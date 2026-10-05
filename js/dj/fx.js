// FX building blocks for the engine: seeded noise, the generated reverb impulse response, the shared
// delay / reverb buses, the four one-shot effects (riser, impact, loop, reverse) and the iOS audio unlock.
//
// The one-shot schedulers do not talk to the engine's bookkeeping directly. The engine hands them a small
// environment object and gets back the nodes it must dispose later:
//
//   env = {
//     ctx, out,                        BaseAudioContext + the node the effect feeds (master bus or a strip input)
//     now(), toCtx(setTime), lead,     set-time clock; `lead` = how far ahead a late effect must be started
//     automate(param, def, points),    schedule [[t, v, kind, tc?], …] (set time) on an AudioParam; late-safe
//     mk(node)                         counts a created node (leak accounting), returns it
//     noise                            shared seeded noise AudioBuffer
//   }
//   result = { t, until, nodes: AudioNode[], sources: AudioScheduledSourceNode[] } | null (nothing to play)

/** Fade used at the edges of every generated or sliced sound, long enough to hide a step, short enough to keep a transient. */
export const EDGE_FADE = 0.003;
const LOOP_FADE_IN = 0.0015;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Small fast seeded PRNG (mulberry32): offline renders must be reproducible, so no Math.random here. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stereo white noise in [-1, 1), decorrelated per channel. */
export function makeNoiseBuffer(ctx, seconds = 2, seed = 0x5e9e) {
  const n = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(seed + ch * 7919);
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  }
  return buf;
}

/**
 * Generated reverb impulse response: decaying stereo noise that gets darker as it decays (like air and
 * walls absorbing the highs), with a short pre-delay so the dry transient stays in front.
 * Scaled to a fixed energy so the convolver can run with normalize = false and sound the same everywhere.
 * @param {BaseAudioContext} ctx
 * @param {{seconds?: number, seed?: number, level?: number}} [o] level = sqrt(energy) per channel
 */
export function makeImpulseResponse(ctx, { seconds = 2.8, seed = 0x51e9, level = 0.55 } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);
  const tau = seconds / 6.9; // -60 dB at the end of the buffer
  const pre = Math.round(0.012 * sr);
  const attack = Math.round(0.004 * sr);
  const tailFade = Math.round(0.05 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(seed + ch * 104729);
    const d = buf.getChannelData(ch);
    let lp = 0;
    let energy = 0;
    for (let i = pre; i < n; i++) {
      const k = i - pre;
      const t = k / sr;
      const fc = 1400 + 8600 * Math.exp(-t / 0.9);
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (rnd() * 2 - 1 - lp);
      let v = lp * Math.exp(-t / tau);
      if (k < attack) v *= k / attack;
      if (i > n - tailFade) v *= (n - i) / tailFade;
      d[i] = v;
      energy += v * v;
    }
    const scale = energy > 0 ? level / Math.sqrt(energy) : 0;
    for (let i = pre; i < n; i++) d[i] *= scale;
  }
  return buf;
}

/** @type {Promise<number>|null} measured once per page */
let loopProbe = null;

/**
 * Extra delay a signal picks up on every trip around a DelayNode feedback loop, in frames.
 * Chrome and Safari resolve a graph cycle by feeding the loop the previous render quantum (+128 frames
 * per trip); Firefox reads the delay line early and adds nothing. Echoes are supposed to sit on the
 * beat grid, so the bus measures this once with a tiny offline render and shortens the loop to match.
 * @returns {Promise<number>} frames (0 if it cannot be measured)
 */
export function probeLoopLatency() {
  if (loopProbe) return loopProbe;
  loopProbe = (async () => {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) return 0;
    const sr = 44100;
    const D = 512;
    const ctx = new OAC(1, 4096, sr);
    const buf = ctx.createBuffer(1, 8, sr);
    buf.getChannelData(0)[0] = 1;
    const src = ctx.createBufferSource();
    const delay = ctx.createDelay(1);
    const fb = ctx.createGain();
    src.buffer = buf;
    delay.delayTime.value = D / sr;
    fb.gain.value = 0.5;
    src.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(ctx.destination);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    const argmax = (a, b) => {
      let at = a;
      for (let i = a; i < b; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i;
      return at;
    };
    const first = argmax(0, D + 256);
    const second = argmax(first + 64, out.length);
    const extra = second - first - D;
    return extra > 0 && extra <= 1024 ? extra : 0;
  })().catch(() => 0);
  return loopProbe;
}

/**
 * Shared send buses.
 *   delay:  in ─▶ D1 ─▶ mix ─▶ return gain ─▶ out, with  mix ─▶ HPF 250 ─▶ LPF 4.5k ─▶ feedback gain ─▶ D2 ─▶ mix
 *           (the first echo is clean, every repeat gets thinner and darker, so long tails never turn to mud).
 *           D1 and D2 are both driven by one ConstantSource (= the 'delayTime' param); D2 additionally gets
 *           −loop latency (see probeLoopLatency) so each trip around the loop takes exactly delayTime.
 *   reverb: in ─▶ HPF 180 (no boomy low end in the wash) ─▶ Convolver ─▶ out
 * @returns {{delayIn: GainNode, reverbIn: GainNode, params: {delayTime: AudioParam, delayFeedback: AudioParam, fxReturn: AudioParam},
 *            nodes: AudioNode[], sources: AudioScheduledSourceNode[], setLoopLatency(seconds: number): void}}
 */
export function createFxBus(ctx, out, mk = (n) => n, { maxDelay = 2.5, impulse = null } = {}) {
  const delayIn = mk(ctx.createGain());
  const d1 = mk(ctx.createDelay(maxDelay));
  const mix = mk(ctx.createGain());
  const fbHp = mk(ctx.createBiquadFilter());
  const fbLp = mk(ctx.createBiquadFilter());
  const feedback = mk(ctx.createGain());
  const ret = mk(ctx.createGain());
  fbHp.type = 'highpass';
  fbHp.frequency.value = 250;
  fbHp.Q.value = -3; // dB for high/lowpass: -3 dB = Butterworth, no resonance to build up in the loop
  fbLp.type = 'lowpass';
  fbLp.frequency.value = 4500;
  fbLp.Q.value = -3;
  delayIn.connect(d1);
  d1.connect(mix);
  mix.connect(ret);
  ret.connect(out);
  mix.connect(fbHp);
  fbHp.connect(fbLp);
  fbLp.connect(feedback);

  const nodes = [delayIn, d1, mix, fbHp, fbLp, feedback, ret];
  const sources = [];
  let delayTime = d1.delayTime;
  let setLoopLatency = () => {};
  if (typeof ctx.createConstantSource === 'function') {
    const d2 = mk(ctx.createDelay(maxDelay));
    const time = mk(ctx.createConstantSource());
    const comp = mk(ctx.createConstantSource());
    // An AudioParam's value is its own value plus whatever is connected to it: both delays follow `time`.
    d1.delayTime.value = 0;
    d2.delayTime.value = 0;
    comp.offset.value = 0;
    time.connect(d1.delayTime);
    time.connect(d2.delayTime);
    comp.connect(d2.delayTime);
    feedback.connect(d2);
    d2.connect(mix);
    time.start();
    comp.start();
    delayTime = time.offset;
    setLoopLatency = (seconds) => {
      comp.offset.value = -Math.max(0, seconds);
    };
    nodes.push(d2, time, comp);
    sources.push(time, comp);
  } else {
    // No ConstantSourceNode (pre-2021 Safari): one delay inside the loop; repeats run a quantum late.
    feedback.connect(d1);
  }

  const reverbIn = mk(ctx.createGain());
  const revHp = mk(ctx.createBiquadFilter());
  const convolver = mk(ctx.createConvolver());
  revHp.type = 'highpass';
  revHp.frequency.value = 180;
  revHp.Q.value = -3;
  convolver.normalize = false; // must be set before the buffer; the IR is already scaled
  convolver.buffer = impulse || makeImpulseResponse(ctx);
  reverbIn.connect(revHp);
  revHp.connect(convolver);
  convolver.connect(out);
  nodes.push(reverbIn, revHp, convolver);

  return {
    delayIn,
    reverbIn,
    params: { delayTime, delayFeedback: feedback.gain, fxReturn: ret.gain },
    nodes,
    sources,
    setLoopLatency,
  };
}

/** Riser: band-passed noise whose band and level climb into t+dur, then stop dead (3 ms, so no click). */
export function scheduleRiser(env, fx) {
  const { ctx } = env;
  const dur = Number(fx.dur);
  const g = clamp(Number(fx.gain), 0, 2);
  if (!Number.isFinite(fx.t) || !(dur > 0.03) || !(g > 0)) return null;
  const t0 = fx.t;
  const t1 = t0 + dur;
  const begin = Math.max(t0, env.now() + env.lead);
  if (begin >= t1 - 0.02) return null;

  const src = env.mk(ctx.createBufferSource());
  const bp = env.mk(ctx.createBiquadFilter());
  const amp = env.mk(ctx.createGain());
  src.buffer = env.noise;
  src.loop = true;
  bp.type = 'bandpass';
  bp.Q.value = 1.3;
  src.connect(bp);
  bp.connect(amp);
  amp.connect(env.out);

  env.automate(bp.frequency, 260, [
    [t0, 260, 'set'],
    [t1, 7800, 'exp'],
  ]);
  // Slow start, steep finish: the last quarter is where the tension is.
  env.automate(amp.gain, 0, [
    [t0, 0, 'set'],
    [t0 + 0.45 * dur, 0.14 * g, 'lin'],
    [t0 + 0.8 * dur, 0.5 * g, 'lin'],
    [t1 - EDGE_FADE, g, 'lin'],
    [t1, 0, 'lin'],
  ]);
  src.start(Math.max(0, env.toCtx(begin)));
  src.stop(Math.max(0, env.toCtx(t1)) + 0.02);
  return { t: t0, until: t1, nodes: [src, bp, amp], sources: [src] };
}

/** Impact: a pitched-down sub thump plus a bright noise crash, both starting exactly on t. */
export function scheduleImpact(env, fx) {
  const { ctx } = env;
  const g = clamp(Number(fx.gain), 0, 2);
  if (!Number.isFinite(fx.t) || !(g > 0.002)) return null;
  const nowS = env.now();
  if (fx.t < nowS - 0.05) return null; // a boom that missed its downbeat is worse than no boom
  const t = Math.max(fx.t, nowS + env.lead);

  const osc = env.mk(ctx.createOscillator());
  const oscGain = env.mk(ctx.createGain());
  osc.type = 'sine';
  osc.connect(oscGain);
  oscGain.connect(env.out);
  env.automate(osc.frequency, 150, [
    [t, 150, 'set'],
    [t + 0.12, 50, 'exp'],
    [t + 0.7, 36, 'exp'],
  ]);
  env.automate(oscGain.gain, 0, [
    [t, 0, 'set'],
    [t + 0.004, 0.8 * g, 'lin'],
    [t + 0.75, 0.001, 'exp'],
    [t + 0.76, 0, 'lin'],
  ]);

  const noise = env.mk(ctx.createBufferSource());
  const hp = env.mk(ctx.createBiquadFilter());
  const noiseGain = env.mk(ctx.createGain());
  noise.buffer = env.noise;
  noise.loop = true;
  hp.type = 'highpass';
  hp.frequency.value = 2800;
  hp.Q.value = -3;
  noise.connect(hp);
  hp.connect(noiseGain);
  noiseGain.connect(env.out);
  env.automate(noiseGain.gain, 0, [
    [t, 0, 'set'],
    [t + 0.002, 0.3 * g, 'lin'],
    [t + 1.5, 0.0004, 'exp'],
    [t + 1.52, 0, 'lin'],
  ]);

  const ct = Math.max(0, env.toCtx(t));
  osc.start(ct);
  osc.stop(ct + 0.8);
  noise.start(ct);
  noise.stop(ct + 1.56);
  return { t: fx.t, until: t + 1.56, nodes: [osc, oscGain, noise, hp, noiseGain], sources: [osc, noise] };
}

const peekBuf = new Float32Array(2);

/**
 * Is the audio at buffer position `pos` (this sample and the next) digital silence? Then a source may
 * start there without a fade.
 * Reads through copyFromChannel: in Firefox getChannelData() on a buffer that a playing source already
 * holds copies the WHOLE buffer back to the main thread (100+ MB for a full-length track) just to hand
 * out two samples.
 */
export function quietAt(buffer, pos) {
  const i = Math.round(pos * buffer.sampleRate);
  if (i < 0 || i >= buffer.length) return true;
  const direct = typeof buffer.copyFromChannel !== 'function';
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    if (direct) {
      const d = buffer.getChannelData(ch);
      peekBuf[0] = d[i];
      peekBuf[1] = d[i + 1] || 0;
    } else {
      peekBuf[1] = 0; // stays 0 when i is the last frame (copyFromChannel copies what there is)
      buffer.copyFromChannel(peekBuf, ch, i);
    }
    if (Math.abs(peekBuf[0]) > 1e-4 || Math.abs(peekBuf[1]) > 1e-4) return false;
  }
  return true;
}

/**
 * Beat repeat / roll: a looping source over the exact slice [offset, offset+len) of `buffer`, fed into
 * `env.out` (the play's strip input) for `dur` seconds. The loop points are the source's own
 * loopStart/loopEnd (sample-exact, no drift); a gain after it dips to zero around every wrap so the
 * jump from the end of the slice back to its start cannot click.
 */
export function scheduleLoop(env, fx, buffer) {
  const { ctx } = env;
  const dur = Number(fx.dur);
  const rate = clamp(Number(fx.rate) || 1, 0.05, 8);
  if (!Number.isFinite(fx.t) || !(dur > 0) || !Number.isFinite(fx.offset) || !(fx.len > 0)) return null;
  const a = clamp(fx.offset, 0, Math.max(0, buffer.duration - 0.01));
  const b = Math.min(a + fx.len, buffer.duration);
  const span = b - a;
  if (!(span > 0.004)) return null;
  const period = span / rate;
  const t0 = fx.t;
  const t1 = t0 + dur;
  const begin = Math.max(t0, env.now() + env.lead);
  if (begin >= t1 - 0.005) return null;
  // A late roll joins at the phase it would have had, so it still sits on the grid.
  const phase = (((begin - t0) * rate) % span + span) % span;

  const src = env.mk(ctx.createBufferSource());
  const amp = env.mk(ctx.createGain());
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = a;
  src.loopEnd = b;
  src.playbackRate.value = rate;
  src.connect(amp);
  amp.connect(env.out);

  const fadeOut = Math.min(EDGE_FADE, period * 0.25);
  const fadeIn = Math.min(LOOP_FADE_IN, period * 0.125);
  const pts = [];
  if (phase === 0 && quietAt(buffer, a)) pts.push([begin, 1, 'set']);
  else pts.push([begin, 0, 'set'], [begin + fadeIn, 1, 'lin']);
  const firstWrap = Math.floor((begin - t0) / period + 1e-9) + 1;
  for (let k = firstWrap; t0 + k * period < t1 - fadeOut - fadeIn; k++) {
    const w = t0 + k * period;
    pts.push([w - fadeOut, 1, 'set'], [w, 0, 'lin'], [w + fadeIn, 1, 'lin']);
  }
  pts.push([t1 - fadeOut, 1, 'set'], [t1, 0, 'lin']);
  env.automate(amp.gain, 0, pts);

  src.start(Math.max(0, env.toCtx(begin)), a + phase);
  src.stop(Math.max(0, env.toCtx(t1)) + 0.02);
  return { t: t0, until: t1, nodes: [src, amp], sources: [src] };
}

/**
 * Spinback: the slice [offset-len, offset) is copied backwards into its own buffer (Chrome renders
 * silence for a negative playbackRate, so "reverse" has to be real reversed audio) and played forward
 * with the rate ramping rate0 → rate1 over `dur` seconds.
 */
export function scheduleReverse(env, fx, buffer) {
  const { ctx } = env;
  const dur = Number(fx.dur);
  if (!Number.isFinite(fx.t) || !(dur > 0.01) || !Number.isFinite(fx.offset) || !(fx.len > 0)) return null;
  const sr = buffer.sampleRate;
  const end = clamp(Math.round(fx.offset * sr), 0, buffer.length);
  const n = Math.min(end, Math.round(fx.len * sr));
  if (n < 16) return null;
  const r0 = clamp(Number(fx.rate0) || 0, 0, 8);
  const r1 = clamp(Number.isFinite(fx.rate1) ? fx.rate1 : r0, 0, 8);
  const t0 = fx.t;
  const t1 = t0 + dur;
  const begin = Math.max(t0, env.now() + env.lead);
  if (begin >= t1 - 0.005) return null;
  // A late spinback skips what it would already have played (area under the rate ramp so far).
  const tau = begin - t0;
  const skipped = r0 * tau + ((r1 - r0) * tau * tau) / (2 * dur);
  if (skipped >= n / sr) return null;

  const rev = ctx.createBuffer(buffer.numberOfChannels, n, sr);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const to = rev.getChannelData(ch);
    // Only the slice crosses over (see quietAt for why not getChannelData on the track's buffer).
    if (typeof buffer.copyFromChannel === 'function') buffer.copyFromChannel(to, ch, end - n);
    else to.set(buffer.getChannelData(ch).subarray(end - n, end));
    to.reverse();
  }

  const src = env.mk(ctx.createBufferSource());
  const amp = env.mk(ctx.createGain());
  src.buffer = rev;
  src.connect(amp);
  amp.connect(env.out);
  env.automate(src.playbackRate, r0, [
    [t0, r0, 'set'],
    [t1, r1, 'lin'],
  ]);
  const fade = Math.min(EDGE_FADE, dur * 0.25);
  env.automate(amp.gain, 0, [
    [begin, 0, 'set'],
    [begin + fade, 1, 'lin'],
    [t1 - fade, 1, 'set'],
    [t1, 0, 'lin'],
  ]);
  src.start(Math.max(0, env.toCtx(begin)), skipped);
  src.stop(Math.max(0, env.toCtx(t1)) + 0.02);
  return { t: t0, until: t1, nodes: [src, amp], sources: [src] };
}

// ---------------------------------------------------------------------------------------------------
// iOS: Web Audio plays on the "ringer" channel and is silenced by the mute switch — unless an
// HTMLMediaElement is playing, which moves the whole page onto the media channel. So: loop a silent
// <audio> for as long as the set runs. Must be started inside the user gesture.

let unlockEl = null;
let unlockUrl = null;
/** Who asked for the silent element (engines); it is released when the last one lets go. */
const unlockOwners = new Set();

const isIOS = () => {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav) return false;
  return /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
};

/** One second of 8-bit mono silence as a WAV file (8 kB, generated so no audio asset ships with the repo). */
export function silentWav(seconds = 1, sampleRate = 8000) {
  const n = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const ascii = (at, s) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, n, true);
  bytes.fill(128, 44); // unsigned 8-bit silence
  return bytes;
}

/**
 * Call inside the user gesture that starts playback (engine.start() already does). On iOS it starts a
 * silent looping <audio> so the mute switch no longer silences the set; everywhere else it does
 * nothing and returns null. Safe to call again (e.g. after the page was backgrounded).
 * @param {{force?: boolean, owner?: object}} [opts] force = run on any platform (tests);
 *   owner = token to pass to lockAudio() later, so one engine cannot release another engine's unlock
 * @returns {HTMLAudioElement|null}
 */
export function unlockAudio({ force = false, owner = null } = {}) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return null;
  if (!force && !isIOS()) return null;
  // iOS 16.4+ lets a page declare itself a media player outright; the silent element below stays as
  // the mechanism for older versions (and is what Now Playing attaches to).
  try {
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
  } catch {
    /* not supported: the element does the job */
  }
  try {
    if (!unlockEl) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', '');
      el.setAttribute('x-webkit-airplay', 'deny');
      el.disableRemotePlayback = true;
      el.preload = 'auto';
      el.loop = true;
      unlockUrl = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
      el.src = unlockUrl;
      unlockEl = el;
    }
    if (owner) unlockOwners.add(owner);
    const p = unlockEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return unlockEl;
  } catch {
    return null;
  }
}

/**
 * Stop and release the silent element. With an owner: only once every owner has released it.
 * Without: unconditionally (full app teardown).
 */
export function lockAudio(owner = null) {
  if (owner) {
    unlockOwners.delete(owner);
    if (unlockOwners.size) return;
  } else unlockOwners.clear();
  if (!unlockEl) return;
  try {
    unlockEl.pause();
    unlockEl.removeAttribute('src');
    unlockEl.load();
  } catch {
    /* nothing to clean up */
  }
  if (unlockUrl) URL.revokeObjectURL(unlockUrl);
  unlockEl = null;
  unlockUrl = null;
}

// 7. Cross-browser behaviour. Nothing in this group uses OfflineAudioContext.suspend(), so unlike
//    cancel / bassSwap / lifecycle it also runs in Firefox (tests/e2e/engine.e2e.mjs drives both
//    browsers). It covers the places where the engines are known to differ:
//      - the limiter: Firefox's DynamicsCompressor pre-emphasises the treble before its detector
//      - cancelFrom() in the middle of a ramp on the path without AudioParam.cancelAndHoldAtTime
//      - uiTime(): what getOutputTimestamp() means differs per engine
//    and two things every browser must get right: a decoded buffer with non-finite samples must not
//    take the mix down, and the engine reports AudioContext state changes.
import { createEngine, sanitizeBuffer, sanitizeBufferAsync, HEADROOM, LIMITER } from '../../../js/dj/engine.js';
import { emphasisFilters, probeCompressorEmphasis, mulberry32 } from '../../../js/dj/fx.js';
import { suite, renderSet, mkPlay, ev, emptyBuffer, addSine, sineBuffer, rms, peak, db, fmt, sleep, SR } from './lib.js';

const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

// ----- limiter helpers ---------------------------------------------------------------------------

const SEG = 0.8;
/** One tone per 0.8 s segment (10 ms raised-cosine edges, so no segment starts with a click). */
function toneRow(ctx, freqs, amps) {
  const buf = emptyBuffer(ctx, freqs.length * SEG + 0.1);
  const sr = buf.sampleRate;
  const edge = Math.round(0.01 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    freqs.forEach((f, k) => {
      const a = Math.round((k * SEG + 0.05) * sr);
      const n = Math.round(0.7 * sr);
      for (let i = 0; i < n; i++) {
        const w = i < edge ? 0.5 - 0.5 * Math.cos((Math.PI * i) / edge) : i > n - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / edge) : 1;
        d[a + i] = amps[k] * w * Math.sin((2 * Math.PI * f * i) / sr);
      }
    });
  }
  return buf;
}
/** RMS of each tone, measured where the limiter has had 400 ms to settle on it. */
async function toneLevels(freqs, amps, engineOpts = {}) {
  let nodes = 0;
  const { L } = await renderSet({
    seconds: freqs.length * SEG + 0.1,
    engineOpts,
    build: (engine, ctx) => {
      nodes = engine.debug().baselineNodes;
      engine.addPlay(mkPlay(0), toneRow(ctx, freqs, amps));
    },
  });
  return { levels: freqs.map((_, k) => rms(L, k * SEG + 0.45, k * SEG + 0.7)), nodes };
}

/** |H(f)| of feedforward / feedback coefficients (b, a) at sample rate sr, as a complex pair. */
function response(coef, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  const at = (c) => c.reduce((s, v, n) => [s[0] + v * Math.cos(n * w), s[1] - v * Math.sin(n * w)], [0, 0]);
  const [nr, ni] = at(coef.feedforward);
  const [dr, di] = at(coef.feedback);
  const den = dr * dr + di * di;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}

// ----- realtime capture --------------------------------------------------------------------------

/**
 * A real AudioContext whose "destination" (as the engine sees it) is a tap into a capture worklet,
 * so the test reads the exact samples the engine sent to the speakers.
 */
async function captureContext() {
  const real = new AudioContext();
  await real.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
  const tap = real.createGain();
  const capture = new AudioWorkletNode(real, 'capture', { channelCount: 2, channelCountMode: 'explicit' });
  const mute = real.createGain();
  mute.gain.value = 0;
  const chunks = [];
  capture.port.onmessage = (e) => chunks.push(e.data);
  tap.connect(capture);
  capture.connect(mute); // some engines only run nodes that lead to the destination
  mute.connect(real.destination);
  const context = new Proxy(real, {
    get(target, key) {
      if (key === 'destination') return tap;
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const stop = async () => {
    await sleep(60);
    tap.disconnect();
    await sleep(60);
    const n = chunks.reduce((s, c) => s + c.l.length, 0);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let at = 0;
    for (const c of chunks) {
      L.set(c.l, at);
      R.set(c.r, at);
      at += c.l.length;
    }
    await real.close();
    return { L, R, sr: real.sampleRate };
  };
  return { real, context, stop };
}

/** Peak per 2 ms window (two periods of a 1 kHz tone), i.e. the tone's envelope. */
function envelope(data, sr) {
  const W = Math.round(0.002 * sr);
  const out = [];
  for (let i = 0; i + W <= data.length; i += W) {
    let p = 0;
    for (let k = 0; k < W; k++) {
      const a = Math.abs(data[i + k]);
      if (a > p) p = a;
    }
    out.push(p);
  }
  return out;
}

/** A context that reports its output clock the way one of the three engines does. */
function clockStyle(real, style, latency) {
  let frozen = null;
  const context = new Proxy(real, {
    get(target, key) {
      if (key === 'outputLatency') return latency;
      if (key === 'currentTime') return frozen ?? target.currentTime;
      if (key === 'getOutputTimestamp') {
        return () => {
          const cur = frozen ?? target.currentTime;
          const now = performance.now();
          // Firefox: the sample at the speakers, stamped with the moment it was rendered.
          if (style === 'firefox') return { contextTime: cur - latency, performanceTime: now - latency * 1000 };
          // WebKit: the sample being rendered now (one quantum back), no device latency at all.
          if (style === 'webkit') return { contextTime: cur - 128 / target.sampleRate, performanceTime: now };
          // Chrome: the sample at the speakers now (device latency + what is left of the last buffer).
          return { contextTime: cur - latency - 0.012, performanceTime: now };
        };
      }
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { context, freeze: () => (frozen = real.currentTime), thaw: () => (frozen = null) };
}

export default async function compat() {
  const { results, check } = suite();
  const AMP = 0.3;

  // === limiter: it reacts to level, not to brightness ============================================
  const emphasised = await probeCompressorEmphasis(SR, LIMITER);
  check('probeCompressorEmphasis() answers once per page and sample rate', typeof emphasised === 'boolean' && probeCompressorEmphasis(SR, LIMITER) === probeCompressorEmphasis(SR, LIMITER), `this browser's DynamicsCompressor pre-emphasises the treble: ${emphasised}`);
  {
    // Tones 9 dB under the limiter's threshold: it has nothing to do, at any frequency.
    const freqs = [97, 997, 4001, 8017, 12011, 16001];
    const at = Math.pow(10, (LIMITER.threshold - 9) / 20) / HEADROOM; // level at the limiter = master gain × this
    const loud = await toneLevels(freqs, freqs.map(() => at));
    const quiet = await toneLevels(freqs, freqs.map(() => at / 20));
    const red = freqs.map((_, k) => db(loud.levels[k] / (quiet.levels[k] * 20)));
    check('limiter: a tone 9 dB under the threshold passes untouched at every frequency (no treble pre-emphasis in the detector)', red.every((r) => Math.abs(r) < 0.2), freqs.map((f, k) => `${f} Hz ${fmt(red[k], 2)} dB`).join(', '));

    // Over the threshold it must work, and equally hard whatever the pitch. The strip's own filters
    // are not perfectly flat up there, so each tone is first levelled to arrive at the limiter alike.
    const hot = [997, 4001, 8017, 12011];
    const flat = await toneLevels(hot, hot.map(() => 0.01));
    const want = 1.2 / HEADROOM;
    const amps = hot.map((_, k) => (want * flat.levels[0]) / flat.levels[k]);
    const over = await toneLevels(hot, amps);
    const redOver = hot.map((_, k) => db(over.levels[k] / amps[k] / (flat.levels[k] / 0.01)));
    const spread = Math.max(...redOver) - Math.min(...redOver);
    check('limiter: 4.6 dB over the threshold it pulls every frequency down alike', redOver.every((r) => r < -2 && r > -6) && spread < 0.6, hot.map((f, k) => `${f} Hz ${fmt(redOver[k], 2)} dB`).join(', '));
  }
  {
    // Bright programme: white noise that stays well under the threshold (the strip's filters ring a
    // little on it, hence the measured peak). Level in 50 ms windows against the same render 26 dB
    // lower, where no limiter could act.
    const run = async (scale) => {
      const { L } = await renderSet({
        seconds: 2.2,
        build: (engine, ctx) => {
          const buf = emptyBuffer(ctx, 2.4);
          for (let ch = 0; ch < 2; ch++) {
            const rnd = mulberry32(77 + ch);
            const d = buf.getChannelData(ch);
            for (let i = 0; i < d.length; i++) d[i] = scale * (rnd() * 2 - 1);
          }
          engine.addPlay(mkPlay(0), buf);
        },
      });
      return L;
    };
    const scale = 0.25 / HEADROOM;
    const loud = await run(scale);
    const quiet = await run(scale / 20);
    let worst = 0;
    for (let t = 0.3; t < 2.1; t += 0.05) worst = Math.min(worst, db(rms(loud, t, t + 0.05) / (rms(quiet, t, t + 0.05) * 20)));
    const top = peak(quiet, 0.3, 2.1) * 20; // what reaches the limiter
    check('limiter: bright noise that stays under the threshold is not ducked', worst > -0.25 && top > 0.2 && db(top) < LIMITER.threshold - 2, `deepest 50 ms window ${fmt(worst, 2)} dB; the noise peaks at ${fmt(db(top), 1)} dBFS, threshold ${LIMITER.threshold} dB`);
  }
  {
    // The filters that cancel the pre-emphasis: exact inverses of each other, unity at DC.
    let worst = 0;
    let dc = 0;
    for (const sr of [44100, 48000, 96000]) {
      const k = emphasisFilters(sr);
      for (const f of [0, 60, 1000, 5000, 12000, 19000]) {
        const b = response(k.boost, f, sr);
        const c = response(k.cut, f, sr);
        worst = Math.max(worst, Math.hypot(b[0] * c[0] - b[1] * c[1] - 1, b[0] * c[1] + b[1] * c[0]));
      }
      dc = Math.max(dc, Math.abs(Math.hypot(...response(k.boost, 0, sr)) - 1));
    }
    const at12k = db(Math.hypot(...response(emphasisFilters(48000).boost, 12000, 48000)));
    check('emphasisFilters(): boost × cut = 1 at 44.1 / 48 / 96 kHz, unity gain at DC', worst < 1e-9 && dc < 1e-9 && at12k > 9 && at12k < 14, `worst |boost·cut − 1| ${worst.toExponential(1)}; the boost is ${fmt(at12k, 2)} dB at 12 kHz`);

    // With the compensation forced on around a compressor (whatever kind this browser has) the path
    // stays transparent for a signal the limiter leaves alone, and its two nodes are accounted for.
    const freqs = [97, 997, 8017, 16001];
    const amps = freqs.map(() => 0.05);
    const off = await toneLevels(freqs, amps, { limiterEmphasis: false });
    const on = await toneLevels(freqs, amps, { limiterEmphasis: true });
    const auto = await toneLevels(freqs, amps);
    const dev = freqs.map((_, k) => db(on.levels[k] / off.levels[k]));
    check('limiterEmphasis: true — the two extra filters cancel exactly (level unchanged at every frequency)', dev.every((d) => Math.abs(d) < 0.01), freqs.map((f, k) => `${f} Hz ${fmt(dev[k], 4)} dB`).join(', '));
    check('…and by default they are there exactly when the probe says this browser needs them', on.nodes === off.nodes + 2 && auto.nodes === (emphasised ? on.nodes : off.nodes), `baseline nodes: off ${off.nodes}, on ${on.nodes}, default ${auto.nodes}`);
  }

  // === cancelFrom() in the middle of a ramp, heard in realtime ====================================
  // Left: play 0, fader ('gain') on a linear ramp. Right: play 1, 'src' on an exponential one. Skip
  // presses cancelFrom(now + 10 ms). Whatever the browser does with the three calls of the fallback
  // path, the envelope must go from "ramping" to "held" without a jump.
  const native = typeof AudioParam.prototype.cancelAndHoldAtTime === 'function';
  for (const [tag, engineOpts] of native ? [['native hold', {}], ['fallback', { cancelAndHold: false }]] : [['fallback (the only path here)', {}]]) {
    const cap = await captureContext();
    const engine = createEngine({ context: cap.context, ...engineOpts });
    const sr = cap.real.sampleRate;
    await engine.start();
    engine.addPlay(mkPlay(0, { startAt: 0.2, events: [ev('gain', 0.2, 1), ev('gain', 6, 0.1, 'lin')] }), sineBuffer(cap.real, 8, 1000, AMP, 0));
    engine.addPlay(mkPlay(1, { startAt: 0.2, events: [ev('src', 0.2, 1), ev('src', 6, 0.05, 'exp')] }), sineBuffer(cap.real, 8, 1000, AMP, 1));
    const deadline = performance.now() + 8000;
    while (engine.now() < 1.5 && performance.now() < deadline) await sleep(20);
    const T = engine.now() + 0.01;
    engine.cancelFrom(T);
    const held = [engine.playState(0, T + 0.2).gain, engine.playState(1, T + 0.2).src];
    await sleep(500);
    engine.destroy();
    const { L, R } = await cap.stop();
    const verdict = (data, want) => {
      const env = envelope(data, sr).map((x) => x / (AMP * HEADROOM));
      const first = env.findIndex((x) => x > 0.9);
      let jump = 0;
      // From 100 ms after the tone is up to 30 ms before the capture ends (destroy() cuts it there).
      for (let i = first + 50; i < env.length - 15; i++) jump = Math.max(jump, Math.abs(env[i + 1] - env[i]));
      const tail = env.slice(-90, -15);
      const level = tail.reduce((s, x) => s + x, 0) / Math.max(1, tail.length);
      return { ok: first >= 0 && env.length - first > 500 && jump < 0.03 && Math.abs(level - want) < 0.02, text: `largest 2 ms step ${fmt(jump, 4)}, held at ${fmt(level, 3)} (model ${fmt(want, 3)})` };
    };
    const lin = verdict(L, held[0]);
    const exp = verdict(R, held[1]);
    check(`[${tag}] realtime cancelFrom(now + 10 ms) inside a linear ramp: no snap-back, value held`, lin.ok, lin.text);
    check(`[${tag}] realtime cancelFrom(now + 10 ms) inside an exponential ramp: no snap-back, value held`, exp.ok, exp.text);
  }

  // === uiTime(): the set time at the speakers =====================================================
  {
    // Each engine's getOutputTimestamp(), replayed on a context with 250 ms of output latency (what
    // Bluetooth headphones do). The clock is frozen while both values are read.
    const real = new AudioContext();
    const LAT = 0.25;
    const out = [];
    let ok = true;
    for (const style of ['chrome', 'firefox', 'webkit']) {
      const clock = clockStyle(real, style, LAT);
      const engine = createEngine({ context: clock.context });
      await engine.start();
      await sleep(250);
      clock.freeze();
      const lag = engine.now() - engine.uiTime();
      clock.thaw();
      engine.destroy();
      const want = LAT + LIMITER.lookahead + (style === 'chrome' ? 0.012 : style === 'webkit' ? 128 / real.sampleRate : 0);
      if (!(Math.abs(lag - want) < 0.002)) ok = false;
      out.push(`${style}-style ${fmt(lag * 1000, 1)} ms (want ${fmt(want * 1000, 1)})`);
    }
    await real.close();
    check('uiTime(): trails now() by output latency + limiter look-ahead, whichever way the browser reports its output timestamp', ok, out.join(', '));
  }
  {
    // And in this browser for real.
    const engine = createEngine();
    await engine.start();
    await sleep(700);
    const lags = [];
    for (let i = 0; i < 11; i++) {
      lags.push(engine.now() - engine.uiTime());
      await sleep(37);
    }
    const lat = engine.ctx.outputLatency || 0;
    const lag = median(lags);
    engine.destroy();
    check("uiTime(): this browser's own clock is at least its reported output latency behind now()", lag >= LIMITER.lookahead + 0.8 * lat - 0.001 && lag < 1, `median lag ${fmt(lag * 1000, 1)} ms; outputLatency ${fmt(lat * 1000, 1)} ms + look-ahead ${LIMITER.lookahead * 1000} ms`);
  }

  // === a buffer with non-finite samples =========================================================
  // (A damaged 32-bit float file decodes to exactly this.) One NaN reaching a filter or the delay loop
  // would stay there for good and silence everything mixed after it.
  {
    const damage = (buf) => {
      const sr = buf.sampleRate;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        d.fill(NaN, Math.round(0.3 * sr), Math.round(0.32 * sr));
        d[Math.round(0.5 * sr)] = Infinity;
        d[Math.round(0.5 * sr) + 1] = -Infinity;
        d[Math.round(0.6 * sr)] = 1e30;
        d[Math.round(0.6 * sr) + 1] = -1e30;
      }
      return 2 * (Math.round(0.32 * sr) - Math.round(0.3 * sr) + 4);
    };
    const dirty = (buf) => {
      let n = 0;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const v of buf.getChannelData(ch)) if (!(v >= -8 && v <= 8)) n++;
      return n;
    };
    let bad = null;
    let threw = '';
    const build = (poisoned) => (engine, ctx) => {
      try {
        // A: clean, left. B: the damaged one, left, into the delay loop and the reverb. C: clean, right.
        engine.addPlay(mkPlay(0, { endAt: 1 }), sineBuffer(ctx, 1.2, 1000, AMP, 0));
        const b = sineBuffer(ctx, 1.2, 1000, AMP, 0);
        if (poisoned) {
          damage(b);
          bad = b;
        }
        engine.addFx([], [ev('delayTime', 0, 0.2), ev('delayFeedback', 0, 0.8)]);
        engine.addPlay(mkPlay(1, { startAt: 1, endAt: 2, events: [ev('delaySend', 1, 0.6), ev('reverbSend', 1, 0.5)] }), b);
        engine.addPlay(mkPlay(2, { startAt: 2.2 }), sineBuffer(ctx, 2, 660, AMP, 1));
      } catch (err) {
        threw = String(err);
      }
    };
    const clean = await renderSet({ seconds: 4, build: build(false) });
    const hurt = await renderSet({ seconds: 4, build: build(true) });
    let finite = true;
    for (let i = 0; i < hurt.L.length && finite; i++) finite = Number.isFinite(hurt.L[i]) && Number.isFinite(hurt.R[i]);
    const c0 = rms(clean.R, 3.4, 3.9);
    const c1 = rms(hurt.R, 3.4, 3.9);
    const a1 = rms(hurt.L, 0.4, 0.9) / rms(clean.L, 0.4, 0.9);
    check('non-finite samples in a buffer: addPlay does not throw, the output stays finite', !threw && finite, threw || `every sample of 4 s finite: ${finite}`);
    check('…and the clean track mixed after the damaged one plays at its normal level', c0 > 0.05 && Math.abs(c1 / c0 - 1) < 0.01 && Math.abs(a1 - 1) < 0.01, `clean track after it: rms ${fmt(c1, 4)} (${fmt(c0, 4)} without the damage)`);
    check('…because addPlay repaired the buffer in place (NaN / ±Infinity → 0, absurd values clamped)', bad && dirty(bad) === 0 && peak(bad.getChannelData(0), 0.55, 0.65, bad.sampleRate) === 8, bad ? `${dirty(bad)} bad samples left, the 1e30 spike is now ${peak(bad.getChannelData(0), 0.55, 0.65, bad.sampleRate)}` : 'no buffer');

    const ctx = new OfflineAudioContext(2, 128, SR);
    const fresh = addSine(emptyBuffer(ctx, 1.2), 440, 0.9);
    const b1 = addSine(emptyBuffer(ctx, 1.2), 440, 0.9);
    const b2 = addSine(emptyBuffer(ctx, 1.2), 440, 0.9);
    const planted = damage(b1);
    damage(b2);
    const before = fresh.getChannelData(1).slice();
    const n0 = sanitizeBuffer(fresh);
    const n1 = sanitizeBuffer(b1);
    const n1again = sanitizeBuffer(b1);
    const n2 = await sanitizeBufferAsync(b2);
    const untouched = fresh.getChannelData(1).every((v, i) => v === before[i]);
    check('sanitizeBuffer(): reports what it repaired, leaves a clean buffer alone, checks a buffer once; the async variant does the same', n0 === 0 && untouched && n1 === planted && n1again === 0 && n2 === planted && dirty(b1) === 0 && dirty(b2) === 0, `clean ${n0}, damaged ${n1} of ${planted} planted, again ${n1again}, async ${n2}`);
  }

  // === AudioContext state is reported ============================================================
  {
    // Asking for the state must not create the context (that has to wait for a user gesture).
    const RealAC = window.AudioContext;
    let made = 0;
    window.AudioContext = function (...a) {
      made++;
      return new RealAC(...a);
    };
    const engine = createEngine();
    const seen = [];
    const off = engine.on('statechange', (e) => seen.push(e.state));
    const idle = engine.state;
    const madeBefore = made;
    let ok = false;
    let text = '';
    try {
      await engine.start();
      window.AudioContext = RealAC;
      await sleep(200);
      const s1 = engine.state;
      await engine.pause();
      const s2 = engine.state;
      const e2 = seen[seen.length - 1];
      await engine.resume();
      const s3 = engine.state;
      const e3 = seen[seen.length - 1];
      const repeats = seen.some((s, i) => i > 0 && s === seen[i - 1]);
      off();
      const count = seen.length;
      await engine.pause();
      await sleep(100);
      ok = idle === 'suspended' && madeBefore === 0 && made === 1 && s1 === 'running' && s2 === 'suspended' && e2 === 'suspended' && s3 === 'running' && e3 === 'running' && !repeats && seen.length === count;
      text = `before a context exists: '${idle}' (${madeBefore} contexts made); then ${s1} → pause ${s2} → resume ${s3}; events [${seen}]`;
    } catch (err) {
      text = String(err && err.stack ? err.stack : err);
    } finally {
      window.AudioContext = RealAC;
    }
    engine.destroy();
    check("engine.state + on('statechange'): follow the context through pause / resume, {state} payload, no context created just by asking", ok && engine.state === 'closed', text);
  }
  {
    // The meter is what leaves the speakers: a paused (or interrupted) context puts out nothing, even
    // though its AnalyserNode still holds the last block it saw.
    const engine = createEngine();
    let text = '';
    let ok = false;
    try {
      await engine.start();
      engine.addPlay(mkPlay(0, { startAt: engine.now() + 0.05 }), sineBuffer(engine.ctx, 6, 220, 0.4));
      await sleep(500);
      const on = { ...engine.levels() };
      const onBands = Math.max(...engine.levels().bands);
      await engine.pause();
      await sleep(120);
      const held = engine.levels();
      const heldRms = held.rms;
      const heldPeak = held.peak;
      const heldBands = Math.max(...held.bands);
      const heldWave = held.wave.every((v) => v === 128);
      const same = held === engine.levels();
      await engine.resume();
      await sleep(400);
      const back = engine.levels().rms;
      ok = on.rms > 0.05 && onBands > 0 && heldRms === 0 && heldPeak === 0 && heldBands === 0 && heldWave && same && back > 0.05;
      text = `playing ${fmt(on.rms, 3)} → paused rms ${heldRms}, peak ${heldPeak}, loudest band ${heldBands} → resumed ${fmt(back, 3)}`;
    } catch (err) {
      text = String(err && err.stack ? err.stack : err);
    }
    engine.destroy();
    check('levels(): a context that is not running reads as silence (the meter does not freeze lit on Pause), and comes back with the sound', ok, text);
  }
  {
    // A context that stops by itself (iOS: a phone call → 'interrupted') and one that does so without
    // firing an event: the housekeeping timer notices.
    const real = new AudioContext();
    let fake = null;
    const context = new Proxy(real, {
      get(target, key) {
        if (key === 'state' && fake) return fake;
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const engine = createEngine({ context });
    const seen = [];
    engine.on('statechange', (e) => seen.push(e.state));
    await engine.start();
    await sleep(150);
    fake = 'interrupted';
    await sleep(200);
    const during = engine.state;
    const afterStop = seen.slice();
    fake = null;
    await sleep(200);
    engine.destroy();
    const late = seen.length;
    await real.suspend();
    await sleep(100);
    await real.close();
    check("on('statechange'): a state the browser changed silently (iOS 'interrupted') is still reported, and nothing after destroy()", during === 'interrupted' && afterStop[afterStop.length - 1] === 'interrupted' && seen[late - 1] === 'running' && seen.length === late, `events [${seen}]`);
  }

  return results;
}

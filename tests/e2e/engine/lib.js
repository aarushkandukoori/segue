// Shared helpers for the engine e2e groups (runs in the browser, loaded by engine-harness.html):
// synthetic buffers, offline rendering with suspend hooks, and measurement of what came out.

import { createEngine } from '../../../js/dj/engine.js';

export const SR = 48000;

/** Collects assertions; a group returns suite.results. */
export function suite() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail: String(detail) });
    return !!ok;
  };
  return { results, check };
}

export const ms = (s) => `${(s * 1000).toFixed(3)} ms`;
export const db = (ratio) => (ratio > 0 ? 20 * Math.log10(ratio) : -Infinity);
export const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

/**
 * Context seconds rendered before set time 0. The engine maps set time onto context time with an
 * offset in real use, so the tests do too; a whole second keeps suspend() hooks on quantum boundaries.
 */
export const PRE = 1;

export function offlineCtx(seconds, sr = SR) {
  const frames = Math.ceil((seconds * sr) / 128) * 128;
  return new OfflineAudioContext(2, frames, sr);
}

/**
 * Build an engine on a fresh OfflineAudioContext, let `build` schedule things at set time 0, run
 * `hooks` ([setTime, fn]) deterministically mid-render via ctx.suspend(), render, and hand back the
 * samples indexed by SET time (L[0] is set time 0).
 * Hook times must sit on a render-quantum boundary; whole seconds are exact at 48 kHz.
 */
export async function renderSet({ seconds, build, hooks = [], engineOpts = {}, sr = SR, pre = PRE }) {
  const ctx = offlineCtx(seconds + pre, sr);
  const engine = createEngine({ context: ctx, ...engineOpts });
  await engine.start({ at: pre });
  const errors = [];
  if (build) await build(engine, ctx);
  for (const [t, fn] of hooks) {
    ctx.suspend(t + pre).then(async () => {
      try {
        await fn(engine, ctx);
      } catch (err) {
        errors.push(`hook@${t}: ${err && err.stack ? err.stack : err}`);
      }
      ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  if (errors.length) throw new Error(errors.join('\n'));
  const skip = Math.round(pre * sr);
  return { out, engine, ctx, L: out.getChannelData(0).subarray(skip), R: out.getChannelData(1).subarray(skip), sr };
}

/** A Play with sane defaults (rate 1, no events). */
export function mkPlay(id, o = {}) {
  const startAt = o.startAt ?? 0;
  return {
    id,
    trackId: `test:${id}`,
    deck: id % 2,
    startAt,
    offset: o.offset ?? 0,
    rate: o.rate ?? [{ t: startAt, v: 1 }],
    trimDb: o.trimDb ?? 0,
    events: o.events ?? [],
    endAt: o.endAt ?? null,
    soloFrom: o.soloFrom ?? startAt,
  };
}

export const ev = (p, t, v, k = 'set', tc) => (tc === undefined ? { p, t, v, k } : { p, t, v, k, tc });

/** channels: 'both' | 0 | 1 */
const chans = (channel) => (channel === 'both' ? [0, 1] : [channel]);

export function emptyBuffer(ctx, seconds) {
  return ctx.createBuffer(2, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
}

/** Add a short symmetric blip (raised cosine, `width` samples) centred on buffer position `pos`. */
export function addBlip(buffer, pos, amp = 0.5, channel = 'both', width = 9) {
  const c = Math.round(pos * buffer.sampleRate);
  const h = (width - 1) / 2;
  for (const ch of chans(channel)) {
    const d = buffer.getChannelData(ch);
    for (let k = -h; k <= h; k++) {
      const i = c + k;
      if (i >= 0 && i < d.length) d[i] += amp * 0.5 * (1 + Math.cos((Math.PI * k) / (h + 1)));
    }
  }
  return buffer;
}

export function clickBuffer(ctx, seconds, positions, { amp = 0.5, channel = 'both' } = {}) {
  const buf = emptyBuffer(ctx, seconds);
  for (const p of positions) addBlip(buf, p, amp, channel);
  return buf;
}

export function addSine(buffer, freq, amp, channel = 'both', from = 0, to = Infinity, phase = 0) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.round(from * sr));
  for (const ch of chans(channel)) {
    const d = buffer.getChannelData(ch);
    const b = Math.min(d.length, Math.round(to * sr));
    for (let i = a; i < b; i++) d[i] += amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  }
  return buffer;
}

export function sineBuffer(ctx, seconds, freq, amp = 0.4, channel = 'both') {
  return addSine(emptyBuffer(ctx, seconds), freq, amp, channel);
}

/** Hann-windowed tone burst centred on `pos`. */
export function addBurst(buffer, pos, freq, amp, dur = 0.03, channel = 'both') {
  const sr = buffer.sampleRate;
  const n = Math.round(dur * sr);
  const start = Math.round(pos * sr) - (n >> 1);
  for (const ch of chans(channel)) {
    const d = buffer.getChannelData(ch);
    for (let k = 0; k < n; k++) {
      const i = start + k;
      if (i < 0 || i >= d.length) continue;
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (n - 1)));
      d[i] += amp * w * Math.sin((2 * Math.PI * freq * k) / sr);
    }
  }
  return buffer;
}

// ----- measurement -----------------------------------------------------------------------------

export function rms(data, t0, t1, sr = SR) {
  const a = Math.max(0, Math.round(t0 * sr));
  const b = Math.min(data.length, Math.round(t1 * sr));
  let s = 0;
  for (let i = a; i < b; i++) s += data[i] * data[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}

export function peak(data, t0 = 0, t1 = Infinity, sr = SR) {
  const a = Math.max(0, Math.round(t0 * sr));
  const b = Math.min(data.length, Math.round(t1 * sr));
  let m = 0;
  for (let i = a; i < b; i++) {
    const x = Math.abs(data[i]);
    if (x > m) m = x;
  }
  return m;
}

/** Largest sample-to-sample step in [t0, t1]: a click shows up here long before it shows in the level. */
export function maxStep(data, t0 = 0, t1 = Infinity, sr = SR) {
  const a = Math.max(1, Math.round(t0 * sr));
  const b = Math.min(data.length, Math.round(t1 * sr));
  let m = 0;
  for (let i = a; i < b; i++) {
    const x = Math.abs(data[i] - data[i - 1]);
    if (x > m) m = x;
  }
  return m;
}

/** Amplitude of a sine carrier around time t: RMS·√2 over `win` seconds (use a whole number of periods). */
export function envelopeAt(data, t, win = 0.002, sr = SR) {
  return rms(data, t - win / 2, t + win / 2, sr) * Math.SQRT2;
}

/**
 * Find isolated transients: regions where |x| > threshold (regions closer than `gap` seconds merge).
 * Time = energy centroid of the region, which is sub-sample accurate for a symmetric blip.
 * @returns {{t:number, amp:number}[]}
 */
export function findClicks(data, { threshold = 0.02, gap = 0.004, from = 0, to = Infinity, sr = SR } = {}) {
  const out = [];
  const a = Math.max(0, Math.round(from * sr));
  const b = Math.min(data.length, Math.round(to * sr));
  const gapN = Math.round(gap * sr);
  let i = a;
  while (i < b) {
    if (Math.abs(data[i]) <= threshold) {
      i++;
      continue;
    }
    let end = i;
    let j = i;
    while (j < b && j - end <= gapN) {
      if (Math.abs(data[j]) > threshold) end = j;
      j++;
    }
    const lo = Math.max(0, i - 12);
    const hi = Math.min(data.length - 1, end + 12);
    let e = 0;
    let et = 0;
    let amp = 0;
    for (let k = lo; k <= hi; k++) {
      const x = data[k];
      e += x * x;
      et += x * x * k;
      if (Math.abs(x) > amp) amp = Math.abs(x);
    }
    out.push({ t: et / e / sr, amp });
    i = end + gapN + 1;
  }
  return out;
}

/** Second difference: flattens kicks / pads so the timing blips stand out. */
export function highlight(data) {
  const out = new Float32Array(data.length);
  for (let i = 2; i < data.length; i++) out[i - 1] = (2 * data[i - 1] - data[i] - data[i - 2]) * 0.5;
  return out;
}

/** Match measured click times to expected ones; returns the worst error and how many matched. */
export function matchClicks(found, expected, tol = 0.02) {
  let worst = 0;
  let matched = 0;
  const missing = [];
  for (const t of expected) {
    let best = Infinity;
    for (const c of found) {
      const d = Math.abs(c.t - t);
      if (d < best) best = d;
    }
    if (best <= tol) {
      matched++;
      if (best > worst) worst = best;
    } else missing.push(t);
  }
  return { worst, matched, missing };
}

/**
 * |H(f)| of the Web Audio lowpass / highpass biquad (Q in dB, as the spec defines it for these types).
 * Used to predict what a moving cutoff should do to a test tone.
 */
export function biquadMag(type, f0, qDb, f, sr = SR) {
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const cos = Math.cos(w0);
  let b0;
  let b1;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
  }
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const w = (2 * Math.PI * f) / sr;
  const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
  const im = (c1, c2) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
  const den = Math.hypot(re(a0, a1, a2), im(a1, a2));
  return num / den;
}

let cachedLatency = null;
/**
 * The constant delay between "scheduled" and "appears in the output" (limiter look-ahead plus the
 * sub-sample group delay of the strip filters), measured once with a single blip.
 */
export async function measureLatency() {
  if (cachedLatency != null) return cachedLatency;
  const { L } = await renderSet({
    seconds: 1,
    build: (engine, ctx) => engine.addPlay(mkPlay(0), clickBuffer(ctx, 0.8, [0.25])),
  });
  const clicks = findClicks(L, { threshold: 0.05 });
  cachedLatency = clicks.length ? clicks[0].t - 0.25 : NaN;
  return cachedLatency;
}

export const sleep = (msec) => new Promise((r) => setTimeout(r, msec));

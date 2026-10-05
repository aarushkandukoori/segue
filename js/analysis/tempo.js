// Tempo, beat grid and downbeat estimation from mono PCM at the analysis rate (FS).
//
//   onsetEnvelopes   STFT → log band magnitudes → half-wave rectified spectral flux in 3 bands
//   estimateTempo    autocorrelation comb + pulse-train features → beat period (frames) + confidence
//   trackGrid        beat positions: a phase-locked chain of local grid fits; collapses to ONE exact
//                    constant-tempo grid whenever the music allows it (what DJs call "the grid")
//   pickDownbeat     which beat phase (mod 4) carries the bar accent
//
// Everything works in onset-envelope frames (FPS per second); analyze.js converts to seconds.
import {
  createRealFFT,
  hann,
  autocorrelate,
  lerpAt,
  movingAverage,
  gaussianSmooth,
  clamp,
  parabolicPeak,
} from './dsp.js';

/** Analysis sample rate. analyze.js resamples everything to this. */
export const FS = 22050;
export const FRAME = 1024;
export const HOP = 128;
/** Onset-envelope frame rate (≈ 172.27 Hz → 5.8 ms per frame). */
export const FPS = FS / HOP;

/** Final tempo range of the product: bpm is folded into [BPM_LO, BPM_HI). */
export const BPM_LO = 70;
export const BPM_HI = 180;

const FLUX_LAG = 3; // frames between the two spectra that are differenced (≈ 17 ms)
const LOG_C = 100; // compression: ln(1 + C·|X|) on RMS-normalised band magnitudes
const LOW_HZ = 200;
const HIGH_HZ = 2500;

// Quasi-logarithmic bands: one bin wide at the bottom (21.5 Hz), ≈ quarter-octave further up.
const BAND_EDGES = (() => {
  const edges = [1];
  let b = 1;
  while (b < FRAME / 2) {
    b = Math.min(FRAME / 2, b + Math.max(1, Math.round(b * 0.19)));
    edges.push(b);
  }
  return Int32Array.from(edges);
})();
const NBANDS = BAND_EDGES.length - 1;
const BIN_HZ = FS / FRAME;
const LOW_BANDS = (() => {
  let i = 0;
  while (i < NBANDS && BAND_EDGES[i] * BIN_HZ < LOW_HZ) i++;
  return i;
})();
const MID_BANDS = (() => {
  let i = 0;
  while (i < NBANDS && BAND_EDGES[i] * BIN_HZ < HIGH_HZ) i++;
  return i;
})();

let shared = null;
function stft() {
  if (!shared) {
    const win = hann(FRAME);
    let wsum2 = 0;
    for (let i = 0; i < FRAME; i++) wsum2 += win[i] * win[i];
    shared = {
      win,
      wsum2,
      fft: createRealFFT(FRAME),
      frame: new Float64Array(FRAME),
      pow: new Float64Array(FRAME / 2 + 1),
    };
  }
  return shared;
}

/**
 * Spectral-flux onset envelopes. Frame t is centred on sample t·HOP (zero-padded at the edges), so
 * frame index ↔ time is simply t / FPS.
 * @param {Float32Array} x mono PCM at FS
 * @returns {{n:number, low:Float64Array, mid:Float64Array, high:Float64Array, flux:Float64Array, sub:Float64Array, silent:boolean}}
 *   low / mid / high / flux: half-wave rectified log-magnitude flux (flux = their sum);
 *   sub: linear amplitude below ≈ 120 Hz (not a flux — used to tell kick drums from everything else)
 */
export function onsetEnvelopes(x) {
  const len = x.length;
  const n = Math.floor(len / HOP) + 1;
  const low = new Float64Array(n);
  const mid = new Float64Array(n);
  const high = new Float64Array(n);
  const flux = new Float64Array(n);
  const sub = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < len; i++) ss += x[i] * x[i];
  const ms = len > 0 ? ss / len : 0;
  if (!(ms > 1e-10)) return { n, low, mid, high, flux, sub, silent: true };

  const { win, wsum2, fft, frame, pow } = stft();
  // Normalise so a unit-RMS signal has total band energy ≈ 1 → the log compression is level-independent.
  const norm = 1 / (ms * wsum2 * (FRAME / 2));
  const hist = new Float64Array((FLUX_LAG + 1) * NBANDS);
  const halfFrame = FRAME / 2;

  for (let t = 0; t < n; t++) {
    const start = t * HOP - halfFrame;
    if (start >= 0 && start + FRAME <= len) {
      for (let i = 0; i < FRAME; i++) frame[i] = x[start + i] * win[i];
    } else {
      for (let i = 0; i < FRAME; i++) {
        const j = start + i;
        frame[i] = j >= 0 && j < len ? x[j] * win[i] : 0;
      }
    }
    fft.power(frame, pow);
    // linear amplitude below ≈ 120 Hz: the body of a kick drum
    sub[t] = Math.sqrt((pow[1] + pow[2] + pow[3] + pow[4] + pow[5]) * norm);
    const cur = (t % (FLUX_LAG + 1)) * NBANDS;
    for (let b = 0; b < NBANDS; b++) {
      let s = 0;
      for (let k = BAND_EDGES[b], e = BAND_EDGES[b + 1]; k < e; k++) s += pow[k];
      hist[cur + b] = Math.log(1 + LOG_C * Math.sqrt(s * norm));
    }
    if (t < FLUX_LAG) continue;
    const prev = ((t - FLUX_LAG) % (FLUX_LAG + 1)) * NBANDS;
    let l = 0;
    let m = 0;
    let h = 0;
    for (let b = 0; b < NBANDS; b++) {
      // Reference = max over neighbouring bands of the older frame ("SuperFlux"): a partial that merely
      // glides to the next band (vibrato, pitch bends) is not an onset.
      let ref = hist[prev + b];
      if (b > 0 && hist[prev + b - 1] > ref) ref = hist[prev + b - 1];
      if (b < NBANDS - 1 && hist[prev + b + 1] > ref) ref = hist[prev + b + 1];
      const d = hist[cur + b] - ref;
      if (d > 0) {
        if (b < LOW_BANDS) l += d;
        else if (b < MID_BANDS) m += d;
        else h += d;
      }
    }
    low[t] = l;
    mid[t] = m;
    high[t] = h;
    flux[t] = l + m + h;
  }
  return { n, low, mid, high, flux, sub, silent: false };
}

/**
 * Local-mean removal + half-wave rectification + unit-variance scaling of a raw flux curve.
 * @param {Float64Array} flux
 * @returns {{env:Float64Array, flat:boolean}} flat = nothing but numerical dust (silence / DC)
 */
export function prepareEnvelope(flux) {
  const n = flux.length;
  const env = new Float64Array(n);
  if (n === 0) return { env, flat: true };
  const mean = movingAverage(flux, Math.round(0.5 * FPS));
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const v = flux[i] - mean[i];
    const e = v > 0 ? v : 0;
    env[i] = e;
    s += e;
    s2 += e * e;
  }
  const variance = s2 / n - (s / n) * (s / n);
  if (!(variance > 1e-12)) {
    env.fill(0);
    return { env, flat: true };
  }
  const k = 1 / Math.sqrt(variance);
  for (let i = 0; i < n; i++) env[i] *= k;
  return { env, flat: false };
}

/**
 * "Kick-likeness" per frame, ≈ 0 … 1.5: mean of two normalised cues —
 *   burst: the amplitude below ~120 Hz steps up (≈ 35 ms after vs. ≈ 30 ms before), and
 *   snap : spectral flux in the bands below 200 Hz (how abruptly the low end changes).
 * A kick drum has both. A hi-hat or clap has neither, a side-chained bass swell has no snap, a plucked
 * off-beat bass note has less burst than the kick it answers.
 * In dance music the open hi-hat on the "and" often produces MORE total spectral flux than the kick; this
 * envelope is what keeps the grid from locking onto it (half a beat off).
 * @param {{n:number, sub:Float64Array, low:Float64Array}} on  from onsetEnvelopes
 * @returns {Float64Array}
 */
export function kickEnvelope(on) {
  const n = on.n;
  const burst = new Float64Array(n);
  const out = new Float64Array(n);
  for (let t = 5; t < n - 6; t++) {
    const d = on.sub[t + 6] - on.sub[t - 5];
    burst[t] = d > 0 ? d : 0;
  }
  const scale = (arr) => {
    const s = Float64Array.from(arr).sort();
    return s[Math.floor(0.98 * (s.length - 1))] || 0;
  };
  const bs = scale(burst);
  const ls = scale(on.low);
  if (!(bs > 0) || !(ls > 0)) return out;
  for (let t = 0; t < n; t++) {
    const a = burst[t] / bs;
    // the flux peak leads the amplitude step by a frame or two: take its maximum nearby
    let l = on.low[t];
    if (t > 0 && on.low[t - 1] > l) l = on.low[t - 1];
    if (t > 1 && on.low[t - 2] > l) l = on.low[t - 2];
    if (t + 1 < n && on.low[t + 1] > l) l = on.low[t + 1];
    const b = l / ls;
    out[t] = 0.5 * ((a > 1.5 ? 1.5 : a) + (b > 1.5 ? 1.5 : b));
  }
  return out;
}

export const periodToBpm = (period) => (60 * FPS) / period;
export const bpmToPeriod = (bpm) => (60 * FPS) / bpm;

/** Fold a tempo into [BPM_LO, BPM_HI) by octaves. */
export function foldBpm(bpm) {
  if (!(bpm > 0) || !isFinite(bpm)) return 120;
  while (bpm < BPM_LO) bpm *= 2;
  while (bpm >= BPM_HI) bpm /= 2;
  return bpm;
}

/**
 * Beat-synchronous onset profile for a candidate period: how the (smoothed) envelope is distributed
 * over one beat when the best phase is put at 0. Evaluated on ~10 s windows (each with its own best
 * phase, so slow tempo drift does not smear it) and averaged.
 * @param {Float64Array} env  smoothed envelope
 * @param {number} period     frames per beat
 * @returns {{on:number, half:number, third:number, quarter:number, mean:number}}
 *   on = mean envelope at the beats; half = at beat + ½; third = mean of ⅓ and ⅔; quarter = mean of ¼ and ¾
 */
export function pulseProfile(env, period) {
  const n = env.length;
  const winLen = Math.min(n, Math.max(Math.round(period * 8), Math.round(10 * FPS)));
  const nWin = Math.max(1, Math.round(n / winLen));
  const bins = Math.max(8, Math.round(period));
  const hist = new Float64Array(bins);
  const count = new Float64Array(bins);
  const acc = { on: 0, half: 0, third: 0, quarter: 0, mean: 0 };
  let used = 0;
  for (let w = 0; w < nWin; w++) {
    const a = Math.floor((w * n) / nWin);
    const b = Math.floor(((w + 1) * n) / nWin);
    if (b - a < period * 3) continue;
    hist.fill(0);
    count.fill(0);
    let total = 0;
    for (let t = a; t < b; t++) {
      const ph = (t - a) / period;
      const bin = Math.floor((ph - Math.floor(ph)) * bins);
      hist[bin] += env[t];
      count[bin]++;
      total += env[t];
    }
    let best = 0;
    let bestV = -1;
    for (let i = 0; i < bins; i++) {
      hist[i] = count[i] > 0 ? hist[i] / count[i] : 0;
    }
    // 3-bin smoothing so a peak split across two bins is not penalised
    for (let i = 0; i < bins; i++) {
      const v = 0.25 * hist[(i + bins - 1) % bins] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % bins];
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    const at = (frac) => {
      const p = best + frac * bins;
      const i = Math.round(p) % bins;
      return 0.25 * hist[(i + bins - 1) % bins] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % bins];
    };
    acc.on += at(0);
    acc.half += at(0.5);
    acc.third += 0.5 * (at(1 / 3) + at(2 / 3));
    acc.quarter += 0.5 * (at(0.25) + at(0.75));
    acc.mean += total / (b - a);
    used++;
  }
  if (used === 0) return acc;
  acc.on /= used;
  acc.half /= used;
  acc.third /= used;
  acc.quarter /= used;
  acc.mean /= used;
  return acc;
}

// Provider tempo hints are wrong in their own way (Deezer: octave errors, 3:2 errors on shuffles and 6/8),
// so a hint may only break a near-tie between our own candidates.
const HINT_BOOST = 1.05;

/** Threshold on the off-beat/on-beat onset ratio above which the double-time reading wins (see estimateTempo). */
function halfBeatThreshold(slowBpm) {
  return clamp(0.3 + (slowBpm - 76) * 0.045, 0.3, 0.6);
}

/**
 * Global tempo of an onset envelope.
 *
 * 1. Autocorrelation of the envelope; "comb" score of a period = mean ACF at 1×, 2×, 3×, 4× the period.
 * 2. Candidates are the comb peaks inside the product range [70, 180) BPM. Each is scored by its own comb
 *    value plus 0.3 × the comb values at twice and half its period: a real tactus has support at both
 *    neighbouring metrical levels, a 3:2 / 4:3 impostor (dotted rhythms, triplets) at one of them at most.
 * 3. Only tempos in [70, 90) ∪ [140, 180) have an octave twin inside the range. There the choice is made by
 *    the beat-synchronous onset profile at the slow reading: if the "and" of the beat is nearly as loud as
 *    the beat itself (backbeat snares, driving eighths), the fast reading is the tactus.
 *
 * @param {Float64Array} env   prepared envelope (see prepareEnvelope)
 * @param {{bpmHint?:number, debug?:object}} [opts]  bpmHint: provider-supplied tempo (noisy, octave-unreliable) — a mild nudge only
 * @returns {{period:number, bpm:number, strength:number, margin:number}}
 *   period in frames; strength = comb score of the winner (≈ 0 … 1, "how periodic is this");
 *   margin = winner score / best score of a candidate that is not an octave relative (≥ 1)
 */
export function estimateTempo(env, opts = {}) {
  const n = env.length;
  const hint = opts.bpmHint > 0 && isFinite(opts.bpmHint) ? foldBpm(opts.bpmHint) : 0;
  const none = { period: bpmToPeriod(hint || 120), bpm: hint || 120, strength: 0, margin: 1 };
  if (n < FPS * 3) return none;
  const smooth = gaussianSmooth(env, 1.5);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += smooth[i];
  mean /= n;
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = smooth[i] - mean;

  const loP = bpmToPeriod(BPM_HI * 1.001);
  const hiP = bpmToPeriod(BPM_LO);
  const maxLag = Math.min(n - 1, Math.ceil(hiP * 8) + 2);
  const acf = autocorrelate(centered, maxLag);
  if (!(acf[0] > 1e-9)) return none;
  const inv = 1 / acf[0];
  for (let i = 0; i <= maxLag; i++) acf[i] *= inv;

  const comb = (p) => {
    let s = 0;
    let k = 0;
    for (let m = 1; m <= 4; m++) {
      const lag = p * m;
      if (lag > maxLag - 1) break;
      s += lerpAt(acf, lag);
      k++;
    }
    return k ? s / k : 0;
  };

  const STEP = 0.25;
  const count = Math.floor((hiP - loP) / STEP) + 1;
  const score = new Float64Array(count);
  for (let i = 0; i < count; i++) score[i] = comb(loP + i * STEP);

  /** @type {{period:number, comb:number, s:number}[]} */
  const cands = [];
  for (let i = 0; i < count; i++) {
    const l = i > 0 ? score[i - 1] : -Infinity;
    const r = i < count - 1 ? score[i + 1] : -Infinity;
    if (score[i] > l && score[i] >= r) {
      const period = loP + (i > 0 && i < count - 1 ? parabolicPeak(score, i) : i) * STEP;
      let s = score[i] + 0.3 * (comb(period * 2) + comb(period / 2));
      if (hint) {
        const ratio = periodToBpm(period) / hint;
        if (Math.abs(ratio - 1) < 0.04 || Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.02) s *= HINT_BOOST;
      }
      cands.push({ period, comb: score[i], s });
    }
  }
  if (cands.length === 0) return none;
  cands.sort((a, b) => b.s - a.s);
  const best = cands[0];
  if (!(best.comb > 0)) return none;

  // Sharpen the period: the comb curve was sampled every ¼ frame; long lags pin it down much better.
  let period = best.period;
  let bestV = -Infinity;
  for (let q = best.period - 0.5; q <= best.period + 0.5; q += 0.02) {
    let v = 0;
    let k = 0;
    for (let m = 1; m <= 8; m++) {
      const lag = q * m;
      if (lag > maxLag - 1) break;
      v += lerpAt(acf, lag);
      k++;
    }
    v = k ? v / k : 0;
    if (v > bestV) {
      bestV = v;
      period = q;
    }
  }

  // Margin over the best candidate from a different tempo class (not ×2 / ÷2 of the winner).
  let rival = 0;
  for (let i = 1; i < cands.length; i++) {
    const ratio = cands[i].period / best.period;
    const octave = Math.abs(ratio - 2) < 0.06 || Math.abs(ratio - 0.5) < 0.015 || Math.abs(ratio - 1) < 0.03;
    if (!octave && cands[i].s > rival) rival = cands[i].s;
  }
  const margin = rival > 0 ? best.s / rival : 4;

  // Octave choice where both readings are inside the range.
  let bpm = periodToBpm(period);
  let halfOn = -1;
  if (bpm < 90 || bpm >= 140) {
    const slowP = bpm < 90 ? period : period * 2;
    const slowBpm = periodToBpm(slowP);
    const prof = pulseProfile(smooth, slowP);
    halfOn = prof.on > 0 ? prof.half / prof.on : 0;
    let fast = halfOn >= halfBeatThreshold(slowBpm);
    if (slowBpm * 2 >= BPM_HI) fast = false;
    if (slowBpm < BPM_LO) fast = true;
    period = fast ? slowP / 2 : slowP;
    bpm = periodToBpm(period);
  }
  if (opts.debug) {
    opts.debug.cands = cands.slice(0, 6).map((c) => ({ bpm: periodToBpm(c.period), comb: c.comb, s: c.s }));
    opts.debug.halfOn = halfOn;
  }
  return { period, bpm, strength: clamp(best.comb, 0, 1), margin };
}

/** The envelope the phase tracker scores against: Gaussian-smoothed with σ = period / 32. */
export function beatLocalScore(env, period) {
  return gaussianSmooth(env, Math.max(1, period / 32));
}

/** Mean envelope value at a set of (fractional) frame positions inside [from, to]. */
export function meanAt(env, positions, from = 0, to = env.length - 1) {
  let s = 0;
  let k = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p >= from && p <= to && p <= env.length - 1) {
      s += lerpAt(env, p);
      k++;
    }
  }
  return k ? s / k : 0;
}

/**
 * One weighted-least-squares pass of the grid  beat(i) = off + i·per  against the envelope peaks that lie
 * within ±capture·per of the predicted beats inside [lo, hi). Returns null when there is nothing to fit.
 * `level` = captured peak weight per expected beat (how much the window had to say).
 */
function gridPass(env, off, per, lo, hi, capture) {
  const half = Math.max(2, per * capture);
  const i0 = Math.ceil((lo - off) / per);
  const i1 = Math.floor((hi - 1 - off) / per);
  let sw = 0;
  let swi = 0;
  let swb = 0;
  let swii = 0;
  let swib = 0;
  let used = 0;
  const last = env.length - 2;
  for (let i = i0; i <= i1; i++) {
    const c = off + i * per;
    const a = Math.max(1, Math.ceil(c - half));
    const b = Math.min(last, Math.floor(c + half));
    let pk = -1;
    let pv = 0;
    for (let t = a; t <= b; t++) {
      const e = env[t];
      if (e >= env[t - 1] && e >= env[t + 1]) {
        // tent weighting keeps the choice stable when two onsets are in reach
        const v = e * (1 - (0.5 * Math.abs(t - c)) / half);
        if (v > pv) {
          pv = v;
          pk = t;
        }
      }
    }
    if (pk < 0) continue;
    const pos = parabolicPeak(env, pk);
    const w = env[pk];
    const x = i - i0; // keep the regression well conditioned
    sw += w;
    swi += w * x;
    swb += w * pos;
    swii += w * x * x;
    swib += w * x * pos;
    used++;
  }
  if (used < 4) return null;
  const den = sw * swii - swi * swi;
  if (!(den > 1e-9)) return null;
  const slope = (sw * swib - swi * swb) / den;
  if (!(slope > per * 0.96 && slope < per * 1.04)) return null;
  const at0 = (swb - slope * swi) / sw; // position of beat i0
  return { off: at0 - slope * i0, per: slope, used, level: sw / Math.max(1, i1 - i0 + 1) };
}

/** Best phase of a period inside [a, b): folded histogram (1-frame bins, lightly smoothed). */
function foldPhase(env, a, b, period) {
  const bins = Math.max(8, Math.round(period));
  const hist = new Float64Array(bins);
  const count = new Float64Array(bins);
  for (let t = a; t < b; t++) {
    const ph = (t - a) / period;
    const bin = Math.floor((ph - Math.floor(ph)) * bins) % bins;
    hist[bin] += env[t];
    count[bin]++;
  }
  for (let i = 0; i < bins; i++) hist[i] = count[i] > 0 ? hist[i] / count[i] : 0;
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < bins; i++) {
    const v = 0.25 * hist[(i + bins - 1) % bins] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % bins];
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  return { phase: ((best + 0.5) / bins) * period, value: bestV };
}

const WIN_BEATS = 16;
const HOP_BEATS = 4;
const SEED_BEATS = 24;
// The constant grid wins when it catches at least this share of the onset energy the local fits catch.
const STEADY_RATIO = 0.85;

/**
 * Beat positions for a known approximate period — a phase-locked chain of local grid fits.
 *
 * 1. Seed: the busiest ~24 beats; local tempo by scanning ±4 % around `period0`, phase from the folded
 *    histogram, then least squares on the envelope peaks.
 * 2. Chain: 16-beat windows hopping 4 beats outwards in both directions, each fitted starting from its
 *    neighbour's solution. A window can only capture peaks within ±12 % of a beat of where its neighbour
 *    predicts them, so the chain follows a drummer who speeds up or slows down but cannot hop onto a
 *    syncopation (off-beat stabs, swung notes) — the classic way beat trackers end up half a beat off.
 *    Windows with nothing to say (breakdowns, quiet intros) inherit their neighbour's fit.
 * 3. A single constant grid is fitted as well (the line through the chain's beats, polished on the whole
 *    track). If it catches about as much onset energy as the chain does (quantised productions), the
 *    answer is that exact grid. Otherwise (live drummers) the locally fitted beats are returned.
 *
 * @param {Float64Array} env   smoothed prepared envelope
 * @param {number} period0     approximate frames per beat (global estimate, right tempo class)
 * @param {number} [from]      active region (frames) used for the steady / wandering decision
 * @param {number} [to]
 * @param {boolean} [halfBeatShift]  start the seed half a beat later (see analyze.js: used when the first
 *                                  pass turned out to sit on the off-beat hats instead of the kicks)
 * @returns {{steady:boolean, offset:number, period:number, beats:Float64Array, ratio:number}}
 *   steady → beats = offset + i·period exactly (offset = first beat ≥ 0). Otherwise period = median interval.
 *   ratio = onset energy caught by the constant grid ÷ by the local fits.
 */
export function trackGrid(env, period0, from = 0, to = env.length - 1, halfBeatShift = false) {
  const n = env.length;
  const seedLen = Math.min(n, Math.round(period0 * SEED_BEATS));
  // Busiest window by Σ env².
  let a = 0;
  if (n > seedLen) {
    let run = 0;
    for (let i = 0; i < seedLen; i++) run += env[i] * env[i];
    let bestRun = run;
    for (let i = seedLen; i < n; i++) {
      run += env[i] * env[i] - env[i - seedLen] * env[i - seedLen];
      if (run > bestRun) {
        bestRun = run;
        a = i - seedLen + 1;
      }
    }
  }
  // Local tempo of the seed window. Scanned outwards from the global estimate; a neighbour must be
  // clearly better (10 %) to replace it, so a steady track keeps its (more precise) global tempo.
  let per = period0;
  let seed = foldPhase(env, a, a + seedLen, period0);
  for (let k = 1; k <= 8; k++) {
    for (const sign of [-1, 1]) {
      const p = period0 * (1 + sign * k * 0.005);
      const f = foldPhase(env, a, a + seedLen, p);
      if (f.value > seed.value * 1.1) {
        seed = f;
        per = p;
      }
    }
  }
  let off = a + seed.phase + (halfBeatShift ? per / 2 : 0);
  let seedLevel = 0;
  for (const capture of [0.16, 0.1, 0.06]) {
    const r = gridPass(env, off, per, a, a + seedLen, capture);
    if (!r) break;
    off = r.off;
    per = r.per;
    seedLevel = r.level;
  }

  /** @type {{c:number, off:number, per:number}[]} */
  const fits = [{ c: (a + seedLen / 2 - off) / per, off, per }];
  const fitWindow = (o, p, lo, hi) => {
    let r = gridPass(env, o, p, lo, hi, 0.12);
    if (r) r = gridPass(env, r.off, r.per, lo, hi, 0.07) || r;
    const expected = (hi - lo) / p;
    // Only a window that clearly has a beat may steer: most of its beats found, at a healthy level, and
    // at a tempo a drummer could have reached within four beats.
    if (r && Math.abs(r.per / p - 1) <= 0.015 && r.level >= 0.5 * seedLevel && r.used >= 0.6 * expected) {
      return { off: r.off, per: r.per };
    }
    return { off: o, per: p }; // nothing convincing here: coast on the neighbour's grid
  };
  // forwards
  {
    let o = off;
    let p = per;
    for (let lo = a + HOP_BEATS * p; lo + 4 * p < n && fits.length < 100000; lo += HOP_BEATS * p) {
      const hi = Math.min(n, lo + WIN_BEATS * p);
      ({ off: o, per: p } = fitWindow(o, p, lo, hi));
      fits.push({ c: ((lo + hi) / 2 - o) / p, off: o, per: p });
      if (hi >= n) break;
    }
  }
  // backwards
  {
    let o = off;
    let p = per;
    for (let hi = a + seedLen - HOP_BEATS * p; hi - 4 * p > 0 && fits.length < 100000; hi -= HOP_BEATS * p) {
      const lo = Math.max(0, hi - WIN_BEATS * p);
      ({ off: o, per: p } = fitWindow(o, p, lo, hi));
      fits.push({ c: ((lo + hi) / 2 - o) / p, off: o, per: p });
      if (lo <= 0) break;
    }
  }
  fits.sort((x, y) => x.c - y.c);

  // Beat i = triangular blend of the fits whose window covers it.
  const firstFit = fits[0];
  const lastFit = fits[fits.length - 1];
  const iMin = Math.ceil((0 - firstFit.off) / firstFit.per);
  const iMax = Math.floor((n - 1 - lastFit.off) / lastFit.per);
  const K = Math.max(0, iMax - iMin + 1);
  const beats = new Float64Array(K);
  let j0 = 0;
  for (let k = 0; k < K; k++) {
    const i = iMin + k;
    while (j0 < fits.length - 1 && fits[j0].c < i - WIN_BEATS / 2) j0++;
    let sw = 0;
    let sv = 0;
    for (let j = j0; j < fits.length && fits[j].c <= i + WIN_BEATS / 2; j++) {
      const w = 1 - Math.abs(fits[j].c - i) / (WIN_BEATS / 2) + 0.05;
      sw += w;
      sv += w * (fits[j].off + i * fits[j].per);
    }
    if (sw > 0) beats[k] = sv / sw;
    else {
      const f = i < fits[0].c ? firstFit : fits[Math.min(fits.length - 1, j0)];
      beats[k] = f.off + i * f.per;
    }
  }
  for (let k = 1; k < K; k++) if (!(beats[k] > beats[k - 1] + 1)) beats[k] = beats[k - 1] + 1;

  // Would ONE constant grid do? Take the line through the chain's beats (weighted by how much onset each
  // one sits on, so coasting stretches do not vote), polish it on the whole track, and compare how much
  // onset energy it catches with what the chain catches. Occam: if the plain grid is (nearly) as good,
  // the chain's extra wiggles were syncopation, not tempo.
  let gOff = off;
  let gPer = per;
  {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let k = 0; k < K; k++) {
      const c = Math.round(beats[k]);
      let w = 0;
      for (let t = Math.max(0, c - 2); t <= Math.min(n - 1, c + 2); t++) if (env[t] > w) w = env[t];
      w += 1e-3;
      sw += w;
      sx += w * k;
      sy += w * beats[k];
      sxx += w * k * k;
      sxy += w * k * beats[k];
    }
    const den = sw * sxx - sx * sx;
    if (K >= 4 && den > 1e-9) {
      gPer = (sw * sxy - sx * sy) / den;
      gOff = (sy - gPer * sx) / sw;
    }
    for (const capture of [0.08, 0.05]) {
      const r = gridPass(env, gOff, gPer, 0, n, capture);
      if (!r) break;
      gOff = r.off;
      gPer = r.per;
    }
  }
  gOff -= Math.floor(gOff / gPer) * gPer;
  const count = Math.max(1, Math.floor((n - 1 - gOff) / gPer) + 1);
  const exact = new Float64Array(count);
  for (let i = 0; i < count; i++) exact[i] = gOff + i * gPer;
  const reach = Math.max(2, Math.round(0.045 * gPer)); // micro-timing (±4.5 % of a beat) is not tempo drift
  const sLine = supportNear(env, exact, from, to, reach);
  const sChain = supportNear(env, beats, from, to, reach);
  const ratio = sChain > 0 ? sLine / sChain : 1;
  if (K < 6 || ratio >= STEADY_RATIO) {
    return { steady: true, offset: gOff, period: gPer, beats: exact, ratio };
  }
  const iv = [];
  for (let k = 1; k < K; k++) iv.push(beats[k] - beats[k - 1]);
  iv.sort((x, y) => x - y);
  return { steady: false, offset: beats[0], period: iv.length ? iv[iv.length >> 1] : per, beats, ratio };
}

/** Mean of the envelope maximum within ±reach frames of each position inside [from, to]. */
export function supportNear(env, positions, from, to, reach) {
  let s = 0;
  let k = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p < from || p > to) continue;
    const c = Math.round(p);
    let v = 0;
    for (let t = Math.max(0, c - reach); t <= Math.min(env.length - 1, c + reach); t++) if (env[t] > v) v = env[t];
    s += v;
    k++;
  }
  return k ? s / k : 0;
}

const FINE_HOP = 32; // 1.45 ms
const FINE_WIN = 256; // 11.6 ms
const FINE_RANGE = 28; // ± hops searched (≈ ±41 ms)

/**
 * Sample-domain phase refinement. The spectral-flux envelope localises onsets only to within its 46 ms
 * analysis window; here the beats are slid (all together) onto the steepest rise of the short-time energy,
 * i.e. onto the attack of whatever marks the beat (usually the kick).
 * @param {Float32Array} x          mono PCM at FS
 * @param {ArrayLike<number>} beats beat positions in SAMPLES
 * @returns {{shift:number, sharpness:number}} shift in samples to add to every beat; sharpness = peak / mean of the
 *   accumulated rise profile (≈ 1 → no consistent attack found, shift is 0 then)
 */
export function refinePhase(x, beats) {
  const len = x.length;
  const span = 2 * FINE_RANGE + 1;
  const acc = new Float64Array(span);
  let ss = 0;
  for (let i = 0; i < len; i += 7) ss += x[i] * x[i];
  const eps = 1e-4 * (ss / Math.max(1, Math.ceil(len / 7))) * FINE_WIN + 1e-12;
  let used = 0;
  for (let bi = 0; bi < beats.length; bi++) {
    const b = Math.round(beats[bi]);
    const first = b - (FINE_RANGE + 1) * FINE_HOP - FINE_WIN / 2; // window start for hop j = −R−1
    if (first < 0 || b + FINE_RANGE * FINE_HOP + FINE_WIN / 2 >= len) continue;
    let e = 0;
    for (let i = 0; i < FINE_WIN; i++) e += x[first + i] * x[first + i];
    let prev = e;
    for (let j = 0; j < span; j++) {
      const s = first + j * FINE_HOP;
      for (let i = 0; i < FINE_HOP; i++) {
        const out = x[s + i];
        const inn = x[s + FINE_WIN + i];
        e += inn * inn - out * out;
      }
      if (e < 0) e = 0;
      const d = Math.log((e + eps) / (prev + eps));
      if (d > 0) acc[j] += d > 3 ? 3 : d;
      prev = e;
    }
    used++;
  }
  if (used < 4) return { shift: 0, sharpness: 0 };
  let best = 0;
  let mean = 0;
  for (let j = 0; j < span; j++) {
    mean += acc[j];
    if (acc[j] > acc[best]) best = j;
  }
  mean /= span;
  const sharpness = mean > 0 ? acc[best] / mean : 0;
  // No consistent attack (pads, strings), or the "peak" is just the edge of the search range: keep the
  // envelope's phase.
  if (!(sharpness > 2) || best < 3 || best > span - 4) return { shift: 0, sharpness };
  const pos = parabolicPeak(acc, best);
  // Hop j has its window END at b + (j − R)·HOP + WIN/2; the attack sits in the newest HOP samples of the
  // first window that sees it.
  const shift = (pos - FINE_RANGE) * FINE_HOP + FINE_WIN / 2 - FINE_HOP / 2;
  return { shift, sharpness };
}

/**
 * Which beat phase (mod 4) is the bar start.
 *
 * Evidence, averaged over the bars of the active region:
 *   harmonic change — chords / bass notes change on the "one";
 *   kick pattern    — low-band onsets favour beats 1 and 3, snare-band onsets beats 2 and 4;
 *   accent          — the "one" tends to carry the heaviest low-band onset.
 *
 * @param {Float64Array} beats     beat positions (frames)
 * @param {Float64Array} lowEnv    prepared low-band envelope
 * @param {Float64Array} snareEnv  prepared mid+high envelope
 * @param {Float64Array|null} harmonicChange  per-beat harmonic novelty (≥ 0), or null
 * @param {number} from            first beat index to consider
 * @param {number} to              one past the last beat index to consider
 * @returns {{phase:number, confidence:number}} phase ∈ 0..3: beats with (index − phase) % 4 === 0 are downbeats
 */
export function pickDownbeat(beats, lowEnv, snareEnv, harmonicChange, from, to) {
  const sums = { low: new Float64Array(4), snare: new Float64Array(4), harm: new Float64Array(4) };
  const counts = new Float64Array(4);
  const peakNear = (env, c) => {
    let v = 0;
    const a = Math.max(0, Math.round(c) - 3);
    const b = Math.min(env.length - 1, Math.round(c) + 3);
    for (let t = a; t <= b; t++) if (env[t] > v) v = env[t];
    return v;
  };
  for (let i = Math.max(0, from); i < Math.min(beats.length, to); i++) {
    const p = i & 3;
    sums.low[p] += peakNear(lowEnv, beats[i]);
    sums.snare[p] += peakNear(snareEnv, beats[i]);
    if (harmonicChange) sums.harm[p] += harmonicChange[i];
    counts[p]++;
  }
  const rel = (arr) => {
    const out = new Float64Array(4);
    let mean = 0;
    for (let p = 0; p < 4; p++) {
      arr[p] = counts[p] > 0 ? arr[p] / counts[p] : 0;
      mean += arr[p] / 4;
    }
    if (!(mean > 1e-9)) return out;
    for (let p = 0; p < 4; p++) out[p] = clamp((arr[p] - mean) / mean, -1, 1);
    return out;
  };
  const low = rel(sums.low);
  const snare = rel(sums.snare);
  const harm = rel(sums.harm);
  let best = 0;
  let bestV = -Infinity;
  let second = -Infinity;
  for (let p = 0; p < 4; p++) {
    const q = (p + 2) & 3;
    const v = 1.0 * harm[p] + 0.5 * (low[p] + low[q]) * 0.5 - 0.5 * (snare[p] + snare[q]) * 0.5 + 0.3 * low[p];
    if (v > bestV) {
      second = bestV;
      bestV = v;
      best = p;
    } else if (v > second) {
      second = v;
    }
  }
  return { phase: best, confidence: clamp((bestV - second) / 0.3, 0, 1) };
}

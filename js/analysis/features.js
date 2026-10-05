// Loudness, energy, cue region and the 3-band display waveform. Time-domain, one pass each.
import { biquad, clamp } from './dsp.js';

const TARGET_RMS_DB = -16;
const TRIM_MIN_DB = -12;
const TRIM_MAX_DB = 6;
const PEAK_CEILING_DB = -1;

const toDb = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -180);

/**
 * Block loudness: mean square in 400 ms blocks every 100 ms.
 * @param {Float32Array} x
 * @param {number} fs
 * @returns {{ms:Float64Array, hop:number, block:number}}
 */
export function blockEnergy(x, fs) {
  const hop = Math.max(1, Math.round(fs * 0.1));
  const block = hop * 4;
  const nh = Math.max(1, Math.ceil(x.length / hop));
  const hopSum = new Float64Array(nh);
  for (let h = 0; h < nh; h++) {
    let s = 0;
    const end = Math.min(x.length, (h + 1) * hop);
    for (let i = h * hop; i < end; i++) s += x[i] * x[i];
    hopSum[h] = s;
  }
  // block b covers hops b … b+3 (shorter at the very end)
  const ms = new Float64Array(nh);
  for (let b = 0; b < nh; b++) {
    let s = 0;
    let len = 0;
    for (let h = b; h < Math.min(nh, b + 4); h++) {
      s += hopSum[h];
      len += Math.min(x.length, (h + 1) * hop) - h * hop;
    }
    ms[b] = len > 0 ? s / len : 0;
  }
  return { ms, hop, block };
}

/**
 * Gated loudness (in the spirit of EBU R128, without K-weighting): RMS over the blocks that are within
 * 10 dB of the mean of all non-silent blocks — "how loud are the loud parts".
 * @param {Float64Array} ms    block mean squares
 * @param {Float32Array} x     samples, for the peak
 * @param {number} [knownPeak] true peak of the original (pre-downmix) audio if the caller has it
 * @returns {{rms:number, peak:number, trimDb:number}}
 */
export function loudness(ms, x, knownPeak) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    if (a > peak) peak = a;
  }
  if (knownPeak > peak && isFinite(knownPeak)) peak = knownPeak;
  const ABS_GATE = 1e-6; // −60 dBFS
  let sum = 0;
  let k = 0;
  for (let i = 0; i < ms.length; i++) {
    if (ms[i] > ABS_GATE) {
      sum += ms[i];
      k++;
    }
  }
  if (k === 0) return { rms: 0, peak, trimDb: 0 };
  const rel = (sum / k) * 0.1; // −10 dB
  let gsum = 0;
  let gk = 0;
  for (let i = 0; i < ms.length; i++) {
    if (ms[i] > ABS_GATE && ms[i] >= rel) {
      gsum += ms[i];
      gk++;
    }
  }
  const rms = Math.sqrt(gk ? gsum / gk : sum / k);
  let trimDb = clamp(TARGET_RMS_DB - toDb(rms), TRIM_MIN_DB, TRIM_MAX_DB);
  // never lift the peak above the ceiling (attenuation is always allowed)
  const room = PEAK_CEILING_DB - toDb(peak);
  if (trimDb > 0 && trimDb > room) trimDb = Math.max(0, room);
  return { rms, peak, trimDb: Math.round(trimDb * 100) / 100 };
}

/**
 * One value per second, 0..1 relative to the track's own loudest second (30 dB range).
 * @param {Float32Array} x
 * @param {number} fs
 * @param {number} [duration] nominal duration in seconds (decides the number of values)
 * @returns {number[]}
 */
export function energyCurve(x, fs, duration = x.length / fs) {
  const secs = Math.max(1, Math.ceil(duration - 1e-6));
  const db = new Float64Array(secs);
  let max = -Infinity;
  for (let s = 0; s < secs; s++) {
    const a = s * fs;
    const b = Math.min(x.length, a + fs);
    let sum = 0;
    for (let i = a; i < b; i++) sum += x[i] * x[i];
    // a short final second is judged on what is there
    db[s] = b > a ? 10 * Math.log10(sum / (b - a) + 1e-12) : -120;
    if (db[s] > max) max = db[s];
  }
  const out = new Array(secs);
  for (let s = 0; s < secs; s++) out[s] = max > -100 ? Math.round(clamp(1 + (db[s] - max) / 30, 0, 1) * 1000) / 1000 : 0;
  return out;
}

/**
 * Usable region of the track: after a fade-in / leading silence, before a fade-out / trailing silence.
 * A fade is only assumed when the first (last) audible block is more than 10 dB below the loud parts —
 * ordinary beat-to-beat dynamics are not a fade — and it is "over" once the level is within 6 dB of what
 * it reaches during the following (preceding) 1.5 s.
 * @param {Float64Array} ms   block mean squares (400 ms blocks, 100 ms hop)
 * @param {number} hopSec
 * @param {number} duration
 * @param {number} loudRms    gated RMS of the track
 * @returns {{start:number, end:number}}
 */
export function usableRegion(ms, hopSec, duration, loudRms) {
  const n = ms.length;
  if (!(loudRms > 0) || n === 0) return { start: 0, end: duration };
  const loudMs = loudRms * loudRms;
  const floorMs = Math.max(1e-6, loudMs * 1e-4); // −40 dB re. the loud parts, at least −60 dBFS
  const fadeMs = loudMs * 0.1; // −10 dB
  let first = 0;
  while (first < n && ms[first] < floorMs) first++;
  if (first >= n) return { start: 0, end: duration };
  let last = n - 1;
  while (last > first && ms[last] < floorMs) last--;
  const look = Math.max(1, Math.round(1.5 / hopSec));
  const maxScan = Math.round(8 / hopSec); // "fades" longer than 8 s are treated as music
  const NEAR = 0.25; // −6 dB in power
  let s = first;
  if (ms[first] < fadeMs) {
    for (let i = first; i <= Math.min(last, first + maxScan); i++) {
      let m = 0;
      for (let j = i; j <= Math.min(last, i + look); j++) if (ms[j] > m) m = ms[j];
      s = i;
      if (ms[i] >= m * NEAR) break;
    }
    if (s === Math.min(last, first + maxScan)) s = first; // never settled: a long build, not a fade
  }
  let e = last;
  if (ms[last] < fadeMs) {
    for (let i = last; i >= Math.max(s, last - maxScan); i--) {
      let m = 0;
      for (let j = i; j >= Math.max(s, i - look); j--) if (ms[j] > m) m = ms[j];
      e = i;
      if (ms[i] >= m * NEAR) break;
    }
    if (e === Math.max(s, last - maxScan)) e = last;
  }
  // Block i covers [i·hop, i·hop + 4 hops): it becomes "audible" thanks to its newest hop at the start of
  // the music and stays so thanks to its oldest hop at the end — lean inwards accordingly.
  let start = s === 0 ? 0 : (s + 3) * hopSec;
  let end = e >= n - 4 ? duration : (e + 1) * hopSec;
  start = clamp(start, 0, duration);
  end = clamp(end, 0, duration);
  if (end - start < Math.min(2, duration * 0.5)) return { start: 0, end: duration };
  return { start, end };
}

/**
 * 3-band peak waveform for the deck display: low < 200 Hz, mid 200 Hz – 2.5 kHz, high > 2.5 kHz
 * (4th-order Butterworth-style splits), 100 columns per second.
 * Scaling: all bands share one reference (the largest full-band column peak → 255) so their relative
 * sizes are real; mid and high get fixed display gains (×1.3, ×2.2) to offset music's natural spectral tilt.
 * @param {Float32Array} x
 * @param {number} fs
 * @param {number} [duration] nominal duration in seconds (decides the number of columns)
 * @returns {{cols:number, perSec:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array,
 *            bandEnergy:{low:number, mid:number, high:number}, lowPeaks:Float32Array}}
 *   bandEnergy = mean square per band; lowPeaks = unscaled low-band column peaks (for drop detection)
 */
export function waveform(x, fs, duration = x.length / fs) {
  const perSec = 100;
  const n = x.length;
  // columns follow the nominal duration (a resampled buffer can be a sample longer or shorter)
  const cols = Math.max(1, Math.ceil(duration * perSec - 1e-6));
  const lastCol = cols - 1;
  const low = new Uint8Array(cols);
  const mid = new Uint8Array(cols);
  const high = new Uint8Array(cols);
  const pl = new Float32Array(cols);
  const pm = new Float32Array(cols);
  const ph = new Float32Array(cols);
  const pf = new Float32Array(cols);
  const lp = biquad('lowpass', 200, fs);
  const hp = biquad('highpass', 2500, fs);
  const mh = biquad('highpass', 200, fs);
  const ml = biquad('lowpass', 2500, fs);
  // biquad states (direct form II transposed), two cascaded sections per split
  let l1a = 0, l1b = 0, l2a = 0, l2b = 0;
  let h1a = 0, h1b = 0, h2a = 0, h2b = 0;
  let m1a = 0, m1b = 0, m2a = 0, m2b = 0, m3a = 0, m3b = 0, m4a = 0, m4b = 0;
  let el = 0;
  let em = 0;
  let eh = 0;
  const step = perSec / fs;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    // low: LP → LP
    let y = lp.b0 * v + l1a;
    l1a = lp.b1 * v - lp.a1 * y + l1b;
    l1b = lp.b2 * v - lp.a2 * y;
    let lo = lp.b0 * y + l2a;
    l2a = lp.b1 * y - lp.a1 * lo + l2b;
    l2b = lp.b2 * y - lp.a2 * lo;
    // high: HP → HP
    y = hp.b0 * v + h1a;
    h1a = hp.b1 * v - hp.a1 * y + h1b;
    h1b = hp.b2 * v - hp.a2 * y;
    let hi = hp.b0 * y + h2a;
    h2a = hp.b1 * y - hp.a1 * hi + h2b;
    h2b = hp.b2 * y - hp.a2 * hi;
    // mid: HP 200 ×2 → LP 2500 ×2
    y = mh.b0 * v + m1a;
    m1a = mh.b1 * v - mh.a1 * y + m1b;
    m1b = mh.b2 * v - mh.a2 * y;
    let z = mh.b0 * y + m2a;
    m2a = mh.b1 * y - mh.a1 * z + m2b;
    m2b = mh.b2 * y - mh.a2 * z;
    y = ml.b0 * z + m3a;
    m3a = ml.b1 * z - ml.a1 * y + m3b;
    m3b = ml.b2 * z - ml.a2 * y;
    let mi = ml.b0 * y + m4a;
    m4a = ml.b1 * y - ml.a1 * mi + m4b;
    m4b = ml.b2 * y - ml.a2 * mi;

    el += lo * lo;
    em += mi * mi;
    eh += hi * hi;
    let c = Math.floor(i * step);
    if (c > lastCol) c = lastCol;
    if (lo < 0) lo = -lo;
    if (mi < 0) mi = -mi;
    if (hi < 0) hi = -hi;
    const fv = v < 0 ? -v : v;
    if (lo > pl[c]) pl[c] = lo;
    if (mi > pm[c]) pm[c] = mi;
    if (hi > ph[c]) ph[c] = hi;
    if (fv > pf[c]) pf[c] = fv;
  }
  let ref = 0;
  for (let c = 0; c < cols; c++) if (pf[c] > ref) ref = pf[c];
  if (ref > 1e-6) {
    const k = 255 / ref;
    for (let c = 0; c < cols; c++) {
      low[c] = Math.min(255, Math.round(pl[c] * k));
      mid[c] = Math.min(255, Math.round(pm[c] * k * 1.3));
      high[c] = Math.min(255, Math.round(ph[c] * k * 2.2));
    }
  }
  const inv = n > 0 ? 1 / n : 0;
  return { cols, perSec, low, mid, high, bandEnergy: { low: el * inv, mid: em * inv, high: eh * inv }, lowPeaks: pl };
}

/**
 * Intensity 0..1 against typical pop / dance masters. Three ingredients, each mapped onto 0..1 with
 * anchors measured on ~340 real chart previews (the median track lands near 0.6, see handoff/analysis.md):
 *   loudness           gated RMS in dBFS
 *   percussive density mean half-wave-rectified spectral flux per frame
 *   brightness         share of the energy above 2.5 kHz, in dB
 * @param {number} rmsDb
 * @param {number} fluxMean
 * @param {number} highShareDb
 */
export function energyScore(rmsDb, fluxMean, highShareDb) {
  const loud = clamp((rmsDb - ENERGY_ANCHORS.rms[0]) / (ENERGY_ANCHORS.rms[1] - ENERGY_ANCHORS.rms[0]), 0, 1);
  const perc = clamp((fluxMean - ENERGY_ANCHORS.flux[0]) / (ENERGY_ANCHORS.flux[1] - ENERGY_ANCHORS.flux[0]), 0, 1);
  const bright = clamp((highShareDb - ENERGY_ANCHORS.high[0]) / (ENERGY_ANCHORS.high[1] - ENERGY_ANCHORS.high[0]), 0, 1);
  return Math.round((0.35 * loud + 0.45 * perc + 0.2 * bright) * 1000) / 1000;
}

/** [value mapped to 0, value mapped to 1] per ingredient. */
export const ENERGY_ANCHORS = {
  rms: [-20, -8.5], // dBFS; chart previews: p10 −16.5, median −11.6, p90 −9.2 (solo piano / ambient ≈ −23)
  flux: [0.9, 2.9], // p10 1.39, median 1.95, p90 2.61 (solo piano / ambient ≈ 0.7)
  high: [-22, -8.5], // dB; p10 −17.1, median −13.0, p90 −9.8 (solo piano / ambient ≈ −35)
};

/**
 * Downbeat with the biggest sustained energy jump ("the drop"), or null when nothing stands out.
 * Compares the 8 beats after each bar line with the 8 beats before it, full-band and low-band.
 * @param {Float64Array} ms         block mean squares (100 ms hop)
 * @param {Float64Array} lowMs      same for the low band, or null
 * @param {number} hopSec
 * @param {number[]} beats          seconds
 * @param {number} downbeat         index of the first bar start
 * @param {number} start            usable region
 * @param {number} end
 * @returns {number|null} time in seconds
 */
export function findDrop(ms, lowMs, hopSec, beats, downbeat, start, end) {
  const meanDb = (arr, t0, t1) => {
    const a = clamp(Math.round(t0 / hopSec), 0, arr.length - 1);
    const b = clamp(Math.round(t1 / hopSec) - 3, a, arr.length - 1); // blocks are 4 hops long
    let s = 0;
    for (let i = a; i <= b; i++) s += arr[i];
    return 10 * Math.log10(s / (b - a + 1) + 1e-10);
  };
  let best = null;
  let bestJump = 3; // dB; anything smaller is not a drop
  for (let i = downbeat; i < beats.length; i += 4) {
    if (i < 8 || i + 8 >= beats.length) continue;
    const t = beats[i];
    // the comparison window must lie inside the music: silence → music is an intro, not a drop
    if (beats[i - 8] < start || t > end - 2) continue;
    const before = meanDb(ms, beats[i - 8], t);
    const after = meanDb(ms, t, beats[i + 8]);
    let jump = after - before;
    if (lowMs) {
      const lowJump = meanDb(lowMs, t, beats[i + 8]) - meanDb(lowMs, beats[i - 8], t);
      jump = 0.5 * jump + 0.5 * clamp(lowJump, -12, 12);
    }
    if (jump > bestJump) {
      bestJump = jump;
      best = t;
    }
  }
  return best;
}

export { toDb };

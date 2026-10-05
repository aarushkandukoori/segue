// Musical key from a tuned chromagram, plus the per-beat harmonic novelty the downbeat picker uses.
//
// 22.05 kHz → 5.5 kHz, 2048-point STFT (2.7 Hz bins, 93 ms hop). Only spectral PEAKS are kept (drums and
// noise mostly vanish), their frequencies are interpolated, the global tuning offset is estimated from
// the peaks themselves, and each peak is folded onto its pitch class. The summed chroma is correlated
// with the 24 rotations of a major/minor key profile.
import { createRealFFT, hann, createResampler, clamp } from './dsp.js';

const DECIM = 4;
const KFRAME = 2048;
const KHOP = 512;
const F_MIN = 55;
const F_MAX = 2000;
const MAX_PEAKS = 96; // per frame

/**
 * Key profiles (index 0 = tonic). Krumhansl–Kessler are the classic probe-tone ratings; `shaath` are the
 * KeyFinder profiles tuned on DJ material. Which one is used is decided by PROFILE below — see
 * handoff/analysis.md for the comparison on real tracks.
 */
export const KEY_PROFILES = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  shaath: {
    major: [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    minor: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  },
  edma: {
    major: [0.1652, 0.0475, 0.0829, 0.0669, 0.0999, 0.0927, 0.0529, 0.1316, 0.0522, 0.0744, 0.0694, 0.0643],
    minor: [0.1724, 0.0534, 0.0761, 0.1004, 0.0562, 0.0853, 0.0498, 0.1345, 0.0746, 0.05, 0.0919, 0.0555],
  },
};
export const DEFAULT_PROFILE = 'shaath';

const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Camelot wheel code: 8B = C major, 8A = A minor, +1 = up a fifth. */
export function camelotCode(pc, mode) {
  const majorPc = mode === 'minor' ? (pc + 3) % 12 : pc;
  return `${((((majorPc * 7) % 12) + 7) % 12) + 1}${mode === 'minor' ? 'A' : 'B'}`;
}

export function keyName(pc, mode) {
  return `${(mode === 'minor' ? MINOR_NAMES : MAJOR_NAMES)[pc]} ${mode}`;
}

let shared = null;
function tools(fs) {
  if (!shared || shared.fs !== fs) {
    shared = {
      fs,
      win: hann(KFRAME),
      fft: createRealFFT(KFRAME),
      frame: new Float64Array(KFRAME),
      pow: new Float64Array(KFRAME / 2 + 1),
      rs: createResampler(fs, fs / DECIM),
    };
  }
  return shared;
}

/**
 * @param {Float32Array} x  mono PCM
 * @param {number} fs       its sample rate (the analysis rate)
 * @returns {{frames:number, fps:number, chroma:Float32Array, tuning:number}}
 *   chroma: frames × 12 (row-major), linear magnitudes; tuning in semitones (−0.5 … 0.5) relative to A440
 */
export function chromagram(x, fs) {
  const { win, fft, frame, pow, rs } = tools(fs);
  const ylen = rs.outLength(x.length);
  const y = new Float32Array(ylen);
  rs.process(x, y, 0, ylen);
  const kfs = fs / DECIM;
  const fps = kfs / KHOP;
  const frames = Math.floor(ylen / KHOP) + 1;
  const chroma = new Float32Array(frames * 12);
  if (ylen < KFRAME / 4) return { frames, fps, chroma, tuning: 0 };

  const binHz = kfs / KFRAME;
  const kMin = Math.max(2, Math.floor(F_MIN / binHz));
  const kMax = Math.min(KFRAME / 2 - 2, Math.ceil(F_MAX / binHz));
  const cap = frames * MAX_PEAKS;
  const pkFrame = new Int32Array(cap);
  const pkMidi = new Float32Array(cap);
  const pkMag = new Float32Array(cap);
  let np = 0;
  const half = KFRAME / 2;
  let tx = 0; // tuning phasor
  let ty = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * KHOP - half;
    for (let i = 0; i < KFRAME; i++) {
      const j = start + i;
      frame[i] = j >= 0 && j < ylen ? y[j] * win[i] : 0;
    }
    fft.power(frame, pow);
    let max = 0;
    for (let k = kMin; k <= kMax; k++) if (pow[k] > max) max = pow[k];
    if (!(max > 1e-12)) continue;
    const floor = max * 1e-4; // −40 dB below the strongest partial of the frame
    let inFrame = 0;
    for (let k = kMin; k <= kMax && inFrame < MAX_PEAKS; k++) {
      const p = pow[k];
      if (p > floor && p > pow[k - 1] && p >= pow[k + 1]) {
        // parabolic interpolation on log power: accurate to a few cents for a Hann window
        const a = Math.log(pow[k - 1] + 1e-30);
        const b = Math.log(p);
        const c = Math.log(pow[k + 1] + 1e-30);
        const den = a - 2 * b + c;
        const delta = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
        const freq = (k + delta) * binHz;
        const midi = 69 + 12 * Math.log2(freq / 440);
        const lf = Math.log2(freq / 260) / 1.6;
        const mag = Math.sqrt(p) * Math.exp(-0.5 * lf * lf);
        pkFrame[np] = f;
        pkMidi[np] = midi;
        pkMag[np] = mag;
        np++;
        inFrame++;
        const ang = 2 * Math.PI * (midi - Math.round(midi));
        tx += mag * Math.cos(ang);
        ty += mag * Math.sin(ang);
      }
    }
  }
  const tuning = tx !== 0 || ty !== 0 ? Math.atan2(ty, tx) / (2 * Math.PI) : 0;
  for (let i = 0; i < np; i++) {
    const m = pkMidi[i] - tuning;
    const r = Math.round(m);
    const c = Math.cos(Math.PI * (m - r)); // 1 on the semitone, 0 half-way between two
    const pc = ((r % 12) + 12) % 12;
    chroma[pkFrame[i] * 12 + pc] += pkMag[i] * c * c;
  }
  return { frames, fps, chroma, tuning };
}

/** Sum the per-frame chroma (each frame weighted by 1/√energy so loud frames do not drown the rest). */
export function globalChroma(chroma, frames, from = 0, to = frames) {
  const out = new Float64Array(12);
  for (let f = Math.max(0, from); f < Math.min(frames, to); f++) {
    let sum = 0;
    for (let p = 0; p < 12; p++) sum += chroma[f * 12 + p];
    if (!(sum > 0)) continue;
    const g = 1 / Math.sqrt(sum);
    for (let p = 0; p < 12; p++) out[p] += chroma[f * 12 + p] * g;
  }
  return out;
}

function pearson(a, b, shift) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12] - ma;
    const y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * @param {ArrayLike<number>} chroma12 summed chroma
 * @param {string} [profileName]
 * @returns {{pc:number, mode:'major'|'minor', name:string, camelot:string, confidence:number}}
 */
export function detectKey(chroma12, profileName = DEFAULT_PROFILE) {
  const prof = KEY_PROFILES[profileName] || KEY_PROFILES[DEFAULT_PROFILE];
  let best = -Infinity;
  let second = -Infinity;
  let pc = 0;
  /** @type {'major'|'minor'} */
  let mode = 'major';
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma12[i];
  if (!(total > 0)) return { pc: 0, mode: 'major', name: keyName(0, 'major'), camelot: camelotCode(0, 'major'), confidence: 0 };
  for (let t = 0; t < 12; t++) {
    for (const m of /** @type {const} */ (['major', 'minor'])) {
      const r = pearson(chroma12, prof[m], t);
      if (r > best) {
        second = best;
        best = r;
        pc = t;
        mode = m;
      } else if (r > second) {
        second = r;
      }
    }
  }
  // Confident when the profile fits well AND clearly better than the runner-up.
  const confidence = clamp(((best - second) / 0.12) * clamp((best - 0.3) / 0.4, 0, 1), 0, 1);
  return { pc, mode, name: keyName(pc, mode), camelot: camelotCode(pc, mode), confidence };
}

/**
 * Harmonic novelty per beat: how different the two beats starting at beat i sound (in chroma) from the
 * two beats before it. Peaks where chords / bass notes change — typically on bar lines.
 * @param {Float32Array} chroma   frames × 12
 * @param {number} frames
 * @param {number} fps            chroma frames per second
 * @param {ArrayLike<number>} beatTimes seconds
 * @returns {Float64Array} one value per beat, 0..1
 */
export function harmonicChange(chroma, frames, fps, beatTimes) {
  const k = beatTimes.length;
  const out = new Float64Array(k);
  if (k < 4 || frames < 2) return out;
  const bc = new Float64Array(k * 12);
  for (let i = 0; i < k; i++) {
    const t0 = beatTimes[i];
    const t1 = i + 1 < k ? beatTimes[i + 1] : t0 + (t0 - beatTimes[i - 1]);
    // frames centred in the middle of the beat: its edges still see the neighbouring chord (0.37 s window)
    let a = Math.round((t0 + 0.3 * (t1 - t0)) * fps);
    let b = Math.round((t0 + 0.8 * (t1 - t0)) * fps);
    if (b <= a) b = a + 1;
    a = clamp(a, 0, frames - 1);
    b = clamp(b, a + 1, frames);
    for (let f = a; f < b; f++) for (let p = 0; p < 12; p++) bc[i * 12 + p] += chroma[f * 12 + p];
    let sum = 0;
    for (let p = 0; p < 12; p++) sum += bc[i * 12 + p];
    if (sum > 0) for (let p = 0; p < 12; p++) bc[i * 12 + p] /= sum;
  }
  for (let i = 2; i < k - 1; i++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let p = 0; p < 12; p++) {
      const before = bc[(i - 2) * 12 + p] + bc[(i - 1) * 12 + p];
      const after = bc[i * 12 + p] + bc[(i + 1) * 12 + p];
      dot += before * after;
      na += before * before;
      nb += after * after;
    }
    out[i] = na > 0 && nb > 0 ? clamp(1 - dot / Math.sqrt(na * nb), 0, 1) : 0;
  }
  return out;
}

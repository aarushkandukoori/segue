// analyzeTrack: mono PCM in → Analysis out (SPEC §3). Pure: runs in Node, in a Worker and on the main thread.
// Never throws — every stage degrades to a neutral default (regular grid, bpmConfidence 0, C major with
// confidence 0 …) so the DJ can always schedule *something*.
import { sanitize, resample, gaussianSmooth, clamp } from './dsp.js';
import {
  FS,
  HOP,
  FPS,
  BPM_LO,
  BPM_HI,
  onsetEnvelopes,
  prepareEnvelope,
  kickEnvelope,
  estimateTempo,
  beatLocalScore,
  trackGrid,
  refinePhase,
  supportNear,
  pickDownbeat,
  meanAt,
  foldBpm,
} from './tempo.js';
import { chromagram, globalChroma, detectKey, harmonicChange, camelotCode, keyName } from './key.js';
import { blockEnergy, loudness, energyCurve, usableRegion, waveform, energyScore, findDrop, toDb } from './features.js';

/** Bump whenever the output for the same audio can change: cached analyses are keyed by it. */
export const ANALYSIS_VERSION = 1;

/** Internal analysis sample rate (re-exported for the client's downsampler). */
export const ANALYSIS_RATE = FS;

// Shorter clips get a regular grid at the hint / default tempo and bpmConfidence 0.
const MIN_TEMPO_SECONDS = 3;

// Half-beat correction: kick-likeness between the beats must be at least this strong, and this many times
// stronger than on the beats, before the grid is moved by half a beat.
const KICK_MIN = 0.3;
const KICK_FLIP_RATIO = 1.6;

// Double-time correction (see buildBeats): only for readings below this tempo, and only when the snare
// band is this many times stronger between the beats than on them.
const SLOW_READING_BPM = 90;
const BACKBEAT_RATIO = 2;

/**
 * @typedef {Object} Analysis   (SPEC.md §3)
 * @property {number} v              ANALYSIS_VERSION
 * @property {number} duration       seconds
 * @property {number} bpm            global tempo in [70, 180)
 * @property {number} bpmConfidence  0..1; ≥ 0.5 = the grid is trustworthy enough to beat-match
 * @property {number[]} beats        beat times (s), strictly increasing, covering the whole track
 * @property {number} downbeat       index (0..3) of the first bar start: i is a downbeat iff (i − downbeat) % 4 === 0
 * @property {{pc:number, mode:'major'|'minor', name:string, camelot:string, confidence:number}} key
 * @property {{rms:number, peak:number, trimDb:number}} loudness
 * @property {number} energy         0..1
 * @property {number[]} energyCurve  one value per second, 0..1 relative to the track's own maximum
 * @property {{start:number, end:number, in:number, drop:number|null}} cues
 * @property {{cols:number, perSec:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array}} wave
 */

/**
 * @param {Float32Array} mono        mono PCM, any sample rate
 * @param {number} sampleRate
 * @param {{bpmHint?:number, peak?:number, duration?:number}} [opts]
 *   bpmHint  — provider-supplied tempo (weak prior, used as the grid tempo when the audio has no beat)
 *   peak     — true sample peak of the original multi-channel audio, if the caller measured it
 *   duration — exact duration (s) of the original buffer when `mono` is a resampled copy of it
 * @returns {Analysis}
 */
export function analyzeTrack(mono, sampleRate, opts = {}) {
  let duration = 0;
  try {
    if (!(mono instanceof Float32Array)) mono = Float32Array.from(mono || []);
    if (!(sampleRate > 0) || !isFinite(sampleRate)) sampleRate = FS;
    duration = mono.length / sampleRate;
    // A caller that resampled the audio knows the exact original duration (ours is off by < 1 sample).
    const given = opts && opts.duration;
    if (given > 0 && Math.abs(given - duration) < 0.005) duration = given;
    return run(mono, sampleRate, duration, opts || {});
  } catch (err) {
    return neutral(duration, opts && opts.bpmHint);
  }
}

function regularBeats(bpm, duration, first = 0) {
  const step = 60 / bpm;
  const out = [];
  let t = first - Math.floor(first / step) * step;
  if (t < 0 || !isFinite(t)) t = 0;
  for (let i = 0; ; i++) {
    const b = t + i * step;
    if (b >= duration && i > 0) break;
    out.push(b);
    if (out.length > 200000) break;
  }
  return out;
}

function neutralKey() {
  return { pc: 0, mode: /** @type {'major'} */ ('major'), name: keyName(0, 'major'), camelot: camelotCode(0, 'major'), confidence: 0 };
}

/** Structurally valid Analysis for audio we could not analyse at all. */
function neutral(duration, bpmHint) {
  const d = duration > 0 && isFinite(duration) ? duration : 0;
  const bpm = bpmHint > 0 && isFinite(bpmHint) ? foldBpm(bpmHint) : 120;
  const cols = Math.max(1, Math.ceil(d * 100));
  return {
    v: ANALYSIS_VERSION,
    duration: d,
    bpm,
    bpmConfidence: 0,
    beats: regularBeats(bpm, d),
    downbeat: 0,
    key: neutralKey(),
    loudness: { rms: 0, peak: 0, trimDb: 0 },
    energy: 0,
    energyCurve: new Array(Math.max(1, Math.ceil(d))).fill(0),
    cues: { start: 0, end: d, in: 0, drop: null },
    wave: { cols, perSec: 100, low: new Uint8Array(cols), mid: new Uint8Array(cols), high: new Uint8Array(cols) },
  };
}

function run(mono, sampleRate, duration, opts) {
  const clean = sanitize(mono);
  const x = sampleRate === FS ? clean : resample(clean, sampleRate, FS);
  const hint = opts.bpmHint > 0 && isFinite(opts.bpmHint) ? opts.bpmHint : 0;

  // ---- level, display, cue region -------------------------------------------------------------
  const blocks = blockEnergy(x, FS);
  const hopSec = blocks.hop / FS;
  const loud = loudness(blocks.ms, x, opts.peak);
  const wave = waveform(x, FS, duration);
  const region = usableRegion(blocks.ms, hopSec, duration, loud.rms);
  const silent = !(loud.rms > 1e-5);

  // ---- tempo + beats ----------------------------------------------------------------------------
  let bpm = hint ? foldBpm(hint) : 120;
  let bpmConfidence = 0;
  /** @type {number[]} */
  let beats = regularBeats(bpm, duration);
  let downbeat = 0;
  let fluxMean = 0;
  let key = neutralKey();
  let chroma = null;

  if (!silent) {
    try {
      chroma = chromagram(x, FS);
      const from = Math.floor(region.start * chroma.fps);
      const to = Math.ceil(region.end * chroma.fps);
      key = detectKey(globalChroma(chroma.chroma, chroma.frames, from, to));
    } catch (err) {
      key = neutralKey();
    }
  }

  if (!silent && duration >= MIN_TEMPO_SECONDS) {
    try {
      const on = onsetEnvelopes(x);
      let fs = 0;
      for (let i = 0; i < on.n; i++) fs += on.flux[i];
      fluxMean = on.n ? fs / on.n : 0;
      const prepared = prepareEnvelope(on.flux);
      if (!prepared.flat) {
        const env = prepared.env;
        const tempo = estimateTempo(env, { bpmHint: hint });
        if (tempo.strength > 0) {
          const lowEnv = prepareEnvelope(on.low).env;
          const midEnv = prepareEnvelope(on.mid).env;
          const result = buildBeats(x, env, tempo, duration, region, kickEnvelope(on), midEnv);
          beats = result.beats;
          bpm = result.bpm;
          bpmConfidence = result.confidence;
          // ---- downbeat ----
          const snare = new Float64Array(on.n);
          for (let i = 0; i < on.n; i++) snare[i] = on.mid[i] + on.high[i];
          const snareEnv = prepareEnvelope(snare).env;
          const hc = chroma ? harmonicChange(chroma.chroma, chroma.frames, chroma.fps, beats) : null;
          let from = 0;
          while (from < beats.length && beats[from] < region.start) from++;
          let to = beats.length;
          while (to > from && beats[to - 1] > region.end) to--;
          const db = pickDownbeat(result.frames, lowEnv, snareEnv, hc, from, to);
          downbeat = db.phase < beats.length ? db.phase : 0;
        }
      }
    } catch (err) {
      bpm = hint ? foldBpm(hint) : 120;
      bpmConfidence = 0;
      beats = regularBeats(bpm, duration);
      downbeat = 0;
    }
  }

  // ---- energy -----------------------------------------------------------------------------------
  const be = wave.bandEnergy;
  const total = be.low + be.mid + be.high;
  const highShareDb = total > 0 ? 10 * Math.log10(be.high / total + 1e-9) : -90;
  const energy = silent ? 0 : energyScore(toDb(loud.rms), fluxMean, highShareDb);

  // ---- cues -------------------------------------------------------------------------------------
  let cueIn = region.start;
  let found = false;
  for (let i = downbeat; i < beats.length; i += 4) {
    if (beats[i] >= region.start - 1e-3) {
      cueIn = beats[i];
      found = true;
      break;
    }
  }
  if (!found) {
    for (let i = 0; i < beats.length; i++) {
      if (beats[i] >= region.start - 1e-3) {
        cueIn = beats[i];
        break;
      }
    }
  }
  if (cueIn >= region.end) cueIn = region.start;
  let drop = null;
  if (bpmConfidence > 0 && !silent) {
    // low-band loudness per 100 ms block from the waveform's column peaks (10 ms columns)
    const lowMs = new Float64Array(blocks.ms.length);
    for (let b = 0; b < lowMs.length; b++) {
      let s = 0;
      let k = 0;
      for (let c = b * 10; c < Math.min(wave.cols, b * 10 + 40); c++) {
        s += wave.lowPeaks[c] * wave.lowPeaks[c];
        k++;
      }
      lowMs[b] = k ? s / k : 0;
    }
    drop = findDrop(blocks.ms, lowMs, hopSec, beats, downbeat, region.start, region.end);
  }

  return {
    v: ANALYSIS_VERSION,
    duration,
    bpm: Math.round(bpm * 1000) / 1000,
    bpmConfidence: Math.round(clamp(bpmConfidence, 0, 1) * 1000) / 1000,
    beats,
    downbeat,
    key,
    loudness: loud,
    energy,
    energyCurve: energyCurve(x, FS, duration),
    cues: { start: region.start, end: region.end, in: cueIn, drop },
    wave: { cols: wave.cols, perSec: wave.perSec, low: wave.low, mid: wave.mid, high: wave.high },
  };
}

/**
 * Period estimate → final beat times (seconds), tempo and confidence.
 * @returns {{beats:number[], frames:Float64Array, bpm:number, confidence:number, steady:boolean}}
 *   frames = the same beats in envelope frames (before latency / attack alignment), for the downbeat picker
 */
function buildBeats(x, env, tempo, duration, region, kick = null, midEnv = null) {
  const n = env.length;
  const smooth = gaussianSmooth(env, 1.5);
  const local = beatLocalScore(env, tempo.period);
  const fa = Math.max(0, Math.floor(region.start * FPS));
  const fb = Math.min(n - 1, Math.ceil(region.end * FPS));

  // Quantised productions come back as one exact grid; live drummers as locally fitted beats.
  let grid = trackGrid(smooth, tempo.period, fa, fb);
  // On the kicks, or on the off-beat hats? An open hi-hat on the "and" often makes more spectral flux
  // than the kick. If the kick drums clearly sit half-way between the beats found, redo the fit there.
  if (kick && grid.beats.length >= 8) {
    const reach = Math.max(2, Math.round(0.06 * grid.period));
    const between = new Float64Array(grid.beats.length - 1);
    for (let i = 0; i < between.length; i++) between[i] = 0.5 * (grid.beats[i] + grid.beats[i + 1]);
    const kOn = supportNear(kick, grid.beats, fa, fb, reach);
    const kOff = supportNear(kick, between, fa, fb, reach);
    if (kOff >= KICK_MIN && kOff >= KICK_FLIP_RATIO * kOn) {
      const shifted = trackGrid(smooth, tempo.period, fa, fb, true);
      if (supportNear(kick, shifted.beats, fa, fb, reach) > kOn) grid = shifted;
    }
  }
  const steady = grid.steady;
  /** @type {Float64Array} */
  let frames = grid.beats;
  let period = grid.period;
  let offset = grid.offset;

  // Backbeat check for slow readings: kicks ON the beats and snares / claps BETWEEN them means those
  // "beats" are really the 1 and the 3 — the tactus is twice as fast (rock, pop and funk around 140–180).
  if (kick && midEnv && frames.length >= 8 && (60 * FPS) / period < SLOW_READING_BPM && (120 * FPS) / period < BPM_HI) {
    const reach = Math.max(2, Math.round(0.06 * period));
    const between = new Float64Array(frames.length - 1);
    for (let i = 0; i < between.length; i++) between[i] = 0.5 * (frames[i] + frames[i + 1]);
    const snareOn = supportNear(midEnv, frames, fa, fb, reach);
    const snareOff = supportNear(midEnv, between, fa, fb, reach);
    const kickOn = supportNear(kick, frames, fa, fb, reach);
    const kickOff = supportNear(kick, between, fa, fb, reach);
    if (snareOff >= BACKBEAT_RATIO * snareOn && kickOn >= kickOff) {
      const dbl = new Float64Array(frames.length * 2 - 1);
      for (let i = 0; i < frames.length; i++) {
        dbl[2 * i] = frames[i];
        if (i < between.length) dbl[2 * i + 1] = between[i];
      }
      frames = dbl;
      period /= 2;
    }
  }

  // Beats as the music plays them — before any folding — are what the confidence is judged on.
  const played = frames;
  const playedPeriod = period;

  // Fold the tempo into the product range (the fit can nudge a boundary case across it).
  let bpm = (60 * FPS) / period;
  if (bpm >= BPM_HI) {
    // keep every other beat — the stronger half
    const even = [];
    const odd = [];
    for (let i = 0; i < frames.length; i++) (i % 2 ? odd : even).push(frames[i]);
    const useEven = meanAt(local, even) >= meanAt(local, odd);
    frames = Float64Array.from(useEven ? even : odd);
    if (!useEven) offset += period;
    period *= 2;
    bpm /= 2;
  } else if (bpm < BPM_LO) {
    const dbl = new Float64Array(Math.max(0, frames.length * 2 - 1));
    for (let i = 0; i < frames.length; i++) {
      dbl[2 * i] = frames[i];
      if (i + 1 < frames.length) dbl[2 * i + 1] = 0.5 * (frames[i] + frames[i + 1]);
    }
    frames = dbl;
    period /= 2;
    bpm *= 2;
  }

  // Frames → samples, then slide the whole grid onto the attacks. (The flux envelope itself turned out to
  // be nearly unbiased — median correction on real music ≈ +2 ms — but individual tracks need up to ±15 ms.)
  const strong = [];
  for (let i = 0; i < frames.length; i++) if (frames[i] >= fa && frames[i] <= fb) strong.push(frames[i] * HOP);
  const fine = refinePhase(x, strong);
  const shift = fine.shift;

  /** @type {number[]} */
  let beats = [];
  if (steady) {
    // Exact arithmetic grid across the whole file (also through silent intros / outros).
    const step = (period * HOP) / FS;
    let first = (offset * HOP + shift) / FS;
    first -= Math.floor(first / step) * step;
    for (let i = 0; ; i++) {
      const t = first + i * step;
      if (t >= duration) break;
      beats.push(t);
    }
    // keep `frames` index-aligned with `beats` for the downbeat picker
    const f0 = (first * FS - shift) / HOP;
    frames = new Float64Array(beats.length);
    for (let i = 0; i < beats.length; i++) frames[i] = f0 + i * period;
  } else {
    const kept = [];
    let last = -Infinity;
    for (let i = 0; i < frames.length; i++) {
      const t = (frames[i] * HOP + shift) / FS;
      if (t < 0 || t >= duration) continue;
      if (t > last + 0.05) {
        beats.push(t);
        kept.push(frames[i]);
        last = t;
      }
    }
    frames = Float64Array.from(kept);
  }
  if (beats.length === 0) {
    beats = regularBeats(bpm, duration);
    frames = Float64Array.from(beats, (t) => t * FPS);
  }

  // ---- confidence ----
  // strength: how periodic the onset envelope is at the chosen tempo (autocorrelation comb, 0..1).
  //           Real drums land at 0.3 – 0.8, rubato piano / pads / strings below 0.2.
  // margin  : lead over the best tempo from a different class (3:2, 4:3 …) — a near-tie is a warning.
  const cStrength = clamp((tempo.strength - 0.1) / 0.3, 0, 1);
  const cMargin = clamp((tempo.margin - 1) / 0.2, 0, 1);
  // coverage: share of the beats that actually have an onset on them (a grid that only fits a third of
  //           the clip is not something to beat-match on, however periodic that third is).
  const reach = Math.max(2, Math.round(0.045 * playedPeriod));
  const near = [];
  for (let i = 0; i < played.length; i++) {
    if (played[i] < fa || played[i] > fb) continue;
    near.push(supportNear(smooth, [played[i]], 0, n - 1, reach));
  }
  let coverage = 0;
  if (near.length) {
    const sorted = Float64Array.from(near).sort();
    const ref = sorted[Math.floor(0.75 * (sorted.length - 1))]; // a typical "clearly there" beat
    let present = 0;
    for (let i = 0; i < near.length; i++) if (near[i] >= 0.3 * ref && near[i] > 0.25) present++;
    coverage = present / near.length;
  }
  const cCoverage = clamp((coverage - 0.3) / 0.4, 0, 1);
  let confidence = cStrength * (0.85 + 0.15 * cMargin) * cCoverage;
  if (!steady) confidence *= 0.9; // locally right, but there is no single tempo to lock to
  // few beats = little evidence
  const span = Math.min(duration, region.end - region.start);
  confidence *= clamp((span - 2) / 8, 0.2, 1);

  return { beats, frames, bpm, confidence, steady };
}

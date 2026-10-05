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
import { attackEnvelope, lowBand, alignGrid, halfBeatEvidence, isHalfBeatOff, edgeTrust, marginToTrust, onOff, slotPattern, SLOTS_PER_BEAT } from './grid.js';

/** Bump whenever the output for the same audio can change: cached analyses are keyed by it. */
export const ANALYSIS_VERSION = 2;

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

// Analysis.grid.phase from which the attacks themselves vouch for the grid (see run(): bpmConfidence).
const PHASE_PROOF = 0.5;

/** Beats judged at each edge of the usable region for Analysis.grid.head / .tail. */
export const GRID_EDGE_BEATS = 16;

/**
 * @typedef {Object} Analysis   (SPEC.md §3)
 * @property {number} v              ANALYSIS_VERSION
 * @property {number} duration       seconds
 * @property {number} bpm            global tempo in [70, 180)
 * @property {number} bpmConfidence  0..1; ≥ 0.5 = the grid is trustworthy enough to beat-match (never below
 *                                   grid.phase once that reaches 0.5: attacks that sit on the beats prove a grid)
 * @property {number[]} beats        beat times (s), strictly increasing, covering the whole track
 * @property {number} downbeat       index (0..3) of the first bar start: i is a downbeat iff (i − downbeat) % 4 === 0
 * @property {{pc:number, mode:'major'|'minor', name:string, camelot:string, confidence:number}} key
 * @property {{rms:number, peak:number, trimDb:number}} loudness
 * @property {number} energy         0..1
 * @property {number[]} energyCurve  one value per second, 0..1 relative to the track's own maximum
 * @property {{start:number, end:number, in:number, drop:number|null}} cues
 * @property {{cols:number, perSec:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array}} wave
 * @property {{phase:number, head:number, tail:number, perBeat:number, slots:Uint8Array}} grid
 *           How far the beat PHASE can be trusted (bpmConfidence is about the tempo; a track can have a
 *           rock-solid tempo and still carry its loud hits between the beats).
 *           phase = 0..1, over the whole usable region: do the loud attacks sit on the beats, clearly and
 *                   all the way through?   0 = as much between the beats as on them · 1 = on the beats only
 *           head / tail = 0..1, the same question for the first / last 16 beats of the usable region —
 *                   where a preview is blended into and out of (the 8 beats nearest the edge count double).
 *                   ≥ 0.5 = "this end can be overlapped beat on beat with another clear one" (calibrated on
 *                   real previews: node tests/helpers/mix-eval.js --calibrate).
 *           slots = the attacks themselves, beat-synchronous: perBeat (16) values per beat, 0..255 — the
 *                   mean attack strength in each sixteenth of every beat, slot 0 centred on the beat
 *                   (grid.js slotPattern). The planner lays two tracks' slots over each other before it
 *                   overlaps them.
 *           All zero when there is no tempo to speak of.
 */

/**
 * @param {Float32Array} mono        mono PCM, any sample rate
 * @param {number} sampleRate
 * @param {{bpmHint?:number, peak?:number, duration?:number, debug?:object}} [opts]
 *   bpmHint  — provider-supplied tempo (weak prior, used as the grid tempo when the audio has no beat)
 *   peak     — true sample peak of the original multi-channel audio, if the caller measured it
 *   duration — exact duration (s) of the original buffer when `mono` is a resampled copy of it
 *   debug    — (tools, tests) an object that receives the grid stage's working notes: debug.polish, debug.grid
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
  const beats = regularBeats(bpm, d);
  return {
    v: ANALYSIS_VERSION,
    duration: d,
    bpm,
    bpmConfidence: 0,
    beats,
    downbeat: 0,
    key: neutralKey(),
    loudness: { rms: 0, peak: 0, trimDb: 0 },
    energy: 0,
    energyCurve: new Array(Math.max(1, Math.ceil(d))).fill(0),
    cues: { start: 0, end: d, in: 0, drop: null },
    wave: { cols, perSec: 100, low: new Uint8Array(cols), mid: new Uint8Array(cols), high: new Uint8Array(cols) },
    grid: noGrid(beats.length),
  };
}

/** Analysis.grid of a track whose beat phase nothing can be said about. */
function noGrid(beatCount) {
  return { phase: 0, head: 0, tail: 0, perBeat: SLOTS_PER_BEAT, slots: new Uint8Array(beatCount * SLOTS_PER_BEAT) };
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
  /** @type {Float32Array|null} attack envelope, kept for the grid trust once the cues are known */
  let att = null;

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
          att = attackEnvelope(x, FS);
          const result = buildBeats(x, env, tempo, duration, region, kickEnvelope(on), midEnv, att, opts.debug);
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
      att = null;
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

  // ---- grid trust ------------------------------------------------------------------------------
  let grid = noGrid(beats.length);
  if (att && bpmConfidence > 0) {
    try {
      grid = gridTrust(att, beats, region, cueIn, opts.debug);
    } catch (err) {
      grid = noGrid(beats.length);
    }
  }
  // A second witness for the tempo. buildBeats judges the grid by how periodic the onset envelope is
  // and how many beats carry an onset, which marks sparse productions down (half-time pop, ballads with
  // a kick every other beat: a quarter of a current chart playlist came out below 0.5 that way). But
  // when the loud attacks sit clearly ON the beats in (nearly) every part of the clip, the grid is
  // demonstrably right, however thin the evidence looked from the other side. Audio without a beat
  // never gets here: where the first witness found none, the phase trust is next to nothing as well
  // (≤ 0.1 on every beatless fixture below 0.5; noise, pads and solo piano: 0).
  if (grid.phase >= PHASE_PROOF && bpmConfidence < grid.phase) bpmConfidence = grid.phase;

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
    grid,
  };
}

const round3 = (v) => Math.round(clamp(v, 0, 1) * 1000) / 1000;

/**
 * Analysis.grid: the beat grid against the audible attacks (see grid.js).
 * @param {Float32Array} att  attack envelope
 * @param {number[]} beats
 * @param {{start:number, end:number}} region  usable region (s)
 * @param {number} cueIn  where the track is entered (first downbeat of the region)
 */
function gridTrust(att, beats, region, cueIn, debug) {
  let i0 = 0;
  while (i0 < beats.length && beats[i0] < region.start - 1e-3) i0++;
  let i1 = beats.length;
  while (i1 > i0 && beats[i1 - 1] > region.end + 1e-3) i1--;
  const whole = edgeTrust(att, beats, i0, i1);
  // consistency: the same question asked of every 8 beats on their own (hop 4)
  let segs = 0;
  let onGrid = 0;
  for (let i = i0; i + 8 <= i1; i += 4) {
    const m = edgeTrust(att, beats, i, i + 8);
    if (!(m.on > 0)) continue;
    segs++;
    if (m.margin > 0.5) onGrid++;
  }
  const steadiness = segs ? onGrid / segs : 0;
  let j = i0;
  while (j < i1 && beats[j] < cueIn - 1e-3) j++;
  // An edge is judged over its 16 beats and over the 8 nearest the edge (a short blend lives in those),
  // the two margins averaged.
  const edge = (a8, b8, a16, b16) => {
    const m16 = edgeTrust(att, beats, a16, b16);
    const m8 = edgeTrust(att, beats, a8, b8);
    const margin = m16.count >= 6 && m8.count >= 6 ? 0.5 * (m8.margin + m16.margin) : 0;
    return { margin, trust: marginToTrust(margin), m8, m16 };
  };
  const head = edge(j, Math.min(i1, j + GRID_EDGE_BEATS / 2), j, Math.min(i1, j + GRID_EDGE_BEATS));
  const tail = edge(Math.max(i0, i1 - GRID_EDGE_BEATS / 2), i1, Math.max(i0, i1 - GRID_EDGE_BEATS), i1);
  // phase: clear over the whole region AND in (nearly) every part of it
  const phase = whole.trust * clamp((steadiness - 0.5) / 0.4, 0, 1);
  if (debug) debug.grid = { whole, head, tail, steadiness, segs };
  return { phase: round3(phase), head: round3(head.trust), tail: round3(tail.trust), perBeat: SLOTS_PER_BEAT, slots: slotPattern(att, beats) };
}

/** Half a beat later: a constant grid moves by half its period, any other grid to its own mid-points. */
function halfBeatLater(beats, steady, duration) {
  const n = beats.length;
  if (n < 2) return beats;
  const out = [];
  if (steady) {
    const p = (beats[n - 1] - beats[0]) / (n - 1);
    let t = beats[0] + p / 2;
    t -= Math.floor(t / p) * p;
    for (let i = 0; t + i * p < duration; i++) out.push(t + i * p);
    return out;
  }
  const first = beats[0] - 0.5 * (beats[1] - beats[0]);
  if (first >= 0) out.push(first);
  for (let i = 0; i + 1 < n; i++) out.push(0.5 * (beats[i] + beats[i + 1]));
  const last = beats[n - 1] + 0.5 * (beats[n - 1] - beats[n - 2]);
  if (last < duration) out.push(last);
  return out;
}

/** A shifted list of beats, back inside [0, duration) and still reaching both ends of the track. */
function coverTrack(beats, duration) {
  const out = beats.filter((t) => t >= 0 && t < duration);
  if (out.length < 2) return out;
  const head = out[1] - out[0];
  while (out[0] - head >= 0 && out.length < 200000) out.unshift(out[0] - head);
  const tail = out[out.length - 1] - out[out.length - 2];
  while (out[out.length - 1] + tail < duration && out.length < 200000) out.push(out[out.length - 1] + tail);
  return out;
}

/**
 * Period estimate → final beat times (seconds), tempo and confidence.
 * @returns {{beats:number[], frames:Float64Array, bpm:number, confidence:number, steady:boolean}}
 *   frames = the same beats in envelope frames (before latency / attack alignment), for the downbeat picker
 */
function buildBeats(x, env, tempo, duration, region, kick = null, midEnv = null, att = null, debug = null) {
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

  // ---- the grid against the audible attacks (grid.js) ----
  if (att && beats.length >= 8) {
    const polished = polishGrid(x, att, beats, steady, duration, region, debug);
    if (polished) {
      beats = polished.beats;
      // envelope frame of each beat: its time minus the two fine shifts (not minus a half-beat move)
      const latency = shift / FS + polished.shift;
      frames = Float64Array.from(beats, (t) => (t - latency) * FPS);
    }
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
  if (debug) debug.confidence = { strength: tempo.strength, margin: tempo.margin, coverage, steady, span, value: confidence };

  return { beats, frames, bpm, confidence, steady };
}

/**
 * Last word on the beat phase, from the audible attacks:
 *   1. Half a beat off? Only if the loudest attacks sit half-way between the beats AND the kick band and
 *      the band above it both say so, in most 8-beat segments of the clip (grid.js isHalfBeatOff).
 *   2. Fine alignment: slide the grid onto the attacks (alignGrid).
 * @returns {null | {beats:number[], shift:number, flipped:boolean}}
 */
function polishGrid(x, att, beats, steady, duration, region, debug) {
  let flipped = false;
  let evidence = null;
  const before = onOffRegion(att, beats, region);
  const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const nearHalf = Math.abs(Math.abs(before.offAtMs) / 1000 - period / 2) < 0.12 * period;
  if (before.count >= 16 && nearHalf && before.off > before.on) {
    const low = lowBand(x, FS);
    const rest = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) rest[i] = x[i] - low[i];
    evidence = halfBeatEvidence(attackEnvelope(low, FS), attackEnvelope(rest, FS), beats, region.start, region.end);
    if (isHalfBeatOff(evidence)) {
      const moved = halfBeatLater(beats, steady, duration);
      if (moved.length >= 8) {
        beats = moved;
        flipped = true;
      }
    }
  }
  const al = alignGrid(att, beats, region.start, region.end);
  const out = coverTrack(al.beats, duration);
  if (debug) debug.polish = { flipped, evidence, shift: al.shift, sharp: al.sharp, before, steady };
  if (out.length < 2) return flipped ? { beats, shift: 0, flipped } : null;
  return { beats: out, shift: al.shift, flipped };
}

function onOffRegion(att, beats, region) {
  let i0 = 0;
  while (i0 < beats.length && beats[i0] < region.start - 1e-3) i0++;
  let i1 = beats.length;
  while (i1 > i0 && beats[i1 - 1] > region.end + 1e-3) i1--;
  return onOff(att, beats, i0, i1);
}

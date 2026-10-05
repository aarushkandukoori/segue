// Beat grid vs. the audible attacks: fine alignment, half-beat evidence and the grid trust signal.
//
// tempo.js finds the grid on a spectral-flux envelope: level-independent (a hi-hat counts as much as a
// kick) and 46 ms wide. What a listener hears in a beat-matched blend is something else: where the LOUD
// attacks of the two tracks fall against each other. Everything here therefore works on an attack
// envelope that is linear in amplitude and 1 ms fine, and asks one question in several places:
// "folded onto this grid, where inside the beat does the attack energy sit?"
//
//   attackEnvelope   rise of the 10 ms RMS over 10 ms, per millisecond
//   beatProfile      attack energy by offset from the beat, summed over a stretch of beats
//   alignGrid        slide the grid onto the attacks
//   halfBeatEvidence kick band and everything-else band: on the beats, or between them? how consistently?
//   edgeTrust        0..1: how clearly the loud attacks of a stretch sit ON its beats (Analysis.grid.head …)
//   slotPattern      the envelope per sixteenth of every beat (Analysis.grid.slots), for the planner to
//                    lay two tracks over each other before it overlaps them
import { clamp } from './dsp.js';

/** Attack-envelope rate (Hz): one value per millisecond. */
export const ATT_RATE = 1000;
const RMS_MS = 10;
const RISE_MS = 10;
/**
 * An attack that starts at t makes the envelope peak a little later, once the RMS window has filled with
 * it: 10 ms for a sustained sound, ≈ 8 ms for a kick drum, ≈ 5 ms for a 2 ms click. Beats mark where
 * attacks START, so on a well-placed grid the profile peaks about ATTACK_DELAY_MS after the beat.
 */
export const ATTACK_DELAY_MS = 7;

/**
 * Attack envelope, linear in amplitude (a kick counts for more than a hi-hat): the increase of the
 * 10 ms RMS over 10 ms, half-wave rectified. Value k describes the audio just before k ms.
 * @param {Float32Array} x  mono PCM
 * @param {number} fs
 * @returns {Float32Array}
 */
export function attackEnvelope(x, fs) {
  const n = Math.floor((x.length / fs) * ATT_RATE);
  const win = Math.max(1, Math.round((RMS_MS / 1000) * fs));
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  const amp = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = Math.min(x.length, Math.round((k / ATT_RATE) * fs));
    const a = c > win ? c - win : 0;
    amp[k] = Math.sqrt((cum[c] - cum[a]) / win);
  }
  const out = new Float32Array(n);
  for (let k = RISE_MS; k < n; k++) {
    const d = amp[k] - amp[k - RISE_MS];
    if (d > 0) out[k] = d;
  }
  return out;
}

/** What is left below ≈ 150 Hz (two cascaded 2-pole low-passes): kick drum and bass. */
export function lowBand(x, fs, hz = 150) {
  const w = (2 * Math.PI * hz) / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const b0 = (1 - c) / 2 / (1 + alpha);
  const b1 = (1 - c) / (1 + alpha);
  const a1 = (-2 * c) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return y;
}

/**
 * Attack energy by offset from the beat: profile[r + d] = Σ over beats i0 ≤ i < i1 of env(beat_i + d ms),
 * for d = −r … +r, lightly smoothed (±2 ms triangle). `r` = half the shortest beat interval of the stretch,
 * so offsets never reach into the neighbouring beat's half.
 * @param {Float32Array} env   attack envelope (ATT_RATE)
 * @param {ArrayLike<number>} beats  beat times (s)
 * @param {number} i0
 * @param {number} i1  one past the last beat used
 * @returns {{profile:Float64Array, r:number, count:number}}
 */
export function beatProfile(env, beats, i0, i1) {
  i0 = Math.max(0, i0);
  i1 = Math.min(beats.length, i1);
  let minIv = Infinity;
  for (let i = Math.max(1, i0); i < Math.min(beats.length, i1 + 1); i++) {
    const d = beats[i] - beats[i - 1];
    if (d < minIv) minIv = d;
  }
  if (!isFinite(minIv)) minIv = 0.5;
  const r = Math.max(4, Math.floor((minIv * ATT_RATE) / 2));
  const raw = new Float64Array(2 * r + 1);
  let count = 0;
  for (let i = i0; i < i1; i++) {
    const c = Math.round(beats[i] * ATT_RATE);
    if (c - r < 0 || c + r >= env.length) continue;
    for (let d = -r; d <= r; d++) raw[d + r] += env[c + d];
    count++;
  }
  const profile = new Float64Array(2 * r + 1);
  for (let k = 0; k <= 2 * r; k++) {
    let s = 3 * raw[k];
    let w = 3;
    for (let j = 1; j <= 2; j++) {
      if (k - j >= 0) {
        s += (3 - j) * raw[k - j];
        w += 3 - j;
      }
      if (k + j <= 2 * r) {
        s += (3 - j) * raw[k + j];
        w += 3 - j;
      }
    }
    profile[k] = s / w;
  }
  return { profile, r, count };
}

const maxIn = (p, lo, hi) => {
  let v = 0;
  let at = lo;
  for (let k = Math.max(0, lo); k <= Math.min(p.length - 1, hi); k++) {
    if (p[k] > v) {
      v = p[k];
      at = k;
    }
  }
  return { v, at };
};

const ON_REACH_MS = 10; // attacks this close to where the grid expects them are "on the beat"
const OFF_GUARD_MS = 24; // attacks further than this from it are "somewhere else"

/**
 * Where a stretch of beats has its attacks: `on` = strongest profile value where the grid expects the
 * attacks (ATTACK_DELAY_MS after the beat, ± 10 ms), `off` = the strongest value anywhere else in the
 * beat (more than 24 ms away), with its offset.
 * @returns {{on:number, off:number, offAtMs:number, peakMs:number, count:number}}  peakMs: offset of the
 *   strongest attack within ± 40 ms of the beat, relative to where the grid expects it
 */
export function onOff(env, beats, i0, i1) {
  const { profile, r, count } = beatProfile(env, beats, i0, i1);
  const c = r + ATTACK_DELAY_MS;
  const on = maxIn(profile, c - ON_REACH_MS, c + ON_REACH_MS).v;
  const left = maxIn(profile, 0, c - OFF_GUARD_MS - 1);
  const right = maxIn(profile, c + OFF_GUARD_MS + 1, 2 * r);
  const off = left.v > right.v ? left : right;
  const near = maxIn(profile, c - 40, c + 40);
  return { on, off: off.v, offAtMs: off.at - c, peakMs: near.at - c, count };
}

/**
 * Grid trust of a stretch of beats, 0..1: how clearly its loud attacks sit ON the beats.
 *   margin = on / (on + off)   — 0.5 when the strongest off-beat attacks are as strong as the on-beat ones
 * mapped by marginToTrust. A stretch of fewer than six beats, or without any attack, gets 0.
 * @param {Float32Array} env
 * @param {ArrayLike<number>} beats
 * @param {number} i0
 * @param {number} i1
 * @returns {{trust:number, margin:number, on:number, off:number, offAtMs:number, peakMs:number, count:number}}
 */
export function edgeTrust(env, beats, i0, i1) {
  const m = onOff(env, beats, i0, i1);
  if (m.count < 6 || !(m.on > 0)) return { trust: 0, margin: 0, ...m };
  const margin = m.on / (m.on + m.off);
  return { trust: marginToTrust(margin), margin, ...m };
}

/** Margin from which a stretch counts as clear (→ trust 0.5). */
export const MARGIN_GATE = 0.58;
const MARGIN_FULL = 0.8;
/**
 * Margin → trust, piecewise linear:  ≤ 0.5 (the beat carries no more than the off-beat does) → 0 ·
 * MARGIN_GATE → 0.5 · ≥ 0.8 (nothing but the beat) → 1.
 * Calibrated on real previews (node tests/helpers/mix-eval.js --calibrate): blend the tail of one track
 * into the head of another, and when the lower of the two values is 0.5 – 0.75 the drums meet within
 * 20 ms nine times in ten (0.75 and up: 99 %; below 0.25: four in ten).
 */
export function marginToTrust(margin) {
  if (!(margin > 0.5)) return 0;
  if (margin < MARGIN_GATE) return (0.5 * (margin - 0.5)) / (MARGIN_GATE - 0.5);
  return clamp(0.5 + (0.5 * (margin - MARGIN_GATE)) / (MARGIN_FULL - MARGIN_GATE), 0, 1);
}

const ALIGN_REACH_MS = 50; // how far the grid may be slid
const ALIGN_MIN_SHARP = 1.5; // profile peak ÷ mean below which there is no consistent attack to slide onto

/**
 * Slide a grid onto the attacks.
 *
 * The flux envelope places beats to within its 46 ms window, and refinePhase (tempo.js) puts them on the
 * steepest rise of the log energy — which can be a quiet pre-attack tens of ms ahead of the hit one
 * actually hears. Here the whole grid is moved so that the attack profile of the usable region peaks
 * where a beat expects its attack. Every track then carries its loud attacks at the same place inside
 * the beat, which is what makes two grids laid on each other put drums on drums.
 *
 * @param {Float32Array} env   attack envelope
 * @param {number[]} beats     beat times (s), whole track
 * @param {number} from        usable region (s)
 * @param {number} to
 * @returns {{beats:number[], shift:number, sharp:number}} shift (s) added to every beat (0 = left
 *   alone); sharp = profile peak ÷ profile mean (≈ 1: no consistent attack)
 */
export function alignGrid(env, beats, from, to) {
  const none = { beats, shift: 0, sharp: 0 };
  let i0 = 0;
  while (i0 < beats.length && beats[i0] < from) i0++;
  let i1 = beats.length;
  while (i1 > i0 && beats[i1 - 1] > to) i1--;
  if (i1 - i0 < 8) return none;
  const { profile, r } = beatProfile(env, beats, i0, i1);
  const c = r + ATTACK_DELAY_MS;
  const pk = maxIn(profile, c - ALIGN_REACH_MS, c + ALIGN_REACH_MS);
  let mean = 0;
  for (let k = 0; k < profile.length; k++) mean += profile[k];
  mean /= profile.length;
  const sharp = mean > 0 ? pk.v / mean : 0;
  // No consistent attack (pads, strings), or the "peak" is just the edge of the search range: hands off.
  const atEdge = pk.at <= Math.max(0, c - ALIGN_REACH_MS) + 1 || pk.at >= Math.min(profile.length - 1, c + ALIGN_REACH_MS) - 1;
  if (!(sharp > ALIGN_MIN_SHARP) || atEdge) return { ...none, sharp };
  // sub-millisecond position by a parabola through the peak
  let pos = pk.at;
  const a = profile[pk.at - 1];
  const d = profile[pk.at + 1];
  const den = a - 2 * pk.v + d;
  if (den < 0) pos += clamp((0.5 * (a - d)) / den, -0.5, 0.5);
  const shift = (pos - c) / ATT_RATE;
  return { beats: beats.map((t) => t + shift), shift, sharp };
}

/**
 * Kick band and everything-else band, on the beats and half-way between them, over 8-beat segments.
 * @param {Float32Array} kickEnv  attack envelope of the low band
 * @param {Float32Array} restEnv  attack envelope of the rest
 * @param {ArrayLike<number>} beats
 * @param {number} from  usable region (s)
 * @param {number} to
 * @returns {{kickOn:number, kickOff:number, restOn:number, restOff:number, segments:number, agree:number}}
 *   agree = share of segments in which BOTH bands are stronger between the beats than on them
 */
export function halfBeatEvidence(kickEnv, restEnv, beats, from, to) {
  const reach = 14;
  const peak = (env, t) => {
    const c = Math.round(t * ATT_RATE) + ATTACK_DELAY_MS;
    let v = 0;
    for (let k = Math.max(0, c - reach); k <= Math.min(env.length - 1, c + reach); k++) if (env[k] > v) v = env[k];
    return v;
  };
  const out = { kickOn: 0, kickOff: 0, restOn: 0, restOff: 0, segments: 0, agree: 0 };
  let seg = [0, 0, 0, 0];
  let k = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    if (beats[i] < from || beats[i + 1] > to) continue;
    const mid = 0.5 * (beats[i] + beats[i + 1]);
    seg[0] += peak(kickEnv, beats[i]);
    seg[1] += peak(kickEnv, mid);
    seg[2] += peak(restEnv, beats[i]);
    seg[3] += peak(restEnv, mid);
    if (++k === 8) {
      out.kickOn += seg[0];
      out.kickOff += seg[1];
      out.restOn += seg[2];
      out.restOff += seg[3];
      out.segments++;
      if (seg[1] > seg[0] && seg[3] > seg[2]) out.agree++;
      seg = [0, 0, 0, 0];
      k = 0;
    }
  }
  if (out.segments) out.agree /= out.segments;
  return out;
}

// The grid moves by half a beat only when the kick band AND everything above it are both this many
// times stronger between the beats than on them, in at least this share of the clip's 8-beat segments.
// Syncopated music fails at least one of the three; a grid that sits on the off-beat passes all of them.
const FLIP_BAND_RATIO = 1.3;
const FLIP_AGREE = 0.75;
const FLIP_MIN_SEGMENTS = 3;

/** Does this evidence (halfBeatEvidence) say the grid sits half a beat off? */
export function isHalfBeatOff(ev) {
  return (
    !!ev &&
    ev.segments >= FLIP_MIN_SEGMENTS &&
    ev.agree >= FLIP_AGREE &&
    ev.kickOff >= FLIP_BAND_RATIO * ev.kickOn &&
    ev.restOff >= FLIP_BAND_RATIO * ev.restOn
  );
}

/** Slots per beat of Analysis.grid.slots. */
export const SLOTS_PER_BEAT = 16;

/**
 * The attack envelope, beat-synchronous: for every beat, the mean attack strength in each sixteenth of
 * it (slot s of beat i = the stretch from (s − ½)/16 to (s + ½)/16 of the way to the next beat, so
 * slot 0 is centred on the beat itself), 0..255 relative to the strongest slot of the track.
 *
 * Small enough to live in the Analysis, and enough for the planner to ask of two tracks before it
 * overlaps them: laid beat on beat over these bars, do your attacks coincide — or would they coincide
 * better half a beat (or a sixteenth) apart?
 * @param {Float32Array} env  attack envelope
 * @param {ArrayLike<number>} beats  beat times (s)
 * @returns {Uint8Array} length beats.length × SLOTS_PER_BEAT
 */
export function slotPattern(env, beats) {
  const n = beats.length;
  const P = SLOTS_PER_BEAT;
  const raw = new Float32Array(n * P);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const len = i + 1 < n ? beats[i + 1] - beats[i] : i > 0 ? beats[i] - beats[i - 1] : 0.5;
    const base = beats[i] * ATT_RATE + ATTACK_DELAY_MS;
    const step = (len * ATT_RATE) / P;
    for (let s = 0; s < P; s++) {
      const a = Math.max(0, Math.round(base + (s - 0.5) * step));
      const b = Math.min(env.length, Math.round(base + (s + 0.5) * step));
      let sum = 0;
      for (let k = a; k < b; k++) sum += env[k];
      const v = b > a ? sum / (b - a) : 0;
      raw[i * P + s] = v;
      if (v > top) top = v;
    }
  }
  const out = new Uint8Array(n * P);
  if (top > 0) for (let k = 0; k < out.length; k++) out[k] = Math.round((255 * raw[k]) / top);
  return out;
}

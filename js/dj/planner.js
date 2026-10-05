// The DJ's brain: decides the running order, where each track is left and entered, which transition
// carries the mix across and what happens in between. Emits Play / Transition plans (SPEC §3) that
// the engine executes verbatim. Pure and deterministic: (seed, vibe, mode, inputs) → plan; no state
// survives between calls, every random choice comes from an RNG derived from the seed + play id.

import { createRng } from '../util/rng.js';
import { camelot, keyCompat, rateToSemitones } from './camelot.js';
import { evalParam, positionAt, rateAt, sortEvents, timeAtPosition } from './timeline.js';
import {
  CUT_S,
  FX_BUS_GUARD,
  FX_DEFAULTS,
  INIT_LEAD_S,
  PREROLL_S,
  RECIPES,
  STRIP_DEFAULTS,
  TRICKS,
  TYPES,
  buildFadeIn,
  createLane,
  labelFor,
  preferredLengths,
} from './transitions.js';

export const MODES = Object.freeze(['preview', 'short', 'medium', 'full']);

const TRUST = 0.5; // bpmConfidence from which a grid may be beat-matched (SPEC Analysis)
// Overlapping two tracks beat on beat takes more than matching tempos: bpmConfidence vouches for the
// tempo, Analysis.grid for the beat PHASE where the two would meet (see canOverlap).
const GRID_TRUST = 0.5; // grid.head / .tail / .phase from which an end is "clear" (SPEC Analysis)
const GRID_SOFT = 0.15; // below this at either end, nothing is overlapped whatever the patterns say
const CONTRAST_MIN = 1.05; // attack patterns laid beat on beat must match this much better than at any other lag
const EDGE_BEATS = 16; // beats at each end of the usable audio that grid.head / grid.tail describe
// chooseNext: what a pair that can really be blended is worth over one that only matches in tempo.
const BLEND_BONUS = 0.6;
// chooseNext looks one track further: a candidate that can itself be blended into another track of the
// window is worth this much more than one that leads nowhere. Half the blend bonus and no more: a blend
// that is on offer now is certain, the one after it is a forecast (the window will have changed).
const LOOKAHEAD_BONUS = 0.3;
// chooseNext, when nothing in the window can be blended with the playing track anyway: that hand-over
// is best spent on a track that could never be beat-matched (so it stops occupying the window).
const DUMP_BONUS = 0.25;
// Ticker wording (Transition.why) for the two reasons that are the DJ's doing rather than the tempos'.
const WHY_HELD = 'tempos match, but the drums would clash — kept apart';
const WHY_VARIETY = 'chosen for variety';
const HARD_FLOOR = 0.15; // what is left of the percussive hand-overs' odds at vibe 0 (see typeWeights)
const SYNC_TOL = 0.08; // max tempo change we ask of a track
// A track that drops in on the one (no overlap) only takes over the outgoing tempo if that costs it
// less than this: speed is pitch here, and a solo track well off its own pitch is worse than a tempo step.
const DROP_SYNC_TOL = 0.03;
const GLIDE_SKIP = 0.003; // closer than this to 1.0 → step instead of glide
const GLIDE_CENTS_PER_S = 12; // a glide home may bend the pitch this fast before it reads as a bend
const END_GUARD = 0.02; // never plan playback into the last 20 ms of a buffer
const LEAD = 0.06; // first beat line we may use lies at least this far after `earliest`
const BUS_FLUSH_S = 1; // ≥ the longest delay time: after this long with feedback 0 the delay line is empty

const fin = Number.isFinite;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod = (n, m) => ((n % m) + m) % m;

// ───────────────────────────── analysis access ─────────────────────────────

/**
 * Defensive view of an Analysis: whatever comes in, the planner works on a finite duration, a
 * strictly increasing beat grid with at least two beats, sane cues and clamped scalars.
 */
function norm(an) {
  an = an || {};
  const bpmIn = fin(an.bpm) && an.bpm >= 30 && an.bpm <= 300 ? an.bpm : 120;
  let beats = [];
  if (an.beats && typeof an.beats.length === 'number') {
    let prev = -Infinity;
    for (let i = 0; i < an.beats.length; i++) {
      const b = an.beats[i];
      if (fin(b) && b > prev + 1e-4) {
        beats.push(b);
        prev = b;
      }
    }
  }
  let duration = fin(an.duration) && an.duration > 0 ? an.duration : 0;
  if (!duration && beats.length) duration = beats[beats.length - 1] + 60 / bpmIn;
  if (beats.length < 2) {
    // No usable grid: lay a regular one from the tempo so "beat" still means something.
    const p = 60 / bpmIn;
    const first = beats.length ? beats[0] - Math.floor(beats[0] / p) * p : 0;
    beats = [];
    for (let i = 0; first + i * p <= duration && i < 100000; i++) beats.push(first + i * p);
    if (beats.length < 2) beats = [first, first + p];
  }
  const n = beats.length;
  const period = (beats[n - 1] - beats[0]) / (n - 1);
  const cues = an.cues || {};
  const start = fin(cues.start) ? clamp(cues.start, 0, duration) : 0;
  const end = fin(cues.end) && cues.end > start + 0.05 ? Math.min(cues.end, duration) : duration;
  const cueIn = fin(cues.in) ? clamp(cues.in, 0, end) : start;
  const drop = fin(cues.drop) && cues.drop >= 0 && cues.drop < end ? cues.drop : null;
  const key = an.key || null;
  let cam = '?';
  if (key && typeof key.camelot === 'string' && key.camelot) cam = key.camelot;
  else if (key && fin(key.pc)) cam = camelot(key.pc, key.mode);
  const trim = an.loudness && fin(an.loudness.trimDb) ? an.loudness.trimDb : 0;
  // Grid trust is optional: an analysis without it (hand-made, tests) is taken at its bpmConfidence.
  const g = an.grid && typeof an.grid === 'object' ? an.grid : null;
  const unit = (v) => (fin(v) ? clamp(v, 0, 1) : 0);
  // (the slot pattern is indexed by beat: only usable if no beat had to be dropped above)
  const perBeat = g && Number.isInteger(g.perBeat) && g.perBeat >= 2 && g.perBeat % 2 === 0 ? g.perBeat : 0;
  const slots = perBeat && g.slots && an.beats && beats.length === an.beats.length && g.slots.length >= beats.length * perBeat ? g.slots : null;
  return {
    grid: g ? { phase: unit(g.phase), head: unit(g.head), tail: unit(g.tail), perBeat, slots } : null,
    duration,
    beats,
    period,
    bpm: fin(an.bpm) && an.bpm > 0 ? an.bpm : 60 / period,
    conf: fin(an.bpmConfidence) ? clamp(an.bpmConfidence, 0, 1) : 0,
    downbeat: fin(an.downbeat) ? mod(Math.round(an.downbeat), 4) : 0,
    key,
    cam,
    energy: fin(an.energy) ? clamp(an.energy, 0, 1) : 0.5,
    // (per-second level against the track's own loudest second; optional)
    curve: an.energyCurve && an.energyCurve.length > 0 ? an.energyCurve : null,
    trimDb: clamp(trim, -12, 6),
    cueStart: start,
    cueEnd: end,
    cueIn,
    drop,
  };
}

/** Buffer position of beat i. Fractional i interpolates; indices off either end extend the grid. */
function beatPos(N, i) {
  const n = N.beats.length;
  if (i <= 0) return N.beats[0] + i * N.period;
  if (i >= n - 1) return N.beats[n - 1] + (i - (n - 1)) * N.period;
  const lo = Math.floor(i);
  return N.beats[lo] + (N.beats[lo + 1] - N.beats[lo]) * (i - lo);
}

/** Smallest beat index whose position is ≥ pos. */
function idxAtOrAfter(N, pos) {
  const b = N.beats;
  const n = b.length;
  const eps = 1e-7;
  if (pos <= b[0] + eps) return Math.ceil((pos - b[0]) / N.period - 1e-6) + 0; // + 0: no negative zero
  if (pos > b[n - 1] + eps) return n - 1 + Math.ceil((pos - b[n - 1]) / N.period - 1e-6);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (b[m] >= pos - eps) hi = m;
    else lo = m + 1;
  }
  return lo;
}

/** Largest beat index whose position is ≤ pos. */
function idxAtOrBefore(N, pos) {
  const i = idxAtOrAfter(N, pos);
  return beatPos(N, i) <= pos + 1e-7 ? i : i - 1;
}

const downAtOrBefore = (N, i) => i - mod(i - N.downbeat, 4);
const downAtOrAfter = (N, i) => i + mod(N.downbeat - i, 4);
/** Nearest index on a line grid `ref + k*step`. */
const nearestLine = (i, ref, step) => ref + Math.round((i - ref) / step) * step;

/**
 * Least-squares straight grid through the analysed beats i0…i1: the best constant-tempo reading of
 * that stretch. Single beat times jitter by a few ms; a fitted line does not, and two fitted lines
 * are what get aligned in a beat-matched blend.
 * @returns {{period:number, pos:(i:number)=>number}}
 */
function lsGrid(N, i0, i1) {
  const lo = Math.max(0, Math.ceil(i0));
  const hi = Math.min(N.beats.length - 1, Math.floor(i1));
  const n = hi - lo + 1;
  if (n >= 3) {
    let si = 0;
    let sb = 0;
    for (let i = lo; i <= hi; i++) {
      si += i;
      sb += N.beats[i];
    }
    const mi = si / n;
    const mb = sb / n;
    let num = 0;
    let den = 0;
    for (let i = lo; i <= hi; i++) {
      num += (i - mi) * (N.beats[i] - mb);
      den += (i - mi) * (i - mi);
    }
    const p = num / den;
    if (fin(p) && p > 0 && Math.abs(p / N.period - 1) < 0.2) return { period: p, pos: (i) => mb + (i - mi) * p };
  }
  // The window hangs off the analysed beats: extend the global grid from the nearest real beat.
  const ref = clamp(Math.round((i0 + i1) / 2), 0, N.beats.length - 1);
  const base = N.beats[ref];
  return { period: N.period, pos: (i) => base + (i - ref) * N.period };
}

/**
 * How loud a track is over the two seconds from buffer position `pos`, in dB against its own loudest
 * second (≤ 0): Analysis.energyCurve spans 30 dB. 0 when the analysis carries no curve.
 */
function levelDbAt(N, pos) {
  if (!N.curve) return 0;
  const last = N.curve.length - 1;
  const k = clamp(Math.floor(pos), 0, last);
  const v = Math.max(Number(N.curve[k]), Number(N.curve[Math.min(last, k + 1)]));
  return fin(v) ? -30 * (1 - clamp(v, 0, 1)) : 0;
}

/** The downbeat a track is normally entered on: first bar line at/after cues.in. */
function cueIndex(N) {
  let j = downAtOrAfter(N, idxAtOrAfter(N, N.cueIn - 0.05));
  while (beatPos(N, j) < 0) j += 4;
  // A cue past the usable audio is useless: fall back to the first bar line with audio behind it.
  if (beatPos(N, j) > N.cueEnd - 4 * N.period) {
    j = downAtOrAfter(N, idxAtOrAfter(N, N.cueStart));
    while (beatPos(N, j) < 0) j += 4;
    if (beatPos(N, j) > N.duration - END_GUARD) j = idxAtOrAfter(N, 0);
  }
  return j;
}

/**
 * How far the beat phase can be trusted over the beats i0 … i1 of a track (0..1): Analysis.grid.head or
 * .tail where the stretch lies at that end of the usable audio (where previews are mixed), the
 * whole-track value anywhere else. 1 when the analysis carries no grid trust at all.
 */
function gridTrust(N, i0, i1) {
  if (!N.grid) return 1;
  const span = Math.max(1e-9, i1 - i0);
  const shared = (a, b) => Math.max(0, Math.min(i1, b) - Math.max(i0, a)) / span;
  const h0 = idxAtOrAfter(N, N.cueIn - 1e-3);
  const t1 = idxAtOrBefore(N, N.cueEnd + 1e-3);
  let trust = 1;
  let edge = false;
  if (shared(h0, h0 + EDGE_BEATS) >= 0.5) {
    trust = Math.min(trust, N.grid.head);
    edge = true;
  }
  if (shared(t1 - EDGE_BEATS, t1) >= 0.5) {
    trust = Math.min(trust, N.grid.tail);
    edge = true;
  }
  return edge ? trust : N.grid.phase;
}

/**
 * The two tracks' attack patterns (Analysis.grid.slots) laid over each other the way a blend would lay
 * the audio: A's beats iS … iS+L on B's beats j0 … j0+L. Returns how much better they correlate beat on
 * beat than at the best other lag up to half a beat either way (1 = no better; < 1 = they would fit
 * better shifted, i.e. the drums of the two would come out interleaved). null when a pattern is missing.
 */
function overlapContrast(A, iS, B, j0, L) {
  const ga = A.grid;
  const gb = B.grid;
  if (!ga || !gb || !ga.slots || !gb.slots || ga.perBeat !== gb.perBeat) return null;
  const P = ga.perBeat;
  const n = Math.round(L * P);
  const a0 = Math.round(iS * P);
  const b0 = Math.round(j0 * P);
  const at = (arr, k) => (k >= 0 && k < arr.length ? arr[k] : 0);
  let na = 0;
  for (let k = 0; k < n; k++) na += at(ga.slots, a0 + k) ** 2;
  if (!(na > 0)) return 0;
  let zero = 0;
  let other = 0;
  for (let d = -P / 2; d <= P / 2; d++) {
    let dot = 0;
    let nb = 0;
    for (let k = 0; k < n; k++) {
      const v = at(gb.slots, b0 + k + d);
      dot += at(ga.slots, a0 + k) * v;
      nb += v * v;
    }
    const c = nb > 0 ? dot / Math.sqrt(na * nb) : 0;
    if (d === 0) zero = c;
    else if (c > other) other = c;
  }
  return other > 0 ? zero / other : zero > 0 ? 9 : 0;
}

/**
 * May A's beats iS … iS+L and B's beats j0 … j0+L be overlapped beat on beat?
 *   - neither end may be one the analysis calls unclear (grid trust below GRID_SOFT), and
 *   - the two attack patterns must agree that "beat on beat" is where they fit (CONTRAST_MIN);
 *     without patterns, both ends must be clear on their own (GRID_TRUST).
 * Analyses without any grid trust (hand-made, tests) pass: bpmConfidence is then all there is.
 * @returns {{ok:boolean, out:number, in:number, contrast?:number}}  contrast only when both patterns exist
 */
function canOverlap(A, iS, B, j0, L) {
  if (!A.grid || !B.grid) return { ok: true, out: 1, in: 1 };
  const out = gridTrust(A, iS, iS + L);
  const inn = gridTrust(B, j0, j0 + L);
  const contrast = overlapContrast(A, iS, B, j0, L);
  const low = Math.min(out, inn);
  if (contrast === null) return { ok: low >= GRID_TRUST, out, in: inn };
  return { ok: low >= GRID_SOFT && contrast >= CONTRAST_MIN, out, in: inn, contrast: Math.round(contrast * 1000) / 1000 };
}

/** Best ×1 / ×2 / ÷2 reading of B's beat against A's (A possibly off-speed by rA). c = rate ratio B/A. */
function foldSync(pA, pB, rA) {
  let best = null;
  for (const f of [1, 2, 0.5]) {
    const c = (f * pB) / pA;
    const dev = Math.abs(Math.log(c * rA));
    if (!best || dev < best.dev) best = { f, c, dev };
  }
  return best;
}

/**
 * The play as the engine holds it after `engine.cancelFrom(t)`: automation and rate frozen at their
 * values as of t, nothing scheduled afterwards, no end. The conductor can use this to keep its copy
 * of a play in step with the engine after a Skip; next({quick:true}) applies it by itself.
 * @param {{startAt:number, rate:{t:number,v:number,ramp?:boolean}[], events:object[]}} play
 * @param {number} t set time of the cancel
 */
export function holdPlayAt(play, t) {
  const src = play.events || [];
  const events = [];
  const moving = new Set();
  for (const e of src) {
    if (e.t < t) events.push(e);
    else moving.add(e.p);
  }
  for (const p of moving) events.push({ p, t, v: evalParam(src, p, t, STRIP_DEFAULTS[p] ?? 0), k: 'set' });
  const pts = (play.rate || []).filter((q) => q.t < t);
  if (!pts.length) pts.push({ t: play.startAt, v: play.rate && play.rate.length ? play.rate[0].v : 1 });
  else {
    const nxt = play.rate.find((q) => q.t >= t);
    // Caught mid-glide: the rate ramped up to the cancel and stays where it was caught.
    if (nxt) pts.push(nxt.ramp && nxt.t > pts[pts.length - 1].t ? { t, v: rateAt(play, t), ramp: true } : { t, v: rateAt(play, t) });
  }
  return { ...play, events, rate: pts, endAt: null };
}

// ───────────────────────────── crate: order and next-track choice ─────────────────────────────

/** Ratio folded by octaves into [1/√2, √2): 75 vs 150 BPM is "the same tempo" to a DJ. */
function foldRatio(r) {
  if (!(r > 0) || !fin(r)) return 1;
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
}

/**
 * Target energy for the n-th play: a seeded wave — warm-up → build → peak → breather → build … —
 * so a set has shape instead of being a flat shuffle.
 */
export function energyArc(seed, n) {
  const r = createRng(`${seed}|arc`);
  const cycle = 9 + r.int(6);
  const peak = r.range(0.78, 0.92);
  const low = r.range(0.42, 0.55);
  const open = r.range(0.4, 0.5);
  const peakAt = r.range(0.6, 0.72);
  const holdTo = peakAt + r.range(0.1, 0.18);
  const i = Math.max(0, Math.floor(fin(n) ? n : 0));
  const phase = (i % cycle) / cycle;
  const from = i < cycle ? open : low;
  if (phase < peakAt) return from + (peak - from) * (phase / peakAt);
  if (phase < holdTo) return peak;
  return peak + (low - peak) * ((phase - holdTo) / (1 - holdTo));
}

const artistTokens = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\bwith\b/)
    .map((x) => x.trim())
    .filter(Boolean);

function tempoScore(a, b) {
  const d = Math.abs(foldRatio(b.period > 0 ? a.period / b.period : 1) - 1);
  // Inside the beat-matchable window everything is good (closer is only mildly better); outside it
  // the score drops off a cliff and keeps falling.
  const raw = d <= SYNC_TOL ? 1 - 0.15 * (d / SYNC_TOL) : Math.max(0, 0.55 - (d - SYNC_TOL) * 2.2);
  // An untrustworthy grid tells us little about the tempo: pull the score toward neutral.
  const trust = clamp(Math.min(a.conf, b.conf) / TRUST, 0, 1);
  return 0.35 + (raw - 0.35) * trust;
}

/** Grid trust where a track is normally left: its tail, or (short / medium sets leave mid-track) the whole. */
const exitTrust = (S, N) => (!N.grid ? 1 : S.mode === 'short' || S.mode === 'medium' ? N.grid.phase : N.grid.tail);

/**
 * Would a blend out of `cur` into `N` pass canOverlap where the planner would normally put it? In
 * preview mode that place is known in advance (last bar line of the usable audio into the first bar of
 * the next track); in the longer modes the exit depends on the play, so the two ends are judged on
 * their own.
 */
function blendableNext(S, cur, N) {
  if (S.mode !== 'preview') return Math.min(exitTrust(S, cur), N.grid.head) >= GRID_TRUST;
  const iX = downAtOrBefore(cur, idxAtOrBefore(cur, Math.min(cur.cueEnd + 1e-3, cur.duration - END_GUARD)));
  const j0 = cueIndex(N);
  return [8, 16].some((L) => canOverlap(cur, iX - L, N, j0, L).ok);
}

/**
 * Could a blend out of `a` into `b` be planned: both grids trusted, tempos within reach at the same beat
 * level, and (where the analyses carry grid trust) an overlap the gate would let through?
 */
function canBlendInto(S, a, b) {
  if (Math.min(a.conf, b.conf) < TRUST) return false;
  if (!(a.period > 0) || Math.abs(b.period / a.period - 1) > SYNC_TOL) return false;
  return !a.grid || !b.grid || blendableNext(S, a, b);
}

function chooseNext(S, current, candidates, ctx) {
  if (!candidates || !candidates.length) return -1;
  const playIndex = ctx && fin(ctx.playIndex) ? ctx.playIndex : 0;
  const recent = new Set();
  for (const a of (ctx && ctx.recentArtists) || []) for (const tok of artistTokens(a)) recent.add(tok);
  const target = energyArc(S.seed, playIndex);
  const cur = current ? norm(current.analysis) : null;
  const Ns = candidates.map((c) => norm((c || {}).analysis));
  const idOf = (k) => (candidates[k] || {}).id;
  // What each candidate leads to: can it be blended into another track of the window afterwards?
  // (A set is a chain of hand-overs; a track that is a dead end costs the next one as well.)
  const leads = Ns.map((N, k) => Ns.some((M, m) => m !== k && idOf(m) !== idOf(k) && canBlendInto(S, N, M)));
  const blendNow = Ns.map((N, k) => !!cur && idOf(k) !== current.id && canBlendInto(S, cur, N));
  // Nothing here can be blended with the playing track: this hand-over is a plain one whatever is picked.
  const lost = !!cur && !blendNow.some(Boolean);
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < candidates.length; k++) {
    const cand = candidates[k] || {};
    const N = Ns[k];
    // Noise is keyed by track, not by list position, so the pick does not depend on candidate order.
    const noise = createRng(`${S.seed}|pick|${playIndex}|${cand.id}`).range(-1, 1) * (0.15 + 0.2 * S.vibe);
    let score;
    if (!cur) {
      // Opener: nothing extreme, and a grid we can trust for the first blend.
      score = 1 - 1.6 * Math.abs(N.energy - Math.min(target, 0.5)) + 0.5 * N.conf + noise;
      if (N.grid && N.conf >= TRUST) score += 0.3 * exitTrust(S, N);
    } else {
      const fit = 1 - Math.min(1, Math.abs(N.energy - target) * 2);
      const jump = Math.max(0, Math.abs(N.energy - cur.energy) - 0.35) * 0.8;
      // A candidate we would beat-match is heard at the matched speed, i.e. transposed: judge its key there.
      const c = foldRatio(cur.period > 0 ? N.period / cur.period : 1);
      const matchable = Math.min(cur.conf, N.conf) >= TRUST && Math.abs(c - 1) <= SYNC_TOL;
      const harmony = keyCompat(cur.key, N.key, matchable ? rateToSemitones(c) : 0);
      score = 1.5 * tempoScore(cur, N) + 0.6 * harmony + 0.7 * fit - jump + noise;
      // Of the tracks that match in tempo, go for one we can really overlap: same beat level, and a
      // beat phase the analysis vouches for where the two would meet.
      if (blendNow[k]) score += BLEND_BONUS;
      // A hand-over that is plain anyway is the moment for a track nothing could be matched with.
      if (lost && N.conf < TRUST) score += DUMP_BONUS;
      if (cand.id === current.id) score -= 3;
    }
    if (leads[k]) score += LOOKAHEAD_BONUS;
    if (artistTokens(cand.artist).some((tok) => recent.has(tok))) score -= 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

// ───────────────────────────── entries without a mix ─────────────────────────────

const round1 = (x) => String(Math.round(x * 10) / 10);

/** Opening track (or a track entering after silence): short fade-in under an opening low-pass. */
function entry(S, track, B, opts) {
  const { id, from, startAt, tInit, deck, rng, quickFade } = opts;
  const j0 = cueIndex(B);
  const room = Math.max(0, B.duration - END_GUARD - 0.05);
  const offset = clamp(beatPos(B, j0), 0, room);
  const beats = quickFade ? 2 : rng.pick([4, 4, 8]);
  const dur = Math.max(0.05, Math.min(beats * B.period, 0.25 * Math.max(0, B.cueEnd - offset), room - offset, quickFade ? 1.5 : 6));
  const lane = buildFadeIn(createLane(STRIP_DEFAULTS), tInit, startAt, dur, rng);
  const play = {
    id,
    trackId: track.id,
    deck,
    startAt,
    offset,
    rate: [{ t: startAt, v: 1 }],
    trimDb: B.trimDb,
    events: sortEvents(lane.events),
    endAt: null,
    soloFrom: startAt + dur,
    via: 'fadeIn',
  };
  return {
    id,
    type: 'fadeIn',
    label: 'Fade in',
    why: `${round1(B.bpm)} BPM · ${B.cam}`,
    from,
    to: id,
    tStart: startAt,
    tEnd: startAt + dur,
    beats,
    synced: false,
    bpm: B.bpm,
    aEvents: [],
    aRate: [],
    aEndAt: startAt + dur,
    play,
    fx: [],
    fxEvents: [],
    marks: [{ t: startAt, label: 'Fade in' }],
  };
}

/** Play 0: `tInit` = set time the strip is set up (a few ms before the source starts at `startAt`). */
function opener(S, track, startAt, tInit) {
  track = track || {};
  const B = norm(track.analysis);
  const rng = createRng(`${S.seed}|first|${track.id}`);
  return entry(S, track, B, { id: 0, from: -1, startAt, tInit, deck: 0, rng, quickFade: false });
}

function first(S, track, opts) {
  const startAt = opts && fin(opts.startAt) ? opts.startAt : 0;
  // (the strip is initialised a few ms before startAt — see INIT_LEAD_S — which for startAt 0 is a
  // slightly negative set time; the engine's start lead-in covers it)
  return opener(S, track, startAt, startAt - INIT_LEAD_S);
}

/**
 * Last-resort plan, built from as little as possible so it cannot fail: if the outgoing track still
 * has audio, a very short crossfade starting at t0; if it is over, a plain entry at t0.
 */
function fallback(env) {
  const { S, A, B, playA, t0, incoming, id, rng } = env;
  const deck = playA.deck ? 0 : 1;
  const tHard = timeAtPosition(playA, A.duration - END_GUARD);
  const left = tHard - t0;
  if (!(fin(left) && left > 0.05)) {
    const tr = entry(S, incoming, B, { id, from: playA.id, startAt: t0 + INIT_LEAD_S, tInit: t0, deck, rng: rng.fork('entry'), quickFade: true });
    // The outgoing source has already run out (or will before t0): stop it where its audio ends.
    tr.aEndAt = fin(tHard) ? clamp(tHard, playA.startAt, t0) : t0;
    tr.why = `${round1(B.bpm)} BPM · ${B.cam} · previous track had ended`;
    tr.degraded = true;
    return tr;
  }
  const j0 = cueIndex(B);
  const dur = Math.min(0.25, left);
  const tEnd = t0 + dur;
  const bStart = t0 + Math.min(INIT_LEAD_S, dur / 2);
  const offset = clamp(beatPos(B, j0), 0, Math.max(0, B.duration - END_GUARD - dur));
  const a = createLane(STRIP_DEFAULTS);
  a.set('gain', t0, evalParam(playA.events || [], 'gain', t0, 1)).ramp('gain', t0, tEnd, 0);
  const b = createLane(STRIP_DEFAULTS);
  b.init(t0, { gain: 0 }).ramp('gain', bStart, tEnd, 1);
  return {
    id,
    type: 'cut',
    label: 'Cut',
    why: `${round1(A.bpm)} → ${round1(B.bpm)} BPM · ${A.cam} → ${B.cam} · out of track`,
    from: playA.id,
    to: id,
    tStart: t0,
    tEnd,
    beats: 0,
    synced: false,
    bpm: B.bpm,
    aEvents: sortEvents(a.events),
    aRate: [],
    aEndAt: tEnd,
    play: {
      id,
      trackId: incoming.id,
      deck,
      startAt: bStart,
      offset,
      rate: [{ t: bStart, v: 1 }],
      trimDb: B.trimDb,
      events: sortEvents(b.events),
      endAt: null,
      soloFrom: tEnd,
      via: 'cut',
    },
    fx: [],
    fxEvents: [],
    marks: [{ t: t0, label: 'Cut' }],
    degraded: true,
  };
}

// ───────────────────────────── the mix: track → track ─────────────────────────────

/** Nearest bar line to a buffer position. */
function downNearest(N, pos) {
  const i = idxAtOrAfter(N, pos - N.period / 2);
  const lo = downAtOrBefore(N, i);
  return i - lo <= 2 ? lo : lo + 4;
}

/**
 * Rate points that make a play run at c × (rate of `play`) from t0 to t1 — i.e. stay locked to a
 * master whose own tempo may still be gliding. c × piecewise-linear is piecewise-linear with the same
 * breakpoints, so the lock is exact, not approximated.
 */
function followRate(play, c, t0, t1) {
  const pts = [{ t: t0, v: c * rateAt(play, t0) }];
  if (!(t1 > t0)) return pts;
  const src = play.rate;
  for (const q of src) {
    if (q.t > t0 && q.t < t1) pts.push(q.ramp ? { t: q.t, v: c * q.v, ramp: true } : { t: q.t, v: c * q.v });
  }
  const k = src.findIndex((q) => q.t >= t1);
  const inRamp = k > 0 && src[k].ramp && src[k].t > src[k - 1].t;
  pts.push(inRamp ? { t: t1, v: c * rateAt(play, t1), ramp: true } : { t: t1, v: c * rateAt(play, t1) });
  return pts;
}

/**
 * How many beats (whole bars) the glide back to the track's own tempo takes. Speed is pitch on these
 * decks, so the further off the track is, the longer the glide: slow enough to pass as drift, not a bend.
 */
export function glideBeats(rate, period, mode) {
  const lo = mode === 'preview' ? 8 : 16;
  const seconds = Math.abs(100 * rateToSemitones(rate)) / GLIDE_CENTS_PER_S;
  const bars = Math.ceil(seconds / (4 * Math.max(period, 0.05)) - 1e-9);
  return clamp(4 * (fin(bars) ? bars : 0), lo, 2 * lo);
}

/** Relative odds of each transition type for this pair (before the feasibility filter). */
function typeWeights(env, matched, kc, bShort) {
  const v = env.S.vibe;
  const s = 1 - v;
  const m = !!matched;
  const clash = 1 + 1.2 * Math.max(0, 0.5 - kc); // clashing keys: get out quickly, percussively
  // "Smooth" means it: below vibe 0.2 the percussive hand-overs (cut, spinback, brake, roll, riser drop)
  // thin out with the slider, down to about one transition in fifty at 0 (they used to keep a floor
  // that added up to one in seven). Never to nothing: for some pairs they are all that can be built.
  const hard = clamp(v / 0.2, HARD_FLOOR, 1);
  // Pairs that may be overlapped (tempo AND grid trust, see canOverlap) are blended most of the time —
  // about 92 % / 84 % / 73 % at vibe 0 / 0.5 / 1 when the keys agree: far from every tempo match may be,
  // so where a blend is on offer it is usually taken, and the other moves are the spice. Every other
  // pair only has the right-hand column.
  const w = {
    bassSwap: 6.0 * (0.7 + 0.6 * kc),
    eqBlend: 4.4 * (0.4 + 1.2 * s) * (0.5 + kc),
    // the two spectra barely overlap in a filter blend, which makes it the kindest one to clashing keys
    filterBlend: 4.0 * (1.4 - 0.8 * kc),
    echoOut: (m ? 0.65 : 2.2) * clash,
    reverbWash: (m ? 0.4 : 1.6) * (0.5 + 1.2 * s),
    cut: (m ? 0.4 : 1.0) * (0.3 + 1.6 * v) * clash * hard,
    spinback: (m ? 0.25 : 0.8) * (0.15 + 2.15 * v) * hard,
    brake: (m ? 0.22 : 0.8) * (0.2 + 1.8 * v) * hard,
    loopRoll: (m ? 0.45 : 0.5) * (0.2 + 2 * v) * clash * hard,
    riserDrop: (m ? 0.5 : 1.4) * (0.3 + 1.8 * v) * clash * hard,
  };
  for (const type of TYPES) {
    if (RECIPES[type].overlap && bShort) w[type] *= 0.5; // a short incoming clip should not be spent inside a blend
    if (type === env.playA.via) w[type] *= 0.25; // do not repeat the move that brought this track in
  }
  if (env.quick) {
    // Skip pressed: favour moves that read as an immediate, deliberate exit.
    w.echoOut *= 1.5;
    w.cut *= 1.5;
    w.riserDrop *= 0.5;
    w.reverbWash *= 0.7;
  }
  return w;
}

/** Mid-solo tricks on the outgoing track, on its bar lines, clear of the transition and of each other. */
function planTricks(env, iS, tS, busFreeAt) {
  const out = { events: [], bus: [], fx: [], marks: [] };
  const { S, A, playA, t0 } = env;
  const dLo = downAtOrAfter(A, idxAtOrAfter(A, positionAt(playA, t0 + 0.05)) + 4); // a bar of plain solo first
  const dHi = downAtOrBefore(A, iS - 8); // and a clean bar before the transition
  const bars = (dHi - dLo) / 4 + 1;
  if (!(bars >= 1)) return out;
  const r = env.rng.fork('tricks');
  const nMax = S.mode === 'preview' ? 1 : clamp(Math.floor(bars / 12), 1, 4);
  const p = clamp(0.08 + 0.62 * S.vibe, 0, 0.8);
  const names = Object.keys(TRICKS);
  const base = { filterDip: 1.2 - 0.4 * S.vibe, echoThrow: 0.9, beatRepeat: 0.4 + 0.9 * S.vibe, hpfBuild: 0.6 + 0.6 * S.vibe };
  let stripFree = t0;
  let busFree = busFreeAt;
  for (let n = 0; n < nMax; n++) {
    const rr = r.fork(n);
    if (rr.next() >= p) continue;
    const segLo = dLo + 4 * Math.floor((bars * n) / nMax);
    const segHi = dLo + 4 * (Math.floor((bars * (n + 1)) / nMax) - 1);
    if (segHi < segLo) continue;
    const d = segLo + 4 * rr.int((segHi - segLo) / 4 + 1);
    const name = rr.weighted(names, names.map((x) => (TRICKS[x].grid && A.conf < TRUST ? 0 : base[x])));
    const T = TRICKS[name];
    const long = T.spans.length > 1 && S.mode !== 'preview' && d + 4 <= dHi && rr.next() < 0.5;
    const span = long ? T.spans[1] : T.spans[0];
    const at = (k) => timeAtPosition(playA, beatPos(A, d + k));
    const lane = createLane(STRIP_DEFAULTS);
    const bus = createLane(FX_DEFAULTS);
    const c = {
      A: lane,
      bus,
      fx: [],
      marks: [],
      at,
      rng: rr.fork(name),
      beatSec: (at(4) - at(0)) / 4,
      span,
      out: { id: playA.id, pos: (k) => beatPos(A, d + k), beatLen: (beatPos(A, d + 4) - beatPos(A, d)) / 4 },
    };
    T.build(c);
    let lo = Infinity;
    let hi = at(span);
    for (const e of [...lane.events, ...bus.events, ...c.fx]) {
      lo = Math.min(lo, e.t);
      hi = Math.max(hi, e.t + (e.dur || 0));
    }
    if (!(lo >= stripFree) || !(hi <= tS - 0.05)) continue;
    if (bus.events.length && !(bus.events[0].t >= busFree)) continue;
    out.events.push(...lane.events);
    out.bus.push(...bus.events);
    out.fx.push(...c.fx);
    out.marks.push(...c.marks);
    stripFree = lane.events.reduce((mx, e) => Math.max(mx, e.t), at(span)) + 0.01;
    if (bus.events.length) busFree = c.busFree + 0.05;
  }
  return out;
}

/** Cheap structural proof that a plan honours the hard guarantees; anything else falls back. */
function valid(tr, env) {
  const { A, B, playA } = env;
  const e = env.earliest - 1e-9;
  const p = tr.play;
  if (![tr.tStart, tr.tEnd, tr.aEndAt, tr.bpm, tr.beats, p.startAt, p.offset, p.soloFrom, p.trimDb].every(fin)) return false;
  if (tr.tStart < e || tr.tEnd < tr.tStart || tr.aEndAt < tr.tEnd || p.startAt < e || p.offset < 0) return false;
  for (const list of [tr.aEvents, p.events, tr.fxEvents]) {
    let prev = -Infinity;
    for (const ev of list) {
      if (!fin(ev.t) || !fin(ev.v) || ev.t < e || ev.t < prev) return false;
      prev = ev.t;
    }
  }
  for (const f of tr.fx) {
    for (const k of Object.keys(f)) if (typeof f[k] === 'number' && !fin(f[k])) return false;
    if (f.t < e || (f.dur !== undefined && !(f.dur > 0))) return false;
    if (f.kind === 'loop' && !(f.offset >= 0 && f.len > 0 && f.offset + f.len <= A.duration && f.rate > 0)) return false;
    if (f.kind === 'reverse' && !(f.len > 0 && f.offset - f.len >= -1e-9 && f.offset <= A.duration && f.rate0 > 0 && f.rate1 > 0)) return false;
  }
  let prevT = -Infinity;
  for (const q of p.rate) {
    if (!fin(q.t) || !(q.v > 0) || q.t < prevT) return false;
    prevT = q.t;
  }
  if (p.rate[0].t !== p.startAt) return false;
  prevT = playA.rate[playA.rate.length - 1].t;
  for (const q of tr.aRate) {
    if (!fin(q.t) || !(q.v > 0) || q.t < prevT || q.t < e) return false;
    prevT = q.t;
  }
  if (positionAt(p, p.soloFrom) > B.duration + 1e-6) return false;
  const outPlay = tr.aRate.length ? { ...playA, rate: [...playA.rate, ...tr.aRate] } : playA;
  if (positionAt(outPlay, tr.aEndAt) > A.duration + 1e-6) return false;
  return tr.marks.every((mk) => fin(mk.t));
}

/** Plan a real mix out of env.playA into the incoming track, or return null if nothing fits. */
function build(env) {
  const { S, A, B, playA, t0, quick, rng, incoming, id } = env;
  const R = (t) => rateAt(playA, t);
  const tb = (i) => timeAtPosition(playA, beatPos(A, i));
  const tHard = timeAtPosition(playA, A.duration - END_GUARD);
  if (!fin(tHard) || tHard < t0 + LEAD + 0.02) return null;
  // Frozen mid-brake (a Skip caught a cancelled brake): the deck is crawling, its "next beat" may be
  // seconds away. Nothing musical is left to mix out of — hand over at once.
  if (R(t0) < 0.5) return null;

  // Beat lines of the outgoing track we may still use.
  const iMin = idxAtOrAfter(A, positionAt(playA, t0 + LEAD));
  const iHard = idxAtOrBefore(A, A.duration - END_GUARD);
  if (iMin > iHard) return null;
  const iUse = Math.min(iHard, idxAtOrBefore(A, A.cueEnd + 1e-3));
  const iBar = downAtOrBefore(A, iUse); // last bar line inside the usable audio
  // Skip pressed, or no bar line left: start on the very next beat and keep it short.
  const urgent = quick || iBar < iMin;
  const iRef = downNearest(A, positionAt(playA, playA.startAt + PREROLL_S)); // bar the track was entered on → phrase grid

  // Where the outgoing track is left (iX = line on which its dry signal is gone).
  let iX = iBar;
  if (!urgent && S.mode !== 'preview') {
    const iOutro = iUse - mod(iUse - iRef, 16);
    const iFull = iOutro >= iMin + 8 ? iOutro : iBar;
    if (S.mode === 'full') iX = iFull;
    else {
      const T = (S.mode === 'short' ? 45 : 90) * rng.range(0.9, 1.1);
      let iP = nearestLine(idxAtOrAfter(A, positionAt(playA, playA.startAt + T)), iRef, 16);
      while (iP - iMin < 24 && iP + 16 <= iFull) iP += 16;
      iX = iP >= iMin && iP <= iFull ? iP : iFull;
    }
  }
  const maxL = (urgent ? iHard : iX) - iMin;
  const startOf = (L) => (urgent ? iMin : iX - L);

  // Can the two be beat-matched here? (A may still be gliding, so judge its tempo at the overlap.)
  const tNom = tb(urgent ? iMin : Math.max(iMin, iX - 16));
  const tNomEnd = tb(urgent ? Math.min(iHard, iMin + 4) : iX);
  let sync = null;
  if (A.conf >= TRUST && B.conf >= TRUST) {
    const s = foldSync(A.period, B.period, R(tNom));
    if (Math.abs(s.c * R(tNom) - 1) <= SYNC_TOL && Math.abs(s.c * R(tNomEnd) - 1) <= SYNC_TOL) sync = s;
  }
  const beatNom = A.period / R(tNom);

  // How much of the incoming track a blend may consume (keep some for its own solo and exit).
  const jIn = cueIndex(B);
  const bAvail = Math.max(0, B.cueEnd - beatPos(B, jIn));
  const reserve = Math.min(8 * B.period, 0.5 * bAvail);
  const maxLBsync = sync ? Math.floor((bAvail - reserve) / (sync.f * B.period)) : -1;
  const maxLBfree = Math.floor((bAvail - reserve) / beatNom);

  // The delay bus may still be ringing from the echo that brought this track in (or from a throw the
  // Skip just cancelled).
  const soloFrom = fin(playA.soloFrom) ? playA.soloFrom : playA.startAt;
  let busFreeAt = playA.via === undefined || playA.via === 'echoOut' ? soloFrom + FX_BUS_GUARD : -Infinity;
  let flushBus = false;
  if (env.held) {
    const thrown = (env.raw.events || []).some((ev) => ev.p === 'delaySend' && ev.v > 0 && ev.t > env.holdT - FX_BUS_GUARD);
    if (thrown || env.holdT < busFreeAt) {
      // The cancel may have frozen the bus mid-echo with its reset un-scheduled: flush it ourselves.
      flushBus = true;
      busFreeAt = t0 + BUS_FLUSH_S + 0.01;
    }
  }

  const lastRateT = playA.rate[playA.rate.length - 1].t;
  const ok = (type, L) => {
    const Rc = RECIPES[type];
    if (L > maxL) return false;
    if (Rc.sync === 'required' && (!sync || L > maxLBsync)) return false;
    if (Rc.overlap && Rc.sync !== 'required' && L > maxLBfree) return false;
    const iS = startOf(L);
    if (type === 'echoOut') return tb(iS) - 0.03 >= busFreeAt;
    if (type === 'spinback') return beatPos(A, iS) >= 0.8; // needs audio behind the needle to rewind
    if (type === 'brake') return lastRateT <= tb(iS); // its rate ramp is appended: nothing may be scheduled later
    if (type === 'loopRoll') return A.conf >= 0.4; // a roll off the grid just sounds like a glitch
    return true;
  };
  // Two tracks are overlapped beat on beat only where the analysis vouches for the beat phase of both:
  // the outgoing track's beats under the blend and the incoming track's first ones. Anything less
  // (a syncopated intro, a grid that may sit half a beat off) and the drums of the two can end up
  // interleaved, which is the one thing a blend must not do. A ×2 / ÷2 tempo fold is left alone too:
  // it puts the faster track's "two" on the slower one's "and" as often as not.
  const overlapOk = (L) => !!sync && sync.f === 1 && canOverlap(A, startOf(L), B, jIn, L).ok;
  const isBlend = (type) => RECIPES[type].overlap && RECIPES[type].sync === 'required';
  // Harmony as it will be heard: a beat-matched incoming track is transposed by its rate change
  // (no key lock); an unmatched one plays at its own pitch against wherever the outgoing deck is.
  const kc = keyCompat(A.key, B.key, sync ? rateToSemitones(sync.c) : -rateToSemitones(R(tNom)));

  // How long a move may be: leave the outgoing track some solo time if the clip allows, then follow
  // the recipe's taste. → the lengths to choose between (its liked ones that fit, else one fallback).
  const soloMin = S.mode === 'preview' ? 8 : 16;
  // `short`: only the shortest of the liked lengths.
  const lengthChoices = (type, list, short) => {
    const roomy = list.filter((L) => urgent || L <= maxL - soloMin);
    const pool = roomy.length ? roomy : [Math.min(...list)];
    let liked = preferredLengths(type, S.mode, urgent, beatNom);
    if (short) liked = [Math.min(...liked)];
    const prefs = liked.filter((L) => pool.includes(L));
    if (prefs.length) return prefs;
    const cap = Math.max(...liked);
    const under = pool.filter((x) => x <= cap);
    return [under.length ? Math.max(...under) : Math.min(...pool)];
  };
  const feas = {};
  const choices = {};
  for (const type of TYPES) {
    feas[type] = RECIPES[type].lengths.filter((L) => ok(type, L));
    // A blend is on offer only at a length it would really be played at AND may be overlapped at.
    if (isBlend(type)) choices[type] = feas[type].length ? lengthChoices(type, feas[type], false).filter(overlapOk) : [];
  }
  const blendable = TYPES.some((type) => isBlend(type) && choices[type].length);
  // Matchable in tempo and a blend would fit, but no overlap is allowed here: the pair is treated like
  // one that cannot be matched — the moves left all hand over on one line (or wash across briefly).
  const held = !!sync && !blendable && TYPES.some((type) => isBlend(type) && feas[type].length);
  const w = typeWeights(env, !!sync && !held, kc, bAvail < 12);
  const weights = TYPES.map((type) => ((isBlend(type) ? choices[type] : feas[type]).length ? w[type] : 0));
  // opts.force (tests, demos): honoured when that move can be built here at all — it is not asked
  // whether the grids deserve it.
  const force = env.force || {};
  const forced = !!(force.type && feas[force.type] && feas[force.type].length);
  if (!forced && !weights.some((x) => x > 0)) return null;
  let type = rng.weighted(TYPES, weights.some((x) => x > 0) ? weights : TYPES.map((t) => (t === force.type ? 1 : 0)));
  if (forced) type = force.type;
  const Rc = RECIPES[type];

  // (a wash is the one unsynced move that overlaps: where the beats may be half a beat apart, keep it short)
  const prefs = isBlend(type) && !forced ? choices[type] : lengthChoices(type, feas[type], held && type === 'reverbWash');
  const uLen = rng.next();
  let L;
  if (Rc.overlap && Math.min(...prefs) !== Math.max(...prefs)) {
    // Long blends when the keys agree and the vibe is smooth; short ones when they clash or it is wild.
    const pLong = clamp(0.2 + 0.6 * kc - 0.35 * S.vibe + (S.mode === 'preview' ? 0 : 0.1), 0.05, 0.9);
    L = uLen < pLong ? Math.max(...prefs) : Math.min(...prefs);
  } else {
    L = prefs[Math.floor(uLen * prefs.length)];
  }
  if (feas[type].includes(force.beats)) L = force.beats;

  // Where the incoming track enters: its first bar, or (longer modes) timed around its drop.
  const wantSync = !!sync && Rc.sync !== 'never';
  let j0 = jIn;
  if (!urgent && S.mode !== 'preview' && B.drop !== null) {
    const u1 = rng.next();
    const u2 = rng.next();
    const jDrop = downNearest(B, B.drop);
    const eaten = Rc.sync === 'required' ? L * sync.f : (L * beatNom) / B.period; // incoming beats used up by the blend
    // Blends land the drop as the blend completes; drop-ins hit the drop itself or start a phrase before it.
    const before = Rc.overlap ? Math.round(eaten / 4) * 4 : u2 < 0.5 ? 0 : 16;
    const jc = jDrop - before;
    const need = { short: 27, medium: 54, full: 60 }[S.mode] + (Rc.overlap ? L * beatNom : 0);
    const pEnter = { short: 0.7, medium: 0.5, full: 0.2 }[S.mode];
    if (u1 < pEnter && jc > jIn && B.cueEnd - beatPos(B, jc) >= need) j0 = jc;
    // (a blend that enters anywhere but the head needs the grid to be trusted there as well)
    if (j0 !== jIn && isBlend(type) && !forced && !canOverlap(A, startOf(L), B, j0, L).ok) j0 = jIn;
  }

  // The outgoing track's beat clock for this transition (least-squares grid around it).
  const iS = startOf(L);
  // Room before the first beat line for the fader cut and (after a Skip) the 30 ms strip tidy-up.
  const lead = L === 0 ? 0.035 + CUT_S : 0.035;
  const g = lsGrid(A, iS - 4, iS + L + 4);
  let pA = g.period;
  let posA = (k) => g.pos(iS + k);
  if (!(timeAtPosition(playA, posA(0)) >= t0 + lead) || posA(L) > A.duration - 0.002 || posA(0) < 0) {
    // The fitted line strays past a hard limit (ragged grid): use the analysed beats themselves.
    pA = A.period;
    posA = (k) => beatPos(A, iS + k);
  }
  const at = (k) => timeAtPosition(playA, posA(k));
  const tS = at(0);
  const X = at(L);
  if (!(tS >= t0 + lead) || !fin(X) || posA(L) > A.duration) return null;
  const beatSec = L > 0 ? (X - tS) / L : pA / R(tS);

  // Beat-match: lock the incoming rate to c × (outgoing rate), downbeat on downbeat.
  let useSync = wantSync;
  let c = 1;
  let gB = null;
  if (useSync) {
    gB = lsGrid(B, j0 - 2, j0 + Math.ceil(L * sync.f) + 8);
    c = (sync.f * gB.period) / pA;
    const off = Math.max(Math.abs(c * R(tS) - 1), Math.abs(c * R(X) - 1));
    if (off > SYNC_TOL + 0.02) {
      if (Rc.sync === 'required') return null;
      useSync = false;
    } else if (Rc.sync !== 'required' && off > DROP_SYNC_TOL) {
      useSync = false;
    }
  }
  const cuePos = useSync ? gB.pos(j0) : beatPos(B, j0);
  let bStart;
  let offset;
  let pre = 0;
  if (Rc.overlap) {
    bStart = tS;
    offset = cuePos;
    if (useSync) {
      // Starting off the bar (Skip): place the incoming so its downbeat meets the outgoing's next one.
      offset -= mod(A.downbeat - iS, 4) * sync.f * gB.period;
      while (offset < 0) offset += 4 * gB.period;
    }
  } else {
    pre = PREROLL_S;
    let back = useSync ? c * (posA(L) - positionAt(playA, X - pre)) : pre;
    if (cuePos - back < 0) {
      pre = 0;
      back = 0;
    }
    bStart = X - pre;
    offset = cuePos - back;
  }
  let rate = [{ t: bStart, v: 1 }];
  if (useSync) {
    rate = followRate(playA, c, bStart, X);
    const v = rate[rate.length - 1].v;
    // Afterwards the incoming track eases back to its own tempo over a few bars.
    if (Math.abs(v - 1) > GLIDE_SKIP) rate.push({ t: X + glideBeats(v, B.period, S.mode) * B.period, v: 1, ramp: true });
    else if (v !== 1) rate.push({ t: X, v: 1 });
  }

  // Write the automation.
  const laneA = createLane(STRIP_DEFAULTS);
  const laneB = createLane(STRIP_DEFAULTS);
  const bus = createLane(FX_DEFAULTS);
  const ctx = {
    at,
    L,
    tS,
    X,
    beatSec,
    bStart,
    bInit: bStart - INIT_LEAD_S,
    pre,
    rng: rng.fork(type),
    vibe: S.vibe,
    inDb: levelDbAt(B, cuePos),
    A: laneA,
    B: laneB,
    bus,
    fx: [],
    aRate: [],
    marks: [],
    out: { id: playA.id, pos: posA, beatLen: pA, rate: R },
  };
  Rc.build(ctx);

  const pre0 = createLane(STRIP_DEFAULTS);
  if (env.held) {
    // After a Skip the strip is frozen wherever the cancel caught it (mid filter dip, source muted
    // by a roll …): state what we believe it holds, then bring everything back to rest quickly.
    for (const p of Object.keys(STRIP_DEFAULTS)) {
      pre0.set(p, t0, evalParam(playA.events || [], p, t0, STRIP_DEFAULTS[p]));
      if (pre0.value(p) !== STRIP_DEFAULTS[p]) pre0.ramp(p, t0, t0 + 0.03, STRIP_DEFAULTS[p]);
    }
  }
  const tricks = urgent || env.held ? { events: [], bus: [], fx: [], marks: [] } : planTricks(env, iS, tS, busFreeAt);
  // Flush = close the return from wherever it is (a target curve needs no anchor), kill the feedback,
  // wait out the longest delay time, reopen. delayTime is left alone: every use sets its own.
  const flush = flushBus
    ? [
        { p: 'fxReturn', t: t0, v: 0, k: 'tgt', tc: 0.05 },
        { p: 'delayFeedback', t: t0, v: 0, k: 'set' },
        { p: 'fxReturn', t: t0 + BUS_FLUSH_S, v: FX_DEFAULTS.fxReturn, k: 'set' },
        { p: 'delayFeedback', t: t0 + BUS_FLUSH_S, v: FX_DEFAULTS.delayFeedback, k: 'set' },
      ]
    : [];

  const tStart = Math.min(bStart, laneA.events.reduce((mn, ev) => Math.min(mn, ev.t), tS));
  const bpmA = (60 / A.period) * R(tS);
  const names = `${round1(A.bpm * R(tS))} → ${round1(B.bpm)} BPM`;
  // The ticker line. Whenever the move is not a beat-matched blend it ends with the reason, and the
  // reason is what is actually true of THIS pair — never a guess about the music:
  //   no trusted tempo on one side → that side is named (the other one's beat may be perfectly steady)
  //   both trusted, too far apart  → the tempos
  //   matchable, held by the gate  → the drums (canOverlap would not vouch for them beat on beat)
  //   matchable, no blend fits     → room
  //   a blend was on offer         → the DJ's choice
  const fold = !sync || sync.f === 1 ? '' : sync.f === 2 ? 'double-time' : 'half-time';
  let reason = '';
  if (isBlend(type)) reason = '';
  else if (!sync) reason = A.conf < TRUST || B.conf < TRUST ? `no steady beat detected in ${A.conf >= TRUST ? 'the incoming track' : B.conf >= TRUST ? 'the outgoing track' : 'either track'}` : 'tempos too far apart to match';
  else if (fold) reason = useSync ? '' : `${fold} apart, not blended`; // (a carried fold is labelled below)
  else if (held) reason = WHY_HELD;
  else if (!blendable) reason = 'no room left for a blend';
  else reason = WHY_VARIETY;
  let why;
  if (useSync) {
    // Rounded before the sign is chosen: a pitch move below 0.05 % is none ("±0.0%"), not "−0.0%".
    const pct = Number(((rate[0].v - 1) * 100).toFixed(1));
    why = `${names} (${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct).toFixed(1)}%)${fold ? ` · ${fold}` : ''} · ${A.cam} → ${B.cam}`;
  } else {
    why = `${names} · ${A.cam} → ${B.cam}`;
  }
  if (reason) why += ` · ${reason}`;
  const byT = (x, y) => x.t - y.t;
  return {
    id,
    type,
    label: labelFor(type, L),
    why,
    from: playA.id,
    to: id,
    tStart,
    tEnd: X,
    beats: L,
    synced: useSync,
    bpm: bpmA,
    aEvents: sortEvents([...pre0.events, ...tricks.events, ...laneA.events]),
    aRate: ctx.aRate,
    aEndAt: X,
    play: {
      id,
      trackId: incoming.id,
      deck: playA.deck ? 0 : 1,
      startAt: bStart,
      offset,
      rate,
      trimDb: B.trimDb,
      events: sortEvents(laneB.events),
      endAt: null,
      soloFrom: X,
      via: type,
    },
    fx: [...tricks.fx, ...ctx.fx].sort(byT),
    fxEvents: sortEvents([...flush, ...tricks.bus, ...bus.events]),
    marks: [...tricks.marks, ...ctx.marks].sort(byT),
    // Blends only: what canOverlap made of these two stretches (a forced blend carries it too).
    ...(isBlend(type) ? { trust: canOverlap(A, iS, B, j0, L) } : {}),
  };
}

/** A Play we can compute with even if the caller's copy is incomplete (missing rate / events / ids). */
function normPlay(p) {
  p = p || {};
  const startAt = fin(p.startAt) ? p.startAt : 0;
  const rate = [];
  for (const q of Array.isArray(p.rate) ? p.rate : []) {
    if (q && fin(q.t) && q.v > 0 && fin(q.v) && (!rate.length || q.t >= rate[rate.length - 1].t)) rate.push(q);
  }
  if (!rate.length) rate.push({ t: startAt, v: 1 });
  const same = Array.isArray(p.rate) && rate.length === p.rate.length;
  return {
    ...p,
    id: fin(p.id) ? p.id : 0,
    deck: p.deck ? 1 : 0,
    startAt,
    offset: fin(p.offset) ? p.offset : 0,
    rate: same ? p.rate : rate,
    events: Array.isArray(p.events) ? p.events : [],
  };
}

function next(S, prev, incoming, opts) {
  opts = opts || {};
  incoming = incoming || {};
  // Nothing to mix out of: this is an opener, whatever it was called as (its strip is set up at
  // `earliest`, so the source starts a few ms later — nothing may be scheduled before `earliest`).
  if (!prev || !prev.play) {
    const e = fin(opts.earliest) ? opts.earliest : 0;
    return opener(S, incoming, e + INIT_LEAD_S, e);
  }
  const raw = normPlay(prev.play);
  const A = norm(prev.analysis);
  const B = norm(incoming.analysis);
  const earliest = fin(opts.earliest) ? opts.earliest : raw.startAt;
  const quick = !!opts.quick;
  // Skip: the engine froze the outgoing strip + rate at the cancel time; plan from that reality.
  const holdT = fin(opts.cancelledAt) ? Math.min(opts.cancelledAt, earliest) : quick ? earliest : null;
  const playA = holdT !== null ? holdPlayAt(raw, holdT) : { ...raw, endAt: null };
  const t0 = Math.max(earliest, playA.startAt, fin(playA.soloFrom) ? playA.soloFrom : playA.startAt);
  const id = raw.id + 1;
  const rng = createRng(`${S.seed}|next|${id}|${raw.trackId}|${incoming.id}`);
  const env = { S, A, B, raw, playA, incoming, earliest, t0, quick, held: holdT !== null, holdT, id, rng, force: opts.force };
  try {
    const tr = build(env);
    if (tr && valid(tr, env)) return tr;
  } catch {
    // fall through: a plan must always come back
  }
  return fallback(env);
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * @param {{seed: string|number, vibe?: number, mode?: 'preview'|'short'|'medium'|'full'}} opts
 *   vibe 0 = smooth (long blends, washes) … 1 = wild (cuts, rolls, spinbacks, risers); default 0.5.
 */
export function createPlanner(opts) {
  const o = opts || {};
  const S = {
    seed: String(o.seed ?? '0'),
    vibe: fin(o.vibe) ? clamp(o.vibe, 0, 1) : 0.5,
    mode: MODES.includes(o.mode) ? o.mode : 'preview',
  };
  return {
    get seed() {
      return S.seed;
    },
    get vibe() {
      return S.vibe;
    },
    get mode() {
      return S.mode;
    },
    /** Live controls: affect plans made from now on (plans stay a pure function of seed + vibe + mode + inputs). */
    setVibe(v) {
      if (fin(v)) S.vibe = clamp(v, 0, 1);
    },
    setMode(m) {
      if (MODES.includes(m)) S.mode = m;
    },
    /** Seeded base order of the crate. */
    order: (trackIds) => createRng(`${S.seed}|order`).shuffle(Array.from(trackIds || [])),
    /** Index into `candidates` of the best next track (−1 for an empty list). current === null → opener. */
    chooseNext: (current, candidates, ctx) => chooseNext(S, current, candidates, ctx),
    /** Entry of the opening track: Transition of type 'fadeIn', from −1, play id 0. */
    first: (track, o2) => first(S, track, o2),
    /**
     * The mix from `prev` into `incoming`. opts.earliest = no event before this set time;
     * opts.quick = Skip; opts.cancelledAt (optional) = set time passed to engine.cancelFrom;
     * opts.force = {type?, beats?} (optional, tests / demos) = use that move if it can be built here.
     */
    next: (prev, incoming, o2) => next(S, prev, incoming, o2),
  };
}

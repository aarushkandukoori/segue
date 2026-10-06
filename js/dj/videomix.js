// Full-song transitions (SPEC 6.4): how one YouTube deck hands the set over to the other.
//
// Full songs come through YouTube's embedded player, so there is no beat grid and no audio processing:
// the only controls are each deck's volume (linear amplitude 0..1, applied about 20 times a second)
// and Web Audio one-shots (riser / impact) layered on top. Every move here is therefore a pair of
// volume shapes plus, at most, a riser and a boom. BPM / energy may be known from the 30-second
// preview's analysis; a tempo is only used to size things in beats when its confidence is ≥ 0.5, and
// even then only as a nominal length (where the full song's beats fall is unknown).
//
// Pure and deterministic: (seed, vibe, mode, playIndex, inputs) → plan. Every random choice comes from
// an RNG forked by label off `${seed}|video|${playIndex}`, so no draw depends on what was drawn before
// it, on which recipe was considered first, or on call history.

import { createRng } from '../util/rng.js';

export const VIDEO_TYPES = Object.freeze(['longBlend', 'crossfade', 'fadeDrop', 'riserDrop', 'cut']);
export const VIDEO_MODES = Object.freeze(['short', 'medium', 'full']);

/**
 * YouTube's play() takes ≈ 0.3 s to become audible (measured, SPEC 6.1), so the incoming deck is
 * started this long before its volume first rises: incStart = (first rise) − PLAY_LEAD_S.
 */
export const PLAY_LEAD_S = 0.35;
/** One tick of the ≈ 20 Hz volume drive: the shortest volume move that is not a click (or skipped). */
export const VOL_STEP_S = 0.05;
/** Ceiling of the two decks' summed amplitude at every instant. */
export const SUM_MAX = 1.15;
/** Riser level at its end — the Web Audio planner's range (transitions.js RISER_GAIN), not imported to keep this module standalone. */
export const RISER_GAIN = Object.freeze([0.42, 0.6]);
/** Length ranges in seconds of the natural (not skipped, not late) moves; `quickCrossfade` = Skip. */
export const LENGTHS = Object.freeze({
  longBlend: Object.freeze([12, 24]),
  crossfade: Object.freeze([4, 10]),
  quickCrossfade: Object.freeze([1.5, 3]),
  fadeDrop: Object.freeze([0.5, 2.5]),
  riserDrop: Object.freeze([1.5, 6]),
  cut: Object.freeze([0.08, 0.15]),
});
/**
 * How short a move may be squeezed when it starts late and the outgoing song is running out (below
 * this the next move down the chain is tried: long blend → crossfade → fade drop → cut).
 */
export const LATE_MIN = Object.freeze({ longBlend: 12, crossfade: 1.5, riserDrop: 1.5, fadeDrop: 0.5, cut: 0.08 });

const fin = Number.isFinite;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const TRUST = 0.5; // bpmConfidence from which a tempo may size things in beats (SPEC Analysis)
const DEFAULT_DURATION_S = 210; // an outgoing song whose length nobody reported: a typical single
const END_MARGIN_S = 1; // the outgoing song is gone at least this long before its own end
const TARGET_S = { short: 45, medium: 90 };
const TARGET_SPREAD = 0.12; // ± share of the target
const GUARD_S = [8, 20]; // outro guard of a full play (the song's own fade / tail is not mixed over)
const PREVIEW_GUARD_S = [1, 2.5]; // a 30-second fallback clip is left this close to its end
const REPEAT_PENALTY = 0.3; // odds of repeating the move that brought the outgoing song in
// The crossfade shape: an equal-power quarter sine would sum to √2 ≈ 1.41 in the middle. Raising
// sin / cos to the power K keeps the shape (the incoming comes up fast, the outgoing leaves late) while
// the summed amplitude peaks at XF_PEAK, under SUM_MAX: the middle sits ≈ 2 dB under either song alone
// (a straight linear fade sags 3 dB).
const XF_PEAK = 1.13;
const XF_K = Math.log(XF_PEAK / 2) / Math.log(Math.SQRT1_2);
const OVERLAP = { longBlend: true, crossfade: true, fadeDrop: false, riserDrop: false, cut: false };
const NAMES = { longBlend: 'Long blend', crossfade: 'Crossfade', fadeDrop: 'Fade drop', riserDrop: 'Riser drop', cut: 'Cut' };
const FALLBACK = {
  longBlend: ['longBlend', 'crossfade', 'fadeDrop', 'cut'],
  crossfade: ['crossfade', 'fadeDrop', 'cut'],
  riserDrop: ['riserDrop', 'fadeDrop', 'cut'],
  fadeDrop: ['fadeDrop', 'cut'],
  cut: ['cut'],
};
// Full plays lean on long blends, short ones on drops and cuts.
const MODE_BIAS = {
  full: { longBlend: 1.6, crossfade: 1.0, fadeDrop: 0.6, riserDrop: 0.6, cut: 0.5 },
  medium: { longBlend: 1.0, crossfade: 1.0, fadeDrop: 1.0, riserDrop: 1.0, cut: 1.0 },
  short: { longBlend: 0.45, crossfade: 1.1, fadeDrop: 1.5, riserDrop: 1.5, cut: 1.4 },
};

/**
 * @typedef {Object} VideoSide
 * @property {string} [id]
 * @property {number} [durationS]       full length of what will play (YouTube reports it during the ad already)
 * @property {number} [startedAt]       out only: set time its position 0 was (or would have been) heard
 * @property {number} [bpm]             from the preview's analysis, if any
 * @property {number} [bpmConfidence]   bpm is used only when this is ≥ 0.5
 * @property {number} [energy]          0..1, from the preview's analysis
 * @property {'youtube'|'preview'} [provider]   'preview' = the 30-second fallback clip played through Web Audio
 */

/**
 * @typedef {Object} VideoInput
 * @property {string|number} seed
 * @property {number} [vibe]          0 smooth … 1 wild (default 0.5)
 * @property {'short'|'medium'|'full'} [mode]   default 'medium'
 * @property {number} playIndex       the outgoing play's index in the set (seeds this hand-over)
 * @property {string} [prevType]      type of the move that brought the outgoing song in
 * @property {boolean} [quick]        Skip: start at `earliest` with a 1.5–3 s crossfade or a cut
 * @property {'skip'|'newset'} [reason]  what asked for the quick move: Skip (default) or New Set (the
 *                                    song on air bridges into the new order). Only the note differs:
 *                                    "skipped" / "new set"; the plan itself is the same.
 * @property {number} earliest        set time; nothing (no breakpoint, no play() call, no fx) before it
 * @property {VideoSide} out
 * @property {VideoSide} [inc]        optional for leavePoint()
 */

/**
 * @typedef {Object} VideoTransition
 * @property {'longBlend'|'crossfade'|'fadeDrop'|'riserDrop'|'cut'} type
 * @property {string} label     "Long blend · 18 s" · "Riser drop · 8 beats" · "Cut"
 * @property {string} why       "Full songs · 128 → 124 BPM · blended by volume (no beat-matching on full songs)"
 * @property {number} tStart    set time of the first audible change
 * @property {number} tEnd      set time the incoming is solo at full volume (outgoing at 0)
 * @property {number} leaveAt   outgoing song position at tStart (0 … durationS)
 * @property {number} incAt     incoming song position it is started from (0)
 * @property {number} incStart  set time to call the incoming deck's play() (volume 0 until its lane rises)
 * @property {{t:number, v:number}[]} outVol   outgoing volume breakpoints: starts at (tStart, 1), reaches 0 by tEnd
 * @property {{t:number, v:number}[]} incVol   incoming volume breakpoints: starts at (incStart, 0), reaches 1 by tEnd
 * @property {({kind:'riser', t:number, dur:number, gain:number}|{kind:'impact', t:number, gain:number})[]} fx
 * @property {{t:number, label:string}[]} marks   ticker moments
 * @property {number} beats     nominal length in beats of the outgoing tempo, 0 when sized in seconds
 */

function side(s, defDur) {
  const o = s && typeof s === 'object' ? s : {};
  const durationS = fin(o.durationS) && o.durationS > 0 ? o.durationS : defDur;
  const trusted = fin(o.bpm) && o.bpm >= 40 && o.bpm <= 260 && fin(o.bpmConfidence) && o.bpmConfidence >= TRUST;
  return {
    id: o.id,
    durationS,
    bpm: trusted ? o.bpm : null,
    beat: trusted ? 60 / o.bpm : null,
    energy: fin(o.energy) ? clamp(o.energy, 0, 1) : null,
    provider: o.provider === 'preview' ? 'preview' : 'youtube',
  };
}

/** Defensive copy of the input with every default filled in; nothing downstream sees a NaN. */
function norm(input) {
  const i = input && typeof input === 'object' ? input : {};
  const o = i.out && typeof i.out === 'object' ? i.out : {};
  const quick = !!i.quick;
  const startedAt = fin(o.startedAt) ? o.startedAt : fin(i.earliest) ? i.earliest : 0;
  return {
    seed: i.seed == null ? '' : String(i.seed),
    vibe: fin(i.vibe) ? clamp(i.vibe, 0, 1) : 0.5,
    mode: VIDEO_MODES.includes(i.mode) ? i.mode : 'medium',
    playIndex: fin(i.playIndex) ? Math.max(0, Math.floor(i.playIndex)) : 0,
    prevType: typeof i.prevType === 'string' ? i.prevType : null,
    quick,
    reason: i.reason === 'newset' ? 'newset' : 'skip',
    // Without an `earliest` nothing constrains the natural plan; a Skip without one means "now" = startedAt.
    earliest: fin(i.earliest) ? i.earliest : quick ? startedAt : -Infinity,
    startedAt,
    out: side(o, DEFAULT_DURATION_S),
    inc: side(i.inc, null),
    force: typeof i.force === 'string' && VIDEO_TYPES.includes(i.force) ? i.force : null,
  };
}

/**
 * How long a move may run: a blend should not eat more than ~40 % of either song (35 % of a
 * 30-second clip, which also keeps long blends off clips altogether); a drop only uses the outgoing.
 */
function capsOf(N) {
  const share = (s) => (s.provider === 'preview' ? 0.35 : 0.4);
  return {
    out: share(N.out) * N.out.durationS,
    inc: N.inc.durationS ? share(N.inc) * N.inc.durationS : Infinity,
  };
}
const capFor = (type, caps) => (OVERLAP[type] ? Math.min(caps.out, caps.inc) : caps.out);

/** Below "club" the percussive moves thin out: almost nothing at vibe 0, all there from 0.25 up. */
const hardness = (v) => clamp(v / 0.25, 0.02, 1);

/** Relative odds of each move (0 = cannot be built here). */
function typeWeights(N, caps) {
  const v = N.vibe;
  const s = 1 - v;
  const M = MODE_BIAS[N.mode];
  const hard = hardness(v);
  /** @type {Record<string, number>} */
  const w = {
    longBlend: (0.25 + 1.5 * s) * M.longBlend,
    crossfade: (0.6 + 0.5 * s) * M.crossfade,
    fadeDrop: (0.15 + 1.1 * v) * hard * M.fadeDrop,
    // A riser is a build-up gesture: not on a smooth set at all.
    riserDrop: v >= 0.3 ? (0.4 + 1.6 * (v - 0.3)) * M.riserDrop : 0,
    cut: (0.05 + v * v) * hard * M.cut,
  };
  // Energy arc, when both songs were analysed: a lift is announced (drops), a come-down is eased (long blend).
  if (N.out.energy !== null && N.inc.energy !== null) {
    const d = N.inc.energy - N.out.energy;
    if (d > 0.12) {
      const k = Math.min(2, 1 + 3 * (d - 0.12));
      w.fadeDrop *= k;
      w.riserDrop *= k;
      w.longBlend *= 0.8;
    } else if (d < -0.12) {
      const k = Math.min(2, 1 + 2 * (-d - 0.12));
      w.longBlend *= k;
      w.fadeDrop *= 0.7;
      w.riserDrop *= 0.7;
    }
  }
  for (const t of VIDEO_TYPES) {
    if (t === N.prevType) w[t] *= REPEAT_PENALTY;
    if (LENGTHS[t][0] > capFor(t, caps)) w[t] = 0;
  }
  if (!VIDEO_TYPES.some((t) => w[t] > 0)) w.cut = 1; // a few-second "song": only a cut fits
  return w;
}

/** A length near `target` within [lo, hi]; whole bars of the outgoing tempo when it is trusted. */
function fitBars(target, lo, hi, beat) {
  if (!(hi >= lo)) hi = lo; // only a forced move (tests) gets here: keep its minimum
  const t = clamp(target, lo, hi);
  if (beat) {
    const bar = 4 * beat;
    const nLo = Math.max(1, Math.ceil(lo / bar - 1e-9));
    const nHi = Math.floor(hi / bar + 1e-9);
    if (nLo <= nHi) {
      const n = clamp(Math.round(t / bar), nLo, nHi);
      return { len: n * bar, beats: 4 * n };
    }
  }
  return { len: t, beats: 0 };
}

/** Length of a move in seconds (+ its beat count when sized in beats). Always draws two numbers. */
function chooseLen(type, N, r, cap, quick) {
  const v = N.vibe;
  const beat = N.out.beat;
  const u1 = r.next();
  const u2 = r.next();
  switch (type) {
    case 'longBlend': {
      const [lo, hi] = { full: [16, 24], medium: [13, 21], short: [12, 17] }[N.mode];
      // smoother sets let the two songs ride together longer
      return fitBars(lo + (hi - lo) * u1 * (1 - 0.4 * v), LENGTHS.longBlend[0], Math.min(LENGTHS.longBlend[1], cap), beat);
    }
    case 'crossfade': {
      if (quick) {
        const [lo, hi] = LENGTHS.quickCrossfade;
        return { len: clamp(lo + (hi - lo) * u1, lo, Math.max(lo, Math.min(hi, cap))), beats: 0 };
      }
      const [lo, hi] = { full: [6, 10], medium: [5, 9], short: [4, 7] }[N.mode];
      return fitBars(lo + (hi - lo) * u1, LENGTHS.crossfade[0], Math.min(LENGTHS.crossfade[1], cap), beat);
    }
    case 'fadeDrop': {
      let res;
      if (beat) {
        // two beats of fade, unless that is far from the ~1.5 s gesture (very slow / very fast tempos)
        const n = 2 * beat < 0.8 ? 4 : 2 * beat > 2.5 ? 1 : 2;
        res = { len: n * beat, beats: n };
      } else res = { len: 1.2 + 0.6 * u1, beats: 0 };
      if (res.len > cap && cap >= LENGTHS.fadeDrop[0]) res = { len: cap, beats: 0 };
      return res;
    }
    case 'riserDrop': {
      let res = null;
      if (beat) {
        const fits = [4, 8].filter((n) => n * beat >= LENGTHS.riserDrop[0] && n * beat <= LENGTHS.riserDrop[1]);
        if (fits.length) {
          const n = fits.length === 2 ? (u1 < 0.45 + 0.2 * v ? 8 : 4) : fits[0];
          res = { len: n * beat, beats: n };
        }
      }
      if (!res) res = { len: 2.5 + 2.5 * u2, beats: 0 };
      if (res.len > cap && cap >= LENGTHS.riserDrop[0]) res = { len: cap, beats: 0 };
      return res;
    }
    default:
      return { len: LENGTHS.cut[0] + (LENGTHS.cut[1] - LENGTHS.cut[0]) * u1, beats: 0 };
  }
}

/**
 * Song position of tStart in the natural plan. Draws its own numbers (same three every time), so the
 * spread / guard of a play do not depend on which move was chosen — only the move's length does.
 */
function naturalLeave(N, r, len) {
  const uSpread = r.next();
  const uGuard = r.next();
  const uPrev = r.next();
  const D = N.out.durationS;
  const bar = N.out.beat ? 4 * N.out.beat : 0;
  const snapDown = (x) => (bar ? Math.floor(x / bar) * bar : x);
  let P;
  if (N.out.provider === 'preview') {
    // The 30-second fallback clip is used whole, like preview mode: left near its own end. Not
    // bar-snapped: a clip starts mid-song, so "bars from position 0" would mean nothing.
    P = D - len - (PREVIEW_GUARD_S[0] + (PREVIEW_GUARD_S[1] - PREVIEW_GUARD_S[0]) * uPrev);
  } else {
    // Short songs get a proportionally shorter outro guard (a 60-second track has no 20-second outro).
    const cap = 0.08 * D + 4;
    const guard = Math.min(GUARD_S[0] + (GUARD_S[1] - GUARD_S[0]) * uGuard, cap);
    let tail = D - guard - len;
    if (bar) {
      // Nearest bar, then one bar back into the guard's range if that pushed it out (the range is 12 s
      // wide, a bar at most 6 s), so the guard stays spread evenly over 8–20 s.
      tail = Math.round(tail / bar) * bar;
      const g = D - len - tail;
      if (g > Math.min(GUARD_S[1], cap) + 1e-9) tail += bar;
      else if (g < Math.min(GUARD_S[0], cap) - 1e-9) tail -= bar;
    }
    if (N.mode === 'full') P = tail;
    else {
      const T = TARGET_S[N.mode] * (1 - TARGET_SPREAD + 2 * TARGET_SPREAD * uSpread);
      P = Math.min(bar ? Math.round(T / bar) * bar : T, tail);
    }
  }
  const limit = D - len - END_MARGIN_S;
  if (P > limit) P = snapDown(limit);
  return P > 0 ? P : 0;
}

/** The natural move for this hand-over: type, length and where the outgoing is left. */
function decide(N, root, caps) {
  const w = typeWeights(N, caps);
  const type = N.force || root.fork('type').weighted(VIDEO_TYPES, VIDEO_TYPES.map((t) => w[t]));
  const { len, beats } = chooseLen(type, N, root.fork(`len|${type}`), capFor(type, caps), false);
  return { type, len, beats, P: naturalLeave(N, root.fork('leave'), len) };
}

/** Seconds after tStart at which the incoming's volume first rises. */
const riseOffset = (type, len) => (type === 'fadeDrop' || type === 'riserDrop' ? Math.max(0, len - VOL_STEP_S) : 0);

/** Earliest tStart for a move: tStart ≥ earliest and the incoming's play() (rise − lead) ≥ earliest. */
const minStart = (N, type, len) => Math.max(N.earliest, N.earliest + PLAY_LEAD_S - riseOffset(type, len));

/**
 * The natural moment has passed (or this is a Skip): start as early as allowed and keep the move if
 * the outgoing song still has room for it, squeeze it, or step down the chain; when not even a cut
 * fits, the song is over (or in its last second) and the incoming simply comes in.
 */
function lateStart(N, root, caps, chain, first) {
  const D = N.out.durationS;
  for (const tp of chain) {
    let pick = first && tp === first.type ? first : null;
    if (!pick) {
      // a step down the chain must suit the songs as well as the clock (no 4-second fade over a 5-second clip)
      const cap = capFor(tp, caps);
      if (tp !== 'cut' && LATE_MIN[tp] > cap) continue;
      pick = chooseLen(tp, N, root.fork(`len|${tp}`), cap, false);
      if (pick.len > cap) pick = { len: cap, beats: 0 };
    }
    const tS = minStart(N, tp, pick.len);
    const pos = Math.max(0, tS - N.startedAt);
    const room = D - END_MARGIN_S - pos;
    if (pick.len <= room) return { type: tp, len: pick.len, beats: pick.beats, tS, leave: pos, note: '' };
    if (room >= LATE_MIN[tp]) return { type: tp, len: room, beats: 0, tS: minStart(N, tp, room), leave: pos, note: 'shortened, the song was ending' };
  }
  const { len } = chooseLen('cut', N, root.fork('len|cut'), Infinity, false);
  const tS = minStart(N, 'cut', len);
  const pos = tS - N.startedAt;
  return { type: 'cut', len, beats: 0, tS, leave: clamp(pos, 0, D), note: pos >= D ? 'previous song had ended' : 'previous song was ending' };
}

/** Bounded equal-power pair at position u ∈ [0, 1] (shared by both lanes, so their sum stays ≤ XF_PEAK). */
const xfOut = (u) => Math.pow(Math.cos((u * Math.PI) / 2), XF_K);
const xfIn = (u) => Math.pow(Math.sin((u * Math.PI) / 2), XF_K);

/** Impact level: ~0.27–0.42 for a song that enters at full level, smaller over a quiet start. */
function impactGain(r, lo, hi, inc) {
  // A full song enters at its very start — usually an intro a few dB under its loud parts. The energy
  // of its preview says how loud the song is overall; the first 3 dB under full are ordinary dynamics,
  // beyond that the boom follows the entry down (as transitions.js impactGain does with a known level).
  const e = inc.energy === null ? 0.5 : inc.energy;
  const entryDb = -6 + 6 * (e - 0.5);
  const under = clamp(-entryDb - 3, 0, 15);
  return r.range(lo, hi) * Math.pow(10, (-0.7 * under) / 20);
}

/** Volume lanes, fx and marks of one move starting at tS, `len` seconds long. */
function build(type, tS, len, N, r) {
  const tE = tS + len;
  /** @type {{t:number, v:number}[]} */
  const outVol = [];
  /** @type {{t:number, v:number}[]} */
  const incVol = [];
  const fx = [];
  const marks = [];
  const dropIn = () => {
    incVol.push({ t: tE - VOL_STEP_S - PLAY_LEAD_S, v: 0 }, { t: tE - VOL_STEP_S, v: 0 }, { t: tE, v: 1 });
  };
  switch (type) {
    case 'longBlend':
    case 'crossfade': {
      // The long blend's crossover point is seeded (γ < 1: the incoming takes over early, > 1: the
      // outgoing outro holds on). Both lanes share every breakpoint time and the same u, so their sum is
      // the linear interpolation of breakpoint sums — never above XF_PEAK.
      const gamma = type === 'longBlend' ? r.range(0.85, 1.25) : 1;
      const n = clamp(Math.round(len / 1.5), 6, 16);
      incVol.push({ t: tS - PLAY_LEAD_S, v: 0 });
      for (let i = 0; i <= n; i++) {
        const x = i / n;
        const u = Math.pow(x, gamma);
        const t = i === n ? tE : tS + len * x;
        outVol.push({ t, v: i === 0 ? 1 : i === n ? 0 : xfOut(u) });
        incVol.push({ t, v: i === 0 ? 0 : i === n ? 1 : xfIn(u) });
      }
      marks.push({ t: tS, label: type === 'longBlend' ? 'Long blend' : 'Crossfade' }, { t: tE, label: 'Mix out' });
      break;
    }
    case 'fadeDrop': {
      // The outgoing closes on a quarter cosine (gentle start, fast finish); the next song lands on the end.
      const n = 6;
      for (let i = 0; i <= n; i++) outVol.push({ t: i === n ? tE : tS + (len * i) / n, v: i === n ? 0 : Math.cos((i / n) * (Math.PI / 2)) });
      dropIn();
      fx.push({ kind: 'impact', t: tE, gain: impactGain(r, 0.3, 0.42, N.inc) });
      marks.push({ t: tS, label: 'Fade out' }, { t: tE, label: 'Drop' });
      break;
    }
    case 'riserDrop': {
      const taper = r.range(0.45, 0.6);
      const beat = N.out.beat;
      // Sometimes the outgoing is pulled half a beat early: a breath of air before the drop.
      const gapOk = beat && len >= 4 * beat - 1e-9;
      const wantGap = r.next() < 0.3 + 0.3 * N.vibe;
      let tCut = gapOk && wantGap ? tE - beat / 2 : tE;
      const tHold = tS + 0.25 * len;
      if (!(tCut - VOL_STEP_S > tHold)) tCut = tE;
      fx.push({ kind: 'riser', t: tS, dur: len, gain: r.range(RISER_GAIN[0], RISER_GAIN[1]) });
      outVol.push({ t: tS, v: 1 }, { t: tHold, v: 1 }, { t: tCut - VOL_STEP_S, v: taper }, { t: tCut, v: 0 });
      dropIn();
      fx.push({ kind: 'impact', t: tE, gain: impactGain(r, 0.3, 0.42, N.inc) });
      marks.push({ t: tS, label: 'Riser' }, { t: tE, label: 'Drop' });
      break;
    }
    default: {
      // cut: a swap within one or two volume ticks
      outVol.push({ t: tS, v: 1 }, { t: tE, v: 0 });
      incVol.push({ t: tS - PLAY_LEAD_S, v: 0 }, { t: tS, v: 0 }, { t: tE, v: 1 });
      if (r.next() < (0.2 + 0.5 * N.vibe) * hardness(N.vibe)) fx.push({ kind: 'impact', t: tE, gain: impactGain(r, 0.27, 0.39, N.inc) });
      marks.push({ t: tE, label: 'Cut' });
    }
  }
  return { tE, outVol, incVol, fx, marks };
}

const fmtSec = (s) => {
  const r = Math.round(s * 10) / 10;
  return `${r >= 10 || Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(1)} s`;
};

function labelOf(type, len, beats) {
  if (type === 'cut') return NAMES.cut;
  // Drops are gestures counted in beats when the tempo is known; blends are volume rides, said in seconds.
  if ((type === 'fadeDrop' || type === 'riserDrop') && beats > 0) return `${NAMES[type]} · ${beats} ${beats === 1 ? 'beat' : 'beats'}`;
  return `${NAMES[type]} · ${fmtSec(len)}`;
}

const HOW = {
  longBlend: 'blended by volume',
  crossfade: 'blended by volume',
  fadeDrop: 'faded out, next song dropped in',
  riserDrop: 'riser, next song dropped in',
  cut: 'hard cut',
};

function whyOf(N, type, note) {
  const yt = (s) => s.provider !== 'preview';
  const head = yt(N.out) && yt(N.inc) ? 'Full songs' : !yt(N.out) && !yt(N.inc) ? 'Preview clips' : yt(N.out) ? 'Full song → preview clip' : 'Preview clip → full song';
  const a = N.out.bpm;
  const b = N.inc.bpm;
  const r = (x) => Math.round(x);
  // Only tempos the analysis vouches for are named; nothing here is beat-matched either way.
  const tempo = a && b ? `${r(a)} → ${r(b)} BPM` : a ? `${r(a)} BPM → tempo unknown` : b ? `tempo unknown → ${r(b)} BPM` : 'tempos unknown';
  const tail = yt(N.out) || yt(N.inc) ? '(no beat-matching on full songs)' : '(volume only, no beat-matching)';
  return [head, tempo, `${HOW[type]} ${tail}`, note].filter(Boolean).join(' · ');
}

/**
 * Song position where the outgoing track is left in this mode (= the natural plan's `leaveAt`): short ≈
 * 45 s and medium ≈ 90 s (seeded ±12 %, whole bars from the song start when the tempo is trusted),
 * full = the end minus a seeded outro guard (8–20 s) minus the move's length; never later than
 * durationS − length − 1; a 30-second fallback clip ('preview') is left 1–2.5 s before its end.
 *
 * Takes the same input as planVideoTransition (`earliest` and `quick` are ignored). With the same
 * input, it equals planVideoTransition(input).leaveAt whenever that plan is not late or a Skip. `inc`
 * may be left out before the next song is known; in full mode the estimate can then differ by the
 * length of the move the incoming song ends up getting (its energy and length shape that choice).
 * @param {VideoInput} input
 * @returns {number}
 */
export function leavePoint(input) {
  const N = norm(input);
  return decide(N, createRng(`${N.seed}|video|${N.playIndex}`), capsOf(N)).P;
}

/**
 * Plan the hand-over from the playing full song to the next one (SPEC 6.4). See VideoTransition.
 * @param {VideoInput} input
 * @returns {VideoTransition}
 */
export function planVideoTransition(input) {
  const N = norm(input);
  const root = createRng(`${N.seed}|video|${N.playIndex}`);
  const caps = capsOf(N);
  /** @type {{type:string, len:number, beats:number, tS:number, leave:number, note:string}} */
  let plan;
  if (N.quick) {
    // Skip (or New Set): an immediate, deliberate exit — a short crossfade, or a cut on a wilder set.
    const types = ['crossfade', 'cut'];
    const xfOk = capFor('crossfade', caps) >= LENGTHS.quickCrossfade[0];
    const w = [xfOk ? 1 : 0, (0.15 + 1.2 * N.vibe) * hardness(N.vibe)].map((x, k) => (types[k] === N.prevType ? x * REPEAT_PENALTY : x));
    const type = N.force && types.includes(N.force) ? N.force : root.fork('quick').weighted(types, w);
    const first = { type, ...chooseLen(type, N, root.fork(`qlen|${type}`), capFor(type, caps), true) };
    plan = lateStart(N, root, caps, type === 'crossfade' ? ['crossfade', 'cut'] : ['cut'], first);
    // a squeezed Skip crossfade is still a Skip crossfade
    if (plan.note === 'shortened, the song was ending') plan.note = '';
    const tag = N.reason === 'newset' ? 'new set' : 'skipped';
    plan.note = plan.note ? `${tag} · ${plan.note}` : tag;
  } else {
    const d = decide(N, root, caps);
    const tNat = N.startedAt + d.P;
    if (tNat >= minStart(N, d.type, d.len)) plan = { type: d.type, len: d.len, beats: d.beats, tS: tNat, leave: d.P, note: '' };
    else {
      plan = lateStart(N, root, caps, FALLBACK[d.type], d);
      if (!plan.note) plan.note = 'later than planned';
    }
  }
  const { type, len, beats, tS, leave, note } = plan;
  const b = build(type, tS, len, N, root.fork(`shape|${type}`));
  return {
    type: /** @type {VideoTransition['type']} */ (type),
    label: labelOf(type, len, beats),
    why: whyOf(N, type, note),
    tStart: tS,
    tEnd: b.tE,
    leaveAt: leave,
    incAt: 0,
    incStart: b.incVol[0].t,
    outVol: b.outVol,
    incVol: b.incVol,
    fx: b.fx,
    marks: b.marks,
    beats,
  };
}

/**
 * Volume of a breakpoint lane at set time t (linear between points, held before the first and after
 * the last) — what the deck driver applies on each ≈ 20 Hz tick.
 * @param {{t:number, v:number}[]} points
 * @param {number} t
 * @returns {number}
 */
export function volumeAt(points, t) {
  if (!points || !points.length) return 0;
  if (!(t > points[0].t)) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (t < p.t) {
      const q = points[i - 1];
      return q.v + ((p.v - q.v) * (t - q.t)) / (p.t - q.t);
    }
  }
  return points[points.length - 1].v;
}

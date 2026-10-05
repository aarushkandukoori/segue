// The transition recipe library: how each kind of DJ move is written as automation.
// Pure data-in / data-out. A recipe receives a context (beat clock of the outgoing track, two strip
// "lanes", the FX-bus lane, a seeded RNG) and fills in events; the planner decides which recipe, where
// and how long. Semantics of every event are those of timeline.evalParam / AudioParam scheduling.

/** Strip params and their resting values (SPEC "Strip signal path and params"). */
export const STRIP_DEFAULTS = Object.freeze({
  gain: 1,
  src: 1,
  low: 0,
  mid: 0,
  high: 0,
  hpf: 20,
  lpf: 20000,
  delaySend: 0,
  reverbSend: 0,
});

/** FX-bus params and their resting values. */
export const FX_DEFAULTS = Object.freeze({ delayTime: 0.375, delayFeedback: 0.5, fxReturn: 1 });

/** Legal range of every param; lanes clamp into it so a recipe can never emit an illegal value. */
export const PARAM_RANGE = Object.freeze({
  gain: [0, 1],
  src: [0, 1],
  low: [-40, 6],
  mid: [-40, 6],
  high: [-40, 6],
  hpf: [20, 20000],
  lpf: [20, 20000],
  delaySend: [0, 1],
  // The engine's reverb returns about 8 dB under its input (measured), so a wash needs a send above 1.
  reverbSend: [0, 1.5],
  delayTime: [0.02, 1],
  delayFeedback: [0, 0.85],
  fxReturn: [0, 1],
});

export const KILL_DB = -28;
/** Length of a "hard" fader cut. Long enough not to click, short enough to read as a cut. */
export const CUT_S = 0.01;
/** A track that drops in on the one starts this much early under a micro fade, so its first transient is intact. */
export const PREROLL_S = 0.006;
/**
 * An incoming strip's initial `set`s are placed this long BEFORE its play.startAt. The engine starts
 * a source up to 4 ms early under a declick ramp; without this the fader would still be at its
 * default (1) during that pre-roll and a track entering at gain 0 would tick (measured in Chrome).
 */
export const INIT_LEAD_S = 0.008;
/** Slowest rate a brake ramps to (rate must stay > 0). */
export const BRAKE_FLOOR = 0.03;
/**
 * After a play goes solo, the shared delay bus may still be ringing / resetting from the transition
 * that brought it in. Every delay-bus use finishes (reset included) within this many seconds of the
 * incoming play's soloFrom, and nothing else touches the bus before then.
 */
export const FX_BUS_GUARD = 6;
/** A bass swap is complete this long before its downbeat (kick transients start a little ahead of the grid). */
export const SWAP_AHEAD_S = 0.02;
const MAX_DELAY_S = 0.9;
const MAX_TAIL_S = 4;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const FREQ = { hpf: true, lpf: true };
const dbToAmp = (db) => Math.pow(10, db / 20);
const ampToDb = (a) => 20 * Math.log10(Math.max(a, 1e-3));

/**
 * An automation lane: collects events for one strip (or the FX bus) while tracking each param's
 * current value, so recipes can say "ramp to X between t0 and t1" and always get a properly
 * anchored, in-range, time-ordered result.
 * @param {Record<string, number>} defaults
 */
export function createLane(defaults) {
  /** @type {{p:string,t:number,v:number,k:'set'|'lin'|'exp'}[]} */
  const events = [];
  const cur = { ...defaults };
  /** @type {Record<string, number>} */
  const last = {};
  const push = (p, t, v, k) => {
    if (!Number.isFinite(t) || !Number.isFinite(v)) throw new RangeError(`bad automation ${p} t=${t} v=${v}`);
    const r = PARAM_RANGE[p];
    v = clamp(v, r[0], r[1]);
    if (last[p] !== undefined && t < last[p]) t = last[p]; // never go back in time on a param
    events.push({ p, t, v, k });
    last[p] = t;
    cur[p] = v;
  };
  const lane = {
    events,
    /** Current (last scheduled) value of a param. */
    value: (p) => cur[p],
    /** Time of the last event on a param, or -Infinity. */
    lastTime: (p) => (last[p] === undefined ? -Infinity : last[p]),
    /** `set` every param at t (defaults overridden by `over`). The anchor for everything that follows. */
    init(t, over = {}) {
      for (const p of Object.keys(defaults)) push(p, t, over[p] ?? defaults[p], 'set');
      return lane;
    },
    set(p, t, v) {
      push(p, t, v, 'set');
      return lane;
    },
    /** Hold the current value until t0, then ramp to v at t1. Frequencies ramp exponentially. */
    ramp(p, t0, t1, v, kind) {
      const k = kind || (FREQ[p] ? 'exp' : 'lin');
      if (!(t1 > t0)) {
        push(p, Math.max(t0, t1), v, 'set');
        return lane;
      }
      if (last[p] !== t0) push(p, t0, cur[p], 'set');
      push(p, t1, v, k);
      return lane;
    },
    /**
     * Equal-power-ish fader move approximated with linear segments.
     * shape 'in': fast start, gentle landing (sin) — for opening a fader.
     * shape 'out': gentle start, fast finish (cos) — for closing one.
     */
    fade(p, t0, t1, v, shape = 'in', steps = 6) {
      if (!(t1 > t0)) {
        push(p, Math.max(t0, t1), v, 'set');
        return lane;
      }
      if (last[p] !== t0) push(p, t0, cur[p], 'set');
      const from = cur[p];
      for (let i = 1; i <= steps; i++) {
        const x = i / steps;
        const g = shape === 'in' ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
        push(p, t0 + (t1 - t0) * x, i === steps ? v : from + (v - from) * g, 'lin');
      }
      return lane;
    },
    /**
     * Equal-power move of an EQ band (value in dB): the band's amplitude follows a quarter sine.
     * Two bands crossfading against each other this way (one opening, one closing) keep their summed
     * power, where two straight dB ramps would sag by 8 dB or more in the middle.
     */
    eq(p, t0, t1, db, steps = 6) {
      if (!(t1 > t0)) {
        push(p, Math.max(t0, t1), db, 'set');
        return lane;
      }
      if (last[p] !== t0) push(p, t0, cur[p], 'set');
      const a0 = dbToAmp(cur[p]);
      const a1 = dbToAmp(db);
      for (let i = 1; i <= steps; i++) {
        const x = i / steps;
        const g = a1 > a0 ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
        push(p, t0 + (t1 - t0) * x, i === steps ? db : ampToDb(a0 + (a1 - a0) * g), 'lin');
      }
      return lane;
    },
  };
  return lane;
}

/**
 * The low end changes hands: the outgoing bass goes out as the incoming one comes up, crossing at
 * −8 dB each (never two full basses at once) and finished at tDone.
 */
function swapBass(A, B, t0, tDone) {
  const tMid = (t0 + tDone) / 2;
  A.ramp('low', t0, tMid, -8).ramp('low', tMid, tDone, KILL_DB);
  B.ramp('low', t0, tMid, -8).ramp('low', tMid, tDone, 0);
}

/**
 * Recipe context.
 * @typedef {Object} Ctx
 * @property {(k:number)=>number} at   set time of the outgoing track's beat k (0 = transition start, fractional ok)
 * @property {number} L                length in beats
 * @property {number} tS               at(0)
 * @property {number} X                at(L): the line the incoming track owns from
 * @property {number} beatSec          seconds per outgoing beat (set time) around the transition
 * @property {number} bStart           set time the incoming source starts
 * @property {number} bInit            set time of the incoming strip's initial sets (bStart − INIT_LEAD_S)
 * @property {number} pre              pre-roll seconds for drop-ins (0 if none)
 * @property {import('../util/rng.js').Rng} rng
 * @property {number} vibe
 * @property {ReturnType<typeof createLane>} A    outgoing strip
 * @property {ReturnType<typeof createLane>} B    incoming strip
 * @property {ReturnType<typeof createLane>} bus  FX bus
 * @property {object[]} fx
 * @property {{t:number,v:number,ramp?:boolean}[]} aRate
 * @property {{t:number,label:string}[]} marks
 * @property {{id:number, pos:(k:number)=>number, beatLen:number, rate:(t:number)=>number}} out   outgoing play: buffer position of beat k, beat length in buffer seconds, rate at t
 */

/** Incoming track owns the mix from X: full level on its downbeat (under a micro fade if pre-rolled). */
function dropIn(c, over = {}) {
  if (c.pre > 0) {
    c.B.init(c.bInit, { ...over, gain: 0 });
    c.B.ramp('gain', c.bStart, c.X, 1);
  } else {
    c.B.init(c.bInit, over);
  }
}

/** Hard fader cut that lands exactly on t. */
function cutAt(lane, t) {
  lane.ramp('gain', t - CUT_S, t, 0);
}

/** A beat fraction that fits the delay line (long beats fall back to shorter fractions). */
function delayTimeFor(beatSec, frac) {
  let d = beatSec * frac;
  if (d > MAX_DELAY_S) d = beatSec * 0.5;
  if (d > MAX_DELAY_S) d = beatSec * 0.25;
  return clamp(d, 0.05, MAX_DELAY_S);
}

/**
 * Take the delay bus for one echo: configure it just before `tOpen`, let the tail ring until
 * `tTailEnd` (return fades over its second half), then empty the line and put every bus param back
 * to its default. Returns the set time at which the bus is free again.
 */
export function useDelayBus(bus, tOpen, tCut, tTailEnd, delayTime, feedback) {
  const t0 = tOpen - 0.03;
  bus.set('delayTime', t0, delayTime).set('delayFeedback', t0, feedback).set('fxReturn', t0, 1);
  const tEnd = Math.max(tTailEnd, tCut + 0.1);
  bus.ramp('fxReturn', tCut + (tEnd - tCut) / 2, tEnd, 0);
  // With the feedback at 0 and no input the line is empty one delay time later; only then is it
  // safe to restore the return and the time without replaying or pitch-smearing stale echoes.
  bus.set('delayFeedback', tEnd, 0);
  const tFree = tEnd + delayTime + 0.05;
  bus.set('delayTime', tFree, FX_DEFAULTS.delayTime);
  bus.set('delayFeedback', tFree, FX_DEFAULTS.delayFeedback);
  bus.set('fxReturn', tFree, FX_DEFAULTS.fxReturn);
  return tFree;
}

// ───────────────────────────── recipes ─────────────────────────────

/** Bass swap: incoming rides in bass-less, the low end changes hands on a downbeat, outgoing peels away. */
function bassSwap(c) {
  const { A, B, at, L, rng } = c;
  // Swap on a downbeat inside the blend; usually the middle, sometimes early or late for variety.
  const sw = L >= 16 ? rng.weighted([L / 2, L / 4, (3 * L) / 4], [0.7, 0.15, 0.15]) : L / 2;
  B.init(c.bInit, { gain: 0, low: KILL_DB });
  B.fade('gain', at(0), at(Math.max(0.5, sw - 1)), 0.85, 'in');
  // The swap takes the half beat BEFORE the downbeat (the gap between two kicks) and is done a
  // moment ahead of it, so the incoming kick owns the one at full weight.
  swapBass(A, B, at(sw - 0.5), at(sw) - SWAP_AHEAD_S);
  B.ramp('gain', at(sw), at(Math.min(L, sw + 2)), 1);
  const rest = L - sw;
  A.ramp('high', at(sw), at(L - Math.min(0.5, rest / 4)), -12);
  A.ramp('mid', at(sw), at(L - Math.min(0.5, rest / 4)), -9);
  A.fade('gain', at(sw + rest * 0.35), at(L), 0, 'out');
  c.marks.push({ t: at(0), label: 'Mix in' }, { t: at(sw), label: 'Bass swap' }, { t: at(L), label: 'Mix out' });
}

/** EQ blend: three-band crossfade, highs first, then mids, bass last (handed over, never doubled). */
function eqBlend(c) {
  const { A, B, at, L } = c;
  // The bass is handed over last, across the beats leading into the three-quarter line (a bar line
  // in 16- and 32-beat blends); with the kicks aligned, −8 dB each sums to about one full bass.
  const lowX = 0.75 * L;
  const lowW = Math.min(2, L / 4);
  B.init(c.bInit, { gain: 0, low: KILL_DB, mid: -15, high: -20 });
  B.fade('gain', at(0), at(0.3 * L), 1, 'in');
  A.eq('high', at(0.1 * L), at(0.45 * L), -22);
  B.eq('high', at(0.1 * L), at(0.45 * L), 0);
  A.eq('mid', at(0.35 * L), at(0.7 * L), -16);
  B.eq('mid', at(0.35 * L), at(0.7 * L), 0);
  swapBass(A, B, at(lowX - lowW), at(lowX) - SWAP_AHEAD_S);
  A.fade('gain', at(lowX), at(L), 0, 'out');
  c.marks.push(
    { t: at(0), label: 'Mix in' },
    { t: at(0.1 * L), label: 'Highs' },
    { t: at(0.35 * L), label: 'Mids' },
    { t: at(lowX - lowW), label: 'Bass' },
    { t: at(L), label: 'Mix out' },
  );
}

/** Filter blend: outgoing is swept away by a rising high-pass while the incoming opens up from a low-pass. */
function filterBlend(c) {
  const { A, B, at, L, rng } = c;
  const top = rng.range(5000, 9000);
  B.init(c.bInit, { gain: 0, low: KILL_DB, lpf: rng.range(220, 420) });
  B.fade('gain', at(0), at(0.5 * L), 1, 'in');
  B.ramp('lpf', at(0), at(0.75 * L), 20000);
  // The outgoing bass is gone (cutoff past the kick) before the incoming bass is let in.
  A.ramp('hpf', at(0), at(0.34 * L), 170)
    .ramp('hpf', at(0.34 * L), at(0.5 * L), 420)
    .ramp('hpf', at(0.5 * L), at(L), top);
  B.ramp('low', at(0.34 * L), at(0.5 * L), 0);
  const lastBeat = L - Math.min(1, L / 4);
  A.ramp('gain', at(0.5 * L), at(lastBeat), 0.8);
  A.ramp('gain', at(lastBeat), at(L), 0);
  c.marks.push({ t: at(0), label: 'Filter sweep' }, { t: at(0.42 * L), label: 'Bass in' }, { t: at(L), label: 'Mix out' });
}

/** Echo out: last beat(s) feed the delay, fader is cut on the bar line, incoming starts on its own one. */
function echoOut(c) {
  const { A, at, L, X, rng } = c;
  const dT = delayTimeFor(c.beatSec, rng.pick([0.75, 0.75, 0.5]));
  const fb = rng.range(0.6, 0.75);
  const send = rng.range(0.45, 0.6);
  const tailBeats = rng.pick([4, 6, 8]);
  const thin = L >= 2 && rng.next() < 0.5;
  A.ramp('delaySend', at(0), at(Math.min(0.5, L / 2)), send);
  if (thin) A.ramp('hpf', at(0), at(L), rng.range(250, 500));
  cutAt(A, X);
  dropIn(c);
  const tailEnd = X + Math.min(tailBeats * c.beatSec, MAX_TAIL_S);
  useDelayBus(c.bus, at(0), X, tailEnd, dT, fb);
  c.marks.push({ t: at(0), label: 'Echo out' }, { t: X, label: 'Drop in' });
}

/** Reverb wash: outgoing dissolves into the reverb under a closing low-pass; incoming rises underneath. */
function reverbWash(c) {
  const { A, B, at, L, rng } = c;
  B.init(c.bInit, { gain: 0, low: KILL_DB });
  A.ramp('reverbSend', at(0), at(0.35 * L), rng.range(0.9, 1.2));
  A.ramp('lpf', at(0.1 * L), at(0.85 * L), rng.range(500, 900));
  // The two kicks are not in time with each other, so the bass is handed over in one short move in
  // the middle rather than left to overlap — or to leave a hole.
  swapBass(A, B, at(0.35 * L), at(0.55 * L));
  A.ramp('gain', at(0.3 * L), at(0.65 * L), 0.6);
  A.fade('gain', at(0.65 * L), at(L), 0, 'out');
  B.fade('gain', at(0.1 * L), at(0.7 * L), 1, 'in');
  c.marks.push({ t: at(0), label: 'Reverb wash' }, { t: at(0.5 * L), label: 'Rising' }, { t: at(L), label: 'Mix out' });
}

/** Cut: hard switch on the downbeat, optionally teased by a short high-pass and stamped with an impact. */
function cut(c) {
  const { A, at, L, X, rng } = c;
  if (L > 0) {
    A.ramp('hpf', at(0), at(L), rng.range(700, 1600));
    c.marks.push({ t: at(0), label: 'Filter tease' });
  }
  cutAt(A, X);
  dropIn(c);
  if (rng.next() < 0.25 + 0.5 * c.vibe) c.fx.push({ kind: 'impact', t: X, gain: rng.range(0.45, 0.65) });
  c.marks.push({ t: X, label: 'Cut' });
}

/** Spinback: the record is yanked backwards and fades; incoming slams in on the bar line. */
function spinback(c) {
  const { A, at, L, X, rng } = c;
  const dur = X - c.tS;
  const offset = c.out.pos(0);
  const fast = rng.range(2.4, 3.4);
  const slow = rng.range(0.9, 1.3);
  // A record flicked backwards starts fast and loses speed as the fader comes down; now and then
  // play it the other way round, as a rewind that winds up into the drop.
  const windUp = rng.next() < 0.3;
  let r0 = windUp ? slow : fast;
  let r1 = windUp ? fast : slow;
  let len = (dur * (r0 + r1)) / 2;
  if (len > offset - 0.01) {
    // Not enough audio behind the needle: rewind slower rather than run off the start.
    const s = Math.max(0.02, offset - 0.01) / len;
    r0 *= s;
    r1 *= s;
    len *= s;
  }
  A.set('src', c.tS, 0);
  c.fx.push({ kind: 'reverse', playId: c.out.id, t: c.tS, dur, offset, len, rate0: r0, rate1: r1 });
  A.ramp('gain', at(L * 0.5), X, 0);
  dropIn(c);
  c.fx.push({ kind: 'impact', t: X, gain: rng.range(0.5, 0.7) });
  c.marks.push({ t: c.tS, label: 'Spinback' }, { t: X, label: 'Drop in' });
}

/** Brake: the outgoing deck is stopped like a turntable; incoming enters on the bar line. */
function brake(c) {
  const { A, at, L, X } = c;
  c.aRate.push({ t: c.tS, v: c.out.rate(c.tS) }, { t: X, v: BRAKE_FLOOR, ramp: true });
  A.ramp('gain', at(L * 0.45), X, 0);
  dropIn(c);
  c.marks.push({ t: c.tS, label: 'Brake' }, { t: X, label: 'Drop in' });
}

/** Loop roll: beat-repeat of the outgoing track's last bar, halving as it goes, under a rising high-pass. */
function loopRoll(c) {
  const { A, at, L, X, rng } = c;
  // [start beat, slice length in beats, repeats]
  const segs =
    L >= 8
      ? [[0, 1, 4], [4, 0.5, 4], [6, 0.25, 8]]
      : L >= 4
        ? [[0, 1, 2], [2, 0.5, 2], [3, 0.25, 4]]
        : L >= 2
          ? [[0, 0.5, 2], [1, 0.25, 4]]
          : [[0, 0.25, 4]];
  // The loop starts on exactly the audio the main source was about to play, so the hand-over is seamless.
  A.set('src', c.tS, 0);
  for (const [k, frac, reps] of segs) {
    const t = at(k);
    const dur = at(k + frac * reps) - t;
    const len = frac * c.out.beatLen;
    c.fx.push({ kind: 'loop', playId: c.out.id, t, dur, offset: c.out.pos(0), len, rate: (len * reps) / dur });
  }
  A.ramp('hpf', c.tS, X, rng.range(1200, 2600));
  cutAt(A, X);
  dropIn(c);
  if (rng.next() < 0.3 + 0.4 * c.vibe) c.fx.push({ kind: 'impact', t: X, gain: rng.range(0.45, 0.65) });
  c.marks.push({ t: c.tS, label: 'Loop roll' }, { t: X, label: 'Drop' });
}

/** Riser → drop: noise riser into the bar line while the outgoing thins out; incoming drops on the one. */
function riserDrop(c) {
  const { A, at, L, X, rng } = c;
  // (gain 1 ≈ the riser's last moments as loud as a full track — measured through the engine; anything
  // much lower disappears under the music it is supposed to lift)
  c.fx.push({ kind: 'riser', t: c.tS, dur: X - c.tS, gain: rng.range(0.85, 1.2) });
  A.ramp('hpf', c.tS, X, rng.range(1000, 2600));
  // Sometimes pull the outgoing half a beat early: a breath of air before the drop.
  const gap = L >= 4 && rng.next() < 0.35 + 0.3 * c.vibe ? 0.5 : 0;
  const tCut = at(L - gap);
  A.ramp('gain', at(L * 0.25), tCut - CUT_S, 0.7);
  A.ramp('gain', tCut - CUT_S, tCut, 0);
  dropIn(c);
  c.fx.push({ kind: 'impact', t: X, gain: rng.range(0.5, 0.7) });
  c.marks.push({ t: c.tS, label: 'Riser' }, { t: X, label: 'Drop' });
}

/**
 * Recipe table.
 *  overlap  both tracks sound together for L beats (incoming starts at the first beat); otherwise the
 *           incoming drops in on the last line.
 *  sync     'required' = only with beat-matched tracks · 'optional' = tempo carried over if matchable ·
 *           'never' = incoming always plays at its own tempo.
 *  lengths  every L the recipe can be built with; prefer(mode) = the ones it likes ('quick' included).
 */
export const RECIPES = {
  bassSwap: { name: 'Bass swap', overlap: true, sync: 'required', lengths: [4, 8, 16, 32], build: bassSwap },
  eqBlend: { name: 'EQ blend', overlap: true, sync: 'required', lengths: [4, 8, 16, 32], build: eqBlend },
  filterBlend: { name: 'Filter blend', overlap: true, sync: 'required', lengths: [4, 8, 16, 32], build: filterBlend },
  echoOut: { name: 'Echo out', overlap: false, sync: 'never', lengths: [1, 2, 4], build: echoOut },
  reverbWash: { name: 'Reverb wash', overlap: true, sync: 'never', lengths: [2, 4, 8, 16], build: reverbWash },
  cut: { name: 'Cut', overlap: false, sync: 'optional', lengths: [0, 2, 4], build: cut },
  spinback: { name: 'Spinback', overlap: false, sync: 'never', lengths: [1, 2, 3, 4], build: spinback },
  brake: { name: 'Brake', overlap: false, sync: 'never', lengths: [1, 2], build: brake },
  loopRoll: { name: 'Loop roll', overlap: false, sync: 'optional', lengths: [1, 2, 4, 8], build: loopRoll },
  riserDrop: { name: 'Riser drop', overlap: false, sync: 'optional', lengths: [2, 4, 8, 16], build: riserDrop },
};

/** Every transition type the planner can choose between two tracks (the opener's 'fadeIn' is separate). */
export const TYPES = Object.freeze(Object.keys(RECIPES));

/** Lengths (beats) a recipe likes in a given situation; the planner falls back to any buildable length. */
export function preferredLengths(type, mode, quick, beatSec) {
  const long = mode !== 'preview';
  // Time-shaped moves: pick the beat count closest to how long the gesture should last.
  const bySeconds = (target, max) => [clamp(Math.round(target / Math.max(beatSec, 0.05)), 1, max)];
  switch (type) {
    case 'bassSwap':
    case 'eqBlend':
    case 'filterBlend':
      return quick ? [4] : long ? [16, 32] : [8, 16];
    case 'reverbWash':
      return quick ? [2] : long ? [8, 16] : [4, 8];
    case 'echoOut':
      return quick ? [1] : [1, 2, 2, 4];
    case 'cut':
      return quick ? [0] : [0, 0, 2, 4];
    case 'spinback':
      return bySeconds(1.2, 4);
    case 'brake':
      return bySeconds(0.7, 2);
    case 'loopRoll':
      return quick ? [2] : long ? [4, 8] : [4];
    case 'riserDrop':
      return quick ? [2, 4] : long ? [8, 16] : [4, 8];
    default:
      return [];
  }
}

/** UI label, e.g. "Bass swap · 16 beats". */
export function labelFor(type, L) {
  const name = RECIPES[type] ? RECIPES[type].name : 'Fade in';
  if (type === 'spinback' || type === 'brake' || !(L > 0)) return name;
  return `${name} · ${L} ${L === 1 ? 'beat' : 'beats'}`;
}

/** Entry of a track with nothing (audible) to mix out of: short fade-in under an opening low-pass. */
export function buildFadeIn(lane, tInit, t0, dur, rng) {
  lane.init(tInit, { gain: 0, lpf: rng.range(300, 600) });
  lane.fade('gain', t0, t0 + dur, 1, 'in');
  lane.ramp('lpf', t0, t0 + dur * 0.9, 20000);
  return lane;
}

// ───────────────────────────── mid-solo tricks ─────────────────────────────
// Small moves on the playing track between transitions. A trick lives inside one bar grid starting at
// a downbeat (`at(0)`), touches only what it restores, and leaves strip + FX bus exactly at defaults.
// Trick context: { A, bus, fx, marks, at, rng, beatSec, span, out:{id,pos,beatLen} }; a trick that
// uses the delay bus reports `c.busFree` (set time the bus is back at rest).

/** Filter dip: the low-pass (or high-pass) closes over two beats and reopens by the next bar line. */
function filterDip(c) {
  const { A, at, rng } = c;
  if (rng.next() < 0.6) A.ramp('lpf', at(0), at(2), rng.range(350, 700)).ramp('lpf', at(2), at(4), 20000);
  else A.ramp('hpf', at(0), at(2), rng.range(450, 900)).ramp('hpf', at(2), at(4), 20);
  c.marks.push({ t: at(0), label: 'Filter dip' });
}

/** Echo throw: the last beat of the bar is thrown into the delay and rings over the next bar. */
function echoThrow(c) {
  const { A, at, rng } = c;
  const dT = delayTimeFor(c.beatSec, rng.pick([0.75, 0.5]));
  const fb = rng.range(0.5, 0.62);
  A.ramp('delaySend', at(3), at(3.15), rng.range(0.45, 0.6));
  A.ramp('delaySend', at(3.85), at(4), 0);
  c.busFree = useDelayBus(c.bus, at(3), at(4), at(4) + Math.min(4 * c.beatSec, 3), dT, fb);
  c.marks.push({ t: at(3), label: 'Echo throw' });
}

/** Beat repeat: the end of the bar stutters (halves and/or quarters), main source back on the one. */
function beatRepeat(c) {
  const { A, at, rng } = c;
  const u = rng.next();
  const segs = u < 0.35 ? [[2, 0.5, 2], [3, 0.25, 4]] : u < 0.7 ? [[3, 0.5, 2]] : [[3, 0.25, 4]];
  const k0 = segs[0][0];
  A.set('src', at(k0), 0);
  for (const [k, frac, reps] of segs) {
    const t = at(k);
    const dur = at(k + frac * reps) - t;
    const len = frac * c.out.beatLen;
    c.fx.push({ kind: 'loop', playId: c.out.id, t, dur, offset: c.out.pos(k0), len, rate: (len * reps) / dur });
  }
  A.set('src', at(4), 1);
  c.marks.push({ t: at(k0), label: 'Beat repeat' });
}

/** High-pass build + drop: the lows drain away over the bar(s) and slam back on the downbeat. */
function hpfBuild(c) {
  const { A, at, rng, span } = c;
  A.ramp('hpf', at(0), at(span), rng.range(700, 1300));
  A.ramp('hpf', at(span), at(span) + 0.02, 20);
  c.marks.push({ t: at(0), label: 'Build' }, { t: at(span), label: 'Drop' });
}

/**
 * Trick table. span = bars' worth of beats the strip is busy; `delay` = uses the shared delay bus
 * (so it needs the bus free and extra room for the tail + reset); `grid` = needs a trustworthy beat grid.
 */
export const TRICKS = {
  filterDip: { name: 'Filter dip', spans: [4], delay: false, grid: false, build: filterDip },
  echoThrow: { name: 'Echo throw', spans: [4], delay: true, grid: true, build: echoThrow },
  beatRepeat: { name: 'Beat repeat', spans: [4], delay: false, grid: true, build: beatRepeat },
  hpfBuild: { name: 'Build + drop', spans: [4, 8], delay: false, grid: false, build: hpfBuild },
};

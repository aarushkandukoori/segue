// Synthetic analyses + the invariant checker shared by every dj.*.test.js.
// Nothing here touches audio: plans are judged in "plan space" with the same timeline.js math the
// engine and the UI use.
import { dbToGain, evalParam, positionAt, timeAtPosition } from '../../js/dj/timeline.js';
import { camelot } from '../../js/dj/camelot.js';
import { holdPlayAt } from '../../js/dj/planner.js';
import { FX_BUS_GUARD, FX_DEFAULTS, PARAM_RANGE, STRIP_DEFAULTS } from '../../js/dj/transitions.js';

export const ALL_TYPES = ['bassSwap', 'eqBlend', 'filterBlend', 'echoOut', 'reverbWash', 'cut', 'spinback', 'brake', 'loopRoll', 'riserDrop'];

/**
 * A plausible Analysis for a track with a steady (optionally jittered / drifting) beat grid.
 * @param {object} o  bpm, duration, conf, first (first beat s), downbeat, pc, mode, keyConf, energy, energyCurve,
 *                    cueEnd, drop, jitter (s, needs rng), drift (fractional tempo change across the track), trimDb
 */
/**
 * Analysis.grid for a synthetic beat list: trust values plus a slot pattern (16 per beat) with attacks
 * in the given slots of every beat (0 = on the beat, 8 = half a beat later, 4 / 12 = the sixteenths).
 * @param {number} beatCount
 * @param {{head?:number, tail?:number, phase?:number, hits?:number[], headHits?:number[], tailHits?:number[], floor?:number}} [g]
 *   headHits / tailHits: a different pattern for the first / last 24 beats (a syncopated intro / outro)
 */
export function synthGrid(beatCount, g = {}) {
  const P = 16;
  const slots = new Uint8Array(beatCount * P);
  for (let i = 0; i < beatCount; i++) {
    const hits = i < 24 && g.headHits ? g.headHits : i >= beatCount - 24 && g.tailHits ? g.tailHits : g.hits || [0];
    for (let s = 0; s < P; s++) slots[i * P + s] = g.floor ?? 12;
    // the bar accent keeps the pattern from being perfectly periodic, as in real music
    hits.forEach((s, k) => (slots[i * P + s] = Math.max(60, (k === 0 ? 230 : 150) - (i % 4 ? 30 : 0))));
  }
  return { phase: g.phase ?? 0.9, head: g.head ?? 0.9, tail: g.tail ?? 0.9, perBeat: P, slots };
}

/**
 * (`grid`: omitted = an analysis without grid trust, as every hand-made one was before Analysis.grid
 * existed; true = a clear grid; an object = synthGrid options.)
 */
export function synthAnalysis(o = {}) {
  const bpm = o.bpm ?? 120;
  const duration = o.duration ?? 30;
  const period = 60 / bpm;
  const first = o.first ?? 0.1;
  const beats = [];
  let t = first;
  for (let i = 0; t < duration && i < 20000; i++) {
    const j = o.jitter && o.rng ? (o.rng.next() - 0.5) * 2 * o.jitter : 0;
    beats.push(Math.max(0, t + j));
    t += period * (1 + (o.drift || 0) * (t / duration - 0.5));
  }
  for (let i = 1; i < beats.length; i++) if (beats[i] <= beats[i - 1]) beats[i] = beats[i - 1] + 1e-3;
  const downbeat = o.downbeat ?? 0;
  const pc = o.pc ?? 0;
  const mode = o.mode ?? 'major';
  const cueStart = o.cueStart ?? 0;
  const cueEnd = o.cueEnd ?? Math.max(0, duration - 0.4);
  let cueIn = o.cueIn;
  if (cueIn === undefined) {
    cueIn = beats.find((b, i) => b >= cueStart && (i - downbeat) % 4 === 0) ?? cueStart;
  }
  return {
    v: 1,
    duration,
    bpm,
    bpmConfidence: o.conf ?? 0.9,
    beats,
    downbeat,
    key: { pc, mode, name: `${pc}${mode}`, camelot: camelot(pc, mode), confidence: o.keyConf ?? 0.8 },
    loudness: { rms: 0.2, peak: 0.9, trimDb: o.trimDb ?? -2 },
    energy: o.energy ?? 0.6,
    energyCurve: o.energyCurve ?? [],
    cues: { start: cueStart, end: cueEnd, in: cueIn, drop: o.drop ?? null },
    wave: { cols: 0, perSec: 100, low: new Uint8Array(0), mid: new Uint8Array(0), high: new Uint8Array(0) },
    ...(o.grid ? { grid: synthGrid(beats.length, o.grid === true ? {} : o.grid) } : {}),
  };
}

/** Apply a Transition to the outgoing play the way the conductor does. */
export function applyOut(play, tr) {
  return { ...play, events: [...play.events, ...tr.aEvents], rate: [...play.rate, ...tr.aRate], endAt: tr.aEndAt };
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function scanFinite(x, path, bad) {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) bad.push(`non-finite ${path}`);
  } else if (Array.isArray(x)) x.forEach((v, i) => scanFinite(v, `${path}[${i}]`, bad));
  else if (x && typeof x === 'object') for (const k of Object.keys(x)) scanFinite(x[k], `${path}.${k}`, bad);
}

function checkList(name, events, allowed, defaults, earliest, bad) {
  let prev = -Infinity;
  const seen = {};
  const val = {};
  const openTgt = {};
  for (const e of events) {
    if (!(e.p in allowed)) bad.push(`${name}: foreign param ${e.p}`);
    if (e.t < earliest - 1e-9) bad.push(`${name}: ${e.p} at ${e.t} before earliest ${earliest}`);
    if (e.t < prev) bad.push(`${name}: not sorted at ${e.p} ${e.t}`);
    prev = e.t;
    const r = PARAM_RANGE[e.p];
    if (r && (e.v < r[0] - 1e-9 || e.v > r[1] + 1e-9)) bad.push(`${name}: ${e.p}=${e.v} out of range`);
    if (!seen[e.p] && (e.k === 'lin' || e.k === 'exp')) bad.push(`${name}: ${e.p} ${e.k} ramp is not anchored`);
    if (openTgt[e.p] && e.k !== 'set') bad.push(`${name}: tgt on ${e.p} followed by ${e.k}`);
    if (e.k === 'exp' && !(e.v > 0 && val[e.p] > 0)) bad.push(`${name}: exp ramp on ${e.p} touches 0`);
    if (!['set', 'lin', 'exp', 'tgt'].includes(e.k)) bad.push(`${name}: unknown kind ${e.k}`);
    openTgt[e.p] = e.k === 'tgt';
    seen[e.p] = true;
    val[e.p] = e.v;
  }
}

const hpfBass = (hz) => Math.min(1, (80 / hz) * (80 / hz)); // what a 12 dB/oct high-pass leaves of a kick
const bassOf = (ev, t) =>
  evalParam(ev, 'gain', t, 1) * dbToGain(evalParam(ev, 'low', t, 0)) * hpfBass(evalParam(ev, 'hpf', t, 20));
const levelOf = (ev, t) =>
  evalParam(ev, 'gain', t, 1) *
  (0.45 * dbToGain(evalParam(ev, 'low', t, 0)) * hpfBass(evalParam(ev, 'hpf', t, 20)) +
    0.35 * dbToGain(evalParam(ev, 'mid', t, 0)) +
    0.2 * dbToGain(evalParam(ev, 'high', t, 0)));

/**
 * Every hard guarantee + musical invariant of a Transition. Returns a list of violations (empty = ok).
 * @param {object} tr Transition
 * @param {{prev:{play:object, analysis:object}, incoming:{id:string, analysis:object}, opts:{earliest:number, quick?:boolean, cancelledAt?:number}}} c
 */
export function checkTransition(tr, c) {
  const bad = [];
  const { prev, incoming } = c;
  const earliest = c.opts.earliest;
  const A = prev.analysis;
  const B = incoming.analysis;
  const holdT = Number.isFinite(c.opts.cancelledAt) ? Math.min(c.opts.cancelledAt, earliest) : c.opts.quick ? earliest : null;
  const playA = holdT !== null ? holdPlayAt(prev.play, holdT) : { ...prev.play, endAt: null };
  const p = tr.play;
  scanFinite(tr, 'tr', bad);
  if (bad.length) return bad;

  if (![...ALL_TYPES, 'fadeIn'].includes(tr.type)) bad.push(`type ${tr.type}`);
  if (!tr.label || !tr.why) bad.push('label / why missing');
  if (tr.from !== playA.id || tr.to !== p.id || p.id !== playA.id + 1 || tr.id !== p.id) bad.push('ids');
  if (p.deck !== 1 - playA.deck) bad.push('deck does not alternate');
  if (p.trackId !== incoming.id) bad.push('trackId');
  if (p.endAt !== null) bad.push('incoming endAt must be null');
  if (!(Number.isInteger(tr.beats) && tr.beats >= 0)) bad.push(`beats ${tr.beats}`);
  if (!(tr.bpm > 0)) bad.push(`bpm ${tr.bpm}`);
  if (tr.tStart < earliest - 1e-9) bad.push(`tStart ${tr.tStart} < earliest ${earliest}`);
  if (tr.tEnd < tr.tStart) bad.push('tEnd < tStart');
  if (p.startAt < earliest - 1e-9) bad.push('incoming starts before earliest');
  if (p.soloFrom !== tr.tEnd) bad.push('soloFrom !== tEnd');
  if (p.offset < 0 || p.offset > B.duration) bad.push(`offset ${p.offset}`);
  if (p.rate[0].t !== p.startAt) bad.push('rate[0].t !== startAt');
  if (p.trimDb !== B.loudness.trimDb) bad.push('trimDb');

  // rates
  let prevT = -Infinity;
  for (const q of p.rate) {
    if (!(q.v > 0)) bad.push(`incoming rate ${q.v}`);
    if (q.v > 1.25 || q.v < 0.8) bad.push(`incoming rate ${q.v} is not a DJ pitch move`);
    if (q.t < prevT) bad.push('incoming rate not sorted');
    prevT = q.t;
  }
  prevT = playA.rate[playA.rate.length - 1].t;
  for (const q of tr.aRate) {
    if (!(q.v > 0)) bad.push(`aRate ${q.v}`);
    if (q.t < prevT || q.t < earliest - 1e-9) bad.push('aRate not appendable / before earliest');
    prevT = q.t;
  }

  // buffers
  if (positionAt(p, p.soloFrom) > B.duration + 1e-6) bad.push('incoming runs past its buffer before it is solo');
  const outPlay = { ...playA, rate: [...playA.rate, ...tr.aRate], endAt: null };
  if (positionAt(outPlay, tr.aEndAt) > A.duration + 1e-6) bad.push(`outgoing plays past its buffer: ${positionAt(outPlay, tr.aEndAt)} > ${A.duration}`);
  const plainEntry = tr.type === 'fadeIn';
  if (!plainEntry && tr.aEndAt < tr.tEnd - 1e-9) bad.push('aEndAt < tEnd');

  // automation lists
  const floorA = Math.max(earliest, playA.soloFrom ?? playA.startAt);
  checkList('aEvents', tr.aEvents, STRIP_DEFAULTS, STRIP_DEFAULTS, floorA, bad);
  checkList('play.events', p.events, STRIP_DEFAULTS, STRIP_DEFAULTS, earliest, bad);
  checkList('fxEvents', tr.fxEvents, FX_DEFAULTS, FX_DEFAULTS, earliest, bad);
  for (const e of p.events) if (e.t > p.soloFrom + 1e-9) bad.push(`incoming event after soloFrom: ${e.p}`);
  for (const p9 of Object.keys(STRIP_DEFAULTS)) {
    // every param is stated before the source starts (INIT_LEAD_S early, so the engine's pre-roll hears it too)
    const first = p.events.find((e) => e.p === p9);
    if (!(first && first.k === 'set' && first.t <= p.startAt - 0.004 && first.t >= p.startAt - 0.02)) bad.push(`incoming ${p9} not initialised just before startAt`);
  }
  let mt = -Infinity;
  for (const mk of tr.marks) {
    if (mk.t < earliest - 1e-9 || mk.t < mt || !mk.label) bad.push('marks');
    mt = mk.t;
  }

  // one-shots
  let ft = -Infinity;
  for (const f of tr.fx) {
    if (f.t < earliest - 1e-9) bad.push(`fx ${f.kind} before earliest`);
    if (f.t < ft) bad.push('fx not sorted');
    ft = f.t;
    if (f.t > tr.tEnd + 1e-6) bad.push(`fx ${f.kind} after tEnd`);
    if (f.kind === 'loop') {
      if (!(f.playId === playA.id && f.offset >= 0 && f.len > 0 && f.offset + f.len <= A.duration + 1e-9 && f.rate > 0 && f.dur > 0)) bad.push('loop fx invalid');
      if (!near(f.len * Math.round((f.dur * f.rate) / f.len), f.dur * f.rate, 1e-6)) bad.push('loop is not a whole number of repeats');
    } else if (f.kind === 'reverse') {
      if (!(f.playId === playA.id && f.len > 0 && f.offset - f.len >= -1e-9 && f.offset <= A.duration + 1e-9 && f.rate0 > 0 && f.rate1 > 0 && f.dur > 0)) bad.push('reverse fx invalid');
      if (!near((f.dur * (f.rate0 + f.rate1)) / 2, f.len, 1e-6)) bad.push('reverse length does not match its rate ramp');
    } else if (f.kind === 'riser') {
      // (riser gain 1 ≈ its final moments as loud as a full track; the engine clamps at 2)
      if (!(f.dur > 0 && f.gain > 0 && f.gain <= 1.25 && f.t + f.dur <= tr.tEnd + 1e-6)) bad.push('riser invalid');
    } else if (f.kind === 'impact') {
      if (!(f.gain > 0 && f.gain <= 1)) bad.push('impact invalid');
    } else bad.push(`unknown fx ${f.kind}`);
  }

  // end states
  const evA = [...playA.events, ...tr.aEvents];
  for (const [k, d] of Object.entries(STRIP_DEFAULTS)) {
    const v = evalParam(p.events, k, p.soloFrom, d);
    if (!near(v, d, 1e-9)) bad.push(`incoming ${k}=${v} at soloFrom (want ${d})`);
  }
  if (!plainEntry && evalParam(evA, 'gain', tr.tEnd, 1) > 1e-9) bad.push('outgoing dry signal not silent at tEnd');
  if (tr.fxEvents.length) {
    for (const [k, d] of Object.entries(FX_DEFAULTS)) {
      if (!near(evalParam(tr.fxEvents, k, 1e9, d), d, 1e-12)) bad.push(`FX bus ${k} not restored`);
    }
    const lastBus = tr.fxEvents[tr.fxEvents.length - 1].t;
    if (lastBus > p.soloFrom + FX_BUS_GUARD) bad.push(`FX bus busy ${lastBus - p.soloFrom}s after soloFrom`);
  }
  if (!tr.degraded && !plainEntry) {
    // Whatever happened during the solo (tricks, post-skip tidy-up), the strip is at rest when the transition starts.
    for (const [k, d] of Object.entries(STRIP_DEFAULTS)) {
      const v = evalParam(evA, k, tr.tStart - 1e-4, d);
      if (!near(v, d, 1e-6)) bad.push(`outgoing ${k}=${v} just before tStart (want ${d})`);
    }
  }

  // sampled musical invariants
  const evB = p.events;
  for (let t = tr.tStart; t <= tr.tEnd + 1e-9; t += 0.01) {
    const live = t >= p.startAt;
    const bA = plainEntry ? 0 : bassOf(evA, t); // a plain entry means the outgoing buffer has run out
    const bB = live ? bassOf(evB, t) : 0;
    if (Math.min(bA, bB) > 0.5) {
      bad.push(`both basses up at ${t.toFixed(2)}: ${bA.toFixed(2)} / ${bB.toFixed(2)}`);
      break;
    }
    const lvl = (plainEntry ? 0 : levelOf(evA, t)) + (live ? levelOf(evB, t) : 0);
    if (lvl > 1.7) {
      bad.push(`summed level ${lvl.toFixed(2)} at ${t.toFixed(2)}`);
      break;
    }
    for (const [k, r] of Object.entries(PARAM_RANGE)) {
      if (!(k in STRIP_DEFAULTS)) continue;
      const va = evalParam(evA, k, t, STRIP_DEFAULTS[k]);
      const vb = evalParam(evB, k, t, STRIP_DEFAULTS[k]);
      if (!(va >= r[0] - 1e-9 && va <= r[1] + 1e-9 && vb >= r[0] - 1e-9 && vb <= r[1] + 1e-9)) bad.push(`${k} leaves its range at ${t}`);
    }
    if (bad.length > 20) break;
  }
  return bad;
}

/**
 * Worst beat misalignment (seconds, set time) between the two tracks over the overlap of a synced
 * transition, measured through timeAtPosition on the analysed beat times. Also reports how many
 * beats were compared and whether a downbeat pair coincides.
 */
export function beatAlignment(tr, prevPlay, A, B) {
  const out = { ...prevPlay, endAt: null };
  const inc = { ...tr.play, endAt: null };
  const inWin = (t) => t >= tr.tStart - 1e-6 && t <= tr.tEnd + 1e-6;
  const allA = A.beats.map((b, i) => ({ t: timeAtPosition(out, b), down: (i - A.downbeat) % 4 === 0 }));
  const allB = B.beats.map((b, i) => ({ t: timeAtPosition(inc, b), down: (i - B.downbeat) % 4 === 0 }));
  const ta = allA.filter((x) => inWin(x.t));
  const tbs = allB.filter((x) => inWin(x.t));
  // Compare from the slower side: each of its beats in the overlap must sit on a beat of the faster
  // track (partners are looked up in the whole track so a pair straddling the window edge still pairs).
  const [few, many] = ta.length <= tbs.length ? [ta, allB] : [tbs, allA];
  let worst = 0;
  let downPairs = 0;
  for (const x of few) {
    let best = Infinity;
    let bestY = null;
    for (const y of many) {
      const d = Math.abs(x.t - y.t);
      if (d < best) {
        best = d;
        bestY = y;
      }
    }
    worst = Math.max(worst, best);
    if (x.down && bestY && bestY.down && best < 0.002) downPairs++;
  }
  return { worst, compared: few.length, downPairs };
}

/** FX-bus discipline: the delay bus is used in sessions (configure → … → restore) that never interleave. */
export function checkBusSessions(tr, c) {
  const bad = [];
  // After a Skip the plan may open with a bus flush (return → 0 by target curve, feedback 0, reopen 1 s later).
  const held = !!(c && (c.opts.quick || Number.isFinite(c.opts.cancelledAt)));
  const t0 = c ? Math.max(c.opts.earliest, c.prev.play.startAt, c.prev.play.soloFrom ?? -Infinity) : -Infinity;
  let fxEvents = tr.fxEvents;
  let flushEnd = -Infinity;
  if (held && fxEvents.length && fxEvents[0].k === 'tgt') {
    const f = fxEvents.slice(0, 4);
    const shape = f.map((e) => `${e.p}:${e.k}:${e.v}`).join(' ');
    if (shape !== 'fxReturn:tgt:0 delayFeedback:set:0 fxReturn:set:1 delayFeedback:set:0.5') bad.push(`bus flush malformed: ${shape}`);
    else if (!(f[0].t === t0 && f[1].t === t0 && f[2].t >= t0 + 0.95 && f[3].t === f[2].t)) bad.push('bus flush timing');
    flushEnd = f[2].t;
    fxEvents = fxEvents.slice(4);
  }
  if (fxEvents.some((e) => e.k === 'tgt')) bad.push('unexpected tgt on the FX bus');
  if (fxEvents.length && fxEvents[0].t < flushEnd) bad.push('delay bus used before the flush finished');
  const dt = fxEvents.filter((e) => e.p === 'delayTime');
  if (dt.length % 2) bad.push('delay bus: unpaired configure / restore');
  const sessions = [];
  for (let i = 0; i + 1 < dt.length; i += 2) {
    if (dt[i + 1].v !== FX_DEFAULTS.delayTime) bad.push('delay bus: session does not restore delayTime');
    if (dt[i + 1].t <= dt[i].t) bad.push('delay bus: empty session');
    if (i > 0 && dt[i].t < dt[i - 1].t) bad.push('delay bus: sessions interleave');
    sessions.push([dt[i].t, dt[i + 1].t]);
  }
  const inSession = (t) => sessions.some(([a, b]) => t >= a - 1e-9 && t <= b + 1e-9);
  for (const e of fxEvents) if (!inSession(e.t)) bad.push(`delay bus: ${e.p} touched outside a session`);
  // (a post-Skip tidy-up may restate a send the cancel froze open, at t0, before closing it)
  for (const e of tr.aEvents) if (e.p === 'delaySend' && e.v > 0 && !(held && e.t === t0) && !inSession(e.t)) bad.push('delay send opened with the bus not configured');
  for (const [a, b] of sessions) {
    const at = (p, t) => evalParam(fxEvents, p, t, FX_DEFAULTS[p]);
    if (!(at('delayFeedback', a) > 0 && at('fxReturn', a) === 1)) bad.push('delay bus: session not fully configured');
    // just before the restore the line must be silent: return closed and feedback off for a full delay time
    const dTime = at('delayTime', a);
    if (!(at('fxReturn', b - 1e-6) === 0 && at('delayFeedback', b - dTime - 1e-3) === 0)) bad.push('delay bus: restored while the line could still ring');
  }
  return bad;
}

/** A random, often awkward analysis for fuzzing. `r` is a createRng() instance. */
export function randomAnalysis(r) {
  const bpm = r.range(60, 200);
  const u = r.next();
  const duration = u < 0.35 ? r.range(6, 31) : u < 0.6 ? 30 : r.range(31, 400);
  const confRoll = r.next();
  const an = synthAnalysis({
    bpm,
    duration,
    conf: confRoll < 0.15 ? 0 : confRoll < 0.3 ? r.range(0, 0.5) : r.range(0.5, 1),
    first: r.range(0, 60 / bpm),
    downbeat: r.int(4),
    pc: r.int(12),
    mode: r.next() < 0.5 ? 'major' : 'minor',
    keyConf: r.next(),
    energy: r.next(),
    jitter: r.next() < 0.3 ? r.range(0, 0.012) : 0,
    drift: r.next() < 0.2 ? r.range(-0.04, 0.04) : 0,
    rng: r,
    trimDb: r.range(-12, 6),
    cueStart: r.next() < 0.5 ? 0 : r.range(0, Math.min(3, duration / 4)),
    cueEnd: r.next() < 0.5 ? undefined : duration - r.range(0, Math.min(6, duration / 3)),
    drop: r.next() < 0.5 ? null : r.range(0, duration),
  });
  // Grid trust on about half of them: any trust values, on-beat / off-beat / busy patterns — and now and
  // then a broken one (wrong length, odd slot count, junk values).
  const gRoll = r.next();
  if (gRoll < 0.5) {
    const pick = () => (r.next() < 0.6 ? r.range(0.5, 1) : r.next());
    const pat = r.next();
    an.grid = synthGrid(an.beats.length, {
      phase: pick(),
      head: pick(),
      tail: pick(),
      hits: pat < 0.6 ? [0] : pat < 0.75 ? [8] : pat < 0.9 ? [0, 8] : [0, 4, 8, 12],
      headHits: r.next() < 0.2 ? [8] : undefined,
      tailHits: r.next() < 0.2 ? [6, 0] : undefined,
    });
    const bad = r.next();
    if (bad < 0.04) an.grid.slots = an.grid.slots.subarray(0, 7);
    else if (bad < 0.08) an.grid.perBeat = 5;
    else if (bad < 0.12) an.grid.head = NaN;
    else if (bad < 0.16) an.grid.slots = null;
    else if (bad < 0.2) an.grid = { phase: 'x' };
  }
  // corrupt some fields the way a bad analysis might
  const c = r.next();
  if (c < 0.03) an.cues.end = an.cues.start; // empty usable region
  else if (c < 0.06) an.cues.in = duration + 5; // cue past the end
  else if (c < 0.08) an.beats = an.beats.slice(0, 1); // almost no grid
  else if (c < 0.1) an.cues.drop = duration + 10;
  else if (c < 0.12) an.bpmConfidence = 0;
  return an;
}

/** A crate that looks like a real playlist: tempo clusters, mostly steady grids, some awkward tracks. */
export function synthCrate(r, n, { full = false, grid = false } = {}) {
  const tracks = [];
  for (let i = 0; i < n; i++) {
    const u = r.next();
    const bpm = u < 0.45 ? r.range(118, 130) : u < 0.7 ? r.range(95, 112) : u < 0.85 ? r.range(84, 95) : r.range(135, 176);
    const duration = full ? r.range(150, 300) : r.next() < 0.85 ? 30 : r.range(26, 30);
    const steady = r.next() < 0.85;
    tracks.push({
      id: `t${i}`,
      artist: `Artist ${r.int(Math.max(3, Math.floor(n * 0.7)))}`,
      analysis: synthAnalysis({
        bpm,
        duration,
        conf: steady ? r.range(0.6, 0.98) : r.range(0.05, 0.45),
        first: r.range(0.02, 60 / bpm),
        downbeat: r.int(4),
        pc: r.int(12),
        mode: r.next() < 0.5 ? 'major' : 'minor',
        keyConf: r.range(0.3, 0.95),
        energy: r.range(0.25, 0.95),
        jitter: 0.002,
        rng: r,
        trimDb: r.range(-8, 3),
        cueEnd: duration - r.range(0.2, 1.5),
        drop: r.next() < 0.6 ? r.range(duration * 0.15, duration * 0.6) : null,
      }),
    });
    if (grid) {
      // like a real crate: most tracks clear at both ends, some syncopated at one, a few off-beat throughout
      const u2 = r.next();
      const an = tracks[i].analysis;
      const clear = () => r.range(0.55, 1);
      const murky = () => r.range(0, 0.3);
      if (u2 < 0.6) an.grid = synthGrid(an.beats.length, { phase: clear(), head: clear(), tail: clear() });
      else if (u2 < 0.75) an.grid = synthGrid(an.beats.length, { phase: clear(), head: murky(), tail: clear(), headHits: [8, 0] });
      else if (u2 < 0.9) an.grid = synthGrid(an.beats.length, { phase: clear(), head: clear(), tail: murky(), tailHits: [6, 12] });
      else an.grid = synthGrid(an.beats.length, { phase: murky(), head: murky(), tail: murky(), hits: [8] });
    }
  }
  return tracks;
}

/**
 * Run the planner the way the conductor does, in plan space: seeded base order, crate window of 5,
 * chooseNext, next() planned shortly after the previous track starts, endless reshuffle.
 * @returns {{plays: object[], transitions: object[], picks: string[], violations: string[]}}
 */
export function simulateSet(planner, tracks, count, { lead = 2, check = true } = {}) {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  let queue = planner.order(tracks.map((t) => t.id));
  const recent = [];
  const plays = [];
  const transitions = [];
  const picks = [];
  const violations = [];
  let current = null;
  for (let n = 0; n < count; n++) {
    if (!queue.length) queue = planner.order(tracks.map((t) => t.id)).filter((id) => !current || id !== current.id);
    const window = queue.slice(0, 5).map((id) => byId.get(id));
    const k = planner.chooseNext(current, window, { playIndex: n, recentArtists: recent.slice(-3) });
    const track = window[k];
    queue.splice(queue.indexOf(track.id), 1);
    picks.push(track.id);
    let tr;
    if (!current) tr = planner.first(track, { startAt: 0 });
    else {
      const prev = { play: plays[plays.length - 1], analysis: current.analysis };
      const opts = { earliest: prev.play.startAt + lead };
      tr = planner.next(prev, track, opts);
      if (check) {
        for (const v of [...checkTransition(tr, { prev, incoming: track, opts }), ...checkBusSessions(tr, { prev, incoming: track, opts })]) {
          violations.push(`play ${n} ${tr.type}: ${v}`);
        }
      }
      plays[plays.length - 1] = applyOut(prev.play, tr);
    }
    transitions.push(tr);
    plays.push(tr.play);
    recent.push(track.artist);
    current = track;
  }
  return { plays, transitions, picks, violations };
}

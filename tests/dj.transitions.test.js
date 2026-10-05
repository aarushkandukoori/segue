// Per-recipe structure + the musical invariants every transition must satisfy (evaluated through
// timeline.evalParam on a 10 ms grid by checkTransition).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { evalParam, positionAt, rateAt } from '../js/dj/timeline.js';
import { BRAKE_FLOOR, CUT_S, FX_DEFAULTS, INIT_LEAD_S, KILL_DB, PREROLL_S, RECIPES, REOPEN_AHEAD_S, RISER_GAIN, STRIP_DEFAULTS, SWAP_AHEAD_S, TRICKS, TYPES, createLane, labelFor, preferredLengths } from '../js/dj/transitions.js';
import { createRng } from '../js/util/rng.js';
import { dbToGain } from '../js/dj/timeline.js';
import { ALL_TYPES, applyOut, checkBusSessions, checkTransition, synthAnalysis } from './helpers/dj-synth.js';

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} !≈ ${b}`);

/** One forced transition between two long, steady, beat-matchable tracks. */
function make(type, beats, o = {}) {
  const A = synthAnalysis({ bpm: o.bpmA ?? 124, duration: o.durA ?? 200, first: 0.31, downbeat: 1, pc: 0, ...o.a });
  const B = synthAnalysis({ bpm: o.bpmB ?? 127, duration: o.durB ?? 200, first: 0.22, downbeat: 2, pc: 7, ...o.b });
  const planner = createPlanner({ seed: o.seed ?? 'recipe', vibe: o.vibe ?? 0.5, mode: o.mode ?? 'preview' });
  const f = planner.first({ id: 'a', analysis: A }, { startAt: o.startAt ?? 3 });
  const prev = { play: f.play, analysis: A };
  const incoming = { id: 'b', analysis: B };
  const opts = { earliest: o.earliest ?? 5, force: { type, beats }, quick: o.quick };
  const tr = planner.next(prev, incoming, opts);
  const bad = [...checkTransition(tr, { prev, incoming, opts }), ...checkBusSessions(tr, { prev, incoming, opts })];
  const evA = [...f.play.events, ...tr.aEvents];
  const a = (p, t) => evalParam(evA, p, t, STRIP_DEFAULTS[p]);
  const b = (p, t) => evalParam(tr.play.events, p, t, STRIP_DEFAULTS[p]);
  const beat = (k) => tr.tStart + ((tr.tEnd - tr.tStart) * k) / (tr.beats || 1);
  return { tr, bad, A, B, prev, incoming, opts, a, b, beat, out: f.play };
}

test('recipe table is complete and consistent', () => {
  assert.deepEqual([...TYPES].sort(), [...ALL_TYPES].sort());
  for (const type of TYPES) {
    const R = RECIPES[type];
    assert.equal(typeof R.build, 'function');
    assert.ok(['required', 'optional', 'never'].includes(R.sync));
    assert.ok(R.lengths.length > 0 && R.lengths.every((L) => Number.isInteger(L) && L >= 0));
    for (const mode of ['preview', 'short', 'medium', 'full']) for (const quick of [false, true]) for (const beatSec of [0.3, 0.5, 1]) {
      const liked = preferredLengths(type, mode, quick, beatSec);
      assert.ok(liked.length > 0 && liked.every((L) => R.lengths.includes(L)), `${type} ${mode} ${quick}: ${liked}`);
    }
  }
  // the brief: blends are 8/16 beats on previews and 16/32 on longer material
  for (const type of ['bassSwap', 'eqBlend', 'filterBlend']) {
    assert.deepEqual(preferredLengths(type, 'preview', false, 0.5), [8, 16]);
    assert.deepEqual(preferredLengths(type, 'full', false, 0.5), [16, 32]);
  }
  assert.equal(labelFor('bassSwap', 16), 'Bass swap · 16 beats');
  assert.equal(labelFor('echoOut', 1), 'Echo out · 1 beat');
  assert.equal(labelFor('cut', 0), 'Cut');
  assert.equal(labelFor('spinback', 2), 'Spinback');
});

test('automation lane: anchored, clamped, time-ordered', () => {
  const lane = createLane(STRIP_DEFAULTS);
  lane.ramp('gain', 1, 2, 0);
  assert.deepEqual(lane.events, [{ p: 'gain', t: 1, v: 1, k: 'set' }, { p: 'gain', t: 2, v: 0, k: 'lin' }]);
  lane.ramp('gain', 2, 3, 5); // continues from the previous event without a duplicate anchor; clamps to range
  assert.equal(lane.events.length, 3);
  assert.equal(lane.events[2].v, 1);
  lane.ramp('hpf', 1, 2, 1); // frequency → exp, clamped ≥ 20 so it can never touch 0
  assert.deepEqual(lane.events.slice(-2), [{ p: 'hpf', t: 1, v: 20, k: 'set' }, { p: 'hpf', t: 2, v: 20, k: 'exp' }]);
  lane.set('gain', 0.5, 0.3); // going back in time is refused: pinned to the last event time
  assert.equal(lane.events[lane.events.length - 1].t, 3);
  lane.ramp('low', 5, 5, -10); // zero-length ramp degrades to a set
  assert.deepEqual(lane.events[lane.events.length - 1], { p: 'low', t: 5, v: -10, k: 'set' });
  assert.throws(() => lane.set('gain', NaN, 1), RangeError);
  assert.throws(() => lane.set('gain', 9, Infinity), RangeError);
  // equal-power fade: monotonic, lands exactly, and sits above the straight line (fade-in)
  const f = createLane(STRIP_DEFAULTS).set('gain', 0, 0);
  f.fade('gain', 0, 6, 1, 'in', 6);
  const vs = f.events.map((e) => e.v);
  assert.equal(vs[vs.length - 1], 1);
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i] > vs[i - 1]);
  near(evalParam(f.events, 'gain', 3, 1), Math.sin(Math.PI / 4), 1e-9);
  // equal-power EQ crossfade: one band opening against one closing keeps the summed power (±1 dB),
  // where two straight dB ramps would be 8 dB down in the middle
  const up = createLane(STRIP_DEFAULTS).set('high', 0, -22);
  const down = createLane(STRIP_DEFAULTS);
  up.eq('high', 0, 8, 0);
  down.eq('high', 0, 8, -22);
  assert.equal(evalParam(up.events, 'high', 8, 0), 0);
  assert.equal(evalParam(down.events, 'high', 8, 0), -22);
  let prevUp = -Infinity;
  for (let t = 0; t <= 8; t += 0.1) {
    const u = evalParam(up.events, 'high', t, 0);
    const d = evalParam(down.events, 'high', t, 0);
    assert.ok(u >= prevUp - 1e-9 && u <= 0 && d <= 0 && d >= -22, `monotonic, in range at ${t}`);
    prevUp = u;
    const power = 10 * Math.log10(dbToGain(u) ** 2 + dbToGain(d) ** 2);
    assert.ok(Math.abs(power) < 1, `summed power ${power} dB at ${t}`);
  }
  assert.ok(up.events.concat(down.events).every((e) => e.k === 'set' || e.k === 'lin'));
});

test('every recipe at every length satisfies the invariants (modes × vibes × seeds)', () => {
  let n = 0;
  for (const type of TYPES) for (const L of RECIPES[type].lengths) for (const mode of ['preview', 'full']) for (const vibe of [0, 0.5, 1]) for (const seed of ['a', 'b', 'c']) {
    const { tr, bad } = make(type, L, { mode, vibe, seed });
    assert.equal(tr.type, type, `${type} ${L} was not buildable`);
    assert.equal(tr.beats, L);
    assert.equal(tr.label, labelFor(type, L));
    assert.deepEqual(bad, [], `${type} L=${L} ${mode} vibe ${vibe} seed ${seed}`);
    assert.equal(tr.degraded, undefined);
    assert.equal(tr.synced, RECIPES[type].sync !== 'never');
    n++;
  }
  assert.ok(n > 500);
});

test('bassSwap: bass changes hands on a downbeat within about half a beat', () => {
  for (const L of [8, 16, 32]) for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
    const { tr, a, b, beat } = make('bassSwap', L, { seed, mode: L > 16 ? 'full' : 'preview' });
    const mark = tr.marks.find((m) => m.label === 'Bass swap');
    const k = ((mark.t - tr.tStart) / (tr.tEnd - tr.tStart)) * L;
    near(k, Math.round(k), 1e-6);
    assert.equal(Math.round(k) % 4, 0, 'swap on a bar line');
    assert.ok(k >= L / 4 && k <= (3 * L) / 4);
    // the swap happens in the half beat before the downbeat and is complete just ahead of it:
    // the incoming kick owns the one
    near(b('low', beat(k - 0.5)), KILL_DB, 1e-6);
    near(a('low', beat(k - 0.5)), 0, 1e-6);
    assert.equal(b('low', beat(k - 0.6)), KILL_DB);
    assert.equal(a('low', beat(k - 0.6)), 0);
    near(b('low', beat(k - 0.25) - SWAP_AHEAD_S / 2), -8, 1e-6, 'basses cross low, never both up');
    near(a('low', beat(k - 0.25) - SWAP_AHEAD_S / 2), -8, 1e-6);
    near(b('low', beat(k) - SWAP_AHEAD_S), 0, 1e-6);
    near(a('low', beat(k) - SWAP_AHEAD_S), KILL_DB, 1e-6);
    assert.equal(b('low', beat(k)), 0);
    assert.equal(a('low', beat(k)), KILL_DB);
    assert.ok(b('gain', beat(k)) >= 0.8, 'incoming is already up when the bass arrives');
    assert.equal(a('gain', beat(k)), 1, 'outgoing still full until the swap');
    assert.ok(a('mid', tr.tEnd) < -6 && a('high', tr.tEnd) < -6, 'outgoing mids/highs rolled off');
  }
});

test('eqBlend: highs, then mids, then bass', () => {
  const { tr, a, b } = make('eqBlend', 16);
  const reach = (fn, p, target) => {
    for (let t = tr.tStart; t <= tr.tEnd; t += 0.01) if (Math.abs(fn(p, t) - target) < 1e-9) return t;
    return Infinity;
  };
  const hi = reach(b, 'high', 0);
  const mid = reach(b, 'mid', 0);
  const low = reach(b, 'low', 0);
  assert.ok(hi < mid && mid < low && low < tr.tEnd, `${hi} ${mid} ${low}`);
  assert.ok(reach(a, 'high', -22) < reach(a, 'mid', -16) && reach(a, 'mid', -16) < reach(a, 'low', KILL_DB));
  assert.equal(b('gain', tr.tStart), 0);
  // each band is an equal-power crossfade: summed band power stays level while it changes hands
  const beat = (k) => tr.tStart + ((tr.tEnd - tr.tStart) * k) / 16;
  for (const [p, k0, k1] of [['high', 1.6, 7.2], ['mid', 5.6, 11.2]]) {
    for (let k = k0; k <= k1; k += 0.2) {
      const power = 10 * Math.log10(dbToGain(a(p, beat(k))) ** 2 + dbToGain(b(p, beat(k))) ** 2);
      assert.ok(Math.abs(power) < 1.2, `${p} band power ${power.toFixed(1)} dB at beat ${k.toFixed(1)}`);
    }
  }
  // the bass goes last, into the bar line three quarters through, and never doubles
  assert.equal(a('low', beat(9.9)), 0);
  assert.equal(b('low', beat(9.9)), KILL_DB);
  assert.equal(a('low', beat(12)), KILL_DB);
  assert.equal(b('low', beat(12)), 0);
  assert.ok(Math.abs(tr.marks.find((m) => m.label === 'Bass').t - beat(10)) < 1e-6);
});

test('eqBlend over 8 beats (the usual length on previews): the bass still changes hands into a bar line', () => {
  // 0.75 × 8 = beat 6 = the THIRD beat of a bar: the low end used to change hands mid-phrase in every
  // 8-beat EQ blend. It now completes on beat 4, the bar line in the middle, with the highs and mids
  // moved up so the order stays highs → mids → bass.
  const { tr, a, b, bad, A, out } = make('eqBlend', 8);
  assert.deepEqual(bad, []);
  assert.equal(tr.beats, 8);
  const beat = (k) => tr.tStart + ((tr.tEnd - tr.tStart) * k) / 8;
  assert.equal(a('low', beat(2) - 1e-6), 0, 'bass untouched until two beats before the line');
  assert.equal(b('low', beat(2) - 1e-6), KILL_DB);
  near(a('low', beat(3) - SWAP_AHEAD_S / 2), -8, 1e-6, 'basses cross low, never both up');
  near(b('low', beat(3) - SWAP_AHEAD_S / 2), -8, 1e-6);
  assert.equal(a('low', beat(4)), KILL_DB);
  assert.equal(b('low', beat(4)), 0);
  // … and beat 4 of the blend is a bar line of the outgoing track
  const pos = positionAt(applyOut(out, { ...tr, aEndAt: null }), beat(4));
  const i = A.beats.findIndex((x) => Math.abs(x - pos) < 2e-3);
  assert.ok(i >= 0 && (i - A.downbeat) % 4 === 0, `beat ${i} of the outgoing track (downbeat ${A.downbeat})`);
  const reach = (fn, p, target) => {
    for (let t = tr.tStart; t <= tr.tEnd; t += 0.005) if (Math.abs(fn(p, t) - target) < 1e-9) return t;
    return Infinity;
  };
  const [hi, mid, low] = [reach(b, 'high', 0), reach(b, 'mid', 0), reach(b, 'low', 0)];
  assert.ok(hi < mid && mid < low && low <= beat(4) + 1e-6, `highs ${hi}, mids ${mid}, bass ${low}; line at ${beat(4)}`);
  assert.ok(reach(a, 'high', -22) < reach(a, 'mid', -16) && reach(a, 'mid', -16) < reach(a, 'low', KILL_DB));
  assert.ok(Math.abs(tr.marks.find((m) => m.label === 'Bass').t - beat(2)) < 1e-6);
  assert.equal(a('gain', beat(4)), 1, 'outgoing at full level until the bass is handed over');
  assert.equal(a('gain', tr.tEnd), 0);
  assert.equal(b('gain', beat(2)), 1, 'incoming is up before its bass arrives');
  // 16 and 32 beats keep the three-quarter line (a bar line there); a 4-beat blend (Skip) has none inside
  for (const [L, k] of [[16, 12], [32, 24], [4, 3]]) {
    const m = make('eqBlend', L, L === 4 ? { quick: true } : {});
    assert.equal(m.tr.beats, L);
    const bt = (x) => m.tr.tStart + ((m.tr.tEnd - m.tr.tStart) * x) / L;
    assert.equal(m.b('low', bt(k)), 0, `${L} beats: bass handed over by beat ${k}`);
    assert.equal(m.b('low', bt(k - Math.min(2, L / 4)) - 1e-6), KILL_DB);
  }
});

test('filterBlend: high-pass sweeps up exponentially across the whole transition, fader closes on the last beat', () => {
  const { tr, a, b, beat } = make('filterBlend', 16);
  let prev = 0;
  for (let k = 0; k <= 16; k += 0.25) {
    const v = a('hpf', beat(k));
    assert.ok(v >= prev, `hpf rises at beat ${k}`);
    prev = v;
  }
  assert.ok(prev >= 5000);
  assert.ok(tr.aEvents.filter((e) => e.p === 'hpf' && e.k !== 'set').every((e) => e.k === 'exp'));
  assert.ok(a('gain', beat(15)) >= 0.79, 'outgoing still up one beat before the end');
  assert.equal(a('gain', tr.tEnd), 0);
  assert.ok(b('lpf', tr.tStart) < 500);
  assert.equal(b('lpf', beat(12)), 20000);
  // the incoming bass is held back until the outgoing's is filtered away
  assert.equal(b('low', beat(16 * 0.33)), KILL_DB);
  assert.ok(a('hpf', beat(8)) >= 400 && b('low', beat(8)) === 0);
});

test('echoOut: send opens before the bar line, fader cut on it, incoming starts there on its downbeat, bus reset', () => {
  for (const L of [1, 2, 4]) for (const seed of ['e1', 'e2', 'e3']) {
    const { tr, a, A, B, out } = make('echoOut', L, { seed });
    const beatSec = (tr.tEnd - tr.tStart) / L;
    const fxAt = (p, t) => evalParam(tr.fxEvents, p, t, FX_DEFAULTS[p]);
    const dT = fxAt('delayTime', tr.tStart);
    assert.ok([0.75, 0.5].some((f) => Math.abs(dT - f * beatSec) < 1e-9), `delay ${dT} is 3/4 or 1/2 beat`);
    const fb = fxAt('delayFeedback', tr.tStart);
    assert.ok(fb >= 0.6 && fb <= 0.75);
    assert.ok(tr.fxEvents[0].t < tr.tStart && tr.fxEvents[0].t >= tr.tStart - 0.05, 'bus configured just before the send opens');
    assert.equal(a('delaySend', tr.tStart), 0);
    assert.ok(a('delaySend', tr.tEnd - 0.02) >= 0.45 && a('delaySend', tr.tEnd - 0.02) <= 0.6, 'modest send');
    assert.equal(a('gain', tr.tEnd - CUT_S), 1);
    assert.equal(a('gain', tr.tEnd), 0);
    // incoming: own tempo, on its downbeat exactly at the bar line of the outgoing
    assert.equal(tr.synced, false);
    assert.ok(tr.play.rate.every((q) => q.v === 1));
    near(tr.play.startAt, tr.tEnd - PREROLL_S, 1e-9);
    const pos = positionAt(tr.play, tr.tEnd);
    const j = B.beats.findIndex((x) => Math.abs(x - pos) < 1e-6);
    assert.ok(j >= 0 && (j - B.downbeat) % 4 === 0, 'incoming is on a downbeat at tEnd');
    const i = A.beats.findIndex((x) => Math.abs(x - positionAt(out, tr.tEnd)) < 1e-6);
    assert.ok(i >= 0 && (i - A.downbeat) % 4 === 0, 'tEnd is a bar line of the outgoing track');
    // the tail rings for beats after the cut, then the bus goes back to rest
    assert.ok(fxAt('fxReturn', tr.tEnd + 2 * beatSec) > 0.5 && fxAt('delayFeedback', tr.tEnd + 2 * beatSec) === fb);
    const last = tr.fxEvents[tr.fxEvents.length - 1].t;
    assert.ok(last - tr.tEnd >= 2 && last - tr.tEnd <= 6);
    for (const [p, d] of Object.entries(FX_DEFAULTS)) assert.equal(fxAt(p, last), d);
  }
});

test('reverbWash: outgoing dissolves (send up, low-pass closing) while the incoming rises underneath at its own tempo', () => {
  const { tr, a, b, beat } = make('reverbWash', 8);
  assert.ok(a('reverbSend', beat(4)) >= 0.9 && a('reverbSend', beat(4)) <= 1.2, 'send high enough for the reverb to be heard');
  assert.ok(a('lpf', beat(7)) < 1000);
  assert.ok(a('gain', beat(4)) > 0.5 && a('gain', beat(4)) < 0.8);
  assert.ok(b('gain', beat(0.8)) === 0 && b('gain', beat(2)) < 0.5 && b('gain', beat(6)) > 0.9);
  // the bass changes hands once, in the middle, crossing low — no doubled low end, no long hole
  assert.equal(a('low', beat(2.7)), 0);
  assert.equal(b('low', beat(2.7)), KILL_DB);
  near(a('low', beat(3.6)), -8, 1e-6);
  near(b('low', beat(3.6)), -8, 1e-6);
  assert.equal(a('low', beat(4.5)), KILL_DB);
  assert.equal(b('low', beat(4.5)), 0);
  assert.equal(tr.synced, false);
  assert.deepEqual(tr.play.rate, [{ t: tr.play.startAt, v: 1 }]);
  assert.equal(tr.play.startAt, tr.tStart);
});

test('cut: hard switch on the downbeat, optional high-pass tease and impact', () => {
  const kinds = new Set();
  for (const L of [0, 2, 4]) for (const seed of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) for (const vibe of [0, 1]) {
    const { tr, a, b } = make('cut', L, { seed, vibe });
    assert.equal(a('gain', tr.tEnd - CUT_S - 1e-6), 1);
    assert.equal(a('gain', tr.tEnd), 0);
    assert.equal(b('gain', tr.tEnd), 1);
    near(tr.tEnd - tr.tStart > 0.02 ? 0 : tr.tEnd - tr.tStart, L === 0 ? CUT_S : 0, 1e-9);
    if (L > 0) assert.ok(a('hpf', tr.tEnd - 0.02) > 500);
    else assert.equal(a('hpf', tr.tEnd), 20);
    const own = tr.fx.filter((f) => f.t >= tr.tStart); // (earlier one-shots belong to mid-solo tricks)
    for (const f of own) {
      assert.equal(f.kind, 'impact');
      assert.equal(f.t, tr.tEnd);
    }
    kinds.add(`${L}:${own.length}`);
  }
  assert.ok(kinds.has('0:0') && kinds.has('0:1'), 'impact is optional (seeded)');
});

test('spinback: main source muted, reverse one-shot rewinds ~1–1.5 s with a rate ramp, impact on the bar line', () => {
  const shapes = { slowing: 0, windingUp: 0 };
  for (let n = 0; n < 40; n++) for (const bpm of [80, 124, 170]) {
    const seed = `spin${n}`;
    const { tr, a, out } = make('spinback', undefined, { seed, bpmA: bpm, bpmB: bpm * 1.3 });
    assert.equal(tr.type, 'spinback');
    const dur = tr.tEnd - tr.tStart;
    assert.ok(dur >= 0.7 && dur <= 1.6, `spin lasts ${dur}s at ${bpm} BPM`);
    assert.equal(a('src', tr.tStart), 0);
    assert.equal(a('src', tr.tStart - 1e-6), 1);
    const rev = tr.fx.filter((f) => f.kind === 'reverse');
    assert.equal(rev.length, 1);
    assert.equal(rev[0].t, tr.tStart);
    near(rev[0].dur, dur, 1e-9);
    near(rev[0].offset, positionAt(out, tr.tStart), 1e-9);
    // a flicked record: fast at first, losing speed — or (less often) a rewind that winds up into the drop
    const [fast, slow] = [Math.max(rev[0].rate0, rev[0].rate1), Math.min(rev[0].rate0, rev[0].rate1)];
    assert.ok(fast >= 2.4 && fast <= 3.4 && slow >= 0.9 && slow <= 1.3, `rates ${rev[0].rate0} → ${rev[0].rate1}`);
    shapes[rev[0].rate0 > rev[0].rate1 ? 'slowing' : 'windingUp']++;
    near(rev[0].len, (dur * (rev[0].rate0 + rev[0].rate1)) / 2, 1e-9, 'rewinds exactly the audio under the rate ramp');
    // (closed from the middle, the spin had faded out 150 – 300 ms before the drop it winds into)
    assert.ok(a('gain', tr.tStart + dur * 0.75 - 1e-6) === 1 && a('gain', tr.tEnd) === 0, 'fader closes over the last quarter only');
    near(a('gain', tr.tStart + dur * 0.875), 0.5, 1e-6);
    assert.ok(tr.fx.some((f) => f.kind === 'impact' && f.t === tr.tEnd));
    assert.equal(tr.synced, false);
  }
  assert.ok(shapes.slowing > shapes.windingUp && shapes.windingUp > 0, JSON.stringify(shapes));
  // right at the start of a buffer there is nothing to rewind: the recipe is not offered
  const early = make('spinback', undefined, { quick: true, earliest: 3.05, startAt: 3, a: { first: 0.02 } });
  if (early.tr.type === 'spinback') assert.ok(early.tr.fx.find((f) => f.kind === 'reverse').offset >= 0.8);
});

test('brake: outgoing rate ramps to ~0 over about a beat via aRate, incoming enters on the bar line', () => {
  for (const bpm of [70, 100, 128, 174]) {
    const { tr, a, out, A } = make('brake', undefined, { bpmA: bpm, bpmB: bpm * 1.25 });
    assert.equal(tr.type, 'brake');
    const dur = tr.tEnd - tr.tStart;
    assert.ok(dur >= 0.4 && dur <= 1.0, `brake lasts ${dur}s at ${bpm} BPM`);
    assert.deepEqual(tr.aRate, [{ t: tr.tStart, v: 1 }, { t: tr.tEnd, v: BRAKE_FLOOR, ramp: true }]);
    const braked = applyOut(out, tr);
    assert.ok(rateAt(braked, tr.tEnd) > 0);
    near(rateAt(braked, (tr.tStart + tr.tEnd) / 2), (1 + BRAKE_FLOOR) / 2, 1e-9);
    const free = positionAt({ ...out, endAt: null }, tr.tEnd);
    const pos = positionAt({ ...braked, endAt: null }, tr.tEnd);
    assert.ok(pos < free && pos <= A.duration);
    assert.equal(a('gain', tr.tEnd), 0);
    // the platter does the fading; the fader only tidies up the last fifth (from the middle it left dead air)
    assert.equal(a('gain', tr.tStart + dur * 0.8 - 1e-6), 1);
    near(a('gain', tr.tStart + dur * 0.9), 0.5, 1e-6);
    assert.ok(tr.play.rate.every((q) => q.v === 1));
  }
});

test('loopRoll: contiguous, halving beat-repeat of the last bar with the main source muted, under a rising high-pass', () => {
  for (const [L, shape] of [[1, ['0.25x4']], [2, ['0.5x2', '0.25x4']], [4, ['1x2', '0.5x2', '0.25x4']], [8, ['1x4', '0.5x4', '0.25x8']]]) {
    const { tr, a, out, A } = make('loopRoll', L);
    const loops = tr.fx.filter((f) => f.kind === 'loop');
    const beatLen = 60 / A.bpm;
    assert.deepEqual(loops.map((f) => `${Math.round((f.len / beatLen) * 100) / 100}x${Math.round((f.dur * f.rate) / f.len)}`), shape);
    assert.equal(loops[0].t, tr.tStart);
    for (let i = 1; i < loops.length; i++) near(loops[i].t, loops[i - 1].t + loops[i - 1].dur, 1e-9, 'contiguous');
    near(loops[loops.length - 1].t + loops[loops.length - 1].dur, tr.tEnd, 1e-9);
    for (const f of loops) {
      near(f.offset, positionAt(out, tr.tStart), 1e-9, 'slice starts where the roll starts');
      near(f.rate, rateAt(out, f.t), 1e-9, 'slice plays at the deck speed');
      assert.equal(f.playId, out.id);
    }
    assert.equal(a('src', tr.tStart), 0);
    assert.ok(a('hpf', tr.tEnd - 0.02) > 1000);
    assert.equal(a('gain', tr.tEnd - CUT_S - 1e-6), 1);
  }
});

test('riserDrop: riser spans the transition into the bar line, outgoing thins out, impact on the one', () => {
  const gaps = new Set();
  for (const L of [2, 4, 8, 16]) for (const seed of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
    const { tr, a, b, beat } = make('riserDrop', L, { seed });
    const riser = tr.fx.filter((f) => f.kind === 'riser');
    assert.equal(riser.length, 1);
    assert.equal(riser[0].t, tr.tStart);
    near(riser[0].t + riser[0].dur, tr.tEnd, 1e-9);
    // (0.85 – 1.2 was "as loud as a full track" by plain RMS and 5 – 9 LU hotter by ear: tests/e2e/mix.e2e.mjs measures it)
    assert.deepEqual(RISER_GAIN, [0.42, 0.6]);
    assert.ok(riser[0].gain >= RISER_GAIN[0] && riser[0].gain <= RISER_GAIN[1], `riser gain ${riser[0].gain}`);
    assert.ok(tr.fx.some((f) => f.kind === 'impact' && f.t === tr.tEnd));
    assert.ok(a('hpf', tr.tEnd - 0.02) > 900);
    assert.ok(a('gain', beat(L * 0.6)) < 1 && a('gain', beat(L * 0.6)) >= 0.7);
    assert.equal(b('gain', tr.tEnd), 1);
    gaps.add(a('gain', beat(L - 0.25)) === 0 ? 'gap' : 'none');
  }
  assert.deepEqual([...gaps].sort(), ['gap', 'none'], 'the half-beat breath before the drop is a seeded option');
});

test('impact one-shots: sized to the music they announce — smaller than a doubled downbeat, smaller still into a quiet entry', () => {
  const impactOf = (tr) => tr.fx.find((f) => f.kind === 'impact' && f.t === tr.tEnd);
  const RANGE = { spinback: [0.3, 0.42], riserDrop: [0.3, 0.42], cut: [0.27, 0.39], loopRoll: [0.27, 0.39] };
  // a track that enters at (or within ordinary dynamics of) its full level: the plain range
  for (const curve of [undefined, new Array(200).fill(1), new Array(200).fill(0.92)]) {
    for (const [type, [lo, hi]] of Object.entries(RANGE)) {
      const seen = [];
      for (let n = 0; n < 40; n++) {
        const { tr } = make(type, type === 'cut' ? 0 : undefined, { seed: `imp${n}`, vibe: 1, bpmB: 160, b: curve ? { energyCurve: curve } : {} });
        assert.equal(tr.type, type);
        const f = impactOf(tr);
        if (f) seen.push(f.gain);
      }
      assert.ok(seen.length >= 15, `${type}: ${seen.length} impacts in 40`);
      assert.ok(Math.min(...seen) >= lo && Math.max(...seen) <= hi, `${type}: ${Math.min(...seen)} … ${Math.max(...seen)}`);
      assert.ok(Math.max(...seen) - Math.min(...seen) > 0.03, 'seeded variety');
    }
  }
  // a quiet entry (15 dB under the track's loud parts: an intro, a breakdown): the boom follows it down
  const quiet = new Array(200).fill(0.5);
  for (const [type, [lo, hi]] of Object.entries(RANGE)) {
    for (let n = 0; n < 40; n++) {
      const o = { seed: `imp${n}`, vibe: 1, bpmB: 160 };
      const full = impactOf(make(type, type === 'cut' ? 0 : undefined, o).tr);
      const soft = impactOf(make(type, type === 'cut' ? 0 : undefined, { ...o, b: { energyCurve: quiet } }).tr);
      assert.equal(!!full, !!soft, 'the level changes, not whether there is one');
      if (!full) continue;
      // 15 dB under → 12 dB beyond the 3 dB of ordinary dynamics → 0.7 × 12 = 8.4 dB less boom
      near(20 * Math.log10(soft.gain / full.gain), -8.4, 1e-6, type);
      assert.ok(soft.gain < lo && soft.gain > 0.1 * hi);
    }
  }
  // the curve is read where the track ENTERS: a quiet stretch somewhere else changes nothing
  const lateDip = new Array(200).fill(1).fill(0.3, 60);
  const o = { seed: 'imp-late', vibe: 1, bpmB: 160 };
  assert.equal(impactOf(make('spinback', undefined, { ...o, b: { energyCurve: lateDip } }).tr).gain, impactOf(make('spinback', undefined, o).tr).gain);
  // garbage in the curve is not a level
  for (const junk of [[NaN, NaN, NaN], ['x'], [5, 5, 5], [-3]]) {
    const g = impactOf(make('spinback', undefined, { ...o, b: { energyCurve: junk } }).tr).gain;
    assert.ok(g >= 0.3 * 10 ** (-0.7 * 15 / 20) - 1e-9 && g <= 0.42, `curve ${JSON.stringify(junk)} → ${g}`);
  }
});

test('"Smooth" drops the optional boom: cuts and rolls carry no impact at vibe 0, most of them at vibe 1', () => {
  const share = (type, vibe) => {
    let k = 0;
    for (let n = 0; n < 200; n++) if (make(type, type === 'cut' ? 0 : 4, { seed: `boom${n}`, vibe }).tr.fx.some((f) => f.kind === 'impact')) k++;
    return k / 200;
  };
  for (const type of ['cut', 'loopRoll']) {
    assert.equal(share(type, 0), 0, `${type} at vibe 0`);
    assert.ok(share(type, 0.1) > 0.05 && share(type, 0.1) < 0.3, `${type} at vibe 0.1: ${share(type, 0.1)}`);
    assert.ok(share(type, 0.5) > 0.35 && share(type, 0.5) < 0.65, `${type} at vibe 0.5 (unchanged): ${share(type, 0.5)}`);
    assert.ok(share(type, 1) > 0.6, `${type} at vibe 1: ${share(type, 1)}`);
  }
});

test('Build + drop: the high-pass is fully open BEFORE the downbeat it drops on', () => {
  // Reopened in 20 ms starting ON the downbeat, the moving filter rang with the kick: a thud up to
  // 7 – 10 dB over the record's own low end, taken straight back out by the limiter.
  for (const span of TRICKS.hpfBuild.spans) for (const beatSec of [0.35, 0.5, 0.85]) {
    const lane = createLane(STRIP_DEFAULTS);
    const marks = [];
    const at = (k) => 10 + k * beatSec;
    TRICKS.hpfBuild.build({ A: lane, at, rng: createRng(`build${span}`), span, marks, fx: [], beatSec });
    const hpf = (t) => evalParam(lane.events, 'hpf', t, STRIP_DEFAULTS.hpf);
    assert.deepEqual(marks, [{ t: at(0), label: 'Build' }, { t: at(span), label: 'Drop' }]);
    assert.equal(hpf(at(0)), 20);
    const top = hpf(at(span - 0.25));
    assert.ok(top >= 700 && top <= 1300, `the lows are drained by the last quarter beat: ${top} Hz`);
    assert.ok(hpf(at(span - 0.125)) < top && hpf(at(span - 0.125)) > 20, 'reopening during the last quarter beat');
    assert.equal(hpf(at(span) - REOPEN_AHEAD_S), 20, 'fully open ahead of the downbeat');
    assert.equal(hpf(at(span)), 20);
    assert.equal(REOPEN_AHEAD_S, SWAP_AHEAD_S, 'the kick starts a little ahead of the grid: the same margin a bass swap keeps');
    // nothing of the trick is scheduled on or after its drop
    assert.ok(lane.events.every((e) => e.p === 'hpf' && e.t < at(span)));
    assert.ok(at(span) - REOPEN_AHEAD_S - at(span - 0.25) >= 0.06, 'the reopening is a sweep (60 ms or more), not a snap');
  }
});

test('first(): fade-in with an opening low-pass from the first bar line', () => {
  const A = synthAnalysis({ bpm: 100, duration: 30, first: 0.4, downbeat: 2, cueStart: 1 });
  const planner = createPlanner({ seed: 'open' });
  const tr = planner.first({ id: 'a', analysis: A }, { startAt: 7 });
  assert.equal(tr.type, 'fadeIn');
  assert.equal(tr.from, -1);
  assert.equal(tr.to, 0);
  assert.deepEqual([tr.play.id, tr.play.deck, tr.play.startAt, tr.play.endAt], [0, 0, 7, null]);
  assert.equal(tr.play.offset, A.cues.in);
  assert.ok(A.beats.indexOf(tr.play.offset) % 4 === 2, 'enters on a downbeat');
  assert.deepEqual(tr.play.rate, [{ t: 7, v: 1 }]);
  assert.equal(tr.play.trimDb, A.loudness.trimDb);
  const at = (p, t) => evalParam(tr.play.events, p, t, STRIP_DEFAULTS[p]);
  assert.equal(at('gain', 7), 0);
  // every param is stated a few ms before the source starts, so the engine's pre-roll is already silent
  assert.equal(tr.play.events.filter((e) => e.t === 7 - INIT_LEAD_S && e.k === 'set').length, Object.keys(STRIP_DEFAULTS).length);
  assert.equal(at('gain', 7 - INIT_LEAD_S), 0);
  assert.ok(at('lpf', 7) >= 300 && at('lpf', 7) <= 600);
  assert.ok(tr.tEnd - tr.tStart >= 1 && tr.tEnd - tr.tStart <= 6);
  for (const [p, d] of Object.entries(STRIP_DEFAULTS)) assert.equal(at(p, tr.tEnd), d);
  assert.equal(tr.play.soloFrom, tr.tEnd);
  assert.deepEqual([tr.aEvents, tr.aRate, tr.fx, tr.fxEvents], [[], [], [], []]);
  assert.equal(planner.first({ id: 'a', analysis: A }).tStart, 0);
});

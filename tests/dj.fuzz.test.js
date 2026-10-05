// Robustness: thousands of random, often pathological pairs — the planner never throws and every
// plan satisfies every invariant in checkTransition / checkBusSessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { positionAt, timeAtPosition } from '../js/dj/timeline.js';
import { INIT_LEAD_S, RECIPES } from '../js/dj/transitions.js';
import { createRng } from '../js/util/rng.js';
import { applyOut, checkBusSessions, checkTransition, randomAnalysis, synthAnalysis } from './helpers/dj-synth.js';

const MODES = ['preview', 'short', 'medium', 'full'];
const judge = (tr, c) => [...checkTransition(tr, c), ...checkBusSessions(tr, c)];

test('fuzz: 4000 random pairs — no throw, all invariants', () => {
  const N = 4000;
  const hist = {};
  let degraded = 0;
  let plain = 0;
  let quickN = 0;
  let synced = 0;
  let replanned = 0;
  for (let n = 0; n < N; n++) {
    const r = createRng(`fuzz-${n}`);
    const mode = r.pick(MODES);
    const planner = createPlanner({ seed: `z${n}`, vibe: r.next(), mode });
    const a0 = randomAnalysis(r);
    // ~40% of pairs are tempo-related so the synced paths get exercised too; ~5% identical tracks
    const related = (base) => {
      const an = randomAnalysis(r);
      if (r.next() < 0.4) {
        const b2 = synthAnalysis({ bpm: Math.min(200, Math.max(60, base.bpm * r.range(0.9, 1.1) * r.pick([1, 1, 1, 2, 0.5]))), duration: an.duration, conf: r.range(0.5, 1), first: r.range(0, 0.3), downbeat: r.int(4), drop: an.cues.drop, jitter: r.next() < 0.3 ? 0.005 : 0, rng: r });
        return b2;
      }
      return an;
    };
    const a = r.next() < 0.05 ? a0 : related(a0);
    const b = r.next() < 0.05 ? a : related(a);
    const ctx = `case ${n} (${mode})`;
    const f = planner.first({ id: 'x', analysis: a0 }, { startAt: r.next() < 0.5 ? 0 : r.range(0, 50) });
    const t1 = planner.next({ play: f.play, analysis: a0 }, { id: 'a', analysis: a }, { earliest: f.play.startAt + r.range(0, 3) });
    let playA = t1.play;
    // earliest: usually somewhere in the outgoing track's life, sometimes pathological
    const u = r.next();
    const end = timeAtPosition(playA, a.duration);
    let earliest;
    if (u < 0.05) earliest = playA.startAt - r.range(0, 50);
    else if (u < 0.1) earliest = playA.startAt + 1e5;
    else if (u < 0.15) earliest = playA.soloFrom + r.range(0, 0.05);
    else if (u < 0.22) earliest = end + r.range(-1.5, 1.5); // right around the end of the buffer
    else if (u < 0.3) earliest = end + r.range(0, 60); // past the end
    else earliest = playA.startAt + r.next() ** 2 * (end - playA.startAt);
    const quick = r.next() < 0.3;
    const opts = { earliest, quick };
    if (quick && r.next() < 0.6) {
      // a transition had already been planned and handed to the engine when Skip cancelled it
      const planned = planner.next({ play: playA, analysis: a }, { id: 'c', analysis: randomAnalysis(r) }, { earliest: playA.startAt + 0.5 });
      playA = applyOut(playA, planned);
      if (r.next() < 0.5) opts.cancelledAt = earliest - 0.25;
      replanned++;
    }
    const prev = { play: playA, analysis: a };
    const incoming = { id: 'b', analysis: b };
    let tr;
    assert.doesNotThrow(() => {
      tr = planner.next(prev, incoming, opts);
    }, ctx);
    assert.deepEqual(judge(tr, { prev, incoming, opts }), [], `${ctx} ${tr.type} ${tr.label}`);
    assert.deepEqual(judge(t1, { prev: { play: f.play, analysis: a0 }, incoming: { id: 'a', analysis: a }, opts: { earliest: f.play.startAt } }).filter((x) => !/earliest/.test(x)), [], `${ctx} (first hop)`);
    hist[tr.type] = (hist[tr.type] || 0) + 1;
    if (tr.degraded) degraded++;
    if (tr.type === 'fadeIn') plain++;
    if (quick) quickN++;
    if (tr.synced) synced++;
    // a plain entry is only ever returned when the outgoing track really has (almost) nothing left
    if (tr.type === 'fadeIn') {
      const t0 = Math.max(earliest, playA.soloFrom, playA.startAt);
      assert.ok(!(end - t0 > 0.12), `${ctx}: plain entry with ${end - t0}s of audio left`);
      assert.ok(tr.play.events[0].t === t0 && Math.abs(tr.tStart - INIT_LEAD_S - t0) < 1e-9, 'enters at earliest (strip set up there, source 8 ms later)');
    }
  }
  console.log(`      fuzz: ${N} pairs · types ${JSON.stringify(hist)} · synced ${synced} · quick ${quickN} (${replanned} with a cancelled plan) · degraded ${degraded} (of which plain entries ${plain})`);
  for (const t of [...Object.keys(RECIPES), 'fadeIn']) assert.ok(hist[t] > 0, `${t} never produced`);
  assert.ok(synced > 300 && quickN > 800);
  // the safety net is for genuinely hopeless situations, not a crutch for ordinary ones
  assert.ok(degraded - plain < 0.03 * N, `micro-crossfade fallbacks: ${degraded - plain}`);
});

test('quick: true at any moment of a track’s life', () => {
  for (const [bpmA, bpmB, durA] of [[124, 126, 30], [90, 150, 30], [128, 128, 200], [174, 87, 45]]) {
    const A = synthAnalysis({ bpm: bpmA, duration: durA });
    const B = synthAnalysis({ bpm: bpmB, duration: 30 });
    const planner = createPlanner({ seed: `skip${bpmA}`, vibe: 0.6 });
    const f = planner.first({ id: 'a', analysis: A }, { startAt: 1 });
    const prev = { play: f.play, analysis: A };
    const incoming = { id: 'b', analysis: B };
    const end = timeAtPosition(f.play, A.duration);
    const types = new Set();
    let k = 0;
    for (let now = 0; now < end + 3; now += 0.137) {
      const opts = { earliest: now + 0.25, quick: true, cancelledAt: now };
      // (a different seed per press: with one seed the same pair always gets the same move, by design)
      const tr = createPlanner({ seed: `skip${bpmA}-${k++}`, vibe: 0.6 }).next(prev, incoming, opts);
      assert.deepEqual(judge(tr, { prev, incoming, opts }), [], `skip at ${now}`);
      const t0 = Math.max(opts.earliest, f.play.soloFrom);
      if (end - t0 > 2.5) {
        // Skip is prompt and short: starts on the first beat ≥ earliest, done within a bar or so
        const beatSec = 60 / bpmA;
        assert.ok(tr.tStart - t0 <= beatSec + 0.07, `starts within a beat (${tr.tStart - t0}s) at ${now}`);
        assert.ok(tr.tStart - t0 >= 0, 'not before earliest');
        assert.ok(tr.beats <= 4, `short: ${tr.label}`);
        assert.ok(tr.tEnd - t0 <= 5 * beatSec + 0.1, `over quickly: ${tr.tEnd - t0}s`);
        assert.equal(tr.degraded, undefined);
        const pos = positionAt(f.play, tr.beats > 0 ? tr.tStart : tr.tEnd);
        assert.ok(A.beats.some((x) => Math.abs(x - pos) < 1e-6), 'on a beat of the outgoing track');
      }
      types.add(tr.type);
    }
    assert.ok(types.size >= 5, `skips are not all the same move: ${[...types]}`);
  }
});

test('awkward inputs: short clips, dead grids, missing cues, garbage analyses', () => {
  const planner = createPlanner({ seed: 'awkward', vibe: 0.5 });
  const ok = synthAnalysis({ bpm: 120, duration: 30 });
  const cases = {
    tiny: synthAnalysis({ bpm: 120, duration: 6 }),
    tinySlow: synthAnalysis({ bpm: 61, duration: 6.5 }),
    noBeat: synthAnalysis({ bpm: 120, duration: 30, conf: 0 }),
    noDrop: synthAnalysis({ bpm: 126, duration: 30, drop: null }),
    empty: {},
    nans: { duration: NaN, bpm: NaN, bpmConfidence: NaN, beats: [NaN, 1, 0.5, Infinity], downbeat: NaN, cues: { start: NaN, end: NaN, in: NaN, drop: NaN }, loudness: { trimDb: NaN }, key: null },
    noBeats: { ...synthAnalysis({ bpm: 100, duration: 20 }), beats: [] },
    typed: { ...ok, beats: Float32Array.from(ok.beats) },
    negCue: { ...ok, cues: { start: -5, end: 9999, in: -1, drop: -3 } },
  };
  for (const [nameA, A] of Object.entries(cases)) for (const [nameB, B] of Object.entries(cases)) {
    const tag = `${nameA} → ${nameB}`;
    let f;
    let tr;
    assert.doesNotThrow(() => {
      f = planner.first({ id: 'a', analysis: A }, { startAt: 2 });
      tr = planner.next({ play: f.play, analysis: A }, { id: 'b', analysis: B }, { earliest: 2.5 });
    }, tag);
    for (const t of [f, tr]) {
      const flat = JSON.stringify(t);
      assert.ok(!/null/.test(flat.replace(/"endAt":null/g, '')), `${tag}: NaN/Infinity leaked (${flat.slice(0, 200)})`);
      assert.ok(t.play.offset >= 0 && t.play.rate.every((q) => q.v > 0) && t.tStart >= 2 && t.tEnd >= t.tStart);
    }
    assert.ok(tr.tStart >= 2.5 && [...tr.aEvents, ...tr.play.events, ...tr.fxEvents, ...tr.fx].every((e) => e.t >= 2.5), tag);
    // full invariants whenever both analyses are well-formed
    if (!['empty', 'nans'].includes(nameA) && !['empty', 'nans'].includes(nameB)) {
      const fix = (an) => ({ ...an, beats: Array.from(an.beats), loudness: an.loudness, duration: an.duration });
      const bad = judge(tr, { prev: { play: f.play, analysis: fix(A) }, incoming: { id: 'b', analysis: fix(B) }, opts: { earliest: 2.5 } });
      assert.deepEqual(bad, [], tag);
    }
  }
  // clips shorter than expected degrade to short moves, never to long blends
  for (let s = 0; s < 100; s++) {
    const p = createPlanner({ seed: `tiny${s}`, vibe: s / 100, mode: MODES[s % 4] });
    const f = p.first({ id: 'a', analysis: cases.tiny });
    const tr = p.next({ play: f.play, analysis: cases.tiny }, { id: 'b', analysis: ok }, { earliest: 0.2 });
    assert.ok(tr.beats <= 4, `6 s clip got ${tr.label}`);
    assert.ok(positionAt(f.play, tr.aEndAt) <= 6);
    const into = p.next({ play: p.first({ id: 'a', analysis: ok }).play, analysis: ok }, { id: 'b', analysis: cases.tiny }, { earliest: 0.2 });
    assert.ok(positionAt(into.play, into.play.soloFrom) <= 6 - 60 / 120, 'the short incoming clip keeps something to play');
  }
});

test('earliest far in the future or past the end of the outgoing track → plain entry at earliest', () => {
  const A = synthAnalysis({ bpm: 120, duration: 30 });
  const B = synthAnalysis({ bpm: 100, duration: 30, cueStart: 0.5 });
  const planner = createPlanner({ seed: 'late' });
  const f = planner.first({ id: 'a', analysis: A }, { startAt: 10 });
  const prev = { play: f.play, analysis: A };
  for (const earliest of [40.5, 41, 100, 1e6, 12345678.9]) for (const quick of [false, true]) {
    const tr = planner.next(prev, { id: 'b', analysis: B }, { earliest, quick });
    assert.equal(tr.type, 'fadeIn');
    assert.equal(tr.degraded, true);
    assert.equal(tr.from, 0);
    assert.equal(tr.play.events[0].t, earliest, 'strip is set up at earliest …');
    assert.equal(tr.play.startAt, earliest + INIT_LEAD_S, '… and the source starts a few ms later');
    assert.equal(tr.tStart, tr.play.startAt);
    assert.equal(tr.play.offset, B.cues.in);
    assert.deepEqual([tr.aEvents, tr.aRate, tr.fx, tr.fxEvents], [[], [], [], []], 'nothing is scheduled for a track that is over');
    assert.ok(tr.aEndAt <= earliest && Math.abs(tr.aEndAt - (10 + 30 - A.cues.in)) < 0.05, `outgoing stops where its audio ends (${tr.aEndAt})`);
    assert.ok(tr.tEnd - tr.tStart <= 1.5, 'quick fade-in, the floor is silent');
    assert.match(tr.why, /previous track had ended/);
  }
  // with a little audio left there is still a (tiny) handover rather than a gap
  const end = timeAtPosition(f.play, A.duration);
  for (const left of [0.9, 0.5, 0.2, 0.09]) {
    const tr = planner.next(prev, { id: 'b', analysis: B }, { earliest: end - left });
    assert.notEqual(tr.type, 'fadeIn', `${left}s left`);
    assert.ok(tr.tEnd <= end && tr.aEndAt <= end, `${left}s left: done before the buffer ends`);
    assert.deepEqual(judge(tr, { prev, incoming: { id: 'b', analysis: B }, opts: { earliest: end - left } }), []);
  }
  // earliest before the track even started: clamped to its solo point, nothing in the past
  const early = planner.next(prev, { id: 'b', analysis: B }, { earliest: -500 });
  assert.ok(early.tStart >= f.play.soloFrom && early.aEvents.every((e) => e.t >= f.play.soloFrom));
  // missing / non-finite earliest never produces NaN
  for (const e of [undefined, NaN, Infinity]) {
    const tr = planner.next(prev, { id: 'b', analysis: B }, { earliest: e });
    assert.ok(Number.isFinite(tr.tStart) && Number.isFinite(tr.tEnd) && tr.tStart >= f.play.soloFrom);
  }
  assert.ok(Number.isFinite(planner.next(prev, { id: 'b', analysis: B }).tStart), 'opts omitted');
});

test('incomplete plays and missing arguments never throw', () => {
  const A = synthAnalysis({ bpm: 120, duration: 30 });
  const B = synthAnalysis({ bpm: 122, duration: 30 });
  const planner = createPlanner({ seed: 'holes' });
  const f = planner.first({ id: 'a', analysis: A }, { startAt: 3 });
  const inc = { id: 'b', analysis: B };
  const strip = (o, ...keys) => {
    const c = { ...o };
    for (const k of keys) delete c[k];
    return c;
  };
  const plays = {
    noRate: strip(f.play, 'rate'),
    emptyRate: { ...f.play, rate: [] },
    junkRate: { ...f.play, rate: [null, { t: NaN, v: 1 }, { t: 3, v: 0 }, { t: 3, v: -1 }, { t: 4, v: Infinity }] },
    noEvents: strip(f.play, 'events'),
    noSolo: strip(f.play, 'soloFrom', 'via'),
    bare: { startAt: 3 },
    empty: {},
    nanStart: { ...f.play, startAt: NaN, offset: NaN },
  };
  for (const [name, play] of Object.entries(plays)) for (const quick of [false, true]) for (const earliest of [3.5, 20, 500]) {
    let tr;
    assert.doesNotThrow(() => {
      tr = planner.next({ play, analysis: A }, inc, { earliest, quick });
    }, `${name} quick ${quick} earliest ${earliest}`);
    const flat = JSON.stringify(tr);
    assert.ok(!/null/.test(flat.replace(/"endAt":null/g, '')), `${name}: NaN/Infinity leaked`);
    assert.ok(tr.tStart >= earliest - 1e-9 && tr.play.offset >= 0 && tr.play.rate.every((q) => q.v > 0), name);
    assert.ok([...tr.aEvents, ...tr.play.events, ...tr.fxEvents, ...tr.fx].every((e) => e.t >= earliest - 1e-9), name);
    assert.ok(positionAt(tr.play, tr.play.soloFrom) <= B.duration + 1e-6);
  }
  // nothing to mix out of → an opener at `earliest`; no incoming track → still a well-formed plan
  for (const prev of [null, undefined, {}, { analysis: A }]) {
    const tr = planner.next(prev, inc, { earliest: 12 });
    assert.equal(tr.type, 'fadeIn');
    assert.equal(tr.from, -1);
    assert.equal(tr.play.startAt, 12 + INIT_LEAD_S);
    assert.ok(tr.tStart >= 12 && tr.play.events.every((e) => e.t >= 12), 'nothing before earliest');
  }
  for (const incoming of [null, undefined, {}, { id: 'x' }]) {
    assert.doesNotThrow(() => planner.next({ play: f.play, analysis: A }, incoming, { earliest: 5 }));
    assert.doesNotThrow(() => planner.first(incoming));
    assert.doesNotThrow(() => planner.next(null, incoming));
  }
  assert.doesNotThrow(() => planner.next({ play: f.play }, inc, { earliest: 5 }), 'outgoing analysis missing');
  assert.deepEqual(planner.order(null), []);
  assert.deepEqual(planner.order(undefined), []);
});

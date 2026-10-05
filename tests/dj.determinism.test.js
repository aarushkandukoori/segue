// Same seed + same inputs ⇒ deep-equal plans regardless of call history; different seeds ⇒ different sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { createRng } from '../js/util/rng.js';
import { simulateSet, synthAnalysis, synthCrate } from './helpers/dj-synth.js';

const crate = () => synthCrate(createRng('det-crate'), 24);

test('plans are a pure function of (seed, vibe, mode, inputs) — call history does not matter', () => {
  for (const mode of ['preview', 'short', 'full']) for (const vibe of [0.1, 0.9]) {
    const tracks = synthCrate(createRng('det-' + mode), 24, { full: mode !== 'preview' });
    const p1 = createPlanner({ seed: 'same', vibe, mode });
    const ref = simulateSet(p1, tracks, 20, { check: false });

    // A second planner is "warmed up" with unrelated calls, then asked the same questions out of order.
    const p2 = createPlanner({ seed: 'same', vibe, mode });
    p2.order(['x', 'y', 'z']);
    p2.chooseNext(null, tracks.slice(3, 9), { playIndex: 5, recentArtists: ['Artist 1'] });
    p2.first(tracks[7]);
    p2.next({ play: p2.first(tracks[2]).play, analysis: tracks[2].analysis }, tracks[9], { earliest: 3, quick: true });
    const byId = new Map(tracks.map((t) => [t.id, t]));
    for (let n = ref.transitions.length - 1; n >= 1; n--) {
      const before = ref.plays[n - 1];
      // the outgoing play as it was when the transition was planned (before aEvents were appended)
      const pristine = { ...before, events: before.events.slice(0, before.events.length - ref.transitions[n].aEvents.length), rate: before.rate.slice(0, before.rate.length - ref.transitions[n].aRate.length), endAt: null };
      const again = p2.next({ play: pristine, analysis: byId.get(before.trackId).analysis }, byId.get(ref.picks[n]), { earliest: pristine.startAt + 2 });
      assert.deepStrictEqual(again, ref.transitions[n], `${mode} vibe ${vibe} transition ${n}`);
    }
    assert.deepStrictEqual(p2.first(byId.get(ref.picks[0]), { startAt: 0 }), ref.transitions[0]);
    assert.deepStrictEqual(p2.order(tracks.map((t) => t.id)), p1.order(tracks.map((t) => t.id)));
    // and a whole fresh run is identical too
    const fresh = simulateSet(createPlanner({ seed: 'same', vibe, mode }), tracks, 20, { check: false });
    assert.deepStrictEqual(fresh.picks, ref.picks);
    assert.deepStrictEqual(fresh.transitions, ref.transitions);
  }
});

test('plans survive JSON (no undefined / NaN / −0 hiding in them) and do not alias their inputs', () => {
  const tracks = crate();
  const planner = createPlanner({ seed: 'json', vibe: 0.7 });
  const sim = simulateSet(planner, tracks, 25, { check: false });
  for (const tr of sim.transitions) assert.deepStrictEqual(JSON.parse(JSON.stringify(tr)), tr);
  // next() must not mutate the play or the analyses it is given
  const f = planner.first(tracks[0]);
  const frozen = JSON.stringify([f.play, tracks[0].analysis.cues, tracks[1].analysis.cues]);
  const t1 = planner.next({ play: f.play, analysis: tracks[0].analysis }, tracks[1], { earliest: 1 });
  planner.next({ play: f.play, analysis: tracks[0].analysis }, tracks[1], { earliest: 1, quick: true });
  assert.equal(JSON.stringify([f.play, tracks[0].analysis.cues, tracks[1].analysis.cues]), frozen);
  assert.notEqual(t1.play.events, f.play.events);
});

test('numeric and string seeds are the same seed; settings are part of the function', () => {
  const tracks = crate();
  const a = simulateSet(createPlanner({ seed: 1234 }), tracks, 12, { check: false });
  const b = simulateSet(createPlanner({ seed: '1234' }), tracks, 12, { check: false });
  assert.deepStrictEqual(a.transitions, b.transitions);
  const p = createPlanner({ seed: 'live', vibe: 0.2, mode: 'preview' });
  assert.deepEqual([p.seed, p.vibe, p.mode], ['live', 0.2, 'preview']);
  p.setVibe(0.9);
  p.setMode('full');
  p.setVibe(NaN);
  p.setMode('nonsense');
  assert.deepEqual([p.vibe, p.mode], [0.9, 'full']);
  const q = createPlanner({ seed: 'live', vibe: 0.9, mode: 'full' });
  const f = p.first(tracks[0]);
  assert.deepStrictEqual(p.next({ play: f.play, analysis: tracks[0].analysis }, tracks[1], { earliest: 1 }), q.next({ play: q.first(tracks[0]).play, analysis: tracks[0].analysis }, tracks[1], { earliest: 1 }));
  // defaults + clamping
  const d = createPlanner({ seed: 's', vibe: 7, mode: 'weird' });
  assert.deepEqual([d.vibe, d.mode], [1, 'preview']);
  assert.equal(createPlanner({ seed: 's' }).vibe, 0.5);
});

test('different seeds → different orders, picks and transition types', () => {
  const tracks = crate();
  const ids = tracks.map((t) => t.id);
  const orders = new Set();
  const typeSeqs = new Set();
  const pickSeqs = new Set();
  const firstTypes = new Set();
  // the same pair of tracks, 40 seeds: the move between them changes with the seed
  const A = synthAnalysis({ bpm: 124 });
  const B = synthAnalysis({ bpm: 126, pc: 7 });
  for (let s = 0; s < 40; s++) {
    const planner = createPlanner({ seed: `seed-${s}` });
    const order = planner.order(ids);
    assert.deepEqual([...order].sort(), [...ids].sort(), 'order is a permutation');
    assert.deepEqual(planner.order(ids), order);
    orders.add(order.join());
    const sim = simulateSet(planner, tracks, 12, { check: false });
    typeSeqs.add(sim.transitions.map((t) => t.type).join());
    pickSeqs.add(sim.picks.join());
    const f = planner.first({ id: 'a', analysis: A });
    firstTypes.add(planner.next({ play: f.play, analysis: A }, { id: 'b', analysis: B }, { earliest: 1 }).type);
  }
  assert.equal(orders.size, 40);
  assert.ok(pickSeqs.size >= 39, `pick sequences ${pickSeqs.size}`);
  assert.ok(typeSeqs.size >= 39, `type sequences ${typeSeqs.size}`);
  assert.ok(firstTypes.size >= 5, `same pair, 40 seeds → ${[...firstTypes]}`);
  assert.deepEqual(createPlanner({ seed: 1 }).order([]), []);
  assert.deepEqual(createPlanner({ seed: 1 }).order(['only']), ['only']);
});

// Whole sets in plan space: the planner is driven the way the conductor drives it (seeded base order,
// crate window of 5, chooseNext, next()), 60 plays per set, several seeds × modes × vibes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { positionAt } from '../js/dj/timeline.js';
import { RECIPES } from '../js/dj/transitions.js';
import { createRng } from '../js/util/rng.js';
import { simulateSet, synthAnalysis, synthCrate } from './helpers/dj-synth.js';

const SEEDS = 6;
const PLAYS = 60;

function runs(mode, vibe) {
  const out = [];
  for (let s = 0; s < SEEDS; s++) {
    const tracks = synthCrate(createRng(`set-crate-${s}`), 40, { full: mode !== 'preview' });
    const planner = createPlanner({ seed: `set-${s}`, vibe, mode });
    out.push({ tracks, sim: simulateSet(planner, tracks, PLAYS) });
  }
  return out;
}

function stats(all) {
  const st = { hist: {}, n: 0, net: 0, solo: 0, minSolo: Infinity, synced: 0, repeats: 0, pairs: 0, degraded: 0, tricks: 0 };
  for (const { sim } of all) {
    for (let i = 1; i < sim.transitions.length; i++) {
      const tr = sim.transitions[i];
      const before = sim.transitions[i - 1];
      st.hist[tr.type] = (st.hist[tr.type] || 0) + 1;
      st.n++;
      st.net += tr.tEnd - before.tEnd; // set time one track "costs": solo point to solo point
      st.solo += tr.tStart - before.tEnd;
      st.minSolo = Math.min(st.minSolo, tr.tStart - before.tEnd);
      if (tr.synced) st.synced++;
      if (tr.degraded) st.degraded++;
      st.tricks += tr.marks.filter((m) => ['Filter dip', 'Echo throw', 'Beat repeat', 'Build'].includes(m.label)).length;
      if (i > 1) {
        st.pairs++;
        if (tr.type === before.type) st.repeats++;
      }
    }
  }
  // chance of two equal types in a row if types were drawn independently with the observed frequencies
  st.chance = Object.values(st.hist).reduce((acc, c) => acc + (c / st.n) ** 2, 0);
  return st;
}

const fmt = (st) =>
  `net ${(st.net / st.n).toFixed(1)} s/track · solo ${(st.solo / st.n).toFixed(1)} s (min ${st.minSolo.toFixed(1)}) · synced ${Math.round((100 * st.synced) / st.n)}% · ` +
  `same-type-twice ${((100 * st.repeats) / st.pairs).toFixed(1)}% (chance ${(100 * st.chance).toFixed(1)}%) · tricks ${(st.tricks / st.n).toFixed(2)}/track · ${JSON.stringify(st.hist)}`;

const total = { hist: {}, n: 0 };

for (const mode of ['preview', 'short', 'medium', 'full']) {
  test(`whole sets (${mode}): 60 plays × ${SEEDS} seeds × 3 vibes`, () => {
    for (const vibe of [0, 0.5, 1]) {
      const all = runs(mode, vibe);
      for (const { tracks, sim } of all) {
        assert.deepEqual(sim.violations.slice(0, 5), [], `${mode} vibe ${vibe}`);
        const byId = new Map(tracks.map((t) => [t.id, t]));
        assert.equal(sim.plays.length, PLAYS);
        for (let n = 0; n < PLAYS; n++) {
          const play = sim.plays[n];
          const tr = sim.transitions[n];
          assert.equal(play.id, n);
          assert.equal(play.deck, n % 2, 'decks alternate');
          assert.equal(tr.to, n);
          assert.equal(tr.from, n - 1);
          if (n === 0) continue;
          const before = sim.plays[n - 1];
          const prevTr = sim.transitions[n - 1];
          // set time strictly advances, one transition at a time
          assert.ok(play.startAt > before.startAt && play.soloFrom > before.soloFrom && tr.tEnd > prevTr.tEnd);
          assert.ok(tr.tStart >= prevTr.tEnd, 'never three tracks at once');
          // no dead air: the outgoing source runs until the incoming one has started
          assert.ok(before.endAt >= play.startAt - 1e-9, `gap before play ${n}`);
          assert.ok(positionAt({ ...before, endAt: null }, before.endAt) <= byId.get(before.trackId).analysis.duration + 1e-6);
          // the finished play's complete automation is one well-formed, time-ordered list
          let last = -Infinity;
          const seen = new Set();
          for (const e of before.events) {
            assert.ok(e.t >= last, `play ${n - 1}: events out of order`);
            last = e.t;
            if (e.k !== 'set') assert.ok(seen.has(e.p), `play ${n - 1}: ${e.p} ramp without anchor`);
            seen.add(e.p);
          }
          for (let i = 1; i < before.rate.length; i++) assert.ok(before.rate[i].t >= before.rate[i - 1].t && before.rate[i].v > 0);
          // audible solo time whenever the clip allows it
          const solo = tr.tStart - prevTr.tEnd;
          const clip = byId.get(before.trackId).analysis.duration;
          if (mode === 'preview' && clip >= 26) assert.ok(solo >= 4, `play ${n - 1}: only ${solo.toFixed(2)} s solo of a ${clip.toFixed(1)} s clip`);
          // longer modes: at least four bars to itself (16 beats; its rate may be up to 8% off while gliding)
          const fourBars = 16 * (60 / byId.get(before.trackId).analysis.bpm);
          if (mode !== 'preview') assert.ok(solo >= fourBars * 0.9, `play ${n - 1}: only ${solo.toFixed(2)} s solo`);
        }
        // the delay bus is never claimed twice at once across the whole set
        let busFree = -Infinity;
        for (const tr of sim.transitions) {
          if (!tr.fxEvents.length) continue;
          assert.ok(tr.fxEvents[0].t >= busFree, 'delay bus sessions of consecutive transitions overlap');
          busFree = tr.fxEvents[tr.fxEvents.length - 1].t;
        }
        // endless crate: no immediate repeats, the whole crate is played before anything comes back
        for (let n = 1; n < PLAYS; n++) assert.notEqual(sim.picks[n], sim.picks[n - 1]);
        assert.equal(new Set(sim.picks.slice(0, 40)).size, 40);
      }
      const st = stats(all);
      console.log(`      ${mode} vibe ${vibe}: ${fmt(st)}`);
      assert.equal(st.degraded, 0, 'no fallback plans in an ordinary set');
      assert.ok(st.repeats / st.pairs < st.chance, `same type twice in a row ${st.repeats / st.pairs} vs chance ${st.chance}`);
      const net = st.net / st.n;
      if (mode === 'preview') assert.ok(net > 19 && net < 29.5, `net set time per ~30 s preview: ${net}`);
      if (mode === 'short') assert.ok(net > 32 && net < 55, `short ≈ 45 s: ${net}`);
      if (mode === 'medium') assert.ok(net > 70 && net < 105, `medium ≈ 90 s: ${net}`);
      if (mode === 'full') assert.ok(net > 140, `full plays the tracks: ${net}`);
      for (const [t, c] of Object.entries(st.hist)) total.hist[t] = (total.hist[t] || 0) + c;
      total.n += st.n;
      if (vibe === 0.5) for (const t of Object.keys(RECIPES)) assert.ok(st.hist[t] > 0, `${mode}: ${t} never appeared across ${SEEDS} seeds`);
    }
  });
}

test('whole sets: every transition type appears; overall mix is sane', () => {
  assert.ok(total.n > 4000, 'run after the per-mode sets');
  console.log(`      all sets: ${total.n} transitions · ${JSON.stringify(Object.fromEntries(Object.entries(total.hist).sort((a, b) => b[1] - a[1])))}`);
  for (const t of Object.keys(RECIPES)) {
    assert.ok(total.hist[t] / total.n > 0.02, `${t} is vanishingly rare (${total.hist[t]})`);
    assert.ok(total.hist[t] / total.n < 0.3, `${t} dominates (${total.hist[t]})`);
  }
  assert.equal(total.hist.fadeIn, undefined, 'fade-ins are for openers only');
});

test('a two-track crate keeps going', () => {
  const tracks = [
    { id: 'a', artist: 'A', analysis: synthAnalysis({ bpm: 122, duration: 30 }) },
    { id: 'b', artist: 'B', analysis: synthAnalysis({ bpm: 96, duration: 28, pc: 3, mode: 'minor' }) },
  ];
  for (const mode of ['preview', 'full']) for (let s = 0; s < 5; s++) {
    const sim = simulateSet(createPlanner({ seed: `two${s}`, mode }), tracks, 30);
    assert.deepEqual(sim.violations, []);
    for (let n = 1; n < 30; n++) assert.notEqual(sim.picks[n], sim.picks[n - 1]);
    assert.ok(sim.transitions.slice(1).every((t) => !t.degraded && !t.synced));
    assert.ok(new Set(sim.transitions.slice(1).map((t) => t.type)).size >= 3);
  }
  // the same track back to back (a one-track "crate", or a duplicate in the playlist)
  const one = [tracks[0], { ...tracks[0], id: 'a2' }];
  const sim = simulateSet(createPlanner({ seed: 'dup' }), one, 12);
  assert.deepEqual(sim.violations, []);
  assert.ok(sim.transitions.slice(1).some((t) => t.synced), 'identical tempo → beat-matched');
});

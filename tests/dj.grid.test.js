// The grid-trust gate: two tracks are overlapped beat on beat only where Analysis.grid vouches for the
// beat phase of both (planner.js canOverlap). Everything else about a plan is covered by the other
// dj.*.test.js files; here it is only about WHEN the planner lets itself blend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { RECIPES } from '../js/dj/transitions.js';
import { positionAt } from '../js/dj/timeline.js';
import { createRng } from '../js/util/rng.js';
import { beatAlignment, checkBusSessions, checkTransition, simulateSet, synthAnalysis, synthCrate, synthGrid } from './helpers/dj-synth.js';

const isBlend = (tr) => !!RECIPES[tr.type] && RECIPES[tr.type].overlap && RECIPES[tr.type].sync === 'required';
const HANDOVERS = ['echoOut', 'cut', 'spinback', 'brake', 'loopRoll', 'riserDrop'];

/** n plans A → B with different seeds; every one is checked against the planner's invariants. */
function plans(A, B, { n = 300, vibe = 0.5, mode = 'preview', earliest = 1, force } = {}) {
  const out = [];
  for (let s = 0; s < n; s++) {
    const planner = createPlanner({ seed: `gate${s}`, vibe, mode });
    const f = planner.first({ id: 'a', analysis: A });
    const prev = { play: f.play, analysis: A };
    const incoming = { id: 'b', analysis: B };
    const opts = force ? { earliest, force } : { earliest };
    const tr = planner.next(prev, incoming, opts);
    assert.deepEqual([...checkTransition(tr, { prev, incoming, opts }), ...checkBusSessions(tr, { prev, incoming, opts })], [], `seed ${s} ${tr.type}`);
    assert.equal(tr.degraded, undefined, `seed ${s}: fallback plan`);
    out.push({ tr, f });
  }
  return out;
}
const hist = (list) => {
  const h = { blend: 0, synced: 0 };
  for (const { tr } of list) {
    h[tr.type] = (h[tr.type] || 0) + 1;
    if (isBlend(tr)) h.blend++;
    if (tr.synced) h.synced++;
  }
  return h;
};
const track = (o = {}) => synthAnalysis({ bpm: 124, pc: 0, keyConf: 0.9, grid: true, ...o });

test('clear grids on both sides of the join: blended as ever, and the plan says what the gate saw', () => {
  const list = plans(track(), track({ bpm: 126 }));
  const h = hist(list);
  assert.ok(h.blend > 0.6 * list.length, `blends ${h.blend} of ${list.length}`);
  for (const { tr } of list.filter((x) => isBlend(x.tr))) {
    assert.ok([8, 16].includes(tr.beats), `preview blend of ${tr.beats} beats`);
    assert.equal(tr.trust.ok, true);
    assert.ok(tr.trust.out >= 0.5 && tr.trust.in >= 0.5 && tr.trust.contrast >= 1.05, JSON.stringify(tr.trust));
  }
  // only blends carry it
  for (const { tr } of list.filter((x) => !isBlend(x.tr))) assert.equal(tr.trust, undefined);
});

test('an analysis without grid trust is taken at its bpmConfidence: nothing changes for it', () => {
  const bare = synthAnalysis({ bpm: 124, pc: 0, keyConf: 0.9 });
  assert.equal(bare.grid, undefined);
  for (const [A, B] of [[bare, track({ bpm: 126 })], [track(), synthAnalysis({ bpm: 126, pc: 0, keyConf: 0.9 })], [bare, synthAnalysis({ bpm: 126, pc: 0, keyConf: 0.9 })]]) {
    const h = hist(plans(A, B, { n: 200 }));
    assert.ok(h.blend > 0.7 * 200, `blends ${h.blend}`);
  }
});

test('unclear tail of the outgoing track: never overlapped; handed over on the bar line, tempo carried where it can be', () => {
  const A = track({ grid: { tail: 0.1 } });
  const B = track({ bpm: 126 });
  const list = plans(A, B, { n: 400 });
  const h = hist(list);
  assert.equal(h.blend, 0, 'no overlapping beat-matched blend through an unclear tail');
  for (const t of [...HANDOVERS, 'reverbWash']) assert.ok(h[t] > 0, `${t} still used`);
  for (const { tr } of list) {
    assert.match(tr.why, /tempos match, but the drums would clash — kept apart$/, tr.why);
    const p = { ...tr.play, endAt: null };
    if (tr.type === 'reverbWash') {
      // the one unsynced overlap is kept short (preview: 4 beats), and still starts the track on its first bar
      assert.equal(tr.beats, 4);
      assert.ok(Math.abs(positionAt(p, tr.play.startAt) - B.cues.in) < 2e-3);
    } else {
      // the incoming track's first downbeat lands exactly where the outgoing one is cut
      assert.ok(Math.abs(positionAt(p, tr.tEnd) - B.cues.in) < 2e-3, `${tr.type}: enters ${positionAt(p, tr.tEnd)} vs cue ${B.cues.in}`);
    }
  }
  // 124 → 126 BPM is inside the drop-in tolerance: the moves that can carry the tempo over still do
  const carried = list.filter(({ tr }) => ['cut', 'loopRoll', 'riserDrop'].includes(tr.type));
  assert.ok(carried.length > 20 && carried.every(({ tr }) => tr.synced), 'cut / roll / riser keep the tempo');
  assert.ok(list.filter(({ tr }) => ['echoOut', 'spinback', 'brake', 'reverbWash'].includes(tr.type)).every(({ tr }) => !tr.synced));
});

test('unclear head of the incoming track: never overlapped either', () => {
  const list = plans(track(), track({ bpm: 126, grid: { head: 0.05 } }), { n: 300 });
  assert.equal(hist(list).blend, 0);
  // … while the same two tracks the other way round (clear tail into clear head) blend
  const back = plans(track({ bpm: 126, grid: { head: 0.05 } }), track(), { n: 300 });
  assert.ok(hist(back).blend > 0.6 * 300, `the unclear head does not stop the track being blended OUT of: ${hist(back).blend}`);
});

test('both ends clear on their own, but the attack patterns interleave: no blend', () => {
  // B's loud hits sit half a beat after its beats (grid half a beat off, or an off-beat rhythm): laid
  // beat on beat, the two tracks' drums would alternate.
  const B = track({ bpm: 126, grid: { hits: [8] } });
  assert.equal(hist(plans(track(), B, { n: 300 })).blend, 0);
  // equally strong hits on and between the beats on both sides: no lag is better than another
  const busy = { hits: [0, 8, 4, 12], floor: 100 };
  assert.equal(hist(plans(track({ grid: busy }), track({ bpm: 126, grid: busy }), { n: 300 })).blend, 0);
  // a syncopated intro (first bars only) blocks the way in, not the way out
  const intro = track({ bpm: 126, grid: { headHits: [8] } });
  assert.equal(hist(plans(track(), intro, { n: 300 })).blend, 0);
  assert.ok(hist(plans(intro, track(), { n: 300 })).blend > 0.6 * 300);
});

test('a slot pattern that cannot be used falls back to the two trust values, strictly', () => {
  const broken = (o) => {
    const an = track(o);
    an.grid.slots = an.grid.slots.subarray(0, 5); // too short for its beats
    return an;
  };
  assert.ok(hist(plans(broken(), track({ bpm: 126 }), { n: 200 })).blend > 0.6 * 200, 'clear ends still blend without a pattern');
  // 0.3 would pass next to a matching pattern (≥ GRID_SOFT); on its own an end has to be ≥ 0.5
  assert.equal(hist(plans(broken({ grid: { tail: 0.3 } }), track({ bpm: 126 }), { n: 200 })).blend, 0);
  assert.ok(hist(plans(track({ grid: { tail: 0.3 } }), track({ bpm: 126 }), { n: 200 })).blend > 0.5 * 200, 'with matching patterns a middling end is enough');
  assert.equal(hist(plans(track({ grid: { tail: 0.1 } }), track({ bpm: 126 }), { n: 200 })).blend, 0, 'an end the analysis calls unclear is never enough');
});

test('tempo folds (×2 / ÷2) are not overlapped — unless asked for', () => {
  const A = track({ bpm: 75 });
  const B = track({ bpm: 151 });
  const natural = plans(A, B, { n: 300 });
  assert.equal(hist(natural).blend, 0);
  assert.ok(natural.every(({ tr }) => !/would clash|steady beat|too far apart/.test(tr.why)), 'a fold is not blamed on the grid, the beat or the tempos');
  // carried over on a drop-in it is labelled; everywhere else the ticker says it kept the two apart
  for (const { tr } of natural) assert.match(tr.why, tr.synced ? / · double-time · / : / · double-time apart, not blended$/, tr.why);
  for (const type of ['bassSwap', 'eqBlend', 'filterBlend']) {
    const { tr, f } = plans(A, B, { n: 1, force: { type, beats: 16 } })[0];
    assert.equal(tr.type, type);
    assert.ok(tr.synced);
    const al = beatAlignment(tr, f.play, A, B);
    assert.ok(al.worst < 0.002 && al.compared >= 8, `forced fold blend: worst ${al.worst}`);
  }
});

test('"the drums would clash" is only said when the gate is what stopped a blend', () => {
  // a 3-second incoming clip has no room for a blend, clear grids or not: that is not the grid's fault
  const tiny = track({ bpm: 126, duration: 3.2 });
  const list = plans(track(), tiny, { n: 150 });
  assert.equal(hist(list).blend, 0);
  assert.ok(list.every(({ tr }) => /no room left for a blend$/.test(tr.why)), 'no room is said as no room');
  // tempos that cannot be matched at all keep their own explanation
  const far = plans(track(), track({ bpm: 98, grid: { head: 0.05 } }), { n: 100 });
  assert.ok(far.every(({ tr }) => /tempos too far apart to match$/.test(tr.why) && !/would clash/.test(tr.why)));
});

// What the ticker tells the listener about a move that is not a beat-matched blend (Transition.why).
// The first version blamed the songs ("no steady beat to lock to") whenever the ANALYSIS was unsure of
// either track — on a chart playlist, for songs with an obvious beat. Every reason has to be true of
// the pair it is printed under.
test('the ticker reason is true of the pair: which track has no trusted beat, tempos, drums, room or choice', () => {
  const reasonOf = (tr) => {
    const m = / · ([^·→]+)$/.exec(tr.why);
    return m ? m[1] : '';
  };
  const reasons = (list) => [...new Set(list.map(({ tr }) => reasonOf(tr)))].sort();
  const steady = track();
  // 1. the analysis could not vouch for ONE of the two: that one is named, the other is not blamed
  const unsureIn = plans(steady, track({ bpm: 126, conf: 0.3 }), { n: 120 });
  assert.deepEqual(reasons(unsureIn), ['no steady beat detected in the incoming track']);
  const unsureOut = plans(track({ conf: 0.2 }), track({ bpm: 126 }), { n: 120 });
  assert.deepEqual(reasons(unsureOut), ['no steady beat detected in the outgoing track']);
  const neither = plans(track({ conf: 0.1 }), track({ bpm: 98, conf: 0 }), { n: 120 });
  assert.deepEqual(reasons(neither), ['no steady beat detected in either track']);
  for (const { tr } of [...unsureIn, ...unsureOut, ...neither]) assert.equal(tr.synced, false);
  // 2. two confident grids are never told they have no steady beat, however the pair turns out
  const confident = [
    plans(steady, track({ bpm: 98 }), { n: 120 }), // too far apart
    plans(steady, track({ bpm: 126, grid: { head: 0.05 } }), { n: 120 }), // held by the gate
    plans(steady, track({ bpm: 126 }), { n: 300 }), // blendable
    plans(track({ bpm: 75 }), track({ bpm: 151 }), { n: 120 }), // a tempo fold
    plans(steady, track({ bpm: 126, duration: 3.2 }), { n: 60 }), // no room
  ];
  for (const list of confident) for (const { tr } of list) assert.ok(!/steady beat/.test(tr.why), tr.why);
  assert.deepEqual(reasons(confident[0]), ['tempos too far apart to match']);
  assert.deepEqual(reasons(confident[1]), ['tempos match, but the drums would clash — kept apart']);
  // 3. a pair that COULD be blended: blends carry no excuse, every other move says it was a choice
  for (const { tr } of confident[2]) assert.equal(reasonOf(tr), isBlend(tr) ? '' : 'chosen for variety', tr.why);
  assert.ok(confident[2].some(({ tr }) => !isBlend(tr) && tr.synced) && confident[2].some(({ tr }) => !isBlend(tr) && !tr.synced), 'both carried and uncarried moves were seen');
  // 4. a forced blend is a blend: no reason, whatever the gate thought of it
  const forced = plans(steady, track({ bpm: 126, grid: { head: 0.05 } }), { n: 3, force: { type: 'bassSwap', beats: 8 } });
  for (const { tr } of forced) assert.equal(reasonOf(tr), '');
});

test('whole sets: every unsynced move carries a reason, and the reason agrees with the two analyses', () => {
  const fold = (r) => {
    while (r >= Math.SQRT2) r /= 2;
    while (r < Math.SQRT1_2) r *= 2;
    return r;
  };
  const seen = {};
  for (const vibe of [0, 0.5, 1]) for (let s = 0; s < 3; s++) {
    const crate = synthCrate(createRng(`why-crate-${s}`), 40, { grid: true });
    const byId = new Map(crate.map((t) => [t.id, t]));
    const sim = simulateSet(createPlanner({ seed: `why-set-${s}`, vibe, mode: 'preview' }), crate, 60);
    for (let i = 1; i < sim.transitions.length; i++) {
      const tr = sim.transitions[i];
      if (tr.degraded) continue;
      const A = byId.get(sim.picks[i - 1]).analysis;
      const B = byId.get(sim.picks[i]).analysis;
      const trusted = Math.min(A.bpmConfidence, B.bpmConfidence) >= 0.5;
      const m = / · ([^·→]+)$/.exec(tr.why);
      const reason = m ? m[1] : '';
      seen[reason.replace(/in (the \w+|either) track$/, 'in …')] = true;
      if (isBlend(tr)) {
        assert.equal(reason, '', tr.why);
        continue;
      }
      if (!tr.synced) assert.notEqual(reason, '', `unsynced ${tr.type} without a reason: ${tr.why}`);
      if (/steady beat/.test(reason)) {
        assert.equal(trusted, false, `${tr.why} — but both tempos are trusted (${A.bpmConfidence}, ${B.bpmConfidence})`);
        const named = /in the incoming track$/.test(reason) ? [B] : /in the outgoing track$/.test(reason) ? [A] : [A, B];
        assert.ok(named.every((an) => an.bpmConfidence < 0.5), `${tr.why} names a track with a trusted tempo`);
        assert.ok((named.length === 2) === (Math.max(A.bpmConfidence, B.bpmConfidence) < 0.5));
      } else {
        assert.equal(trusted, true, `${tr.why} — but a tempo is not trusted`);
      }
      // (the planner judges the outgoing tempo where the deck is at that moment; allow for its glide)
      const gap = Math.abs(fold(A.bpm / B.bpm) - 1);
      if (/too far apart/.test(reason)) assert.ok(gap > 0.05, `${tr.why} at a ${(100 * gap).toFixed(1)} % gap`);
      if (/would clash|variety|no room/.test(reason)) assert.ok(gap < 0.11, `${tr.why} at a ${(100 * gap).toFixed(1)} % gap`);
    }
  }
  for (const r of ['no steady beat detected in …', 'tempos too far apart to match', 'tempos match, but the drums would clash — kept apart', 'chosen for variety']) assert.ok(seen[r], `"${r}" was exercised (${Object.keys(seen).join(' | ')})`);
});

test('opts.force is not asked whether the grids deserve it; the plan still records that they do not', () => {
  const A = track({ grid: { tail: 0.05 } });
  const { tr, f } = plans(A, track({ bpm: 126 }), { n: 1, force: { type: 'eqBlend', beats: 16 } })[0];
  assert.equal(tr.type, 'eqBlend');
  assert.equal(tr.beats, 16);
  assert.equal(tr.trust.ok, false);
  assert.ok(tr.trust.out < 0.2);
  assert.ok(beatAlignment(tr, f.play, A, track({ bpm: 126 })).worst < 0.002);
});

test('longer modes leave mid-track: there the whole-track value (grid.phase) speaks for the outgoing side', () => {
  const long = (g) => synthAnalysis({ bpm: 124, duration: 240, pc: 0, keyConf: 0.9, grid: g });
  const B = long({});
  for (const mode of ['short', 'medium']) {
    assert.equal(hist(plans(long({ phase: 0.1 }), B, { n: 150, mode, earliest: 2 })).blend, 0, `${mode}: unclear phase`);
    const ok = hist(plans(long({ phase: 0.9, tail: 0.05 }), B, { n: 150, mode, earliest: 2 }));
    assert.ok(ok.blend > 0.5 * 150, `${mode}: a murky outro does not matter when the track is left long before it (${ok.blend})`);
  }
  // (and the incoming side is still judged at its head, where it is entered)
  assert.equal(hist(plans(long({}), long({ head: 0.05 }), { n: 150, mode: 'medium', earliest: 2 })).blend, 0);
});

test('chooseNext goes for the track it can really blend into', () => {
  const cand = (id, analysis) => ({ id, artist: id, analysis });
  const cur = cand('cur', track({ energy: 0.6 }));
  const clear = cand('clear', track({ bpm: 125, energy: 0.6 }));
  const murky = cand('murky', track({ bpm: 125, energy: 0.6, grid: { head: 0.05 } }));
  const offbeat = cand('offbeat', track({ bpm: 125, energy: 0.6, grid: { hits: [8] } }));
  const share = (id, list, mode = 'preview') => {
    let n = 0;
    for (let s = 0; s < 300; s++) {
      const p = createPlanner({ seed: `pick${s}`, vibe: 0.5, mode });
      if (list[p.chooseNext(cur, list, { playIndex: 3, recentArtists: [] })].id === id) n++;
    }
    return n / 300;
  };
  assert.ok(share('clear', [murky, clear]) > 0.85, `clear head preferred: ${share('clear', [murky, clear])}`);
  assert.ok(share('clear', [clear, offbeat]) > 0.85, 'matching pattern preferred');
  assert.ok(share('clear', [murky, clear], 'medium') > 0.85);
  // … but it is a preference among tempo matches, not a veto: a murky track still beats a tempo clash
  const far = cand('far', track({ bpm: 98, energy: 0.6 }));
  assert.ok(share('murky', [far, murky]) > 0.85);
  // and it changes nothing between tracks that carry no grid trust
  const bareA = cand('x', synthAnalysis({ bpm: 125, energy: 0.6, pc: 0, keyConf: 0.9 }));
  const bareB = cand('y', synthAnalysis({ bpm: 125, energy: 0.6, pc: 0, keyConf: 0.9 }));
  const s = share('x', [bareA, bareB]);
  assert.ok(s > 0.3 && s < 0.7, `no preference without grid trust: ${s}`);
});

test('chooseNext thinks one hand-over ahead, and spends a lost one on a track nothing could be matched with', () => {
  const cand = (id, analysis) => ({ id, artist: id, analysis });
  const cur = cand('cur', track({ energy: 0.6 }));
  const share = (id, list, n = 300) => {
    let k = 0;
    for (let s = 0; s < n; s++) {
      const p = createPlanner({ seed: `ahead${s}`, vibe: 0.5 });
      if (list[p.chooseNext(cur, list, { playIndex: 3, recentArtists: [] })].id === id) k++;
    }
    return k / n;
  };
  // Nothing here can be blended with the playing track (124 BPM); two of the three could be blended with
  // EACH OTHER afterwards, the third leads nowhere. All three are equally far from 124.
  const p = cand('p', track({ bpm: 104, energy: 0.6 }));
  const q = cand('q', track({ bpm: 105, energy: 0.6 }));
  const loner = cand('loner', track({ bpm: 147.7, energy: 0.6 }));
  assert.ok(share('loner', [loner, p, q]) < 0.12, `a dead end is left for later: ${share('loner', [loner, p, q])}`);
  // (the same loner against two tracks that lead nowhere either is picked like any other)
  const q2 = cand('q2', track({ bpm: 84, energy: 0.6 }));
  const alone = share('loner', [loner, p, q2]);
  assert.ok(alone > 0.2 && alone < 0.6, `no forecast, no preference: ${alone}`);
  // A blend that is on offer NOW is not traded for a forecast: `next` can be blended with the playing
  // track but leads nowhere, `later` cannot but leads to `next`.
  const next = cand('next', track({ bpm: 125, energy: 0.6, grid: { tailHits: [8] } }));
  const later = cand('later', track({ bpm: 125, energy: 0.6, grid: { head: 0.05 } }));
  assert.ok(share('next', [later, next]) > 0.85, `the certain blend first: ${share('next', [later, next])}`);
  // The hand-over is plain whatever is picked: it goes to the track without a trusted tempo, which could
  // not be beat-matched with anything, rather than to one that might be blended out of a later track.
  const unsure = cand('unsure', track({ bpm: 104, energy: 0.6, conf: 0.2 }));
  assert.ok(share('unsure', [p, unsure]) > 0.85, `lost hand-over spent on the unmatchable track: ${share('unsure', [p, unsure])}`);
  // … but never instead of a real blend
  const clear = cand('clear', track({ bpm: 125, energy: 0.6 }));
  assert.ok(share('clear', [unsure, clear]) > 0.95);
  // and the pick still does not depend on the order the candidates are listed in
  for (let s = 0; s < 50; s++) {
    const pl = createPlanner({ seed: `order${s}`, vibe: 0.5 });
    const a = [loner, p, q, unsure, clear];
    const b = [clear, unsure, q, p, loner];
    assert.equal(a[pl.chooseNext(cur, a, { playIndex: 2, recentArtists: [] })].id, b[pl.chooseNext(cur, b, { playIndex: 2, recentArtists: [] })].id);
  }
});

test('whole sets on a crate with grid trust: every invariant holds, blends survive, none goes through an unclear end', () => {
  let n = 0;
  let blends = 0;
  let held = 0;
  for (const vibe of [0, 0.5, 1]) for (let s = 0; s < 4; s++) {
    const crate = synthCrate(createRng(`grid-crate-${s}`), 40, { grid: true });
    const byId = new Map(crate.map((t) => [t.id, t]));
    const planner = createPlanner({ seed: `grid-set-${s}`, vibe, mode: 'preview' });
    const sim = simulateSet(planner, crate, 60);
    assert.deepEqual(sim.violations.slice(0, 5), [], `vibe ${vibe} seed ${s}`);
    for (let i = 1; i < sim.transitions.length; i++) {
      const tr = sim.transitions[i];
      assert.equal(tr.degraded, undefined);
      n++;
      if (/would clash/.test(tr.why)) held++;
      if (!isBlend(tr)) continue;
      blends++;
      const A = byId.get(sim.picks[i - 1]).analysis;
      const B = byId.get(sim.picks[i]).analysis;
      assert.equal(tr.trust.ok, true);
      assert.ok(A.grid.tail >= 0.15 && B.grid.head >= 0.15, `blend through an unclear end: tail ${A.grid.tail}, head ${B.grid.head}`);
      assert.ok(tr.trust.contrast >= 1.05);
    }
  }
  console.log(`      sets with grid trust: ${n} transitions · ${blends} blends (${Math.round((100 * blends) / n)}%) · ${held} tempo matches held back by the gate`);
  assert.ok(blends / n > 0.15, `blends must not disappear: ${blends} of ${n}`);
  assert.ok(held > 0, 'the gate was exercised');
});

test('gated plans are as deterministic as any other', () => {
  const A = track({ grid: { tail: 0.1 } });
  const B = track({ bpm: 126 });
  const plan = () => {
    const p = createPlanner({ seed: 'same', vibe: 0.6 });
    const f = p.first({ id: 'a', analysis: A });
    return p.next({ play: f.play, analysis: A }, { id: 'b', analysis: B }, { earliest: 1 });
  };
  assert.deepEqual(plan(), plan());
  // and the inputs are left alone
  const before = JSON.stringify([A.grid.head, A.grid.tail, Array.from(A.grid.slots.subarray(0, 64))]);
  plan();
  assert.equal(JSON.stringify([A.grid.head, A.grid.tail, Array.from(A.grid.slots.subarray(0, 64))]), before);
});

test('synthGrid: the helper builds what it says', () => {
  const g = synthGrid(40, { hits: [0], headHits: [8] });
  assert.equal(g.slots.length, 640);
  assert.ok(g.slots[8] > 100 && g.slots[0] < 50, 'head beats carry the hit in slot 8');
  assert.ok(g.slots[30 * 16] > 100 && g.slots[30 * 16 + 8] < 50, 'later beats in slot 0');
});

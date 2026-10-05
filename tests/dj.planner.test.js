// Planner behaviour: next-track choice, energy arc, mid-solo tricks, where tracks are left/entered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner, energyArc, holdPlayAt } from '../js/dj/planner.js';
import { evalParam, positionAt, rateAt } from '../js/dj/timeline.js';
import { RECIPES, STRIP_DEFAULTS } from '../js/dj/transitions.js';
import { createRng } from '../js/util/rng.js';
import { checkBusSessions, checkTransition, simulateSet, synthAnalysis, synthCrate } from './helpers/dj-synth.js';

const cand = (id, o = {}, artist = id) => ({ id, artist, analysis: synthAnalysis(o) });
/** How often (0..1) over many seeds chooseNext picks the candidate with `id`. */
function share(id, current, candidates, ctx = {}, vibe = 0.5) {
  let hit = 0;
  for (let s = 0; s < 200; s++) {
    const p = createPlanner({ seed: `cn${s}`, vibe });
    const k = p.chooseNext(current, candidates, { playIndex: 3, recentArtists: [], ...ctx });
    assert.ok(Number.isInteger(k) && k >= 0 && k < candidates.length);
    if (candidates[k].id === id) hit++;
  }
  return hit / 200;
}

test('chooseNext: empty list, single candidate, index range', () => {
  const p = createPlanner({ seed: 'x' });
  assert.equal(p.chooseNext(null, [], { playIndex: 0, recentArtists: [] }), -1);
  assert.equal(p.chooseNext(null, [cand('a')], { playIndex: 0, recentArtists: [] }), 0);
  assert.equal(p.chooseNext(cand('a'), [cand('a')], { playIndex: 4, recentArtists: ['a'] }), 0);
  assert.equal(p.chooseNext(cand('a'), [cand('b'), cand('c')]), p.chooseNext(cand('a'), [cand('b'), cand('c')], { playIndex: 0, recentArtists: [] }));
  assert.ok([0, 1].includes(p.chooseNext(cand('a'), [{ id: 'junk' }, { id: 'junk2', analysis: {} }], {})));
});

test('chooseNext: opener is moderate in energy with a trustworthy grid', () => {
  const c = [cand('hot', { energy: 0.97 }), cand('good', { energy: 0.48 }), cand('loose', { energy: 0.48, conf: 0.05 }), cand('sleepy', { energy: 0.05 })];
  assert.ok(share('good', null, c, { playIndex: 0 }) > 0.8);
  assert.ok(share('hot', null, c, { playIndex: 0 }) < 0.05);
});

test('chooseNext: beat-matchable tempo (after ×2 / ÷2 folding) wins strongly', () => {
  const cur = cand('cur', { bpm: 124 });
  const far = cand('far', { bpm: 100 });
  assert.ok(share('near', cur, [far, cand('near', { bpm: 127 })]) > 0.9);
  assert.ok(share('double', cand('c', { bpm: 75 }), [cand('f', { bpm: 112 }), cand('double', { bpm: 151 })]) > 0.9, '75 ↔ 151 is matchable by folding');
  assert.ok(share('half', cand('c', { bpm: 170 }), [cand('f', { bpm: 120 }), cand('half', { bpm: 86 })]) > 0.9);
  // within the ±8% window closer is still better, but (tempo alone, keys unknown) only mildly
  const s = share('exact', cand('cur', { bpm: 124, keyConf: 0 }), [cand('exact', { bpm: 124, keyConf: 0 }), cand('edge', { bpm: 133, keyConf: 0 })]);
  assert.ok(s > 0.55 && s < 0.98, `exact vs edge ${s}`);
  // an untrustworthy grid makes the tempo evidence count for less
  const trusted = share('near', cur, [far, cand('near', { bpm: 127 })]);
  const loose = share('near', cand('cur', { bpm: 124, conf: 0.1 }), [far, cand('near', { bpm: 127 })]);
  assert.ok(trusted > 0.99 && loose < 0.93 && loose > 0.5, `trusted ${trusted}, loose grid ${loose}`);
});

test('chooseNext: harmonic compatibility counts in proportion to key confidence', () => {
  const cur = cand('cur', { pc: 0, mode: 'major', keyConf: 0.95 });
  const sure = [cand('fifth', { pc: 7, mode: 'major', keyConf: 0.95 }), cand('tritone', { pc: 6, mode: 'major', keyConf: 0.95 })];
  const unsure = [cand('fifth', { pc: 7, mode: 'major', keyConf: 0 }), cand('tritone', { pc: 6, mode: 'major', keyConf: 0 })];
  const a = share('fifth', cur, sure);
  const b = share('fifth', cur, unsure);
  assert.ok(a > 0.85, `confident keys ${a}`);
  assert.ok(b > 0.35 && b < 0.65, `no key confidence → coin flip, got ${b}`);
});

test('chooseNext: harmony is judged at the pitch a beat-matched track will actually play at', () => {
  // No key lock: matching 124 → 131.4 BPM plays the candidate 5.6 % slow = one semitone flat.
  const cur = cand('cur', { bpm: 124, pc: 0, mode: 'major', keyConf: 0.95 });
  const semitoneUp = 124 * 2 ** (1 / 12);
  // written a semitone above, it lands exactly in the current key once slowed down to match …
  const lands = cand('lands', { bpm: semitoneUp, pc: 1, mode: 'major', keyConf: 0.95 });
  // … while "the same key" at that tempo ends up a semitone flat of the current track
  const drifts = cand('drifts', { bpm: semitoneUp, pc: 0, mode: 'major', keyConf: 0.95 });
  assert.ok(share('lands', cur, [lands, drifts]) > 0.85);
  // a quarter tone apart nothing is in tune, whatever the keys say: the exact-tempo twin is preferred
  const sour = cand('sour', { bpm: 124 * 2 ** (0.5 / 12), pc: 0, mode: 'major', keyConf: 0.95 });
  const sweet = cand('sweet', { bpm: 124, pc: 0, mode: 'major', keyConf: 0.95 });
  assert.ok(share('sweet', cur, [sour, sweet]) > 0.9);
  // tracks that would not be beat-matched anyway play at their own pitch: plain wheel compatibility
  const farSame = cand('farSame', { bpm: 100, pc: 0, mode: 'major', keyConf: 0.95 });
  const farClash = cand('farClash', { bpm: 100, pc: 6, mode: 'major', keyConf: 0.95 });
  assert.ok(share('farSame', cur, [farSame, farClash]) > 0.85);
});

test('chooseNext: avoids recent artists and the track that is playing', () => {
  const cur = cand('cur', {}, 'Daft Punk');
  const c = [cand('same', {}, 'Daft Punk, Pharrell Williams'), cand('other', {}, 'Justice')];
  assert.ok(share('other', cur, c, { recentArtists: ['Daft Punk'] }) > 0.9);
  assert.ok(share('other', cur, c, { recentArtists: ['PHARRELL WILLIAMS feat. Someone'] }) > 0.9, 'matches any credited artist, case-insensitively');
  const neutral = share('other', cur, c, { recentArtists: ['Moby'] });
  assert.ok(neutral > 0.3 && neutral < 0.7);
  assert.ok(share('new', cur, [cand('cur', {}, 'x'), cand('new', { bpm: 96 }, 'y')]) > 0.95, 'never the same track twice in a row if avoidable');
});

test('energy arc: warm-up → build → peak → breather → build …, seeded', () => {
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const arc = Array.from({ length: 40 }, (_, i) => energyArc(seed, i));
    assert.ok(arc.every((e) => e >= 0.35 && e <= 0.95));
    assert.ok(arc[0] <= 0.5, 'opens moderate');
    const peak = Math.max(...arc.slice(0, 15));
    const peakAt = arc.indexOf(peak);
    assert.ok(peak >= 0.78 && peakAt >= 4, `first peak ${peak} at ${peakAt}`);
    for (let i = 1; i <= peakAt; i++) assert.ok(arc[i] >= arc[i - 1] - 1e-12, 'builds monotonically to the first peak');
    const after = arc.slice(peakAt);
    const dip = after.findIndex((e) => e < peak - 0.15);
    assert.ok(dip > 0, 'a breather follows the peak');
    assert.ok(after.slice(dip).some((e) => e >= 0.78), 'and it builds again');
    assert.deepEqual(arc, Array.from({ length: 40 }, (_, i) => energyArc(seed, i)));
  }
  assert.notDeepEqual(Array.from({ length: 30 }, (_, i) => energyArc('a', i)), Array.from({ length: 30 }, (_, i) => energyArc('b', i)));
  // choices follow the arc: with candidates differing only in energy, picks track the target
  let err = 0;
  let base = 0;
  let n = 0;
  for (let s = 0; s < 30; s++) {
    const seed = `arc${s}`;
    const p = createPlanner({ seed });
    const c = [0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map((e, i) => cand(`e${i}`, { energy: e }));
    for (let i = 1; i < 30; i++) {
      const k = p.chooseNext(cand('cur', { energy: energyArc(seed, i - 1) }), c, { playIndex: i, recentArtists: [] });
      err += Math.abs(c[k].analysis.energy - energyArc(seed, i));
      base += c.reduce((acc, x) => acc + Math.abs(x.analysis.energy - energyArc(seed, i)), 0) / c.length;
      n++;
    }
  }
  assert.ok(err / n < 0.5 * (base / n), `mean distance to the arc ${err / n} vs random ${base / n}`);
});

test('chooseNext: deterministic, independent of candidate order, seed-dependent', () => {
  const r = createRng('cands');
  let varied = 0;
  for (let c = 0; c < 12; c++) {
    const tracks = synthCrate(r, 12);
    const cur = tracks[0];
    const pool = tracks.slice(1, 6); // a crate window
    const picks = new Set();
    for (let s = 0; s < 40; s++) {
      const p = createPlanner({ seed: `o${s}` });
      const ctx = { playIndex: 7, recentArtists: ['Artist 2'] };
      const id = pool[p.chooseNext(cur, pool, ctx)].id;
      assert.equal(pool[p.chooseNext(cur, pool, ctx)].id, id);
      for (let k = 0; k < 3; k++) {
        const shuffled = r.shuffle(pool);
        assert.equal(shuffled[p.chooseNext(cur, shuffled, ctx)].id, id, 'same track whatever the list order');
      }
      picks.add(id);
    }
    if (picks.size >= 2) varied++;
  }
  assert.ok(varied >= 5, `seeded noise lets different seeds take different paths (${varied}/12 windows)`);
});

test('holdPlayAt mirrors engine.cancelFrom: values frozen, nothing scheduled after, idempotent', () => {
  const play = {
    id: 3, trackId: 't', deck: 1, startAt: 10, offset: 1, trimDb: 0, endAt: 40, soloFrom: 14,
    rate: [{ t: 10, v: 1.06 }, { t: 14, v: 1.06 }, { t: 18, v: 1, ramp: true }],
    events: [
      { p: 'gain', t: 10, v: 0, k: 'set' }, { p: 'lpf', t: 10, v: 20000, k: 'set' }, { p: 'gain', t: 14, v: 1, k: 'lin' },
      { p: 'lpf', t: 20, v: 20000, k: 'set' }, { p: 'lpf', t: 22, v: 200, k: 'exp' }, { p: 'lpf', t: 24, v: 20000, k: 'exp' },
      { p: 'src', t: 23, v: 0, k: 'set' },
    ],
  };
  const h = holdPlayAt(play, 21);
  assert.equal(h.endAt, null);
  assert.ok(h.events.every((e) => e.t <= 21));
  const lpf = evalParam(play.events, 'lpf', 21, 20000);
  assert.ok(Math.abs(lpf - 2000) < 1e-6, 'caught half-way down the exponential sweep');
  for (const t of [21, 22, 30, 99]) {
    assert.ok(Math.abs(evalParam(h.events, 'lpf', t, 20000) - lpf) < 1e-9);
    assert.equal(evalParam(h.events, 'src', t, 1), 1, 'a mute scheduled after the cancel never happens');
    assert.equal(evalParam(h.events, 'gain', t, 1), 1);
  }
  assert.deepEqual(h.rate, play.rate);
  const g = holdPlayAt(play, 16); // mid-glide
  assert.deepEqual(g.rate, [{ t: 10, v: 1.06 }, { t: 14, v: 1.06 }, { t: 16, v: 1.03, ramp: true }]);
  assert.equal(rateAt(g, 30), 1.03);
  for (const t of [12, 15, 16]) assert.ok(Math.abs(positionAt(g, t) - positionAt({ ...play, endAt: null }, t)) < 1e-12, 'same past');
  assert.ok(Math.abs(positionAt(g, 20) - (positionAt(g, 16) + 4 * 1.03)) < 1e-12, 'constant from the cancel on');
  assert.deepEqual(holdPlayAt(play, 14).rate, [{ t: 10, v: 1.06 }, { t: 14, v: 1.06 }], 'cancel exactly on a breakpoint');
  assert.deepEqual(holdPlayAt(play, 5).rate, [{ t: 10, v: 1.06 }], 'cancel before the start keeps the entry rate');
  assert.deepEqual(holdPlayAt(g, 16), g, 'idempotent');
  assert.deepEqual(holdPlayAt(h, 21), h);
  assert.equal(play.events.length, 7, 'input untouched');
});

// ───────────────────────────── tricks ─────────────────────────────

const TRICK_MARKS = { 'Filter dip': 0, 'Echo throw': 3, 'Beat repeat': null, Build: 0 };

function trickRun(vibe, mode, crateOpts = {}, seeds = 6) {
  const found = [];
  let transitions = 0;
  for (let s = 0; s < seeds; s++) {
    const tracks = synthCrate(createRng(`trick-crate${s}`), 20, { full: mode !== 'preview', ...crateOpts });
    if (crateOpts.conf !== undefined) for (const t of tracks) t.analysis.bpmConfidence = crateOpts.conf;
    const planner = createPlanner({ seed: `trick${s}`, vibe, mode });
    const sim = simulateSet(planner, tracks, 30);
    assert.deepEqual(sim.violations, []);
    const byId = new Map(tracks.map((t) => [t.id, t]));
    for (let n = 1; n < sim.transitions.length; n++) {
      const tr = sim.transitions[n];
      transitions++;
      const out = { ...sim.plays[n - 1], endAt: null, rate: sim.plays[n - 1].rate.slice(0, sim.plays[n - 1].rate.length - tr.aRate.length) };
      const A = byId.get(out.trackId).analysis;
      for (const mk of tr.marks) if (mk.label in TRICK_MARKS) found.push({ tr, mk, out, A });
    }
  }
  return { found, transitions };
}

test('tricks: all four kinds occur, on bar lines, clear of the transition, strip + bus restored', () => {
  const { found } = trickRun(1, 'full');
  const kinds = new Set(found.map((f) => f.mk.label));
  assert.deepEqual([...kinds].sort(), Object.keys(TRICK_MARKS).sort());
  for (const { tr, mk, out, A } of found) {
    assert.ok(mk.t >= out.soloFrom + 1, 'a bar of plain solo first');
    assert.ok(mk.t < tr.tStart - 1, 'well before the transition');
    // the mark sits on a beat of the outgoing track: bar line, or the bar's last beat(s) for throws / repeats
    const pos = positionAt(out, mk.t);
    const i = A.beats.findIndex((x) => Math.abs(x - pos) < 1e-6);
    assert.ok(i >= 0, `${mk.label} on a beat`);
    const inBar = (((i - A.downbeat) % 4) + 4) % 4;
    if (TRICK_MARKS[mk.label] !== null) assert.equal(inBar, TRICK_MARKS[mk.label], mk.label);
    else assert.ok(inBar === 2 || inBar === 3, 'beat repeat on the last beats of the bar');
  }
  // trick automation never reaches into the transition, and the strip is at rest in between (checked on a grid)
  for (const { tr, out } of found.slice(0, 200)) {
    const ev = [...out.events];
    const trickEnd = tr.aEvents.filter((e) => e.t < tr.tStart - 0.04).reduce((m, e) => Math.max(m, e.t), -Infinity);
    assert.ok(trickEnd <= tr.tStart - 0.05);
    for (const [p, d] of Object.entries(STRIP_DEFAULTS)) assert.equal(evalParam(ev, p, trickEnd + 1e-6, d), d, `${p} restored after the last trick`);
  }
});

test('tricks: beat repeat mutes the main source exactly while the slices play; echo throw closes its send on the bar line', () => {
  const { found } = trickRun(1, 'full');
  let repeats = 0;
  let throws = 0;
  for (const { tr, mk, out } of found) {
    const src = (t) => evalParam(out.events, 'src', t, 1);
    if (mk.label === 'Beat repeat') {
      const loops = tr.fx.filter((f) => f.kind === 'loop' && f.t >= mk.t - 1e-9 && f.t < mk.t + 3 && f.t < tr.tStart - 0.5);
      assert.ok(loops.length >= 1 && loops.length <= 2);
      const end = loops[loops.length - 1].t + loops[loops.length - 1].dur;
      assert.equal(src(mk.t - 1e-6), 1);
      assert.equal(src(mk.t), 0);
      assert.equal(src(end - 1e-6), 0);
      assert.equal(src(end), 1);
      for (const f of loops) assert.ok(Math.abs(f.offset - positionAt(out, mk.t)) < 1e-9);
      repeats++;
    }
    if (mk.label === 'Echo throw') {
      const send = (t) => evalParam(out.events, 'delaySend', t, 0);
      assert.equal(send(mk.t), 0);
      const peak = Math.max(...[0.2, 0.3, 0.4].map((d) => send(mk.t + d * 0.5)));
      assert.ok(peak >= 0.4 && peak <= 0.6, `send ${peak}`);
      throws++;
    }
    assert.deepEqual(checkBusSessions(tr, { prev: { play: out }, opts: { earliest: out.startAt + 2 } }), []);
  }
  assert.ok(repeats > 5 && throws > 5);
});

test('tricks: probability rises with vibe; none without room or after a Skip; loose grids only get filter moves', () => {
  const lo = trickRun(0, 'preview');
  const mid = trickRun(0.5, 'preview');
  const hi = trickRun(1, 'preview');
  const rate = (r) => r.found.length / r.transitions;
  assert.ok(rate(lo) < 0.15, `vibe 0: ${rate(lo)}`);
  assert.ok(rate(mid) > rate(lo) + 0.1 && rate(hi) > rate(mid) + 0.1, `${rate(lo)} < ${rate(mid)} < ${rate(hi)}`);
  assert.ok(rate(hi) <= 1, 'previews get at most one trick per track');
  const loose = trickRun(1, 'preview', { conf: 0.2 });
  assert.ok(loose.found.length > 5);
  assert.ok(loose.found.every((f) => f.mk.label === 'Filter dip' || f.mk.label === 'Build'));
  // no room: a 9-second clip is all transition
  const A = synthAnalysis({ bpm: 120, duration: 9 });
  const B = synthAnalysis({ bpm: 121, duration: 30 });
  for (let s = 0; s < 80; s++) {
    const planner = createPlanner({ seed: `noroom${s}`, vibe: 1 });
    const f = planner.first({ id: 'a', analysis: A });
    const tr = planner.next({ play: f.play, analysis: A }, { id: 'b', analysis: B }, { earliest: 0.5 });
    assert.ok(tr.marks.every((m) => !(m.label in TRICK_MARKS)), 'no trick in a 9 s clip');
    const q = planner.next({ play: f.play, analysis: synthAnalysis({ bpm: 120, duration: 200 }) }, { id: 'b', analysis: B }, { earliest: 30, quick: true });
    assert.ok(q.marks.every((m) => !(m.label in TRICK_MARKS)), 'no trick on a Skip');
  }
});

// ───────────────────────────── where tracks are left and entered ─────────────────────────────

test('preview mode: the outgoing clip is used to its last usable bar line', () => {
  for (let s = 0; s < 40; s++) {
    const r = createRng(`late${s}`);
    const A = synthAnalysis({ bpm: r.range(80, 170), duration: 30, first: r.range(0, 0.4), downbeat: r.int(4), cueEnd: r.range(28, 29.9) });
    const B = synthAnalysis({ bpm: r.range(80, 170), duration: 30 });
    const planner = createPlanner({ seed: `late${s}`, vibe: r.next() });
    const f = planner.first({ id: 'a', analysis: A });
    const tr = planner.next({ play: f.play, analysis: A }, { id: 'b', analysis: B }, { earliest: 1 });
    const posEnd = positionAt(f.play, tr.tEnd);
    const i = A.beats.findIndex((x) => Math.abs(x - posEnd) < 1e-6);
    assert.ok(i >= 0 && (i - A.downbeat) % 4 === 0, 'left on a bar line');
    assert.ok(posEnd <= A.cues.end + 1e-3, 'inside the usable audio');
    assert.ok(A.beats[i + 4] === undefined || A.beats[i + 4] > A.cues.end, 'no later bar line was available');
    assert.ok([0, 1, 2, 3, 4, 8, 16].includes(tr.beats));
    if (RECIPES[tr.type].sync === 'required') assert.ok([8, 16].includes(tr.beats), 'preview blends are 8 or 16 beats');
    assert.equal(tr.play.offset <= B.cues.in + 1e-9 && tr.play.offset >= B.cues.in - 0.01, true, 'incoming enters at cues.in');
  }
});

test('short / medium / full: leave after ~45 s / ~90 s / at the outro, on phrase lines, 16/32-beat blends', () => {
  const stats = { short: [], medium: [], full: [] };
  const dropEntries = { short: 0, medium: 0, full: 0 };
  for (const mode of ['short', 'medium', 'full']) for (let s = 0; s < 60; s++) {
    const r = createRng(`${mode}${s}`);
    const A = synthAnalysis({ bpm: r.range(100, 130), duration: r.range(200, 280), first: 0.2, downbeat: r.int(4) });
    const B = synthAnalysis({ bpm: A.bpm * r.range(0.96, 1.04), duration: 240, first: 0.1 });
    // analysis reports the drop on a bar line
    const drop = B.beats[4 * Math.round(r.range(40, 70) / (60 / B.bpm) / 4)];
    B.cues.drop = drop;
    const planner = createPlanner({ seed: `${mode}${s}`, vibe: 0.5, mode });
    const f = planner.first({ id: 'a', analysis: A });
    const prev = { play: f.play, analysis: A };
    const tr = planner.next(prev, { id: 'b', analysis: B }, { earliest: 2 });
    assert.deepEqual(checkTransition(tr, { prev, incoming: { id: 'b', analysis: B }, opts: { earliest: 2 } }), []);
    stats[mode].push(tr.tEnd - f.play.startAt);
    const iEnd = A.beats.findIndex((x) => Math.abs(x - positionAt(f.play, tr.tEnd)) < 1e-6);
    const iIn = A.beats.findIndex((x) => Math.abs(x - f.play.offset) < 1e-6);
    assert.ok(iEnd >= 0 && (iEnd - iIn) % 16 === 0, `${mode}: left on a 16-beat phrase line (${iEnd - iIn} beats in)`);
    if (RECIPES[tr.type].sync === 'required') assert.ok([16, 32].includes(tr.beats), `${mode} blend of ${tr.beats}`);
    if (mode === 'full') assert.ok(A.cues.end - positionAt(f.play, tr.tEnd) < 16 * (60 / A.bpm) + 1e-6, 'full: plays to the outro');
    // entry: at cues.in, or timed around the drop (drop lands as the blend completes / on the one / a phrase later)
    const jB = B.beats.findIndex((x) => Math.abs(x - positionAt(tr.play, tr.tEnd)) < 0.02);
    const jDrop = B.beats.indexOf(drop);
    if (tr.play.offset > B.cues.in + 1) {
      dropEntries[mode]++;
      assert.ok([0, 16].includes(jDrop - jB) || RECIPES[tr.type].overlap, `drop-timed entry, ${jDrop - jB} beats before the drop at tEnd`);
      if (RECIPES[tr.type].sync === 'required') assert.equal(jDrop - jB, 0, 'blend completes on the drop');
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(stats.short) > 38 && mean(stats.short) < 56, `short ≈ 45 s, got ${mean(stats.short)}`);
  assert.ok(mean(stats.medium) > 80 && mean(stats.medium) < 102, `medium ≈ 90 s, got ${mean(stats.medium)}`);
  assert.ok(mean(stats.full) > 180, `full plays the track, got ${mean(stats.full)}`);
  assert.ok(Math.min(...stats.short) > 28 && Math.max(...stats.short) < 70);
  assert.ok(dropEntries.short > dropEntries.full && dropEntries.short >= 20, `drop-timed entries ${JSON.stringify(dropEntries)}`);
  assert.ok(dropEntries.full >= 3);
});

test('type selection follows compatibility and vibe; previous type is not repeated', () => {
  const tally = (o, n = 400) => {
    const h = {};
    for (let s = 0; s < n; s++) {
      const A = synthAnalysis({ bpm: 124, pc: 0, keyConf: 0.9, ...o.a });
      const B = synthAnalysis({ bpm: o.bpmB ?? 126, pc: o.pcB ?? 0, keyConf: 0.9, ...o.b });
      const planner = createPlanner({ seed: `sel${s}`, vibe: o.vibe ?? 0.5 });
      const f = planner.first({ id: 'a', analysis: A });
      const play = o.via ? { ...f.play, via: o.via } : f.play;
      const tr = planner.next({ play, analysis: A }, { id: 'b', analysis: B }, { earliest: 1 });
      h[tr.type] = (h[tr.type] || 0) + 1;
      h.long = (h.long || 0) + (RECIPES[tr.type].sync === 'required' && tr.beats === 16 ? 1 : 0);
      h.blend = (h.blend || 0) + (RECIPES[tr.type].sync === 'required' ? 1 : 0);
    }
    return h;
  };
  const wild = (h) => (h.cut || 0) + (h.loopRoll || 0) + (h.spinback || 0) + (h.riserDrop || 0) + (h.brake || 0);
  const smooth = tally({ vibe: 0 });
  const mid = tally({ vibe: 0.5 });
  const hot = tally({ vibe: 1 });
  assert.ok(smooth.blend > 0.75 * 400, `vibe 0, compatible pair: mostly blends (${smooth.blend})`);
  assert.ok(wild(hot) > 2.5 * wild(smooth), `vibe 1 is wilder: ${wild(hot)} vs ${wild(smooth)}`);
  assert.ok((smooth.eqBlend || 0) + (smooth.reverbWash || 0) > (hot.eqBlend || 0) + (hot.reverbWash || 0));
  assert.ok(mid.blend > 0.5 * 400, 'matchable tracks are usually beat-matched');
  // keys: agree → long blends; clash → fewer and shorter blends, more quick exits
  const clash = tally({ pcB: 6 });
  assert.ok(mid.long / mid.blend > clash.long / clash.blend + 0.15, `long share ${mid.long / mid.blend} vs ${clash.long / clash.blend}`);
  assert.ok(clash.blend < mid.blend && wild(clash) + (clash.echoOut || 0) > wild(mid) + (mid.echoOut || 0));
  // not matchable → only unsynced exits, and every one of them is used
  const far = tally({ bpmB: 98 });
  assert.equal(far.blend, 0);
  for (const t of ['echoOut', 'reverbWash', 'cut', 'spinback', 'brake', 'riserDrop', 'loopRoll']) assert.ok(far[t] > 0, `${t} reachable when unsyncable`);
  // every type is reachable for a matchable pair, at both ends of the vibe range
  for (const h of [smooth, hot, mid]) for (const t of Object.keys(RECIPES)) if (h === mid) assert.ok(h[t] > 0, `${t} reachable`);
  const all = tally({ vibe: 0 }, 3000);
  for (const t of Object.keys(RECIPES)) assert.ok(all[t] > 0, `${t} reachable even at vibe 0`);
  // a matched pair that ends up a quarter tone apart (no key lock) is treated like a clash: shorter blends
  const detuned = tally({ bpmB: 124 * 2 ** (0.5 / 12) });
  const inTune = tally({ bpmB: 124 });
  assert.ok(inTune.long / inTune.blend > detuned.long / detuned.blend + 0.15, `long share ${inTune.long / inTune.blend} vs detuned ${detuned.long / detuned.blend}`);
  assert.ok(detuned.blend < inTune.blend && detuned.blend > 0.3 * 400, `still mostly beat-matched: ${detuned.blend} vs ${inTune.blend}`);
  // … and one that lands a whole semitone away is judged in the key it lands in
  const landsInKey = tally({ bpmB: 124 * 2 ** (1 / 12), pcB: 1 });
  const landsOff = tally({ bpmB: 124 * 2 ** (1 / 12), pcB: 0 });
  assert.ok(landsInKey.long / landsInKey.blend > landsOff.long / landsOff.blend + 0.1, `${landsInKey.long / landsInKey.blend} vs ${landsOff.long / landsOff.blend}`);
  // repeat penalty
  const afterSwap = tally({ via: 'bassSwap' });
  assert.ok(afterSwap.bassSwap < 0.5 * mid.bassSwap, `bassSwap after bassSwap: ${afterSwap.bassSwap} vs ${mid.bassSwap}`);
});

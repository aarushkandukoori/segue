// Beat-matching: for perfect grids, every pair of corresponding beats in a synced overlap lands
// within 2 ms in set time (measured through timeline.timeAtPosition), including ×2 / ÷2 folds and an
// outgoing track that is itself still gliding back to its own tempo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner, holdPlayAt } from '../js/dj/planner.js';
import { positionAt, rateAt, timeAtPosition } from '../js/dj/timeline.js';
import { createRng } from '../js/util/rng.js';
import { beatAlignment, checkTransition, synthAnalysis } from './helpers/dj-synth.js';

const BLENDS = ['bassSwap', 'eqBlend', 'filterBlend'];
const TWO_MS = 0.002;

function pair(bpmA, bpmB, o = {}) {
  const A = synthAnalysis({ bpm: bpmA, duration: o.durA ?? 120, first: 0.37, downbeat: 3, ...o.a });
  const B = synthAnalysis({ bpm: bpmB, duration: o.durB ?? 120, first: 0.13, downbeat: 1, pc: 2, ...o.b });
  const planner = createPlanner({ seed: o.seed ?? 'sync', mode: o.mode ?? 'preview', vibe: 0.5 });
  const f = planner.first({ id: 'a', analysis: A }, { startAt: 2 });
  return { A, B, planner, f, prev: { play: f.play, analysis: A }, incoming: { id: 'b', analysis: B } };
}

/**
 * After the transition the incoming rate returns to exactly 1: a linear glide over whole bars
 * ([lo, 2·lo] beats; lo = 8 on previews, 16 otherwise), as short as keeps the pitch drift at or under
 * 12 cents/s (speed is pitch on these decks) — or a plain step when it is within 0.3 % already.
 */
function assertGlidesHome(tr, B, lo = 8) {
  const r = tr.play.rate;
  assert.equal(r[r.length - 1].v, 1, 'ends at exactly 1');
  assert.equal(rateAt(tr.play, r[r.length - 1].t), 1);
  assert.equal(rateAt(tr.play, 1e9), 1);
  const atEnd = r.filter((q) => q.t <= tr.tEnd).pop().v;
  if (Math.abs(atEnd - 1) > 0.003) {
    const g = r[r.length - 1];
    assert.equal(g.ramp, true, 'linear glide');
    assert.equal(r[r.length - 2].t, tr.tEnd, 'glide starts when the incoming is solo');
    const period = 60 / B.bpm;
    const beats = (g.t - tr.tEnd) / period;
    assert.ok(Math.abs(beats - Math.round(beats)) < 1e-6 && Math.round(beats) % 4 === 0, `glide lasts whole bars (${beats} beats)`);
    assert.ok(beats >= lo - 1e-6 && beats <= 2 * lo + 1e-6, `glide of ${beats} beats`);
    const cents = Math.abs(1200 * Math.log2(atEnd));
    const drift = (n) => cents / (n * period);
    assert.ok(drift(beats) <= 12 + 1e-6 || Math.round(beats) === 2 * lo, `pitch drifts ${drift(beats)} cents/s`);
    assert.ok(Math.round(beats) === lo || drift(beats - 4) > 12, 'and no longer than that takes');
    return Math.round(beats);
  }
  assert.equal(r[r.length - 1].t, tr.tEnd, 'within 0.3%: no glide, straight to 1');
  return 0;
}

test('synced blends: every beat pair within 2 ms across tempo pairs and ×2 / ÷2 folds', () => {
  let cases = 0;
  let worstAll = 0;
  const glides = new Set();
  for (const bpmA of [72, 88, 100, 118, 124, 128, 140, 160, 174]) {
    for (const ratio of [0.93, 0.96, 0.99, 1, 1.013, 1.05, 1.078]) {
      for (const fold of [1, 2, 0.5]) {
        const bpmB = bpmA * ratio * fold;
        if (bpmB < 60 || bpmB > 200) continue;
        for (const type of BLENDS) for (const L of [8, 16]) {
          const { A, B, planner, f, prev, incoming } = pair(bpmA, bpmB);
          const opts = { earliest: 4, force: { type, beats: L } };
          const tr = planner.next(prev, incoming, opts);
          const tag = `${bpmA} → ${bpmB.toFixed(2)} ${type} ${L}`;
          assert.equal(tr.type, type, tag);
          assert.equal(tr.synced, true, tag);
          assert.deepEqual(checkTransition(tr, { prev, incoming, opts }), [], tag);
          const al = beatAlignment(tr, f.play, A, B);
          assert.ok(al.worst <= TWO_MS, `${tag}: ${al.worst * 1000} ms`);
          assert.ok(al.compared >= (fold === 1 ? L : L / 2), `${tag}: compared ${al.compared}`);
          // downbeat on downbeat: with equal beat counts every bar line pairs up; with folds every bar of the slower track
          const expectBars = fold === 2 ? L / 4 : fold === 0.5 ? L / 8 : L / 4;
          assert.ok(al.downPairs >= expectBars, `${tag}: downbeat pairs ${al.downPairs}`);
          // the pitch move is the tempo ratio (after folding), and never more than 8%
          const want = 1 / ratio;
          assert.ok(Math.abs(tr.play.rate[0].v - want) < 1e-9, `${tag}: rate ${tr.play.rate[0].v} vs ${want}`);
          assert.ok(Math.abs(tr.play.rate[0].v - 1) <= 0.0811);
          glides.add(assertGlidesHome(tr, B));
          assert.ok(Math.abs(tr.bpm - bpmA) < 1e-6, 'master tempo is the outgoing track');
          assert.match(tr.why, /BPM \((?:[+−]\d+\.\d|±0\.0)%\)/);
          assert.doesNotMatch(tr.why, /[+−]0\.0%/, 'no pitch change is not a signed zero');
          worstAll = Math.max(worstAll, al.worst);
          cases++;
        }
      }
    }
  }
  assert.ok(cases >= 600, `cases ${cases}`);
  assert.ok(worstAll < 1e-6, `perfect grids align to float precision, got ${worstAll}`);
  assert.deepEqual([...glides].sort((x, y) => x - y), [0, 8, 12, 16], 'no glide when matched already; longer the further off-pitch');
});

test('the pitch readout in Transition.why: signed when there is a change, "±0.0%" when it rounds to none', () => {
  const whyAt = (ratio) => {
    const { planner, prev, incoming } = pair(124, 124 * ratio);
    return planner.next(prev, incoming, { earliest: 4, force: { type: 'bassSwap', beats: 16 } }).why;
  };
  // the incoming track is faster by a hair: it is slowed by 0.03 % — which used to read "(−0.0%)"
  assert.match(whyAt(1.0003), /BPM \(±0\.0%\)/);
  assert.match(whyAt(0.9997), /BPM \(±0\.0%\)/);
  assert.match(whyAt(1), /BPM \(±0\.0%\)/);
  assert.match(whyAt(1.02), /BPM \(−2\.0%\)/);
  assert.match(whyAt(0.98), /BPM \(\+2\.0%\)/);
  assert.match(whyAt(1.0006), /BPM \(−0\.1%\)/);
});

test('longer modes glide home over 16–32 beats', () => {
  for (const ratio of [0.93, 0.97, 1.02, 1.07]) {
    const { B, planner, prev, incoming } = pair(124, 124 * ratio, { mode: 'full', durA: 240, durB: 240 });
    const tr = planner.next(prev, incoming, { earliest: 4, force: { type: 'eqBlend', beats: 32 } });
    assert.equal(tr.synced, true);
    const beats = assertGlidesHome(tr, B, 16);
    assert.ok(beats >= 16 && beats <= 32);
  }
});

test('synced blend while the outgoing track is still gliding (rate changing during the overlap)', () => {
  let cases = 0;
  for (const r1 of [0.95, 0.97, 1.03, 1.05]) for (const r2 of [0.97, 1, 1.03]) for (const fold of [1, 0.5]) for (const type of BLENDS) {
    // A → B beat-matched, B is short so its exit blend has to start during its own glide.
    const { B, planner, prev, incoming } = pair(120 * r1, 120, { durB: 11.7, b: { first: 0.1, downbeat: 0, cueEnd: 11.3 } });
    const t1 = planner.next(prev, incoming, { earliest: 4, force: { type: 'bassSwap', beats: 8 } });
    assert.equal(t1.synced, true);
    const playB = t1.play;
    const C = synthAnalysis({ bpm: 120 * r2 * fold, duration: 60, first: 0.29, downbeat: 2 });
    const prevB = { play: playB, analysis: B };
    const inC = { id: 'c', analysis: C };
    const opts = { earliest: playB.startAt + 1, force: { type, beats: 8 } };
    const t2 = planner.next(prevB, inC, opts);
    const tag = `r1 ${r1} r2 ${r2} fold ${fold} ${type}`;
    assert.equal(t2.type, type, tag);
    assert.equal(t2.synced, true, tag);
    assert.deepEqual(checkTransition(t2, { prev: prevB, incoming: inC, opts }), [], tag);
    // really mid-glide: the master's rate differs between the two ends of the overlap …
    assert.ok(Math.abs(rateAt(playB, t2.tStart) - rateAt(playB, t2.tEnd)) > 0.003, `${tag}: not mid-glide`);
    assert.ok(Math.abs(rateAt(playB, t2.tStart) - 1) > 0.003);
    // … so the follower's rate has to move with it, not sit at a constant: same ratio all the way through
    const c = rateAt(t2.play, t2.tStart) / rateAt(playB, t2.tStart);
    for (let k = 0; k <= 10; k++) {
      // (sampled just inside tEnd: on tEnd itself the follower is released to glide / step home)
      const t = Math.min(t2.tStart + ((t2.tEnd - t2.tStart) * k) / 10, t2.tEnd - 1e-6);
      assert.ok(Math.abs(rateAt(t2.play, t) - c * rateAt(playB, t)) < 1e-9, `${tag}: follower rate does not track at ${t}`);
    }
    assert.ok(Math.abs(rateAt(t2.play, t2.tStart) - rateAt(t2.play, t2.tEnd)) > 0.003 * c * 0.99, `${tag}: follower rate is constant`);
    const al = beatAlignment(t2, playB, B, C);
    assert.ok(al.worst <= TWO_MS, `${tag}: ${al.worst * 1000} ms`);
    assert.ok(al.worst < 1e-6, `${tag}: exact lock expected, got ${al.worst}`);
    assert.ok(al.compared >= (fold === 1 ? 8 : 4) && al.downPairs >= 1, tag);
    // a constant-rate follower would have drifted audibly — the lock is doing real work here
    const naive = { ...t2.play, rate: [{ t: t2.play.startAt, v: t2.play.rate[0].v }] };
    const drift = Math.abs(positionAt(naive, t2.tEnd) - positionAt(t2.play, t2.tEnd));
    assert.ok(drift > 0.004, `${tag}: naive drift only ${drift}`);
    assertGlidesHome(t2, C);
    cases++;
  }
  assert.ok(cases >= 60, `cases ${cases}`);
});

test('Skip during a glide: the frozen rate is what gets matched', () => {
  for (const r1 of [0.94, 1.06]) for (const type of BLENDS) {
    const { B, planner, prev, incoming } = pair(124 * r1, 124, { durB: 60 });
    const t1 = planner.next(prev, incoming, { earliest: 4, force: { type: 'eqBlend', beats: 8 } });
    const playB = t1.play;
    const glideEnd = playB.rate[playB.rate.length - 1].t;
    const cancelledAt = playB.soloFrom + (glideEnd - playB.soloFrom) * 0.4;
    const C = synthAnalysis({ bpm: 126, duration: 60, first: 0.2 });
    const opts = { earliest: cancelledAt + 0.25, quick: true, cancelledAt, force: { type } };
    const prevB = { play: playB, analysis: B };
    const t2 = planner.next(prevB, { id: 'c', analysis: C }, opts);
    assert.equal(t2.type, type);
    assert.equal(t2.synced, true);
    assert.deepEqual(checkTransition(t2, { prev: prevB, incoming: { id: 'c', analysis: C }, opts }), []);
    const held = holdPlayAt(playB, cancelledAt);
    const frozen = rateAt(playB, cancelledAt);
    assert.ok(Math.abs(frozen - 1) > 0.01, 'cancel caught the glide part-way');
    assert.equal(rateAt(held, glideEnd + 5), frozen);
    const al = beatAlignment(t2, held, B, C);
    assert.ok(al.worst < 1e-6 && al.compared >= 4, `${al.worst}`);
    // quick: starts on the first beat ≥ earliest, yet downbeats still meet
    const firstBeat = B.beats.map((x) => timeAtPosition(held, x)).find((t) => t >= opts.earliest + 0.06 - 1e-9);
    assert.ok(Math.abs(t2.tStart - firstBeat) < 1e-6, 'starts on the next beat');
    assert.ok(al.downPairs >= 1);
    assert.ok(t2.tStart - opts.earliest < 0.06 + 60 / 124 / 0.9);
  }
});

test('drop-ins carry the tempo across when the tracks are close (≤ 3%)', () => {
  for (const type of ['cut', 'loopRoll', 'riserDrop']) for (const ratio of [0.975, 0.99, 1.028]) {
    const { A, B, planner, f, prev, incoming } = pair(126, 126 * ratio);
    const tr = planner.next(prev, incoming, { earliest: 4, force: { type } });
    assert.equal(tr.type, type);
    assert.equal(tr.synced, true);
    // incoming's bar line sits exactly on the outgoing's bar line at tEnd
    const posB = positionAt(tr.play, tr.tEnd);
    const j = B.beats.findIndex((x) => Math.abs(x - posB) < 1e-6);
    assert.ok(j >= 0 && (j - B.downbeat) % 4 === 0);
    const i = A.beats.findIndex((x) => Math.abs(timeAtPosition(f.play, x) - tr.tEnd) < 1e-6);
    assert.ok(i >= 0 && (i - A.downbeat) % 4 === 0);
    assert.ok(Math.abs(rateAt(tr.play, tr.tEnd) - 1 / ratio) < 1e-9);
    assertGlidesHome(tr, B);
  }
  // further apart, a track entering solo plays at its own speed (= its own pitch): still on the bar
  // line, but no tempo carry-over and no glide
  for (const type of ['cut', 'loopRoll', 'riserDrop']) for (const ratio of [0.93, 0.96, 1.04, 1.07]) {
    const { A, B, planner, f, prev, incoming } = pair(126, 126 * ratio);
    const tr = planner.next(prev, incoming, { earliest: 4, force: { type } });
    assert.equal(tr.type, type);
    assert.equal(tr.synced, false, `${type} ${ratio}`);
    assert.ok(tr.play.rate.every((q) => q.v === 1));
    const posB = positionAt(tr.play, tr.tEnd);
    const j = B.beats.findIndex((x) => Math.abs(x - posB) < 1e-6);
    assert.ok(j >= 0 && (j - B.downbeat) % 4 === 0, 'incoming on its downbeat at tEnd');
    const i = A.beats.findIndex((x) => Math.abs(timeAtPosition(f.play, x) - tr.tEnd) < 1e-6);
    assert.ok(i >= 0 && (i - A.downbeat) % 4 === 0, 'tEnd is a bar line of the outgoing track');
  }
});

test('unsyncable pairs are never blended: tempo gap or an untrustworthy grid', () => {
  const cases = [
    pair(120, 120 * 1.15),
    pair(120, 120 * 0.86),
    pair(124, 126, { a: { conf: 0.3 } }),
    pair(124, 126, { b: { conf: 0 } }),
  ];
  for (const [k, c] of cases.entries()) {
    for (let s = 0; s < 60; s++) {
      const planner = createPlanner({ seed: `u${s}`, vibe: s / 60 });
      const f = planner.first({ id: 'a', analysis: c.A }, { startAt: 0 });
      for (const force of [undefined, { type: 'bassSwap' }, { type: 'eqBlend' }, { type: 'filterBlend' }]) {
        const tr = planner.next({ play: f.play, analysis: c.A }, c.incoming, { earliest: 1, force });
        assert.ok(!BLENDS.includes(tr.type), `case ${k}: got ${tr.type}`);
        assert.equal(tr.synced, false);
        assert.ok(tr.play.rate.every((q) => q.v === 1), 'unsynced incoming plays at its own tempo from the start');
        // the reason names what is true: the tempos, or the ONE track the analysis could not vouch for
        assert.match(tr.why, [/tempos too far apart to match$/, /tempos too far apart to match$/, /no steady beat detected in the outgoing track$/, /no steady beat detected in the incoming track$/][k]);
      }
    }
  }
});

test('least-squares grids: jittery beat times still give the true tempo ratio and a tight lock', () => {
  const r = createRng('jitter');
  let worst = 0;
  for (let n = 0; n < 40; n++) {
    const bpmA = r.range(90, 150);
    const bpmB = bpmA * r.range(0.94, 1.06);
    const { A, B, planner, f, prev, incoming } = pair(bpmA, bpmB, { seed: `j${n}`, a: { jitter: 0.004, rng: r }, b: { jitter: 0.004, rng: r } });
    const tr = planner.next(prev, incoming, { earliest: 4, force: { type: 'bassSwap', beats: 16 } });
    assert.equal(tr.synced, true);
    // ±4 ms of jitter on single beats barely moves a 20-beat fit: the rate is the real ratio to ~0.1%
    assert.ok(Math.abs(tr.play.rate[0].v / (bpmA / bpmB) - 1) < 0.0015, `rate ${tr.play.rate[0].v} vs ${bpmA / bpmB}`);
    // measured against the jittered beats themselves the error is the jitter (≤ 8 ms pair-to-pair), not a drift
    const al = beatAlignment(tr, f.play, A, B);
    assert.ok(al.worst < 0.012, `${al.worst}`);
    worst = Math.max(worst, al.worst);
  }
  assert.ok(worst > 0.001, 'the jitter is really there');
});

test('a master that is too far off-speed mid-glide is not beat-matched', () => {
  // B was sped down 7% to meet A and is still gliding; C would need another −5% on top of that.
  const { B, planner, prev, incoming } = pair(120 * 0.93, 120, { durB: 11.7, b: { first: 0.1, downbeat: 0, cueEnd: 11.3 } });
  const t1 = planner.next(prev, incoming, { earliest: 4, force: { type: 'bassSwap', beats: 8 } });
  const C = synthAnalysis({ bpm: 126, duration: 60, first: 0.29 });
  const t2 = planner.next({ play: t1.play, analysis: B }, { id: 'c', analysis: C }, { earliest: t1.play.startAt + 1, force: { type: 'bassSwap', beats: 8 } });
  assert.ok(!BLENDS.includes(t2.type));
  assert.equal(t2.synced, false);
  assert.ok(t2.play.rate.every((q) => q.v === 1));
});

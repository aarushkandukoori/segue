// The planner on real music: real 30-second previews → the real analyzeTrack() → plans.
// Needs the audio fixtures of the analysis tests (git-ignored, `node tests/tools/fetch-fixtures.mjs`);
// without them — a fresh clone — every test here is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../js/dj/planner.js';
import { RECIPES } from '../js/dj/transitions.js';
import { loadRealCrate, onsetEnvelope, onsetLag } from './helpers/dj-real.js';
import { checkBusSessions, checkTransition, simulateSet } from './helpers/dj-synth.js';
import { GROUPS, formatSurvey, loadCrate, surveyAll, tally } from './helpers/mix-eval.js';

const crate = await loadRealCrate(48);
const skip = crate ? false : 'no audio fixtures (node tests/tools/fetch-fixtures.mjs) or no analysis module';

const fold = (r) => {
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
};

test('real previews: whole sets hold every invariant, no fallback plans', { skip }, () => {
  const hist = {};
  let n = 0;
  let synced = 0;
  let net = 0;
  for (const vibe of [0, 0.5, 1]) for (let s = 0; s < 3; s++) {
    const planner = createPlanner({ seed: `real-${s}`, vibe, mode: 'preview' });
    const sim = simulateSet(planner, crate, 40);
    assert.deepEqual(sim.violations.slice(0, 5), [], `vibe ${vibe} seed ${s}`);
    for (let i = 1; i < sim.transitions.length; i++) {
      const tr = sim.transitions[i];
      assert.equal(tr.degraded, undefined, `${tr.type} into play ${i}`);
      hist[tr.type] = (hist[tr.type] || 0) + 1;
      n++;
      if (tr.synced) synced++;
      net += tr.tEnd - sim.transitions[i - 1].tEnd;
    }
  }
  console.log(`      real previews (${crate.length} tracks): ${n} transitions · synced ${Math.round((100 * synced) / n)}% · net ${(net / n).toFixed(1)} s per preview · ${JSON.stringify(hist)}`);
  for (const type of Object.keys(RECIPES)) assert.ok(hist[type] > 0, `${type} never used on real music`);
  assert.ok(synced / n > 0.15, `beat-matched share ${synced / n}`);
  assert.ok(net / n > 19 && net / n < 29.5, `net set time per preview ${net / n}`);
});

test('real previews: a beat-matched blend puts real drum hits on real drum hits', { skip }, () => {
  // Every matchable ordered pair (thinned out), forced into a 16-beat bass swap; then listen for
  // where the incoming track's onsets actually fall against the outgoing track's during the overlap.
  const trusted = crate.filter((t) => t.analysis.bpmConfidence >= 0.5);
  const envs = new Map();
  const env = (t) => {
    if (!envs.has(t.id)) envs.set(t.id, onsetEnvelope(t.samples, t.sampleRate));
    return envs.get(t.id);
  };
  const lags = [];
  outer: for (let i = 0; i < trusted.length; i++) for (let j = 0; j < trusted.length; j++) {
    const A = trusted[i];
    const B = trusted[j];
    if (i === j || (i * 7 + j * 13) % 3 !== 0) continue;
    if (Math.abs(fold(A.analysis.bpm / B.analysis.bpm) - 1) > 0.075) continue;
    const planner = createPlanner({ seed: `lag-${i}-${j}`, vibe: 0.3, mode: 'preview' });
    const f = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
    const prev = { play: f.play, analysis: A.analysis };
    const incoming = { id: B.id, analysis: B.analysis };
    const opts = { earliest: 1, force: { type: 'bassSwap', beats: 16 } };
    const tr = planner.next(prev, incoming, opts);
    if (tr.type !== 'bassSwap' || !tr.synced) continue;
    assert.deepEqual([...checkTransition(tr, { prev, incoming, opts }), ...checkBusSessions(tr, { prev, incoming, opts })], [], `${A.title} → ${B.title}`);
    lags.push(Math.abs(onsetLag(tr, f.play, env(A), env(B))));
    if (lags.length >= 60) break outer;
  }
  if (lags.length < 10) return; // a crate with hardly any matchable pairs has nothing to say
  lags.sort((x, y) => x - y);
  const median = lags[Math.floor(lags.length / 2)];
  const within20 = lags.filter((x) => x <= 0.02).length / lags.length;
  console.log(`      real previews: ${lags.length} beat-matched pairs · onset offset median ${(median * 1000).toFixed(1)} ms · ${Math.round(within20 * 100)}% within 20 ms`);
  // (the rest are pairs whose rhythms correlate best a 16th apart — swing, off-beat hats — not drift)
  assert.ok(median <= 0.01, `median onset offset ${median * 1000} ms`);
  assert.ok(within20 >= 0.75, `only ${Math.round(within20 * 100)}% of pairs within 20 ms`);
});

test('real previews, sets per genre crate: the blends the planner allows itself put the drums together (raw, ±0.55 beat)', { skip }, () => {
  // The offline twin of tests/e2e/mix.e2e.mjs: every fixture, one crate per genre, sets planned the way
  // the conductor plans them; each overlapping beat-matched blend is measured by cross-correlating the
  // two tracks' attack envelopes over the overlap. No allowances: half a beat apart is a miss.
  const all = loadCrate();
  if (!all) return;
  const by = surveyAll(all, { seeds: 3 });
  console.log(formatSurvey(by).replace(/^/gm, '      '));
  const group = (list) => {
    const have = list.filter((g) => by[g]);
    const blends = have.flatMap((g) => by[g].blends);
    return { ...tally(blends), transitions: have.reduce((n, g) => n + by[g].transitions, 0), blendCount: have.reduce((n, g) => n + by[g].blendCount, 0) };
  };
  const steady = group(GROUPS.steady);
  const sync = group(GROUPS.syncopated);
  if (steady.n < 30 || sync.n < 20) return; // a tiny fixture set has nothing to say
  // wanted: ≥ 92 % on dance / electro / pop, ≥ 85 % on hip-hop / latin / r&b (measured on the 357 fixtures
  // this was written with: 98 % / 96 %; another day's charts are other songs, hence floors, not the figures)
  assert.ok(steady.tight / steady.n >= 0.92, `dance + electro + pop: ${steady.tight} of ${steady.n} blends within 20 ms`);
  assert.ok(sync.tight / sync.n >= 0.85, `hip-hop + latin + r&b: ${sync.tight} of ${sync.n} blends within 20 ms`);
  // … and blending has not been gated away where it works (measured: 33 % of dance + electro transitions)
  const dance = group(['dance', 'electro']);
  assert.ok(dance.blendCount / dance.transitions >= 0.2, `dance + electro: ${dance.blendCount} blends in ${dance.transitions} transitions`);
  assert.ok(sync.blendCount / sync.transitions >= 0.08, `syncopated crates still blend sometimes: ${sync.blendCount} in ${sync.transitions}`);
});

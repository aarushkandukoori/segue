// Accuracy on REAL music. Needs the fixtures from `node tests/tools/fetch-fixtures.mjs`
// (tests/fixtures/analysis, git-ignored); skips cleanly when they are not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures, evaluate, formatReport } from './helpers/analysis-eval.js';
import { assertValidAnalysis } from './helpers/analysis-assert.js';
import { ANALYSIS_VERSION } from '../js/analysis/analyze.js';

const tracks = loadFixtures();
const skip = tracks ? false : 'no fixtures (run: node tests/tools/fetch-fixtures.mjs)';

/** @type {ReturnType<typeof evaluate> | null} */
let result = null;
const run = () => (result ||= evaluate(tracks));

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

test('real previews: every analysis is structurally valid and within the time budget', { skip }, () => {
  const { rows, summary } = run();
  console.log(formatReport(result).replace(/^/gm, '    '));
  for (const r of rows) {
    try {
      assertValidAnalysis(r.analysis, r.analysis.duration, ANALYSIS_VERSION);
    } catch (err) {
      err.message = `${r.track.artist} — ${r.track.title}: ${err.message}`;
      throw err;
    }
  }
  assert.ok(summary.meanMs <= 250, `mean ${summary.meanMs.toFixed(0)} ms per 30 s clip`);
});

test('real previews: tempo accuracy against published tempos (hand list)', { skip }, (t) => {
  const s = run().summary.sets.hand;
  if (s.n < 30) return t.skip(`only ${s.n} hand-list fixtures`);
  const strict = s.strict / s.n;
  const octave = s.octave / s.n;
  // product targets …
  assert.ok(strict >= 0.7, `strict accuracy ${(100 * strict).toFixed(1)} % < 70 %`);
  assert.ok(octave >= 0.88, `octave-tolerant accuracy ${(100 * octave).toFixed(1)} % < 88 %`);
  // … and a regression floor a little below what was measured when this was written (96.7 % / 99.4 %)
  assert.ok(strict >= 0.92, `strict accuracy regressed to ${(100 * strict).toFixed(1)} %`);
  assert.ok(octave >= 0.97, `octave-tolerant accuracy regressed to ${(100 * octave).toFixed(1)} %`);
});

test("real previews: tempo accuracy against Deezer's own bpm field (noisy reference)", { skip }, (t) => {
  const s = run().summary.sets.deezer;
  if (s.n < 20) return t.skip(`only ${s.n} Deezer-only fixtures`);
  assert.ok(s.strict / s.n >= 0.7, `strict ${(100 * s.strict) / s.n} %`);
  assert.ok(s.octave / s.n >= 0.85, `octave-tolerant ${(100 * s.octave) / s.n} %`);
});

test('real previews: beats sit on onsets (ground-truth-free phase proxy)', { skip }, () => {
  const rows = run().rows.filter((r) => r.track.genre !== 'rubato' && r.analysis.bpmConfidence >= 0.5);
  const clear = rows.filter((r) => r.phase.onVsHalf >= 1.25).length / rows.length;
  assert.ok(clear >= 0.6, `only ${(100 * clear).toFixed(0)} % of confident tracks have clearly stronger attacks on the beats than between them`);
  const backwards = rows.filter((r) => r.phase.onVsHalf < 0.7).length / rows.length;
  assert.ok(backwards <= 0.08, `${(100 * backwards).toFixed(0)} % of confident tracks have their strongest attacks BETWEEN the beats`);
});

test('real previews: bpmConfidence is high for four-on-the-floor dance music and low for rubato / ambient', { skip }, (t) => {
  const rows = run().rows;
  const dance = rows.filter((r) => r.track.source === 'hand' && (r.track.genre === 'dance' || r.track.genre === 'electro')).map((r) => r.analysis.bpmConfidence);
  const rubato = rows.filter((r) => r.track.genre === 'rubato').map((r) => r.analysis.bpmConfidence);
  if (dance.length < 10) return t.skip('not enough dance fixtures');
  assert.ok(median(dance) >= 0.75, `dance median ${median(dance)}`);
  assert.ok(dance.filter((c) => c >= 0.5).length / dance.length >= 0.8, 'at least 80 % of dance tracks are beat-matchable');
  if (rubato.length >= 8) {
    assert.ok(median(rubato) < 0.3, `rubato median ${median(rubato)}`);
    assert.ok(rubato.filter((c) => c >= 0.5).length / rubato.length <= 0.4, 'most rubato tracks are below the beat-matching threshold');
  }
  // when the analysis says "trust me", the tempo class is right
  const judged = rows.filter((r) => r.verdict && r.analysis.bpmConfidence >= 0.5);
  const right = judged.filter((r) => r.verdict.octave).length / judged.length;
  assert.ok(right >= 0.94, `tempo class correct for ${(100 * right).toFixed(1)} % of confident tracks`);
});

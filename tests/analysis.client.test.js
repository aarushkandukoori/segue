// client.js in Node: no Worker, no IndexedDB → exactly the fallback paths (main-thread analysis, memory
// cache). The Worker + IndexedDB paths are covered in headless Chrome by tests/e2e/analysis.e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, prepareAudio } from '../js/analysis/client.js';
import { analyzeTrack, ANALYSIS_VERSION, ANALYSIS_RATE } from '../js/analysis/analyze.js';
import { resample } from '../js/analysis/dsp.js';
import { drumLoop } from './helpers/analysis-synth.js';
import { assertValidAnalysis } from './helpers/analysis-assert.js';

/** Minimal AudioBuffer stand-in. */
function fakeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (c) => channels[c],
  };
}

test('prepareAudio: stereo → mono mix at the analysis rate, true peak of the channels', async () => {
  const sr = 48000;
  const loop = drumLoop({ bpm: 120, seconds: 6, sr }).samples;
  const left = Float32Array.from(loop, (v) => v * 0.9);
  const right = Float32Array.from(loop, (v) => -v * 0.3); // partly out of phase: the mono mix is quieter
  right[1234] = 0.97;
  const out = await prepareAudio(fakeBuffer([left, right], sr));
  assert.equal(out.sampleRate, ANALYSIS_RATE);
  assert.equal(out.pcm.length, Math.round((loop.length * ANALYSIS_RATE) / sr));
  const peakLeft = left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(out.peak - Math.max(peakLeft, 0.97)) < 1e-6, `peak ${out.peak}`);
  const mono = Float32Array.from(left, (v, i) => 0.5 * (v + right[i]));
  const want = resample(mono, sr, ANALYSIS_RATE);
  assert.deepEqual(out.pcm, want);
  // already at the analysis rate: no resampling, mono passes straight through
  const same = await prepareAudio(fakeBuffer([Float32Array.from([0.1, -0.2, 0.3])], ANALYSIS_RATE));
  assert.deepEqual(Array.from(same.pcm), [0.1, -0.2, 0.3].map(Math.fround));
  // NaN samples do not poison the peak
  const bad = await prepareAudio(fakeBuffer([Float32Array.from([0.1, NaN, -0.4])], ANALYSIS_RATE));
  assert.ok(Math.abs(bad.peak - 0.4) < 1e-6);
  const empty = await prepareAudio(fakeBuffer([new Float32Array(0)], 44100));
  assert.equal(empty.pcm.length, 0);
});

test('createAnalyzer without Workers / IndexedDB: main-thread analysis, memory cache, de-duplication', async () => {
  const analyzer = createAnalyzer();
  const sr = 44100;
  const loop = drumLoop({ bpm: 126, seconds: 12, sr });
  const buffer = fakeBuffer([loop.samples, loop.samples], sr);

  assert.equal(await analyzer.cached('deezer:1'), null);
  const [a, b] = await Promise.all([
    analyzer.analyze(buffer, { key: 'deezer:1', bpmHint: 126 }),
    analyzer.analyze(buffer, { key: 'deezer:1', bpmHint: 126 }),
  ]);
  assert.equal(a, b, 'concurrent requests for the same key share one analysis');
  assertValidAnalysis(a, 12, ANALYSIS_VERSION);
  assert.ok(Math.abs(a.bpm - 126) < 0.3);

  // identical to calling analyzeTrack on the prepared audio
  const prepared = await prepareAudio(buffer);
  assert.deepEqual(a, analyzeTrack(prepared.pcm, prepared.sampleRate, { bpmHint: 126, peak: prepared.peak, duration: buffer.duration }));

  let stats = analyzer.stats;
  assert.equal(stats.main, 1);
  assert.equal(stats.worker, 0);
  assert.equal(stats.storage, 'memory');

  assert.equal(await analyzer.cached('deezer:1'), a);
  assert.equal(await analyzer.analyze(buffer, { key: 'deezer:1' }), a, 'second call is a cache hit');
  stats = analyzer.stats;
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.main, 1);

  // a different key is analysed again; no key = never cached
  const c = await analyzer.analyze(buffer, { key: 'deezer:2' });
  assert.notEqual(c, a);
  await analyzer.analyze(buffer, {});
  await analyzer.analyze(buffer, {});
  assert.equal(analyzer.stats.main, 4);
  assert.equal(await analyzer.cached(''), null);

  analyzer.destroy();
  await assert.rejects(() => analyzer.analyze(buffer, { key: 'deezer:3' }), /destroyed/);
});

test('createAnalyzer({workers: 0}) and odd buffers', async () => {
  const analyzer = createAnalyzer({ workers: 0 });
  const silent = await analyzer.analyze(fakeBuffer([new Float32Array(48000 * 3)], 48000), { key: 'local:silence:1:2' });
  assertValidAnalysis(silent, 3, ANALYSIS_VERSION);
  assert.equal(silent.bpmConfidence, 0);
  const empty = await analyzer.analyze(fakeBuffer([new Float32Array(0)], 48000), { key: 'local:empty:0:0' });
  assertValidAnalysis(empty, 0, ANALYSIS_VERSION);
  analyzer.destroy();
});

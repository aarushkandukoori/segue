import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, ANALYSIS_VERSION, ANALYSIS_RATE } from '../js/analysis/analyze.js';
import { drumLoop, clickTrack, noise, ambientPad } from './helpers/analysis-synth.js';
import { assertValidAnalysis } from './helpers/analysis-assert.js';

const FS = 22050;

test('ANALYSIS_VERSION is a positive integer, ANALYSIS_RATE is 22050', () => {
  assert.ok(Number.isInteger(ANALYSIS_VERSION) && ANALYSIS_VERSION > 0);
  assert.equal(ANALYSIS_RATE, 22050);
});

test('never throws and always returns a structurally valid Analysis', () => {
  const loop6 = drumLoop({ bpm: 120, seconds: 6 }).samples;
  const dirty = drumLoop({ bpm: 126, seconds: 12 }).samples;
  for (let i = 0; i < dirty.length; i += 997) dirty[i] = NaN;
  dirty[5] = Infinity;
  dirty[9] = -Infinity;
  /** @type {Record<string, [any, number]>} */
  const cases = {
    'empty buffer': [new Float32Array(0), FS],
    'one sample': [new Float32Array(1).fill(0.5), 44100],
    '10 s of digital silence': [new Float32Array(FS * 10), FS],
    '10 s of white noise': [noise(10), FS],
    '2 s clip': [drumLoop({ bpm: 120, seconds: 2 }).samples, FS],
    '4 s clip': [drumLoop({ bpm: 120, seconds: 4 }).samples, FS],
    '0.3 s clip': [drumLoop({ bpm: 120, seconds: 0.3 }).samples, FS],
    'beatless ambient pad': [ambientPad(20), FS],
    'NaN / Infinity samples': [dirty, FS],
    'all NaN': [new Float32Array(50000).fill(NaN), FS],
    'DC offset only': [new Float32Array(100000).fill(0.5), FS],
    'absurd amplitude': [new Float32Array(100000).fill(1e30), FS],
    '8 kHz': [drumLoop({ bpm: 100, seconds: 15, sr: 8000 }).samples, 8000],
    '11.025 kHz': [drumLoop({ bpm: 100, seconds: 15, sr: 11025 }).samples, 11025],
    '44.1 kHz': [drumLoop({ bpm: 128, seconds: 15, sr: 44100 }).samples, 44100],
    '48 kHz': [drumLoop({ bpm: 128, seconds: 15, sr: 48000 }).samples, 48000],
    '96 kHz': [drumLoop({ bpm: 100, seconds: 8, sr: 96000 }).samples, 96000],
    'plain Array input': [Array.from(loop6), FS],
    'Float64Array input': [Float64Array.from(loop6), FS],
    'sample rate NaN': [loop6, NaN],
    'sample rate 0': [loop6, 0],
    'null input': [null, FS],
  };
  for (const [name, [x, sr]] of Object.entries(cases)) {
    let a;
    assert.doesNotThrow(() => {
      a = analyzeTrack(x, sr);
    }, name);
    const rate = sr > 0 ? sr : FS;
    const duration = (x ? x.length : 0) / rate;
    try {
      assertValidAnalysis(a, duration, ANALYSIS_VERSION);
    } catch (err) {
      err.message = `${name}: ${err.message}`;
      throw err;
    }
  }
  // garbage options do not matter either
  assert.doesNotThrow(() => analyzeTrack(loop6, FS, null));
  assert.doesNotThrow(() => analyzeTrack(loop6, FS, { bpmHint: 'fast', peak: 'loud' }));
});

test('no beat → bpmConfidence ≈ 0 and a regular fallback grid', () => {
  const regular = (a) => {
    const step = a.beats[1] - a.beats[0];
    for (let i = 2; i < a.beats.length; i++) assert.ok(Math.abs(a.beats[i] - a.beats[i - 1] - step) < 0.03 * step, 'regular grid');
    assert.ok(Math.abs(60 / step - a.bpm) < 0.02 * a.bpm, 'grid matches the reported tempo');
  };
  for (const [name, x] of [
    ['silence', new Float32Array(FS * 10)],
    ['white noise', noise(12)],
    ['ambient pad', ambientPad(20)],
    ['2 s clip', drumLoop({ bpm: 120, seconds: 2 }).samples],
  ]) {
    const a = analyzeTrack(x, FS);
    assert.ok(a.bpmConfidence < 0.25, `${name}: confidence ${a.bpmConfidence}`);
    regular(a);
  }
  // … while real drums are confidently above the beat-matching threshold
  assert.ok(analyzeTrack(drumLoop({ bpm: 124, seconds: 20 }).samples, FS).bpmConfidence >= 0.8);
});

test('silence has neutral everything', () => {
  const a = analyzeTrack(new Float32Array(FS * 10), FS);
  assert.equal(a.bpm, 120);
  assert.equal(a.bpmConfidence, 0);
  assert.equal(a.downbeat, 0);
  assert.equal(a.beats.length, 20);
  assert.equal(a.key.confidence, 0);
  assert.deepEqual(a.loudness, { rms: 0, peak: 0, trimDb: 0 });
  assert.equal(a.energy, 0);
  assert.deepEqual(a.cues, { start: 0, end: 10, in: 0, drop: null });
  assert.ok(a.wave.low.every((v) => v === 0));
});

test('deterministic: the same input gives a deep-equal result, and the input is not modified', () => {
  const loop = drumLoop({ bpm: 123, seconds: 20, offset: 0.31, downbeat: 2 });
  const copy = Float32Array.from(loop.samples);
  const a = analyzeTrack(loop.samples, loop.sr, { bpmHint: 123 });
  const b = analyzeTrack(loop.samples, loop.sr, { bpmHint: 123 });
  assert.deepEqual(a, b);
  assert.deepEqual(loop.samples, copy);
  // analysing something else in between does not leak state (shared FFT scratch buffers)
  analyzeTrack(noise(5), FS);
  analyzeTrack(clickTrack({ bpm: 90, seconds: 8, sr: 48000 }).samples, 48000);
  assert.deepEqual(analyzeTrack(loop.samples, loop.sr, { bpmHint: 123 }), a);
});

test('sample rate does not change the answer (same music at 22.05, 44.1 and 48 kHz)', () => {
  const ref = drumLoop({ bpm: 126, seconds: 20, sr: 22050, offset: 0.25 });
  const a = analyzeTrack(ref.samples, 22050);
  for (const sr of [44100, 48000]) {
    const other = drumLoop({ bpm: 126, seconds: 20, sr, offset: 0.25 });
    const b = analyzeTrack(other.samples, sr);
    assert.ok(Math.abs(a.bpm - b.bpm) < 0.05, `bpm ${a.bpm} vs ${b.bpm} @ ${sr}`);
    assert.equal(a.beats.length, b.beats.length);
    for (let i = 0; i < a.beats.length; i++) assert.ok(Math.abs(a.beats[i] - b.beats[i]) < 0.004, `beat ${i} @ ${sr}`);
    assert.equal(a.downbeat, b.downbeat);
    assert.equal(a.key.camelot, b.key.camelot);
    assert.equal(b.wave.cols, 2000);
  }
});

test('JSON / structured-clone friendly: plain data only', () => {
  const a = analyzeTrack(drumLoop({ bpm: 120, seconds: 8 }).samples, FS);
  const clone = structuredClone(a);
  assert.deepEqual(clone, a);
  assert.ok(clone.wave.low instanceof Uint8Array);
  assert.deepEqual(Object.keys(a).sort(), ['beats', 'bpm', 'bpmConfidence', 'cues', 'downbeat', 'duration', 'energy', 'energyCurve', 'grid', 'key', 'loudness', 'v', 'wave']);
  assert.deepEqual(Object.keys(a.wave).sort(), ['cols', 'high', 'low', 'mid', 'perSec']);
  assert.deepEqual(Object.keys(a.grid).sort(), ['head', 'perBeat', 'phase', 'slots', 'tail']);
  assert.ok(clone.grid.slots instanceof Uint8Array);
});

test('performance budgets: 30 s clip ≤ 250 ms, 5-minute track ≤ 3 s', () => {
  const best = (fn, runs) => {
    let t = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      t = Math.min(t, performance.now() - t0);
    }
    return t;
  };
  const clip = drumLoop({ bpm: 124, seconds: 30 });
  analyzeTrack(clip.samples, clip.sr); // warm-up (JIT, FFT tables)
  const short = best(() => analyzeTrack(clip.samples, clip.sr), 3);
  const long = drumLoop({ bpm: 124, seconds: 300 });
  let a;
  const full = best(() => {
    a = analyzeTrack(long.samples, long.sr);
  }, 2);
  console.log(`    analyzeTrack: 30 s clip ${short.toFixed(0)} ms, 5-minute track ${full.toFixed(0)} ms`);
  assert.ok(short <= 250, `30 s clip took ${short.toFixed(0)} ms`);
  assert.ok(full <= 3000, `5-minute track took ${full.toFixed(0)} ms`);
  // and the long grid is still exact at the far end (no drift over 620 beats)
  assertValidAnalysis(a, 300, ANALYSIS_VERSION);
  assert.ok(Math.abs(a.bpm - 124) < 0.01);
  const last = long.beatTimes[long.beatTimes.length - 2];
  assert.ok(a.beats.some((b) => Math.abs(b - last) < 0.005), 'last beats still on the grid');
});

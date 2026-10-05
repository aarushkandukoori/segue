import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, ANALYSIS_VERSION } from '../js/analysis/analyze.js';
import { foldBpm } from '../js/analysis/tempo.js';
import { drumLoop, clickTrack } from './helpers/analysis-synth.js';
import { assertValidAnalysis, beatErrors } from './helpers/analysis-assert.js';

const TEMPOS = [80, 96, 110, 120, 128, 140, 174];

/** Is analysis downbeat on a true bar line? */
function downbeatOk(a, loop) {
  const bar = (4 * 60) / loop.bpm;
  const d = (a.beats[a.downbeat] - loop.beatTimes[loop.downbeat]) / bar;
  return Math.abs(d - Math.round(d)) * bar < 0.03;
}

for (const bpm of TEMPOS) {
  test(`drum loop at ${bpm} BPM: tempo within 0.3 %, beat phase within 12 ms, downbeat on the bar line`, () => {
    // non-zero phase offset and a bar that does not start on beat 0
    const loop = drumLoop({ bpm, offset: 0.137 + bpm / 3000, downbeat: bpm % 4, seconds: 30 });
    const a = analyzeTrack(loop.samples, loop.sr);
    assertValidAnalysis(a, 30, ANALYSIS_VERSION);
    assert.ok(Math.abs(a.bpm / bpm - 1) < 0.003, `bpm ${a.bpm} vs ${bpm}`);
    const e = beatErrors(a.beats, loop.beatTimes);
    assert.ok(e.count > 20);
    assert.ok(e.maxMs <= 12, `max beat error ${e.maxMs.toFixed(2)} ms`);
    assert.ok(Math.abs(e.meanMs) <= 4, `mean beat error ${e.meanMs.toFixed(2)} ms`);
    assert.ok(downbeatOk(a, loop), `downbeat index ${a.downbeat} (beat at ${a.beats[a.downbeat]}) is not a bar line`);
    assert.ok(a.bpmConfidence >= 0.8, `confidence ${a.bpmConfidence}`);
    // cues.in is the first downbeat inside the usable region
    assert.ok(Math.abs(a.cues.in - a.beats[a.downbeat]) < 1e-9);
  });

  test(`bare click track at ${bpm} BPM: sample-accurate grid`, () => {
    const clicks = clickTrack({ bpm, offset: 0.211, seconds: 20 });
    const a = analyzeTrack(clicks.samples, clicks.sr);
    assertValidAnalysis(a, 20, ANALYSIS_VERSION);
    assert.ok(Math.abs(a.bpm / bpm - 1) < 0.003, `bpm ${a.bpm}`);
    const e = beatErrors(a.beats, clicks.beatTimes);
    assert.ok(e.maxMs <= 3, `max beat error ${e.maxMs.toFixed(2)} ms`);
  });
}

test('every downbeat position (0..3) is found', () => {
  for (let downbeat = 0; downbeat < 4; downbeat++) {
    const loop = drumLoop({ bpm: 124, offset: 0.09, downbeat, seconds: 30 });
    const a = analyzeTrack(loop.samples, loop.sr);
    assert.ok(downbeatOk(a, loop), `downbeat ${downbeat}: got index ${a.downbeat}`);
  }
});

test('tempo is folded into [70, 180): 60 → 120, 65 → 130, 200 → 100, 185 → 92.5', () => {
  for (const [bpm, want] of [
    [60, 120],
    [65, 130],
    [200, 100],
    [185, 92.5],
  ]) {
    const clicks = clickTrack({ bpm, seconds: 24 });
    const a = analyzeTrack(clicks.samples, clicks.sr);
    assertValidAnalysis(a, 24, ANALYSIS_VERSION);
    assert.ok(Math.abs(a.bpm / want - 1) < 0.003, `${bpm} → ${a.bpm}, wanted ${want}`);
    // the beats follow the folded tempo and stay phase-locked to the clicks
    const step = (a.beats[a.beats.length - 1] - a.beats[0]) / (a.beats.length - 1);
    assert.ok(Math.abs(60 / step / want - 1) < 0.003);
    const hits = clicks.beatTimes.filter((t) => t > 1 && t < 22 && a.beats.some((b) => Math.abs(b - t) < 0.012)).length;
    const expected = clicks.beatTimes.filter((t) => t > 1 && t < 22).length;
    assert.ok(hits >= expected * (bpm > 180 ? 0.45 : 0.95), `${hits}/${expected} clicks have a beat on them`);
  }
  assert.equal(foldBpm(60), 120);
  assert.equal(foldBpm(360), 90);
  assert.equal(foldBpm(NaN), 120);
});

test('loud open hi-hats on the off-beat do not pull the grid half a beat off', () => {
  for (const bpm of [100, 124, 128, 138, 150]) {
    const loop = drumLoop({ bpm, hatAmp: 0.5, hatDecay: 0.06, snare: false, seconds: 30 });
    const a = analyzeTrack(loop.samples, loop.sr);
    assert.ok(Math.abs(a.bpm / bpm - 1) < 0.003, `bpm ${a.bpm} vs ${bpm}`);
    const e = beatErrors(a.beats, loop.beatTimes);
    assert.ok(e.maxMs <= 12, `${bpm} BPM: beats are ${e.meanMs.toFixed(0)} ms from the kicks`);
  }
});

test('a silent intro is covered by the same grid, extrapolated backwards', () => {
  const loop = drumLoop({ bpm: 126, lead: 4.3, seconds: 30 });
  const a = analyzeTrack(loop.samples, loop.sr);
  assertValidAnalysis(a, 30, ANALYSIS_VERSION);
  assert.ok(a.beats[0] < 60 / 126, 'grid starts at the top of the file');
  // every beat — including the ones inside the silence — sits on the true (virtual) grid
  for (const b of a.beats) {
    const nearest = loop.beatTimes.reduce((best, t) => (Math.abs(t - b) < Math.abs(best - b) ? t : best), Infinity);
    assert.ok(Math.abs(nearest - b) < 0.012, `beat ${b} is ${(1000 * (b - nearest)).toFixed(1)} ms off the grid`);
  }
  assert.ok(a.cues.start > 4 && a.cues.start < 4.8, `cues.start ${a.cues.start}`);
  assert.ok(a.cues.in >= a.cues.start && a.cues.in < a.cues.start + (4 * 60) / 126 + 0.05);
  assert.equal(a.cues.drop, null, 'silence → music is an intro, not a drop');
});

test('a drummer who drifts is followed (beats are local, not one rigid grid)', () => {
  // 108 → 114 BPM over 30 s
  const beatTimes = [];
  for (let t = 0.2; t < 30; ) {
    beatTimes.push(t);
    t += 60 / (108 + (6 * t) / 30);
  }
  const loop = drumLoop({ bpm: 111, beatTimes, seconds: 30 });
  const a = analyzeTrack(loop.samples, loop.sr);
  assertValidAnalysis(a, 30, ANALYSIS_VERSION);
  assert.ok(a.bpm > 108 && a.bpm < 114, `bpm ${a.bpm}`);
  const inner = a.beats.filter((b) => b > 1.5 && b < 28.5);
  const close = inner.filter((b) => beatTimes.some((t) => Math.abs(t - b) < 0.02)).length;
  assert.ok(close >= inner.length * 0.9, `only ${close}/${inner.length} beats within 20 ms of the drummer`);
  // the local tempo at the start is slower than at the end
  const first = a.beats[9] - a.beats[1];
  const last = a.beats[a.beats.length - 2] - a.beats[a.beats.length - 10];
  assert.ok(first > last * 1.02, `intervals do not shrink: ${first} vs ${last}`);
});

test('bpmHint is only a hint: it names the grid of beatless audio and does not override real drums', () => {
  const silence = new Float32Array(22050 * 10);
  const a = analyzeTrack(silence, 22050, { bpmHint: 200 });
  assert.equal(a.bpm, 100);
  assert.equal(a.bpmConfidence, 0);
  assert.ok(Math.abs(a.beats[1] - a.beats[0] - 0.6) < 1e-9);
  const loop = drumLoop({ bpm: 128, seconds: 20 });
  for (const hint of [128, 64, 96, 171, -5, NaN, Infinity]) {
    const b = analyzeTrack(loop.samples, loop.sr, { bpmHint: hint });
    assert.ok(Math.abs(b.bpm - 128) < 0.3, `hint ${hint} → ${b.bpm}`);
  }
});

test('a clear drop is reported on its downbeat', () => {
  const loop = drumLoop({ bpm: 128, seconds: 30, offset: 0.1 });
  const tDrop = loop.beatTimes[32];
  for (let i = 0; i < Math.round(tDrop * loop.sr); i++) loop.samples[i] *= 0.25; // −12 dB before the drop
  const a = analyzeTrack(loop.samples, loop.sr);
  assert.ok(a.cues.drop !== null, 'drop found');
  assert.ok(Math.abs(a.cues.drop - tDrop) < 0.02, `drop at ${a.cues.drop}, expected ${tDrop}`);
  // and a loop without any change has none
  const flat = analyzeTrack(drumLoop({ bpm: 128, seconds: 30 }).samples, 22050);
  assert.equal(flat.cues.drop, null);
});

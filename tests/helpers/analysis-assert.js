// Structural contract of an Analysis (SPEC.md §3) — every analyzeTrack result must pass, whatever the input.
import assert from 'node:assert/strict';

const CAMELOT = /^(1[0-2]|[1-9])[AB]$/;

/**
 * @param {any} a          result of analyzeTrack
 * @param {number} duration expected duration in seconds
 * @param {number} version  expected ANALYSIS_VERSION
 */
export function assertValidAnalysis(a, duration, version) {
  assert.equal(typeof a, 'object');
  assert.equal(a.v, version, 'version');
  assert.ok(Math.abs(a.duration - duration) < 1e-6, `duration ${a.duration} vs ${duration}`);

  assert.ok(Number.isFinite(a.bpm) && a.bpm >= 70 && a.bpm < 180, `bpm in [70,180): ${a.bpm}`);
  assert.ok(Number.isFinite(a.bpmConfidence) && a.bpmConfidence >= 0 && a.bpmConfidence <= 1, `bpmConfidence ${a.bpmConfidence}`);

  assert.ok(Array.isArray(a.beats) && a.beats.length >= 1, 'beats is a non-empty array');
  for (let i = 0; i < a.beats.length; i++) {
    const b = a.beats[i];
    assert.ok(Number.isFinite(b) && b >= 0, `beat ${i} finite and ≥ 0: ${b}`);
    if (i > 0) assert.ok(b > a.beats[i - 1], `beats strictly increasing at ${i}`);
    if (duration > 0 && i > 0) assert.ok(b < duration, `beat ${i} inside the track`);
  }
  if (duration > 2) {
    // the grid covers the whole track: no hole bigger than ~1 beat at either end, no huge gaps inside
    const maxStep = 60 / 70 + 0.05;
    assert.ok(a.beats[0] <= maxStep, `first beat too late: ${a.beats[0]}`);
    assert.ok(duration - a.beats[a.beats.length - 1] <= maxStep, `last beat too early: ${a.beats[a.beats.length - 1]} of ${duration}`);
    for (let i = 1; i < a.beats.length; i++) {
      const d = a.beats[i] - a.beats[i - 1];
      assert.ok(d > 60 / 180 / 1.3 && d < maxStep * 1.3, `beat interval ${d} at ${i}`);
    }
  }
  assert.ok(Number.isInteger(a.downbeat) && a.downbeat >= 0 && a.downbeat < Math.max(1, Math.min(4, a.beats.length)), `downbeat ${a.downbeat}`);

  assert.ok(Number.isInteger(a.key.pc) && a.key.pc >= 0 && a.key.pc <= 11, 'key.pc');
  assert.ok(a.key.mode === 'major' || a.key.mode === 'minor', 'key.mode');
  assert.equal(typeof a.key.name, 'string');
  assert.match(a.key.camelot, CAMELOT);
  assert.ok(a.key.confidence >= 0 && a.key.confidence <= 1, 'key.confidence');

  assert.ok(Number.isFinite(a.loudness.rms) && a.loudness.rms >= 0, 'loudness.rms');
  assert.ok(Number.isFinite(a.loudness.peak) && a.loudness.peak >= 0, 'loudness.peak');
  assert.ok(Number.isFinite(a.loudness.trimDb) && a.loudness.trimDb >= -12 && a.loudness.trimDb <= 6, `trimDb ${a.loudness.trimDb}`);

  assert.ok(Number.isFinite(a.energy) && a.energy >= 0 && a.energy <= 1, `energy ${a.energy}`);
  assert.ok(Array.isArray(a.energyCurve), 'energyCurve');
  assert.equal(a.energyCurve.length, Math.max(1, Math.ceil(duration)), 'one energyCurve value per second');
  for (const v of a.energyCurve) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `energyCurve value ${v}`);

  const c = a.cues;
  assert.ok(Number.isFinite(c.start) && Number.isFinite(c.end) && Number.isFinite(c.in), 'cues finite');
  assert.ok(c.start >= 0 && c.start <= c.end && c.end <= duration + 1e-9, `cues.start/end ${c.start} ${c.end}`);
  assert.ok(c.in >= c.start - 1e-3 && c.in <= Math.max(c.end, c.start), `cues.in ${c.in}`);
  assert.ok(c.drop === null || (Number.isFinite(c.drop) && c.drop >= c.start && c.drop <= c.end), `cues.drop ${c.drop}`);

  const w = a.wave;
  assert.equal(w.perSec, 100);
  assert.equal(w.cols, Math.max(1, Math.ceil(duration * 100 - 1e-6)), 'wave.cols = 100 per second');
  for (const band of ['low', 'mid', 'high']) {
    assert.ok(w[band] instanceof Uint8Array, `wave.${band} is a Uint8Array`);
    assert.equal(w[band].length, w.cols, `wave.${band} length`);
  }
}

/** Mean / max distance (ms) from analysis beats to the nearest true beat, ignoring the first and last second. */
export function beatErrors(beats, truth) {
  let sum = 0;
  let max = 0;
  let k = 0;
  const lo = truth[0] + 1;
  const hi = truth[truth.length - 1] - 1;
  for (const b of beats) {
    if (b < lo || b > hi) continue;
    let best = Infinity;
    for (const t of truth) if (Math.abs(b - t) < Math.abs(best)) best = b - t;
    sum += best;
    if (Math.abs(best) > max) max = Math.abs(best);
    k++;
  }
  return { meanMs: k ? (1000 * sum) / k : NaN, maxMs: 1000 * max, count: k };
}

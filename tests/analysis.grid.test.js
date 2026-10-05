// The beat grid against the audible attacks (js/analysis/grid.js) and the trust signal it produces
// (Analysis.grid): synthetic audio with a known grid here; the calibration on real previews is at the
// end (skipped without the audio fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, ANALYSIS_VERSION, GRID_EDGE_BEATS } from '../js/analysis/analyze.js';
import {
  ATT_RATE,
  ATTACK_DELAY_MS,
  MARGIN_GATE,
  SLOTS_PER_BEAT,
  alignGrid,
  attackEnvelope,
  beatProfile,
  edgeTrust,
  halfBeatEvidence,
  isHalfBeatOff,
  lowBand,
  marginToTrust,
  onOff,
  slotPattern,
} from '../js/analysis/grid.js';
import { assertValidAnalysis, beatErrors } from './helpers/analysis-assert.js';
import { ambientPad, clickTrack, drumLoop, noise } from './helpers/analysis-synth.js';
import { calibrate, formatCalibration, loadCrate } from './helpers/mix-eval.js';

const FS = 22050;
const loop = drumLoop({ bpm: 120, seconds: 24, offset: 0.2 });
const env = attackEnvelope(loop.samples, FS);
const half = loop.beatTimes.map((t) => t + 0.25);
const sixteenth = loop.beatTimes.map((t) => t + 0.125);

test('attackEnvelope: one value per millisecond, silent in silence, peaks just after an attack', () => {
  assert.equal(ATT_RATE, 1000);
  assert.equal(env.length, Math.floor(loop.samples.length / FS * 1000));
  const clicks = clickTrack({ bpm: 120, seconds: 6, offset: 0.3 });
  const e = attackEnvelope(clicks.samples, FS);
  assert.ok(e.every((v) => v >= 0));
  for (const t of clicks.beatTimes.slice(1, -1)) {
    const c = Math.round(t * 1000);
    let at = c - 40;
    for (let k = c - 40; k <= c + 40; k++) if (e[k] > e[at]) at = k;
    assert.ok(at - c >= 1 && at - c <= 12, `click at ${t}: envelope peaks ${at - c} ms later`);
    assert.equal(e[c - 20], 0, 'nothing before the click');
  }
  // a kick drum: the profile over all beats peaks about ATTACK_DELAY_MS after the beat
  const { profile, r } = beatProfile(env, loop.beatTimes, 2, loop.beatTimes.length - 2);
  let pk = 0;
  for (let k = 0; k < profile.length; k++) if (profile[k] > profile[pk]) pk = k;
  assert.ok(Math.abs(pk - r - ATTACK_DELAY_MS) <= 3, `kick profile peaks ${pk - r} ms after the beat`);
  assert.equal(attackEnvelope(new Float32Array(FS), FS).reduce((a, b) => a + b, 0), 0);
});

test('onOff / edgeTrust: attacks on the beats → clear; the same audio on a grid half a beat or a sixteenth off → nothing', () => {
  const n = loop.beatTimes.length;
  const good = edgeTrust(env, loop.beatTimes, 4, 20);
  assert.ok(good.trust >= 0.75 && good.margin > 0.7, `true grid: ${JSON.stringify(good)}`);
  assert.ok(Math.abs(good.peakMs) <= 3);
  const off = edgeTrust(env, half, 4, 20);
  assert.equal(off.trust, 0, 'half a beat off');
  assert.ok(Math.abs(Math.abs(off.offAtMs) - 250) <= 12, `the attacks are found half a beat away: ${off.offAtMs} ms`);
  assert.equal(edgeTrust(env, sixteenth, 4, 20).trust, 0, 'a sixteenth off');
  assert.equal(edgeTrust(env, loop.beatTimes, 4, 8).trust, 0, 'four beats are not enough to say');
  assert.equal(edgeTrust(new Float32Array(env.length), loop.beatTimes, 0, n).trust, 0, 'silence');
  const m = onOff(env, loop.beatTimes, 0, n);
  assert.ok(m.on > 3 * m.off && m.count >= n - 2);
});

test('marginToTrust: 0 up to a tie, 0.5 at the calibrated gate, 1 for a beat that stands alone; monotonic', () => {
  assert.equal(marginToTrust(0.3), 0);
  assert.equal(marginToTrust(0.5), 0);
  assert.ok(Math.abs(marginToTrust(MARGIN_GATE) - 0.5) < 1e-9);
  assert.equal(marginToTrust(0.8), 1);
  assert.equal(marginToTrust(0.99), 1);
  assert.equal(marginToTrust(NaN), 0);
  let prev = -1;
  for (let m = 0.4; m <= 0.9; m += 0.01) {
    const t = marginToTrust(m);
    assert.ok(t >= prev && t >= 0 && t <= 1);
    prev = t;
  }
});

test('loud off-beat hi-hats: the kicks are still on the beats, but the grid is no longer something to blend on', () => {
  const hats = drumLoop({ bpm: 120, seconds: 24, offset: 0.2, hatAmp: 0.5, hatDecay: 0.06 });
  const e = attackEnvelope(hats.samples, FS);
  const m = edgeTrust(e, hats.beatTimes, 4, 20);
  assert.ok(m.trust < 0.5, `trust ${m.trust} (margin ${m.margin})`);
  assert.ok(m.trust < edgeTrust(env, loop.beatTimes, 4, 20).trust);
});

test('alignGrid: a grid tens of ms off the kicks is slid onto them; one that is right stays; no attacks → hands off', () => {
  const at = (list) => beatErrors(list, loop.beatTimes);
  for (const d of [-0.035, -0.02, 0.012, 0.03, 0.045]) {
    const moved = loop.beatTimes.map((t) => t + d);
    const r = alignGrid(env, moved, 0, 24);
    assert.ok(Math.abs(r.shift + d) < 0.004, `displaced ${d * 1000} ms: shift ${r.shift * 1000} ms`);
    assert.ok(at(r.beats).maxMs <= 4, `displaced ${d * 1000} ms: still ${at(r.beats).maxMs} ms off`);
    assert.ok(r.sharp > 3);
  }
  const same = alignGrid(env, loop.beatTimes, 0, 24);
  assert.ok(Math.abs(same.shift) < 0.004);
  // out of reach (a sixteenth away): not its job
  const far = alignGrid(env, sixteenth, 0, 24);
  assert.ok(Math.abs(far.shift) < 0.06);
  const pad = ambientPad(20);
  const flat = alignGrid(attackEnvelope(pad, FS), loop.beatTimes, 0, 20);
  assert.equal(flat.shift, 0);
  assert.deepEqual(alignGrid(env, loop.beatTimes.slice(0, 5), 0, 24).shift, 0, 'too few beats');
});

test('half-beat evidence: kick band and the rest must BOTH sit between the beats, consistently', () => {
  const low = lowBand(loop.samples, FS);
  const rest = Float32Array.from(loop.samples, (v, i) => v - low[i]);
  const kickEnv = attackEnvelope(low, FS);
  const restEnv = attackEnvelope(rest, FS);
  const right = halfBeatEvidence(kickEnv, restEnv, loop.beatTimes, 0, 24);
  assert.ok(right.segments >= 4 && right.kickOn > 1.5 * right.kickOff && right.restOn > 2 * right.restOff && right.agree === 0, JSON.stringify(right));
  assert.equal(isHalfBeatOff(right), false);
  const wrong = halfBeatEvidence(kickEnv, restEnv, half, 0, 24);
  assert.ok(wrong.kickOff > 1.5 * wrong.kickOn && wrong.restOff > 2 * wrong.restOn && wrong.agree === 1, JSON.stringify(wrong));
  assert.equal(isHalfBeatOff(wrong), true, 'a grid on the off-beat is recognised');
  // loud off-beat hats on a correct grid: the rest band points between the beats, the kick band does not
  const hats = drumLoop({ bpm: 120, seconds: 24, offset: 0.2, hatAmp: 0.9, hatDecay: 0.06, snare: false });
  const hl = lowBand(hats.samples, FS);
  const ev = halfBeatEvidence(attackEnvelope(hl, FS), attackEnvelope(Float32Array.from(hats.samples, (v, i) => v - hl[i]), FS), hats.beatTimes, 0, 24);
  assert.ok(ev.restOff > ev.restOn && ev.kickOn > ev.kickOff, JSON.stringify(ev));
  assert.equal(isHalfBeatOff(ev), false, 'syncopation is not a wrong grid');
  assert.equal(isHalfBeatOff(null), false);
  assert.equal(isHalfBeatOff({ ...wrong, segments: 2 }), false, 'two segments are not enough');
});

test('slotPattern: 16 slots per beat, slot 0 is the beat', () => {
  assert.equal(SLOTS_PER_BEAT, 16);
  const slots = slotPattern(env, loop.beatTimes);
  assert.ok(slots instanceof Uint8Array);
  assert.equal(slots.length, loop.beatTimes.length * 16);
  assert.equal(Math.max(...slots), 255);
  const n = loop.beatTimes.length;
  let onTop = 0;
  for (let i = 2; i < n - 2; i++) {
    const row = slots.subarray(i * 16, i * 16 + 16);
    const top = row.indexOf(Math.max(...row));
    assert.ok(top <= 1, `beat ${i}: strongest slot ${top}`); // (a long attack can spill into the next slot)
    if (top === 0) onTop++;
  }
  assert.ok(onTop >= 0.85 * (n - 4), `slot 0 strongest in ${onTop} of ${n - 4} beats`);
  // on a grid half a beat off the same attacks land in slot 8
  const shifted = slotPattern(env, half);
  let inEight = 0;
  for (let i = 2; i < n - 2; i++) {
    const row = shifted.subarray(i * 16, i * 16 + 16);
    if (row[8] === Math.max(...row)) inEight++;
  }
  assert.ok(inEight >= 0.85 * (n - 4));
  assert.equal(slotPattern(new Float32Array(1000), [0.1, 0.6]).reduce((a, b) => a + b, 0), 0);
  assert.equal(slotPattern(env, []).length, 0);
});

test('Analysis.grid: shape, and a clean four-on-the-floor loop is clear everywhere', () => {
  assert.ok(ANALYSIS_VERSION >= 2, 'cached analyses without grid trust must not be reused');
  assert.equal(GRID_EDGE_BEATS, 16);
  for (const bpm of [96, 124, 140]) {
    const l = drumLoop({ bpm, seconds: 30, offset: 0.15 });
    const a = analyzeTrack(l.samples, FS);
    assertValidAnalysis(a, 30, ANALYSIS_VERSION);
    assert.ok(a.grid.phase >= 0.75 && a.grid.head >= 0.75 && a.grid.tail >= 0.75, `${bpm} BPM: ${JSON.stringify({ ...a.grid, slots: undefined })}`);
    assert.equal(a.grid.perBeat, 16);
    assert.equal(a.grid.slots.length, a.beats.length * 16);
    // the fine alignment did not cost any accuracy against the true grid
    const e = beatErrors(a.beats, l.beatTimes);
    assert.ok(e.maxMs <= 6, `${bpm} BPM: beats ${e.maxMs.toFixed(1)} ms off`);
  }
});

test('opts.debug receives the grid stage\'s working notes (for tools; not part of the Analysis)', () => {
  const debug = {};
  const a = analyzeTrack(loop.samples, FS, { debug });
  assert.equal(debug.polish.flipped, false);
  assert.ok(Math.abs(debug.polish.shift) < 0.02 && debug.polish.sharp > 3, JSON.stringify(debug.polish));
  assert.ok(debug.grid.head.margin > MARGIN_GATE && debug.grid.tail.margin > MARGIN_GATE && debug.grid.steadiness === 1);
  assert.equal(a.debug, undefined);
  assert.deepEqual(analyzeTrack(loop.samples, FS).beats, a.beats, 'asking for the notes changes nothing');
});

test('Analysis.grid: a syncopated intro shows at the head only', () => {
  // ten seconds of nothing but loud off-beat hats, then the full kit: the tempo and the beats are found
  // from the kit, the tail is clear — the head is not a place to lay another track's drums on
  const full = drumLoop({ bpm: 120, seconds: 30, offset: 0.2 });
  const hats = drumLoop({ bpm: 120, seconds: 30, offset: 0.2, kick: false, snare: false, tonal: false, hatAmp: 0.5, hatDecay: 0.05 });
  const cut = Math.round(10.2 * FS);
  const x = Float32Array.from(full.samples, (v, i) => (i < cut ? hats.samples[i] : v));
  const a = analyzeTrack(x, FS);
  assertValidAnalysis(a, 30, ANALYSIS_VERSION);
  assert.ok(a.bpmConfidence >= 0.5 && Math.abs(a.bpm - 120) < 0.5);
  assert.ok(beatErrors(a.beats, full.beatTimes).maxMs <= 6);
  assert.ok(a.grid.head < 0.25, `head ${a.grid.head}`);
  assert.ok(a.grid.tail >= 0.75, `tail ${a.grid.tail}`);
  assert.ok(a.grid.phase < 0.5, `not clear all the way through: phase ${a.grid.phase}`);
  // and the slots say where the intro has its hits: half a beat after the beats
  const i = a.beats.findIndex((t) => t > 4);
  const row = a.grid.slots.subarray(i * 16, i * 16 + 16);
  assert.equal(row.indexOf(Math.max(...row)), 8);
});

test('Analysis.grid: nothing to say → all zero, never missing, never throwing', () => {
  const cases = {
    silence: new Float32Array(FS * 10),
    noise: noise(12, FS),
    pad: ambientPad(15),
    short: drumLoop({ bpm: 120, seconds: 2 }).samples,
    empty: new Float32Array(0),
  };
  for (const [name, x] of Object.entries(cases)) {
    const a = analyzeTrack(x, FS);
    const g = a.grid;
    assert.ok(g && g.slots instanceof Uint8Array && g.perBeat === 16, name);
    assert.equal(g.slots.length, a.beats.length * 16, `${name}: one row of slots per beat`);
    for (const k of ['phase', 'head', 'tail']) assert.ok(g[k] >= 0 && g[k] <= 1 && Number.isFinite(g[k]), `${name}.${k}`);
    if (a.bpmConfidence === 0) assert.deepEqual([g.phase, g.head, g.tail], [0, 0, 0], name);
  }
  assert.deepEqual(analyzeTrack(null, FS).grid.phase, 0);
});

test('bpmConfidence has a second witness: attacks that sit on the beats all the way through vouch for a sparse grid', () => {
  // A kick on every OTHER beat under steady noise (half-time pop, a ballad): only half the beats carry
  // an onset and the envelope is weakly periodic, so the tempo stage alone stays under 0.5 — the app
  // would refuse to beat-match a track whose beat anyone can hear.
  const kick = drumLoop({ bpm: 62, seconds: 30, snare: false, hats: false });
  const hiss = noise(30, FS, 0.3, 5);
  const sparse = Float32Array.from(kick.samples, (v, i) => v + 0.2 * hiss[i]);
  const dbg = {};
  const a = analyzeTrack(sparse, FS, { debug: dbg });
  assertValidAnalysis(a, 30, ANALYSIS_VERSION);
  assert.ok(Math.abs(a.bpm - 124) < 0.5, `tempo ${a.bpm}`);
  assert.ok(dbg.confidence.value < 0.5, `the tempo stage on its own: ${dbg.confidence.value}`);
  assert.ok(a.grid.phase >= 0.5, `phase ${a.grid.phase}`);
  assert.equal(a.bpmConfidence, a.grid.phase, 'lifted to what the attacks prove');
  // every kick really is on a beat of the grid it now vouches for
  const worst = Math.max(...kick.beatTimes.filter((t) => t > 1 && t < 29).map((t) => Math.min(...a.beats.map((x) => Math.abs(x - t)))));
  assert.ok(worst < 0.012, `kick to nearest beat: worst ${worst}`);
  // it only ever raises, and only on that proof
  const full = drumLoop({ bpm: 124, seconds: 20 });
  const d2 = {};
  const b = analyzeTrack(full.samples, FS, { debug: d2 });
  assert.equal(b.bpmConfidence, Math.max(d2.confidence.value, b.grid.phase >= 0.5 ? b.grid.phase : 0));
  // and audio without a beat is no nearer to being trusted than before
  const tones = ambientPad(20, FS);
  for (const [name, x] of [['pad', tones], ['noise', noise(20, FS, 0.3, 9)], ['pad + noise', Float32Array.from(tones, (v, i) => v + 0.1 * hiss[i])]]) {
    const c = analyzeTrack(x, FS);
    assert.ok(c.bpmConfidence < 0.2 && c.grid.phase < 0.2, `${name}: confidence ${c.bpmConfidence}, phase ${c.grid.phase}`);
  }
});

// ── calibration on real previews ───────────────────────────────────────────────────────────────

const crate = process.env.SEGUE_NO_FIXTURES ? null : loadCrate();
const skip = crate ? false : 'no audio fixtures (node tests/tools/fetch-fixtures.mjs)';

test('real previews: Analysis.grid and the planner gate against what the audio does', { skip }, () => {
  const c = calibrate(crate, { maxPairs: 250 });
  console.log(formatCalibration(c).replace(/^/gm, '    '));
  assert.ok(c.pairs.length >= 300, `${c.pairs.length} forced blends`);
  // the trust values order the blends: the clearer the worse of the two ends, the more often the drums meet
  const share = c.buckets.map((b) => b.tight / Math.max(1, b.n));
  for (let k = 1; k < share.length; k++) assert.ok(share[k] > share[k - 1], `bucket ${k}: ${share[k]} vs ${share[k - 1]}`);
  assert.ok(share[0] < 0.6 && share[share.length - 1] > 0.92, `lowest bucket ${share[0]}, highest ${share[share.length - 1]}`);
  // a clear edge is an aligned edge (measured value when this was written: 96 %)
  assert.ok(c.edges.high >= 50 && c.edges.highAligned / c.edges.high >= 0.88, `${c.edges.highAligned} of ${c.edges.high} clear edges aligned`);
  // … and what the planner lets through is within 20 ms far more often than what it holds back
  for (const [name, floor] of [['steady', 0.92], ['syncopated', 0.88], ['all', 0.9]]) {
    const g = c.gate[name];
    assert.ok(g.pass.n >= 40, `${name}: ${g.pass.n} pairs pass`);
    assert.ok(g.pass.tight / g.pass.n >= floor, `${name}: ${g.pass.tight} of ${g.pass.n} passed pairs within 20 ms`);
    assert.ok(g.hold.tight / Math.max(1, g.hold.n) < g.pass.tight / g.pass.n - 0.25, `${name}: the gate separates`);
  }
  // ungated, the same pairs are far worse: the gate is doing the work, not the crate
  assert.ok(c.all.tight / c.all.n < 0.8);
});

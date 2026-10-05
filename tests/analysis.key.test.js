import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack } from '../js/analysis/analyze.js';
import { camelotCode, keyName, detectKey, KEY_PROFILES, chromagram, globalChroma, harmonicChange } from '../js/analysis/key.js';
import { tonalPiece, drumLoop } from './helpers/analysis-synth.js';

const KEYS = [
  [0, 'major', 'C major', '8B'],
  [9, 'minor', 'A minor', '8A'],
  [7, 'major', 'G major', '9B'],
  [4, 'minor', 'E minor', '9A'],
  [6, 'major', 'F# major', '2B'],
  [10, 'minor', 'Bb minor', '3A'],
  [3, 'major', 'Eb major', '5B'],
  [1, 'minor', 'C# minor', '12A'],
  [11, 'major', 'B major', '1B'],
  [5, 'minor', 'F minor', '4A'],
];

for (const [pc, mode, name, camelot] of KEYS) {
  test(`chords + scale melody in ${name} → ${camelot}`, () => {
    const a = analyzeTrack(tonalPiece({ pc, mode }), 22050);
    assert.equal(a.key.pc, pc);
    assert.equal(a.key.mode, mode);
    assert.equal(a.key.name, name);
    assert.equal(a.key.camelot, camelot);
    assert.ok(a.key.confidence > 0.5, `confidence ${a.key.confidence}`);
  });
}

test('key survives a detuned recording (+35 and −40 cents)', () => {
  for (const cents of [35, -40]) {
    const a = analyzeTrack(tonalPiece({ pc: 2, mode: 'minor', tuneCents: cents }), 22050);
    assert.equal(a.key.name, 'D minor', `${cents} cents → ${a.key.name}`);
  }
  const { tuning } = chromagram(tonalPiece({ pc: 2, mode: 'minor', tuneCents: 35, seconds: 8 }), 22050);
  assert.ok(Math.abs(tuning - 0.35) < 0.06, `estimated tuning ${tuning} semitones`);
});

test('key is found under a drum loop and at other sample rates', () => {
  const sr = 44100;
  const tonal = tonalPiece({ pc: 7, mode: 'minor', sr, seconds: 20 });
  const drums = drumLoop({ bpm: 122, sr, seconds: 20, tonal: false }).samples;
  const mix = Float32Array.from(tonal, (v, i) => v + 0.8 * drums[i]);
  const a = analyzeTrack(mix, sr);
  assert.equal(a.key.name, 'G minor');
  assert.equal(a.key.camelot, '6A');
});

test('Camelot wheel: all 24 codes, relatives share a number, fifths are neighbours', () => {
  const seen = new Set();
  for (let pc = 0; pc < 12; pc++) {
    const maj = camelotCode(pc, 'major');
    const relMinor = camelotCode((pc + 9) % 12, 'minor');
    assert.equal(maj.slice(0, -1), relMinor.slice(0, -1), 'relative minor shares the number');
    assert.ok(maj.endsWith('B') && relMinor.endsWith('A'));
    const fifthUp = camelotCode((pc + 7) % 12, 'major');
    assert.equal((Number(maj.slice(0, -1)) % 12) + 1, Number(fifthUp.slice(0, -1)), 'a fifth up is +1 on the wheel');
    seen.add(maj);
    seen.add(camelotCode(pc, 'minor'));
  }
  assert.equal(seen.size, 24);
  assert.equal(camelotCode(0, 'major'), '8B');
  assert.equal(camelotCode(9, 'minor'), '8A');
  assert.equal(camelotCode(8, 'minor'), '1A');
  assert.equal(keyName(1, 'major'), 'Db major');
  assert.equal(keyName(1, 'minor'), 'C# minor');
});

test('detectKey: every profile set recognises its own templates; empty chroma → confidence 0', () => {
  for (const [name, prof] of Object.entries(KEY_PROFILES)) {
    for (const mode of ['major', 'minor']) {
      for (const pc of [0, 5, 10]) {
        const chroma = new Float64Array(12);
        for (let i = 0; i < 12; i++) chroma[(i + pc) % 12] = prof[mode][i];
        const k = detectKey(chroma, name);
        assert.equal(k.pc, pc, `${name} ${mode} ${pc}`);
        assert.equal(k.mode, mode);
      }
    }
  }
  const none = detectKey(new Float64Array(12));
  assert.equal(none.confidence, 0);
  assert.equal(none.camelot, '8B');
});

test('harmonic change peaks where the chord changes', () => {
  const loop = drumLoop({ bpm: 120, seconds: 20, offset: 0.1, downbeat: 0 });
  const ch = chromagram(loop.samples, loop.sr);
  const hc = harmonicChange(ch.chroma, ch.frames, ch.fps, loop.beatTimes);
  let onBar = 0;
  let other = 0;
  let nBar = 0;
  let nOther = 0;
  for (let i = 4; i < loop.beatTimes.length - 4; i++) {
    if (i % 4 === 0) {
      onBar += hc[i];
      nBar++;
    } else {
      other += hc[i];
      nOther++;
    }
  }
  assert.ok(onBar / nBar > 2 * (other / nOther), `bar lines ${onBar / nBar} vs other beats ${other / nOther}`);
  const g = globalChroma(ch.chroma, ch.frames);
  assert.equal(g.length, 12);
});

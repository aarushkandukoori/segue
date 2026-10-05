import test from 'node:test';
import assert from 'node:assert/strict';
import { camelot, camelotCompat, camelotRelation, keyCompat, parseCamelot, transposeCamelot, rateToSemitones } from '../js/dj/camelot.js';

// The published wheel, written out by hand (pc 0 = C … 11 = B).
const MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const ALL = [];
for (let n = 1; n <= 12; n++) ALL.push(`${n}A`, `${n}B`);

test('camelot(): all 24 keys match the wheel', () => {
  for (let pc = 0; pc < 12; pc++) {
    assert.equal(camelot(pc, 'major'), MAJOR[pc], `pc ${pc} major`);
    assert.equal(camelot(pc, 'minor'), MINOR[pc], `pc ${pc} minor`);
  }
  assert.equal(new Set([...MAJOR, ...MINOR]).size, 24);
  assert.equal(camelot(12, 'major'), '8B'); // wraps
  assert.equal(camelot(-3, 'minor'), '8A');
  // relative major/minor share a number
  for (let pc = 0; pc < 12; pc++) assert.equal(parseInt(camelot(pc, 'major'), 10), parseInt(camelot((pc + 9) % 12, 'minor'), 10));
});

test('parseCamelot', () => {
  assert.deepEqual(parseCamelot('8A'), { n: 8, letter: 'A' });
  assert.deepEqual(parseCamelot(' 12b '), { n: 12, letter: 'B' });
  for (const bad of ['0A', '13B', 'A8', '', null, undefined, '8C']) assert.equal(parseCamelot(bad), null);
});

test('camelotCompat: full 24 × 24 table', () => {
  const step = (code, d, flip) => {
    const { n, letter } = parseCamelot(code);
    const m = ((((n - 1 + d) % 12) + 12) % 12) + 1;
    return `${m}${flip ? (letter === 'A' ? 'B' : 'A') : letter}`;
  };
  for (const from of ALL) {
    const letter = from.slice(-1);
    const expected = new Map(ALL.map((k) => [k, { name: 'clash', score: 0.15 }]));
    expected.set(from, { name: 'same key', score: 1 });
    expected.set(step(from, 0, true), { name: 'relative', score: 0.9 });
    expected.set(step(from, 1, false), { name: 'adjacent', score: 0.85 });
    expected.set(step(from, -1, false), { name: 'adjacent', score: 0.85 });
    expected.set(step(from, 2, false), { name: 'whole tone up', score: 0.55 });
    expected.set(step(from, -2, false), { name: 'whole tone down', score: 0.45 });
    expected.set(step(from, 7, false), { name: 'semitone up', score: 0.5 });
    expected.set(step(from, -7, false), { name: 'semitone down', score: 0.3 });
    expected.set(step(from, 6, false), { name: 'tritone', score: 0.05 });
    expected.set(step(from, 6, true), { name: 'tritone', score: 0.05 });
    expected.set(step(from, letter === 'A' ? 1 : -1, true), { name: 'diagonal', score: 0.6 });
    expected.set(step(from, letter === 'A' ? 3 : -3, true), { name: 'parallel', score: 0.5 });
    for (const to of ALL) {
      const rel = camelotRelation(from, to);
      assert.deepEqual(rel, expected.get(to), `${from} → ${to}`);
      assert.equal(camelotCompat(from, to), rel.score);
      assert.ok(rel.score >= 0 && rel.score <= 1);
    }
  }
});

test('camelotCompat: musical spot checks', () => {
  // semitone up really is +7 on the wheel: C major (8B) → C# major (3B)
  assert.equal(camelotRelation(camelot(0, 'major'), camelot(1, 'major')).name, 'semitone up');
  assert.equal(camelotRelation(camelot(0, 'major'), camelot(2, 'major')).name, 'whole tone up');
  assert.equal(camelotRelation(camelot(9, 'minor'), camelot(9, 'major')).name, 'parallel'); // A minor ↔ A major
  assert.equal(camelotRelation(camelot(9, 'major'), camelot(9, 'minor')).name, 'parallel');
  assert.equal(camelotRelation(camelot(9, 'minor'), camelot(0, 'major')).name, 'relative'); // A minor ↔ C major
  assert.equal(camelotRelation(camelot(0, 'major'), camelot(7, 'major')).name, 'adjacent'); // C → G
  assert.equal(camelotRelation(camelot(0, 'major'), camelot(6, 'major')).name, 'tritone');
  // the smooth moves are symmetric
  for (const a of ALL) for (const b of ALL) if (camelotCompat(a, b) >= 0.6) assert.equal(camelotCompat(a, b), camelotCompat(b, a), `${a} ${b}`);
  assert.equal(camelotCompat('nonsense', '8A'), 0.5);
});

test('keyCompat: weighted by key confidence, robust to missing data', () => {
  const k = (pc, mode, confidence) => ({ pc, mode, camelot: camelot(pc, mode), confidence });
  assert.equal(keyCompat(k(0, 'major', 1), k(0, 'major', 1)), 1);
  assert.equal(keyCompat(k(0, 'major', 1), k(6, 'major', 1)), 0.05);
  assert.equal(keyCompat(k(0, 'major', 0), k(6, 'major', 1)), 0.5, 'no confidence → neutral');
  assert.ok(Math.abs(keyCompat(k(0, 'major', 0.5), k(0, 'major', 1)) - 0.75) < 1e-12);
  assert.ok(keyCompat(k(0, 'major', 0.9), k(7, 'major', 0.9)) > keyCompat(k(0, 'major', 0.9), k(1, 'major', 0.9)));
  assert.equal(keyCompat(null, k(0, 'major', 1)), 0.5);
  assert.equal(keyCompat(undefined, undefined), 0.5);
  assert.equal(keyCompat({}, {}), 0.5);
  // camelot string missing → derived from pc/mode
  assert.equal(keyCompat({ pc: 0, mode: 'major', confidence: 1 }, { pc: 9, mode: 'minor', confidence: 1 }), 0.9);
  for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
    const v = keyCompat(k(a, 'minor', 0.7), k(b, 'major', 0.3));
    assert.ok(v >= 0 && v <= 1);
  }
});

test('transposeCamelot: one semitone is seven steps round the wheel, letter kept', () => {
  for (let pc = 0; pc < 12; pc++) for (const mode of ['major', 'minor']) for (let n = -14; n <= 14; n++) {
    assert.equal(transposeCamelot(camelot(pc, mode), n), camelot(pc + n, mode), `${pc} ${mode} ${n}`);
  }
  assert.equal(transposeCamelot('8B', 1), '3B');
  assert.equal(transposeCamelot('8A', -1), '1A');
  assert.equal(transposeCamelot('8A', 0.4), '8A', 'rounds to whole semitones');
  assert.equal(transposeCamelot('nonsense', 1), null);
  assert.equal(transposeCamelot('8A', NaN), null);
});

test('rateToSemitones: speed is pitch (no key lock)', () => {
  assert.equal(rateToSemitones(1), 0);
  assert.ok(Math.abs(rateToSemitones(2) - 12) < 1e-12);
  assert.ok(Math.abs(rateToSemitones(2 ** (1 / 12)) - 1) < 1e-12);
  assert.ok(Math.abs(rateToSemitones(0.5) + 12) < 1e-12);
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.equal(rateToSemitones(bad), 0);
});

test('keyCompat with detune: keys are judged at the pitch actually heard', () => {
  const k = (pc, mode, confidence = 1) => ({ pc, mode, camelot: camelot(pc, mode), confidence });
  const C = k(0, 'major');
  // no detune, tiny detune (≤ 15 cents): the plain wheel
  assert.equal(keyCompat(C, k(7, 'major'), 0), keyCompat(C, k(7, 'major')));
  assert.equal(keyCompat(C, C, 0.1), 1);
  assert.equal(keyCompat(C, C, -0.15), 1);
  // a whole semitone: the second key moves round the wheel
  assert.equal(keyCompat(C, k(11, 'major'), 1), 1, 'B major played a semitone sharp is C major');
  assert.equal(keyCompat(C, k(1, 'major'), -1), 1);
  assert.equal(keyCompat(C, C, 1), keyCompat(C, k(1, 'major')), 'same key a semitone sharp = semitone clash');
  assert.equal(keyCompat(C, k(8, 'minor'), 1), keyCompat(C, k(9, 'minor')), 'G# minor +1 = A minor, the relative');
  // a quarter tone: out of tune whatever the keys are
  assert.equal(keyCompat(C, C, 0.5), 0.2);
  assert.equal(keyCompat(C, k(6, 'major'), -0.5), 0.2);
  // in between: monotonic from in tune to out of tune, symmetric around the semitone
  let prev = 1;
  for (let d = 0; d <= 0.5 + 1e-9; d += 0.05) {
    const v = keyCompat(C, C, d);
    assert.ok(v <= prev + 1e-12 && v >= 0.2 - 1e-12, `detune ${d}: ${v}`);
    assert.ok(Math.abs(v - keyCompat(C, C, -d)) < 1e-12);
    assert.ok(Math.abs(keyCompat(C, k(11, 'major'), 1 - d) - v) < 1e-9, 'same residue either side of a semitone');
    prev = v;
  }
  // still weighted by key confidence; garbage detune is ignored
  assert.equal(keyCompat(k(0, 'major', 0), C, 0.5), 0.5);
  assert.ok(Math.abs(keyCompat(k(0, 'major', 0.5), C, 0.5) - 0.35) < 1e-12);
  assert.equal(keyCompat(C, C, NaN), 1);
  assert.equal(keyCompat(C, C, Infinity), 1);
  assert.equal(keyCompat(null, C, 0.5), 0.5);
  for (let d = -2; d <= 2; d += 0.07) for (let b = 0; b < 12; b++) {
    const v = keyCompat(k(3, 'minor', 0.8), k(b, 'major', 0.6), d);
    assert.ok(v >= 0 && v <= 1 && Number.isFinite(v));
  }
});

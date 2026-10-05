import test from 'node:test';
import assert from 'node:assert/strict';
import { rateAt, positionAt, timeAtPosition, evalParam, sortEvents, dbToGain, gainToDb } from '../js/dj/timeline.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test('constant rate play', () => {
  const play = { startAt: 10, offset: 2, endAt: null, rate: [{ t: 10, v: 1.05 }] };
  near(rateAt(play, 5), 1.05);
  near(rateAt(play, 50), 1.05);
  near(positionAt(play, 10), 2);
  near(positionAt(play, 20), 2 + 10 * 1.05);
  near(positionAt(play, 8), 2 - 2 * 1.05); // virtual position before start
  near(timeAtPosition(play, 2 + 10 * 1.05), 20);
  near(timeAtPosition(play, 2 - 2 * 1.05), 8);
});

test('ramped rate: glide back to 1.0', () => {
  const play = {
    startAt: 0,
    offset: 1,
    endAt: null,
    rate: [
      { t: 0, v: 1.04 },
      { t: 8, v: 1.04 }, // anchor
      { t: 12, v: 1.0, ramp: true },
    ],
  };
  near(rateAt(play, 4), 1.04);
  near(rateAt(play, 10), 1.02);
  near(rateAt(play, 12), 1.0);
  near(rateAt(play, 99), 1.0);
  const pAt8 = 1 + 8 * 1.04;
  near(positionAt(play, 8), pAt8);
  near(positionAt(play, 10), pAt8 + ((1.04 + 1.02) / 2) * 2);
  near(positionAt(play, 12), pAt8 + ((1.04 + 1.0) / 2) * 4);
  near(positionAt(play, 20), pAt8 + 1.02 * 4 + 8);
  for (const t of [-3, 0, 0.5, 7.9, 8, 9.123, 11.99, 12, 15.5, 100]) {
    near(timeAtPosition(play, positionAt(play, t)), t, 1e-7);
  }
});

test('step change + brake to near zero', () => {
  const play = {
    startAt: 5,
    offset: 0,
    endAt: null,
    rate: [
      { t: 5, v: 1 },
      { t: 10, v: 0.5 }, // step
      { t: 20, v: 0.5 },
      { t: 21, v: 0.0001, ramp: true }, // brake
    ],
  };
  near(positionAt(play, 10), 5);
  near(positionAt(play, 12), 6);
  near(rateAt(play, 10), 0.5);
  near(rateAt(play, 9.999), 1);
  near(positionAt(play, 21), 10 + (0.5 + 0.0001) / 2, 1e-9);
  near(timeAtPosition(play, 6), 12);
  near(timeAtPosition(play, positionAt(play, 20.6)), 20.6, 1e-6);
  assert.equal(timeAtPosition(play, 1e6) > 1e6, true); // crawls at 0.0001 → effectively never
});

test('endAt freezes the position', () => {
  const play = { startAt: 0, offset: 0, endAt: 4, rate: [{ t: 0, v: 1 }] };
  near(positionAt(play, 3), 3);
  near(positionAt(play, 9), 4);
});

test('evalParam: set / lin / exp', () => {
  const ev = [
    { p: 'gain', t: 0, v: 0, k: 'set' },
    { p: 'lpf', t: 0, v: 200, k: 'set' },
    { p: 'gain', t: 4, v: 1, k: 'lin' },
    { p: 'lpf', t: 4, v: 20000, k: 'exp' },
    { p: 'gain', t: 10, v: 1, k: 'set' },
    { p: 'gain', t: 12, v: 0, k: 'lin' },
  ];
  near(evalParam(ev, 'gain', -1, 0.7), 0.7); // before first event → default
  near(evalParam(ev, 'gain', 0, 0.7), 0);
  near(evalParam(ev, 'gain', 1, 0.7), 0.25);
  near(evalParam(ev, 'gain', 4, 0.7), 1);
  near(evalParam(ev, 'gain', 7, 0.7), 1);
  near(evalParam(ev, 'gain', 11, 0.7), 0.5);
  near(evalParam(ev, 'gain', 99, 0.7), 0);
  near(evalParam(ev, 'lpf', 2, 20000), 2000, 1e-6); // geometric midpoint of 200 → 20000
  near(evalParam(ev, 'low', 2, -3), -3); // untouched param → default
});

test('evalParam: tgt decays toward target and is closed by a set', () => {
  const ev = [
    { p: 'gain', t: 0, v: 1, k: 'set' },
    { p: 'gain', t: 2, v: 0, k: 'tgt', tc: 0.5 },
    { p: 'gain', t: 4, v: 0.3, k: 'set' },
  ];
  near(evalParam(ev, 'gain', 1, 1), 1);
  near(evalParam(ev, 'gain', 2.5, 1), Math.exp(-1), 1e-12);
  near(evalParam(ev, 'gain', 3.999, 1), Math.exp(-1.999 / 0.5), 1e-9);
  near(evalParam(ev, 'gain', 4, 1), 0.3);
  near(evalParam(ev, 'gain', 9, 1), 0.3);
});

test('sortEvents is stable; db helpers round-trip', () => {
  const ev = [
    { p: 'a', t: 2, v: 1, k: 'set' },
    { p: 'b', t: 1, v: 1, k: 'set' },
    { p: 'c', t: 2, v: 2, k: 'set' },
  ];
  assert.deepEqual(
    sortEvents(ev).map((e) => e.p),
    ['b', 'a', 'c'],
  );
  near(dbToGain(-6.0206), 0.5, 1e-4);
  near(gainToDb(dbToGain(-13)), -13, 1e-9);
  assert.equal(gainToDb(0), -120);
});

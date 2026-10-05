import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, randomSeed } from '../js/util/rng.js';

test('rng: same seed → same stream; different seed → different stream', () => {
  const a = createRng('segue');
  const b = createRng('segue');
  const c = createRng('segue2');
  const sa = Array.from({ length: 200 }, () => a.next());
  const sb = Array.from({ length: 200 }, () => b.next());
  const sc = Array.from({ length: 200 }, () => c.next());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.deepEqual(createRng(42).shuffle([1, 2, 3, 4, 5, 6, 7, 8]), createRng('42').shuffle([1, 2, 3, 4, 5, 6, 7, 8]));
});

test('rng: next() is uniform in [0, 1)', () => {
  const r = createRng('dist');
  const N = 200000;
  const bins = new Array(20).fill(0);
  let sum = 0;
  let sumSq = 0;
  let lagged = 0;
  let prev = r.next();
  for (let i = 0; i < N; i++) {
    const x = r.next();
    assert.ok(x >= 0 && x < 1);
    bins[Math.floor(x * 20)]++;
    sum += x;
    sumSq += x * x;
    lagged += (x - 0.5) * (prev - 0.5);
    prev = x;
  }
  const mean = sum / N;
  assert.ok(Math.abs(mean - 0.5) < 0.005, `mean ${mean}`);
  assert.ok(Math.abs(sumSq / N - mean * mean - 1 / 12) < 0.002, 'variance');
  assert.ok(Math.abs(lagged / N / (1 / 12)) < 0.01, 'lag-1 correlation');
  // chi-square with 19 dof: 99.9th percentile ≈ 43.8
  const chi = bins.reduce((acc, n) => acc + (n - N / 20) ** 2 / (N / 20), 0);
  assert.ok(chi < 43.8, `chi-square ${chi}`);
});

test('rng: int / range / pick / weighted / shuffle', () => {
  const r = createRng('helpers');
  const counts = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) {
    const k = r.int(7);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 7);
    counts[k]++;
  }
  for (const n of counts) assert.ok(Math.abs(n - 10000) < 500, `int bucket ${n}`);
  assert.equal(r.int(0), 0);
  for (let i = 0; i < 1000; i++) {
    const x = r.range(-3, 5);
    assert.ok(x >= -3 && x < 5);
  }
  assert.ok(['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])));
  assert.equal(r.pick([]), undefined);

  const hits = { a: 0, b: 0, c: 0, z: 0 };
  for (let i = 0; i < 60000; i++) hits[r.weighted(['a', 'b', 'c', 'z'], [1, 2, 3, 0])]++;
  assert.equal(hits.z, 0, 'zero weight is never drawn');
  assert.ok(Math.abs(hits.a - 10000) < 500 && Math.abs(hits.b - 20000) < 700 && Math.abs(hits.c - 30000) < 800, JSON.stringify(hits));
  // degenerate weights fall back to a uniform pick instead of returning undefined
  assert.ok(['x', 'y'].includes(r.weighted(['x', 'y'], [0, 0])));
  assert.ok(['x', 'y'].includes(r.weighted(['x', 'y'], [NaN, -1])));

  const src = Array.from({ length: 50 }, (_, i) => i);
  const sh = r.shuffle(src);
  assert.deepEqual(src, Array.from({ length: 50 }, (_, i) => i), 'input untouched');
  assert.deepEqual([...sh].sort((x, y) => x - y), src, 'permutation');
  assert.notDeepEqual(sh, src);
  // every position gets every value about equally often
  const first = new Array(5).fill(0);
  for (let i = 0; i < 20000; i++) first[r.shuffle([0, 1, 2, 3, 4])[0]]++;
  for (const n of first) assert.ok(Math.abs(n - 4000) < 300, `shuffle bucket ${n}`);
});

test('rng: weighted() consumes exactly one number whatever the weights', () => {
  const a = createRng('w');
  const b = createRng('w');
  a.weighted([1, 2, 3], [5, 0, 1]);
  b.weighted([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 9]);
  assert.equal(a.next(), b.next());
});

test('rng: fork is independent of the parent and of call history', () => {
  const a = createRng('seed');
  const b = createRng('seed');
  for (let i = 0; i < 1000; i++) a.next(); // history must not matter
  const fa = a.fork('transition:7');
  const fb = b.fork('transition:7');
  assert.deepEqual(Array.from({ length: 50 }, () => fa.next()), Array.from({ length: 50 }, () => fb.next()));
  // different labels / parents → different streams, and uncorrelated with the parent
  const f1 = createRng('seed').fork('x');
  const f2 = createRng('seed').fork('y');
  const par = createRng('seed');
  const s1 = Array.from({ length: 5000 }, () => f1.next());
  const s2 = Array.from({ length: 5000 }, () => f2.next());
  const sp = Array.from({ length: 5000 }, () => par.next());
  const corr = (x, y) => x.reduce((acc, v, i) => acc + (v - 0.5) * (y[i] - 0.5), 0) / x.length / (1 / 12);
  assert.ok(Math.abs(corr(s1, s2)) < 0.05 && Math.abs(corr(s1, sp)) < 0.05 && Math.abs(corr(s2, sp)) < 0.05);
  // forking does not disturb the parent stream
  const p1 = createRng('p');
  const p2 = createRng('p');
  p1.fork('child').next();
  assert.equal(p1.next(), p2.next());
  // nested forks are stable and distinct from flat labels
  assert.equal(createRng('s').fork('a').fork('b').next(), createRng('s').fork('a').fork('b').next());
  assert.notEqual(createRng('s').fork('a').fork('b').next(), createRng('s').fork('b').fork('a').next());
});

test('randomSeed: 6 base36 chars, varies', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = randomSeed();
    assert.match(s, /^[0-9a-z]{6}$/);
    seen.add(s);
  }
  assert.ok(seen.size > 190);
});

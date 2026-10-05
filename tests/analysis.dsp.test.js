import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFFT,
  createRealFFT,
  createResampler,
  resample,
  autocorrelate,
  sanitize,
  hann,
  nextPow2,
  parabolicPeak,
  lerpAt,
  median,
  quantile,
  movingAverage,
  gaussianSmooth,
  biquad,
} from '../js/analysis/dsp.js';

function naiveDft(x) {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * k * i) / n;
      re[k] += x[i] * Math.cos(a);
      im[k] += x[i] * Math.sin(a);
    }
  }
  return { re, im };
}

const signal = (n) => Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.13 + 1) + ((i * 7919) % 13) / 13 - 0.5);

test('complex FFT matches a naive DFT and inverts exactly', () => {
  for (const n of [2, 8, 64, 256]) {
    const x = signal(n);
    const ref = naiveDft(x);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    const fft = createFFT(n);
    fft.forward(re, im);
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(re[k] - ref.re[k]) < 1e-8, `re[${k}] n=${n}`);
      assert.ok(Math.abs(im[k] - ref.im[k]) < 1e-8, `im[${k}] n=${n}`);
    }
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(re[i] - x[i]) < 1e-10);
      assert.ok(Math.abs(im[i]) < 1e-10);
    }
  }
  assert.throws(() => createFFT(12));
});

test('real FFT power spectrum matches the naive DFT (incl. DC and Nyquist)', () => {
  for (const n of [8, 64, 1024]) {
    const x = signal(n);
    const ref = naiveDft(x);
    const out = new Float64Array(n / 2 + 1);
    const before = Float64Array.from(x);
    createRealFFT(n).power(x, out);
    assert.deepEqual(x, before, 'input frame is not modified');
    for (let k = 0; k <= n / 2; k++) {
      const want = ref.re[k] * ref.re[k] + ref.im[k] * ref.im[k];
      assert.ok(Math.abs(out[k] - want) <= 1e-9 * (1 + want), `bin ${k} n=${n}: ${out[k]} vs ${want}`);
    }
  }
});

test('resampler: length, timing, pass-band gain and alias rejection', () => {
  for (const [srIn, srOut] of [
    [44100, 22050],
    [48000, 22050],
    [8000, 22050],
    [22050, 5512.5],
  ]) {
    const seconds = 0.5;
    const n = Math.round(srIn * seconds);
    const tone = (hz) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / srIn));
    const rms = (y) => {
      let s = 0;
      const a = Math.floor(y.length * 0.2);
      const b = Math.floor(y.length * 0.8);
      for (let i = a; i < b; i++) s += y[i] * y[i];
      return Math.sqrt(s / (b - a));
    };
    const nyq = Math.min(srIn, srOut) / 2;
    // a tone well inside the pass band survives with its exact phase (zero-phase kernel)
    const f = nyq * 0.3;
    const y = resample(tone(f), srIn, srOut);
    assert.ok(Math.abs(y.length - (n * srOut) / srIn) <= 1, `length ${srIn}→${srOut}`);
    let err = 0;
    for (let m = Math.floor(y.length * 0.2); m < Math.floor(y.length * 0.8); m++) {
      err = Math.max(err, Math.abs(y[m] - Math.sin((2 * Math.PI * f * m) / srOut)));
    }
    assert.ok(err < 0.01, `pass-band error ${err} for ${srIn}→${srOut}`);
    // a tone above the new Nyquist must be attenuated, not folded back
    if (srOut < srIn) {
      const alias = rms(resample(tone(nyq * 1.4), srIn, srOut));
      assert.ok(alias < 0.01, `alias leakage ${alias} for ${srIn}→${srOut}`);
    }
  }
  // DC gain is exactly 1, chunked processing equals one-shot processing
  const dc = new Float32Array(5000).fill(0.25);
  const rs = createResampler(48000, 22050);
  const whole = new Float32Array(rs.outLength(dc.length));
  rs.process(dc, whole, 0, whole.length);
  for (let i = 50; i < whole.length - 50; i++) assert.ok(Math.abs(whole[i] - 0.25) < 1e-5);
  const x = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i * 0.05) * Math.cos(i * 0.011));
  const a = new Float32Array(rs.outLength(x.length));
  const b = new Float32Array(a.length);
  rs.process(x, a, 0, a.length);
  for (let from = 0; from < b.length; from += 333) rs.process(x, b, from, Math.min(b.length, from + 333));
  assert.deepEqual(a, b);
  // identity
  assert.equal(resample(x, 22050, 22050), x);
});

test('autocorrelate equals the direct definition (unbiased)', () => {
  const x = signal(300);
  const acf = autocorrelate(x, 40);
  for (let l = 0; l <= 40; l++) {
    let s = 0;
    for (let i = 0; i + l < x.length; i++) s += x[i] * x[i + l];
    assert.ok(Math.abs(acf[l] - s / (x.length - l)) < 1e-9, `lag ${l}`);
  }
  assert.equal(autocorrelate(new Float64Array(0), 5).length, 6);
});

test('sanitize removes NaN / Infinity and clamps absurd values without copying clean data', () => {
  const clean = Float32Array.from([0, 0.5, -1, 1]);
  assert.equal(sanitize(clean), clean);
  const dirty = Float32Array.from([0.1, NaN, Infinity, -Infinity, 1e20, -1e20, 0.3]);
  const out = sanitize(dirty);
  assert.notEqual(out, dirty);
  assert.deepEqual(Array.from(out), [Math.fround(0.1), 0, 0, 0, 8, -8, Math.fround(0.3)]);
  assert.ok(Number.isNaN(dirty[1]), 'input untouched');
});

test('small helpers', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(1025), 2048);
  const w = hann(8);
  assert.ok(Math.abs(w[0]) < 1e-12 && Math.abs(w[4] - 1) < 1e-12);
  // parabola with its vertex at 2.3
  const p = Float64Array.from({ length: 5 }, (_, i) => -((i - 2.3) ** 2));
  assert.ok(Math.abs(parabolicPeak(p, 2) - 2.3) < 1e-9);
  assert.equal(parabolicPeak(p, 0), 0);
  assert.equal(lerpAt([0, 10, 20], 1.25), 12.5);
  assert.equal(lerpAt([0, 10, 20], -1), 0);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
  const flat = movingAverage(Float64Array.from([2, 2, 2, 2, 2]), 2);
  assert.deepEqual(Array.from(flat), [2, 2, 2, 2, 2]);
  const sm = gaussianSmooth(Float64Array.from([0, 0, 1, 0, 0]), 1);
  assert.ok(sm[2] > sm[1] && sm[1] > sm[0] && Math.abs(sm[1] - sm[3]) < 1e-12);
});

test('biquad low-pass / high-pass have the expected magnitude response', () => {
  const sr = 22050;
  const gainAt = (c, hz) => {
    // steady-state gain measured by filtering a sine
    let a = 0;
    let b = 0;
    let peak = 0;
    for (let i = 0; i < sr; i++) {
      const v = Math.sin((2 * Math.PI * hz * i) / sr);
      const y = c.b0 * v + a;
      a = c.b1 * v - c.a1 * y + b;
      b = c.b2 * v - c.a2 * y;
      if (i > sr / 2 && Math.abs(y) > peak) peak = Math.abs(y);
    }
    return peak;
  };
  const lp = biquad('lowpass', 200, sr);
  assert.ok(gainAt(lp, 50) > 0.95);
  assert.ok(Math.abs(gainAt(lp, 200) - Math.SQRT1_2) < 0.03);
  assert.ok(gainAt(lp, 2000) < 0.02);
  const hp = biquad('highpass', 2500, sr);
  assert.ok(gainAt(hp, 8000) > 0.95);
  assert.ok(gainAt(hp, 250) < 0.02);
});

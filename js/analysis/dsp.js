// Small, allocation-conscious DSP kit for the analysis pipeline: radix-2 FFT, real spectra,
// windowed-sinc resampling, autocorrelation, biquads and a few statistics helpers.
// Pure typed-array math — runs unchanged in Node, in a Worker and on the main thread.

/** Smallest power of two ≥ n (n ≥ 1). */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * In-place iterative radix-2 complex FFT of a fixed size. Tables are built once per size.
 * @param {number} n power of two ≥ 2
 * @returns {{n:number, forward(re:Float64Array, im:Float64Array):void, inverse(re:Float64Array, im:Float64Array):void}}
 */
export function createFFT(n) {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  function forward(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const h = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < h; k++, tw += step) {
          const a = start + k;
          const b = a + h;
          const wr = cos[tw];
          const wi = sin[tw];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
  function inverse(re, im) {
    // conj → forward → conj, scaled by 1/n
    for (let i = 0; i < n; i++) im[i] = -im[i];
    forward(re, im);
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= -s;
    }
  }
  return { n, forward, inverse };
}

/**
 * Power spectrum of real frames via a half-size complex FFT (≈ 2× cheaper than a full complex FFT).
 * `power(frame, out)` writes |X[k]|² for k = 0 … n/2 into `out` (length ≥ n/2 + 1). `frame` (length n,
 * already windowed) is not modified. No allocation per call.
 * @param {number} n power of two ≥ 4
 */
export function createRealFFT(n) {
  const h = n >> 1;
  const fft = createFFT(h);
  const zr = new Float64Array(h);
  const zi = new Float64Array(h);
  const cos = new Float64Array(h + 1);
  const sin = new Float64Array(h + 1);
  for (let k = 0; k <= h; k++) {
    const a = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }
  /** Shared core: leaves Z = FFT(x[2m] + i·x[2m+1]) in zr/zi. */
  function half(frame) {
    for (let m = 0; m < h; m++) {
      zr[m] = frame[2 * m];
      zi[m] = frame[2 * m + 1];
    }
    fft.forward(zr, zi);
  }
  function power(frame, out) {
    half(frame);
    for (let k = 0; k <= h; k++) {
      const a = k === h ? 0 : k;
      const b = k === 0 ? 0 : h - k;
      // E = (Z[k] + conj(Z[h−k])) / 2 ;  O = (Z[k] − conj(Z[h−k])) / (2i)
      const er = 0.5 * (zr[a] + zr[b]);
      const ei = 0.5 * (zi[a] - zi[b]);
      const or = 0.5 * (zi[a] + zi[b]);
      const oi = -0.5 * (zr[a] - zr[b]);
      const xr = er + cos[k] * or - sin[k] * oi;
      const xi = ei + cos[k] * oi + sin[k] * or;
      out[k] = xr * xr + xi * xi;
    }
  }
  return { n, bins: h + 1, power };
}

/** Periodic Hann window of length n. */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Copy of `x` with NaN / ±Infinity replaced by 0 and absurd magnitudes clamped, so that nothing
 * downstream can turn into NaN. Returns the same array when it is already clean (no copy).
 * @param {Float32Array} x
 */
export function sanitize(x) {
  const n = x.length;
  let i = 0;
  for (; i < n; i++) {
    const v = x[i];
    if (!(v >= -8 && v <= 8)) break; // also catches NaN
  }
  if (i === n) return x;
  const out = new Float32Array(x);
  for (; i < n; i++) {
    const v = out[i];
    if (v !== v || v === Infinity || v === -Infinity) out[i] = 0;
    else if (v > 8) out[i] = 8;
    else if (v < -8) out[i] = -8;
  }
  return out;
}

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Band-limited resampler (Kaiser-windowed sinc, polyphase table). Zero-phase: output sample m sits at
 * time m / srOut exactly. Built for analysis, not playback: ~60 dB stop-band, 8 zero crossings.
 * `process` fills out[from … to) so a long buffer can be converted in slices without blocking a thread.
 * @param {number} srIn
 * @param {number} srOut
 */
export function createResampler(srIn, srOut) {
  const ratio = srIn / srOut;
  const outLength = (nIn) => Math.max(0, Math.round(nIn / ratio)); // same duration, to the nearest sample
  if (Math.abs(ratio - 1) < 1e-9) {
    return {
      ratio: 1,
      outLength: (nIn) => nIn,
      process(input, out, from, to) {
        for (let m = from; m < to; m++) out[m] = input[m];
      },
    };
  }
  const ZEROS = 8;
  const PHASES = 256;
  const scale = Math.min(1, 1 / ratio) * 0.94; // cutoff as a fraction of the input Nyquist
  const halfW = Math.ceil(ZEROS / scale);
  const taps = 2 * halfW;
  const table = new Float32Array((PHASES + 1) * taps);
  const beta = 6.5;
  const i0beta = besselI0(beta);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = j - halfW + 1 - frac; // distance (input samples) from the output instant
      const u = d / halfW;
      let w = 0;
      if (u > -1 && u < 1) {
        const a = Math.PI * d * scale;
        const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(a) / a;
        w = sinc * (besselI0(beta * Math.sqrt(1 - u * u)) / i0beta);
      }
      table[p * taps + j] = w;
      sum += w;
    }
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum; // unity DC gain per phase
  }
  function process(input, out, from, to) {
    const n = input.length;
    for (let m = from; m < to; m++) {
      const pos = m * ratio;
      let i0 = Math.floor(pos);
      let p = Math.round((pos - i0) * PHASES);
      if (p === PHASES) {
        p = 0;
        i0++;
      }
      const base = p * taps;
      const first = i0 - halfW + 1;
      let acc = 0;
      if (first >= 0 && first + taps <= n) {
        for (let j = 0; j < taps; j++) acc += input[first + j] * table[base + j];
      } else {
        for (let j = 0; j < taps; j++) {
          const idx = first + j;
          if (idx >= 0 && idx < n) acc += input[idx] * table[base + j];
        }
      }
      out[m] = acc;
    }
  }
  return { ratio, outLength, process };
}

/**
 * One-shot resample.
 * @param {Float32Array} input
 * @param {number} srIn
 * @param {number} srOut
 * @returns {Float32Array}
 */
export function resample(input, srIn, srOut) {
  if (srIn === srOut) return input;
  const rs = createResampler(srIn, srOut);
  const out = new Float32Array(rs.outLength(input.length));
  rs.process(input, out, 0, out.length);
  return out;
}

/**
 * Autocorrelation r[0 … maxLag] of x (mean NOT removed — do it first if you want it), normalised by the
 * number of overlapping samples (unbiased) so long lags are not artificially damped.
 * @param {Float64Array|Float32Array} x
 * @param {number} maxLag
 * @returns {Float64Array} length maxLag + 1
 */
export function autocorrelate(x, maxLag) {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  if (n === 0) return out;
  const size = nextPow2(n + maxLag + 1);
  const fft = createFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i];
  fft.forward(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft.inverse(re, im);
  for (let l = 0; l <= maxLag; l++) out[l] = l < n ? re[l] / (n - l) : 0;
  return out;
}

/** Linear interpolation into an array at a fractional index (0 outside the array). */
export function lerpAt(arr, pos) {
  const i = Math.floor(pos);
  if (i < 0 || i >= arr.length - 1) {
    if (i === arr.length - 1 && pos === i) return arr[i];
    return 0;
  }
  const f = pos - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

/** Sub-sample peak position around index i by fitting a parabola through (i−1, i, i+1). Returns i + δ, |δ| ≤ 0.5. */
export function parabolicPeak(arr, i) {
  if (i <= 0 || i >= arr.length - 1) return i;
  const a = arr[i - 1];
  const b = arr[i];
  const c = arr[i + 1];
  const den = a - 2 * b + c;
  if (den >= 0) return i;
  return i + clamp((0.5 * (a - c)) / den, -0.5, 0.5);
}

/** Median of a numeric array (copy is sorted; fine for the small arrays we use it on). */
export function median(values) {
  const n = values.length;
  if (n === 0) return 0;
  const s = Float64Array.from(values).sort();
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** q-quantile (0..1) of a numeric array, linear interpolation. */
export function quantile(values, q) {
  const n = values.length;
  if (n === 0) return 0;
  const s = Float64Array.from(values).sort();
  const pos = clamp(q, 0, 1) * (n - 1);
  const i = Math.floor(pos);
  return i >= n - 1 ? s[n - 1] : s[i] + (s[i + 1] - s[i]) * (pos - i);
}

/**
 * Centered moving average with a window of 2·half + 1 samples (shrinks at the edges), O(n).
 * @param {Float64Array} x
 * @param {number} half
 * @param {Float64Array} [out]
 */
export function movingAverage(x, half, out = new Float64Array(x.length)) {
  const n = x.length;
  if (n === 0) return out;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = i - half < 0 ? 0 : i - half;
    const b = i + half + 1 > n ? n : i + half + 1;
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/**
 * Gaussian smoothing (truncated at 3σ, renormalised at the edges).
 * @param {Float64Array} x
 * @param {number} sigma in samples
 */
export function gaussianSmooth(x, sigma) {
  const n = x.length;
  const out = new Float64Array(n);
  if (!(sigma > 0.05)) {
    out.set(x);
    return out;
  }
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    const a = i - r < 0 ? 0 : i - r;
    const b = i + r >= n ? n - 1 : i + r;
    for (let j = a; j <= b; j++) {
      const w = k[j - i + r];
      acc += x[j] * w;
      wsum += w;
    }
    out[i] = acc / wsum;
  }
  return out;
}

/**
 * RBJ biquad coefficients, normalised (a0 = 1).
 * @param {'lowpass'|'highpass'} type
 * @param {number} freq Hz
 * @param {number} sr Hz
 * @param {number} [q]
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function biquad(type, freq, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * clamp(freq, 1, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

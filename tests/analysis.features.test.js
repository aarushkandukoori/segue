import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, ANALYSIS_VERSION } from '../js/analysis/analyze.js';
import { drumLoop, ambientPad, noise } from './helpers/analysis-synth.js';
import { assertValidAnalysis } from './helpers/analysis-assert.js';

const FS = 22050;
const sine = (hz, seconds, amp, sr = FS) => Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const db = (v) => 20 * Math.log10(v);

test('loudness: rms / peak of a steady sine, trim brings it to −16 dBFS', () => {
  for (const amp of [0.05, 0.2, 0.5, 0.9]) {
    const a = analyzeTrack(sine(440, 8, amp), FS);
    assert.ok(Math.abs(a.loudness.rms - amp / Math.SQRT2) < amp * 0.01, `rms ${a.loudness.rms}`);
    assert.ok(Math.abs(a.loudness.peak - amp) < amp * 0.01, `peak ${a.loudness.peak}`);
    const want = Math.min(6, Math.max(-12, -16 - db(amp / Math.SQRT2)));
    // a positive trim may not lift the peak above −1 dBFS
    const limited = want > 0 ? Math.max(0, Math.min(want, -1 - db(amp))) : want;
    assert.ok(Math.abs(a.loudness.trimDb - limited) < 0.1, `amp ${amp}: trim ${a.loudness.trimDb}, expected ${limited.toFixed(2)}`);
  }
});

test('loudness: trim is clamped to [−12, +6] and never pushes the peak above −1 dBFS', () => {
  const square = new Float32Array(FS * 6).map((_, i) => (Math.floor(i / 50) % 2 ? 1 : -1)); // 0 dBFS RMS
  assert.equal(analyzeTrack(square, FS).loudness.trimDb, -12);
  assert.equal(analyzeTrack(sine(300, 6, 0.01), FS).loudness.trimDb, 6);
  // quiet body (−30 dBFS) with full-scale clicks: wants +6 dB but has no headroom
  const peaky = sine(300, 6, 0.03);
  for (let i = 1000; i < peaky.length; i += 11025) peaky[i] = 0.98;
  const a = analyzeTrack(peaky, FS);
  assert.ok(a.loudness.peak > 0.9);
  assert.ok(a.loudness.trimDb <= Math.max(0, -1 - db(a.loudness.peak)) + 1e-9, `trim ${a.loudness.trimDb} with peak ${a.loudness.peak}`);
  // a known true peak (from the un-downmixed channels) is honoured
  const b = analyzeTrack(sine(300, 6, 0.05), FS, { peak: 0.95 });
  assert.ok(Math.abs(b.loudness.peak - 0.95) < 1e-6);
  assert.equal(b.loudness.trimDb, 0);
});

test('loudness is measured on the loud parts: a long quiet intro does not raise the trim', () => {
  const loud = drumLoop({ bpm: 120, seconds: 30 }).samples;
  const withIntro = Float32Array.from(loud);
  for (let i = 0; i < 12 * FS; i++) withIntro[i] *= 0.05; // 12 s at −26 dB
  const a = analyzeTrack(loud, FS).loudness;
  const b = analyzeTrack(withIntro, FS).loudness;
  assert.ok(Math.abs(a.trimDb - b.trimDb) < 0.6, `${a.trimDb} vs ${b.trimDb}`);
});

test('waveform: 100 columns per second, each band reacts to its own frequencies', () => {
  const seconds = 4;
  const n = seconds * FS;
  const x = new Float32Array(n);
  // second 0–1: 80 Hz, 1–2: 1 kHz, 2–3: 6 kHz, 3–4: silence
  x.set(sine(80, 1, 0.5), 0);
  x.set(sine(1000, 1, 0.5), FS);
  x.set(sine(6000, 1, 0.5), 2 * FS);
  const a = analyzeTrack(x, FS);
  const w = a.wave;
  assert.equal(w.perSec, 100);
  assert.equal(w.cols, 400);
  const mean = (arr, from, to) => arr.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
  // steady-state part of each second (skip filter transients at the joins)
  assert.ok(mean(w.low, 20, 90) > 200 && mean(w.mid, 20, 90) < 30 && mean(w.high, 20, 90) < 5, 'low band');
  assert.ok(mean(w.mid, 120, 190) > 200 && mean(w.low, 120, 190) < 30 && mean(w.high, 120, 190) < 60, 'mid band');
  assert.ok(mean(w.high, 220, 290) > 200 && mean(w.low, 220, 290) < 5 && mean(w.mid, 220, 290) < 60, 'high band');
  assert.ok(mean(w.low, 330, 400) < 2 && mean(w.mid, 330, 400) < 2 && mean(w.high, 330, 400) < 2, 'silence');
});

test('waveform: kicks show up as low-band peaks on the beats', () => {
  const loop = drumLoop({ bpm: 120, seconds: 10, offset: 0.2, snare: false, hats: false, tonal: false });
  const a = analyzeTrack(loop.samples, loop.sr);
  const w = a.wave;
  let on = 0;
  let off = 0;
  for (const t of loop.beatTimes.slice(1, -1)) {
    const c = Math.round(t * 100);
    on += Math.max(w.low[c], w.low[c + 1], w.low[c + 2]);
    off += w.low[c + 40];
  }
  assert.ok(on > 4 * off, `low band on the kicks ${on} vs between them ${off}`);
  assert.ok(Math.max(...w.low) > 100 && Math.max(...w.low) <= 255, `low-band peak ${Math.max(...w.low)}`);
});

test('cues: leading / trailing silence and fades are excluded from the usable region', () => {
  const body = drumLoop({ bpm: 120, seconds: 30 }).samples;
  // 2 s silence + music + 3 s silence
  const padded = new Float32Array(body.length + 5 * FS);
  padded.set(body, 2 * FS);
  const a = analyzeTrack(padded, FS);
  assertValidAnalysis(a, 35, ANALYSIS_VERSION);
  assert.ok(Math.abs(a.cues.start - 2.1) < 0.35, `start ${a.cues.start}`);
  assert.ok(Math.abs(a.cues.end - 32) < 0.35, `end ${a.cues.end}`);
  assert.ok(a.cues.in >= a.cues.start - 1e-3 && a.cues.in < a.cues.start + 2.1);

  // 3 s fade-in, 4 s fade-out
  const faded = Float32Array.from(body);
  for (let i = 0; i < 3 * FS; i++) faded[i] *= i / (3 * FS);
  for (let i = 0; i < 4 * FS; i++) faded[faded.length - 1 - i] *= i / (4 * FS);
  const b = analyzeTrack(faded, FS);
  assert.ok(b.cues.start > 0.8 && b.cues.start < 3.2, `fade-in: start ${b.cues.start}`);
  assert.ok(b.cues.end > 26 && b.cues.end < 29.4, `fade-out: end ${b.cues.end}`);

  // no fade: the whole clip is usable, even though the level bounces with the beat
  const c = analyzeTrack(body, FS);
  assert.equal(c.cues.start, 0);
  assert.equal(c.cues.end, c.duration);
});

test('energy: dense loud drums ≫ quiet pad; energy curve follows the level', () => {
  const drums = analyzeTrack(drumLoop({ bpm: 128, seconds: 20, hatAmp: 0.2 }).samples, FS);
  const pad = analyzeTrack(ambientPad(20), FS);
  assert.ok(drums.energy > pad.energy + 0.3, `drums ${drums.energy} vs pad ${pad.energy}`);
  assert.ok(pad.energy < 0.2);

  const loop = drumLoop({ bpm: 120, seconds: 20 }).samples;
  for (let i = 0; i < 10 * FS; i++) loop[i] *= 0.1; // first half 20 dB down
  const a = analyzeTrack(loop, FS);
  assert.equal(a.energyCurve.length, 20);
  assert.equal(Math.max(...a.energyCurve), 1);
  const first = a.energyCurve.slice(1, 9).reduce((s, v) => s + v, 0) / 8;
  const second = a.energyCurve.slice(11, 19).reduce((s, v) => s + v, 0) / 8;
  assert.ok(second > 0.85 && first < 0.45 && first > 0.15, `curve ${first} → ${second}`);
});

test('energy of noise is finite and mid-scale; silence is 0', () => {
  const a = analyzeTrack(noise(10), FS);
  assert.ok(a.energy > 0.1 && a.energy < 0.9);
  assert.equal(analyzeTrack(new Float32Array(FS * 5), FS).energy, 0);
});

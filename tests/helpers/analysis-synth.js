// Deterministic synthetic audio for the analysis tests: drum loops with a known grid, tonal material in a
// known key, noise. No randomness that is not seeded.

/** Small seeded PRNG (mulberry32) → () => [0, 1). */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function addKick(out, sr, t0, amp) {
  const start = Math.round(t0 * sr);
  const len = Math.round(0.28 * sr);
  let phase = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const t = i / sr;
    const f = 48 + 110 * Math.exp(-t / 0.03); // pitch sweep 158 → 48 Hz
    phase += (2 * Math.PI * f) / sr;
    // cosine start = instant attack (plus a 1 ms click), like a real kick transient
    const click = t < 0.001 ? 0.6 * (1 - t / 0.001) : 0;
    out[start + i] += amp * (Math.cos(phase) * Math.exp(-t / 0.09) + click);
  }
}

function addNoiseHit(out, sr, t0, amp, decay, rand, hp) {
  const start = Math.round(t0 * sr);
  const len = Math.round(decay * 6 * sr);
  let prev = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const t = i / sr;
    const white = rand() * 2 - 1;
    const v = hp ? white - prev : white; // crude first-order high-pass for hats
    prev = white;
    out[start + i] += amp * v * Math.exp(-t / decay);
  }
}

function addTone(out, sr, t0, dur, freq, amp, partials = 4) {
  const start = Math.round(t0 * sr);
  const len = Math.round(dur * sr);
  const fade = Math.round(0.012 * sr);
  for (let i = 0; i < len && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const t = i / sr;
    let v = 0;
    for (let k = 1; k <= partials; k++) {
      if (freq * k < sr * 0.45) v += Math.sin(2 * Math.PI * freq * k * t) / k;
    }
    const env = Math.min(1, i / fade, (len - i) / fade);
    out[start + i] += amp * v * env;
  }
}

/**
 * A simple but music-like loop: four-on-the-floor kick (accented on the "one"), snare on 2 and 4, off-beat
 * hats, and a bass + chord that change on every bar line.
 * @param {{bpm:number, seconds?:number, sr?:number, offset?:number, downbeat?:number, seed?:number,
 *          kick?:boolean, snare?:boolean, hats?:boolean, tonal?:boolean, lead?:number, gain?:number,
 *          hatAmp?:number, hatDecay?:number, beatTimes?:number[]}} o
 *   offset    — time of beat 0 in seconds
 *   downbeat  — index (0..3) of the first beat that starts a bar
 *   lead      — seconds of digital silence before anything plays (beats before it are not rendered)
 *   hatAmp / hatDecay — off-beat hi-hat level and decay (defaults 0.07 / 12 ms; 0.5 / 60 ms = loud open hat)
 *   beatTimes — explicit beat times (a drummer who speeds up and slows down) instead of bpm + offset
 * @returns {{samples:Float32Array, sr:number, beatTimes:number[], downbeat:number, bpm:number}}
 */
export function drumLoop(o) {
  const sr = o.sr || 22050;
  const seconds = o.seconds || 30;
  const offset = o.offset ?? 0.137;
  const downbeat = o.downbeat ?? 0;
  const lead = o.lead || 0;
  const rand = prng(o.seed || 7);
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const step = 60 / o.bpm;
  const beatTimes = [];
  // Am – F – C – G  (roots as MIDI notes), one chord per bar
  const roots = [45, 41, 48, 43];
  const thirds = [3, 4, 4, 4];
  const given = o.beatTimes;
  for (let i = 0; ; i++) {
    const t = given ? given[i] : offset + i * step;
    if (t === undefined || t >= seconds) break;
    beatTimes.push(t);
    if (t < lead) continue;
    const next = given && given[i + 1] !== undefined ? given[i + 1] : t + step;
    const inBar = (((i - downbeat) % 4) + 4) % 4;
    const bar = Math.floor((i - downbeat) / 4);
    if (o.kick !== false) addKick(out, sr, t, inBar === 0 ? 0.6 : 0.45);
    if (o.snare !== false && (inBar === 1 || inBar === 3)) addNoiseHit(out, sr, t, 0.22, 0.045, rand, false);
    if (o.hats !== false) addNoiseHit(out, sr, (t + next) / 2, o.hatAmp ?? 0.07, o.hatDecay ?? 0.012, rand, true);
    if (o.tonal !== false && inBar === 0) {
      const c = ((bar % 4) + 4) % 4;
      const root = roots[c];
      const len = Math.min(4 * (next - t), seconds - t);
      addTone(out, sr, t, len, midiHz(root - 12), 0.16, 3); // bass
      addTone(out, sr, t, len, midiHz(root + 12), 0.05, 4);
      addTone(out, sr, t, len, midiHz(root + 12 + thirds[c]), 0.05, 4);
      addTone(out, sr, t, len, midiHz(root + 19), 0.05, 4);
    }
  }
  const g = o.gain ?? 0.8;
  if (g !== 1) for (let i = 0; i < n; i++) out[i] *= g;
  return { samples: out, sr, beatTimes, downbeat, bpm: o.bpm };
}

/** Bare click track (2 ms clicks), for the purest timing check. */
export function clickTrack({ bpm, seconds = 20, sr = 22050, offset = 0.1 }) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const step = 60 / bpm;
  const beatTimes = [];
  const rand = prng(3);
  for (let i = 0; ; i++) {
    const t = offset + i * step;
    if (t >= seconds) break;
    beatTimes.push(t);
    const s = Math.round(t * sr);
    for (let k = 0; k < Math.round(0.002 * sr) && s + k < n; k++) out[s + k] += 0.7 * (rand() * 2 - 1);
  }
  return { samples: out, sr, beatTimes, bpm };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/**
 * Sustained diatonic triads plus a scale melody in a given key (no drums).
 * Progression: I–IV–V–I–vi–IV–V–I (major) or i–iv–v–i–VI–VII–v–i (natural minor).
 * @param {{pc:number, mode:'major'|'minor', seconds?:number, sr?:number, tuneCents?:number}} o
 * @returns {Float32Array}
 */
export function tonalPiece(o) {
  const sr = o.sr || 22050;
  const seconds = o.seconds || 24;
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const scale = o.mode === 'minor' ? MINOR : MAJOR;
  const tune = Math.pow(2, (o.tuneCents || 0) / 1200);
  const degrees = o.mode === 'minor' ? [0, 3, 4, 0, 5, 6, 4, 0] : [0, 3, 4, 0, 5, 3, 4, 0];
  const chordLen = seconds / degrees.length;
  const note = (deg, octave) => {
    const d = ((deg % 7) + 7) % 7;
    const up = Math.floor(deg / 7);
    return 48 + o.pc + scale[d] + 12 * (octave + up);
  };
  degrees.forEach((deg, c) => {
    const t = c * chordLen;
    addTone(out, sr, t, chordLen, midiHz(note(deg, -1)) * tune, 0.2, 4); // bass root
    addTone(out, sr, t, chordLen, midiHz(note(deg, 0)) * tune, 0.1, 5);
    addTone(out, sr, t, chordLen, midiHz(note(deg + 2, 0)) * tune, 0.1, 5);
    addTone(out, sr, t, chordLen, midiHz(note(deg + 4, 0)) * tune, 0.1, 5);
    // melody: four chord/scale tones per chord
    const mel = [deg + 7, deg + 9, deg + 11, deg + 8];
    mel.forEach((m, k) => addTone(out, sr, t + (k * chordLen) / 4, chordLen / 4, midiHz(note(m, 0)) * tune, 0.08, 3));
  });
  return out;
}

/** Seeded white noise. */
export function noise(seconds, sr = 22050, amp = 0.3, seed = 11) {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = amp * (rand() * 2 - 1);
  return out;
}

/** Slow pad chord with no onsets at all (rubato / ambient stand-in). */
export function ambientPad(seconds, sr = 22050) {
  const out = new Float32Array(Math.round(seconds * sr));
  const freqs = [110, 164.81, 220, 277.18, 329.63];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin(2 * Math.PI * freqs[k] * t + k) * (0.6 + 0.4 * Math.sin(2 * Math.PI * (0.05 + 0.013 * k) * t + k));
    out[i] = 0.08 * v * Math.min(1, t / 3, (seconds - t) / 3);
  }
  return out;
}

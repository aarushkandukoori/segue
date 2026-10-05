// Synthetic track data: a plausible 3-band waveform + beat grid in the exact shape of Analysis['wave'] /
// beats / cues. Used by the landing page's silent "attract mode" waveform and by ui-demo.html.
// No audio is involved anywhere in this file.

/** Small seeded PRNG (mulberry32) — deterministic so screenshots are stable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// kick, bass, mid, hats — how much of each layer a section carries
const SECTIONS = {
  intro: [0.85, 0.08, 0.22, 0.5],
  groove: [1, 0.62, 0.55, 0.7],
  lift: [1, 0.75, 0.72, 0.85],
  break: [0, 0.16, 0.8, 0.18],
  build: [0.55, 0.12, 0.7, 0.9],
  drop: [1, 1, 0.92, 1],
  outro: [0.9, 0.25, 0.28, 0.45],
};

const SHORT_FORMS = [
  ['groove', 'lift', 'break', 'drop', 'drop'],
  ['intro', 'groove', 'build', 'drop', 'drop'],
  ['lift', 'break', 'build', 'drop', 'groove'],
  ['groove', 'groove', 'break', 'drop', 'lift'],
];
const LONG_FORM = [
  'intro', 'intro', 'groove', 'lift', 'break', 'build', 'drop', 'drop',
  'groove', 'lift', 'break', 'build', 'drop', 'drop', 'outro', 'outro',
];

/**
 * @param {{seed?: number, bpm?: number, duration?: number, firstBeat?: number, club?: boolean}} [o]
 * @returns {{duration:number, bpm:number, beats:number[], downbeat:number,
 *   cues:{start:number, end:number, in:number, drop:number|null},
 *   wave:{cols:number, perSec:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array}}}
 */
export function makeTrack({ seed = 1, bpm = 124, duration = 30, firstBeat = 0.14, club = false } = {}) {
  const rnd = mulberry32(seed * 7919 + 13);
  const perSec = 100;
  const cols = Math.max(1, Math.round(duration * perSec));
  const low = new Uint8Array(cols);
  const mid = new Uint8Array(cols);
  const high = new Uint8Array(cols);
  const beatLen = 60 / bpm;

  const beats = [];
  for (let i = 0; firstBeat + i * beatLen < duration; i++) beats.push(firstBeat + i * beatLen);

  // Phrase plan: 4-bar phrases for preview-length clips, 8-bar phrases with a long arc otherwise.
  const long = duration > 75;
  const phraseBeats = long ? 32 : 16;
  const phrases = Math.ceil(beats.length / phraseBeats) + 1;
  const form = [];
  if (club) {
    // wall-to-wall dance floor: no intro, no breakdowns (used by the landing page's silent demo)
    const loop = ['groove', 'lift', 'drop', 'drop', 'lift', 'drop'];
    for (let i = 0; i < phrases; i++) form.push(loop[i % loop.length]);
  } else if (long) {
    const body = Math.max(1, phrases - 4);
    for (let i = 0; i < phrases; i++) {
      if (i < 2) form.push('intro');
      else if (i >= phrases - 2) form.push('outro');
      else form.push(LONG_FORM[2 + ((i - 2) % Math.min(body, 12))]);
    }
  } else {
    const pick = SHORT_FORMS[Math.floor(rnd() * SHORT_FORMS.length)];
    for (let i = 0; i < phrases; i++) form.push(pick[i % pick.length]);
  }

  // Slow random contour for pads / vocals, one control point every half second.
  const ctl = new Float32Array(Math.ceil(duration * 2) + 3);
  for (let i = 0; i < ctl.length; i++) ctl[i] = rnd();
  const swing = 0.3 + rnd() * 0.5;
  const hatBusy = rnd() > 0.5;
  const bassPhase = rnd() * Math.PI * 2;

  let drop = null;
  for (let c = 0; c < cols; c++) {
    const t = c / perSec;
    const bp = (t - firstBeat) / beatLen;
    if (bp < 0) {
      low[c] = 0;
      mid[c] = Math.round(18 * rnd());
      high[c] = Math.round(14 * rnd());
      continue;
    }
    const beat = Math.floor(bp);
    const fb = bp - beat;
    const inBar = beat % 4;
    const phrase = Math.min(form.length - 1, Math.floor(beat / phraseBeats));
    const kind = form[phrase];
    const S = SECTIONS[kind];
    if (kind === 'drop' && drop === null && beat % phraseBeats === 0) drop = firstBeat + beat * beatLen;
    // builds get denser towards their end
    const inPhrase = (beat % phraseBeats + fb) / phraseBeats;
    const rise = kind === 'build' ? inPhrase : 0;

    const kick = Math.exp(-fb * 5.5);
    const snare = inBar === 1 || inBar === 3 ? Math.exp(-fb * 11) : 0;
    const f8 = (bp * 2) % 1;
    const off = Math.floor(bp * 2) % 2 === 1;
    const f16 = (bp * 4) % 1;
    const hat = Math.exp(-f8 * 8) * (off ? 1 : 0.42) + (hatBusy ? Math.exp(-f16 * 13) * 0.3 : 0);
    const roll = rise > 0.5 ? Math.exp(-((bp * (rise > 0.8 ? 8 : 4)) % 1) * 9) * rise : 0;

    const ci = t * 2;
    const c0 = Math.floor(ci);
    const pad = ctl[c0] + (ctl[c0 + 1] - ctl[c0]) * (ci - c0);

    // off-beat bass notes and chord stabs give the body between the kicks
    const pump = 1 - 0.55 * kick;
    const bass = S[1] * (0.5 + 0.22 * Math.sin(bp * Math.PI * 0.5 + bassPhase)) * pump * (off ? 1 : 0.8);
    const stab = Math.exp(-f8 * 3.2) * (off ? 0.34 : 0.12);
    const lo = S[0] * kick * 0.97 + bass;
    const mi = S[2] * (0.3 + 0.42 * pad + stab) * (0.7 + 0.3 * pump) + snare * 0.46 * (S[0] > 0 ? 1 : 0.25) + kick * 0.16 * S[0] + roll * 0.4;
    const hi = S[3] * hat * (0.6 + swing * 0.3) * (1 + rise * 0.5) + S[2] * 0.12 * pad + snare * 0.34 + roll * 0.35;

    low[c] = Math.min(255, Math.round(255 * lo * (0.86 + 0.24 * rnd())));
    mid[c] = Math.min(255, Math.round(255 * mi * (0.78 + 0.4 * rnd())));
    high[c] = Math.min(255, Math.round(255 * hi * (0.7 + 0.5 * rnd())));
  }

  return {
    duration,
    bpm,
    beats,
    downbeat: 0,
    cues: { start: 0, end: Math.max(0, duration - 0.05), in: beats[0] ?? 0, drop },
    wave: { cols, perSec, low, mid, high },
  };
}

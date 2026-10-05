// Harmonic mixing helpers: Camelot wheel codes and a compatibility score between two keys.
// The wheel: numbers 1–12 step in fifths, letter B = major, A = minor; a major key and its relative
// minor share a number (C major = 8B, A minor = 8A).

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Camelot code of a key.
 * @param {number} pc 0 = C … 11 = B
 * @param {'major'|'minor'} mode
 * @returns {string} e.g. "8A"
 */
export function camelot(pc, mode) {
  const p = mod(Math.round(pc), 12);
  const major = mode !== 'minor';
  const root = major ? p : (p + 3) % 12; // a minor key sits on its relative major's number
  return `${((root * 7 + 7) % 12) + 1}${major ? 'B' : 'A'}`;
}

/** @returns {{n:number, letter:'A'|'B'}|null} */
export function parseCamelot(code) {
  const m = /^\s*(\d{1,2})\s*([ABab])\s*$/.exec(String(code ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, letter: /** @type {'A'|'B'} */ (m[2].toUpperCase()) };
}

/**
 * How the move from key `from` to key `to` sounds to a DJ. Direction matters a little: stepping up
 * (a semitone / a whole tone) lifts the energy and is more usable than stepping down.
 * @returns {{name:string, score:number}} score 0..1
 */
export function camelotRelation(from, to) {
  const a = parseCamelot(from);
  const b = parseCamelot(to);
  if (!a || !b) return { name: 'unknown', score: 0.5 };
  const d = mod(b.n - a.n, 12); // clockwise steps (fifths)
  const same = a.letter === b.letter;
  if (same) {
    if (d === 0) return { name: 'same key', score: 1 };
    if (d === 1 || d === 11) return { name: 'adjacent', score: 0.85 };
    if (d === 2) return { name: 'whole tone up', score: 0.55 };
    if (d === 10) return { name: 'whole tone down', score: 0.45 };
    if (d === 7) return { name: 'semitone up', score: 0.5 };
    if (d === 5) return { name: 'semitone down', score: 0.3 };
    if (d === 6) return { name: 'tritone', score: 0.05 };
    return { name: 'clash', score: 0.15 };
  }
  if (d === 0) return { name: 'relative', score: 0.9 };
  // Diagonal that shares six of seven notes: minor n → major n+1, major n → minor n−1.
  const diag = a.letter === 'A' ? d === 1 : d === 11;
  if (diag) return { name: 'diagonal', score: 0.6 };
  // Same tonic, other mode (A minor 8A ↔ A major 11B).
  const parallel = a.letter === 'A' ? d === 3 : d === 9;
  if (parallel) return { name: 'parallel', score: 0.5 };
  if (d === 6) return { name: 'tritone', score: 0.05 };
  return { name: 'clash', score: 0.15 };
}

/** Raw wheel compatibility of two Camelot codes, 0..1. */
export function camelotCompat(from, to) {
  return camelotRelation(from, to).score;
}

/**
 * Camelot code after transposing by whole semitones (one semitone = seven steps round the wheel).
 * @param {string} code
 * @param {number} semitones
 * @returns {string|null}
 */
export function transposeCamelot(code, semitones) {
  const k = parseCamelot(code);
  if (!k || !Number.isFinite(semitones)) return null;
  return `${mod(k.n - 1 + 7 * Math.round(semitones), 12) + 1}${k.letter}`;
}

const codeOf = (key) => {
  if (!key) return null;
  if (parseCamelot(key.camelot)) return key.camelot;
  if (Number.isFinite(key.pc)) return camelot(key.pc, key.mode);
  return null;
};

/** How far (semitones) two tracks may be detuned against each other before it starts to hurt. */
const IN_TUNE = 0.15;
/** Wheel score of two tracks a quarter tone apart: nothing lines up, whatever the keys say. */
const OUT_OF_TUNE = 0.2;

/**
 * Key compatibility of track `a` going into track `b`, 0..1, already weighted by how much the key
 * detection can be trusted: with zero confidence every pair scores a neutral 0.5.
 *
 * `detune` = pitch of `b` relative to `a` in semitones while they sound together. Decks have no key
 * lock — a track played 6 % fast is a semitone sharp — so a beat-matched pair is judged in the keys
 * actually heard: whole semitones move `b` round the wheel, and what is left over (up to a quarter
 * tone) pulls the score toward "out of tune".
 * @param {{pc?:number, mode?:string, camelot?:string, confidence?:number}} a
 * @param {{pc?:number, mode?:string, camelot?:string, confidence?:number}} b
 * @param {number} [detune] semitones, fractional; default 0
 */
export function keyCompat(a, b, detune = 0) {
  const ca = codeOf(a);
  let cb = codeOf(b);
  if (!ca || !cb) return 0.5;
  const conf = (k) => (Number.isFinite(k.confidence) ? Math.min(1, Math.max(0, k.confidence)) : 0.5);
  const trust = Math.min(conf(a), conf(b));
  let wheel;
  if (Number.isFinite(detune) && detune !== 0) {
    const whole = Math.round(detune);
    const off = Math.abs(detune - whole); // 0 … 0.5 semitone
    if (whole !== 0) cb = transposeCamelot(cb, whole);
    const tuned = Math.min(1, Math.max(0, 1 - (off - IN_TUNE) / (0.5 - IN_TUNE)));
    wheel = camelotCompat(ca, cb) * tuned + OUT_OF_TUNE * (1 - tuned);
  } else {
    wheel = camelotCompat(ca, cb);
  }
  return wheel * trust + 0.5 * (1 - trust);
}

/** Pitch change in semitones of a deck played at `rate` (no key lock: speed and pitch move together). */
export const rateToSemitones = (rate) => (rate > 0 && Number.isFinite(rate) ? 12 * Math.log2(rate) : 0);

// Seeded random numbers for the planner. Everything the DJ "decides" flows through here so that a
// seed reproduces a set exactly. No Math.random / Date anywhere except randomSeed().

/** xmur3: string → stream of well-mixed 32-bit integers (used only to seed the generator). */
function hasher(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/**
 * @typedef {Object} Rng
 * @property {string} seed
 * @property {() => number} next                 uniform in [0, 1)
 * @property {(n: number) => number} int         integer in [0, n)
 * @property {(a: number, b: number) => number} range   uniform in [a, b)
 * @property {<T>(arr: T[]) => T} pick
 * @property {<T>(items: T[], weights: number[]) => T} weighted   one draw, proportional to weight
 * @property {<T>(arr: T[]) => T[]} shuffle      Fisher–Yates on a copy
 * @property {(label: string|number) => Rng} fork   independent child stream
 */

/**
 * sfc32 generator seeded from a string. `fork(label)` derives the child from the *seed text*, not
 * from the current state, so a fork is the same no matter how many numbers were drawn before it —
 * that is what makes planner output independent of call history.
 * @param {number|string} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  const key = String(seed);
  const h = hasher(key);
  let a = h();
  let b = h();
  let c = h();
  let d = h();
  const next = () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // let the state mix before first use

  /** @type {Rng} */
  const rng = {
    seed: key,
    next,
    int: (n) => (n > 0 ? Math.floor(next() * n) : 0),
    range: (lo, hi) => lo + (hi - lo) * next(),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted(items, weights) {
      // Always consumes exactly one number so later draws do not depend on the weights.
      const u = next();
      let total = 0;
      for (let i = 0; i < items.length; i++) total += weights[i] > 0 ? weights[i] : 0;
      if (!(total > 0)) return items[Math.floor(u * items.length)];
      let acc = 0;
      let last = 0;
      for (let i = 0; i < items.length; i++) {
        const w = weights[i] > 0 ? weights[i] : 0;
        if (w === 0) continue;
        acc += w;
        last = i;
        if (u * total < acc) return items[i];
      }
      return items[last];
    },
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    fork: (label) => createRng(`${key}\u001f${label}`),
  };
  return rng;
}

/** A fresh 6-character base36 seed for "New set" (the only non-deterministic function here). */
export function randomSeed() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(6);
  const c = globalThis.crypto;
  let out = '';
  for (let i = 0; i < 6; i++) {
    let v;
    // Rejection sampling keeps the 36 symbols equally likely (252 = 7 * 36).
    do {
      if (c && c.getRandomValues) c.getRandomValues(bytes);
      else for (let k = 0; k < 6; k++) bytes[k] = Math.floor(Math.random() * 256);
      v = bytes[i];
    } while (v >= 252);
    out += alphabet[v % 36];
  }
  return out;
}

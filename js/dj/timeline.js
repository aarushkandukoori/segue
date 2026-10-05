// Pure time / rate / automation math shared by the planner, the engine and the UI.
// Everything here is in SET TIME: seconds since the set started (engine maps it onto AudioContext time).
// No DOM, no Web Audio — importable from Node tests and from a Worker.

const MIN_RATE = 1e-4;

/**
 * Playback rate of a play at set time t.
 * `play.rate` is a list of RatePoints {t, v, ramp?} sorted by t; rate[0].t === play.startAt.
 * A point with ramp=true is reached by a linear ramp from the previous point (linearRampToValueAtTime);
 * otherwise the rate steps to v at t (setValueAtTime).
 * @param {{rate: {t:number, v:number, ramp?:boolean}[]}} play
 * @param {number} t
 */
export function rateAt(play, t) {
  const pts = play.rate;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (t < b.t) {
      if (b.ramp && b.t > a.t) return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
      return a.v;
    }
  }
  return pts[pts.length - 1].v;
}

/**
 * Buffer position (seconds into the track) heard at set time t.
 * Before startAt it extrapolates backwards at the initial rate (a "virtual" position, handy for grid math).
 * After play.endAt (if set) the position freezes.
 * @param {{startAt:number, offset:number, endAt?:number|null, rate:{t:number,v:number,ramp?:boolean}[]}} play
 * @param {number} t
 */
export function positionAt(play, t) {
  const pts = play.rate;
  if (play.endAt != null && t > play.endAt) t = play.endAt;
  if (t <= play.startAt) return play.offset + (t - play.startAt) * pts[0].v;
  let pos = play.offset;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segEnd = b ? Math.min(b.t, t) : t;
    const dt = segEnd - a.t;
    if (dt > 0) {
      if (b && b.ramp && b.t > a.t) {
        const rEnd = a.v + ((b.v - a.v) * dt) / (b.t - a.t);
        pos += ((a.v + rEnd) / 2) * dt;
      } else {
        pos += a.v * dt;
      }
    }
    if (!b || b.t >= t) break;
  }
  return pos;
}

/**
 * Inverse of positionAt (ignores endAt): the set time at which buffer position `pos` is heard.
 * Positions before play.offset map to times before startAt (extrapolated at the initial rate).
 * @returns {number} set time, or Infinity if the position is never reached
 */
export function timeAtPosition(play, pos) {
  const pts = play.rate;
  if (pos <= play.offset) return play.startAt + (pos - play.offset) / Math.max(pts[0].v, MIN_RATE);
  let cur = play.offset;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!b) {
      if (a.v <= MIN_RATE) return Infinity;
      return a.t + (pos - cur) / a.v;
    }
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const ramp = !!b.ramp;
    const area = ramp ? ((a.v + b.v) / 2) * dt : a.v * dt;
    if (cur + area >= pos) {
      const need = pos - cur;
      if (!ramp || Math.abs(b.v - a.v) < 1e-12) {
        return a.v <= MIN_RATE ? b.t : a.t + need / a.v;
      }
      const k = (b.v - a.v) / dt; // rate slope
      // need = a.v*x + k*x^2/2  →  x = (-a.v + sqrt(a.v^2 + 2*k*need)) / k
      const disc = Math.max(0, a.v * a.v + 2 * k * need);
      return a.t + (-a.v + Math.sqrt(disc)) / k;
    }
    cur += area;
  }
  return Infinity;
}

/**
 * Value of automated param `p` at set time t, simulating AudioParam scheduling semantics for an
 * event list (see SPEC "Ev").  Rules the planner must follow so every browser agrees with this model:
 *   - every 'lin' / 'exp' ramp is preceded by an anchoring event on the same param;
 *   - 'exp' ramps never touch 0 (use ≥ 1e-4);
 *   - a 'tgt' is followed (if by anything) by a 'set'.
 * @param {{p:string,t:number,v:number,k:'set'|'lin'|'exp'|'tgt',tc?:number}[]} events
 * @param {string} p
 * @param {number} t
 * @param {number} def default value of the param
 */
export function evalParam(events, p, t, def) {
  let lastT = -Infinity;
  let lastV = def;
  /** @type {null | {t:number, v:number, tc:number, from:number}} */
  let tgt = null;
  const settle = (at) => {
    if (tgt) {
      lastV = tgt.v + (tgt.from - tgt.v) * Math.exp(-(at - tgt.t) / tgt.tc);
      lastT = at;
      tgt = null;
    }
  };
  // Events are expected sorted by t; a stable pass over the matching ones is enough.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.p !== p) continue;
    if (e.k === 'set') {
      if (t < e.t) break;
      settle(e.t);
      lastT = e.t;
      lastV = e.v;
    } else if (e.k === 'lin' || e.k === 'exp') {
      settle(Math.min(e.t, t));
      if (t < e.t) {
        if (tgt) break;
        if (lastT === -Infinity || e.t <= lastT) return lastV;
        const f = (t - lastT) / (e.t - lastT);
        if (f <= 0) return lastV;
        if (e.k === 'exp' && lastV > 0 && e.v > 0) return lastV * Math.pow(e.v / lastV, f);
        return lastV + (e.v - lastV) * f;
      }
      lastT = e.t;
      lastV = e.v;
    } else if (e.k === 'tgt') {
      if (t < e.t) break;
      settle(e.t);
      tgt = { t: e.t, v: e.v, tc: Math.max(e.tc || 0.001, 1e-4), from: lastV };
      lastT = e.t;
    }
  }
  if (tgt) return tgt.v + (tgt.from - tgt.v) * Math.exp(-(Math.max(t, tgt.t) - tgt.t) / tgt.tc);
  return lastV;
}

/** Stable sort of automation events by time (planner output must already be sorted; engine re-sorts defensively). */
export function sortEvents(events) {
  return events
    .map((e, i) => [e, i])
    .sort((x, y) => x[0].t - y[0].t || x[1] - y[1])
    .map((x) => x[0]);
}

/** dB → linear gain. */
export const dbToGain = (db) => Math.pow(10, db / 20);
/** linear gain → dB (floored at −120). */
export const gainToDb = (g) => (g > 1e-6 ? 20 * Math.log10(g) : -120);

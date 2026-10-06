// Timers that keep their pace in a background tab.
//
// The full-song set is driven by a 20 Hz ticker (volume lanes, the incoming deck's play() at its start,
// the end of each hand-over) and the decks poll their players. With the page's own setTimeout /
// setInterval, Chrome throttles all of that in a hidden tab — to once a second, and after a few minutes
// of a silent tab to ONCE A MINUTE (measured 2026-10-06 with real background throttling: hand-overs up to
// a minute late, the freed deck cueing its next song only at the next wake-up). Timers of a dedicated
// worker are not throttled (0 gaps in 300 s, same run), so these timers run there and fire here as a
// message. Where no worker can be started (no Worker, a blocked script, a worker that fails later) they
// fall back to the page's own timers, re-arming whatever was pending.
//
//   const timers = createTimers();
//   const id = timers.setInterval(fn, 50); … timers.clearInterval(id);
//   timers.setTimeout(fn, ms) / timers.clearTimeout(id)    same shape as the window's
//   timers.worker                                           true while the worker is the clock

/**
 * @typedef {{
 *   setTimeout: (fn: () => void, ms?: number) => number,
 *   clearTimeout: (id: number|null|undefined) => void,
 *   setInterval: (fn: () => void, ms?: number) => number,
 *   clearInterval: (id: number|null|undefined) => void,
 *   readonly worker: boolean,
 * }} Timers
 */

/**
 * @param {{url?: string|URL, Worker?: any}} [opts]  url of timer-worker.js (default: next to this module)
 * @returns {Timers}
 */
export function createTimers(opts = {}) {
  const W = opts.Worker !== undefined ? opts.Worker : typeof Worker !== 'undefined' ? Worker : null;
  /** @type {Map<number, {fn: () => void, ms: number, repeat: boolean, due: number, native: any}>} */
  const live = new Map();
  let nextId = 1;
  /** @type {any} */
  let worker = null;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function fire(id) {
    const t = live.get(id);
    if (!t) return;
    if (t.repeat) t.due = now() + t.ms;
    else live.delete(id);
    try {
      t.fn();
    } catch (err) {
      setTimeout(() => {
        throw err; // reported like an error in a plain timer, without stopping this clock
      });
    }
  }

  function armNative(id, t, ms) {
    t.native = t.repeat ? setInterval(() => fire(id), t.ms) : setTimeout(() => fire(id), ms);
  }

  /** The worker is gone (failed to load, or later): every pending timer goes on the page's own timers. */
  function fallBack() {
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      /* already gone */
    }
    worker = null;
    const t0 = now();
    for (const [id, t] of live) armNative(id, t, Math.max(0, t.due - t0));
  }

  if (W) {
    try {
      worker = new W(opts.url || new URL('./timer-worker.js', import.meta.url));
      worker.onmessage = (/** @type {MessageEvent} */ e) => fire(Number(e.data));
      worker.onerror = () => fallBack();
      worker.onmessageerror = () => fallBack();
    } catch {
      worker = null; // CSP, an old browser: the page's own timers
    }
  }

  function add(fn, ms, repeat) {
    if (typeof fn !== 'function') return 0;
    const id = nextId++;
    const wait = Math.max(0, Number(ms) || 0);
    const t = { fn, ms: wait, repeat, due: now() + wait, native: null };
    live.set(id, t);
    if (worker) {
      try {
        worker.postMessage({ op: repeat ? 'interval' : 'timeout', id, ms: wait });
        return id;
      } catch {
        fallBack();
        return id;
      }
    }
    armNative(id, t, wait);
    return id;
  }

  function clear(id) {
    const t = typeof id === 'number' ? live.get(id) : undefined;
    if (!t) return;
    live.delete(id);
    if (t.native !== null) {
      clearTimeout(t.native);
      clearInterval(t.native);
    }
    if (worker) {
      try {
        worker.postMessage({ op: 'clear', id });
      } catch {
        /* the worker is going away; its message will find nothing */
      }
    }
  }

  return {
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: clear,
    get worker() {
      return !!worker;
    },
  };
}

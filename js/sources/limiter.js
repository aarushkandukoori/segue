// Client-side rate limiting. Both public APIs we lean on have per-IP quotas (Deezer 50 req / 5 s,
// iTunes Search ≈ 20 req / min) and punish bursts with errors, so every request goes through one of
// these. Clock and timers are injectable so the logic is testable with fake time.

import { SourceError, abortError } from './util.js';

/**
 * Sliding-window limiter: at most `max` starts within any `windowMs`, at most `concurrency` running,
 * and at least `minGapMs` between consecutive starts. FIFO. Aborted waiters leave the queue without
 * consuming a slot.
 *
 * @param {{max: number, windowMs: number, concurrency?: number, minGapMs?: number,
 *          now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void}} cfg
 */
export function createLimiter(cfg) {
  const { max, windowMs, concurrency = Infinity, minGapMs = 0 } = cfg;
  const now = cfg.now || (() => Date.now());
  const setTimer = cfg.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = cfg.clearTimer || ((id) => clearTimeout(id));

  /** @type {number[]} start times inside the current window, ascending */
  const starts = [];
  /** @type {{run: () => void, cancelled: boolean}[]} */
  const queue = [];
  let running = 0;
  let timer = null;
  let pausedUntil = 0;

  function waitMs() {
    const t = now();
    while (starts.length && t - starts[0] >= windowMs) starts.shift();
    let wait = 0;
    if (starts.length >= max) wait = Math.max(wait, starts[starts.length - max] + windowMs - t);
    if (minGapMs && starts.length) wait = Math.max(wait, starts[starts.length - 1] + minGapMs - t);
    if (pausedUntil > t) wait = Math.max(wait, pausedUntil - t);
    return wait;
  }

  /**
   * Earliest the next newly queued task could start, in ms from now, given what is already queued.
   * Ignores how long running tasks take, so it is a lower bound.
   */
  function earliestStart() {
    const t = now();
    const sim = starts.filter((s) => t - s < windowMs);
    let at = t;
    const ahead = queue.filter((q) => !q.cancelled).length;
    for (let i = 0; i <= ahead; i++) {
      let w = Math.max(at, pausedUntil);
      if (sim.length >= max) w = Math.max(w, sim[sim.length - max] + windowMs);
      if (minGapMs && sim.length) w = Math.max(w, sim[sim.length - 1] + minGapMs);
      sim.push(w);
      at = w;
    }
    return at - t;
  }

  function pump() {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    while (queue.length) {
      if (queue[0].cancelled) {
        queue.shift();
        continue;
      }
      if (running >= concurrency) return; // a finishing task pumps again
      const wait = waitMs();
      if (wait > 0) {
        timer = setTimer(() => {
          timer = null;
          pump();
        }, wait);
        return;
      }
      const item = queue.shift();
      starts.push(now());
      running++;
      item.run();
    }
  }

  /**
   * Run `task` when the quota allows it.
   * `maxWaitMs`: give up (reject with a 'busy' SourceError) if the task has not STARTED by then —
   * for callers who would rather skip an optional lookup than sit in a long queue. When the queue
   * already makes that impossible the rejection is immediate.
   * @template T
   * @param {() => Promise<T>} task
   * @param {{signal?: AbortSignal, maxWaitMs?: number}} [opts]
   * @returns {Promise<T>}
   */
  function schedule(task, opts = {}) {
    const { signal, maxWaitMs } = opts;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const bounded = maxWaitMs != null && Number.isFinite(maxWaitMs);
      // No point queueing for a turn that cannot come in time: say so now, not after the wait.
      if (bounded && earliestStart() > maxWaitMs) return reject(new SourceError('busy', 'Too many requests are already waiting.'));
      let waitTimer = null;
      const item = {
        cancelled: false,
        run: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (waitTimer != null) clearTimer(waitTimer);
          let p;
          try {
            p = Promise.resolve(task());
          } catch (err) {
            p = Promise.reject(err);
          }
          p.then(resolve, reject).finally(() => {
            running--;
            pump();
          });
        },
      };
      const onAbort = () => {
        item.cancelled = true;
        if (waitTimer != null) clearTimer(waitTimer);
        reject(abortError());
        pump();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (bounded) {
        waitTimer = setTimer(() => {
          item.cancelled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new SourceError('busy', 'Too many requests are already waiting.'));
          pump();
        }, maxWaitMs);
      }
      queue.push(item);
      pump();
    });
  }

  return {
    schedule,
    /** Hold all new starts for `ms` (the server told us to back off). */
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms);
      pump();
    },
    /** Queued (not yet started) tasks. */
    get pending() {
      return queue.filter((q) => !q.cancelled).length;
    },
    get running() {
      return running;
    },
  };
}

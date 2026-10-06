// js/util/timers.js: the worker clock behind the full-song set (Chrome does not throttle a dedicated
// worker's timers in a background tab). A fake Worker stands in: what the page sends it, what it fires,
// and the fallback to the page's own timers when the worker cannot start or fails later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimers } from '../js/util/timers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Worker that records messages; `fire(id)` plays the worker's timer going off. */
function fakeWorkerClass(log) {
  return class FakeWorker {
    constructor(url) {
      this.url = String(url);
      this.sent = [];
      this.terminated = false;
      log.push(this);
    }
    postMessage(m) {
      if (this.terminated) throw new Error('terminated');
      this.sent.push(m);
    }
    terminate() {
      this.terminated = true;
    }
    fire(id) {
      this.onmessage({ data: id });
    }
  };
}

test('timers: intervals and timeouts run on the worker and fire here as its messages', () => {
  const made = [];
  const t = createTimers({ Worker: fakeWorkerClass(made) });
  assert.equal(made.length, 1);
  assert.equal(t.worker, true);
  assert.match(made[0].url, /timer-worker\.js$/, 'the worker script next to the module');
  const w = made[0];
  let ticks = 0;
  let once = 0;
  const iv = t.setInterval(() => ticks++, 50);
  const to = t.setTimeout(() => once++, 300);
  assert.deepEqual(w.sent, [
    { op: 'interval', id: iv, ms: 50 },
    { op: 'timeout', id: to, ms: 300 },
  ]);
  w.fire(iv);
  w.fire(iv);
  w.fire(to);
  w.fire(to); // a late duplicate: the timeout is already done
  assert.equal(ticks, 2);
  assert.equal(once, 1);
  t.clearInterval(iv);
  assert.deepEqual(w.sent[w.sent.length - 1], { op: 'clear', id: iv });
  w.fire(iv); // a message already on its way when it was cleared
  assert.equal(ticks, 2, 'nothing fires after clearInterval');
  t.clearTimeout(12345); // unknown ids are ignored
  t.clearInterval(undefined);
});

test('timers: a callback that throws does not stop the clock', () => {
  const made = [];
  const t = createTimers({ Worker: fakeWorkerClass(made) });
  let n = 0;
  const iv = t.setInterval(() => {
    n++;
    if (n === 1) throw new Error('boom');
  }, 50);
  // the error is re-thrown from a plain page timer (reported like any timer error): capture that timer
  const rethrows = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => rethrows.push(fn);
  try {
    made[0].fire(iv);
    made[0].fire(iv);
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(n, 2, 'the next firing still runs');
  assert.equal(rethrows.length, 1);
  assert.throws(rethrows[0], /boom/, 'and the error is reported, not swallowed');
  t.clearInterval(iv);
});

test('timers: no Worker, or a constructor that throws (CSP) → the page’s own timers', async () => {
  for (const W of [null, class { constructor() { throw new Error('blocked by CSP'); } }]) {
    const t = createTimers({ Worker: W });
    assert.equal(t.worker, false);
    let ticks = 0;
    let once = 0;
    const iv = t.setInterval(() => ticks++, 5);
    t.setTimeout(() => once++, 5);
    await sleep(60);
    t.clearInterval(iv);
    const at = ticks;
    await sleep(30);
    assert.ok(at >= 3, `interval ran on window timers (${at})`);
    assert.equal(ticks, at, 'and stops when cleared');
    assert.equal(once, 1);
  }
});

test('timers: a worker that fails after starting hands every pending timer to the page’s own timers', async () => {
  const made = [];
  const t = createTimers({ Worker: fakeWorkerClass(made) });
  let ticks = 0;
  let once = 0;
  const iv = t.setInterval(() => ticks++, 5);
  t.setTimeout(() => once++, 20);
  made[0].onerror(new Event('error'));
  assert.equal(made[0].terminated, true);
  assert.equal(t.worker, false);
  await sleep(80);
  assert.ok(ticks >= 3, `the interval goes on (${ticks})`);
  assert.equal(once, 1, 'the pending timeout still fires once');
  t.clearInterval(iv);
  const at = ticks;
  await sleep(30);
  assert.equal(ticks, at);
  // new timers after the failure use the page's timers too
  let later = 0;
  t.setTimeout(() => later++, 5);
  await sleep(30);
  assert.equal(later, 1);
});

// Rate limiting with a fake clock: no real time passes in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../js/sources/limiter.js';
import { createItunes, mapItunesResult } from '../js/sources/itunes.js';
import { SourceError } from '../js/sources/util.js';

const flush = () => new Promise((r) => setImmediate(r));

/** Deterministic clock + timers. advance() fires due timers in order, letting promises settle in between. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    get pendingTimers() {
      return timers.size;
    },
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const tm of timers.values()) if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id))) next = tm;
        if (!next) break;
        t = next.at;
        timers.delete(next.id);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

/** Largest number of starts inside any half-open window of `windowMs`. */
function maxInWindow(starts, windowMs) {
  let worst = 0;
  for (let i = 0; i < starts.length; i++) {
    let n = 0;
    for (let j = i; j < starts.length && starts[j] - starts[i] < windowMs; j++) n++;
    worst = Math.max(worst, n);
  }
  return worst;
}

const isAbortError = (err) => err && err.name === 'AbortError';

test('limiter: at most `max` starts in any sliding window, FIFO, everything eventually runs', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 5, windowMs: 1000, ...clock });
  const starts = [];
  const order = [];
  const all = Array.from({ length: 23 }, (_, i) =>
    lim.schedule(async () => {
      starts.push(clock.now());
      order.push(i);
      return i * 2;
    }),
  );
  await flush();
  assert.equal(starts.length, 5, 'the first window is used at once');
  assert.equal(lim.pending, 18);
  await clock.advance(999);
  assert.equal(starts.length, 5, 'nothing more until the window slides');
  await clock.advance(1);
  assert.equal(starts.length, 10);
  await clock.advance(10000);
  assert.deepEqual(await Promise.all(all), Array.from({ length: 23 }, (_, i) => i * 2));
  assert.deepEqual(order, Array.from({ length: 23 }, (_, i) => i));
  assert.equal(maxInWindow(starts, 1000), 5);
  assert.deepEqual([...new Set(starts)], [0, 1000, 2000, 3000, 4000]);
  assert.equal(lim.pending, 0);
  assert.equal(lim.running, 0);
  assert.equal(clock.pendingTimers, 0, 'no timer left armed when idle');
});

test('limiter: the window really slides (starts spread inside a window free up one by one)', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 3, windowMs: 1000, ...clock });
  const starts = [];
  const go = () => lim.schedule(async () => void starts.push(clock.now()));
  go();
  await clock.advance(300);
  go();
  await clock.advance(300);
  go(); // starts: 0, 300, 600
  const queued = [go(), go(), go()];
  await clock.advance(5000);
  await Promise.all(queued);
  assert.deepEqual(starts, [0, 300, 600, 1000, 1300, 1600]);
  assert.equal(maxInWindow(starts, 1000), 3);
});

test('limiter: concurrency cap', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 100, windowMs: 1000, concurrency: 2, ...clock });
  let running = 0;
  let peak = 0;
  const done = [];
  const task = (i) => () =>
    new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      clock.setTimer(() => {
        running--;
        done.push(i);
        resolve(i);
      }, 100);
    });
  const all = [0, 1, 2, 3, 4].map((i) => lim.schedule(task(i)));
  await flush();
  assert.equal(lim.running, 2);
  assert.equal(lim.pending, 3);
  await clock.advance(1000);
  await Promise.all(all);
  assert.equal(peak, 2);
  assert.deepEqual(done, [0, 1, 2, 3, 4]);
});

test('limiter: minGapMs spaces consecutive starts', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 100, windowMs: 60000, minGapMs: 250, ...clock });
  const starts = [];
  const all = Array.from({ length: 5 }, () => lim.schedule(async () => void starts.push(clock.now())));
  await clock.advance(5000);
  await Promise.all(all);
  assert.deepEqual(starts, [0, 250, 500, 750, 1000]);
});

test('limiter: aborting a queued task rejects it, frees its place and uses no quota', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 1, windowMs: 1000, ...clock });
  const ran = [];
  const ctrl = new AbortController();
  const a = lim.schedule(async () => void ran.push('a'));
  const b = lim.schedule(async () => void ran.push('b'), { signal: ctrl.signal });
  const c = lim.schedule(async () => void ran.push('c'));
  await flush();
  assert.equal(lim.pending, 2);
  ctrl.abort();
  await assert.rejects(b, isAbortError);
  assert.equal(lim.pending, 1);
  await clock.advance(1000);
  await Promise.all([a, c]);
  assert.deepEqual(ran, ['a', 'c'], 'c took the slot b would have used');
  assert.equal(clock.now(), 1000);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(lim.schedule(async () => ran.push('never'), { signal: pre.signal }), isAbortError);
  assert.deepEqual(ran, ['a', 'c']);
});

test('limiter: aborting a task that already started does not disturb the queue', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 5, windowMs: 1000, concurrency: 1, ...clock });
  const ctrl = new AbortController();
  let release;
  const a = lim.schedule(() => new Promise((r) => (release = r)), { signal: ctrl.signal });
  const b = lim.schedule(async () => 'b');
  await flush();
  ctrl.abort(); // too late to cancel: the task owns the outcome now
  release('a');
  assert.equal(await a, 'a');
  assert.equal(await b, 'b');
});

test('limiter: maxWaitMs gives up with "busy" instead of queueing forever', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 1, windowMs: 10000, ...clock });
  const ran = [];
  await lim.schedule(async () => void ran.push('first'));
  const impatient = lim.schedule(async () => void ran.push('impatient'), { maxWaitMs: 3000 });
  const patient = lim.schedule(async () => void ran.push('patient'));
  const settled = impatient.then(
    () => 'ran',
    (e) => e,
  );
  await clock.advance(3000);
  const err = await settled;
  assert.ok(err instanceof SourceError && err.code === 'busy');
  await clock.advance(7000);
  await patient;
  assert.deepEqual(ran, ['first', 'patient']);

  // A task that starts in time is not affected by its own maxWaitMs afterwards.
  const quick = createLimiter({ max: 5, windowMs: 1000, ...clock });
  let release;
  const slow = quick.schedule(() => new Promise((r) => (release = r)), { maxWaitMs: 10 });
  await clock.advance(1000);
  release('done');
  assert.equal(await slow, 'done');
});

test('limiter: pause() holds new starts (server said back off)', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 10, windowMs: 1000, ...clock });
  const starts = [];
  await lim.schedule(async () => void starts.push(clock.now()));
  lim.pause(1500);
  const next = lim.schedule(async () => void starts.push(clock.now()));
  await clock.advance(1499);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  await next;
  assert.deepEqual(starts, [0, 1500]);
  // A shorter pause never shortens a longer one.
  lim.pause(5000);
  lim.pause(10);
  const later = lim.schedule(async () => void starts.push(clock.now()));
  await clock.advance(4999);
  assert.equal(starts.length, 2);
  await clock.advance(1);
  await later;
  assert.deepEqual(starts, [0, 1500, 6500]);
});

test('limiter: failing and throwing tasks reject their caller and release their slot', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 10, windowMs: 1000, concurrency: 1, ...clock });
  const a = lim.schedule(async () => {
    throw new Error('async boom');
  });
  const b = lim.schedule(() => {
    throw new Error('sync boom');
  });
  const c = lim.schedule(async () => 'fine');
  await assert.rejects(a, /async boom/);
  await assert.rejects(b, /sync boom/);
  assert.equal(await c, 'fine');
  assert.equal(lim.running, 0);
});

test('limiter: Deezer settings (40 per 5 s, 6 at a time) stay under the 50 / 5 s quota under a burst', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 40, windowMs: 5000, concurrency: 6, ...clock });
  const starts = [];
  let running = 0;
  let peak = 0;
  const all = Array.from({ length: 400 }, (_, i) =>
    lim.schedule(
      () =>
        new Promise((resolve) => {
          starts.push(clock.now());
          running++;
          peak = Math.max(peak, running);
          clock.setTimer(() => {
            running--;
            resolve(i);
          }, 20 + (i % 7) * 30); // 20–200 ms per request
        }),
    ),
  );
  await clock.advance(120000);
  await Promise.all(all);
  assert.equal(starts.length, 400);
  assert.ok(peak <= 6, `peak concurrency ${peak}`);
  const worst = maxInWindow(starts, 5000);
  assert.ok(worst <= 40, `worst 5 s window had ${worst} starts`);
  assert.ok(worst < 50);
  // …and it is not needlessly slow either: 400 requests need 10 windows.
  assert.ok(starts[starts.length - 1] <= 46000, `last start at ${starts[starts.length - 1]} ms`);
});

/* ------------------------------------------------------------------ iTunes queue */

const itunesBody = (n = 1) => ({
  resultCount: n,
  results: Array.from({ length: n }, (_, i) => ({
    wrapperType: 'track',
    kind: 'song',
    trackId: 1000 + i,
    trackName: `Paper Lanterns ${i}`,
    artistName: 'Mara Vale',
    trackTimeMillis: 201000,
    previewUrl: `https://audio-ssl.itunes.apple.com/itunes-assets/preview${i}.m4a`,
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/a/b/c/cover.jpg/100x100bb.jpg',
    trackViewUrl: `https://music.apple.com/us/album/x/1?i=${1000 + i}`,
    trackExplicitness: 'notExplicit',
  })),
});
const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });

test('iTunes queue: serial, at most 15 requests in any minute, at least a second apart', async () => {
  const clock = fakeClock();
  const starts = [];
  let running = 0;
  let peak = 0;
  const fetchImpl = async (url) => {
    starts.push(clock.now());
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => clock.setTimer(r, 350));
    running--;
    assert.match(String(url), /^https:\/\/itunes\.apple\.com\/search\?term=/);
    return jsonResponse(200, itunesBody(2));
  };
  // The production settings, on the fake clock.
  const itunes = createItunes({ fetchImpl, limiter: createLimiter({ max: 15, windowMs: 60000, concurrency: 1, minGapMs: 1000, ...clock }) });
  const all = Array.from({ length: 40 }, (_, i) => itunes.search(`mara vale song ${i}`));
  await clock.advance(200000);
  const results = await Promise.all(all);
  assert.equal(results.length, 40);
  assert.equal(results[0].length, 2);
  assert.equal(peak, 1, 'never two requests at once');
  assert.equal(maxInWindow(starts, 60000), 15);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1000, `gap ${starts[i] - starts[i - 1]}`);
  assert.equal(starts[15], 60000, 'the 16th waits for the first to leave the window');
  assert.equal(starts[30], 120000);
});

test('iTunes queue: the default client is configured to the same limits', async () => {
  // Real clock, but only ever one request: just prove the wiring (limiter exposed, serial).
  let calls = 0;
  const itunes = createItunes({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(200, itunesBody(1));
    },
  });
  const [hit] = await itunes.search('mara vale paper lanterns');
  assert.equal(calls, 1);
  assert.equal(hit.title, 'Paper Lanterns 0');
  assert.equal(itunes.limiter.pending, 0);
});

test('iTunes queue: 403 / 429 pause the queue for a minute and surface as "unreachable"', async () => {
  for (const status of [403, 429]) {
    const clock = fakeClock();
    const starts = [];
    let n = 0;
    const fetchImpl = async () => {
      starts.push(clock.now());
      return n++ === 0 ? jsonResponse(status, {}) : jsonResponse(200, itunesBody(1));
    };
    const itunes = createItunes({ fetchImpl, limiter: createLimiter({ max: 15, windowMs: 60000, concurrency: 1, minGapMs: 1000, ...clock }) });
    const first = itunes.search('a').then(
      () => 'ok',
      (e) => e,
    );
    await clock.advance(10);
    const err = await first;
    assert.ok(err instanceof SourceError && err.code === 'unreachable', `status ${status}`);
    const second = itunes.search('b');
    await clock.advance(59000);
    assert.equal(starts.length, 1, 'quiet while paused');
    await clock.advance(1100);
    assert.equal((await second).length, 1);
    assert.ok(starts[1] >= 60000);
  }
});

test('iTunes queue: maxWaitMs skips the lookup instead of waiting for a far-away slot', async () => {
  const clock = fakeClock();
  const fetchImpl = async () => jsonResponse(200, itunesBody(1));
  const itunes = createItunes({ fetchImpl, limiter: createLimiter({ max: 15, windowMs: 60000, concurrency: 1, minGapMs: 1000, ...clock }) });
  const first15 = Array.from({ length: 15 }, (_, i) => itunes.search(`q${i}`));
  const sixteenth = itunes.search('q15', { maxWaitMs: 30000 }).then(
    () => 'ran',
    (e) => e,
  );
  await clock.advance(50000);
  await Promise.all(first15);
  const err = await sixteenth;
  assert.ok(err instanceof SourceError && err.code === 'busy');
});

test('iTunes queue: network failure and junk bodies are typed errors; abort stays an AbortError', async () => {
  const clock = fakeClock();
  const mk = (fetchImpl) => createItunes({ fetchImpl, limiter: createLimiter({ max: 15, windowMs: 60000, concurrency: 1, ...clock }) });
  await assert.rejects(mk(async () => { throw new TypeError('Failed to fetch'); }).search('x'), (e) => e instanceof SourceError && e.code === 'unreachable');
  await assert.rejects(mk(async () => jsonResponse(200, { nope: true })).search('x'), (e) => e instanceof SourceError && e.code === 'bad-response');
  await assert.rejects(mk(async () => jsonResponse(500, {})).search('x'), (e) => e instanceof SourceError && e.code === 'bad-response');
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(mk(async () => jsonResponse(200, itunesBody(1))).search('x', { signal: ctrl.signal }), isAbortError);
});

test('mapItunesResult: whitelisted fields, https only, bigger artwork', () => {
  const [raw] = itunesBody(1).results;
  assert.deepEqual(mapItunesResult(raw), {
    id: '1000',
    title: 'Paper Lanterns 0',
    artist: 'Mara Vale',
    preview: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview0.m4a',
    durationMs: 201000,
    explicit: false,
    artwork: 'https://is1-ssl.mzstatic.com/image/thumb/Music/a/b/c/cover.jpg/300x300bb.jpg',
    link: 'https://music.apple.com/us/album/x/1?i=1000',
  });
  assert.equal(mapItunesResult({ ...raw, previewUrl: 'http://audio-ssl.itunes.apple.com/p.m4a' }), null, 'http preview is refused');
  assert.equal(mapItunesResult({ ...raw, previewUrl: undefined }), null);
  assert.equal(mapItunesResult({ ...raw, trackName: '' }), null);
  assert.equal(mapItunesResult({ ...raw, kind: 'music-video' }), null);
  assert.equal(mapItunesResult({ ...raw, wrapperType: 'collection' }), null);
  assert.equal(mapItunesResult({ ...raw, trackId: 'abc' }), null);
  assert.equal(mapItunesResult(null), null);
  const scheme = ['java', 'script:void 0'].join('');
  const odd = mapItunesResult({ ...raw, artworkUrl100: scheme, trackViewUrl: scheme });
  assert.equal(odd.artwork, undefined);
  assert.equal(odd.link, undefined);
});

test('limiter: a bounded wait that cannot be met is refused at once, not after the wait', async () => {
  const clock = fakeClock();
  const lim = createLimiter({ max: 2, windowMs: 60000, minGapMs: 1000, ...clock });
  const ran = [];
  const a = lim.schedule(async () => void ran.push('a'), { maxWaitMs: 30000 });
  const b = lim.schedule(async () => void ran.push('b'), { maxWaitMs: 30000 }); // 1 s away: fine
  const c = lim.schedule(async () => void ran.push('c'), { maxWaitMs: 30000 }).then(
    () => 'ran',
    (e) => e,
  ); // 60 s away: hopeless
  const err = await c; // no clock.advance() needed
  assert.ok(err instanceof SourceError && err.code === 'busy');
  assert.equal(clock.now(), 0);
  assert.equal(lim.pending, 1, 'the hopeless one never entered the queue');
  await clock.advance(1000);
  await Promise.all([a, b]);
  assert.deepEqual(ran, ['a', 'b']);
  // Close enough to the window's end, the same request is accepted and runs.
  await clock.advance(31000);
  const d = lim.schedule(async () => 'd', { maxWaitMs: 30000 });
  await clock.advance(28000);
  assert.equal(await d, 'd');
  // While paused for longer than the caller will wait: refused at once as well.
  lim.pause(45000);
  const e = await lim.schedule(async () => 'e', { maxWaitMs: 30000 }).catch((x) => x);
  assert.ok(e instanceof SourceError && e.code === 'busy');
  // Without maxWaitMs the caller simply waits.
  const f = lim.schedule(async () => 'f');
  await clock.advance(120000);
  assert.equal(await f, 'f');
});

// request() with a byte limit, and download(): what they do with bodies that are too big, too slow,
// silent, or cancelled — and that neither leaves a timer or a connection behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { SourceError, createPulse, download, request } from '../js/sources/util.js';

const URL_A = 'https://relay.example/answer';
const coded = (code) => (err) => err instanceof SourceError && err.code === code;
const isAbortError = (err) => !!err && err.name === 'AbortError';
// For tests that run on mocked timers: a promise that waits for a timer nobody advances would
// otherwise hang the whole run instead of failing this one test.
const BOUNDED = { timeout: 10000 };
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/**
 * A response whose body is a stream the test controls. `chunks` are served one per read; with
 * `endless` the last one is served again and again. The stream fails when the request is aborted,
 * the way fetch does — unless `deaf`, which models a transport that never notices.
 */
function streamed(chunks, { status = 200, headers = {}, endless = false, deaf = false, hold = false } = {}) {
  const seen = { served: 0, reads: 0, cancelled: false, aborted: false, textCalls: 0 };
  const enc = new TextEncoder();
  const fetchImpl = async (url, init) => {
    let i = 0;
    let ctl;
    const body = new ReadableStream({
      start(c) {
        ctl = c;
      },
      pull(c) {
        if (hold) return; // headers only, then silence
        seen.reads++;
        if (i >= chunks.length && !endless) return c.close();
        const raw = chunks[Math.min(i++, chunks.length - 1)];
        const bytes = typeof raw === 'string' ? enc.encode(raw) : raw;
        seen.served += bytes.byteLength;
        c.enqueue(bytes);
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    init.signal.addEventListener('abort', () => {
      seen.aborted = true;
      if (deaf) return;
      try {
        ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      } catch {
        /* already closed */
      }
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(headers),
      body,
      text: async () => (seen.textCalls++, assert.fail('a limited body must be read as a stream')),
      arrayBuffer: async () => assert.fail('a limited body must be read as a stream'),
    };
  };
  return { fetchImpl, seen };
}

/* ------------------------------------------------------------------ request({maxBytes}) */

test('request: a body under the limit reads exactly like an unlimited one', async () => {
  const payload = { title: 'Paper Lanterns — ½ speed', n: [1, 2, 3], note: 'ünïcödé ' + String.fromCodePoint(0x1f3b6) };
  const text = JSON.stringify(payload);
  const whole = new TextEncoder().encode(text);
  for (const as of ['json', 'text']) {
    const plain = await request(URL_A, { as, fetchImpl: async () => new Response(text, { status: 200 }) });
    const capped = await request(URL_A, { as, maxBytes: 4096, fetchImpl: async () => new Response(text, { status: 200 }) });
    assert.deepEqual(capped, plain);
    // Split in the middle of multi-byte characters, one byte per chunk: still the same text.
    const drip = streamed(Array.from(whole, (b) => Uint8Array.of(b)));
    assert.deepEqual(await request(URL_A, { as, maxBytes: 4096, fetchImpl: drip.fetchImpl }), plain);
  }
  // Exactly at the limit is fine; one byte over is not.
  const exact = 'x'.repeat(1000);
  assert.equal((await request(URL_A, { as: 'text', maxBytes: 1000, fetchImpl: async () => new Response(exact) })).body, exact);
  await assert.rejects(request(URL_A, { as: 'text', maxBytes: 999, fetchImpl: async () => new Response(exact) }), coded('too-large'));
  // Status and non-JSON bodies behave as before.
  const bad = await request(URL_A, { maxBytes: 4096, fetchImpl: async () => new Response('upstream error', { status: 502 }) });
  assert.deepEqual(bad, { status: 502, ok: false, body: undefined });
  // A leading byte-order mark is dropped, as Response.text() does.
  const bom = await request(URL_A, { maxBytes: 4096, fetchImpl: async () => new Response(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d)) });
  assert.deepEqual(bom.body, {});
});

test('request: a body announced as over the limit is refused without reading a byte', async () => {
  const big = streamed(['x'.repeat(1000)], { headers: { 'content-length': '5000000' }, endless: true });
  const err = await request(URL_A, { as: 'text', maxBytes: 100000, fetchImpl: big.fetchImpl }).catch((e) => e);
  assert.ok(coded('too-large')(err));
  assert.match(err.detail, /relay\.example/);
  assert.equal(big.seen.cancelled, true, 'the connection is let go');
  assert.ok(big.seen.served <= 1000, `nothing was read on purpose (${big.seen.served} bytes buffered by the stream itself)`);
});

test('request: an unannounced endless body is dropped as soon as it passes the limit', async () => {
  const flood = streamed([new Uint8Array(64 * 1024)], { endless: true });
  const t0 = performance.now();
  const err = await request(URL_A, { as: 'json', maxBytes: 1024 * 1024, fetchImpl: flood.fetchImpl }).catch((e) => e);
  assert.ok(coded('too-large')(err));
  assert.equal(flood.seen.cancelled, true);
  assert.ok(flood.seen.served > 1024 * 1024 && flood.seen.served <= 1024 * 1024 + 3 * 64 * 1024, `stopped right after the limit (${flood.seen.served} bytes)`);
  assert.ok(performance.now() - t0 < 2000);
  // A content-length that lies low does not help the sender.
  const liar = streamed([new Uint8Array(64 * 1024)], { endless: true, headers: { 'content-length': '10' } });
  await assert.rejects(request(URL_A, { as: 'text', maxBytes: 200000, fetchImpl: liar.fetchImpl }), coded('too-large'));
  assert.equal(liar.seen.cancelled, true);
});

test('request: where the body is not a stream the limit is applied to the text', async () => {
  const plain = (text) => async () => ({ status: 200, ok: true, text: async () => text });
  assert.equal((await request(URL_A, { as: 'text', maxBytes: 10, fetchImpl: plain('0123456789') })).body, '0123456789');
  await assert.rejects(request(URL_A, { as: 'text', maxBytes: 10, fetchImpl: plain('0123456789a') }), coded('too-large'));
});

test('request: without a limit nothing changes — the body is read whole, never as a stream', async () => {
  let streamTouched = false;
  const res = {
    status: 200,
    ok: true,
    get body() {
      streamTouched = true;
      return null;
    },
    text: async () => '{"fine":true}',
  };
  assert.deepEqual(await request(URL_A, { fetchImpl: async () => res }), { status: 200, ok: true, body: { fine: true } });
  assert.equal(streamTouched, false);
  // maxBytes is for text and JSON; a binary read ignores it.
  const bin = await request(URL_A, { as: 'arrayBuffer', maxBytes: 4, fetchImpl: async () => new Response(new Uint8Array(64)) });
  assert.equal(bin.body.byteLength, 64);
});

test('request: with a limit, a deadline is still "timeout" and a cancel is still AbortError', BOUNDED, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Headers arrive, then the body goes silent.
  for (const deaf of [false, true]) {
    const silent = streamed([], { hold: true, deaf });
    const p = request(URL_A, { as: 'text', maxBytes: 1000, timeoutMs: 9000, fetchImpl: silent.fetchImpl }).catch((e) => e);
    await flush();
    t.mock.timers.tick(8999);
    await flush();
    assert.equal(silent.seen.aborted, false);
    t.mock.timers.tick(1);
    const err = await p;
    assert.ok(coded('timeout')(err), `${deaf ? 'a transport that ignores the abort' : 'a normal transport'}: ${err && err.code}`);
    assert.equal(silent.seen.aborted, true);
    assert.equal(silent.seen.cancelled || !deaf, true, 'the reader is released either way');
  }
  for (const deaf of [false, true]) {
    const silent = streamed([], { hold: true, deaf });
    const ctrl = new AbortController();
    const p = request(URL_A, { as: 'json', maxBytes: 1000, signal: ctrl.signal, fetchImpl: silent.fetchImpl }).catch((e) => e);
    await flush();
    ctrl.abort();
    assert.ok(isAbortError(await p));
  }
});

/* ------------------------------------------------------------------ download() */

test('download: bytes arrive joined and in order; an error status comes back without its body', async () => {
  const parts = [Uint8Array.of(1, 2, 3), new Uint8Array(0), Uint8Array.of(4), Uint8Array.of(5, 6)];
  const ok = streamed(parts);
  const res = await download(URL_A, { fetchImpl: ok.fetchImpl });
  assert.equal(res.status, 200);
  assert.ok(res.body instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(res.body)], [1, 2, 3, 4, 5, 6]);

  const missing = streamed([new Uint8Array(5000)], { status: 404 });
  assert.deepEqual(await download(URL_A, { fetchImpl: missing.fetchImpl }), { status: 404, ok: false, body: null });
  assert.equal(missing.seen.cancelled, true);
  assert.ok(missing.seen.served <= 5000, 'the error page is not downloaded');
});

test('download: the request is credential-free and carries no referrer', async () => {
  let init = null;
  await download(URL_A, { fetchImpl: async (url, i) => ((init = i), new Response(new Uint8Array(8))) });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
});

test('download: silence is measured from the last byte, not from the start', BOUNDED, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ctl;
  let aborted = false;
  const fetchImpl = async (url, init) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    return { status: 200, ok: true, headers: new Headers(), body: new ReadableStream({ start: (c) => (ctl = c) }) };
  };
  const p = download(URL_A, { idleMs: 1000, totalMs: 60000, fetchImpl }).catch((e) => e);
  await flush();
  // Ten seconds of a byte every 900 ms: ten times the idle limit, never idle.
  for (let i = 0; i < 11; i++) {
    ctl.enqueue(Uint8Array.of(i));
    await flush();
    t.mock.timers.tick(900);
    await flush();
    assert.equal(aborted, false, `alive at ${(i + 1) * 900} ms`);
  }
  t.mock.timers.tick(100);
  const err = await p;
  assert.ok(coded('timeout')(err), 'then 1000 ms of nothing ends it');
  assert.equal(aborted, true);
});

test('download: downloads sharing a pulse keep each other alive; a finished or failed one stops counting', BOUNDED, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** A request that waits for `headers()`, then a body fed by `push()`. */
  const waiting = () => {
    const call = { aborted: false };
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        let ctl;
        const body = new ReadableStream({ start: (c) => (ctl = c) });
        call.headers = () => resolve({ status: 200, ok: true, headers: new Headers(), body });
        call.push = (n) => ctl.enqueue(new Uint8Array(n));
        call.end = () => ctl.close();
        init.signal.addEventListener('abort', () => {
          call.aborted = true;
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          reject(err);
          try {
            ctl.error(err);
          } catch {
            /* already closed */
          }
        });
      });
    return { call, fetchImpl };
  };
  const pulse = createPulse();
  const busy = waiting();
  const queued = waiting();
  const alone = waiting();
  const opts = { idleMs: 1000, totalMs: 60000 };
  const pBusy = download(URL_A, { ...opts, pulse, fetchImpl: busy.fetchImpl });
  const pQueued = download(URL_A, { ...opts, pulse, fetchImpl: queued.fetchImpl }).catch((e) => e);
  const pAlone = download(URL_A, { ...opts, fetchImpl: alone.fetchImpl }).catch((e) => e);
  await flush();
  busy.call.headers();
  for (let i = 0; i < 10; i++) {
    busy.call.push(100);
    await flush();
    t.mock.timers.tick(900);
    await flush();
  }
  assert.equal(queued.call.aborted, false, 'nine seconds without so much as headers, but the line is busy with the other file');
  assert.equal(alone.call.aborted, true, 'the same silence with no pulse to share is a stall');
  assert.ok(coded('timeout')(await pAlone));
  busy.call.end();
  assert.equal((await pBusy).body.byteLength, 1000);
  // The busy one is done, 900 ms after its last byte: from here the queued one is on its own clock.
  t.mock.timers.tick(99);
  await flush();
  assert.equal(queued.call.aborted, false);
  t.mock.timers.tick(1);
  assert.ok(coded('timeout')(await pQueued), '1000 ms after the last byte on either');
  assert.equal(queued.call.aborted, true);

  // A body that cannot be watched takes no part: somebody else's bytes must not start an idle
  // clock for it that its own (invisible) progress could never reset.
  let deliver = null;
  const blind = download(URL_A, { idleMs: 1000, totalMs: 5000, pulse, fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: () => new Promise((done) => (deliver = () => done(new ArrayBuffer(64)))) }) });
  await flush();
  pulse.beat();
  t.mock.timers.tick(3000); // three idle limits of nothing from anyone
  await flush();
  deliver();
  assert.equal((await blind).body.byteLength, 64);
  // …and it is the overall limit that ends one that never arrives.
  const never = download(URL_A, { idleMs: 1000, totalMs: 5000, pulse, fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: () => new Promise(() => {}) }) }).catch((e) => e);
  await flush();
  t.mock.timers.tick(4999);
  await flush();
  pulse.beat();
  t.mock.timers.tick(1);
  assert.ok(coded('timeout')(await never));
});

test('download: the caller cancelling mid-body is AbortError, and the body is let go', async () => {
  const slow = streamed([new Uint8Array(1000)], { hold: true });
  const ctrl = new AbortController();
  const p = download(URL_A, { signal: ctrl.signal, fetchImpl: slow.fetchImpl }).catch((e) => e);
  await flush();
  ctrl.abort();
  assert.ok(isAbortError(await p));
  assert.equal(slow.seen.aborted, true);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(download(URL_A, { signal: pre.signal, fetchImpl: () => assert.fail('must not fetch') }), isAbortError);
});

test('download: too much is "too-large" whether announced or not', async () => {
  const announced = streamed([new Uint8Array(100)], { headers: { 'content-length': '999999' } });
  await assert.rejects(download(URL_A, { maxBytes: 5000, fetchImpl: announced.fetchImpl }), coded('too-large'));
  assert.equal(announced.seen.cancelled, true);
  const flood = streamed([new Uint8Array(1000)], { endless: true });
  await assert.rejects(download(URL_A, { maxBytes: 5000, fetchImpl: flood.fetchImpl }), coded('too-large'));
  assert.equal(flood.seen.cancelled, true);
  assert.ok(flood.seen.served <= 8000, `${flood.seen.served} bytes`);
});

test('request / download: nothing keeps the process alive afterwards (no timer, no reader left behind)', () => {
  // download() arms a 15-second and a two-minute timer, request() a 10-second one. Had any path
  // forgotten to clear them, this child would still be running when its kill timer fires.
  const utilUrl = new URL('../js/sources/util.js', import.meta.url).href;
  const code = `
    import { download, request } from ${JSON.stringify(utilUrl)};
    const u = 'https://relay.example/x';
    const endless = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4096)); } }));
    const out = [];
    const note = (p) => p.then((r) => out.push(r.status), (e) => out.push(e.name === 'SourceError' ? e.code : e.name));
    await note(download(u, { fetchImpl: async () => new Response(new Uint8Array(5000)) }));
    await note(download(u, { fetchImpl: async () => new Response('gone', { status: 404 }) }));
    await note(download(u, { maxBytes: 10000, fetchImpl: async () => endless() }));
    await note(download(u, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }));
    await note(download(u, { fetchImpl: async () => ({ status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(16) }) }));
    await note(request(u, { as: 'text', maxBytes: 10000, fetchImpl: async () => new Response('ok') }));
    await note(request(u, { as: 'text', maxBytes: 10000, fetchImpl: async () => endless() }));
    await note(request(u, { as: 'text', maxBytes: 10000, fetchImpl: async () => { throw new TypeError('fetch failed'); } }));
    const ctrl = new AbortController();
    const hang = download(u, { signal: ctrl.signal, fetchImpl: () => new Promise(() => {}) });
    ctrl.abort();
    await note(hang);
    console.log(JSON.stringify(out));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 10000, encoding: 'utf8' });
  assert.equal(run.error, undefined, `still running after 10 s: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [200, 404, 'too-large', 'TypeError', 200, 200, 'too-large', 'TypeError', 'AbortError']);
});

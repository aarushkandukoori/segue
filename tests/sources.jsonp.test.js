// JSONP helper against a fake document / window (no network, no real <script> execution).
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonp, jsonpGlobals } from '../js/sources/jsonp.js';
import { SourceError } from '../js/sources/util.js';

/** Minimal stand-in for document + window that records what the helper does to them. */
function fakeBrowser() {
  const win = {};
  const head = {
    children: [],
    appendChild(el) {
      el.parentNode = head;
      head.children.push(el);
      doc.appended.push(el);
      return el;
    },
    removeChild(el) {
      const i = head.children.indexOf(el);
      if (i >= 0) head.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
  const doc = {
    head,
    appended: [],
    createElement(tag) {
      assert.equal(tag, 'script');
      return { tagName: 'SCRIPT', parentNode: null, src: '', async: false, onload: null, onerror: null };
    },
  };
  const last = () => doc.appended[doc.appended.length - 1];
  const callbackOf = (el) => new URL(el.src).searchParams.get('callback');
  return {
    win,
    doc,
    last,
    callbackOf,
    /** The server answered: the script body runs (calls the callback), then `load` fires. */
    respond(el, payload) {
      const fn = win[callbackOf(el)];
      if (typeof fn !== 'function') throw new ReferenceError(`${callbackOf(el)} is not defined`);
      fn(payload);
      if (el.onload) el.onload();
    },
    clean() {
      return head.children.length === 0 && jsonpGlobals(win).length === 0 && Object.keys(win).length === 0;
    },
  };
}

const URL_OK = 'https://api.deezer.com/search?q=mara%20vale&limit=5';
const rejectsWith = (code) => (err) => err instanceof SourceError && err.code === code;
const isAbortError = (err) => err && err.name === 'AbortError';

test('jsonp: success → payload, then no script tag and no global left', async () => {
  const b = fakeBrowser();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win });
  const el = b.last();
  assert.equal(b.doc.head.children.length, 1);
  const u = new URL(el.src);
  assert.equal(u.origin + u.pathname, 'https://api.deezer.com/search');
  assert.equal(u.searchParams.get('q'), 'mara vale', 'the query survives');
  assert.equal(u.searchParams.get('limit'), '5');
  assert.equal(u.searchParams.get('output'), 'jsonp');
  const name = u.searchParams.get('callback');
  assert.match(name, /^__segueJsonp_\d+_[a-z0-9]+$/);
  assert.equal(typeof b.win[name], 'function');
  assert.deepEqual(jsonpGlobals(b.win), [name]);
  assert.equal(el.async, true);

  b.respond(el, { data: [{ id: 1 }], total: 1 });
  assert.deepEqual(await p, { data: [{ id: 1 }], total: 1 });
  assert.ok(b.clean());
  assert.equal(el.onload, null);
  assert.equal(el.onerror, null);
});

test('jsonp: concurrent calls get unique callback names and do not cross wires', async () => {
  const b = fakeBrowser();
  const ps = Array.from({ length: 25 }, (_, i) => jsonp(`https://api.deezer.com/track/${i + 1}`, { doc: b.doc, win: b.win }));
  const names = b.doc.appended.map(b.callbackOf);
  assert.equal(new Set(names).size, 25);
  assert.equal(jsonpGlobals(b.win).length, 25);
  // Answer in reverse order.
  [...b.doc.appended].reverse().forEach((el) => b.respond(el, { id: Number(new URL(el.src).pathname.split('/').pop()) }));
  const out = await Promise.all(ps);
  assert.deepEqual(out.map((o) => o.id), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.ok(b.clean());
});

test('jsonp: script error → "unreachable", cleaned up', async () => {
  const b = fakeBrowser();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win });
  b.last().onerror();
  await assert.rejects(p, rejectsWith('unreachable'));
  assert.ok(b.clean());
});

test('jsonp: script loaded but never called back → "bad-response", cleaned up', async () => {
  const b = fakeBrowser();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win });
  b.last().onload();
  await assert.rejects(p, rejectsWith('bad-response'));
  assert.ok(b.clean());
});

test('jsonp: timeout → "timeout"; a late answer is swallowed and the leftovers disappear with it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win, timeoutMs: 8000 });
  const el = b.last();
  const name = b.callbackOf(el);
  t.mock.timers.tick(7999);
  assert.equal(b.doc.head.children.length, 1, 'still waiting');
  t.mock.timers.tick(1);
  await assert.rejects(p, rejectsWith('timeout'));
  assert.equal(b.doc.head.children.length, 0, 'script tag is gone right away');
  // The request cannot be cancelled, so a no-op stays registered for the late response…
  assert.equal(typeof b.win[name], 'function');
  assert.doesNotThrow(() => b.respond(el, { data: [] }), 'late response does not throw a ReferenceError');
  // …and goes away as soon as that response has arrived.
  assert.ok(b.clean());
});

test('jsonp: timeout with a response that never comes → the tombstone expires on its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win, timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  await assert.rejects(p, rejectsWith('timeout'));
  assert.equal(jsonpGlobals(b.win).length, 1);
  t.mock.timers.tick(15000);
  assert.ok(b.clean(), 'nothing left behind after the grace period');
});

test('jsonp: abort → AbortError, cleaned up; a late answer is harmless', async () => {
  const b = fakeBrowser();
  const ctrl = new AbortController();
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win, signal: ctrl.signal });
  const el = b.last();
  ctrl.abort();
  await assert.rejects(p, isAbortError);
  assert.equal(b.doc.head.children.length, 0);
  assert.doesNotThrow(() => b.respond(el, { data: [] }));
  assert.ok(b.clean());

  // Late *error* instead of a late answer cleans up too.
  const ctrl2 = new AbortController();
  const p2 = jsonp(URL_OK, { doc: b.doc, win: b.win, signal: ctrl2.signal });
  const el2 = b.last();
  ctrl2.abort();
  await assert.rejects(p2, isAbortError);
  el2.onerror();
  assert.ok(b.clean());
});

test('jsonp: an already-aborted signal never touches the document', async () => {
  const b = fakeBrowser();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(jsonp(URL_OK, { doc: b.doc, win: b.win, signal: ctrl.signal }), isAbortError);
  assert.equal(b.doc.appended.length, 0);
  assert.ok(b.clean());
});

test('jsonp: abort after success is a no-op; the abort listener is removed', async () => {
  const b = fakeBrowser();
  const ctrl = new AbortController();
  let listeners = 0;
  const add = ctrl.signal.addEventListener.bind(ctrl.signal);
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = (...a) => (listeners++, add(...a));
  ctrl.signal.removeEventListener = (...a) => (listeners--, remove(...a));
  const p = jsonp(URL_OK, { doc: b.doc, win: b.win, signal: ctrl.signal });
  b.respond(b.last(), { ok: true });
  assert.deepEqual(await p, { ok: true });
  assert.equal(listeners, 0);
  ctrl.abort();
  assert.ok(b.clean());
});

test('jsonp: only https://api.deezer.com is ever loaded as a script', async () => {
  const b = fakeBrowser();
  const refused = [
    'https://example.com/search?q=x',
    'https://api.deezer.com.example.com/search?q=x',
    'https://example.com/api.deezer.com/search',
    'https://user@example.com/@api.deezer.com',
    'http://api.deezer.com/search?q=x',
    '//api.deezer.com/search?q=x',
    'api.deezer.com/search?q=x',
    ['java', 'script:void 0'].join(''),
    ['da', 'ta:text/plain,x'].join(''),
    'https://deezer.com/search',
    'https://cdn-api.deezer.com/search',
    '',
    'not a url',
  ];
  for (const url of refused) {
    await assert.rejects(jsonp(url, { doc: b.doc, win: b.win }), rejectsWith('bad-response'), url);
  }
  await assert.rejects(jsonp(undefined, { doc: b.doc, win: b.win }), rejectsWith('bad-response'));
  assert.equal(b.doc.appended.length, 0, 'no script element was ever created');
  assert.ok(b.clean());
});

test('jsonp: caller-supplied output/callback params cannot redirect the callback', async () => {
  const b = fakeBrowser();
  const p = jsonp('https://api.deezer.com/search?q=x&callback=alert&output=xml', { doc: b.doc, win: b.win });
  const u = new URL(b.last().src);
  assert.deepEqual(u.searchParams.getAll('callback').length, 1);
  assert.match(u.searchParams.get('callback'), /^__segueJsonp_/);
  assert.equal(u.searchParams.get('output'), 'jsonp');
  b.respond(b.last(), {});
  await p;
  assert.ok(b.clean());
});

test('jsonp: without a document (Node) it fails cleanly instead of throwing', async () => {
  await assert.rejects(jsonp(URL_OK, { doc: null, win: {} }), rejectsWith('unreachable'));
  await assert.rejects(jsonp(URL_OK), rejectsWith('unreachable'));
  assert.deepEqual(jsonpGlobals(), []);
});

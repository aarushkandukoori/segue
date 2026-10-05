// JSONP for the one API that needs it: api.deezer.com sends no CORS headers, so a <script> tag is
// the only way to read it from a static page. JSONP executes whatever the server returns, so this
// helper refuses every host except the allow-list (Deezer's API) — never point it anywhere else.

import { SourceError, abortError } from './util.js';

const ALLOWED_HOSTS = new Set(['api.deezer.com']);
const PREFIX = '__segueJsonp';
// A browser cannot cancel a <script> fetch. After a timeout/abort the response may still arrive and
// call the callback; a tiny no-op stays registered until the request settles (or this long at most)
// so that late call is swallowed instead of throwing a ReferenceError into the console.
const TOMBSTONE_MS = 15000;

let counter = 0;

/**
 * @param {string} url  https://api.deezer.com/... (without output/callback params)
 * @param {{signal?: AbortSignal, timeoutMs?: number, doc?: Document, win?: any}} [opts]  doc/win are injectable for tests
 * @returns {Promise<any>} the JSON payload
 */
export function jsonp(url, opts = {}) {
  const { signal, timeoutMs = 8000 } = opts;
  const doc = opts.doc || globalThis.document;
  const win = opts.win || globalThis;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new SourceError('bad-response', 'Bad request address.', { detail: String(url) }));
    }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
      return reject(new SourceError('bad-response', 'Refusing JSONP to an unexpected host.', { detail: u.hostname }));
    }
    if (signal && signal.aborted) return reject(abortError());
    if (!doc || typeof doc.createElement !== 'function') {
      return reject(new SourceError('unreachable', 'JSONP needs a browser document.'));
    }

    const name = `${PREFIX}_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
    u.searchParams.set('output', 'jsonp');
    u.searchParams.set('callback', name);

    const script = doc.createElement('script');
    let settled = false;
    let timer = null;
    let tombTimer = null;

    const removeScript = () => {
      script.onload = null;
      script.onerror = null;
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    const removeGlobal = () => {
      if (tombTimer != null) clearTimeout(tombTimer);
      tombTimer = null;
      try {
        delete win[name];
      } catch {
        win[name] = undefined;
      }
    };
    /** @param {boolean} requestSettled  false when the network request may still complete later */
    const finish = (requestSettled) => {
      settled = true;
      if (timer != null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (requestSettled) {
        removeScript();
        removeGlobal();
      } else {
        // Keep listening so the tombstone goes away the moment the request really ends.
        script.onload = script.onerror = () => {
          removeScript();
          removeGlobal();
        };
        if (script.parentNode) script.parentNode.removeChild(script);
        win[name] = () => {};
        tombTimer = setTimeout(() => {
          removeScript();
          removeGlobal();
        }, TOMBSTONE_MS);
      }
    };
    const onAbort = () => {
      if (settled) return;
      finish(false);
      reject(abortError());
    };

    win[name] = (data) => {
      if (settled) return;
      finish(true);
      resolve(data);
    };
    script.onerror = () => {
      if (settled) return;
      finish(true);
      reject(new SourceError('unreachable', 'Could not reach Deezer.', { detail: u.pathname }));
    };
    // Loaded without ever calling us back: the body was not the JSONP we asked for.
    script.onload = () => {
      if (settled) return;
      finish(true);
      reject(new SourceError('bad-response', 'Deezer sent an unexpected response.', { detail: u.pathname }));
    };
    timer = setTimeout(() => {
      if (settled) return;
      finish(false);
      reject(new SourceError('timeout', 'Deezer took too long to answer.', { detail: u.pathname }));
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    script.async = true;
    script.src = u.href;
    (doc.head || doc.documentElement).appendChild(script);
  });
}

/** Names of JSONP callbacks currently registered on `win` (tests use this to prove nothing leaks). */
export function jsonpGlobals(win = globalThis) {
  return Object.keys(win).filter((k) => k.startsWith(PREFIX));
}

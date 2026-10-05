// Shared plumbing for the sources modules: typed errors, URL hygiene, text hygiene, abortable
// timeouts. No DOM access here, so everything is importable from Node tests.

/**
 * Error thrown by loaders. `message` is always safe and friendly enough to show to the user as-is.
 * code: 'empty-input' | 'unsupported' | 'not-found' | 'empty' | 'unreachable' | 'offline' | 'timeout' | 'bad-response'
 */
export class SourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{cause?: unknown, detail?: string}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SourceError';
    this.code = code;
    /** Technical detail for logs (never shown to the user). */
    this.detail = opts.detail || '';
  }
}

/** Display string the loaders use when a source names no artist. The resolver treats it as "unknown". */
export const UNKNOWN_ARTIST = 'Unknown artist';

/** The standard "you cancelled this" error, same shape fetch() uses. */
export function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** @param {unknown} err */
export function isAbort(err) {
  return !!err && typeof err === 'object' && /** @type {{name?: string}} */ (err).name === 'AbortError';
}

/** @param {AbortSignal} [signal] */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/**
 * Returns the URL as a string only if it is an absolute https URL; otherwise undefined.
 * Every image / audio / link URL that leaves this package goes through here.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let u;
  try {
    u = new URL(value);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return undefined;
  return u.href;
}

// Control chars, zero-width chars, BOM and bidi overrides: never meaningful in a song title, and bidi
// overrides can be used to spoof what a title looks like.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const ODD_SPACE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/**
 * Display-string hygiene for anything that came from the network or a file name.
 * (The UI still has to use textContent; this only makes the text sane.)
 * @param {unknown} value
 * @param {number} [max]
 */
export function cleanText(value, max = 300) {
  if (typeof value !== 'string') return '';
  let s = value.replace(INVISIBLE, '').replace(ODD_SPACE, ' ').trim();
  try {
    s = s.normalize('NFC');
  } catch {
    /* lone surrogates etc. — keep as is */
  }
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/**
 * setTimeout as a promise that rejects with AbortError when the signal fires.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    const id = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * fetch + body read under one deadline. Distinguishes the caller aborting (AbortError) from the
 * deadline passing (SourceError 'timeout') — the relay chain treats those very differently.
 * @param {string} url
 * @param {{signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string>,
 *          as?: 'json'|'text'|'arrayBuffer', fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{status: number, ok: boolean, body: any}>}
 */
export async function request(url, opts = {}) {
  const { signal, timeoutMs = 10000, headers, as = 'json', fetchImpl = globalThis.fetch } = opts;
  throwIfAborted(signal);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let body;
    if (as === 'arrayBuffer') body = await res.arrayBuffer();
    else {
      const text = await res.text();
      if (as === 'text') body = text;
      else {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined; // caller decides what a non-JSON body means
        }
      }
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    if (timedOut) throw new SourceError('timeout', 'The request took too long.', { cause: err, detail: url });
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Small stable string hash (FNV-1a, 32 bit) → base36. Used for ids of pasted text / dropped files. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

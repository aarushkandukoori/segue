// Shared plumbing for the sources modules: typed errors, URL hygiene, text hygiene, abortable
// timeouts. No DOM access here, so everything is importable from Node tests.

/**
 * Error thrown by loaders. `message` is always safe and friendly enough to show to the user as-is.
 * code: 'empty-input' | 'unsupported' | 'not-found' | 'empty' | 'unreachable' | 'offline' | 'timeout' | 'bad-response' | 'too-large'
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

const tooLarge = (url, limit) => new SourceError('too-large', 'The response was too large.', { detail: `more than ${limit} bytes from ${url}` });

/**
 * A promise that rejects with AbortError when `signal` fires and never resolves. Raced against
 * reads so that giving up on a request takes effect even if the transport does not react to it.
 * @param {AbortSignal} signal
 * @returns {{promise: Promise<never>, off: () => void}}
 */
function whenAborted(signal) {
  let off = () => {};
  /** @type {Promise<never>} */
  const promise = new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    off = () => signal.removeEventListener('abort', onAbort);
  });
  promise.catch(() => {}); // only ever observed through a race
  return { promise, off };
}

const dropBody = (res) => {
  if (res && res.body && typeof res.body.cancel === 'function') Promise.resolve(res.body.cancel()).catch(() => {});
};

/**
 * Read a response body chunk by chunk instead of in one go, so the caller can
 *  - stop as soon as more than `maxBytes` have arrived or been announced (SourceError 'too-large'),
 *  - hear about every chunk (`onChunk`) and so tell a slow download from a dead one.
 * Returns null when the body is not a readable stream (old engines, test doubles) — the caller
 * then reads it whole and can only check the size afterwards.
 * @param {Response} res
 * @param {{maxBytes?: number, onChunk?: () => void, gone?: Promise<never>, url?: string}} [opts]
 *        gone: see whenAborted()
 * @returns {Promise<Uint8Array | null>}
 */
async function readChunks(res, opts = {}) {
  const { maxBytes = Infinity, onChunk, gone, url = '' } = opts;
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (declared > maxBytes) {
    dropBody(res);
    throw tooLarge(url, maxBytes);
  }
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await (gone ? Promise.race([reader.read(), gone]) : reader.read());
      if (done) break;
      if (!value || !value.byteLength) continue;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge(url, maxBytes);
      chunks.push(value);
      if (onChunk) onChunk();
    }
  } catch (err) {
    Promise.resolve(reader.cancel()).catch(() => {}); // let go of the connection; the caller reports `err`
    throw err;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** res.text() that refuses to buffer more than `maxBytes`. */
async function cappedText(res, maxBytes, url, gone) {
  const bytes = await readChunks(res, { maxBytes, url, gone });
  if (bytes) return new TextDecoder().decode(bytes);
  const text = await res.text();
  if (text.length > maxBytes) throw tooLarge(url, maxBytes);
  return text;
}

/**
 * fetch + body read under one deadline. Distinguishes the caller aborting (AbortError) from the
 * deadline passing (SourceError 'timeout') — the relay chain treats those very differently.
 *
 * `maxBytes` (text / json only) is for answers from servers that are not ours to trust: the body
 * is read as a stream and dropped with SourceError 'too-large' past the limit, before anything
 * parses it. Without it the body is read whole.
 * @param {string} url
 * @param {{signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string>,
 *          as?: 'json'|'text'|'arrayBuffer', maxBytes?: number, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{status: number, ok: boolean, body: any}>}
 */
export async function request(url, opts = {}) {
  const { signal, timeoutMs = 10000, headers, as = 'json', maxBytes, fetchImpl = globalThis.fetch } = opts;
  throwIfAborted(signal);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const capped = maxBytes > 0 && as !== 'arrayBuffer';
  const gone = capped ? whenAborted(ctrl.signal) : null;
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
      const text = gone ? await cappedText(res, maxBytes, url, gone.promise) : await res.text();
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
    if (gone) gone.off();
  }
}

/**
 * A sign of life shared by downloads that run side by side: bytes arriving for any of them count
 * as progress for all of them (see download()).
 * @returns {{beat: () => void, on: (fn: () => void) => () => void}}
 */
export function createPulse() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    beat() {
      for (const fn of [...listeners]) fn();
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Download a file's bytes. Unlike request() there is no deadline for the whole exchange: a slow
 * connection that keeps delivering is left to finish, because cutting it off at a fixed time throws
 * away everything received so far and the retry starts from zero on the same slow connection.
 * What ends a download early:
 *  - no bytes at all (headers included) for `idleMs`      → SourceError 'timeout'
 *  - still not finished after `totalMs` (a backstop)      → SourceError 'timeout'
 *  - more than `maxBytes` arriving or announced           → SourceError 'too-large'
 *  - the caller's signal                                  → AbortError
 * A response that is not 2xx is returned without its body.
 *
 * `pulse`: downloads that run at the same time should share one (createPulse()). Over HTTP/2 a
 * server sends parallel responses largely one after the other, so on a slow connection the second
 * and third file get nothing — not even headers — until the first is through (measured 2026-10 on
 * a real 240 kbit/s link: 17 s of nothing, then the file). That is waiting in line, not a dead
 * connection. With a shared pulse "no bytes for idleMs" means no bytes for any of them.
 *
 * Where the body cannot be read as a stream, progress is invisible and only `totalMs` applies
 * once the headers are in.
 * @param {string} url
 * @param {{signal?: AbortSignal, idleMs?: number, totalMs?: number, maxBytes?: number,
 *          pulse?: ReturnType<typeof createPulse>, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{status: number, ok: boolean, body: ArrayBuffer | null}>}
 */
export async function download(url, opts = {}) {
  const { signal, idleMs = 15000, totalMs = 120000, maxBytes = Infinity, pulse, fetchImpl = globalThis.fetch } = opts;
  throwIfAborted(signal);
  const ctrl = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    ctrl.abort();
  };
  let idleTimer = setTimeout(expire, idleMs);
  const totalTimer = setTimeout(expire, totalMs);
  let watching = true;
  const alive = () => {
    if (!watching) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, idleMs);
  };
  const unlisten = pulse ? pulse.on(alive) : null;
  const progress = pulse ? pulse.beat : alive; // my bytes are everybody's sign of life
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const gone = whenAborted(ctrl.signal);
  try {
    const res = await Promise.race([fetchImpl(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }), gone.promise]);
    progress();
    if (!res.ok) {
      dropBody(res); // an error page: the status is all anyone wants
      return { status: res.status, ok: false, body: null };
    }
    const bytes = await readChunks(res, { maxBytes, onChunk: progress, gone: gone.promise, url });
    if (bytes) return { status: res.status, ok: true, body: /** @type {ArrayBuffer} */ (bytes.buffer) };
    watching = false; // nothing to watch from here on; totalTimer still runs
    clearTimeout(idleTimer);
    const whole = await Promise.race([res.arrayBuffer(), gone.promise]);
    if (whole.byteLength > maxBytes) throw tooLarge(url, maxBytes);
    progress();
    return { status: res.status, ok: true, body: whole };
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    if (timedOut) throw new SourceError('timeout', 'The download stalled.', { cause: err, detail: url });
    throw err;
  } finally {
    watching = false;
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (unlisten) unlisten();
    if (signal) signal.removeEventListener('abort', onAbort);
    gone.off();
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

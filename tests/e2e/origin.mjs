// Serve the repo under the app's real origin inside a puppeteer page (SPEC.md §6.6).
//
// Why: YouTube decides per embedding origin. Label music that plays on https://aarushkandukoori.github.io
// answers error 150 on http://127.0.0.1, so full-song tests must run the page AS the real site. Request
// interception answers every request under `origin + base` from the files on disk and lets everything
// else (YouTube, relays, fonts) through to the real network.
//
//   import { serveAsOrigin } from './origin.mjs';
//   const site = await serveAsOrigin(page);                       // https://aarushkandukoori.github.io/segue/
//   await page.goto(site.url('tests/e2e/ytdeck-harness.html'));
//   ...; await site.close();
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const DEFAULT_ORIGIN = 'https://aarushkandukoori.github.io';
export const DEFAULT_BASE = '/segue/';

/** The same map as serve.mjs (which does not export it and is frozen); ytdeck.e2e.mjs checks they agree. */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Map a URL path under `base` to a file inside `root`, or null when it would leave the repo.
 * Pure apart from the file system checks; exported for the e2e's own sanity checks.
 * @param {string} pathname  URL pathname (still percent-encoded)
 * @param {{base?: string, root?: string}} [opts]
 * @returns {Promise<{file: string, status: 200}|{file: null, status: 403|404}>}
 */
export async function resolveFile(pathname, { base = DEFAULT_BASE, root = ROOT } = {}) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return { file: null, status: 404 };
  }
  if (!rel.startsWith(base) || rel.includes('\0')) return { file: null, status: 404 };
  rel = rel.slice(base.length);
  let file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return { file: null, status: 403 };
  let info = await stat(file).catch(() => null);
  if (info && info.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info || !info.isFile()) return { file: null, status: 404 };
  // A symlink inside the repo must not lead out of it either.
  const real = await realpath(file).catch(() => null);
  const realRoot = await realpath(root).catch(() => root);
  if (!real || (real !== realRoot && !real.startsWith(realRoot + sep))) return { file: null, status: 403 };
  return { file, status: 200 };
}

/**
 * Answer every request under origin + base from the repo on disk (no-store, serve.mjs's MIME types,
 * 404 for missing files, 403 for anything that would leave the repo) and let every other request through.
 * Call before page.goto(). Works with any puppeteer page that supports request interception.
 * @param {import('puppeteer-core').Page} page
 * @param {{origin?: string, base?: string, root?: string}} [opts]
 * @returns {Promise<{prefix: string, url: (path?: string) => string, served: {url: string, status: number}[],
 *   close: (opts?: {timeoutMs?: number}) => Promise<boolean>}>}   close() resolves false when it gave up waiting
 */
export async function serveAsOrigin(page, { origin = DEFAULT_ORIGIN, base = DEFAULT_BASE, root = ROOT } = {}) {
  const o = new URL(origin);
  if (o.origin !== origin.replace(/\/$/, '')) throw new TypeError(`serveAsOrigin: origin must be a bare origin, got ${origin}`);
  if (!base.startsWith('/') || !base.endsWith('/')) throw new TypeError(`serveAsOrigin: base must start and end with "/", got ${base}`);
  const prefix = o.origin + base;
  /** @type {{url: string, status: number}[]} */
  const served = [];

  /** @param {import('puppeteer-core').HTTPRequest} req */
  const handler = async (req) => {
    if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
    const url = req.url();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return req.continue().catch(() => {});
    }
    if (parsed.origin !== o.origin || !parsed.pathname.startsWith(base)) return req.continue().catch(() => {});
    const answer = (status, contentType, body) => {
      served.push({ url, status });
      return req
        .respond({ status, contentType, headers: { 'cache-control': 'no-store' }, body })
        .catch(() => {});
    };
    const method = req.method();
    if (method !== 'GET' && method !== 'HEAD') return answer(405, 'text/plain', 'method not allowed');
    const hit = await resolveFile(parsed.pathname, { base, root });
    if (!hit.file) return answer(hit.status, 'text/plain', hit.status === 403 ? 'forbidden' : 'not found');
    const body = await readFile(hit.file).catch(() => null);
    if (!body) return answer(404, 'text/plain', 'not found');
    return answer(200, MIME[extname(hit.file).toLowerCase()] || 'application/octet-stream', method === 'HEAD' ? '' : body);
  };

  await page.setRequestInterception(true);
  page.on('request', handler);
  return {
    prefix,
    url: (path = '') => prefix + String(path).replace(/^\//, ''),
    served,
    /**
     * Stop intercepting. The handler stays attached until interception is really off, so no request
     * is left paused in between. Bounded: after a long YouTube session puppeteer has been seen to never
     * settle setRequestInterception(false) (a stale out-of-process ad frame, most likely); then the
     * handler simply stays on, which keeps answering correctly, and close() returns anyway.
     */
    close: async ({ timeoutMs = 3000 } = {}) => {
      let timer;
      const off = page.setRequestInterception(false).then(
        () => true,
        () => true,
      );
      const late = new Promise((r) => (timer = setTimeout(() => r(false), timeoutMs)));
      const done = await Promise.race([off, late]);
      clearTimeout(timer);
      if (done) page.off('request', handler);
      return done;
    },
  };
}

// Apple iTunes Search — the fallback when Deezer has no acceptable match. CORS is open, but the API
// allows only ~20 requests/minute per IP and answers 403/429 beyond that, so every request goes
// through one serial queue capped at 15 per rolling minute.

import { createLimiter } from './limiter.js';
import { SourceError, cleanText, httpsUrl, isAbort, request } from './util.js';

const API = 'https://itunes.apple.com/search';

/**
 * @typedef {Object} ItunesTrack
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {number} [durationMs]
 * @property {boolean} [explicit]
 * @property {string} preview   https .m4a
 * @property {string} [artwork]
 * @property {string} [link]
 */

/**
 * @param {any} r  one element of `results`
 * @returns {ItunesTrack | null}
 */
export function mapItunesResult(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.wrapperType && r.wrapperType !== 'track') return null;
  if (r.kind && r.kind !== 'song') return null;
  const id = String(r.trackId ?? '');
  if (!/^\d{1,20}$/.test(id)) return null;
  const preview = httpsUrl(r.previewUrl);
  const title = cleanText(r.trackName);
  if (!preview || !title) return null;
  /** @type {ItunesTrack} */
  const out = { id, title, artist: cleanText(r.artistName), preview };
  const ms = Number(r.trackTimeMillis);
  if (Number.isFinite(ms) && ms > 0) out.durationMs = ms;
  if (typeof r.trackExplicitness === 'string') out.explicit = r.trackExplicitness === 'explicit';
  // artworkUrl100 is a 100 px thumbnail; the same CDN path serves any size.
  const art = httpsUrl(typeof r.artworkUrl100 === 'string' ? r.artworkUrl100.replace(/\/100x100bb\.(jpg|png)$/, '/300x300bb.$1') : undefined);
  if (art) out.artwork = art;
  const link = httpsUrl(r.trackViewUrl);
  if (link) out.link = link;
  return out;
}

/**
 * @param {{fetchImpl?: typeof fetch, limiter?: ReturnType<typeof createLimiter>, timeoutMs?: number}} [cfg]
 */
export function createItunes(cfg = {}) {
  const limiter = cfg.limiter || createLimiter({ max: 15, windowMs: 60000, concurrency: 1, minGapMs: 1000 });
  const timeoutMs = cfg.timeoutMs || 9000;

  /**
   * @param {string} term
   * @param {{signal?: AbortSignal, limit?: number, maxWaitMs?: number}} [opts]  maxWaitMs: skip (SourceError 'busy') rather than queue longer
   * @returns {Promise<ItunesTrack[]>}
   */
  async function search(term, opts = {}) {
    const url = `${API}?term=${encodeURIComponent(term)}&media=music&entity=song&limit=${opts.limit || 8}`;
    const res = await limiter.schedule(
      async () => {
        try {
          return await request(url, { signal: opts.signal, timeoutMs, as: 'json', fetchImpl: cfg.fetchImpl });
        } catch (err) {
          if (isAbort(err)) throw err;
          throw new SourceError('unreachable', "Couldn't reach Apple's catalogue.", { cause: err, detail: term });
        }
      },
      { signal: opts.signal, maxWaitMs: opts.maxWaitMs },
    );
    if (res.status === 403 || res.status === 429) {
      limiter.pause(60000); // throttled: stay quiet for a minute
      throw new SourceError('unreachable', "Apple's catalogue is rate-limiting us.", { detail: `status ${res.status}` });
    }
    if (!res.ok || !res.body || !Array.isArray(res.body.results)) {
      throw new SourceError('bad-response', "Apple's catalogue sent an unexpected response.", { detail: `status ${res.status}` });
    }
    return res.body.results.map(mapItunesResult).filter(Boolean);
  }

  return { search, limiter };
}

let shared = null;
/** Process-wide client: the per-minute budget is per IP, so it must be shared. */
export function sharedItunes() {
  if (!shared) shared = createItunes();
  return shared;
}

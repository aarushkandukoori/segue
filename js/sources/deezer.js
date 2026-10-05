// Deezer: playlists / albums / genre charts (tracks arrive with their 30 s preview attached) and the
// track search the resolver uses. The API has no CORS headers, so browsers go through JSONP; Node
// (tests) uses plain fetch. Either way every call passes one shared rate limiter.

import { jsonp } from './jsonp.js';
import { createLimiter } from './limiter.js';
import { SourceError, UNKNOWN_ARTIST, cleanText, httpsUrl, isAbort, request, sleep, throwIfAborted } from './util.js';

const API = 'https://api.deezer.com';
export const DEEZER_MAX_TRACKS = 200;
const PAGE = 100;

/** Genre ids that /chart/<id>/tracks understands, with the names we show. */
export const CHART_GENRES = {
  0: 'Global Top 100',
  132: 'Pop',
  116: 'Hip-Hop',
  122: 'Reggaeton',
  152: 'Rock',
  113: 'Dance',
  165: 'R&B',
  85: 'Alternative',
  106: 'Electro',
  466: 'Folk',
  144: 'Reggae',
  129: 'Jazz',
  84: 'Country',
  464: 'Metal',
  169: 'Soul & Funk',
  2: 'Afro',
  16: 'K-Pop & Asian',
  75: 'Brazilian',
  81: 'Indian',
  197: 'Latin',
};

/**
 * @typedef {(url: string, opts: {signal?: AbortSignal, timeoutMs?: number}) => Promise<any>} DeezerTransport
 * Resolves with the decoded JSON payload of a Deezer API URL.
 */

/** Browser transport: JSONP (api.deezer.com only — enforced inside jsonp()). @type {DeezerTransport} */
export const jsonpTransport = (url, opts) => jsonp(url, opts);

/** Node / test transport: plain fetch. @type {DeezerTransport} */
export const fetchTransport = async (url, opts = {}) => {
  const res = await request(url, { signal: opts.signal, timeoutMs: opts.timeoutMs, as: 'json' });
  if (res.body === undefined) throw new SourceError('bad-response', 'Deezer sent an unexpected response.');
  return res.body;
};

function defaultTransport() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function' ? jsonpTransport : fetchTransport;
}

/**
 * Map a Deezer track object to TrackMeta. Returns null for tracks we cannot play (no preview,
 * readable=false) or that are malformed.
 * @param {any} t
 * @param {{artwork?: string}} [fallback]  album cover when the track object has none
 * @returns {import('./index.js').TrackMeta | null}
 */
export function mapDeezerTrack(t, fallback = {}) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id ?? '');
  if (!/^\d{1,20}$/.test(id) || id === '0') return null;
  if (t.readable === false) return null;
  const preview = httpsUrl(t.preview);
  if (!preview) return null;
  const title = cleanText(t.title) || cleanText(t.title_short);
  if (!title) return null;
  const album = t.album && typeof t.album === 'object' ? t.album : {};
  /** @type {import('./index.js').TrackMeta} */
  const meta = {
    id: `deezer:${id}`,
    title,
    artist: cleanText(t.artist && t.artist.name) || UNKNOWN_ARTIST,
    link: `https://www.deezer.com/track/${id}`,
    preview: { url: preview, provider: 'deezer', id },
  };
  const dur = Number(t.duration);
  if (Number.isFinite(dur) && dur > 0) meta.durationMs = Math.round(dur * 1000);
  if (typeof t.explicit_lyrics === 'boolean') meta.explicit = t.explicit_lyrics;
  const art = httpsUrl(album.cover_medium) || httpsUrl(album.cover_big) || fallback.artwork;
  if (art) meta.artwork = art;
  return meta;
}

/**
 * @param {{transport?: DeezerTransport, limiter?: ReturnType<typeof createLimiter>, timeoutMs?: number}} [cfg]
 */
export function createDeezer(cfg = {}) {
  const transport = cfg.transport || defaultTransport();
  // Deezer allows 50 requests per 5 s per IP. Stay well under: other tabs share the quota.
  const limiter = cfg.limiter || createLimiter({ max: 40, windowMs: 5000, concurrency: 6 });
  const timeoutMs = cfg.timeoutMs || 9000;

  /**
   * One API call. Deezer reports errors as HTTP 200 + {error:{code}}: 4 = quota (wait and retry),
   * 800 = no data (not found), 200/300 = needs login (private).
   * @param {string} path  "/playlist/123" or "/search?q=…"
   * @param {{signal?: AbortSignal}} [opts]
   */
  async function get(path, opts = {}) {
    const url = API + path;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(opts.signal);
      let data;
      try {
        data = await limiter.schedule(() => transport(url, { signal: opts.signal, timeoutMs }), { signal: opts.signal });
      } catch (err) {
        if (isAbort(err)) throw err;
        if (attempt < 1) {
          await sleep(400, opts.signal);
          continue; // one retry for a flaky network / timeout
        }
        // The JSONP transport's own 'unreachable' is a bare "Could not reach Deezer." — replace it with
        // the message that tells the user what to do; any other typed error already says it.
        if (err instanceof SourceError && err.code !== 'unreachable') throw err;
        throw new SourceError('unreachable', "Couldn't reach Deezer — check your connection and try again.", { cause: err, detail: path });
      }
      const error = data && data.error;
      if (error) {
        const code = Number(error.code);
        if (code === 4 && attempt < 3) {
          limiter.pause(1500);
          await sleep(1500, opts.signal);
          continue;
        }
        if (code === 800 || code === 200 || code === 300) {
          throw new SourceError('not-found', "That Deezer link is private or doesn't exist.", { detail: `${path} code ${code}` });
        }
        throw new SourceError('unreachable', "Deezer couldn't answer that — try again in a moment.", { detail: `${path} code ${code}` });
      }
      if (!data || typeof data !== 'object') throw new SourceError('bad-response', 'Deezer sent an unexpected response.', { detail: path });
      return data;
    }
  }

  /**
   * Follow a list endpoint ("?index=&limit=" + "next") until `want` playable tracks are collected.
   * `next` comes from the network, so only its presence is trusted — the URL is rebuilt locally.
   */
  async function collect(basePath, seed, want, fallback, opts) {
    const tracks = [];
    const seen = new Set();
    let scanned = 0;
    const take = (list) => {
      for (const raw of Array.isArray(list) ? list : []) {
        scanned++;
        const meta = mapDeezerTrack(raw, fallback);
        if (!meta || seen.has(meta.id)) continue;
        seen.add(meta.id);
        if (tracks.length < want) tracks.push(meta);
      }
    };
    take(seed.data);
    let more = seed.more;
    // Hard stop on pages too, so a server that always says "next" cannot loop us forever.
    for (let page = 0; more && tracks.length < want && page < 8; page++) {
      const data = await get(`${basePath}?index=${scanned}&limit=${PAGE}`, opts);
      const before = scanned;
      take(data.data);
      more = typeof data.next === 'string' && scanned > before;
    }
    return tracks;
  }

  /** @returns {Promise<import('./index.js').Playlist>} */
  async function loadPlaylist(id, opts = {}) {
    const p = await get(`/playlist/${id}`, opts);
    const inline = p.tracks && Array.isArray(p.tracks.data) ? p.tracks.data : [];
    const total = Number(p.nb_tracks) || inline.length;
    const tracks = await collect(`/playlist/${id}/tracks`, { data: inline, more: inline.length < total }, DEEZER_MAX_TRACKS, {}, opts);
    return finish(
      {
        id: `deezer:playlist:${id}`,
        source: 'deezer',
        title: cleanText(p.title) || 'Deezer playlist',
        subtitle: cleanText(p.creator && p.creator.name) || undefined,
        link: `https://www.deezer.com/playlist/${id}`,
        artwork: httpsUrl(p.picture_big) || httpsUrl(p.picture_medium),
        tracks,
      },
      total,
    );
  }

  /** @returns {Promise<import('./index.js').Playlist>} */
  async function loadAlbum(id, opts = {}) {
    const a = await get(`/album/${id}`, opts);
    const cover = httpsUrl(a.cover_medium) || httpsUrl(a.cover_big);
    const inline = a.tracks && Array.isArray(a.tracks.data) ? a.tracks.data : [];
    const total = Number(a.nb_tracks) || inline.length;
    // /album/<id> inlines only the first 25 tracks.
    const tracks = await collect(`/album/${id}/tracks`, { data: inline, more: inline.length < total }, DEEZER_MAX_TRACKS, { artwork: cover }, opts);
    return finish(
      {
        id: `deezer:album:${id}`,
        source: 'deezer',
        title: cleanText(a.title) || 'Deezer album',
        subtitle: cleanText(a.artist && a.artist.name) || undefined,
        link: `https://www.deezer.com/album/${id}`,
        artwork: httpsUrl(a.cover_big) || cover,
        tracks,
      },
      total,
    );
  }

  /** @returns {Promise<import('./index.js').Playlist>} */
  async function loadChart(id, opts = {}) {
    const data = await get(`/chart/${id}/tracks?limit=${PAGE}`, opts);
    const tracks = await collect(`/chart/${id}/tracks`, { data: data.data, more: false }, DEEZER_MAX_TRACKS, {}, opts);
    const genre = CHART_GENRES[id];
    return finish(
      {
        id: `deezer:chart:${id}`,
        source: 'deezer',
        title: genre ? (String(id) === '0' ? genre : `${genre} — Top 100`) : 'Deezer chart',
        subtitle: 'Deezer chart · updated daily',
        link: 'https://www.deezer.com/channels/charts',
        artwork: tracks[0] && tracks[0].artwork,
        tracks,
      },
      tracks.length,
    );
  }

  function finish(playlist, total) {
    if (!playlist.tracks.length) {
      throw new SourceError('empty', 'Nothing playable in there — Deezer has no previews for those tracks.', { detail: playlist.id });
    }
    for (const k of Object.keys(playlist)) if (playlist[k] === undefined) delete playlist[k];
    if (total > playlist.tracks.length) playlist.total = total;
    return playlist;
  }

  /**
   * Track search. Returns raw Deezer track objects (possibly empty).
   * @param {string} query @param {{signal?: AbortSignal, limit?: number}} [opts]
   */
  async function search(query, opts = {}) {
    const data = await get(`/search?q=${encodeURIComponent(query)}&limit=${opts.limit || 10}`, opts);
    return Array.isArray(data.data) ? data.data : [];
  }

  /** Fresh copy of one track (used to renew an expired preview URL). */
  function track(id, opts = {}) {
    return get(`/track/${encodeURIComponent(String(id))}`, opts);
  }

  return { get, search, track, loadPlaylist, loadAlbum, loadChart };
}

let shared = null;
/** Process-wide client so the playlist loaders and the resolver share one quota. */
export function sharedDeezer() {
  if (!shared) shared = createDeezer();
  return shared;
}

/**
 * @param {{type: 'playlist'|'album'|'chart', id: string}} ref
 * @param {{signal?: AbortSignal, onStatus?: (msg: string) => void, deezer?: ReturnType<typeof createDeezer>}} [opts]
 * @returns {Promise<import('./index.js').Playlist>}
 */
export function loadDeezer(ref, opts = {}) {
  const dz = opts.deezer || sharedDeezer();
  const say = opts.onStatus || (() => {});
  if (!/^\d{1,20}$/.test(String(ref.id))) {
    return Promise.reject(new SourceError('unsupported', "That doesn't look like a Deezer link."));
  }
  if (ref.type === 'chart') {
    say('Loading the chart from Deezer…');
    return dz.loadChart(ref.id, opts);
  }
  if (ref.type === 'album') {
    say('Reading album from Deezer…');
    return dz.loadAlbum(ref.id, opts);
  }
  say('Reading playlist from Deezer…');
  return dz.loadPlaylist(ref.id, opts);
}

// Spotify is used for the TRACK LIST ONLY. We read the public embed page (the thing an <iframe>
// would show) through CORS relays, pull out titles / artists / durations, and never touch Spotify
// audio: `audioPreview` and the embed's session token are deliberately never read, kept or exposed
// (Spotify's developer policy forbids mixing their audio — the sound comes from Deezer / iTunes).

import { SourceError, UNKNOWN_ARTIST, abortError, cleanText, httpsUrl, isAbort, request, throwIfAborted } from './util.js';

/** The embed page lists at most this many tracks, whatever the playlist's real length (measured 2026-10). */
export const SPOTIFY_EMBED_CAP = 100;
/**
 * The most tracks kept from one answer, like the other sources' caps. Today the embed never lists
 * more than SPOTIFY_EMBED_CAP; this is what stops a relay that answers with twenty thousand rows
 * from turning into twenty thousand catalogue lookups and setlist rows.
 */
export const SPOTIFY_MAX_TRACKS = 200;

// What comes back through a relay is somebody else's text. A real answer for a 100-track playlist
// is 50 kB as JSON and 150 kB as HTML (measured 2026-10); anything past these limits is dropped
// unread, and nothing below reads an answer with a pattern whose cost depends on what it says.
const MAX_RELAY_BYTES = 2 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024; // oEmbed and the song count are a few hundred bytes

const ID = /^[A-Za-z0-9]{22}$/;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const ATTEMPT_TIMEOUT_MS = 9000;
// If a relay has not answered after this long, the next one is started alongside it (the first
// valid answer wins). Keeps the worst case at a few seconds instead of a sum of timeouts.
const HEDGE_MS = 3500;

const embedUrl = (type, id) => `https://open.spotify.com/embed/${type}/${id}`;
const pageUrl = (type, id) => `https://open.spotify.com/${type}/${id}`;

/* ------------------------------------------------------------------ parsing (pure) */

const NEXT_DATA_ID = /\bid=["']__NEXT_DATA__["']/i;

/**
 * Pull the __NEXT_DATA__ JSON out of an HTML string without ever handing the HTML to the DOM.
 *
 * A left-to-right scan in which every character is looked at a bounded number of times: find a
 * "<script", find the ">" that ends that tag, look for the id in between, move on from the ">".
 * (One pattern for the whole thing — tag, attributes, id, body, closing tag — is shorter, and takes
 * minutes on 60 kB of unclosed "<script id=…" repeats: each of its three open-ended parts starts
 * over from every position the others stopped at.)
 */
export function nextDataFromHtml(html) {
  if (typeof html !== 'string') return null;
  const open = /<script\b/gi; // sticky state (lastIndex) is this call's own
  while (open.exec(html)) {
    const attrsAt = open.lastIndex;
    const tagEnd = html.indexOf('>', attrsAt);
    if (tagEnd < 0) return null; // no tag is closed from here on
    if (!NEXT_DATA_ID.test(html.slice(attrsAt, tagEnd))) {
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const close = /<\/script>/gi;
    close.lastIndex = tagEnd + 1;
    const end = close.exec(html);
    return end ? parseJson(html.slice(tagEnd + 1, end.index)) : null;
  }
  return null;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Classify a parsed __NEXT_DATA__ object.
 * @returns {{kind: 'entity', entity: any} | {kind: 'not-found'} | {kind: 'bad', reason: string}}
 */
export function readNextData(nd) {
  const pageProps = nd && nd.props && nd.props.pageProps;
  if (!pageProps || typeof pageProps !== 'object') return { kind: 'bad', reason: 'no pageProps' };
  const entity = pageProps.state && pageProps.state.data && pageProps.state.data.entity;
  if (entity && typeof entity === 'object' && Array.isArray(entity.trackList)) return { kind: 'entity', entity };
  // Spotify's own "Page not found" page, or an entity that carries no track list at all.
  if (pageProps.status === 404 || entity) return { kind: 'not-found' };
  return { kind: 'bad', reason: `status ${pageProps.status ?? 'unknown'}` };
}

/** "KAROL G, Judeline , rusowsky" → "KAROL G, Judeline, rusowsky" */
function cleanArtists(value) {
  return cleanText(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Embed entity → Playlist. Builds fresh objects from a whitelist of fields, so nothing else in the
 * embed payload (audio previews, tokens) can leak through. Keeps the first SPOTIFY_MAX_TRACKS songs.
 * @param {any} entity
 * @param {{type: 'playlist'|'album', id: string}} ref
 * @returns {{playlist: import('./index.js').Playlist, rawCount: number, found: number}}
 *          rawCount = rows in the embed's list, found = songs among them (≥ playlist.tracks.length)
 */
export function playlistFromEntity(entity, ref) {
  const cover =
    httpsUrl(entity.coverArt && entity.coverArt.sources && entity.coverArt.sources[0] && entity.coverArt.sources[0].url) ||
    pickImage(entity.visualIdentity && entity.visualIdentity.image);
  const tracks = [];
  const seen = new Set();
  const list = Array.isArray(entity.trackList) ? entity.trackList : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const m = TRACK_URI.exec(typeof raw.uri === 'string' ? raw.uri : '');
    if (!m) continue; // podcast episodes, local files
    const title = cleanText(raw.title);
    if (!title) continue;
    const id = `spotify:track:${m[1]}`;
    if (seen.has(id)) continue; // the same song added twice
    seen.add(id);
    if (tracks.length >= SPOTIFY_MAX_TRACKS) continue; // counted (seen.size) so the caller can say "first N of M", not kept
    /** @type {import('./index.js').TrackMeta} */
    const meta = {
      id,
      title,
      artist: cleanArtists(raw.subtitle) || UNKNOWN_ARTIST,
      link: `https://open.spotify.com/track/${m[1]}`,
    };
    const ms = Number(raw.duration);
    if (Number.isFinite(ms) && ms > 0) meta.durationMs = Math.round(ms);
    if (typeof raw.isExplicit === 'boolean') meta.explicit = raw.isExplicit;
    if (ref.type === 'album' && cover) meta.artwork = cover; // one cover for the whole album
    tracks.push(meta);
  }
  /** @type {import('./index.js').Playlist} */
  const playlist = {
    id: `spotify:${ref.type}:${ref.id}`,
    source: 'spotify',
    title: cleanText(entity.title) || cleanText(entity.name) || (ref.type === 'album' ? 'Spotify album' : 'Spotify playlist'),
    link: pageUrl(ref.type, ref.id),
    tracks,
  };
  const subtitle = cleanText(entity.subtitle);
  if (subtitle) playlist.subtitle = subtitle;
  if (cover) playlist.artwork = cover;
  return { playlist, rawCount: list.length, found: seen.size };
}

function pickImage(images) {
  if (!Array.isArray(images)) return undefined;
  // Prefer ~300 px; fall back to whatever is there.
  const sorted = images
    .filter((i) => i && httpsUrl(i.url))
    .sort((a, b) => Math.abs((a.maxWidth || 0) - 300) - Math.abs((b.maxWidth || 0) - 300));
  return sorted.length ? httpsUrl(sorted[0].url) : undefined;
}

// The markdown parser reads line by line. Each line is trimmed and cut to MD_MAX_LINE before any
// pattern sees it, the patterns have nothing left to try twice (no optional space at either end,
// and the capture runs to the end of the line whatever is in it), and only MD_MAX_LINES lines are
// looked at — a real 100-track page has about 700 lines of under 100 characters.
const MD_MAX_LINES = 20000;
const MD_MAX_LINE = 400;
const MD_LINE_BREAK = /\r?\n/;
const MD_TRACK = /^\d+\.\s+#{2,4}\s+([\s\S]+)$/;
const MD_ITEM = /^\d+\.\s+#{2,4}(?:\s|$)/; // any numbered heading, titled or not
const MD_ARTIST = /^#{3,5}\s+([\s\S]+)$/;
const MD_DURATION = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
const MD_NOT_FOUND = /^#{1,3}\s*Page not found$/i;
const MD_TITLE = /^Title:/;
const MD_TITLE_SUFFIX = /\s*[-|]\s*Spotify(?:\s*\|\s*Spotify)?$/i;

const mdLine = (raw) => {
  const line = raw.trim();
  return line.length > MD_MAX_LINE ? line.slice(0, MD_MAX_LINE).trimEnd() : line;
};

/**
 * Last-resort parser for the markdown rendering of the embed page (r.jina.ai without the HTML header):
 *
 *     1.   ### Title
 *
 *     #### E Artist,Artist        ("E " = explicit badge)
 *
 *     03:45
 *
 * No track ids in this format, so ids are "spotify:md:<n>" and tracks have no link.
 * Keeps the first SPOTIFY_MAX_TRACKS songs; `found` counts all of them.
 * @param {string} md
 * @param {{type: 'playlist'|'album', id: string}} ref
 * @returns {{kind: 'playlist', playlist: import('./index.js').Playlist, rawCount: number, found: number} | {kind: 'not-found'} | {kind: 'bad'}}
 */
export function playlistFromMarkdown(md, ref) {
  if (typeof md !== 'string' || !md) return { kind: 'bad' };
  const lines = md.split(MD_LINE_BREAK, MD_MAX_LINES).map(mdLine);
  if (lines.some((line) => MD_NOT_FOUND.test(line))) return { kind: 'not-found' };
  let title = '';
  const head = lines.find((line) => MD_TITLE.test(line));
  if (head) title = cleanText(head.slice(6).replace(MD_TITLE_SUFFIX, ''));
  const tracks = [];
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = MD_TRACK.exec(lines[i]);
    if (!t) continue;
    const name = cleanText(t[1]);
    if (!name) continue;
    found++;
    if (tracks.length >= SPOTIFY_MAX_TRACKS) continue;
    let artist = '';
    let explicit = false;
    let durationMs;
    // The artist heading and the duration follow within a few lines, before the next numbered item.
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      if (MD_ITEM.test(lines[j])) break;
      const a = MD_ARTIST.exec(lines[j]);
      if (a && !artist) {
        let text = a[1];
        if (/^E\s+\S/.test(text)) {
          explicit = true;
          text = text.replace(/^E\s+/, '');
        }
        artist = cleanArtists(text);
        continue;
      }
      const d = MD_DURATION.exec(lines[j]);
      if (d) {
        durationMs = ((Number(d[1] || 0) * 60 + Number(d[2])) * 60 + Number(d[3])) * 1000;
        break;
      }
    }
    /** @type {import('./index.js').TrackMeta} */
    const meta = { id: `spotify:md:${tracks.length}`, title: name, artist: artist || UNKNOWN_ARTIST, explicit };
    if (durationMs) meta.durationMs = durationMs;
    tracks.push(meta);
  }
  if (!tracks.length) return { kind: 'bad' };
  return {
    kind: 'playlist',
    rawCount: found,
    found,
    playlist: {
      id: `spotify:${ref.type}:${ref.id}`,
      source: 'spotify',
      title: title || (ref.type === 'album' ? 'Spotify album' : 'Spotify playlist'),
      link: pageUrl(ref.type, ref.id),
      tracks,
    },
  };
}

/* ------------------------------------------------------------------ relays */

/**
 * @typedef {Object} Relay
 * @property {string} name
 * @property {(target: string) => {url: string, headers?: Record<string,string>, as: 'json'|'text'}} build
 * @property {(body: any) => any} extract   response body → parsed __NEXT_DATA__ object (or null)
 */

/** The three relays, in the order they are tried. @type {Relay[]} */
export const RELAYS = [
  {
    name: 'scraper',
    build: (target) => ({
      url: `https://web.scraper.workers.dev/?url=${encodeURIComponent(target)}&selector=${encodeURIComponent('script#__NEXT_DATA__')}&scrape=text`,
      as: 'json',
    }),
    extract: (body) => {
      const hit = body && body.result && body.result['script#__NEXT_DATA__'];
      return parseJson(Array.isArray(hit) ? hit[0] : hit);
    },
  },
  {
    name: 'jina',
    build: (target) => ({ url: `https://r.jina.ai/${target}`, headers: { 'X-Return-Format': 'html' }, as: 'text' }),
    extract: (body) => nextDataFromHtml(body),
  },
  {
    name: 'microlink',
    build: (target) => ({
      url: `https://api.microlink.io/?url=${encodeURIComponent(target)}&data.next.selector=%23__NEXT_DATA__&data.next.attr=text`,
      as: 'json',
    }),
    extract: (body) => {
      const next = body && body.status === 'success' && body.data && body.data.next;
      return typeof next === 'string' ? parseJson(next) : next && typeof next === 'object' ? next : null;
    },
  },
];

/**
 * One relay, one try.
 * @returns {Promise<{kind: 'playlist', playlist: import('./index.js').Playlist, rawCount: number, found: number, via: string}
 *                 | {kind: 'not-found', via: string} | {kind: 'empty', via: string} | {kind: 'fail', via: string, reason: string}>}
 *          reason: 'timeout', 'too-large', 'network', 'http 502', … (for the log)
 */
export async function tryRelay(relay, ref, opts = {}) {
  const req = relay.build(embedUrl(ref.type, ref.id));
  let res;
  try {
    res = await request(req.url, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs || ATTEMPT_TIMEOUT_MS,
      headers: req.headers,
      as: req.as,
      maxBytes: MAX_RELAY_BYTES,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    return { kind: 'fail', via: relay.name, reason: err instanceof SourceError ? err.code : 'network' };
  }
  if (!res.ok) return { kind: 'fail', via: relay.name, reason: `http ${res.status}` };
  const read = readNextData(relay.extract(res.body));
  if (read.kind === 'not-found') return { kind: 'not-found', via: relay.name };
  if (read.kind === 'bad') return { kind: 'fail', via: relay.name, reason: read.reason };
  const entity = read.entity;
  // A relay must answer for the playlist we asked about (guards against a stale/wrong cached page).
  if (typeof entity.id === 'string' && entity.id !== ref.id) return { kind: 'fail', via: relay.name, reason: 'wrong entity' };
  const { playlist, rawCount, found } = playlistFromEntity(entity, ref);
  if (!playlist.tracks.length) return { kind: 'empty', via: relay.name };
  return { kind: 'playlist', playlist, rawCount, found, via: relay.name };
}

/** Markdown rendering via r.jina.ai — independent of the __NEXT_DATA__ format. */
export async function tryMarkdown(ref, opts = {}) {
  let res;
  try {
    res = await request(`https://r.jina.ai/${embedUrl(ref.type, ref.id)}`, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs || ATTEMPT_TIMEOUT_MS,
      as: 'text',
      maxBytes: MAX_RELAY_BYTES,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    return { kind: 'fail', via: 'jina-markdown', reason: err instanceof SourceError ? err.code : 'network' };
  }
  if (!res.ok) return { kind: 'fail', via: 'jina-markdown', reason: `http ${res.status}` };
  const parsed = playlistFromMarkdown(res.body, ref);
  if (parsed.kind === 'bad') return { kind: 'fail', via: 'jina-markdown', reason: 'no tracks in markdown' };
  return { ...parsed, via: 'jina-markdown' };
}

/**
 * Ask Spotify itself (oEmbed has CORS) whether the thing exists publicly. A 404 from oEmbed carries
 * no CORS header, so in a browser "missing" and "offline" both surface as a network error — only a
 * positive answer is conclusive.
 * @returns {Promise<{title?: string, artwork?: string} | null>}  null = not confirmed
 */
export async function spotifyOEmbed(ref, opts = {}) {
  try {
    const res = await request(`https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl(ref.type, ref.id))}`, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs || 3000,
      as: 'json',
      maxBytes: MAX_META_BYTES,
      fetchImpl: opts.fetchImpl,
    });
    if (!res.ok || !res.body || typeof res.body !== 'object') return null;
    return { title: cleanText(res.body.title) || undefined, artwork: httpsUrl(res.body.thumbnail_url) };
  } catch (err) {
    if (isAbort(err) && opts.signal && opts.signal.aborted) throw err;
    return null;
  }
}

/**
 * Real track count of a playlist (the embed stops at 100). Read from the public page's
 * <meta name="music:song_count"> through relay 1. Best effort: undefined when it cannot be had quickly.
 */
export async function spotifyTrackCount(ref, opts = {}) {
  const selector = 'meta[name="music:song_count"]';
  const url = `https://web.scraper.workers.dev/?url=${encodeURIComponent(pageUrl(ref.type, ref.id))}&selector=${encodeURIComponent(selector)}&scrape=attr&attr=content`;
  try {
    const res = await request(url, { signal: opts.signal, timeoutMs: opts.timeoutMs || 2500, as: 'json', maxBytes: MAX_META_BYTES, fetchImpl: opts.fetchImpl });
    const raw = res.ok && res.body ? res.body.result : undefined;
    const n = Number(typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : NaN);
    return Number.isInteger(n) && n > 0 && n < 1e6 ? n : undefined;
  } catch (err) {
    if (isAbort(err) && opts.signal && opts.signal.aborted) throw err;
    return undefined;
  }
}

/* ------------------------------------------------------------------ the chain */

/**
 * Run attempts in order, starting the next one when the current one fails — or when it has been
 * silent for `hedgeMs`. First conclusive answer (anything but 'fail') wins and the rest are aborted.
 * @template T
 * @param {((signal: AbortSignal) => Promise<T & {kind: string}>)[]} attempts
 * @param {{signal?: AbortSignal, hedgeMs?: number, onLaunch?: (index: number) => void}} [opts]
 * @returns {Promise<{result: (T & {kind: string}) | null, failures: any[]}>}
 */
export function hedgedChain(attempts, opts = {}) {
  const { signal, hedgeMs = HEDGE_MS, onLaunch } = opts;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    if (!attempts.length) return resolve({ result: null, failures: [] });
    const ctrl = new AbortController();
    const failures = [];
    let next = 0;
    let active = 0;
    let done = false;
    let hedge = null;

    const finish = (fn) => {
      if (done) return;
      done = true;
      if (hedge != null) clearTimeout(hedge);
      if (signal) signal.removeEventListener('abort', onAbort);
      ctrl.abort(); // stop the losers
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const launch = () => {
      if (done || next >= attempts.length) return;
      const index = next++;
      active++;
      if (hedge != null) clearTimeout(hedge);
      hedge = next < attempts.length && Number.isFinite(hedgeMs) ? setTimeout(launch, hedgeMs) : null;
      if (onLaunch) onLaunch(index);
      Promise.resolve()
        .then(() => attempts[index](ctrl.signal))
        .catch((err) => ({ kind: 'fail', reason: isAbort(err) ? 'aborted' : String((err && err.message) || err) }))
        .then((res) => {
          active--;
          if (done) return;
          if (res.kind !== 'fail') return finish(() => resolve({ result: res, failures }));
          failures.push(res);
          if (next < attempts.length) launch();
          else if (active === 0) finish(() => resolve({ result: null, failures }));
        });
    };
    launch();
  });
}

const NOT_FOUND_MESSAGE =
  "That playlist is private or doesn't exist. Spotify only shares public playlists — make it public, then paste the link again.";

/**
 * Load a Spotify playlist or album's track list.
 * @param {{type: 'playlist'|'album', id: string}} ref
 * @param {{signal?: AbortSignal, onStatus?: (msg: string) => void, fetchImpl?: typeof fetch,
 *          relays?: Relay[], hedgeMs?: number, timeoutMs?: number, markdown?: boolean}} [opts]
 * @returns {Promise<import('./index.js').Playlist>}
 */
export async function loadSpotify(ref, opts = {}) {
  const { signal } = opts;
  const say = opts.onStatus || (() => {});
  if (!ref || (ref.type !== 'playlist' && ref.type !== 'album') || !ID.test(ref.id)) {
    throw new SourceError('unsupported', "That doesn't look like a Spotify playlist link.");
  }
  throwIfAborted(signal);
  const thing = ref.type === 'album' ? 'album' : 'playlist';
  const relays = opts.relays || RELAYS;
  const common = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs };

  // A relay showing Spotify's 404 page is only believed if Spotify itself does not vouch for the
  // playlist — one check, shared by all attempts.
  let existsCheck = null;
  const existsPublicly = (sig) => (existsCheck ||= spotifyOEmbed(ref, { fetchImpl: opts.fetchImpl, signal: sig }));

  const attempts = relays.map((relay) => async (sig) => {
    const res = await tryRelay(relay, ref, { ...common, signal: sig });
    if (res.kind === 'not-found' && (await existsPublicly(signal))) {
      return { kind: 'fail', via: relay.name, reason: 'relay saw 404 but Spotify says it exists' };
    }
    return res;
  });

  say(`Reading ${thing} from Spotify…`);
  let { result, failures } = await hedgedChain(attempts, {
    signal,
    hedgeMs: opts.hedgeMs,
    onLaunch: (i) => {
      if (i > 0) say('Still reading — trying another route to Spotify…');
    },
  });

  if (!result && opts.markdown !== false) {
    say('Trying one more route to Spotify…');
    const md = await tryMarkdown(ref, { ...common, signal });
    if (md.kind === 'fail') failures.push(md);
    else if (md.kind === 'not-found' && (await existsPublicly(signal))) failures.push({ kind: 'fail', via: md.via, reason: 'markdown 404' });
    else {
      result = md;
      if (md.kind === 'playlist') {
        // Markdown has no cover and sometimes no usable title; oEmbed has both.
        const meta = await existsPublicly(signal);
        if (meta && meta.artwork) md.playlist.artwork = meta.artwork;
        if (meta && meta.title) md.playlist.title = meta.title;
      }
    }
  }
  throwIfAborted(signal);

  if (!result) {
    const detail = failures.map((f) => `${f.via || '?'}: ${f.reason}`).join('; ');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new SourceError('offline', "You're offline — reconnect and try again.", { detail });
    }
    throw new SourceError('unreachable', "Couldn't reach Spotify — try again in a moment.", { detail });
  }
  if (result.kind === 'not-found') throw new SourceError('not-found', NOT_FOUND_MESSAGE, { detail: `via ${result.via}` });
  if (result.kind === 'empty') throw new SourceError('empty', `That ${thing} has no songs in it yet.`, { detail: `via ${result.via}` });

  const { playlist, rawCount, found } = result;
  // More songs in the answer than were kept: say so even if the real count cannot be had.
  let total = found > playlist.tracks.length ? found : 0;
  if (rawCount >= SPOTIFY_EMBED_CAP) {
    // The embed stops at 100; find out how long the playlist really is.
    const real = await spotifyTrackCount(ref, { fetchImpl: opts.fetchImpl, signal });
    if (real && real > total) total = real;
  }
  if (total > playlist.tracks.length) playlist.total = total;
  return playlist;
}

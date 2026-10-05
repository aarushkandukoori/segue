// Track → audio. Given a TrackMeta (usually title + artist + duration from Spotify) find a 30-second
// preview of the SAME recording on Deezer, or failing that on iTunes, and fetch its bytes.
// Wrong matches are worse than no match: the scorer in match.js decides, this file does the I/O.

import { sharedDeezer } from './deezer.js';
import { sharedItunes } from './itunes.js';
import { localKey } from './local.js';
import { ACCEPT_SCORE, CONFIDENT_SCORE, artistScore, bestMatch, normalizeTitle, parseTitle, primaryArtist } from './match.js';
import { SourceError, UNKNOWN_ARTIST, abortError, cleanText, httpsUrl, isAbort, request, sleep, throwIfAborted } from './util.js';

/**
 * code:
 *  'no-match'  searched, nothing close enough to play
 *  'network'   could not reach any catalogue (worth retrying later)
 *  'no-audio'  the audio file itself could not be fetched
 *  'bad-track' the TrackMeta has no usable title / file
 */
export class ResolveError extends Error {
  /** @param {'no-match'|'network'|'no-audio'|'bad-track'} code @param {string} message @param {{cause?: unknown}} [opts] */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ResolveError';
    this.code = code;
    /** 'no-match' only: false when a catalogue could not be asked, i.e. a retry later might succeed. */
    this.final = true;
  }
}

const AUDIO_TIMEOUT_MS = 20000;
const MIN_AUDIO_BYTES = 2048; // anything smaller is an error page, not 30 s of audio
const PRECISE_OFF_MS = 10 * 60 * 1000;
const PRECISE_MISS_LIMIT = 2;
const SEARCH_LIMIT = 15;
const CACHE_MAX = 3000;
// iTunes lookups are serialised at 15/minute. A track that would wait longer than this for its turn
// is reported as unmatched instead (and not cached, so a later retry can still find it) — otherwise
// a playlist Deezer barely knows would stall the whole preparation pipeline behind the throttle.
const ITUNES_MAX_WAIT_MS = 30000;

/** Deezer search hit → scorer candidate. */
function deezerCandidate(t) {
  if (!t || typeof t !== 'object' || t.readable === false) return null;
  const id = String(t.id ?? '');
  const preview = httpsUrl(t.preview);
  const title = cleanText(t.title) || cleanText(t.title_short);
  if (!/^\d{1,20}$/.test(id) || !preview || !title) return null;
  const album = t.album && typeof t.album === 'object' ? t.album : {};
  const dur = Number(t.duration);
  return {
    provider: /** @type {'deezer'} */ ('deezer'),
    id,
    title,
    artist: cleanText(t.artist && t.artist.name),
    durationMs: Number.isFinite(dur) && dur > 0 ? dur * 1000 : undefined,
    explicit: typeof t.explicit_lyrics === 'boolean' ? t.explicit_lyrics : undefined,
    rank: Number(t.rank) || 0,
    url: preview,
    artwork: httpsUrl(album.cover_medium) || httpsUrl(album.cover_big),
    link: `https://www.deezer.com/track/${id}`,
  };
}

function itunesCandidate(t) {
  return { provider: /** @type {'itunes'} */ ('itunes'), id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, exactDuration: true, explicit: t.explicit, rank: 0, url: t.preview, artwork: t.artwork, link: t.link };
}

/** Accepted on "same artist, same length, title in another script" alone — a guess, not a title match. */
const isGuess = (m) => /(?:^| )translit(?: |$)/.test(m.detail.reason);

/** @returns {import('./index.js').AudioRef} */
function toRef(cand, score) {
  /** @type {import('./index.js').AudioRef} */
  const ref = {
    provider: cand.provider,
    key: `${cand.provider}:${cand.id}`,
    url: cand.url,
    isPreview: true,
    matchScore: Math.round(score * 1000) / 1000,
    matchedTitle: cand.title,
    matchedArtist: cand.artist,
  };
  if (cand.artwork) ref.artwork = cand.artwork;
  if (cand.link) ref.link = cand.link;
  if (cand.durationMs > 0) ref.matchedDurationMs = Math.round(cand.durationMs);
  return ref;
}

const quoteless = (s) => s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The Deezer queries to try for a track, in order. Later ones only run when the earlier ones did not
 * produce a confident match.
 *
 * Plain free text ("artist title") goes first: it is the form that works every day. Deezer's
 * advanced syntax (artist:"…" track:"…") is more exact when it works, but its artist: filter has
 * outages in which it matches nothing at all (observed 2026-10-05: every artist:"…" query came back
 * empty while free text was fine), so it is a second opinion, never the gatekeeper.
 * @param {{title: string, artist?: string}} track
 * @param {{precise?: boolean}} [opts]  precise:false leaves the artist:"…" form out (known dead)
 * @returns {{kind: 'loose'|'base'|'precise'|'title', q: string}[]}
 */
export function deezerQueries(track, opts = {}) {
  const info = parseTitle(track.title);
  const base = quoteless(info.baseRaw || cleanText(track.title));
  const version = quoteless(info.versionRaw);
  const first = quoteless(primaryArtist(track.artist || ''));
  const out = [];
  out.push({ kind: /** @type {const} */ ('loose'), q: [first, base, version].filter(Boolean).join(' ') });
  // "Artist Title PNAU Remix" finds nothing when Deezer words the version differently.
  if (version) out.push({ kind: /** @type {const} */ ('base'), q: [first, base].filter(Boolean).join(' ') });
  if (first && opts.precise !== false) out.push({ kind: /** @type {const} */ ('precise'), q: `artist:"${first}" track:"${base}"` });
  // Exact-phrase title with the artist as a hint: for artists Deezer spells differently.
  out.push({ kind: /** @type {const} */ ('title'), q: first ? `track:"${base}" ${first}` : `track:"${base}"` });
  const seen = new Set();
  return out.filter((s) => s.q && !seen.has(s.q) && seen.add(s.q));
}

/**
 * @param {{deezer?: ReturnType<typeof import('./deezer.js').createDeezer>,
 *          itunes?: ReturnType<typeof import('./itunes.js').createItunes>,
 *          fetchImpl?: typeof fetch, now?: () => number, useItunes?: boolean}} [cfg]
 */
export function createResolver(cfg = {}) {
  const deezer = cfg.deezer || sharedDeezer();
  const itunes = cfg.itunes || sharedItunes();
  const now = cfg.now || (() => Date.now());

  /** @type {Map<string, import('./index.js').AudioRef | ResolveError>} */
  const cache = new Map();
  /** @type {Map<string, {promise: Promise<any>, ctrl: AbortController, waiters: number}>} */
  const inflight = new Map();

  // Deezer's artist:"…" filter has outages where it matches nothing at all. When it comes back
  // empty for artists free text has just found, stop paying a request per track for it for a while.
  let preciseMisses = 0;
  let preciseOffUntil = 0;
  const stats = { deezer: 0, itunes: 0, noMatch: 0, requests: 0 };

  const remember = (key, value) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  };

  async function searchDeezer(wanted, signal) {
    const preciseOn = now() >= preciseOffUntil;
    const queries = deezerQueries(wanted, { precise: preciseOn });
    const pool = new Map();
    let best = null;
    let reached = false;
    let lastError = null;
    let artistSeen = false; // some free-text hit is by the wanted artist
    for (const { kind, q } of queries) {
      let hits;
      try {
        stats.requests++;
        hits = await deezer.search(q, { signal, limit: SEARCH_LIMIT });
        reached = true;
      } catch (err) {
        if (isAbort(err)) throw err;
        lastError = err;
        continue;
      }
      if (kind === 'precise') {
        // Empty although free text just found this very artist: the artist: filter is out of order.
        if (hits.length) preciseMisses = 0;
        else if (artistSeen && ++preciseMisses >= PRECISE_MISS_LIMIT) {
          preciseOffUntil = now() + PRECISE_OFF_MS;
          preciseMisses = 0;
        }
      }
      for (const h of hits) {
        const c = deezerCandidate(h);
        if (!c || pool.has(c.id)) continue;
        pool.set(c.id, c);
        if (!artistSeen && wanted.artist && artistScore(wanted.artist, c.artist) >= 0.85) artistSeen = true;
      }
      best = bestMatch(wanted, [...pool.values()]);
      if (best && best.score >= CONFIDENT_SCORE) break;
    }
    const accepted = best && best.score >= ACCEPT_SCORE ? best : null;
    return { accepted, best, reached, lastError };
  }

  async function searchItunes(wanted, signal) {
    const info = parseTitle(wanted.title);
    const term = [primaryArtist(wanted.artist || ''), info.baseRaw || wanted.title, info.versionRaw].filter(Boolean).join(' ');
    stats.requests++;
    const hits = await itunes.search(term, { signal, limit: 8, maxWaitMs: ITUNES_MAX_WAIT_MS });
    const best = bestMatch(wanted, hits.map(itunesCandidate));
    return best && best.score >= ACCEPT_SCORE ? best : null;
  }

  async function find(wanted, signal) {
    let dz = { accepted: null, best: null, reached: false, lastError: null };
    try {
      dz = await searchDeezer(wanted, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      dz.lastError = err;
    }
    // Deezer counts whole seconds, and for a title it cannot read it answers with the artist's most
    // popular songs — one of which may happen to have the right length. Such a guess is only kept
    // if iTunes (millisecond durations) lands on the same song.
    const guess = dz.accepted && isGuess(dz.accepted) ? dz.accepted : null;
    if (dz.accepted && !guess) {
      stats.deezer++;
      return toRef(dz.accepted.candidate, dz.accepted.score);
    }
    let itunesReached = false;
    let skipped = false;
    if (cfg.useItunes !== false) {
      try {
        const hit = await searchItunes(wanted, signal);
        itunesReached = true;
        if (hit) {
          if (guess && normalizeTitle(hit.candidate.title) === normalizeTitle(guess.candidate.title)) {
            stats.deezer++;
            return toRef(guess.candidate, guess.score);
          }
          stats.itunes++;
          return toRef(hit.candidate, hit.score);
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        skipped = true; // throttled, queue too long, or unreachable: this answer is not final
      }
    }
    if (!dz.reached && !itunesReached) {
      throw new ResolveError('network', "Couldn't reach the music catalogues.", { cause: dz.lastError });
    }
    return { miss: true, final: !skipped && dz.reached };
  }

  /** @param {import('./index.js').TrackMeta} track */
  async function resolveRemote(track, signal) {
    const artist = typeof track.artist === 'string' && track.artist !== UNKNOWN_ARTIST ? track.artist : '';
    const wanted = { title: track.title, artist, durationMs: track.durationMs, explicit: track.explicit };
    let found = await find(wanted, signal);
    // Pasted lines can be read two ways ("Title - Artist", "Stand by Me"); text.js supplies the
    // second reading and we try it before giving up.
    const alt = /** @type {any} */ (track).alt;
    if (found.miss && alt && typeof alt.title === 'string' && alt.title.trim()) {
      const second = await find({ title: alt.title, artist: typeof alt.artist === 'string' ? alt.artist : '', durationMs: track.durationMs }, signal);
      found = second.miss ? { miss: true, final: found.final && second.final } : second;
    }
    if (found.miss) {
      stats.noMatch++;
      const err = new ResolveError('no-match', `No preview found for “${track.title}”.`);
      err.final = found.final; // false: a catalogue was skipped, so asking again later may succeed
      throw err;
    }
    return found;
  }

  /** Run `work` once per key no matter how many callers ask; cancel it only when all of them left. */
  function share(key, work, signal) {
    let entry = inflight.get(key);
    if (!entry) {
      const ctrl = new AbortController();
      const created = { ctrl, waiters: 0, promise: /** @type {Promise<any>} */ (Promise.resolve()) };
      created.promise = work(ctrl.signal).finally(() => {
        if (inflight.get(key) === created) inflight.delete(key);
      });
      created.promise.catch(() => {}); // every waiter may already be gone
      inflight.set(key, created);
      entry = created;
    }
    const mine = entry;
    mine.waiters++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (--mine.waiters === 0) {
          mine.ctrl.abort();
          if (inflight.get(key) === mine) inflight.delete(key);
        }
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const done = () => signal && signal.removeEventListener('abort', onAbort);
      mine.promise.then(
        (v) => (done(), resolve(v)),
        (e) => (done(), reject(e)),
      );
    });
  }

  /**
   * @param {import('./index.js').TrackMeta} track
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<import('./index.js').AudioRef>}
   */
  async function resolveTrack(track, opts = {}) {
    const { signal } = opts;
    throwIfAborted(signal);
    if (!track || typeof track !== 'object') throw new ResolveError('bad-track', 'Not a track.');

    if (track.file) {
      return {
        provider: 'local',
        key: localKey(track.file),
        file: track.file,
        isPreview: false,
        matchScore: 1,
        matchedTitle: track.title || track.file.name,
        matchedArtist: track.artist || '',
      };
    }
    if (track.preview && track.preview.url) {
      const url = httpsUrl(track.preview.url);
      const provider = track.preview.provider === 'itunes' ? 'itunes' : 'deezer';
      if (url) {
        /** @type {import('./index.js').AudioRef} */
        const ref = { provider, key: `${provider}:${track.preview.id}`, url, isPreview: true, matchScore: 1, matchedTitle: track.title, matchedArtist: track.artist || '' };
        if (httpsUrl(track.artwork)) ref.artwork = track.artwork;
        if (httpsUrl(track.link)) ref.link = track.link;
        return ref;
      }
    }
    if (typeof track.title !== 'string' || !track.title.trim()) throw new ResolveError('bad-track', 'This track has no title.');

    const key = `${track.id}|${track.title}|${track.artist || ''}`;
    const hit = cache.get(key);
    if (hit) {
      if (hit instanceof ResolveError) throw hit;
      return hit;
    }
    return share(
      key,
      async (sig) => {
        try {
          const ref = await resolveRemote(track, sig);
          remember(key, ref);
          return ref;
        } catch (err) {
          if (err instanceof ResolveError && err.code === 'no-match' && err.final !== false) remember(key, err);
          throw err;
        }
      },
      signal,
    );
  }

  /** Signed Deezer preview URLs carry their expiry ("…?hdnea=exp=1791185773~…"), ~15 min after issue. */
  function expired(url) {
    const m = /[?&~=]exp=(\d{9,11})/.exec(url);
    return !!m && Number(m[1]) * 1000 < now() + 10000;
  }

  /** Get a fresh signed URL for a Deezer ref (mutates the ref so every holder sees it). */
  async function renew(ref, signal) {
    const id = ref.key.replace(/^deezer:/, '');
    let t;
    try {
      t = await deezer.track(id, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ResolveError(err instanceof SourceError && err.code === 'not-found' ? 'no-audio' : 'network', 'Could not renew the preview link.', { cause: err });
    }
    const url = httpsUrl(t && t.preview);
    if (!url) throw new ResolveError('no-audio', 'Deezer no longer has a preview for this track.');
    ref.url = url;
    const bpm = Number(t.bpm);
    if (bpm > 0) ref.bpmHint = bpm;
  }

  /**
   * @param {import('./index.js').AudioRef} ref
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<ArrayBuffer>}
   */
  async function fetchAudio(ref, opts = {}) {
    const { signal } = opts;
    throwIfAborted(signal);
    if (!ref || typeof ref !== 'object') throw new ResolveError('no-audio', 'Nothing to fetch.');
    if (ref.file) {
      try {
        const bytes = await ref.file.arrayBuffer();
        throwIfAborted(signal);
        return bytes;
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new ResolveError('no-audio', `Couldn't read “${ref.file.name}”.`, { cause: err });
      }
    }
    const isDeezer = ref.provider === 'deezer';
    let renewed = false;
    if (isDeezer && typeof ref.url === 'string' && expired(ref.url)) {
      await renew(ref, signal);
      renewed = true;
    }
    for (let tries = 1; ; tries++) {
      const url = httpsUrl(ref.url);
      if (!url) throw new ResolveError('no-audio', 'This track has no playable address.');
      let res = null;
      let failure = null;
      try {
        res = await request(url, { signal, timeoutMs: AUDIO_TIMEOUT_MS, as: 'arrayBuffer', fetchImpl: cfg.fetchImpl });
      } catch (err) {
        if (isAbort(err)) throw err;
        failure = err;
      }
      if (res && res.ok && res.body && res.body.byteLength > MIN_AUDIO_BYTES) return res.body;
      // A Deezer link that stopped working has most likely outlived its signature. A browser often
      // cannot see the 403: the CDN's error page carries no CORS header, so it surfaces as a bare
      // network error. Either way: get a fresh link once and go again.
      const maybeExpired = !res || res.status === 403 || res.status === 410 || res.status === 404;
      if (isDeezer && !renewed && maybeExpired) {
        await renew(ref, signal);
        renewed = true;
        continue;
      }
      if (!res && tries < 2) {
        await sleep(300, signal);
        continue; // one retry for a dropped connection
      }
      if (!res) throw new ResolveError('network', 'The audio download failed.', { cause: failure });
      throw new ResolveError('no-audio', `The audio download failed (${res.status}).`);
    }
  }

  return {
    resolveTrack,
    fetchAudio,
    /** Counters for diagnostics: how many tracks each catalogue served. */
    stats: () => ({ ...stats, cached: cache.size, preciseEnabled: now() >= preciseOffUntil }),
  };
}

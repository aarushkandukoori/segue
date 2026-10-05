// Sources: turn what the user pasted / dropped into a Playlist.
// (Turning a track into audio bytes lives in resolver.js.)

import { loadDeezer } from './deezer.js';
import { loadSpotify } from './spotify.js';
import { parseTextLine, playlistFromText } from './text.js';
import { SourceError, throwIfAborted } from './util.js';

export { playlistFromFiles, applyTags } from './local.js';
export { DEMOS, EXAMPLES } from './demo.js';
export { SourceError } from './util.js';
export { createResolver, ResolveError } from './resolver.js';

/**
 * @typedef {Object} TrackMeta
 * @property {string} id          unique within the playlist: "spotify:track:<id>" | "deezer:<id>" | "text:<n>" | "local:<n>" ("spotify:md:<n>" from the markdown fallback)
 * @property {string} title
 * @property {string} artist      display string (artists joined with ", "); '' when unknown
 * @property {number} [durationMs] full-track duration when the source knows it
 * @property {boolean} [explicit]
 * @property {string} [link]      canonical https URL of the track at its source ("Open in Spotify")
 * @property {string} [artwork]   https image URL if known
 * @property {{url:string, provider:'deezer'|'itunes', id:string}} [preview]  preview already known (Deezer sources)
 * @property {File} [file]        local file (source 'local')
 * @property {{title:string, artist:string}} [alt]  second reading of an ambiguous pasted line (source 'text')
 *
 * @typedef {Object} Playlist
 * @property {string} id          "spotify:playlist:<id>" | "spotify:album:<id>" | "deezer:playlist:<id>" | "deezer:album:<id>" | "deezer:chart:<genre>" | "local:<hash>" | "text:<hash>"
 * @property {'spotify'|'deezer'|'text'|'local'} source
 * @property {string} title
 * @property {string} [subtitle]  owner / description
 * @property {string} [link]
 * @property {string} [artwork]
 * @property {TrackMeta[]} tracks
 * @property {number} [total]     track count at the source, if larger than tracks.length
 *
 * @typedef {Object} AudioRef
 * @property {'deezer'|'itunes'|'local'} provider
 * @property {string} key         "deezer:<id>" | "itunes:<id>" | "local:<name>:<size>:<lastModified>"
 * @property {string} [url]       https, CORS-enabled
 * @property {File} [file]
 * @property {boolean} isPreview
 * @property {number} matchScore  0..1 (1 when the source already supplied the audio)
 * @property {string} matchedTitle
 * @property {string} matchedArtist
 * @property {string} [artwork]
 * @property {string} [link]
 * @property {number} [bpmHint]   provider-supplied BPM if > 0
 * @property {number} [matchedDurationMs]  full-track length of the matched recording, when the catalogue says (searched matches only)
 *
 * @typedef {Object} ParsedInput
 * @property {'spotify'|'deezer'|'text'|'unknown'} kind
 * @property {'playlist'|'album'|'chart'|'track'} [type]
 * @property {string} [id]
 * @property {string} [reason]    kind 'unknown' only: machine-readable why (e.g. 'spotify-track', 'spotify-short', 'apple-music', 'empty')
 * @property {string} [message]   kind 'unknown' only: friendly sentence telling the user what to paste instead
 */

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const DEEZER_ID = /^\d{1,15}$/;
const MAX_INPUT = 20000;

const HOW_TO_COPY = 'In Spotify: ••• → Share → Copy link to playlist.';
const WHAT_WORKS = 'Paste a Spotify or Deezer playlist link, or a list of songs (Artist - Title, one per line).';

const MESSAGES = {
  empty: 'Paste a Spotify playlist link to get started.',
  'spotify-track': `That link is a single song. Paste a playlist or album link instead. ${HOW_TO_COPY}`,
  'spotify-artist': 'That link is an artist page. Open one of their albums or playlists and paste that link instead.',
  'spotify-podcast': 'That link is a podcast, and Segue mixes music. Paste a playlist or album link instead.',
  'spotify-liked': "Spotify keeps Liked Songs private. Add the songs to a playlist, make it public and paste that playlist's link.",
  'spotify-profile': 'That link is a profile. Open one of the playlists on it and paste that link instead.',
  'spotify-short': 'Short spotify.link addresses cannot be read from a web page. Open it in your browser, then copy the full address that starts with open.spotify.com/playlist/.',
  'spotify-bad-id': `That Spotify link looks cut off. Copy it again. ${HOW_TO_COPY}`,
  'spotify-other': `Segue can read Spotify playlists and albums, but not that page. ${HOW_TO_COPY}`,
  'deezer-track': 'That link is a single song. Paste a Deezer playlist or album link instead.',
  'deezer-artist': 'That link is an artist page. Open one of their albums or playlists and paste that link instead.',
  'deezer-short': 'Short Deezer links cannot be read from a web page. Open it in your browser, then copy the full address that starts with deezer.com/playlist/.',
  'deezer-other': 'Segue can read Deezer playlists and albums, but not that page. Paste a link like deezer.com/playlist/1234.',
  'apple-music': `Apple Music links are not supported yet. ${WHAT_WORKS}`,
  youtube: `YouTube links are not supported yet. ${WHAT_WORKS}`,
  'other-service': `Links from that service are not supported yet. ${WHAT_WORKS}`,
  'other-link': `Segue cannot read that link. ${WHAT_WORKS}`,
  'not-a-list': `That does not look like a playlist link. ${WHAT_WORKS}`,
};

/** @returns {ParsedInput} */
function unknown(reason, extra = {}) {
  return { kind: 'unknown', reason, message: MESSAGES[reason] || MESSAGES['other-link'], ...extra };
}

function spotifyThing(type, id) {
  if (type === 'playlist' || type === 'album') {
    return SPOTIFY_ID.test(id || '') ? { kind: /** @type {const} */ ('spotify'), type, id } : unknown('spotify-bad-id');
  }
  if (type === 'track') return unknown('spotify-track', SPOTIFY_ID.test(id || '') ? { type: 'track', id } : {});
  if (type === 'artist') return unknown('spotify-artist');
  if (type === 'show' || type === 'episode' || type === 'audiobook') return unknown('spotify-podcast');
  if (type === 'collection') return unknown('spotify-liked');
  if (type === 'user') return unknown('spotify-profile');
  return unknown('spotify-other');
}

function deezerThing(type, id) {
  if (type === 'playlist' || type === 'album') {
    return DEEZER_ID.test(id || '') ? { kind: /** @type {const} */ ('deezer'), type, id } : unknown('deezer-other');
  }
  if (type === 'chart') return /^\d{1,4}$/.test(id || '') ? { kind: /** @type {const} */ ('deezer'), type, id } : unknown('deezer-other');
  if (type === 'track') return unknown('deezer-track', DEEZER_ID.test(id || '') ? { type: 'track', id } : {});
  if (type === 'artist') return unknown('deezer-artist');
  return unknown('deezer-other');
}

const SCHEMELESS_HOST =
  /^(?:(?:open|play)\.spotify\.com|spotify\.link|spotify\.app\.link|(?:www\.)?deezer\.com|deezer\.page\.link|dzr\.page\.link|link\.deezer\.com|music\.apple\.com|(?:www\.|m\.|music\.)?youtube\.com|youtu\.be)\//i;

/**
 * Classify one whitespace-free token. Returns null when it is not a link/URI at all.
 * Only ever extracts an id that matches a strict pattern — nothing from the token is reused as a URL.
 * @param {string} token
 * @returns {ParsedInput | null}
 */
function classifyToken(token) {
  let t = token.replace(/^[<("'[]+|[>)"'\],.;!]+$/g, '');
  if (!t || t.length > 2048) return null;

  // URIs: spotify:playlist:ID, spotify:user:NAME:playlist:ID, deezer:chart:113 (share-link ids)
  if (/^spotify:/i.test(t)) {
    const parts = t.split(':').slice(1);
    if (parts[0] === 'user' && parts.length >= 4) return spotifyThing(parts[2], parts[3]);
    return spotifyThing(parts[0], parts[1]);
  }
  if (/^deezer:/i.test(t)) {
    const parts = t.split(':').slice(1);
    return deezerThing(parts[0], parts[1]);
  }

  if (!/^https?:\/\//i.test(t)) {
    if (!SCHEMELESS_HOST.test(t)) return null;
    t = 'https://' + t;
  }
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let seg;
  try {
    seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    seg = u.pathname.split('/').filter(Boolean);
  }

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    if (/^intl-[a-z]{2,3}$/i.test(seg[0] || '')) seg.shift();
    if (seg[0] === 'embed') seg.shift();
    const uri = u.searchParams.get('uri'); // legacy embed form: /embed?uri=spotify:playlist:ID
    if (!seg.length && uri && /^spotify:/i.test(uri)) return classifyToken(uri);
    if (seg[0] === 'user' && seg.length >= 4) seg.splice(0, 2); // /user/NAME/playlist/ID (pre-2018 links)
    return spotifyThing(seg[0], seg[1]);
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') return unknown('spotify-short');
  if (host === 'deezer.com') {
    if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(seg[0] || '')) seg.shift(); // /us/, /en/, /pt-br/
    return deezerThing(seg[0], seg[1]);
  }
  if (host === 'deezer.page.link' || host === 'dzr.page.link' || host === 'link.deezer.com') return unknown('deezer-short');
  if (host === 'music.apple.com' || host === 'itunes.apple.com' || host === 'geo.music.apple.com') return unknown('apple-music');
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return unknown('youtube');
  if (/(^|\.)(?:soundcloud\.com|tidal\.com|music\.amazon\.[a-z.]+|pandora\.com|audiomack\.com|bandcamp\.com)$/.test(host)) return unknown('other-service');
  if (host.endsWith('.spotify.com') || host === 'spotify.com') return unknown('spotify-other');
  return unknown('other-link');
}

/**
 * Work out what the user pasted. Never throws.
 *
 *   {kind:'spotify', type:'playlist'|'album', id}      Spotify URL / URI in any of its shapes
 *   {kind:'deezer',  type:'playlist'|'album'|'chart', id}
 *   {kind:'text'}                                      a list of songs
 *   {kind:'unknown', reason, message}                  anything else; `message` says what to paste instead
 *
 * @param {string} text
 * @returns {ParsedInput}
 */
export function parseInput(text) {
  if (typeof text !== 'string') return unknown('empty');
  const input = text.slice(0, MAX_INPUT).trim();
  if (!input) return unknown('empty');

  const lines = input
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  /** @type {ParsedInput | null} */
  let firstSupported = null;
  /** @type {ParsedInput | null} */
  let firstUnsupported = null;
  let linkLines = 0;
  for (const line of lines.slice(0, 500)) {
    let hasLink = false;
    for (const token of line.split(/\s+/).slice(0, 40)) {
      const hit = classifyToken(token);
      if (!hit) continue;
      hasLink = true;
      if (hit.kind === 'unknown') firstUnsupported ||= hit;
      else firstSupported ||= hit;
    }
    if (hasLink) linkLines++;
  }

  // Mostly prose with a stray link in it is a song list; otherwise a link wins.
  const mostlyText = lines.length >= 3 && linkLines * 2 < lines.length;
  if (!mostlyText) {
    if (firstSupported) return firstSupported;
    if (firstUnsupported) return firstUnsupported;
  }

  const songs = lines.slice(0, 500).map(parseTextLine).filter(Boolean);
  if (songs.length >= 2) return { kind: 'text' };
  if (songs.length === 1 && songs[0].artist) return { kind: 'text' }; // one "Artist - Title" line
  return unknown(firstUnsupported ? firstUnsupported.reason : 'not-a-list', firstUnsupported || {});
}

/**
 * Load a playlist from whatever the user pasted: a Spotify/Deezer URL or URI, an internal id such as
 * "deezer:chart:113" (share links), or multi-line "Artist - Title" text.
 * Rejects with SourceError (friendly `message`, machine `code`) or AbortError.
 * @param {string} input
 * @param {{signal?: AbortSignal, onStatus?: (msg: string) => void}} [opts]
 * @returns {Promise<Playlist>}
 */
export async function loadPlaylist(input, opts = {}) {
  throwIfAborted(opts.signal);
  const parsed = parseInput(input);
  if (parsed.kind === 'spotify') {
    return loadSpotify({ type: /** @type {'playlist'|'album'} */ (parsed.type), id: /** @type {string} */ (parsed.id) }, opts);
  }
  if (parsed.kind === 'deezer') {
    return loadDeezer({ type: /** @type {'playlist'|'album'|'chart'} */ (parsed.type), id: /** @type {string} */ (parsed.id) }, opts);
  }
  if (parsed.kind === 'text') {
    if (opts.onStatus) opts.onStatus('Reading your list…');
    return playlistFromText(input.slice(0, MAX_INPUT * 10));
  }
  throw new SourceError(parsed.reason === 'empty' ? 'empty-input' : 'unsupported', parsed.message || MESSAGES['other-link'], { detail: parsed.reason });
}

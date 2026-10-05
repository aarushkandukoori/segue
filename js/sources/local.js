// The user's own audio files (full-length tracks, nothing leaves the machine).
// Titles come from file names ("Artist - Title.mp3"); an optional tiny ID3v2 reader can improve them.

import { cleanText, hashString } from './util.js';

const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);
export const LOCAL_MAX_TRACKS = 500;

const collator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
const naturalCompare = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

function extension(name) {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** @param {{name?: string, type?: string}} file */
export function isAudioFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  if (typeof file.type === 'string' && file.type.toLowerCase().startsWith('audio/')) return true;
  return AUDIO_EXT.has(extension(file.name));
}

/** Cache identity of a local file (AudioRef.key). */
export function localKey(file) {
  return `local:${file.name}:${file.size}:${file.lastModified}`;
}

// Things ripping tools and video sites append to file names.
const JUNK_GROUP = /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|lyric video|visuali[sz]er|hq|hd|4k|\d{2,3} ?kbps|explicit|full song|free download)\b[^)\]]*[)\]]/gi;

const TRACK_NO = /^\d{1,3}$/;
const VERSION_PART = /\b(?:remaster(?:ed)?|remix|mix|edit|version|live|acoustic|instrumental|mono|stereo|demo|feat|ft)\b/i;

/**
 * "03 - Daft Punk - One More Time.mp3" → {artist: "Daft Punk", title: "One More Time"}.
 * Never throws; with nothing to go on the whole name becomes the title.
 *
 * A bare leading number is ambiguous ("12 Song" vs "99 Problems", "50 Cent - In Da Club",
 * "311 - Amber"), so it is only treated as a track number when it is zero-padded, punctuated like
 * one ("12. ", "(12) ", "1-03 "), followed by a full "Artist - Title", or when the caller knows the
 * whole batch is numbered (`numbered`).
 * @param {unknown} name
 * @param {{numbered?: boolean}} [opts]
 * @returns {{title: string, artist: string}}
 */
export function parseFilename(name, opts = {}) {
  let s = typeof name === 'string' ? name : '';
  s = s.replace(/^.*[\\/]/, ''); // drop any folder part
  s = s.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  s = s.replace(/_+/g, ' ').replace(JUNK_GROUP, '');
  s = cleanText(s);
  s = s
    .replace(/^\(\d{1,3}\)\s*(?=\S)/, '') // "(12) Title"
    .replace(/^\d{1,3}\s*[.)]\s+(?=\S)/, '') // "12. Title", "12) Title"
    .replace(/^\d{1,2}-\d{1,3}\s*[-.]?\s+(?=\S)/, '') // "1-03 Title" (disc-track)
    .replace(/^0\d{1,2}\s*[-.]?\s+(?=\S)/, '') // "03 Title", "03 - Title"
    .replace(/^[A-D]\d\s*[-.)]\s+(?=\S)/, ''); // "A1 - Title" (vinyl sides)
  if (opts.numbered) s = s.replace(/^\d{1,3}\s*[-.)]?\s+(?=\S)/, '');
  let parts = s
    .split(/\s+[-\u2013\u2014]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  // "12 - Artist - Title": with two more parts behind it the number is a track number.
  if (parts.length >= 3 && TRACK_NO.test(parts[0])) parts = parts.slice(1);
  const named = parts.filter((p, i) => i === 0 || !TRACK_NO.test(p)); // "Artist - Album - 07 - Title"
  let title = s;
  let artist = '';
  if (named.length === 2) [artist, title] = named;
  else if (named.length > 2) {
    artist = named[0];
    // "Artist - Title - Live at X" keeps its suffix; "Artist - Album - Title" drops the album.
    title = VERSION_PART.test(named[named.length - 1]) ? named.slice(1).join(' - ') : named[named.length - 1];
  }
  return { title: cleanText(title) || cleanText(typeof name === 'string' ? name : '') || 'Untitled', artist: cleanText(artist) };
}

/**
 * Build a playlist from dropped / picked files. Synchronous: only names are looked at.
 * Non-audio files are ignored; order is natural ("2" before "10"), by folder path when present.
 * @param {ArrayLike<File> | Iterable<File>} files
 * @returns {import('./index.js').Playlist}
 */
export function playlistFromFiles(files) {
  const all = files ? Array.from(/** @type {any} */ (files)) : [];
  const audio = all.filter(isAudioFile);
  const path = (f) => (typeof f.webkitRelativePath === 'string' && f.webkitRelativePath) || f.name;
  audio.sort((a, b) => naturalCompare(path(a), path(b)));
  // An album rip: (nearly) every name starts with a track number.
  const numberedCount = audio.filter((f) => /^\d{1,3}[\s._-]/.test(f.name)).length;
  const numbered = audio.length >= 3 && numberedCount >= audio.length * 0.7;
  const seen = new Set();
  /** @type {import('./index.js').TrackMeta[]} */
  const tracks = [];
  for (const file of audio) {
    const key = localKey(file);
    if (seen.has(key)) continue; // the same file dropped twice
    seen.add(key);
    if (tracks.length >= LOCAL_MAX_TRACKS) continue;
    const { title, artist } = parseFilename(file.name, { numbered });
    tracks.push({ id: `local:${tracks.length}`, title, artist, file });
  }
  // A single dropped folder names the set.
  const folders = new Set(audio.map((f) => (typeof f.webkitRelativePath === 'string' ? f.webkitRelativePath.split('/')[0] : '')).filter(Boolean));
  const title = folders.size === 1 ? cleanText([...folders][0]) : 'Your files';
  /** @type {import('./index.js').Playlist} */
  const playlist = {
    id: `local:${hashString([...seen].join('|'))}`,
    source: 'local',
    title: title || 'Your files',
    subtitle: `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} from this device`,
    tracks,
  };
  if (seen.size > tracks.length) playlist.total = seen.size;
  return playlist;
}

/* ------------------------------------------------------------------ optional ID3v2 */

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function decodeText(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'windows-1252';
  try {
    const text = new TextDecoder(label).decode(body);
    return cleanText(text.split('\u0000')[0]); // v2.4 may hold several NUL-separated values
  } catch {
    return '';
  }
}

/**
 * Minimal ID3v2 (.2/.3/.4) reader: title (TIT2/TT2) and artist (TPE1/TP1) only.
 * Returns {} for anything it does not understand — never throws.
 * @param {Uint8Array} bytes  the start of the file
 * @returns {{title?: string, artist?: string}}
 */
export function parseId3v2(bytes) {
  const out = {};
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 20) return out;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return out; // "ID3"
    const ver = bytes[3];
    const flags = bytes[5];
    if (ver < 2 || ver > 4 || flags & 0x80) return out; // unsynchronised tags: not worth the code
    const end = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
    let p = 10;
    if (ver >= 3 && flags & 0x40) {
      // extended header
      const size = ver === 4 ? syncsafe(bytes, p) : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) + 4;
      p += Math.max(size, 0);
    }
    const idLen = ver === 2 ? 3 : 4;
    const headLen = ver === 2 ? 6 : 10;
    for (let guard = 0; p + headLen <= end && guard < 200; guard++) {
      if (bytes[p] === 0) break; // padding
      const id = String.fromCharCode(...bytes.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let size;
      if (ver === 2) size = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
      else if (ver === 4) size = syncsafe(bytes, p + 4);
      else size = ((bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]) >>> 0;
      const start = p + headLen;
      if (size <= 0 || start + size > end) break;
      if (id === 'TIT2' || id === 'TT2') out.title = decodeText(bytes.subarray(start, start + size)) || out.title;
      else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(bytes.subarray(start, start + size)) || out.artist;
      if (out.title && out.artist) break;
      p = start + size;
    }
  } catch {
    /* junk in, nothing out */
  }
  if (!out.title) delete out.title;
  if (!out.artist) delete out.artist;
  return out;
}

/**
 * Read title/artist tags from a file (mp3 with ID3v2 only). Never rejects.
 * @param {File} file
 * @returns {Promise<{title?: string, artist?: string}>}
 */
export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    // Cover art can sit in front of the text frames; cap what we are willing to read.
    const size = Math.min(10 + syncsafe(head, 6), 4 * 1024 * 1024);
    return parseId3v2(new Uint8Array(await file.slice(0, size).arrayBuffer()));
  } catch {
    return {};
  }
}

/**
 * Optional upgrade after playlistFromFiles(): replace file-name guesses with real tags where a file
 * has them. Mutates and returns the same playlist. Never rejects.
 * @param {import('./index.js').Playlist} playlist
 * @returns {Promise<import('./index.js').Playlist>}
 */
export async function applyTags(playlist) {
  await Promise.all(
    playlist.tracks.map(async (t) => {
      if (!t.file) return;
      const tags = await readTags(t.file);
      if (tags.title) {
        t.title = tags.title;
        if (tags.artist) t.artist = tags.artist;
      } else if (tags.artist && !t.artist) t.artist = tags.artist;
    }),
  );
  return playlist;
}

// Pasted song lists: one song per line, in whatever shape people actually type —
//   Artist - Title        Title by Artist        1. Artist – Title (3:45)        Artist<TAB>Title
// The convention is "Artist - Title". Lines that could be read two ways also carry the other
// reading in `alt`, and the resolver tries it when the first one finds nothing.

import { SourceError, cleanText, hashString } from './util.js';

export const TEXT_MAX_TRACKS = 200;
const MAX_LINES = 2000; // never chew through megabytes of junk
const MAX_LINE = 300;

const DASH = /\s+[-–—]+\s+|\s*[–—]\s*/; // " - " or an en/em dash with or without spaces
const TIME = /\s*([([])?(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)[)\]]?\s*$/;

const stripQuotes = (s) => s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();

/** Peel a trailing duration ("(3:45)", "- 3:45") off a line, unless it is plausibly the title ("JAY-Z - 4:44"). */
function takeDuration(s) {
  const m = TIME.exec(s);
  if (!m || m.index === 0) return { rest: s };
  let rest = s.slice(0, m.index).trim();
  const bracketed = !!m[1];
  const danglingDash = /[-–—]$/.test(rest);
  if (danglingDash) {
    const before = rest.replace(/\s*[-–—]+$/, '');
    // "Artist - Title - 3:45" has another separator left; "JAY-Z - 4:44" does not.
    if (!bracketed && !DASH.test(before)) return { rest: s };
    rest = before;
  }
  if (!/[\p{L}\p{N}]/u.test(rest)) return { rest: s };
  const ms = ((Number(m[2] || 0) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
  return { rest, durationMs: ms >= 20000 ? ms : undefined };
}

/**
 * Parse one line. Returns null for blanks, headings, URLs and other non-songs.
 * @param {unknown} raw
 * @returns {{title: string, artist: string, durationMs?: number, alt?: {title: string, artist: string}} | null}
 */
export function parseTextLine(raw) {
  if (typeof raw !== 'string') return null;
  const line = raw.slice(0, MAX_LINE * 2);
  let title = '';
  let artist = '';
  let durationMs;
  /** @type {{title: string, artist: string} | undefined} */
  let alt;

  // A tab is an unambiguous column separator (spreadsheet paste): [#] Artist, Title, [album…], [time]
  const cols = line.includes('\t')
    ? line
        .split('\t')
        .map((c) => cleanText(c, MAX_LINE))
        .filter(Boolean)
    : [];
  if (cols.length >= 2) {
    if (/^#?\d{1,3}[.)]?$/.test(cols[0]) && cols.length >= 3) cols.shift();
    const last = TIME.exec(cols[cols.length - 1]);
    if (last && last.index === 0 && cols.length >= 3) durationMs = takeDuration('x ' + cols.pop()).durationMs;
    artist = cols[0];
    title = cols[1];
    alt = { title: artist, artist: title };
  } else {
    let s = cleanText(line, MAX_LINE);
    if (!s) return null;
    if (/^(?:https?:\/\/|www\.|spotify:|deezer:)/i.test(s)) return null; // a link is not a song
    if (/^(?:#\s|\/\/)/.test(s)) return null; // comment / heading
    if (/^#?\d{1,3}\s*[.):]$/.test(s)) return null; // list numbering with nothing after it
    if (/^[([]\d{1,2}(?::\d{2}){1,2}[)\]]$/.test(s)) return null; // a stray "(3:45)"
    // Bullets and numbering: "1. ", "01) ", "#3: ", "- ", "• ", "* ", "[12] ", "12 - Artist - Title".
    s = s
      .replace(/^[-*•·▪►>]+\s+/, '')
      .replace(/^\[\d{1,3}\]\s*/, '')
      .replace(/^#?\d{1,3}\s*[.):]\s+(?=\S)/, '')
      .replace(/^\d{1,3}\s+[-–—]\s+(?=\S.*\s[-–—]\s)/, '');
    const timed = takeDuration(s);
    s = timed.rest;
    durationMs = timed.durationMs;
    if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;

    const dash = DASH.exec(s);
    const by = /^(.+?)\s+by\s+(.+)$/i.exec(s);
    if (dash && dash.index > 0 && dash.index + dash[0].length < s.length) {
      artist = s.slice(0, dash.index);
      title = s.slice(dash.index + dash[0].length);
      alt = { title: artist, artist: title }; // some lists are "Title - Artist"
    } else if (by) {
      title = by[1];
      artist = by[2];
      alt = { title: s, artist: '' }; // "Stand by Me" is a title, not "Stand" by "Me"
    } else {
      title = s;
    }
  }
  title = stripQuotes(title);
  artist = stripQuotes(artist);
  if (!title) {
    title = artist;
    artist = '';
    alt = undefined;
  }
  if (!title || !/[\p{L}\p{N}]/u.test(title)) return null;
  /** @type {{title: string, artist: string, durationMs?: number, alt?: {title: string, artist: string}}} */
  const out = { title, artist };
  if (durationMs) out.durationMs = durationMs;
  if (alt && stripQuotes(alt.title)) out.alt = { title: stripQuotes(alt.title), artist: stripQuotes(alt.artist) };
  return out;
}

/**
 * @param {string} text
 * @returns {{tracks: import('./index.js').TrackMeta[], total: number}}  total = songs found before the cap
 */
export function parseTextTracks(text) {
  const lines = typeof text === 'string' ? text.split(/\r\n|\r|\n/, MAX_LINES) : [];
  /** @type {import('./index.js').TrackMeta[]} */
  const tracks = [];
  const seen = new Set();
  let total = 0;
  for (const line of lines) {
    const song = parseTextLine(line);
    if (!song) continue;
    const key = `${song.artist}\n${song.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    if (tracks.length >= TEXT_MAX_TRACKS) continue;
    tracks.push({ id: `text:${tracks.length}`, ...song });
  }
  return { tracks, total };
}

/**
 * Multi-line "Artist - Title" text → Playlist.
 * @param {string} text
 * @returns {import('./index.js').Playlist}
 */
export function playlistFromText(text) {
  const { tracks, total } = parseTextTracks(text);
  if (!tracks.length) {
    throw new SourceError('empty', 'No songs found in that text. Put one song per line, like “Daft Punk - One More Time”.');
  }
  /** @type {import('./index.js').Playlist} */
  const playlist = {
    id: `text:${hashString(tracks.map((t) => `${t.artist}\n${t.title}`).join('\n\n'))}`,
    source: 'text',
    title: 'Your list',
    subtitle: `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} you pasted`,
    tracks,
  };
  if (total > tracks.length) playlist.total = total;
  return playlist;
}

// Track → YouTube video, for the full-song modes (SPEC 6). Given a TrackMeta (title, artist, length
// from Spotify / Deezer / a pasted line) find an embeddable upload of the SAME recording, so the
// official IFrame player can play it. Nothing here touches audio or the player.
//
// YouTube's search page cannot be read from another origin, so it is fetched through the same kind of
// public relays the Spotify reader uses (SPEC 6.1), hedged, size-capped and serialised. The page's
// `ytInitialData` object is cut out with a linear brace scan and walked for `videoRenderer` entries.
// The scorer is stricter about version traps than the preview matcher (a sped-up re-upload or a live
// cut is easy to find on YouTube and sounds wrong for the whole song) and looser about length (music
// videos run a few seconds long). A weak match is reported as no match rather than played.

import { createLimiter } from './limiter.js';
import { artistScore, censoredEqual, fold, parseTitle, primaryArtist, splitArtists, titleSimilarity } from './match.js';
import { ResolveError } from './resolver.js';
import { hedgedChain } from './spotify.js';
import { SourceError, UNKNOWN_ARTIST, abortError, cleanText, isAbort, request, throwIfAborted } from './util.js';

/**
 * @typedef {Object} YtCandidate
 * @property {string} videoId          11 characters, [A-Za-z0-9_-]
 * @property {string} title
 * @property {string} channel
 * @property {number|null} durationS
 * @property {boolean} verifiedArtist  "Official Artist Channel" badge (music note)
 * @property {boolean} verified        any verified badge (true whenever verifiedArtist is)
 * @property {boolean} topic           auto-generated "<Artist> - Topic" channel (album audio)
 * @property {number} rank             0-based position in the search results (beyond SPEC 6.4: tie-break)
 * @property {boolean} live            live stream / premiere without a length (beyond SPEC 6.4)
 *
 * @typedef {Object} YtMatch
 * @property {string} videoId
 * @property {string} title
 * @property {string} channel
 * @property {number|null} durationS
 * @property {number} score            0..1
 * @property {string[]} alternates     next best video ids of the same recording, best first (for a video that refuses to embed)
 * @property {''|'v'|'a'} badge         the pick's channel badge (verified / artist), kept so a cached pick can be re-checked (beyond SPEC 6.4)
 * @property {{durationS: number|null, badge: ''|'v'|'a'}[]} altInfo  the same for each alternate, in order (beyond SPEC 6.4)
 *
 * The title and channel are YouTube's own (oEmbed) whenever that check answered: a relay's word is never
 * taken for which video carries which title.
 *
 * @typedef {(url: string, opts: {signal?: AbortSignal, timeoutMs?: number, headers?: Record<string,string>, maxBytes?: number})
 *            => Promise<{status: number, ok: boolean, body: string}>} FetchText
 */

/** A match at or above this is played. */
export const YT_ACCEPT = 0.7;
/** Further uploads at or above this are kept as alternates. */
export const YT_ALTERNATE = 0.66;


const MAX_ALTERNATES = 4;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// A real results page is ~1.3 MB either way (measured 2026-10-05); anything past this is dropped unread.
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_OEMBED_BYTES = 64 * 1024;
const ATTEMPT_TIMEOUT_MS = 12000;
// If the first relay is silent this long, the second one is asked alongside it (first valid answer wins).
// Relay 1 answered in 0.7-0.94 s in every one of 10 searches from a browser origin (2026-10-05).
const HEDGE_MS = 3000;
const OEMBED_TIMEOUT_MS = 5000;
// Uploads checked with oEmbed per lookup, in parallel: the pick, its alternates and two spares. Only a
// checked upload is ever returned.
const OEMBED_CHECKS = 7;
// r.jina.ai's free tier allows about 20 requests a minute per IP; a relay that keeps failing is moved
// to the back of the line for a while instead of costing every search a timeout.
const JINA_PER_MINUTE = 18;
export const SEARCHES_PER_MINUTE = 40;
const JINA_MAX_WAIT_MS = 30000;
const DEMOTE_AFTER = 2;
const DEMOTE_MS = 2 * 60 * 1000;
const BACKOFF_MS = 60 * 1000;

export const YT_STORAGE_KEY = 'segue:yt:v1';
const STORAGE_MAX = 1500;
const STORAGE_TTL_MS = 60 * 24 * 3600 * 1000; // uploads disappear; an old mapping is looked up again (and deleted)
// A record stamped later than this is not from this clock: dropped, never trusted for ever.
const STORAGE_FUTURE_MS = 24 * 3600 * 1000;
const STORAGE_KEY_MAX = 600;
const MEMORY_MAX = 3000;
// What a deck reports when the upload itself is not at fault (a long ad, a background tab, autoplay rules):
// forget() keeps the upload for these.
const NO_VERDICT = new Set(['timeout', 'blocked', 'cancelled', 'api', 'slow', 'stuck', 'cap', 'background', 'busy', 'network']);

// The walk over ytInitialData is bounded whatever the page holds.
const MAX_NODES = 2000000;
const MAX_CANDIDATES = 40;
const MARKER = 'ytInitialData';
const MAX_MARKERS = 3;

/* ------------------------------------------------------------------ parsing (pure) */

/**
 * End index of the JSON object that starts at `start` (a "{"), or -1. One pass, every character
 * looked at once: braces count only outside strings, and a backslash skips the next character.
 */
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // backslash: whatever follows is part of the string
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) return i;
  }
  return -1;
}

const HEX = /^[0-9a-fA-F]+$/;
const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * A JS string literal ('…' or "…") starting at `start` → its value, or null. Some YouTube pages ship
 * the data as `ytInitialData = '\x7b\x22…'`. Linear: one pass, no patterns.
 */
function readJsString(s, start) {
  const quote = s[start];
  const out = [];
  let chunk = start + 1;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === quote) {
      out.push(s.slice(chunk, i));
      return out.join('');
    }
    if (ch === '\n') return null;
    if (ch !== '\\') continue;
    out.push(s.slice(chunk, i));
    const e = s[i + 1];
    if (e === 'x' || e === 'u') {
      const len = e === 'x' ? 2 : 4;
      const hex = s.slice(i + 2, i + 2 + len);
      if (hex.length !== len || !HEX.test(hex)) return null;
      out.push(String.fromCharCode(parseInt(hex, 16)));
      i += 1 + len;
    } else if (e === undefined) return null;
    else {
      out.push(SIMPLE_ESCAPES[e] ?? e);
      i += 1;
    }
    chunk = i + 1;
  }
  return null;
}

function parseObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null; // includes a RangeError from absurd nesting
  }
}

/**
 * The ytInitialData object inside one string (an HTML page or one script's text), or null. Looks at
 * the first MAX_MARKERS mentions only, so the cost stays a small multiple of the length.
 */
function initialDataIn(s) {
  let from = 0;
  for (let n = 0; n < MAX_MARKERS; n++) {
    const at = s.indexOf(MARKER, from);
    if (at < 0) return null;
    from = at + MARKER.length;
    let j = from;
    if (s[j] === '"' || s[j] === "'") j++;
    if (s[j] === ']') j++;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] !== '=') continue;
    j++;
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r') j++;
    let data = null;
    if (s[j] === '{') {
      const end = matchBrace(s, j);
      if (end < 0) return null; // nothing after this point can close either
      data = parseObject(s.slice(j, end + 1));
    } else if (s[j] === "'" || s[j] === '"') {
      data = parseObject(readJsString(s, j));
    }
    if (data) return data;
  }
  return null;
}

/** The text of a YouTube "formatted string": {simpleText} or {runs: [{text}]} (or a plain string). */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (Array.isArray(v.runs)) {
    let s = '';
    for (let i = 0; i < v.runs.length && i < 50; i++) {
      const r = v.runs[i];
      if (r && typeof r.text === 'string') s += r.text;
    }
    return s;
  }
  return '';
}

const CLOCK = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/;

/** "4:40" → 280, "1:02:03" → 3723; anything else → null. */
export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = CLOCK.exec(value.trim());
  if (!m) return null;
  const s = (Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
  return s > 0 && s < 86400 ? s : null;
}

const badgeStyles = (list) =>
  (Array.isArray(list) ? list.slice(0, 10) : [])
    .map((b) => b && b.metadataBadgeRenderer && b.metadataBadgeRenderer.style)
    .filter((s) => typeof s === 'string');

/** One videoRenderer → YtCandidate (fresh object from whitelisted fields), or null. */
function toCandidate(vr, rank) {
  const videoId = vr.videoId;
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return null;
  const title = cleanText(textOf(vr.title), 300);
  if (!title) return null;
  const channel = cleanText(textOf(vr.ownerText) || textOf(vr.longBylineText) || textOf(vr.shortBylineText), 200);
  const length = vr.lengthText;
  const durationS = parseClock(typeof length === 'string' ? length : length && typeof length === 'object' ? textOf(length) : '');
  const owner = badgeStyles(vr.ownerBadges);
  const verifiedArtist = owner.includes('BADGE_STYLE_TYPE_VERIFIED_ARTIST');
  const verified = verifiedArtist || owner.includes('BADGE_STYLE_TYPE_VERIFIED');
  const live = badgeStyles(vr.badges).some((s) => /LIVE/.test(s)) || (!!vr.upcomingEventData && durationS == null);
  return { videoId, title, channel, durationS, verifiedArtist, verified, topic: / - Topic$/.test(channel), rank, live };
}

/** Every videoRenderer in document order, iteratively (no recursion over somebody else's nesting). */
function collectVideos(root) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  let visited = 0;
  while (stack.length && visited++ < MAX_NODES && out.length < MAX_CANDIDATES) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
      continue;
    }
    const vr = node.videoRenderer;
    if (vr && typeof vr === 'object' && !Array.isArray(vr)) {
      const c = toCandidate(vr, out.length);
      if (c && !seen.has(c.videoId)) {
        seen.add(c.videoId);
        out.push(c);
      }
    }
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i] === 'videoRenderer') continue;
      const v = node[keys[i]];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out;
}

/**
 * Read a relay answer. `found` = the page carried ytInitialData at all (a genuine results page, even
 * when it lists no videos), as opposed to a consent wall, an error page or junk.
 * @param {unknown} text
 * @returns {{found: boolean, candidates: YtCandidate[]}}
 */
export function readSearchPage(text) {
  if (typeof text !== 'string' || !text) return { found: false, candidates: [] };
  let data = null;
  // Relay 1 answers {result: {script: ["…", "var ytInitialData = {…};", …]}}.
  let i = 0;
  while (i < text.length && i < 64 && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t' || text[i] === '\ufeff')) i++;
  if (text[i] === '{') {
    const body = parseObject(text);
    const result = body && body.result;
    if (result && typeof result === 'object') {
      for (const value of Object.values(result).slice(0, 8)) {
        const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.slice(0, 200) : [];
        for (const t of texts) {
          if (typeof t === 'string' && t.includes(MARKER)) data = initialDataIn(t);
          if (data) break;
        }
        if (data) break;
      }
    }
  }
  if (!data && text.includes(MARKER)) data = initialDataIn(text);
  if (!data) return { found: false, candidates: [] };
  return { found: true, candidates: collectVideos(data) };
}

/**
 * Search results from a relay answer: the HTML page (relay 2) or the relay-1 JSON. Never throws;
 * junk, truncated or hostile input gives [].
 * @param {unknown} text
 * @returns {YtCandidate[]}
 */
export function parseYouTubeSearch(text) {
  return readSearchPage(text).candidates;
}

/* ------------------------------------------------------------------ scoring (pure) */

/** Folded, punctuation-free words ("Don't Stop (Live)" → "dont stop live"). */
const words = (s) =>
  fold(s)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();

/** Typographic quotes/dashes → ASCII, whitespace collapsed; case kept. */
const unify = (s) =>
  String(s || '')
    .replace(/[\u2018\u2019\u201b\u02bc\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212\u30fc\uff0d]/g, (c) => (c === '\u30fc' ? c : '-'))
    .replace(/\s+/g, ' ')
    .trim();

// What uploaders add around a song title. Longest phrases first: alternation takes the first that fits.
const DECOR_ALT = [
  'official\\s+(?:(?:4k|hd|hq|uhd|8k)\\s+)?(?:(?:music|lyrics?|audio|dance|animated|art|vertical)\\s+)?(?:video|audio|visuali[sz]er|clip|mv|m\\/v|lyric\\s+video|lyrics)',
  '(?:(?:4k|hd|hq)\\s+)?(?:music|lyrics?|animated|art|vertical)\\s+video',
  'lyrics?\\s+visuali[sz]er',
  'visuali[sz]er',
  'v[i\u00ed]deo\\s*clipe?(?:\\s+oficial)?',
  '(?:v[i\u00ed]deo|audio|clipe)\\s+oficial',
  'letra(?:\\s+oficial)?',
  'con\\s+letra',
  'lyrics?',
  'cover\\s+art',
  'remastered\\s+in\\s+(?:4k|hd)',
  'official',
  'oficial',
  'audio',
  'video',
  'uhd',
  'hd',
  'hq',
  '4k',
  '8k',
  '1080p',
  '720p',
  'mv',
  'm\\/v',
  'explicit',
  'clean',
  'dirty',
  'premiere',
  'out\\s+now',
  'new\\s+song',
  'new\\s+single',
].join('|');
const DECOR_ANY = new RegExp(`\\b(?:${DECOR_ALT})\\b`, 'gi');
const DECOR_TAIL = new RegExp(`[\\s,:;/|-]+(?:${DECOR_ALT})[\\s,:;/|.!-]*$`, 'i');
const SEPARATORS_AT_ENDS = /^[\s,:;/&+|.!-]+|[\s,:;/&+|-]+$/g;
// One bracket group, innermost first. Titles are capped at 300 characters, so the worst case of this
// pattern (a run of unclosed openers) stays small.
const BRACKET_GROUP = /[([{\uff08\u3010\uff3b]([^()[\]{}\uff08\uff09\u3010\u3011\uff3b\uff3d]*)[)\]}\uff09\u3011\uff3d]/g;
const QUOTED = /[\u300c\u300e"]([^\u300c\u300d\u300e\u300f"]{1,120})[\u300d\u300f"]|(?:^|\s)'([^']{1,120})'(?=\s|$|[(\[])/g;
const TITLE_DASH = /\s+-+\s*|\s*-+\s+/;
const PIPE = /\s*[|\uff5c]\s*|\s+\/\/\s+/;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;

/** Bracket content without the decorations; '' when nothing else was in it. */
function cleanBracket(inner) {
  return inner.replace(DECOR_ANY, ' ').replace(/\s+/g, ' ').replace(SEPARATORS_AT_ENDS, '').trim();
}

/** Strip trailing decorations ("Song Official Video" → "Song"); never down to nothing. */
function stripTail(s) {
  let out = s;
  for (let n = 0; n < 6; n++) {
    const next = out.replace(DECOR_TAIL, '').trim();
    if (next === out || !words(next)) break;
    out = next;
  }
  return out;
}

/** Split on top-level dashes (not inside brackets). */
function splitDashes(s) {
  const kept = [];
  const masked = s.replace(BRACKET_GROUP, (m) => {
    kept.push(m);
    return `\u0001${kept.length - 1}\u0002`;
  });
  const restore = (p) => p.replace(/\u0001(\d+)\u0002/g, (_, n) => kept[Number(n)] || '');
  return masked
    .split(TITLE_DASH)
    .map((p) => restore(p).trim())
    .filter((p) => words(p.replace(BRACKET_GROUP, ' ')));
}

const CHANNEL_SUFFIX = /(?:\s*-\s*topic|vevo|\s+official(?:\s+(?:youtube\s+)?channel)?|\s+oficial|\s+official\s+artist\s+channel|\s+music|\s+tv|\s+channel)$/i;

/** "MaraValeVEVO" → "MaraVale", "Mara Vale - Topic" → "Mara Vale". */
function channelName(channel) {
  let s = channel;
  for (let n = 0; n < 3; n++) {
    const next = s.replace(CHANNEL_SUFFIX, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

/** Does `text` name `artist` somewhere (as whole words, stylised spellings folded the same way)? */
function mentions(text, artist) {
  const names = splitArtists(artist).filter((n) => n.replace(/\s+/g, '').length >= 2);
  if (!names.length) return false;
  const pieces = splitArtists(text).map((p) => ` ${p} `);
  return names.some((n) => pieces.some((p) => p.includes(` ${n} `)));
}

/**
 * Read a video title: which part names the artist, and the title text in a few cleaned readings.
 * @param {string} rawTitle
 * @param {string} wantedArtist
 * @param {string} [channelHint]  the uploader's name, for telling names from other words
 * @returns {{artistPart: string, primary: string, variants: string[], extraTags: string[]}}
 */
function readVideoTitle(rawTitle, wantedArtist, channelHint = '') {
  let t = unify(rawTitle).replace(HASHTAG, ' ');
  // Bracket groups lose their decorations ("(Dusk Unit Remix - Official Audio)" → "(Dusk Unit Remix)").
  for (let n = 0; n < 2; n++) {
    t = t.replace(BRACKET_GROUP, (m, inner) => {
      const rest = cleanBracket(inner);
      return rest ? `\u0003${rest}\u0004` : ' ';
    });
  }
  t = t.replace(/\u0003/g, '(').replace(/\u0004/g, ')').replace(/\s+/g, ' ').trim();
  // "Song (Official Video) | Artist", "Artist | Song": the segment that is not just the artist.
  const segments = t.split(PIPE).filter((p) => words(p));
  let main = segments[0] || t;
  if (segments.length > 1 && wantedArtist) {
    const bare = (p) => stripTail(p).replace(BRACKET_GROUP, ' ');
    if (artistScore(wantedArtist, bare(main)) >= 0.85 && words(bare(main)).length <= words(wantedArtist).length + 2) main = segments[1];
  }
  main = stripTail(main);

  const parts = splitDashes(main);
  let artistPart = '';
  let primary = main;
  if (parts.length >= 2) {
    const bare = (p) => p.replace(BRACKET_GROUP, ' ');
    const first = wantedArtist ? artistScore(wantedArtist, bare(parts[0])) : 0;
    const last = wantedArtist ? artistScore(wantedArtist, bare(parts[parts.length - 1])) : 0;
    if (first > 0 || !(last > 0)) {
      // "Artist - Title" (also the guess when neither side names the wanted artist)
      artistPart = parts[0];
      primary = parts.slice(1).join(' - ');
    } else {
      artistPart = parts[parts.length - 1];
      primary = parts.slice(0, -1).join(' - ');
    }
  }
  primary = stripTail(primary);
  const variants = [primary];
  const add = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && words(s) && !variants.includes(s)) variants.push(s);
  };
  add(main);
  // "Artist Song Official Video" (no dash): the title after the artist's name.
  if (wantedArtist) {
    const w = words(main.replace(BRACKET_GROUP, ' '));
    for (const name of [primaryArtist(wantedArtist), wantedArtist]) {
      const a = words(name);
      if (a && w.startsWith(a + ' ')) add(stripTail(w.slice(a.length + 1)));
    }
  }
  // K-pop / J-pop style: Artist 'Song' M/V, Artist「Song」 — only when nothing but artist names and
  // decorations is left outside the quotes ("Artist 'Song' but it's slowed" is somebody's edit).
  const unified = unify(rawTitle).replace(HASHTAG, ' ');
  const nameWords = new Set(words(`${wantedArtist} ${channelHint}`).split(' ').concat(CONNECTORS));
  for (const m of unified.matchAll(QUOTED)) {
    const outside = words(unified.replace(m[0], ' ').replace(BRACKET_GROUP, ' ').replace(DECOR_ANY, ' '));
    if (outside.split(' ').every((tok) => !tok || nameWords.has(tok))) add(m[1] || m[2]);
  }
  // Version words outside the title part: "Song - Somebody Remix", "#remix".
  let extraTags = [];
  if (artistPart) {
    const known = new Set(words(wantedArtist).split(' '));
    const rest = words(artistPart).split(' ').filter((tok) => tok && !known.has(tok)).join(' ');
    if (rest) extraTags = [...parseTitle(`x (${rest})`).tags];
  }
  const hashtags = [...unify(rawTitle).matchAll(HASHTAG)].map((m) => m[0].replace(/[#\s]+/g, ' ').trim()).join(' ');
  if (hashtags) extraTags = extraTags.concat([...parseTitle(`x (${hashtags.replace(/(\d+)/g, ' $1 ')})`).tags]);
  return { artistPart, primary, variants, extraTags };
}
const CONNECTORS = ['x', 'and', 'with', 'feat', 'ft', 'featuring', 'vs', 'prod', 'by', 'official'];

// Uploads that are some other recording or not the song at all. Run on the folded words of the whole
// video title; a trap is ignored when the wanted title / artist itself matches it ("Best of Both Coasts").
// Festivals and broadcast sessions: a set filmed on a stage, whatever the title says around it. Names that
// are also ordinary words ("Reading", "Download", "Wireless") count only with a year ("| Reading 2025").
const STAGES =
  'glastonbury|primavera sound|rock am ring|rock im park|rock werchter|rock in rio|roskilde|pinkpop|bonnaroo|governors ball|outside lands|austin city limits|' +
  'sziget|lowlands|creamfields|rolling loud|summer sonic|fuji rock|splendour in the grass|osheaga|electric picnic|vive latino|pyramid stage|' +
  'bbc music|bbc introducing|later with jools holland|jools holland|hootenanny|like a version|kexp|audiotree|sofar sounds|mahogany sessions?|la blogotheque';
const STAGE_YEAR = '(?:reading|leeds|reading and leeds|primavera|acl|download|wireless|parklife|hurricane|southside|firefly|proms|bbc proms|mad cool|ultra|lolla|main stage|other stage) (?:19|20)\\d\\d';
const YT_TRAPS = [
  ['live', new RegExp(`(?:^| )(?:live (?:at|from|in|on|session|sessions|performance|version|acoustic|lounge)|en vivo|ao vivo|en directo|in concert|tiny desk|live lounge|colors show|vevo dscvr|vevo ctrl|unplugged|spotify singles|saturday night live|snl|tonight show|jimmy fallon|jimmy kimmel|grammys|bbc radio|npr music|open mic|concert|festival|tour|tomorrowland\\s?\\d*|coachella|lollapalooza|ultra music festival|edc|boiler room|dj set|live set|full set|b2b|${STAGES}|${STAGE_YEAR})(?= |$)`, 'g')],
  ['live-tag', /(?:^| )live$/g],
  ['reaction', /(?:^| )(?:reacts?|reaction|reacting|first time hearing|review|breakdown|explained)(?= |$)/g],
  ['tutorial', /(?:^| )(?:tutorial|lesson|how to (?:play|sing|make|dance)|chords|tabs|synthesia|easy piano|piano cover|guitar cover|drum cover|bass cover|dance practice|choreography|dance cover|mirrored)(?= |$)/g],
  ['loop', /(?:^| )(?:\d+ ?(?:hours?|hrs?)|one hour|loop|looped|on repeat)(?= |$)/g],
  ['edit', /(?:^| )(?:bass ?boost(?:ed)?|8 ?d|16 ?d|nightcore|daycore|slowed|sped ?up|speed ?up|reverb|chipmunk|pitched|super slowed|tiktok (?:version|edit)|\d{3} ?hz|audio edit|edit audio|fan edit|but (?:its|it s|it is|youre|you re|with|in|slowed|sped)|if it (?:was|were)|[39] ?d(?: audio)?|theat(?:re|er) version|use headphones|concert hall|empty arena|another room|underwater|car audio|muffled|lofi|lo fi|phonk|jersey club|(?:rock|metal|piano|female|male|cut|short) version|best part)(?= |$)/g],
  ['demo', /(?:^| )(?:draft|demo|voice memo|rough (?:cut|mix|draft)|work in progress|wip|early version|from bed|bedroom version|alternate (?:version|bridge|take))(?= |$)/g],
  ['cover', /(?:^| )(?:karaoke|cover|covers|covered by|tribute|instrumental|acapella|a cappella|backing track|in the style of|kidz bop|8 ?bit|music box|lullaby|ringtone|remake|parody|type beat|ai cover)(?= |$)/g],
  ['promo', /(?:^| )(?:teaser|trailer|snippet|preview|sneak peek|behind the scenes|making of|interview|lyrics and meaning|fancam|fan ?made|unreleased|leaked|full album|album stream|mashup|mash up|megamix|medley|compilation|playlist|best of|top \d+)(?= |$)/g],
  ['translation', /(?:^| )(?:vietsub|thaisub|engsub|indosub|legendad[oa]|traducid[oa]|traduccion|traducao|traduzione|traduction|terjemahan|perevod|sub (?:espanol|ingles|english|indo)|subtitulad[oa]|letra (?:en espanol|traducida)|lyrics (?:traduccion|terjemahan|deutsch|espanol|francais))(?= |$)/g],
];
// The same idea where \b and spaces do not separate words.
const TRANSLATION_SCRIPT = /\u043f\u0435\u0440\u0435\u0432\u043e\u0434|\u4e2d\u5b57|\u4e2d\u6587\u5b57\u5e55|\u4e2d\u6587\u6b4c\u8a5e|\u4e2d\u6587\u6b4c\u8bcd|\u6b4c\u8a5e|\u6b4c\u8bcd|\uac00\uc0ac|\ud55c\uae00|\uc790\ub9c9|\u548c\u8a33|\u65e5\u672c\u8a9e\u8a33|\u0e41\u0e1b\u0e25|\u0e0b\u0e31\u0e1a/;
// Channels that publish edits of other people's songs.
const CHANNEL_TRAP = /(?:^| )(?:nightcore|daycore|sped ?up|speed ?up|slowed|reverb|8 ?d|16 ?d|bass ?boost(?:ed)?|karaoke|covers?|tribute|instrumentals?|piano|8 ?bit|lullab(?:y|ies)|kidz bop|music box|ringtones?|type beats?|remix(?:es)?)(?= |$)/;
const CHANNEL_REUPLOAD = /(?:^| )(?:lyrics?|letras?|vibes?|hub|nation|planet|world|sounds|beats|fans?|tunes|hits|records)(?= |$)/;
// Broadcasters and session series: what they upload of somebody else's song is a performance filmed for
// them (a festival set, a radio session, a talk-show slot), not the record. Only when the channel is not
// the artist's — or the broadcaster leads a shared upload ("BBC Music and <artist>": oEmbed names the
// broadcaster alone) — and the title does not say "official".
const BROADCASTER = /^(?:bbc(?: music| radio(?: \w+)?| introducing| sounds| one| two)?|kexp|triple j|like a version|later with jools holland|jools holland|npr music|tiny desk|colors|a colors show|colorsxstudios|audiotree|sofar sounds|mahogany|la blogotheque|genius|vevo|spotify|apple music|amazon music|the tonight show(?: starring jimmy fallon)?|jimmy kimmel live|the late show(?: with stephen colbert)?|the late late show|saturday night live|snl|the graham norton show)$/;
const OFFICIAL_WORD = /(?:^| )(?:official|oficial)(?= |$)/;
const OFFICIAL_AUDIO = /(?:^| )(?:official (?:hd |4k )?audio|audio oficial)(?= |$)/;
const OFFICIAL_VIDEO = /(?:^| )(?:official (?:\w+ )?video|video oficial|videoclip oficial|music video)(?= |$)/;
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const NAMED_TAKE = /(?:^| )([\p{L}\p{N}]+) (?:version|versi\u00f3n|ver)(?= |$)/gu;
// Words that say which cut of the SAME recording an upload is, not whose take it is.
const VERSION_WORDS = new Set(
  ('album single radio original extended clean explicit dirty studio full official video audio lyric lyrics short long edit club dub mix ' +
    'remastered remaster deluxe acoustic live instrumental sped slowed english spanish espanol french portuguese korean japanese ' +
    'new old the this music visualizer visualiser vinyl cd digital mono stereo uncensored censored tiktok remix final alternate ' +
    'alternative bonus orchestral piano acapella karaoke edited uncut unmixed mixed theatrical mv performance dance eng ' +
    '1 2 3 4 5 20 21 22 23 24 25 26 2020 2021 2022 2023 2024 2025 2026 movie film')
    .split(' '),
);
const CLEAN_EDIT = /(?:^| )(?:clean|clean version|radio edit|radio version|censored|kids version)(?= |$)/;

/** The channel's name starts with the artist's ("MARAVALEYRN" for Mara Vale). Names under 4 letters never do. */
function artistPrefix(wantedArtist, chanName) {
  const chan = splitArtists(chanName).join('').replace(/\s+/g, '');
  return splitArtists(wantedArtist)
    .slice(0, 2)
    .some((name) => {
      const n = name.replace(/\s+/g, '');
      return n.length >= 4 && chan.startsWith(n) && chan.length - n.length <= 8;
    });
}

// Candidate carries a version tag the wanted title lacks → another recording. Sized so that an
// otherwise perfect upload lands below YT_ACCEPT.
const PENALTY_EXTRA = { cover: 0.6, tempo: 0.6, instrumental: 0.6, acapella: 0.6, medley: 0.5, remix: 0.5, live: 0.45, acoustic: 0.45, demo: 0.4, orchestral: 0.45, section: 0.4, rerecorded: 0.35, extended: 0.4, named: 0.4 };
// Wanted title asks for a version the upload does not claim to be.
const PENALTY_MISSING = { cover: 0.2, tempo: 0.45, instrumental: 0.45, acapella: 0.45, medley: 0.3, remix: 0.45, live: 0.25, acoustic: 0.3, demo: 0.15, orchestral: 0.2, section: 0.36, rerecorded: 0.1, extended: 0.2, named: 0.4 };
const TRAP_PENALTY = 0.6;

/** 1 for ≤ 3 s, still good to 8 s, weak past 15 s, nothing at 60 s. `d` = |Δ| in seconds. */
function durationFit(d) {
  if (d <= 3) return 1;
  if (d <= 8) return 1 - 0.03 * (d - 3);
  if (d <= 15) return 0.85 - 0.05 * (d - 8);
  return Math.max(0, 0.5 - (0.5 * (d - 15)) / 45);
}

const knownArtist = (a) => (typeof a === 'string' && a.trim() && a.trim() !== UNKNOWN_ARTIST ? a.trim() : '');

/**
 * Score one search result against the wanted track, with the reasons (for reports and tests).
 * @param {import('./index.js').TrackMeta} track
 * @param {YtCandidate} c
 * @returns {{score: number, rankScore: number, title: number, artist: number|null, durationDelta: number|null, penalty: number, evidence: string, reason: string, translit: boolean, titleBase: string}}
 */
export function scoreVideoDetail(track, c) {
  const none = (reason) => ({ score: 0, rankScore: 0, title: 0, artist: null, durationDelta: null, penalty: 1, evidence: '', reason, translit: false, titleBase: '' });
  if (!track || typeof track.title !== 'string' || !c || typeof c.title !== 'string') return none('bad input');
  const wantedArtist = knownArtist(track.artist);
  const w = parseTitle(track.title);
  if (!w.base) return none('no title');
  if (!words(c.title)) return none('no video title');
  const channel = typeof c.channel === 'string' ? c.channel : '';
  const chanName = channelName(channel);
  const read = readVideoTitle(c.title, wantedArtist, chanName);
  const primary = parseTitle(read.primary);
  const reasons = [];

  /* artist evidence */
  let artist = null;
  let evidence = 'none';
  let chanScore = 0;
  if (wantedArtist) {
    chanScore = Math.max(artistScore(wantedArtist, channel), artistScore(wantedArtist, chanName));
    // A merely similar channel name ("MaraValeFan13" for Mara Vale) is somebody's fan upload unless YouTube
    // has verified the channel.
    if (chanScore > 0 && chanScore < 0.9 && !c.verified) chanScore = 0;
    // An Official Artist Channel named after the artist plus a nickname or a label tag
    // ("Mara Vale Nights", "MARAVALEYRN", "MaraValeMusicPR"). Only with the badge: anyone can call a channel that.
    if (chanScore < 0.85 && c.verifiedArtist && artistPrefix(wantedArtist, chanName)) chanScore = 0.9;
    // The credit in front of the dash has to LEAD with one of the wanted artists: "Somebody ft. Artist -
    // Song" is somebody else's record (a remix, a parody) that the wanted artist is only a guest on.
    const credit = read.artistPart ? read.artistPart.replace(BRACKET_GROUP, ' ') : '';
    const lead = credit ? splitArtists(credit)[0] || '' : '';
    const leadKnown = !credit || (lead && artistScore(wantedArtist, lead) > 0);
    const inTitle = Math.max(credit && leadKnown ? artistScore(wantedArtist, credit) : 0, primary.feat.length && leadKnown ? artistScore(wantedArtist, primary.feat.join(', ')) : 0);
    const named = inTitle >= 0.85 || (leadKnown && mentions(c.title, wantedArtist));
    if (c.topic && chanScore >= 0.85) [artist, evidence] = [1, 'topic'];
    else if (chanScore >= 0.85 && c.verifiedArtist) [artist, evidence] = [1, 'artist channel'];
    else if (chanScore >= 0.85 && c.verified) [artist, evidence] = [0.97, 'verified channel'];
    else if (chanScore >= 0.85) [artist, evidence] = [0.92, 'channel'];
    else if (named && c.verifiedArtist) [artist, evidence] = [0.95, 'title + artist badge'];
    else if (named && c.verified) [artist, evidence] = [0.9, 'title + verified'];
    else if (named) [artist, evidence] = [0.85, 'title'];
    else [artist, evidence] = [0, 'none'];
    // A featured artist's own channel / credit is still the record, a little less surely.
    if (artist > 0 && Math.max(chanScore, inTitle) < 1 && Math.max(chanScore, inTitle) >= 0.85 && !named) artist = Math.min(artist, 0.9);
  } else evidence = 'no artist wanted';

  /* title */
  const artistTokens = new Set();
  for (const src of [wantedArtist, read.artistPart, chanName, ...w.feat, ...primary.feat]) {
    for (const tok of words(src || '').split(' ')) if (tok) artistTokens.add(tok);
  }
  let title = 0;
  let titleBase = primary.base;
  for (const v of read.variants) {
    const p = v === read.primary ? primary : parseTitle(v);
    let sim = titleSimilarity(w.base, p.base, artistTokens);
    if (sim < 0.9 && censoredEqual(w.baseRaw, p.baseRaw)) sim = 0.95;
    if (sim > title) {
      title = sim;
      titleBase = p.base;
    }
  }

  /* length */
  const wantS = track.durationMs > 0 ? track.durationMs / 1000 : null;
  const gotS = typeof c.durationS === 'number' && c.durationS > 0 ? c.durationS : null;
  const delta = wantS != null && gotS != null ? Math.abs(wantS - gotS) : null;
  // "Song - Subtitle" on one side only: the same song if the length agrees.
  if (title < 0.9 && delta != null && delta <= 3) {
    const sub = (x, y) => x.head && titleSimilarity(x.head, y.base, artistTokens) >= 0.9;
    if (sub(w, primary) || sub(primary, w)) title = 0.9;
  }

  /* versions and traps */
  let penalty = 0;
  const cTags = new Set([...primary.tags, ...read.extraTags]);
  for (const tag of Object.keys(PENALTY_EXTRA)) {
    const inW = w.tags.has(tag);
    const inC = cTags.has(tag);
    if (inC && !inW) {
      penalty += PENALTY_EXTRA[tag];
      reasons.push(`+${tag}`);
    } else if (inW && !inC) {
      penalty += PENALTY_MISSING[tag];
      reasons.push(`-${tag}`);
    }
  }
  if (w.tags.has('remix') && cTags.has('remix') && w.remixBy && primary.remixBy && !sameRemixer(w.remixBy, primary.remixBy)) {
    penalty += 0.45;
    reasons.push('other-remix');
  }
  if (w.tags.has('named') && cTags.has('named') && w.named !== primary.named) {
    penalty += 0.45;
    reasons.push('other-named');
  }
  const wantedText = words(`${track.title} ${wantedArtist}`);
  const videoText = words(c.title);
  let trapped = '';
  // A trap word the wanted title or artist has itself is not a trap ("Born to Live", "Best of Both Coasts").
  const padded = ` ${wantedText} `;
  for (const [name, re] of YT_TRAPS) {
    for (const m of videoText.matchAll(re)) {
      if (!padded.includes(` ${m[0].trim()} `)) {
        trapped = name;
        break;
      }
    }
    if (trapped) break;
  }
  if (!trapped && TRANSLATION_SCRIPT.test(c.title.normalize('NFC')) && !TRANSLATION_SCRIPT.test(`${track.title} ${wantedArtist}`.normalize('NFC'))) trapped = 'translation';
  // "<Somebody> version" / "<Somebody>'s version": another singer's take ("Arden version").
  if (!trapped) {
    const known = new Set(wantedText.split(' '));
    for (const m of videoText.matchAll(NAMED_TAKE)) {
      const who = m[1];
      if (!VERSION_WORDS.has(who) && !known.has(who) && !known.has(who.replace(/s$/, ''))) {
        trapped = 'other-version';
        break;
      }
    }
  }
  if (trapped) {
    penalty += TRAP_PENALTY;
    reasons.push(`trap:${trapped}`);
  }
  const chanWords = words(channel);
  if (chanScore < 0.85 && CHANNEL_TRAP.test(chanWords) && !CHANNEL_TRAP.test(wantedText)) {
    penalty += 0.5;
    reasons.push('edit-channel');
  }
  const leadChannel = chanWords.split(' and ')[0];
  if (wantedArtist && (chanScore < 0.85 || leadChannel !== chanWords) && BROADCASTER.test(leadChannel) && !OFFICIAL_WORD.test(videoText) && !padded.includes(` ${leadChannel} `)) {
    penalty += 0.5;
    reasons.push('broadcaster');
  }
  // The radio edit of an explicit song has words cut out: same song, a worse copy.
  if (track.explicit === true && CLEAN_EDIT.test(videoText) && !CLEAN_EDIT.test(wantedText)) {
    penalty += 0.12;
    reasons.push('clean');
  }
  // Somebody else's upload of the song: fine as a last resort, never ahead of the artist's own.
  let bonus = 0;
  if (wantedArtist && chanScore < 0.85 && !c.verified) {
    bonus -= CHANNEL_REUPLOAD.test(chanWords) ? 0.05 : 0.03;
  }
  // A title in a script neither the wanted title nor artist uses: usually a fan upload with a translation.
  if (NON_LATIN.test(c.title) && !NON_LATIN.test(`${track.title} ${wantedArtist}`) && chanScore < 0.85) {
    penalty += 0.12;
    reasons.push('foreign-script');
  }

  /* length rules */
  let durFit = null;
  if (delta != null) {
    durFit = durationFit(delta);
    if (delta > 15) {
      penalty += 0.12 + 0.28 * Math.min(1, (delta - 15) / 45);
      reasons.push(`len+${Math.round(delta)}s`);
    }
  } else if (gotS != null) {
    // Nothing to compare with (a pasted line): only absurd lengths are out.
    if (gotS < 60 || gotS > 900) {
      penalty += 0.5;
      reasons.push('odd-length');
    } else if (gotS > 480) penalty += 0.1;
  } else {
    penalty += 0.1;
    reasons.push('no-length');
  }

  /* preferences among equals */
  if (c.topic && chanScore >= 0.85) bonus += 0.03;
  if (c.verifiedArtist && chanScore >= 0.85) bonus += 0.02;
  if (OFFICIAL_AUDIO.test(videoText)) bonus += 0.02;
  else if (OFFICIAL_VIDEO.test(videoText)) bonus += 0.005;
  if (Number.isFinite(c.rank)) bonus += 0.01 * Math.max(0, 1 - c.rank / 10);

  const a = artist == null ? 0.72 : artist;
  let score = durFit == null ? 0.6 * title + 0.4 * a : 0.5 * title + 0.3 * a + 0.2 * durFit;
  score -= penalty;

  let translit = false;
  if (title < 0.6) {
    // Different words. Exception: the artist's own channel, the same length to the second, and the two
    // titles in different scripts (夜の港 vs "Yoru no Minato") — a transliteration, not another song.
    const scripts = NON_LATIN.test(w.base) !== NON_LATIN.test(titleBase);
    if (scripts && artist != null && artist >= 0.92 && delta != null && delta <= 2 && penalty === 0) {
      score = Math.max(score, 0.72);
      translit = true;
      reasons.push('translit');
    } else {
      score = Math.min(score, 0.35);
      reasons.push('title');
    }
  } else if (artist === 0) {
    // Right title, nobody we know. Accept only for an artist written in another script (星野 vs a
    // romanised "Hoshino" channel) when the upload is an official one and title + length agree exactly.
    const scripts = NON_LATIN.test(fold(wantedArtist)) !== NON_LATIN.test(fold(`${channel} ${c.title}`));
    if (scripts && (c.topic || c.verifiedArtist) && title >= 0.97 && delta != null && delta <= 2 && penalty === 0) {
      score = Math.max(score, 0.72);
      reasons.push('translit-artist');
    } else {
      score = Math.min(score, 0.3);
      reasons.push('artist');
    }
  }
  if (c.live) {
    score = 0;
    reasons.push('live-stream');
  }
  if (delta != null && delta > 60) {
    score = 0;
    reasons.push('length');
  }
  score = Math.max(0, Math.min(1, score));
  const rankScore = score > 0 ? score + bonus : 0;
  const shown = Math.max(0, Math.min(1, score + Math.min(0, bonus)));
  return {
    score: Math.round(shown * 1000) / 1000,
    rankScore,
    title,
    artist,
    durationDelta: delta == null ? null : Math.round(delta * 10) / 10,
    penalty: Math.round(penalty * 1000) / 1000,
    evidence,
    reason: reasons.join(' '),
    translit,
    titleBase,
  };
}

function sameRemixer(a, b) {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 0..1: is this upload the wanted recording? (≥ YT_ACCEPT = play it.)
 * @param {import('./index.js').TrackMeta} track
 * @param {YtCandidate} c
 */
export function scoreVideo(track, c) {
  return scoreVideoDetail(track, c).score;
}

/**
 * Candidates sorted best first, with their details. Uploads accepted only as transliterations are
 * dropped when two of them disagree about the title (the length was a coincidence for one of them).
 * @param {import('./index.js').TrackMeta} track
 * @param {YtCandidate[]} candidates
 */
export function rankVideos(track, candidates) {
  const scored = candidates.map((c) => ({ c, d: scoreVideoDetail(track, c) }));
  const guesses = scored.filter((s) => s.d.translit && s.d.score >= YT_ACCEPT);
  if (new Set(guesses.map((s) => s.d.titleBase)).size > 1) {
    for (const s of guesses) s.d = { ...s.d, score: Math.min(s.d.score, 0.4), rankScore: Math.min(s.d.rankScore, 0.4), reason: `${s.d.reason} ambiguous` };
  }
  return scored.sort((x, y) => y.d.rankScore - x.d.rankScore || x.c.rank - y.c.rank);
}

/* ------------------------------------------------------------------ queries */

const quoteless = (s) => String(s || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The search queries for a track, best first. The first is the artist (first credited only) and the
 * title with its version words (remix / edit / live / acoustic / sped up / extended …) but without
 * "feat." credits; title only when there is no artist. The others run only when the ones before
 * found nothing acceptable (or nothing at all).
 * @param {import('./index.js').TrackMeta} track
 * @returns {string[]}
 */
export function youtubeQueries(track) {
  if (!track || typeof track.title !== 'string') return [];
  const info = parseTitle(track.title);
  const base = quoteless(info.baseRaw || cleanText(track.title));
  let version = quoteless(info.versionRaw);
  // "Extended Mix" carries no tag that versionRaw keeps, but on YouTube it is a different upload.
  if (info.tags.has('extended') && !/extended|club|12/i.test(version)) {
    const ext = info.extras.find((e) => /\b(?:extended|club|12|long|maxi)\b/.test(e));
    if (ext) version = quoteless(`${version} ${ext}`);
  }
  const artist = quoteless(primaryArtist(knownArtist(track.artist)));
  const first = [artist, base, version].filter(Boolean).join(' ');
  // YouTube answers some exact queries with a "Confirm your age" wall and no results (seen
  // 2026-10-05 for two chart hits); one more word gets past it, and which word varies.
  const out = [first, `${first} official audio`, `${first} lyrics`];
  return out.filter((q, i) => q.trim() && out.indexOf(q) === i);
}

/** Search page URL on YouTube. */
export const searchUrl = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

/* ------------------------------------------------------------------ relays */

/**
 * @typedef {Object} YtRelay
 * @property {string} name
 * @property {(target: string) => {url: string, headers?: Record<string,string>}} build
 */

/**
 * In the order they are asked. Measured from a browser origin on 2026-10-05, 10 searches each
 * (tests/e2e/youtube.e2e.mjs, group "relays"): scraper 10/10, median 0.78 s, max 0.94 s, ~1.3 MB JSON;
 * jina 10/10, median 1.6 s, max 2.5 s, ~1.3-2.1 MB HTML, and a ~20 requests/minute free tier.
 * @type {YtRelay[]}
 */
export const YT_RELAYS = [
  {
    name: 'scraper',
    build: (target) => ({ url: `https://web.scraper.workers.dev/?url=${encodeURIComponent(target)}&selector=script&scrape=text` }),
  },
  {
    name: 'jina',
    build: (target) => ({ url: `https://r.jina.ai/${target}`, headers: { 'X-Return-Format': 'html' } }),
  },
];

/** @type {FetchText} */
const defaultFetchText = (url, opts = {}) =>
  request(url, { signal: opts.signal, timeoutMs: opts.timeoutMs, headers: opts.headers, as: 'text', maxBytes: opts.maxBytes });

const memoryStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // a sandboxed frame or blocked site data throws on access
  }
};

/* ------------------------------------------------------------------ the finder */

/**
 * @param {{fetchText?: FetchText, storage?: Storage|null, relays?: YtRelay[], hedgeMs?: number, timeoutMs?: number,
 *          searchLimiter?: ReturnType<typeof createLimiter>, relayLimiters?: Record<string, ReturnType<typeof createLimiter>>,
 *          oembed?: boolean, now?: () => number}} [cfg]
 *   storage: null = no persistence; omitted = window.localStorage when there is one
 *   oembed: false skips the embeddability check (tests of other parts)
 */
export function createYouTubeFinder(cfg = {}) {
  const fetchText = cfg.fetchText || defaultFetchText;
  const storage = cfg.storage === undefined ? memoryStorage() : cfg.storage;
  const relays = cfg.relays || YT_RELAYS;
  const now = cfg.now || (() => Date.now());
  const timeoutMs = cfg.timeoutMs || ATTEMPT_TIMEOUT_MS;
  const hedgeMs = cfg.hedgeMs ?? HEDGE_MS;
  // One search at a time, lightly spaced, at most SEARCHES_PER_MINUTE: the relays are free services
  // shared with everyone, and a set needs one search per song, minutes apart.
  const searchLimiter = cfg.searchLimiter || createLimiter({ max: SEARCHES_PER_MINUTE, windowMs: 60000, concurrency: 1, minGapMs: 250 });
  const relayLimiters = cfg.relayLimiters || { jina: createLimiter({ max: JINA_PER_MINUTE, windowMs: 60000 }) };

  /** @type {Map<string, {fails: number, demotedUntil: number}>} */
  const health = new Map(relays.map((r) => [r.name, { fails: 0, demotedUntil: 0 }]));
  /** @type {Map<string, YtMatch | ResolveError>} */
  const memory = new Map();
  /** @type {Map<string, {promise: Promise<any>, ctrl: AbortController, waiters: number}>} */
  const inflight = new Map();
  /** Video ids that refused to play this session (forget()); never picked again. */
  const refused = new Set();
  const stats = { finds: 0, searches: 0, memoryHits: 0, storageHits: 0, noMatch: 0, network: 0, oembedDropped: 0, oembedMismatch: 0, relay: Object.fromEntries(relays.map((r) => [r.name, { ok: 0, fail: 0, ms: [] }])) };

  const rememberMemory = (key, value) => {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
    memory.set(key, value);
  };

  /* ---------- persistent cache ---------- */

  /** The stored record's time when it is a usable one (well-formed, at most 60 days old, not from the future), else NaN. */
  function recordTime(key, rec) {
    if (typeof key !== 'string' || key.length > STORAGE_KEY_MAX) return NaN;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.videoId !== 'string' || !VIDEO_ID.test(rec.videoId)) return NaN;
    const t = typeof rec.t === 'number' ? rec.t : NaN;
    const at = now();
    return Number.isFinite(t) && at - t <= STORAGE_TTL_MS && t <= at + STORAGE_FUTURE_MS ? t : NaN;
  }

  /** Drop expired, future-stamped and malformed records, then the oldest past the cap. True when anything went. */
  function prune(all) {
    let changed = false;
    const times = new Map();
    for (const k of Object.keys(all)) {
      const t = recordTime(k, all[k]);
      if (Number.isNaN(t)) {
        delete all[k];
        changed = true;
      } else times.set(k, t);
    }
    if (times.size > STORAGE_MAX) {
      const keys = [...times.keys()].sort((a, b) => times.get(a) - times.get(b));
      for (const k of keys.slice(0, keys.length - STORAGE_MAX)) delete all[k];
      changed = true;
    }
    return changed;
  }

  let swept = false;
  function readStore() {
    if (!storage) return {};
    try {
      const raw = storage.getItem(YT_STORAGE_KEY);
      if (typeof raw !== 'string') return {};
      if (raw.length > 4 * 1024 * 1024) {
        storage.removeItem(YT_STORAGE_KEY); // nothing this finder writes gets near this
        return {};
      }
      const parsed = JSON.parse(raw);
      const all = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      // Once per finder (page visit): what is past its 60 days is deleted, not just skipped, even when
      // nothing new gets written.
      if (!swept) {
        swept = true;
        if (prune(all)) storage.setItem(YT_STORAGE_KEY, JSON.stringify(all));
      }
      return all;
    } catch {
      return {};
    }
  }

  const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 86400 ? v : null);
  const badgeOf = (c) => (c.verifiedArtist ? 'a' : c.verified ? 'v' : '');
  const asBadge = (b) => (b === 'a' || b === 'v' ? b : '');

  /** A stored record → YtMatch (not yet re-checked this visit), or null when it is malformed, stale or refused. */
  function fromRecord(key, rec) {
    if (Number.isNaN(recordTime(key, rec))) return null;
    const info = Array.isArray(rec.alts) ? rec.alts : [];
    const ids = [{ videoId: rec.videoId, durationS: posNum(rec.durationS), badge: asBadge(rec.b) }];
    (Array.isArray(rec.alternates) ? rec.alternates.slice(0, 20) : []).forEach((id, i) => {
      if (typeof id !== 'string' || !VIDEO_ID.test(id) || ids.some((x) => x.videoId === id)) return;
      const x = info[i] && typeof info[i] === 'object' ? info[i] : {};
      ids.push({ videoId: id, durationS: posNum(x.d), badge: asBadge(x.b) });
    });
    const left = ids.filter((x) => !refused.has(x.videoId));
    if (!left.length) return null;
    const same = left[0].videoId === rec.videoId;
    const score = Number(rec.score);
    const alts = left.slice(1, 1 + MAX_ALTERNATES);
    return {
      videoId: left[0].videoId,
      title: same ? cleanText(rec.title, 300) : '',
      channel: same ? cleanText(rec.channel, 200) : '',
      durationS: left[0].durationS,
      score: same && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : YT_ALTERNATE,
      badge: left[0].badge,
      alternates: alts.map((x) => x.videoId),
      altInfo: alts.map((x) => ({ durationS: x.durationS, badge: x.badge })),
    };
  }

  /** Merge one entry into what is stored now (another tab may have written since); expired and excess records out. */
  function writeStore(key, match, t = now()) {
    if (!storage) return;
    try {
      const all = readStore();
      if (match) {
        all[key] = {
          videoId: match.videoId,
          alternates: match.alternates.slice(0, MAX_ALTERNATES),
          alts: match.altInfo.slice(0, MAX_ALTERNATES).map((x) => ({ d: x.durationS, b: x.badge })),
          t,
          title: match.title.slice(0, 120),
          channel: match.channel.slice(0, 80),
          durationS: match.durationS,
          score: match.score,
          b: match.badge,
        };
      } else delete all[key];
      prune(all);
      storage.setItem(YT_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* quota, private mode, blocked storage: the memory cache still works */
    }
  }

  /* ---------- search ---------- */

  function relayOrder() {
    const t = now();
    return relays
      .map((r, i) => ({ r, i, down: health.get(r.name).demotedUntil > t ? 1 : 0 }))
      .sort((a, b) => a.down - b.down || a.i - b.i)
      .map((x) => x.r);
  }

  function noteRelay(relay, ok, ms) {
    const h = health.get(relay.name);
    const s = stats.relay[relay.name];
    if (ok) {
      h.fails = 0;
      h.demotedUntil = 0;
      s.ok++;
      if (s.ms.length < 500) s.ms.push(ms);
    } else {
      s.fail++;
      if (++h.fails >= DEMOTE_AFTER) {
        h.demotedUntil = now() + DEMOTE_MS;
        h.fails = 0;
      }
    }
  }

  /** One relay, one try → {kind: 'page', candidates, via} | {kind: 'fail', reason, reached?}. */
  async function tryRelay(relay, query, signal) {
    const req = relay.build(searchUrl(query));
    const limiter = relayLimiters[relay.name];
    const t0 = now();
    let res;
    try {
      const go = () => fetchText(req.url, { signal, timeoutMs, headers: req.headers, maxBytes: MAX_PAGE_BYTES });
      res = limiter ? await limiter.schedule(go, { signal, maxWaitMs: JINA_MAX_WAIT_MS }) : await go();
    } catch (err) {
      if (isAbort(err)) throw err;
      const code = err instanceof SourceError ? err.code : 'network';
      // 'busy' = our own per-minute budget for this relay is spent: not the relay's fault.
      if (code !== 'busy') noteRelay(relay, false);
      return { kind: 'fail', via: relay.name, reason: code };
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      if (status === 429 && limiter) limiter.pause(BACKOFF_MS);
      if (status === 429) health.get(relay.name).demotedUntil = now() + BACKOFF_MS;
      noteRelay(relay, false);
      return { kind: 'fail', via: relay.name, reason: `http ${status}` };
    }
    const page = readSearchPage(typeof res.body === 'string' ? res.body : '');
    if (!page.found) {
      noteRelay(relay, false);
      return { kind: 'fail', via: relay.name, reason: 'no results page' };
    }
    noteRelay(relay, true, now() - t0);
    // A results page with no videos is an answer too, but the other relay gets a say first.
    if (!page.candidates.length) return { kind: 'fail', via: relay.name, reason: 'no videos', reached: true };
    return { kind: 'page', via: relay.name, candidates: page.candidates };
  }

  /**
   * Raw search through the relays (serialised). [] when YouTube answered with no videos.
   * @param {string} query
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<YtCandidate[]>}  throws ResolveError('network') when no relay could be read
   */
  async function search(query, opts = {}) {
    const { signal } = opts;
    throwIfAborted(signal);
    const q = quoteless(query).slice(0, 200);
    if (!q) return [];
    return searchLimiter.schedule(async () => {
      stats.searches++;
      const attempts = relayOrder().map((relay) => (sig) => tryRelay(relay, q, sig));
      const { result, failures } = await hedgedChain(attempts, { signal, hedgeMs });
      throwIfAborted(signal);
      if (result) return result.candidates;
      if (failures.some((f) => f.reached)) return [];
      stats.network++;
      const detail = failures.map((f) => `${f.via || '?'}: ${f.reason}`).join('; ');
      const err = new ResolveError('network', "Couldn't reach YouTube — try again in a moment.");
      /** @type {any} */ (err).detail = detail;
      throw err;
    }, { signal });
  }

  /* ---------- embeddability ---------- */

  /**
   * What YouTube itself says about a video: {verdict: 'gone'} when it cannot be embedded / does not exist,
   * {verdict: 'ok', title, channel} with its real title and channel, {verdict: 'unknown'} otherwise.
   */
  async function oembed(videoId, signal) {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    try {
      const res = await fetchText(url, { signal, timeoutMs: OEMBED_TIMEOUT_MS, maxBytes: MAX_OEMBED_BYTES });
      if (res && (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404)) return { verdict: 'gone' };
      if (!res || !res.ok) return { verdict: 'unknown' };
      const body = parseObject(typeof res.body === 'string' ? res.body : '');
      const title = body ? cleanText(body.title, 300) : '';
      if (!title) return { verdict: 'unknown' }; // not an oEmbed answer: proves nothing either way
      return { verdict: 'ok', title, channel: cleanText(body.author_name, 200) };
    } catch (err) {
      if (isAbort(err) && signal && signal.aborted) throw err;
      return { verdict: 'unknown' }; // a failed check proves nothing; the deck still has the alternates
    }
  }

  /**
   * Check uploads with oEmbed (in parallel) against the track. Gone: refused for the session. Otherwise
   * the upload is scored again with the title and channel YouTube reports (the relay's length and badges
   * kept, as oEmbed has neither): one that no longer reads as this recording — a relay that lied about
   * which video carries which title, a stored mapping gone stale — is dropped for this track. A check that
   * failed proves nothing: the upload stays as claimed.
   * @param {import('./index.js').TrackMeta} track
   * @param {{c: YtCandidate, d: {score: number}}[]} entries
   * @returns {Promise<{c: YtCandidate, d: {score: number}}[]>} the ones kept, in order
   */
  async function verify(track, entries, signal) {
    const answers = await Promise.all(entries.map((e) => oembed(e.c.videoId, signal)));
    const kept = [];
    entries.forEach((e, i) => {
      const o = answers[i];
      if (o.verdict === 'gone') {
        stats.oembedDropped++;
        refused.add(e.c.videoId);
      } else if (o.verdict === 'unknown') kept.push(e);
      else {
        const c = { ...e.c, title: o.title, channel: o.channel, topic: e.c.topic || / - Topic$/.test(o.channel) };
        const d = scoreVideoDetail(track, c);
        if (d.score >= YT_ALTERNATE) kept.push({ c, d });
        else stats.oembedMismatch++; // not refused: it may well be the right video for another track
      }
    });
    return kept;
  }

  /** The first kept upload good enough to play, the rest as alternates → YtMatch, or null. */
  function toMatch(kept) {
    const at = kept.findIndex((e) => e.d.score >= YT_ACCEPT);
    if (at < 0) return null;
    const best = kept[at];
    const alts = kept.filter((_, i) => i !== at).slice(0, MAX_ALTERNATES);
    return {
      videoId: best.c.videoId,
      title: best.c.title,
      channel: best.c.channel,
      durationS: best.c.durationS,
      score: best.d.score,
      badge: badgeOf(best.c),
      alternates: alts.map((e) => e.c.videoId),
      altInfo: alts.map((e) => ({ durationS: posNum(e.c.durationS), badge: badgeOf(e.c) })),
    };
  }

  /**
   * A stored mapping, checked once per visit before it is used (it may have been written by an older
   * version, by a clock that was wrong, or by another page of this origin). null = search again.
   */
  async function recheck(track, stored, signal) {
    const claim = (videoId, rank, title, channel, durationS, badge) => ({ videoId, title, channel, durationS, verifiedArtist: badge === 'a', verified: badge !== '', topic: / - Topic$/.test(channel), rank, live: false });
    const entries = [
      { c: claim(stored.videoId, 0, stored.title, stored.channel, stored.durationS, stored.badge), d: { score: stored.score } },
      ...stored.alternates.map((id, i) => ({ c: claim(id, i + 1, '', '', stored.altInfo[i].durationS, stored.altInfo[i].badge), d: { score: YT_ALTERNATE } })),
    ];
    return toMatch(await verify(track, entries, signal));
  }

  /* ---------- find ---------- */

  const trackKey = (track) => `${words(knownArtist(track.artist))}|${words(track.title)}`;

  async function lookup(track, signal) {
    const queries = youtubeQueries(track);
    /** @type {Map<string, YtCandidate>} */
    const pool = new Map();
    let reached = false;
    let lastError = null;
    let ranked = [];
    for (let qi = 0; qi < queries.length; qi++) {
      let hits;
      try {
        hits = await search(queries[qi], { signal });
        reached = true;
      } catch (err) {
        if (isAbort(err)) throw err;
        lastError = err;
        continue;
      }
      for (const h of hits) {
        if (refused.has(h.videoId)) continue;
        const prev = pool.get(h.videoId);
        // Later queries rank behind the first: their order says less about this track.
        const rank = h.rank + qi * MAX_CANDIDATES;
        if (!prev || rank < prev.rank) pool.set(h.videoId, { ...h, rank });
      }
      ranked = rankVideos(track, [...pool.values()]);
      // The second query costs a relay request; only a miss pays for it.
      if (ranked.length && ranked[0].d.score >= YT_ACCEPT) break;
    }
    if (!reached) {
      throw lastError instanceof ResolveError ? lastError : new ResolveError('network', "Couldn't reach YouTube — try again in a moment.", { cause: lastError });
    }
    // Alternates stand in without another look, so they must be the same cut: close to the length of
    // the track (or of the chosen upload, when that is itself a long music video).
    let list = ranked.filter((r) => r.d.score >= YT_ALTERNATE);
    if (list.length) {
      const room = Math.max(12, (list[0].d.durationDelta ?? 0) + 3);
      list = [list[0], ...list.slice(1).filter((r) => r.d.durationDelta == null || r.d.durationDelta <= room)];
    }
    if (!list.some((r) => r.d.score >= YT_ACCEPT)) return null;
    if (cfg.oembed === false) return toMatch(list.slice(0, 1 + MAX_ALTERNATES));
    // Only uploads YouTube has vouched for (or could not be asked about) are returned, alternates included:
    // they go to the deck without another look.
    return toMatch(await verify(track, list.slice(0, OEMBED_CHECKS), signal));
  }

  /** Run `work` once per key however many callers ask; cancel it only when all of them have left. */
  function share(key, work, signal) {
    let entry = inflight.get(key);
    if (!entry) {
      const ctrl = new AbortController();
      const created = { ctrl, waiters: 0, promise: /** @type {Promise<any>} */ (Promise.resolve()) };
      created.promise = work(ctrl.signal).finally(() => {
        if (inflight.get(key) === created) inflight.delete(key);
      });
      created.promise.catch(() => {});
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

  const copy = (m) => ({ ...m, alternates: m.alternates.slice(), altInfo: m.altInfo.map((x) => ({ ...x })) });

  /**
   * The video to play for a track.
   * @param {import('./index.js').TrackMeta} track
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<YtMatch>}  throws ResolveError 'no-match' (searched, nothing safe to play) | 'network'
   */
  async function find(track, opts = {}) {
    const { signal } = opts;
    throwIfAborted(signal);
    stats.finds++;
    if (!track || typeof track !== 'object' || typeof track.title !== 'string' || !words(track.title)) {
      throw new ResolveError('no-match', 'This track has no title to search for.');
    }
    const key = trackKey(track);
    const hit = memory.get(key);
    if (hit) {
      stats.memoryHits++;
      if (hit instanceof ResolveError) throw hit;
      return copy(hit);
    }
    const match = await share(
      key,
      async (sig) => {
        const rec = readStore()[key];
        const stored = fromRecord(key, rec);
        if (stored) {
          const checked = cfg.oembed === false ? stored : await recheck(track, stored, sig);
          if (checked) {
            stats.storageHits++;
            rememberMemory(key, checked);
            // Keep the record's age: a re-check is not a new lookup.
            if (checked.videoId !== stored.videoId || checked.alternates.join() !== stored.alternates.join()) writeStore(key, checked, rec.t);
            return checked;
          }
        }
        let found = await lookup(track, sig);
        // A pasted line that reads two ways ("Title - Artist"): text.js supplies the other reading.
        const alt = /** @type {any} */ (track).alt;
        if (!found && alt && typeof alt.title === 'string' && words(alt.title)) {
          found = await lookup({ ...track, title: alt.title, artist: typeof alt.artist === 'string' ? alt.artist : '' }, sig);
        }
        if (!found) {
          stats.noMatch++;
          const err = new ResolveError('no-match', `No full version of “${cleanText(track.title, 80)}” found on YouTube.`);
          rememberMemory(key, err); // for this session only: a later visit searches again
          throw err;
        }
        rememberMemory(key, found);
        writeStore(key, found);
        return found;
      },
      signal,
    );
    return copy(match);
  }

  /**
   * The deck could not play `videoId` (error 100 / 101 / 150 …): never offer it again this session, and
   * drop the track's cached mapping so the next find() starts from its alternates or a fresh search.
   * `code` = what the deck reported; one that says nothing about the upload (a timeout behind a long ad,
   * a blocked autoplay, a background tab — NO_VERDICT) changes nothing. Beyond SPEC 6.4.
   * @param {import('./index.js').TrackMeta} track
   * @param {string} [videoId]
   * @param {string|number} [code]
   */
  function forget(track, videoId, code) {
    if (code !== undefined && NO_VERDICT.has(String(code))) return;
    const valid = typeof videoId === 'string' && VIDEO_ID.test(videoId);
    const key = track && typeof track.title === 'string' ? trackKey(track) : null;
    let current = null;
    let checked = false;
    if (key) {
      const mem = memory.get(key);
      checked = !!mem && !(mem instanceof ResolveError);
      current = checked ? mem : fromRecord(key, readStore()[key]); // read before refusing
      memory.delete(key);
    }
    if (valid) refused.add(videoId);
    if (!key) return;
    if (valid && current) {
      const all = [{ videoId: current.videoId, durationS: current.durationS, badge: current.badge }, ...current.alternates.map((id, i) => ({ videoId: id, ...current.altInfo[i] }))];
      const left = all.filter((x) => !refused.has(x.videoId));
      if (left.length) {
        // Keep what is left: the next find() plays the best remaining upload without searching again.
        const same = left[0].videoId === current.videoId;
        const kept = {
          videoId: left[0].videoId,
          title: same ? current.title : '',
          channel: same ? current.channel : '',
          durationS: left[0].durationS,
          score: same ? current.score : YT_ALTERNATE,
          badge: left[0].badge,
          alternates: left.slice(1).map((x) => x.videoId),
          altInfo: left.slice(1).map((x) => ({ durationS: x.durationS, badge: x.badge })),
        };
        // Only what was checked this visit is answered from memory; a stored mapping is checked on its next find().
        if (checked) rememberMemory(key, kept);
        writeStore(key, kept);
        return;
      }
    }
    writeStore(key, null);
  }

  return {
    find,
    search,
    forget,
    /** Counters for diagnostics and the e2e report. */
    stats: () => ({ ...stats, relay: Object.fromEntries(Object.entries(stats.relay).map(([k, v]) => [k, { ok: v.ok, fail: v.fail, ms: v.ms.slice() }])), cached: memory.size }),
  };
}

let shared = null;
/**
 * Process-wide finder (beyond SPEC 6.4): the relays' budgets are per visitor, so every part of the app
 * should search through the same queue and cache.
 */
export function sharedYouTubeFinder() {
  if (!shared) shared = createYouTubeFinder();
  return shared;
}

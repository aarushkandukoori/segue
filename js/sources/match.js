// "Is this search result the song the playlist asked for?" — pure string/number logic, no I/O.
//
// A Spotify title like "Dreams - 2004 Remaster" has to match Deezer's "Dreams (2004 Remaster)" and
// must NOT match "Dreams (Live 1977)", a karaoke backing track, or The Cranberries' "Dreams".
// The approach: split every title into a base ("dreams") plus version extras ("2004 remaster"),
// classify the extras into tags (remix / live / karaoke …), then score base-title similarity,
// artist overlap and duration difference, and subtract for version tags the other side lacks.

/** Scores at or above this are played; anything lower is treated as "no match". */
export const ACCEPT_SCORE = 0.7;
/** Scores at or above this stop the search early (no need to try a looser query). */
export const CONFIDENT_SCORE = 0.9;

// Letters NFKD does not decompose but that people type without thinking about it.
const LETTER_FOLDS = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd', ð: 'd', ł: 'l', ı: 'i', þ: 'th', ħ: 'h' };

/**
 * Case-fold, strip Latin diacritics, unify quotes/dashes. Non-Latin scripts keep their marks
 * (stripping all combining marks would mangle Devanagari, Thai, Japanese dakuten …).
 * @param {unknown} value
 */
export function fold(value) {
  if (typeof value !== 'string') return '';
  let s = value;
  try {
    s = s.normalize('NFKD');
  } catch {
    /* keep */
  }
  s = s.replace(/[\u0300-\u036f]/g, '');
  try {
    s = s.normalize('NFC'); // put Hangul syllables and kana voicing marks back together
  } catch {
    /* keep */
  }
  return s
    .toLowerCase()
    .replace(/[\u00df\u00f8\u00e6\u0153\u0111\u00f0\u0142\u0131\u00fe\u0127]/g, (c) => LETTER_FOLDS[c] || c)
    .replace(/[\u2018\u2019\u201b\u02bc`\u00b4']/g, '') // apostrophes vanish: don't → dont
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Keep letters/digits (any script, with their marks); everything else becomes a space. */
function words(s) {
  return s
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\bpt\b/g, 'part')
    .replace(/\bpart (i{1,3}|iv|vi{0,3}|ix|x)\b/g, (_, r) => `part ${ROMAN[r]}`)
    .replace(/ n (?=\S)/g, ' and ') // rock n roll
    .replace(/\s+/g, ' ')
    .trim();
}

const FEAT_GROUP = /^(?:feat|ft|featuring|with|w\/|con|avec|mit|duet with|prod|prod by|produced by)\b\.?\s*(.*)$/;
const FEAT_INLINE = /\s+(?:feat|ft|featuring)\b\.?\s+(.+)$/i;
const PART_NOTE = /^(?:part|pt)\.? ?(?:\d{1,2}|[ivx]{1,4})$/;
const BRACKETS = /[([{\uff08\u3010\uff3b]([^()[\]{}\uff08\uff09\u3010\u3011\uff3b\uff3d]*)[)\]}\uff09\u3011\uff3d]/g;

// A " - suffix" is a version note (not part of the title) when it contains one of these.
const VERSIONISH =
  /\b(?:remaster(?:ed)?|remix|rmx|mix|mixed|edit|version|ver|live|acoustic|acustico|instrumental|karaoke|mono|stereo|demo|bonus|deluxe|explicit|clean|single|album|original|extended|radio|club|dub|unplugged|sessions?|soundtrack|ost|motion picture|from|feat|ft|featuring|with|tribute|cover|performed|made famous|sped up|speed up|slowed|reverb|nightcore|a cappella|acapella|orchestral|re-?record(?:ed|ing)?|recording|recorded|spotify singles?|anniversary|edition|reprise|rework|bootleg|vip|en vivo|ao vivo|en directo|take \d+|\d{4})\b/;

// Tags that mean "a different recording than the plain title". These run on words(extra), so
// hyphens and quotes are already spaces ("re-recorded" → "re recorded", 12" → "12").
const TAG_RULES = [
  ['cover', /\b(?:karaoke|tribute|cover(?:s|ed)?|made famous|originally performed|original performed|originally by|in the style of|backing track|playback|as performed|lullab(?:y|ies)|8 ?bit|music box|ringtone|kidz bop|piano (?:version|cover|tribute)|string (?:quartet|tribute)|workout (?:mix|remix|version))\b/],
  ['tempo', /\b(?:sped up|speed up|spedup|slowed|slowed down|reverb|nightcore|daycore|8d|fast version|slow version|tiktok version|tiktok remix)\b/],
  ['instrumental', /\b(?:instrumental|instrumentale|inst)\b/],
  ['acapella', /\b(?:a cappella|acapella|acappella|vocals only)\b/],
  ['live', /\b(?:live|en vivo|en directo|ao vivo|en concert|in concert|concert|unplugged|sessions?|at the bbc|bbc|recorded (?:at|in|live)|spotify singles?)\b/],
  ['acoustic', /\b(?:acoustic|acustico|acustica|acoustique|akustik|stripped|unplugged)\b/],
  ['demo', /\b(?:demo|outtakes?|rough mix|rough|rehearsal|alternate|alternative (?:take|version|mix)|take \d+|early version|work in progress|voice memo)\b/],
  ['orchestral', /\b(?:orchestral|orchestra version|symphonic)\b/],
  ['rerecorded', /\b(?:re ?record(?:ed|ing)?|new recording|\d{4} recording|re ?cut)\b/],
  // "(Mixed)" = lifted out of a continuous DJ mix, so the clip has another song bleeding into it.
  ['medley', /\b(?:medley|megamix|mashup|mash up|mixed|continuous mix|dj mix)\b/],
  ['extended', /\b(?:extended|club (?:mix|version|edit)|12 (?:inch|in|mix|version)|long version|full length|maxi)\b/],
  // A bracketed "(Interlude)" / "(Reprise)" is another track on the album, not the song itself.
  ['section', /\b(?:interlude|skit|intro|outro|reprise|prelude|coda|intermission|commentary)\b/],
];
// "Mix"/"Edit" only means "somebody reworked it" when a name comes with it: "Dusk Unit Club Mix"
// is a remix, "Extended Club Mix", "Radio Edit" and "2011 Mix" are the original recording.
const REMIX = /\b(?:remix(?:es|ed)?|rmx|rework(?:ed)?|bootleg|refix|flip|vip|dub|re ?edit)\b/;
const MIX_WORDS =
  /\b(?:remix(?:es|ed)?|rmx|rework(?:ed)?|bootleg|refix|flip|vip|dub|re|mix|edit|version|original|radio|single|album|stereo|mono|main|lp|inch|in|extended|club|short|long|video|clean|explicit|dirty|uk|us|international|new|full|length|tv|promo|final|master|remaster(?:ed)?|digital|bonus|deluxe|edition|official|feat|ft|the|a|\d+)\b/g;
const mixName = (w) => w.replace(MIX_WORDS, ' ').replace(/\s+/g, ' ').trim();
const NAMED_VERSION = /\b([\p{L}\p{N}]+s) version\b/u; // "taylors version"

/**
 * @typedef {Object} TitleInfo
 * @property {string} base        folded core title, punctuation-free: "dreams"
 * @property {string} head        '' unless the title has a " - subtitle" that is not a version note; then the folded part before it
 * @property {string} baseRaw     core title as typed (case, accents, apostrophes kept): "Dreams" — for search queries
 * @property {string} versionRaw  as-typed text of the extras that change the recording: "PNAU Remix" ('' if none)
 * @property {string[]} extras    folded version notes: ["2004 remaster"]
 * @property {Set<string>} tags   'remix' | 'live' | 'acoustic' | 'instrumental' | 'cover' | 'tempo' | 'demo' | 'acapella' | 'orchestral' | 'rerecorded' | 'medley' | 'extended' | 'section' | 'named'
 * @property {string} remixBy     what distinguishes the remix: "pnau"
 * @property {string} named       "taylors" for "(Taylor's Version)"
 * @property {string[]} feat      folded featured-artist text found in the title
 */

/** Typographic quotes/dashes → ASCII, whitespace collapsed; case and accents untouched. */
function unify(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u2018\u2019\u201b\u02bc\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// The same ideas in scripts where \\b does not work (CJK has no ASCII word boundaries):
// karaoke / music box / cover / accompaniment / "original singer:" / piano version, and instrumental.
const CJK_COVER = /\u30ab\u30e9\u30aa\u30b1|\u30aa\u30eb\u30b4\u30fc\u30eb|\u30ab\u30d0\u30fc|\u539f\u66f2\u6b4c\u624b|\u7ffb\u5531|\u4f34\u594f|\u92fc\u7434\u7248|\u94a2\u7434\u7248|\ub178\ub798\ubc29|\ucee4\ubc84/;
const CJK_INSTRUMENTAL = /\u7d14\u97f3\u6a02|\u7eaf\u97f3\u4e50|\u30a4\u30f3\u30b9\u30c8/;

/** Tags carried by one folded extra. */
function tagsOf(extra) {
  const w = words(extra);
  const tags = [];
  for (const [tag, re] of TAG_RULES) if (re.test(w)) tags.push(tag);
  const composed = extra.normalize('NFC');
  if (CJK_COVER.test(composed) && !tags.includes('cover')) tags.push('cover');
  if (CJK_INSTRUMENTAL.test(composed) && !tags.includes('instrumental')) tags.push('instrumental');
  const isRemix = REMIX.test(w) || (/\b(?:mix|edit)\b/.test(w) && mixName(w) !== '');
  let remixBy = '';
  if (isRemix && !tags.includes('cover') && !tags.includes('medley')) {
    tags.push('remix');
    remixBy = mixName(w);
  }
  let named = '';
  const nv = NAMED_VERSION.exec(w);
  if (nv) {
    tags.push('named');
    named = nv[1];
  }
  return { tags, remixBy, named };
}

/**
 * @param {unknown} raw
 * @returns {TitleInfo}
 */
export function parseTitle(raw) {
  const typed = unify(raw);
  /** @type {{raw: string, folded: string}[]} */
  const extras = [];
  const feat = [];
  const groups = [];
  let main = typed;
  // Peel bracket groups (repeat for nesting like "(Live (2009))").
  for (let i = 0; i < 3; i++) {
    let found = false;
    main = main.replace(BRACKETS, (_, inner) => {
      found = true;
      const g = inner.trim();
      if (g) groups.push(g);
      return ' ';
    });
    if (!found) break;
  }
  main = main.replace(/\s+/g, ' ').trim();
  if (!words(fold(main))) {
    // The whole title was inside brackets ("[Untitled]", "(Intro)").
    main = groups.length ? groups.shift() : typed;
  }
  let part = '';
  const addNote = (text) => {
    const folded = fold(text);
    const m = FEAT_GROUP.exec(folded);
    if (m) feat.push(words(m[1]));
    // "(Pt. 2)" names a different song than part 1: it stays in the title.
    else if (PART_NOTE.test(folded)) part = part || text;
    else extras.push({ raw: text, folded });
  };
  groups.forEach(addNote);

  const inlineFeat = FEAT_INLINE.exec(main);
  if (inlineFeat) {
    // "Song feat. X - Remix": keep whatever follows a dash after the feat clause.
    const rest = inlineFeat[1];
    const dash = rest.search(/\s-\s/);
    feat.push(words(fold(dash >= 0 ? rest.slice(0, dash) : rest)));
    main = main.slice(0, inlineFeat.index) + (dash >= 0 ? rest.slice(dash) : '');
  }
  const parts = main.split(/\s+-\s+/).filter((p) => p.trim());
  let baseRaw = parts.length ? parts[0] : main;
  let subtitled = false;
  for (let i = 1; i < parts.length; i++) {
    if (VERSIONISH.test(fold(parts[i]))) addNote(parts[i]);
    else {
      baseRaw += ' ' + parts[i];
      subtitled = true;
    }
  }
  // "La Plena - W Sound 05": the part before the dash, in case the other side leaves the rest out.
  const head = subtitled ? words(fold(part ? `${parts[0]} ${part}` : parts[0])) : '';
  baseRaw = (part ? `${baseRaw} ${part}` : baseRaw).trim();

  const tags = new Set();
  const versionRaw = [];
  let remixBy = '';
  let named = '';
  for (const e of extras) {
    const t = tagsOf(e.folded);
    for (const tag of t.tags) tags.add(tag);
    if (t.remixBy) remixBy = remixBy ? remixBy + ' ' + t.remixBy : t.remixBy;
    if (t.named) named = t.named;
    if (t.tags.some((tag) => tag !== 'extended')) versionRaw.push(e.raw);
  }
  return {
    base: words(fold(baseRaw)),
    head,
    baseRaw,
    versionRaw: versionRaw.join(' '),
    extras: extras.map((e) => e.folded),
    tags,
    remixBy,
    named,
    feat: feat.filter(Boolean),
  };
}

/** Folded, punctuation-free base title ("Dreams - 2004 Remaster" → "dreams"). */
export function normalizeTitle(raw) {
  return parseTitle(raw).base;
}

/** Sørensen–Dice on character bigrams of the space-less strings. 0..1. */
export function dice(a, b) {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (x === y) return x ? 1 : 0;
  const cx = Array.from(x);
  const cy = Array.from(y);
  if (cx.length < 2 || cy.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < cx.length - 1; i++) {
    const g = cx[i] + cx[i + 1];
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < cy.length - 1; i++) {
    const g = cy[i] + cy[i + 1];
    const n = grams.get(g) || 0;
    if (n > 0) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (cx.length - 1 + (cy.length - 1));
}

/** Levenshtein distance, early exit above `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const ARTIST_SPLIT = /\s*(?:,|;|\/|\+|&|\band\b|\bx\b|\u00d7|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b|\bwith\b|\bvs\b\.?)\s*/;

/** Fold an artist credit; stylised symbols become the letters they stand for (P!nk, Ke$ha, A$AP). */
function foldArtist(raw) {
  return fold(raw)
    .replace(/(\p{L})!(?=\p{L})/gu, '$1i') // no lookbehind: older Safari cannot parse it
    .replace(/\$/g, 's');
}

/**
 * Split a display artist string into folded individual names.
 * "Dr. Dre, Snoop Dogg" → ["dr dre", "snoop dogg"]. Over-splitting ("Earth, Wind & Fire") is fine:
 * both sides are split the same way and we only ask whether the sets intersect.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function splitArtists(raw) {
  const out = [];
  for (const piece of foldArtist(raw).split(ARTIST_SPLIT)) {
    const name = words(piece).replace(/^the /, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The first credited artist as typed (for building search queries). */
export function primaryArtist(raw) {
  if (typeof raw !== 'string') return '';
  return raw.split(/\s*(?:,|;|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b)\s*/i)[0].trim();
}

function sameName(a, b) {
  if (a === b) return true;
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (x === y) return true;
  // One typo in a long name ("ava maxx"). Short names are left alone: "muse" is not "mase".
  return Math.min(x.length, y.length) >= 6 && editDistance(x, y, 1) <= 1;
}

/**
 * 0..1: how well the candidate's artist credit matches the wanted one.
 * 1 = the wanted primary artist is credited, 0.9 = a featured artist is, 0 = nobody in common.
 * @param {string} wanted @param {string} candidate
 */
export function artistScore(wanted, candidate) {
  const w = splitArtists(wanted);
  const c = splitArtists(candidate);
  if (!w.length || !c.length) return 0;
  const wholeW = words(foldArtist(wanted)).replace(/^the /, '');
  const wholeC = words(foldArtist(candidate)).replace(/^the /, '');
  if (wholeW === wholeC) return 1;
  let best = 0;
  w.forEach((wn, i) => {
    for (const cn of c) {
      if (sameName(wn, cn)) best = Math.max(best, i === 0 ? 1 : 0.9);
    }
  });
  if (best) return best;
  // "Florence + the Machine" vs "Florence and the Machine", "Beyoncé Knowles" vs "Beyoncé".
  if (sameName(wholeW, wholeC)) return 1;
  const d = dice(wholeW, wholeC);
  if (d >= 0.82) return 0.85;
  const tw = new Set(wholeW.split(' '));
  const tc = wholeC.split(' ');
  if (tc.length >= 2 && tc.every((t) => tw.has(t))) return 0.85;
  return 0;
}

const STOP = new Set(['the', 'a', 'an']);
const LATIN_WORD = /^\p{Script=Latin}+$/u;
const contentTokens = (s) => s.split(' ').filter((t) => t && !STOP.has(t));
const tokenKey = (s) => contentTokens(s).sort().join(' ');

/**
 * Two words that are the same word spelled slightly differently: "lantern"/"lanterns",
 * "believin"/"believing", a typo in a long word. Short words and anything with a digit must be
 * identical — "love"/"live" and "part 1"/"part 2" are different songs.
 */
function sameWord(a, b) {
  if (a === b) return true;
  // Only for alphabetic Latin words: one changed character in 夜の光 or in "part 2" is another title.
  if (!LATIN_WORD.test(a) || !LATIN_WORD.test(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const n = Array.from(short).length;
  if (n >= 4 && long.startsWith(short) && Array.from(long).length - n <= 1) return true;
  if (n >= 9) return editDistance(short, long, 2) <= 2;
  return n >= 6 && editDistance(short, long, 1) <= 1;
}

/**
 * 0..1 similarity of two base titles. Deliberately strict: the same words (give or take articles,
 * word order, spacing and a spelling slip) score ≥ 0.9; anything else is a different title and scores
 * ≤ 0.5 however many letters it shares — "Night Shift" is not "Night Shift II", and "Dance With Me"
 * is not "Dance With Me Tonight".
 * `artistTokens` are words that may legitimately appear in one title and not the other
 * ("Stateside + Zara Larsson" vs "Stateside").
 * @param {string} a @param {string} b @param {Set<string>} [artistTokens]
 */
export function titleSimilarity(a, b, artistTokens) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 1;
  if (tokenKey(a) === tokenKey(b) && tokenKey(a)) return 0.97;
  let ta = contentTokens(a);
  let tb = contentTokens(b);
  if (artistTokens && artistTokens.size) {
    const strip = (list) => list.filter((t) => !artistTokens.has(t) && t !== 'and');
    const sa = strip(ta);
    const sb = strip(tb);
    if (sa.length && sb.length) {
      if (sa.join(' ') === sb.join(' ')) return 0.95;
      ta = sa;
      tb = sb;
    }
  }
  if (ta.length === tb.length && ta.length) {
    let slips = 0;
    let same = true;
    for (let i = 0; i < ta.length && same; i++) {
      if (ta[i] === tb[i]) continue;
      if (sameWord(ta[i], tb[i])) slips++;
      else same = false;
    }
    if (same && slips <= 2) return slips === 1 ? 0.93 : 0.9;
  }
  return Math.min(0.5, 0.95 * dice(a, b));
}

/** Folded title tokens with censoring stars kept: "gl*w up" → ["gl*w", "up"]. */
const starTokens = (s) =>
  fold(s)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M}*]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/**
 * Stores that censor titles write "Gl*w" or "G**w" for "Glow". True when the two titles are the
 * same once every star may stand for one letter (or none).
 * @param {string} a @param {string} b
 */
export function censoredEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || (!a.includes('*') && !b.includes('*'))) return false;
  const ta = starTokens(a);
  const tb = starTokens(b);
  if (!ta.length || ta.length !== tb.length) return false;
  return ta.every((x, i) => {
    const y = tb[i];
    if (x === y) return true;
    const [pat, plain] = x.includes('*') ? [x, y] : [y, x];
    if (!pat.includes('*') || plain.includes('*')) return false;
    const letters = Array.from(pat).filter((ch) => ch !== '*');
    if (!letters.length) return false; // "****" could be anything
    const re = new RegExp(`^${Array.from(pat, (ch) => (ch === '*' ? '[\\p{L}\\p{N}]?' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'u');
    return re.test(plain);
  });
}

/** 1 when durations agree within 2 s, falling off fast after 4 s. `d` in seconds. */
export function durationScore(d) {
  if (d <= 2) return 1;
  if (d <= 4) return 1 - 0.125 * (d - 2);
  if (d <= 7) return 0.75 - 0.2 * (d - 4);
  return Math.max(0, 0.15 - 0.03 * (d - 7));
}

// Candidate has a version tag the wanted title lacks → it is some other recording. Everything
// from 'cover' to 'section' is sized so that an otherwise perfect candidate still lands below
// ACCEPT_SCORE: a live cut or a remix must never stand in for the studio original.
const PENALTY_EXTRA = { cover: 0.55, tempo: 0.45, instrumental: 0.45, acapella: 0.45, medley: 0.45, remix: 0.4, live: 0.4, acoustic: 0.4, demo: 0.4, orchestral: 0.4, section: 0.4, rerecorded: 0.36, extended: 0.08, named: 0.05 };
// Wanted title asks for a version the candidate does not claim to be. A remix, an instrumental or a
// sped-up edit sounds nothing like the original, so the original is rejected; a live or acoustic
// request falls back to the studio take (same song, same artist) at a reduced score.
const PENALTY_MISSING = { cover: 0.2, tempo: 0.36, instrumental: 0.36, acapella: 0.36, medley: 0.25, remix: 0.36, live: 0.2, acoustic: 0.24, demo: 0.15, orchestral: 0.2, section: 0.36, rerecorded: 0.05, extended: 0.05, named: 0.05 };
const COVER_ARTIST = /\b(?:karaoke|tribute|cover band|covers|kidz bop|lullab(?:y|ies)|backing tracks?|made famous|originally performed|party tyme|hit crew|sound ?alikes?|ameritz|vitamin string quartet|piano superstar|workout)\b/;

const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * @typedef {Object} Wanted
 * @property {string} title
 * @property {string} [artist]
 * @property {number} [durationMs]
 * @property {boolean} [explicit]
 *
 * @typedef {Object} Candidate
 * @property {string} title
 * @property {string} artist
 * @property {number} [durationMs]
 * @property {boolean} [explicit]
 * @property {number} [rank]     provider popularity, larger = more popular (tie-break only)
 * @property {boolean} [exactDuration]  durationMs is exact to the millisecond (iTunes), not rounded to seconds (Deezer)
 */

/**
 * Score one candidate against the wanted track.
 * @param {Wanted} wanted
 * @param {Candidate} cand
 * @returns {{score: number, title: number, artist: number|null, duration: number|null, penalty: number, reason: string}}
 */
export function scoreCandidate(wanted, cand) {
  const w = parseTitle(wanted.title);
  const c = parseTitle(cand.title);
  const wantArtist = typeof wanted.artist === 'string' && wanted.artist.trim() !== '';

  const artistTokens = new Set();
  for (const src of [wanted.artist, cand.artist, ...w.feat, ...c.feat]) {
    for (const t of words(fold(src || '')).split(' ')) if (t) artistTokens.add(t);
  }
  let title = titleSimilarity(w.base, c.base, artistTokens);
  if (title < 0.9 && censoredEqual(w.baseRaw, c.baseRaw)) title = 0.95;

  let artist = null;
  if (wantArtist) {
    artist = artistScore(wanted.artist, cand.artist);
    // A featured guest credited only in the candidate's title still counts as overlap.
    if (artist === 0 && c.feat.length) {
      const guest = artistScore(wanted.artist, c.feat.join(', '));
      if (guest > 0) artist = 0.5;
    }
  }

  let duration = null;
  let diff = null;
  if (wanted.durationMs > 0 && cand.durationMs > 0) {
    diff = Math.abs(wanted.durationMs - cand.durationMs) / 1000;
    duration = durationScore(diff);
  }
  // One side says "Title - Subtitle", the other just "Title". Same song only if the length agrees:
  // a subtitle can also be what tells two tracks apart ("Suite - II. Andante").
  if (title < 0.9 && diff != null && diff <= 2) {
    const sub = (x, y) => x.head && titleSimilarity(x.head, y.base, artistTokens) >= 0.9;
    if (sub(w, c) || sub(c, w)) title = 0.9;
  }
  // How close "the same length" has to be for the cross-script rules below. Catalogues that report
  // milliseconds agree with Spotify to a few ms on the same master; whole seconds are coarser.
  const sameLength = diff != null && diff <= (cand.exactDuration ? 0.15 : 1.0);

  let penalty = 0;
  const reasons = [];
  const cTags = new Set(c.tags);
  if (COVER_ARTIST.test(words(fold(cand.artist))) || CJK_COVER.test(String(cand.artist || '').normalize('NFC'))) cTags.add('cover');
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
  if (w.tags.has('remix') && cTags.has('remix') && w.remixBy && c.remixBy && dice(w.remixBy, c.remixBy) < 0.6) {
    penalty += 0.4;
    reasons.push('other-remix');
  }
  if (w.tags.has('named') && cTags.has('named') && w.named !== c.named) penalty += 0.2;
  // Guests in the candidate that the wanted credit never mentions: probably a different edition.
  if (wantArtist && c.feat.length) {
    const known = words(fold(wanted.artist + ' ' + wanted.title));
    if (c.feat.some((f) => f && !f.split(' ').some((t) => t.length > 2 && known.includes(t)))) {
      penalty += 0.04;
      reasons.push('+guest');
    }
  }

  const a = artist == null ? 0.75 : artist; // unknown artist: neutral, the title has to carry it
  let score = duration == null ? 0.6 * title + 0.4 * a : 0.5 * title + 0.3 * a + 0.2 * duration;
  score -= penalty;

  if (title < 0.6) {
    // Different words. The one exception: the same artist, the same length to the second, and the
    // two titles are in different scripts (アイドル vs "Idol") — a transliteration, not another song.
    const scripts = NON_LATIN.test(w.base) !== NON_LATIN.test(c.base);
    if (scripts && artist === 1 && sameLength && penalty === 0) {
      score = Math.max(score, 0.72);
      reasons.push('translit');
    } else {
      score = Math.min(score, 0.4);
      reasons.push('title');
    }
  } else if (artist === 0) {
    // Right title, nobody in common. Accept only when the artist credit is in another script
    // (王菲 vs "Faye Wong") and title + length agree exactly.
    const scripts = NON_LATIN.test(fold(wanted.artist)) !== NON_LATIN.test(fold(cand.artist));
    // …and the title is distinctive: plenty of unrelated songs are called "Stay" and run 3:20.
    const distinctive = Array.from(w.base.replace(/\s+/g, '')).length >= (NON_LATIN.test(w.base) ? 3 : 8);
    if (scripts && distinctive && title >= 0.97 && sameLength && penalty === 0) {
      score = Math.max(score, 0.72);
      reasons.push('translit-artist');
    } else {
      score = Math.min(score, 0.45);
      reasons.push('artist');
    }
  }
  score = Math.max(0, Math.min(1, score));
  // Clean edit vs explicit original: same title, same length. A nudge so the right one wins the tie.
  if (wanted.explicit != null && cand.explicit != null && wanted.explicit !== cand.explicit) score = Math.max(0, score - 0.005);
  return { score, title, artist, duration, penalty, reason: reasons.join(' ') };
}

/**
 * Pick the best candidate. Ties go to the more popular one, then to the earlier one.
 * @template {Candidate} T
 * @param {Wanted} wanted
 * @param {T[]} candidates
 * @returns {{candidate: T, score: number, detail: ReturnType<typeof scoreCandidate>} | null}
 */
export function bestMatch(wanted, candidates) {
  const scored = candidates.map((candidate) => ({ candidate, detail: scoreCandidate(wanted, candidate) }));
  // The cross-script rule accepts on artist + length alone. If two different titles pass it, length
  // was a coincidence for at least one of them and there is no telling which: trust neither.
  const guesses = scored.filter((s) => /(?:^| )translit(?: |$)/.test(s.detail.reason));
  if (new Set(guesses.map((s) => normalizeTitle(s.candidate.title))).size > 1) {
    for (const s of guesses) s.detail = { ...s.detail, score: Math.min(s.detail.score, 0.4), reason: `${s.detail.reason} ambiguous` };
  }
  let best = null;
  for (const { candidate, detail } of scored) {
    const better =
      !best ||
      detail.score > best.score + 1e-9 ||
      (Math.abs(detail.score - best.score) <= 1e-9 && (candidate.rank || 0) > (best.candidate.rank || 0));
    if (better) best = { candidate, score: detail.score, detail };
  }
  return best;
}

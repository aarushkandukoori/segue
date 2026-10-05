// Title normalisation and match scoring. Every track / artist name in here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPT_SCORE,
  CONFIDENT_SCORE,
  artistScore,
  bestMatch,
  censoredEqual,
  dice,
  durationScore,
  fold,
  normalizeTitle,
  parseTitle,
  primaryArtist,
  scoreCandidate,
  splitArtists,
  titleSimilarity,
} from '../js/sources/match.js';

const W = (title, artist, seconds, extra = {}) => ({ title, artist, durationMs: seconds ? seconds * 1000 : undefined, ...extra });
const score = (w, c) => scoreCandidate(w, c).score;
const accepted = (w, c) => score(w, c) >= ACCEPT_SCORE;

/* ------------------------------------------------------------------ normalisation */

test('fold: case, Latin diacritics, typographic quotes and dashes', () => {
  assert.equal(fold('  Corazón   ELÉCTRICO '), 'corazon electrico');
  assert.equal(fold('Straße über Øresund'), 'strasse uber oresund');
  assert.equal(fold('Don’t Stop'), 'dont stop');
  assert.equal(fold('Up – Down — Around'), 'up - down - around');
  assert.equal(fold(undefined), '');
  assert.equal(fold(42), '');
});

test('normalizeTitle: version notes, brackets and feat clauses are not part of the title', () => {
  const same = [
    'Paper Lanterns',
    'paper lanterns',
    'Paper Lanterns - Remastered 2011',
    'Paper Lanterns (2011 Remaster)',
    'Paper Lanterns [Deluxe Edition]',
    'Paper Lanterns - Radio Edit',
    'Paper Lanterns (feat. Juno Reyes)',
    'Paper Lanterns feat. Juno Reyes',
    'Paper Lanterns (with Juno Reyes)',
    'Paper Lanterns - From "Harbor Lights"',
    'Paper Lanterns - Single Version',
    'Paper Lanterns (Live at Harbor Hall)',
    'Paper Lanterns - Dusk Unit Remix',
    'Paper Lanterns ft. Juno Reyes - Dusk Unit Remix',
    'PAPER LANTERNS (Mono)',
    'Paper Lanterns （Bonus Track）',
  ];
  for (const t of same) assert.equal(normalizeTitle(t), 'paper lanterns', t);
});

test('normalizeTitle: punctuation, ampersands, parts and titles that are all brackets', () => {
  assert.equal(normalizeTitle('Salt & Smoke'), 'salt and smoke');
  assert.equal(normalizeTitle('Salt and Smoke'), 'salt and smoke');
  assert.equal(normalizeTitle('Mr. Lighthouse!'), 'mr lighthouse');
  assert.equal(normalizeTitle('Night Shift, Pt. 2'), 'night shift part 2');
  assert.equal(normalizeTitle('Night Shift (Part II)'), 'night shift part 2');
  assert.equal(normalizeTitle('Night Shift - Pt. 2'), 'night shift part 2');
  assert.equal(normalizeTitle("Rock 'n' Stroll"), 'rock and stroll');
  assert.equal(normalizeTitle('(Intro)'), 'intro');
  assert.equal(normalizeTitle('[Untitled]'), 'untitled');
  assert.equal(normalizeTitle('Up - Down'), 'up down', 'a dash that is not a version note stays in the title');
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
});

test('normalizeTitle: non-Latin scripts survive untouched', () => {
  assert.equal(normalizeTitle('よるのひかり'), 'よるのひかり');
  assert.equal(normalizeTitle('Белая ночь (Remastered)'), 'белая ночь');
  assert.equal(normalizeTitle('밤의 노래 - Live'), '밤의 노래');
  // Dakuten / combining marks are part of the letter and must not be stripped.
  assert.notEqual(normalizeTitle('がいとう'), normalizeTitle('かいとう'));
});

test('parseTitle: tags, remixer, featured artists, search-friendly raw strings', () => {
  const remix = parseTitle('Paper Lanterns (feat. Juno Reyes) - Dusk Unit Remix');
  assert.equal(remix.base, 'paper lanterns');
  assert.equal(remix.baseRaw, 'Paper Lanterns');
  assert.ok(remix.tags.has('remix'));
  assert.equal(remix.remixBy, 'dusk unit');
  assert.deepEqual(remix.feat, ['juno reyes']);
  assert.equal(remix.versionRaw, 'Dusk Unit Remix');

  assert.deepEqual([...parseTitle('Paper Lanterns - Live at Harbor Hall').tags], ['live']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Acoustic)').tags], ['acoustic']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Instrumental)').tags], ['instrumental']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Karaoke Version)').tags], ['cover']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Sped Up)').tags], ['tempo']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Interlude)').tags], ['section']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Demo)').tags], ['demo']);
  assert.deepEqual([...parseTitle('Paper Lanterns (Re-Recorded)').tags], ['rerecorded']);
  assert.ok(parseTitle("Open Road (Mara's Version)").tags.has('named'));
  assert.equal(parseTitle("Open Road (Mara's Version)").named, 'maras');

  // Neutral notes: same recording, no tag.
  for (const t of ['Paper Lanterns (Radio Edit)', 'Paper Lanterns - 2011 Remaster', 'Paper Lanterns (Original Mix)', 'Paper Lanterns (Album Version)', 'Paper Lanterns - Mono', 'Paper Lanterns (Explicit)']) {
    assert.equal(parseTitle(t).tags.size, 0, t);
    assert.equal(parseTitle(t).versionRaw, '', t);
  }
});

test('splitArtists / primaryArtist', () => {
  assert.deepEqual(splitArtists('Mara Vale, Juno Reyes & The Hollow Pines'), ['mara vale', 'juno reyes', 'hollow pines']);
  assert.deepEqual(splitArtists('Mara Vale feat. Juno Reyes'), ['mara vale', 'juno reyes']);
  assert.deepEqual(splitArtists('Mara Vale x Dusk Unit'), ['mara vale', 'dusk unit']);
  assert.deepEqual(splitArtists('Zoé Márquez'), ['zoe marquez']);
  assert.deepEqual(splitArtists('L!nk, Ca$h Avenue'), ['link', 'cash avenue']);
  assert.deepEqual(splitArtists(''), []);
  assert.deepEqual(splitArtists(null), []);
  assert.equal(primaryArtist('Mara Vale, Juno Reyes'), 'Mara Vale');
  assert.equal(primaryArtist('Mara Vale feat. Juno Reyes'), 'Mara Vale');
  assert.equal(primaryArtist(undefined), '');
});

test('artistScore: primary, featured, spelling variants, strangers', () => {
  assert.equal(artistScore('Mara Vale', 'Mara Vale'), 1);
  assert.equal(artistScore('Mara Vale, Juno Reyes', 'Mara Vale'), 1);
  assert.equal(artistScore('Mara Vale, Juno Reyes', 'Juno Reyes'), 0.9);
  assert.equal(artistScore('The Hollow Pines', 'Hollow Pines'), 1);
  assert.equal(artistScore('Zoé Márquez', 'Zoe Marquez'), 1);
  assert.equal(artistScore('Mara Vale + The Hollow Pines', 'Mara Vale and the Hollow Pines'), 1);
  assert.equal(artistScore('Marabelle Vale', 'Marabele Vale'), 1, 'one typo in a long name');
  assert.equal(artistScore('Mara Vale', 'The Hollow Pines'), 0);
  assert.equal(artistScore('Muse', 'Mase'), 0, 'short names must be exact');
  assert.equal(artistScore('', 'Mara Vale'), 0);
  assert.equal(artistScore('Mara Vale', ''), 0);
});

test('titleSimilarity: same words score high, different titles score low however much they share', () => {
  const sim = (a, b, tokens) => titleSimilarity(normalizeTitle(a), normalizeTitle(b), tokens);
  assert.equal(sim('Paper Lanterns', 'Paper Lanterns'), 1);
  assert.equal(sim('Some Body', 'Somebody'), 1);
  assert.equal(sim('The Paper Lanterns', 'Paper Lanterns'), 0.97);
  assert.equal(sim('Lanterns Paper', 'Paper Lanterns'), 0.97);
  assert.ok(sim('Paper Lanterns', 'Paper Lantern') >= 0.9, 'plural slip');
  assert.ok(sim('Keep Believin', 'Keep Believing') >= 0.9, 'dropped g');
  assert.ok(sim('Bohemian Lullabye', 'Bohemian Lullaby') >= 0.9);
  assert.equal(sim('Paper Lanterns Mara Vale', 'Paper Lanterns', new Set(['mara', 'vale'])), 0.95, 'artist name inside the title');

  for (const [a, b] of [
    ['Night Shift', 'Night Shift II'],
    ['Night Shift, Pt. 1', 'Night Shift, Pt. 2'],
    ['Night Shift', 'Night Shift, Pt. 2'],
    ['Track 7', 'Track 8'],
    ['1999', '1989'],
    ['Dance With Me', 'Dance With Me Tonight'],
    ['Home', 'Homecoming'],
    ['Love', 'Live'],
    ['Paper Lanterns', 'Glass Harbor'],
    ['よるのひかり', 'よるのひかる'],
    ['Белая ночь', 'Белый день'],
  ]) {
    assert.ok(sim(a, b) <= 0.5, `${a} / ${b} → ${sim(a, b)}`);
  }
  assert.equal(sim('', 'Paper Lanterns'), 0);
});

test('censoredEqual: a star stands for one hidden letter', () => {
  assert.equal(censoredEqual('Gl*w Up', 'Glow Up'), true);
  assert.equal(censoredEqual('G**w Up', 'Glow Up'), true);
  assert.equal(censoredEqual('Glow Up', 'Gl*w Up'), true);
  assert.equal(censoredEqual('Gl*w Up', 'Grow Up'), false);
  assert.equal(censoredEqual('Gl*w Up', 'Glow Down'), false);
  assert.equal(censoredEqual('**** Up', 'Glow Up'), false, 'all stars could be anything');
  assert.equal(censoredEqual('Glow Up', 'Glow Up'), false, 'only meaningful when something is censored');
  assert.ok(accepted(W('Glow Up', 'Mara Vale', 200), W('Gl*w Up', 'Mara Vale', 200)));
});

const STAR = String.fromCharCode(42);

test('censoredEqual: a star is zero or one letter or digit, never punctuation, a mark or two letters', () => {
  const s = (text) => text.replaceAll('#', STAR);
  for (const [a, b, want] of [
    ['gl#w', 'glw', true], // the star may stand for nothing
    ['gl#w', 'gloow', false], // …but not for two letters
    ['gl##w', 'gloow', true],
    ['gl###w', 'glow', true],
    ['#low', 'glow', true],
    ['glo#', 'glow', true],
    ['glo#', 'glo', true],
    ['track #', 'track 7', false], // a star on its own could be anything
    ['tr#ck 7', 'track 7', true],
    ['r#om 1#1', 'room 101', true], // digits count
    ['gl#w', 'gl-w', false], // the plain side is two words there
    ['gl#w up', 'glow', false], // word counts must agree
    ['#l#w', 'blow', true],
    ['#l#w', 'blown', false],
    ['g#', 'go', true],
    ['g#', 'no', false],
    ['よるの#かり', 'よるのひかり', true],
    ['よ#のひかり', 'よるのひかる', false],
    ['gl#w', 'gl#w', true], // identical tokens are equal whatever they contain
    ['gl#w', 'g#ow', false], // stars on both sides of one word: no guessing
  ]) {
    assert.equal(censoredEqual(s(a), b.includes('#') ? s(b) : b), want, `${a} / ${b}`);
    assert.equal(censoredEqual(b.includes('#') ? s(b) : b, s(a)), want, `${b} / ${a} (other way round)`);
  }
  // A star hides a letter or a digit, not a combining mark (here a Devanagari vowel sign).
  const KA = String.fromCodePoint(0x915);
  const AA = String.fromCodePoint(0x93e);
  assert.equal(censoredEqual(STAR + AA, KA + AA), true);
  assert.equal(censoredEqual(KA + STAR, KA + AA), false, 'a star cannot stand for a vowel sign');
});

test('censoredEqual: agrees with the one-optional-letter-per-star definition on every short pattern', () => {
  // Reference: the obvious regular expression. Only safe for a handful of stars, which is all this uses.
  const reference = (pat, plain) => {
    const body = Array.from(pat, (ch) => (ch === STAR ? '[\\p{L}\\p{N}]?' : ch)).join('');
    return new RegExp(`^${body}$`, 'u').test(plain);
  };
  const alphabet = ['a', 'b', '7', STAR];
  const plains = ['', 'a', 'b', 'ab', 'ba', 'a7', 'aab', 'abab', 'b7ab', 'aaaa'].filter(Boolean);
  let checked = 0;
  const walk = (prefix, depth) => {
    if (prefix.includes(STAR) && /[ab7]/.test(prefix)) {
      for (const plain of plains) {
        if (plain === prefix) continue;
        assert.equal(censoredEqual(prefix, plain), reference(prefix, plain), `${prefix.replaceAll(STAR, '#')} / ${plain}`);
        checked++;
      }
    }
    if (depth < 5) for (const ch of alphabet) walk(prefix + ch, depth + 1);
  };
  walk('', 0);
  assert.ok(checked > 5000, `${checked} pairs`);
});

test('censoredEqual / scoreCandidate: a long run of stars cannot stall the page', async () => {
  // Runs in a child process with a kill timer: the old implementation built a regular expression
  // with one optional group per star, which never came back for ~40 stars — and a regex that is
  // stuck cannot be interrupted from inside its own thread.
  const { spawnSync } = await import('node:child_process');
  const matchUrl = new URL('../js/sources/match.js', import.meta.url).href;
  const code = `
    import { censoredEqual, scoreCandidate, bestMatch } from ${JSON.stringify(matchUrl)};
    const star = String.fromCharCode(42);
    const out = [];
    const t0 = performance.now();
    for (const n of [30, 45, 60, 299, 5000]) {
      const title = star.repeat(n) + 'z';
      out.push(censoredEqual(title, 'wonderful'), censoredEqual('wonderful', title), censoredEqual(title + ' night', 'wonderful night'));
      out.push(scoreCandidate({ title, artist: 'Mara Vale', durationMs: 200000 }, { title: 'Wonderful', artist: 'Mara Vale', durationMs: 200000 }).score < 0.7);
      out.push(scoreCandidate({ title: 'Wonderful', artist: 'Mara Vale' }, { title, artist: 'Mara Vale' }).score < 0.7);
      const page = Array.from({ length: 15 }, (_, i) => ({ title: 'Wonderful ' + i, artist: 'Mara Vale', durationMs: 200000 }));
      out.push(bestMatch({ title, artist: 'Mara Vale', durationMs: 200000 }, page).score < 0.7);
    }
    // Many starred words, and stars that do match: still instant, still right.
    out.push(censoredEqual(Array.from({ length: 60 }, () => 'w' + star.repeat(3) + 'd').join(' '), Array.from({ length: 60 }, () => 'word').join(' ')));
    out.push(censoredEqual('w' + star.repeat(40) + 'd', 'word'));
    // …while a "word" of hundreds of characters is not a censored word at all.
    out.push(censoredEqual('w' + star.repeat(250) + 'd', 'word'));
    console.log(JSON.stringify({ ms: performance.now() - t0, out }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 20000, encoding: 'utf8' });
  assert.equal(run.error, undefined, `did not finish: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, run.stderr);
  const { ms, out } = JSON.parse(run.stdout);
  const perSize = [false, false, false, true, true, true];
  assert.deepEqual(out, [...perSize, ...perSize, ...perSize, ...perSize, ...perSize, true, true, false]);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});

test('dice / durationScore: basic shape', () => {
  assert.equal(dice('night', 'night'), 1);
  assert.equal(dice('', ''), 0);
  assert.equal(dice('a', 'b'), 0);
  assert.ok(dice('paper lanterns', 'paper lantern') > 0.9);
  assert.equal(durationScore(0), 1);
  assert.equal(durationScore(2), 1);
  assert.ok(durationScore(4) >= 0.7);
  assert.ok(durationScore(5) < durationScore(4));
  assert.ok(durationScore(8) < 0.2, 'more than a few seconds off is a strong negative');
  assert.equal(durationScore(60), 0);
});

/* ------------------------------------------------------------------ scoring */

const ORIGINAL = W('Paper Lanterns', 'Mara Vale', 201);

test('scoreCandidate: the same recording under its usual disguises is a confident match', () => {
  const good = [
    [ORIGINAL, W('Paper Lanterns', 'Mara Vale', 201)],
    [ORIGINAL, W('Paper Lanterns', 'Mara Vale', 202.4)],
    [ORIGINAL, W('Paper Lanterns (2011 Remaster)', 'Mara Vale', 202)],
    [ORIGINAL, W('Paper Lanterns (Radio Edit)', 'Mara Vale', 201)],
    [ORIGINAL, W('PAPER LANTERNS', 'MARA VALE', 201)],
    [W('Paper Lanterns - Remastered 2011', 'Mara Vale', 201), W('Paper Lanterns', 'Mara Vale', 200)],
    [W('Paper Lanterns - From "Harbor Lights"', 'Mara Vale', 201), W('Paper Lanterns', 'Mara Vale', 201)],
    [W('Slow Tide (feat. Juno Reyes)', 'Mara Vale, Juno Reyes', 180), W('Slow Tide', 'Mara Vale', 180)],
    [W('Slow Tide', 'Mara Vale, Juno Reyes', 180), W('Slow Tide (feat. Juno Reyes)', 'Mara Vale', 180)],
    [W('Slow Tide', 'Mara Vale, Juno Reyes', 180), W('Slow Tide', 'Juno Reyes', 180)],
    [W('Corazón Eléctrico', 'Zoé Márquez', 190), W('Corazon Electrico', 'Zoe Marquez', 190)],
    [W('Salt & Smoke', 'Mara Vale', 201), W('Salt and Smoke', 'Mara Vale', 201)],
    [W('The Paper Lanterns', 'The Hollow Pines', 201), W('Paper Lanterns', 'Hollow Pines', 201)],
    [W('Night Shift, Pt. 2', 'Mara Vale', 200), W('Night Shift (Part II)', 'Mara Vale', 200)],
    [W('Paper Lanterns', 'Mara Vale & The Hollow Pines', 201), W('Paper Lanterns', 'Mara Vale', 201)],
    [W("Open Road (Mara's Version)", 'Mara Vale', 201), W('Open Road', 'Mara Vale', 201)],
    [W('Paper Lanterns', 'Mara Vale'), W('Paper Lanterns', 'Mara Vale', 201)], // no duration known (pasted text)
    [W('(Intro)', 'Mara Vale', 61), W('Intro', 'Mara Vale', 61)],
  ];
  for (const [w, c] of good) {
    const s = score(w, c);
    assert.ok(s >= CONFIDENT_SCORE, `${w.title} / ${c.title} by ${c.artist} → ${s.toFixed(3)}`);
  }
});

test('scoreCandidate: other recordings lose when the playlist asked for the original', () => {
  const traps = [
    ['live', W('Paper Lanterns (Live at Harbor Hall)', 'Mara Vale', 215)],
    ['live, same length', W('Paper Lanterns - Live', 'Mara Vale', 201)],
    ['remix', W('Paper Lanterns (Dusk Unit Remix)', 'Mara Vale', 201)],
    ['remix, dash form', W('Paper Lanterns - Dusk Unit Remix', 'Mara Vale', 201)],
    ['club mix by someone', W('Paper Lanterns (Dusk Unit Club Mix)', 'Mara Vale', 201)],
    ['karaoke', W('Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201)],
    ['karaoke, artist kept', W('Paper Lanterns (Karaoke Version)', 'Mara Vale', 201)],
    ['originally performed by', W('Paper Lanterns (Originally Performed by Mara Vale)', 'Studio Backing Crew', 201)],
    ['made famous by', W('Paper Lanterns (As Made Famous By Mara Vale)', 'The Backing Tracks', 201)],
    ['tribute band', W('Paper Lanterns', 'Mara Vale Tribute Band', 201)],
    ['tribute in title', W('Paper Lanterns (Tribute to Mara Vale)', 'Mara Vale', 201)],
    ['lullaby rendition', W('Paper Lanterns', 'Lullaby Players', 201)],
    ['instrumental', W('Paper Lanterns (Instrumental)', 'Mara Vale', 201)],
    ['acoustic', W('Paper Lanterns (Acoustic)', 'Mara Vale', 201)],
    ['sped up', W('Paper Lanterns (Sped Up)', 'Mara Vale', 170)],
    ['slowed', W('Paper Lanterns - Slowed + Reverb', 'Mara Vale', 240)],
    ['demo', W('Paper Lanterns (Demo)', 'Mara Vale', 201)],
    ['re-recorded', W('Paper Lanterns (Re-Recorded)', 'Mara Vale', 201)],
    ['interlude', W('Paper Lanterns (Interlude)', 'Mara Vale', 62)],
    ['reprise', W('Paper Lanterns (Reprise)', 'Mara Vale', 201)],
    ['dj mix excerpt', W('Paper Lanterns (Mixed)', 'Mara Vale', 150)],
    ['same title, other artist', W('Paper Lanterns', 'The Hollow Pines', 201)],
    ['same artist, other title', W('Glass Harbor', 'Mara Vale', 201)],
    ['sequel', W('Paper Lanterns II', 'Mara Vale', 201)],
    ['longer title', W('Paper Lanterns Forever', 'Mara Vale', 201)],
    ['cover without a tag', W('Paper Lanterns', 'Piano Dreamers', 201)],
  ];
  for (const [name, c] of traps) {
    const r = scoreCandidate(ORIGINAL, c);
    assert.ok(r.score < ACCEPT_SCORE, `${name}: ${r.score.toFixed(3)} (${r.reason})`);
  }
});

test('scoreCandidate: a version is fine when the wanted title asks for that version', () => {
  assert.ok(score(W('Paper Lanterns - Live at Harbor Hall', 'Mara Vale', 215), W('Paper Lanterns (Live at Harbor Hall)', 'Mara Vale', 215)) >= CONFIDENT_SCORE);
  assert.ok(score(W('Paper Lanterns - Acoustic', 'Mara Vale', 201), W('Paper Lanterns (Acoustic Version)', 'Mara Vale', 201)) >= CONFIDENT_SCORE);
  assert.ok(score(W('Paper Lanterns - Dusk Unit Remix', 'Mara Vale, Dusk Unit', 240), W('Paper Lanterns (Dusk Unit Remix)', 'Mara Vale', 240)) >= CONFIDENT_SCORE);
  assert.ok(score(W('Paper Lanterns - Instrumental', 'Mara Vale', 201), W('Paper Lanterns (Instrumental)', 'Mara Vale', 201)) >= CONFIDENT_SCORE);
  assert.ok(score(W('Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201), W('Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201)) >= CONFIDENT_SCORE);

  // …but not a different remix, and not the original standing in for a remix.
  const wantRemix = W('Paper Lanterns - Dusk Unit Remix', 'Mara Vale, Dusk Unit', 240);
  assert.ok(!accepted(wantRemix, W('Paper Lanterns (Nova Kids Remix)', 'Mara Vale', 240)));
  assert.ok(!accepted(wantRemix, W('Paper Lanterns', 'Mara Vale', 201)));
  assert.ok(!accepted(W('Paper Lanterns - Dusk Unit Remix', 'Mara Vale, Dusk Unit'), W('Paper Lanterns', 'Mara Vale', 201)), 'even without a duration to compare');
  // A live request may fall back to the studio take, but the live cut wins when both are there.
  const wantLive = W('Paper Lanterns - Live', 'Mara Vale', 205);
  const live = W('Paper Lanterns (Live)', 'Mara Vale', 205);
  const studio = W('Paper Lanterns', 'Mara Vale', 204);
  assert.ok(score(wantLive, live) > score(wantLive, studio));
  assert.equal(bestMatch(wantLive, [studio, live]).candidate, live);
});

test('scoreCandidate: duration — a few seconds off costs a lot, and breaks ties the right way', () => {
  const exact = score(ORIGINAL, W('Paper Lanterns', 'Mara Vale', 201));
  const off3 = score(ORIGINAL, W('Paper Lanterns', 'Mara Vale', 204));
  const off6 = score(ORIGINAL, W('Paper Lanterns', 'Mara Vale', 207));
  const off60 = score(ORIGINAL, W('Paper Lanterns', 'Mara Vale', 261));
  assert.ok(exact > off3 && off3 > off6 && off6 > off60);
  assert.ok(off6 < CONFIDENT_SCORE, 'no longer a confident match → the resolver keeps looking');
  assert.ok(exact - off60 >= 0.19);
  // Long version with any other doubt on top is out.
  assert.ok(!accepted(ORIGINAL, W('Paper Lanterns', 'Mara Vale, Juno Reyes Tribute', 261)));
  // An album cut and a 7-minute extended mix: the one with the right length wins.
  const pick = bestMatch(ORIGINAL, [W('Paper Lanterns (Extended Mix)', 'Mara Vale', 420), W('Paper Lanterns', 'Mara Vale', 201)]);
  assert.equal(pick.candidate.durationMs, 201000);
});

test('scoreCandidate: non-Latin titles — exact matches pass, near misses and other songs fail', () => {
  assert.ok(score(W('よるのひかり', 'ハナ', 200), W('よるのひかり', 'ハナ', 200)) >= CONFIDENT_SCORE);
  assert.ok(score(W('Белая ночь', 'Ника', 200), W('Белая ночь', 'Ника', 201)) >= CONFIDENT_SCORE);
  assert.ok(score(W('밤의 노래', '하늘', 200), W('밤의 노래', '하늘', 200)) >= CONFIDENT_SCORE);
  assert.ok(score(W('夜的光 (電影主題曲)', '林小雨', 200), W('夜的光', '林小雨', 200)) >= CONFIDENT_SCORE);
  assert.ok(score(W('رقصة الليل', 'نور', 200), W('رقصة الليل', 'نور', 200)) >= CONFIDENT_SCORE);

  assert.ok(!accepted(W('よるのひかり', 'ハナ', 200), W('あさのかぜ', 'ハナ', 200)), 'another song by the same artist');
  assert.ok(!accepted(W('よるのひかり', 'ハナ', 200), W('よるのひかる', 'ハナ', 200)), 'one character off is another title');
  assert.ok(!accepted(W('Белая ночь', 'Ника', 200), W('Белый день', 'Ника', 200)));
  assert.ok(!accepted(W('밤의 노래', '하늘', 200), W('밤의 노래 (Inst.)', '하늘', 200)), 'instrumental');
  assert.ok(!accepted(W('よるのひかり', 'ハナ', 200), W('よるのひかり (カラオケ)', 'ハナ', 200)), 'karaoke, in Japanese');
  assert.ok(!accepted(W('夜的光', '林小雨', 200), W('夜的光 (伴奏)', '林小雨', 200)), 'backing track, in Chinese');
});

test('scoreCandidate: transliterated title is accepted only with the same artist and the same length', () => {
  const wanted = W('よるのひかり', 'Hana Mori', 200);
  const r = scoreCandidate(wanted, W('Yoru no Hikari', 'Hana Mori', 200.4));
  assert.ok(r.score >= ACCEPT_SCORE && r.score < CONFIDENT_SCORE, String(r.score));
  assert.match(r.reason, /translit/);
  assert.ok(!accepted(wanted, W('Yoru no Hikari', 'Hana Mori', 204)), 'length differs');
  assert.ok(!accepted(wanted, W('Yoru no Hikari', 'Someone Else', 200)), 'artist differs');
  assert.ok(!accepted(W('よるのひかり', 'Hana Mori'), W('Yoru no Hikari', 'Hana Mori', 200)), 'no duration to lean on');
  // Artist credited in another script: needs a distinctive, identical title and the same length.
  assert.ok(accepted(W('Yoru no Hikari', '森ハナ', 200), W('Yoru no Hikari', 'Hana Mori', 200)));
  assert.ok(!accepted(W('Stay', '森ハナ', 200), W('Stay', 'Hana Mori', 200)), 'a common short title proves nothing');
  assert.ok(!accepted(W('Yoru no Hikari', '森ハナ', 200), W('Yoru no Hikari', 'Hana Mori', 209)));
});

test('bestMatch: two different transliteration guesses cancel each other out', () => {
  const wanted = W('よるのひかり', 'Hana Mori', 200);
  const one = bestMatch(wanted, [W('Yoru no Hikari', 'Hana Mori', 200), W('Asa no Kaze', 'Hana Mori', 230)]);
  assert.ok(one.score >= ACCEPT_SCORE);
  assert.equal(one.candidate.title, 'Yoru no Hikari');
  const two = bestMatch(wanted, [W('Yoru no Hikari', 'Hana Mori', 200), W('Asa no Kaze', 'Hana Mori', 200.5)]);
  assert.ok(two.score < ACCEPT_SCORE, 'ambiguous → rejected');
  // The same title twice (single + album) is not ambiguous.
  const dup = bestMatch(wanted, [W('Yoru no Hikari', 'Hana Mori', 200), W('Yoru no Hikari', 'Hana Mori', 200.6)]);
  assert.ok(dup.score >= ACCEPT_SCORE);
});

test('scoreCandidate: unknown artist (pasted titles) — the title has to carry it', () => {
  assert.ok(accepted(W('Paper Lanterns', ''), W('Paper Lanterns', 'Mara Vale', 201)));
  assert.ok(accepted(W('Paper Lanterns Mara Vale', ''), W('Paper Lanterns', 'Mara Vale', 201)), 'artist typed into the title');
  assert.ok(!accepted(W('Paper Lanterns', ''), W('Paper Lantern Parade', 'Mara Vale', 201)));
  assert.ok(!accepted(W('Paper Lanterns', ''), W('Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201)));
  assert.ok(!accepted(W('Paper Lanterns', ''), W('Paper Lanterns (Live)', 'Mara Vale', 201)));
});

test('scoreCandidate: never throws on junk and always returns 0..1', () => {
  const junk = [undefined, null, 42, {}, [], '', ' ', '()', '[[[[', '-', ' - - - ', '*'.repeat(50), 'a'.repeat(5000), '\u0000￿', '((((((((((x))))))))))'];
  for (const a of junk) {
    for (const b of junk) {
      const r = scoreCandidate({ title: a, artist: b, durationMs: a }, { title: b, artist: a, durationMs: b });
      assert.ok(r.score >= 0 && r.score <= 1, `${String(a).slice(0, 10)} / ${String(b).slice(0, 10)}`);
    }
  }
  assert.equal(bestMatch(ORIGINAL, []), null);
});

test('bestMatch: picks the right recording out of a realistic result page', () => {
  const page = [
    { id: 1, ...W('Paper Lanterns (Live at Harbor Hall)', 'Mara Vale', 233), rank: 300000 },
    { id: 2, ...W('Paper Lanterns (Dusk Unit Remix)', 'Mara Vale', 201), rank: 650000 },
    { id: 3, ...W('Paper Lanterns', 'Mara Vale', 201), rank: 900000 },
    { id: 4, ...W('Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201), rank: 100 },
    { id: 5, ...W('Paper Lanterns', 'The Hollow Pines', 201), rank: 990000 },
    { id: 6, ...W('Paper Lanterns (Sped Up)', 'Mara Vale', 171), rank: 800000 },
    { id: 7, ...W('Glass Harbor', 'Mara Vale', 201), rank: 950000 },
  ];
  const best = bestMatch(ORIGINAL, page);
  assert.equal(best.candidate.id, 3);
  assert.ok(best.score >= CONFIDENT_SCORE);

  // Without the original on the page there is nothing acceptable — "no match", not "closest thing".
  const without = bestMatch(ORIGINAL, page.filter((c) => c.id !== 3));
  assert.ok(without.score < ACCEPT_SCORE, `${without.candidate.title} ${without.score}`);
});

test('bestMatch: ties go to the more popular candidate, explicitness breaks near-ties', () => {
  const a = { id: 'a', ...W('Paper Lanterns', 'Mara Vale', 201), rank: 10 };
  const b = { id: 'b', ...W('Paper Lanterns', 'Mara Vale', 201), rank: 99 };
  assert.equal(bestMatch(ORIGINAL, [a, b]).candidate.id, 'b');
  assert.equal(bestMatch(ORIGINAL, [b, a]).candidate.id, 'b');

  const wanted = W('Slow Tide', 'Mara Vale', 180.3, { explicit: true });
  const clean = { id: 'clean', ...W('Slow Tide', 'Mara Vale', 180.2), explicit: false, rank: 999 };
  const explicit = { id: 'explicit', ...W('Slow Tide', 'Mara Vale', 180.1), explicit: true, rank: 1 };
  // Scores are capped at 1, so make both slightly imperfect to see the nudge.
  const w2 = { ...wanted, durationMs: 183500 };
  assert.equal(bestMatch(w2, [clean, explicit]).candidate.id, 'explicit');
});

test('scoreCandidate: "Title - Subtitle" on one side only matches when the length agrees', () => {
  const wanted = W('Harbor Song - Dockside 05', 'Dockside, Mara Vale', 150);
  assert.equal(parseTitle(wanted.title).head, 'harbor song');
  assert.equal(parseTitle('Harbor Song').head, '');
  assert.equal(parseTitle('Harbor Song - Live').head, '', 'a version note is not a subtitle');
  assert.ok(accepted(wanted, W('Harbor Song', 'Dockside', 150.8)));
  assert.ok(accepted(wanted, W('Harbor Song (Dockside 05)', 'Dockside', 149)));
  assert.ok(accepted(W('Harbor Song', 'Dockside', 150), W('Harbor Song - Dockside 05', 'Dockside', 150)), 'works both ways round');
  assert.ok(!accepted(wanted, W('Harbor Song', 'Dockside', 171)), 'length differs → the subtitle may be what tells them apart');
  assert.ok(!accepted(W('Harbor Song - Dockside 05', 'Dockside'), W('Harbor Song', 'Dockside', 150)), 'no duration, no benefit of the doubt');
  // Movements of one work share a head but are different tracks.
  assert.ok(!accepted(W('Harbor Suite - II. Andante', 'Mara Vale', 240), W('Harbor Suite - I. Allegro', 'Mara Vale', 240)));
});

test('scoreCandidate: a "Spotify Singles" session is a version, not part of the title', () => {
  const p = parseTitle('Paper Lanterns - Spotify Singles');
  assert.equal(p.base, 'paper lanterns');
  assert.ok(p.tags.has('live'));
  const wanted = W('Paper Lanterns - Spotify Singles', 'Mara Vale', 201);
  assert.ok(accepted(wanted, W('Paper Lanterns', 'Mara Vale', 201)), 'falls back to the studio take when the length matches');
  assert.ok(!accepted(wanted, W('Paper Lanterns', 'Mara Vale', 230)));
  assert.ok(!accepted(ORIGINAL, W('Paper Lanterns - Spotify Singles', 'Mara Vale', 201)), 'never the other way round');
});

test('scoreCandidate: cross-script guesses need millisecond agreement when the catalogue reports milliseconds', () => {
  const wanted = W('よるのひかり', 'Hana Mori', 200.02);
  const ms = (seconds) => ({ ...W('Yoru no Hikari', 'Hana Mori', seconds), exactDuration: true });
  assert.ok(accepted(wanted, ms(200.0)));
  assert.ok(accepted(wanted, ms(200.1)));
  assert.ok(!accepted(wanted, ms(200.6)), '0.6 s off is a different master when durations are exact');
  assert.ok(accepted(wanted, W('Yoru no Hikari', 'Hana Mori', 200.6)), 'whole-second catalogues get a 1 s window');
  assert.ok(!accepted(wanted, W('Yoru no Hikari', 'Hana Mori', 201.3)));
});

test('scoreCandidate: explicit vs clean edit of the same track — the matching one wins even at a perfect score', () => {
  const wanted = W('Slow Tide', 'Mara Vale', 180, { explicit: true });
  const clean = { id: 'clean', ...W('Slow Tide', 'Mara Vale', 180), explicit: false, rank: 999 };
  const explicit = { id: 'explicit', ...W('Slow Tide', 'Mara Vale', 180), explicit: true, rank: 1 };
  assert.equal(score(wanted, explicit), 1);
  assert.ok(score(wanted, clean) < 1 && score(wanted, clean) >= CONFIDENT_SCORE);
  assert.equal(bestMatch(wanted, [clean, explicit]).candidate.id, 'explicit');
  assert.equal(bestMatch({ ...wanted, explicit: false }, [explicit, clean]).candidate.id, 'clean');
  // Unknown explicitness on either side changes nothing.
  assert.equal(score({ ...wanted, explicit: undefined }, clean), 1);
});

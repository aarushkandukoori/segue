import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, loadPlaylist, DEMOS, EXAMPLES, SourceError } from '../js/sources/index.js';

const PL = '37i9dQZF1DXcBWIGoYBM5M';
const AL = '2noRn2Aes5aoNVsU6iWThc';
const TR = '11hcBLPtbMp4aQI6zGQLub';
const sp = (type, id) => ({ kind: 'spotify', type, id });
const dz = (type, id) => ({ kind: 'deezer', type, id });

/** [input, expected kind/type/id] — things that must load. */
const SUPPORTED = [
  [`https://open.spotify.com/playlist/${PL}`, sp('playlist', PL)],
  [`https://open.spotify.com/playlist/${PL}?si=4f1c2a9b8d7e4c11`, sp('playlist', PL)],
  [`https://open.spotify.com/playlist/${PL}?si=abc&pt=def&nd=1&dlsi=xyz`, sp('playlist', PL)],
  [`https://open.spotify.com/playlist/${PL}/`, sp('playlist', PL)],
  [`https://open.spotify.com/playlist/${PL}#fragment`, sp('playlist', PL)],
  [`https://open.spotify.com/intl-de/playlist/${PL}`, sp('playlist', PL)],
  [`https://open.spotify.com/intl-pt/album/${AL}?si=x`, sp('album', AL)],
  [`https://open.spotify.com/embed/playlist/${PL}?utm_source=generator`, sp('playlist', PL)],
  [`https://open.spotify.com/embed/album/${AL}`, sp('album', AL)],
  [`https://open.spotify.com/embed?uri=spotify:playlist:${PL}`, sp('playlist', PL)],
  [`https://open.spotify.com/user/spotify/playlist/${PL}`, sp('playlist', PL)],
  [`https://open.spotify.com/user/some.user-name_1/playlist/${PL}?si=abc`, sp('playlist', PL)],
  [`http://open.spotify.com/playlist/${PL}`, sp('playlist', PL)],
  [`https://play.spotify.com/playlist/${PL}`, sp('playlist', PL)],
  [`open.spotify.com/playlist/${PL}`, sp('playlist', PL)],
  [`HTTPS://OPEN.SPOTIFY.COM/playlist/${PL}`, sp('playlist', PL)],
  [`  https://open.spotify.com/playlist/${PL}  \n`, sp('playlist', PL)],
  [`<https://open.spotify.com/playlist/${PL}>`, sp('playlist', PL)],
  [`Check out my playlist: https://open.spotify.com/playlist/${PL}?si=abc`, sp('playlist', PL)],
  [`My road trip mix\nhttps://open.spotify.com/playlist/${PL}`, sp('playlist', PL)],
  [`https://open.spotify.com/album/${AL}`, sp('album', AL)],
  [`spotify:playlist:${PL}`, sp('playlist', PL)],
  [`spotify:album:${AL}`, sp('album', AL)],
  [`spotify:user:spotify:playlist:${PL}`, sp('playlist', PL)],
  ['https://www.deezer.com/playlist/3155776842', dz('playlist', '3155776842')],
  ['https://deezer.com/playlist/3155776842', dz('playlist', '3155776842')],
  ['https://www.deezer.com/us/playlist/3155776842', dz('playlist', '3155776842')],
  ['https://www.deezer.com/pt-br/playlist/1111141961?utm_source=deezer', dz('playlist', '1111141961')],
  ['https://www.deezer.com/en/album/302127', dz('album', '302127')],
  ['deezer.com/fr/album/302127', dz('album', '302127')],
  ['deezer:playlist:3155776842', dz('playlist', '3155776842')],
  ['deezer:album:302127', dz('album', '302127')],
  ['deezer:chart:113', dz('chart', '113')],
  ['deezer:chart:0', dz('chart', '0')],
];

/** [input, expected reason, words the message must contain] — recognised but not loadable. */
const UNSUPPORTED = [
  [`https://open.spotify.com/track/${TR}`, 'spotify-track', /playlist or album/i],
  [`https://open.spotify.com/intl-fr/track/${TR}?si=1`, 'spotify-track', /playlist or album/i],
  [`spotify:track:${TR}`, 'spotify-track', /playlist or album/i],
  [`https://open.spotify.com/track/${TR}\nhttps://open.spotify.com/track/${TR}\nhttps://open.spotify.com/track/${TR}`, 'spotify-track', /playlist/i],
  ['https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02', 'spotify-artist', /albums or playlists/i],
  ['https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk', 'spotify-podcast', /podcast/i],
  ['https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk', 'spotify-podcast', /podcast/i],
  ['https://open.spotify.com/collection/tracks', 'spotify-liked', /Liked Songs/],
  ['https://open.spotify.com/user/spotify', 'spotify-profile', /profile/i],
  ['https://spotify.link/AbCdEfGhIj', 'spotify-short', /open\.spotify\.com\/playlist/],
  ['spotify.link/AbCdEfGhIj', 'spotify-short', /open\.spotify\.com\/playlist/],
  ['https://spotify.app.link/AbCdEfGhIj?_p=c1', 'spotify-short', /open\.spotify\.com\/playlist/],
  ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIG', 'spotify-bad-id', /cut off/i],
  ['https://open.spotify.com/playlist/', 'spotify-bad-id', /cut off/i],
  ['https://open.spotify.com/', 'spotify-other', /playlists and albums/i],
  ['https://www.spotify.com/us/premium/', 'spotify-other', /playlists and albums/i],
  ['https://www.deezer.com/us/track/3135553', 'deezer-track', /playlist or album/i],
  ['https://www.deezer.com/en/artist/27', 'deezer-artist', /albums or playlists/i],
  ['https://deezer.page.link/AbCdEf123', 'deezer-short', /deezer\.com\/playlist/],
  ['https://link.deezer.com/s/30abcDEF', 'deezer-short', /deezer\.com\/playlist/],
  ['https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb', 'apple-music', /Apple Music/],
  ['https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', 'youtube', /YouTube/],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube', /YouTube/],
  ['https://music.youtube.com/playlist?list=RDCLAK5uy_k', 'youtube', /YouTube/],
  ['https://soundcloud.com/someone/sets/a-set', 'other-service', /not supported/i],
  ['https://tidal.com/browse/playlist/1b418bb8-90a7-4f87-901d-707993838346', 'other-service', /not supported/i],
  ['https://example.com/some/page', 'other-link', /Spotify or Deezer playlist link/],
];

// Hostile strings are put together from harmless fragments, so this file holds no literal payloads.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const QUOTE = String.fromCharCode(39);
const MARKUP = `${LT}b${GT}x${LT}/b${GT}`;
const SCHEME_JS = ['java', 'script:void 0'].join('');
const SCHEME_DATA = ['da', 'ta:text/html,', MARKUP].join('');

/** Hostile / malformed input: must come back 'unknown', never throw, never yield an id. */
const HOSTILE = [
  ['', 'empty'],
  ['   \n\t  ', 'empty'],
  [null, 'empty'],
  [undefined, 'empty'],
  [42, 'empty'],
  [{ toString: () => `https://open.spotify.com/playlist/${PL}` }, 'empty'],
  [SCHEME_JS, 'not-a-list'],
  [SCHEME_DATA, 'not-a-list'],
  [`${LT}img src=x${GT}`, 'not-a-list'],
  [`https://open.spotify.com.evil.example/playlist/${PL}`, 'other-link'],
  [`https://evil.example/?next=https://open.spotify.com/playlist/${PL}`, 'other-link'],
  [`https://evil.example/open.spotify.com/playlist/${PL}`, 'other-link'],
  [`https://open.spotify.com@evil.example/playlist/${PL}`, 'other-link'],
  [`https://open.spotify.com/playlist/../../etc/passwd`, null],
  [`https://open.spotify.com/playlist/${PL}%00.html`, 'spotify-bad-id'],
  [`https://open.spotify.com/playlist/${MARKUP}`, null],
  [`spotify:playlist:${PL}${QUOTE};--`, 'spotify-bad-id'],
  ['spotify:playlist:', 'spotify-bad-id'],
  ['spotify:', 'spotify-other'],
  ['deezer:chart:99999', 'deezer-other'],
  ['deezer:chart:-1', 'deezer-other'],
  ['deezer:playlist:12abc', 'deezer-other'],
  ['https://www.deezer.com/playlist/1e9', 'deezer-other'],
  ['ftp://open.spotify.com/playlist/' + PL, 'not-a-list'],
  ['https://', 'not-a-list'],
  ['http://[::1', 'not-a-list'],
  ['x'.repeat(200000), 'not-a-list'],
];

test('parseInput: supported links, URIs and share ids', () => {
  assert.ok(SUPPORTED.length >= 30);
  for (const [input, want] of SUPPORTED) {
    assert.deepEqual(parseInput(input), want, input);
  }
});

test('parseInput: unsupported things get a specific reason and a helpful message', () => {
  for (const [input, reason, mustSay] of UNSUPPORTED) {
    const got = parseInput(input);
    assert.equal(got.kind, 'unknown', input);
    assert.equal(got.reason, reason, input);
    assert.match(got.message, mustSay, input);
    assert.ok(got.message.length > 20 && got.message.length < 220, `message length for ${input}`);
  }
});

test('parseInput: a single track link still reports which track it was', () => {
  assert.deepEqual(
    { type: parseInput(`https://open.spotify.com/track/${TR}`).type, id: parseInput(`https://open.spotify.com/track/${TR}`).id },
    { type: 'track', id: TR },
  );
});

test('parseInput: hostile and malformed input never throws and never yields an id', () => {
  for (const [input, reason] of HOSTILE) {
    let got;
    assert.doesNotThrow(() => {
      got = parseInput(/** @type {any} */ (input));
    }, String(input).slice(0, 60));
    assert.equal(got.kind, 'unknown', String(input).slice(0, 60));
    if (reason) assert.equal(got.reason, reason, String(input).slice(0, 60));
    assert.equal(got.id, undefined, String(input).slice(0, 60));
    assert.equal(typeof got.message, 'string');
  }
});

test('parseInput: junk after a valid link is ignored, and only the strict id comes out', () => {
  assert.deepEqual(parseInput(`spotify:playlist:${PL}${QUOTE}; x;--`), sp('playlist', PL));
  assert.deepEqual(parseInput(`https://open.spotify.com/playlist/${PL}?si="${GT}${MARKUP}`), sp('playlist', PL));
  assert.deepEqual(parseInput(`https://open.spotify.com/playlist/${PL}).`), sp('playlist', PL));
});

test('parseInput: ids are only ever strict base62 / digits', () => {
  for (const [input] of [...SUPPORTED, ...UNSUPPORTED, ...HOSTILE]) {
    const got = parseInput(/** @type {any} */ (input));
    if (got.id !== undefined) assert.match(got.id, /^(?:[A-Za-z0-9]{22}|\d{1,15})$/);
  }
});

test('parseInput: song lists are text', () => {
  const lists = [
    'Daft Punk - One More Time\nQueen - Bohemian Rhapsody',
    '1. Daft Punk – One More Time (5:20)\n2. Queen – Bohemian Rhapsody (5:55)\n3. a-ha – Take On Me',
    'One More Time by Daft Punk\nBohemian Rhapsody by Queen',
    'One More Time\nBohemian Rhapsody\nTake On Me',
    'Daft Punk - One More Time',
    'Daft Punk\tOne More Time\nQueen\tBohemian Rhapsody',
    'Stromae — Alors on danse\r\nBad Bunny — DtMF\r\n',
    'YOASOBI - アイドル\n王菲 - 红豆',
  ];
  for (const text of lists) assert.deepEqual(parseInput(text), { kind: 'text' }, text);
});

test('parseInput: a list that happens to contain a link is still a list; a link with a caption is a link', () => {
  const list = `Daft Punk - One More Time\nQueen - Bohemian Rhapsody\na-ha - Take On Me\nsee also https://example.com/x\nToto - Africa`;
  assert.deepEqual(parseInput(list), { kind: 'text' });
  assert.deepEqual(parseInput(`Summer 2026\n\nhttps://open.spotify.com/playlist/${PL}?si=1`), sp('playlist', PL));
});

test('parseInput: one bare word is not a playlist', () => {
  const got = parseInput('hello');
  assert.equal(got.kind, 'unknown');
  assert.equal(got.reason, 'not-a-list');
  assert.match(got.message, /Spotify or Deezer playlist link/);
});

test('total parseInput table size', () => {
  assert.ok(SUPPORTED.length + UNSUPPORTED.length + HOSTILE.length >= 40);
});

test('loadPlaylist: unsupported input rejects with a friendly SourceError and makes no request', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    throw new Error('network must not be touched');
  });
  await assert.rejects(loadPlaylist(`https://open.spotify.com/track/${TR}`), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'unsupported');
    assert.match(err.message, /playlist or album/);
    return true;
  });
  await assert.rejects(loadPlaylist(''), (err) => err instanceof SourceError && err.code === 'empty-input');
  await assert.rejects(loadPlaylist('https://spotify.link/abc'), (err) => err instanceof SourceError && /open\.spotify\.com/.test(err.message));
  assert.equal(calls.length, 0);
});

test('loadPlaylist: pasted text becomes a text playlist without any network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be touched');
  });
  const status = [];
  const pl = await loadPlaylist('Daft Punk - One More Time\nQueen - Bohemian Rhapsody', { onStatus: (m) => status.push(m) });
  assert.equal(pl.source, 'text');
  assert.equal(pl.tracks.length, 2);
  assert.match(pl.id, /^text:[a-z0-9]+$/);
  assert.ok(status.length >= 1);
});

test('loadPlaylist: an already-aborted signal rejects with AbortError', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(loadPlaylist('deezer:chart:113', { signal: ctrl.signal }), (err) => err.name === 'AbortError');
});

test('DEMOS and EXAMPLES are well-formed and parse to what they claim', () => {
  assert.ok(DEMOS.length >= 6 && DEMOS.length <= 8);
  assert.equal(new Set(DEMOS.map((d) => d.id)).size, DEMOS.length);
  for (const d of DEMOS) {
    assert.ok(d.label && d.emoji && d.id);
    const p = parseInput(d.input);
    assert.equal(p.kind, 'deezer');
    assert.equal(p.type, 'chart');
  }
  assert.ok(EXAMPLES.length >= 4 && EXAMPLES.length <= 6);
  for (const e of EXAMPLES) {
    assert.ok(e.label);
    assert.match(e.url, /^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]{22}$/);
    assert.equal(parseInput(e.url).kind, 'spotify');
  }
});

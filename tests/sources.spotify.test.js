import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  RELAYS,
  SPOTIFY_EMBED_CAP,
  SPOTIFY_MAX_TRACKS,
  hedgedChain,
  loadSpotify,
  nextDataFromHtml,
  playlistFromEntity,
  playlistFromMarkdown,
  readNextData,
} from '../js/sources/spotify.js';
import { SourceError } from '../js/sources/util.js';

const PID = '37i9dQZF1DXcBWIGoYBM5M';
const REF = { type: 'playlist', id: PID };
const NBSP = String.fromCharCode(0xa0);
const ZWSP = String.fromCharCode(0x200b);

/* ---------- hand-written fixtures in the shapes the embed page / relays really return ---------- */

const track = (id, title, subtitle, duration, extra = {}) => ({
  uri: `spotify:track:${id}`,
  uid: 'abc',
  title,
  subtitle,
  isExplicit: false,
  duration,
  isPlayable: true,
  audioPreview: { format: 'MP3_96', url: 'https://p.scdn.co/mp3-preview/SECRET' },
  entityType: 'track',
  ...extra,
});

const T1 = '11hcBLPtbMp4aQI6zGQLub';
const T2 = '3h5T5JypYU7huFiVYhv1dr';
const T3 = '48RrDBpOSSl1aLVCalGl5C';

function entity(overrides = {}) {
  return {
    type: 'playlist',
    name: 'Today’s Top Hits',
    uri: `spotify:playlist:${PID}`,
    id: PID,
    title: 'Today’s Top Hits',
    subtitle: 'Spotify',
    coverArt: { sources: [{ height: null, width: null, url: 'https://i.scdn.co/image/ab67706f0000000271992d3b45eb1297df9c6bf7' }] },
    trackList: [
      track(T1, 'Patient Zero', 'Taylor Swift', 225868),
      track(T2, 'BbY WOW', `KAROL G,${NBSP}Judeline , rusowsky`, 225834),
      track(T3, `The${ZWSP} Monster`, 'Eminem, Rihanna', 250188, { isExplicit: true }),
    ],
    ...overrides,
  };
}

function nextData(ent = entity()) {
  return {
    props: {
      pageProps: {
        state: {
          data: { entity: ent, embeded_entity_uri: ent.uri },
          settings: { session: { accessToken: 'BQD-ANON-TOKEN-MUST-NOT-LEAK', isAnonymous: true } },
        },
      },
    },
    page: '/playlist/[id]',
  };
}
const notFoundData = () => ({ props: { pageProps: { status: 404, title: 'Page not found' } }, page: '/playlist/[id]' });

// The three relay response shapes (SPEC §1).
const scraperBody = (nd) => JSON.stringify({ result: { 'script#__NEXT_DATA__': [JSON.stringify(nd)] } });
const jinaHtmlBody = (nd) =>
  `<html lang="en"><head><title>x</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></body></html>`;
const microlinkBody = (nd) => JSON.stringify({ status: 'success', data: { publisher: 'Spotify', next: nd, lang: 'en' } });

const MARKDOWN = `Title: Today’s Top Hits - Spotify

URL Source: https://open.spotify.com/embed/playlist/${PID}

Markdown Content:
1.   ### Patient Zero

#### Taylor Swift

03:45

2.   ### the cure

#### E Olivia Rodrigo

04:57

3.   ### BbY WOW

#### KAROL G,Judeline,rusowsky

03:45

4.   ### A Very Long One

#### Some Orchestra

1:02:03
`;
const MARKDOWN_404 = `Title: - | Spotify

URL Source: https://open.spotify.com/embed/playlist/${PID}

Markdown Content:
## Page not found

We can’t seem to find the page you are looking for.
`;

/* ---------- fake fetch ---------- */

const ok = (body, status = 200) => new Response(body, { status });
const never = (init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/**
 * Routes by relay. Each handler gets (url, init) and returns a Response / throws / hangs.
 * Missing handlers fail like an unreachable host.
 */
function fakeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    let name;
    if (u.hostname === 'web.scraper.workers.dev') name = u.searchParams.get('scrape') === 'attr' ? 'count' : 'scraper';
    else if (u.hostname === 'r.jina.ai') name = init.headers && init.headers['X-Return-Format'] === 'html' ? 'jina' : 'markdown';
    else if (u.hostname === 'api.microlink.io') name = 'microlink';
    else if (u.hostname === 'open.spotify.com' && u.pathname === '/oembed') name = 'oembed';
    else name = 'other';
    calls.push(name);
    const h = handlers[name];
    if (!h) throw new TypeError('fetch failed');
    return h(url, init);
  };
  return { fetchImpl, calls };
}

const fast = { hedgeMs: 25, timeoutMs: 120 };

/* ---------- parsing ---------- */

test('relay shapes: each relay extracts the same __NEXT_DATA__', () => {
  const nd = nextData();
  const bodies = [JSON.parse(scraperBody(nd)), jinaHtmlBody(nd), JSON.parse(microlinkBody(nd))];
  assert.deepEqual(RELAYS.map((r) => r.name), ['scraper', 'jina', 'microlink']);
  RELAYS.forEach((relay, i) => {
    const got = readNextData(relay.extract(bodies[i]));
    assert.equal(got.kind, 'entity', relay.name);
    assert.equal(got.entity.trackList.length, 3, relay.name);
  });
  // microlink sometimes hands the script text back unparsed
  const asText = { status: 'success', data: { next: JSON.stringify(nd) } };
  assert.equal(readNextData(RELAYS[2].extract(asText)).kind, 'entity');
});

test('relay shapes: junk bodies are "bad", Spotify 404 pages are "not-found"', () => {
  for (const relay of RELAYS) {
    for (const junk of [null, undefined, '', 'nope', {}, { result: {} }, { result: { 'script#__NEXT_DATA__': ['{not json'] } }, { status: 'fail' }, '<html></html>', 42]) {
      assert.equal(readNextData(relay.extract(junk)).kind, 'bad', `${relay.name} ${JSON.stringify(junk)}`);
    }
  }
  assert.equal(readNextData(notFoundData()).kind, 'not-found');
  // an entity without any track list (what a private playlist degrades to) is "not found", not a crash
  assert.equal(readNextData(nextData({ type: 'playlist', id: PID })).kind, 'not-found');
  assert.equal(readNextData({ props: { pageProps: { status: 500 } } }).kind, 'bad');
});

test('relay URLs: the embed page, properly encoded', () => {
  const target = `https://open.spotify.com/embed/playlist/${PID}`;
  const [a, b, c] = RELAYS.map((r) => r.build(target));
  assert.equal(a.url, `https://web.scraper.workers.dev/?url=${encodeURIComponent(target)}&selector=script%23__NEXT_DATA__&scrape=text`);
  assert.equal(b.url, `https://r.jina.ai/${target}`);
  assert.deepEqual(b.headers, { 'X-Return-Format': 'html' });
  assert.equal(c.url, `https://api.microlink.io/?url=${encodeURIComponent(target)}&data.next.selector=%23__NEXT_DATA__&data.next.attr=text`);
});

test('nextDataFromHtml: finds the script regardless of attribute order, ignores other scripts', () => {
  const nd = nextData();
  const html = `<script>var x = "<script id=__NEXT>";</script><script type="application/json" id="__NEXT_DATA__" crossorigin>${JSON.stringify(nd)}</script>`;
  assert.deepEqual(nextDataFromHtml(html), nd);
  assert.equal(nextDataFromHtml('<script id="__NEXT_DATA__">{broken</script>'), null);
  assert.equal(nextDataFromHtml(undefined), null);
});

test('playlistFromEntity: maps to the Playlist / TrackMeta contract', () => {
  const { playlist, rawCount } = playlistFromEntity(entity(), REF);
  assert.equal(rawCount, 3);
  assert.deepEqual(playlist, {
    id: `spotify:playlist:${PID}`,
    source: 'spotify',
    title: 'Today’s Top Hits',
    link: `https://open.spotify.com/playlist/${PID}`,
    tracks: [
      { id: `spotify:track:${T1}`, title: 'Patient Zero', artist: 'Taylor Swift', link: `https://open.spotify.com/track/${T1}`, durationMs: 225868, explicit: false },
      { id: `spotify:track:${T2}`, title: 'BbY WOW', artist: 'KAROL G, Judeline, rusowsky', link: `https://open.spotify.com/track/${T2}`, durationMs: 225834, explicit: false },
      { id: `spotify:track:${T3}`, title: 'The Monster', artist: 'Eminem, Rihanna', link: `https://open.spotify.com/track/${T3}`, durationMs: 250188, explicit: true },
    ],
    subtitle: 'Spotify',
    artwork: 'https://i.scdn.co/image/ab67706f0000000271992d3b45eb1297df9c6bf7',
  });
});

test('playlistFromEntity: Spotify audio and tokens never make it into the result', () => {
  const { playlist } = playlistFromEntity(entity(), REF);
  const dump = JSON.stringify(playlist);
  assert.doesNotMatch(dump, /audioPreview|p\.scdn\.co|mp3-preview|SECRET|accessToken|TOKEN/);
  for (const t of playlist.tracks) {
    assert.deepEqual(Object.keys(t).sort(), ['artist', 'durationMs', 'explicit', 'id', 'link', 'title']);
    assert.equal(t.preview, undefined);
  }
});

test('playlistFromEntity: skips episodes, junk rows and duplicates; tolerates missing fields', () => {
  const ent = entity({
    title: '',
    name: '',
    subtitle: undefined,
    coverArt: { sources: [{ url: 'http://insecure.example/cover.jpg' }] },
    trackList: [
      track(T1, 'Patient Zero', 'Taylor Swift', 225868),
      track(T1, 'Patient Zero', 'Taylor Swift', 225868), // added twice
      { uri: 'spotify:episode:4rOoJ6Egrf8K2IrywzwOMk', title: 'A podcast', subtitle: 'Host', duration: 1 },
      { uri: 'spotify:local:::song:200', title: 'Local file', subtitle: '' },
      { uri: `spotify:track:${T2}`, title: '   ', subtitle: 'No title' },
      { uri: 'spotify:track:short', title: 'Bad id', subtitle: 'x' },
      null,
      'string',
      { uri: `spotify:track:${T3}`, title: 'No artist or duration', duration: 'abc' },
    ],
  });
  const { playlist, rawCount } = playlistFromEntity(ent, REF);
  assert.equal(rawCount, 9);
  assert.deepEqual(
    playlist.tracks.map((t) => t.id),
    [`spotify:track:${T1}`, `spotify:track:${T3}`],
  );
  assert.equal(playlist.tracks[1].artist, 'Unknown artist');
  assert.equal(playlist.tracks[1].durationMs, undefined);
  assert.equal(playlist.title, 'Spotify playlist');
  assert.equal(playlist.artwork, undefined, 'http cover must be dropped');
  assert.equal('subtitle' in playlist, false);
});

test('playlistFromEntity: albums use visualIdentity for the cover and give every track that cover', () => {
  const AID = '2noRn2Aes5aoNVsU6iWThc';
  const ent = {
    type: 'album',
    id: AID,
    title: 'Discovery',
    subtitle: 'Daft Punk',
    visualIdentity: {
      image: [
        { url: 'https://image-cdn-fa.spotifycdn.com/image/small', maxWidth: 64, maxHeight: 64 },
        { url: 'https://image-cdn-fa.spotifycdn.com/image/medium', maxWidth: 300, maxHeight: 300 },
        { url: 'https://image-cdn-fa.spotifycdn.com/image/large', maxWidth: 640, maxHeight: 640 },
      ],
    },
    trackList: [track(T1, 'One More Time', 'Daft Punk', 320357)],
  };
  const { playlist } = playlistFromEntity(ent, { type: 'album', id: AID });
  assert.equal(playlist.id, `spotify:album:${AID}`);
  assert.equal(playlist.link, `https://open.spotify.com/album/${AID}`);
  assert.equal(playlist.artwork, 'https://image-cdn-fa.spotifycdn.com/image/medium');
  assert.equal(playlist.tracks[0].artwork, playlist.artwork);
});

test('playlistFromMarkdown: last-resort parse of the jina markdown shape', () => {
  const got = playlistFromMarkdown(MARKDOWN, REF);
  assert.equal(got.kind, 'playlist');
  assert.equal(got.playlist.title, 'Today’s Top Hits');
  assert.equal(got.playlist.id, `spotify:playlist:${PID}`);
  assert.deepEqual(got.playlist.tracks, [
    { id: 'spotify:md:0', title: 'Patient Zero', artist: 'Taylor Swift', explicit: false, durationMs: 225000 },
    { id: 'spotify:md:1', title: 'the cure', artist: 'Olivia Rodrigo', explicit: true, durationMs: 297000 },
    { id: 'spotify:md:2', title: 'BbY WOW', artist: 'KAROL G, Judeline, rusowsky', explicit: false, durationMs: 225000 },
    { id: 'spotify:md:3', title: 'A Very Long One', artist: 'Some Orchestra', explicit: false, durationMs: 3723000 },
  ]);
  assert.equal(playlistFromMarkdown(MARKDOWN_404, REF).kind, 'not-found');
  for (const junk of ['', 'hello world', '### heading only', null, undefined]) {
    assert.equal(playlistFromMarkdown(/** @type {any} */ (junk), REF).kind, 'bad');
  }
});

/* ---------- answers built to be slow, or simply enormous ---------- */

// Tags are put together from pieces so this file never contains one.
const OPEN = ['<', 'script'].join('');
const CLOSE = ['</', 'script>'].join('');
const lean = (i) => ({ uri: `spotify:track:${String(i).padStart(22, 'a')}`, title: `Song ${i}`, subtitle: 'Mara Vale', duration: 200000 + i });

test('nextDataFromHtml: tag case, quotes and attribute order do not matter; only a script tag with that id counts', () => {
  const json = '{"props":{"n":1}}';
  const want = { props: { n: 1 } };
  const up = (text) => text.toUpperCase();
  for (const html of [
    `${OPEN} id="__NEXT_DATA__">${json}${CLOSE}`,
    `${OPEN} id='__NEXT_DATA__' type="application/json">${json}${CLOSE}`,
    `${OPEN} defer type="application/json" id="__NEXT_DATA__"\n crossorigin>${json}${CLOSE}`,
    `${up(OPEN)} ID="__NEXT_DATA__">${json}${up(CLOSE)}`,
    `<p>1 > 0</p>${OPEN} src="a.js">${CLOSE}${OPEN}>var s = "${OPEN} id=x";${CLOSE}${OPEN} id="__NEXT_DATA__">${json}${CLOSE}${OPEN} id="__NEXT_DATA__">{"second":true}${CLOSE}`,
    `${OPEN} ${OPEN} id="__NEXT_DATA__">${json}${CLOSE}`,
  ]) {
    assert.deepEqual(nextDataFromHtml(html), want, html.slice(0, 60));
  }
  for (const html of [
    '',
    `${OPEN} id="__NEXT_DATA__">${json}`, // never closed
    `${OPEN} id="__NEXT_DATA__"`, // tag never ends
    `${OPEN}s id="__NEXT_DATA__">${json}${CLOSE}`, // some other element
    `<div id="__NEXT_DATA__">${json}</div>`,
    `${OPEN} id="__NEXT_DATA_">${json}${CLOSE}`,
    `${OPEN} id="__NEXT_DATA__">[1,2`,
    `${OPEN} id="__NEXT_DATA__">7${CLOSE}`, // JSON, but not an object
  ]) {
    assert.equal(nextDataFromHtml(html), null, html.slice(0, 60));
  }
});

test('nextDataFromHtml: agrees with the one-pattern definition on every short page', () => {
  // Reference: the single regular expression this used to be. Fine on a handful of fragments,
  // which is all it gets here; hopeless on a large hostile page (next test).
  const pattern = new RegExp(`${OPEN}\\b[^>]*\\bid=["']__NEXT_DATA__["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const reference = (html) => {
    const m = pattern.exec(html);
    if (!m) return null;
    try {
      const v = JSON.parse(m[1]);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  const pieces = [OPEN, OPEN.toUpperCase(), ' ', ' id="__NEXT_DATA__"', " id='__NEXT_DATA__'", ' type="x"', '>', '{"a":1}', CLOSE, CLOSE.toUpperCase(), 'x'];
  let checked = 0;
  let found = 0;
  const walk = (html, depth) => {
    if (html) {
      const want = reference(html);
      const got = nextDataFromHtml(html);
      if (JSON.stringify(got) !== JSON.stringify(want)) assert.fail(`${JSON.stringify(html)}: got ${JSON.stringify(got)}, reference says ${JSON.stringify(want)}`);
      checked++;
      if (want) found++;
    }
    if (depth < 6) for (const piece of pieces) walk(html + piece, depth + 1);
  };
  walk('', 0);
  assert.ok(checked > 1500000 && found > 500, `${checked} pages, ${found} with data`);
});

test('playlistFromEntity: keeps the first SPOTIFY_MAX_TRACKS songs and counts the rest', () => {
  assert.ok(SPOTIFY_MAX_TRACKS >= SPOTIFY_EMBED_CAP, 'a real embed page is never cut');
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push(lean(i));
    if (i % 10 === 0) rows.push(lean(i), null, { uri: 'spotify:episode:4rOoJ6Egrf8K2IrywzwOMk', title: 'A podcast' }); // a repeat, junk, an episode
  }
  const { playlist, rawCount, found } = playlistFromEntity(entity({ trackList: rows }), REF);
  assert.equal(rawCount, 6500);
  assert.equal(found, 5000, 'songs, not rows');
  assert.equal(playlist.tracks.length, SPOTIFY_MAX_TRACKS);
  assert.deepEqual(playlist.tracks.map((t) => t.title), Array.from({ length: SPOTIFY_MAX_TRACKS }, (_, i) => `Song ${i}`));
  // Nothing is counted that was not kept when the list is short.
  const small = playlistFromEntity(entity(), REF);
  assert.equal(small.found, small.playlist.tracks.length);
});

test('playlistFromMarkdown: spacing, line endings and over-long lines', () => {
  const md = ['Title: Night Drive | Spotify', '', '  1.\t###   First Light   ', '', '\t####   E   Mara Vale , Juno Reyes  ', '', '  3:07  ', '2. ## Second Wind', '### Dusk Unit', '1:02:03', `3. #### ${'Long '.repeat(200)}`, '#### Mara Vale', '0:45'].join('\r\n');
  const got = playlistFromMarkdown(md, REF);
  assert.equal(got.kind, 'playlist');
  assert.equal(got.playlist.title, 'Night Drive');
  assert.deepEqual(got.playlist.tracks.slice(0, 2), [
    { id: 'spotify:md:0', title: 'First Light', artist: 'Mara Vale, Juno Reyes', explicit: true, durationMs: 187000 },
    { id: 'spotify:md:1', title: 'Second Wind', artist: 'Dusk Unit', explicit: false, durationMs: 3723000 },
  ]);
  const long = got.playlist.tracks[2];
  assert.ok(long.title.startsWith('Long Long') && long.title.length <= 300, `a very long title is cut, not dropped (${long.title.length} chars)`);
  assert.equal(long.artist, 'Mara Vale');
  assert.equal(long.durationMs, 45000);
  for (const head of ['Title: Night Drive - Spotify', 'Title: Night Drive | Spotify | Spotify', 'Title:Night Drive', 'Title:   Night Drive   ']) {
    assert.equal(playlistFromMarkdown(`${head}\n1. ### First Light\n`, REF).playlist.title, 'Night Drive', head);
  }
  assert.equal(playlistFromMarkdown('no title line\n1. ### First Light\n', REF).playlist.title, 'Spotify playlist');
  for (const notFound of ['# Page not found', '##Page not found', '   ### page NOT found   ']) {
    assert.equal(playlistFromMarkdown(`Title: x\n${notFound}\n1. ### First Light\n`, REF).kind, 'not-found', notFound);
  }
  // A numbered heading without a title is skipped, and the lines after it are not the previous song's.
  const gap = playlistFromMarkdown('1. ### First Light\n2. ###\n#### Somebody Else\n9:59\n3. ### Second Wind\n', REF).playlist.tracks;
  assert.deepEqual(gap, [
    { id: 'spotify:md:0', title: 'First Light', artist: 'Unknown artist', explicit: false },
    { id: 'spotify:md:1', title: 'Second Wind', artist: 'Unknown artist', explicit: false },
  ]);
  // A song may be called that; a heading inside a numbered item is not the 404 page.
  assert.equal(playlistFromMarkdown('1. ### Page not found\n#### Mara Vale\n', REF).kind, 'playlist');
  assert.equal(playlistFromMarkdown('#### Page not found\n1. ### First Light\n', REF).kind, 'playlist');
});

test('playlistFromMarkdown: keeps the first SPOTIFY_MAX_TRACKS songs and counts the rest', () => {
  const md = Array.from({ length: 1000 }, (_, i) => `${i + 1}.   ### Song ${i}\n\n#### Mara Vale\n\n03:0${i % 10}\n`).join('\n');
  const got = playlistFromMarkdown(md, REF);
  assert.equal(got.playlist.tracks.length, SPOTIFY_MAX_TRACKS);
  assert.equal(got.found, 1000);
  assert.equal(got.rawCount, 1000);
  assert.deepEqual(got.playlist.tracks[SPOTIFY_MAX_TRACKS - 1], { id: `spotify:md:${SPOTIFY_MAX_TRACKS - 1}`, title: `Song ${SPOTIFY_MAX_TRACKS - 1}`, artist: 'Mara Vale', explicit: false, durationMs: 189000 });
});

test('parsers: two megabytes of anything are read in a blink (nothing here can stall the page)', () => {
  // In a child process with a kill timer. The patterns these parsers used to be took 8 s for
  // 400 kB of unclosed tags and half a minute for 60 kB of unclosed tags carrying the id, and a
  // pattern that is busy cannot be interrupted from its own thread.
  const spotifyUrl = new URL('../js/sources/spotify.js', import.meta.url).href;
  const code = `
    import { nextDataFromHtml, playlistFromMarkdown, playlistFromEntity } from ${JSON.stringify(spotifyUrl)};
    const REF = { type: 'playlist', id: ${JSON.stringify(PID)} };
    const open = ['<', 'script'].join('');
    const close = ['</', 'script>'].join('');
    const SIZE = 2 * 1024 * 1024;
    const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length));
    const space = ' '.repeat(SIZE);
    const block = (n) => open + ' id="__NEXT_DATA__">{"n":' + n + '}' + close;
    const out = [];
    const t0 = performance.now();
    out.push(nextDataFromHtml(fill(open + ' ')));
    out.push(nextDataFromHtml(fill(open + ' x id="__NEXT_DATA__" ')));
    out.push(nextDataFromHtml(fill(open + ' id="__NEXT_DATA__">')));
    out.push(nextDataFromHtml(fill(open + ' id="__NEXT_DATA__">' + close.slice(0, -1))));
    out.push(nextDataFromHtml(fill(open + '>') + block(1)));
    out.push(nextDataFromHtml(fill(open + ' x') + '>' + block(2)));
    out.push(nextDataFromHtml(fill('<') + block(3)));
    out.push(playlistFromMarkdown('Title: x' + space + 'y\\n1. ### First Light\\n', REF).kind);
    out.push(playlistFromMarkdown('1. ### a' + space + 'b\\n', REF).kind);
    out.push(playlistFromMarkdown('1. ### a' + space + 'b' + String.fromCharCode(0x2028) + 'c\\n', REF).kind);
    out.push(playlistFromMarkdown(fill('1. ' + ' '.repeat(390) + '##\\n'), REF).kind);
    out.push(playlistFromMarkdown(fill('#' + ' '.repeat(397) + 'x\\n'), REF).kind);
    out.push(playlistFromMarkdown(fill('1.' + '#'.repeat(397) + '\\n'), REF).kind);
    out.push(playlistFromMarkdown(fill('Title:' + ' - Spotify'.repeat(39) + ' \\n'), REF).kind);
    out.push(playlistFromMarkdown(fill('1. ### a\\n'), REF).playlist.tracks.length);
    out.push(playlistFromMarkdown('\\n'.repeat(SIZE) + '1. ### too far down to be a playlist\\n', REF).kind);
    const rows = Array.from({ length: 40000 }, (_, i) => ({ uri: 'spotify:track:' + String(i).padStart(22, 'a'), title: 'Song ' + i, subtitle: space.slice(0, 20) + 'x' }));
    rows.push({ uri: 'spotify:track:' + 'b'.repeat(22), title: space + 'x' + space, subtitle: fill('a,') });
    out.push(playlistFromEntity({ trackList: rows, title: space }, REF).playlist.tracks.length);
    console.log(JSON.stringify({ ms: performance.now() - t0, out }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 30000, encoding: 'utf8' });
  assert.equal(run.error, undefined, `did not finish: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, run.stderr);
  const { ms, out } = JSON.parse(run.stdout);
  assert.deepEqual(out, [null, null, null, null, { n: 1 }, { n: 2 }, { n: 3 }, 'playlist', 'playlist', 'playlist', 'bad', 'bad', 'bad', 'bad', SPOTIFY_MAX_TRACKS, 'bad', SPOTIFY_MAX_TRACKS]);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
});

/* ---------- the chain ---------- */

test('loadSpotify: relay 1 answers → one request, playlist returned, status reported', async () => {
  const { fetchImpl, calls } = fakeFetch({ scraper: () => ok(scraperBody(nextData())) });
  const status = [];
  const pl = await loadSpotify(REF, { fetchImpl, onStatus: (m) => status.push(m), ...fast });
  assert.deepEqual(calls, ['scraper']);
  assert.equal(pl.tracks.length, 3);
  assert.equal(pl.total, undefined);
  assert.deepEqual(status, ['Reading playlist from Spotify…']);
  assert.doesNotMatch(JSON.stringify(pl), /audioPreview|p\.scdn\.co/);
});

test('loadSpotify: falls through the relays in order 1 → 2 → 3 → markdown', async () => {
  // relay 1 down → relay 2
  let f = fakeFetch({ scraper: () => ok('upstream error', 502), jina: () => ok(jinaHtmlBody(nextData())) });
  let pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
  assert.deepEqual(f.calls, ['scraper', 'jina']);
  assert.equal(pl.tracks.length, 3);

  // relays 1 + 2 down → relay 3
  f = fakeFetch({ scraper: () => ok('{"error":"blocked"}'), microlink: () => ok(microlinkBody(nextData())) });
  pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
  assert.deepEqual(f.calls, ['scraper', 'jina', 'microlink']);
  assert.equal(pl.tracks[0].id, `spotify:track:${T1}`);

  // all three down → markdown (ids are synthetic, cover + title come from oEmbed)
  f = fakeFetch({
    markdown: () => ok(MARKDOWN),
    oembed: () => ok(JSON.stringify({ title: 'Today’s Top Hits', thumbnail_url: 'https://i.scdn.co/image/cover' })),
  });
  const status = [];
  pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, onStatus: (m) => status.push(m), ...fast });
  assert.deepEqual(f.calls, ['scraper', 'jina', 'microlink', 'markdown', 'oembed']);
  assert.equal(pl.tracks.length, 4);
  assert.equal(pl.tracks[0].id, 'spotify:md:0');
  assert.equal(pl.artwork, 'https://i.scdn.co/image/cover');
  assert.ok(status.length >= 3, 'tells the user it is trying other routes');
});

test('loadSpotify: everything down → "unreachable", with per-relay detail for the log', async () => {
  const f = fakeFetch({});
  await assert.rejects(loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'unreachable');
    assert.match(err.message, /Couldn't reach Spotify/);
    assert.match(err.detail, /scraper: network.*jina: network.*microlink: network.*jina-markdown: network/);
    return true;
  });
  assert.deepEqual(f.calls, ['scraper', 'jina', 'microlink', 'markdown']);
});

test('loadSpotify: a Spotify 404 page → friendly "private or doesn\'t exist", fast, no more relays', async () => {
  const f = fakeFetch({ scraper: () => ok(scraperBody(notFoundData())) }); // oEmbed unreachable = not vouched for
  const t0 = Date.now();
  await assert.rejects(loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'not-found');
    assert.match(err.message, /private or doesn't exist/);
    return true;
  });
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(f.calls, ['scraper', 'oembed']);
});

test('loadSpotify: a relay claiming 404 is overruled when Spotify itself says the playlist exists', async () => {
  const f = fakeFetch({
    scraper: () => ok(scraperBody(notFoundData())),
    oembed: () => ok(JSON.stringify({ title: 'Today’s Top Hits' })),
    jina: () => ok(jinaHtmlBody(nextData())),
  });
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
  assert.equal(pl.tracks.length, 3);
  assert.deepEqual(f.calls, ['scraper', 'oembed', 'jina']);
});

test('loadSpotify: an empty playlist is its own error', async () => {
  const f = fakeFetch({ scraper: () => ok(scraperBody(nextData(entity({ trackList: [] })))) });
  await assert.rejects(loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast }), (err) => err instanceof SourceError && err.code === 'empty' && /no songs/.test(err.message));
});

test('loadSpotify: a relay answering for a different playlist is not trusted', async () => {
  const other = entity({ id: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const f = fakeFetch({ scraper: () => ok(scraperBody(nextData(other))), jina: () => ok(jinaHtmlBody(nextData())) });
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
  assert.deepEqual(f.calls, ['scraper', 'jina']);
  assert.equal(pl.id, `spotify:playlist:${PID}`);
});

test('loadSpotify: a silent relay is hedged — the next one starts and wins, the slow one is cancelled', async () => {
  let scraperAborted = false;
  const f = fakeFetch({
    scraper: (_url, init) => {
      init.signal.addEventListener('abort', () => (scraperAborted = true));
      return never(init);
    },
    jina: () => ok(jinaHtmlBody(nextData())),
  });
  const t0 = Date.now();
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, hedgeMs: 30, timeoutMs: 5000 });
  const took = Date.now() - t0;
  assert.equal(pl.tracks.length, 3);
  assert.deepEqual(f.calls, ['scraper', 'jina']);
  assert.ok(took >= 25 && took < 1000, `took ${took}ms`);
  assert.equal(scraperAborted, true);
});

test('loadSpotify: each attempt has its own timeout', async () => {
  const f = fakeFetch({ scraper: (_u, init) => never(init), jina: (_u, init) => never(init), microlink: () => ok(microlinkBody(nextData())) });
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, hedgeMs: 10000, timeoutMs: 40 });
  assert.equal(pl.tracks.length, 3);
  assert.deepEqual(f.calls, ['scraper', 'jina', 'microlink']);
});

test('loadSpotify: AbortSignal cancels the in-flight requests and rejects with AbortError', async () => {
  let aborted = 0;
  const hang = (_u, init) => {
    init.signal.addEventListener('abort', () => aborted++);
    return never(init);
  };
  const f = fakeFetch({ scraper: hang, jina: hang, microlink: hang, markdown: hang });
  const ctrl = new AbortController();
  const p = loadSpotify(REF, { fetchImpl: f.fetchImpl, signal: ctrl.signal, hedgeMs: 10, timeoutMs: 5000 });
  setTimeout(() => ctrl.abort(), 35);
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.ok(aborted >= 2, `aborted ${aborted} requests`);
  const before = f.calls.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.calls.length, before, 'nothing new starts after abort');
});

test('loadSpotify: a capped playlist (100 rows) gets its real total', async () => {
  const many = Array.from({ length: SPOTIFY_EMBED_CAP }, (_, i) => track(String(i).padStart(22, 'a'), `Song ${i}`, 'Artist', 200000 + i));
  const body = scraperBody(nextData(entity({ trackList: many })));
  let f = fakeFetch({ scraper: () => ok(body), count: () => ok(JSON.stringify({ result: '2000' })) });
  let pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
  assert.equal(pl.tracks.length, 100);
  assert.equal(pl.total, 2000);
  assert.deepEqual(f.calls, ['scraper', 'count']);

  // the count is best-effort: failing to get it must not fail the load
  for (const count of [undefined, () => ok('nope', 500), () => ok(JSON.stringify({ result: 'abc' })), () => ok(JSON.stringify({ result: '100' }))]) {
    f = fakeFetch({ scraper: () => ok(body), ...(count ? { count } : {}) });
    pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast });
    assert.equal(pl.tracks.length, 100);
    assert.equal(pl.total, undefined);
  }
});

test('loadSpotify: rejects ids that are not Spotify ids before touching the network', async () => {
  const f = fakeFetch({});
  for (const ref of [{ type: 'playlist', id: '../etc/passwd' }, { type: 'track', id: PID }, { type: 'playlist', id: '' }, null]) {
    await assert.rejects(loadSpotify(/** @type {any} */ (ref), { fetchImpl: f.fetchImpl }), (err) => err instanceof SourceError && err.code === 'unsupported');
  }
  assert.equal(f.calls.length, 0);
});

/**
 * A 200 answer that never ends: 64 kB per read for as long as anyone keeps reading. (Not quite
 * never: a reader that has swallowed 48 MB is not going to stop, so the stream fails there rather
 * than let a broken limit eat the machine's memory.)
 */
function endless(headers = {}) {
  const seen = { served: 0, cancelled: false };
  const respond = () =>
    new Response(
      new ReadableStream({
        pull(c) {
          if (seen.served >= 48 * 1024 * 1024) return c.error(new Error('nobody stopped reading'));
          seen.served += 65536;
          c.enqueue(new Uint8Array(65536).fill(120));
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
      { status: 200, headers },
    );
  return { respond, seen };
}

test('loadSpotify: an answer far too big to be a playlist is dropped unread and the next relay is asked', async () => {
  const flood = endless();
  let f = fakeFetch({ scraper: flood.respond, jina: () => ok(jinaHtmlBody(nextData())) });
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 });
  assert.deepEqual(f.calls, ['scraper', 'jina']);
  assert.equal(pl.tracks.length, 3);
  assert.equal(flood.seen.cancelled, true, 'the oversized answer was let go');
  assert.ok(flood.seen.served < 4 * 1024 * 1024, `gave up after ${flood.seen.served} bytes`);

  // Announced up front: refused before the first byte.
  const announced = endless({ 'content-length': String(50 * 1024 * 1024) });
  f = fakeFetch({ scraper: announced.respond, jina: () => ok(jinaHtmlBody(nextData())) });
  await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 });
  assert.equal(announced.seen.cancelled, true);
  assert.ok(announced.seen.served <= 2 * 65536, `read ${announced.seen.served} bytes`);

  // Every route answering like that is "unreachable", with the reason in the log detail — not a frozen page.
  const all = endless();
  f = fakeFetch({ scraper: all.respond, jina: all.respond, microlink: all.respond, markdown: all.respond });
  await assert.rejects(loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 }), (err) => {
    assert.ok(err instanceof SourceError);
    assert.equal(err.code, 'unreachable');
    assert.match(err.detail, /scraper: too-large.*jina: too-large.*microlink: too-large.*jina-markdown: too-large/);
    return true;
  });

  // A real answer with a megabyte of something extra in it still loads.
  f = fakeFetch({ scraper: () => ok(scraperBody(nextData(entity({ extra: 'x'.repeat(1024 * 1024) })))) });
  assert.equal((await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 })).tracks.length, 3);
});

test('loadSpotify: thousands of rows in one answer → the first SPOTIFY_MAX_TRACKS, and the count that was claimed', async () => {
  const body = scraperBody(nextData(entity({ trackList: Array.from({ length: 5000 }, (_, i) => lean(i)) })));
  for (const [count, total] of [
    [undefined, 5000], // the real count cannot be had: say what the answer held
    [() => ok(JSON.stringify({ result: '9000' })), 9000],
    [() => ok(JSON.stringify({ result: '300' })), 5000],
  ]) {
    const f = fakeFetch({ scraper: () => ok(body), ...(count ? { count } : {}) });
    const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 });
    assert.equal(pl.tracks.length, SPOTIFY_MAX_TRACKS);
    assert.equal(pl.tracks[SPOTIFY_MAX_TRACKS - 1].title, `Song ${SPOTIFY_MAX_TRACKS - 1}`);
    assert.equal(pl.total, total);
  }
  // Same through the markdown route.
  const md = Array.from({ length: 700 }, (_, i) => `${i + 1}. ### Song ${i}\n#### Mara Vale\n03:00\n`).join('\n');
  const f = fakeFetch({ markdown: () => ok(md) });
  const pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 });
  assert.equal(pl.tracks.length, SPOTIFY_MAX_TRACKS);
  assert.equal(pl.total, 700);
});

test('loadSpotify: oversized side answers (song count, oEmbed) count as no answer', async () => {
  const many = Array.from({ length: SPOTIFY_EMBED_CAP }, (_, i) => lean(i));
  const flood = endless();
  let f = fakeFetch({ scraper: () => ok(scraperBody(nextData(entity({ trackList: many })))), count: flood.respond });
  let pl = await loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 });
  assert.equal(pl.tracks.length, 100);
  assert.equal(pl.total, undefined);
  assert.equal(flood.seen.cancelled, true);
  assert.ok(flood.seen.served < 1024 * 1024, `gave up on the count after ${flood.seen.served} bytes`);

  // A relay showing the 404 page, and an oEmbed that floods instead of vouching: believed as "not found".
  const flood2 = endless();
  f = fakeFetch({ scraper: () => ok(scraperBody(notFoundData())), oembed: flood2.respond });
  await assert.rejects(loadSpotify(REF, { fetchImpl: f.fetchImpl, ...fast, timeoutMs: 5000 }), (err) => err instanceof SourceError && err.code === 'not-found');
  assert.equal(flood2.seen.cancelled, true);
});

test('hedgedChain: order, hedging and failure collection', async () => {
  const log = [];
  const attempt = (name, ms, kind) => async (signal) => {
    log.push(`start ${name}`);
    await new Promise((res, rej) => {
      const id = setTimeout(res, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(id);
        rej(new DOMException('x', 'AbortError'));
      });
    });
    log.push(`end ${name}`);
    return { kind, name };
  };
  // sequential when attempts fail quickly
  let out = await hedgedChain([attempt('a', 5, 'fail'), attempt('b', 5, 'fail'), attempt('c', 5, 'ok')], { hedgeMs: 1000 });
  assert.equal(out.result.name, 'c');
  assert.equal(out.failures.length, 2);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);

  // hedged: a is slow, b starts alongside and wins; a is aborted and never "ends"
  log.length = 0;
  out = await hedgedChain([attempt('a', 300, 'ok'), attempt('b', 5, 'ok')], { hedgeMs: 20 });
  assert.equal(out.result.name, 'b');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ['start a', 'start b', 'end b']);

  // a slow first attempt can still win if it finishes before the hedge does
  log.length = 0;
  out = await hedgedChain([attempt('a', 40, 'ok'), attempt('b', 200, 'ok')], { hedgeMs: 15 });
  assert.equal(out.result.name, 'a');

  // all fail
  out = await hedgedChain([attempt('a', 1, 'fail'), attempt('b', 1, 'fail')], { hedgeMs: 5 });
  assert.equal(out.result, null);
  assert.equal(out.failures.length, 2);

  // throwing attempts count as failures
  out = await hedgedChain([async () => { throw new Error('boom'); }, attempt('b', 1, 'ok')], {});
  assert.equal(out.result.name, 'b');
  assert.match(out.failures[0].reason, /boom/);
});

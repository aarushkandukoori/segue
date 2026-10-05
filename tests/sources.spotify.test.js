import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAYS,
  SPOTIFY_EMBED_CAP,
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

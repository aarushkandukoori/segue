// Deezer loaders against a fake transport (the browser uses JSONP, Node tests use plain objects).
// All names are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART_GENRES, DEEZER_MAX_TRACKS, createDeezer, loadDeezer, mapDeezerTrack } from '../js/sources/deezer.js';
import { createLimiter } from '../js/sources/limiter.js';
import { loadPlaylist } from '../js/sources/index.js';
import { SourceError } from '../js/sources/util.js';

const preview = (id) => `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/${id}.mp3?hdnea=exp=1999999999~acl=/api/1/1/a/b/c/0/${id}.mp3*~data=user_id=0~hmac=abcdef`;
const dzTrack = (id, over = {}) => ({
  id,
  readable: true,
  title: `Song ${id}`,
  title_short: `Song ${id}`,
  link: `https://www.deezer.com/track/${id}`,
  duration: 180 + (id % 60),
  rank: 500000,
  explicit_lyrics: false,
  preview: preview(id),
  artist: { id: 9, name: 'Mara Vale' },
  album: { id: 7, title: 'Harbor Lights', cover_medium: `https://cdn-images.dzcdn.net/images/cover/x${id}/250x250-000000-80-0-0.jpg`, cover_big: `https://cdn-images.dzcdn.net/images/cover/x${id}/500x500-000000-80-0-0.jpg` },
  type: 'track',
  ...over,
});
const range = (from, to, over) => Array.from({ length: to - from }, (_, i) => dzTrack(from + i + 1, typeof over === 'function' ? over(from + i + 1) : over));

/** Transport that serves from a route table and records every URL asked for. */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (url, opts = {}) => {
    calls.push(url);
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.deezer.com');
    for (const [pattern, handler] of routes) {
      const m = pattern.exec(u.pathname);
      if (m) return handler(u, m, calls.length);
    }
    return { error: { type: 'DataException', message: 'no data', code: 800 } };
  };
  return { transport, calls };
}
const instant = () => createLimiter({ max: 1000, windowMs: 1000 });
const client = (routes) => {
  const ft = fakeTransport(routes);
  return { ...ft, dz: createDeezer({ transport: ft.transport, limiter: instant() }) };
};
/** Paged list endpoint over `all`, shaped like Deezer's (data, total, next). */
const paged = (all) => (u) => {
  const index = Number(u.searchParams.get('index') || 0);
  const limit = Number(u.searchParams.get('limit') || 25);
  const data = all.slice(index, index + limit);
  const out = { data, total: all.length };
  if (index + limit < all.length) out.next = `https://api.deezer.com${u.pathname}?index=${index + limit}`;
  return out;
};
const coded = (code) => (err) => err instanceof SourceError && err.code === code;

test('mapDeezerTrack: TrackMeta contract, preview attached, https only', () => {
  assert.deepEqual(mapDeezerTrack(dzTrack(42, { title: 'Paper Lanterns (Radio Edit)', explicit_lyrics: true, duration: 201 })), {
    id: 'deezer:42',
    title: 'Paper Lanterns (Radio Edit)',
    artist: 'Mara Vale',
    link: 'https://www.deezer.com/track/42',
    preview: { url: preview(42), provider: 'deezer', id: '42' },
    durationMs: 201000,
    explicit: true,
    artwork: 'https://cdn-images.dzcdn.net/images/cover/x42/250x250-000000-80-0-0.jpg',
  });
  // Tracks that cannot be played are skipped, not passed on half-broken.
  assert.equal(mapDeezerTrack(dzTrack(1, { readable: false })), null, 'readable=false');
  assert.equal(mapDeezerTrack(dzTrack(1, { preview: '' })), null, 'empty preview');
  assert.equal(mapDeezerTrack(dzTrack(1, { preview: null })), null);
  assert.equal(mapDeezerTrack(dzTrack(1, { preview: 'http://cdnt-preview.dzcdn.net/x.mp3' })), null, 'http preview');
  assert.equal(mapDeezerTrack(dzTrack(1, { preview: ['java', 'script:void 0'].join('') })), null);
  assert.equal(mapDeezerTrack(dzTrack(1, { title: '', title_short: '' })), null);
  assert.equal(mapDeezerTrack(dzTrack('12abc')), null, 'ids are digits only');
  assert.equal(mapDeezerTrack(dzTrack(0)), null);
  for (const junk of [null, undefined, 'x', 7, []]) assert.equal(mapDeezerTrack(junk), null);
  // Album track lists carry no album object: the album cover is passed in.
  const bare = mapDeezerTrack(dzTrack(5, { album: undefined }), { artwork: 'https://cdn-images.dzcdn.net/images/cover/album/250x250.jpg' });
  assert.equal(bare.artwork, 'https://cdn-images.dzcdn.net/images/cover/album/250x250.jpg');
  assert.equal(mapDeezerTrack(dzTrack(5, { album: undefined })).artwork, undefined);
  assert.equal(mapDeezerTrack(dzTrack(5, { artist: undefined })).artist, 'Unknown artist');
  // The link is rebuilt from the id, never copied from the payload.
  assert.equal(mapDeezerTrack(dzTrack(5, { link: 'https://example.com/elsewhere' })).link, 'https://www.deezer.com/track/5');
});

test('playlist: one request when everything is inline; Playlist contract', async () => {
  const tracks = range(0, 30);
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 555, title: 'Harbor Nights', nb_tracks: 30, creator: { name: 'Juno' }, picture_medium: 'https://cdn-images.dzcdn.net/images/playlist/p/250x250.jpg', picture_big: 'https://cdn-images.dzcdn.net/images/playlist/p/500x500.jpg', tracks: { data: tracks } })],
  ]);
  const p = await dz.loadPlaylist('555');
  assert.deepEqual(calls, ['https://api.deezer.com/playlist/555']);
  assert.deepEqual(
    { ...p, tracks: p.tracks.length },
    { id: 'deezer:playlist:555', source: 'deezer', title: 'Harbor Nights', subtitle: 'Juno', link: 'https://www.deezer.com/playlist/555', artwork: 'https://cdn-images.dzcdn.net/images/playlist/p/500x500.jpg', tracks: 30 },
  );
  assert.equal(p.total, undefined, 'total only when the source has more than we return');
  assert.equal(p.tracks[0].id, 'deezer:1');
  assert.equal(p.tracks[0].preview.provider, 'deezer');
});

test('playlist: follows the paged track list until 200 playable tracks, then stops', async () => {
  const all = range(0, 460);
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 777, title: 'Long One', nb_tracks: 460, tracks: { data: all.slice(0, 25) } })],
    [/^\/playlist\/(\d+)\/tracks$/, paged(all)],
  ]);
  const p = await dz.loadPlaylist('777');
  assert.equal(DEEZER_MAX_TRACKS, 200);
  assert.equal(p.tracks.length, 200);
  assert.equal(p.total, 460);
  assert.deepEqual(p.tracks.map((t) => t.id).slice(0, 3), ['deezer:1', 'deezer:2', 'deezer:3']);
  assert.equal(p.tracks[199].id, 'deezer:200');
  assert.equal(new Set(p.tracks.map((t) => t.id)).size, 200);
  assert.deepEqual(calls, ['https://api.deezer.com/playlist/777', 'https://api.deezer.com/playlist/777/tracks?index=25&limit=100', 'https://api.deezer.com/playlist/777/tracks?index=125&limit=100']);
});

test('playlist: unplayable and duplicate tracks are skipped and do not count toward the cap', async () => {
  const all = range(0, 150, (id) => (id % 3 === 0 ? { readable: false } : id % 10 === 1 ? { preview: '' } : {}));
  all.push(dzTrack(2), dzTrack(4)); // repeats
  const playable = new Set(all.filter((t) => t.readable !== false && t.preview).map((t) => t.id));
  const { dz } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 3, title: 'Patchy', nb_tracks: all.length, tracks: { data: all.slice(0, 100) } })],
    [/^\/playlist\/(\d+)\/tracks$/, paged(all)],
  ]);
  const p = await dz.loadPlaylist('3');
  assert.equal(p.tracks.length, playable.size);
  assert.ok(p.tracks.every((t) => t.preview && t.preview.url.startsWith('https://')));
  assert.equal(p.total, all.length, 'total is the count at the source');
});

test('playlist: a server that says "next" forever cannot loop us', async () => {
  let n = 0;
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 4, title: 'Liar', nb_tracks: 100000, tracks: { data: range(0, 10) } })],
    [/^\/playlist\/(\d+)\/tracks$/, (u) => ({ data: n++ < 50 ? [dzTrack(1), dzTrack(2)] : [], total: 100000, next: `${u.origin}${u.pathname}?index=999` })],
  ]);
  const p = await dz.loadPlaylist('4');
  assert.equal(p.tracks.length, 10);
  assert.ok(calls.length <= 10, `${calls.length} requests`);
});

test('playlist: "next" from the network is never followed as a URL', async () => {
  const all = range(0, 60);
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 5, title: 'Redirector', nb_tracks: 60, tracks: { data: all.slice(0, 25) } })],
    [/^\/playlist\/(\d+)\/tracks$/, (u) => ({ ...paged(all)(u), next: 'https://example.com/elsewhere?index=25' })],
  ]);
  const p = await dz.loadPlaylist('5');
  assert.equal(p.tracks.length, 60);
  assert.ok(calls.every((c) => c.startsWith('https://api.deezer.com/playlist/5')), calls.join('\n'));
});

test('album: tracks get the album cover; paged when the album is long', async () => {
  const bare = (id) => ({ album: undefined });
  const all = range(0, 40, bare);
  const { dz, calls } = client([
    [/^\/album\/(\d+)$/, () => ({ id: 302127, title: 'Harbor Lights', nb_tracks: 40, artist: { name: 'Mara Vale' }, cover_medium: 'https://cdn-images.dzcdn.net/images/cover/al/250x250.jpg', cover_big: 'https://cdn-images.dzcdn.net/images/cover/al/500x500.jpg', tracks: { data: all.slice(0, 25) } })],
    [/^\/album\/(\d+)\/tracks$/, paged(all)],
  ]);
  const p = await dz.loadAlbum('302127');
  assert.equal(p.id, 'deezer:album:302127');
  assert.equal(p.title, 'Harbor Lights');
  assert.equal(p.subtitle, 'Mara Vale');
  assert.equal(p.link, 'https://www.deezer.com/album/302127');
  assert.equal(p.artwork, 'https://cdn-images.dzcdn.net/images/cover/al/500x500.jpg');
  assert.equal(p.tracks.length, 40);
  assert.ok(p.tracks.every((t) => t.artwork === 'https://cdn-images.dzcdn.net/images/cover/al/250x250.jpg'));
  assert.equal(calls.length, 2);
});

test('chart: one request, named after the genre', async () => {
  const { dz, calls } = client([[/^\/chart\/(\d+)\/tracks$/, (u) => ({ data: range(0, Number(u.searchParams.get('limit'))), total: 100 })]]);
  const p = await dz.loadChart('113');
  assert.deepEqual(calls, ['https://api.deezer.com/chart/113/tracks?limit=100']);
  assert.equal(p.id, 'deezer:chart:113');
  assert.equal(p.source, 'deezer');
  assert.match(p.title, /^Dance/);
  assert.equal(p.tracks.length, 100);
  assert.equal(p.artwork, p.tracks[0].artwork);
  assert.match(p.link, /^https:\/\/www\.deezer\.com\//);
  assert.equal(CHART_GENRES[113], 'Dance');
  assert.match((await dz.loadChart('0')).title, /Top 100/);
  assert.equal((await dz.loadChart('9999')).title, 'Deezer chart', 'unknown genre ids still load');
});

test('errors: not found / private, empty, unreachable — all friendly SourceErrors', async () => {
  const none = client([]);
  await assert.rejects(none.dz.loadPlaylist('1'), (e) => coded('not-found')(e) && /private or doesn't exist/.test(e.message));
  await assert.rejects(none.dz.loadAlbum('1'), coded('not-found'));

  const login = client([[/^\/playlist\//, () => ({ error: { type: 'OAuthException', message: 'An active access token must be used', code: 200 } })]]);
  await assert.rejects(login.dz.loadPlaylist('2'), coded('not-found'));

  const noPreviews = client([[/^\/playlist\/(\d+)$/, () => ({ id: 3, title: 'Silent', nb_tracks: 3, tracks: { data: range(0, 3, { preview: '' }) } })]]);
  await assert.rejects(noPreviews.dz.loadPlaylist('3'), (e) => coded('empty')(e) && /no previews/i.test(e.message));

  const down = createDeezer({
    transport: async () => {
      throw new TypeError('Failed to fetch');
    },
    limiter: instant(),
  });
  await assert.rejects(down.loadPlaylist('4'), (e) => coded('unreachable')(e) && /Couldn't reach Deezer/.test(e.message));

  // The browser's JSONP transport fails with its own terse SourceError: the user still gets told what to do.
  const jsonpDown = createDeezer({
    transport: async () => {
      throw new SourceError('unreachable', 'Could not reach Deezer.');
    },
    limiter: instant(),
  });
  await assert.rejects(jsonpDown.loadPlaylist('4'), (e) => coded('unreachable')(e) && /check your connection and try again/.test(e.message));

  const weird = client([[/^\/playlist\//, () => ({ error: { type: 'Exception', message: 'boom', code: 700 } })]]);
  await assert.rejects(weird.dz.loadPlaylist('5'), coded('unreachable'));
  const notJson = createDeezer({ transport: async () => 'nonsense', limiter: instant() });
  await assert.rejects(notJson.loadPlaylist('6'), coded('bad-response'));
});

test('get: one retry after a network blip; quota errors (code 4) wait and retry', async (t) => {
  // Date too: the limiter's pause is measured on the clock, not just by timers.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = async (ms) => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(ms);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  let n = 0;
  const flaky = createDeezer({
    transport: async () => {
      if (n++ === 0) throw new TypeError('Failed to fetch');
      return { id: 1, title: 'Back Again', nb_tracks: 1, tracks: { data: [dzTrack(1)] } };
    },
    limiter: instant(),
  });
  const p1 = flaky.loadPlaylist('1');
  await settle(400);
  assert.equal((await p1).title, 'Back Again');
  assert.equal(n, 2);

  let q = 0;
  const quota = createDeezer({
    transport: async () => (q++ < 2 ? { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } : { data: [dzTrack(7)], total: 1 }),
    limiter: instant(),
  });
  const p2 = quota.search('mara vale paper lanterns');
  await settle(1500);
  await settle(1500);
  await settle(1500);
  const hits = await p2;
  assert.equal(hits.length, 1);
  assert.equal(q, 3);
});

test('search / track: URL shape, raw results, encoding', async () => {
  const { dz, calls } = client([
    [/^\/search$/, (u) => ({ data: [dzTrack(1, { title: u.searchParams.get('q') })], total: 1 })],
    [/^\/track\/(\d+)$/, (u, m) => dzTrack(Number(m[1]), { bpm: 124 })],
  ]);
  const hits = await dz.search('Mara Vale & Juno "Slow Tide" #1', { limit: 15 });
  assert.equal(hits[0].title, 'Mara Vale & Juno "Slow Tide" #1', 'query round-trips through encoding');
  assert.equal(new URL(calls[0]).searchParams.get('limit'), '15');
  assert.equal((await dz.track(99)).bpm, 124);
  assert.equal(calls[1], 'https://api.deezer.com/track/99');
  const none = client([[/^\/search$/, () => ({ data: [], total: 0 })]]);
  assert.deepEqual(await none.dz.search('nothing'), []);
  const odd = client([[/^\/search$/, () => ({ total: 0 })]]);
  assert.deepEqual(await odd.dz.search('nothing'), []);
});

test('abort: an aborted signal rejects with AbortError and stops paging', async () => {
  const all = range(0, 300);
  const ctrl = new AbortController();
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 8, title: 'Long', nb_tracks: 300, tracks: { data: all.slice(0, 25) } })],
    [/^\/playlist\/(\d+)\/tracks$/, (u) => (ctrl.abort(), paged(all)(u))],
  ]);
  await assert.rejects(dz.loadPlaylist('8', { signal: ctrl.signal }), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 2);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(dz.loadChart('113', { signal: pre.signal }), (e) => e.name === 'AbortError');
});

test('loadDeezer / loadPlaylist: routing, status messages, id validation', async () => {
  const { dz, calls } = client([
    [/^\/playlist\/(\d+)$/, () => ({ id: 1, title: 'P', nb_tracks: 1, tracks: { data: [dzTrack(1)] } })],
    [/^\/album\/(\d+)$/, () => ({ id: 2, title: 'A', nb_tracks: 1, tracks: { data: [dzTrack(2)] } })],
    [/^\/chart\/(\d+)\/tracks$/, () => ({ data: [dzTrack(3)], total: 1 })],
  ]);
  const said = [];
  const onStatus = (m) => said.push(m);
  assert.equal((await loadDeezer({ type: 'playlist', id: '1' }, { deezer: dz, onStatus })).id, 'deezer:playlist:1');
  assert.equal((await loadDeezer({ type: 'album', id: '2' }, { deezer: dz, onStatus })).id, 'deezer:album:2');
  assert.equal((await loadDeezer({ type: 'chart', id: '116' }, { deezer: dz, onStatus })).id, 'deezer:chart:116');
  assert.deepEqual(said, ['Reading playlist from Deezer…', 'Reading album from Deezer…', 'Loading the chart from Deezer…']);
  assert.equal(calls.length, 3);
  await assert.rejects(loadDeezer({ type: 'playlist', id: '12/../../x' }, { deezer: dz }), coded('unsupported'));
  assert.equal(calls.length, 3, 'a bad id never reaches the network');

  // Through the public entry point, every accepted spelling lands on the same loader.
  for (const input of ['deezer:chart:116', 'https://www.deezer.com/us/playlist/1', 'https://www.deezer.com/en/album/2']) {
    const p = await loadPlaylist(input, { deezer: dz });
    assert.equal(p.source, 'deezer', input);
  }
});

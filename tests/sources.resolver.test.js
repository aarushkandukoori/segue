// Resolver against fake catalogues and a fake fetch: query order, the dead-"artist:"-filter breaker,
// fallback to iTunes, typed errors, cache, in-flight de-duplication, audio download + link renewal.
// All names are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolveError, createResolver, deezerQueries } from '../js/sources/resolver.js';
import { SourceError } from '../js/sources/util.js';

const preview = (id, exp = 1999999999) => `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/${id}.mp3?hdnea=exp=${exp}~acl=/api/1/1/a/b/c/0/${id}.mp3*~hmac=abcdef`;
const dz = (id, title, artist, seconds, over = {}) => ({
  id,
  readable: true,
  title,
  duration: seconds,
  rank: 500000,
  explicit_lyrics: false,
  preview: preview(id),
  artist: { name: artist },
  album: { cover_medium: `https://cdn-images.dzcdn.net/images/cover/c${id}/250x250.jpg` },
  ...over,
});
const it = (id, title, artist, seconds) => ({
  id: String(id),
  title,
  artist,
  durationMs: seconds * 1000,
  explicit: false,
  preview: `https://audio-ssl.itunes.apple.com/itunes-assets/p${id}.m4a`,
  artwork: `https://is1-ssl.mzstatic.com/image/thumb/a${id}/300x300bb.jpg`,
  link: `https://music.apple.com/us/album/x/1?i=${id}`,
});
const spotify = (n, title, artist, seconds, over = {}) => ({
  id: `spotify:track:${String(n).padStart(22, '0')}`,
  title,
  artist,
  durationMs: seconds * 1000,
  link: `https://open.spotify.com/track/${String(n).padStart(22, '0')}`,
  ...over,
});

/**
 * Fake Deezer client. `answer(query)` returns hits; `artistFilter: 'dead'` makes every artist:"…"
 * query come back empty, the way the real API did on 2026-10-05.
 */
function fakeDeezer(answer, { artistFilter = 'alive', tracks = {} } = {}) {
  const queries = [];
  return {
    queries,
    trackCalls: [],
    async search(q, opts = {}) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      queries.push(q);
      if (artistFilter === 'dead' && /artist:"/.test(q)) return [];
      return answer(q) || [];
    },
    async track(id) {
      this.trackCalls.push(String(id));
      const t = tracks[id];
      if (t instanceof Error) throw t;
      return t || { error: 'none' };
    },
  };
}
function fakeItunes(answer) {
  const terms = [];
  return {
    terms,
    async search(term, opts = {}) {
      terms.push(term);
      const r = answer ? answer(term, opts) : [];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const noItunes = () => fakeItunes(() => []);
const kindOf = (q) => (/^artist:"/.test(q) ? 'precise' : /^track:"/.test(q) ? 'title' : 'free');
const coded = (code) => (err) => err instanceof ResolveError && err.code === code;
const isAbortError = (err) => err && err.name === 'AbortError';

const WANTED = spotify(1, 'Paper Lanterns', 'Mara Vale, Juno Reyes', 201);
const PAGE = [
  dz(11, 'Paper Lanterns (Live at Harbor Hall)', 'Mara Vale', 233),
  dz(12, 'Paper Lanterns', 'Mara Vale', 201, { rank: 900000 }),
  dz(13, 'Paper Lanterns (Dusk Unit Remix)', 'Mara Vale', 201),
  dz(14, 'Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201),
];

/* ------------------------------------------------------------------ queries */

test('deezerQueries: free text first, advanced syntax as a second opinion', () => {
  assert.deepEqual(deezerQueries({ title: 'Paper Lanterns', artist: 'Mara Vale, Juno Reyes' }), [
    { kind: 'loose', q: 'Mara Vale Paper Lanterns' },
    { kind: 'precise', q: 'artist:"Mara Vale" track:"Paper Lanterns"' },
    { kind: 'title', q: 'track:"Paper Lanterns" Mara Vale' },
  ]);
  // Version notes go into the first free-text query only; neutral notes (remaster, feat.) into none.
  assert.deepEqual(
    deezerQueries({ title: 'Paper Lanterns (feat. Juno Reyes) - Dusk Unit Remix', artist: 'Mara Vale' }).map((x) => x.q),
    ['Mara Vale Paper Lanterns Dusk Unit Remix', 'Mara Vale Paper Lanterns', 'artist:"Mara Vale" track:"Paper Lanterns"', 'track:"Paper Lanterns" Mara Vale'],
  );
  assert.deepEqual(deezerQueries({ title: 'Paper Lanterns - 2011 Remaster', artist: 'Mara Vale' })[0], { kind: 'loose', q: 'Mara Vale Paper Lanterns' });
  // Known-dead filter: the precise form is not even built.
  assert.deepEqual(deezerQueries({ title: 'Paper Lanterns', artist: 'Mara Vale' }, { precise: false }).map((x) => x.kind), ['loose', 'title']);
  // No artist (a pasted title).
  assert.deepEqual(deezerQueries({ title: 'Paper Lanterns', artist: '' }).map((x) => x.q), ['Paper Lanterns', 'track:"Paper Lanterns"']);
});

test('deezerQueries: quotes and backslashes cannot break out of the quoted form', () => {
  const dq = String.fromCharCode(34);
  const qs = deezerQueries({ title: `Say ${dq}Hello${dq} \\ Goodbye`, artist: `Mara ${dq}MV${dq} Vale` });
  for (const { q } of qs) {
    const body = q.replace(/(?:artist|track):"[^"]*"/g, '');
    assert.ok(!body.includes(dq) && !q.includes('\\'), q);
  }
  assert.equal(qs.find((x) => x.kind === 'precise').q, 'artist:"Mara MV Vale" track:"Say Hello Goodbye"');
});

/* ------------------------------------------------------------------ resolveTrack */

test('resolveTrack: confident free-text match → one request, AudioRef contract', async () => {
  const deezer = fakeDeezer(() => PAGE);
  const itunes = noItunes();
  const r = createResolver({ deezer, itunes });
  const ref = await r.resolveTrack(WANTED);
  assert.deepEqual(ref, {
    provider: 'deezer',
    key: 'deezer:12',
    url: preview(12),
    isPreview: true,
    matchScore: 1,
    matchedTitle: 'Paper Lanterns',
    matchedArtist: 'Mara Vale',
    artwork: 'https://cdn-images.dzcdn.net/images/cover/c12/250x250.jpg',
    link: 'https://www.deezer.com/track/12',
    matchedDurationMs: 201000,
  });
  assert.deepEqual(deezer.queries, ['Mara Vale Paper Lanterns'], 'no second query, and never the precise form');
  assert.equal(itunes.terms.length, 0);
  assert.deepEqual({ ...r.stats(), cached: undefined }, { deezer: 1, itunes: 0, noMatch: 0, requests: 1, cached: undefined, preciseEnabled: true });
});

test('resolveTrack: falls through free text → advanced → title-only, stopping at the first confident match', async () => {
  // Free text finds only other recordings; the artist:"…" form finds the original.
  const deezer = fakeDeezer((q) => (kindOf(q) === 'precise' ? [PAGE[1]] : [PAGE[0], PAGE[2], PAGE[3]]));
  const r = createResolver({ deezer, itunes: noItunes() });
  const ref = await r.resolveTrack(WANTED);
  assert.equal(ref.key, 'deezer:12');
  assert.deepEqual(deezer.queries.map(kindOf), ['free', 'precise']);

  // Neither finds it; the title-only form does.
  const deezer2 = fakeDeezer((q) => (kindOf(q) === 'title' ? [PAGE[1]] : []));
  const ref2 = await createResolver({ deezer: deezer2, itunes: noItunes() }).resolveTrack(WANTED);
  assert.equal(ref2.key, 'deezer:12');
  assert.deepEqual(deezer2.queries.map(kindOf), ['free', 'precise', 'title']);
});

test('resolveTrack: a dead artist:"…" filter costs at most two requests, then is skipped', async () => {
  // Every track here needs a second query (the free-text hit is 6 s off → accepted but not confident),
  // which is exactly when the advanced form gets asked.
  const answer = (q) => {
    const n = Number(/Song (\d+)/.exec(q)?.[1]);
    return [dz(100 + n, `Song ${n}`, 'Mara Vale', 206)];
  };
  let clock = 1_000_000;
  const deezer = fakeDeezer(answer, { artistFilter: 'dead' });
  const r = createResolver({ deezer, itunes: noItunes(), now: () => clock });
  for (let n = 1; n <= 6; n++) {
    const ref = await r.resolveTrack(spotify(n, `Song ${n}`, 'Mara Vale', 200));
    assert.equal(ref.key, `deezer:${100 + n}`, 'the dead filter never costs a match');
    assert.ok(ref.matchScore >= 0.7 && ref.matchScore < 0.9);
  }
  const precise = deezer.queries.filter((q) => kindOf(q) === 'precise');
  assert.equal(precise.length, 2, `asked the dead form ${precise.length} times`);
  assert.equal(r.stats().preciseEnabled, false);
  assert.deepEqual(deezer.queries.slice(-2).map(kindOf), ['free', 'title']);

  // Ten minutes later it gets another chance (outages end).
  clock += 10 * 60 * 1000 + 1;
  assert.equal(r.stats().preciseEnabled, true);
  await r.resolveTrack(spotify(7, 'Song 7', 'Mara Vale', 200));
  assert.equal(deezer.queries.filter((q) => kindOf(q) === 'precise').length, 3);
});

test('resolveTrack: an empty precise answer for an artist Deezer does not know is not held against the filter', async () => {
  const deezer = fakeDeezer(() => []);
  const r = createResolver({ deezer, itunes: noItunes() });
  for (let n = 1; n <= 5; n++) await assert.rejects(r.resolveTrack(spotify(n, `Obscure ${n}`, 'Nobody Known', 200)), coded('no-match'));
  assert.equal(r.stats().preciseEnabled, true);
  assert.equal(deezer.queries.filter((q) => kindOf(q) === 'precise').length, 5);
});

test('resolveTrack: only wrong versions on Deezer → iTunes fallback', async () => {
  const deezer = fakeDeezer(() => [PAGE[0], PAGE[2], PAGE[3]]);
  const itunes = fakeItunes(() => [it(901, 'Paper Lanterns (Live)', 'Mara Vale', 233), it(902, 'Paper Lanterns', 'Mara Vale', 201)]);
  const r = createResolver({ deezer, itunes });
  const ref = await r.resolveTrack(WANTED);
  assert.deepEqual(ref, {
    provider: 'itunes',
    key: 'itunes:902',
    url: 'https://audio-ssl.itunes.apple.com/itunes-assets/p902.m4a',
    isPreview: true,
    matchScore: 1,
    matchedTitle: 'Paper Lanterns',
    matchedArtist: 'Mara Vale',
    artwork: 'https://is1-ssl.mzstatic.com/image/thumb/a902/300x300bb.jpg',
    link: 'https://music.apple.com/us/album/x/1?i=902',
    matchedDurationMs: 201000,
  });
  assert.deepEqual(itunes.terms, ['Mara Vale Paper Lanterns']);
  assert.equal(r.stats().itunes, 1);
});

test('resolveTrack: nothing acceptable anywhere → ResolveError("no-match"), remembered', async () => {
  const deezer = fakeDeezer(() => [PAGE[0], PAGE[2], PAGE[3], dz(15, 'Glass Harbor', 'Mara Vale', 201), dz(16, 'Paper Lanterns', 'The Hollow Pines', 201)]);
  const itunes = fakeItunes(() => [it(903, 'Paper Lanterns (Karaoke Version)', 'Sing Along Stars', 201)]);
  const r = createResolver({ deezer, itunes });
  const err = await r.resolveTrack(WANTED).catch((e) => e);
  assert.ok(coded('no-match')(err));
  assert.equal(err.final, true);
  assert.match(err.message, /Paper Lanterns/);
  const asked = deezer.queries.length;
  await assert.rejects(r.resolveTrack(WANTED), coded('no-match'));
  assert.equal(deezer.queries.length, asked, 'the miss is cached');
  assert.equal(itunes.terms.length, 1);
  assert.equal(r.stats().noMatch, 1);
});

test('resolveTrack: iTunes skipped (busy / throttled / down) → "no-match" that is NOT final and NOT cached', async () => {
  for (const failure of [new SourceError('busy', 'queue too long'), new SourceError('unreachable', 'rate limited'), new TypeError('Failed to fetch')]) {
    let fail = true;
    const deezer = fakeDeezer(() => []);
    const itunes = fakeItunes(() => (fail ? failure : [it(902, 'Paper Lanterns', 'Mara Vale', 201)]));
    const r = createResolver({ deezer, itunes });
    const err = await r.resolveTrack(WANTED).catch((e) => e);
    assert.ok(coded('no-match')(err));
    assert.equal(err.final, false, 'a retry later might succeed');
    fail = false;
    assert.equal((await r.resolveTrack(WANTED)).key, 'itunes:902', 'second attempt really searches again');
  }
});

test('resolveTrack: iTunes is given a bounded wait so one playlist cannot stall behind the throttle', async () => {
  let seen;
  const itunes = fakeItunes((term, opts) => ((seen = opts), []));
  await assert.rejects(createResolver({ deezer: fakeDeezer(() => []), itunes }).resolveTrack(WANTED), coded('no-match'));
  assert.ok(seen.maxWaitMs > 0 && seen.maxWaitMs <= 60000);
  assert.ok(seen.signal instanceof AbortSignal);
});

test('resolveTrack: catalogues unreachable → ResolveError("network"), not cached; one catalogue down is survivable', async () => {
  let down = true;
  const deezer = {
    queries: [],
    async search(q) {
      this.queries.push(q);
      if (down) throw new SourceError('unreachable', "Couldn't reach Deezer");
      return [PAGE[1]];
    },
  };
  const itunes = fakeItunes(() => (down ? new TypeError('Failed to fetch') : []));
  const r = createResolver({ deezer, itunes });
  const err = await r.resolveTrack(WANTED).catch((e) => e);
  assert.ok(coded('network')(err));
  assert.ok(err.cause instanceof SourceError);
  down = false;
  assert.equal((await r.resolveTrack(WANTED)).key, 'deezer:12');

  // Deezer down, iTunes up → still resolved.
  const r2 = createResolver({
    deezer: { search: async () => { throw new TypeError('Failed to fetch'); } },
    itunes: fakeItunes(() => [it(902, 'Paper Lanterns', 'Mara Vale', 201)]),
  });
  assert.equal((await r2.resolveTrack(WANTED)).provider, 'itunes');
  // Deezer down, iTunes up but empty → no-match that is worth retrying.
  const r3 = createResolver({ deezer: { search: async () => { throw new TypeError('Failed to fetch'); } }, itunes: noItunes() });
  const e3 = await r3.resolveTrack(WANTED).catch((e) => e);
  assert.ok(coded('no-match')(e3));
  assert.equal(e3.final, false);
});

test('resolveTrack: Deezer-sourced tracks resolve instantly from their own preview', async () => {
  const never = { search: () => assert.fail('no search needed'), track: () => assert.fail('no lookup needed') };
  const r = createResolver({ deezer: never, itunes: never });
  const track = { id: 'deezer:42', title: 'Paper Lanterns', artist: 'Mara Vale', durationMs: 201000, link: 'https://www.deezer.com/track/42', artwork: 'https://cdn-images.dzcdn.net/images/cover/x/250x250.jpg', preview: { url: preview(42), provider: 'deezer', id: '42' } };
  assert.deepEqual(await r.resolveTrack(track), {
    provider: 'deezer',
    key: 'deezer:42',
    url: preview(42),
    isPreview: true,
    matchScore: 1,
    matchedTitle: 'Paper Lanterns',
    matchedArtist: 'Mara Vale',
    artwork: 'https://cdn-images.dzcdn.net/images/cover/x/250x250.jpg',
    link: 'https://www.deezer.com/track/42',
  });
  // A preview that is not https is not trusted: the track is searched for like any other.
  const deezer = fakeDeezer(() => [PAGE[1]]);
  const r2 = createResolver({ deezer, itunes: noItunes() });
  const ref = await r2.resolveTrack({ ...track, preview: { url: 'http://cdnt-preview.dzcdn.net/x.mp3', provider: 'deezer', id: '42' } });
  assert.equal(ref.key, 'deezer:12');
  assert.equal(deezer.queries.length, 1);
});

test('resolveTrack: cache and in-flight de-duplication', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const deezer = fakeDeezer(() => PAGE);
  const slow = { ...deezer, search: async (q, o) => (await gate, deezer.search(q, o)) };
  const r = createResolver({ deezer: slow, itunes: noItunes() });
  const a = r.resolveTrack(WANTED);
  const b = r.resolveTrack({ ...WANTED });
  const c = r.resolveTrack(WANTED);
  release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(deezer.queries.length, 1, 'three callers, one search');
  assert.equal(ra, rb);
  assert.equal(rb, rc);
  const again = await r.resolveTrack(WANTED);
  assert.equal(again, ra, 'cached');
  assert.equal(deezer.queries.length, 1);
  // A different track with the same title is its own cache entry.
  await r.resolveTrack(spotify(2, 'Paper Lanterns', 'Mara Vale', 201));
  assert.equal(deezer.queries.length, 2);
});

test('resolveTrack: abort — one waiter leaving does not cancel the others; the last one leaving does', async () => {
  let release;
  let innerSignal;
  const gate = new Promise((r) => (release = r));
  const deezer = {
    n: 0,
    async search(q, opts) {
      this.n++;
      innerSignal = opts.signal;
      await gate;
      if (opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return PAGE;
    },
  };
  const r = createResolver({ deezer, itunes: noItunes() });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = r.resolveTrack(WANTED, { signal: c1.signal });
  const p2 = r.resolveTrack(WANTED, { signal: c2.signal });
  await new Promise((res) => setImmediate(res));
  c1.abort();
  await assert.rejects(p1, isAbortError);
  assert.equal(innerSignal.aborted, false, 'still wanted by the second caller');
  release();
  assert.equal((await p2).key, 'deezer:12');

  // Sole waiter aborts → the underlying search is cancelled and nothing is cached.
  let release2;
  const gate2 = new Promise((res) => (release2 = res));
  let sig2;
  const deezer2 = { n: 0, async search(q, opts) { this.n++; sig2 = opts.signal; await gate2; if (opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return PAGE; } };
  const r2 = createResolver({ deezer: deezer2, itunes: noItunes() });
  const c3 = new AbortController();
  const p3 = r2.resolveTrack(WANTED, { signal: c3.signal });
  await new Promise((res) => setImmediate(res));
  c3.abort();
  await assert.rejects(p3, isAbortError);
  assert.equal(sig2.aborted, true);
  release2();
  await new Promise((res) => setImmediate(res));
  assert.equal((await r2.resolveTrack(WANTED)).key, 'deezer:12', 'a fresh call starts a fresh search');
  assert.equal(deezer2.n, 2);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(r2.resolveTrack(spotify(9, 'X', 'Y', 100), { signal: pre.signal }), isAbortError);
});

test('resolveTrack: pasted lines are tried both ways round before giving up', async () => {
  // The user typed "Title - Artist": the first reading finds nothing, the alt reading does.
  const deezer = fakeDeezer((q) => (q.startsWith('Mara Vale') ? [PAGE[1]] : []));
  const r = createResolver({ deezer, itunes: noItunes() });
  const ref = await r.resolveTrack({ id: 'text:0', title: 'Mara Vale', artist: 'Paper Lanterns', alt: { title: 'Paper Lanterns', artist: 'Mara Vale' } });
  assert.equal(ref.key, 'deezer:12');
  assert.equal(ref.matchScore, 1);
});

test('resolveTrack: "Unknown artist" is treated as no artist, not searched for', async () => {
  const deezer = fakeDeezer(() => [PAGE[1]]);
  const ref = await createResolver({ deezer, itunes: noItunes() }).resolveTrack({ id: 'spotify:md:0', title: 'Paper Lanterns', artist: 'Unknown artist', durationMs: 201000 });
  assert.equal(ref.key, 'deezer:12');
  assert.deepEqual(deezer.queries, ['Paper Lanterns']);
});

test('resolveTrack: bad input is a typed error, never a crash', async () => {
  const r = createResolver({ deezer: fakeDeezer(() => []), itunes: noItunes() });
  for (const bad of [null, undefined, 'x', 42, {}, { id: 'a', title: '' }, { id: 'a', title: '   ' }, { id: 'a', title: 7 }]) {
    await assert.rejects(r.resolveTrack(bad), coded('bad-track'));
  }
});

test('resolveTrack: unusable candidates (no preview, http preview, unreadable) are never returned', async () => {
  const deezer = fakeDeezer(() => [
    dz(21, 'Paper Lanterns', 'Mara Vale', 201, { preview: '' }),
    dz(22, 'Paper Lanterns', 'Mara Vale', 201, { preview: 'http://cdnt-preview.dzcdn.net/x.mp3' }),
    dz(23, 'Paper Lanterns', 'Mara Vale', 201, { readable: false }),
    dz('24x', 'Paper Lanterns', 'Mara Vale', 201),
    null,
    'junk',
  ]);
  await assert.rejects(createResolver({ deezer, itunes: noItunes() }).resolveTrack(WANTED), coded('no-match'));
});

/* ------------------------------------------------------------------ fetchAudio */

const audio = (n = 4096) => new Uint8Array(n).fill(7).buffer;
const res = (status, body = new ArrayBuffer(0)) => ({ status, ok: status >= 200 && status < 300, arrayBuffer: async () => body, text: async () => '' });
const refOf = (over = {}) => ({ provider: 'deezer', key: 'deezer:12', url: preview(12), isPreview: true, matchScore: 1, matchedTitle: 'Paper Lanterns', matchedArtist: 'Mara Vale', ...over });

test('fetchAudio: returns the bytes; request is credential-free', async () => {
  const seen = [];
  const r = createResolver({
    deezer: fakeDeezer(() => []),
    itunes: noItunes(),
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return res(200, audio());
    },
  });
  const buf = await r.fetchAudio(refOf());
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 4096);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], preview(12));
  assert.equal(seen[0][1].credentials, 'omit');
  assert.ok(seen[0][1].signal instanceof AbortSignal);
});

test('fetchAudio: 403 / 410 on a Deezer link → fresh link once, retry, ref updated in place', async () => {
  for (const status of [403, 410]) {
    const fresh = preview(12, 2099999999);
    const deezer = fakeDeezer(() => [], { tracks: { 12: { id: 12, preview: fresh, bpm: 124 } } });
    const urls = [];
    const r = createResolver({
      deezer,
      itunes: noItunes(),
      fetchImpl: async (url) => {
        urls.push(url);
        return url === fresh ? res(200, audio()) : res(status);
      },
    });
    const ref = refOf();
    const buf = await r.fetchAudio(ref);
    assert.equal(buf.byteLength, 4096);
    assert.deepEqual(urls, [preview(12), fresh], `status ${status}`);
    assert.deepEqual(deezer.trackCalls, ['12']);
    assert.equal(ref.url, fresh, 'holders of the ref see the new link');
    assert.equal(ref.bpmHint, 124);
  }
});

test('fetchAudio: an opaque network failure on a Deezer link is treated like an expired link (browsers hide the 403)', async () => {
  const fresh = preview(12, 2099999999);
  const deezer = fakeDeezer(() => [], { tracks: { 12: { id: 12, preview: fresh, bpm: 0 } } });
  const urls = [];
  const r = createResolver({
    deezer,
    itunes: noItunes(),
    fetchImpl: async (url) => {
      urls.push(url);
      if (url !== fresh) throw new TypeError('Failed to fetch');
      return res(200, audio());
    },
  });
  const ref = refOf();
  assert.equal((await r.fetchAudio(ref)).byteLength, 4096);
  assert.deepEqual(urls, [preview(12), fresh]);
  assert.equal(ref.bpmHint, undefined, 'bpm 0 is not a hint');
});

test('fetchAudio: a link already past its expiry is renewed before the first download', async () => {
  const now = 1_800_000_000_000;
  const stale = preview(12, now / 1000 - 60);
  const fresh = preview(12, now / 1000 + 900);
  const deezer = fakeDeezer(() => [], { tracks: { 12: { id: 12, preview: fresh } } });
  const urls = [];
  const r = createResolver({ deezer, itunes: noItunes(), now: () => now, fetchImpl: async (url) => (urls.push(url), res(200, audio())) });
  await r.fetchAudio(refOf({ url: stale }));
  assert.deepEqual(urls, [fresh], 'the stale link was never requested');
  // A link with time left is used as is.
  const r2 = createResolver({ deezer, itunes: noItunes(), now: () => now, fetchImpl: async (url) => (urls.push(url), res(200, audio())) });
  await r2.fetchAudio(refOf({ url: fresh }));
  assert.equal(deezer.trackCalls.length, 1);
});

test('fetchAudio: renewal happens once — a second 403 is "no-audio"; a vanished preview is "no-audio"', async () => {
  const fresh = preview(12, 2099999999);
  const deezer = fakeDeezer(() => [], { tracks: { 12: { id: 12, preview: fresh } } });
  let calls = 0;
  const r = createResolver({ deezer, itunes: noItunes(), fetchImpl: async () => (calls++, res(403)) });
  await assert.rejects(r.fetchAudio(refOf()), coded('no-audio'));
  assert.equal(calls, 2);
  assert.equal(deezer.trackCalls.length, 1);

  const gone = fakeDeezer(() => [], { tracks: { 12: { id: 12, preview: '' } } });
  await assert.rejects(createResolver({ deezer: gone, itunes: noItunes(), fetchImpl: async () => res(403) }).fetchAudio(refOf()), coded('no-audio'));
  const lookupDown = fakeDeezer(() => [], { tracks: { 12: new SourceError('unreachable', 'down') } });
  await assert.rejects(createResolver({ deezer: lookupDown, itunes: noItunes(), fetchImpl: async () => res(403) }).fetchAudio(refOf()), coded('network'));
});

test('fetchAudio: iTunes links are not renewed — one retry for a dropped connection, then "network"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deezer = fakeDeezer(() => []);
  let calls = 0;
  const r = createResolver({
    deezer,
    itunes: noItunes(),
    fetchImpl: async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    },
  });
  const p = r.fetchAudio(refOf({ provider: 'itunes', key: 'itunes:902', url: 'https://audio-ssl.itunes.apple.com/p902.m4a' })).catch((e) => e);
  for (let i = 0; i < 10; i++) await new Promise((r2) => setImmediate(r2));
  t.mock.timers.tick(300);
  const err = await p;
  assert.ok(coded('network')(err));
  assert.equal(calls, 2);
  assert.equal(deezer.trackCalls.length, 0);

  // Recovers when the retry works.
  let n = 0;
  const r2 = createResolver({ deezer, itunes: noItunes(), fetchImpl: async () => { if (n++ === 0) throw new TypeError('Failed to fetch'); return res(200, audio()); } });
  const p2 = r2.fetchAudio(refOf({ provider: 'itunes', key: 'itunes:902', url: 'https://audio-ssl.itunes.apple.com/p902.m4a' }));
  for (let i = 0; i < 10; i++) await new Promise((r3) => setImmediate(r3));
  t.mock.timers.tick(300);
  assert.equal((await p2).byteLength, 4096);
});

test('fetchAudio: error pages and stubs are not audio', async () => {
  const r = (fetchImpl) => createResolver({ deezer: fakeDeezer(() => []), itunes: noItunes(), fetchImpl });
  const itunesRef = refOf({ provider: 'itunes', key: 'itunes:1', url: 'https://audio-ssl.itunes.apple.com/p.m4a' });
  await assert.rejects(r(async () => res(200, audio(300))).fetchAudio(itunesRef), coded('no-audio'), 'a 300-byte body is an error page');
  await assert.rejects(r(async () => res(500)).fetchAudio(itunesRef), coded('no-audio'));
  await assert.rejects(r(async () => res(404)).fetchAudio(itunesRef), coded('no-audio'));
});

test('fetchAudio: refuses anything that is not https; junk refs are typed errors', async () => {
  const fetchImpl = () => assert.fail('must not fetch');
  const r = createResolver({ deezer: fakeDeezer(() => []), itunes: noItunes(), fetchImpl });
  const itunesRef = (url) => refOf({ provider: 'itunes', key: 'itunes:1', url });
  for (const url of ['http://audio-ssl.itunes.apple.com/p.m4a', ['java', 'script:void 0'].join(''), ['da', 'ta:audio/mpeg;base64,AAAA'].join(''), 'file:///etc/hosts', '//example.com/a.mp3', '', undefined]) {
    await assert.rejects(r.fetchAudio(itunesRef(url)), coded('no-audio'), String(url));
  }
  for (const junk of [null, undefined, 'x', 7]) await assert.rejects(r.fetchAudio(junk), coded('no-audio'));
});

test('fetchAudio: abort and timeout', async (t) => {
  const hang = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const itunesRef = refOf({ provider: 'itunes', key: 'itunes:1', url: 'https://audio-ssl.itunes.apple.com/p.m4a' });
  const r = createResolver({ deezer: fakeDeezer(() => []), itunes: noItunes(), fetchImpl: hang });

  const ctrl = new AbortController();
  const p = r.fetchAudio(itunesRef, { signal: ctrl.signal });
  await new Promise((r2) => setImmediate(r2));
  ctrl.abort();
  await assert.rejects(p, isAbortError);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(r.fetchAudio(itunesRef, { signal: pre.signal }), isAbortError);

  // A download that never finishes is cut off (20 s per try, two tries) and reported as "network".
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = r.fetchAudio(itunesRef).catch((e) => e);
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 10; i++) await new Promise((r2) => setImmediate(r2));
    t.mock.timers.tick(10000);
  }
  for (let i = 0; i < 10; i++) await new Promise((r2) => setImmediate(r2));
  assert.ok(coded('network')(await stuck));
});

/* ------------------------------------------------------------------ cross-script guesses */

// Deezer answers a title it cannot read with the artist's popular songs; one of them has the right
// length to the second. On its own that proves nothing.
const JP = spotify(50, 'よるのひかり', 'Hana Mori', 200.6);
const dzGuess = dz(61, 'Yoru no Hikari', 'Hana Mori', 200);
const dzOthers = [dz(62, 'Asa no Kaze', 'Hana Mori', 231), dz(63, 'Umi', 'Hana Mori', 187)];
const itMs = (id, title, seconds) => ({ ...it(id, title, 'Hana Mori', 0), durationMs: Math.round(seconds * 1000) });

test('resolveTrack: a Deezer cross-script guess is kept when iTunes lands on the same song', async () => {
  const itunes = fakeItunes(() => [itMs(71, 'Yoru no Hikari', 200.61), itMs(72, 'Asa no Kaze', 231.2)]);
  const r = createResolver({ deezer: fakeDeezer(() => [dzGuess, ...dzOthers]), itunes });
  const ref = await r.resolveTrack(JP);
  assert.equal(ref.key, 'deezer:61');
  assert.ok(ref.matchScore >= 0.7 && ref.matchScore < 0.9);
  assert.equal(itunes.terms.length, 1, 'iTunes was asked for a second opinion');
});

test('resolveTrack: iTunes points at a different song → iTunes wins over the Deezer guess', async () => {
  // Deezer's same-length track was a coincidence; iTunes has the real one, exact to the millisecond.
  const itunes = fakeItunes(() => [itMs(73, 'Night Light', 200.6), itMs(74, 'Yoru no Hikari', 199.2)]);
  const r = createResolver({ deezer: fakeDeezer(() => [dzGuess, ...dzOthers]), itunes });
  const ref = await r.resolveTrack(JP);
  assert.equal(ref.key, 'itunes:73');
  assert.equal(ref.matchedTitle, 'Night Light');
});

test('resolveTrack: an unconfirmed Deezer guess is dropped, not played', async () => {
  // iTunes reachable but has nothing with that exact length → no-match, final.
  const none = createResolver({ deezer: fakeDeezer(() => [dzGuess, ...dzOthers]), itunes: fakeItunes(() => [itMs(74, 'Yoru no Hikari', 199.2)]) });
  const e1 = await none.resolveTrack(JP).catch((e) => e);
  assert.ok(coded('no-match')(e1));
  assert.equal(e1.final, true);
  // iTunes busy → no-match, but worth another try later.
  const busy = createResolver({ deezer: fakeDeezer(() => [dzGuess]), itunes: fakeItunes(() => new SourceError('busy', 'queue')) });
  const e2 = await busy.resolveTrack(JP).catch((e) => e);
  assert.ok(coded('no-match')(e2));
  assert.equal(e2.final, false);
  // iTunes switched off entirely → still not played on a guess.
  const off = createResolver({ deezer: fakeDeezer(() => [dzGuess]), itunes: noItunes(), useItunes: false });
  await assert.rejects(off.resolveTrack(JP), coded('no-match'));
});

test('resolveTrack: a real title match on Deezer never needs a second opinion', async () => {
  const itunes = noItunes();
  const r = createResolver({ deezer: fakeDeezer(() => [dz(64, 'よるのひかり', 'Hana Mori', 200), dzGuess]), itunes });
  assert.equal((await r.resolveTrack(JP)).key, 'deezer:64');
  assert.equal(itunes.terms.length, 0);
});

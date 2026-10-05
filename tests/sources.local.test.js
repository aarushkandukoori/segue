// Local files: filename parsing, audio filtering, ordering, the tiny ID3v2 reader. Names are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_MAX_TRACKS, applyTags, isAudioFile, localKey, parseFilename, parseId3v2, playlistFromFiles, readTags } from '../js/sources/local.js';
import { createResolver } from '../js/sources/resolver.js';

const file = (name, { type = '', size = 8, lastModified = 1700000000000, path } = {}) => {
  const f = new File([new Uint8Array(size)], name, { type, lastModified });
  if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};
const TA = (title, artist) => ({ title, artist });

/* ------------------------------------------------------------------ file names */

test('parseFilename: "Artist - Title.ext" and the usual rip / download decorations', () => {
  /** @type {[string, {title: string, artist: string}][]} */
  const table = [
    ['Mara Vale - Paper Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale – Paper Lanterns.aac', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara_Vale_-_Paper_Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['03 - Mara Vale - Paper Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['2 - Mara Vale - Paper Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['03 Paper Lanterns.flac', TA('Paper Lanterns', '')],
    ['12. Paper Lanterns.m4a', TA('Paper Lanterns', '')],
    ['(12) Paper Lanterns.mp3', TA('Paper Lanterns', '')],
    ['1-03 Paper Lanterns.mp3', TA('Paper Lanterns', '')],
    ['A1 - Paper Lanterns.wav', TA('Paper Lanterns', '')],
    ['Mara Vale - Harbor Lights - 07 - Paper Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns - Live at Harbor Hall.ogg', TA('Paper Lanterns - Live at Harbor Hall', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns (Official Video).mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns [320kbps].mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns (feat. Juno Reyes) (Lyric Video).mp3', TA('Paper Lanterns (feat. Juno Reyes)', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns (Dusk Unit Remix).opus', TA('Paper Lanterns (Dusk Unit Remix)', 'Mara Vale')],
    ['paper lanterns.wav', TA('paper lanterns', '')],
    ['track.with.dots.mp3', TA('track.with.dots', '')],
    ['/home/someone/music/Mara Vale - Paper Lanterns.opus', TA('Paper Lanterns', 'Mara Vale')],
    ['C:\\Music\\Mara Vale - Paper Lanterns.mp3', TA('Paper Lanterns', 'Mara Vale')],
    ['ハナ - よるのひかり.m4a', TA('よるのひかり', 'ハナ')],
    ['noext', TA('noext', '')],
  ];
  for (const [name, want] of table) assert.deepEqual(parseFilename(name), want, name);
});

test('parseFilename: a leading number is only a track number when it looks like one', () => {
  assert.deepEqual(parseFilename('99 Balloons.mp3'), TA('99 Balloons', ''));
  assert.deepEqual(parseFilename('311 - Amber Sky.mp3'), TA('Amber Sky', '311'), 'a band can be called 311');
  assert.deepEqual(parseFilename('50 Cent Avenue - In The Club.mp3'), TA('In The Club', '50 Cent Avenue'));
  assert.deepEqual(parseFilename('12 Paper Lanterns.mp3'), TA('12 Paper Lanterns', ''));
  assert.deepEqual(parseFilename('12 Paper Lanterns.mp3', { numbered: true }), TA('Paper Lanterns', ''), 'the caller knows the batch is numbered');
});

test('parseFilename: never throws; junk becomes a title or "Untitled"', () => {
  const lt = String.fromCharCode(60);
  for (const junk of [undefined, null, 42, {}, [], '', '.', '..', '.mp3', '---', ' - ', '/', '\\', 'a'.repeat(5000) + '.mp3', `${lt}img src=x${String.fromCharCode(62)}.mp3`, String.fromCharCode(0, 1, 2) + '.mp3']) {
    const r = parseFilename(junk);
    assert.equal(typeof r.title, 'string');
    assert.ok(r.title.length > 0 && r.title.length <= 301, JSON.stringify(junk));
    assert.equal(typeof r.artist, 'string');
  }
  assert.equal(parseFilename('').title, 'Untitled');
  assert.equal(parseFilename(null).title, 'Untitled');
  const zero = String.fromCharCode(0x200b);
  assert.deepEqual(parseFilename(`Mara${zero} Vale - Paper Lanterns.mp3`), TA('Paper Lanterns', 'Mara Vale'), 'invisible characters are dropped');
});

/* ------------------------------------------------------------------ playlistFromFiles */

test('isAudioFile: by MIME type or by extension', () => {
  for (const ext of ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'MP3', 'Flac']) assert.ok(isAudioFile(file(`a.${ext}`)), ext);
  assert.ok(isAudioFile(file('voice-note', { type: 'audio/webm' })), 'type wins when the name has no extension');
  assert.ok(isAudioFile(file('x.bin', { type: 'AUDIO/MPEG' })));
  for (const name of ['cover.jpg', 'notes.txt', 'playlist.m3u', 'video.mp4', 'archive.zip', 'mp3', '.DS_Store', 'desktop.ini']) assert.ok(!isAudioFile(file(name)), name);
  assert.ok(!isAudioFile(file('movie.mp4', { type: 'video/mp4' })));
  assert.ok(!isAudioFile(null));
  assert.ok(!isAudioFile({}));
});

test('playlistFromFiles: keeps audio, natural order, Playlist contract', () => {
  const files = [
    file('10 - Mara Vale - Tenth.mp3'),
    file('cover.jpg', { type: 'image/jpeg' }),
    file('2 - Mara Vale - Second.mp3'),
    file('1 - Mara Vale - First.mp3'),
    file('notes.txt', { type: 'text/plain' }),
    file('Juno Reyes - Slow Tide.flac'),
  ];
  const p = playlistFromFiles(files);
  assert.equal(p.source, 'local');
  assert.match(p.id, /^local:[a-z0-9]+$/);
  assert.equal(p.title, 'Your files');
  assert.equal(p.subtitle, '4 tracks from this device');
  assert.equal(p.total, undefined);
  assert.deepEqual(
    p.tracks.map((t) => [t.id, t.artist, t.title]),
    [
      ['local:0', 'Mara Vale', 'First'],
      ['local:1', 'Mara Vale', 'Second'],
      ['local:2', 'Mara Vale', 'Tenth'],
      ['local:3', 'Juno Reyes', 'Slow Tide'],
    ],
  );
  for (const t of p.tracks) assert.ok(t.file instanceof File);
  assert.equal(p.tracks[0].file.name, '1 - Mara Vale - First.mp3');
  // Same files in another order → same playlist id.
  assert.equal(playlistFromFiles([...files].reverse()).id, p.id);
});

test('playlistFromFiles: an album rip (every name numbered) loses its numbers; a mixed bag keeps them', () => {
  const rip = playlistFromFiles([file('1 Opening.mp3'), file('2 Paper Lanterns.mp3'), file('3 Slow Tide.mp3'), file('10 Closing.mp3')]);
  assert.deepEqual(rip.tracks.map((t) => t.title), ['Opening', 'Paper Lanterns', 'Slow Tide', 'Closing']);
  const mixed = playlistFromFiles([file('99 Balloons.mp3'), file('Mara Vale - Paper Lanterns.mp3'), file('Juno Reyes - Slow Tide.mp3')]);
  assert.ok(mixed.tracks.some((t) => t.title === '99 Balloons'));
});

test('playlistFromFiles: folders, duplicates, FileList-likes, empty input', () => {
  const a = file('01 First.mp3', { path: 'Harbor Lights/01 First.mp3' });
  const b = file('02 Second.mp3', { path: 'Harbor Lights/02 Second.mp3' });
  const p = playlistFromFiles([b, a, a]);
  assert.equal(p.title, 'Harbor Lights', 'a single dropped folder names the set');
  assert.equal(p.tracks.length, 2, 'the same file twice is one track');
  assert.deepEqual(p.tracks.map((t) => t.title), ['First', 'Second']);

  const two = playlistFromFiles([file('x.mp3', { path: 'A/x.mp3' }), file('y.mp3', { path: 'B/y.mp3' })]);
  assert.equal(two.title, 'Your files');

  const listLike = { 0: file('Mara Vale - Paper Lanterns.mp3'), length: 1 };
  assert.equal(playlistFromFiles(listLike).tracks.length, 1);
  assert.equal(playlistFromFiles([file('Mara Vale - Paper Lanterns.mp3')]).subtitle, '1 track from this device');

  for (const nothing of [[], null, undefined, [file('cover.jpg')]]) {
    const empty = playlistFromFiles(nothing);
    assert.deepEqual(empty.tracks, []);
    assert.equal(empty.source, 'local');
  }
});

test(`playlistFromFiles: capped at ${LOCAL_MAX_TRACKS}, total says how many were dropped`, () => {
  const many = Array.from({ length: LOCAL_MAX_TRACKS + 25 }, (_, i) => file(`Artist - Song ${i}.mp3`, { size: 4, lastModified: i }));
  const p = playlistFromFiles(many);
  assert.equal(p.tracks.length, LOCAL_MAX_TRACKS);
  assert.equal(p.total, LOCAL_MAX_TRACKS + 25);
});

test('localKey + resolver: local tracks resolve instantly and fetchAudio reads the File', async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251);
  const f = new File([bytes], 'Mara Vale - Paper Lanterns.mp3', { type: 'audio/mpeg', lastModified: 1700000000123 });
  assert.equal(localKey(f), 'local:Mara Vale - Paper Lanterns.mp3:4096:1700000000123');
  const [track] = playlistFromFiles([f]).tracks;
  const never = { search: () => assert.fail('no network for local files'), track: () => assert.fail('no network') };
  const resolver = createResolver({ deezer: never, itunes: never, fetchImpl: () => assert.fail('no fetch for local files') });
  const ref = await resolver.resolveTrack(track);
  assert.deepEqual(
    { ...ref, file: undefined },
    { provider: 'local', key: localKey(f), file: undefined, isPreview: false, matchScore: 1, matchedTitle: 'Paper Lanterns', matchedArtist: 'Mara Vale' },
  );
  assert.equal(ref.file, f);
  assert.equal(ref.url, undefined);
  const buf = await resolver.fetchAudio(ref);
  assert.ok(buf instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(buf), bytes);
});

/* ------------------------------------------------------------------ ID3v2 */

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const syncsafe = (n) => [(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127];
const latin1 = (s) => [0, ...ascii(s)];
const utf8 = (s) => [3, ...new TextEncoder().encode(s)];
const utf16 = (s) => {
  const out = [1, 0xff, 0xfe];
  for (const c of s) {
    const code = c.charCodeAt(0);
    out.push(code & 255, code >> 8);
  }
  return out;
};
/** ID3v2.3 / v2.4 tag from [frameId, payloadBytes] pairs. */
function id3(version, frames, { padding = 16 } = {}) {
  const body = [];
  for (const [id, data] of frames) {
    body.push(...ascii(id), ...(version === 4 ? syncsafe(data.length) : be32(data.length)), 0, 0, ...data);
  }
  for (let i = 0; i < padding; i++) body.push(0);
  return new Uint8Array([...ascii('ID3'), version, 0, 0, ...syncsafe(body.length), ...body, 0xff, 0xfb, 0x90, 0x00]);
}
function id3v22(frames) {
  const body = [];
  for (const [id, data] of frames) body.push(...ascii(id), (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...data);
  body.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  return new Uint8Array([...ascii('ID3'), 2, 0, 0, ...syncsafe(body.length), ...body]);
}

test('parseId3v2: TIT2 / TPE1 in v2.3 (Latin-1, UTF-16) and v2.4 (UTF-8)', () => {
  assert.deepEqual(parseId3v2(id3(3, [['TIT2', latin1('Paper Lanterns')], ['TPE1', latin1('Mara Vale')]])), { title: 'Paper Lanterns', artist: 'Mara Vale' });
  assert.deepEqual(parseId3v2(id3(3, [['TALB', latin1('Harbor Lights')], ['TPE1', utf16('Zoé Márquez')], ['TIT2', utf16('Corazón Eléctrico')]])), {
    title: 'Corazón Eléctrico',
    artist: 'Zoé Márquez',
  });
  assert.deepEqual(parseId3v2(id3(4, [['TIT2', utf8('よるのひかり')], ['TPE1', utf8('ハナ')]])), { title: 'よるのひかり', artist: 'ハナ' });
  // v2.4 multi-value: first value wins.
  assert.deepEqual(parseId3v2(id3(4, [['TPE1', utf8('Mara Vale\u0000Juno Reyes')], ['TIT2', utf8('Slow Tide')]])), { title: 'Slow Tide', artist: 'Mara Vale' });
  // v2.2 three-letter frames.
  assert.deepEqual(parseId3v2(id3v22([['TT2', latin1('Paper Lanterns')], ['TP1', latin1('Mara Vale')]])), { title: 'Paper Lanterns', artist: 'Mara Vale' });
  // Only one of the two present.
  assert.deepEqual(parseId3v2(id3(3, [['TIT2', latin1('Paper Lanterns')]])), { title: 'Paper Lanterns' });
  assert.deepEqual(parseId3v2(id3(3, [['TPE1', latin1('Mara Vale')]])), { artist: 'Mara Vale' });
  // A big frame (cover art) in front is skipped.
  assert.deepEqual(parseId3v2(id3(3, [['APIC', Array.from({ length: 3000 }, (_, i) => i & 255)], ['TIT2', latin1('Paper Lanterns')], ['TPE1', latin1('Mara Vale')]])), { title: 'Paper Lanterns', artist: 'Mara Vale' });
});

test('parseId3v2: never throws on junk, truncation or hostile sizes', () => {
  const good = id3(3, [['TIT2', latin1('Paper Lanterns')], ['TPE1', latin1('Mara Vale')]]);
  assert.deepEqual(parseId3v2(new Uint8Array(0)), {});
  assert.deepEqual(parseId3v2(new Uint8Array(64)), {});
  assert.deepEqual(parseId3v2(new Uint8Array(64).fill(255)), {});
  assert.deepEqual(parseId3v2('ID3'), {});
  assert.deepEqual(parseId3v2(null), {});
  assert.deepEqual(parseId3v2(new Uint8Array([...ascii('RIFF'), ...new Array(40).fill(1)])), {}, 'not an ID3 file');
  // Every truncation of a good tag: no throw, never garbage types.
  for (let n = 0; n <= good.length; n++) {
    const r = parseId3v2(good.subarray(0, n));
    for (const v of Object.values(r)) assert.equal(typeof v, 'string');
  }
  // Frame claims to be 2 GB long; header claims a huge tag.
  const lying = id3(3, [['TIT2', latin1('Paper Lanterns')]]);
  lying.set([0x7f, 0xff, 0xff, 0xff], 14);
  assert.deepEqual(parseId3v2(lying), {});
  const hugeHeader = id3(3, [['TIT2', latin1('Paper Lanterns')]]);
  hugeHeader.set([0x7f, 0x7f, 0x7f, 0x7f], 6);
  assert.deepEqual(parseId3v2(hugeHeader), { title: 'Paper Lanterns' }, 'tag size is clamped to the bytes we have');
  // Random noise after a valid header.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  for (let i = 0; i < 300; i++) {
    const noise = new Uint8Array(10 + (rnd() % 200));
    for (let j = 0; j < noise.length; j++) noise[j] = rnd();
    noise.set([...ascii('ID3'), 2 + (i % 3), 0, i % 2 ? 0x40 : 0], 0);
    assert.doesNotThrow(() => parseId3v2(noise));
  }
  // Control characters inside a tag are cleaned, not passed on.
  const ctl = parseId3v2(id3(3, [['TIT2', latin1(`Paper${String.fromCharCode(7)} Lanterns`)]]));
  assert.equal(ctl.title, 'Paper Lanterns');
});

test('readTags / applyTags: tags replace file-name guesses; files without tags keep them', async () => {
  const tagged = new File([id3(3, [['TIT2', latin1('Paper Lanterns')], ['TPE1', latin1('Mara Vale')]])], 'track01.mp3', { type: 'audio/mpeg' });
  const untagged = new File([new Uint8Array(256)], 'Juno Reyes - Slow Tide.mp3', { type: 'audio/mpeg' });
  const artistOnly = new File([id3(4, [['TPE1', utf8('The Hollow Pines')]])], 'Glass Harbor.mp3', { type: 'audio/mpeg' });
  assert.deepEqual(await readTags(tagged), { title: 'Paper Lanterns', artist: 'Mara Vale' });
  assert.deepEqual(await readTags(untagged), {});
  assert.deepEqual(await readTags({ slice: () => { throw new Error('unreadable'); } }), {}, 'never rejects');

  const p = playlistFromFiles([tagged, untagged, artistOnly]);
  const same = await applyTags(p);
  assert.equal(same, p);
  const by = Object.fromEntries(p.tracks.map((t) => [t.file.name, [t.artist, t.title]]));
  assert.deepEqual(by['track01.mp3'], ['Mara Vale', 'Paper Lanterns']);
  assert.deepEqual(by['Juno Reyes - Slow Tide.mp3'], ['Juno Reyes', 'Slow Tide']);
  assert.deepEqual(by['Glass Harbor.mp3'], ['The Hollow Pines', 'Glass Harbor']);
});

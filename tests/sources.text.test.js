// Pasted song lists. Every track / artist name in here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_MAX_TRACKS, parseTextLine, parseTextTracks, playlistFromText } from '../js/sources/text.js';
import { SourceError } from '../js/sources/util.js';

const song = (line) => {
  const s = parseTextLine(line);
  return s ? { title: s.title, artist: s.artist, ...(s.durationMs ? { durationMs: s.durationMs } : {}) } : null;
};
const TA = (title, artist, durationMs) => ({ title, artist, ...(durationMs ? { durationMs } : {}) });
const TAB = String.fromCharCode(9);

test('parseTextLine: the shapes people actually paste', () => {
  /** @type {[string, ReturnType<typeof TA>][]} */
  const table = [
    ['Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale – Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')], // en dash
    ['Mara Vale — Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')], // em dash
    ['Mara Vale—Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')], // em dash, no spaces
    ['  Mara Vale   -   Paper Lanterns  ', TA('Paper Lanterns', 'Mara Vale')],
    ['Paper Lanterns by Mara Vale', TA('Paper Lanterns', 'Mara Vale')],
    ['"Paper Lanterns" by Mara Vale', TA('Paper Lanterns', 'Mara Vale')],
    ['“Paper Lanterns” by Mara Vale', TA('Paper Lanterns', 'Mara Vale')],
    ['1. Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['01) Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['12. Mara Vale – Paper Lanterns (3:45)', TA('Paper Lanterns', 'Mara Vale', 225000)],
    ['#3: Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['[12] Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['- Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['• Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['* Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['7 - Mara Vale - Paper Lanterns', TA('Paper Lanterns', 'Mara Vale')],
    ['Mara Vale - Paper Lanterns 3:45', TA('Paper Lanterns', 'Mara Vale', 225000)],
    ['Mara Vale - Paper Lanterns [03:45]', TA('Paper Lanterns', 'Mara Vale', 225000)],
    ['Mara Vale - Paper Lanterns - 3:45', TA('Paper Lanterns', 'Mara Vale', 225000)],
    ['Mara Vale - Paper Lanterns (1:02:03)', TA('Paper Lanterns', 'Mara Vale', 3723000)],
    ['Mara Vale - Paper Lanterns (Dusk Unit Remix)', TA('Paper Lanterns (Dusk Unit Remix)', 'Mara Vale')],
    ['Mara Vale, Juno Reyes - Slow Tide (feat. Kito)', TA('Slow Tide (feat. Kito)', 'Mara Vale, Juno Reyes')],
    ['Mara-Lou Vale - Paper-Thin Lanterns', TA('Paper-Thin Lanterns', 'Mara-Lou Vale')], // hyphens inside names are not separators
    ['Paper Lanterns', TA('Paper Lanterns', '')],
    ['ハナ - よるのひかり', TA('よるのひかり', 'ハナ')],
    ['Ника — Белая ночь (4:01)', TA('Белая ночь', 'Ника', 241000)],
    [`Mara Vale${TAB}Paper Lanterns`, TA('Paper Lanterns', 'Mara Vale')],
    [`3${TAB}Mara Vale${TAB}Paper Lanterns${TAB}3:45`, TA('Paper Lanterns', 'Mara Vale', 225000)],
    [`Mara Vale${TAB}Paper Lanterns${TAB}Harbor Lights${TAB}3:45`, TA('Paper Lanterns', 'Mara Vale', 225000)],
  ];
  for (const [line, want] of table) assert.deepEqual(song(line), want, JSON.stringify(line));
});

test('parseTextLine: things that are not songs', () => {
  for (const line of ['', '   ', '\t', '---', '***', '1.', '12)', '•', '# My road trip list', '// notes', 'https://example.com/some/page', 'www.example.com', 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', '(3:45)', '…', null, undefined, 42, {}]) {
    assert.equal(parseTextLine(line), null, JSON.stringify(line));
  }
});

test('parseTextLine: a time that is the title stays the title', () => {
  assert.deepEqual(song('Mara Vale - 4:44'), TA('4:44', 'Mara Vale'));
  assert.deepEqual(song('Mara Vale - 4:44 (4:44)'), TA('4:44', 'Mara Vale', 284000));
  assert.deepEqual(song('Mara Vale - 3:45 - 3:45'), TA('3:45', 'Mara Vale', 225000));
});

test('parseTextLine: ambiguous lines carry their other reading for the resolver', () => {
  assert.deepEqual(parseTextLine('Mara Vale - Paper Lanterns').alt, { title: 'Mara Vale', artist: 'Paper Lanterns' });
  // "X by Y" might be one title ("Stand by Me" style): the alt reading is the whole line.
  assert.deepEqual(parseTextLine('Stand by Me').alt, { title: 'Stand by Me', artist: '' });
  assert.equal(parseTextLine('Paper Lanterns').alt, undefined);
});

test('parseTextLine: hostile and oversized input is contained', () => {
  const lt = String.fromCharCode(60);
  const gt = String.fromCharCode(62);
  const tag = `${lt}b${gt}Mara Vale${lt}/b${gt} - Paper Lanterns`;
  // Markup is not interpreted or stripped here — it stays plain text for textContent to render.
  assert.equal(parseTextLine(tag).title, 'Paper Lanterns');
  assert.ok(parseTextLine(tag).artist.includes(lt));

  const long = parseTextLine(`${'A'.repeat(5000)} - ${'B'.repeat(5000)}`);
  assert.ok(long === null || (long.title.length <= 301 && long.artist.length <= 301));

  const zero = String.fromCharCode(0x200b);
  const rlo = String.fromCharCode(0x202e);
  const nul = String.fromCharCode(0);
  assert.deepEqual(song(`Mara${zero} Vale - Paper${rlo} Lanterns${nul}`), TA('Paper Lanterns', 'Mara Vale'));
  const t0 = Date.now();
  parseTextLine(`${'- '.repeat(2000)}x`);
  parseTextLine(`${'1:11 '.repeat(2000)}`);
  parseTextLine('('.repeat(4000));
  assert.ok(Date.now() - t0 < 500, 'no pathological backtracking');
});

test('parseTextTracks: blanks, numbering, duplicates, ids', () => {
  const text = ['My list', '', '1. Mara Vale - Paper Lanterns', '2. Juno Reyes - Slow Tide (3:01)', '', '   ', '3. mara vale - paper lanterns', '4. The Hollow Pines – Glass Harbor', 'https://example.com/x', '# heading'].join('\r\n');
  const { tracks, total } = parseTextTracks(text);
  assert.deepEqual(
    tracks.map((t) => [t.id, t.artist, t.title]),
    [
      ['text:0', '', 'My list'],
      ['text:1', 'Mara Vale', 'Paper Lanterns'],
      ['text:2', 'Juno Reyes', 'Slow Tide'],
      ['text:3', 'The Hollow Pines', 'Glass Harbor'],
    ],
  );
  assert.equal(tracks[2].durationMs, 181000);
  assert.equal(total, 4, 'the repeated song is counted once');
  assert.deepEqual(parseTextTracks(''), { tracks: [], total: 0 });
  assert.deepEqual(parseTextTracks(undefined), { tracks: [], total: 0 });
});

test(`parseTextTracks: capped at ${TEXT_MAX_TRACKS}, total reports what was pasted`, () => {
  const lines = Array.from({ length: 260 }, (_, i) => `Artist ${i} - Song ${i}`).join('\n');
  const { tracks, total } = parseTextTracks(lines);
  assert.equal(TEXT_MAX_TRACKS, 200);
  assert.equal(tracks.length, 200);
  assert.equal(total, 260);
  assert.equal(tracks[199].id, 'text:199');
  const p = playlistFromText(lines);
  assert.equal(p.tracks.length, 200);
  assert.equal(p.total, 260);
});

test('playlistFromText: Playlist contract, stable id, friendly error when empty', () => {
  const text = 'Mara Vale - Paper Lanterns\nJuno Reyes - Slow Tide\n';
  const p = playlistFromText(text);
  assert.equal(p.source, 'text');
  assert.match(p.id, /^text:[a-z0-9]+$/);
  assert.equal(p.title, 'Your list');
  assert.equal(p.subtitle, '2 songs you pasted');
  assert.equal(p.total, undefined);
  assert.equal(p.link, undefined);
  assert.deepEqual(Object.keys(p.tracks[0]).sort(), ['alt', 'artist', 'id', 'title']);
  // Same songs → same id, whatever the numbering / spacing; different songs → different id.
  assert.equal(playlistFromText('1. Mara Vale - Paper Lanterns\r\n\r\n2. Juno Reyes – Slow Tide').id, p.id);
  assert.notEqual(playlistFromText('Mara Vale - Paper Lanterns\nJuno Reyes - Glass Harbor').id, p.id);
  assert.equal(playlistFromText('Mara Vale - Paper Lanterns').subtitle, '1 song you pasted');

  assert.throws(
    () => playlistFromText('\n\n   \n# nothing here\n'),
    (err) => err instanceof SourceError && err.code === 'empty' && /one song per line/i.test(err.message),
  );
  assert.throws(() => playlistFromText(undefined), (err) => err instanceof SourceError && err.code === 'empty');
});

test('parseTextTracks: a megabyte of junk does not hang', () => {
  const t0 = Date.now();
  const junk = Array.from({ length: 30000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const { tracks } = parseTextTracks(junk);
  assert.equal(tracks.length, 200);
  assert.ok(Date.now() - t0 < 1500);
});

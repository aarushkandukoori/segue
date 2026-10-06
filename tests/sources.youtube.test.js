import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  YT_ACCEPT,
  YT_ALTERNATE,
  YT_STORAGE_KEY,
  createYouTubeFinder,
  parseClock,
  parseYouTubeSearch,
  rankVideos,
  readSearchPage,
  scoreVideo,
  scoreVideoDetail,
  youtubeQueries,
} from '../js/sources/youtube.js';
import { createLimiter } from '../js/sources/limiter.js';
import { ResolveError } from '../js/sources/resolver.js';
import { UNKNOWN_ARTIST } from '../js/sources/util.js';

// Every name in this file is invented.

/* ---------- fixtures in the shapes YouTube / the relays really return (SPEC 6.1) ---------- */

let idSeq = 0;
/** An 11-character video id that is unique per call. */
const vid = (stem = 'v') => (stem + String(idSeq++).padStart(10, '0')).slice(-11).replace(/[^A-Za-z0-9_-]/g, 'x');

/** What YouTube's oEmbed says about each fixture video (its real title and channel), filled by vr(). */
const OEMBED = new Map();
const oembedBody = (title, author) => JSON.stringify({ title, author_name: author, author_url: 'https://www.youtube.com/@x', type: 'video', provider_name: 'YouTube', version: '1.0' });

/** One videoRenderer as the search page carries it. */
function vr({ id = vid(), title, channel, length, badge, live = false, extra = {} }) {
  if (!OEMBED.has(id)) OEMBED.set(id, { title, channel });
  const r = {
    videoId: id,
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/hq720.jpg', width: 360, height: 202 }] },
    title: { runs: [{ text: title }], accessibility: { accessibilityData: { label: `${title} 3 minutes` } } },
    ownerText: { runs: [{ text: channel, navigationEndpoint: { browseEndpoint: { browseId: 'UCabc' } } }] },
    longBylineText: { runs: [{ text: channel }] },
    viewCountText: { simpleText: '12,345 views' },
    ...extra,
  };
  if (length) r.lengthText = { accessibility: { accessibilityData: { label: 'x' } }, simpleText: length };
  if (badge) r.ownerBadges = [{ metadataBadgeRenderer: { icon: { iconType: 'CHECK' }, style: badge, tooltip: 'Verified' } }];
  if (live) r.badges = [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }];
  return { videoRenderer: r };
}

const ARTIST = 'BADGE_STYLE_TYPE_VERIFIED_ARTIST';
const VERIFIED = 'BADGE_STYLE_TYPE_VERIFIED';

/** ytInitialData with the videos in the main list, plus the furniture a real page has around them. */
function initialData(items) {
  return {
    responseContext: { serviceTrackingParams: [{ service: 'GUIDED_HELP', params: [{ key: 'context', value: 'yt_web_search' }] }] },
    estimatedResults: '1234',
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { channelRenderer: { channelId: 'UCx', title: { simpleText: 'Some Channel' } } },
                    ...items.slice(0, 2),
                    { shelfRenderer: { title: { simpleText: 'People also watched' }, content: { verticalListRenderer: { items: items.slice(2, 4) } } } },
                    { reelShelfRenderer: { items: [{ shortsLockupViewModel: { entityId: 'shorts-x' } }] } },
                    ...items.slice(4),
                  ],
                },
              },
              { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } },
            ],
          },
        },
      },
    },
  };
}

/** The search page as relay 2 (r.jina.ai, X-Return-Format: html) returns it. */
function htmlPage(items) {
  return [
    '<!DOCTYPE html><html lang="en"><head><title>results - YouTube</title>',
    '<script nonce="n1">var ytcfg = {"x": "{not the data}"};</script>',
    `<script nonce="n2">var ytInitialData = ${JSON.stringify(initialData(items))};</script>`,
    '<script nonce="n3">window["ytInitialData"] && console.log("done");</script>',
    '</head><body><ytd-app></ytd-app></body></html>',
  ].join('\n');
}

/** The same page as relay 1 (web.scraper.workers.dev, selector=script, scrape=text) returns it. */
function relayJson(items) {
  return JSON.stringify({
    result: {
      script: ['window.WIZ_global_data = {"a":true};', 'var ytcfg = {};', `var ytInitialData = ${JSON.stringify(initialData(items))};`, "(function serverContract() {window['ytPageType'] = \"search\";})();"],
    },
  });
}

const SAMPLE = [
  vr({ id: 'aaaaaaaaaa1', title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', length: '3:21', badge: ARTIST }),
  vr({ id: 'aaaaaaaaaa2', title: 'Glass Harbor', channel: 'Mara Vale - Topic', length: '3:21' }),
  vr({ id: 'aaaaaaaaaa3', title: 'Mara Vale - Glass Harbor {Lyrics} "night" \\ edit', channel: 'Moonlit Lyrics', length: '3:22', badge: VERIFIED }),
  vr({ id: 'aaaaaaaaaa4', title: 'Mara Vale live stream', channel: 'Mara Vale', badge: ARTIST, live: true }),
  vr({ id: 'aaaaaaaaaa5', title: 'Mara Vale - Glass Harbor (Live at Copper Hall)', channel: 'Mara Vale', length: '1:02:03', badge: ARTIST }),
];

/* ---------- parser ---------- */

test('parseYouTubeSearch: the HTML page (relay 2) → candidates in document order', () => {
  const list = parseYouTubeSearch(htmlPage(SAMPLE));
  assert.deepEqual(
    list.map((c) => c.videoId),
    ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa4', 'aaaaaaaaaa5'],
  );
  assert.deepEqual(list[0], {
    videoId: 'aaaaaaaaaa1',
    title: 'Mara Vale - Glass Harbor (Official Audio)',
    channel: 'Mara Vale',
    durationS: 201,
    verifiedArtist: true,
    verified: true,
    topic: false,
    rank: 0,
    live: false,
  });
  assert.equal(list[1].topic, true);
  assert.equal(list[1].verified, false);
  assert.equal(list[2].verified, true);
  assert.equal(list[2].verifiedArtist, false);
  // braces, quotes and a backslash inside a title do not confuse the brace scan
  assert.equal(list[2].title, 'Mara Vale - Glass Harbor {Lyrics} "night" \\ edit');
  assert.equal(list[3].live, true);
  assert.equal(list[3].durationS, null);
  assert.equal(list[4].durationS, 3723);
});

test('parseYouTubeSearch: the relay-1 JSON shape gives the same candidates', () => {
  assert.deepEqual(parseYouTubeSearch(relayJson(SAMPLE)), parseYouTubeSearch(htmlPage(SAMPLE)));
  // a single string instead of an array, and whitespace in front
  const single = '\n  ' + JSON.stringify({ result: { script: `var ytInitialData = ${JSON.stringify(initialData(SAMPLE))};` } });
  assert.equal(parseYouTubeSearch(single).length, 5);
});

test('parseYouTubeSearch: data shipped as a JS string literal (\\x escapes) and window["ytInitialData"]', () => {
  const json = JSON.stringify(initialData(SAMPLE));
  // the way such pages write it: backslashes doubled, structural characters as \xHH
  const escaped = json.replace(/\\/g, '\\\\').replace(/[{}"']/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  assert.equal(parseYouTubeSearch(`<script>var ytInitialData = '${escaped}';</script>`).length, 5);
  assert.equal(parseYouTubeSearch(`<script>window["ytInitialData"] = ${json};</script>`).length, 5);
});

test('readSearchPage: a results page with no videos is "found"; a consent wall or junk is not', () => {
  assert.deepEqual(readSearchPage(htmlPage([])), { found: true, candidates: [] });
  assert.deepEqual(readSearchPage('<html><body>Before you continue to YouTube</body></html>'), { found: false, candidates: [] });
  assert.deepEqual(readSearchPage(JSON.stringify({ result: { script: ['var x = 1;'] } })), { found: false, candidates: [] });
});

test('parseYouTubeSearch: junk, truncated and malformed input → [] without throwing', () => {
  const page = htmlPage(SAMPLE);
  const junk = [
    undefined,
    null,
    42,
    {},
    '',
    'ytInitialData',
    'ytInitialData = ',
    'var ytInitialData = {',
    'var ytInitialData = {"contents": [}',
    "var ytInitialData = '\\x7",
    page.slice(0, Math.floor(page.length / 2)),
    page.replace('var ytInitialData = {', 'var ytInitialData = {{'),
    '{"result": {"script": [1, null, {"a": "ytInitialData"}]}}',
    '{"result": "nope"}',
    '[1,2,3]',
    'var ytInitialData = [1,2,3];',
    'var ytInitialData = {"videoRenderer": "not an object", "x": {"videoRenderer": [1, 2]}};',
  ];
  for (const j of junk) assert.deepEqual(parseYouTubeSearch(j), [], `input ${String(j).slice(0, 40)}`);
});

test('parseYouTubeSearch: bad ids, missing titles and duplicates are dropped; at most 40 kept', () => {
  const items = [
    vr({ id: 'short', title: 'A', channel: 'C', length: '3:00' }),
    vr({ id: 'has/slash11', title: 'B', channel: 'C', length: '3:00' }),
    vr({ id: 'okokokokok1', title: '', channel: 'C', length: '3:00' }),
    vr({ id: 'okokokokok2', title: 'Kept', channel: 'C', length: 'LIVE' }),
    vr({ id: 'okokokokok2', title: 'Duplicate', channel: 'C', length: '3:00' }),
  ];
  const list = parseYouTubeSearch(htmlPage(items));
  assert.deepEqual(list.map((c) => [c.videoId, c.title, c.durationS]), [['okokokokok2', 'Kept', null]]);
  const many = Array.from({ length: 120 }, (_, i) => vr({ id: `m${String(i).padStart(10, '0')}`, title: `Song ${i}`, channel: 'C', length: '3:00' }));
  const big = parseYouTubeSearch(htmlPage(many));
  assert.equal(big.length, 40);
  assert.deepEqual(big.map((c) => c.rank), Array.from({ length: 40 }, (_, i) => i));
});

test('parseClock', () => {
  assert.equal(parseClock('4:40'), 280);
  assert.equal(parseClock('0:45'), 45);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock(' 12:00 '), 720);
  for (const bad of ['', 'LIVE', '4:4', '4:60x', '99:99:99', '0:00', null, 280]) assert.equal(parseClock(bad), null, String(bad));
});

test('parseYouTubeSearch: hostile 2 MB inputs finish fast and give [] (child process with a kill timer)', () => {
  // A stuck parser cannot be interrupted from its own thread, so this runs in a child with a timeout.
  const ytUrl = new URL('../js/sources/youtube.js', import.meta.url).href;
  const code = `
    import { parseYouTubeSearch, readSearchPage } from ${JSON.stringify(ytUrl)};
    const N = 2 * 1024 * 1024;
    const M = 'ytInitial' + 'Data';
    const inputs = [
      '{'.repeat(N),
      M + ' = ' + '{'.repeat(N),
      M + ' = {"' + '\\\\'.repeat(N),
      M + ' = ' + '['.repeat(N),
      (M + ' = {"a":').repeat(Math.floor(N / 16)),
      (M + ' = ').repeat(Math.floor(N / 16)),
      (M + '"] = \\'\\\\x7').repeat(Math.floor(N / 20)),
      M + ' = ' + '{"a":'.repeat(200000) + '1' + '}'.repeat(200000) + ';',
      JSON.stringify({ result: { script: Array.from({ length: 200 }, () => 'x'.repeat(10000)) } }),
      JSON.stringify({ result: { script: [M + ' = ' + '{'.repeat(N / 2)] } }),
      '<script>' + '"'.repeat(N) + M,
      M + ' = {"x":"' + '}'.repeat(N) + '"',
    ];
    const t0 = performance.now();
    const out = inputs.map((s) => parseYouTubeSearch(s).length);
    const found = inputs.map((s) => readSearchPage(s).found);
    console.log(JSON.stringify({ ms: performance.now() - t0, out, found }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 30000, encoding: 'utf8' });
  assert.equal(run.error, undefined, `did not finish: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, run.stderr);
  const { ms, out } = JSON.parse(run.stdout);
  assert.deepEqual(out, out.map(() => 0));
  assert.ok(ms < 4000, `took ${ms.toFixed(0)} ms for 12 inputs (two passes each)`);
});

/* ---------- scoring ---------- */

const W = { title: 'Glass Harbor', artist: 'Mara Vale', durationMs: 201000 };
/** A candidate with defaults: an unverified upload, 3:21, first in the list. */
const cand = (title, channel = 'Someone Uploads', durationS = 201, more = {}) => ({
  videoId: 'cccccccccc1',
  title,
  channel,
  durationS,
  verifiedArtist: false,
  verified: false,
  topic: / - Topic$/.test(channel),
  rank: 0,
  live: false,
  ...more,
});
const oac = { verifiedArtist: true, verified: true };
const ver = { verified: true };

/** [label, wanted, candidate, expectation] — 'accept' = playable, 'reject' = not even an alternate. */
const TABLE = [
  ['official audio, artist channel', W, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['topic channel art track', W, cand('Glass Harbor', 'Mara Vale - Topic', 202), 'accept'],
  ['official video, VEVO channel, 6 s long', W, cand('Mara Vale - Glass Harbor (Official Music Video)', 'MaraValeVEVO', 207, ver), 'accept'],
  ['verified lyrics channel re-upload', W, cand('Mara Vale - Glass Harbor (Lyrics)', 'Moonlit Lyrics', 202, ver), 'accept'],
  ['unverified re-upload, "Title - Artist"', W, cand('Glass Harbor - Mara Vale (Lyric Video)'), 'accept'],
  ['decorations in capitals, 4K outside brackets', W, cand('MARA VALE - GLASS HARBOR [OFFICIAL VIDEO] 4K', 'Mara Vale', 203, oac), 'accept'],
  ['trailing "| label" segment', W, cand('Mara Vale - Glass Harbor (Visualizer) | Night Drive Records', 'Night Drive Records', 201, ver), 'accept'],
  ['decoration as a dash suffix', W, cand('Mara Vale - Glass Harbor - Official Visualiser', 'Mara Vale', 201, oac), 'accept'],
  ['two artists, comma credit', { ...W, artist: 'Mara Vale, Juno Pike' }, cand('Mara Vale, Juno Pike - Glass Harbor (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['feat. in the video title', { title: 'Glass Harbor (feat. Juno Pike)', artist: 'Mara Vale, Juno Pike', durationMs: 201000 }, cand('Mara Vale - Glass Harbor ft. Juno Pike (Official Video)', 'Mara Vale', 203, oac), 'accept'],
  ['reversed credit with feat.', { title: 'Glass Harbor (feat. Juno Pike)', artist: 'Mara Vale, Juno Pike', durationMs: 201000 }, cand('Glass Harbor - Mara Vale ft. Juno Pike'), 'accept'],
  ['artist channel with a nickname, artist badge', W, cand('Glass Harbor', 'MaraValeHQ', 201, oac), 'accept'],
  ['quoted title, no dash', W, cand('Mara Vale "Glass Harbor" (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['censored wanted title', { ...W, title: 'Gl*ss Harbor' }, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['music video with a 12 s skit', W, cand('Mara Vale - Glass Harbor (Official Video)', 'Mara Vale', 213, oac), 'accept'],
  ['live performance', W, cand('Mara Vale - Glass Harbor (Live at Copper Hall)', 'Mara Vale', 205, oac), 'reject'],
  ['live, outside brackets after a pipe', W, cand('Mara Vale - Glass Harbor | Live at Copper Hall', 'Mara Vale', 205, oac), 'reject'],
  ['festival set after a pipe, broadcaster channel', W, cand('Mara Vale - Glass Harbor | Glastonbury 2025', 'BBC Music', 203, ver), 'reject'],
  ['festival set, the broadcaster named in the title too', W, cand('Mara Vale - Glass Harbor | Glastonbury 2025 | BBC Music', 'BBC Music', 203, ver), 'reject'],
  ['festival with a year, no "live" anywhere', W, cand('Mara Vale - Glass Harbor | Reading 2025', 'Stage Archive', 203), 'reject'],
  ['festival with a year on the artist channel', W, cand('Mara Vale - Glass Harbor (Primavera Sound 2024)', 'Mara Vale', 204, oac), 'reject'],
  ['stage name', W, cand('Mara Vale - Glass Harbor (Pyramid Stage)', 'Mara Vale', 204, oac), 'reject'],
  ['radio session channel, plain title', W, cand('Mara Vale - Glass Harbor', 'BBC Radio 1', 202, ver), 'reject'],
  ['session series channel, plain title', W, cand('Mara Vale - Glass Harbor', 'KEXP', 205, ver), 'reject'],
  ['TV special on a broadcaster channel shared with the artist', W, cand('Mara Vale - Glass Harbor | Annual Hootenanny 2025', 'BBC Music and Mara Vale', 203, ver), 'reject'],
  ['broadcaster leading a shared channel, plain title', W, cand('Mara Vale - Glass Harbor', 'BBC Music and Mara Vale', 203, ver), 'reject'],
  ['a shared channel the artist leads is fine', W, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale and Juno Pike', 201, ver), 'accept'],
  ['interview "lyrics & meaning"', W, cand('Mara Vale - Glass Harbor (Official Lyrics & Meaning) | Verified', 'Genius', 201, ver), 'reject'],
  ['"Reading" inside the wanted title', { ...W, title: 'Reading Lights' }, cand('Mara Vale - Reading Lights (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['a broadcaster upload that says official', W, cand('Mara Vale - Glass Harbor (Official Audio)', 'Vevo', 201, ver), 'accept'],
  ['artist channel ending in VEVO is not a broadcaster', W, cand('Mara Vale - Glass Harbor', 'Mara Vale VEVO', 201, ver), 'accept'],
  ['cover by another singer', W, cand('Glass Harbor - Mara Vale (Cover by Tess Arden)', 'Tess Arden', 199), 'reject'],
  ['karaoke channel', W, cand('Glass Harbor (Karaoke Version) - Mara Vale', 'Sing Along Karaoke', 201), 'reject'],
  ['instrumental', W, cand('Mara Vale - Glass Harbor (Instrumental)', 'Mara Vale', 201, oac), 'reject'],
  ['acapella', W, cand('Mara Vale - Glass Harbor (Acapella)', 'Vocal Stems', 199), 'reject'],
  ['slowed + reverb', W, cand('Mara Vale - Glass Harbor (slowed + reverb)', 'Sad Hours', 260), 'reject'],
  ['sped up', W, cand('mara vale - glass harbor (sped up)', 'Fast Tunes', 170), 'reject'],
  ['nightcore channel', W, cand('Nightcore - Glass Harbor', 'Nightcore Vibes', 180), 'reject'],
  ['8D audio', W, cand('Mara Vale - Glass Harbor (8D Audio)', 'Spatial Sounds', 201), 'reject'],
  ['bass boosted', W, cand('Mara Vale - Glass Harbor [Bass Boosted]', 'Boost Lab', 201), 'reject'],
  ['432 Hz retune', W, cand('Mara Vale - Glass Harbor (432Hz)', 'Calm Frequencies', 202), 'reject'],
  ['one hour loop', W, cand('Mara Vale - Glass Harbor (1 Hour Loop)', 'Loop Station', 3600), 'reject'],
  ['extended mix not asked for', W, cand('Mara Vale - Glass Harbor (Extended Mix)', 'Mara Vale', 330, oac), 'reject'],
  ['reaction video', W, cand('Reacting to Mara Vale - Glass Harbor', 'Hot Takes', 600), 'reject'],
  ['piano tutorial', W, cand('Glass Harbor - Mara Vale | Piano Tutorial', 'Keys Academy', 420), 'reject'],
  ['remix not asked for', W, cand('Mara Vale - Glass Harbor (Dusk Unit Remix)', 'Dusk Unit', 245, oac), 'reject'],
  ['remix in the dash part', W, cand('Glass Harbor - Mara Vale And Dusk Unit Remix', 'Club Uploads', 205), 'reject'],
  ['remix as a hashtag', W, cand('Mara Vale - Glass Harbor #remix #club', 'Club Uploads', 204), 'reject'],
  ['remix asked for, right remixer', { title: 'Glass Harbor - Dusk Unit Remix', artist: 'Mara Vale', durationMs: 245000 }, cand('Mara Vale - Glass Harbor (Dusk Unit Remix) [Official Audio]', 'Mara Vale', 245, oac), 'accept'],
  ['remix asked for, other remixer', { title: 'Glass Harbor - Dusk Unit Remix', artist: 'Mara Vale', durationMs: 245000 }, cand('Mara Vale - Glass Harbor (Kilo Fen Remix)', 'Kilo Fen', 246, oac), 'reject'],
  ['remix asked for, original offered', { title: 'Glass Harbor - Dusk Unit Remix', artist: 'Mara Vale', durationMs: 245000 }, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 244, oac), 'reject'],
  ['lyrics translation in another script', W, cand('Mara Vale - Glass Harbor (Lyrics) 中文歌詞', 'Lyric Pages', 201), 'reject'],
  ['Spanish subtitles translation', W, cand('Mara Vale - Glass Harbor (Sub Español + Lyrics)', 'Traducciones', 201, ver), 'reject'],
  ['35 s longer', W, cand('Mara Vale - Glass Harbor (Official Video)', 'Mara Vale', 236, oac), 'reject'],
  ['75 s longer', W, cand('Mara Vale - Glass Harbor (Official Video)', 'Mara Vale', 276, oac), 'reject'],
  ['no artist anywhere', W, cand('Glass Harbor (Official Audio)', 'Northwind Records', 201), 'reject'],
  ['another artist, same title', W, cand('Tess Arden - Glass Harbor', 'Tess Arden', 201, oac), 'reject'],
  ['somebody else leading, wanted artist as guest', W, cand('Kilo Fen ft. Mara Vale - Glass Harbor', 'Kilo Fen', 201), 'reject'],
  ['another song by the artist', W, cand('Mara Vale - Silver Coast (Official Audio)', 'Mara Vale', 201, oac), 'reject'],
  ['title with an extra word', W, cand('Mara Vale - Glass Harbor Nights', 'Mara Vale', 201, oac), 'reject'],
  ['fan edit ("but it\'s…")', W, cand('Mara Vale "Glass Harbor" but it\'s even more cinematic', 'Edit Corner', 215), 'reject'],
  ['another singer\'s version', W, cand('Mara Vale - Glass Harbor (Arden Version)', 'Arden Sings', 201), 'reject'],
  ['3D audio', W, cand('Mara Vale - Glass Harbor (3D Audio) | Use Headphones', 'Spatial Sounds', 201), 'reject'],
  ['demo draft', W, cand('glass harbor (lyric draft from bed)', 'Mara Vale', 194, oac), 'reject'],
  ['live stream', W, cand('Mara Vale - Glass Harbor', 'Mara Vale', null, { ...oac, live: true }), 'reject'],
  ['named version wanted, original offered', { ...W, title: "Glass Harbor (Mara's Version)" }, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 201, oac), 'reject'],
  ['other named version', { ...W, title: "Glass Harbor (Mara's Version)" }, cand("Mara Vale - Glass Harbor (Tess's Version)", 'Mara Vale', 201, oac), 'reject'],
  ['trap word inside the wanted title ("… to Live")', { ...W, title: 'Born to Live' }, cand('Mara Vale - Born to Live (Official Audio)', 'Mara Vale', 201, oac), 'accept'],
  ['…and a real live cut of that title', { ...W, title: 'Born to Live' }, cand('Mara Vale - Born to Live (Live at Copper Hall)', 'Mara Vale', 203, oac), 'reject'],
  ['"best of" inside the wanted title', { ...W, title: 'Best of Both Coasts' }, cand('Mara Vale - Best of Both Coasts', 'Mara Vale', 201, oac), 'accept'],
  ['fan channel with a similar name, no badge', W, cand('Mara Vale - Glass Harbor (Audio)', 'MaraValeFan13', 201), 'accept'],
  ['named version wanted and offered', { ...W, title: "Glass Harbor (Mara's Version)" }, cand("Mara Vale - Glass Harbor (Mara's Version) (Lyric Video)", 'Mara Vale', 202, oac), 'accept'],
  ['non-Latin title, artist channel', { title: '夜の港', artist: 'Hoshino Rei', durationMs: 240000 }, cand('Hoshino Rei - 夜の港 (Official Music Video)', 'Hoshino Rei', 241, oac), 'accept'],
  ['non-Latin title in corner brackets, no dash', { title: '夜の港', artist: 'Hoshino Rei', durationMs: 240000 }, cand('Hoshino Rei「夜の港」Official Video', 'Hoshino Rei', 240, oac), 'accept'],
  ['transliterated title, artist topic, same length', { title: '夜の港', artist: 'Hoshino Rei', durationMs: 240000 }, cand('Yoru no Minato', 'Hoshino Rei - Topic', 241), 'accept'],
  ['transliterated title, 5 s off', { title: '夜の港', artist: 'Hoshino Rei', durationMs: 240000 }, cand('Yoru no Minato', 'Hoshino Rei - Topic', 245), 'reject'],
  ['no artist wanted (pasted title), topic upload', { title: 'Glass Harbor' }, cand('Glass Harbor', 'Mara Vale - Topic', 201), 'accept'],
  ['no artist wanted, a 45 s short', { title: 'Glass Harbor', artist: UNKNOWN_ARTIST }, cand('Glass Harbor #shorts', 'Clip Farm', 45), 'reject'],
];

test(`scoreVideo: table of ${TABLE.length} cases (traps, decorations, channels, lengths, scripts)`, () => {
  assert.ok(TABLE.length >= 30);
  const wrong = [];
  for (const [label, wanted, c, expect] of TABLE) {
    const d = scoreVideoDetail(wanted, c);
    assert.equal(scoreVideo(wanted, c), d.score);
    assert.ok(d.score >= 0 && d.score <= 1, label);
    const ok = expect === 'accept' ? d.score >= YT_ACCEPT : d.score < YT_ALTERNATE;
    if (!ok) wrong.push(`${label}: ${d.score} (${d.evidence}; ${d.reason})`);
  }
  assert.deepEqual(wrong, []);
});

test('scoreVideo: preferences among right answers (official audio and topic above re-uploads and long videos)', () => {
  const official = scoreVideoDetail(W, cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 201, oac));
  const topic = scoreVideoDetail(W, cand('Glass Harbor', 'Mara Vale - Topic', 201));
  const lyrics = scoreVideoDetail(W, cand('Mara Vale - Glass Harbor (Lyrics)', 'Moonlit Lyrics', 201, ver));
  const reupload = scoreVideoDetail(W, cand('Mara Vale - Glass Harbor (Lyrics)', 'Lyrics Planet', 201));
  const skit = scoreVideoDetail(W, cand('Mara Vale - Glass Harbor (Official Video)', 'Mara Vale', 213, oac));
  assert.ok(official.rankScore > lyrics.rankScore && topic.rankScore > lyrics.rankScore);
  assert.ok(lyrics.rankScore > reupload.rankScore);
  assert.ok(lyrics.rankScore > skit.rankScore, 'exact audio beats a music video with a skit');
  assert.ok(skit.score >= YT_ACCEPT && skit.score < 0.95);
  // explicit original wanted: the clean edit loses to a plain upload
  const ex = { ...W, explicit: true };
  assert.ok(scoreVideo(ex, cand('Mara Vale - Glass Harbor (Clean)')) < scoreVideo(ex, cand('Mara Vale - Glass Harbor')));
  // rankVideos sorts by preference, then by search position
  const ranked = rankVideos(W, [
    cand('Mara Vale - Glass Harbor (Lyrics)', 'Moonlit Lyrics', 201, { ...ver, videoId: 'lyricslyric', rank: 0 }),
    cand('Mara Vale - Glass Harbor (Live)', 'Mara Vale', 201, { ...oac, videoId: 'livelivelve', rank: 1 }),
    cand('Mara Vale - Glass Harbor (Official Audio)', 'Mara Vale', 201, { ...oac, videoId: 'officialaud', rank: 2 }),
  ]);
  assert.deepEqual(ranked.map((r) => r.c.videoId), ['officialaud', 'lyricslyric', 'livelivelve']);
});

test('rankVideos: two transliteration guesses that disagree are both dropped', () => {
  const wanted = { title: '夜の港', artist: 'Hoshino Rei', durationMs: 240000 };
  const a = cand('Yoru no Minato', 'Hoshino Rei - Topic', 240, { videoId: 'translitaaa' });
  const b = cand('Hana Kaze', 'Hoshino Rei - Topic', 240, { videoId: 'translitbbb', rank: 1 });
  const ranked = rankVideos(wanted, [a, b]);
  assert.ok(ranked.every((r) => r.d.score < YT_ACCEPT));
});

test('scoreVideo: bad input never throws', () => {
  for (const [t, c] of [[null, cand('x')], [W, null], [{}, cand('x')], [{ title: '' }, cand('x')], [W, { title: 5 }], [W, cand('')], [{ title: '!!!' }, cand('Glass Harbor')]]) {
    assert.equal(scoreVideo(t, c), 0);
  }
});

/* ---------- queries ---------- */

test('youtubeQueries: first artist + title + version words, no feat., no remaster; title only without an artist', () => {
  const q = (title, artist) => youtubeQueries({ title, artist })[0];
  assert.equal(q('Glass Harbor (feat. Juno Pike)', 'Mara Vale, Juno Pike'), 'Mara Vale Glass Harbor');
  assert.equal(q('Glass Harbor feat. Juno Pike', 'Mara Vale feat. Juno Pike'), 'Mara Vale Glass Harbor');
  assert.equal(q('Glass Harbor - Dusk Unit Remix', 'Mara Vale'), 'Mara Vale Glass Harbor Dusk Unit Remix');
  assert.equal(q('Glass Harbor - Acoustic', 'Mara Vale'), 'Mara Vale Glass Harbor Acoustic');
  assert.equal(q('Glass Harbor (Sped Up)', 'Mara Vale'), 'Mara Vale Glass Harbor Sped Up');
  assert.equal(q('Glass Harbor - 2011 Remaster', 'Mara Vale'), 'Mara Vale Glass Harbor');
  assert.equal(q('Glass Harbor - Radio Edit', 'Mara Vale'), 'Mara Vale Glass Harbor');
  assert.equal(q('Glass Harbor - Extended Mix', 'Mara Vale'), 'Mara Vale Glass Harbor extended mix');
  assert.equal(q('Glass "Harbor"', 'Mara Vale'), 'Mara Vale Glass Harbor');
  assert.equal(q('Glass Harbor', ''), 'Glass Harbor');
  assert.equal(q('Glass Harbor', UNKNOWN_ARTIST), 'Glass Harbor');
  assert.deepEqual(youtubeQueries({ title: 'Glass Harbor', artist: 'Mara Vale' }), ['Mara Vale Glass Harbor', 'Mara Vale Glass Harbor official audio', 'Mara Vale Glass Harbor lyrics']);
  assert.deepEqual(youtubeQueries(null), []);
});

/* ---------- the finder, with a fake network ---------- */

const TRACK = { id: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: 'Glass Harbor', artist: 'Mara Vale', durationMs: 201000 };
const GOOD = [
  vr({ id: 'officialaud', title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', length: '3:21', badge: ARTIST }),
  vr({ id: 'topictopic1', title: 'Glass Harbor', channel: 'Mara Vale - Topic', length: '3:21' }),
  vr({ id: 'livelivelv1', title: 'Mara Vale - Glass Harbor (Live at Copper Hall)', channel: 'Mara Vale', length: '3:40', badge: ARTIST }),
  vr({ id: 'lyricslyric', title: 'Mara Vale - Glass Harbor (Lyrics)', channel: 'Moonlit Lyrics', length: '3:22', badge: VERIFIED }),
  vr({ id: 'longvideo01', title: 'Mara Vale - Glass Harbor (Official Video)', channel: 'Mara Vale', length: '3:58', badge: ARTIST }),
  vr({ id: 'slowedslow1', title: 'Mara Vale - Glass Harbor (slowed + reverb)', channel: 'Sad Hours', length: '4:20' }),
];

const quickLimiter = () => createLimiter({ max: 10000, windowMs: 1000, concurrency: 1 });

/** In-memory Storage. */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => (m.has(YT_STORAGE_KEY) ? JSON.parse(m.get(YT_STORAGE_KEY)) : null),
  };
}

/** The oEmbed answer YouTube gives for a fixture video: its real title and channel (an unknown id: an empty 200). */
const realOembed = (id) => (OEMBED.has(id) ? { status: 200, body: oembedBody(OEMBED.get(id).title, OEMBED.get(id).channel) } : { status: 200, body: '{}' });

/**
 * A fake network. `routes` decides per call: scraper(query) / jina(query) / oembed(id) return
 * {status, body} | 'hang' | throw. Every call is logged.
 */
function fakeNet(routes = {}) {
  const calls = [];
  const active = { scraper: 0, jina: 0, oembed: 0 };
  const peak = { scraper: 0, jina: 0, oembed: 0 };
  const fetchText = async (url, opts = {}) => {
    const u = new URL(url.startsWith('https://r.jina.ai/') ? url.slice('https://r.jina.ai/'.length) : url);
    let kind;
    let arg;
    if (url.startsWith('https://web.scraper.workers.dev/')) {
      kind = 'scraper';
      arg = new URL(u.searchParams.get('url')).searchParams.get('search_query');
    } else if (url.startsWith('https://r.jina.ai/')) {
      kind = 'jina';
      arg = u.searchParams.get('search_query');
    } else if (url.startsWith('https://www.youtube.com/oembed')) {
      kind = 'oembed';
      arg = new URL(u.searchParams.get('url')).searchParams.get('v');
    } else throw new Error(`unexpected url ${url}`);
    calls.push({ kind, arg, url, headers: opts.headers, maxBytes: opts.maxBytes, signal: opts.signal });
    const route = routes[kind] || (kind === 'oembed' ? realOembed : () => ({ status: 200, body: kind === 'scraper' ? relayJson(GOOD) : htmlPage(GOOD) }));
    active[kind]++;
    peak[kind] = Math.max(peak[kind], active[kind]);
    try {
      const r = await route(arg, opts);
      if (r === 'hang') {
        await new Promise((_, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (opts.signal && opts.signal.aborted) fail();
          else if (opts.signal) opts.signal.addEventListener('abort', fail, { once: true });
        });
      }
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.body };
    } finally {
      active[kind]--;
    }
  };
  return { fetchText, calls, peak };
}

const finderWith = (net, more = {}) => createYouTubeFinder({ fetchText: net.fetchText, storage: null, searchLimiter: quickLimiter(), relayLimiters: {}, hedgeMs: 1000, ...more });

test('find: query shape, relay 1 first, best upload + alternates, oEmbed on the pick and every alternate', async () => {
  const net = fakeNet();
  const finder = finderWith(net);
  const m = await finder.find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.equal(m.title, 'Mara Vale - Glass Harbor (Official Audio)');
  assert.equal(m.channel, 'Mara Vale');
  assert.equal(m.durationS, 201);
  assert.ok(m.score >= 0.95);
  // the topic upload and the lyrics re-upload; never the live cut, the slowed edit or the 37 s longer video
  assert.deepEqual(m.alternates, ['topictopic1', 'lyricslyric']);
  const searches = net.calls.filter((c) => c.kind !== 'oembed');
  assert.deepEqual(searches.map((c) => [c.kind, c.arg]), [['scraper', 'Mara Vale Glass Harbor']]);
  assert.equal(searches[0].maxBytes, 3 * 1024 * 1024);
  assert.ok(searches[0].url.includes('selector=script') && searches[0].url.includes('scrape=text'));
  // the alternates go to the deck without another look, so YouTube vouches for them too
  assert.deepEqual(net.calls.filter((c) => c.kind === 'oembed').map((c) => c.arg), ['officialaud', 'topictopic1', 'lyricslyric']);
  assert.equal(m.badge, 'a');
  assert.deepEqual(m.altInfo, [
    { durationS: 201, badge: '' },
    { durationS: 202, badge: 'v' },
  ]);
});

test('find: relay 1 failing → relay 2 (with the HTML header); a relay failing twice moves to the back', async () => {
  const net = fakeNet({ scraper: () => ({ status: 502, body: 'bad gateway' }) });
  const finder = finderWith(net);
  assert.equal((await finder.find(TRACK)).videoId, 'officialaud');
  const jina = net.calls.find((c) => c.kind === 'jina');
  assert.deepEqual(jina.headers, { 'X-Return-Format': 'html' });
  await finder.find({ ...TRACK, title: 'Glass Harbor (feat. Juno Pike)', artist: 'Mara Vale, Juno Pike' });
  const s = finder.stats();
  assert.equal(s.relay.scraper.fail, 2);
  assert.equal(s.relay.jina.ok, 2);
  // demoted: the third search asks relay 2 first
  net.calls.length = 0;
  await finder.find({ ...TRACK, id: 'x', title: 'Glass Harbor - Acoustic' }).catch(() => {});
  assert.equal(net.calls.filter((c) => c.kind !== 'oembed')[0].kind, 'jina');
});

test('find: a silent relay 1 is hedged — relay 2 starts after hedgeMs, first valid answer wins', async () => {
  const net = fakeNet({ scraper: () => 'hang' });
  const finder = finderWith(net, { hedgeMs: 40 });
  const t0 = Date.now();
  const m = await finder.find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.ok(Date.now() - t0 < 1000);
  const scraper = net.calls.find((c) => c.kind === 'scraper');
  assert.equal(scraper.signal.aborted, true, 'the loser is cancelled');
});

test('find: no relay reachable → ResolveError network (not cached)', async () => {
  let down = true;
  const net = fakeNet({
    scraper: () => {
      if (down) throw new TypeError('Failed to fetch');
      return { status: 200, body: relayJson(GOOD) };
    },
    jina: () => ({ status: 429, body: 'slow down' }),
  });
  const finder = finderWith(net);
  await assert.rejects(finder.find(TRACK), (e) => e instanceof ResolveError && e.code === 'network');
  down = false;
  assert.equal((await finder.find(TRACK)).videoId, 'officialaud');
});

test('find: an age-gated query (results page, no videos) falls through to the next query', async () => {
  const net = fakeNet({ scraper: (q) => ({ status: 200, body: q.endsWith('official audio') ? relayJson(GOOD) : relayJson([]) }), jina: () => ({ status: 200, body: htmlPage([]) }) });
  const finder = finderWith(net);
  assert.equal((await finder.find(TRACK)).videoId, 'officialaud');
  const qs = [...new Set(net.calls.filter((c) => c.kind === 'scraper').map((c) => c.arg))];
  assert.deepEqual(qs, ['Mara Vale Glass Harbor', 'Mara Vale Glass Harbor official audio']);
});

test('find: nothing acceptable after every query → ResolveError no-match, cached for the session', async () => {
  const traps = [
    vr({ id: 'trapslowed1', title: 'Mara Vale - Glass Harbor (slowed + reverb)', channel: 'Sad Hours', length: '4:20' }),
    vr({ id: 'trapcover01', title: 'Glass Harbor (Cover)', channel: 'Tess Arden', length: '3:20' }),
  ];
  const net = fakeNet({ scraper: () => ({ status: 200, body: relayJson(traps) }) });
  const finder = finderWith(net);
  await assert.rejects(finder.find(TRACK), (e) => e instanceof ResolveError && e.code === 'no-match');
  assert.equal(net.calls.filter((c) => c.kind === 'scraper').length, 3);
  assert.equal(net.calls.filter((c) => c.kind === 'oembed').length, 0);
  const before = net.calls.length;
  await assert.rejects(finder.find(TRACK), (e) => e.code === 'no-match');
  assert.equal(net.calls.length, before, 'second ask answered from memory');
});

test('find: oEmbed 401/403/404 drops the pick and takes the next; a failed check proves nothing', async () => {
  for (const status of [401, 403, 404]) {
    const net = fakeNet({ oembed: (id) => ({ status: id === 'officialaud' ? status : 200, body: '{}' }) });
    const m = await finderWith(net).find(TRACK);
    assert.equal(m.videoId, 'topictopic1', `status ${status}`);
    assert.deepEqual(m.alternates, ['lyricslyric']);
  }
  const net = fakeNet({
    oembed: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal((await finderWith(net).find(TRACK)).videoId, 'officialaud');
});

test('find: memory and storage cache ({videoId, alternates, t}); a new finder reads it without searching', async () => {
  const storage = memStorage();
  const net = fakeNet();
  const a = finderWith(net, { storage });
  const first = await a.find(TRACK);
  const n = net.calls.length;
  assert.deepEqual(await a.find(TRACK), first);
  assert.equal(net.calls.length, n);
  const rec = storage.dump()['mara vale|glass harbor'];
  assert.equal(rec.videoId, 'officialaud');
  assert.deepEqual(rec.alternates, ['topictopic1', 'lyricslyric']);
  assert.ok(Number.isFinite(rec.t));
  assert.deepEqual(rec.alts, [
    { d: 201, b: '' },
    { d: 202, b: 'v' },
  ]);
  assert.equal(rec.b, 'a');
  // A new visit: the stored mapping is used without searching, after one oEmbed look at each of its
  // uploads (once per visit); after that, memory answers with no request at all.
  const b = finderWith(net, { storage });
  const again = await b.find({ ...TRACK, id: 'deezer:1' }); // same song from another source
  assert.deepEqual(again, first);
  assert.deepEqual(net.calls.slice(n).map((c) => [c.kind, c.arg]), [['oembed', 'officialaud'], ['oembed', 'topictopic1'], ['oembed', 'lyricslyric']]);
  assert.equal(b.stats().storageHits, 1);
  assert.equal(b.stats().searches, 0);
  const m = net.calls.length;
  assert.deepEqual(await b.find(TRACK), first);
  assert.equal(net.calls.length, m);
  assert.equal(storage.dump()['mara vale|glass harbor'].t, rec.t, 'a re-check that changed nothing leaves the record as it was');
  // oembed: false (tests of other parts) skips the re-check
  const c = finderWith(net, { storage, oembed: false });
  assert.equal((await c.find(TRACK)).videoId, 'officialaud');
  assert.equal(net.calls.length, m);
});

test('find: storage is capped (oldest out), stale and malformed records are ignored, a throwing storage is survived', async () => {
  const old = {};
  const base = Date.now() - 24 * 3600 * 1000; // a day old: well inside the 60 days
  for (let i = 0; i < 1500; i++) old[`artist ${i}|song ${i}`] = { videoId: 'zzzzzzzzzzz', alternates: [], t: base + i };
  const storage = memStorage({ [YT_STORAGE_KEY]: JSON.stringify(old) });
  const net = fakeNet();
  await finderWith(net, { storage }).find(TRACK);
  const all = storage.dump();
  assert.equal(Object.keys(all).length, 1500);
  assert.ok(!('artist 0|song 0' in all) && 'artist 1499|song 1499' in all && 'mara vale|glass harbor' in all);

  const bad = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ 'mara vale|glass harbor': { videoId: 'bad id', alternates: 5, t: Date.now() } }) });
  assert.equal((await finderWith(fakeNet(), { storage: bad }).find(TRACK)).videoId, 'officialaud');
  const stale = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ 'mara vale|glass harbor': { videoId: 'stalestale1', alternates: [], t: Date.now() - 400 * 24 * 3600 * 1000 } }) });
  assert.equal((await finderWith(fakeNet(), { storage: stale }).find(TRACK)).videoId, 'officialaud');
  const junk = memStorage({ [YT_STORAGE_KEY]: '{not json' });
  assert.equal((await finderWith(fakeNet(), { storage: junk }).find(TRACK)).videoId, 'officialaud');
  const throwing = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal((await finderWith(fakeNet(), { storage: throwing }).find(TRACK)).videoId, 'officialaud');
});

test('find: concurrent asks for one track share one search; different tracks are searched one at a time', async () => {
  const net = fakeNet({ scraper: async () => (await new Promise((r) => setTimeout(r, 20)), { status: 200, body: relayJson(GOOD) }) });
  const finder = finderWith(net);
  const [x, y] = await Promise.all([finder.find(TRACK), finder.find({ ...TRACK })]);
  assert.deepEqual(x, y);
  assert.equal(net.calls.filter((c) => c.kind === 'scraper').length, 1);
  await Promise.all([
    finder.find({ ...TRACK, title: 'Glass Harbor (feat. Juno Pike)', artist: 'Mara Vale, Juno Pike' }),
    finder.find({ ...TRACK, title: 'Glass Harbor', artist: 'Mara Vale, Juno Pike' }),
    finder.find({ ...TRACK, title: 'Glass Harbor', artist: 'Mara Vale & Juno Pike' }),
  ]);
  // each search takes 20 ms in the fake, so any overlap would show here
  assert.equal(net.peak.scraper, 1);
  assert.equal(net.calls.filter((c) => c.kind === 'scraper').length, 4);
});

test('find: abort — one waiter leaving keeps the shared search alive; the last one cancels it', async () => {
  const net = fakeNet({ scraper: () => 'hang', jina: () => 'hang' });
  const finder = finderWith(net, { hedgeMs: 5 });
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = finder.find(TRACK, { signal: c1.signal });
  const p2 = finder.find(TRACK, { signal: c2.signal });
  await new Promise((r) => setTimeout(r, 30));
  c1.abort();
  await assert.rejects(p1, (e) => e.name === 'AbortError');
  assert.ok(net.calls.every((c) => !c.signal.aborted), 'still searching for the other caller');
  c2.abort();
  await assert.rejects(p2, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(net.calls.every((c) => c.signal.aborted));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(finder.find(TRACK, { signal: pre.signal }), (e) => e.name === 'AbortError');
});

test('forget: a refused video is never offered again; the next find uses the alternates without searching', async () => {
  const net = fakeNet();
  const storage = memStorage();
  const finder = finderWith(net, { storage });
  const m = await finder.find(TRACK);
  const n = net.calls.length;
  finder.forget(TRACK, m.videoId);
  const next = await finder.find(TRACK);
  assert.equal(next.videoId, 'topictopic1');
  assert.deepEqual(next.alternates, ['lyricslyric']);
  assert.equal(net.calls.length, n);
  assert.equal(storage.dump()['mara vale|glass harbor'].videoId, 'topictopic1');
  // without a video id: the mapping goes and the next find searches again, never offering refused ids
  finder.forget(TRACK);
  const fresh = await finder.find(TRACK);
  assert.ok(net.calls.length > n);
  assert.notEqual(fresh.videoId, 'officialaud');
});

test('forget: a timeout, a blocked autoplay or a background tab says nothing about the upload — it stays', async () => {
  const net = fakeNet();
  const storage = memStorage();
  const finder = finderWith(net, { storage });
  const m = await finder.find(TRACK);
  const before = JSON.stringify(storage.dump());
  for (const code of ['timeout', 'blocked', 'background', 'cancelled']) finder.forget(TRACK, m.videoId, code);
  assert.deepEqual(await finder.find(TRACK), m, 'still the official upload, alternates untouched');
  assert.equal(JSON.stringify(storage.dump()), before, 'the stored mapping is not rewritten to an alternate');
  // a real refusal (embedding disabled) does count
  finder.forget(TRACK, m.videoId, 150);
  assert.equal((await finder.find(TRACK)).videoId, 'topictopic1');
  assert.equal(storage.dump()['mara vale|glass harbor'].videoId, 'topictopic1');
  assert.deepEqual(storage.dump()['mara vale|glass harbor'].alts, [{ d: 202, b: 'v' }], 'the alternate keeps its length and badge');
});

test('find: a relay that lies about which video carries which title is refuted by oEmbed', async () => {
  // The relay claims a clean official audio; YouTube's own oEmbed names a different video and channel.
  const planted = 'Qq1Qq1Qq1Qq';
  const page = [vr({ id: planted, title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale - Topic', length: '3:21' })];
  const storage = memStorage();
  const net = fakeNet({
    scraper: () => ({ status: 200, body: relayJson(page) }),
    jina: () => ({ status: 200, body: htmlPage(page) }),
    oembed: (id) => (id === planted ? { status: 200, body: oembedBody('Totally Unrelated Clip', 'Some Other Channel') } : realOembed(id)),
  });
  const finder = finderWith(net, { storage });
  await assert.rejects(finder.find(TRACK), (e) => e instanceof ResolveError && e.code === 'no-match');
  assert.ok(finder.stats().oembedMismatch >= 1);
  assert.equal(storage.dump(), null, 'nothing cached');

  // One lie among honest results: the liar is dropped, the next honest upload is played, and the title
  // and channel shown are YouTube's own.
  const mixed = [vr({ id: 'Qq2Qq2Qq2Qq', title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', length: '3:21', badge: ARTIST }), ...GOOD];
  const net2 = fakeNet({
    scraper: () => ({ status: 200, body: relayJson(mixed) }),
    oembed: (id) => (id === 'Qq2Qq2Qq2Qq' ? { status: 200, body: oembedBody('Tess Arden - Silver Coast (Official Audio)', 'Tess Arden') } : realOembed(id)),
  });
  const f2 = finderWith(net2);
  const m = await f2.find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.ok(!m.alternates.includes('Qq2Qq2Qq2Qq'));
  assert.equal(f2.stats().oembedMismatch, 1);
  // ...but it is not refused for the session: it IS the right video for the song YouTube says it is.
  const silver = [vr({ id: 'Qq2Qq2Qq2Qq', title: 'Tess Arden - Silver Coast (Official Audio)', channel: 'Tess Arden', length: '3:21', badge: ARTIST })];
  const f3 = finderWith(fakeNet({ scraper: () => ({ status: 200, body: relayJson(silver) }), oembed: () => ({ status: 200, body: oembedBody('Tess Arden - Silver Coast (Official Audio)', 'Tess Arden') }) }));
  assert.equal((await f3.find({ title: 'Silver Coast', artist: 'Tess Arden', durationMs: 201000 })).videoId, 'Qq2Qq2Qq2Qq');
});

test('find: every returned upload was checked — alternates that are gone or refuted are dropped, nothing unchecked slips in', async () => {
  const net = fakeNet({
    oembed: (id) => {
      if (id === 'lyricslyric') return { status: 404, body: 'Not Found' };
      if (id === 'topictopic1') return { status: 200, body: oembedBody('Some Stream Highlights', 'Clip Farm') };
      return realOembed(id);
    },
  });
  const finder = finderWith(net);
  const m = await finder.find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.deepEqual(m.alternates, []);
  assert.equal(finder.stats().oembedDropped, 1);
  assert.equal(finder.stats().oembedMismatch, 1);

  // Nine acceptable uploads, the first three refuted: the pick is the fourth, the alternates come only
  // from the seven that were checked.
  const many = Array.from({ length: 9 }, (_, i) => vr({ id: `many${i}`.padEnd(11, 'x'), title: 'Mara Vale - Glass Harbor (Lyrics)', channel: `Lyric Page ${i}`, length: '3:21', badge: VERIFIED }));
  const ids = many.map((x) => x.videoRenderer.videoId);
  const checked = [];
  const net2 = fakeNet({
    scraper: () => ({ status: 200, body: relayJson(many) }),
    oembed: (id) => {
      checked.push(id);
      return ids.indexOf(id) < 3 ? { status: 200, body: oembedBody('Unrelated Vlog', 'Somebody') } : realOembed(id);
    },
  });
  const m2 = await finderWith(net2).find(TRACK);
  assert.equal(checked.length, 7);
  assert.ok(checked.includes(m2.videoId));
  assert.ok(m2.alternates.every((id) => checked.includes(id)));
  assert.ok(!ids.slice(0, 3).includes(m2.videoId) && m2.alternates.every((id) => !ids.slice(0, 3).includes(id)));
  assert.equal(m2.alternates.length, 3);
});

test('storage: records past 60 days are deleted (even when nothing new is written), future-stamped and malformed ones too; capped at 1,500', async () => {
  let clock = Date.UTC(2026, 9, 5);
  const now = () => clock;
  const day = 24 * 3600 * 1000;
  const storage = memStorage();
  await finderWith(fakeNet(), { storage, now }).find(TRACK);
  assert.ok('mara vale|glass harbor' in storage.dump());

  // 61 days later a new visit looks up a song that is not found at all: the old record still goes.
  clock += 61 * day;
  const miss = fakeNet({ scraper: () => ({ status: 200, body: relayJson([]) }), jina: () => ({ status: 200, body: htmlPage([]) }) });
  await assert.rejects(finderWith(miss, { storage, now }).find({ title: 'Silver Coast', artist: 'Tess Arden', durationMs: 200000 }));
  assert.deepEqual(storage.dump(), {});

  // A record stamped in the future is not trusted for ever: ignored, searched again, and deleted.
  const fresh = (videoId, t) => ({ videoId, alternates: [], t, title: 'x', channel: 'y', score: 1 });
  const future = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ 'mara vale|glass harbor': fresh('Zz9Zz9Zz9Zz', clock + 10 * day), 'tess arden|silver coast': fresh('Zz8Zz8Zz8Zz', 8.64e15) }) });
  const net = fakeNet();
  const m = await finderWith(net, { storage: future, now }).find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.ok(net.calls.some((c) => c.kind === 'scraper'));
  assert.deepEqual(Object.keys(future.dump()), ['mara vale|glass harbor']);
  assert.equal(future.dump()['mara vale|glass harbor'].videoId, 'officialaud');
  // ...while a clock a few hours off is tolerated
  const skew = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ 'mara vale|glass harbor': { ...fresh('officialaud', clock + 3 * 3600 * 1000), title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', durationS: 201, b: 'a' } }) });
  const net3 = fakeNet();
  assert.equal((await finderWith(net3, { storage: skew, now }).find(TRACK)).videoId, 'officialaud');
  assert.ok(!net3.calls.some((c) => c.kind === 'scraper'));

  // Malformed records are swept on the first read; well-formed ones stay.
  const messy = memStorage({
    [YT_STORAGE_KEY]: JSON.stringify({
      'a|1': 'not a record',
      'a|2': { videoId: 'bad id', t: clock },
      'a|3': { videoId: 'Ab3dEf6hIj9', t: String(clock) },
      'a|4': { videoId: 'Ab3dEf6hIj9' },
      'a|5': ['Ab3dEf6hIj9'],
      ['k'.repeat(700)]: fresh('Ab3dEf6hIj9', clock),
      'a|ok': fresh('Ab3dEf6hIj9', clock - day),
    }),
  });
  await finderWith(fakeNet(), { storage: messy, now, oembed: false }).find({ title: 'Silver Coast', artist: 'Tess Arden' }).catch(() => {});
  assert.deepEqual(Object.keys(messy.dump()), ['a|ok']);

  // More than 1,500 (written by another version or another page): the oldest go on the first read.
  const lots = {};
  for (let i = 0; i < 1600; i++) lots[`artist ${i}|song ${i}`] = fresh('Ab3dEf6hIj9', clock - day + i);
  const big = memStorage({ [YT_STORAGE_KEY]: JSON.stringify(lots) });
  await finderWith(fakeNet(), { storage: big, now, oembed: false }).find({ title: 'song 1599', artist: 'artist 1599' });
  const left = Object.keys(big.dump());
  assert.equal(left.length, 1500);
  assert.ok(!left.includes('artist 99|song 99') && left.includes('artist 100|song 100'));
});

test('storage: a cached mapping is re-checked with oEmbed once per visit before it is used', async () => {
  const key = 'mara vale|glass harbor';
  // A well-formed, current record that maps the song to some other video (another page of this origin,
  // an old version, a mapping gone stale): YouTube says that video is something else, so it is searched again.
  const planted = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ [key]: { videoId: 'Zz9Zz9Zz9Zz', alternates: ['Zz7Zz7Zz7Zz'], t: Date.now(), title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', durationS: 201, score: 1, b: 'a' } }) });
  const net = fakeNet({ oembed: (id) => (id.startsWith('Zz') ? { status: 200, body: oembedBody('Unrelated Prank Clip', 'Prank Corner') } : realOembed(id)) });
  const finder = finderWith(net, { storage: planted });
  const m = await finder.find(TRACK);
  assert.equal(m.videoId, 'officialaud');
  assert.ok(net.calls.some((c) => c.kind === 'scraper'), 'searched again');
  assert.equal(planted.dump()[key].videoId, 'officialaud', 'the record is replaced');
  assert.equal(finder.stats().storageHits, 0);

  // A cached pick YouTube now calls gone: its checked alternate plays, without a search; the record
  // follows and keeps its age.
  const t0 = Date.now() - 5 * 24 * 3600 * 1000;
  const gone = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ [key]: { videoId: 'officialaud', alternates: ['topictopic1'], alts: [{ d: 201, b: '' }], t: t0, title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', durationS: 201, score: 0.98, b: 'a' } }) });
  const net2 = fakeNet({ oembed: (id) => (id === 'officialaud' ? { status: 401, body: 'Unauthorized' } : realOembed(id)) });
  const f2 = finderWith(net2, { storage: gone });
  const m2 = await f2.find(TRACK);
  assert.equal(m2.videoId, 'topictopic1');
  assert.equal(m2.title, 'Glass Harbor', "YouTube's own title");
  assert.ok(!net2.calls.some((c) => c.kind !== 'oembed'));
  assert.equal(gone.dump()[key].videoId, 'topictopic1');
  assert.equal(gone.dump()[key].t, t0);

  // oEmbed unreachable: a failed check proves nothing, the stored mapping is used as it is.
  const ok = memStorage({ [YT_STORAGE_KEY]: JSON.stringify({ [key]: { videoId: 'officialaud', alternates: ['topictopic1'], alts: [{ d: 201, b: '' }], t: t0, title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale', durationS: 201, score: 0.98, b: 'a' } }) });
  const net3 = fakeNet({
    oembed: () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const m3 = await finderWith(net3, { storage: ok }).find(TRACK);
  assert.equal(m3.videoId, 'officialaud');
  assert.deepEqual(m3.alternates, ['topictopic1']);
  assert.ok(!net3.calls.some((c) => c.kind !== 'oembed'));
});

test('find: a pasted line that reads two ways tries the other reading before giving up', async () => {
  const net = fakeNet({ scraper: (q) => ({ status: 200, body: relayJson(q.startsWith('Mara Vale Glass Harbor') ? GOOD : []) }), jina: () => ({ status: 200, body: htmlPage([]) }) });
  const finder = finderWith(net);
  const m = await finder.find({ id: 'text:0', title: 'Mara Vale', artist: 'Glass Harbor', alt: { title: 'Glass Harbor', artist: 'Mara Vale' } });
  assert.equal(m.videoId, 'officialaud');
  assert.equal(net.calls.filter((c) => c.kind === 'scraper')[0].arg, 'Glass Harbor Mara Vale');
});

test('find: a relay whose per-minute budget is spent is skipped without being blamed', async () => {
  const jinaBudget = createLimiter({ max: 1, windowMs: 60000 });
  const net = fakeNet({ scraper: () => ({ status: 503, body: '' }) });
  const finder = finderWith(net, { relayLimiters: { jina: jinaBudget } });
  // the budget allows one jina request a minute: the first find uses it, the second is refused quickly
  await finder.find(TRACK);
  const t0 = Date.now();
  const second = await finder.find({ ...TRACK, title: 'Glass Harbor (feat. Juno Pike)', artist: 'Mara Vale, Juno Pike' }).catch((e) => e);
  assert.ok(second instanceof ResolveError && second.code === 'network');
  assert.ok(Date.now() - t0 < 1000, 'refused at once, not after a wait');
  assert.equal(finder.stats().relay.jina.fail, 0);
});

test('find / search: tracks without a title, empty queries', async () => {
  const finder = finderWith(fakeNet());
  for (const bad of [null, {}, { title: '' }, { title: '   ' }, { title: 7 }]) {
    await assert.rejects(finder.find(bad), (e) => e instanceof ResolveError && e.code === 'no-match');
  }
  assert.deepEqual(await finder.search('   '), []);
  const hits = await finder.search('Mara Vale Glass Harbor');
  assert.equal(hits.length, GOOD.length);
});

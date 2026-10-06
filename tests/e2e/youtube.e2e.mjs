// YouTube finder e2e: drives tests/e2e/youtube-harness.html in headless Chrome from a localhost origin
// against the REAL services (Spotify embed via the relays, YouTube search via the relays, oEmbed).
// Searching never embeds a player, so the origin restrictions of SPEC 6.1 do not apply here.
//
//   node tests/e2e/youtube.e2e.mjs                    every group
//   node tests/e2e/youtube.e2e.mjs relays find        only these groups
//   node tests/e2e/youtube.e2e.mjs find --per=20      tracks per playlist (default 16 → 64 tracks)
//   node tests/e2e/youtube.e2e.mjs find --only=tth    only these playlists (keys below)
//   node tests/e2e/youtube.e2e.mjs find --all         also the older-catalogue EXAMPLES (2000s, rock classics);
//                                                     reported separately, outside the 90 % bar
//
// Groups: relays oembed liar find cache hostile
//   relays   each relay asked separately for the same searches: success, latency, size, parse time
//   oembed   is a refusal's status readable cross-origin (it decides whether a pick is dropped), and the
//            body of an answer (the real title / channel a relay's claim is checked against)
//   liar     a made-up relay answer against the REAL oEmbed: an honest claim is played, a lie is refuted
//   find     real playlists of different genres through loadPlaylist, find() on every track; no pick or
//            alternate may be a live / festival recording by YouTube's own title
//   cache    a second finder on the same localStorage answers without a single search (one oEmbed look per
//            stored upload, once per visit), then from memory without a single request
//   hostile  a 2.5 MB hostile relay answer must not freeze the page
// Prints a short report (match rate, mean score, latency, relay usage, suspicious rows) and writes the
// full "wanted → matched" table to tests/fixtures/youtube-report.txt (git-ignored). Exit code 0 = pass,
// non-zero when the match rate on these mainstream playlists falls below 90 %. Skips (exit 0) when Chrome
// or the network is unavailable.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES } from '../../js/sources/demo.js';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`youtube e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}
const online = await fetch('https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dm00rvC4CWH8&format=json', { signal: AbortSignal.timeout(8000) }).then(
  (r) => r.ok,
  () => false,
);
if (!online) {
  console.log('youtube e2e: SKIPPED, no network (youtube.com unreachable)');
  process.exit(0);
}

const GROUPS = ['relays', 'oembed', 'liar', 'find', 'cache', 'hostile'];
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const only = args.filter((a) => !a.startsWith('--'));
const unknown = only.filter((g) => !GROUPS.includes(g));
if (unknown.length) {
  console.error(`unknown group(s): ${unknown.join(', ')} (have: ${GROUPS.join(' ')})`);
  process.exit(2);
}
const wants = (g) => !only.length || only.includes(g);
const flag = (name, dflt) => {
  const f = flags.find((x) => x.startsWith(`--${name}=`));
  return f ? f.slice(name.length + 3) : dflt;
};
const PER = Math.max(1, Number(flag('per', 16)) || 16);
const onlyKeys = String(flag('only', '')).split(',').filter(Boolean);

/** The user's real playlists are mainstream pop / hip-hop / dance / latin: four public examples of those. */
const byLabel = (label) => {
  const ex = EXAMPLES.find((e) => e.label === label);
  if (!ex) throw new Error(`demo.js EXAMPLES has no "${label}"`);
  return ex.url;
};
const PLAYLISTS = [
  { key: 'tth', what: "Today's Top Hits (pop)", url: byLabel("Today's Top Hits"), core: true },
  { key: 'rapcaviar', what: 'RapCaviar (hip-hop)', url: byLabel('RapCaviar'), core: true },
  { key: 'mint', what: 'mint (dance / house)', url: byLabel('mint (dance)'), core: true },
  { key: 'viva', what: 'Viva Latino (latin)', url: byLabel('Viva Latino'), core: true },
  { key: 'allout', what: 'All Out 2000s (throwbacks)', url: byLabel('All Out 2000s'), core: false },
  { key: 'rock', what: 'Rock Classics (remasters, live cuts)', url: byLabel('Rock Classics'), core: false },
]
  .filter((p) => p.core || flags.includes('--all') || onlyKeys.includes(p.key))
  .filter((p) => !onlyKeys.length || onlyKeys.includes(p.key));
const CORE = new Set(PLAYLISTS.filter((p) => p.core).map((p) => p.key));
const MIN_MATCH_RATE = 0.9;
const MIN_TRACKS = 60;

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, '../fixtures/youtube-report.txt');
const report = [`Segue YouTube finder e2e — ${new Date().toISOString()}`, ''];
let failed = 0;
let passed = 0;
const say = (line = '') => {
  console.log(line);
  report.push(line);
};
const note = (line = '') => report.push(line); // report file only
const check = (ok, name, detail = '') => {
  if (ok) passed++;
  else failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
};
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
/** Titles of explicit tracks are not echoed to the console (the full text is in the report file). */
const shy = (row, text, n = 34) => (row.explicit ? `[explicit, ${String(text).length} chars]` : clip(text, n));
const pct = (x) => `${(100 * x).toFixed(1)} %`;
const quantile = (xs, q) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const answered = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: the page did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

const srv = await startServer();
const { page, errors, close } = await launch({ width: 1200, height: 800 });
try {
  await page.goto(`${srv.url}/tests/e2e/youtube-harness.html`);
  await page.waitForFunction(() => window.harnessReady === true, { timeout: 20000 });

  /* ---------- playlists (needed by relays / find / cache) ---------- */
  const tracks = [];
  if (wants('relays') || wants('find') || wants('cache')) {
    say('playlists');
    for (const pl of PLAYLISTS) {
      const r = await answered(page.evaluate((url) => H.timed(() => H.index.loadPlaylist(url)), pl.url), 90000, `load ${pl.key}`);
      if (!check(r.ok && r.value.tracks.length >= Math.min(PER, 10), `${pl.what}: loaded`, r.ok ? `${r.value.tracks.length} tracks in ${r.ms} ms` : JSON.stringify(r.error))) continue;
      for (const t of r.value.tracks.slice(0, PER)) {
        if (tracks.some((x) => x.id === t.id)) continue; // the same song in two playlists
        tracks.push({ ...t, playlist: pl.key });
      }
    }
    say(`  ${tracks.length} distinct tracks`);
  }

  /* ---------- relays ---------- */
  if (wants('relays') && tracks.length) {
    say('\nrelays (each asked separately, same searches, from this browser origin)');
    const queries = [];
    for (const pl of PLAYLISTS) {
      for (const t of tracks.filter((x) => x.playlist === pl.key).slice(0, 2)) queries.push(await page.evaluate((tr) => H.youtube.youtubeQueries(tr)[0], t));
    }
    const per = {};
    for (const q of queries) {
      for (const name of ['scraper', 'jina']) {
        const r = await answered(page.evaluate((n, qq) => H.probeRelay(n, qq), name, q), 40000, `relay ${name}`);
        (per[name] ||= []).push(r);
        note(`  ${name.padEnd(8)} ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.ms).padStart(6)} ms  status ${r.status}  ${r.bytes || 0} bytes  parse ${r.parseMs ?? '-'} ms  videos ${r.videos ?? 0}${r.error ? `  ${JSON.stringify(r.error)}` : ''}`);
      }
    }
    for (const [name, rs] of Object.entries(per)) {
      const ok = rs.filter((r) => r.ok);
      const ms = ok.map((r) => r.ms);
      // A results page without videos is YouTube's "Confirm your age" wall for that exact query (the
      // finder rephrases), not a relay failure.
      const gated = rs.filter((r) => !r.ok && r.found).length;
      say(`  ${name.padEnd(8)} ${ok.length}/${rs.length} ok${gated ? ` (+${gated} results page without videos)` : ''}  median ${quantile(ms, 0.5)} ms  p90 ${quantile(ms, 0.9)} ms  ~${Math.round(quantile(ok.map((r) => r.bytes), 0.5) / 1024)} KB  parse ${quantile(ok.map((r) => r.parseMs), 0.5)} ms`);
    }
    const best = Math.max(...Object.values(per).map((rs) => rs.filter((r) => r.ok || r.found).length / rs.length));
    check(best >= 0.8, 'at least one relay answers ≥ 80 % of searches', `best ${pct(best)}`);
    const first = per.scraper || [];
    const second = per.jina || [];
    const okRate = (rs) => rs.filter((r) => r.ok).length / Math.max(1, rs.length);
    const med = (rs) => quantile(rs.filter((r) => r.ok).map((r) => r.ms), 0.5);
    // YT_RELAYS asks scraper first; that order should still be the better one.
    if (okRate(second) > okRate(first) + 0.2 || (okRate(second) >= okRate(first) && med(second) < med(first) * 0.7)) {
      say(`  WARN relay 2 now beats relay 1 (${pct(okRate(second))} / ${med(second)} ms vs ${pct(okRate(first))} / ${med(first)} ms) — consider swapping YT_RELAYS`);
    }
  }

  /* ---------- oEmbed ---------- */
  if (wants('oembed')) {
    say('\noembed');
    const [good, bad] = await page.evaluate(async () => [await H.oembedStatus('m00rvC4CWH8'), await H.oembedStatus('aaaaaaaaaaa')]);
    check(good.status === 200, 'an embeddable video answers 200', JSON.stringify(good));
    check(bad.status >= 400 && bad.status < 500, 'a refusal is readable cross-origin (status, not a network error)', JSON.stringify(bad));
    check(good.title && good.author, "an answer's body is readable cross-origin (title and author_name)", JSON.stringify(good));
  }

  /* ---------- liar ---------- */
  if (wants('liar')) {
    say('\nliar (made-up relay answers, real oEmbed)');
    // The video SPEC 6.1 names; its real title and channel, as YouTube's oEmbed gives them.
    const id = 'm00rvC4CWH8';
    const honest = await answered(
      page.evaluate(
        (vid) => H.withFakeRelay({ title: 'Blessings (KETTAMA Remix)', artist: 'Calvin Harris, Clementine Douglas', durationMs: 280000 }, { videoId: vid, title: 'Calvin Harris, Clementine Douglas - Blessings (KETTAMA Remix - Official Audio)', channel: 'Calvin Harris', length: '4:40', badge: 'BADGE_STYLE_TYPE_VERIFIED_ARTIST' }),
        id,
      ),
      60000,
      'liar honest',
    );
    check(honest.ok && honest.value.videoId === id && honest.oembeds >= 1 && honest.mismatch === 0, 'an honest claim is confirmed by oEmbed and played', JSON.stringify({ ok: honest.ok, err: honest.error, oembeds: honest.oembeds, mismatch: honest.mismatch, score: honest.value && honest.value.score }));
    // The same real video claimed to be an invented song by an invented artist.
    const lie = await answered(
      page.evaluate((vid) => H.withFakeRelay({ title: 'Glass Harbor', artist: 'Mara Vale', durationMs: 280000 }, { videoId: vid, title: 'Mara Vale - Glass Harbor (Official Audio)', channel: 'Mara Vale - Topic', length: '4:40' }), id),
      60000,
      'liar lie',
    );
    check(!lie.ok && lie.error && lie.error.code === 'no-match' && lie.mismatch >= 1, 'a lying claim is refuted by the real oEmbed answer (no match, nothing played)', JSON.stringify({ ok: lie.ok, code: lie.error && lie.error.code, mismatch: lie.mismatch, searches: lie.searches }));
  }

  /* ---------- find ---------- */
  let rows = [];
  if (wants('find') && tracks.length) {
    say(`\nfind (${tracks.length} tracks, one finder, one search at a time)`);
    const out = await answered(
      page.evaluate(async (list) => {
        try {
          localStorage.removeItem(H.youtube.YT_STORAGE_KEY);
        } catch {}
        // Wrap the real network to see every candidate the finder saw (for the report's evidence column).
        const seen = new Map();
        const told = new Map(); // video id → what YouTube's oEmbed says it is
        let requests = 0;
        const fetchText = async (url, opts) => {
          requests++;
          const res = await H.util.request(url, { signal: opts.signal, timeoutMs: opts.timeoutMs, headers: opts.headers, as: 'text', maxBytes: opts.maxBytes });
          if (!/oembed/.test(url)) {
            for (const c of H.youtube.parseYouTubeSearch(res.body)) if (!seen.has(c.videoId)) seen.set(c.videoId, c);
          } else if (res.ok) {
            try {
              const o = JSON.parse(res.body);
              const v = new URL(new URL(url).searchParams.get('url')).searchParams.get('v');
              told.set(v, { title: String(o.title || ''), channel: String(o.author_name || '') });
            } catch {}
          }
          return res;
        };
        const finder = H.youtube.createYouTubeFinder({ fetchText });
        window.F = finder;
        const rows = [];
        for (const t of list) {
          const before = finder.stats();
          const r = await H.timed(() => finder.find(t));
          const after = finder.stats();
          const row = { id: t.id, playlist: t.playlist, title: t.title, artist: t.artist, durationMs: t.durationMs, explicit: !!t.explicit, ms: r.ms, searches: after.searches - before.searches, refuted: after.oembedMismatch - before.oembedMismatch };
          if (r.ok) {
            const m = r.value;
            const c = seen.get(m.videoId);
            const d = c ? H.youtube.scoreVideoDetail(t, c) : null;
            Object.assign(row, {
              ok: true,
              videoId: m.videoId,
              vTitle: m.title,
              channel: m.channel,
              durationS: m.durationS,
              score: m.score,
              alternates: m.alternates.length,
              delta: t.durationMs > 0 && m.durationS ? Math.round((m.durationS - t.durationMs / 1000) * 10) / 10 : null,
              evidence: d ? d.evidence : '?',
              reason: d ? d.reason : '',
              badges: c ? [c.topic && 'topic', c.verifiedArtist && 'artist', !c.verifiedArtist && c.verified && 'verified'].filter(Boolean).join(',') : '',
              // YouTube's own word on the pick and every alternate (what the deck may end up playing)
              told: [m.videoId, ...m.alternates].map((id) => ({ id, ...(told.get(id) || { title: null, channel: null }) })),
            });
          } else Object.assign(row, { ok: false, error: r.error });
          rows.push(row);
        }
        return { rows, stats: finder.stats(), requests };
      }, tracks),
      30 * 60 * 1000,
      'find',
    );
    rows = out.rows;
    const core = rows.filter((r) => CORE.has(r.playlist));
    const matched = rows.filter((r) => r.ok);
    const network = rows.filter((r) => !r.ok && r.error && r.error.code === 'network');
    const rate = matched.length / rows.length;
    const coreRate = core.length ? core.filter((r) => r.ok).length / core.length : 1;
    const scores = matched.map((r) => r.score);
    const ms = rows.map((r) => r.ms);
    const s = out.stats;
    say(`  matched ${matched.length}/${rows.length} = ${pct(rate)}   (no-match ${rows.length - matched.length - network.length}, network ${network.length})`);
    say(`  mean score ${(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)).toFixed(3)}   alternates ${(matched.reduce((a, r) => a + r.alternates, 0) / Math.max(1, matched.length)).toFixed(1)} per track`);
    // Includes waiting for the finder's own budget (SEARCHES_PER_MINUTE): back-to-back finds of a whole
    // playlist hit it once a minute; a set needs one search per song, minutes apart.
    const budget = await page.evaluate(() => H.youtube.SEARCHES_PER_MINUTE);
    say(`  latency per find: median ${quantile(ms, 0.5)} ms, p90 ${quantile(ms, 0.9)} ms, max ${Math.max(...ms)} ms (includes waits for the ${budget} searches/minute budget)`);
    say(`  searches ${s.searches} (${(s.searches / rows.length).toFixed(2)} per track), requests ${out.requests}, oEmbed drops ${s.oembedDropped}, refuted by oEmbed ${s.oembedMismatch} (on ${rows.filter((r) => r.refuted > 0).length} tracks)`);
    for (const [name, r] of Object.entries(s.relay)) say(`  relay ${name.padEnd(8)} ok ${r.ok}  fail ${r.fail}  median ${quantile(r.ms, 0.5) ?? '-'} ms`);
    const byPl = PLAYLISTS.map((pl) => {
      const rs = rows.filter((r) => r.playlist === pl.key);
      return `${pl.key} ${rs.filter((r) => r.ok).length}/${rs.length}`;
    });
    say(`  per playlist: ${byPl.join(', ')}`);
    const evid = {};
    for (const r of matched) evid[r.evidence] = (evid[r.evidence] || 0) + 1;
    say(`  evidence: ${Object.entries(evid).map(([k, v]) => `${k} ${v}`).join(', ')}`);

    // Full table → the report file only.
    note('\nwanted → matched');
    for (const r of rows) {
      const want = `${r.artist} — ${r.title} (${r.durationMs ? Math.round(r.durationMs / 1000) + 's' : '?'})`;
      if (r.ok) note(`  ok   [${r.playlist}] ${want}\n         → ${r.videoId} "${r.vTitle}" | ${r.channel}${r.badges ? ` [${r.badges}]` : ''} | ${r.durationS ?? '?'}s Δ${r.delta ?? '?'} | score ${r.score} | ${r.evidence}${r.reason ? ` | ${r.reason}` : ''} | alts ${r.alternates} | ${r.ms} ms, ${r.searches} search(es)`);
      else note(`  MISS [${r.playlist}] ${want}\n         → ${r.error.code}: ${r.error.message} | ${r.ms} ms, ${r.searches} search(es)`);
    }

    // Uploads oEmbed refuted (their real title / channel did not read as the song): candidates for a
    // scoring gap if a track ended up without a match because of it.
    note('\nrefuted by oEmbed (per track)');
    for (const r of rows.filter((x) => x.refuted > 0)) note(`  ${r.ok ? 'ok  ' : 'MISS'} [${r.playlist}] ${r.artist} — ${r.title}: ${r.refuted} upload(s) refuted`);

    // Live / festival / broadcast recordings, judged by YouTube's own title and channel (independent of the
    // scorer's lists): none may be the pick or an alternate unless the wanted title asks for one.
    const LIVE_WORDS = /\b(?:live (?:at|from|in|on)|en vivo|ao vivo|in concert|glastonbury|coachella|lollapalooza|festival|tiny desk|live lounge|unplugged|hootenanny|later\.{0,3} with jools)\b/i;
    // A broadcaster alone, or leading a channel shared with the artist ("BBC Music and <artist>").
    const BROADCAST = /^(?:bbc music|bbc radio \w+|kexp|npr music|colors|triple j|genius)(?: (?:and|&) .+)?$/i;
    const live = [];
    for (const r of matched) {
      if (LIVE_WORDS.test(r.title)) continue;
      for (const v of r.told || []) if ((v.title && LIVE_WORDS.test(v.title)) || (v.channel && BROADCAST.test(v.channel.trim()))) live.push({ r, v });
    }
    note('\nlive / festival / broadcast uploads among picks and alternates');
    for (const { r, v } of live) note(`  [${r.playlist}] ${r.artist} — ${r.title} → ${v.id} "${v.title}" | ${v.channel}${v.id === r.videoId ? ' (PICK)' : ' (alternate)'}`);
    const unchecked = matched.reduce((n, r) => n + (r.told || []).filter((v) => v.title == null).length, 0);
    say(`  picks + alternates YouTube's oEmbed did not answer for: ${unchecked}`);
    check(!live.length, "no pick or alternate is a live / festival / broadcast recording (by YouTube's own title and channel)", live.length ? `${live.length} — see the report file` : '');

    const suspicious = matched.filter((r) => r.score < 0.75 || (r.delta != null && Math.abs(r.delta) > 8) || /^(none|\?|no artist wanted)$/.test(r.evidence));
    say(`  suspicious (score < 0.75, |Δ| > 8 s or no artist evidence): ${suspicious.length}`);
    for (const r of suspicious.slice(0, 12)) say(`    ${shy(r, r.title)} → ${shy(r, r.vTitle, 44)} | ${clip(r.channel, 24)} | Δ${r.delta}s | ${r.score} | ${r.evidence}`);
    const misses = rows.filter((r) => !r.ok);
    if (misses.length) say(`  misses: ${misses.map((r) => `${shy(r, r.title, 28)} (${r.error.code})`).join('; ')}`);

    const want = Math.min(MIN_TRACKS, PER * PLAYLISTS.length - 4);
    check(rows.length >= want, `ran on at least ${want} tracks`, `${rows.length}`);
    if (core.length) check(coreRate >= MIN_MATCH_RATE, `match rate ≥ ${pct(MIN_MATCH_RATE)} on the mainstream playlists`, `${pct(coreRate)} of ${core.length}`);
    if (core.length < rows.length) say(`  older catalogue (outside the bar): ${pct((matched.length - core.filter((r) => r.ok).length) / (rows.length - core.length))} of ${rows.length - core.length}`);
    check(network.length <= Math.ceil(rows.length * 0.05), 'network failures ≤ 5 %', `${network.length}`);
    check(matched.every((r) => r.score >= 0.7 && /^[A-Za-z0-9_-]{11}$/.test(r.videoId)), 'every match is a valid id at or above the accept score');
  }

  /* ---------- cache ---------- */
  if (wants('cache') && rows.some((r) => r.ok)) {
    say('\ncache');
    const sample = tracks.filter((t) => rows.find((r) => r.id === t.id && r.ok)).slice(0, 8);
    const out = await page.evaluate(async (list) => {
      // A new visit: searching is an error; YouTube's oEmbed (the once-per-visit re-check of each stored
      // upload) goes to the real network and is counted.
      let searches = 0;
      let oembeds = 0;
      const fetchText = async (url, opts) => {
        if (!/^https:\/\/www\.youtube\.com\/oembed/.test(url)) {
          searches++;
          throw new Error('the cache should have answered');
        }
        oembeds++;
        return H.util.request(url, { signal: opts.signal, timeoutMs: opts.timeoutMs, as: 'text', maxBytes: opts.maxBytes });
      };
      const fresh = H.youtube.createYouTubeFinder({ fetchText });
      const res = [];
      for (const t of list) res.push(await H.timed(() => fresh.find(t)));
      const firstOembeds = oembeds;
      const again = [];
      for (const t of list) again.push(await H.timed(() => fresh.find(t)));
      const stored = JSON.parse(localStorage.getItem(H.youtube.YT_STORAGE_KEY) || '{}');
      const rec = Object.values(stored)[0] || {};
      const uploads = list.reduce((n, t, i) => n + (res[i].ok ? 1 + res[i].value.alternates.length : 0), 0);
      return { res, again, searches, firstOembeds, oembeds, uploads, stats: fresh.stats(), entries: Object.keys(stored).length, recKeys: Object.keys(rec).sort() };
    }, sample);
    const ids = sample.map((t) => rows.find((r) => r.id === t.id).videoId);
    check(out.searches === 0 && out.res.every((r) => r.ok), `${sample.length} finds answered from localStorage by a new finder, no searches`, `searches ${out.searches}`);
    check(out.firstOembeds <= sample.length * 5, 'one oEmbed look per stored upload (pick + up to 4 alternates), once per visit', `${out.firstOembeds} for ${sample.length} tracks`);
    check(out.res.every((r, i) => r.value && r.value.videoId === ids[i]), 'the same videos come back');
    check(out.res.every((r) => r.ms < 6000), 'each in < 6 s (a parallel oEmbed round trip)', `max ${Math.max(...out.res.map((r) => r.ms))} ms`);
    check(out.oembeds === out.firstOembeds && out.again.every((r, i) => r.ok && r.value.videoId === out.res[i].value.videoId), 'asked again in the same visit: no request at all');
    check(out.again.every((r) => r.ms < 50), 'each in < 50 ms the second time', `max ${Math.max(...out.again.map((r) => r.ms))} ms`);
    check(['alternates', 'alts', 'b', 't', 'videoId'].every((k) => out.recKeys.includes(k)), `records carry {videoId, alternates, alts, b, t}`, out.recKeys.join(','));
    say(`  ${out.entries} entries stored under 'segue:yt:v1'`);
  }

  /* ---------- hostile ---------- */
  if (wants('hostile')) {
    say('\nhostile');
    const r = await answered(
      page.evaluate(() => {
        const M = 'ytInitial' + 'Data';
        const n = 2.5 * 1024 * 1024;
        const inputs = [M + ' = ' + '{'.repeat(n), (M + ' = {"a":').repeat(n / 16), '<script>' + M + ' = {"x":"' + '}'.repeat(n) + '"', JSON.stringify({ result: { script: [M + ' = ' + '['.repeat(n)] } })];
        return H.frozenDuring(() => inputs.map((s) => H.youtube.parseYouTubeSearch(s).length));
      }),
      30000,
      'hostile',
    );
    check(r.out.every((x) => x === 0), 'hostile relay answers give no candidates');
    check(r.worst < 1500, 'the page stays responsive (4 × 2.5 MB)', `longest freeze ${r.worst} ms`);
  }

  const csp = errors.filter((e) => /Content Security Policy|Refused to/i.test(e));
  check(!csp.length, 'nothing blocked by the production CSP', csp.slice(0, 2).join(' | '));
} catch (err) {
  failed++;
  say(`FAIL ${err && err.stack ? err.stack : err}`);
} finally {
  await close();
  await srv.close();
}

say(`\n${passed} passed, ${failed} failed`);
try {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report.join('\n') + '\n');
  console.log(`full table: ${reportPath}`);
} catch (err) {
  console.log(`could not write the report: ${err.message}`);
}
process.exit(failed ? 1 : 0);

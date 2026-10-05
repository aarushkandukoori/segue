// Sources e2e: drives tests/e2e/sources-harness.html in headless Chrome from a localhost origin
// against the REAL services (Spotify embed via the relays, Deezer via JSONP, iTunes, the audio CDNs).
//
//   node tests/e2e/sources.e2e.mjs                 every group
//   node tests/e2e/sources.e2e.mjs chain resolve   only these groups
//   node tests/e2e/sources.e2e.mjs --no-microlink  skip the relay with a 25-requests/day quota
//   node tests/e2e/sources.e2e.mjs resolve --full  resolve EVERY track of every playlist (minutes; scorer audit)
//   node tests/e2e/sources.e2e.mjs resolve --full --only=tokyo,kpop   …of just these playlists (keys below)
//
// Groups: relays chain outage notfound examples demos deezer resolve audio expiry local jsonp hostile slow
//   hostile  answers built to freeze the page (a title of stars, relay bodies that are huge or slow to
//            parse): the main thread must stay responsive. Mostly in-page fakes, one real download.
//   slow     real previews over a really slow line (a second Chrome behind a throttling proxy, so the
//            CDN's own ordering of parallel responses shows), two at once: neither may be cut off
//            and restarted. Takes about a minute.
// Prints a short report (counts, timings, suspicious matches) and writes the full "wanted → matched"
// table to tests/fixtures/sources-report.txt (git-ignored). Exit code 0 = pass. Skips (exit 0) when
// Chrome or the network is unavailable.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`sources e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}
const online = await fetch('https://api.deezer.com/infos', { signal: AbortSignal.timeout(8000) }).then(
  (r) => r.ok,
  () => false,
);
if (!online) {
  console.log('sources e2e: SKIPPED, no network (api.deezer.com unreachable)');
  process.exit(0);
}

const GROUPS = ['relays', 'chain', 'outage', 'notfound', 'examples', 'demos', 'deezer', 'resolve', 'audio', 'expiry', 'local', 'jsonp', 'hostile', 'slow'];
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const only = args.filter((a) => !a.startsWith('--'));
const unknown = only.filter((g) => !GROUPS.includes(g));
if (unknown.length) {
  console.error(`unknown group(s): ${unknown.join(', ')} (have: ${GROUPS.join(' ')})`);
  process.exit(2);
}
const wants = (g) => !only.length || only.includes(g);
// --only=tokyo,kpop restricts the Spotify playlists used by the chain / resolve groups (scorer audits).
const onlyKeys = ([...flags].find((f) => f.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const picked = (pl) => !onlyKeys.length || onlyKeys.includes(pl.key);

/** Real public playlists: different genres, eras and languages. `mainstream` ones carry the ≥ 90 % match-rate bar. */
const SPOTIFY = [
  { key: 'tth', id: '37i9dQZF1DXcBWIGoYBM5M', what: "Today's Top Hits (current pop)", mainstream: true },
  { key: 'mint', id: '37i9dQZF1DX4dyzvuaRJ0n', what: 'mint (dance / house)', mainstream: true },
  { key: 'rapcaviar', id: '37i9dQZF1DX0XUsuxWHRQd', what: 'RapCaviar (hip-hop)', mainstream: true },
  { key: 'allout00', id: '37i9dQZF1DX4o1oenSJRJd', what: 'All Out 2000s (throwback)', mainstream: true, total: 150 },
  { key: 'rock', id: '37i9dQZF1DWXRqgorJj26U', what: 'Rock Classics (60s-80s, remasters)', mainstream: true, total: 200 },
  { key: 'viva', id: '37i9dQZF1DX10zKzsJ2jva', what: 'Viva Latino (Spanish)', mainstream: true },
  { key: 'kpop', id: '37i9dQZF1DX9tPFwDMOaN1', what: 'K-Pop ON! (Korean)' },
  { key: 'tokyo', id: '37i9dQZF1DXafb0IuPwJyF', what: 'Tokyo Super Hits (Japanese)' },
  { key: 'hindi', id: '37i9dQZF1DX0XUfTFmNBRM', what: 'Hot Hits Hindi' },
  { key: 'lofi', id: '0vvXsWCC9xrXsKd4FyS8kM', what: 'Lofi Girl (user playlist, 500 tracks)', total: 500, noResolve: true },
];
const ALBUM = { key: 'album', id: '2noRn2Aes5aoNVsU6iWThc', what: 'album (Daft Punk, Discovery)' };
const MISSING = '37i9dQZF1DXcBWIGoYBM5X'; // well-formed id that does not exist
const PER_PLAYLIST = { mainstream: 14, other: 8 };

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = resolve(here, '../fixtures/sources-report.txt');
const report = [`Segue sources e2e — ${new Date().toISOString()}`, ''];
let failed = 0;
let passed = 0;
let warned = 0;
const say = (line = '') => {
  console.log(line);
  report.push(line);
};
const check = (ok, name, detail = '') => {
  if (ok) passed++;
  else failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
};
const warn = (name, detail = '') => {
  warned++;
  say(`  WARN ${name}${detail ? `  — ${detail}` : ''}`);
};
const pad = (s, n) => String(s).padEnd(n);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
/** Titles of explicit tracks are not echoed to the console (the full text is in the report file). */
const shy = (row, text) => (row.explicit ? `[explicit, ${String(text).length} chars]` : clip(text, 38));

/**
 * Wait for something the page is doing, but not for ever: a main thread stuck in one pattern match
 * never answers, and without this the whole run would hang with it instead of failing.
 */
const answered = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: the page did not answer within ${ms / 1000} s — its main thread is stuck`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/**
 * A slow line: an HTTP CONNECT proxy on localhost whose server → browser bytes, over all tunnels
 * together, pass through one token bucket. It sits below TLS and HTTP/2, so the browser and the CDN
 * behave as they do on a slow connection — DevTools throttling does not show that: it paces each
 * response separately inside the browser, after the network has delivered them all in parallel.
 * `setRate(bytesPerSecond)`; Infinity = not throttled.
 */
async function slowLine() {
  let rate = Infinity;
  let budget = 0;
  const queue = []; // {client, chunk, up}: one chunk per tunnel at a time, the rest waits in the kernel
  const sockets = new Set();
  const TICK = 50;
  const pump = setInterval(() => {
    if (rate === Infinity) budget = Infinity;
    else budget = Math.min(budget + (rate * TICK) / 1000, (rate * TICK * 2) / 1000);
    while (queue.length && budget > 0) {
      const item = queue[0];
      const n = Math.min(Math.ceil(budget), item.chunk.length);
      if (!item.client.destroyed) item.client.write(item.chunk.subarray(0, n));
      budget -= n;
      if (n < item.chunk.length) item.chunk = item.chunk.subarray(n);
      else {
        queue.shift();
        item.up.resume();
      }
    }
  }, TICK);
  const proxy = http.createServer((req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client, head) => {
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port) || 443, host);
    sockets.add(client).add(up);
    const drop = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    up.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      client.pipe(up); // browser → server is not throttled
      up.on('data', (chunk) => {
        up.pause();
        queue.push({ client, chunk, up });
      });
    });
    up.on('error', drop);
    client.on('error', drop);
    up.on('close', drop);
    client.on('close', drop);
  });
  await new Promise((ready) => proxy.listen(0, '127.0.0.1', ready));
  return {
    port: proxy.address().port,
    setRate: (bytesPerSecond) => {
      rate = bytesPerSecond;
      budget = 0;
    },
    close: async () => {
      clearInterval(pump);
      for (const sock of sockets) sock.destroy();
      await new Promise((done) => proxy.close(() => done()));
    },
  };
}

/** A second Chrome whose every request (except to localhost) goes through `proxyPort`. */
async function launchBehind(proxyPort) {
  const profile = await mkdtemp(join(tmpdir(), 'segue-chrome-slow-'));
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    userDataDir: profile,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-background-networking', '--disable-component-update', '--disable-sync', `--proxy-server=http://127.0.0.1:${proxyPort}`],
  });
  const tab = await browser.newPage();
  const failed = [];
  tab.on('requestfailed', (req) => failed.push(`${req.url()} ${req.failure()?.errorText || ''}`));
  return {
    page: tab,
    failed,
    close: async () => {
      await browser.close().catch(() => {});
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const srv = await startServer();
const { page, errors, logs, close } = await launch({ width: 1000, height: 700 });
const timings = [];

try {
  await page.goto(`${srv.url}/tests/e2e/sources-harness.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.harnessReady === true', { timeout: 15000 });
  await page.evaluate(() => {
    window.PL = {};
    window.REFS = [];
  });
  say(`origin ${srv.url} · ${await page.evaluate(() => navigator.userAgent.replace(/^.*(HeadlessChrome\/[\d.]+).*$/, '$1'))}`);

  /* ---------------------------------------------------------------- relays */
  if (wants('relays')) {
    say('\nrelays — each one alone, against a real playlist (browser origin, so CORS counts)');
    const names = await page.evaluate(() => window.H.spotify.RELAYS.map((r) => r.name));
    let healthy = 0;
    for (let i = 0; i < names.length; i++) {
      if (names[i] === 'microlink' && flags.has('--no-microlink')) {
        say('  skip microlink (--no-microlink)');
        continue;
      }
      const r = await page.evaluate(
        (i, id) => window.H.timed(async () => {
          const res = await window.H.spotify.tryRelay(window.H.spotify.RELAYS[i], { type: 'playlist', id });
          return { kind: res.kind, reason: res.reason, n: res.playlist ? res.playlist.tracks.length : 0, title: res.playlist && res.playlist.title, problems: res.playlist ? window.H.checkPlaylist(res.playlist, { source: 'spotify', trackId: /^spotify:track:[A-Za-z0-9]{22}$/ }) : [] };
        }),
        i,
        SPOTIFY[0].id,
      );
      const v = r.value || {};
      const ok = r.ok && v.kind === 'playlist' && v.n >= 20 && !v.problems.length;
      if (ok) healthy++;
      timings.push([`relay ${i + 1} (${names[i]})`, r.ms]);
      const detail = ok ? `${v.n} tracks, ${r.ms} ms` : `${v.kind || 'threw'} ${v.reason || (r.error && r.error.message) || ''} ${(v.problems || []).join('; ')} (${r.ms} ms)`;
      // One relay being down is what the chain exists for; it is reported, and fails the run only if
      // fewer than two of the three are usable.
      if (ok) check(true, `relay ${i + 1} ${names[i]}`, detail);
      else warn(`relay ${i + 1} ${names[i]} is not usable right now`, detail);
    }
    const md = await page.evaluate(
      (id) => window.H.timed(async () => {
        const res = await window.H.spotify.tryMarkdown({ type: 'playlist', id });
        return { kind: res.kind, reason: res.reason, n: res.playlist ? res.playlist.tracks.length : 0, withDuration: res.playlist ? res.playlist.tracks.filter((t) => t.durationMs > 0).length : 0, withArtist: res.playlist ? res.playlist.tracks.filter((t) => t.artist && t.artist !== 'Unknown artist').length : 0 };
      }),
      SPOTIFY[0].id,
    );
    timings.push(['markdown fallback (jina)', md.ms]);
    const mv = md.value || {};
    if (md.ok && mv.kind === 'playlist' && mv.n >= 20) {
      check(mv.withArtist >= mv.n * 0.9 && mv.withDuration >= mv.n * 0.9, 'markdown fallback parses the live page', `${mv.n} tracks, ${mv.withArtist} with artist, ${mv.withDuration} with duration, ${md.ms} ms`);
    } else warn('markdown fallback is not usable right now', `${mv.kind || 'threw'} ${mv.reason || ''} (${md.ms} ms)`);
    const expected = flags.has('--no-microlink') ? 1 : 2;
    check(healthy >= expected, `at least ${expected} relay(s) healthy`, `${healthy} healthy`);
  }

  /* ---------------------------------------------------------------- chain */
  const loadInPage = (input, key, source = 'spotify') =>
    page.evaluate(
      (input, key, source) =>
        window.H.timed(async () => {
          const statuses = [];
          const p = await window.H.index.loadPlaylist(input, { onStatus: (m) => statuses.push(m) });
          if (key) window.PL[key] = p;
          const trackId = source === 'spotify' ? /^spotify:track:[A-Za-z0-9]{22}$/ : /^deezer:\d+$/;
          return {
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            n: p.tracks.length,
            total: p.total,
            statuses,
            artwork: !!p.artwork,
            link: p.link,
            withDuration: p.tracks.filter((t) => t.durationMs > 0).length,
            withPreview: p.tracks.filter((t) => t.preview).length,
            withLink: p.tracks.filter((t) => t.link).length,
            problems: window.H.checkPlaylist(p, { source, trackId }),
          };
        }),
      input,
      key,
      source,
    );

  if (wants('chain') || wants('resolve') || wants('audio')) {
    say('\nchain — loadPlaylist() through the relay chain, real public playlists');
    for (const pl of SPOTIFY.filter(picked)) {
      // Real-world link shape: locale prefix + share token.
      const r = await loadInPage(`https://open.spotify.com/intl-de/playlist/${pl.id}?si=0123456789abcdef`, pl.key);
      const v = r.value || {};
      timings.push([`spotify playlist: ${pl.what}`, r.ms]);
      let ok = r.ok && v.n >= 10 && !v.problems.length && v.id === `spotify:playlist:${pl.id}` && v.artwork && v.withDuration === v.n && v.withLink === v.n && v.statuses[0] === 'Reading playlist from Spotify…';
      if (ok && pl.total) ok = v.n === 100 && v.total >= pl.total * 0.8 && v.total <= pl.total * 1.25;
      if (ok && !pl.total) ok = v.total === undefined || v.total > v.n;
      check(ok, pad(pl.what, 40), r.ok ? `"${clip(v.title, 28)}" ${v.n} tracks${v.total ? ` of ${v.total}` : ''}, ${r.ms} ms${v.problems.length ? ` · ${v.problems.slice(0, 3).join('; ')}` : ''}` : `${r.error.code}: ${r.error.message} [${r.error.detail}] (${r.ms} ms)`);
    }
    const a = picked(ALBUM) ? await loadInPage(`spotify:album:${ALBUM.id}`, ALBUM.key) : null;
    if (a) {
    timings.push([`spotify ${ALBUM.what}`, a.ms]);
    const av = a.value || {};
    check(a.ok && av.n >= 8 && !av.problems.length && av.id === `spotify:album:${ALBUM.id}` && av.statuses[0] === 'Reading album from Spotify…', pad(ALBUM.what, 40), a.ok ? `"${clip(av.title, 28)}" by ${clip(av.subtitle, 20)}, ${av.n} tracks, ${a.ms} ms${av.problems.length ? ` · ${av.problems.join('; ')}` : ''}` : `${a.error.code}: ${a.error.message} (${a.ms} ms)`);
    const albumArt = await page.evaluate((k) => window.PL[k] && window.PL[k].tracks.every((t) => t.artwork && t.artwork === window.PL[k].artwork), ALBUM.key);
    check(albumArt, 'album tracks carry the album cover');
    }
  }

  /* ---------------------------------------------------------------- outage */
  if (wants('outage')) {
    say('\noutage — real services, with relays knocked out one layer at a time');
    const scenario = (blocked) =>
      page.evaluate(
        (blocked, id) =>
          window.H.timed(async () => {
            const asked = [];
            const fetchImpl = (url, init = {}) => {
              const html = init.headers && init.headers['X-Return-Format'] === 'html';
              const who = url.startsWith('https://web.scraper.workers.dev') ? 'scraper' : url.startsWith('https://api.microlink.io') ? 'microlink' : url.startsWith('https://r.jina.ai') ? (html ? 'jina' : 'markdown') : url.startsWith('https://open.spotify.com/oembed') ? 'oembed' : 'other';
              asked.push(who);
              if (blocked.includes(who)) return Promise.reject(new TypeError('blocked by test'));
              return fetch(url, init);
            };
            const statuses = [];
            const p = await window.H.spotify.loadSpotify({ type: 'playlist', id }, { fetchImpl, onStatus: (m) => statuses.push(m) });
            return { n: p.tracks.length, ids: p.tracks.filter((t) => /^spotify:track:/.test(t.id)).length, md: p.tracks.filter((t) => /^spotify:md:/.test(t.id)).length, title: p.title, artwork: !!p.artwork, asked, statuses, problems: window.H.checkPlaylist(p, { source: 'spotify', trackId: /^spotify:(?:track:[A-Za-z0-9]{22}|md:\d+)$/ }) };
          }),
        blocked,
        SPOTIFY[0].id,
      );
    const a = await scenario(['scraper']);
    timings.push(['spotify, relay 1 down → relay 2', a.ms]);
    check(a.ok && a.value.ids >= 20 && !a.value.problems.length && a.value.asked.includes('jina') && !a.value.asked.includes('microlink'), 'relay 1 down → relay 2 (jina, HTML) answers', a.ok ? `${a.value.n} tracks, ${a.ms} ms, asked ${a.value.asked.join('→')}` : `${a.error.code}: ${a.error.message} [${a.error.detail}]`);
    const b = await scenario(['scraper', 'jina', 'microlink']);
    timings.push(['spotify, relays 1-3 down → markdown', b.ms]);
    check(b.ok && b.value.md >= 20 && !b.value.problems.length && b.value.artwork, 'relays 1-3 down → markdown parse answers (titles, no track ids)', b.ok ? `${b.value.n} tracks, "${clip(b.value.title, 24)}", cover ${b.value.artwork}, ${b.ms} ms` : `${b.error.code}: ${b.error.message} [${b.error.detail}]`);
    const c = await scenario(['scraper', 'jina', 'microlink', 'markdown', 'oembed']);
    timings.push(['spotify, everything down → error', c.ms]);
    check(!c.ok && c.error.code === 'unreachable' && /Couldn't reach Spotify/.test(c.error.message) && c.ms < 3000, 'everything down → "Couldn\'t reach Spotify", promptly', `${c.ok ? 'unexpectedly loaded' : `${c.error.code}: ${c.error.message}`} (${c.ms} ms)`);
    // Cancelling mid-flight really cancels.
    const ab = await page.evaluate(
      (id) =>
        window.H.timed(async () => {
          const ctrl = new AbortController();
          const p = window.H.index.loadPlaylist(`spotify:playlist:${id}`, { signal: ctrl.signal });
          setTimeout(() => ctrl.abort(), 30);
          await p;
        }),
      SPOTIFY[1].id,
    );
    check(!ab.ok && ab.error.name === 'AbortError' && ab.ms < 1000, 'AbortSignal cancels a load in flight', `${ab.ok ? 'completed' : ab.error.name} after ${ab.ms} ms`);
  }

  /* ---------------------------------------------------------------- not found */
  if (wants('notfound')) {
    say('\nnot found — a playlist id that does not exist');
    for (const input of [`https://open.spotify.com/playlist/${MISSING}`, 'spotify:album:0000000000000000000000']) {
      const r = await loadInPage(input, null);
      timings.push([`spotify not-found (${input.includes('album') ? 'album' : 'playlist'})`, r.ms]);
      check(!r.ok && r.error.name === 'SourceError' && r.error.code === 'not-found' && /private or doesn't exist/.test(r.error.message) && r.ms < 8000, `friendly error, quickly: ${clip(input, 44)}`, r.ok ? `unexpectedly loaded ${r.value.n} tracks` : `${r.error.code}: "${clip(r.error.message, 60)}" (${r.ms} ms)`);
    }
    for (const [input, reason] of [
      ['https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl', /single song/],
      ['https://spotify.link/AbCdEfGhIj', /Short spotify\.link/],
      ['https://music.apple.com/us/playlist/x/pl.abc', /Apple Music/],
    ]) {
      const r = await loadInPage(input, null);
      check(!r.ok && r.error.code === 'unsupported' && reason.test(r.error.message) && r.ms < 50, `unsupported link explains itself: ${clip(input, 40)}`, r.ok ? 'loaded?!' : `"${clip(r.error.message, 60)}" (${r.ms} ms)`);
    }
  }

  /* ---------------------------------------------------------------- examples */
  if (wants('examples')) {
    say('\nexamples — every EXAMPLES entry loads today');
    const examples = await page.evaluate(() => window.H.index.EXAMPLES);
    check(examples.length >= 4 && examples.length <= 6, 'EXAMPLES has 4-6 entries', String(examples.length));
    for (const ex of examples) {
      const r = await loadInPage(ex.url, null);
      timings.push([`example: ${ex.label}`, r.ms]);
      check(r.ok && r.value.n >= 30 && !r.value.problems.length, pad(ex.label, 22), r.ok ? `"${clip(r.value.title, 28)}" ${r.value.n} tracks${r.value.total ? ` of ${r.value.total}` : ''}, ${r.ms} ms` : `${r.error.code}: ${r.error.message} (${r.ms} ms)`);
    }
  }

  /* ---------------------------------------------------------------- demos */
  if (wants('demos') || wants('audio')) {
    say('\ndemos — every DEMOS chart, straight from Deezer over JSONP');
    const demos = await page.evaluate(() => window.H.index.DEMOS);
    check(demos.length >= 6 && demos.length <= 8 && demos.every((d) => d.id && d.label && d.emoji && /^deezer:chart:\d+$/.test(d.input)), 'DEMOS has 6-8 well-formed entries', String(demos.length));
    for (const d of demos) {
      const r = await loadInPage(d.input, `demo:${d.id}`, 'deezer');
      timings.push([`deezer chart: ${d.label}`, r.ms]);
      const v = r.value || {};
      check(r.ok && v.n >= 50 && v.withPreview === v.n && !v.problems.length && v.id === d.input && v.artwork, pad(`${d.label} (${d.input})`, 34), r.ok ? `"${clip(v.title, 24)}" ${v.n} tracks, all with previews, ${r.ms} ms${v.problems.length ? ` · ${v.problems.slice(0, 3).join('; ')}` : ''}` : `${r.error.code}: ${r.error.message} (${r.ms} ms)`);
    }
  }

  /* ---------------------------------------------------------------- deezer links */
  if (wants('deezer')) {
    say('\ndeezer — playlist / album links and errors over JSONP');
    const cases = [
      ['https://www.deezer.com/us/playlist/3155776842', 'playlist link', (v) => v.n >= 50 && v.id === 'deezer:playlist:3155776842'],
      ['https://www.deezer.com/en/album/302127', 'album link', (v) => v.n >= 10 && v.id === 'deezer:album:302127'],
      ['deezer:playlist:10064140302', 'long playlist (>100 tracks)', (v) => v.n > 100 && v.n <= 200],
    ];
    for (const [input, name, good] of cases) {
      const r = await loadInPage(input, null, 'deezer');
      timings.push([`deezer ${name}`, r.ms]);
      const v = r.value || {};
      if (!r.ok && name.startsWith('long') && r.error.code === 'not-found') {
        warn(`${name}: that playlist is gone`, input);
        continue;
      }
      check(r.ok && good(v) && v.withPreview === v.n && !v.problems.length, pad(name, 30), r.ok ? `"${clip(v.title, 24)}" ${v.n} tracks${v.total ? ` of ${v.total}` : ''}, ${r.ms} ms${v.problems.length ? ` · ${v.problems.slice(0, 3).join('; ')}` : ''}` : `${r.error.code}: ${r.error.message} (${r.ms} ms)`);
    }
    const nf = await loadInPage('https://www.deezer.com/playlist/99999999999999', null, 'deezer');
    timings.push(['deezer not-found', nf.ms]);
    check(!nf.ok && nf.error.code === 'not-found' && /private or doesn't exist/.test(nf.error.message) && nf.ms < 5000, 'missing Deezer playlist → friendly error', nf.ok ? 'loaded?!' : `"${nf.error.message}" (${nf.ms} ms)`);
  }

  /* ---------------------------------------------------------------- resolve */
  const rows = [];
  if (wants('resolve') || wants('audio')) {
    say('\nresolve — Spotify tracks → Deezer / iTunes previews (the shared resolver, 4 at a time)');
    for (const pl of [...SPOTIFY, ALBUM].filter(picked)) {
      if (pl.noResolve) continue;
      const size = await page.evaluate((key) => (window.PL[key] ? window.PL[key].tracks.length : 0), pl.key);
      // Default: an evenly spaced sample. --full: every track (slow, and hard on the iTunes quota).
      const want = flags.has('--full') ? size : Math.min(size, pl.mainstream ? PER_PLAYLIST.mainstream : PER_PLAYLIST.other);
      const stride = Math.max(1, Math.floor(size / Math.max(1, want)));
      const indices = Array.from({ length: size }, (_, i) => i).filter((i) => i % stride === 0).slice(0, want);
      let out = size ? [] : null;
      for (let at = 0; at < indices.length; at += 16) {
        const chunk = await page.evaluate(
          async (key, picksAt) => {
            const p = window.PL[key];
            const picks = picksAt.map((i) => p.tracks[i]);
            const results = new Array(picks.length);
            let next = 0;
            const worker = async () => {
              for (;;) {
                const i = next++;
                if (i >= picks.length) return;
                const t = picks[i];
                const r = await window.H.timed(() => window.H.shared.resolveTrack(t));
                const row = { title: t.title, artist: t.artist, durationMs: t.durationMs, explicit: !!t.explicit, ms: r.ms, ok: r.ok };
                if (r.ok) {
                  const ref = r.value;
                  window.REFS.push({ key, ref, track: t });
                  const d = window.H.match.scoreCandidate({ title: t.title, artist: t.artist, durationMs: t.durationMs }, { title: ref.matchedTitle, artist: ref.matchedArtist, durationMs: ref.matchedDurationMs });
                  Object.assign(row, { provider: ref.provider, score: ref.matchScore, mTitle: ref.matchedTitle, mArtist: ref.matchedArtist, mDurationMs: ref.matchedDurationMs, https: /^https:\/\//.test(ref.url) && (!ref.artwork || /^https:\/\//.test(ref.artwork)) && (!ref.link || /^https:\/\//.test(ref.link)), isPreview: ref.isPreview, refKey: ref.key, tSim: d.title, aSim: d.artist, reason: d.reason });
                } else Object.assign(row, { code: r.error.code, final: r.error.final, message: r.error.message });
                results[i] = row;
              }
            };
            await Promise.all([worker(), worker(), worker(), worker()]);
            return results;
          },
          pl.key,
          indices.slice(at, at + 16),
        );
        out.push(...chunk);
      }
      if (!out) {
        warn(`${pl.what}: not loaded, nothing to resolve`);
        continue;
      }
      for (const r of out) rows.push({ ...r, playlist: pl.key, mainstream: !!pl.mainstream });
      const hit = out.filter((r) => r.ok);
      say(`  ${pad(pl.what, 38)} ${hit.length}/${out.length} matched · deezer ${hit.filter((r) => r.provider === 'deezer').length} · itunes ${hit.filter((r) => r.provider === 'itunes').length} · mean score ${(hit.reduce((s, r) => s + r.score, 0) / Math.max(1, hit.length)).toFixed(3)}`);
    }

    const gap = (r) => (r.ok && r.durationMs && r.mDurationMs ? Math.abs(r.durationMs - r.mDurationMs) / 1000 : 0);
    const suspicious = (r) => !r.ok || r.score < 0.95 || gap(r) > 4 || r.tSim < 0.97 || r.aSim === 0 || !!r.reason;
    const main = rows.filter((r) => r.mainstream);
    const hits = rows.filter((r) => r.ok);
    const mainHits = main.filter((r) => r.ok);
    const rate = (a, b) => (b.length ? (100 * a.length) / b.length : 0);
    const mean = hits.reduce((s, r) => s + r.score, 0) / Math.max(1, hits.length);
    const sortedMs = rows.map((r) => r.ms).sort((a, b) => a - b);
    const stats = await page.evaluate(() => window.H.shared.stats());

    // Full table → report file only.
    report.push('', 'wanted → matched (full table)', '');
    for (const r of rows) {
      report.push(
        `${pad(r.playlist, 10)} ${r.ok ? `${r.score.toFixed(3)} ${pad(r.provider, 6)}` : `MISS ${pad(r.code + (r.final === false ? '*' : ''), 7)}`} ${suspicious(r) ? '?' : ' '} ${pad(clip(`${r.artist} — ${r.title}`, 62), 62)} ${r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '  -'}  →  ${r.ok ? `${clip(`${r.mArtist} — ${r.mTitle}`, 62)} ${r.mDurationMs ? `${Math.round(r.mDurationMs / 1000)}s` : '-'}${r.reason ? `  [${r.reason}]` : ''}` : r.message}`,
      );
    }
    report.push('');

    say(`\n  tracks tried ${rows.length} · matched ${hits.length} (${rate(hits, rows).toFixed(1)} %) · mainstream ${mainHits.length}/${main.length} (${rate(mainHits, main).toFixed(1)} %)`);
    say(`  mean matchScore ${mean.toFixed(3)} · providers: deezer ${hits.filter((r) => r.provider === 'deezer').length}, itunes ${hits.filter((r) => r.provider === 'itunes').length} · resolve time median ${sortedMs[Math.floor(sortedMs.length / 2)]} ms, p90 ${sortedMs[Math.floor(sortedMs.length * 0.9)]} ms`);
    say(`  catalogue requests ${stats.requests} (${(stats.requests / Math.max(1, rows.length)).toFixed(2)} per track) · artist:"…" filter ${stats.preciseEnabled ? 'in use' : 'switched off (returned nothing)'}`);
    timings.push(['resolveTrack (median)', sortedMs[Math.floor(sortedMs.length / 2)]]);

    const odd = rows.filter(suspicious);
    say(`  rows worth a look: ${odd.length} (full table in ${reportPath.replace(resolve(here, '../..') + '/', '')})`);
    for (const r of odd.slice(0, flags.has('--full') ? 200 : 60)) {
      say(
        r.ok
          ? `    ? ${pad(r.playlist, 9)} ${r.score.toFixed(2)} ${pad(r.provider, 6)} ${shy(r, `${r.artist} — ${r.title}`)}  →  ${shy(r, `${r.mArtist} — ${r.mTitle}`)}  (title ${r.tSim.toFixed(2)}, artist ${r.aSim ?? '-'}, Δ${gap(r).toFixed(1)}s${r.reason ? `, ${r.reason}` : ''})`
          : `    - ${pad(r.playlist, 9)} MISS ${pad(r.code + (r.final === false ? ' (not final)' : ''), 9)} ${shy(r, `${r.artist} — ${r.title}`)}`,
      );
    }

    check(rows.length >= 40, 'at least 40 tracks resolved against the real catalogues', String(rows.length));
    check(rate(mainHits, main) >= 90, 'match rate on mainstream playlists ≥ 90 %', `${rate(mainHits, main).toFixed(1)} %`);
    check(mean >= 0.9, 'mean matchScore ≥ 0.9', mean.toFixed(3));
    check(hits.every((r) => r.https && r.isPreview && /^(deezer|itunes):\d+$/.test(r.refKey) && r.score >= 0.7 && r.score <= 1), 'every AudioRef is well-formed (https URLs, key, score in range)');
    check(rows.every((r) => r.ok || r.code === 'no-match'), 'misses are typed ResolveError("no-match")', rows.filter((r) => !r.ok && r.code !== 'no-match').map((r) => r.code).join(','));
    // Guard against the scorer letting a different recording through: an accepted match never differs
    // in title words, and never has an artist in common with nobody (outside the cross-script rule).
    const wrongish = hits.filter((r) => (r.tSim < 0.9 || r.aSim === 0) && !/translit/.test(r.reason || ''));
    check(wrongish.length === 0, 'no accepted match with a different title or artist', `${wrongish.length}`);
  }

  /* ---------------------------------------------------------------- audio */
  if (wants('audio')) {
    say('\naudio — fetchAudio() + decodeAudioData()');
    const out = await page.evaluate(async () => {
      const H = window.H;
      const results = [];
      const run = async (label, ref) => {
        const r = await H.timed(async () => {
          const bytes = await H.shared.fetchAudio(ref);
          const info = await H.decode(bytes);
          return { bytes: bytes.byteLength, isBuffer: bytes instanceof ArrayBuffer, ...info };
        });
        results.push({ label, provider: ref.provider, ...r });
      };
      // Deezer refs found by search, spread over the playlists.
      const searched = window.REFS.filter((x) => x.ref.provider === 'deezer');
      const step = Math.max(1, Math.floor(searched.length / 5));
      for (const x of searched.filter((_, i) => i % step === 0).slice(0, 5)) await run(`deezer (searched, ${x.key})`, x.ref);
      // Deezer refs that came with a chart track.
      const chart = Object.entries(window.PL).find(([k]) => k.startsWith('demo:'));
      if (chart) for (const t of chart[1].tracks.slice(0, 2)) await run('deezer (chart track)', await H.shared.resolveTrack(t));
      // iTunes refs: whatever the run found, plus three forced through the fallback path.
      for (const x of window.REFS.filter((x) => x.ref.provider === 'itunes').slice(0, 2)) await run(`itunes (fallback hit, ${x.key})`, x.ref);
      const itunesOnly = H.resolver.createResolver({ deezer: { search: async () => [], track: async () => ({}) } });
      const forced = [];
      for (const key of ['tth', 'rock', 'allout00']) {
        const p = window.PL[key];
        if (!p) continue;
        const t = p.tracks[1];
        const r = await H.timed(() => itunesOnly.resolveTrack(t));
        forced.push({ key, ok: r.ok, ms: r.ms, provider: r.ok ? r.value.provider : null, score: r.ok ? r.value.matchScore : null, error: r.error });
        if (r.ok) await run(`itunes (forced, ${key})`, r.value);
      }
      return { results, forced };
    });
    for (const f of out.forced) {
      if (f.ok) check(f.provider === 'itunes' && f.score >= 0.7, `iTunes search finds a ${f.key} track`, `score ${f.score}, ${f.ms} ms`);
      else warn(`iTunes search found nothing for a ${f.key} track`, `${f.error.code}${f.error.final === false ? ' (not final)' : ''}`);
    }
    for (const r of out.results) {
      timings.push([`fetchAudio + decode: ${r.provider}`, r.ms]);
      const v = r.value || {};
      check(r.ok && v.isBuffer && v.bytes > 100000 && v.duration > 25 && v.duration < 35 && v.peak > 0.01, pad(r.label, 34), r.ok ? `${(v.bytes / 1024).toFixed(0)} KB → ${v.duration.toFixed(2)} s, ${v.channels} ch @ ${v.sampleRate} Hz, ${r.ms} ms` : `${r.error.code}: ${r.error.message}`);
    }
    check(out.results.filter((r) => r.provider === 'deezer' && r.ok).length >= 3, 'at least 3 Deezer previews decoded', String(out.results.filter((r) => r.provider === 'deezer' && r.ok).length));
    check(out.results.filter((r) => r.provider === 'itunes' && r.ok).length >= 2, 'at least 2 iTunes previews decoded', String(out.results.filter((r) => r.provider === 'itunes' && r.ok).length));
  }

  /* ---------------------------------------------------------------- expiry */
  if (wants('expiry')) {
    say('\nexpiry — a signed Deezer link that no longer works is renewed once');
    const out = await page.evaluate(async () => {
      const H = window.H;
      const chart = await H.index.loadPlaylist('deezer:chart:0');
      const mk = async (t) => ({ ...(await H.shared.resolveTrack(t)) });
      // 1. Signature broken: what does a browser see, and does fetchAudio recover?
      const broken = await mk(chart.tracks[3]);
      const good = broken.url;
      const tampered = good.replace(/hmac=[0-9a-f]{8}/, 'hmac=00000000');
      broken.url = tampered;
      const raw = await fetch(tampered, { credentials: 'omit' }).then(
        (r) => `HTTP ${r.status}`,
        (e) => `${e.name} (opaque)`,
      );
      const a = await H.timed(async () => {
        const bytes = await H.shared.fetchAudio(broken);
        return { bytes: bytes.byteLength, renewed: broken.url !== tampered, https: broken.url.startsWith('https://') };
      });
      // 2. Expiry already in the past: renewed before any download is attempted.
      const stale = await mk(chart.tracks[4]);
      const staleUrl = stale.url.replace(/exp=\d+/, 'exp=1700000000');
      stale.url = staleUrl;
      const b = await H.timed(async () => {
        const bytes = await H.shared.fetchAudio(stale);
        return { bytes: bytes.byteLength, renewed: stale.url !== staleUrl, exp: Number((/exp=(\d+)/.exec(stale.url) || [])[1]) - Math.floor(Date.now() / 1000) };
      });
      return { raw, a, b, mutated: tampered !== good };
    });
    say(`  a tampered link looks like this to the page: ${out.raw}`);
    check(out.mutated, 'test really tampered with the signature');
    check(out.a.ok && out.a.value.bytes > 100000 && out.a.value.renewed && out.a.value.https, 'broken signature → fresh link, audio fetched', out.a.ok ? `${(out.a.value.bytes / 1024).toFixed(0)} KB, ${out.a.ms} ms` : `${out.a.error.code}: ${out.a.error.message}`);
    check(out.b.ok && out.b.value.bytes > 100000 && out.b.value.renewed && out.b.value.exp > 60, 'expired timestamp → renewed up front', out.b.ok ? `${(out.b.value.bytes / 1024).toFixed(0)} KB, new link valid for ${out.b.value.exp} s, ${out.b.ms} ms` : `${out.b.error.code}: ${out.b.error.message}`);
  }

  /* ---------------------------------------------------------------- local + text */
  if (wants('local')) {
    say('\nlocal + text — files and pasted lists in a real browser');
    const out = await page.evaluate(async () => {
      const H = window.H;
      const files = [H.wavFile('02 - Mara Vale - Second Song.wav'), new File(['x'], 'cover.jpg', { type: 'image/jpeg' }), H.wavFile('01 - Mara Vale - First Song.wav')];
      const p = H.index.playlistFromFiles(files);
      const ref = await H.shared.resolveTrack(p.tracks[0]);
      const bytes = await H.shared.fetchAudio(ref);
      const info = await H.decode(bytes);
      const text = await H.index.loadPlaylist('1. Daft Punk - One More Time (5:20)\nBohemian Rhapsody by Queen\n\nStromae – Alors on danse');
      const resolved = [];
      for (const t of text.tracks) {
        const r = await H.timed(() => H.shared.resolveTrack(t));
        resolved.push({ wanted: `${t.artist} — ${t.title}`, ok: r.ok, got: r.ok ? `${r.value.matchedArtist} — ${r.value.matchedTitle}` : r.error.code, score: r.ok ? r.value.matchScore : 0 });
      }
      return { local: { source: p.source, n: p.tracks.length, titles: p.tracks.map((t) => `${t.artist}|${t.title}`), key: ref.key, provider: ref.provider, isPreview: ref.isPreview, bytes: bytes.byteLength, ...info }, text: { id: text.id, n: text.tracks.length, resolved } };
    });
    check(out.local.n === 2 && out.local.titles[0] === 'Mara Vale|First Song' && out.local.titles[1] === 'Mara Vale|Second Song', 'playlistFromFiles: audio only, natural order, names parsed', out.local.titles.join(' · '));
    check(out.local.provider === 'local' && out.local.isPreview === false && /^local:01 - Mara Vale - First Song\.wav:\d+:1700000000000$/.test(out.local.key), 'local AudioRef', out.local.key);
    check(out.local.bytes > 40000 && Math.abs(out.local.duration - 1) < 0.05, 'fetchAudio reads the File; it decodes', `${out.local.bytes} bytes → ${out.local.duration.toFixed(2)} s`);
    check(out.text.n === 3 && /^text:/.test(out.text.id), 'pasted text → playlist', `${out.text.n} songs`);
    for (const r of out.text.resolved) check(r.ok && r.score >= 0.9, `text line resolves: ${clip(r.wanted, 34)}`, `${clip(r.got, 40)} (${r.score})`);
  }

  /* ---------------------------------------------------------------- jsonp hygiene */
  if (wants('jsonp')) {
    say('\njsonp — real <script> transport: abort, timeout, refused hosts, and nothing left behind');
    const out = await page.evaluate(async () => {
      const H = window.H;
      const J = H.jsonp;
      const before = H.leftovers();
      const okCall = await H.timed(async () => {
        const data = await J.jsonp('https://api.deezer.com/chart/0/tracks?limit=3');
        return { n: data.data.length };
      });
      const during = [];
      const burst = Promise.all(
        Array.from({ length: 12 }, (_, i) => J.jsonp(`https://api.deezer.com/search?q=${encodeURIComponent('daft punk ' + i)}&limit=1`).then(
          (d) => (Array.isArray(d.data) ? 'ok' : d.error ? `error ${d.error.code}` : 'odd'),
          (e) => e.code || e.name,
        )),
      );
      during.push(H.leftovers().globals.length);
      const burstResult = await burst;
      const ctrl = new AbortController();
      const aborted = J.jsonp('https://api.deezer.com/chart/113/tracks?limit=50', { signal: ctrl.signal }).then(
        () => 'resolved',
        (e) => e.name,
      );
      ctrl.abort();
      const timedOut = await J.jsonp('https://api.deezer.com/chart/116/tracks?limit=50', { timeoutMs: 1 }).then(
        () => 'resolved',
        (e) => e.code || e.name,
      );
      const refused = await J.jsonp('https://example.com/data?x=1').then(
        () => 'resolved',
        (e) => e.code || e.name,
      );
      const errorCode = await J.jsonp('https://api.deezer.com/playlist/99999999999999').then(
        (d) => (d.error ? `error ${d.error.code}` : 'data'),
        (e) => e.code || e.name,
      );
      const rightAfter = H.leftovers();
      // Late responses to the aborted / timed-out requests must be swallowed, then cleaned up.
      let settled = rightAfter;
      const t0 = performance.now();
      while ((settled.globals.length || settled.scripts) && performance.now() - t0 < 17000) {
        await new Promise((r) => setTimeout(r, 250));
        settled = H.leftovers();
      }
      const stray = Object.keys(window).filter((k) => /jsonp/i.test(k));
      return { before, okCall, peak: during[0], burstResult, aborted: await aborted, timedOut, refused, errorCode, rightAfter, settled, waited: Math.round(performance.now() - t0), stray };
    });
    check(out.okCall.ok && out.okCall.value.n === 3, 'plain call works', `${out.okCall.ms} ms`);
    check(out.peak === 12 && out.burstResult.every((r) => r === 'ok'), '12 concurrent calls: 12 distinct callbacks, 12 answers', `peak globals ${out.peak}; ${[...new Set(out.burstResult)].join(',')}`);
    check(out.aborted === 'AbortError', 'abort → AbortError', out.aborted);
    check(out.timedOut === 'timeout', 'timeout → SourceError("timeout")', out.timedOut);
    check(out.refused === 'bad-response', 'other hosts are refused', out.refused);
    check(out.errorCode === 'error 800', 'Deezer error payloads arrive as data', out.errorCode);
    check(out.rightAfter.scripts === 0, 'no Deezer <script> tag left in the document', `${out.rightAfter.scripts} tags, ${out.rightAfter.globals.length} tombstone(s) pending`);
    check(out.settled.globals.length === 0 && out.settled.scripts === 0 && out.stray.length === 0, 'no JSONP globals left behind', `clean after ${out.waited} ms; before the whole run: ${out.before.globals.length} globals / ${out.before.scripts} tags`);
  }

  /* ---------------------------------------------------------------- hostile answers */
  if (wants('hostile')) {
    say('\nhostile — titles and relay answers built to freeze the page');
    const FROZEN_MS = 1000; // the page used to be gone for 20 s to for ever on each of these
    const out = await answered(
      page.evaluate(async () => {
        const H = window.H;
        const star = String.fromCharCode(42);
        const open = ['<', 'script'].join('');
        const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length));
        const res = {};

        // 1. A title that is a run of stars and a letter, scored against a page of one-word titles.
        {
          const stop = H.heartbeat();
          const t0 = performance.now();
          const wanted = { title: star.repeat(45) + 'z', artist: 'Mara Vale', durationMs: 200000 };
          const hits = Array.from({ length: 15 }, (_, i) => ({ id: 9000 + i, readable: true, title: i ? `Wonderful ${i}` : 'Wonderful', duration: 200, preview: `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/${9000 + i}.mp3`, artist: { name: 'Mara Vale' } }));
          const best = H.match.bestMatch(wanted, hits.map((h) => ({ title: h.title, artist: h.artist.name, durationMs: 200000 })));
          // …and the way a pasted line reaches it: the real resolver, with a catalogue that answers at once.
          const r = H.resolver.createResolver({ deezer: { search: async () => hits, track: async () => ({}) }, itunes: { search: async () => [] } });
          const pasted = await H.timed(() => r.resolveTrack({ id: 'text:0', title: wanted.title, artist: wanted.artist }));
          res.stars = { ms: Math.round(performance.now() - t0), frozen: stop(), score: best ? best.score : 0, pasted: pasted.ok ? 'matched' : pasted.error.code, censored: H.match.censoredEqual(`gl${star}w up`, 'glow up') };
        }

        // 2. Relay answers. Routed by relay, like the outage group, but nothing leaves the page.
        const routes = (handlers) => (url, init = {}) => {
          const html = init.headers && init.headers['X-Return-Format'] === 'html';
          const who = url.startsWith('https://web.scraper.workers.dev') ? (url.includes('scrape=attr') ? 'count' : 'scraper') : url.startsWith('https://api.microlink.io') ? 'microlink' : url.startsWith('https://r.jina.ai') ? (html ? 'jina' : 'markdown') : url.startsWith('https://open.spotify.com/oembed') ? 'oembed' : 'other';
          const h = handlers[who];
          return h ? Promise.resolve(h()) : Promise.reject(new TypeError('blocked by test'));
        };
        const ref = { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' };
        const load = async (handlers) => {
          const stop = H.heartbeat();
          const r = await H.timed(async () => {
            const p = await H.spotify.loadSpotify(ref, { fetchImpl: routes(handlers) });
            return { n: p.tracks.length, total: p.total, first: p.tracks[0].title, last: p.tracks[p.tracks.length - 1].title };
          });
          return { ...r, frozen: stop() };
        };
        const entityPage = (rows) => JSON.stringify({ result: { 'script#__NEXT_DATA__': [JSON.stringify({ props: { pageProps: { state: { data: { entity: { type: 'playlist', id: ref.id, title: 'Night Drive', trackList: rows } } } } } })] } });
        const row = (i) => ({ uri: `spotify:track:${String(i).padStart(22, 'a')}`, title: `Song ${i}`, subtitle: 'Mara Vale', duration: 200000 + i });

        // 2a. Pages that are slow to read for a pattern: unclosed tags carrying the id, and markdown
        //     made of long runs of spaces. Under the size limit, so they do get parsed.
        const SIZE = 1600 * 1024;
        res.slowPages = await load({
          scraper: () => new Response('upstream error', { status: 502 }),
          jina: () => new Response(fill(`${open} x id="__NEXT_DATA__" `, SIZE)),
          microlink: () => new Response(fill(`${open} `, SIZE)),
          markdown: () => new Response(`Title: x${' '.repeat(600000)}y\n${fill(`1. ${' '.repeat(390)}##\n`, 900000)}`),
        });

        // 2b. Twelve thousand rows in one answer (1.4 MB: under the size limit, so it is read), and
        //     forty thousand (over it: refused unread).
        res.manyRows = await load({ scraper: () => new Response(entityPage(Array.from({ length: 12000 }, (_, i) => row(i)))) });
        res.tooManyRows = await load({ scraper: () => new Response(entityPage(Array.from({ length: 40000 }, (_, i) => row(i)))) });

        // 2c. An answer that never ends, then a relay with a sane one.
        const flood = { served: 0, cancelled: false };
        res.endless = await load({
          scraper: () =>
            new Response(
              new ReadableStream({
                pull(c) {
                  if (flood.served >= 48 * 1024 * 1024) return c.error(new Error('nobody stopped reading'));
                  flood.served += 65536;
                  c.enqueue(new Uint8Array(65536).fill(120));
                },
                cancel() {
                  flood.cancelled = true;
                },
              }),
            ),
          jina: () => new Response(`<html><body>${open} id="__NEXT_DATA__" type="application/json">${JSON.parse(entityPage([row(1), row(2), row(3)])).result['script#__NEXT_DATA__'][0]}</${'script'}></body></html>`),
        });
        res.endless.flood = flood;

        // 3. The byte limit against a real response: a ~480 kB preview read as text with a 50 kB limit.
        const chart = await H.index.loadPlaylist('deezer:chart:0');
        const url = chart.tracks[30].preview.url;
        res.realLimit = await H.timed(() => H.util.request(url, { as: 'text', maxBytes: 50000 }));
        res.realWhole = await H.timed(async () => (await H.util.download(url, { maxBytes: 5 * 1024 * 1024 })).body.byteLength);
        return res;
      }),
      60000,
      'hostile answers',
    );
    const st = out.stars;
    check(st.score < 0.7 && st.pasted === 'no-match' && st.ms < 2000 && st.frozen < FROZEN_MS, 'a title of 45 stars is scored and rejected at once', `${st.ms} ms, page frozen ${st.frozen} ms at most, pasted line → ${st.pasted}`);
    check(st.censored === true, 'a single censoring star still matches its word');
    const sp = out.slowPages;
    timings.push(['spotify, three 1.6 MB hostile answers → error', sp.ms]);
    check(!sp.ok && sp.error.code === 'unreachable' && sp.ms < 5000 && sp.frozen < FROZEN_MS, 'relay pages built to be slow to read → "Couldn\'t reach Spotify", page stays alive', `${sp.ok ? 'loaded?!' : sp.error.code} after ${sp.ms} ms, page frozen ${sp.frozen} ms at most [${sp.ok ? '' : sp.error.detail}]`);
    const mr = out.manyRows;
    check(mr.ok && mr.value.n === 200 && mr.value.total === 12000 && mr.value.first === 'Song 0' && mr.value.last === 'Song 199' && mr.frozen < FROZEN_MS, '12,000 rows in one answer → the first 200, "of 12000"', mr.ok ? `${mr.value.n} tracks of ${mr.value.total}, ${mr.ms} ms, page frozen ${mr.frozen} ms at most` : `${mr.error.code}: ${mr.error.message} [${mr.error.detail}]`);
    const tm = out.tooManyRows;
    check(!tm.ok && tm.error.code === 'unreachable' && /scraper: too-large/.test(tm.error.detail) && tm.frozen < FROZEN_MS, '40,000 rows (4 MB) in one answer → refused unread', tm.ok ? `loaded ${tm.value.n} tracks?!` : `${tm.error.code} [${tm.error.detail}], ${tm.ms} ms`);
    const en = out.endless;
    check(en.ok && en.value.n === 3 && en.flood.cancelled && en.flood.served < 4 * 1024 * 1024 && en.frozen < FROZEN_MS, 'an answer that never ends is dropped at the size limit and the next relay is asked', en.ok ? `${(en.flood.served / 1048576).toFixed(1)} MB read, then ${en.value.n} tracks from relay 2, ${en.ms} ms` : `${en.error.code}: ${en.error.message} [${en.error.detail}]`);
    check(!out.realLimit.ok && out.realLimit.error.code === 'too-large' && out.realLimit.ms < 8000, 'real response over the limit → SourceError("too-large")', out.realLimit.ok ? 'was read whole' : `${out.realLimit.error.code} after ${out.realLimit.ms} ms`);
    check(out.realWhole.ok && out.realWhole.value > 100000, 'the same file under a generous limit downloads whole', out.realWhole.ok ? `${(out.realWhole.value / 1024).toFixed(0)} KB, ${out.realWhole.ms} ms` : `${out.realWhole.error.code}: ${out.realWhole.error.message}`);
  }

  /* ---------------------------------------------------------------- slow connection */
  if (wants('slow')) {
    // Two previews at once at 160 kbit/s: the first takes 24 s, and the second hears nothing — not
    // even headers — for most of that. (The app runs three at once; two show the same thing sooner.)
    const KBPS = 160;
    const AT_ONCE = 2;
    say(`\nslow — real previews over a ${KBPS} kbit/s line: slow, or waiting in line, is not the same as dead`);
    const line = await slowLine();
    const far = await launchBehind(line.port);
    try {
      await far.page.goto(`${srv.url}/tests/e2e/sources-harness.html`, { waitUntil: 'load' });
      await far.page.waitForFunction('window.harnessReady === true', { timeout: 15000 });
      const got = await far.page
        .evaluate(async () => {
          const chart = await window.H.index.loadPlaylist('deezer:chart:0');
          window.SLOW = [];
          for (const t of chart.tracks.slice(40, 43)) window.SLOW.push({ ...(await window.H.shared.resolveTrack(t)) });
          return window.SLOW.length;
        })
        .catch(() => 0);
      if (got < 3) warn('could not reach Deezer through the test proxy; nothing checked', String(got));
      else {
        const failedDownloads = () => far.failed.filter((text) => /dzcdn\.net/.test(text)).length;
        line.setRate((KBPS * 1000) / 8);
        // 1. Side by side through the shipped resolver code, the way the conductor asks for them.
        const r = await answered(
          far.page.evaluate((atOnce) =>
            window.H.timed(async () => {
              const t0 = performance.now();
              const headersAfter = [];
              const fetchImpl = async (url, init) => {
                const res = await fetch(url, init);
                headersAfter.push(Math.round(performance.now() - t0));
                return res;
              };
              const r = window.H.resolver.createResolver({ fetchImpl });
              const sizes = await Promise.all(window.SLOW.slice(0, atOnce).map(async (ref) => (await r.fetchAudio(ref)).byteLength));
              return { sizes, headersAfter };
            }),
            AT_ONCE,
          ),
          170000,
          'downloads over the slow line',
        );
        const cutOff = failedDownloads();
        const v = r.value || { sizes: [], headersAfter: [] };
        timings.push([`${AT_ONCE} previews at once, ${KBPS} kbit/s`, r.ms]);
        check(r.ok && v.sizes.length === AT_ONCE && v.sizes.every((n) => n > 100000), `${AT_ONCE} previews at once over ${KBPS} kbit/s both arrive`, r.ok ? `${v.sizes.map((n) => `${(n / 1024).toFixed(0)} KB`).join(', ')} in ${(r.ms / 1000).toFixed(1)} s` : `${r.error.code}: ${r.error.message}`);
        check(cutOff === 0 && v.headersAfter.length === AT_ONCE, 'no download was cut off and started again', `${cutOff} request(s) aborted, ${v.headersAfter.length} responses for ${AT_ONCE} files`);
        // What makes this a test of the idle rule: a file that heard nothing for longer than the 15 s
        // limit because it was queued behind the others, and a total no fixed 20 s deadline allows.
        const longestWait = Math.max(0, ...v.headersAfter);
        if (r.ok && longestWait > 15500 && r.ms > 21000) check(true, 'one waited in line for longer than the idle limit, and was left alone', `first byte of the response after ${v.headersAfter.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(', ')}`);
        else if (r.ok) warn('the line or the CDN did not make any download wait long enough to prove anything', `responses began after ${v.headersAfter.join(', ')} ms; ${r.ms} ms in all`);

        // 2. A real download whose body stops arriving half-way (the stream is held back in the page;
        //    the request underneath is real and, on this line, still under way when it is given up
        //    on — so its cancellation shows). 800 kbit/s: the response starts well inside the short
        //    idle limit used here, and the file still takes five seconds.
        line.setRate(100000);
        const stall = await answered(
          far.page.evaluate(() =>
            window.H.timed(async () => {
              let passed = 0;
              let lastByteAt = 0;
              const fetchImpl = async (url, init) => {
                const res = await fetch(url, init);
                const hold = new TransformStream({
                  transform(chunk, c) {
                    if (passed >= 60000) return new Promise(() => {}); // nothing more comes through
                    passed += chunk.byteLength;
                    lastByteAt = performance.now();
                    c.enqueue(chunk);
                  },
                });
                return new Response(res.body.pipeThrough(hold), { status: res.status });
              };
              try {
                await window.H.util.download(window.SLOW[2].url, { idleMs: 1500, totalMs: 60000, fetchImpl });
                return { outcome: 'completed' };
              } catch (e) {
                return { outcome: e.code || e.name, passed, afterStall: Math.round(performance.now() - lastByteAt) };
              }
            }),
          ),
          60000,
          'a stalled download',
        );
        await new Promise((done) => setTimeout(done, 500)); // let Chrome report the cancelled request
        const cancelled = failedDownloads() - cutOff;
        const sv = stall.value || {};
        check(stall.ok && sv.outcome === 'timeout' && sv.passed >= 60000 && sv.afterStall >= 1400 && sv.afterStall < 4000, 'a download that goes silent half-way is given up on after the idle limit', stall.ok ? `${sv.outcome} ${sv.afterStall} ms after the last byte (limit 1500 ms), ${sv.passed} bytes in` : `${stall.error.code}: ${stall.error.message}`);
        check(cancelled === 1, 'giving up cancels the request underneath', `${cancelled} request(s) aborted`);
      }
    } finally {
      await far.close();
      await line.close();
    }
  }

  /* ---------------------------------------------------------------- page hygiene */
  say('\npage');
  // Expected console noise: Chrome logs failed loads itself (Spotify's oEmbed 404 has no CORS header,
  // the tampered Deezer link is a 403, the outage group blocks requests on purpose).
  const expected = /Failed to load resource|blocked by CORS policy|net::ERR_|open\.spotify\.com\/oembed|dzcdn\.net/i;
  const unexpected = errors.filter((e) => !expected.test(e));
  const uncaught = errors.filter((e) => e.startsWith('pageerror:'));
  check(uncaught.length === 0, 'no uncaught exceptions on the page (e.g. a late JSONP callback with no handler)', uncaught.slice(0, 3).join(' | '));
  check(unexpected.length === 0, 'no unexpected console errors', unexpected.slice(0, 3).join(' | '));
  say(`  (${errors.length - unexpected.length} expected network-failure console lines, ${logs.filter((l) => l.type === 'requestfailed').length} failed requests)`);

  say('\ntime to playlist / audio');
  for (const [name, ms] of timings) say(`  ${pad(name, 46)} ${String(ms).padStart(6)} ms`);
} catch (err) {
  failed++;
  say(`  FAIL harness: ${err && err.stack ? err.stack : err}`);
  for (const e of errors.slice(0, 10)) say(`  page error: ${e}`);
} finally {
  await close();
  await srv.close();
}

say(`\nsources e2e: ${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed, ${warned} warning(s)`);
try {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report.join('\n') + '\n');
} catch (err) {
  console.log(`(could not write ${reportPath}: ${err.message})`);
}
process.exit(failed === 0 ? 0 : 1);

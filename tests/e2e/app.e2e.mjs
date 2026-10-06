// The whole app, end to end, in headless Chrome against the REAL network:
// index.html → view → main.js → conductor → sources / analysis / planner / engine.
//
//   node tests/e2e/app.e2e.mjs            everything (~3–4 min; the browsers run side by side)
//   node tests/e2e/app.e2e.mjs demo local only these groups: demo spotify share local transport mobile
//
// Prints one line per check, saves screenshots of the real app to handoff/shots/app-*.png and exits
// non-zero when a check fails. A check that fails because a third-party service was unreachable says so.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`app e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}

const SHOTS = fileURLToPath(new URL('../../handoff/shots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wants = (g) => !only.length || only.includes(g);
const SPOTIFY_URL = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
};
const note = (text) => console.log(`        ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── page helpers ───────────────────────────────────────────────────────────────────────────────

async function open(srv, opts = {}) {
  const b = await launch(opts);
  b.requests = [];
  b.page.on('request', (req) => b.requests.push(req.url()));
  b.url = srv.url;
  return b;
}

/**
 * Full songs (YouTube) are the default track length for streaming playlists since 2026-10-05; they have
 * their own suite (full.e2e.mjs, under the real origin). The groups here test the Web Audio side, so
 * the visitor has picked Preview (stored once, like a returning visitor's own choice).
 */
const preferPreview = (b) =>
  b.page.evaluateOnNewDocument(() => {
    try {
      if (!sessionStorage.getItem('e2e-prefs')) {
        sessionStorage.setItem('e2e-prefs', '1');
        localStorage.setItem('segue:prefs', JSON.stringify({ volume: 0.9, vibe: 0.5, mode: 'preview' }));
      }
    } catch {
      /* storage blocked */
    }
  });

/**
 * Console errors that are ours to answer for. Chrome itself logs an error line for every failed
 * third-party request (an image that 404s, Spotify answering a non-existent playlist without CORS
 * headers); the app handles those and they cannot be silenced from script.
 */
const ownErrors = (b) => b.errors.filter((e) => !(/Failed to load resource|blocked by CORS policy/.test(e) && !/Failed to load resource.*127\.0\.0\.1/.test(e)));

/** Everything a check may want to know, read in one round trip. */
const state = (page) =>
  page.evaluate(() => {
    const g = window.__segue;
    const c = g.conductor;
    const q = (sel) => document.querySelector(sel);
    const text = (sel) => (q(sel) ? q(sel).textContent.trim() : '');
    const fader = (i) => {
      const fill = q(`[data-ref="mixer"] [data-ch="${i}"] .fader-fill`);
      const m = fill ? /scaleY\(([\d.]+)\)/.exec(fill.style.transform) : null;
      return m ? Number(m[1]) : -1;
    };
    // The cued deck, as the page has drawn it — read BEFORE snapshot(): that brings conductor.live up
    // to date by itself, a frame ahead of the DOM (a deck just handed its next track would still show
    // the old one's readouts).
    const drawnAt = g.engine.now();
    const drawn = c.live.decks.map((rec, i) => (rec && drawnAt < rec.play.startAt - 0.4 ? { fader: fader(i), text: text(`[data-ref="wt${i}"] [data-part="t"]`), startsIn: rec.play.startAt - drawnAt } : null));
    const s = c.snapshot();
    const d = c.debug();
    const lv = g.engine.levels();
    const tally = {};
    for (const it of s.setlist) tally[it.state] = (tally[it.state] || 0) + 1;
    // (engine.ctx creates the AudioContext on first access: only look once the engine has built its graph)
    const built = !!d.engine && d.engine.nodes > 0;
    return {
      screen: q('#app').dataset.screen,
      loaded: s.loaded,
      started: s.started,
      playing: s.playing,
      paused: s.paused,
      ctx: built ? g.engine.ctx.state : 'none',
      media: navigator.mediaSession ? navigator.mediaSession.playbackState : '',
      vibe: s.vibe,
      // per deck: is a track cued there that has not started yet, and where its channel fader stands
      cued: drawn.map((x) => (x ? x.fader : null)),
      // …and what the tag in its waveform lane says (the countdown comes from DeckFrame.startsIn)
      cuedTag: drawn.map((x) => (x ? { text: x.text, startsIn: x.startsIn } : null)),
      buffersChecked: g.metrics.buffersChecked,
      now: g.engine.now(),
      rms: lv.rms,
      peak: lv.peak,
      seed: s.seed,
      mode: s.mode,
      modeEnabled: s.modeEnabled,
      canSkip: s.canSkip,
      stats: s.stats,
      history: c.history(),
      buffers: d.buffers,
      bytes: d.bytes,
      strips: d.engine ? d.engine.strips : -1,
      nodes: d.engine ? d.engine.nodes : -1,
      baseline: d.engine ? d.engine.baselineNodes : -1,
      order: d.order.slice(0, 10),
      failures: d.failures,
      transition: s.transition ? { state: s.transition.state, type: s.transition.type, label: s.transition.label } : null,
      decks: s.decks.map((x) => x && { title: x.title, provider: x.provider, link: x.link || '' }),
      source: s.playlist ? s.playlist.source : '',
      setlist: tally,
      rows: s.setlist.length,
      links: s.setlist.filter((it) => it.link).map((it) => it.link).slice(0, 5),
      dom: {
        ticker: text('[data-ref="tk-label"]'),
        tag: text('[data-ref="tk-tag"]'),
        elapsed: text('[data-ref="elapsed"]'),
        deckA: text('[data-ref="deck0"] [data-part="title"]'),
        deckB: text('[data-ref="deck1"] [data-part="title"]'),
        seed: text('[data-ref="seed"]'),
        rows: document.querySelectorAll('[data-ref="crate-list"] li').length,
        toasts: [...document.querySelectorAll('.toast p')].map((n) => n.textContent),
        // a failed load is written under the control it was started from (view.inputError), not toasted
        hint: text('[data-ref="hint"]'),
        fieldInvalid: !!q('#segue-input') && q('#segue-input').getAttribute('aria-invalid') === 'true',
        focusId: document.activeElement ? document.activeElement.id : '',
        playLabel: q('[data-ref="play"]').getAttribute('aria-label'),
        skipDisabled: q('[data-ref="skip"]').disabled,
        loading: text('[data-ref="ld-detail"]'),
        loadingTitle: text('[data-ref="ld-title"]'),
        recording: q('[data-ref="rec"]').getAttribute('aria-pressed') === 'true',
        vibe: Number(q('[data-ref="vibe"]').value),
      },
      url: location.href,
      firstSoundMs: g.metrics.firstSoundMs,
      lastRecording: g.metrics.lastRecording || null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

/** Poll until fn(state) is truthy; returns the state, or null on timeout. */
async function until(page, fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await state(page);
    if (fn(s)) return s;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

/** Listen for a while: level statistics and the longest stretch of silence (wall clock, while playing). */
async function listen(page, ms, each) {
  const out = { samples: 0, silentMs: 0, longestSilentMs: 0, rms: [], last: null };
  const end = Date.now() + ms;
  let quietSince = 0;
  while (Date.now() < end) {
    const s = await state(page);
    out.last = s;
    if (s.started && s.playing) {
      out.samples++;
      out.rms.push(s.rms);
      if (s.rms < 0.002) {
        if (!quietSince) quietSince = Date.now();
        out.longestSilentMs = Math.max(out.longestSilentMs, Date.now() - quietSince);
      } else quietSince = 0;
    }
    if (each && (await each(s)) === false) break;
    await sleep(240);
  }
  const sorted = out.rms.slice().sort((a, b) => a - b);
  out.medianRms = sorted.length ? sorted[sorted.length >> 1] : 0;
  return out;
}

const shot = (page, name) => page.screenshot({ path: join(SHOTS, name) }).catch(() => {});
const begun = (s) => s.history.filter((h, i) => i > 0 && h.tStart <= s.now).length;
const networkTrouble = (b) => b.logs.filter((l) => l.type === 'requestfailed' && !/fonts\.g|\.png|\.jpg|\.webp|dzcdn\.net\/images|scdn\.co\/image|mzstatic/.test(l.text)).length;

async function typeAndGo(page, text) {
  await page.$eval('#segue-input', (el) => {
    el.value = '';
    el.focus();
  });
  await page.keyboard.type(text, { delay: 1 });
  await page.keyboard.press('Enter');
}

// ── group: demo crate on desktop (1, 2, 4, 5, 7, 12, 13) ───────────────────────────────────────

/** The demo group's set, for the share group to reproduce: {url, seed, firstFour} (firstFour fills in ~50 s later). */
let shareInfo;
const shared = new Promise((resolve) => (shareInfo = resolve));
const signature = (s) => s.history.slice(0, 4).map((h) => `${h.trackId} ${h.type} ${h.beats}`);

async function groupDemo(srv) {
  const b = await open(srv, { width: 1440, height: 900 });
  const { page } = b;
  const downloads = mkdtempSync(join(tmpdir(), 'segue-dl-'));
  await preferPreview(b);
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => {});

    // 1. landing
    await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector('button[data-demo]', { timeout: 15000 });
    await sleep(600);
    const land = await page.evaluate(() => ({
      screen: document.querySelector('#app').dataset.screen,
      demos: document.querySelectorAll('button[data-demo]').length,
      examples: document.querySelectorAll('button[data-url]').length,
      input: !!document.querySelector('#segue-input'),
      title: document.title,
      url: location.search,
    }));
    await shot(page, 'app-landing-1440x900.png');
    check('1. landing renders: input, 8 demo crates, 6 example playlists', land.screen === 'landing' && land.demos === 8 && land.examples === 6 && land.input, JSON.stringify(land));
    check('1. landing: zero console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));

    // 2. demo crate → live set
    const t0 = Date.now();
    await page.click('button[data-demo="dance"]');
    await sleep(120);
    const loading = await state(page);
    await shot(page, 'app-loading-1440x900.png');
    const first = await until(page, (s) => s.started && s.rms > 0.01, 45000, 50);
    const ttfs = Date.now() - t0;
    if (!check('2. demo crate starts playing', !!first, first ? `time to first sound ${ttfs} ms (app's own measure ${first.firstSoundMs} ms)` : `stuck on "${(await state(page)).dom.loading}"`)) throw new Error('demo did not start');
    check('2. loading screen showed real status text', loading.screen === 'loading' && /Deezer|chart|crate|track|Finding|Fetching|Tempo|Starting/i.test(`${loading.dom.loadingTitle} ${loading.dom.loading}`), `"${loading.dom.loadingTitle} — ${loading.dom.loading}"`);
    check('2. time to first sound under 8 s', ttfs < 8000, `${ttfs} ms`);
    check('2. the address bar is a share link to this set', new RegExp(`\\?p=deezer:chart:113&seed=${first.seed}`).test(first.url), first.url.replace(srv.url, ''));
    const ref = { url: first.url.replace(srv.url, ''), seed: first.seed, firstFour: null, gone: false };
    shareInfo(ref);
    check('2. the share link names the vibe the set uses', /[?&]vibe=0\.5(&|$)/.test(first.url), first.url.replace(srv.url, ''));
    check('2. …and its track length (Preview)', /[?&]len=preview(&|$)/.test(first.url), first.url.replace(srv.url, ''));

    // 4a. Watch the Skip button against the conductor for the whole run: every stretch in which the
    // button says something else than Skip would do (it opens and closes on the audio clock).
    await page.evaluate(() => {
      const c = window.__segue.conductor;
      const btn = document.querySelector('[data-ref="skip"]');
      const w = (window.__skipWatch = { flips: 0, lags: [], since: 0, was: c.canSkip() });
      setInterval(() => {
        const can = c.canSkip();
        const now = performance.now();
        if (can !== w.was) {
          w.was = can;
          w.flips++;
        }
        if (can === !btn.disabled) {
          if (w.since) w.lags.push(now - w.since);
          w.since = 0;
        } else if (!w.since) w.since = now;
      }, 4);
    });

    const seen = { decks: new Set(), tickers: new Set(), states: new Set(), elapsed: new Set(), maxBuffers: 0, maxStrips: 0, playingRows: [], shotMix: false, shotSolo: false, cuedFaders: [], cuedTags: [] };
    const run = await listen(page, 125000, async (s) => {
      if (!ref.firstFour && s.history.length >= 4) ref.firstFour = signature(s);
      for (const f of s.cued) if (f !== null) seen.cuedFaders.push(f);
      for (const c of s.cuedTag) if (c !== null) seen.cuedTags.push(c);
      for (const d of s.decks) if (d) seen.decks.add(d.title);
      seen.tickers.add(s.dom.ticker);
      if (s.transition) seen.states.add(s.transition.state);
      seen.elapsed.add(s.dom.elapsed);
      seen.maxBuffers = Math.max(seen.maxBuffers, s.buffers);
      seen.maxStrips = Math.max(seen.maxStrips, s.strips);
      seen.playingRows.push(s.setlist.playing || 0);
      if (!seen.shotMix && s.transition && s.transition.state === 'active' && s.transition.type !== 'fadeIn' && s.decks[0] && s.decks[1]) {
        const h = s.history.find((x) => x.tStart <= s.now && x.tEnd > s.now);
        if (h && s.now > h.tStart + (h.tEnd - h.tStart) * 0.35) {
          seen.shotMix = true;
          await shot(page, 'app-stage-transition-1440x900.png');
        }
      }
      if (!seen.shotSolo && s.transition && s.transition.state === 'upcoming' && s.now > 8) {
        seen.shotSolo = true;
        await shot(page, 'app-stage-1440x900.png');
      }
      return !(s.now >= 76 && begun(s) >= 3 && seen.shotMix);
    });
    const end = run.last;
    const done = end.history.filter((h, i) => i > 0 && h.tEnd <= end.now);
    check('2. the set runs for 75 s and at least 3 transitions happen', end.now >= 75 && begun(end) >= 3, `${end.now.toFixed(0)} s of set time, ${begun(end)} transitions begun (${done.length} finished): ${end.history.slice(1, 5).map((h) => h.label).join(' → ')}`);
    check('2. no transition was planned late', end.history.every((h) => !h.degraded));
    check('2. sound throughout: no silence longer than 1.2 s', run.longestSilentMs <= 1200 && run.medianRms > 0.02, `longest quiet stretch ${run.longestSilentMs} ms, median level ${run.medianRms.toFixed(3)} over ${run.samples} samples`);
    check('2. decks update', seen.decks.size >= 3, `${seen.decks.size} different tracks seen on the decks`);
    check('2. ticker updates (next → mixing)', seen.states.has('upcoming') && seen.states.has('active') && seen.tickers.size >= 3, `${seen.tickers.size} different labels`);
    check('2. setlist updates', (end.setlist.played || 0) >= 2 && seen.playingRows.filter((n) => n === 1).length >= seen.playingRows.length * 0.95 && end.dom.rows === end.rows, `${end.setlist.played} played, ${end.rows} rows`);
    check('2. the clock runs', seen.elapsed.size >= 60, `${seen.elapsed.size} different readings`);
    check('2. mixer: the channel fader of a deck that is only cued is down', seen.cuedFaders.length >= 20 && Math.max(...seen.cuedFaders) <= 0.02, `${seen.cuedFaders.length} samples of a cued deck, fader at most ${seen.cuedFaders.length ? Math.max(...seen.cuedFaders) : '?'}`);
    {
      // "Cued · in 0:14": the tag counts the cued deck down. The view's clock trails the engine's by the
      // output latency, so a second and a half either way is agreement. A deck that has just been handed
      // its track reads plain "Cued" until the next animation frame writes the countdown: allowed, as
      // long as it stays the rare look it is. What a cued deck must never show is time left ("−0:29").
      const read = seen.cuedTags.map((c) => ({ ...c, m: /^Cued · in (\d+):(\d\d)$/.exec(c.text) }));
      const counted = read.filter((c) => c.m);
      const off = counted.filter((c) => Math.abs(Number(c.m[1]) * 60 + Number(c.m[2]) - c.startsIn) > 1.6);
      const wrong = read.filter((c) => !c.m && c.text !== 'Cued').map((c) => c.text);
      check('2. waveforms: a cued deck is counted down in its lane ("Cued · in m:ss")', read.length >= 20 && counted.length >= read.length * 0.95 && wrong.length === 0 && off.length === 0, `${counted.length} of ${read.length} looks at a cued deck showed a countdown, ${off.length} disagreed with the plan${wrong.length ? `; a cued deck also read: ${[...new Set(wrong)].slice(0, 3).join(' | ')}` : ''}`);
    }
    const sw = await page.evaluate(() => {
      const w = window.__skipWatch;
      const lags = w.lags.slice().sort((a, b) => a - b);
      return { flips: w.flips, n: lags.length, median: lags.length ? lags[lags.length >> 1] : 0, max: lags.length ? lags[lags.length - 1] : 0, slow: lags.filter((x) => x > 100).length };
    });
    // (one animation frame is the design; when the button only followed the conductor's 200 ms tick the median was 56 ms and the longest 180)
    check('4. the Skip button follows what Skip would do, promptly', sw.flips >= 4 && sw.median <= 35 && sw.slow <= 1, `Skip opened / closed ${sw.flips} times; the button disagreed for ${sw.median.toFixed(0)} ms (median of ${sw.n} stretches, longest ${sw.max.toFixed(0)} ms)`);
    const failed = end.stats.failed;
    if (failed && networkTrouble(b)) note(`${failed} track(s) failed while ${networkTrouble(b)} network requests failed: not counted against the app`);
    check('2. no failed track', failed === 0 || networkTrouble(b) > 0, `${failed} failed${failed ? ` (${JSON.stringify(end.failures)})` : ''}`);
    check('2. no console errors or unhandled rejections during the set', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));

    // share: with no system share sheet the link is copied and says which set it is
    await page.evaluate(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
    await page.click('[data-ref="share"]');
    const sh = await until(page, (s) => s.dom.toasts.some((t) => t.includes(first.seed) || /Copy this link/.test(t)), 4000);
    check('2. Share gives a link to this exact set', !!sh, sh ? `"${sh.dom.toasts.find((t) => t.includes(first.seed) || /Copy this link/.test(t)).slice(0, 70)}"` : '');

    // 4. skip
    // (the button, not just the conductor: a click on a button that is still disabled goes nowhere)
    const ready = await until(page, (s) => s.canSkip && !s.dom.skipDisabled && s.history.length >= 2 && s.history[s.history.length - 1].tStart > s.now + 6, 40000);
    if (check('4. Skip becomes available during a solo', !!ready)) {
      const planned = ready.history[ready.history.length - 1];
      await page.click('[data-ref="skip"]');
      const after = await until(page, (s) => s.history[s.history.length - 1].tStart !== planned.tStart, 3000, 50);
      const q = after && after.history[after.history.length - 1];
      check('4. Skip produces a quick transition into the announced track', !!q && q.trackId === planned.trackId && q.tStart - ready.now < 3.2 && q.tEnd - q.tStart < 5, q ? `${q.label}: starts ${(q.tStart - ready.now).toFixed(2)} s after the click, lasts ${(q.tEnd - q.tStart).toFixed(2)} s (was planned ${(planned.tStart - ready.now).toFixed(1)} s away)` : 'no new plan');
      const heard = await listen(page, 7000);
      check('4. audio continues through the Skip', heard.longestSilentMs <= 700 && heard.medianRms > 0.02, `longest quiet stretch ${heard.longestSilentMs} ms, median level ${heard.medianRms.toFixed(3)}`);
      const later = await until(page, (s) => q && s.now > q.tEnd + 0.5, 8000);
      check('4. the skipped-to track is now playing', !!later && later.history.length >= after.history.length && (later.setlist.playing || 0) === 1);
    }

    // 13. memory: more skips to get past 6 plays, then count what is retained
    for (let i = 0; i < 4; i++) {
      const s = await until(page, (x) => x.canSkip && !x.dom.skipDisabled, 30000);
      if (!s) break;
      await page.click('[data-ref="skip"]');
      await sleep(4500);
    }
    await sleep(2500);
    const mem = await state(page);
    check('13. memory: after 6+ plays decoded buffers and engine strips stay bounded', mem.history.length >= 7 && Math.max(mem.buffers, seen.maxBuffers) <= 7 && Math.max(mem.strips, seen.maxStrips) <= 4 && mem.nodes <= mem.baseline + 80, `${mem.history.length} plays; decoded buffers ${mem.buffers} now / ${seen.maxBuffers} peak; engine strips ${mem.strips} now / ${seen.maxStrips} peak; ${mem.nodes} audio nodes (${mem.baseline} idle); ${(mem.bytes / 1e6).toFixed(1)} MB of previews held`);

    // 7. pause / resume
    await page.click('[data-ref="play"]');
    await sleep(500);
    const p1 = await state(page);
    await sleep(1200);
    const p2 = await state(page);
    check('7. pause freezes set time', !p2.playing && Math.abs(p2.now - p1.now) < 0.005 && p2.dom.playLabel === 'Play', `set time ${p1.now.toFixed(3)} → ${p2.now.toFixed(3)} over 1.2 s`);
    // (the analyser still holds the last block it saw; the meter must not stay lit over a silent set)
    check('7. paused: the output meter reads silence', p2.rms === 0 && p2.peak === 0, `level ${p2.rms}, peak ${p2.peak}`);
    await page.click('[data-ref="play"]');
    const p3 = await until(page, (s) => s.playing && s.now > p2.now + 0.4 && s.rms > 0.005, 5000);
    check('7. resume continues', !!p3, p3 ? `set time ${p3.now.toFixed(2)}` : '');

    // 12. record
    await page.click('[data-ref="rec"]');
    await sleep(300);
    const r1 = await state(page);
    await sleep(3200);
    await page.click('[data-ref="rec"]');
    const r2 = await until(page, (s) => !!s.lastRecording, 6000);
    await sleep(800);
    const files = readdirSync(downloads).filter((f) => f.startsWith('segue-set-'));
    check('12. record toggle yields a recording', r1.dom.recording && !!r2 && r2.lastRecording.size > 3000 && /^segue-set-[A-Za-z0-9]+\.(webm|m4a|ogg)$/.test(r2.lastRecording.name), r2 ? `${r2.lastRecording.name}, ${r2.lastRecording.size} bytes, ${r2.lastRecording.type}${files.length ? ' — downloaded' : ' — blob only (download not observed)'}` : 'no blob');

    // 5. new set
    const before = await state(page);
    await page.click('[data-ref="newset"]');
    const fresh = await until(page, (s) => s.seed !== before.seed && s.started && s.history.length >= 2 && s.rms > 0.005, 25000);
    if (check('5. New Set starts a new set', !!fresh, fresh ? `#${before.seed} → #${fresh.seed}, playing again ${fresh.now.toFixed(1)} s into the new set` : '')) {
      check('5. New Set: different seed in the UI and in the URL', fresh.dom.seed.toLowerCase() === `#${fresh.seed}`.toLowerCase() && fresh.url.includes(`seed=${fresh.seed}`) && !fresh.url.includes(before.seed));
      const sameOrder = JSON.stringify(fresh.order) === JSON.stringify(before.order);
      const opener = fresh.history[0].trackId !== before.history[0].trackId;
      check('5. New Set: different order and transitions', !sameOrder && fresh.history[0].type === 'fadeIn' && (opener || fresh.history[1].type !== before.history[1].type || fresh.history[1].trackId !== before.history[1].trackId), `base order changed: ${!sameOrder}; opener changed: ${opener}; first move ${before.history[1].label} → ${fresh.history[1].label}`);
    }
    // 17. Back leaves the set, not the site; Forward leads to the set again
    const cur = await state(page);
    await page.evaluate(() => history.back());
    const home = await until(page, (s) => s.screen === 'landing' && !s.loaded, 5000, 50);
    check('17. Back from the stage returns to the start screen and stops the set', !!home && home.url === `${srv.url}/index.html`, home ? home.url.replace(srv.url, '') : `still on ${(await state(page)).screen}, ${await page.evaluate(() => location.href)}`);
    await page.evaluate(() => history.forward());
    const again = await until(page, (s) => s.screen === 'ready' && s.seed === cur.seed, 25000, 100);
    check('17. Forward leads to the same set again ("Start the set")', !!again && again.url === cur.url && !again.started, again ? again.url.replace(srv.url, '') : (await state(page)).screen);
    check('demo group: no console errors at all', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    shareInfo(null);
    await b.close();
    rmSync(downloads, { recursive: true, force: true });
  }
}

// ── group: share link reproduces the set (6), under Chrome's real autoplay policy ──────────────

async function groupShare(srv) {
  const info = await shared;
  if (!info) return check('6. share link: the set to reproduce never started', false);
  const b = await open(srv, { width: 1280, height: 800, gesture: true });
  const { page } = b;
  try {
    // The recipient is a returning visitor who once left the Vibe slider at "wild" and prefers full
    // songs — and the link is an old-style one that names neither a vibe (= made at the default) nor a
    // track length (= made before full songs existed: 30-second previews).
    await page.evaluateOnNewDocument(() => {
      try {
        if (!sessionStorage.getItem('e2e-prefs')) {
          sessionStorage.setItem('e2e-prefs', '1');
          localStorage.setItem('segue:prefs', JSON.stringify({ volume: 0.9, vibe: 0.95, mode: 'medium' }));
        }
      } catch {
        /* storage blocked: the check below says so */
      }
    });
    await page.goto(`${srv.url}${info.url.replace(/&vibe=[^&]*/, '').replace(/&len=[^&]*/, '')}`, { waitUntil: 'load' });
    const ready = await until(page, (s) => s.screen === 'ready', 20000);
    check('6. share link opens on the "Start the set" screen', !!ready && ready.seed === info.seed && !ready.started, ready ? `set #${ready.seed}` : (await state(page)).screen);
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('segue:prefs') || '{}').vibe);
    check('6. the set uses the link’s vibe, not the one the visitor has stored', !!ready && ready.vibe === 0.5 && ready.dom.vibe === 0.5 && /[?&]vibe=0\.5(&|$)/.test(ready.url) && (await stored()) === 0.95, ready ? `set vibe ${ready.vibe}, slider ${ready.dom.vibe}, stored preference ${await stored()}, address bar ${ready.url.replace(srv.url, '')}` : '');
    check('6. a link without a track length plays 30-second previews (its old meaning), whatever the visitor prefers', !!ready && ready.mode === 'preview' && /[?&]len=preview(&|$)/.test(ready.url), ready ? `mode ${ready.mode}, ${ready.url.replace(srv.url, '')}` : '');
    await sleep(1500); // let it cue the opener while it waits for the tap
    await shot(page, 'app-ready-1280x800.png');
    const cued = await state(page);
    const t0 = Date.now();
    await page.click('[data-ref="rd-start"]');
    const first = await until(page, (s) => s.started && s.rms > 0.01, 30000, 40);
    check('6. one tap starts the audio (real autoplay policy)', !!first, first ? `sound ${Date.now() - t0} ms after the tap (${cued.stats.ready} tracks were cued while waiting)` : '');
    const warned = b.logs.filter((l) => /AudioContext was not allowed/i.test(l.text)).length;
    check('6. no AudioContext was started before the tap', warned === 0, `${warned} autoplay warnings`);
    const mine = await until(page, (s) => s.history.length >= 4, 90000, 500);
    for (let i = 0; i < 240 && !info.firstFour; i++) await sleep(500); // recorded by the demo group before it starts skipping
    if (check('6. both sets reached four plays', !!mine && !!info.firstFour)) {
      const a = info.firstFour;
      const c = signature(mine);
      check('6. same p + seed reproduces the first 4 tracks and transition types', JSON.stringify(a) === JSON.stringify(c), `${c.map((x) => x.split(' ').slice(1).join(' ')).join(' → ')}${JSON.stringify(a) === JSON.stringify(c) ? '' : `  vs  ${a.join(' → ')}`}`);
    }
    // a volume change saves the preferences: the link's vibe must not ride along into them
    await page.$eval('[data-ref="volume"]', (el) => {
      el.value = '0.8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('segue:prefs') || '{}'));
    check('6. the visitor’s own stored vibe survives the visit', kept.vibe === 0.95 && kept.volume === 0.8, JSON.stringify(kept));
    check('share group: no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
}

// ── group: Spotify link, text paste, bad input (3, 9, 10) ──────────────────────────────────────

async function groupSpotify(srv) {
  const b = await open(srv, { width: 1280, height: 800 });
  const { page } = b;
  await preferPreview(b);
  try {
    await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector('#segue-input');

    // 10. bad input first (cheap, and proves the way back to landing)
    const bad = async (label, text, expect) => {
      await typeAndGo(page, text);
      const s = await until(page, (x) => x.screen === 'landing' && expect.test(x.dom.hint), 30000, 150);
      const now = s || (await state(page));
      check(`10. bad input (${label}) → friendly error, back on landing`, !!s, s ? `"${s.dom.hint.slice(0, 90)}"` : `hint: ${JSON.stringify(now.dom.hint)}, toasts: ${JSON.stringify(now.dom.toasts)}`);
      // …said where it can be acted on: under the link field, which is marked, focused, and not also toasted
      check(`10. bad input (${label}): the error stays under the link field, the field is marked and has the focus`, !!s && s.dom.fieldInvalid && s.dom.focusId === 'segue-input' && !s.dom.toasts.some((t) => expect.test(t)), s ? JSON.stringify({ invalid: s.dom.fieldInvalid, focus: s.dom.focusId, toasts: s.dom.toasts.length }) : '');
      if (s && !bad.shot) {
        bad.shot = true;
        await shot(page, 'app-landing-error-1280x800.png');
      }
      await sleep(300);
    };
    await bad('one word', 'hello', /playlist/i);
    await bad('a single-track link', `https://open.spotify.com/track/${'4uLU6hMCjMI75M1A2tKUQC'}`, /single song/i);
    await bad('a playlist that does not exist', `https://open.spotify.com/playlist/${'0'.repeat(22)}`, /private or doesn|reach Spotify/i);
    // Markup pasted as a "playlist": assembled here so no ready-made payload sits in the repository.
    const markup = ['<im', 'g src=x on', 'error="window.__marked=1">'].join('');
    await typeAndGo(page, markup);
    await sleep(1500);
    const inj = await page.evaluate(() => ({ marked: window.__marked === 1, imgs: document.querySelectorAll('img[src="x"]').length, screen: document.querySelector('#app').dataset.screen }));
    check('10. pasted markup is treated as text, never as HTML', !inj.marked && inj.imgs === 0 && inj.screen === 'landing');

    // 3. a real Spotify playlist
    const t0 = Date.now();
    await typeAndGo(page, SPOTIFY_URL);
    const first = await until(page, (s) => (s.started && s.rms > 0.01) || (s.screen === 'landing' && (s.dom.hint || s.dom.toasts.length > 0) && Date.now() - t0 > 1500), 60000, 60);
    if (!first || !first.started) {
      const why = first ? [first.dom.hint, ...first.dom.toasts].filter(Boolean).join(' | ') : 'timeout';
      check('3. Spotify playlist loads and plays', false, /reach Spotify|offline/i.test(why) ? `NETWORK: the Spotify relays did not answer (${why})` : why);
    } else {
      check('3. Spotify playlist loads and plays', true, `time to first sound ${Date.now() - t0} ms; ${first.stats.total} tracks from ${first.source}`);
      const heard = await listen(page, 12000);
      check('3. Spotify set keeps playing', heard.longestSilentMs <= 1200 && heard.medianRms > 0.02, `median level ${heard.medianRms.toFixed(3)}`);
      const all = await until(page, (s) => s.stats.resolved + s.stats.failed >= s.stats.total, 150000, 1000);
      const st = (all || (await state(page))).stats;
      check('3. at least 85 % of the tracks have audio (resolved in the background)', st.resolved / st.total >= 0.85, `${st.resolved}/${st.total} resolved, ${st.failed} without a preview, ${st.pending} still pending`);
      const s = await state(page);
      check('3. setlist links open the track on Spotify', s.links.length > 0 && s.links.every((l) => l.startsWith('https://open.spotify.com/track/')), s.links[0] || '');
      const spotifyAudio = b.requests.filter((u) => /p\.scdn\.co|audio-ak-spotify|mp3-preview/.test(u));
      check('3. no Spotify audio is ever requested', spotifyAudio.length === 0, `${b.requests.filter((u) => /dzcdn\.net.*\.mp3|itunes\.apple\.com.*\.m4a|audio-ssl/.test(u)).length} preview downloads, all from Deezer / Apple`);
      await shot(page, 'app-stage-spotify-1280x800.png');
    }

    // 9. pasted track list (built from a live chart so no song titles live in this file)
    await page.click('[data-ref="home"]');
    await until(page, (s) => s.screen === 'landing', 5000);
    const lines = await page.evaluate(async () => {
      const { loadPlaylist } = await import('./js/sources/index.js');
      const pl = await loadPlaylist('deezer:chart:132');
      return pl.tracks.slice(3, 9).map((t) => `${t.artist.split(',')[0]} - ${t.title}`);
    });
    await page.click('[data-ref="text-toggle"]');
    await page.$eval('#segue-text', (el, v) => (el.value = v), lines.join('\n'));
    const t1 = Date.now();
    await page.click('[data-ref="text-go"]');
    const txt = await until(page, (s) => s.started && s.rms > 0.01 && s.source === 'text', 60000, 80);
    if (check('9. six pasted "Artist - Title" lines load and play', !!txt && txt.stats.total === 6, txt ? `time to first sound ${Date.now() - t1} ms` : JSON.stringify((await state(page)).dom.toasts))) {
      const all = await until(page, (s) => s.stats.resolved + s.stats.failed >= 6, 60000, 500);
      check('9. the pasted tracks are found', !!all && all.stats.resolved >= 5, all ? `${all.stats.resolved}/6 matched` : 'still resolving');
      // No system share sheet in this test: take the copy-a-link path.
      await page.evaluate(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
      await page.click('[data-ref="share"]');
      const sh = await until(page, (s) => s.dom.toasts.some((t) => /link/i.test(t)), 4000);
      check('9. Share explains that a pasted list has no rebuildable link', !!sh && !/[?&]p=/.test(sh.url), sh ? `"${sh.dom.toasts.find((t) => /link/i.test(t)).slice(0, 80)}"` : JSON.stringify((await state(page)).dom.toasts));
    }
    check('spotify group: no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
}

// ── group: local files, full-length mode (8) ───────────────────────────────────────────────────

/** A 40-second synthetic track: kick on every beat, a hat between, a bass note per bar. 16-bit mono WAV. */
function synthWav(bpm, seconds, note) {
  const sr = 22050;
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = Math.round(bpm * 977);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let k = 0; 0.12 + k * beat < seconds - 0.3; k++) {
    const at = Math.round((0.12 + k * beat) * sr);
    let ph = 0;
    for (let i = 0; i < 0.22 * sr && at + i < n; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (48 + 110 * Math.exp(-t / 0.025))) / sr;
      x[at + i] += 0.75 * Math.exp(-t / 0.09) * Math.sin(ph);
    }
    const hat = at + Math.round((beat / 2) * sr);
    for (let i = 0; i < 0.03 * sr && hat + i < n; i++) x[hat + i] += 0.12 * Math.exp(-i / (0.008 * sr)) * rnd();
    if (k % 2 === 1) for (let i = 0; i < 0.08 * sr && at + i < n; i++) x[at + i] += 0.22 * Math.exp(-i / (0.02 * sr)) * rnd();
    const f = note * (k % 16 < 8 ? 1 : 1.335);
    for (let i = 0; i < beat * sr && at + i < n; i++) x[at + i] += 0.13 * Math.sin((2 * Math.PI * f * i) / sr) * Math.min(1, i / 200) * Math.min(1, (beat * sr - i) / 400);
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32000), 44 + i * 2);
  return buf;
}

const WAV_SPECS = [
  ['Test Pilots - Kick One Twenty.wav', 120, 55],
  ['Test Pilots - Kick One Twenty Four.wav', 124, 61.7],
  ['Signal Check - Click One Twenty Six.wav', 126, 65.4],
  ['Signal Check - Click One Twenty Eight.wav', 128, 73.4],
];
/** Write the synthetic tracks (each `seconds` long) into a fresh temp dir: {dir, paths}. */
function makeWavs(seconds) {
  const dir = mkdtempSync(join(tmpdir(), 'segue-wav-'));
  const paths = WAV_SPECS.map(([name, bpm, note]) => {
    const p = join(dir, name);
    writeFileSync(p, synthWav(bpm, seconds, note));
    return p;
  });
  return { dir, paths };
}

async function groupLocal(srv) {
  const { dir, paths } = makeWavs(40);
  const b = await open(srv, { width: 1280, height: 800 });
  const { page } = b;
  try {
    await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector('#segue-files', { timeout: 15000 });
    const input = await page.$('#segue-files');
    const mark = b.requests.length;
    const t0 = Date.now();
    await input.uploadFile(...paths);
    const first = await until(page, (s) => s.started && s.rms > 0.01, 40000, 60);
    if (!check('8. four local WAV files load and play', !!first && first.stats.total === 4 && first.source === 'local', first ? `time to first sound ${Date.now() - t0} ms` : JSON.stringify((await state(page)).dom))) return;
    check('8. full-length mode: track-length control is live', first.modeEnabled && first.mode !== 'preview' && first.decks.some((d) => d && d.provider === 'local'), `mode ${first.mode}`);
    check('8. titles come from the file names', first.decks.some((d) => d && /Kick One|Click One/.test(d.title)), (first.decks.find(Boolean) || {}).title);
    let mixShot = false;
    const run = await listen(page, 100000, async (s) => {
      // mid-transition picture of a set made only of synthetic files (nobody's artwork): used in the README
      const h = s.history[1];
      if (!mixShot && h && s.now > h.tStart + (h.tEnd - h.tStart) * 0.45 && s.now < h.tEnd) {
        mixShot = true;
        await shot(page, 'app-stage-local-transition-1280x800.png');
      }
      return !(s.history.length >= 3 && s.history[1].tEnd < s.now - 1 && s.now > 44);
    });
    const end = run.last;
    const tr = end.history[1];
    check('8. local set mixes into the next file with a real transition', !!tr && !tr.degraded && tr.tEnd <= end.now, tr ? `${tr.label}${tr.synced ? ' (beat-matched)' : ''} at ${tr.tStart.toFixed(1)}–${tr.tEnd.toFixed(1)} s; next: ${end.history[2] ? end.history[2].label : 'not planned yet'}` : 'no transition');
    check('8. local set: sound throughout', run.longestSilentMs <= 1200 && run.medianRms > 0.02, `longest quiet stretch ${run.longestSilentMs} ms, median level ${run.medianRms.toFixed(3)}`);
    const out = b.requests.slice(mark).filter((u) => !u.startsWith(srv.url) && !/fonts\.(googleapis|gstatic)\.com/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'));
    check('8. nothing leaves the device for local files', out.length === 0, out.slice(0, 3).join(' '));
    await page.click('input[name="segue-mode"][value="short"]').catch(() => page.evaluate(() => document.querySelector('input[name="segue-mode"][value="short"]').click()));
    const m = await until(page, (s) => s.mode === 'short', 3000);
    await sleep(700);
    const radio = await page.evaluate(() => (document.querySelector('input[name="segue-mode"]:checked') || {}).value);
    check('8. track length can be changed while playing', !!m && radio === 'short', `planner mode ${m ? m.mode : '?'}, control shows ${radio}`);
    await page.mouse.move(640, 300);
    await sleep(300);
    await shot(page, 'app-stage-local-1280x800.png');
    check('local group: no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── group: transport truth, history, re-planning (14–19) — local files, real autoplay policy ───

/**
 * Runs inside the page (evaluateOnNewDocument), with no user activation and no devtools call: waits for
 * the app, puts three synthetic WAVs into the real file input, fires `change` and logs the app's state
 * four times a second into window.__noGesture.
 */
function noGestureFiles() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wav = (bpm) => {
    const sr = 11025;
    const n = sr * 24;
    const bytes = new Uint8Array(44 + n * 2);
    const v = new DataView(bytes.buffer);
    const tag = (o, t) => {
      for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i);
    };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    tag(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, n * 2, true);
    const beat = Math.round((60 / bpm) * sr);
    for (let i = 0; i < n; i++) {
      const k = i % beat;
      const kick = Math.exp(-k / (0.05 * sr)) * Math.sin((2 * Math.PI * 60 * k) / sr);
      v.setInt16(44 + i * 2, Math.round(20000 * kick + 2500 * Math.sin((2 * Math.PI * 220 * i) / sr)), true);
    }
    return bytes;
  };
  (async () => {
    const out = (window.__noGesture = { done: false, log: [] });
    while (!window.__segue || !document.getElementById('segue-files')) await sleep(50);
    await sleep(300);
    const input = document.getElementById('segue-files');
    const dt = new DataTransfer();
    [['Quiet Room - First Light.wav', 120], ['Quiet Room - Second Light.wav', 124], ['Quiet Room - Third Light.wav', 126]].forEach(([name, bpm]) => dt.items.add(new File([wav(bpm)], name, { type: 'audio/wav' })));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // look four times a second until the set has been "started" for three seconds (at most 40 s)
    let after = 0;
    for (let i = 0; i < 160 && after < 12; i++) {
      await sleep(250);
      const g = window.__segue;
      const s = g.conductor.snapshot();
      const d = g.engine.debug();
      if (s.started) after++;
      out.log.push({ screen: document.getElementById('app').dataset.screen, started: s.started, playing: s.playing, ctx: d && d.nodes > 0 ? g.engine.ctx.state : 'none', now: g.engine.now(), label: document.querySelector('[data-ref="play"]').getAttribute('aria-label') });
    }
    out.done = true;
    console.log('[e2e] no-gesture run done'); // the test waits for this line: it must not look into the page before
  })();
}

async function groupTransport(srv) {
  const short = makeWavs(40);
  const long = makeWavs(100);
  const downloads = mkdtempSync(join(tmpdir(), 'segue-dl-'));
  const [a, b] = await Promise.all([open(srv, { width: 1280, height: 800, gesture: true }), open(srv, { width: 1280, height: 800, gesture: true })]);
  try {
    await Promise.all([transportA(srv, a, short.paths, downloads), transportB(srv, b, long.paths)]);
  } finally {
    await a.close();
    await b.close();
    for (const d of [short.dir, long.dir, downloads]) rmSync(d, { recursive: true, force: true });
  }
}

/** A page nobody has touched: files arrive without a user gesture; then interruptions, Pause + Rec, New Set that cannot start, Back. */
async function transportA(srv, b, paths, downloads) {
  const { page } = b;
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => {});
  // 14. No gesture (what Safari makes of its file picker, and every browser of a drop): the context
  // cannot run. Puppeteer's evaluate() counts as a user gesture, so the page does this part alone:
  // it hands itself three files through the real input and writes down what it sees.
  await page.evaluateOnNewDocument(noGestureFiles);
  await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
  for (let i = 0; i < 500 && !b.logs.some((l) => l.text === '[e2e] no-gesture run done'); i++) await sleep(100); // hands off until the page-side script is through
  const rep = await page.evaluate(() => window.__noGesture || null);
  const seenAt = (rep && rep.log) || [];
  const cued = seenAt[seenAt.length - 1] || {};
  const lied = seenAt.filter((x) => x.playing && x.ctx !== 'running');
  if (!check('14. files without a user gesture: the set is cued behind "Start the set", never shown as playing', !!rep && rep.done && cued.started && cued.screen === 'ready' && !cued.playing && cued.ctx === 'suspended' && cued.now <= 0.01 && lied.length === 0, `${seenAt.length} looks; last: screen ${cued.screen}, started ${cued.started}, playing ${cued.playing}, context ${cued.ctx}, set time ${cued.now}; ${lied.length} looks claimed to play on a context that was not running`)) return;
  const h0 = await page.evaluate(() => history.length) - 1; // (the set already has its entry)
  await page.click('[data-ref="rd-start"]');
  const first = await until(page, (s) => s.screen === 'stage' && s.playing && s.ctx === 'running' && s.rms > 0.01, 8000, 40);
  check('14. one tap starts it, from the beginning', !!first && first.now < 3 && first.dom.playLabel === 'Pause' && first.media === 'playing', first ? `sound at set time ${first.now.toFixed(2)} s` : JSON.stringify(await state(page)).slice(0, 200));

  // 15. The browser stops the audio by itself (a call, another app's audio; iOS calls it "interrupted").
  await until(page, (s) => s.now > 3 && s.history.length >= 2, 20000);
  await page.evaluate(() => window.__segue.engine.ctx.suspend());
  const cut = await until(page, (s) => !s.playing && s.dom.playLabel === 'Play' && s.media === 'paused', 3000, 40);
  check('15. audio stopped by the browser: the transport says paused', !!cut, cut ? `context ${cut.ctx}, button "${cut.dom.playLabel}", media session ${cut.media}` : JSON.stringify((({ playing, ctx, media, dom }) => ({ playing, ctx, media, label: dom.playLabel }))(await state(page))));
  await sleep(600);
  const plansBefore = (await state(page)).history.length;
  await page.click('[data-ref="play"]');
  const back = await until(page, (s) => s.playing && s.ctx === 'running' && s.dom.playLabel === 'Pause' && s.rms > 0.005, 4000, 40);
  await sleep(1500);
  const on = await state(page);
  check('15. one tap on Play brings it back — as playing', !!back && on.playing && !on.paused && on.dom.playLabel === 'Pause' && on.media === 'playing' && on.now > back.now + 1, `playing ${on.playing}, button "${on.dom.playLabel}", set time ${back ? back.now.toFixed(2) : '?'} → ${on.now.toFixed(2)}`);
  // an interruption that ends by itself needs no tap at all
  await page.evaluate(() => window.__segue.engine.ctx.suspend());
  await until(page, (s) => !s.playing, 3000, 40);
  await page.evaluate(() => window.__segue.engine.ctx.resume());
  const self = await until(page, (s) => s.playing && s.dom.playLabel === 'Pause', 3000, 40);
  check('15. audio that comes back by itself is playing again without a tap', !!self);

  // 16. Pause, then Rec: arming a recording must not start the sound behind a Play button.
  await page.click('[data-ref="play"]');
  const held = await until(page, (s) => !s.playing && s.ctx !== 'running', 3000, 40);
  await sleep(300);
  const q1 = await state(page);
  await page.click('[data-ref="rec"]');
  await sleep(1500);
  const q2 = await state(page);
  check('16. Pause, then Rec: still paused, nothing audible, clock frozen', !!held && !q2.playing && q2.ctx !== 'running' && Math.abs(q2.now - q1.now) < 0.005 && q2.dom.playLabel === 'Play' && q2.dom.recording, `context ${q2.ctx}, set time ${q1.now.toFixed(3)} → ${q2.now.toFixed(3)}, button "${q2.dom.playLabel}", recording armed: ${q2.dom.recording}`);
  await page.click('[data-ref="play"]');
  const resumed = await until(page, (s) => s.playing && s.rms > 0.005 && s.now > q2.now + 0.5, 5000, 40);
  await sleep(1200);
  await page.click('[data-ref="rec"]');
  const saved = await until(page, (s) => !!s.lastRecording, 6000);
  check('16. Play resumes; the armed recording has the music from there on', !!resumed && !!saved && saved.lastRecording.size > 2000, saved ? `${saved.lastRecording.size} bytes` : 'no recording');
  const later = await until(page, (s) => s.history.length > plansBefore || s.now > 60, 60000, 500);
  check('15. the set keeps planning after the interruptions', !!later && later.history.length > plansBefore && later.playing, later ? `${later.history.length} plays planned at ${later.now.toFixed(0)} s` : '');

  // 18. New Set that cannot start (here: the engine never answers): the loading screen says what it waits for.
  await page.evaluate(() => {
    const e = window.__segue.engine;
    e.__start = e.start;
    e.start = () => new Promise(() => {});
  });
  await page.click('[data-ref="newset"]');
  const waiting = await until(page, (s) => s.screen === 'loading', 4000, 50);
  check('18. a New Set that does not start within a moment shows the loading screen, not a silent stage', !!waiting && !waiting.started && waiting.dom.loadingTitle.length > 0, waiting ? `"${waiting.dom.loadingTitle} — ${waiting.dom.loading}"` : `screen ${(await state(page)).screen}`);
  await page.evaluate(() => {
    const e = window.__segue.engine;
    e.start = e.__start;
  });

  // 17. Cancel steps back onto the start screen's own history entry; a new set gets one again; Back returns.
  await page.click('[data-ref="ld-cancel"]');
  const home = await until(page, (s) => s.screen === 'landing' && !s.loaded, 4000, 50);
  await sleep(300);
  const h1 = await page.evaluate(() => ({ len: history.length, href: location.href, state: history.state }));
  check('17. leaving a set from the page steps back to the start screen’s history entry', !!home && h1.len === h0 + 1 && h1.state === null && h1.href === `${srv.url}/index.html`, JSON.stringify({ ...h1, was: h0 }));
  await (await page.$('#segue-files')).uploadFile(...paths);
  const second = await until(page, (s) => s.screen === 'stage' && s.playing && s.rms > 0.01, 40000, 60);
  const h2 = await page.evaluate(() => ({ len: history.length, state: history.state }));
  check('17. a set started from the start screen has a history entry of its own', !!second && h2.len === h0 + 1 && !!h2.state && h2.state.segue === 'set', JSON.stringify(h2));
  await page.evaluate(() => history.back());
  const out = await until(page, (s) => s.screen === 'landing' && !s.loaded, 4000, 50);
  await sleep(1200);
  const quiet = await state(page);
  check('17. Back from the stage returns to the start screen and stops the set', !!out && quiet.rms < 0.001 && quiet.url === `${srv.url}/index.html`, out ? `level ${quiet.rms.toFixed(4)}` : `screen ${quiet.screen}, ${quiet.url}`);
  check('transport group (untouched page): no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
}

/** The picker opened by a real click; then Track length on full-length files. */
async function transportB(srv, b, paths) {
  const { page } = b;
  await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('label[for="segue-files"]', { timeout: 15000 });
  const before = await state(page);
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click('label[for="segue-files"]')]);
  await sleep(250);
  const open1 = await state(page);
  check('14. the click that opens the file picker unlocks the audio (the context runs while the picker is open)', before.ctx === 'none' && open1.ctx === 'running', `context before the click: ${before.ctx}, with the picker open: ${open1.ctx}`);
  const screens = new Set();
  await chooser.accept(paths);
  const first = await until(page, (s) => (screens.add(s.screen), s.started && s.playing && s.rms > 0.01), 40000, 40);
  check('14. picked files start playing by themselves, straight onto the stage', !!first && first.screen === 'stage' && !screens.has('ready'), `screens seen: ${[...screens].join(' → ')}`);
  if (!first) return;
  // Full-length files are checked for NaN / Infinity samples in slices right after decoding, so the
  // engine's own check does not land in one piece on the frame a track starts (every decode counts one).
  check('14. decoded files are checked for bad samples before they reach the engine', first.buffersChecked >= 1 && first.buffersChecked >= first.buffers, `${first.buffersChecked} buffers checked after decoding, ${first.buffers} held`);

  // 19. Track length reaches the transition that is already announced.
  const planned = await until(page, (s) => s.history.length >= 2 && s.canSkip && !s.dom.skipDisabled, 20000, 100);
  if (!check('19. full-length files: the way out of the first track is planned early', !!planned && planned.mode === 'medium' && planned.history[1].tStart > 52, planned ? `Medium: planned for ${planned.history[1].tStart.toFixed(1)} s` : '')) return;
  const was = planned.history[1];
  await page.click('input[name="segue-mode"][value="short"]').catch(() => page.evaluate(() => document.querySelector('input[name="segue-mode"][value="short"]').click()));
  const moved = await until(page, (s) => s.mode === 'short' && s.history.length >= 2 && s.history[1].tStart !== was.tStart, 3000, 50);
  const now1 = moved && moved.history[1];
  check('19. choosing Short re-plans it at once: same next track, about 45 s in', !!moved && now1.trackId === was.trackId && now1.tStart < was.tStart - 12 && now1.tStart < 62 && now1.tStart > moved.now, moved ? `${was.label} at ${was.tStart.toFixed(1)} s → ${now1.label} at ${now1.tStart.toFixed(1)} s (set time ${moved.now.toFixed(1)} s)` : `still planned for ${was.tStart.toFixed(1)} s`);
  if (!moved) return;
  const heard = await listen(page, 4000);
  check('19. the music does not notice the re-plan', heard.longestSilentMs <= 500 && heard.medianRms > 0.02, `longest quiet stretch ${heard.longestSilentMs} ms, median level ${heard.medianRms.toFixed(3)}`);
  // and Skip still works on the re-made plan
  const can = await until(page, (s) => s.canSkip && !s.dom.skipDisabled, 10000, 50);
  if (can) {
    await page.click('[data-ref="skip"]');
    const q = await until(page, (s) => s.history[1].tStart < can.now + 3.2 && s.history[1].tStart !== now1.tStart, 3000, 50);
    const after = await listen(page, 5000);
    check('19. Skip after a re-plan: quick transition, sound throughout', !!q && q.history[1].trackId === was.trackId && after.longestSilentMs <= 700 && after.medianRms > 0.02, q ? `${q.history[1].label}, longest quiet stretch ${after.longestSilentMs} ms` : 'no new plan');
  } else check('19. Skip after a re-plan: quick transition, sound throughout', false, 'Skip never became available');
  check('transport group (picker): no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
}

// ── group: phone (11) ──────────────────────────────────────────────────────────────────────────

async function groupMobile(srv) {
  const b = await open(srv, { width: 390, height: 844, mobile: true });
  const { page } = b;
  await preferPreview(b);
  try {
    await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
    await page.waitForSelector('button[data-demo]', { timeout: 15000 });
    await sleep(700);
    const land = await state(page);
    await shot(page, 'app-mobile-landing-390x844.png');
    check('11. phone landing: no horizontal overflow', land.overflowX <= 0, `scrollWidth − clientWidth = ${land.overflowX}`);
    await page.tap('button[data-demo="pop"]');
    const first = await until(page, (s) => s.started && s.rms > 0.01, 45000, 80);
    if (!check('11. phone: a demo crate plays', !!first)) return;
    await until(page, (s) => s.now > 6 && !!s.transition, 20000);
    const box = await page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        const q = e.getBoundingClientRect();
        return { w: Math.round(q.width), h: Math.round(q.height), inside: q.left >= 0 && q.right <= window.innerWidth + 0.5 && q.top >= 0 && q.bottom <= window.innerHeight + 0.5 };
      };
      return { play: r('[data-ref="play"]'), skip: r('[data-ref="skip"]'), newset: r('[data-ref="newset"]'), toggle: r('[data-ref="crate-toggle"]'), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, canvas: r('[data-ref="wave-canvas"]') };
    });
    await shot(page, 'app-mobile-stage-390x844.png');
    check('11. phone stage: no horizontal overflow', box.overflowX <= 0, `scrollWidth − clientWidth = ${box.overflowX}`);
    check('11. phone stage: play, skip, New set and Setlist are on screen and finger-sized', [box.play, box.skip, box.newset, box.toggle].every((r) => r.inside && r.w >= 40 && r.h >= 40), JSON.stringify(box));
    await page.tap('[data-ref="play"]');
    const paused = await until(page, (s) => !s.playing, 3000);
    await page.tap('[data-ref="play"]');
    const again = await until(page, (s) => s.playing && s.rms > 0.005, 5000);
    check('11. phone: play / pause works by touch', !!paused && !!again);
    await page.tap('[data-ref="crate-toggle"]');
    await sleep(500);
    const sheet = await page.evaluate(() => ({ open: document.querySelector('[data-ref="crate"]').classList.contains('is-open'), rows: document.querySelectorAll('[data-ref="crate-list"] li').length }));
    await shot(page, 'app-mobile-setlist-390x844.png');
    check('11. phone: the setlist sheet opens', sheet.open && sheet.rows > 5, `${sheet.rows} rows`);
    check('mobile group: no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await b.close();
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

const srv = await startServer();
const guard = (name, fn) =>
  fn(srv).catch((err) => {
    check(`${name} group ran to completion`, false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
  });
const jobs = [];
if (wants('demo')) jobs.push(guard('demo', groupDemo));
else shareInfo(null);
if (wants('share') && wants('demo')) jobs.push(guard('share', groupShare));
if (wants('spotify')) jobs.push(guard('spotify', groupSpotify));
// (the two groups that play local files run one after the other: fewer browsers at once, same total time)
jobs.push((wants('local') ? guard('local', groupLocal) : Promise.resolve()).then(() => (wants('transport') ? guard('transport', groupTransport) : undefined)));
if (wants('mobile')) jobs.push(guard('mobile', groupMobile));
await Promise.all(jobs);
await srv.close();

const failed = results.filter((r) => !r.ok);
console.log(`\napp e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);

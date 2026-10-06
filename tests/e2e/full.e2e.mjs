// Full songs, end to end: the real app (index.html → main.js → fullset.js → ytdeck.js / youtube.js)
// served as https://aarushkandukoori.github.io/segue/ (YouTube decides per embedding origin: label music
// refuses http://127.0.0.1), in headless Chrome with its REAL autoplay policy, against the real network —
// real Spotify relays, real YouTube search relays, real players and real pre-roll ads (20-90 s each; they
// are never skipped or hidden, so this suite is slow: ~8-12 minutes).
//
//   node tests/e2e/full.e2e.mjs                 everything (several browsers side by side)
//   node tests/e2e/full.e2e.mjs main phone      only these groups: main share phone background moves prefs stopload
//
// SEGUE_SITE_ROOT=<dir> serves another copy of the site under the real origin (to try a change first).
//
// Prints one line per check, saves screenshots to handoff/shots/full-*.png, exits non-zero on a failure.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sendToBackground } from './browser.mjs';
import { serveAsOrigin } from './origin.mjs';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`full e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}

const SHOTS = fileURLToPath(new URL('../../handoff/shots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wants = (g) => !only.length || only.includes(g);
/** Today's Top Hits — a public editorial playlist that is always there. */
const SPOTIFY_URL = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const SPOTIFY_ID = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';
const CSP = "default-src 'self'; script-src 'self' https://api.deezer.com https://www.youtube.com; connect-src 'self' https:; img-src 'self' https: data: blob:; media-src blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const results = [];
const check = (group, name, ok, detail = '') => {
  results.push({ name: `[${group}] ${name}`, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} [${group}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
};
const note = (group, text) => console.log(`        [${group}] ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timings = {};

// ── page helpers ───────────────────────────────────────────────────────────────────────────────

/** Errors that are ours: Chrome logs one per failed third-party request (a cover image, a relay that is down). */
const ownErrors = (b) => b.errors.filter((e) => !/Failed to load resource|blocked by CORS policy|net::ERR_/.test(e));

const SITE_ROOT = process.env.SEGUE_SITE_ROOT || '';

async function open(opts) {
  const b = await launch({ gesture: true, ...opts });
  b.site = await serveAsOrigin(b.page, SITE_ROOT ? { root: SITE_ROOT } : {});
  // CSP violations of OUR page (the players' own documents are YouTube's business)
  await b.page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return b;
}
async function close(b) {
  await b.site.close().catch(() => {});
  await b.close();
}
/** Click a control by its data-ref; a control that is scrolled away or covered for a moment is clicked from the page. */
async function clickRef(b, ref) {
  const sel = `[data-ref="${ref}"]`;
  await b.page.click(sel).catch(() => b.page.evaluate((q) => document.querySelector(q).click(), sel));
}

/**
 * Read the page through raw CDP with userGesture:false: puppeteer's page.evaluate grants the page user
 * activation, which would make every autoplay check pass whatever the app does.
 */
async function peek(b, fn, arg) {
  if (!b.cdp) b.cdp = await b.page.createCDPSession();
  const expression = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`;
  const r = await b.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}

/** Everything a check may want, in one round trip (runs in the page). */
function readState() {
  const g = window.__segue;
  const q = (sel) => document.querySelector(sel);
  const text = (sel) => (q(sel) ? q(sel).textContent.trim() : '');
  const f = g.fullset;
  const s = g.active.snapshot();
  const d = f.debug();
  const decks = (g.decks || []).map((x) => {
    const y = x.debug();
    return { state: x.state, video: x.videoId, sent: y.sentVolume, player: y.playerVolume, muted: y.playerMuted, pos: y.position, dur: x.duration, ad: x.adSeconds, ps: y.playerState, err: x.error, pending: y.pending, silenced: y.silenced };
  });
  const lv = g.active === f ? g.videoEngine.levels() : g.engine.levels();
  const tally = {};
  for (const it of s.setlist) tally[it.state] = (tally[it.state] || 0) + 1;
  const rec = q('[data-ref="rec"]');
  return {
    screen: q('#app').dataset.screen,
    stage: q('#app').dataset.stage,
    active: g.active === f ? 'full' : 'preview',
    handoff: g.handoff,
    loaded: s.loaded,
    started: s.started,
    playing: s.playing,
    paused: !!f.paused,
    needsTap: !!f.needsTap,
    now: s.now,
    mode: s.mode,
    seed: s.seed,
    canSkip: s.canSkip,
    tv: s.transition ? { state: s.transition.state, type: s.transition.type, label: s.transition.label, why: s.transition.why } : null,
    deckViews: s.decks.map((x) => x && { title: x.title, provider: x.provider, status: x.status, link: x.link }),
    cur: d.cur,
    nxt: d.nxt,
    lanes: d.lanes,
    leaveAt: s.leaveAt,
    history: g.active === f ? f.history() : [],
    decks,
    rms: lv.rms,
    previewRms: g.engine.levels().rms,
    setlist: tally,
    played: s.setlist.filter((r) => r.state === 'played' || r.state === 'playing' || r.state === 'mixing').map((r) => String(r.key).slice(0, String(r.key).lastIndexOf('|'))),
    elapsed: Number.isFinite(s.elapsed) ? s.elapsed : s.now,
    stalled: s.stalled,
    previews: s.stats.previews,
    held: g.active === f ? [d.cur, d.nxt].map((r) => !!(r && f.snapshot().decks[r.deck] && /tab is in front/.test(f.snapshot().decks[r.deck].statusText || ''))) : [],
    cues: d.cues,
    hidden: document.visibilityState === 'hidden',
    workerClock: !!g.workerClock,
    canUnlock: !!(g.decks && g.decks[0] && typeof g.decks[0].unlock === 'function'),
    url: location.href,
    firstSoundMs: g.metrics.firstSoundMs,
    unavailable: g.metrics.unavailable || '',
    dom: {
      ticker: text('[data-ref="tk-label"]'),
      tag: text('[data-ref="tk-tag"]'),
      why: text('[data-ref="tk-why"]'),
      vstatus: [...document.querySelectorAll('.vdeck [data-part="status"]')].map((n) => n.textContent),
      toasts: [...document.querySelectorAll('.toast p')].map((n) => n.textContent),
      recDisabled: rec.getAttribute('aria-disabled') === 'true',
      recTitle: rec.title,
      recPressed: rec.getAttribute('aria-pressed') === 'true',
      playLabel: q('[data-ref="play"]').getAttribute('aria-label'),
      skipDisabled: q('[data-ref="skip"]').disabled,
      modeChecked: (q('input[name="segue-mode"]:checked') || {}).value || '',
      csp: q('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    },
    csp: (window.__csp || []).slice(),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}
const state = (b) => peek(b, readState);
/** One line about where the set is (for a check that timed out). */
const where = (s) => (s ? `set ${s.started ? `at ${Number(s.now).toFixed(0)} s` : 'not started'}; on air ${s.cur ? `${s.cur.provider}:${s.cur.phase} deck ${'AB'[s.cur.deck]}` : '-'}; next ${s.nxt ? `${s.nxt.provider}:${s.nxt.phase} deck ${'AB'[s.nxt.deck]}${s.held && s.held[1] ? ' (held)' : ''}` : '-'}; decks ${s.decks.map((d) => `${d.state}${d.err != null ? ` ${d.err}` : ''} ps${d.ps}${d.pending && d.pending.cue ? ` cue:${d.pending.cue}` : ''}${d.silenced ? ' silenced' : ''} ad ${Math.round(d.ad || 0)} s`).join(' / ')}; ticker ${s.tv ? s.tv.state : '-'}; cues ${JSON.stringify(s.cues)}` : 'no state');

/**
 * What deck `i`'s player draws, read inside its own (cross-origin) frame through raw CDP, never with a
 * gesture: YouTube's error screen ("Video unavailable"), an ad (and its Skip button), the <video>.
 * null when the frame cannot be found.
 */
async function deckScreen(b, i) {
  if (!b.cdp) b.cdp = await b.page.createCDPSession();
  for (const f of b.page.frames()) {
    if (!/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//.test(f.url())) continue;
    const owner = await b.cdp.send('DOM.getFrameOwner', { frameId: f._id }).catch(() => null);
    if (!owner) continue;
    const node = await b.cdp.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId }).catch(() => null);
    if (!node || !node.object || !node.object.objectId) continue;
    const r = await b.cdp.send('Runtime.callFunctionOn', { objectId: node.object.objectId, functionDeclaration: 'function () { const s = this.closest(".vslot"); return s ? s.dataset.ref : null; }', returnByValue: true, userGesture: false }).catch(() => null);
    await b.cdp.send('Runtime.releaseObject', { objectId: node.object.objectId }).catch(() => {});
    if (!r || !r.result || r.result.value !== `vslot${i}` || !f.client) continue;
    const expression = `(() => {
      const q = (s) => document.querySelector(s);
      const err = q('.ytp-error');
      const v = q('video');
      const mp = q('#movie_player');
      return { error: !!(err && err.getClientRects().length && getComputedStyle(err).display !== 'none' && getComputedStyle(err).visibility !== 'hidden'),
        errorText: err ? err.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : '', ad: !!q('.ad-showing'),
        skip: !!q('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'),
        video: v ? { paused: v.paused, t: Math.round(v.currentTime * 100) / 100, src: !!(v.currentSrc || v.src) } : null,
        mode: mp ? mp.className.split(' ').filter((c) => /-mode$|^ad-showing$|embed-error/.test(c)).join(' ') : '' };
    })()`;
    const out = await f.client.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false }).catch(() => null);
    return out && out.result ? out.result.value : null;
  }
  return null;
}

async function until(b, fn, timeoutMs, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await state(b);
    if (fn(s)) return s;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

/**
 * until(), but past `baseMs` it keeps waiting as long as a deck's pre-roll ad is still moving (its ad
 * clock grew within the last 20 s), up to `maxMs`: YouTube served ad pods of 3-4 minutes at night
 * (2026-10-06), and what the check waits for can only come after the ad. The condition is unchanged; an
 * ad that stands still ends the wait at `baseMs` as before.
 */
async function untilPastAds(b, fn, baseMs, maxMs, everyMs = 300) {
  const t0 = Date.now();
  let lastAd = -1;
  let movedAt = t0;
  for (;;) {
    const s = await state(b);
    if (fn(s)) return s;
    const ad = s.decks.reduce((sum, d) => sum + (d.state === 'ad' ? Number(d.ad) || 0 : 0), 0);
    if (ad > lastAd + 0.05 && s.decks.some((d) => d.state === 'ad')) movedAt = Date.now();
    lastAd = ad;
    const ran = Date.now() - t0;
    if (ran > maxMs || (ran > baseMs && Date.now() - movedAt > 20000)) return null;
    await sleep(everyMs);
  }
}

/**
 * YouTube's terms in the page as it is drawn: each player iframe on screen, ≥ 200×200 CSS px, opaque
 * all the way up, not filtered, not clipped, and nothing drawn over any part of it — probed on a 10 px
 * grid with elementsFromPoint while every element is made hit-testable (an overlay with
 * pointer-events:none would otherwise hide from the probe). CSSOM only: the page's CSP refuses <style>.
 */
function probePlayers() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('*, *::before, *::after { pointer-events: auto !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const out = [];
  try {
    const frames = [...document.querySelectorAll('.vslot iframe')];
    for (const fr of frames) {
      const r = fr.getBoundingClientRect();
      const res = { w: Math.round(r.width), h: Math.round(r.height), inView: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, covered: 0, points: 0, opacity: 1, filter: false, hidden: false, clipped: false, src: (fr.src || '').split('?')[0] };
      for (let el = fr; el && el !== document.documentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        res.opacity = Math.min(res.opacity, Number(cs.opacity));
        if (cs.filter && cs.filter !== 'none') res.filter = true;
        if (cs.visibility !== 'visible' || cs.display === 'none') res.hidden = true;
        if (el !== fr && /(hidden|clip)/.test(cs.overflow)) {
          const pr = el.getBoundingClientRect();
          if (pr.left > r.left + 0.5 || pr.top > r.top + 0.5 || pr.right < r.right - 0.5 || pr.bottom < r.bottom - 0.5) res.clipped = true;
        }
      }
      for (let x = r.left + 2; x < r.right - 1; x += 10) {
        for (let y = r.top + 2; y < r.bottom - 1; y += 10) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          res.points++;
          const top = document.elementsFromPoint(x, y)[0];
          if (top !== fr) res.covered++;
        }
      }
      out.push(res);
    }
  } finally {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  }
  return out;
}
const playersOk = (list) => list.length === 2 && list.every((p) => p.w >= 200 && p.h >= 200 && p.inView && p.covered === 0 && p.points > 100 && p.opacity === 1 && !p.filter && !p.hidden && !p.clipped);
const playersSay = (list) => list.map((p) => `${p.w}×${p.h}${p.inView ? '' : ' off-screen'}, ${p.covered}/${p.points} covered${p.opacity < 1 ? `, opacity ${p.opacity}` : ''}${p.filter ? ', filtered' : ''}${p.hidden ? ', hidden' : ''}${p.clipped ? ', clipped' : ''}`).join(' | ');

/** In-page sampler at ~20 Hz: set time, both lanes and what each deck was told / reports. */
function startSampler() {
  const g = window.__segue;
  const w = (window.__samples = []);
  window.__sampler = setInterval(() => {
    const f = g.fullset;
    if (g.active !== f || !f.started) return;
    const d = f.debug();
    const dk = (g.decks || []).map((x) => x.debug());
    w.push({ t: f.now(), lanes: d.lanes ? { outVol: d.lanes.outVol, incVol: d.lanes.incVol, tStart: d.lanes.tStart, tEnd: d.lanes.tEnd } : null, cur: d.cur, nxt: d.nxt, vol: d.volume, sent: dk.map((x) => x.sentVolume), player: dk.map((x) => x.playerVolume), muted: dk.map((x) => x.playerMuted), st: dk.map((x) => x.state), pos: dk.map((x) => x.position) });
    if (w.length > 12000) w.splice(0, 2000);
  }, 50);
}
const takeSamples = (b) => peek(b, () => window.__samples.splice(0));

/**
 * Audible-anything sampler for the hand-overs: a YouTube deck that is playing, unmuted and above 2 %, or
 * Web Audio output. It samples every 50 ms on the app's own worker clock (js/util/timer-worker.js) when it
 * can: a page timer fires only once a minute in a throttled background tab, which would hide every gap
 * shorter than that.
 */
function startGapWatch() {
  const g = window.__segue;
  const w = (window.__gap = { since: 0, longest: 0, samples: 0, audible: 0, t0: performance.now(), worker: false });
  const sample = () => {
    const yt = (g.decks || []).some((x) => {
      const y = x.debug();
      return x.state === 'playing' && y.playerMuted === false && y.playerVolume > 2;
    });
    const wa = g.engine.levels().rms > 0.003 || g.videoEngine.levels().rms > 0.003;
    const now = performance.now();
    w.samples++;
    if (yt || wa) {
      w.audible++;
      w.since = 0;
    } else {
      if (!w.since) w.since = now;
      w.longest = Math.max(w.longest, now - w.since);
    }
  };
  try {
    const worker = new Worker(new URL('js/util/timer-worker.js', location.href));
    worker.onmessage = sample;
    worker.postMessage({ op: 'interval', id: 1, ms: 50 });
    window.__gapTimer = { worker };
    w.worker = true;
  } catch {
    window.__gapTimer = { id: setInterval(sample, 50) };
  }
}
const takeGap = (b) => peek(b, () => {
  const t = window.__gapTimer || {};
  if (t.worker) t.worker.terminate();
  else clearInterval(t.id);
  return window.__gap;
});

const volumeAt = (points, t) => {
  if (!points || !points.length) return 0;
  if (!(t > points[0].t)) return points[0].v;
  for (let i = 1; i < points.length; i++) {
    if (t < points[i].t) {
      const q = points[i - 1];
      return q.v + ((points[i].v - q.v) * (t - q.t)) / (points[i].t - q.t);
    }
  }
  return points[points.length - 1].v;
};

const shot = (b, name) => b.page.screenshot({ path: join(SHOTS, name) }).catch(() => {});

async function pasteAndGo(b, text) {
  // the start screen keeps the last link: empty the field first (raw CDP, no user activation) so the
  // typed link replaces it instead of being appended to it
  await peek(b, () => {
    document.querySelector('#segue-input').value = '';
  });
  await b.page.click('#segue-input');
  await b.page.keyboard.type(text, { delay: 1 });
  await b.page.keyboard.press('Enter');
}

const setPrefs = (b, mode) =>
  b.page.evaluateOnNewDocument((m) => {
    try {
      if (!sessionStorage.getItem('e2e-prefs')) {
        sessionStorage.setItem('e2e-prefs', '1');
        localStorage.setItem('segue:prefs', JSON.stringify({ volume: 0.9, vibe: 0.5, mode: m }));
      }
    } catch {
      /* storage blocked */
    }
  }, mode);

// ── group: desktop, Spotify playlist in Short → transitions → Skip → Preview → Medium ─────────

async function groupMain() {
  const G = 'main';
  const b = await open({ width: 1440, height: 900 });
  try {
    await setPrefs(b, 'short');
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    const land = await state(b);
    check(G, 'the page runs under the production Content-Security-Policy', land.dom.csp === CSP, land.dom.csp === CSP ? '' : land.dom.csp);
    check(G, 'Track length defaults to the stored choice (Short) for a streaming playlist', land.dom.modeChecked === 'short', land.dom.modeChecked);

    const t0 = Date.now();
    await pasteAndGo(b, SPOTIFY_URL);
    const stage = await until(b, (s) => s.screen === 'stage' && s.stage === 'video' && s.active === 'full', 30000, 200);
    if (!check(G, 'a Spotify link in Short opens the video stage at once', !!stage, stage ? `${((Date.now() - t0) / 1000).toFixed(1)} s after Enter` : JSON.stringify((await state(b)).dom.toasts))) return;
    const ad = await until(b, (s) => s.decks.length === 2 && (s.decks[0].state === 'ad' || s.started), 60000, 250);
    if (ad && !ad.started) {
      // (silent either way: muted, or — after a gesture, where the deck supports it — unmuted at volume 0, which Chrome lets go on in a background tab)
      check(G, 'the first song pre-rolls silently (muted or at volume 0) in deck A in plain view; the ticker says it is starting', ad.decks[0].state === 'ad' && (ad.decks[0].muted !== false || ad.decks[0].player === 0) && ad.tv && ad.tv.state === 'starting' && /ad/i.test(ad.dom.why) && ad.dom.tag === 'Starting', `deck A ${ad.decks[0].state}, muted ${ad.decks[0].muted}, volume ${ad.decks[0].player}; ticker "${ad.dom.tag} · ${ad.dom.ticker} · ${ad.dom.why}"`);
      check(G, 'the second song pre-rolls at the same time in deck B (both ads run at once)', ['ad', 'loading', 'cued'].includes(ad.decks[1].state) && !!ad.decks[1].video, `deck B ${ad.decks[1].state}`);
      await sleep(1500);
      await shot(b, 'full-ad-1440x900.png');
      const pl = await peek(b, probePlayers);
      check(G, 'during the ads: both players visible, ≥ 200×200, opaque, uncovered', playersOk(pl), playersSay(pl));
    } else note(G, 'the first song was cued before its ad could be looked at');
    check(G, 'REC is disabled for full songs, with the reason', (await state(b)).dom.recDisabled && /YouTube.*recorded|can’t be recorded/.test((await state(b)).dom.recTitle), (await state(b)).dom.recTitle);

    const started = await untilPastAds(b, (s) => s.started && s.playing, 180000, 420000, 200);
    const ttfs = Date.now() - t0;
    timings.short = ttfs;
    // The deck on air: the set opens on deck B instead when the first song's ad runs long while the second
    // is cued (fullset SWAP_AFTER_S) — deck A then still shows its (silent) ad. What the player reports
    // arrives a few hundred ms after the command: give its report up to 2 s to catch up.
    const onAir = (s) => (s && s.cur ? s.decks[s.cur.deck] : null);
    const sounding = (s) => !!onAir(s) && onAir(s).state === 'playing' && onAir(s).muted === false && onAir(s).player > 50;
    const first = started && ((await until(b, sounding, 2000, 100)) || (await state(b)));
    if (!check(G, 'the first song plays with sound once its ad is over', sounding(first), first && onAir(first) ? `time to first sound ${(ttfs / 1000).toFixed(1)} s after Enter (app: ${first.firstSoundMs} ms), deck ${'AB'[first.cur.deck]} volume ${onAir(first).player}, ad ${onAir(first).ad.toFixed(0)} s${first.cur.deck === 1 ? ' (opened with the second song: the first one’s ad ran long)' : ''}` : where(first || (await state(b))))) return;
    const fs0 = await state(b);
    check(G, 'the address bar links to this set with its track length', new RegExp(`\\?p=${SPOTIFY_ID}&seed=${fs0.seed}&vibe=0\\.5&len=short`).test(fs0.url), fs0.url.replace(b.site.prefix, '/'));

    // REC: a tap explains itself and records nothing
    await b.page.click('[data-ref="rec"]');
    const recT = await until(b, (s) => s.dom.toasts.some((t) => /recorded/.test(t)), 3000, 100);
    check(G, 'a tap on REC says why it is off and records nothing', !!recT && !recT.dom.recPressed, recT ? `"${recT.dom.toasts.find((t) => /recorded/.test(t))}"` : '');

    // ── two or more transitions, watched ──
    await peek(b, startSampler);
    const seen = { tv: new Set(), labels: new Set(), rows: new Set(), shotMix: false, shotPlay: false, curDecks: [], positions: [], covered: [] };
    const watchEnd = Date.now() + 420000;
    let last = null;
    while (Date.now() < watchEnd) {
      const s = await state(b);
      last = s;
      if (s.tv) {
        seen.tv.add(s.tv.state);
        seen.labels.add(s.tv.label);
      }
      for (const k of Object.keys(s.setlist)) seen.rows.add(k);
      if (s.cur) seen.curDecks.push(s.cur.deck);
      // (a video on air: a song that has ended waits for the next one, and a preview stand-in plays in Web
      // Audio with its YouTube deck idle — neither has a player position that moves)
      if (s.cur && s.cur.provider === 'youtube' && s.cur.phase === 'live' && s.decks[s.cur.deck]) seen.positions.push({ wall: Date.now(), id: s.cur.id, pos: s.decks[s.cur.deck].pos });
      if (!seen.shotPlay && s.started && s.tv && s.tv.state === 'upcoming' && s.now > 6) {
        seen.shotPlay = true;
        await shot(b, 'full-playing-1440x900.png');
      }
      if (!seen.shotMix && s.tv && s.tv.state === 'active' && s.decks.every((x) => x.state === 'playing' && x.sent > 15)) {
        seen.shotMix = true;
        await shot(b, 'full-crossfade-1440x900.png');
        seen.covered.push(await peek(b, probePlayers));
      }
      const done = s.history.filter((h, i) => i > 0 && h.tEnd > 0 && h.tEnd < s.now - 0.5);
      if (done.length >= 2 && seen.shotMix) break;
      await sleep(400);
    }
    const samples = await takeSamples(b);
    const done = last.history.filter((h, i) => i > 0 && h.tEnd > 0 && h.tEnd < last.now - 0.5);
    timings.transitions = done.length;
    check(G, 'at least two transitions happen', done.length >= 2, `${done.length} done in ${last.now.toFixed(0)} s of set time: ${done.map((h) => `${h.label} at ${h.tStart.toFixed(0)} s`).join(' → ')}`);
    const swaps = seen.curDecks.filter((d, i) => i > 0 && d !== seen.curDecks[i - 1]).length;
    check(G, 'the decks swap at every transition (A → B → A …)', swaps >= 2 && last.history.every((h, i) => i === 0 || h.deck !== last.history[i - 1].deck), `${swaps} swaps; decks ${last.history.map((h) => 'AB'[h.deck]).join('')}`);
    // volume lanes: what the deck was told vs the lane at that moment (one 50 ms tick of slack), and what the player reports
    let worst = 0;
    let worstPlayer = 0;
    let n = 0;
    let both = 0;
    for (const x of samples) {
      if (!x.lanes || !x.cur || !x.nxt || x.t < x.lanes.tStart - 0.4 || x.t > x.lanes.tEnd) continue;
      const vol = Math.min(1, x.vol);
      for (const [rec, lane] of [[x.cur, x.lanes.outVol], [x.nxt, x.lanes.incVol]]) {
        if (rec.provider !== 'youtube' || x.st[rec.deck] !== 'playing') continue;
        const lo = Math.min(volumeAt(lane, x.t - 0.08), volumeAt(lane, x.t)) * vol * 100;
        const hi = Math.max(volumeAt(lane, x.t - 0.08), volumeAt(lane, x.t)) * vol * 100;
        const s = x.sent[rec.deck];
        const err = s < lo - 1.01 ? lo - 1 - s : s > hi + 1.01 ? s - hi - 1 : 0;
        worst = Math.max(worst, err);
        if (typeof x.player[rec.deck] === 'number') worstPlayer = Math.max(worstPlayer, Math.abs(x.player[rec.deck] - s));
        n++;
      }
      if (x.st[0] === 'playing' && x.st[1] === 'playing' && x.sent[0] > 5 && x.sent[1] > 5) both++;
    }
    check(G, 'deck volumes follow the transition’s volume lanes (sampled at 20 Hz)', n >= 20 && worst <= 2, `${n} samples in transitions, worst miss ${worst.toFixed(1)} % of full scale; the players reported within ${worstPlayer} of what they were told; ${both} samples with both decks audible`);
    // positions advance with the clock
    const pos = seen.positions;
    let adv = 0;
    let stuck = 0;
    for (let i = 1; i < pos.length; i++) {
      if (pos[i].id !== pos[i - 1].id) continue;
      const dw = (pos[i].wall - pos[i - 1].wall) / 1000;
      const dp = pos[i].pos - pos[i - 1].pos;
      if (dw > 0.2) {
        if (dp > 0.5 * dw) adv++;
        else stuck++;
      }
    }
    check(G, 'the song positions advance in real time', adv > 50 && stuck <= adv * 0.05, `${adv} looks advanced, ${stuck} did not (a buffering stall or a mid-roll ad counts here)`);
    check(G, 'the ticker went starting → upcoming → active', seen.tv.has('upcoming') && seen.tv.has('active'), [...seen.tv].join(', ') + (seen.tv.has('waiting') ? ' (waited for an ad on the way: the song on air played on)' : ''));
    check(G, 'the setlist shows played / playing / next rows', seen.rows.has('played') && seen.rows.has('playing') && seen.rows.has('next'), [...seen.rows].join(', '));
    const cov = seen.covered[0] || (await peek(b, probePlayers));
    check(G, 'mid-crossfade: both players visible, ≥ 200×200, opaque, uncovered', playersOk(cov), playersSay(cov));

    // ── Skip when the next song is cued ──
    const ready = await untilPastAds(b, (s) => s.nxt && s.nxt.phase === 'cued' && s.canSkip && !s.dom.skipDisabled && s.lanes && s.lanes.tStart > s.now + 4, 240000, 480000);
    if (check(G, 'Skip is offered once the next song is cued', !!ready, ready ? `next song cued, its transition planned ${(ready.lanes.tStart - ready.now).toFixed(0)} s away` : where(await state(b)))) {
      await b.page.click('[data-ref="skip"]');
      const q = await until(b, (s) => s.lanes && s.lanes.tStart !== ready.lanes.tStart, 3000, 50);
      check(G, 'Skip: a quick transition into the cued song, at once', !!q && q.lanes.tStart - ready.now < 1.6 && q.lanes.tEnd - q.lanes.tStart <= 3.05 && q.nxt.id === ready.nxt.id, q ? `${q.history[q.history.length - 1].label}: starts ${(q.lanes.tStart - ready.now).toFixed(2)} s after the click, lasts ${(q.lanes.tEnd - q.lanes.tStart).toFixed(2)} s` : 'no new plan');
      const after = await until(b, (s) => s.cur && s.cur.id === ready.nxt.id && s.decks[s.cur.deck].state === 'playing', 12000, 200);
      check(G, 'the skipped-to song is on air', !!after);
    }

    // ── Preview: hand over to 30-second clips without a gap ──
    const beforePrev = await state(b);
    await peek(b, startGapWatch);
    const tPrev = Date.now();
    await b.page.click('input[name="segue-mode"][value="preview"]').catch(() => b.page.evaluate(() => document.querySelector('input[name="segue-mode"][value="preview"]').click()));
    const prev = await until(b, (s) => s.active === 'preview' && !s.handoff && s.stage === 'waves' && s.started && s.playing, 60000, 150);
    timings.toPreview = Date.now() - tPrev;
    const gap1 = await takeGap(b);
    if (check(G, 'switch to Preview: the previews take over in Web Audio', !!prev, prev ? `${(timings.toPreview / 1000).toFixed(1)} s from the tap to the end of the crossfade` : JSON.stringify((await state(b)).handoff))) {
      check(G, 'switch to Preview: no gap longer than 1 s', gap1.longest <= 1000 && gap1.samples > 20, `longest silence ${Math.round(gap1.longest)} ms over ${gap1.samples} looks`);
      await sleep(2500);
      const lv = [];
      for (let i = 0; i < 12; i++) {
        lv.push((await state(b)).previewRms);
        await sleep(250);
      }
      lv.sort((a, b2) => a - b2);
      const pv = await state(b);
      check(G, 'Preview: Web Audio levels > 0, players stopped, REC available again', lv[6] > 0.01 && pv.decks.every((x) => x.state !== 'playing') && !pv.dom.recDisabled, `median level ${lv[6].toFixed(3)}, decks ${pv.decks.map((x) => x.state).join('/')}, rec disabled ${pv.dom.recDisabled}`);
      check(G, 'Preview: the address bar says len=preview', /&len=preview/.test(pv.url), pv.url.replace(b.site.prefix, '/'));
      // the set goes on in the other conductor rather than restarting (F10): no song heard in full opens the
      // previews, the setlist keeps them as played, Elapsed goes on — through the wait for the first clip too
      const heardFull = beforePrev.played || [];
      const pvOpener = await peek(b, () => {
        const h = window.__segue.conductor.history();
        return h.length ? h[0].trackId : '';
      });
      check(G, 'Preview: the running order goes on — no song just heard in full is played again, the setlist keeps them, Elapsed continues', heardFull.length > 0 && !!pvOpener && !heardFull.includes(pvOpener) && heardFull.every((id) => prev.played.includes(id)) && prev.elapsed >= beforePrev.elapsed + timings.toPreview / 1000 - 1.5, `${heardFull.length} heard in full; the previews opened with ${heardFull.includes(pvOpener) ? 'one of them' : 'a new song'}; played rows ${prev.played.length}; Elapsed ${beforePrev.elapsed.toFixed(0)} s → ${prev.elapsed.toFixed(1)} s after a ${(timings.toPreview / 1000).toFixed(1)} s switch`);
      await shot(b, 'full-preview-1440x900.png');
    }

    // ── back to Medium: the previews play on until the first song (after its ad) fades in ──
    const beforeMed = await state(b);
    await peek(b, startGapWatch);
    const tMed = Date.now();
    await b.page.click('input[name="segue-mode"][value="medium"]').catch(() => b.page.evaluate(() => document.querySelector('input[name="segue-mode"][value="medium"]').click()));
    const during = await until(b, (s) => s.stage === 'video' && !!s.handoff, 5000, 100);
    if (during) {
      await sleep(4000);
      const mid = await state(b);
      check(G, 'back to Medium: the previews play on under the video stage while the first song pre-rolls', mid.previewRms > 0.003 && !!mid.handoff && mid.decks.some((x) => x.state === 'ad' || x.state === 'loading' || x.state === 'cued'), `preview level ${mid.previewRms.toFixed(3)}, decks ${mid.decks.map((x) => x.state).join('/')}`);
      check(G, 'during the switch the page says what is true: Pause button, "Switching to full songs"', mid.dom.playLabel === 'Pause' && mid.dom.ticker === 'Switching to full songs' && /previews play on/.test(mid.dom.why), `button "${mid.dom.playLabel}", ticker "${mid.dom.ticker} · ${mid.dom.why}"`);
      await shot(b, 'full-handover-1440x900.png');
    }
    const med = await untilPastAds(b, (s) => s.active === 'full' && !s.handoff && s.started && s.playing && s.mode === 'medium', 200000, 420000, 250);
    timings.toMedium = Date.now() - tMed;
    const gap2 = await takeGap(b);
    if (check(G, 'back to Medium: full songs take over', !!med, med ? `${(timings.toMedium / 1000).toFixed(1)} s from the tap (the first song’s ad included)` : JSON.stringify((await state(b)).handoff))) {
      check(G, 'back to Medium: no gap longer than 1 s', gap2.longest <= 1000, `longest silence ${Math.round(gap2.longest)} ms over ${gap2.samples} looks`);
      check(G, 'Medium: the address bar says len=medium, REC is off again', /&len=medium/.test(med.url) && med.dom.recDisabled, med.url.replace(b.site.prefix, '/'));
      // the set goes on rather than restarting: no song heard before the switch opens the full-song set,
      // what was played stays in the setlist, Elapsed continues
      const heard = beforeMed.played || [];
      const opener = med.history.length ? med.history[0].trackId : '';
      // (Elapsed: the previews played on through the first song's ad, so that time counts too)
      check(G, 'back to Medium: the running order goes on — no song just heard is played again, the setlist keeps them, Elapsed continues', heard.length > 0 && !heard.includes(opener) && heard.every((id) => med.played.includes(id)) && med.elapsed >= beforeMed.elapsed + timings.toMedium / 1000 - 2, `${heard.length} heard before the switch; the full-song set opened with ${heard.includes(opener) ? 'one of them' : 'a new song'}; played rows ${med.played.length}; Elapsed ${beforeMed.elapsed.toFixed(0)} s → ${med.elapsed.toFixed(1)} s after a ${(timings.toMedium / 1000).toFixed(1)} s switch`);
      const pl = await peek(b, probePlayers);
      check(G, 'Medium: both players visible, ≥ 200×200, opaque, uncovered', playersOk(pl), playersSay(pl));
    }
    // ── New set: same crate, new seed — and the music does not stop for the new first song's ad ──
    if (med) {
      await peek(b, startGapWatch);
      const before = await state(b);
      const tNew = Date.now();
      await b.page.click('[data-ref="newset"]');
      const kept = await until(b, (s) => s.seed !== before.seed, 3000, 100);
      check(G, 'New set: a new seed at once, and the song on air plays on while the new first song pre-rolls', !!kept && kept.started && kept.playing && kept.decks.some((x) => x.state === 'playing') && kept.url.includes(`seed=${kept.seed}`), kept ? `#${before.seed} → #${kept.seed}; decks ${kept.decks.map((x) => x.state).join('/')}` : '');
      let ranOut = false; // the bridging song ended while the new first song was still in its ad
      const fresh = await untilPastAds(
        b,
        (s) => {
          if (s.cur && s.cur.phase === 'ended' && s.nxt && s.nxt.phase === 'cueing') ranOut = true;
          return s.seed !== before.seed && s.history.length >= 2 && s.history[1].tEnd > 0 && s.history[1].tEnd < s.now && s.cur && s.cur.id === s.history[1].playId;
        },
        200000,
        480000,
      );
      timings.newSet = Date.now() - tNew;
      const gap3 = await takeGap(b);
      // When YouTube's ad for the new first song outlasts the song on air, the set does what it does in
      // front at any time: SILENT_WAIT_S (12 s) of silence, then that song's preview (or the song itself if
      // its ad ends first). Otherwise no gap over 1 s.
      const allowed = ranOut ? 12000 + 2500 : 1000;
      const inc = fresh && fresh.history[1];
      check(G, 'New set: the new running order’s first song comes in with a quick move, no gap longer than 1 s (or, when its ad outlasted the song on air, the 12 s silence rule)', !!fresh && gap3.longest <= allowed && (!ranOut || inc.provider === 'youtube' || inc.previewWhy === 'slow'), fresh ? `${inc.label} (${inc.provider}${inc.previewWhy ? `, ${inc.previewWhy}` : ''}) ${(timings.newSet / 1000).toFixed(1)} s after the tap (its ad included); longest silence ${Math.round(gap3.longest)} ms${ranOut ? '; the song on air ran out first' : ''}` : `longest silence ${Math.round(gap3.longest)} ms; ${where(await state(b))}`);
    }

    const end = await state(b);
    check(G, 'no Content-Security-Policy violations', end.csp.length === 0, end.csp.slice(0, 3).join(' | '));
    check(G, 'no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

// ── group: share links — without len (old links: previews), with len=full (full songs, real tap) ─

async function groupShare() {
  const G = 'share';
  const b = await open({ width: 1280, height: 800 });
  try {
    // a returning visitor who prefers Short: the links' own length must win
    await setPrefs(b, 'short');
    await b.page.goto(b.site.url(`index.html?p=${SPOTIFY_ID}&seed=e2eold&vibe=0.5`), { waitUntil: 'load' });
    const old = await until(b, (s) => s.screen === 'ready' || s.screen === 'stage', 30000, 200);
    check(G, 'a link without len keeps its old meaning: 30-second previews behind "Start the set"', !!old && old.screen === 'ready' && old.active === 'preview' && old.dom.modeChecked === 'preview', old ? `screen ${old.screen}, ${old.active}, track length ${old.dom.modeChecked}` : '');

    await b.page.goto(b.site.url(`index.html?p=${SPOTIFY_ID}&seed=e2efull&vibe=0.5&len=full`), { waitUntil: 'load' });
    const land = await until(b, (s) => s.screen === 'stage' && s.active === 'full' && s.decks.length === 2, 30000, 200);
    if (!check(G, 'a link with len=full opens the video stage in Full, no tap yet', !!land && land.mode === 'full' && land.dom.modeChecked === 'full' && !land.started, land ? `mode ${land.mode}, control ${land.dom.modeChecked}` : JSON.stringify((await state(b)).screen))) return;
    const ad = await until(b, (s) => s.decks[0].state === 'ad' || s.decks[0].state === 'cued', 60000, 250);
    check(G, 'before any tap: the first song pre-rolls muted (no gesture needed) and nothing is audible', !!ad && !ad.started && ad.decks[0].muted !== false && ad.dom.playLabel === 'Play', ad ? `deck A ${ad.decks[0].state}, muted ${ad.decks[0].muted}, button "${ad.dom.playLabel}"` : '');
    const tTap = Date.now();
    await b.page.click('[data-ref="play"]'); // the one real user gesture
    // (the deck on air: when the first song's ad runs long, the set opens with the second song on deck B)
    const onAir = (s) => (s.cur && s.decks[s.cur.deck]) || s.decks[0];
    const first = await untilPastAds(b, (s) => s.started && s.playing && onAir(s).state === 'playing', 300000, 420000, 200);
    timings.full = Date.now() - tTap;
    const heardFirst = first && (await until(b, (s) => onAir(s).muted === false && onAir(s).player > 0, 2000, 200));
    check(G, 'one tap on Play: the first song starts with sound once its ad is over (real autoplay policy)', !!heardFirst, first ? `time to first sound ${(timings.full / 1000).toFixed(1)} s after the tap, on deck ${'AB'[first.cur ? first.cur.deck : 0]}${heardFirst ? `, volume ${onAir(heardFirst).player}` : `, muted ${onAir(first).muted}, volume ${onAir(first).player}`}` : JSON.stringify((await state(b)).decks));
    if (first) {
      check(G, 'the set is the link’s: seed and track length', first.seed === 'e2efull' && /&len=full/.test(first.url) && first.mode === 'full', first.url.replace(b.site.prefix, '/'));
      // (from the leave estimate: the plan itself waits for the next song's ad, which can take minutes)
      const est = await until(b, (s) => s.leaveAt > 0 && s.decks[0].dur > 0, 10000, 250);
      const dur = est ? est.decks[0].dur : 0;
      check(G, 'Full: the first song is to be left near its end (an 8-20 s outro guard plus the move)', !!est && est.leaveAt > dur - 50 && est.leaveAt < dur - 8, est ? `leave at ${est.leaveAt.toFixed(0)} s of ${dur.toFixed(0)} s; deck B ${est.decks[1].state} (ad ${est.decks[1].ad.toFixed(0)} s)` : JSON.stringify((await state(b)).decks));
    }
    const end = await state(b);
    check(G, 'no CSP violations, no console errors', end.csp.length === 0 && ownErrors(b).length === 0, [...end.csp, ...ownErrors(b)].slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

// ── group: phone — Short, the players fit, and a video that will not embed falls back to its preview ─

async function groupPhone() {
  const G = 'phone';
  const b = await open({ width: 390, height: 844, mobile: true });
  try {
    await setPrefs(b, 'short');
    // The second video looked up gets a well-formed id that does not exist: the player answers error
    // 150 at play time, exactly like a label upload that refuses to embed. Patched in the page, before
    // the app starts, without touching the app's own files.
    await b.page.evaluateOnNewDocument(() => {
      const iv = setInterval(() => {
        const g = window.__segue;
        if (!g || !g.finder) return;
        clearInterval(iv);
        const find = g.finder.find;
        let n = 0;
        window.__bogus = null;
        g.finder.find = async (track, opts) => {
          const v = await find(track, opts);
          if (++n === 2) {
            window.__bogus = track.id;
            return { ...v, videoId: 'AAAAAAAAAAA', alternates: [] };
          }
          return v;
        };
      }, 5);
    });
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    const t0 = Date.now();
    await b.page.tap('#segue-input');
    await b.page.keyboard.type(SPOTIFY_URL, { delay: 1 });
    await b.page.keyboard.press('Enter');
    const ad = await until(b, (s) => s.stage === 'video' && s.decks.length === 2 && (s.decks[0].state === 'ad' || s.started), 60000, 250);
    if (ad) {
      await sleep(1200);
      await shot(b, 'full-phone-ad-390x844.png');
      const pl = await peek(b, probePlayers);
      check(G, 'phone: both players ≥ 200×200, on screen, opaque, uncovered', playersOk(pl), playersSay(pl));
      check(G, 'phone: no horizontal overflow', ad.overflowX <= 0, `${ad.overflowX}`);
    } else check(G, 'phone: the video stage appears', false);
    const first = await untilPastAds(b, (s) => s.started && s.playing, 180000, 420000, 250);
    timings.phoneShort = Date.now() - t0;
    if (!check(G, 'phone: the first song plays', !!first, first ? `time to first sound ${(timings.phoneShort / 1000).toFixed(1)} s` : '')) return;
    // the refused video → no alternates → its 30-second preview through Web Audio
    const fb = await until(b, (s) => s.nxt && s.nxt.provider === 'preview' && s.nxt.phase === 'cued', 60000, 300);
    check(G, 'a video that refuses to embed (error 150) falls back to the song’s preview', !!fb, fb ? `the second song plays its preview: ${JSON.stringify(fb.nxt)}` : JSON.stringify((await state(b)).nxt));
    if (fb) {
      const live = await until(b, (s) => s.cur && s.cur.provider === 'preview' && s.rms > 0.005, 150000, 250);
      if (check(G, 'the preview fallback plays through the Web Audio engine after a transition', !!live, live ? `level ${live.rms.toFixed(3)}, deck ${'AB'[live.cur.deck]} shows ${live.deckViews[live.cur.deck].provider}` : '')) {
        await sleep(600);
        const cap = await state(b);
        check(G, 'the fallback deck says there is no video and its 30-s preview plays', cap.cur && /No video · its 30-s preview/.test(cap.dom.vstatus[cap.cur.deck] || ''), `"${cap.dom.vstatus.join('" | "')}"`);
        // the refused video was given up: YouTube's "Video unavailable" (or a paused ad) must not stay on the
        // deck the preview now plays on — its player is stopped back to its plain start screen (stopVideo)
        const scr = cap.cur ? await deckScreen(b, cap.cur.deck) : null;
        check(G, 'the fallback deck’s player shows neither YouTube’s error screen nor an ad (stopVideo() on the refused deck)', !!scr && !scr.error && !scr.ad, scr ? `player: ${scr.mode || '?'}${scr.error ? `, error screen “${scr.errorText}”` : ''}${scr.ad ? ', ad' : ''}; deck ${cap.decks[cap.cur.deck].state}` : 'player frame not found');
        await shot(b, 'full-phone-preview-fallback-390x844.png');
      }
    }
    await shot(b, 'full-phone-playing-390x844.png');
    const end = await state(b);
    check(G, 'phone: no CSP violations, no console errors', end.csp.length === 0 && ownErrors(b).length === 0, [...end.csp, ...ownErrors(b)].slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

// ── group: a real background tab ───────────────────────────────────────────────────────────────
//
// The owner listens with other tabs in front. browser.mjs passes --disable-background-timer-throttling,
// which hides what Chrome really does to a hidden page, so this group launches Chrome without it.
// Measured (2026-10-05): Chrome pauses a player that has only ever played MUTED when its tab is hidden
// and will not start a new video on it there (cue → 'blocked'); a player that has never played cannot
// start at all until the tab is shown. What must hold whatever the deck does about that: nothing is
// refused or forgotten for it, nothing counts towards "YouTube does not work here", the set is not handed
// to Preview, and once the tab is in front the held songs load. Where the deck pre-rolls unmuted at
// volume 0 (deck.unlock exists), the set must also start and play nothing but full songs while hidden.

async function openBackgroundTab({ width = 1280, height = 800 } = {}) {
  // Chrome's real autoplay policy AND its real background-tab throttling (timers at most once a second)
  const b = await open({ width, height, realBackground: true });
  const page = b.page;
  // every finder.forget and every failed cue, with its code (a forget must follow a refusal)
  await page.evaluateOnNewDocument(() => {
    window.__bg = { forgot: [], fails: [], plays: [] };
    const iv = setInterval(() => {
      const g = window.__segue;
      if (!g || !g.decks || !g.finder) return;
      clearInterval(iv);
      const f0 = g.finder.forget;
      g.finder.forget = function (track, id) {
        window.__bg.forgot.push({ track: track && track.id, id, hidden: document.hidden });
        return f0 && f0.apply(this, arguments);
      };
      g.decks.forEach((d, i) => {
        const cue = d.cue;
        d.cue = function (...args) {
          const p = cue.apply(this, args);
          Promise.resolve(p).catch((e) => window.__bg.fails.push({ deck: i, code: e && e.code, hidden: document.hidden }));
          return p;
        };
      });
    }, 20);
  });
  return b;
}

async function backgroundRun(G, how) {
  const b = await openBackgroundTab();
  const REFUSALS = [2, 5, 100, 101, 150];
  try {
    await setPrefs(b, 'short');
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    await pasteAndGo(b, SPOTIFY_URL);
    if (how === 'ad') {
      const ad = await until(b, (s) => s.decks.length === 2 && (s.decks[0].state === 'ad' || s.started), 90000, 250);
      if (!check(G, `${how}: the first song’s pre-roll runs`, !!ad && !ad.started, ad ? `deck A ${ad.decks[0].state}` : 'no ad seen')) return;
      await sleep(3000);
    } else {
      const first = await untilPastAds(b, (s) => s.started && s.playing, 240000, 420000, 250);
      if (!check(G, `${how}: the set starts in front`, !!first)) return;
      await sleep(5000);
    }
    const front = await state(b);
    const toFront = await sendToBackground(b.page);
    await sleep(500);
    await peek(b, startGapWatch);
    const samples = [];
    const HIDDEN_S = 180;
    for (let k = 0; k < HIDDEN_S / 5; k++) {
      await sleep(5000);
      samples.push(await state(b));
    }
    const hiddenEnd = samples[samples.length - 1];
    const gap = await takeGap(b);
    const bg = await peek(b, () => window.__bg);
    check(G, `${how}: the page really was in a background tab`, samples.every((x) => x.hidden), `${samples.filter((x) => x.hidden).length}/${samples.length} looks hidden`);
    const badForget = bg.forgot.filter((f) => !bg.fails.some((x) => REFUSALS.includes(Number(x.code))));
    check(G, `${how}: nothing forgotten from the finder’s cache for a background-tab failure`, badForget.length === 0, `${bg.forgot.length} forgotten, ${bg.fails.length} failed cues (${bg.fails.map((x) => `${x.code}${x.hidden ? ' hidden' : ''}`).join(', ') || 'none'})`);
    check(G, `${how}: not handed to Preview, nothing counted as a broken player while hidden`, samples.every((x) => x.active === 'full' && !x.unavailable) && hiddenEnd.cues.failed === front.cues.failed, `cues failed ${front.cues.failed} → ${hiddenEnd.cues.failed}; ${hiddenEnd.unavailable || 'no hand-over'}`);
    // what the decks did while hidden (one entry per change): the evidence behind the checks below
    const trace = [];
    for (const x of samples) {
      const sig = `${x.now.toFixed(0)}s ${x.decks.map((d) => `${d.state}(ps${d.ps} v${d.player}${d.muted ? 'm' : ''})`).join('/')} ${x.cur ? `${x.cur.provider}:${x.cur.phase}` : '-'}→${x.nxt ? `${x.nxt.provider}:${x.nxt.phase}` : '-'}${x.paused ? ' PAUSED' : ''}${x.needsTap ? ' TAP' : ''} leave ${Number.isFinite(x.leaveAt) ? x.leaveAt.toFixed(0) : '?'} previews ${x.previews}`;
      if (!trace.length || trace[trace.length - 1].slice(trace[trace.length - 1].indexOf(' ')) !== sig.slice(sig.indexOf(' '))) trace.push(sig);
    }
    note(G, `${how}: while hidden — ${trace.slice(0, 16).join(' | ')}`);
    // the next song's pre-roll as the conductor saw it, per 5 s look (ad clock, seconds since it last grew, held)
    note(G, `${how}: next song per look — ${samples.map((x) => (x.nxt ? `${x.now.toFixed(0)}s ${x.nxt.provider}:${x.nxt.phase}${x.nxt.held ? ' HELD' : ''}${x.nxt.previewWhy ? ` (${x.nxt.previewWhy})` : ''} ad ${x.nxt.adSeen != null ? Number(x.nxt.adSeen).toFixed(0) : '?'} still ${x.nxt.adStillS != null ? x.nxt.adStillS.toFixed(0) : '-'}` : '-')).join(' | ')}`);
    // (a song pre-rolled while the tab was in front that starts while it is hidden came in while hidden too)
    const heardInFront = (h) => front.history.some((x) => x.playId === h.playId && (x.phase === 'live' || x.phase === 'done' || x.phase === 'ended'));
    const hiddenPlays = hiddenEnd.history.filter((h) => !heardInFront(h) && (h.phase === 'live' || h.phase === 'done' || h.phase === 'ended'));
    note(G, `${how}: hidden ${HIDDEN_S} s — set ${hiddenEnd.started ? `at ${hiddenEnd.now.toFixed(0)} s` : 'not started'}, ${hiddenPlays.length} songs came in while hidden (${hiddenPlays.map((h) => h.provider).join(', ') || 'none'}), longest silence ${(gap.longest / 1000).toFixed(1)} s (sampled ${gap.samples}× on ${gap.worker ? 'a worker clock' : 'page timers'}); deck.unlock ${front.canUnlock ? 'present' : 'absent'}; full-song clock on ${hiddenEnd.workerClock ? 'its worker' : 'page timers'}`);
    // On time: each full song that came in while hidden started when its plan said (heardAt = the set time
    // its player reported PLAYING; the plan's incStart), and each song it replaced was left near its plan.
    const handovers = hiddenPlays.filter((h) => h.provider === 'youtube' && h.type !== 'start' && Number.isFinite(h.heardAt) && h.incStart > 0);
    const lateness = handovers.map((h) => h.heardAt - h.incStart);
    const outs = hiddenEnd.history.filter((h) => handovers.some((x) => x.playId === h.playId + 1) && Number.isFinite(h.leaveAt) && Number.isFinite(h.startedAt));
    note(G, `${how}: hand-overs while hidden — ${handovers.map((h, i) => `${h.type} ${lateness[i] >= 0 ? '+' : ''}${lateness[i].toFixed(1)} s vs plan`).join(', ') || 'none'}; songs left at ${outs.map((h) => `${h.leaveAt.toFixed(0)} s`).join(', ') || '-'} of each song`);
    // (no full-song hand-over while hidden — e.g. the first song started there after a long ad — leaves nothing to time)
    if (front.canUnlock && handovers.length) check(G, `${how}: every full song that came in while hidden started on time (within 2 s of its plan)`, lateness.every((x) => Math.abs(x) <= 2), lateness.map((x) => x.toFixed(1)).join(', '));
    // ≥ 2 songs in 180 s — unless the next song's ad ran (moving) through most of the hidden stretch: YouTube
    // served pods of 3-4 minutes at night (2026-10-06); the song on air then plays on, as in front
    const adLooks = samples.filter((x) => x.nxt && x.nxt.provider === 'youtube' && x.nxt.phase === 'cueing' && x.nxt.adStillS != null && x.nxt.adStillS < 20);
    const oneLongAd = adLooks.length >= 0.6 * samples.length && hiddenPlays.length <= 1;
    if (how === 'play') check(G, `${how}: the set plays on in the background (no silence over 15 s; ≥ 2 songs in, or the next song's ad still running)`, hiddenEnd.started && gap.longest <= 15000 && (hiddenPlays.length >= 2 || oneLongAd), `${hiddenPlays.length} songs in, longest silence ${(gap.longest / 1000).toFixed(1)} s${oneLongAd ? `; the next song's ad was moving in ${adLooks.length}/${samples.length} looks` : ''}`);
    if (front.canUnlock) {
      // (not started: then both first songs' ads must have kept moving while hidden — the ad's length, not a
      // background tab that holds the players still)
      const adRun = [0, 1].map((i) => {
        const inAd = samples.filter((x) => x.decks[i] && x.decks[i].state === 'ad');
        return inAd.length >= 2 ? Number(inAd[inAd.length - 1].decks[i].ad) - Number(inAd[0].decks[i].ad) : 0;
      });
      const adsRanHidden = !hiddenEnd.started && samples.every((x) => x.decks.some((d) => d.state === 'ad')) && Math.max(...adRun) >= 0.8 * (HIDDEN_S - 10);
      if (how === 'ad') check(G, `${how}: the set starts while the tab is hidden (or both first ads run on there the whole time)`, (hiddenEnd.started && hiddenEnd.playing) || adsRanHidden, hiddenEnd.started ? `at ${hiddenEnd.now.toFixed(0)} s of set time` : `not started; ad clocks moved ${adRun.map((x) => x.toFixed(0)).join(' / ')} s while hidden`);
      // A preview that came in because the next song's ad was still running when the song on air had ended
      // and SILENT_WAIT_S had passed ('slow': YouTube's ad length, the same rule in front) is not the
      // background tab's doing; any other preview (held, stood in for, 'background') is.
      const longAd = (h) => h.provider === 'preview' && h.previewWhy === 'slow';
      if (hiddenPlays.length) check(G, `${how}: every song that came in while hidden is a full song (pre-rolled unmuted at volume 0), apart from previews after an ad that outlasted the song on air`, hiddenPlays.some((h) => h.provider === 'youtube') && hiddenPlays.every((h) => h.provider === 'youtube' || longAd(h)), hiddenPlays.map((h) => (h.provider === 'preview' ? `preview (${h.previewWhy || '?'})` : h.provider)).join(', '));
      else note(G, `${how}: no song came in while hidden (checked above: the set played on)`);
    } else note(G, `${how}: the deck pre-rolls muted only (no deck.unlock): songs held by the background tab are expected; the full-song-only checks are skipped`);
    await toFront();
    const back = await untilPastAds(b, (s) => s.started && s.playing && s.cur && s.cur.provider === 'youtube' && !s.held.some(Boolean) && (!s.nxt || s.nxt.provider === 'youtube'), 150000, 420000, 500);
    check(G, `${how}: back in front, full songs again (held songs load, nothing stays held)`, !!back, back ? `set at ${back.now.toFixed(0)} s, on air ${back.cur.provider}, next ${back.nxt ? `${back.nxt.provider} (${back.nxt.phase})` : 'none yet'}` : JSON.stringify({ cur: (await state(b)).cur, nxt: (await state(b)).nxt }));
    check(G, `${how}: no console errors`, ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

async function groupBackground() {
  const G = 'background';
  const one = process.env.SEGUE_BG_ONLY; // 'ad' | 'play': one of the two runs
  if (one) {
    await backgroundRun(G, one).catch((err) => check(G, `${one}: ran to completion`, false, String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : err)));
    return;
  }
  await Promise.all([backgroundRun(G, 'ad').catch((err) => check(G, 'ad: ran to completion', false, String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : err))), sleep(3000).then(() => backgroundRun(G, 'play')).catch((err) => check(G, 'play: ran to completion', false, String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : err)))]);
}

// ── group: New set in the middle of a move, then Home and a link that fails to load ────────────

async function groupMoves() {
  const G = 'moves';
  const b = await open({ width: 1280, height: 800 });
  try {
    await setPrefs(b, 'short');
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    await pasteAndGo(b, SPOTIFY_URL);
    const first = await untilPastAds(b, (s) => s.started && s.playing, 240000, 420000, 250);
    if (!check(G, 'the set starts', !!first)) return;
    // New set from FX_LEAD before a move to its end: it used to reset both decks (silence for a whole ad)
    const inMove = await untilPastAds(b, (s) => s.lanes && s.nxt && s.now >= s.lanes.tStart - 1.3 && s.now < s.lanes.tEnd - 0.3, 200000, 480000, 80);
    if (check(G, 'a move is under way', !!inMove, inMove ? `${(inMove.now - inMove.lanes.tStart).toFixed(1)} s from its start` : where(await state(b)))) {
      await peek(b, startGapWatch);
      await clickRef(b, 'newset');
      const after = [];
      for (let k = 0; k < 40; k++) {
        await sleep(500);
        after.push(await state(b));
      }
      const gap = await takeGap(b);
      check(G, 'New set during a move: the move finishes and the music never stops (no reset, no new first-song ad to wait for)', after.every((x) => x.started && x.tv?.state !== 'starting') && gap.longest <= 1000 && after[after.length - 1].seed !== inMove.seed, `longest silence ${Math.round(gap.longest)} ms; seed #${inMove.seed} → #${after[after.length - 1].seed}; ${after.some((x) => x.tv?.state === 'starting') ? 'went back to "Starting the set"' : 'stayed on air'}`);
      const fresh = after[after.length - 1];
      // (the bridging song can be a 30-second preview, after an ad that outlasted the song before it)
      const bridging = fresh.history[0];
      const bridgeSounds = fresh.decks.some((x) => x.state === 'playing') || (!!bridging && bridging.provider === 'preview' && bridging.phase === 'live');
      check(G, 'New set during a move: the new order’s first song pre-rolls on the free deck, the bridging song plays on', fresh.history.length >= 1 && fresh.history.length <= 2 && bridgeSounds, `history ${fresh.history.map((h) => `${h.provider}:${h.phase}`).join(' → ')}; decks ${fresh.decks.map((x) => x.state).join('/')}`);
    }
    // Home, then a link that fails to load: no player may play behind the start screen
    await clickRef(b, 'home');
    await until(b, (s) => s.screen === 'landing', 5000, 100);
    await sleep(2000);
    await pasteAndGo(b, 'htps://open.spotfy.com/playlst/nothing-here');
    const looks = [];
    for (let k = 0; k < 20; k++) {
      await sleep(1000);
      looks.push(await peek(b, () => ({ screen: document.querySelector('#app').dataset.screen, ps: (window.__segue.decks || []).map((d) => d.debug().playerState), t: (window.__segue.decks || []).map((d) => +d.debug().currentTime || 0) })));
    }
    const moving = looks.length > 1 ? looks[looks.length - 1].t.map((t, i) => t - looks[0].t[i]) : [0, 0];
    check(G, 'after Home and a link that fails to load, no player plays behind the start screen', looks.every((x) => x.screen === 'landing' && !x.ps.includes(1)) && moving.every((m) => m < 1), `screens ${[...new Set(looks.map((x) => x.screen))].join('/')}; player states ${[...new Set(looks.flatMap((x) => x.ps))].join(',')}; players moved ${moving.map((m) => m.toFixed(1)).join(' / ')} s in 20 s`);
    check(G, 'no console errors', ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

// ── group: "Play previews instead" is for this set only ────────────────────────────────────────

async function groupPrefs() {
  const G = 'prefs';
  const b = await open({ width: 1280, height: 800 });
  try {
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' }); // a first visit: nothing stored
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    await pasteAndGo(b, SPOTIFY_URL);
    const starting = await until(b, (s) => s.screen === 'stage' && s.active === 'full' && s.tv && s.tv.state === 'starting', 30000, 200);
    if (!check(G, 'a first visit plays full songs (Medium) and the first song’s wait offers “Play previews instead”', !!starting && starting.mode === 'medium', starting ? `mode ${starting.mode}` : '')) return;
    await b.page.waitForSelector('[data-ref="tk-act"]:not([hidden])', { timeout: 10000 });
    await clickRef(b, 'tk-act');
    const prev = await until(b, (s) => s.active === 'preview' && !s.handoff, 30000, 200);
    const stored = await peek(b, () => JSON.parse(localStorage.getItem('segue:prefs') || '{}').mode || '');
    check(G, '“Play previews instead” switches this set to previews without storing Preview as the default', !!prev && stored !== 'preview', `set ${prev ? prev.active : '?'}; stored track length "${stored || '(none)'}"`);
    await clickRef(b, 'home');
    await until(b, (s) => s.screen === 'landing', 5000, 100);
    await pasteAndGo(b, SPOTIFY_URL);
    const again = await until(b, (s) => s.screen === 'stage' && s.loaded && s.active !== undefined, 30000, 200);
    const last = again || (await state(b));
    check(G, 'the next playlist plays full songs again', !!again && again.active === 'full' && again.mode === 'medium', `screen ${last.screen}, ${last.active}, mode ${last.mode}, loaded ${last.loaded}; input "${await peek(b, () => document.querySelector('#segue-input').value.slice(0, 80))}"`);
  } finally {
    await close(b);
  }
}

// ── group: leaving video mode within a second of a deck's loadVideoById ───────────────────────

/**
 * (In the page, before the app runs.) Notes every loadVideoById the YouTube players are sent, with its
 * performance.now() time, in window.__ytLoads: a trap on window.YT.Player, which the IFrame API defines
 * after this runs (the player's methods are own properties, so each new player is hooked). Changes
 * nothing else about the player.
 */
function ytLoadTrap() {
  window.__ytLoads = [];
  let yt;
  const note = (a) => window.__ytLoads.push({ t: performance.now(), id: typeof a[0] === 'string' ? a[0] : a[0] && a[0].videoId });
  const wrap = (fn) => (typeof fn === 'function' && !fn.__trap ? Object.assign(function (...a) { note(a); return fn.apply(this, a); }, { __trap: true }) : fn);
  const hookPlayer = (p) => {
    if (typeof p.loadVideoById === 'function') {
      p.loadVideoById = wrap(p.loadVideoById);
      return;
    }
    let real;
    Object.defineProperty(p, 'loadVideoById', { configurable: true, enumerable: true, get: () => real, set: (fn) => { real = wrap(fn); } });
  };
  const wrapClass = (P) => {
    if (typeof P !== 'function' || P.__wrapped) return P;
    const W = function (...args) {
      const p = new P(...args);
      hookPlayer(p);
      return p;
    };
    W.prototype = P.prototype;
    W.__wrapped = true;
    return W;
  };
  Object.defineProperty(window, 'YT', {
    configurable: true,
    get: () => yt,
    set: (v) => {
      yt = v;
      if (!v || typeof v !== 'object') return;
      let player = wrapClass(v.Player);
      Object.defineProperty(v, 'Player', { configurable: true, enumerable: true, get: () => player, set: (P) => { player = wrapClass(P); } });
    },
  });
}

/** One look at the players while the stage should be hidden (raw CDP). */
function stageLook() {
  const app = document.querySelector('#app');
  const frames = [...document.querySelectorAll('.vslot iframe')];
  return {
    t: performance.now(),
    screen: app.dataset.screen,
    stage: app.dataset.stage,
    active: window.__segue.active === window.__segue.fullset ? 'full' : 'preview',
    hidden: frames.length > 0 && frames.every((f) => !f.checkVisibility()),
    decks: (window.__segue.decks || []).map((d) => {
      const x = d.debug();
      return { state: d.state, err: d.error, ps: x.playerState, ct: Number(x.currentTime) || 0 };
    }),
  };
}

/**
 * Home, or "Play previews instead", pressed within a second of a deck's loadVideoById (the player is still
 * loading the video and ignores a pause): for 30 s after the video stage is hidden, no player may move —
 * not the API's getCurrentTime, not the <video> inside the player's own frame. (A video stopped while it
 * loaded used to start its ad ~10 s later anyway, then the song, muted in the display:none stage.)
 */
async function stopDuringLoad(G, how) {
  const b = await open({ width: 1280, height: 800 });
  try {
    await b.page.evaluateOnNewDocument(ytLoadTrap);
    await setPrefs(b, 'short');
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await b.page.waitForSelector('#segue-input', { timeout: 15000 });
    await pasteAndGo(b, SPOTIFY_URL);
    const ref = how === 'home' ? 'home' : 'tk-act';
    await b.page.waitForSelector(`[data-ref="${ref}"]:not([hidden])`, { timeout: 30000 });
    let load = null;
    for (const end = Date.now() + 90000; !load && Date.now() < end; ) {
      const loads = await peek(b, () => window.__ytLoads || []);
      if (loads.length) load = loads[0];
      else await sleep(20);
    }
    if (!check(G, `${how}: a deck sends loadVideoById (the set’s first cue)`, !!load)) return;
    const before = await peek(b, () => performance.now());
    await clickRef(b, ref);
    const after = await peek(b, () => performance.now());
    check(G, `${how}: pressed within 1 s of the deck’s loadVideoById`, after - load.t < 1000, `click sent ${Math.round(before - load.t)} ms after loadVideoById, done ${Math.round(after - load.t)} ms after`);
    let first = null;
    for (const end = Date.now() + 15000; !first && Date.now() < end; ) {
      const l = await peek(b, stageLook);
      if (l.hidden) first = l;
      else await sleep(100);
    }
    if (!check(G, `${how}: the video stage is hidden`, !!first, first ? `screen ${first.screen}, stage ${first.stage}` : JSON.stringify(await peek(b, stageLook)))) return;
    const looks = [];
    const inFrame = [[], []];
    for (let k = 0; k <= 30; k++) {
      looks.push(await peek(b, stageLook));
      for (const i of [0, 1]) {
        const scr = await deckScreen(b, i);
        if (scr && scr.video) inFrame[i].push(scr.video.t);
      }
      if (k < 30) await sleep(1000);
    }
    const span = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    const moved = [0, 1].map((i) => span(looks.map((l) => (l.decks[i] ? l.decks[i].ct : 0))));
    const movedVideo = inFrame.map(span);
    const played = looks.some((l) => l.decks.some((d) => d.ps === 1));
    const trace = [];
    for (const l of looks) {
      const sig = l.decks.map((d) => `${d.state}${d.err != null ? ` ${d.err}` : ''} ps${d.ps} ${d.ct.toFixed(1)}`).join(' / ');
      if (!trace.length || trace[trace.length - 1].sig !== sig) trace.push({ at: ((l.t - looks[0].t) / 1000).toFixed(0), sig });
    }
    note(G, `${how}: players while hidden — ${trace.slice(0, 8).map((x) => `+${x.at}s ${x.sig}`).join(' | ')}`);
    check(G, `${how}: the stage stays hidden for the 30 s`, looks.every((l) => l.hidden), `${looks.filter((l) => l.hidden).length}/${looks.length} looks hidden; screens ${[...new Set(looks.map((l) => `${l.screen}/${l.stage}`))].join(', ')}`);
    check(G, `${how}: no deck’s player time advances for 30 s while the stage is hidden`, moved.every((m) => m <= 0.3) && movedVideo.every((m) => m <= 0.3) && !played, `getCurrentTime moved ${moved.map((m) => m.toFixed(2)).join(' / ')} s, the <video> in each player ${movedVideo.map((m, i) => (inFrame[i].length ? m.toFixed(2) : 'n/a')).join(' / ')} s${played ? ', a player reported PLAYING' : ''}`);
    if (how === 'preview') check(G, 'preview: the set goes on as previews', looks[looks.length - 1].active === 'preview' && looks[looks.length - 1].stage === 'waves', `${looks[looks.length - 1].active}, stage ${looks[looks.length - 1].stage}`);
    check(G, `${how}: no console errors`, ownErrors(b).length === 0, ownErrors(b).slice(0, 3).join(' | '));
  } finally {
    await close(b);
  }
}

async function groupStopLoad() {
  const G = 'stopload';
  for (const how of ['home', 'preview']) {
    await stopDuringLoad(G, how).catch((err) => check(G, `${how}: ran to completion`, false, String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : err)));
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

const guard = (name, fn) =>
  fn().catch((err) => {
    check(name, 'group ran to completion', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
  });
const jobs = [];
if (wants('main')) jobs.push(guard('main', groupMain));
if (wants('share')) jobs.push(sleep(wants('main') ? 4000 : 0).then(() => guard('share', groupShare)));
if (wants('phone')) jobs.push(sleep(wants('main') ? 8000 : 0).then(() => guard('phone', groupPhone)));
if (wants('background')) jobs.push(sleep(only.length ? 0 : 12000).then(() => guard('background', groupBackground)));
if (wants('moves')) jobs.push(sleep(only.length ? 0 : 16000).then(() => guard('moves', groupMoves)));
if (wants('prefs')) jobs.push(sleep(only.length ? 0 : 20000).then(() => guard('prefs', groupPrefs)));
if (wants('stopload')) jobs.push(sleep(only.length ? 0 : 24000).then(() => guard('stopload', groupStopLoad)));
await Promise.all(jobs);

const failed = results.filter((r) => !r.ok);
console.log(`\ntime to first sound (full songs include the first song’s pre-roll ad): ${Object.entries(timings).map(([k, v]) => `${k} ${typeof v === 'number' && v > 100 ? `${(v / 1000).toFixed(1)} s` : v}`).join(', ')}`);
console.log(`full e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);

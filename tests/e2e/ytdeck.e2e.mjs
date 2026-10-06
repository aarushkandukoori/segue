// YouTube deck e2e (SPEC.md §6, js/dj/ytdeck.js): real YouTube, real ads, under the app's real origin.
//
// One file, two roles — the harness page runs under the production CSP (no inline script), and this
// area owns no other file:
//   in Node      the runner:  node tests/e2e/ytdeck.e2e.mjs [--chrome] [--firefox]
//   in a browser loaded by tests/e2e/ytdeck-harness.html as its module script: installs window.ytHarness
//
// Chrome is launched with launch({gesture: true}) (Chrome's real autoplay policy) and the repo is served
// as https://aarushkandukoori.github.io/segue/ through request interception (origin.mjs). Pre-roll ads
// are real and are never skipped or hidden: a run takes about 5-10 minutes (up to 25), most of it ads.
//
// Chrome runs with launch({gesture: true, realBackground: true}): its real autoplay policy and its real
// background-tab throttling (only (9) / (9b) hide the tab).
//
// Checks: (0) harness sanity · (1) two decks cue in parallel through muted ads, (1d) adSeconds = how far
// the ad clock ran, (1u) a third asked for unmuted before any gesture still cues, inaudible, (1r) their
// embed URL carries origin + path only · (1b) play() before any gesture is refused · (2) a real click starts A,
// (2k) a real click on cued B's own play button is paused back, A→B crossfade by setVolume ticks ·
// (9) background tab · (2h) pause / resume / seek / ended · (3) error path, (3e) a player that starts
// while its deck says 'error' is paused back, (3s) stop() clears its error screen · (5) a cancelled cue ·
// (4) a reused deck sees its ad again, (4u) pre-rolled UNMUTED at volume 0 (after the gesture), never
// audible, (4b) a play() issued during that pre-roll raises the volume, (4w) unlock() of a running muted
// pre-roll, (cc) no captions on a
// playing song (read in the player's own frame), (4c) stop(), (4e) a click on a stopped deck is paused
// back, (4d) stop() while the next video is still loading, stage hidden: nothing plays on · (9b) a real
// background tab: an unmuted pre-roll runs on and cues there, one started there cues too, a muted one is
// held (control) and its adSeconds stands still, (9c) back in front nothing idle runs by itself ·
// (1s) YouTube never receives the page's query · (6) destroy
// leaves nothing behind · (7) zero CSP violations · (8) control: the same label video on
// http://127.0.0.1 fails with 150 · (F) the same flow, reduced, in headless Firefox.
// The YouTube frames are read through raw CDP too (userGesture: false): DOM.getFrameOwner finds a deck's
// frame, Runtime.evaluate in that frame's own session reads its captions / <video> elements, and a watch
// installed there records every moment a <video> plays unmuted above volume 0 ("loud").
// Video ids: YT_IDS="<A>,<B>,<C>,<D>" overrides the defaults (A and B are label uploads that are blocked
// on 127.0.0.1, C a widely embedded music video whose player shows captions by default — (cc) is only
// conclusive on a video that has them, and says so — and D one more, loaded only in (9b), whose pre-roll
// starts in the hidden tab: a video already played in the session often comes with no ad).
// Exit code 0 = every check passed.

// ── browser role ────────────────────────────────────────────────────────────────────────────────────

/** Calls made by js/dj/ytdeck.js itself (the first stack frame outside this file is in that module). */
function instrumentOwnership(marker) {
  const here = new URL(import.meta.url).pathname;
  const ownCaller = () => {
    const frames = String(new Error().stack || '')
      .split('\n')
      .filter((l) => /:\d+:\d+\)?\s*$/.test(l) && !l.includes(here));
    return frames.length > 0 && frames[0].includes(marker);
  };
  const timers = new Map();
  const listeners = [];
  const w = window;
  const [st, ct, si, ci] = [w.setTimeout, w.clearTimeout, w.setInterval, w.clearInterval];
  w.setTimeout = function (fn, ms, ...args) {
    const own = ownCaller();
    let id = 0;
    const wrapped =
      typeof fn === 'function'
        ? function () {
            timers.delete(id);
            return fn.apply(this, arguments);
          }
        : fn;
    id = st.call(w, wrapped, ms, ...args);
    if (own) timers.set(id, 'timeout');
    return id;
  };
  w.clearTimeout = function (id) {
    timers.delete(id);
    return ct.call(w, id);
  };
  w.setInterval = function (fn, ms, ...args) {
    const own = ownCaller();
    const id = si.call(w, fn, ms, ...args);
    if (own) timers.set(id, 'interval');
    return id;
  };
  w.clearInterval = function (id) {
    timers.delete(id);
    return ci.call(w, id);
  };
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  const capOf = (o) => !!(typeof o === 'boolean' ? o : o && o.capture);
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (ownCaller()) listeners.push({ target: this, type, fn, capture: capOf(opts) });
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const i = listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn && l.capture === capOf(opts));
    if (i >= 0) listeners.splice(i, 1);
    return rem.call(this, type, fn, opts);
  };
  return {
    get timers() {
      return timers.size;
    },
    get listeners() {
      return listeners.length;
    },
    describe: () => ({
      timers: [...timers.values()],
      listeners: listeners.map((l) => `${l.target && l.target.nodeName ? l.target.nodeName : String(l.target)}:${l.type}`),
    }),
  };
}

async function installHarness() {
  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const out = $('out');
  const say = (msg) => {
    if (status) status.textContent = msg;
  };
  const csp = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    csp.push({
      directive: e.effectiveDirective || e.violatedDirective,
      blocked: String(e.blockedURI || ''),
      source: String(e.sourceFile || ''),
      line: e.lineNumber,
    }),
  );
  const own = instrumentOwnership('/js/dj/ytdeck.js');
  // CSSOM writes are allowed by the CSP (style attributes and <style> are not).
  $('slots').style.display = 'flex';
  $('slots').style.flexWrap = 'wrap';
  $('slots').style.gap = '12px';
  for (const slot of document.querySelectorAll('.slot')) {
    slot.style.width = '320px';
    slot.style.height = '240px';
    slot.style.background = '#000';
  }
  if (out) out.style.whiteSpace = 'pre-wrap';

  const mod = await import('../../js/dj/ytdeck.js');
  const decks = {};
  const history = {};
  const firstIframe = {};
  const settle = (p) =>
    p.then(
      () => ({ ok: true }),
      (e) => ({ ok: false, name: e && e.name, code: e && e.code, message: e && e.message }),
    );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();

  const H = {
    ready: false,
    csp,
    own,
    mod,
    decks,
    history,
    results: {},
    onStart: null,
    startResult: null,
    clicks: 0,
    create(name, slotId, opts = {}) {
      if (decks[name]) return true; // (deck C is made early, for (1u))
      history[name] = [];
      const deck = mod.createYouTubeDeck($(slotId), {
        ...opts,
        onChange: (d) => history[name].push({ t: +((performance.now() - t0) / 1000).toFixed(2), state: d.state, ad: +d.adSeconds.toFixed(2) }),
      });
      decks[name] = deck;
      return true;
    },
    async whenReady(name, ms = 30000) {
      const end = performance.now() + ms;
      while (!decks[name].ready && performance.now() < end) await sleep(50);
      if (decks[name].ready) firstIframe[name] = decks[name].iframe;
      return decks[name].ready;
    },
    cue(name, id, opts) {
      return settle(decks[name].cue(id, opts));
    },
    startCue(name, id, opts) {
      const t = performance.now();
      H.results[name] = null;
      settle(decks[name].cue(id, opts)).then((r) => (H.results[name] = { ...r, ms: Math.round(performance.now() - t), at: Date.now(), hidden: document.visibilityState === 'hidden' }));
      return true;
    },
    /** Call deck.unlock() once its pre-roll shows an ad (or after `afterMs` without one); the result lands in H.unlocked[name]. */
    unlockWhenAd(name, afterMs = 2500) {
      const deck = decks[name];
      const t = performance.now();
      H.unlocked[name] = null;
      const iv = setInterval(() => {
        const st = deck.state;
        const waited = performance.now() - t;
        if (st !== 'loading' && st !== 'ad') {
          clearInterval(iv);
          H.unlocked[name] = { ok: null, why: `the cue was over before an ad (${st})`, state: st, at: Date.now() };
        } else if (st === 'ad' || waited > afterMs) {
          clearInterval(iv);
          const before = deck.debug();
          const ok = deck.unlock();
          H.unlocked[name] = { ok, state: st, at: Date.now(), ms: Math.round(waited), adSeconds: before.adSeconds, wasMuted: before.playerMuted, again: deck.unlock() };
        }
      }, 100);
      return true;
    },
    unlocked: {},
    /** The YouTube widget id of a deck's player, learnt from its own messages (rawCommand needs it). */
    widgetIds: {},
    /**
     * Send a player command straight to a deck's iframe, as the IFrame API would, bypassing the deck: a
     * player start the deck did not ask for (what Chrome does when it resumes a held video as the tab is
     * shown again). Returns false until the player's widget id is known.
     */
    rawCommand(name, func, args = []) {
      const f = decks[name].iframe;
      const id = H.widgetIds[name];
      if (!f || !f.contentWindow || id === undefined) return false;
      f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args, id, channel: 'widget' }), new URL(f.src).origin);
      return true;
    },
    play(name, opts) {
      return settle(decks[name].play(opts));
    },
    snap(name) {
      const deck = decks[name];
      const d = deck.debug();
      const f = deck.iframe;
      let rect = null;
      let covered = null;
      let opacity = null;
      if (f) {
        const r = f.getBoundingClientRect();
        rect = { x: r.x, y: r.y, w: r.width, h: r.height };
        const cs = getComputedStyle(f);
        opacity = `${cs.opacity}/${cs.visibility}/${cs.display}`;
        covered = [
          [0.5, 0.5],
          [0.1, 0.1],
          [0.9, 0.1],
          [0.1, 0.9],
          [0.9, 0.9],
        ].some(([fx, fy]) => document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy) !== f);
      }
      return {
        ...d,
        position: deck.position(),
        stateGetter: deck.state,
        adSecondsGetter: deck.adSeconds,
        durationGetter: deck.duration,
        rect,
        covered,
        opacity,
        sameIframe: !!f && f === firstIframe[name],
        parentIsSlot: !!f && f.parentNode && f.parentNode.classList.contains('slot'),
        history: history[name],
      };
    },
    startSampler(names, ms = 250) {
      const samples = [];
      const s0 = performance.now();
      const iv = setInterval(() => {
        const row = { t: +((performance.now() - s0) / 1000).toFixed(2) };
        for (const n of names) {
          const d = decks[n].debug();
          row[n] = { state: d.state, ps: d.playerState, ct: d.currentTime, muted: d.playerMuted, vol: d.playerVolume, ad: d.adSeconds, vid: d.playerVideoId, hold: d.silentHold, um: d.unmutedPreroll, fb: d.fellBack, at: Date.now(), hidden: document.visibilityState === 'hidden' };
        }
        samples.push(row);
      }, ms);
      H._sampler = { iv, samples };
      return true;
    },
    stopSampler() {
      if (!H._sampler) return [];
      clearInterval(H._sampler.iv);
      const s = H._sampler.samples;
      H._sampler = null;
      return s;
    },
    /** Measure position() against the player's own getCurrentTime() and the wall clock for `ms`. */
    async track(name, ms = 3000, every = 100) {
      const deck = decks[name];
      const rows = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        rows.push({ wall: performance.now() / 1000, pos: deck.position(), cur: deck.debug().currentTime, state: deck.state });
        await sleep(every);
      }
      return rows;
    },
    /** Crossfade A→B: B.play({volume: 0}), then setVolume ticks at `hz` for `seconds`, then A.pause(). */
    async crossfade(aName, bName, { seconds = 4, hz = 20, tailSeconds = 3 } = {}) {
      const A = decks[aName];
      const B = decks[bName];
      const samples = [];
      const c0 = performance.now();
      const rec = (phase) => {
        const a = A.debug();
        const b = B.debug();
        samples.push({
          t: (performance.now() - c0) / 1000,
          phase,
          aSent: a.sentVolume,
          bSent: b.sentVolume,
          aRep: a.playerVolume,
          bRep: b.playerVolume,
          aPos: A.position(),
          aCur: a.currentTime,
          aState: A.state,
          aPS: a.playerState,
          bPos: B.position(),
          bCur: b.currentTime,
          bState: B.state,
          bPS: b.playerState,
          bMuted: b.playerMuted,
        });
      };
      rec('before');
      const bCall = performance.now();
      const bRes = await settle(B.play({ volume: 0 }));
      const bStartMs = Math.round(performance.now() - bCall);
      const bPosAtStart = B.position();
      if (!bRes.ok) return { bRes, bStartMs, bPosAtStart, samples };
      rec('start');
      const f0 = performance.now();
      let ticks = 0;
      await new Promise((done) => {
        const iv = setInterval(() => {
          const k = Math.min(1, (performance.now() - f0) / (seconds * 1000));
          A.setVolume(1 - k);
          B.setVolume(k);
          ticks++;
          rec('fade');
          if (k >= 1) {
            clearInterval(iv);
            done();
          }
        }, 1000 / hz);
      });
      const fadeS = (performance.now() - f0) / 1000;
      A.pause();
      rec('paused');
      const tailEnd = performance.now() + tailSeconds * 1000;
      while (performance.now() < tailEnd) {
        await sleep(100);
        rec('tail');
      }
      return { bRes, bStartMs, bPosAtStart, ticks, fadeS, samples };
    },
    destroyAll() {
      for (const d of Object.values(decks)) d.destroy();
      return true;
    },
    leftovers() {
      return {
        iframes: document.querySelectorAll('iframe').length,
        slotChildren: [...document.querySelectorAll('.slot')].map((s) => s.childElementCount),
        ownTimers: own.timers,
        ownListeners: own.listeners,
        detail: own.describe(),
        deckTimers: Object.values(decks).map((d) => d.debug().timer),
      };
    },
  };

  // Each player's widget id, from the messages it posts to this page (see rawCommand).
  window.addEventListener('message', (e) => {
    for (const [name, deck] of Object.entries(decks)) {
      const f = deck.iframe;
      if (!f || e.source !== f.contentWindow) continue;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data && data.id !== undefined && data.id !== null) H.widgetIds[name] = data.id;
      } catch {
        /* not the widget protocol */
      }
    }
  });
  $('start').addEventListener('click', () => {
    H.clicks++;
    const fn = H.onStart;
    H.onStart = null;
    if (typeof fn === 'function') {
      try {
        H.startResult = fn();
      } catch (e) {
        H.startResult = { ok: false, message: String(e) };
      }
    }
  });
  window.ytHarness = H;
  H.ready = true;
  say('harness ready');
}

// ── Node role ───────────────────────────────────────────────────────────────────────────────────────

const PROD_CSP =
  "default-src 'self'; script-src 'self' https://api.deezer.com https://www.youtube.com; connect-src 'self' https:; img-src 'self' https: data: blob:; media-src blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HARNESS = 'tests/e2e/ytdeck-harness.html';
const OVERALL_TIMEOUT_MS = 45 * 60 * 1000;

async function runInNode() {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { launch, sendToBackground } = await import('./browser.mjs');
  const { startServer } = await import('./serve.mjs');
  const { serveAsOrigin, resolveFile, MIME } = await import('./origin.mjs');
  const { launchFirefox, FIREFOX } = await import('./engine/firefox.mjs');

  const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const bad = flags.filter((f) => f !== '--chrome' && f !== '--firefox');
  if (bad.length) {
    console.error(`unknown option(s): ${bad.join(', ')} (have: --chrome, --firefox)`);
    process.exit(2);
  }
  const wantChrome = !flags.length || flags.includes('--chrome');
  const wantFirefox = !flags.length || flags.includes('--firefox');
  const [ID_A, ID_B, ID_C, ID_D] = (process.env.YT_IDS || 'm00rvC4CWH8,JEmbyx8NLxA,kJQP7kiw5Fk,9bZkp7q19f0').split(',').map((s) => s.trim());
  // Well-formed but (almost surely) nonexistent; assembled so no real id is implied.
  const MISSING = ['zZ0', '_-z', 'Z0_', '-z'].join('');

  const watchdog = setTimeout(() => {
    console.log(`FAIL watchdog: the run did not finish within ${OVERALL_TIMEOUT_MS / 60000} min`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  watchdog.unref();

  const checks = [];
  const check = (id, name, ok, detail = '') => {
    checks.push({ id, name, ok: !!ok, detail });
    console.log(`  ${ok ? 'pass' : 'FAIL'}  (${id}) ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const skip = (id, name, why) => {
    checks.push({ id, name, ok: true, skipped: true, detail: why });
    console.log(`  skip  (${id}) ${name} — ${why}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Teardown must not hang the run (a keep-alive socket can hold server.close() open). */
  const bounded = async (p, ms, what) => {
    let timer;
    let late = false;
    await Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => (timer = setTimeout(() => r((late = true)), ms)))]);
    clearTimeout(timer);
    if (late) console.log(`  note: ${what} did not finish within ${ms / 1000} s; moving on`);
  };
  const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);
  /**
   * Wait for fn() to be truthy in the page, polling with short evaluations. Not page.waitForFunction for
   * long waits: its single CDP call is cut at puppeteer's 180 s protocol timeout, which a real ad pod
   * outlasts (230 s measured, 2026-10-06) — and the run then went on as if the wait were over.
   */
  const pollUntil = async (pg, fn, timeoutMs, everyMs = 500) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await pg.evaluate(fn).catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(everyMs);
    }
  };
  // Pre-roll length is YouTube's choice (20-40 s measured, sometimes far longer): the e2e waits up to
  // CUE_WAIT_MS; the deck's own default timeout (90 s) is exercised separately in (3c).
  const CUE_WAIT_MS = 300000; // 150 s was not enough twice in four runs on 2026-10-06 (ad clocks of 133 / 142 s)
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dump = {};
  /** What the samples say about one deck's pre-roll: number of ads, ad clock, was it moving at the end? */
  const adStory = (samples, name) => {
    const ad = samples.filter((row) => row[name].state === 'ad' && typeof row[name].ct === 'number');
    let ads = ad.length ? 1 : 0;
    let longestStall = 0;
    let stallFrom = null;
    // how far the ad clock ran over the samples (what adSeconds must add up to): forward steps, and a new ad's start
    let clockRun = ad.length ? Math.min(ad[0][name].ct, 1) : 0;
    for (let i = 1; i < ad.length; i++) {
      const a = ad[i - 1][name].ct;
      const b = ad[i][name].ct;
      if (b > a) clockRun += b - a;
      else if (b < a - 0.5) clockRun += b;
      if (b < a - 1) ads++;
      if (Math.abs(b - a) < 0.01) {
        if (stallFrom === null) stallFrom = ad[i - 1].t;
        longestStall = Math.max(longestStall, ad[i].t - stallFrom);
      } else stallFrom = null;
    }
    return { samples: ad.length, ads, maxAdClock: ad.length ? Math.max(...ad.map((row) => row[name].ct)) : 0, longestStall, clockRun };
  };
  const states = (h) => (h || []).map((e) => e.state).join('>');

  // ── (0) sanity of the harness itself ──
  console.log('\n(0) harness sanity');
  {
    const serveSrc = await readFile(new URL('./serve.mjs', import.meta.url), 'utf8');
    const block = serveSrc.match(/const MIME = \{([\s\S]*?)\};/);
    const parsed = block ? Object.fromEntries([...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]])) : null;
    check('0a', 'origin.mjs MIME map equals serve.mjs', parsed && JSON.stringify(parsed) === JSON.stringify(MIME), parsed ? `${Object.keys(parsed).length} types` : 'could not read serve.mjs');
    const html = await readFile(new URL('./ytdeck-harness.html', import.meta.url), 'utf8');
    const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    check('0b', 'harness CSP is the production policy, exactly', meta && meta[1] === PROD_CSP);
    const esc = [
      await resolveFile('/segue/' + ['..', '..', 'etc', 'hosts'].join('%2F')),
      await resolveFile('/segue/%2e%2e/%2e%2e/etc/hosts'),
      await resolveFile('/segue/tests/e2e/' + 'no-such-file.html'),
      await resolveFile('/segue/'),
    ];
    check(
      '0c',
      'origin.mjs never serves outside the repo; 404 for missing; dir → index.html',
      esc[0].file === null && esc[1].file === null && esc[2].status === 404 && esc[3].status === 200 && /index\.html$/.test(esc[3].file || ''),
      esc.map((e) => e.status).join(' '),
    );
  }

  // ── Chrome under the real origin ──
  if (wantChrome && !existsSync(CHROME)) skip('chrome', 'Chrome runs', `not installed at ${CHROME} (CHROME_PATH)`);
  else if (wantChrome) await runChrome();

  async function runChrome() {
    // Chrome's real autoplay policy, and its real background-tab throttling for (9) / (9b): the owner
    // listens with other tabs in front (browser.mjs: launch({realBackground}), sendToBackground).
    const session = await launch({ gesture: true, realBackground: true, width: 1100, height: 800 });
    const { page, errors, logs, browser } = session;
    let site;
    // What leaves the page: a share link's query must not (1s). The marker is made at run time.
    const LEAK = ['lk', Math.random().toString(36).slice(2, 9)].join('');
    /** @type {{url: string, referer: string}[]} every request not answered by the page's own origin */
    const outgoing = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('https://aarushkandukoori.github.io/')) return;
      const h = req.headers();
      outgoing.push({ url, referer: h.referer || h.Referer || '' });
    });
    try {
      site = await serveAsOrigin(page);
      await page.goto(site.url(HARNESS) + `?p=deezer:chart:0&seed=${LEAK}&vibe=0.5&len=short`, { waitUntil: 'load' });
      // Until the real click, the page is driven through raw CDP with userGesture: false: puppeteer's
      // page.evaluate / waitForFunction pass userGesture: true, which would hand the page the sticky user
      // activation that the autoplay policy is about (and make the "no gesture yet" checks meaningless).
      const cdp = await page.createCDPSession();
      const ng = async (expr) => {
        const r = await cdp.send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true, userGesture: false });
        if (r.exceptionDetails) throw new Error(`in page: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
        return r.result.value;
      };
      const ngWait = async (expr, timeoutMs, everyMs = 250) => {
        const end = Date.now() + timeoutMs;
        for (;;) {
          const v = await ng(expr).catch(() => null);
          if (v || Date.now() > end) return v;
          await sleep(everyMs);
        }
      };
      const J = JSON.stringify;
      /** The puppeteer frame of the player inside slot `slotId` (raw CDP: no user activation). */
      const deckFrame = async (slotId) => {
        for (const f of page.frames()) {
          if (!/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//.test(f.url())) continue;
          const owner = await cdp.send('DOM.getFrameOwner', { frameId: f._id }).catch(() => null);
          if (!owner) continue;
          const node = await cdp.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId }).catch(() => null);
          if (!node || !node.object || !node.object.objectId) continue;
          const r = await cdp.send('Runtime.callFunctionOn', { objectId: node.object.objectId, functionDeclaration: 'function () { return this.parentNode ? this.parentNode.id : null; }', returnByValue: true, userGesture: false }).catch(() => null);
          await cdp.send('Runtime.releaseObject', { objectId: node.object.objectId }).catch(() => {});
          if (r && r.result && r.result.value === slotId) return f;
        }
        return null;
      };
      /** Evaluate in a deck's YouTube frame (its own out-of-process session), never with a gesture. */
      const inFrame = async (slotId, expr) => {
        const f = await deckFrame(slotId);
        if (!f || !f.client) return null;
        const r = await f.client.send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: false }).catch(() => null);
        return r && r.result ? r.result.value : null;
      };
      // Captions as the player draws them: segments on screen, and the player's own "subtitles on". The
      // API's getOption('captions','track') keeps naming a track after they are off, so it proves nothing.
      // `modules` lists 'captions' when the video has captions at all (else the check is vacuous).
      const CAPTIONS_JS = `(() => {
        if (!/youtube/.test(location.host)) return null;
        const mp = document.getElementById('movie_player');
        let on = null, modules = [];
        try { on = mp && typeof mp.isSubtitlesOn === 'function' ? mp.isSubtitlesOn() : null; } catch (e) { on = null; }
        try { modules = mp && typeof mp.getOptions === 'function' ? mp.getOptions() : []; } catch (e) { modules = []; }
        return { segments: document.querySelectorAll('.ytp-caption-segment').length, on, modules, ad: !!document.querySelector('.ad-showing') };
      })()`;
      const captionSamples = async (slotId, ms, every = 500) => {
        const rows = [];
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const c = await inFrame(slotId, CAPTIONS_JS);
          if (c) rows.push(c);
          await sleep(every);
        }
        return rows;
      };
      // The player frame's own <video> elements: what really plays (the API's numbers are a copy).
      const VIDEOS_JS = `(() => /youtube/.test(location.host) ? [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, t: v.currentTime })) : null)()`;
      // Audibility as the player's own frame sees it: every <video> in it, at every media event (volumechange,
      // play, playing, timeupdate: these fire in a background tab too) and every 100 ms. "Loud" = playing,
      // not muted and volume above 0. The API's getVolume()/isMuted() are a copy; this is the element itself.
      const WATCH_JS = `(() => {
        if (!/youtube/.test(location.host)) return null;
        // a second call starts a fresh record (the listeners stay)
        window.__sgw = { since: Date.now(), polls: 0, events: 0, videos: 0, frames: 0, playing: 0, zero: 0, muted: 0, loud: [], loudCount: 0, maxPlayingT: 0 };
        if (window.__sgwOn) return 'reset';
        window.__sgwOn = true;
        const look = (v, why) => {
          const w = window.__sgw;
          if (v.paused) return;
          if (v.muted) w.muted++;
          else if (!(v.volume > 0)) w.zero++;
          else {
            w.loudCount++;
            w.loud.push({ at: Date.now(), why, vol: +v.volume.toFixed(3), t: +v.currentTime.toFixed(2) });
            if (w.loud.length > 300) w.loud.splice(0, 100);
          }
        };
        for (const type of ['volumechange', 'play', 'playing', 'timeupdate', 'loadeddata']) {
          document.addEventListener(type, (e) => {
            if (e.target instanceof HTMLMediaElement) {
              window.__sgw.events++;
              look(e.target, type);
            }
          }, true);
        }
        setInterval(() => {
          const w = window.__sgw;
          const vs = document.querySelectorAll('video');
          w.polls++;
          w.videos = Math.max(w.videos, vs.length);
          w.frames = Math.max(w.frames, document.querySelectorAll('iframe').length);
          for (const v of vs) {
            if (!v.paused) {
              w.playing++;
              w.maxPlayingT = Math.max(w.maxPlayingT, v.currentTime);
            }
            look(v, 'poll');
          }
        }, 100);
        return 'installed';
      })()`;
      const READ_WATCH_JS = `(() => window.__sgw ? JSON.parse(JSON.stringify(window.__sgw)) : null)()`;
      const watchFrame = async (slotId) => inFrame(slotId, WATCH_JS);
      const readWatch = async (slotId) => inFrame(slotId, READ_WATCH_JS);
      /** Loud moments of a frame watch before `until` (Date.now() of the moment the deck was allowed to sound). */
      const loudBefore = (w, until) => (w ? w.loud.filter((x) => x.at < until) : null);
      const watchSay = (w, until) => {
        if (!w) return 'frame watch unreadable';
        const early = loudBefore(w, until);
        return `frame: ${w.polls} polls + ${w.events} media events, ${w.videos} <video>, ${w.frames} nested iframes; playing samples ${w.muted} muted / ${w.zero} at volume 0 / ${w.loudCount} loud (${early.length} before it was allowed to sound${early.length ? `, e.g. ${J(early[0])}` : ''})`;
      };
      /** API samples of `name` from `rows` (H.startSampler) taken before `until`: muted or at volume 0? */
      const apiSilent = (rows, name, until, from = 0) => {
        const pre = rows.filter((r) => r[name] && r[name].at < until && r[name].at >= from && (r[name].state === 'loading' || r[name].state === 'ad'));
        const loud = pre.filter((r) => r[name].muted === false && r[name].vol !== 0);
        const unmuted0 = pre.filter((r) => r[name].muted === false && r[name].vol === 0).length;
        return { n: pre.length, loud, unmuted0, muted: pre.filter((r) => r[name].muted === true).length };
      };
      if (!(await ngWait('window.ytHarness && window.ytHarness.ready === true', 20000))) throw new Error('harness did not load');
      const fromPage = await ng(`(async () => {
        const ok = await fetch('./ytdeck.e2e.mjs', { cache: 'no-store' });
        const missing = await fetch('./' + 'no-such-file.js', { cache: 'no-store' });
        return { origin: location.origin, path: location.pathname, ok: ok.status, okType: ok.headers.get('content-type'), missing: missing.status };
      })()`);
      check(
        '0d',
        'page runs as https://aarushkandukoori.github.io/segue/ (files from disk, 404 for missing)',
        fromPage.origin === 'https://aarushkandukoori.github.io' && fromPage.path === '/segue/' + HARNESS && fromPage.ok === 200 && /javascript/.test(fromPage.okType || '') && fromPage.missing === 404,
        `${fromPage.origin}${fromPage.path} · ${fromPage.ok} ${fromPage.okType} · missing ${fromPage.missing}`,
      );

      // ── (1) two decks cue in parallel ──
      console.log('\n(1) cue two real music videos in parallel (real, muted pre-roll ads)');
      await ng(`ytHarness.create('A', 'slotA') && ytHarness.create('B', 'slotB') && ytHarness.create('C', 'slotC')`);
      const ready = await ng(`Promise.all([ytHarness.whenReady('A'), ytHarness.whenReady('B'), ytHarness.whenReady('C')])`);
      check('1a', 'the players become ready', ready[0] && ready[1] && ready[2]);
      const embed = await ng(`({ srcs: [ytHarness.decks.A.iframe.src, ytHarness.decks.B.iframe.src], allow: ytHarness.decks.A.iframe.getAttribute('allow'), origin: location.origin, path: location.pathname, query: location.search })`);
      const embedOk = embed.srcs.map((src) => {
        const u = new URL(src);
        const q = u.searchParams;
        return u.origin === 'https://www.youtube-nocookie.com' && u.pathname === '/embed/' && !q.has('forigin') && !src.includes(LEAK) &&
          q.get('origin') === embed.origin && q.get('widget_referrer') === embed.origin + embed.path &&
          q.get('enablejsapi') === '1' && q.get('mute') === '1' && q.get('cc_load_policy') === '0' && q.get('controls') === '0';
      });
      check(
        '1r',
        "each player's embed URL carries the page's origin + path only (no forigin, no query), muted, captions not forced",
        embed.query.includes(LEAK) && embedOk.every(Boolean) && /\bautoplay\b/.test(embed.allow || ''),
        `page query ${embed.query.length} chars · ${embedOk.map((ok, i) => `${'AB'[i]} ${ok ? 'ok' : new URL(embed.srcs[i]).search.slice(0, 220)}`).join(' · ')} · allow="${embed.allow}"`,
      );
      const policy = await ng(`[ytHarness.snap('A'), ytHarness.snap('B')]`);
      check(
        '1b',
        'players fill their slots: ≥ 200×200, opaque, visible, uncovered',
        policy.every((s) => s.rect && s.rect.w >= 200 && s.rect.h >= 200 && s.opacity === '1/visible/inline' && s.covered === false && s.parentIsSlot),
        policy.map((s) => `${s.rect && s.rect.w}×${s.rect && s.rect.h} ${s.opacity} covered=${s.covered}`).join(' · '),
      );
      // Deck C pre-rolls too, asked for UNMUTED at volume 0 — before the page has had any gesture (1u).
      const watchC1 = await watchFrame('slotC');
      await ng(`ytHarness.startSampler(['A', 'B', 'C'], 250) && ytHarness.startCue('A', ${J(ID_A)}, { timeoutMs: ${CUE_WAIT_MS} }) && ytHarness.startCue('B', ${J(ID_B)}, { timeoutMs: ${CUE_WAIT_MS} }) && ytHarness.startCue('C', ${J(ID_A)}, { timeoutMs: ${CUE_WAIT_MS}, unmuted: true })`);
      const t1 = Date.now();
      await ngWait('ytHarness.results.A && ytHarness.results.B && ytHarness.results.C', CUE_WAIT_MS + 15000, 500);
      const cueSeconds = (Date.now() - t1) / 1000;
      await sleep(600); // a few samples of the held state
      const samples1 = await ng('ytHarness.stopSampler()');
      const res1 = await ng('ytHarness.results');
      const s1 = await ng(`[ytHarness.snap('A'), ytHarness.snap('B'), ytHarness.snap('C')]`);
      const w1 = await readWatch('slotC');
      dump.cue1 = { samples: samples1, results: res1, A: adStory(samples1, 'A'), B: adStory(samples1, 'B'), C: adStory(samples1, 'C'), watchC: w1 };
      for (const [i, name, id] of [[0, 'A', ID_A], [1, 'B', ID_B]]) {
        const r = res1[name];
        const s = s1[i];
        check(
          `1c${name}`,
          `deck ${name} reaches 'cued' at ≈ 0 (song held, paused)`,
          r && r.ok && s.state === 'cued' && Math.abs(s.position) <= 0.5 && Math.abs(s.currentTime) <= 0.6 && s.playerState === 2 && s.playerVideoId === id,
          r ? `${r.ok ? 'ok' : `${r.code} ${r.message}`} in ${r2((r.ms || 0) / 1000)} s · pos ${r2(s.position)} · getCurrentTime ${r2(s.currentTime)} · playerState ${s.playerState} · ${states(s.history)}` : `no result after ${r2(cueSeconds)} s`,
        );
        const adSamples = samples1.filter((row) => row[name].state === 'ad').length;
        const clock = dump.cue1[name].clockRun;
        check(
          `1d${name}`,
          `deck ${name} reports adSeconds (ad seen ⇔ adSeconds > 0), and it matches how far the ad clock ran`,
          typeof s.adSeconds === 'number' && (adSamples > 0) === (s.adSeconds > 0) && s.adSecondsGetter === s.adSeconds && Math.abs(s.adSeconds - clock) <= Math.max(2, 0.1 * clock),
          `adSeconds ${r2(s.adSeconds)} · ad clock ran ${r2(clock)} s · ${adSamples} samples in 'ad' (${dump.cue1[name].ads} ad(s), ad clock up to ${r2(dump.cue1[name].maxAdClock)} s, longest stall ${r2(dump.cue1[name].longestStall)} s) · duration ${r2(s.duration)} s`,
        );
        const loud = samples1.filter((row) => row[name].state !== 'cued' && row[name].muted === false);
        const mutedAfter = samples1.filter((row) => row[name].state === 'cued').every((row) => row[name].muted === true);
        check(
          `1e${name}`,
          `deck ${name} muted throughout the pre-roll (ads never audible)`,
          loud.length === 0 && mutedAfter && samples1.some((row) => row[name].muted === true),
          `${samples1.length} samples, ${loud.length} unmuted before 'cued'`,
        );
      }

      // ── (1u) an unmuted pre-roll asked for before any gesture. Chrome runs it unmuted at volume 0 even
      // then (measured 2026-10-06); a browser that refuses gets the deck's muted fallback. Either way it must
      // cue, and nothing may be heard ──
      {
        const r = res1.C;
        const s = s1[2];
        const api = apiSilent(samples1, 'C', Date.now() + 1);
        const loudFrame = loudBefore(w1, Date.now() + 1);
        dump.cue1.C.api = { n: api.n, loud: api.loud.length, unmuted0: api.unmuted0, muted: api.muted };
        check(
          '1u',
          "cue(…, {unmuted: true}) before any gesture still reaches 'cued' at ≈ 0, and is inaudible throughout (API: muted or volume 0; the player's own <video>: never playing unmuted above 0)",
          watchC1 === 'installed' && r && r.ok && s.state === 'cued' && Math.abs(s.position) <= 0.5 && api.n > 0 && api.loud.length === 0 && loudFrame !== null && loudFrame.length === 0 && w1.polls > 10,
          `${r ? (r.ok ? `cued in ${r2(r.ms / 1000)} s` : `${r.code} ${r.message}`) : 'no result'} · went on muted: ${s.fellBack || 'no (the browser let it run unmuted at 0)'} · ${states(s.history)} · API ${api.n} pre-roll samples: ${api.muted} muted, ${api.unmuted0} unmuted at 0, ${api.loud.length} loud${api.loud.length ? ` (e.g. ${J(api.loud[0].C)})` : ''} · ${watchSay(w1, Date.now() + 1)}`,
        );
      }

      // ── (1b) play() before any user gesture ──
      console.log('\n(1b) play() before any user gesture');
      const activation0 = await ng('navigator.userActivation ? navigator.userActivation.hasBeenActive : null');
      const early = await ng(`ytHarness.play('A', { volume: 1 })`);
      const afterEarly = await ng(`ytHarness.snap('A')`);
      check(
        '1f',
        "play() with sound before any gesture rejects DeckError 'blocked' and leaves the deck usable",
        activation0 === false && !early.ok && early.code === 'blocked' && (afterEarly.state === 'cued' || afterEarly.state === 'paused') && afterEarly.muted === true,
        `page had user activation: ${activation0} · ${early.ok ? 'resolved (not blocked!)' : `${early.name} ${early.code}: ${early.message}`} · state ${afterEarly.state} · playerState ${afterEarly.playerState} · pos ${r2(afterEarly.position)} · re-muted ${afterEarly.muted}`,
      );
      if (Math.abs(afterEarly.position) > 0.3 && afterEarly.state !== 'playing') {
        await ng(`ytHarness.decks.A.seek(0)`); // the refused attempt may have moved it
        await sleep(800);
      }

      // ── (2) a real click starts A, then A→B crossfade ──
      console.log('\n(2) a real click starts deck A with sound; crossfade A→B over 4 s at 20 Hz');
      await ng(`(ytHarness.onStart = () => {
        const t = performance.now();
        // The Start tap primes both decks (iOS media unlock; must be harmless elsewhere), then plays A.
        ytHarness.decks.B.prime();
        ytHarness.decks.A.prime();
        return ytHarness.decks.A.play({ volume: 1 }).then(
          () => ({ ok: true, ms: Math.round(performance.now() - t) }),
          (e) => ({ ok: false, code: e.code, message: e.message }),
        );
      }, true)`);
      const activation1 = await ng('navigator.userActivation ? navigator.userActivation.hasBeenActive : null');
      if (activation1 !== false) console.log(`  note: the page had user activation before the click (${activation1})`);
      await page.click('#start');
      await page.waitForFunction(() => ytHarness.startResult && typeof ytHarness.startResult.then === 'function', { timeout: 5000 }).catch(() => {});
      const startRes = await page.evaluate(() => ytHarness.startResult);
      const snapA = await page.evaluate(() => ytHarness.snap('A'));
      const clicks = await page.evaluate(() => ytHarness.clicks);
      check(
        '2a',
        'the real click starts deck A unmuted at volume 100 (resolves at PLAYING)',
        clicks === 1 && startRes && startRes.ok && snapA.state === 'playing' && snapA.muted === false && snapA.playerMuted === false && snapA.playerVolume === 100,
        startRes ? `${startRes.ok ? `PLAYING ${startRes.ms} ms after the click` : `${startRes.code} ${startRes.message}`} · player muted ${snapA.playerMuted} · volume ${snapA.playerVolume}` : 'no result',
      );
      const bAfterPrime = await page.evaluate(() => ytHarness.snap('B'));
      check('2b', 'prime() leaves the cued deck B cued at ≈ 0, muted', bAfterPrime.state === 'cued' && Math.abs(bAfterPrime.position) <= 0.5 && bAfterPrime.muted === true, `state ${bAfterPrime.state} · pos ${r2(bAfterPrime.position)} · playerState ${bAfterPrime.playerState}`);
      dump.captionsA = await captionSamples('slotA', 3000);

      // ── (2k) a visitor clicks the big play button YouTube draws on the cued (idle) player ──
      console.log('\n(2k) a real click on cued deck B\'s own player');
      const bRect = await page.evaluate(() => {
        const r = ytHarness.decks.B.iframe.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const kHist = await page.evaluate(() => ytHarness.history.B.length);
      await page.mouse.click(bRect.x, bRect.y);
      const kRows = [];
      for (let i = 0; i < 16; i++) {
        await sleep(250);
        kRows.push(await page.evaluate(() => {
          const d = ytHarness.decks.B.debug();
          return { state: d.state, ps: d.playerState, ct: d.currentTime, pos: d.position, muted: d.playerMuted, heldBack: d.heldBack };
        }));
      }
      await sleep(1500); // the hold-back's seek back to the cue point lands
      const kEnd = await page.evaluate(() => ytHarness.snap('B'));
      const kStates = kEnd.history.slice(kHist).map((e) => e.state);
      const kMax = Math.max(...kRows.map((r) => (typeof r.ct === 'number' ? r.ct : 0)));
      const kDetail = `heldBack ${kEnd.heldBack} · deck/player states after the click: ${kRows.map((r) => `${r.state}/${r.ps}`).filter((x, i, a) => x !== a[i - 1]).join(' > ')} · player clock up to ${r2(kMax)} s, now ${r2(kEnd.currentTime)} · pos ${r2(kEnd.position)} · onChange calls ${kStates.join(',') || 'none'}`;
      if (kEnd.heldBack === 0 && kMax <= 0.05 && kRows.every((r) => r.state === 'cued' && r.ps !== 1)) {
        skip('2k', 'a click on the cued player is paused back', `INCONCLUSIVE: the click did not start YouTube's player at all (${kDetail})`);
      } else check(
        '2k',
        'a click on the cued player does not start the song: it is paused back at its cue point, muted, still cued (heldBack counts it)',
        kEnd.heldBack >= 1 && kEnd.state === 'cued' && kStates.every((st) => st === 'cued') && kRows.every((r) => r.state === 'cued' && r.muted !== false) &&
          Math.abs(kEnd.position) <= 0.5 && Math.abs(kEnd.currentTime) <= 0.6 && kEnd.playerState === 2,
        kDetail,
      );
      const trackA = await page.evaluate(() => ytHarness.track('A', 5000, 100));
      const fade = await page.evaluate(() => ytHarness.crossfade('A', 'B', { seconds: 4, hz: 20, tailSeconds: 3 }));
      const fs = fade.samples;
      // reported volume follows what was sent (the player reports with up to a few hundred ms of lag)
      const follows = (sentKey, repKey) => {
        let worst = 0;
        for (const s of fs.filter((x) => x.phase === 'fade' || x.phase === 'paused')) {
          if (typeof s[repKey] !== 'number') continue;
          const recent = fs.filter((x) => x.t <= s.t && x.t >= s.t - 0.75 && typeof x[sentKey] === 'number').map((x) => x[sentKey]);
          if (!recent.length) continue;
          const lo = Math.min(...recent) - 3;
          const hi = Math.max(...recent) + 3;
          worst = Math.max(worst, s[repKey] < lo ? lo - s[repKey] : s[repKey] > hi ? s[repKey] - hi : 0);
        }
        return worst;
      };
      const tail = fs.filter((x) => x.phase === 'tail');
      const lastTail = tail[tail.length - 1] || {};
      const midFade = fs.filter((x) => x.phase === 'fade').find((x) => x.t - fs.find((y) => y.phase === 'fade').t >= 2) || {};
      const aWorst = follows('aSent', 'aRep');
      const bWorst = follows('bSent', 'bRep');
      check('2c', 'B starts on the cue with no second ad (PLAYING ≈ 0.3 s after play)', fade.bRes.ok && fade.bPosAtStart <= 1.0 && !fs.some((x) => x.bState === 'ad'), `${fade.bRes.ok ? `PLAYING after ${fade.bStartMs} ms` : `${fade.bRes.code} ${fade.bRes.message}`} · B pos at start ${r2(fade.bPosAtStart)} s`);
      check(
        '2d',
        'reported volumes follow the 20 Hz ramp (A 100→0, B 0→100)',
        fade.bRes.ok && aWorst <= 6 && bWorst <= 6 && lastTail.aRep <= 1 && lastTail.bRep >= 99 && midFade.aRep > 20 && midFade.aRep < 80,
        `${fade.ticks} ticks in ${r2(fade.fadeS)} s · worst lag-tolerant error A ${aWorst} B ${bWorst} · mid-fade reported A ${midFade.aRep} B ${midFade.bRep} · end A ${lastTail.aRep} B ${lastTail.bRep}`,
      );
      const aTailPos = tail.map((x) => x.aPos);
      check(
        '2e',
        'A ends paused and stays put',
        lastTail.aState === 'paused' && lastTail.aPS === 2 && aTailPos.length > 5 && Math.max(...aTailPos) - Math.min(...aTailPos) < 0.15,
        `A state ${lastTail.aState} · playerState ${lastTail.aPS} · position spread over the tail ${r2(Math.max(...aTailPos) - Math.min(...aTailPos))} s`,
      );
      const rate = (rows, key, curKey) => {
        const a = rows[0];
        const b = rows[rows.length - 1];
        return { byPos: (b[key] - a[key]) / (b.wall - a.wall), byCur: (b[curKey] - a[curKey]) / (b.wall - a.wall) };
      };
      const rA = rate(trackA, 'pos', 'cur');
      const bRows = tail.map((x) => ({ wall: x.t, pos: x.bPos, cur: x.bCur }));
      const rB = rate(bRows, 'pos', 'cur');
      check(
        '2f',
        'positions advance at ~1 s/s (A solo 5 s, B after the fade)',
        Math.abs(rA.byPos - 1) < 0.05 && Math.abs(rB.byPos - 1) < 0.08 && Math.abs(rA.byCur - 1) < 0.06,
        `A ${r2(rA.byPos)} (getCurrentTime ${r2(rA.byCur)}) · B ${r2(rB.byPos)} (getCurrentTime ${r2(rB.byCur)})`,
      );
      const errs = [
        ...trackA.filter((x) => x.state === 'playing').map((x) => ({ e: x.pos - x.cur, where: 'A solo' })),
        ...fs.filter((x) => x.phase !== 'before').flatMap((x) => [
          x.aState === 'playing' ? { e: x.aPos - x.aCur, where: `A ${x.phase} t=${r2(x.t)}` } : null,
          x.bState === 'playing' ? { e: x.bPos - x.bCur, where: `B ${x.phase} t=${r2(x.t)}` } : null,
        ]).filter(Boolean),
      ];
      const worst = errs.reduce((w, x) => (Math.abs(x.e) > Math.abs(w.e) ? x : w), { e: 0, where: '-' });
      check('2g', 'position() vs getCurrentTime() while playing: error < 0.15 s', Math.abs(worst.e) < 0.15, `worst ${Math.round(worst.e * 1000)} ms (${worst.where}) over ${errs.length} samples`);

      // ── (9) background tab ──
      console.log('\n(9) background tab');
      const other = await browser.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await sleep(500);
      const bg0 = await page.evaluate(() => ({ vis: document.visibilityState, cur: ytHarness.decks.B.debug().currentTime, pos: ytHarness.decks.B.position(), wall: performance.now() / 1000 }));
      await sleep(4000);
      const bg1 = await page.evaluate(() => ({ vis: document.visibilityState, cur: ytHarness.decks.B.debug().currentTime, pos: ytHarness.decks.B.position(), wall: performance.now() / 1000, state: ytHarness.decks.B.state }));
      await page.bringToFront();
      await other.close();
      const bgRate = (bg1.cur - bg0.cur) / (bg1.wall - bg0.wall);
      check(
        '9',
        'deck B keeps playing while another tab is in front',
        bg1.state === 'playing' && Math.abs(bgRate - 1) < 0.08 && Math.abs(bg1.pos - bg1.cur) < 0.3,
        `visibility ${bg0.vis}/${bg1.vis} · advanced ${r2(bg1.cur - bg0.cur)} s in ${r2(bg1.wall - bg0.wall)} s · position() − getCurrentTime() ${r2(bg1.pos - bg1.cur)} s (real background throttling)`,
      );

      // ── (2h) pause / resume / seek / ended ──
      console.log('\n(2h) pause / resume / seek / ended on deck B');
      const ph = await page.evaluate(async () => {
        const B = ytHarness.decks.B;
        const sl = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = {};
        B.pause();
        await sl(1000);
        const p0 = B.position();
        await sl(500);
        const p1 = B.position();
        out.pause = { state: B.state, ps: B.debug().playerState, spread: Math.abs(p1 - p0), pos: p1 };
        const t = performance.now();
        out.resumeOk = await B.resume();
        out.resumeMs = Math.round(performance.now() - t);
        await sl(1000);
        out.resume = { state: B.state, pos: B.position(), cur: B.debug().currentTime };
        B.seek(60);
        await sl(1500);
        out.seek = { state: B.state, pos: B.position(), cur: B.debug().currentTime };
        const d = B.duration;
        B.seek(d - 3);
        const t2 = performance.now();
        while (B.state !== 'ended' && performance.now() - t2 < 10000) await sl(100);
        out.ended = { state: B.state, pos: B.position(), duration: d, waited: Math.round(performance.now() - t2) };
        out.resumeEnded = await B.resume();
        return out;
      });
      const resumedBy = ph.resume.pos - ph.pause.pos;
      check(
        '2h',
        'pause holds, resume continues, seek lands, a finished song reports ended',
        ph.pause.state === 'paused' && ph.pause.ps === 2 && ph.pause.spread < 0.02 &&
          ph.resumeOk === true && ph.resume.state === 'playing' && resumedBy > 0.5 && resumedBy < 1.7 &&
          ph.seek.state === 'playing' && ph.seek.pos > 60.7 && ph.seek.pos < 62 && Math.abs(ph.seek.pos - ph.seek.cur) < 0.15 &&
          ph.ended.state === 'ended' && Math.abs(ph.ended.pos - ph.ended.duration) < 0.6 && ph.resumeEnded === false,
        `paused (spread ${r2(ph.pause.spread)} s) · resume ${ph.resumeOk} in ${ph.resumeMs} ms, +${r2(resumedBy)} s after 1 s · seek 60 → ${r2(ph.seek.pos)} after 1.5 s (getCurrentTime ${r2(ph.seek.cur)}) · ended after ${ph.ended.waited} ms at ${r2(ph.ended.pos)} / ${r2(ph.ended.duration)} · resume() on ended → ${ph.resumeEnded}`,
      );

      // ── (3) error path ──
      console.log('\n(3) error path');
      await page.evaluate(() => ytHarness.create('C', 'slotC'));
      await page.evaluate(() => ytHarness.whenReady('C'));
      const invalid = await page.evaluate(() => ytHarness.cue('C', 'not a video id'));
      check('3a', "a malformed id rejects DeckError 'invalid' at once", !invalid.ok && invalid.name === 'DeckError' && invalid.code === 'invalid', `${invalid.code}: ${invalid.message}`);
      const tMiss = Date.now();
      const missing = await page.evaluate((id) => ytHarness.cue('C', id, { timeoutMs: 30000 }), MISSING);
      const sC = await page.evaluate(() => ytHarness.snap('C'));
      check(
        '3b',
        'a well-formed id that does not exist rejects DeckError with the player’s code',
        !missing.ok && missing.name === 'DeckError' && typeof missing.code === 'number' && sC.state === 'error' && sC.error === missing.code,
        `${missing.code}: ${missing.message} after ${r2((Date.now() - tMiss) / 1000)} s · state ${sC.state} · deck.error ${sC.error}`,
      );

      // ── (3e) a player that starts while its deck says 'error' (a refused cue that the browser lets go on
      // later, e.g. once a background tab is shown again) is paused back. Emulated by sending the player a
      // load + play of its own, straight to its iframe as the IFrame API would, past the deck ──
      {
        const before = await page.evaluate(() => ytHarness.snap('C'));
        const sent = await page.evaluate((id) => ytHarness.rawCommand('C', 'loadVideoById', [{ videoId: id }]) && ytHarness.rawCommand('C', 'playVideo'), ID_A);
        const eRows = [];
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          eRows.push(await page.evaluate(() => {
            const d = ytHarness.decks.C.debug();
            return { state: d.state, ps: d.playerState, ct: d.currentTime, vid: d.playerVideoId, heldBack: d.heldBack, muted: d.playerMuted };
          }));
        }
        const videos = await inFrame('slotC', VIDEOS_JS);
        const started = eRows.some((r) => r.vid === ID_A && (r.ps === 1 || r.ps === 3 || r.ps === -1));
        // after the first 5 s, the player's clock must stand still
        const late = eRows.slice(10).map((r) => (typeof r.ct === 'number' ? r.ct : 0));
        const lateMoved = late.length ? Math.max(...late) - Math.min(...late) : 0;
        const last = eRows[eRows.length - 1];
        const cts = eRows.map((r) => (typeof r.ct === 'number' ? r.ct : 0));
        // a start caught while still buffering is paused back without counting (heldBack counts real starts)
        const countedOrNeverRan = last.heldBack > before.heldBack || Math.max(...cts) - Math.min(...cts) < 0.5;
        const detail = `raw load sent: ${sent} · player ${[...new Set(eRows.map((r) => `${r.state}/${r.ps}`))].join(' > ')} · video ${last.vid} · clock moved ${r2(lateMoved)} s over the last 15 s (now ${r2(last.ct)}) · heldBack ${before.heldBack} → ${last.heldBack} · <video> ${J(videos)}`;
        if (!sent || !started) skip('3e', "a player that starts while its deck says 'error' is paused back", `INCONCLUSIVE: the raw command did not start the player (${detail})`);
        else check(
          '3e',
          "a player that starts while its deck says 'error' is paused back (muted, clock still, the deck still 'error', heldBack counts it)",
          last.state === 'error' && eRows.every((r) => r.state === 'error') && lateMoved < 0.1 && countedOrNeverRan && last.muted !== false && Array.isArray(videos) && videos.every((v) => v.paused),
          detail,
        );
      }

      // ── (3s) stop() on a deck in 'error' clears YouTube's error screen from its player (stopVideo) ──
      {
        const again = await page.evaluate((id) => ytHarness.cue('C', id, { timeoutMs: 30000 }), MISSING);
        await sleep(800);
        const ERR_JS = `(() => { const e = document.querySelector('.ytp-error'); const mp = document.querySelector('#movie_player'); return { error: !!(e && e.getClientRects().length && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'), mode: mp ? mp.className.split(' ').filter((c) => /-mode$|embed-error|ad-showing/.test(c)).join(' ') : '' }; })()`;
        const scr0 = await inFrame('slotC', ERR_JS);
        await page.evaluate(() => ytHarness.decks.C.stop());
        await sleep(1500);
        const scr1 = await inFrame('slotC', ERR_JS);
        const sS = await page.evaluate(() => ytHarness.snap('C'));
        check(
          '3s',
          "stop() on a deck in 'error' clears YouTube's error screen (the deck stays 'error' with its code)",
          !again.ok && scr0 && scr0.error === true && scr1 && scr1.error === false && sS.state === 'error' && sS.error === again.code,
          `cue → ${again.code} · before stop: ${J(scr0)} · after: ${J(scr1)} · state ${sS.state}, error ${sS.error}, playerState ${sS.playerState}`,
        );
      }

      const tTo = Date.now();
      const to = await page.evaluate((id) => ytHarness.cue('C', id, { timeoutMs: 4000 }), ID_C);
      const tookTo = (Date.now() - tTo) / 1000;
      await sleep(1000); // let the pause reach the player, then see whether its clock still moves
      const sTo = await page.evaluate(() => ytHarness.snap('C'));
      await sleep(1500);
      const sTo2 = await page.evaluate(() => ytHarness.snap('C'));
      const stopped = Math.abs(sTo2.currentTime - sTo.currentTime) < 0.05;
      if (to.ok) skip('3c', "cue timeout rejects 'timeout'", 'the video cued within 4 s (no ad served this time)');
      else check('3c', "a cue that cannot finish in time rejects DeckError 'timeout' and stops the player", to.code === 'timeout' && sTo.state === 'error' && tookTo < 6 && stopped, `${to.code}: ${to.message} after ${r2(tookTo)} s · state ${sTo.state} · player state ${sTo2.playerState}, clock ${stopped ? 'stopped' : `still moving (${r2(sTo.currentTime)} → ${r2(sTo2.currentTime)})`}`);

      // ── (5) a cancelled cue, (4) deck A reused for a third video ──
      console.log('\n(5) a cancelled cue · (4) deck A reused for a third video');
      // Now that the page has had its gesture, A's new cue pre-rolls UNMUTED at volume 0 (4u). At the same
      // time deck B pre-rolls muted and is unlocked once its ad shows (4w). The players' own frames are watched.
      const hist4From = await page.evaluate(() => ytHarness.history.A.length);
      const watch4 = [await watchFrame('slotA'), await watchFrame('slotB')];
      const t4 = Date.now();
      await page.evaluate((b, a, WAIT) => {
        ytHarness.startSampler(['A', 'B'], 250);
        ytHarness.startCue('A', b); // to be cancelled
        ytHarness.startCue('B', a, { timeoutMs: WAIT }); // muted, then unlock()
        ytHarness.unlockWhenAd('B');
      }, ID_B, ID_A, CUE_WAIT_MS);
      await sleep(1500);
      await page.evaluate((c, WAIT) => {
        ytHarness._first = ytHarness.results.A; // still pending
        const t = performance.now();
        ytHarness._cue4At = Date.now();
        ytHarness._p2 = ytHarness.cue('A', c, { timeoutMs: WAIT, unmuted: true }).then((r) => (ytHarness._r2 = { ...r, ms: Math.round(performance.now() - t), at: Date.now() }));
        // Issued during the pre-roll: waits for the cue, then starts the song (the app's "starting" state).
        ytHarness._p3 = ytHarness.play('A', { volume: 0.5 }).then((r) => (ytHarness._r3 = { ...r, ms: Math.round(performance.now() - t), pos: ytHarness.decks.A.position() }));
      }, ID_C, CUE_WAIT_MS);
      await sleep(300);
      const cancelled = await page.evaluate(() => ({ first: ytHarness._first, now: ytHarness.results.A }));
      check('5', "a cue superseded by a newer one rejects 'cancelled'", cancelled.first === null && cancelled.now && !cancelled.now.ok && cancelled.now.code === 'cancelled', cancelled.now ? `${cancelled.now.code} after ${r2(cancelled.now.ms / 1000)} s: ${cancelled.now.message}` : 'still pending');
      await pollUntil(page, () => !!(ytHarness._r2 && ytHarness._r3), CUE_WAIT_MS + 15000);
      await pollUntil(page, () => !!ytHarness.results.B, CUE_WAIT_MS + 15000);
      await sleep(1000);
      const r4 = await page.evaluate(() => ytHarness._r2);
      const r4p = await page.evaluate(() => ytHarness._r3);
      const cue4At = await page.evaluate(() => ytHarness._cue4At);
      const samples4 = await page.evaluate(() => ytHarness.stopSampler());
      const s4 = await page.evaluate(() => ytHarness.snap('A'));
      const wA4 = await readWatch('slotA');
      const h4 = s4.history.slice(hist4From);
      const idx = (st) => h4.findIndex((e) => e.state === st);
      const loud4 = samples4.filter((row) => (row.A.state === 'ad' || row.A.state === 'loading') && row.A.muted === false && row.A.vol !== 0 && row.t > 1.5);
      const story4 = adStory(samples4, 'A');
      dump.cue4 = { samples: samples4, history: h4, result: r4, play: r4p, story: story4, watchA: wA4 };
      console.log(`  ad story: ${story4.ads} ad(s), ad clock up to ${r2(story4.maxAdClock)} s, longest stall ${r2(story4.longestStall)} s, ${story4.samples} samples in 'ad'`);
      const longAds = r4 && !r4.ok && r4.code === 'timeout' && story4.longestStall < 5 && loud4.length === 0;
      if (longAds) {
        skip('4', "reused deck A: 'ad' then 'cued' again", `INCONCLUSIVE: YouTube served ${r2(r4.ms / 1000)} s of ads (clock kept moving, muted throughout) — longer than the ${CUE_WAIT_MS / 1000} s wait; the deck timed out as designed`);
      } else check(
        '4',
        "reused deck A: 'ad' then 'cued' again (silent), same iframe",
        r4 && r4.ok && s4.playerVideoId === ID_C && idx('ad') >= 0 && idx('cued') > idx('ad') && s4.adSeconds > 0 && loud4.length === 0 && s4.sameIframe && s4.parentIsSlot,
        `${r4 ? (r4.ok ? `cued after ${r2(r4.ms / 1000)} s` : `${r4.code} ${r4.message}`) : 'no result'} · ${states(h4)} · adSeconds ${r2(s4.adSeconds)} · unmuted ad samples ${loud4.length} · same iframe ${s4.sameIframe}`,
      );
      if (longAds) skip('4b', 'play() during the pre-roll', 'see (4)');
      else check(
        '4b',
        'a play() issued during the pre-roll starts the song from ≈ 0 right after the cue',
        r4p && r4p.ok && r4 && r4p.ms >= r4.ms && r4p.ms - r4.ms < 2000 && r4p.pos < 1.0 && s4.state === 'playing' && idx('playing') > idx('cued') && s4.playerVolume === 50 && s4.playerMuted === false,
        r4p ? `${r4p.ok ? `PLAYING ${r4p.ms - (r4 ? r4.ms : 0)} ms after the cue resolved, at ${r2(r4p.pos)} s` : `${r4p.code} ${r4p.message}`} · state ${s4.state} · volume ${s4.playerVolume} · muted ${s4.playerMuted}` : 'no result',
      );
      // ── (4u) the unmuted pre-roll: unmuted at volume 0 from start to cue, never audible ──
      {
        const until = r4 && r4.at ? r4.at : Date.now();
        const api = apiSilent(samples4, 'A', until, cue4At);
        const early = loudBefore(wA4, until);
        const ranUnmuted = api.unmuted0 > 0 && !s4.fellBack;
        const detail = `${r4 ? (r4.ok ? `cued after ${r2(r4.ms / 1000)} s` : `${r4.code}`) : 'no result'} · ${story4.samples} samples in 'ad' (ad clock up to ${r2(story4.maxAdClock)} s) · API ${api.n} pre-roll samples: ${api.unmuted0} unmuted at volume 0, ${api.muted} muted, ${api.loud.length} loud${api.loud.length ? ` (e.g. ${J(api.loud[0].A)})` : ''} · went on muted: ${s4.fellBack || 'no'} · ${watchSay(wA4, until)} · then play({volume: 0.5}) → volume ${s4.playerVolume}`;
        const silentOk = ranUnmuted && api.loud.length === 0 && early !== null && early.length === 0 && wA4.polls > 20 && (story4.samples === 0 || wA4.playing > 0);
        if (watch4[0] !== 'installed' && watch4[0] !== 'reset') check('4u', "an unmuted pre-roll (after the gesture) stays inaudible", false, `could not watch the player's frame (${watch4[0]}) · ${detail}`);
        else if (longAds) check('4u', `cue(…, {unmuted: true}) after the gesture: unmuted at volume 0 and never audible over ${r2(story4.maxAdClock)} s of ads (the cue outlasted the wait, see (4))`, silentOk, detail);
        else check(
          '4u',
          "cue(…, {unmuted: true}) after the gesture: the pre-roll runs UNMUTED at volume 0 (getVolume() 0, isMuted() false) and the player's own <video> never plays unmuted above 0 until play() raises it",
          r4 && r4.ok && ranUnmuted && api.loud.length === 0 && early !== null && early.length === 0 && wA4.polls > 20 && (story4.samples === 0 || wA4.playing > 0) && s4.playerVolume === 50,
          detail,
        );
      }

      // ── (4w) unlock(): a running muted pre-roll goes on unmuted at volume 0 ──
      {
        const rB = await page.evaluate(() => ytHarness.results.B);
        const un = await page.evaluate(() => ytHarness.unlocked.B);
        const sB = await page.evaluate(() => ytHarness.snap('B'));
        const wB = await readWatch('slotB');
        const until = rB && rB.at ? rB.at : Date.now();
        const after = un && un.at ? un.at + 1500 : until; // the player's copy of its volume lags a command
        const apiAll = apiSilent(samples4, 'B', until, t4);
        const apiAfter = apiSilent(samples4, 'B', until, after);
        // (a short ad may end before the reported volume catches up: the held song counts too)
        apiAfter.unmuted0 += samples4.filter((r) => r.B && r.B.at >= after && r.B.state === 'cued' && r.B.muted === false && r.B.vol === 0).length;
        const early = loudBefore(wB, until);
        const storyB = adStory(samples4, 'B');
        dump.cue4.B = { result: rB, unlock: un, watch: wB, story: storyB };
        let play = null;
        if (rB && rB.ok) {
          play = await page.evaluate(async () => {
            const B = ytHarness.decks.B;
            const t = performance.now();
            const r = await ytHarness.play('B', { volume: 0.6 });
            const ms = Math.round(performance.now() - t);
            await new Promise((res) => setTimeout(res, 1500));
            const d = B.debug();
            return { ...r, ms, state: B.state, pos: B.position(), vol: d.playerVolume, muted: d.playerMuted, hist: ytHarness.history.B.slice(-3).map((e) => e.state) };
          });
        }
        const detail = `unlock ${un ? `${un.ok} in '${un.state}' after ${un.ms} ms (adSeconds ${r2(un.adSeconds)}, player muted before: ${un.wasMuted}; again → ${un.again})${un.why ? ` — ${un.why}` : ''}` : 'never called'} · ${rB ? (rB.ok ? `cued after ${r2(rB.ms / 1000)} s` : `${rB.code} ${rB.message}`) : 'no result'} · ${storyB.samples} samples in 'ad' · API after unlock: ${apiAfter.n} samples, ${apiAfter.unmuted0} unmuted at 0, ${apiAfter.muted} muted, ${apiAll.loud.length} loud over the whole pre-roll${apiAll.loud.length ? ` (e.g. ${J(apiAll.loud[0].B)})` : ''} · ${watchSay(wB, until)} · play → ${play ? `${play.ok ? `PLAYING in ${play.ms} ms` : play.code}, volume ${play.vol}, muted ${play.muted}, pos ${r2(play.pos)}, ${play.hist.join('>')}` : 'not tried'}`;
        const bLong = rB && !rB.ok && rB.code === 'timeout' && storyB.longestStall < 5;
        if (un && un.ok === null) skip('4w', 'unlock() of a running muted pre-roll', `INCONCLUSIVE: no ad was served, the cue was over first (${detail})`);
        else if (bLong) check('4w', `unlock() during a muted pre-roll: it goes on unmuted at volume 0 and stays inaudible over ${r2(storyB.maxAdClock)} s of ads (the cue outlasted the wait)`, un && un.ok === true && un.again === true && apiAfter.unmuted0 > 0 && apiAll.loud.length === 0 && early !== null && early.length === 0, detail);
        else check(
          '4w',
          "unlock() during a muted pre-roll: it goes on unmuted at volume 0, never audible, still cues; play() then raises the volume with no second ad",
          un && un.ok === true && un.again === true && rB && rB.ok && sB.fellBack === '' && apiAfter.unmuted0 > 0 && apiAll.loud.length === 0 && early !== null && early.length === 0 && watch4[1] !== null &&
            play && play.ok && play.ms < 2500 && play.state === 'playing' && play.vol === 60 && play.muted === false && play.pos < 2.5 && !play.hist.includes('ad'),
          detail,
        );
        await page.evaluate(() => ytHarness.decks.B.stop());
      }

      // ── (cc) captions stay off on a playing song ──
      // (2) sampled deck A's first song, here deck A plays video C (which shows captions by default).
      if (!longAds) dump.captionsC = await captionSamples('slotA', 6000);
      {
        const all = [...(dump.captionsA || []), ...(dump.captionsC || [])].filter((c) => !c.ad);
        const conclusive = all.filter((c) => Array.isArray(c.modules) && c.modules.includes('captions'));
        const shown = all.filter((c) => c.segments > 0 || c.on === true);
        const detail = `${all.length} samples of a playing song (${(dump.captionsA || []).length} of A's first song, ${(dump.captionsC || []).length} of video C) · ${conclusive.length} with a captions module loaded · ${shown.length} with captions on/drawn${shown.length ? ` (e.g. ${J(shown[0])})` : ''}`;
        if (!conclusive.length && !shown.length) skip('cc', 'no captions on a playing song', `INCONCLUSIVE: neither video has captions here (${detail})`);
        else check('cc', "no captions on a playing song: the player's own frame draws none and says subtitles are off", all.length >= 6 && shown.length === 0 && all.every((c) => c.on === false), detail);
      }

      const st4 = await page.evaluate(async () => {
        const A = ytHarness.decks.A;
        const sl = (ms) => new Promise((r) => setTimeout(r, ms));
        A.stop();
        await sl(1200);
        const p0 = A.position();
        await sl(500);
        return { state: A.state, muted: A.muted, playerMuted: A.debug().playerMuted, ps: A.debug().playerState, spread: Math.abs(A.position() - p0) };
      });
      if (longAds) skip('4c', 'stop()', 'see (4)');
      else check('4c', 'stop() pauses and mutes', st4.state === 'paused' && st4.muted === true && st4.playerMuted === true && st4.ps === 2 && st4.spread < 0.02, `state ${st4.state} · player muted ${st4.playerMuted} · playerState ${st4.ps} · spread ${r2(st4.spread)} s`);

      // ── (4e) a stopped deck stays silent: a start it did not ask for (here a real click on its
      // player) is paused back, as a load that ignored stop()'s pause would be ──
      if (longAds) skip('4e', 'a stopped deck stays silent', 'see (4)');
      else {
        const aRect = await page.evaluate(() => {
          const r = ytHarness.decks.A.iframe.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const e0 = await page.evaluate(() => ytHarness.snap('A'));
        await page.mouse.click(aRect.x, aRect.y);
        const eRows = [];
        for (let i = 0; i < 12; i++) {
          await sleep(250);
          eRows.push(await page.evaluate(() => {
            const d = ytHarness.decks.A.debug();
            return { state: d.state, ps: d.playerState, ct: d.currentTime, muted: d.playerMuted };
          }));
        }
        const e1 = await page.evaluate(() => ytHarness.snap('A'));
        await sleep(1500);
        const e2 = await page.evaluate(() => ytHarness.snap('A'));
        const eMoved = Math.max(...eRows.map((r) => (typeof r.ct === 'number' ? r.ct : 0)), e2.currentTime) - e0.currentTime;
        const eDetail = `heldBack ${e0.heldBack} → ${e2.heldBack} · deck/player states after the click: ${eRows.map((r) => `${r.state}/${r.ps}`).filter((x, i, a) => x !== a[i - 1]).join(' > ')} · player clock moved ${r2(eMoved)} s, then ${r2(e2.currentTime - e1.currentTime)} s in the last 1.5 s · muted ${e2.playerMuted}`;
        // The deck may catch the start while it is still buffering (3): paused back, but not counted in
        // heldBack (which counts starts that reached PLAYING). Either way the player must end up still.
        const eStarted = e2.heldBack > e0.heldBack || eMoved > 0.05 || eRows.some((r) => r.ps === 1 || r.ps === 3);
        if (!eStarted) {
          skip('4e', 'a stopped deck stays silent', `INCONCLUSIVE: the click did not start YouTube's player at all (${eDetail})`);
        } else check(
          '4e',
          "a click on a stopped deck's player is paused back: muted, still 'paused', its clock still",
          e2.state === 'paused' && eRows.every((r) => r.state === 'paused' && r.muted !== false) && e2.playerState === 2 && e2.playerMuted === true && eMoved < 1.5 && Math.abs(e2.currentTime - e1.currentTime) < 0.05,
          eDetail,
        );
      }

      // ── (4d) stop() while the next video is still loading, then the stage is hidden (main.js leaving
      // video mode). A pause sent in that window used to be ignored: the ad, then the song, played on
      // muted inside the hidden player. Deck B loads video A (new to it: a fresh load and pre-roll).
      console.log('\n(4d) stop() inside the load window, stage hidden');
      const d4 = await page.evaluate(async (id) => {
        const B = ytHarness.decks.B;
        const sl = (ms) => new Promise((r) => setTimeout(r, ms));
        ytHarness.startCue('B', id, { timeoutMs: 120000 });
        await sl(700);
        const at = { state: B.state, ps: B.debug().playerState };
        B.stop();
        document.getElementById('slotB').style.display = 'none';
        return at;
      }, ID_A);
      const d4Rows = [];
      const d4End = Date.now() + 30000;
      while (Date.now() < d4End) {
        const deck = await page.evaluate(() => {
          const d = ytHarness.decks.B.debug();
          return { state: d.state, ps: d.playerState, ct: d.currentTime, heldBack: d.heldBack, hidden: !ytHarness.decks.B.iframe.checkVisibility() };
        });
        const videos = await inFrame('slotB', VIDEOS_JS);
        d4Rows.push({ t: d4Rows.length, ...deck, videos });
        await sleep(1000);
      }
      await page.evaluate(() => (document.getElementById('slotB').style.display = ''));
      const d4Late = d4Rows.slice(5); // the first seconds may show the start being paused back
      const d4Cts = d4Late.map((r) => (typeof r.ct === 'number' ? r.ct : 0));
      const d4Playing = d4Late.filter((r) => r.ps === 1 || (Array.isArray(r.videos) && r.videos.some((v) => !v.paused)));
      const d4VideoMoved = (() => {
        const first = d4Late.find((r) => Array.isArray(r.videos));
        const last = [...d4Late].reverse().find((r) => Array.isArray(r.videos));
        if (!first || !last) return null;
        return Math.max(0, ...last.videos.map((v, i) => Math.abs(v.t - ((first.videos[i] || {}).t ?? v.t))));
      })();
      dump.stopLoading = { at: d4, rows: d4Rows };
      const d4Last = d4Rows[d4Rows.length - 1] || {};
      check(
        '4d',
        'stop() during the load window: with the stage hidden, nothing plays for 30 s (no ad, no song)',
        d4Rows.every((r) => r.hidden) && d4Last.state === 'empty' && d4Playing.length === 0 && Math.max(...d4Cts) - Math.min(...d4Cts) < 0.1 && d4VideoMoved !== null && d4VideoMoved < 0.1,
        `stopped while '${d4.state}' (playerState ${d4.ps}) · player clock ${r2(Math.min(...d4Cts))} → ${r2(Math.max(...d4Cts))} s over the last 25 s · <video> moved ${d4VideoMoved === null ? 'unread' : `${r2(d4VideoMoved)} s`} · ${d4Playing.length} samples playing · heldBack ${d4Last.heldBack} · state ${d4Last.state}`,
      );

      // ── (9b) a real background tab: unmuted pre-rolls run on and cue there, a muted one is held ──
      // A (unmuted, started in front) and C (muted: the control, a player that has only played muted)
      // pre-roll the same video; once C's ad runs the tab goes to the background, where B (it has played
      // with sound before) starts an unmuted pre-roll of its own; A, once cued, is played there.
      console.log('\n(9b) background tab, real throttling: unmuted pre-rolls run on, a muted one is held');
      {
        const w9 = [await watchFrame('slotA'), await watchFrame('slotB'), await watchFrame('slotC')];
        await page.evaluate((b, WAIT) => {
          ytHarness.startSampler(['A', 'B', 'C'], 250);
          ytHarness.startCue('A', b, { timeoutMs: WAIT, unmuted: true });
          ytHarness.startCue('C', b, { timeoutMs: WAIT });
        }, ID_B, CUE_WAIT_MS);
        // hide once an ad is really running (C's, else A's), or after 60 s
        const adEnd = Date.now() + 60000;
        while (Date.now() < adEnd) {
          const ok = await page.evaluate(() => ['C', 'A'].some((n) => ytHarness.decks[n].state === 'ad' && ytHarness.decks[n].adSeconds > 2) || (ytHarness.results.A && ytHarness.results.C));
          if (ok) break;
          await sleep(500);
        }
        const toFront = await sendToBackground(page);
        await sleep(300);
        const hideAt = await page.evaluate(() => Date.now());
        const vis0 = await page.evaluate(() => document.visibilityState);
        await page.evaluate((c, WAIT) => ytHarness.startCue('B', c, { timeoutMs: WAIT, unmuted: true }), ID_D, CUE_WAIT_MS);
        // timers in the hidden page now run about once a second (measured: browser.mjs)
        const rate = await page.evaluate(() => new Promise((res) => {
          let n = 0;
          const t = performance.now();
          const iv = setInterval(() => n++, 50);
          setTimeout(() => { clearInterval(iv); res(n / ((performance.now() - t) / 1000)); }, 3000);
        }));
        let playA = null;
        // until both cues are over (each deck gives up after CUE_WAIT_MS: ad pods of 230-250 s were served)
        const hideEnd = Date.now() + CUE_WAIT_MS + 30000;
        while (Date.now() < hideEnd) {
          const r = await page.evaluate(() => ({ A: ytHarness.results.A, B: ytHarness.results.B }));
          if (r.A && r.A.ok && !playA) {
            playA = await page.evaluate(async () => {
              const A = ytHarness.decks.A;
              const at = Date.now();
              const res = await ytHarness.play('A', { volume: 0.7 });
              const p0 = A.position();
              await new Promise((done) => setTimeout(done, 4000));
              const d = A.debug();
              return { ...res, at, ms: Date.now() - at, state: A.state, moved: A.position() - p0, vol: d.playerVolume, muted: d.playerMuted, hidden: document.visibilityState === 'hidden' };
            });
          }
          if (r.A && r.B && (playA || !r.A.ok)) break;
          await sleep(2000);
        }
        const rows9 = await page.evaluate(() => ytHarness.stopSampler());
        const res9 = await page.evaluate(() => ytHarness.results);
        const snaps9 = await page.evaluate(() => [ytHarness.snap('A'), ytHarness.snap('B'), ytHarness.snap('C')]);
        const watches9 = [await readWatch('slotA'), await readWatch('slotB'), await readWatch('slotC')];
        const hiddenRows = rows9.filter((r) => r.A && r.A.hidden);
        await toFront();
        dump.bg9 = { rows: rows9, results: res9, playA, watches: watches9, hideAt, rate };
        const hid = (r) => r && r.hidden === true;
        console.log(`  hidden at ${vis0}, page timers ${r2(rate)}/s while hidden; ${hiddenRows.length} hidden samples`);
        // A: started in front, its pre-roll must run on hidden (unmuted at 0) and cue there; then it plays there
        {
          const rA = res9.A;
          const until = playA ? playA.at : Date.now();
          const api = apiSilent(rows9, 'A', until);
          const adHidden = rows9.filter((r) => r.A.hidden && r.A.state === 'ad');
          const adMovedHidden = adHidden.length > 1 ? Math.max(...adHidden.map((r) => r.A.ct || 0)) - Math.min(...adHidden.map((r) => r.A.ct || 0)) : 0;
          const early = loudBefore(watches9[0], until);
          const detail = `${rA ? (rA.ok ? `cued after ${r2(rA.ms / 1000)} s, ${hid(rA) ? 'while hidden' : 'BEFORE the tab was hidden'}` : `${rA.code} ${rA.message}`) : 'no result'} · ${adHidden.length} hidden samples in 'ad' (ad clock moved ${r2(adMovedHidden)} s there) · went on muted: ${snaps9[0].fellBack || 'no'} · API ${api.n} pre-roll samples: ${api.unmuted0} unmuted at 0, ${api.muted} muted, ${api.loud.length} loud · ${watchSay(watches9[0], until)} · play while hidden → ${playA ? `${playA.ok ? 'PLAYING' : `${playA.code} ${playA.message}`} in ${playA.ms - 4000} ms, moved ${r2(playA.moved)} s in 4 s, volume ${playA.vol}, muted ${playA.muted}, hidden ${playA.hidden}` : 'not tried'}`;
          const longA = rA && !rA.ok && rA.code === 'timeout' && adMovedHidden > 30;
          if (rA && rA.ok && !hid(rA)) skip('9bA', 'an unmuted pre-roll runs on in a background tab', `INCONCLUSIVE: its ad was over before the tab went to the background (${detail})`);
          else if (longA) check('9bA', `background tab: an unmuted pre-roll started in front runs on hidden — its ad clock moved ${r2(adMovedHidden)} s there, unmuted at volume 0, never audible (the ads outlasted the wait, so the cue timed out as designed)`, !snaps9[0].fellBack && api.unmuted0 > 0 && api.loud.length === 0 && early !== null && early.length === 0, detail);
          else check(
            '9bA',
            'background tab: an unmuted pre-roll started in front runs on hidden (unmuted at volume 0, never audible) and cues there; play() then starts it with sound, still hidden',
            rA && rA.ok && hid(rA) && !snaps9[0].fellBack && api.unmuted0 > 0 && api.loud.length === 0 && early !== null && early.length === 0 && playA && playA.ok && playA.hidden && playA.moved > 2.5 && playA.vol === 70 && playA.muted === false,
            detail,
          );
        }
        // B: its pre-roll starts while hidden
        {
          const rB = res9.B;
          const until = rB && rB.at ? rB.at : Date.now();
          const api = apiSilent(rows9, 'B', until);
          const early = loudBefore(watches9[1], until);
          const storyB9 = adStory(rows9, 'B');
          if (rB && !rB.ok && rB.code === 'timeout' && storyB9.clockRun > 30) check('9bB', `background tab: an unmuted pre-roll STARTED while hidden runs there — ${r2(storyB9.clockRun)} s of ad clock, never audible (the ads outlasted the wait)`, api.loud.length === 0 && early !== null && early.length === 0 && api.unmuted0 > 0, `${rB.code} · ${watchSay(watches9[1], until)}`);
          else check(
            '9bB',
            'background tab: an unmuted pre-roll STARTED while hidden (on a player that has played with sound) reaches its song there, inaudible throughout',
            rB && rB.ok && hid(rB) && snaps9[1].state === 'cued' && snaps9[1].playerVideoId === ID_D && !snaps9[1].fellBack && api.loud.length === 0 && early !== null && early.length === 0,
            `${rB ? (rB.ok ? `cued after ${r2(rB.ms / 1000)} s, hidden ${hid(rB)}` : `${rB.code} ${rB.message}`) : `no result after ${r2((Date.now() - hideAt) / 1000)} s`} · player on ${snaps9[1].playerVideoId === ID_D ? 'the new video' : snaps9[1].playerVideoId} · ${adStory(rows9, 'B').samples} samples in 'ad' · ${states(snaps9[1].history.slice(-6))} · adSeconds ${r2(snaps9[1].adSeconds)} · API ${api.n} pre-roll samples: ${api.unmuted0} unmuted at 0, ${api.muted} muted, ${api.loud.length} loud · ${watchSay(watches9[1], until)}`,
          );
        }
        // C (control, muted): Chrome holds its ad still in the background — and adSeconds must stand still with it
        {
          const cRows = rows9.filter((r) => r.C.hidden && r.C.state === 'ad');
          let frozenS = 0;
          let adGrewWhileFrozen = 0;
          let adGrewWhileMoving = 0;
          let clockMoved = 0;
          // (the deck's tick may come one sample after the sampler saw a step: the first still pair after a
          // step can carry that step's adSeconds, so it counts with the step)
          let lastMoved = false;
          for (let i = 1; i < cRows.length; i++) {
            const a = cRows[i - 1].C;
            const b = cRows[i].C;
            const dt = (b.at - a.at) / 1000;
            if (dt > 3) continue; // (a gap in the samples)
            const still = Math.abs((b.ct || 0) - (a.ct || 0)) < 0.01;
            if (still && !lastMoved) {
              frozenS += dt;
              adGrewWhileFrozen += Math.max(0, b.ad - a.ad);
            } else {
              clockMoved += Math.max(0, (b.ct || 0) - (a.ct || 0));
              adGrewWhileMoving += Math.max(0, b.ad - a.ad);
            }
            lastMoved = !still;
          }
          const rC = res9.C;
          const detail = `${cRows.length} hidden samples in 'ad': clock frozen for ${r2(frozenS)} s (adSeconds grew ${r2(adGrewWhileFrozen)} s meanwhile), moved ${r2(clockMoved)} s (adSeconds grew ${r2(adGrewWhileMoving)} s) · C ${rC ? (rC.ok ? `cued, hidden ${hid(rC)}` : `${rC.code} ${rC.message}`) : 'still pre-rolling'} · ${states(snaps9[2].history.slice(-6))}`;
          // Measured: Chrome sometimes holds a muted ad still in a hidden tab, sometimes lets it crawl on at
          // about half speed (2026-10-06). Either way adSeconds must follow the ad's clock, not the wall clock.
          const spanS = cRows.length > 1 ? (cRows[cRows.length - 1].C.at - cRows[0].C.at) / 1000 : 0;
          if (spanS < 10) skip('9bC', "adSeconds follows the ad's clock in a background tab", `INCONCLUSIVE: the muted pre-roll spent ${r2(spanS)} s in its ad while hidden (${detail})`);
          else check('9bC', `control (muted pre-roll, hidden ${r2(spanS)} s in its ad): adSeconds follows the ad's own clock — it stands still while the clock is held and grows no faster than it`, adGrewWhileFrozen < 0.5 && adGrewWhileMoving <= clockMoved * 1.1 + 1.5, detail);
        }
        // back in front: a deck whose cue failed / was dropped must not start playing by itself
        await sleep(6000);
        const q0 = await page.evaluate(() => ['A', 'B', 'C'].map((n) => ({ n, state: ytHarness.decks[n].state, ct: ytHarness.decks[n].debug().currentTime, ps: ytHarness.decks[n].debug().playerState })));
        await sleep(5000);
        const q1 = await page.evaluate(() => ['A', 'B', 'C'].map((n) => ({ n, state: ytHarness.decks[n].state, ct: ytHarness.decks[n].debug().currentTime, ps: ytHarness.decks[n].debug().playerState })));
        const idle = q1.filter((x, i) => x.state === 'error' || x.state === 'empty' || (x.state === 'cued' && q0[i].state === 'cued'));
        const runaway = idle.filter((x) => Math.abs((x.ct || 0) - (q0[q1.indexOf(x)].ct || 0)) > 0.05);
        check('9c', "back in front: no idle deck's player runs by itself (cued decks stay on their cue point, a failed one stays still)", runaway.length === 0, q1.map((x, i) => `${x.n} ${q0[i].state}→${x.state} ps ${x.ps} clock ${r2(q0[i].ct)}→${r2(x.ct)}`).join(' · '));
        await page.evaluate(() => ['A', 'B', 'C'].forEach((n) => ytHarness.decks[n].stop()));
      }

      // ── (6) destroy ──
      console.log('\n(6) destroy');
      const before6 = await page.evaluate(() => ytHarness.leftovers());
      await page.evaluate(() => ytHarness.destroyAll());
      await sleep(1500); // let anything that would still fire, fire
      const after6 = await page.evaluate(() => ytHarness.leftovers());
      const postCalls = await page.evaluate(async () => {
        const d = ytHarness.decks.A;
        d.pause();
        d.setVolume(0.3);
        d.seek(10);
        d.prime();
        d.stop();
        const r = await ytHarness.cue('A', 'abcdefghijk');
        return { r, state: d.state };
      });
      check(
        '6',
        'destroy leaves no iframe, timer or listener (and later calls are inert)',
        after6.iframes === 0 && after6.slotChildren.every((n) => n === 0) && after6.ownTimers === 0 && after6.ownListeners === 0 && after6.deckTimers.every((t) => t === false) && postCalls.r.code === 'cancelled',
        `before: ${before6.iframes} iframes, ${before6.ownTimers} deck timers · after: ${after6.iframes} iframes, slots ${after6.slotChildren.join('/')}, deck timers ${after6.ownTimers}, deck listeners ${after6.ownListeners} ${JSON.stringify(after6.detail)} · cue after destroy → ${postCalls.r.code}`,
      );

      await mkdir(new URL('../fixtures/', import.meta.url), { recursive: true });
      await writeFile(new URL('../fixtures/ytdeck-e2e-samples.json', import.meta.url), JSON.stringify(dump));
      console.log('  (samples written to tests/fixtures/ytdeck-e2e-samples.json, git-ignored)');

      // ── (1s) what YouTube received ──
      {
        const leaked = outgoing.filter((r) => r.url.includes(LEAK) || r.referer.includes(LEAK));
        const inPlayer = outgoing.filter((r) => /^https:\/\/www\.youtube-nocookie\.com\/(youtubei|api\/stats|ptracking|pagead)/.test(r.url) || (/^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(r.referer) && !r.url.startsWith('https://www.youtube-nocookie.com/embed/')));
        const embeds = outgoing.filter((r) => /^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(r.url));
        const embedRefOk = embeds.length > 0 && embeds.every((r) => r.referer === 'https://aarushkandukoori.github.io/');
        check(
          '1s',
          "no request to YouTube / Google carries the page's query (URL or Referer); the embeds' Referer is the bare origin",
          outgoing.length >= 20 && inPlayer.length >= 5 && leaked.length === 0 && embedRefOk,
          `${outgoing.length} outgoing requests (${inPlayer.length} from inside the players, ${embeds.length} embed loads, Referer ${[...new Set(embeds.map((r) => r.referer))].join(' / ')}) · ${leaked.length} with the marker${leaked.length ? `: ${leaked.slice(0, 3).map((r) => r.url.replace(/\?.*/, '')).join(', ')}` : ''}`,
        );
      }

      // ── (7) CSP ──
      const csp = await page.evaluate(() => ytHarness.csp);
      const cspConsole = logs.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l.text));
      check('7', 'zero CSP violations under the production policy', csp.length === 0 && cspConsole.length === 0, csp.length || cspConsole.length ? JSON.stringify(csp.slice(0, 3)) + ' ' + cspConsole.slice(0, 2).map((l) => l.text.slice(0, 160)).join(' | ') : 'securitypolicyviolation events: 0, console: 0');
      const pageErrors = errors.filter((e) => !/Failed to load resource|ERR_BLOCKED_BY_CLIENT|doubleclick|googleads|net::/i.test(e));
      if (pageErrors.length) console.log(`  note: ${pageErrors.length} console error(s) from the page / YouTube, e.g. ${pageErrors.slice(0, 3).map((e) => e.slice(0, 140)).join(' | ')}`);
      const ownErrors = errors.filter((e) => /ytdeck|ytHarness/.test(e));
      check('7b', 'no page error from the deck or the harness', ownErrors.length === 0, ownErrors.slice(0, 2).join(' | '));
    } catch (err) {
      check('chrome', 'Chrome run completed', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' ') : String(err));
    } finally {
      if (site && !(await site.close())) console.log('  note: puppeteer did not confirm that interception was switched off (harmless at the end of a run)');
    }

    // ── (8) control: plain http://127.0.0.1 ──
    console.log('\n(8) control: the same label video on http://127.0.0.1 (serve.mjs, no interception)');
    const srv = await startServer();
    try {
      const p8 = await browser.newPage();
      await p8.goto(`${srv.url}/${HARNESS}`, { waitUntil: 'load' });
      await p8.waitForFunction(() => window.ytHarness && window.ytHarness.ready === true, { timeout: 20000 });
      await p8.evaluate(() => ytHarness.create('A', 'slotA'));
      const r8 = await p8.evaluate((id) => ytHarness.cue('A', id, { timeoutMs: 60000 }), ID_A);
      const s8 = await p8.evaluate(() => ytHarness.snap('A'));
      check(
        '8',
        'label video on http://127.0.0.1 ends in DeckError 150 (why tests need the origin harness)',
        !r8.ok && r8.code === 150 && s8.state === 'error',
        `${r8.ok ? 'it played!' : `${r8.code}: ${r8.message}`} · ${states(s8.history)}`,
      );
      await p8.close();
    } catch (err) {
      check('8', 'control on 127.0.0.1 ran', false, String(err && err.message ? err.message : err));
    }

    // ── (L) the API script blocked (content blocker / network) ──
    console.log('\n(L) the IFrame API script blocked');
    try {
      const p9 = await browser.newPage();
      await p9.setRequestInterception(true);
      // Registered before serveAsOrigin, so it answers first (serveAsOrigin skips handled requests).
      p9.on('request', (req) => {
        if (!req.isInterceptResolutionHandled() && req.url().startsWith('https://www.youtube.com/iframe_api')) req.abort('blockedbyclient').catch(() => {});
      });
      const site9 = await serveAsOrigin(p9);
      await p9.goto(site9.url(HARNESS), { waitUntil: 'load' });
      await p9.waitForFunction(() => window.ytHarness && window.ytHarness.ready === true, { timeout: 20000 });
      const l = await p9.evaluate(async () => {
        const t = performance.now();
        let api;
        try {
          await ytHarness.mod.loadYouTubeApi({ timeoutMs: 8000 });
          api = { ok: true };
        } catch (e) {
          api = { ok: false, message: e.message, ms: Math.round(performance.now() - t) };
        }
        ytHarness.create('A', 'slotA');
        const cue = await ytHarness.cue('A', 'abcdefghijk');
        return { api, cue, state: ytHarness.decks.A.state, scripts: document.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]').length };
      });
      check(
        'L',
        "a blocked iframe_api rejects fast with a clear Error; the deck reports DeckError 'api'",
        !l.api.ok && l.api.ms < 5000 && /YouTube player/.test(l.api.message) && !l.cue.ok && l.cue.code === 'api' && l.state === 'error' && l.scripts === 0,
        `${l.api.ok ? 'loaded?!' : `“${l.api.message}” after ${l.api.ms} ms`} · cue → ${l.cue.code} · state ${l.state} · failed script tags left: ${l.scripts}`,
      );
      await site9.close();
      await p9.close();
    } catch (err) {
      check('L', 'blocked-API check ran', false, String(err && err.message ? err.message : err));
    } finally {
      // Chrome first: its keep-alive sockets would hold server.close() open.
      await bounded(session.close(), 15000, 'closing Chrome');
      await bounded(srv.close(), 5000, 'closing the 127.0.0.1 server');
    }
  }

  // ── (F) headless Firefox, reduced flow ──
  if (wantFirefox && !existsSync(FIREFOX)) skip('F', 'Firefox flow', `not installed at ${FIREFOX} (FIREFOX_PATH)`);
  else if (wantFirefox) await runFirefox();

  async function runFirefox() {
    console.log('\n(F) headless Firefox (autoplay allowed by tests/e2e/engine/firefox.mjs prefs)');
    let session;
    let site;
    try {
      session = await launchFirefox({ width: 1100, height: 800 });
    } catch (err) {
      skip('F', 'Firefox flow', `could not launch: ${err && err.message ? err.message : err}`);
      return;
    }
    const { page } = session;
    try {
      try {
        site = await serveAsOrigin(page);
        await page.goto(site.url(HARNESS), { waitUntil: 'load', timeout: 20000 });
        await page.waitForFunction(() => window.ytHarness && window.ytHarness.ready === true, { timeout: 20000 });
      } catch (err) {
        skip('F', 'Firefox flow', `request interception could not serve the origin here: ${String(err && err.message ? err.message : err).slice(0, 160)}`);
        return;
      }
      const where = await page.evaluate(() => location.href);
      check('F0', 'Firefox page runs under the real origin (interception answered)', where.startsWith('https://aarushkandukoori.github.io/segue/'), where);
      await page.evaluate(() => {
        ytHarness.create('A', 'slotA');
        ytHarness.create('C', 'slotC');
      });
      const rdy = await page.evaluate(async () => [await ytHarness.whenReady('A', 40000), await ytHarness.whenReady('C', 40000)]);
      check('F1', 'players become ready', rdy[0] && rdy[1]);
      // A pre-rolls unmuted at volume 0 (autoplay is allowed here), C muted, at the same time
      await page.evaluate((a, b, WAIT) => {
        ytHarness.startSampler(['A', 'C'], 250);
        ytHarness.startCue('C', b, { timeoutMs: WAIT });
        ytHarness.startCue('A', a, { unmuted: true, timeoutMs: WAIT });
      }, ID_A, ID_B, CUE_WAIT_MS);
      await pollUntil(page, () => !!(ytHarness.results.A && ytHarness.results.C), CUE_WAIT_MS + 15000);
      const rc = (await page.evaluate(() => ytHarness.results.A)) || { ok: false, code: 'no result' };
      const rcC = (await page.evaluate(() => ytHarness.results.C)) || { ok: false, code: 'no result' };
      const sf = await page.evaluate(() => ytHarness.stopSampler());
      const s = await page.evaluate(() => ytHarness.snap('A'));
      const sC = await page.evaluate(() => ytHarness.snap('C'));
      const loud = sf.filter((row) => row.A.state !== 'cued' && row.A.muted === false && row.A.vol !== 0);
      const unmuted0 = sf.filter((row) => (row.A.state === 'ad' || row.A.state === 'loading') && row.A.muted === false && row.A.vol === 0).length;
      const loudC = sf.filter((row) => row.C.state !== 'cued' && row.C.muted === false);
      const storyF = adStory(sf, 'A');
      const longF = !rc.ok && rc.code === 'timeout' && storyF.longestStall < 5 && storyF.clockRun > 30;
      if (longF) check('F2', `cue(…, {unmuted: true}): unmuted at volume 0 and never audible over ${r2(storyF.clockRun)} s of ads (they outlasted the wait; C muted throughout)`, loud.length === 0 && unmuted0 > 0 && loudC.length === 0, `A ${rc.code} · ${unmuted0} samples unmuted at 0, ${loud.length} loud · C ${rcC.ok ? 'ok' : rcC.code}, ${loudC.length} unmuted`);
      else check('F2', "cue → 'cued' at ≈ 0: muted throughout (C), and unmuted at volume 0 throughout (A, cue(…, {unmuted: true}))", rc.ok && s.state === 'cued' && Math.abs(s.position) <= 0.5 && loud.length === 0 && unmuted0 > 0 && !s.fellBack && rcC.ok && sC.state === 'cued' && loudC.length === 0, `A ${rc.ok ? 'ok' : `${rc.code} ${rc.message}`} · ${states(s.history)} · adSeconds ${r2(s.adSeconds)} · pos ${r2(s.position)} · ${unmuted0} samples unmuted at 0, ${loud.length} loud, went on muted: ${s.fellBack || 'no'} · C ${rcC.ok ? 'ok' : `${rcC.code} ${rcC.message}`}, ${loudC.length} unmuted`);
      if (rc.ok) {
        const rp = await page.evaluate(() => ytHarness.play('A', { volume: 0.8 }));
        const rows = await page.evaluate(() => ytHarness.track('A', 4000, 100));
        const a = rows[0];
        const b = rows[rows.length - 1];
        const rate = (b.pos - a.pos) / (b.wall - a.wall);
        const err = Math.max(...rows.filter((x) => x.state === 'playing').map((x) => Math.abs(x.pos - x.cur)));
        const after = await page.evaluate(() => ytHarness.snap('A'));
        check('F3', 'play → PLAYING at the volume asked for, ~1 s/s, position() within 0.15 s of getCurrentTime()', rp.ok && Math.abs(rate - 1) < 0.08 && err < 0.15 && after.playerVolume === 80 && after.playerMuted === false, `${rp.ok ? 'ok' : `${rp.code} ${rp.message}`} · rate ${r2(rate)} · worst error ${r2(err * 1000) / 1000} s · volume ${after.playerVolume}, muted ${after.playerMuted}`);
      }
      const rm = await page.evaluate((id) => ytHarness.cue('C', id, { timeoutMs: 30000 }), MISSING);
      check('F4', 'error path: nonexistent id → DeckError with the player’s code', !rm.ok && typeof rm.code === 'number', `${rm.code}: ${rm.message}`);
      await page.evaluate(() => ytHarness.destroyAll());
      await sleep(1000);
      const left = await page.evaluate(() => ytHarness.leftovers());
      check('F5', 'destroy leaves no iframe, timer or listener', left.iframes === 0 && left.ownTimers === 0 && left.ownListeners === 0, JSON.stringify({ iframes: left.iframes, timers: left.ownTimers, listeners: left.ownListeners }));
      const csp = await page.evaluate(() => ytHarness.csp);
      check('F6', 'zero CSP violations', csp.length === 0, csp.length ? JSON.stringify(csp.slice(0, 3)) : '');
    } catch (err) {
      check('F', 'Firefox run completed', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
    } finally {
      if (site) await site.close();
      await bounded(session.close(), 15000, 'closing Firefox');
    }
  }

  const failed = checks.filter((c) => !c.ok);
  const skipped = checks.filter((c) => c.skipped);
  console.log(`\nytdeck e2e: ${checks.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const c of failed) console.log(`  FAIL (${c.id}) ${c.name}`);
  for (const c of skipped) console.log(`  skip (${c.id}) ${c.name} — ${c.detail}`);
  clearTimeout(watchdog);
  process.exit(failed.length ? 1 : 0);
}

// Dispatch last: both roles use module-level constants declared above.
if (typeof window === 'undefined') await runInNode();
else await installHarness();

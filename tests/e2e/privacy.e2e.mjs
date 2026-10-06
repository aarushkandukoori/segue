// README "Privacy" against reality: what a visitor's browser talks to and keeps BEFORE ANY TAP.
// Each scenario gets a fresh Chrome profile, the page served as the real site (origin.mjs: YouTube decides
// per embedding origin) and Chrome's real autoplay policy; the profile's cookies are read over CDP
// (Storage.getCookies) and page state through raw CDP with userGesture:false, so nothing ever gives the page
// user activation. Ads are never skipped or blocked.
//
// What must hold (SPEC.md §6.2):
//   - a plain visit contacts only the page itself and the hosts README's "On every visit" bullet names, and
//     leaves no cookies;
//   - a Preview share link never contacts YouTube or its ad servers;
//   - every cookie any scenario leaves belongs to a site that README "Privacy" names in a bullet or paragraph
//     that also says "cookie", and README says a share link sets them before any tap;
//   - no request to a YouTube or Google host (players, ads, statistics, the API script) carries the page's
//     query — playlist link, seed, vibe, length — in its URL or its Referer: the decks build their own
//     iframe with the page's origin and path only (ytdeck.js youTubeEmbedUrl), and README says exactly that;
//   - the relay hedge delays README states equal HEDGE_MS in js/sources/youtube.js and js/sources/spotify.js.
//
//   node tests/e2e/privacy.e2e.mjs                    everything (~1.5 min, needs Chrome and the network)
//   node tests/e2e/privacy.e2e.mjs static home         only these groups: static home preview full
//   SEGUE_SITE_ROOT=<dir> serves another copy of the site under the real origin (a control run).
//
// Prints one line per check, exits non-zero on a failure.
import { existsSync, readFileSync } from 'node:fs';
import { launch } from './browser.mjs';
import { serveAsOrigin, DEFAULT_ORIGIN } from './origin.mjs';

const ROOT = new URL('../../', import.meta.url);
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wants = (g) => !only.length || only.includes(g);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (group, name, ok, detail = '') => {
  results.push({ name: `[${group}] ${name}`, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} [${group}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
};
const note = (group, text) => console.log(`        [${group}] ${text}`);

// ── README "Privacy" ───────────────────────────────────────────────────────────────────────────

const readme = readFileSync(new URL('README.md', ROOT), 'utf8');
const privacy = (() => {
  const m = /^## Privacy\n([\s\S]*?)(?=^## )/m.exec(readme);
  return m ? m[1] : '';
})();
/** The section's bullets and paragraphs, each as one string (continuation lines joined). */
const blocks = privacy
  .split(/\n(?=- )|\n\s*\n/)
  .map((b) => b.replace(/\s*\n\s*/g, ' ').trim())
  .filter(Boolean);
const COOKIE_WORD = /\bcookies?\b/i; // not the "cookie" inside "youtube-nocookie"
const cookieBlocks = blocks.filter((b) => COOKIE_WORD.test(b));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `site` named as a domain (also as `.site` or `www.site`), not as part of a longer name. */
const namesSite = (text, site) => new RegExp(`(^|[^a-z0-9-])${escapeRe(site)}($|[^a-z0-9-])`, 'i').test(text);
/** youtube.com for .youtube.com, www.youtube.com, … (the last two labels: enough for the sites involved). */
const siteOf = (domain) => domain.replace(/^\./, '').split('.').slice(-2).join('.');
const PAGE_HOST = new URL(DEFAULT_ORIGIN).host;

/** Every cookie must belong to a site README names next to the word "cookie". */
function checkCookiesDocumented(group, cookies) {
  const sites = [...new Set(cookies.map((c) => siteOf(c.domain)))].sort();
  const missing = sites.filter((s) => !cookieBlocks.some((b) => namesSite(b, s)));
  note(group, `cookies before any tap: ${cookies.length ? cookies.map((c) => `${c.domain} ${c.name} (${c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : 'session'})`).join(', ') : 'none'}`);
  check(
    group,
    'README "Privacy" names every site that left a cookie, next to the word "cookie"',
    missing.length === 0,
    missing.length ? `not disclosed: ${missing.join(', ')}` : sites.join(', ') || 'no cookies',
  );
}

// ── static checks (no browser) ────────────────────────────────────────────────────────────────

function groupStatic() {
  const G = 'static';
  check(G, 'README has a "Privacy" section', privacy.length > 200, `${privacy.length} chars`);
  const hedge = (file) => {
    const m = /const HEDGE_MS = (\d+);/.exec(readFileSync(new URL(file, ROOT), 'utf8'));
    return m ? Number(m[1]) : null;
  };
  const seconds = (ms) => `${String(ms / 1000)} s`;
  const yt = hedge('js/sources/youtube.js');
  const sp = hedge('js/sources/spotify.js');
  const ytBlock = blocks.find((b) => /YouTube search/.test(b) && /r\.jina\.ai/.test(b)) || '';
  const spBlock = blocks.find((b) => /Spotify link/.test(b) && /r\.jina\.ai/.test(b)) || '';
  check(G, `YouTube search relays: README says the second relay is asked when the first is silent for ${yt == null ? '?' : seconds(yt)} (youtube.js HEDGE_MS)`, yt != null && ytBlock.includes(`within ${seconds(yt)}`), ytBlock ? '' : 'no bullet names the YouTube search relays');
  check(G, `Spotify relays: README says the next relay is asked when the one before is silent for ${sp == null ? '?' : seconds(sp)} (spotify.js HEDGE_MS)`, sp != null && spBlock.includes(`within ${seconds(sp)}`), spBlock ? '' : 'no bullet names the Spotify relays');
  const share = blocks.find((b) => /share link/i.test(b) && /before you tap/i.test(b)) || '';
  check(G, 'README says opening a share link sets the cookies before any tap', COOKIE_WORD.test(share), share ? '' : 'no share-link bullet');
}

// ── browser scenarios ─────────────────────────────────────────────────────────────────────────

async function open() {
  const b = await launch({ gesture: true });
  b.site = await serveAsOrigin(b.page, process.env.SEGUE_SITE_ROOT ? { root: process.env.SEGUE_SITE_ROOT } : {});
  b.hosts = new Map(); // host → first URL seen
  /** @type {{url: string, host: string, referer: string}[]} every http(s) request not answered by the page's own origin */
  b.outgoing = [];
  b.page.on('request', (r) => {
    let u;
    try {
      u = new URL(r.url());
    } catch {
      return;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    if (!b.hosts.has(u.host)) b.hosts.set(u.host, u.origin + u.pathname);
    if (u.host === PAGE_HOST) return;
    const h = r.headers();
    b.outgoing.push({ url: u.href, host: u.host, referer: h.referer || h.Referer || '' });
  });
  b.store = await b.browser.target().createCDPSession();
  return b;
}
async function close(b) {
  await b.site.close().catch(() => {});
  await b.close();
}
const cookiesOf = async (b) => (await b.store.send('Storage.getCookies')).cookies;
/** Read the page through raw CDP with userGesture:false (puppeteer's evaluate would grant user activation). */
async function peek(b, expression) {
  if (!b.cdp) b.cdp = await b.page.createCDPSession();
  const r = await b.cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(b, cond, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(250);
  }
  return false;
}
const shareUrl = (b, len, seed, vibe = '0.5') => b.site.url(`index.html?p=deezer:chart:0&seed=${seed}&vibe=${vibe}&len=${len}`);
/** YouTube's and Google's hosts: the players, their ads and statistics, the API script, fonts. */
const YT_GOOGLE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com|ggpht\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagservices\.com|google-analytics\.com|googleapis\.com|gstatic\.com|googleusercontent\.com|google\.[a-z]{2,3}(\.[a-z]{2})?)$/;
/** A URL with every percent-encoding layer undone (a query copied into a parameter is encoded once or twice). */
function decodedAll(s) {
  let out = s;
  for (let i = 0; i < 4; i++) {
    let next;
    try {
      next = decodeURIComponent(out.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === out) break;
    out = next;
  }
  return out;
}
const AD_OR_YT = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com)$/;

async function groupHome() {
  const G = 'home';
  const b = await open();
  try {
    await b.page.goto(b.site.url('index.html'), { waitUntil: 'load' });
    await sleep(6000);
    const everyVisit = blocks.find((b2) => /On every visit/i.test(b2)) || '';
    const hosts = [...b.hosts.keys()].filter((h) => h !== PAGE_HOST).sort();
    const undocumented = hosts.filter((h) => !namesSite(everyVisit, h));
    check(G, 'a plain visit contacts only the page and the hosts README\'s "On every visit" bullet names', undocumented.length === 0, undocumented.length ? `also: ${undocumented.map((h) => b.hosts.get(h)).join(', ')}` : hosts.join(', '));
    const cookies = await cookiesOf(b);
    check(G, 'a plain visit leaves no cookies', cookies.length === 0, cookies.map((c) => `${c.domain} ${c.name}`).join(', '));
    check(G, 'README says a plain visit leaves no cookies', blocks.some((b2) => /plain visit/i.test(b2) && /leaves none|no cookies/i.test(b2)));
  } finally {
    await close(b);
  }
}

async function groupPreview() {
  const G = 'preview';
  const b = await open();
  try {
    await b.page.goto(shareUrl(b, 'preview', 'pvcy01'), { waitUntil: 'load' });
    const loaded = await waitFor(b, async () => b.hosts.has('cdnt-preview.dzcdn.net'), 25000);
    await sleep(3000);
    check(G, 'the Preview share link read its playlist and fetched a preview without a tap (the scenario really ran)', loaded && b.hosts.has('api.deezer.com'), [...b.hosts.keys()].join(', '));
    const yt = [...b.hosts.keys()].filter((h) => AD_OR_YT.test(h));
    check(G, 'a Preview share link contacts no YouTube or ad host', yt.length === 0, yt.join(', '));
    check(G, 'still no user activation (nothing was tapped)', (await peek(b, 'navigator.userActivation.hasBeenActive')) === false);
    checkCookiesDocumented(G, await cookiesOf(b));
  } finally {
    await close(b);
  }
}

/** Made at run time, so a hit can only come from this run's address bar. */
const MARK = ['pv', Math.random().toString(36).slice(2, 8)].join('');
const VIBE = '0.43';

async function groupFull() {
  const G = 'full';
  const b = await open();
  try {
    await b.page.goto(shareUrl(b, 'short', MARK, VIBE), { waitUntil: 'load' });
    const api = await waitFor(b, async () => b.hosts.has('www.youtube.com') && [...b.hosts.values()].some((u) => u.endsWith('/iframe_api')), 30000);
    check(G, 'the full-song share link loads YouTube\'s player API without a tap', api);
    const ytCookie = await waitFor(b, async () => (await cookiesOf(b)).some((c) => siteOf(c.domain) === 'youtube.com'), 30000);
    if (!ytCookie) note(G, 'no youtube.com cookie appeared within 30 s (README may now overstate; not a failure)');
    // give the muted pre-roll ads time to load and report (their ad servers set the advertising cookies)
    const decks = await waitFor(b, async () => {
      const s = await peek(b, 'JSON.stringify((window.__segue && window.__segue.decks || []).map((d) => d && d.state))');
      return /"(ad|cued|ready|playing|paused)"/.test(s || '');
    }, 45000);
    note(G, `deck states: ${await peek(b, 'JSON.stringify((window.__segue && window.__segue.decks || []).map((d) => d && d.state))')}${decks ? '' : ' (no deck reached its ad within 45 s)'}`);
    await sleep(20000);
    check(G, 'still no user activation (nothing was tapped)', (await peek(b, 'navigator.userActivation.hasBeenActive')) === false);
    checkCookiesDocumented(G, await cookiesOf(b));
    // What YouTube and Google are handed. The share link's seed is unique to this run and its vibe unusual,
    // so they can only get into a request from the address bar.
    const players = JSON.parse((await peek(b, "JSON.stringify([...document.querySelectorAll('iframe')].map((f) => f.src).filter((u) => /youtube/.test(u)))")) || '[]');
    const toYt = b.outgoing.filter((r) => YT_GOOGLE.test(r.host));
    const fromPlayers = toYt.filter((r) => /^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//.test(r.referer) && !/\/embed\//.test(r.url));
    const embeds = toYt.filter((r) => /^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//.test(r.url));
    const leaks = (text) => {
      const d = decodedAll(text);
      const hit = [];
      if (d.includes(MARK)) hit.push('seed');
      if (/deezer:chart/i.test(d)) hit.push('playlist');
      if (/[?&#]vibe=/.test(d) || d.includes(`vibe=${VIBE}`)) hit.push('vibe');
      if (/[?&#]len=short/.test(d)) hit.push('len');
      if (/[?&#]seed=/.test(d)) hit.push('seed=');
      return hit;
    };
    const leaked = [];
    for (const r of toYt) {
      const inUrl = leaks(r.url);
      const inRef = leaks(r.referer);
      if (inUrl.length || inRef.length) leaked.push(`${r.url.replace(/\?.*/, '')} (${inUrl.length ? `URL: ${inUrl.join('+')}` : ''}${inUrl.length && inRef.length ? '; ' : ''}${inRef.length ? `Referer: ${inRef.join('+')}` : ''})`);
    }
    const srcLeaks = players.filter((u) => leaks(u).length);
    note(G, `${toYt.length} requests to YouTube / Google hosts (${fromPlayers.length} from inside the players, ${embeds.length} player loads, their Referer: ${[...new Set(embeds.map((r) => r.referer || '(none)'))].join(' / ') || '-'}); ${players.length} player iframes`);
    check(G, 'the players really ran (two player iframes, requests from inside them)', players.length >= 2 && embeds.length >= 2 && fromPlayers.length >= 5, `${players.length} iframes, ${embeds.length} player loads, ${fromPlayers.length} requests from inside the players`);
    check(G, "no request to a YouTube or Google host carries the page's query (playlist, seed, vibe, length) in its URL or Referer", toYt.length >= 10 && leaked.length === 0 && srcLeaks.length === 0, leaked.length || srcLeaks.length ? `${leaked.length} requests: ${leaked.slice(0, 4).join(', ')}${srcLeaks.length ? ` · ${srcLeaks.length} iframe src` : ''}` : `${toYt.length} checked`);
    check(G, "the player loads' Referer is the page's origin, nothing more", embeds.length > 0 && embeds.every((r) => r.referer === '' || r.referer === `${DEFAULT_ORIGIN}/`), [...new Set(embeds.map((r) => r.referer || '(none)'))].join(' / '));
    const says = blocks.some((b2) => /YouTube/.test(b2) && /origin and path/i.test(b2) && /never/i.test(b2) && /\bseed\b/.test(b2) && /playlist/i.test(b2));
    const saysFull = blocks.some((b2) => /full address/i.test(b2));
    check(G, "README says the players get only this page's origin and path, never the playlist link or the set's seed / vibe / length (and no longer that YouTube sees the full address)", says && !saysFull, `${says ? '' : 'statement missing'}${!says && saysFull ? '; ' : ''}${saysFull ? '"full address" still in README Privacy' : ''}`);
  } finally {
    await close(b);
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const guard = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      check(name, 'group ran to completion', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : String(err));
    });

if (wants('static')) await guard('static', groupStatic);
if (!existsSync(chrome)) {
  console.log(`privacy e2e: browser groups SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
} else {
  if (wants('home')) await guard('home', groupHome);
  if (wants('preview')) await guard('preview', groupPreview);
  if (wants('full')) await guard('full', groupFull);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nprivacy e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);

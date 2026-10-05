// UI end-to-end checks, driven through ui-demo.html (mock data, no audio, no app network).
//
//   node tests/e2e/ui.e2e.mjs            run every check, write screenshots to handoff/shots/
//   node tests/e2e/ui.e2e.mjs --assets   also re-render assets/og.png and the PNG icons
//   node tests/e2e/ui.e2e.mjs --only=handlers,helpers   just those sections (see SECTIONS)
//
// For each screen × viewport (1440×900, 1024×768, 390×844 touch): no console errors, no horizontal
// overflow, key elements present / visible / inside the viewport, a screenshot. Then: phone-browser
// and phone-on-its-side viewports (the whole booth must fit), every handler from click / tap /
// keyboard / file input / drop, keyboard shortcuts ignored while typing, failed loads reported at the
// field they came from, the locked / live track-length control, a cued deck parked in its lane,
// hostile / sparse / extreme data, view.frame() cost over 600 frames (mean + p95) incl. a 6-minute,
// 36 000-column track, the Content-Security-Policy (as written and as the browser enforces it), the
// page with the web-font host blocked or never answering, and the same screens again in Firefox when
// it is installed (skipped otherwise).
// Exit code 0 = pass.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = join(ROOT, 'handoff', 'shots');
const MAKE_ASSETS = process.argv.includes('--assets');
// --only=handlers,helpers runs just those sections while working on one of them (default: all of them)
const SECTIONS = ['screens', 'sizes', 'handlers', 'cued', 'live', 'robust', 'helpers', 'cost', 'index', 'csp', 'fonts', 'firefox'];
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const unknownSections = ONLY.filter((s) => !SECTIONS.includes(s));
if (unknownSections.length) {
  console.error(`unknown section: ${unknownSections.join(', ')} (have: ${SECTIONS.join(', ')})`);
  process.exit(2);
}
const want = (section) => !ONLY.length || ONLY.includes(section);

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '1024x768', width: 1024, height: 768, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
];

// Elements that must be visible on each screen. `desktop` / `wide` / `narrow` only apply to matching viewports.
const MUST_SEE = {
  landing: {
    all: ['.landing .wordmark', '.l-title', '.l-sub', '#segue-input', '[data-ref="submit"]', '.l-demos .chip', '.l-wave canvas'],
    below: ['.l-drop label.btn', '[data-ref="text-toggle"]', '.l-example', '.l-foot'],
  },
  loading: { all: ['.crate-anim', '.ld-title', '.ld-detail', '.ld-bar', '[data-ref="ld-cancel"]'] },
  ready: { all: ['.rd-sleeve', '.rd-title', '.rd-meta', '[data-ref="rd-start"]', '.ready .wordmark'] },
  stage: {
    all: [
      '.topbar .wordmark', '[data-ref="seed"]', '[data-ref="share"]', '[data-ref="elapsed"]', '[data-ref="rec"]',
      '.waves canvas', '.wave-tag-a', '.wave-tag-b',
      '.deck-a .platter', '.deck-a .deck-title', '.deck-a [data-part="bpm"]', '.deck-a .keychip',
      '.deck-b .platter', '.deck-b .deck-title', '.deck-b [data-part="bpm"]', '.deck-b .keychip',
      '.ticker .tk-tag', '.ticker .tk-label',
      '.ch-a .fader-cap', '.ch-b .fader-cap', '.ch-a [data-knob="low"]', '.ch-b [data-knob="filter"]', '.meter', '.xf-cap',
      '[data-ref="play"]', '[data-ref="skip"]', '[data-ref="newset"]', '#segue-vibe',
    ],
    wide: ['.crate .sl', '.deck-a .deck-link', '.deck-a .deck-provider', '#segue-volume', '.pl-title'],
    narrow: ['[data-ref="crate-toggle"]'],
    // Track length is locked in the mock set (30-second previews): where the transport has room the
    // four options are shown greyed under their label; on compact layouts a chip stands in for them.
    roomy: ['.tp-mode .seg', '.tp-mode-lbl'],
    compact: ['[data-ref="mode-note"]'],
  },
};
const COMPACT_MAX = 1023;
/** Selectors that must be visible on `screen` at this viewport. */
function mustSee(screen, vp) {
  const spec = MUST_SEE[screen];
  return [...spec.all, ...((vp.width >= 1180 ? spec.wide : spec.narrow) || []), ...((vp.width <= COMPACT_MAX ? spec.compact : spec.roomy) || [])];
}

const failures = [];
const notes = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

/** Console noise that is not ours: font CDN unreachable (offline run), favicon. */
const ignorable = (text) => /fonts\.(googleapis|gstatic)\.com|favicon|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(text);

async function open(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await window.__segueDemo.ready;
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
    // two frames so ResizeObservers have sized every canvas
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** The policy string of a page's CSP <meta>, and the same parsed into { directive: [sources] }. */
const cspOf = (html) => (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/) || [])[1] || '';
function parseCsp(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

/** Visibility report for a list of selectors, evaluated in the page. */
function inspect(page, selectors, requireInViewport) {
  return page.evaluate(
    (sels, inView) =>
      sels.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, problem: 'missing' };
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 1 || r.height < 1) return { sel, problem: `zero size ${r.width}x${r.height}` };
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return { sel, problem: 'hidden' };
        if (r.left < -1 || r.right > innerWidth + 1) return { sel, problem: `outside viewport horizontally (${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth})` };
        if (inView && (r.bottom < 0 || r.top > innerHeight)) return { sel, problem: `outside viewport vertically (${Math.round(r.top)}..${Math.round(r.bottom)} of ${innerHeight})` };
        return { sel, problem: '' };
      }),
    selectors,
    requireInViewport,
  );
}

const overflow = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    const wide = [];
    const limit = de.clientWidth;
    if (de.scrollWidth > limit) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > limit + 1 || el.scrollWidth > Math.max(limit, r.width) + 1) && getComputedStyle(el).position !== 'fixed') wide.push(`${el.tagName}.${el.className}`.slice(0, 60));
        if (wide.length > 5) break;
      }
    }
    return { scrollWidth: de.scrollWidth, innerWidth, wide };
  });

const calls = (page) => page.evaluate(() => window.__segueDemo.calls.map((c) => c.slice()));
const clearCalls = (page) => page.evaluate(() => void (window.__segueDemo.calls.length = 0));
const names = (list) => list.map((c) => c[0]);

async function press(page, vp, selector) {
  if (vp.mobile) await page.tap(selector);
  else await page.click(selector);
}

// ── screens × viewports ───────────────────────────────────────────────────────────────────────
async function screenChecks(srv, vp) {
  console.log(`\n== ${vp.name}${vp.mobile ? ' (mobile, touch)' : ''} ==`);
  const { page, errors, close } = await launch(vp);
  const base = `${srv.url}/ui-demo.html`;
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}-${vp.name}.png`) });
  const wide = vp.width >= 1180;

  try {
    for (const screen of ['landing', 'loading', 'ready', 'stage']) {
      errors.length = 0;
      await open(page, `${base}?screen=${screen}&freeze=1`);
      if (screen === 'stage') {
        // park in the middle of a beat-matched transition so every control is doing something
        await page.evaluate(() => {
          const d = window.__segueDemo;
          const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
          d.seek(tr.tStart + (tr.tEnd - tr.tStart) * 0.55 - 1);
          for (let i = 0; i < 60; i++) d.step(1 / 60);
        });
      }
      await settle(screen === 'landing' ? 900 : 350);

      const real = errors.filter((e) => !ignorable(e));
      check(real.length === 0, `${screen}: no console errors${real.length ? ` — ${real.join(' | ')}` : ''}`);

      // compare against the emulated device width: a phone silently widens its layout viewport to fit
      // overflowing content, so scrollWidth ≤ innerWidth alone would not catch it
      const of = await overflow(page);
      check(of.scrollWidth <= vp.width && of.innerWidth === vp.width, `${screen}: no horizontal overflow (scrollWidth ${of.scrollWidth}, innerWidth ${of.innerWidth}, device ${vp.width})${of.wide.length ? ` — ${of.wide.join(', ')}` : ''}`);

      const spec = MUST_SEE[screen];
      const sels = mustSee(screen, vp);
      const seen = await inspect(page, sels, true);
      const bad = seen.filter((s) => s.problem);
      check(bad.length === 0, `${screen}: ${sels.length} key elements visible${bad.length ? ` — ${bad.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}`);
      if (spec.below) {
        const more = (await inspect(page, spec.below, false)).filter((s) => s.problem);
        check(more.length === 0, `${screen}: ${spec.below.length} below-the-fold elements present${more.length ? ` — ${more.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}`);
      }

      if (screen === 'stage') {
        const painted = await page.evaluate(() => {
          const c = document.querySelector('.waves canvas');
          const g = c.getContext('2d');
          const lane = (y0, y1) => {
            const d = g.getImageData(0, y0, c.width, Math.max(1, y1 - y0)).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
            return n / (d.length / 4);
          };
          return { w: c.width, h: c.height, top: lane(0, Math.floor(c.height * 0.4)), bottom: lane(Math.ceil(c.height * 0.6), c.height), dpr: devicePixelRatio, css: c.getBoundingClientRect().width };
        });
        check(painted.top > 0.08 && painted.bottom > 0.08, `stage: both waveform lanes painted (A ${(painted.top * 100).toFixed(0)}%, B ${(painted.bottom * 100).toFixed(0)}% of pixels)`);
        check(Math.abs(painted.w - Math.min(3, painted.dpr) * painted.css) <= 2, `stage: waveform canvas sized for devicePixelRatio (${painted.w}px for ${painted.css}px × ${painted.dpr})`);
        const lock = await page.evaluate(() => document.querySelector('[data-ref="lock"]').classList.contains('is-on'));
        check(lock, 'stage: "Beat lock" lamp is lit during a beat-matched transition');
        const tk = await page.evaluate(() => ({ state: document.querySelector('.ticker').dataset.state, marks: document.querySelectorAll('.tk-mark').length, live: document.querySelector('[data-ref="tk-live"]').textContent }));
        check(tk.state === 'active' && tk.marks >= 2 && /^Mixing:/.test(tk.live), `stage: ticker shows the active transition (${tk.state}, ${tk.marks} marks, live region "${tk.live}")`);
      }
      await shot(screen);
      if (screen === 'landing') {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await settle(150);
        await shot('landing-bottom');
      }
    }

    // extra stage states, mostly for the screenshots
    errors.length = 0;
    await open(page, `${base}?screen=stage&freeze=1`);
    await page.evaluate(() => {
      const d = window.__segueDemo;
      const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
      d.seek(tr.tStart - 4.5);
      for (let i = 0; i < 60; i++) d.step(1 / 60);
    });
    await settle();
    const up = await page.evaluate(() => ({ state: document.querySelector('.ticker').dataset.state, count: document.querySelector('[data-ref="tk-count"]').textContent }));
    check(up.state === 'upcoming' && /^\d+:\d\d$/.test(up.count), `stage: upcoming transition shows a countdown ("${up.count}")`);
    await shot('stage-upcoming');

    await open(page, `${base}?screen=stage&freeze=1&toasts=1&rec=1`);
    await page.evaluate(() => {
      const d = window.__segueDemo;
      d.seek(4);
      for (let i = 0; i < 30; i++) d.step(1 / 60);
    });
    await settle();
    const toasts = await page.evaluate(() => ({ n: document.querySelectorAll('.toast').length, alert: !!document.querySelector('.toast[role="alert"]'), rec: document.querySelector('[data-ref="rec"]').getAttribute('aria-pressed') }));
    check(toasts.n === 3 && toasts.alert && toasts.rec === 'true', `stage: toasts (${toasts.n}, error has role=alert) and recording indicator`);
    await shot('stage-solo-toasts-rec');

    await open(page, `${base}?screen=stage&freeze=1&empty=1`);
    await page.evaluate(() => window.__segueDemo.step(1 / 60));
    await settle();
    const ofEmpty = await overflow(page);
    check(ofEmpty.scrollWidth <= vp.width && ofEmpty.innerWidth === vp.width, 'stage (nothing loaded yet): no horizontal overflow');
    await shot('stage-empty');

    if (!wide) {
      await open(page, `${base}?screen=stage&freeze=1`);
      await page.evaluate(() => {
        const d = window.__segueDemo;
        d.seek(30);
        for (let i = 0; i < 30; i++) d.step(1 / 60);
      });
      await press(page, vp, '[data-ref="crate-toggle"]');
      await settle(450);
      const drawer = await page.evaluate(() => {
        const c = document.querySelector('.crate');
        const r = c.getBoundingClientRect();
        return { open: c.classList.contains('is-open'), inert: c.hasAttribute('inert'), inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, rows: c.querySelectorAll('.sl').length, expanded: document.querySelector('[data-ref="crate-toggle"]').getAttribute('aria-expanded') };
      });
      check(drawer.open && !drawer.inert && drawer.inView && drawer.rows > 5 && drawer.expanded === 'true', `stage: setlist drawer opens (${drawer.rows} rows, inside the viewport)`);
      await shot('stage-setlist');
      await page.keyboard.press('Escape');
      await settle(400);
      const closed = await page.evaluate(() => ({ open: document.querySelector('.crate').classList.contains('is-open'), inert: document.querySelector('.crate').hasAttribute('inert') }));
      check(!closed.open && closed.inert, 'stage: Escape closes the setlist drawer and makes it inert');
    }
    const real = errors.filter((e) => !ignorable(e));
    check(real.length === 0, `extra stage states: no console errors${real.length ? ` — ${real.join(' | ')}` : ''}`);
  } finally {
    await close();
  }
}

// ── other sizes: stage + landing must hold together from 360 px wide to ultrawide ─────────────
async function extraSizes(srv) {
  console.log('\n== other sizes ==');
  for (const vp of [
    { name: '360x640', width: 360, height: 640, mobile: true },
    // a phone browser with its toolbars showing leaves ~660 px: the whole booth must still fit
    { name: '390x664', width: 390, height: 664, mobile: true, fits: true },
    // phones on their side: one-row transport; from 700 px wide the mixer sits beside the waveforms
    { name: '667x375', width: 667, height: 375, mobile: true },
    { name: '844x390', width: 844, height: 390, mobile: true, fits: true },
    { name: '768x1024', width: 768, height: 1024, mobile: true },
    { name: '1280x720', width: 1280, height: 720, mobile: false },
    { name: '2560x1080', width: 2560, height: 1080, mobile: false },
  ]) {
    const { page, errors, close } = await launch(vp);
    try {
      for (const screen of ['landing', 'stage']) {
        await open(page, `${srv.url}/ui-demo.html?screen=${screen}&freeze=1`);
        if (screen === 'stage') {
          await page.evaluate(() => {
            const d = window.__segueDemo;
            const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
            d.seek(tr.tStart + (tr.tEnd - tr.tStart) * 0.55 - 1);
            for (let i = 0; i < 60; i++) d.step(1 / 60);
          });
        }
        await settle(screen === 'landing' ? 700 : 300);
        const of = await overflow(page);
        const sels = screen === 'stage'
          ? ['.waves canvas', '.deck-a .deck-title', '.deck-b [data-part="bpm"]', '.ch-a [data-knob="low"]', '.xf-cap', '[data-ref="play"]', '[data-ref="newset"]', '#segue-vibe', vp.width <= COMPACT_MAX ? '[data-ref="mode-note"]' : '.tp-mode .seg', '[data-ref="rec"]', '[data-ref="share"]']
          : ['.l-title', '#segue-input', '[data-ref="submit"]'];
        const bad = (await inspect(page, sels, screen === 'stage' && vp.height >= 720)).filter((x) => x.problem);
        const real = errors.filter((e) => !ignorable(e));
        check(
          of.scrollWidth <= vp.width && of.innerWidth === vp.width && bad.length === 0 && real.length === 0,
          `${screen} @ ${vp.name}: no overflow, controls visible, no errors${bad.length ? ` — ${bad.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}${of.wide.length ? ` — wide: ${of.wide.join(', ')}` : ''}${real.length ? ` — ${real.join(' | ')}` : ''}`,
        );
        if (screen === 'stage' && vp.fits) {
          // nothing below the fold: every part of the booth sits between the top bar and the transport
          const fit = await page.evaluate(() => {
            const booth = document.querySelector('.booth');
            const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
            const bottom = document.querySelector('.transport').getBoundingClientRect().top;
            const out = [];
            for (const sel of ['.deck-a .deck-title', '.waves canvas', '.wave-tag-b', '.deck-b .deck-title', '.ticker .tk-label', '.ch-a [data-knob="low"] .knob-lbl', '.ch-b .ch-id', '.xf-cap']) {
              const r = document.querySelector(sel).getBoundingClientRect();
              if (r.height < 1 || r.top < top - 1 || r.bottom > bottom + 1) out.push(`${sel} (${Math.round(r.top)}..${Math.round(r.bottom)} vs ${Math.round(top)}..${Math.round(bottom)})`);
            }
            return { out, scroll: booth.scrollHeight - booth.clientHeight, transport: Math.round(innerHeight - bottom) };
          });
          check(fit.out.length === 0 && fit.scroll <= 1, `stage @ ${vp.name}: the whole booth fits without scrolling (transport ${fit.transport}px tall)${fit.out.length ? ` — cut off: ${fit.out.join('; ')}` : ''}${fit.scroll > 1 ? ` — booth scrolls by ${fit.scroll}px` : ''}`);
        }
        await page.screenshot({ path: join(SHOTS, `${screen}-${vp.name}.png`) });
      }
      if (vp.width > vp.height && vp.height <= 520) {
        // a phone on its side: loading keeps Cancel on screen, the setlist is a side drawer, not a sheet
        await open(page, `${srv.url}/ui-demo.html?screen=loading&freeze=1`);
        const cancel = (await inspect(page, ['.crate-anim', '.ld-title', '[data-ref="ld-cancel"]'], true)).filter((x) => x.problem);
        check(cancel.length === 0, `loading @ ${vp.name}: crate, status and Cancel are all on screen${cancel.length ? ` — ${cancel.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}`);
        await page.screenshot({ path: join(SHOTS, `loading-${vp.name}.png`) });
        await open(page, `${srv.url}/ui-demo.html?screen=stage&freeze=1&t=30`);
        await page.tap('[data-ref="crate-toggle"]');
        await settle(450);
        const drawer = await page.evaluate(() => {
          const r = document.querySelector('.crate').getBoundingClientRect();
          return { open: document.querySelector('.crate').classList.contains('is-open'), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight, rows: document.querySelectorAll('.crate .sl').length };
        });
        check(drawer.open && drawer.rows > 5 && drawer.top <= 1 && drawer.bottom >= drawer.h - 1 && drawer.right <= drawer.w + 1 && drawer.left > drawer.w * 0.2, `stage @ ${vp.name}: setlist opens as a full-height side drawer (${drawer.left}..${drawer.right} of ${drawer.w})`);
        await page.screenshot({ path: join(SHOTS, `stage-setlist-${vp.name}.png`) });
      }
    } finally {
      await close();
    }
  }
}

// ── handlers ──────────────────────────────────────────────────────────────────────────────────
async function handlerChecks(srv, vp, tmp) {
  console.log(`\n== handlers @ ${vp.name}${vp.mobile ? ' (touch)' : ''} ==`);
  const { page, errors, close } = await launch(vp);
  const base = `${srv.url}/ui-demo.html`;
  const wide = vp.width >= 1180;
  try {
    // landing: the one input
    await open(page, `${base}?screen=landing&freeze=1`);
    await press(page, vp, '[data-ref="submit"]');
    let got = await calls(page);
    const hint = await page.evaluate(() => document.querySelector('[data-ref="hint"]').textContent);
    check(got.length === 0 && hint.length > 0, `landing: empty submit calls nothing and explains ("${hint}")`);

    await page.type('#segue-input', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    // typing shortcut keys into the input must not trigger the stage shortcuts
    await page.type('#segue-input', ' n');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    got = await calls(page);
    check(got.length === 0, 'landing: typing in the input fires no handlers');
    await page.keyboard.press('Enter');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onSubmit' && got[0][1] === 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', `landing: Enter submits → onSubmit(${JSON.stringify(got[0] && got[0][1])})`);

    await open(page, `${base}?screen=landing&freeze=1`);
    await press(page, vp, '.l-demos .chip:nth-child(2)');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onDemo' && got[0][1] === 'dance', `landing: crate chip → onDemo(${JSON.stringify(got[0] && got[0][1])})`);

    await open(page, `${base}?screen=landing&freeze=1`);
    await page.evaluate(() => document.querySelector('.l-example').scrollIntoView({ block: 'center' }));
    await press(page, vp, '.l-examples-list li:nth-child(2) .l-example');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onSubmit' && /^https:\/\/open\.spotify\.com\/playlist\//.test(got[0][1]), `landing: example playlist → onSubmit(${JSON.stringify(got[0] && got[0][1])})`);

    await open(page, `${base}?screen=landing&freeze=1`);
    await page.evaluate(() => document.querySelector('[data-ref="text-toggle"]').scrollIntoView({ block: 'center' }));
    await press(page, vp, '[data-ref="text-toggle"]');
    await page.type('#segue-text', 'Mirelle Ito - Glasshouse\nDov Kessler - Night Bus to Peckham');
    await page.screenshot({ path: join(SHOTS, `landing-tracklist-${vp.name}.png`) });
    await page.evaluate(() => document.querySelector('[data-ref="text-go"]').scrollIntoView({ block: 'center' }));
    await press(page, vp, '[data-ref="text-go"]');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onSubmit' && got[0][1].split('\n').length === 2, 'landing: pasted track list → onSubmit(multi-line text)');

    // multi-line paste into the single-line input is routed to the list box instead of being flattened
    await open(page, `${base}?screen=landing&freeze=1`);
    const routed = await page.evaluate(() => {
      const input = document.querySelector('#segue-input');
      const dt = new DataTransfer();
      dt.setData('text', 'A - One\nB - Two\nC - Three');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return { panel: !document.querySelector('[data-ref="text-panel"]').hidden, value: document.querySelector('#segue-text').value };
    });
    check(routed.panel && routed.value.split('\n').length === 3, 'landing: a multi-line paste lands in the track-list box');

    // local files: picker
    const mp3 = join(tmp, 'Glasshouse.mp3');
    const flac = join(tmp, 'Night Bus.flac');
    const txt = join(tmp, 'notes.txt');
    const input = await page.$('#segue-files');
    await input.uploadFile(mp3, flac, txt);
    await settle(100);
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onFiles' && got[0][1].join(',') === 'Glasshouse.mp3,Night Bus.flac', `landing: file input → onFiles(${JSON.stringify(got[0] && got[0][1])}) (non-audio filtered out)`);

    await open(page, `${base}?screen=landing&freeze=1`);
    await (await page.$('#segue-files')).uploadFile(txt);
    await settle(100);
    got = await calls(page);
    const alert = await page.evaluate(() => document.querySelector('.toast[role="alert"]')?.textContent || '');
    check(got.length === 0 && alert.length > 0, `landing: only non-audio files → no handler, error toast ("${alert}")`);

    // local files: drag and drop anywhere on the landing screen
    await open(page, `${base}?screen=landing&freeze=1`);
    const drop = await page.evaluate(() => {
      const target = document.querySelector('.l-title');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(64)], 'dropped set.m4a', { type: 'audio/mp4' }));
      dt.items.add(new File([new Uint8Array(64)], 'untyped.wav', { type: '' }));
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      const veilShown = !document.querySelector('[data-ref="dropveil"]').hidden;
      const overPrevented = !fire('dragover');
      const dropPrevented = !fire('drop');
      return { veilShown, overPrevented, dropPrevented, veilHidden: document.querySelector('[data-ref="dropveil"]').hidden };
    });
    got = await calls(page);
    check(drop.veilShown && drop.overPrevented && drop.dropPrevented && drop.veilHidden, 'landing: dragging files shows the drop veil, drop is handled');
    check(got.length === 1 && got[0][0] === 'onFiles' && got[0][1].join(',') === 'dropped set.m4a,untyped.wav', `landing: drop anywhere → onFiles(${JSON.stringify(got[0] && got[0][1])})`);

    // a failed load (&fail=1: every load fails the way js/main.js reports one) is explained where it was started
    const failed = (hintRef) => page.waitForFunction((ref) => document.querySelector('#app').dataset.screen === 'landing' && document.querySelector(`[data-ref="${ref}"]`).textContent.length > 0, { timeout: 4000 }, hintRef).then(() => true, () => false);
    const errorState = () =>
      page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const input = q('#segue-input');
        const hintEl = q('[data-ref="hint"]');
        const textEl = q('#segue-text');
        const textHintEl = q('[data-ref="text-hint"]');
        const box = (el) => el.getBoundingClientRect();
        const active = document.activeElement;
        return {
          hint: hintEl.textContent, textHint: textHintEl.textContent,
          fieldInvalid: q('[data-ref="field"]').classList.contains('is-invalid'), ariaInvalid: input.getAttribute('aria-invalid'),
          textInvalid: textEl.classList.contains('is-invalid'), textAria: textEl.getAttribute('aria-invalid'),
          focus: active === input ? 'input' : active === textEl ? 'text' : active && active.dataset.demo ? `chip:${active.dataset.demo}` : active ? active.tagName : '',
          selectedAll: input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length, value: input.value,
          described: input.getAttribute('aria-describedby') === hintEl.id && textEl.getAttribute('aria-describedby') === textHintEl.id,
          hintBelowField: Math.round(box(hintEl).top - box(q('[data-ref="field"]')).bottom), hintInView: box(hintEl).top >= 0 && box(hintEl).bottom <= innerHeight,
          textHintBelowBox: Math.round(box(textHintEl).top - box(textEl).bottom), textHintInView: box(textHintEl).height > 0 && box(textHintEl).top >= 0 && box(textHintEl).bottom <= innerHeight,
          alerts: document.querySelectorAll('.toast[role="alert"]').length,
        };
      });
    await open(page, `${base}?screen=landing&freeze=1&fail=1`);
    await page.type('#segue-input', 'https://spotify.link/AbCdEfGh');
    await page.keyboard.press('Enter');
    let shown = await failed('hint');
    let es = await errorState();
    check(shown && /spotify\.link/.test(es.hint) && es.hintInView && es.hintBelowField >= 0 && es.hintBelowField < 24 && es.alerts === 0, `landing: a failed link is explained right under the field, not in a corner toast ("${es.hint.slice(0, 44)}…", ${es.hintBelowField}px below the field)`);
    check(es.fieldInvalid && es.ariaInvalid === 'true' && es.described && es.focus === 'input' && es.selectedAll && es.value === 'https://spotify.link/AbCdEfGh', `landing: the field is marked invalid and handed back — focused, its text kept and selected (focus on ${es.focus || 'nothing'})`);
    if (!vp.mobile) {
      // a toast was gone after 7 s; this has to still be there when the user looks back at the field
      await settle(7400);
      const late = await errorState();
      check(late.hint === es.hint && late.fieldInvalid, 'landing: the message does not time out (still there after 7.4 s)');
    }
    await page.keyboard.type('h');
    es = await errorState();
    check(es.hint === '' && !es.fieldInvalid && es.ariaInvalid === null && es.value === 'h', 'landing: the next edit clears the message (and typing replaced the selected link)');

    // …a pasted list: under the list box, caret back in it
    await open(page, `${base}?screen=landing&freeze=1&fail=1`);
    await page.evaluate(() => document.querySelector('[data-ref="text-toggle"]').scrollIntoView({ block: 'center' }));
    await press(page, vp, '[data-ref="text-toggle"]');
    await page.type('#segue-text', 'Mirelle Ito - Glasshouse\nDov Kessler - Night Bus to Peckham');
    await page.evaluate(() => document.querySelector('[data-ref="text-go"]').scrollIntoView({ block: 'center' }));
    await press(page, vp, '[data-ref="text-go"]');
    shown = await failed('text-hint');
    await settle(120);
    es = await errorState();
    check(shown && es.textHint.length > 20 && es.textInvalid && es.textAria === 'true' && es.focus === 'text' && es.textHintInView && es.textHintBelowBox >= 0 && es.textHintBelowBox < 24 && es.hint === '' && !es.fieldInvalid && es.alerts === 0, `landing: a failed track list is explained under the list box, which gets the focus back (focus on ${es.focus || 'nothing'}, message ${es.textHintBelowBox}px below the box, on screen: ${es.textHintInView})`);
    await page.keyboard.type('x');
    es = await errorState();
    check(es.textHint === '' && !es.textInvalid && es.textAria === null, 'landing: editing the list clears its message');

    // …a crate chip: nothing to correct, so the field is not blamed and the chip gets the focus back
    await open(page, `${base}?screen=landing&freeze=1&fail=1`);
    await press(page, vp, '.l-demos .chip:nth-child(2)');
    shown = await failed('hint');
    es = await errorState();
    check(shown && es.hint.length > 20 && !es.fieldInvalid && es.ariaInvalid === null && es.focus === 'chip:dance' && es.hintInView && es.alerts === 0, `landing: a crate that fails to load says so above the chips without marking the link field (focus on ${es.focus || 'nothing'})`);
    await press(page, vp, '.l-demos .chip:nth-child(3)');
    const cleared = await page.evaluate(() => document.querySelector('[data-ref="hint"]').textContent);
    check(cleared === '', 'landing: the next attempt clears the message');
    await failed('hint');

    const inert = await page.evaluate(() => {
      const markup = ['<im', 'g src=x on', 'error="window.__marked=1">'].join('');
      window.__segueDemo.view.inputError(markup);
      const hintEl = document.querySelector('[data-ref="hint"]');
      return { text: hintEl.textContent === markup, children: hintEl.childElementCount, imgs: document.querySelectorAll('img[src="x"]').length, marked: window.__marked === 1 };
    });
    check(inert.text && inert.children === 0 && inert.imgs === 0 && !inert.marked, 'landing: a failure message is written as text, whatever it contains');

    // …and when the landing screen is not showing, the same call still reaches the user (as a toast)
    await open(page, `${base}?screen=stage&freeze=1`);
    const offLanding = await page.evaluate(() => {
      window.__segueDemo.view.inputError('That playlist could not be loaded.');
      return { alert: (document.querySelector('.toast[role="alert"]') || {}).textContent || '', hint: document.querySelector('[data-ref="hint"]').textContent };
    });
    check(offLanding.alert === 'That playlist could not be loaded.' && offLanding.hint === '', 'stage: inputError() away from the landing screen falls back to an error toast');

    // loading / ready
    await open(page, `${base}?screen=loading&freeze=1`);
    await press(page, vp, '[data-ref="ld-cancel"]');
    got = await calls(page);
    check(names(got).join() === 'onHome', 'loading: Cancel → onHome');
    const bar = await page.evaluate(() => {
      const v = window.__segueDemo.view;
      v.setLoading({ title: 'Reading the playlist', detail: 'x', progress: null });
      const ind = document.querySelector('[data-ref="ld-bar"]').classList.contains('is-indeterminate');
      v.setLoading({ title: 'Digging', detail: 'y', progress: 0.5 });
      return { ind, now: document.querySelector('[data-ref="ld-bar"]').getAttribute('aria-valuenow'), title: document.querySelector('[data-ref="ld-title"]').textContent };
    });
    check(bar.ind && bar.now === '50' && bar.title === 'Digging', 'loading: setLoading drives title + determinate / indeterminate progress');

    await open(page, `${base}?screen=ready&freeze=1`);
    const focused = await page.evaluate(() => document.activeElement === document.querySelector('[data-ref="rd-start"]'));
    check(focused, 'ready: "Start the set" has focus, so Enter / Space starts it');
    if (!vp.mobile) {
      await page.keyboard.press('Enter');
      got = await calls(page);
      check(names(got).join() === 'onStart', 'ready: Enter → onStart');
      await open(page, `${base}?screen=ready&freeze=1`);
    }
    await press(page, vp, '[data-ref="rd-start"]');
    got = await calls(page);
    check(names(got).join() === 'onStart', 'ready: Start the set → onStart');

    // stage: transport
    const stage = `${base}?screen=stage&freeze=1`;
    const fresh = async (extra = '') => {
      await open(page, stage + extra);
      await page.evaluate(() => {
        const d = window.__segueDemo;
        d.seek(4);
        for (let i = 0; i < 10; i++) d.step(1 / 60);
      });
      await clearCalls(page);
    };
    await fresh();
    for (const [ref, name] of [['play', 'onPlayPause'], ['skip', 'onSkip'], ['newset', 'onNewSet'], ['share', 'onShare'], ['rec', 'onRecordToggle']]) {
      await clearCalls(page);
      await press(page, vp, `[data-ref="${ref}"]`);
      got = await calls(page);
      check(names(got).join() === name, `stage: ${ref} button → ${name}`);
    }
    await fresh();
    // the wordmark is the labelled way out of a set ("Change playlist"), a fingertip wide at every size —
    // on a narrow phone the wordmark's text is gone and the mark alone is 22 px
    for (const width of vp.mobile ? [vp.width, 360] : [vp.width]) {
      if (width !== vp.width) await page.setViewport({ width, height: vp.height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const home = await page.evaluate(() => {
        const b = document.querySelector('[data-ref="home"]');
        const r = b.getBoundingClientRect();
        const chevron = b.querySelector('.ic-back').getBoundingClientRect();
        const bar = document.querySelector('.topbar');
        const seed = document.querySelector('[data-ref="seed"]');
        return { w: r.width, h: r.height, left: r.left, name: b.getAttribute('aria-label'), title: b.title, chevron: chevron.width > 6 && chevron.height > 6, overflow: bar.scrollWidth - bar.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth, seed: seed.textContent, seedCut: seed.scrollWidth - seed.clientWidth };
      });
      check(home.w >= 44 && home.h >= 44 && home.left >= 0 && home.chevron && /^Change playlist/.test(home.name) && /Change playlist/.test(home.title) && home.overflow <= 0 && home.doc <= 0, `stage @ ${width} wide: "Change playlist" is a ${Math.round(home.w)}×${Math.round(home.h)} px target with a back chevron, named "${home.name}", top bar not overflowing`);
      // the chevron must not be paid for with the set's code (a six-character seed is shown whole)
      check(home.seedCut <= 0, `stage @ ${width} wide: the set code ${home.seed} is not cut short beside it${home.seedCut > 0 ? ` (${home.seedCut} px hidden)` : ''}`);
      if (width !== vp.width) await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 3 : 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    }
    await clearCalls(page);
    await press(page, vp, '[data-ref="home"]');
    got = await calls(page);
    check(names(got).join() === 'onHome', 'stage: wordmark → onHome');

    // keyboard shortcuts
    await fresh();
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('n');
    got = await calls(page);
    check(names(got).join() === 'onPlayPause,onSkip,onNewSet', `stage: Space / → / N → ${names(got).join()}`);

    await fresh();
    await page.focus('#segue-vibe');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('n');
    await page.keyboard.press('Space');
    got = await calls(page);
    check(names(got).join() === 'onVibe' && typeof got[0][1] === 'number' && got[0][1] > 0.5 && got[0][1] <= 1, `stage: arrow key on the vibe slider → onVibe(${got[0] && got[0][1]}) and no shortcut fires`);
    const vibeText = await page.evaluate(() => document.querySelector('#segue-vibe').getAttribute('aria-valuetext'));
    check(/Smooth|Club|Wild/.test(vibeText), `stage: vibe slider has a spoken value ("${vibeText}")`);

    // a click must not leave Space bound to the clicked button (mouse users expect play/pause)
    if (!vp.mobile) {
      await fresh();
      await page.click('[data-ref="share"]');
      await clearCalls(page);
      await page.keyboard.press('Space');
      got = await calls(page);
      check(names(got).join() === 'onPlayPause', 'stage: Space after clicking Share still means play/pause');
    }

    // track length: locked for previews, live with local files
    await fresh();
    const locked = await page.evaluate(() => ({ disabled: document.querySelector('[data-ref="mode"]').disabled, checked: document.querySelector('.seg input:checked')?.value }));
    check(locked.disabled && locked.checked === 'preview', 'stage: track-length control is disabled (showing "preview") unless modeEnabled');
    // …and a locked control must say why when it is tapped: a title tooltip never shows on a touch screen
    const compact = vp.width <= COMPACT_MAX;
    const lockedLook = await page.evaluate(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const note = document.querySelector('[data-ref="mode-note"]');
      const r = note.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // the tappable area is the chip plus the margin its ::after adds around it
      const hit = (x, y) => document.elementFromPoint(x, y) === note || note.contains(document.elementFromPoint(x, y));
      let top = cy;
      let bottom = cy;
      while (top > 0 && hit(cx, top - 1)) top--;
      while (bottom < innerHeight && hit(cx, bottom + 1)) bottom++;
      return { seg: vis('.tp-mode .seg'), note: vis('[data-ref="mode-note"]'), text: note.textContent.trim(), isButton: note.tagName === 'BUTTON' && !note.disabled, target: Math.round(bottom - top + 1), width: Math.round(r.width), group: document.querySelector('[data-ref="mode"] legend').textContent.trim() };
    });
    if (compact) {
      check(lockedLook.note && !lockedLook.seg && lockedLook.isButton && /30 s previews/.test(lockedLook.text) && lockedLook.target >= 44 && lockedLook.width >= 44, `stage: compact layout shows one labelled chip in place of the locked options ("${lockedLook.text}", tap target ${lockedLook.width}×${lockedLook.target}px)`);
      await press(page, vp, '[data-ref="mode-note"]');
    } else {
      check(lockedLook.seg && !lockedLook.note && lockedLook.group === 'Track length', 'stage: roomy layout keeps the greyed options under their "Track length" label');
      await press(page, vp, '.seg label:nth-child(4)');
    }
    await settle(60);
    got = await calls(page);
    const why = await page.evaluate(() => ({ toasts: [...document.querySelectorAll('.toast p')].map((n) => n.textContent), checked: document.querySelector('.seg input:checked')?.value }));
    check(got.length === 0 && why.checked === 'preview' && why.toasts.some((t) => /30 seconds/.test(t) && /your own files/.test(t)), `stage: tapping the locked track-length control explains it and changes nothing ("${why.toasts[0] || ''}")`);

    await fresh('&long=1');
    const liveLook = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      const lbl = box('.tp-mode-lbl');
      return {
        options: [...document.querySelectorAll('.seg label')].map((l) => ({ w: Math.round(l.getBoundingClientRect().width), h: Math.round(l.getBoundingClientRect().height) })),
        label: lbl.width > 0 && lbl.height > 0, noteHidden: box('[data-ref="mode-note"]').width === 0, enabled: !document.querySelector('[data-ref="mode"]').disabled,
        ownRow: box('[data-ref="mode"]').top >= box('.vibe-ctl').bottom - 1, sw: document.documentElement.scrollWidth,
      };
    });
    const small = liveLook.options.filter((o) => o.w < 44 || o.h < 44);
    if (compact) {
      check(liveLook.enabled && liveLook.noteHidden && small.length === 0 && liveLook.sw <= vp.width, `stage: with own files the options are live and finger-sized (${liveLook.options.map((o) => `${o.w}×${o.h}`).join(', ')})`);
      if (vp.height >= 790 && vp.width < 720) check(liveLook.label && liveLook.ownRow, 'stage: on a phone the live control has a row of its own, with its "Track length" label');
    } else {
      check(liveLook.enabled && liveLook.noteHidden && liveLook.label, 'stage: with own files the options are live, under their label');
    }
    await press(page, vp, '.seg label:nth-child(4)');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onMode' && got[0][1] === 'full', `stage: track length (enabled) → onMode(${JSON.stringify(got[0] && got[0][1])})`);
    const quiet = await page.evaluate(() => [...document.querySelectorAll('.toast p')].some((n) => /30 seconds/.test(n.textContent)));
    check(!quiet, 'stage: a live control does not show the "locked" explanation');

    if (wide || vp.width >= 1024) {
      await fresh();
      await page.focus('#segue-volume');
      await page.keyboard.press('ArrowLeft');
      got = await calls(page);
      check(got.length === 1 && got[0][0] === 'onVolume' && got[0][1] < 0.9, `stage: volume slider → onVolume(${got[0] && got[0][1]})`);
      await clearCalls(page);
      await page.click('[data-ref="mute"]');
      got = await calls(page);
      check(got.length === 1 && got[0][0] === 'onVolume' && got[0][1] === 0, 'stage: mute → onVolume(0)');
    }

    // setTransport must not fight a slider the user is holding, and untrusted strings stay text
    await fresh();
    const safe = await page.evaluate(() => {
      const v = window.__segueDemo.view;
      // markup and script-scheme strings are put together here, so no ready-made payload sits in the repository
      const evil = ['<im', 'g src=x on', 'error="window.__pwned=1">'].join('');
      const scriptUrl = `${['java', 'script'].join('')}:void 0`;
      const dataUrl = `${['da', 'ta'].join('')}:text/plain,hi`;
      v.setDeck(0, { playId: 99, title: evil, artist: evil, artwork: scriptUrl, link: scriptUrl, bpm: 120, camelot: '8A', keyName: evil, duration: 30, provider: 'deezer', wave: { cols: 10, perSec: 100, low: new Uint8Array(10), mid: new Uint8Array(10), high: new Uint8Array(10) }, beats: [0.1, 0.6], downbeat: 0, cues: { start: 0, end: 30, in: 0.1, drop: null } });
      v.setSetlist([{ key: 'x', title: evil, artist: evil, artwork: 'http://insecure.example/a.png', state: 'playing', link: dataUrl, via: evil }]);
      v.setPlaylist({ title: evil, subtitle: evil, artwork: scriptUrl, link: scriptUrl, count: 3, source: 'spotify' });
      v.setTransition({ type: 'cut', label: evil, why: evil, fromTitle: evil, toTitle: evil, state: 'upcoming', tStart: 10, tEnd: 11, marks: [{ t: 10, label: evil }] });
      v.toast(evil, 'error');
      v.inputError(evil); // not on the landing screen: becomes a toast
      v.setLoading({ title: evil, detail: evil, progress: 0.3 });
      const app = document.querySelector('#app');
      return {
        injected: app.querySelectorAll('img[src="x"], [onerror]').length,
        pwned: !!window.__pwned,
        title: app.querySelector('.deck-a .deck-title').textContent === evil,
        badHref: [...app.querySelectorAll('a[href]')].filter((a) => !/^(https:|blob:)/.test(a.href)).length,
        badSrc: [...app.querySelectorAll('img[src]')].filter((i) => !/^(https:|blob:)/.test(i.src)).length,
        rel: [...app.querySelectorAll('a[href]')].every((a) => a.target === '_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel)),
      };
    });
    check(safe.injected === 0 && !safe.pwned && safe.title, 'safety: hostile strings render as text (no markup injected)');
    check(safe.badHref === 0 && safe.badSrc === 0 && safe.rel, 'safety: only https:/blob: URLs reach href/src; links are target=_blank rel="noopener noreferrer"');

    // the ticker's two other states: "waiting" (the crate ran dry) and a mid-solo trick riding along
    // on the announced transition; and the setlist header, which counts the crate, not the rows
    await fresh();
    const tk = await page.evaluate(() => {
      const d = window.__segueDemo;
      const v = d.view;
      const q = (ref) => document.querySelector(`[data-ref="${ref}"]`);
      const read = () => {
        const count = document.querySelector('.tk-count');
        const pill = q('tk-trick');
        const why = document.querySelector('.tk-why');
        return {
          state: document.querySelector('.ticker').dataset.state,
          tag: q('tk-tag').textContent,
          label: q('tk-label').textContent,
          to: q('tk-to').textContent,
          why: q('tk-why').textContent,
          count: q('tk-count').textContent + q('tk-count-lbl').textContent,
          countShown: getComputedStyle(count).display !== 'none',
          fill: q('tk-fill').style.clipPath,
          live: q('tk-live').textContent,
          trick: pill.hidden || getComputedStyle(pill).display === 'none' ? null : pill.textContent,
          trickLive: q('tk-trick-live').textContent,
          whyH: Math.round(why.getBoundingClientRect().height * 10) / 10,
          pillInside: pill.hidden || (pill.getBoundingClientRect().right <= why.getBoundingClientRect().right + 0.5 && pill.getBoundingClientRect().width > 20),
        };
      };
      const out = {};
      const next = { type: 'bassSwap', label: 'Bass swap · 16 beats', why: '126 → 124 BPM (−1.6%) · 8A → 9A', fromTitle: 'Slow Dissolve', toTitle: 'Halogen', state: 'upcoming', tStart: 30, tEnd: 38, marks: [{ t: 34, label: 'Swap the lows' }] };
      v.setTransition(next);
      v.frame(d.frameAt(4));
      out.plain = read();
      // a trick begins: same transition, plus `trick`
      v.setTransition({ ...next, trick: { label: 'Beat repeat', on: 'Slow Dissolve', tStart: 12, tEnd: 13 } });
      v.frame(d.frameAt(12.2));
      out.trick = read();
      v.setTransition({ ...next, trick: { label: 'Beat repeat', on: 'Slow Dissolve', tStart: 12, tEnd: 13 } });
      out.trickAgain = read();
      v.setTransition(next);
      v.frame(d.frameAt(14.2));
      out.after = read();
      // the crate ran dry
      const wait = { type: 'wait', label: 'Waiting for the next track', why: 'The set picks up as soon as it has loaded.', reason: 'loading', fromTitle: '', toTitle: '', state: 'waiting', tStart: 40, tEnd: 40, marks: [], synced: false };
      v.setTransition(wait);
      v.frame(d.frameAt(41));
      v.frame(d.frameAt(55));
      out.waiting = read();
      v.setTransition({ ...wait, reason: 'network', why: 'Can’t reach the music right now.' });
      v.frame(d.frameAt(56));
      out.offline = read();
      v.setTransition(next);
      v.frame(d.frameAt(57));
      out.back = read();

      // setlist header: the crate holds 5 tracks; one has come round again, one is not queued yet
      const row = (key, title, state, extra) => ({ key, title, artist: 'Someone', state, ...extra });
      const rows = [row('p0', 'One', 'played'), row('p1', 'Two', 'played'), row('p2', 'Three', 'played'), row('p3', 'One', 'playing', { again: true }), row('p4', 'Four', 'next')];
      v.setSetlist(rows, { crate: 5 });
      out.header = q('crate-count').textContent;
      v.setSetlist(rows);
      out.headerPlain = q('crate-count').textContent;
      v.setSetlist(rows, { crate: NaN });
      out.headerBad = q('crate-count').textContent;
      v.setSetlist([], { crate: 5 });
      out.headerEmpty = q('crate-count').textContent;
      return out;
    });
    check(tk.plain.state === 'upcoming' && tk.plain.trick === null && /^Next: Bass swap/.test(tk.plain.live), `ticker: an announced transition, no trick (${tk.plain.tag} · ${tk.plain.label})`);
    check(tk.trick.state === 'upcoming' && tk.trick.trick === 'Beat repeat' && tk.trick.trickLive === 'Beat repeat on Slow Dissolve.' && tk.trick.live === tk.plain.live && tk.trick.label === tk.plain.label && tk.trick.why === tk.plain.why && tk.trick.countShown && tk.trick.pillInside,
      `ticker: a mid-solo trick shows as a pill ("${tk.trick.trick}") with its own announcement; "Next: …" is neither replaced nor said again`);
    check(tk.trick.whyH === tk.plain.whyH && tk.trickAgain.trickLive === tk.trick.trickLive, `ticker: the pill does not move the layout (reason line ${tk.plain.whyH} → ${tk.trick.whyH} px)`);
    check(tk.after.trick === null && tk.after.state === 'upcoming' && tk.after.live === tk.plain.live, 'ticker: the pill goes when the trick is over');
    check(tk.waiting.state === 'waiting' && tk.waiting.label === 'Waiting for the next track' && tk.waiting.to === '' && tk.waiting.why === 'The set picks up as soon as it has loaded.' && tk.waiting.count === '' && !tk.waiting.countShown && /inset\(0(px)? 100%/.test(tk.waiting.fill) && tk.waiting.live === 'Waiting for the next track. The set picks up as soon as it has loaded.',
      `ticker: a set that ran dry says so and why — no "Next … in 0:00" (tag "${tk.waiting.tag}", "${tk.waiting.label}", count shown ${tk.waiting.countShown}, bar ${tk.waiting.fill})`);
    check(tk.offline.state === 'waiting' && /reach the music/.test(tk.offline.why) && /reach the music/.test(tk.offline.live), 'ticker: the reason follows when it changes (still loading → connection gone)');
    check(tk.back.state === 'upcoming' && tk.back.countShown && /^0:\d\d$/.test(tk.back.count.replace(/In$/, '')), `ticker: picks up again with the next transition (${tk.back.count})`);
    check(tk.header === '3 played · 5 in the crate' && tk.headerPlain === '3 played · 5 in the crate' && tk.headerBad === '3 played · 5 in the crate' && tk.headerEmpty === '', `setlist header counts the crate, not the rows (“${tk.header}”; without the count “${tk.headerPlain}”)`);

    const real = errors.filter((e) => !ignorable(e));
    check(real.length === 0, `handlers: no console errors${real.length ? ` — ${real.join(' | ')}` : ''}`);
  } finally {
    await close();
  }
}

// ── live loops: nothing frozen, the page's own rAF loops run for a while ──────────────────────
async function liveChecks(srv) {
  console.log('\n== live loops ==');
  const { page, errors, close } = await launch(VIEWPORTS[0]);
  const base = `${srv.url}/ui-demo.html`;
  try {
    await open(page, `${base}?screen=landing`);
    await settle(1500);
    const attract = await page.evaluate(() => {
      const c = document.querySelector('.l-wave canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n / (d.length / 4);
    });
    check(attract > 0.2, `landing: the silent demo waveform is running (${(attract * 100).toFixed(0)}% of pixels painted)`);

    await open(page, `${base}?screen=stage`);
    await settle(2500);
    const live = await page.evaluate(() => ({
      elapsed: document.querySelector('[data-ref="elapsed"]').textContent,
      spin: document.querySelector('.deck-a .vinyl-spin').style.transform,
      bpm: document.querySelector('.deck-a [data-part="bpm"]').textContent,
      label: document.querySelector('[data-ref="play"]').getAttribute('aria-label'),
    }));
    check(live.elapsed !== '0:00' && /rotate\(/.test(live.spin) && /^\d+\.\d$/.test(live.bpm) && live.label === 'Pause', `stage: runs live (elapsed ${live.elapsed}, platter ${live.spin}, ${live.bpm} BPM, button says "${live.label}")`);
    await page.click('[data-ref="play"]');
    await settle(300);
    const paused = await page.evaluate(() => ({ label: document.querySelector('[data-ref="play"]').getAttribute('aria-label'), cls: document.querySelector('[data-ref="play"]').classList.contains('is-playing'), spin: document.querySelector('.deck-a .vinyl-spin').style.transform }));
    await settle(400);
    const still = await page.evaluate(() => document.querySelector('.deck-a .vinyl-spin').style.transform);
    check(paused.label === 'Play' && !paused.cls && paused.spin === still, 'stage: pausing flips the button to "Play" and the platter stops');

    // resizing while paused must not leave a blank waveform (a canvas resize clears its bitmap)
    await page.setViewport({ width: 1200, height: 800 });
    await settle(500);
    const afterResize = await page.evaluate(() => {
      const c = document.querySelector('.waves canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return { frac: n / (d.length / 4), w: c.width };
    });
    check(afterResize.w === 1200 && afterResize.frac > 0.1, `stage: waveform repaints after a resize (${afterResize.w}px wide, ${(afterResize.frac * 100).toFixed(0)}% painted)`);
    await page.setViewport({ width: 1440, height: 900 });

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await open(page, `${base}?screen=landing`);
    await settle(600);
    const calm = await page.evaluate(async () => {
      const c = document.querySelector('.l-wave canvas');
      const snap = () => c.toDataURL().length + ':' + c.toDataURL().slice(-64);
      const a = snap();
      await new Promise((r) => setTimeout(r, 500));
      return { same: a === snap(), anim: getComputedStyle(document.querySelector('.led') || document.body).animationDuration };
    });
    check(calm.same, 'reduced motion: the landing waveform is a still frame');
    await open(page, `${base}?screen=stage`);
    await settle(800);
    await page.emulateMediaFeatures([]);

    const real = errors.filter((e) => !ignorable(e));
    check(real.length === 0, `live loops: no console errors${real.length ? ` — ${real.join(' | ')}` : ''}`);
  } finally {
    await close();
  }
}

// ── frame cost ────────────────────────────────────────────────────────────────────────────────
async function frameCost(srv, vp) {
  console.log(`\n== frame() cost @ ${vp.name} ==`);
  const { page, close } = await launch(vp);
  const base = `${srv.url}/ui-demo.html`;
  const limit = vp.mobile ? 8 : 4;
  const measure = async (label, query, startT) => {
    await open(page, `${base}?screen=stage&freeze=1${query}`);
    await settle(200);
    const r = await page.evaluate((t0) => {
      const d = window.__segueDemo;
      d.seek(t0);
      const sync = [];
      for (let i = 0; i < 600; i++) sync.push(d.step(1 / 60));
      sync.sort((a, b) => a - b);
      const stat = (xs) => ({ mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: xs[Math.floor(xs.length * 0.5)], p95: xs[Math.floor(xs.length * 0.95)], max: xs[xs.length - 1] });
      // and a couple of seconds inside real animation frames, where the browser also composites
      const total0 = performance.now();
      for (let i = 0; i < 600; i++) d.step(1 / 60);
      const batchMean = (performance.now() - total0) / 600; // not limited by the 0.1 ms timer resolution
      return new Promise((done) => {
        const raf = [];
        const gaps = [];
        let prev = 0;
        const tick = (now) => {
          if (prev) gaps.push(now - prev);
          prev = now;
          raf.push(d.step(1 / 60));
          if (raf.length < 120) requestAnimationFrame(tick);
          else {
            raf.sort((a, b) => a - b);
            gaps.sort((a, b) => a - b);
            done({ sync: stat(sync), raf: stat(raf), gaps: stat(gaps), batchMean });
          }
        };
        requestAnimationFrame(tick);
      });
    }, startT);
    const f = (x) => x.toFixed(2);
    const line = `${label}: 600 frames mean ${f(r.sync.mean)} ms (batch-timed, incl. mock: ${f(r.batchMean)}) · p50 ${f(r.sync.p50)} · p95 ${f(r.sync.p95)} · max ${f(r.sync.max)}  |  in rAF (120): mean ${f(r.raf.mean)} · p95 ${f(r.raf.p95)} · max ${f(r.raf.max)} · frame interval p50 ${f(r.gaps.p50)} / p95 ${f(r.gaps.p95)} ms`;
    notes.push(`frame cost @ ${vp.name} — ${line}`);
    check(r.sync.p95 < limit && r.raf.p95 < limit, `${line}  (target p95 < ${limit} ms)`);
    // rasterization happens off the main thread; a healthy pipeline still delivers ~60 frames a second
    check(r.gaps.p50 < 25, `${label}: frames keep arriving at display rate (median interval ${f(r.gaps.p50)} ms)`);
  };
  try {
    // 10 s that contain a silent pre-roll, a beat-matched transition and the hand-over
    const t0 = await (async () => {
      await open(page, `${base}?screen=stage&freeze=1`);
      return page.evaluate(() => {
        const tr = window.__segueDemo.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
        return tr.tStart - 3;
      });
    })();
    await measure('30 s previews', '', t0);
    await measure('6-minute tracks (36 000 columns)', '&long=1', 1);
    const mem = await page.evaluate(() => {
      const d = window.__segueDemo;
      // run two minutes of set time through the long tracks, then make sure the tile cache stayed bounded
      for (let i = 0; i < 7200; i++) d.step(1 / 60);
      return d.view._debug().waves;
    });
    check(mem.tiles[0] <= 8 && mem.tiles[1] <= 8 && mem.pool <= 16, `6-minute tracks: 2 more minutes of set time ran clean (${mem.tiles[0]} + ${mem.tiles[1]} tiles live, ${mem.pool} pooled)`);

    // Worst case for the tile cache: sweep a whole 6-minute track past the playhead with no idle time at
    // all, so every one of its 36 tiles has to be rendered inside a frame.
    const sweep = await page.evaluate(async () => {
      const { makeTrack } = await import('./js/ui/mock.js');
      const d = window.__segueDemo;
      const an = makeTrack({ seed: 77, bpm: 128, duration: 360 });
      const deck = { playId: 500, title: 'Six Minute Sweep', artist: 'Test', bpm: 128, camelot: '8A', keyName: 'A minor', duration: 360, provider: 'local', wave: an.wave, beats: an.beats, downbeat: 0, cues: an.cues };
      d.view.setDeck(0, deck);
      d.view.setDeck(1, { ...deck, playId: 501 });
      const f = d.frameAt(0);
      const df = () => ({ pos: 0, rate: 1, bpmNow: 128, gain: 1, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 1 });
      f.decks[0] = df();
      f.decks[1] = df();
      const xs = [];
      for (let i = 0; i < 1440; i++) {
        f.t = i * 0.25;
        f.decks[0].pos = i * 0.25;
        f.decks[1].pos = 360 - i * 0.25;
        const t0 = performance.now();
        d.view.frame(f);
        xs.push(performance.now() - t0);
      }
      xs.sort((a, b) => a - b);
      return { stats: d.view._debug().waves, p95: xs[Math.floor(xs.length * 0.95)], max: xs[xs.length - 1], mean: xs.reduce((a, b) => a + b, 0) / xs.length };
    });
    const sweepLine = `6-minute sweep (all 36 tiles rendered in-frame): mean ${sweep.mean.toFixed(2)} ms · p95 ${sweep.p95.toFixed(2)} · max ${sweep.max.toFixed(2)} · tiles kept ${sweep.stats.tiles[0]} + ${sweep.stats.tiles[1]}, pooled ${sweep.stats.pool}`;
    notes.push(`frame cost @ ${vp.name} — ${sweepLine}`);
    check(sweep.stats.tiles[0] <= 8 && sweep.stats.tiles[1] <= 8 && sweep.stats.pool <= 16 && sweep.p95 < limit, `${sweepLine}  (cache ≤ 8 tiles per deck, p95 < ${limit} ms)`);
  } finally {
    await close();
  }
}

// ── hard data: nothing the conductor can throw at the view may break it ───────────────────────
async function robustChecks(srv) {
  console.log('\n== hostile / sparse / extreme data ==');
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], { name: '390x664', width: 390, height: 664, mobile: true }, { name: '844x390', width: 844, height: 390, mobile: true }]) {
    const { page, errors, close } = await launch(vp);
    try {
      await open(page, `${srv.url}/ui-demo.html?screen=stage&freeze=1&empty=1`);
      const r = await page.evaluate(async () => {
        const { makeTrack } = await import('./js/ui/mock.js');
        const v = window.__segueDemo.view;
        const long = 'Supercalifragilisticexpialidocious — The Extraordinarily Long Extended Club Remix (feat. Somebody With A Very Long Name & Another One) [2011 Remastered Deluxe Edition]';
        const cjk = '夜に駆ける（ライブバージョン）とても長い曲のタイトルがここに入りますとても長い曲のタイトル';
        const rtl = 'أغنية طويلة جدا مع عنوان عربي يمتد إلى ما لا نهاية له في هذه الواجهة';
        const nospace = 'A'.repeat(140);
        const an = makeTrack({ seed: 3, bpm: 174, duration: 30 });
        const an2 = makeTrack({ seed: 4, bpm: 70, duration: 12 });
        const full = { playId: 1, title: long, artist: long, bpm: 174.44, camelot: '12B', keyName: 'G♯ minor / A♭ minor', duration: 30, provider: 'itunes', link: 'https://music.apple.com/x', wave: an.wave, beats: an.beats, downbeat: an.downbeat, cues: an.cues };
        // no artwork, link, key or beats; NaN tempo; zero duration; unknown provider; no drop
        const sparse = { playId: 2, title: nospace, artist: cjk, bpm: NaN, camelot: undefined, keyName: undefined, duration: 0, provider: 'mystery', wave: an2.wave, beats: [], downbeat: 0, cues: { start: 0, end: 12, in: 0, drop: null } };
        const busy = { type: 'riserDrop', label: long, why: long, fromTitle: long, toTitle: rtl, state: 'active', tStart: 5, tEnd: 25, marks: Array.from({ length: 12 }, (_, i) => ({ t: 5 + i, label: `A very long mark label number ${i}` })) };
        const states = ['played', 'playing', 'mixing', 'next', 'queued', 'loading', 'failed'];
        const items = Array.from({ length: 400 }, (_, i) => ({ key: `k${i}`, title: i % 3 ? long : i % 2 ? cjk : rtl, artist: i % 2 ? long : nospace, bpm: i % 5 ? 120 + i / 7 : undefined, camelot: i % 4 ? '10A' : undefined, state: states[i % 7], via: i % 2 ? long : undefined, link: i % 3 ? `https://example.com/${i}` : undefined }));
        const df = (o) => ({ pos: 3, rate: 1, bpmNow: 120, gain: 0.5, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0.5, ...o });
        const frames = [
          { t: 10, playing: true, elapsed: 3725, decks: [df({ pos: 31, rate: 1.5, bpmNow: 261.66, gain: 2, low: 12, mid: -99, high: -Infinity, hpf: 0, lpf: 1e9, audible: 3 }), df({ pos: -5, rate: 0, bpmNow: NaN, gain: -1, low: NaN, hpf: NaN, lpf: NaN, audible: NaN })], crossfade: 7, beatPhase: -2, levels: { rms: 5, peak: 9, bands: new Uint8Array(0) } },
          { t: 11, playing: false, elapsed: -5, decks: [null, null], crossfade: NaN, beatPhase: NaN, levels: null },
          { t: 12, playing: true, elapsed: 3, decks: [df({ pos: 1e6, rate: 0.0001, bpmNow: 0 }), null], crossfade: 0, beatPhase: 0.5 },
          { t: 13, playing: true, elapsed: 3, decks: [df(), df()], crossfade: 0, beatPhase: 0.5, levels: { rms: 0.2, peak: 0.4, bands: new Uint8Array(1024).fill(200) } },
        ];
        const threw = [];
        const attempt = (name, fn) => {
          try {
            fn();
          } catch (e) {
            threw.push(`${name}: ${e && e.message}`);
          }
        };
        attempt('setPlaylist', () => v.setPlaylist({ title: long, subtitle: `${long} ${long}`, count: 100000, source: 'spotify', link: 'https://open.spotify.com/x' }));
        attempt('setDeck', () => (v.setDeck(0, full), v.setDeck(1, sparse)));
        attempt('setTransition', () => v.setTransition(busy));
        const t0 = performance.now();
        attempt('setSetlist ×400', () => v.setSetlist(items));
        const setlistMs = performance.now() - t0;
        attempt('setTransport', () => v.setTransport({ playing: true, canSkip: true, recording: true, seed: 'ZZZZZZZZZZZZ', vibe: 2, mode: 'weird', modeEnabled: true, volume: -1 }));
        attempt('toast', () => (v.toast(long + long, 'error'), v.toast(nospace, 'info'), v.toast(cjk, 'success')));
        for (const f of frames) attempt(`frame t=${f.t}`, () => v.frame(f));
        attempt('degenerate frames', () => (v.frame(null), v.frame({}), v.frame({ decks: [] })));
        attempt('odd startsIn', () => {
          for (const wait of [NaN, Infinity, -Infinity, -5, 0, 1e-9, 0.5, 3, 1e9, '3', null]) v.frame({ ...frames[3], decks: [df({ startsIn: wait }), df({ pos: -4, rate: 0, startsIn: wait })] });
        });
        attempt('inputError', () => (v.inputError(long + long), v.inputError(null), v.inputError('')));
        attempt('half-built decks', () => {
          v.setDeck(1, { playId: 3, title: 'x' });
          v.frame(frames[3]);
          v.setDeck(1, { playId: 4, title: 'y', wave: { cols: 5, perSec: 100, low: new Uint8Array(2), mid: new Uint8Array(5), high: new Uint8Array(5) }, beats: [1], cues: {} });
          v.frame(frames[3]);
          v.setDeck(1, null);
          v.frame(frames[3]);
        });
        attempt('empty arguments', () => {
          v.setTransition({});
          v.frame(frames[3]);
          v.setTransition({ state: 'upcoming', tStart: NaN, tEnd: NaN });
          v.frame(frames[3]);
          v.setSetlist(null);
          v.setSetlist([null, {}, { key: 1 }]);
          v.setPlaylist(null);
          v.setLoading(null);
          v.setDemos(null, null);
          v.setTransport(null);
          v.toast(null);
          v.setScreen('nope');
        });
        v.setSetlist(items);
        v.setDeck(1, sparse);
        v.setTransition(busy);
        v.frame(frames[0]);
        await new Promise((res) => setTimeout(res, 300));
        // anything that sticks out of the window and is not clipped by an ancestor is a layout break
        const clipped = (el) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX !== 'visible' && p.getBoundingClientRect().right <= innerWidth + 1) return true;
          }
          return false;
        };
        const out = [];
        for (const el of document.querySelectorAll('.topbar *, .transport *, .ticker > *, .deck *, .mixer *')) {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) && !clipped(el)) out.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]} (${Math.round(b.left)}..${Math.round(b.right)})`);
        }
        const inView = (sel) => {
          const b = document.querySelector(sel).getBoundingClientRect();
          return b.width > 0 && b.left >= -1 && b.right <= innerWidth + 1;
        };
        return {
          threw, out: out.slice(0, 6), setlistMs, sw: document.documentElement.scrollWidth,
          rec: inView('[data-ref="rec"]'), share: inView('[data-ref="share"]'), elapsed: inView('[data-ref="elapsed"]'), count: inView('[data-ref="tk-count"]'),
          bpmB: document.querySelector('.deck-b [data-part="bpm"]').textContent, rows: document.querySelectorAll('.sl').length,
          toastH: Math.max(...[...document.querySelectorAll('.toast')].map((n) => n.getBoundingClientRect().height)),
          text: document.querySelector('.deck-a .deck-title').textContent === long,
        };
      });
      const real = errors.filter((e) => !ignorable(e));
      check(r.threw.length === 0 && real.length === 0, `hard data @ ${vp.name}: no exceptions, no console errors${r.threw.length ? ` — ${r.threw.join(' | ')}` : ''}${real.length ? ` — ${real.join(' | ')}` : ''}`);
      check(r.sw <= vp.width && r.out.length === 0 && r.rec && r.share && r.elapsed && r.count, `hard data @ ${vp.name}: very long titles / seed / clock stay inside the window (Rec, Share, clock, countdown all visible)${r.out.length ? ` — sticking out: ${r.out.join(', ')}` : ''}`);
      check(r.bpmB === '–' && r.rows === 400 && r.text && r.toastH < 140 && r.setlistMs < 250, `hard data @ ${vp.name}: NaN tempo shows a dash, 400-row setlist in ${r.setlistMs.toFixed(0)} ms, toasts capped at ${Math.round(r.toastH)} px`);
      await page.screenshot({ path: join(SHOTS, `stage-hard-data-${vp.name}.png`) });
    } finally {
      await close();
    }
  }
}

// ── Firefox: the same screens in Gecko (skipped when Firefox is not installed) ────────────────
async function firefoxChecks(srv) {
  console.log('\n== Firefox ==');
  const exe = process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (!(await stat(exe).catch(() => null))) {
    console.log(`  skip  Firefox not found at ${exe} (set FIREFOX_PATH to run these)`);
    return;
  }
  const { default: puppeteer } = await import('puppeteer-core');
  const profile = await mkdtemp(join(tmpdir(), 'segue-ff-'));
  let browser;
  try {
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: exe, headless: true, userDataDir: profile, args: ['-no-remote', '-new-instance'] });
  } catch (err) {
    console.log(`  skip  could not launch Firefox (${String(err && err.message).split('\n')[0]})`);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    return;
  }
  try {
    for (const vp of [{ name: '1440x900', width: 1440, height: 900 }, { name: '390x844', width: 390, height: 844 }, { name: '844x390', width: 844, height: 390 }]) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height });
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await watchCsp(page);
      for (const screen of ['landing', 'loading', 'ready', 'stage']) {
        errors.length = 0;
        await open(page, `${srv.url}/ui-demo.html?screen=${screen}&freeze=1`);
        if (screen === 'stage') {
          await page.evaluate(() => {
            const d = window.__segueDemo;
            const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
            d.seek(tr.tStart + (tr.tEnd - tr.tStart) * 0.55 - 1);
            for (let i = 0; i < 60; i++) d.step(1 / 60);
          });
        }
        await settle(500);
        const sels = mustSee(screen, vp);
        const bad = (await inspect(page, sels, vp.height >= 800 || screen !== 'stage')).filter((x) => x.problem && !(screen === 'landing' && /vertically/.test(x.problem)));
        const info = await page.evaluate((isStage) => {
          const out = { sw: document.documentElement.scrollWidth, iw: innerWidth, fonts: [...document.fonts].filter((f) => f.status === 'loaded').length, painted: 1, cost: 0, lock: true, csp: (window.__csp || []).slice() };
          if (!isStage) return out;
          const c = document.querySelector('.waves canvas');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
          out.painted = n / (d.length / 4);
          out.lock = document.querySelector('[data-ref="lock"]').classList.contains('is-on');
          const t0 = performance.now();
          for (let i = 0; i < 300; i++) window.__segueDemo.step(1 / 60);
          out.cost = (performance.now() - t0) / 300;
          return out;
        }, screen === 'stage');
        const real = errors.filter((e) => !ignorable(e));
        check(
          real.length === 0 && bad.length === 0 && info.sw <= vp.width && info.painted > 0.08 && info.lock && info.cost < 4 && info.csp.length === 0,
          `firefox ${screen} @ ${vp.name}: no errors, no policy violations, no overflow, ${sels.length} key elements visible${screen === 'stage' ? `, waveform ${(info.painted * 100).toFixed(0)}% painted, beat lock lit, frame ≈ ${info.cost.toFixed(2)} ms (300-frame batch incl. mock)` : ''}${info.fonts ? '' : ' (web fonts not loaded)'}${bad.length ? ` — ${bad.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}${real.length ? ` — ${real.join(' | ')}` : ''}${info.sw > vp.width ? ` — scrollWidth ${info.sw}` : ''}${info.csp.length ? ` — CSP: ${info.csp.join(' | ')}` : ''}`,
        );
        if (screen === 'stage') {
          // Gecko swallows clicks on disabled controls: the locked track-length control must still answer
          await page.click(vp.width <= COMPACT_MAX ? '[data-ref="mode-note"]' : '.seg label:nth-child(4)');
          await settle(80);
          const said = await page.evaluate(() => [...document.querySelectorAll('.toast p')].map((n) => n.textContent));
          check(said.some((t) => /30 seconds/.test(t)), `firefox stage @ ${vp.name}: clicking the locked track-length control explains it${said.length ? '' : ' — no toast appeared'}`);
          // a cued deck: parked waveform and countdown in Gecko too
          const cuedFx = await page.evaluate(() => {
            const d = window.__segueDemo;
            const { approach } = d.view._debug().waves.geo;
            const plays = d.state().plays;
            const k = plays.findIndex((p, i) => i > 0 && p.deck === 1 && p.startAt - p.loadAt > approach + 0.9 + 2.5);
            if (k < 0) return null;
            d.seek(plays[k].loadAt + 0.5);
            for (let i = 0; i < 30; i++) d.step(1 / 60);
            const { W, H, cx, laneH } = d.view._debug().waves.geo;
            const px = document.querySelector('.waves canvas').getContext('2d').getImageData(cx + 6, H - laneH, W - cx - 6, laneH).data;
            let n = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 30 && px[i + 2] > px[i] + 30) n++;
            return { lane: n / (px.length / 4), tag: document.querySelector('[data-ref="wt1"] [data-part="t"]').textContent };
          });
          check(!!cuedFx && cuedFx.lane > 0.05 && /^Cued · in \d+:\d\d$/.test(cuedFx.tag), `firefox stage @ ${vp.name}: a cued deck is parked in its lane (${cuedFx ? `${(cuedFx.lane * 100).toFixed(1)}% waveform, "${cuedFx.tag}"` : 'no long solo in the mock set'})`);
        }
        if (screen === 'stage') {
          // re-park for the screenshot (the timing loop above moved the set on)
          await page.evaluate(() => {
            const d = window.__segueDemo;
            const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
            d.seek(tr.tStart + (tr.tEnd - tr.tStart) * 0.55 - 1);
            for (let i = 0; i < 60; i++) d.step(1 / 60);
          });
          await settle(300);
        }
        await page.screenshot({ path: join(SHOTS, `firefox-${screen}-${vp.name}.png`) });
      }
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

// ── pure helpers (run in the page: they are ES modules served from the repo) ───────────────────
async function helperChecks(srv) {
  console.log('\n== helpers ==');
  const { page, close } = await launch({ width: 800, height: 600 });
  try {
    await page.goto(`${srv.url}/ui-demo.html?screen=landing&freeze=1`, { waitUntil: 'load' });
    const r = await page.evaluate(async () => {
      const dom = await import('./js/ui/dom.js');
      const mixer = await import('./js/ui/mixer.js');
      const mock = await import('./js/ui/mock.js');
      // script-scheme / data-scheme URLs, assembled here rather than written out
      const scriptUrl = `${['java', 'script'].join('')}:void 0`;
      const dataUrl = `${['da', 'ta'].join('')}:text/plain,x`;
      const t = mock.makeTrack({ seed: 5, bpm: 120, duration: 30 });
      const t2 = mock.makeTrack({ seed: 5, bpm: 120, duration: 30 });
      return {
        urls: [
          dom.safeUrl('https://example.com/a.png'), dom.safeUrl('blob:https://x/1'), dom.safeUrl('http://example.com/a.png'),
          dom.safeUrl(scriptUrl), dom.safeUrl(dataUrl), dom.safeUrl('/relative.png'), dom.safeUrl(''), dom.safeUrl(null),
        ],
        times: [dom.fmtTime(0), dom.fmtTime(59.9), dom.fmtTime(61), dom.fmtTime(3725), dom.fmtTime(-4), dom.fmtTime(NaN)],
        labels: [dom.linkLabel('https://open.spotify.com/track/x'), dom.linkLabel('https://www.deezer.com/track/1'), dom.linkLabel('https://music.apple.com/x'), dom.linkLabel('https://example.com'), dom.linkLabel(scriptUrl)],
        // a service's name is only for links that are on that service: the bare domain or a subdomain of it
        own: ['https://spotify.com/x', 'https://deezer.com/x', 'https://deezer.page.link/x', 'https://apple.com/x', 'https://geo.music.apple.com/x'].map(dom.linkLabel),
        lookalikes: ['https://pineapple.com/x', 'https://notspotify.com/x', 'https://mydeezer.com/x', 'https://spotify.com.example.net/x', 'https://open.spotify.com.example.net/x'].map(dom.linkLabel),
        // credentials in front of the host (assembled here, not written out) are refused, as in sources/util.js httpsUrl
        userinfo: [['name', ':', 'word', '@'], ['name', '@'], ['open.spotify.com', '@']].map((parts) => dom.safeUrl(`https://${parts.join('')}example.com/a.png`)),
        filter: [mixer.filterValue(20, 20000), mixer.filterValue(20000, 20000), mixer.filterValue(20, 20), mixer.filterValue(632, 20000) > 0.45 && mixer.filterValue(632, 20000) < 0.55, mixer.filterValue(20, 632) < -0.45 && mixer.filterValue(20, 632) > -0.55],
        track: { cols: t.wave.cols, perSec: t.wave.perSec, beats: t.beats.length, same: t.wave.low.join() === t2.wave.low.join(), grid: Math.abs(t.beats[1] - t.beats[0] - 0.5) < 1e-9, cue: t.cues.in === t.beats[0] },
      };
    });
    check(r.urls.join('|') === 'https://example.com/a.png|blob:https://x/1||||||', `safeUrl accepts only absolute https:/blob: (${JSON.stringify(r.urls)})`);
    check(r.times.join('|') === '0:00|0:59|1:01|1:02:05|0:00|0:00', `fmtTime (${r.times.join(', ')})`);
    check(r.labels.join('|') === 'Open in Spotify|Open in Deezer|Open in Apple Music|Open track|', `linkLabel (${r.labels.join(', ')})`);
    check(r.own.join('|') === 'Open in Spotify|Open in Deezer|Open in Deezer|Open in Apple Music|Open in Apple Music', `linkLabel names a service for its own domain and subdomains (${r.own.join(', ')})`);
    check(r.lookalikes.every((l) => l === 'Open track'), `linkLabel does not name a service for a look-alike host (${r.lookalikes.join(', ')})`);
    check(r.userinfo.every((u) => u === ''), `safeUrl refuses https URLs that carry a user name or password (${JSON.stringify(r.userinfo)})`);
    check(r.filter[0] === 0 && r.filter[1] === 1 && r.filter[2] === -1 && r.filter[3] && r.filter[4], 'filterValue: 0 when open, +1 high-pass fully up, −1 low-pass fully closed, log-scaled in between');
    check(r.track.cols === 3000 && r.track.perSec === 100 && r.track.beats === 60 && r.track.same && r.track.grid && r.track.cue, 'mock.makeTrack: deterministic, 100 columns/s, regular beat grid');
  } finally {
    await close();
  }
}

// ── index.html ────────────────────────────────────────────────────────────────────────────────
async function indexChecks(srv) {
  console.log('\n== index.html ==');
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const demoHtml = await readFile(join(ROOT, 'ui-demo.html'), 'utf8');
  const csp = parseCsp(cspOf(html));
  const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));
  check(cspOf(html).length > 0 && cspOf(html) === cspOf(demoHtml), 'index.html: Content-Security-Policy meta tag, and ui-demo.html runs under the very same policy');
  check(same(csp['default-src'], ["'self'"]) && same(csp['script-src'], ["'self'", 'https://api.deezer.com']), `CSP: scripts only from the page itself and Deezer's JSONP endpoint (script-src ${(csp['script-src'] || []).join(' ')})`);
  const loose = Object.entries(csp).filter(([, src]) => src.some((s) => /unsafe-inline|unsafe-eval|unsafe-hashes|^\*$|^https?:\/\/\*$/.test(s))).map(([name]) => name);
  check(loose.length === 0 && same(csp['style-src'], ["'self'", 'https://fonts.googleapis.com']) && same(csp['font-src'], ['https://fonts.gstatic.com']), `CSP: no inline script, inline style or eval anywhere${loose.length ? ` — loose: ${loose.join(', ')}` : ''}`);
  check(['object-src', 'base-uri', 'form-action'].every((d) => same(csp[d], ["'none'"])), "CSP: object-src, base-uri and form-action are 'none' (the last two do not fall back to default-src)");
  check(same(csp['connect-src'], ["'self'", 'https:']) && same(csp['worker-src'], ["'self'"]) && same(csp['media-src'], ['blob:']) && same(csp['img-src'], ["'self'", 'https:', 'data:', 'blob:']), 'CSP: fetch to the own origin and https hosts, module workers from the page, blob: media (the silent unlock clip), https / data: / blob: images');
  check(/<script type="module" src="\.\/js\/main\.js"><\/script>/.test(html), 'index.html: loads ./js/main.js as a module');
  // Web fonts must never hold up the page: the font stylesheet is declared with media="print" and switched on by js/ui/fonts.js.
  const blocking = [html, demoHtml].flatMap((h) => [...h.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((tag) => /rel="stylesheet"/.test(tag) && /href="https:/.test(tag) && !/media="print"[^>]*data-defer|data-defer[^>]*media="print"/.test(tag)));
  check(blocking.length === 0 && [html, demoHtml].every((h) => /<script type="module" src="\.\/js\/ui\/fonts\.js"><\/script>/.test(h)), `index.html / ui-demo.html: no render-blocking stylesheet from another host${blocking.length ? ` — ${blocking.join(' ')}` : ''}`);
  check(/name="theme-color"/.test(html) && /rel="manifest" href="\.\/assets\/manifest\.webmanifest"/.test(html) && /rel="icon" href="\.\/assets\/favicon\.svg"/.test(html), 'index.html: theme-color, manifest, SVG favicon');
  check(/property="og:image" content="[^"]*assets\/og\.png"/.test(html) && /name="twitter:card" content="summary_large_image"/.test(html), 'index.html: Open Graph / Twitter tags point at assets/og.png');
  const local = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https:/.test(u));
  check(local.length > 0 && local.every((u) => u.startsWith('./')), `index.html: local URLs are relative (${local.join(', ')})`);
  check(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+="/.test(html), 'index.html: no inline scripts or inline event handlers (CSP)');

  for (const f of ['assets/og.png', 'assets/favicon.svg', 'assets/apple-touch-icon.png', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png', 'assets/manifest.webmanifest']) {
    const info = await stat(join(ROOT, f)).catch(() => null);
    check(!!info && info.size > 200, `${f} exists${info ? ` (${info.size} bytes)` : ''}`);
  }
  const manifest = JSON.parse(await readFile(join(ROOT, 'assets/manifest.webmanifest'), 'utf8'));
  check(manifest.start_url === '../' && manifest.icons.length >= 3, 'manifest: start_url relative to the sub-path, icons listed');

  // the pre-JS fallback inside #app must render cleanly even before / without js/main.js
  const hasMain = !!(await stat(join(ROOT, 'js/main.js')).catch(() => null));
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    const { page, errors, close } = await launch(vp);
    try {
      await watchCsp(page);
      await page.setRequestInterception(true);
      page.on('request', (req) => (/\/js\/main\.js/.test(req.url()) ? req.respond({ status: 200, contentType: 'text/javascript', body: '' }) : req.continue()));
      await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]));
      const of = await overflow(page);
      const seen = (await inspect(page, ['.wordmark', '.l-title', '.l-sub', '.l-foot'], false)).filter((s) => s.problem);
      const real = errors.filter((e) => !ignorable(e));
      const violations = await page.evaluate(() => window.__csp.slice());
      check(of.scrollWidth <= vp.width && of.innerWidth === vp.width && seen.length === 0 && real.length === 0 && violations.length === 0, `index.html @ ${vp.name}: static first paint is clean, no policy violations (main.js stubbed${hasMain ? '' : '; the real file does not exist yet'})${real.length ? ` — ${real.join(' | ')}` : ''}${violations.length ? ` — CSP: ${violations.join(' | ')}` : ''}`);
      await page.screenshot({ path: join(SHOTS, `index-first-paint-${vp.name}.png`) });
    } finally {
      await close();
    }
  }
}

// ── a cued deck is parked in its lane, never an empty rectangle ───────────────────────────────
async function cuedChecks(srv) {
  console.log('\n== cued deck ==');
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    const { page, errors, close } = await launch(vp);
    try {
      // 1. the view on its own, with hand-built frames
      await open(page, `${srv.url}/ui-demo.html?screen=stage&freeze=1&empty=1`);
      const r = await page.evaluate(async () => {
        const { makeTrack } = await import('./js/ui/mock.js');
        const { cuedBlend } = await import('./js/ui/waves.js');
        const v = window.__segueDemo.view;
        const mk = (seed) => {
          const an = makeTrack({ seed, bpm: 124, duration: 30 });
          return { an, view: { playId: seed, title: `Track ${seed}`, artist: 'Test', bpm: 124, camelot: '8A', keyName: 'A minor', duration: 30, provider: 'deezer', wave: an.wave, beats: an.beats, downbeat: an.downbeat, cues: an.cues } };
        };
        const A = mk(41);
        const B = mk(42);
        v.setDeck(0, A.view);
        v.setDeck(1, B.view);
        const stats = () => v._debug().waves;
        const canvas = document.querySelector('.waves canvas');
        const g = canvas.getContext('2d');
        // share of deck-B-coloured (blue) pixels right of the playhead, where nothing is shaded
        const blue = (y0, y1) => {
          const { W, cx } = stats().geo;
          const px = g.getImageData(cx + 6, y0, W - cx - 6, y1 - y0).data;
          let n = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 30 && px[i + 2] > px[i] + 30) n++;
          return n / (px.length / 4);
        };
        const look = () => {
          const { H, laneH, railHalf } = stats().geo;
          const mid = Math.floor(H / 2);
          const tag = document.querySelector('[data-ref="wt1"]');
          // ticks hang from the centre line into the rail; the upper half of B's rail holds nothing else
          return { lane: blue(H - laneH, H), ticks: blue(mid + 1, mid + 1 + Math.floor(railHalf / 2)), shown: stats().shown[1], tag: tag.querySelector('[data-part="t"]').textContent, cuedClass: tag.classList.contains('is-cued') };
        };
        const df = (o) => ({ pos: 3, rate: 1, bpmNow: 124, gain: 1, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 1, ...o });
        const levels = { rms: 0.2, peak: 0.3, bands: new Uint8Array(64) };
        let clock = 10;
        const paint = (b, a = df({ pos: 8, startsIn: 0 })) => v.frame({ t: (clock += 1 / 60), playing: true, elapsed: clock, decks: [a, b], crossfade: -1, beatPhase: 0.5, levels });
        const entry = B.an.cues.in; // where deck B will come in
        const cued = (startsIn) => df({ pos: entry - startsIn, startsIn, gain: 0, audible: 0 });
        const approach = stats().geo.approach;
        const wind = 0.9;

        paint(cued(15));
        const parked = look();
        paint(cued(approach * 0.5));
        const running = look();

        // sweep the whole run-in at 60 fps: where the entry point is drawn must never jump
        let maxStep = 0;
        let prev = null;
        let first = null;
        let last = null;
        for (let s = approach + wind + 0.5; s >= 0; s -= 1 / 60) {
          paint(cued(s));
          const lead = entry - stats().shown[1].pos; // seconds between the playhead and the entry point
          if (first == null) first = lead;
          if (prev != null) maxStep = Math.max(maxStep, Math.abs(lead - prev));
          prev = lead;
          last = { s, lead };
        }

        v.setDeck(1, { ...B.view, playId: 43 });
        const bare = df({ pos: -15, gain: 0, audible: 0 });
        delete bare.startsIn;
        paint(bare);
        const fallback = look();
        paint(df({ pos: 5, startsIn: 0 }));
        const playing = look();

        // "Beat lock": deck B cued exactly in phase with deck A, but silent
        const beat = 60 / 124;
        const lockEl = document.querySelector('[data-ref="lock"]');
        for (let i = 0; i < 120; i++) paint(df({ pos: 8 - 40 * beat - 15, startsIn: 15, gain: 0, audible: 0 }));
        const lockCued = lockEl.classList.contains('is-on');
        for (let i = 0; i < 120; i++) paint(df({ pos: 8 - 4 * beat, startsIn: 0 }));
        const lockHeard = lockEl.classList.contains('is-on');

        return {
          parked, running, fallback, playing, entry, approach, maxStep, first, last, lockCued, lockHeard,
          blend: [cuedBlend(60, 4), cuedBlend(4.9, 4), cuedBlend(4.45, 4), cuedBlend(4, 4), cuedBlend(1, 4), cuedBlend(0, 4), cuedBlend(-1, 4), cuedBlend(NaN, 4), cuedBlend(Infinity, 4)],
        };
      });
      const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
      const pct = (x) => `${(x * 100).toFixed(1)}%`;
      check(r.parked.lane > 0.05, `cued @ ${vp.name}: a deck that starts in 15 s shows its waveform in its lane (${pct(r.parked.lane)} of the lane right of the playhead is waveform)`);
      check(near(r.parked.shown.pos, r.entry) && r.parked.shown.aligned === 0 && r.parked.ticks === 0, `cued @ ${vp.name}: parked with its entry point on the playhead and no beat ticks (position ${r.parked.shown.pos.toFixed(3)} s vs entry ${r.entry.toFixed(3)} s, tick pixels ${pct(r.parked.ticks)})`);
      check(r.parked.tag === 'Cued · in 0:15' && r.parked.cuedClass, `cued @ ${vp.name}: lane tag counts down to the start ("${r.parked.tag}")`);
      check(near(r.running.shown.pos, r.entry - r.approach * 0.5) && r.running.shown.aligned === 1 && r.running.ticks > 0.002 && r.running.lane > 0.02, `cued @ ${vp.name}: inside the last ${r.approach.toFixed(1)} s it is time-aligned again, beat ticks showing (${pct(r.running.ticks)} tick pixels)`);
      check(near(r.first, 0) && near(r.last.lead, r.last.s, 1e-6) && r.maxStep < 0.2, `cued @ ${vp.name}: parked → pulled back → run-in is one continuous movement (largest step ${(r.maxStep * 1000).toFixed(0)} ms of set time per frame)`);
      check(near(r.fallback.shown.pos, 0) && r.fallback.shown.aligned === 0 && r.fallback.lane > 0.05 && r.fallback.ticks === 0 && r.fallback.tag === 'Cued', `cued @ ${vp.name}: without startsIn a not-yet-started deck is still parked, first sample on the playhead ("${r.fallback.tag}", ${pct(r.fallback.lane)} waveform)`);
      check(near(r.playing.shown.pos, 5) && r.playing.shown.aligned === 1 && r.playing.tag === '−0:25' && !r.playing.cuedClass, `cued @ ${vp.name}: a running deck is drawn where it plays and shows its time left ("${r.playing.tag}")`);
      check(!r.lockCued && r.lockHeard, `cued @ ${vp.name}: "Beat lock" stays dark for a silent cued deck that merely sits in phase, and lights once both decks are heard`);
      check(JSON.stringify(r.blend.map((x) => +x.toFixed(4))) === JSON.stringify([0, 0, 0.5, 1, 1, 1, 1, 1, 0]), `cuedBlend: 0 parked, eased across the pull-back, 1 for the run-in and for anything not waiting (${r.blend.map((x) => +x.toFixed(3)).join(', ')})`);

      // 2. the mock set: during a solo the next track is cued, and its lane is not empty
      await open(page, `${srv.url}/ui-demo.html?screen=stage&freeze=1`);
      const solo = await page.evaluate(() => {
        const d = window.__segueDemo;
        const { approach } = d.view._debug().waves.geo;
        const plays = d.state().plays;
        const k = plays.findIndex((p, i) => i > 0 && p.deck === 1 && p.startAt - p.loadAt > approach + 0.9 + 2.5);
        if (k < 0) return null;
        d.seek(plays[k].loadAt + 0.5);
        for (let i = 0; i < 60; i++) d.step(1 / 60);
        const { W, H, cx, laneH } = d.view._debug().waves.geo;
        const c = document.querySelector('.waves canvas');
        const px = c.getContext('2d').getImageData(cx + 6, H - laneH, W - cx - 6, laneH).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 30 && px[i + 2] > px[i] + 30) n++;
        return { lane: n / (px.length / 4), tag: document.querySelector('[data-ref="wt1"] [data-part="t"]').textContent, wait: plays[k].startAt - d.state().t, lamp: document.querySelector('.deck-b [data-part="lamp"]').textContent, lock: document.querySelector('[data-ref="lock"]').classList.contains('is-on'), fader: document.querySelector('.ch-b .fader-fill').style.transform };
      });
      check(!!solo && solo.lane > 0.05 && /^Cued · in \d+:\d\d$/.test(solo.tag) && solo.lamp === 'Cued' && !solo.lock, `mock set @ ${vp.name}: ${solo ? `${solo.wait.toFixed(1)} s before deck B starts its lane shows the cued track (${pct(solo.lane)} waveform, tag "${solo.tag}", lamp "${solo.lamp}", beat lock ${solo.lock ? 'lit' : 'dark'})` : 'no long solo found in the mock set'}`);
      await page.screenshot({ path: join(SHOTS, `stage-cued-${vp.name}.png`) });
      const real = errors.filter((e) => !ignorable(e));
      check(real.length === 0, `cued @ ${vp.name}: no console errors${real.length ? ` — ${real.join(' | ')}` : ''}`);
    } finally {
      await close();
    }
  }
}

// ── Content-Security-Policy as the browser enforces it ────────────────────────────────────────
/** Collect securitypolicyviolation events from the first byte on (install before navigating). */
const watchCsp = (page) =>
  page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective || e.violatedDirective} ← ${String(e.blockedURI).slice(0, 60)}`));
  });

async function policyChecks(srv) {
  console.log('\n== Content-Security-Policy, enforced ==');
  const { page, close } = await launch(VIEWPORTS[0]);
  try {
    await watchCsp(page);
    // every screen, a transition, toasts, the setlist, a failed load: the view itself must never trip the policy
    for (const q of ['screen=landing&freeze=1', 'screen=loading&freeze=1', 'screen=ready&freeze=1', 'screen=stage&freeze=1&toasts=1&rec=1&long=1']) {
      await open(page, `${srv.url}/ui-demo.html?${q}`);
      const own = await page.evaluate(() => {
        const d = window.__segueDemo;
        if (d.state().screen === 'stage') {
          const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
          d.seek(tr.tStart - 6);
          for (let i = 0; i < 600; i++) d.step(1 / 30);
        }
        return window.__csp.slice();
      });
      check(own.length === 0, `ui-demo.html?${q}: the view runs with zero policy violations${own.length ? ` — ${own.join(' | ')}` : ''}`);
    }
    // what the app itself does must stay allowed: a fetch to its own origin (also on a plain-http dev
    // server, where "https:" alone would not cover it) and styles written through the CSSOM
    const allowed = await page.evaluate(async () => {
      const seen = window.__csp.length;
      const status = await fetch('./assets/manifest.webmanifest').then((res) => res.status, (err) => String(err));
      const box = document.body.appendChild(document.createElement('i'));
      box.style.cssText = 'position:fixed;left:-99px;width:33px';
      const styled = getComputedStyle(box).width === '33px';
      box.remove();
      return { status, styled, violations: window.__csp.slice(seen) };
    });
    check(allowed.status === 200 && allowed.styled && allowed.violations.length === 0, `CSP: same-origin fetch and CSSOM styles are allowed (fetch → ${allowed.status})${allowed.violations.length ? ` — ${allowed.violations.join(' | ')}` : ''}`);

    // …and the policy is real: each class of injected markup is refused by the browser
    const probe = await page.evaluate(async () => {
      const seen = window.__csp.length;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const mk = (tag, attrs = {}) => {
        const n = document.createElement(tag);
        for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
        return n;
      };
      const styled = host.appendChild(mk('p', { style: 'position:fixed;left:-99px;width:77px' }));
      const sheet = host.appendChild(mk('style'));
      sheet.textContent = '#csp-probe{width:55px}';
      const ruled = host.appendChild(mk('p', { id: 'csp-probe' }));
      const script = mk('script');
      script.textContent = 'window.__cspInline = 1';
      host.appendChild(script);
      const base = document.head.appendChild(mk('base', { href: 'https://csp-probe.invalid/' }));
      const baseTook = document.baseURI.includes('csp-probe.invalid');
      base.remove();
      host.appendChild(mk('iframe', { name: 'csp-probe-frame', hidden: '' }));
      host.appendChild(mk('form', { action: 'https://csp-probe.invalid/', target: 'csp-probe-frame', method: 'get' })).submit();
      host.appendChild(mk('object', { data: 'https://csp-probe.invalid/x', type: 'application/pdf' }));
      await new Promise((res) => setTimeout(res, 500));
      const out = {
        styleAttr: getComputedStyle(styled).width === '77px', styleElem: getComputedStyle(ruled).width === '55px', inlineScript: window.__cspInline === 1, baseTook,
        fired: [...new Set(window.__csp.slice(seen).map((v) => v.split(' ')[0]))],
      };
      host.remove();
      return out;
    });
    check(!probe.styleAttr && !probe.styleElem && !probe.inlineScript && !probe.baseTook, `CSP enforced: injected inline style / <style> / <script> / <base> have no effect (${JSON.stringify({ styleAttr: probe.styleAttr, styleElem: probe.styleElem, inlineScript: probe.inlineScript, base: probe.baseTook })})`);
    const expected = ['style-src-attr', 'style-src-elem', 'script-src-elem', 'base-uri', 'form-action', 'object-src'];
    const missing = expected.filter((d) => !probe.fired.includes(d));
    check(missing.length === 0, `CSP enforced: the browser reported ${expected.join(', ')}${missing.length ? ` — not reported: ${missing.join(', ')} (got ${probe.fired.join(', ')})` : ''}`);
  } finally {
    await close();
  }
}

// ── web fonts are optional: blocked or never answered, the page still paints and works ────────
async function fontChecks(srv) {
  console.log('\n== without the font host ==');
  const fontHost = (url) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url);
  for (const how of ['never answers', 'is blocked']) {
    for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
      const { page, errors, close } = await launch(vp);
      try {
        await page.setRequestInterception(true);
        let asked = 0;
        page.on('request', (req) => {
          if (/\/js\/main\.js/.test(req.url())) return req.respond({ status: 200, contentType: 'text/javascript', body: '' });
          if (!fontHost(req.url())) return req.continue();
          asked++;
          // "never answers": the request is simply left hanging, as on a network that drops it
          return how === 'is blocked' ? req.abort('blockedbyclient') : undefined;
        });
        const paintWithin = async (url, extra) => {
          const t0 = Date.now();
          // 'load' would wait for the hanging request, which is exactly what the page itself must not do
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          let fcp = null;
          let ready = !extra;
          while (Date.now() - t0 < 4000 && (fcp == null || !ready)) {
            await settle(60);
            fcp = await page.evaluate(() => (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime ?? null);
            if (extra) ready = await page.evaluate(extra);
          }
          return { fcp, ready, ms: Date.now() - t0 };
        };
        const first = await paintWithin(`${srv.url}/index.html`);
        check(first.fcp != null && first.fcp < 2500 && asked > 0, `index.html @ ${vp.name}, font host ${how}: first paint ${first.fcp == null ? `not within ${first.ms} ms` : `after ${Math.round(first.fcp)} ms`}`);
        for (const screen of ['landing', 'stage']) {
          const r = await paintWithin(`${srv.url}/ui-demo.html?screen=${screen}&freeze=1`, () => !!window.__segueDemo && window.__segueDemo.ready.then(() => document.querySelector('#app').dataset.screen || '', () => ''));
          if (screen === 'stage') {
            await page.evaluate(() => {
              const d = window.__segueDemo;
              const tr = d.state().trans.find((x) => x.type === 'bassSwap' || x.type === 'eqBlend' || x.type === 'filterBlend');
              d.seek(tr.tStart + (tr.tEnd - tr.tStart) * 0.55 - 1);
              for (let i = 0; i < 60; i++) d.step(1 / 60);
            });
          }
          await settle(300);
          const of = await overflow(page);
          const sels = mustSee(screen, vp);
          const bad = (await inspect(page, sels, true)).filter((s) => s.problem);
          const webFonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
          const real = errors.filter((e) => !ignorable(e) && !/ERR_BLOCKED_BY_CLIENT/.test(e));
          check(
            r.fcp != null && r.ready === screen && webFonts === 0 && of.scrollWidth <= vp.width && of.innerWidth === vp.width && bad.length === 0 && real.length === 0,
            `${screen} @ ${vp.name}, font host ${how}: paints (${r.fcp == null ? 'never' : `${Math.round(r.fcp)} ms`}), the view boots, fallback fonts fit — no overflow, ${sels.length} key elements visible${bad.length ? ` — ${bad.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}${of.wide.length ? ` — wide: ${of.wide.join(', ')}` : ''}${real.length ? ` — ${real.join(' | ')}` : ''}${webFonts ? ` — ${webFonts} web fonts loaded?!` : ''}`,
          );
          await page.screenshot({ path: join(SHOTS, `${screen}-no-webfonts-${vp.name}.png`) });
        }
      } finally {
        await close();
      }
    }
  }
}

// ── assets (og.png, PNG icons) ────────────────────────────────────────────────────────────────
async function makeAssets(srv) {
  console.log('\n== rendering assets ==');
  {
    const { page, close } = await launch({ width: 1200, height: 630 });
    try {
      await page.goto(`${srv.url}/assets/og-card.html`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.documentElement.dataset.ready === '1', { timeout: 15000 });
      const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
      if (!fonts.some((f) => /Anybody/.test(f))) throw new Error('web fonts did not load — refusing to render og.png with fallback fonts');
      await page.screenshot({ path: join(ROOT, 'assets', 'og.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
      ok('assets/og.png (1200×630)');
    } finally {
      await close();
    }
  }
  const svg = await readFile(join(ROOT, 'assets', 'favicon.svg'), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  // full-bleed square (no rounded corners): the platform applies its own mask
  const square = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#09090b"/><g transform="translate(32 32) scale(${pad}) translate(-32 -32)">${inner.replace(/<rect[^>]*\/>/, '')}</g></svg>`;
  for (const [file, size, pad] of [['apple-touch-icon.png', 180, 0.86], ['icon-192.png', 192, 0.92], ['icon-512.png', 512, 0.92], ['icon-maskable-512.png', 512, 0.7]]) {
    const { page, close } = await launch({ width: size, height: size });
    try {
      await page.setContent(`<style>html,body{margin:0;background:#09090b}svg{display:block;width:${size}px;height:${size}px}</style>${square(pad)}`);
      await page.screenshot({ path: join(ROOT, 'assets', file), clip: { x: 0, y: 0, width: size, height: size } });
      ok(`assets/${file} (${size}×${size})`);
    } finally {
      await close();
    }
  }
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────
await mkdir(SHOTS, { recursive: true });
const tmp = await mkdtemp(join(tmpdir(), 'segue-ui-'));
// tiny stand-in files for the picker: the view only looks at name / type, it never decodes audio
await writeFile(join(tmp, 'Glasshouse.mp3'), Buffer.alloc(256));
await writeFile(join(tmp, 'Night Bus.flac'), Buffer.alloc(256));
await writeFile(join(tmp, 'notes.txt'), 'not audio');

const srv = await startServer();
let crashed = null;
try {
  if (MAKE_ASSETS) await makeAssets(srv);
  if (want('screens')) for (const vp of VIEWPORTS) await screenChecks(srv, vp);
  if (want('sizes')) await extraSizes(srv);
  if (want('handlers')) {
    await handlerChecks(srv, VIEWPORTS[0], tmp);
    await handlerChecks(srv, VIEWPORTS[2], tmp);
  }
  if (want('cued')) await cuedChecks(srv);
  if (want('live')) await liveChecks(srv);
  if (want('robust')) await robustChecks(srv);
  if (want('helpers')) await helperChecks(srv);
  if (want('cost')) {
    await frameCost(srv, VIEWPORTS[0]);
    await frameCost(srv, VIEWPORTS[2]);
  }
  if (want('index')) await indexChecks(srv);
  if (want('csp')) await policyChecks(srv);
  if (want('fonts')) await fontChecks(srv);
  if (want('firefox')) await firefoxChecks(srv);
} catch (err) {
  crashed = err;
} finally {
  await srv.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log('\n── summary ──');
for (const n of notes) console.log(n);
if (crashed) console.log(`CRASHED: ${crashed && crashed.stack ? crashed.stack : crashed}`);
console.log(failures.length || crashed ? `${failures.length} check(s) failed` : `all UI checks passed · screenshots in handoff/shots/`);
process.exit(failures.length || crashed ? 1 : 0);

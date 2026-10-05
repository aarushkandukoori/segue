// UI end-to-end checks, driven through ui-demo.html (mock data, no audio, no app network).
//
//   node tests/e2e/ui.e2e.mjs            run every check, write screenshots to handoff/shots/
//   node tests/e2e/ui.e2e.mjs --assets   also re-render assets/og.png and the PNG icons
//
// For each screen × viewport (1440×900, 1024×768, 390×844 touch): no console errors, no horizontal
// overflow, key elements present / visible / inside the viewport, a screenshot. Then: phone-browser
// and phone-on-its-side viewports (the whole booth must fit), every handler from click / tap /
// keyboard / file input / drop, keyboard shortcuts ignored while typing, hostile / sparse / extreme
// data, view.frame() cost over 600 frames (mean + p95) incl. a 6-minute, 36 000-column track, and the
// same screens again in Firefox when it is installed (skipped otherwise).
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
      '[data-ref="play"]', '[data-ref="skip"]', '[data-ref="newset"]', '#segue-vibe', '.tp-mode .seg',
    ],
    wide: ['.crate .sl', '.deck-a .deck-link', '.deck-a .deck-provider', '#segue-volume', '.pl-title'],
    narrow: ['[data-ref="crate-toggle"]'],
  },
};

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
      const sels = [...spec.all, ...(wide ? spec.wide || [] : spec.narrow || [])];
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
          ? ['.waves canvas', '.deck-a .deck-title', '.deck-b [data-part="bpm"]', '.ch-a [data-knob="low"]', '.xf-cap', '[data-ref="play"]', '[data-ref="newset"]', '#segue-vibe', '.tp-mode .seg', '[data-ref="rec"]', '[data-ref="share"]']
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
    await fresh('&long=1');
    await press(page, vp, '.seg label:nth-child(4)');
    got = await calls(page);
    check(got.length === 1 && got[0][0] === 'onMode' && got[0][1] === 'full', `stage: track length (enabled) → onMode(${JSON.stringify(got[0] && got[0][1])})`);

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
      const evil = '<img src=x onerror="window.__pwned=1">';
      v.setDeck(0, { playId: 99, title: evil, artist: evil, artwork: 'javascript:alert(1)', link: 'javascript:alert(1)', bpm: 120, camelot: '8A', keyName: evil, duration: 30, provider: 'deezer', wave: { cols: 10, perSec: 100, low: new Uint8Array(10), mid: new Uint8Array(10), high: new Uint8Array(10) }, beats: [0.1, 0.6], downbeat: 0, cues: { start: 0, end: 30, in: 0.1, drop: null } });
      v.setSetlist([{ key: 'x', title: evil, artist: evil, artwork: 'http://insecure.example/a.png', state: 'playing', link: 'data:text/html,hi', via: evil }]);
      v.setPlaylist({ title: evil, subtitle: evil, artwork: 'javascript:1', link: 'javascript:1', count: 3, source: 'spotify' });
      v.setTransition({ type: 'cut', label: evil, why: evil, fromTitle: evil, toTitle: evil, state: 'upcoming', tStart: 10, tEnd: 11, marks: [{ t: 10, label: evil }] });
      v.toast(evil, 'error');
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
        const spec = MUST_SEE[screen];
        const wide = vp.width >= 1180;
        const sels = [...spec.all, ...(wide ? spec.wide || [] : spec.narrow || [])];
        const bad = (await inspect(page, sels, vp.height >= 800 || screen !== 'stage')).filter((x) => x.problem && !(screen === 'landing' && /vertically/.test(x.problem)));
        const info = await page.evaluate((isStage) => {
          const out = { sw: document.documentElement.scrollWidth, iw: innerWidth, fonts: [...document.fonts].filter((f) => f.status === 'loaded').length, painted: 1, cost: 0, lock: true };
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
          real.length === 0 && bad.length === 0 && info.sw <= vp.width && info.painted > 0.08 && info.lock && info.cost < 4,
          `firefox ${screen} @ ${vp.name}: no errors, no overflow, ${sels.length} key elements visible${screen === 'stage' ? `, waveform ${(info.painted * 100).toFixed(0)}% painted, beat lock lit, frame ≈ ${info.cost.toFixed(2)} ms (300-frame batch incl. mock)` : ''}${info.fonts ? '' : ' (web fonts not loaded)'}${bad.length ? ` — ${bad.map((b) => `${b.sel}: ${b.problem}`).join('; ')}` : ''}${real.length ? ` — ${real.join(' | ')}` : ''}${info.sw > vp.width ? ` — scrollWidth ${info.sw}` : ''}`,
        );
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
      const t = mock.makeTrack({ seed: 5, bpm: 120, duration: 30 });
      const t2 = mock.makeTrack({ seed: 5, bpm: 120, duration: 30 });
      return {
        urls: [
          dom.safeUrl('https://example.com/a.png'), dom.safeUrl('blob:https://x/1'), dom.safeUrl('http://example.com/a.png'),
          dom.safeUrl('javascript:alert(1)'), dom.safeUrl('data:text/html,x'), dom.safeUrl('/relative.png'), dom.safeUrl(''), dom.safeUrl(null),
        ],
        times: [dom.fmtTime(0), dom.fmtTime(59.9), dom.fmtTime(61), dom.fmtTime(3725), dom.fmtTime(-4), dom.fmtTime(NaN)],
        labels: [dom.linkLabel('https://open.spotify.com/track/x'), dom.linkLabel('https://www.deezer.com/track/1'), dom.linkLabel('https://music.apple.com/x'), dom.linkLabel('https://example.com'), dom.linkLabel('javascript:1')],
        filter: [mixer.filterValue(20, 20000), mixer.filterValue(20000, 20000), mixer.filterValue(20, 20), mixer.filterValue(632, 20000) > 0.45 && mixer.filterValue(632, 20000) < 0.55, mixer.filterValue(20, 632) < -0.45 && mixer.filterValue(20, 632) > -0.55],
        track: { cols: t.wave.cols, perSec: t.wave.perSec, beats: t.beats.length, same: t.wave.low.join() === t2.wave.low.join(), grid: Math.abs(t.beats[1] - t.beats[0] - 0.5) < 1e-9, cue: t.cues.in === t.beats[0] },
      };
    });
    check(r.urls.join('|') === 'https://example.com/a.png|blob:https://x/1||||||', `safeUrl accepts only absolute https:/blob: (${JSON.stringify(r.urls)})`);
    check(r.times.join('|') === '0:00|0:59|1:01|1:02:05|0:00|0:00', `fmtTime (${r.times.join(', ')})`);
    check(r.labels.join('|') === 'Open in Spotify|Open in Deezer|Open in Apple Music|Open track|', `linkLabel (${r.labels.join(', ')})`);
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
  check(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https:\/\/api\.deezer\.com; connect-src https:; img-src [^;]*https: data: blob:; media-src https: blob: data:; style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com; font-src https:\/\/fonts\.gstatic\.com; worker-src 'self' blob:">/.test(html), 'index.html: Content-Security-Policy meta tag');
  check(/<script type="module" src="\.\/js\/main\.js"><\/script>/.test(html), 'index.html: loads ./js/main.js as a module');
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
      await page.setRequestInterception(true);
      page.on('request', (req) => (/\/js\/main\.js/.test(req.url()) ? req.respond({ status: 200, contentType: 'text/javascript', body: '' }) : req.continue()));
      await page.goto(`${srv.url}/index.html`, { waitUntil: 'load' });
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]));
      const of = await overflow(page);
      const seen = (await inspect(page, ['.wordmark', '.l-title', '.l-sub', '.l-foot'], false)).filter((s) => s.problem);
      const real = errors.filter((e) => !ignorable(e));
      check(of.scrollWidth <= vp.width && of.innerWidth === vp.width && seen.length === 0 && real.length === 0, `index.html @ ${vp.name}: static first paint is clean (main.js stubbed${hasMain ? '' : '; the real file does not exist yet'})${real.length ? ` — ${real.join(' | ')}` : ''}`);
      await page.screenshot({ path: join(SHOTS, `index-first-paint-${vp.name}.png`) });
    } finally {
      await close();
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
  for (const vp of VIEWPORTS) await screenChecks(srv, vp);
  await extraSizes(srv);
  await handlerChecks(srv, VIEWPORTS[0], tmp);
  await handlerChecks(srv, VIEWPORTS[2], tmp);
  await liveChecks(srv);
  await robustChecks(srv);
  await helperChecks(srv);
  await frameCost(srv, VIEWPORTS[0]);
  await frameCost(srv, VIEWPORTS[2]);
  await indexChecks(srv);
  await firefoxChecks(srv);
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

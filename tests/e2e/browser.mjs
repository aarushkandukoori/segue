// Headless-Chrome launcher shared by every e2e script. Uses the system Chrome via puppeteer-core.
// Each launch gets its own throwaway profile dir (reusing a profile across runs breaks on this Mac).
import puppeteer from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Switches that keep a hidden tab running at full speed. Puppeteer passes all three by default, so leaving
 *  our own flag out is not enough: measured, a 20 Hz setInterval in a hidden tab runs at 20/s with them and
 *  at 1/s (Chrome's real throttling) without them. */
const BACKGROUND_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/**
 * @param {{ width?: number, height?: number, mobile?: boolean, gesture?: boolean, realBackground?: boolean }} [opts]
 *   gesture: true keeps Chrome's real autoplay policy (audio only after a click), to test that path
 *   realBackground: true lets Chrome throttle and background a hidden tab as it does for a visitor with many
 *     tabs open (timers at most once a second); by default hidden tabs run at full speed. Hide a page with
 *     sendToBackground().
 * @returns {Promise<{ browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page,
 *   logs: {type: string, text: string}[], errors: string[], close: () => Promise<void> }>}
 */
export async function launch({ width = 1440, height = 900, mobile = false, gesture = false, realBackground = false } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'segue-chrome-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: profile,
    ...(realBackground ? { ignoreDefaultArgs: BACKGROUND_FLAGS } : {}),
    args: [
      // AudioContext may start without a click — unless the test is about that click
      ...(gesture ? [] : ['--autoplay-policy=no-user-gesture-required']),
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      ...(realBackground ? [] : ['--disable-background-timer-throttling']),
      `--window-size=${width},${height}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({
    width,
    height,
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const logs = [];
  const errors = [];
  page.on('console', (msg) => {
    const entry = { type: msg.type(), text: msg.text() };
    logs.push(entry);
    if (entry.type === 'error') errors.push(entry.text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    logs.push({ type: 'requestfailed', text: `${req.url()} ${req.failure()?.errorText || ''}` });
  });
  const close = async () => {
    await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { browser, page, logs, errors, close };
}

/**
 * Hides `page` the way switching tabs does: another tab is opened in front of it (document.visibilityState
 * becomes 'hidden'). Throttling follows only with launch({realBackground: true}).
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<() => Promise<void>>} brings `page` back to the front and closes the other tab
 */
export async function sendToBackground(page) {
  const other = await page.browser().newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  return async () => {
    await page.bringToFront();
    await other.close().catch(() => {});
  };
}

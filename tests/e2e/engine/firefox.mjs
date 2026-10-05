// Node side: headless-Firefox launcher for the engine e2e (tests/e2e/browser.mjs is the Chrome one).
// Firefox is the browser whose Web Audio differs most from Chrome's where the engine cares: no
// AudioParam.cancelAndHoldAtTime, no OfflineAudioContext.suspend, a DynamicsCompressor that still has
// the old pre-emphasis, an output timestamp without the device latency. puppeteer-core drives it over
// WebDriver BiDi; every launch gets a throwaway profile.
import puppeteer from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIREFOX = process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox';

/**
 * @param {{ width?: number, height?: number }} [opts]
 * @returns {Promise<{ browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page,
 *   logs: {type: string, text: string}[], errors: string[], close: () => Promise<void> }>}
 */
export async function launchFirefox({ width = 1000, height = 700 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'segue-firefox-'));
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: true,
    userDataDir: profile,
    extraPrefsFirefox: {
      'media.volume_scale': '0.0', // silent, but the audio device still runs
      'media.autoplay.default': 0, // an AudioContext may start without a click
      'media.autoplay.blocking_policy': 0,
      'browser.shell.checkDefaultBrowser': false,
      'datareporting.policy.dataSubmissionEnabled': false,
    },
    args: [`--width=${width}`, `--height=${height}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height });
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

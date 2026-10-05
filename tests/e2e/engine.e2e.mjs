// Engine e2e: drives tests/e2e/engine-harness.html in headless Chrome, then in headless Firefox.
// Every group renders hand-authored plans through the real engine (OfflineAudioContext, plus realtime
// smoke tests) and compares the samples with what js/dj/timeline.js predicts.
//
//   node tests/e2e/engine.e2e.mjs                 all engine groups, in both browsers
//   node tests/e2e/engine.e2e.mjs timing fx       only these groups
//   node tests/e2e/engine.e2e.mjs plannerSmoke    optional: real planner output through the engine
//   node tests/e2e/engine.e2e.mjs --chrome        only Chrome   (--firefox: only Firefox)
//
// Firefox has no OfflineAudioContext.suspend(), which the cancel / bassSwap / lifecycle groups are
// built on, so it runs the others; the "compat" group covers what those would have shown there
// (cancelFrom on the fallback path, captured in realtime) plus the places where Firefox's Web Audio
// is known to differ. A browser that is not installed is skipped, not failed.
//
// Exit code 0 = every assertion passed in every browser that ran.
import { existsSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';
import { launchFirefox, FIREFOX } from './engine/firefox.mjs';

// Same lookup as browser.mjs.
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BROWSERS = [
  { name: 'chrome', path: CHROME, env: 'CHROME_PATH', launch: () => launch({ width: 1000, height: 700 }) },
  { name: 'firefox', path: FIREFOX, env: 'FIREFOX_PATH', launch: () => launchFirefox({ width: 1000, height: 700 }) },
];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const only = args.filter((a) => !a.startsWith('--'));
const badFlags = flags.filter((f) => !BROWSERS.some((b) => `--${b.name}` === f));
if (badFlags.length) {
  console.error(`unknown option(s): ${badFlags.join(', ')} (have: ${BROWSERS.map((b) => `--${b.name}`).join(', ')})`);
  process.exit(2);
}
const picked = BROWSERS.filter((b) => !flags.length || flags.includes(`--${b.name}`));

const srv = await startServer();
let failed = 0;
let passed = 0;
let ran = 0;

/** A group that hangs (a browser that never finishes a render) must fail the run, not stall it. */
const GROUP_TIMEOUT_S = 240;
function withTimeout(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${GROUP_TIMEOUT_S} s`)), GROUP_TIMEOUT_S * 1000);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function runIn(browser) {
  let session;
  try {
    session = await browser.launch();
  } catch (err) {
    failed++;
    console.log(`  FAIL [${browser.name}] could not be launched: ${err && err.message ? err.message : err}`);
    return;
  }
  const { page, errors, logs, close } = session;
  try {
    await page.goto(`${srv.url}/tests/e2e/engine-harness.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.engineTests !== undefined', { timeout: 15000 });
    const { groups, optional, unsupported } = await page.evaluate(() => ({
      groups: window.engineTests.groups,
      optional: window.engineTests.optional,
      unsupported: window.engineTests.unsupported,
    }));
    const unknown = only.filter((g) => !groups.includes(g) && !optional.includes(g));
    if (unknown.length) throw new Error(`unknown group(s): ${unknown.join(', ')} (have: ${groups.join(', ')}; optional: ${optional.join(', ')})`);

    const wanted = only.length ? only : groups;
    const skipped = wanted.filter((g) => unsupported.includes(g));
    if (skipped.length) console.log(`\n[${browser.name}] not run here (they need OfflineAudioContext.suspend): ${skipped.join(', ')}`);
    for (const group of wanted.filter((g) => !unsupported.includes(g))) {
      console.log(`\n[${browser.name}] ${group}`);
      const results = await withTimeout(page.evaluate((name) => window.engineTests.run(name), group), `[${browser.name}] ${group}`);
      for (const r of results) {
        if (r.ok) passed++;
        else failed++;
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
      }
    }
    // The engine must run clean: any console.error / uncaught exception on the page fails the run,
    // and so does a browser warning (Chrome warns when an AudioParam is driven outside its range).
    for (const e of errors) {
      failed++;
      console.log(`  FAIL [${browser.name}] page error: ${e}`);
    }
    for (const l of logs) {
      if (l.type !== 'warn' && l.type !== 'warning' && l.type !== 'requestfailed') continue;
      failed++;
      console.log(`  FAIL [${browser.name}] page ${l.type}: ${l.text}`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAIL [${browser.name}] harness: ${err && err.stack ? err.stack : err}`);
    for (const e of errors) console.log(`  page error: ${e}`);
  } finally {
    await close();
  }
}

try {
  for (const browser of picked) {
    // Not installed = nothing to run there, not a failure.
    if (!existsSync(browser.path)) {
      console.log(`\nengine e2e: ${browser.name} SKIPPED, nothing at ${browser.path} (set ${browser.env})`);
      continue;
    }
    ran++;
    await runIn(browser);
  }
} finally {
  await srv.close();
}

if (!ran) {
  console.log('engine e2e: SKIPPED, no browser to run in');
  process.exit(0);
}
console.log(`\nengine e2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

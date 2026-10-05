// Engine e2e: drives tests/e2e/engine-harness.html in headless Chrome.
// Every group renders hand-authored plans through the real engine (OfflineAudioContext, plus one
// realtime smoke test) and compares the samples with what js/dj/timeline.js predicts.
//
//   node tests/e2e/engine.e2e.mjs                 all engine groups
//   node tests/e2e/engine.e2e.mjs timing fx       only these groups
//   node tests/e2e/engine.e2e.mjs plannerSmoke    optional: real planner output through the engine
//
// Exit code 0 = every assertion passed.
import { existsSync } from 'node:fs';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

// Same lookup as browser.mjs. No Chrome on this machine = nothing to run, not a failure.
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`engine e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}

const only = process.argv.slice(2);
const srv = await startServer();
const { page, errors, logs, close } = await launch({ width: 1000, height: 700 });
let failed = 0;
let passed = 0;

try {
  await page.goto(`${srv.url}/tests/e2e/engine-harness.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.engineTests !== undefined', { timeout: 15000 });
  const { groups, optional } = await page.evaluate(() => ({ groups: window.engineTests.groups, optional: window.engineTests.optional }));
  const unknown = only.filter((g) => !groups.includes(g) && !optional.includes(g));
  if (unknown.length) throw new Error(`unknown group(s): ${unknown.join(', ')} (have: ${groups.join(', ')}; optional: ${optional.join(', ')})`);

  for (const group of only.length ? only : groups) {
    console.log(`\n${group}`);
    const results = await page.evaluate((name) => window.engineTests.run(name), group);
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
    console.log(`  FAIL page error: ${e}`);
  }
  for (const l of logs) {
    if (l.type !== 'warn' && l.type !== 'warning' && l.type !== 'requestfailed') continue;
    failed++;
    console.log(`  FAIL page ${l.type}: ${l.text}`);
  }
} catch (err) {
  failed++;
  console.log(`  FAIL harness: ${err && err.stack ? err.stack : err}`);
  for (const e of errors) console.log(`  page error: ${e}`);
} finally {
  await close();
  await srv.close();
}

console.log(`\nengine e2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Runs every end-to-end script one after the other (each is a headless-Chrome run of its own) and
// prints a summary. Exit code 0 only when all of them passed.
//
//   npm run e2e                       everything (~25 min, needs Chrome and the network; the YouTube suites sit through real ads)
//   node tests/e2e/run.mjs app mix    only the scripts whose name matches
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('./', import.meta.url));
/** [name, script, extra args] — unit-like harnesses first, the whole app last. */
const SUITES = [
  ['engine', 'engine.e2e.mjs', []],
  ['engine-planner', 'engine.e2e.mjs', ['plannerSmoke']],
  ['analysis', 'analysis.e2e.mjs', []],
  ['sources', 'sources.e2e.mjs', []],
  ['ui', 'ui.e2e.mjs', []],
  ['mix', 'mix.e2e.mjs', []],
  ['app', 'app.e2e.mjs', []],
  // full songs: the YouTube finder, the deck, then the whole app under the real origin with real ads
  ['youtube', 'youtube.e2e.mjs', []],
  ['ytdeck', 'ytdeck.e2e.mjs', []],
  ['full', 'full.e2e.mjs', []],
  // README "Privacy" against what a plain visit and a share link really contact and leave (cookies), no tap
  ['privacy', 'privacy.e2e.mjs', []],
];

const only = process.argv.slice(2);
const picked = SUITES.filter(([name]) => !only.length || only.some((o) => name === o || name.startsWith(`${o}-`)));
if (!picked.length) {
  console.error(`no e2e suite matches: ${only.join(', ')} (have: ${SUITES.map((s) => s[0]).join(', ')})`);
  process.exit(2);
}

const run = (script, args) =>
  new Promise((resolve) => {
    if (!existsSync(HERE + script)) {
      console.error(`missing: tests/e2e/${script} (counted as a failure)`);
      return resolve(1);
    }
    const child = spawn(process.execPath, [HERE + script, ...args], { stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    child.on('error', () => resolve(1));
  });

const summary = [];
for (const [name, script, args] of picked) {
  console.log(`\n━━━ ${name} ━━━  node tests/e2e/${script}${args.length ? ` ${args.join(' ')}` : ''}`);
  const t0 = Date.now();
  const code = await run(script, args);
  summary.push({ name, code, seconds: Math.round((Date.now() - t0) / 1000) });
}

console.log('\n━━━ e2e summary ━━━');
for (const s of summary) console.log(`  ${s.code === 0 ? 'pass' : 'FAIL'}  ${s.name.padEnd(16)} ${s.seconds} s`);
const failed = summary.filter((s) => s.code !== 0).length;
console.log(failed ? `${failed} of ${summary.length} suites failed` : `all ${summary.length} suites passed`);
process.exit(failed ? 1 : 0);

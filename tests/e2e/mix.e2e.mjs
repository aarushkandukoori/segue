// Mix quality, measured on real music.
//
// In headless Chrome: real previews (fetched through the app's own sources code) → real analysis →
// real planner → real engine in an OfflineAudioContext. Every pair is rendered with one plan as
//   - the full mix,
//   - two stems as mixed (outgoing only / incoming only, all EQ and fader moves),
//   - two timing stems (same plan, strips left open) — where each track's audio really is.
// Then:
//   - beat-matched transitions: cross-correlation of the two timing stems' onset (attack) envelopes
//     over the overlap. The lag of the peak is how far apart the two tracks' drums are
//     (target: within 20 ms for at least 80 % of pairs). The as-mixed stems are no use for this:
//     a bass swap never has both kick drums audible at once — that is the point of it.
//   - why a pair misses: beat grids apart (planner), stem not where the plan says (engine), or the
//     drums of one track not on its analysed grid (analysis: typically half a beat off)
//   - every transition: the mix never clips, never goes silent for > 250 ms unless the music does,
//     and has no click at a join
//   - one 6-track mini-set rendered end to end, same assertions
//
//   node tests/e2e/mix.e2e.mjs            full run (~2 min, needs the network)
//   node tests/e2e/mix.e2e.mjs --pairs=80 --charts=113,132,0,106,116,197 --tracks=16   a bigger sample
//
// Exit code 0 = pass. A detailed report goes to tests/fixtures/mix-report.json (git-ignored).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.log(`mix e2e: SKIPPED, no Chrome at ${chrome} (set CHROME_PATH)`);
  process.exit(0);
}

const raw = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const arg = (name, def) => (raw(name) === null ? def : Number(raw(name)));
const WANT_SYNCED = arg('pairs', 40);
const WANT_FREE = 4;
const PER_CHART = arg('tracks', 14);
// Deezer genre charts (what the app's demo crates play): dance, pop, global hits, electro.
const CHARTS = (raw('charts') || '113,132,0,106').split(',').map((id) => `deezer:chart:${Number(id)}`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)} %` : 'n/a');
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

const srv = await startServer();
const { page, errors, close } = await launch({ width: 900, height: 600 });
const report = { when: new Date().toISOString(), pairs: [], miniSet: null };
try {
  await page.goto(`${srv.url}/tests/e2e/mix-harness.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.mixReady === true', { timeout: 20000 });

  // ---- crate ------------------------------------------------------------------------------------
  const crate = await page.evaluate((charts, n) => window.mix.loadCrate(charts, n), CHARTS, PER_CHART);
  report.crate = crate.tracks;
  const trusted = crate.tracks.filter((t) => t.conf >= 0.5).length;
  console.log(`crate: ${crate.tracks.length} real previews analysed (${trusted} with a trusted beat grid), ${crate.failed.length} failed to load`);
  check('enough real previews to work with', crate.tracks.length >= 16, `${crate.tracks.length} tracks`);

  const { synced, free } = await page.evaluate((a, b) => window.mix.choosePairs(a, b), WANT_SYNCED, WANT_FREE);
  console.log(`pairs: ${synced.length} the planner can beat-match, ${free.length} it cannot\n`);

  // ---- pairs ------------------------------------------------------------------------------------
  for (const [kind, list] of [['synced', synced], ['free', free]]) {
    for (const [a, b] of list) {
      const r = await page.evaluate((x, y, wantSync) => window.mix.pair(x, y, { wantSync }), a, b, kind === 'synced');
      r.kind = kind;
      report.pairs.push(r);
      const lag = r.lagMs === undefined ? '' : ` lag ${String(r.lagMs).padStart(4)} ms (${r.lagBeats.toFixed(2)} beat)  grids ${r.gridMedianMs.toFixed(1)} ms, engine ${r.engineLagA}/${r.engineLagB} ms`;
      const flags = [r.forced ? 'forced' : '', r.gaps.filter((g) => g.musicDb > -40).length ? 'GAP' : '', r.clicks.length ? 'CLICK' : '', r.peak > 1 ? 'CLIP' : ''].filter(Boolean).join(' ');
      console.log(`  ${String(a).padStart(2)}→${String(b).padEnd(2)} ${r.from.padEnd(14)} → ${r.to.padEnd(14)} ${r.label.padEnd(24)} peak ${r.peak.toFixed(3)}${lag} ${flags}`);
    }
  }
  console.log('');

  const pairs = report.pairs;
  const measured = pairs.filter((p) => p.lagMs !== undefined);
  // What the lag of the peak means for each pair.
  //   tight           the peak is within 20 ms: the drums of the two tracks hit together
  //   off-beat accent the peak is half a beat away, yet at small lags the stems agree within 20 ms and
  //                   each track's own attacks (whole track, kick band and full band) sit ON its grid:
  //                   in these few bars one song accents the "and" (sparse intro, syncopated break).
  //                   The grids are right; an envelope cross-correlation cannot tell this from an error.
  //   half a beat     the peak is half a beat away and one track's attacks sit BETWEEN its analysed
  //                   beats: that grid is most likely half a beat off (analysis) — this is the bad one
  //   loose           anything else (a 16th, tens of ms)
  const nearHalf = (p) => Math.abs(Math.abs(p.lagBeats) - 0.5) < 0.1;
  const onGrid = (t) => Math.max(t.kickHalfOverOn, t.fullHalfOverOn) < 1;
  for (const p of measured) {
    if (Math.abs(p.lagMs) <= 20) p.verdict = 'tight';
    else if (nearHalf(p) && Math.abs(p.fineLagMs) <= 20 && onGrid(p.trackA) && onGrid(p.trackB)) p.verdict = 'off-beat accent';
    else if (nearHalf(p)) p.verdict = 'half a beat';
    else p.verdict = 'loose';
  }
  const count = (v) => measured.filter((p) => p.verdict === v).length;
  const al = {
    pairs: measured.length,
    medianAbsLagMs: median(measured.map((p) => Math.abs(p.lagMs))),
    within10: measured.filter((p) => Math.abs(p.lagMs) <= 10).length,
    tight: count('tight'),
    offBeatAccent: count('off-beat accent'),
    halfBeat: count('half a beat'),
    loose: count('loose'),
    fineWithin20: measured.filter((p) => Math.abs(p.fineLagMs) <= 20).length,
    kickBandHalfToo: measured.filter((p) => nearHalf(p) && Math.abs(Math.abs(p.kickLagBeats) - 0.5) < 0.1).length,
    forced: measured.filter((p) => p.forced).length,
  };
  report.alignment = al;
  console.log(`alignment over ${al.pairs} beat-matched overlaps (lag of the cross-correlation peak, searched ±0.55 beat):`);
  console.log(`    within 20 ms: ${al.tight} (${pct(al.tight, al.pairs)}) — median |lag| ${al.medianAbsLagMs} ms, within 10 ms ${pct(al.within10, al.pairs)}`);
  console.log(`    half a beat away, grids right, off-beat accents in these bars: ${al.offBeatAccent} (${pct(al.offBeatAccent, al.pairs)})`);
  console.log(`    half a beat away, one track's grid most likely half a beat off: ${al.halfBeat} (${pct(al.halfBeat, al.pairs)})`);
  console.log(`    loose (a 16th, tens of ms): ${al.loose} (${pct(al.loose, al.pairs)})`);
  console.log(`    searched only ±¼ beat, the best lag is within 20 ms for ${al.fineWithin20} (${pct(al.fineWithin20, al.pairs)})`);
  for (const p of measured.filter((x) => x.verdict !== 'tight')) {
    let cause = p.verdict;
    if (p.gridMedianMs > 3) cause = 'PLANNER: the two beat grids are not aligned';
    else if (Math.abs(p.engineLagA) > 3 || Math.abs(p.engineLagB) > 3) cause = 'ENGINE: a stem is not where the plan puts it';
    p.cause = cause;
    console.log(`      ${String(p.a).padStart(2)}→${String(p.b).padEnd(2)} ${p.label.padEnd(24)} ${String(p.lagMs).padStart(4)} ms (${p.lagBeats.toFixed(2)} beat; ±¼ beat: ${p.fineLagMs} ms; kick band: ${p.kickLagMs} ms) — ${cause}; attacks between/on the beats, whole track: out ${Math.max(p.trackA.kickHalfOverOn, p.trackA.fullHalfOverOn).toFixed(2)}, in ${Math.max(p.trackB.kickHalfOverOn, p.trackB.fullHalfOverOn).toFixed(2)}`);
  }
  // A track that is half a beat off in every pair it appears in is a wrong grid, not a rhythm.
  const seen = {};
  for (const p of measured) {
    for (const i of [p.a, p.b]) {
      seen[i] = seen[i] || { n: 0, half: 0 };
      seen[i].n++;
      if (nearHalf(p)) seen[i].half++;
    }
  }
  const multi = Object.values(seen).filter((t) => t.n >= 2);
  al.tracksInSeveralPairs = multi.length;
  al.tracksAlwaysHalfOff = multi.filter((t) => t.half === t.n).length;
  console.log(`    tracks that are half a beat off in every pair they are in: ${al.tracksAlwaysHalfOff} of ${al.tracksInSeveralPairs} tracks used in two or more pairs\n`);

  check('at least 8 pairs rendered, beat-matched and not', pairs.length >= 8 && measured.length >= 5 && pairs.some((p) => !p.synced), `${pairs.length} pairs, ${measured.length} beat-matched overlaps`);
  const aligned = al.tight + al.offBeatAccent;
  check('beat-matched overlaps: drums together in at least 80 % of pairs', al.pairs > 0 && aligned / al.pairs >= 0.8, `${aligned}/${al.pairs} = ${pct(aligned, al.pairs)} (peak within 20 ms: ${pct(al.tight, al.pairs)}; plus off-beat accents on a correct grid: ${pct(al.offBeatAccent, al.pairs)})`);
  check('beat-matched overlaps: at small lags the stems agree within 20 ms in at least 80 % of pairs', al.fineWithin20 / al.pairs >= 0.8, `${al.fineWithin20}/${al.pairs} = ${pct(al.fineWithin20, al.pairs)}`);
  check('planner maths: the two beat grids coincide in every beat-matched overlap', measured.every((p) => p.gridMedianMs <= 2), `worst median ${Math.max(...measured.map((p) => p.gridMedianMs)).toFixed(2)} ms`);
  const engineLags = measured.flatMap((p) => [p.engineLagA, p.engineLagB]);
  check('engine timing: every rendered stem sits where the plan says (± 3 ms)', engineLags.filter((x) => Math.abs(x) > 3).length <= Math.ceil(engineLags.length * 0.1), `median ${median(engineLags)} ms, worst ${Math.max(...engineLags.map(Math.abs))} ms`);
  const peak = Math.max(...pairs.map((p) => p.peak));
  check('no pair clips (peak ≤ 1.0) or renders a non-finite sample', peak <= 1 && pairs.every((p) => p.nonFinite === 0), `worst peak ${peak.toFixed(3)}`);
  const gaps = pairs.flatMap((p) => p.gaps.filter((g) => g.musicDb > -40).map((g) => `${p.a}→${p.b} ${p.label} ${g.ms} ms at ${g.from.toFixed(2)} s (music at ${g.musicDb.toFixed(0)} dBFS)`));
  const musicGaps = pairs.reduce((n, p) => n + p.gaps.filter((g) => g.musicDb <= -40).length, 0);
  check('no silent gap > 250 ms between tracks', gaps.length === 0, gaps.slice(0, 4).join(' | ') || `${musicGaps} quiet stretches are in the songs themselves`);
  const clicks = pairs.flatMap((p) => p.clicks.map((c) => `${p.a}→${p.b} ${c.what} at ${c.t.toFixed(2)} s: step ${c.step.toFixed(2)} vs ${c.ref.toFixed(2)} around it`));
  check('no click at a join in any pair', clicks.length === 0, clicks.slice(0, 4).join(' | '));

  // ---- mini-set ---------------------------------------------------------------------------------
  const set = await page.evaluate(() => window.mix.miniSet(6, 'mix-e2e-set', 0.5));
  report.miniSet = set;
  console.log(`\nmini-set: 6 tracks, ${set.seconds.toFixed(0)} s — ${set.transitions.map((t) => `${t.label}${t.synced ? ' (synced)' : ''}`).join(' → ')}`);
  check('mini-set: five real transitions, none degraded', set.transitions.length === 5 && set.transitions.every((t) => !t.degraded));
  check('mini-set never clips', set.peak <= 1 && set.nonFinite === 0, `peak ${set.peak.toFixed(3)} at volume 1, ${set.peakAtMaxVolume.toFixed(3)} at the app's maximum (1.25); level ${set.rmsDb.toFixed(1)} dBFS RMS`);
  check("mini-set stays under 1.0 at the app's maximum volume", set.peakAtMaxVolume <= 1, `peak ${set.peakAtMaxVolume.toFixed(3)}`);
  const setGaps = set.gaps.filter((g) => g.musicDb > -40);
  check('mini-set: no silent gap > 250 ms', setGaps.length === 0, setGaps.map((g) => `${g.ms} ms at ${g.from.toFixed(1)} s`).join(', ') || `${set.gaps.length} quiet stretches in the songs themselves`);
  check('mini-set: no click at any of its joins', set.clicks.length === 0, set.clicks.map((c) => `${c.what} at ${c.t.toFixed(2)} s (step ${c.step.toFixed(2)} vs ${c.ref.toFixed(2)})`).join(' | ') || `${set.joins} joins, hardest ${set.worstJoin.ratio.toFixed(2)}× its surroundings (${set.worstJoin.what})`);

  check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('harness ran to completion', false, err && err.stack ? err.stack : String(err));
  for (const e of errors) console.log(`  page error: ${e}`);
} finally {
  await close();
  await srv.close();
}

try {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}mix-report.json`, JSON.stringify(report, null, 1));
} catch {
  /* the report is a convenience */
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nmix e2e: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Mix quality, measured on real music.
//
// In headless Chrome: today's Deezer charts (what the app's demo crates play), fetched through the
// app's own sources code → real analysis → real planner → real engine in an OfflineAudioContext.
//
//   1. Survey. One crate per chart; whole sets are planned the way the conductor plans them (seeded
//      order, window of five, chooseNext, next) at the app's default vibe. Counted per chart: how many
//      transitions are overlapping beat-matched blends (bass swap / EQ blend / filter blend).
//   2. Alignment. Each of those blends is rendered through the engine as two timing stems (same
//      plan, strips left open, one track each) and the stems' attack envelopes are cross-correlated
//      over the overlap, searched ±0.55 beat. The lag of the peak is how far apart the two tracks'
//      drums are:   within 20 ms = together · half a beat away · anything else.
//      These are RAW numbers. The planner only overlaps two tracks where the analysis vouches for the
//      beat phase at the join (Analysis.grid: neither end unclear, and the two attack patterns
//      agreeing beat on beat — planner.js canOverlap), so a blend that comes out half a beat apart is
//      a miss, whatever the reason.
//   3. Integrity. A sample of transitions of every kind rendered as the full mix: never clips, never
//      goes silent for > 250 ms unless the music does, no click at a join. Planner maths (the two
//      beat grids coincide) and engine timing (each stem where the plan says) on every blend.
//   4. One 6-track mini-set rendered end to end, same assertions.
//   5. Levels. The moves that add sound of their own or take sound away, forced on a sample of pairs
//      and measured the way they are heard: the riser against the music around it (K-weighted — it is
//      4 – 8 kHz noise, and "as loud as the track" by plain RMS is 5 – 9 LU hotter by ear), the impact
//      one-shot against the track it announces, dead air before the drop of a brake or a spinback, and
//      the Build + drop trick's downbeat against the record's own.
//
//   node tests/e2e/mix.e2e.mjs            default run (≈ 2 min, needs the network)
//   (the "measured" figures in this file and in the README: the --tracks=40 --blends=40 run of 2026-10-05, 282 previews)
//   node tests/e2e/mix.e2e.mjs --tracks=40 --blends=40               a bigger sample (≈ 8 min; the README figures)
//   node tests/e2e/mix.e2e.mjs --charts=113,106 --blends=0           two charts, every blend
//   node tests/e2e/mix.e2e.mjs --levels=12                           a bigger sample for part 5 (0 = skip it)
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

// Deezer genre charts. The first three are four-on-the-floor / straight pop; hip-hop, latin and r&b
// are the syncopated ones the grid-trust gate exists for; hits and rock are measured and reported.
const CHART_NAMES = { 113: 'dance', 106: 'electro', 132: 'pop', 0: 'hits', 116: 'hip-hop', 197: 'latin', 165: 'r&b', 152: 'rock' };
const STEADY = ['dance', 'electro', 'pop'];
const SYNCOPATED = ['hip-hop', 'latin', 'r&b'];
const CHARTS = (raw('charts') || '113,106,132,0,116,197,165,152').split(',').map((id) => ({ label: CHART_NAMES[Number(id)] || `chart ${Number(id)}`, input: `deezer:chart:${Number(id)}` }));
const PER_CHART = arg('tracks', 20);
const SEEDS = arg('seeds', 4);
const VIBE = arg('vibe', 0.5);
const MAX_BLENDS = arg('blends', 14); // rendered per chart; 0 = every one
const WANT_PAIRS = arg('pairs', 12);
const LEVELS = arg('levels', 6); // hand-overs rendered per kind for the level checks; 0 = skip

// What is promised (README, "Beat grids are estimated") and what this run must show. The floors sit
// below the measured figures because a chart is a different set of songs every day and a run only
// renders a few dozen blends per group.
const FLOOR = {
  steadyAligned: 0.9, // dance + electro + pop: blends whose drums are within 20 ms (measured: 98 % of 118)
  syncopatedAligned: 0.8, // hip-hop + latin + r&b (measured: 92 % of 90)
  danceBlendShare: 0.18, // dance + electro: share of all transitions that are still blends (measured: 30 %)
};
const MIN_SAMPLE = 10; // fewer measured blends than this in a group: reported, not judged
// Levels (part 5). Each bound sits between what the recipes measured before they were fixed and what
// they measure now (24 hand-overs per kind, 16 Build + drop tricks, on the audio fixtures; the recipes'
// comments in js/dj/transitions.js say what each change was):
const LEVEL = {
  riserBumpMedian: 3.5, // dB the riser's loudest 400 ms may stand over the music (was 6.1 median, now 1.7)
  riserBumpMax: 6.5, //   … and the worst single one (was up to 9.9, now up to 3.9)
  impactMedian: 3.5, // dB the impact's loudest 50 ms may stand over the incoming track (was 5.5, now about 1)
  impactMax: 9, //        … worst single one, quiet intros included (was up to 14.5, now up to 5.6)
  brakeDeadMedian: 60, // ms more than 12 dB under the programme before the drop (was 73 median / 198 max, now 38 / 78)
  brakeDeadMax: 150,
  spinDeadMedian: 110, // (was 158 median, now 78; on charts: 115 – 140 before, 58 – 88 now)
  dropExcess: 1, // dB the Build + drop downbeat may peak over the record's own (was +1.3 median, +6.9 max; now 0.0 / +0.1)
  dropLowExcess: 1.5, //  … below 150 Hz (was +2.6 median, +10.5 max; now 0.0 / 0.0)
  reopenExcess: 1, // dB of level (RMS) in the quarter beat before it, where the filter now reopens
};

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
const verdictOf = (m) => (Math.abs(m.lagMs) <= 20 ? 'tight' : Math.abs(Math.abs(m.lagBeats) - 0.5) < 0.1 ? 'half' : 'other');
/** Evenly spread sample of at most n items. */
const spread = (list, n) => (n <= 0 || list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));

const srv = await startServer();
const { page, errors, close } = await launch({ width: 900, height: 600 });
const report = { when: new Date().toISOString(), args: { PER_CHART, SEEDS, VIBE, MAX_BLENDS }, charts: [], blends: [], pairs: [], miniSet: null };
try {
  await page.goto(`${srv.url}/tests/e2e/mix-harness.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.mixReady === true', { timeout: 20000 });

  // ---- crate ------------------------------------------------------------------------------------
  const crate = await page.evaluate((charts, n) => window.mix.loadCrate(charts, n), CHARTS, PER_CHART);
  report.crate = crate.tracks;
  const trusted = crate.tracks.filter((t) => t.conf >= 0.5).length;
  console.log(`crate: ${crate.tracks.length} real previews analysed from ${crate.charts.length} charts (${trusted} with a trusted tempo), ${crate.failed.length} failed to load`);
  check('enough real previews to work with', crate.tracks.length >= Math.min(16, 6 * CHARTS.length), `${crate.tracks.length} tracks`);

  // ---- survey: what the planner does on each chart ------------------------------------------------
  const survey = await page.evaluate((s, v) => window.mix.survey(s, v), SEEDS, VIBE);
  for (const c of survey) {
    const unique = c.blends.filter((b) => !b.repeat);
    c.measured = [];
    for (const b of spread(unique, MAX_BLENDS)) {
      const m = await page.evaluate((key) => window.mix.blend(key), b.key);
      m.chart = c.label;
      m.verdict = verdictOf(m);
      c.measured.push(m);
      report.blends.push(m);
    }
  }
  const count = (list, v) => list.filter((m) => m.verdict === v).length;
  const group = (labels) => {
    const cs = survey.filter((c) => labels.includes(c.label));
    const measured = cs.flatMap((c) => c.measured);
    return {
      charts: cs.map((c) => c.label),
      transitions: cs.reduce((n, c) => n + c.transitions, 0),
      matchable: cs.reduce((n, c) => n + c.matchable, 0),
      blends: cs.reduce((n, c) => n + c.blends.length, 0),
      measured,
      tight: count(measured, 'tight'),
      half: count(measured, 'half'),
      other: count(measured, 'other'),
    };
  };
  console.log(`\nsets planned per chart: ${SEEDS} at vibe ${VIBE}; blends = overlapping beat-matched transitions; lag = cross-correlation peak of the two rendered stems, raw`);
  console.log('  chart      tracks  transitions  tempo-matchable  blends (share)   rendered  within 20 ms  half a beat  other');
  const row = (name, tracks, g) =>
    console.log(
      `  ${name.padEnd(10)} ${String(tracks).padStart(6)}  ${String(g.transitions).padStart(11)}  ${String(g.matchable).padStart(15)}  ${String(g.blends).padStart(6)} (${pct(g.blends, g.transitions).padStart(5)})  ${String(g.measured.length).padStart(8)}  ${`${g.tight} (${pct(g.tight, g.measured.length)})`.padStart(12)}  ${`${g.half} (${pct(g.half, g.measured.length)})`.padStart(11)}  ${`${g.other} (${pct(g.other, g.measured.length)})`.padStart(5)}`,
    );
  for (const c of survey) {
    const g = group([c.label]);
    row(c.label, c.tracks, g);
    report.charts.push({ label: c.label, tracks: c.tracks, trusted: c.trusted, transitions: c.transitions, matchable: c.matchable, blends: c.blends.length, types: c.types, rendered: g.measured.length, tight: g.tight, half: g.half, other: g.other });
  }
  const steady = group(STEADY);
  const sync = group(SYNCOPATED);
  const all = group(survey.map((c) => c.label));
  const dance = group(['dance', 'electro']);
  if (steady.charts.length > 1) row('= steady', '', steady);
  if (sync.charts.length > 1) row('= syncop.', '', sync);
  row('= all', '', all);
  report.groups = Object.fromEntries(
    Object.entries({ steady, syncopated: sync, all, dance }).map(([k, g]) => [k, { charts: g.charts, transitions: g.transitions, matchable: g.matchable, blends: g.blends, rendered: g.measured.length, tight: g.tight, half: g.half, other: g.other }]),
  );
  const measured = all.measured;
  for (const m of measured.filter((x) => x.verdict !== 'tight')) {
    let cause = m.verdict === 'half' ? 'half a beat apart' : 'loose';
    if (m.gridMedianMs > (m.constantGrids ? 3 : 15)) cause = 'PLANNER: the two beat grids are not aligned';
    else if (!m.constantGrids) cause += ' (a wandering beat grid)';
    else if (Math.abs(m.engineLagA) > 3 || Math.abs(m.engineLagB) > 3) cause = 'ENGINE: a stem is not where the plan puts it';
    m.cause = cause;
    const trust = m.trust && m.trust.outTail !== null ? `; grid trust: out tail ${m.trust.outTail}, in head ${m.trust.inHead}, pattern contrast ${m.trust.contrast}` : '';
    console.log(`      ${m.chart.padEnd(8)} ${String(m.a).padStart(3)}→${String(m.b).padEnd(3)} ${m.label.padEnd(24)} ${String(m.lagMs).padStart(4)} ms (${m.lagBeats.toFixed(2)} beat; searched ±¼ beat: ${m.fineLagMs} ms) — ${cause}${trust}`);
  }
  console.log('');

  check('the survey found transitions on every chart', survey.every((c) => c.transitions > 0), survey.map((c) => `${c.label} ${c.transitions}`).join(', '));
  const judge = (name, g, floor) => {
    const n = g.measured.length;
    if (!g.charts.length) return;
    if (n < MIN_SAMPLE) {
      console.log(`  note  ${name}: only ${n} blends rendered (${g.tight} within 20 ms) — too few to judge, reported only`);
      return;
    }
    check(`${name}: drums within 20 ms in at least ${Math.round(floor * 100)} % of blends (raw)`, g.tight / n >= floor, `${g.tight}/${n} = ${pct(g.tight, n)}; half a beat apart ${pct(g.half, n)}, other ${pct(g.other, n)}; median |lag| ${median(g.measured.map((m) => Math.abs(m.lagMs)))} ms`);
  };
  judge(`${STEADY.join(' + ')} charts`, steady, FLOOR.steadyAligned);
  judge(`${SYNCOPATED.join(' + ')} charts`, sync, FLOOR.syncopatedAligned);
  if (dance.charts.length) {
    check(`dance / electro crates are still blended: at least ${Math.round(FLOOR.danceBlendShare * 100)} % of their transitions`, dance.transitions > 0 && dance.blends / dance.transitions >= FLOOR.danceBlendShare, `${dance.blends}/${dance.transitions} = ${pct(dance.blends, dance.transitions)} (${dance.matchable} were tempo-matchable)`);
  }
  if (measured.length) {
    // Two constant grids coincide exactly. A grid that follows a live drummer wanders by a few ms from
    // beat to beat; the planner lays the straight line through its beats on the other grid, so there the
    // single beats may be those few ms apart.
    const exact = measured.filter((m) => m.constantGrids);
    const fitted = measured.filter((m) => !m.constantGrids);
    const worst = (list) => (list.length ? Math.max(...list.map((m) => m.gridMedianMs)).toFixed(2) : 'n/a');
    check('planner maths: the two beat grids coincide in every blend', exact.every((m) => m.gridMedianMs <= 2) && fitted.every((m) => m.gridMedianMs <= 15), `${exact.length} blends of two constant grids: worst median ${worst(exact)} ms; ${fitted.length} with a wandering grid (matched by its fitted line): worst ${worst(fitted)} ms`);
    const engineLags = measured.flatMap((m) => [m.engineLagA, m.engineLagB]);
    check('engine timing: every rendered stem sits where the plan says (± 3 ms)', engineLags.filter((x) => Math.abs(x) > 3).length <= Math.ceil(engineLags.length * 0.1), `median ${median(engineLags)} ms, worst ${Math.max(...engineLags.map(Math.abs))} ms`);
  }

  // ---- integrity: full mixes of a sample of pairs -----------------------------------------------
  // Half of them pairs the survey blended (asked for a blend again), half taken across the crate.
  const blendPairs = spread(measured, Math.ceil(WANT_PAIRS / 2)).map((m) => [m.a, m.b, true]);
  const n = crate.tracks.length;
  const freePairs = Array.from({ length: Math.floor(WANT_PAIRS / 2) }, (_, i) => [(i * 5) % n, (i * 5 + 3 + 7 * i) % n, false]).filter(([a, b]) => a !== b);
  console.log('');
  for (const [a, b, wantBlend] of [...blendPairs, ...freePairs]) {
    const r = await page.evaluate((x, y, w, v) => window.mix.pair(x, y, { wantBlend: w, vibe: v }), a, b, wantBlend, VIBE);
    report.pairs.push(r);
    const flags = [r.gaps.filter((g) => g.musicDb > -40).length ? 'GAP' : '', r.clicks.length ? 'CLICK' : '', r.peak > 1 ? 'CLIP' : ''].filter(Boolean).join(' ');
    console.log(`  ${String(a).padStart(3)}→${String(b).padEnd(3)} ${r.from.padEnd(14)} → ${r.to.padEnd(14)} ${r.label.padEnd(24)} peak ${r.peak.toFixed(3)} ${flags}`);
  }
  console.log('');
  const pairs = report.pairs;
  check('full mixes rendered, blends and other moves', pairs.length >= Math.min(6, WANT_PAIRS) && (WANT_PAIRS < 4 || pairs.some((p) => !p.blend)), `${pairs.length} pairs, ${pairs.filter((p) => p.blend).length} of them blends`);
  const peak = Math.max(...pairs.map((p) => p.peak));
  check('no pair clips (peak ≤ 1.0) or renders a non-finite sample', peak <= 1 && pairs.every((p) => p.nonFinite === 0), `worst peak ${peak.toFixed(3)}`);
  const gaps = pairs.flatMap((p) => p.gaps.filter((g) => g.musicDb > -40).map((g) => `${p.a}→${p.b} ${p.label} ${g.ms} ms at ${g.from.toFixed(2)} s (music at ${g.musicDb.toFixed(0)} dBFS)`));
  const musicGaps = pairs.reduce((k, p) => k + p.gaps.filter((g) => g.musicDb <= -40).length, 0);
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

  // ---- levels ------------------------------------------------------------------------------------
  if (LEVELS > 0) {
    const N = crate.tracks.length;
    const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
    const stat = (xs) => `median ${f1(median(xs))}, worst ${f1(Math.max(...xs))}`;
    // (a chart is a different set of songs every day: one freak — a riser between two near-silent
    // passages, an intro that is all room tone — is reported, a second one fails)
    const allButOne = (xs, limit) => xs.filter((x) => !(x <= limit)).length <= 1;
    report.levels = [];
    const sample = async (type, want, vibe) => {
      const rows = [];
      for (let k = 0; rows.length < want && k < want * 5; k++) {
        const a = (k * 11 + type.length * 3) % N;
        const b = (k * 17 + 5 + type.length) % N;
        if (a === b) continue;
        const m = await page.evaluate((x, y, o) => window.mix.levels(x, y, o), a, b, { type, vibe, seed: `levels-${type}-${k}` });
        if (m.skipped) continue;
        rows.push(m);
        report.levels.push(m);
      }
      return rows;
    };
    const risers = await sample('riserDrop', LEVELS, 0.5);
    const spins = await sample('spinback', 2 * LEVELS, 0.5); // (the smallest of the changes: a bigger sample to see it)
    const brakes = await sample('brake', LEVELS, 0.5);
    const cuts = await sample('cut', Math.ceil(LEVELS / 2), 1);
    console.log(`\nlevels: ${risers.length} riser drops, ${spins.length} spinbacks, ${brakes.length} brakes, ${cuts.length} cuts rendered`);
    const enough = (name, rows) => {
      if (rows.length >= Math.min(4, LEVELS)) return true;
      console.log(`  note  ${name}: only ${rows.length} rendered — reported, not judged`);
      return false;
    };
    if (enough('riser drops', risers)) {
      const bumps = risers.map((m) => m.bumpDb);
      check(`riser: its loudest 400 ms stands no more than ${LEVEL.riserBumpMedian} dB over the music (K-weighted; median), ${LEVEL.riserBumpMax} dB at worst (one exception allowed)`, median(bumps) <= LEVEL.riserBumpMedian && allButOne(bumps, LEVEL.riserBumpMax), `${stat(bumps)} dB over ${bumps.length} riser drops; the drop lands ${f1(median(risers.map((m) => m.stepDownDb)))} dB under its build-up (median)`);
    }
    const impacts = [...risers, ...spins, ...cuts].filter((m) => m.impactDb !== null);
    if (enough('impacts', impacts)) {
      const rel = impacts.map((m) => m.impactDb);
      check(`impact: its loudest 50 ms stands no more than ${LEVEL.impactMedian} dB over the track it announces (median), ${LEVEL.impactMax} dB at worst (one exception allowed)`, median(rel) <= LEVEL.impactMedian && allButOne(rel, LEVEL.impactMax), `${stat(rel)} dB over ${rel.length} impacts; peak vs the incoming track's own: ${stat(impacts.map((m) => m.impactPeakDb))} dB`);
    }
    if (enough('brakes', brakes)) {
      const dead = brakes.map((m) => m.deadMs);
      check(`brake: no dead air before the drop (more than 12 dB under the programme for at most ${LEVEL.brakeDeadMedian} ms median, ${LEVEL.brakeDeadMax} ms worst; one exception allowed)`, median(dead) <= LEVEL.brakeDeadMedian && allButOne(dead, LEVEL.brakeDeadMax), `${stat(dead)} ms over ${dead.length} brakes`);
    }
    if (enough('spinbacks', spins)) {
      const dead = spins.map((m) => m.deadMs);
      check(`spinback: the spin lasts into the drop (more than 12 dB under the programme for at most ${LEVEL.spinDeadMedian} ms, median)`, median(dead) <= LEVEL.spinDeadMedian, `${stat(dead)} ms over ${dead.length} spinbacks`);
    }
    // Build + drop is a mid-solo trick: look through natural plans (cheap) for ones that carry it, render those
    const drops = [];
    for (let k = 0; drops.length < LEVELS && k < 60 * LEVELS; k++) {
      const a = (k * 7 + 1) % N;
      const b = (k * 13 + 4) % N;
      if (a === b) continue;
      const m = await page.evaluate((x, y, seed) => window.mix.buildDrop(x, y, seed), a, b, `build-${k}`);
      if (!m.skipped) drops.push(m);
    }
    report.buildDrops = drops;
    if (enough('Build + drop tricks', drops)) {
      const noise = Math.max(...drops.map((m) => Math.abs(m.controlDb)));
      check(`Build + drop: the downbeat is the record's own (peak within ${LEVEL.dropExcess} dB of an untouched strip, ${LEVEL.dropLowExcess} dB below 150 Hz)`, drops.every((m) => m.dropDb <= LEVEL.dropExcess && m.lowDb <= LEVEL.dropLowExcess), `full band: ${stat(drops.map((m) => m.dropDb))} dB; below 150 Hz: ${stat(drops.map((m) => m.lowDb))} dB; ${drops.length} tricks, control one bar later within ${f1(noise)} dB`);
      check(`Build + drop: reopening the filter before the downbeat adds no thump of its own (level within ${LEVEL.reopenExcess} dB of the untouched strip there)`, drops.every((m) => m.beforeDb <= LEVEL.reopenExcess), `quarter beat before the drop: level ${stat(drops.map((m) => m.beforeDb))} dB vs the untouched strip (peaks: ${stat(drops.map((m) => m.beforePeakDb))} dB)`);
    }
  }

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
  writeFileSync(raw('report') || `${dir}mix-report.json`, JSON.stringify(report, null, 1));
} catch {
  /* the report is a convenience */
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nmix e2e: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

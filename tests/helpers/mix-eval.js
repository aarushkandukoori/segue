// Mix alignment on REAL previews, in plan space (no browser, no network).
//
// tests/e2e/mix.e2e.mjs measures the same thing through the real engine in headless Chrome on today's
// charts; this is its offline twin on the audio fixtures (tests/fixtures/analysis, fetched by
// tests/tools/fetch-fixtures.mjs), fast enough to iterate on and to calibrate against:
//
//   fixtures → analyzeTrack → planner (sets planned the way the conductor plans them, one crate per
//   genre) → for every overlapping beat-matched blend the two tracks' attack envelopes are read in set
//   time through the plan (timeline.positionAt) and cross-correlated over the overlap, ±0.55 beat.
//   The lag of the peak is how far apart the two tracks' drums are.
//
// (The engine puts every stem within 1 ms of where the plan says — tests/e2e/mix.e2e.mjs checks that —
// so plan space and rendered audio agree.)
//
//   node tests/helpers/mix-eval.js                 # per-genre table: blend share, alignment of the blends
//   node tests/helpers/mix-eval.js --seeds=8 --vibe=0.5
//   node tests/helpers/mix-eval.js --calibrate     # + how well Analysis.grid predicts each blend edge
//   node tests/helpers/mix-eval.js --json=out.json # every measured blend, for further digging
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { loadFixtures, loadSamples, FIXTURE_DIR } from './analysis-eval.js';
import { analyzeTrack } from '../../js/analysis/analyze.js';
import { createPlanner } from '../../js/dj/planner.js';
import { positionAt } from '../../js/dj/timeline.js';

export const BLENDS = ['bassSwap', 'eqBlend', 'filterBlend'];
/** Crates, in report order: the fixture genres (Deezer chart genres + the hand list filed under them). */
export const GENRES = ['dance', 'electro', 'pop', 'all', 'rap', 'latin', 'rnb', 'rock'];
export const GENRE_LABEL = { dance: 'dance', electro: 'electro', pop: 'pop', all: 'hits (all genres)', rap: 'hip-hop', latin: 'latin', rnb: 'r&b', rock: 'rock' };
/** The two groups the product makes a promise about. */
export const GROUPS = { steady: ['dance', 'electro', 'pop'], syncopated: ['rap', 'latin', 'rnb'] };

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Attack envelope at 1 kHz, linear in amplitude (a kick counts for more than a hi-hat): rise of the
 * 10 ms RMS over 10 ms, half-wave rectified. Same definition as tests/e2e/mix/harness.js.
 * @param {Float32Array} x mono PCM
 * @param {number} sr
 */
export function attackEnvelope(x, sr) {
  const n = Math.floor((x.length / sr) * 1000);
  const win = Math.round(0.01 * sr);
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  const amp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.min(x.length, Math.round((i / 1000) * sr));
    const a = Math.max(0, c - win);
    amp[i] = Math.sqrt((cum[c] - cum[a]) / win);
  }
  const d = new Float32Array(n);
  for (let i = 10; i < n; i++) d[i] = Math.max(0, amp[i] - amp[i - 10]);
  return d;
}

/** Envelope of a raw track as the plan says it is heard: read through positionAt over [t0, t1), 1 kHz. */
export function planEnvelope(rawEnv, play, t0, t1) {
  const n = Math.max(0, Math.floor((t1 - t0) * 1000));
  const out = new Float32Array(n);
  const p = { ...play, endAt: null };
  for (let i = 0; i < n; i++) {
    const f = positionAt(p, t0 + i / 1000) * 1000;
    const k = Math.floor(f);
    if (k >= 0 && k + 1 < rawEnv.length) out[i] = rawEnv[k] + (rawEnv[k + 1] - rawEnv[k]) * (f - k);
  }
  return out;
}

/** Lag (ms) at which b best matches a, searched within ±maxLag ms. Positive = b is late. */
export function bestLag(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  let best = -Infinity;
  let bestAt = 0;
  let atZero = 0;
  let na = 0;
  for (let k = maxLag; k < n - maxLag; k++) na += a[k] * a[k];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let nb = 0;
    for (let k = maxLag; k < n - maxLag; k++) {
      const v = b[k + lag];
      dot += a[k] * v;
      nb += v * v;
    }
    const c = dot / Math.sqrt(na * nb + 1e-20);
    if (lag === 0) atZero = c;
    if (c > best) {
      best = c;
      bestAt = lag;
    }
  }
  return { lag: bestAt, peak: best, atZero };
}

/** 'tight' = peak within 20 ms · 'half' = half a beat away (±0.1 beat) · 'other' = anything else. */
export function verdictOf(lagMs, lagBeats) {
  if (Math.abs(lagMs) <= 20) return 'tight';
  if (Math.abs(Math.abs(lagBeats) - 0.5) < 0.1) return 'half';
  return 'other';
}

/**
 * Raw alignment of one planned transition: cross-correlation of the two tracks' attack envelopes over
 * the overlap, as the plan plays them.
 * @returns {{lagMs:number, lagBeats:number, verdict:'tight'|'half'|'other', peak:number, atZero:number}}
 */
export function blendAlignment(tr, outPlay, envA, envB) {
  const beatSec = (tr.tEnd - tr.tStart) / tr.beats;
  const wide = Math.round(0.55 * beatSec * 1000);
  const pad = wide / 1000 + 0.03;
  const t0 = tr.tStart - pad;
  const t1 = tr.tEnd + pad;
  const a = planEnvelope(envA, outPlay, t0, t1);
  const b = planEnvelope(envB, tr.play, t0, t1);
  const m = bestLag(a, b, wide);
  const lagBeats = m.lag / 1000 / beatSec;
  return { lagMs: m.lag, lagBeats, verdict: verdictOf(m.lag, lagBeats), peak: m.peak, atZero: m.atZero };
}

// ── fixtures → analysed crate ──────────────────────────────────────────────────────────────────

/** Hash of the analysis sources: analyses are cached on disk per version of the code that made them. */
function analysisHash() {
  const dir = fileURLToPath(new URL('../../js/analysis/', import.meta.url));
  const h = createHash('sha1');
  for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest('hex').slice(0, 12);
}

/**
 * Every fixture, analysed with its attack envelope. No bpmHint by default: the app has none either
 * (Deezer's chart, playlist and search responses carry no tempo).
 * @param {{cache?: boolean, envelopes?: boolean, samples?: boolean, hint?: boolean}} [o]
 * @returns {null | {id:string, artist:string, title:string, genre:string, source:string, analysis:object, env:Float32Array|null, samples?:Float32Array, sampleRate:number}[]}
 */
export function loadCrate(o = {}) {
  const tracks = loadFixtures();
  if (!tracks) return null;
  const cacheDir = resolve(FIXTURE_DIR, '..', 'mix-eval-cache');
  const cacheFile = join(cacheDir, `${analysisHash()}${o.hint ? '-hint' : ''}.json`);
  let cached = {};
  if (o.cache !== false && existsSync(cacheFile)) {
    try {
      cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      cached = {};
    }
  }
  let dirty = false;
  const out = [];
  for (const t of tracks) {
    const { samples, sampleRate } = loadSamples(t);
    let analysis = cached[t.id];
    // (JSON has no typed arrays: the slot pattern is cached as a plain array)
    if (analysis && analysis.grid && Array.isArray(analysis.grid.slots)) analysis.grid.slots = Uint8Array.from(analysis.grid.slots);
    if (!analysis) {
      const full = analyzeTrack(samples, sampleRate, o.hint && t.deezerBpm > 0 ? { bpmHint: t.deezerBpm } : {});
      analysis = { ...full, wave: undefined, energyCurve: undefined };
      cached[t.id] = analysis;
      dirty = true;
    }
    out.push({
      id: `deezer:${t.id}`,
      artist: String(t.artist ?? ''),
      title: String(t.title ?? ''),
      genre: t.genre,
      source: t.source,
      analysis,
      env: o.envelopes === false ? null : attackEnvelope(samples, sampleRate),
      samples: o.samples ? samples : undefined,
      sampleRate,
    });
  }
  if (dirty && o.cache !== false) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      // one file per version of the analysis code: the older ones are of no use any more
      for (const f of readdirSync(cacheDir)) if (f.endsWith('.json') && join(cacheDir, f) !== cacheFile) unlinkSync(join(cacheDir, f));
      writeFileSync(cacheFile, JSON.stringify(cached, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v)));
    } catch {
      /* the cache is a convenience */
    }
  }
  return out;
}

// ── sets, the way the conductor plans them ─────────────────────────────────────────────────────

/**
 * One pass through a crate: seeded base order, window of 5 (3 for the opener), chooseNext, each mix
 * planned at the start of the outgoing track's solo.
 * @returns {{tr:object, from:object, to:object, outPlay:object}[]} one record per track-to-track transition
 */
export function planSet(crate, seed, vibe = 0.5, count = crate.length) {
  const planner = createPlanner({ seed, vibe, mode: 'preview' });
  const byId = new Map(crate.map((t) => [t.id, t]));
  const queue = planner.order(crate.map((t) => t.id));
  const cand = (t) => ({ id: t.id, artist: t.artist, analysis: t.analysis });
  const out = [];
  const recent = [];
  let cur = null;
  let prevPlay = null;
  for (let n = 0; n < count && queue.length; n++) {
    const win = queue.slice(0, n === 0 ? 3 : 5).map((id) => byId.get(id));
    const k = planner.chooseNext(cur ? cand(cur) : null, win.map(cand), { playIndex: n, recentArtists: recent.slice(-3) });
    const track = win[k];
    queue.splice(queue.indexOf(track.id), 1);
    let tr;
    if (!cur) tr = planner.first({ id: track.id, analysis: track.analysis }, { startAt: 0 });
    else {
      tr = planner.next({ play: prevPlay, analysis: cur.analysis }, { id: track.id, analysis: track.analysis }, { earliest: prevPlay.soloFrom });
      const outPlay = { ...prevPlay, events: prevPlay.events.concat(tr.aEvents), rate: prevPlay.rate.concat(tr.aRate), endAt: null };
      out.push({ tr, from: cur, to: track, outPlay });
    }
    prevPlay = { ...tr.play, events: tr.play.events.slice(), rate: tr.play.rate.slice() };
    cur = track;
    recent.push(track.artist);
  }
  return out;
}

export const isBlend = (tr) => !!tr.synced && BLENDS.includes(tr.type) && tr.beats > 0;

/** Buffer-position window [from, to] (s) each track contributes to a blend: outgoing tail, incoming head. */
export function blendWindows(rec) {
  const { tr, outPlay } = rec;
  const pb = { ...tr.play, endAt: null };
  return {
    out: [positionAt(outPlay, tr.tStart), positionAt(outPlay, tr.tEnd)],
    in: [positionAt(pb, tr.tStart), positionAt(pb, tr.tEnd)],
  };
}

/**
 * Sets over one crate with several seeds; every overlapping beat-matched blend is measured once
 * (the same two tracks blended over the same number of beats again say nothing new about alignment).
 * `matchable` counts the transitions whose two tracks have trusted tempos inside the tempo window: the
 * blend candidates before any grid-trust gate.
 * @returns {{transitions:number, matchable:number, types:Record<string,number>, blendCount:number, blends:object[]}}
 */
export function surveyCrate(crate, { seeds = 6, vibe = 0.5, tag = 'eval' } = {}) {
  const types = {};
  const blends = [];
  const seen = new Set();
  let transitions = 0;
  let matchable = 0;
  let blendCount = 0;
  const foldR = (r) => {
    while (r >= Math.SQRT2) r /= 2;
    while (r < Math.SQRT1_2) r *= 2;
    return r;
  };
  for (let s = 0; s < seeds; s++) {
    for (const rec of planSet(crate, `${tag}-${s}`, vibe)) {
      transitions++;
      types[rec.tr.type] = (types[rec.tr.type] || 0) + 1;
      const A = rec.from.analysis;
      const B = rec.to.analysis;
      if (Math.min(A.bpmConfidence, B.bpmConfidence) >= 0.5 && Math.abs(foldR(B.bpm / A.bpm) - 1) <= 0.08) matchable++;
      if (!isBlend(rec.tr)) continue;
      blendCount++;
      const same = `${rec.from.id}>${rec.to.id}:${rec.tr.beats}`;
      if (seen.has(same)) continue;
      seen.add(same);
      const m = blendAlignment(rec.tr, rec.outPlay, rec.from.env, rec.to.env);
      const w = blendWindows(rec);
      blends.push({ seed: s, a: rec.from.id, b: rec.to.id, type: rec.tr.type, beats: rec.tr.beats, rate: rec.tr.play.rate[0].v, outWin: w.out, inWin: w.in, ...m });
    }
  }
  return { transitions, matchable, types, blendCount, blends };
}

export function tally(blends) {
  const n = blends.length;
  const c = (v) => blends.filter((b) => b.verdict === v).length;
  return { n, tight: c('tight'), half: c('half'), other: c('other'), medianAbsLagMs: median(blends.map((b) => Math.abs(b.lagMs))) };
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');

/** The per-genre table as text. */
export function formatSurvey(byGenre) {
  const lines = [];
  lines.push('crate              tracks  transitions  matchable  blends (share)  measured  within 20 ms   half a beat      other   median |lag|');
  const row = (name, tracks, s) => {
    const t = tally(s.blends);
    lines.push(
      `${name.padEnd(19)}${String(tracks).padStart(5)}  ${String(s.transitions).padStart(11)}  ${String(s.matchable).padStart(9)}  ${String(s.blendCount).padStart(6)} (${pct(s.blendCount, s.transitions).padStart(4)})  ${String(t.n).padStart(8)}  ${String(t.tight).padStart(5)} (${pct(t.tight, t.n).padStart(4)})   ${String(t.half).padStart(4)} (${pct(t.half, t.n).padStart(4)})  ${String(t.other).padStart(3)} (${pct(t.other, t.n).padStart(4)})   ${Number.isFinite(t.medianAbsLagMs) ? `${t.medianAbsLagMs} ms` : 'n/a'}`,
    );
  };
  for (const g of Object.keys(byGenre)) row(GENRE_LABEL[g] || g, byGenre[g].tracks, byGenre[g]);
  for (const [name, list] of Object.entries(GROUPS)) {
    const have = list.filter((g) => byGenre[g]);
    if (!have.length) continue;
    const sum = { transitions: 0, matchable: 0, blendCount: 0, blends: [], tracks: 0 };
    for (const g of have) {
      sum.transitions += byGenre[g].transitions;
      sum.matchable += byGenre[g].matchable;
      sum.blendCount += byGenre[g].blendCount;
      sum.blends.push(...byGenre[g].blends);
      sum.tracks += byGenre[g].tracks;
    }
    row(`= ${name}`, sum.tracks, sum);
  }
  return lines.join('\n');
}

export function surveyAll(crate, opts = {}) {
  const byGenre = {};
  for (const g of GENRES) {
    const sub = crate.filter((t) => t.genre === g);
    if (sub.length < 8) continue;
    byGenre[g] = { tracks: sub.length, ...surveyCrate(sub, { ...opts, tag: `eval-${g}` }) };
  }
  return byGenre;
}

// ── calibration of Analysis.grid ────────────────────────────────────────────────────────────────

const CLEAR = 0.5; // Analysis.grid.head / .tail from which an end counts as clear (planner.js GRID_TRUST)
const CLEAN = 0.75; // a partner edge this clear is used as the yardstick for judging the other edge

/**
 * What the stem cross-correlation says about Analysis.grid and about the planner's gate.
 *
 * Every ordered pair inside a genre crate whose tempos match at the same beat level is FORCED into a
 * bass swap (8 or 16 beats; opts.force bypasses the planner's gate), out of A's tail into B's head, and
 * measured like any blend. Then:
 *   buckets  — by the lower of the two edge values (tail of A, head of B): how many came out within 20 ms
 *   edges    — each single edge is judged against partners whose own edge is very clear (≥ 0.75): it is
 *              "aligned" if most of those blends are within 20 ms, "off" otherwise
 *   contrast — by the pattern contrast the planner computed for the pair (Transition.trust.contrast)
 *   gate     — the planner's own verdict on the pair (Transition.trust.ok): of the pairs it would
 *              overlap, how many are within 20 ms; of the pairs it holds back, how many really are off
 * @param {ReturnType<typeof loadCrate>} crate
 * @param {{maxPairs?: number}} [o]  cap per genre (pairs are thinned evenly)
 */
export function calibrate(crate, o = {}) {
  const maxPairs = o.maxPairs || 500;
  const pairs = [];
  for (const g of GENRES) {
    const sub = crate.filter((t) => t.genre === g && t.analysis.bpmConfidence >= 0.5 && t.analysis.grid);
    const cand = [];
    for (let i = 0; i < sub.length; i++) for (let j = 0; j < sub.length; j++) {
      if (i !== j && Math.abs(sub[j].analysis.bpm / sub[i].analysis.bpm - 1) <= 0.075) cand.push([i, j]);
    }
    const step = Math.max(1, cand.length / maxPairs);
    for (let k = 0; k < cand.length; k += step) {
      const [i, j] = cand[Math.floor(k)];
      const A = sub[i];
      const B = sub[j];
      const beats = (i + j) % 2 ? 8 : 16;
      const planner = createPlanner({ seed: `cal-${g}-${i}-${j}`, vibe: 0.3, mode: 'preview' });
      const first = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
      const tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom, force: { type: 'bassSwap', beats } });
      if (!isBlend(tr) || !tr.trust) continue;
      const outPlay = { ...first.play, rate: first.play.rate.concat(tr.aRate), endAt: null };
      const m = blendAlignment(tr, outPlay, A.env, B.env);
      pairs.push({ genre: g, a: A.id, b: B.id, beats: tr.beats, tail: A.analysis.grid.tail, head: B.analysis.grid.head, ok: tr.trust.ok, contrast: tr.trust.contrast ?? null, ...m });
    }
  }
  const bucketsBy = (key, edges) => {
    const out = [];
    for (let k = 0; k + 1 < edges.length; k++) {
      out.push({ from: edges[k], to: edges[k + 1], ...tally(pairs.filter((p) => key(p) >= edges[k] && key(p) < edges[k + 1])) });
    }
    return out;
  };
  // each edge against its very clear partners
  const edges = new Map();
  const note = (key, trust, tight) => {
    const e = edges.get(key) || { trust, n: 0, tight: 0 };
    e.n++;
    if (tight) e.tight++;
    edges.set(key, e);
  };
  for (const p of pairs) {
    if (p.head >= CLEAN) note(`tail ${p.a}`, p.tail, p.verdict === 'tight');
    if (p.tail >= CLEAN) note(`head ${p.b}`, p.head, p.verdict === 'tight');
  }
  const judged = [...edges.values()].filter((e) => e.n >= 2).map((e) => ({ trust: e.trust, aligned: e.tight / e.n > 0.5 }));
  const high = judged.filter((e) => e.trust >= CLEAR);
  const low = judged.filter((e) => e.trust < CLEAR);
  const group = (list) => {
    const rs = pairs.filter((p) => list.includes(p.genre));
    return { pairs: rs.length, pass: tally(rs.filter((p) => p.ok)), hold: tally(rs.filter((p) => !p.ok)) };
  };
  return {
    pairs,
    all: tally(pairs),
    buckets: bucketsBy((p) => Math.min(p.tail, p.head), [0, 0.25, 0.5, 0.75, 1.0001]),
    contrast: bucketsBy((p) => (p.contrast === null ? -1 : p.contrast), [0, 0.9, 1, 1.05, 1.15, 1.3, 99]),
    edges: { judged: judged.length, high: high.length, highAligned: high.filter((e) => e.aligned).length, low: low.length, lowOff: low.filter((e) => !e.aligned).length },
    gate: { all: group(GENRES), steady: group(GROUPS.steady), syncopated: group(GROUPS.syncopated) },
  };
}

export function formatCalibration(c) {
  const lines = [];
  const rows = (buckets, label) => {
    lines.push(`  ${label.padEnd(34)} blends   within 20 ms   half a beat   other`);
    for (const b of buckets) {
      const name = b.to > 50 ? `${b.from.toFixed(2)} and above` : `${b.from.toFixed(2)} – ${(b.to > 1 && b.to < 1.001 ? 1 : b.to).toFixed(2)}`;
      lines.push(`  ${name.padEnd(34)} ${String(b.n).padStart(6)}   ${pct(b.tight, b.n).padStart(12)}   ${pct(b.half, b.n).padStart(11)}   ${pct(b.other, b.n).padStart(5)}`);
    }
  };
  lines.push(`calibration on ${c.pairs.length} forced blends (tail of one track into the head of another, same genre crate, tempos within 7.5 %; ${pct(c.all.tight, c.all.n)} of them within 20 ms):`);
  rows(c.buckets, 'lower of grid.tail / grid.head');
  const e = c.edges;
  lines.push(`  single edges, each judged by its blends with very clear partners (partner edge ≥ ${CLEAN}, at least two): ${e.judged} edges`);
  lines.push(`    clear (≥ ${CLEAR}):   ${e.high} edges, ${pct(e.highAligned, e.high)} actually aligned (most of those blends within 20 ms)`);
  lines.push(`    unclear (< ${CLEAR}): ${e.low} edges, ${pct(e.lowOff, e.low)} actually off`);
  rows(c.contrast, 'pattern contrast of the pair');
  for (const [name, g] of Object.entries(c.gate)) {
    const { pass, hold } = g;
    lines.push(`  planner gate, ${name}: lets ${pass.n} of ${g.pairs} through (${pct(pass.n, g.pairs)}), ${pct(pass.tight, pass.n)} of them within 20 ms; holds ${hold.n} back, ${pct(hold.n - hold.tight, hold.n)} of them really off (${pct(hold.half, hold.n)} half a beat, ${pct(hold.other, hold.n)} other)`);
  }
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const crate = loadCrate();
  if (!crate) {
    console.log('no fixtures — run: node tests/tools/fetch-fixtures.mjs');
    process.exit(0);
  }
  const seeds = Number(raw('seeds') || 6);
  const vibe = Number(raw('vibe') || 0.5);
  const byGenre = surveyAll(crate, { seeds, vibe });
  console.log(`${crate.length} fixture previews, ${seeds} sets per crate at vibe ${vibe} (preview mode)\n`);
  console.log(formatSurvey(byGenre));
  const out = { survey: byGenre };
  if (process.argv.includes('--calibrate')) {
    const c = calibrate(crate);
    console.log(`\n${formatCalibration(c)}`);
    out.calibration = { all: c.all, buckets: c.buckets, contrast: c.contrast, gate: c.gate, edges: c.edges };
  }
  const json = raw('json');
  if (json) writeFileSync(json, JSON.stringify(out, null, 1));
}

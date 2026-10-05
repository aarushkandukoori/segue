// Accuracy evaluation of the analysis on REAL previews (tests/fixtures/analysis, fetched by
// tests/tools/fetch-fixtures.mjs). Used by tests/analysis.real.test.js and runnable on its own:
//
//   node tests/helpers/analysis-eval.js            # summary
//   node tests/helpers/analysis-eval.js --verbose  # + every failure, per-track confidence
//   node tests/helpers/analysis-eval.js --hint     # feed Deezer's bpm as bpmHint (NOT a fair accuracy number)
//   node tests/helpers/analysis-eval.js --consistency   # + split-half consistency (≈ 1 min more)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readWav } from './analysis-wav.js';
import { analyzeTrack } from '../../js/analysis/analyze.js';

export const FIXTURE_DIR = resolve(fileURLToPath(new URL('../fixtures/analysis/', import.meta.url)));

/** @returns {null | any[]} manifest tracks whose WAV exists, or null when no fixtures were fetched */
export function loadFixtures() {
  const file = join(FIXTURE_DIR, 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    const tracks = JSON.parse(readFileSync(file, 'utf8')).tracks.filter((t) => existsSync(join(FIXTURE_DIR, t.wav)));
    return tracks.length ? tracks : null;
  } catch {
    return null;
  }
}

export const loadSamples = (track) => readWav(join(FIXTURE_DIR, track.wav));

export const fold = (bpm) => {
  while (bpm < 70) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  return bpm;
};
const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;

/**
 * Ground truth for a fixture.
 *   'hand'    — published tempo of a famous recording (HAND list), not contradicted by Deezer → reliable
 *   'suspect' — hand tempo and Deezer's bpm disagree by more than the scoring tolerance (2 %, octaves
 *               allowed): most likely the search matched a different version (remix, re-recording,
 *               soundtrack edit). Excluded from the scores, listed in the report.
 *   'deezer'  — only Deezer's bpm field (> 0). Noisy: it has its own octave and 3:2 errors.
 * @returns {null | {bpm:number, kind:'hand'|'suspect'|'deezer'}}
 */
export function groundTruth(t) {
  if (t.genre === 'rubato') return null; // beatless on purpose: a confidence test, not a tempo test
  if (t.handBpm > 0) {
    const d = t.deezerBpm;
    if (d > 0 && !(near(d, t.handBpm, 0.02) || near(d, 2 * t.handBpm, 0.02) || near(2 * d, t.handBpm, 0.02))) {
      return { bpm: t.handBpm, kind: 'suspect' };
    }
    return { bpm: t.handBpm, kind: 'hand' };
  }
  if (t.deezerBpm > 0) return { bpm: t.deezerBpm, kind: 'deezer' };
  return null;
}

/** strict: within 2 % of the truth folded into [70,180). octave: also accepts ×2 / ÷2. */
export function judge(est, truth) {
  const strict = near(est, fold(truth), 0.02);
  const octave = strict || near(est, truth, 0.02) || near(est * 2, truth, 0.02) || near(est / 2, truth, 0.02) || near(est * 2, fold(truth), 0.02) || near(est / 2, fold(truth), 0.02);
  return { strict, octave };
}

/**
 * Ground-truth-free beat-phase check, deliberately NOT using the library's own onset envelope:
 * short-time amplitude (5 ms RMS window, 1 ms hop) → its increase over 3 ms ("attack strength", linear in
 * amplitude, so a kick counts for more than a hi-hat).
 *   onVsHalf  mean attack at the beats (best value within ±10 ms) ÷ the same at the half-beat positions
 *   attackHit share of beats whose strongest attack within ±70 ms lies within ±12 ms of the beat
 *             (random placement would give ≈ 17 %); beats with no real attack nearby are not counted
 *   offsetMs  median signed distance beat → that strongest attack
 */
export function phaseProxy(x, fs, beats, from, to) {
  const hop = Math.round(fs / 1000);
  const win = hop * 5;
  const n = Math.floor((x.length - win) / hop);
  if (n < 10) return { onVsHalf: 0, attackHit: 0, offsetMs: 0, beats: 0 };
  const amp = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let e = 0;
    for (let i = t * hop; i < t * hop + win; i++) e += x[i] * x[i];
    amp[t] = Math.sqrt(e / win);
  }
  // the rise is attributed to the END of the window (where the new energy entered)
  const rise = new Float32Array(n);
  for (let t = 3; t < n; t++) rise[t] = Math.max(0, amp[t] - amp[t - 3]);
  const sorted = Float32Array.from(rise).sort();
  const floor = 0.25 * sorted[Math.floor(0.995 * n)]; // a quarter of a typical strong attack
  const idx = (sec) => Math.round((sec * fs - win) / hop); // window ending at `sec`
  const best = (c, r) => {
    let v = 0;
    let at = 0;
    for (let k = -r; k <= r; k++) {
      const i = c + k;
      if (i >= 0 && i < n && rise[i] > v) {
        v = rise[i];
        at = k;
      }
    }
    return { v, at };
  };
  let on = 0;
  let half = 0;
  let hits = 0;
  let counted = 0;
  const offsets = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const b = beats[i];
    if (b < from || b > to) continue;
    const period = beats[i + 1] - b;
    on += best(idx(b), 10).v;
    half += best(idx(b + period / 2), 10).v;
    const wide = best(idx(b), 70);
    if (wide.v > floor) {
      counted++;
      // +1: a 3-hop difference peaks about one hop after the attack entered the window
      offsets.push(wide.at - 1);
      if (Math.abs(wide.at - 1) <= 12) hits++;
    }
  }
  offsets.sort((a, b) => a - b);
  return {
    onVsHalf: half > 0 ? on / half : on > 0 ? 99 : 0,
    attackHit: counted ? hits / counted : 0,
    offsetMs: offsets.length ? offsets[offsets.length >> 1] : 0,
    beats: counted,
  };
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const quant = (arr, q) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * Run the analysis over the fixtures.
 * @param {any[]} tracks
 * @param {{useHint?:boolean, limit?:number}} [opts]
 */
export function evaluate(tracks, opts = {}) {
  const rows = [];
  let ms = 0;
  let maxMs = 0;
  for (const t of opts.limit ? tracks.slice(0, opts.limit) : tracks) {
    const { samples, sampleRate } = loadSamples(t);
    const t0 = performance.now();
    const a = analyzeTrack(samples, sampleRate, opts.useHint && t.deezerBpm > 0 ? { bpmHint: t.deezerBpm } : {});
    const dt = performance.now() - t0;
    ms += dt;
    if (dt > maxMs) maxMs = dt;
    const gt = groundTruth(t);
    const verdict = gt && gt.kind !== 'suspect' ? judge(a.bpm, gt.bpm) : null;
    const phase = phaseProxy(samples, sampleRate, a.beats, a.cues.start, a.cues.end);
    rows.push({ track: t, analysis: a, gt, verdict, phase, ms: dt });
  }
  const summary = { tracks: rows.length, meanMs: ms / Math.max(1, rows.length), maxMs, sets: {} };
  for (const kind of ['hand', 'deezer']) {
    const set = rows.filter((r) => r.gt && r.gt.kind === kind);
    summary.sets[kind] = {
      n: set.length,
      strict: set.filter((r) => r.verdict.strict).length,
      octave: set.filter((r) => r.verdict.octave).length,
      classFailures: set.filter((r) => !r.verdict.octave),
      octaveFailures: set.filter((r) => r.verdict.octave && !r.verdict.strict),
    };
  }
  summary.suspect = rows.filter((r) => r.gt && r.gt.kind === 'suspect');
  return { rows, summary };
}

/**
 * Split-half consistency (ground-truth-free): analyse seconds 0–20 and 10–30 of every clip separately
 * and compare the two answers where they overlap. A grid that is right is the same grid both times;
 * a half-beat slip or an octave flip shows up as a disagreement.
 * @returns {{n:number, tempo:number, phase:number, confident:number, confidentPhase:number, downbeat:number, downbeatOf:number, key:number}}
 */
export function splitHalfConsistency(tracks) {
  const out = { n: 0, tempo: 0, phase: 0, confident: 0, confidentPhase: 0, downbeat: 0, downbeatOf: 0, key: 0 };
  for (const t of tracks) {
    if (t.genre === 'rubato') continue;
    const { samples, sampleRate: fs } = loadSamples(t);
    if (samples.length < 28 * fs) continue;
    const A = analyzeTrack(samples.subarray(0, 20 * fs), fs);
    const B = analyzeTrack(samples.subarray(10 * fs), fs);
    const full = analyzeTrack(samples, fs);
    out.n++;
    const sameTempo = Math.abs(A.bpm / B.bpm - 1) < 0.01;
    if (sameTempo) out.tempo++;
    if (A.key.camelot === B.key.camelot) out.key++;
    let phaseOk = false;
    if (sameTempo) {
      const diffs = [];
      for (const b of A.beats) {
        if (b < 11 || b > 19) continue;
        let best = Infinity;
        for (const c of B.beats) if (Math.abs(c + 10 - b) < Math.abs(best)) best = c + 10 - b;
        diffs.push(best);
      }
      diffs.sort((x, y) => x - y);
      phaseOk = diffs.length > 0 && Math.abs(diffs[diffs.length >> 1]) < 0.025;
    }
    if (phaseOk) out.phase++;
    if (full.bpmConfidence >= 0.5) {
      out.confident++;
      if (phaseOk) out.confidentPhase++;
    }
    if (phaseOk) {
      out.downbeatOf++;
      const bar = (4 * 60) / A.bpm;
      const d = (A.beats[A.downbeat] - (B.beats[B.downbeat] + 10)) / bar;
      if (Math.abs((d - Math.round(d)) * 4) < 0.3) out.downbeat++;
    }
  }
  return out;
}

const label = (r) => `${r.track.artist} — ${r.track.title}`;

export function formatReport({ rows, summary }, verbose = false) {
  const out = [];
  out.push(`tracks analysed: ${summary.tracks}   mean ${summary.meanMs.toFixed(1)} ms / 30 s clip (max ${summary.maxMs.toFixed(0)} ms)`);
  for (const kind of ['hand', 'deezer']) {
    const s = summary.sets[kind];
    out.push(`\nTEMPO vs ${kind === 'hand' ? 'hand list (published tempos, reliable)' : "Deezer bpm field only (noisy)"}: n=${s.n}  strict(2%) ${pct(s.strict, s.n)}  octave-tolerant ${pct(s.octave, s.n)}`);
    out.push('  wrong tempo class:');
    for (const r of s.classFailures) out.push(`    ${label(r)}: est ${r.analysis.bpm.toFixed(1)} truth ${r.gt.bpm} conf ${r.analysis.bpmConfidence}`);
    out.push('  right class, other octave:');
    for (const r of s.octaveFailures) out.push(`    ${label(r)}: est ${r.analysis.bpm.toFixed(1)} truth ${r.gt.bpm} conf ${r.analysis.bpmConfidence}`);
  }
  if (summary.suspect.length) {
    out.push('\nexcluded (hand tempo contradicted by Deezer → probably another version):');
    for (const r of summary.suspect) out.push(`    ${label(r)} [${r.track.album || ''}]: est ${r.analysis.bpm.toFixed(1)} hand ${r.track.handBpm} deezer ${r.track.deezerBpm}`);
  }

  // ---- beat phase proxy ----
  const rhythmic = rows.filter((r) => r.track.genre !== 'rubato');
  const ph = rhythmic.map((r) => r.phase);
  out.push(`\nBEAT PHASE (ground-truth-free, ${rhythmic.length} non-rubato tracks):`);
  out.push(`  onset rise at beats ÷ at half-beats: median ${quant(ph.map((p) => p.onVsHalf), 0.5).toFixed(2)}  (p10 ${quant(ph.map((p) => p.onVsHalf), 0.1).toFixed(2)}, p90 ${quant(ph.map((p) => p.onVsHalf), 0.9).toFixed(2)})`);
  out.push(`  tracks with beats clearly on onsets (ratio ≥ 1.25): ${pct(ph.filter((p) => p.onVsHalf >= 1.25).length, ph.length)}`);
  out.push(`  share of beats with their strongest attack (±70 ms) within ±12 ms: median track ${(100 * quant(ph.map((p) => p.attackHit), 0.5)).toFixed(0)}%  (p10 ${(100 * quant(ph.map((p) => p.attackHit), 0.1)).toFixed(0)}%, p90 ${(100 * quant(ph.map((p) => p.attackHit), 0.9)).toFixed(0)}%; random ≈ 17%)`);
  out.push(`  tracks where ≥ 50% of the beats have it: ${pct(ph.filter((p) => p.attackHit >= 0.5).length, ph.length)}`);
  const offs = ph.filter((p) => p.attackHit >= 0.5).map((p) => p.offsetMs);
  out.push(`  median beat→attack offset on those tracks: ${quant(offs, 0.5)} ms (p10 ${quant(offs, 0.1)}, p90 ${quant(offs, 0.9)})`);
  const confident = rhythmic.filter((r) => r.analysis.bpmConfidence >= 0.5).map((r) => r.phase);
  out.push(`  … among tracks with bpmConfidence ≥ 0.5 (${confident.length}): ratio ≥ 1.25 in ${pct(confident.filter((p) => p.onVsHalf >= 1.25).length, confident.length)}, attack-hit ≥ 50% in ${pct(confident.filter((p) => p.attackHit >= 0.5).length, confident.length)}`);

  // ---- confidence ----
  out.push('\nbpmConfidence by group (p10 / median / p90, share ≥ 0.5):');
  const groups = {};
  for (const r of rows) {
    const g = r.track.genre === 'rubato' ? 'rubato / ambient / solo piano' : r.track.source === 'hand' && (r.track.genre === 'dance' || r.track.genre === 'electro') ? 'four-on-the-floor dance (hand list: dance + electro)' : `chart+hand: ${r.track.genre}`;
    (groups[g] = groups[g] || []).push(r.analysis.bpmConfidence);
  }
  for (const [g, v] of Object.entries(groups).sort()) {
    out.push(`  ${g.padEnd(52)} n=${String(v.length).padStart(3)}  ${quant(v, 0.1).toFixed(2)} / ${quant(v, 0.5).toFixed(2)} / ${quant(v, 0.9).toFixed(2)}   ≥0.5: ${pct(v.filter((c) => c >= 0.5).length, v.length)}`);
  }
  const judged = rows.filter((r) => r.verdict);
  const hi = judged.filter((r) => r.analysis.bpmConfidence >= 0.5);
  const lo = judged.filter((r) => r.analysis.bpmConfidence < 0.5);
  out.push(`  tempo class correct when confidence ≥ 0.5: ${pct(hi.filter((r) => r.verdict.octave).length, hi.length)} (n=${hi.length});  < 0.5: ${pct(lo.filter((r) => r.verdict.octave).length, lo.length)} (n=${lo.length})`);

  if (verbose) {
    out.push('\nper track:');
    for (const r of rows) {
      out.push(`  ${String(r.analysis.bpm.toFixed(1)).padStart(6)} conf ${r.analysis.bpmConfidence.toFixed(2)} ${r.analysis.key.camelot.padStart(3)} e=${r.analysis.energy.toFixed(2)} on/half ${r.phase.onVsHalf.toFixed(2)} hit ${(100 * r.phase.attackHit).toFixed(0).padStart(3)}% off ${String(r.phase.offsetMs).padStart(3)}ms  [${r.track.genre}] ${label(r)}${r.gt ? `  (truth ${r.gt.bpm} ${r.gt.kind})` : ''}`);
    }
  }
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracks = loadFixtures();
  if (!tracks) {
    console.log('no fixtures — run: node tests/tools/fetch-fixtures.mjs');
    process.exit(0);
  }
  const result = evaluate(tracks, { useHint: process.argv.includes('--hint') });
  console.log(formatReport(result, process.argv.includes('--verbose')));
  if (process.argv.includes('--consistency')) {
    const c = splitHalfConsistency(tracks);
    console.log(`\nSPLIT-HALF CONSISTENCY (0–20 s vs 10–30 s, ${c.n} non-rubato tracks):`);
    console.log(`  same tempo (±1 %, same octave): ${pct(c.tempo, c.n)}`);
    console.log(`  same beat phase (±25 ms): ${pct(c.phase, c.n)};  among tracks with bpmConfidence ≥ 0.5: ${pct(c.confidentPhase, c.confident)} of ${c.confident}`);
    console.log(`  same downbeat, given the same beat phase: ${pct(c.downbeat, c.downbeatOf)} of ${c.downbeatOf} (chance 25 %)`);
    console.log(`  same key (Camelot code): ${pct(c.key, c.n)}`);
  }
}

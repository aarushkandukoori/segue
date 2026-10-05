// Real music for the planner tests: the 30-second previews the analysis tests download into
// tests/fixtures/analysis/ (git-ignored; `node tests/tools/fetch-fixtures.mjs` fetches them), run
// through the real analyzeTrack(). Everything here returns null instead of throwing when the
// fixtures or the analysis module are missing, so a fresh clone simply skips these tests.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { positionAt } from '../../js/dj/timeline.js';

const DIR = fileURLToPath(new URL('../fixtures/analysis/', import.meta.url));

/**
 * @param {number} max how many tracks to analyse (≈ 60 ms each)
 * @returns {Promise<null | {id:string, artist:string, title:string, analysis:object, samples:Float32Array, sampleRate:number}[]>}
 */
export async function loadRealCrate(max = 48) {
  try {
    // SEGUE_NO_FIXTURES=1 runs the suite the way a fresh clone sees it (these tests skipped).
    if (process.env.SEGUE_NO_FIXTURES) return null;
    const manifest = `${DIR}manifest.json`;
    if (!existsSync(manifest)) return null;
    const { analyzeTrack } = await import('../../js/analysis/analyze.js');
    const { readWav } = await import('./analysis-wav.js');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : parsed.tracks;
    if (!Array.isArray(items)) return null;
    const tracks = [];
    for (const it of items) {
      if (tracks.length >= max) break;
      if (!it || !it.wav || !existsSync(DIR + it.wav)) continue;
      const wav = readWav(DIR + it.wav);
      const analysis = analyzeTrack(wav.samples, wav.sampleRate, it.deezerBpm > 0 ? { bpmHint: it.deezerBpm } : {});
      if (!analysis || !Array.isArray(analysis.beats) || analysis.beats.length < 8) continue;
      tracks.push({ id: `deezer:${it.id}`, artist: String(it.artist ?? ''), title: String(it.title ?? ''), analysis, samples: wav.samples, sampleRate: wav.sampleRate });
    }
    return tracks.length >= 12 ? tracks : null;
  } catch {
    return null;
  }
}

const HOP = 32; // samples per envelope frame (1.45 ms at 22.05 kHz)

/** Onset-strength envelope: half-wave rectified rise of the short-time log energy. */
export function onsetEnvelope(samples, sampleRate) {
  const n = Math.floor(samples.length / HOP);
  const energy = new Float32Array(n);
  const win = 128;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const a = Math.max(0, i * HOP - win / 2);
    const b = Math.min(samples.length, i * HOP + win / 2);
    for (let k = a; k < b; k++) sum += samples[k] * samples[k];
    energy[i] = Math.log(1e-6 + sum / win);
  }
  const d = new Float32Array(n);
  const lag = 7; // ≈ 10 ms
  for (let i = lag; i < n; i++) d[i] = Math.max(0, energy[i] - energy[i - lag]);
  return { d, hopSec: HOP / sampleRate };
}

function sampleEnv(env, pos) {
  const f = pos / env.hopSec;
  const i = Math.floor(f);
  if (i < 0 || i + 1 >= env.d.length) return 0;
  return env.d[i] + (env.d[i + 1] - env.d[i]) * (f - i);
}

/**
 * How far (seconds) the incoming track's onsets sit from the outgoing track's over the overlap of a
 * transition, as heard: both onset envelopes are read in SET time through positionAt, then
 * cross-correlated within ±0.2 beat. 0 = the real drums of both tracks hit together.
 */
export function onsetLag(tr, outPlay, envA, envB) {
  const dt = 0.001;
  const beatSec = (tr.tEnd - tr.tStart) / Math.max(1, tr.beats);
  const maxLag = Math.round((0.2 * beatSec) / dt);
  const n = Math.floor((tr.tEnd - tr.tStart) / dt);
  const playA = { ...outPlay, endAt: null };
  const playB = { ...tr.play, endAt: null };
  const a = new Float32Array(n);
  for (let k = 0; k < n; k++) a[k] = sampleEnv(envA, positionAt(playA, tr.tStart + k * dt));
  const b = new Float32Array(n + 2 * maxLag);
  for (let k = 0; k < b.length; k++) b[k] = sampleEnv(envB, positionAt(playB, tr.tStart + (k - maxLag) * dt));
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let nb = 0;
    for (let k = 0; k < n; k++) {
      const v = b[k + maxLag + lag];
      dot += a[k] * v;
      nb += v * v;
    }
    const c = dot / Math.sqrt(nb + 1e-12);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return bestLag * dt;
}

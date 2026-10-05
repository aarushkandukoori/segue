// Headless-Chrome check of the analysis front end (js/analysis/client.js + worker.js):
//   decodeAudioData → createAnalyzer().analyze() through the real module Worker → compare with Node,
//   wall time, IndexedDB cache (also across a page reload), and every fallback path.
// Uses a real Deezer preview when one is available (tests/fixtures/analysis, or fetched now); otherwise
// (or with SEGUE_E2E_OFFLINE=1) a synthetic WAV, so the script also passes offline.   exit code 0 = pass
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';
import { analyzeTrack, ANALYSIS_VERSION } from '../../js/analysis/analyze.js';
import { readWav, encodeWav } from '../helpers/analysis-wav.js';
import { drumLoop } from '../helpers/analysis-synth.js';
import { assertValidAnalysis } from '../helpers/analysis-assert.js';

const FIXTURES = resolve(fileURLToPath(new URL('../fixtures/analysis/', import.meta.url)));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A real preview (mp3 + the ffmpeg-decoded 22.05 kHz mono WAV of the same bytes), or null. */
async function realPreview() {
  mkdirSync(FIXTURES, { recursive: true });
  if (process.env.SEGUE_E2E_OFFLINE) return null; // force the synthetic path
  let mp3 = null;
  try {
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
    const kept = manifest.tracks.find((t) => t.mp3 && existsSync(join(FIXTURES, t.mp3)) && existsSync(join(FIXTURES, t.wav)));
    if (kept) return { mp3: kept.mp3, wav: kept.wav, label: `${kept.artist} — ${kept.title}` };
  } catch {
    /* no manifest */
  }
  try {
    const chart = await (await fetch('https://api.deezer.com/chart/113/tracks?limit=5', { signal: AbortSignal.timeout(10000) })).json();
    const track = chart.data.find((t) => t.preview);
    const bytes = Buffer.from(await (await fetch(track.preview, { signal: AbortSignal.timeout(20000) })).arrayBuffer());
    if (bytes.length < 50000) throw new Error('preview too small');
    mp3 = 'e2e-preview.mp3';
    writeFileSync(join(FIXTURES, mp3), bytes);
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-i', join(FIXTURES, mp3), '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', join(FIXTURES, 'e2e-preview.wav')]);
    return { mp3, wav: 'e2e-preview.wav', label: `${track.artist.name} — ${track.title}` };
  } catch (err) {
    console.log(`  (no real preview available: ${err.message})`);
    return null;
  }
}

const srv = await startServer();
const { page, errors, logs, close } = await launch({ width: 1000, height: 700 });
let failed = false;
try {
  // ---- audio under test ---------------------------------------------------------------------------
  const real = await realPreview();
  let audioFile;
  let nodeRef;
  if (real) {
    audioFile = real.mp3;
    const wav = readWav(join(FIXTURES, real.wav));
    nodeRef = analyzeTrack(wav.samples, wav.sampleRate);
    console.log(`audio: real Deezer preview "${real.label}"`);
  } else {
    const loop = drumLoop({ bpm: 124, seconds: 30, sr: 44100 });
    audioFile = 'e2e-synth.wav';
    writeFileSync(join(FIXTURES, audioFile), encodeWav(loop.samples, 44100));
    nodeRef = analyzeTrack(readWav(join(FIXTURES, audioFile)).samples, 44100);
    console.log('audio: synthetic 124 BPM loop (offline)');
  }
  const audioUrl = `${srv.url}/tests/fixtures/analysis/${audioFile}`;
  const harnessUrl = `${srv.url}/tests/e2e/analysis-harness.html`;
  const open = async () => {
    await page.goto(harnessUrl);
    await page.waitForFunction('window.harnessReady === true', { timeout: 15000 });
  };
  await open();

  // ---- 1. decode + analyse through the Worker ---------------------------------------------------
  const first = await page.evaluate(async (url) => {
    const h = window.harness;
    const buffer = await h.decode(url);
    const analyzer = (h.analyzers.main = h.createAnalyzer());
    const miss = await analyzer.cached('e2e:track');
    const t0 = performance.now();
    const analysis = await analyzer.analyze(buffer, { key: 'e2e:track' });
    const cold = performance.now() - t0;
    // warm worker, different key
    const t1 = performance.now();
    const again = await analyzer.analyze(buffer, { key: 'e2e:track:warm' });
    const warm = performance.now() - t1;
    // the same computation on the main thread, for an exact comparison and a pure compute time
    const tp = performance.now();
    const prepared = await h.prepareAudio(buffer);
    const prepareMs = performance.now() - tp;
    const tc = performance.now();
    const direct = h.analyzeTrack(prepared.pcm, prepared.sampleRate, { peak: prepared.peak, duration: buffer.duration });
    const computeMs = performance.now() - tc;
    return {
      info: h.info(buffer),
      miss,
      cold,
      warm,
      prepareMs,
      computeMs,
      analysis: h.plain(analysis),
      sameAsWarm: JSON.stringify(h.plain(again)) === JSON.stringify(h.plain(analysis)),
      sameAsDirect: JSON.stringify(h.plain(direct)) === JSON.stringify(h.plain(analysis)),
      stats: analyzer.stats,
    };
  }, audioUrl);

  const a = first.analysis;
  console.log(`decoded: ${first.info.sampleRate} Hz, ${first.info.channels} ch, ${first.info.duration.toFixed(2)} s`);
  check('cached() is null before the first analysis', first.miss === null);
  check('analysis ran in the Worker', first.stats.worker === 2 && first.stats.main === 0 && first.stats.workerFailures === 0, JSON.stringify(first.stats));
  check('results are stored in IndexedDB', first.stats.storage === 'indexeddb', first.stats.storage);
  check('typed arrays survive the Worker round trip', a.__types.low === 'Uint8Array' && a.__types.mid === 'Uint8Array' && a.__types.high === 'Uint8Array' && a.__types.beats);
  let valid = true;
  let why = '';
  try {
    assertValidAnalysis({ ...a, wave: { ...a.wave, low: Uint8Array.from(a.wave.low), mid: Uint8Array.from(a.wave.mid), high: Uint8Array.from(a.wave.high) } }, first.info.duration, ANALYSIS_VERSION);
  } catch (err) {
    valid = false;
    why = err.message;
  }
  check('Worker result is a structurally valid Analysis', valid, why);
  check('Worker result is identical to analyzeTrack on the main thread', first.sameAsDirect);
  check('a second run on a warm Worker gives the identical result', first.sameAsWarm);

  // ---- 2. agreement with Node (ffmpeg-decoded, 22.05 kHz) ------------------------------------------
  const n = nodeRef;
  check('tempo matches Node', Math.abs(a.bpm / n.bpm - 1) < 0.002, `browser ${a.bpm} vs node ${n.bpm}`);
  check('duration matches Node', Math.abs(a.duration - n.duration) < 0.08, `${a.duration.toFixed(3)} vs ${n.duration.toFixed(3)}`);
  // beat times: allow one constant decoder-delay offset between Chrome and ffmpeg, then compare tightly
  const diffs = a.beats.map((b) => n.beats.reduce((best, t) => (Math.abs(t - b) < Math.abs(best) ? t - b : best), Infinity)).sort((x, y) => x - y);
  const offset = diffs[diffs.length >> 1];
  const worst = Math.max(...diffs.map((d) => Math.abs(d - offset)));
  check('beat grid matches Node', Math.abs(offset) < 0.03 && worst < 0.004 && Math.abs(a.beats.length - n.beats.length) <= 1, `constant offset ${(offset * 1000).toFixed(2)} ms, worst residual ${(worst * 1000).toFixed(2)} ms, ${a.beats.length} vs ${n.beats.length} beats`);
  const bar = (4 * 60) / n.bpm;
  const dbShift = (a.beats[a.downbeat] + offset - n.beats[n.downbeat]) / bar;
  check('downbeat matches Node', Math.abs(dbShift - Math.round(dbShift)) < 0.05, `bar offset ${dbShift.toFixed(3)}`);
  check('key matches Node', a.key.camelot === n.key.camelot, `${a.key.name} (${a.key.camelot}) vs ${n.key.name} (${n.key.camelot})`);
  check('confidence matches Node', Math.abs(a.bpmConfidence - n.bpmConfidence) < 0.1, `${a.bpmConfidence} vs ${n.bpmConfidence}`);
  check('loudness trim matches Node', Math.abs(a.loudness.trimDb - n.loudness.trimDb) < 0.6, `${a.loudness.trimDb} vs ${n.loudness.trimDb} dB`);
  check('energy matches Node', Math.abs(a.energy - n.energy) < 0.06, `${a.energy} vs ${n.energy}`);
  let waveDiff = 0;
  const cols = Math.min(a.wave.cols, n.wave.cols) - 5;
  for (let c = 5; c < cols; c++) waveDiff += Math.abs(a.wave.low[c] - n.wave.low[c]) + Math.abs(a.wave.mid[c] - n.wave.mid[c]) + Math.abs(a.wave.high[c] - n.wave.high[c]);
  waveDiff /= 3 * (cols - 5);
  check('waveform matches Node', waveDiff < 12 && Math.abs(a.wave.cols - n.wave.cols) <= 8, `mean |Δ| ${waveDiff.toFixed(1)} of 255, ${a.wave.cols} vs ${n.wave.cols} columns`);

  // ---- 3. time -----------------------------------------------------------------------------------
  console.log(`timing (30 s clip): cold ${first.cold.toFixed(0)} ms (worker start-up included), warm ${first.warm.toFixed(0)} ms; of which main-thread downmix+resample ${first.prepareMs.toFixed(0)} ms; analyzeTrack alone ${first.computeMs.toFixed(0)} ms`);
  check('analyzeTrack ≤ 250 ms for the 30 s clip (in Chrome)', first.computeMs <= 250, `${first.computeMs.toFixed(0)} ms`);
  check('warm analyze() wall time ≤ 600 ms', first.warm <= 600, `${first.warm.toFixed(0)} ms`);
  check('cold analyze() wall time ≤ 2 s', first.cold <= 2000, `${first.cold.toFixed(0)} ms`);

  // ---- 4. cache hits ---------------------------------------------------------------------------------
  const hit = await page.evaluate(async (url) => {
    const h = window.harness;
    const buffer = await h.decode(url);
    const analyzer = h.analyzers.main;
    const t0 = performance.now();
    const again = await analyzer.analyze(buffer, { key: 'e2e:track' });
    const ms = performance.now() - t0;
    const before = analyzer.stats;
    // a brand-new analyzer has an empty memory cache: this must come from IndexedDB
    const fresh = h.createAnalyzer();
    const t1 = performance.now();
    const stored = await fresh.cached('e2e:track');
    const idbMs = performance.now() - t1;
    const viaAnalyze = await fresh.analyze(buffer, { key: 'e2e:track' });
    const stats = fresh.stats;
    fresh.destroy();
    return {
      ms,
      idbMs,
      memoryHit: before.cacheHits === 1 && before.worker === 2,
      stored: h.plain(stored),
      storedSame: JSON.stringify(h.plain(stored)) === JSON.stringify(h.plain(again)),
      viaAnalyzeSame: JSON.stringify(h.plain(viaAnalyze)) === JSON.stringify(h.plain(again)),
      stats,
    };
  }, audioUrl);
  check('same key again → memory cache hit, no new Worker job', hit.memoryHit && hit.ms < 30, `${hit.ms.toFixed(1)} ms`);
  check('fresh analyzer → cached() reads the Analysis back from IndexedDB', hit.stored && hit.storedSame && hit.stored.__types.low === 'Uint8Array', `${hit.idbMs.toFixed(1)} ms`);
  check('fresh analyzer → analyze() is served from IndexedDB without a Worker', hit.viaAnalyzeSame && hit.stats.cacheHits === 1 && hit.stats.worker === 0 && hit.stats.main === 0, JSON.stringify(hit.stats));

  await open(); // full page reload: only IndexedDB survives
  const afterReload = await page.evaluate(async () => {
    const h = window.harness;
    const analyzer = h.createAnalyzer();
    const stored = await analyzer.cached('e2e:track');
    const other = await analyzer.cached('e2e:never-analysed');
    analyzer.destroy();
    return { stored: h.plain(stored), other };
  });
  check('cache survives a page reload', afterReload.stored && JSON.stringify(afterReload.stored) === JSON.stringify(a) && afterReload.other === null);

  // ---- 4b. what must NOT be kept: the user's own files -----------------------------------------------
  // A local file's cache key carries its file name. Earlier builds wrote those keys to IndexedDB, where
  // they outlived the session and the page. (Names below are invented.)
  const localKey = 'local:Rehearsal take 2 (rough).wav:1764044:1700000000000';
  const legacyKey = 'local:Old demo bounce.wav:1500000:1690000000000';
  const privacy = await page.evaluate(
    async (url, key, legacy) => {
      const h = window.harness;
      const idb = (mode, fn) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('segue-analysis', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('analysis');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('analysis', mode);
            const out = fn(tx.objectStore('analysis'));
            tx.oncomplete = () => {
              open.result.close();
              resolve(out.result);
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      const keys = () => idb('readonly', (store) => store.getAllKeys());
      const suffix = `|v${h.ANALYSIS_VERSION}`;
      const buffer = await h.decode(url);
      // what an earlier build left behind: a current-version record under a file-name key
      const an0 = h.createAnalyzer();
      const valid = await an0.analyze(buffer, { key: 'e2e:track' });
      an0.destroy();
      await idb('readwrite', (store) => store.put(valid, legacy + suffix));
      const seeded = (await keys()).includes(legacy + suffix);

      const an = h.createAnalyzer();
      const legacyRead = await an.cached(legacy);
      const first = await an.analyze(buffer, { key });
      const again = await an.analyze(buffer, { key });
      const viaCached = await an.cached(key);
      const stats = an.stats;
      // (only local keys were asked for: the housekeeping must not wait for a preview to come along)
      let after = await keys();
      for (let i = 0; i < 40 && after.some((k) => String(k).startsWith('local:')); i++) {
        await new Promise((r) => setTimeout(r, 50));
        after = await keys();
      }
      await new Promise((r) => setTimeout(r, 150)); // anything that was going to be written has been by now
      after = await keys();
      an.destroy();
      // a new analyzer (new session): nothing about the file comes back
      const fresh = h.createAnalyzer();
      const freshRead = await fresh.cached(key);
      const previewStill = !!(await fresh.cached('e2e:track'));
      fresh.destroy();
      return { seeded, legacyRead, memoryHit: again === first && viaCached === first, stats, localKeys: after.filter((k) => String(k).startsWith('local:')), all: after.length, freshRead, previewStill };
    },
    audioUrl,
    localKey,
    legacyKey,
  );
  check('a local file is analysed and cached for the session (memory)', privacy.memoryHit && privacy.stats.cacheHits === 1 && privacy.stats.worker === 1, JSON.stringify(privacy.stats));
  check('… but its key (the file name) is never written to IndexedDB', privacy.localKeys.length === 0 && privacy.all > 0, `${privacy.all} records, ${privacy.localKeys.length} of them local`);
  check('file-name records left by an earlier build are deleted, and not read back', privacy.seeded && privacy.legacyRead === null && privacy.localKeys.length === 0);
  check('a new session knows nothing about the file; previews are still cached', privacy.freshRead === null && privacy.previewStill);

  await open();
  const bounded = await page.evaluate(async (limit) => {
    const h = window.harness;
    const idb = (mode, fn) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('segue-analysis', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('analysis', mode);
          const out = fn(tx.objectStore('analysis'));
          tx.oncomplete = () => {
            open.result.close();
            resolve(out && out.result);
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    const suffix = `|v${h.ANALYSIS_VERSION}`;
    const before = await idb('readonly', (store) => store.count());
    // under the limit nothing of the current version is touched …
    const an1 = h.createAnalyzer();
    const kept = !!(await an1.cached('e2e:track'));
    an1.destroy();
    // … a store that has outgrown it starts over
    await idb('readwrite', (store) => {
      for (let i = 0; i <= limit; i++) store.put({ filler: i }, `e2e:filler:${i}${suffix}`);
    });
    const full = await idb('readonly', (store) => store.count());
    const an2 = h.createAnalyzer();
    const gone = await an2.cached('e2e:track');
    an2.destroy();
    const after = await idb('readonly', (store) => store.count());
    return { before, kept, full, gone, after };
  }, 2000);
  check('the store is bounded: found with more than 2000 records it starts over', bounded.kept && bounded.before > 0 && bounded.full > 2000 && bounded.gone === null && bounded.after === 0, JSON.stringify(bounded));

  // ---- 5. fallbacks ---------------------------------------------------------------------------------
  const fallback = await page.evaluate(async (url) => {
    const h = window.harness;
    const buffer = await h.decode(url);
    const reference = JSON.stringify(h.plain(await h.createAnalyzer({ workers: 0 }).analyze(buffer, {})));
    const out = {};
    const RealWorker = window.Worker;

    // (a) Workers disabled by option
    let an = h.createAnalyzer({ workers: 0 });
    let r = await an.analyze(buffer, { key: 'e2e:fallback:a' });
    out.option = { same: JSON.stringify(h.plain(r)) === reference, stats: an.stats };
    an.destroy();

    // (b) the Worker constructor throws (CSP, very old browser)
    window.Worker = function () {
      throw new Error('Workers are blocked');
    };
    an = h.createAnalyzer();
    r = await an.analyze(buffer, { key: 'e2e:fallback:b' });
    out.throws = { same: JSON.stringify(h.plain(r)) === reference, stats: an.stats };
    an.destroy();

    // (c) the Worker script fails to load → error event → job is rescued on the main thread
    window.Worker = class extends RealWorker {
      constructor(url, opts) {
        super(new URL('./does-not-exist.js', location.href), opts);
      }
    };
    an = h.createAnalyzer();
    const [r1, r2] = await Promise.all([an.analyze(buffer, { key: 'e2e:fallback:c1' }), an.analyze(buffer, { key: 'e2e:fallback:c2' })]);
    out.loadError = { same: JSON.stringify(h.plain(r1)) === reference && JSON.stringify(h.plain(r2)) === reference, stats: an.stats };
    an.destroy();
    window.Worker = RealWorker;

    // (d) IndexedDB unavailable (private mode): memory cache only, nothing throws
    const desc = Object.getOwnPropertyDescriptor(window, 'indexedDB') || Object.getOwnPropertyDescriptor(Window.prototype, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
    an = h.createAnalyzer();
    r = await an.analyze(buffer, { key: 'e2e:fallback:d' });
    const mem = await an.cached('e2e:fallback:d');
    out.noIdb = { same: JSON.stringify(h.plain(r)) === reference, cached: mem === r, stats: an.stats };
    an.destroy();
    // (e) IndexedDB that throws on open
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get: () => ({
        open() {
          throw new DOMException('denied', 'SecurityError');
        },
      }),
    });
    an = h.createAnalyzer();
    r = await an.analyze(buffer, { key: 'e2e:fallback:e' });
    out.idbThrows = { same: JSON.stringify(h.plain(r)) === reference, stats: an.stats };
    an.destroy();
    if (desc) Object.defineProperty(window, 'indexedDB', desc);
    else delete window.indexedDB;

    // (f) after destroy(): pending and new calls reject, nothing hangs
    an = h.createAnalyzer();
    const pending = an.analyze(buffer, { key: 'e2e:destroyed' }).then(
      () => 'resolved',
      (err) => `rejected: ${err.message}`,
    );
    an.destroy();
    out.destroyed = await pending;
    return out;
  }, audioUrl);
  check('fallback: {workers: 0} analyses on the main thread', fallback.option.same && fallback.option.stats.main === 1 && fallback.option.stats.worker === 0, JSON.stringify(fallback.option.stats));
  check('fallback: Worker constructor throws → main thread', fallback.throws.same && fallback.throws.stats.main === 1 && fallback.throws.stats.worker === 0, JSON.stringify(fallback.throws.stats));
  check('fallback: Worker script fails to load → both queued jobs rescued on the main thread', fallback.loadError.same && fallback.loadError.stats.main === 2 && fallback.loadError.stats.workerFailures >= 1, JSON.stringify(fallback.loadError.stats));
  check('fallback: no IndexedDB → memory cache', fallback.noIdb.same && fallback.noIdb.cached && fallback.noIdb.stats.storage === 'memory', JSON.stringify(fallback.noIdb.stats));
  check('fallback: IndexedDB.open throws → memory cache', fallback.idbThrows.same && fallback.idbThrows.stats.storage === 'memory', JSON.stringify(fallback.idbThrows.stats));
  check('destroy() rejects pending work', /^rejected/.test(fallback.destroyed), fallback.destroyed);

  // ---- 6. pool + long track -----------------------------------------------------------------------
  const long = await page.evaluate(async () => {
    const h = window.harness;
    const analyzer = h.createAnalyzer();
    const five = h.synthBuffer(300, 126);
    const t0 = performance.now();
    let longestGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 4);
    const analysis = await analyzer.analyze(five, { key: 'e2e:five-minutes' });
    const ms = performance.now() - t0;
    clearInterval(tick);
    // two different clips at once → two Workers
    const b1 = h.synthBuffer(20, 100);
    const b2 = h.synthBuffer(20, 140);
    const [r1, r2] = await Promise.all([analyzer.analyze(b1, { key: 'e2e:p1' }), analyzer.analyze(b2, { key: 'e2e:p2' })]);
    const stats = analyzer.stats;
    analyzer.destroy();
    return { ms, longestGap, bpm: analysis.bpm, beats: analysis.beats.length, conf: analysis.bpmConfidence, duration: analysis.duration, p1: r1.bpm, p2: r2.bpm, stats };
  });
  console.log(`timing (5-minute stereo 48 kHz track): ${long.ms.toFixed(0)} ms wall, longest main-thread stall ${long.longestGap.toFixed(0)} ms`);
  check('5-minute track: correct grid', Math.abs(long.bpm - 126) < 0.05 && Math.abs(long.beats - 630) <= 2 && long.conf >= 0.8, `bpm ${long.bpm}, ${long.beats} beats, conf ${long.conf}`);
  check('5-minute track ≤ 3 s wall (main-thread prep + Worker)', long.ms <= 3000, `${long.ms.toFixed(0)} ms`);
  check('main thread stays responsive while preparing a long track', long.longestGap < 120, `longest stall ${long.longestGap.toFixed(0)} ms`);
  check('two clips in parallel on the pool', Math.abs(long.p1 - 100) < 0.2 && Math.abs(long.p2 - 140) < 0.2 && long.stats.worker === 3 && long.stats.main === 0, `${long.p1} / ${long.p2} BPM, ${JSON.stringify(long.stats)}`);

  // the only console errors allowed are the two we provoked on purpose (missing worker script)
  const unexpected = errors.filter((e) => !/does-not-exist\.js|404/.test(e));
  check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
} catch (err) {
  failed = true;
  console.error('e2e crashed:', err);
  for (const l of logs.slice(-15)) console.error(`  [${l.type}] ${l.text}`);
} finally {
  await close();
  await srv.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\nanalysis e2e: ${results.length - bad.length}/${results.length} checks passed${failed ? ' (crashed)' : ''}`);
process.exit(failed || bad.length ? 1 : 0);

// client.js in Node: no Worker, no IndexedDB → exactly the fallback paths (main-thread analysis, memory
// cache). The Worker + IndexedDB paths are covered in headless Chrome by tests/e2e/analysis.e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer, isPrivateKey, prepareAudio } from '../js/analysis/client.js';
import { analyzeTrack, ANALYSIS_VERSION, ANALYSIS_RATE } from '../js/analysis/analyze.js';
import { resample } from '../js/analysis/dsp.js';
import { drumLoop } from './helpers/analysis-synth.js';
import { assertValidAnalysis } from './helpers/analysis-assert.js';

/** Minimal AudioBuffer stand-in. */
function fakeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (c) => channels[c],
  };
}

test('prepareAudio: stereo → mono mix at the analysis rate, true peak of the channels', async () => {
  const sr = 48000;
  const loop = drumLoop({ bpm: 120, seconds: 6, sr }).samples;
  const left = Float32Array.from(loop, (v) => v * 0.9);
  const right = Float32Array.from(loop, (v) => -v * 0.3); // partly out of phase: the mono mix is quieter
  right[1234] = 0.97;
  const out = await prepareAudio(fakeBuffer([left, right], sr));
  assert.equal(out.sampleRate, ANALYSIS_RATE);
  assert.equal(out.pcm.length, Math.round((loop.length * ANALYSIS_RATE) / sr));
  const peakLeft = left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(out.peak - Math.max(peakLeft, 0.97)) < 1e-6, `peak ${out.peak}`);
  const mono = Float32Array.from(left, (v, i) => 0.5 * (v + right[i]));
  const want = resample(mono, sr, ANALYSIS_RATE);
  assert.deepEqual(out.pcm, want);
  // already at the analysis rate: no resampling, mono passes straight through
  const same = await prepareAudio(fakeBuffer([Float32Array.from([0.1, -0.2, 0.3])], ANALYSIS_RATE));
  assert.deepEqual(Array.from(same.pcm), [0.1, -0.2, 0.3].map(Math.fround));
  // NaN samples do not poison the peak
  const bad = await prepareAudio(fakeBuffer([Float32Array.from([0.1, NaN, -0.4])], ANALYSIS_RATE));
  assert.ok(Math.abs(bad.peak - 0.4) < 1e-6);
  const empty = await prepareAudio(fakeBuffer([new Float32Array(0)], 44100));
  assert.equal(empty.pcm.length, 0);
});

test('createAnalyzer without Workers / IndexedDB: main-thread analysis, memory cache, de-duplication', async () => {
  const analyzer = createAnalyzer();
  const sr = 44100;
  const loop = drumLoop({ bpm: 126, seconds: 12, sr });
  const buffer = fakeBuffer([loop.samples, loop.samples], sr);

  assert.equal(await analyzer.cached('deezer:1'), null);
  const [a, b] = await Promise.all([
    analyzer.analyze(buffer, { key: 'deezer:1', bpmHint: 126 }),
    analyzer.analyze(buffer, { key: 'deezer:1', bpmHint: 126 }),
  ]);
  assert.equal(a, b, 'concurrent requests for the same key share one analysis');
  assertValidAnalysis(a, 12, ANALYSIS_VERSION);
  assert.ok(Math.abs(a.bpm - 126) < 0.3);

  // identical to calling analyzeTrack on the prepared audio
  const prepared = await prepareAudio(buffer);
  assert.deepEqual(a, analyzeTrack(prepared.pcm, prepared.sampleRate, { bpmHint: 126, peak: prepared.peak, duration: buffer.duration }));

  let stats = analyzer.stats;
  assert.equal(stats.main, 1);
  assert.equal(stats.worker, 0);
  assert.equal(stats.storage, 'memory');

  assert.equal(await analyzer.cached('deezer:1'), a);
  assert.equal(await analyzer.analyze(buffer, { key: 'deezer:1' }), a, 'second call is a cache hit');
  stats = analyzer.stats;
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.main, 1);

  // a different key is analysed again; no key = never cached
  const c = await analyzer.analyze(buffer, { key: 'deezer:2' });
  assert.notEqual(c, a);
  await analyzer.analyze(buffer, {});
  await analyzer.analyze(buffer, {});
  assert.equal(analyzer.stats.main, 4);
  assert.equal(await analyzer.cached(''), null);

  analyzer.destroy();
  await assert.rejects(() => analyzer.analyze(buffer, { key: 'deezer:3' }), /destroyed/);
});

test('createAnalyzer({workers: 0}) and odd buffers', async () => {
  const analyzer = createAnalyzer({ workers: 0 });
  const silent = await analyzer.analyze(fakeBuffer([new Float32Array(48000 * 3)], 48000), { key: 'local:silence:1:2' });
  assertValidAnalysis(silent, 3, ANALYSIS_VERSION);
  assert.equal(silent.bpmConfidence, 0);
  const empty = await analyzer.analyze(fakeBuffer([new Float32Array(0)], 48000), { key: 'local:empty:0:0' });
  assertValidAnalysis(empty, 0, ANALYSIS_VERSION);
  analyzer.destroy();
});

// ── what is written to IndexedDB ───────────────────────────────────────────────────────────────
// (the real thing is exercised in headless Chrome by tests/e2e/analysis.e2e.mjs; this stand-in records
// every write, so the rule "a file name never reaches the disk" is checked on every `node --test` run)

/** The few IndexedDB calls client.js makes, over a Map; requests settle on later microtasks. */
function fakeIndexedDB(initial = {}) {
  const data = new Map(Object.entries(initial));
  const log = { puts: [], deletes: [], cleared: 0, opened: 0 };
  const request = (compute) => {
    const r = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      r.result = compute();
      if (r.onsuccess) r.onsuccess();
    });
    return r;
  };
  const store = {
    get: (k) => request(() => data.get(k)),
    put: (v, k) => (log.puts.push(k), request(() => void data.set(k, v))),
    delete: (k) => (log.deletes.push(k), request(() => void data.delete(k))),
    clear: () => (log.cleared++, request(() => void data.clear())),
    count: () => request(() => data.size),
    openKeyCursor() {
      const keys = [...data.keys()].sort();
      let i = 0;
      const r = { result: null, onsuccess: null };
      const step = () =>
        queueMicrotask(() => {
          r.result = i < keys.length ? { key: keys[i], continue: () => (i++, step()) } : null;
          if (r.onsuccess) r.onsuccess();
        });
      step();
      return r;
    },
  };
  const db = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore: () => store }), close() {} };
  return {
    data,
    log,
    open() {
      log.opened++;
      const r = { result: db };
      queueMicrotask(() => r.onsuccess && r.onsuccess());
      return r;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a local file is cached for the session only: its key (the file name) is never written, old ones are removed', async () => {
  assert.equal(isPrivateKey('local:Rehearsal take 2.wav:1764044:1700000000000'), true);
  for (const key of ['deezer:123', 'itunes:9', 'mix:deezer:1', 'not-local:1', '']) assert.equal(isPrivateKey(key), false, key);
  const sr = 44100;
  const loop = drumLoop({ bpm: 122, seconds: 8, sr });
  const buffer = fakeBuffer([loop.samples], sr);
  const prepared = await prepareAudio(buffer);
  const stored = analyzeTrack(prepared.pcm, prepared.sampleRate, { peak: prepared.peak, duration: buffer.duration });
  const v = `|v${ANALYSIS_VERSION}`;
  // what an earlier build left in the browser: two file-name keys, one preview, one outdated record
  const idb = fakeIndexedDB({
    [`local:Old demo bounce.wav:1500000:1690000000000${v}`]: stored,
    [`local:Voice note.m4a:900:1680000000000|v${ANALYSIS_VERSION - 1}`]: stored,
    [`deezer:7${v}`]: stored,
    [`deezer:8|v${ANALYSIS_VERSION - 1}`]: stored,
  });
  globalThis.indexedDB = idb;
  try {
    const analyzer = createAnalyzer({ workers: 0 });
    const key = 'local:Rehearsal take 2 (rough).wav:1764044:1700000000000';
    // a stale record under a file-name key is not served …
    assert.equal(await analyzer.cached('local:Old demo bounce.wav:1500000:1690000000000'), null);
    const a = await analyzer.analyze(buffer, { key });
    assertValidAnalysis(a, 8, ANALYSIS_VERSION);
    assert.equal(await analyzer.analyze(buffer, { key }), a, 'second call: memory hit');
    assert.equal(await analyzer.cached(key), a);
    assert.equal(analyzer.stats.cacheHits, 1);
    await settle();
    // … nothing was written for the file, and the database was opened anyway to clean up
    assert.equal(idb.log.opened, 1);
    assert.deepEqual(idb.log.puts, []);
    assert.deepEqual([...idb.data.keys()], [`deezer:7${v}`], 'file-name records and outdated ones are gone, the preview stays');
    assert.equal(idb.log.cleared, 0);
    // previews are stored and read back as before
    assert.equal(await analyzer.cached('deezer:7'), stored);
    const b = await analyzer.analyze(buffer, { key: 'deezer:42', bpmHint: 122 });
    await settle();
    assert.deepEqual(idb.log.puts, [`deezer:42${v}`]);
    assert.equal(idb.data.get(`deezer:42${v}`), b);
    assert.equal(analyzer.stats.storage, 'indexeddb');
    analyzer.destroy();
    // a new session: the preview comes back from the store, the file does not
    const next = createAnalyzer({ workers: 0 });
    assert.equal(await next.cached('deezer:42'), b);
    assert.equal(await next.cached(key), null);
    next.destroy();
  } finally {
    delete globalThis.indexedDB;
  }
});

test('the stored cache is bounded: opened with more than 2000 records it starts over', async () => {
  const v = `|v${ANALYSIS_VERSION}`;
  const fill = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`deezer:${i}${v}`, { filler: i }]));
  try {
    const under = fakeIndexedDB(fill(2000));
    globalThis.indexedDB = under;
    let analyzer = createAnalyzer({ workers: 0 });
    await analyzer.cached('deezer:nothing');
    await settle();
    assert.equal(under.log.cleared, 0);
    assert.equal(under.data.size, 2000);
    analyzer.destroy();
    const over = fakeIndexedDB(fill(2001));
    globalThis.indexedDB = over;
    analyzer = createAnalyzer({ workers: 0 });
    await analyzer.cached('deezer:nothing');
    await settle();
    assert.equal(over.log.cleared, 1);
    assert.equal(over.data.size, 0);
    analyzer.destroy();
  } finally {
    delete globalThis.indexedDB;
  }
});

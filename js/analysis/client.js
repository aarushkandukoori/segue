// Main-thread front end of the analysis: AudioBuffer in → Analysis out.
//
//   1. cache lookup (memory → IndexedDB), keyed by `key` + ANALYSIS_VERSION
//   2. downmix to mono + resample to the analysis rate on the main thread, in ≤ ~8 ms slices
//      (a decoded 5-minute stereo buffer is ~115 MB; only the 26 MB mono copy leaves this thread)
//   3. analyzeTrack in a module Worker (pool of 2); if Workers cannot be used — or one dies — the same
//      code runs on the main thread during idle time instead
//   4. store the result
import { analyzeTrack, ANALYSIS_VERSION, ANALYSIS_RATE } from './analyze.js';
import { createResampler } from './dsp.js';

const DB_NAME = 'segue-analysis';
const STORE = 'analysis';
const MEMORY_LIMIT = 400; // entries kept in the in-memory cache (an Analysis is ~10–100 kB)
const SLICE_MS = 8;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Yield to the event loop without the 1 s timer clamp of background tabs. */
function breathe() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function whenIdle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });
}

/**
 * Mono mix at the analysis rate plus the true sample peak of the original channels.
 * @param {AudioBuffer} buffer
 * @returns {Promise<{pcm:Float32Array, sampleRate:number, peak:number}>}
 */
export async function prepareAudio(buffer) {
  const channels = buffer.numberOfChannels;
  const n = buffer.length;
  const sr = buffer.sampleRate;
  const mono = new Float32Array(n);
  let peak = 0;
  let t0 = now();
  const CHUNK = 262144;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    const g = 1 / channels;
    for (let a = 0; a < n; a += CHUNK) {
      const b = Math.min(n, a + CHUNK);
      for (let i = a; i < b; i++) {
        const v = data[i];
        mono[i] += v * g;
        const m = v < 0 ? -v : v;
        if (m > peak) peak = m; // NaN never passes this test
      }
      if (now() - t0 > SLICE_MS) {
        await breathe();
        t0 = now();
      }
    }
  }
  if (!(peak >= 0) || !isFinite(peak)) peak = 0;
  if (sr === ANALYSIS_RATE || n === 0) return { pcm: mono, sampleRate: sr, peak };
  const rs = createResampler(sr, ANALYSIS_RATE);
  const outLen = rs.outLength(n);
  const out = new Float32Array(outLen);
  const STEP = 16384;
  for (let a = 0; a < outLen; a += STEP) {
    rs.process(mono, out, a, Math.min(outLen, a + STEP));
    if (now() - t0 > SLICE_MS) {
      await breathe();
      t0 = now();
    }
  }
  return { pcm: out, sampleRate: ANALYSIS_RATE, peak };
}

function looksValid(a) {
  return (
    a &&
    a.v === ANALYSIS_VERSION &&
    Array.isArray(a.beats) &&
    a.beats.length > 0 &&
    a.wave &&
    a.wave.low instanceof Uint8Array &&
    a.key &&
    a.cues &&
    a.loudness
  );
}

/** IndexedDB with every failure mode folded into "no database" (private mode, quota, blocked, old Safari). */
function openDatabase() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (db) => {
      if (!settled) {
        settled = true;
        resolve(db);
      }
    };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return done(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        if (settled) db.close();
        else done(db);
      };
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
      setTimeout(() => done(null), 2500); // some browsers never answer in private windows
    } catch (err) {
      done(null);
    }
  });
}

/**
 * @param {{workers?: number}} [options]  workers: pool size (default 2); 0 = always analyse on the main thread
 * @returns {{
 *   analyze(buffer: AudioBuffer, opts: {key: string, bpmHint?: number}): Promise<import('./analyze.js').Analysis>,
 *   cached(key: string): Promise<import('./analyze.js').Analysis|null>,
 *   destroy(): void,
 *   readonly stats: {cacheHits:number, worker:number, main:number, workerFailures:number, storage:'indexeddb'|'memory'|'pending'}
 * }}
 */
export function createAnalyzer({ workers = 2 } = {}) {
  const poolSize = Math.max(0, Math.min(4, Math.floor(workers)));
  const suffix = `|v${ANALYSIS_VERSION}`;
  /** @type {Map<string, any>} */
  const memory = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();
  const stats = { cacheHits: 0, worker: 0, main: 0, workerFailures: 0, storage: 'pending' };
  let destroyed = false;

  // ---- storage ---------------------------------------------------------------------------------
  let dbPromise = null;
  const database = () => {
    if (!dbPromise) {
      dbPromise = openDatabase().then((db) => {
        stats.storage = db ? 'indexeddb' : 'memory';
        if (db) pruneOldVersions(db);
        return db;
      });
    }
    return dbPromise;
  };

  function pruneOldVersions(db) {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const req = store.openKeyCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (typeof cur.key === 'string' && !cur.key.endsWith(suffix)) store.delete(cur.key);
        cur.continue();
      };
    } catch (err) {
      /* best effort */
    }
  }

  function remember(key, analysis) {
    memory.delete(key);
    memory.set(key, analysis);
    if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  }

  async function readStored(key) {
    const db = await database();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key + suffix);
        req.onsuccess = () => resolve(looksValid(req.result) ? req.result : null);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function writeStored(key, analysis) {
    const db = await database();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.onerror = () => {};
      tx.onabort = () => {};
      tx.objectStore(STORE).put(analysis, key + suffix);
    } catch (err) {
      /* quota / closed database: the memory copy still serves this session */
    }
  }

  async function cached(key) {
    if (!key) return null;
    const hit = memory.get(key);
    if (hit) return hit;
    const stored = await readStored(String(key));
    if (stored) remember(key, stored);
    return stored;
  }

  // ---- worker pool -----------------------------------------------------------------------------
  /** @type {{worker: Worker, job: any}[]} */
  const pool = [];
  /** @type {any[]} */
  const queue = [];
  let workersUsable = poolSize > 0 && typeof Worker === 'function';
  let nextId = 1;

  function spawn() {
    const slot = { worker: null, job: null };
    try {
      slot.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      workersUsable = false;
      return null;
    }
    slot.worker.onmessage = (e) => {
      const job = slot.job;
      slot.job = null;
      if (job && e.data && e.data.id === job.id) {
        clearTimeout(job.timer);
        if (e.data.analysis && looksValid(e.data.analysis)) {
          stats.worker++;
          job.resolve(e.data.analysis);
        } else {
          job.fail();
        }
      }
      pump();
    };
    const broken = () => retire(slot);
    slot.worker.onerror = broken;
    slot.worker.onmessageerror = broken;
    pool.push(slot);
    return slot;
  }

  /** A worker failed to load or crashed: stop using Workers altogether and rescue its job. */
  function retire(slot) {
    stats.workerFailures++;
    workersUsable = false;
    const i = pool.indexOf(slot);
    if (i >= 0) pool.splice(i, 1);
    try {
      slot.worker.terminate();
    } catch (err) {
      /* already gone */
    }
    const job = slot.job;
    slot.job = null;
    if (job) {
      clearTimeout(job.timer);
      job.fail();
    }
    // jobs still waiting for a worker go to the main thread as well
    while (queue.length) queue.shift().fail();
  }

  function pump() {
    while (queue.length && workersUsable) {
      let slot = pool.find((s) => !s.job);
      if (!slot && pool.length < poolSize) slot = spawn();
      if (!slot) break;
      const job = queue.shift();
      slot.job = job;
      // generous watchdog: a preview takes ~0.1 s, a 10-minute file a few seconds
      job.timer = setTimeout(() => retire(slot), 20000 + job.seconds * 500);
      try {
        slot.worker.postMessage({ id: job.id, pcm: job.pcm, sampleRate: job.sampleRate, opts: job.opts }, [job.pcm.buffer]);
      } catch (err) {
        retire(slot);
      }
    }
    if (!workersUsable) while (queue.length) queue.shift().fail();
  }

  /** Run one analysis: Worker if possible, else (or on failure) the main thread. */
  async function compute(buffer, opts) {
    const prepared = await prepareAudio(buffer);
    if (destroyed) throw new Error('analyzer destroyed');
    const jobOpts = { bpmHint: opts.bpmHint > 0 ? opts.bpmHint : undefined, peak: prepared.peak, duration: buffer.duration };
    if (workersUsable) {
      const viaWorker = await new Promise((resolve) => {
        queue.push({
          id: nextId++,
          pcm: prepared.pcm,
          sampleRate: prepared.sampleRate,
          opts: jobOpts,
          seconds: buffer.duration || 0,
          timer: 0,
          resolve,
          fail: () => resolve(null),
        });
        pump();
      });
      if (viaWorker) return viaWorker;
      if (destroyed) throw new Error('analyzer destroyed');
    }
    // Main-thread fallback. The PCM went to the worker (transferred), so prepare it again.
    const again = prepared.pcm.length ? prepared : await prepareAudio(buffer);
    await whenIdle();
    stats.main++;
    return analyzeTrack(again.pcm, again.sampleRate, jobOpts);
  }

  async function analyze(buffer, opts = {}) {
    if (destroyed) throw new Error('analyzer destroyed');
    const key = opts.key ? String(opts.key) : '';
    if (key) {
      const hit = await cached(key);
      if (hit) {
        stats.cacheHits++;
        return hit;
      }
      const running = inFlight.get(key);
      if (running) return running;
    }
    const task = compute(buffer, opts).then((analysis) => {
      if (key) {
        remember(key, analysis);
        writeStored(key, analysis);
      }
      return analysis;
    });
    if (key) {
      inFlight.set(key, task);
      const clear = () => inFlight.delete(key);
      task.then(clear, clear);
    }
    return task;
  }

  function destroy() {
    destroyed = true;
    workersUsable = false;
    for (const slot of pool.splice(0)) {
      if (slot.job) {
        clearTimeout(slot.job.timer);
        slot.job.fail();
      }
      try {
        slot.worker.terminate();
      } catch (err) {
        /* already gone */
      }
    }
    while (queue.length) queue.shift().fail();
    memory.clear();
    if (dbPromise) dbPromise.then((db) => db && db.close()).catch(() => {});
  }

  return {
    analyze,
    cached,
    destroy,
    get stats() {
      return { ...stats };
    },
  };
}

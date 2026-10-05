// The conductor owns a live set: which tracks are being prepared, which one plays, what comes next.
//
//   crate    every track of the playlist as an entry: resolve → fetch bytes → decode → analyse, a few at
//            a time, in the set's seeded base order. Compressed bytes are kept for the tracks about to
//            play; decoded AudioBuffers only for the ones in or next to the mix.
//   set      seed → planner. The opener is picked from the head of the order, then for every next slot
//            the conductor waits for the crate window (first 5 unplayed tracks) to settle, lets the
//            planner choose and plan, and hands the whole transition to the engine seconds ahead.
//
// Timing rule: nothing audible ever depends on a timer. Timers (and engine events) only wake pump(),
// which looks at the engine's clock and decides whether something should be planned. If a timer is
// late (background tab) the plan is simply made later; if a track is not ready in time the current
// one plays out and the next enters through the planner's late path.
//
// Races: async work captures a generation token (crateGen for per-track work, setGen for anything
// that touches the running set) and drops its result when the token has moved on.

import { createPlanner, holdPlayAt, MODES } from './planner.js';
import { createRng, randomSeed } from '../util/rng.js';
import { evalParam, sortEvents, timeAtPosition } from './timeline.js';

/** Crate window: the next track is chosen among the first WINDOW unplayed tracks of the base order. */
export const WINDOW = 5;
/** The opener is chosen among the first HEAD tracks of the base order. */
export const HEAD = 3;
/** Seconds between "now" and the first event of a fresh plan (scheduling happens well inside this). */
const MARGIN = 0.3;
/** After the first head track is ready, how long the rest of the head may take before we start anyway. */
const HEAD_GRACE_MS = 2500;
/** Plays remembered for the setlist. */
const HISTORY = 60;
/** Playlists up to this size keep their compressed audio for the whole session (no refetch on replays). */
const KEEP_BYTES_UP_TO = 24;
const TICK_MS = 200;

const REST = { gain: 1, src: 1, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, delaySend: 0, reverbSend: 0 };
const STAGE_WEIGHT = { resolve: 0.15, fetch: 0.45, decode: 0.7, analyze: 0.85 };

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 20);

/**
 * decodeAudioData as a promise in every browser (older Safari only has the callback form).
 * The ArrayBuffer is detached by the call: pass a copy if the bytes are still needed.
 * @param {BaseAudioContext} ctx
 * @param {ArrayBuffer} bytes
 * @returns {Promise<AudioBuffer>}
 */
export function decodeAudio(ctx, bytes) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Hand one planned Transition to the engine. `prevPlay` (the conductor's own copy of the outgoing
 * play, or null for an opener) is extended in place so it keeps describing what the engine will do.
 * The whole transition goes over at once: it may carry mid-solo tricks that happen before tStart.
 * @param {object} engine
 * @param {object|null} prevPlay
 * @param {object} tr Transition
 * @param {AudioBuffer} buffer decoded audio of the incoming track
 */
export function applyTransition(engine, prevPlay, tr, buffer) {
  if (prevPlay && tr.from === prevPlay.id) {
    if (tr.aEvents.length) prevPlay.events = sortEvents(prevPlay.events.concat(tr.aEvents));
    if (tr.aRate.length) prevPlay.rate = prevPlay.rate.concat(tr.aRate);
    prevPlay.endAt = tr.aEndAt;
    engine.extendPlay(prevPlay.id, { events: tr.aEvents, rate: tr.aRate, endAt: tr.aEndAt });
  }
  engine.addPlay(tr.play, buffer);
  engine.addFx(tr.fx, tr.fxEvents);
}

/**
 * Mid-solo tricks inside a transition, as time windows: everything the plan does to the outgoing
 * strip before the transition proper begins. Used for the ticker and to keep Skip away from a strip
 * that is in the middle of a move.
 * @returns {{t0:number, t1:number, label:string}[]}
 */
export function trickWindows(tr) {
  const out = [];
  if (!tr || !Array.isArray(tr.aEvents)) return out;
  const edge = tr.tStart - 1e-3;
  const spans = [];
  for (const e of tr.aEvents) if (e.t < edge) spans.push([e.t, e.t]);
  for (const f of tr.fx || []) if (f.t < edge) spans.push([f.t, f.t + (f.dur > 0 ? f.dur : 0)]);
  spans.sort((a, b) => a[0] - b[0]);
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last.t1 + 1.5) last.t1 = Math.max(last.t1, b);
    else out.push({ t0: a, t1: b, label: '' });
  }
  const marks = (tr.marks || []).filter((m) => m.t < edge);
  for (const w of out) {
    const m = marks.find((x) => x.t >= w.t0 - 0.1 && x.t <= w.t1 + 0.1);
    w.label = m ? m.label : 'Trick';
  }
  // A 30 ms strip tidy-up after a Skip is not a trick.
  return out.filter((w) => w.t1 - w.t0 > 0.2);
}

/**
 * Order for the next pass through the crate: a fresh seeded shuffle, minus what is still waiting,
 * with the tracks heard most recently moved to the back so nothing comes round again straight away.
 * @param {string} seed
 * @param {number} cycle 1, 2, 3 …
 * @param {string[]} alive playable track ids
 * @param {string[]} waiting ids still in the queue
 * @param {string[]} recent most recently played ids, oldest first
 */
export function nextCycleOrder(seed, cycle, alive, waiting, recent) {
  const skip = new Set(waiting);
  const fresh = createRng(`${seed}|cycle|${cycle}`)
    .shuffle(alive)
    .filter((id) => !skip.has(id));
  const hold = new Set(recent.slice(-Math.min(4, Math.floor(alive.length / 2))));
  return fresh.filter((id) => !hold.has(id)).concat(fresh.filter((id) => hold.has(id)));
}

function newEntry(meta, idx) {
  return {
    id: meta.id,
    meta,
    idx,
    /** @type {any} AudioRef */ ref: null,
    /** @type {any} Analysis (shared with the analyzer cache: never mutated) */ analysis: null,
    /** @type {ArrayBuffer|null} compressed audio (previews); local files are re-read from the File */ bytes: null,
    /** @type {AudioBuffer|null} */ buffer: null,
    bufferAt: 0,
    /** @type {Promise<AudioBuffer>|null} */ decoding: null,
    /** @type {'idle'|'working'|'ready'|'failed'} */ status: 'idle',
    stage: '',
    /** @type {{code:string, message:string}|null} */ error: null,
    dead: false,
    tries: 0,
    retryAt: 0,
    resolveTried: false,
    pinned: 0,
    playCount: 0,
  };
}

/**
 * @param {{
 *   engine: any, analyzer: any, resolver: any,
 *   decode?: (bytes: ArrayBuffer) => Promise<AudioBuffer>,
 *   clock?: () => number,            wall clock in ms (tests)
 *   timers?: boolean,                false = no interval; the caller drives poke() (tests)
 * }} deps
 */
export function createConductor(deps) {
  const { engine, analyzer, resolver } = deps;
  const decode = deps.decode || ((bytes) => decodeAudio(engine.ctx, bytes));
  const clock = deps.clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const useTimers = deps.timers !== false;

  // ── events ───────────────────────────────────────────────────────────────────────────────────
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  }
  function emit(type, payload) {
    for (const fn of [...(listeners.get(type) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[conductor] listener failed', err);
      }
    }
  }

  // ── crate state (lives as long as the playlist) ──────────────────────────────────────────────
  let crateGen = 0;
  /** @type {AbortController|null} */
  let abort = null;
  /** @type {any} Playlist */
  let playlist = null;
  /** @type {Map<string, ReturnType<typeof newEntry>>} */
  let entries = new Map();
  /** @type {string[]} */
  let ids = [];
  let jobs = 0;
  let bgJobs = 0;
  let stamp = 0;
  let longTracks = false;

  // ── set state (lives as long as the seed) ────────────────────────────────────────────────────
  let setGen = 0;
  let seed = '';
  let vibe = 0.5;
  let userMode = 'medium';
  let volume = 1;
  /** @type {ReturnType<typeof createPlanner>|null} */
  let planner = null;
  /** @type {string[]} */
  let order = [];
  /** @type {string[]} unplayed ids in base order; later cycles are appended */
  let queue = [];
  let cycle = 0;
  /** @type {any[]} PlayRec: {id, play, entry, tr, buffer, key, tricks, gone} */
  let plays = [];
  let started = false;
  let starting = false;
  let allowed = false;
  let paused = false;
  /** @type {Promise<void>|null} serialises planning and Skip */
  let busy = null;
  /** @type {string|null} */
  let fatal = null;
  let headSince = 0;
  let resetDone = Promise.resolve();
  let timer = null;
  let rev = 0;
  let lastSig = '';
  let lastStatus = '';
  let offStart = null;
  let offEnd = null;

  /** Per-frame data for the UI: the play record on each deck (null = empty). Same object every time. */
  const live = { /** @type {[any, any]} */ decks: [null, null] };

  const bump = () => {
    rev++;
  };
  const isLocal = () => !!playlist && playlist.source === 'local';
  const planMode = () => (isLocal() ? (userMode === 'short' || userMode === 'full' ? userMode : 'medium') : 'preview');
  const concurrency = () => (longTracks ? 2 : 3);
  const prepAhead = () => (longTracks ? WINDOW + 1 : WINDOW + 3);
  const isReady = (e) => e.status === 'ready';
  const settled = (e) => e.status === 'ready' || e.status === 'failed';
  const cand = (e) => ({ id: e.id, artist: e.meta.artist || '', analysis: e.analysis });

  /** Queue entries that can still be played, in order (dead ones are skipped), up to `max`. */
  function upcoming(max) {
    const out = [];
    for (const id of queue) {
      const e = entries.get(id);
      if (!e || e.dead) continue;
      out.push(e);
      if (out.length >= max) break;
    }
    return out;
  }

  // ── preparation pipeline ─────────────────────────────────────────────────────────────────────

  const canWork = (e, nowMs) => e.status === 'idle' || (e.status === 'failed' && !e.dead && nowMs >= e.retryAt);

  function pickJob() {
    const nowMs = clock();
    for (const e of upcoming(prepAhead())) {
      if (!isReady(e) && canWork(e, nowMs)) return { kind: 'prepare', e };
    }
    // Background: find out which of the remaining tracks have audio at all (cheap, keeps the setlist
    // honest). Bounded so slow catalogue fallbacks cannot starve the look-ahead above.
    if (bgJobs < Math.min(2, concurrency() - 1)) {
      for (const id of order) {
        const e = entries.get(id);
        if (e && !e.ref && !e.resolveTried && e.status === 'idle') return { kind: 'resolve', e };
      }
    }
    return null;
  }

  function schedule() {
    if (!playlist || fatal) return;
    while (jobs < concurrency()) {
      const job = pickJob();
      if (!job) break;
      run(job);
    }
  }

  function run(job) {
    const { e, kind } = job;
    const g = crateGen;
    const signal = abort ? abort.signal : undefined;
    jobs++;
    if (kind === 'resolve') bgJobs++;
    e.status = 'working';
    e.stage = e.ref ? 'fetch' : 'resolve';
    bump();
    const work = kind === 'prepare' ? prepare(e, g, signal) : resolveOnly(e, g, signal);
    work
      .catch((err) => {
        if (g === crateGen) failEntry(e, err);
      })
      .then(() => {
        jobs--;
        if (kind === 'resolve') bgJobs--;
        if (g !== crateGen) return;
        bump();
        pump();
      });
  }

  async function resolveOnly(e, g, signal) {
    e.resolveTried = true;
    const ref = await resolver.resolveTrack(e.meta, { signal });
    if (g !== crateGen) return;
    e.ref = ref;
    e.status = 'idle';
    e.stage = '';
  }

  async function prepare(e, g, signal) {
    if (!e.ref) {
      e.stage = 'resolve';
      e.resolveTried = true;
      const ref = await resolver.resolveTrack(e.meta, { signal });
      if (g !== crateGen) return;
      e.ref = ref;
      bump();
    }
    const ref = e.ref;
    let analysis = e.analysis;
    if (!analysis) {
      try {
        analysis = await analyzer.cached(ref.key);
      } catch {
        analysis = null;
      }
      if (g !== crateGen) return;
    }
    let bytes = e.bytes;
    if (!ref.file && !bytes) {
      e.stage = 'fetch';
      bump();
      bytes = await resolver.fetchAudio(ref, { signal });
      if (g !== crateGen) return;
    }
    if (!analysis) {
      e.stage = 'decode';
      bump();
      // decodeAudioData detaches what it is given: previews hand over a copy and keep the original.
      const data = ref.file ? await resolver.fetchAudio(ref, { signal }) : bytes.slice(0);
      if (g !== crateGen) return;
      let buffer;
      try {
        buffer = await decode(data);
      } catch (err) {
        throw Object.assign(new Error("This audio couldn't be decoded."), { code: 'decode', cause: err });
      }
      if (g !== crateGen) return;
      e.stage = 'analyze';
      bump();
      analysis = await analyzer.analyze(buffer, { key: ref.key, bpmHint: ref.bpmHint });
      if (g !== crateGen) return;
      keepBuffer(e, buffer);
    }
    if (!analysis || !(analysis.duration >= 3)) {
      throw Object.assign(new Error('This track is too short to mix.'), { code: 'too-short' });
    }
    e.analysis = analysis;
    e.bytes = bytes || null;
    e.status = 'ready';
    e.stage = '';
    e.error = null;
    if (!headSince) headSince = clock();
  }

  function failEntry(e, err) {
    e.stage = '';
    if (isAbort(err)) {
      e.status = 'idle';
      return;
    }
    const code = (err && err.code) || 'error';
    e.tries++;
    e.status = 'failed';
    e.error = { code: String(code), message: (err && err.message) || 'Something went wrong with this track.' };
    // Worth another go: the network hiccuped, or a catalogue was too busy to be asked.
    const network = code === 'network';
    const busyCatalogue = code === 'no-match' && err && err.final === false;
    if (network && (started || e.tries < 3)) {
      e.retryAt = clock() + Math.min(60000, 4000 * 2 ** (e.tries - 1));
    } else if (busyCatalogue && e.tries < 3) {
      e.retryAt = clock() + 45000;
    } else {
      e.dead = true;
      if (!err || (!err.code && !isAbort(err))) console.error('[conductor] track failed unexpectedly', e.meta && e.meta.title, err);
    }
  }

  // ── decoded-buffer window ────────────────────────────────────────────────────────────────────

  function keepBuffer(e, buffer) {
    e.buffer = buffer;
    e.bufferAt = ++stamp;
    if (buffer && buffer.duration > 75) longTracks = true;
    trimBuffers();
  }

  /** Keep decoded audio only for what is in the mix, about to be, or was decoded a moment ago. */
  function trimBuffers() {
    const keep = new Set();
    for (const rec of plays) if (!rec.gone) keep.add(rec.entry);
    if (!started) for (const e of upcoming(HEAD)) keep.add(e);
    const spare = [];
    for (const e of entries.values()) {
      if (!e.buffer || keep.has(e) || e.pinned > 0) continue;
      spare.push(e);
    }
    spare.sort((a, b) => b.bufferAt - a.bufferAt);
    for (let i = longTracks ? 0 : 2; i < spare.length; i++) spare[i].buffer = null;
  }

  /** Decoded audio for an entry that is ready: from the window, or decoded again from the bytes. */
  function ensureBuffer(e) {
    if (e.buffer) {
      e.bufferAt = ++stamp;
      return Promise.resolve(e.buffer);
    }
    if (e.decoding) return e.decoding;
    const g = crateGen;
    const signal = abort ? abort.signal : undefined;
    const task = (async () => {
      let data;
      if (e.ref && e.ref.file) data = await resolver.fetchAudio(e.ref, { signal });
      else if (e.bytes) data = e.bytes.slice(0);
      else {
        // Bytes were let go after an earlier play: fetch them again (the resolver renews expired links).
        const bytes = await resolver.fetchAudio(e.ref, { signal });
        if (g === crateGen && entries.size <= KEEP_BYTES_UP_TO) e.bytes = bytes;
        data = bytes.slice(0);
      }
      const buffer = await decode(data);
      if (g === crateGen) keepBuffer(e, buffer);
      return buffer;
    })();
    e.decoding = task;
    const clear = () => {
      if (e.decoding === task) e.decoding = null;
    };
    task.then(clear, clear);
    return task;
  }

  // ── the set ──────────────────────────────────────────────────────────────────────────────────

  /** Set time the play's own audio runs out (its usable end at the rate it is planned to play). */
  function audioEnd(rec) {
    const an = rec.entry.analysis;
    const end = an && an.cues && an.cues.end > 0 ? Math.min(an.cues.end, an.duration) : an ? an.duration : 0;
    const t = timeAtPosition({ ...rec.play, endAt: null }, end);
    return Number.isFinite(t) ? t : rec.play.startAt + end;
  }

  /** Where the planner will probably leave this play (set time): decides how long we may wait. */
  function exitEstimate(rec) {
    const end = audioEnd(rec);
    const mode = planner ? planner.mode : 'preview';
    if (mode === 'short') return Math.min(end, rec.play.startAt + 45);
    if (mode === 'medium') return Math.min(end, rec.play.startAt + 90);
    return end;
  }

  /** Index of the play the set is "on": the last one whose incoming transition has begun. */
  function currentIndex(now) {
    let k = 0;
    for (let i = plays.length - 1; i > 0; i--) {
      if (now >= plays[i].tr.tStart) {
        k = i;
        break;
      }
    }
    return k;
  }

  function commit(tr, head, e, buffer) {
    applyTransition(engine, head ? head.play : null, tr, buffer);
    const rec = {
      id: tr.play.id,
      play: { ...tr.play, events: tr.play.events.slice(), rate: tr.play.rate.slice() },
      entry: e,
      tr,
      buffer,
      key: `${e.id}|${e.playCount}`,
      tricks: trickWindows(tr),
      gone: false,
    };
    plays.push(rec);
    e.playCount++;
    const at = queue.indexOf(e.id);
    if (at >= 0) queue.splice(at, 1);
    // Big playlists let the compressed audio go once it is in the mix; it is fetched again if the
    // track comes round in a later pass.
    if (e.bytes && entries.size > KEEP_BYTES_UP_TO) {
      e.bytes = null;
      e.status = 'idle';
    }
    if (plays.length > HISTORY) plays = plays.slice(-HISTORY);
    bump();
    return rec;
  }

  function refill() {
    const alive = ids.filter((id) => !entries.get(id).dead);
    if (!alive.length) return;
    const want = Math.min(WINDOW, alive.length);
    for (let guard = 0; guard < 2 && upcoming(want).length < want; guard++) {
      const more = nextCycleOrder(
        seed,
        cycle + 1,
        alive,
        queue,
        plays.map((r) => r.entry.id),
      );
      if (!more.length) break;
      cycle++;
      queue.push(...more);
      bump();
    }
  }

  function failFatal(message) {
    if (fatal) return;
    fatal = message;
    bump();
    emit('error', { message });
  }

  function checkFatal() {
    if (started || fatal || !playlist) return;
    let alive = 0;
    let dead = 0;
    let ready = 0;
    let network = 0;
    for (const e of entries.values()) {
      if (e.dead) {
        dead++;
        if (e.error && e.error.code === 'network') network++;
      } else alive++;
      if (isReady(e)) ready++;
    }
    // Every track is out — or the first dozen all were, which says the same about the rest.
    if (alive > 0 && !(ready === 0 && dead >= 12)) return;
    if (network * 2 >= dead) failFatal("Couldn't reach the music catalogues. Check your connection and try again.");
    else if (isLocal()) failFatal("None of those files could be decoded. Try MP3, M4A, WAV or FLAC files.");
    else failFatal("Couldn't find playable previews for the tracks in this playlist. Try another one.");
  }

  /** Pick and start the opener once the head of the order has settled. */
  function tryStart() {
    if (started || starting || !allowed || fatal || !planner) return;
    const head = upcoming(HEAD);
    const ready = head.filter(isReady);
    if (!ready.length) return;
    const all = head.every(settled) && head.length >= Math.min(HEAD, ids.length);
    if (!all && clock() - headSince < HEAD_GRACE_MS) return;
    starting = true;
    const g = setGen;
    const idx = planner.chooseNext(null, ready.map(cand), { playIndex: 0, recentArtists: [] });
    const e = ready[idx >= 0 ? idx : 0];
    e.pinned++;
    (async () => {
      try {
        let buffer;
        try {
          buffer = await ensureBuffer(e);
        } catch (err) {
          // The opener's audio went bad between analysis and now: drop it, the next pump picks another.
          if (g === setGen && !isAbort(err)) failEntry(e, Object.assign(new Error("This audio couldn't be decoded."), { code: (err && err.code) || 'decode', final: err && err.final }));
          return;
        }
        await resetDone;
        if (g !== setGen) return;
        try {
          const tr = planner.first({ id: e.id, analysis: e.analysis }, { startAt: 0 });
          // Queued by the engine until its clock starts, so the opener begins exactly at set time 0.
          commit(tr, null, e, buffer);
          engine.setVolume(volume);
          await engine.start();
        } catch (err) {
          console.error('[conductor] could not start audio', err);
          if (g === setGen) failFatal("This browser couldn't start audio playback.");
          return;
        }
        if (g !== setGen) return;
        started = true;
        paused = false;
        bump();
        emit('start', { seed, trackId: e.id });
      } finally {
        e.pinned--;
        if (g === setGen) {
          starting = false;
          pump();
        }
      }
    })();
  }

  /** First set time a new plan may touch. Bucketed while there is room, so the same seed plans the same tricks. */
  function earliestFor(head, now) {
    const base = now + MARGIN;
    const solo = head.play.soloFrom;
    if (!(base > solo)) return base; // the planner starts at soloFrom anyway: nothing depends on "now"
    const q = solo + Math.ceil((base - solo) / 4) * 4;
    return exitEstimate(head) - q > 20 ? q : base;
  }

  /** Run one planning step at a time; a step that belongs to an older set does nothing. */
  function exclusive(fn) {
    const task = (async () => {
      try {
        await fn();
      } catch (err) {
        if (!isAbort(err)) console.error('[conductor] planning failed', err);
      }
    })();
    busy = task;
    task.then(() => {
      if (busy === task) busy = null;
      pump();
    });
    return task;
  }

  function maybePlan(now) {
    if (busy || paused || !plays.length) return;
    const head = plays[plays.length - 1];
    // One transition ahead at a time: wait until the newest play is itself on its way in.
    if (now < head.play.startAt - 0.5) return;
    const alive = ids.reduce((n, id) => n + (entries.get(id).dead ? 0 : 1), 0);
    const win = upcoming(WINDOW);
    const ready = win.filter(isReady);
    if (!ready.length) return;
    const full = win.length >= Math.min(WINDOW, alive) && win.every(settled);
    if (!full) {
      const lead = planner.mode === 'preview' ? 16 : 26;
      const planBy = Math.max(head.play.soloFrom + 1, exitEstimate(head) - lead);
      if (now < planBy) return;
    }
    const g = setGen;
    exclusive(async () => {
      const cur = head.entry;
      const recent = plays.slice(-3).map((r) => r.entry.meta.artist || '');
      const idx = planner.chooseNext(cand(cur), ready.map(cand), { playIndex: head.id + 1, recentArtists: recent });
      const e = ready[idx >= 0 ? idx : 0];
      e.pinned++;
      try {
        let buffer;
        try {
          buffer = await ensureBuffer(e);
        } catch (err) {
          if (g === setGen && !isAbort(err)) failEntry(e, Object.assign(new Error("This audio couldn't be decoded."), { code: (err && err.code) || 'decode', final: err && err.final }));
          return;
        }
        if (g !== setGen || plays[plays.length - 1] !== head) return;
        const tNow = engine.now();
        const tr = planner.next({ play: head.play, analysis: cur.analysis }, { id: e.id, analysis: e.analysis }, { earliest: earliestFor(head, tNow) });
        commit(tr, head, e, buffer);
      } finally {
        e.pinned--;
      }
    });
  }

  /** What Skip would act on right now, or null when Skip is not available. */
  function skipTarget(now) {
    if (!started || paused || busy || fatal || !plays.length) return null;
    const k = currentIndex(now);
    const cur = plays[k];
    const next = plays[k + 1] || null;
    if (k < plays.length - 2) return null;
    if (now < cur.play.soloFrom + 0.1) return null; // still mixing in
    if (next && now > next.tr.tStart - 0.4) return null; // already mixing out
    if (audioEnd(cur) - now < 1.2) return null; // nothing left to mix out of
    if (next) {
      for (const w of next.tricks) if (now > w.t0 - 0.3 && now < w.t1 + 0.25) return null;
    }
    // The strip must be at rest: a cancel freezes whatever a trick was in the middle of.
    const ev = cur.play.events;
    for (const p of Object.keys(REST)) {
      const v = evalParam(ev, p, now, REST[p]);
      const ok = p === 'hpf' ? v < 40 : p === 'lpf' ? v > 15000 : Math.abs(v - REST[p]) < 0.02;
      if (!ok) return null;
    }
    if (next) return { cur, next, entry: next.entry };
    const ready = upcoming(WINDOW).filter(isReady);
    if (!ready.length) return null;
    return { cur, next: null, entry: null, ready };
  }

  /** Skip to the next track with a quick transition. Only while a single track is playing. */
  function skip() {
    if (!started) return false;
    const target = skipTarget(engine.now());
    if (!target) return false;
    const g = setGen;
    exclusive(async () => {
      const { cur } = target;
      let e = target.entry;
      if (!e) {
        const recent = plays.slice(-3).map((r) => r.entry.meta.artist || '');
        const idx = planner.chooseNext(cand(cur.entry), target.ready.map(cand), { playIndex: cur.id + 1, recentArtists: recent });
        e = target.ready[idx >= 0 ? idx : 0];
      }
      e.pinned++;
      try {
        const buffer = target.next && target.next.buffer ? target.next.buffer : await ensureBuffer(e);
        if (g !== setGen) return;
        // Things may have moved while the audio was decoding: only act if Skip still means the same.
        const again = skipTarget0(engine.now());
        if (!again || again.cur !== cur || (again.next || null) !== (target.next || null)) return;
        // A hair ahead of the clock, so the engine and the planner cut at exactly the same instant.
        const T = engine.now() + 0.01;
        engine.cancelFrom(T);
        if (target.next) {
          plays.pop();
          e.playCount--;
        }
        cur.play = engine.getPlay(cur.id) || holdPlayAt(cur.play, T);
        const tr = planner.next(
          { play: cur.play, analysis: cur.entry.analysis },
          { id: e.id, analysis: e.analysis },
          { earliest: T + 0.25, quick: true, cancelledAt: T },
        );
        commit(tr, cur, e, buffer);
        emit('skip', { to: e.id });
      } finally {
        e.pinned--;
      }
    });
    return true;
  }
  /** skipTarget without the "nothing else is planning" condition (used from inside the planning step). */
  function skipTarget0(now) {
    const was = busy;
    busy = null;
    try {
      return skipTarget(now);
    } finally {
      busy = was;
    }
  }

  function retire(now) {
    for (const rec of plays) {
      if (rec.gone) continue;
      const end = rec.play.endAt != null ? rec.play.endAt : audioEnd(rec) + 0.5;
      if (now > end + 1) {
        rec.gone = true;
        rec.buffer = null;
        bump();
      }
    }
  }

  // ── heartbeat ────────────────────────────────────────────────────────────────────────────────

  function pump() {
    if (!playlist) return;
    if (!fatal) {
      schedule();
      if (!started) {
        tryStart();
        checkFatal();
      } else {
        const now = engine.now();
        retire(now);
        refill();
        schedule();
        maybePlan(now);
      }
      trimBuffers();
    }
    publish();
  }

  function publish() {
    const st = started ? null : status();
    const text = st ? `${st.title}|${st.detail}|${st.progress}` : '';
    if (text !== lastStatus) {
      lastStatus = text;
      if (st) emit('status', st);
    }
    const now = started ? engine.now() : 0;
    const k = started ? currentIndex(now) : 0;
    updateLive(now);
    const sig = [
      rev,
      started,
      paused,
      k,
      started && k > 0 && now < plays[k].tr.tEnd,
      live.decks[0] ? live.decks[0].id : -1,
      live.decks[1] ? live.decks[1].id : -1,
      trickNow(now, k) ? 1 : 0,
      started && !!skipTarget(now),
    ].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      emit('change', undefined);
    }
  }

  function updateLive(now) {
    for (let d = 0; d < 2; d++) {
      let pick = null;
      if (started) {
        for (const rec of plays) {
          if (rec.gone || rec.play.deck !== d) continue;
          // A deck keeps its record until that one is over; the next one cued on it shows up after.
          const end = rec.play.endAt != null ? rec.play.endAt : Infinity;
          if (now < end + 0.6) {
            pick = rec;
            break;
          }
        }
      }
      live.decks[d] = pick;
    }
  }

  function trickNow(now, k) {
    const next = plays[k + 1];
    if (!started || !next) return null;
    for (const w of next.tricks) if (now >= w.t0 - 0.05 && now <= w.t1) return w;
    return null;
  }

  function status() {
    if (!playlist) return null;
    const head = upcoming(HEAD);
    const total = Math.max(1, Math.min(HEAD, ids.length));
    const name = (e) => (e.meta.artist ? `${e.meta.artist} · ${e.meta.title}` : e.meta.title);
    let done = 0;
    let working = null;
    for (const e of head) {
      if (settled(e)) done += 1;
      else if (e.status === 'working') {
        done += STAGE_WEIGHT[e.stage] || 0;
        if (!working || (STAGE_WEIGHT[e.stage] || 0) > (STAGE_WEIGHT[working.stage] || 0)) working = e;
      }
    }
    let title = 'Digging through the crate';
    let detail = 'Lining up the first tracks…';
    if (working) {
      if (working.stage === 'resolve') detail = `Finding audio — ${name(working)}`;
      else if (working.stage === 'fetch') detail = isLocal() ? `Reading — ${name(working)}` : `Fetching the preview — ${name(working)}`;
      else {
        title = 'Counting the beats';
        detail = `Tempo and key — ${name(working)}`;
      }
    } else if (done >= total) {
      title = 'Dropping the needle';
      detail = allowed ? 'Starting the set…' : 'Ready when you are.';
    }
    return { title, detail, progress: clamp01(done / total) };
  }

  // ── public: lifecycle ────────────────────────────────────────────────────────────────────────

  function startTimer() {
    if (!useTimers || timer) return;
    timer = setInterval(pump, TICK_MS);
    if (!offStart && engine.on) {
      offStart = engine.on('playstart', pump);
      offEnd = engine.on('playend', pump);
    }
  }

  function newPlanner() {
    planner = createPlanner({ seed, vibe, mode: planMode() });
    order = planner.order(ids);
    queue = order.slice();
    cycle = 0;
    plays = [];
    started = false;
    starting = false;
    paused = false;
    busy = null;
    fatal = null;
    headSince = [...entries.values()].some(isReady) ? clock() : 0;
    for (const e of entries.values()) e.playCount = 0;
    live.decks[0] = live.decks[1] = null;
    lastSig = '';
    lastStatus = '';
    bump();
  }

  /**
   * Load a playlist and begin preparing it. Playback starts as soon as an opener is ready and
   * begin() has been called (autostart: true calls it for you; a share link waits for the tap).
   * @param {any} pl Playlist
   * @param {{seed?: string, vibe?: number, mode?: string, autostart?: boolean}} [opts]
   */
  function load(pl, opts = {}) {
    stop();
    crateGen++;
    setGen++;
    abort = typeof AbortController === 'function' ? new AbortController() : null;
    playlist = pl;
    entries = new Map();
    ids = [];
    for (const meta of pl.tracks || []) {
      if (!meta || meta.id == null || entries.has(meta.id)) continue;
      entries.set(meta.id, newEntry(meta, ids.length));
      ids.push(meta.id);
    }
    jobs = 0;
    bgJobs = 0;
    longTracks = false;
    seed = String(opts.seed || randomSeed());
    if (Number.isFinite(opts.vibe)) vibe = clamp01(opts.vibe);
    if (MODES.includes(opts.mode)) userMode = opts.mode;
    allowed = !!opts.autostart;
    newPlanner();
    if (!ids.length) {
      failFatal('That playlist has no songs in it.');
      return;
    }
    startTimer();
    pump();
  }

  /** A user gesture has happened: the set may start as soon as its opener is ready. */
  function begin() {
    if (!playlist) return;
    allowed = true;
    pump();
  }

  /** Same crate, new seed: stop the mix, reshuffle, start again from a new opener. */
  function newSet(nextSeed) {
    if (!playlist) return;
    setGen++;
    resetDone = Promise.resolve(engine.reset()).catch(() => {});
    seed = String(nextSeed || randomSeed());
    newPlanner();
    allowed = true;
    pump();
  }

  /** Stop everything and forget the playlist. */
  function stop() {
    if (!playlist) return;
    setGen++;
    crateGen++;
    if (abort) abort.abort();
    abort = null;
    if (timer) clearInterval(timer);
    timer = null;
    resetDone = Promise.resolve(engine.reset()).catch(() => {});
    playlist = null;
    entries = new Map();
    ids = [];
    order = [];
    queue = [];
    plays = [];
    started = false;
    starting = false;
    allowed = false;
    paused = false;
    busy = null;
    fatal = null;
    live.decks[0] = live.decks[1] = null;
    lastSig = '';
    lastStatus = '';
    bump();
  }

  async function pause() {
    if (!started || paused) return;
    paused = true;
    bump();
    publish();
    await engine.pause();
  }

  async function resume() {
    if (!started || !paused) return;
    await engine.resume();
    paused = false;
    bump();
    pump();
  }

  function setVibe(v) {
    if (!Number.isFinite(v)) return;
    vibe = clamp01(v);
    if (planner) planner.setVibe(vibe);
    bump();
  }

  /** Track length for full-length sources: 'short' | 'medium' | 'full'. Previews always use 'preview'. */
  function setMode(m) {
    if (!MODES.includes(m)) return;
    userMode = m;
    if (planner) planner.setMode(planMode());
    bump();
    publish();
  }

  function setVolume(v) {
    if (!Number.isFinite(v)) return;
    volume = Math.max(0, v);
    engine.setVolume(volume);
  }

  // ── public: what the UI shows ────────────────────────────────────────────────────────────────

  function deckInfo(rec) {
    if (!rec) return null;
    const e = rec.entry;
    const an = e.analysis;
    const ref = e.ref || {};
    return {
      playId: rec.id,
      title: e.meta.title,
      artist: e.meta.artist || ref.matchedArtist || '',
      artwork: e.meta.artwork || ref.artwork,
      link: e.meta.link || ref.link,
      bpm: an.bpm,
      camelot: an.key.camelot,
      keyName: an.key.name,
      duration: an.duration,
      provider: ref.provider || 'deezer',
      wave: an.wave,
      beats: an.beats,
      downbeat: an.downbeat,
      cues: an.cues,
    };
  }

  function transitionInfo(now, k) {
    if (!started || !plays.length) return null;
    const cur = plays[k];
    const view = (rec, state) => ({
      type: rec.tr.type,
      label: rec.tr.label,
      why: rec.tr.why,
      fromTitle: rec.tr.from >= 0 && plays[plays.indexOf(rec) - 1] ? plays[plays.indexOf(rec) - 1].entry.meta.title : '',
      toTitle: rec.entry.meta.title,
      state,
      tStart: rec.tr.tStart,
      tEnd: rec.tr.tEnd,
      marks: rec.tr.marks.filter((m) => m.t >= rec.tr.tStart - 0.01),
      synced: !!rec.tr.synced,
    });
    if (now < cur.tr.tEnd) return view(cur, 'active');
    const next = plays[k + 1];
    if (!next) return null;
    const w = trickNow(now, k);
    if (w) {
      return {
        type: 'trick',
        label: w.label,
        why: `A little something on ${cur.entry.meta.title}`,
        fromTitle: '',
        toTitle: '',
        state: 'active',
        tStart: w.t0,
        tEnd: w.t1,
        marks: [],
        synced: false,
      };
    }
    return view(next, 'upcoming');
  }

  function setlistItems(now, k) {
    const items = [];
    const seen = new Set();
    const row = (e, key, state, extra) => {
      if (seen.has(key)) return;
      seen.add(key);
      const an = e.analysis;
      const ref = e.ref || {};
      items.push({
        key,
        title: e.meta.title,
        artist: e.meta.artist || '',
        artwork: e.meta.artwork || ref.artwork,
        bpm: an ? Math.round(an.bpm) : undefined,
        camelot: an ? an.key.camelot : undefined,
        state,
        link: e.meta.link || ref.link,
        ...extra,
      });
    };
    const mixing = started && k > 0 && now < plays[k].tr.tEnd;
    plays.forEach((rec, i) => {
      let state = 'played';
      if (i === k) state = mixing ? 'mixing' : 'playing';
      else if (i === k - 1 && mixing) state = 'playing';
      else if (i > k) state = 'next';
      row(rec.entry, rec.key, state, { via: rec.tr.label, deck: rec.play.deck });
    });
    for (const id of queue) {
      const e = entries.get(id);
      if (!e || e.dead) continue;
      row(e, `${e.id}|${e.playCount}`, e.status === 'working' ? 'loading' : 'queued');
    }
    for (const e of entries.values()) if (e.dead) row(e, `${e.id}|x`, 'failed');
    return items;
  }

  function stats() {
    let resolved = 0;
    let ready = 0;
    let failed = 0;
    let analysed = 0;
    for (const e of entries.values()) {
      if (e.ref) resolved++;
      if (isReady(e)) ready++;
      if (e.analysis) analysed++;
      if (e.dead) failed++;
    }
    return { total: entries.size, resolved, ready, analysed, failed, pending: entries.size - resolved - failed };
  }

  /** Everything the view needs outside the per-frame path. A fresh object each call. */
  function snapshot() {
    const now = started ? engine.now() : 0;
    const k = started ? currentIndex(now) : 0;
    updateLive(now);
    const cur = started ? plays[k] : null;
    return {
      loaded: !!playlist,
      started,
      playing: started && !paused,
      paused,
      fatal,
      seed,
      vibe,
      mode: planMode(),
      modeEnabled: isLocal(),
      canSkip: started && !!skipTarget(now),
      playlist: playlist
        ? { id: playlist.id, title: playlist.title, subtitle: playlist.subtitle, artwork: playlist.artwork, link: playlist.link, source: playlist.source, count: ids.length, total: playlist.total }
        : null,
      now,
      playIndex: cur ? cur.id : -1,
      current: cur ? { playId: cur.id, trackId: cur.entry.id, title: cur.entry.meta.title, artist: cur.entry.meta.artist || '', artwork: cur.entry.meta.artwork || (cur.entry.ref && cur.entry.ref.artwork) } : null,
      decks: [deckInfo(live.decks[0]), deckInfo(live.decks[1])],
      transition: transitionInfo(now, k),
      setlist: playlist ? setlistItems(now, k) : [],
      stats: stats(),
      status: started ? null : status(),
    };
  }

  /** Plain record of the set so far (tests, share-link reproducibility checks). */
  function history() {
    return plays.map((rec) => ({
      playId: rec.id,
      trackId: rec.entry.id,
      title: rec.entry.meta.title,
      type: rec.tr.type,
      label: rec.tr.label,
      beats: rec.tr.beats,
      synced: !!rec.tr.synced,
      degraded: !!rec.tr.degraded,
      tStart: rec.tr.tStart,
      tEnd: rec.tr.tEnd,
      startAt: rec.play.startAt,
      tricks: rec.tricks.length,
    }));
  }

  function debug() {
    let buffers = 0;
    let bytes = 0;
    /** @type {Record<string, number>} why tracks failed, by error code */
    const failures = {};
    for (const e of entries.values()) {
      if (e.buffer) buffers++;
      if (e.bytes) bytes += e.bytes.byteLength;
      if (e.status === 'failed' && e.error) failures[e.error.code] = (failures[e.error.code] || 0) + 1;
    }
    return { buffers, bytes, failures, jobs, queue: queue.length, plays: plays.length, activePlays: plays.filter((r) => !r.gone).length, cycle, order: order.slice(), engine: engine.debug ? engine.debug() : null };
  }

  function destroy() {
    stop();
    if (offStart) offStart();
    if (offEnd) offEnd();
    offStart = offEnd = null;
    listeners.clear();
  }

  return {
    on,
    load,
    begin,
    newSet,
    stop,
    skip,
    pause,
    resume,
    setVibe,
    setMode,
    setVolume,
    snapshot,
    history,
    debug,
    destroy,
    /** Wake the conductor now (visibility change, tests). */
    poke: pump,
    live,
    get seed() {
      return seed;
    },
    get started() {
      return started;
    },
    get paused() {
      return paused;
    },
  };
}

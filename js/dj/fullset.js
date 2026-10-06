// The full-song conductor (SPEC.md §6): a live set of whole songs played through YouTube's embedded
// player, two players = two decks. Same public surface as conductor.js, so main.js can hold either.
//
//   crate    every track as an entry: its YouTube video (finder, a few tracks ahead) and, in the
//            background, its 30-second Deezer / Apple preview (tempo, key and energy for the transition
//            planner — and the audio that plays when no video will).
//   set      seeded running order (planner.order), endless passes, every track once per pass. The idle
//            deck pre-rolls the next song MUTED as soon as it is free (SPEC 6.1: every music video opens
//            with 20-40 s of ads), so the ad runs while the current song plays and the hand-over needs
//            no wait. Once the incoming deck holds its song, videomix.planVideoTransition decides when
//            and how; one ticker (≈ 20 Hz) applies the two volume lanes; risers / impacts go to the Web
//            Audio engine on the same set clock.
//
// Clocks: set time is wall time (performance.now) minus the time spent paused — YouTube plays in wall
// time, so the volume lanes must too. The Web Audio engine runs its own clock; whatever is handed to it
// is converted at that moment (engine time = engine.now() + (set time − now())), and only shortly before
// it happens, so a re-plan never has to take anything back.
//
// Races: async work captures setGen (anything touching the running set) or crateGen (per-track work)
// and drops its result when the token has moved on.

import { createPlanner } from './planner.js';
import { nextCycleOrder } from './conductor.js';
import { leavePoint, planVideoTransition, volumeAt, PLAY_LEAD_S } from './videomix.js';
import { randomSeed } from '../util/rng.js';

/** Track lengths this conductor plays (Preview is the Web Audio conductor's). */
export const FULL_MODES = Object.freeze(['short', 'medium', 'full']);
/** Videos looked up ahead of the play order. */
export const LOOKAHEAD = 3;
/** Previews (tempo / energy, and the fallback audio) prepared ahead of the play order. */
const PREVIEW_AHEAD = 2;
/** The volume lanes are applied this often (the decks quantise to 1 %, a 50 ms step is not heard). */
export const TICK_MS = 50;
/** Planning, preparation and bookkeeping run on every PUMP_EVERY-th tick. */
const PUMP_EVERY = 4;
/** Seconds between "now" and the first change of a fresh plan. */
const MARGIN = 0.4;
/** Fx and fallback audio are handed to the engine this long before they happen (and from then on the plan stands). */
export const FX_LEAD = 1.5;
/** An announced transition this close to its start is not re-planned (Track length / Vibe) or skipped. */
const LOCK_S = 2;
/** Look for the next song in earnest (take any ready one) once the playing one is this close to its way out. */
const URGENT_S = 50;
/** Previous plays remembered for the setlist. */
const HISTORY = 60;
/** Wait for an incoming play() this long past tEnd before giving up on it. */
const START_GRACE_S = 6;
/** Moving Vibe re-plans the announced transition once the slider has rested this long. */
const VIBE_SETTLE_MS = 600;
/** Preview bytes are kept for the whole session up to this playlist size. */
const KEEP_BYTES_UP_TO = 24;
/**
 * The deck's own cue deadline is only a backstop: when to give up on a pre-roll is decided here (cueWatch),
 * on the time the page was in front and on whether the ad is still moving.
 */
const DECK_CUE_CAP_MS = 15 * 60 * 1000;
/** Before the start: the second song is cued and the opener is still in its ad this long after → the set opens with the second song. */
export const SWAP_AFTER_S = 15;
/** Once the music has stopped, an incoming still in its ad is waited for this long (set time), then its ready preview plays. */
export const SILENT_WAIT_S = 12;
/** An ad that keeps moving is waited for at most this much longer than the cue time (an ad that loops). */
const AD_CAP_EXTRA_S = 240;
/** The ad clock has not moved for this long: the pre-roll is not moving. */
const AD_STILL_MS = 4000;
/**
 * In a background tab a pre-roll counts as held still (Chrome stops a muted one there for good) only once
 * its ad clock has not moved for this long: the gap between two ads of a pod, or the ad buffering, stops
 * the clock for seconds — cutting such an ad for a preview was seen in a real background tab (2026-10-06).
 * Waiting costs no silence: the song on air plays on meanwhile, and SILENT_WAIT_S covers a song that ends.
 */
const AD_HELD_MS = 20000;
/** The song on air has not moved for this long while its player says it plays: it is buffering. */
export const STALL_S = 3;
/** A failure this soon after the page was seen hidden is the background tab's doing, not the video's. */
const HIDDEN_GRACE_MS = 4000;
/** A cue that spent this long in a background tab and is still loading a few seconds after the page came back is started again. */
const REVIVE_HIDDEN_MS = 5000;
const REVIVE_AFTER_MS = 5000;
/** An incoming held by a background tab gives way to its preview this close to the end of the song on air. */
const STANDIN_LEAD_S = 6;
/** …as does one still not cued after this much time in a background tab (Chrome holds a muted pre-roll still there). */
const STANDIN_HIDDEN_MS = 15000;
const RECORD_WHY = 'Recording works with previews and your own files — YouTube’s audio can’t be recorded';

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 20);
const fin = Number.isFinite;
const REFUSALS = new Set([100, 101, 150, 2, 5]);

function newEntry(meta, idx) {
  return {
    id: meta.id,
    meta,
    idx,
    /** @type {{videoId:string, title?:string, channel?:string, durationS?:number|null, score?:number, alternates:string[]}|null} */
    video: null,
    /** @type {'idle'|'working'|'ready'|'failed'} */
    vStatus: 'idle',
    vFinal: false,
    vTries: 0,
    vRetryAt: 0,
    /** @type {{code:string, message:string}|null} */
    vError: null,
    /** video ids a deck could not play (never offered again) */
    refused: new Set(),
    /** @type {any} AudioRef of the preview */
    ref: null,
    /** @type {any} Analysis of the preview */
    analysis: null,
    /** @type {ArrayBuffer|null} */
    bytes: null,
    /** @type {AudioBuffer|null} */
    buffer: null,
    /** @type {'idle'|'working'|'ready'|'failed'} */
    pStatus: 'idle',
    pFinal: false,
    pTries: 0,
    pRetryAt: 0,
    dead: false,
    playCount: 0,
  };
}

/**
 * @param {{
 *   engine?: any,                 Web Audio engine for risers / impacts and the preview fallback (its own, see main.js)
 *   finder: {find: Function, forget?: Function},
 *   decks: any[] | (() => any[]), the two YouTube decks (js/dj/ytdeck.js), or a function that returns them
 *   resolver?: any, analyzer?: any, decode?: (bytes: ArrayBuffer) => Promise<AudioBuffer>,   previews (optional)
 *   clock?: () => number,         wall clock in ms (tests)
 *   timers?: boolean | {setInterval: Function, clearInterval: Function},
 *                                 false = no interval, the caller drives tick() (tests); an object = the
 *                                 interval to tick on (main.js: js/util/timers.js, a worker clock that
 *                                 Chrome does not throttle in a background tab); default the window's
 *   volumeWorks?: boolean,        false where the player ignores setVolume (iOS: mute / unmute only) —
 *                                 every move then becomes a cut at its crossover point
 *   hidden?: () => boolean,       is the page in a background tab? (default: document.visibilityState)
 * }} deps
 */
export function createFullSet(deps) {
  const engine = deps.engine || null;
  const finder = deps.finder;
  const resolver = deps.resolver || null;
  const analyzer = deps.analyzer || null;
  const decode = deps.decode || null;
  const getDecks = typeof deps.decks === 'function' ? deps.decks : () => deps.decks;
  const clock = deps.clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const useTimers = deps.timers !== false;
  /** @type {{setInterval: Function, clearInterval: Function}} */
  const timerApi =
    deps.timers && typeof deps.timers === 'object' && typeof deps.timers.setInterval === 'function'
      ? deps.timers
      : { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };
  const volumeWorks = deps.volumeWorks !== false;
  const isHidden = deps.hidden || (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const deck = (i) => {
    const list = getDecks();
    return list ? list[i] : null;
  };

  // ── the page in a background tab ───────────────────────────────────────────────────────────────
  // Chrome does not let a player that has only ever played MUTED (every pre-roll here is muted) start or
  // go on in a hidden tab: its cue fails 'blocked', or never loads at all. That says nothing about the
  // video, so such a failure never refuses the upload, never touches the finder's cache and never counts
  // towards "YouTube does not work here"; the play is held and cued again once the page is back in front.
  /** clock() when the page was last seen hidden / visible again */
  let hiddenAt = -Infinity;
  let visibleSince = 0;
  let wasHidden = false;
  function pageHidden() {
    let h = false;
    try {
      h = !!isHidden();
    } catch {
      h = false;
    }
    const t = clock();
    if (h) hiddenAt = t;
    else if (wasHidden) visibleSince = t;
    wasHidden = h;
    return h;
  }
  const hiddenLately = () => pageHidden() || clock() - hiddenAt < HIDDEN_GRACE_MS;

  // ── events ─────────────────────────────────────────────────────────────────────────────────────
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
        console.error('[fullset] listener failed', err);
      }
    }
  }

  // ── crate ──────────────────────────────────────────────────────────────────────────────────────
  let crateGen = 0;
  /** @type {AbortController|null} */
  let abort = null;
  /** @type {any} */
  let playlist = null;
  /** @type {Map<string, ReturnType<typeof newEntry>>} */
  let entries = new Map();
  /** @type {string[]} */
  let ids = [];
  let jobs = { video: 0, preview: 0 };
  /** lookups that came back: a run of network failures with no success says YouTube cannot be reached */
  let lookups = { ok: 0, network: 0 };
  /** cue outcomes: a run of failures with no success says the player cannot work here */
  let cues = { ok: 0, failed: 0, refusedTracks: 0 };

  // ── set ────────────────────────────────────────────────────────────────────────────────────────
  let setGen = 0;
  let seed = '';
  let vibe = 0.5;
  let mode = 'medium';
  let volume = 1;
  /** @type {string[]} */
  let order = [];
  /** @type {string[]} */
  let queue = [];
  let queuePass = new Map();
  let cycle = 0;
  /** @type {any[]} PlayRec, oldest first */
  let plays = [];
  /** @type {any} the play on air (or, before the start, the opener) */
  let cur = null;
  /** @type {any} the play being readied on the other deck */
  let nxt = null;
  let started = false;
  let starting = false;
  let allowed = false;
  let paused = false;
  let userPaused = false;
  /** the browser refused to start the sound without a tap */
  let needsTap = false;
  let origin = 0;
  let pausedAt = 0;
  let pausedMs = 0;
  let skipQueued = false;
  /** what queued the quick move: Skip, or New Set under a song that plays on (its note says which) */
  let quickWhy = 'skip';
  /** a new running order under a song that keeps playing (New set): its head is waited for, not raced past */
  let freshOrder = false;
  /** New set pressed while a hand-over was in motion: it takes over once the hand-over is done */
  let pendingNew = false;
  /** a set handed over from Preview mode (load's carry): the songs it played (setlist rows) and its elapsed time */
  let carried = [];
  let elapsedBase = 0;
  /** carry.live: the set it came from plays on until this one sounds — Elapsed runs on from this clock ms (else -1) */
  let carryRunsFrom = -1;
  /** Elapsed time carried over from the set this one took over from (wait included while that one plays on). */
  const carriedElapsed = () => elapsedBase + (carryRunsFrom >= 0 ? Math.max(0, clock() - carryRunsFrom) / 1000 : 0);
  let replanAt = 0;
  /** @type {string|null} */
  let fatal = null;
  let unavailable = false;
  let engineStarted = false;
  let enginePlayId = 0;
  let timer = null;
  let ticks = 0;
  let rev = 0;
  let lastSig = '';
  let lastStatus = '';
  /** lane value each deck was last given (0..1, before the user's volume) */
  const gains = [0, 0];

  const bump = () => {
    rev++;
  };

  /** Set time (s): wall time since the opener's first sample, minus pauses. 0 before the start. */
  function now() {
    if (!started) return 0;
    const end = paused ? pausedAt : clock();
    return (end - origin - pausedMs) / 1000;
  }

  // ── preparation ────────────────────────────────────────────────────────────────────────────────

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

  const videoKnown = (e) => e.vStatus === 'ready' && !!e.video;
  const videoGone = (e) => e.vStatus === 'failed' && e.vFinal;
  const previewReady = (e) => e.pStatus === 'ready' && !!e.analysis;
  const previewGone = (e) => !resolver || (e.pStatus === 'failed' && e.pFinal);
  const playable = (e) => !e.dead && (videoKnown(e) || previewReady(e));

  /** Entries worth working on now, most urgent first. */
  function workList() {
    const list = [];
    for (const r of [nxt, cur]) if (r && r.entry && !list.includes(r.entry)) list.push(r.entry);
    for (const e of upcoming(LOOKAHEAD)) if (!list.includes(e)) list.push(e);
    return list;
  }

  function schedule() {
    if (!playlist || fatal) return;
    const t = clock();
    const list = workList();
    for (const e of list) {
      if (jobs.video >= 2) break;
      if (!e.dead && (e.vStatus === 'idle' || (e.vStatus === 'failed' && !e.vFinal && t >= e.vRetryAt))) runVideo(e);
    }
    if (!resolver || !analyzer || !decode) return;
    // Previews: the ones a fallback is waiting for first, then the head of the order.
    const want = list.filter((e) => !e.dead).slice(0, PREVIEW_AHEAD + 2);
    want.sort((a, b) => Number(videoGone(b) || needsPreview(b)) - Number(videoGone(a) || needsPreview(a)));
    for (const e of want) {
      if (jobs.preview >= 1) break;
      if (e.pStatus === 'idle' || (e.pStatus === 'failed' && !e.pFinal && t >= e.pRetryAt)) runPreview(e);
    }
  }
  // (a play held by a background tab may need its preview as a stand-in: fetched early too)
  const needsPreview = (e) => [nxt, cur].some((r) => r && r.entry === e && (r.wantPreview || r.held));

  function runVideo(e) {
    const g = crateGen;
    const signal = abort ? abort.signal : undefined;
    jobs.video++;
    e.vStatus = 'working';
    bump();
    Promise.resolve()
      .then(() => finder.find(e.meta, { signal }))
      .then(
        (v) => {
          if (g !== crateGen) return;
          const alternates = (Array.isArray(v.alternates) ? v.alternates : []).filter((id) => !e.refused.has(id));
          e.video = { videoId: v.videoId, title: v.title, channel: v.channel, durationS: v.durationS, score: v.score, alternates };
          if (e.refused.has(v.videoId)) {
            e.video.videoId = alternates.shift() || '';
            if (!e.video.videoId) {
              e.video = null;
              throw Object.assign(new Error('Every upload of this song refused to play here.'), { code: 'no-match' });
            }
          }
          e.vStatus = 'ready';
          e.vError = null;
          lookups.ok++;
        },
      )
      .catch((err) => {
        if (g !== crateGen) return;
        if (isAbort(err)) {
          e.vStatus = 'idle';
          return;
        }
        const code = (err && err.code) || 'error';
        e.vTries++;
        e.vStatus = 'failed';
        e.vError = { code: String(code), message: (err && err.message) || 'Couldn’t look this song up.' };
        if (code === 'network') {
          lookups.network++;
          // Worth another go — unless nothing has ever got through (checkUsable decides about that).
          e.vFinal = e.vTries >= 4;
          e.vRetryAt = clock() + Math.min(60000, 4000 * 2 ** (e.vTries - 1));
        } else e.vFinal = true;
      })
      .then(() => {
        jobs.video--;
        if (g !== crateGen) return;
        settleEntry(e);
        bump();
        pump();
      });
  }

  /** No video and no preview, for good: the track is out (the setlist says so at once, not when its turn comes). */
  function settleEntry(e) {
    if (!e.dead && videoGone(e) && previewGone(e) && (resolver || e.vFinal)) {
      const inPlay = (cur && cur.entry === e && !cur.gone) || (nxt && nxt.entry === e && !nxt.gone);
      if (!inPlay) markDead(e);
    }
  }

  function runPreview(e) {
    const g = crateGen;
    const signal = abort ? abort.signal : undefined;
    jobs.preview++;
    e.pStatus = 'working';
    (async () => {
      if (!e.ref) e.ref = await resolver.resolveTrack(e.meta, { signal });
      if (g !== crateGen) return;
      let analysis = null;
      try {
        analysis = await analyzer.cached(e.ref.key);
      } catch {
        analysis = null;
      }
      if (g !== crateGen) return;
      const bytes = await resolver.fetchAudio(e.ref, { signal });
      if (g !== crateGen) return;
      if (!analysis) {
        const buffer = await decode(bytes.slice(0));
        if (g !== crateGen) return;
        analysis = await analyzer.analyze(buffer, { key: e.ref.key, bpmHint: e.ref.bpmHint });
        if (g !== crateGen) return;
        e.buffer = buffer;
      }
      if (!analysis || !(analysis.duration >= 3)) throw Object.assign(new Error('The preview is too short to play.'), { code: 'too-short' });
      e.analysis = analysis;
      e.bytes = bytes;
      e.pStatus = 'ready';
    })()
      .catch((err) => {
        if (g !== crateGen) return;
        if (isAbort(err)) {
          e.pStatus = 'idle';
          return;
        }
        e.pTries++;
        e.pStatus = 'failed';
        const code = err && err.code;
        e.pFinal = !(code === 'network' && e.pTries < 3);
        e.pRetryAt = clock() + 6000 * e.pTries;
      })
      .then(() => {
        jobs.preview--;
        if (g !== crateGen) return;
        settleEntry(e);
        bump();
        pump();
      });
  }

  /** Decoded preview audio for the fallback (decoded again from the kept bytes when it was let go). */
  async function previewBuffer(e) {
    if (e.buffer) return e.buffer;
    if (!e.bytes) e.bytes = await resolver.fetchAudio(e.ref, { signal: abort ? abort.signal : undefined });
    e.buffer = await decode(e.bytes.slice(0));
    return e.buffer;
  }

  function markDead(e) {
    if (e.dead) return;
    e.dead = true;
    bump();
  }

  // ── the running order ──────────────────────────────────────────────────────────────────────────

  function refill() {
    const alive = ids.filter((id) => !entries.get(id).dead);
    if (!alive.length) return;
    const want = Math.min(LOOKAHEAD + 1, alive.length);
    for (let guard = 0; guard < 2 && upcoming(want).length < want; guard++) {
      const recent = plays.map((r) => r.entry.id);
      const more = nextCycleOrder(seed, cycle + 1, alive, queue, recent);
      if (!more.length) break;
      cycle++;
      for (const id of more) queuePass.set(id, cycle);
      queue.push(...more);
      bump();
    }
  }

  function take(e) {
    const at = queue.indexOf(e.id);
    if (at < 0) return;
    const pass = queuePass.get(e.id);
    queue.splice(at, 1);
    queuePass.delete(e.id);
    // queued for the next pass while still waiting in this one: it joins that pass now, at the back
    if (pass < cycle) {
      queue.push(e.id);
      queuePass.set(e.id, cycle);
    }
  }

  /**
   * The next song: the first track of the order that can be played. Not urgent, it waits for the head
   * of the order to settle (the same seed then gives the same order of songs); urgent, it takes the
   * first one that is ready. A track whose video failed plays its preview, a track with neither is out.
   */
  function pickNext(urgent) {
    refill();
    const win = upcoming(LOOKAHEAD + 2);
    const avoid = cur ? cur.entry : null;
    for (const e of win) {
      if (e === avoid && win.some((x) => x !== e && !x.dead)) continue; // never the same song twice in a row
      if (videoKnown(e)) return { e, provider: 'youtube' };
      if (videoGone(e)) {
        if (previewReady(e)) return { e, provider: 'preview' };
        if (previewGone(e)) {
          markDead(e);
          continue;
        }
      }
      if (!urgent) return null;
    }
    return null;
  }

  /** Seconds until the playing song is probably left (Infinity when unknown). */
  function timeToLeave(t) {
    if (!cur || cur.phase !== 'live') return Infinity;
    if (cur.trOut) return cur.trOut.tStart - t;
    const at = leaveEstimate(cur);
    return fin(at) && fin(cur.startedAt) ? cur.startedAt + at - t : Infinity;
  }

  function newPlay(e, d, provider) {
    const round = e.playCount++;
    const rec = {
      id: plays.length ? plays[plays.length - 1].id + 1 : 0,
      entry: e,
      deck: d,
      provider,
      round,
      key: `${e.id}|${round}`,
      videoId: '',
      /** @type {'cueing'|'cued'|'starting'|'live'|'ended'|'done'|'failed'} */
      phase: 'cueing',
      durationS: 0,
      startedAt: NaN,
      /** @type {any} VideoTransition that brings it in */
      tr: null,
      /** @type {any} VideoTransition that takes it out */
      trOut: null,
      outSent: false,
      inSent: false,
      wantPreview: false,
      enginePlay: -1,
      /** @type {AudioBuffer|null} */
      buffer: null,
      leaveKey: '',
      leaveEst: NaN,
      startTimer: 0,
      /** set time its player reported PLAYING (a hand-over's real start, for history / the e2e timing) */
      heardAt: NaN,
      gone: false,
      /** the page was in a background tab when its cue failed: cued again once the page is back */
      held: false,
      /** why its preview plays instead of its video: 'refused' | 'slow' | 'background' */
      previewWhy: '',
      // the cue watch (cueWatch): clock() at the cue, last look, time spent hidden, the ad clock
      cueAt: 0,
      cueSeen: 0,
      cueHiddenMs: 0,
      cueLimitMs: 0,
      adSeen: 0,
      adMovedAt: 0,
      /** clock() when its ad clock (deck.adSeconds) was last seen to grow, hidden or not */
      adGrewAt: -Infinity,
      revived: false,
      cuedAt: 0,
      /** set time it ran out (phase 'ended') */
      endedAt: NaN,
      // a song on air whose position stands still while its player says it plays (buffering)
      stallPos: NaN,
      stallAt: 0,
      buffering: false,
    };
    plays.push(rec);
    if (plays.length > HISTORY) plays = plays.slice(-HISTORY);
    take(e);
    // Big playlists let the preview bytes of a track go once it is on its way; a later pass fetches them again.
    if (entries.size > KEEP_BYTES_UP_TO && provider === 'youtube') {
      e.bytes = null;
      e.buffer = null;
      if (e.pStatus === 'ready' && !e.analysis) e.pStatus = 'idle';
    }
    bump();
    return rec;
  }

  /**
   * Ready the chosen song on deck d as the opener ('cur', before the start) or the next song ('nxt'):
   * cue its video (muted pre-roll) or decode its preview. The slot is taken before anything is asked of
   * the deck — a deck reports its state changes synchronously, and whatever that wakes must see it.
   */
  function ready(choice, d, slot) {
    const rec = newPlay(choice.e, d, choice.provider);
    if (slot === 'cur') cur = rec;
    else nxt = rec;
    if (choice.provider === 'youtube') cueVideo(rec, choice.e.video.videoId);
    else usePreview(rec);
    return rec;
  }

  /**
   * How long a pre-roll that is NOT moving may take before the video is given up for its next upload
   * (a player that never gets anywhere). The opener gets 3 minutes, a next song as long as the song on air
   * still has to run, within 2-5 minutes. Only time with the page in front counts (cueWatch), and an ad
   * that is still moving is not cut short for this: a long ad is not a broken upload — every new video
   * would bring an ad of its own. Ad breaks of 120-190 s were measured.
   */
  function cueTimeout() {
    if (!started || !cur) return 180000;
    const dur = side(cur, false).durationS;
    const left = fin(cur.startedAt) && dur > 0 ? cur.startedAt + dur - now() : 120;
    return Math.round(Math.max(120, Math.min(300, left + 15)) * 1000);
  }

  function cueVideo(rec, id) {
    const g = setGen;
    const dk = deck(rec.deck);
    const token = (rec.cueSeq = (rec.cueSeq || 0) + 1);
    rec.provider = 'youtube';
    rec.videoId = id;
    rec.phase = 'cueing';
    rec.held = false;
    rec.durationS = rec.entry.video && rec.entry.video.videoId === id && rec.entry.video.durationS > 0 ? rec.entry.video.durationS : 0;
    rec.cueAt = rec.cueSeen = rec.adMovedAt = clock();
    rec.cueHiddenMs = 0;
    rec.cueLimitMs = cueTimeout();
    rec.adSeen = 0;
    rec.adGrewAt = -Infinity;
    rec.revived = false;
    bump();
    if (!dk) {
      onVideoError(rec, Object.assign(new Error('No YouTube player'), { code: 'api' }));
      return;
    }
    let p;
    try {
      p = dk.cue(id, { timeoutMs: DECK_CUE_CAP_MS, unmuted: unmutedPreroll() });
    } catch (err) {
      p = Promise.reject(err);
    }
    const mine = () => g === setGen && !rec.gone && rec.cueSeq === token && rec.videoId === id && rec.provider === 'youtube';
    Promise.resolve(p).then(
      () => {
        if (!mine() || rec.phase !== 'cueing' || rec.held) return;
        rec.phase = 'cued';
        rec.cuedAt = clock();
        if (dk.duration > 0) rec.durationS = dk.duration;
        cues.ok++;
        bump();
        pump();
      },
      (err) => {
        if (!mine()) return;
        if (err && err.code === 'cancelled') return;
        onVideoError(rec, err);
      },
    );
  }

  /**
   * Pre-roll unmuted at volume 0 instead of muted? Measured in a real background tab (Chrome, 2026-10-05):
   * a player that has only ever played MUTED is paused by Chrome when the tab is hidden (its ad stops)
   * and cannot start a new video there — every hidden cue on it failed 'blocked'. A player playing
   * unmuted at volume 0 (unMute() THEN setVolume(0): the other order makes YouTube restore volume 5,
   * audible) is silent (its <video> reads volume 0.00) yet counts as sounding: its ad runs on in the
   * background, the song starts after it, and later cues on that player start there too. That needs a
   * user gesture (unmuted autoplay) and a player that obeys volume (not iOS). The deck decides how to
   * honour it (js/dj/ytdeck.js); a deck that does not know the option pre-rolls muted as before.
   */
  const unmutedPreroll = () => allowed && volumeWorks;

  /** The tap: decks already pre-rolling muted (a share link before its tap) switch to unmuted at volume 0. */
  function unlockDecks() {
    if (!volumeWorks) return;
    for (const rec of [cur, nxt]) {
      if (!rec || rec.gone || rec.provider !== 'youtube' || rec.phase !== 'cueing' || rec.held) continue;
      const dk = deck(rec.deck);
      if (dk && typeof dk.unlock === 'function') {
        try {
          dk.unlock();
        } catch {
          /* a deck that cannot: it stays muted */
        }
      }
    }
  }

  function stopDeck(i) {
    const dk = deck(i);
    if (!dk) return;
    try {
      dk.stop();
    } catch {
      /* nothing loaded */
    }
  }

  /** Seconds of silence since the song on air ran out (0 while something plays). */
  function silentFor(t) {
    if (!started || !cur || cur.phase !== 'ended') return 0;
    return fin(cur.endedAt) ? Math.max(0, t - cur.endedAt) : 0;
  }

  /** Seconds the song on air still runs (Infinity when unknown). */
  function remainingOnAir(t) {
    if (!started || !cur) return Infinity;
    if (cur.phase === 'ended') return 0;
    if (cur.phase !== 'live') return Infinity;
    if (cur.provider === 'preview') return fin(cur.startedAt) && cur.durationS > 0 ? cur.startedAt + cur.durationS - t : Infinity;
    const dk = deck(cur.deck);
    const d = (dk && dk.duration) || cur.durationS;
    return dk && d > 0 ? d - dk.position() : Infinity;
  }

  /**
   * Watch a pre-roll (every pump). Decides when waiting for it is no longer worth it — on the time the
   * page was in front and on whether its ad is still moving, never on wall time alone (a background tab
   * may not load anything at all until it is shown again).
   */
  function cueWatch(rec, t) {
    if (!rec || rec.gone || rec.provider !== 'youtube' || rec.phase !== 'cueing' || rec.held) return;
    const dk = deck(rec.deck);
    if (!dk) return;
    const ms = clock();
    const dt = Math.max(0, ms - rec.cueSeen);
    rec.cueSeen = ms;
    // The music has stopped and waits for this one: its ready preview ends the silence instead — in a
    // background tab too, where a player may neither load nor fail (or Chrome holds its ad still) until
    // the tab is shown, which would otherwise mean silence for as long as the listener is elsewhere.
    if (rec === nxt && silentFor(t) >= SILENT_WAIT_S && previewReady(rec.entry)) {
      // an ad still moving ran long (hidden or not); only a pre-roll that does not move there is the tab's doing
      cueGiveUp(rec, pageHidden() && !adMoving(rec, AD_HELD_MS) ? 'background' : 'slow');
      return;
    }
    const ad = dk.adSeconds || 0;
    const grew = ad > rec.adSeen + 0.05;
    if (grew) {
      rec.adSeen = ad;
      rec.adGrewAt = ms;
    }
    if (pageHidden()) {
      rec.cueHiddenMs += dt;
      rec.adMovedAt = ms; // back in front, an ad that Chrome held in the background gets its moment to move again
      return;
    }
    if (grew) rec.adMovedAt = ms;
    // Back in front after a long time hidden, and the player has still not started on it: load it again.
    if (!rec.revived && rec.cueHiddenMs > REVIVE_HIDDEN_MS && ms - visibleSince > REVIVE_AFTER_MS && dk.state === 'loading' && rec.adSeen === 0) {
      cueVideo(rec, rec.videoId);
      rec.revived = true;
      return;
    }
    const adMovesInFront = dk.state === 'ad' && ms - rec.adMovedAt < AD_STILL_MS;
    const ran = ms - rec.cueAt - rec.cueHiddenMs;
    if (ran > rec.cueLimitMs && !adMovesInFront) {
      cues.failed++; // a player that never gets anywhere with the page in front
      cueGiveUp(rec, 'stuck');
      return;
    }
    if (ran > rec.cueLimitMs + AD_CAP_EXTRA_S * 1000) cueGiveUp(rec, 'cap'); // an ad that does not end
  }

  /** The next upload of the song that has not been tried in this set, or ''. */
  function nextAlternate(e) {
    if (!e.video) return '';
    const alt = e.video.alternates.find((x) => !e.refused.has(x) && x !== e.video.videoId) || '';
    if (alt) {
      e.video.alternates = e.video.alternates.filter((x) => x !== alt);
      e.video.videoId = alt;
    }
    return alt;
  }

  /**
   * Waiting for this pre-roll is over. 'stuck': the player got nowhere — its next upload, else the preview.
   * 'slow' / 'background' (the music stopped for it, the page in front / in a background tab) / 'cap' (an
   * ad that does not end): the preview when there is one, else the next upload. The upload is never
   * refused or forgotten for this: it did nothing wrong.
   */
  function cueGiveUp(rec, why) {
    const e = rec.entry;
    // the music has already stopped and waits for this one: its ready preview beats a fresh ad
    const quiet = rec === nxt && silentFor(now()) > 0 && previewReady(e);
    if ((why !== 'stuck' && !previewGone(e) && resolver) || quiet) {
      stopDeck(rec.deck);
      usePreview(rec, why === 'background' ? 'background' : 'slow');
      return;
    }
    const alt = nextAlternate(e);
    if (alt) {
      cueVideo(rec, alt);
      return;
    }
    stopDeck(rec.deck);
    if (checkUsable()) return;
    usePreview(rec, why === 'stuck' ? 'stuck' : 'slow');
  }

  /**
   * The page is in a background tab and the video could not be readied there: hold the play (its deck
   * paused, so nothing starts by itself when the page is shown again) and cue the same upload once the
   * page is back in front (step). Not the video's fault: nothing refused, forgotten or counted.
   */
  function holdVideo(rec) {
    rec.held = true;
    rec.phase = 'cueing';
    stopDeck(rec.deck);
    bump();
  }

  /**
   * A video would not cue or play: its other uploads, then the track's preview, then the next track.
   * Only a refusal (or another fault of the video itself) is held against the upload — refused for the
   * set and forgotten by the finder's cache. A run of failures with not one success means YouTube itself
   * is unusable here (checkUsable).
   */
  function onVideoError(rec, err) {
    const e = rec.entry;
    const code = err && err.code;
    if (code === 'api') {
      giveUp('The YouTube player couldn’t be loaded here (a content blocker or the network may be stopping it). Playing 30-second previews instead.');
      return;
    }
    const refusal = REFUSALS.has(code);
    if (!refusal && hiddenLately()) {
      holdVideo(rec);
      return;
    }
    if (code === 'timeout') {
      // the deck's own backstop, or a start that never came: the player got nowhere
      cues.failed++;
      cueGiveUp(rec, 'stuck');
      return;
    }
    if (code === 'blocked') {
      // The browser refuses even muted playback with the page in front: no other upload would do better,
      // and it is not this one's fault. A browser that does this to every video hands over to Preview.
      cues.failed++;
      stopDeck(rec.deck);
      if (checkUsable()) return;
      usePreview(rec);
      return;
    }
    const id = rec.videoId;
    if (id) {
      e.refused.add(id);
      try {
        // with the deck's code: the finder keeps the upload when the code says nothing about it (NO_VERDICT)
        if (finder.forget) finder.forget(e.meta, id, code);
      } catch {
        /* the cache is a nicety */
      }
    }
    if (refusal) cues.refused = (cues.refused || 0) + 1;
    else cues.failed++;
    const alt = nextAlternate(e);
    if (alt) {
      cueVideo(rec, alt);
      return;
    }
    if (refusal) cues.refusedTracks++;
    if (rec.provider === 'youtube') stopDeck(rec.deck);
    if (checkUsable()) return;
    usePreview(rec);
  }

  /**
   * The track's 30-second preview stands in (Web Audio). Waits for it when it is still on its way.
   * @param {'refused'|'stuck'|'slow'|'background'} [why] what the notice says
   */
  function usePreview(rec, why = 'refused') {
    rec.provider = 'preview';
    rec.videoId = '';
    rec.phase = 'cueing';
    rec.held = false;
    rec.previewWhy = why;
    rec.wantPreview = true;
    bump();
    schedule(); // a preview still to fetch is picked first (needsPreview)
    resumePreviewWaits();
  }

  function previewNotice(rec) {
    const title = rec.entry.meta.title;
    switch (rec.previewWhy) {
      case 'slow':
        return `YouTube’s ad before “${title}” ran long — its 30-second preview plays instead.`;
      case 'stuck':
        return `The video of “${title}” didn’t load — its 30-second preview plays instead.`;
      case 'background':
        return `The browser doesn’t start new videos while Segue is in a background tab — “${title}” plays as its 30-second preview.`;
      default:
        return `No playable video of “${title}” — its 30-second preview plays instead.`;
    }
  }

  /** Plays waiting for a preview: go on once it has settled. */
  function resumePreviewWaits() {
    for (const rec of [cur, nxt]) {
      if (!rec || rec.provider !== 'preview' || rec.phase !== 'cueing' || rec.buffer || rec.decoding) continue;
      const e = rec.entry;
      if (previewReady(e)) {
        rec.decoding = true;
        const g = setGen;
        previewBuffer(e).then(
          (buffer) => {
            rec.decoding = false;
            if (g !== setGen || rec.gone || rec.provider !== 'preview') return;
            rec.buffer = buffer;
            rec.durationS = e.analysis.duration;
            rec.phase = 'cued';
            rec.wantPreview = false;
            emit('notice', { message: previewNotice(rec), kind: 'info' });
            bump();
            pump();
          },
          () => {
            rec.decoding = false;
            if (g !== setGen || rec.gone) return;
            e.pFinal = true;
            e.pStatus = 'failed';
            failPlay(rec, 'The preview of this song couldn’t be decoded.');
          },
        );
      } else if (previewGone(e)) failPlay(rec, 'No video and no preview of this song could be played.');
    }
  }

  /** Neither a video nor a preview: the track is out, and the slot goes to the next one. */
  function failPlay(rec, message) {
    const e = rec.entry;
    rec.phase = 'failed';
    rec.gone = true;
    markDead(e);
    e.vError = e.vError || { code: 'unplayable', message };
    plays = plays.filter((r) => r !== rec);
    if (nxt === rec) {
      nxt = null;
      if (cur && cur.trOut) cur.trOut = null;
    } else if (cur === rec) {
      // Only the opener can fail this way (a live play never does): the song readied on the other
      // deck opens the set instead, and the freed deck takes the one after it.
      cur = started ? null : nxt;
      nxt = null;
      if (cur) cur.tr = null;
    }
    bump();
    checkFatal();
    pump();
  }

  /** YouTube does not work here at all: hand the set to Preview mode (main.js switches conductors). */
  function giveUp(message) {
    if (unavailable) return;
    unavailable = true;
    bump();
    // after the current step: the listener stops this very set (main.js hands it to Preview mode)
    const g = setGen;
    Promise.resolve().then(() => {
      if (g === setGen) emit('unavailable', { message });
    });
  }

  /**
   * Is YouTube usable at all? Before the first song ever cued or was found: every lookup failing on the
   * network, every cue failing, or three songs in a row whose every upload refused to play here (label
   * music on a local address answers error 150 to all of them).
   * @returns {boolean} true when the set has been handed over
   */
  function checkUsable() {
    if (unavailable) return true;
    if (cues.ok === 0 && cues.failed >= 3) {
      giveUp('YouTube’s player keeps failing in this browser. Playing 30-second previews instead.');
      return true;
    }
    if (cues.ok === 0 && cues.refusedTracks >= 3) {
      giveUp('YouTube won’t play these songs on this site address (their owners only allow some sites). Playing 30-second previews instead.');
      return true;
    }
    if (lookups.ok === 0 && lookups.network >= 3) {
      giveUp('Couldn’t reach YouTube’s search. Playing 30-second previews instead.');
      return true;
    }
    return false;
  }

  function checkFatal() {
    if (fatal || !playlist || started) return;
    let alive = 0;
    for (const e of entries.values()) if (!e.dead) alive++;
    if (alive > 0) return;
    fatal = 'None of these songs could be found on YouTube or as previews. Try another playlist.';
    bump();
    emit('error', { message: fatal });
  }

  // ── the Web Audio side (risers, impacts, preview fallback) ─────────────────────────────────────

  /** Start the engine's clock (once per set). Resolves when it runs — or does not: engineLive() says which. */
  function ensureEngine() {
    if (!engine) return Promise.resolve();
    if (engineStarting) return engineStarting;
    const g = setGen;
    const task = Promise.resolve()
      .then(() => engine.start())
      .then(
        () => {
          if (g === setGen && engineStarting === task) engineStarted = true;
        },
        (err) => {
          if (g === setGen && engineStarting === task) engineStarting = null;
          console.warn('[fullset] Web Audio engine did not start', err);
        },
      );
    engineStarting = task;
    return task;
  }
  /** @type {Promise<void>|null} */
  let engineStarting = null;
  const engineLive = () => !!engine && engineStarted && engine.state === 'running';
  /** Set time → engine set time, at this moment. */
  const toEngine = (t) => engine.now() + (t - now());

  function sendFx(tr) {
    if (!engineLive() || !tr.fx || !tr.fx.length) return;
    const fx = tr.fx.map((f) => (f.kind === 'riser' ? { kind: 'riser', t: toEngine(f.t), dur: f.dur, gain: f.gain } : { kind: f.kind, t: toEngine(f.t), gain: f.gain }));
    try {
      engine.addFx(fx, []);
    } catch (err) {
      console.warn('[fullset] fx', err);
    }
  }

  /** A preview play through the engine: its gain lane is the transition's incoming lane. */
  function sendPreviewIn(rec, tr, t0) {
    if (!engineLive() || !rec.buffer) return false;
    const an = rec.entry.analysis;
    const startSet = tr ? tr.incStart : t0;
    const lane = tr ? tr.incVol : [{ t: t0, v: 1 }];
    const startAt = toEngine(startSet);
    const events = [{ p: 'gain', t: startAt, v: lane[0].v, k: 'set' }];
    for (let i = 1; i < lane.length; i++) events.push({ p: 'gain', t: toEngine(lane[i].t), v: lane[i].v, k: 'lin' });
    const id = ++enginePlayId;
    try {
      engine.addPlay(
        {
          id,
          trackId: rec.entry.id,
          deck: rec.deck,
          startAt,
          offset: 0,
          rate: [{ t: startAt, v: 1 }],
          trimDb: an && an.loudness ? an.loudness.trimDb || 0 : 0,
          events,
          endAt: null,
          soloFrom: toEngine(tr ? tr.tEnd : t0),
        },
        rec.buffer,
      );
    } catch (err) {
      console.warn('[fullset] preview play', err);
      return false;
    }
    rec.enginePlay = id;
    rec.startedAt = startSet;
    return true;
  }

  function sendPreviewOut(rec, tr) {
    if (!engineLive() || rec.enginePlay < 0) return;
    const events = tr.outVol.map((p, i) => ({ p: 'gain', t: toEngine(p.t), v: p.v, k: i === 0 ? 'set' : 'lin' }));
    try {
      engine.extendPlay(rec.enginePlay, { events, endAt: toEngine(tr.tEnd + 0.05) });
    } catch (err) {
      console.warn('[fullset] preview out', err);
    }
  }

  // ── transitions ────────────────────────────────────────────────────────────────────────────────

  /** What videomix needs to know about a play. */
  function side(rec, out) {
    const an = rec.entry.analysis;
    const dk = rec.provider === 'youtube' ? deck(rec.deck) : null;
    const dur = rec.provider === 'preview' && an ? an.duration : rec.durationS || (dk && dk.duration) || (rec.entry.meta.durationMs > 0 ? rec.entry.meta.durationMs / 1000 : 0);
    const s = { id: rec.entry.id, durationS: dur > 0 ? dur : undefined, provider: rec.provider };
    if (an) {
      s.bpm = an.bpm;
      s.bpmConfidence = an.bpmConfidence;
      s.energy = an.energy;
    }
    if (out) s.startedAt = rec.phase === 'ended' && dur > 0 ? Math.min(rec.startedAt, now() - dur) : rec.startedAt;
    return s;
  }

  function leaveEstimate(rec) {
    if (rec.trOut) return rec.trOut.leaveAt;
    const s = side(rec, false);
    const key = `${mode}|${vibe}|${s.durationS}|${nxt && rec === cur ? nxt.entry.id : ''}|${s.bpm || ''}`;
    if (key !== rec.leaveKey) {
      rec.leaveKey = key;
      try {
        rec.leaveEst = leavePoint({ seed, vibe, mode, playIndex: rec.id, prevType: rec.tr ? rec.tr.type : undefined, out: { ...s, startedAt: 0 }, inc: nxt && rec === cur ? side(nxt, false) : undefined });
      } catch {
        rec.leaveEst = NaN;
      }
    }
    return rec.leaveEst;
  }

  const incomingReady = (r) => !!r && r.phase === 'cued';

  /**
   * Where the player ignores its volume (iOS), a 15-second blend would play both songs at full level for
   * 15 seconds: the move is made a cut at its crossover instead (the first moment the incoming lane reaches
   * the outgoing one; the drop itself for drops). A preview on either side keeps its lanes (Web Audio).
   */
  function asCut(tr) {
    const times = [...tr.outVol, ...tr.incVol].map((p) => p.t).filter((t) => t >= tr.tStart).sort((a, b) => a - b);
    let tx = tr.tEnd;
    for (const t of times) {
      if (volumeAt(tr.incVol, t) > 0 && volumeAt(tr.incVol, t) >= volumeAt(tr.outVol, t) - 1e-9) {
        tx = t;
        break;
      }
    }
    return {
      ...tr,
      incStart: Math.max(tr.incStart, tx - PLAY_LEAD_S),
      outVol: [{ t: tr.tStart, v: 1 }, { t: tx, v: 1 }, { t: tx + 0.02, v: 0 }],
      incVol: [{ t: Math.max(tr.incStart, tx - PLAY_LEAD_S), v: 0 }, { t: tx, v: 0 }, { t: tx + 0.02, v: 1 }],
      tEnd: tx + 0.05,
      marks: tr.marks.filter((m) => m.t <= tx + 0.05),
      why: `${tr.why} · a cut on this device (its player ignores volume)`,
    };
  }

  /**
   * Plan the way from `cur` into `nxt` (quick = Skip, or New Set's move into the new order).
   * @param {boolean} quick
   * @param {'skip'|'newset'} [why] what asked for the quick move (the plan's note says it)
   */
  function plan(quick, why = 'skip') {
    const t = now();
    const tr = planVideoTransition({
      seed,
      vibe,
      mode,
      playIndex: cur.id,
      prevType: cur.tr ? cur.tr.type : undefined,
      quick: !!quick,
      reason: why,
      earliest: t + (quick ? 0.1 : MARGIN),
      out: side(cur, true),
      inc: side(nxt, false),
    });
    if (!volumeWorks && cur.provider === 'youtube' && nxt.provider === 'youtube' && tr.type !== 'cut') {
      const cut = asCut(tr);
      cut.quick = !!quick;
      cur.trOut = cut;
      cur.outSent = false;
      nxt.tr = cut;
      nxt.inSent = false;
      skipQueued = false;
      bump();
      return cut;
    }
    tr.quick = !!quick;
    cur.trOut = tr;
    cur.outSent = false;
    nxt.tr = tr;
    nxt.inSent = false;
    skipQueued = false;
    bump();
    return tr;
  }

  /** May the announced transition still be changed? Not once anything of it is in motion. */
  function changeable(t) {
    const tr = cur && cur.trOut;
    if (!tr || !nxt || nxt.phase !== 'cued' || cur.outSent || nxt.inSent) return false;
    return tr.incStart - t > LOCK_S && tr.tStart - t > LOCK_S;
  }

  function startIncoming(rec, tr) {
    const g = setGen;
    rec.startTimer = now();
    if (rec.provider === 'preview') {
      if (!rec.inSent) rec.inSent = sendPreviewIn(rec, tr);
      if (!rec.inSent) {
        // no Web Audio (a browser that never let the context run): this play cannot be heard
        failPlay(rec, 'The preview could not be played (Web Audio is not running).');
        return;
      }
      rec.phase = 'live';
      bump();
      return;
    }
    const dk = deck(rec.deck);
    rec.phase = 'starting';
    rec.startedAt = tr.incStart + 0.3;
    const v = volumeAt(tr.incVol, now());
    gains[rec.deck] = v;
    bump();
    Promise.resolve()
      .then(() => {
        // given up on in the meantime (onVideoError's stop(), a new set): never start the abandoned song
        if (g !== setGen || rec.gone || rec.phase !== 'starting') throw Object.assign(new Error('superseded'), { code: 'superseded' });
        return dk.play({ volume: Math.min(1, v * volume) });
      })
      .then(
        () => {
          if (g !== setGen || rec.gone || rec.phase !== 'starting') return;
          rec.phase = 'live';
          rec.heardAt = now();
          rec.startedAt = now() - dk.position();
          bump();
          pump();
        },
        (err) => {
          if (g !== setGen || rec.gone || rec.phase !== 'starting') return;
          if (err && err.code === 'cancelled') {
            rec.phase = 'cued'; // a pause in the middle: resume() starts it again
            return;
          }
          if (err && err.code === 'blocked') {
            // The page has lost the right to play sound: hold the set until a tap.
            rec.phase = 'cued';
            holdForTap();
            return;
          }
          // The incoming will not play: the outgoing stays up, the slot is filled again.
          if (cur && cur.trOut === tr) cur.trOut = null;
          rec.tr = null;
          gains[rec.deck] = 0;
          onVideoError(rec, err);
        },
      );
  }

  /** The hand-over is complete: the incoming is the play on air, its old deck is free for the next song. */
  function finish() {
    const old = cur;
    old.phase = 'done';
    old.gone = true;
    if (old.provider === 'youtube') {
      try {
        deck(old.deck).stop();
      } catch {
        /* already gone */
      }
    }
    gains[old.deck] = 0;
    cur = nxt;
    nxt = null;
    if (old.entry !== cur.entry && entries.size > KEEP_BYTES_UP_TO) {
      old.entry.bytes = null;
      old.entry.buffer = null;
    }
    bump();
  }

  /** Has the song on air run out (its video ended, failed, or reached its own length)? */
  function songOver(rec, t) {
    if (rec.provider === 'preview') return fin(rec.startedAt) && rec.durationS > 0 && t >= rec.startedAt + rec.durationS - 0.05;
    const dk = deck(rec.deck);
    if (!dk) return true;
    if (dk.state === 'ended' || dk.state === 'error') return true;
    const d = dk.duration || rec.durationS;
    return d > 0 && dk.state === 'playing' && dk.position() >= d - 0.15;
  }

  function setGain(i, v) {
    gains[i] = v;
    const dk = deck(i);
    if (dk) dk.setVolume(Math.min(1, v * volume));
  }

  /** The ≈ 20 Hz part: volume lanes, starts and ends of the hand-over. */
  function drive() {
    if (!started || paused || !cur) return;
    const t = now();
    const tr = cur.trOut;
    if (cur.phase === 'live' && songOver(cur, t) && !(tr && t >= tr.tStart)) {
      // Ran out before its transition (the video is shorter than its plan, or it failed): the incoming
      // comes in as soon as it can, with a plan that knows the song is over.
      cur.phase = 'ended';
      cur.endedAt = t;
      cur.buffering = false;
      if (cur.provider === 'youtube') gains[cur.deck] = 0;
      if (tr && nxt) {
        cur.trOut = null;
        nxt.tr = null;
      }
      bump();
      pump();
      return;
    }
    if (tr && nxt && nxt.tr === tr) {
      if (!cur.outSent && t >= tr.tStart - FX_LEAD) {
        cur.outSent = true;
        sendFx(tr);
        if (cur.provider === 'preview') sendPreviewOut(cur, tr);
      }
      if (nxt.provider === 'preview' && !nxt.inSent && nxt.phase === 'cued' && t >= tr.incStart - FX_LEAD) nxt.inSent = sendPreviewIn(nxt, tr);
      if (nxt.phase === 'cued' && t >= tr.incStart) startIncoming(nxt, tr);
      if (cur.provider === 'youtube' && cur.phase === 'live') setGain(cur.deck, volumeAt(tr.outVol, t));
      if (nxt.provider === 'youtube' && (nxt.phase === 'starting' || nxt.phase === 'live')) setGain(nxt.deck, volumeAt(tr.incVol, t));
      else if (nxt.provider === 'preview') gains[nxt.deck] = t >= tr.incStart ? volumeAt(tr.incVol, t) : 0;
      if (cur.provider === 'preview') gains[cur.deck] = volumeAt(tr.outVol, t);
      if (t >= tr.tEnd + 0.05) {
        if (nxt.phase === 'live') {
          finish();
          if (pendingNew) applyPendingNewSet();
        } else if (nxt.phase === 'starting' && t > Math.max(tr.tEnd, nxt.startTimer) + START_GRACE_S) {
          // (counted from when play() was issued too: a late wake-up may issue it after tEnd)
          // play() never got there: give up on that video, keep the slot
          const rec = nxt;
          cur.trOut = null;
          rec.tr = null;
          onVideoError(rec, Object.assign(new Error('The video did not start'), { code: 'timeout' }));
        }
      }
      return;
    }
    if (cur.phase === 'live') {
      if (cur.provider === 'youtube') setGain(cur.deck, 1);
      else gains[cur.deck] = 1;
    }
  }

  // ── the opener ─────────────────────────────────────────────────────────────────────────────────

  function startOpener() {
    const rec = cur;
    if (!rec || starting || started || !allowed || rec.phase !== 'cued') return;
    starting = true;
    const g = setGen;
    const engineUp = ensureEngine();
    if (rec.provider === 'preview') {
      // the opener's video failed: its preview opens the set through Web Audio
      engineUp.then(() => {
        if (g !== setGen) return;
        starting = false;
        if (!engineLive()) {
          holdForTap();
          return;
        }
        begun(rec, 0);
        rec.inSent = sendPreviewIn(rec, null, 0);
        gains[rec.deck] = 1;
        pump();
      });
      return;
    }
    const dk = deck(rec.deck);
    rec.phase = 'starting';
    gains[rec.deck] = 1;
    bump();
    Promise.resolve()
      .then(() => {
        if (g !== setGen || rec.gone || rec.phase !== 'starting') throw Object.assign(new Error('superseded'), { code: 'superseded' });
        return dk.play({ volume: Math.min(1, volume) });
      })
      .then(
        () => {
          if (g !== setGen) return;
          starting = false;
          begun(rec, dk.position());
          pump();
        },
        (err) => {
          if (g !== setGen) return;
          starting = false;
          if (err && err.code === 'superseded') return; // given up on before play() was sent
          gains[rec.deck] = 0;
          if (err && err.code === 'cancelled') {
            rec.phase = 'cued';
            return;
          }
          if (err && err.code === 'blocked') {
            rec.phase = 'cued';
            needsTap = true;
            allowed = false;
            bump();
            publish();
            return;
          }
          onVideoError(rec, err);
        },
      );
  }

  /** The first sample is out: set time starts (at the song position already played). */
  function begun(rec, pos) {
    // the set this one took over from played on until now (the first song's ad): Elapsed keeps that time
    if (carryRunsFrom >= 0) {
      elapsedBase = carriedElapsed();
      carryRunsFrom = -1;
    }
    origin = clock() - (pos > 0 ? pos : 0) * 1000;
    pausedMs = 0;
    started = true;
    paused = false;
    userPaused = false;
    needsTap = false;
    rec.phase = 'live';
    rec.startedAt = 0;
    bump();
    emit('start', { seed, trackId: rec.entry.id });
  }

  function holdForTap() {
    if (!started) {
      needsTap = true;
      allowed = false;
      bump();
      return;
    }
    if (paused) return;
    paused = true;
    userPaused = false;
    needsTap = true;
    pausedAt = clock();
    holdDecks();
    bump();
    publish();
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────────────────────────

  let pumping = false;
  let pumpAgain = false;
  /** One planning step at a time: a deck's state report or a settled job during a step asks for another after it. */
  function pump() {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      for (let guard = 0; guard < 4; guard++) {
        pumpAgain = false;
        step();
        if (!pumpAgain) break;
      }
    } finally {
      pumping = false;
    }
  }

  function step() {
    if (!playlist) return;
    const hidden = pageHidden();
    if (!fatal && !unavailable) {
      schedule();
      resumePreviewWaits();
      if (!hidden) recueHeld();
      quietIdleDecks(hidden);
      if (!started) {
        if (!cur) {
          const c = pickNext(false);
          if (c) ready(c, 0, 'cur');
        }
        // the free deck pre-rolls the second song at the same time: both ads run at once
        if (cur && !nxt) {
          const c = pickNext(false);
          if (c) ready(c, 1 - cur.deck, 'nxt');
        }
        cueWatch(cur, 0);
        cueWatch(nxt, 0);
        swapOpener();
        if (cur && cur.phase === 'cued' && allowed) startOpener();
        checkUsable();
        checkFatal();
      } else {
        audioState(true);
        refill();
        const t = now();
        if (cur && cur.provider === 'youtube' && cur.phase === 'live' && !cur.trOut && !paused) {
          // A buffering stall or a mid-roll ad holds the song back against the set clock: the plan to
          // come is made from where the song really is.
          const dk = deck(cur.deck);
          if (dk && dk.state === 'playing') cur.startedAt = t - dk.position();
        }
        watchStall();
        // New set pressed during a hand-over that has since come apart (its incoming failed): now
        if (pendingNew && !paused && cur && !inMotion() && (cur.phase === 'live' || (cur.phase === 'ended' && !incomingDue()))) applyPendingNewSet();
        if (!nxt && cur) {
          const c = pickNext(!freshOrder && (timeToLeave(t) < URGENT_S || cur.provider === 'preview' || cur.phase === 'ended'));
          if (c) {
            freshOrder = false;
            ready(c, 1 - cur.deck, 'nxt');
          }
        }
        cueWatch(nxt, t);
        standIn(t);
        if (!paused && cur && nxt && incomingReady(nxt)) {
          const tr = cur.trOut;
          if (skipQueued && (!tr || changeable(t))) plan(true, quickWhy);
          else if (!tr) plan(false);
          else maybeReplan(t);
        }
        checkUsable();
      }
    }
    publish();
  }

  /**
   * A deck that carries no video of this set must not play. A pre-roll this set gave up on (its song now
   * plays as a preview, or it is held) or the last song can go on by itself after stop(): a pause sent
   * while the player is still loading, or while Chrome holds it in a background tab, is lost — seen in a
   * real background tab (2026-10-06): the deck went on 'playing' muted under a preview. Such a deck is told
   * to stop again whenever it says it runs; and for a few seconds after the tab is shown (Chrome then
   * resumes, by itself, a muted player it paused in the background, whatever the deck believes), any idle
   * deck that holds something is.
   * @param {boolean} hidden
   */
  function quietIdleDecks(hidden) {
    const justBack = !hidden && hiddenAt >= 0 && clock() - visibleSince <= REVIVE_AFTER_MS;
    for (let i = 0; i < 2; i++) {
      const rec = onDeck(i);
      if (rec && rec.provider === 'youtube' && !rec.held) continue;
      const dk = deck(i);
      if (!dk) continue;
      const runs = dk.state === 'playing' || dk.state === 'ad' || dk.state === 'loading';
      if (runs || (justBack && dk.state !== 'empty')) stopDeck(i);
    }
  }

  /** Plays held by a background tab: the page is in front again, cue the same upload again. */
  function recueHeld() {
    for (const rec of [cur, nxt]) {
      if (rec && rec.held && !rec.gone && rec.provider === 'youtube' && rec.videoId) cueVideo(rec, rec.videoId);
    }
  }

  /**
   * The next song is held by a background tab (its player could not pre-roll there), or is still not cued
   * after a while in one (Chrome holds a muted pre-roll still in a hidden tab without failing it — measured
   * with real background throttling, 2026-10-06), and the song on air is on its way out: its preview
   * stands in (Web Audio plays on in a background tab), so the set goes on instead of falling silent
   * until the page is shown again. In front, a pre-roll still running is waited for as before.
   */
  function standIn(t) {
    const rec = nxt;
    if (!rec || rec.gone || !cur || paused || rec.provider !== 'youtube' || rec.phase !== 'cueing') return;
    if (!rec.held && !(pageHidden() && rec.cueHiddenMs >= STANDIN_HIDDEN_MS)) return;
    // A pre-roll whose ad still moves in the background tab (unmuted at volume 0 it runs on there) is
    // waited for as in front: the song on air plays on; once the music stops, cueWatch's SILENT_WAIT_S
    // rule brings the preview in. Only a held play, or a pre-roll that does not move, is stood in for.
    if (!rec.held && adMoving(rec, AD_HELD_MS)) return;
    // (its pre-roll has just ended: the deck says 'cued' and the cue's promise is about to settle)
    const dk = deck(rec.deck);
    if (!rec.held && dk && dk.state === 'cued' && dk.videoId === rec.videoId) return;
    const due = cur.phase === 'ended' || timeToLeave(t) <= STANDIN_LEAD_S || remainingOnAir(t) <= STANDIN_LEAD_S;
    if (!due || !previewReady(rec.entry)) return;
    if (!rec.held) stopDeck(rec.deck); // (a held play's deck is stopped already)
    usePreview(rec, 'background');
  }

  /**
   * Before the start: the second song is cued and the opener is still in its ad (or its player is stuck,
   * or held by a background tab) SWAP_AFTER_S later — the set opens with the cued song, and the opener's
   * pre-roll goes on as the next song (its ad keeps counting down; nothing is cancelled). Without this a
   * long ad pod, or an opener that times out into another upload, kept the set silent for minutes while
   * a song sat ready on the other deck. The seeded order changes only by swapping its first two songs.
   */
  function swapOpener() {
    if (started || starting || !allowed || !cur || !nxt) return;
    if (cur.phase !== 'cueing' || nxt.phase !== 'cued' || nxt.provider !== 'youtube') return;
    if (clock() - nxt.cuedAt < SWAP_AFTER_S * 1000) return;
    const a = cur;
    const b = nxt;
    const id = a.id;
    a.id = b.id;
    b.id = id;
    plays.sort((x, y) => x.id - y.id);
    cur = b;
    nxt = a;
    for (const r of [a, b]) {
      r.tr = null;
      r.trOut = null;
      r.leaveKey = '';
    }
    bump();
  }

  /**
   * The pre-roll's ad clock grew within the last `withinMs` (the deck counts it only while it moves). Its
   * 'loading' right after the ad counts too: the song has started and the deck is holding it at its cue
   * point (a second or so) — cutting it there for a preview was seen in a real background tab (2026-10-06).
   */
  function adMoving(rec, withinMs = AD_STILL_MS) {
    const dk = deck(rec.deck);
    return !!dk && (dk.state === 'ad' || dk.state === 'loading') && clock() - rec.adGrewAt < withinMs;
  }

  /** Is a hand-over in motion (anything of it handed over to a deck or the engine)? */
  function inMotion() {
    return !!(nxt && (nxt.phase === 'starting' || nxt.phase === 'live' || nxt.inSent || (cur && cur.trOut && cur.outSent)));
  }

  /**
   * The song on air has stood still for STALL_S while its player says it plays: it is buffering (the
   * network). The set says so (snapshot.stalled, the ticker) instead of claiming to play; YouTube picks
   * the song up by itself once data arrives again.
   */
  function watchStall() {
    const rec = cur;
    if (!rec) return;
    const dk = rec.provider === 'youtube' && rec.phase === 'live' && !paused ? deck(rec.deck) : null;
    if (!dk || dk.state !== 'playing') {
      rec.stallPos = NaN;
      if (rec.buffering) {
        rec.buffering = false;
        bump();
      }
      return;
    }
    const pos = dk.position();
    const ms = clock();
    if (!fin(rec.stallPos) || Math.abs(pos - rec.stallPos) > 0.05) {
      rec.stallPos = pos;
      rec.stallAt = ms;
      if (rec.buffering) {
        rec.buffering = false;
        bump();
      }
      return;
    }
    if (!rec.buffering && ms - rec.stallAt >= STALL_S * 1000) {
      rec.buffering = true;
      bump();
    }
  }

  function maybeReplan(t) {
    if (!replanAt || clock() < replanAt) return;
    replanAt = 0;
    if (!changeable(t) || cur.trOut.quick) return;
    plan(false);
  }

  function tick() {
    ticks++;
    drive();
    if (ticks % PUMP_EVERY === 0) pump();
  }

  function startTimer() {
    if (!useTimers || timer) return;
    timer = timerApi.setInterval(tick, TICK_MS);
  }

  /**
   * The player on air was paused or started by something else than this conductor (a click on the video
   * itself): the set follows, so the transport tells the truth.
   * @param {boolean} [quiet] called from pump(): do not pump again
   */
  function audioState(quiet) {
    if (!started || !cur || cur.provider !== 'youtube' || cur.phase !== 'live') return;
    const dk = deck(cur.deck);
    if (!dk) return;
    const inTransition = cur.trOut && now() >= cur.trOut.incStart;
    if (!paused && dk.state === 'paused' && !inTransition) {
      paused = true;
      userPaused = true;
      pausedAt = clock();
      holdDecks(cur.deck);
      bump();
      if (!quiet) publish();
    } else if (paused && !resuming && dk.state === 'playing') {
      pausedMs += clock() - pausedAt;
      paused = false;
      userPaused = false;
      needsTap = false;
      bump();
      if (engine && engineStarted) Promise.resolve(engine.resume()).catch(() => {});
      if (!quiet) pump();
    }
  }

  /** Pause every deck that is sounding (except `skip`), and the engine. */
  function holdDecks(skip = -1) {
    for (const rec of [cur, nxt]) {
      if (!rec || rec.provider !== 'youtube' || rec.deck === skip) continue;
      const dk = deck(rec.deck);
      if (!dk) continue;
      try {
        if (rec.phase === 'live' || rec.phase === 'ended') dk.pause();
        else if (rec.phase === 'starting') {
          dk.stop();
          rec.phase = 'cued';
        }
      } catch {
        /* the player is gone */
      }
    }
    if (engine && engineStarted) Promise.resolve(engine.pause()).catch(() => {});
  }

  let resuming = false;

  function publish() {
    const st = started ? null : status();
    const text = st ? `${st.title}|${st.detail}|${st.progress}` : '';
    if (text !== lastStatus) {
      lastStatus = text;
      if (st) emit('status', st);
    }
    const t = now();
    const tr = cur && cur.trOut;
    const sig = [
      rev,
      started,
      paused,
      needsTap,
      cur ? `${cur.id}:${cur.phase}:${deckState(cur)}` : '-',
      nxt ? `${nxt.id}:${nxt.phase}:${deckState(nxt)}` : '-',
      tr ? (t >= tr.tEnd ? 3 : t >= tr.tStart ? 2 : 1) : 0,
      canSkip() ? 1 : 0,
      stalledFor(t),
    ].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      emit('change', undefined);
    }
  }

  const deckState = (rec) => {
    if (!rec || rec.provider !== 'youtube') return '';
    const dk = deck(rec.deck);
    return dk ? dk.state : '';
  };

  // ── public: lifecycle ──────────────────────────────────────────────────────────────────────────

  function resetSet() {
    for (const rec of [cur, nxt]) {
      if (rec) rec.gone = true;
    }
    for (let i = 0; i < 2; i++) {
      const dk = deck(i);
      if (!dk) continue;
      try {
        dk.stop();
      } catch {
        /* not created yet */
      }
      gains[i] = 0;
    }
    if (engine && (engineStarted || engineStarting) && engine.reset) Promise.resolve(engine.reset()).catch(() => {});
    engineStarted = false;
    engineStarting = null;
    plays = [];
    cur = null;
    nxt = null;
    started = false;
    starting = false;
    paused = false;
    userPaused = false;
    needsTap = false;
    skipQueued = false;
    freshOrder = false;
    pendingNew = false;
    replanAt = 0;
    origin = pausedAt = pausedMs = 0;
    lastSig = '';
    lastStatus = '';
  }

  function newOrder() {
    const planner = createPlanner({ seed, vibe, mode });
    order = planner.order(ids);
    queue = order.slice();
    queuePass = new Map(order.map((id) => [id, 0]));
    cycle = 0;
    for (const e of entries.values()) e.playCount = 0;
  }

  /**
   * @param {any} pl Playlist
   * @param {{seed?: string, vibe?: number, mode?: string, autostart?: boolean, patient?: boolean,
   *   carry?: {played?: string[], elapsed?: number, at?: number, live?: boolean}}} [opts]
   *   autostart: a user gesture already happened — the opener plays as soon as it is cued
   *   carry: the set this one takes over from (Preview ↔ full songs, main.js): the track ids it has played
   *   or has on air (oldest first) are taken out of this order's first pass and shown as played, and
   *   Elapsed goes on from its set time. `live` + `at` (clock ms the elapsed was read at): that set plays
   *   on until this one sounds (the first song's ad), and Elapsed runs on through the wait.
   */
  function load(pl, opts = {}) {
    stop();
    crateGen++;
    setGen++;
    abort = typeof AbortController === 'function' ? new AbortController() : null;
    playlist = pl;
    entries = new Map();
    ids = [];
    for (const meta of (pl && pl.tracks) || []) {
      if (!meta || meta.id == null || entries.has(meta.id)) continue;
      entries.set(meta.id, newEntry(meta, ids.length));
      ids.push(meta.id);
    }
    jobs = { video: 0, preview: 0 };
    lookups = { ok: 0, network: 0 };
    cues = { ok: 0, failed: 0, refusedTracks: 0 };
    unavailable = false;
    fatal = null;
    seed = String(opts.seed || randomSeed());
    if (fin(opts.vibe)) vibe = clamp01(opts.vibe);
    if (FULL_MODES.includes(opts.mode)) mode = opts.mode;
    allowed = !!opts.autostart;
    resetSet();
    newOrder();
    const carry = opts.carry || {};
    carried = [];
    for (const id of Array.isArray(carry.played) ? carry.played : []) {
      const e = entries.get(id);
      if (!e || carried.includes(e)) continue;
      carried.push(e);
      take(e);
    }
    elapsedBase = fin(carry.elapsed) && carry.elapsed > 0 ? carry.elapsed : 0;
    carryRunsFrom = carry.live && fin(carry.at) ? carry.at : -1;
    bump();
    if (!ids.length) {
      fatal = 'That playlist has no songs in it.';
      emit('error', { message: fatal });
      return;
    }
    startTimer();
    pump();
  }

  /** A user gesture happened: the opener plays as soon as it is cued (or now, if it is). */
  function begin() {
    if (!playlist) return;
    allowed = true;
    needsTap = false;
    unlockDecks();
    ensureEngine();
    pump();
  }

  /**
   * Same crate, new seed. With a song on air the music does not stop: that song plays on, the new running
   * order's first song pre-rolls on the free deck, and the set skips into it the moment it is cued — a
   * fresh opener would otherwise mean silence for the length of its ad. A hand-over already in motion
   * (from FX_LEAD before it, or Skip's quick move) is finished first; the song it brings in then bridges
   * the two sets. Only with nothing audible (not started, paused, the song on air over) a full reset.
   */
  function newSet(nextSeed) {
    if (!playlist) return;
    if (started && !paused && cur && (cur.phase === 'live' || cur.phase === 'ended')) {
      seed = String(nextSeed || randomSeed());
      // A hand-over in motion — or a song that ran out with its incoming cued and about to come in (a long
      // ad delayed it): let it come in, then the new order takes over under it. Resetting here meant
      // silence for two fresh ads (seen in a real run, 2026-10-06).
      if (inMotion() || incomingDue()) {
        pendingNew = true;
        skipQueued = false;
        bump();
        publish();
        return;
      }
      if (cur.phase === 'live') {
        softNewSet();
        return;
      }
      hardNewSet(seed); // ended, nothing on its way in: a fresh start with the new seed
      return;
    }
    hardNewSet(nextSeed);
  }

  /** The song on air has ended and the incoming is cued (its move into it is planned or about to be). */
  function incomingDue() {
    return !!(cur && cur.phase === 'ended' && nxt && !nxt.gone && nxt.phase === 'cued');
  }

  /** New set pressed during a hand-over: the hand-over is done (or came apart), the new order takes over. */
  function applyPendingNewSet() {
    pendingNew = false;
    if (started && !paused && cur && cur.phase === 'live') softNewSet();
    else hardNewSet(seed);
  }

  /** The new order (seed already set) under the song on air, which plays on. */
  function softNewSet() {
    pendingNew = false;
    setGen++;
    if (nxt) {
      nxt.gone = true;
      plays = plays.filter((r) => r !== nxt);
      if (nxt.provider === 'youtube') stopDeck(nxt.deck);
      nxt.entry.playCount = Math.max(0, nxt.entry.playCount - 1);
    }
    nxt = null;
    cur.trOut = null;
    cur.outSent = false;
    newOrder();
    carried = [];
    elapsedBase = 0;
    carryRunsFrom = -1;
    plays = [cur];
    take(cur.entry); // just heard: it waits for the next pass
    cur.entry.playCount = 1;
    freshOrder = true;
    // the song on air is not this set's first: the new order's head comes in as soon as it can
    skipQueued = true;
    quickWhy = 'newset';
    replanAt = 0;
    lastSig = '';
    bump();
    pump();
  }

  /** Nothing audible: stop everything and start the new order from a fresh opener. */
  function hardNewSet(nextSeed) {
    setGen++;
    resetSet();
    carried = [];
    elapsedBase = 0;
    carryRunsFrom = -1;
    seed = String(nextSeed || randomSeed());
    newOrder();
    for (const e of entries.values()) {
      if (e.dead && e.vError && e.vError.code === 'network') e.dead = false;
    }
    allowed = true;
    bump();
    pump();
  }

  function stop() {
    if (!playlist) return;
    setGen++;
    crateGen++;
    if (abort) abort.abort();
    abort = null;
    if (timer) timerApi.clearInterval(timer);
    timer = null;
    resetSet();
    playlist = null;
    entries = new Map();
    ids = [];
    order = [];
    queue = [];
    allowed = false;
    fatal = null;
    bump();
  }

  async function pause() {
    if (!started || userPaused) return;
    if (!paused) pausedAt = clock();
    paused = true;
    userPaused = true;
    holdDecks();
    bump();
    publish();
  }

  /** Play: call synchronously from the tap (YouTube and Web Audio both want one for sound). */
  async function resume() {
    if (!started) {
      begin();
      return;
    }
    if (!paused) return;
    resuming = true;
    pausedMs += clock() - pausedAt;
    paused = false;
    userPaused = false;
    needsTap = false;
    bump();
    const g = setGen;
    const waits = [];
    if (engine && engineStarted) waits.push(Promise.resolve(engine.resume()).catch(() => {}));
    for (const rec of [cur, nxt]) {
      if (!rec || rec.provider !== 'youtube' || rec.phase !== 'live') continue;
      const dk = deck(rec.deck);
      if (!dk) continue;
      const v = gains[rec.deck];
      waits.push(
        Promise.resolve()
          .then(() => dk.play({ volume: Math.min(1, v * volume) }))
          .catch((err) => {
            if (g === setGen && err && err.code === 'blocked') holdForTap();
          }),
      );
    }
    // (an incoming that the pause stopped in the middle of its start is started again by drive())
    await Promise.all(waits);
    resuming = false;
    pump();
  }

  function setVibe(v) {
    if (!fin(v)) return;
    const next = clamp01(v);
    if (next === vibe) return;
    vibe = next;
    if (started) replanAt = clock() + VIBE_SETTLE_MS;
    bump();
  }

  /** Track length: 'short' | 'medium' | 'full' (Preview is main.js's business: another conductor). */
  function setMode(m) {
    if (!FULL_MODES.includes(m) || m === mode) return;
    mode = m;
    if (started) replanAt = clock();
    bump();
    pump();
  }

  /** The user's volume, 0..1: multiplies every lane (capped at 1 — YouTube's own maximum). */
  function setVolume(v) {
    if (!fin(v)) return;
    volume = Math.max(0, v);
    for (let i = 0; i < 2; i++) {
      const dk = deck(i);
      if (dk && gains[i] > 0) dk.setVolume(Math.min(1, gains[i] * volume));
    }
    if (engine) engine.setVolume(Math.min(1.25, volume));
  }

  // ── Skip ───────────────────────────────────────────────────────────────────────────────────────

  /** 'now' (quick transition into a ready song), 'queue' (the next song is still in its ad), or ''. */
  function skipMode(t) {
    if (!started || paused || !cur || fatal || unavailable || skipQueued || pendingNew) return '';
    if (cur.phase !== 'live') return '';
    if (cur.tr && t < cur.tr.tEnd) return '';
    if (cur.trOut && (cur.outSent || (nxt && nxt.inSent) || t > cur.trOut.incStart - LOCK_S || t > cur.trOut.tStart - LOCK_S)) return '';
    if (cur.provider === 'preview' && cur.durationS - (t - cur.startedAt) < 3) return '';
    if (nxt && incomingReady(nxt)) return 'now';
    if (nxt || upcoming(2).some((e) => e !== cur.entry)) return 'queue';
    return '';
  }

  function canSkip() {
    return !!skipMode(now());
  }

  function skip() {
    const how = skipMode(now());
    if (!how) return false;
    if (how === 'now') {
      plan(true, 'skip');
      emit('skip', { to: nxt.entry.id });
    } else {
      skipQueued = true;
      quickWhy = 'skip';
      emit('notice', { message: 'Next song after its ad', kind: 'info' });
      bump();
    }
    publish();
    return true;
  }

  // ── what the UI shows ──────────────────────────────────────────────────────────────────────────

  function stalledFor(t) {
    if (!started || paused || !cur) return '';
    // the song on air is buffering (and nothing else is coming in over it): the network
    if (cur.buffering && !(nxt && nxt.tr && t >= nxt.tr.incStart)) return 'network';
    if (cur.phase !== 'ended') return '';
    if (nxt && nxt.tr && t >= nxt.tr.incStart) return '';
    for (const e of upcoming(LOOKAHEAD)) if (e.vError && e.vError.code === 'network') return 'network';
    return 'loading';
  }

  function deckStatus(rec, t) {
    const dk = rec.provider === 'youtube' ? deck(rec.deck) : null;
    const tin = rec.tr;
    const tout = rec.trOut;
    const mixing = (tin && t >= tin.tStart && t < tin.tEnd) || (tout && t >= tout.tStart && t < tout.tEnd);
    switch (rec.phase) {
      case 'cueing':
        if (rec.provider === 'preview') return { status: 'loading', statusText: 'Preparing its preview' };
        if (rec.held) return { status: 'loading', statusText: 'Loads when this tab is in front' };
        if (dk && dk.state === 'ad') return { status: 'ad', statusText: !started && rec === cur ? 'Starting · ad playing' : undefined };
        return { status: 'loading' };
      case 'cued':
        if (!started && rec === cur) return { status: 'cued', statusText: needsTap || !allowed ? 'Cued · press Play' : 'Cued · starting' };
        // (a fallback leaves the player showing YouTube's own "unavailable" screen: say what will play instead)
        if (rec.provider === 'preview') return { status: 'cued', statusText: 'No video · its preview is cued' };
        return { status: 'cued' };
      case 'starting':
        return { status: mixing ? 'mixing' : 'loading', statusText: mixing ? undefined : 'Starting' };
      case 'live':
        if (dk && dk.state === 'ad') return { status: 'ad', statusText: 'Ad playing' };
        if (rec.buffering) return { status: 'loading', statusText: 'Buffering' };
        // a preview play: no statusText, so the view says it its own way ("No video · its 30-s preview")
        return { status: mixing ? 'mixing' : 'live' };
      case 'ended':
        return { status: 'cued', statusText: 'Ended' };
      default:
        return { status: 'error' };
    }
  }

  function deckInfo(rec, t) {
    if (!rec) return null;
    const e = rec.entry;
    const an = e.analysis;
    const yt = rec.provider === 'youtube';
    const dk = yt ? deck(rec.deck) : null;
    const { status: st, statusText } = deckStatus(rec, t);
    return {
      playId: rec.id,
      title: e.meta.title,
      artist: e.meta.artist || '',
      artwork: e.meta.artwork || (e.ref && e.ref.artwork),
      link: yt && rec.videoId ? `https://www.youtube.com/watch?v=${rec.videoId}` : e.meta.link || (e.ref && e.ref.link),
      bpm: an && an.bpmConfidence >= 0.5 ? an.bpm : NaN,
      camelot: an && an.key ? an.key.camelot : undefined,
      keyName: an && an.key ? an.key.name : undefined,
      duration: (dk && dk.duration) || rec.durationS || (e.meta.durationMs > 0 ? e.meta.durationMs / 1000 : 0),
      provider: rec.provider,
      wave: !yt && an ? an.wave : null,
      beats: [],
      downbeat: 0,
      cues: null,
      status: st,
      statusText,
    };
  }

  /** The play shown on deck d. */
  function onDeck(d) {
    if (cur && cur.deck === d) return cur;
    if (nxt && nxt.deck === d) return nxt;
    return null;
  }

  function startingView() {
    const rec = cur;
    let why;
    if (!rec) why = 'Finding the first song on YouTube…';
    else if (rec.phase === 'cueing') {
      const dk = rec.provider === 'youtube' ? deck(rec.deck) : null;
      if (rec.held) why = 'The browser doesn’t load YouTube videos while Segue is in a background tab — the set starts once this tab is in front.';
      else if (dk && dk.state === 'ad') why = nxt && nxt.phase === 'cued' ? 'YouTube plays an ad before the first song — muted here; if it runs long, the set opens with the next song, which is ready.' : 'YouTube plays an ad before the first song — muted here; the set starts when it ends.';
      else why = rec.provider === 'preview' ? 'Getting the first song’s preview ready…' : 'Loading the first song…';
    } else if (needsTap || !allowed) why = 'Ready — press Play to start the set.';
    else why = 'Starting…';
    return { type: 'start', label: 'Starting the set', why, state: 'starting', fromTitle: '', toTitle: rec ? rec.entry.meta.title : '', tStart: 0, tEnd: 0, marks: [], synced: false };
  }

  function transitionInfo(t) {
    if (!playlist) return null;
    if (!started) return startingView();
    if (!cur) return null;
    const tr = cur.trOut;
    if (cur.buffering && cur.phase === 'live' && !(tr && nxt && nxt.tr === tr && t >= tr.incStart)) {
      return {
        type: 'wait',
        label: 'Buffering',
        why: 'The song stopped loading — YouTube picks it up where it left off as soon as data arrives again (check the connection).',
        reason: 'network',
        fromTitle: cur.entry.meta.title,
        toTitle: '',
        state: 'waiting',
        tStart: t,
        tEnd: t,
        marks: [],
        synced: false,
      };
    }
    if (tr && nxt && nxt.tr === tr) {
      return {
        type: tr.type,
        label: tr.label,
        why: tr.why,
        fromTitle: cur.entry.meta.title,
        toTitle: nxt.entry.meta.title,
        state: t >= tr.tStart ? 'active' : 'upcoming',
        tStart: tr.tStart,
        tEnd: tr.tEnd,
        marks: tr.marks,
        synced: false,
      };
    }
    const behind = nxt && nxt.phase === 'cueing';
    const over = cur.phase === 'ended';
    const due = cur.phase === 'live' && timeToLeave(t) <= 0;
    if (over || ((skipQueued || due) && behind)) {
      const dk = behind && nxt.provider === 'youtube' ? deck(nxt.deck) : null;
      const inAd = dk && dk.state === 'ad';
      const held = behind && nxt.held;
      const reason = stalledFor(t) || 'loading';
      return {
        type: 'wait',
        label: behind && inAd ? 'Next song after its ad' : 'Waiting for the next song',
        why: held
          ? 'The browser doesn’t load YouTube videos in a background tab — the next song loads once this tab is in front (its preview stands in if it is ready).'
          : over
            ? reason === 'network'
              ? 'Can’t reach YouTube right now — the set picks up when the connection is back.'
              : inAd
                ? 'YouTube is showing an ad before the next song (muted, in plain view); it starts as soon as the ad ends.'
                : 'The set picks up as soon as the next song has loaded.'
            : inAd
              ? 'YouTube is showing an ad before the next song (muted, on the other deck) — this one plays on until it ends.'
              : 'The next song is still loading on the other deck — this one plays on until it is ready.',
        reason,
        fromTitle: '',
        toTitle: nxt ? nxt.entry.meta.title : '',
        state: 'waiting',
        tStart: t,
        tEnd: t,
        marks: [],
        synced: false,
      };
    }
    return null;
  }

  function setlistItems(t) {
    const items = [];
    const seen = new Set();
    const row = (e, key, st, extra) => {
      if (seen.has(key)) return;
      seen.add(key);
      const an = e.analysis;
      items.push({
        key,
        title: e.meta.title,
        artist: e.meta.artist || '',
        artwork: e.meta.artwork || (e.ref && e.ref.artwork),
        bpm: an && an.bpmConfidence >= 0.5 ? Math.round(an.bpm) : undefined,
        camelot: an && an.key ? an.key.camelot : undefined,
        state: st,
        link: e.meta.link || (e.ref && e.ref.link),
        ...extra,
      });
    };
    const tr = cur && cur.trOut;
    const mixing = !!tr && started && t >= tr.tStart && t < tr.tEnd;
    const onAir = new Set();
    carried.forEach((e, i) => row(e, `${e.id}|c${i}`, 'played'));
    for (const rec of plays) {
      let st = 'played';
      if (rec === cur) st = !started ? 'next' : mixing ? 'playing' : rec.phase === 'ended' ? 'played' : 'playing';
      else if (rec === nxt) st = mixing ? 'mixing' : 'next';
      else if (!rec.gone) continue;
      if (st !== 'played') onAir.add(rec.entry);
      row(rec.entry, rec.key, st, { via: rec.tr ? rec.tr.label : undefined, deck: rec.deck, ...(rec.round > 0 ? { again: true } : {}) });
    }
    const head = upcoming(1)[0];
    const pass = head ? queuePass.get(head.id) : 0;
    for (const id of queue) {
      const e = entries.get(id);
      if (!e || e.dead || queuePass.get(id) !== pass || onAir.has(e)) continue;
      row(e, `${e.id}|${e.playCount}`, e.vStatus === 'working' ? 'loading' : 'queued', e.playCount > 0 ? { again: true } : undefined);
    }
    for (const e of entries.values()) if (e.dead) row(e, `${e.id}|x`, 'failed');
    return items;
  }

  function stats() {
    let resolved = 0;
    let ready = 0;
    let failed = 0;
    let pending = 0;
    let videos = 0;
    let previews = 0;
    for (const e of entries.values()) {
      if (videoKnown(e)) videos++;
      if (previewReady(e)) previews++;
      if (playable(e)) {
        resolved++;
        ready++;
      }
      if (e.dead) failed++;
      else if (!playable(e)) pending++;
    }
    return { total: entries.size, resolved, ready, analysed: previews, failed, pending, videos, previews };
  }

  function status() {
    if (!playlist) return null;
    const rec = cur;
    if (!rec) return { title: 'Finding the songs', detail: 'Looking the first song up on YouTube…', progress: 0.1 };
    const name = rec.entry.meta.artist ? `${rec.entry.meta.artist} · ${rec.entry.meta.title}` : rec.entry.meta.title;
    if (rec.phase === 'cueing') {
      const dk = rec.provider === 'youtube' ? deck(rec.deck) : null;
      return { title: 'Cueing the first song', detail: dk && dk.state === 'ad' ? `YouTube ad before ${name}` : `Loading ${name}`, progress: dk && dk.state === 'ad' ? 0.6 : 0.4 };
    }
    return { title: 'Dropping the needle', detail: allowed && !needsTap ? 'Starting the set…' : 'Ready when you are.', progress: 1 };
  }

  /** Everything the view needs outside the per-frame path. A fresh object each call. */
  function snapshot() {
    const t = now();
    const tr = cur && cur.trOut;
    return {
      loaded: !!playlist,
      started,
      playing: started && !paused,
      paused,
      needsTap,
      stalled: stalledFor(t),
      buffering: !!(started && cur && cur.buffering),
      fatal,
      unavailable,
      seed,
      vibe,
      mode,
      modeEnabled: true,
      canSkip: started && !!skipMode(t),
      skipQueued,
      stageMode: 'video',
      recordEnabled: false,
      recordWhy: RECORD_WHY,
      playlist: playlist
        ? { id: playlist.id, title: playlist.title, subtitle: playlist.subtitle, artwork: playlist.artwork, link: playlist.link, source: playlist.source, count: ids.length, total: playlist.total }
        : null,
      now: t,
      /** what Elapsed shows: set time plus the time carried over from the set this one took over from */
      elapsed: (t > 0 ? t : 0) + carriedElapsed(),
      playIndex: cur ? cur.id : -1,
      current: cur && started ? { playId: cur.id, trackId: cur.entry.id, title: cur.entry.meta.title, artist: cur.entry.meta.artist || '', artwork: cur.entry.meta.artwork || (cur.entry.ref && cur.entry.ref.artwork) } : null,
      decks: [deckInfo(onDeck(0), t), deckInfo(onDeck(1), t)],
      transition: transitionInfo(t),
      leaveAt: cur ? leaveEstimate(cur) : NaN,
      setlist: playlist ? setlistItems(t) : [],
      stats: stats(),
      status: started ? null : status(),
      tr: tr ? { type: tr.type, tStart: tr.tStart, tEnd: tr.tEnd } : null,
    };
  }

  // ── per frame (allocation-free) ────────────────────────────────────────────────────────────────

  const mkDf = () => ({ pos: 0, rate: 1, bpmNow: NaN, gain: 0, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0, startsIn: 0, duration: 0, leaveAt: 0, eqActive: false });
  const dfs = [mkDf(), mkDf()];
  const silent = { rms: 0, peak: 0, bands: new Uint8Array(512), wave: new Uint8Array(1024).fill(128) };

  /**
   * Fill a FrameState for the view (SPEC §4 / §6.5) at set time t (default: now).
   * @param {number} [t]
   * @param {any} [out]
   */
  function frame(t, out) {
    const f = out || { decks: [null, null] };
    const tt = fin(t) ? t : now();
    f.t = tt;
    f.playing = started && !paused;
    f.elapsed = (tt > 0 ? tt : 0) + carriedElapsed();
    let g0 = 0;
    let g1 = 0;
    for (let d = 0; d < 2; d++) {
      const rec = playlist ? onDeck(d) : null;
      if (!rec) {
        f.decks[d] = null;
        continue;
      }
      const df = dfs[d];
      const yt = rec.provider === 'youtube';
      const dk = yt ? deck(d) : null;
      const running = rec.phase === 'live' || rec.phase === 'starting' || rec.phase === 'ended';
      if (yt) df.pos = running && dk ? dk.position() : 0;
      else df.pos = running && fin(rec.startedAt) ? Math.max(0, Math.min(rec.durationS || 30, tt - rec.startedAt)) : 0;
      df.startsIn = rec.phase === 'cued' && rec.tr ? Math.max(0, rec.tr.incStart - tt) : 0;
      df.duration = (dk && dk.duration) || rec.durationS || 0;
      const at = rec === cur && started ? leaveEstimate(rec) : 0;
      df.leaveAt = fin(at) ? at : 0;
      df.gain = running && !paused ? gains[d] : 0;
      df.audible = df.gain;
      df.eqActive = !yt;
      f.decks[d] = df;
      if (d === 0) g0 = df.gain;
      else g1 = df.gain;
    }
    if (g0 + g1 > 0.001) f.crossfade = (g1 - g0) / (g0 + g1);
    else if (!fin(f.crossfade)) f.crossfade = 0;
    f.beatPhase = -1;
    f.levels = engine && engineStarted && engine.levels ? engine.levels() : silent;
    return f;
  }

  /** Plain record of the set so far (tests, the e2e). */
  function history() {
    return plays.map((rec) => ({
      playId: rec.id,
      trackId: rec.entry.id,
      title: rec.entry.meta.title,
      provider: rec.provider,
      videoId: rec.videoId,
      deck: rec.deck,
      phase: rec.phase,
      type: rec.tr ? rec.tr.type : 'start',
      label: rec.tr ? rec.tr.label : 'Start',
      quick: !!(rec.tr && rec.tr.quick),
      tStart: rec.tr ? rec.tr.tStart : 0,
      tEnd: rec.tr ? rec.tr.tEnd : 0,
      incStart: rec.tr ? rec.tr.incStart : 0,
      leaveAt: rec.trOut ? rec.trOut.leaveAt : NaN,
      startedAt: rec.startedAt,
      heardAt: rec.heardAt,
      /** why its preview plays instead of its video ('refused' | 'stuck' | 'slow' | 'background'), else '' */
      previewWhy: rec.provider === 'preview' ? rec.previewWhy : '',
      durationS: rec.durationS,
    }));
  }

  function debug() {
    const failures = {};
    for (const e of entries.values()) {
      if (e.dead && e.vError) failures[e.vError.code] = (failures[e.vError.code] || 0) + 1;
    }
    const lanes = cur && cur.trOut ? { outVol: cur.trOut.outVol, incVol: cur.trOut.incVol, incStart: cur.trOut.incStart, tStart: cur.trOut.tStart, tEnd: cur.trOut.tEnd } : null;
    return {
      jobs: { ...jobs },
      lookups: { ...lookups },
      cues: { ...cues },
      queue: queue.length,
      plays: plays.length,
      cycle,
      order: order.slice(),
      gains: gains.slice(),
      volume,
      failures,
      cur: cur ? { id: cur.id, phase: cur.phase, deck: cur.deck, provider: cur.provider, videoId: cur.videoId } : null,
      nxt: nxt
        ? { id: nxt.id, phase: nxt.phase, deck: nxt.deck, provider: nxt.provider, videoId: nxt.videoId, held: nxt.held, previewWhy: nxt.previewWhy, adSeen: nxt.adSeen, adStillS: nxt.adGrewAt > -Infinity ? Math.round(clock() - nxt.adGrewAt) / 1000 : null, cueHiddenS: Math.round(nxt.cueHiddenMs) / 1000 }
        : null,
      lanes,
      skipQueued,
      needsTap,
      unavailable,
      engine: engine && engine.debug ? engine.debug() : null,
    };
  }

  function destroy() {
    stop();
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
    audioState: () => audioState(),
    canSkip,
    snapshot,
    history,
    debug,
    destroy,
    frame,
    now,
    tick,
    poke: pump,
    get seed() {
      return seed;
    },
    get started() {
      return started;
    },
    get paused() {
      return paused;
    },
    get pausedByUser() {
      return userPaused;
    },
    get vibe() {
      return vibe;
    },
    get mode() {
      return mode;
    },
    get needsTap() {
      return needsTap;
    },
    /** The two YouTube decks' plays, for the e2e: [{deck, phase, provider, videoId}|null]. */
    get onAir() {
      return [0, 1].map((d) => {
        const r = onDeck(d);
        return r ? { playId: r.id, deck: d, phase: r.phase, provider: r.provider, videoId: r.videoId, title: r.entry.meta.title } : null;
      });
    },
  };
}

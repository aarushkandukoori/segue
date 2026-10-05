// Web Audio engine: a faithful executor of Play / Transition plans (see SPEC.md §3 and §4 "engine").
//
// The planner speaks SET TIME and declarative automation (Ev / RatePoint lists whose meaning is defined
// by timeline.js). The engine's job is to make an (Offline)AudioContext render exactly what
// timeline.js predicts, and to stay able to change its mind (cancelFrom) without clicks or leaks.
//
// Three ideas carry the whole file:
//
//  1. LANES. Every automated AudioParam (strip params, playbackRate, the FX-bus params, the internal
//     declick envelope) is a "lane": the AudioParam plus the list of events scheduled on it, in set
//     time. The list is the engine's model of the param and is always kept equal to what the browser
//     will render from "now" on. Late events are folded into the value evalParam() gives for now;
//     cancelFrom() truncates the list and the native timeline the same way.
//
//  2. NOTHING IRREVERSIBLE IS SCHEDULED AHEAD. source.stop(t) cannot be taken back, so a play's end
//     is a gain ramp on the declick envelope (an AudioParam, cancellable) and the real stop() is
//     issued by housekeeping only after the source is already silent.
//
//  3. HOUSEKEEPING IS NOT TIMING. tick() (a timer in realtime, or called by hand around an offline
//     render) only emits playstart/playend and frees nodes that are provably silent. Everything
//     audible is sample-accurate AudioParam / start() scheduling.

import { positionAt, timeAtPosition, evalParam, sortEvents, dbToGain } from './timeline.js';
import {
  createFxBus,
  probeLoopLatency,
  makeImpulseResponse,
  makeNoiseBuffer,
  scheduleRiser,
  scheduleImpact,
  scheduleLoop,
  scheduleReverse,
  quietAt,
  unlockAudio,
  lockAudio,
} from './fx.js';

export { unlockAudio, lockAudio };

/** Master gain at volume 1: room for two overlapping tracks before the limiter has to work. */
export const HEADROOM = 0.85;

/**
 * Limiter = DynamicsCompressorNode with a hard knee and the steepest ratio it offers. `lookahead` is the
 * node's fixed pre-delay (6 ms in every engine derived from the original WebKit code): it delays the
 * whole mix by a constant and is why the UI clock (uiTime) subtracts it.
 */
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.15, lookahead: 0.006 };

/** Declick fade at source start / stop. */
export const FADE = 0.004;
/** How fast a play that must disappear right now (cancelled inside its pre-roll, or replaced) is faded. */
const RETIRE_FADE = 0.003;
/** A finished strip is freed this long after it went silent (its EQ filters have rung out by then). */
const STRIP_TAIL = 0.3;

export const STRIP_DEFAULTS = Object.freeze({
  gain: 1,
  src: 1,
  low: 0,
  mid: 0,
  high: 0,
  hpf: 20,
  lpf: 20000,
  delaySend: 0,
  reverbSend: 0,
});
export const BUS_DEFAULTS = Object.freeze({ delayTime: 0.375, delayFeedback: 0.5, fxReturn: 1 });

// Safety rails, not musical choices: a planner bug must not be able to blow up the mix (feedback > 1,
// negative gain, filter above Nyquist). Values are clamped when scheduled AND in the stored model.
const RANGES = {
  gain: [0, 4],
  src: [0, 4],
  low: [-60, 12],
  mid: [-60, 12],
  high: [-60, 12],
  hpf: [10, 20000],
  lpf: [10, 20000],
  delaySend: [0, 2],
  reverbSend: [0, 2],
  delayTime: [0.01, 2.4],
  delayFeedback: [0, 0.9],
  fxReturn: [0, 2],
  rate: [0, 8],
};
const STRIP_PARAMS = Object.keys(STRIP_DEFAULTS);
const BUS_PARAMS = Object.keys(BUS_DEFAULTS);
const KINDS = { set: 1, lin: 1, exp: 1, tgt: 1 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isOfflineCtx = (ctx) => typeof ctx.startRendering === 'function';

// ---------------------------------------------------------------------------------------------------
// Pure lane maths (no Web Audio): shared by the engine and by anyone who needs to mirror it.

/** Copy the usable events of one param, clamped to its safe range. Never throws on junk input. */
function cleanEvents(events, p, range) {
  const out = [];
  for (const e of events || []) {
    if (!e || e.p !== p || !KINDS[e.k] || !Number.isFinite(e.t) || !Number.isFinite(e.v)) continue;
    const v = range ? clamp(e.v, range[0], range[1]) : e.v;
    const c = { p, t: e.t, v, k: e.k };
    if (e.k === 'tgt') c.tc = Math.max(Number(e.tc) || 0.001, 1e-4);
    out.push(c);
  }
  return out;
}

/**
 * Merge new events into a lane's list. Two rewrites keep every browser equal to evalParam():
 * a ramp with nothing before it becomes a step (browsers disagree on where an unanchored ramp starts),
 * and an exponential ramp from/to a non-positive value becomes linear (it would throw or stick).
 */
function mergeLane(existing, incoming, p, def) {
  const merged = sortEvents(existing.concat(incoming));
  const fresh = new Set(incoming);
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];
    if (!fresh.has(e) || (e.k !== 'lin' && e.k !== 'exp')) continue;
    if (i === 0) e.k = 'set';
    else if (e.k === 'exp' && !(e.v > 0 && evalParam(merged.slice(0, i), p, e.t, def) > 0)) e.k = 'lin';
  }
  return merged;
}

/** The setTarget that is still pulling the param at time t, if any. */
function activeTarget(events, t) {
  let last = null;
  for (const e of events) {
    if (e.t > t) break;
    last = e;
  }
  return last && last.k === 'tgt' ? last : null;
}

/**
 * Cut one param's events at T: everything at/after T goes, the value just before T is held.
 * If the cut lands inside a ramp the ramp is shortened to end at T on the same curve.
 * @returns {{events: Ev[], held: number, k: 'set'|'lin'|'exp'|null, touched: boolean}}
 */
export function truncateLane(events, p, T, def) {
  let n = 0;
  while (n < events.length && events[n].t < T) n++;
  const first = events[n];
  const midTarget = n > 0 && events[n - 1].k === 'tgt';
  if (!first && !midTarget) return { events, held: evalParam(events, p, T, def), k: null, touched: false };
  const kept = events.slice(0, n);
  const ramp = first && n > 0 && (first.k === 'lin' || first.k === 'exp') ? first : null;
  const held = evalParam(ramp ? kept.concat([ramp]) : kept, p, T, def);
  const k = ramp ? ramp.k : 'set';
  kept.push({ p, t: T, v: held, k });
  return { events: kept, held, k, touched: true };
}

const rateEvents = (points) =>
  (points || []).map((r) => ({ p: 'rate', t: r && r.t, v: r && r.v, k: r && r.ramp ? 'lin' : 'set' }));
const ratePoints = (events) => events.map((e) => (e.k === 'lin' ? { t: e.t, v: e.v, ramp: true } : { t: e.t, v: e.v }));

/**
 * Rate points as timeline.js needs them: finite, in range, and starting exactly at startAt (points at or
 * before it are folded into the value they give there). A missing or junk list means rate 1.
 */
function normalRate(points, startAt) {
  const ev = mergeLane([], cleanEvents(rateEvents(points), 'rate', RANGES.rate), 'rate', 1);
  if (!ev.length) return [{ t: startAt, v: 1 }];
  const head = { p: 'rate', t: startAt, v: evalParam(ev, 'rate', startAt, ev[0].v), k: 'set' };
  return ratePoints([head].concat(ev.filter((e) => e.t > startAt)));
}

/**
 * What cancelFrom(T) leaves of a play, as plain data: events and rate cut at T with values held, a
 * pending endAt (> T) cleared. The engine's own copy after a cancel is engine.getPlay(id); this is for
 * code that wants the same answer without an engine (planner tests, the conductor's bookkeeping).
 * @template P
 * @param {P} play
 * @param {number} T set time
 * @returns {P}
 */
export function truncatePlay(play, T) {
  let events = [];
  for (const p of STRIP_PARAMS) {
    const lane = mergeLane([], cleanEvents(play.events, p, RANGES[p]), p, STRIP_DEFAULTS[p]);
    events = events.concat(truncateLane(lane, p, T, STRIP_DEFAULTS[p]).events);
  }
  const rate0 = play.rate && play.rate[0] ? play.rate[0].v : 1;
  const rate = mergeLane([], cleanEvents(rateEvents(play.rate), 'rate', RANGES.rate), 'rate', rate0);
  return {
    ...play,
    events: sortEvents(events),
    rate: ratePoints(truncateLane(rate, 'rate', T, rate0).events),
    endAt: play.endAt != null && play.endAt > T ? null : play.endAt,
  };
}

// ---------------------------------------------------------------------------------------------------

/**
 * @param {{context?: BaseAudioContext, cancelAndHold?: boolean}} [opts]
 *   context        render into this context (AudioContext or OfflineAudioContext). Omitted: an
 *                  AudioContext({latencyHint: 'playback'}) is created on first use and closed by destroy().
 *   cancelAndHold  false = never use AudioParam.cancelAndHoldAtTime (forces the code path Firefox takes;
 *                  exists so that path can be tested in Chrome).
 */
export function createEngine(opts = {}) {
  /** @type {BaseAudioContext|null} */
  let ctx = opts.context || null;
  const owned = !ctx;
  const nativeHold = opts.cancelAndHold !== false;
  let offline = ctx ? isOfflineCtx(ctx) : false;

  /** Master section + buses, built on first use. */
  let g = null;
  let t0 = 0;
  let started = false;
  let destroyed = false;
  let volume = 1;
  /** How far ahead a "start right now" must be scheduled to still be sample-accurate (realtime only). */
  let lead = 0;
  let timer = null;
  /** Frames a DelayNode feedback loop adds per trip in this browser (null until measured). */
  let loopLatency = null;
  /** True once this engine started the iOS silent-audio element (so destroy() can release it). */
  let unlocked = false;
  /** A reset() still fading the old set out; start() waits for it. */
  let resetting = null;
  const token = {};

  /** @type {Map<number, any>} */
  const strips = new Map();
  let oneShots = [];
  /** Node groups that are fading out and only wait to be disconnected. */
  let dying = [];
  /** Calls made before start(), replayed once the set clock exists. */
  let pending = [];
  /** loop / reverse FX whose play has not been added yet (the caller sent the FX first). */
  let waitingFx = [];
  let busLanes = null;
  const listeners = { playstart: new Set(), playend: new Set() };

  let nodeCount = 0;
  let baseline = 0;
  const mk = (node) => {
    nodeCount++;
    return node;
  };
  const drop = (nodes) => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    nodeCount -= nodes.length;
  };
  const halt = (sources) => {
    for (const s of sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started or already stopped */
      }
    }
  };

  const FFT = 1024;
  const floatWave = new Float32Array(FFT);
  const lv = { rms: 0, peak: 0, bands: new Uint8Array(FFT / 2), wave: new Uint8Array(FFT).fill(128) };

  function getCtx() {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not available in this browser');
      try {
        ctx = new AC({ latencyHint: 'playback' });
      } catch {
        ctx = new AC();
      }
      offline = false;
    }
    return ctx;
  }

  function graph() {
    if (g) return g;
    const c = getCtx();
    const bus = mk(c.createGain());
    const master = mk(c.createGain());
    const limiter = mk(c.createDynamicsCompressor());
    const post = mk(c.createGain());
    const analyser = mk(c.createAnalyser());
    const keepAlive = mk(c.createBufferSource());
    master.gain.value = HEADROOM * volume;
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.release.value = LIMITER.release;
    // A fresh compressor believes it is in the middle of heavy gain reduction and needs ~150 ms of
    // processing to open up; anything played in that window is ducked. Three things keep that away
    // from the music: (1) it gets a slow attack for its first 100 ms, so it cannot dive while it
    // settles; (2) a −140 dB DC source keeps it processing even where browsers skip nodes with silent
    // input; (3) its input is pinned to stereo, because Firefox rebuilds (= resets) the compressor
    // whenever the channel count changes.
    limiter.attack.setValueAtTime(1, c.currentTime);
    limiter.attack.setValueAtTime(LIMITER.attack, c.currentTime + 0.1);
    try {
      limiter.channelCount = 2;
      limiter.channelCountMode = 'explicit';
    } catch {
      /* stays clamped-max */
    }
    const dc = c.createBuffer(2, 2048, c.sampleRate);
    dc.getChannelData(0).fill(1e-7);
    dc.getChannelData(1).fill(1e-7);
    keepAlive.buffer = dc;
    keepAlive.loop = true;
    keepAlive.connect(limiter);
    keepAlive.start();
    // The compressor adds "makeup gain" on its own: (1 / gain it would apply to a 0 dBFS input)^0.6.
    // Undo it, otherwise everything below the threshold comes out ~1.7 dB hot and fader maths is off.
    post.gain.value = dbToGain(0.6 * LIMITER.threshold * (1 - 1 / LIMITER.ratio));
    analyser.fftSize = FFT;
    analyser.smoothingTimeConstant = 0.8;
    bus.connect(master);
    master.connect(limiter);
    limiter.connect(post);
    post.connect(analyser);
    analyser.connect(c.destination);
    const impulse = makeImpulseResponse(c);
    const noise = makeNoiseBuffer(c);
    g = { bus, master, limiter, post, analyser, keepAlive, fx: null, impulse, noise, tap: null };
    buildFx();
    baseline = nodeCount;
    return g;
  }

  /** (Re)create the delay / reverb buses; old tails vanish with the old nodes. */
  function buildFx() {
    if (g.fx) {
      halt(g.fx.sources);
      drop(g.fx.nodes);
    }
    g.fx = createFxBus(ctx, g.bus, mk, { impulse: g.impulse });
    busLanes = {};
    for (const p of BUS_PARAMS) busLanes[p] = makeLane(p, g.fx.params[p], BUS_DEFAULTS[p], RANGES[p]);
    const fx = g.fx;
    if (loopLatency != null) fx.setLoopLatency(loopLatency / ctx.sampleRate);
    else {
      probeLoopLatency().then((frames) => {
        loopLatency = frames;
        if (!destroyed) fx.setLoopLatency(frames / ctx.sampleRate);
      });
    }
  }

  const toCtx = (setTime) => t0 + setTime;
  const now = () => (started && ctx ? ctx.currentTime - t0 : 0);
  /** Context time for a set time, never negative (AudioParam methods throw on negative times). */
  const at = (setTime) => Math.max(0, t0 + setTime);

  // ----- lanes ---------------------------------------------------------------------------------

  function makeLane(p, param, def, range) {
    // Explicit anchor: before its first event a param must read `def` in every browser, whatever the
    // node's own default is, and the first ramp needs something to start from.
    param.setValueAtTime(def, at(now()));
    return { p, param, def, range, events: [] };
  }

  function applyNative(param, e) {
    const t = at(e.t);
    if (e.k === 'set') param.setValueAtTime(e.v, t);
    else if (e.k === 'lin') param.linearRampToValueAtTime(e.v, t);
    else if (e.k === 'exp') param.exponentialRampToValueAtTime(e.v, t);
    else param.setTargetAtTime(e.v, t, e.tc);
  }

  /**
   * Add events to a lane. Events that are already in the past are not scheduled (browsers clamp or
   * reorder them differently); instead the param is set to the value the full event list implies for
   * `F` (= now), which leaves the curve from now on exactly where it would have been.
   */
  function laneAdd(lane, events, F) {
    const incoming = cleanEvents(events, lane.p, lane.range);
    if (!incoming.length) return;
    const merged = mergeLane(lane.events, incoming, lane.p, lane.def);
    let late = false;
    for (const e of incoming) {
      if (e.t <= F) late = true;
    }
    if (late) {
      const tF = at(F);
      lane.param.setValueAtTime(evalParam(merged, lane.p, F, lane.def), tF);
      const pull = activeTarget(merged, F);
      if (pull) lane.param.setTargetAtTime(pull.v, tF, pull.tc); // an exponential approach has no memory: restarting it from the current value continues the same curve
    }
    for (const e of incoming) {
      if (e.t > F) applyNative(lane.param, e);
    }
    lane.events = merged;
  }

  /** Cut a lane at T (≥ now), holding its value. Returns the held value. */
  function laneTruncate(lane, T) {
    const cut = truncateLane(lane.events, lane.p, T, lane.def);
    if (!cut.touched) return cut.held;
    const tc = at(T);
    const param = lane.param;
    if (nativeHold && typeof param.cancelAndHoldAtTime === 'function') {
      // Atomic on the audio thread: no render quantum can ever see a half-cancelled timeline.
      param.cancelAndHoldAtTime(tc);
      // Then pin the held value with a real event at the cut. Two reasons: the native call keeps an
      // event sitting exactly on the cut where ours must go ("at/after"; of equal-time events the last
      // one wins), and when it had nothing to shorten it inserts nothing, so a ramp scheduled next
      // would start from some event long ago instead of from here.
      param.setValueAtTime(cut.held, tc);
    } else {
      // Firefox has no cancelAndHoldAtTime, and cancelScheduledValues() alone would drop the end point
      // of a ramp in flight, snapping the value back to where the ramp began. So: first add the hold
      // point ON the existing curve (a ramp that ends at the cut with the value it has there — nothing
      // audible changes yet), then cancel everything after it, then pin the value (covers an old event
      // sitting exactly on the cut). Every intermediate timeline is a valid one, so it does not matter
      // whether the browser applies these three calls together or one by one.
      if (cut.k === 'lin') param.linearRampToValueAtTime(cut.held, tc);
      else if (cut.k === 'exp' && cut.held > 0) param.exponentialRampToValueAtTime(cut.held, tc);
      else param.setValueAtTime(cut.held, tc);
      param.cancelScheduledValues(tc + 1e-6);
      param.setValueAtTime(cut.held, tc);
    }
    lane.events = cut.events;
    return cut.held;
  }

  /** Collapse history older than `cut` into one anchor, so a lane that lives for hours stays short. */
  function laneCompact(lane, cut) {
    const ev = lane.events;
    if (ev.length < 16 || !(ev[0].t < cut)) return;
    let n = 0;
    while (n < ev.length && ev[n].t <= cut) n++;
    if (n < 8) return;
    const head = [{ p: lane.p, t: cut, v: evalParam(ev, lane.p, cut, lane.def), k: 'set' }];
    const pull = activeTarget(ev, cut);
    if (pull) head.push({ p: lane.p, t: cut, v: pull.v, k: 'tgt', tc: pull.tc });
    lane.events = head.concat(ev.slice(n));
  }

  // ----- events / housekeeping -----------------------------------------------------------------

  function emit(type, playId) {
    for (const fn of [...listeners[type]]) {
      try {
        fn({ playId });
      } catch (err) {
        console.error('[engine] listener failed', err);
      }
    }
  }

  function disposeOneShot(os) {
    halt(os.sources);
    drop(os.nodes);
  }

  function teardown(strip) {
    if (strip.gone) return;
    strip.gone = true;
    halt([strip.source]);
    drop(strip.nodes);
    if (strips.get(strip.id) === strip) strips.delete(strip.id);
    oneShots = oneShots.filter((os) => {
      if (os.strip !== strip) return true;
      disposeOneShot(os);
      return false;
    });
  }

  /**
   * Bookkeeping pass: emits playstart / playend, issues the real stop() for sources that have already
   * been faded to silence, frees finished strips and one-shots. Runs on a timer in realtime; around an
   * OfflineAudioContext render call it yourself (from a suspend() hook or after rendering).
   */
  function tick() {
    if (destroyed || !started) return;
    const n = now();
    for (const strip of [...strips.values()]) {
      if (!strip.started && n >= strip.tBegin) {
        strip.started = true;
        emit('playstart', strip.id);
      }
      if (!strip.ended && (strip.bufferEnded || n >= strip.effEnd)) {
        strip.ended = true;
        strip.endTime = Math.min(n, strip.effEnd);
        halt([strip.source]);
        if (!strip.started) {
          strip.started = true;
          emit('playstart', strip.id);
        }
        emit('playend', strip.id);
      }
      if (strip.ended && n >= Math.max(strip.endTime, strip.fxUntil) + STRIP_TAIL) teardown(strip);
    }
    if (oneShots.length) {
      oneShots = oneShots.filter((os) => {
        if (n < os.until + 0.1) return true;
        disposeOneShot(os);
        return false;
      });
    }
    if (dying.length) {
      dying = dying.filter((d) => {
        if (n < d.until) return true;
        halt(d.sources);
        drop(d.nodes);
        return false;
      });
    }
    if (waitingFx.length) waitingFx = waitingFx.filter((f) => f.t + (Number(f.dur) || 0) > n);
    if (busLanes) for (const p of BUS_PARAMS) laneCompact(busLanes[p], n - 1);
  }

  // ----- plays ---------------------------------------------------------------------------------

  /** The strip's timing as timeline.js wants it. Rebuilt only when the rate lane changed (lanes replace their list on every edit), so the UI can ask every frame. */
  const playModel = (strip) => {
    const ev = strip.lanes.rate.events;
    if (strip.modelOf !== ev) {
      strip.modelOf = ev;
      strip.model = { startAt: strip.play.startAt, offset: strip.play.offset, rate: ratePoints(ev), endAt: null };
    }
    return strip.model;
  };

  /**
   * (Re)schedule the audible end of a strip's main source: a FADE-long ramp of the declick envelope
   * down to zero ending at min(endAt, the moment the buffer runs out). Being an AudioParam ramp it can
   * be cancelled or moved at any time before it happens.
   */
  function scheduleEnd(strip) {
    if (strip.ended) return;
    const env = strip.lanes.env;
    const n = now();
    const from = Math.max(n, strip.fadeInEnd);
    let level = 1;
    if (strip.fadeOut) {
      if (strip.effEnd <= n) return; // already silent: a finished play is not revived
      level = laneTruncate(env, from);
    }
    const endAt = strip.play.endAt != null ? strip.play.endAt : Infinity;
    const eff = Math.min(endAt, timeAtPosition(playModel(strip), strip.buffer.duration));
    const ev = [];
    if (!Number.isFinite(eff)) {
      if (level < 1) ev.push({ p: 'env', t: from + FADE, v: 1, k: 'lin' });
      strip.effEnd = Infinity;
      strip.fadeOut = level < 1;
    } else if (eff - FADE >= from) {
      if (level < 1) ev.push({ p: 'env', t: Math.min(from + FADE, eff - FADE), v: 1, k: 'lin' });
      ev.push({ p: 'env', t: eff - FADE, v: 1, k: 'set' }, { p: 'env', t: eff, v: 0, k: 'lin' });
      strip.effEnd = eff;
      strip.fadeOut = true;
    } else {
      // Ends sooner than one fade from now (or the end is already past): fade out right away.
      const e = Math.max(eff, from + FADE);
      if (!env.events.length) ev.push({ p: 'env', t: from, v: 1, k: 'set' });
      ev.push({ p: 'env', t: e, v: 0, k: 'lin' });
      strip.effEnd = e;
      strip.fadeOut = true;
    }
    laneAdd(env, ev, n);
  }

  /**
   * @param {Play} play
   * @param {AudioBuffer} buffer
   */
  function addPlay(play, buffer) {
    if (destroyed || !play || !buffer) return;
    if (!started) {
      pending.push({ kind: 'play', play, buffer });
      return;
    }
    const startAt = Number(play.startAt);
    if (!Number.isFinite(startAt) || !Number.isFinite(play.offset) || !(buffer.duration > 0)) return;
    const rate = normalRate(play.rate, startAt);
    const rate0 = rate[0].v;
    const c = getCtx();
    graph();

    const old = strips.get(play.id);
    if (old) retire(old); // same id again: the newest instruction wins

    const nowS = now();
    const timing = { startAt, offset: play.offset, rate, endAt: null };

    // Where does the source actually start? On time if we can, otherwise as soon as possible at the
    // buffer position the plan says is playing by then — late, but on the grid.
    let tBegin = startAt;
    let offset = play.offset;
    const late = startAt < nowS + lead;
    if (late) {
      tBegin = nowS + lead;
      offset = positionAt(timing, tBegin);
    }
    if (offset < 0) {
      // The plan starts before the audio does: wait for buffer position 0 instead of playing junk.
      tBegin = Math.max(tBegin, timeAtPosition(timing, 0));
      offset = 0;
    }
    const over = !Number.isFinite(tBegin) || offset >= buffer.duration - 0.001 || (play.endAt != null && play.endAt <= tBegin);
    if (over) {
      // Nothing left to hear. Listeners still get a complete start/end pair, after this call returns.
      Promise.resolve().then(() => {
        if (destroyed) return;
        emit('playstart', play.id);
        emit('playend', play.id);
      });
      return;
    }

    const source = mk(c.createBufferSource());
    const env = mk(c.createGain());
    const src = mk(c.createGain());
    const trim = mk(c.createGain());
    const low = mk(c.createBiquadFilter());
    const mid = mk(c.createBiquadFilter());
    const high = mk(c.createBiquadFilter());
    const hpf = mk(c.createBiquadFilter());
    const lpf = mk(c.createBiquadFilter());
    const fader = mk(c.createGain());
    const delaySend = mk(c.createGain());
    const reverbSend = mk(c.createGain());
    source.buffer = buffer;
    trim.gain.value = dbToGain(clamp(Number(play.trimDb) || 0, -24, 12));
    low.type = 'lowshelf';
    low.frequency.value = 220;
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    high.type = 'highshelf';
    high.frequency.value = 3200;
    hpf.type = 'highpass';
    hpf.Q.value = 0; // high/lowpass Q is in dB: 0 dB = a classic Q of 1
    lpf.type = 'lowpass';
    lpf.Q.value = 0;
    source.connect(env);
    env.connect(src);
    src.connect(trim);
    trim.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(hpf);
    hpf.connect(lpf);
    lpf.connect(fader);
    fader.connect(g.bus);
    fader.connect(delaySend);
    delaySend.connect(g.fx.delayIn);
    fader.connect(reverbSend);
    reverbSend.connect(g.fx.reverbIn);

    const fMax = Math.min(20000, c.sampleRate * 0.49);
    const params = {
      gain: fader.gain,
      src: src.gain,
      low: low.gain,
      mid: mid.gain,
      high: high.gain,
      hpf: hpf.frequency,
      lpf: lpf.frequency,
      delaySend: delaySend.gain,
      reverbSend: reverbSend.gain,
    };
    const lanes = {};
    for (const p of STRIP_PARAMS) {
      const range = p === 'hpf' || p === 'lpf' ? [RANGES[p][0], fMax] : RANGES[p];
      lanes[p] = makeLane(p, params[p], Math.min(STRIP_DEFAULTS[p], range[1]), range);
      laneAdd(lanes[p], play.events, nowS);
    }
    lanes.rate = makeLane('rate', source.playbackRate, rate0, RANGES.rate);
    laneAdd(lanes.rate, rateEvents(rate), nowS);
    lanes.env = makeLane('env', env.gain, 1, [0, 1]);

    // Declick. Preferred: start the source one fade early and ramp up INTO startAt, so whatever sits on
    // the cue point (usually a kick) keeps its full attack. When there is no room for that (late start,
    // cue at the very top of the buffer) fade in after the start, unless the audio there is silent anyway.
    let srcStart = tBegin;
    let srcOffset = offset;
    let fadeInEnd = tBegin;
    if (!late) {
      const room = Math.min(FADE, offset / Math.max(rate0, 1e-3), tBegin - nowS - lead);
      if (room >= 0.001) {
        srcStart = tBegin - room;
        srcOffset = offset - room * rate0;
        laneAdd(lanes.env, [{ p: 'env', t: srcStart, v: 0, k: 'set' }, { p: 'env', t: tBegin, v: 1, k: 'lin' }], nowS);
        // The pre-roll has to sound like the play does AT startAt, not like a strip at its defaults:
        // a plan whose first events sit exactly on startAt (fader at 0, bass killed) would otherwise
        // leak these few ms at full level. So a param that is first set inside the pre-roll window
        // takes that value from the moment the source starts.
        for (const p of STRIP_PARAMS) {
          const lane = lanes[p];
          const first = lane.events[0];
          if (!first || first.k !== 'set' || !(first.t > srcStart && first.t <= tBegin)) continue;
          laneAdd(lane, [{ p, t: srcStart, v: evalParam(lane.events, p, first.t, lane.def), k: 'set' }], nowS);
        }
      }
    }
    if (srcStart === tBegin && !quietAt(buffer, offset)) {
      fadeInEnd = tBegin + FADE;
      laneAdd(lanes.env, [{ p: 'env', t: tBegin, v: 0, k: 'set' }, { p: 'env', t: fadeInEnd, v: 1, k: 'lin' }], nowS);
    }

    // Everything on the play that is not timing or automation rides along untouched (trackId, deck,
    // soloFrom, a planner's own bookkeeping fields), so getPlay() can stand in for the caller's copy.
    const { rate: _rate, events: _events, ...passthrough } = play;
    const strip = {
      id: play.id,
      play: {
        ...passthrough,
        startAt,
        offset: play.offset,
        trimDb: Number(play.trimDb) || 0,
        endAt: play.endAt != null && Number.isFinite(play.endAt) ? play.endAt : null,
      },
      buffer,
      source,
      input: trim,
      nodes: [source, env, src, trim, low, mid, high, hpf, lpf, fader, delaySend, reverbSend],
      lanes,
      tBegin,
      srcStart,
      fadeInEnd,
      fadeOut: false,
      effEnd: Infinity,
      endTime: Infinity,
      fxUntil: -Infinity,
      started: false,
      ended: false,
      bufferEnded: false,
      gone: false,
    };
    source.onended = () => {
      if (strip.gone || destroyed) return;
      strip.bufferEnded = true;
      tick();
    };
    source.start(at(srcStart), Math.max(0, srcOffset));
    strips.set(strip.id, strip);
    scheduleEnd(strip);
    if (waitingFx.length) {
      const mine = waitingFx.filter((f) => f.playId === strip.id);
      if (mine.length) {
        waitingFx = waitingFx.filter((f) => f.playId !== strip.id);
        addFx(mine, []);
      }
    }
  }

  /** Take a strip out of the mix now (replaced or cancelled before it was heard), without a click. */
  function retire(strip) {
    if (strip.gone) return;
    const n = now();
    if (strip.srcStart > n || strip.ended) {
      teardown(strip);
      return;
    }
    // Its source is already running (it is inside the pre-roll fade): fade it out, free it afterwards.
    const held = laneTruncate(strip.lanes.gain, n);
    strip.lanes.gain.param.setValueAtTime(held, at(n));
    strip.lanes.gain.param.linearRampToValueAtTime(0, at(n + RETIRE_FADE));
    strip.gone = true;
    strips.delete(strip.id);
    const mine = oneShots.filter((os) => os.strip === strip);
    oneShots = oneShots.filter((os) => os.strip !== strip);
    dying.push({
      until: n + 0.05,
      nodes: strip.nodes.concat(...mine.map((os) => os.nodes)),
      sources: [strip.source].concat(...mine.map((os) => os.sources)),
    });
  }

  /**
   * Append to a live play: more strip events, more rate points, and/or its endAt (null clears it).
   * @param {number} playId
   * @param {{events?: Ev[], rate?: RatePoint[], endAt?: number|null}} more
   * @returns {boolean} false if the play is unknown or already over
   */
  function extendPlay(playId, more) {
    if (destroyed || !more) return false;
    if (!started) {
      pending.push({ kind: 'extend', playId, more });
      return true;
    }
    const strip = strips.get(playId);
    if (!strip || strip.ended) return false;
    const n = now();
    if (more.events && more.events.length) {
      for (const p of STRIP_PARAMS) laneAdd(strip.lanes[p], more.events, n);
    }
    if (more.rate && more.rate.length) laneAdd(strip.lanes.rate, rateEvents(more.rate), n);
    if (more.endAt !== undefined) strip.play.endAt = more.endAt != null && Number.isFinite(more.endAt) ? more.endAt : null;
    if ((more.rate && more.rate.length) || more.endAt !== undefined) scheduleEnd(strip);
    return true;
  }

  // ----- one-shot FX ---------------------------------------------------------------------------

  function fxEnv(out) {
    return {
      ctx,
      out,
      now,
      toCtx,
      lead,
      mk,
      noise: g.noise,
      automate(param, def, points) {
        const lane = makeLane('x', param, def, null);
        laneAdd(
          lane,
          points.map((q) => ({ p: 'x', t: q[0], v: q[1], k: q[2], tc: q[3] })),
          now(),
        );
      },
    };
  }

  /**
   * @param {Fx[]} fx
   * @param {Ev[]} [fxEvents] FX-bus automation ('delayTime' | 'delayFeedback' | 'fxReturn')
   */
  function addFx(fx, fxEvents) {
    if (destroyed) return;
    if (!started) {
      pending.push({ kind: 'fx', fx, fxEvents });
      return;
    }
    graph();
    const n = now();
    if (fxEvents && fxEvents.length) {
      for (const p of BUS_PARAMS) laneAdd(busLanes[p], fxEvents, n);
    }
    for (const f of fx || []) {
      if (!f) continue;
      let made = null;
      let strip = null;
      try {
        if (f.kind === 'riser') made = scheduleRiser(fxEnv(g.bus), f);
        else if (f.kind === 'impact') made = scheduleImpact(fxEnv(g.bus), f);
        else if (f.kind === 'loop' || f.kind === 'reverse') {
          strip = strips.get(f.playId);
          if (!strip) {
            // Its play may simply not have been added yet (call order is the caller's business): keep
            // it until the play shows up or the effect's time has passed.
            if (Number.isFinite(f.t) && f.t + (Number(f.dur) || 0) > n) waitingFx.push(f);
            continue;
          }
          made = (f.kind === 'loop' ? scheduleLoop : scheduleReverse)(fxEnv(strip.input), f, strip.buffer);
        }
      } catch (err) {
        console.error('[engine] fx failed', f.kind, err);
        made = null;
      }
      if (!made) continue;
      if (strip) strip.fxUntil = Math.max(strip.fxUntil, made.until);
      oneShots.push({ kind: f.kind, t: made.t, until: made.until, nodes: made.nodes, sources: made.sources, strip });
    }
  }

  // ----- cancel --------------------------------------------------------------------------------

  /**
   * Un-schedule the future from `setTime` on (clamped to now): every param holds the value it has at
   * that moment, plays that have not started are removed, one-shots that have not started are dropped,
   * a pending endAt is forgotten. Running one-shots finish on their own.
   * @returns {number[]} ids of the removed plays
   */
  function cancelFrom(setTime) {
    const removed = [];
    if (destroyed) return removed;
    if (!started) {
      pending = pending.filter((op) => {
        if (op.kind !== 'play' || !(op.play.startAt >= setTime)) return true;
        removed.push(op.play.id);
        return false;
      });
      return removed;
    }
    const T = Math.max(Number(setTime) || 0, now());
    for (const strip of [...strips.values()]) {
      if (strip.play.startAt >= T) {
        removed.push(strip.id);
        retire(strip);
        continue;
      }
      if (strip.ended) continue;
      for (const p of STRIP_PARAMS) laneTruncate(strip.lanes[p], T);
      laneTruncate(strip.lanes.rate, T);
      if (strip.play.endAt != null && strip.play.endAt > T) strip.play.endAt = null;
      scheduleEnd(strip);
    }
    oneShots = oneShots.filter((os) => {
      if (os.t < T) return true;
      disposeOneShot(os);
      return false;
    });
    waitingFx = waitingFx.filter((f) => f.t < T);
    if (busLanes) for (const p of BUS_PARAMS) laneTruncate(busLanes[p], T);
    return removed;
  }

  // ----- transport / master --------------------------------------------------------------------

  /** Everything that only works inside a user gesture. Returns the pending ctx.resume(), if any. */
  function wake() {
    const c = getCtx();
    graph();
    if (offline) return null;
    const resuming = c.state !== 'running' && typeof c.resume === 'function' ? c.resume() : null;
    if (unlockAudio({ owner: token })) unlocked = true; // iOS only: same gesture, or the mute switch silences the set
    return resuming;
  }

  /**
   * The gesture-bound part of start() on its own: creates / resumes the AudioContext and, on iOS, starts
   * the silent <audio>. Call it synchronously in the click handler when the set can only start later
   * (tracks still loading); start() may then run outside a gesture. Does not start the set clock.
   */
  function unlock() {
    if (destroyed) return;
    const resuming = wake();
    if (resuming) resuming.catch(() => {});
  }

  /**
   * Start the set clock: set time 0 ≡ context time `at` (default: 150 ms from now). Call from a user
   * gesture (or after unlock() was): it resumes the context and, on iOS, starts the silent <audio> that
   * defeats the mute switch. With an OfflineAudioContext pass {at: …}. Calling it again only resumes.
   */
  async function start(o = {}) {
    if (destroyed) return;
    const c = getCtx();
    const resuming = wake(); // synchronously, before any await: this is the part that needs the gesture
    if (resuming) resuming.catch(() => {}); // awaited further down; a closed context must not surface as an unhandled rejection meanwhile
    if (loopLatency == null) await probeLoopLatency(); // a few ms, once per page; buildFx applies the result
    if (resetting) await resetting; // the old set is still fading out: its cleanup must not eat the new one
    if (destroyed) return;
    if (!started) {
      t0 = Number.isFinite(o.at) ? o.at : c.currentTime + 0.15;
      started = true;
      // A realtime context renders a whole device buffer ahead of what currentTime shows; anything
      // that must start "now" is scheduled past that so it still starts on an exact sample.
      lead = offline ? 0 : clamp((c.baseLatency || 0.03) + 0.02, 0.03, 0.25);
      const ops = pending;
      pending = [];
      for (const op of ops) {
        if (op.kind === 'play') addPlay(op.play, op.buffer);
        else if (op.kind === 'extend') extendPlay(op.playId, op.more);
        else addFx(op.fx, op.fxEvents);
      }
      if (!offline && !timer) timer = setInterval(tick, 50);
    }
    if (resuming) await settled(resuming);
  }

  /** Without a user gesture browsers may leave resume() pending for good; never hang the caller on it. */
  const settled = (promise) => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);

  async function pause() {
    if (destroyed || offline || !ctx || ctx.state !== 'running') return;
    await ctx.suspend();
  }

  async function resume() {
    if (destroyed || offline || !ctx || ctx.state === 'closed') return;
    if (unlocked) unlockAudio({ owner: token }); // iOS pauses the silent element when the page is backgrounded
    if (ctx.state === 'running') return;
    await settled(ctx.resume());
    tick();
  }

  function setVolume(v) {
    volume = clamp(Number(v) || 0, 0, 1.5);
    if (!g) return;
    const target = HEADROOM * volume;
    // Before the clock runs there is nothing to smooth (and an offline render must start at level).
    if (!started) g.master.gain.setValueAtTime(target, ctx.currentTime);
    else g.master.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
  }

  /** Output meter. Returns the same object and arrays every call. */
  function levels() {
    if (!g) return lv;
    const a = g.analyser;
    a.getByteFrequencyData(lv.bands);
    a.getByteTimeDomainData(lv.wave);
    let sum = 0;
    let peak = 0;
    if (typeof a.getFloatTimeDomainData === 'function') {
      a.getFloatTimeDomainData(floatWave);
      for (let i = 0; i < FFT; i++) {
        const x = floatWave[i];
        sum += x * x;
        if (x > peak) peak = x;
        else if (-x > peak) peak = -x;
      }
    } else {
      for (let i = 0; i < FFT; i++) {
        const x = (lv.wave[i] - 128) / 128;
        sum += x * x;
        if (x > peak) peak = x;
        else if (-x > peak) peak = -x;
      }
    }
    lv.rms = Math.sqrt(sum / FFT);
    lv.peak = peak;
    return lv;
  }

  /**
   * Set time of the sound leaving the speakers right now (now() minus output + limiter latency, and
   * interpolated between audio callbacks so it moves smoothly). For drawing; never for scheduling.
   */
  function uiTime() {
    if (!started || !ctx) return 0;
    const cur = ctx.currentTime;
    let t = cur - (ctx.outputLatency || ctx.baseLatency || 0);
    if (!offline && ctx.state === 'running' && typeof ctx.getOutputTimestamp === 'function') {
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.performanceTime > 0 && Number.isFinite(ts.contextTime)) {
          t = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        }
      } catch {
        /* keep the estimate */
      }
    }
    return clamp(t, cur - 1, cur + 0.1) - t0 - LIMITER.lookahead;
  }

  /** Tap of the final mix for MediaRecorder; null where it cannot exist (OfflineAudioContext). */
  function recordStream() {
    if (destroyed) return null;
    const c = getCtx();
    graph();
    if (offline || typeof c.createMediaStreamDestination !== 'function') return null;
    if (!g.tap) {
      g.tap = mk(c.createMediaStreamDestination());
      g.post.connect(g.tap);
      baseline++;
    }
    return g.tap.stream;
  }

  function on(type, fn) {
    const set = listeners[type];
    if (!set || typeof fn !== 'function') return () => {};
    set.add(fn);
    return () => set.delete(fn);
  }

  /** The engine's current copy of a play (after extendPlay / cancelFrom), or null once it is gone. */
  function getPlay(playId) {
    const strip = strips.get(playId);
    if (!strip) return null;
    let events = [];
    for (const p of STRIP_PARAMS) events = events.concat(strip.lanes[p].events);
    return {
      ...strip.play,
      rate: ratePoints(strip.lanes.rate.events),
      events: sortEvents(events).map((e) => ({ ...e })),
    };
  }

  /**
   * Cheap per-frame snapshot of a play for the UI: buffer position, rate and every strip param at set
   * time t, straight from the engine's model. Pass `out` to avoid allocating.
   * @returns {{pos:number, rate:number, gain:number, src:number, low:number, mid:number, high:number, hpf:number, lpf:number, delaySend:number, reverbSend:number}|null}
   */
  function playState(playId, t = now(), out = {}) {
    const strip = strips.get(playId);
    if (!strip) return null;
    const rate = strip.lanes.rate;
    const tt = Math.min(t, strip.effEnd);
    out.pos = positionAt(playModel(strip), tt);
    out.rate = evalParam(rate.events, 'rate', tt, rate.def);
    for (const p of STRIP_PARAMS) out[p] = evalParam(strip.lanes[p].events, p, t, strip.lanes[p].def);
    return out;
  }

  /** Leak accounting: after everything has played out, strips/oneShots are 0 and nodes === baselineNodes. */
  function debug() {
    return {
      started,
      strips: strips.size,
      oneShots: oneShots.length,
      dying: dying.length,
      pending: pending.length + waitingFx.length,
      nodes: nodeCount,
      baselineNodes: baseline,
      busEvents: busLanes ? BUS_PARAMS.reduce((s, p) => s + busLanes[p].events.length, 0) : 0,
    };
  }

  function clearAll() {
    for (const strip of [...strips.values()]) teardown(strip);
    for (const os of oneShots) disposeOneShot(os);
    for (const d of dying) {
      halt(d.sources);
      drop(d.nodes);
    }
    oneShots = [];
    dying = [];
    pending = [];
    waitingFx = [];
  }

  /**
   * End the current set but keep the (already unlocked) context: fades the mix out, frees every play
   * and one-shot, flushes delay / reverb tails. Afterwards start() begins a new set at set time 0.
   * The set clock stops at once: anything scheduled after this call (awaited or not) is queued for
   * that next start(), never mixed into or wiped with the old set.
   */
  function reset() {
    if (destroyed) return Promise.resolve();
    pending = [];
    if (!g || !started) return resetting || Promise.resolve();
    started = false;
    const c = ctx;
    const job = (async () => {
      if (!offline && c.state === 'running') {
        g.bus.gain.setTargetAtTime(0, c.currentTime, 0.008);
        await new Promise((r) => setTimeout(r, 60));
        if (destroyed) return;
      }
      const queued = pending;
      clearAll();
      pending = queued;
      buildFx();
      g.bus.gain.cancelScheduledValues(0);
      g.bus.gain.setValueAtTime(1, c.currentTime);
    })().finally(() => {
      if (resetting === job) resetting = null;
    });
    resetting = job;
    return job;
  }

  function destroy() {
    if (destroyed) return;
    if (timer) clearInterval(timer);
    timer = null;
    if (g) {
      clearAll();
      halt(g.fx.sources.concat([g.keepAlive]));
      drop(g.fx.nodes);
      drop([g.bus, g.master, g.limiter, g.post, g.analyser, g.keepAlive].concat(g.tap ? [g.tap] : []));
    }
    destroyed = true;
    if (unlocked) lockAudio(token);
    listeners.playstart.clear();
    listeners.playend.clear();
    if (owned && ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      ctx.close().catch(() => {});
    }
  }

  return {
    /** Created on first access when the engine owns the context (never after destroy()). */
    get ctx() {
      return destroyed ? ctx : getCtx();
    },
    start,
    unlock,
    now,
    toCtx,
    addPlay,
    extendPlay,
    addFx,
    cancelFrom,
    pause,
    resume,
    setVolume,
    levels,
    on,
    recordStream,
    destroy,
    // Beyond the SPEC surface (see handoff/engine.md):
    tick,
    reset,
    uiTime,
    getPlay,
    playState,
    debug,
  };
}

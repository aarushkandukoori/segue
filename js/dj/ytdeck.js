// YouTube deck: one official IFrame-API player is one deck of the full-song mix (SPEC.md §6).
//
// What the embedded player tells a page is coarse, late and sometimes misleading, so the deck is built
// around what was measured (SPEC §6.1), not around the API reference:
//
//  - Every music video starts with 1-2 pre-roll ads (20-40 s). During an ad getPlayerState() is -1 while
//    getCurrentTime() counts the AD's time, getVideoData() already names the song and seekTo is ignored.
//    The song has begun when PLAYING (1) is first reported for the song's id. There is no "ad" event,
//    so the deck POLLS; the events only make it react sooner.
//  - Muted playback needs no user gesture, and a song held after its muted pre-roll later plays with
//    sound and without a second ad. So cue() runs the pre-roll muted in plain view (never hidden or
//    skipped; YouTube's terms) and parks the song; play() unmutes it at the moment the mix needs it.
//  - Background tabs: Chrome holds still the pre-roll of a player that has only ever played MUTED once
//    its tab is hidden (the ad clock stops; a new video does not start there). A player playing UNMUTED
//    at volume 0 is silent (its <video> reads volume 0) yet runs on in a hidden tab, and so do its later
//    cues. So once the page has had a user gesture, cue(id, {unmuted: true}) pre-rolls unmuted at volume
//    0 and unlock() switches a running muted pre-roll over (called in the tap). The volume stays 0 until
//    play() raises it: setVolume() is remembered but not sent meanwhile, and a player found unmuted above
//    0 is set back to 0. A browser that refuses sound (no gesture after all) gets the muted pre-roll as
//    before. Never on iOS / iPadOS, whose player ignores the volume (volume 0 would be full volume).
//  - Every getter of the player reads a copy that the iframe refreshes by postMessage, so right after
//    a command the getters still describe the past. Commands therefore set a short "quiet" window in
//    which contrary readings are not taken as the truth, and a cue only trusts PLAYING once the player
//    has been seen in some other state after loadVideoById (the old video may still be cached as 1).
//  - The audio never reaches our AudioContext (cross-origin iframe): volume 0-100 is the only control.
//  - YouTube switches its auto-generated captions on for these embeds (muted start or not), and
//    controls:0 / disablekb:1 leave the visitor no way to turn them off. Every song gets them unloaded
//    once it plays (the module calls do nothing during an ad; getOption keeps naming a track, so only the
//    player's own DOM proves it — ytdeck.e2e checks that).
//  - A deck is the only one that may start its player. A start nobody asked for (the big play button
//    YouTube draws on a cued player, a pause ignored while a video was still loading) is paused back:
//    a cued deck stays at its cue point, a stopped deck stays silent, a deck in 'error' plays nothing
//    (heldBack counts them). A load that is abandoned (stop() during a cue, a cue timeout, a cue the
//    browser refused) is also cancelled with stopVideo(), and stop() on a deck in 'error', or after a
//    play() that never reached PLAYING (still pending, or timed out), clears the player the same way.
//  - The deck polls its player on `opts.timers` when given (main.js: js/util/timers.js, a worker clock):
//    the page's own timers fire only once a minute in a silent background tab.
//
// The iframe is created once inside the slot it is given and is never moved, restyled or hidden by this
// module (moving it reloads it; hiding it breaks the terms). destroy() removes it. The deck builds the
// iframe itself rather than letting YT.Player do it: the API would put the page's full address
// (forigin=location.href: playlist, seed, …) into the embed URL, and from there into the Referer of every
// player, ad and stats request. Ours carries origin + path only.

const API_SRC = 'https://www.youtube.com/iframe_api';
const WIDGET_SCRIPT_ID = 'www-widgetapi-script'; // the second script the loader injects
const HOSTS = ['https://www.youtube-nocookie.com', 'https://www.youtube.com']; // what the CSP's frame-src allows
const DEFAULT_HOST = HOSTS[0];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const API_TIMEOUT_MS = 20000;
const CUE_TIMEOUT_MS = 90000; // two pre-roll ads plus a slow start fit with room to spare
const PLAY_TIMEOUT_MS = 15000;
const POLL_MS = 250; // ad detection needs polling; events alone are not enough during ads
const FAST_POLL_MS = 50; // while a play() or a seek is waiting for the player, and just after
const FAST_AFTER_MS = 1000; // the first reports after a start / seek can be stale: correct them quickly
const BLOCKED_MS = 2500; // still paused this long after playVideo() = the browser refused (measured start: ~0.3 s)
const PRIME_SETTLE_MS = 700; // prime()'s own play/pause reports PLAYING for a moment: not the start play() waits for
const MUTED_GRACE_MS = 1500; // PLAYING but still muted this long after unMute() = autoplay with sound refused
const NUDGE_MS = 2000; // re-send playVideo() at most this often while a pre-roll is not moving
const STALL_NUDGE_MS = 4000;
const SEEK_TOLERANCE_S = 0.5;
const SEEK_RETRY_MS = 1500;
const SEEK_GIVE_UP_MS = 4500;
const QUIET_MS = 1200; // after a command, contrary cached states are not believed for this long
const HARD_REANCHOR_S = 0.1; // a report this far from the extrapolation is believed at once (seek, stall, late report)
const SOFT_GAIN = 0.25; // share of a small disagreement corrected per report (keeps position() smooth)
const HOLD_REPEAT_MS = 500; // a start nobody asked for is paused back at most this often
const ENFORCE_MS = 600; // an unmuted pre-roll found above volume 0 is set back to 0 at most this often
const ENFORCE_AFTER_MS = 800; // (the player's reported volume lags a command by a few hundred ms)
const UNMUTED_STALL_MS = 6000; // an unmuted pre-roll that has not moved this long (page in front): go on muted
const LATE_BLOCK_MS = 300; // an autoplay refusal this soon after going muted belongs to the unmuted attempt
const CAPTIONS_AGAIN_MS = 1000; // captions are unloaded when a song starts, and once more this long after

/** What every deck's embed URL carries (plus origin / widget_referrer); see youTubeEmbedUrl(). */
const PLAYER_VARS = Object.freeze({
  playsinline: 1,
  controls: 0,
  disablekb: 1,
  rel: 0,
  iv_load_policy: 3,
  fs: 0,
  cc_load_policy: 0,
  enablejsapi: 1,
  mute: 1, // starts muted: nothing is ever heard before play() asks for it
});
/**
 * iOS / iPadOS (iPadOS reports itself as a Mac with touch; the same rule as main.js): the player there
 * ignores setVolume, so a pre-roll "unmuted at volume 0" would be an ad at full volume.
 */
function volumeIgnored() {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(String(navigator.userAgent || '')) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** The attributes YT.Player gives the iframes it makes (autoplay matters: play() unmutes from our tap). */
const IFRAME_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';

/** Messages for the player's onError codes (YouTube IFrame API reference + the 2025 referrer code). */
export const YT_ERRORS = Object.freeze({
  2: 'The video id was refused by the player',
  5: 'The player could not play this video',
  100: 'Video not found (removed or private)',
  101: 'The owner does not allow this video to be embedded',
  150: 'The owner does not allow this video to be embedded',
  153: 'The player refused to start (missing referrer / origin)',
});

/**
 * Typed error of every deck promise.
 * code: a YouTube onError number (2, 5, 100, 101, 150, 153) or
 *   'timeout'   the cue / play did not get there in time
 *   'cancelled' superseded by a newer cue / play, by pause() / stop(), or the deck was destroyed
 *   'blocked'   the browser refused to start playback (autoplay policy) — needs a user gesture
 *   'invalid'   not a YouTube video id
 *   'not-cued'  play() with nothing cued
 *   'api'       the IFrame API could not be loaded (network, content blocker, CSP)
 */
export class DeckError extends Error {
  /** @param {number|string} code @param {string} message @param {{cause?: unknown}} [opts] */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'DeckError';
    this.code = code;
  }
}

// ── API loader ──────────────────────────────────────────────────────────────────────────────────────

/** @type {Promise<any>|null} */
let apiPromise = null;

/** window.YT once the widget API has fully run (YT.Player defined), else null. */
function loadedYT() {
  const yt = typeof window !== 'undefined' ? /** @type {any} */ (window).YT : null;
  return yt && typeof yt.Player === 'function' && yt.loaded !== 0 ? yt : null;
}

/**
 * Load the YouTube IFrame Player API once per page. Injects https://www.youtube.com/iframe_api (unless
 * a script with that src is already in the document), chains any window.onYouTubeIframeAPIReady that
 * the page already has, and resolves with window.YT. Rejects with a clear Error when the script fails
 * (network, content blocker, Content-Security-Policy) or nothing arrives within timeoutMs; a later call
 * tries again.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export function loadYouTubeApi({ timeoutMs = API_TIMEOUT_MS } = {}) {
  const ready = loadedYT();
  if (ready) return Promise.resolve(ready);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const w = /** @type {any} */ (window);
    let done = false;
    /** @type {HTMLScriptElement|null} */
    let script = document.querySelector(`script[src="${API_SRC}"]`);
    const injected = !script;
    /** @type {HTMLScriptElement|null} */
    let widget = null;

    const check = () => {
      const yt = loadedYT();
      if (yt) finish(null, yt);
    };
    const onScriptError = () =>
      finish(
        new Error(
          'Could not load the YouTube player (blocked by the network, a content blocker or the page’s Content-Security-Policy)',
        ),
      );
    const onLoad = () => {
      // The loader defines YT.ready() and injects the widget script; watch that one fail too.
      const yt = w.YT;
      if (yt && typeof yt.ready === 'function') yt.ready(check);
      widget = /** @type {HTMLScriptElement|null} */ (document.getElementById(WIDGET_SCRIPT_ID));
      if (widget) widget.addEventListener('error', onScriptError);
      check();
    };
    // Someone else may (re)assign onYouTubeIframeAPIReady after us; the poll covers that.
    const poll = setInterval(check, 100);
    const timer = setTimeout(
      () => finish(new Error(`The YouTube player did not load within ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );

    function finish(/** @type {Error|null} */ err, /** @type {any} */ yt) {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (script) {
        script.removeEventListener('error', onScriptError);
        script.removeEventListener('load', onLoad);
      }
      if (widget) widget.removeEventListener('error', onScriptError);
      if (err) {
        apiPromise = null;
        if (injected && script && script.parentNode && !loadedYT()) script.parentNode.removeChild(script);
        reject(err);
      } else {
        resolve(yt);
      }
    }

    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = function chainedYouTubeReady(/** @type {any[]} */ ...args) {
      try {
        if (typeof previous === 'function') previous.apply(this, args);
      } catch (e) {
        setTimeout(() => {
          throw e; // the page's own handler failed: surface it without breaking the chain
        });
      } finally {
        check();
      }
    };

    if (!script) {
      script = document.createElement('script');
      script.src = API_SRC;
      script.async = true;
    }
    script.addEventListener('error', onScriptError);
    script.addEventListener('load', onLoad);
    if (injected) (document.head || document.documentElement).appendChild(script);
    else if (w.YT && typeof w.YT.ready === 'function') onLoad(); // already executed: just wait for it
  });
  return apiPromise;
}

// ── the deck ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The embed URL a deck's iframe loads: the player vars, the page's origin (the API needs it for its
 * messages) and widget_referrer = origin + path. Never the query or hash: a share link's playlist, seed,
 * vibe and length stay on the page (the API itself would send location.href as `forigin`).
 * @param {string} host  one of HOSTS
 * @param {{origin: string, pathname: string}} loc  usually window.location
 * @returns {string}
 */
export function youTubeEmbedUrl(host, loc) {
  if (!HOSTS.includes(host)) throw new TypeError(`youTubeEmbedUrl: host must be one of ${HOSTS.join(', ')}`);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(PLAYER_VARS)) params.set(k, String(v));
  params.set('origin', String(loc.origin));
  params.set('widget_referrer', String(loc.origin) + String(loc.pathname || '/'));
  return `${host}/embed/?${params}`;
}

/** @typedef {'empty'|'loading'|'ad'|'cued'|'playing'|'paused'|'ended'|'error'} DeckState */

/**
 * @typedef {Object} YouTubeDeck
 * @property {DeckState} state
 * @property {string|null} videoId
 * @property {number} duration      song length in s (0 until the player knows it)
 * @property {number|null} error    the player's onError code, null otherwise
 * @property {number} adSeconds     seconds of pre-roll ad seen by the current / last cue, counted only while
 *                                  the ad's clock moves (Chrome holds a muted ad still in a hidden tab)
 * @property {boolean} ready        the player is up (commands before that are queued)
 * @property {boolean} muted        what the deck last told the player
 * @property {boolean} unmutedHold  an unmuted pre-roll / cued song: the player is unmuted at volume 0 and
 *                                  stays there until play()
 * @property {number} volume        0..1, the volume last asked for (setVolume / play); during an unmuted
 *                                  pre-roll the player itself is held at 0 until play()
 * @property {number} heldBack      starts the deck did not ask for and paused back (a click on a cued
 *                                  player's own play button; a stopped player that went on anyway).
 *                                  Each one also calls onChange.
 * @property {HTMLIFrameElement|null} iframe
 * @property {(videoId: string, opts?: {at?: number, timeoutMs?: number, unmuted?: boolean}) => Promise<void>} cue
 * @property {() => boolean} unlock  a running muted pre-roll goes on unmuted at volume 0 (call it in a tap)
 * @property {(opts?: {volume?: number, timeoutMs?: number}) => Promise<void>} play
 * @property {() => void} pause
 * @property {() => Promise<boolean>} resume
 * @property {() => void} stop
 * @property {(s: number) => void} seek
 * @property {(v: number) => void} setVolume
 * @property {() => number} position
 * @property {() => void} prime
 * @property {() => void} destroy
 * @property {() => Object} debug
 */

/**
 * Create one deck: an iframe in `slot` (made by the deck, see youTubeEmbedUrl) becomes a YT.Player
 * (100 % of the slot, privacy-enhanced host by default). The slot must stay visible, at least 200×200
 * CSS px and uncovered (SPEC §6.2).
 * @param {HTMLElement} slot
 * @param {{host?: string, onChange?: (deck: YouTubeDeck) => void, apiTimeoutMs?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function}}} [opts]
 *   timers: what the deck polls its player on (main.js: js/util/timers.js, a worker clock that Chrome does
 *   not throttle in a background tab); default the window's
 * @returns {YouTubeDeck}
 */
export function createYouTubeDeck(slot, { host = DEFAULT_HOST, onChange, apiTimeoutMs, timers } = {}) {
  if (!slot || typeof slot.appendChild !== 'function') throw new TypeError('createYouTubeDeck: slot must be an element');
  if (!HOSTS.includes(host)) throw new TypeError(`createYouTubeDeck: host must be one of ${HOSTS.join(', ')}`);
  const T =
    timers && typeof timers.setTimeout === 'function' && typeof timers.clearTimeout === 'function'
      ? timers
      : { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };

  // A placeholder until the API is there; then replaced, in place, by the deck's own iframe.
  const mount = document.createElement('div');
  mount.className = 'yt-deck-player';
  slot.appendChild(mount);
  /** @type {HTMLIFrameElement|null} */
  let frame = null;

  /** @type {any} */
  let player = null;
  let ready = false;
  let destroyed = false;
  /** @type {(() => void)[]} commands issued before onReady */
  const queue = [];

  /** @type {DeckState} */
  let state = 'empty';
  /** @type {string|null} */
  let videoId = null;
  let duration = 0;
  /** @type {number|null} */
  let error = null;
  let adSeconds = 0;
  let muted = false;
  /** last volume asked for, 0-100 (-1 = never); sent to the player except while silentHold */
  let sentVolume = -1;
  /** unmuted at volume 0 (an unmuted pre-roll and the song it cues): the player stays at 0 until play() */
  let silentHold = false;
  let enforcedAt = -Infinity;
  /** why the last cue went on muted although asked for unmuted ('refused' | 'stalled' | 'player' | '') */
  let lastFellBack = '';

  // position(): the last report, extrapolated with performance.now() while playing
  let anchorT = 0;
  let anchorAt = 0;
  let anchorPlaying = false;

  // passive mirroring of the player's state
  let quietUntil = 0;
  /** @type {number|null} state that ends the quiet window early when seen */
  let expectSt = null;
  let lastPassiveT = 0;
  let autoplayBlockedAt = -Infinity;
  let cueDrift = 0;
  let fastUntil = 0;
  let primedAt = -Infinity;

  // starts nobody asked for
  /** song position a cued deck holds (where its cue landed) */
  let holdAt = 0;
  /** stop() was called: the player must stay paused until the next cue / play / resume */
  let silenced = false;
  let silencedAt = -Infinity;
  let heldAt = -Infinity;
  let countedAt = -Infinity;
  let heldBack = 0;

  // captions: unloaded for each song once it plays (see the header)
  /** @type {string|null} the video whose captions were last unloaded */
  let captionsOffFor = null;
  let captionsAgainAt = 0;

  /** @type {any} the poll's timer id (window or js/util/timers.js) */
  let timer = null;

  /**
   * @typedef {{token: number, videoId: string, at: number, startedAt: number, deadline: number,
   *   phase: 'start'|'preroll'|'seek', sawFresh: boolean, lastT: number, lastWall: number,
   *   movedAt: number, nudgedAt: number, seekIssuedAt: number, seekStartedAt: number, seekTries: number,
   *   pausedAt: number, unmuted: boolean, unmutedAt: number, mutedAt: number, fellBack: string,
   *   resolve: () => void, reject: (e: DeckError) => void}} CueOp
   * @typedef {{prev: DeckState, unmute: boolean, startedAt: number, deadline: number, adMs: number,
   *   lastWall: number, lastT: number, playingSince: number,
   *   resolve: () => void, reject: (e: DeckError) => void}} PlayOp
   */
  /** @type {CueOp|null} */
  let cueOp = null;
  /** @type {PlayOp|null} */
  let playOp = null;
  /** the last play() timed out without the song starting: the next stop() clears the player (stopVideo) */
  let startTimedOut = false;
  let cueSeq = 0;
  let playSeq = 0; // bumped by every play / pause / stop / cue: a play() waiting on a cue checks it

  const now = () => performance.now();
  const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  function setState(/** @type {DeckState} */ next) {
    if (state === next || destroyed) return;
    state = next;
    notify();
  }

  function notify() {
    if (destroyed || typeof onChange !== 'function') return;
    try {
      onChange(api);
    } catch (e) {
      setTimeout(() => {
        throw e; // the caller's bug, reported without breaking the deck
      });
    }
  }

  /** Run a player command now, or after onReady. A throwing player call never breaks the deck. */
  function run(/** @type {() => void} */ fn) {
    if (destroyed) return;
    if (!ready) {
      queue.push(fn);
      return;
    }
    try {
      fn();
    } catch {
      /* the iframe is gone or not yet attached; the poll will notice */
    }
  }

  function read(/** @type {string} */ method, /** @type {any} */ fallback) {
    if (!ready || !player || typeof player[method] !== 'function') return fallback;
    try {
      const v = player[method]();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  /**
   * The song is playing: unload YouTube's captions (every new video brings them back), and once more a
   * moment later in case the player turned them on again as it started. Only called for the song itself
   * at PLAYING: the same calls during an ad do nothing.
   */
  function captionsOff(/** @type {number} */ t0, again = true) {
    if (!videoId) return;
    captionsOffFor = videoId;
    captionsAgainAt = again ? t0 + CAPTIONS_AGAIN_MS : 0;
    run(() => {
      if (typeof player.unloadModule === 'function') {
        player.unloadModule('captions');
        player.unloadModule('cc');
      }
      if (typeof player.setOption === 'function') player.setOption('captions', 'track', {});
    });
  }

  /**
   * The player started (or kept going) without this deck asking: pause it back, muted, at most every
   * HOLD_REPEAT_MS. A cued deck is put back on its cue point.
   * @param {number} t0
   * @param {boolean} count  a new start (not prime()'s own play/pause, not the same start again)
   */
  function holdBack(t0, count) {
    if (t0 - heldAt < HOLD_REPEAT_MS) return;
    heldAt = t0;
    const cued = state === 'cued';
    // A cued song pre-rolled unmuted stays unmuted at volume 0 (what lets it start in a hidden tab).
    const keep = cued && silentHold;
    if (!keep) {
      muted = true;
      silentHold = false;
    }
    run(() => {
      if (keep) player.setVolume(0);
      else player.mute();
      player.pauseVideo();
      if (cued) player.seekTo(holdAt, true);
    });
    quiet(2);
    // The same start reported again while it is being paused back is not a new one.
    if (count && t0 - countedAt > 4 * HOLD_REPEAT_MS) {
      heldBack++;
      countedAt = t0;
      notify();
    }
  }

  function quiet(/** @type {number|null} */ expect, ms = QUIET_MS) {
    quietUntil = now() + ms;
    expectSt = expect;
  }

  /**
   * (Inside run().) Unmuted at volume 0: setVolume(0) first, so a player that is playing never sounds at
   * its old volume; unMute() (YouTube restores volume 5 when it unmutes a player at 0); setVolume(0) again.
   */
  function sendUnmutedSilent() {
    player.setVolume(0);
    player.unMute();
    player.setVolume(0);
  }

  /**
   * While silentHold: a player found unmuted above volume 0 (YouTube's restore-on-unmute arriving after our
   * setVolume(0), or anything else) is set back to 0.
   */
  function enforceSilence(/** @type {number} */ t0) {
    if (!silentHold || t0 - enforcedAt < ENFORCE_MS) return;
    if (read('isMuted', true) !== false || !(Number(read('getVolume', 0)) > 0)) return;
    enforcedAt = t0;
    run(() => player.setVolume(0));
  }

  /** An unmuted pre-roll the browser will not run with sound (no gesture after all): go on muted, as before. */
  function fallBackToMuted(/** @type {CueOp} */ op, /** @type {number} */ t0, /** @type {string} */ why) {
    op.unmuted = false;
    op.fellBack = why;
    op.mutedAt = t0 + LATE_BLOCK_MS;
    op.movedAt = op.nudgedAt = t0;
    silentHold = false;
    muted = true;
    run(() => {
      if (cueOp !== op) return;
      player.mute();
      if (op.phase === 'preroll') player.playVideo();
    });
  }

  function setAnchor(/** @type {number} */ t, /** @type {boolean} */ playing) {
    anchorT = Math.max(0, t);
    anchorAt = now();
    anchorPlaying = playing;
  }

  function position() {
    if (!anchorPlaying) return anchorT;
    let p = anchorT + (now() - anchorAt) / 1000;
    if (state === 'playing' && !playOp && !cueOp) {
      // Cheap cross-check against the player's own (Date.now-extrapolated) report, so a jump in it
      // is followed now and not at the next tick; small disagreements are left to tick()'s smoothing.
      const raw = Number(read('getCurrentTime', NaN));
      if (Number.isFinite(raw) && Math.abs(raw - p) > HARD_REANCHOR_S && now() >= quietUntil) {
        setAnchor(raw, true);
        p = raw;
      }
    }
    return duration > 0 ? Math.min(p, duration) : p;
  }

  function schedule() {
    if (destroyed || (!ready && !cueOp && !playOp)) return; // before onReady only deadlines need watching
    if (timer) T.clearTimeout(timer);
    const fast = !!playOp || (cueOp && cueOp.phase === 'seek') || now() < fastUntil;
    timer = T.setTimeout(() => {
      timer = null;
      tick(null);
    }, fast ? FAST_POLL_MS : POLL_MS);
  }

  // ── the state machine (one reading of the player per tick) ──

  function tick(/** @type {number|null} */ eventState) {
    if (destroyed) return;
    const t0 = now();
    if (!ready) {
      // A player that never comes up (iframe refused, API wedged) must still end the wait.
      if (cueOp && t0 > cueOp.deadline) failCue(cueOp, new DeckError('timeout', 'The YouTube player did not start'), 'error');
      if (playOp && t0 > playOp.deadline) endPlay(playOp, new DeckError('timeout', 'The YouTube player did not start'), playOp.prev);
      schedule();
      return;
    }
    const st = eventState ?? read('getPlayerState', -1);
    const t = Number(read('getCurrentTime', 0)) || 0;
    const data = read('getVideoData', null);
    const vid = data && typeof data.video_id === 'string' ? data.video_id : null;
    const d = Number(read('getDuration', 0)) || 0;
    if (videoId && vid === videoId && d > 0) duration = d;
    if (captionsAgainAt && t0 >= captionsAgainAt && st === 1 && vid === videoId) captionsOff(t0, false);
    enforceSilence(t0);

    if (cueOp) tickCue(cueOp, st, t, vid, d, t0);
    else if (playOp) tickPlay(playOp, st, t, t0);
    else mirror(st, t, t0);
    schedule();
  }

  function tickCue(/** @type {CueOp} */ op, /** @type {number} */ st, /** @type {number} */ t, /** @type {string|null} */ vid, /** @type {number} */ d, /** @type {number} */ t0) {
    if (t0 > op.deadline) {
      run(() => {
        // do not leave a muted ad looping on a deck nobody waits for (stopVideo: see stop())
        player.pauseVideo();
        player.stopVideo();
      });
      failCue(op, new DeckError('timeout', `The video did not start within ${Math.round((op.deadline - op.startedAt) / 1000)} s`), 'error');
      return;
    }
    if (op.phase === 'start') return; // loadVideoById not sent yet (queued behind onReady)

    if (op.phase === 'preroll') {
      if (st !== 1) op.sawFresh = true;
      if (st === 1 && op.sawFresh && vid === op.videoId) {
        // The song itself is playing (muted). Hold it at the cue point.
        op.phase = 'seek';
        op.at = clampAt(op.at, d);
        op.seekStartedAt = op.seekIssuedAt = op.pausedAt = t0;
        run(() => {
          player.pauseVideo();
          player.seekTo(op.at, true);
        });
        captionsOff(t0);
        setState('loading');
        return;
      }
      const moved = t > op.lastT + 0.01 || t < op.lastT - 0.5; // a second ad restarts at 0
      const sinceMove = (t0 - op.movedAt) / 1000;
      if (moved) op.movedAt = t0;
      if (st === -1 && moved) setState('ad');
      // Only time the ad's clock really moved: Chrome holds a muted ad still in a hidden tab (or lets it
      // crawl), and a caller deciding whether an ad is "still running" must not see a frozen one as
      // progress. The step the clock made, at most the wall time since it last moved (the player's copy of
      // its clock arrives in bursts in a background tab).
      if (state === 'ad' && moved) adSeconds += t > op.lastT ? Math.min(t - op.lastT, sinceMove + 0.25) : Math.min(t, sinceMove + 0.25);
      if (op.unmuted) {
        const refused = autoplayBlockedAt >= op.unmutedAt;
        // (a pre-roll that has never moved, with the page in front where muted would run: same answer)
        const stuck = op.movedAt <= op.unmutedAt && t0 - op.unmutedAt > UNMUTED_STALL_MS && st !== 1 && st !== 3 && !pageHidden();
        if (refused || stuck) fallBackToMuted(op, t0, refused ? 'refused' : 'stalled');
        else if (moved && t0 - op.unmutedAt > 2500 && read('isMuted', false) === true) {
          // the player answered the refusal itself by playing muted: say so
          op.unmuted = false;
          op.fellBack = 'player';
          silentHold = false;
          muted = true;
        }
      }
      // A pre-roll that is not moving: cued-but-not-playing (5), paused (2), or stuck unstarted.
      const stalled = st === 5 || st === 2 || (st === -1 && t0 - op.movedAt > STALL_NUDGE_MS);
      if (stalled && t0 - op.nudgedAt > NUDGE_MS) {
        op.nudgedAt = t0;
        run(() => player.playVideo());
      }
      if (!op.unmuted && autoplayBlockedAt >= op.mutedAt && t0 - op.movedAt > BLOCKED_MS && st !== 1 && st !== 3) {
        // given up: cancel the load too, so it does not start by itself later (when the tab is shown)
        run(() => {
          player.pauseVideo();
          player.stopVideo();
        });
        failCue(op, new DeckError('blocked', 'The browser blocked even muted playback — tap to start'), 'error');
        return;
      }
      op.lastT = t;
      op.lastWall = t0;
      return;
    }

    // phase 'seek': paused at the cue point yet?
    if (st === 1 && t0 - op.pausedAt > 500) {
      op.pausedAt = t0;
      run(() => player.pauseVideo());
    }
    const near = Math.abs(t - op.at) <= SEEK_TOLERANCE_S;
    const held = st === 2 || st === 5 || (st === 3 && t0 - op.seekIssuedAt > 1000);
    if (near && held) {
      cueDrift = t - op.at;
      completeCue(op, t);
      return;
    }
    if (t0 - op.seekIssuedAt > SEEK_RETRY_MS && op.seekTries < 1) {
      op.seekTries++;
      op.seekIssuedAt = t0;
      run(() => player.seekTo(op.at, true));
      return;
    }
    if (t0 - op.seekStartedAt > SEEK_GIVE_UP_MS && st !== 1) {
      cueDrift = t - op.at; // held, just not where asked; position() reports the truth
      completeCue(op, t);
    }
  }

  function completeCue(/** @type {CueOp} */ op, /** @type {number} */ t) {
    cueOp = null;
    lastFellBack = op.fellBack;
    setAnchor(t, false);
    holdAt = Math.max(0, t);
    quiet(2);
    setState('cued');
    op.resolve();
  }

  function failCue(/** @type {CueOp} */ op, /** @type {DeckError} */ err, /** @type {DeckState|null} */ next) {
    if (cueOp === op) cueOp = null;
    lastFellBack = op.fellBack;
    // A cue given up on (timeout) may have its ad still loading, and a pause sent then is ignored:
    // keep it paused like a stopped deck until the next cue.
    if (err.code === 'timeout') {
      silenced = true;
      silencedAt = now();
    }
    if (next) setState(next);
    op.reject(err);
  }

  function tickPlay(/** @type {PlayOp} */ op, /** @type {number} */ st, /** @type {number} */ t, /** @type {number} */ t0) {
    const dt = t0 - op.lastWall;
    const moved = t > op.lastT + 0.01;
    op.lastWall = t0;
    op.lastT = t;
    if (t0 < primedAt + PRIME_SETTLE_MS) return; // a prime() in the same tap: its transient states are noise
    if (st === 1) {
      if (!op.playingSince) op.playingSince = t0;
      // Some browsers / player builds answer a refused unmuted play by playing muted instead.
      const stillMuted = op.unmute && read('isMuted', false) === true;
      if (stillMuted && t0 - op.playingSince < MUTED_GRACE_MS) return;
      if (stillMuted) {
        run(() => player.pauseVideo());
        endPlay(op, new DeckError('blocked', 'The browser only allowed muted playback — tap to start'), op.prev);
        return;
      }
      setAnchor(t, true);
      lastPassiveT = t;
      endPlay(op, null, 'playing');
      return;
    }
    if (autoplayBlockedAt >= op.startedAt) {
      endPlay(op, new DeckError('blocked', 'The browser blocked playback with sound — tap to start'), op.prev);
      return;
    }
    if (st === -1 && moved) {
      // An ad while starting (a mid-roll, or the pre-roll of a deck that was never cued): it does not
      // count against the timeout, and the deck says what is on screen.
      op.adMs += dt;
      setState('ad');
    } else if ((st === 2 || st === 5) && t0 - op.startedAt - op.adMs > BLOCKED_MS) {
      endPlay(op, new DeckError('blocked', 'The browser blocked playback — tap to start'), op.prev);
      return;
    }
    if (t0 > op.deadline + op.adMs) endPlay(op, new DeckError('timeout', 'The video did not start playing'), op.prev);
  }

  function endPlay(/** @type {PlayOp} */ op, /** @type {DeckError|null} */ err, /** @type {DeckState} */ next) {
    if (playOp === op) playOp = null;
    startTimedOut = !!err && err.code === 'timeout';
    if (err && op.unmute && (err.code === 'blocked' || err.code === 'timeout')) {
      // A refused or late start must not turn audible later behind the caller's back.
      muted = true;
      run(() => {
        player.pauseVideo();
        player.mute();
      });
      quiet(2);
    }
    if (next === 'playing') {
      quiet(1, 400);
      fastUntil = now() + FAST_AFTER_MS;
      captionsOff(now());
    }
    setState(next);
    if (err) op.reject(err);
    else op.resolve();
  }

  /**
   * No operation pending: follow what the player does (ended, a click on the video, a mid-roll ad) —
   * except where the deck must hold: a stopped deck stays paused, a cued deck stays on its cue point.
   */
  function mirror(/** @type {number} */ st, /** @type {number} */ t, /** @type {number} */ t0) {
    const advancing = t > lastPassiveT + 0.01;
    lastPassiveT = t;
    if (silenced) {
      // stop() was called. A pause sent while a video is still loading is ignored by the player, which
      // then plays its ad and the song (muted) in a stage that may be hidden by now: pause it again.
      // Before the early returns below: an abandoned cue leaves the deck 'empty'.
      // (Right after stop() the cached state still says what the player did before: not a new start.)
      if (st === 1 || st === 3 || (st === -1 && advancing)) holdBack(t0, st !== 3 && t0 - silencedAt > QUIET_MS && t0 >= primedAt + PRIME_SETTLE_MS);
      return;
    }
    if (!videoId || state === 'empty' || state === 'error') {
      // Nothing of this deck's may play here either. A cue that failed (refused by the browser in a
      // background tab, say) can still start later on its own — Chrome resumes it when the tab is shown —
      // and it would play unseen by the deck and its caller: paused back like a stopped deck's.
      if (st === 1 || st === 3 || (st === -1 && advancing)) holdBack(t0, st !== 3 && t0 >= primedAt + PRIME_SETTLE_MS);
      return;
    }
    if (t0 < quietUntil && st !== expectSt) return;
    quietUntil = 0;
    expectSt = null;
    if (state === 'cued') {
      // Nothing may start a cued song but play(): a click on the big play button YouTube draws on the
      // idle player would otherwise run it (muted, unseen) and it would come in late at the transition.
      if (st === 1 || (st === -1 && advancing)) holdBack(t0, t0 >= primedAt + PRIME_SETTLE_MS);
      else if ((st === 2 || st === 5) && Math.abs(t - holdAt) > SEEK_TOLERANCE_S && t0 - heldAt > SEEK_RETRY_MS) {
        heldAt = t0; // held, but not where the cue left it (after a hold-back): back to the cue point
        run(() => player.seekTo(holdAt, true));
        quiet(2);
      }
      return; // a cued deck's position is its cue point
    }
    if (st === 1) {
      // getCurrentTime() is already extrapolated by the API while playing; follow it smoothly.
      const pred = position();
      if (!anchorPlaying || Math.abs(t - pred) > HARD_REANCHOR_S) setAnchor(t, true);
      else setAnchor(pred + (t - pred) * SOFT_GAIN, true);
      if (state !== 'playing') {
        captionsOff(t0); // started by a click on the video (a deck paused by pause())
        setState('playing');
      }
      return;
    }
    if (st === 0) {
      setAnchor(duration || t, false);
      setState('ended');
      return;
    }
    if (st === -1 && advancing && (state === 'playing' || state === 'ad')) {
      setAnchor(anchorT, false);
      setState('ad');
      return;
    }
    if (st === 2 || st === 5) {
      setAnchor(t, false);
      if (state === 'playing' || state === 'ad') setState('paused');
      return;
    }
    if (st === 3) setAnchor(t, false); // buffering: the song is not moving
  }

  function clampAt(/** @type {number} */ at, /** @type {number} */ d) {
    const a = Number.isFinite(at) && at > 0 ? at : 0;
    return d > 1 ? Math.min(a, d - 1) : a;
  }

  function cancelPlay(/** @type {string} */ why) {
    playSeq++;
    const op = playOp;
    if (!op) return;
    playOp = null;
    op.reject(new DeckError('cancelled', why));
  }

  function cancelCue(/** @type {string} */ why) {
    const op = cueOp;
    if (!op) return;
    cueOp = null;
    op.reject(new DeckError('cancelled', why));
  }

  // ── player construction ──

  function onReady() {
    if (destroyed) return;
    ready = true;
    if (sentVolume >= 0 && !silentHold) run(() => player.setVolume(sentVolume));
    for (const fn of queue.splice(0)) run(fn);
    tick(null);
  }

  function onStateChange(/** @type {{data: number}} */ e) {
    if (destroyed) return;
    const st = typeof e?.data === 'number' ? e.data : null;
    if (cueOp && cueOp.phase === 'preroll' && st !== null && st !== 1) cueOp.sawFresh = true;
    tick(st);
  }

  function onError(/** @type {{data: number}} */ e) {
    if (destroyed) return;
    const code = Number(e?.data);
    error = Number.isFinite(code) ? code : 5;
    const err = new DeckError(error, YT_ERRORS[/** @type {keyof typeof YT_ERRORS} */ (error)] || `YouTube player error ${error}`);
    if (cueOp) failCue(cueOp, err, null);
    if (playOp) endPlay(playOp, err, 'error');
    setState('error');
  }

  function onAutoplayBlocked() {
    if (destroyed) return;
    autoplayBlockedAt = now();
    tick(null);
  }

  let apiFailure = /** @type {DeckError|null} */ (null);
  loadYouTubeApi(apiTimeoutMs ? { timeoutMs: apiTimeoutMs } : undefined).then(
    (YT) => {
      if (destroyed) return;
      // Our own iframe (see the header: no forigin = location.href), with the attributes the API would
      // give it, put where the placeholder was. The API then just attaches to it.
      frame = document.createElement('iframe');
      frame.className = mount.className;
      frame.title = 'YouTube video player';
      frame.width = '100%';
      frame.height = '100%';
      frame.setAttribute('frameborder', '0');
      frame.setAttribute('allow', IFRAME_ALLOW);
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.src = youTubeEmbedUrl(host, location);
      if (mount.parentNode) mount.parentNode.replaceChild(frame, mount);
      else slot.appendChild(frame);
      player = new YT.Player(frame, { host, events: { onReady, onStateChange, onError, onAutoplayBlocked } });
      muted = true;
    },
    (err) => {
      if (destroyed) return;
      apiFailure = new DeckError('api', err && err.message ? err.message : 'The YouTube player could not be loaded', { cause: err });
      queue.length = 0;
      if (cueOp) failCue(cueOp, apiFailure, null);
      cancelPlay('the YouTube player could not be loaded');
      setState('error');
    },
  );

  // ── public surface ──

  /** @type {YouTubeDeck} */
  const api = {
    get state() {
      return state;
    },
    get videoId() {
      return videoId;
    },
    get duration() {
      return duration;
    },
    get error() {
      return error;
    },
    get adSeconds() {
      return adSeconds;
    },
    get ready() {
      return ready;
    },
    get muted() {
      return muted;
    },
    get unmutedHold() {
      return silentHold;
    },
    get volume() {
      return sentVolume < 0 ? 1 : sentVolume / 100;
    },
    get iframe() {
      return player && frame && !destroyed ? frame : null;
    },
    get heldBack() {
      return heldBack;
    },

    cue(id, { at = 0, timeoutMs = CUE_TIMEOUT_MS, unmuted = false } = {}) {
      if (destroyed) return Promise.reject(new DeckError('cancelled', 'The deck was destroyed'));
      if (apiFailure) return Promise.reject(apiFailure);
      if (typeof id !== 'string' || !VIDEO_ID.test(id)) {
        return Promise.reject(new DeckError('invalid', 'Not a YouTube video id'));
      }
      startTimedOut = false;
      cancelCue('replaced by a newer cue');
      cancelPlay('replaced by a newer cue');
      const t0 = now();
      const um = !!unmuted && !volumeIgnored();
      return new Promise((resolve, reject) => {
        /** @type {CueOp} */
        const op = {
          token: ++cueSeq,
          videoId: id,
          at: Number.isFinite(at) && at > 0 ? at : 0,
          startedAt: t0,
          deadline: t0 + Math.max(1000, timeoutMs),
          phase: 'start',
          sawFresh: false,
          lastT: 0,
          lastWall: t0,
          movedAt: t0,
          nudgedAt: t0,
          seekIssuedAt: 0,
          seekStartedAt: 0,
          seekTries: 0,
          pausedAt: 0,
          unmuted: um,
          unmutedAt: um ? t0 : Infinity,
          mutedAt: t0,
          fellBack: '',
          resolve,
          reject,
        };
        cueOp = op;
        silenced = false;
        silentHold = um; // from now on setVolume() waits for play() (the queued load sends the 0)
        enforcedAt = t0 + ENFORCE_AFTER_MS - ENFORCE_MS;
        videoId = id;
        duration = 0;
        error = null;
        adSeconds = 0;
        cueDrift = 0;
        setAnchor(op.at, false);
        quietUntil = 0;
        setState('loading');
        run(() => {
          if (cueOp !== op) return; // superseded while queued
          if (op.unmuted) {
            muted = false;
            sendUnmutedSilent();
          } else {
            muted = true;
            player.mute();
          }
          const start = op.at >= 1 ? { videoId: id, startSeconds: op.at } : { videoId: id };
          player.loadVideoById(start);
          op.phase = 'preroll';
          op.lastWall = op.movedAt = op.nudgedAt = now();
          if (op.unmuted) op.unmutedAt = op.lastWall;
          op.mutedAt = op.lastWall;
          op.lastT = 0;
        });
        schedule();
      });
    },

    async play({ volume, timeoutMs = PLAY_TIMEOUT_MS } = {}) {
      if (destroyed) throw new DeckError('cancelled', 'The deck was destroyed');
      const seq = ++playSeq;
      if (cueOp) {
        await new Promise((resolve, reject) => {
          const op = /** @type {CueOp} */ (cueOp);
          const { resolve: r0, reject: j0 } = op;
          op.resolve = () => {
            r0();
            resolve(undefined);
          };
          op.reject = (e) => {
            j0(e);
            reject(e);
          };
        });
        if (seq !== playSeq || destroyed) throw new DeckError('cancelled', 'superseded while the video was cueing');
      }
      if (!videoId || state === 'empty' || state === 'error') {
        throw new DeckError(error ?? 'not-cued', error != null ? YT_ERRORS[/** @type {keyof typeof YT_ERRORS} */ (error)] || 'The video failed' : 'Nothing is cued on this deck');
      }
      if (volume !== undefined) api.setVolume(volume);
      if (state === 'playing') {
        if (muted || silentHold) {
          const v = sentVolume >= 0 ? sentVolume : silentHold ? 100 : -1;
          muted = false;
          silentHold = false;
          run(() => {
            player.unMute();
            if (v >= 0) player.setVolume(v);
          });
        }
        return;
      }
      return startPlayback(true, timeoutMs);
    },

    pause() {
      if (destroyed) return;
      cancelPlay('paused');
      // A pre-roll goes on (muted) and ends with the song held anyway; a cued deck is not playing.
      if (cueOp || (state !== 'playing' && state !== 'ad')) return;
      run(() => player.pauseVideo());
      setAnchor(position(), false);
      quiet(2);
      setState('paused');
    },

    resume() {
      // Only what pause() / stop() paused: resuming a CUED deck would start it and spoil the cue.
      if (destroyed || state === 'playing') return Promise.resolve(!destroyed);
      if (cueOp || state !== 'paused') return Promise.resolve(false);
      return startPlayback(false, PLAY_TIMEOUT_MS).then(
        () => true,
        () => false,
      );
    },

    stop() {
      if (destroyed) return;
      // a play() that never reached PLAYING (given up for its preview at the transition) leaves the
      // player half-started on the deck the preview then plays on: stopVideo() clears it as well
      const startAbandoned = !!playOp;
      cancelPlay('stopped');
      const abandoned = !!cueOp;
      // a deck in 'error' still shows YouTube's error screen ("Video unavailable"): stopVideo() clears it
      const clear = abandoned || startAbandoned || startTimedOut || state === 'error';
      startTimedOut = false;
      cancelCue('stopped');
      silenced = true; // until the next cue / play / resume: see mirror()
      silencedAt = now();
      muted = true;
      silentHold = false;
      run(() => {
        player.pauseVideo();
        player.mute();
        // A video still loading ignores the pause and starts its ad ~10 s later on its own (measured);
        // stopVideo() cancels the load. mirror() still pauses back anything that starts anyway.
        if (clear) player.stopVideo();
      });
      setAnchor(position(), false);
      if (abandoned) {
        videoId = null; // the song never got cued: nothing usable is loaded
        setState('empty');
      } else if (videoId && (state === 'playing' || state === 'ad' || state === 'cued')) {
        quiet(2);
        setState('paused');
      }
    },

    seek(s) {
      if (destroyed || !Number.isFinite(s)) return;
      const to = Math.max(0, s);
      if (cueOp) {
        cueOp.at = to;
        if (cueOp.phase === 'seek') {
          const op = cueOp;
          op.seekIssuedAt = op.seekStartedAt = now();
          op.seekTries = 0;
          run(() => player.seekTo(clampAt(to, duration), true));
        }
        return;
      }
      if (!videoId || state === 'empty' || state === 'error') return;
      const target = clampAt(to, duration);
      run(() => player.seekTo(target, true));
      setAnchor(target, state === 'playing');
      if (state === 'cued') holdAt = target;
      lastPassiveT = target;
      quiet(null, 800); // the cached time still describes the old spot for a moment: believe nothing yet
      fastUntil = now() + 800 + FAST_AFTER_MS;
      schedule();
      if (state === 'ended') setState('paused');
    },

    setVolume(v) {
      if (destroyed || typeof v !== 'number' || Number.isNaN(v)) return;
      const n = Math.round(Math.min(1, Math.max(0, v)) * 100);
      if (n === sentVolume) return;
      sentVolume = n;
      // Before onReady only the latest value matters; during an unmuted pre-roll play() sends it.
      if (ready && !silentHold) run(() => player.setVolume(n));
    },

    position,

    prime() {
      // Inside the Start tap: a muted play/pause gives iOS its "media started in a gesture". Only on a
      // deck whose player is idle — pausing a running pre-roll or song would be the opposite of harmless.
      if (destroyed || !ready || cueOp || playOp) return;
      const st = read('getPlayerState', -1);
      if (state === 'playing' || state === 'ad' || st === 1 || st === 3) return;
      const hold = videoId && (state === 'cued' || state === 'paused') ? position() : null;
      const wasMuted = muted;
      const zero = silentHold;
      primedAt = now();
      run(() => {
        player.mute();
        player.playVideo();
        player.pauseVideo();
        if (hold !== null) player.seekTo(hold, true);
        if (!wasMuted) {
          player.unMute();
          if (zero) player.setVolume(0);
        }
      });
      quiet(2, 1500);
    },

    /**
     * Inside a user gesture: a pre-roll running muted (cued before the page had a gesture, e.g. a share
     * link before its tap) goes on unmuted at volume 0, like cue(id, {unmuted: true}) — so it, and every
     * later cue on this player, also runs in a background tab. The volume stays 0 until play(). True when
     * the pre-roll is (now) unmuted at 0; false when there is no pre-roll running (a cued song needs
     * nothing: play() unmutes it) or on iOS / iPadOS (the volume is ignored there).
     */
    unlock() {
      const op = cueOp;
      if (destroyed || !op || volumeIgnored()) return false;
      if (op.unmuted) return true;
      const t0 = now();
      op.unmuted = true;
      op.unmutedAt = t0;
      op.fellBack = '';
      silentHold = true;
      enforcedAt = t0 + ENFORCE_AFTER_MS - ENFORCE_MS;
      // (a load still queued behind onReady sends it itself)
      if (op.phase !== 'start') {
        run(() => {
          if (cueOp !== op || !op.unmuted) return;
          muted = false;
          sendUnmutedSilent();
        });
      }
      return true;
    },

    destroy() {
      if (destroyed) return;
      cancelCue('the deck was destroyed');
      cancelPlay('the deck was destroyed');
      destroyed = true;
      if (timer) T.clearTimeout(timer);
      timer = null;
      queue.length = 0;
      try {
        if (player && typeof player.destroy === 'function') player.destroy();
      } catch {
        /* already torn down */
      }
      for (const el of [frame, mount]) if (el && el.parentNode) el.parentNode.removeChild(el);
      frame = null;
      player = null;
      ready = false;
    },

    debug() {
      return {
        state,
        videoId,
        ready,
        destroyed,
        playerState: read('getPlayerState', null),
        currentTime: read('getCurrentTime', null),
        position: position(),
        duration,
        adSeconds,
        error,
        sentVolume,
        playerVolume: read('getVolume', null),
        playerMuted: read('isMuted', null),
        muted,
        silentHold,
        unmutedPreroll: cueOp ? cueOp.unmuted : null,
        fellBack: cueOp ? cueOp.fellBack : lastFellBack,
        playerVideoId: (read('getVideoData', null) || {}).video_id ?? null,
        queued: queue.length,
        timer: timer !== null,
        pending: { cue: cueOp ? cueOp.phase : null, play: !!playOp },
        cueDrift,
        holdAt,
        silenced,
        heldBack,
        captionsOffFor,
      };
    },
  };

  function startPlayback(/** @type {boolean} */ unmute, /** @type {number} */ timeoutMs) {
    cancelPlay('replaced by a newer play');
    startTimedOut = false;
    const t0 = now();
    return new Promise((resolve, reject) => {
      /** @type {PlayOp} */
      const op = {
        prev: state === 'ended' ? 'paused' : state,
        unmute,
        startedAt: t0,
        deadline: t0 + Math.max(1000, timeoutMs),
        adMs: 0,
        lastWall: t0,
        lastT: position(),
        playingSince: 0,
        resolve,
        reject,
      };
      playOp = op;
      silenced = false;
      if (unmute) muted = false;
      // A song cued unmuted waits at volume 0: this is where it gets its volume (unMute() first — YouTube
      // may restore volume 5 when it unmutes a player at 0 — then the volume asked for, then play).
      const v = sentVolume >= 0 ? sentVolume : silentHold ? 100 : -1;
      silentHold = false;
      run(() => {
        if (playOp !== op) return;
        if (unmute) player.unMute();
        if (v >= 0) player.setVolume(v);
        player.playVideo();
      });
      schedule();
    });
  }

  return api;
}

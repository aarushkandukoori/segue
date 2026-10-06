// Segue bootstrap: wires the view (dumb, state-driven) to the set that is playing and owns everything
// that belongs to the page rather than to the mix — screens, the address bar, sharing, recording
// downloads, Media Session, stored preferences and the per-frame paint loop.
//
// Two conductors (SPEC.md §6.3), one of them `active` (the one the view shows):
//   conductor  js/dj/conductor.js — 30-second previews (Preview) and your own files, mixed in Web Audio
//   fullset    js/dj/fullset.js   — full songs (Short / Medium / Full) for Spotify, Deezer and pasted
//              lists, played in YouTube's embedded player: two players in the view's video slots
// Switching between Preview and a full-song length mid-set hands over between the two without a gap:
// the old one plays on until the new one has its first song sounding, then a short crossfade.

import { createView } from './ui/view.js';
import { DEMOS, EXAMPLES, SourceError, applyTags, createResolver, loadPlaylist, parseInput, playlistFromFiles } from './sources/index.js';
import { sharedYouTubeFinder } from './sources/youtube.js';
import { createAnalyzer } from './analysis/client.js';
import { createEngine, sanitizeBufferAsync } from './dj/engine.js';
import { createRecorder, extensionFor } from './dj/recorder.js';
import { createConductor, decodeAudio, deckFrameAt } from './dj/conductor.js';
import { createFullSet } from './dj/fullset.js';
import { createYouTubeDeck } from './dj/ytdeck.js';
import { randomSeed } from './util/rng.js';
import { createTimers } from './util/timers.js';

/** Slider at 100 % = engine volume 1.25: the engine keeps headroom for two tracks, measured safe to 1.5. */
const VOLUME_SCALE = 1.25;
const PREFS_KEY = 'segue:prefs';
/** Every track length; 'preview' = 30-second clips (streaming playlists only). */
const MODES = ['preview', 'short', 'medium', 'full'];
const FULL = ['short', 'medium', 'full'];
/** Preview ↔ full songs: the crossfade once the incoming side is sounding. */
const XFADE_MS = 3000;

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const isAbort = (err) => !!err && err.name === 'AbortError';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Fire-and-forget for transport calls: a context that refuses to suspend / resume must not surface as an unhandled rejection. */
const quiet = (promise) => Promise.resolve(promise).catch((err) => console.warn('[segue] transport', err));

// ── preferences (localStorage may be unavailable: private mode, blocked storage) ─────────────────
function readPrefs() {
  const prefs = { volume: 0.9, vibe: 0.5, mode: 'medium' };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (Number.isFinite(saved.volume)) prefs.volume = clamp01(saved.volume);
      if (Number.isFinite(saved.vibe)) prefs.vibe = clamp01(saved.vibe);
      if (MODES.includes(saved.mode)) prefs.mode = saved.mode;
    }
  } catch {
    /* defaults */
  }
  return prefs;
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* not persisted, still works */
  }
}
const prefs = readPrefs();

// ── singletons ───────────────────────────────────────────────────────────────────────────────────
const engine = createEngine();
/** The full-song set's own Web Audio engine: risers / impacts over the videos, and a preview that stands in for a video that will not play. Its own clock and context, so the two sets can overlap in a hand-over. */
const videoEngine = createEngine();
const analyzer = createAnalyzer();
const resolver = createResolver();
const finder = sharedYouTubeFinder();

let unlocked = false;
/** @type {BaseAudioContext|null} */
let quietCtx = null;

/**
 * Decode for the conductors. Before the first tap there is no AudioContext we are allowed to start
 * (a share link prepares its opener while the "Start the set" button is showing), so those decodes
 * go through an OfflineAudioContext; the buffers play in the real context all the same.
 */
function decode(bytes) {
  return decodeRaw(bytes).then(checked);
}
function decodeRaw(bytes) {
  if (unlocked) return decodeAudio(engine.ctx, bytes);
  if (!quietCtx) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return decodeAudio(engine.ctx, bytes);
    quietCtx = new Offline(2, 2, 48000);
  }
  return decodeAudio(quietCtx, bytes);
}
/**
 * The engine refuses to let a NaN / Infinity sample into its graph and checks every buffer before it
 * plays; done here, in slices, right after decoding, that check never lands in one piece on the frame
 * a full-length file starts on (a 6-minute file is ~35 million samples).
 */
async function checked(buffer) {
  try {
    await sanitizeBufferAsync(buffer);
    metrics.buffersChecked++;
  } catch (err) {
    console.warn('[segue] could not check a decoded file', err); // addPlay() checks it again itself
  }
  return buffer;
}

const conductor = createConductor({ engine, analyzer, resolver, decode });

/** The two YouTube decks: created once, inside the view's video slots, the first time a full-song set needs them. */
let ytDecks = null;
/** iOS (iPadOS reports itself as a Mac with touch): its YouTube player ignores setVolume — mute / unmute only. */
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/**
 * The full-song set's clock: its 20 Hz ticker, the decks' polls and the hand-over ramp run on a worker's
 * timers, which Chrome does not throttle in a background tab (the page's own fired once a minute there,
 * measured 2026-10-06: hand-overs up to a minute late, songs replaced by their previews). Falls back to the
 * page's timers where no worker starts.
 */
const timers = createTimers();
const fullset = createFullSet({ engine: videoEngine, finder, decks: () => ytDecks, resolver, analyzer, decode, volumeWorks: !IOS, timers });

/** @type {any} the set the view shows (conductor or fullset) */
let active = conductor;

// ── page state ───────────────────────────────────────────────────────────────────────────────────
let screen = 'landing';
/** @type {any} Playlist being played / prepared */
let playlist = null;
let loadToken = 0;
/** @type {AbortController|null} */
let loadAbort = null;
let gestureAt = 0;
let recorder = null;
let recordingSeed = '';
let stallNoted = false;
/** performance.now() of a history.back() of our own (the logo): its popstate has nothing left to do. */
let ownBackAt = -1e9;
const shown = { decks: ['', ''], transition: '', media: '', title: document.title, /** @type {boolean|null} */ canSkip: null };
const baseTitle = document.title;
const metrics = { firstSoundMs: null, loads: 0, buffersChecked: 0, handoffs: [] };
/** A hand-over between the two conductors in progress: {token, to, target, cancel?} */
let handoff = null;
let handoffSeq = 0;

const isVideo = () => active === fullset;
/** Which conductor plays `pl` at track length `mode`. */
const conductorFor = (pl, mode) => (pl && pl.source !== 'local' && FULL.includes(mode) ? fullset : conductor);
/** The track length the active set plays. */
const modeNow = () => (active === fullset ? fullset.mode : playlist && playlist.source === 'local' ? conductor.snapshot().mode : 'preview');

// ── view ─────────────────────────────────────────────────────────────────────────────────────────
const view = createView(document.getElementById('app'), {
  onSubmit(text) {
    gesture(false, prefs.mode !== 'preview');
    openInput(text, { autostart: true });
  },
  onDemo(id) {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    gesture(false, prefs.mode !== 'preview');
    openInput(demo.input, { autostart: true });
  },
  onFiles(files) {
    gesture();
    openFiles(files);
  },
  onStart() {
    gesture(true, isVideo());
    if (!playlist) return goHome();
    active.begin();
    if (isVideo()) {
      show('stage');
      return;
    }
    if (conductor.started) {
      // Cued and waiting for this tap (the browser would not start the audio without one).
      quiet(conductor.resume());
      show('stage');
      return;
    }
    // Usually the opener is already cued and the stage appears at once; only a slow one shows progress.
    const token = loadToken;
    setTimeout(() => {
      if (token === loadToken && screen === 'ready' && !conductor.started) show('loading');
    }, 300);
  },
  onPlayPause() {
    if (handoff) {
      // Pause during a switch: what is audible pauses, and the switch is called off (pick the length again to retry)
      const from = handoff.from;
      cancelHandoff();
      gesture(true, from === fullset);
      if (from.paused) quiet(from.resume());
      else quiet(from.pause());
      syncTransport();
      sync();
      return;
    }
    if (isVideo()) {
      gesture(true, true);
      if (!fullset.started || fullset.needsTap) {
        // a full-song set waits for this tap (a share link, or a browser that wanted one for sound)
        if (fullset.started) quiet(fullset.resume());
        else fullset.begin();
        return;
      }
      if (fullset.paused) quiet(fullset.resume());
      else quiet(fullset.pause());
      return;
    }
    if (!conductor.started) return gesture();
    // Decide from what is true before this tap changes it: gesture() below may wake a context the
    // browser had stopped, and a set that was silent must come back as "playing", not flip to paused.
    const halted = conductor.paused || !audioRunning();
    gesture();
    if (halted) quiet(conductor.resume());
    else quiet(conductor.pause());
  },
  onSkip() {
    active.skip();
  },
  onNewSet() {
    if (!playlist) return gesture();
    cancelHandoff();
    active.newSet(); // first: a set the user had paused is over, so this tap may wake the audio again
    gesture(false, isVideo());
    resetShown();
    syncUrl();
    view.toast(`New set #${active.seed} — same crate, different mix`, 'success');
    sync();
    if (isVideo()) return; // the stage says what the new opener waits for (ticker: "Starting the set")
    // Normally the new opener is in hand and plays within a moment. When it is not (the connection
    // dropped), a silent stage explains nothing: go back to the loading screen, which says what the
    // set is waiting for and offers Cancel.
    const token = loadToken;
    const seed = conductor.seed;
    setTimeout(() => {
      if (token !== loadToken || screen !== 'stage' || conductor.started || conductor.seed !== seed || isVideo()) return;
      show('loading');
      const st = conductor.snapshot().status;
      if (st) view.setLoading(st);
    }, 1200);
  },
  onVibe(v) {
    prefs.vibe = clamp01(v);
    conductor.setVibe(prefs.vibe);
    fullset.setVibe(prefs.vibe);
    savePrefs();
    syncUrlSoon();
  },
  /** The Track length control: the visitor's choice, kept for every later playlist (prefs.mode). */
  onMode(m) {
    changeMode(m, false);
  },
  /**
   * "Play previews instead" (the first song stuck behind its ad): this set goes on as previews, like a
   * share link's len — the visitor's stored track length is not touched, the next playlist plays full
   * songs again.
   */
  onPreviewOnce() {
    changeMode('preview', true);
  },
  onVolume(v) {
    prefs.volume = clamp01(v);
    applyVolume();
    savePrefs();
  },
  onRecordToggle() {
    toggleRecording();
  },
  onShare() {
    share();
  },
  onHome() {
    goHome();
  },
});

// The file picker: the tap that opens it is the last user gesture before the files arrive — in Safari
// the 'change' event that delivers them no longer counts as one, and an AudioContext first touched
// there stays suspended. Unlock on that tap (it reaches the input from its label and from the
// keyboard alike); the context then runs through the picker and the set can start by itself.
{
  const picker = document.getElementById('segue-files');
  if (picker) picker.addEventListener('click', () => gesture());
}

/**
 * Change the track length of the set on screen (Preview ↔ full songs hands over between the conductors).
 * @param {string} m
 * @param {boolean} once  for this set only: the visitor's stored default (prefs.mode) stays as it was
 */
function changeMode(m, once) {
  if (!MODES.includes(m)) return;
  const local = !!playlist && playlist.source === 'local';
  if (local && m === 'preview') {
    // "Preview" only describes 30-second clips; your own files always play full length.
    view.setTransport({ mode: conductor.snapshot().mode });
    return;
  }
  if (!once) {
    prefs.mode = m;
    savePrefs();
  }
  if (!playlist) return;
  if (local) {
    conductor.setMode(m);
    return;
  }
  const target = conductorFor(playlist, m);
  gesture(false, target === fullset);
  if (handoff && handoff.target !== target) {
    // flipped back while a switch was still on its way: what is playing simply stays
    cancelHandoff();
    syncTransport();
  }
  if ((handoff && handoff.target === target) || target === active) {
    if (target === fullset) fullset.setMode(m);
    syncTransport();
    syncUrlSoon();
    return;
  }
  switchSet(target, m);
}

function show(name) {
  screen = name;
  view.setScreen(name);
}

/** Volume to both sets (only the active one is heard; a hand-over ramps them against each other). */
function applyVolume(kConductor = 1, kFull = 1) {
  conductor.setVolume(prefs.volume * VOLUME_SCALE * kConductor);
  fullset.setVolume(prefs.volume * kFull);
}

/**
 * Everything that needs a user gesture: creating / resuming the AudioContext (and iOS's silent element);
 * for full songs also the second engine and a muted play/pause of the idle YouTube players (iOS media
 * unlock). Not while the user has the set paused: a tap on Rec, Share or the setlist must not start the
 * sound again behind a button that says Play — Play itself resumes through the conductor.
 * @param {boolean} [force] the tap asks for sound whatever the state ("Start the set", Play)
 * @param {boolean} [video] full songs are (or are about to be) playing
 */
function gesture(force = false, video = false) {
  gestureAt = performance.now();
  if (!force && active.started && active.pausedByUser) return;
  try {
    engine.unlock();
    unlocked = true;
    if (video || isVideo()) videoEngine.unlock();
  } catch (err) {
    console.warn('[segue] audio unavailable', err);
    view.toast('This browser cannot play Web Audio, so Segue cannot mix here.', 'error');
  }
  // (only before the set sounds: iOS wants media started inside a tap once; later a prime would only
  // delay a resume — the deck ignores its own priming noise for 0.7 s.) Only while the video stage is
  // showing, and only a player with no video in it: a prime is a play + pause sent back to back, and
  // a player that holds a video (the last set's song, an abandoned ad) loses the pause while it
  // buffers and plays on — muted, but inside a hidden stage on the start screen (review 2).
  if ((video || isVideo()) && ytDecks && !fullset.started && screen === 'stage' && isVideo()) {
    for (const d of ytDecks) if (d.state === 'empty') d.prime();
  }
}

// Browsers stop an AudioContext on their own (a phone call, another app taking the audio session,
// iOS's "interrupted") and sometimes bring it back on their own. The engine reports every such change
// ('statechange', also the ones a browser makes without an event) and the conductor listens to it
// itself, so the transport always shows what is true; nothing to wire here.

/** Is the context producing sound? (engine.state never creates a context just to answer.) */
function audioRunning() {
  return engine.state === 'running'; // never compare with 'suspended': iOS also has 'interrupted'
}

function resetShown() {
  shown.decks[0] = shown.decks[1] = '';
  shown.transition = '';
  view.setDeck(0, null);
  view.setDeck(1, null);
  view.setTransition(null);
}

// ── the two stages ───────────────────────────────────────────────────────────────────────────────

/** The YouTube decks, created once inside the view's slots (the stage must be showing in video mode). */
function ensureDecks() {
  if (ytDecks) return ytDecks;
  // (a deck reports its state from inside its own calls: the set looks at it right after, not in the middle)
  ytDecks = [0, 1].map((i) => createYouTubeDeck(view.videoSlot(i), { timers, onChange: () => queueMicrotask(() => fullset.poke()) }));
  return ytDecks;
}

/** Video stage: players visible, waveforms hidden. Only while the stage screen shows (YouTube's terms). */
function videoStage() {
  view.setStageMode('video');
  ensureDecks();
}

/** Waveform stage: only once the players are silent and paused (a hidden slot must never play). */
function wavesStage() {
  if (ytDecks) for (const d of ytDecks) d.stop();
  view.setStageMode('waves');
}

/** The transport for the set that is showing: REC off for full songs, with the reason. */
function stageTransport() {
  const s = active.snapshot();
  return { recordEnabled: s.recordEnabled !== false, recordWhy: s.recordWhy || '', modeEnabled: true };
}

// ── loading a playlist ───────────────────────────────────────────────────────────────────────────

function cancelLoad() {
  loadToken++;
  if (loadAbort) loadAbort.abort();
  loadAbort = null;
}

function fail(err) {
  // SourceError messages are written for people; anything else is a bug worth seeing in the console.
  const friendly = err instanceof SourceError;
  if (!friendly) console.error('[segue] load failed', err);
  goHome();
  // Under the control the load was started from (and it stays there); a toast when there is none.
  view.inputError(friendly ? err.message : 'Something went wrong while loading that. Please try again.');
}

function stopAll() {
  cancelHandoff();
  conductor.stop();
  fullset.stop();
  // the players themselves, whatever the set's state (fullset.stop() does nothing once it holds no
  // playlist, and a player must never play behind the start or loading screen)
  if (ytDecks) for (const d of ytDecks) d.stop();
}

async function openInput(input, opts) {
  cancelLoad();
  const token = loadToken;
  stopAll();
  playlist = null;
  show('loading');
  view.setLoading({ title: 'Reading the playlist', detail: 'One moment…', progress: null });
  const ctrl = new AbortController();
  loadAbort = ctrl;
  try {
    const pl = await loadPlaylist(input, {
      signal: ctrl.signal,
      onStatus: (msg) => {
        if (token === loadToken) view.setLoading({ title: 'Reading the playlist', detail: msg, progress: null });
      },
    });
    if (token !== loadToken) return;
    startPlaylist(pl, opts);
  } catch (err) {
    if (token !== loadToken || isAbort(err)) return;
    fail(err);
  }
}

async function openFiles(files) {
  cancelLoad();
  const token = loadToken;
  stopAll();
  playlist = null;
  const pl = playlistFromFiles(files);
  if (!pl.tracks.length) {
    view.toast('Those don’t look like audio files — try MP3, M4A, WAV or FLAC.', 'error');
    return;
  }
  show('loading');
  view.setLoading({ title: 'Reading your files', detail: `${pl.tracks.length} ${pl.tracks.length === 1 ? 'file' : 'files'} — nothing leaves this device`, progress: null });
  // Real titles from the tags when they are quick to read; file names otherwise.
  await Promise.race([applyTags(pl), sleep(1200)]);
  if (token !== loadToken) return;
  startPlaylist(pl, { autostart: true });
}

/**
 * @param {any} pl Playlist
 * @param {{autostart?: boolean, seed?: string, vibe?: number, mode?: string, fromLink?: boolean}} [opts]
 *   fromLink: the set comes from the address bar (a share link, or Back / Forward to one): seed, vibe
 *   and track length are the link's, and the history entry is the one we are on.
 */
function startPlaylist(pl, opts = {}) {
  playlist = pl;
  metrics.loads++;
  metrics.firstSoundMs = null;
  stallNoted = false;
  view.setPlaylist({ title: pl.title, subtitle: pl.subtitle, artwork: pl.artwork, link: pl.link, count: pl.tracks.length, source: pl.source });
  resetShown();
  view.setSetlist([]);
  applyVolume();
  // The set's vibe and length: the link's when it came from one (the visitor's own stored preferences
  // would build a different set than the sender heard), otherwise the visitor's.
  const vibe = opts.fromLink && Number.isFinite(opts.vibe) ? opts.vibe : prefs.vibe;
  const mode = opts.fromLink && MODES.includes(opts.mode) ? opts.mode : prefs.mode;
  const seed = opts.seed || randomSeed();
  active = conductorFor(pl, mode);
  if (active === fullset) {
    // Full songs: straight to the stage — the first song's pre-roll ad runs in deck A in plain view
    // (muted, no gesture needed) while the page waits for a tap or for the ad to end.
    show('stage');
    videoStage();
    fullset.load(pl, { seed, vibe, mode, autostart: !!opts.autostart, patient: !!opts.fromLink && !!opts.seed });
    if (!fullset.snapshot().loaded) return;
  } else {
    wavesStage();
    conductor.load(pl, { seed, vibe, mode: mode === 'preview' ? 'medium' : mode, autostart: !!opts.autostart, patient: !!opts.fromLink && !!opts.seed });
    if (!conductor.snapshot().loaded) return; // the conductor refused it (empty) and already reported why
  }
  enterSet(!!opts.fromLink);
  syncTransport();
  if (pl.total > pl.tracks.length) {
    const where = pl.source === 'spotify' && pl.tracks.length <= 100 ? ' — Spotify only shares the first 100 with web pages' : '';
    view.toast(`Mixing the first ${pl.tracks.length} of ${pl.total} tracks${where}.`, 'info');
  }
  if (active === fullset) {
    sync();
    return;
  }
  if (opts.autostart) {
    view.setLoading({ title: 'Digging through the crate', detail: 'Lining up the first tracks…', progress: 0 });
  } else {
    show('ready');
  }
}

/**
 * Back to the start screen: stop the set (a running recording is saved), then put the address bar and
 * the history right. @param {{fromHistory?: boolean}} [opts] fromHistory: the browser already moved
 * (Back / Forward) — only the page has to follow.
 */
function goHome(opts = {}) {
  cancelLoad();
  if (recorder && recorder.recording) finishRecording();
  stopAll();
  wavesStage();
  active = conductor;
  playlist = null;
  resetShown();
  view.setSetlist([]);
  shown.canSkip = false;
  view.setTransport({ playing: false, canSkip: false, recordEnabled: true, recordWhy: '' });
  setMedia(null);
  document.title = baseTitle;
  show('landing');
  if (opts.fromHistory) return;
  if (historyState().pushed) {
    // The set has a history entry of its own on top of the start screen's: step back onto that one,
    // so Forward still leads to the set and Back does not pass through a second start screen.
    try {
      ownBackAt = performance.now();
      history.back();
      return;
    } catch {
      ownBackAt = -1e9;
    }
  }
  try {
    const base = `${location.origin}${location.pathname}`;
    if (base !== location.href || history.state) history.replaceState(null, '', base);
  } catch {
    /* file:// or a sandbox without history access */
  }
}

// ── Preview ↔ full songs: hand-over between the two conductors ──────────────────────────────────

function cancelHandoff() {
  if (!handoff) return;
  const h = handoff;
  handoff = null;
  if (h.cancel) h.cancel();
  // the side that was being readied is dropped; the one playing stays as it is (and is shown again)
  h.target.stop();
  if (active !== h.from) {
    active = h.from;
    resetShown();
    if (h.from === conductor) wavesStage();
    else videoStage();
  }
  applyVolume();
}

/** A volume ramp on a wall-clock timer (≈ 20 steps a second, the worker clock): fn(p) for p 0 → 1, then done(). */
function ramp(ms, fn, done) {
  const t0 = performance.now();
  const id = timers.setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / ms);
    fn(p);
    if (p >= 1) {
      timers.clearInterval(id);
      if (done) done();
    }
  }, 50);
  fn(0);
  return () => timers.clearInterval(id);
}

/**
 * Change engines mid-set. The set that is playing keeps playing until the other one has its first
 * track sounding (full songs: after the first song's ad), then they crossfade (Web Audio master volume
 * against the YouTube decks' volume). With nothing playing yet it is a plain swap.
 */
function switchSet(target, mode) {
  cancelHandoff();
  const from = active;
  const seed = from.seed || randomSeed();
  const vibe = from.vibe;
  // the set so far goes on in the other conductor: what it played is not played again, Elapsed goes on
  const carry = carryFrom(from);
  if (recorder && recorder.recording && target === fullset) finishRecording();
  if (!from.started || from.paused) {
    from.stop();
    active = target;
    resetShown();
    if (target === fullset) {
      show('stage');
      videoStage();
      fullset.load(playlist, { seed, vibe, mode, autostart: true, carry });
    } else {
      wavesStage();
      conductor.load(playlist, { seed, vibe, mode: 'medium', autostart: true, carry });
      show('loading');
      view.setLoading({ title: 'Switching to previews', detail: 'Lining up the first clips…', progress: 0 });
    }
    syncTransport();
    syncUrl();
    sync();
    return;
  }
  const token = ++handoffSeq;
  const h = { token, target, from, at: performance.now(), cancel: null };
  handoff = h;
  if (target === fullset) {
    // The previews play on under the video stage; the first song starts silent and fades in over them.
    active = fullset;
    resetShown();
    show('stage');
    videoStage();
    applyVolume(1, 0);
    fullset.load(playlist, { seed, vibe, mode, autostart: true, carry });
    view.toast('Switching to full songs — the previews play on until the first song is ready.', 'info');
  } else {
    // The videos play on (the video stage stays up while they sound); the previews start silent.
    applyVolume(0, 1);
    conductor.load(playlist, { seed, vibe, mode: 'medium', autostart: true, carry });
    view.toast('Switching to 30-second previews…', 'info');
  }
  syncTransport();
  syncUrl();
  sync();
}

/**
 * What a set hands to the conductor that takes over from it: the track ids it has played or has on air
 * (setlist rows, oldest first; both conductors key them `${trackId}|${round}`) and its Elapsed, read at
 * `at` (performance.now(), the conductors' clock). `live`: it plays on until the new set sounds (a
 * hand-over, not a swap), so the new set's Elapsed runs on through that wait. Before its first sound
 * there is nothing to carry.
 * @returns {{played: string[], elapsed: number, at: number, live: boolean}}
 */
function carryFrom(set) {
  const s = set.snapshot();
  const at = performance.now();
  if (!s.loaded || !s.started) return { played: [], elapsed: 0, at, live: false };
  const played = [];
  for (const r of s.setlist || []) {
    if (r.state !== 'played' && r.state !== 'playing' && r.state !== 'mixing') continue;
    const id = String(r.key).slice(0, String(r.key).lastIndexOf('|'));
    if (id && !played.includes(id)) played.push(id);
  }
  const elapsed = Number.isFinite(s.elapsed) ? s.elapsed : s.now; // (its own carried time included)
  return { played, elapsed: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0, at, live: !set.paused };
}

/** The incoming side of a hand-over has started: crossfade, then retire the old side. */
function completeHandoff(source) {
  const h = handoff;
  if (!h || h.target !== source) return false;
  const from = h.from;
  const t0 = performance.now();
  h.cancel = ramp(
    XFADE_MS,
    (p) => (h.target === fullset ? applyVolume(1 - p, p) : applyVolume(p, 1 - p)),
    () => {
      if (handoff !== h) return;
      handoff = null;
      from.stop();
      if (h.target === conductor) {
        if (recorder && recorder.recording) finishRecording();
        active = conductor;
        resetShown();
        wavesStage();
        if (screen !== 'stage') show('stage');
      }
      applyVolume();
      metrics.handoffs.push({ to: h.target === fullset ? 'video' : 'preview', waitMs: Math.round(t0 - h.at), at: Date.now() });
      syncTransport();
      syncUrl();
      sync();
    },
  );
  return true;
}

// ── conductors → view ────────────────────────────────────────────────────────────────────────────

conductor.on('status', (s) => {
  if (active === conductor && screen === 'loading' && s) view.setLoading(s);
});
fullset.on('status', (s) => {
  if (active === fullset && screen === 'loading' && s) view.setLoading(s);
});

conductor.on('start', () => {
  if (handoff && handoff.target === conductor) {
    if (!conductor.paused) completeHandoff(conductor);
    return;
  }
  if (active !== conductor) return;
  if (conductor.paused) {
    // The opener is cued but the browser would not start the audio without a tap (Safari once its
    // file picker has closed, any browser after a drop, a tab that never had a gesture): offer the
    // one tap instead of a stage that claims to be playing. The set waits at 0:00.
    if (screen === 'loading') show('ready');
    sync();
    return;
  }
  noteFirstSound();
  if (screen === 'loading' || screen === 'ready') show('stage');
  sync();
});

fullset.on('start', () => {
  if (handoff && handoff.target === fullset) completeHandoff(fullset);
  if (active !== fullset) return;
  noteFirstSound();
  if (screen !== 'stage') show('stage');
  sync();
});

function noteFirstSound() {
  if (metrics.firstSoundMs == null && gestureAt) {
    // 150 ms is the Web Audio engine's start lead-in; a YouTube deck reports PLAYING when it sounds.
    metrics.firstSoundMs = Math.round(performance.now() - gestureAt + (isVideo() ? 0 : 150));
  }
}

conductor.on('error', ({ message }) => {
  if (handoff && handoff.target === conductor) {
    cancelHandoff();
    view.toast(`Couldn’t switch to previews: ${message}`, 'error');
    syncTransport();
    sync();
    return;
  }
  if (active !== conductor) return;
  goHome();
  view.inputError(message);
});

fullset.on('error', ({ message }) => {
  if (handoff && handoff.target === fullset) {
    cancelHandoff(); // the previews never stopped
    view.toast(message, 'error');
    syncTransport();
    sync();
    return;
  }
  if (active !== fullset) return;
  goHome();
  view.inputError(message);
});

// YouTube does not work here at all (the player is blocked, its search unreachable, every video refused
// on this address): the set goes on as 30-second previews and says why, once.
fullset.on('unavailable', ({ message }) => {
  if (!playlist || (active !== fullset && !(handoff && handoff.target === fullset))) return;
  view.toast(message, 'error');
  metrics.unavailable = message;
  if (handoff && handoff.target === fullset) {
    cancelHandoff(); // the previews never stopped: just drop the full-song side
    syncTransport();
    syncUrl();
    sync();
    return;
  }
  switchSet(conductor, 'preview');
  view.setTransport({ mode: 'preview' });
});

fullset.on('notice', ({ message, kind }) => {
  if (active === fullset) view.toast(message, kind || 'info');
});

conductor.on('change', () => {
  // a hand-over into previews whose opener was cued while the audio could not run: it goes on once it can
  if (handoff && handoff.target === conductor && !handoff.cancel && conductor.started && !conductor.paused) completeHandoff(conductor);
  if (active === conductor) sync();
});
fullset.on('change', () => {
  if (active === fullset) sync();
});

function syncTransport() {
  const s = active.snapshot();
  shown.canSkip = s.canSkip;
  view.setTransport({
    playing: playingNow(s),
    canSkip: s.canSkip,
    recording: !!(recorder && recorder.recording),
    seed: s.seed,
    vibe: s.vibe,
    mode: handoff ? (handoff.target === fullset ? fullset.mode : 'preview') : s.mode,
    volume: prefs.volume,
    ...stageTransport(),
  });
}

/** What the Play button shows: the set on screen — or, while a switch is on its way, the one still playing. */
function playingNow(s) {
  if (handoff && !s.started) return !handoff.from.paused;
  return s.started ? s.playing : screen === 'stage' && !isVideo();
}

/** While full songs are being readied the previews play on: the ticker says that, not "waiting for an ad". */
function handoffView(tv) {
  if (!tv || !handoff || handoff.target !== fullset || tv.state !== 'starting') return tv;
  return { ...tv, label: 'Switching to full songs', why: 'The previews play on until the first song’s YouTube ad is over (muted, in deck A) — then they crossfade into it.' };
}

function deckSig(s, info) {
  if (!info) return '';
  return isVideo() ? `${s.seed}:${info.playId}:${info.provider}:${info.status}:${info.statusText || ''}:${Math.round(info.duration)}` : `${s.seed}:${info.playId}`;
}

function sync() {
  const s = active.snapshot();
  if (!s.loaded) return;
  // A set that was waiting for its audio (see 'start') and got it without the button — the browser
  // let the context run after all — belongs on the stage.
  if (s.playing && (screen === 'ready' || screen === 'loading')) show('stage');
  for (let d = 0; d < 2; d++) {
    const info = s.decks[d];
    const id = deckSig(s, info);
    if (id !== shown.decks[d]) {
      shown.decks[d] = id;
      view.setDeck(d, info);
    }
  }
  const tv = handoffView(s.transition);
  const tsig = tv ? `${s.seed}|${tv.state}|${tv.type}|${tv.label}|${tv.tStart}|${tv.toTitle}|${tv.trick ? `${tv.trick.label}@${tv.trick.tStart}` : ''}|${tv.why}` : '';
  if (tsig !== shown.transition) {
    shown.transition = tsig;
    view.setTransition(tv);
  }
  // Second argument: how many different tracks the crate can play (the list itself also holds replays).
  view.setSetlist(s.setlist, { crate: s.stats.total - s.stats.failed });
  shown.canSkip = s.canSkip;
  view.setTransport({
    playing: playingNow(s),
    canSkip: s.canSkip,
    seed: s.seed,
    vibe: s.vibe,
    mode: handoff ? (handoff.target === fullset ? fullset.mode : 'preview') : s.mode,
    ...stageTransport(),
  });
  setMedia(s.started ? s : null);

  // The crate ran dry (network gone, or nothing else playable yet): the ticker carries the state for
  // as long as it lasts (snapshot.transition, state 'waiting'); a toast says it once as well.
  if (s.stalled) {
    if (!stallNoted) {
      stallNoted = true;
      const offline = s.stalled === 'network' || navigator.onLine === false;
      view.toast(
        s.buffering
          ? 'The song stopped loading — it picks up where it left off as soon as the connection is back.'
          : offline
            ? 'Lost the connection — the set picks up as soon as the next track can load.'
            : 'Waiting for the next track — the set picks up as soon as it loads.',
        'info',
      );
    }
  } else if (s.decks[0] || s.decks[1]) stallNoted = false;
}

// ── per-frame paint (no allocation: one FrameState, mutated in place) ────────────────────────────

const mkDeck = () => ({ pos: 0, rate: 1, bpmNow: 0, gain: 0, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0, startsIn: 0 });
const deckFrames = [mkDeck(), mkDeck()];
const frameState = { t: 0, playing: false, elapsed: 0, /** @type {[any, any]} */ decks: [null, null], crossfade: 0, beatPhase: 0, /** @type {any} */ levels: null };
const beatCursor = [0, 0];

/** Phase 0..1 inside the beat that contains buffer position `pos` (cursor walks, never searches from 0). */
function beatPhaseAt(beats, pos, d) {
  const n = beats.length;
  if (n < 2) return 0;
  let i = beatCursor[d];
  if (i > n - 2) i = n - 2;
  if (i < 0) i = 0;
  while (i < n - 2 && beats[i + 1] <= pos) i++;
  while (i > 0 && beats[i] > pos) i--;
  beatCursor[d] = i;
  const ph = (pos - beats[i]) / (beats[i + 1] - beats[i]);
  return ph - Math.floor(ph);
}

function frame() {
  requestAnimationFrame(frame);
  if (screen !== 'stage') return;
  const f = frameState;
  if (isVideo()) {
    fullset.frame(fullset.now(), f);
    view.frame(f);
    const can = fullset.started && fullset.canSkip();
    if (can !== shown.canSkip) {
      shown.canSkip = can;
      view.setTransport({ canSkip: can });
    }
    return;
  }
  const started = conductor.started;
  const t = started ? engine.uiTime() : 0;
  f.t = t;
  f.playing = started && !conductor.paused;
  f.elapsed = conductor.elapsedAt ? conductor.elapsedAt(t) : t > 0 ? t : 0; // (+ time carried over from full songs)
  let g0 = 0;
  let g1 = 0;
  let lead = -1;
  let leadAud = 0;
  for (let d = 0; d < 2; d++) {
    const rec = started ? conductor.live.decks[d] : null;
    if (!rec) {
      f.decks[d] = null;
      continue;
    }
    const df = deckFrames[d];
    // (a deck that is cued or has stopped reports fader 0: the mixer shows what can be heard; a cued
    // one also says how long until it starts, which parks its waveform in the lane with a countdown)
    deckFrameAt(df, rec.play, rec.entry.analysis, t);
    f.decks[d] = df;
    if (d === 0) g0 = df.gain;
    else g1 = df.gain;
    if (df.audible > leadAud) {
      leadAud = df.audible;
      lead = d;
    }
  }
  if (g0 + g1 > 0.001) f.crossfade = (g1 - g0) / (g0 + g1);
  f.beatPhase = lead >= 0 ? beatPhaseAt(conductor.live.decks[lead].entry.analysis.beats, deckFrames[lead].pos, lead) : 0;
  f.levels = engine.levels();
  view.frame(f);
  // Skip opens and closes on the audio clock (a solo begins, a trick ends), between two ticks of the
  // conductor: follow it here, so the button is never enabled later — or longer — than Skip works.
  const can = started && conductor.canSkip();
  if (can !== shown.canSkip) {
    shown.canSkip = can;
    view.setTransport({ canSkip: can });
  }
}

// ── address bar: always a link to this exact set ─────────────────────────────────────────────────

const shareable = () => !!playlist && (playlist.source === 'spotify' || playlist.source === 'deezer') && /^[a-z]+(?::[A-Za-z0-9]+)+$/.test(playlist.id);

function currentUrl() {
  const base = `${location.origin}${location.pathname}`;
  const set = handoff ? handoff.target : active;
  if (!shareable() || !set.seed) return base;
  // Always with the vibe and the track length the set is using: a link without them would be rebuilt
  // with whatever the recipient last left their own controls at — a different set.
  const vibe = Math.round(set.vibe * 100) / 100;
  const len = set === fullset ? fullset.mode : 'preview';
  return `${base}?p=${playlist.id}&seed=${encodeURIComponent(set.seed)}&vibe=${vibe}&len=${len}`;
}

/** Seed / vibe changed: the entry we are on describes the set as it is now (never a new entry — a Vibe drag must not fill the history). */
function syncUrl() {
  try {
    const url = currentUrl();
    if (url !== location.href) history.replaceState(history.state, '', url);
  } catch {
    /* file:// or a sandbox without history access: the app works without it */
  }
}

// ── history: Back leaves the set, not the site ───────────────────────────────────────────────────
//
// The start screen and the set are two history entries: starting a set from the start screen pushes
// one ({segue: 'set', pushed: true}), so Back (the phone's back button, a swipe) returns to the start
// screen instead of walking off to whatever site was open before — and Forward leads to the set
// again (a link set is rebuilt from its URL; files and pasted lists cannot be, the start screen stays).
// A share link opened directly IS its entry (pushed: false): nothing of ours lies behind it.

function historyState() {
  try {
    const st = history.state;
    return st && st.segue === 'set' ? st : {};
  } catch {
    return {};
  }
}

/** A set has been loaded: give it its history entry (or, when it came from the address bar, mark the one we are on). */
function enterSet(fromLink) {
  try {
    const here = historyState();
    const url = currentUrl();
    if (fromLink || here.segue) history.replaceState({ segue: 'set', pushed: !!here.pushed }, '', url);
    else history.pushState({ segue: 'set', pushed: true }, '', url);
  } catch {
    /* no history access: Back leaves the page, as before */
  }
}

/**
 * The set a URL describes, or null: {p, seed, vibe, len}. A link that names no vibe was made at the
 * default; one that names no track length was made before full songs existed: 30-second previews.
 */
function linkFrom(search) {
  const qs = new URLSearchParams(search);
  const p = qs.get('p');
  if (!p) return null;
  const parsed = parseInput(p);
  const seedQ = qs.get('seed') || '';
  const vibeQ = qs.get('vibe');
  const lenQ = qs.get('len');
  return {
    p,
    ok: (parsed.kind === 'spotify' || parsed.kind === 'deezer') && p.length < 200,
    seed: /^[A-Za-z0-9]{1,24}$/.test(seedQ) ? seedQ : undefined,
    vibe: vibeQ !== null && vibeQ !== '' && Number.isFinite(Number(vibeQ)) ? clamp01(Number(vibeQ)) : 0.5,
    len: MODES.includes(lenQ) ? lenQ : 'preview',
  };
}

function onPopState() {
  const link = linkFrom(location.search);
  if (performance.now() - ownBackAt < 1500) {
    // Our own step back from the logo: the page is on the start screen already — and whatever the
    // user started in the meantime must not be torn down by it.
    ownBackAt = -1e9;
    if (!(link && link.ok)) return;
  }
  if (link && link.ok) {
    if (playlist && playlist.id === link.p && active.seed === link.seed) return;
    // Forward (or Back) onto a set's entry: rebuild it; like any share link it waits for a tap.
    openInput(link.p, { autostart: false, seed: link.seed, vibe: link.vibe, mode: link.len, fromLink: true });
    return;
  }
  if (screen !== 'landing' || playlist) goHome({ fromHistory: true });
}

let urlTimer = 0;
function syncUrlSoon() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(syncUrl, 400);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function share() {
  if (!playlist) return;
  syncUrl();
  const url = currentUrl();
  const exact = shareable();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Segue', text: exact ? `“${playlist.title}”, DJ’d live — set #${active.seed}` : 'Segue — your playlist, DJ’d live', url });
      return;
    } catch (err) {
      if (isAbort(err)) return; // the user closed the share sheet
    }
  }
  const copied = await copyText(url);
  if (!exact) {
    view.toast(`${copied ? 'Link to Segue copied.' : `Link to Segue: ${url}`} Sets from your own files or a pasted list can’t be rebuilt from a link.`, 'info');
  } else if (copied) view.toast(`Link to set #${active.seed} copied`, 'success');
  else view.toast(`Copy this link: ${url}`, 'info');
}

// ── recording ────────────────────────────────────────────────────────────────────────────────────

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function finishRecording() {
  const rec = recorder;
  if (!rec) return;
  view.setTransport({ recording: false });
  const blob = await rec.stop();
  if (!blob || !blob.size) {
    view.toast('Nothing was recorded.', 'info');
    return;
  }
  const name = `segue-set-${recordingSeed || 'mix'}.${extensionFor(blob.type || rec.mimeType)}`;
  metrics.lastRecording = { name, size: blob.size, type: blob.type };
  saveBlob(blob, name);
  view.toast(`Recording saved — ${name}`, 'success');
}

function toggleRecording() {
  if (recorder && recorder.recording) {
    finishRecording();
    return;
  }
  if (isVideo()) {
    // (the view says this itself when REC is disabled; a keyboard shortcut or a race can still get here)
    view.toast(fullset.snapshot().recordWhy, 'info');
    return;
  }
  gesture();
  if (!recorder) recorder = createRecorder(engine.recordStream());
  if (!recorder.supported || !recorder.start()) {
    view.toast('This browser cannot record the mix.', 'error');
    return;
  }
  recordingSeed = conductor.seed;
  view.setTransport({ recording: true });
  view.toast('Recording the mix — press Rec again to save it.', 'info');
}

// ── Media Session (lock screen / media keys) ─────────────────────────────────────────────────────

function setMedia(s) {
  const cur = s && s.current;
  const sig = cur ? `${s.seed}:${cur.playId}:${s.playing}` : '';
  if (sig === shown.media) return;
  shown.media = sig;
  document.title = cur ? `${cur.title}${cur.artist ? ` · ${cur.artist}` : ''} — Segue` : baseTitle;
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!cur) {
      ms.metadata = null;
      ms.playbackState = 'none';
      return;
    }
    const art = typeof cur.artwork === 'string' && /^https:/.test(cur.artwork) ? [{ src: cur.artwork }] : [];
    ms.metadata = new MediaMetadata({ title: cur.title, artist: cur.artist, album: playlist ? `${playlist.title} · Segue` : 'Segue', artwork: art });
    ms.playbackState = s.playing ? 'playing' : 'paused';
  } catch {
    /* metadata is a nicety */
  }
}

function bindMediaKeys() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const bind = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* this browser does not know the action */
    }
  };
  bind('play', () => {
    gesture(false, isVideo());
    quiet(active.resume());
  });
  bind('pause', () => quiet(active.pause()));
  bind('nexttrack', () => active.skip());
  bind('stop', () => quiet(active.pause()));
}

// ── boot ─────────────────────────────────────────────────────────────────────────────────────────

function boot() {
  view.setDemos(DEMOS, EXAMPLES);
  view.setTransport({ playing: false, canSkip: false, recording: false, seed: '', vibe: prefs.vibe, mode: prefs.mode, modeEnabled: true, volume: prefs.volume, recordEnabled: true, recordWhy: '' });
  bindMediaKeys();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    active.poke();
    // Back in front: if the browser stopped the audio meanwhile and the user had not paused, try to
    // pick it up. A browser that wants a tap for this leaves the Play button showing.
    if (active.started && active.paused && !active.pausedByUser) quiet(active.resume());
  });
  window.addEventListener('popstate', onPopState);
  requestAnimationFrame(frame);

  // A share link: ?p=<playlist id>&seed=<seed>&vibe=<0..1>&len=<track length>. Audio needs a tap
  // first: previews land on "ready", full songs on the stage (the first song's ad runs meanwhile).
  // Seed, vibe and length are the link's for this set; the visitor's stored preferences stay theirs.
  const link = linkFrom(location.search);
  if (link) {
    if (link.ok) {
      openInput(link.p, { autostart: false, seed: link.seed, vibe: link.vibe, mode: link.len, fromLink: true });
      return;
    }
    view.toast('That share link doesn’t point to a playlist Segue can read.', 'error');
    try {
      history.replaceState(null, '', `${location.origin}${location.pathname}`);
    } catch {
      /* no history access */
    }
  }
  show('landing');
}

// Handy in the console, and what the end-to-end tests read. No secrets live here.
window.__segue = {
  conductor,
  fullset,
  engine,
  videoEngine,
  view,
  analyzer,
  resolver,
  finder,
  metrics,
  prefs,
  get active() {
    return active;
  },
  get decks() {
    return ytDecks;
  },
  /** true while the full-song clock runs on its worker (js/util/timers.js) */
  get workerClock() {
    return timers.worker;
  },
  get handoff() {
    return handoff ? { to: handoff.target === fullset ? 'video' : 'preview', crossfading: !!handoff.cancel } : null;
  },
};

boot();

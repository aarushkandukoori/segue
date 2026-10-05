// Segue bootstrap: wires the view (dumb, state-driven) to the conductor (the live set) and owns
// everything that belongs to the page rather than to the mix — screens, the address bar, sharing,
// recording downloads, Media Session, stored preferences and the per-frame paint loop.

import { createView } from './ui/view.js';
import { DEMOS, EXAMPLES, SourceError, applyTags, createResolver, loadPlaylist, parseInput, playlistFromFiles } from './sources/index.js';
import { createAnalyzer } from './analysis/client.js';
import { createEngine, sanitizeBufferAsync } from './dj/engine.js';
import { createRecorder, extensionFor } from './dj/recorder.js';
import { createConductor, decodeAudio, deckFrameAt } from './dj/conductor.js';
import { randomSeed } from './util/rng.js';

/** Slider at 100 % = engine volume 1.25: the engine keeps headroom for two tracks, measured safe to 1.5. */
const VOLUME_SCALE = 1.25;
const PREFS_KEY = 'segue:prefs';
const MODES = ['short', 'medium', 'full'];

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
const analyzer = createAnalyzer();
const resolver = createResolver();

let unlocked = false;
/** @type {BaseAudioContext|null} */
let quietCtx = null;

/**
 * Decode for the conductor. Before the first tap there is no AudioContext we are allowed to start
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
const metrics = { firstSoundMs: null, loads: 0, buffersChecked: 0 };

// ── view ─────────────────────────────────────────────────────────────────────────────────────────
const view = createView(document.getElementById('app'), {
  onSubmit(text) {
    gesture();
    openInput(text, { autostart: true });
  },
  onDemo(id) {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    gesture();
    openInput(demo.input, { autostart: true });
  },
  onFiles(files) {
    gesture();
    openFiles(files);
  },
  onStart() {
    gesture(true);
    if (!playlist) return goHome();
    conductor.begin();
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
    if (!conductor.started) return gesture();
    // Decide from what is true before this tap changes it: gesture() below may wake a context the
    // browser had stopped, and a set that was silent must come back as "playing", not flip to paused.
    const halted = conductor.paused || !audioRunning();
    gesture();
    if (halted) quiet(conductor.resume());
    else quiet(conductor.pause());
  },
  onSkip() {
    conductor.skip();
  },
  onNewSet() {
    if (!playlist) return gesture();
    conductor.newSet(); // first: a set the user had paused is over, so this tap may wake the audio again
    gesture();
    resetShown();
    syncUrl();
    view.toast(`New set #${conductor.seed} — same crate, different mix`, 'success');
    sync();
    // Normally the new opener is in hand and plays within a moment. When it is not (the connection
    // dropped), a silent stage explains nothing: go back to the loading screen, which says what the
    // set is waiting for and offers Cancel.
    const token = loadToken;
    const seed = conductor.seed;
    setTimeout(() => {
      if (token !== loadToken || screen !== 'stage' || conductor.started || conductor.seed !== seed) return;
      show('loading');
      const st = conductor.snapshot().status;
      if (st) view.setLoading(st);
    }, 1200);
  },
  onVibe(v) {
    prefs.vibe = clamp01(v);
    conductor.setVibe(prefs.vibe);
    savePrefs();
    syncUrlSoon();
  },
  onMode(m) {
    if (!MODES.includes(m)) {
      // "Preview" only describes 30-second clips; for full-length files fall back to the stored choice.
      view.setTransport({ mode: conductor.snapshot().mode });
      return;
    }
    prefs.mode = m;
    conductor.setMode(m);
    savePrefs();
  },
  onVolume(v) {
    prefs.volume = clamp01(v);
    conductor.setVolume(prefs.volume * VOLUME_SCALE);
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

function show(name) {
  screen = name;
  view.setScreen(name);
}

/**
 * Everything that needs a user gesture: creating / resuming the AudioContext (and iOS's silent element).
 * Not while the user has the set paused: a tap on Rec, Share or the setlist must not start the sound
 * again behind a button that says Play — Play itself resumes through the conductor.
 * @param {boolean} [force] the tap asks for sound whatever the state ("Start the set")
 */
function gesture(force = false) {
  gestureAt = performance.now();
  if (!force && conductor.started && conductor.pausedByUser) return;
  try {
    engine.unlock();
    unlocked = true;
  } catch (err) {
    console.warn('[segue] audio unavailable', err);
    view.toast('This browser cannot play Web Audio, so Segue cannot mix here.', 'error');
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

async function openInput(input, opts) {
  cancelLoad();
  const token = loadToken;
  conductor.stop();
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
  conductor.stop();
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
 * @param {{autostart?: boolean, seed?: string, vibe?: number, fromLink?: boolean}} [opts]
 *   fromLink: the set comes from the address bar (a share link, or Back / Forward to one): seed and
 *   vibe are the link's, and the history entry is the one we are on.
 */
function startPlaylist(pl, opts = {}) {
  playlist = pl;
  metrics.loads++;
  metrics.firstSoundMs = null;
  stallNoted = false;
  view.setPlaylist({ title: pl.title, subtitle: pl.subtitle, artwork: pl.artwork, link: pl.link, count: pl.tracks.length, source: pl.source });
  resetShown();
  view.setSetlist([]);
  conductor.setVolume(prefs.volume * VOLUME_SCALE);
  // The set's vibe: the link's when it came from one (the visitor's own stored preference would
  // build a different set than the sender heard), otherwise the visitor's.
  const vibe = opts.fromLink && Number.isFinite(opts.vibe) ? opts.vibe : prefs.vibe;
  conductor.load(pl, { seed: opts.seed || randomSeed(), vibe, mode: prefs.mode, autostart: !!opts.autostart, patient: !!opts.fromLink && !!opts.seed });
  if (!conductor.snapshot().loaded) return; // the conductor refused it (empty) and already reported why
  enterSet(!!opts.fromLink);
  syncTransport();
  if (pl.total > pl.tracks.length) {
    const where = pl.source === 'spotify' && pl.tracks.length <= 100 ? ' — Spotify only shares the first 100 with web pages' : '';
    view.toast(`Mixing the first ${pl.tracks.length} of ${pl.total} tracks${where}.`, 'info');
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
  conductor.stop();
  playlist = null;
  resetShown();
  view.setSetlist([]);
  shown.canSkip = false;
  view.setTransport({ playing: false, canSkip: false });
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

// ── conductor → view ─────────────────────────────────────────────────────────────────────────────

conductor.on('status', (s) => {
  if (screen === 'loading' && s) view.setLoading(s);
});

conductor.on('start', () => {
  if (conductor.paused) {
    // The opener is cued but the browser would not start the audio without a tap (Safari once its
    // file picker has closed, any browser after a drop, a tab that never had a gesture): offer the
    // one tap instead of a stage that claims to be playing. The set waits at 0:00.
    if (screen === 'loading') show('ready');
    sync();
    return;
  }
  if (metrics.firstSoundMs == null && gestureAt) {
    // 150 ms is the engine's start lead-in: the first sample leaves that long after start().
    metrics.firstSoundMs = Math.round(performance.now() - gestureAt + 150);
  }
  if (screen === 'loading' || screen === 'ready') show('stage');
  sync();
});

conductor.on('error', ({ message }) => {
  goHome();
  view.inputError(message);
});

conductor.on('change', sync);

function syncTransport() {
  const s = conductor.snapshot();
  shown.canSkip = s.canSkip;
  view.setTransport({
    playing: s.started ? s.playing : screen === 'stage',
    canSkip: s.canSkip,
    recording: !!(recorder && recorder.recording),
    seed: s.seed,
    vibe: s.vibe,
    mode: s.mode,
    modeEnabled: s.modeEnabled,
    volume: prefs.volume,
  });
}

function sync() {
  const s = conductor.snapshot();
  if (!s.loaded) return;
  // A set that was waiting for its audio (see 'start') and got it without the button — the browser
  // let the context run after all — belongs on the stage.
  if (s.playing && (screen === 'ready' || screen === 'loading')) show('stage');
  for (let d = 0; d < 2; d++) {
    const info = s.decks[d];
    const id = info ? `${s.seed}:${info.playId}` : '';
    if (id !== shown.decks[d]) {
      shown.decks[d] = id;
      view.setDeck(d, info);
    }
  }
  const tv = s.transition;
  const tsig = tv ? `${s.seed}|${tv.state}|${tv.type}|${tv.label}|${tv.tStart}|${tv.toTitle}|${tv.trick ? `${tv.trick.label}@${tv.trick.tStart}` : ''}|${tv.why}` : '';
  if (tsig !== shown.transition) {
    shown.transition = tsig;
    view.setTransition(tv);
  }
  // Second argument: how many different tracks the crate can play (the list itself also holds replays).
  view.setSetlist(s.setlist, { crate: s.stats.total - s.stats.failed });
  shown.canSkip = s.canSkip;
  view.setTransport({ playing: s.started ? s.playing : screen === 'stage', canSkip: s.canSkip, seed: s.seed, vibe: s.vibe, mode: s.mode, modeEnabled: s.modeEnabled });
  setMedia(s.started ? s : null);

  // The crate ran dry (network gone, or nothing else playable yet): the ticker carries the state for
  // as long as it lasts (snapshot.transition, state 'waiting'); a toast says it once as well.
  if (s.stalled) {
    if (!stallNoted) {
      stallNoted = true;
      const offline = s.stalled === 'network' || navigator.onLine === false;
      view.toast(offline ? 'Lost the connection — the set picks up as soon as the next track can load.' : 'Waiting for the next track — the set picks up as soon as it loads.', 'info');
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
  const started = conductor.started;
  const t = started ? engine.uiTime() : 0;
  f.t = t;
  f.playing = started && !conductor.paused;
  f.elapsed = t > 0 ? t : 0;
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
  if (!shareable() || !conductor.seed) return base;
  // Always with the vibe the set is using: a link without one would be rebuilt with whatever the
  // recipient last left their own slider at — a different set.
  const vibe = Math.round(conductor.vibe * 100) / 100;
  return `${base}?p=${playlist.id}&seed=${encodeURIComponent(conductor.seed)}&vibe=${vibe}`;
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

/** The set a URL describes, or null: {p, seed, vibe}. A link that names no vibe was made at the default. */
function linkFrom(search) {
  const qs = new URLSearchParams(search);
  const p = qs.get('p');
  if (!p) return null;
  const parsed = parseInput(p);
  const seedQ = qs.get('seed') || '';
  const vibeQ = qs.get('vibe');
  return {
    p,
    ok: (parsed.kind === 'spotify' || parsed.kind === 'deezer') && p.length < 200,
    seed: /^[A-Za-z0-9]{1,24}$/.test(seedQ) ? seedQ : undefined,
    vibe: vibeQ !== null && vibeQ !== '' && Number.isFinite(Number(vibeQ)) ? clamp01(Number(vibeQ)) : 0.5,
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
    if (playlist && playlist.id === link.p && conductor.seed === link.seed) return;
    // Forward (or Back) onto a set's entry: rebuild it; like any share link it waits for a tap.
    openInput(link.p, { autostart: false, seed: link.seed, vibe: link.vibe, fromLink: true });
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
      await navigator.share({ title: 'Segue', text: exact ? `“${playlist.title}”, DJ’d live — set #${conductor.seed}` : 'Segue — your playlist, DJ’d live', url });
      return;
    } catch (err) {
      if (isAbort(err)) return; // the user closed the share sheet
    }
  }
  const copied = await copyText(url);
  if (!exact) {
    view.toast(`${copied ? 'Link to Segue copied.' : `Link to Segue: ${url}`} Sets from your own files or a pasted list can’t be rebuilt from a link.`, 'info');
  } else if (copied) view.toast(`Link to set #${conductor.seed} copied`, 'success');
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
    gesture();
    quiet(conductor.resume());
  });
  bind('pause', () => quiet(conductor.pause()));
  bind('nexttrack', () => conductor.skip());
  bind('stop', () => quiet(conductor.pause()));
}

// ── boot ─────────────────────────────────────────────────────────────────────────────────────────

function boot() {
  view.setDemos(DEMOS, EXAMPLES);
  view.setTransport({ playing: false, canSkip: false, recording: false, seed: '', vibe: prefs.vibe, mode: 'preview', modeEnabled: false, volume: prefs.volume });
  bindMediaKeys();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    conductor.poke();
    // Back in front: if the browser stopped the audio meanwhile and the user had not paused, try to
    // pick it up. A browser that wants a tap for this leaves the Play button showing.
    if (conductor.started && conductor.paused && !conductor.pausedByUser) quiet(conductor.resume());
  });
  window.addEventListener('popstate', onPopState);
  requestAnimationFrame(frame);

  // A share link: ?p=<playlist id>&seed=<seed>&vibe=<0..1>. Audio needs a tap first, so this lands on
  // "ready". Seed and vibe are the link's for this set; the visitor's stored preferences stay theirs.
  const link = linkFrom(location.search);
  if (link) {
    if (link.ok) {
      openInput(link.p, { autostart: false, seed: link.seed, vibe: link.vibe, fromLink: true });
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
window.__segue = { conductor, engine, view, analyzer, resolver, metrics, prefs };

boot();

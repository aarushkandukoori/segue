// Segue bootstrap: wires the view (dumb, state-driven) to the conductor (the live set) and owns
// everything that belongs to the page rather than to the mix — screens, the address bar, sharing,
// recording downloads, Media Session, stored preferences and the per-frame paint loop.

import { createView } from './ui/view.js';
import { DEMOS, EXAMPLES, SourceError, applyTags, createResolver, loadPlaylist, parseInput, playlistFromFiles } from './sources/index.js';
import { createAnalyzer } from './analysis/client.js';
import { createEngine } from './dj/engine.js';
import { createRecorder, extensionFor } from './dj/recorder.js';
import { createConductor, decodeAudio } from './dj/conductor.js';
import { dbToGain, evalParam, positionAt, rateAt } from './dj/timeline.js';
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
  if (unlocked) return decodeAudio(engine.ctx, bytes);
  if (!quietCtx) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return decodeAudio(engine.ctx, bytes);
    quietCtx = new Offline(2, 2, 48000);
  }
  return decodeAudio(quietCtx, bytes);
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
const shown = { decks: ['', ''], transition: '', media: '', title: document.title };
const baseTitle = document.title;
const metrics = { firstSoundMs: null, loads: 0 };

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
    gesture();
    if (!playlist) return goHome();
    conductor.begin();
    if (conductor.started) {
      if (conductor.paused) quiet(conductor.resume());
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
    gesture();
    if (!conductor.started) return;
    if (conductor.paused) quiet(conductor.resume());
    else quiet(conductor.pause());
  },
  onSkip() {
    conductor.skip();
  },
  onNewSet() {
    gesture();
    if (!playlist) return;
    conductor.newSet();
    resetShown();
    syncUrl();
    view.toast(`New set #${conductor.seed} — same crate, different mix`, 'success');
    sync();
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

function show(name) {
  screen = name;
  view.setScreen(name);
}

/** Everything that needs a user gesture: creating / resuming the AudioContext (and iOS's silent element). */
function gesture() {
  gestureAt = performance.now();
  try {
    engine.unlock();
    unlocked = true;
  } catch (err) {
    console.warn('[segue] audio unavailable', err);
    view.toast('This browser cannot play Web Audio, so Segue cannot mix here.', 'error');
  }
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
  view.toast(friendly ? err.message : 'Something went wrong while loading that. Please try again.', 'error');
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

function startPlaylist(pl, opts = {}) {
  playlist = pl;
  metrics.loads++;
  metrics.firstSoundMs = null;
  stallNoted = false;
  view.setPlaylist({ title: pl.title, subtitle: pl.subtitle, artwork: pl.artwork, link: pl.link, count: pl.tracks.length, source: pl.source });
  resetShown();
  view.setSetlist([]);
  conductor.setVolume(prefs.volume * VOLUME_SCALE);
  conductor.load(pl, { seed: opts.seed || randomSeed(), vibe: prefs.vibe, mode: prefs.mode, autostart: !!opts.autostart });
  if (!conductor.snapshot().loaded) return; // the conductor refused it (empty) and already reported why
  syncUrl();
  syncTransport();
  if (pl.total > pl.tracks.length) {
    const where = pl.source === 'spotify' ? ' — Spotify only shares the first 100 with web pages' : '';
    view.toast(`Mixing the first ${pl.tracks.length} of ${pl.total} tracks${where}.`, 'info');
  }
  if (opts.autostart) {
    view.setLoading({ title: 'Digging through the crate', detail: 'Lining up the first tracks…', progress: 0 });
  } else {
    show('ready');
  }
}

function goHome() {
  cancelLoad();
  if (recorder && recorder.recording) finishRecording();
  conductor.stop();
  playlist = null;
  resetShown();
  view.setSetlist([]);
  view.setTransport({ playing: false, canSkip: false });
  setMedia(null);
  document.title = baseTitle;
  syncUrl();
  show('landing');
}

// ── conductor → view ─────────────────────────────────────────────────────────────────────────────

conductor.on('status', (s) => {
  if (screen === 'loading' && s) view.setLoading(s);
});

conductor.on('start', () => {
  if (metrics.firstSoundMs == null && gestureAt) {
    // 150 ms is the engine's start lead-in: the first sample leaves that long after start().
    metrics.firstSoundMs = Math.round(performance.now() - gestureAt + 150);
  }
  if (screen === 'loading' || screen === 'ready') show('stage');
  sync();
});

conductor.on('error', ({ message }) => {
  goHome();
  view.toast(message, 'error');
});

conductor.on('change', sync);

function syncTransport() {
  const s = conductor.snapshot();
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
  for (let d = 0; d < 2; d++) {
    const info = s.decks[d];
    const id = info ? `${s.seed}:${info.playId}` : '';
    if (id !== shown.decks[d]) {
      shown.decks[d] = id;
      view.setDeck(d, info);
    }
  }
  const tv = s.transition;
  const tsig = tv ? `${s.seed}|${tv.state}|${tv.type}|${tv.label}|${tv.tStart}|${tv.toTitle}` : '';
  if (tsig !== shown.transition) {
    shown.transition = tsig;
    view.setTransition(tv);
  }
  view.setSetlist(s.setlist);
  view.setTransport({ playing: s.started ? s.playing : screen === 'stage', canSkip: s.canSkip, seed: s.seed, vibe: s.vibe, mode: s.mode, modeEnabled: s.modeEnabled });
  setMedia(s.started ? s : null);

  // The crate ran dry (network gone, or nothing else playable yet): say so once instead of going quiet.
  if (s.started && s.playing && !s.decks[0] && !s.decks[1]) {
    if (!stallNoted) {
      stallNoted = true;
      view.toast('Waiting for the next track — the set picks up as soon as it loads.', 'info');
    }
  } else if (s.decks[0] || s.decks[1]) stallNoted = false;
}

// ── per-frame paint (no allocation: one FrameState, mutated in place) ────────────────────────────

const mkDeck = () => ({ pos: 0, rate: 1, bpmNow: 0, gain: 0, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0 });
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
    const p = rec.play;
    const an = rec.entry.analysis;
    const df = deckFrames[d];
    const ev = p.events;
    const end = p.endAt;
    df.pos = positionAt(p, t);
    df.rate = t < p.startAt ? p.rate[0].v : rateAt(p, end != null && t > end ? end : t);
    df.bpmNow = an.bpm * df.rate;
    df.gain = evalParam(ev, 'gain', t, 1);
    df.low = evalParam(ev, 'low', t, 0);
    df.mid = evalParam(ev, 'mid', t, 0);
    df.high = evalParam(ev, 'high', t, 0);
    df.hpf = evalParam(ev, 'hpf', t, 20);
    df.lpf = evalParam(ev, 'lpf', t, 20000);
    const running = t >= p.startAt && (end == null || t < end) && df.pos < an.duration;
    if (running) {
      // A rough "how much of this deck can you hear": fader × what the EQ and filters leave.
      const eq = 0.5 * dbToGain(df.low) + 0.3 * dbToGain(df.mid) + 0.2 * dbToGain(df.high);
      const hp = 1 - Math.log(Math.max(df.hpf, 20) / 20) / 9;
      const lp = Math.log(Math.max(df.lpf, 40) / 20) / Math.log(1000);
      const a = df.gain * eq * (hp > 0.25 ? hp : 0.25) * (lp > 0.3 ? (lp < 1 ? lp : 1) : 0.3);
      df.audible = a < 1 ? a : 1;
    } else df.audible = 0;
    f.decks[d] = df;
    const g = running ? df.gain : 0;
    if (d === 0) g0 = g;
    else g1 = g;
    if (df.audible > leadAud) {
      leadAud = df.audible;
      lead = d;
    }
  }
  if (g0 + g1 > 0.001) f.crossfade = (g1 - g0) / (g0 + g1);
  f.beatPhase = lead >= 0 ? beatPhaseAt(conductor.live.decks[lead].entry.analysis.beats, deckFrames[lead].pos, lead) : 0;
  f.levels = engine.levels();
  view.frame(f);
}

// ── address bar: always a link to this exact set ─────────────────────────────────────────────────

const shareable = () => !!playlist && (playlist.source === 'spotify' || playlist.source === 'deezer') && /^[a-z]+(?::[A-Za-z0-9]+)+$/.test(playlist.id);

function currentUrl() {
  const base = `${location.origin}${location.pathname}`;
  if (!shareable() || !conductor.seed) return base;
  const vibe = Math.round(prefs.vibe * 100) / 100;
  return `${base}?p=${playlist.id}&seed=${encodeURIComponent(conductor.seed)}${vibe === 0.5 ? '' : `&vibe=${vibe}`}`;
}

function syncUrl() {
  try {
    const url = currentUrl();
    if (url !== location.href) history.replaceState(null, '', url);
  } catch {
    /* file:// or a sandbox without history access: the app works without it */
  }
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
  const qs = new URLSearchParams(location.search);
  const vibeQ = qs.get('vibe');
  if (vibeQ !== null && Number.isFinite(Number(vibeQ))) prefs.vibe = clamp01(Number(vibeQ));
  view.setTransport({ playing: false, canSkip: false, recording: false, seed: '', vibe: prefs.vibe, mode: 'preview', modeEnabled: false, volume: prefs.volume });
  bindMediaKeys();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) conductor.poke();
  });
  requestAnimationFrame(frame);

  // A share link: ?p=<playlist id>&seed=<seed>. Audio needs a tap first, so this lands on "ready".
  const p = qs.get('p');
  if (p) {
    const parsed = parseInput(p);
    const seedQ = qs.get('seed') || '';
    if ((parsed.kind === 'spotify' || parsed.kind === 'deezer') && p.length < 200) {
      openInput(p, { autostart: false, seed: /^[A-Za-z0-9]{1,24}$/.test(seedQ) ? seedQ : undefined });
      return;
    }
    view.toast('That share link doesn’t point to a playlist Segue can read.', 'error');
    syncUrl();
  }
  show('landing');
}

// Handy in the console, and what the end-to-end tests read. No secrets live here.
window.__segue = { conductor, engine, view, analyzer, resolver, metrics, prefs };

boot();

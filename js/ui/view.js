// Segue's view: a dumb, state-driven UI. It owns the DOM under `root`, turns clicks / keys / drops into
// handler calls, and paints whatever state it is handed. It knows nothing about audio or the network.
//
//   const view = createView(document.getElementById('app'), handlers);
//   view.setScreen('landing'); … view.frame(frameState) on every animation frame while on stage.
//
// Contract: see SPEC.md §4 "ui". Per-frame work is kept allocation-free and writes to the DOM only when
// a displayed value changes (each sub-module quantizes and remembers what it last painted).

import { TEMPLATE } from './template.js';
import { clamp01, collectRefs, el, fmtTime, isTypingTarget, setImage, setLink, setText } from './dom.js';
import { createWaves, observeCanvas } from './waves.js';
import { createBackdrop } from './backdrop.js';
import { createDeck } from './decks.js';
import { createMixer } from './mixer.js';
import { createTicker } from './ticker.js';
import { createSetlist } from './setlist.js';
import { createAttract } from './landing.js';

const SCREENS = ['landing', 'loading', 'ready', 'stage'];
const SOURCE_NAMES = { spotify: 'Spotify', deezer: 'Deezer', text: 'Track list', local: 'Your files' };
const MODES = ['preview', 'short', 'medium', 'full'];
const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|wav|wave|flac|ogg|oga|opus|aif|aiff|caf|webm|weba|wma)$/i;
const DRAWER_QUERY = '(max-width: 1179px)';

/**
 * @typedef {Object} ViewHandlers
 * @property {(text: string) => void} [onSubmit]
 * @property {(demoId: string) => void} [onDemo]
 * @property {(files: File[]) => void} [onFiles]
 * @property {() => void} [onStart]
 * @property {() => void} [onPlayPause]
 * @property {() => void} [onSkip]
 * @property {() => void} [onNewSet]
 * @property {(v: number) => void} [onVibe]
 * @property {(m: string) => void} [onMode]
 * @property {(v: number) => void} [onVolume]
 * @property {() => void} [onRecordToggle]
 * @property {() => void} [onShare]
 * @property {() => void} [onHome]
 */

/**
 * @param {HTMLElement} root
 * @param {ViewHandlers} handlers
 */
export function createView(root, handlers) {
  root.classList.add('segue');
  root.innerHTML = TEMPLATE; // static markup only — see template.js
  const R = collectRefs(root);

  const call = (name, ...args) => {
    const fn = handlers && handlers[name];
    if (typeof fn === 'function') fn(...args);
  };

  /** @type {Record<string, HTMLElement>} */
  const screens = {};
  for (const s of root.querySelectorAll('[data-screen]')) screens[s.dataset.screen] = s;
  let screen = '';

  // ── sub-views ────────────────────────────────────────────────────────────────────────────────
  const backdrop = createBackdrop(R.backdrop);
  const waves = createWaves(R['wave-canvas']);
  observeCanvas(R['wave-canvas'], (w, h, dpr) => waves.resize(w, h, dpr));
  const deckUi = [createDeck(R.deck0), createDeck(R.deck1)];
  const mixer = createMixer(R.mixer);
  const ticker = createTicker(R.ticker, R);
  const setlist = createSetlist(R['crate-list'], { count: R['crate-count'], empty: R['crate-empty'] });
  const attract = createAttract(R.attract, R['attract-lock'], backdrop);
  const waveTags = [R.wt0.querySelector('[data-part="t"]'), R.wt1.querySelector('[data-part="t"]')];
  /** @type {[any, any]} */
  const deckViews = [null, null];
  /** @type {any} */
  let transition = null;

  // ── screens ──────────────────────────────────────────────────────────────────────────────────
  /** @param {'landing'|'loading'|'ready'|'stage'} name */
  function setScreen(name) {
    if (!screens[name] || name === screen) return;
    const first = screen === '';
    screen = name;
    root.dataset.screen = name;
    for (const k of SCREENS) {
      screens[k].hidden = k !== name;
      // the first screen replaces index.html's static first paint in place: no fade, no flash
      screens[k].classList.toggle('is-first', first && k === name);
    }
    setCrate(false, false);
    hideVeil();
    if (name === 'landing') attract.start();
    else attract.stop();
    waves.invalidate();
    if (name === 'ready') {
      // one keypress (Enter / Space) starts the set — also when this is the very first screen
      R['rd-start'].focus({ preventScroll: true });
    } else if (!first) {
      // Move focus with the screen so keyboard and screen-reader users land in the new content.
      screens[name].focus({ preventScroll: true });
    }
    if (!first) window.scrollTo(0, 0);
  }

  // ── landing ──────────────────────────────────────────────────────────────────────────────────
  function hint(message) {
    setText(R.hint, message);
    R.field.classList.toggle('is-invalid', !!message);
  }

  function nudge(node) {
    node.classList.remove('is-nudged');
    void node.offsetWidth; // restart the CSS animation
    node.classList.add('is-nudged');
  }

  function submit(raw, fromList) {
    const text = String(raw || '').trim();
    if (!text) {
      if (fromList) {
        nudge(R.text);
        R.text.focus();
      } else {
        hint('Paste a playlist link first — or pick a crate below.');
        nudge(R.field);
        R.input.focus();
      }
      return;
    }
    hint('');
    call('onSubmit', text);
  }

  R.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(R.input.value, false);
  });
  R.input.addEventListener('input', () => hint(''));
  // A pasted multi-line track list would be flattened by a single-line input: route it to the list box.
  R.input.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!/\S\s*[\r\n]+\s*\S/.test(text)) return;
    e.preventDefault();
    setTextPanel(true);
    R.text.value = text.trim();
    R.text.focus();
  });

  function setTextPanel(open) {
    R['text-panel'].hidden = !open;
    R['text-toggle'].setAttribute('aria-expanded', String(open));
    R['text-toggle'].hidden = open;
    R['text-blurb'].hidden = open;
  }
  R['text-toggle'].addEventListener('click', () => {
    setTextPanel(true);
    R.text.focus();
  });
  R['text-go'].addEventListener('click', () => submit(R.text.value, true));
  R.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(R.text.value, true);
  });

  R.demos.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-demo]') : null;
    if (btn) call('onDemo', btn.dataset.demo);
  });
  R.examples.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-url]') : null;
    if (!btn) return;
    R.input.value = btn.dataset.url;
    submit(btn.dataset.url, false);
  });

  /** @param {{id:string, label:string, emoji?:string}[]} demos @param {{label:string, url:string}[]} examples */
  function setDemos(demos, examples) {
    R.demos.textContent = '';
    for (const d of Array.isArray(demos) ? demos : []) {
      if (!d || d.id == null) continue;
      const b = el('button', 'chip');
      b.type = 'button';
      b.dataset.demo = String(d.id);
      // The crate's emoji is deliberately not rendered: the chrome uses drawn marks, not emoji.
      b.append(el('i', 'chip-disc'), el('span', '', d.label || String(d.id)));
      R.demos.appendChild(b);
    }
    R['demos-row'].hidden = R.demos.childElementCount === 0;

    R.examples.textContent = '';
    for (const x of Array.isArray(examples) ? examples : []) {
      if (!x || !x.url) continue;
      const li = el('li');
      const b = el('button', 'l-example');
      b.type = 'button';
      b.dataset.url = String(x.url);
      b.append(el('span', '', x.label || String(x.url)), el('i', 'l-example-go'));
      li.appendChild(b);
      R.examples.appendChild(li);
    }
    R['examples-card'].hidden = R.examples.childElementCount === 0;
  }

  // Local files: picker + drop anywhere on the landing screen.
  function takeFiles(fileList) {
    const all = Array.from(fileList || []);
    const audio = all.filter((f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name || ''));
    if (!audio.length) {
      if (all.length) toast('Those don’t look like audio files — try MP3, M4A, WAV or FLAC.', 'error');
      return;
    }
    if (audio.length < all.length) {
      const skipped = all.length - audio.length;
      toast(`Skipped ${skipped} file${skipped === 1 ? '' : 's'} that ${skipped === 1 ? 'isn’t' : 'aren’t'} audio.`, 'info');
    }
    call('onFiles', audio);
  }
  R.file.addEventListener('change', () => {
    takeFiles(R.file.files);
    R.file.value = ''; // picking the same files again must fire change again
  });

  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let dragDepth = 0;
  function hideVeil() {
    dragDepth = 0;
    R.dropveil.hidden = true;
  }
  screens.landing.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    R.dropveil.hidden = false;
  });
  screens.landing.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) R.dropveil.hidden = true;
  });
  screens.landing.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideVeil();
    takeFiles(e.dataTransfer.files);
  });
  // Anywhere else a dropped file must not navigate the tab away from a running set.
  root.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = screen === 'landing' ? 'copy' : 'none';
  });
  root.addEventListener('drop', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });

  // ── loading / ready ──────────────────────────────────────────────────────────────────────────
  /** @param {{title: string, detail?: string, progress?: number|null}} s */
  function setLoading(s) {
    const o = s || {};
    setText(R['ld-title'], o.title || 'Digging through the crate');
    setText(R['ld-detail'], o.detail || '');
    const bar = R['ld-bar'];
    if (o.progress == null || !Number.isFinite(o.progress)) {
      bar.classList.add('is-indeterminate');
      bar.removeAttribute('aria-valuenow');
      R['ld-fill'].style.transform = '';
    } else {
      const p = clamp01(o.progress);
      bar.classList.remove('is-indeterminate');
      bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      R['ld-fill'].style.transform = `scaleX(${p.toFixed(4)})`;
    }
  }

  /** @param {{title:string, subtitle?:string, artwork?:string, link?:string, count:number, source:string}} p */
  function setPlaylist(p) {
    const o = p || {};
    const title = o.title || 'Untitled playlist';
    const count = Math.max(0, o.count | 0);
    const tracks = `${count} track${count === 1 ? '' : 's'}`;
    const source = SOURCE_NAMES[o.source] || '';
    setText(R['pl-title'], title);
    setLink(R['pl-title'], o.link, true);
    setText(R['pl-meta'], source ? `${tracks} · ${source}` : tracks);
    R.pl.hidden = false;
    setImage(R.pl.querySelector('img'), o.artwork);
    setText(R['rd-title'], title);
    setText(R['rd-sub'], o.subtitle || '');
    R['rd-sub'].hidden = !o.subtitle;
    setText(R['rd-count'], tracks);
    setText(R['rd-source'], source ? `from ${source}` : '');
    R['rd-source'].hidden = !source;
    setImage(R['rd-sleeve'].querySelector('img'), o.artwork);
    setImage(R['ld-sleeve'].querySelector('img'), o.artwork);
  }
  R.pl.hidden = true;

  R['rd-start'].addEventListener('click', () => call('onStart'));
  for (const k of ['home', 'rd-home', 'ld-home', 'ld-cancel']) R[k].addEventListener('click', () => call('onHome'));

  // ── stage: decks, transition, setlist ────────────────────────────────────────────────────────
  /** @param {0|1} deck @param {any|null} d DeckView */
  function setDeck(deck, d) {
    const i = deck === 1 ? 1 : 0;
    deckViews[i] = d || null;
    deckUi[i].set(deckViews[i]);
    waves.setDeck(i, deckViews[i]);
    qRemain[i] = -2;
    setText(waveTags[i], deckViews[i] ? 'Cued' : 'Empty');
    (i === 0 ? R.wt0 : R.wt1).classList.toggle('is-empty', !deckViews[i]);
    setlist.setDecks(deckViews);
    syncTransitionSides();
    soloCheck = 0;
  }

  /** Which deck a title is on (−1 unknown) — colours the ticker bar from the outgoing to the incoming deck. */
  function deckOfTitle(title) {
    if (!title) return -1;
    if (deckViews[0] && deckViews[0].title === title) return 0;
    if (deckViews[1] && deckViews[1].title === title) return 1;
    return -1;
  }
  function syncTransitionSides() {
    if (!transition) return;
    let from = deckOfTitle(transition.fromTitle);
    let to = deckOfTitle(transition.toTitle);
    if (from === to && from >= 0) from = -1; // same title on both decks: only trust the incoming side
    if (to < 0 && from >= 0) to = 1 - from;
    if (from < 0 && to >= 0 && transition.fromTitle) from = 1 - to;
    R.ticker.dataset.from = String(from);
    R.ticker.dataset.to = String(to);
  }

  /** @param {any|null} tv TransitionView */
  function setTransition(tv) {
    transition = tv || null;
    ticker.set(transition);
    syncTransitionSides();
    soloCheck = 0;
  }

  /** @param {any[]} items SetlistItem[] */
  function setSetlist(items) {
    setlist.set(items);
  }

  // Setlist drawer (docked column on wide screens, drawer / bottom sheet below that).
  const drawerMq = window.matchMedia(DRAWER_QUERY);
  let crateOpen = false;
  function setCrate(open, moveFocus = true) {
    const drawer = drawerMq.matches;
    const was = crateOpen;
    crateOpen = !!open && drawer;
    const closed = drawer && !crateOpen;
    R.crate.classList.toggle('is-open', crateOpen);
    R.crate.toggleAttribute('inert', closed);
    if (closed) R.crate.setAttribute('aria-hidden', 'true');
    else R.crate.removeAttribute('aria-hidden');
    R.scrim.hidden = !crateOpen;
    R['crate-toggle'].setAttribute('aria-expanded', String(crateOpen));
    if (!moveFocus || was === crateOpen) return;
    if (crateOpen) R['crate-close'].focus({ preventScroll: true });
    else R['crate-toggle'].focus({ preventScroll: true });
  }
  drawerMq.addEventListener('change', () => setCrate(false, false));
  R['crate-toggle'].addEventListener('click', () => setCrate(!crateOpen));
  R['crate-close'].addEventListener('click', () => setCrate(false));
  R.scrim.addEventListener('click', () => setCrate(false));
  setCrate(false, false);

  // ── transport ────────────────────────────────────────────────────────────────────────────────
  /** After a mouse/touch click, hand focus back to the page so Space keeps meaning play/pause. */
  const press = (node, fn) =>
    node.addEventListener('click', (e) => {
      if (e.detail > 0) node.blur();
      fn();
    });
  press(R.play, () => call('onPlayPause'));
  press(R.skip, () => call('onSkip'));
  press(R.newset, () => call('onNewSet'));
  press(R.share, () => call('onShare'));
  press(R.rec, () => call('onRecordToggle'));

  const tp = { playing: null, canSkip: null, recording: null, seed: null, vibe: NaN, mode: null, modeEnabled: null, volume: NaN };
  const modeInputs = /** @type {HTMLInputElement[]} */ (Array.from(R.mode.querySelectorAll('input')));
  const vibeWords = Array.from(root.querySelectorAll('.vibe-scale span'));
  let vibeBusy = false;
  let volumeBusy = false;
  let lastVolume = 0.9;
  let recStart = 0;
  let qRec = -1;

  function paintVibe(v) {
    R.vibe.style.setProperty('--v', v.toFixed(3));
    const word = v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2;
    R.vibe.setAttribute('aria-valuetext', `${['Smooth', 'Club', 'Wild'][word]} (${Math.round(v * 100)}%)`);
    for (let i = 0; i < vibeWords.length; i++) vibeWords[i].classList.toggle('is-on', i === word);
  }
  function paintVolume(v) {
    R.volume.style.setProperty('--v', v.toFixed(3));
    R.mute.classList.toggle('is-muted', v <= 0.001);
    R.mute.setAttribute('aria-pressed', String(v <= 0.001));
  }
  const holdWhile = (input, set) => {
    input.addEventListener('pointerdown', () => set(true));
    for (const type of ['pointerup', 'pointercancel', 'blur', 'change']) input.addEventListener(type, () => set(false));
  };
  // While the user is dragging a slider, incoming setTransport() values must not yank the thumb.
  holdWhile(R.vibe, (b) => (vibeBusy = b));
  holdWhile(R.volume, (b) => (volumeBusy = b));
  R.vibe.addEventListener('input', () => {
    const v = clamp01(Number(R.vibe.value));
    tp.vibe = v;
    paintVibe(v);
    call('onVibe', v);
  });
  R.volume.addEventListener('input', () => {
    const v = clamp01(Number(R.volume.value));
    tp.volume = v;
    if (v > 0.001) lastVolume = v;
    paintVolume(v);
    call('onVolume', v);
  });
  press(R.mute, () => {
    const v = tp.volume > 0.001 ? 0 : lastVolume || 0.8;
    tp.volume = v;
    R.volume.value = String(v);
    paintVolume(v);
    call('onVolume', v);
  });
  R.mode.addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (!input || !input.checked || !MODES.includes(input.value)) return;
    tp.mode = input.value;
    call('onMode', input.value);
  });
  paintVibe(0.5);
  paintVolume(0.9);

  /** @param {{playing:boolean, canSkip:boolean, recording:boolean, seed:string, vibe:number, mode:string, modeEnabled:boolean, volume:number}} s */
  function setTransport(s) {
    if (!s) return;
    // Every field is optional: only what is present (and changed) is repainted.
    const playing = s.playing == null ? !!tp.playing : !!s.playing;
    if (playing !== tp.playing) {
      tp.playing = playing;
      R.play.classList.toggle('is-playing', playing);
      R.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      root.classList.toggle('is-playing', playing);
    }
    const canSkip = s.canSkip == null ? !!tp.canSkip : !!s.canSkip;
    if (canSkip !== tp.canSkip) {
      tp.canSkip = canSkip;
      R.skip.disabled = !canSkip;
    }
    const recording = s.recording == null ? !!tp.recording : !!s.recording;
    if (recording !== tp.recording) {
      tp.recording = recording;
      R.rec.classList.toggle('is-on', recording);
      R.rec.setAttribute('aria-pressed', String(recording));
      R.rec.title = recording ? 'Stop recording and save the set' : 'Record this set';
      root.classList.toggle('is-recording', recording);
      recStart = performance.now();
      qRec = -1;
      setText(R['rec-label'], recording ? '0:00' : 'Rec');
    }
    const seed = s.seed == null ? tp.seed || '' : String(s.seed).replace(/^#/, '');
    if (seed !== tp.seed) {
      tp.seed = seed;
      setText(R.seed, seed ? `#${seed}` : '#––––––');
      setText(R['rd-seed'], seed ? `#${seed}` : '');
      R['rd-seed'].parentElement.hidden = !seed;
    }
    const vibe = s.vibe == null ? NaN : clamp01(Number(s.vibe));
    if (!vibeBusy && Number.isFinite(vibe) && vibe !== tp.vibe) {
      tp.vibe = vibe;
      R.vibe.value = String(vibe);
      paintVibe(vibe);
    }
    const volume = s.volume == null ? NaN : clamp01(Number(s.volume));
    if (!volumeBusy && Number.isFinite(volume) && volume !== tp.volume) {
      tp.volume = volume;
      if (volume > 0.001) lastVolume = volume;
      R.volume.value = String(volume);
      paintVolume(volume);
    }
    if (s.mode != null && s.mode !== tp.mode) {
      tp.mode = s.mode;
      for (const input of modeInputs) input.checked = input.value === s.mode;
    }
    const modeEnabled = s.modeEnabled == null ? !!tp.modeEnabled : !!s.modeEnabled;
    if (modeEnabled !== tp.modeEnabled) {
      tp.modeEnabled = modeEnabled;
      R.mode.disabled = !modeEnabled;
      R.mode.classList.toggle('is-locked', !modeEnabled);
      R.mode.title = modeEnabled ? 'How long each track plays before the next blend' : 'Previews are 30 seconds — add your own files to unlock longer plays';
    }
  }

  // ── toasts ───────────────────────────────────────────────────────────────────────────────────
  /** @type {Map<string, {node: HTMLElement, timer: any}>} */
  const liveToasts = new Map();
  /** @param {string} message @param {'info'|'error'|'success'} [kind] */
  function toast(message, kind = 'info') {
    const text = String(message == null ? '' : message);
    if (!text) return;
    const type = kind === 'error' || kind === 'success' ? kind : 'info';
    const ttl = type === 'error' ? 7000 : 4200;
    const id = `${type}|${text}`;
    const dismiss = () => {
      const t = liveToasts.get(id);
      if (!t) return;
      clearTimeout(t.timer);
      liveToasts.delete(id);
      t.node.classList.add('is-leaving');
      setTimeout(() => t.node.remove(), 220);
    };
    const existing = liveToasts.get(id);
    if (existing) {
      // Same message again: keep one toast and restart its clock instead of stacking duplicates.
      clearTimeout(existing.timer);
      existing.timer = setTimeout(dismiss, ttl);
      return;
    }
    const node = el('div', `toast toast-${type}`);
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    node.append(el('i', 'toast-dot'), el('p', '', text));
    node.addEventListener('click', dismiss);
    R.toasts.appendChild(node);
    liveToasts.set(id, { node, timer: setTimeout(dismiss, ttl) });
    if (liveToasts.size > 3) {
      const oldest = liveToasts.keys().next().value;
      const t = liveToasts.get(oldest);
      clearTimeout(t.timer);
      liveToasts.delete(oldest);
      t.node.remove();
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────────────────────
  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && crateOpen) {
      setCrate(false);
      return;
    }
    if (screen !== 'stage' || e.repeat || isTypingTarget(e.target)) return;
    const onControl = e.target instanceof Element && !!e.target.closest('button, a[href], summary, [role="button"]');
    if (e.key === ' ' || e.code === 'Space') {
      if (onControl) return; // Space on a focused button activates that button, as it should
      e.preventDefault();
      call('onPlayPause');
    } else if (e.key === 'ArrowRight') {
      if (!tp.canSkip) return;
      e.preventDefault();
      call('onSkip');
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      call('onNewSet');
    }
  };
  document.addEventListener('keydown', onKey);

  // ── per-frame ────────────────────────────────────────────────────────────────────────────────
  const qRemain = [-2, -2];
  let qElapsed = -1;
  let isLong = false;
  let lastNow = 0;
  let locked = false;
  let lockFor = 0;
  let soloCheck = 0;

  function paintLock(d0, d1, playing, dt) {
    let ok = false;
    if (playing && d0 && d1) {
      const a = waves.beatPhaseAt(0, d0.pos);
      const b = waves.beatPhaseAt(1, d1.pos);
      if (a >= 0 && b >= 0) {
        let diff = a > b ? a - b : b - a;
        if (diff > 0.5) diff = 1 - diff;
        ok = diff < (locked ? 0.1 : 0.05);
      }
    }
    lockFor = ok ? lockFor + dt : 0;
    const next = ok && (locked || lockFor > 0.5);
    if (next !== locked) {
      locked = next;
      R.lock.classList.toggle('is-on', locked);
    }
  }

  /** @param {any} f FrameState */
  function frame(f) {
    if (screen !== 'stage' || !f || !f.decks) return;
    const now = performance.now();
    let dt = (now - lastNow) / 1000;
    lastNow = now;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;

    const d0 = f.decks[0] || null;
    const d1 = f.decks[1] || null;
    const playing = !!f.playing;
    const beatPhase = playing && f.beatPhase >= 0 ? f.beatPhase : 1;

    waves.draw(d0, d1, beatPhase);
    deckUi[0].frame(d0);
    deckUi[1].frame(d1);
    mixer.frame(f, d0 ? waves.ampAt(0, d0.pos) : 0, d1 ? waves.ampAt(1, d1.pos) : 0, dt);
    ticker.frame(f.t);
    paintLock(d0, d1, playing, dt);

    const es = f.elapsed > 0 ? Math.floor(f.elapsed) : 0;
    if (es !== qElapsed) {
      qElapsed = es;
      setText(R.elapsed, fmtTime(es));
    }
    for (let i = 0; i < 2; i++) {
      const v = deckViews[i];
      const d = i === 0 ? d0 : d1;
      if (!v || !d) continue;
      // a cued deck reports a "virtual" position before its start: never show more than the track's length
      const left = Math.ceil(v.duration - (d.pos > 0 ? d.pos : 0));
      const rem = left > 0 ? (left < 35999 ? left : 35999) : 0;
      if (rem !== qRemain[i]) {
        qRemain[i] = rem;
        setText(waveTags[i], `−${fmtTime(rem)}`);
      }
    }
    let rs = 0;
    if (tp.recording) {
      rs = Math.floor((now - recStart) / 1000);
      if (rs !== qRec) {
        qRec = rs;
        setText(R['rec-label'], fmtTime(rs));
      }
    }
    // h:mm:ss clocks are wider: lets the CSS make room for them in a narrow top bar
    const long = es >= 3600 || rs >= 3600;
    if (long !== isLong) {
      isLong = long;
      root.classList.toggle('is-long', long);
    }
    // A few times a second: tell the idle ticker which track is riding solo.
    if (--soloCheck < 0) {
      soloCheck = 20;
      const a0 = d0 && deckViews[0] ? d0.audible : -1;
      const a1 = d1 && deckViews[1] ? d1.audible : -1;
      const lead = a0 >= a1 ? (a0 > 0.2 ? 0 : -1) : a1 > 0.2 ? 1 : -1;
      ticker.setIdleTitle(lead >= 0 ? deckViews[lead].title : '');
    }

    backdrop.draw(f.levels, beatPhase, d0 ? d0.audible : 0, d1 ? d1.audible : 0, 1);
  }

  function destroy() {
    document.removeEventListener('keydown', onKey);
    attract.stop();
    mixer.destroy();
    deckUi[0].destroy();
    deckUi[1].destroy();
  }

  return {
    setScreen,
    setDemos,
    setLoading,
    setPlaylist,
    setDeck,
    setTransition,
    setSetlist,
    setTransport,
    toast,
    frame,
    destroy,
    /** @internal test hook: waveform tile-cache statistics */
    _debug: () => ({ waves: waves._stats() }),
  };
}

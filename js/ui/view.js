// Segue's view: a dumb, state-driven UI. It owns the DOM under `root`, turns clicks / keys / drops into
// handler calls, and paints whatever state it is handed. It knows nothing about audio or the network.
//
//   const view = createView(document.getElementById('app'), handlers);
//   view.setScreen('landing'); … view.frame(frameState) on every animation frame while on stage.
//
// Contract: see SPEC.md §4 "ui" and §6.5 (video mode). Per-frame work is kept allocation-free and writes
// to the DOM only when a displayed value changes (each sub-module quantizes and remembers what it last
// painted).
//
// Two stage modes: 'waves' (30-second previews and local files through Web Audio: scrolling waveforms in
// the hero) and 'video' (full songs in YouTube's embedded player: the hero shows two player slots, see
// vstage.js). Switching modes is CSS only — the slots are created once and never moved.

import { TEMPLATE } from './template.js';
import { clamp01, collectRefs, el, fmtTime, isTypingTarget, setImage, setLink, setText } from './dom.js';
import { createWaves, observeCanvas } from './waves.js';
import { createBackdrop } from './backdrop.js';
import { createDeck } from './decks.js';
import { createMixer } from './mixer.js';
import { createTicker } from './ticker.js';
import { createSetlist } from './setlist.js';
import { createAttract } from './landing.js';
import { createVStage } from './vstage.js';

const SCREENS = ['landing', 'loading', 'ready', 'stage'];
const SOURCE_NAMES = { spotify: 'Spotify', deezer: 'Deezer', text: 'Track list', local: 'Your files' };
const MODES = ['preview', 'short', 'medium', 'full'];
const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|wav|wave|flac|ogg|oga|opus|aif|aiff|caf|webm|weba|wma)$/i;
const DRAWER_QUERY = '(max-width: 1179px)';
/** Video mode on a short phone (and a phone on its side): the page scrolls, and the setlist is page
 * content under the booth instead of a drawer that would only get the sliver below the players. */
const SCROLL_QUERY = '(max-width: 599px) and (max-height: 730px), (max-width: 1023px) and (max-height: 520px)';
/** Track-length microcopy: how long each song plays, and where the sound comes from. */
const MODE_LENGTH = { preview: '30-second clips', short: 'About 45 s of each song', medium: 'About 90 s of each song', full: 'Each song to its outro' };
const MODE_FROM_STREAM = { preview: '30-second clips, beat-matched', short: 'full songs from YouTube', medium: 'full songs from YouTube', full: 'full songs from YouTube' };
const MODE_FROM_FILES = { short: 'your own files, full length', medium: 'your own files, full length', full: 'your own files, full length' };
const PREVIEW_OFF_WHY = 'Previews are for streaming playlists — your own files always play full length';
/** The first song's ad in one short line (the video stage on a short phone; the ticker has the long one). */
const START_AD = 'Muted ad before the first song. The set starts when it ends.';
const REC_OFF_WHY = 'Recording isn’t available for this set';

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
 * @property {(m: string) => void} [onMode]  the Track length control: the visitor's choice (kept as their default)
 * @property {() => void} [onPreviewOnce]  "Play previews instead" (the first song stuck behind its ad):
 *   this set only goes on as previews; the stored track length is not touched. Without it the view
 *   falls back to onMode('preview').
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
  const vstage = createVStage(R.vstage);
  /** @type {'waves'|'video'} */
  let stageMode = 'waves';
  root.dataset.stage = stageMode;
  const waveTagBox = [R.wt0, R.wt1];
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
  /** Where the last load was started from — a failure is reported there. '' = not from this page (a share link). */
  let lastSource = '';
  /** @type {HTMLElement|null} */
  let lastChip = null;

  /** Message under the link field; `invalid` also marks the field itself as the thing to correct. */
  function hint(message, invalid = true) {
    const bad = !!message && invalid;
    setText(R.hint, message);
    R.field.classList.toggle('is-invalid', bad);
    if (bad) R.input.setAttribute('aria-invalid', 'true');
    else R.input.removeAttribute('aria-invalid');
  }
  function textHint(message) {
    setText(R['text-hint'], message);
    R.text.classList.toggle('is-invalid', !!message);
    if (message) R.text.setAttribute('aria-invalid', 'true');
    else R.text.removeAttribute('aria-invalid');
  }
  function clearErrors() {
    hint('');
    textHint('');
  }

  /**
   * A load failed. Say so next to what the user used to start it, and hand that control back: the
   * link field is focused with its text selected (paste the right link straight over it), a pasted
   * list gets the caret back, a crate chip gets focus again. The message stays until the next edit or
   * the next attempt — unlike a toast, it cannot time out before it has been read.
   * Called while another screen is showing, it falls back to an error toast.
   * @param {string} message
   */
  function inputError(message) {
    const text = String(message == null ? '' : message);
    if (!text) return;
    if (screen !== 'landing') {
      toast(text, 'error');
      return;
    }
    clearErrors();
    if (lastSource === 'text' && !R['text-panel'].hidden) {
      textHint(text);
      R.text.focus();
      // focus alone only guarantees the box is on screen; the message sits just under it
      R['text-panel'].scrollIntoView({ block: 'nearest' });
      return;
    }
    hint(text, lastSource === 'input');
    if (lastSource === 'input') {
      R.input.focus();
      R.input.select();
    } else if (lastSource === 'demo' && lastChip && lastChip.isConnected) {
      lastChip.focus();
    }
    R.form.scrollIntoView({ block: 'nearest' });
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
    clearErrors();
    lastSource = fromList ? 'text' : 'input';
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
  R.text.addEventListener('input', () => textHint(''));

  R.demos.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-demo]') : null;
    if (!btn) return;
    clearErrors();
    lastSource = 'demo';
    lastChip = /** @type {HTMLElement} */ (btn);
    call('onDemo', btn.dataset.demo);
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
    clearErrors();
    lastSource = 'files';
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
    // your own files play full length through Web Audio: no 30-second previews, no YouTube
    playlistLocal = o.source === 'local';
    paintModes();
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
    vstage.set(i, deckViews[i]);
    qRemain[i] = -2;
    setText(waveTags[i], deckViews[i] ? 'Cued' : 'Empty');
    waveTagBox[i].classList.toggle('is-empty', !deckViews[i]);
    waveTagBox[i].classList.toggle('is-cued', !!deckViews[i]);
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
    paintStart();
    soloCheck = 0;
  }

  /**
   * The first song waiting for its ad (TransitionView 'starting'). Where the page scrolls (short phone,
   * phone on its side) the ticker that explains it is below the fold, so the video stage carries a short
   * version of it and the way out (the CSS shows .vs-start only on that layout). The ticker's live region
   * still reads the whole reason out; the short line carries it as a tooltip.
   */
  function paintStart() {
    const starting = !!transition && transition.state === 'starting';
    R['vs-start'].hidden = !starting;
    R.vstage.classList.toggle('is-starting', starting);
    if (!starting) return;
    const why = typeof transition.why === 'string' ? transition.why : '';
    setText(R['vs-start-why'], /\bads?\b/i.test(why) ? START_AD : why || 'Starting the set…');
    R['vs-start-why'].title = why;
  }

  /**
   * @param {any[]} items SetlistItem[]
   * @param {{crate?: number}} [info] crate: number of different playable tracks, for the header
   */
  function setSetlist(items, info) {
    setlist.set(items, info);
  }

  // Setlist drawer (docked column on wide screens, drawer / bottom sheet below that). Video mode on a
  // short phone or a phone on its side (SCROLL_QUERY): the page scrolls and the setlist is page content
  // under the booth; "Setlist" opens it as a sheet BELOW the two players (placeSheet) — scrolling down to
  // it would take both players, and the transport, off the screen.
  const drawerMq = window.matchMedia(DRAWER_QUERY);
  const scrollMq = window.matchMedia(SCROLL_QUERY);
  const inlineCrate = () => stageMode === 'video' && scrollMq.matches;
  let crateOpen = false;
  function setCrate(open, moveFocus = true) {
    const inline = inlineCrate();
    const drawer = drawerMq.matches && !inline;
    const was = crateOpen;
    crateOpen = !!open && (drawer || inline);
    const closed = drawer && !crateOpen;
    const sheet = inline && crateOpen;
    R.crate.classList.toggle('is-open', crateOpen);
    R.crate.classList.toggle('is-sheet', sheet);
    R.crate.toggleAttribute('inert', closed);
    if (closed) R.crate.setAttribute('aria-hidden', 'true');
    else R.crate.removeAttribute('aria-hidden');
    // the sheet starts below the players and leaves them uncovered and in use: no scrim
    R.scrim.hidden = !crateOpen || sheet;
    R['crate-toggle'].setAttribute('aria-expanded', String(crateOpen));
    if (sheet && !was) {
      placeSheet(true);
      setlist.reveal();
    }
    if (!moveFocus || was === crateOpen) return;
    if (crateOpen) R['crate-close'].focus({ preventScroll: true });
    else R['crate-toggle'].focus({ preventScroll: true });
  }

  /**
   * The setlist sheet where the page scrolls. Two screens of ≥ 200 px leave a phone no room for a list
   * beside or under them, so: scroll the page just far enough that the screens sit at the top of the
   * window (never further), and lay the sheet over everything below their bottom edge, down to the
   * window's bottom. It is placed in page coordinates (absolute, CSS), so no later scroll — the user's —
   * can bring a player under it: the players only ever move away from it, upwards.
   * @param {boolean} scroll bring the screens to the top first (false: only re-measure, e.g. on resize)
   */
  function placeSheet(scroll) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const s of R.vstage.querySelectorAll('.vscreen')) {
      const r = s.getBoundingClientRect();
      if (!(r.height > 0)) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!(bottom > top)) return;
    if (scroll) {
      const y0 = window.scrollY;
      window.scrollTo(0, Math.max(0, Math.floor(top + y0) - 6));
      bottom -= window.scrollY - y0;
    }
    const cb = R.crate.offsetParent || document.body;
    const cbTop = cb.getBoundingClientRect().top + cb.clientTop;
    const sheetTop = Math.ceil(bottom) + 4; // viewport coordinates, a few px clear of the rings
    R.crate.style.setProperty('--sheet-top', `${sheetTop - cbTop}px`);
    R.crate.style.setProperty('--sheet-h', `${Math.max(160, Math.floor(window.innerHeight - sheetTop))}px`);
  }
  const onResize = () => {
    if (crateOpen && inlineCrate()) placeSheet(false);
  };
  window.addEventListener('resize', onResize);
  drawerMq.addEventListener('change', () => setCrate(false, false));
  scrollMq.addEventListener('change', () => setCrate(false, false));
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
  // Recording can be unavailable (full songs: YouTube's audio never reaches the page, so there is
  // nothing to record). The button stays focusable and tappable — a tap says why, which a tooltip
  // alone never does on a touch screen.
  press(R.rec, () => {
    if (tp.recordEnabled === false) toast(tp.recordWhy || REC_OFF_WHY, 'info');
    else call('onRecordToggle');
  });
  // the way out of a first song stuck behind its ad (ticker state 'starting'), in the ticker and, where
  // the ticker is below the fold, on the video stage
  // — for this set only (onPreviewOnce), so one tap does not switch full songs off for every later visit
  const previewOnce = () => {
    if (handlers && typeof handlers.onPreviewOnce === 'function') call('onPreviewOnce');
    else call('onMode', 'preview');
  };
  press(R['tk-act'], previewOnce);
  press(R['vs-start-act'], previewOnce);

  const tp = {
    playing: null, canSkip: null, recording: null, seed: null, vibe: NaN, mode: null, modeEnabled: true, volume: NaN,
    /** @type {string[]|null} */ modes: null, recordEnabled: true, recordWhy: '',
  };
  const modeInputs = /** @type {HTMLInputElement[]} */ (Array.from(R.mode.querySelectorAll('input')));
  const vibeWords = Array.from(root.querySelectorAll('.vibe-scale span'));
  let playlistLocal = false;
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
  function paintRec() {
    const off = tp.recordEnabled === false;
    const why = tp.recordWhy || REC_OFF_WHY;
    R.rec.classList.toggle('is-disabled', off);
    if (off) R.rec.setAttribute('aria-disabled', 'true');
    else R.rec.removeAttribute('aria-disabled');
    // the name stays put while recording (aria-pressed says that); unavailable, it carries the reason
    R.rec.setAttribute('aria-label', off ? `Record — not available: ${why}` : 'Record this set');
    R.rec.title = off ? why : tp.recording ? 'Stop recording and save the set' : 'Record this set';
  }

  /** Which track lengths this set offers: what setTransport said, else all four — minus Preview for your own files. */
  const offered = () => tp.modes || (playlistLocal ? MODES.slice(1) : MODES);
  /** Track length: every playlist can play full songs; only your own files have no 30-second previews. */
  function paintModes() {
    const avail = offered();
    const on = tp.modeEnabled !== false;
    const from = playlistLocal ? MODE_FROM_FILES : MODE_FROM_STREAM;
    for (const input of modeInputs) {
      const ok = avail.includes(input.value);
      input.disabled = !on || !ok;
      const label = /** @type {HTMLElement} */ (input.parentElement);
      label.classList.toggle('is-unavailable', !ok);
      label.title = ok ? `${MODE_LENGTH[input.value]} — ${from[input.value] || ''}` : input.value === 'preview' && playlistLocal ? PREVIEW_OFF_WHY : 'Not available for this set';
    }
    // The fieldset itself is never disabled: Gecko would swallow the taps that explain an unavailable option.
    R.mode.classList.toggle('is-off', !on);
    // lets the phone layout give the control a row of its own
    R.transport.classList.toggle('is-mode-live', on);
    paintModeHint();
  }
  function paintModeHint() {
    const from = playlistLocal ? MODE_FROM_FILES : MODE_FROM_STREAM;
    setText(R['mode-hint'], from[tp.mode] || '');
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
    paintModeHint();
    call('onMode', input.value);
  });
  // An option this set does not offer (Preview, for your own files) says why when it is tapped: a
  // tooltip is no explanation on a touch screen. The CSS lets taps fall through disabled radios to
  // their label — a disabled control would swallow them.
  R.mode.addEventListener('click', (e) => {
    const label = e.target instanceof Element ? e.target.closest('label') : null;
    const input = label && label.querySelector('input');
    if (!input || !input.disabled || tp.modeEnabled === false) return;
    toast(input.value === 'preview' && playlistLocal ? PREVIEW_OFF_WHY : 'That track length isn’t available for this set', 'info');
  });
  paintVibe(0.5);
  paintVolume(0.9);
  paintModes();

  /**
   * @param {{playing?:boolean, canSkip?:boolean, recording?:boolean, seed?:string, vibe?:number, mode?:string,
   *   modeEnabled?:boolean, modes?:string[], volume?:number, recordEnabled?:boolean, recordWhy?:string}} s
   */
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
      root.classList.toggle('is-recording', recording);
      recStart = performance.now();
      qRec = -1;
      setText(R['rec-label'], recording ? '0:00' : 'Rec');
      paintRec();
    }
    const recordEnabled = s.recordEnabled == null ? tp.recordEnabled : s.recordEnabled !== false;
    const recordWhy = s.recordWhy == null ? tp.recordWhy : String(s.recordWhy);
    if (recordEnabled !== tp.recordEnabled || recordWhy !== tp.recordWhy) {
      tp.recordEnabled = recordEnabled;
      tp.recordWhy = recordWhy;
      paintRec();
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
    let modesChanged = false;
    if (s.mode != null && s.mode !== tp.mode) {
      tp.mode = s.mode;
      for (const input of modeInputs) input.checked = input.value === s.mode;
      paintModeHint();
    }
    if (s.modes !== undefined) {
      const list = Array.isArray(s.modes) ? MODES.filter((m) => s.modes.includes(m)) : null;
      if (String(list) !== String(tp.modes)) {
        tp.modes = list;
        modesChanged = true;
      }
    }
    const modeEnabled = s.modeEnabled == null ? tp.modeEnabled : !!s.modeEnabled;
    if (modeEnabled !== tp.modeEnabled || modesChanged) {
      tp.modeEnabled = modeEnabled;
      paintModes();
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
    // an error is usually an instruction: give a long one the time it takes to read (≈ 60 ms a character)
    const ttl = type === 'error' ? Math.min(15000, Math.max(7000, 2500 + text.length * 60)) : 4200;
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
  let lastT = NaN;
  let locked = false;
  let lockFor = 0;
  let soloCheck = 0;

  function paintLock(d0, d1, playing, dt) {
    let ok = false;
    // "Beat lock" is a claim about two tracks you can hear: a deck that is only cued (silent, parked in
    // its lane) may well sit in phase by arithmetic, but nothing is locked to anything yet.
    const heard = locked ? 0.02 : 0.04;
    if (playing && d0 && d1 && d0.audible > heard && d1.audible > heard) {
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

  /**
   * @param {any} f FrameState (SPEC.md §4). One optional addition per DeckFrame:
   *   `startsIn` — seconds of set time until that deck's play starts: > 0 while the deck is cued (loaded,
   *   silent, not started), 0 once it runs. With it the cued deck's waveform is parked in its lane and
   *   counted down ("Cued · in 0:14") instead of sitting off-screen; without it the view can only tell
   *   that a deck has not begun from a negative `pos`, and parks it without the run-in or the countdown.
   */
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
    const video = stageMode === 'video';

    if (video) {
      // the waveform hero is hidden: its canvas is not drawn, the slots' captions are
      vstage.frame(0, d0);
      vstage.frame(1, d1);
    } else waves.draw(d0, d1, beatPhase);
    deckUi[0].frame(d0);
    deckUi[1].frame(d1);
    // channel meters are read off the deck's own waveform — a YouTube deck has none, so they stay down
    mixer.frame(f, d0 ? waves.ampAt(0, d0.pos) : 0, d1 ? waves.ampAt(1, d1.pos) : 0, dt);
    ticker.frame(f.t);
    // "In phase for half a second" is measured on the set's clock: what the lamp says must not depend
    // on how the frames happen to be spaced in real time (a burst after a stall, a coarse timer).
    let dtSet = f.t - lastT;
    lastT = f.t;
    if (!(dtSet > 0) || dtSet > 0.25) dtSet = dt;
    // no beat grid exists for a full song: the lamp (hidden in video mode anyway) never claims a lock
    paintLock(d0, d1, playing && !video, dtSet);

    const es = f.elapsed > 0 ? Math.floor(f.elapsed) : 0;
    if (es !== qElapsed) {
      qElapsed = es;
      setText(R.elapsed, fmtTime(es));
    }
    for (let i = 0; !video && i < 2; i++) {
      const v = deckViews[i];
      const d = i === 0 ? d0 : d1;
      if (!v || !d) continue;
      // One number per state, so the text is only rebuilt when it changes:
      //   ≥ 0   playing, that many seconds left
      //   −3    cued, start time not known (no startsIn; the "virtual" position before the start is < 0)
      //   ≤ −10 cued, starts in (−code − 10) seconds — "time left" would be a clock that is not running
      let code;
      if (d.startsIn > 0 && d.startsIn < Infinity) {
        const wait = Math.ceil(d.startsIn);
        code = -10 - (wait < 35999 ? wait : 35999);
      } else if (d.pos < 0) code = -3;
      else {
        const left = Math.ceil(v.duration - d.pos);
        code = left > 0 ? (left < 35999 ? left : 35999) : 0;
      }
      if (code !== qRemain[i]) {
        qRemain[i] = code;
        setText(waveTags[i], code >= 0 ? `−${fmtTime(code)}` : code === -3 ? 'Cued' : `Cued · in ${fmtTime(-code - 10)}`);
        waveTagBox[i].classList.toggle('is-cued', code < 0);
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

  // ── stage mode: waveforms (previews, own files) or video (full songs in YouTube's player) ──────
  /**
   * Nothing may be drawn over a player (YouTube's terms), so in video mode everything that floats —
   * toasts, the setlist drawer and its scrim — is kept below the video stage. Its bottom edge is
   * measured here and handed to the CSS as --vs-bottom.
   */
  const topbar = /** @type {HTMLElement} */ (root.querySelector('.topbar'));
  let vsBottom = -1;
  function syncVsBottom() {
    if (stageMode !== 'video') return;
    // in document coordinates: where a short phone lets the page scroll, the stage only ever moves up
    // from here, so a layer placed below this line can never reach the players
    const b = Math.ceil(R.vstage.getBoundingClientRect().bottom + window.scrollY);
    if (b === vsBottom) return;
    vsBottom = b;
    root.style.setProperty('--vs-bottom', `${b}px`);
  }
  const vsRo = new ResizeObserver(() => {
    syncVsBottom();
    // the stage changed size under an open setlist sheet (the first song's start line came or went): the
    // screens moved, so the sheet follows their bottom edge before anything is painted
    onResize();
  });
  vsRo.observe(R.vstage);
  vsRo.observe(topbar);

  /**
   * 'waves': the hero shows the scrolling waveforms (Web Audio sets). 'video': it shows the two video
   * slots instead (full songs). CSS only: the slots stay where they are, so a mounted player is never
   * reloaded. Switch back to 'waves' only once the players are stopped — a hidden slot must not play.
   * @param {'waves'|'video'} m
   */
  function setStageMode(m) {
    const mode = m === 'video' ? 'video' : 'waves';
    if (mode === stageMode) return;
    stageMode = mode;
    root.dataset.stage = mode;
    mixer.setVideo(mode === 'video');
    if (locked) {
      locked = false;
      lockFor = 0;
      R.lock.classList.remove('is-on');
    }
    for (let i = 0; i < 2; i++) qRemain[i] = -2;
    vsBottom = -1;
    setCrate(false, false); // drawer or page content, depending on the mode
    if (mode === 'video') syncVsBottom();
    else waves.invalidate();
  }

  /**
   * The element deck `deck`'s YouTube player lives in: created once, never moved or re-created by the
   * view. Mount the player INSIDE it (the IFrame API replaces the element it is given with its iframe,
   * so hand it a child, not the slot). The slot is ≥ 200×200 CSS px in video mode; its children are
   * stretched to fill it.
   * @param {0|1} deck
   */
  const videoSlot = (deck) => vstage.slot(deck === 1 ? 1 : 0);

  function destroy() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    attract.stop();
    mixer.destroy();
    deckUi[0].destroy();
    deckUi[1].destroy();
    vsRo.disconnect();
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
    inputError,
    frame,
    setStageMode,
    videoSlot,
    destroy,
    /** @internal test hook: waveform tile-cache statistics, the video stage */
    _debug: () => ({ waves: waves._stats(), stage: stageMode, vstage: vstage._state() }),
  };
}

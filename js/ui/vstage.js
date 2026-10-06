// The video stage: full songs play in YouTube's embedded player, one player per deck.
//
// The view owns two slot elements, created once in template.js and never moved, re-created, hidden or
// drawn over (moving an iframe in the DOM reloads it; YouTube's terms forbid covering, hiding or shrinking
// the player). The integrator mounts a player INSIDE each slot (view.videoSlot(deck)). Everything a deck
// has to say — its letter, what it is doing, the song, a progress bar with the leave point — is laid out
// around the slot, never on it. The cued deck is not dimmed (its ad has to be shown in plain view): its
// frame and label say "cued" instead.
//
// set() runs when a deck's DeckView changes; frame() runs every animation frame and touches the DOM only
// when a displayed value changes (quantized, allocation-free).

import { clamp01, fmtTime, setText } from './dom.js';

/** What each DeckView.status says when the integrator does not pass its own statusText. */
const STATUS_TEXT = {
  ad: 'Cued · ad playing',
  loading: 'Loading',
  cued: 'Cued · ready',
  live: 'Live',
  mixing: 'Mixing',
  error: 'Couldn’t play this one',
};

/** A deck playing a song's 30-second preview through the mixer (its video would not play). Whatever its
 * player still shows is not what is heard, so the screen is not lit as the one on air (CSS) and the
 * label says where the sound comes from. */
const PREVIEW_PROVIDERS = new Set(['preview', 'deezer', 'itunes']);
const PREVIEW_TEXT = { live: 'No video · its 30-s preview', mixing: 'Mixing · 30-s preview' };
const PREVIEW_WHY = 'No video for this song — its 30-second preview plays through the mixer';

/**
 * @param {HTMLElement} root the .vstage section
 */
export function createVStage(root) {
  const decks = [0, 1].map((i) => {
    const el = /** @type {HTMLElement} */ (root.querySelector(`[data-vdeck="${i}"]`));
    const part = (name) => /** @type {HTMLElement} */ (el.querySelector(`[data-part="${name}"]`));
    return {
      el,
      slot: /** @type {HTMLElement} */ (el.querySelector('.vslot')),
      status: part('status'),
      title: part('title'),
      artist: part('artist'),
      time: part('time'),
      fill: /** @type {HTMLElement} */ (el.querySelector('.vbar-fill')),
      leave: /** @type {HTMLElement} */ (el.querySelector('.vbar-leave')),
      /** @type {any} */
      view: null,
      st: 'empty',
      base: '',
      qText: NaN,
      qFill: -1,
      qLeave: -2,
      qTime: NaN,
    };
  });

  function setStatus(dk, st) {
    if (st === dk.st) return;
    dk.st = st;
    dk.el.dataset.status = st;
  }

  /** @param {0|1} i @param {any|null} v DeckView */
  function set(i, v) {
    const dk = decks[i === 1 ? 1 : 0];
    dk.view = v || null;
    dk.qText = NaN;
    dk.qFill = -1;
    dk.qLeave = -2;
    dk.qTime = NaN;
    // a deck can carry a 30-second preview instead of a video (no player in its slot): the CSS says so
    dk.el.dataset.provider = dk.view && typeof dk.view.provider === 'string' ? dk.view.provider : '';
    if (!dk.view) {
      setStatus(dk, 'empty');
      dk.base = '';
      setText(dk.status, 'Empty');
      setText(dk.title, 'Waiting for a track');
      setText(dk.artist, '');
      setText(dk.time, '');
      dk.title.removeAttribute('title');
      dk.status.removeAttribute('title');
      dk.fill.style.transform = 'scaleX(0)';
      dk.leave.hidden = true;
      return;
    }
    const st = STATUS_TEXT[dk.view.status] ? dk.view.status : 'cued';
    setStatus(dk, st);
    const preview = PREVIEW_PROVIDERS.has(dk.el.dataset.provider) && !!PREVIEW_TEXT[st];
    dk.base = typeof dk.view.statusText === 'string' && dk.view.statusText ? dk.view.statusText : preview ? PREVIEW_TEXT[st] : STATUS_TEXT[st];
    setText(dk.status, dk.base);
    if (preview) dk.status.title = PREVIEW_WHY;
    else dk.status.removeAttribute('title');
    setText(dk.title, dk.view.title || 'Untitled');
    dk.title.title = dk.view.title || '';
    setText(dk.artist, dk.view.artist || '');
    dk.fill.style.transform = 'scaleX(0)';
    dk.leave.hidden = true;
  }

  /**
   * @param {0|1} i
   * @param {any|null} fd DeckFrame (pos, startsIn, duration?, leaveAt?)
   */
  function frame(i, fd) {
    const dk = decks[i];
    const v = dk.view;
    if (!v) return;
    const pos = fd && Number.isFinite(fd.pos) ? fd.pos : 0;
    const known = fd && fd.duration > 0 && fd.duration < 1e6 ? fd.duration : v.duration;
    const dur = known > 0 ? known : 0;
    const at = fd && fd.leaveAt > 0 && (!dur || fd.leaveAt < dur) ? fd.leaveAt : 0;

    // Status line. One number per state so the text is rebuilt only when it changes:
    //   ≥ 0  live: seconds until it is left (or until the song ends)
    //   −1   the plain status words
    //   ≤ −10 cued with a known start: starts in (−code − 10) s
    let code = -1;
    if (dk.st === 'live' && dur > 0) {
      const end = at > pos ? at : dur;
      const left = Math.ceil(end - pos);
      code = left > 0 ? (left < 35999 ? left : 35999) : 0;
    } else if (dk.st === 'cued' && fd && fd.startsIn > 0 && fd.startsIn < Infinity && !v.statusText) {
      const wait = Math.ceil(fd.startsIn);
      code = -10 - (wait < 35999 ? wait : 35999);
    }
    if (code !== dk.qText) {
      dk.qText = code;
      setText(dk.status, code >= 0 ? `${dk.base} · −${fmtTime(code)}` : code <= -10 ? `Cued · in ${fmtTime(-code - 10)}` : dk.base);
    }

    // Progress bar under the screen, with the leave point marked.
    const fill = dur > 0 ? Math.round(clamp01(pos / dur) * 1000) : 0;
    if (fill !== dk.qFill) {
      dk.qFill = fill;
      dk.fill.style.transform = `scaleX(${(fill / 1000).toFixed(3)})`;
    }
    const leave = dur > 0 && at > 0 ? Math.round((at / dur) * 1000) : -1;
    if (leave !== dk.qLeave) {
      dk.qLeave = leave;
      dk.leave.hidden = leave < 0;
      if (leave >= 0) dk.leave.style.left = `${(leave / 10).toFixed(1)}%`;
    }

    // "1:12 / 3:45 · out 1:30" — the string is only built when one of its seconds changes
    const s = pos > 0 ? Math.min(35999, Math.floor(dur > 0 && pos > dur ? dur : pos)) : 0;
    const d = Math.min(99999, Math.round(dur));
    const o = at > 0 ? Math.min(99999, Math.round(at)) : -1;
    const key = (s * 100000 + d) * 100001 + (o + 1);
    if (key !== dk.qTime) {
      dk.qTime = key;
      setText(dk.time, d > 0 ? `${fmtTime(s)} / ${fmtTime(d)}${o >= 0 ? ` · out ${fmtTime(o)}` : ''}` : '');
    }
  }

  return {
    set,
    frame,
    /** @param {0|1} i */
    slot: (i) => decks[i === 1 ? 1 : 0].slot,
    /** @internal test hook */
    _state: () => decks.map((dk) => ({ status: dk.st, text: dk.status.textContent })),
  };
}

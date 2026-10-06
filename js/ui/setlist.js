// Setlist / crate: played, playing, mixing, next, queued, loading, failed.
// Rows are keyed by item.key and reused across updates, so artwork is not reloaded and the list does not
// flicker when the conductor re-sends the whole list every few seconds.

import { el, setImage, setLink, setText } from './dom.js';
import { ICONS } from './template.js';

const STATE_LABEL = {
  played: 'Played',
  playing: 'Now',
  mixing: 'Mixing',
  next: 'Next',
  queued: '',
  loading: 'Finding',
  failed: 'No audio',
};

/**
 * @param {HTMLElement} list  the <ol>
 * @param {{count: HTMLElement, empty: HTMLElement}} extra
 */
export function createSetlist(list, extra) {
  /** @type {Map<string, any>} */
  const rows = new Map();
  // The row the list last followed, and where it was. Both count: after New Set the song on air keeps
  // its key but the played rows above it are gone, so it moves to the top while the key stays the same.
  let focusKey = '';
  let focusIdx = -1;
  let lastUserScroll = -Infinity; // not 0: the first seconds of a page are not "the user just scrolled"
  /** @type {[any, any]} */
  let deckViews = [null, null];
  /** @type {any[]} */
  let current = [];

  list.addEventListener('wheel', () => (lastUserScroll = performance.now()), { passive: true });
  list.addEventListener('touchmove', () => (lastUserScroll = performance.now()), { passive: true });

  function makeRow() {
    const li = el('li', 'sl');
    const art = el('span', 'sl-art');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy'; // long playlists: only fetch thumbnails that scroll into view
    img.draggable = false;
    const eq = el('i', 'sl-eq');
    eq.append(el('i'), el('i'), el('i'));
    art.append(img, eq);
    const main = el('div', 'sl-main');
    const title = el('p', 'sl-title');
    const artist = el('p', 'sl-artist');
    const via = el('p', 'sl-via');
    main.append(title, artist);
    const chips = el('div', 'sl-chips');
    const bpm = el('span', 'sl-chip sl-bpm');
    const key = el('span', 'sl-chip sl-key');
    chips.append(bpm, key);
    const state = el('span', 'sl-state');
    const link = /** @type {HTMLAnchorElement} */ (el('a', 'sl-link'));
    // Static icon markup (no dynamic data).
    link.innerHTML = ICONS.out;
    link.hidden = true;
    li.append(art, main, chips, state, via, link);
    return { li, img, title, artist, via, chips, bpm, key, state, link, sig: '' };
  }

  /** Which deck (0/1) a row belongs to, so "playing" rows can carry that deck's colour. */
  function deckOf(it) {
    if (it.deck === 0 || it.deck === 1) return it.deck;
    if (it.state !== 'playing' && it.state !== 'mixing' && it.state !== 'next') return -1;
    for (let d = 0; d < 2; d++) {
      const v = deckViews[d];
      if (v && v.title === it.title && v.artist === it.artist) return d;
    }
    return -1;
  }

  function update(row, it) {
    const deck = deckOf(it);
    const sig = `${it.state}|${deck}|${it.title}|${it.artist}|${it.artwork || ''}|${it.bpm || ''}|${it.camelot || ''}|${it.via || ''}|${it.link || ''}`;
    if (sig === row.sig) return;
    row.sig = sig;
    row.li.dataset.state = it.state;
    if (deck >= 0) row.li.dataset.deck = String(deck);
    else delete row.li.dataset.deck;
    setText(row.title, it.title || 'Untitled');
    setText(row.artist, it.artist || '');
    setText(row.via, it.via && it.state !== 'queued' && it.state !== 'failed' ? it.via : '');
    row.via.hidden = !row.via.textContent;
    setText(row.bpm, it.bpm ? String(Math.round(it.bpm)) : '');
    row.bpm.hidden = !it.bpm;
    setText(row.key, it.camelot || '');
    row.key.hidden = !it.camelot;
    row.chips.hidden = !it.bpm && !it.camelot;
    setText(row.state, STATE_LABEL[it.state] ?? '');
    row.state.hidden = !STATE_LABEL[it.state];
    setImage(row.img, it.artwork);
    if (setLink(row.link, it.link)) row.link.setAttribute('aria-label', `Open ${it.title || 'track'} at its source`);
    if (it.state === 'playing' || it.state === 'mixing') row.li.setAttribute('aria-current', 'true');
    else row.li.removeAttribute('aria-current');
  }

  /**
   * @param {any[]} items SetlistItem[]
   * @param {{crate?: number}} [info] crate: how many different tracks the crate can play. The list
   *   itself is not that number: it holds replays once the crate has come round, and leaves out what
   *   is not queued yet. Without it the header falls back to counting the rows.
   */
  function set(items, info) {
    current = Array.isArray(items) ? items : [];
    const seen = new Set();
    let prev = null;
    let played = 0;
    let nowKey = '';
    let nowIdx = -1;
    for (const it of current) {
      if (!it || it.key == null) continue;
      const key = String(it.key);
      if (seen.has(key)) continue; // duplicate keys would fight over one row
      seen.add(key);
      let row = rows.get(key);
      if (!row) {
        row = makeRow();
        rows.set(key, row);
      }
      update(row, it);
      const want = prev ? prev.nextSibling : list.firstChild;
      if (row.li !== want) list.insertBefore(row.li, want);
      prev = row.li;
      if (it.state === 'played') played++;
      if (!nowKey && (it.state === 'playing' || it.state === 'mixing')) {
        nowKey = key;
        nowIdx = seen.size - 1;
      }
    }
    for (const [key, row] of rows) {
      if (seen.has(key)) continue;
      row.li.remove();
      rows.delete(key);
    }
    extra.empty.hidden = seen.size > 0;
    const crate = info && Number.isFinite(info.crate) && info.crate >= 0 ? Math.round(info.crate) : seen.size;
    setText(extra.count, seen.size ? `${played} played · ${crate} in the crate` : '');

    // Follow the playing track unless the user just scrolled the list themselves — when it changes, and
    // when the rows above it change (New Set keeps the song on air but drops the played rows).
    if (nowKey && (nowKey !== focusKey || nowIdx !== focusIdx)) {
      focusKey = nowKey;
      focusIdx = nowIdx;
      if (performance.now() - lastUserScroll > 4000) follow();
    }
  }

  /** Scroll the list so the row on air sits near its top (nothing to do when nothing is on air). */
  function follow() {
    const row = focusKey ? rows.get(focusKey) : null;
    if (!row) return;
    const top = row.li.offsetTop - list.clientHeight * 0.28;
    list.scrollTop = top > 0 ? top : 0;
  }

  /** Called when a deck is (un)loaded so rows can pick up the deck colour. */
  function setDecks(views) {
    deckViews = views;
    for (const it of current) {
      const row = it && rows.get(String(it.key));
      if (row) update(row, it);
    }
  }

  /** The list was just opened at a new size (a sheet): bring the row on air into view. */
  const reveal = () => follow();

  return { set, setDecks, reveal };
}

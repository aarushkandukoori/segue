// ui-demo.html?mode=video: a mock FULL-SONG set for the view. No audio, no network, no YouTube — the two
// "players" are plain placeholder boxes mounted in the view's video slots, the way js/main.js mounts the
// real IFrame players.
//
// The schedule mimics what the full-song conductor does (SPEC §6): the first song sits behind its
// pre-roll ad (TransitionView 'starting'), the next song is cued on the free deck and plays its own ad
// muted, in plain view ('ad' → 'cued'), the live song is left at its leave point (short ≈ 45 s, medium
// ≈ 90 s, full = the outro), and the hand-over is a volume move — no beat grid exists for a full song.

import { mulberry32 } from './mock.js';

const AD_FIRST = 9; // seconds of pre-roll before the first song (real ads: 20–40 s)
const PRELOAD_ADS = [16, 23, 19, 27]; // muted pre-roll on the cued deck
const CUE_AFTER = 1.5; // seconds after a deck is freed that the next song is cued on it
const ANNOUNCE = 10;
const MOVES = [
  { type: 'crossfade', len: 10, label: 'Crossfade · 10 s', marks: ['Bring in', 'Even', 'Fade out'] },
  { type: 'longBlend', len: 16, label: 'Long blend · 16 s', marks: ['Bring in', 'Swap', 'Ease out'] },
  { type: 'fadeDrop', len: 6, label: 'Fade out, drop in', marks: ['Fade out', 'Drop'] },
  { type: 'cut', len: 0.4, label: 'Cut on the phrase', marks: ['Cut'] },
];
const WHY = 'Full songs from YouTube: no beat grid, so a volume move instead of a beat-matched blend';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Song position where a track is left in this mode (seeded, like videomix.leavePoint). */
function leavePoint(mode, dur, rnd, moveLen) {
  if (mode === 'short') return Math.min(dur - moveLen - 4, 42 + rnd() * 8);
  if (mode === 'full') return Math.max(30, dur - (8 + rnd() * 12) - moveLen);
  return Math.min(dur - moveLen - 4, 84 + rnd() * 14);
}

/**
 * @param {string} seed
 * @param {any[]} tracks  {title, artist, artwork, durationS, ...}
 * @param {'short'|'medium'|'full'} mode
 */
export function createVideoSet(seed, tracks, mode) {
  const rnd = mulberry32(hash(`${seed}|video`));
  const order = tracks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const shift = Math.floor(rnd() * MOVES.length);
  /** @type {any[]} */
  const plays = [];
  /** @type {any[]} */
  const trans = [];

  function moveFor(k) {
    // the first hand-overs show the long moves; cuts come later
    return MOVES[(k - 1 + shift) % MOVES.length];
  }

  function addPlay(k) {
    const T = tracks[order[k % order.length]];
    const out = moveFor(k + 1);
    const p = { id: k, track: T, deck: k % 2, duration: T.durationS, startAt: 0, loadAt: 0, adUntil: 0, leaveAt: 0, endAt: Infinity, inEnd: 0 };
    p.leaveAt = leavePoint(mode, T.durationS, rnd, out.len);
    if (k === 0) {
      p.loadAt = 0;
      p.adUntil = AD_FIRST;
      p.startAt = AD_FIRST;
      p.inEnd = AD_FIRST + 1.2;
      trans.push({ id: 0, type: 'start', state0: 'starting', label: 'Starting the set', why: 'YouTube plays an ad before the first song — muted here; the set starts when it ends', tStart: AD_FIRST, tEnd: AD_FIRST + 1.2, announceAt: -Infinity, marks: [] });
    } else {
      const P = plays[k - 1];
      const mv = moveFor(k);
      const tStart = P.startAt + P.leaveAt;
      const tEnd = tStart + mv.len;
      // the deck this song goes on was freed when the song before last finished
      p.loadAt = k === 1 ? AD_FIRST + 2 : trans[k - 1].tEnd + CUE_AFTER;
      p.adUntil = Math.min(tStart - 4, p.loadAt + PRELOAD_ADS[k % PRELOAD_ADS.length]);
      p.startAt = mv.type === 'fadeDrop' ? tEnd : tStart;
      p.inEnd = tEnd;
      P.endAt = tEnd;
      const marks = mv.marks.map((label, i) => ({ t: tStart + (mv.marks.length === 1 ? 0 : (mv.len * i) / (mv.marks.length - 1)), label }));
      trans.push({ id: k, type: mv.type, label: mv.label, why: WHY, tStart, tEnd, announceAt: tStart - ANNOUNCE, marks, from: k - 1, to: k });
    }
    plays.push(p);
  }

  /** Volume (0..1) of play p at set time t: the hand-over is a volume move. */
  function volume(p, t) {
    if (t < p.startAt || t >= p.endAt) return 0;
    const tin = trans[p.id];
    let v = 1;
    if (p.id > 0 && t < tin.tEnd) {
      const u = (t - tin.tStart) / Math.max(0.01, tin.tEnd - tin.tStart);
      if (tin.type === 'crossfade') v = u;
      else if (tin.type === 'longBlend') v = Math.min(1, u * 1.6);
      else v = 1;
    }
    const tout = trans[p.id + 1];
    if (tout && t >= tout.tStart) {
      const u = (t - tout.tStart) / Math.max(0.01, tout.tEnd - tout.tStart);
      if (tout.type === 'crossfade' || tout.type === 'fadeDrop') v *= 1 - u;
      else if (tout.type === 'longBlend') v *= Math.min(1, (1 - u) * 1.6);
      else v = 0;
    }
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** What a deck shows for play p at set time t, or '' when p is not on its deck. */
  function status(p, t) {
    if (t < p.loadAt || t >= p.endAt) return '';
    if (t < p.adUntil) return 'ad';
    if (t < p.startAt) return 'cued';
    if (t < p.inEnd && p.id > 0) return 'mixing';
    const tout = trans[p.id + 1];
    if (tout && t >= tout.tStart) return 'mixing';
    return 'live';
  }

  return {
    seed,
    mode,
    order,
    plays,
    trans,
    volume,
    status,
    ensure(k) {
      while (plays.length <= k + 1) addPlay(plays.length);
    },
  };
}

/**
 * A placeholder "player" for one slot: what the real IFrame player would be showing, as plain text.
 * @param {HTMLElement} slot  view.videoSlot(i)
 * @param {string} letter
 */
export function mountPlaceholder(slot, letter) {
  const box = document.createElement('div');
  box.className = 'demo-yt';
  const badge = document.createElement('span');
  badge.className = 'demo-yt-badge';
  badge.textContent = `YouTube player · deck ${letter}`;
  const what = document.createElement('p');
  what.className = 'demo-yt-what';
  const sub = document.createElement('p');
  sub.className = 'demo-yt-sub';
  const note = document.createElement('span');
  note.className = 'demo-yt-note';
  note.textContent = 'placeholder — the demo plays no video';
  box.append(badge, what, sub, note);
  slot.appendChild(box);
  let sig = '';
  return {
    box,
    /** @param {string} st @param {any} track */
    show(st, track) {
      const next = `${st}|${track ? track.title : ''}`;
      if (next === sig) return;
      sig = next;
      box.dataset.status = st || 'empty';
      if (!st || !track) {
        what.textContent = 'No video';
        sub.textContent = '';
      } else if (st === 'ad') {
        what.textContent = 'Ad';
        sub.textContent = 'Pre-roll, muted — the song is held at 0:00';
      } else if (st === 'cued') {
        what.textContent = track.title;
        sub.textContent = 'Paused at the start, ready';
      } else {
        what.textContent = track.title;
        sub.textContent = track.artist;
      }
    },
  };
}

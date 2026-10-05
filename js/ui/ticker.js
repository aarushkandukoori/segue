// "What the DJ is doing": the next transition with a countdown, turning into a progress bar whose steps
// ("Bass swap", "Drop") light up as they pass.
//
// set() rebuilds the (few) DOM nodes when the transition changes; frame() only moves the bar and flips
// classes. Screen-reader announcements happen once per state change, never per frame.
//
// Two more things a TransitionView can say:
//   state 'waiting' — the set is running but nothing can play (the crate ran dry: the connection is
//     gone, or the next track is still loading). The ticker says so, and why, for as long as it lasts.
//   trick — a mid-solo trick ("Beat repeat") on the track that is playing, while the next transition
//     is already announced. It shows as a pill for its second or two and never replaces "Next: …".

import { clamp01, el, fmtTime, setText } from './dom.js';

/**
 * @param {HTMLElement} root the .ticker section
 * @param {Record<string, HTMLElement>} R refs
 */
export function createTicker(root, R) {
  /** @type {any} */
  let tv = null;
  let sig = '';
  /** @type {{t:number, chip:HTMLElement, notch:HTMLElement}[]} */
  let marks = [];
  let passed = 0;
  let t0 = NaN; // set time of the first frame after an "upcoming" transition appeared
  let qFill = -1;
  let qCount = -1;
  let idleTitle = '';
  let trickSig = '';

  function clearMarks() {
    R['tk-marks'].textContent = '';
    R['tk-notches'].textContent = '';
    marks = [];
    passed = 0;
  }

  function paintFill(v) {
    const q = Math.round(clamp01(v) * 1000);
    if (q === qFill) return;
    qFill = q;
    // clip rather than scale, so the from→to colour gradient is revealed instead of squashed
    R['tk-fill'].style.clipPath = `inset(0 ${(100 - q / 10).toFixed(1)}% 0 0)`;
  }

  /** The pill for a mid-solo trick: shown while tv.trick is there, announced once, gone with it. */
  function paintTrick() {
    const trick = tv && tv.state === 'upcoming' && tv.trick && tv.trick.label ? tv.trick : null;
    const next = trick ? `${trick.label}@${trick.tStart}` : '';
    if (next === trickSig) return;
    trickSig = next;
    setText(R['tk-trick'], trick ? String(trick.label) : '');
    R['tk-trick'].hidden = !trick;
    // Its own live region: "Next: …" was announced when the transition appeared and is not said again.
    if (trick) setText(R['tk-trick-live'], `${trick.label}${trick.on ? ` on ${trick.on}` : ''}.`);
  }

  /**
   * @param {any|null} v TransitionView
   * @param {{from: number, to: number}} [sides] deck index (0/1) of the outgoing / incoming track, −1 if unknown
   */
  function set(v, sides) {
    const waiting = !!v && v.state === 'waiting';
    const next = v
      ? `${v.state}|${v.type}|${v.label}|${v.fromTitle}|${v.toTitle}|${v.tStart}|${v.tEnd}|${(v.marks || []).length}${waiting ? `|${v.why}` : ''}`
      : '';
    tv = v || null;
    if (sides) {
      root.dataset.from = String(sides.from);
      root.dataset.to = String(sides.to);
    }
    paintTrick(); // comes and goes while the transition itself (and so `sig`) stays the same
    if (next === sig) return;
    const prevState = sig.split('|')[0];
    sig = next;
    qFill = qCount = -1;
    clearMarks();

    if (!tv) {
      root.dataset.state = 'idle';
      setText(R['tk-tag'], 'On air');
      paintIdle();
      setText(R['tk-count-lbl'], '');
      setText(R['tk-count'], '');
      paintFill(0);
      return;
    }

    if (waiting) {
      // Nothing is on air and nothing is announced: no countdown, no bar — what the set waits for.
      root.dataset.state = 'waiting';
      setText(R['tk-tag'], 'Standby');
      setText(R['tk-label'], tv.label || 'Waiting for the next track');
      setText(R['tk-to'], '');
      setText(R['tk-why'], tv.why || '');
      setText(R['tk-count-lbl'], '');
      setText(R['tk-count'], '');
      paintFill(0);
      setText(R['tk-live'], `${tv.label || 'Waiting for the next track'}.${tv.why ? ` ${tv.why}` : ''}`);
      return;
    }

    const active = tv.state === 'active';
    root.dataset.state = active ? 'active' : 'upcoming';
    setText(R['tk-tag'], active ? 'Mixing' : 'Next');
    setText(R['tk-label'], tv.label || 'Transition');
    setText(R['tk-to'], active && tv.fromTitle ? `${tv.fromTitle} → ${tv.toTitle || ''}` : tv.toTitle ? `into ${tv.toTitle}` : '');
    setText(R['tk-why'], tv.why || '');
    setText(R['tk-count-lbl'], active ? 'Left' : 'In');
    if (!active || prevState !== 'upcoming') t0 = NaN;

    const span = tv.tEnd - tv.tStart;
    const list = Array.isArray(tv.marks) ? tv.marks.slice(0, 6) : [];
    for (const m of list) {
      const chip = el('li', 'tk-mark', m.label);
      const notch = el('i', 'tk-notch');
      notch.style.left = `${(span > 0 ? clamp01((m.t - tv.tStart) / span) : 0) * 100}%`;
      R['tk-marks'].appendChild(chip);
      R['tk-notches'].appendChild(notch);
      marks.push({ t: m.t, chip, notch });
    }

    setText(
      R['tk-live'],
      active
        ? `Mixing: ${tv.label}. ${tv.fromTitle ? `${tv.fromTitle} into ${tv.toTitle}.` : ''}`
        : `Next: ${tv.label}${tv.toTitle ? `, into ${tv.toTitle}` : ''}.`,
    );
  }

  function paintIdle() {
    if (tv) return;
    setText(R['tk-label'], idleTitle ? 'Letting it play' : 'Warming up');
    setText(R['tk-to'], idleTitle || '');
    setText(R['tk-why'], idleTitle ? 'Lining up the next blend…' : 'Lining up the first track…');
  }

  /** Title of the track that is playing solo (shown while no transition is planned). */
  function setIdleTitle(title) {
    if (title === idleTitle) return;
    idleTitle = title || '';
    paintIdle();
  }

  /** @param {number} t set time */
  function frame(t) {
    if (!tv || tv.state === 'waiting') return;
    if (tv.state === 'active') {
      const span = tv.tEnd - tv.tStart;
      paintFill(span > 0 ? (t - tv.tStart) / span : 1);
      const left = Math.max(0, Math.ceil(tv.tEnd - t));
      if (left !== qCount) {
        qCount = left;
        setText(R['tk-count'], fmtTime(left));
      }
      // marks can move in either direction if time jumps (seek / new plan)
      let p = passed;
      while (p < marks.length && t >= marks[p].t) p++;
      while (p > 0 && t < marks[p - 1].t) p--;
      if (p !== passed) {
        for (let i = 0; i < marks.length; i++) {
          marks[i].chip.classList.toggle('is-passed', i < p - 1);
          marks[i].chip.classList.toggle('is-now', i === p - 1);
          marks[i].notch.classList.toggle('is-passed', i < p);
        }
        passed = p;
      }
    } else {
      if (!(t0 <= t)) t0 = t;
      const total = tv.tStart - t0;
      paintFill(total > 0.5 ? (t - t0) / total : 0);
      const left = Math.max(0, Math.ceil(tv.tStart - t));
      if (left !== qCount) {
        qCount = left;
        setText(R['tk-count'], fmtTime(left));
      }
    }
  }

  return { set, setIdleTitle, frame };
}

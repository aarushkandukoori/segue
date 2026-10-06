// The centre mixer. Nobody touches it — it is driven from FrameState every frame so the audience can watch
// the DJ's hands: channel faders, 3-band EQ (with kills), a bipolar filter knob (left = low-pass,
// right = high-pass, derived from hpf/lpf), the crossfader and the master meter.
//
// Every control keeps the last value it painted (quantized), so a frame in which nothing moved costs a
// few comparisons and zero style writes.
//
// Full songs play in YouTube's player, whose audio never reaches the page: a deck whose DeckFrame says
// `eqActive: false` shows its EQ / filter knobs at rest and inactive (with the reason), and in video mode
// the master meter, which could only hear the Web Audio side, is switched off rather than faked.
// Faders and the crossfader still follow `gain` — the player's volume is the one control there is.

import { clamp, clamp01 } from './dom.js';

const ARC_PER_DEG = (2 * Math.PI * 21) / 360; // k-val circle: r=21 in a 48-unit viewBox
const LOG_1000 = Math.log(1000);
const KILL_DB = -24;
const EQ_WHY = 'EQ works on previews — YouTube audio can’t be processed';
const METER_WHY = 'The master meter can’t hear YouTube’s player';
const METER_STEPS = 24;
const VU_STEPS = 20;

/** EQ gain in dB → knob angle. 0 dB at 12 o'clock, −28 dB ("kill") hard left, +6 dB hard right. */
const eqAngle = (db) => (db >= 0 ? (Math.min(db, 6) / 6) * 135 : (Math.max(db, -28) / 28) * 135);

/** hpf/lpf cutoffs → one bipolar value: −1 (low-pass fully closed) … 0 (open) … +1 (high-pass fully up). */
export function filterValue(hpf, lpf) {
  const h = hpf > 22 ? Math.log(hpf / 20) / LOG_1000 : 0;
  const l = lpf > 0 && lpf < 19000 ? 1 - Math.log(lpf / 20) / LOG_1000 : 0;
  return h >= l ? clamp01(h) : -clamp01(l);
}

/** Linear level → 0..1 on a dB scale with a −48 dB floor. */
const meterScale = (lin) => (lin > 0.004 ? clamp01(1 + (20 * Math.log10(lin)) / 48) : 0);

/** @param {HTMLElement} root  the .mixer section */
export function createMixer(root) {
  const channels = [0, 1].map((i) => {
    const ch = root.querySelector(`[data-ch="${i}"]`);
    const knob = (id) => {
      const k = ch.querySelector(`[data-knob="${id}"]`);
      const val = k.querySelector('.k-val');
      val.style.strokeDasharray = `0 ${(360 * ARC_PER_DEG).toFixed(2)}`;
      return { el: k, cap: k.querySelector('.knob-cap'), val, lbl: k.querySelector('.knob-lbl'), q: 0, flag: '' };
    };
    return {
      el: ch,
      high: knob('high'),
      mid: knob('mid'),
      low: knob('low'),
      filter: knob('filter'),
      fader: ch.querySelector('.fader'),
      cap: ch.querySelector('.fader-cap'),
      fill: ch.querySelector('.fader-fill'),
      vu: ch.querySelector('.vu > i'),
      travel: 0,
      qGain: -1,
      qVu: -1,
      vuLvl: 0,
      on: null,
      eqOff: false,
      knobs: /** @type {HTMLElement[]} */ (Array.from(ch.querySelectorAll('.knobs'))),
    };
  });
  const master = root.querySelector('.master');
  const note = root.querySelector('.mx-note');
  let video = false;
  let noteShown = false;
  const xfSlot = root.querySelector('.xf-slot');
  const xfCap = root.querySelector('.xf-cap');
  const meterLit = root.querySelector('.meter-lit');
  const meterPeak = root.querySelector('.meter-peak');
  const meter = root.querySelector('.meter');

  let xfTravel = 0;
  let qXf = NaN;
  let meterH = 0;
  let qMeter = -1;
  let qPeak = -1;
  let rmsLvl = 0;
  let peakLvl = 0;
  let peakHold = 0;

  // Travel distances are measured here (never inside frame()).
  const ro = new ResizeObserver(() => {
    for (const c of channels) {
      c.travel = Math.max(0, c.fader.clientHeight - c.cap.offsetHeight);
      c.qGain = -1;
    }
    xfTravel = Math.max(0, xfSlot.clientWidth - xfCap.offsetWidth);
    qXf = NaN;
    meterH = meter.clientHeight;
    qPeak = -1;
  });
  for (const c of channels) ro.observe(c.fader);
  ro.observe(xfSlot);
  ro.observe(meter);

  function turn(k, angle) {
    const q = Math.round(angle);
    if (q === k.q) return;
    k.q = q;
    k.cap.style.transform = `rotate(${q}deg)`;
    const a = Math.abs(q) * ARC_PER_DEG;
    k.val.style.strokeDasharray = `${a.toFixed(2)} ${(360 * ARC_PER_DEG).toFixed(2)}`;
    // a negative value draws the arc backwards from 12 o'clock
    k.val.style.strokeDashoffset = q < 0 ? a.toFixed(2) : '0';
  }

  function flag(k, value, text) {
    if (k.flag === value) return;
    k.flag = value;
    if (value) k.el.dataset.flag = value;
    else delete k.el.dataset.flag;
    if (text) k.lbl.textContent = text;
  }

  /**
   * @param {any} f FrameState
   * @param {number} amp0 pre-fader signal on deck A, 0..1
   * @param {number} amp1
   * @param {number} dt seconds since the previous frame
   */
  function frame(f, amp0, amp1, dt) {
    for (let i = 0; i < 2; i++) {
      const c = channels[i];
      const d = f.decks[i];
      const on = !!d;
      if (on !== c.on) {
        c.on = on;
        c.el.classList.toggle('is-off', !on);
      }
      const eqOff = !!d && d.eqActive === false;
      if (eqOff !== c.eqOff) {
        c.eqOff = eqOff;
        c.el.classList.toggle('is-eq-off', eqOff);
        for (const k of c.knobs) {
          if (eqOff) k.title = EQ_WHY;
          else k.removeAttribute('title');
        }
      }
      // an inactive EQ rests at 12 o'clock: whatever the numbers say, nothing is being cut
      const low = d && !eqOff ? d.low : 0;
      const mid = d && !eqOff ? d.mid : 0;
      const high = d && !eqOff ? d.high : 0;
      turn(c.low, eqAngle(low));
      turn(c.mid, eqAngle(mid));
      turn(c.high, eqAngle(high));
      flag(c.low, low <= KILL_DB ? 'kill' : '');
      flag(c.mid, mid <= KILL_DB ? 'kill' : '');
      flag(c.high, high <= KILL_DB ? 'kill' : '');
      const fv = d && !eqOff ? filterValue(d.hpf, d.lpf) : 0;
      turn(c.filter, fv * 135);
      // the filter knob names what it is doing: high-pass to the right, low-pass to the left
      if (fv > 0.02) flag(c.filter, 'hpf', 'Hi-pass');
      else if (fv < -0.02) flag(c.filter, 'lpf', 'Lo-pass');
      else flag(c.filter, '', 'Filter');

      const gain = d ? clamp01(d.gain) : 0;
      const qg = Math.round(gain * 200);
      if (qg !== c.qGain) {
        c.qGain = qg;
        c.cap.style.transform = `translate3d(0,${((1 - qg / 200) * c.travel).toFixed(1)}px,0)`;
        c.fill.style.transform = `scaleY(${(qg / 200).toFixed(3)})`;
      }

      // Pre-fader channel meter, like a real mixer: you see the incoming track before you hear it.
      const target = d && f.playing ? (i === 0 ? amp0 : amp1) : 0;
      c.vuLvl = target > c.vuLvl ? target : Math.max(target, c.vuLvl - dt * 2.4);
      const qv = Math.round(c.vuLvl * VU_STEPS);
      if (qv !== c.qVu) {
        c.qVu = qv;
        c.vu.style.transform = `scaleY(${(qv / VU_STEPS).toFixed(3)})`;
      }
    }

    const showNote = channels[0].eqOff || channels[1].eqOff;
    if (showNote !== noteShown) {
      noteShown = showNote;
      note.hidden = !showNote;
      root.classList.toggle('has-note', showNote);
    }

    const xf = Math.round(clamp(f.crossfade, -1, 1) * 100);
    if (xf !== qXf) {
      qXf = xf;
      xfCap.style.transform = `translate3d(${(((xf + 100) / 200) * xfTravel).toFixed(1)}px,0,0)`;
    }

    // video mode: the meter is off (it would only hear the Web Audio side, never the player)
    const lv = video ? null : f.levels;
    const rms = lv ? meterScale(lv.rms) : 0;
    const peak = lv ? meterScale(lv.peak) : 0;
    rmsLvl = rms > rmsLvl ? rms : Math.max(rms, rmsLvl - dt * 1.6);
    if (peak >= peakLvl) {
      peakLvl = peak;
      peakHold = 0.7;
    } else if (peakHold > 0) peakHold -= dt;
    else peakLvl = Math.max(peak, peakLvl - dt * 0.9);
    const qm = Math.round(rmsLvl * METER_STEPS);
    if (qm !== qMeter) {
      qMeter = qm;
      meterLit.style.clipPath = `inset(${(100 - (qm / METER_STEPS) * 100).toFixed(2)}% 0 0 0)`;
    }
    const qp = Math.round(peakLvl * METER_STEPS);
    if (qp !== qPeak) {
      qPeak = qp;
      meterPeak.style.transform = `translate3d(0,${(-(qp / METER_STEPS) * meterH).toFixed(1)}px,0)`;
      meterPeak.style.opacity = qp > 0 ? '1' : '0';
    }
  }

  /** @param {boolean} on video mode: master meter off */
  function setVideo(on) {
    if (on === video) return;
    video = !!on;
    root.classList.toggle('is-deaf', video);
    if (video) {
      master.title = METER_WHY;
      // drop to silence at once instead of letting the bar fall through the next frames
      rmsLvl = peakLvl = peakHold = 0;
    } else master.removeAttribute('title');
  }

  return { frame, setVideo, destroy: () => ro.disconnect() };
}

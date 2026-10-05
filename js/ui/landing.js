// Landing page "attract mode": a silent, synthetic two-deck waveform that shows the product's one trick —
// deck B's beat grid drifts, gets nudged, and locks onto deck A's — using the same renderer as the stage.
// No audio, no network; it runs its own rAF loop only while the landing screen is showing.

import { createWaves, observeCanvas } from './waves.js';
import { makeTrack } from './mock.js';

const PERIOD = 20; // seconds per drift → lock → release cycle
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Beat offset of deck B relative to deck A at cycle time u (0 = locked). */
function drift(u) {
  if (u < 6) return 0.62 - 0.34 * (u / 6);
  if (u < 8) return 0.28 * (1 - smooth((u - 6) / 2));
  if (u < 16) return 0;
  return 0.62 * smooth((u - 16) / 4);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} lockEl   "Beat lock" lamp
 * @param {{draw: Function}} backdrop
 */
export function createAttract(canvas, lockEl, backdrop) {
  const waves = createWaves(canvas, { labels: false });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fa = { pos: 0, audible: 1, rate: 1 };
  const fb = { pos: 0, audible: 0.5, rate: 124 / 126 };
  const levels = { rms: 0, peak: 0, bands: new Uint8Array(32) };
  /** @type {ReturnType<typeof makeTrack>[]|null} */
  let tracks = null;
  let stopObserving = null;
  let raf = 0;
  let running = false;
  let t = 0;
  let last = 0;
  let locked = null;

  function ensureTracks() {
    if (tracks) return;
    tracks = [
      makeTrack({ seed: 11, bpm: 124, duration: 240, club: true }),
      makeTrack({ seed: 29, bpm: 126, duration: 240, firstBeat: 0.31, club: true }),
    ];
    waves.setDeck(0, tracks[0]);
    waves.setDeck(1, tracks[1]);
  }

  function paint() {
    const [a, b] = tracks;
    const span = a.duration - 40;
    const ta = t % span;
    const u = t % PERIOD;
    const beatA = 60 / a.bpm;
    const beatB = 60 / b.bpm;
    fa.pos = 6 + ta;
    fb.pos = b.beats[0] + ((fa.pos - a.beats[0]) / beatA + 8 + drift(u)) * beatB;
    fb.audible = 0.5 + 0.5 * (smooth((u - 8) / 2) - smooth((u - 14) / 2));
    fa.audible = 1 - 0.4 * (smooth((u - 9) / 2) - smooth((u - 13) / 2));
    const phase = waves.beatPhaseAt(0, fa.pos);
    waves.draw(fa, fb, phase < 0 ? 1 : phase);

    const isLocked = u >= 8 && u < 16;
    if (isLocked !== locked) {
      locked = isLocked;
      lockEl.classList.toggle('is-on', isLocked);
    }

    // feed the backdrop from the synthetic waveform under the playhead so the page breathes in time
    const c = Math.floor(fa.pos * 100);
    const w = a.wave;
    const bands = levels.bands;
    for (let i = 0; i < 32; i++) bands[i] = i < 4 ? w.low[c] : i < 14 ? w.mid[c] * 0.7 : w.high[c] * 0.5;
    backdrop.draw(levels, phase < 0 ? 1 : phase, fa.audible, fb.audible, 0.55, !running);
  }

  function loop(now) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    t += dt;
    paint();
  }

  function start() {
    if (running) return;
    ensureTracks();
    if (!stopObserving) {
      stopObserving = observeCanvas(canvas, (w, h, dpr) => {
        waves.resize(w, h, dpr);
        // a resize while idle (reduced motion) still needs a repaint
        if (tracks && !raf) paint();
      });
    }
    if (reduce.matches) {
      // Reduced motion: one still frame of the locked state, no loop.
      t = 10;
      waves.invalidate();
      paint();
      return;
    }
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  reduce.addEventListener('change', () => {
    if (reduce.matches) stop();
  });

  return { start, stop, _seek: (v) => { t = v; if (tracks) { waves.invalidate(); paint(); } } };
}

// Audio-reactive backdrop: light spilling from under each deck (warm left, cool right) plus a very faint
// column of spectrum light. Painted into a tiny fixed-size canvas that CSS stretches over the viewport —
// the upscale blur is the look, and it keeps the cost at a few dozen fillRects on ~14 000 pixels.

import { clamp01 } from './dom.js';

const W = 160;
const H = 90;
const BARS = 40;

/** @param {HTMLCanvasElement} canvas */
export function createBackdrop(canvas) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const glow = (x, y, r, rgb) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(0.45, `rgba(${rgb},0.32)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    return g;
  };
  // Gradients are built once; per frame only globalAlpha changes.
  const glowA = glow(W * 0.1, H * 1.08, W * 0.62, '255,122,60');
  const glowB = glow(W * 0.9, H * 1.08, W * 0.62, '63,210,255');
  const haze = glow(W * 0.5, -H * 0.35, W * 0.7, '244,238,227');
  const barColors = [];
  for (let i = 0; i < BARS; i++) {
    const k = i / (BARS - 1);
    // ember → bone → ice across the width
    const r = Math.round(k < 0.5 ? 255 + (244 - 255) * k * 2 : 244 + (63 - 244) * (k - 0.5) * 2);
    const g = Math.round(k < 0.5 ? 122 + (238 - 122) * k * 2 : 238 + (210 - 238) * (k - 0.5) * 2);
    const b = Math.round(k < 0.5 ? 60 + (227 - 60) * k * 2 : 227 + (255 - 227) * (k - 0.5) * 2);
    barColors.push(`rgb(${r},${g},${b})`);
  }
  const bars = new Float32Array(BARS);

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let calm = mq.matches;
  mq.addEventListener('change', () => {
    calm = mq.matches;
  });

  let low = 0;
  let a = 0;
  let b = 0;
  let tick = 0;

  /**
   * @param {{bands?: Uint8Array, rms?: number}|null} levels
   * @param {number} beatPhase 0..1
   * @param {number} audA 0..1 how present deck A is
   * @param {number} audB
   * @param {number} intensity 0..1 overall brightness (lower on the landing page)
   * @param {boolean} force paint now and snap to the given values (single still frames)
   */
  function draw(levels, beatPhase, audA, audB, intensity = 1, force = false) {
    // 30 fps is plenty for something this soft; reduced motion gets ~8 fps and no beat pulse.
    tick++;
    if (!force && (calm ? tick % 8 !== 0 : tick % 2 !== 0)) return;
    const bands = levels && levels.bands;
    const n = bands ? bands.length : 0;

    let lowNow = 0;
    if (n) {
      const m = Math.max(1, Math.min(n, Math.ceil(n * 0.06)));
      for (let i = 0; i < m; i++) lowNow += bands[i];
      lowNow /= m * 255;
    }
    const ease = calm ? 0.04 : 0.3;
    low += (lowNow - low) * (lowNow > low ? ease * 2 : ease);
    a += (clamp01(audA) - a) * (force ? 1 : 0.12);
    b += (clamp01(audB) - b) * (force ? 1 : 0.12);
    const kick = calm ? 0 : Math.pow(1 - clamp01(beatPhase), 3);
    const drive = 0.1 + 0.2 * low + 0.1 * kick * (0.4 + low);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    ctx.globalAlpha = intensity * (0.05 + a * drive);
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = intensity * (0.05 + b * drive);
    ctx.fillStyle = glowB;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = intensity * 0.035;
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);

    if (n) {
      // Log-ish spread of the spectrum over the bars, mirrored so the bass sits in the middle.
      const usable = Math.max(1, Math.floor(n * 0.7));
      const half = BARS / 2;
      const rel = calm ? 0.05 : 0.22;
      for (let i = 0; i < half; i++) {
        const k = i / (half - 1);
        const idx = Math.min(n - 1, Math.floor(Math.pow(k, 1.8) * (usable - 1)));
        const v = bands[idx] / 255;
        const li = half - 1 - i;
        const ri = half + i;
        bars[li] += (v - bars[li]) * (v > bars[li] ? 0.6 : rel);
        bars[ri] = bars[li];
      }
      const bw = W / BARS;
      for (let i = 0; i < BARS; i++) {
        const h = bars[i] * bars[i] * H * 0.62;
        if (h < 1) continue;
        ctx.globalAlpha = intensity * 0.075;
        ctx.fillStyle = barColors[i];
        ctx.fillRect(i * bw + 0.5, H - h, bw - 1, h);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  return { draw };
}

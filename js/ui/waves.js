// Scrolling two-deck waveform display (rekordbox / Serato style).
//
// Deck A sits on top growing upwards, deck B below growing downwards; between them is a thin rail where
// each deck's beat ticks reach for the centre line — when two tracks are beat-matched the ticks join up
// into unbroken lines, which is the whole point: you can SEE the grids lock.
//
// Cost model: a track is pre-rendered into 1024-column tiles (1 px per analysis column) the first time
// a tile is needed, and the next tile along is rendered in idle time. A frame is then just a handful of
// drawImage calls. Only a small window of tiles is kept per deck, so a 6-minute track (36 000 columns)
// costs the same per frame, and the same memory, as a 30-second preview.

import { clamp, clamp01 } from './dom.js';

const TILE_COLS = 1024;
const MAX_TILES = 8;

/** Three-band colours per deck: low = deep, mid = the deck accent, high = pale. */
export const DECK_COLORS = [
  { low: '#b3360e', mid: '#ff7a3c', high: '#ffe6cf', tick: '#ffd2b5' },
  { low: '#135fc0', mid: '#3fd2ff', high: '#e2f9ff', tick: '#c4f1ff' },
];
const BONE = '#f4eee3';
const SHADE = 'rgba(7,7,9,0.46)'; // dims the already-played side, left of the playhead
const GUIDE = 'rgba(244,238,227,0.085)'; // bar lines behind the waveform

const whenIdle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 400 })
    : (fn) => setTimeout(fn, 30);

/** CSS pixels per second of audio for a given display width (discrete so the tile scale stays simple). */
function defaultPxPerSec(cssWidth) {
  if (cssWidth < 560) return 50;
  if (cssWidth < 2300) return 100;
  return 150;
}

/**
 * @param {HTMLCanvasElement} canvas  sized by CSS; this module owns its bitmap size
 * @param {{ pxPerSec?: (cssWidth:number)=>number, labels?: boolean }} [opts]
 */
export function createWaves(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const pxPerSecFor = opts.pxPerSec || defaultPxPerSec;
  const showLabels = opts.labels !== false;

  // All geometry in device pixels.
  const geo = { W: 0, H: 0, dpr: 1, laneH: 0, railHalf: 0, th: 0, colPx: 1, cx: 0 };
  const lutLow = new Uint16Array(256);
  const lutMid = new Uint16Array(256);
  const lutHigh = new Uint16Array(256);
  /** @type {HTMLCanvasElement[]} */
  let pool = [];
  let dirty = true;

  const decks = [0, 1].map((i) => ({
    i,
    view: null,
    wave: null,
    perSec: 100,
    cols: 0,
    beats: /** @type {number[]|null} */ (null),
    downbeat: 0,
    cursor: 0,
    restPos: 0,
    /** @type {Map<number, HTMLCanvasElement>} */
    tiles: new Map(),
    pending: -1,
    /** @type {{t:number, label:string, sprite:HTMLCanvasElement|null}[]} */
    markers: [],
    lastPos: NaN,
    lastAud: NaN,
  }));

  function dropTiles(dk, keepPool) {
    for (const cv of dk.tiles.values()) if (keepPool) pool.push(cv);
    dk.tiles.clear();
    dk.pending = -1;
  }

  /** @param {number} cssW @param {number} cssH @param {number} dpr */
  function resize(cssW, cssH, dpr) {
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (W === geo.W && H === geo.H && dpr === geo.dpr) return;
    const railCss = clamp(cssH * 0.15, 16, 36);
    const railHalf = Math.max(4, Math.round((railCss * dpr) / 2));
    const laneH = Math.max(8, Math.floor(H / 2) - railHalf);
    const th = laneH + railHalf;
    const heightChanged = th !== geo.th;
    geo.W = W;
    geo.H = H;
    geo.dpr = dpr;
    geo.laneH = laneH;
    geo.railHalf = railHalf;
    geo.th = th;
    geo.cx = Math.round(W / 2);
    canvas.width = W;
    canvas.height = H;
    geo.colPx = (pxPerSecFor(cssW) * dpr) / 100;
    // Resizing a canvas resets its context state, so it is (re)configured here.
    ctx.imageSmoothingQuality = 'medium';
    if (heightChanged) {
      for (let v = 0; v < 256; v++) {
        const a = Math.pow(v / 255, 0.82);
        lutLow[v] = Math.round(a * laneH * 0.97);
        lutMid[v] = Math.round(a * laneH * 0.8);
        lutHigh[v] = Math.round(a * laneH * 0.56);
      }
      pool = [];
      for (const dk of decks) {
        dropTiles(dk, false);
        buildMarkers(dk);
      }
    }
    dirty = true;
    if (everDrawn) paint();
  }

  function getTileCanvas() {
    const cv = pool.pop() || document.createElement('canvas');
    if (cv.width !== TILE_COLS || cv.height !== geo.th) {
      cv.width = TILE_COLS;
      cv.height = geo.th;
    }
    return cv;
  }

  function firstBeatAtOrAfter(beats, t) {
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (beats[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Render one tile (columns [ti*1024, +1024)) of a deck. ~0.3–1 ms. */
  function renderTile(dk, ti) {
    const { laneH, railHalf, th } = geo;
    const cv = getTileCanvas();
    const g = cv.getContext('2d');
    g.clearRect(0, 0, TILE_COLS, th);
    const pal = DECK_COLORS[dk.i];
    const top = dk.i === 0; // top deck grows up from its baseline, bottom deck grows down
    const base = top ? laneH : railHalf;
    const laneY = top ? 0 : railHalf;
    const c0 = ti * TILE_COLS;
    const c1 = Math.min(dk.cols, c0 + TILE_COLS);
    const n = c1 - c0;
    const beats = dk.beats;
    const perSec = dk.perSec;

    if (beats && beats.length) {
      const b0 = firstBeatAtOrAfter(beats, (c0 - 2) / perSec);
      const b1 = firstBeatAtOrAfter(beats, (c1 + 2) / perSec);
      // bar lines behind the waveform
      g.fillStyle = GUIDE;
      for (let i = b0; i < b1; i++) {
        if ((((i - dk.downbeat) % 4) + 4) % 4 !== 0) continue;
        g.fillRect(Math.round(beats[i] * perSec) - c0, laneY, 1, laneH);
      }
    }

    if (n > 0) {
      const { low, mid, high } = dk.wave;
      g.fillStyle = pal.low;
      g.beginPath();
      for (let c = 0; c < n; c++) {
        const h = lutLow[low[c0 + c]];
        if (h) g.rect(c, top ? base - h : base, 1, h);
      }
      g.fill();
      g.fillStyle = pal.mid;
      g.beginPath();
      for (let c = 0; c < n; c++) {
        const h = lutMid[mid[c0 + c]];
        if (h) g.rect(c, top ? base - h : base, 1, h);
      }
      g.fill();
      g.fillStyle = pal.high;
      g.beginPath();
      for (let c = 0; c < n; c++) {
        const h = lutHigh[high[c0 + c]];
        if (h) g.rect(c, top ? base - h : base, 1, h);
      }
      g.fill();
    }

    return cv;
  }

  function storeTile(dk, ti, cv) {
    dk.tiles.set(ti, cv);
    if (dk.tiles.size > MAX_TILES) {
      // evict the tile furthest from the one just added
      let far = -1;
      let farDist = -1;
      for (const k of dk.tiles.keys()) {
        const d = Math.abs(k - ti);
        if (d > farDist) {
          farDist = d;
          far = k;
        }
      }
      const old = dk.tiles.get(far);
      dk.tiles.delete(far);
      if (old) pool.push(old);
    }
  }

  function tileNow(dk, ti) {
    const cv = renderTile(dk, ti);
    storeTile(dk, ti, cv);
    return cv;
  }

  /** Render tile `ti` in idle time (at most one job in flight per deck). */
  function prefetch(dk, ti) {
    if (ti < 0 || ti * TILE_COLS >= dk.cols || dk.tiles.has(ti) || dk.pending === ti) return;
    dk.pending = ti;
    const view = dk.view;
    const th = geo.th;
    whenIdle(() => {
      if (dk.pending === ti) dk.pending = -1;
      if (dk.view !== view || geo.th !== th || dk.tiles.has(ti)) return;
      tileNow(dk, ti);
    });
  }

  function makeSprite(label, deckIndex) {
    const { dpr } = geo;
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d');
    const font = `600 ${Math.round(9 * dpr)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    g.font = font;
    const w = Math.ceil(g.measureText(label).width + 8 * dpr);
    const h = Math.round(13 * dpr);
    cv.width = w;
    cv.height = h;
    g.font = font;
    g.fillStyle = BONE;
    g.fillRect(0, 0, w, h);
    g.fillStyle = DECK_COLORS[deckIndex].low;
    g.textBaseline = 'middle';
    g.fillText(label, 4 * dpr, h / 2 + 0.5 * dpr);
    return cv;
  }

  function buildMarkers(dk) {
    dk.markers.length = 0;
    const v = dk.view;
    if (!v || !v.cues || !geo.th) return;
    const { cues } = v;
    if (Number.isFinite(cues.in)) dk.markers.push({ t: cues.in, label: 'CUE', sprite: null });
    if (cues.drop != null && Number.isFinite(cues.drop) && Math.abs(cues.drop - cues.in) > 0.5) {
      dk.markers.push({ t: cues.drop, label: 'DROP', sprite: null });
    }
    if (showLabels) for (const m of dk.markers) m.sprite = makeSprite(m.label, dk.i);
  }

  /**
   * Load (or clear) a deck. `view` needs {wave, beats, downbeat, cues}; the typed arrays are read in
   * place, never copied.
   * @param {0|1} i
   * @param {any|null} view
   */
  function setDeck(i, view) {
    const dk = decks[i];
    dropTiles(dk, true);
    dk.view = view && view.wave && view.wave.cols > 0 ? view : null;
    dk.wave = dk.view ? dk.view.wave : null;
    dk.perSec = dk.wave ? dk.wave.perSec || 100 : 100;
    dk.cols = dk.wave ? Math.min(dk.wave.cols, dk.wave.low.length, dk.wave.mid.length, dk.wave.high.length) : 0;
    // number[] per the contract; typed arrays work too
    dk.beats = dk.view && dk.view.beats && dk.view.beats.length > 0 ? dk.view.beats : null;
    dk.downbeat = dk.view ? dk.view.downbeat | 0 : 0;
    dk.cursor = 0;
    dk.restPos = dk.view && dk.view.cues && Number.isFinite(dk.view.cues.in) ? dk.view.cues.in : 0;
    dk.lastPos = NaN;
    buildMarkers(dk);
    dirty = true;
    if (dk.view && geo.th) {
      // Pre-render where playback will start, in idle slices; frame() renders on demand if it gets there first.
      const startTile = Math.max(0, Math.floor((dk.restPos * dk.perSec) / TILE_COLS));
      prefetch(dk, startTile);
    }
  }

  function drawDeck(dk, fd) {
    if (!dk.view) return;
    const { W, H, cx, laneH, th, colPx, dpr } = geo;
    const pos = fd ? fd.pos : dk.restPos;
    const aud = fd ? clamp01(fd.audible) : 0;
    // The x axis is SET time, not buffer time: a deck pitched to 0.976× is drawn 1/0.976 wider, so two
    // beat-matched decks have the same on-screen beat spacing and their grids line up across the whole
    // display (not just at the playhead). Clamped so a brake / spinback does not zoom absurdly.
    const rate = fd && fd.rate > 0 ? clamp(fd.rate, 0.7, 1.4) : 1;
    // colPx is device px per 1/100 s; a wave with a different perSec has proportionally narrower columns.
    const pxPerCol = (colPx * 100) / dk.perSec / rate;
    const x0 = cx - pos * dk.perSec * pxPerCol;
    const cA = Math.max(0, Math.floor(-x0 / pxPerCol));
    const cB = Math.min(dk.cols, Math.ceil((W - x0) / pxPerCol));
    if (cB > cA) {
      const y = dk.i === 0 ? 0 : H - th;
      ctx.globalAlpha = 0.34 + 0.66 * aud;
      ctx.imageSmoothingEnabled = pxPerCol < 1 || Math.abs(pxPerCol - Math.round(pxPerCol)) > 1e-3;
      const t0 = Math.floor(cA / TILE_COLS);
      const t1 = Math.floor((cB - 1) / TILE_COLS);
      for (let ti = t0; ti <= t1; ti++) {
        const tile = dk.tiles.get(ti) || tileNow(dk, ti);
        const dx = Math.round(x0 + ti * TILE_COLS * pxPerCol);
        const dx2 = Math.round(x0 + (ti + 1) * TILE_COLS * pxPerCol);
        ctx.drawImage(tile, 0, 0, TILE_COLS, th, dx, y, dx2 - dx, th);
      }
      prefetch(dk, t1 + 1);
    }
    // Beat ticks live in the rail and are anchored on the centre line, so deck A's ticks and deck B's
    // ticks touch tip-to-tip when the grids are aligned. Drawn per frame (a few dozen rects) rather than
    // baked into the tiles so they stay crisp at any scale and readable even on a silent, cued deck.
    const beats = dk.beats;
    if (beats) {
      const pxPerSec = dk.perSec * pxPerCol;
      const mid = Math.floor(H / 2);
      const railHalf = geo.railHalf;
      const shortH = Math.max(2, Math.round(railHalf * 0.5));
      const wBeat = Math.max(1, Math.round(1.5 * dpr));
      const wDown = Math.max(2, Math.round(2.5 * dpr));
      const pal = DECK_COLORS[dk.i];
      const tR = (W - x0) / pxPerSec;
      ctx.globalAlpha = 0.5 + 0.5 * aud;
      let down = true;
      ctx.fillStyle = pal.tick;
      for (let i = firstBeatAtOrAfter(beats, -x0 / pxPerSec - 0.05); i < beats.length && beats[i] <= tR; i++) {
        const isDown = (((i - dk.downbeat) % 4) + 4) % 4 === 0;
        if (isDown !== down) {
          down = isDown;
          ctx.fillStyle = isDown ? pal.tick : pal.mid;
        }
        const h = isDown ? railHalf : shortH;
        const w = isDown ? wDown : wBeat;
        ctx.fillRect(Math.round(x0 + beats[i] * pxPerSec) - (w >> 1), dk.i === 0 ? mid - h : mid + 1, w, h);
      }
    }
    // cue / drop markers
    const laneY = dk.i === 0 ? 0 : H - laneH;
    const lineW = Math.max(1, Math.round(dpr));
    ctx.globalAlpha = 0.45 + 0.55 * aud;
    for (let m = 0; m < dk.markers.length; m++) {
      const mk = dk.markers[m];
      const x = Math.round(x0 + mk.t * dk.perSec * pxPerCol);
      if (x < -80 * dpr || x > W + 2) continue;
      ctx.fillStyle = BONE;
      ctx.fillRect(x, laneY, lineW, laneH);
      if (mk.sprite) ctx.drawImage(mk.sprite, x, dk.i === 0 ? 0 : H - mk.sprite.height);
    }
  }

  // Copy of the last frame handed to draw(), so a resize (which clears the bitmap) can repaint at once
  // instead of showing an empty canvas until the next frame arrives.
  const held = [
    { on: false, pos: 0, audible: 0, rate: 1 },
    { on: false, pos: 0, audible: 0, rate: 1 },
  ];
  let heldPhase = 1;
  let everDrawn = false;

  function hold(i, fd) {
    const h = held[i];
    h.on = !!fd;
    if (!fd) return;
    h.pos = fd.pos;
    h.audible = fd.audible;
    h.rate = fd.rate > 0 ? fd.rate : 1;
  }

  /**
   * Paint one frame.
   * @param {{pos:number, audible:number, rate?:number}|null} fd0
   * @param {{pos:number, audible:number, rate?:number}|null} fd1
   * @param {number} [beatPhase]  0..1, pulses the playhead
   */
  function draw(fd0, fd1, beatPhase = 1) {
    hold(0, fd0);
    hold(1, fd1);
    heldPhase = beatPhase;
    everDrawn = true;
    paint();
  }

  function paint() {
    const { W, H, cx, dpr } = geo;
    if (W < 2 || H < 2) return;
    const fd0 = held[0].on ? held[0] : null;
    const fd1 = held[1].on ? held[1] : null;
    const beatPhase = heldPhase;
    // Nothing moved (paused) → keep the last bitmap.
    const p0 = fd0 ? fd0.pos : -1;
    const p1 = fd1 ? fd1.pos : -1;
    const a0 = fd0 ? fd0.audible + fd0.rate : -1;
    const a1 = fd1 ? fd1.audible + fd1.rate : -1;
    if (!dirty && p0 === decks[0].lastPos && p1 === decks[1].lastPos && a0 === decks[0].lastAud && a1 === decks[1].lastAud) {
      return;
    }
    dirty = false;
    decks[0].lastPos = p0;
    decks[1].lastPos = p1;
    decks[0].lastAud = a0;
    decks[1].lastAud = a1;

    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    drawDeck(decks[0], fd0);
    drawDeck(decks[1], fd1);

    ctx.globalAlpha = 1;
    ctx.fillStyle = SHADE;
    ctx.fillRect(0, 0, cx, H);
    // centre line of the rail
    ctx.fillStyle = 'rgba(244,238,227,0.07)';
    ctx.fillRect(0, Math.floor(H / 2), W, 1);

    // playhead
    const pw = Math.max(2, Math.round(1.5 * dpr));
    const pulse = 1 - clamp01(beatPhase);
    ctx.globalAlpha = 0.16 + 0.2 * pulse * pulse;
    ctx.fillStyle = BONE;
    ctx.fillRect(cx - pw * 2, 0, pw * 5, H);
    ctx.globalAlpha = 1;
    ctx.fillRect(cx - Math.floor(pw / 2), 0, pw, H);
    const tri = Math.round(5 * dpr);
    ctx.beginPath();
    ctx.moveTo(cx - tri, 0);
    ctx.lineTo(cx + tri + (pw % 2), 0);
    ctx.lineTo(cx + (pw % 2) / 2, tri * 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - tri, H);
    ctx.lineTo(cx + tri + (pw % 2), H);
    ctx.lineTo(cx + (pw % 2) / 2, H - tri * 1.3);
    ctx.closePath();
    ctx.fill();
  }

  /** Loudest band at a buffer position, 0..1 (drives the per-channel meters). */
  function ampAt(i, pos) {
    const dk = decks[i];
    if (!dk.wave) return 0;
    const c = Math.floor(pos * dk.perSec);
    if (c < 0 || c >= dk.cols) return 0;
    const w = dk.wave;
    const a = w.low[c];
    const b = w.mid[c];
    const h = w.high[c];
    return (a > b ? (a > h ? a : h) : b > h ? b : h) / 255;
  }

  /** Phase within the current beat at a buffer position (0..1), or −1 without a grid. Amortized O(1). */
  function beatPhaseAt(i, pos) {
    const dk = decks[i];
    const b = dk.beats;
    if (!b || b.length < 2) return -1;
    let k = dk.cursor;
    if (k > b.length - 2) k = b.length - 2;
    if (k < 0) k = 0;
    while (k < b.length - 2 && b[k + 1] <= pos) k++;
    while (k > 0 && b[k] > pos) k--;
    dk.cursor = k;
    const len = b[k + 1] - b[k];
    if (!(len > 0)) return -1;
    const ph = (pos - b[k]) / len;
    return ph - Math.floor(ph);
  }

  return {
    resize,
    setDeck,
    draw,
    ampAt,
    beatPhaseAt,
    invalidate() {
      dirty = true;
    },
    hasDeck: (i) => !!decks[i].view,
    /** @internal test hook */
    _stats: () => ({ tiles: [decks[0].tiles.size, decks[1].tiles.size], pool: pool.length, geo: { ...geo } }),
  };
}

/**
 * Keep a canvas' bitmap matched to its CSS box × devicePixelRatio.
 * @param {HTMLCanvasElement} canvas
 * @param {(cssW:number, cssH:number, dpr:number)=>void} onSize
 * @returns {() => void} disconnect
 */
export function observeCanvas(canvas, onSize) {
  const host = canvas.parentElement || canvas;
  let w = 0;
  let h = 0;
  const apply = () => onSize(w, h, Math.min(3, window.devicePixelRatio || 1));
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    w = r.width;
    h = r.height;
    apply();
  });
  ro.observe(host);
  // DPR changes without a box change (window dragged to another monitor, browser zoom).
  let mq = null;
  const onDpr = () => {
    listenDpr();
    if (w && h) apply();
  };
  function listenDpr() {
    mq?.removeEventListener('change', onDpr);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', onDpr);
  }
  listenDpr();
  return () => {
    ro.disconnect();
    mq?.removeEventListener('change', onDpr);
  };
}

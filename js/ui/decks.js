// One deck: the platter (artwork as a spinning label) and its readouts.
// set() runs when a track is loaded; frame() runs every animation frame and only touches the DOM when a
// displayed value actually changes.

import { clamp01, fmtTime, linkLabel, setImage, setLink, setText } from './dom.js';
import { DECK_COLORS } from './waves.js';

const PROVIDERS = { deezer: 'Deezer preview', itunes: 'Apple preview', local: 'Your file' };
const PROVIDERS_SHORT = { deezer: 'Deezer', itunes: 'Apple', local: 'File' };
const RING_LEN = 2 * Math.PI * 48; // r=48 in the 100-unit viewBox
const DEG_PER_SEC = 200; // 33⅓ rpm

/** @param {HTMLElement} root  the .deck section */
export function createDeck(root) {
  const part = (name) => root.querySelector(`[data-part="${name}"]`);
  const spin = /** @type {HTMLElement} */ (root.querySelector('.vinyl-spin'));
  const img = /** @type {HTMLImageElement} */ (root.querySelector('.vinyl-label img'));
  const ring = /** @type {SVGCircleElement} */ (root.querySelector('.ring-val'));
  const elTitle = part('title');
  const elArtist = part('artist');
  const elBpm = part('bpm');
  const elPitch = part('pitch');
  const elKey = part('key');
  const elKeyName = part('keyname');
  const elTime = part('time');
  const elDur = part('dur');
  const elLamp = part('lamp');
  const elProvider = part('provider');
  const elProviderShort = part('provider-short');
  const elProviderBox = /** @type {HTMLElement} */ (root.querySelector('.deck-provider'));
  elProviderBox.hidden = true;
  const elLink = part('link');
  const elLinkText = part('link-text');

  ring.style.strokeDasharray = `${RING_LEN}`;
  ring.style.strokeDashoffset = `${RING_LEN}`;

  // Whole-track overview: drawn once per track (and on resize); per frame only the playhead moves.
  const ov = /** @type {HTMLElement} */ (root.querySelector('.deck-ov'));
  const ovCanvas = /** @type {HTMLCanvasElement} */ (ov.querySelector('canvas'));
  const ovHead = /** @type {HTMLElement} */ (ov.querySelector('.ov-head'));
  const ovPlayed = /** @type {HTMLElement} */ (ov.querySelector('.ov-played'));
  const palette = DECK_COLORS[root.dataset.deck === '1' ? 1 : 0];
  let ovW = 0;
  let ovH = 0;
  let qHead = -1;

  function drawOverview() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(ovW * dpr);
    const H = Math.round(ovH * dpr);
    if (W < 2 || H < 2) return;
    if (ovCanvas.width !== W) ovCanvas.width = W;
    if (ovCanvas.height !== H) ovCanvas.height = H;
    const g = ovCanvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const wave = view && view.wave;
    if (!wave || !(wave.cols > 0)) return;
    const cols = Math.min(wave.cols, wave.low.length, wave.mid.length, wave.high.length);
    const bands = [wave.low, wave.mid, wave.high];
    const colors = [palette.low, palette.mid, palette.high];
    const scale = [0.96, 0.74, 0.4];
    for (let b = 0; b < 3; b++) {
      const arr = bands[b];
      g.fillStyle = colors[b];
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const c0 = Math.floor((x * cols) / W);
        const c1 = Math.max(c0 + 1, Math.floor(((x + 1) * cols) / W));
        const step = Math.max(1, Math.floor((c1 - c0) / 12)); // a dozen samples per pixel is plenty
        let peak = 0;
        for (let c = c0; c < c1; c += step) if (arr[c] > peak) peak = arr[c];
        const h = Math.max(1, Math.round((peak / 255) * H * scale[b]));
        g.rect(x, (H - h) >> 1, 1, h);
      }
      g.fill();
    }
    const cues = view.cues;
    const dur = view.duration > 0 ? view.duration : cols / (wave.perSec || 100);
    if (cues && cues.drop != null && Number.isFinite(cues.drop)) {
      g.fillStyle = '#f4eee3';
      g.fillRect(Math.round((cues.drop / dur) * W), 0, Math.max(1, Math.round(dpr)), H);
    }
  }

  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    if (r.width === ovW && r.height === ovH) return;
    ovW = r.width;
    ovH = r.height;
    qHead = -1;
    drawOverview();
  });
  ro.observe(ov);

  /** @type {any} */
  let view = null;
  let qRot = -1;
  let qRing = -1;
  let qBpm = -1;
  let qPitch = 9999;
  let qSec = -1;
  let lamp = '';
  let qAud = -1;

  function setLamp(state) {
    if (state === lamp) return;
    lamp = state;
    root.dataset.lamp = state;
    setText(elLamp, state === 'live' ? 'Live' : state === 'mix' ? 'Mixing' : state === 'cued' ? 'Cued' : 'Empty');
  }

  /** @param {any|null} v DeckView */
  function set(v) {
    view = v || null;
    root.classList.toggle('is-empty', !view);
    qRot = qRing = qBpm = qSec = qAud = qHead = -1;
    qPitch = 9999;
    drawOverview();
    ovHead.style.transform = 'translate3d(0,0,0)';
    ovPlayed.style.transform = 'scaleX(0)';
    if (!view) {
      setText(elTitle, 'Waiting for a track');
      setText(elArtist, 'The next one lands here');
      setText(elBpm, '–');
      setText(elPitch, '');
      setText(elKey, '–');
      setText(elKeyName, '');
      setText(elTime, '0:00');
      setText(elDur, '/ 0:00');
      setText(elProvider, '');
      setText(elProviderShort, '');
      elProviderBox.hidden = true;
      setImage(img, '');
      setLink(elLink, '');
      elKey.removeAttribute('title');
      ring.style.strokeDashoffset = `${RING_LEN}`;
      root.style.setProperty('--aud', '0');
      setLamp('empty');
      return;
    }
    setText(elTitle, view.title || 'Untitled');
    setText(elArtist, view.artist || '');
    elTitle.title = view.title || '';
    setText(elBpm, Number.isFinite(view.bpm) ? view.bpm.toFixed(1) : '–');
    setText(elPitch, '');
    setText(elKey, view.camelot || '–');
    setText(elKeyName, view.keyName || '');
    if (view.keyName) elKey.title = view.keyName;
    setText(elTime, '0:00');
    setText(elDur, `/ ${fmtTime(view.duration)}`);
    setText(elProvider, PROVIDERS[view.provider] || '');
    setText(elProviderShort, PROVIDERS_SHORT[view.provider] || '');
    elProviderBox.hidden = !PROVIDERS[view.provider];
    setImage(img, view.artwork);
    if (setLink(elLink, view.link)) {
      setText(elLinkText, linkLabel(view.link));
      elLink.setAttribute('aria-label', `${linkLabel(view.link)}: ${view.title || 'track'}`);
    }
    setLamp('cued');
  }

  /** @param {{pos:number, rate:number, bpmNow:number, audible:number}|null} fd DeckFrame */
  function frame(fd) {
    if (!view) return;
    if (!fd) {
      setLamp('cued');
      return;
    }
    const pos = fd.pos;

    // 33⅓ rpm label. Quantized to 0.2° so a paused deck writes nothing.
    const rot = Math.round((((pos * DEG_PER_SEC) % 360) + 360) % 360 * 5);
    if (rot !== qRot) {
      qRot = rot;
      spin.style.transform = `rotate(${rot / 5}deg)`;
    }

    const dur = view.duration > 0 ? view.duration : 1;
    const prog = Math.round(clamp01(pos / dur) * 400);
    if (prog !== qRing) {
      qRing = prog;
      ring.style.strokeDashoffset = `${(RING_LEN * (1 - prog / 400)).toFixed(2)}`;
    }

    if (ovW > 0) {
      const head = Math.round(clamp01(pos / dur) * ovW);
      if (head !== qHead) {
        qHead = head;
        ovHead.style.transform = `translate3d(${head}px,0,0)`;
        ovPlayed.style.transform = `scaleX(${(head / ovW).toFixed(4)})`;
      }
    }

    const sec = pos > 0 ? Math.floor(pos < dur ? pos : dur) : 0;
    if (sec !== qSec) {
      qSec = sec;
      setText(elTime, fmtTime(sec));
    }

    // live tempo; falls back to the track's own BPM, and to a dash when neither is a number
    const bpmSrc = Number.isFinite(fd.bpmNow) ? fd.bpmNow : view.bpm;
    const bpm = Number.isFinite(bpmSrc) ? Math.round(bpmSrc * 10) : -2;
    if (bpm !== qBpm) {
      qBpm = bpm;
      setText(elBpm, bpm < 0 ? '–' : (bpm / 10).toFixed(1));
    }
    const pitch = Math.round(((fd.rate > 0 ? fd.rate : 1) - 1) * 1000); // tenths of a percent
    if (pitch !== qPitch) {
      qPitch = pitch;
      setText(elPitch, pitch === 0 ? '' : `${pitch > 0 ? '+' : '−'}${(Math.abs(pitch) / 10).toFixed(1)}%`);
    }

    const aud = clamp01(fd.audible);
    // hysteresis so the lamp does not flicker on a slow fade
    if (aud >= 0.62 || (lamp === 'live' && aud >= 0.5)) setLamp('live');
    else if (aud >= 0.04 || (lamp === 'mix' && aud >= 0.02)) setLamp('mix');
    else setLamp('cued');
    const qa = Math.round(aud * 20);
    if (qa !== qAud) {
      qAud = qa;
      root.style.setProperty('--aud', (qa / 20).toFixed(2));
    }
  }

  return { set, frame, destroy: () => ro.disconnect() };
}

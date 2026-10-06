// One deck: the platter (artwork as a spinning label) and its readouts.
// set() runs when a track is loaded; frame() runs every animation frame and only touches the DOM when a
// displayed value actually changes.
//
// A deck without a waveform (a full song in YouTube's player: no audio reaches the page, so there is
// nothing to analyse) shows a progress bar in the overview's place — position / duration, with the
// point where the DJ will leave the song marked — and dashes for the tempo and key it cannot know.

import { clamp01, fmtTime, linkLabel, setImage, setLink, setText } from './dom.js';
import { DECK_COLORS } from './waves.js';

const PROVIDERS = { deezer: 'Deezer preview', itunes: 'Apple preview', local: 'Your file', youtube: 'YouTube', preview: 'Preview' };
const PROVIDERS_SHORT = { deezer: 'Deezer', itunes: 'Apple', local: 'File', youtube: 'YouTube', preview: 'Preview' };
/** DeckView.status → the deck's lamp (the word under the record). */
const STATUS_LAMP = { ad: ['cued', 'Ad'], loading: ['cued', 'Loading'], cued: ['cued', 'Cued'], live: ['live', 'Live'], mixing: ['mix', 'Mixing'], error: ['error', 'Error'] };
/** The lamp for a DeckView: its status word, except that a song that has played out says so (the conductor
 *  reports it as status 'cued' + statusText 'Ended', which the stage label already shows). */
const lampFor = (view) => (view.statusText === 'Ended' ? ['cued', 'Ended'] : STATUS_LAMP[view.status]);
const UNKNOWN = '—';
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
  const ovLeave = /** @type {HTMLElement} */ (ov.querySelector('.ov-leave'));
  ovLeave.hidden = true;
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
    if (progress) {
      drawTimeline(g, W, H, dpr);
      return;
    }
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

  /**
   * No waveform (a full song in YouTube's player): the strip becomes a timeline — a tick every 15 s,
   * a taller one with its label every minute. Drawn once per song (and on resize / a corrected length);
   * per frame only the played fill, the playhead and the leave notch move.
   */
  function drawTimeline(g, W, H, dpr) {
    const dur = timelineDur;
    if (!(dur > 1)) return;
    const step = dur > 900 ? 60 : 15;
    const tick = Math.max(1, Math.round(dpr));
    const font = Math.round(8.5 * dpr);
    const labelsFit = (60 / dur) * W > font * 4.4;
    g.font = `500 ${font}px 'Martian Mono', ui-monospace, Menlo, monospace`;
    g.textBaseline = 'top';
    for (let t = step; t < dur - 0.5; t += step) {
      const x = Math.round((t / dur) * W);
      const minute = t % 60 === 0;
      const h = Math.round(H * (minute ? 0.42 : 0.2));
      g.fillStyle = minute ? 'rgba(244,238,227,0.2)' : 'rgba(244,238,227,0.1)';
      g.fillRect(x, H - h, tick, h);
      if (minute && labelsFit) {
        g.fillStyle = 'rgba(244,238,227,0.34)';
        g.fillText(`${t / 60}:00`, x + 3 * dpr, Math.round(3 * dpr));
      }
    }
  }
  let timelineDur = 0;

  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    if (r.width === ovW && r.height === ovH) return;
    ovW = r.width;
    ovH = r.height;
    qHead = -1;
    qLeave = -2;
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
  let qDur = -1;
  let qLeave = -2;
  let lamp = '';
  let lampWord = '';
  let qAud = -1;
  let progress = false; // no waveform: the overview strip is a progress bar

  function setLamp(state, word) {
    const text = word || (state === 'live' ? 'Live' : state === 'mix' ? 'Mixing' : state === 'cued' ? 'Cued' : state === 'error' ? 'Error' : 'Empty');
    if (state === lamp && text === lampWord) return;
    lamp = state;
    lampWord = text;
    root.dataset.lamp = state;
    setText(elLamp, text);
  }

  /** @param {any|null} v DeckView */
  function set(v) {
    view = v || null;
    root.classList.toggle('is-empty', !view);
    progress = !!view && !(view.wave && view.wave.cols > 0);
    root.classList.toggle('is-progress', progress);
    qRot = qRing = qBpm = qSec = qAud = qHead = qDur = -1;
    qLeave = -2;
    qPitch = 9999;
    timelineDur = view && view.duration > 0 ? view.duration : 0;
    drawOverview();
    ovHead.style.transform = 'translate3d(0,0,0)';
    ovPlayed.style.transform = 'scaleX(0)';
    ovLeave.hidden = true;
    if (!view) {
      setText(elTitle, 'Waiting for a track');
      setText(elArtist, 'The next one lands here');
      setText(elBpm, UNKNOWN);
      setText(elPitch, '');
      setText(elKey, UNKNOWN);
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
    setText(elBpm, Number.isFinite(view.bpm) && view.bpm > 0 ? view.bpm.toFixed(1) : UNKNOWN);
    setText(elPitch, '');
    setText(elKey, view.camelot || UNKNOWN);
    setText(elKeyName, view.keyName || '');
    if (view.keyName) elKey.title = view.keyName;
    else elKey.removeAttribute('title');
    setText(elTime, '0:00');
    paintDur(view.duration);
    setText(elProvider, PROVIDERS[view.provider] || '');
    setText(elProviderShort, PROVIDERS_SHORT[view.provider] || '');
    elProviderBox.hidden = !PROVIDERS[view.provider];
    setImage(img, view.artwork);
    if (setLink(elLink, view.link)) {
      setText(elLinkText, linkLabel(view.link));
      elLink.setAttribute('aria-label', `${linkLabel(view.link)}: ${view.title || 'track'}`);
    }
    const st = lampFor(view);
    if (st) setLamp(st[0], st[1]);
    else setLamp('cued');
  }

  function paintDur(sec) {
    const d = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
    if (d === qDur) return;
    qDur = d;
    setText(elDur, `/ ${fmtTime(d)}`);
    // the player's own length can differ from the track list's: re-draw the timeline's minutes for it
    if (progress && d > 0 && Math.abs(d - timelineDur) >= 1) {
      timelineDur = d;
      drawOverview();
    }
  }

  /** @param {{pos:number, rate:number, bpmNow:number, audible:number, duration?:number, leaveAt?:number}|null} fd DeckFrame */
  function frame(fd) {
    if (!view) return;
    if (!fd) {
      const st = lampFor(view);
      if (st) setLamp(st[0], st[1]);
      else setLamp('cued');
      return;
    }
    const pos = fd.pos;

    // 33⅓ rpm label. Quantized to 0.2° so a paused deck writes nothing.
    const rot = Math.round((((pos * DEG_PER_SEC) % 360) + 360) % 360 * 5);
    if (rot !== qRot && Number.isFinite(rot)) {
      qRot = rot;
      spin.style.transform = `rotate(${rot / 5}deg)`;
    }

    // a full song's player knows its length better than the track list did
    const known = fd.duration > 0 && fd.duration < 1e6 ? fd.duration : view.duration;
    const dur = known > 0 ? known : 1;
    if (progress) paintDur(known);
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
      if (progress) {
        // where the DJ will leave this song (short / medium / full), as a notch on the bar
        const at = fd.leaveAt;
        const leave = at > 0 && at < dur ? Math.round((at / dur) * ovW) : -1;
        if (leave !== qLeave) {
          qLeave = leave;
          ovLeave.hidden = leave < 0;
          if (leave >= 0) ovLeave.style.transform = `translate3d(${leave}px,0,0)`;
        }
      }
    }

    const sec = pos > 0 ? Math.floor(pos < dur ? pos : dur) : 0;
    if (sec !== qSec) {
      qSec = sec;
      setText(elTime, fmtTime(sec));
    }

    // live tempo; falls back to the track's own BPM, and to a dash when neither is a number
    const bpmSrc = Number.isFinite(fd.bpmNow) && fd.bpmNow > 0 ? fd.bpmNow : view.bpm;
    const bpm = Number.isFinite(bpmSrc) && bpmSrc > 0 ? Math.round(bpmSrc * 10) : -2;
    if (bpm !== qBpm) {
      qBpm = bpm;
      setText(elBpm, bpm < 0 ? UNKNOWN : (bpm / 10).toFixed(1));
    }
    const pitch = Math.round(((fd.rate > 0 ? fd.rate : 1) - 1) * 1000); // tenths of a percent
    if (pitch !== qPitch) {
      qPitch = pitch;
      setText(elPitch, pitch === 0 || !Number.isFinite(pitch) ? '' : `${pitch > 0 ? '+' : '−'}${(Math.abs(pitch) / 10).toFixed(1)}%`);
    }

    const aud = clamp01(fd.audible);
    const st = lampFor(view);
    if (st) setLamp(st[0], st[1]);
    // hysteresis so the lamp does not flicker on a slow fade
    else if (aud >= 0.62 || (lamp === 'live' && aud >= 0.5)) setLamp('live');
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

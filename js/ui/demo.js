// ui-demo.html driver: a mock conductor for the view. NO audio, NO network — everything is synthetic.
//
// It builds a fake set the same way the real conductor will (Play objects with rate points + automation
// events, evaluated through js/dj/timeline.js) and feeds the view exactly the calls main.js will make.
//
//   ui-demo.html?screen=landing|loading|ready|stage
//     &t=42        start the set at set time 42 s
//     &freeze=1    do not run the animation loop (tests drive it through window.__segueDemo)
//     &long=1      first two tracks are 6-minute "local files" (36 000 waveform columns)
//     &drawer=1    open the setlist drawer (narrow layouts)
//     &rec=1       recording indicator on
//     &toasts=1    show one toast of each kind
//     &empty=1     stage with nothing loaded yet
//
// window.__segueDemo exposes { ready, view, calls, seek(t), step(dt), frameAt(t), state() } for e2e tests.

import { createView } from './view.js';
import { makeTrack, mulberry32 } from './mock.js';
import { dbToGain, evalParam, positionAt, rateAt, sortEvents, timeAtPosition } from '../dj/timeline.js';

const qs = new URLSearchParams(location.search);
const flag = (name) => qs.get(name) === '1';

// ── fake crate ─────────────────────────────────────────────────────────────────────────────────
// title, artist, bpm, camelot, key name
const CRATE = [
  ['Glasshouse', 'Mirelle Ito', 124, '8A', 'A minor'],
  ['Night Bus to Peckham', 'Dov Kessler', 126, '9A', 'E minor'],
  ['Soft Machines', 'Parallel Lines Club', 122, '8B', 'C major'],
  ['Heatwave on Mercer', 'Tasha Vee', 128, '10A', 'B minor'],
  ['Low Tide Radio', 'Okonkwo & Lime', 120, '7A', 'D minor'],
  ['Velvet Static (feat. Juno Arias)', 'Nine Lamps', 125, '9B', 'G major'],
  ['Cassette Summer', 'Juno Arias', 100, '6A', 'G minor'],
  ['Paradise, Double-Parked', 'The Longwave', 123, '11A', 'F♯ minor'],
  ['Halogen', 'Sable & the Motorik Choir', 127, '10B', 'D major'],
  ['Second Sunrise', 'Arlo Fenn', 121, '7B', 'F major'],
  ['Copper Wire', 'DJ Mariposa', 124, '8A', 'A minor'],
  ['Anywhere but the Afterparty', 'Kit Okafor', 126, '5A', 'C minor'],
  ['Slow Dissolve', 'Hana Brandt', 119, '4A', 'F minor'],
  ['Kiosk Flowers', 'Teodor Vale', 125, '11B', 'A major'],
];
const FAILED = { title: 'Unreleased Dubplate (White Label)', artist: 'Unknown Artist' };

const PALETTES = [
  ['#1d3557', '#e63946', '#f1faee'], ['#2b2d42', '#ef233c', '#edf2f4'], ['#f4a261', '#264653', '#e9c46a'],
  ['#0b132b', '#5bc0be', '#fdfffc'], ['#3d0c11', '#f58549', '#f2d0a4'], ['#101010', '#f7f7f2', '#e4572e'],
  ['#283618', '#dda15e', '#fefae0'], ['#5f0f40', '#fb8b24', '#e36414'], ['#003049', '#fcbf49', '#eae2b7'],
  ['#22223b', '#c9ada7', '#f2e9e4'], ['#0d1b2a', '#778da9', '#e0e1dd'], ['#582f0e', '#ffe6a7', '#bb9457'],
  ['#14213d', '#fca311', '#e5e5e5'], ['#2d6a4f', '#d8f3dc', '#95d5b2'],
];

/** Procedural sleeve art → blob: URL (the view only accepts https:/blob: image URLs). */
function makeCover(i) {
  const [bg, c1, c2] = PALETTES[i % PALETTES.length];
  const rnd = mulberry32(i * 97 + 5);
  const S = 240;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  const style = i % 5;
  if (style === 0) {
    g.fillStyle = c1;
    g.beginPath();
    g.arc(S * 0.62, S * 0.4, S * 0.3, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = c2;
    for (let k = 0; k < 5; k++) g.fillRect(S * 0.1, S * (0.62 + k * 0.06), S * (0.3 + rnd() * 0.5), S * 0.022);
  } else if (style === 1) {
    g.fillStyle = c1;
    g.beginPath();
    g.moveTo(0, S);
    g.lineTo(S, S * 0.25);
    g.lineTo(S, S);
    g.fill();
    g.fillStyle = c2;
    g.beginPath();
    g.arc(S * 0.3, S * 0.32, S * 0.14, 0, Math.PI * 2);
    g.fill();
  } else if (style === 2) {
    for (let k = 6; k > 0; k--) {
      g.fillStyle = k % 2 ? c1 : c2;
      g.beginPath();
      g.arc(S * 0.5, S * 0.56, (S * 0.07) * k, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = bg;
    g.fillRect(0, S * 0.56, S, S);
  } else if (style === 3) {
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        g.fillStyle = rnd() > 0.5 ? c1 : c2;
        g.beginPath();
        g.arc(S * (0.14 + x * 0.145), S * (0.14 + y * 0.145), S * 0.02 + rnd() * S * 0.04, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else {
    const n = 7;
    for (let k = 0; k < n; k++) {
      g.fillStyle = k % 2 ? c1 : c2;
      const w = S * (0.04 + rnd() * 0.06);
      g.fillRect(S * (0.1 + k * 0.118), S * (0.1 + rnd() * 0.25), w, S * (0.4 + rnd() * 0.4));
    }
  }
  return new Promise((ok) => cv.toBlob((blob) => ok(blob ? URL.createObjectURL(blob) : ''), 'image/png'));
}

// ── mock planner ───────────────────────────────────────────────────────────────────────────────
const SOLO = 9.5; // seconds a track rides alone before the next transition
const ANNOUNCE = 8; // seconds before tStart that the transition is shown as "upcoming"
const PRE = 5.5; // silent pre-roll in which the incoming deck's grid visibly converges
const TYPES = ['bassSwap', 'echoOut', 'filterBlend', 'cut', 'eqBlend', 'brake'];
const SYNCED = new Set(['bassSwap', 'filterBlend', 'eqBlend']);
const ev = (p, t, v, k = 'set') => ({ p, t, v, k });

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function createMockSet(seed, tracks) {
  const rnd = mulberry32(hash(seed));
  const order = tracks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (flag('long')) {
    // keep the two long local files up front so the 36 000-column path is on screen
    order.sort((a, b) => (tracks[b].long ? 1 : 0) - (tracks[a].long ? 1 : 0));
  }
  const typeShift = Math.floor(rnd() * TYPES.length);
  const plays = [];
  const trans = [];

  const first = tracks[order[0]];
  const startPos = first.long ? first.an.beats[4 * Math.floor(first.an.beats.length / 8)] : first.an.cues.in;
  plays.push({
    id: 0, track: first, deck: 0, startAt: 0, offset: startPos, rate: [{ t: 0, v: 1 }],
    events: [ev('gain', 0, 0), ev('gain', 0.9, 1, 'lin')], endAt: null, soloFrom: 0.9, loadAt: -Infinity,
  });
  trans.push({
    id: 0, type: 'fadeIn', label: 'Fade in', why: 'First track — easing the fader up', from: -1, to: 0,
    tStart: 0, tEnd: 0.9, marks: [{ t: 0, label: 'Fade in' }], announceAt: -Infinity, synced: false,
  });

  function extend() {
    const k = plays.length;
    const P = plays[k - 1];
    const A = P.track.an;
    const T = tracks[order[k % order.length]];
    const B = T.an;
    let type = TYPES[(k - 1 + typeShift) % TYPES.length];

    // outgoing downbeat at/after the solo stretch
    const target = P.soloFrom + SOLO;
    let i = A.downbeat;
    while (i + 4 < A.beats.length && timeAtPosition(P, A.beats[i]) < target) i += 4;
    const tStart = timeAtPosition(P, A.beats[i]);
    const rateA = rateAt(P, tStart);
    const bpmA = A.bpm * rateA;
    const Lb = 60 / bpmA;
    const rB = bpmA / B.bpm;
    const room = (A.duration - 0.4 - A.beats[i]) / rateA; // seconds of outgoing audio left
    let beats = room >= 16.5 * Lb ? 16 : room >= 8.5 * Lb ? 8 : 0;
    const syncable = Math.abs(rB - 1) <= 0.08 && beats > 0;
    if (SYNCED.has(type) && !syncable) type = room > 5 * Lb ? 'echoOut' : 'cut';
    if ((type === 'echoOut' || type === 'brake') && room < 5 * Lb) type = 'cut';

    const aEv = [];
    const bEv = [];
    const marks = [];
    let tEnd;
    let label;
    let play;
    const pct = (rB - 1) * 100;
    let why = `${A.bpm} → ${B.bpm} BPM (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%) · ${P.track.camelot} → ${T.camelot}`;

    if (SYNCED.has(type)) {
      const len = beats * Lb;
      tEnd = tStart + len;
      const s0 = tStart - PRE;
      // The incoming deck starts silently a little fast, then gets nudged onto the grid: positions
      // advance at slightly different rates and converge exactly at tStart.
      const rate = [{ t: s0, v: rB * 1.04 }, { t: tStart - 1.6, v: rB * 1.04 }, { t: tStart - 0.3, v: rB, ramp: true }];
      const run = positionAt({ startAt: s0, offset: 0, rate, endAt: null }, tStart);
      rate.push({ t: tEnd + 1, v: rB }, { t: tEnd + 6.5, v: 1, ramp: true });
      play = { startAt: s0, offset: B.cues.in - run, rate };
      bEv.push(ev('gain', s0, 0));
      const q = beats / 16; // scale the choreography to 8-beat versions
      if (type === 'bassSwap') {
        const tSwap = tStart + 8 * q * Lb;
        bEv.push(ev('low', s0, -28), ev('gain', tStart, 0), ev('gain', tStart + 4 * q * Lb, 1, 'lin'));
        bEv.push(ev('low', tSwap - 0.08, -28), ev('low', tSwap + 0.12, 0, 'lin'));
        aEv.push(ev('low', tSwap - 0.08, 0), ev('low', tSwap + 0.12, -28, 'lin'));
        aEv.push(ev('gain', tEnd - 4 * q * Lb, 1), ev('gain', tEnd, 0, 'lin'));
        marks.push({ t: tStart, label: 'Bring in' }, { t: tSwap, label: 'Bass swap' }, { t: tEnd - 4 * q * Lb, label: 'Fade out' });
        label = `Bass swap · ${beats} beats`;
      } else if (type === 'filterBlend') {
        bEv.push(ev('hpf', s0, 3200), ev('gain', tStart, 0), ev('gain', tStart + 6 * q * Lb, 1, 'lin'));
        bEv.push(ev('hpf', tStart + 2 * q * Lb, 3200), ev('hpf', tStart + 10 * q * Lb, 20, 'exp'));
        aEv.push(ev('lpf', tStart + 4 * q * Lb, 20000), ev('lpf', tEnd, 260, 'exp'));
        aEv.push(ev('gain', tEnd - 3 * q * Lb, 1), ev('gain', tEnd, 0, 'lin'));
        marks.push({ t: tStart, label: 'High-pass in' }, { t: tStart + 4 * q * Lb, label: 'Filter sweep' }, { t: tStart + 10 * q * Lb, label: 'Wide open' });
        label = `Filter blend · ${beats} beats`;
      } else {
        const tLow = tStart + 10 * q * Lb;
        bEv.push(ev('high', s0, -28), ev('mid', s0, -14), ev('low', s0, -28));
        bEv.push(ev('gain', tStart, 0), ev('gain', tStart + 8 * q * Lb, 1, 'lin'));
        bEv.push(ev('high', tStart, -28), ev('high', tStart + 4 * q * Lb, 0, 'lin'));
        bEv.push(ev('mid', tStart + 2 * q * Lb, -14), ev('mid', tStart + 8 * q * Lb, 0, 'lin'));
        bEv.push(ev('low', tLow - 0.08, -28), ev('low', tLow + Lb, 0, 'lin'));
        aEv.push(ev('high', tStart + 6 * q * Lb, 0), ev('high', tLow, -28, 'lin'));
        aEv.push(ev('low', tLow - 0.08, 0), ev('low', tLow + Lb, -28, 'lin'));
        aEv.push(ev('mid', tLow, 0), ev('mid', tStart + 14 * q * Lb, -20, 'lin'));
        aEv.push(ev('gain', tStart + 12 * q * Lb, 1), ev('gain', tEnd, 0, 'lin'));
        marks.push({ t: tStart, label: 'Highs in' }, { t: tLow, label: 'Swap the lows' }, { t: tStart + 12 * q * Lb, label: 'Ease out' });
        label = `EQ blend · ${beats} beats`;
      }
      P.endAt = tEnd + 0.05;
    } else {
      beats = type === 'cut' ? 0 : 4;
      if (Math.abs(rB - 1) > 0.08) why = `${A.bpm} vs ${B.bpm} BPM — too far apart to beat-match, so no overlap`;
      if (type === 'echoOut') {
        const tCut = tStart + 2 * Lb;
        tEnd = tStart + 4 * Lb;
        aEv.push(ev('hpf', tStart, 20), ev('hpf', tCut, 900, 'exp'));
        aEv.push(ev('gain', tCut - 0.02, 1), ev('gain', tCut + 0.08, 0, 'lin'));
        marks.push({ t: tStart, label: 'Echo out' }, { t: tCut, label: 'Fader down' }, { t: tEnd, label: 'Drop' });
        label = 'Echo out · 4 beats';
        P.endAt = tCut + 0.1;
      } else if (type === 'brake') {
        tEnd = tStart + 4 * Lb;
        P.rate.push({ t: tStart, v: rateA }, { t: tStart + 1.3, v: 0.04, ramp: true });
        aEv.push(ev('gain', tStart + 0.9, 1), ev('gain', tStart + 1.3, 0, 'lin'));
        marks.push({ t: tStart, label: 'Brake' }, { t: tEnd, label: 'Drop' });
        label = 'Brake · drop on the one';
        P.endAt = tStart + 1.35;
      } else {
        tEnd = tStart + Lb;
        aEv.push(ev('gain', tStart, 0));
        marks.push({ t: tStart, label: 'Cut' });
        label = 'Hard cut on the one';
        P.endAt = tStart + 0.02;
      }
      const tIn = type === 'cut' ? tStart : tEnd;
      play = { startAt: tIn, offset: B.cues.in, rate: [{ t: tIn, v: 1 }] };
      bEv.push(ev('gain', tIn, 1));
    }

    P.events = sortEvents(P.events.concat(aEv));
    plays.push({
      id: k, track: T, deck: k % 2, startAt: play.startAt, offset: play.offset, rate: play.rate,
      events: sortEvents(bEv), endAt: null, soloFrom: tEnd, loadAt: tStart - ANNOUNCE,
    });
    trans.push({
      id: k, type, label, why, from: k - 1, to: k, tStart, tEnd, marks,
      announceAt: tStart - ANNOUNCE, synced: SYNCED.has(type),
    });
  }

  return {
    seed,
    order,
    plays,
    trans,
    /** make sure plays/transitions exist up to index k */
    ensure(k) {
      while (plays.length <= k) extend();
    },
  };
}

// ── boot ───────────────────────────────────────────────────────────────────────────────────────
const calls = [];
const state = {
  screen: 'landing',
  playing: true,
  recording: flag('rec'),
  seed: 'K3F9QZ',
  vibe: 0.5,
  mode: flag('long') ? 'medium' : 'preview',
  volume: 0.9,
  t: Number(qs.get('t')) || 0,
};
/** @type {ReturnType<typeof createMockSet>} */
let set;
let cur = 0; // index of the play that is currently "the" track (outgoing side of the next transition)
let lastSig = '';
const loaded = [-2, -2]; // play id shown on each deck (−1 = empty, −2 = not yet pushed)

const log = (name) => (...args) => {
  calls.push([name, ...args.map((a) => (Array.isArray(a) ? a.map((f) => (f && f.name) || f) : a))]);
};

const view = createView(document.getElementById('app'), {
  onSubmit(text) {
    log('onSubmit')(text);
    fakeLoad(/\n/.test(text) ? 'your track list' : 'Late Night Drive');
  },
  onDemo(id) {
    log('onDemo')(id);
    fakeLoad(`the ${id} chart`);
  },
  onFiles(files) {
    log('onFiles')(files);
    fakeLoad(`${files.length} file${files.length === 1 ? '' : 's'}`);
  },
  onStart() {
    log('onStart')();
    state.playing = true;
    go('stage');
  },
  onPlayPause() {
    log('onPlayPause')();
    state.playing = !state.playing;
    pushTransport();
  },
  onSkip() {
    log('onSkip')();
    set.ensure(cur + 1);
    const next = set.trans[cur + 1];
    if (state.t < next.tStart - 0.6) state.t = next.tStart - 0.6;
  },
  onNewSet() {
    log('onNewSet')();
    state.seed = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    newSet();
    view.toast(`New set #${state.seed} — same crate, different mix`, 'success');
  },
  onVibe(v) {
    log('onVibe')(v);
    state.vibe = v;
    pushTransport();
  },
  onMode(m) {
    log('onMode')(m);
    state.mode = m;
    pushTransport();
  },
  onVolume(v) {
    log('onVolume')(v);
    state.volume = v;
    pushTransport();
  },
  onRecordToggle() {
    log('onRecordToggle')();
    state.recording = !state.recording;
    pushTransport();
    if (!state.recording) view.toast('Recording saved to your downloads (demo)', 'success');
  },
  onShare() {
    log('onShare')();
    view.toast(`Link to set #${state.seed} copied`, 'success');
  },
  onHome() {
    log('onHome')();
    clearTimeout(loadTimer);
    go('landing');
  },
});

// Same shape (and counts) as DEMOS / EXAMPLES in js/sources/demo.js, so the landing page is laid out as it ships.
view.setDemos(
  [
    { id: 'hits', label: 'Global hits', emoji: '🔥' },
    { id: 'dance', label: 'Dance', emoji: '🪩' },
    { id: 'electro', label: 'Electro', emoji: '🎛️' },
    { id: 'hiphop', label: 'Hip-hop', emoji: '🎤' },
    { id: 'pop', label: 'Pop', emoji: '✨' },
    { id: 'latin', label: 'Latin', emoji: '🌴' },
    { id: 'rnb', label: 'R&B', emoji: '💜' },
    { id: 'rock', label: 'Rock', emoji: '🎸' },
  ],
  [
    { label: 'Today’s Top Hits', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
    { label: 'mint (dance)', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n' },
    { label: 'RapCaviar', url: 'https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd' },
    { label: 'All Out 2000s', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd' },
    { label: 'Viva Latino', url: 'https://open.spotify.com/playlist/37i9dQZF1DX10zKzsJ2jva' },
    { label: 'Rock Classics', url: 'https://open.spotify.com/playlist/37i9dQZF1DWXRqgorJj26U' },
  ],
);

/** @type {any[]} */
let tracks = [];

function pushTransport() {
  const tr = set && set.trans[cur + 1];
  view.setTransport({
    playing: state.playing,
    canSkip: !!tr && state.t < tr.tStart - 0.7,
    recording: state.recording,
    seed: state.seed,
    vibe: state.vibe,
    mode: state.mode,
    modeEnabled: flag('long'),
    volume: state.volume,
  });
}

function go(screen) {
  state.screen = screen;
  view.setScreen(screen);
}

let loadTimer = 0;
function fakeLoad(what) {
  go('loading');
  const steps = [
    ['Reading the playlist', `Fetching ${what} from Spotify…`, null],
    ['Digging through the crate', 'Finding audio 3 / 14 — Dov Kessler · Night Bus to Peckham', 0.2],
    ['Digging through the crate', 'Finding audio 9 / 14 — Juno Arias · Cassette Summer', 0.62],
    ['Counting the beats', 'Analysing tempo and key — Mirelle Ito · Glasshouse (124 BPM, 8A)', 0.9],
  ];
  let i = 0;
  const tick = () => {
    if (i >= steps.length) {
      newSet();
      go('stage');
      return;
    }
    const [title, detail, progress] = steps[i++];
    view.setLoading({ title, detail, progress });
    loadTimer = setTimeout(tick, 700);
  };
  tick();
}

function newSet() {
  set = createMockSet(state.seed, tracks);
  cur = 0;
  lastSig = '';
  loaded[0] = loaded[1] = -2;
  state.t = 0;
  state.playing = true;
  sync(0);
  pushTransport();
}

function deckView(play) {
  const T = play.track;
  return {
    playId: play.id, title: T.title, artist: T.artist, artwork: T.artwork, link: T.link, bpm: T.bpm,
    camelot: T.camelot, keyName: T.keyName, duration: T.an.duration, provider: T.provider,
    wave: T.an.wave, beats: T.an.beats, downbeat: T.an.downbeat, cues: T.an.cues,
  };
}

/** Push deck / transition / setlist state for set time t (only what changed). */
function sync(t) {
  if (flag('empty')) return;
  // which play is "current": the last one whose incoming transition has finished
  if (cur >= set.trans.length || t < set.trans[cur].tEnd) cur = 0;
  for (;;) {
    set.ensure(cur + 2);
    if (t >= set.trans[cur + 1].tEnd) cur++;
    else break;
  }
  const next = set.trans[cur + 1];
  const phase = t >= next.tStart ? 'active' : t >= next.announceAt ? 'upcoming' : 'solo';

  // decks: a play is on its deck from loadAt until a moment after it ends
  for (let d = 0; d < 2; d++) {
    let id = -1;
    for (let k = Math.max(0, cur - 1); k <= cur + 1; k++) {
      const p = set.plays[k];
      if (p.deck !== d || t < p.loadAt) continue;
      if (p.endAt != null && t > p.endAt + 1.5) continue;
      id = k;
    }
    if (id !== loaded[d]) {
      loaded[d] = id;
      view.setDeck(d, id < 0 ? null : deckView(set.plays[id]));
    }
  }

  const sig = `${cur}|${phase}`;
  if (sig === lastSig) return;
  lastSig = sig;

  if (phase === 'solo') view.setTransition(null);
  else {
    view.setTransition({
      type: next.type, label: next.label, why: next.why, state: phase,
      fromTitle: set.plays[cur].track.title, toTitle: set.plays[cur + 1].track.title,
      tStart: next.tStart, tEnd: next.tEnd, marks: next.marks,
    });
  }

  const n = set.order.length;
  const base = cur - (cur % n);
  const items = [];
  for (let j = 0; j < n; j++) {
    const k = base + j;
    set.ensure(k);
    const T = set.plays[k].track;
    let st = 'queued';
    if (k < cur) st = 'played';
    else if (k === cur) st = 'playing';
    else if (k === cur + 1) st = phase === 'active' ? 'mixing' : 'next';
    else if (k === cur + 3) st = 'loading';
    items.push({
      key: `${T.id}`, title: T.title, artist: T.artist, artwork: T.artwork,
      bpm: st === 'loading' ? undefined : T.bpm, camelot: st === 'loading' ? undefined : T.camelot,
      state: st, via: k <= cur + 1 ? set.trans[k].label : undefined, link: T.link,
    });
    if (j === 4) items.push({ key: 'failed', title: FAILED.title, artist: FAILED.artist, state: 'failed' });
  }
  view.setSetlist(items);
  pushTransport();
}

// One FrameState object, mutated in place every frame — the same no-allocation discipline the real loop needs.
const mkDeck = () => ({ pos: 0, rate: 1, bpmNow: 0, gain: 0, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0 });
const deckFrames = [mkDeck(), mkDeck()];
const frameState = {
  t: 0, playing: true, elapsed: 0, decks: [null, null], crossfade: -1, beatPhase: 0,
  levels: { rms: 0, peak: 0, bands: new Uint8Array(64) },
};
const noise = mulberry32(99);

function frameAt(t) {
  const f = frameState;
  f.t = t;
  f.playing = state.playing;
  f.elapsed = t;
  let g0 = 0;
  let g1 = 0;
  let lead = -1;
  let leadAud = 0;
  let lo = 0;
  let mi = 0;
  let hi = 0;
  for (let d = 0; d < 2; d++) {
    const id = loaded[d];
    if (id < 0 || flag('empty')) {
      f.decks[d] = null;
      continue;
    }
    const p = set.plays[id];
    const df = deckFrames[d];
    const an = p.track.an;
    df.pos = positionAt(p, t);
    df.rate = t < p.startAt ? p.rate[0].v : rateAt(p, p.endAt != null && t > p.endAt ? p.endAt : t);
    df.bpmNow = p.track.bpm * df.rate;
    df.gain = evalParam(p.events, 'gain', t, 1);
    df.low = evalParam(p.events, 'low', t, 0);
    df.mid = evalParam(p.events, 'mid', t, 0);
    df.high = evalParam(p.events, 'high', t, 0);
    df.hpf = evalParam(p.events, 'hpf', t, 20);
    df.lpf = evalParam(p.events, 'lpf', t, 20000);
    const running = t >= p.startAt && (p.endAt == null || t < p.endAt);
    const eq = 0.5 * dbToGain(df.low) + 0.3 * dbToGain(df.mid) + 0.2 * dbToGain(df.high);
    const filt = Math.max(0.25, 1 - Math.log(Math.max(df.hpf, 20) / 20) / 9) * Math.max(0.3, Math.log(Math.max(df.lpf, 40) / 20) / Math.log(1000));
    df.audible = running ? Math.min(1, df.gain * eq * filt) : 0;
    f.decks[d] = df;
    if (d === 0) g0 = running ? df.gain : 0;
    else g1 = running ? df.gain : 0;
    if (df.audible > leadAud) {
      leadAud = df.audible;
      lead = d;
    }
    const c = Math.floor(df.pos * 100);
    if (running && c >= 0 && c < an.wave.cols) {
      lo += (an.wave.low[c] / 255) * df.gain * dbToGain(df.low);
      mi += (an.wave.mid[c] / 255) * df.gain * dbToGain(df.mid);
      hi += (an.wave.high[c] / 255) * df.gain * dbToGain(df.high);
    }
  }
  if (g0 + g1 > 0.001) f.crossfade = (g1 - g0) / (g0 + g1);

  if (lead >= 0) {
    const p = set.plays[loaded[lead]];
    const beats = p.track.an.beats;
    const pos = deckFrames[lead].pos;
    const len = beats[1] - beats[0];
    const ph = (pos - beats[0]) / len;
    f.beatPhase = ph - Math.floor(ph);
  } else f.beatPhase = 0;

  const on = state.playing ? 1 : 0;
  const bands = f.levels.bands;
  for (let i = 0; i < 64; i++) {
    const src = i < 5 ? lo : i < 24 ? mi * (1 - (i - 5) / 40) : hi * (1 - (i - 24) / 80);
    bands[i] = Math.max(0, Math.min(255, Math.round(on * 235 * src * (0.75 + 0.25 * noise()))));
  }
  const peak = Math.min(1, on * Math.max(lo, mi * 0.8, hi * 0.6) * 0.95);
  f.levels.peak = peak;
  f.levels.rms = Math.min(1, on * (lo * 0.5 + mi * 0.3 + hi * 0.15) * 0.8);
  return f;
}

function seek(t) {
  state.t = Math.max(0, t);
  if (state.screen === 'stage' && set) {
    sync(state.t);
    view.frame(frameAt(state.t));
  }
}

/** Advance the set by dt seconds and paint one frame; returns the time view.frame() took in ms. */
function step(dt = 1 / 60) {
  if (state.playing) state.t += dt;
  sync(state.t);
  const f = frameAt(state.t);
  const t0 = performance.now();
  view.frame(f);
  return performance.now() - t0;
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.screen !== 'stage' || !set) return;
  step(dt);
}

const ready = (async () => {
  const covers = await Promise.all(CRATE.map((_, i) => makeCover(i)));
  tracks = CRATE.map(([title, artist, bpm, camelot, keyName], i) => {
    const long = flag('long') && i < 2;
    return {
      id: `demo:${i}`, title, artist, bpm, camelot, keyName, artwork: covers[i], long,
      link: 'https://open.spotify.com/',
      provider: long ? 'local' : i % 4 === 3 ? 'itunes' : 'deezer',
      an: makeTrack({ seed: i + 3, bpm, duration: long ? 360 : 30, firstBeat: 0.1 + ((i * 37) % 23) / 100 }),
    };
  });
  view.setPlaylist({
    title: 'Late Night Drive', subtitle: 'Fourteen after-hours cuts for the demo', artwork: covers[2],
    link: 'https://open.spotify.com/', count: CRATE.length, source: flag('long') ? 'local' : 'spotify',
  });
  view.setLoading({ title: 'Digging through the crate', detail: 'Finding audio 9 / 14 — Juno Arias · Cassette Summer', progress: 0.62 });

  const t0 = state.t;
  newSet();
  state.t = t0;
  const screen = ['landing', 'loading', 'ready', 'stage'].includes(qs.get('screen')) ? qs.get('screen') : 'landing';
  go(screen);
  if (screen === 'stage') seek(t0);
  if (flag('drawer')) document.querySelector('[data-ref="crate-toggle"]').click();
  if (flag('toasts')) {
    view.toast('Couldn’t find audio for “Unreleased Dubplate” — skipping it', 'error');
    view.toast('Link to set #K3F9QZ copied', 'success');
    view.toast('Matched 13 of 14 tracks', 'info');
  }
  if (!flag('freeze')) requestAnimationFrame(loop);
  return true;
})();

window.__segueDemo = {
  ready,
  view,
  calls,
  seek,
  step,
  frameAt,
  state: () => ({ ...state, cur, phase: lastSig, trans: set ? set.trans.map((x) => ({ type: x.type, tStart: x.tStart, tEnd: x.tEnd, announceAt: x.announceAt })) : [] }),
};

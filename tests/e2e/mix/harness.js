// Mix-quality harness (runs in the browser, driven by tests/e2e/mix.e2e.mjs).
//
// Real previews, fetched through the app's own sources code, go through the real analysis, the real
// planner and the real engine inside an OfflineAudioContext.
//
//   survey      whole sets planned the way the conductor plans them, one crate per chart: which
//               transitions the planner chooses, and every overlapping beat-matched blend among them
//   blend       one surveyed blend, rendered as two timing stems (one track each, strips left open):
//               attack envelopes cross-correlated over the overlap → lag of the peak (how far apart the
//               two tracks' drums are); each stem also against its own plan (engine timing)
//   pair        one transition rendered as the full mix + stems as mixed:
//     level       peak of the full mix (never above 1.0)
//     continuity  no silent gap > 250 ms that the tracks themselves do not contain
//     clicks      as-mixed stems summed (no risers / impacts): no sample-to-sample step at a join that
//                 the surrounding music does not have
//   miniSet     six tracks end to end, same level / continuity / click checks
//   levels      one forced hand-over (riser drop, spinback, brake, cut, loop roll) rendered as the mix and
//               as its parts, measured the way it is heard: K-weighted loudness of the riser's peak
//               against the music around it, the impact one-shot against the track it announces, dead air
//               before the drop
//   buildDrop   a natural plan whose solo carries the Build + drop trick: the drop beat against the same
//               beat played through an untouched strip
//
// Everything returned is plain JSON.

import { loadPlaylist } from '../../../js/sources/index.js';
import { createResolver } from '../../../js/sources/resolver.js';
import { createAnalyzer } from '../../../js/analysis/client.js';
import { createPlanner } from '../../../js/dj/planner.js';
import { createEngine, LIMITER } from '../../../js/dj/engine.js';
import { applyTransition, decodeAudio, WINDOW } from '../../../js/dj/conductor.js';
import { positionAt, sortEvents, timeAtPosition } from '../../../js/dj/timeline.js';

const SR = 48000;
/** Context seconds rendered before set time 0: the limiter has settled by then (see handoff/engine.md). */
const PRE = 0.25;
const BLENDS = ['bassSwap', 'eqBlend', 'filterBlend'];
const SILENT = Math.pow(10, -55 / 20);
/** Engine volume for a "linear" render: the limiter never comes near its threshold down here. */
const QUIET = 0.02;

const resolver = createResolver();
const analyzer = createAnalyzer();
const decodeCtx = new OfflineAudioContext(2, 1, SR);

/** @type {{id:string, title:string, artist:string, bytes:ArrayBuffer, analysis:any, charts:string[]}[]} */
let crate = [];
/** @type {{label:string, input:string, tracks:number[]}[]} one crate per chart (a track on two charts is in both) */
let charts = [];
/** @type {Map<string, AudioBuffer>} */
const buffers = new Map();
/** @type {Map<string, {a:number, b:number, tr:any, outPlay:any}>} blends found by survey(), by key */
const surveyed = new Map();

const fold = (r) => {
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
};
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function bufferOf(track) {
  let b = buffers.get(track.id);
  if (b) return b;
  b = await decodeAudio(decodeCtx, track.bytes.slice(0));
  buffers.set(track.id, b);
  if (buffers.size > 8) buffers.delete(buffers.keys().next().value);
  return b;
}

/**
 * Fetch + analyse the first `perChart` tracks of each chart, exactly as the app would.
 * @param {{label:string, input:string}[]} inputs
 */
async function loadCrate(inputs, perChart) {
  crate = [];
  charts = [];
  surveyed.clear();
  const failed = [];
  const byId = new Map();
  for (const { label, input } of inputs) {
    const pl = await loadPlaylist(input);
    const picks = pl.tracks.slice(0, perChart);
    const mine = [];
    let next = 0;
    const worker = async () => {
      while (next < picks.length) {
        const k = next++;
        const meta = picks[k];
        if (byId.has(meta.id)) {
          mine.push({ k, t: byId.get(meta.id) });
          continue;
        }
        try {
          const ref = await resolver.resolveTrack(meta);
          const bytes = await resolver.fetchAudio(ref);
          const buffer = await decodeAudio(decodeCtx, bytes.slice(0));
          const analysis = await analyzer.analyze(buffer, { key: `mix:${ref.key}`, bpmHint: ref.bpmHint });
          const t = { id: meta.id, title: meta.title, artist: meta.artist, bytes, analysis, charts: [] };
          byId.set(meta.id, t);
          mine.push({ k, t });
        } catch (err) {
          failed.push(`${meta.id}: ${err && err.message}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    mine.sort((x, y) => x.k - y.k); // chart order, whatever order the downloads finished in
    const tracks = [];
    for (const { t } of mine) {
      if (!crate.includes(t)) crate.push(t);
      t.charts.push(label);
      tracks.push(crate.indexOf(t));
    }
    charts.push({ label, input, tracks });
  }
  return {
    tracks: crate.map((t, i) => {
      const g = t.analysis.grid;
      return { i, id: t.id, bpm: t.analysis.bpm, conf: t.analysis.bpmConfidence, grid: g ? { phase: g.phase, head: g.head, tail: g.tail } : null, key: t.analysis.key.camelot, duration: t.analysis.duration, charts: t.charts };
    }),
    charts: charts.map((c) => ({ label: c.label, tracks: c.tracks.length })),
    failed,
  };
}

const isBlend = (tr) => !!tr.synced && BLENDS.includes(tr.type) && tr.beats > 0;

/** One pass through a crate the way the conductor plans it: base order, window of 5, chooseNext, next. */
function planSet(indices, seed, vibe) {
  const planner = createPlanner({ seed, vibe, mode: 'preview' });
  const byId = new Map(indices.map((i) => [crate[i].id, i]));
  const queue = planner.order(indices.map((i) => crate[i].id));
  const cand = (t) => ({ id: t.id, artist: t.artist, analysis: t.analysis });
  const out = [];
  const recent = [];
  let cur = -1;
  let prevPlay = null;
  for (let n = 0; queue.length; n++) {
    const win = queue.slice(0, n === 0 ? 3 : WINDOW).map((id) => byId.get(id));
    const k = planner.chooseNext(cur < 0 ? null : cand(crate[cur]), win.map((i) => cand(crate[i])), { playIndex: n, recentArtists: recent.slice(-3) });
    const pick = win[k];
    const track = crate[pick];
    queue.splice(queue.indexOf(track.id), 1);
    let tr;
    if (cur < 0) tr = planner.first({ id: track.id, analysis: track.analysis }, { startAt: 0 });
    else {
      tr = planner.next({ play: prevPlay, analysis: crate[cur].analysis }, { id: track.id, analysis: track.analysis }, { earliest: prevPlay.soloFrom });
      const outPlay = { ...prevPlay, events: [], rate: prevPlay.rate.concat(tr.aRate), endAt: null };
      out.push({ a: cur, b: pick, tr, outPlay });
    }
    prevPlay = clonePlay(tr.play);
    cur = pick;
    recent.push(track.artist);
  }
  return out;
}

/**
 * Sets over every chart's crate, `seeds` of them each, planner only: what the DJ chooses to do on
 * this music. Overlapping beat-matched blends are kept (by key) for blend() to render.
 * `matchable` counts the transitions whose two tracks are within the tempo window with trusted
 * tempos: the ones that were blend candidates before the grid-trust gate.
 */
function survey(seeds, vibe) {
  surveyed.clear();
  return charts.map((c, ci) => {
    const types = {};
    const blends = [];
    let transitions = 0;
    let matchable = 0;
    const seen = new Set();
    for (let s = 0; s < seeds; s++) {
      for (const rec of planSet(c.tracks, `mix-${c.label}-${s}`, vibe)) {
        transitions++;
        types[rec.tr.type] = (types[rec.tr.type] || 0) + 1;
        const A = crate[rec.a].analysis;
        const B = crate[rec.b].analysis;
        if (Math.min(A.bpmConfidence, B.bpmConfidence) >= 0.5 && Math.abs(fold(B.bpm / A.bpm) - 1) <= 0.08) matchable++;
        if (!isBlend(rec.tr)) continue;
        // the same two tracks blended over the same bars again say nothing new about alignment
        const same = `${rec.a}>${rec.b}:${rec.tr.beats}`;
        const key = `${ci}:${s}:${rec.tr.id}`;
        blends.push({ key, a: rec.a, b: rec.b, type: rec.tr.type, beats: rec.tr.beats, repeat: seen.has(same) });
        seen.add(same);
        surveyed.set(key, rec);
      }
    }
    return { label: c.label, tracks: c.tracks.length, trusted: c.tracks.filter((i) => crate[i].analysis.bpmConfidence >= 0.5).length, transitions, matchable, types, blends };
  });
}

const clonePlay = (p) => ({ ...p, events: p.events.slice(), rate: p.rate.slice() });
const silentLike = (b) => new AudioBuffer({ length: b.length, sampleRate: b.sampleRate, numberOfChannels: b.numberOfChannels });

/**
 * Render a list of planned transitions through the real engine, offline.
 * @param {{tr:any, buffer:AudioBuffer, trackId:string}[]} steps
 * @param {number} seconds set time to render
 * @param {{mute?: Set<number>, noise?: boolean, only?: string[], flat?: boolean, volume?: number, linear?: boolean}} [o]
 *        mute = play ids rendered from silence; noise:false drops risers / impacts (they belong to neither
 *        track); only = keep just these kinds of one-shot; flat = timing only; linear = what goes INTO the
 *        limiter (rendered far below its threshold and scaled back up), aligned with the limited output
 */
async function render(steps, seconds, o = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(((seconds + PRE) * SR) / 128) * 128, SR);
  const engine = createEngine({ context: ctx });
  const volume = o.linear ? QUIET : o.volume;
  if (volume) engine.setVolume(volume);
  await engine.start({ at: PRE });
  if (volume) engine.setVolume(volume);
  let prev = null;
  for (const s of steps) {
    const buffer = o.mute && o.mute.has(s.tr.play.id) ? silentLike(s.buffer) : s.buffer;
    let tr = o.noise === false ? { ...s.tr, fx: s.tr.fx.filter((f) => f.kind === 'loop' || f.kind === 'reverse') } : s.tr;
    if (o.only) tr = { ...tr, fx: tr.fx.filter((f) => o.only.includes(f.kind)) };
    // flat: the plan's timing only (start, offset, rate), every strip left open — "where is each track's audio"
    if (o.flat) tr = { ...tr, aEvents: [], fx: [], fxEvents: [], play: { ...tr.play, events: [] } };
    applyTransition(engine, prev, tr, buffer);
    prev = clonePlay(tr.play);
  }
  const out = await ctx.startRendering();
  engine.destroy();
  const skip = Math.round(PRE * SR);
  const L = out.getChannelData(0).subarray(skip);
  const R = out.getChannelData(1).subarray(skip);
  if (!o.linear) return { L, R };
  const k = (o.volume || 1) / QUIET;
  return { L: L.map((v) => v * k), R: R.map((v) => v * k) };
}

// ── measurements ───────────────────────────────────────────────────────────────────────────────

const monoOf2 = (L, R) => {
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = 0.5 * (L[i] + R[i]);
  return out;
};

/** Mono mix of an AudioBuffer (for reading "what the track itself contains"). */
function monoOf(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * Lag (ms) at which b best matches a, searched within ±maxLag ms. Positive = b is late.
 * @returns {{lag:number, peak:number, atZero:number}}
 */
function bestLag(a, b, maxLag) {
  const n = Math.min(a.length, b.length);
  let best = -Infinity;
  let bestAt = 0;
  let atZero = 0;
  let na = 0;
  for (let k = maxLag; k < n - maxLag; k++) na += a[k] * a[k];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0;
    let nb = 0;
    for (let k = maxLag; k < n - maxLag; k++) {
      const v = b[k + lag];
      dot += a[k] * v;
      nb += v * v;
    }
    const c = dot / Math.sqrt(na * nb + 1e-20);
    if (lag === 0) atZero = c;
    if (c > best) {
      best = c;
      bestAt = lag;
    }
  }
  return { lag: bestAt, peak: best, atZero };
}

/** Envelope of a raw track as the plan says it is heard: read through positionAt over [t0, t1). */
function planEnvelope(rawEnv, play, t0, t1) {
  const n = Math.max(0, Math.floor((t1 - t0) * 1000));
  const out = new Float32Array(n);
  const p = { ...play, endAt: null };
  for (let i = 0; i < n; i++) {
    const f = positionAt(p, t0 + i / 1000) * 1000;
    const k = Math.floor(f);
    if (k >= 0 && k + 1 < rawEnv.length) out[i] = rawEnv[k] + (rawEnv[k + 1] - rawEnv[k]) * (f - k);
  }
  return out;
}

/** Is this beat list one constant grid (to 0.5 ms)? Live drummers are not: their beats are fitted locally. */
function constantGrid(beats) {
  const n = beats.length;
  if (n < 3) return true;
  const p = (beats[n - 1] - beats[0]) / (n - 1);
  for (let i = 0; i < n; i++) if (Math.abs(beats[i] - (beats[0] + i * p)) > 5e-4) return false;
  return true;
}

/** How far the two beat grids are apart in set time over [t0, t1] (ms): planner maths, no audio. */
function gridError(outPlay, A, inPlay, B, t0, t1) {
  const times = (play, an) => {
    const p = { ...play, endAt: null };
    return an.beats.map((b) => timeAtPosition(p, b)).filter((t) => t >= t0 - 1e-6 && t <= t1 + 1e-6);
  };
  const ta = times(outPlay, A);
  const tb = times(inPlay, B);
  const nearest = (xs, ys) => xs.map((x) => Math.min(...ys.map((y) => Math.abs(y - x))));
  if (!ta.length || !tb.length) return { median: NaN, max: NaN };
  // With a ×2 / ÷2 tempo fold only every other beat of the denser grid has a partner: judge the sparser one.
  const errs = ta.length <= tb.length ? nearest(ta, tb) : nearest(tb, ta);
  return { median: median(errs) * 1000, max: Math.max(...errs) * 1000 };
}

function peakOf(L, R) {
  let p = 0;
  let bad = 0;
  for (const d of [L, R]) {
    for (let i = 0; i < d.length; i++) {
      const x = d[i] < 0 ? -d[i] : d[i];
      if (!(x <= 16)) bad++;
      else if (x > p) p = x;
    }
  }
  return { peak: p, nonFinite: bad };
}

/** RMS per 10 ms frame of the mono mix. */
function frames10(L, R) {
  const hop = SR / 100;
  const n = Math.floor(L.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) {
      const v = 0.5 * (L[k] + R[k]);
      s += v * v;
    }
    out[i] = Math.sqrt(s / hop);
  }
  return out;
}

/**
 * Silent stretches (> 250 ms below −55 dBFS) of the mix inside [t0, t1], each with the level the
 * tracks themselves have there (read from the raw audio through the plan). A gap only counts
 * against the mix when the music was not silent too.
 */
function findGaps(L, R, t0, t1, sources) {
  const fr = frames10(L, R);
  const gaps = [];
  let run = -1;
  const lo = Math.max(0, Math.floor(t0 * 100));
  const hi = Math.min(fr.length, Math.floor(t1 * 100));
  for (let i = lo; i <= hi; i++) {
    const quiet = i < hi && fr[i] < SILENT;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      if (i - run > 25) {
        const a = run / 100;
        const b = i / 100;
        let music = 0;
        for (const s of sources) {
          const p = { ...s.play, endAt: null };
          // only a track that is planned to be playing counts as "should be audible"
          if (s.play.startAt > b || (s.endAt != null && s.endAt < a)) continue;
          const pa = Math.max(0, Math.round(positionAt(p, a) * s.sr));
          const pb = Math.min(s.mono.length, Math.round(positionAt(p, b) * s.sr));
          let sum = 0;
          for (let k = pa; k < pb; k++) sum += s.mono[k] * s.mono[k];
          if (pb > pa) music = Math.max(music, Math.sqrt(sum / (pb - pa)));
        }
        gaps.push({ from: a, to: b, ms: Math.round((b - a) * 1000), musicDb: music > 0 ? 20 * Math.log10(music) : -120 });
      }
      run = -1;
    }
  }
  return gaps;
}

/**
 * Clicks at joins: the largest sample-to-sample step within a few ms of each join, against the
 * largest step the music makes in the second around it. A join is a click when it steps more than
 * twice as hard as its surroundings (and audibly so).
 */
function findClicks(L, R, joins) {
  const step = (a, b) => {
    let m = 0;
    const lo = Math.max(1, Math.round(a * SR));
    const hi = Math.min(L.length, Math.round(b * SR));
    for (let i = lo; i < hi; i++) {
      const dl = Math.abs(L[i] - L[i - 1]);
      const dr = Math.abs(R[i] - R[i - 1]);
      if (dl > m) m = dl;
      if (dr > m) m = dr;
    }
    return m;
  };
  const out = [];
  for (const j of joins) {
    const t = j.t + LIMITER.lookahead;
    if (!(t > 0.02)) continue;
    const at = step(t - 0.012, t + 0.018);
    const ref = Math.max(step(t - 0.8, t - 0.04), step(t + 0.04, t + 0.8));
    const click = at > 0.15 && at > 2 * ref;
    out.push({ what: j.what, t: j.t, step: at, ref, click });
  }
  return out;
}

function joinsOf(first, trs) {
  const joins = [{ t: first.play.startAt, what: 'opener start' }];
  for (const tr of trs) {
    joins.push({ t: tr.play.startAt, what: `${tr.type} incoming start` }, { t: tr.tStart, what: `${tr.type} tStart` }, { t: tr.tEnd, what: `${tr.type} tEnd` }, { t: tr.aEndAt, what: `${tr.type} outgoing stop` });
    for (const f of tr.fx) {
      if (f.kind !== 'loop' && f.kind !== 'reverse') continue;
      joins.push({ t: f.t, what: `${f.kind} start` }, { t: f.t + f.dur, what: `${f.kind} end` });
    }
  }
  return joins;
}

/**
 * Attack envelope at 1 kHz, linear in amplitude (a kick counts for more than a hi-hat): rise of the
 * 10 ms RMS over 10 ms, half-wave rectified.
 */
function attackEnvelope(x, sr, t0, t1) {
  const n = Math.max(0, Math.floor((t1 - t0) * 1000));
  const win = Math.round(0.01 * sr);
  const amp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.round((t0 + i / 1000) * sr);
    let sum = 0;
    const a = Math.max(0, c - win);
    const b = Math.min(x.length, c);
    for (let k = a; k < b; k++) sum += x[k] * x[k];
    amp[i] = Math.sqrt(sum / win);
  }
  const d = new Float32Array(n);
  for (let i = 10; i < n; i++) d[i] = Math.max(0, amp[i] - amp[i - 10]);
  return d;
}

// ── one pair, as mixed ─────────────────────────────────────────────────────────────────────────

/**
 * Plan A → B the way the conductor does (opener, then the mix planned at the start of A's solo),
 * render the full mix + the two stems as mixed, check level, continuity and joins.
 * @param {number} a crate index of the outgoing track
 * @param {number} b crate index of the incoming track
 * @param {{wantBlend?: boolean, vibe?: number}} o  wantBlend: try a few seeds for one that blends
 *        (never forced: a pair the planner will not blend is rendered as what it does instead)
 */
async function pair(a, b, o = {}) {
  const A = crate[a];
  const B = crate[b];
  const [bufA, bufB] = [await bufferOf(A), await bufferOf(B)];
  let first;
  let tr;
  for (let s = 0; s < 6; s++) {
    const planner = createPlanner({ seed: `mix-${a}-${b}-${s}`, vibe: o.vibe ?? 0.5, mode: 'preview' });
    first = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
    tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom });
    if (!o.wantBlend || isBlend(tr)) break;
  }
  const steps = [
    { tr: first, buffer: bufA, trackId: A.id },
    { tr, buffer: bufB, trackId: B.id },
  ];
  const outPlay = { ...first.play, events: sortEvents(first.play.events.concat(tr.aEvents)), rate: first.play.rate.concat(tr.aRate), endAt: null };
  const endB = timeAtPosition({ ...tr.play, endAt: null }, B.analysis.duration - 0.05);
  const seconds = Math.min(Number.isFinite(endB) ? endB : tr.tEnd + 6, tr.tEnd + 6) + 0.3;

  const mix = await render(steps, seconds);
  const stemA = await render(steps, seconds, { mute: new Set([tr.play.id]), noise: false });
  const stemB = await render(steps, seconds, { mute: new Set([first.play.id]), noise: false });
  const tracksOnly = new Float32Array(stemA.L.length);
  const tracksOnlyR = new Float32Array(stemA.L.length);
  for (let i = 0; i < tracksOnly.length; i++) {
    tracksOnly[i] = stemA.L[i] + stemB.L[i];
    tracksOnlyR[i] = stemA.R[i] + stemB.R[i];
  }
  const sources = [
    { play: outPlay, endAt: tr.aEndAt, mono: monoOf(bufA), sr: bufA.sampleRate },
    { play: tr.play, endAt: null, mono: monoOf(bufB), sr: bufB.sampleRate },
  ];
  return {
    a,
    b,
    from: `${A.analysis.bpm.toFixed(1)} BPM ${A.analysis.key.camelot}`,
    to: `${B.analysis.bpm.toFixed(1)} BPM ${B.analysis.key.camelot}`,
    type: tr.type,
    label: tr.label,
    why: tr.why,
    beats: tr.beats,
    synced: !!tr.synced,
    blend: isBlend(tr),
    degraded: !!tr.degraded,
    rate: tr.play.rate[0].v,
    tStart: tr.tStart,
    tEnd: tr.tEnd,
    ...peakOf(mix.L, mix.R),
    gaps: findGaps(mix.L, mix.R, first.tEnd, Math.min(seconds - 0.4, tr.tEnd + 5), sources),
    clicks: findClicks(tracksOnly, tracksOnlyR, joinsOf(first, [tr])).filter((c) => c.click),
  };
}

// ── one surveyed blend: where the two tracks' drums really are ──────────────────────────────────

/**
 * Render one blend found by survey() as two timing stems — the plan's timing (start, offset, rate)
 * with every strip left open, one track each — and cross-correlate their attack envelopes over the
 * overlap. Set time is shifted so the outgoing play starts at 0 (a set transition may lie minutes in).
 */
async function blend(key) {
  const rec = surveyed.get(key);
  if (!rec) throw new Error(`no surveyed blend ${key}`);
  const A = crate[rec.a];
  const B = crate[rec.b];
  const [bufA, bufB] = [await bufferOf(A), await bufferOf(B)];
  const T = rec.outPlay.startAt;
  const sh = (q) => ({ ...q, t: q.t - T });
  const outPlay = { ...rec.outPlay, startAt: 0, rate: rec.outPlay.rate.map(sh), events: [], endAt: null, soloFrom: 0 };
  const inPlay = { ...rec.tr.play, startAt: rec.tr.play.startAt - T, rate: rec.tr.play.rate.map(sh), events: [], endAt: null, soloFrom: rec.tr.play.soloFrom - T };
  const first = { from: -1, to: outPlay.id, play: outPlay, aEvents: [], aRate: [], fx: [], fxEvents: [] };
  const tr = { ...rec.tr, tStart: rec.tr.tStart - T, tEnd: rec.tr.tEnd - T, aEndAt: rec.tr.aEndAt - T, aEvents: [], aRate: [], fx: [], fxEvents: [], play: inPlay };
  const steps = [
    { tr: first, buffer: bufA, trackId: A.id },
    { tr, buffer: bufB, trackId: B.id },
  ];
  const beatSec = (tr.tEnd - tr.tStart) / tr.beats;
  const wide = Math.round(0.55 * beatSec * 1000);
  const fine = Math.round(0.25 * beatSec * 1000);
  const pad = wide / 1000 + 0.03;
  const t0 = tr.tStart - pad;
  const t1 = tr.tEnd + pad;
  const seconds = t1 + 0.3;
  const flatA = await render(steps, seconds, { mute: new Set([inPlay.id]), flat: true });
  const flatB = await render(steps, seconds, { mute: new Set([outPlay.id]), flat: true });
  const L = LIMITER.lookahead; // constant delay of everything the engine renders
  const eA = attackEnvelope(monoOf2(flatA.L, flatA.R), SR, t0 + L, t1 + L);
  const eB = attackEnvelope(monoOf2(flatB.L, flatB.R), SR, t0 + L, t1 + L);
  const m = bestLag(eA, eB, wide);
  const monoA = monoOf(bufA);
  const monoB = monoOf(bufB);
  // Rendered stem against its own plan (raw track read through positionAt): the engine's timing on real audio.
  const pA = planEnvelope(attackEnvelope(monoA, bufA.sampleRate, 0, bufA.duration), outPlay, t0, t1);
  const pB = planEnvelope(attackEnvelope(monoB, bufB.sampleRate, 0, bufB.duration), inPlay, t0, t1);
  const g = gridError(outPlay, A.analysis, inPlay, B.analysis, tr.tStart, tr.tEnd);
  const ga = A.analysis.grid || null;
  const gb = B.analysis.grid || null;
  return {
    key,
    a: rec.a,
    b: rec.b,
    from: `${A.analysis.bpm.toFixed(1)} BPM ${A.analysis.key.camelot}`,
    to: `${B.analysis.bpm.toFixed(1)} BPM ${B.analysis.key.camelot}`,
    type: tr.type,
    label: tr.label,
    beats: tr.beats,
    rate: inPlay.rate[0].v,
    lagMs: m.lag,
    lagBeats: m.lag / 1000 / beatSec,
    corrPeak: m.peak,
    corrZero: m.atZero,
    fineLagMs: bestLag(eA, eB, fine).lag,
    engineLagA: bestLag(pA, eA, 30).lag,
    engineLagB: bestLag(pB, eB, 30).lag,
    gridMedianMs: g.median,
    gridMaxMs: g.max,
    constantGrids: constantGrid(A.analysis.beats) && constantGrid(B.analysis.beats),
    trust: { outTail: ga ? ga.tail : null, inHead: gb ? gb.head : null, contrast: rec.tr.trust && rec.tr.trust.contrast !== undefined ? rec.tr.trust.contrast : null },
  };
}

// ── levels: a hand-over as it is heard ─────────────────────────────────────────────────────────

/** One biquad section, direct form I. */
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}
/** ITU-R BS.1770 K-weighting at 48 kHz (high shelf, then high-pass): level as the ear weighs it. */
const kWeight = (x) => biquad(biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585), 1, -2, 1, -1.99004745483398, 0.99007225036621);
/** Running sum of the two channels' power (optionally weighted), for cheap windowed levels. */
function powerSum(s, weight) {
  const L = weight ? weight(s.L) : s.L;
  const R = weight ? weight(s.R) : s.R;
  const p = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i++) p[i + 1] = p[i] + L[i] * L[i] + R[i] * R[i];
  return p;
}
/** Level (dB, arbitrary but common reference) of [t0, t1) from a running power sum. Set time; the limiter's delay is added here. */
function levelDb(p, t0, t1) {
  const a = Math.max(0, Math.min(p.length - 1, Math.round((t0 + LIMITER.lookahead) * SR)));
  const b = Math.max(0, Math.min(p.length - 1, Math.round((t1 + LIMITER.lookahead) * SR)));
  return b > a && p[b] > p[a] ? 10 * Math.log10((p[b] - p[a]) / (b - a)) : -200;
}
function peakIn(s, t0, t1) {
  const a = Math.max(0, Math.round((t0 + LIMITER.lookahead) * SR));
  const b = Math.min(s.L.length, Math.round((t1 + LIMITER.lookahead) * SR));
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(s.L[i]), Math.abs(s.R[i]));
  return p;
}
const dB = (x) => (x > 1e-10 ? 20 * Math.log10(x) : -200);

/**
 * One hand-over of a given kind, A → B, planned with opts.force and measured:
 *   bumpDb     loudest 400 ms (K-weighted) that ends before the drop, over the louder of the music's own
 *              median levels in the 4 s before the move and the 4 s after it. A riser that is "as loud as
 *              the track" by plain RMS shows here as +5 … +9: it is 4 – 8 kHz noise.
 *   impactDb   the impact one-shot alone, its loudest 50 ms, over the incoming track's own level in the
 *              2 s after the drop (null when the plan carries no impact)
 *   deadMs     how long, counted back from the drop, the mix stays more than 12 dB under the outgoing
 *              programme (5 ms frames; the incoming track's few ms of pre-roll are left out)
 * @returns {Promise<object>} {skipped} when the planner could not build that move for this pair
 */
async function levels(a, b, o = {}) {
  const A = crate[a];
  const B = crate[b];
  const planner = createPlanner({ seed: o.seed ?? `levels-${a}-${b}`, vibe: o.vibe ?? 0.5, mode: 'preview' });
  const first = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
  const tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom, force: { type: o.type } });
  if (tr.type !== o.type || tr.degraded) return { skipped: tr.type };
  const [bufA, bufB] = [await bufferOf(A), await bufferOf(B)];
  const steps = [
    { tr: first, buffer: bufA, trackId: A.id },
    { tr, buffer: bufB, trackId: B.id },
  ];
  const tS = tr.tStart;
  const X = tr.tEnd;
  const endB = timeAtPosition({ ...tr.play, endAt: null }, B.analysis.duration - 0.05);
  const seconds = Math.min(Number.isFinite(endB) ? endB : X + 5, X + 5) + 0.3;
  if (!(tS > 4.5) || !(seconds > X + 2.5)) return { skipped: 'no room to measure' };
  const mix = await render(steps, seconds);
  const out = { a, b, type: tr.type, label: tr.label, beats: tr.beats, moveMs: Math.round((X - tS) * 1000) };

  const pk = powerSum(mix, kWeight);
  const windows = (t0, t1) => {
    const xs = [];
    for (let t = t0; t + 0.4 <= t1 + 1e-9; t += 0.1) xs.push(levelDb(pk, t, t + 0.4));
    return xs;
  };
  const before = median(windows(tS - 4, tS));
  const after = median(windows(X, Math.min(X + 4, seconds - 0.3)));
  let loudest = -200;
  for (let t = tS - 0.2; t + 0.4 <= X + 1e-6; t += 0.01) loudest = Math.max(loudest, levelDb(pk, t, t + 0.4));
  out.bumpDb = X - tS >= 0.3 ? loudest - Math.max(before, after) : null;
  out.stepDownDb = levelDb(pk, X - 0.4, X) - levelDb(pk, X, X + 0.4);

  const impact = tr.fx.find((f) => f.kind === 'impact');
  out.impactDb = null;
  if (impact) {
    const mute = new Set([first.play.id, tr.play.id]);
    const only = await render(steps, seconds, { linear: true, mute, only: ['impact'] });
    const stemB = await render(steps, seconds, { linear: true, mute: new Set([first.play.id]), noise: false });
    const pi = powerSum(only);
    let best = -200;
    for (let t = impact.t; t + 0.05 <= impact.t + 0.3; t += 0.005) best = Math.max(best, levelDb(pi, t, t + 0.05));
    out.impactDb = best - levelDb(powerSum(stemB), X, X + 2);
    out.impactPeakDb = dB(peakIn(only, impact.t, impact.t + 0.8)) - dB(peakIn(stemB, impact.t, impact.t + 0.4));
    out.impactGain = impact.gain;
  }
  const riser = tr.fx.find((f) => f.kind === 'riser');
  if (riser) out.riserGain = riser.gain;

  const pm = powerSum(mix);
  const programme = levelDb(pm, tS - 4, tS);
  let frames = 0;
  for (let t = X - 0.013; t > tS - 0.5; t -= 0.005) {
    if (levelDb(pm, t, t + 0.005) < programme - 12) frames++;
    else break;
  }
  out.deadMs = frames ? frames * 5 + 8 : 0;
  return out;
}

/**
 * A natural plan A → B (vibe 0.9) whose solo carries the Build + drop trick, rendered up to the
 * transition: the drop beat as mixed against the same beat through an untouched strip, both as they
 * reach the limiter. dropDb / lowDb = peak (full band / below 150 Hz) over the untouched track's own.
 * @returns {Promise<object>} {skipped: true} when this pair and seed carry no such trick
 */
async function buildDrop(a, b, seed) {
  const A = crate[a];
  const B = crate[b];
  const planner = createPlanner({ seed, vibe: 0.9, mode: 'preview' });
  const first = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
  const tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom });
  const drop = tr.marks.find((m) => m.label === 'Drop' && m.t < tr.tStart - 1e-3);
  if (!drop || !tr.marks.some((m) => m.label === 'Build' && m.t < drop.t)) return { skipped: true };
  const tD = drop.t;
  const [bufA, bufB] = [await bufferOf(A), await bufferOf(B)];
  const steps = [
    { tr: first, buffer: bufA, trackId: A.id },
    { tr, buffer: bufB, trackId: B.id },
  ];
  const seconds = Math.min(tr.tStart, tD + 3);
  const mute = new Set([tr.play.id]);
  const raw = await render(steps, seconds, { linear: true, mute });
  const flat = await render(steps, seconds, { linear: true, mute, flat: true });
  const beat = 60 / (A.analysis.bpm || 120);
  const w = Math.min(0.25, beat * 0.5);
  const low = (s) => {
    // two cascaded low-pass sections at 150 Hz
    let L = s.L;
    let R = s.R;
    for (const Q of [0.5412, 1.3066]) {
      const w0 = (2 * Math.PI * 150) / SR;
      const al = Math.sin(w0) / (2 * Q);
      const c = Math.cos(w0);
      const a0 = 1 + al;
      const co = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0];
      L = biquad(L, ...co);
      R = biquad(R, ...co);
    }
    return { L, R };
  };
  const [lowRaw, lowFlat] = [low(raw), low(flat)];
  return {
    a,
    b,
    tDrop: tD,
    dropDb: dB(peakIn(raw, tD - 0.01, tD + w)) - dB(peakIn(flat, tD - 0.01, tD + w)),
    lowDb: dB(peakIn(lowRaw, tD - 0.01, tD + w)) - dB(peakIn(lowFlat, tD - 0.01, tD + w)),
    // The quarter beat in which the filter reopens: it must not thump there instead. Judged by energy
    // (a high-pass moving through the bass also rotates its phase, which lifts the PEAKS of a
    // brick-walled master by a few dB without adding any level: reported, not judged).
    beforeDb: levelDb(powerSum(raw), tD - 0.3 * beat, tD - 0.01) - levelDb(powerSum(flat), tD - 0.3 * beat, tD - 0.01),
    beforePeakDb: dB(peakIn(raw, tD - 0.3 * beat, tD - 0.01)) - dB(peakIn(flat, tD - 0.3 * beat, tD - 0.01)),
    // one bar later nothing is automated: the two renders must agree (the measurement's own noise floor)
    controlDb: dB(peakIn(raw, tD + 4 * beat - 0.01, tD + 4 * beat + w)) - dB(peakIn(flat, tD + 4 * beat - 0.01, tD + 4 * beat + w)),
    peakIntoLimiter: peakIn(raw, tD - 0.01, tD + w),
  };
}

// ── a whole mini-set ───────────────────────────────────────────────────────────────────────────

/** Plan `count` tracks the way the conductor does (base order, window of 5, chooseNext) and render them as one mix. */
async function miniSet(count, seed, vibe) {
  const planner = createPlanner({ seed, vibe, mode: 'preview' });
  const byId = new Map(crate.map((t) => [t.id, t]));
  const queue = planner.order(crate.map((t) => t.id));
  const cand = (t) => ({ id: t.id, artist: t.artist, analysis: t.analysis });
  const steps = [];
  const trs = [];
  const sources = [];
  let cur = null;
  let prevPlay = null;
  const recent = [];
  for (let n = 0; n < count; n++) {
    const win = queue.slice(0, n === 0 ? 3 : WINDOW).map((id) => byId.get(id));
    const k = planner.chooseNext(cur ? cand(cur) : null, win.map(cand), { playIndex: n, recentArtists: recent.slice(-3) });
    const track = win[k];
    queue.splice(queue.indexOf(track.id), 1);
    const buffer = await decodeAudio(decodeCtx, track.bytes.slice(0));
    let tr;
    if (!cur) tr = planner.first({ id: track.id, analysis: track.analysis }, { startAt: 0 });
    else {
      tr = planner.next({ play: prevPlay, analysis: cur.analysis }, { id: track.id, analysis: track.analysis }, { earliest: prevPlay.soloFrom });
      const out = sources[sources.length - 1];
      out.play = { ...prevPlay, events: sortEvents(prevPlay.events.concat(tr.aEvents)), rate: prevPlay.rate.concat(tr.aRate), endAt: null };
      out.endAt = tr.aEndAt;
    }
    steps.push({ tr, buffer, trackId: track.id });
    trs.push(tr);
    sources.push({ play: tr.play, endAt: null, mono: monoOf(buffer), sr: buffer.sampleRate });
    prevPlay = clonePlay(tr.play);
    cur = track;
    recent.push(track.artist);
  }
  const last = trs[trs.length - 1];
  const seconds = last.tEnd + 5;
  const mix = await render(steps, seconds);
  const loud = await render(steps, seconds, { volume: 1.25 });
  const tracksOnly = await render(steps, seconds, { noise: false });
  const gaps = findGaps(mix.L, mix.R, trs[0].tEnd, seconds - 0.5, sources);
  const clicks = findClicks(tracksOnly.L, tracksOnly.R, joinsOf(trs[0], trs.slice(1)));
  let sum = 0;
  for (let i = 0; i < mix.L.length; i++) sum += 0.5 * (mix.L[i] * mix.L[i] + mix.R[i] * mix.R[i]);
  return {
    seconds,
    transitions: trs.slice(1).map((t) => ({ type: t.type, label: t.label, synced: !!t.synced, degraded: !!t.degraded, tStart: t.tStart, tEnd: t.tEnd, tricks: t.marks.filter((m) => m.t < t.tStart - 1e-3).length })),
    ...peakOf(mix.L, mix.R),
    peakAtMaxVolume: peakOf(loud.L, loud.R).peak,
    rmsDb: 10 * Math.log10(sum / mix.L.length + 1e-20),
    gaps,
    clicks: clicks.filter((c) => c.click),
    joins: clicks.length,
    worstJoin: clicks.reduce((m, c) => (c.ref > 0 && c.step / c.ref > m.ratio ? { ratio: c.step / c.ref, what: c.what, step: c.step } : m), { ratio: 0, what: '', step: 0 }),
  };
}

window.mix = { loadCrate, survey, blend, pair, miniSet, levels, buildDrop, size: () => crate.length };
window.mixReady = true;

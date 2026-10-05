// Mix-quality harness (runs in the browser, driven by tests/e2e/mix.e2e.mjs).
//
// Real previews, fetched through the app's own sources code, go through the real analysis, the real
// planner and the real engine inside an OfflineAudioContext. Each pair is rendered several times
// with the SAME plan and the samples are measured:
//
//   alignment   two timing stems (one track each, strips left open): attack envelopes cross-correlated
//               over the overlap → lag of the peak; each stem also against the shared beat grid
//   level       peak of the full mix (never above 1.0)
//   continuity  no silent gap > 250 ms that the tracks themselves do not contain
//   clicks      as-mixed stems summed (no risers / impacts): no sample-to-sample step at a join that
//               the surrounding music does not have
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

const resolver = createResolver();
const analyzer = createAnalyzer();
const decodeCtx = new OfflineAudioContext(2, 1, SR);

/** @type {{id:string, title:string, artist:string, bytes:ArrayBuffer, analysis:any, chart:string}[]} */
let crate = [];
/** @type {Map<string, AudioBuffer>} */
const buffers = new Map();

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

/** Fetch + analyse the first `perChart` tracks of each chart, exactly as the app would. */
async function loadCrate(inputs, perChart) {
  crate = [];
  const failed = [];
  for (const input of inputs) {
    const pl = await loadPlaylist(input);
    const picks = pl.tracks.slice(0, perChart);
    let next = 0;
    const worker = async () => {
      while (next < picks.length) {
        const meta = picks[next++];
        try {
          const ref = await resolver.resolveTrack(meta);
          const bytes = await resolver.fetchAudio(ref);
          const buffer = await decodeAudio(decodeCtx, bytes.slice(0));
          const analysis = await analyzer.analyze(buffer, { key: `mix:${ref.key}`, bpmHint: ref.bpmHint });
          if (!crate.some((t) => t.id === meta.id)) crate.push({ id: meta.id, title: meta.title, artist: meta.artist, bytes, analysis, chart: pl.title, rank: inputs.indexOf(input) * 1000 + picks.indexOf(meta) });
        } catch (err) {
          failed.push(`${meta.id}: ${err && err.message}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  crate.sort((x, y) => x.rank - y.rank); // same indices whatever order the downloads finished in
  return {
    tracks: crate.map((t, i) => ({ i, id: t.id, bpm: t.analysis.bpm, conf: t.analysis.bpmConfidence, key: t.analysis.key.camelot, duration: t.analysis.duration, chart: t.chart })),
    failed,
  };
}

/** Index pairs: ones the planner will beat-match, and ones it will not. Each track is used sparingly. */
function choosePairs(wantSynced, wantFree) {
  const n = crate.length;
  const synced = [];
  const free = [];
  const usedA = new Array(n).fill(0);
  const usedB = new Array(n).fill(0);
  const ok = (i) => crate[i].analysis.bpmConfidence >= 0.5;
  // deterministic sweep with a stride so pairs spread over the crate
  for (let step = 1; step < n && synced.length < wantSynced; step++) {
    for (let a = 0; a < n && synced.length < wantSynced; a++) {
      const b = (a + step * 7) % n;
      if (a === b || usedA[a] >= 2 || usedB[b] >= 2) continue;
      if (!ok(a) || !ok(b)) continue;
      const r = fold(crate[b].analysis.bpm / crate[a].analysis.bpm);
      if (Math.abs(r - 1) > 0.075) continue;
      if (synced.some((p) => p[0] === a && p[1] === b)) continue;
      synced.push([a, b]);
      usedA[a]++;
      usedB[b]++;
    }
  }
  for (let a = 0; a < n && free.length < wantFree; a++) {
    for (let b = n - 1; b >= 0 && free.length < wantFree; b--) {
      if (a === b || free.some((p) => p[0] === a || p[1] === b)) continue;
      const r = fold(crate[b].analysis.bpm / crate[a].analysis.bpm);
      if (Math.abs(r - 1) < 0.12 && ok(a) && ok(b)) continue;
      free.push([a, b]);
    }
  }
  return { synced, free };
}

const clonePlay = (p) => ({ ...p, events: p.events.slice(), rate: p.rate.slice() });
const silentLike = (b) => new AudioBuffer({ length: b.length, sampleRate: b.sampleRate, numberOfChannels: b.numberOfChannels });

/**
 * Render a list of planned transitions through the real engine, offline.
 * @param {{tr:any, buffer:AudioBuffer, trackId:string}[]} steps
 * @param {number} seconds set time to render
 * @param {{mute?: Set<number>, noise?: boolean, flat?: boolean, volume?: number}} [o]  mute = play ids rendered
 *        from silence; noise:false drops risers / impacts (they belong to neither track); flat = timing only
 */
async function render(steps, seconds, o = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(((seconds + PRE) * SR) / 128) * 128, SR);
  const engine = createEngine({ context: ctx });
  if (o.volume) engine.setVolume(o.volume);
  await engine.start({ at: PRE });
  if (o.volume) engine.setVolume(o.volume);
  let prev = null;
  for (const s of steps) {
    const buffer = o.mute && o.mute.has(s.tr.play.id) ? silentLike(s.buffer) : s.buffer;
    let tr = o.noise === false ? { ...s.tr, fx: s.tr.fx.filter((f) => f.kind === 'loop' || f.kind === 'reverse') } : s.tr;
    // flat: the plan's timing only (start, offset, rate), every strip left open — "where is each track's audio"
    if (o.flat) tr = { ...tr, aEvents: [], fx: [], fxEvents: [], play: { ...tr.play, events: [] } };
    applyTransition(engine, prev, tr, buffer);
    prev = clonePlay(tr.play);
  }
  const out = await ctx.startRendering();
  engine.destroy();
  const skip = Math.round(PRE * SR);
  return { L: out.getChannelData(0).subarray(skip), R: out.getChannelData(1).subarray(skip) };
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

/** Two cascaded 2-pole low-passes (≈ 150 Hz): what is left is kick drum and bass. */
function kickBand(x, sr, hz = 150) {
  const w = (2 * Math.PI * hz) / sr;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const b0 = (1 - c) / 2 / (1 + alpha);
  const b1 = (1 - c) / (1 + alpha);
  const a1 = (-2 * c) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  let y = Float32Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = y[i];
      y2 = y1;
      y1 = v;
      out[i] = v;
    }
    y = out;
  }
  return y;
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

/**
 * A stem's attacks against a list of beat times (set time): mean attack strength on the beats and
 * half-way between them (best value within ±25 ms), and the median distance from a beat to the
 * strongest attack within ±60 ms of it.
 * @param {Float32Array} env  attack envelope at 1 kHz whose index 0 is set time `envT0`
 */
function gridProfile(env, beats, envT0) {
  const peak = (t, reach) => {
    const c = Math.round((t - envT0) * 1000);
    let v = 0;
    let at = 0;
    for (let k = Math.max(0, c - reach); k <= Math.min(env.length - 1, c + reach); k++) {
      if (env[k] > v) {
        v = env[k];
        at = k - c;
      }
    }
    return { v, at };
  };
  let on = 0;
  let half = 0;
  let n = 0;
  const offs = [];
  const ons = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    on += peak(beats[i], 25).v;
    half += peak(0.5 * (beats[i] + beats[i + 1]), 25).v;
    n++;
    ons.push(peak(beats[i], 60));
  }
  const ref = median(ons.map((x) => x.v));
  for (const x of ons) if (x.v >= 0.3 * ref && x.v > 0) offs.push(x.at);
  return { beats: n, on: n ? on / n : 0, half: n ? half / n : 0, halfOverOn: on > 0 ? half / on : 0, offsetMs: offs.length ? median(offs) : null };
}

/**
 * Where a track's attacks sit inside its own analysed beats: mean attack strength at beat phase
 * 0, ¼, ½, ¾ (best value within ±20 ms), for the kick band and for the whole spectrum. A grid that is
 * half a beat off shows up as "half" well above "on".
 */
function phaseProfile(mono, sr, an) {
  const from = an.cues.start;
  const to = an.cues.end;
  const prof = (env) => {
    const acc = [0, 0, 0, 0];
    let n = 0;
    for (let i = 0; i + 1 < an.beats.length; i++) {
      const b = an.beats[i];
      const len = an.beats[i + 1] - b;
      if (b < from + 0.05 || b + len > to - 0.05) continue;
      for (let q = 0; q < 4; q++) {
        const c = Math.round((b + (q / 4) * len) * 1000);
        let v = 0;
        for (let k = Math.max(0, c - 20); k <= Math.min(env.length - 1, c + 20); k++) if (env[k] > v) v = env[k];
        acc[q] += v;
      }
      n++;
    }
    return acc.map((v) => (n ? v / n : 0));
  };
  const kick = prof(attackEnvelope(kickBand(mono, sr), sr, 0, an.duration));
  const full = prof(attackEnvelope(mono, sr, 0, an.duration));
  return { kick, full, kickHalfOverOn: kick[0] > 0 ? kick[2] / kick[0] : 0, fullHalfOverOn: full[0] > 0 ? full[2] / full[0] : 0 };
}

async function profiles() {
  const out = [];
  for (let i = 0; i < crate.length; i++) {
    const t = crate[i];
    const buf = await decodeAudio(decodeCtx, t.bytes.slice(0));
    const p = phaseProfile(monoOf(buf), buf.sampleRate, t.analysis);
    out.push({ i, bpm: t.analysis.bpm, conf: t.analysis.bpmConfidence, kickHalfOverOn: p.kickHalfOverOn, fullHalfOverOn: p.fullHalfOverOn, kick: p.kick, full: p.full });
  }
  return out;
}

// ── one pair ───────────────────────────────────────────────────────────────────────────────────

/**
 * Plan A → B the way the conductor does (opener, then the mix planned at the start of A's solo),
 * render mix + stems, measure.
 * @param {number} a crate index of the outgoing track
 * @param {number} b crate index of the incoming track
 * @param {{wantSync?: boolean, vibe?: number}} o
 */
async function pair(a, b, o = {}) {
  const A = crate[a];
  const B = crate[b];
  const [bufA, bufB] = [await bufferOf(A), await bufferOf(B)];
  let planner;
  let first;
  let tr;
  let forced = false;
  // Natural selection first; a matchable pair that keeps drawing a non-blend is asked for a blend.
  for (let s = 0; s < 6; s++) {
    planner = createPlanner({ seed: `mix-${a}-${b}-${s}`, vibe: o.vibe ?? 0.3, mode: 'preview' });
    first = planner.first({ id: A.id, analysis: A.analysis }, { startAt: 0 });
    tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom });
    if (!o.wantSync || (tr.synced && BLENDS.includes(tr.type))) break;
  }
  if (o.wantSync && !(tr.synced && BLENDS.includes(tr.type))) {
    forced = true;
    tr = planner.next({ play: first.play, analysis: A.analysis }, { id: B.id, analysis: B.analysis }, { earliest: first.play.soloFrom, force: { type: BLENDS[(a + b) % 3] } });
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

  const monoA = monoOf(bufA);
  const monoB = monoOf(bufB);
  const res = {
    a,
    b,
    from: `${A.analysis.bpm.toFixed(1)} BPM ${A.analysis.key.camelot}`,
    to: `${B.analysis.bpm.toFixed(1)} BPM ${B.analysis.key.camelot}`,
    type: tr.type,
    label: tr.label,
    beats: tr.beats,
    synced: !!tr.synced,
    forced,
    degraded: !!tr.degraded,
    rate: tr.play.rate[0].v,
    tStart: tr.tStart,
    tEnd: tr.tEnd,
    ...peakOf(mix.L, mix.R),
  };

  const sources = [
    { play: outPlay, endAt: tr.aEndAt, mono: monoA, sr: bufA.sampleRate },
    { play: tr.play, endAt: null, mono: monoB, sr: bufB.sampleRate },
  ];
  res.gaps = findGaps(mix.L, mix.R, first.tEnd, Math.min(seconds - 0.4, tr.tEnd + 5), sources);
  res.clicks = findClicks(tracksOnly, tracksOnlyR, joinsOf(first, [tr])).filter((c) => c.click);

  const dur = tr.tEnd - tr.tStart;
  if (tr.synced && tr.beats > 0 && dur > 1.2) {
    // Timing stems: the same plan with every strip left open, one track each — where each track's
    // audio really is, without the EQ moves deciding which drums are audible at which moment.
    const flatA = await render(steps, seconds, { mute: new Set([tr.play.id]), flat: true });
    const flatB = await render(steps, seconds, { mute: new Set([first.play.id]), flat: true });
    const beatSec = dur / tr.beats;
    const wide = Math.round(0.55 * beatSec * 1000);
    const fine = Math.round(0.25 * beatSec * 1000);
    const pad = wide / 1000 + 0.03;
    const t0 = tr.tStart - pad;
    const t1 = tr.tEnd + pad;
    const L = LIMITER.lookahead; // constant delay of everything the engine renders
    const eA = attackEnvelope(monoOf2(flatA.L, flatA.R), SR, t0 + L, t1 + L);
    const eB = attackEnvelope(monoOf2(flatB.L, flatB.R), SR, t0 + L, t1 + L);
    const m = bestLag(eA, eB, wide);
    res.lagMs = m.lag;
    res.lagBeats = m.lag / 1000 / beatSec;
    res.corrPeak = m.peak;
    res.corrZero = m.atZero;
    res.fineLagMs = bestLag(eA, eB, fine).lag;
    // The same question for the kick band alone (< 150 Hz): interleaved kick drums are what a
    // half-beat error sounds like, and hats or claps between the beats cannot fake it.
    const kA = attackEnvelope(kickBand(monoOf2(flatA.L, flatA.R), SR), SR, t0 + L, t1 + L);
    const kB = attackEnvelope(kickBand(monoOf2(flatB.L, flatB.R), SR), SR, t0 + L, t1 + L);
    const km = bestLag(kA, kB, wide);
    res.kickLagMs = km.lag;
    res.kickLagBeats = km.lag / 1000 / beatSec;
    res.kickCorrPeak = km.peak;
    res.kickCorrZero = km.atZero;
    // Each stem against the shared beat grid (the two grids coincide, see gridError below).
    const beatTimes = (play, an) => {
      const p = { ...play, endAt: null };
      return an.beats.map((x) => timeAtPosition(p, x)).filter((t) => t >= tr.tStart - 1e-6 && t <= tr.tEnd + 1e-6);
    };
    res.gridA = gridProfile(eA, beatTimes(outPlay, A.analysis), t0);
    res.gridB = gridProfile(eB, beatTimes(tr.play, B.analysis), t0);
    // Rendered stem against its own plan (raw track read through positionAt): the engine's timing on real audio.
    const pA = planEnvelope(attackEnvelope(monoA, bufA.sampleRate, 0, bufA.duration), outPlay, t0, t1);
    const pB = planEnvelope(attackEnvelope(monoB, bufB.sampleRate, 0, bufB.duration), tr.play, t0, t1);
    res.engineLagA = bestLag(pA, eA, 30).lag;
    res.engineLagB = bestLag(pB, eB, 30).lag;
    const g = gridError(outPlay, A.analysis, tr.play, B.analysis, tr.tStart, tr.tEnd);
    res.gridMedianMs = g.median;
    res.gridMaxMs = g.max;
    // The whole track's verdict on its own grid (kick band and full band).
    const wa = phaseProfile(monoA, bufA.sampleRate, A.analysis);
    const wb = phaseProfile(monoB, bufB.sampleRate, B.analysis);
    res.trackA = { kickHalfOverOn: wa.kickHalfOverOn, fullHalfOverOn: wa.fullHalfOverOn };
    res.trackB = { kickHalfOverOn: wb.kickHalfOverOn, fullHalfOverOn: wb.fullHalfOverOn };
  }
  return res;
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

window.mix = { loadCrate, choosePairs, pair, miniSet, profiles, size: () => crate.length };
window.mixReady = true;

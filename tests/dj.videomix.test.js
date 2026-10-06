// Full-song transition planner (js/dj/videomix.js, SPEC 6.4): invariants of every move on a 10 ms grid,
// determinism, fuzz, leave-point statistics and the type distribution against vibe / mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_MIN,
  LENGTHS,
  PLAY_LEAD_S,
  RISER_GAIN,
  SUM_MAX,
  VIDEO_MODES,
  VIDEO_TYPES,
  VOL_STEP_S,
  leavePoint,
  planVideoTransition,
  volumeAt,
} from '../js/dj/videomix.js';
import { createRng } from '../js/util/rng.js';

const EPS = 1e-6;
const BLENDS = new Set(['longBlend', 'crossfade']);
const DROPS = new Set(['fadeDrop', 'riserDrop']);
const VIBES = [0, 0.25, 0.3, 0.5, 0.75, 1];

/** The test's own interpolator (independent of volumeAt): held before the first / after the last point. */
function lerp(pts, t) {
  if (t <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (pts[i + 1].t <= t) i++;
  const a = pts[i];
  const b = pts[i + 1];
  return b.t > a.t ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : b.v;
}

/** A normal hand-over between two invented full songs; `o` overrides any part. */
function input(o = {}) {
  return {
    seed: o.seed ?? 'vm',
    vibe: o.vibe ?? 0.5,
    mode: o.mode ?? 'medium',
    playIndex: o.playIndex ?? 3,
    prevType: o.prevType,
    quick: o.quick,
    reason: o.reason,
    earliest: o.earliest ?? 10,
    force: o.force,
    out: { id: 'song-a', durationS: 240, startedAt: 5, bpm: 124, bpmConfidence: 0.8, energy: 0.6, provider: 'youtube', ...o.out },
    inc: { id: 'song-b', durationS: 210, bpm: 128, bpmConfidence: 0.8, energy: 0.6, provider: 'youtube', ...o.inc },
  };
}

/** Every number in a value, recursively. */
function numbers(x, out = []) {
  if (typeof x === 'number') out.push(x);
  else if (Array.isArray(x)) for (const y of x) numbers(y, out);
  else if (x && typeof x === 'object') for (const k of Object.keys(x)) numbers(x[k], out);
  return out;
}

const trustedBpm = (s) => (s && Number.isFinite(s.bpm) && s.bpm >= 40 && s.bpm <= 260 && Number.isFinite(s.bpmConfidence) && s.bpmConfidence >= 0.5 ? s.bpm : null);
const durOf = (s) => (s && Number.isFinite(s.durationS) && s.durationS > 0 ? s.durationS : 210);

/**
 * Classify a plan: 'quick' (Skip), 'natural' (left where leavePoint says) or 'late' (the natural moment
 * had passed, started at the earliest allowed moment).
 */
function pathOf(tr, inp) {
  if (inp.quick) return 'quick';
  const started = Number.isFinite(inp.out?.startedAt) ? inp.out.startedAt : Number.isFinite(inp.earliest) ? inp.earliest : 0;
  return tr.tStart === started + leavePoint(inp) && tr.leaveAt === leavePoint(inp) ? 'natural' : 'late';
}

/** All the invariants of SPEC 6.4 + the brief; returns a list of problems (empty = fine). */
function check(tr, inp, { forced = false } = {}) {
  const bad = [];
  const say = (m) => bad.push(m);
  if (!VIDEO_TYPES.includes(tr.type)) say(`type ${tr.type}`);
  if (!numbers(tr).every(Number.isFinite)) say('non-finite number');
  if (typeof tr.label !== 'string' || !tr.label) say('label');
  if (typeof tr.why !== 'string' || !/no beat-matching/.test(tr.why)) say(`why "${tr.why}"`);
  if (!/^(Cut|(Long blend|Crossfade|Fade drop|Riser drop) · (\d+(\.\d)? s|\d+ beats?))$/.test(tr.label)) say(`label "${tr.label}"`);
  if (tr.type === 'cut' ? tr.label !== 'Cut' : !tr.label.startsWith({ longBlend: 'Long blend', crossfade: 'Crossfade', fadeDrop: 'Fade drop', riserDrop: 'Riser drop' }[tr.type])) say(`label/type ${tr.label} ${tr.type}`);
  const { tStart, tEnd, incStart, outVol, incVol } = tr;
  const len = tEnd - tStart;
  const E = Number.isFinite(inp.earliest) ? inp.earliest : -Infinity;
  const D = durOf(inp.out);
  if (!(len > 0)) say(`length ${len}`);
  if (len > LENGTHS.longBlend[1] + EPS) say(`too long ${len}`);
  // lanes: sorted, in range, anchored
  for (const [name, lane] of [['out', outVol], ['inc', incVol]]) {
    if (!Array.isArray(lane) || lane.length < 2) {
      say(`${name} lane too short`);
      return bad;
    }
    for (let i = 0; i < lane.length; i++) {
      const p = lane[i];
      if (!(p.v >= 0 && p.v <= 1)) say(`${name}[${i}].v ${p.v}`);
      if (i && !(p.t >= lane[i - 1].t)) say(`${name} unsorted at ${i}`);
      if (!(p.t >= E - 1e-9)) say(`${name}[${i}] at ${p.t} before earliest ${E}`);
      if (i && name === 'out' && p.v > lane[i - 1].v + 1e-12) say('out lane rises');
      if (i && name === 'inc' && p.v < lane[i - 1].v - 1e-12) say('inc lane falls');
    }
  }
  if (outVol[0].t !== tStart || outVol[0].v !== 1) say(`out anchor ${JSON.stringify(outVol[0])} vs tStart ${tStart}`);
  if (incVol[0].t !== incStart || incVol[0].v !== 0) say(`inc anchor ${JSON.stringify(incVol[0])} vs incStart ${incStart}`);
  const oL = outVol[outVol.length - 1];
  const iL = incVol[incVol.length - 1];
  if (!(oL.v === 0 && oL.t <= tEnd + 1e-9)) say(`outgoing not at 0 by tEnd ${JSON.stringify(oL)} ${tEnd}`);
  if (!(iL.v === 1 && iL.t <= tEnd + 1e-9)) say(`incoming not at 1 by tEnd ${JSON.stringify(iL)} ${tEnd}`);
  if (!(tStart >= E - 1e-9)) say(`tStart ${tStart} < earliest ${E}`);
  if (!(incStart >= E - 1e-9)) say(`incStart ${incStart} < earliest ${E}`);
  if (!(incStart >= tStart - PLAY_LEAD_S - 1e-9)) say(`incStart ${incStart} too early vs tStart ${tStart}`);
  // the incoming is started at least ~PLAY_LEAD_S before its volume first rises
  const rise = incVol.find((p) => p.v > 0);
  if (!rise || !(rise.t - incStart >= PLAY_LEAD_S - 1e-9)) say(`incoming rises ${rise && rise.t - incStart} s after play()`);
  // 10 ms grid (plus every breakpoint): ranges and the summed-amplitude bound
  const t0 = Math.min(incStart, tStart) - 0.5;
  const t1 = tEnd + 0.5;
  const times = [...outVol.map((p) => p.t), ...incVol.map((p) => p.t)];
  for (let t = t0; t <= t1; t += 0.01) times.push(t);
  let worst = 0;
  for (const t of times) {
    const a = lerp(outVol, t);
    const b = lerp(incVol, t);
    if (!(a >= 0 && a <= 1 && b >= 0 && b <= 1)) say(`out of range at ${t}: ${a} ${b}`);
    worst = Math.max(worst, a + b);
    if (t >= tEnd && (a !== 0 || b !== 1)) say(`not settled after tEnd at ${t}: ${a} ${b}`);
    if (t < tStart && a !== 1) say(`outgoing moved before tStart at ${t}`);
  }
  if (worst > SUM_MAX + 1e-9) say(`summed amplitude ${worst.toFixed(4)} > ${SUM_MAX}`);
  if (worst > 2) bad.length = Math.min(bad.length, 20); // keep reports readable
  // equal-power moves: ≥ 6 linear segments inside the move, both lanes on the same times
  if (BLENDS.has(tr.type)) {
    const inside = (lane) => lane.filter((p) => p.t >= tStart - 1e-9 && p.t <= tEnd + 1e-9);
    if (inside(outVol).length < 7 || inside(incVol).length < 7) say('equal-power curve with < 6 segments');
    const ti = inside(incVol).map((p) => p.t);
    if (JSON.stringify(inside(outVol).map((p) => p.t)) !== JSON.stringify(ti)) say('blend lanes on different times');
  }
  // fx: riser / impact only, nothing before earliest, at the right moments and levels
  for (const f of tr.fx) {
    if (!(f.t >= E - 1e-9)) say(`fx before earliest ${f.t}`);
    if (f.kind === 'riser') {
      if (tr.type !== 'riserDrop') say('riser outside a riser drop');
      if (Math.abs(f.t - tStart) > 1e-9 || Math.abs(f.t + f.dur - tEnd) > 1e-9) say('riser not spanning the move');
      if (!(f.gain >= RISER_GAIN[0] && f.gain <= RISER_GAIN[1])) say(`riser gain ${f.gain}`);
    } else if (f.kind === 'impact') {
      if (Math.abs(f.t - tEnd) > 1e-9) say('impact not on tEnd');
      if (!(f.gain > 0.1 && f.gain <= 0.42 + 1e-9)) say(`impact gain ${f.gain}`);
    } else say(`fx kind ${f.kind}`);
  }
  if (DROPS.has(tr.type) && !tr.fx.some((f) => f.kind === 'impact')) say('drop without an impact');
  if (tr.type === 'riserDrop' && !tr.fx.some((f) => f.kind === 'riser')) say('riser drop without a riser');
  if (BLENDS.has(tr.type) && tr.fx.length) say('fx on a blend');
  // marks
  if (!tr.marks.length) say('no marks');
  for (let i = 0; i < tr.marks.length; i++) {
    const m = tr.marks[i];
    if (!(typeof m.label === 'string' && m.label)) say('mark label');
    if (!(m.t >= tStart - 1e-9 && m.t <= tEnd + 1e-9)) say(`mark ${m.label} at ${m.t} outside the move`);
    if (i && m.t < tr.marks[i - 1].t) say('marks unsorted');
  }
  // positions
  if (!(tr.leaveAt >= 0 && tr.leaveAt <= D + 1e-9)) say(`leaveAt ${tr.leaveAt} outside the song (${D})`);
  if (tr.incAt !== 0) say(`incAt ${tr.incAt}`);
  if (!(Number.isInteger(tr.beats) && tr.beats >= 0)) say(`beats ${tr.beats}`);
  const bpm = trustedBpm(inp.out);
  if (tr.beats > 0 && !(bpm && Math.abs(len - (tr.beats * 60) / bpm) < EPS)) say(`beats ${tr.beats} vs length ${len} at ${bpm}`);
  // lengths per path
  const path = pathOf(tr, inp);
  if (tr.type === 'cut' && len > LENGTHS.cut[1] + EPS) say(`cut ${len} s`);
  if (path === 'quick') {
    if (!['crossfade', 'cut'].includes(tr.type)) say(`Skip used ${tr.type}`);
    if (!(tStart <= E + PLAY_LEAD_S + 1e-9) && Number.isFinite(E)) say(`Skip starts at ${tStart}, earliest ${E}`);
    if (tr.type === 'crossfade' && !(len >= LENGTHS.quickCrossfade[0] - EPS && len <= LENGTHS.quickCrossfade[1] + EPS)) say(`Skip crossfade ${len}`);
    if (!/skipped/.test(tr.why)) say('Skip not said');
  } else if (path === 'natural') {
    if (!forced) {
      const [lo, hi] = LENGTHS[tr.type];
      const room = Math.min(hi, 0.4 * D); // a blend / drop is shrunk only by the songs' caps
      if (!(len <= hi + EPS)) say(`${tr.type} ${len} s above ${hi}`);
      if (!(len >= Math.min(lo, room) - EPS)) say(`${tr.type} ${len} s below ${lo}`);
      const vibe = Number.isFinite(inp.vibe) ? Math.min(1, Math.max(0, inp.vibe)) : 0.5; // the module's defaulting
      if (tr.type === 'riserDrop' && !(vibe >= 0.3)) say(`riser drop at vibe ${inp.vibe}`);
    }
    if (D >= len + 1 && !(tr.leaveAt <= D - len - 1 + EPS)) say(`leaveAt ${tr.leaveAt} later than D − length − 1 (${D - len - 1})`);
  } else {
    if (tr.type !== 'cut' && !(len >= LATE_MIN[tr.type] - EPS)) say(`late ${tr.type} squeezed to ${len}`);
    if (!/later than planned|shortened|ending|ended/.test(tr.why)) say(`late plan does not say so: ${tr.why}`);
  }
  return bad;
}

const assertClean = (tr, inp, opts) => {
  const bad = check(tr, inp, opts);
  assert.deepEqual(bad, [], `${JSON.stringify(inp)} → ${JSON.stringify(tr)}`);
};

test('volumeAt agrees with an independent interpolator', () => {
  const pts = [{ t: 1, v: 0 }, { t: 2, v: 0.5 }, { t: 2, v: 0.6 }, { t: 4, v: 1 }];
  for (let t = 0; t <= 5; t += 0.05) assert.ok(Math.abs(volumeAt(pts, t) - lerp(pts, t)) < 1e-12, `t ${t}`);
  assert.equal(volumeAt([], 3), 0);
});

test('every recipe × mode × vibe obeys the invariants (10 ms grid)', () => {
  let n = 0;
  const paths = { natural: 0, late: 0, quick: 0 };
  for (const force of VIDEO_TYPES) {
    for (const mode of VIDEO_MODES) {
      for (const vibe of VIBES) {
        for (const tempo of [{ bpm: 124, bpmConfidence: 0.8 }, { bpm: 124, bpmConfidence: 0.2 }, { bpm: undefined }]) {
          for (const seed of ['a', 'b', 'c']) {
            for (const when of ['natural', 'late', 'past', 'quick', 'unset']) {
              const o = { force, mode, vibe, seed, playIndex: n % 7, out: tempo, inc: tempo };
              if (when === 'late') o.earliest = 5 + leavePoint(input(o)) + 3; // natural moment just passed
              if (when === 'past') o.earliest = 5 + 240 + 30; // the outgoing song is over
              if (when === 'quick') Object.assign(o, { quick: true, earliest: 77.7 });
              const inp = input(o);
              if (when === 'unset') delete inp.earliest;
              const tr = planVideoTransition(inp);
              assertClean(tr, inp, { forced: true });
              if (when === 'natural' || when === 'unset') assert.equal(tr.type, force, 'a forced move is built as asked');
              paths[pathOf(tr, inp)]++;
              n++;
            }
          }
        }
      }
    }
  }
  console.log(`      invariants: ${n} plans · ${JSON.stringify(paths)}`);
  assert.ok(paths.natural > 0 && paths.late > 0 && paths.quick > 0);
});

test('natural plans: leaveAt === leavePoint(input), and leavePoint ignores earliest / quick', () => {
  for (let k = 0; k < 400; k++) {
    const mode = VIDEO_MODES[k % 3];
    const inp = input({ seed: `n${k}`, mode, vibe: (k % 11) / 10, playIndex: k, earliest: 0 });
    const tr = planVideoTransition(inp);
    assert.equal(pathOf(tr, inp), 'natural');
    assert.equal(tr.leaveAt, leavePoint(inp));
    assert.equal(tr.tStart, inp.out.startedAt + tr.leaveAt);
    assert.equal(leavePoint({ ...inp, earliest: 1e6, quick: true }), leavePoint(inp));
    // the estimate without the incoming song: same as with an unconstraining incoming of unknown energy / tempo
    const { inc, ...noInc } = inp;
    assert.equal(leavePoint(noInc), leavePoint({ ...inp, inc: { id: inc.id } }));
    if (mode !== 'full') assert.equal(leavePoint(noInc), leavePoint(inp), 'short / medium leave points do not depend on the incoming');
  }
});

test('determinism: deep-equal across call histories; inputs untouched; seeds and play indexes matter', () => {
  const inputs = [];
  for (let k = 0; k < 60; k++) {
    inputs.push(input({ seed: `d${k % 5}`, vibe: (k % 6) / 5, mode: VIDEO_MODES[k % 3], playIndex: k, prevType: VIDEO_TYPES[k % 5], quick: k % 9 === 0, earliest: k % 4 === 0 ? 400 : 10 }));
  }
  const copies = inputs.map((x) => structuredClone(x));
  const first = inputs.map((x) => planVideoTransition(x));
  assert.deepEqual(inputs, copies, 'inputs are not mutated');
  // a different call history: reversed order with unrelated plans and leave points in between
  const second = [];
  for (let k = inputs.length - 1; k >= 0; k--) {
    planVideoTransition(input({ seed: 'noise', playIndex: k * 13, vibe: 1, mode: 'short' }));
    leavePoint(input({ seed: 'noise2', playIndex: k }));
    second[k] = planVideoTransition(structuredClone(inputs[k]));
  }
  assert.deepEqual(second, first);
  // different seeds / play indexes → different plans. Without a trusted tempo every length is continuous,
  // so single plans differ; with one, lengths and leave points come in whole bars (a crossfade has no
  // other free parameter), so single plans may coincide but whole sets still differ.
  const free = { bpmConfidence: 0.1 };
  const bySeed = new Set();
  const byIndex = new Set();
  const sets = new Set();
  for (let k = 0; k < 200; k++) {
    bySeed.add(JSON.stringify(planVideoTransition(input({ seed: `s${k}`, out: free }))));
    byIndex.add(JSON.stringify(planVideoTransition(input({ playIndex: k, out: free }))));
  }
  for (let k = 0; k < 60; k++) {
    const set = [];
    for (let p = 0; p < 12; p++) set.push(planVideoTransition(input({ seed: `set${k}`, playIndex: p })));
    sets.add(JSON.stringify(set));
  }
  assert.ok(bySeed.size >= 198, `only ${bySeed.size} distinct plans over 200 seeds`);
  assert.ok(byIndex.size >= 198, `only ${byIndex.size} distinct plans over 200 play indexes`);
  assert.equal(sets.size, 60, '12-song sets under 60 seeds (trusted tempo) all differ');
});

test('fuzz: 4000 random inputs never throw and keep every invariant', () => {
  const r = createRng('videomix-fuzz');
  const maybe = (p, f) => (r.next() < p ? f() : undefined);
  const hist = {};
  const paths = { natural: 0, late: 0, quick: 0 };
  let over = 0;
  for (let k = 0; k < 4000; k++) {
    const outPrev = r.next() < 0.15;
    const incPrev = r.next() < 0.15;
    const durOut = outPrev ? r.range(20, 31) : r.next() < 0.05 ? r.pick([null, NaN, -5, 0]) : r.range(20, 900);
    const startedAt = r.range(-20, 5000);
    const bpmOf = () => (r.next() < 0.7 ? r.pick([r.range(60, 190), r.range(30, 300), NaN, 0]) : undefined);
    const D = Number.isFinite(durOut) && durOut > 0 ? durOut : 210;
    const earliestKind = r.int(5);
    const earliest =
      earliestKind === 0
        ? startedAt + r.range(0, 30) // early in the song
        : earliestKind === 1
          ? startedAt + r.range(0, D) // anywhere in it
          : earliestKind === 2
            ? startedAt + D + r.range(-3, 2000) // around or far past the end
            : earliestKind === 3
              ? startedAt - r.range(0, 60) // before the outgoing was heard
              : r.pick([startedAt + r.range(D - 2, D + 0.5), undefined, NaN]);
    const inp = {
      seed: r.pick(['x', 'y', 42, 'long seed text', '']),
      vibe: r.next() < 0.9 ? r.next() : r.pick([NaN, -1, 2, undefined]),
      mode: r.next() < 0.93 ? r.pick(VIDEO_MODES) : r.pick(['preview', undefined, 'bogus']),
      playIndex: r.next() < 0.95 ? r.int(500) : r.pick([NaN, -3, 2.7]),
      prevType: maybe(0.7, () => r.pick([...VIDEO_TYPES, 'bassSwap', 'fadeIn'])),
      quick: r.next() < 0.2,
      earliest,
      out: {
        id: `o${k}`,
        durationS: durOut,
        startedAt,
        bpm: bpmOf(),
        bpmConfidence: maybe(0.8, () => r.next()),
        energy: maybe(0.6, () => r.pick([r.next(), r.range(-1, 2), NaN])),
        provider: outPrev ? 'preview' : r.pick(['youtube', 'youtube', undefined]),
      },
      inc: r.next() < 0.95
        ? {
            id: `i${k}`,
            durationS: incPrev ? r.range(20, 31) : r.next() < 0.05 ? r.pick([null, NaN, 3]) : r.range(20, 900),
            bpm: bpmOf(),
            bpmConfidence: maybe(0.8, () => r.next()),
            energy: maybe(0.6, () => r.next()),
            provider: incPrev ? 'preview' : 'youtube',
          }
        : undefined,
    };
    let tr;
    assert.doesNotThrow(() => {
      tr = planVideoTransition(inp);
    }, JSON.stringify(inp));
    const bad = check(tr, inp);
    assert.deepEqual(bad, [], `#${k} ${JSON.stringify(inp)} → ${JSON.stringify(tr)}`);
    assert.deepEqual(planVideoTransition(structuredClone(inp)), tr, 'deterministic');
    hist[tr.type] = (hist[tr.type] || 0) + 1;
    paths[pathOf(tr, inp)]++;
    if (/had ended|was ending/.test(tr.why)) over++;
  }
  console.log(`      fuzz: 4000 inputs · types ${JSON.stringify(hist)} · paths ${JSON.stringify(paths)} · song over / ending ${over}`);
  for (const t of VIDEO_TYPES) assert.ok(hist[t] > 0, `${t} never planned in the fuzz`);
});

/** Simple text histogram of values into `bins` buckets between lo and hi. */
function histogram(values, lo, hi, bins) {
  const c = new Array(bins).fill(0);
  for (const v of values) c[Math.min(bins - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * bins)))]++;
  const w = (hi - lo) / bins;
  return c.map((n, i) => `${(lo + i * w).toFixed(0)}–${(lo + (i + 1) * w).toFixed(0)}:${n}`).join(' ');
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

test('leave points per mode: short ≈ 45 s, medium ≈ 90 s (bar-snapped when trusted), full = end − guard − move', () => {
  const N = 1500;
  for (const trusted of [true, false]) {
    const tempo = trusted ? { bpm: 124, bpmConfidence: 0.9 } : { bpm: 124, bpmConfidence: 0.1 };
    const bar = (4 * 60) / 124;
    for (const [mode, lo, hi, target] of [['short', 38, 52, 45], ['medium', 77, 103, 90]]) {
      const xs = [];
      for (let k = 0; k < N; k++) {
        const inp = input({ seed: `L${k}`, mode, playIndex: k, vibe: (k % 5) / 4, out: { durationS: 300, ...tempo }, earliest: 0 });
        const tr = planVideoTransition(inp);
        xs.push(tr.leaveAt);
        if (trusted) assert.ok(Math.abs(tr.leaveAt / bar - Math.round(tr.leaveAt / bar)) < 1e-6, `${tr.leaveAt} not on a bar`);
      }
      const m = mean(xs);
      console.log(`      ${mode} (${trusted ? 'trusted' : 'no'} tempo): mean ${m.toFixed(1)} s · min ${Math.min(...xs).toFixed(1)} · max ${Math.max(...xs).toFixed(1)} · ${histogram(xs, lo, hi, 7)}`);
      assert.ok(Math.abs(m - target) < target * 0.03, `${mode} mean ${m}`);
      assert.ok(Math.min(...xs) >= lo && Math.max(...xs) <= hi, `${mode} range ${Math.min(...xs)}..${Math.max(...xs)}`);
      assert.ok(new Set(xs.map((x) => x.toFixed(2))).size >= (trusted ? 6 : 100), 'seeded spread');
    }
    // full: the outro guard (end − leave − move) is 8–20 s on songs ≥ 200 s (up to a bar more when snapped)
    const guards = [];
    for (let k = 0; k < N; k++) {
      const D = 200 + (k % 7) * 60;
      const inp = input({ seed: `F${k}`, mode: 'full', playIndex: k, vibe: (k % 5) / 4, out: { durationS: D, ...tempo }, earliest: 0 });
      const tr = planVideoTransition(inp);
      const g = D - tr.leaveAt - (tr.tEnd - tr.tStart);
      guards.push(g);
      assert.ok(g >= 8 - EPS && g <= 20 + EPS, `guard ${g} (D ${D}, ${tr.type})`);
      if (trusted) assert.ok(Math.abs(tr.leaveAt / bar - Math.round(tr.leaveAt / bar)) < 1e-6, 'full leave on a bar');
    }
    console.log(`      full (${trusted ? 'trusted' : 'no'} tempo): outro guard mean ${mean(guards).toFixed(1)} s · ${histogram(guards, 8, 20, 6)}`);
  }
  // a 30-second fallback clip is left 1–2.5 s before its own end (like preview mode), in every mode
  const tails = [];
  for (let k = 0; k < 600; k++) {
    const inp = input({ seed: `P${k}`, mode: VIDEO_MODES[k % 3], playIndex: k, out: { durationS: 30, provider: 'preview', bpmConfidence: k % 2 ? 0.9 : 0 }, earliest: 0 });
    const tr = planVideoTransition(inp);
    const tail = 30 - tr.leaveAt - (tr.tEnd - tr.tStart);
    tails.push(tail);
    assert.ok(tail >= 1 - EPS && tail <= 2.5 + EPS, `preview tail ${tail}`);
    assert.notEqual(tr.type, 'longBlend', 'no 12-second blend out of a 30-second clip');
  }
  console.log(`      preview clip out: end − leave − move ${Math.min(...tails).toFixed(2)}..${Math.max(...tails).toFixed(2)} s`);
  // songs shorter than the target behave like full plays: never later than durationS − length − 1
  for (let k = 0; k < 300; k++) {
    const D = 25 + k * 0.5;
    const inp = input({ seed: `S${k}`, mode: 'medium', playIndex: k, out: { durationS: D }, earliest: 0 });
    const tr = planVideoTransition(inp);
    assert.ok(tr.leaveAt <= D - (tr.tEnd - tr.tStart) - 1 + EPS, `short song ${D}: leave ${tr.leaveAt}`);
    assert.ok(tr.leaveAt >= 0);
  }
});

/** Share of each type over n seeds for one setting. */
function distribution(o, n = 3000) {
  const h = Object.fromEntries(VIDEO_TYPES.map((t) => [t, 0]));
  for (let k = 0; k < n; k++) h[planVideoTransition(input({ ...o, seed: `T${k}`, playIndex: k, earliest: 0 })).type]++;
  return Object.fromEntries(VIDEO_TYPES.map((t) => [t, h[t] / n]));
}
const pct = (d) => VIDEO_TYPES.map((t) => `${t} ${(100 * d[t]).toFixed(1)}%`).join(' · ');
const blendShare = (d) => d.longBlend + d.crossfade;

test('type distribution: smooth ≈ blends only, wild uses drops / cuts, full leans on long blends', () => {
  const D = {};
  for (const mode of VIDEO_MODES) {
    for (const vibe of [0, 0.3, 0.5, 0.75, 1]) {
      const d = distribution({ mode, vibe });
      D[`${mode}${vibe}`] = d;
      console.log(`      ${mode.padEnd(6)} vibe ${vibe.toFixed(2)}: ${pct(d)}`);
    }
  }
  for (const mode of VIDEO_MODES) {
    assert.ok(blendShare(D[`${mode}0`]) >= 0.97, `${mode} vibe 0 blends ${blendShare(D[`${mode}0`])}`);
    assert.equal(D[`${mode}0`].riserDrop, 0, 'no riser below vibe 0.3');
    assert.ok(D[`${mode}0.3`].riserDrop > 0, 'riser reachable from vibe 0.3');
    // blends thin out as the vibe rises
    assert.ok(blendShare(D[`${mode}0`]) > blendShare(D[`${mode}0.5`]) && blendShare(D[`${mode}0.5`]) > blendShare(D[`${mode}1`]));
    for (const t of VIDEO_TYPES) assert.ok(D[`${mode}1`][t] > 0.01 || (t === 'longBlend' && D[`${mode}1`][t] > 0), `${mode} wild never plays ${t}`);
  }
  assert.ok(1 - blendShare(D.medium1) >= 0.6, `medium wild drops+cuts ${1 - blendShare(D.medium1)}`);
  assert.ok(1 - blendShare(D.full1) >= 0.45, `full wild drops+cuts ${1 - blendShare(D.full1)}`);
  assert.ok(1 - blendShare(D.short1) >= 0.7, `short wild drops+cuts ${1 - blendShare(D.short1)}`);
  // full → more long blends, short → more drops / cuts
  for (const vibe of [0.3, 0.5, 0.75]) {
    assert.ok(D[`full${vibe}`].longBlend > D[`medium${vibe}`].longBlend && D[`medium${vibe}`].longBlend > D[`short${vibe}`].longBlend, `long blends by mode at ${vibe}`);
    assert.ok(blendShare(D[`short${vibe}`]) < blendShare(D[`medium${vibe}`]) && blendShare(D[`medium${vibe}`]) < blendShare(D[`full${vibe}`]), `drops by mode at ${vibe}`);
  }
  // energy arc: a lift favours drops, a come-down long blends
  const lift = distribution({ mode: 'medium', vibe: 0.5, out: { energy: 0.3 }, inc: { energy: 0.9 } });
  const down = distribution({ mode: 'medium', vibe: 0.5, out: { energy: 0.9 }, inc: { energy: 0.3 } });
  console.log(`      energy lift  : ${pct(lift)}\n      energy drop  : ${pct(down)}`);
  assert.ok(lift.fadeDrop + lift.riserDrop > D["medium0.5"].fadeDrop + D["medium0.5"].riserDrop);
  assert.ok(down.longBlend > D["medium0.5"].longBlend);
});

test('repeat penalty: the move that brought the song in is chosen much less often', () => {
  const base = distribution({ mode: 'medium', vibe: 0.65 });
  const rows = [];
  for (const t of VIDEO_TYPES) {
    const after = distribution({ mode: 'medium', vibe: 0.65, prevType: t });
    const ratio = after[t] / base[t];
    rows.push(`${t} ${(100 * base[t]).toFixed(1)}% → ${(100 * after[t]).toFixed(1)}% (×${ratio.toFixed(2)})`);
    assert.ok(ratio < 0.6, `${t}: ${base[t]} → ${after[t]}`);
    assert.ok(after[t] > 0, `${t} still reachable after itself`);
  }
  console.log(`      repeat penalty (medium, vibe 0.65): ${rows.join(' · ')}`);
});

test('Skip (quick): starts at earliest with a 1.5–3 s crossfade or a cut; cuts grow with the vibe', () => {
  const share = {};
  for (const vibe of [0, 0.5, 1]) {
    let cuts = 0;
    for (let k = 0; k < 1000; k++) {
      const inp = input({ seed: `Q${k}`, vibe, playIndex: k, quick: true, earliest: 60 });
      const tr = planVideoTransition(inp);
      assertClean(tr, inp);
      assert.equal(tr.incStart, 60, 'the incoming play() goes out at earliest');
      assert.equal(tr.tStart, 60 + PLAY_LEAD_S);
      if (tr.type === 'cut') cuts++;
    }
    share[vibe] = cuts / 1000;
  }
  console.log(`      Skip: cut share by vibe ${JSON.stringify(share)}`);
  assert.ok(share[0] < 0.05 && share[0] < share[0.5] && share[0.5] < share[1] && share[1] > 0.4);
  // Skip with under a second of the outgoing left → a cut; after its end → a cut that says so
  const ending = planVideoTransition(input({ quick: true, earliest: 5 + 240 - 1.2 }));
  assert.equal(ending.type, 'cut');
  const ended = planVideoTransition(input({ quick: true, earliest: 5 + 240 + 10 }));
  assert.equal(ended.type, 'cut');
  assert.equal(ended.leaveAt, 240);
  assert.match(ended.why, /skipped · previous song had ended/);
});

test('a quick move after New Set says "new set", not "skipped" — and is otherwise the same plan as Skip’s', () => {
  for (let k = 0; k < 200; k++) {
    const base = { seed: `N${k}`, vibe: (k % 5) / 4, playIndex: k, quick: true, earliest: 60 + (k % 3) * 90 };
    const skip = planVideoTransition(input(base));
    const fresh = planVideoTransition(input({ ...base, reason: 'newset' }));
    assert.match(skip.why, /skipped/);
    assert.match(fresh.why, /new set/);
    assert.doesNotMatch(fresh.why, /skipped/, 'New Set is not a Skip');
    assert.equal(fresh.why, skip.why.replace('skipped', 'new set'), 'only the word differs');
    assert.deepEqual({ ...fresh, why: '' }, { ...skip, why: '' }, 'same move, same timing');
    assert.deepEqual(planVideoTransition(input({ ...base, reason: 'skip' })), skip, "reason 'skip' is the default");
  }
  // with a note of its own: "new set · previous song had ended"
  const ended = planVideoTransition(input({ quick: true, reason: 'newset', earliest: 5 + 240 + 10 }));
  assert.match(ended.why, /new set · previous song had ended/);
  // not quick: the reason changes nothing
  assert.deepEqual(planVideoTransition(input({ reason: 'newset' })), planVideoTransition(input()));
});

test('earliest: a passed leave point starts at earliest; moves shrink or step down near the end', () => {
  // the natural point passed a few seconds ago, plenty of song left → same move, started now
  for (const force of VIDEO_TYPES) {
    const nat = planVideoTransition(input({ force, mode: 'medium', earliest: 0 }));
    const late = input({ force, mode: 'medium', earliest: nat.tStart + 4 });
    const tr = planVideoTransition(late);
    assertClean(tr, late, { forced: true });
    assert.equal(tr.type, force);
    assert.equal(tr.tEnd - tr.tStart, nat.tEnd - nat.tStart, 'same length');
    assert.equal(tr.incStart >= late.earliest - 1e-9 && tr.tStart >= late.earliest, true);
    assert.ok(tr.tStart - late.earliest <= PLAY_LEAD_S + 1e-9, 'started at the earliest allowed moment');
    assert.match(tr.why, /later than planned/);
  }
  // 8 s of song left (+1 s margin) → no long blend fits: crossfade instead
  const near = input({ force: 'longBlend', mode: 'full', earliest: 5 + 240 - 9 - PLAY_LEAD_S });
  const trN = planVideoTransition(near);
  assertClean(trN, near, { forced: true });
  assert.equal(trN.type, 'crossfade');
  assert.ok(trN.leaveAt + (trN.tEnd - trN.tStart) <= 240 - 1 + EPS);
  // 1.2 s left → a fade drop (no crossfade fits) or a cut
  const nearer = input({ force: 'crossfade', earliest: 5 + 240 - 2.2 - PLAY_LEAD_S });
  const trM = planVideoTransition(nearer);
  assertClean(trM, nearer, { forced: true });
  assert.ok(['fadeDrop', 'cut'].includes(trM.type), trM.type);
  // far past the end → a plain cut at earliest, nothing before it
  for (const earliest of [5 + 240 + 0.5, 5 + 240 + 5000]) {
    const past = input({ earliest });
    const tr = planVideoTransition(past);
    assertClean(tr, past);
    assert.equal(tr.type, 'cut');
    assert.equal(tr.leaveAt, 240);
    assert.equal(tr.incStart, earliest);
    assert.match(tr.why, /previous song had ended/);
  }
});

test('labels and why are honest and short', () => {
  const lb = planVideoTransition(input({ force: 'longBlend' }));
  assert.match(lb.label, /^Long blend · \d+ s$/);
  assert.equal(lb.why, 'Full songs · 124 → 128 BPM · blended by volume (no beat-matching on full songs)');
  const rd = planVideoTransition(input({ force: 'riserDrop' }));
  assert.match(rd.label, /^Riser drop · [48] beats$/);
  const rdFree = planVideoTransition(input({ force: 'riserDrop', out: { bpmConfidence: 0.3 } }));
  assert.match(rdFree.label, /^Riser drop · \d(\.\d)? s$/);
  assert.equal(rdFree.beats, 0);
  assert.match(rdFree.why, /^Full songs · tempo unknown → 128 BPM · riser, next song dropped in/);
  const fd = planVideoTransition(input({ force: 'fadeDrop' }));
  assert.equal(fd.label, 'Fade drop · 2 beats');
  assert.equal(planVideoTransition(input({ force: 'cut' })).label, 'Cut');
  const xf = planVideoTransition(input({ force: 'crossfade', out: { bpm: undefined }, inc: { bpm: undefined } }));
  assert.match(xf.label, /^Crossfade · \d+(\.\d)? s$/);
  assert.match(xf.why, /^Full songs · tempos unknown · blended by volume/);
  const toClip = planVideoTransition(input({ inc: { provider: 'preview', durationS: 30 } }));
  assert.match(toClip.why, /^Full song → preview clip · /);
  const clips = planVideoTransition(input({ out: { provider: 'preview', durationS: 30 }, inc: { provider: 'preview', durationS: 30 } }));
  assert.match(clips.why, /^Preview clips · .*\(volume only, no beat-matching\)$/);
  for (let k = 0; k < 300; k++) {
    const tr = planVideoTransition(input({ seed: `W${k}`, playIndex: k, vibe: k / 300 }));
    assert.ok(tr.why.length <= 110, `why too long: ${tr.why}`);
    assert.ok(tr.label.length <= 24, `label too long: ${tr.label}`);
  }
});

test('curves and fx: bounded equal power, a breath before some drops, impacts scaled to the entry', () => {
  const xf = planVideoTransition(input({ force: 'crossfade' }));
  const mid = (xf.tStart + xf.tEnd) / 2;
  const a = lerp(xf.outVol, mid);
  const b = lerp(xf.incVol, mid);
  assert.ok(a + b > 1.05 && a + b <= SUM_MAX, `middle sum ${a + b}`);
  assert.ok(a * a + b * b > 0.6, `middle power ${a * a + b * b} (a linear fade gives 0.5)`);
  // drops: the incoming is silent until one volume tick before tEnd, full on it
  for (const force of ['fadeDrop', 'riserDrop']) {
    const tr = planVideoTransition(input({ force }));
    assert.equal(lerp(tr.incVol, tr.tEnd - VOL_STEP_S - 1e-6), 0);
    assert.equal(lerp(tr.incVol, tr.tEnd), 1);
  }
  // riser drop: the outgoing tapers to ~0.45–0.6 before it is cut; sometimes half a beat early
  let gaps = 0;
  for (let k = 0; k < 400; k++) {
    const tr = planVideoTransition(input({ force: 'riserDrop', seed: `R${k}`, vibe: 0.8 }));
    const lastOn = tr.outVol[tr.outVol.length - 2];
    assert.ok(lastOn.v >= 0.45 && lastOn.v <= 0.6, `taper ${lastOn.v}`);
    if (tr.outVol[tr.outVol.length - 1].t < tr.tEnd - 1e-9) gaps++;
  }
  assert.ok(gaps > 100 && gaps < 350, `breath before the drop in ${gaps}/400`);
  // impacts: loud songs get the full range, quiet ones a smaller boom
  const imp = (energy) => {
    const g = [];
    for (let k = 0; k < 300; k++) g.push(planVideoTransition(input({ force: 'fadeDrop', seed: `I${k}`, inc: { energy } })).fx[0].gain);
    return g;
  };
  const loud = imp(1);
  const quiet = imp(0);
  assert.ok(Math.min(...loud) >= 0.3 - EPS && Math.max(...loud) <= 0.42 + EPS);
  assert.ok(Math.max(...quiet) < Math.min(...loud) + 0.05 && mean(quiet) < mean(loud) * 0.7);
  console.log(`      impact gain: loud song ${mean(loud).toFixed(3)} · quiet song ${mean(quiet).toFixed(3)} · riser breath ${gaps}/400`);
});

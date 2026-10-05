// Optional group (not in the default run: it depends on another area's module):
//   node tests/e2e/engine.e2e.mjs plannerSmoke
// Real planner output → engine, offline. Checks the seam between the two: nothing throws, the engine's
// copy of every play agrees with the planner's (no event was clamped or rewritten on the way in), the
// mix stays finite and under full scale, and every strip is freed afterwards.
import { evalParam, sortEvents, positionAt } from '../../../js/dj/timeline.js';
import { createEngine, truncatePlay, STRIP_DEFAULTS } from '../../../js/dj/engine.js';
import { mulberry32 } from '../../../js/dj/fx.js';
import { suite, fmt, SR } from './lib.js';

function testTrack(ctx, i, bpm, seconds, seed) {
  const buf = ctx.createBuffer(2, Math.round(seconds * SR), SR);
  const per = 60 / bpm;
  const lead = 0.2;
  const rnd = mulberry32(seed);
  const beats = [];
  for (let k = 0; lead + k * per < seconds; k++) {
    const t = lead + k * per;
    beats.push(t);
    if (t > seconds - 0.4) continue;
    const at = Math.round(t * SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let phase = 0;
      for (let n = 0; n < 0.25 * SR; n++) {
        const tt = n / SR;
        phase += (2 * Math.PI * (50 + 90 * Math.exp(-tt / 0.03))) / SR;
        d[at + n] += 0.7 * Math.exp(-tt / 0.1) * Math.min(1, (0.25 - tt) / 0.02) * Math.sin(phase);
      }
    }
  }
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let n = 0; n < d.length; n++) d[n] += 0.1 * Math.sin((2 * Math.PI * (200 + 37 * seed) * n) / SR) + 0.03 * (rnd() * 2 - 1);
  }
  const analysis = {
    v: 1,
    duration: seconds,
    bpm,
    bpmConfidence: 0.9,
    beats,
    downbeat: 0,
    key: { pc: seed % 12, mode: seed % 2 ? 'minor' : 'major', name: 'X', camelot: `${(seed % 12) + 1}${seed % 2 ? 'A' : 'B'}`, confidence: 0.8 },
    loudness: { rms: 0.2, peak: 0.9, trimDb: -3 },
    energy: 0.6,
    energyCurve: Array.from({ length: Math.ceil(seconds) }, () => 0.8),
    cues: { start: beats[0], end: seconds - 0.5, in: beats[0], drop: beats[16] ?? null },
    wave: { cols: 1, perSec: 100, low: new Uint8Array(1), mid: new Uint8Array(1), high: new Uint8Array(1) },
  };
  return { id: `t${i}`, buf, analysis };
}

export default async function plannerSmoke() {
  const { results, check } = suite();
  let P;
  try {
    P = await import('../../../js/dj/planner.js');
  } catch (err) {
    check('planner module not loadable: skipped', true, String(err));
    return results;
  }

  const types = {};
  const problems = [];
  let worstPeak = 0;
  let transitions = 0;
  let oneShots = 0;
  const bpms = [120, 126, 98, 128, 122, 110];
  const SEEDS = 8;
  for (let s = 0; s < SEEDS; s++) {
    for (const vibe of [0.1, 0.9]) {
      const tag = `seed ${s} vibe ${vibe}`;
      const N = 4;
      const ctx = new OfflineAudioContext(2, Math.ceil(((30 * N + 6) * SR) / 128) * 128, SR);
      const engine = createEngine({ context: ctx });
      await engine.start({ at: 1 });
      const planner = P.createPlanner({ seed: `smoke${s}`, vibe, mode: 'preview' });
      const tracks = Array.from({ length: N }, (_, i) => testTrack(ctx, i, bpms[(i + s) % bpms.length], 30, i + s + 1));
      try {
        const opener = planner.first({ id: tracks[0].id, analysis: tracks[0].analysis }, { startAt: 0 });
        engine.addPlay(opener.play, tracks[0].buf);
        engine.addFx(opener.fx, opener.fxEvents);
        let prev = { play: opener.play, analysis: tracks[0].analysis };
        for (let i = 1; i < N; i++) {
          const t = planner.next(prev, { id: tracks[i].id, analysis: tracks[i].analysis }, { earliest: prev.play.soloFrom + 2 });
          transitions++;
          oneShots += t.fx.length;
          types[t.type] = (types[t.type] || 0) + 1;
          if (!engine.extendPlay(t.from, { events: t.aEvents, rate: t.aRate, endAt: t.aEndAt })) problems.push(`${tag}: extendPlay(${t.from}) found no play`);
          engine.addPlay(t.play, tracks[i].buf);
          engine.addFx(t.fx, t.fxEvents);
          // The conductor's copy of the outgoing play, grown the way the SPEC says it grows.
          const mine = { ...prev.play, events: sortEvents(prev.play.events.concat(t.aEvents)), rate: prev.play.rate.concat(t.aRate), endAt: t.aEndAt };
          const theirs = engine.getPlay(t.from);
          for (const at of [t.tStart, (t.tStart + t.tEnd) / 2, t.tEnd, t.aEndAt]) {
            for (const p of Object.keys(STRIP_DEFAULTS)) {
              const a = evalParam(mine.events, p, at, STRIP_DEFAULTS[p]);
              const b = evalParam(theirs.events, p, at, STRIP_DEFAULTS[p]);
              if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a))) problems.push(`${tag} ${t.type}: '${p}' at ${fmt(at, 2)} s is ${a} in the plan, ${b} in the engine`);
            }
            const pa = positionAt({ ...mine, endAt: null }, at);
            const pb = positionAt({ ...theirs, endAt: null }, at);
            if (Math.abs(pa - pb) > 1e-6) problems.push(`${tag} ${t.type}: position at ${fmt(at, 2)} s is ${pa} in the plan, ${pb} in the engine`);
          }
          prev = { play: t.play, analysis: tracks[i].analysis };
        }
      } catch (err) {
        problems.push(`${tag}: threw ${err && err.stack ? err.stack : err}`);
      }
      const out = await ctx.startRendering();
      for (let ch = 0; ch < 2; ch++) {
        const d = out.getChannelData(ch);
        let bad = 0;
        for (let n = 0; n < d.length; n++) {
          const x = Math.abs(d[n]);
          if (!(x <= 8)) bad++;
          else if (x > worstPeak) worstPeak = x;
        }
        if (bad) problems.push(`${tag}: ${bad} non-finite samples`);
      }
      engine.tick();
      const d = engine.debug();
      if (d.strips !== 0 || d.oneShots !== 0 || d.nodes !== d.baselineNodes) problems.push(`${tag}: not torn down (strips ${d.strips}, one-shots ${d.oneShots}, nodes ${d.nodes}/${d.baselineNodes})`);
    }
  }
  check(`planner → engine: ${SEEDS * 2} four-track sets render without a throw, a model mismatch or a leak`, problems.length === 0, problems.slice(0, 6).join(' | ') || `${transitions} transitions (${Object.entries(types).map(([k, v]) => `${k} ${v}`).join(', ')}), ${oneShots} one-shots`);
  check('planner → engine: the mix never exceeds 1.0', worstPeak <= 1, `peak ${fmt(worstPeak, 3)}`);

  // After a cancel in the middle of a rate glide the engine keeps playing along the shortened ramp.
  // If the planner models that moment differently, a beat-matched Skip is off by this much.
  if (typeof P.holdPlayAt === 'function') {
    const play = { id: 1, startAt: 8, offset: 2, rate: [{ t: 8, v: 0.952 }, { t: 16, v: 0.952 }, { t: 24, v: 1.0, ramp: true }], events: [], endAt: null, trimDb: 0 };
    const diff = positionAt(P.holdPlayAt(play, 20), 30) - positionAt(truncatePlay(play, 20), 30);
    check('planner.holdPlayAt() agrees with the engine about a cancel in the middle of a rate glide', Math.abs(diff) < 0.001, `planner's position model is ${fmt(diff * 1000, 1)} ms off what the engine plays (engine.getPlay / truncatePlay is what is rendered)`);
  }
  return results;
}

// 5. A complete hand-authored transition, the way the conductor would deliver it: track A (120 BPM)
//    is playing; some seconds later the plan for a 16-beat bass swap into track B (126 BPM) arrives
//    (extendPlay on A, addPlay for B, FX); B is rate-matched during the overlap, then glides to 1.0.
import { timeAtPosition } from '../../../js/dj/timeline.js';
import { mulberry32 } from '../../../js/dj/fx.js';
import {
  suite,
  renderSet,
  mkPlay,
  ev,
  emptyBuffer,
  addBlip,
  addSine,
  findClicks,
  highlight,
  rms,
  peak,
  maxStep,
  measureLatency,
  fmt,
  ms,
  SR,
} from './lib.js';

const LEAD = 0.25; // audio before beat 0 in both test tracks

/**
 * Four-on-the-floor test track: kick (pitched-down sine) + a timing blip on every beat, a pad, and
 * (unless `bare`) a noise hat on the off-beats. `bare` tracks carry a sharper blip and nothing else
 * with high-frequency content, so beat times can be read off the mix even at low fader levels.
 */
function kickTrack(ctx, bpm, seconds, channel, seed, padHz, bare = false) {
  const buf = emptyBuffer(ctx, seconds);
  const per = 60 / bpm;
  const rnd = mulberry32(seed);
  const chs = channel === 'both' ? [0, 1] : [channel];
  for (let k = 0; LEAD + k * per < seconds - 0.4; k++) {
    const beat = Math.round((LEAD + k * per) * SR);
    const hat = Math.round((LEAD + (k + 0.5) * per) * SR);
    const hatNoise = Array.from({ length: Math.round(0.03 * SR) }, () => rnd() * 2 - 1);
    for (const ch of chs) {
      const d = buf.getChannelData(ch);
      let phase = 0;
      for (let i = 0; i < 0.3 * SR; i++) {
        const t = i / SR;
        phase += (2 * Math.PI * (48 + 90 * Math.exp(-t / 0.03))) / SR;
        const tail = Math.min(1, (0.3 - t) / 0.02); // no step where the kick is cut off
        d[beat + i] += 0.75 * Math.exp(-t / 0.11) * tail * Math.sin(phase);
      }
      if (!bare) for (let i = 0; i < hatNoise.length; i++) d[hat + i] += 0.12 * hatNoise[i] * Math.exp(-i / (0.008 * SR));
    }
    if (bare) addBlip(buf, LEAD + k * per, 0.5, channel, 5);
    else addBlip(buf, LEAD + k * per, 0.2, channel);
  }
  addSine(buf, padHz, 0.08, channel);
  return buf;
}

const perA = 60 / 120;
const perB = 60 / 126;
const T0 = 8; // transition start = A's beat 16
const BEATS = 16;
const T1 = T0 + BEATS * perA; // 16 s: A is gone, B is solo
const SWAP = T0 + 8 * perA; // 12 s: bass swap on beat 8 of the transition
const R = perB / perA; // B's rate while matched

function plan({ trimDb = -3 } = {}) {
  const A = mkPlay(0, { startAt: 0, offset: LEAD, trimDb, events: [ev('gain', 0, 1), ev('low', 0, 0)] });
  const aEvents = [
    ev('low', SWAP - 0.03, 0),
    ev('low', SWAP + 0.03, -28, 'lin'),
    ev('gain', SWAP, 1),
    ev('gain', T1, 0, 'lin'),
  ];
  const B = mkPlay(1, {
    startAt: T0,
    offset: LEAD + 4 * perB, // B's beat 4 (a downbeat) lands on A's beat 16
    trimDb,
    rate: [
      { t: T0, v: R },
      { t: T1, v: R },
      { t: T1 + 8, v: 1.0, ramp: true }, // glide back to its own tempo
    ],
    events: [
      ev('gain', T0, 0),
      ev('gain', SWAP, 1, 'lin'),
      ev('low', T0, -28),
      ev('low', SWAP - 0.03, -28),
      ev('low', SWAP + 0.03, 0, 'lin'),
    ],
    soloFrom: T1,
  });
  return { A, B, aEvents, aEndAt: T1 };
}

export default async function bassSwap() {
  const { results, check } = suite();
  const lat = await measureLatency();
  const SECONDS = 27;

  // --- alignment: A only in the left channel, B only in the right ----------------------------
  {
    const p = plan();
    const ctxBufs = {};
    const out = await renderSet({
      seconds: SECONDS,
      build: (engine, ctx) => {
        ctxBufs.a = kickTrack(ctx, 120, 20, 0, 11, 220, true);
        ctxBufs.b = kickTrack(ctx, 126, 26, 1, 23, 330, true);
        engine.addPlay(p.A, ctxBufs.a);
      },
      hooks: [
        [4, (engine) => {
          engine.extendPlay(0, { events: p.aEvents, endAt: p.aEndAt });
          engine.addPlay(p.B, ctxBufs.b);
        }],
      ],
    });
    const a = findClicks(highlight(out.L), { threshold: 0.002, gap: 0.01 });
    const b = findClicks(highlight(out.R), { threshold: 0.002, gap: 0.01 });
    let worst = 0;
    let pairs = 0;
    const offsets = [];
    for (let k = 0; k < BEATS; k++) {
      const t = T0 + k * perA + lat;
      const ca = a.find((c) => Math.abs(c.t - t) < 0.006);
      const cb = b.find((c) => Math.abs(c.t - t) < 0.006);
      if (!ca || !cb) continue;
      pairs++;
      offsets.push(((cb.t - ca.t) * 1000).toFixed(2));
      worst = Math.max(worst, Math.abs(ca.t - cb.t));
    }
    check('bass swap: overlap beats of both decks are measurable', pairs >= 14, `${pairs}/16 beats found on both decks`);
    check('bass swap: overlap beats coincide within 2 ms', pairs >= 14 && worst <= 0.002, `worst ${ms(worst)}; B−A per beat (ms): ${offsets.join(' ')}`);

    // After the glide B runs at its own tempo, still where timeline.js puts it.
    const expected = [];
    for (let k = 0; k < 60; k++) {
      const t = timeAtPosition(p.B, LEAD + k * perB);
      if (t > T1 + 0.2 && t < SECONDS - 0.5) expected.push(t + lat);
    }
    let worstB = 0;
    let got = 0;
    for (const t of expected) {
      const c = b.find((x) => Math.abs(x.t - t) < 0.006);
      if (!c) continue;
      got++;
      worstB = Math.max(worstB, Math.abs(c.t - t));
    }
    check('bass swap: through the glide back to 1.0 every B beat is within 1.5 ms of the plan', got === expected.length && worstB <= 0.0015, `${got}/${expected.length} beats, worst ${ms(worstB)}`);
    const last = b.filter((c) => c.t > T1 + 8.5);
    const spacing = last.length > 2 ? (last[last.length - 1].t - last[0].t) / (last.length - 1) : NaN;
    check('bass swap: B ends at its own tempo (126 BPM)', Math.abs(60 / spacing - 126) < 0.05, `${fmt(60 / spacing, 3)} BPM`);

    // The swap itself: bass moves from A to B around beat 8.
    const bassBefore = { a: rms(lowpass(out.L), SWAP - 1.9, SWAP - 0.1), b: rms(lowpass(out.R), SWAP - 1.9, SWAP - 0.1) };
    const bassAfter = { a: rms(lowpass(out.L), SWAP + 0.1, SWAP + 1.9), b: rms(lowpass(out.R), SWAP + 0.1, SWAP + 1.9) };
    check('bass swap: the low end changes hands on the swap beat', bassBefore.a > bassBefore.b * 4 && bassAfter.b > bassAfter.a * 4, `low-band rms before A ${fmt(bassBefore.a, 4)} / B ${fmt(bassBefore.b, 4)}; after A ${fmt(bassAfter.a, 4)} / B ${fmt(bassAfter.b, 4)}`);
    check('bass swap: A is silent after its endAt, B carries on', peak(out.L, T1 + lat + 0.3, SECONDS) < 1e-5 && rms(out.R, T1 + 1, T1 + 5) > 0.03, `A peak after ${fmt(peak(out.L, T1 + lat + 0.3, SECONDS), 6)}, B rms ${fmt(rms(out.R, T1 + 1, T1 + 5), 3)}`);
  }

  // --- the real mix: both tracks centred ------------------------------------------------------
  {
    const p = plan();
    const bufs = {};
    const out = await renderSet({
      seconds: SECONDS,
      build: (engine, ctx) => {
        bufs.a = kickTrack(ctx, 120, 20, 'both', 11, 220);
        bufs.b = kickTrack(ctx, 126, 26, 'both', 23, 330);
        engine.addPlay(p.A, bufs.a);
      },
      hooks: [
        [4, (engine) => {
          engine.extendPlay(0, { events: p.aEvents, endAt: p.aEndAt });
          engine.addPlay(p.B, bufs.b);
          engine.addFx([{ kind: 'riser', t: SWAP - 2, dur: 2, gain: 0.35 }, { kind: 'impact', t: SWAP, gain: 0.5 }], []);
        }],
      ],
    });
    const pk = Math.max(peak(out.L), peak(out.R));
    check('bass swap (full mix + riser + impact): output never exceeds 1.0', pk <= 1.0, `peak ${fmt(pk, 3)}`);
    const solo = rms(out.L, 2, 6);
    const overlap = rms(out.L, T0 + 4.5, T0 + 7.5);
    check('bass swap: summed level during the overlap stays sane (within 3 dB of solo)', overlap < solo * 1.41 && overlap > solo * 0.7, `solo rms ${fmt(solo, 3)}, overlap rms ${fmt(overlap, 3)}`);
    // Starts and stops: A's start, B's entry, A's exit. Compare with the largest step the programme itself
    // makes (its kick blips) — a click would stick out above that.
    const programme = maxStep(out.L, 1, 7);
    const edges = [0, T0, T1].map((t) => maxStep(out.L, t + lat - 0.008, t + lat + 0.008));
    check('bass swap: no discontinuity at A start / B start / A stop beyond the music itself', edges.every((e) => e <= programme * 1.05), `largest step at the three edges ${edges.map((e) => fmt(e, 4)).join(', ')} vs ${fmt(programme, 4)} in the programme`);
  }

  // --- stress: both decks at full level on the same beats ------------------------------------
  {
    const bufs = {};
    const out = await renderSet({
      seconds: 9,
      build: (engine, ctx) => {
        bufs.a = kickTrack(ctx, 120, 12, 'both', 11, 220);
        bufs.b = kickTrack(ctx, 120, 12, 'both', 11, 220);
        engine.addPlay(mkPlay(0, { startAt: 0, offset: LEAD, trimDb: 3 }), bufs.a);
        engine.addPlay(mkPlay(1, { startAt: 2, offset: LEAD, trimDb: 3 }), bufs.b);
      },
    });
    const single = peak(out.L, 0.5, 1.9);
    const both = peak(out.L, 2.5, 8.5);
    check('limiter: two identical hot tracks on top of each other stay under 1.0', both <= 1.0 && single > 0.5, `one deck peaks at ${fmt(single, 3)}, two coincident decks at ${fmt(both, 3)} (unlimited: ${fmt(single * 2, 3)})`);
  }

  // --- hard cut at full level between two sustained tones: the worst case for clicks ---------
  {
    const CUT = 2.00013; // not on a sample, not on a zero crossing
    const out = await renderSet({
      seconds: 4,
      build: (engine, ctx) => {
        const a = addSine(emptyBuffer(ctx, 6), 330, 0.5);
        const b = addSine(emptyBuffer(ctx, 6), 440, 0.5);
        engine.addPlay(mkPlay(0, { startAt: 0.20007, offset: 0.3111, endAt: CUT }), a);
        engine.addPlay(mkPlay(1, { startAt: CUT, offset: 1.2345 }), b);
        engine.extendPlay(1, { endAt: 3.3003 });
      },
    });
    const natural = 0.5 * 0.85 * 2 * Math.PI * (440 / SR); // steepest step of the louder tone
    const steps = [0.20007, CUT, 3.3003].map((t) => maxStep(out.L, t + lat - 0.01, t + lat + 0.01));
    check('hard cut at full level: start, cut and stop are click-free', steps.every((s) => s < natural * 2.5), `largest sample step ${steps.map((s) => fmt(s, 4)).join(', ')} (a sine alone: ${fmt(natural, 4)}; an unfaded cut: up to ${fmt(0.5 * 0.85 * 2, 2)})`);
    const dip = Math.min(...Array.from({ length: 40 }, (_, i) => rms(out.L, CUT + lat - 0.02 + i * 0.001, CUT + lat - 0.018 + i * 0.001)));
    check('hard cut: the two tracks cross over without a hole', dip > 0.15, `lowest 2 ms rms across the cut ${fmt(dip, 3)} (steady ${fmt(rms(out.L, 1, 1.5), 3)})`);
    check('hard cut: silence before the first start and after the last stop', peak(out.L, 0, 0.19) < 1e-5 && peak(out.L, 3.4, 4) < 1e-5, `${peak(out.L, 0, 0.19).toExponential(1)}, ${peak(out.L, 3.4, 4).toExponential(1)}`);
  }

  return results;
}

/** One-pole low-pass at ~150 Hz (offline analysis only): isolates the kick's body. */
function lowpass(data) {
  const out = new Float32Array(data.length);
  const a = 1 - Math.exp((-2 * Math.PI * 150) / SR);
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y += a * (data[i] - y);
    out[i] = y;
  }
  return out;
}

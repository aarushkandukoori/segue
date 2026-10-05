// 1. Timing: clicks come out where timeline.js says they should.
import { timeAtPosition, evalParam } from '../../../js/dj/timeline.js';
import { LIMITER } from '../../../js/dj/engine.js';
import { suite, renderSet, mkPlay, ev, clickBuffer, sineBuffer, addBlip, findClicks, matchClicks, measureLatency, peak, ms } from './lib.js';

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

export default async function timing() {
  const { results, check } = suite();
  const lat = await measureLatency();
  check(
    'limiter latency is a constant close to its 6 ms look-ahead',
    Math.abs(lat - LIMITER.lookahead) < 0.0005,
    `measured ${ms(lat)} (look-ahead ${ms(LIMITER.lookahead)}; the rest is filter group delay)`,
  );

  // --- fractional start time + offset, constant rate ---------------------------------------
  {
    const positions = range(12, (i) => 0.1 + 0.5 * i);
    const play = mkPlay(0, { startAt: 0.31337, offset: 1.2345 });
    const { L } = await renderSet({
      seconds: 5.5,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 6.2, positions)),
    });
    const expected = positions.filter((p) => p >= play.offset).map((p) => timeAtPosition(play, p) + lat).filter((t) => t < 5.4);
    const found = findClicks(L, { to: 5.4 });
    const m = matchClicks(found, expected);
    check('fractional start + offset: every click present, nothing extra', m.matched === expected.length && found.length === expected.length, `${found.length} found / ${expected.length} expected`);
    check('fractional start + offset: clicks within 1 ms of timeAtPosition', m.matched === expected.length && m.worst <= 0.001, `worst error ${ms(m.worst)}`);
    check('…and in fact within 2 samples', m.worst <= 2 / 48000, `worst error ${(m.worst * 48000).toFixed(2)} samples`);
  }

  // --- a click exactly on the cue point survives the declick at full height -----------------
  {
    const play = mkPlay(0, { startAt: 0.5, offset: 1.0 });
    const { L } = await renderSet({
      seconds: 2,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 3, [1.0, 1.5])),
    });
    const found = findClicks(L);
    const ok = found.length === 2 && Math.abs(found[0].t - (0.5 + lat)) < 0.0002 && Math.abs(found[0].amp / found[1].amp - 1) < 0.02;
    check('a transient sitting on the cue point keeps its full attack (pre-roll fade)', ok, found.map((c) => `${c.t.toFixed(5)}s amp ${c.amp.toFixed(3)}`).join(', '));
  }

  // --- …and that pre-roll plays through the strip as it is AT startAt, not at its defaults ------
  // A plan written exactly as the SPEC says (first 'set's on startAt) must not leak the few ms the
  // engine starts early: fader 0 → silence, fader 0.5 → half of what an open fader lets through.
  {
    const loud = (ctx) => sineBuffer(ctx, 3, 1000, 0.5);
    const run = async (events) => {
      const r = await renderSet({
        seconds: 2,
        build: (engine, ctx) => engine.addPlay({ ...mkPlay(0, { startAt: 1, offset: 0.5, events }), via: 'bassSwap' }, loud(ctx)),
      });
      // Output time = set time + limiter latency; the pre-roll is the 4 ms before startAt.
      return { pre: peak(r.L, 1 + lat - 0.006, 1 + lat - 0.0003), later: peak(r.L, 1.6, 1.7), model: r.engine.getPlay(0) };
    };
    const open = await run([]);
    const shut = await run([ev('gain', 1, 0), ev('gain', 1.5, 1, 'lin')]);
    const half = await run([ev('gain', 1, 0.5)]);
    const muted = await run([ev('src', 1, 0), ev('src', 1.2, 1)]);
    check('pre-roll exists when the fader is open at startAt (the declick ramps INTO the cue)', open.pre > 0.05 && open.pre < open.later, `peak in the 4 ms before startAt ${open.pre.toFixed(4)}, programme ${open.later.toFixed(4)}`);
    check("pre-roll is silent when the plan sets 'gain' 0 on startAt", shut.pre < 1e-5 && Math.abs(shut.later / open.later - 1) < 0.01, `peak before startAt ${shut.pre.toExponential(1)}, after the fade-in ${shut.later.toFixed(4)}`);
    check("pre-roll follows a 'gain' 0.5 set on startAt", Math.abs(half.pre / open.pre - 0.5) < 0.02, `ratio to the open fader ${(half.pre / open.pre).toFixed(3)}`);
    check("pre-roll is silent when the plan sets 'src' 0 on startAt", muted.pre < 1e-5 && Math.abs(muted.later / open.later - 1) < 0.01, `peak before startAt ${muted.pre.toExponential(1)}`);
    const g = (t) => evalParam(shut.model.events, 'gain', t, 1);
    check('…and the model from startAt on is the plan, untouched', Math.abs(g(1) - 0) < 1e-9 && Math.abs(g(1.25) - 0.5) < 1e-9 && Math.abs(g(1.6) - 1) < 1e-9, `gain at 1.0 / 1.25 / 1.6 s: ${g(1)} ${g(1.25)} ${g(1.6)}`);
    const m = shut.model;
    check('getPlay() passes the play\'s other fields through (trackId, deck, soloFrom, planner extras)', m.via === 'bassSwap' && m.trackId === 'test:0' && m.deck === 0 && m.soloFrom === 1 && m.startAt === 1 && m.offset === 0.5 && m.endAt === null && Array.isArray(m.rate) && Array.isArray(m.events), JSON.stringify({ ...m, events: m.events.length, rate: m.rate.length }));
  }

  // --- rate 1.05 held, then glide to 1.0 --------------------------------------------------
  {
    const s = 0.2071;
    const positions = range(40, (i) => 0.05 + 0.25 * i);
    const play = mkPlay(0, {
      startAt: s,
      offset: 0.4,
      rate: [
        { t: s, v: 1.05 },
        { t: s + 2, v: 1.05 },
        { t: s + 5, v: 1.0, ramp: true },
      ],
    });
    const { L } = await renderSet({
      seconds: 8,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 10.2, positions)),
    });
    const expected = positions.filter((p) => p >= play.offset).map((p) => timeAtPosition(play, p) + lat).filter((t) => t < 7.9);
    const found = findClicks(L, { to: 7.9 });
    const m = matchClicks(found, expected);
    check('rate ramp 1.05 → 1.0: every click present', m.matched === expected.length && found.length === expected.length, `${found.length} found / ${expected.length} expected`);
    check('rate ramp 1.05 → 1.0: every click within 1.5 ms of prediction', m.matched === expected.length && m.worst <= 0.0015, `worst error ${ms(m.worst)} over ${expected.length} clicks`);
  }

  // --- a step change of rate mid-play -----------------------------------------------------
  {
    const positions = range(30, (i) => 0.05 + 0.2 * i);
    const play = mkPlay(0, { startAt: 0.1, offset: 0, rate: [{ t: 0.1, v: 0.94 }, { t: 2.3333, v: 1.08 }] });
    const { L } = await renderSet({
      seconds: 5,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 6.2, positions)),
    });
    const expected = positions.map((p) => timeAtPosition(play, p) + lat).filter((t) => t < 4.9);
    const m = matchClicks(findClicks(L), expected);
    check('rate step 0.94 → 1.08: clicks within 1 ms', m.matched === expected.length && m.worst <= 0.001, `worst error ${ms(m.worst)}`);
  }

  // --- two decks, beat-matched by hand, must stay locked for 32 beats ----------------------
  {
    // A: 120 BPM in the left channel. B: 126 BPM in the right channel, slowed to 120.
    const perA = 0.5;
    const perB = 60 / 126;
    const posA = range(44, (i) => 0.1 + perA * i);
    const posB = range(44, (i) => 0.07 + perB * i);
    const A = mkPlay(0, { startAt: 0.2, offset: 0 });
    const r = perB / perA; // B's beat period becomes A's
    // Land B's beat 2 on A's beat 4: startAt = (time of A's beat 4) − (B audio between its cue and its beat 2) / rate
    const tA4 = timeAtPosition(A, posA[4]);
    const offB = 0.3;
    const B = mkPlay(1, { startAt: tA4 - (posB[2] - offB) / r, offset: offB, rate: [{ t: 0, v: r }] });
    B.rate[0].t = B.startAt;
    const { L, R } = await renderSet({
      seconds: 19.5,
      build: (engine, ctx) => {
        engine.addPlay(A, clickBuffer(ctx, 22, posA, { channel: 0 }));
        engine.addPlay(B, clickBuffer(ctx, 22, posB, { channel: 1 }));
      },
    });
    const a = findClicks(L);
    const b = findClicks(R);
    let worst = 0;
    let pairs = 0;
    for (let n = 0; n < 32; n++) {
      const t = tA4 + perA * n + lat;
      const ca = a.find((c) => Math.abs(c.t - t) < 0.01);
      const cb = b.find((c) => Math.abs(c.t - t) < 0.01);
      if (!ca || !cb) continue;
      pairs++;
      worst = Math.max(worst, Math.abs(ca.t - cb.t));
    }
    check('beat-matched decks: all 32 overlapping beats found on both decks', pairs === 32, `${pairs}/32`);
    check('beat-matched decks: stay aligned within 1 ms for 32 beats', pairs === 32 && worst <= 0.001, `worst A–B offset ${ms(worst)}`);
    const expB = posB.filter((p) => p >= offB).map((p) => timeAtPosition(B, p) + lat).filter((t) => t < 19.4);
    const mB = matchClicks(b, expB);
    check('beat-matched decks: slowed deck follows timeAtPosition', mB.matched === expB.length && mB.worst <= 0.001, `worst ${ms(mB.worst)} over ${expB.length} beats`);
  }

  // --- other sample rates: a 44.1 kHz context, and a 44.1 kHz buffer inside a 48 kHz context ---
  {
    const positions = range(8, (i) => 0.1 + 0.5 * i);
    const play = mkPlay(0, { startAt: 0.2222, offset: 0.4, rate: [{ t: 0.2222, v: 1.02 }] });
    const expected = (l) => positions.filter((p) => p >= play.offset).map((p) => timeAtPosition(play, p) + l).filter((t) => t < 3.4);
    const a = await renderSet({
      seconds: 3.5,
      sr: 44100,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 4.2, positions)),
    });
    const fa = findClicks(a.L, { sr: 44100, to: 3.4 });
    const ma = matchClicks(fa, expected(lat));
    check('44.1 kHz context: same timing (≤ 2 samples)', fa.length === expected(lat).length && ma.matched === fa.length && ma.worst <= 2 / 44100, `${fa.length} clicks, worst ${ms(ma.worst)}`);
    const b = await renderSet({
      seconds: 3.5,
      build: (engine, ctx) => {
        const buf = ctx.createBuffer(2, Math.round(4.2 * 44100), 44100);
        for (const p of positions) addBlip(buf, p, 0.5);
        engine.addPlay(play, buf);
      },
    });
    const fb = findClicks(b.L, { to: 3.4 });
    const mb = matchClicks(fb, expected(lat));
    check('44.1 kHz buffer in a 48 kHz context: positions are seconds, not samples', fb.length === expected(lat).length && mb.matched === fb.length && mb.worst <= 0.0001, `${fb.length} clicks, worst ${ms(mb.worst)}`);
  }

  return results;
}

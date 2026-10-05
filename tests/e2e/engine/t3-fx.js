// 3. One-shot FX: loop (beat repeat), reverse (spinback), riser, impact.
import {
  suite,
  renderSet,
  mkPlay,
  ev,
  emptyBuffer,
  addBlip,
  addSine,
  findClicks,
  matchClicks,
  rms,
  peak,
  maxStep,
  measureLatency,
  fmt,
  ms,
  SR,
} from './lib.js';

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const MUTED = [ev('src', 0, 0)]; // main source off: only the one-shot is heard through the strip

export default async function fx() {
  const { results, check } = suite();
  const lat = await measureLatency();

  // --- loop: the exact slice, the right number of times --------------------------------------
  const loopCase = async (rate) => {
    const { L } = await renderSet({
      seconds: 3,
      build: (engine, ctx) => {
        const buf = emptyBuffer(ctx, 4);
        addBlip(buf, 2.03, 0.5); // inside the slice [2.0, 2.125)
        addBlip(buf, 1.9, 0.5); // decoys just outside it
        addBlip(buf, 2.2, 0.5);
        engine.addPlay(mkPlay(0, { events: MUTED }), buf);
        engine.addFx([{ kind: 'loop', playId: 0, t: 1.0, dur: 1.0, offset: 2.0, len: 0.125, rate }], []);
      },
    });
    const period = 0.125 / rate;
    const n = Math.round(1.0 / period);
    const expected = range(n, (k) => 1.0 + 0.03 / rate + k * period + lat);
    const found = findClicks(L);
    return { found, expected, m: matchClicks(found, expected, 0.005) };
  };
  {
    const a = await loopCase(1);
    check('loop: slice [2.0, 2.125) repeats exactly 8 times in 1 s, nothing from outside the slice', a.found.length === 8 && a.m.matched === 8, `${a.found.length} clicks, ${a.m.matched}/8 on schedule`);
    check('loop: every repeat within 0.1 ms of its grid position', a.m.matched === 8 && a.m.worst < 0.0001, `worst ${ms(a.m.worst)}`);
    const b = await loopCase(2);
    check('loop: rate 2 halves the period (16 repeats, on the grid)', b.found.length === 16 && b.m.matched === 16 && b.m.worst < 0.0001, `${b.found.length} clicks, worst ${ms(b.m.worst)}`);
  }
  {
    // Slice of a 100 Hz sine from a positive peak to a negative peak: the wrap is a full-scale jump
    // unless the micro-fades do their job.
    const build = (engine, ctx) => {
      const buf = addSine(emptyBuffer(ctx, 4), 100, 0.4);
      engine.addPlay(mkPlay(0, { events: MUTED }), buf);
      engine.addFx([{ kind: 'loop', playId: 0, t: 1.0, dur: 1.0, offset: 2.0025, len: 0.125, rate: 1 }], []);
    };
    const { L } = await renderSet({ seconds: 2.5, build });
    const step = maxStep(L, 0.9, 2.2);
    const level = rms(L, 1.01, 1.99);
    check('loop: no click at the wrap, the start or the end (micro-fades)', step < 0.02 && level > 0.15, `largest sample step ${fmt(step, 4)} (an unfaded wrap would be ≈ 0.68); loop rms ${fmt(level, 3)}`);
    // "After" is measured once the strip's EQ / 20 Hz high-pass have rung out from the sudden stop.
    const before = peak(L, 0, 1.0 + lat - 0.0005);
    const after = peak(L, 2.3, 2.5);
    const ringing = peak(L, 2.0 + lat + 0.0005, 2.05);
    check('loop: silent before t and after t+dur', before < 1e-5 && after < 1e-5 && ringing < 0.1, `before ${before.toExponential(1)}, 0.3 s after ${after.toExponential(1)} (filter ring-out right after the stop peaks at ${fmt(ringing, 3)})`);
  }

  {
    // FX handed over before its play exists (call order is up to the conductor): it must wait for it.
    const { L, engine } = await renderSet({
      seconds: 2.5,
      build: (engine, ctx) => {
        const buf = emptyBuffer(ctx, 4);
        addBlip(buf, 2.03, 0.5);
        engine.addFx([{ kind: 'loop', playId: 0, t: 1.0, dur: 0.5, offset: 2.0, len: 0.125, rate: 1 }, { kind: 'loop', playId: 77, t: 1.0, dur: 0.5, offset: 2.0, len: 0.125, rate: 1 }], []);
        engine.addPlay(mkPlay(0, { events: MUTED }), buf);
      },
    });
    engine.tick();
    const found = findClicks(L);
    check('loop sent before its play was added still plays; one for a play that never comes is dropped', found.length === 4 && engine.debug().pending === 0, `${found.length} clicks, ${engine.debug().pending} FX still waiting after the render`);
  }

  // --- reverse: really backwards ---------------------------------------------------------------
  const reverseCase = async (rate0, rate1, dur) => {
    const { L } = await renderSet({
      seconds: 2.5,
      build: (engine, ctx) => {
        const buf = emptyBuffer(ctx, 4);
        addBlip(buf, 2.6, 0.6); // big, early in the slice [2.5, 3.0)
        addBlip(buf, 2.9, 0.25); // small, late
        addBlip(buf, 3.05, 0.5); // decoy after the slice
        engine.addPlay(mkPlay(0, { events: MUTED }), buf);
        engine.addFx([{ kind: 'reverse', playId: 0, t: 1.0, dur, offset: 3.0, len: 0.5, rate0, rate1 }], []);
      },
    });
    // Time after t at which `consumed` seconds of the reversed slice have been played, for a linear rate ramp.
    const when = (consumed) => {
      const k = (rate1 - rate0) / dur;
      if (Math.abs(k) < 1e-9) return consumed / rate0;
      return (-rate0 + Math.sqrt(rate0 * rate0 + 2 * k * consumed)) / k;
    };
    return { found: findClicks(L), small: 1.0 + when(0.1) + lat, big: 1.0 + when(0.4) + lat };
  };
  {
    const a = await reverseCase(1, 1, 0.6);
    const ok = a.found.length === 2 && a.found[0].amp < a.found[1].amp * 0.6;
    check('reverse: the late/small click now comes first, the early/big one second', ok, a.found.map((c) => `${fmt(c.t, 4)}s amp ${fmt(c.amp, 3)}`).join(', '));
    const err = a.found.length === 2 ? Math.max(Math.abs(a.found[0].t - a.small), Math.abs(a.found[1].t - a.big)) : Infinity;
    check('reverse: positions mirror the slice (rate 1)', err < 0.0005, `worst ${ms(err)}`);
    const b = await reverseCase(1.5, 0.5, 0.6);
    const errB = b.found.length === 2 ? Math.max(Math.abs(b.found[0].t - b.small), Math.abs(b.found[1].t - b.big)) : Infinity;
    check('reverse: rate ramp 1.5 → 0.5 slows it down as predicted', errB < 0.002, `worst ${ms(errB)} (clicks at ${b.found.map((c) => fmt(c.t, 4)).join(', ')}; predicted ${fmt(b.small, 4)}, ${fmt(b.big, 4)})`);
  }

  // --- riser ---------------------------------------------------------------------------------
  {
    const { L } = await renderSet({
      seconds: 4,
      build: (engine) => engine.addFx([{ kind: 'riser', t: 1.0, dur: 2.0, gain: 0.5 }], []),
    });
    const q = range(8, (i) => rms(L, 1.0 + lat + i * 0.25, 1.0 + lat + (i + 1) * 0.25));
    const rising = q.every((v, i) => i === 0 || v > q[i - 1]);
    check('riser: energy climbs through all 8 quarters', rising && q[7] > q[0] * 8, `rms per 250 ms: ${q.map((v) => fmt(v, 4)).join(' ')}`);
    check('riser: silent before t', peak(L, 0, 1.0 + lat - 0.0005) < 1e-5, `peak ${peak(L, 0, 1.0 + lat - 0.0005).toExponential(1)}`);
    const tail = peak(L, 3.0 + lat + 0.0005, 4);
    const lastMs = rms(L, 3.0 + lat - 0.02, 3.0 + lat - 0.004);
    check('riser: stops hard at t+dur', tail < 1e-5 && lastMs > 0.02, `rms just before the end ${fmt(lastMs, 4)}, peak after it ${tail.toExponential(1)}`);
    const pk = peak(L, 1, 3.1);
    check('riser: level is tasteful (peak < gain, never near clipping)', pk < 0.5 && pk > 0.05, `peak ${fmt(pk, 3)} for gain 0.5`);
    const lastHalfMs = peak(L, 3.0 + lat - 0.0005, 3.0 + lat);
    const justBefore = peak(L, 3.0 + lat - 0.008, 3.0 + lat - 0.004);
    check('riser: the stop is a 3 ms fade, not a truncation', lastHalfMs < justBefore * 0.3, `peak in the last 0.5 ms ${fmt(lastHalfMs, 4)} vs ${fmt(justBefore, 4)} a few ms earlier`);
  }

  // --- impact --------------------------------------------------------------------------------
  {
    const { L } = await renderSet({
      seconds: 4,
      build: (engine) => engine.addFx([{ kind: 'impact', t: 1.5, gain: 0.8 }], []),
    });
    const t = 1.5 + lat;
    let onset = -1;
    for (let i = 0; i < L.length; i++) {
      if (Math.abs(L[i]) > 0.02) {
        onset = i / SR;
        break;
      }
    }
    check('impact: silent before t', peak(L, 0, t - 0.0005) < 1e-5, `peak ${peak(L, 0, t - 0.0005).toExponential(1)}`);
    check('impact: lands on t (audible within 3 ms)', onset >= t && onset - t < 0.003, `onset ${ms(onset - t)} after t`);
    const pk = peak(L, 1.5, 3.5);
    check('impact: level is tasteful', pk > 0.25 && pk < 0.8, `peak ${fmt(pk, 3)} for gain 0.8`);
    const early = rms(L, t, t + 0.2);
    const late = rms(L, t + 1.0, t + 1.2);
    check('impact: decays and ends', late < early * 0.1 && peak(L, t + 1.6, 4) < 1e-5, `rms first 200 ms ${fmt(early, 3)}, after 1 s ${fmt(late, 4)}, peak after 1.6 s ${peak(L, t + 1.6, 4).toExponential(1)}`);
  }

  // --- one-shots are deterministic (seeded noise) ----------------------------------------------
  {
    const run = () =>
      renderSet({
        seconds: 2,
        build: (engine) => engine.addFx([{ kind: 'riser', t: 0.2, dur: 1, gain: 0.6 }, { kind: 'impact', t: 1.2, gain: 0.6 }], []),
      });
    const a = await run();
    const b = await run();
    let same = true;
    for (let i = 0; i < a.L.length && same; i += 5) same = a.L[i] === b.L[i] && a.R[i] === b.R[i];
    check('riser + impact renders are bit-identical run to run', same);
  }

  return results;
}

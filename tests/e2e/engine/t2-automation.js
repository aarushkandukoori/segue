// 2. Automation: what the strip renders matches evalParam() for every event kind, the EQ / filters
//    do what the plan says, the sends feed the shared delay and reverb, trimDb is applied.
import { evalParam, dbToGain, timeAtPosition } from '../../../js/dj/timeline.js';
import { createEngine, HEADROOM } from '../../../js/dj/engine.js';
import {
  suite,
  renderSet,
  mkPlay,
  ev,
  emptyBuffer,
  sineBuffer,
  clickBuffer,
  addSine,
  addBurst,
  findClicks,
  matchClicks,
  rms,
  peak,
  envelopeAt,
  biquadMag,
  measureLatency,
  db,
  fmt,
  SR,
} from './lib.js';

/** Compare a rendered sine envelope with evalParam; returns the worst absolute error in gain units. */
function envelopeError(data, events, p, def, ref, lat, { from, to, step = 0.01, skip = [], settle = 0.004 }) {
  let worst = 0;
  let at = 0;
  let n = 0;
  for (let t = from; t <= to; t += step) {
    // Around a step the measuring window straddles two levels, and (for 'src', which sits before the
    // EQ) the 20 Hz high-pass needs a few tens of ms to ring out after an abrupt mute / unmute.
    if (skip.some((s) => t > s - 0.004 && t < s + settle)) continue;
    const got = envelopeAt(data, t + lat) / ref;
    const want = evalParam(events, p, t, def);
    const err = Math.abs(got - want);
    n++;
    if (err > worst) {
      worst = err;
      at = t;
    }
  }
  return { worst, at, n };
}

export default async function automation() {
  const { results, check } = suite();
  const lat = await measureLatency();
  const AMP = 0.4;

  // --- absolute level: fader maths is not disturbed by the limiter's makeup gain ------------
  let ref;
  {
    const { L } = await renderSet({
      seconds: 1,
      build: (engine, ctx) => engine.addPlay(mkPlay(0), sineBuffer(ctx, 1.2, 1000, AMP)),
    });
    ref = envelopeAt(L, 0.5, 0.01);
    check(
      'unity strip: output = input × headroom (limiter makeup gain compensated)',
      Math.abs(ref / (AMP * HEADROOM) - 1) < 0.01,
      `out ${fmt(ref)} vs ${fmt(AMP * HEADROOM)} (${fmt(db(ref / (AMP * HEADROOM)), 3)} dB)`,
    );
  }

  // --- 'gain': set / lin / exp / tgt --------------------------------------------------------
  {
    const events = [
      ev('gain', 0, 1),
      ev('gain', 0.5, 1),
      ev('gain', 1.0, 0.25, 'lin'),
      ev('gain', 2.0, 0.8, 'exp'),
      ev('gain', 2.5, 0.8),
      ev('gain', 2.5, 0.1, 'tgt', 0.15),
      ev('gain', 3.5, 0.6),
      ev('gain', 4.2, 0.05, 'lin'),
    ];
    const { L } = await renderSet({
      seconds: 4.6,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 5, 1000, AMP)),
    });
    const e = envelopeError(L, events, 'gain', 1, ref, lat, { from: 0.05, to: 4.4, skip: [3.5] });
    check("'gain' set/lin/exp/tgt: rendered envelope = evalParam", e.worst < 0.01, `worst |Δgain| ${fmt(e.worst, 5)} at t=${fmt(e.at, 2)} over ${e.n} points`);
  }

  // --- 'src': same, on the source gain ------------------------------------------------------
  {
    const events = [
      ev('src', 0, 0.3),
      ev('src', 0.6, 1, 'lin'),
      ev('src', 1.0, 0),
      ev('src', 1.5, 1),
      ev('src', 1.5, 0.2, 'tgt', 0.1),
      ev('src', 2.2, 0.2),
      ev('src', 3.0, 0.9, 'exp'),
    ];
    const { L } = await renderSet({
      seconds: 3.6,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 4, 1000, AMP)),
    });
    const e = envelopeError(L, events, 'src', 1, ref, lat, { from: 0.05, to: 3.4, skip: [1.0, 1.5], settle: 0.1 });
    check("'src' set/lin/exp/tgt: rendered envelope = evalParam", e.worst < 0.01, `worst |Δgain| ${fmt(e.worst, 5)} at t=${fmt(e.at, 2)}`);
    check("'src' = 0 mutes the main source completely", peak(L, 1.25, 1.49) < 1e-5, `peak 0.25 s after the mute ${peak(L, 1.25, 1.49).toExponential(2)} (before that the EQ filters ring out)`);
  }

  // --- EQ kills: left channel carries the band that must die, right the band that must stay --
  const eqCase = async (p, fKill, fKeep) => {
    const events = [ev(p, 0, 0), ev(p, 1.5, -28)];
    const { L, R } = await renderSet({
      seconds: 3,
      build: (engine, ctx) => {
        const buf = emptyBuffer(ctx, 3.2);
        addSine(buf, fKill, 0.3, 0);
        addSine(buf, fKeep, 0.3, 1);
        engine.addPlay(mkPlay(0, { events }), buf);
      },
    });
    return {
      kill: db(rms(L, 2.0, 2.8) / rms(L, 0.5, 1.3)),
      keep: db(rms(R, 2.0, 2.8) / rms(R, 0.5, 1.3)),
    };
  };
  {
    const low = await eqCase('low', 60, 1000);
    check("'low' kill (−28 dB): 60 Hz down ≥ 20 dB", low.kill <= -20, `${fmt(low.kill, 1)} dB`);
    check("'low' kill: 1 kHz within 2 dB", Math.abs(low.keep) <= 2, `${fmt(low.keep, 2)} dB`);
    const high = await eqCase('high', 8000, 200);
    check("'high' kill (−28 dB): 8 kHz down ≥ 20 dB", high.kill <= -20, `${fmt(high.kill, 1)} dB`);
    check("'high' kill: 200 Hz within 1 dB", Math.abs(high.keep) <= 1, `${fmt(high.keep, 2)} dB`);
    const mid = await eqCase('mid', 1000, 60);
    check("'mid' kill (−28 dB): 1 kHz down ≥ 20 dB", mid.kill <= -20, `${fmt(mid.kill, 1)} dB`);
    check("'mid' kill: 60 Hz within 2 dB", Math.abs(mid.keep) <= 2, `${fmt(mid.keep, 2)} dB`);
  }

  // --- filter sweeps: the cutoff is where evalParam says it is, all the way through ---------
  const sweepCase = async (p, type, tone, fromHz, toHz, def) => {
    const events = [ev(p, 0, fromHz), ev(p, 1, fromHz), ev(p, 3, toHz, 'exp')];
    const { L } = await renderSet({
      seconds: 3.6,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 4, tone, AMP)),
    });
    const base = envelopeAt(L, 0.5 + lat, 0.01) / biquadMag(type, fromHz, 0, tone);
    let worst = 0;
    let at = 0;
    let deepest = 0;
    for (let t = 1.05; t <= 3.4; t += 0.05) {
      const fc = evalParam(events, p, t, def);
      const want = db(biquadMag(type, fc, 0, tone));
      const got = db(envelopeAt(L, t + lat, 0.01) / base);
      deepest = Math.min(deepest, got);
      if (Math.abs(got - want) > worst) {
        worst = Math.abs(got - want);
        at = t;
      }
    }
    return { worst, at, deepest };
  };
  {
    const hp = await sweepCase('hpf', 'highpass', 200, 20, 3200, 20);
    check("'hpf' exp sweep 20 → 3200 Hz: 200 Hz tone tracks the predicted response within 1 dB", hp.worst <= 1, `worst ${fmt(hp.worst, 2)} dB at t=${fmt(hp.at, 2)}, deepest ${fmt(hp.deepest, 1)} dB`);
    const lp = await sweepCase('lpf', 'lowpass', 4000, 20000, 250, 20000);
    check("'lpf' exp sweep 20 k → 250 Hz: 4 kHz tone tracks the predicted response within 1 dB", lp.worst <= 1, `worst ${fmt(lp.worst, 2)} dB at t=${fmt(lp.at, 2)}, deepest ${fmt(lp.deepest, 1)} dB`);
  }

  // --- delay send: echoes every delayTime, each one feedback× the last ----------------------
  const delayCase = async (delayTime, feedback) => {
    const { L } = await renderSet({
      seconds: 2.4,
      build: (engine, ctx) => {
        const buf = addBurst(emptyBuffer(ctx, 3), 0.5, 1000, 0.5);
        engine.addFx([], [ev('delayTime', 0, delayTime), ev('delayFeedback', 0, feedback), ev('fxReturn', 0, 1)]);
        engine.addPlay(mkPlay(0, { events: [ev('delaySend', 0, 1)] }), buf);
      },
    });
    const echoes = [];
    for (let k = 0; k < 5; k++) {
      const c = 0.5 + k * delayTime + lat;
      const a = Math.round((c - 0.03) * SR);
      const b = Math.round((c + 0.03) * SR);
      let e = 0;
      let et = 0;
      for (let i = a; i < b; i++) {
        e += L[i] * L[i];
        et += L[i] * L[i] * i;
      }
      echoes.push({ t: et / e / SR - lat, level: Math.sqrt(e) });
    }
    return echoes;
  };
  {
    const e = await delayCase(0.25, 0.5);
    const spacing = e.slice(1).map((x, i) => x.t - e[i].t);
    const worst = Math.max(...spacing.map((s) => Math.abs(s - 0.25)));
    check('delay: echoes are spaced by delayTime (0.25 s)', worst < 0.001, `spacings ${spacing.map((s) => fmt(s, 4)).join(', ')}`);
    check('delay: first echo is the clean signal at fxReturn level', Math.abs(e[1].level / e[0].level - 1) < 0.05, `echo1/dry ${fmt(e[1].level / e[0].level, 3)}`);
    const ratios = [e[2].level / e[1].level, e[3].level / e[2].level, e[4].level / e[3].level];
    check('delay: each repeat decays by delayFeedback (0.5)', ratios.every((r) => r > 0.42 && r < 0.52), `ratios ${ratios.map((r) => fmt(r, 3)).join(', ')}`);
    const e2 = await delayCase(0.18, 0.7);
    const sp2 = e2.slice(1).map((x, i) => x.t - e2[i].t);
    const r2 = [e2[2].level / e2[1].level, e2[3].level / e2[2].level];
    check('delay: delayTime / delayFeedback events move the bus (0.18 s, 0.7)', Math.max(...sp2.map((s) => Math.abs(s - 0.18))) < 0.001 && r2.every((r) => r > 0.6 && r < 0.72), `spacings ${sp2.map((s) => fmt(s, 4)).join(', ')}; ratios ${r2.map((r) => fmt(r, 3)).join(', ')}`);
  }
  {
    // fxReturn at 0 silences the delay return.
    const { L } = await renderSet({
      seconds: 1.6,
      build: (engine, ctx) => {
        engine.addFx([], [ev('delayTime', 0, 0.25), ev('fxReturn', 0, 0)]);
        engine.addPlay(mkPlay(0, { events: [ev('delaySend', 0, 1)] }), addBurst(emptyBuffer(ctx, 2), 0.5, 1000, 0.5));
      },
    });
    check("'fxReturn' = 0 mutes the echoes", peak(L, 0.7, 1.6) < 1e-5, `peak after the dry burst ${peak(L, 0.7, 1.6).toExponential(2)}`);
  }

  {
    // Without ConstantSourceNode (pre-2021 Safari) the bus falls back to a plain feedback loop.
    const ctx = new OfflineAudioContext(2, 48000 * 2, 48000);
    ctx.createConstantSource = undefined;
    const engine = createEngine({ context: ctx });
    await engine.start({ at: 0.5 });
    engine.addFx([], [ev('delayTime', 0, 0.25), ev('delayFeedback', 0, 0.5)]);
    engine.addPlay(mkPlay(0, { events: [ev('delaySend', 0, 1)] }), addBurst(emptyBuffer(ctx, 2), 0.3, 1000, 0.5));
    const out = (await ctx.startRendering()).getChannelData(0);
    const e1 = rms(out, 0.5 + 0.3 + 0.25 - 0.02, 0.5 + 0.3 + 0.25 + 0.03);
    const e2 = rms(out, 0.5 + 0.3 + 0.5 - 0.02, 0.5 + 0.3 + 0.5 + 0.03);
    check('delay bus without ConstantSourceNode: fallback loop still echoes and decays', e1 > 0.02 && e2 > e1 * 0.4 && e2 < e1 * 0.6, `echo 1 rms ${fmt(e1, 4)}, echo 2 rms ${fmt(e2, 4)}`);
  }

  // --- reverb send: the tail outlives the fader ---------------------------------------------
  {
    const run = async (send) => {
      const events = [ev('reverbSend', 0, send), ev('gain', 0, 1), ev('gain', 1.0, 1), ev('gain', 1.02, 0, 'lin')];
      return renderSet({
        seconds: 4.4,
        build: (engine, ctx) => {
          const buf = emptyBuffer(ctx, 5);
          addSine(buf, 440, 0.2);
          addSine(buf, 1320, 0.15);
          engine.addPlay(mkPlay(0, { events }), buf);
        },
      });
    };
    const wet = await run(0.6);
    const dry = await run(0);
    const early = rms(wet.L, 1.1, 1.4);
    const lateTail = rms(wet.L, 3.2, 3.6);
    check('reverb: tail rings on after the fader is cut', early > 2e-3, `rms 0.1–0.4 s after the cut ${early.toExponential(2)}`);
    check('reverb: tail decays (≥ 20 dB down two seconds later) and ends', lateTail < early * 0.1 && peak(wet.L, 4.0, 4.4) < 1e-4, `${fmt(db(lateTail / early), 1)} dB; peak after 3 s ${peak(wet.L, 4.0, 4.4).toExponential(2)}`);
    check('reverb: without the send the cut is silent', peak(dry.L, 1.1, 4.4) < 1e-5, `peak ${peak(dry.L, 1.1, 4.4).toExponential(2)}`);
    const decor = (() => {
      let lr = 0;
      let ll = 0;
      let rr = 0;
      for (let i = Math.round(1.1 * SR); i < Math.round(2.5 * SR); i++) {
        lr += wet.L[i] * wet.R[i];
        ll += wet.L[i] * wet.L[i];
        rr += wet.R[i] * wet.R[i];
      }
      return lr / Math.sqrt(ll * rr);
    })();
    check('reverb: tail is stereo (L/R decorrelated)', Math.abs(decor) < 0.5, `L/R correlation ${fmt(decor, 3)}`);
    const again = await run(0.6);
    let same = true;
    for (let i = 0; i < wet.L.length && same; i += 7) same = wet.L[i] === again.L[i];
    check('reverb: impulse response is deterministic (two renders are bit-identical)', same);
  }

  // --- trim -----------------------------------------------------------------------------------
  {
    const level = async (trimDb) => {
      const { L } = await renderSet({
        seconds: 0.8,
        build: (engine, ctx) => engine.addPlay(mkPlay(0, { trimDb }), sineBuffer(ctx, 1, 1000, 0.2)),
      });
      return envelopeAt(L, 0.5, 0.01);
    };
    const l0 = await level(0);
    const lm6 = await level(-6);
    const lp3 = await level(3);
    check('trimDb −6 dB', Math.abs(lm6 / l0 - dbToGain(-6)) < 0.005, `ratio ${fmt(lm6 / l0)} (want ${fmt(dbToGain(-6))})`);
    check('trimDb +3 dB', Math.abs(lp3 / l0 - dbToGain(3)) < 0.01, `ratio ${fmt(lp3 / l0)} (want ${fmt(dbToGain(3))})`);
  }

  // --- junk must not throw or poison the strip ------------------------------------------------
  {
    const events = [
      ev('gain', 0, 0.5),
      ev('gain', NaN, 1),
      ev('nonsense', 0.1, 1),
      { p: 'gain', t: 0.2, v: 1, k: 'warp' },
      ev('gain', 0.4, 0, 'exp'), // exponential ramp to 0: must degrade to a linear ramp, not throw
      ev('lpf', 0.1, 1e9),
      ev('delayFeedback', 0, 5), // bus param inside strip events: ignored
      null,
    ];
    let threw = '';
    let out = null;
    try {
      out = await renderSet({
        seconds: 1,
        build: (engine, ctx) => {
          engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 1.2, 1000, AMP));
          engine.addFx([{ kind: 'wat' }, null, { kind: 'loop', playId: 99, t: 0, dur: 1, offset: 0, len: 1, rate: 1 }], [ev('delayFeedback', 0, 5)]);
          engine.extendPlay(42, { events: [ev('gain', 0, 1)] });
        },
      });
    } catch (err) {
      threw = String(err);
    }
    const mid = out ? envelopeAt(out.L, 0.2 + lat) / ref : NaN;
    check('malformed events / fx are ignored without throwing', !threw && Math.abs(mid - 0.25) < 0.01 && peak(out.L, 0.45, 1) < 1e-4, threw || `gain mid-ramp ${fmt(mid, 3)} (want 0.250)`);
  }

  // --- mono buffers --------------------------------------------------------------------------------
  {
    const { L, R } = await renderSet({
      seconds: 1,
      build: (engine, ctx) => {
        const buf = ctx.createBuffer(1, 48000, 48000);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = AMP * Math.sin((2 * Math.PI * 1000 * i) / 48000);
        engine.addPlay(mkPlay(0), buf);
        engine.addFx([{ kind: 'loop', playId: 0, t: 0.2, dur: 0.2, offset: 0.1, len: 0.05, rate: 1 }, { kind: 'reverse', playId: 0, t: 0.5, dur: 0.2, offset: 0.4, len: 0.2, rate0: 1, rate1: 1 }], []);
      },
    });
    let same = true;
    for (let i = 0; i < L.length && same; i += 3) same = L[i] === R[i];
    check('mono buffer: plays centred (L = R), loop / reverse work on it', same && Math.abs(envelopeAt(L, 0.1 + lat) / ref - 1) < 0.01 && rms(L, 0.25, 0.35) > 0.1, `level ${fmt(envelopeAt(L, 0.1 + lat) / ref, 3)}`);
  }

  // --- junk rate lists ----------------------------------------------------------------------------
  {
    const positions = [0.5, 1.0, 1.5, 2.0];
    const cases = {
      'no rate at all': undefined,
      'NaN and negative values': [{ t: 0.2, v: NaN }, { t: 0.2, v: 1 }, { t: 1.0, v: -3 }, null],
      'first point before startAt': [{ t: -5, v: 1.1 }, { t: -1, v: 1.0, ramp: true }],
      'first point after startAt': [{ t: 0.7, v: 1 }],
    };
    const bad = [];
    for (const [label, rate] of Object.entries(cases)) {
      const play = mkPlay(0, { startAt: 0.2 });
      play.rate = rate;
      try {
        let model = null;
        const { L } = await renderSet({
          seconds: 1.6,
          build: (engine, ctx) => {
            engine.addPlay(play, clickBuffer(ctx, 3, positions));
            model = engine.getPlay(0);
          },
        });
        // Whatever the engine made of it, what it plays must match the model it reports.
        const expected = positions.map((p) => timeAtPosition(model, p) + lat).filter((t) => t < 1.5);
        const found = findClicks(L, { to: 1.5 });
        const m = matchClicks(found, expected);
        if (model.rate[0].t !== 0.2 || found.length !== expected.length || m.matched !== expected.length || m.worst > 0.001) bad.push(`${label}: ${found.length}/${expected.length} clicks, model ${JSON.stringify(model.rate)}`);
      } catch (err) {
        bad.push(`${label}: threw ${err}`);
      }
    }
    check('malformed rate lists are normalised (never throw, audio matches getPlay())', bad.length === 0, bad.join(' | ') || `${Object.keys(cases).length} cases`);
  }

  return results;
}

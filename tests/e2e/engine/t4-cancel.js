// 4. cancelFrom + late scheduling, made deterministic with OfflineAudioContext.suspend():
//    the engine is poked at an exact context time in the middle of a render.
//    Every scenario runs twice: with AudioParam.cancelAndHoldAtTime (Chrome, Safari) and with the
//    cancelScheduledValues fallback (the path Firefox takes).
import { evalParam, timeAtPosition, positionAt } from '../../../js/dj/timeline.js';
import { truncatePlay } from '../../../js/dj/engine.js';
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
  maxStep,
  envelopeAt,
  biquadMag,
  measureLatency,
  db,
  fmt,
  ms,
} from './lib.js';

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const AMP = 0.4;

async function scenarios(check, tag, engineOpts, lat, ref) {
  const name = (s) => `[${tag}] ${s}`;
  const level = (data, t) => envelopeAt(data, t + lat) / ref;

  // --- cancel "now", in the middle of a linear ramp ----------------------------------------
  {
    const events = [ev('gain', 0, 1), ev('gain', 4, 0, 'lin'), ev('gain', 4.2, 1)];
    let model = null;
    let removed = null;
    const { L } = await renderSet({
      seconds: 4.8,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 6, 1000, AMP)),
      hooks: [
        [2, (engine) => {
          removed = engine.cancelFrom(engine.now());
          model = engine.getPlay(0);
        }],
      ],
    });
    const before = Math.abs(level(L, 1.0) - 0.75);
    const held = Math.max(...[2.05, 2.5, 3.0, 3.9, 4.1, 4.5].map((t) => Math.abs(level(L, t) - 0.5)));
    check(name('cancel mid-ramp: untouched before the cut'), before < 0.005, `|Δ| ${fmt(before, 5)} at t=1`);
    check(name('cancel mid-ramp: gain held at its value (0.5), later events gone'), held < 0.005, `worst |Δ| ${fmt(held, 5)} from t=2.05 to 4.5`);
    const step = Math.abs(level(L, 2.004) - level(L, 1.996));
    check(name('cancel mid-ramp: no jump at the cut'), step < 0.004, `Δ across the cut ${fmt(step, 5)}`);
    const m = model ? evalParam(model.events, 'gain', 3.3, 1) : NaN;
    check(name('cancel mid-ramp: getPlay() model agrees (0.5) and no play was removed'), Math.abs(m - 0.5) < 1e-6 && removed && removed.length === 0, `model ${fmt(m, 6)}, removed [${removed}]`);
    const t = truncatePlay(mkPlay(0, { events }), 2);
    check(name('truncatePlay() gives the same events as the engine'), JSON.stringify(t.events) === JSON.stringify(model.events), JSON.stringify(t.events));
  }

  // --- the held value is a real anchor: a ramp scheduled after the cancel starts from it --------
  {
    const run = async (events, expectAt) => {
      const { L } = await renderSet({
        seconds: 4,
        engineOpts,
        build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 6, 1000, AMP)),
        hooks: [
          [2, (engine) => {
            engine.cancelFrom(engine.now());
            engine.extendPlay(0, { events: [ev('gain', 3, 1, 'lin')] }); // deliberately no 'set' first
          }],
        ],
      });
      return Math.max(...expectAt.map(([t, want]) => Math.abs(level(L, t) - want)));
    };
    const midRamp = await run([ev('gain', 0, 1), ev('gain', 4, 0, 'lin')], [[2.25, 0.625], [2.5, 0.75], [2.75, 0.875], [3.5, 1]]);
    const flat = await run([ev('gain', 0, 0.5), ev('gain', 3.5, 0.1)], [[2.25, 0.625], [2.5, 0.75], [2.75, 0.875], [3.7, 1]]);
    // Nothing to cut on this lane: the late ramp then runs from the previous event (t=0), exactly as
    // AudioParam and evalParam define it: 0.5 + 0.5·t/3.
    const untouched = await run([ev('gain', 0, 0.5)], [[1.5, 0.5], [2.25, 0.875], [2.7, 0.95], [3.5, 1]]);
    check(name('a ramp scheduled right after the cancel starts from the held value'), midRamp < 0.005 && flat < 0.005, `worst |Δ| after a mid-ramp cut ${fmt(midRamp, 5)}, after a cut on a flat stretch ${fmt(flat, 5)}`);
    check(name('…and on a lane the cancel had nothing to cut, a late ramp still renders as evalParam says'), untouched < 0.005, `worst |Δ| ${fmt(untouched, 5)}`);
  }

  // --- cancel in the future: the ramp runs on to the cut, then holds -----------------------
  {
    const events = [ev('gain', 0, 1), ev('gain', 4, 0, 'lin')];
    const { L } = await renderSet({
      seconds: 4.6,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 6, 1000, AMP)),
      hooks: [[1, (engine) => engine.cancelFrom(3)]],
    });
    const errs = [[1.5, 0.625], [2.0, 0.5], [2.9, 0.275], [3.2, 0.25], [4.3, 0.25]].map(([t, want]) => Math.abs(level(L, t) - want));
    check(name('cancel at a future time: ramp continues to the cut (no snap back), then holds'), Math.max(...errs) < 0.005, `|Δ| at 1.5, 2.0, 2.9, 3.2, 4.3 s: ${errs.map((e) => fmt(e, 4)).join(' ')}`);
  }

  // --- cancel before a ramp has even begun ---------------------------------------------------
  {
    const events = [ev('gain', 0, 0.8), ev('gain', 3, 0.8), ev('gain', 4, 0.1, 'lin')];
    const { L } = await renderSet({
      seconds: 4.6,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 6, 1000, AMP)),
      hooks: [[2, (engine) => engine.cancelFrom(engine.now())]],
    });
    const errs = [1.0, 2.5, 3.5, 4.3].map((t) => Math.abs(level(L, t) - 0.8));
    check(name('cancel before a ramp starts: the ramp never happens'), Math.max(...errs) < 0.005, `worst |Δ| ${fmt(Math.max(...errs), 5)}`);
  }

  // --- cancel exactly on an event time: "at/after" goes ---------------------------------------
  {
    const events = [ev('gain', 0, 0.8), ev('gain', 2, 0.2)];
    const { L } = await renderSet({
      seconds: 3,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(0, { events }), sineBuffer(ctx, 4, 1000, AMP)),
      hooks: [[2, (engine) => engine.cancelFrom(2)]],
    });
    const e = Math.max(Math.abs(level(L, 2.1) - 0.8), Math.abs(level(L, 2.8) - 0.8));
    check(name('cancel exactly on an event: that event is removed too'), e < 0.005, `|Δ| ${fmt(e, 5)}`);
  }

  // --- setTarget in flight is frozen; exponential filter sweep is held on its curve ---------
  {
    const evT = [ev('gain', 0, 1), ev('gain', 1, 0, 'tgt', 1.0)];
    const evX = [ev('lpf', 0, 20000), ev('lpf', 4, 200, 'exp'), ev('gain', 3, 0)];
    const { L, R } = await renderSet({
      seconds: 4.6,
      engineOpts,
      build: (engine, ctx) => {
        engine.addPlay(mkPlay(0, { events: evT }), sineBuffer(ctx, 6, 1000, AMP, 0));
        engine.addPlay(mkPlay(1, { events: evX }), sineBuffer(ctx, 6, 2000, AMP, 1));
      },
      hooks: [[2, (engine) => engine.cancelFrom(engine.now())]],
    });
    const want = Math.exp(-1);
    const eT = Math.max(...[2.1, 3.0, 4.4].map((t) => Math.abs(level(L, t) - want)));
    check(name('cancel during setTarget: frozen at its value (e⁻¹)'), eT < 0.005, `worst |Δ| ${fmt(eT, 5)}`);
    // Held cutoff = 20000·(200/20000)^(2/4) = 2000 Hz; tone at 2 kHz sits exactly on it.
    const base = envelopeAt(R, 0.2 + lat) / biquadMag('lowpass', 20000, 0, 2000);
    const wantDb = db(biquadMag('lowpass', 2000, 0, 2000));
    const got = [2.2, 3.5, 4.4].map((t) => db(envelopeAt(R, t + lat) / base));
    check(name('cancel during exp sweep: cutoff held at 2 kHz, later gain cut gone'), got.every((d) => Math.abs(d - wantDb) < 0.5), `level ${got.map((d) => fmt(d, 2)).join(', ')} dB (want ${fmt(wantDb, 2)} dB)`);
  }

  // --- plays that have not started are removed; a pending endAt is forgotten ---------------
  {
    const build = (engine, ctx) => {
      engine.addPlay(mkPlay(0), sineBuffer(ctx, 6, 1000, AMP, 0));
      engine.extendPlay(0, { endAt: 3.0, events: [ev('gain', 2.9, 1), ev('gain', 3.0, 0.5, 'lin')] });
      engine.addPlay(mkPlay(1, { startAt: 3.5 }), sineBuffer(ctx, 3, 1000, AMP, 1));
      engine.addPlay(mkPlay(2, { startAt: 2.5 }), sineBuffer(ctx, 3, 1000, AMP, 1));
    };
    const control = await renderSet({ seconds: 4.5, engineOpts, build });
    check(name('control: endAt stops the play, later plays start'), peak(control.L, 3.0 + lat + 0.001, 4.5) < 1e-5 && rms(control.R, 3.7, 4.4) > 0.1, `L peak after endAt ${peak(control.L, 3.0 + lat + 0.001, 4.5).toExponential(1)}, R rms ${fmt(rms(control.R, 3.7, 4.4), 3)}`);
    let removed = null;
    let after = null;
    let endAt;
    const cut = await renderSet({
      seconds: 4.5,
      engineOpts,
      build,
      hooks: [
        [2, (engine) => {
          removed = engine.cancelFrom(2.5);
          after = engine.debug();
          endAt = engine.getPlay(0).endAt;
        }],
      ],
    });
    check(name('unstarted plays are removed (startAt ≥ cut, including = cut) and reported'), removed && removed.slice().sort().join() === '1,2' && after.strips === 1, `removed [${removed}], strips left ${after && after.strips}`);
    check(name('removed plays never sound'), peak(cut.R, 0, 4.5) < 1e-5, `R peak ${peak(cut.R, 0, 4.5).toExponential(1)}`);
    const l = level(cut.L, 3.5);
    check(name('a cancelled endAt no longer stops the play (and its fade events are gone)'), Math.abs(l - 1) < 0.005 && endAt === null, `level at 3.5 s ${fmt(l, 4)}, getPlay().endAt ${endAt}`);
  }

  // --- cancel landing inside a play's 4 ms pre-roll: it is faded away, not cut ----------------
  {
    let removed = null;
    const { L } = await renderSet({
      seconds: 3,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(5, { startAt: 2.0, offset: 0.5003 }), sineBuffer(ctx, 3, 1000, AMP)),
      hooks: [[2, (engine) => (removed = engine.cancelFrom(engine.now()))]],
    });
    const blip = peak(L, 1.99, 2.02);
    const gone = peak(L, 2.0 + lat + 0.004, 3);
    check(name('a play cancelled at the very instant it starts is removed with a 3 ms fade'), removed && removed.join() === '5' && gone < 1e-5 && maxStep(L, 1.99, 2.03) < 0.06, `removed [${removed}]; pre-roll remnant peaks at ${fmt(blip, 3)}, silent 4 ms later (${gone.toExponential(1)}); largest sample step ${fmt(maxStep(L, 1.99, 2.03), 4)}`);
  }

  // --- endAt can be moved / cleared through extendPlay ----------------------------------------
  {
    const { L } = await renderSet({
      seconds: 4,
      engineOpts,
      build: (engine, ctx) => {
        engine.addPlay(mkPlay(0, { endAt: 1.5 }), sineBuffer(ctx, 6, 1000, AMP));
      },
      hooks: [[1, (engine) => engine.extendPlay(0, { endAt: 3 })]],
    });
    const mid = level(L, 2.5);
    check(name('extendPlay moves a pending endAt (1.5 → 3.0)'), Math.abs(mid - 1) < 0.005 && peak(L, 3 + lat + 0.001, 4) < 1e-5, `level at 2.5 s ${fmt(mid, 4)}, peak after 3 s ${peak(L, 3 + lat + 0.001, 4).toExponential(1)}`);
  }

  // --- rate automation is held too -------------------------------------------------------------
  {
    const positions = range(40, (i) => 0.05 + 0.2 * i);
    const play = mkPlay(0, { rate: [{ t: 0, v: 1 }, { t: 1, v: 1 }, { t: 3, v: 1.2, ramp: true }] });
    let model = null;
    const { L } = await renderSet({
      seconds: 5,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(play, clickBuffer(ctx, 8.2, positions)),
      hooks: [
        [2, (engine) => {
          engine.cancelFrom(engine.now());
          model = engine.getPlay(0);
        }],
      ],
    });
    const heldRate = model.rate[model.rate.length - 1].v;
    const expected = positions.map((p) => timeAtPosition(model, p) + lat).filter((t) => t < 4.9);
    const found = findClicks(L, { to: 4.9 });
    const m = matchClicks(found, expected);
    check(name('cancel mid rate ramp: rate held at 1.1'), Math.abs(heldRate - 1.1) < 1e-9, `model rate ${heldRate}`);
    check(name('cancel mid rate ramp: clicks follow the truncated plan within 1.5 ms'), m.matched === expected.length && found.length === expected.length && m.worst < 0.0015, `${found.length}/${expected.length} clicks, worst ${ms(m.worst)}`);
    // Had the ramp gone on to 1.2 the last clicks would be elsewhere: make sure the test can tell.
    const uncut = positions.map((p) => timeAtPosition(play, p) + lat).filter((t) => t > 4 && t < 4.9);
    const drift = Math.min(...uncut.map((t) => Math.min(...found.map((c) => Math.abs(c.t - t)))));
    check(name('…and not the original plan'), drift > 0.003, `nearest original-plan click is ${ms(drift)} away`);
  }

  // --- one-shots: not started → dropped; running → finish; FX-bus events → cut ---------------
  {
    const { L } = await renderSet({
      seconds: 5,
      engineOpts,
      build: (engine) => {
        engine.addFx([{ kind: 'impact', t: 3.0, gain: 0.8 }, { kind: 'riser', t: 2.0, dur: 1.5, gain: 0.5 }, { kind: 'riser', t: 1.0, dur: 1.8, gain: 0.5 }], []);
      },
      hooks: [[2, (engine) => engine.cancelFrom(2)]],
    });
    const running = rms(L, 2.5, 2.8);
    const dropped = peak(L, 2.8 + lat + 0.001, 5);
    check(name('one-shots not yet started are dropped, a running riser finishes'), running > 0.02 && dropped < 1e-5, `running riser rms ${fmt(running, 3)}; peak after it ends (impact at 3.0 and second riser cancelled) ${dropped.toExponential(1)}`);
  }
  {
    const build = (engine, ctx) => {
      engine.addFx([], [ev('delayTime', 0, 0.25), ev('delayFeedback', 0, 0.8), ev('fxReturn', 0, 1), ev('fxReturn', 2.5, 0)]);
      engine.addPlay(mkPlay(0, { events: [ev('delaySend', 0, 1)] }), addBurst(emptyBuffer(ctx, 5), 1.0, 1000, 0.5));
    };
    const control = await renderSet({ seconds: 4, engineOpts, build });
    const cut = await renderSet({ seconds: 4, engineOpts, build, hooks: [[2, (engine) => engine.cancelFrom(2)]] });
    check(name('FX-bus events after the cut are removed (fxReturn stays open)'), peak(control.L, 2.6, 4) < 1e-5 && peak(cut.L, 2.6, 4) > 0.01, `echo peak after 2.6 s: control ${peak(control.L, 2.6, 4).toExponential(1)}, after cancel ${fmt(peak(cut.L, 2.6, 4), 3)}`);
  }

  // --- late addPlay: starts now, but on the grid, with every param where it should be -------
  {
    // Left channel: clicks (timing). Right channel: a tone (reads the gain curve).
    const positions = range(30, (i) => 0.11 + 0.25 * i);
    const play = mkPlay(7, {
      startAt: 0.3,
      offset: 0.2,
      rate: [{ t: 0.3, v: 1.03 }, { t: 1.5, v: 1.03 }, { t: 3.5, v: 1.0, ramp: true }],
      events: [ev('gain', 0.3, 0.2), ev('gain', 2.3, 1.0, 'lin'), ev('mid', 0.3, -28), ev('mid', 0.6, 0, 'lin')],
    });
    let threw = '';
    let state = null;
    const { L, R } = await renderSet({
      seconds: 4.5,
      engineOpts,
      hooks: [
        [1, (engine, ctx) => {
          try {
            const buf = clickBuffer(ctx, 8, positions, { channel: 0 });
            addSine(buf, 1000, AMP, 1);
            engine.addPlay(play, buf);
            state = engine.playState(7, engine.now());
          } catch (err) {
            threw = String(err);
          }
        }],
      ],
    });
    const audible = positions.map((p) => timeAtPosition(play, p)).filter((t) => t > 1.0 && t < 4.4);
    const found = findClicks(L, { threshold: 0.01, to: 4.4 + lat });
    const m = matchClicks(found, audible.map((t) => t + lat));
    check(name('late addPlay does not throw'), !threw, threw);
    check(name('late addPlay: nothing before "now", then every click on the planned grid (≤ 1 ms)'), !threw && peak(L, 0, 1.0 + lat - 0.0005) < 1e-5 && found.length === audible.length && m.matched === audible.length && m.worst < 0.001, `${found.length}/${audible.length} clicks, worst ${ms(m.worst)}`);
    let worst = 0;
    for (let t = 1.03; t < 4.3; t += 0.03) {
      worst = Math.max(worst, Math.abs(envelopeAt(R, t + lat, 0.01) / ref - evalParam(play.events, 'gain', t, 1)));
    }
    check(name('late addPlay: params are at their evalParam value (gain ramp already in flight, EQ ramp already done)'), !threw && worst < 0.015, `worst |Δgain| ${fmt(worst, 4)} from the late start on`);
    check(name('late addPlay: playState() reports the position timeline.js predicts'), state && Math.abs(state.pos - positionAt(play, 1.0)) < 1e-9 && Math.abs(state.gain - evalParam(play.events, 'gain', 1.0, 1)) < 1e-9, state ? `pos ${fmt(state.pos, 5)} gain ${fmt(state.gain, 4)}` : 'no state');
  }

  // --- late extendPlay (events already in the past) --------------------------------------------
  {
    let threw = '';
    const more = [ev('gain', 0.5, 1), ev('gain', 2.5, 0.2, 'lin'), ev('gain', 3.0, 0.2), ev('gain', 3.0, 0.9, 'tgt', 0.2)];
    const { L } = await renderSet({
      seconds: 4,
      engineOpts,
      build: (engine, ctx) => engine.addPlay(mkPlay(0), sineBuffer(ctx, 6, 1000, AMP)),
      hooks: [
        [1, (engine) => {
          try {
            engine.extendPlay(0, { events: more });
          } catch (err) {
            threw = String(err);
          }
        }],
      ],
    });
    let worst = 0;
    for (let t = 1.02; t < 3.9; t += 0.02) {
      if (Math.abs(t - 3.0) < 0.005) continue;
      worst = Math.max(worst, Math.abs(level(L, t) - evalParam(more, 'gain', t, 1)));
    }
    check(name('late extendPlay: joins the curve where it would be by now'), !threw && worst < 0.01, threw || `worst |Δgain| ${fmt(worst, 5)} after the late call`);
  }

  // --- endAt that is already past, and re-adding a play id that is still running ---------------
  {
    let threw = '';
    const { L, R, engine } = await renderSet({
      seconds: 3,
      engineOpts,
      build: (engine, ctx) => {
        engine.addPlay(mkPlay(0), sineBuffer(ctx, 5, 1000, AMP, 0));
        engine.addPlay(mkPlay(1), sineBuffer(ctx, 5, 1000, AMP, 0));
      },
      hooks: [
        [1, (engine, ctx) => {
          try {
            engine.extendPlay(0, { endAt: 0.5 }); // "should have stopped half a second ago"
            engine.addPlay(mkPlay(1, { startAt: 0.2 }), sineBuffer(ctx, 5, 1000, AMP, 1)); // same id, new audio (right channel)
          } catch (err) {
            threw = String(err);
          }
        }],
        [2, (engine) => engine.tick()],
      ],
    });
    const before = level(L, 0.9);
    const after = peak(L, 1.0 + lat + 0.006, 3);
    const step = maxStep(L, 0.99, 1.03);
    const fresh = envelopeAt(R, 1.5 + lat) / ref;
    check(name('endAt in the past + replacing a running play: both old sources fade out at once, click-free; the replacement plays'), !threw && Math.abs(before - 2) < 0.02 && after < 1e-4 && step < 0.12 && Math.abs(fresh - 1) < 0.01 && engine.debug().strips === 1, threw || `two plays before ${fmt(before, 3)}×, left peak 6 ms after ${after.toExponential(1)}, largest step ${fmt(step, 4)}, replacement level ${fmt(fresh, 3)}`);
  }

  // --- a play that is already over when it is added --------------------------------------------
  {
    const seen = [];
    let threw = '';
    const { L, engine } = await renderSet({
      seconds: 2.5,
      engineOpts,
      build: (engine) => {
        engine.on('playstart', (e) => seen.push(`start${e.playId}`));
        engine.on('playend', (e) => seen.push(`end${e.playId}`));
      },
      hooks: [
        [2, (engine, ctx) => {
          try {
            engine.addPlay(mkPlay(3, { startAt: 0.1 }), sineBuffer(ctx, 1, 1000, AMP)); // 1 s of audio, 1.9 s ago
            engine.addPlay(mkPlay(4, { startAt: 0.1, endAt: 1.5 }), sineBuffer(ctx, 6, 1000, AMP)); // endAt passed
          } catch (err) {
            threw = String(err);
          }
        }],
      ],
    });
    await Promise.resolve();
    check(name('adding a play that is already over: no throw, no sound, still a start/end pair'), !threw && peak(L, 0, 2.5) < 1e-5 && seen.join() === 'start3,end3,start4,end4' && engine.debug().strips === 0, threw || `events ${seen.join()}, peak ${peak(L, 0, 2.5).toExponential(1)}`);
  }
}

export default async function cancel() {
  const { results, check } = suite();
  const lat = await measureLatency();
  const { L } = await renderSet({
    seconds: 1,
    build: (engine, ctx) => engine.addPlay(mkPlay(0), sineBuffer(ctx, 1.2, 1000, AMP)),
  });
  const ref = envelopeAt(L, 0.5, 0.01);
  check('this browser has AudioParam.cancelAndHoldAtTime (otherwise both passes test the fallback)', typeof AudioParam.prototype.cancelAndHoldAtTime === 'function');
  await scenarios(check, 'native hold', {}, lat, ref);
  await scenarios(check, 'fallback', { cancelAndHold: false }, lat, ref);
  return results;
}

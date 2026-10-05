// 6. Lifecycle: nothing leaks over a long set, and the realtime path (real AudioContext, timers,
//    pause/resume, recorder tap, iOS unlock helper) works.
import { createEngine, unlockAudio, lockAudio, LIMITER } from '../../../js/dj/engine.js';
import { createRecorder, pickMimeType, extensionFor } from '../../../js/dj/recorder.js';
import { suite, renderSet, mkPlay, ev, emptyBuffer, addSine, addBlip, findClicks, peak, maxStep, sleep, fmt } from './lib.js';

export default async function lifecycle() {
  const { results, check } = suite();

  // --- offline: 40 short plays with every kind of FX, housekeeping once a second -------------
  {
    const N = 40;
    const seen = { start: [], end: [] };
    const samples = [];
    let baseline = null;
    const { engine, L } = await renderSet({
      seconds: 11,
      build: (engine, ctx) => {
        baseline = engine.debug();
        engine.on('playstart', (e) => seen.start.push(e.playId));
        engine.on('playend', (e) => seen.end.push(e.playId));
        const buf = addSine(emptyBuffer(ctx, 1.5), 500, 0.2);
        addBlip(buf, 0.5, 0.3);
        for (let i = 0; i < N; i++) {
          const t = 0.2 * i;
          const events = [ev('gain', t, 0.8), ev('reverbSend', t, 0.3), ev('delaySend', t, i % 2 ? 0.4 : 0), ev('low', t, 0), ev('low', t + 0.1, -12, 'lin'), ev('lpf', t, 20000), ev('lpf', t + 0.14, 800, 'exp')];
          engine.addPlay(mkPlay(i, { startAt: t, offset: 0.3, events, endAt: i % 3 === 0 ? null : t + 0.15 }), buf);
          if (i % 3 === 0) engine.extendPlay(i, { endAt: t + 0.15, events: [ev('gain', t + 0.1, 0.8), ev('gain', t + 0.15, 0, 'lin')] });
          const fx = [];
          if (i % 4 === 0) fx.push({ kind: 'loop', playId: i, t: t + 0.05, dur: 0.1, offset: 0.48, len: 0.05, rate: 1 });
          if (i % 4 === 1) fx.push({ kind: 'reverse', playId: i, t: t + 0.05, dur: 0.2, offset: 0.6, len: 0.2, rate0: 1, rate1: 0.4 });
          if (i % 5 === 0) fx.push({ kind: 'riser', t, dur: 0.3, gain: 0.2 });
          if (i % 7 === 0) fx.push({ kind: 'impact', t: t + 0.1, gain: 0.2 });
          engine.addFx(fx, [ev('delayTime', t, 0.1 + 0.01 * (i % 5)), ev('delayFeedback', t, 0.3)]);
        }
        samples.push({ t: 0, ...engine.debug() });
      },
      hooks: Array.from({ length: 10 }, (_, k) => [k + 1, (engine) => {
        engine.tick();
        samples.push({ t: k + 1, ...engine.debug() });
      }]),
    });
    engine.tick();
    const end = engine.debug();
    check('offline: all 40 plays + FX scheduled up front, audio rendered', samples[0].strips === N && peak(L, 0, 8) > 0.05, `strips at t=0: ${samples[0].strips}, one-shots ${samples[0].oneShots}, nodes ${samples[0].nodes}, peak ${fmt(peak(L, 0, 8), 3)}`);
    const shrinking = samples.every((s, i) => i === 0 || s.strips <= samples[i - 1].strips) && samples[5].strips < N - 20;
    check('offline: strips are freed as the set moves on', shrinking, `strips per second: ${samples.map((s) => s.strips).join(' ')}`);
    check('offline: after the set every strip, one-shot and node is gone (counters back to baseline)', end.strips === 0 && end.oneShots === 0 && end.dying === 0 && end.nodes === end.baselineNodes && end.nodes === baseline.nodes, `strips ${end.strips}, one-shots ${end.oneShots}, nodes ${end.nodes} (baseline ${baseline.nodes}, peak ${Math.max(...samples.map((s) => s.nodes))})`);
    check('offline: playstart and playend fired once per play, in order', seen.start.join() === Array.from({ length: N }, (_, i) => i).join() && seen.end.join() === seen.start.join(), `${seen.start.length} starts, ${seen.end.length} ends`);
    check('offline: FX-bus automation history is compacted', end.busEvents < 60, `${end.busEvents} bus events kept after ${N * 2} were scheduled`);
  }

  // --- a play nobody ends: the buffer runs out, the strip still goes away, and without a click ---
  {
    const seen = [];
    const { engine, L } = await renderSet({
      seconds: 2,
      build: (engine, ctx) => {
        engine.on('playend', (e) => seen.push(e.playId));
        // 0.7003 s of a loud tone that is nowhere near zero when the buffer stops.
        const buf = ctx.createBuffer(2, Math.round(0.7003 * 48000), 48000);
        addSine(buf, 330, 0.5);
        engine.addPlay(mkPlay(0, { startAt: 0.1, rate: [{ t: 0.1, v: 1.07 }] }), buf);
      },
      hooks: [[1, (engine) => engine.tick()]],
    });
    engine.tick();
    const end = 0.1 + 0.7003 / 1.07;
    const natural = 0.5 * 0.85 * 2 * Math.PI * ((330 * 1.07) / 48000);
    const step = maxStep(L, end - 0.01, end + 0.02);
    check('no endAt: the play ends with its buffer, fades its last 4 ms, fires playend and is freed', seen.join() === '0' && engine.debug().strips === 0 && engine.debug().nodes === engine.debug().baselineNodes && step < natural * 2.5 && peak(L, end + 0.012, 2) < 1e-4, `largest sample step at the end ${fmt(step, 4)} (sine alone ${fmt(natural, 4)}), playend [${seen}]`);
  }

  // --- reset(): same context, clean slate ------------------------------------------------------
  {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const engine = createEngine({ context: ctx });
    await engine.start({ at: 0 });
    const base = engine.debug().nodes;
    engine.addPlay(mkPlay(0), addSine(emptyBuffer(ctx, 1), 500, 0.2));
    engine.addFx([{ kind: 'riser', t: 0.1, dur: 0.5, gain: 0.3 }], [ev('delayTime', 0, 0.2)]);
    const busy = engine.debug();
    await engine.reset();
    const clean = engine.debug();
    await engine.start({ at: 0 });
    engine.addPlay(mkPlay(0), addSine(emptyBuffer(ctx, 1), 500, 0.2));
    const out = await ctx.startRendering();
    check('reset(): frees everything, start() begins a new set on the same context', busy.strips === 1 && clean.strips === 0 && clean.oneShots === 0 && clean.nodes === base && !clean.started && peak(out.getChannelData(0), 0.5, 0.9) > 0.1, `nodes ${busy.nodes} → ${clean.nodes} (baseline ${base}); new set peak ${fmt(peak(out.getChannelData(0), 0.5, 0.9), 3)}`);
  }

  // --- realtime smoke ------------------------------------------------------------------------
  {
    const engine = createEngine();
    const ctx = engine.ctx;
    check('realtime: engine creates its own AudioContext lazily', ctx instanceof AudioContext, `state ${ctx.state}, ${ctx.sampleRate} Hz, baseLatency ${fmt(ctx.baseLatency || 0, 4)} s`);
    const seen = [];
    engine.on('playstart', (e) => seen.push(`start${e.playId}@${engine.now().toFixed(2)}`));
    const off = engine.on('playend', (e) => seen.push(`end${e.playId}@${engine.now().toFixed(2)}`));
    const buf = addSine(emptyBuffer(ctx, 3), 440, 0.3);
    // Calls made before start() are queued, not lost.
    engine.addPlay(mkPlay(0, { startAt: 0.1, events: [ev('gain', 0.1, 0.9), ev('reverbSend', 0.1, 0.2)] }), buf);
    engine.extendPlay(0, { endAt: 2.6 });
    engine.setVolume(0.9);
    const queued = engine.debug();
    await engine.start();
    const base = engine.debug().baselineNodes;
    const stream = engine.recordStream();
    const rec = createRecorder(stream);
    const recStarted = rec.start();
    check('realtime: start() resumes the context and flushes queued calls', ctx.state === 'running' && queued.pending === 2 && engine.debug().strips === 1, `state ${ctx.state}, queued ${queued.pending}, strips ${engine.debug().strips}`);

    await sleep(900);
    const lv = engine.levels();
    const lv2 = engine.levels();
    check('realtime: levels() shows signal and reuses its arrays', lv.rms > 0.01 && lv.peak >= lv.rms && lv === lv2 && lv.bands === lv2.bands && lv.bands instanceof Uint8Array && lv.wave instanceof Uint8Array && lv.bands.some((v) => v > 0), `rms ${fmt(lv.rms, 3)}, peak ${fmt(lv.peak, 3)}, ${lv.bands.length} bands, ${lv.wave.length} wave samples`);
    // Compared with the wall clock actually elapsed (a busy machine stretches sleep()); currentTime
    // moves in device-buffer steps, hence the tolerance.
    const n1 = engine.now();
    const w1 = performance.now();
    await sleep(300);
    const n2 = engine.now();
    const wall = (performance.now() - w1) / 1000;
    check('realtime: now() advances with the audio clock', Math.abs(n2 - n1 - wall) < 0.08, `+${fmt(n2 - n1, 3)} s of set time in ${fmt(wall, 3)} s`);
    const ui = engine.uiTime();
    check('realtime: uiTime() trails now() by the output + limiter latency', ui < engine.now() && ui > engine.now() - 0.5, `now ${fmt(engine.now(), 3)}, uiTime ${fmt(ui, 3)} (limiter ${LIMITER.lookahead * 1000} ms)`);

    await engine.pause();
    const p1 = engine.now();
    await sleep(400);
    const p2 = engine.now();
    check('realtime: pause() freezes now()', ctx.state === 'suspended' && Math.abs(p2 - p1) < 0.005, `Δ ${fmt(p2 - p1, 4)} s over 400 ms, state ${ctx.state}`);
    await engine.resume();
    const w2 = performance.now();
    await sleep(300);
    const r1 = engine.now();
    const wall2 = (performance.now() - w2) / 1000;
    check('realtime: resume() continues from where it stopped', ctx.state === 'running' && Math.abs(r1 - p2 - wall2) < 0.1, `+${fmt(r1 - p2, 3)} s of set time in ${fmt(wall2, 3)} s`);

    // Late play in realtime: must not throw, must start.
    let threw = '';
    try {
      engine.addPlay(mkPlay(1, { startAt: 0.2, offset: 0.1, events: [ev('gain', 0.2, 0.5)] }), buf);
      engine.addFx([{ kind: 'impact', t: engine.now() + 0.2, gain: 0.3 }, { kind: 'loop', playId: 1, t: engine.now() - 0.1, dur: 0.4, offset: 0.5, len: 0.1, rate: 1 }], [ev('delayTime', 0, 0.2)]);
      engine.extendPlay(1, { endAt: engine.now() + 0.6 });
    } catch (err) {
      threw = String(err);
    }
    check('realtime: late addPlay / addFx / extendPlay do not throw', !threw, threw);

    // Wait for both plays to end and be torn down (play 0 ends at set time 2.6, play 1 0.6 s from now).
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline && (engine.debug().strips > 0 || engine.debug().oneShots > 0)) await sleep(100);
    const end = engine.debug();
    check('realtime: playstart / playend fire for every play', ['start0', 'end0', 'start1', 'end1'].every((k) => seen.some((s) => s.startsWith(k + '@'))), seen.join(' '));
    const start0 = Number((seen.find((s) => s.startsWith('start0@')) || '@NaN').split('@')[1]);
    const end0 = Number((seen.find((s) => s.startsWith('end0@')) || '@NaN').split('@')[1]);
    check('realtime: the events are close to the planned times (timer accuracy)', start0 >= 0.1 && start0 < 0.4 && end0 >= 2.6 && end0 < 2.9, `start0 at ${start0} (plan 0.10), end0 at ${end0} (plan 2.60)`);
    check('realtime: finished strips are torn down by the housekeeping timer', end.strips === 0 && end.oneShots === 0 && end.nodes === end.baselineNodes && end.baselineNodes === base + 1, `strips ${end.strips}, one-shots ${end.oneShots}, nodes ${end.nodes} (baseline ${end.baselineNodes} = ${base} + recorder tap)`);

    const blob = await rec.stop();
    check('realtime: recordStream() + recorder yield a non-empty Blob', stream instanceof MediaStream && recStarted && blob instanceof Blob && blob.size > 1000 && !rec.recording, `${blob.size} bytes, type "${blob.type}", picked "${pickMimeType()}" → .${extensionFor(rec.mimeType)}`);
    off();

    engine.destroy();
    await sleep(100);
    let after = '';
    try {
      engine.addPlay(mkPlay(9), buf);
      engine.addFx([{ kind: 'impact', t: 0, gain: 1 }], []);
      engine.cancelFrom(0);
      engine.tick();
      engine.destroy();
    } catch (err) {
      after = String(err);
    }
    check('realtime: destroy() closes the context it created; later calls are harmless', ctx.state === 'closed' && !after, `state ${ctx.state} ${after}`);
  }

  // --- realtime: a play added late is still on the grid ---------------------------------------
  // Deck A (clicks, left channel) is scheduled ahead of time. Deck B (clicks, right channel) is planned
  // to coincide with A click for click, but is handed to the engine a second too late. Both channels
  // travel through the same recorder tap, so whatever latency the capture has, L and R share it.
  {
    const engine = createEngine();
    const ctx = engine.ctx;
    await engine.start();
    const tap = ctx.createMediaStreamSource(engine.recordStream());
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
    const capture = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks = [];
    capture.port.onmessage = (e) => chunks.push(e.data);
    tap.connect(capture);

    const sr = ctx.sampleRate;
    const bufA = ctx.createBuffer(2, Math.round(4 * sr), sr);
    const bufB = ctx.createBuffer(2, Math.round(4 * sr), sr);
    for (let k = 0; k < 14; k++) {
      addBlip(bufA, 0.1 + 0.25 * k, 0.5, 0);
      addBlip(bufB, (0.05 + 0.25 * k) * 1.05, 0.5, 1); // played at rate 1.05 → every 0.25 s
    }
    const t = engine.now();
    const A = mkPlay(0, { startAt: t + 0.3, offset: 0 }); // clicks at t + 0.4 + 0.25k
    const B = mkPlay(1, { startAt: t + 0.35, offset: 0, rate: [{ t: t + 0.35, v: 1.05 }] }); // same instants
    engine.addPlay(A, bufA);
    await sleep(1100);
    const lateBy = engine.now() - B.startAt;
    engine.addPlay(B, bufB);
    await sleep(1500);
    tap.disconnect();
    const n = chunks.reduce((s, c) => s + c.l.length, 0);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let at = 0;
    for (const c of chunks) {
      L.set(c.l, at);
      R.set(c.r, at);
      at += c.l.length;
    }
    const a = findClicks(L, { sr, threshold: 0.05 });
    const b = findClicks(R, { sr, threshold: 0.05 });
    let worst = 0;
    let pairs = 0;
    for (const cb of b) {
      const near = a.reduce((best, ca) => (Math.abs(ca.t - cb.t) < Math.abs(best - cb.t) ? ca.t : best), Infinity);
      if (Math.abs(near - cb.t) > 0.1) continue;
      pairs++;
      worst = Math.max(worst, Math.abs(near - cb.t));
    }
    check('realtime: a play added ~1 s late lands on the planned grid (sample-accurate vs. a deck scheduled on time)', lateBy > 0.5 && pairs >= 3 && pairs === b.length && worst <= 2 / sr, `added ${fmt(lateBy, 2)} s late; ${a.length} clicks on A, ${b.length} on B, ${pairs} pairs, worst offset ${(worst * sr).toFixed(2)} samples`);
    engine.destroy();
  }

  // --- realtime: the Skip flow (cancelFrom(now) → quick re-plan), heard through the recorder tap ----
  {
    const engine = createEngine();
    const ctx = engine.ctx;
    await engine.start();
    const tap = ctx.createMediaStreamSource(engine.recordStream());
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
    const capture = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks = [];
    capture.port.onmessage = (e) => chunks.push(e.data);
    tap.connect(capture);
    const sr = ctx.sampleRate;
    const bufA = addSine(ctx.createBuffer(2, 6 * sr, sr), 440, 0.3, 0); // A: left only
    const bufB = addSine(ctx.createBuffer(2, 6 * sr, sr), 660, 0.3, 1); // B: right only
    const t = engine.now();
    // A was planned to ride a long fade-out into a transition far away…
    engine.addPlay(mkPlay(0, { startAt: t + 0.1, offset: 0.5, events: [ev('gain', t + 0.1, 1), ev('gain', t + 4, 0.2, 'lin'), ev('lpf', t + 0.1, 20000), ev('lpf', t + 4, 300, 'exp')], endAt: t + 4 }), bufA);
    engine.addPlay(mkPlay(1, { startAt: t + 3, offset: 0.5 }), bufB);
    await sleep(900);
    // …the user presses Skip.
    const skipAt = engine.now();
    let threw = '';
    let removed = [];
    let model = null;
    try {
      removed = engine.cancelFrom(skipAt);
      model = engine.getPlay(0);
      const go = skipAt + 0.25;
      engine.extendPlay(0, { events: [ev('gain', go, model ? model.events.filter((e) => e.p === 'gain').pop().v : 1), ev('gain', go + 0.3, 0, 'lin')], endAt: go + 0.3 });
      engine.addPlay(mkPlay(2, { startAt: go, offset: 0.5, events: [ev('gain', go, 0), ev('gain', go + 0.3, 1, 'lin')] }), bufB);
    } catch (err) {
      threw = String(err);
    }
    await sleep(1300);
    tap.disconnect();
    const n = chunks.reduce((s2, c) => s2 + c.l.length, 0);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    let at = 0;
    for (const c of chunks) {
      L.set(c.l, at);
      R.set(c.r, at);
      at += c.l.length;
    }
    // Locate the hand-over in the capture itself: where B (right channel) first sounds.
    let bStart = -1;
    for (let i = 0; i < n; i++) {
      if (Math.abs(R[i]) > 0.01) {
        bStart = i / sr;
        break;
      }
    }
    const rmsOf = (d, a, b) => {
      let e = 0;
      const i0 = Math.max(0, Math.round(a * sr));
      const i1 = Math.min(n, Math.round(b * sr));
      for (let i = i0; i < i1; i++) e += d[i] * d[i];
      return Math.sqrt(e / Math.max(1, i1 - i0));
    };
    const aBefore = rmsOf(L, bStart - 0.2, bStart - 0.05);
    const aAfter = rmsOf(L, bStart + 0.45, bStart + 0.8);
    const bAfter = rmsOf(R, bStart + 0.45, bStart + 0.8);
    let clean = true;
    for (let i = 0; i < n && clean; i++) clean = Number.isFinite(L[i]) && Number.isFinite(R[i]) && Math.abs(L[i]) <= 1 && Math.abs(R[i]) <= 1;
    const heldGain = model ? model.events.filter((e) => e.p === 'gain').pop().v : NaN;
    check('realtime Skip: cancelFrom(now) + quick re-plan does not throw; the unstarted play is removed', !threw && removed.join() === '1' && model && model.endAt === null, threw || `removed [${removed}], held gain ${fmt(heldGain, 3)}`);
    check('realtime Skip: A hands over to B 250 ms later, no dropouts or junk samples', bStart > 0 && aBefore > 0.05 && aAfter < 1e-3 && bAfter > 0.1 && clean, `A rms before ${fmt(aBefore, 3)} / after ${aAfter.toExponential(1)}, B rms after ${fmt(bAfter, 3)}`);
    await sleep(700);
    const d = engine.debug();
    check('realtime Skip: everything is freed afterwards except the play still running', d.strips === 1 && d.oneShots === 0 && d.dying === 0, `strips ${d.strips}, nodes ${d.nodes} (baseline ${d.baselineNodes})`);
    engine.destroy();
  }

  // --- realtime "New Set": reset() not awaited, the next set scheduled straight away -------------
  // The old set must be gone, and its cleanup (which runs 60 ms later, after the fade) must not take
  // the new set's plays with it.
  {
    const engine = createEngine();
    const ctx = engine.ctx;
    await engine.start();
    const sr = ctx.sampleRate;
    const seen = [];
    engine.on('playstart', (e) => seen.push(e.playId));
    engine.addPlay(mkPlay(0, { startAt: 0.05, events: [ev('reverbSend', 0.05, 0.5)] }), addSine(emptyBuffer(ctx, 4), 440, 0.3));
    engine.addFx([{ kind: 'riser', t: 0.1, dur: 3, gain: 0.3 }], [ev('delayFeedback', 0, 0.8)]);
    await sleep(500);
    const before = { now: engine.now(), ...engine.debug() };
    let threw = '';
    try {
      engine.reset(); // deliberately not awaited
      engine.addPlay(mkPlay(7, { startAt: 0.05, events: [ev('gain', 0.05, 0.8)] }), addSine(ctx.createBuffer(2, 3 * sr, sr), 660, 0.3));
      engine.extendPlay(7, { endAt: 2.5 });
      await engine.start();
    } catch (err) {
      threw = String(err);
    }
    const nowAfterStart = engine.now();
    await sleep(500);
    const after = { now: engine.now(), ...engine.debug() };
    const model = engine.getPlay(7);
    const lv = engine.levels();
    check(
      'realtime reset() + start() without awaiting: the old set is freed, the new one survives and plays from set time 0',
      !threw && before.strips === 1 && before.now > 0.3 && nowAfterStart < 0 && after.now > 0.2 && after.now < before.now + 0.4 && after.strips === 1 && after.oneShots === 0 && engine.getPlay(0) === null && model && model.endAt === 2.5 && seen.join() === '0,7' && lv.rms > 0.05,
      threw || `old set at ${fmt(before.now, 2)} s (${before.strips} strip, ${before.oneShots} one-shot) → new clock ${fmt(nowAfterStart, 3)} s right after start(), ${fmt(after.now, 2)} s later; strips ${after.strips}, one-shots ${after.oneShots}, playstart [${seen}], rms ${fmt(lv.rms, 3)}`,
    );
    engine.destroy();
  }

  // --- resume() never hangs the caller, even if the browser never settles ctx.resume() ----------
  // (That is what Chrome does outside a user gesture; simulated here with a stubbed resume.)
  {
    const ctx = new AudioContext();
    const engine = createEngine({ context: ctx });
    await engine.start();
    await engine.pause();
    const real = ctx.resume.bind(ctx);
    ctx.resume = () => new Promise(() => {});
    const t = performance.now();
    const outcome = await Promise.race([engine.resume().then(() => 'returned'), sleep(4000).then(() => 'hung')]);
    const took = performance.now() - t;
    ctx.resume = real;
    await engine.resume();
    check('resume() returns even when the browser leaves ctx.resume() pending (no user gesture)', outcome === 'returned' && took < 3000 && ctx.state === 'running', `${outcome} after ${Math.round(took)} ms; a real resume afterwards → ${ctx.state}`);
    engine.destroy();
    await ctx.close();
  }

  // --- a context the engine was given is not closed --------------------------------------------
  {
    const ctx = new AudioContext();
    const engine = createEngine({ context: ctx });
    await engine.start();
    engine.destroy();
    await sleep(50);
    const state = ctx.state;
    await ctx.close();
    check('destroy() leaves a caller-owned context open', state !== 'closed', `state ${state}`);
    const off = new OfflineAudioContext(2, 4800, 48000);
    const e2 = createEngine({ context: off });
    await e2.start({ at: 0 });
    let ok = true;
    try {
      ok = e2.recordStream() === null;
      await e2.pause();
      await e2.resume();
    } catch {
      ok = false;
    }
    check('OfflineAudioContext: recordStream() is null, pause()/resume() are no-ops', ok);

    // unlock(): the gesture-bound half of start(), for apps that can only start the set later.
    const e3 = createEngine();
    const c3 = e3.ctx;
    await c3.suspend();
    const suspended = c3.state;
    let threw = '';
    try {
      e3.unlock();
      e2.unlock();
    } catch (err) {
      threw = String(err);
    }
    await sleep(150);
    const d3 = e3.debug();
    check('unlock(): resumes the context and builds the graph without starting the set clock; no-op offline', !threw && suspended === 'suspended' && c3.state === 'running' && !d3.started && e3.now() === 0 && d3.baselineNodes > 0, threw || `state ${suspended} → ${c3.state}, started ${d3.started}, now ${e3.now()}`);
    e3.destroy();
    e3.unlock();
    await sleep(50);
    check('unlock() after destroy() does nothing (context stays closed)', c3.state === 'closed' && e3.ctx === c3, `state ${c3.state}`);
  }

  // --- recorder + unlock helpers -----------------------------------------------------------------
  {
    const none = createRecorder(null);
    const blob = await none.stop();
    check('recorder without a stream: unsupported, start() false, stop() resolves an empty Blob', none.supported === false && none.start() === false && none.recording === false && blob instanceof Blob && blob.size === 0);
    const saved = window.MediaRecorder;
    window.MediaRecorder = undefined;
    let ok = true;
    try {
      const r = createRecorder(new MediaStream());
      ok = r.supported === false && r.start() === false && (await r.stop()).size === 0 && pickMimeType() === '';
    } catch {
      ok = false;
    }
    window.MediaRecorder = saved;
    check('recorder when MediaRecorder is missing: safe no-op', ok);

    const idle = unlockAudio();
    const el = unlockAudio({ force: true });
    await sleep(150);
    const again = unlockAudio({ force: true });
    check('unlockAudio(): no-op off iOS; forced, it loops a silent <audio> (and is idempotent)', idle === null && el instanceof HTMLAudioElement && el.loop && again === el && !el.paused, el ? `paused ${el.paused}, src ${String(el.src).slice(0, 5)}…, duration ${fmt(el.duration, 2)} s` : 'no element');
    const a = {};
    const b = {};
    unlockAudio({ force: true, owner: a });
    unlockAudio({ force: true, owner: b });
    lockAudio(a);
    const stillOn = !el.paused;
    lockAudio(b);
    check('lockAudio(owner) releases it only when the last owner lets go', stillOn && el.paused, `after first release paused=${!stillOn}, after last paused=${el.paused}`);
    const el2 = unlockAudio({ force: true });
    lockAudio();
    check('lockAudio() without an owner releases unconditionally', el2 instanceof HTMLAudioElement && el2.paused);
  }

  return results;
}

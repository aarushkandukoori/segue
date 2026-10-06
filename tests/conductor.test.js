// The conductor's state machine, driven with a fake engine / resolver / analyzer and a hand-cranked
// clock (no audio, no network, no timers): what gets planned, in which order, and what happens when
// tracks fail, the network is slow, Skip is pressed or a new set starts under running work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConductor, deckFrameAt, nextCycleOrder, trickWindows, WINDOW } from '../js/dj/conductor.js';
import { createPlanner, holdPlayAt } from '../js/dj/planner.js';
import { synthAnalysis } from './helpers/dj-synth.js';

const BPMS = [120, 124, 126, 122, 98, 128, 121, 125, 100, 123, 127, 119, 140, 124, 126, 90];

/** @param {number} n @param {{bpms?: number[], duration?: number, source?: string}} [o] */
function makeCrate(n, o = {}) {
  const bpms = o.bpms || BPMS;
  const source = o.source || 'deezer';
  const tracks = [];
  const analyses = [];
  for (let i = 0; i < n; i++) {
    tracks.push({ id: `t:${i}`, title: `Track ${i}`, artist: `Artist ${i % 7}` });
    analyses.push(synthAnalysis({ bpm: bpms[i % bpms.length], duration: o.duration || 30, first: 0.1 + (i % 5) * 0.03, pc: (i * 5) % 12, mode: i % 2 ? 'minor' : 'major', energy: 0.4 + (i % 6) * 0.1 }));
  }
  return { playlist: { id: source === 'local' ? 'local:test' : 'deezer:chart:0', source, title: 'Test crate', tracks }, analyses };
}

function fakeEngine() {
  let t = 0;
  let started = false;
  const plays = new Map();
  const log = [];
  let pending = [];
  // The context as the browser has it: tests flip `state` to play the browser stopping the audio by
  // itself ('suspended', iOS: 'interrupted'), and `blocked` for a resume() it will not honour.
  // (The fake reads it through this binding, so a test can count the conductor's own reads of `ctx`.)
  const ctx = { state: 'running' };
  const api = {
    log,
    plays,
    ctx,
    blocked: false,
    calls: { pause: 0, resume: 0 },
    now: () => (started ? t : 0),
    advance(dt) {
      if (started && ctx.state === 'running') t += dt;
    },
    async start() {
      if (started) return;
      started = true;
      t = -0.15;
      const ops = pending;
      pending = [];
      for (const op of ops) op();
    },
    addPlay(play, buffer) {
      if (!started) return void pending.push(() => api.addPlay(play, buffer));
      assert.ok(buffer && buffer.duration > 0, 'addPlay needs a decoded buffer');
      plays.set(play.id, { ...play, events: play.events.slice(), rate: play.rate.slice() });
      log.push(['addPlay', play.id, play.trackId, t]);
    },
    extendPlay(id, more) {
      if (!started) return void pending.push(() => api.extendPlay(id, more));
      const p = plays.get(id);
      if (!p) return false;
      p.events.push(...(more.events || []));
      p.rate.push(...(more.rate || []));
      if (more.endAt !== undefined) p.endAt = more.endAt;
      log.push(['extendPlay', id, t]);
      return true;
    },
    addFx(fx, fxEvents) {
      log.push(['addFx', fx.length, fxEvents.length, t]);
    },
    cancelFrom(T) {
      const removed = [];
      for (const [id, p] of plays) {
        if (p.startAt >= T) {
          plays.delete(id);
          removed.push(id);
        } else plays.set(id, holdPlayAt(p, T));
      }
      log.push(['cancelFrom', T, removed.join(',')]);
      return removed;
    },
    getPlay: (id) => {
      const p = plays.get(id);
      return p ? { ...p, events: p.events.slice(), rate: p.rate.slice() } : null;
    },
    reset() {
      started = false;
      t = 0;
      plays.clear();
      pending = [];
      log.push(['reset']);
      return Promise.resolve();
    },
    pause: async () => {
      api.calls.pause++;
      if (ctx.state === 'running') ctx.state = 'suspended';
    },
    resume: async () => {
      api.calls.resume++;
      if (!api.blocked) ctx.state = 'running';
    },
    setVolume() {},
    on: () => () => {},
    debug: () => ({ strips: plays.size }),
  };
  return api;
}

/** Everything a conductor needs, with knobs for latency and failures. */
function rig(n, opts = {}) {
  const { playlist, analyses } = makeCrate(n, opts);
  const engine = fakeEngine();
  let wall = 0;
  const delay = opts.delay || (() => 0);
  const waiters = [];
  const sleep = (ms) => (ms > 0 ? new Promise((r) => waiters.push({ at: wall + ms, r })) : Promise.resolve());
  const fails = opts.fails || (() => null);
  // decoding / maxDecoding: decodes in flight right now / the most there ever were at once
  const counts = { resolve: 0, fetch: 0, decode: 0, analyze: 0, decoding: 0, maxDecoding: 0 };
  const resolver = {
    async resolveTrack(meta) {
      counts.resolve++;
      const i = Number(meta.id.split(':')[1]);
      await sleep(delay(i, 'resolve'));
      const f = fails(i, 'resolve');
      if (f) throw Object.assign(new Error(`no audio for ${meta.title}`), f);
      return { provider: 'deezer', key: `deezer:${i}`, url: 'https://example.invalid/a.mp3', isPreview: true, matchScore: 1, matchedTitle: meta.title, matchedArtist: meta.artist };
    },
    async fetchAudio(ref) {
      counts.fetch++;
      const i = Number(ref.key.split(':')[1]);
      await sleep(delay(i, 'fetch'));
      const f = fails(i, 'fetch');
      if (f) throw Object.assign(new Error(`could not download ${ref.key}`), f);
      return new Uint8Array([i, 1, 2, 3]).buffer;
    },
  };
  const analyzer = {
    cached: async () => null,
    async analyze(buffer) {
      counts.analyze++;
      await sleep(delay(buffer.index, 'analyze'));
      return analyses[buffer.index];
    },
  };
  const decode = async (bytes) => {
    counts.decode++;
    assert.ok(bytes.byteLength === 4, 'decode must be handed live bytes (a copy), not a detached buffer');
    const i = new Uint8Array(bytes)[0];
    counts.maxDecoding = Math.max(counts.maxDecoding, ++counts.decoding);
    try {
      await sleep(delay(i, 'decode'));
    } finally {
      counts.decoding--;
    }
    return { duration: analyses[i].duration, index: i };
  };
  const conductor = createConductor({ engine, analyzer, resolver, decode, clock: () => wall, timers: false });
  const events = { start: 0, error: [], change: 0, status: [] };
  conductor.on('start', () => events.start++);
  conductor.on('error', (e) => events.error.push(e.message));
  conductor.on('change', () => events.change++);
  conductor.on('status', (s) => events.status.push(s));

  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  };
  /** Advance wall + set clock by `seconds` in 0.2 s steps, poking the conductor like its timer would. */
  const run = async (seconds, step = 0.2) => {
    for (let s = 0; s < seconds - 1e-9; s += step) {
      wall += step * 1000;
      engine.advance(step);
      for (let k = waiters.length - 1; k >= 0; k--) {
        if (waiters[k].at <= wall) waiters.splice(k, 1)[0].r();
      }
      await flush();
      conductor.poke();
      await flush();
    }
  };
  return { playlist, analyses, engine, conductor, events, counts, run, flush };
}

test('starts on an opener from the head of the order and keeps planning one transition ahead', async () => {
  const r = rig(14);
  r.conductor.load(r.playlist, { seed: 'alpha', autostart: true });
  await r.run(1);
  assert.equal(r.events.start, 1);
  assert.equal(r.conductor.started, true);
  const order = r.conductor.debug().order;
  const first = r.conductor.history()[0];
  assert.ok(order.slice(0, 3).includes(first.trackId), 'opener comes from the first three of the base order');
  assert.equal(first.type, 'fadeIn');

  await r.run(100);
  const h = r.conductor.history();
  assert.ok(h.length >= 5, `expected at least 5 plays in 100 s, got ${h.length}`);
  for (let i = 1; i < h.length; i++) {
    assert.equal(h[i].playId, i);
    assert.ok(!h[i].degraded, `play ${i} (${h[i].type}) was planned late`);
    assert.ok(h[i].tStart >= h[i - 1].tEnd - 1e-6, 'a transition never starts before the previous one ended');
    assert.notEqual(h[i].trackId, h[i - 1].trackId);
  }
  assert.equal(new Set(h.map((x) => x.trackId)).size, h.length, 'no repeats inside the first pass');
  // engine received every play once, in order
  const added = r.engine.log.filter((l) => l[0] === 'addPlay').map((l) => l[1]);
  assert.deepEqual(added, h.map((x) => x.playId));
});

test('same seed → same tracks and transitions; another seed → another set', async () => {
  const sets = [];
  for (const seed of ['bravo', 'bravo', 'charlie']) {
    const r = rig(16, { delay: (i, what) => (what === 'fetch' ? 40 + (i % 3) * 30 : 10) });
    r.conductor.load(r.playlist, { seed, autostart: true });
    await r.run(110);
    sets.push(r.conductor.history().slice(0, 5).map((x) => `${x.trackId}/${x.type}/${x.beats}`));
  }
  assert.equal(sets[0].length, 5);
  assert.deepEqual(sets[0], sets[1]);
  assert.notDeepEqual(sets[0], sets[2]);
});

test('begin() gates playback: a share link prepares but waits for the tap', async () => {
  const r = rig(8);
  r.conductor.load(r.playlist, { seed: 'delta', autostart: false });
  await r.run(3);
  assert.equal(r.conductor.started, false);
  assert.ok(r.conductor.snapshot().stats.ready >= 3, 'tracks are prepared while waiting');
  assert.equal(r.events.status.at(-1).detail, 'Ready when you are.');
  r.conductor.begin();
  await r.run(0.4);
  assert.equal(r.conductor.started, true);
});

test('failed tracks are skipped and reported; a crate with nothing playable is a clear error', async () => {
  const bad = new Set([1, 4, 6, 9]);
  const r = rig(12, { fails: (i) => (bad.has(i) ? { code: 'no-match', final: true } : null) });
  r.conductor.load(r.playlist, { seed: 'echo', autostart: true });
  await r.run(120);
  const h = r.conductor.history();
  assert.ok(h.length >= 5);
  for (const p of h) assert.ok(!bad.has(Number(p.trackId.split(':')[1])), `${p.trackId} has no audio and must not play`);
  const snap = r.conductor.snapshot();
  assert.equal(snap.stats.failed, 4);
  assert.equal(snap.setlist.filter((x) => x.state === 'failed').length, 4);
  assert.equal(r.events.error.length, 0);

  const none = rig(6, { fails: () => ({ code: 'no-match', final: true }) });
  none.conductor.load(none.playlist, { seed: 'echo', autostart: true });
  await none.run(3);
  assert.equal(none.conductor.started, false);
  assert.equal(none.events.error.length, 1);
  assert.match(none.events.error[0], /playable previews/);

  const offline = rig(6, { fails: () => ({ code: 'network' }) });
  offline.conductor.load(offline.playlist, { seed: 'echo', autostart: true });
  await offline.run(40);
  assert.equal(offline.events.error.length, 1);
  assert.match(offline.events.error[0], /connection/);
});

test('slow network: the set starts late, then the next track enters through the late path', async () => {
  // Only the first three tracks arrive quickly; the rest take 45 s each.
  const r = rig(10, { delay: (i, what) => (what === 'fetch' ? 45000 : 0) });
  r.conductor.load(r.playlist, { seed: 'foxtrot', autostart: true });
  await r.run(40);
  assert.equal(r.conductor.started, false, 'nothing can start before a track has arrived');
  await r.run(100);
  const h = r.conductor.history();
  assert.ok(h.length >= 2, 'the set carries on once tracks arrive');
  assert.equal(r.events.error.length, 0);
});

test('Skip cancels the pending plan and makes a quick transition into the same next track', async () => {
  const r = rig(14);
  r.conductor.load(r.playlist, { seed: 'golf', autostart: true });
  await r.run(9);
  let h = r.conductor.history();
  assert.equal(h.length, 2, 'next transition is planned early');
  const planned = h[1];
  assert.ok(planned.tStart > r.engine.now() + 5, 'and lies well ahead');
  assert.equal(r.conductor.snapshot().canSkip, true);
  const t = r.engine.now();
  assert.equal(r.conductor.skip(), true);
  await r.flush();
  h = r.conductor.history();
  assert.equal(h.length, 2);
  assert.equal(h[1].trackId, planned.trackId, 'Skip goes to the track that was announced');
  assert.ok(h[1].tStart >= t + 0.25 && h[1].tStart < t + 3, `quick transition starts right away (${(h[1].tStart - t).toFixed(2)} s)`);
  assert.ok(h[1].tEnd - h[1].tStart < 4);
  assert.ok(r.engine.log.some((l) => l[0] === 'cancelFrom'));
  // While the quick transition runs there are two tracks in the air: no Skip.
  await r.run(h[1].tStart - r.engine.now() + 0.2);
  assert.equal(r.conductor.snapshot().canSkip, false);
  assert.equal(r.conductor.skip(), false);
  await r.run(30);
  assert.ok(r.conductor.history().length >= 3, 'the set continues after a Skip');
});

test('new set: different seed, stale work from the old set is ignored', async () => {
  const r = rig(14, { delay: (i, what) => (what === 'fetch' ? 300 : 0) });
  r.conductor.load(r.playlist, { seed: 'hotel', autostart: true });
  await r.run(30);
  const before = r.conductor.history().map((x) => x.trackId);
  const orderBefore = r.conductor.debug().order;
  r.conductor.newSet('india');
  r.conductor.newSet('juliett'); // twice in a row, mid-flight
  await r.run(20);
  assert.equal(r.conductor.seed, 'juliett');
  const h = r.conductor.history();
  assert.equal(h[0].playId, 0);
  assert.equal(h[0].type, 'fadeIn');
  assert.notDeepEqual(r.conductor.debug().order, orderBefore);
  assert.ok(before.length >= 2);
  assert.equal(r.events.start, 2, 'one start per set that actually began');
  assert.ok(r.engine.log.filter((l) => l[0] === 'reset').length >= 2);
});

test('stop() abandons everything; a later load starts clean', async () => {
  const r = rig(10, { delay: () => 500 });
  r.conductor.load(r.playlist, { seed: 'kilo', autostart: true });
  await r.run(0.6);
  r.conductor.stop();
  await r.run(5);
  assert.equal(r.conductor.started, false);
  assert.equal(r.conductor.snapshot().loaded, false);
  assert.equal(r.events.start, 0);
  r.conductor.load(r.playlist, { seed: 'kilo', autostart: true });
  await r.run(5);
  assert.equal(r.conductor.started, true);
});

test('endless: a small crate keeps going without playing a track twice in a row', async () => {
  const r = rig(3);
  r.conductor.load(r.playlist, { seed: 'lima', autostart: true });
  await r.run(260);
  const h = r.conductor.history();
  assert.ok(h.length >= 9, `expected 9+ plays from 3 tracks, got ${h.length}`);
  for (let i = 1; i < h.length; i++) assert.notEqual(h[i].trackId, h[i - 1].trackId);
  assert.equal(new Set(h.map((x) => x.trackId)).size, 3);
  assert.ok(r.conductor.debug().cycle >= 2);
});

test('memory: decoded buffers and compressed bytes stay bounded over a long set', async () => {
  const r = rig(40);
  r.conductor.load(r.playlist, { seed: 'mike', autostart: true });
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    await r.run(10);
    worst = Math.max(worst, r.conductor.debug().buffers);
  }
  const d = r.conductor.debug();
  assert.ok(r.conductor.history().length >= 10);
  assert.ok(worst <= 6, `decoded buffers peaked at ${worst}`);
  assert.ok(d.bytes <= 4 * (WINDOW + 4), `compressed audio kept for ${d.bytes / 4} tracks`);
  assert.ok(d.activePlays <= 3);
});

test('setlist rows: stable keys, one playing row, states follow the mix', async () => {
  const r = rig(12);
  r.conductor.load(r.playlist, { seed: 'november', autostart: true });
  await r.run(12);
  const snap = r.conductor.snapshot();
  const keys = snap.setlist.map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(snap.setlist.filter((x) => x.state === 'playing').length, 1);
  assert.equal(snap.setlist.filter((x) => x.state === 'next').length, 1);
  assert.equal(snap.setlist.length, 12);
  assert.ok(snap.transition && snap.transition.state === 'upcoming');
  assert.ok(snap.decks[0] && snap.decks[0].title === snap.setlist.find((x) => x.state === 'playing').title);
  // into the transition: outgoing still "playing", incoming "mixing"
  const tr = r.conductor.history()[1];
  await r.run(tr.tStart - r.engine.now() + 0.4);
  const mid = r.conductor.snapshot();
  if (tr.tEnd - tr.tStart > 1) {
    assert.equal(mid.transition.state, 'active');
    assert.equal(mid.setlist.filter((x) => x.state === 'mixing').length, 1);
  }
});

test('nextCycleOrder keeps recent tracks away from the front; trickWindows finds mid-solo moves', () => {
  const alive = Array.from({ length: 10 }, (_, i) => `t:${i}`);
  const recent = ['t:1', 't:2', 't:3', 't:4'];
  for (let c = 1; c < 30; c++) {
    const o = nextCycleOrder('s', c, alive, ['t:9'], recent);
    assert.equal(o.length, 9);
    assert.ok(!o.includes('t:9'));
    assert.ok(o.slice(0, 5).every((id) => !recent.includes(id)));
  }
  assert.deepEqual(nextCycleOrder('s', 1, ['a'], [], ['a']), ['a']);

  const tr = {
    tStart: 20,
    aEvents: [
      { p: 'lpf', t: 8, v: 20000, k: 'set' },
      { p: 'lpf', t: 9, v: 500, k: 'exp' },
      { p: 'lpf', t: 10, v: 20000, k: 'exp' },
      { p: 'gain', t: 20, v: 1, k: 'set' },
      { p: 'gain', t: 24, v: 0, k: 'lin' },
    ],
    fx: [],
    marks: [{ t: 8, label: 'Filter dip' }, { t: 20, label: 'Mix in' }],
  };
  assert.deepEqual(trickWindows(tr), [{ t0: 8, t1: 10, label: 'Filter dip' }]);
  assert.deepEqual(trickWindows({ tStart: 5, aEvents: [{ p: 'gain', t: 4.9, v: 1, k: 'set' }, { p: 'gain', t: 4.93, v: 1, k: 'lin' }], fx: [], marks: [] }), []);
});

// ── transport: `paused` follows the real AudioContext ────────────────────────────────────────────

test('the browser stops the audio by itself: the set reads paused, and one Play brings it back', async () => {
  const r = rig(14);
  r.conductor.load(r.playlist, { seed: 'oscar', autostart: true });
  await r.run(8);
  assert.equal(r.conductor.snapshot().playing, true);

  // a phone call, another app's audio … (iOS reports 'interrupted', never 'suspended')
  r.engine.ctx.state = 'interrupted';
  r.conductor.audioState();
  let s = r.conductor.snapshot();
  assert.equal(s.playing, false, 'a set whose context is not running is not playing');
  assert.equal(r.conductor.paused, true);
  assert.equal(r.conductor.pausedByUser, false);
  assert.equal(s.canSkip, false);

  // one tap on the button, which now says Play: main.js calls resume()
  const plays = r.conductor.history().length;
  await r.conductor.resume();
  assert.equal(r.engine.ctx.state, 'running');
  assert.equal(r.conductor.snapshot().playing, true);
  await r.run(60);
  assert.ok(r.conductor.history().length > plays, 'planning carries on after the interruption');

  // an interruption that ends on its own resumes on its own — unless the user had paused
  r.engine.ctx.state = 'suspended';
  r.conductor.audioState();
  assert.equal(r.conductor.paused, true);
  r.engine.ctx.state = 'running';
  r.conductor.audioState();
  assert.equal(r.conductor.paused, false);

  // no 'statechange' forwarded at all: the next tick notices
  r.engine.ctx.state = 'suspended';
  r.conductor.poke();
  assert.equal(r.conductor.snapshot().playing, false);
  r.engine.ctx.state = 'running';
  r.conductor.poke();
  assert.equal(r.conductor.snapshot().playing, true);
});

test("the engine's 'statechange' reaches the conductor by itself: no tick, no page wiring needed", async () => {
  const r = rig(14);
  // an engine as engine.js is: on('statechange') and a `state` that answers without touching `ctx`
  const heard = new Set();
  let unsubscribed = 0;
  r.engine.on = (type, fn) => {
    if (type !== 'statechange') return () => {};
    heard.add(fn);
    return () => {
      unsubscribed++;
      heard.delete(fn);
    };
  };
  let ctxReads = 0;
  const ctx = r.engine.ctx;
  Object.defineProperty(r.engine, 'state', { get: () => ctx.state });
  Object.defineProperty(r.engine, 'ctx', {
    get() {
      ctxReads++;
      return ctx;
    },
  });
  const says = (state) => {
    ctx.state = state;
    for (const fn of [...heard]) fn({ state });
  };

  r.conductor.load(r.playlist, { seed: 'oscar', autostart: true });
  assert.equal(heard.size, 1, 'subscribed when the crate is loaded, once');
  await r.run(8);
  assert.equal(r.conductor.snapshot().playing, true);
  assert.equal(ctxReads, 0, 'the context is never read (reading it would create one before the first tap)');

  let changes = r.events.change;
  says('interrupted');
  assert.equal(r.conductor.paused, true, 'held as soon as the engine says so');
  assert.equal(r.conductor.pausedByUser, false);
  assert.ok(r.events.change > changes, 'and the page is told (the button turns to Play)');
  changes = r.events.change;
  says('running');
  assert.equal(r.conductor.paused, false, 'an interruption that ends by itself resumes by itself');
  assert.ok(r.events.change > changes);

  // a resume that lands after the user pressed Pause is held again
  await r.conductor.pause();
  says('running');
  await r.flush();
  assert.equal(r.conductor.paused, true);
  assert.equal(ctx.state, 'suspended');

  // loading another crate does not subscribe twice; destroy() lets go
  r.conductor.load(r.playlist, { seed: 'oscar2', autostart: true });
  assert.equal(heard.size, 1);
  r.conductor.destroy();
  assert.equal(heard.size, 0);
  assert.equal(unsubscribed, 1);
});

test('a user pause holds whatever the context does; a refused resume does not claim to play', async () => {
  const r = rig(14);
  r.conductor.load(r.playlist, { seed: 'papa', autostart: true });
  await r.run(8);
  await r.conductor.pause();
  assert.equal(r.engine.ctx.state, 'suspended');
  assert.equal(r.conductor.pausedByUser, true);
  const t = r.engine.now();

  // something else wakes the context (a resume that was still pending, a tap on another control)
  r.engine.ctx.state = 'running';
  r.conductor.audioState();
  await r.flush();
  assert.equal(r.engine.ctx.state, 'suspended', 'the conductor holds the engine again');
  assert.equal(r.conductor.snapshot().playing, false);
  await r.run(2);
  assert.equal(r.engine.now(), t, 'set time stays frozen');

  // Play where the browser will not resume (no gesture, interruption still on): still paused, not by the user
  r.engine.blocked = true;
  await r.conductor.resume();
  assert.equal(r.conductor.snapshot().playing, false);
  assert.equal(r.conductor.pausedByUser, false);
  r.engine.blocked = false;
  await r.conductor.resume();
  assert.equal(r.conductor.snapshot().playing, true);

  // resume() asks the engine even when the conductor believed the set was running
  const asked = r.engine.calls.resume;
  await r.conductor.resume();
  assert.equal(r.engine.calls.resume, asked + 1);

  // Pause and Play in quick succession: the suspend that was still on its way does not win
  let release;
  const slow = new Promise((res) => (release = res));
  const realPause = r.engine.pause;
  r.engine.pause = async () => {
    await slow;
    return realPause();
  };
  const p1 = r.conductor.pause();
  const p2 = r.conductor.resume();
  release();
  await Promise.all([p1, p2]);
  r.conductor.audioState();
  assert.equal(r.engine.ctx.state, 'running');
  assert.equal(r.conductor.snapshot().playing, true);
});

test('a set whose audio the browser would not start is cued, not playing', async () => {
  const r = rig(8);
  r.engine.ctx.state = 'suspended'; // no user gesture: Safari after its file picker, any browser after a drop
  r.engine.blocked = true;
  r.conductor.load(r.playlist, { seed: 'quebec', autostart: true });
  await r.run(2);
  assert.equal(r.events.start, 1);
  const s = r.conductor.snapshot();
  assert.equal(s.started, true);
  assert.equal(s.playing, false, 'nothing is playing: the context never ran');
  assert.equal(r.conductor.paused, true);
  assert.equal(r.conductor.pausedByUser, false);
  assert.equal(r.engine.now(), -0.15, 'the set waits at its very beginning');
  // the tap
  r.engine.blocked = false;
  await r.conductor.resume();
  assert.equal(r.conductor.snapshot().playing, true);
  await r.run(3);
  assert.ok(r.engine.now() > 2);
});

// ── endless: every pass plays every track ────────────────────────────────────────────────────────

test('endless: no track is starved, and a small crate goes round in order', async () => {
  // Ten tracks around 122 BPM and two the planner never favours (far slower): they still get their turn.
  const bpms = [120, 124, 126, 122, 98, 128, 121, 125, 96, 123, 127, 119];
  const r = rig(12, { bpms });
  r.conductor.load(r.playlist, { seed: 'romeo', autostart: true });
  /** @type {string[]} every play of the set (history() only remembers the last 60) */
  const h = [];
  for (let k = 0; k < 100; k++) {
    await r.run(10);
    for (const x of r.conductor.history()) if (x.playId === h.length) h.push(x.trackId);
  }
  assert.ok(h.length >= 40, `expected 40+ plays in 17 minutes, got ${h.length}`);
  assert.equal(new Set(h.slice(0, 12)).size, 12, `the first pass plays all twelve: ${h.slice(0, 12).join(' ')}`);
  const count = new Map(r.playlist.tracks.map((t) => [t.id, 0]));
  const last = new Map();
  let gap = 0;
  h.forEach((id, i) => {
    assert.notEqual(id, h[i - 1]);
    count.set(id, count.get(id) + 1);
    if (last.has(id)) gap = Math.max(gap, i - last.get(id));
    last.set(id, i);
  });
  const tally = [...count.values()];
  assert.ok(Math.max(...tally) - Math.min(...tally) <= 1, `plays per track range from ${Math.min(...tally)} to ${Math.max(...tally)} (${[...count].map(([id, n]) => `${id}×${n}`).join(' ')})`);
  assert.ok(gap < 24, `a track waited ${gap} plays for its next turn`);
  for (let p = 0; p + 12 <= h.length; p += 12) assert.equal(new Set(h.slice(p, p + 12)).size, 12, `pass ${p / 12} plays every track once: ${h.slice(p, p + 12).join(' ')}`);

  for (const n of [2, 3, 4, 6]) {
    const s = rig(n);
    s.conductor.load(s.playlist, { seed: `sierra${n}`, autostart: true });
    await s.run(60 + n * 75);
    const g = s.conductor.history().map((x) => x.trackId);
    assert.ok(g.length >= 3 * n, `${n} tracks: ${g.length} plays`);
    for (let p = 0; p + n <= g.length; p += n) assert.equal(new Set(g.slice(p, p + n)).size, n, `${n} tracks, pass ${p / n}: ${g.slice(p, p + n).join(' ')}`);
    for (let i = 1; i < g.length; i++) assert.notEqual(g[i], g[i - 1], `${n} tracks: the same track twice in a row`);
    if (n >= 3) for (let i = 2; i < g.length; i++) assert.notEqual(g[i], g[i - 2], `${n} tracks: A-B-A at play ${i}`);
  }
});

// ── Track length / Vibe reach the transition that is already announced ───────────────────────────

test('full-length set: changing Track length re-plans the announced transition; Vibe too, once the slider rests', async () => {
  const r = rig(6, { source: 'local', duration: 300, bpms: [120, 122, 124, 121, 123, 125] });
  r.conductor.load(r.playlist, { seed: 'tango', mode: 'full', autostart: true });
  await r.run(10);
  let h = r.conductor.history();
  assert.equal(h.length, 2);
  const before = h[1];
  assert.ok(before.tStart > 200, `Full: the exit is planned near the end (${before.tStart.toFixed(1)} s)`);

  r.conductor.setMode('short');
  await r.run(1);
  h = r.conductor.history();
  assert.equal(r.conductor.snapshot().mode, 'short');
  assert.equal(h.length, 2);
  assert.equal(h[1].trackId, before.trackId, 'same incoming track');
  assert.equal(h[1].playId, 1);
  assert.ok(h[1].tStart < 70, `Short: the exit moved up to ${h[1].tStart.toFixed(1)} s (was ${before.tStart.toFixed(1)})`);
  assert.ok(h[1].tStart > r.engine.now(), 'and still lies ahead');
  assert.equal(r.engine.log.filter((l) => l[0] === 'cancelFrom').length, 1);
  assert.equal(new Set(r.conductor.snapshot().setlist.map((x) => x.key)).size, r.conductor.snapshot().setlist.length, 'setlist keys stay unique');
  assert.equal(r.conductor.snapshot().setlist.filter((x) => x.state === 'next').length, 1);

  // the same choice again changes nothing
  r.conductor.setMode('short');
  await r.run(1);
  assert.equal(r.engine.log.filter((l) => l[0] === 'cancelFrom').length, 1);

  // Vibe: a drag is many events — one re-plan, after it has settled
  for (const v of [0.6, 0.7, 0.8, 0.9, 1]) r.conductor.setVibe(v);
  assert.equal(r.engine.log.filter((l) => l[0] === 'cancelFrom').length, 1, 'not on every slider event');
  await r.run(1.4);
  assert.equal(r.engine.log.filter((l) => l[0] === 'cancelFrom').length, 2);
  assert.equal(r.conductor.history()[1].trackId, before.trackId);

  // A transition that is about to begin (or running) stands as planned; the set carries on
  const tr = r.conductor.history()[1];
  await r.run(tr.tStart - r.engine.now() - 0.2);
  r.conductor.setMode('medium');
  await r.run(1);
  assert.equal(r.conductor.history()[1].tStart, tr.tStart);
  assert.equal(r.engine.log.filter((l) => l[0] === 'cancelFrom').length, 2);
  await r.run(120);
  assert.ok(r.conductor.history().length >= 3);
  for (const x of r.conductor.history()) assert.ok(!x.degraded);

  // Previews: Vibe never cancels (a shared set must not depend on when the slider was touched)
  const p = rig(14);
  p.conductor.load(p.playlist, { seed: 'tango', autostart: true });
  await p.run(9);
  p.conductor.setVibe(1);
  p.conductor.setMode('short');
  await p.run(3);
  assert.equal(p.engine.log.filter((l) => l[0] === 'cancelFrom').length, 0);
});

// ── preparation bookkeeping ──────────────────────────────────────────────────────────────────────

test('a crate replaced under running decodes: the job counter never goes negative, the limit holds', async () => {
  const r = rig(12, { source: 'local', duration: 300, bpms: [118, 119, 120, 121, 122, 123], delay: (i, what) => (what === 'decode' ? 3000 : what === 'analyze' ? 1000 : 0) });
  r.conductor.load(r.playlist, { seed: 'uniform', autostart: true });
  await r.run(1);
  for (let n = 0; n < 3; n++) {
    r.conductor.stop(); // Cancel on the loading screen …
    await r.run(0.4);
    r.conductor.load(r.playlist, { seed: `uniform${n}`, autostart: true }); // … and the same files again
    await r.run(0.6);
  }
  await r.run(4.2); // the abandoned decodes have all come home
  r.counts.maxDecoding = 0;
  let low = Infinity;
  let loading = 0;
  for (let k = 0; k < 120; k++) {
    await r.run(0.2);
    low = Math.min(low, r.conductor.debug().jobs);
    loading = Math.max(loading, r.conductor.snapshot().setlist.filter((x) => x.state === 'loading').length);
  }
  assert.ok(low >= 0, `job counter went down to ${low}`);
  assert.ok(loading <= 3, `${loading} tracks in preparation at once`);
  assert.ok(r.counts.maxDecoding <= 3, `${r.counts.maxDecoding} decodes in flight at once`);
  assert.equal(r.conductor.started, true);
});

test('New Set while the network is away: nothing is written off, the set goes on with what is in hand', async () => {
  let offline = false;
  const r = rig(40, { fails: () => (offline ? { code: 'network' } : null), delay: (i, what) => (what === 'fetch' ? 300 : 20) });
  r.conductor.load(r.playlist, { seed: 'victor', autostart: true });
  await r.run(12);
  assert.equal(r.conductor.started, true);
  offline = true;
  await r.run(1.5);
  // The worst case: a new order that opens with tracks which have not been downloaded yet.
  const have = new Set(r.conductor.snapshot().setlist.filter((x) => x.bpm).map((x) => x.key.split('|')[0]));
  assert.ok(have.size >= 5 && have.size < 30, `${have.size} tracks in hand`);
  let seed = '';
  for (let k = 0; k < 300 && !seed; k++) {
    const order = createPlanner({ seed: `whiskey${k}` }).order(r.playlist.tracks.map((t) => t.id));
    if (order.slice(0, 5).every((id) => !have.has(id))) seed = `whiskey${k}`;
  }
  assert.ok(seed, 'found an order that opens with unfetched tracks');
  r.conductor.newSet(seed);
  let worstPending = Infinity;
  let restartedAfter = null;
  for (let k = 0; k < 45; k++) {
    await r.run(1);
    const s = r.conductor.snapshot();
    assert.equal(s.stats.failed, 0, `${s.stats.failed} tracks written off ${k + 1} s into the outage`);
    worstPending = Math.min(worstPending, s.stats.pending);
    if (restartedAfter === null && s.started) restartedAfter = k + 1;
  }
  assert.ok(worstPending >= 0, `stats.pending fell to ${worstPending}`);
  assert.ok(restartedAfter !== null && restartedAfter <= 5, `the new set started ${restartedAfter} s after New Set, from tracks already in hand`);
  assert.ok(have.has(r.conductor.history()[0].trackId));
  offline = false;
  await r.run(70);
  const s = r.conductor.snapshot();
  assert.equal(s.stats.failed, 0);
  assert.equal(s.setlist.filter((x) => x.state === 'failed').length, 0);
  assert.equal(r.events.error.length, 0);
  assert.ok(r.conductor.history().length >= 3);
});

test('first load on a dead connection still ends in a clear error; a late success revives what was given up', async () => {
  // nothing ever arrives: three tries per track, then the load fails as a whole
  const dead = rig(20, { fails: () => ({ code: 'network' }) });
  dead.conductor.load(dead.playlist, { seed: 'xray', autostart: true });
  await dead.run(60);
  assert.equal(dead.events.error.length, 1);
  assert.match(dead.events.error[0], /connection/);

  // the first eight seconds are dead, then the network is there: tracks given up on meanwhile come back
  let offline = true;
  const r = rig(20, { fails: () => (offline ? { code: 'network' } : null) });
  r.conductor.load(r.playlist, { seed: 'xray', autostart: true });
  await r.run(13);
  offline = false;
  await r.run(70);
  assert.equal(r.events.error.length, 0);
  assert.equal(r.conductor.started, true);
  assert.equal(r.conductor.snapshot().stats.failed, 0, 'no healthy track stays marked as failed');
});

test('status while nothing can be fetched says it is the connection', async () => {
  let offline = true;
  const r = rig(40, { fails: () => (offline ? { code: 'network' } : null) });
  r.conductor.load(r.playlist, { seed: 'yankee', autostart: true });
  await r.run(3);
  assert.equal(r.conductor.started, false);
  const st = r.conductor.snapshot().status;
  assert.match(st.title, /connection/i, `"${st.title} — ${st.detail}"`);
  assert.equal(st.progress, 0, 'no progress is claimed while every try fails');
  assert.match(r.events.status.at(-1).title, /connection/i, 'and the loading screen is told');
  offline = false;
  await r.run(20);
  assert.equal(r.conductor.started, true);
  assert.equal(r.events.error.length, 0);
});

// ── what the UI is told ──────────────────────────────────────────────────────────────────────────

test('the crate runs dry: the snapshot says the set is waiting (and why), no row is "playing"; it picks up again', async () => {
  // 30 tracks (so played audio is let go), but only the head of the order can be fetched.
  const ids = Array.from({ length: 30 }, (_, i) => `t:${i}`);
  const head = new Set(createPlanner({ seed: 'zulu' }).order(ids).slice(0, 3).map((id) => Number(id.split(':')[1])));
  let offline = true;
  const r = rig(30, { fails: (i) => (offline && !head.has(i) ? { code: 'network' } : null) });
  r.conductor.load(r.playlist, { seed: 'zulu', autostart: true });
  await r.run(20);
  assert.equal(r.conductor.started, true);
  assert.equal(r.conductor.snapshot().stalled, '');
  await r.run(100);
  let s = r.conductor.snapshot();
  assert.equal(s.stalled, 'network', `after ${r.conductor.history().length} plays the crate is dry`);
  assert.equal(s.playing, true, 'the set itself is not paused');
  assert.ok(s.transition && s.transition.state === 'waiting' && /Waiting/.test(s.transition.label), JSON.stringify(s.transition));
  assert.match(s.transition.why, /connection/);
  assert.equal(s.setlist.filter((x) => x.state === 'playing' || x.state === 'mixing').length, 0, 'a track that has ended is not "now"');
  assert.equal(s.stats.failed, 0);
  const t1 = s.transition.tStart;
  await r.run(5);
  assert.equal(r.conductor.snapshot().transition.tStart, t1, 'the waiting state is stable (no repaint per tick)');
  const plays = r.conductor.history().length;
  offline = false;
  await r.run(70);
  s = r.conductor.snapshot();
  assert.equal(s.stalled, '');
  assert.ok(r.conductor.history().length > plays, 'the set picks up when tracks load again');
  assert.equal(s.setlist.filter((x) => x.state === 'playing' || x.state === 'mixing').length >= 1, true);
});

test('a mid-solo trick rides along on the upcoming transition instead of replacing it', async () => {
  let seen = 0;
  for (let k = 0; k < 16 && seen < 2; k++) {
    const r = rig(14);
    r.conductor.load(r.playlist, { seed: `trick${k}`, autostart: true });
    await r.run(2);
    /** @type {{label:string, first:number, last:number, tStart:number, next:number}|null} */
    let cur = null;
    const done = [];
    for (let i = 0; i < 1500; i++) {
      await r.run(0.05, 0.05);
      const s = r.conductor.snapshot();
      const tv = s.transition;
      if (tv) assert.notEqual(tv.type, 'trick', 'a trick is never the transition');
      const tk = tv && tv.trick;
      if (tk) {
        assert.equal(tv.state, 'upcoming');
        assert.ok(tk.label && tv.label && tk.label !== tv.label);
        assert.ok(tv.toTitle, 'what comes next stays announced during the trick');
        if (!cur || cur.tStart !== tk.tStart) cur = { label: tk.label, first: s.now, last: s.now, tStart: tk.tStart, next: tv.tStart };
        cur.last = s.now;
      } else if (cur) {
        done.push(cur);
        cur = null;
      }
    }
    for (const d of done) {
      seen++;
      const shown = d.last - d.first;
      const room = d.next - d.tStart;
      assert.ok(shown >= Math.min(1.8, room - 0.2), `"${d.label}" was announced for ${shown.toFixed(2)} s (${room.toFixed(2)} s before the transition)`);
    }
  }
  assert.ok(seen >= 2, `only ${seen} tricks in 16 sets`);
});

test('small crates: the setlist lists each track once; a lone track is never blended into itself', async () => {
  const r = rig(6, { source: 'local', duration: 120, bpms: [120, 122, 124, 121, 123, 125] });
  r.conductor.load(r.playlist, { seed: 'amber', mode: 'medium', autostart: true });
  await r.run(8);
  let rows = r.conductor.snapshot().setlist;
  assert.equal(rows.length, 6, `6 files, ${rows.length} rows: ${rows.map((x) => `${x.title}/${x.state}`).join(', ')}`);
  assert.equal(new Set(rows.map((x) => x.title)).size, 6);
  assert.ok(rows.every((x) => !x.again));
  // into the second pass: replays are marked, and nothing is listed under itself
  await r.run(6 * 95);
  rows = r.conductor.snapshot().setlist;
  const live = rows.filter((x) => x.state !== 'played');
  assert.equal(new Set(live.map((x) => x.title)).size, live.length, `a track is listed twice among what is on and to come: ${live.map((x) => `${x.title}/${x.state}`).join(', ')}`);
  assert.ok(rows.some((x) => x.again), 'replays carry `again`');

  for (const source of ['deezer', 'local']) {
    const one = rig(1, { source, duration: source === 'local' ? 200 : 30 });
    one.conductor.load(one.playlist, { seed: 'solo', mode: 'medium', autostart: true });
    await one.run(source === 'local' ? 450 : 100);
    const h = one.conductor.history();
    assert.ok(h.length >= 3, `${source}: a single track keeps going (${h.length} plays)`);
    for (const x of h.slice(1)) {
      assert.ok(!['bassSwap', 'eqBlend', 'filterBlend', 'reverbWash'].includes(x.type), `${source}: the track was laid over itself (${x.label})`);
      assert.equal(x.synced, false);
    }
    // full-length: it plays out before it starts over, whatever Track length says
    if (source === 'local') assert.ok(h[1].tStart > 150, `restart at ${h[1].tStart.toFixed(0)} s of a 200 s file`);
    const list = one.conductor.snapshot().setlist.filter((x) => x.state !== 'played');
    assert.ok(list.length <= 2, `${source}: ${list.length} rows for one track: ${list.map((x) => x.state).join(', ')}`);
    assert.equal(list.filter((x) => x.state === 'queued').length, 0);
  }
});

test('share-link sets wait for the whole head before choosing the opener (within reason)', async () => {
  const ids = Array.from({ length: 16 }, (_, i) => `t:${i}`);
  const headIdx = createPlanner({ seed: 'bravo2' }).order(ids).slice(0, 3).map((id) => Number(id.split(':')[1]));
  const opener = async (opts, slow) => {
    const r = rig(16, { delay: (i, what) => (what === 'fetch' && slow.includes(i) ? slow.ms : 10) });
    r.conductor.load(r.playlist, { seed: 'bravo2', autostart: true, ...opts });
    let startedAt = null;
    for (let k = 0; k < 150 && startedAt === null; k++) {
      await r.run(0.2);
      if (r.conductor.started) startedAt = (k + 1) * 0.2;
    }
    return { id: r.conductor.history()[0].trackId, startedAt };
  };
  const quick = await opener({ patient: true }, Object.assign([], { ms: 0 }));
  // each head track in turn arrives six seconds late: the opener is the same every time
  for (const i of headIdx) {
    const late = await opener({ patient: true }, Object.assign([i], { ms: 6000 }));
    assert.equal(late.id, quick.id, `opener with track ${i} six seconds late`);
  }
  // but a track that does not arrive at all does not hold the start for ever
  const never = await opener({ patient: true }, Object.assign([headIdx[0]], { ms: 600000 }));
  assert.ok(never.startedAt !== null && never.startedAt <= 11, `started after ${never.startedAt} s`);
  // a set of one's own starts as soon as it reasonably can
  const own = await opener({}, Object.assign([headIdx[0]], { ms: 600000 }));
  assert.ok(own.startedAt <= 4, `started after ${own.startedAt} s`);
});

test('deckFrameAt: a deck that is not sounding shows its fader down', () => {
  const an = synthAnalysis({ bpm: 120, duration: 30 });
  const play = {
    id: 1,
    trackId: 't:1',
    deck: 1,
    startAt: 20,
    offset: 0.1,
    rate: [{ t: 20, v: 1.02 }],
    trimDb: 0,
    events: [
      { p: 'gain', t: 19.99, v: 0, k: 'set' },
      { p: 'low', t: 19.99, v: -28, k: 'set' },
      { p: 'gain', t: 24, v: 1, k: 'lin' },
      { p: 'low', t: 24, v: 0, k: 'lin' },
    ],
    endAt: null,
    soloFrom: 24,
  };
  const df = { pos: 0, rate: 1, bpmNow: 0, gain: 0, low: 0, mid: 0, high: 0, hpf: 20, lpf: 20000, audible: 0, startsIn: 0 };
  assert.equal(deckFrameAt(df, play, an, 5), false); // cued: the automation has not begun, the default fader value is 1
  assert.equal(df.gain, 0);
  assert.equal(df.audible, 0);
  assert.equal(df.startsIn, 15, 'a cued deck says how long until it starts (the view counts it down)');
  deckFrameAt(df, play, an, 19.75);
  assert.ok(Math.abs(df.startsIn - 0.25) < 1e-9);
  deckFrameAt(df, play, an, 20);
  assert.equal(df.startsIn, 0, 'running: no countdown');
  assert.ok(Math.abs(df.bpmNow - 122.4) < 1e-9);
  assert.equal(deckFrameAt(df, play, an, 22), true);
  assert.ok(Math.abs(df.gain - 0.5) < 0.01 && df.audible > 0 && df.audible < 0.5);
  assert.equal(deckFrameAt(df, play, an, 30), true);
  assert.equal(df.gain, 1);
  assert.ok(df.audible > 0.95);
  // stopped (faded out, or its audio ran out): down again
  assert.equal(deckFrameAt(df, { ...play, endAt: 40 }, an, 41), false);
  assert.equal(df.gain, 0);
  assert.equal(df.startsIn, 0, 'stopped is not cued');
  assert.equal(deckFrameAt(df, play, an, 60), false);
  assert.equal(df.gain, 0);
});

test('canSkip() is the same answer the snapshot gives, without building one', async () => {
  const r = rig(14);
  r.conductor.load(r.playlist, { seed: 'golf', autostart: true });
  assert.equal(r.conductor.canSkip(), false);
  for (let i = 0; i < 300; i++) {
    await r.run(0.1, 0.1);
    assert.equal(r.conductor.canSkip(), r.conductor.snapshot().canSkip);
  }
});

test('handed over from full songs: the songs it played are not played again, they show as played, and Elapsed goes on', async () => {
  const r = rig(10);
  r.conductor.load(r.playlist, { seed: 'carry1', autostart: false });
  const plain = r.conductor.debug().order;
  const heard = [plain[0], plain[1], plain[2]];
  r.conductor.load(r.playlist, { seed: 'carry1', autostart: true, carry: { played: heard, elapsed: 372 } });
  let s = r.conductor.snapshot();
  assert.deepEqual(
    s.setlist.slice(0, 3).map((x) => [x.key, x.state]),
    heard.map((id, i) => [`${id}|c${i}`, 'played']),
    'the songs the full-song set played lead the setlist as played rows',
  );
  assert.equal(s.setlist.length, 10, 'each track listed once');
  assert.equal(s.elapsed, 372, 'Elapsed starts where the full-song set was');
  await r.run(80);
  const h = r.conductor.history();
  assert.ok(h.length >= 5, `${h.length} plays`);
  const firstPass = h.slice(0, 10 - heard.length).map((x) => x.trackId);
  for (const id of heard) assert.ok(!firstPass.includes(id), `${id} is not played again in this pass`);
  assert.ok(plain.slice(3, 6).includes(h[0].trackId), 'the opener comes from the head of what is left of the order');
  s = r.conductor.snapshot();
  assert.ok(Math.abs(s.elapsed - (372 + s.now)) < 1e-9, `Elapsed goes on (${s.elapsed} at set time ${s.now})`);
  assert.equal(r.conductor.elapsedAt(10), 382, 'the per-frame Elapsed adds the same carried time');
  assert.deepEqual(s.setlist.filter((x) => /\|c\d+$/.test(x.key)).map((x) => x.state), ['played', 'played', 'played']);
  // the next pass: the carried songs come round again (they are in it, as queued or played rows)
  for (let k = 0; k < 60 && r.conductor.history().length <= 10 - heard.length; k++) await r.run(5);
  const later = r.conductor.snapshot().setlist.filter((x) => !/\|c\d+$/.test(x.key)).map((x) => x.key.split('|')[0]);
  for (const id of heard) assert.ok(later.includes(id), `${id} is in the next pass`);
  // New Set: a set of its own (no carried rows, Elapsed from 0)
  r.conductor.newSet('carry2');
  await r.run(2);
  s = r.conductor.snapshot();
  assert.ok(!s.setlist.some((x) => /\|c\d+$/.test(x.key)), 'a new set starts its own history');
  assert.ok(s.elapsed < 3, `Elapsed restarts (${s.elapsed})`);
});

test('a hand-over (the full-song set plays on until the previews sound): Elapsed runs on through the wait, then goes on with set time', async () => {
  const r = rig(8, { delay: () => 900 }); // the first previews take a few seconds to get ready
  r.conductor.load(r.playlist, { seed: 'carry3', autostart: true, carry: { played: [], elapsed: 100, at: 0, live: true } });
  await r.run(1);
  assert.equal(r.conductor.started, false);
  const waiting = r.conductor.snapshot().elapsed;
  assert.ok(Math.abs(waiting - 101) < 0.05, `the wait counts while the other set plays on (${waiting})`);
  for (let k = 0; k < 40 && !r.conductor.started; k++) await r.run(0.2);
  assert.equal(r.conductor.started, true);
  await r.run(0.4); // (set time starts just below 0)
  const s = r.conductor.snapshot();
  const wait = s.elapsed - 100 - s.now;
  assert.ok(wait > 1 && wait < 10, `Elapsed = 100 + the wait + set time (wait ${wait.toFixed(2)} s)`);
  await r.run(5);
  const later = r.conductor.snapshot();
  assert.ok(Math.abs(later.elapsed - s.elapsed - (later.now - s.now)) < 1e-6, 'after the start it follows set time only (the wait is not counted twice)');
  // a plain swap (nothing was playing): the wait does not count
  const q = rig(8, { delay: () => 900 });
  q.conductor.load(q.playlist, { seed: 'carry3', autostart: true, carry: { played: [], elapsed: 100, at: 0, live: false } });
  await q.run(1);
  assert.equal(q.conductor.snapshot().elapsed, 100);
});

// The conductor's state machine, driven with a fake engine / resolver / analyzer and a hand-cranked
// clock (no audio, no network, no timers): what gets planned, in which order, and what happens when
// tracks fail, the network is slow, Skip is pressed or a new set starts under running work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConductor, nextCycleOrder, trickWindows, WINDOW } from '../js/dj/conductor.js';
import { holdPlayAt } from '../js/dj/planner.js';
import { synthAnalysis } from './helpers/dj-synth.js';

const BPMS = [120, 124, 126, 122, 98, 128, 121, 125, 100, 123, 127, 119, 140, 124, 126, 90];

function makeCrate(n) {
  const tracks = [];
  const analyses = [];
  for (let i = 0; i < n; i++) {
    tracks.push({ id: `t:${i}`, title: `Track ${i}`, artist: `Artist ${i % 7}` });
    analyses.push(synthAnalysis({ bpm: BPMS[i % BPMS.length], duration: 30, first: 0.1 + (i % 5) * 0.03, pc: (i * 5) % 12, mode: i % 2 ? 'minor' : 'major', energy: 0.4 + (i % 6) * 0.1 }));
  }
  return { playlist: { id: 'deezer:chart:0', source: 'deezer', title: 'Test crate', tracks }, analyses };
}

function fakeEngine() {
  let t = 0;
  let started = false;
  const plays = new Map();
  const log = [];
  let pending = [];
  const api = {
    log,
    plays,
    ctx: { state: 'running' },
    now: () => (started ? t : 0),
    advance(dt) {
      if (started) t += dt;
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
    pause: async () => {},
    resume: async () => {},
    setVolume() {},
    on: () => () => {},
    debug: () => ({ strips: plays.size }),
  };
  return api;
}

/** Everything a conductor needs, with knobs for latency and failures. */
function rig(n, opts = {}) {
  const { playlist, analyses } = makeCrate(n);
  const engine = fakeEngine();
  let wall = 0;
  const delay = opts.delay || (() => 0);
  const waiters = [];
  const sleep = (ms) => (ms > 0 ? new Promise((r) => waiters.push({ at: wall + ms, r })) : Promise.resolve());
  const fails = opts.fails || (() => null);
  const counts = { resolve: 0, fetch: 0, decode: 0, analyze: 0 };
  const resolver = {
    async resolveTrack(meta) {
      counts.resolve++;
      const i = Number(meta.id.split(':')[1]);
      await sleep(delay(i, 'resolve'));
      const f = fails(i);
      if (f) throw Object.assign(new Error(`no audio for ${meta.title}`), f);
      return { provider: 'deezer', key: `deezer:${i}`, url: 'https://example.invalid/a.mp3', isPreview: true, matchScore: 1, matchedTitle: meta.title, matchedArtist: meta.artist };
    },
    async fetchAudio(ref) {
      counts.fetch++;
      const i = Number(ref.key.split(':')[1]);
      await sleep(delay(i, 'fetch'));
      return new Uint8Array([i, 1, 2, 3]).buffer;
    },
  };
  const analyzer = {
    cached: async () => null,
    async analyze(buffer) {
      counts.analyze++;
      return analyses[buffer.index];
    },
  };
  const decode = async (bytes) => {
    counts.decode++;
    assert.ok(bytes.byteLength === 4, 'decode must be handed live bytes (a copy), not a detached buffer');
    const i = new Uint8Array(bytes)[0];
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

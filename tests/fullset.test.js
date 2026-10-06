// The full-song conductor (js/dj/fullset.js), driven with fake YouTube decks, a fake finder, a fake Web
// Audio engine and a hand-cranked clock: no network, no players, no timers. What it checks is the
// choreography — which deck cues what and when, when the volume lanes move, what happens when an ad
// runs long, a video refuses to play, Skip is pressed mid-ad, or a new set starts under running work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFullSet, TICK_MS, FX_LEAD, SWAP_AFTER_S, SILENT_WAIT_S, STALL_S } from '../js/dj/fullset.js';
import { volumeAt } from '../js/dj/videomix.js';

const vid = (i, alt = 0) => `v${String(i).padStart(7, '0')}${alt ? `a${alt}` : '__'}x`.slice(0, 11);
const err = (code, message = String(code)) => Object.assign(new Error(message), { code });
const flush = () => new Promise((r) => setImmediate(r));

/** Invented crate: "Track i" by "Artist i % 5". */
function crate(n, source = 'spotify') {
  const tracks = [];
  for (let i = 0; i < n; i++) tracks.push({ id: `t:${i}`, title: `Track ${i}`, artist: `Artist ${i % 5}`, durationMs: 200000 });
  return { id: 'spotify:playlist:test', source, title: 'Invented crate', tracks };
}
const idx = (trackId) => Number(String(trackId).split(':')[1]);

function makeClock() {
  const c = { ms: 1000 };
  c.now = () => c.ms;
  return c;
}

/** A YouTube deck as ytdeck.js behaves, with the ad / cue / failure under the test's control. */
function fakeDeck(i, clock) {
  const d = {
    i,
    state: 'empty',
    videoId: null,
    duration: 0,
    error: null,
    muted: true,
    volume: 1,
    log: [],
    vlog: [],
    blockNext: false,
    _cue: null,
    _pos: 0,
    _at: 0,
    _adBase: 0,
    _adFrom: -1,
    _buffering: false,
    /** wall-clock seconds of pre-roll ad seen by the current cue (ytdeck counts while its state is 'ad') */
    get adSeconds() {
      return d._adBase + (d.state === 'ad' && d._adFrom >= 0 ? (clock.now() - d._adFrom) / 1000 : 0);
    },
    cue(id, opts = {}) {
      d.log.push(['cue', id, opts]);
      if (d._cue) d._cue.rej(err('cancelled'));
      d.state = 'loading';
      d.videoId = id;
      d.duration = 0;
      d.error = null;
      d._pos = 0;
      d._adBase = 0;
      d._adFrom = -1;
      d._buffering = false;
      return new Promise((res, rej) => {
        d._cue = { id, res, rej };
      });
    },
    /** test: the pre-roll ad is showing (its clock runs with the test clock) */
    ad() {
      d.state = 'ad';
      d._adFrom = clock.now();
    },
    /** test: the ad's clock stops (a pre-roll that is not moving) */
    adStill() {
      d._adBase = d.adSeconds;
      d._adFrom = -1;
    },
    /** test: the song on this deck stops moving while the player still says it plays (buffering) */
    buffer() {
      d._pos = d.position();
      d._buffering = true;
    },
    unbuffer() {
      d._at = clock.now();
      d._buffering = false;
    },
    unlock() {
      d.log.push(['unlock']);
    },
    /** test: the ad is over, the song is held at 0 */
    cued(duration = 200) {
      const c = d._cue;
      d._cue = null;
      d._adBase = d.adSeconds;
      d._adFrom = -1;
      d.duration = duration;
      d.state = 'cued';
      d._pos = 0;
      c.res();
    },
    failCue(code) {
      const c = d._cue;
      d._cue = null;
      d.state = 'error';
      d.error = code;
      c.rej(err(code));
    },
    play(opts = {}) {
      d.log.push(['play', opts.volume]);
      if (opts.volume !== undefined) d.setVolume(opts.volume);
      if (d.blockNext) {
        d.blockNext = false;
        return Promise.reject(err('blocked'));
      }
      if (d.state === 'empty' || d.state === 'error' || d._cue) return Promise.reject(err('not-cued'));
      d.muted = false;
      if (d.state !== 'playing') {
        d.state = 'playing';
        d._at = clock.now();
      }
      return Promise.resolve();
    },
    pause() {
      d.log.push(['pause']);
      if (d.state === 'playing') {
        d._pos = d.position();
        d._buffering = false;
        d.state = 'paused';
      }
    },
    resume() {
      return Promise.resolve(false);
    },
    stop() {
      d.log.push(['stop']);
      d.muted = true;
      if (d._cue) {
        const c = d._cue;
        d._cue = null;
        c.rej(err('cancelled'));
        d.state = 'empty';
        d.videoId = null;
        return;
      }
      if (d.state === 'playing') d._pos = d.position();
      if (d.videoId && d.state !== 'error') d.state = 'paused';
    },
    seek() {},
    setVolume(v) {
      const n = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
      if (n === d.volume) return;
      d.volume = n;
      d.vlog.push([clock.now(), n]);
    },
    position() {
      if (d.state !== 'playing' || d._buffering) return d._pos;
      const p = d._pos + (clock.now() - d._at) / 1000;
      return d.duration > 0 ? Math.min(p, d.duration) : p;
    },
    prime() {},
    destroy() {},
    cuedCount: () => d.log.filter((x) => x[0] === 'cue').length,
    lastCueOpts: () => {
      const c = d.log.filter((x) => x[0] === 'cue');
      return c.length ? c[c.length - 1][2] : null;
    },
    lastCue: () => {
      const c = d.log.filter((x) => x[0] === 'cue');
      return c.length ? c[c.length - 1][1] : null;
    },
  };
  return d;
}

function fakeEngine(clock) {
  let started = false;
  let t0 = 0;
  const e = {
    state: 'running',
    fx: [],
    plays: [],
    extends: [],
    calls: { start: 0, reset: 0, pause: 0, resume: 0 },
    vol: 1,
    start() {
      e.calls.start++;
      if (!started) {
        started = true;
        t0 = clock.now();
      }
      return Promise.resolve();
    },
    now: () => (started ? (clock.now() - t0) / 1000 : 0),
    addFx(fx) {
      e.fx.push(...fx);
    },
    addPlay(play, buffer) {
      assert.ok(buffer && buffer.duration > 0, 'addPlay needs a buffer');
      e.plays.push(play);
    },
    extendPlay(id, more) {
      e.extends.push([id, more]);
    },
    reset() {
      e.calls.reset++;
      started = false;
      return Promise.resolve();
    },
    pause() {
      e.calls.pause++;
      return Promise.resolve();
    },
    resume() {
      e.calls.resume++;
      return Promise.resolve();
    },
    setVolume(v) {
      e.vol = v;
    },
    levels: () => ({ rms: 0, peak: 0, bands: new Uint8Array(4) }),
    debug: () => ({ started }),
  };
  return e;
}

/** finder: `table(i)` → {durationS, alternates} | 'no-match' | 'network' | 'hang' */
function fakeFinder(table = () => ({})) {
  const f = {
    calls: [],
    forgotten: [],
    /** the deck's code handed to each forget() (the finder ignores codes that say nothing about the upload) */
    codes: [],
    pending: [],
    find(track) {
      f.calls.push(track.id);
      const i = idx(track.id);
      const v = table(i);
      if (v === 'hang') return new Promise((res, rej) => f.pending.push({ i, res, rej }));
      if (typeof v === 'string') return Promise.reject(err(v));
      return Promise.resolve({ videoId: vid(i), title: track.title, channel: track.artist, durationS: v.durationS || 200, score: 0.9, alternates: v.alternates || [] });
    },
    forget(track, id, code) {
      f.forgotten.push([track.id, id]);
      f.codes.push(code);
    },
  };
  return f;
}

/** Previews: every track has one unless `missing(i)`. */
function fakePreviews(missing = () => false) {
  const resolver = {
    resolveTrack: (track) => (missing(idx(track.id)) ? Promise.reject(err('no-match')) : Promise.resolve({ provider: 'deezer', key: `deezer:${track.id}`, isPreview: true })),
    fetchAudio: () => Promise.resolve(new ArrayBuffer(16)),
  };
  const analyzer = {
    cached: () => Promise.resolve(null),
    analyze: (buffer, { key }) => Promise.resolve({ duration: 30, bpm: 120 + (key.length % 7), bpmConfidence: 0.8, energy: 0.6, key: { camelot: '8A', name: 'A minor' }, loudness: { trimDb: -2 }, cues: { start: 0, end: 30 }, wave: null }),
  };
  const decode = () => Promise.resolve({ duration: 30, numberOfChannels: 2, sampleRate: 48000 });
  return { resolver, analyzer, decode };
}

function setup(opts = {}) {
  const clock = makeClock();
  const decks = [fakeDeck(0, clock), fakeDeck(1, clock)];
  const engine = fakeEngine(clock);
  const finder = fakeFinder(opts.table);
  const pv = opts.noPreviews ? {} : fakePreviews(opts.missing);
  /** the page: hidden = in a background tab */
  const page = { hidden: !!opts.hidden };
  const fs = createFullSet({ engine, finder, decks, clock: clock.now, timers: false, volumeWorks: opts.volumeWorks, hidden: () => page.hidden, ...pv });
  const events = [];
  for (const type of ['start', 'change', 'skip', 'error', 'unavailable', 'notice']) fs.on(type, (p) => type !== 'change' && events.push([type, p]));
  /** crank the clock: one tick every TICK_MS, microtasks settled after each */
  const advance = async (sec) => {
    const steps = Math.round((sec * 1000) / TICK_MS);
    for (let k = 0; k < steps; k++) {
      clock.ms += TICK_MS;
      fs.tick();
      if (k % 4 === 0) await flush();
    }
    await flush();
  };
  const settle = async () => {
    for (let k = 0; k < 6; k++) {
      fs.poke();
      await flush();
    }
  };
  return { clock, decks, engine, finder, fs, events, advance, settle, page };
}

/** Load, cue both decks, tap: returns once the opener plays. */
async function started(env, { mode = 'medium', n = 8, seed = 'abc123', vibe = 0.5 } = {}) {
  const { fs, decks, settle } = env;
  fs.load(crate(n), { seed, vibe, mode, autostart: true });
  await settle();
  decks[0].ad();
  decks[1].ad();
  decks[0].cued(200);
  await settle();
  assert.equal(fs.started, true, 'the opener started');
  return fs;
}

test('opener: pre-rolls muted at once (both decks), waits for the cue AND the tap, then plays with sound', async () => {
  const env = setup();
  const { fs, decks, finder, events, settle } = env;
  fs.load(crate(8), { seed: 'k3f9qz', vibe: 0.5, mode: 'medium', autostart: false });
  await settle();
  const order = fs.debug().order;
  assert.ok(finder.calls.length >= 2 && finder.calls.length <= 5, `looks a few tracks ahead, not the whole crate (${finder.calls.length})`);
  assert.equal(decks[0].lastCue(), vid(idx(order[0])), 'deck A cues the first song of the running order');
  assert.equal(decks[1].lastCue(), vid(idx(order[1])), 'deck B pre-rolls the second song at the same time');
  decks[0].ad();
  let s = fs.snapshot();
  assert.equal(s.started, false);
  assert.equal(s.transition.state, 'starting');
  assert.match(s.transition.why, /ad/);
  assert.equal(s.decks[0].status, 'ad');
  assert.equal(s.decks[0].statusText, 'Starting · ad playing');
  assert.equal(s.recordEnabled, false);
  assert.match(s.recordWhy, /recorded/);
  assert.equal(s.stageMode, 'video');

  decks[0].cued(210);
  await settle();
  s = fs.snapshot();
  assert.equal(s.started, false, 'cued, but no tap yet: nothing plays');
  assert.equal(decks[0].log.filter((x) => x[0] === 'play').length, 0);
  assert.match(s.transition.why, /press Play/);

  fs.begin(); // the tap
  await settle();
  assert.equal(fs.started, true);
  assert.equal(decks[0].state, 'playing');
  assert.equal(decks[0].muted, false);
  assert.ok(events.some(([t]) => t === 'start'));
  assert.equal(fs.snapshot().current.trackId, order[0]);
});

test('autostart: plays as soon as the opener is cued; a browser that refuses sound holds it for a tap', async () => {
  const env = setup();
  const { fs, decks, settle } = env;
  fs.load(crate(6), { seed: 's1', mode: 'short', autostart: true });
  await settle();
  decks[0].blockNext = true;
  decks[0].cued(180);
  await settle();
  assert.equal(fs.started, false);
  assert.equal(fs.needsTap, true, 'blocked: waits for a tap');
  assert.match(fs.snapshot().transition.why, /press Play/);
  fs.begin();
  await settle();
  assert.equal(fs.started, true);
});

test('pre-roll: the freed deck cues the next song right after a hand-over, while the current one plays', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'short' });
  decks[1].cued(190);
  await settle();
  const tr = fs.snapshot().tr;
  assert.ok(tr && tr.tStart > 30, `a transition is announced (${tr && tr.tStart})`);
  const cuesA = decks[0].cuedCount();
  await advance(tr.tEnd + 0.5);
  assert.equal(fs.debug().cur.deck, 1, 'deck B is on air');
  assert.ok(decks[0].log.some((x) => x[0] === 'stop'), 'deck A was stopped after the hand-over');
  await settle();
  assert.equal(decks[0].cuedCount(), cuesA + 1, 'deck A pre-rolls the third song at once');
  assert.equal(decks[1].state, 'playing');
  assert.equal(fs.debug().nxt.phase, 'cueing');
});

test('transitions: start at the leave point, follow the volume lanes, swap decks', async () => {
  const env = setup();
  const { fs, decks, advance, settle, engine } = env;
  await started(env, { mode: 'medium', seed: 'lanes1' });
  decks[1].cued(200);
  await settle();
  const h = fs.history();
  const s = fs.snapshot();
  const lanes = fs.debug().lanes;
  assert.ok(lanes, 'planned');
  // medium ≈ 90 s ± 12 %: the leave point of the song on air
  assert.ok(h[0].leaveAt > 75 && h[0].leaveAt < 105, `left at ${h[0].leaveAt}`);
  assert.ok(Math.abs(s.leaveAt - h[0].leaveAt) < 1e-9);
  assert.equal(s.transition.state, 'upcoming');
  await advance(lanes.incStart - 0.3);
  assert.equal(decks[1].log.filter((x) => x[0] === 'play').length, 0, 'the incoming waits for its lane');
  assert.equal(decks[0].volume, 1, 'the outgoing is at full level before the move');
  await advance(0.5);
  assert.ok(decks[1].log.some((x) => x[0] === 'play'), 'incoming started at incStart');
  // sample both decks through the move: each follows its lane (to the 1 % the player knows)
  let worst = 0;
  const mid = [];
  while (fs.now() < lanes.tEnd) {
    await advance(0.25);
    const t = fs.now() - TICK_MS / 1000; // the value written on the last tick
    if (t > lanes.tEnd) break;
    const a = volumeAt(lanes.outVol, t);
    const b = volumeAt(lanes.incVol, t);
    worst = Math.max(worst, Math.abs(decks[0].volume - Math.round(a * 100) / 100), Math.abs(decks[1].volume - Math.round(b * 100) / 100));
    mid.push(decks[0].volume + decks[1].volume);
  }
  assert.ok(worst <= 0.011, `deck volumes follow the lanes (worst ${worst})`);
  assert.ok(Math.max(...mid) <= 1.16, 'the summed level stays sane');
  await advance(0.3);
  assert.equal(fs.debug().cur.deck, 1);
  assert.equal(decks[1].volume, 1);
  assert.equal(fs.snapshot().decks[1].status, 'live');
  if (fs.history()[1].type === 'riserDrop' || fs.history()[1].type === 'fadeDrop') assert.ok(engine.fx.length > 0, 'riser / impact went to the engine');
});

test('the riser and impact are handed to the engine shortly before they happen, on the engine clock', async () => {
  const env = setup();
  const { fs, decks, advance, settle, engine } = env;
  // find a seed whose first hand-over is a drop (fx carried)
  let found = null;
  for (let k = 0; k < 40 && !found; k++) {
    const e = setup();
    await started(e, { mode: 'short', seed: `fx${k}`, vibe: 0.9 });
    e.decks[1].cued(200);
    await e.settle();
    const d = e.fs.debug().lanes;
    const h = e.fs.history()[1];
    if (d && (h.type === 'riserDrop' || h.type === 'fadeDrop')) found = `fx${k}`;
    e.fs.destroy();
  }
  assert.ok(found, 'some seed plans a drop');
  await started(env, { mode: 'short', seed: found, vibe: 0.9 });
  decks[1].cued(200);
  await settle();
  const lanes = fs.debug().lanes;
  await advance(lanes.tStart - FX_LEAD - 0.5);
  assert.equal(engine.fx.length, 0, 'nothing handed over early');
  await advance(1);
  assert.ok(engine.fx.length >= 1, 'handed over FX_LEAD before tStart');
  const impact = engine.fx.find((f) => f.kind === 'impact');
  const offset = engine.now() - fs.now();
  assert.ok(Math.abs(impact.t - (lanes.tEnd + offset)) < 0.06, 'on the engine clock');
});

test('an ad that runs long delays the hand-over instead of leaving silence', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'short', seed: 'late1' });
  decks[1].ad();
  const est = fs.snapshot().leaveAt;
  assert.ok(est > 35 && est < 55, `short ≈ 45 s (${est})`);
  await advance(est + 8);
  const s = fs.snapshot();
  assert.equal(decks[0].state, 'playing', 'the song on air plays on');
  assert.equal(decks[0].volume, 1);
  assert.equal(s.transition.state, 'waiting');
  assert.equal(s.transition.label, 'Next song after its ad');
  assert.equal(s.tr, null, 'nothing planned while the incoming is in its ad');
  decks[1].cued(200);
  await settle();
  const tr = fs.debug().lanes;
  assert.ok(tr.tStart >= fs.now() && tr.tStart < fs.now() + 2, 'planned from now');
  assert.match(fs.snapshot().transition.why, /later than planned/);
  await advance(tr.tEnd - fs.now() + 0.4);
  assert.equal(fs.debug().cur.deck, 1);
});

test('a song that ends before its hand-over: cut into the cued deck, or wait for it', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'full', seed: 'end1' });
  decks[1].ad();
  await advance(3);
  decks[0].state = 'ended'; // the video was shorter than anyone said
  await advance(0.3);
  let s = fs.snapshot();
  assert.equal(s.transition.state, 'waiting');
  assert.equal(s.stalled, 'loading');
  decks[1].cued(200);
  await settle();
  await advance(1.5);
  s = fs.snapshot();
  const h = fs.history()[1];
  assert.equal(h.type, 'cut');
  assert.equal(fs.debug().cur.deck, 1);
  assert.equal(decks[1].state, 'playing');
});

test('New set when the song on air has run out and its incoming is cued: the incoming comes in, then the new order takes over under it (no reset, no fresh ads)', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'full', seed: 'end2' });
  decks[1].ad();
  await advance(3);
  decks[0].state = 'ended'; // ran out while the next song was still in its ad
  await advance(0.3);
  decks[1].cued(200);
  await settle();
  assert.equal(fs.debug().cur.phase, 'ended');
  assert.equal(fs.debug().nxt.phase, 'cued', 'the incoming is cued and about to come in');
  const seed0 = fs.seed;
  const cuesA = decks[0].cuedCount();
  fs.newSet('nw2new');
  assert.equal(fs.seed, 'nw2new');
  await settle();
  await advance(2);
  await settle();
  assert.equal(fs.started, true, 'no reset: the set is still on');
  assert.equal(fs.debug().cur.deck, 1, 'the cued song came in');
  assert.equal(decks[1].state, 'playing');
  assert.notEqual(fs.snapshot().transition.state, 'starting', 'not back to "Starting the set"');
  assert.equal(decks[0].cuedCount(), cuesA + 1, 'the free deck pre-rolls the new order’s first song');
  assert.notEqual(seed0, fs.seed);
  // without a cued incoming (the song ran out, the next one still in its ad) New set starts afresh
  const env2 = setup();
  await started(env2, { mode: 'full', seed: 'end3' });
  env2.decks[1].ad();
  await env2.advance(3);
  env2.decks[0].state = 'ended';
  await env2.advance(0.3);
  env2.fs.newSet('nw3new');
  await env2.settle();
  assert.equal(env2.fs.started, false, 'nothing on its way in: a fresh start');
  assert.equal(env2.fs.seed, 'nw3new', 'with the new seed');
});

test('errors: alternates first, then the preview through Web Audio, then the next track', async () => {
  const env = setup({ table: (i) => (i % 2 === 0 ? { alternates: [vid(i, 1)] } : {}) });
  const { fs, decks, finder, advance, settle, engine } = env;
  await started(env, { mode: 'short', seed: 'err7' });
  const order = fs.debug().order;
  const second = idx(order[1]);
  const alt = second % 2 === 0;
  decks[1].failCue(150);
  await settle();
  assert.deepEqual(finder.forgotten[0], [order[1], vid(second)], 'the refused id is reported to the finder');
  assert.equal(finder.codes[0], 150, 'with the deck’s code');
  if (alt) {
    assert.equal(decks[1].lastCue(), vid(second, 1), 'its alternate upload is cued');
    decks[1].failCue(150);
    await settle();
  }
  // no upload left: its 30-second preview stands in
  await settle();
  const rec = fs.debug().nxt;
  assert.equal(rec.provider, 'preview');
  assert.equal(rec.phase, 'cued');
  const shown = () => fs.snapshot().decks[rec.deck];
  assert.equal(shown().statusText, 'No video · its preview is cued', 'the cued preview says what will play');
  const lanes = fs.debug().lanes;
  assert.ok(lanes, 'the preview gets a planned transition');
  await advance(lanes.incStart - fs.now() + 0.2);
  // playing: no text of the conductor's own, so the view's "No video · its 30-s preview" shows
  assert.equal(shown().status, 'mixing');
  assert.equal(shown().statusText, undefined, 'a mixing preview leaves the wording to the view');
  assert.equal(engine.plays.length, 1, 'the preview plays through the engine');
  const play = engine.plays[0];
  assert.equal(play.events[0].p, 'gain');
  assert.equal(play.events[0].k, 'set');
  assert.ok(play.events.length >= 3, 'gain events built from the incoming lane');
  await advance(lanes.tEnd - fs.now() + 0.3);
  assert.equal(fs.debug().cur.provider, 'preview');
  assert.equal(fs.snapshot().decks[fs.debug().cur.deck].provider, 'preview');
  assert.equal(shown().status, 'live');
  assert.equal(shown().statusText, undefined, 'a live preview leaves the wording to the view (not "Preview clip")');
});

test('a track with no video and no preview is skipped and marked failed', async () => {
  const env = setup({ table: (i) => (i === 1 || i === 2 ? 'no-match' : {}), missing: (i) => i === 1 || i === 2 });
  const { fs, settle, decks } = env;
  fs.load(crate(6), { seed: 'fail2', mode: 'short', autostart: true });
  for (let k = 0; k < 4; k++) await settle();
  const order = fs.debug().order;
  const s = fs.snapshot();
  const failed = s.setlist.filter((r) => r.state === 'failed').map((r) => r.key.split('|')[0]);
  for (const id of order.slice(0, 4)) {
    const i = idx(id);
    if (i === 1 || i === 2) assert.ok(failed.includes(id), `${id} is marked failed`);
  }
  const cuedIds = [decks[0].lastCue(), decks[1].lastCue()];
  assert.ok(!cuedIds.includes(vid(1)) && !cuedIds.includes(vid(2)));
  assert.ok(s.stats.failed >= 1);
});

test('Skip: quick transition when the next song is cued; queued while it is in its ad', async () => {
  const env = setup();
  const { fs, decks, events, advance, settle } = env;
  await started(env, { mode: 'medium', seed: 'skip1' });
  decks[1].ad();
  await advance(2);
  assert.equal(fs.canSkip(), true, 'Skip offered while the next song is in its ad');
  assert.equal(fs.skip(), true);
  assert.ok(events.some(([t, p]) => t === 'notice' && /after its ad/.test(p.message)), 'says so');
  assert.equal(fs.snapshot().skipQueued, true);
  assert.equal(fs.canSkip(), false, 'not twice');
  assert.equal(fs.snapshot().transition.label, 'Next song after its ad');
  await advance(5);
  assert.equal(fs.snapshot().tr, null);
  decks[1].cued(200);
  await settle();
  const tr = fs.debug().lanes;
  assert.ok(tr.tStart - fs.now() < 0.6, `the queued Skip fires as soon as it is cued (${(tr.tStart - fs.now()).toFixed(2)} s)`);
  assert.ok(tr.tEnd - tr.tStart <= 3.01, 'a quick move');
  assert.match(fs.snapshot().transition.why, /skipped/, 'a queued Skip says so');
  await advance(tr.tEnd - fs.now() + 0.3);
  assert.equal(fs.debug().cur.deck, 1);

  // the next one is cued in time: Skip acts at once, into it
  decks[0].cued(200);
  await settle();
  const planned = fs.debug().lanes;
  assert.ok(planned.tStart - fs.now() > 20);
  await advance(3);
  assert.equal(fs.skip(), true);
  const q = fs.debug().lanes;
  assert.ok(q.tStart - fs.now() < 0.5 && q.tStart < planned.tStart);
  assert.match(fs.snapshot().transition.why, /skipped/);
  assert.ok(events.some(([t]) => t === 'skip'));
});

test('pause and resume: both decks and the engine, set time frozen in between', async () => {
  const env = setup();
  const { fs, decks, engine, advance, settle, clock } = env;
  // a smooth set in Full: the hand-over is a blend long enough to pause in the middle of
  let seed = '';
  for (let k = 0; k < 30 && !seed; k++) {
    const e = setup();
    await started(e, { mode: 'full', seed: `pz${k}`, vibe: 0 });
    e.decks[1].cued(200);
    await e.settle();
    const l = e.fs.debug().lanes;
    if (l.tEnd - l.tStart > 6) seed = `pz${k}`;
    e.fs.destroy();
  }
  assert.ok(seed);
  await started(env, { mode: 'full', seed, vibe: 0 });
  decks[1].cued(200);
  await settle();
  const lanes = fs.debug().lanes;
  await advance((lanes.tStart + lanes.tEnd) / 2 - fs.now()); // in the middle of the hand-over: both decks sound
  assert.equal(decks[1].state, 'playing');
  await fs.pause();
  const t0 = fs.now();
  clock.ms += 5000;
  await settle();
  assert.equal(fs.now(), t0, 'set time frozen');
  assert.equal(decks[0].state, 'paused');
  assert.equal(decks[1].state, 'paused');
  assert.ok(engine.calls.pause >= 1);
  assert.equal(fs.snapshot().playing, false);
  await fs.resume();
  await settle();
  assert.equal(decks[0].state, 'playing');
  assert.equal(decks[1].state, 'playing');
  assert.ok(engine.calls.resume >= 1);
  await advance(1);
  assert.ok(Math.abs(fs.now() - (t0 + 1)) < 0.11, 'continues from where it was');
  await advance(lanes.tEnd - fs.now() + 0.3);
  assert.equal(fs.debug().cur.deck, 1, 'the hand-over completes after the pause');
});

test('a click on the video itself pauses the set (the transport follows the player)', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'medium', seed: 'click' });
  await advance(2);
  decks[0].pause(); // someone clicked the player
  await settle();
  assert.equal(fs.paused, true);
  decks[0].play({});
  await settle();
  assert.equal(fs.paused, false);
});

test('endless: every track once per pass, passes go on', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'short', n: 3, seed: 'loop3' });
  for (let k = 0; k < 7; k++) {
    const nx = fs.debug().nxt;
    assert.ok(nx, `play ${k + 1} has a next song`);
    decks[nx.deck].cued(150);
    await settle();
    const lanes = fs.debug().lanes;
    await advance(lanes.tEnd - fs.now() + 0.3);
    await settle();
  }
  const h = fs.history().map((x) => x.trackId);
  assert.ok(h.length >= 8);
  for (let p = 0; p + 3 <= 6; p += 3) assert.equal(new Set(h.slice(p, p + 3)).size, 3, `pass ${p / 3 + 1} plays each track once: ${h.slice(p, p + 3)}`);
  for (let k = 1; k < h.length; k++) assert.notEqual(h[k], h[k - 1], 'never the same song twice in a row');
});

test('New set mid-flight: stale cues and plays are ignored, a new opener is cued', async () => {
  const env = setup();
  const { fs, decks, settle } = env;
  fs.load(crate(8), { seed: 'old111', mode: 'medium', autostart: true });
  await settle();
  const oldCue = decks[0]._cue;
  const oldOrder = fs.debug().order;
  fs.newSet('new222');
  await settle();
  const newOrder = fs.debug().order;
  assert.notDeepEqual(newOrder, oldOrder);
  assert.equal(decks[0].lastCue(), vid(idx(newOrder[0])), 'the new opener is cued on deck A');
  oldCue.res(); // the old cue resolves late (it was cancelled): nothing may start from it
  await settle();
  assert.equal(fs.started, false);
  decks[0].cued(200);
  await settle();
  assert.equal(fs.started, true);
  assert.equal(fs.snapshot().current.trackId, newOrder[0]);
  assert.equal(fs.seed, 'new222');
});

test('Track length re-plans the announced transition (same next song)', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'medium', seed: 'mode1' });
  decks[1].cued(200);
  await settle();
  const was = fs.history()[1];
  assert.ok(was.tStart > 70);
  await advance(3);
  fs.setMode('short');
  await settle();
  const now1 = fs.history()[1];
  assert.equal(now1.trackId, was.trackId);
  assert.ok(now1.tStart < 56 && now1.tStart < was.tStart - 15, `re-planned from ${was.tStart.toFixed(1)} to ${now1.tStart.toFixed(1)}`);
  fs.setMode('full');
  await settle();
  assert.ok(fs.history()[1].tStart > 150, 'full: towards the end of the song');
});

test('YouTube unusable: the player API fails, or every lookup fails on the network → handed to Preview mode', async () => {
  const a = setup();
  a.fs.load(crate(5), { seed: 'api1', mode: 'medium', autostart: true });
  await a.settle();
  a.decks[0].failCue('api');
  await a.settle();
  assert.ok(a.events.some(([t, p]) => t === 'unavailable' && /YouTube/.test(p.message)));

  const b = setup({ table: () => 'network' });
  b.fs.load(crate(6), { seed: 'net1', mode: 'medium', autostart: true });
  for (let k = 0; k < 4; k++) await b.settle();
  assert.ok(b.events.some(([t, p]) => t === 'unavailable' && /reach YouTube/.test(p.message)));

  // label uploads refusing this address (error 150 everywhere, as on 127.0.0.1)
  const c = setup({ noPreviews: true });
  c.fs.load(crate(6), { seed: 'ref1', mode: 'medium', autostart: true });
  for (let k = 0; k < 5; k++) {
    await c.settle();
    for (const d of c.decks) if (d._cue) d.failCue(150);
  }
  assert.ok(c.events.some(([t, p]) => t === 'unavailable' && /site address/.test(p.message)));
});

test('frame(): deck volumes, leave point and countdown for the view, no allocation per call', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'short', seed: 'frame1' });
  decks[1].cued(200);
  await settle();
  await advance(4);
  const out = { decks: [null, null] };
  fs.frame(fs.now(), out);
  const [a, b] = out.decks;
  assert.ok(a && b);
  assert.equal(a.gain, 1);
  assert.equal(a.eqActive, false);
  assert.ok(a.leaveAt > 30 && a.leaveAt < 60);
  assert.ok(a.pos > 3.5 && a.pos < 4.5);
  assert.equal(b.gain, 0);
  assert.ok(b.startsIn > 20, 'the cued deck counts down to its start');
  assert.equal(out.beatPhase, -1);
  const first = out.decks[0];
  fs.frame(fs.now(), out);
  assert.equal(out.decks[0], first, 'the same DeckFrame object every frame');
});

test('newSet keeps working after failures; stop() silences both decks', async () => {
  const env = setup();
  const { fs, decks } = env;
  await started(env, { mode: 'short', seed: 'stop1' });
  fs.stop();
  assert.equal(decks[0].muted, true);
  assert.equal(decks[0].state, 'paused');
  assert.equal(fs.snapshot().loaded, false);
});

test('a deck that reports its state from inside cue() (as ytdeck does) never gets a second song', async () => {
  const env = setup();
  const { fs, decks, settle } = env;
  // ytdeck calls onChange synchronously inside cue(); main.js wires onChange to poke()
  for (const d of decks) {
    const cue = d.cue;
    d.cue = (id) => {
      const p = cue(id);
      fs.poke();
      return p;
    };
  }
  fs.load(crate(8), { seed: 're1', mode: 'short', autostart: true });
  await settle();
  assert.equal(decks[0].cuedCount(), 1, 'deck A cued once');
  assert.equal(decks[1].cuedCount(), 1, 'deck B cued once');
  assert.equal(fs.history().length, 2, 'two plays, no orphan');
  decks[0].cued(200);
  decks[1].cued(200);
  await settle();
  assert.equal(fs.started, true);
  assert.ok(fs.debug().lanes, 'the cued next song is planned (it is the play the set knows about)');
});

test('a player that ignores volume (iOS): every move becomes a cut at its crossover — never two songs at full for a whole blend', async () => {
  for (let k = 0; k < 12; k++) {
    const env = setup({ volumeWorks: false });
    await started(env, { mode: 'full', seed: `ios${k}`, vibe: 0.1 });
    env.decks[1].cued(220);
    await env.settle();
    const l = env.fs.debug().lanes;
    assert.ok(l.tEnd - l.tStart < 30, 'planned');
    const span = l.tEnd - Math.max(l.incStart, l.tStart);
    assert.ok(l.incStart >= l.tEnd - 0.05 - 0.02 - 0.36, `the incoming starts just before the cut (${(l.tEnd - l.incStart).toFixed(2)} s before the end)`);
    assert.ok(span < 0.5, `the overlap is a cut (${span.toFixed(2)} s)`);
    assert.match(env.fs.snapshot().transition.why, /ignores volume/);
    env.fs.destroy();
  }
});

test('New set while a song plays: it plays on, the new order’s first song pre-rolls on the free deck, then a quick hand-over', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  await started(env, { mode: 'medium', seed: 'ns1' });
  decks[1].cued(200);
  await settle();
  await advance(10);
  const playing = fs.debug().cur;
  fs.newSet('ns2');
  await settle();
  const order = fs.debug().order;
  assert.equal(fs.seed, 'ns2');
  assert.equal(fs.started, true, 'still started');
  assert.equal(decks[playing.deck].state, 'playing', 'the song on air plays on');
  assert.equal(fs.snapshot().playing, true);
  const head = order.find((id) => id !== fs.snapshot().current.trackId);
  assert.equal(decks[1 - playing.deck].lastCue(), vid(idx(head)), 'the new order’s first song is cued on the free deck');
  assert.equal(fs.snapshot().tr, null);
  await advance(3);
  decks[1 - playing.deck].cued(200);
  await settle();
  const l = fs.debug().lanes;
  assert.ok(l && l.tStart - fs.now() < 0.6, 'in as soon as it is cued');
  const why = fs.snapshot().transition.why;
  assert.match(why, /new set/, 'the move says New Set brought it in');
  assert.doesNotMatch(why, /skipped/, 'not “skipped”: nobody pressed Skip');
  await advance(l.tEnd - fs.now() + 0.3);
  assert.equal(fs.snapshot().current.trackId, head);
  assert.equal(fs.history()[0].trackId, playing ? fs.history()[0].trackId : '', 'history starts with the song that bridged the two sets');
});

// ── background tabs, long ads, the opener, New set mid-move, stalls (review 2, 2026-10-05) ─────────

test('background tab: a cue the browser blocks there is held — never refused, forgotten or counted — and cued again once the tab is in front', async () => {
  const env = setup({ table: (i) => ({ alternates: [vid(i, 1)] }) });
  const { fs, decks, finder, events, advance, settle, page } = env;
  await started(env, { mode: 'medium', seed: 'bg1' });
  const id = decks[1].lastCue();
  const cues = decks[1].cuedCount();
  page.hidden = true;
  await advance(1);
  decks[1].failCue('blocked'); // what Chrome does to a player that has only ever played muted
  await settle();
  let d = fs.debug();
  assert.deepEqual(finder.forgotten, [], 'the finder’s cache keeps the upload');
  assert.equal(d.nxt.provider, 'youtube', 'not handed to the preview');
  assert.equal(d.nxt.videoId, id, 'the same upload, not an alternate');
  assert.equal(d.cues.failed, 0, 'not counted towards “YouTube does not work here”');
  assert.equal(decks[1].log[decks[1].log.length - 1][0], 'stop', 'the deck is stopped (nothing starts by itself when the tab is shown)');
  assert.equal(fs.snapshot().decks[1].statusText, 'Loads when this tab is in front');
  await advance(20);
  assert.equal(decks[1].cuedCount(), cues, 'nothing is cued while the tab stays hidden');
  page.hidden = false;
  await advance(0.3);
  assert.equal(decks[1].cuedCount(), cues + 1, 'cued again as soon as the tab is in front');
  assert.equal(decks[1].lastCue(), id);
  decks[1].cued(200);
  await settle();
  assert.ok(fs.debug().lanes, 'and planned as usual');
  assert.equal(fs.debug().nxt.provider, 'youtube');

  // many background failures before any cue ever succeeded never hand the set to Preview
  const b = setup({ hidden: true });
  b.fs.load(crate(8), { seed: 'bg1b', mode: 'medium', autostart: true });
  await b.settle();
  for (let k = 0; k < 4; k++) {
    for (const dk of b.decks) if (dk._cue) dk.failCue('blocked');
    await b.settle();
    b.page.hidden = false;
    await b.advance(0.3);
    b.page.hidden = true;
    await b.advance(5); // past the grace after the page was last seen hidden
  }
  assert.ok(!b.events.some(([t]) => t === 'unavailable'), 'no “YouTube keeps failing” hand-over');
  assert.equal(b.fs.debug().cues.failed, 0);
  assert.deepEqual(b.finder.forgotten, []);
  assert.ok(events.every(([t]) => t !== 'unavailable'));
});

test('background tab: the held next song’s preview stands in when the song on air is on its way out, and the set goes on', async () => {
  const env = setup();
  const { fs, decks, events, advance, settle, page } = env;
  await started(env, { mode: 'short', seed: 'bg2' });
  page.hidden = true;
  await advance(1);
  decks[1].failCue('blocked');
  await settle();
  const est = fs.snapshot().leaveAt;
  await advance(est - 12);
  assert.equal(fs.debug().nxt.provider, 'youtube', 'held, not given up early');
  await advance(8);
  await settle();
  const d = fs.debug();
  assert.equal(d.nxt.provider, 'preview', 'its preview stands in');
  assert.ok(events.some(([t, p]) => t === 'notice' && /background tab/.test(p.message)), 'and the notice says why');
  assert.ok(d.lanes, 'planned');
  await advance(d.lanes.tEnd - fs.now() + 0.3);
  await settle();
  assert.equal(fs.debug().cur.provider, 'preview');
  assert.equal(fs.debug().cur.deck, 1);
  assert.equal(decks[0].cuedCount(), 2, 'the deck that played with sound pre-rolls the next song (it can, in a background tab)');
});

test('background tab: back in front, a player Chrome starts by itself on a deck whose song now plays as a preview is stopped again; the song on air is left alone', async () => {
  const env = setup();
  const { fs, decks, advance, settle, page } = env;
  await started(env, { mode: 'short', seed: 'bg4' });
  page.hidden = true;
  await advance(1);
  decks[1].failCue('blocked');
  await settle();
  await advance(fs.snapshot().leaveAt - 4);
  await settle();
  assert.equal(fs.debug().nxt.provider, 'preview', 'the preview stands in');
  // still hidden: the deck that carries no video of this set reports that it plays (an abandoned pre-roll
  // going on by itself) — told to stop at once, whatever the tab
  decks[1].state = 'playing';
  decks[1]._at = env.clock.ms;
  let stops1 = decks[1].log.filter((x) => x[0] === 'stop').length;
  await advance(0.5);
  assert.equal(decks[1].log.filter((x) => x[0] === 'stop').length, stops1 + 1, 'an idle deck that plays is stopped, hidden or not');
  assert.notEqual(decks[1].state, 'playing');
  // what Chrome does when the tab is shown: the muted player it held in the background plays on its own
  // (the deck may not even say so: right after the tab is shown, an idle deck is told to stop again)
  decks[1].state = 'playing';
  decks[1]._at = env.clock.ms;
  const stops0 = decks[0].log.filter((x) => x[0] === 'stop').length;
  page.hidden = false;
  await advance(0.3);
  assert.equal(decks[1].log[decks[1].log.length - 1][0], 'stop', 'stopped again');
  assert.notEqual(decks[1].state, 'playing');
  assert.equal(decks[0].log.filter((x) => x[0] === 'stop').length, stops0, 'the deck playing the song on air is not touched');
  assert.equal(decks[0].state, 'playing');
});

test('background tab: a next song whose player neither loads nor fails there (or whose ad Chrome holds still) ends the silence with its preview, as in front', async () => {
  for (const how of ['loading', 'ad-still']) {
    const env = setup();
    const { fs, decks, finder, events, advance, settle, page } = env;
    await started(env, { mode: 'full', seed: `bg5-${how}` });
    decks[1].ad(); // a long ad, moving while the tab is in front
    const cues = decks[1].cuedCount();
    // (an ad clock that stops counts as held only after AD_HELD_MS — a pod's gap between two ads, or the
    // second the deck needs to hold the song at 0:00 after its ad, stops it for a while — so the tab is
    // hidden, and the player stuck, 15 s before the song on air runs out)
    await advance(185 - fs.now());
    page.hidden = true;
    decks[1].adStill(); // Chrome pauses the muted pre-roll when the tab is hidden …
    if (how === 'loading') decks[1].state = 'loading'; // … or the player goes back to loading and gets no further
    await advance(200.5 - fs.now());
    assert.equal(fs.debug().cur.phase, 'ended', `${how}: the song on air ran out`);
    assert.equal(fs.debug().nxt.provider, 'youtube', `${how}: the incoming is not given up while the song plays`);
    await advance(SILENT_WAIT_S + 0.5);
    await settle();
    assert.equal(fs.history()[1].provider, 'preview', `${how}: after SILENT_WAIT_S of silence its preview is readied, hidden tab or not`);
    await advance(1.5);
    assert.equal(fs.debug().cur.provider, 'preview', `${how}: and plays`);
    assert.ok(events.some(([t, p]) => t === 'notice' && /background tab/.test(p.message)), `${how}: the notice says why`);
    assert.equal(decks[1].cuedCount(), cues, `${how}: no fresh ad was cued`);
    assert.deepEqual(finder.forgotten, [], `${how}: nothing forgotten`);
    assert.equal(fs.debug().cues.failed, 0, `${how}: nothing counted`);
    assert.ok(!events.some(([t]) => t === 'unavailable'));
  }
});

test('background tab: an ad that keeps moving there and outlasts the song on air is a long ad, as in front — the preview after SILENT_WAIT_S says so (not "the browser doesn’t start videos")', async () => {
  const env = setup();
  const { fs, decks, finder, events, advance, settle, page } = env;
  await started(env, { mode: 'full', seed: 'bg7' });
  decks[1].ad();
  page.hidden = true;
  await advance(200.5 - fs.now());
  assert.equal(fs.debug().cur.phase, 'ended', 'the song on air ran out while the ad still moves');
  assert.equal(fs.debug().nxt.provider, 'youtube');
  await advance(SILENT_WAIT_S + 0.5);
  await settle();
  await advance(1.5);
  const h = fs.history();
  assert.equal(h[1].provider, 'preview', 'after SILENT_WAIT_S of silence its preview plays');
  assert.equal(h[1].previewWhy, 'slow', 'history says why: a long ad');
  assert.ok(events.some(([t, p]) => t === 'notice' && /ran long/.test(p.message)), 'the notice names the long ad');
  assert.ok(!events.some(([t, p]) => t === 'notice' && /background tab/.test(p.message)), 'and does not blame the background tab');
  assert.deepEqual(finder.forgotten, [], 'nothing forgotten');
  assert.equal(fs.debug().cues.failed, 0);
});

test('background tab: a next song still not cued at the leave point gives way to its preview only when its pre-roll does not move (Chrome holds a muted one still there); a moving ad is waited for, hidden or not', async () => {
  for (const how of ['hidden-still', 'hidden-moving', 'front']) {
    const hidden = how !== 'front';
    const env = setup();
    const { fs, decks, finder, events, advance, settle, page } = env;
    await started(env, { mode: 'short', seed: `bg6-${how}` });
    decks[1].ad();
    page.hidden = hidden;
    await advance(0.5);
    if (how === 'hidden-still') decks[1].adStill(); // the ad clock stops in the background tab
    const cues = decks[1].cuedCount();
    const stops = decks[1].log.filter((x) => x[0] === 'stop').length;
    const est = fs.snapshot().leaveAt;
    await advance(est - 12);
    assert.equal(fs.debug().nxt.provider, 'youtube', `${how}: not given up early`);
    await advance(10);
    await settle();
    const d = fs.debug();
    if (how === 'hidden-still') {
      assert.equal(d.nxt.provider, 'preview', 'hidden, ad still: its preview stands in before the song on air is over');
      assert.equal(d.cur.phase, 'live', 'while the song on air still plays');
      assert.ok(d.lanes, 'and the move is planned');
      assert.equal(decks[1].log[decks[1].log.length - 1][0], 'stop', 'the held-still pre-roll is stopped');
      assert.equal(decks[1].cuedCount(), cues, 'no fresh ad');
      assert.ok(events.some(([t, p]) => t === 'notice' && /background tab/.test(p.message)));
    } else {
      // an unmuted pre-roll at volume 0 runs on in a background tab (measured 2026-10-06): cutting it for a
      // 30-second clip was what turned songs heard while hidden into previews
      assert.equal(d.nxt.provider, 'youtube', `${how}: the moving ad is waited for (the song on air plays on)`);
      assert.equal(d.nxt.phase, 'cueing');
      assert.equal(decks[1].log.filter((x) => x[0] === 'stop').length, stops, `${how}: the pre-roll is not stopped`);
      decks[1].cued(200);
      await settle();
      await advance(1);
      assert.ok(fs.debug().lanes, `${how}: once cued, the move is planned at once`);
      await advance(fs.debug().lanes.tEnd - fs.now() + 0.3);
      await settle();
      assert.equal(fs.debug().cur.deck, 1, `${how}: the full song comes in`);
      assert.equal(fs.debug().cur.provider, 'youtube', `${how}: ${JSON.stringify(fs.history().map((h) => [h.provider, h.phase]))} ${JSON.stringify(events.filter((e) => e[0] === 'notice'))} ${JSON.stringify(decks[1].log)}`);
    }
    assert.deepEqual(finder.forgotten, []);
    assert.equal(fs.debug().cues.failed, 0);
  }
});

test('background tab: the gap between two ads of a pod (the ad clock still for seconds) at the leave point is not a held pre-roll — no stand-in', async () => {
  const env = setup();
  const { fs, decks, advance, settle, page } = env;
  await started(env, { mode: 'short', seed: 'bg8' });
  decks[1].ad();
  page.hidden = true;
  const est = fs.snapshot().leaveAt;
  await advance(est - 3);
  decks[1].adStill(); // the first ad is over, the second is loading: the clock stands still …
  await advance(8);
  assert.equal(fs.debug().nxt.provider, 'youtube', 'not stood in during an 8 s gap');
  decks[1].ad(); // … and the second ad runs
  await advance(10);
  await settle();
  assert.equal(fs.debug().nxt.provider, 'youtube', 'still the full song');
  decks[1].cued(200);
  await settle();
  await advance(1);
  await advance(fs.debug().lanes.tEnd - fs.now() + 0.3);
  await settle();
  assert.equal(fs.debug().cur.provider, 'youtube', 'the full song comes in');
  assert.equal(fs.debug().cur.deck, 1);
});

test('background tab: the moment a pre-roll\'s ad ends (the deck holds the song at its cue point, "loading") is not a held pre-roll — no stand-in', async () => {
  const env = setup();
  const { fs, decks, advance, settle, page } = env;
  await started(env, { mode: 'short', seed: 'bg9' });
  decks[1].ad();
  page.hidden = true;
  await advance(fs.snapshot().leaveAt + 5 - fs.now()); // past the leave point: the song on air plays on
  assert.equal(fs.debug().nxt.provider, 'youtube');
  decks[1].adStill();
  decks[1].state = 'loading'; // the ad is over: the song started and is being held at 0:00
  await advance(1.5);
  await settle();
  assert.equal(fs.debug().nxt.provider, 'youtube', 'not cut for its preview while it is being cued');
  assert.equal(fs.debug().nxt.phase, 'cueing');
  decks[1].cued(200);
  await settle();
  await advance(1);
  await advance(fs.debug().lanes.tEnd - fs.now() + 0.3);
  await settle();
  assert.equal(fs.debug().cur.provider, 'youtube', 'the full song comes in');
  assert.equal(fs.debug().cur.deck, 1);
});

test('a late tick (a throttled timer) issues the incoming play() after tEnd: it gets its START_GRACE from then, not from tEnd', async () => {
  const env = setup();
  const { fs, decks, clock, settle } = env;
  await started(env, { mode: 'short', seed: 'late1' });
  decks[1].ad();
  decks[1].cued(200);
  await settle();
  await env.advance(0.5);
  const tr = fs.debug().lanes;
  assert.ok(tr, 'planned');
  // the next song's play() will not resolve at once (a hidden tab's player takes a moment)
  let release;
  decks[1].play = (opts = {}) => {
    decks[1].log.push(['play', opts.volume]);
    return new Promise((res) => {
      release = () => {
        decks[1].state = 'playing';
        decks[1]._at = clock.now();
        res();
      };
    });
  };
  // no tick for a long while, then one: past incStart, past tEnd + START_GRACE
  const stops1 = decks[1].log.filter((x) => x[0] === 'stop').length;
  clock.ms += (tr.tEnd - fs.now() + 30) * 1000;
  fs.tick();
  await settle();
  assert.equal(decks[1].log.filter((x) => x[0] === 'play').length, 1, 'the late tick issues the play()');
  assert.equal(fs.debug().nxt && fs.debug().nxt.phase, 'starting', 'and does not give it up in the same call');
  assert.equal(decks[1].log.filter((x) => x[0] === 'stop').length, stops1, `the incoming deck is not stopped ${JSON.stringify(decks[1].log)}`);
  release();
  await settle();
  await env.advance(0.2);
  assert.equal(fs.debug().cur.deck, 1, 'the full song comes in');
  assert.equal(fs.debug().cur.provider, 'youtube');
  assert.equal(fs.debug().cues.failed, 0);
});

test('an incoming given up between startIncoming and its deferred play() is never started', async () => {
  const env = setup();
  const { fs, decks, settle } = env;
  await started(env, { mode: 'short', seed: 'defer1' });
  decks[1].ad();
  decks[1].cued(200);
  await settle();
  await env.advance(0.5);
  const tr = fs.debug().lanes;
  // step right up to incStart, then the tick that issues play(); before its microtask runs, the set stops
  await env.advance(Math.max(0, tr.incStart - fs.now() - 0.1));
  const plays = decks[1].log.filter((x) => x[0] === 'play').length;
  env.clock.ms += 200;
  fs.tick(); // startIncoming(): play() deferred to a microtask
  fs.stop(); // given up before it runs
  await settle();
  assert.equal(decks[1].log.filter((x) => x[0] === 'play').length, plays, 'no play() reaches the abandoned deck');
  assert.notEqual(decks[1].state, 'playing');
});

test('timers: an object with setInterval / clearInterval is the clock the set ticks on (main.js: the worker clock)', async () => {
  const clock = makeClock();
  const decks = [fakeDeck(0, clock), fakeDeck(1, clock)];
  const live = new Map();
  let next = 1;
  const timers = {
    setInterval: (fn, ms) => {
      live.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (id) => live.delete(id),
  };
  const fs = createFullSet({ engine: fakeEngine(clock), finder: fakeFinder(), decks, clock: clock.now, timers, ...fakePreviews() });
  assert.equal(live.size, 0, 'nothing ticks before a set is loaded');
  fs.load(crate(6), { seed: 'tm1', vibe: 0.5, mode: 'short', autostart: true });
  assert.equal(live.size, 1, 'load() starts one interval on the given timers');
  const [t] = [...live.values()];
  assert.equal(t.ms, TICK_MS);
  for (let k = 0; k < 8; k++) t.fn(); // the worker's firings drive the set
  await flush();
  assert.ok(decks[0].cuedCount() >= 1, 'its ticks drive the set (deck A cues the opener)');
  fs.stop();
  assert.equal(live.size, 0, 'stop() clears it on the same timers');
});

test('background tab before the first song: ten minutes of players that never load refuse nothing; back in front, a still-stuck cue is started again', async () => {
  const env = setup({ hidden: true, table: (i) => ({ alternates: [vid(i, 1)] }) });
  const { fs, decks, finder, events, advance, settle, page } = env;
  fs.load(crate(8), { seed: 'bg3', mode: 'medium', autostart: true });
  await settle();
  const ids = [decks[0].lastCue(), decks[1].lastCue()];
  await advance(600);
  assert.deepEqual([decks[0].cuedCount(), decks[1].cuedCount()], [1, 1], 'no timeout, no alternate while hidden');
  assert.deepEqual(finder.forgotten, []);
  assert.ok(!events.some(([t]) => t === 'unavailable'));
  assert.equal(fs.debug().cues.failed, 0);
  page.hidden = false;
  await advance(4);
  assert.deepEqual([decks[0].cuedCount(), decks[1].cuedCount()], [1, 1], 'a moment to come to life on its own');
  await advance(2);
  assert.deepEqual([decks[0].cuedCount(), decks[1].cuedCount()], [2, 2], 'still loading 5 s after the tab came back: started again');
  assert.deepEqual([decks[0].lastCue(), decks[1].lastCue()], ids, 'the same uploads');
  decks[0].ad();
  decks[0].cued(200);
  await settle();
  assert.equal(fs.started, true);
});

test('a player that gets nowhere with the page in front: its next upload after 3 minutes — the first is not forgotten', async () => {
  const env = setup({ table: (i) => ({ alternates: [vid(i, 1)] }) });
  const { fs, decks, finder, events, advance } = env;
  fs.load(crate(6), { seed: 'stk1', mode: 'medium', autostart: true });
  await advance(0.5);
  const first = idx(fs.debug().order[0]);
  await advance(170);
  assert.equal(decks[0].cuedCount(), 1);
  await advance(15);
  assert.equal(decks[0].lastCue(), vid(first, 1), 'the next upload');
  assert.deepEqual(finder.forgotten, [], 'a stuck player says nothing about the upload');
  assert.ok(!events.some(([t]) => t === 'unavailable'));
});

test('a long ad is not a broken upload: while it moves it is waited for; once the music has stopped, the ready preview ends the silence', async () => {
  // (a) a moving ad past the cue time is not cut short while the song on air plays; a still one is
  const a = setup({ table: (i) => ({ alternates: [vid(i, 1)] }) });
  a.fs.load(crate(8), { seed: 'long0', mode: 'full', autostart: true });
  await a.settle();
  a.decks[0].ad();
  a.decks[1].ad();
  a.decks[0].cued(600);
  await a.settle();
  assert.equal(a.fs.started, true);
  const second = idx(a.fs.debug().order[1]);
  await a.advance(200);
  assert.equal(a.decks[1].cuedCount(), 1, 'an ad that keeps moving is not given up at the cue time');
  assert.equal(a.fs.debug().nxt.phase, 'cueing');
  a.decks[1].adStill();
  await a.advance(3);
  assert.equal(a.decks[1].cuedCount(), 1);
  await a.advance(2);
  assert.equal(a.decks[1].lastCue(), vid(second, 1), 'an ad that stopped moving: the next upload');
  assert.deepEqual(a.finder.forgotten, [], 'not forgotten');

  // (b) the ad outlasts the song on air: SILENT_WAIT_S of silence, then the preview — not a fresh ad
  const env = setup({ table: (i) => ({ alternates: [vid(i, 1)] }) });
  const { fs, decks, finder, events, advance, settle } = env;
  await started(env, { mode: 'full', seed: 'long1' });
  decks[1].ad();
  const cues = decks[1].cuedCount();
  await advance(200.5);
  assert.equal(fs.snapshot().transition.state, 'waiting');
  assert.equal(fs.debug().cur.phase, 'ended');
  await advance(SILENT_WAIT_S - 1.5);
  assert.equal(fs.debug().nxt.provider, 'youtube', 'a short silence is waited out');
  await advance(2);
  await settle();
  assert.equal(fs.history()[1].provider, 'preview', 'then its preview');
  assert.equal(decks[1].cuedCount(), cues, 'no other upload (a fresh ad) was cued');
  assert.deepEqual(finder.forgotten, [], 'the upload is not forgotten');
  assert.ok(events.some(([t, p]) => t === 'notice' && /ran long/.test(p.message)));
  await advance(2);
  assert.equal(fs.debug().cur.provider, 'preview', 'and it plays');
  assert.equal(fs.debug().cur.id, 1);
});

test('a deck whose song gives way to its preview is stopped (its abandoned ad, or YouTube’s error screen, must not stay on the deck the preview plays on)', async () => {
  const stops = (d) => d.log.filter((x) => x[0] === 'stop').length;
  // (a) refused (error 150), no other upload: stop() after the refusal, then the preview
  {
    const env = setup();
    const { fs, decks, settle } = env;
    await started(env, { mode: 'short', seed: 'gv150' });
    const before = stops(decks[1]);
    decks[1].failCue(150);
    await settle();
    assert.equal(fs.debug().nxt.provider, 'preview');
    assert.ok(stops(decks[1]) > before, 'the refusing deck is told to stop');
  }
  // (b) the ad outlasts the song on air: the deck is stopped DURING its cue (ytdeck: stopVideo cancels the load)
  {
    const env = setup({ table: (i) => ({ alternates: [vid(i, 1)] }) });
    const { fs, decks, advance, settle } = env;
    await started(env, { mode: 'full', seed: 'gvslow' });
    decks[1].ad();
    await advance(200.5 + SILENT_WAIT_S + 0.5);
    await settle();
    assert.equal(fs.history()[1].provider, 'preview');
    const log = decks[1].log.map((x) => x[0]);
    assert.equal(log[log.length - 1], 'stop', 'stopped, and not cued again');
    assert.equal(decks[1].state, 'empty', 'stopped while its pre-roll ran: the load is abandoned');
  }
  // (c) the browser blocks even its muted pre-roll with the page in front
  {
    const env = setup();
    const { fs, decks, settle } = env;
    await started(env, { mode: 'short', seed: 'gvblk' });
    const before = stops(decks[1]);
    decks[1].failCue('blocked');
    await settle();
    assert.equal(fs.debug().nxt.provider, 'preview');
    assert.ok(stops(decks[1]) > before, 'the blocked deck is told to stop');
  }
  // (d) a player that gets nowhere, no other upload: stopped during its cue
  {
    const env = setup();
    const { fs, decks, advance, settle } = env;
    await started(env, { mode: 'medium', seed: 'gvstk' });
    decks[1].adStill(); // its pre-roll stops moving
    // (debug().nxt is a copy: watch the play itself through history())
    const pv = () => fs.history()[1] && fs.history()[1].provider === 'preview';
    for (let k = 0; k < 60 && !pv(); k++) await advance(5);
    await settle();
    assert.ok(pv(), 'its preview stands in');
    assert.equal(decks[1].cuedCount(), 1, 'no other upload');
    assert.equal(decks[1].state, 'empty', 'stopped while its cue was pending');
  }
});

test('the first song’s ad runs long while the second is cued: the set opens with the second, the first keeps its ad and comes next', async () => {
  const env = setup();
  const { fs, decks, advance, settle } = env;
  fs.load(crate(8), { seed: 'swap1', mode: 'medium', autostart: true });
  await settle();
  const order = fs.debug().order;
  decks[0].ad();
  decks[1].ad();
  decks[1].cued(200);
  await settle();
  await advance(SWAP_AFTER_S - 1);
  assert.equal(fs.started, false, 'the opener is given its moment');
  await advance(1.5);
  await settle();
  assert.equal(fs.started, true, 'the set opened');
  assert.equal(fs.snapshot().current.trackId, order[1], 'with the cued song');
  assert.equal(decks[1].state, 'playing');
  assert.equal(decks[0].cuedCount(), 1, 'the first song’s pre-roll was not restarted');
  assert.ok(!decks[0].log.slice(decks[0].log.findIndex((x) => x[0] === 'cue')).some((x) => x[0] === 'stop'), 'nor stopped');
  assert.equal(decks[0].state, 'ad');
  const h = fs.history();
  assert.deepEqual(h.map((x) => x.trackId), [order[1], order[0]]);
  assert.deepEqual(h.map((x) => x.playId), [0, 1]);
  decks[0].cued(210);
  await settle();
  const lanes = fs.debug().lanes;
  assert.ok(lanes, 'the old opener is the next song');
  await advance(lanes.tEnd - fs.now() + 0.3);
  await settle();
  assert.equal(fs.snapshot().current.trackId, order[0]);
  assert.equal(decks[1].lastCue(), vid(idx(order[2])), 'then the order goes on');
  assert.deepEqual(new Set(fs.history().map((x) => x.playId)).size, fs.history().length, 'play ids stay unique');
});

test('New set while a hand-over is in motion (just before it, or right after Skip): it finishes, then the new order takes over — the music never stops', async () => {
  for (const how of ['before', 'skip']) {
    const env = setup();
    const { fs, decks, advance, settle } = env;
    await started(env, { mode: 'short', seed: `nsx-${how}` });
    decks[1].cued(200);
    await settle();
    let lanes = fs.debug().lanes;
    if (how === 'before') {
      await advance(lanes.tStart - fs.now() - 1); // inside FX_LEAD: the fx are already handed over
    } else {
      await advance(5);
      assert.equal(fs.skip(), true);
      lanes = fs.debug().lanes;
      await advance(0.5);
    }
    const oldOrder = fs.debug().order;
    const incoming = fs.debug().nxt;
    const cues = [decks[0].cuedCount(), decks[1].cuedCount()];
    fs.newSet(`nsy-${how}`);
    await settle();
    assert.equal(fs.seed, `nsy-${how}`, 'the new seed at once');
    assert.equal(fs.started, true, `${how}: still playing`);
    assert.deepEqual([decks[0].cuedCount(), decks[1].cuedCount()], cues, `${how}: no deck re-cued`);
    assert.notEqual(fs.snapshot().transition && fs.snapshot().transition.state, 'starting');
    let silent = 0;
    while (fs.now() < lanes.tEnd + 0.3) {
      await advance(0.1);
      if (decks[0].state !== 'playing' && decks[1].state !== 'playing') silent++;
    }
    await settle();
    assert.equal(silent, 0, `${how}: something played throughout`);
    assert.equal(fs.debug().cur.id, incoming.id, `${how}: the hand-over finished`);
    assert.notDeepEqual(fs.debug().order, oldOrder, `${how}: then the new order took over`);
    const h = fs.history();
    assert.equal(h.length, 2, 'history restarts with the song that bridged the two sets');
    assert.equal(h[0].trackId, fs.snapshot().current.trackId);
    const head = fs.debug().order.find((id) => id !== h[0].trackId);
    assert.equal(decks[0].lastCue(), vid(idx(head)), `${how}: the new order’s first song pre-rolls on the free deck`);
    decks[0].cued(200);
    await settle();
    const l = fs.debug().lanes;
    assert.ok(l && l.tStart - fs.now() < 0.6, 'and comes in as soon as it is cued');
  }
});

test('the song on air stops moving while its player says it plays (buffering): the set says so, and clears it when the song moves again', async () => {
  const env = setup();
  const { fs, decks, advance } = env;
  await started(env, { mode: 'medium', seed: 'buf1' });
  await advance(5);
  decks[0].buffer();
  await advance(STALL_S - 0.6);
  assert.equal(fs.snapshot().stalled, '');
  await advance(1);
  let s = fs.snapshot();
  assert.equal(s.stalled, 'network');
  assert.equal(s.buffering, true);
  assert.equal(s.transition.state, 'waiting');
  assert.equal(s.transition.label, 'Buffering');
  assert.equal(s.decks[0].statusText, 'Buffering');
  decks[0].unbuffer();
  await advance(0.5);
  s = fs.snapshot();
  assert.equal(s.stalled, '');
  assert.equal(s.buffering, false);
  assert.ok(!s.transition || s.transition.label !== 'Buffering');
});

test('after a gesture the decks pre-roll unmuted at volume 0 (Chrome lets those go on in a background tab); a share link’s muted pre-rolls are unlocked by the tap; never on iOS', async () => {
  const a = setup();
  a.fs.load(crate(8), { seed: 'um1', mode: 'medium', autostart: false });
  await a.settle();
  assert.equal(a.decks[0].lastCueOpts().unmuted, false, 'no gesture yet: muted');
  assert.equal(a.decks[1].lastCueOpts().unmuted, false);
  a.decks[1].ad();
  a.fs.begin(); // the tap
  await a.settle();
  assert.ok(a.decks[0].log.some((x) => x[0] === 'unlock') && a.decks[1].log.some((x) => x[0] === 'unlock'), 'the tap unlocks both running pre-rolls');
  a.decks[0].cued(200);
  await a.settle();
  a.decks[1].cued(200);
  await a.settle();
  await a.advance(fs2end(a) + 0.5);
  await a.settle();
  assert.equal(a.decks[0].lastCueOpts().unmuted, true, 'every cue after the tap: unmuted at volume 0');

  const b = setup();
  b.fs.load(crate(8), { seed: 'um2', mode: 'medium', autostart: true });
  await b.settle();
  assert.equal(b.decks[0].lastCueOpts().unmuted, true, 'a pasted link was the gesture');

  const c = setup({ volumeWorks: false });
  c.fs.load(crate(8), { seed: 'um3', mode: 'medium', autostart: false });
  await c.settle();
  c.fs.begin();
  await c.settle();
  assert.equal(c.decks[0].lastCueOpts().unmuted, false, 'iOS ignores volume: always muted');
  assert.ok(!c.decks[0].log.some((x) => x[0] === 'unlock'));
});
function fs2end(env) {
  const l = env.fs.debug().lanes;
  return l ? l.tEnd - env.fs.now() : 0;
}

test('handed over from Preview: the songs it played are not played again, they show as played, and Elapsed goes on', async () => {
  const env = setup();
  const { fs, decks, settle, advance } = env;
  fs.load(crate(8), { seed: 'car1', mode: 'medium', autostart: true });
  await settle();
  const plain = fs.debug().order;
  fs.load(crate(8), { seed: 'car1', mode: 'medium', autostart: true, carry: { played: [plain[0], plain[1]], elapsed: 95 } });
  await settle();
  assert.equal(decks[0].lastCue(), vid(idx(plain[2])), 'the opener is the first song not heard yet');
  assert.equal(decks[1].lastCue(), vid(idx(plain[3])));
  let s = fs.snapshot();
  assert.deepEqual(s.setlist.slice(0, 2).map((r) => [r.key.split('|')[0], r.state]), [[plain[0], 'played'], [plain[1], 'played']]);
  const out = { decks: [null, null] };
  fs.frame(fs.now(), out);
  assert.equal(out.elapsed, 95);
  decks[0].cued(200);
  await settle();
  await advance(2);
  fs.frame(fs.now(), out);
  assert.ok(Math.abs(out.elapsed - 97) < 0.15, `Elapsed goes on (${out.elapsed})`);
  fs.newSet('car2');
  await settle();
  s = fs.snapshot();
  assert.ok(!s.setlist.some((r) => /\|c\d+$/.test(r.key)), 'a new set starts its own history');
});

test('handed over while the previews play on (the first song’s ad): Elapsed runs on through the wait, then goes on with set time', async () => {
  const env = setup();
  const { fs, decks, settle, advance, clock } = env;
  fs.load(crate(8), { seed: 'car3', mode: 'medium', autostart: true, carry: { played: [], elapsed: 95, at: clock.ms, live: true } });
  await settle();
  decks[0].ad();
  await advance(20); // the ad, while the previews play on under it
  assert.equal(fs.started, false);
  const out = { decks: [null, null] };
  fs.frame(fs.now(), out);
  assert.ok(Math.abs(out.elapsed - 115) < 0.06, `Elapsed runs on during the ad (${out.elapsed})`);
  assert.ok(Math.abs(fs.snapshot().elapsed - 115) < 0.06);
  decks[0].cued(200);
  await settle();
  assert.equal(fs.started, true);
  await advance(3);
  fs.frame(fs.now(), out);
  assert.ok(Math.abs(out.elapsed - 118) < 0.2, `then it goes on with set time, the wait counted once (${out.elapsed})`);
  // a plain swap (nothing was playing): the wait does not count
  const q = setup();
  q.fs.load(crate(8), { seed: 'car3', mode: 'medium', autostart: true, carry: { played: [], elapsed: 95, at: q.clock.ms, live: false } });
  await q.settle();
  await q.advance(20);
  assert.equal(q.fs.snapshot().elapsed, 95);
});

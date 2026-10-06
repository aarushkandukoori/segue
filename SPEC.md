# Segue — build contract

**Segue**: paste a Spotify playlist link, get a live DJ set in the browser. Beat-matched blends, EQ bass
swaps, filter sweeps, echo-outs, spinbacks, drops. Every time you press play the set is different
(seeded: track order, cue points, transition styles, FX tricks). Tagline: *"Your playlist, DJ'd live.
Never the same set twice."*

This file is the contract between modules. If you must deviate, keep the deviation minimal, and record
it in your `handoff/<area>.md` so the integrator sees it.

## 0. Hard constraints

- **Static site.** GitHub Pages, served from a sub-path (`/segue/`). No backend, no build step, no
  bundler, **no runtime dependencies** — vanilla ES modules, relative URLs only (`./js/...`).
- **Never fetch, decode or mix Spotify audio** (`audioPreview` / `p.scdn.co`). Spotify's developer
  policy forbids mixing/overlapping Spotify content. Spotify is used for the *track list only*.
  Audio = 30-second previews from **Deezer** (primary) and **Apple iTunes** (fallback), or the user's
  own local files (full length).
- Untrusted strings (titles, artists, playlist names, anything from the network or a file) go into the
  DOM with `textContent` / attribute setters only. Never `innerHTML` with dynamic data. Image/audio/link
  URLs must be `https:` (or `blob:` for local files) before use.
- Target: current Chrome, Safari (incl. iOS) and Firefox (what has actually been run is in README.md,
  "Honest limits"). AudioContext is created/resumed only inside a user gesture. No
  `cancelAndHoldAtTime` without a fallback (Firefox lacks it). No negative `playbackRate` (Chrome
  outputs silence).
- The page runs under a Content-Security-Policy (`index.html`, same in `ui-demo.html`): scripts from
  `'self'`, `https://api.deezer.com` (JSONP) and `https://www.youtube.com` (the IFrame Player API) only,
  frames from `https://www.youtube-nocookie.com` / `https://www.youtube.com` only, no inline script or
  style (`style="…"` attributes and `<style>` elements are refused; CSSOM writes are fine),
  `connect-src 'self' https:`, images `'self'` / `https:` / `data:` / `blob:`, media `blob:` only, workers
  `'self'` only, fonts from Google Fonts, `object-src` / `base-uri` / `form-action` `'none'`. Exactly:
  `default-src 'self'; script-src 'self' https://api.deezer.com https://www.youtube.com; connect-src 'self' https:; img-src 'self' https: data: blob:; media-src blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`
- Code style: small pure functions, JSDoc types on exports, no classes needed, no frameworks. Comments
  explain *why*, not what. `node --test` for pure logic; headless Chrome (puppeteer-core) for anything
  touching Web Audio / DOM / network-from-a-browser.

## 1. Verified platform facts (tested 2026-10-05 from a real browser origin)

| Thing | Result |
|---|---|
| `https://open.spotify.com/embed/playlist/<id>` (also `/embed/album/<id>`) | HTML contains `<script id="__NEXT_DATA__" type="application/json">`; `props.pageProps.state.data.entity` = `{type, name, title, subtitle, id, uri, coverArt:{sources:[{url}]}, trackList:[{uri:"spotify:track:<id>", title, subtitle /*artists*/, duration /*ms*/, isExplicit, isPlayable, audioPreview /*DO NOT USE*/}]}`. No CORS header → needs a relay. |
| Relay 1: `https://web.scraper.workers.dev/?url=<enc>&selector=<enc 'script#__NEXT_DATA__'>&scrape=text` | 200, `access-control-allow-origin: *`, JSON `{result:{"script#__NEXT_DATA__":["<json string>"]}}` |
| Relay 2: `https://r.jina.ai/<url>` with header `X-Return-Format: html` | 200, CORS ok (reflects origin), full HTML incl. `__NEXT_DATA__`. Without the header returns markdown: `1.   ### Title\n\n#### [E ]Artist,Artist\n\n03:45` (usable last-resort parse; `E ` = explicit badge). |
| Relay 3: `https://api.microlink.io/?url=<enc>&data.next.selector=%23__NEXT_DATA__&data.next.attr=text` | 200, CORS `*`, JSON `{status:"success", data:{next:{props:…}}}` (already parsed). 25 req/day per visitor IP. |
| Generic public CORS proxies (corsproxy.io, allorigins, codetabs, thingproxy, cors.eu.org …) | all failing (401/429/5xx). Do not rely on them. |
| `https://open.spotify.com/oembed?url=<spotify url>` | CORS `*`; `{title, thumbnail_url}` only (works for tracks and playlists) |
| Deezer API `https://api.deezer.com/...` | **No** `Access-Control-Allow-Origin` → browser must use **JSONP** (`&output=jsonp&callback=<fn>`), works. Node tests can `fetch` it directly. Quota 50 req / 5 s. Endpoints: `/search?q=…`, `/playlist/<id>`, `/album/<id>`, `/chart/<genreId>/tracks?limit=50` (0 = all, 132 Pop, 116 Rap, 152 Rock, 113 Dance, 165 R&B, 106 Electro, 197 Latin …), `/track/<id>` (has `bpm`, often 0). Track objects: `{id, title, title_short, duration /*s*/, preview, link, explicit_lyrics, artist:{name}, album:{title, cover_medium, cover_big}}` |
| Deezer preview mp3 (`cdnt-preview.dzcdn.net/...mp3?hdnea=exp=…`) | CORS `*`, ~480 KB, 30 s, 128 kbps. **Signed URL that expires** — fetch soon after resolving, keep the bytes. |
| iTunes Search `https://itunes.apple.com/search?term=…&entity=song&limit=5` | CORS `*`. **~20 requests/minute per IP** → fallback only, serialize + throttle. Results: `{trackId, trackName, artistName, trackTimeMillis, previewUrl, artworkUrl100, trackViewUrl}` |
| iTunes preview m4a (`audio-ssl.itunes.apple.com/...p.m4a`) | CORS `*`, ~1 MB, 30 s AAC. `decodeAudioData` works in Chrome/Safari/Firefox. |
| Headless Chrome | `decodeAudioData` of both preview formats OK, module Workers OK, AudioContext 48 kHz. |

## 2. Layout and ownership

```
index.html                      [ui]
css/style.css (+ more)          [ui]
ui-demo.html                    [ui]    mock-driven harness for the view (no audio)
js/main.js                      [integrator]  bootstrap: view <-> conductor wiring, URL params, rAF loop
js/util/rng.js                  [brain]
js/util/{timers,timer-worker}.js   [integrator]  the full-song clock: timers on a dedicated worker (not throttled in a background tab), §6.4
js/sources/{spotify,deezer,itunes,resolver,local,text,demo,index}.js   [sources]
js/analysis/{dsp,tempo,grid,key,features,analyze,worker,client}.js      [analysis]  grid.js = beat grid vs. the audible attacks (Analysis.grid)
js/dj/timeline.js               [foundation — DONE, do not change semantics]
js/dj/{camelot,transitions,planner}.js   [brain]
js/dj/{engine,fx,recorder}.js   [engine]
js/dj/conductor.js              [integrator]  previews + local files (Web Audio)
js/dj/fullset.js                [integrator]  full songs (YouTube decks), §6
js/dj/{ytdeck,videomix}.js      [engine] / [brain]  §6
js/sources/youtube.js           [sources]  §6
js/ui/*.js                      [ui]    (fonts.js switches the deferred Google Fonts stylesheet on; no other module touches the network)
tests/*.test.js                 node --test (each area prefixes its files: analysis.*.test.js, dj.*.test.js, sources.*.test.js)
tests/helpers/*.js              synthetic analyses / audio, and the evaluations on real previews (need tests/fixtures; skip without)
tests/tools/fetch-fixtures.mjs  downloads the preview fixtures into tests/fixtures/ (never committed)
tests/e2e/serve.mjs, browser.mjs   [foundation — DONE] static server (ephemeral port) + headless Chrome launcher
tests/e2e/<area>.e2e.mjs        headless-Chrome scripts, exit code 0 = pass
tests/fixtures/                 git-ignored scratch (downloaded audio etc.). NEVER commit audio.
handoff/<area>.md               git-ignored notes for the integrator: API as built, deviations, known issues
```

Only edit files you own. Shared files (`package.json`, `SPEC.md`, `js/dj/timeline.js`, `tests/e2e/serve.mjs`,
`tests/e2e/browser.mjs`) are frozen for builders; the integrator may change them.

E2E pattern:

```js
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';
const srv = await startServer();                 // ephemeral port, serves repo root, no-store
const { page, errors, logs, close } = await launch({ width: 1440, height: 900 });
await page.goto(srv.url + '/tests/e2e/whatever.html');
const result = await page.evaluate(async () => { /* runs in Chrome; AudioContext/OfflineAudioContext available */ });
await close(); await srv.close();
process.exit(ok ? 0 : 1);
```

## 3. Data contracts

All times are **seconds**. "Set time" = seconds since the set started (engine maps it to `AudioContext`
time). "Buffer position" = seconds into a track's decoded audio.

```js
/** @typedef {Object} TrackMeta
 * @property {string} id          unique within the playlist: "spotify:track:<id>" | "deezer:<id>" | "text:<n>" | "local:<n>"
 * @property {string} title
 * @property {string} artist      display string (artists joined with ", ")
 * @property {number} [durationMs] full-track duration when the source knows it
 * @property {boolean} [explicit]
 * @property {string} [link]      canonical https URL of the track at its source ("Open in Spotify")
 * @property {string} [artwork]   https image URL if known
 * @property {{url:string, provider:'deezer'|'itunes', id:string}} [preview]  preview already known (Deezer sources)
 * @property {File} [file]        local file (source 'local')
 */

/** @typedef {Object} Playlist
 * @property {string} id          e.g. "spotify:playlist:37i9…", "deezer:chart:113", "local:…", "text:…"
 * @property {'spotify'|'deezer'|'text'|'local'} source
 * @property {string} title
 * @property {string} [subtitle]  owner / description
 * @property {string} [link]
 * @property {string} [artwork]
 * @property {TrackMeta[]} tracks
 * @property {number} [total]     track count at the source, if larger than tracks.length
 */

/** @typedef {Object} AudioRef    — result of resolver.resolveTrack()
 * @property {'deezer'|'itunes'|'local'} provider
 * @property {string} key         cache identity: "deezer:<id>" | "itunes:<id>" | "local:<name>:<size>:<lastModified>"
 * @property {string} [url]       https, CORS-enabled
 * @property {File} [file]
 * @property {boolean} isPreview
 * @property {number} matchScore  0..1 (1 when the source already supplied the audio)
 * @property {string} matchedTitle
 * @property {string} matchedArtist
 * @property {string} [artwork]
 * @property {string} [link]
 * @property {number} [bpmHint]   provider-supplied BPM if > 0
 */

/** @typedef {Object} Analysis
 * @property {number} v              ANALYSIS_VERSION (2 since Analysis.grid; cached results of another version are recomputed)
 * @property {number} duration
 * @property {number} bpm            global tempo folded into [70, 180)
 * @property {number} bpmConfidence  0..1; ≥ 0.5 means "the TEMPO is trustworthy enough to beat-match" (never below grid.phase once
 *                                   that reaches 0.5: attacks that sit on the beats prove a grid). Whether two stretches may be
 *                                   overlapped beat on beat is a second question, answered by `grid` below."
 * @property {number[]} beats        beat times, strictly increasing, covering the whole track (extrapolated on the grid through quiet parts)
 * @property {number} downbeat       index into beats of the first bar start. Bars are 4 beats: i is a downbeat iff (i - downbeat) % 4 === 0
 * @property {{pc:number, mode:'major'|'minor', name:string, camelot:string, confidence:number}} key   pc 0=C … 11=B; camelot like "8A"
 * @property {{rms:number, peak:number, trimDb:number}} loudness   trimDb = gain that brings the loud parts to −16 dBFS RMS, clamped to [−12, +6] and never lifting the peak above −1 dBFS
 * @property {number} energy         0..1 intensity vs. typical pop/dance masters (loudness + percussive density + brightness)
 * @property {number[]} energyCurve  one value per second, 0..1 relative to the track's own max
 * @property {{start:number, end:number, in:number, drop:number|null}} cues
 *           start/end = usable region (after a fade-in, before a fade-out / trailing silence)
 *           in = first downbeat ≥ start;  drop = downbeat with the biggest sustained energy jump, or null
 * @property {{cols:number, perSec:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array}} wave   peak 0..255 per column per band, perSec = 100
 * @property {{phase:number, head:number, tail:number, perBeat:number, slots:Uint8Array}} grid
 *           How far the beat PHASE can be trusted (a track can have a rock-solid tempo and still carry its loud hits
 *           between the beats). Measured on a 1 ms attack envelope that is linear in amplitude (js/analysis/grid.js).
 *           phase       0..1 over the whole usable region: do the loud attacks sit ON the beats, clearly and all the way through?
 *           head / tail 0..1, the same question for the first / last 16 beats of the usable region — where a preview is blended
 *                       into and out of (the 8 beats nearest the edge count double). ≥ 0.5 = this end can be overlapped beat on beat.
 *           perBeat     16
 *           slots       perBeat values per beat (beats.length × perBeat), 0..255: mean attack strength in each sixteenth of every
 *                       beat, slot 0 centred on the beat. The planner lays two tracks' slots over each other before it overlaps them.
 *           All zero when there is no tempo to speak of. Optional for the planner: an analysis without `grid` (hand-made, tests)
 *           is taken at its bpmConfidence.
 */

/** Automation event; mirrors AudioParam scheduling. `t` is set time.
 * @typedef {Object} Ev
 * @property {string} p   strip params: 'gain' 'src' 'low' 'mid' 'high' 'hpf' 'lpf' 'delaySend' 'reverbSend'
 *                        FX-bus params (only inside fxEvents): 'delayTime' 'delayFeedback' 'fxReturn'
 * @property {number} t
 * @property {number} v
 * @property {'set'|'lin'|'exp'|'tgt'} k   set → setValueAtTime · lin → linearRampToValueAtTime · exp → exponentialRampToValueAtTime · tgt → setTargetAtTime(v, t, tc)
 * @property {number} [tc]
 */

/** @typedef {{t:number, v:number, ramp?:boolean}} RatePoint   see js/dj/timeline.js */

/** @typedef {Object} Play          — one track's appearance in the set
 * @property {number} id            0, 1, 2 … in set order
 * @property {string} trackId
 * @property {0|1} deck             UI side, alternates
 * @property {number} startAt       set time the main source starts
 * @property {number} offset        buffer position at startAt
 * @property {RatePoint[]} rate     rate[0].t === startAt; rate > 0 always
 * @property {number} trimDb
 * @property {Ev[]} events          strip automation sorted by t. MUST contain a 'set' for every param it later ramps. Grows when the outgoing transition is planned.
 * @property {number|null} endAt    set time the main source stops; null until the outgoing transition is planned
 * @property {number} soloFrom      set time its incoming transition ends
 * @property {string} [via]         type of the transition that brought it in (planner bookkeeping; the engine ignores it)
 */

/** One-shot effects.
 * @typedef {(
 *   {kind:'riser',  t:number, dur:number, gain:number} |                      // noise sweep rising into t+dur, hard stop at t+dur
 *   {kind:'impact', t:number, gain:number} |                                  // boom + crash on a downbeat
 *   {kind:'loop',   playId:number, t:number, dur:number, offset:number, len:number, rate:number} |   // repeat buffer slice [offset, offset+len) through that play's strip for dur seconds (beat repeat / roll)
 *   {kind:'reverse',playId:number, t:number, dur:number, offset:number, len:number, rate0:number, rate1:number}  // spinback: slice [offset-len, offset) played backwards through that play's strip, rate ramps rate0→rate1
 * )} Fx
 */

/** @typedef {Object} Transition
 * @property {number} id
 * @property {'fadeIn'|'bassSwap'|'eqBlend'|'filterBlend'|'echoOut'|'reverbWash'|'cut'|'spinback'|'brake'|'loopRoll'|'riserDrop'} type
 * @property {string} label      "Bass swap · 16 beats"
 * @property {string} why        one short line for the UI: "126 → 124 BPM (−1.6%) · 8A → 9A". The bracket is the incoming track's pitch
 *                               change while matched ("±0.0%" when it rounds to none). A move that is not a beat-matched blend ends
 *                               with the reason, true of THIS pair: "no steady beat detected in the incoming track | the outgoing
 *                               track | either track", "tempos too far apart to match", "tempos match, but the drums would clash —
 *                               kept apart" (held by the gate), "double-time | half-time apart, not blended", "no room left for a
 *                               blend", "chosen for variety"
 * @property {number} from       outgoing playId, −1 for the first track
 * @property {number} to         incoming playId
 * @property {number} tStart     set time of the first audible change
 * @property {number} tEnd       set time the incoming track is solo (outgoing dry signal gone; FX tails may still ring)
 * @property {number} beats      nominal length in beats of the outgoing track (0 for hard cuts)
 * @property {boolean} synced    true if the tracks are beat-matched during the overlap
 * @property {number} bpm        master tempo during the transition
 * @property {Ev[]} aEvents      events to append to the outgoing play's strip
 * @property {RatePoint[]} aRate rate points to append to the outgoing play (brake), usually []
 * @property {number} aEndAt     set time to stop the outgoing source (≥ tEnd)
 * @property {Play} play         the incoming play, complete (entry automation + glide of its rate back to 1.0)
 * @property {Fx[]} fx
 * @property {Ev[]} fxEvents     FX-bus automation
 * @property {{t:number, label:string}[]} marks   moments for the UI ticker ("Bass swap", "Drop", "Echo out")
 * @property {{ok:boolean, out:number, in:number, contrast?:number}} [trust]   blends only: what the overlap gate made of the two
 *           stretches. out / in = grid trust (0..1) of the outgoing tail / incoming head over the overlap; contrast = how much
 *           better the two slot patterns fit beat on beat than at any other offset (only when both analyses carry slots);
 *           ok = the gate would let this overlap through (false only on a blend that was forced, e.g. by a test).
 */
```

### Strip signal path and params (engine realizes exactly this)

```
main BufferSource ─▶ src (gain) ─┐
loop / reverse one-shot sources ─┴▶ trim (const, play.trimDb) ▶ low ▶ mid ▶ high ▶ hpf ▶ lpf ▶ fader ('gain') ─▶ master bus
                                                                                         fader ─▶ delaySend ─▶ delay bus
                                                                                         fader ─▶ reverbSend ─▶ reverb bus
delay bus: DelayNode('delayTime') with feedback loop (gain 'delayFeedback', HPF 250 Hz + LPF 4.5 kHz in the loop) ─▶ 'fxReturn' ─▶ master bus
reverb bus: ConvolverNode (generated ~2.8 s IR) ─▶ master bus
risers / impacts ─▶ master bus
master bus ─▶ master gain ─▶ limiter (DynamicsCompressor, fast) ─▶ analyser ─▶ destination (+ recorder tap)
```

| param | unit | default | notes |
|---|---|---|---|
| `gain` | linear | 1 | channel fader |
| `src` | linear | 1 | mutes the main source only (during rolls / spinbacks) |
| `low` `mid` `high` | dB | 0 | lowshelf ≈ 220 Hz, peaking ≈ 1 kHz (Q ≈ 0.8), highshelf ≈ 3.2 kHz. "Kill" ≈ −28 dB |
| `hpf` | Hz | 20 | highpass cutoff, Q ≈ 1 |
| `lpf` | Hz | 20000 | lowpass cutoff, Q ≈ 1 |
| `delaySend` `reverbSend` | linear | 0 | post-fader sends (cutting the fader stops feeding the FX but the tail rings on) |
| `delayTime` | s | 0.375 | FX bus; planner sets it to a beat fraction |
| `delayFeedback` | linear | 0.5 | FX bus, ≤ 0.85 |
| `fxReturn` | linear | 1 | FX bus (delay return) |

Automation rules (so every browser matches `evalParam` in `timeline.js`): events sorted by `t`; every ramp
has an anchoring event before it on the same param; `exp` never touches 0 (frequencies only, basically);
a `tgt` is followed, if by anything, by a `set`.

## 4. Module APIs

### analysis (`js/analysis/`)

```js
// analyze.js — pure, runs in Node and in a Worker
export const ANALYSIS_VERSION: number
export function analyzeTrack(mono: Float32Array, sampleRate: number, opts?: {bpmHint?: number}): Analysis
// client.js — main thread
export function createAnalyzer({ workers?: number }): {
  analyze(buffer: AudioBuffer, { key: string, bpmHint?: number }): Promise<Analysis>,  // downmix/downsample on main thread, analyze in a module Worker (fallback: main thread in idle slices), cache by key+version in IndexedDB (fallback: memory)
  cached(key: string): Promise<Analysis|null>,
  destroy(): void
}
```
Budgets: 30 s preview ≤ 250 ms in the worker; 5-minute track ≤ 3 s. Must not throw on silence, on clips
< 5 s, on beatless/ambient audio (then `bpmConfidence` ≈ 0, `grid` is all zero and `beats` is still a valid
regular grid).

Cache: keyed by `AudioRef.key` + `ANALYSIS_VERSION` in IndexedDB — previews only. Keys that start with
`local:` (they contain the file's name) are kept in memory for the session and never written; records
under such keys left by earlier builds are deleted when the database opens. The store is cleared when it
is found above 2,000 records.

### sources (`js/sources/`)

```js
// index.js
export function parseInput(text: string): {kind:'spotify'|'deezer'|'text'|'unknown', type?: 'playlist'|'album'|'chart'|'track', id?: string}
export async function loadPlaylist(input: string, opts?: {signal?: AbortSignal, onStatus?: (msg:string)=>void}): Promise<Playlist>   // Spotify/Deezer URL or URI, "deezer:chart:113", or multi-line "Artist - Title" text
export function playlistFromFiles(files: File[]): Playlist
export const DEMOS: {id:string, label:string, emoji:string, input:string}[]     // Deezer genre charts — always fresh, never needs a relay
export const EXAMPLES: {label:string, url:string}[]                             // a few famous public Spotify playlists
// resolver.js
export function createResolver(): {
  resolveTrack(track: TrackMeta, opts?: {signal?: AbortSignal}): Promise<AudioRef>,   // throws ResolveError('no-match'|'network'|…) — Deezer JSONP search first, iTunes fallback (throttled), local/Deezer tracks resolve instantly
  fetchAudio(ref: AudioRef, opts?: {signal?: AbortSignal}): Promise<ArrayBuffer>      // re-resolves once if a signed URL expired (403)
}
```
Spotify fetch = fallback chain over relays 1→2→3 (+ markdown parse of relay 2 as last resort), each with a
timeout, validated by actually finding a non-empty `trackList`. Relay answers are not trusted for size
either: bodies are read as a stream and dropped past 2 MB (`SourceError('too-large')`, the next relay is
asked), parsers are linear in their input, and at most `SPOTIFY_MAX_TRACKS` (200) songs are kept — the
embed itself stops at 100; `Playlist.total` carries the real count for the "first N of M" note.

Preview downloads (`util.js download()`, used by `fetchAudio`) are judged by progress, not by a fixed
deadline: a download is given up only after 15 s without a byte on ANY audio download of the same
resolver (CDNs serve parallel responses one after the other on a slow line; waiting in line is not a
dead connection), with a 2-minute backstop and a size cap. Errors are typed and human-readable
("That playlist is private or doesn't exist", "Couldn't reach Spotify — try again"). Matching must
normalize titles (strip `feat.`, `- Remastered 2011`, bracketed suffixes, diacritics, case) and use the
duration when known; reject weak matches rather than play the wrong song.

### brain (`js/util/rng.js`, `js/dj/{camelot,transitions,planner}.js`)

```js
// rng.js
export function createRng(seed: number|string): { next(): number /*[0,1)*/, int(n), range(a,b), pick(arr), weighted(items, weights), shuffle(arr) /*copy*/, fork(label): Rng }
export function randomSeed(): string        // 6 chars base36, uses crypto
// camelot.js
export function camelot(pc, mode): string;  export function keyCompat(a: Analysis['key'], b: Analysis['key']): number /*0..1*/
// planner.js
export function createPlanner(opts: { seed: string|number, vibe?: number /*0 smooth … 1 wild, default 0.5*/, mode?: 'preview'|'short'|'medium'|'full' }): {
  order(trackIds: string[]): string[],                                   // seeded base order of the crate
  chooseNext(current: {id, artist, analysis}|null, candidates: {id, artist, analysis}[], ctx: {playIndex: number, recentArtists: string[]}): number,   // index into candidates
  first(track: {id, analysis}, opts?: {startAt?: number}): Transition,   // type 'fadeIn', from −1
  next(prev: {play: Play, analysis: Analysis}, incoming: {id, analysis}, opts: {earliest: number, quick?: boolean}): Transition,
  setVibe(v), setMode(m),   // live controls: affect plans made from now on (plans stay a pure function of seed + vibe + mode + inputs)
}
export function holdPlayAt(play: Play, t: number): Play   // the play as the engine holds it after engine.cancelFrom(t) (Skip)
```
- Pure and deterministic: same seed + same inputs ⇒ identical output (deep-equal), regardless of call
  history (derive sub-RNGs from `seed` + play id; never use `Math.random`/`Date`).
- `mode`: `'preview'` for ≤ 45 s clips (use the whole clip, 8/16-beat transitions); `'short'` ≈ 45 s,
  `'medium'` ≈ 90 s, `'full'` = play to the outro, for full-length local files (16/32-beat transitions).
  The planner must also work when a clip is shorter than expected (degrade to short fades / cuts).
- `next()` must return a plan with `tStart ≥ opts.earliest` and all new events at `t ≥ opts.earliest`.
  If the outgoing track has too little audio left for the chosen transition it picks a shorter one; if the
  outgoing track is already over (or ends before `earliest`) it returns a plain entry for the incoming
  track at `earliest`. `quick: true` (user pressed Skip) ⇒ short transition starting at the first beat
  ≥ earliest.
- Beat-matching: when tempos (after ×2 / ÷2 folding) are within ±8 % and both grids are trustworthy, the
  incoming track's rate is set so beat periods match, its downbeat lands on a downbeat of the outgoing
  track, and after the transition its rate glides back to 1.0 over a few bars. Use a least-squares local
  grid over the beats in the overlap region, not single beat times. `timeline.js` gives
  `timeAtPosition` / `positionAt` for the mapping.
- The overlap gate (`canOverlap` in planner.js): two matched tracks are only OVERLAPPED (bassSwap /
  eqBlend / filterBlend) where the analyses vouch for the beat phase at both ends — neither end's grid
  trust (`Analysis.grid` head / tail, whole-track `phase` when a track is left mid-way) below 0.15, and
  the two slot patterns fitting beat on beat at least 1.05× better than at any other offset; without
  slot patterns both ends must reach 0.5. Held pairs are handed over on a bar line with a move that
  needs no overlap, carrying the tempo across where the move allows; `Transition.why` says so. The gate's
  verdict travels on blends as `Transition.trust`.
- `chooseNext` prefers a track it can really blend into (tempo, key, energy arc AND the gate), looks one
  track ahead (a candidate that leads to a blend afterwards is worth half a blend now), and spends a
  hand-over that is lost anyway on a track nothing could be matched with.
- Otherwise use transitions that do not need sync (echo-out, reverb wash, spinback, brake, riser→drop,
  filter fade + cut).
- Gain staging: never have both tracks' bass at full during an overlap; keep summed level sane.
- Uniqueness: seeded choice of transition type (weights depend on compatibility, `vibe`, and what was used
  last), cue points, lengths, and optional mid-solo tricks (filter dip, echo throw, beat-repeat, HPF build
  + drop) placed on bar lines of the outgoing track between `max(earliest, prev.play.soloFrom)` and
  `tStart`.

### engine (`js/dj/{engine,fx,recorder}.js`)

```js
export function createEngine(opts?: { context?: BaseAudioContext }): {
  ctx: BaseAudioContext,                        // created on first access — only touch it inside a user gesture
  state: 'suspended'|'running'|'closed'|'interrupted',   // the context's state WITHOUT creating it ('suspended' while there is none; 'interrupted' is iOS)
  unlock(): void,                               // the gesture-bound part of start() on its own: create / resume the context (iOS: the silent <audio>). Call synchronously in the tap when the set can only start later.
  start(opts?: {at?: number}): Promise<void>,   // set time 0 ≡ ctx time `at` (default currentTime + 0.15); resumes a suspended realtime ctx. With an OfflineAudioContext use at: 0.
  now(): number,                                // set time
  toCtx(setTime: number): number,
  addPlay(play: Play, buffer: AudioBuffer): void,     // build strip, schedule source + rate + events. If startAt is already past, start now at the right later offset. Never throws for late scheduling.
  extendPlay(playId: number, more: {events?: Ev[], rate?: RatePoint[], endAt?: number}): void,
  addFx(fx: Fx[], fxEvents: Ev[]): void,
  cancelFrom(setTime: number): number[],        // un-schedule everything at/after setTime (hold values as of setTime), drop one-shots not yet started, remove plays whose startAt ≥ setTime; returns removed play ids
  pause(): Promise<void>, resume(): Promise<void>,
  setVolume(v: number): void,
  levels(): { rms: number, peak: number, bands: Uint8Array, wave: Uint8Array },   // per-frame cheap; reuses arrays; silence while a realtime context is not running (paused / interrupted)
  on(type: 'playstart'|'playend', fn: (e:{playId:number}) => void): () => void,  // best-effort timers
  on(type: 'statechange', fn: (e:{state:string}) => void): () => void,           // every change of the context's state, exactly once — also the ones a browser makes without firing its own event (polled every 50 ms)
  recordStream(): MediaStream,                  // null on an OfflineAudioContext
  destroy(): void,
  // beyond the original surface: uiTime() (set time of the sound at the speakers, for drawing), reset() (New Set),
  // getPlay(id) (the engine's copy of a play after extendPlay / cancelFrom), tick(), playState(id), debug()
}
export function sanitizeBuffer(buffer: AudioBuffer): number            // NaN / ±Infinity → 0, absurd magnitudes clamped, in place; addPlay() calls it itself, once per buffer
export function sanitizeBufferAsync(buffer: AudioBuffer): Promise<number>   // the same in slices; call right after decoding a long file so addPlay() finds the work done
// recorder.js
export function createRecorder(stream: MediaStream): { start(), stop(): Promise<Blob>, readonly recording: boolean, mimeType: string }
```
Strips are created per play and torn down after `endAt` + FX tail (no node leaks over a multi-hour set).
The same engine code must render inside an `OfflineAudioContext` (that is how correctness is tested).
Where a browser's DynamicsCompressor still pre-emphasises the treble in front of its detector (Firefox),
the limiter is wrapped in a filter pair that cancels it (measured once per page, `fx.js
probeCompressorEmphasis`).

### ui (`index.html`, `css/`, `js/ui/`) — a dumb, state-driven view

```js
// js/ui/view.js
export function createView(root: HTMLElement, handlers: {
  onSubmit(text: string), onDemo(demoId: string), onFiles(files: File[]),
  onStart(), onPlayPause(), onSkip(), onNewSet(), onVibe(v: number), onMode(m: string), onVolume(v: number),
  onRecordToggle(), onShare(), onHome()
}): {
  setScreen(name: 'landing'|'loading'|'ready'|'stage'),   // 'ready' = playlist loaded via share link, big "Start the set" button (needs a user gesture)
  setDemos(demos: {id,label,emoji}[], examples: {label,url}[]),
  setLoading(s: {title: string, detail?: string, progress?: number|null}),
  setPlaylist(p: {title, subtitle?, artwork?, link?, count: number, source: string}),
  setDeck(deck: 0|1, d: DeckView|null),
  setTransition(tv: TransitionView|null),
  setSetlist(items: SetlistItem[], info?: {crate: number}),   // crate = different playable tracks (the header's "N in the crate"; the rows also hold replays)
  setTransport(s: {playing: boolean, canSkip: boolean, recording: boolean, seed: string, vibe: number, mode: string, modeEnabled: boolean, volume: number}),
  toast(message: string, kind?: 'info'|'error'|'success'),
  inputError(message: string),                // a failed load, written under the control it was started from (link field / list box / crate chip) until the next edit; a toast when another screen is showing
  frame(f: FrameState): void,                 // every animation frame
  destroy(): void,
}
/** DeckView      {playId, title, artist, artwork?, link?, bpm, camelot, keyName, duration, provider, wave: Analysis['wave'], beats: number[], downbeat: number, cues: Analysis['cues']} */
/** TransitionView {type, label, why, fromTitle, toTitle, state: 'upcoming'|'active'|'waiting', tStart, tEnd, marks: {t,label}[], synced?,
 *                  trick?: {label, on /*track title*/, tStart, tEnd},   // 'upcoming' only: a mid-solo trick in flight (shown as a pill for ≥ 2 s; "Next: …" is not re-announced)
 *                  reason?: 'network'|'loading'}                        // 'waiting' only: the crate ran dry — nothing on air, nothing planned (label + why say it; no titles, no marks, tStart === tEnd)
 */
/** SetlistItem   {key, title, artist, artwork?, bpm?, camelot?, state: 'played'|'playing'|'mixing'|'next'|'queued'|'loading'|'failed', via?: string /*transition label into it*/, link?,
 *                 deck?: 0|1, again?: true /*heard before in this set: the crate has come round*/} */
/** FrameState    {t: number, playing: boolean, elapsed: number,
 *                 decks: [DeckFrame|null, DeckFrame|null],   // DeckFrame {pos, rate, bpmNow, gain, low, mid, high, hpf, lpf, audible /*0..1*/, startsIn}
 *                                                            //   a deck that is cued or stopped reports gain 0 and audible 0; startsIn = seconds of set time
 *                                                            //   until a cued deck starts (0 once it runs): its waveform is parked in its lane and counted down
 *                 crossfade: number /*-1 deck0 … +1 deck1*/, beatPhase: number /*0..1 within the current beat*/,
 *                 levels: {rms, peak, bands: Uint8Array}} */
```

### conductor + main (`js/dj/conductor.js`, `js/main.js`) — integrator

Owns the live set: seeded base order → prepare tracks in that order (resolve → fetch bytes → decode →
analyze, concurrency ≈ 3; keep compressed bytes, drop decoded AudioBuffers outside a small window to bound
memory) → start as soon as the first track is ready → for each next slot wait for the "crate window"
(first 5 unplayed tracks in base order) to settle, `chooseNext`, decode, `planner.next`, hand to the
engine well ahead of time (Web Audio does the sample-accurate timing; timers are only for bookkeeping).
Endless: when the crate is empty, reshuffle and continue (every pass plays every track once; no A-B-A in
small crates). Skip = `engine.cancelFrom(now)` + `planner.next(…, {earliest: now + 0.25, quick: true})`,
only when a single track is playing. Tracks that fail to resolve/decode are marked failed and skipped;
network failures stay retryable once the crate has produced a track. URL:
`?p=<playlist id>&seed=<seed>&vibe=<0..1>` reproduces a set (a link without `vibe` means 0.5; the
recipient's own stored vibe is neither used nor overwritten). Since §6 the URL also carries
`&len=<preview|short|medium|full>`; a link without `len` was made before full songs existed and means
`preview`.

As built, beyond the paragraph above (`createConductor({engine, analyzer, resolver, decode})`):

```js
load(playlist, {seed?, vibe?, mode?, autostart?, patient?})   // patient: a share-link seed — wait (≤ 10 s) for the whole head of the order before choosing the opener
begin(), newSet(), stop(), skip(), pause(), resume(), setVibe(v), setMode(m), setVolume(v), poke(), destroy()
audioState()            // make `paused` say what is true of the AudioContext; the conductor also hears the engine's 'statechange' itself and checks every tick
canSkip(): boolean      // cheap enough for every animation frame
snapshot(): {loaded, started, playing, paused, stalled: ''|'network'|'loading', seed, vibe, mode, modeEnabled, canSkip, playlist, now,
             playIndex, current, decks: [DeckView|null, DeckView|null], transition: TransitionView|null, setlist: SetlistItem[], stats, status}
history(), debug(), live                                      // tests / the per-frame loop
seed, vibe, started, paused /*by the user or by the browser*/, pausedByUser
on('start'|'change'|'status'|'skip'|'error', fn)
export function deckFrameAt(df, play, analysis, t): boolean   // one DeckFrame at set time t, written in place (pure)
```

Transport truth has one owner: `paused` mirrors the real context (a browser that stops the audio by
itself — a phone call, iOS "interrupted", a start without a user gesture — shows Play; audio that comes
back by itself plays again unless the user had paused). History: starting a set from the start screen
pushes one entry, so Back returns to the start screen; seed / vibe changes and New Set replace it.

## 5. Product priorities

- **P0** — paste Spotify link / click a demo → continuous, good-sounding, beat-matched mix with visible
  decks, waveforms, mixer and "what the DJ is doing" ticker; New Set gives a different set; works on phone.
- **P1** — skip, vibe control, share link with seed, local files (full-length), text paste, setlist with
  "open in Spotify" links, Media Session, record/download the set.
- **P2** — nice-to-have polish.

## 6. Full songs (YouTube) — added 2026-10-05

Goal: Short / Medium / Full track lengths work for **every** playlist (Spotify, Deezer, pasted text), not
only for local files, by playing full songs through YouTube's official embedded player. Preview mode
(30-second clips through Web Audio, beat-matched) stays exactly as it is.

### 6.1 Verified facts (headless Chrome, 2026-10-05; see `handoff/yt/` scratch)

| Thing | Result |
|---|---|
| YouTube search page `https://www.youtube.com/results?search_query=<q>` via relay 2 (`r.jina.ai`, header `X-Return-Format: html`) | 200, CORS ok, ~1.3 MB HTML containing `var ytInitialData = {…};</script>`. Walk it for `videoRenderer` objects: `videoId`, `title.runs[].text`, `ownerText.runs[].text` (channel), `lengthText.simpleText` ("4:40"), `ownerBadges[].metadataBadgeRenderer.style` (`BADGE_STYLE_TYPE_VERIFIED_ARTIST` / `…_VERIFIED`). For "Calvin Harris Blessings KETTAMA remix" the first hit was the artist's own "(KETTAMA Remix - Official Audio)", verified artist, 4:40. |
| Same URL via relay 1 (`web.scraper.workers.dev`, `selector=script`, `scrape=text`) | 200, CORS `*`, JSON `{result:{script:[…texts]}}`; one text holds `var ytInitialData = …`. |
| Invidious / Piped public instances | all failing (401/403/526). Do not use. |
| oEmbed `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json` | CORS ok (reflects origin). 200 for embeddable public videos; 401/403/404 for private / removed / some non-embeddable. Not a full guarantee (label blocks show only at play time). |
| IFrame Player API (`https://www.youtube.com/iframe_api`, `new YT.Player(el, {videoId, host, playerVars})`) | Works in Chrome with `host: 'https://www.youtube-nocookie.com'` (privacy-enhanced). Two players in one page can play at once. The nocookie host does **not** keep the visit cookie-free (next row). |
| **Third-party cookies** (re-measured 2026-10-05: fresh Chrome profile, page served as the real site, share link, no tap; `Storage.getCookies` over CDP) | A plain home-page visit: **none**. The top page's own request for `www.youtube.com/iframe_api` answers with ~7 `Set-Cookie` on `.youtube.com` (`VISITOR_INFO1_LIVE`, `__Secure-YNID`, `VISITOR_PRIVACY_METADATA`, `__Secure-ROLLOUT_TOKEN` ≈ 6 months, `YSC` session) and no `Access-Control-Allow-Origin`, so `crossorigin="anonymous"` is not an option. The nocookie players' ad beacons (`www.youtube.com/pagead/adview`, `/pagead/interaction/`) carry those cookies; the ads set `.doubleclick.net` `IDE` (≈ 13 months), `APC`, `test_cookie` (depends on the ad). Deezer's JSONP script (`api.deezer.com`, every playlist but local files) sets `.deezer.com` `dzr_uniq_id` (≈ 6 months). Fetches (relays, oEmbed, iTunes) use `credentials: 'omit'` and set nothing. Loading the API only after the tap would break the muted pre-roll, so this is disclosed (README *Privacy*), not avoided. |
| **Origin matters** | Label music (e.g. official Calvin Harris uploads) gives **error 150 on `http://127.0.0.1`** but plays on `https://aarushkandukoori.github.io`. Tests must serve the app under the real origin (request interception, see 6.6). |
| **Pre-roll ads** | On the real origin every music video shows 1-2 pre-roll ads, 20-40 s in total (measured 20 s and 37 s). During an ad: `getPlayerState() === -1`, `getCurrentTime()` counts the AD's time, `getDuration()` already reports the song, `getVideoData().video_id` is the song, `seekTo` is ignored. The song has started when the state first becomes `1` (PLAYING). |
| Muted pre-roll without any user gesture | Works: `mute(); playVideo()` on a fresh player plays the ads muted and then the song. After that, `pauseVideo(); seekTo(0, true)` holds it at the start; a later `unMute(); setVolume(100); playVideo()` plays with sound (no new ad, state 1 after ~0.3 s) — also with no gesture in that iframe, because the API's iframe carries `allow="autoplay"` and the top page has had a user tap. |
| `loadVideoById` on a used player | Plays new ads for the new video. |
| Background tab | A playing video keeps playing (time advanced 3.98 s in 4 s while another tab was in front). That run, like every e2e run by default, had hidden-tab throttling switched off: puppeteer itself passes `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`. With them removed (`launch({realBackground: true})`, 6.6) a hidden tab's 20 Hz `setInterval` runs once a second (measured 1.0/s against 19.8/s) — also while it plays Web Audio, because the harness's `--mute-audio` leaves Chrome nothing it hears; Chrome documents that it does not throttle a tab that is audibly playing. **Re-measured 2026-10-06** with `launch({realBackground: true})`: a player playing *unmuted at volume 0* runs its ads on in a hidden tab, cues there and starts new videos there; its `<video>` reads volume 0.00 throughout (sampled inside the player's frame at every media event). Chrome also lets such a pre-roll run before any gesture. A muted-only pre-roll in a hidden tab was held still in earlier probes and crawled at about half speed in these runs. Page timers of a hidden tab under `--mute-audio` fired **once a minute** after a few minutes (gaps of 60 s — Chrome's intensive throttling of a silent tab), so a conductor ticking on `setInterval` ran its hand-overs up to a minute late; timers in a dedicated Worker were not throttled (0 gaps in 300 s). |
| `setPlaybackRate(1.05)` | Accepted (getPlaybackRate 1.05) but no beat grid exists for the full song, so it is not used. |
| No audio access | The audio of a cross-origin iframe never enters our AudioContext: no EQ / filters / FX on it, no analysis of the full song, the master meter and the recorder do not hear it. Volume is the only control (0-100, linear). iOS ignores volume (mute/unmute only). |

### 6.2 Policy constraints (YouTube API Services terms — design rules, not optional)

- The player stays **visible, at least 200×200 CSS px, fully opaque**, never covered: no element may be
  drawn over any part of the player rectangle (labels, progress, badges go *outside* it). Never
  `display:none`, `visibility:hidden`, opacity < 1, off-screen, or clipped. Do not hide or skip ads; the
  cued deck shows its ad (muted) in plain view.
- Never move a player's iframe in the DOM after creation (that reloads it) — the view gives each deck
  a stable slot element.
- Use only the official IFrame API; no stream extraction, no audio capture.
- README must say plainly that full songs come from YouTube's embedded player, ads included, and that
  silent pre-loading of the next song (muted before the first tap, unmuted at volume 0 after it) is how
  the mix avoids ad breaks (a grey area under YouTube's terms for anything commercial).
- README *Privacy* must name every site that leaves cookies, in the same bullet as the word "cookie", and
  say that a share link sets them before any tap. The players get only this page's origin and path, never
  the playlist link or the set's seed, vibe or length: the deck builds its own iframe
  (`youTubeEmbedUrl(host, location)`: `origin` + `widget_referrer` = origin + path, the iframe's
  `referrerpolicy` strict-origin-when-cross-origin) instead of letting the IFrame API copy `location.href`
  into it as `forigin`, and README says so. Its relay-hedge delays must match `HEDGE_MS` in
  `js/sources/youtube.js` and `js/sources/spotify.js`. `tests/e2e/privacy.e2e.mjs` checks all of it
  against a real run.

### 6.3 Modes and engines

| playlist source | mode `preview` | modes `short` / `medium` / `full` |
|---|---|---|
| spotify / deezer / text | existing `conductor.js` + Web Audio engine (unchanged) | **new `fullset.js`** with two YouTube decks |
| local files | not offered | existing `conductor.js` (full-length local audio, unchanged) |

Default mode = `prefs.mode` (default `'medium'`), so full songs are the default for every playlist.
Leave points: short ≈ 45 s, medium ≈ 90 s (seeded ±, bar-snapped from the start when the BPM is known),
full = the song's end minus a seeded outro guard (8-20 s) minus the transition. Changing mode between
`preview` and a full-song mode mid-set hands over between the two conductors (main.js), without a gap
when possible. Share links carry `&len=<mode>`.

As built (main.js):

- `prefs.mode` (`'preview' | 'short' | 'medium' | 'full'`, default `'medium'`) is the length every
  playlist starts at; a share link's `len` is used for that set only (like its vibe). Local files never
  play `preview` (the view greys it; `medium` is used).
- Full songs skip the "Start the set" screen: the stage (video mode) shows at once, because the first
  song's pre-roll ad must run in a visible player — and it needs no gesture (muted). A share link waits
  for a tap on Play there; a pasted link / demo tap already was the gesture.
- The two YouTube decks are created once (`createYouTubeDeck(view.videoSlot(i))`, which loads the IFrame
  API) when a full-song set first needs them, and kept; leaving video mode (Preview, the start screen)
  stops them first (`deck.stop()`: paused + muted), then `view.setStageMode('waves')`. The full-song set
  has its own Web Audio engine (`videoEngine`: risers / impacts, preview fallback), so the two conductors
  can overlap during a hand-over without sharing a clock.
- Hand-over Preview ↔ full songs: the playing side keeps playing; the other side loads the same playlist
  with the same seed and vibe (autostart) and starts silent; once its first track sounds, a 3-second
  crossfade (Web Audio master volume vs. the decks' volume, ramped by main.js at 20 Hz), then the old side
  is stopped. Into full songs that wait includes the first song's ad (the previews play on under the
  video stage meanwhile); into previews it is the few seconds the preview conductor needs. With nothing
  playing yet it is a plain swap. Flipping back while a hand-over is pending cancels it.
- The hand-over does not restart the order, in either direction: main.js passes
  `carry: {played, elapsed, at, live}` to the other side's `load` — `played` = the track ids played or on
  air, oldest first; `elapsed` = the set's Elapsed; `at` = `performance.now()` of the switch; `live` = the
  old side plays on (a hand-over, not a swap). `conductor.load` and `fullset.load` take the played ids
  out of the first pass, list them as `'played'` setlist rows keyed `` `${trackId}|c${i}` ``, count them as
  recent for the next pass, and continue Elapsed. With `live`, Elapsed keeps running through the wait
  (the first song's ad / the first clip) and is fixed at the first sound. *New set* clears the carried
  rows and Elapsed.
- *Play previews instead* (the `starting` TransitionView action) calls `handlers.onPreviewOnce()`:
  main.js hands this set over to previews without writing `prefs.mode`, so the next playlist plays the
  stored length (6.5).
- `fullset` emits `unavailable` when YouTube cannot work here at all (the IFrame API failed to load;
  the first three lookups all failed on the network; three songs in a row whose every upload refused to
  embed, before any cue succeeded — what label music does on `http://127.0.0.1`; three failed cues
  before any success): main.js hands the set to Preview with a toast that says why.
- REC is disabled in video mode (`recordEnabled: false`, `recordWhy`), Media Session follows the active
  set, `window.__segue` exposes `conductor`, `fullset`, `engine`, `videoEngine`, `finder`, `active`,
  `decks`, `handoff`, `workerClock` for the tests.

### 6.4 Module APIs (new)

```js
// js/sources/youtube.js                                                          [sources]
export function parseYouTubeSearch(text: string): YtCandidate[]      // pure; accepts the HTML page or the relay-1 JSON
/** @typedef {{videoId:string, title:string, channel:string, durationS:number|null, verifiedArtist:boolean, verified:boolean, topic:boolean}} YtCandidate */
export function scoreVideo(track: TrackMeta, c: YtCandidate): number  // pure, 0..1
export function createYouTubeFinder(cfg?: {fetchText?, storage?}): {
  find(track: TrackMeta, opts?: {signal}): Promise<{videoId, title, channel, durationS, score, alternates: string[] /*next best ids*/}>,  // throws ResolveError('no-match'|'network')
  search(query: string, opts?: {signal}): Promise<YtCandidate[]>,
}
// js/dj/ytdeck.js                                                                [engine]
export function loadYouTubeApi(opts?: {timeoutMs?}): Promise<any>      // injects https://www.youtube.com/iframe_api once
export function youTubeEmbedUrl(host: string, loc: {origin, pathname}): string
  // the deck's own embed URL: PLAYER_VARS (playsinline 1, controls 0, disablekb 1, rel 0, iv_load_policy 3,
  // fs 0, cc_load_policy 0, enablejsapi 1, mute 1) + origin + widget_referrer = origin + path. Never the
  // query or hash (the API itself would send location.href as forigin).
export function createYouTubeDeck(slot: HTMLElement, opts?: {host?: string, onChange?: (deck) => void, apiTimeoutMs?: number,
                                  timers?: {setTimeout, clearTimeout} /* what it polls its player on; main.js: js/util/timers.js */}): {
  // builds its own <iframe> (src = youTubeEmbedUrl(host, location), referrerpolicy strict-origin-when-cross-origin,
  // the API's allow list) in place of a placeholder in `slot`, then hands it to YT.Player; never moved or hidden
  readonly state: 'empty'|'loading'|'ad'|'cued'|'playing'|'paused'|'ended'|'error',
  readonly videoId: string|null, readonly duration: number, readonly error: number|null,
  readonly adSeconds: number,      // pre-roll ad seconds of the current / last cue, counted only while the ad's own
                                   // clock moves (not wall time: Chrome slows or holds a muted ad in a hidden tab)
  readonly ready: boolean, readonly muted: boolean, readonly volume: number, readonly iframe: HTMLIFrameElement|null,
  readonly unmutedHold: boolean,   // an unmuted pre-roll / cued song held at volume 0 until play()
  readonly heldBack: number,       // starts the deck did not ask for, paused back (see below)
  cue(videoId, opts?: {at?: number, timeoutMs?: number, unmuted?: boolean}): Promise<void>,
      // pre-roll → 'cued' (song held at `at`); rejects DeckError {code}. Muted by default. unmuted: true runs the
      // pre-roll unmuted at volume 0: setVolume(0), unMute(), setVolume(0), then loadVideoById (the last call undoes
      // YouTube restoring volume 5 on unMute). The volume stays 0 until play(): setVolume() during the pre-roll is
      // remembered, not sent; a player found unmuted above 0 is set back to 0 at most every 600 ms. Ignored on
      // iOS / iPadOS (the volume is ignored there). If the browser refuses sound (onAutoplayBlocked, or a pre-roll
      // that has not moved for 6 s with the page in front) the pre-roll goes on muted. A cue that fails 'blocked', or times out,
      // is also cancelled with stopVideo().
  unlock(): boolean,               // call inside the user's tap: a running muted pre-roll goes on unmuted at volume 0.
                                   // true when the pre-roll is (now) unmuted at 0; false with no pre-roll, or on iOS / iPadOS
  play(opts?: {volume?: number}): Promise<void>,   // unMute + the requested volume (100 if never set) + playVideo; resolves at PLAYING
  pause(), resume(): Promise<boolean>, seek(s: number),
  stop(),                          // pause + mute; a cue in progress is abandoned and cancelled with stopVideo() (→ 'empty');
                                   // a deck in 'error' gets stopVideo() too, which clears YouTube's error screen (the deck
                                   // stays 'error' with its code), and so does one whose play() was pending or timed out
  setVolume(v: number),            // 0..1 → player 0-100, only sent when the rounded value changes
  position(): number,              // song time, extrapolated between player reports
  prime(): void,                   // call inside the Start tap (iOS media unlock); keeps an unmuted hold at volume 0
  destroy(): void,
  debug(): object,                 // adds silentHold, unmutedPreroll, fellBack ('refused'|'stalled'|'player'|''), heldBack, captionsOffFor …
}
// Pause-back: the deck is the only one that may start its player. A start nobody asked for — the play button
// YouTube draws on a cued player, a stopped player that went on anyway, a player that plays while the deck is in
// 'error' or 'empty' — is muted and paused back (a cued deck stays at its cue point); heldBack counts each one.
// Captions: cc_load_policy 0, and YouTube's auto-generated captions are unloaded for each song once it plays
// (and once more 1 s later): YouTube switches them on for these embeds and controls 0 leaves no way to turn them off.
// During an ad they stay on (measured 2026-10-06 in the app: isSubtitlesOn() true and caption segments drawn in
// 256 of 278 one-second samples of pre-roll ads on both decks); the module calls do nothing there.
// js/dj/videomix.js  — pure, deterministic                                       [brain]
export function planVideoTransition(input: {
  seed, vibe, mode: 'short'|'medium'|'full', playIndex: number, prevType?: string, quick?: boolean,
  reason?: 'skip'|'newset',                          // a quick plan's why ends in 'skipped' (default) or 'new set'; the plan is otherwise identical
  earliest: number,                                  // set time; nothing may happen before it
  out: {id, durationS, startedAt /*set time its position 0 was (or would have been) heard*/, bpm?, bpmConfidence?, energy?, provider: 'youtube'|'preview'},
  inc: {id, durationS, bpm?, bpmConfidence?, energy?, provider: 'youtube'|'preview'},
}): VideoTransition
/** @typedef {{ type: 'longBlend'|'crossfade'|'fadeDrop'|'riserDrop'|'cut', label: string, why: string,
 *   tStart: number, tEnd: number,          // set time
 *   leaveAt: number,                       // outgoing song position at tStart
 *   incAt: number,                         // incoming song position when it starts (usually 0)
 *   incStart: number,                      // set time the incoming starts playing (≥ tStart - small lead)
 *   outVol: {t:number, v:number}[], incVol: {t:number, v:number}[],   // linear 0..1 volume breakpoints, set time, linear interpolation between points
 *   fx: Fx[],                              // only 'riser' / 'impact' (Web Audio, layered on top)
 *   marks: {t:number, label:string}[] }} VideoTransition */
export function leavePoint(input): number   // song position where a track in this mode is left (exported for the conductor's "upcoming" display)
// js/dj/fullset.js — the full-song conductor                                     [integrator]
// same public surface as conductor.js (on, load, begin, newSet, stop, skip, pause, resume, setVibe, setMode,
// setVolume, audioState, canSkip, snapshot, history, debug, destroy) plus frame(t, out): fills a FrameState-like object.
```

As built:

```js
createFullSet({engine, finder, decks /* [deckA, deckB] or () => them */, resolver?, analyzer?, decode?, clock?, timers?, volumeWorks?, hidden?})
load(playlist, {seed?, vibe?, mode?: 'short'|'medium'|'full', autostart?, carry?})  // autostart: a gesture happened, play as soon as cued; carry: 6.3
begin()                 // the tap: the opener plays as soon as it is cued (now, if it is)
newSet(seed?), stop(), skip(): boolean, pause(), resume(), setVibe(v), setMode(m), setVolume(v /*0..1*/)
canSkip(), snapshot(), history(), debug(), frame(t, out), now() /*set time*/, tick(), poke(), destroy()
on('start'|'change'|'status'|'skip'|'error'|'unavailable'|'notice', fn)    // notice: {message, kind} for a toast
seed, started, paused, pausedByUser, vibe, mode, needsTap, onAir            // getters
export FULL_MODES, LOOKAHEAD (3), TICK_MS (50), FX_LEAD (1.5), SWAP_AFTER_S (15), SILENT_WAIT_S (12), STALL_S (3)
```

The Preview conductor (`conductor.js`) gains the same carry: `load(pl, {…, carry: {played, elapsed, at?, live?}})`,
`snapshot().elapsed` = set time + carried time, and `elapsedAt(t)` for the per-frame value (main.js `frame()` uses it).

- **Order and preparation.** `planner.order(ids)` with the seed; passes as in conductor.js
  (`nextCycleOrder`), every track once per pass, never the same song twice in a row. Videos are looked up
  for the two plays in hand plus the next `LOOKAHEAD` tracks (two lookups at a time; the finder itself
  searches one at a time). Previews (resolver → fetchAudio → decode → analyzer) one at a time for the
  same window, fallbacks first. The next song is the first track of the order that has settled (waits for
  it, so a seed gives the same songs), or — when the song on air is within 50 s of its way out — the first
  one that is ready.
- **Pre-roll.** Before the start deck A cues the opener and deck B the second song at once (both ads run
  in parallel). After every hand-over the freed deck cues the next song immediately. Once the page has
  had a gesture (and not on iOS) every cue is `{unmuted: true}` (volume 0), and the tap calls
  `deck.unlock()` on pre-rolls still running muted (a share link before its tap). When to give up on a
  pre-roll is decided by the conductor (`cueWatch`; the deck's own deadline is a 15-minute backstop), on
  the time the page was **in front**: 180 s for the opener; for a next song the time the song on air still
  runs + 15 s, within 120-300 s. A player that got nowhere by then → its next upload (a fresh ad); an ad
  that is still moving (its `adSeconds` grew within the last 4 s) gets up to 240 s more, then the song's
  preview. Ad pods of 120-250 s were measured.
- **Opener swap** (`SWAP_AFTER_S` = 15): before the start, when the second song is cued and the opener is
  still in its pre-roll 15 s later, the set opens with the second song and the opener's pre-roll goes on as
  the next song. The seeded order changes only by swapping its first two songs.
- **Silence.** Once the music has stopped (a song ended) and the incoming has been waited for
  `SILENT_WAIT_S` (12 s of set time) still in its ad, its ready preview plays instead (the upload is not
  refused or forgotten: the ad did nothing wrong).
- **Buffering.** The song on air standing still for `STALL_S` (3 s) while its player says it plays is a
  network stall: `snapshot().stalled = 'network'` and the ticker says so; YouTube picks the song up by
  itself.
- **Clock.** Set time = wall time since the opener's first sound minus pauses (YouTube plays in wall
  time). Engine things are converted at the moment they are handed over (`engine.now() + (t − now())`)
  and only `FX_LEAD` before they happen; nothing is re-planned or skipped once handed over (and not within
  2 s of a transition's start). The ticker runs on `deps.timers` when it is an object
  (`{setInterval, clearInterval}`): main.js passes `createTimers()` from `js/util/timers.js`, the timers of
  a dedicated worker (`js/util/timer-worker.js`) that fire in the page as messages, and gives the same
  timers to both decks (`createYouTubeDeck(slot, {timers})`, their polls) and to the hand-over ramp. A
  hidden page's own timers fired once a minute (6.1); with the worker clock the hand-overs in a hidden tab
  started 0.3 s after plan (full.e2e `background`, 2026-10-06). Without a Worker (or when it fails) the
  page's timers are used. `window.__segue.workerClock` says which.
- **Background tab.** A pre-roll whose ad clock grew within the last 20 s (`AD_HELD_MS`; `adSeconds`,
  hidden or not — the gap between two ads of a pod, or the ad buffering, stops the clock for seconds;
  the deck's `'loading'` while it holds the song at 0:00 right after the ad counts as moving) or that the
  deck already reports `'cued'` is never stood in for: the song on air plays on, as in front.
  Only a held play, or a pre-roll whose clock has stood still that long (Chrome holds a muted one still
  in a hidden tab), gives way to its preview at the leave point (`STANDIN_LEAD_S`, after 15 s hidden).
  Once the music has stopped, the silence rule names a moving ad `'slow'` (notice: the ad ran long) and
  only a pre-roll that does not move in the hidden tab `'background'`; `history()` carries `previewWhy` and `heardAt` (set time the player reported PLAYING).
  An incoming `play()` is given up `START_GRACE_S` after `max(tEnd, when it was issued)`, and a deferred
  `play()` is never sent to a play given up in the meantime. *New set* while the song on air has run out
  and its incoming is cued waits for that move (`pendingNew`), then the new order takes over under it.
- **Transitions.** Planned as soon as the incoming is cued (`planVideoTransition`, `earliest = now + 0.4`;
  BPM / energy from the preview analysis when it is there). A 20 Hz ticker applies `volumeAt(lane, t) ×
  volume` (capped at 1) to each YouTube deck, calls the incoming `play()` at `incStart`, finishes the
  hand-over at `tEnd` (outgoing `stop()`). The song on air is re-anchored to its real position (a stall or a
  mid-roll ad) until its plan is made. An incoming still in its ad at the leave point: the song on air plays
  on, the ticker says "Next song after its ad" (state `waiting`), the plan is made the moment it is cued
  (late path). A song that ends first: `waiting` until the incoming is cued, then a cut.
- **Errors.** A refusal (100 / 101 / 150 / 2 / 5) or another fault of the video → `finder.forget(track,
  id, code)` with the deck's code (the finder keeps the upload for a code that says nothing about it:
  timeout, blocked, background — `NO_VERDICT`) and the next alternate upload → the track's preview as a
  Web Audio play (`engine.addPlay` with `'gain'` events from the same lanes; provider `'preview'`, it is
  left 1-2.5 s before its end) → the track is marked failed and the slot goes to the next track. An opener
  that fails hands the start to the song cued on the other deck. Every deck given up for its preview is
  stopped with `deck.stop()` (a stop during a cue, or of a deck in 'error', does `stopVideo()`, which clears
  YouTube's "Video unavailable" screen and an abandoned paused ad back to the player's plain start screen;
  measured 2026-10-06). A failure (not a refusal) within 4 s of the page being hidden is the background
  tab's doing: the play is **held** (deck stopped, nothing refused, forgotten or counted) and the same
  upload is cued again once the page is in front.
- **Skip.** Next song cued: a quick plan (`quick: true`, `reason: 'skip'`) at once. Still in its ad:
  queued ("Next song after its ad" notice) and done the moment it is cued. Not during a transition or
  within 2 s of one.
- **New set** with a song on air (no hand-over in motion): that song plays on, the new order's head
  pre-rolls on the free deck and comes in with a quick move once cued (`reason: 'newset'`, so its why says
  "new set"; no silence for its ad); history restarts with the bridging song. Pressed during a hand-over
  in motion, it is applied once that hand-over is over. Otherwise (nothing playing yet) a full reset.
- **iOS** (`volumeWorks: false`, main.js detects iOS / iPadOS): the player ignores volume, so a
  YouTube → YouTube move is turned into a cut at its crossover (`why` says so) instead of two songs at full
  level for the length of a blend.
- **Pause / resume** pause both decks and the engine and freeze set time; resume calls `play()` on the
  decks that were sounding. A click on the video itself (which pauses YouTube's player) pauses the set,
  another click resumes it.
- **snapshot()** = conductor.js's shape plus `stageMode: 'video'`, `recordEnabled: false`, `recordWhy`,
  `leaveAt` (song position the song on air is left at), `needsTap`, `skipQueued`, `unavailable`, `tr`
  ({type, tStart, tEnd} of the announced transition). DeckView: `provider` `'youtube'|'preview'`, `link` the
  YouTube watch URL, `bpm` only when the preview's tempo is trusted (else NaN), `wave` null (a preview
  play passes its waveform), `status` / `statusText` from the play's phase and the deck's state
  (`ad` / `loading` / `cued` / `live` / `mixing` / `error`). A preview play that is live or mixing has no
  `statusText`, so the view says "No video · its 30-s preview" / "Mixing · 30-s preview"; a cued preview
  says "No video · its preview is cued". TransitionView `starting` before the first sound (why: finding /
  ad / "press Play"), `upcoming` / `active` for a plan, `waiting` as above. `snapshot().elapsed` and
  `frame().elapsed` include the time carried over from the other conductor (6.3).
- **frame(t, out)**: DeckFrame `pos` from `deck.position()` (a preview: set time since it started),
  `gain` = lane value (before the user's volume), `audible` = gain, `startsIn` (cued incoming), `duration`,
  `leaveAt`, `eqActive` false for YouTube; `beatPhase` −1; `levels` from the full-song engine.

Deviations from the builders' modules used as built: `ytdeck` playerVars add `mute: 1`; `youtube.js`
adds `forget`, `stats`, `sharedYouTubeFinder` (main.js uses the shared finder); `videomix` adds `volumeAt`
and `beats`; see the modules' headers.

### 6.5 View additions                                                           [ui]

```js
view.setStageMode('waves' | 'video')        // 'video': the hero shows two video slots instead of the waveform lanes
view.videoSlot(deck: 0|1): HTMLElement      // stable, created once; the integrator mounts a YouTube player inside. Never moved / re-created by the view.
// DeckView gains: provider 'youtube'|'deezer'|'itunes'|'local'|'preview', wave may be null (video mode → progress bar instead of mini waveform),
//                 status?: 'ad'|'loading'|'cued'|'live'|'mixing'|'error', statusText?: string
// DeckFrame gains: duration?: number, leaveAt?: number (song position where it will be left), eqActive?: boolean (false in video mode → EQ/filter knobs shown inactive)
// TransitionView gains state 'starting' (waiting for the first song's ad; label/why/ no countdown) with an action button "Play previews instead"
//                 (ticker tk-act, and vs-start-act on the video stage) → handlers.onPreviewOnce(): this set goes on as previews, prefs.mode
//                 is not written (the next playlist plays the stored length); the view falls back to onMode('preview') only when
//                 onPreviewOnce is missing. ViewHandlers gains onPreviewOnce.
// setTransport gains: recordEnabled?: boolean, recordWhy?: string   (video mode: REC disabled — YouTube audio cannot be recorded)
```
Track-length control: enabled for every playlist (preview / short / medium / full); for local files `preview`
stays unavailable. The old "Previews are 30 seconds — add your own files" lock and its toast go away.

### 6.6 Testing under the real origin

`tests/e2e/origin.mjs` exports `serveAsOrigin(page, {origin = 'https://aarushkandukoori.github.io', base = '/segue/'})`:
request interception that answers every request under `origin + base` from the repo on disk (same MIME
map as serve.mjs) and lets everything else through to the network. Full-song e2e runs use it, with
`launch({gesture: true})` so Chrome's real autoplay policy applies, and must tolerate real ads (measured
12 s to 250 s per video in the e2e runs). Waits longer than puppeteer's 180 s protocol timeout must poll
with short evaluations: one `page.waitForFunction` is a single CDP call and is cut at 180 s.

Background tabs: by default `launch()` keeps a hidden tab running at full speed (see the 6.1 row).
`launch({realBackground: true})` removes the three switches that do that, so a hidden tab is throttled the
way a visitor's Chrome throttles a silent one; `sendToBackground(page)` (also in `browser.mjs`) puts
another tab in front and returns a function that brings `page` back. Use both for anything about the
visitor who switches tabs.

- `tests/fullset.test.js` — the conductor with fake decks / finder / engine and a hand-cranked clock.
- `tests/e2e/privacy.e2e.mjs` — README *Privacy* against reality, each in a fresh profile with no tap: a
  plain visit (only the page and Google Fonts contacted, no cookies), a Preview share link (no YouTube
  host contacted), a full-song share link (YouTube's cookies within 30 s); every cookie's site must be
  named next to "cookie" in README *Privacy*; no request to a YouTube or Google host (players, ads,
  statistics, API script) may carry the share link's query — a seed made at run time, the playlist, vibe,
  length — in its URL or its Referer (every percent-encoding layer undone), the player loads' Referer is
  the bare origin, and README says the players get only origin and path; the hedge delays there must
  equal the code's. `SEGUE_SITE_ROOT=<dir>` serves another copy of the site (a control run with a leaking
  copy fails the query check).
- `tests/e2e/ytdeck.e2e.mjs` — one deck in `ytdeck-harness.html` under the real origin. Chrome runs with
  `launch({gesture: true, realBackground: true})`; `YT_IDS` takes 4 video ids (the 4th is one never loaded
  in the session, for a cue started in a hidden tab). Silence is checked inside each player's own frame:
  every `<video>` moment that plays unmuted above volume 0 before `play()` is a failure.
- `tests/e2e/full.e2e.mjs` — the real app under the real origin: a Spotify playlist in Short (time to
  first sound, ≥ 2 transitions, deck swap, volume lanes sampled at 20 Hz, positions, ticker and setlist
  states, players ≥ 200×200 and uncovered on a 10 px elementsFromPoint grid with every element made
  hit-testable, REC off with its reason, Skip into a cued song, Preview and back to Medium without a gap
  > 1 s; Short → Preview keeps the running order and Elapsed, and back to Medium Elapsed includes the ad
  wait), share links with and without `len` (a real tap on Play), a phone pass with a forced error 150
  → preview fallback (the fallback deck's label, and its player showing neither the error screen nor an
  ad), a real background tab (`background`: the set started in front and hidden for 180 s, and a set
  started in front whose first ad runs on hidden), New set during a move (`moves`), *Play previews
  instead* for this set only (`prefs`), Home / *Play previews instead* within 1 s of a deck's
  `loadVideoById` with no player time moving for 30 s while the stage is hidden (`stopload`); zero console
  errors and CSP violations. Groups: `main share phone background moves prefs stopload`. Page state is
  read through raw CDP with `userGesture: false` (puppeteer's evaluate would grant the page user
  activation). Waits for something that can only come after an ad (`untilPastAds`) go on past their base
  time only while a deck's ad clock is still moving (YouTube served 3-4 minute pods at night), and a
  check that meets an ad longer than the song on air expects the documented 12 s silence rule, nothing
  looser. The background group's silence watch samples on the app's worker clock (page timers fire once
  a minute in a throttled tab) and times each hand-over while hidden against its plan (`heardAt` vs
  `incStart`).

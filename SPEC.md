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
  `'self'` and `https://api.deezer.com` (JSONP) only, no inline script or style (`style="…"` attributes
  and `<style>` elements are refused; CSSOM writes are fine), `connect-src 'self' https:`, images
  `'self'` / `https:` / `data:` / `blob:`, media `blob:` only, workers `'self'` only, fonts from Google Fonts,
  `object-src` / `base-uri` / `form-action` `'none'`.
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
js/sources/{spotify,deezer,itunes,resolver,local,text,demo,index}.js   [sources]
js/analysis/{dsp,tempo,grid,key,features,analyze,worker,client}.js      [analysis]  grid.js = beat grid vs. the audible attacks (Analysis.grid)
js/dj/timeline.js               [foundation — DONE, do not change semantics]
js/dj/{camelot,transitions,planner}.js   [brain]
js/dj/{engine,fx,recorder}.js   [engine]
js/dj/conductor.js              [integrator]
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
recipient's own stored vibe is neither used nor overwritten).

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

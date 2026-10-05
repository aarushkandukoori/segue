# Segue

**Your playlist, DJ'd live. Never the same set twice.**

Paste a Spotify playlist link and Segue plays it as one continuous DJ set in your browser: every track
is mixed into the next — beat-matched blends, bass swaps and filter sweeps where the tempos line up,
echo-outs, cuts, spinbacks and drops where they don't — with the decks, waveforms and mixer moving as it
happens. Press *New set* and the same playlist becomes a different mix.

**Live: https://aarushkandukoori.github.io/segue/**

![Segue mid-transition: two decks beat-locked during a filter blend](assets/screenshot.png)

No sign-up, no backend, no build step. It is a static site of plain ES modules with zero runtime
dependencies.

## How it works

```
 what you paste          track list            audio               analysis             planner               engine
┌───────────────┐    ┌───────────────┐    ┌──────────────┐    ┌───────────────┐    ┌────────────────┐    ┌───────────────┐
│ Spotify link  │    │ title, artist,│    │ 30 s preview │    │ tempo + beat  │    │ order, cue     │    │ Web Audio:    │
│ Deezer link   │ ─▶ │ duration      │ ─▶ │ from Deezer  │ ─▶ │ grid, key,    │ ─▶ │ points, which  │ ─▶ │ two strips,   │ ─▶ speakers
│ "Artist-Title"│    │ (never audio) │    │ or Apple; or │    │ loudness,     │    │ transition and │    │ EQ, filters,  │
│ your own files│    │               │    │ your file    │    │ energy, cues  │    │ when, as a plan│    │ delay, reverb │
└───────────────┘    └───────────────┘    └──────────────┘    └───────────────┘    └────────────────┘    └───────────────┘
   js/sources            js/sources           js/sources          js/analysis         js/dj/planner          js/dj/engine
                                                                  (Web Worker)        js/dj/transitions      js/dj/fx
```

- **Sources** read the track list. Spotify pages cannot be read from another website, so the playlist's
  public embed page is fetched through public relays; Deezer links and charts are read directly.
- **Audio** for each track is a 30-second preview matched by title, artist and length on Deezer, with
  Apple's iTunes previews as a fallback. A weak match is skipped rather than played as the wrong song.
- **Analysis** runs in a Web Worker: tempo and beat grid, downbeat, how clearly the loud hits sit on
  that grid, musical key (shown as Camelot codes), loudness, energy and the waveform. Results for
  previews are cached in IndexedDB; analyses of your own files stay in memory.
- **The planner** is a pure function of seed + analyses. It picks the next track from the first five
  unplayed ones (tempo, key, energy arc, whether the two can really be blended — now and one track
  ahead —, no artist twice in a row), decides where to leave one track and enter the next, and writes
  the transition as timed automation: rate points and fader / EQ / filter / send events.
- **The engine** executes that plan with sample-accurate Web Audio scheduling. Timers only do
  bookkeeping, so a busy tab or a background tab does not move a beat.
- **The conductor** (`js/dj/conductor.js`) keeps it running: prepares tracks three at a time, hands each
  transition to the engine well ahead of time, and loops through the playlist endlessly (every pass
  plays every track once).

When two tracks are within 8 % in tempo, both tempos are trusted and the two beat grids can be laid
over each other (see *Honest limits*), the incoming track is sped up or slowed down to match, its
downbeat is placed on a downbeat of the outgoing track, and it glides back to its own tempo afterwards.
Otherwise the planner uses moves that need no overlap: echo-out, reverb wash, cut, spinback, brake,
loop roll, riser and drop. The ticker under the waveforms names the move and, when it is not a
beat-matched blend, says why ("tempos too far apart to match", "no steady beat detected in the incoming
track", "tempos match, but the drums would clash — kept apart", "chosen for variety").

## What makes each set unique

Every set has a six-character seed. The seed decides the running order, which track opens, the
transition type for each pair, its length, the cue points and the small tricks in between (filter dips,
echo throws, beat repeats, builds). The *Vibe* slider shifts the odds from long smooth blends to cuts,
rolls and spinbacks.

The address bar always holds a link to the set that is playing
(`?p=<playlist>&seed=<seed>&vibe=<0..1>`). Opening that link rebuilds the same set: same order, same
transitions, at the sender's vibe — the recipient's own slider setting is neither used nor changed.
The link describes the set as its seed and vibe make it from the first track; a Skip, or a Vibe change
part-way through, is not in it. Sets from your own files or a pasted list have no such link. *New set*
replaces the link in place, so the browser's Back button leaves the set for the start screen instead of
stepping through old seeds.

## Honest limits

- **30-second previews, not full songs.** Spotify's audio is DRM-protected and its developer policy
  forbids mixing or overlapping Spotify content, so Segue never touches Spotify audio. Spotify is used
  for the track list only; the sound is the preview clip Deezer or Apple publish for the same recording.
- **Full-length sets need your own files.** Drop audio files on the page and they are mixed at full
  length (Short / Medium / Full track length). They are decoded locally and never uploaded.
- **Public playlists only**, and only the first 100 tracks: that is what Spotify's public embed exposes.
- **The Spotify track list depends on third-party relays** that offer no guarantees. If they are all
  down, the demo crates, Deezer links, pasted lists and local files still work.
- **Not every track has a preview.** Typically 90 % or more of a mainstream playlist resolves; the rest
  is marked "No audio" and skipped.
- **No key lock.** Beat-matching changes playback speed, so a matched track is also pitched by up to
  ±8 % until it glides home.
- **How much of a set is beat-matched depends on the playlist.** Tracks are only matched within 8 % of
  tempo, and the next one is picked from the five that are up next. Measured on one day's Deezer charts
  (2026-10-05, 40 tracks a chart, default vibe), overlapping beat-matched blends were 30 % of all
  transitions on the dance and electro charts, 27 % on the global hits chart and 21 % on hip-hop, latin
  and r&b. The rest are hand-overs that need no overlap, and the ticker says why each was chosen. A
  playlist whose tempos are spread widely mostly gets those.
- **Beat grids are estimated, so two tracks are only overlapped where the estimate can be trusted.** The
  analysis notes how clearly the loud hits sit on the beats at each end of a clip and keeps a small map
  of where they fall. Before the planner blends two tracks it lays the two maps over each other and
  checks that the hits meet on the beat, not half a beat apart. Where they do not (a syncopated intro,
  an off-beat rhythm, a grid that may be half a beat off, a tempo-doubled pair) it hands over on a bar
  line instead (echo-out, cut, drop, roll, spinback, brake or a short wash), carrying the tempo across
  where the move allows. Measured on the same day's charts (282 previews; `node tests/e2e/mix.e2e.mjs
  --tracks=40 --blends=40`: the two rendered stems cross-correlated over every sampled blend, no
  allowances), the two tracks' drums were within 20 ms of each other in 116 of 118 blends on the dance,
  electro and pop charts, 83 of 90 on hip-hop, latin and r&b and 37 of 40 on rock; the default, smaller
  run of the same test gave 40 of 41 and 41 of 42. Nearly every miss is half a beat apart. Other days'
  charts will move these figures by a few points; the test fails below 90 % and 80 %.
- **A share link is rebuilt from the seed, not recorded.** It gives the same set only while the
  playlist itself is unchanged (charts and editorial playlists change). And the recipient waits for the
  first three tracks of the running order before choosing the opener, while the sender's own set starts
  as soon as it can: on a slow connection the sender can have heard a different opener than the link
  gives.
- **Browsers: Chrome and Firefox are tested, Safari is not.** Everything in *Tests* runs in headless
  Chrome (154). In headless Firefox (155) the engine's timing, automation, effects and compatibility
  groups and the four screens of the interface run as part of those suites, and the whole app was
  driven once for this release by a script that is not part of them: a demo crate played for 75
  seconds without a gap, with transitions, Skip, pause and resume, New set and Back all working, no
  console errors and no Content-Security-Policy violations. Safari — macOS and iOS — was not run for
  this release. The code has paths written for it
  (audio unlocked by the tap that opens the file picker, the "interrupted" state of a phone call, a
  silent element against the mute switch), and they are tested only as far as Chrome and Firefox can
  imitate them.

## Privacy

There are no accounts, no analytics, no cookies and no server of Segue's own. The page itself is static
files; everything else it talks to is a third party, and each of them sees your IP address:

- **On every visit: Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) for the typefaces. The
  stylesheet is requested without a referrer and the page works without it (system fonts).
- **When you play a demo crate or a Deezer link: Deezer** — its public API (`api.deezer.com`, loaded as
  a script because it offers no other way in), the preview audio (`cdnt-preview.dzcdn.net`) and cover
  art (`cdn-images.dzcdn.net`).
- **When you paste a Spotify link:** the playlist's address goes to a third-party relay so its public
  embed page can be read — `web.scraper.workers.dev` first, then `r.jina.ai`, then `api.microlink.io` if
  the one before fails. Spotify itself is asked directly (`open.spotify.com`) only when a relay reports
  the playlist missing or returns it without its title and cover, and its image host (`i.scdn.co`)
  serves the cover. Then every track's **title and artist are sent to Deezer's search** to find a
  preview, and those Deezer does not have to **Apple's iTunes search** (`itunes.apple.com`), whose
  preview and artwork hosts are loaded in turn. The same searches happen for a pasted "Artist - Title"
  list.
- **Opening a share link does all of that before you tap anything**: the playlist is read and the
  first previews are downloaded and analysed while "Start the set" is showing. Nothing plays, and no
  audio output is opened, until the tap.
- **Your own files never leave the device.** They are decoded and analysed locally; nothing about them
  is stored (their analyses live in memory until the tab is closed).

In your browser Segue keeps: volume, vibe and track length in local storage, and the analysis results
of previews in IndexedDB under the preview's id (at most 2,000; then the cache starts over). A set you
record is saved by your browser as a download and goes nowhere else.

## Run it locally

```
git clone https://github.com/aarushkandukoori/segue.git
cd segue
npm run serve        # http://127.0.0.1:4173 — a tiny static server, no install needed
```

Any static file server works. There is nothing to build.

## Tests

```
npm install          # dev only: puppeteer-core, to drive your installed Chrome
npm test             # 396 node tests: planner, transitions, analysis, sources, conductor (no browser, no network)
npm run e2e          # all headless-browser suites in sequence (needs Chrome and the network; about 9 minutes)
npm run e2e:app      # the whole app against the real network: demo crate, Spotify link, share link,
                     #   skip, new set, pause, local files, pasted list, phone viewport, recording,
                     #   interrupted audio, Back / Forward
npm run e2e:mix      # mix quality on real previews, rendered offline through the real engine:
                     #   beat alignment of beat-matched pairs, no clipping, no gaps, no clicks, levels
```

What the browser suites check, as run on 2026-10-05 (the numbers are individual checks):

| suite | checks | what |
|---|---|---|
| engine | 292 | scheduling to the sample, automation, effects, cancel / skip, lifecycle and leaks, rendered offline; part of it again in Firefox |
| engine + planner | 8 | planned sets through the real engine |
| analysis | 39 | the Worker pipeline against the same code in Node, caching, what is and is not stored |
| sources | 102 | live Deezer / Apple / Spotify-relay reads, preview matching, hostile and oversized answers, a throttled line |
| ui | 317 | the screens at ten viewport sizes, every control, hostile strings, the Content-Security-Policy, Firefox |
| mix | 23 | beat alignment, clipping, gaps, clicks and levels on the day's charts |
| app | 95 | the whole app, as listed above |

Nine of the node tests run on real music (`tests/analysis.real.test.js`, `tests/dj.real.test.js` and
one test in `tests/analysis.grid.test.js`) and need preview clips that are not in the repository;
without them they are skipped. `node tests/tools/fetch-fixtures.mjs` downloads them into `tests/fixtures/` (git-ignored; needs
ffmpeg). No audio is ever committed. The Firefox parts of the engine and UI suites run when Firefox is
installed and are skipped otherwise.

## Layout

```
index.html, css/          the page
js/main.js                wiring: view ↔ conductor, URL + history, share, recording, Media Session
js/ui/                    the view (state in, DOM out)
js/sources/               playlist readers, preview matching, downloads
js/analysis/              tempo, beats, grid trust, key, loudness, waveform (runs in a Worker)
js/dj/                    planner, transitions, engine, fx, conductor
tests/                    node tests; tests/e2e/ headless-browser suites
SPEC.md                   the contract between the modules (data shapes, module APIs)
```

## Roadmap

- Licensed full-track sources
- Key-lock time-stretching, so matched tracks keep their pitch
- Stems (drums / bass / vocals) for acapella and instrumental blends
- Live crowd controls: requests, energy votes, shared sets

## Credits and licence

Built by Aarush Kandukoori. MIT licence, see [LICENSE](LICENSE).

Segue is not affiliated with Spotify, Deezer or Apple. Track names, artwork and previews belong to
their owners and are loaded from those services at play time; nothing is stored or redistributed.

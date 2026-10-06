# Segue

**Your playlist, DJ'd live. Never the same set twice.**

Paste a Spotify playlist link and Segue plays it as one continuous DJ set in your browser, every song
mixed into the next. It has two ways of doing that, picked with *Track length*:

- **Short / Medium / Full — whole songs, for any playlist.** The songs play in YouTube's own embedded
  player: two players on screen are the two decks. Segue finds each song's video, pre-loads the next one
  on the idle deck while the current one plays, and hands over with long blends, crossfades, fade-drops,
  riser-drops and cuts, about 45 s into each song (Short), about 90 s (Medium) or near its end (Full).
- **Preview — 30-second clips, really DJ'd.** The clips are mixed in Web Audio: beat-matched blends, bass
  swaps and filter sweeps where the tempos line up, echo-outs, cuts, spinbacks and drops where they don't,
  with waveforms and a working mixer.

Press *New set* and the same playlist becomes a different mix. Your own audio files play full length in
the Web Audio mixer too.

**Live: https://aarushkandukoori.github.io/segue/**

![Segue mid-transition: two decks beat-locked during a filter blend](assets/screenshot.png)

No sign-up, no backend, no build step. It is a static site of plain ES modules with zero runtime
dependencies.

**Full songs come from YouTube's embedded player, ads included.** Every music video starts with one or
two pre-roll ads (from 12 s to about four minutes in our test runs). Segue never hides or skips them: it
starts the next song's video in plain view on the idle deck at volume 0 while the current song plays —
muted until your first tap; after it, unmuted at volume 0, so the ad also runs on while Segue is in a
background tab — and nothing is heard until the song is mixed in. So the ad has usually run by the time
the mix needs that song. That silent pre-loading is what keeps ads from interrupting the set — and it is a
grey area under YouTube's terms for anything beyond personal, non-commercial use. A skippable ad can be
skipped by you, in the player, as on YouTube.

## How it works

**Full songs (Short / Medium / Full):**

```
 what you paste          track list          the video               the mix
┌───────────────┐    ┌───────────────┐    ┌──────────────────┐    ┌──────────────────────────────────────┐
│ Spotify link  │    │ title, artist,│    │ YouTube search   │    │ two YouTube players = two decks;     │
│ Deezer link   │ ─▶ │ duration      │ ─▶ │ (through relays),│ ─▶ │ the idle one pre-loads the next song │ ─▶ speakers
│ "Artist-Title"│    │               │    │ scored, checked  │    │ at volume 0; volume lanes at 20 Hz,  │
└───────────────┘    └───────────────┘    └──────────────────┘    │ risers and impacts in Web Audio      │
   js/sources            js/sources         js/sources/youtube     └──────────────────────────────────────┘
                                                                     js/dj/fullset, ytdeck, videomix
```

- **Finding the video**: YouTube's search page is read through the same kind of public relays as
  Spotify's (it cannot be read from another website directly) and every result is scored: the artist must
  be there, the length must fit, and live versions, covers, sped-up edits, remixes and the like are turned
  down. Up to 7 of the best uploads of each song are then checked with YouTube's oEmbed, which answers
  with YouTube's own title and channel for each; those are scored again, so a relay that mislabels a
  video is caught and festival sets, radio sessions and TV-show uploads are turned down. The best one left
  plays and up to 4 others are kept as alternates. A result is reused from your browser's storage for up
  to 60 days (checked with oEmbed again once per visit before it is used), then looked up again.
- **The decks**: the official IFrame Player API on the `youtube-nocookie.com` host (YouTube's
  "privacy-enhanced mode", which does not keep YouTube's and the ads' cookies away — see *Privacy*), never
  moved, covered, shrunk or hidden. The next song is cued as soon as a deck is free, at volume 0 (muted
  before your first tap, unmuted at volume 0 after it); once its ad is over the song waits at 0:00.
  YouTube's auto-generated captions are switched off on every deck as soon as its song plays (YouTube
  still draws captions on its ads, which the player API cannot turn off). The players are given only this
  page's origin and path, never the playlist link or the set's seed, vibe or length (see *Privacy*).
- **The transition** is planned once the next song is waiting (`js/dj/videomix.js`): which move, how long,
  where to leave the current song. The 30-second preview of each song is analysed in the background, so
  the plan knows the two tempos and energies — but YouTube's audio never reaches the page, so the move is
  made with the two players' volume only, and risers and impacts are layered on top in Web Audio.
- **When a video will not play** (its owner blocks embedding, it was removed, its player never gets
  going) the next upload is tried, then the song's 30-second preview plays through Web Audio in its place,
  and only then is it skipped. An ad that does not end, or that keeps the music stopped for 12 s, gives
  way to the song's preview when it has one, not to another upload (which would bring a new ad). If YouTube does not work at all (blocked by a content blocker or the network), the set
  switches to Preview and says why.
- **Switching** between Preview and a full-song length mid-set does not stop the music: the old set plays
  on until the new one has its first song sounding, then they crossfade. The running order goes on where
  it was (what was already played is not played again in this pass) and *Elapsed* keeps counting, in both
  directions. *Play previews instead*, offered while the first song's ad runs, switches this set only:
  the next playlist plays at your track length again. *New set* works like a switch: the song on air
  plays on until the new set's first song is past its ad.

**Preview (30-second clips):**

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
  plays every track once). Full songs have a conductor of their own (`js/dj/fullset.js`) that does the
  same with the two YouTube decks.

In Preview, when two tracks are within 8 % in tempo, both tempos are trusted and the two beat grids can be laid
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
(`?p=<playlist>&seed=<seed>&vibe=<0..1>&len=<preview|short|medium|full>`). Opening that link rebuilds the
same set: same order, same transitions, at the sender's vibe and track length — the recipient's own
settings are neither used nor changed. A link without `len` was made before full songs existed and plays
30-second previews, as it always did. A full-song link opens on the stage with the first song's ad
already running (muted) and waits for a tap on Play; full-song sets reproduce the order of songs, while
the exact moves can differ when the recipient's previews were analysed at different moments. One
exception to the order: when the first song is still in its ad 15 s after the second song is ready, the
set opens with the second song, so the order differs by its first two songs swapping places (see *Ads,
and the wait for the first song*).
The link describes the set as its seed and vibe make it from the first track; a Skip, or a Vibe change
part-way through, is not in it. Sets from your own files or a pasted list have no such link. *New set*
replaces the link in place, so the browser's Back button leaves the set for the start screen instead of
stepping through old seeds.

## Honest limits

- **Spotify's audio is never used.** It is DRM-protected and Spotify's developer policy forbids mixing or
  overlapping it. Spotify is used for the track list only; the sound is YouTube's video of the song (full
  songs), or the 30-second preview Deezer or Apple publish for the same recording (Preview).
- **Full songs are mixed by volume only.** YouTube's player plays in its own frame; its audio never enters
  the page. So there is no beat-matching, no EQ, no filters, no effects on the songs themselves, no
  waveform and no recording in full-song mode — the transitions are volume moves (long blends,
  crossfades, fade-outs into a dropped-in next song, cuts) with risers and impacts layered on top. The
  ticker says so ("blended by volume — no beat-matching on full songs"). Preview is where the DJ tricks are.
- **Ads, and the wait for the first song.** The first song of a set waits for a pre-roll ad: time to
  first sound in our runs was 9-50 s after pasting a link in most runs, and up to about three minutes when
  YouTube served long ad breaks (the night of 2026-10-06) (*Play previews instead* is offered meanwhile, and a skippable ad can be
  skipped in the player). The first two songs' ads run at the same time, on the two decks; when the second
  song is cued and the first is still in its ad 15 s later, the set opens with the second song (the seeded
  order then swaps only its first two songs). After that the next song's ad runs at volume 0 on the idle
  deck while the current one plays; when an ad runs long, the current song simply plays on past its
  planned exit — in Short mode a song can play well beyond 45 s. Once the music has stopped (a song
  ended) and has waited 12 s on an ad, the incoming song's 30-second preview plays instead. A player that
  gets nowhere is given up for the song's next upload after 3 minutes of time with the page in front (for
  a next song: as long as the song on air still runs plus 15 s, within 2-5 minutes); an ad that is still
  moving gets up to 4 more minutes, because every new video brings a new ad.
- **Background tabs.** Full songs keep playing while Segue is in a background tab, with their
  transitions on time. Measured in Chrome with its real background-tab throttling (2026-10-06, four runs
  of 180-200 s hidden): 15 songs came in while hidden, all of them full songs; the 14 hand-overs among
  them started 0.28-0.34 s after their planned moment, with no silence (the 15th was a set's first song,
  which started there once its ad was over). In a fifth run the next song's ad ran for more than 200 s:
  the song on air played on to its end, as it would in front (the run ended 9 s into the silence after
  it, where the 12 s rule above applies). Two things make this work: after your
  first tap the next song is pre-rolled unmuted at volume 0, which Chrome lets run in a background tab
  (it holds a muted one still), and the set runs on a clock in a Web Worker, whose timers Chrome does not
  slow down (the page's own timers fired once a minute there). Firefox and Safari were not run in a
  background tab.
- **iOS ignores the player's volume** (mute / unmute only), so on an iPhone or iPad Segue makes every
  full-song transition a cut, at the moment the blend would have crossed over (rather than two songs at
  full level for the length of a blend). Not run on Safari or iOS at all (see below).
- **Some videos refuse to be embedded**, and that only shows when they start. Segue then tries the song's
  other uploads, then plays its 30-second preview in place of the video (the deck says *No video · its
  30-s preview*), then skips it. A preview is shorter than most ads, so after one there can be a short wait for the next song.
- **Wrong video, rarely.** Matching is by title, artist and length; on 4 playlists (63 songs, then 117,
  then 40 older ones) no wrong pick was found by hand, but a song whose official upload is missing gets a
  verified lyric-channel re-upload, and a pasted title with no artist can match a different song of the
  same name.
- **Your own files** are mixed at full length in Web Audio (Short / Medium / Full) with every trick
  Preview has. They are decoded locally and never uploaded.
- **Public playlists only**, and only the first 100 tracks: that is what Spotify's public embed exposes.
- **The Spotify track list and the YouTube search depend on third-party relays** that offer no
  guarantees. If the Spotify relays are down, the demo crates, Deezer links, pasted lists and local files
  still work; if the YouTube search relays are down, sets fall back to Preview.
- **Not every track has a preview.** Typically 90 % or more of a mainstream playlist resolves; in Preview
  the rest is marked "No audio" and skipped.
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
  Chrome (154); full songs were run only in Chrome (the YouTube deck alone also in headless Firefox). In headless Firefox (155) the engine's timing, automation, effects and compatibility
  groups and the four screens of the interface run as part of those suites, and the whole app was
  driven once for this release by a script that is not part of them: a demo crate played for 75
  seconds without a gap, with transitions, Skip, pause and resume, New set and Back all working, no
  console errors and no Content-Security-Policy violations. Safari — macOS and iOS — was not run for
  this release. The code has paths written for it
  (audio unlocked by the tap that opens the file picker, the "interrupted" state of a phone call, a
  silent element against the mute switch), and they are tested only as far as Chrome and Firefox can
  imitate them.

## Privacy

There are no accounts, no analytics and no server of Segue's own, and Segue itself sets no cookies.
**The third parties it loads do set cookies — YouTube, Google's ad servers and Deezer, listed below.** A
plain visit to the home page leaves none. The page itself is static files; everything else it talks to
is a third party, and each of them sees your IP address:

- **On every visit: Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) for the typefaces. The
  stylesheet is requested without a referrer and the page works without it (system fonts).
- **For every playlist except your own files: Deezer** — its public API (`api.deezer.com`, loaded as a
  script because it offers no other way in) for demo crates, Deezer links and the preview searches below,
  the preview audio (`cdnt-preview.dzcdn.net`) and cover art (`cdn-images.dzcdn.net`). Loading that API
  script sets a Deezer visitor cookie on `.deezer.com` (`dzr_uniq_id`, kept about six months). Deezer's
  servers also send Akamai bot-check cookies (`_abck`, `bm_sz`) without the flag that lets a cookie be set
  from another site, so Chrome drops them; another browser may keep them.
- **Full songs: YouTube and Google** see every song you play (the player API is loaded from
  `www.youtube.com`, the players play from `www.youtube-nocookie.com` and show Google's ads). To find the
  videos, each song's artist and title are sent as a YouTube search through a third-party relay —
  `web.scraper.workers.dev` first; `r.jina.ai` as well whenever the first fails or has not answered
  within 3 s, and first for two minutes after the first has failed twice — and up to 7 of the videos found
  for each song (a stored choice once per visit) are checked with YouTube's oEmbed
  (`www.youtube.com/oembed`). The players get only this page's origin and
  path (`https://aarushkandukoori.github.io/segue/`), never the playlist link or the set's seed, vibe or
  length: Segue builds each player's frame itself rather than letting YouTube's player API copy the whole
  address bar into it. The 30-second previews are still looked up and downloaded in the background
  (Deezer / Apple, as below) for tempo and energy and as the stand-in for a video that will not play.
- **Full songs set YouTube and Google advertising cookies**, and full songs are the default mode. Loading
  YouTube's player API (`www.youtube.com/iframe_api`) sets YouTube's visitor cookies on `.youtube.com`
  (`VISITOR_INFO1_LIVE`, `__Secure-YNID`, `YSC` and a few more, most kept about six months). The
  `youtube-nocookie.com` host ("privacy-enhanced mode") does not prevent this: once a player starts an
  ad (silent pre-rolls included), the ad reports back to `www.youtube.com` with those cookies and the ad
  servers set Google advertising cookies on `.doubleclick.net` (`IDE` for up to 13 months, `APC`,
  `test_cookie` — which ones depends on the ad). Measured in Chrome, which accepts third-party cookies by
  default; a browser that blocks or partitions third-party cookies keeps fewer of them, or keeps them for
  this site only.
- **When you paste a Spotify link:** the playlist's address goes to a third-party relay so its public
  embed page can be read — `web.scraper.workers.dev` first, then `r.jina.ai`, then `api.microlink.io`,
  each one as well whenever the one before fails or has not answered within 3.5 s. Spotify itself is
  asked directly (`open.spotify.com`) only when a relay reports the playlist missing or returns it
  without its title and cover, and its image host (`i.scdn.co`) serves the cover. Then every track's
  **title and artist are sent to Deezer's search** to find a preview, and those Deezer does not have to
  **Apple's iTunes search** (`itunes.apple.com`), whose preview and artwork hosts are loaded in turn. The
  same searches happen for a pasted "Artist - Title" list.
- **Opening a share link does all of that before you tap anything**: the playlist is read and the
  first previews are downloaded and analysed while "Start the set" is showing — for a full-song link the
  first two videos are looked up and their ads start, muted, in the players on screen. **So the cookies
  above are set without a tap**: Deezer's for any shared playlist, and YouTube's and the ad servers' for a
  full-song link. Nothing is heard, and no audio output is opened, until the tap.
- **Your own files never leave the device.** They are decoded and analysed locally; nothing about them
  is stored (their analyses live in memory until the tab is closed).

In your browser Segue keeps:

- **Volume, vibe and track length** in local storage.
- **Which YouTube video was found for which song** (local storage, `segue:yt:v1`): one record per song,
  under its artist and title, holding the video id, up to 4 alternate video ids, the video's title,
  channel and length, its score and the time it was found; at most 1,500 records (the oldest go first).
  A record is used for 60 days from the time it was found — the once-a-visit check with YouTube's oEmbed
  does not renew it. Records older than 60 days, dated more than a day ahead, or malformed are deleted at
  the first full-song lookup of each visit and on every write, and a stored value over 4 MB is removed
  whole. Songs for which no video was found are never stored.
- **The analysis results of previews** in IndexedDB under the preview's id (at most 2,000; then the cache
  starts over).

All of it belongs to the origin
`aarushkandukoori.github.io`, which the owner's other GitHub Pages sites share: their pages can read and
change what Segue stores, and clearing site data for one clears it for all. The third-party
cookies above belong to those sites, not to Segue (it never reads them); clearing your browser's data for
`youtube.com`, `doubleclick.net` and `deezer.com` removes them. A set you record is saved by your browser
as a download and goes nowhere else.

## Run it locally

```
git clone https://github.com/aarushkandukoori/segue.git
cd segue
npm run serve        # http://127.0.0.1:4173 — a tiny static server, no install needed
```

Any static file server works. There is nothing to build.

**Full songs on a local address:** YouTube decides per embedding site, and label music refuses to play on
`http://127.0.0.1` (error 150 — the set then falls back to previews and says why). To try full songs
during development use the live site, or serve the repo *as* the real site inside headless Chrome with
`tests/e2e/origin.mjs` (`serveAsOrigin(page)`; the full-song e2e suite does exactly that).

## Tests

```
npm install          # dev only: puppeteer-core, to drive your installed Chrome
npm test             # 491 node tests: planner, transitions, analysis, sources, both conductors, the worker
                     #   clock (no browser, no network)
npm run e2e          # all headless-browser suites in sequence (needs Chrome and the network; about 35 minutes,
                     #   longer when YouTube serves long ads)
npm run e2e:app      # the whole app against the real network: demo crate, Spotify link, share link,
                     #   skip, new set, pause, local files, pasted list, phone viewport, recording,
                     #   interrupted audio, Back / Forward
npm run e2e:mix      # mix quality on real previews, rendered offline through the real engine:
                     #   beat alignment of beat-matched pairs, no clipping, no gaps, no clicks, levels
npm run e2e:full     # full songs: the whole app served as the real site, real YouTube players and ads, a
                     #   real background tab (~11 minutes; the ads are sat through, never skipped)
npm run e2e:privacy  # the Privacy section above against a real run: what a plain visit and a share link
                     #   contact, which cookies they leave before any tap, what YouTube is handed (~1 min)
```

What the browser suites check, as run on 2026-10-06 (the numbers are individual checks):

| suite | checks | what |
|---|---|---|
| engine | 292 | scheduling to the sample, automation, effects, cancel / skip, lifecycle and leaks, rendered offline; part of it again in Firefox |
| engine + planner | 8 | planned sets through the real engine |
| analysis | 39 | the Worker pipeline against the same code in Node, caching, what is and is not stored |
| sources | 102 | live Deezer / Apple / Spotify-relay reads, preview matching, hostile and oversized answers, a throttled line |
| ui | 627 | the screens at ten viewport sizes, every control, hostile strings, the Content-Security-Policy, the video stage (players never covered, at every size), Firefox |
| mix | 23 | beat alignment, clipping, gaps, clicks and levels on the day's charts |
| app | 97 | the whole app in Preview and with local files, as listed above |
| youtube | 25 | the YouTube finder on four real Spotify playlists (63 songs, every pick reviewed), oEmbed with YouTube's own title and channel (an honest and a lying relay claim; no live, festival or broadcast pick), the stored choices read back by a new finder, the relays, hostile answers |
| ytdeck | 56 | one YouTube deck under the real origin with real background-tab throttling: muted and unmuted-at-volume-0 pre-rolls through real ads (silence checked inside the player's own frame), the gesture rule, unlock, crossfade by volume, cueing and starting in a hidden tab, captions, errors, what YouTube receives, teardown; part of it in Firefox |
| full | 91 | full songs in the whole app: time to first sound, transitions, volume lanes, players never covered, Skip, Preview ↔ Medium and New set without a gap (running order and Elapsed carried over), share links, phone, a forced embed refusal → preview, a real background tab (full songs on time while hidden), New set during a move, *Play previews instead* for this set only, Home during a load |
| privacy | 18 | *Privacy* above against a real run with no tap: hosts and cookies of a plain visit, a Preview and a full-song share link; every site that leaves a cookie is named here; no request to YouTube or Google carries the share link's query; relay delays match the code |

Nine of the node tests run on real music (`tests/analysis.real.test.js`, `tests/dj.real.test.js` and
one test in `tests/analysis.grid.test.js`) and need preview clips that are not in the repository;
without them they are skipped. `node tests/tools/fetch-fixtures.mjs` downloads them into `tests/fixtures/` (git-ignored; needs
ffmpeg). No audio is ever committed. The Firefox parts of the engine and UI suites run when Firefox is
installed and are skipped otherwise.

## Layout

```
index.html, css/          the page
js/main.js                wiring: view ↔ the two conductors, URL + history, share, recording, Media Session
js/ui/                    the view (state in, DOM out); the video stage is js/ui/vstage.js
js/sources/               playlist readers, preview matching, downloads, the YouTube finder
js/analysis/              tempo, beats, grid trust, key, loudness, waveform (runs in a Worker)
js/dj/                    Preview: planner, transitions, engine, fx, conductor
                          full songs: fullset (conductor), ytdeck (one YouTube deck), videomix (transitions)
js/util/                  the seeded random numbers; the full-song clock (timers on a worker, so a
                          background tab does not slow the set down)
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

Segue is not affiliated with Spotify, Deezer, Apple, YouTube or Google. Track names, artwork, previews
and videos belong to their owners and are loaded from those services at play time; nothing is stored or
redistributed.

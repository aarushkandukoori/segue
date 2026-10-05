// Static markup for every screen. This string contains NO dynamic data — it is the only thing in the UI
// that is ever assigned through innerHTML. Everything that comes from the network, a file or the user is
// written later with textContent / validated attribute setters (see dom.js).

const svg = (body, cls = 'ic') =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${body}</svg>`;
const stroke = (d) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const ICONS = {
  play: svg('<path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.4-6.8a.6.6 0 0 0 0-1L8.92 4.7A.6.6 0 0 0 8 5.2z" fill="currentColor"/>', 'ic ic-play'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/>', 'ic ic-pause'),
  skip: svg('<path d="M5.5 5.6v12.8a.6.6 0 0 0 .93.5l9.3-6.4a.6.6 0 0 0 0-1l-9.3-6.4a.6.6 0 0 0-.93.5z" fill="currentColor"/><rect x="16.6" y="5" width="2.6" height="14" rx="1" fill="currentColor"/>'),
  shuffle: svg(stroke('M3 7h3.4a5 5 0 0 1 4.2 2.3l2.8 4.4a5 5 0 0 0 4.2 2.3H21M18.2 13.2 21 16l-2.8 2.8M3 17h3.4a5 5 0 0 0 4.2-2.3l.3-.5M13.2 9.9l.2-.6A5 5 0 0 1 17.6 7H21M18.2 4.2 21 7l-2.8 2.8')),
  share: svg(stroke('M12 15V3.5M7.8 7.4 12 3.2l4.2 4.2M5 12.5v6a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6')),
  volume: svg('<path d="M4 9.6v4.8a.6.6 0 0 0 .6.6h2.9l4 3.5a.6.6 0 0 0 1-.45V5.95a.6.6 0 0 0-1-.45l-4 3.5H4.6a.6.6 0 0 0-.6.6z" fill="currentColor"/><g class="ic-waves">' + stroke('M15.6 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8') + '</g><g class="ic-mute">' + stroke('M16 9.5l5 5M21 9.5l-5 5') + '</g>'),
  list: svg(stroke('M4 6.5h12M4 12h12M4 17.5h7') + '<circle cx="18" cy="17" r="2.4" fill="currentColor"/>' + stroke('M20.4 17V8.5')),
  close: svg(stroke('M6 6l12 12M18 6 6 18')),
  out: svg(stroke('M8 16 16.5 7.5M9.5 7.5h7v7'), 'ic ic-out'),
  link: svg(stroke('M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2')),
  files: svg(stroke('M9 18.5V6.2l10-2v12.3') + '<circle cx="6.5" cy="18.5" r="2.5" fill="currentColor"/><circle cx="16.5" cy="16.5" r="2.5" fill="currentColor"/>'),
  text: svg(stroke('M5 6.5h14M5 11h14M5 15.5h9M5 20h5')),
  lock: svg(stroke('M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5') + '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2" fill="currentColor"/>'),
  arrow: svg(stroke('M5 12h14M13 6l6 6-6 6')),
};

/** The Segue mark: one record, half warm and half cool, split by the playhead. */
export const MARK =
  '<svg class="mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">' +
  '<path d="M14.6 3.1a13 13 0 0 0 0 25.8z" fill="var(--a)"/><path d="M17.4 3.1a13 13 0 0 1 0 25.8z" fill="var(--b)"/>' +
  '<circle cx="16" cy="16" r="4.4" fill="var(--bg)"/></svg>';

const WORDMARK = `${MARK}<span class="wordmark-text">Segue</span>`;

const knob = (id, label) => `
        <div class="knob" data-knob="${id}">
          <div class="knob-dial">
            <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
              <circle class="k-track" cx="24" cy="24" r="21" transform="rotate(135 24 24)"/>
              <circle class="k-val" cx="24" cy="24" r="21" transform="rotate(-90 24 24)"/>
            </svg>
            <i class="knob-cap"><i></i></i>
          </div>
          <span class="knob-lbl">${label}</span>
        </div>`;

const knobs = () => `
      <div class="knobs">${knob('high', 'High')}${knob('mid', 'Mid')}${knob('low', 'Low')}${knob('filter', 'Filter')}
      </div>`;

const fader = (name) => `
      <div class="ch-fader">
        <div class="vu"><i></i></div>
        <div class="fader"><i class="fader-slot"></i><i class="fader-fill"></i><i class="fader-cap"></i></div>
        <span class="ch-id">${name}</span>
      </div>`;

const deck = (i, name) => `
    <section class="deck deck-${name.toLowerCase()} is-empty" data-ref="deck${i}" data-deck="${i}" aria-label="Deck ${name}">
      <div class="deck-body">
      <div class="platter" aria-hidden="true">
        <svg class="platter-ring" viewBox="0 0 100 100" focusable="false">
          <circle class="ring-track" cx="50" cy="50" r="48"/>
          <circle class="ring-val" cx="50" cy="50" r="48" transform="rotate(-90 50 50)"/>
        </svg>
        <div class="vinyl">
          <div class="vinyl-spin">
            <i class="vinyl-sticker"></i>
            <div class="vinyl-label"><img alt="" draggable="false"><span class="vinyl-letter">${name}</span></div>
          </div>
          <i class="vinyl-sheen"></i>
          <i class="vinyl-hole"></i>
        </div>
      </div>
      <div class="deck-info">
        <div class="deck-head">
          <span class="deck-id">${name}</span>
          <span class="deck-lamp" data-part="lamp">Empty</span>
          <span class="deck-provider"><span class="p-long" data-part="provider"></span><span class="p-short" data-part="provider-short"></span></span>
        </div>
        <h2 class="deck-title" data-part="title">Waiting for a track</h2>
        <p class="deck-artist" data-part="artist">The next one lands here</p>
        <div class="deck-ov" aria-hidden="true"><canvas></canvas><i class="ov-played"></i><i class="ov-head"></i></div>
        <div class="deck-stats">
          <div class="stat stat-bpm"><b class="num" data-part="bpm">–</b><span class="unit">BPM</span><span class="pitch" data-part="pitch"></span></div>
          <div class="stat stat-key"><span class="keyname" data-part="keyname"></span><b class="keychip" data-part="key">–</b></div>
        </div>
        <div class="deck-foot">
          <div class="stat stat-time"><span class="num" data-part="time">0:00</span><span class="unit" data-part="dur">/ 0:00</span></div>
          <a class="deck-link" data-part="link" hidden><span data-part="link-text">Open track</span>${ICONS.out}</a>
        </div>
      </div>
      </div>
    </section>`;

export const TEMPLATE = `
<canvas class="backdrop" data-ref="backdrop" aria-hidden="true"></canvas>
<div class="grain" aria-hidden="true"></div>

<main class="screen landing" data-screen="landing" tabindex="-1" hidden>
  <header class="l-top">
    <span class="wordmark">${WORDMARK}</span>
    <p class="l-top-note">No sign-up. Runs in your browser.</p>
  </header>

  <section class="l-hero">
    <h1 class="l-title"><span class="l-title-1">Your playlist,</span> <span class="l-title-2">DJ’d live.</span></h1>
    <p class="l-sub"><span class="l-sub-tag">Never the same set twice.</span> Paste a link and Segue beat-matches, blends and drops every track — a different mix each time you press play.</p>

    <form class="l-form" data-ref="form" novalidate>
      <label class="sr-only" for="segue-input">Spotify playlist link</label>
      <div class="l-field" data-ref="field">
        ${ICONS.link}
        <input id="segue-input" data-ref="input" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste a Spotify playlist link" aria-describedby="segue-input-hint">
        <button type="submit" class="btn btn-primary" data-ref="submit"><span>Start the set</span>${ICONS.arrow}</button>
      </div>
      <p class="l-hint" id="segue-input-hint" data-ref="hint" role="status"></p>
    </form>

    <div class="l-demos" data-ref="demos-row" hidden>
      <span class="l-label">or spin a crate</span>
      <div class="chips" data-ref="demos" role="group" aria-label="Ready-made crates"></div>
    </div>
  </section>

  <div class="l-wave" aria-hidden="true">
    <canvas data-ref="attract"></canvas>
    <span class="l-wave-tag l-wave-a"><b>A</b>124.0 BPM · 8A</span>
    <span class="l-wave-tag l-wave-b"><b>B</b>126.0 → 124.0 BPM · 9A</span>
    <span class="lock l-wave-lock" data-ref="attract-lock"><i></i><span>Beat lock</span></span>
  </div>

  <section class="l-more" aria-label="More ways to start">
    <div class="l-card l-drop" data-ref="drop">
      <input class="sr-only" id="segue-files" data-ref="file" type="file" multiple accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,.webm">
      <span class="l-card-ic">${ICONS.files}</span>
      <h2 class="l-card-title">Your own files</h2>
      <p class="l-card-text">Full-length sets from your own files. Drop audio anywhere on this page — nothing is uploaded.</p>
      <label class="btn btn-ghost" for="segue-files">Choose audio files</label>
    </div>

    <div class="l-card l-text">
      <span class="l-card-ic">${ICONS.text}</span>
      <h2 class="l-card-title">A track list</h2>
      <p class="l-card-text" data-ref="text-blurb">No link? Paste any list of songs, one per line.</p>
      <button type="button" class="btn btn-ghost" data-ref="text-toggle" aria-expanded="false" aria-controls="segue-text-panel">Paste a track list</button>
      <div class="l-text-panel" id="segue-text-panel" data-ref="text-panel" hidden>
        <label class="sr-only" for="segue-text">Track list, one “Artist - Title” per line</label>
        <textarea id="segue-text" data-ref="text" rows="5" spellcheck="false" autocapitalize="off" placeholder="Artist - Title&#10;Artist - Title&#10;Artist - Title"></textarea>
        <button type="button" class="btn btn-primary btn-sm" data-ref="text-go"><span>Mix this list</span>${ICONS.arrow}</button>
      </div>
    </div>

    <div class="l-card l-examples" data-ref="examples-card" hidden>
      <span class="l-card-ic">${ICONS.list}</span>
      <h2 class="l-card-title">Popular playlists</h2>
      <ul class="l-examples-list" data-ref="examples"></ul>
    </div>
  </section>

  <footer class="l-foot">
    <p>Segue mixes 30-second previews (from Deezer / Apple). Local files play full length. Not affiliated with Spotify.</p>
  </footer>

  <div class="dropveil" data-ref="dropveil" hidden><div><span class="l-card-ic">${ICONS.files}</span><p>Drop to start a full-length set</p></div></div>
</main>

<main class="screen loading" data-screen="loading" tabindex="-1" hidden>
  <button type="button" class="wordmark wordmark-btn" data-ref="ld-home" aria-label="Segue — cancel and go back">${WORDMARK}</button>
  <div class="ld-body">
    <div class="crate-anim" aria-hidden="true">
      <div class="crate-sleeves">
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        <span class="crate-front" data-ref="ld-sleeve"><img alt="" draggable="false"></span>
      </div>
      <div class="crate-box"><span>Segue</span></div>
    </div>
    <h1 class="ld-title" data-ref="ld-title">Digging through the crate</h1>
    <p class="ld-detail" data-ref="ld-detail" role="status" aria-live="polite"></p>
    <div class="ld-bar is-indeterminate" data-ref="ld-bar" role="progressbar" aria-label="Loading progress" aria-valuemin="0" aria-valuemax="100"><i data-ref="ld-fill"></i></div>
    <button type="button" class="btn btn-ghost btn-sm" data-ref="ld-cancel">Cancel</button>
  </div>
</main>

<main class="screen ready" data-screen="ready" tabindex="-1" hidden>
  <button type="button" class="wordmark wordmark-btn" data-ref="rd-home" aria-label="Segue — back to start">${WORDMARK}</button>
  <div class="rd-body">
    <div class="rd-art" aria-hidden="true">
      <div class="rd-vinyl"><i></i></div>
      <div class="rd-sleeve" data-ref="rd-sleeve"><img alt="" draggable="false"><span class="rd-sleeve-ph">${MARK}</span></div>
    </div>
    <div class="rd-text">
      <p class="eyebrow"><i class="led"></i>Cued up and ready</p>
      <h1 class="rd-title" data-ref="rd-title">Your playlist</h1>
      <p class="rd-sub" data-ref="rd-sub"></p>
      <p class="rd-meta"><span data-ref="rd-count"></span><span data-ref="rd-source"></span><span class="rd-seed">Set <b data-ref="rd-seed"></b></span></p>
      <button type="button" class="btn btn-primary btn-xl" data-ref="rd-start">${ICONS.play}<span>Start the set</span></button>
      <p class="rd-hint">Sound on — your browser needs one tap before it can play audio.</p>
    </div>
  </div>
</main>

<div class="screen stage" data-screen="stage" tabindex="-1" hidden>
  <header class="topbar">
    <button type="button" class="wordmark wordmark-btn" data-ref="home" aria-label="Segue — back to start" title="Back to start">${WORDMARK}</button>
    <div class="pl" data-ref="pl">
      <span class="pl-art"><img alt="" draggable="false"></span>
      <div class="pl-text">
        <a class="pl-title" data-ref="pl-title"></a>
        <span class="pl-meta" data-ref="pl-meta"></span>
      </div>
    </div>
    <div class="top-right">
      <div class="setid">
        <span class="lbl">Set</span>
        <b class="setid-code" data-ref="seed">#––––––</b>
        <button type="button" class="chipbtn" data-ref="share" title="Copy a link to this exact set" aria-label="Share — copy a link to this exact set">${ICONS.share}<span>Share</span></button>
      </div>
      <div class="elapsed"><span class="lbl">Elapsed</span><time data-ref="elapsed">0:00</time></div>
      <button type="button" class="rec" data-ref="rec" aria-label="Record this set" aria-pressed="false" title="Record this set"><i class="rec-dot"></i><span data-ref="rec-label">Rec</span></button>
    </div>
  </header>

  <!-- Before the booth in the DOM (after it on screen) so Tab reaches play / skip / New set without first
       walking every link in the setlist. -->
  <div class="transport" role="group" aria-label="Transport">
    <div class="tp-main">
      <button type="button" class="tp-round tp-play" data-ref="play" aria-label="Play" title="Play / pause (Space)">${ICONS.play}${ICONS.pause}</button>
      <button type="button" class="tp-round tp-skip" data-ref="skip" aria-label="Skip to the next track" title="Skip to the next track (→)">${ICONS.skip}</button>
      <button type="button" class="newset" data-ref="newset" title="Same crate, brand-new mix (N)">${ICONS.shuffle}<span class="newset-text"><b>New set</b><small>same crate, new mix</small></span></button>
    </div>

    <div class="tp-vibe">
      <label class="lbl" for="segue-vibe">Vibe</label>
      <div class="vibe-ctl">
        <input type="range" id="segue-vibe" data-ref="vibe" min="0" max="1" step="0.01" value="0.5">
        <div class="vibe-scale" aria-hidden="true"><span>Smooth</span><span>Club</span><span>Wild</span></div>
      </div>
    </div>

    <fieldset class="tp-mode" data-ref="mode">
      <legend class="lbl">Track length<span class="tp-mode-lock" data-ref="mode-lock">${ICONS.lock}</span></legend>
      <div class="seg">
        <label><input type="radio" name="segue-mode" value="preview"><span>Preview</span></label>
        <label><input type="radio" name="segue-mode" value="short"><span>Short</span></label>
        <label><input type="radio" name="segue-mode" value="medium"><span>Medium</span></label>
        <label><input type="radio" name="segue-mode" value="full"><span>Full</span></label>
      </div>
    </fieldset>

    <div class="tp-vol">
      <button type="button" class="iconbtn" data-ref="mute" aria-label="Mute" aria-pressed="false">${ICONS.volume}</button>
      <input type="range" id="segue-volume" data-ref="volume" min="0" max="1" step="0.01" value="0.9" aria-label="Volume">
    </div>

    <button type="button" class="tp-crate" data-ref="crate-toggle" aria-expanded="false" aria-controls="segue-crate">${ICONS.list}<span>Setlist</span></button>
  </div>

  <main class="booth" data-ref="booth">
${deck(0, 'A')}

    <section class="waves" data-ref="waves" aria-label="Waveforms: deck A above, deck B below, playhead in the centre">
      <canvas data-ref="wave-canvas" aria-hidden="true"></canvas>
      <span class="wave-tag wave-tag-a" data-ref="wt0"><b>A</b><span data-part="t">Empty</span></span>
      <span class="wave-tag wave-tag-b" data-ref="wt1"><b>B</b><span data-part="t">Empty</span></span>
      <span class="lock wave-lock" data-ref="lock"><i></i><span>Beat lock</span></span>
    </section>

${deck(1, 'B')}

    <section class="ticker" data-ref="ticker" data-state="idle" aria-label="What the DJ is doing">
      <span class="tk-tag" data-ref="tk-tag">On air</span>
      <div class="tk-main">
        <p class="tk-label"><span data-ref="tk-label">Warming up</span><span class="tk-to" data-ref="tk-to"></span></p>
        <p class="tk-why" data-ref="tk-why">Lining up the first track…</p>
      </div>
      <ol class="tk-marks" data-ref="tk-marks" aria-hidden="true"></ol>
      <div class="tk-count"><span class="lbl" data-ref="tk-count-lbl"></span><b data-ref="tk-count"></b></div>
      <div class="tk-bar" aria-hidden="true"><i class="tk-fill" data-ref="tk-fill"></i><div class="tk-notches" data-ref="tk-notches"></div></div>
      <p class="sr-only" aria-live="polite" data-ref="tk-live"></p>
    </section>

    <section class="mixer" data-ref="mixer" aria-label="Mixer — the DJ moves these, you watch">
      <div class="mx-body" aria-hidden="true">
        <div class="ch ch-a" data-ch="0">${fader('A')}${knobs()}
        </div>
        <div class="master">
          <span class="lbl">Master</span>
          <div class="meter"><i class="meter-lit" data-ref="meter-lit"></i><i class="meter-peak" data-ref="meter-peak"></i></div>
        </div>
        <div class="ch ch-b" data-ch="1">${knobs()}${fader('B')}
        </div>
      </div>
      <div class="xf" aria-hidden="true">
        <span class="xf-end xf-a">A</span>
        <div class="xf-slot" data-ref="xf"><i class="xf-cap" data-ref="xf-cap"></i></div>
        <span class="xf-end xf-b">B</span>
      </div>
    </section>

    <aside class="crate" id="segue-crate" data-ref="crate" aria-label="Setlist">
      <header class="crate-head">
        <h2>Setlist</h2>
        <span class="crate-count" data-ref="crate-count"></span>
        <button type="button" class="iconbtn crate-close" data-ref="crate-close" aria-label="Close setlist">${ICONS.close}</button>
      </header>
      <ol class="crate-list" data-ref="crate-list"></ol>
      <p class="crate-empty" data-ref="crate-empty">The setlist fills in as the DJ digs.</p>
    </aside>
  </main>

  <div class="scrim" data-ref="scrim" hidden></div>
</div>

<div class="toasts" data-ref="toasts" role="region" aria-label="Notifications" aria-live="polite"></div>
`;

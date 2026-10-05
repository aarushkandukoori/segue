#!/usr/bin/env node
// Downloads real 30-second Deezer previews for the analysis accuracy tests and converts them to
// mono 22050 Hz 16-bit WAV with ffmpeg. Everything lands in tests/fixtures/analysis/ (git-ignored —
// audio is NEVER committed). Idempotent: tracks that are already converted are skipped.
//
//   node tests/tools/fetch-fixtures.mjs                 # charts (25 per genre) + the hand-picked list
//   node tests/tools/fetch-fixtures.mjs --per-genre 40  # more chart tracks
//   node tests/tools/fetch-fixtures.mjs --no-charts     # hand list only
//   node tests/tools/fetch-fixtures.mjs --no-hand       # charts only
//
// Ground truth written to manifest.json per track:
//   handBpm   — tempo of a famous song from the HAND list below (reliable)
//   deezerBpm — Deezer's /track/<id> `bpm` field when > 0 (noisy: it has its own octave errors)
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const OUT = resolve(fileURLToPath(new URL('../fixtures/analysis/', import.meta.url)));
const MANIFEST = join(OUT, 'manifest.json');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const API = 'https://api.deezer.com';

const GENRES = [
  ['all', 0],
  ['pop', 132],
  ['rap', 116],
  ['rock', 152],
  ['dance', 113],
  ['rnb', 165],
  ['electro', 106],
  ['latin', 197],
];

// [artist, title, bpm, genre] — famous recordings whose studio tempo is well known.
// Tempos are the commonly published values; a few live-drummed tracks wander by ±1 BPM.
const HAND = [
  // dance / electro
  ['Daft Punk', 'One More Time', 123, 'dance'],
  ['Daft Punk', 'Around the World', 121, 'dance'],
  ['Daft Punk', 'Get Lucky', 116, 'dance'],
  ['Daft Punk', 'Harder, Better, Faster, Stronger', 123, 'dance'],
  ['Avicii', 'Levels', 126, 'dance'],
  ['Avicii', 'Wake Me Up', 124, 'dance'],
  ['Swedish House Mafia', "Don't You Worry Child", 129, 'dance'],
  ['Calvin Harris', 'Summer', 128, 'dance'],
  ['Calvin Harris', 'Feel So Close', 128, 'dance'],
  ['David Guetta', 'Titanium', 126, 'dance'],
  ['David Guetta', 'When Love Takes Over', 130, 'dance'],
  ['Martin Garrix', 'Animals', 128, 'electro'],
  ['Zedd', 'Clarity', 128, 'electro'],
  ['deadmau5', "Ghosts 'n' Stuff", 128, 'electro'],
  ['Eric Prydz', 'Call on Me', 126, 'dance'],
  ['Benny Benassi', 'Satisfaction', 130, 'electro'],
  ['Darude', 'Sandstorm', 136, 'electro'],
  ['Haddaway', 'What Is Love', 124, 'dance'],
  ['Corona', 'The Rhythm of the Night', 128, 'dance'],
  ['Snap!', 'Rhythm Is a Dancer', 124, 'dance'],
  ['Technotronic', 'Pump Up the Jam', 125, 'dance'],
  ['Stardust', 'Music Sounds Better With You', 124, 'dance'],
  ['Modjo', 'Lady (Hear Me Tonight)', 126, 'dance'],
  ['Kylie Minogue', "Can't Get You Out of My Head", 126, 'dance'],
  ['Madonna', 'Hung Up', 125, 'dance'],
  ['Bob Sinclar', 'Love Generation', 128, 'dance'],
  ['Fedde Le Grand', 'Put Your Hands Up for Detroit', 128, 'electro'],
  ['Tiësto', 'The Business', 120, 'dance'],
  ['MEDUZA', 'Piece of Your Heart', 124, 'dance'],
  ['FISHER', 'Losing It', 125, 'electro'],
  ['Robin Schulz', 'Prayer in C', 123, 'dance'],
  ['Lost Frequencies', 'Are You with Me', 121, 'dance'],
  ['Disclosure', 'Latch', 122, 'electro'],
  ['Skrillex', 'Bangarang', 110, 'electro'],
  ['Skrillex', 'Scary Monsters and Nice Sprites', 140, 'electro'],
  ['Pendulum', 'Tarantula', 174, 'electro'],
  ['Pendulum', 'Witchcraft', 174, 'electro'],
  ['The Chemical Brothers', 'Hey Boy Hey Girl', 127, 'electro'],
  ['The Chemical Brothers', 'Galvanize', 104, 'electro'],
  ['Fatboy Slim', 'Praise You', 110, 'electro'],
  ['Faithless', 'Insomnia', 127, 'electro'],
  ['Alice Deejay', 'Better Off Alone', 137, 'dance'],
  ['Eiffel 65', 'Blue (Da Ba Dee)', 128, 'dance'],
  ['Gigi D\'Agostino', "L'amour toujours", 139, 'dance'],
  ['ATB', '9 PM (Till I Come)', 130, 'dance'],
  ['Robert Miles', 'Children', 137, 'electro'],
  // pop
  ['Lady Gaga', 'Poker Face', 119, 'pop'],
  ['Lady Gaga', 'Bad Romance', 119, 'pop'],
  ['Lady Gaga', 'Just Dance', 119, 'pop'],
  ['Katy Perry', 'Firework', 124, 'pop'],
  ['Katy Perry', 'California Gurls', 125, 'pop'],
  ['LMFAO', 'Party Rock Anthem', 130, 'dance'],
  ['The Black Eyed Peas', 'I Gotta Feeling', 128, 'pop'],
  ['Rihanna', 'We Found Love', 128, 'pop'],
  ['Rihanna', "Don't Stop the Music", 123, 'pop'],
  ['Rihanna', 'Umbrella', 174, 'pop'],
  ['Britney Spears', 'Toxic', 143, 'pop'],
  ['Britney Spears', '...Baby One More Time', 93, 'pop'],
  ['Dua Lipa', "Don't Start Now", 124, 'pop'],
  ['Dua Lipa', 'Levitating', 103, 'pop'],
  ['Dua Lipa', 'New Rules', 116, 'pop'],
  ['Dua Lipa', 'Physical', 147, 'pop'],
  ['The Weeknd', 'Blinding Lights', 171, 'pop'],
  ['The Weeknd', 'Save Your Tears', 118, 'pop'],
  ['The Weeknd', 'Starboy', 93, 'rnb'],
  ['The Weeknd', "Can't Feel My Face", 108, 'pop'],
  ['Mark Ronson', 'Uptown Funk', 115, 'pop'],
  ['Pharrell Williams', 'Happy', 160, 'pop'],
  ['Justin Timberlake', "CAN'T STOP THE FEELING!", 113, 'pop'],
  ['Justin Timberlake', 'SexyBack', 117, 'pop'],
  ['Maroon 5', 'Moves Like Jagger', 128, 'pop'],
  ['Maroon 5', 'Sugar', 120, 'pop'],
  ['Carly Rae Jepsen', 'Call Me Maybe', 120, 'pop'],
  ['PSY', 'Gangnam Style', 132, 'pop'],
  ['Ed Sheeran', 'Shape of You', 96, 'pop'],
  ['Ed Sheeran', 'Bad Habits', 126, 'pop'],
  ['Billie Eilish', 'bad guy', 135, 'pop'],
  ['Taylor Swift', 'Shake It Off', 160, 'pop'],
  ['Taylor Swift', 'Blank Space', 96, 'pop'],
  ['Taylor Swift', 'Anti-Hero', 97, 'pop'],
  ['Adele', 'Rolling in the Deep', 105, 'pop'],
  ['Miley Cyrus', 'Flowers', 118, 'pop'],
  ['Miley Cyrus', 'Party in the U.S.A.', 96, 'pop'],
  ['Harry Styles', 'As It Was', 174, 'pop'],
  ['Harry Styles', 'Watermelon Sugar', 95, 'pop'],
  ['Doja Cat', 'Say So', 111, 'pop'],
  ['The Chainsmokers', 'Closer', 95, 'pop'],
  ['Major Lazer', 'Lean On', 98, 'dance'],
  ['Sia', 'Cheap Thrills', 90, 'pop'],
  ['Tones and I', 'Dance Monkey', 98, 'pop'],
  ['Post Malone', 'Circles', 120, 'pop'],
  ['Lizzo', 'Juice', 120, 'pop'],
  ['Lizzo', 'About Damn Time', 109, 'pop'],
  ['Bruno Mars', '24K Magic', 107, 'pop'],
  ['Bruno Mars', 'Locked Out of Heaven', 144, 'pop'],
  ['Gotye', 'Somebody That I Used to Know', 129, 'pop'],
  ['Kesha', 'TiK ToK', 120, 'pop'],
  ['Taio Cruz', 'Dynamite', 120, 'pop'],
  ['Flo Rida', 'Low', 128, 'rap'],
  ['Pitbull', 'Give Me Everything', 129, 'pop'],
  ['Usher', 'Yeah!', 105, 'rnb'],
  ["Usher", "DJ Got Us Fallin' in Love", 120, 'pop'],
  ['Beyoncé', 'Crazy in Love', 99, 'rnb'],
  ['Whitney Houston', 'I Wanna Dance with Somebody', 119, 'pop'],
  ['Michael Jackson', 'Billie Jean', 117, 'pop'],
  ['Michael Jackson', 'Beat It', 139, 'pop'],
  ['Michael Jackson', 'Thriller', 118, 'pop'],
  ['Michael Jackson', "Don't Stop 'Til You Get Enough", 119, 'pop'],
  ['Prince', 'Kiss', 112, 'pop'],
  ['ABBA', 'Dancing Queen', 101, 'pop'],
  ['ABBA', 'Gimme! Gimme! Gimme! (A Man After Midnight)', 120, 'pop'],
  ['Bee Gees', "Stayin' Alive", 104, 'pop'],
  ['Earth, Wind & Fire', 'September', 126, 'pop'],
  ['Earth, Wind & Fire', "Let's Groove", 126, 'pop'],
  ['Gloria Gaynor', 'I Will Survive', 117, 'pop'],
  ['Donna Summer', 'Hot Stuff', 120, 'pop'],
  ['a-ha', 'Take on Me', 169, 'pop'],
  ['Rick Astley', 'Never Gonna Give You Up', 113, 'pop'],
  ['Eurythmics', 'Sweet Dreams (Are Made of This)', 125, 'pop'],
  ['Depeche Mode', "Just Can't Get Enough", 128, 'pop'],
  ['Depeche Mode', 'Enjoy the Silence', 113, 'pop'],
  ['New Order', 'Blue Monday', 130, 'electro'],
  ['Cyndi Lauper', 'Girls Just Want to Have Fun', 120, 'pop'],
  // rock
  ['Queen', 'Another One Bites the Dust', 110, 'rock'],
  ['Queen', "Don't Stop Me Now", 156, 'rock'],
  ['Journey', "Don't Stop Believin'", 119, 'rock'],
  ['Toto', 'Africa', 93, 'rock'],
  ['Survivor', 'Eye of the Tiger', 109, 'rock'],
  ['Bon Jovi', "Livin' on a Prayer", 123, 'rock'],
  ["Guns N' Roses", "Sweet Child O' Mine", 125, 'rock'],
  ['AC/DC', 'Back in Black', 94, 'rock'],
  ['AC/DC', 'Highway to Hell', 116, 'rock'],
  ['AC/DC', 'Thunderstruck', 134, 'rock'],
  ['Nirvana', 'Smells Like Teen Spirit', 117, 'rock'],
  ['The White Stripes', 'Seven Nation Army', 124, 'rock'],
  ['The Killers', 'Mr. Brightside', 148, 'rock'],
  ['Coldplay', 'Viva la Vida', 138, 'rock'],
  ['Coldplay', 'Adventure of a Lifetime', 112, 'rock'],
  ['Imagine Dragons', 'Believer', 125, 'rock'],
  ['Imagine Dragons', 'Radioactive', 136, 'rock'],
  ['Blur', 'Song 2', 130, 'rock'],
  ['Red Hot Chili Peppers', "Can't Stop", 91, 'rock'],
  ['Red Hot Chili Peppers', 'Californication', 96, 'rock'],
  ['Arctic Monkeys', 'Do I Wanna Know?', 85, 'rock'],
  ['Gorillaz', 'Feel Good Inc.', 139, 'rock'],
  ['MGMT', 'Kids', 123, 'rock'],
  ['Foster the People', 'Pumped Up Kicks', 128, 'rock'],
  ['Empire of the Sun', 'Walking on a Dream', 127, 'rock'],
  ['The Strokes', 'Last Nite', 104, 'rock'],
  ['Oasis', 'Wonderwall', 87, 'rock'],
  ['Linkin Park', 'In the End', 105, 'rock'],
  ['Linkin Park', 'Numb', 110, 'rock'],
  ['Metallica', 'Enter Sandman', 123, 'rock'],
  ['Fleetwood Mac', 'Dreams', 120, 'rock'],
  ['Stevie Wonder', 'Superstition', 100, 'rnb'],
  ['Kings of Leon', 'Sex on Fire', 153, 'rock'],
  ['The Police', 'Every Breath You Take', 117, 'rock'],
  ['U2', 'With or Without You', 110, 'rock'],
  ['Dire Straits', 'Sultans of Swing', 148, 'rock'],
  // hip-hop / r&b
  ['Eminem', 'Lose Yourself', 171, 'rap'],
  ['Eminem', 'The Real Slim Shady', 105, 'rap'],
  ['Eminem', 'Without Me', 112, 'rap'],
  ['Dr. Dre', 'Still D.R.E.', 93, 'rap'],
  ['Dr. Dre', 'The Next Episode', 95, 'rap'],
  ['50 Cent', 'In da Club', 90, 'rap'],
  ['Kanye West', 'Stronger', 104, 'rap'],
  ['Kanye West', 'Gold Digger', 93, 'rap'],
  ['OutKast', 'Hey Ya!', 159, 'rap'],
  ['OutKast', 'Ms. Jackson', 95, 'rap'],
  ['JAY-Z', 'Empire State of Mind', 173, 'rap'],
  ['Kendrick Lamar', 'HUMBLE.', 150, 'rap'],
  ['Drake', 'One Dance', 104, 'rap'],
  ['Drake', 'Hotline Bling', 135, 'rap'],
  ['Drake', "God's Plan", 77, 'rap'],
  ['Lil Nas X', 'Old Town Road', 136, 'rap'],
  ['Missy Elliott', 'Get Ur Freak On', 89, 'rap'],
  ['Snoop Dogg', "Drop It Like It's Hot", 92, 'rap'],
  ['The Notorious B.I.G.', 'Juicy', 96, 'rap'],
  ['Coolio', "Gangsta's Paradise", 80, 'rap'],
  ['TLC', 'No Scrubs', 93, 'rnb'],
  ['Mary J. Blige', 'Family Affair', 93, 'rnb'],
  ['Macklemore & Ryan Lewis', 'Thrift Shop', 95, 'rap'],
  ['Macklemore & Ryan Lewis', "Can't Hold Us", 146, 'rap'],
  ['Cardi B', 'I Like It', 136, 'rap'],
  ['Travis Scott', 'goosebumps', 130, 'rap'],
  ['Roddy Ricch', 'The Box', 117, 'rap'],
  ['Juice WRLD', 'Lucid Dreams', 84, 'rap'],
  ['SZA', 'Kill Bill', 89, 'rnb'],
  ['Rihanna', 'Work', 92, 'rnb'],
  ['Alicia Keys', 'No One', 90, 'rnb'],
  ['Nelly', 'Hot in Herre', 107, 'rap'],
  ['Sean Paul', 'Get Busy', 100, 'rap'],
  ['The Black Eyed Peas', 'Pump It', 154, 'rap'],
  ['House of Pain', 'Jump Around', 107, 'rap'],
  ['Montell Jordan', 'This Is How We Do It', 104, 'rnb'],
  ['Mark Morrison', 'Return of the Mack', 95, 'rnb'],
  // latin
  ['Luis Fonsi', 'Despacito', 89, 'latin'],
  ['Shakira', "Hips Don't Lie", 100, 'latin'],
  ['Shakira', 'Waka Waka (This Time for Africa)', 127, 'latin'],
  ['Daddy Yankee', 'Gasolina', 96, 'latin'],
  ['Don Omar', 'Danza Kuduro', 130, 'latin'],
  ['J Balvin', 'Mi Gente', 105, 'latin'],
  ['Enrique Iglesias', 'Bailando', 91, 'latin'],
  ['Bad Bunny', 'DÁKITI', 110, 'latin'],
  ['Bad Bunny', 'Me Porto Bonito', 92, 'latin'],
  ['Nicky Jam', 'El Perdón', 90, 'latin'],
  ['Ricky Martin', "Livin' la Vida Loca", 178, 'latin'],
  ['Los Del Rio', 'Macarena', 103, 'latin'],
  ['Pitbull', 'Fireball', 123, 'latin'],
  ['Marc Anthony', 'Vivir Mi Vida', 105, 'latin'],
  ['ROSALÍA', 'DESPECHÁ', 130, 'latin'],
  ['Maluma', 'Felices los 4', 94, 'latin'],
  ['Camila Cabello', 'Havana', 105, 'latin'],
  ['Santana', 'Smooth', 116, 'latin'],
];

// Music without a steady beat (solo piano, strings, ambient): bpmConfidence should come out LOW for these.
const RUBATO = [
  ['Erik Satie', 'Gymnopédie No. 1'],
  ['Claude Debussy', 'Clair de lune'],
  ['Brian Eno', 'An Ending (Ascent)'],
  ['Ludovico Einaudi', 'Nuvole Bianche'],
  ['Samuel Barber', 'Adagio for Strings'],
  ['Arvo Pärt', 'Spiegel im Spiegel'],
  ['Max Richter', 'On the Nature of Daylight'],
  ['Frédéric Chopin', 'Nocturne'],
  ['Yiruma', 'River Flows in You'],
  ['Hans Zimmer', 'Time'],
  ['Aphex Twin', 'Avril 14th'],
  ['Sigur Rós', 'Hoppípolla'],
  ['Brian Eno', '1/1'],
  ['Stars of the Lid', 'Requiem for Dying Mothers'],
  ['Ólafur Arnalds', 'Saman'],
  ['Nils Frahm', 'Says'],
];

// ---------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : def;
};
const PER_GENRE = opt('--per-genre', 25);
const KEEP_MP3 = opt('--keep-mp3', 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deezer allows 50 requests / 5 s per IP; stay well under it.
let lastApi = 0;
async function api(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastApi + 130 - Date.now();
    if (wait > 0) await sleep(wait);
    lastApi = Date.now();
    try {
      const res = await fetch(API + path, { signal: AbortSignal.timeout(15000) });
      const json = await res.json();
      if (json && json.error) {
        if (json.error.code === 4) {
          await sleep(1500 * (attempt + 1)); // quota
          continue;
        }
        return null;
      }
      return json;
    } catch {
      await sleep(600 * (attempt + 1));
    }
  }
  return null;
}

const norm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Versions that are not the famous studio recording (different tempo, no drums, re-recordings …).
// Checked against the track title AND the album title ("Poker Face" on "Poker Face (Remixes Part 1)").
const BAD_VERSION =
  /\b(live|remix(es|ed)?|karaoke|acoustic|instrumental|tribute|cover|mix(es)?|medley|demo|sessions?|sped up|slowed|nightcore|dub|a ?cappella|piano|pianoforte|reloaded|vs|surrender|rough trade|stripped|orchestral|rework|bootleg|club|extended|vip|thin white duke|aude|reprise|unplugged|symphonic|re ?recorded|made famous|rehearsal|box set|tnt|version \d+)\b/i;

const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const isBadVersion = (found, wanted) => BAD_VERSION.test(plain(found)) && !BAD_VERSION.test(plain(wanted));
const normKeep = (s) => plain(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

async function findHand([artist, title]) {
  // Plain free-text queries: the advanced `artist:"…" track:"…"` syntax returned empty result sets when
  // this was written (2026-10-05), so filter client-side instead. Prefer the un-suffixed title, then the
  // most popular version (Deezer `rank`) — that is almost always the original hit.
  const bare = title.replace(/\(.*?\)/g, '').trim();
  const wantA = norm(artist);
  const wantT = norm(title);
  let best = null;
  let bestScore = -1;
  for (const query of [`${artist} ${bare}`, `${plain(artist)} ${plain(bare)}`.replace(/[^\w\s]/g, ' '), bare]) {
    const res = await api(`/search?q=${encodeURIComponent(query)}&limit=25`);
    for (const t of (res && res.data) || []) {
      if (!t.preview) continue;
      const a = norm(t.artist && t.artist.name);
      const ti = norm(t.title);
      // the found artist must be the wanted one (or one of its members: "Macklemore" for
      // "Macklemore & Ryan Lewis") — "Santana Tribù" or "Daft Punk Experience" are cover bands
      if (!a || !(a === wantA || ` ${wantA} `.includes(` ${a} `))) continue;
      if (!ti.startsWith(wantT)) continue;
      if (isBadVersion(t.title, title) || isBadVersion(t.album && t.album.title, title)) continue;
      const exact = normKeep(t.title) === normKeep(title) || normKeep(t.title) === normKeep(bare);
      const score = (exact ? 1e7 : 0) + (t.rank || 0);
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return null;
}

function run(cmd, argv) {
  return new Promise((ok, fail) => {
    execFile(cmd, argv, { timeout: 60000 }, (err, stdout, stderr) => (err ? fail(new Error(stderr || err.message)) : ok(stdout)));
  });
}

const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50000) throw new Error(`suspiciously small preview (${buf.length} bytes)`);
  await writeFile(file, buf);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    }),
  );
}

async function main() {
  await mkdir(OUT, { recursive: true });
  try {
    await run(FFMPEG, ['-version']);
  } catch {
    console.error('ffmpeg not found (set FFMPEG_PATH). Nothing downloaded.');
    process.exit(1);
  }
  /** @type {Record<string, any>} */
  const byId = {};
  try {
    for (const e of JSON.parse(await readFile(MANIFEST, 'utf8')).tracks) byId[e.id] = e;
  } catch {
    /* first run */
  }

  /** @type {{track:any, genre:string, source:string, handBpm?:number}[]} */
  const wanted = [];
  if (!flag('--no-hand')) {
    for (const h of HAND) {
      const handKey = `${h[0]} — ${h[1]}`;
      const known = Object.values(byId).find((e) => e.handKey === handKey);
      if (known && known.album !== undefined && !flag('--recheck')) {
        known.handBpm = h[2];
        continue;
      }
      const t = await findHand(h);
      if (known && (!t || String(t.id) !== known.id)) {
        // an earlier run matched a remix / re-recording (or nothing better exists): forget it
        if (known.source === 'hand') {
          delete byId[known.id];
          await unlink(join(OUT, known.wav)).catch(() => {});
        } else {
          known.handBpm = 0;
          known.handKey = '';
        }
      }
      if (!t) {
        console.warn(`  no match: ${h[0]} — ${h[1]}`);
        continue;
      }
      if (known && String(t.id) === known.id) {
        known.handBpm = h[2];
        known.album = (t.album && t.album.title) || '';
        continue;
      }
      wanted.push({ track: t, genre: h[3], source: 'hand', handBpm: h[2], handKey: `${h[0]} — ${h[1]}` });
    }
  }
  if (!flag('--no-rubato')) {
    for (const [artist, title] of RUBATO) {
      const handKey = `rubato: ${artist} — ${title}`;
      if (Object.values(byId).some((e) => e.handKey === handKey)) continue;
      // free-text search; composers are rarely the "artist", so only the title is checked
      const res = await api(`/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=10`);
      const t = ((res && res.data) || []).find((r) => r.preview && norm(r.title).includes(norm(title).split(' ')[0]));
      if (!t) {
        console.warn(`  no match: ${handKey}`);
        continue;
      }
      wanted.push({ track: t, genre: 'rubato', source: 'rubato', handKey });
    }
  }
  if (!flag('--no-charts')) {
    for (const [genre, gid] of GENRES) {
      const res = await api(`/chart/${gid}/tracks?limit=${Math.min(100, PER_GENRE)}`);
      for (const t of (res && res.data) || []) {
        if (t.preview) wanted.push({ track: t, genre, source: 'chart' });
      }
    }
  }

  const seen = new Set();
  const todo = [];
  for (const w of wanted) {
    const id = String(w.track.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (byId[id] && (await exists(join(OUT, `${id}.wav`)))) {
      if (w.handBpm) Object.assign(byId[id], { handBpm: w.handBpm, handKey: w.handKey });
      if (byId[id].album === undefined) byId[id].album = (w.track.album && w.track.album.title) || '';
      continue;
    }
    todo.push(w);
  }
  console.log(`${Object.keys(byId).length} tracks already present, ${todo.length} to fetch → ${OUT}`);

  let done = 0;
  let failed = 0;
  let kept = (await Promise.all(Object.keys(byId).map((id) => exists(join(OUT, `${id}.mp3`))))).filter(Boolean).length;
  await pool(todo, 4, async (w) => {
    const id = String(w.track.id);
    const mp3 = join(OUT, `${id}.mp3`);
    const wav = join(OUT, `${id}.wav`);
    try {
      // /track/<id> gives the bpm field and a freshly signed preview URL.
      const full = await api(`/track/${id}`);
      const url = (full && full.preview) || w.track.preview;
      await download(url, mp3);
      await run(FFMPEG, ['-v', 'error', '-y', '-i', mp3, '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', wav]);
      const keepMp3 = kept < KEEP_MP3;
      if (keepMp3) kept++;
      else await unlink(mp3).catch(() => {});
      byId[id] = {
        id,
        title: w.track.title,
        artist: w.track.artist && w.track.artist.name,
        album: (w.track.album && w.track.album.title) || '',
        genre: w.genre,
        source: w.source,
        deezerBpm: full && full.bpm > 0 ? full.bpm : 0,
        handBpm: w.handBpm || 0,
        handKey: w.handKey || '',
        wav: `${id}.wav`,
        mp3: keepMp3 ? `${id}.mp3` : '',
      };
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${todo.length}`);
    } catch (err) {
      failed++;
      console.warn(`  failed ${id} ${w.track.title}: ${err.message}`);
      await unlink(mp3).catch(() => {});
    }
  });

  const tracks = Object.values(byId).sort((a, b) => (a.id < b.id ? -1 : 1));
  await writeFile(MANIFEST, JSON.stringify({ fetchedAt: new Date().toISOString(), tracks }, null, 1));
  const withHand = tracks.filter((t) => t.handBpm > 0).length;
  const withDz = tracks.filter((t) => t.deezerBpm > 0).length;
  console.log(`done: +${done} (${failed} failed). manifest: ${tracks.length} tracks, ${withHand} with hand bpm, ${withDz} with deezer bpm`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

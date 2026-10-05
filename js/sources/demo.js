// One-click starting points.
//
// DEMOS are Deezer genre charts: refreshed by Deezer every day, loaded straight from Deezer (no
// relay involved) and every track already carries its preview — the most reliable way into a set.
// EXAMPLES are well-known public Spotify playlists (each id checked by tests/e2e/sources.e2e.mjs).

/** @type {{id: string, label: string, emoji: string, input: string}[]} */
export const DEMOS = [
  { id: 'hits', label: 'Global hits', emoji: '🔥', input: 'deezer:chart:0' },
  { id: 'dance', label: 'Dance', emoji: '🪩', input: 'deezer:chart:113' },
  { id: 'electro', label: 'Electro', emoji: '🎛️', input: 'deezer:chart:106' },
  { id: 'hiphop', label: 'Hip-hop', emoji: '🎤', input: 'deezer:chart:116' },
  { id: 'pop', label: 'Pop', emoji: '✨', input: 'deezer:chart:132' },
  { id: 'latin', label: 'Latin', emoji: '🌴', input: 'deezer:chart:197' },
  { id: 'rnb', label: 'R&B', emoji: '💜', input: 'deezer:chart:165' },
  { id: 'rock', label: 'Rock', emoji: '🎸', input: 'deezer:chart:152' },
];

/** @type {{label: string, url: string}[]} */
export const EXAMPLES = [
  { label: "Today's Top Hits", url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
  { label: 'mint (dance)', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4dyzvuaRJ0n' },
  { label: 'RapCaviar', url: 'https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd' },
  { label: 'All Out 2000s', url: 'https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd' },
  { label: 'Viva Latino', url: 'https://open.spotify.com/playlist/37i9dQZF1DX10zKzsJ2jva' },
  { label: 'Rock Classics', url: 'https://open.spotify.com/playlist/37i9dQZF1DWXRqgorJj26U' },
];

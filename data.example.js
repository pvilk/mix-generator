// DJ Claude — stations + scene config.
//
// Each station drives both audio (Spotify playlist) and visual (a scene/room).
//
// FIRST-RUN: server.js auto-copies this file to `data.js` if `data.js` doesn't
// exist. Each user has their own `data.js`. To reset to defaults, delete
// `data.js` and restart the server.
//
// Schema:
//   id           string   stable slug (kebab-case)
//   title        string   display name on the dial
//   subtitle     string   short vibe line + seed artists
//   scene        string   'highway' | 'bar' | 'sunset'
//   coverColors  string[] 1-2 hex codes — used as accent / fallback art
//   spotifyUri   string   spotify:playlist:...  (leave empty for first-run setup)
//   spotifyUrl   string   https://open.spotify.com/playlist/...
//   refresh      string   'manual' | 'daily'  (informational only for now)
//
// HOW EMPTY URIs WORK:
//   The defaults below ship without playlist URIs because Spotify playlists
//   are private to whoever created them — a default URI wouldn't be playable
//   for new users. On first run, the page shows "Set up this station" on
//   each card. Press ⌘K and ask the DJ ("make a station for…"), or replace
//   the entries below by hand with your own playlist URIs.

window.MIX_DATA = {
  active: 'late-night-drive',
  playlists: [
    {
      id: 'late-night-drive',
      title: 'Late Night Drive',
      subtitle: 'Synthwave · Dream pop · 2am highway',
      scene: 'highway',
      coverColors: ['#7c2dd1', '#d6336c'],
      spotifyUri: '',
      spotifyUrl: '',
      refresh: 'manual',
    },
    {
      id: 'bar-at-eleven',
      title: 'Bar at Eleven',
      subtitle: 'Hi-fi listening bar · Soul · Khruangbin · Mac DeMarco',
      scene: 'bar',
      coverColors: ['#e8a652'],
      spotifyUri: '',
      spotifyUrl: '',
      refresh: 'manual',
    },
    {
      id: 'sunset-cabin',
      title: 'Sunset Cabin',
      subtitle: 'Lane 8 · Ben Böhmer · Eli & Fur · Anjunadeep',
      scene: 'sunset',
      coverColors: ['#ff6b80', '#ffa55a'],
      spotifyUri: '',
      spotifyUrl: '',
      refresh: 'manual',
    },
  ],
};

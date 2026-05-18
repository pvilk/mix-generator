# Taste profile — what gets collected and how it's used

Mix Generator tracks two signals locally as you listen: **listen-throughs** (tracks you let play to the end) and **skips** (tracks you cut early). These signals power three things:

1. **Auto-saving** — listened-through tracks get added to your *Liked Radio Songs* playlist AND to the active station's own playlist
2. **Auto-pruning** — skipped tracks get removed from the active station's playlist
3. **DJ priors** — every ⌘K request includes the last 30 of each as context, so Claude can bias picks

## Where it's stored

Three `localStorage` keys, all under your browser's origin (`http://127.0.0.1:8765`):

```js
mixgen.liked.v1           // listen-through history (array of {ts, uri, name, artist, ...})
mixgen.skipped.v1         // skip history (same shape)
mixgen.knownArtists.v1    // Set of artist IDs you've listened through (for discovery bias)
```

None of this leaves your browser unless you trigger a Cmd+K request (which sends a *snapshot* of last 30 of each to your local Node server, which forwards to `claude -p`).

## Schema — what each entry looks like

### `mixgen.liked.v1` / `mixgen.skipped.v1`

```js
[
  {
    ts: 1715900000000,             // unix ms of when this was recorded
    uri: 'spotify:track:abc123',   // canonical Spotify track URI
    name: 'Plymouth',              // track title
    artist: 'Spider Bags',         // joined artist names
    durationMs: 215000,            // track length
    stationId: 'bar-at-eleven',    // which station was active
    stationTitle: 'Bar at Eleven', // ditto, display name
  },
  // ...
]
```

### `mixgen.knownArtists.v1`

```js
// Just an array of Spotify artist IDs (deduped via Set):
['1tqysapcCh1lWEAc9dIFpa', '4dwfMmGspl4o0V8sntSMtT', ...]
```

## How "listen-through" vs "skip" is detected

The SDK emits `player_state_changed` events whenever playback state changes. We watch for **track URI changes** — when the URI changes from one event to the next, the previous track ended.

The previous track's last-seen `progress / duration` ratio decides which bucket it goes in:

```js
const ratio = lastSeenTrack.progressMs / lastSeenTrack.durationMs;
if (ratio >= 0.85) onTrackListenedThrough(lastSeenTrack);
else onTrackSkipped(lastSeenTrack);
```

- **≥ 0.85** = listened through. The last 15% is often outro/fadeout, so this is forgiving.
- **< 0.85** = skipped. User cut it short.

Edge case: if the SDK polls don't catch the last few seconds before transition, the ratio might be under 0.85 even though the track played to natural end. The current threshold accepts a small false-skip rate for the simpler logic.

## What the DJ sees

When you hit ⌘K, the browser packages the last 30 of each into a `profile` object and sends it with the request:

```js
POST /dj
{
  "prompt": "Add 5 darker shoegaze tracks to Late Night Drive",
  "profile": {
    "liked": [
      { "name": "Space Song", "artist": "Beach House", "station": "Late Night Drive" },
      { "name": "Plymouth", "artist": "Spider Bags", "station": "Bar at Eleven" },
      // ... up to 30
    ],
    "skipped": [
      { "name": "Some Track", "artist": "Some Artist", "station": "Sunset Cabin" },
      // ... up to 30
    ]
  }
}
```

The server expands this into the `claude -p` system prompt as:

```
USER'S TASTE PROFILE (use this to bias your picks):

LOVED tracks (they listened all the way through):
  - "Space Song" by Beach House [from Late Night Drive]
  - "Plymouth" by Spider Bags [from Bar at Eleven]
  - ...

SKIPPED tracks (they didn't like — avoid territory near these):
  - "Some Track" by Some Artist [from Sunset Cabin]
  - ...

When picking tracks, lean toward artists/sounds similar to LOVED. Avoid artists in SKIPPED.
```

Claude reads this and uses it to bias Spotify searches and final selections.

## How replenishment uses it

Separately, after every listen-through, the page runs a background replenishment routine. It uses `mixgen.knownArtists.v1` to score discovery candidates:

```js
// Inside replenishStationFromTrack (script.js)
const isNew = aid && !knownArtists.has(aid);
const score = (isNew ? 10 : 0) + (popularity / 20) + (isSeedArtist ? 0 : 1.5);
```

- **+10 if the artist is NEW** (you haven't listened through their tracks before) — heavy discovery bias
- **+popularity/20** — light popularity tilt
- **+1.5 if the candidate is a *different* artist** than the seed — variety

The seed artist (whichever artist's track just finished) gets added to the known-artists set after replenishment, so they're not "new" anymore on the next round.

## Inspect / export / reset

```js
// See what's stored
JSON.parse(localStorage.getItem('mixgen.liked.v1'))
JSON.parse(localStorage.getItem('mixgen.skipped.v1'))
JSON.parse(localStorage.getItem('mixgen.knownArtists.v1'))

// Wipe a category
localStorage.removeItem('mixgen.liked.v1')
localStorage.removeItem('mixgen.skipped.v1')
localStorage.removeItem('mixgen.knownArtists.v1')

// Wipe everything (also clears auth)
localStorage.clear()
```

The hot-corner overlay (`⌖`) shows a session summary: `+N added · −N removed` and the running list. "Clear session" there only clears the local mirror — does NOT undo Spotify-side changes (added tracks stay in playlists, removed tracks stay removed).

## Privacy

- All taste data lives in **your browser**. The server (when running) has no persistent storage.
- The DJ subprocess sees a 30-track snapshot per request — `claude -p` execution is local, no remote inference.
- The Spotify Web API obviously receives your token + track operations. That's the only outbound surface.

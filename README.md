# Mix Generator

An agent-driven personal radio for Spotify. Three ambient rooms, a custom player, and a Claude-powered DJ behind ⌘K.

```
⌘K → "Add 5 darker shoegaze tracks to Late Night Drive"
   → Claude searches Spotify, picks 5 tracks, the browser adds them to
     your existing playlist. No orphans. No "create another playlist."
```

It's a single-page web app that runs locally. Audio plays in your browser via the Spotify Web Playback SDK. There's no build step, no `npm install`, no environment files. Everything fits in seven source files.

---

## What you get

**Three stations on the dial, with full ambient scenes** — Late Night Drive (highway streaks at night), Bar at Eleven (warm walnut listening bar with smoking incense), Sunset Cabin (Anjunadeep-style golden-hour gradient). Add your own from there.

**A custom Spotify player** — album art, live track + artist, progress bar, ⏮ ⏯ ⏭ ♥. Driven by the Web Playback SDK, so it registers as its own Spotify Connect device. Doesn't fight your desktop app for control.

**⌘K DJ Request** — type "new station for early morning coding" or "remove the synth-heavy tracks from Sunset Cabin." A local `claude -p` subprocess picks up the request, uses the Spotify MCP to do the work, and returns. The browser applies playlist mutations directly via OAuth Web API.

**A taste-learning algorithm** — when you listen a track all the way through, it gets saved to your *Liked Radio Songs* playlist *and* added to that station. When you skip a track, it gets removed from the station. The station evolves around your actual taste.

**Discovery replenishment** — on every listen-through, a background routine fetches your seed artist's genres, searches Spotify for similar territory, biases toward artists you haven't heard yet, and quietly adds one new track to the station.

**Bridge tracks between stations** — when you switch from Bar at Eleven to Sunset Cabin, the page plays one of your recent likes as a transition song first. Optional, toggle in settings.

**Album-art tinted scenes** — the dominant color of the current album art bleeds into the scene as a soft overlay. Crossfades when tracks change. Optional.

**Hardware media keys** — F7/F8/F9 (the ⏮/⏯/⏭ keys on a Mac keyboard) and lock screen / Touch Bar controls all route here when this tab is the active media source.

**Now-Playing OS integration** — track title, artist, and album art show up in macOS Control Center.

---

## Quick start

You need:
- **Node 18+** (`node --version`)
- **Spotify Premium** (Web Playback SDK requirement)
- **A Spotify Developer App** (free, one-time setup — ~2 min)
- **Claude Code CLI** with the Spotify MCP configured — only needed for the ⌘K DJ feature, the radio works without it

```bash
git clone https://github.com/<your-org>/mix-generator.git
cd mix-generator
node server.js
```

Open **<http://127.0.0.1:8765>** — *not* `localhost`. Spotify rejects `localhost` as an OAuth redirect URI; only the literal `127.0.0.1` works.

### Spotify Developer App (one-time)

1. Go to <https://developer.spotify.com/dashboard> → click **Create app**
2. Any name + description. Pick **Web API** + **Web Playback SDK** in the "Which API/SDKs are you planning to use" section
3. Add redirect URI: `http://127.0.0.1:8765/`
4. Save the app. Copy the **Client ID** from the app settings page
5. In the radio page, click the **⌖** in the bottom-right → paste your Client ID → click **Authorize**

That's it. After authorize, your Spotify shows a device called *Mix Generator · Radio*. Music plays in the browser. The page can read what's playing, save to Liked Songs, add/remove tracks from your playlists, and skip / pause / play.

### First-run experience

The three default stations ship with empty `spotifyUri` fields because Spotify playlists are private to their creator — a hardcoded URI wouldn't be playable for you. So:

- Each station card initially shows **"Set up [station] — Press ⌘K and ask the DJ to fill it in"**
- Press **⌘K**, type something like **"Set up Late Night Drive — synthwave + atmospheric indie + dreamy 2am driving music"** → Enter
- 30–60 seconds later, the DJ creates a Spotify playlist in your library and points the station at it
- Repeat for the other two stations

Or just edit `data.js` directly with playlist URIs you already have:
```js
spotifyUri: 'spotify:playlist:0LRgiYqdRA8n3OK8kWk7cQ',
spotifyUrl: 'https://open.spotify.com/playlist/0LRgiYqdRA8n3OK8kWk7cQ',
```

---

## Daily use

### Keyboard

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | DJ Request modal |
| `Space` | Play / pause |
| `→` | Next track |
| `←` | Previous track |
| `S` | Next station |
| `A` | Previous station |
| `Esc` | Close any overlay |
| `F7` / `F8` / `F9` | Hardware media keys (prev / pause / next) |

### DJ examples

Anything in natural language, but here are the patterns Claude knows. **See [`examples/dj-commands.md`](./examples/dj-commands.md) for the full cookbook.**

**Create a new station**
- *"New station for 90s grunge"*
- *"Make me a station for cooking dinner"*
- *"Build a station like Khruangbin but jazzier"*

**Refresh a station's vibe entirely (replaces playlist)**
- *"Make Late Night Drive darker, more dream-pop"*
- *"Refresh Sunset Cabin with newer Lane 8 tracks"*

**Add specific tracks to an existing station (preserves the playlist)**
- *"Add 5 darker shoegaze tracks to Late Night Drive"*
- *"Throw 3 vocal-led tracks into Sunset Cabin"*
- *"Bar at Eleven needs more soul"*

**Remove tracks**
- *"Drop the synthwave from Late Night Drive"*
- *"Remove the poppier tracks from Bar at Eleven"*

### Taste profile

The DJ sees your last 30 listened-through tracks + last 30 skipped tracks with every request. It uses that as bias signal:
- Lean toward artists and sounds near LOVED
- Avoid territory near SKIPPED

Over time, you don't have to spell out your taste — Claude already knows.

### Settings (⚙ in bottom-right)

- **Bridge tracks between stations** — play one familiar liked song as a transition when switching stations
- **BPM-locked replenishment** — auto-added tracks stay within ±5 BPM of recent listens (depends on Spotify's audio-features endpoint, which is rate-limited for new apps)
- **Album-art tinted room** — soft color overlay matching the current cover

More detail in [`examples/settings.md`](./examples/settings.md).

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (the radio)                                         │
│                                                             │
│   ┌─────────────────────┐    ┌────────────────────────┐    │
│   │  Web Playback SDK   │    │   Web API (OAuth PKCE) │    │
│   │  registers as a     │    │   - currently-playing  │    │
│   │  Spotify Connect    │    │   - add/remove tracks  │    │
│   │  device + plays     │    │   - save to library    │    │
│   │  audio in-browser   │    │   - search             │    │
│   └─────────────────────┘    └────────────────────────┘    │
│                                                             │
└────────────────┬────────────────────────────────────────────┘
                 │ ⌘K request
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Local Node server (server.js)                               │
│   POST /dj { prompt, taste-profile }                        │
│        │                                                    │
│        ▼                                                    │
│   spawn claude -p with structured prompt                    │
│        │                                                    │
└────────┼────────────────────────────────────────────────────┘
         ▼
┌─────────────────────────────────────────────────────────────┐
│ claude -p subprocess                                        │
│   - reads request + current stations + taste profile        │
│   - calls Spotify MCP: search, create_playlist              │
│   - returns one JSON object:                                │
│       { action: "create_station" | "add_tracks" |           │
│                 "remove_tracks" | "error", ... }            │
└─────────────────────────────────────────────────────────────┘
```

**Two key splits make this work:**

1. **Server-side intelligence, browser-side mutation.** `claude -p` decides what tracks to add or remove. The browser does the actual `POST /v1/playlists/{id}/tracks` via OAuth tokens that never leave the page.
2. **Audio + Web API in the browser, no iframe.** The SDK runs in this tab. macOS, Spotify Connect, and any phone in the room all see it as a real device.

---

## File tour

| File | Purpose |
|---|---|
| `index.html` | Markup. Scene divs, card, DJ modal, hot corner, gear |
| `styles.css` | All visual design |
| `script.js` | App logic (audio, scene activation, DJ, listen-through, bridge, tint) |
| `auth.js` | Spotify OAuth PKCE + Web API helpers — exposes `window.SpotifyAuth` |
| `server.js` | Node static server + `/dj` endpoint that spawns `claude -p` |
| `data.example.js` | Default station list shipped in the repo |
| `data.js` | Your per-user station list (gitignored; auto-created from example on first run) |
| `favicon.png` | Vinyl record icon |
| `examples/` | Cookbook + schema docs ([overview](./examples/README.md)) |

---

## Customization

### Change the default stations

Edit `data.example.js` if you want a fresh-clone experience. Edit `data.js` for your local state. Full schema + 10 sample station configs in [`examples/stations.md`](./examples/stations.md).

### Change a station's scene

In `data.js`, set `scene` to `'highway'`, `'bar'`, or `'sunset'`. Each station gets its assigned scene visually.

### Add a new scene

Walkthrough in [`examples/scenes.md`](./examples/scenes.md).

### Replace the favicon

Drop your image in as `favicon.png`. The `<link rel="icon">` in `index.html` picks it up.

---

## Why this exists

- I wanted a radio that *adapts to my taste in real time* instead of through Spotify's opaque recommendation system
- I wanted to talk to it in natural language: *"add some shoegaze to Late Night Drive"* — not click through 14 menus
- I wanted the audio to play in my browser tab as its own device, not piggyback on the desktop app

That all has to be locally controlled. So it's local.

---

## Roadmap

Ideas that are *next*:
- **Bridge tracks via DJ** instead of just liked-track shuffles — DJ picks a transition track that fits the seed *and* the target station
- **Time-of-day autotune** — morning → coffee bar, late → highway, etc.
- **Daily new-music agent** — cron-fired generation of a "today's pick" station
- **AI-generated scenes** — describe a vibe, get a custom CSS animation matching it
- **Voice DJ requests** — say "add more soul" instead of typing
- **Concert finder** — agent watches your top artists, surfaces local shows

PRs welcome. See `CONTRIBUTING.md`.

---

## Requirements + limitations

- **Spotify Premium** required for Web Playback SDK. Free accounts cannot use it.
- **Chrome / Edge / Brave** recommended. Safari has worked but is the strictest about media keys.
- **macOS** is the only platform tested end-to-end. Linux + Windows should work but haven't been verified.
- **Spotify Web API deprecations** (Nov 2024) affect features that rely on `/recommendations`, `/related-artists`, and `/audio-features`. We use search-based fallbacks and gracefully no-op when these endpoints 403.
- **`localhost` doesn't work for OAuth.** Use `127.0.0.1`. This is a Spotify policy change from late 2024 — not a code issue.

---

## License

MIT — see [LICENSE](./LICENSE). Use it however you want, just don't sue if Spotify changes their API.

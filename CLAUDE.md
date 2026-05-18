# DJ Claude — Agent Guide

This file primes AI assistants working on DJ Claude. Read before making changes.

## What this is

A single-page personal radio: a `<body>` with three ambient scenes, a custom Spotify Web Playback player, and a ⌘K DJ that calls `claude -p` to manipulate playlists.

## Hard constraints

- **No build step.** Vanilla HTML/CSS/JS. If you want to add React/TypeScript/anything that requires compilation: don't. The project's velocity comes from "hard-reload to test."
- **No npm dependencies.** `server.js` uses only Node built-ins (`http`, `fs`, `path`, `child_process`, `crypto`). Stay zero-dep.
- **Use `claude -p`, not the Anthropic API directly.** Users have Claude Code subscriptions; API key billing would cost them money per request. If `claude -p` is misbehaving, fix that — don't bypass.
- **OAuth tokens stay in the browser.** Never ship code that sends tokens server-side or stores them on the server. The server has no concept of "user."
- **Server-side intelligence, browser-side mutation.** `claude -p` decides *what* to do (search, pick tracks). Browser executes the Spotify Web API mutations via the user's localStorage tokens.

## Defaults to preserve

- The radio works without OAuth (audio plays via fallback) — but heart, skip, station-mutation all require auth. Don't break this.
- `data.js` is per-user, never committed (`.gitignore`d). `data.example.js` is the template.
- The DJ supports three action schemas: `create_station`, `add_tracks`, `remove_tracks`. Add new ones the same way — don't merge or refactor existing ones away.

## Compound-engineering loop

Plan → Work → Review → Compound → Repeat. Always:

1. **Plan first.** For any non-trivial change, state what you're doing + why + which files touch + the riskiest part. Skip the plan only for one-line fixes.
2. **Three questions before shipping.** Always self-answer:
   - What was the hardest decision?
   - What did I reject and why?
   - What am I least confident about?
3. **Capture learnings.** Recurring issue or non-obvious decision? Document it in this file or in a code comment that explains *why*. Future agents read this file.

## Where things live

| Subsystem | File(s) |
|---|---|
| Audio engine | `script.js` — Spotify Web Playback SDK init (`onSpotifyWebPlaybackSDKReady`) |
| OAuth (PKCE) | `auth.js` — `window.SpotifyAuth` namespace |
| Scenes | `index.html` (markup) + `styles.css` (`.scene--highway`, etc.) |
| Card / player UI | `index.html` (`.card`) + `script.js` (`renderTrackOnCard`) |
| DJ Request (Cmd+K) | `index.html` (`.dj`) + `script.js` (`submitDj`) + `server.js` (`/dj` endpoint) |
| Listen-through algorithm | `script.js` (`onTrackListenedThrough`, `onTrackSkipped`, `replenishStationFromTrack`) |
| Bridge tracks | `script.js` (`startBridge`, `checkBridgeEnd`) |
| Settings | `script.js` (`loadSettings`, `saveSettings`, `renderSettingsOverlay`) |
| Album-art tint | `script.js` (`updateArtTint`, `extractDominantColor`) |

## Console-log namespaces

When you add a subsystem, prefix its logs:
- `[sdk]` — Web Playback SDK lifecycle
- `[dj]` — Cmd+K requests + responses
- `[bridge]` — bridge track transitions
- `[bpm]` — BPM-locked filter
- `[tint]` — album-art color extraction
- `[card]` — track changes on the player card
- `[replenish]` — auto-add discovery logic
- `[mediasession]` — hardware media keys

## Anti-patterns

- **Don't poll Spotify Web API for state we already get from the SDK.** The SDK pushes `player_state_changed` events with full track info. Polling is for the *initial* "currently playing" lookup only, never for steady-state.
- **Don't mutate `data.js` from the browser.** Server owns writes to `data.js`. Browser owns Spotify playlist mutations.
- **Don't add `alert()` for recoverable errors.** Open the appropriate overlay or show inline UI. `alert()` is too jarring.
- **Don't hide the Spotify iframe behind `display: none` or move it off-screen.** Browsers throttle hidden iframes' audio contexts. (This was a real bug — search git history.)

## When in doubt

Read `README.md` for the user-facing model. Read `CONTRIBUTING.md` for the dev model. This file is the agent's working contract.

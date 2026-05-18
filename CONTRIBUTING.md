# Contributing to Mix Generator

Pull requests welcome. The project is small enough that there's no real ceremony — open an issue or PR and we'll iterate.

## Local dev

```bash
git clone https://github.com/<your-org>/mix-generator.git
cd mix-generator
node server.js
```

Open <http://127.0.0.1:8765>. Edit any of the source files (`index.html`, `styles.css`, `script.js`, `auth.js`, `server.js`) and hard-reload (`Cmd+Shift+R`) — there's no build step.

## Architecture in one paragraph

- **No build pipeline.** Vanilla HTML/CSS/JS — no React, no bundler, no transpile step. Hard-reload to test.
- **Zero npm deps.** `server.js` uses only Node built-ins. The page loads Google Fonts + the Spotify Web Playback SDK from CDNs.
- **Server-side `claude -p`.** The DJ Request (`⌘K`) endpoint spawns `claude -p` with the Spotify MCP. Server-side intelligence, browser-side mutation.
- **Browser-side Spotify Web API.** OAuth PKCE flow in `auth.js`. Tokens live in `localStorage`. The browser does all playlist add/remove via the Web API directly.
- **Spotify Web Playback SDK** for audio. The browser registers as a dedicated Spotify Connect device — no iframe, no conflict with the desktop app.

## Files

| File | Purpose |
|---|---|
| `server.js` | Node HTTP server: static + `/dj` endpoint (spawns `claude -p`) |
| `index.html` | Markup |
| `styles.css` | Scenes + player card + DJ modal + settings overlay |
| `script.js` | Scene + player + Cmd+K + listen-through detection + bridge + tint |
| `auth.js` | Spotify PKCE flow + Web API helpers |
| `data.js` | User-specific (gitignored); per-user station list |
| `data.example.js` | Template copied to `data.js` on first run |
| `examples/` | Cookbook + schema docs |

## Conventions

- **No frameworks unless absolutely necessary.** The "no build step" property is load-bearing for the project's vibe.
- **No env files.** Each user enters their Spotify Client ID via the in-app Connect overlay (stored in `localStorage`). No `.env` in the repo, no secrets to leak.
- **No npm install required.** If you add a dep, you have to justify it. Built-in modules first.
- **Console logs are the diagnostic surface.** `[sdk] …`, `[dj] …`, `[bridge] …`, `[bpm] …`, `[tint] …` — every subsystem prefixes its logs.

## Adding a scene

Scenes live in `index.html` (markup) + `styles.css` (animations) + are activated by name from `data.js`. To add `forest`:

1. In `index.html`, add a `<section class="scene scene--forest" data-scene="forest">` with whatever layers (sky, trees, rain, vignette).
2. In `styles.css`, add `.scene--forest { background: ... }` and any sub-element animations.
3. Stations using `scene: 'forest'` will now cross-fade to it on activation.

Full walkthrough in [`examples/scenes.md`](./examples/scenes.md).

## Adding a DJ action

The DJ currently supports `create_station`, `add_tracks`, `remove_tracks`. To add a new one (say `replace_track`):

1. In `server.js`, extend `buildDjPrompt()` with the new schema description.
2. In `server.js`, extend `applyDjResult()` with the new branch.
3. In `script.js`, extend `submitDj()` to handle the new action's result (mutation via `SpotifyAuth.api`).

Server-side intelligence, browser-side mutation. Don't add OAuth tokens to the server.

## Code style

- Vanilla. No transpilation, no fancy syntax beyond what modern Node + browsers natively support.
- Prefer small, named helper functions over inlined logic.
- Comments explain the *why* (constraints, browser quirks, Spotify API behaviors) — not the *what*.

## License

MIT. By contributing, you agree your changes ship under the same.

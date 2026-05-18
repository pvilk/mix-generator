# Settings — what each toggle does

Open the ⚙ in the bottom-right corner. Three toggles. All persisted to `localStorage` under the key `mixgen.settings.v1`.

## Schema

```js
{
  bridgeTracks: boolean,   // default: true
  bpmLocked: boolean,      // default: false
  albumArtTint: boolean,   // default: true
}
```

You can inspect or hand-edit in DevTools:

```js
JSON.parse(localStorage.getItem('mixgen.settings.v1'))
// → { bridgeTracks: true, bpmLocked: false, albumArtTint: true }
```

---

## 1. Bridge tracks between stations

**Default: ON.**

When you switch stations (click `›` or press `S`), if this is on AND you have at least one liked track, the page picks a recently-loved track that isn't already in the target station and plays it as a one-shot bridge song. When the bridge ends, the target station's playlist loads automatically.

**Why use it:** Switching stations feels like a real DJ transition — one familiar song first, then drop into the new vibe.

**Why turn it off:** You want station switches to be instant — no familiar interlude, just immediate context shift.

**Edge cases:**
- If you don't have any liked tracks yet (fresh session), bridge silently falls through to direct switch.
- If all your recently-loved tracks are *already* in the target station, no bridge fires.
- Hitting `›` again *during* a bridge cancels it and switches to the next station directly (no nested bridges).

**Console log:** `[bridge] "Track Name" by Artist → Target Station`

---

## 2. BPM-locked replenishment

**Default: OFF.**

When the auto-replenishment fires (after a listen-through), normally it adds the highest-scoring discovery candidate. With BPM lock on, it first filters candidates to those within ±5 BPM of the seed track, then scores.

**Why use it:** You want station continuity — tracks 1 and 2 should be similar tempo, not whiplashing between 90 and 140 BPM.

**Why turn it off (or why default off):** Spotify's `/audio-features` endpoint is deprecated for new apps (Nov 2024). Many users will get 403s on this endpoint. The filter silently falls through to no-op in that case — but still costs an API call you don't get value from.

**Edge cases:**
- If `/audio-features` is unavailable (403), filter is silently skipped. Replenishment proceeds without BPM gating.
- If the filter eliminates all candidates, the filter is dropped and replenishment uses the unfiltered set.

**Console logs:**
- `[bpm] seed 122.3 bpm → 8/30 within ±5` (working)
- `[bpm] audio-features unavailable (audio-features may be deprecated for your app)` (graceful failure)

---

## 3. Album-art tinted room

**Default: ON.**

Every time the current track changes, the page loads the album art into a hidden canvas, samples mid-luminance pixels (skipping pure black backgrounds and white text), computes a dominant color, and applies it to the `.art-tint` overlay div as `background-color` with a 1.4s `transition`.

The overlay sits at `z-index: 15` (above scenes, below UI) with `opacity: 0.22` and `mix-blend-mode: overlay` — a soft color cast, not a wash.

**Why use it:** The room reflects the track. Switching from a deep blue album to a warm orange one feels physical.

**Why turn it off:** You want the scene's authored colors untouched. Or your album art is wildly mixed and the tint flickers.

**Edge cases:**
- If the album art image fails CORS or 404s, tint silently fails (overlay stays transparent).
- Pre-OAuth (no real album art), tint shows nothing.
- Toggling off in settings clears the current tint immediately. Toggling on reapplies on the next track change.

**Console log:** *(silent on success; warning on extract failure)*

---

## Preset configurations

### Minimal (most subtle)

```js
{ bridgeTracks: false, bpmLocked: false, albumArtTint: false }
```

No bridges, no BPM gating, no color overlays. Just the radio in its rest state. Stations switch instantly, replenishment grabs whatever scores highest, scene colors are pristine.

### Power User (default + BPM)

```js
{ bridgeTracks: true, bpmLocked: true, albumArtTint: true }
```

All features on. BPM-locked replenishment only works reliably if `/audio-features` returns for your app — check the console for `[bpm]` logs.

### Discovery-Maxed (default)

```js
{ bridgeTracks: true, bpmLocked: false, albumArtTint: true }
```

Bridges for vibe continuity, BPM filter off (don't pre-narrow the discovery candidates), tint on for atmosphere. This is what ships out of the box.

---

## Hand-editing

To force a specific setting without opening the UI:

```js
localStorage.setItem('mixgen.settings.v1', JSON.stringify({
  bridgeTracks: false,
  bpmLocked: true,
  albumArtTint: true,
}));
location.reload();
```

To wipe and start from defaults: `localStorage.removeItem('mixgen.settings.v1')`.

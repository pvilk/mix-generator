# DJ Commands — the Cmd+K cookbook

Open with **⌘K** (or **Ctrl+K** on Windows/Linux). Type natural language. Hit Enter. Wait 30–60 seconds.

The DJ supports three action shapes, picked automatically based on your phrasing:

| Intent verbs in your prompt | Action picked |
|---|---|
| *"new"*, *"make me a station for"*, *"build a station"* | **`create_station`** — appends a new station to the dial |
| *"refresh"*, *"make it darker"*, *"change [station] to be"* | **`create_station` with same id** — overwrites the existing station's playlist URI |
| *"add"*, *"more"*, *"throw in"*, *"include"*, *"needs more"* | **`add_tracks`** — searches Spotify, appends specific tracks to the existing playlist |
| *"remove"*, *"drop"*, *"kill the"*, *"less"* | **`remove_tracks`** — searches Spotify, deletes specific tracks from the existing playlist |

---

## Create a new station

Adds a new entry to the dial and creates a brand-new Spotify playlist in your library.

- `New station for early morning coding`
- `Make me a station for cooking dinner — Brazilian jazz, Os Mutantes`
- `Build a station like Khruangbin but jazzier`
- `Station for late nights writing — instrumental, no vocals, dreamy`
- `Make a station for driving through fog at 5am`
- `Build a station for the gym — energetic, electronic, 120-130 bpm`
- `New station: rainy Sunday morning, slow-strummed indie folk`
- `Make a station like Bonobo curated this`
- `Station for a dinner party — bossa nova, warm, no English vocals`
- `Build something like the Anjunadeep label, ~60 tracks`

### Specifying a scene

You can hint at which scene the station should use:

- `New station — sunset cabin vibe — Lane 8 territory`  (→ scene: sunset)
- `Build a station for night driving — synthwave`  (→ scene: highway)
- `Make a station for a quiet bar — soul + jazz`  (→ scene: bar)

If you don't specify, Claude picks the best match for the vibe described.

---

## Refresh an existing station

Replaces a station's playlist entirely. Old playlist stays orphaned in your Spotify library (we don't auto-delete) but the dial points to the new one.

- `Refresh Late Night Drive`
- `Make Sunset Cabin darker, more 4am closing set`
- `Change Bar at Eleven to be jazzier — less soul, more cool jazz`
- `Late Night Drive needs more shoegaze, less synthwave`
- `Make Morning Coding more electronic`
- `Refresh Sunset Cabin with newer Lane 8 tracks from this year`

---

## Add tracks to an existing station

Searches Spotify and appends specific tracks. **The existing playlist is preserved — no orphans.**

- `Add 5 darker shoegaze tracks to Late Night Drive`
- `Bar at Eleven needs more Khruangbin-y bass lines`
- `Throw 3 vocal-led tracks into Sunset Cabin`
- `Add some Tycho to Morning Coding`
- `Late Night Drive needs more Beach House energy — add 5`
- `Add 4 tracks to Bar at Eleven that feel like Mac DeMarco's mellower stuff`
- `Sneak in 3 ambient interludes to Morning Coding`
- `Add more Ben Böhmer-style melodic house to Sunset Cabin`

---

## Remove tracks from an existing station

Searches your station for tracks matching the description and removes them.

- `Remove the synthwave from Late Night Drive`
- `Drop the poppier tracks from Bar at Eleven`
- `Kill the vocals on Sunset Cabin`
- `Remove anything by Mac DeMarco from Bar at Eleven`
- `Strip the 80s sound out of Late Night Drive`
- `Less Khruangbin on Bar at Eleven`

---

## Cross-station moves

The DJ can reason across stations:

- `Move the slower tracks from Late Night Drive to Bar at Eleven`  (= remove from A + add to B)
- `Take 3 Sunset Cabin tracks and put them on Late Night Drive`

Note: these become *two sequential DJ requests* if Claude decides — sometimes faster to just ask for the add directly.

---

## Taste-aware requests

The DJ has your last 30 listened-through + last 30 skipped tracks as context with every request. You can lean on that:

- `Add 5 tracks I'd probably like to Late Night Drive`
- `Refresh Sunset Cabin around what I've been listening to lately`
- `Throw some artists I haven't heard before but might like into Bar at Eleven`
- `Add tracks similar to the ones I've been finishing on Late Night Drive`

---

## Recovery / error cases

- *Empty station response:* `That station doesn't exist. Make one with: 'new station for...'`
- *Vague remove:* `'less synthy' is too vague — I'd suggest 'refresh [station] with more X' instead`
- *Premium-only failures:* the DJ doesn't know about Premium gating; if it tries to play a track that needs Premium and you don't have it, the SDK errors out separately

---

## Pro tips

- **Be specific about counts.** "Add 5 tracks" works better than "add some tracks."
- **Name seed artists.** "Like Khruangbin's bass lines" gives Claude a much better search than "kind of groovy."
- **Mention BPM if you care.** "Around 120 bpm" — Claude will try (though Spotify's audio-features API isn't always available).
- **Genres > moods for search precision.** Spotify's search engine speaks genres. "Slowcore" returns better results than "sad."
- **Use "and" to combine seeds.** "Lane 8 and Cubicolor" gets you the overlap of two universes.

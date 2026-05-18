# Stations — schema + 10 starting configs

Stations live in `data.js`. The schema is in `data.example.js` (also reproduced below). Each entry is a JSON object inside `window.MIX_DATA.playlists`.

## Schema

```js
{
  id: 'kebab-case-id',          // stable slug, doubles as the dial's key
  title: 'Display Name',         // shown on the nameplate above the deck
  subtitle: 'Vibe · Seed artists',  // shown under the title
  scene: 'highway' | 'bar' | 'sunset',  // background scene/room
  coverColors: ['#hex'],         // 1-2 hex codes — accent color for the card
  spotifyUri: 'spotify:playlist:...',   // empty triggers first-run setup
  spotifyUrl: 'https://open.spotify.com/playlist/...',
  refresh: 'manual',             // informational ('manual' | 'daily')
}
```

### Field-by-field

- **`id`** — must be unique. Used as the React-key-equivalent for the dial. Keep it kebab-case.
- **`title`** — uppercased on the nameplate, shown as-is on the card.
- **`subtitle`** — try to lead with the vibe, then `·` then 2–3 seed artists. The taste profile and replenishment use the subtitle as a hint when seeding searches.
- **`scene`** — one of the three defaults shipped, or any scene you add yourself (see [`scenes.md`](./scenes.md)).
- **`coverColors`** — 1 hex (a single solid) or 2 hex (used as gradient endpoints for the fallback card art).
- **`spotifyUri`** — when empty, the card shows "Set up [Title] — Press ⌘K". When set, the SDK loads this as the active context on station change.
- **`spotifyUrl`** — the open.spotify.com link. Auto-derived from `spotifyUri` if you leave it blank.
- **`refresh`** — currently informational. Hook for the future Daily New Music agent.

## 10 sample station configs

Drop any of these into `data.js`'s `playlists` array. Replace the empty `spotifyUri` either by editing it manually or by hitting ⌘K and asking the DJ to set it up.

### 1. Late Night Drive (default ships)

```js
{
  id: 'late-night-drive',
  title: 'Late Night Drive',
  subtitle: 'Synthwave · Dream pop · 2am highway',
  scene: 'highway',
  coverColors: ['#7c2dd1', '#d6336c'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 2. Bar at Eleven (default ships)

```js
{
  id: 'bar-at-eleven',
  title: 'Bar at Eleven',
  subtitle: 'Hi-fi listening bar · Soul · Khruangbin · Mac DeMarco',
  scene: 'bar',
  coverColors: ['#e8a652'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 3. Sunset Cabin (default ships)

```js
{
  id: 'sunset-cabin',
  title: 'Sunset Cabin',
  subtitle: 'Lane 8 · Ben Böhmer · Eli & Fur · Anjunadeep',
  scene: 'sunset',
  coverColors: ['#ff6b80', '#ffa55a'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 4. Morning Coding

```js
{
  id: 'morning-coding',
  title: 'Morning Coding',
  subtitle: 'Instrumental · Tycho · Bonobo · Helios',
  scene: 'bar',
  coverColors: ['#9d7f4c'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 5. 90s Grunge

```js
{
  id: '90s-grunge',
  title: '90s Grunge',
  subtitle: 'Pearl Jam · Soundgarden · Alice in Chains',
  scene: 'highway',
  coverColors: ['#4a4a4a', '#7c2dd1'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 6. Rainy Afternoon

```js
{
  id: 'rainy-afternoon',
  title: 'Rainy Afternoon',
  subtitle: 'Indie folk · Phoebe Bridgers · Big Thief · Bon Iver',
  scene: 'bar',
  coverColors: ['#5a7c8a'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 7. Cooking Dinner

```js
{
  id: 'cooking-dinner',
  title: 'Cooking Dinner',
  subtitle: 'Brazilian jazz · Tropicalia · Os Mutantes · Caetano Veloso',
  scene: 'bar',
  coverColors: ['#d4a86a'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 8. Festival Sundown

```js
{
  id: 'festival-sundown',
  title: 'Festival Sundown',
  subtitle: 'Tinlicker · Nora En Pure · Cubicolor · Yotto',
  scene: 'sunset',
  coverColors: ['#ff8a3d', '#c44d72'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 9. Sad Girl Indie

```js
{
  id: 'sad-girl-indie',
  title: 'Sad Girl Indie',
  subtitle: 'Mitski · Adrianne Lenker · Snail Mail · Soccer Mommy',
  scene: 'highway',
  coverColors: ['#4d2f5c'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

### 10. Lofi Background

```js
{
  id: 'lofi-background',
  title: 'Lofi Background',
  subtitle: 'Chill beats · Jinsang · Nymano · Idealism',
  scene: 'bar',
  coverColors: ['#a3825a'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

## Mixing it up

You can put as many stations as you want into `data.js`. The dial cycles through all of them with the `‹` / `›` arrows or the `A` / `S` keys. There's no hard ceiling — 3 stations feels right, 10 feels crowded but still works.

To start fresh: delete `data.js` and restart the server. The first-run logic copies `data.example.js` → `data.js`.

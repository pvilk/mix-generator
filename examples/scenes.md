# Scenes — how to add a new room

Each station has a `scene` field that maps to a fullscreen ambient backdrop. Three ship by default: `highway`, `bar`, `sunset`. Adding a new one is purely data + CSS — no JS changes.

## Anatomy of a scene

A scene is a `<section>` inside the `.scenes` container in `index.html`. It contains layered `<div>` elements (sky, particles, foreground, vignette). When the active station's `scene` matches, the JS adds `.--active` to it and CSS handles the cross-fade.

```html
<section class="scene scene--highway" data-scene="highway">
  <div class="highway__sky"></div>
  <div class="highway__stars"></div>
  <div class="highway__streaks"></div>
  <div class="highway__windshield"></div>
  <div class="highway__dashboard"></div>
  <div class="vignette"></div>
</section>
```

CSS pattern:

```css
.scene--highway {
  background: #02030a;
}
.highway__sky { /* background gradient */ }
.highway__stars { /* twinkly dots via radial-gradient */ }
.highway__streaks { /* animated horizontal blurs */ }
/* ... */
```

The `.scene` class handles cross-fade opacity transitions (controlled by `script.js → activateScene()`). You don't have to wire that yourself.

## Step-by-step: adding a "forest" scene

### 1. Markup in `index.html`

Add a new `<section>` inside `.scenes`:

```html
<section class="scene scene--forest" data-scene="forest">
  <div class="forest__sky"></div>
  <div class="forest__canopy"></div>
  <div class="forest__rays"></div>
  <div class="forest__floor"></div>
  <div class="vignette"></div>
</section>
```

### 2. Styles in `styles.css`

```css
/* ═══════════════════════════════════════
   SCENE — FOREST
   ═══════════════════════════════════════ */
.scene--forest {
  background: linear-gradient(180deg, #1a2a1c 0%, #0d1a0e 100%);
}

.forest__sky {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 0%, #4a6b3f 0%, transparent 50%);
}

.forest__canopy {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 50vh;
  background:
    repeating-linear-gradient(
      45deg,
      transparent 0,
      rgba(20, 50, 25, 0.4) 8px,
      transparent 16px,
      rgba(35, 80, 40, 0.3) 24px,
      transparent 32px
    );
  filter: blur(2px);
}

.forest__rays {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 80vh;
  background:
    linear-gradient(
      105deg,
      transparent 0%,
      rgba(220, 240, 180, 0.06) 30%,
      transparent 60%
    );
  animation: forest-rays 40s ease-in-out infinite alternate;
}

@keyframes forest-rays {
  0% { transform: translateX(-5%) skewX(-2deg); }
  100% { transform: translateX(5%) skewX(2deg); }
}

.forest__floor {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 22vh;
  background: linear-gradient(180deg, transparent 0%, rgba(8, 14, 8, 0.9) 80%);
}
```

### 3. Use it in `data.js`

```js
{
  id: 'forest-walk',
  title: 'Forest Walk',
  subtitle: 'Ambient · Sigur Rós · Hammock · Stars of the Lid',
  scene: 'forest',         // ← the new scene
  coverColors: ['#4a6b3f'],
  spotifyUri: '',
  spotifyUrl: '',
  refresh: 'manual',
}
```

That's it. Hard-reload, switch to the new station, the scene cross-fades in.

---

## Design tips

### Layer count
- **3 layers** = minimal (background gradient, one animated element, vignette)
- **5 layers** = sweet spot (sky, mid-ground, particles, foreground, vignette)
- **8+ layers** = busy, performance concerns

### Performance
- All animations should run at 60 FPS at most. Use `transform` and `opacity` only — avoid animating `top` / `left` / `width` / `height`.
- `filter: blur()` is expensive. Apply once per element, not to many elements simultaneously.
- Particles via `repeating-linear-gradient` or `radial-gradient` are cheaper than per-element divs for ambient effects.

### Color
- Lean into one dominant hue. The album-art tint overlay (if enabled) will modulate the scene, so build with a "neutral resting state" in mind.
- Mid-luminance backgrounds (not pure black, not white) play best with the tint feature.

### Animation timing
- Long, slow loops (40s+) read as ambient.
- Short loops (<5s) feel jittery in the background.
- Multiple elements with different periods + delays look more organic than synchronized motion.

---

## Existing scenes for reference

| Scene | Layers | Notable techniques |
|---|---|---|
| `highway` | sky, stars, streaks, windshield, dashboard, vignette | JS-injected streak divs with randomized speed + position; `streak-go` animation slides them across the viewport |
| `bar` | wall, lamp, counter, floor, incense (SVG smoke), vignette | SVG `<path>` smoke trails with `smoke-drift` keyframes; radial gradient pendant lamp with `mix-blend-mode: screen` |
| `sunset` | sky, stars, sun, sun-halo, 3 cloud layers, horizon, vignette | Clip-path mountain silhouette; multi-stop linear gradient sky; pulse on the sun disc |

Open `styles.css` and search for `SCENE — HIGHWAY` etc. for the full source.

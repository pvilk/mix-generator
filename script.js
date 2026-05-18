(() => {
  'use strict';

  const data = window.MIX_DATA || { playlists: [], active: null };
  const els = {
    scenes: document.getElementById('scenes'),
    streaksHost: document.getElementById('streaks-host'),
    stationLabel: document.getElementById('station-label'),
    stationName: document.getElementById('station-name'),
    stationSub: document.getElementById('station-sub'),
    stationPrev: document.getElementById('station-prev'),
    stationNext: document.getElementById('station-next'),
    connectPrompt: document.getElementById('connect-prompt'),

    card: document.getElementById('card'),
    cardArt: document.getElementById('card-art'),
    cardTitle: document.getElementById('card-title'),
    cardArtist: document.getElementById('card-artist'),
    cardProgress: document.getElementById('card-progress'),
    ctrlPrev: document.getElementById('ctrl-prev'),
    ctrlPlay: document.getElementById('ctrl-play'),
    ctrlNext: document.getElementById('ctrl-next'),

    hotcorner: document.getElementById('hotcorner'),
    gear: document.getElementById('gear'),
    artTint: document.getElementById('art-tint'),

    // DJ Request (Cmd+K)
    dj: document.getElementById('dj'),
    djBackdrop: document.getElementById('dj-backdrop'),
    djForm: document.getElementById('dj-form'),
    djInput: document.getElementById('dj-input'),
    djDice: document.getElementById('dj-dice'),
    djRollHint: document.getElementById('dj-roll-hint'),
    djStatus: document.getElementById('dj-status'),
    overlay: document.getElementById('overlay'),
    overlayClose: document.getElementById('overlay-close'),
    overlayKicker: document.getElementById('overlay-kicker'),
    overlayTitle: document.getElementById('overlay-title'),
    overlayBody: document.getElementById('overlay-body'),
    overlayActions: document.getElementById('overlay-actions'),
  };

  // ── State ──
  const LS_KEY = 'mixgen.liked.v1';
  const LS_SKIPPED = 'mixgen.skipped.v1';
  const LS_KNOWN_ARTISTS = 'mixgen.knownArtists.v1';
  const LS_SETTINGS = 'mixgen.settings.v1';
  const LS_ONBOARDED = 'mixgen.onboarded.v1';
  const LS_ONBOARDING_STEP = 'mixgen.onboarding.step';
  const DEFAULT_SETTINGS = {
    bpmLocked: false,
    albumArtTint: true,
  };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      return { ...DEFAULT_SETTINGS, ...s };
    } catch (e) { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  }

  let activeId = data.active || (data.playlists[0] && data.playlists[0].id);
  let isPlaying = false;
  let sdkPlayer = null;            // Spotify Web Playback SDK instance
  let sdkDeviceId = null;          // our browser device id, registered with Spotify Connect
  let sdkReady = false;
  let liked = loadLocal(LS_KEY);
  let skipped = loadLocal(LS_SKIPPED);
  let lastSeenTrack = null;
  let pollInterval = null;
  let inflightAdds = new Set();
  let currentTrack = null;
  // Iframe-level progress (works without OAuth — drives the live timer/progress bar)
  let iframePos = 0;
  let iframeDur = 0;
  let iframeTrackIdx = 0;
  let lastIframePos = 0;

  // ── Auto-skip state ──
  const MAX_AUTO_SKIPS_PER_TRACK = 3;       // safety: never spam-skip the same URI
  const MAX_AUTO_SKIPS_IN_A_ROW = 10;       // safety: if every track is disfavored, just play one
  const autoSkipCounter = {};               // uri → times we've auto-skipped it
  let autoSkipsInARow = 0;
  let autoSkipInProgress = false;

  // Station-switching gate: while a station change is in flight, the SDK
  // keeps firing player_state_changed events for the PREVIOUS station's
  // track until Spotify finishes loading the new context (200-800ms).
  // Without this gate, the old track gets rendered under the new station's
  // nameplate ("BAROQUE CHAMBERS playing Trance Wax").
  let stationSwitching = false;
  let switchingToUri = null;

  // ── Chapter auto-regen state ──
  // After N listen-throughs on a station, background-trigger MCP to create a
  // fresh playlist with the same vibe. We DERIVE the counter from the
  // persistent `liked` array (each entry has stationId) and a per-station
  // baseline that we snapshot when a regen fires. Effective listens for a
  // station = liked-records-for-that-station - baseline.
  //
  // Threshold is 25 — matches legacy ~30-track stations (regen at ~83%
  // through) and ~20% of new 120-track stations.
  const CHAPTER_REGEN_THRESHOLD = 25;
  const LS_CHAPTER_BASELINES = 'mixgen.chapterBaselines.v1';
  const stationRegenInProgress = {};     // stationId → bool
  const stationsAwaitingSwap = {};       // stationId → new spotifyUri

  let chapterBaselines = {};   // stationId → liked-count at last regen
  try {
    chapterBaselines = JSON.parse(localStorage.getItem(LS_CHAPTER_BASELINES) || '{}');
  } catch (e) { chapterBaselines = {}; }

  function persistChapterBaselines() {
    localStorage.setItem(LS_CHAPTER_BASELINES, JSON.stringify(chapterBaselines));
    scheduleStateSync();
  }

  function likedCountForStation(stationId) {
    let n = 0;
    for (const l of liked) if (l.stationId === stationId) n++;
    return n;
  }

  function effectiveChapterCount(stationId) {
    return likedCountForStation(stationId) - (chapterBaselines[stationId] || 0);
  }

  // Returns true if this track should be silently skipped because the user
  // already rejected it (URI in skipped list, or artist in last 20 skips).
  function shouldAutoSkip(track) {
    if (!track || !track.uri) return false;
    // Exact-URI skip
    if (skipped.some((s) => s && s.uri === track.uri)) return true;
    // Artist-level skip — only consider the LAST 20 skips so the set doesn't
    // grow unboundedly
    const recentSkips = skipped.slice(-20);
    if (recentSkips.length === 0) return false;
    const disfavored = new Set();
    recentSkips.forEach((s) => {
      String(s.artist || '').split(',').forEach((a) => disfavored.add(a.trim().toLowerCase()));
    });
    const artistNames = (track.artists || []).map((a) => (a.name || '').toLowerCase());
    return artistNames.some((n) => disfavored.has(n));
  }
  // Station-switch guard — ignore Spotify polls that return the OLD track
  // while the iframe is still loading the new playlist.
  let preSwitchUri = null;
  let postSwitchUntil = 0;
  // Station playlist URI cache: stationId -> Set<trackUri>
  const stationTrackCache = {};

  function loadLocal(k) {
    try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; }
  }
  function saveLiked() { localStorage.setItem(LS_KEY, JSON.stringify(liked)); scheduleStateSync(); }
  function saveSkipped() { localStorage.setItem(LS_SKIPPED, JSON.stringify(skipped)); scheduleStateSync(); }

  // ── Server-side persistence (backup to state.json) ──
  // localStorage already persists across sessions/restarts on the same browser,
  // but we ALSO mirror to disk so:
  //   - "Clear browsing data" doesn't nuke listening history
  //   - You can read the same history from a fresh browser on the same machine
  //   - It survives a JSON-corruption bug in localStorage
  // Server file: state.json (gitignored). One-way push: browser → server.
  // On boot, if localStorage is empty, hydrate FROM the server file.
  let stateSyncTimer = null;
  async function scheduleStateSync() {
    if (stateSyncTimer) clearTimeout(stateSyncTimer);
    stateSyncTimer = setTimeout(async () => {
      try {
        await fetch('/state/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            liked,
            skipped,
            knownArtists: [...loadKnownArtists()],
            chapterBaselines,
          }),
        });
      } catch (e) {
        // Server might not be running, or browser tab might be closing.
        // Either way: localStorage already has the data, so this is just a
        // missed backup. Don't block anything on it.
        console.warn('[state] sync failed (non-fatal)', e.message || e);
      }
    }, 1500);
  }

  async function hydrateStateFromServer() {
    // Only hydrate when local is empty — server is a backup, not the truth.
    if (liked.length > 0 || skipped.length > 0) return;
    try {
      const resp = await fetch('/state/sync');
      if (!resp.ok) return;
      const remote = await resp.json();
      if (remote.liked && remote.liked.length > 0) {
        liked = remote.liked;
        localStorage.setItem(LS_KEY, JSON.stringify(liked));
      }
      if (remote.skipped && remote.skipped.length > 0) {
        skipped = remote.skipped;
        localStorage.setItem(LS_SKIPPED, JSON.stringify(skipped));
      }
      if (remote.knownArtists && remote.knownArtists.length > 0) {
        saveKnownArtists(new Set(remote.knownArtists));
      }
      if (remote.chapterBaselines && typeof remote.chapterBaselines === 'object') {
        // Merge baselines: take MAX so we never accidentally re-fire regen
        // on a browser that's behind on baseline updates.
        for (const stationId in remote.chapterBaselines) {
          const remoteN = remote.chapterBaselines[stationId] || 0;
          const localN = chapterBaselines[stationId] || 0;
          chapterBaselines[stationId] = Math.max(remoteN, localN);
        }
        localStorage.setItem(LS_CHAPTER_BASELINES, JSON.stringify(chapterBaselines));
      }
      if (remote.syncedAt) {
        console.log(`[state] hydrated from server backup (last sync: ${new Date(remote.syncedAt).toLocaleString()})`);
      }
    } catch (e) {
      console.warn('[state] hydrate skipped', e.message || e);
    }
  }

  function playlistIdFromUri(uri) {
    if (!uri) return null;
    return uri.split(':').pop();
  }

  async function ensureStationTracksLoaded(stationId) {
    if (stationTrackCache[stationId]) return stationTrackCache[stationId];
    const mix = findMix(stationId);
    if (!mix || !mix.spotifyUri) return new Set();
    const pid = playlistIdFromUri(mix.spotifyUri);
    try {
      const uris = await SpotifyAuth.getAllPlaylistTrackUris(pid);
      stationTrackCache[stationId] = uris;
      return uris;
    } catch (e) {
      console.warn(`Could not load track cache for ${stationId}`, e);
      const empty = new Set();
      stationTrackCache[stationId] = empty;
      return empty;
    }
  }
  const findMix = (id) => data.playlists.find((p) => p.id === id);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  // ── Scene management ──
  function activateScene(sceneName) {
    document.querySelectorAll('.scene').forEach((el) => {
      el.classList.toggle('--active', el.dataset.scene === sceneName);
    });
    // Re-seed highway streaks if entering highway
    if (sceneName === 'highway') seedHighwayStreaks();
  }

  function seedHighwayStreaks() {
    if (!els.streaksHost) return;
    els.streaksHost.innerHTML = '';
    const COUNT = 18;
    for (let i = 0; i < COUNT; i++) {
      const s = document.createElement('span');
      s.className = 'streak' + (Math.random() < 0.35 ? ' streak--cool' : '');
      const top = 35 + Math.random() * 40; // 35–75% (focus toward horizon)
      const dur = 2.4 + Math.random() * 3.6; // 2.4–6s
      const delay = -Math.random() * dur; // randomize start so streaks aren't synced
      s.style.setProperty('--top', `${top}%`);
      s.style.setProperty('--dur', `${dur}s`);
      s.style.setProperty('--delay', `${delay}s`);
      s.style.width = `${18 + Math.random() * 24}vw`;
      els.streaksHost.appendChild(s);
    }
  }

  // ── Render station ──
  function renderStation(mix) {
    els.stationName.textContent = mix.title;
    els.stationSub.textContent = mix.subtitle || '';
    activateScene(mix.scene || 'highway');

    // First-run state: station has no Spotify URI yet (template default)
    if (!mix.spotifyUri) {
      els.cardTitle.textContent = `Set up "${mix.title}"`;
      els.cardArtist.textContent = 'Press ⌘K and ask the DJ to fill it in';
      els.cardArt.style.backgroundImage = '';
      els.cardArt.classList.remove('--has-art');
      els.cardProgress.style.width = '0%';
      return;
    }

    // Reset card display
    if (!SpotifyAuth.isAuthed() || !currentTrack) {
      els.cardTitle.textContent = mix.title;
      els.cardArtist.textContent = mix.subtitle || '';
      els.cardArt.style.backgroundImage = '';
      els.cardArt.classList.remove('--has-art');
      els.cardProgress.style.width = '0%';
    }
  }

  function setPlayingVisual(playing) {
    isPlaying = playing;
    els.ctrlPlay.textContent = playing ? '⏸' : '▶';
    if (window.SpotifyAuth && SpotifyAuth.isAuthed()) {
      if (playing) startPolling(); else stopPolling();
    }
    renderConnectPrompt();
  }

  function renderConnectPrompt() {
    const authed = window.SpotifyAuth && SpotifyAuth.isAuthed();
    els.connectPrompt.hidden = !(isPlaying && !authed);
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
  }

  function renderHotcorner() {
    const authed = window.SpotifyAuth && SpotifyAuth.isAuthed();
    els.hotcorner.classList.toggle('--unsaved', !authed);
    els.hotcorner.title = authed
      ? `Auto-saving on · ${liked.length} saved this session`
      : 'Set up Spotify auto-save';
  }

  function renderTrackOnCard(t) {
    const isNewTrack = !currentTrack || currentTrack.uri !== t.uri;
    currentTrack = t;
    updateMediaSessionMetadata(t);
    els.cardTitle.textContent = t.name || '—';
    els.cardArtist.textContent = t.artist || '—';
    els.cardArtist.classList.remove('--timer');
    els.cardTitle.classList.remove('--swapping');
    els.cardArtist.classList.remove('--swapping');
    if (t.artUrl) {
      els.cardArt.style.backgroundImage = `url(${JSON.stringify(t.artUrl)})`;
      els.cardArt.classList.add('--has-art');
      els.cardArt.classList.remove('--swapping');
    } else {
      els.cardArt.classList.remove('--has-art');
    }
    if (t.durationMs > 0) {
      const pct = Math.max(0, Math.min(100, (t.progressMs / t.durationMs) * 100));
      els.cardProgress.style.width = `${pct}%`;
    }
    if (isNewTrack) {
      console.log('[card] new track on deck:', t.name, '·', t.artist);
      updateArtTint(t);
    }
  }

  // ── Album-art tint ──
  // Loads the album art, samples pixel colors via canvas, applies an
  // overlay-blend tint to the .art-tint div.
  async function updateArtTint(track) {
    const s = loadSettings();
    if (!s.albumArtTint || !track || !track.artUrl) {
      els.artTint.style.backgroundColor = 'transparent';
      return;
    }
    try {
      const color = await extractDominantColor(track.artUrl);
      if (color) els.artTint.style.backgroundColor = color;
    } catch (e) {
      console.warn('[tint] extract failed', e);
    }
  }

  function extractDominantColor(imageUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(null), 3500);
      img.onload = () => {
        clearTimeout(t);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32; canvas.height = 32;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;
          let r = 0, g = 0, b = 0, n = 0;
          // Average only mid-luminance pixels — skip pure black backgrounds
          // and white text/borders so the tint reflects the album's true hue.
          for (let i = 0; i < data.length; i += 4) {
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < 30 || lum > 235) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2];
            n++;
          }
          if (n === 0) {
            // All pixels filtered — fall back to plain average
            for (let i = 0; i < data.length; i += 4) {
              r += data[i]; g += data[i + 1]; b += data[i + 2];
              n++;
            }
          }
          resolve(`rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.src = imageUrl;
    });
  }

  // ── MediaSession (hardware media keys: F7/F8/F9, lock screen, Touch Bar) ──
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) {
      console.log('[mediasession] not supported');
      return;
    }
    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        console.log('[mediasession] previoustrack');
        skipPrev();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        console.log('[mediasession] nexttrack');
        skipNext();
      });
      navigator.mediaSession.setActionHandler('play', () => {
        console.log('[mediasession] play');
        if (!isPlaying) togglePlay();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        console.log('[mediasession] pause');
        if (isPlaying) togglePlay();
      });
      navigator.mediaSession.setActionHandler('seekto', (e) => {
        if (sdkPlayer && e.seekTime != null) {
          try { sdkPlayer.seek(Math.round(e.seekTime * 1000)); } catch (err) {}
        }
      });
      console.log('[mediasession] handlers registered');
    } catch (e) {
      console.warn('[mediasession] setup failed', e);
    }
  }

  function updateMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name || '',
        artist: track.artist || '',
        album: (findMix(activeId) && findMix(activeId).title) || 'Mix Generator',
        artwork: track.artUrl
          ? [
              { src: track.artUrl, sizes: '300x300', type: 'image/jpeg' },
              { src: track.artUrl, sizes: '640x640', type: 'image/jpeg' },
            ]
          : [],
      });
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      if (track.durationMs > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: track.durationMs / 1000,
            position: (track.progressMs || 0) / 1000,
            playbackRate: 1.0,
          });
        } catch (e) { /* some browsers throw if position > duration */ }
      }
    } catch (e) {
      console.warn('[mediasession] metadata failed', e);
    }
  }

  // ── Web API polling (only when authed) ──
  async function pollCurrentlyPlaying() {
    try {
      const resp = await SpotifyAuth.getCurrentlyPlaying();
      if (!resp || !resp.item) { lastSeenTrack = null; return; }
      const item = resp.item;
      const cur = {
        uri: item.uri,
        id: item.id,
        name: item.name,
        artist: (item.artists || []).map((a) => a.name).join(', '),
        artUrl: (item.album && item.album.images && item.album.images[0] && item.album.images[0].url) || null,
        durationMs: item.duration_ms,
        progressMs: resp.progress_ms || 0,
        isPlaying: resp.is_playing,
        polledAt: Date.now(),
      };

      // Stale-poll guard: during the station-switch window (8s), Spotify
      // often keeps returning the previous track while the iframe loads.
      // Drop those updates so the OLD album art doesn't repopulate.
      if (Date.now() < postSwitchUntil && cur.uri === preSwitchUri) {
        console.log('[poll] stale track during switch, ignoring:', cur.name);
        return;
      }

      // The first non-stale track confirms the switch — clear the guard
      if (postSwitchUntil > 0 && cur.uri !== preSwitchUri) {
        postSwitchUntil = 0;
        preSwitchUri = null;
      }

      console.log('[poll] track:', cur.name, '·', cur.artist);
      renderTrackOnCard(cur);

      if (lastSeenTrack && lastSeenTrack.uri !== cur.uri) {
        const remainingBefore = lastSeenTrack.durationMs - lastSeenTrack.progressMs;
        const elapsedReal = cur.polledAt - lastSeenTrack.polledAt;
        const ratio = lastSeenTrack.durationMs > 0
          ? lastSeenTrack.progressMs / lastSeenTrack.durationMs : 0;

        // Played through if: >85% heard, OR real wall-time matches what
        // would've been needed to play out the remainder (caught the natural transition).
        const naturallyEnded = elapsedReal >= remainingBefore - 8000;
        const playedThrough = ratio >= 0.85 || naturallyEnded;

        if (playedThrough) {
          await onTrackListenedThrough(lastSeenTrack);
        } else {
          await onTrackSkipped(lastSeenTrack);
        }
      }
      lastSeenTrack = cur;
    } catch (e) {
      if (String(e.message || e).includes('401')) {
        SpotifyAuth.clearAuth();
        renderHotcorner();
        stopPolling();
      }
    }
  }

  function startPolling() {
    if (pollInterval) return;
    pollCurrentlyPlaying();
    pollInterval = setInterval(pollCurrentlyPlaying, 2500);
  }
  function stopPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
  }

  // Schedule a cascade of polls — used right after an action so the UI
  // catches the new track within a second instead of waiting for the next
  // 2.5s tick. Cheap (Spotify allows 180/min, we'd use maybe 30).
  function pollSoon() {
    if (!SpotifyAuth.isAuthed()) return;
    setTimeout(pollCurrentlyPlaying, 250);
    setTimeout(pollCurrentlyPlaying, 900);
    setTimeout(pollCurrentlyPlaying, 1800);
  }

  function flashButton(btn) {
    if (!btn || !btn.animate) return;
    btn.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.86)' }, { transform: 'scale(1)' }],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0.3, 1)' }
    );
  }

  // Action debounce — prevents double-fire when the same media-key event
  // fires through BOTH the MediaSession handler AND the keydown handler
  // (which both happen on Mac when a hardware media key is pressed).
  const actionLocks = { play: 0, next: 0, prev: 0 };
  function actionLocked(key) {
    const now = Date.now();
    if (now < actionLocks[key]) return true;
    actionLocks[key] = now + 350;
    return false;
  }

  async function onTrackListenedThrough(track) {
    if (liked.some((l) => l.uri === track.uri)) return;
    if (inflightAdds.has(track.uri)) return;
    inflightAdds.add(track.uri);

    const mix = findMix(activeId);
    liked.push({
      ts: Date.now(),
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      durationMs: track.durationMs,
      stationId: activeId,
      stationTitle: mix ? mix.title : activeId,
    });
    saveLiked();
    renderHotcorner();

    const trackId = track.id || (track.uri || '').split(':').pop();

    // Best-effort save to user's Liked Songs library. If the dev app is in
    // Development Mode + User Management isn't propagating, this 403s — that's
    // expected and not actionable per-track. Log only; rely on save_session
    // (via MCP, which bypasses the dev app) for actual durable archives.
    if (trackId) {
      SpotifyAuth.saveTrackToLibrary(trackId)
        .then(() => console.log(`[liked] ✓ saved "${track.name}" to Liked Songs`))
        .catch((e) => console.warn(`[liked] auto-save 403 (expected if dev app blocked) — use ⌘K "save my session" to archive via MCP:`, e.message || e));
    }

    // 3. Queue ONE discovery track for the current session
    if (mix) {
      queueDiscoveryFromSeed(track, mix).catch((e) =>
        console.warn('[discover] failed', e.message || e));
    }

    // 4. Check if this listen-through pushes us past the chapter threshold.
    //    Counter is DERIVED from `liked` array (just pushed above) minus the
    //    per-station baseline, so it persists across reloads automatically.
    if (mix && mix.spotifyUri && SpotifyAuth.isAuthed()) {
      const n = effectiveChapterCount(mix.id);
      if (n % 5 === 0 || n === CHAPTER_REGEN_THRESHOLD) {
        console.log(`[chapter] "${mix.title}" listen count: ${n}/${CHAPTER_REGEN_THRESHOLD}`);
      }
      if (n >= CHAPTER_REGEN_THRESHOLD
          && !stationRegenInProgress[mix.id]
          && !stationsAwaitingSwap[mix.id]) {
        triggerChapterRegen(mix);   // fire and forget
      }
    }

    // 5. If a chapter regen has finished while the current track was playing,
    //    NOW (between tracks) is the right moment to swap to the new URI —
    //    no mid-song cut.
    if (mix && stationsAwaitingSwap[mix.id] && sdkReady) {
      const newUri = stationsAwaitingSwap[mix.id];
      delete stationsAwaitingSwap[mix.id];
      mix.spotifyUri = newUri;
      mix.spotifyUrl = `https://open.spotify.com/playlist/${newUri.split(':').pop()}`;
      console.log(`[chapter] ▶ swapping "${mix.title}" to fresh playlist after current track`);
      try { await playStation(mix); } catch (e) { console.warn('[chapter] swap failed', e); }
    }

    inflightAdds.delete(track.uri);
  }

  // Background chapter regeneration — generates a fresh ~120-track playlist
  // via MCP (claude -p), keeping station identity (title/subtitle/scene)
  // intact. Goes through /dj. Routes around Spotify dev app restrictions
  // entirely since MCP uses Claude.ai's connection.
  async function triggerChapterRegen(mix) {
    stationRegenInProgress[mix.id] = true;
    // Snapshot baseline NOW so we don't re-trigger while regen is in flight.
    // Effective listens drops to 0 immediately, ramps back up as user keeps
    // listening to the (about-to-be-swapped) playlist.
    chapterBaselines[mix.id] = likedCountForStation(mix.id);
    persistChapterBaselines();
    console.log(`[chapter] generating fresh chapter for "${mix.title}" (baseline=${chapterBaselines[mix.id]})…`);
    try {
      const profile = buildTasteProfile();
      const prompt =
        `CHAPTER REGEN for the "${mix.title}" station. The user has listened through ${CHAPTER_REGEN_THRESHOLD}+ tracks ` +
        `on this station this session. Generate a FRESH ~120-track playlist via create_playlist that fits the same vibe.\n\n` +
        `USE action="create_station" with these exact fields preserved (DO NOT change them):\n` +
        `  id="${mix.id}"\n` +
        `  title="${mix.title}"\n` +
        `  subtitle="${mix.subtitle || ''}"\n` +
        `  scene="${mix.scene || 'bar'}"\n` +
        `  coverColors=${JSON.stringify(mix.coverColors || ['#5b2e2e'])}\n\n` +
        `Only the playlist URI changes — everything else stays IDENTICAL. ` +
        `Prefer tracks/artists DIFFERENT from the user's recent listen-throughs (chapter freshness).`;

      const resp = await fetch('/dj', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, profile }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

      const final = await pollDjJob(data.jobId);
      if (final.status !== 'done') throw new Error(final.error || 'regen failed');

      const r = final.result || {};
      if (r.action === 'updated' && r.id === mix.id && r.spotifyUri) {
        // Mark for swap at next track boundary
        stationsAwaitingSwap[mix.id] = r.spotifyUri;
        console.log(`[chapter] ✓ fresh playlist ready for "${mix.title}" — will swap at next track`);
        showAuthToast(`Fresh chapter ready for ${mix.title} — swapping after this track`, 'success');
      } else if (r.action === 'created') {
        console.warn(`[chapter] expected overwrite, got new station ${r.id}`);
      }
    } catch (e) {
      console.warn(`[chapter] regen failed for "${mix.title}":`, e.message || e);
    } finally {
      stationRegenInProgress[mix.id] = false;
    }
  }

  // On boot, check every station's effective listen count (derived from
  // hydrated `liked` records). If any is already past threshold from prior
  // sessions, fire regen now.
  function maybeFireOverdueChapter() {
    if (!SpotifyAuth.isAuthed()) return;
    for (const mix of mixes) {
      const n = effectiveChapterCount(mix.id);
      if (n >= CHAPTER_REGEN_THRESHOLD
          && mix.spotifyUri
          && !stationRegenInProgress[mix.id]
          && !stationsAwaitingSwap[mix.id]) {
        console.log(`[chapter] "${mix.title}" at ${n} listens from prior sessions — firing regen now`);
        triggerChapterRegen(mix);
      }
    }
  }

  function loadKnownArtists() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_KNOWN_ARTISTS) || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveKnownArtists(s) {
    localStorage.setItem(LS_KNOWN_ARTISTS, JSON.stringify([...s]));
    scheduleStateSync();
  }

  // Find the artist Spotify ID from a SDK current_track object. The SDK
  // gives us `t.artists[0].uri` like "spotify:artist:abc123" — pull the id off.
  function artistIdFromSdkTrack() {
    if (!currentTrack || !currentTrack.uri) return null;
    // The SDK track exposes artists with uris. We're storing the joined name
    // string in lastSeenTrack.artist so we lost the uri. Pull from SDK state
    // on demand instead.
    return null; // (we get the id directly inside replenish via getCurrentState)
  }

  // ── Discovery queueing ──
  // When the user listens a track all the way through, we surface ONE
  // discovery track by queueing it via the SDK — no playlist mutation.
  // The queued track plays next in this session. If the user likes it,
  // they hit ♥ (saves to Liked Songs). If not, it's gone after the session.
  //   1. Find the seed track's first artist + their genres
  //   2. Search Spotify for tracks in that genre
  //   3. Hard-veto candidates from skipped artists; bonus for favored artists
  //   4. Bonus for new-to-you artists (discovery)
  //   5. POST /me/player/queue?uri=<winner> — track plays next in session
  async function queueDiscoveryFromSeed(seedTrack, mix) {
    if (!SpotifyAuth.isAuthed() || !sdkDeviceId) return;

    // We need the seed artist's ID — pull live from SDK state since
    // lastSeenTrack only stored the artist name string.
    let seedArtistId = null;
    let seedArtistName = seedTrack.artist;
    try {
      const state = await sdkPlayer.getCurrentState();
      const prev = state && state.track_window && state.track_window.previous_tracks
        && state.track_window.previous_tracks.find((t) => t.uri === seedTrack.uri);
      const cur = state && state.track_window && state.track_window.current_track;
      const src = prev || cur;
      if (src && src.artists && src.artists[0] && src.artists[0].uri) {
        seedArtistId = src.artists[0].uri.split(':').pop();
        seedArtistName = src.artists[0].name;
      }
    } catch (e) { /* */ }

    if (!seedArtistId) return;

    // Get seed artist genres
    let genres = [];
    try {
      const artist = await SpotifyAuth.getArtist(seedArtistId);
      genres = (artist && artist.genres) || [];
      console.log(`[replenish] seed artist: ${seedArtistName}, genres:`, genres);
    } catch (e) { console.warn('[replenish] artist lookup failed', e); }

    // Build a search query: prefer genre, fall back to "similar to X"
    let candidates = [];
    if (genres.length > 0) {
      const q = `genre:"${genres[0]}"`;
      try {
        const search = await SpotifyAuth.searchTracks(q, 30);
        if (search && search.tracks && search.tracks.items) candidates = search.tracks.items;
      } catch (e) { /* */ }
    }
    if (candidates.length === 0) {
      // Fall back to "similar to X" semantic search
      try {
        const search = await SpotifyAuth.searchTracks(seedArtistName, 30);
        if (search && search.tracks && search.tracks.items) candidates = search.tracks.items;
      } catch (e) { /* */ }
    }
    if (candidates.length === 0) {
      console.log('[replenish] no candidates found');
      return;
    }

    // Build a taste profile from recent listening:
    //   FAVORED  = artist names from the last 20 listen-throughs
    //   DISFAVORED = artist names from the last 20 skips
    // Used to score candidates (favored = bonus, disfavored = hard veto)
    const recentListened = liked.slice(-20);
    const recentSkipped = skipped.slice(-20);
    const splitArtists = (s) =>
      String(s || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
    const favoredArtists = new Set();
    recentListened.forEach((l) => splitArtists(l.artist).forEach((a) => favoredArtists.add(a)));
    const disfavoredArtists = new Set();
    recentSkipped.forEach((s) => splitArtists(s.artist).forEach((a) => disfavoredArtists.add(a)));
    console.log(`[replenish] taste: ${favoredArtists.size} favored / ${disfavoredArtists.size} disfavored artists`);

    // Filter out tracks already in the station + the seed track itself
    const cache = await ensureStationTracksLoaded(activeId);
    let fresh = candidates.filter((t) =>
      !cache.has(t.uri) && t.uri !== seedTrack.uri
    );
    if (fresh.length === 0) {
      console.log('[replenish] all candidates already in station');
      return;
    }

    // HARD VETO: if any of the candidate's artists are in the disfavored set,
    // drop it entirely. This is the anti-skip-pattern signal.
    const beforeVeto = fresh.length;
    fresh = fresh.filter((t) => {
      const artistNames = (t.artists || []).map((a) => (a.name || '').toLowerCase());
      return !artistNames.some((n) => disfavoredArtists.has(n));
    });
    if (fresh.length < beforeVeto) {
      console.log(`[replenish] vetoed ${beforeVeto - fresh.length} candidate(s) by disfavored artists`);
    }
    if (fresh.length === 0) {
      console.log('[replenish] all remaining candidates were disfavored — no add');
      return;
    }

    // BPM-locked filter (if enabled): keep only candidates within ±5 BPM
    // of the seed track. Spotify's audio-features endpoint is deprecated
    // for new apps — if it 403s, we silently skip the filter.
    const settings = loadSettings();
    if (settings.bpmLocked) {
      const filtered = await applyBpmFilter(seedTrack, fresh);
      if (filtered && filtered.length > 0) {
        fresh = filtered;
      } else {
        console.log('[bpm] filter produced nothing — keeping unfiltered candidates');
      }
    }

    // Score each candidate. Composite signal:
    //   +15  if the artist appeared in your favored set (listened through before)
    //   +8   if it's a new-to-you artist (discovery bonus)
    //   +1.5 if it's NOT the seed artist (variety)
    //   +pop/20 (light popularity tilt)
    // Skipped-artist tracks are already vetoed above — no need to score them.
    const knownArtists = loadKnownArtists();
    const scored = fresh.map((t) => {
      const firstArtist = t.artists && t.artists[0];
      const aid = firstArtist && firstArtist.uri && firstArtist.uri.split(':').pop();
      const artistNames = (t.artists || []).map((a) => (a.name || '').toLowerCase());

      const isFavored = artistNames.some((n) => favoredArtists.has(n));
      const isNew = aid && !knownArtists.has(aid);
      const isSeedArtist = aid === seedArtistId;

      const score =
        (isFavored ? 15 : 0) +
        (isNew ? 8 : 0) +
        (t.popularity || 0) / 20 +
        (isSeedArtist ? 0 : 1.5);

      return { track: t, score, isFavored, isNew };
    }).sort((a, b) => b.score - a.score);

    const winner = scored[0];
    const aname = (winner.track.artists && winner.track.artists[0] && winner.track.artists[0].name) || '?';
    const tags = [
      winner.isFavored && 'favored',
      winner.isNew && 'new',
    ].filter(Boolean).join('+') || 'baseline';

    // Queue the winner via Spotify Connect — plays next in this session.
    // No playlist mutation. If the user likes it, they hit ♥ to save.
    try {
      await SpotifyAuth.api(
        `/me/player/queue?uri=${encodeURIComponent(winner.track.uri)}&device_id=${sdkDeviceId}`,
        { method: 'POST' }
      );
      console.log(`[discover] ▶ queued "${winner.track.name}" by ${aname} (${tags}, score ${winner.score.toFixed(1)})`);
    } catch (e) {
      console.warn('[discover] queue failed', e.message || e);
    }

    // Mark the seed artist as "known" — they've now been heard through.
    knownArtists.add(seedArtistId);
    saveKnownArtists(knownArtists);
  }

  async function applyBpmFilter(seedTrack, candidates) {
    const seedId = (seedTrack.uri || '').split(':').pop();
    if (!seedId) return null;
    let seedTempo = null;
    try {
      const feat = await SpotifyAuth.api(`/audio-features/${seedId}`);
      seedTempo = feat && feat.tempo;
    } catch (e) {
      console.warn('[bpm] seed tempo unavailable (audio-features may be deprecated for your app)', e.message || e);
      return null;
    }
    if (!seedTempo) return null;

    const ids = candidates
      .slice(0, 100)
      .map((c) => c.id || (c.uri || '').split(':').pop())
      .filter(Boolean);
    if (ids.length === 0) return null;

    let features;
    try {
      features = await SpotifyAuth.api(`/audio-features?ids=${ids.join(',')}`);
    } catch (e) {
      console.warn('[bpm] candidate tempos unavailable', e.message || e);
      return null;
    }
    const tempoById = {};
    (features && features.audio_features || []).forEach((f) => {
      if (f && f.id) tempoById[f.id] = f.tempo;
    });

    const winners = candidates.filter((c) => {
      const id = c.id || (c.uri || '').split(':').pop();
      const tempo = tempoById[id];
      if (tempo == null) return false;     // require known tempo for BPM-lock
      return Math.abs(tempo - seedTempo) <= 5;
    });
    console.log(`[bpm] seed ${seedTempo.toFixed(1)} bpm → ${winners.length}/${candidates.length} within ±5`);
    return winners;
  }

  async function onTrackSkipped(track) {
    const mix = findMix(activeId);

    // Local record only. The recommender's hard-veto uses this set so the
    // same artist won't surface as a discovery again. We DO NOT mutate any
    // Spotify playlist on skip — stations stay curated/static.
    skipped.push({
      ts: Date.now(),
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      stationId: activeId,
      stationTitle: mix ? mix.title : activeId,
    });
    saveSkipped();
    console.log(`[skip] recorded "${track.name}" by ${track.artist} (informs recommender; no Spotify mutation)`);
  }

  // ── Spotify Web Playback SDK ──
  // The SDK registers this browser as its own Spotify Connect device, so we
  // don't have to fight the desktop app for control. We become the device,
  // and Web API calls (play/pause/next/prev/load-context) hit it directly.
  window.onSpotifyWebPlaybackSDKReady = async () => {
    if (!SpotifyAuth.isAuthed()) {
      console.log('[sdk] not authed yet — will init after Connect');
      return;
    }
    initSpotifySdk();
  };

  async function initSpotifySdk() {
    if (sdkPlayer) return;
    if (typeof Spotify === 'undefined' || !Spotify.Player) {
      console.log('[sdk] SDK script not loaded yet');
      return;
    }
    console.log('[sdk] initializing player');

    sdkPlayer = new Spotify.Player({
      name: 'Mix Generator · Radio',
      getOAuthToken: async (cb) => {
        const tok = await SpotifyAuth.getAccessToken();
        cb(tok);
      },
      volume: 0.6,
    });

    sdkPlayer.addListener('initialization_error', ({ message }) =>
      console.error('[sdk] init error:', message));
    sdkPlayer.addListener('authentication_error', ({ message }) => {
      // IMPORTANT: don't clear tokens or open overlay here.
      // The SDK can fire authentication_error for reasons unrelated to the
      // Web API (e.g. Premium not detected, app missing Web Playback SDK
      // enabled in dev dashboard). Wiping tokens broke the heart + save
      // surfaces that ARE working. Just log; if the user needs to re-auth
      // they can double-click the hot corner.
      console.error('[sdk] auth error (not clearing tokens):', message);
    });
    sdkPlayer.addListener('account_error', ({ message }) => {
      // Premium not detected. Web Playback SDK won't work but everything
      // else (heart, save, playlist mutation) still does.
      console.error('[sdk] account error — Spotify Premium required for in-browser playback:', message);
    });
    sdkPlayer.addListener('playback_error', ({ message }) =>
      console.warn('[sdk] playback error:', message));

    sdkPlayer.addListener('ready', async ({ device_id }) => {
      console.log('[sdk] device ready:', device_id);
      sdkDeviceId = device_id;
      sdkReady = true;
      await transferToOurDevice(false);
    });

    sdkPlayer.addListener('not_ready', ({ device_id }) => {
      console.log('[sdk] device went offline:', device_id);
      sdkReady = false;
    });

    sdkPlayer.addListener('player_state_changed', async (state) => {
      if (!state) return;
      const { paused, position, duration, track_window } = state;

      // ─── STATION-SWITCH GATE ────────────────────────────────────────
      // After setStation(), the SDK keeps reporting the OLD context's
      // track for a moment. Ignore those events so we don't render the
      // previous station's music under the new nameplate. Clear the gate
      // as soon as we see a state from the expected new context.
      if (stationSwitching) {
        const ctxUri = state.context && state.context.uri;
        if (ctxUri && switchingToUri && ctxUri === switchingToUri) {
          console.log('[switch] new context arrived:', ctxUri);
          stationSwitching = false;
          switchingToUri = null;
        } else {
          // Still on the previous context — ignore this update
          return;
        }
      }

      // ─── AUTO-SKIP BLACKLIST ────────────────────────────────────────
      // Before we render anything, check if this track is one Phil has
      // skipped before (or is by a disfavored artist). If so, jump to the
      // next track immediately. The user never hears blacklisted tracks
      // again — no Spotify mutation needed.
      const t = track_window && track_window.current_track;
      if (t && shouldAutoSkip(t)) {
        const skippedAlreadyCount = autoSkipCounter[t.uri] || 0;
        if (skippedAlreadyCount < MAX_AUTO_SKIPS_PER_TRACK) {
          autoSkipCounter[t.uri] = skippedAlreadyCount + 1;
          autoSkipInProgress = true;
          autoSkipsInARow++;
          console.log(`[auto-skip] ⏭ "${t.name}" by ${t.artist} — blacklisted`);
          if (autoSkipsInARow > MAX_AUTO_SKIPS_IN_A_ROW) {
            console.warn(`[auto-skip] ${MAX_AUTO_SKIPS_IN_A_ROW} skips in a row — pausing auto-skip to avoid loop`);
            autoSkipInProgress = false;
            // fall through and play this track
          } else {
            try { await sdkPlayer.nextTrack(); } catch (e) { console.warn('[auto-skip] nextTrack failed', e); }
            return;
          }
        }
      } else if (t) {
        // Reset the in-a-row counter once we land on a non-skipped track
        autoSkipsInARow = 0;
        autoSkipInProgress = false;
      }

      const playing = !paused;
      if (playing !== isPlaying) setPlayingVisual(playing);

      if (duration > 0) {
        const pct = Math.max(0, Math.min(100, (position / duration) * 100));
        els.cardProgress.style.width = pct + '%';
      }

      if (t) {
        const cur = {
          uri: t.uri,
          id: t.id,
          name: t.name,
          artist: (t.artists || []).map((a) => a.name).join(', '),
          artUrl: (t.album && t.album.images && t.album.images[0] && t.album.images[0].url) || null,
          durationMs: duration,
          progressMs: position,
        };

        // Listen-through / skip detection on URI change. Auto-skip
        // transitions are filtered out — they're machine actions, not
        // user reactions, so they shouldn't pollute the skipped/liked lists.
        if (lastSeenTrack && lastSeenTrack.uri !== cur.uri) {
          if (autoSkipInProgress) {
            console.log(`[transition] suppressed (auto-skip in progress)`);
            autoSkipInProgress = false;
          } else {
            const ratio = lastSeenTrack.durationMs > 0
              ? lastSeenTrack.progressMs / lastSeenTrack.durationMs : 0;
            const verdict = ratio >= 0.85 ? 'LISTEN-THROUGH' : 'SKIP';
            console.log(
              `[transition] "${lastSeenTrack.name}" by ${lastSeenTrack.artist}` +
              ` · ${(ratio * 100).toFixed(0)}% played → ${verdict}`
            );
            if (ratio >= 0.85) onTrackListenedThrough(lastSeenTrack);
            else onTrackSkipped(lastSeenTrack);
          }
        }
        lastSeenTrack = cur;
        renderTrackOnCard(cur);
      }
    });

    const connected = await sdkPlayer.connect();
    console.log('[sdk] connect:', connected ? 'ok' : 'failed');
  }

  async function transferToOurDevice(autoplay) {
    if (!sdkDeviceId) return;
    try {
      await SpotifyAuth.api('/me/player', {
        method: 'PUT',
        body: JSON.stringify({ device_ids: [sdkDeviceId], play: !!autoplay }),
      });
      console.log('[sdk] transferred playback to our device');
    } catch (e) {
      console.warn('[sdk] transfer failed', e);
    }
  }

  async function togglePlay() {
    if (actionLocked('play')) return;
    flashButton(els.ctrlPlay);
    // Empty-URI station — gently nudge into the DJ
    const activeMix = findMix(activeId);
    if (activeMix && !activeMix.spotifyUri) {
      openDj();
      els.djInput.value = `Set up "${activeMix.title}" — ${activeMix.subtitle}`;
      return;
    }
    if (!sdkReady || !sdkPlayer) {
      // No SDK yet — kick off auth flow if not authed
      if (!SpotifyAuth.isAuthed()) {
        openOverlay('connect');
        return;
      }
      console.log('[player] SDK not ready yet');
      return;
    }
    const target = !isPlaying;
    setPlayingVisual(target);

    try {
      // If nothing has been queued yet, load the active station's playlist first.
      const state = await sdkPlayer.getCurrentState();
      if (!state || !state.track_window || !state.track_window.current_track) {
        const mix = findMix(activeId);
        if (mix && mix.spotifyUri) await playStation(mix);
        return;
      }
      await sdkPlayer.togglePlay();
    } catch (e) {
      setPlayingVisual(!target);
      console.warn('togglePlay failed', e);
    }
  }

  async function playStation(mix) {
    if (!sdkDeviceId) return;
    try {
      // Find the most-recently-added track so playback starts fresh — fixes
      // the "same songs in the same order" complaint by dropping in at
      // whatever was most recently added (DJ adds, replenishments, listen-
      // through saves all surface here) instead of always at track #1.
      const newestUri = await findNewestTrackUri(mix.spotifyUri);

      const body = { context_uri: mix.spotifyUri, position_ms: 0 };
      if (newestUri) body.offset = { uri: newestUri };

      await SpotifyAuth.api(`/me/player/play?device_id=${sdkDeviceId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      console.log('[player] context play:', mix.title, newestUri ? '(starting at newest add)' : '');

      // Enable shuffle so the rest of the playlist isn't played in stored
      // order. Different walk through the catalogue each session.
      try {
        await SpotifyAuth.api(`/me/player/shuffle?state=true&device_id=${sdkDeviceId}`, {
          method: 'PUT',
        });
        console.log('[player] shuffle: on');
      } catch (e) {
        console.warn('[player] shuffle toggle failed', e.message || e);
      }
    } catch (e) {
      console.warn('playStation failed', e);
    }
  }

  // Most-recently-added track URI in a playlist
  async function findNewestTrackUri(spotifyUri) {
    const pid = playlistIdFromUri(spotifyUri);
    if (!pid) return null;
    try {
      const resp = await SpotifyAuth.api(
        `/playlists/${pid}/tracks?fields=items(added_at,track(uri))&limit=50`
      );
      if (!resp || !resp.items || resp.items.length === 0) return null;
      const sorted = resp.items
        .filter((i) => i && i.added_at && i.track && i.track.uri)
        .sort((a, b) => b.added_at.localeCompare(a.added_at));
      return sorted.length > 0 ? sorted[0].track.uri : null;
    } catch (e) {
      console.warn('[player] findNewestTrackUri failed', e.message || e);
      return null;
    }
  }

  // Next/Prev via Web API (requires OAuth)
  function optimisticTrackChangeUi() {
    // Immediately blank the metadata so the user sees the click registered.
    // pollSoon() will fill in the new track within ~250ms.
    els.cardProgress.style.width = '0%';
    els.cardArt.classList.add('--swapping');
    els.cardTitle.classList.add('--swapping');
    els.cardArtist.classList.add('--swapping');
    setTimeout(() => {
      els.cardArt.classList.remove('--swapping');
      els.cardTitle.classList.remove('--swapping');
      els.cardArtist.classList.remove('--swapping');
    }, 700);
  }

  async function skipNext() {
    if (actionLocked('next')) return;
    flashButton(els.ctrlNext);
    if (!sdkReady || !sdkPlayer) { flashUnavailable(els.ctrlNext); return; }
    optimisticTrackChangeUi();
    try { await sdkPlayer.nextTrack(); }
    catch (e) { console.warn('skip next failed', e); flashUnavailable(els.ctrlNext); }
  }

  async function skipPrev() {
    if (actionLocked('prev')) return;
    flashButton(els.ctrlPrev);
    if (!sdkReady || !sdkPlayer) { flashUnavailable(els.ctrlPrev); return; }
    optimisticTrackChangeUi();
    try { await sdkPlayer.previousTrack(); }
    catch (e) { console.warn('skip prev failed', e); flashUnavailable(els.ctrlPrev); }
  }

  function flashUnavailable(btn) {
    btn.animate(
      [{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
      { duration: 400, easing: 'ease-out' }
    );
    btn.title = 'Connect Spotify (hot corner) to enable skip';
    setTimeout(() => { btn.title = ''; }, 2000);
  }

  // ── Station switching ──
  async function setStation(id, opts = {}) {
    const mix = findMix(id);
    if (!mix || id === activeId) return;

    activeId = id;
    lastSeenTrack = null;
    currentTrack = null;
    stationSwitching = true;
    switchingToUri = mix.spotifyUri || null;

    renderStation(mix);

    // Blank the card text + art until the new context's first track arrives.
    // Spotify's SDK lags 200-800ms behind the play API call, so leaving the
    // old text in place causes "BAROQUE CHAMBERS playing Trance Wax".
    els.cardProgress.style.width = '0%';
    els.cardArt.classList.add('--swapping');
    els.cardArt.classList.remove('--has-art');
    els.cardArt.style.backgroundImage = '';
    els.cardTitle.textContent = 'Loading…';
    els.cardArtist.textContent = mix.title;
    els.cardTitle.classList.add('--swapping');
    els.cardArtist.classList.add('--swapping');
    setPlayingVisual(true);

    if (sdkReady && mix.spotifyUri) {
      await playStation(mix);
    } else if (!SpotifyAuth.isAuthed()) {
      openOverlay('connect');
    }

    setTimeout(() => {
      els.cardArt.classList.remove('--swapping');
      els.cardTitle.classList.remove('--swapping');
      els.cardArtist.classList.remove('--swapping');
    }, 1200);
  }


  function cycleStation(dir = 1) {
    const idx = data.playlists.findIndex((p) => p.id === activeId);
    if (idx < 0) return;
    const len = data.playlists.length;
    const next = data.playlists[(idx + dir + len) % len];
    setStation(next.id);
  }

  // ── Overlay ──
  function openOverlay(kind) {
    if (kind === 'liked') renderLikedOverlay();
    else if (kind === 'connect') renderConnectOverlay();
    else if (kind === 'settings') renderSettingsOverlay();
    else if (kind === 'wizard') renderWizardStep(getOnboardingStep());
    else if (kind === 'diagnostic') renderDiagnosticOverlay();
    els.overlay.hidden = false;
  }
  function closeOverlay() { els.overlay.hidden = true; }

  // ── Auth result feedback (visible after each OAuth round-trip) ──
  function showAuthSuccess() {
    showAuthToast('✓ Spotify connected. All scopes granted.', 'success');
  }
  function showScopeMismatch(missing, fullScope) {
    showAuthToast(
      `⚠ Spotify granted partial access. Missing: ${missing.join(', ')}. ` +
      `Revoke the app at spotify.com/account/apps and try again.`,
      'error'
    );
    console.error('[auth] MISSING SCOPES:', missing.join(', '));
    console.error('[auth] Granted scopes:', fullScope);
  }
  function showAuthToast(message, kind) {
    let el = document.getElementById('auth-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'auth-toast';
      el.style.cssText = `
        position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
        max-width: 540px; padding: 14px 20px; border-radius: 8px;
        font-family: var(--font-sans); font-size: 13px; font-weight: 500;
        line-height: 1.5; z-index: 500; cursor: pointer;
        animation: card-in 0.35s cubic-bezier(0.2, 1, 0.3, 1);
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      `;
      document.body.appendChild(el);
    }
    el.style.background = kind === 'success' ? '#eafce8' : '#fce8e8';
    el.style.color = kind === 'success' ? '#1d5a26' : '#7a1d1d';
    el.style.border = kind === 'success' ? '1px solid #79c98c' : '2px solid #c44d4d';
    el.textContent = message;
    el.title = 'Click to dismiss';
    el.onclick = () => el.remove();
    if (kind === 'success') setTimeout(() => el.remove(), 4000);
  }

  // ── Onboarding wizard ──
  function isOnboarded() { return localStorage.getItem(LS_ONBOARDED) === 'true'; }
  function markOnboarded() {
    localStorage.setItem(LS_ONBOARDED, 'true');
    localStorage.removeItem(LS_ONBOARDING_STEP);
  }
  function getOnboardingStep() {
    return Math.max(0, Math.min(3, parseInt(localStorage.getItem(LS_ONBOARDING_STEP) || '0', 10)));
  }
  function setOnboardingStep(n) {
    localStorage.setItem(LS_ONBOARDING_STEP, String(n));
    renderWizardStep(n);
  }
  function maybeAutoCompleteOnboarding() {
    // If you've already got auth + at least one station with a URI, you don't
    // need onboarding — skip silently.
    if (isOnboarded()) return true;
    const hasAuth = window.SpotifyAuth && SpotifyAuth.isAuthed();
    const hasStation = data.playlists.some((p) => p && p.spotifyUri);
    if (hasAuth && hasStation) {
      markOnboarded();
      return true;
    }
    return false;
  }

  function wizardProgress(activeIdx) {
    const dots = [0, 1, 2, 3].map((i) => {
      const cls = i === activeIdx ? 'wizard-progress__dot --active'
        : (i < activeIdx ? 'wizard-progress__dot --done' : 'wizard-progress__dot');
      return `<span class="${cls}"></span>`;
    }).join('');
    return `<div class="wizard-progress">${dots}</div>`;
  }

  function renderWizardStep(n) {
    if (n === 0) renderWizardWelcome();
    else if (n === 1) renderWizardSpotifyApp();
    else if (n === 2) renderWizardAuthorize();
    else renderWizardDone();
  }

  function renderWizardWelcome() {
    els.overlayKicker.textContent = 'Step 1 of 4 · Welcome';
    els.overlayTitle.textContent = 'Welcome to Mix Generator';
    els.overlayBody.innerHTML = `
      ${wizardProgress(0)}
      <div class="wizard-body">
        <p>A personal radio that adapts to your taste. Three ambient rooms, a custom Spotify player, and an AI DJ behind <kbd>⌘K</kbd>.</p>
        <p><strong>What you'll need:</strong></p>
        <ul class="checklist">
          <li><span class="checklist__check">◐</span><span><strong>Spotify Premium</strong> — the audio engine needs it (Free won't work)</span></li>
          <li><span class="checklist__check">◐</span><span>A <strong>free Spotify Developer App</strong> — used as the OAuth bridge between this page and your library</span></li>
          <li><span class="checklist__check">◐</span><span>About <strong>3 minutes</strong></span></li>
        </ul>
        <p>The next three steps will walk you through it.</p>
      </div>
    `;
    els.overlayActions.innerHTML = '';
    const skip = document.createElement('button');
    skip.className = '--ghost';
    skip.textContent = 'Skip setup';
    skip.addEventListener('click', () => {
      markOnboarded();
      closeOverlay();
    });
    els.overlayActions.appendChild(skip);
    const next = document.createElement('button');
    next.className = '--primary';
    next.textContent = 'Get started →';
    next.addEventListener('click', () => setOnboardingStep(1));
    els.overlayActions.appendChild(next);
  }

  function renderWizardSpotifyApp() {
    const redirect = SpotifyAuth.REDIRECT_URI;
    els.overlayKicker.textContent = 'Step 2 of 4 · Spotify Developer App';
    els.overlayTitle.textContent = 'Create your Spotify App';
    els.overlayBody.innerHTML = `
      ${wizardProgress(1)}
      <div class="wizard-body">
        <p>This is a one-time setup. Spotify requires a "Developer App" to authorize a personal client like Mix Generator. It's free and takes ~90 seconds.</p>
        <ol>
          <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> in another tab</li>
          <li>Click <strong>Create app</strong> — any name and description</li>
          <li>Under "Which API/SDKs are you planning to use?" pick <strong>Web API</strong> and <strong>Web Playback SDK</strong></li>
          <li>Add this redirect URI <em>exactly</em>:
            <div class="copy-row">
              <code>${escapeHtml(redirect)}</code>
              <button type="button" class="copy-btn" data-copy="${escapeHtml(redirect)}">Copy</button>
            </div>
          </li>
          <li>Save the app, then copy your <strong>Client ID</strong> from its settings page</li>
        </ol>
        <div class="callout">
          ⚠ The redirect URI uses <strong>127.0.0.1</strong>, not <strong>localhost</strong> — Spotify rejects <code>localhost</code> as a loopback redirect.
        </div>
      </div>
    `;
    // Wire copy button
    els.overlayBody.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          btn.textContent = 'Copied ✓';
          btn.classList.add('--copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('--copied'); }, 1500);
        } catch (e) { console.warn('copy failed', e); }
      });
    });
    els.overlayActions.innerHTML = '';
    const back = document.createElement('button');
    back.className = '--ghost';
    back.textContent = '← Back';
    back.addEventListener('click', () => setOnboardingStep(0));
    els.overlayActions.appendChild(back);
    const next = document.createElement('button');
    next.className = '--primary';
    next.textContent = 'I have my Client ID →';
    next.addEventListener('click', () => setOnboardingStep(2));
    els.overlayActions.appendChild(next);
  }

  function renderWizardAuthorize() {
    const existingId = SpotifyAuth.getClientId();
    els.overlayKicker.textContent = 'Step 3 of 4 · Authorize';
    els.overlayTitle.textContent = 'Paste your Client ID';
    els.overlayBody.innerHTML = `
      ${wizardProgress(2)}
      <div class="wizard-body">
        <p>Paste the Client ID from your Spotify Developer App below. Clicking Authorize redirects you to Spotify's consent page — approve the requested permissions and you'll come right back here.</p>
        <div class="field-row">
          <label class="field-label" for="wizard-client-id">Spotify Client ID</label>
          <input type="text" id="wizard-client-id" placeholder="e.g. 7a1c8b9e..." value="${escapeHtml(existingId || '')}" autocomplete="off" />
        </div>
        ${existingId ? `<div class="callout">If Spotify silently skips the consent screen (it remembers prior approvals), <a href="https://www.spotify.com/account/apps/" target="_blank" rel="noopener">remove the app at spotify.com/account/apps</a> first, then click Authorize.</div>` : ''}
      </div>
    `;
    els.overlayActions.innerHTML = '';
    const back = document.createElement('button');
    back.className = '--ghost';
    back.textContent = '← Back';
    back.addEventListener('click', () => setOnboardingStep(1));
    els.overlayActions.appendChild(back);
    const authBtn = document.createElement('button');
    authBtn.className = '--primary';
    authBtn.textContent = 'Authorize ↗';
    authBtn.addEventListener('click', async () => {
      const input = document.getElementById('wizard-client-id');
      const id = (input.value || '').trim();
      if (!id) { input.focus(); return; }
      authBtn.textContent = 'Redirecting…';
      authBtn.disabled = true;
      try {
        await SpotifyAuth.startAuth(id);
      } catch (e) {
        authBtn.textContent = 'Failed — retry';
        authBtn.disabled = false;
        console.error(e);
      }
    });
    els.overlayActions.appendChild(authBtn);
  }

  function renderWizardDone() {
    const authed = SpotifyAuth.isAuthed();
    els.overlayKicker.textContent = 'Step 4 of 4 · Ready';
    els.overlayTitle.textContent = authed ? "You're set up" : 'Almost there';
    els.overlayBody.innerHTML = `
      ${wizardProgress(3)}
      <div class="wizard-body">
        ${authed
          ? `<p>Spotify is connected. Your Connect device <strong>"Mix Generator · Radio"</strong> should appear in any Spotify app you have open.</p>`
          : `<p>Looks like the Spotify connection didn't finish. You can press <strong>Back</strong> and try again — or close this and use the <strong>⌖</strong> in the corner whenever you're ready.</p>`
        }
        <p style="margin-top: 16px;"><strong>Three things to remember:</strong></p>
        <div class="shortcut-grid">
          <kbd>⌘K</kbd><span>Open the DJ — ask for "a station for…", "add more X", "remove the Y"</span>
          <kbd>⚙</kbd><span>Settings — bridge tracks, BPM lock, album-art tint</span>
          <kbd>⌖</kbd><span>Liked Radio Songs panel — also where you'd re-authorize</span>
        </div>
        <p>Stations need playlists — press <kbd>⌘K</kbd> after this and the DJ will set them up.</p>
        <div class="callout">
          <strong>Pro tip:</strong> Edit <code>data.js</code> by hand with your own existing playlist URIs if you'd rather not generate fresh ones. The DJ enhances any playlist over time.
        </div>
      </div>
    `;
    els.overlayActions.innerHTML = '';
    if (!authed) {
      const back = document.createElement('button');
      back.className = '--ghost';
      back.textContent = '← Back';
      back.addEventListener('click', () => setOnboardingStep(2));
      els.overlayActions.appendChild(back);
    }
    const done = document.createElement('button');
    done.className = '--primary';
    done.textContent = authed ? 'Start listening →' : 'Close';
    done.addEventListener('click', () => {
      markOnboarded();
      closeOverlay();
    });
    els.overlayActions.appendChild(done);
  }

  function renderLikedOverlay() {
    const authed = SpotifyAuth.isAuthed();
    els.overlayKicker.textContent = authed
      ? `+${liked.length} added · −${skipped.length} removed this session`
      : `Saved this session · ${liked.length}`;
    els.overlayTitle.textContent = 'Liked Radio Songs';
    let html = '';
    if (liked.length === 0) {
      html = `<p>No saves yet. Songs you let play all the way through (no skip) get filed here automatically.</p>`;
    } else if (authed) {
      html = `<p style="font-size: 12px; opacity: 0.7;">Listened-through tracks save to your Spotify <strong>Liked Songs</strong> library + the <strong>Liked Radio Songs</strong> playlist.</p>`;
      html += `<ul class="saved-list">`;
      liked.slice().reverse().forEach((l) => {
        html += `<li>
          <span><strong>${escapeHtml(l.name || '—')}</strong> · ${escapeHtml(l.artist || '')}</span>
          <span class="station">+ ${escapeHtml(l.stationTitle || l.stationId)}</span>
        </li>`;
      });
      html += '</ul>';
      if (skipped.length > 0) {
        html += `<p style="margin-top: 18px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.2em; opacity: 0.6;">Recently skipped (informs discovery)</p>`;
        html += `<ul class="saved-list">`;
        skipped.slice().reverse().slice(0, 20).forEach((s) => {
          html += `<li>
            <span style="opacity:0.65">${escapeHtml(s.name || '—')} · ${escapeHtml(s.artist || '')}</span>
            <span class="station">− ${escapeHtml(s.stationTitle || s.stationId)}</span>
          </li>`;
        });
        html += '</ul>';
      }
    } else {
      const byStation = {};
      liked.forEach((l) => {
        const k = l.stationTitle || l.stationId;
        byStation[k] = (byStation[k] || 0) + 1;
      });
      html = `<p>Counts by station (titles hidden without Spotify auth):</p><ul>`;
      Object.entries(byStation).forEach(([s, n]) => {
        html += `<li><span><strong>${escapeHtml(s)}</strong></span><span class="station">${n} track${n === 1 ? '' : 's'}</span></li>`;
      });
      html += '</ul>';
    }
    els.overlayBody.innerHTML = html;

    els.overlayActions.innerHTML = '';
    if (!authed) {
      const c = document.createElement('button');
      c.className = '--primary';
      c.textContent = 'Set up auto-save';
      c.addEventListener('click', () => { closeOverlay(); openOverlay('connect'); });
      els.overlayActions.appendChild(c);
    } else {
      if (liked.length > 0) {
        const saveBtn = document.createElement('button');
        saveBtn.className = '--primary';
        saveBtn.textContent = `Save ${liked.length} to new playlist`;
        saveBtn.title = 'Uses Claude\'s Spotify MCP — bypasses your dev app entirely';
        saveBtn.addEventListener('click', () => {
          closeOverlay();
          openDj();
          els.djInput.value = `save my session — create a new playlist with my recent ${liked.length} listen-throughs`;
          submitDj();
        });
        els.overlayActions.appendChild(saveBtn);
      }
      const close = document.createElement('button');
      close.className = '--ghost';
      close.textContent = 'Close';
      close.addEventListener('click', closeOverlay);
      els.overlayActions.appendChild(close);
    }
  }

  // ── Diagnostic tool — runs all the API calls we depend on and reports each result ──
  async function renderDiagnosticOverlay() {
    els.overlayKicker.textContent = 'Diagnostic';
    els.overlayTitle.textContent = 'Spotify API Health Check';
    els.overlayBody.innerHTML = `
      <div class="wizard-body">
        <p>Running tests against your Spotify tokens + dev app config…</p>
        <div id="diag-results" style="font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.7; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.04); border: 1px solid rgba(10,7,6,0.15);">
          <div>Initializing…</div>
        </div>
      </div>
    `;
    els.overlayActions.innerHTML = '';
    const close = document.createElement('button');
    close.className = '--primary';
    close.textContent = 'Close';
    close.addEventListener('click', closeOverlay);
    els.overlayActions.appendChild(close);

    const out = document.getElementById('diag-results');
    out.innerHTML = '';
    const log = (msg, ok = null) => {
      const color = ok === true ? '#1d5a26' : ok === false ? '#7a1d1d' : 'inherit';
      const icon = ok === true ? '✓' : ok === false ? '✗' : '·';
      out.insertAdjacentHTML('beforeend', `<div style="color:${color}">${icon} ${msg}</div>`);
    };

    // 1. Auth state
    if (!SpotifyAuth.isAuthed()) {
      log('Not authenticated — connect Spotify first', false);
      return;
    }
    log('Authenticated', true);

    // 2. Token + scopes
    let token;
    try {
      token = await SpotifyAuth.getAccessToken();
      if (!token) { log('No valid access token (refresh failed)', false); return; }
      log(`Access token: ${token.slice(0, 8)}…${token.slice(-4)} (length: ${token.length})`, true);
    } catch (e) {
      log(`Token fetch failed: ${e.message || e}`, false);
      return;
    }
    const stored = JSON.parse(localStorage.getItem('mixgen.spotify.tokens') || 'null');
    if (stored && stored.scope) {
      log(`Granted scopes:`, true);
      stored.scope.split(' ').forEach((s) => log(`&nbsp;&nbsp;${s}`, true));
    }

    // Helper to run an API call and log the result
    async function testApi(label, path, options = {}) {
      try {
        const res = await fetch(`https://api.spotify.com/v1${path}`, {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
          },
        });
        const text = await res.text();
        if (res.ok) {
          log(`${label} → ${res.status} OK`, true);
          return true;
        } else {
          const detail = text.slice(0, 200).replace(/\n/g, ' ');
          log(`${label} → ${res.status} ${detail}`, false);
          return false;
        }
      } catch (e) {
        log(`${label} → network error: ${e.message || e}`, false);
        return false;
      }
    }

    // 3. Get current user (basic identity check) — show the actual account
    //    email so the user can compare with their dev-app User Management
    try {
      const meRes = await fetch(`https://api.spotify.com/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json();
        log(`GET /me → 200 OK`, true);
        log(`&nbsp;&nbsp;display_name: <strong>${escapeHtml(me.display_name || '?')}</strong>`, true);
        log(`&nbsp;&nbsp;email: <strong>${escapeHtml(me.email || '?')}</strong>  ← this must match a User Management entry`, true);
        log(`&nbsp;&nbsp;product: <strong>${escapeHtml(me.product || '?')}</strong> (must be 'premium' for SDK)`, true);
        log(`&nbsp;&nbsp;country: ${escapeHtml(me.country || '?')}`, true);
        log(`&nbsp;&nbsp;id: ${escapeHtml(me.id || '?')}`, true);
      } else {
        const text = await meRes.text();
        log(`GET /me → ${meRes.status} ${text.slice(0, 200)}`, false);
      }
    } catch (e) {
      log(`GET /me → network error: ${e.message || e}`, false);
    }

    // Also show the configured Client ID for cross-checking with the dev dashboard
    const clientId = SpotifyAuth.getClientId();
    if (clientId) {
      log(`Client ID in use: <strong>${escapeHtml(clientId)}</strong>`, true);
      log(`&nbsp;&nbsp;→ must match the app you added yourself to in dev dashboard's Users and Access`, true);
    }

    // 4. Read library (user-library-read)
    const sampleTrackId = (currentTrack && currentTrack.id)
      || '11dFghVXANMlKmJXsNCbNl'; // fallback: a stable Spotify track for tests
    await testApi(`GET /me/tracks/contains (user-library-read)`, `/me/tracks/contains?ids=${sampleTrackId}`);

    // 5. Write library (user-library-modify) — save then unsave so we don't leave junk
    const writeOk = await testApi(`PUT /me/tracks (user-library-modify)`, `/me/tracks?ids=${sampleTrackId}`, { method: 'PUT' });
    if (writeOk) {
      await testApi(`DELETE /me/tracks (cleanup)`, `/me/tracks?ids=${sampleTrackId}`, { method: 'DELETE' });
    }

    // 6. Read user's playlists (playlist-read-private)
    await testApi('GET /me/playlists (playlist-read-private)', '/me/playlists?limit=1');

    // 7. Player state (user-read-playback-state)
    await testApi('GET /me/player (user-read-playback-state)', '/me/player');

    // 8. Active station playlist read (playlist-read-private)
    const mix = findMix(activeId);
    if (mix && mix.spotifyUri) {
      const pid = playlistIdFromUri(mix.spotifyUri);
      await testApi(`GET /playlists/${pid} (current station)`, `/playlists/${pid}`);
    }

    log('—');
    log('Done. Any ✗ red lines show exactly what\'s broken.');
    log('');
    log('"Insufficient client scope" with green-✓ scope toast = User Management allowlist issue:');
    log('  1. developer.spotify.com/dashboard → your app');
    log('  2. "Users and Access" section');
    log('  3. Add your Spotify email');
    log('  4. (No reauth needed — write calls start working immediately)');
  }

  function renderSettingsOverlay() {
    const s = loadSettings();
    els.overlayKicker.textContent = 'Configuration';
    els.overlayTitle.textContent = 'Radio Settings';
    els.overlayBody.innerHTML = `
      <div class="settings-list">
        <label class="settings-row">
          <input type="checkbox" id="setting-bpm" ${s.bpmLocked ? 'checked' : ''} />
          <div class="settings-row__text">
            <div class="settings-row__title">BPM-locked replenishment</div>
            <div class="settings-row__desc">Auto-added tracks stay within ±5 BPM of the seed track. Keeps sets continuous — but depends on Spotify's audio-features API, which is rate-limited for new apps and may silently fall back to no-filter.</div>
          </div>
        </label>
        <label class="settings-row">
          <input type="checkbox" id="setting-tint" ${s.albumArtTint ? 'checked' : ''} />
          <div class="settings-row__text">
            <div class="settings-row__title">Album-art tinted room</div>
            <div class="settings-row__desc">Bleed the current track's album-cover dominant color into the scene as a soft overlay. Crossfades when tracks change.</div>
          </div>
        </label>
      </div>
    `;
    // Bottom-of-settings links
    const links = document.createElement('p');
    links.style.cssText = 'margin-top: 18px; font-size: 12px; opacity: 0.7; display: flex; gap: 14px; flex-wrap: wrap;';
    links.innerHTML = `
      <a href="#" id="replay-onboarding" style="color: var(--ink); text-decoration: underline;">Replay welcome tour</a>
      <a href="#" id="run-diagnostic" style="color: var(--vinyl-red); text-decoration: underline; font-weight: 600;">Run Spotify diagnostic →</a>
    `;
    els.overlayBody.appendChild(links);
    document.getElementById('replay-onboarding').addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem(LS_ONBOARDED);
      localStorage.setItem(LS_ONBOARDING_STEP, '0');
      openOverlay('wizard');
    });
    document.getElementById('run-diagnostic').addEventListener('click', (e) => {
      e.preventDefault();
      openOverlay('diagnostic');
    });

    els.overlayActions.innerHTML = '';
    const saveBtn = document.createElement('button');
    saveBtn.className = '--primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      saveSettings({
        bpmLocked: document.getElementById('setting-bpm').checked,
        albumArtTint: document.getElementById('setting-tint').checked,
      });
      if (!document.getElementById('setting-tint').checked) {
        els.artTint.style.backgroundColor = 'transparent';
      } else if (currentTrack) {
        updateArtTint(currentTrack);
      }
      closeOverlay();
    });
    els.overlayActions.appendChild(saveBtn);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = '--ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeOverlay);
    els.overlayActions.appendChild(cancelBtn);
  }

  function renderConnectOverlay() {
    els.overlayKicker.textContent = 'One-time setup';
    els.overlayTitle.textContent = 'Spotify auto-save';
    const redirect = SpotifyAuth.REDIRECT_URI;
    const existingId = SpotifyAuth.getClientId();
    const onLocalhost = window.location.hostname === 'localhost';

    let html = `<p>Connects your personal Spotify Developer App so the radio can save listened-through tracks to your <strong>Spotify Liked Songs</strong> library and queue discovery tracks.</p>`;
    if (existingId) {
      html += `<div style="margin-top: 12px; padding: 12px 14px; border: 2px solid var(--vinyl-red); background: rgba(196, 59, 74, 0.08); font-size: 13px; line-height: 1.55;">
        <strong style="color: var(--vinyl-red); display: block; margin-bottom: 6px;">⚠ Reauthorizing?</strong>
        Spotify silently re-grants the SAME scopes you approved before — even when this app asks for new ones. If saving to Liked Songs fails:
        <ol style="margin: 8px 0 4px 18px; padding: 0;">
          <li>Open <a href="https://www.spotify.com/account/apps/" target="_blank" rel="noopener" style="color: var(--vinyl-red); font-weight: 700;">spotify.com/account/apps</a></li>
          <li>Find <strong>the app you connected</strong> — its name will match the title shown on Spotify's consent screen (could be "Mix Generator", "Shuffler", or anything you set in the dev dashboard) → click <strong>Remove access</strong></li>
          <li>Come back and click Authorize below — you'll see the FULL consent screen with all current scopes</li>
        </ol>
      </div>`;
    }
    if (onLocalhost) {
      html += `<p style="margin-top: 10px; padding: 10px 12px; border: 1px dashed var(--ink); font-size: 12px;">⚠ Open this page at <code>http://127.0.0.1:8765/</code> instead of <code>localhost</code> — Spotify rejects <code>localhost</code> as a redirect URI.</p>`;
    }
    html += `
      <ol>
        <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> → <strong>Create app</strong>.</li>
        <li>Pick <strong>Web API</strong>. Any name + description.</li>
        <li>Add redirect URI exactly:<br><code style="word-break: break-all;">${escapeHtml(redirect)}</code></li>
        <li>Save the app, copy the <strong>Client ID</strong>.</li>
        <li>Paste it below and click <strong>Authorize</strong>.</li>
      </ol>
      <div class="field-row">
        <label class="field-label" for="client-id-input">Spotify Client ID</label>
        <input type="text" id="client-id-input" placeholder="e.g. 7a1c8b9e..." value="${escapeHtml(existingId || '')}" autocomplete="off" />
      </div>
    `;
    els.overlayBody.innerHTML = html;

    els.overlayActions.innerHTML = '';
    const authBtn = document.createElement('button');
    authBtn.className = '--primary';
    authBtn.textContent = 'Authorize ↗';
    authBtn.addEventListener('click', async () => {
      const input = document.getElementById('client-id-input');
      const id = (input.value || '').trim();
      if (!id) { input.focus(); return; }
      authBtn.textContent = 'Redirecting…';
      authBtn.disabled = true;
      try { await SpotifyAuth.startAuth(id); }
      catch (e) {
        authBtn.textContent = 'Failed — retry';
        authBtn.disabled = false;
        console.error(e);
      }
    });
    els.overlayActions.appendChild(authBtn);

    const cancel = document.createElement('button');
    cancel.className = '--ghost';
    cancel.textContent = 'Later';
    cancel.addEventListener('click', closeOverlay);
    els.overlayActions.appendChild(cancel);
  }

  // ── Event wiring ──
  els.ctrlPlay.addEventListener('click', togglePlay);
  els.ctrlNext.addEventListener('click', skipNext);
  els.ctrlPrev.addEventListener('click', skipPrev);
  els.stationPrev.addEventListener('click', () => cycleStation(-1));
  els.stationNext.addEventListener('click', () => cycleStation(1));
  els.connectPrompt.addEventListener('click', () => openOverlay('connect'));

  els.hotcorner.addEventListener('click', () => {
    if (SpotifyAuth.isAuthed()) openOverlay('liked');
    else openOverlay('connect');
  });
  els.hotcorner.addEventListener('dblclick', () => openOverlay('connect'));
  els.gear.addEventListener('click', () => openOverlay('settings'));

  els.overlayClose.addEventListener('click', closeOverlay);
  els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) closeOverlay(); });

  window.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl+K toggles the DJ request modal (works from anywhere, even inputs)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (els.dj.hidden) openDj(); else closeDj();
      return;
    }
    // Hardware media-style keys — works whether or not the OS routes the
    // F-keys as media keys (the MediaSession handlers below cover the
    // hardware-media-key path; this covers the literal F7/F8/F9 keydowns).
    if (e.key === 'F7' || e.code === 'F7') { e.preventDefault(); skipPrev(); return; }
    if (e.key === 'F8' || e.code === 'F8') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'F9' || e.code === 'F9') { e.preventDefault(); skipNext(); return; }
    // When DJ modal is open, only handle Escape (let the input receive everything else)
    if (!els.dj.hidden) {
      if (e.key === 'Escape') closeDj();
      return;
    }
    if (e.target && /^(input|textarea)$/i.test(e.target.tagName)) return;
    if (e.key === 'Escape') { closeOverlay(); return; }
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight') skipNext();
    if (e.key === 'ArrowLeft') skipPrev();
    if (e.key === 's' || e.key === 'S') cycleStation(1);
    if (e.key === 'a' || e.key === 'A') cycleStation(-1);
  });

  // ── DJ Request (Cmd+K) ──
  function openDj() {
    els.dj.hidden = false;
    setTimeout(() => els.djInput.focus(), 20);
  }
  function closeDj() {
    els.dj.hidden = true;
    els.djInput.value = '';
    els.djInput.disabled = false;
    els.djStatus.textContent = '';
    els.djStatus.className = 'dj__status';
    if (els.djRollHint) {
      els.djRollHint.hidden = true;
      els.djRollHint.innerHTML = '';
    }
  }

  // 🎲 Roll a station idea — random prompt from a curated pool spanning
  // time-of-day, activity, weather, era, geography, mood, genre. Click the
  // dice to populate the input; click again to reroll; Enter to submit.
  const STATION_PROMPTS = [
    // Time-of-day
    ['Morning',    'Make a station for 6am coffee — slow ambient, Helios, Ólafur Arnalds, no vocals'],
    ['Focus',      'Build a station for deep work — Tycho-style instrumental electronica, no vocals'],
    ['Afternoon',  'Station for the 3pm slump — bossa nova, warm Brazilian jazz, Joyce'],
    ['Sunday',     'Make a Sunday morning station — slow folk, Big Thief, Bon Iver, no anthems'],
    ['Late night', 'Late-night reading station — neoclassical, Max Richter, Nils Frahm'],

    // Activity
    ['Cooking',    'Station for cooking dinner — tropicalia, Os Mutantes, Caetano Veloso'],
    ['Workout',    'Build a gym station — house + breakbeat, 120-130 BPM, no vocals'],
    ['Writing',    'Station for long writing sessions — instrumental ambient drone, no rhythm'],
    ['Hosting',    'Station for hosting dinner — listening-bar jazz + soul, conversation-friendly'],
    ['Travel',     'Station for long flights — slow ambient, William Basinski, quiet Aphex Twin'],
    ['Driving',    'Station for cross-country drives — alt-country, Lucinda Williams, Wilco'],
    ['Garden',     'Station for puttering in the garden — sunny psych-folk, Connan Mockasin, Real Estate'],
    ['Wind-down',  'Station for the last hour before bed — soft ambient, Brian Eno, Stars of the Lid'],

    // Classical
    ['Classical',  'Build a classical station — Bach, Chopin, Debussy, romantic-era piano'],
    ['Classical',  'Station for modern classical — Max Richter, Nils Frahm, Ólafur Arnalds, Hauschka'],
    ['Classical',  'Station for minimalist classical — Philip Glass, Steve Reich, Arvo Pärt, John Adams'],
    ['Classical',  'Build a baroque station — Bach cello suites, Vivaldi, Handel, Pachelbel'],
    ['Classical',  'Station for cinematic orchestra — Jóhann Jóhannsson, Max Richter, Hans Zimmer'],

    // Weather
    ['Rainy day',  'Station for rainy afternoons — sad indie folk, Mitski, Adrianne Lenker'],
    ['Storm',      'Station for thunderstorms — dark ambient, Tim Hecker, Stars of the Lid'],
    ['Snow',       'Station for snow falling — folk + chamber, Sigur Rós, Nils Frahm'],
    ['Heat',       'Station for hot summer afternoons — dub reggae, King Tubby, Lee Scratch Perry'],
    ['Fog',        'Station for fog rolling in — slowcore + sad-core, Codeine, Low'],

    // Nostalgia
    ['90s grunge',     'Build a 90s grunge station — Pearl Jam, Soundgarden, Alice in Chains'],
    ['2000s indie',    'Station for early 2000s indie — The Strokes, Yeah Yeah Yeahs, Interpol'],
    ['80s sophistipop', 'Station for 80s sophisti-pop — Sade, Roxy Music, Talk Talk, Prefab Sprout'],
    ['70s soft rock',  'Station for 70s soft rock — Fleetwood Mac, Carly Simon, Steely Dan'],
    ['60s folk',       'Station for 60s folk — Joni Mitchell, Nick Drake, Leonard Cohen'],
    ['Y2K pop',        'Station for early-2000s pop nostalgia — Avril Lavigne, Vanessa Carlton, Michelle Branch'],

    // Geographic
    ['Tokyo',     'Station for a Tokyo night — city pop, Mariya Takeuchi, Tatsuro Yamashita'],
    ['Brazil',    'Brazilian dinner station — samba + bossa, Joyce, Os Mutantes, Tom Jobim'],
    ['Berlin',    'Berlin techno warmup station — slower melodic techno, Tale Of Us, Mind Against'],
    ['Lisbon',    'Station for a Lisbon afternoon — fado, Mariza, modern Portuguese indie'],
    ['Paris',     'Station for a Paris café — French chanson, Serge Gainsbourg, Françoise Hardy'],
    ['Nashville', 'Station for old Nashville — outlaw country, Willie Nelson, Townes Van Zandt'],
    ['Reykjavik', 'Station for Icelandic ambient — Sigur Rós, múm, Ólafur Arnalds'],
    ['Lagos',     'Station for Afrobeat — Fela Kuti, Tony Allen, Ebo Taylor'],

    // Mood
    ['Melancholy', 'Station for melancholy without sadness — Joep Beving, Max Richter, Nils Frahm'],
    ['Good mood',  'Station for feeling good — Whitney, Real Estate, Connan Mockasin'],
    ['Heartbreak', 'Station for heartbreak — Phoebe Bridgers, Adrianne Lenker, Big Thief'],
    ['Energy',     'Station for high energy — Daft Punk, LCD Soundsystem, Justice'],
    ['Reflective', 'Station for reflective moments — neoclassical + post-rock, Ólafur Arnalds, Sigur Rós'],

    // Discovery
    ['Discovery',  "Build a station of artists I haven't heard but probably like"],
    ['Discovery',  'Station that\'s 80% new artists, 20% Sleeping Pandora territory'],
    ['Discovery',  'Station for "adjacent to what I usually skip" — push my taste sideways'],

    // Genre deep cuts
    ['Jazz',       'Station for late-night jazz — Bill Evans, Chet Baker, Bill Frisell'],
    ['Soul',       'Station for old soul — Bill Withers, Curtis Mayfield, Ann Peebles'],
    ['Folk',       'Station for British folk — Nick Drake, Sandy Denny, Bert Jansch'],
    ['Hip-hop',    'Station for instrumental hip-hop — Madlib, MF DOOM beats, Nujabes'],
    ['Shoegaze',   'Station for shoegaze — My Bloody Valentine, Slowdive, Ride'],
    ['Krautrock',  'Station for krautrock — Neu!, Can, Cluster, Harmonia'],
    ['Post-rock',  'Station for post-rock — Mogwai, Explosions in the Sky, Godspeed You! Black Emperor'],
    ['Disco',      'Station for late-70s disco — Chic, Donna Summer, Sister Sledge'],

    // Combo (scene + station)
    ['+ Forest',    'Make a forest scene + a folk station for it — Iron & Wine, Fleet Foxes, dappled-sunlight folk'],
    ['+ Basement',  'Make a basement scene + an instrumental hip-hop station — Madlib, MF DOOM'],
    ['+ Beach',     'Create a midnight-beach scene + a slow downtempo station — Bonobo, Thievery Corporation'],
    ['+ Train',     'Make a train scene + a station for window-staring — Sufjan Stevens, Iron & Wine'],
  ];

  let lastDiceIdx = -1;
  function rollDiceStation() {
    if (STATION_PROMPTS.length === 0) return;
    let idx;
    do {
      idx = Math.floor(Math.random() * STATION_PROMPTS.length);
    } while (idx === lastDiceIdx && STATION_PROMPTS.length > 1);
    lastDiceIdx = idx;

    const [category, text] = STATION_PROMPTS[idx];
    els.djInput.value = text;
    els.djInput.focus();
    // Cursor at START so the input shows the beginning of the prompt, not
    // the end (long prompts would otherwise scroll-right and hide "Station
    // for…"). User can ⌘→ or End to jump to the tail if they want to edit.
    els.djInput.setSelectionRange(0, 0);
    els.djInput.scrollLeft = 0;

    if (els.djRollHint) {
      els.djRollHint.innerHTML = `<span class="--cat">${category}</span>Enter to submit · 🎲 to reroll`;
      els.djRollHint.hidden = false;
    }

    els.djDice.classList.remove('--rolling');
    void els.djDice.offsetWidth;   // restart animation
    els.djDice.classList.add('--rolling');
  }

  els.djDice.addEventListener('click', rollDiceStation);
  els.djBackdrop.addEventListener('click', closeDj);
  els.djForm.addEventListener('submit', (e) => { e.preventDefault(); submitDj(); });

  function buildTasteProfile() {
    // Last 30 of each — enough to inform picks, small enough to keep request size sane
    const trim = (l) => l.slice(-30).map((t) => ({
      name: t.name,
      artist: t.artist,
      station: t.stationTitle,
    }));
    return {
      liked: trim(liked),
      skipped: trim(skipped),
    };
  }

  async function applyAddTracks(result) {
    const station = findMix(result.stationId);
    if (!station || !station.spotifyUri) throw new Error(`No station: ${result.stationId}`);
    const pid = playlistIdFromUri(station.spotifyUri);
    const cache = await ensureStationTracksLoaded(result.stationId);
    let added = 0;
    for (const t of result.tracks || []) {
      if (!t || !t.uri) continue;
      if (cache.has(t.uri)) continue;
      try {
        await SpotifyAuth.addTrackToPlaylist(pid, t.uri);
        cache.add(t.uri);
        added++;
      } catch (e) {
        console.warn('[dj] add track failed:', t.uri, e);
      }
    }
    console.log(`[dj] added ${added} track(s) to ${station.title}`);
    return { added, station };
  }

  async function applyRemoveTracks(result) {
    const station = findMix(result.stationId);
    if (!station || !station.spotifyUri) throw new Error(`No station: ${result.stationId}`);
    const pid = playlistIdFromUri(station.spotifyUri);
    const cache = stationTrackCache[result.stationId] || new Set();
    let removed = 0;
    for (const uri of result.trackUris || []) {
      try {
        await SpotifyAuth.removeTrackFromPlaylist(pid, uri);
        cache.delete(uri);
        removed++;
      } catch (e) {
        console.warn('[dj] remove track failed:', uri, e);
      }
    }
    console.log(`[dj] removed ${removed} track(s) from ${station.title}`);
    return { removed, station };
  }

  async function submitDj() {
    const prompt = (els.djInput.value || '').trim();
    if (!prompt) return;
    els.djStatus.textContent = 'Spinning the request…';
    els.djStatus.className = 'dj__status --working';
    els.djInput.disabled = true;
    try {
      const profile = buildTasteProfile();
      const resp = await fetch('/dj', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, profile }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

      const final = await pollDjJob(data.jobId);
      if (final.status !== 'done') {
        els.djStatus.textContent = final.error || 'DJ request failed';
        els.djStatus.className = 'dj__status --error';
        els.djInput.disabled = false;
        return;
      }

      const r = final.result || {};

      // create_station / updated → server already wrote data.js, reload
      if (r.action === 'created' || r.action === 'updated') {
        const verb = r.action === 'updated' ? 'Updated' : 'New station';
        els.djStatus.textContent = `${verb}: ${r.title || ''}. Reloading…`;
        els.djStatus.className = 'dj__status --done';
        setTimeout(() => window.location.reload(), 1400);
        return;
      }

      // created_scene → reload so the new scene is in the DOM
      if (r.action === 'created_scene') {
        els.djStatus.textContent = `New scene: ${r.label || r.sceneId}. Reloading…`;
        els.djStatus.className = 'dj__status --done';
        setTimeout(() => window.location.reload(), 1400);
        return;
      }

      // session_saved → show success + offer to open the new playlist
      if (r.action === 'session_saved') {
        els.djStatus.innerHTML = `Saved: <a href="${escapeHtml(r.spotifyUrl)}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline;">${escapeHtml(r.title)} ↗</a>`;
        els.djStatus.className = 'dj__status --done';
        setTimeout(closeDj, 5000);
        return;
      }

      // add_tracks / remove_tracks → execute mutations in browser via Web API
      if (r.action === 'add_tracks') {
        try {
          const out = await applyAddTracks(r);
          const stationLabel = out.station.title;
          els.djStatus.textContent = r.summary
            ? `${r.summary} (${out.added} added to ${stationLabel})`
            : `Added ${out.added} track${out.added === 1 ? '' : 's'} to ${stationLabel}`;
          els.djStatus.className = 'dj__status --done';
          setTimeout(closeDj, 2200);
        } catch (e) {
          els.djStatus.textContent = e.message;
          els.djStatus.className = 'dj__status --error';
          els.djInput.disabled = false;
        }
        return;
      }

      if (r.action === 'remove_tracks') {
        try {
          const out = await applyRemoveTracks(r);
          const stationLabel = out.station.title;
          els.djStatus.textContent = r.summary
            ? `${r.summary} (${out.removed} removed from ${stationLabel})`
            : `Removed ${out.removed} track${out.removed === 1 ? '' : 's'} from ${stationLabel}`;
          els.djStatus.className = 'dj__status --done';
          setTimeout(closeDj, 2200);
        } catch (e) {
          els.djStatus.textContent = e.message;
          els.djStatus.className = 'dj__status --error';
          els.djInput.disabled = false;
        }
        return;
      }

      // Unknown action — surface it
      els.djStatus.textContent = `Unknown action: ${r.action}`;
      els.djStatus.className = 'dj__status --error';
      els.djInput.disabled = false;
    } catch (e) {
      els.djStatus.textContent = e.message || 'Request failed';
      els.djStatus.className = 'dj__status --error';
      els.djInput.disabled = false;
    }
  }

  async function pollDjJob(jobId, maxMs = 180_000) {
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < maxMs) {
      // Slow ramp: 1s, 1.5s, then 2.5s steady
      const delay = i < 2 ? 1000 : (i < 5 ? 1500 : 2500);
      await new Promise((r) => setTimeout(r, delay));
      i++;
      try {
        const resp = await fetch(`/dj/job/${jobId}`);
        const job = await resp.json();
        if (job.status === 'done' || job.status === 'error') return job;
      } catch (e) { /* keep polling */ }
    }
    return { status: 'error', error: 'Polling timed out client-side' };
  }

  // Disable next/prev visually until OAuth'd
  function syncSkipButtonsAvailability() {
    const authed = SpotifyAuth.isAuthed();
    els.ctrlNext.disabled = !authed;
    els.ctrlPrev.disabled = !authed;
  }

  // ── Custom scenes (hot-loaded from scenes/*.json) ──
  async function loadCustomScenes() {
    try {
      const resp = await fetch('/scenes/index.json');
      if (!resp.ok) return;
      const { scenes } = await resp.json();
      if (!scenes || scenes.length === 0) return;
      const host = document.getElementById('scenes');
      for (const scene of scenes) {
        // Don't double-inject if scene already exists in DOM (built-ins)
        if (document.querySelector(`[data-scene="${scene.sceneId}"]`)) continue;
        // Inject CSS — scoped <style> tag tagged with the sceneId
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-scene-css', scene.sceneId);
        styleEl.textContent = scene.css;
        document.head.appendChild(styleEl);
        // Inject the markup — wrap to extract the <section>
        const wrapper = document.createElement('div');
        wrapper.innerHTML = scene.html.trim();
        const sceneNode = wrapper.firstElementChild;
        if (sceneNode && sceneNode.tagName === 'SECTION') {
          host.appendChild(sceneNode);
          console.log(`[scenes] hot-loaded "${scene.sceneId}" (${scene.label})`);
        } else {
          console.warn('[scenes] invalid scene HTML, skipping:', scene.sceneId);
        }
      }
    } catch (e) {
      console.warn('[scenes] custom loader failed', e.message || e);
    }
  }

  // ── Boot ──
  async function boot() {
    // Hydrate state from server backup BEFORE we render anything
    await hydrateStateFromServer();
    // Load any user-generated scenes BEFORE activateScene() runs
    await loadCustomScenes();

    let cameBackFromAuth = false;
    if (window.location.search.includes('code=') || window.location.search.includes('error=')) {
      try {
        const tokens = await SpotifyAuth.handleCallback();
        cameBackFromAuth = true;
        // Verify the grant has the scopes we need; surface to the UI if not
        if (tokens && tokens.scope) {
          const granted = new Set(tokens.scope.split(' '));
          const required = ['user-library-modify', 'user-library-read', 'streaming', 'user-modify-playback-state'];
          const missing = required.filter((s) => !granted.has(s));
          if (missing.length > 0) {
            // Defer to next tick so other boot steps don't clobber the alert
            setTimeout(() => showScopeMismatch(missing, tokens.scope), 500);
          } else {
            setTimeout(() => showAuthSuccess(), 500);
          }
        }
      } catch (e) {
        console.error('OAuth callback failed:', e);
        alert('Spotify auth failed: ' + (e.message || e));
      }
    }
    const mix = findMix(activeId);
    if (mix) renderStation(mix);
    renderHotcorner();
    syncSkipButtonsAvailability();

    if (SpotifyAuth.isAuthed()) {
      SpotifyAuth.findOrCreateLikedPlaylist().catch((e) => {
        console.warn('Could not ensure Liked Radio Songs playlist', e);
      });
      if (typeof Spotify !== 'undefined' && Spotify.Player) {
        initSpotifySdk();
      }
    }

    seedHighwayStreaks();
    setupMediaSession();

    // If any station's persistent counter is already over threshold, fire
    // the overdue chapter regen now. Brief delay to let other boot bits
    // settle.
    setTimeout(maybeFireOverdueChapter, 2000);

    // Onboarding — show on first run, or resume from the right step after
    // the OAuth round-trip. Skip silently for users who already have auth
    // + at least one station set up.
    if (!maybeAutoCompleteOnboarding()) {
      if (cameBackFromAuth && getOnboardingStep() === 2) {
        // User just finished the Authorize step — advance to Done
        setOnboardingStep(3);
        els.overlay.hidden = false;
      } else {
        // Fresh visit — show wizard from wherever we left off (default 0)
        openOverlay('wizard');
      }
    }
  }

  boot();
})();

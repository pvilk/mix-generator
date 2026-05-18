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
    ctrlHeart: document.getElementById('ctrl-heart'),

    hotcorner: document.getElementById('hotcorner'),
    gear: document.getElementById('gear'),
    artTint: document.getElementById('art-tint'),

    // DJ Request (Cmd+K)
    dj: document.getElementById('dj'),
    djBackdrop: document.getElementById('dj-backdrop'),
    djForm: document.getElementById('dj-form'),
    djInput: document.getElementById('dj-input'),
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
  const DEFAULT_SETTINGS = {
    bridgeTracks: true,
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

  // ── Bridge-track state ──
  // When non-null, we're mid-transition between stations: bridge track is
  // playing, and when it ends we load `targetStation`.
  let bridgeState = null;
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
  // Station-switch guard — ignore Spotify polls that return the OLD track
  // while the iframe is still loading the new playlist.
  let preSwitchUri = null;
  let postSwitchUntil = 0;
  // Station playlist URI cache: stationId -> Set<trackUri>
  const stationTrackCache = {};

  function loadLocal(k) {
    try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; }
  }
  function saveLiked() { localStorage.setItem(LS_KEY, JSON.stringify(liked)); }
  function saveSkipped() { localStorage.setItem(LS_SKIPPED, JSON.stringify(skipped)); }

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
      refreshHeartState(t);
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

  // ── ♡ Save / unsave to Spotify Liked Songs ──
  async function refreshHeartState(track) {
    if (!SpotifyAuth.isAuthed() || !track || !track.id) {
      els.ctrlHeart.classList.remove('--saved');
      els.ctrlHeart.setAttribute('aria-pressed', 'false');
      return;
    }
    try {
      const saved = await SpotifyAuth.isTrackSavedInLibrary(track.id);
      els.ctrlHeart.classList.toggle('--saved', !!saved);
      els.ctrlHeart.setAttribute('aria-pressed', saved ? 'true' : 'false');
    } catch (e) {
      // 403 here means user-library-read scope missing — prompt re-auth
      if (String(e.message || e).includes('403')) {
        console.warn('[heart] scope missing — re-auth needed');
      }
    }
  }

  async function toggleHeart() {
    flashButton(els.ctrlHeart);
    if (!currentTrack || !currentTrack.id) return;
    if (!SpotifyAuth.isAuthed()) { openOverlay('connect'); return; }
    const wasSaved = els.ctrlHeart.classList.contains('--saved');
    // Optimistic toggle
    els.ctrlHeart.classList.toggle('--saved', !wasSaved);
    els.ctrlHeart.setAttribute('aria-pressed', !wasSaved ? 'true' : 'false');
    try {
      if (wasSaved) await SpotifyAuth.removeTrackFromLibrary(currentTrack.id);
      else await SpotifyAuth.saveTrackToLibrary(currentTrack.id);
    } catch (e) {
      // Revert on failure
      els.ctrlHeart.classList.toggle('--saved', wasSaved);
      els.ctrlHeart.setAttribute('aria-pressed', wasSaved ? 'true' : 'false');
      if (String(e.message || e).includes('403')) {
        // Tokens lack the new user-library-modify scope. Open the re-auth
        // flow directly — no jarring alert.
        console.warn('[heart] 403 — opening re-auth overlay');
        openOverlay('connect');
      } else {
        console.warn('save/unsave failed', e);
      }
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

    // 1. Add to global Liked Radio Songs playlist
    try {
      await SpotifyAuth.addToLikedPlaylist(track.uri);
    } catch (e) {
      console.warn('add to Liked Radio Songs failed', e);
    }

    // 2. Add to the active station's own playlist
    if (mix && mix.spotifyUri) {
      try {
        const pid = playlistIdFromUri(mix.spotifyUri);
        const cache = await ensureStationTracksLoaded(activeId);
        if (!cache.has(track.uri)) {
          await SpotifyAuth.addTrackToPlaylist(pid, track.uri);
          cache.add(track.uri);
        }
      } catch (e) {
        console.warn(`add to station "${mix.title}" failed`, e);
      }

      // 3. Replenish: find a similar+discovery track and add it. Fires in
      //    background so it never blocks playback.
      replenishStationFromTrack(track, mix).catch((e) =>
        console.warn('[replenish] failed', e));
    }

    inflightAdds.delete(track.uri);
  }

  function loadKnownArtists() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_KNOWN_ARTISTS) || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveKnownArtists(s) {
    localStorage.setItem(LS_KNOWN_ARTISTS, JSON.stringify([...s]));
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

  // ── Replenishment algorithm ──
  // When Phil listens through a track, we:
  //   1. Find the track's first artist + their genres
  //   2. Search Spotify for tracks in that genre
  //   3. Score: prefer artists Phil hasn't heard yet (discovery), then popularity
  //   4. Filter out anything already in the station
  //   5. Add the highest-scoring track to the station
  // The "known artists" set lives in localStorage so "new" actually means new.
  async function replenishStationFromTrack(seedTrack, mix) {
    if (!SpotifyAuth.isAuthed()) return;
    const stationPid = playlistIdFromUri(mix.spotifyUri);
    if (!stationPid) return;

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

    // Filter out tracks already in the station + the seed track itself
    const cache = await ensureStationTracksLoaded(activeId);
    let fresh = candidates.filter((t) =>
      !cache.has(t.uri) && t.uri !== seedTrack.uri
    );
    if (fresh.length === 0) {
      console.log('[replenish] all candidates already in station');
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

    // Score: +10 if artist is new to Phil, + popularity/20, + 1 if not the seed artist
    const knownArtists = loadKnownArtists();
    const scored = fresh.map((t) => {
      const firstArtist = t.artists && t.artists[0];
      const aid = firstArtist && firstArtist.uri && firstArtist.uri.split(':').pop();
      const isNew = aid && !knownArtists.has(aid);
      const isSeedArtist = aid === seedArtistId;
      return {
        track: t,
        score:
          (isNew ? 10 : 0) +              // discovery bonus
          (t.popularity || 0) / 20 +      // light popularity weight
          (isSeedArtist ? 0 : 1.5),       // prefer a different artist for variety
      };
    }).sort((a, b) => b.score - a.score);

    const winner = scored[0].track;
    try {
      await SpotifyAuth.addTrackToPlaylist(stationPid, winner.uri);
      cache.add(winner.uri);
      const aname = (winner.artists && winner.artists[0] && winner.artists[0].name) || '?';
      console.log(`[replenish] + "${winner.name}" by ${aname} (score ${scored[0].score.toFixed(1)})`);
    } catch (e) {
      console.warn('[replenish] add failed', e);
    }

    // Mark the seed artist as "known" — Phil has now heard them through.
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

    // Local record of this skip (for the overlay summary)
    skipped.push({
      ts: Date.now(),
      uri: track.uri,
      name: track.name,
      artist: track.artist,
      stationId: activeId,
      stationTitle: mix ? mix.title : activeId,
    });
    saveSkipped();

    // Remove from the active station's playlist so it stops surfacing
    if (mix && mix.spotifyUri) {
      try {
        const pid = playlistIdFromUri(mix.spotifyUri);
        await SpotifyAuth.removeTrackFromPlaylist(pid, track.uri);
        const cache = stationTrackCache[activeId];
        if (cache) cache.delete(track.uri);
      } catch (e) {
        console.warn(`remove from station "${mix && mix.title}" failed`, e);
      }
    }
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
      console.error('[sdk] auth error:', message);
      SpotifyAuth.clearAuth();
      renderHotcorner();
      // Don't yell with alert — just nudge the user to reconnect
      openOverlay('connect');
    });
    sdkPlayer.addListener('account_error', ({ message }) => {
      console.error('[sdk] account error:', message);
      // Premium required. Show as inline error on the connect overlay.
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

    sdkPlayer.addListener('player_state_changed', (state) => {
      if (!state) return;
      checkBridgeEnd(state);
      const { paused, position, duration, track_window } = state;
      const playing = !paused;
      if (playing !== isPlaying) setPlayingVisual(playing);

      if (duration > 0) {
        const pct = Math.max(0, Math.min(100, (position / duration) * 100));
        els.cardProgress.style.width = pct + '%';
      }

      const t = track_window && track_window.current_track;
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

        // Listen-through / skip detection on URI change
        if (lastSeenTrack && lastSeenTrack.uri !== cur.uri) {
          const ratio = lastSeenTrack.durationMs > 0
            ? lastSeenTrack.progressMs / lastSeenTrack.durationMs : 0;
          if (ratio >= 0.85) onTrackListenedThrough(lastSeenTrack);
          else onTrackSkipped(lastSeenTrack);
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
      await SpotifyAuth.api(`/me/player/play?device_id=${sdkDeviceId}`, {
        method: 'PUT',
        body: JSON.stringify({
          context_uri: mix.spotifyUri,
          position_ms: 0,
        }),
      });
      console.log('[player] context_uri play:', mix.title);
    } catch (e) {
      console.warn('playStation failed', e);
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

    // Try bridge if enabled, not already mid-bridge, and we have ammo
    const settings = loadSettings();
    const canBridge = settings.bridgeTracks
      && !opts.skipBridge
      && !bridgeState
      && sdkReady
      && currentTrack
      && liked.length > 0;

    if (canBridge) {
      const bridge = pickBridgeTrack(mix);
      if (bridge) {
        await startBridge(bridge, mix);
        return;
      }
    }

    // Direct station switch
    activeId = id;
    lastSeenTrack = null;
    currentTrack = null;

    renderStation(mix);

    // Optimistic blank state
    els.cardProgress.style.width = '0%';
    els.cardArt.classList.add('--swapping');
    els.cardArt.classList.remove('--has-art');
    els.cardArt.style.backgroundImage = '';
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

  // ── Bridge track helpers ──
  function pickBridgeTrack(targetMix) {
    // Pick a recently-loved track that isn't currently playing and isn't
    // already in the target station's playlist.
    const cache = stationTrackCache[targetMix.id] || new Set();
    const recentLoved = liked.slice(-25).filter((l) =>
      l && l.uri
      && (!currentTrack || l.uri !== currentTrack.uri)
      && !cache.has(l.uri)
    );
    if (recentLoved.length === 0) return null;
    return recentLoved[Math.floor(Math.random() * recentLoved.length)];
  }

  async function startBridge(bridge, targetMix) {
    if (!sdkDeviceId) return;
    bridgeState = {
      trackUri: bridge.uri,
      bridgeName: bridge.name,
      bridgeArtist: bridge.artist,
      targetStation: targetMix,
      startedAt: Date.now(),
    };
    console.log(`[bridge] "${bridge.name}" by ${bridge.artist} → ${targetMix.title}`);

    // Show bridge state on the card
    els.cardTitle.classList.remove('--swapping');
    els.cardArtist.classList.remove('--swapping');
    els.cardTitle.textContent = `→ ${targetMix.title}`;
    els.cardArtist.textContent = `bridging via ${bridge.name} · ${bridge.artist}`;
    els.stationName.textContent = `Bridging → ${targetMix.title.toUpperCase()}`;

    // Play the bridge track as a one-shot (PUT /me/player/play with uris)
    try {
      await SpotifyAuth.api(`/me/player/play?device_id=${sdkDeviceId}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [bridge.uri] }),
      });
      setPlayingVisual(true);
    } catch (e) {
      console.warn('[bridge] play failed, doing direct switch', e);
      bridgeState = null;
      await setStation(targetMix.id, { skipBridge: true });
    }
  }

  // Called from player_state_changed — checks if the bridge just ended.
  async function checkBridgeEnd(state) {
    if (!bridgeState || !state) return;
    const cur = state.track_window && state.track_window.current_track;
    const elapsed = Date.now() - bridgeState.startedAt;
    const curUri = cur && cur.uri;

    // Bridge ended if: (a) track URI is no longer the bridge AND we've been
    // playing for >5s (avoid catching the initial settle), or (b) playback
    // is paused at position 0 after >5s (single-track playback ran out).
    const trackChanged = curUri && curUri !== bridgeState.trackUri && elapsed > 5000;
    const ranOut = state.paused && state.position === 0 && elapsed > 5000;

    if (trackChanged || ranOut) {
      const target = bridgeState.targetStation;
      console.log('[bridge] ended → loading', target.title);
      bridgeState = null;
      await setStation(target.id, { skipBridge: true });
    }
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
    els.overlay.hidden = false;
  }
  function closeOverlay() { els.overlay.hidden = true; }

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
      html = `<p style="font-size: 12px; opacity: 0.7;">Listened-through tracks get added to <strong>Liked Radio Songs</strong> and to the station you were on. Skipped tracks get removed from that station.</p>`;
      html += `<ul>`;
      liked.slice().reverse().forEach((l) => {
        html += `<li>
          <span><strong>${escapeHtml(l.name || '—')}</strong> · ${escapeHtml(l.artist || '')}</span>
          <span class="station">+ ${escapeHtml(l.stationTitle || l.stationId)}</span>
        </li>`;
      });
      html += '</ul>';
      if (skipped.length > 0) {
        html += `<p style="margin-top: 18px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.2em; opacity: 0.6;">Skipped — removed from station</p>`;
        html += `<ul>`;
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
    if (authed && liked.length > 0) {
      const open = document.createElement('button');
      open.className = '--primary';
      open.textContent = 'Open in Spotify ↗';
      open.addEventListener('click', async () => {
        const url = await SpotifyAuth.getLikedPlaylistUrl();
        if (url) window.open(url, '_blank', 'noopener');
      });
      els.overlayActions.appendChild(open);
    } else if (!authed) {
      const c = document.createElement('button');
      c.className = '--primary';
      c.textContent = 'Set up auto-save';
      c.addEventListener('click', () => { closeOverlay(); openOverlay('connect'); });
      els.overlayActions.appendChild(c);
    }
    if (liked.length > 0 || skipped.length > 0) {
      const clr = document.createElement('button');
      clr.className = '--ghost';
      clr.textContent = 'Clear session';
      clr.addEventListener('click', () => {
        if (!confirm('Clear local session list? (Does not undo changes already made to Spotify.)')) return;
        liked = [];
        skipped = [];
        saveLiked();
        saveSkipped();
        renderHotcorner();
        renderLikedOverlay();
      });
      els.overlayActions.appendChild(clr);
    }
  }

  function renderSettingsOverlay() {
    const s = loadSettings();
    els.overlayKicker.textContent = 'Configuration';
    els.overlayTitle.textContent = 'Radio Settings';
    els.overlayBody.innerHTML = `
      <div class="settings-list">
        <label class="settings-row">
          <input type="checkbox" id="setting-bridge" ${s.bridgeTracks ? 'checked' : ''} />
          <div class="settings-row__text">
            <div class="settings-row__title">Bridge tracks between stations</div>
            <div class="settings-row__desc">When you switch stations, play one familiar song from your liked list first as a transition. The new station loads automatically when the bridge ends.</div>
          </div>
        </label>
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
    els.overlayActions.innerHTML = '';
    const saveBtn = document.createElement('button');
    saveBtn.className = '--primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      saveSettings({
        bridgeTracks: document.getElementById('setting-bridge').checked,
        bpmLocked: document.getElementById('setting-bpm').checked,
        albumArtTint: document.getElementById('setting-tint').checked,
      });
      // If tint was turned off, clear immediately
      if (!document.getElementById('setting-tint').checked) {
        els.artTint.style.backgroundColor = 'transparent';
      } else if (currentTrack) {
        // Tint was turned on — apply to current track
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

    let html = `<p>Connects a personal Spotify Developer App so the radio can show the live track + auto-write listened-through tracks to a <strong>Liked Radio Songs</strong> playlist.</p>`;
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
  els.ctrlHeart.addEventListener('click', toggleHeart);
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
  }

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

  // ── Boot ──
  async function boot() {
    if (window.location.search.includes('code=') || window.location.search.includes('error=')) {
      try { await SpotifyAuth.handleCallback(); }
      catch (e) {
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
      // If the SDK script already loaded (race with our boot), init the
      // player now. Otherwise onSpotifyWebPlaybackSDKReady will trigger it.
      if (typeof Spotify !== 'undefined' && Spotify.Player) {
        initSpotifySdk();
      }
    }

    seedHighwayStreaks();
    setupMediaSession();
  }

  boot();
})();

// Spotify PKCE auth + Web API helpers.
// Public API surface: window.SpotifyAuth

(() => {
  'use strict';

  const SCOPES = [
    'streaming',                        // Web Playback SDK — required for browser device
    'user-read-email',                  // SDK init requires email scope too
    'user-read-currently-playing',
    'user-read-playback-state',
    'user-modify-playback-state',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-modify',              // ♡ save to / remove from Liked Songs
    'user-library-read',                // check whether a track is already saved
    'user-read-private',
  ].join(' ');

  const REDIRECT_URI = window.location.origin + window.location.pathname;

  const LS = {
    verifier: 'mixgen.pkce.verifier',
    state: 'mixgen.pkce.state',
    clientId: 'mixgen.spotify.clientId',
    tokens: 'mixgen.spotify.tokens',
    likedPlaylist: 'mixgen.likedPlaylistId',
    user: 'mixgen.spotify.user',
  };

  function base64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(len = 64) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return base64url(arr);
  }

  async function sha256(str) {
    const data = new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', data);
  }

  // ── Token storage ──
  function getTokens() {
    try { return JSON.parse(localStorage.getItem(LS.tokens) || 'null'); } catch (e) { return null; }
  }

  function saveTokens(t) {
    const wrapped = { ...t, expires_at: Date.now() + ((t.expires_in || 3600) * 1000) };
    localStorage.setItem(LS.tokens, JSON.stringify(wrapped));
    return wrapped;
  }

  function clearAuth() {
    [LS.verifier, LS.state, LS.tokens, LS.likedPlaylist, LS.user].forEach((k) => localStorage.removeItem(k));
  }

  function getClientId() { return localStorage.getItem(LS.clientId) || ''; }
  function setClientId(id) { localStorage.setItem(LS.clientId, id); }

  // ── Auth flow ──
  async function startAuth(clientId) {
    if (clientId) setClientId(clientId);
    const id = getClientId();
    if (!id) throw new Error('clientId missing');

    const verifier = randomString(64);
    const challenge = base64url(await sha256(verifier));
    const state = randomString(16);

    localStorage.setItem(LS.verifier, verifier);
    localStorage.setItem(LS.state, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    window.location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const err = params.get('error');
    if (err) {
      // Spotify sent us back with an error
      cleanUrl();
      throw new Error(`spotify auth error: ${err}`);
    }
    if (!code) return null;

    const expected = localStorage.getItem(LS.state);
    if (state !== expected) {
      cleanUrl();
      throw new Error('state mismatch');
    }

    const verifier = localStorage.getItem(LS.verifier);
    const clientId = getClientId();
    if (!verifier || !clientId) {
      cleanUrl();
      throw new Error('missing verifier or clientId');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      cleanUrl();
      throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    }
    const tokens = saveTokens(await res.json());
    localStorage.removeItem(LS.verifier);
    localStorage.removeItem(LS.state);
    cleanUrl();
    return tokens;
  }

  function cleanUrl() {
    const url = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, url);
  }

  async function refreshTokens() {
    const t = getTokens();
    if (!t || !t.refresh_token) return null;
    const clientId = getClientId();
    if (!clientId) return null;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: clientId,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return null;
    const fresh = await res.json();
    // Spotify may omit refresh_token on refresh — preserve the old one
    if (!fresh.refresh_token) fresh.refresh_token = t.refresh_token;
    return saveTokens(fresh);
  }

  async function getAccessToken() {
    const t = getTokens();
    if (!t) return null;
    if (Date.now() > (t.expires_at || 0) - 60000) {
      const r = await refreshTokens();
      return r ? r.access_token : null;
    }
    return t.access_token;
  }

  // ── Web API ──
  async function api(path, options = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('not authenticated');
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Spotify ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async function getCurrentUser() {
    const cached = localStorage.getItem(LS.user);
    if (cached) { try { return JSON.parse(cached); } catch (e) {} }
    const u = await api('/me');
    if (u) localStorage.setItem(LS.user, JSON.stringify(u));
    return u;
  }

  async function getCurrentlyPlaying() {
    return api('/me/player/currently-playing?additional_types=track,episode');
  }

  async function listUserPlaylists() {
    const out = [];
    let url = '/me/playlists?limit=50';
    let page;
    while (url) {
      page = await api(url);
      if (!page || !page.items) break;
      out.push(...page.items);
      url = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return out;
  }

  async function findOrCreateLikedPlaylist() {
    const cached = localStorage.getItem(LS.likedPlaylist);
    if (cached) {
      // Verify the playlist still exists
      try {
        const p = await api(`/playlists/${cached}`);
        if (p && !p.error) return cached;
      } catch (e) { /* fall through to recreate */ }
      localStorage.removeItem(LS.likedPlaylist);
    }

    const playlists = await listUserPlaylists();
    const existing = playlists.find((p) => p && p.name === 'Liked Radio Songs');
    if (existing) {
      localStorage.setItem(LS.likedPlaylist, existing.id);
      return existing.id;
    }

    const user = await getCurrentUser();
    const created = await api(`/users/${user.id}/playlists`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Liked Radio Songs',
        description: 'Songs I let play all the way through on the radio.',
        public: false,
      }),
    });
    localStorage.setItem(LS.likedPlaylist, created.id);
    return created.id;
  }

  async function addTrackToPlaylist(playlistId, trackUri) {
    await api(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris: [trackUri] }),
    });
  }

  async function removeTrackFromPlaylist(playlistId, trackUri) {
    await api(`/playlists/${playlistId}/tracks`, {
      method: 'DELETE',
      body: JSON.stringify({ tracks: [{ uri: trackUri }] }),
    });
  }

  async function getAllPlaylistTrackUris(playlistId) {
    const uris = new Set();
    let url = `/playlists/${playlistId}/tracks?fields=items(track(uri)),next&limit=100`;
    while (url) {
      const page = await api(url);
      if (!page || !page.items) break;
      page.items.forEach((it) => { if (it.track && it.track.uri) uris.add(it.track.uri); });
      url = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return uris;
  }

  async function addToLikedPlaylist(trackUri) {
    const id = await findOrCreateLikedPlaylist();
    await addTrackToPlaylist(id, trackUri);
  }

  async function getLikedPlaylistUrl() {
    const id = localStorage.getItem(LS.likedPlaylist);
    if (!id) return null;
    return `https://open.spotify.com/playlist/${id}`;
  }

  // ── User Library (Liked Songs) ──
  async function saveTrackToLibrary(trackId) {
    await api(`/me/tracks?ids=${encodeURIComponent(trackId)}`, { method: 'PUT' });
  }
  async function removeTrackFromLibrary(trackId) {
    await api(`/me/tracks?ids=${encodeURIComponent(trackId)}`, { method: 'DELETE' });
  }
  async function isTrackSavedInLibrary(trackId) {
    const result = await api(`/me/tracks/contains?ids=${encodeURIComponent(trackId)}`);
    return Array.isArray(result) && result[0] === true;
  }

  // ── Discovery helpers ──
  async function getArtist(artistId) {
    return api(`/artists/${artistId}`);
  }
  async function searchTracks(query, limit = 20) {
    const q = encodeURIComponent(query);
    return api(`/search?q=${q}&type=track&limit=${limit}`);
  }

  function isAuthed() { return !!(getTokens() && getClientId()); }

  window.SpotifyAuth = {
    REDIRECT_URI,
    SCOPES,
    isAuthed,
    getClientId,
    setClientId,
    startAuth,
    handleCallback,
    refreshTokens,
    getAccessToken,
    getCurrentUser,
    getCurrentlyPlaying,
    listUserPlaylists,
    findOrCreateLikedPlaylist,
    addToLikedPlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    getAllPlaylistTrackUris,
    getLikedPlaylistUrl,
    saveTrackToLibrary,
    removeTrackFromLibrary,
    isTrackSavedInLibrary,
    getArtist,
    searchTracks,
    clearAuth,
    api,
  };
})();

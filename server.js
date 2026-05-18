// Mix Generator — local server.
// Serves static files AND runs DJ requests via `claude -p` subprocess.
//
// Run:  node server.js
// Open: http://127.0.0.1:8765/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

const PORT = 8765;
const ROOT = __dirname;
const DATA_JS = path.join(ROOT, 'data.js');
const DATA_EXAMPLE = path.join(ROOT, 'data.example.js');
const STATE_FILE = path.join(ROOT, 'state.json');     // per-user listening history backup (gitignored)
const SCENES_DIR = path.join(ROOT, 'scenes');         // user-generated scenes (gitignored)
const DJ_TIMEOUT_MS = 180_000; // 3 minutes — claude -p with MCP calls can be slow

// Ensure scenes/ exists (state.json is created on first sync)
if (!fs.existsSync(SCENES_DIR)) fs.mkdirSync(SCENES_DIR, { recursive: true });

// First-run: copy data.example.js → data.js so each user has their own state.
// data.js is gitignored; data.example.js is the template that ships with the repo.
if (!fs.existsSync(DATA_JS) && fs.existsSync(DATA_EXAMPLE)) {
  fs.copyFileSync(DATA_EXAMPLE, DATA_JS);
  console.log('First run — created data.js from data.example.js');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

// In-memory job store.
const jobs = {};

// ────────────────────────────────────────────────────────────────────
// data.js helpers
// ────────────────────────────────────────────────────────────────────

function readData() {
  const src = fs.readFileSync(DATA_JS, 'utf8');
  const match = src.match(/window\.MIX_DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*$/m);
  if (!match) throw new Error('Could not parse data.js');
  // Safe because we wrote this file.
  return new Function(`return (${match[1]});`)();
}

function writeData(obj) {
  const header = `// Mix Generator — stations + scene config.
// Each station drives both audio (Spotify playlist) and visual (a scene/room).
//
// Schema:
//   id, title, subtitle, scene ('highway'|'bar'|'sunset'),
//   coverColors[], spotifyUri, spotifyUrl, refresh
//
// Updated by DJ requests via server.js (Cmd+K in the page).

window.MIX_DATA = `;
  fs.writeFileSync(DATA_JS, header + JSON.stringify(obj, null, 2) + ';\n', 'utf8');
}

// ────────────────────────────────────────────────────────────────────
// claude -p subprocess
// ────────────────────────────────────────────────────────────────────

let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim() || 'claude';
} catch (e) { /* fallback to PATH */ }

function buildDjPrompt(userRequest, profile) {
  const data = readData();
  const stationsText = data.playlists.map((p) =>
    `  - id="${p.id}"  title="${p.title}"  scene="${p.scene}"  uri=${p.spotifyUri}`
  ).join('\n');

  let profileText = '';
  if (profile && (profile.liked?.length || profile.skipped?.length)) {
    const fmtList = (items) => items.slice(0, 30).map((t) =>
      `    - "${t.name}" by ${t.artist}${t.station ? ` [from ${t.station}]` : ''}`
    ).join('\n');
    profileText = `
USER'S TASTE PROFILE (use this to bias your picks):

LOVED tracks (they listened all the way through):
${profile.liked?.length ? fmtList(profile.liked) : '    (none yet)'}

SKIPPED tracks (they didn't like — avoid territory near these):
${profile.skipped?.length ? fmtList(profile.skipped) : '    (none yet)'}

When picking tracks, lean toward artists/sounds similar to LOVED. Avoid artists in SKIPPED.
`;
  }

  return `You are the in-app DJ for "Mix Generator", a personal radio web app. The user just hit Cmd+K and typed a request. Execute it using the Spotify MCP and respond with a single JSON object — nothing else.

REQUEST:
"""
${userRequest}
"""

CURRENT STATIONS (in data.js):
${stationsText}
${profileText}
YOUR TOOLS:
- mcp__claude_ai_Spotify__create_playlist — make a brand new Spotify playlist
- mcp__claude_ai_Spotify__search — find specific tracks, artists, albums (returns up to 5 results per query — issue multiple queries to collect variety)

DECIDE THE ACTION:

1. NEW or REFRESH a station's vibe entirely → "create_station" (the server overwrites the station if id matches existing; appends if new)
2. ADD specific tracks to an existing station (preserve the playlist, just append) → "add_tracks"
3. REMOVE specific tracks from an existing station → "remove_tracks"
4. CREATE a NEW VISUAL SCENE (a new ambient room — forest, beach, basement, etc.) → "create_scene"
5. Can't do it → "error"

CHOOSING ACTION:
- "make a station for X" / "new station: X" → create_station (new id)
- "refresh X" / "change X to be Y" / "make X darker" → create_station (re-use X's id — overwrites)
- "add more shoegaze to X" / "X needs more Y" / "throw in some Z" → add_tracks (search Spotify, return URIs, browser will append to the existing playlist)
- "remove the synthwave from X" / "drop track Y from X" → remove_tracks (search to identify URIs)
- "make me a forest scene" / "add a beach room" / "create a winter night vibe" → create_scene (generate HTML + CSS for a new ambient backdrop)

CHOOSING "scene":
- "highway" — night driving, synthwave, dark, dream-pop, lo-fi
- "bar"     — warm listening bar, jazz, soul, slow grooves
- "sunset"  — melodic deep house, golden-hour, Anjunadeep / This Never Happened

CHOOSING "coverColors": 1-2 hex codes matching the vibe.

OUTPUT JSON SCHEMA — choose ONE:

A) Create / replace a station playlist:
{
  "action": "create_station",
  "id": "kebab-case-id",         // re-use an existing id to OVERWRITE a station
  "title": "Display Name",
  "subtitle": "Short vibe line · Seed artists",
  "scene": "highway" | "bar" | "sunset",
  "coverColors": ["#hex", "#hex"?],
  "spotifyUri": "spotify:playlist:...",
  "spotifyUrl": "https://open.spotify.com/playlist/..."
}

B) ADD tracks to an existing station (preserves the playlist):
{
  "action": "add_tracks",
  "stationId": "existing-station-id",
  "tracks": [
    {"uri": "spotify:track:...", "name": "Track Name", "artist": "Artist Name"}
  ],
  "summary": "Short description of what you added"
}

C) REMOVE tracks from an existing station:
{
  "action": "remove_tracks",
  "stationId": "existing-station-id",
  "trackUris": ["spotify:track:..."],
  "summary": "Short description of what you removed and why"
}

D) CREATE a new visual scene (a new ambient "room"):
{
  "action": "create_scene",
  "sceneId": "kebab-case-id",      // becomes scene='kebab-case-id' on a station
  "label": "Display Name",
  "description": "What it evokes (one sentence)",
  "html": "<section class=\\"scene scene--{id}\\" data-scene=\\"{id}\\">...layered divs...</section>",
  "css": ".scene--{id} { ... }\\n.{id}__sky { ... }\\n..."
}

SCENE CONSTRAINTS — these are hard requirements:
- The HTML must be ONE <section> with class "scene scene--{sceneId}" and data-scene="{sceneId}". It will be appended to the existing .scenes container.
- Inside the section: 3-5 layered divs (sky/background, midground, foreground, vignette). No JS. No <script>. No event handlers.
- All CSS class names MUST be prefixed with the sceneId (e.g. .forest__sky, .forest__canopy) to avoid clashing with existing scenes.
- Use CSS transforms, opacity, filter, gradient, mix-blend-mode. Animate via @keyframes.
- Animations should feel ambient: 10-90s loops, slow drift, subtle pulse.
- Include a vignette layer at the end: <div class="vignette"></div> — the existing class is reused.
- Color palette should match the requested vibe.

E) Error:
{"action": "error", "message": "why"}

EXECUTION TIPS:
- For "add" prompts: issue 3-5 separate Spotify search queries (different angles on the vibe) to collect 8-12 candidates, then return your favorite 5-8 URIs.
- For "remove" prompts: if Phil names specific artists/tracks, search for them to get URIs. If the request is vague ("less synth"), recommend create_station instead.
- Use the taste profile (if present) to bias selections.
- Output ONLY the JSON object — no prose, no markdown fences.

Be decisive. Pick reasonable defaults.`;
}

function extractJsonObject(text) {
  if (!text) return null;
  // Find the LAST top-level { ... } block — Claude sometimes prefixes with thoughts.
  // Walk from the end looking for a balanced object.
  for (let i = text.lastIndexOf('}'); i !== -1; i = text.lastIndexOf('}', i - 1)) {
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      const c = text[j];
      if (c === '}') depth++;
      else if (c === '{') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(j, i + 1);
          try { return JSON.parse(candidate); } catch (e) { break; }
        }
      }
    }
  }
  // Fallback: first { ... } block
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* */ } }
  return null;
}

function runDjJob(jobId, userRequest, profile) {
  jobs[jobId].status = 'running';
  jobs[jobId].startedAt = Date.now();

  const prompt = buildDjPrompt(userRequest, profile);
  const proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const timeout = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch (e) {}
    jobs[jobId] = {
      ...jobs[jobId],
      status: 'error',
      error: `DJ request timed out after ${DJ_TIMEOUT_MS / 1000}s`,
    };
  }, DJ_TIMEOUT_MS);

  proc.on('error', (err) => {
    clearTimeout(timeout);
    jobs[jobId] = { ...jobs[jobId], status: 'error', error: `Could not spawn claude: ${err.message}` };
  });

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (jobs[jobId].status === 'error') return; // already errored (timeout)

    try {
      if (code !== 0) {
        jobs[jobId] = { ...jobs[jobId], status: 'error', error: `claude exited ${code}: ${stderr.slice(0, 400)}` };
        return;
      }
      const envelope = JSON.parse(stdout);
      const resultText = envelope.result || envelope.structured_output || '';
      const result = extractJsonObject(resultText);
      if (!result) {
        jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'DJ returned no JSON', raw: resultText.slice(0, 400) };
        return;
      }
      applyDjResult(jobId, result);
    } catch (e) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: e.message, raw: stdout.slice(0, 400) };
    }
  });

  proc.stdin.write(prompt);
  proc.stdin.end();
}

function applyDjResult(jobId, result) {
  if (result.action === 'error') {
    jobs[jobId] = { ...jobs[jobId], status: 'error', error: result.message || 'DJ said no' };
    return;
  }

  if (result.action === 'create_station') {
    if (!result.spotifyUri) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'DJ did not return a Spotify URI' };
      return;
    }
    const data = readData();
    let id = result.id || `dj-${Date.now().toString(36).slice(-5)}`;
    const existingIdx = data.playlists.findIndex((p) => p.id === id);
    const entry = {
      id,
      title: result.title || 'Untitled',
      subtitle: result.subtitle || '',
      scene: ['highway', 'bar', 'sunset'].includes(result.scene) ? result.scene : 'bar',
      coverColors: Array.isArray(result.coverColors) && result.coverColors.length
        ? result.coverColors.slice(0, 2)
        : ['#5b2e2e'],
      spotifyUri: result.spotifyUri,
      spotifyUrl: result.spotifyUrl || ('https://open.spotify.com/playlist/' + result.spotifyUri.split(':').pop()),
      refresh: 'manual',
    };
    let action;
    if (existingIdx >= 0) { data.playlists[existingIdx] = entry; action = 'updated'; }
    else { data.playlists.push(entry); action = 'created'; }
    data.active = id;
    writeData(data);
    jobs[jobId] = {
      ...jobs[jobId],
      status: 'done',
      result: { action, id, title: entry.title, scene: entry.scene },
    };
    return;
  }

  if (result.action === 'create_scene') {
    if (!result.sceneId || !result.html || !result.css) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'create_scene missing sceneId/html/css' };
      return;
    }
    const safeId = String(result.sceneId).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (!safeId) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'invalid sceneId' };
      return;
    }
    const sceneFile = path.join(SCENES_DIR, `${safeId}.json`);
    fs.writeFileSync(sceneFile, JSON.stringify({
      sceneId: safeId,
      label: result.label || safeId,
      description: result.description || '',
      html: result.html,
      css: result.css,
      createdAt: Date.now(),
    }, null, 2));
    console.log(`[scene] created "${safeId}" (${result.label || ''})`);
    jobs[jobId] = {
      ...jobs[jobId],
      status: 'done',
      result: { action: 'created_scene', sceneId: safeId, label: result.label || safeId },
    };
    return;
  }

  if (result.action === 'add_tracks' || result.action === 'remove_tracks') {
    // No data.js mutation needed — server hands the track URIs back to the
    // browser, which executes the playlist mutation via its OAuth tokens.
    if (!result.stationId) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'DJ did not specify a stationId' };
      return;
    }
    const data = readData();
    const station = data.playlists.find((p) => p.id === result.stationId);
    if (!station) {
      jobs[jobId] = { ...jobs[jobId], status: 'error', error: `Unknown station: ${result.stationId}` };
      return;
    }
    jobs[jobId] = {
      ...jobs[jobId],
      status: 'done',
      result: {
        action: result.action,
        stationId: result.stationId,
        stationTitle: station.title,
        tracks: result.tracks || null,
        trackUris: result.trackUris || null,
        summary: result.summary || '',
      },
    };
    return;
  }

  jobs[jobId] = { ...jobs[jobId], status: 'error', error: 'Unknown action: ' + result.action };
}

// ────────────────────────────────────────────────────────────────────
// HTTP server
// ────────────────────────────────────────────────────────────────────

function jsonRes(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c.toString(); if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // POST /dj — start a job
    if (req.method === 'POST' && req.url === '/dj') {
      const body = await readBody(req);
      let prompt, profile;
      try { ({ prompt, profile } = JSON.parse(body || '{}')); } catch (e) {}
      if (!prompt || !prompt.trim()) return jsonRes(res, 400, { error: 'empty prompt' });
      const jobId = crypto.randomBytes(4).toString('hex');
      jobs[jobId] = { status: 'queued', createdAt: Date.now(), prompt };
      setImmediate(() => runDjJob(jobId, prompt, profile));
      const profileSize = profile ? ((profile.liked || []).length + (profile.skipped || []).length) : 0;
      console.log(`[dj] ${jobId} queued (${profileSize} profile items): ${prompt.slice(0, 80)}`);
      return jsonRes(res, 200, { jobId });
    }

    // GET /dj/job/:id — poll job status
    if (req.method === 'GET' && req.url.startsWith('/dj/job/')) {
      const id = req.url.slice('/dj/job/'.length);
      const job = jobs[id];
      if (!job) return jsonRes(res, 404, { error: 'not found' });
      return jsonRes(res, 200, job);
    }

    // POST /state/sync — back up the browser's listening state to disk
    if (req.method === 'POST' && req.url === '/state/sync') {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body || '{}');
        // Light validation — must be the expected shape
        const safe = {
          liked: Array.isArray(parsed.liked) ? parsed.liked : [],
          skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
          knownArtists: Array.isArray(parsed.knownArtists) ? parsed.knownArtists : [],
          syncedAt: Date.now(),
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2));
        return jsonRes(res, 200, { ok: true, syncedAt: safe.syncedAt });
      } catch (e) {
        return jsonRes(res, 400, { error: e.message });
      }
    }

    // GET /state/sync — restore listening state on a fresh browser
    if (req.method === 'GET' && req.url === '/state/sync') {
      if (!fs.existsSync(STATE_FILE)) {
        return jsonRes(res, 200, { liked: [], skipped: [], knownArtists: [], syncedAt: null });
      }
      try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return jsonRes(res, 200, data);
      } catch (e) {
        return jsonRes(res, 500, { error: 'corrupt state file' });
      }
    }

    // GET /scenes/index.json — list available user-generated scenes
    if (req.method === 'GET' && req.url === '/scenes/index.json') {
      const entries = fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json'));
      const scenes = entries.map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8')); }
        catch (e) { return null; }
      }).filter(Boolean);
      return jsonRes(res, 200, { scenes });
    }

    // Static file
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    const filePath = path.join(ROOT, url);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) jsonRes(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mix Generator   http://127.0.0.1:${PORT}/`);
  console.log(`DJ endpoint      POST /dj  { prompt }`);
  console.log(`Claude binary    ${CLAUDE_BIN}`);
});

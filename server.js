'use strict';
const express      = require('express');
const http         = require('http');
const https        = require('https');
const { WebSocketServer } = require('ws');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const path         = require('path');
const fs           = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const IS_RENDER    = !!process.env.RENDER;
const LK_URL       = process.env.LIVEKIT_URL        || 'wss://your-project.livekit.cloud';
const LK_KEY       = process.env.LIVEKIT_API_KEY    || 'your-api-key';
const LK_SECRET    = process.env.LIVEKIT_API_SECRET || 'your-api-secret';
const ADMIN_USER   = 'angry';
const ADMIN_PASS   = 'angry0306';
let   OPERATOR_PASS = process.env.OPERATOR_PASSWORD || 'upthrust2024';
const ROOM_NAME    = 'upthrust-main';

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/players', express.static(path.join(__dirname, 'public', 'players')));

let httpServer;
if (!IS_RENDER) {
  try {
    const ssl = {
      key:  fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem')),
    };
    httpServer = https.createServer(ssl, app);
  } catch { httpServer = http.createServer(app); }
} else {
  httpServer = http.createServer(app);
}

const roomService = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);

// ── State ─────────────────────────────────────────────────────────────────────
const cameras     = new Map();   // uid → { playerName, team, slot }
const spectAssign = {};          // spectId → uid
const livePlayers = new Map();   // uid → { playerName, team }
const wsClients   = new Set();
let   booyahTeam  = null;

// ── FF API Polling State ───────────────────────────────────────────────────────
// spectObservers: [ { slot: 1, observerUid: '123' }, ... ]
// Each observer is a spectator PC's FF account UID
// We poll FF API to detect which player each observer is spectating
// then auto-assign spect slots
let ffPolling       = false;
let ffMatchId       = '';
let ffClientId      = 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2';
let ffSpectObservers = [];   // [{ slot, observerUid }]
let ffPollTimer     = null;
let ffLastSpect     = {};    // slot → uid (last known)

// ── LiveKit Token Generator ───────────────────────────────────────────────────
function generateToken(identity, name, canPublish, canSubscribe, metadata = '') {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, name, metadata });
  at.addGrant({
    room: ROOM_NAME, roomJoin: true,
    canPublish, canSubscribe, canPublishData: true,
  });
  return at.toJwt();
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, livekit: LK_URL, ffPolling }));

// Player join
app.post('/api/room/player-join', async (req, res) => {
  const { uid, operatorPassword } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  if (operatorPassword !== OPERATOR_PASS)
    return res.status(403).json({ error: 'Invalid operator password' });
  const cam = cameras.get(uid);
  if (!cam) return res.status(403).json({ error: 'UID not registered. Contact operator.' });
  try {
    const token = await generateToken(
      'player_' + uid, cam.playerName, true, false,
      JSON.stringify({ uid, team: cam.team, slot: cam.slot })
    );
    res.json({ success: true, token, livekitUrl: LK_URL, roomName: ROOM_NAME, playerName: cam.playerName, slot: cam.slot });
  } catch(e) { res.status(500).json({ error: 'Token generation failed' }); }
});

// Admin session
app.post('/api/admin/session', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid credentials' });
  try {
    const token = await generateToken('admin_' + Date.now(), 'Operator', false, true);
    const camList = [];
    cameras.forEach((cam, uid) => camList.push({ uid, ...cam, live: livePlayers.has(uid) }));
    res.json({ success: true, token, livekitUrl: LK_URL, roomName: ROOM_NAME, adminToken: 'admin-' + Date.now(), cameras: camList });
  } catch(e) { res.status(500).json({ error: 'Token generation failed' }); }
});

// Viewer token
app.post('/api/viewer-token', async (req, res) => {
  const { viewerType, spectId } = req.body;
  const identity = (viewerType || 'viewer') + '_' + (spectId || Date.now());
  try {
    const token = await generateToken(identity, identity, false, true);
    res.json({ token, livekitUrl: LK_URL, roomName: ROOM_NAME });
  } catch(e) { res.status(500).json({ error: 'Token generation failed' }); }
});

// Camera management
app.post('/api/room/camera/add', (req, res) => {
  const { uid, playerName, team, slot } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  cameras.set(uid, { playerName: playerName||uid, team: team||'', slot: slot||null });
  res.json({ success: true });
});
app.post('/api/room/camera/bulk-add', (req, res) => {
  const { players } = req.body;
  if (!Array.isArray(players)) return res.status(400).json({ error: 'Expected array' });
  players.forEach(p => { if (p.uid) cameras.set(p.uid, { playerName: p.playerName||p.uid, team: p.team||'', slot: p.slot||null }); });
  res.json({ success: true, added: players.length, total: cameras.size });
});
app.delete('/api/room/camera/:uid', (req, res) => { cameras.delete(req.params.uid); res.json({ success: true }); });
app.delete('/api/room/cameras/all', (req, res) => { cameras.clear(); res.json({ success: true }); });
app.get('/api/room/cameras', (req, res) => {
  const list = [];
  cameras.forEach((cam, uid) => list.push({ uid, ...cam, live: livePlayers.has(uid) }));
  res.json({ cameras: list });
});

// Player live status
app.post('/api/player/online', (req, res) => {
  const { uid, playerName, team } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  livePlayers.set(uid, { playerName, team });
  broadcast({ type: 'player-joined', uid, playerName, team });
  console.log('[LIVE] Online:', uid, playerName);
  res.json({ ok: true });
});
app.post('/api/player/offline', (req, res) => {
  const { uid } = req.body;
  livePlayers.delete(uid);
  broadcast({ type: 'player-left', uid });
  console.log('[LIVE] Offline:', uid);
  res.json({ ok: true });
});
app.get('/api/players/live', (req, res) => {
  const list = [];
  livePlayers.forEach((p, uid) => list.push({ uid, ...p }));
  res.json({ players: list });
});

// Logos + Photos
app.get('/api/logos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logos');
  try {
    const logos = {};
    fs.readdirSync(dir).forEach(f => { logos[path.basename(f, path.extname(f))] = '/logos/' + f; });
    res.json({ logos });
  } catch { res.json({ logos: {} }); }
});
app.get('/api/players/photos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'players');
  try {
    const photos = {};
    fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .forEach(f => { const name = path.basename(f, path.extname(f)); if (!/^[1-4]$/.test(name)) photos[name] = '/players/' + f; });
    res.json({ photos });
  } catch { res.json({ photos: {} }); }
});

// Disconnect player
app.post('/api/admin/disconnect-player', async (req, res) => {
  const { uid } = req.body;
  try {
    await roomService.removeParticipant(ROOM_NAME, 'player_' + uid);
    livePlayers.delete(uid);
    broadcast({ type: 'player-left', uid });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Operator password
app.post('/api/operator-password', (req, res) => {
  const { username, password, newPassword } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Too short' });
  OPERATOR_PASS = newPassword;
  res.json({ success: true });
});
app.get('/api/operator-password', (req, res) => {
  const { username, password } = req.query;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ operatorPassword: OPERATOR_PASS });
});

// Spect assignment
app.post('/api/spect/set', (req, res) => {
  const { spectId, uid } = req.body;
  if (uid) spectAssign[spectId] = uid;
  else     delete spectAssign[spectId];
  broadcast({ type: 'spect-update', spectId, uid: uid || null });
  res.json({ success: true, spectators: spectAssign });
});
app.get('/api/spect/status',   (req, res) => res.json({ spectators: spectAssign }));
app.get('/api/spect/:spectId', (req, res) => res.json({ uid: spectAssign[req.params.spectId] || null }));
app.get('/api/spect/booyah-players', (req, res) => {
  if (!booyahTeam) return res.json({ players: [] });
  const list = [];
  cameras.forEach((cam, uid) => { if (cam.team === booyahTeam) list.push({ uid, playerName: cam.playerName, team: cam.team }); });
  res.json({ players: list.slice(0, 4), teamName: booyahTeam });
});

// Booyah
app.post('/api/booyah/trigger', (req, res) => {
  const { teamName } = req.body;
  booyahTeam = teamName;
  const players = [];
  cameras.forEach((cam, uid) => { if (cam.team === teamName) players.push({ uid, playerName: cam.playerName, team: cam.team }); });
  broadcast({ type: 'booyah-detected', teamName, players: players.slice(0, 4) });
  res.json({ success: true });
});
app.post('/api/booyah/reset', (req, res) => {
  booyahTeam = null;
  broadcast({ type: 'booyah-reset' });
  res.json({ success: true });
});

// ── FF API Spectator Auto-Tracking ────────────────────────────────────────────
// Correct implementation based on FF CG Engine:
//   - Polls Garena batch API every 1 second
//   - Reads spector_info[] from match_stats_extra
//   - Each spector_info entry: spector_id → observer_id (player being watched)
//   - Admin maps: slot number → spector_id (spectator PC's match ID)
//
// Admin sets: { slot: 1, spectorId: "12345" }  ← spectorId = spectator PC's ID in match
// API returns: spector_info[].spector_id + observer_id (who they're watching)
// We match spectorId → find observer_id → look up player name → broadcast spect-update

app.post('/api/spect/config', (req, res) => {
  const { matchId, clientId, spectObservers } = req.body;
  ffMatchId        = matchId  || '';
  ffClientId       = clientId || 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2';
  ffSpectObservers = spectObservers || [];
  // spectObservers: [{ slot: 1, spectorId: "123456" }, ...]
  // spectorId = spectator PC's ID in the FF match (from spector_info[].spector_id)

  if (ffMatchId && ffSpectObservers.length) {
    startFFPolling();
  } else {
    stopFFPolling();
  }
  res.json({ success: true, polling: ffPolling, matchId: ffMatchId, observers: ffSpectObservers });
});

app.get('/api/spect/config', (req, res) => {
  res.json({ polling: ffPolling, matchId: ffMatchId, clientId: ffClientId, observers: ffSpectObservers, spectators: spectAssign });
});

// ── FF API Polling Engine ─────────────────────────────────────────────────────
const FF_API_URL = 'https://suez-ind.garenanow.com/game/freefire/tidy/v1/livematch/br/batch';

function startFFPolling() {
  if (ffPollTimer) clearInterval(ffPollTimer);
  ffPolling = true;
  console.log('[FF] Polling started — match:', ffMatchId, 'spectors:', ffSpectObservers.length);
  pollFFOnce();                               // immediate first poll
  ffPollTimer = setInterval(pollFFOnce, 1000); // every 1 second like CG engine
}

function stopFFPolling() {
  if (ffPollTimer) { clearInterval(ffPollTimer); ffPollTimer = null; }
  ffPolling = false;
  ffLastSpect = {};
  console.log('[FF] Polling stopped');
}

async function pollFFOnce() {
  if (!ffMatchId || !ffSpectObservers.length) return;

  try {
    const url  = `${FF_API_URL}?matchid=${ffMatchId}`;
    const resp = await fetchURL(url, {
      'accept':    'application/json',
      'Client-ID': ffClientId,
    });
    if (!resp) return;
    console.log('[FF POLL] resp bytes:', resp ? resp.length : 'NULL');

    const data       = JSON.parse(resp);
    const matchStats = data?.match_stats?.[0];
    if (!matchStats) return;
    console.log('[FF POLL] match_stats found, match_id:', matchStats?.match?.match_id);

    const extra       = matchStats?.match?.match_stats_extra || {};
    const spectorInfo = extra.spector_info || [];

    if (!spectorInfo.length) { console.log('[FF POLL] empty spector_info'); return; }
    console.log('[FF POLL] spector_info count:', spectorInfo.length);
    console.log('[FF POLL] spector_info:', JSON.stringify(spectorInfo));

    // Build player lookup from all teams: account_id → { playerName, team }
    const playerLookup = {};
    (matchStats.team_stats || []).forEach(team => {
      (team.player_stats || []).forEach(p => {
        playerLookup[String(p.account_id)] = {
          playerName: p.nickname || String(p.account_id),
          team:       team.team_name || '',
        };
      });
    });

    // For each configured observer slot, find who they are watching
    for (const obs of ffSpectObservers) {
      const slotKey   = String(obs.slot);
      const spectorId = String(obs.spectorId || obs.observerUid || '');
      console.log('[FF POLL] Slot', slotKey, '— looking for spectorId:', spectorId);
      if (!spectorId) { console.log('[FF POLL] Slot', slotKey, '— no spectorId configured'); continue; }

      // Find the spector_info entry matching this spectorId
      const allIds = spectorInfo.map(s => String(s.spector_id));
      console.log('[FF POLL] Available spector_ids:', allIds);
      const entry = spectorInfo.find(s => String(s.spector_id) === spectorId);
      if (!entry) { console.log('[FF POLL] Slot', slotKey, '— spectorId', spectorId, 'NOT found in', allIds); continue; }
      console.log('[FF POLL] Slot', slotKey, '— found entry:', JSON.stringify(entry));

      const observerId = String(entry.observer_id || '0');
      if (!observerId || observerId === '0') continue;

      // Look up who they are watching
      // observer_id IS the player's FF account_id
      // cameras map uses player's uid (should be same as account_id)
      const cam        = cameras.get(observerId);
      const lookup     = playerLookup[observerId];
      // Don't skip if player not in cameras — they might not be registered
      // Still broadcast with whatever name we have
      const playerName = cam?.playerName || lookup?.playerName
        || entry.observer_name || observerId;

      // Only update + broadcast if changed
      if (ffLastSpect[slotKey] !== observerId) {
        ffLastSpect[slotKey]  = observerId;
        spectAssign[slotKey]  = observerId;

        broadcast({
          type:       'spect-update',
          spectId:    slotKey,
          uid:        observerId,
          playerName: playerName,
          auto:       true,
        });
        console.log('[FF] Spect', slotKey, '→', playerName, '(uid:', observerId, ')');
      }
    }

  } catch(e) {
    // Silently skip
  }
}

// ── Raw spector info dump (for admin to find spector IDs) ────────────────────
app.get('/api/spect/raw', async (req, res) => {
  const { matchId, clientId } = req.query;
  const mid = matchId || ffMatchId;
  const cid = clientId || ffClientId;
  if (!mid) return res.status(400).json({ error: 'matchId required' });

  try {
    const url = `${FF_API_URL}?matchid=${mid}`;
    console.log('[FF RAW] Fetching:', url, '| Client-ID:', cid);

    const resp = await fetchURL(url, { 'accept': 'application/json', 'Client-ID': cid });
    console.log('[FF RAW] Response:', resp ? resp.length + ' bytes' : 'NULL');
    if (!resp) return res.status(503).json({ error: 'FF API unreachable — null response' });

    // Show first 200 chars of response for debugging
    console.log('[FF RAW] Preview:', resp.slice(0, 200));

    let data;
    try { data = JSON.parse(resp); }
    catch(pe) { return res.status(500).json({ error: 'JSON parse error: ' + pe.message, preview: resp.slice(0,500) }); }

    console.log('[FF RAW] Top-level keys:', Object.keys(data));

    const matchStats = data?.match_stats?.[0];
    if (!matchStats) {
      console.log('[FF RAW] No match_stats found');
      return res.json({ error: 'No match_stats in response', keys: Object.keys(data) });
    }

    console.log('[FF RAW] match_id:', matchStats?.match?.match_id);
    const extra       = matchStats?.match?.match_stats_extra || {};
    const spectorInfo = extra.spector_info || [];
    console.log('[FF RAW] extra keys:', Object.keys(extra));
    console.log('[FF RAW] spector_info:', JSON.stringify(spectorInfo));

    // Build player lookup
    const playerLookup = {};
    (matchStats.team_stats || []).forEach(team => {
      (team.player_stats || []).forEach(p => {
        playerLookup[String(p.account_id)] = { nickname: p.nickname, team: team.team_name };
      });
    });

    // Enrich — show ALL spectors including idle
    const enriched = spectorInfo.map(s => {
      const obsId  = String(s.observer_id || '0');
      const isIdle = !obsId || obsId === '0';
      const lk     = !isIdle ? (playerLookup[obsId] || {}) : {};
      return {
        spector_id:    s.spector_id,
        observer_id:   obsId,
        observer_name: s.observer_name || lk.nickname || (isIdle ? '(idle)' : '?'),
        observer_team: s.observer_team_name || lk.team || '',
        is_idle:       isIdle,
      };
    });

    console.log('[FF RAW] Enriched result:', JSON.stringify(enriched));

    res.json({
      match_id:      mid,
      spector_count: spectorInfo.length,
      spectors:      enriched,
      total_teams:   matchStats.team_stats?.length || 0,
    });
  } catch(e) {
    console.error('[FF RAW] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Simple HTTP GET helper
function fetchURL(url, headers = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      timeout: 5000,
    };
    const req = lib.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end',  () => resolve(data));
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/booyah',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'booyah-cam.html')));
app.get('/camwall',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'camwall.html')));
app.get('/spect:id',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'obs-spect.html')));
app.get('/league-ops', (req, res) => res.sendFile(path.join(__dirname, 'public', 'league-ops.html')));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  wsClients.add(ws);
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register')   ws._role = msg.role || 'viewer';
      if (msg.type === 'ping')       ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'booyah-detected') {
        booyahTeam = msg.teamName;
        broadcast({ type: 'booyah-detected', teamName: msg.teamName, players: msg.players || [] });
      }
      if (msg.type === 'booyah-reset') {
        booyahTeam = null;
        broadcast({ type: 'booyah-reset' });
      }
    } catch {}
  });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', booyahTeam, spectators: spectAssign, ffPolling }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('[SERVER] Running on port', PORT);
  console.log('[SERVER] LiveKit URL:', LK_URL);
  console.log('[SERVER] Render mode:', IS_RENDER);
});
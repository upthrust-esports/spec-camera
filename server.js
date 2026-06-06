'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const { WebSocketServer } = require('ws');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const path         = require('path');
const fs           = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const LK_URL     = process.env.LIVEKIT_URL        || 'wss://upthrustcam-op4vshqy.livekit.cloud';
const LK_KEY     = process.env.LIVEKIT_API_KEY    || 'APIoAYisvBwkMm3';
const LK_SECRET  = process.env.LIVEKIT_API_SECRET || '';   // set in .env
const ADMIN_USER = 'angry';
const ADMIN_PASS = 'angry0306';
let   OPERATOR_PASS = process.env.OPERATOR_PASSWORD || 'upthrust2024';
const ROOM_NAME  = 'upthrust-main';

// ── Express ───────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/players', express.static(path.join(__dirname, 'public', 'players')));

// ── LiveKit ───────────────────────────────────────────────────────────────────
const roomService = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);

function generateToken(identity, name, canPublish, canSubscribe, metadata = '') {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, name, metadata });
  at.addGrant({ room: ROOM_NAME, roomJoin: true, canPublish, canSubscribe, canPublishData: true });
  return at.toJwt();
}

// ── State ─────────────────────────────────────────────────────────────────────
const cameras     = new Map();
const spectAssign = {};
const livePlayers = new Map();
const wsClients   = new Set();
let   booyahTeam  = null;

// ── FF API Polling State ──────────────────────────────────────────────────────
let ffPolling        = false;
let ffMatchId        = '';
let ffClientId       = 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2';
let ffSpectObservers = [];
let ffPollTimer      = null;
let ffLastSpect      = {};

const FF_API_URL = 'https://suez-ind.garenanow.com/game/freefire/tidy/v1/livematch/br/batch';

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

// ── API: Health ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, livekit: LK_URL, ffPolling }));

// ── API: Player join ──────────────────────────────────────────────────────────
app.post('/api/room/player-join', async (req, res) => {
  const { uid, operatorPassword } = req.body;
  if (!uid)                            return res.status(400).json({ error: 'UID required' });
  if (operatorPassword !== OPERATOR_PASS) return res.status(403).json({ error: 'Invalid operator password' });
  const cam = cameras.get(uid);
  if (!cam) return res.status(403).json({ error: 'UID not registered. Contact operator.' });
  try {
    const token = await generateToken(
      'player_' + uid, cam.playerName, true, false,
      JSON.stringify({ uid, team: cam.team, slot: cam.slot })
    );
    res.json({ success: true, token, livekitUrl: LK_URL, roomName: ROOM_NAME, playerName: cam.playerName, slot: cam.slot });
  } catch(e) { res.status(500).json({ error: 'Token error: ' + e.message }); }
});

// ── API: Admin session ────────────────────────────────────────────────────────
app.post('/api/admin/session', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid credentials' });
  try {
    const token = await generateToken('admin_' + Date.now(), 'Operator', false, true);
    const camList = [];
    cameras.forEach((cam, uid) => camList.push({ uid, ...cam, live: livePlayers.has(uid) }));
    res.json({ success: true, token, livekitUrl: LK_URL, roomName: ROOM_NAME, adminToken: 'admin-' + Date.now(), cameras: camList });
  } catch(e) { res.status(500).json({ error: 'Token error: ' + e.message }); }
});

// ── API: Viewer token ─────────────────────────────────────────────────────────
app.post('/api/viewer-token', async (req, res) => {
  const { viewerType, spectId } = req.body;
  const identity = (viewerType || 'viewer') + '_' + (spectId || Date.now());
  try {
    const token = await generateToken(identity, identity, false, true);
    res.json({ token, livekitUrl: LK_URL, roomName: ROOM_NAME });
  } catch(e) { res.status(500).json({ error: 'Token error: ' + e.message }); }
});

// ── API: Camera management ────────────────────────────────────────────────────
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

// ── API: Player live status ───────────────────────────────────────────────────
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

// ── API: Logos + Photos ───────────────────────────────────────────────────────
app.get('/api/logos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logos');
  try {
    const logos = {};
    if (fs.existsSync(dir)) fs.readdirSync(dir).forEach(f => { logos[path.basename(f, path.extname(f))] = '/logos/' + f; });
    res.json({ logos });
  } catch { res.json({ logos: {} }); }
});
app.get('/api/players/photos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'players');
  try {
    const photos = {};
    if (fs.existsSync(dir)) fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .forEach(f => { const n = path.basename(f, path.extname(f)); if (!/^[1-4]$/.test(n)) photos[n] = '/players/' + f; });
    res.json({ photos });
  } catch { res.json({ photos: {} }); }
});

// ── API: Disconnect player ────────────────────────────────────────────────────
app.post('/api/admin/disconnect-player', async (req, res) => {
  const { uid } = req.body;
  try {
    await roomService.removeParticipant(ROOM_NAME, 'player_' + uid);
    livePlayers.delete(uid);
    broadcast({ type: 'player-left', uid });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Operator password ────────────────────────────────────────────────────
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

// ── API: Spect assignment ─────────────────────────────────────────────────────
app.post('/api/spect/set', (req, res) => {
  const { spectId, uid } = req.body;
  if (uid) spectAssign[spectId] = uid;
  else     delete spectAssign[spectId];
  broadcast({ type: 'spect-update', spectId, uid: uid || null });
  res.json({ success: true, spectators: spectAssign });
});
app.get('/api/spect/status',   (req, res) => res.json({ spectators: spectAssign }));
app.get('/api/spect/raw',      async (req, res) => {
  const mid = req.query.matchId || ffMatchId;
  const cid = req.query.clientId || ffClientId;
  if (!mid) return res.status(400).json({ error: 'matchId required' });

  console.log('[FF RAW] Fetching matchId:', mid, '| clientId:', cid);
  const url  = `${FF_API_URL}?matchid=${mid}`;
  const resp = await fetchURL(url, { 'accept': 'application/json', 'Client-ID': cid });
  console.log('[FF RAW] Response:', resp ? resp.length + ' bytes' : 'NULL');

  if (!resp) return res.status(503).json({ error: 'FF API unreachable — check your IP whitelist' });

  let data;
  try { data = JSON.parse(resp); }
  catch(e) { return res.status(500).json({ error: 'JSON parse error', preview: resp.slice(0, 300) }); }

  console.log('[FF RAW] Top-level keys:', Object.keys(data));

  const matchStats = data?.match_stats?.[0];
  if (!matchStats) return res.json({ error: 'No match_stats in response', keys: Object.keys(data) });

  const extra       = matchStats?.match?.match_stats_extra || {};
  const spectorInfo = extra.spector_info || [];
  console.log('[FF RAW] spector_info count:', spectorInfo.length);
  console.log('[FF RAW] spector_info:', JSON.stringify(spectorInfo));

  const playerLookup = {};
  (matchStats.team_stats || []).forEach(team => {
    (team.player_stats || []).forEach(p => {
      playerLookup[String(p.account_id)] = { nickname: p.nickname, team: team.team_name };
    });
  });

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

  console.log('[FF RAW] Enriched:', JSON.stringify(enriched));
  res.json({ match_id: mid, spector_count: spectorInfo.length, spectors: enriched, total_teams: matchStats.team_stats?.length || 0 });
});
app.get('/api/spect/booyah-players', (req, res) => {
  if (!booyahTeam) return res.json({ players: [] });
  const list = [];
  cameras.forEach((cam, uid) => { if (cam.team === booyahTeam) list.push({ uid, playerName: cam.playerName, team: cam.team }); });
  res.json({ players: list.slice(0, 4), teamName: booyahTeam });
});
// ── FF Spect Config GET ──────────────────────────────────────────────────────
app.get('/api/spect/config', (req, res) => {
  res.json({ polling: ffPolling, matchId: ffMatchId, clientId: ffClientId, observers: ffSpectObservers, spectators: spectAssign });
});
// ⚠️ Wildcard :spectId MUST be last
app.get('/api/spect/:spectId', (req, res) => res.json({ uid: spectAssign[req.params.spectId] || null }));

// ── API: Booyah ───────────────────────────────────────────────────────────────
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

// ── API: FF Spect Config ──────────────────────────────────────────────────────
app.post('/api/spect/config', (req, res) => {
  const { matchId, clientId, spectObservers } = req.body;
  ffMatchId        = matchId  || '';
  ffClientId       = clientId || 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2';
  ffSpectObservers = spectObservers || [];
  if (ffMatchId && ffSpectObservers.length) startFFPolling();
  else stopFFPolling();
  res.json({ success: true, polling: ffPolling, matchId: ffMatchId, observers: ffSpectObservers });
});


// /api/spect/raw — moved above :spectId wildcard to fix routing

// ── FF Polling Engine ─────────────────────────────────────────────────────────
function startFFPolling() {
  if (ffPollTimer) clearInterval(ffPollTimer);
  ffPolling   = true;
  ffLastSpect = {};
  console.log('[FF] Polling started — match:', ffMatchId, '| spectors:', ffSpectObservers.length);
  pollFFOnce();
  ffPollTimer = setInterval(pollFFOnce, 500);
}

function stopFFPolling() {
  if (ffPollTimer) { clearInterval(ffPollTimer); ffPollTimer = null; }
  ffPolling   = false;
  ffLastSpect = {};
  console.log('[FF] Polling stopped');
}

async function pollFFOnce() {
  if (!ffMatchId || !ffSpectObservers.length) return;

  try {
    const url  = `${FF_API_URL}?matchid=${ffMatchId}`;
    const resp = await fetchURL(url, { 'accept': 'application/json', 'Client-ID': ffClientId });

    if (!resp) { console.log('[FF POLL] null response'); return; }

    let data;
    try { data = JSON.parse(resp); } catch(e) { console.log('[FF POLL] parse error:', e.message); return; }

    const matchStats  = data?.match_stats?.[0];
    if (!matchStats)  { console.log('[FF POLL] no match_stats'); return; }

    const extra       = matchStats?.match?.match_stats_extra || {};
    const spectorInfo = extra.spector_info || [];

    if (!spectorInfo.length) return;

    // Build player lookup: account_id → { playerName, team }
    const playerLookup = {};
    (matchStats.team_stats || []).forEach(team => {
      (team.player_stats || []).forEach(p => {
        playerLookup[String(p.account_id)] = { playerName: p.nickname || String(p.account_id), team: team.team_name || '' };
      });
    });

    for (const obs of ffSpectObservers) {
      const slotKey   = String(obs.slot);
      const spectorId = String(obs.spectorId || obs.observerUid || '');
      if (!spectorId) continue;

      const allIds = spectorInfo.map(s => String(s.spector_id));
      const entry  = spectorInfo.find(s => String(s.spector_id) === spectorId);

      if (!entry) {
        console.log('[FF POLL] Slot', slotKey, '— spectorId', spectorId, 'not found. Available:', allIds.join(', '));
        continue;
      }

      const observerId = String(entry.observer_id || '0');
      if (!observerId || observerId === '0') continue;

      if (ffLastSpect[slotKey] === observerId) continue; // no change

      ffLastSpect[slotKey]  = observerId;
      spectAssign[slotKey]  = observerId;

      const cam        = cameras.get(observerId);
      const lk         = playerLookup[observerId];
      const playerName = cam?.playerName || lk?.playerName || entry.observer_name || observerId;

      broadcast({ type: 'spect-update', spectId: slotKey, uid: observerId, playerName, auto: true });
      console.log('[FF POLL] Slot', slotKey, '→', playerName, '( uid:', observerId, ')');
    }

  } catch(e) { /* silent */ }
}

// ── HTTP GET helper ───────────────────────────────────────────────────────────
function fetchURL(url, headers = {}) {
  return new Promise((resolve) => {
    const lib  = url.startsWith('https') ? require('https') : require('http');
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 5000 };
    const req  = lib.get(url, opts, (res) => {
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
      if (msg.type === 'register')        ws._role = msg.role || 'viewer';
      if (msg.type === 'ping')            ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'booyah-detected') { booyahTeam = msg.teamName; broadcast({ type: 'booyah-detected', teamName: msg.teamName, players: msg.players || [] }); }
      if (msg.type === 'booyah-reset')    { booyahTeam = null; broadcast({ type: 'booyah-reset' }); }
    } catch {}
  });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', booyahTeam, spectators: spectAssign, ffPolling }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('  Upthrust Esports Camera Server');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin.html`);
  console.log(`  LiveKit: ${LK_URL}`);
  console.log('='.repeat(50));
});
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
const LK_URL       = process.env.LIVEKIT_URL    || 'wss://your-project.livekit.cloud';
const LK_KEY       = process.env.LIVEKIT_API_KEY    || 'your-api-key';
const LK_SECRET    = process.env.LIVEKIT_API_SECRET || 'your-api-secret';
const ADMIN_USER   = 'angry';
const ADMIN_PASS   = 'angry0306';
let   OPERATOR_PASS = process.env.OPERATOR_PASSWORD || 'upthrust2024';
const ROOM_NAME    = 'upthrust-main'; // single LiveKit room for all players

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
  } catch {
    httpServer = http.createServer(app);
  }
} else {
  httpServer = http.createServer(app);
}

// ── LiveKit Room Service (for admin operations) ───────────────────────────────
const roomService = new RoomServiceClient(LK_URL, LK_KEY, LK_SECRET);

// ── State ─────────────────────────────────────────────────────────────────────
// cameras: pre-registered players (uid → { playerName, team, slot })
const cameras   = new Map();
// spectAssign: slot → uid
const spectAssign = {};
// booyah state
let   booyahTeam = null;
// ws clients for server→browser notifications
const wsClients = new Set();
// track which players are currently live (joined LiveKit room)
const livePlayers = new Map(); // uid → { playerName, team }

// ── LiveKit Token Generator ───────────────────────────────────────────────────
function generateToken(identity, name, canPublish, canSubscribe, metadata = '') {
  const at = new AccessToken(LK_KEY, LK_SECRET, {
    identity,
    name,
    metadata,
  });
  at.addGrant({
    room:             ROOM_NAME,
    roomJoin:         true,
    canPublish,
    canSubscribe,
    canPublishData:   true,
  });
  return at.toJwt();
}

// ── Broadcast to all WS clients ───────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}
function broadcastAdmins(data) {
  wsClients.forEach(ws => {
    if (ws.readyState === 1 && ws._role === 'admin') ws.send(JSON.stringify(data));
  });
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, livekit: LK_URL }));

// ── Player: get LiveKit token to publish camera ───────────────────────────────
app.post('/api/room/player-join', async (req, res) => {
  const { uid, operatorPassword } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  if (operatorPassword !== OPERATOR_PASS)
    return res.status(403).json({ error: 'Invalid operator password' });

  const cam = cameras.get(uid);
  if (!cam) return res.status(403).json({ error: 'UID not registered. Contact operator.' });

  try {
    // Generate token — player can publish (send camera) but not subscribe (save bandwidth)
    const token = await generateToken(
      'player_' + uid,       // identity
      cam.playerName,        // display name
      true,                  // canPublish = YES (player sends camera)
      false,                 // canSubscribe = NO (player doesn't receive others)
      JSON.stringify({ uid, team: cam.team, slot: cam.slot })
    );
    res.json({
      success:      true,
      token,
      livekitUrl:   LK_URL,
      roomName:     ROOM_NAME,
      playerName:   cam.playerName,
      slot:         cam.slot,
    });
  } catch(e) {
    console.error('Token error:', e);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

// ── Admin: get LiveKit token to subscribe to all cameras ──────────────────────
app.post('/api/admin/session', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid credentials' });

  try {
    const token = await generateToken(
      'admin_' + Date.now(),
      'Operator',
      false,  // canPublish = NO (admin just watches)
      true,   // canSubscribe = YES (admin sees all cameras)
    );
    const camList = [];
    cameras.forEach((cam, uid) => {
      camList.push({ uid, ...cam, live: livePlayers.has(uid) });
    });
    res.json({
      success:    true,
      token,
      livekitUrl: LK_URL,
      roomName:   ROOM_NAME,
      adminToken: 'admin-' + Date.now(),
      cameras:    camList,
    });
  } catch(e) {
    res.status(500).json({ error: 'Token generation failed' });
  }
});

// ── Viewer token (booyah cam, camwall, spect overlays) ────────────────────────
app.post('/api/viewer-token', async (req, res) => {
  const { viewerType, spectId } = req.body;
  const identity = viewerType + '_' + (spectId || Date.now());
  try {
    const token = await generateToken(
      identity,
      identity,
      false,  // can't publish
      true,   // can subscribe to all
    );
    res.json({ token, livekitUrl: LK_URL, roomName: ROOM_NAME });
  } catch(e) {
    res.status(500).json({ error: 'Token generation failed' });
  }
});

// ── Camera management ─────────────────────────────────────────────────────────
app.post('/api/room/camera/add', (req, res) => {
  const { uid, playerName, team, slot } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  cameras.set(uid, { playerName: playerName||uid, team: team||'', slot: slot||null });
  res.json({ success: true });
});

app.post('/api/room/camera/bulk-add', (req, res) => {
  const { players } = req.body;
  if (!Array.isArray(players)) return res.status(400).json({ error: 'Expected array' });
  players.forEach(p => {
    if (p.uid) cameras.set(p.uid, { playerName: p.playerName||p.uid, team: p.team||'', slot: p.slot||null });
  });
  res.json({ success: true, added: players.length, total: cameras.size });
});

app.delete('/api/room/camera/:uid', (req, res) => {
  cameras.delete(req.params.uid);
  res.json({ success: true });
});

app.delete('/api/room/cameras/all', (req, res) => {
  cameras.clear();
  res.json({ success: true });
});

app.get('/api/room/cameras', (req, res) => {
  const list = [];
  cameras.forEach((cam, uid) => list.push({ uid, ...cam, live: livePlayers.has(uid) }));
  res.json({ cameras: list });
});

// ── Player live status (called by LiveKit webhooks or client notify) ──────────
app.post('/api/player/online', (req, res) => {
  const { uid, playerName, team } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });
  livePlayers.set(uid, { playerName, team });
  broadcast({ type: 'player-joined', uid, playerName, team });
  console.log('[LIVE] Player online:', uid, playerName);
  res.json({ ok: true });
});

app.post('/api/player/offline', (req, res) => {
  const { uid } = req.body;
  livePlayers.delete(uid);
  broadcast({ type: 'player-left', uid });
  console.log('[LIVE] Player offline:', uid);
  res.json({ ok: true });
});

app.get('/api/players/live', (req, res) => {
  const list = [];
  livePlayers.forEach((p, uid) => list.push({ uid, ...p }));
  res.json({ players: list });
});

// ── Logos + Photos ────────────────────────────────────────────────────────────
app.get('/api/logos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logos');
  try {
    const logos = {};
    fs.readdirSync(dir).forEach(f => {
      logos[path.basename(f, path.extname(f))] = '/logos/' + f;
    });
    res.json({ logos });
  } catch { res.json({ logos: {} }); }
});

app.get('/api/players/photos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'players');
  try {
    const photos = {};
    fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .forEach(f => {
        const name = path.basename(f, path.extname(f));
        if (!/^[1-4]$/.test(name)) photos[name] = '/players/' + f;
      });
    res.json({ photos });
  } catch { res.json({ photos: {} }); }
});

// ── Admin: force disconnect player ───────────────────────────────────────────
app.post('/api/admin/disconnect-player', async (req, res) => {
  const { uid } = req.body;
  try {
    // Remove from LiveKit room
    await roomService.removeParticipant(ROOM_NAME, 'player_' + uid);
    livePlayers.delete(uid);
    broadcast({ type: 'player-left', uid });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Operator password ─────────────────────────────────────────────────────────
app.post('/api/operator-password', (req, res) => {
  const { username, password, newPassword } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Unauthorized' });
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Too short' });
  OPERATOR_PASS = newPassword;
  res.json({ success: true });
});
app.get('/api/operator-password', (req, res) => {
  const { username, password } = req.query;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Unauthorized' });
  res.json({ operatorPassword: OPERATOR_PASS });
});

// ── Spect assignment ──────────────────────────────────────────────────────────
app.post('/api/spect/set', (req, res) => {
  const { spectId, uid } = req.body;
  if (uid) spectAssign[spectId] = uid;
  else     delete spectAssign[spectId];
  broadcast({ type: 'spect-update', spectId, uid: uid || null });
  res.json({ success: true, spectators: spectAssign });
});
app.get('/api/spect/status',    (req, res) => res.json({ spectators: spectAssign }));
app.get('/api/spect/:spectId',  (req, res) => res.json({ uid: spectAssign[req.params.spectId] || null }));
app.get('/api/spect/booyah-players', (req, res) => {
  if (!booyahTeam) return res.json({ players: [] });
  const list = [];
  cameras.forEach((cam, uid) => {
    if (cam.team === booyahTeam) list.push({ uid, playerName: cam.playerName, team: cam.team });
  });
  res.json({ players: list.slice(0, 4), teamName: booyahTeam });
});

// ── Booyah ────────────────────────────────────────────────────────────────────
app.post('/api/booyah/trigger', (req, res) => {
  const { teamName } = req.body;
  booyahTeam = teamName;
  const players = [];
  cameras.forEach((cam, uid) => {
    if (cam.team === teamName) players.push({ uid, playerName: cam.playerName, team: cam.team });
  });
  broadcast({ type: 'booyah-detected', teamName, players: players.slice(0, 4) });
  res.json({ success: true });
});
app.post('/api/booyah/reset', (req, res) => {
  booyahTeam = null;
  broadcast({ type: 'booyah-reset' });
  res.json({ success: true });
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/booyah',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'booyah-cam.html')));
app.get('/camwall',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'camwall.html')));
app.get('/spect:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'obs-spect.html')));

// ── WebSocket (for real-time notifications to browser) ────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  wsClients.add(ws);

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        ws._role = msg.role || 'viewer';
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      // Admin booyah actions
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

  // Send current state on connect
  ws.send(JSON.stringify({ type: 'connected', booyahTeam, spectators: spectAssign }));
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('[SERVER] Running on port', PORT);
  console.log('[SERVER] LiveKit URL:', LK_URL);
  console.log('[SERVER] Render mode:', IS_RENDER);
});
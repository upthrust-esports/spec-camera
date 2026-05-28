const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const http       = require('http');
const https      = require('https');
const selfsigned = require('selfsigned');
const { WebSocketServer } = require('ws');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();

// Auto-generate or load SSL cert (skip on Render — they handle SSL)
let server;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');
const IS_RENDER = !!process.env.RENDER;

if (!IS_RENDER && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const sslOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  server = https.createServer(sslOptions, app);
  console.log('🔒 HTTPS mode — loaded cert.pem + key.pem');
} else if (!IS_RENDER) {
  console.log('🔑 Generating self-signed SSL certificate...');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems  = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath,  pems.private);
  server = https.createServer({ cert: pems.cert, key: pems.private }, app);
  console.log('🔒 HTTPS mode — auto-generated self-signed cert');
} else {
  // Render handles SSL externally — use plain HTTP internally
  server = http.createServer(app);
  console.log('☁️  HTTP mode (Render handles SSL externally)');
}

const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ──────────────────────────────────────────────────────────
const rooms         = new Map();
const playerCameras = new Map();
const latestOffers  = new Map();
const peers         = new Map();
const spectators    = new Map();
const spectConfigs  = new Map();
const spectPollers  = new Map();
const booyahDetected = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function roomKey(n, p) { return n + '::' + p; }
function getPeers(key) { if (!peers.has(key)) peers.set(key, new Map()); return peers.get(key); }
function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcastAdmins(key, msg) { getPeers(key).forEach((ws, id) => { if (id.startsWith('admin:')) sendTo(ws, msg); }); }
function broadcastAll(key, msg) { getPeers(key).forEach((ws) => sendTo(ws, msg)); }

// ─── REST: Room Create ────────────────────────────────────────────────────────
app.post('/api/room/create', (req, res) => {
  const { adminSecret, roomName, roomPassword } = req.body;
  if ((process.env.ADMIN_SECRET || 'upthrust_admin') !== adminSecret)
    return res.status(401).json({ error: 'Unauthorized' });
  if (!roomName || !roomPassword)
    return res.status(400).json({ error: 'roomName and roomPassword required' });
  const key = roomKey(roomName, roomPassword);
  if (rooms.has(key)) return res.status(409).json({ error: 'Room already exists' });
  const adminToken = crypto.randomBytes(24).toString('hex');
  rooms.set(key, { roomName, roomPassword, adminToken, createdAt: Date.now() });
  playerCameras.set(key, []);
  return res.json({ success: true, roomName, adminToken });
});

// ─── REST: Admin Login ────────────────────────────────────────────────────────
app.post('/api/room/admin-login', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.body;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room || room.adminToken !== adminToken)
    return res.status(403).json({ error: 'Invalid room or admin token' });
  return res.json({ success: true, role: 'admin', roomName, cameras: playerCameras.get(key) || [] });
});

// ─── REST: Player Join ────────────────────────────────────────────────────────
app.post('/api/room/player-join', (req, res) => {
  const { uid, operatorPassword } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });

  // Validate operator password
  if (!operatorPassword || operatorPassword !== OPERATOR_PASSWORD) {
    return res.status(403).json({ error: 'Invalid operator password. Contact your operator.' });
  }

  for (const [key, room] of rooms.entries()) {
    const reg = (playerCameras.get(key) || []).find(c => c.uid === uid);
    if (reg) {
      return res.json({ success: true, role: 'player', playerName: reg.playerName, slot: reg.slot, roomName: room.roomName, roomPassword: room.roomPassword });
    }
  }
  return res.status(403).json({ error: 'UID not registered. Contact your operator.' });
});

// ─── REST: Add camera ────────────────────────────────────────────────────────
app.post('/api/room/camera/add', (req, res) => {
  const { roomName, roomPassword, adminToken, playerName, uid, slot, team } = req.body;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  const cameras = playerCameras.get(key);
  const idx = cameras.findIndex(c => c.uid === uid);
  const cam = { playerName, uid, slot, team: team||'', addedAt: Date.now() };
  if (idx >= 0) cameras[idx] = cam; else cameras.push(cam);
  playerCameras.set(key, cameras);
  return res.json({ success: true, cameras });
});

// ─── REST: Bulk add cameras ───────────────────────────────────────────────────
app.post('/api/room/camera/bulk-add', (req, res) => {
  const { roomName, roomPassword, adminToken, players } = req.body;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  if (!Array.isArray(players)) return res.status(400).json({ error: 'players must be array' });
  const cameras = playerCameras.get(key);
  let added = 0;
  for (const p of players) {
    if (!p.playerName || !p.uid) continue;
    const idx = cameras.findIndex(c => c.uid === p.uid);
    const cam = { playerName: p.playerName, uid: p.uid, slot: p.slot||cameras.length+1, team: p.team||'', addedAt: Date.now() };
    if (idx >= 0) cameras[idx] = cam; else { cameras.push(cam); added++; }
  }
  playerCameras.set(key, cameras);
  return res.json({ success: true, added, total: cameras.length, cameras });
});

// ─── REST: Clear all cameras ──────────────────────────────────────────────────
app.delete('/api/room/cameras/all', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  playerCameras.set(key, []);
  return res.json({ success: true, cameras: [] });
});

// ─── REST: Remove camera ──────────────────────────────────────────────────────
app.delete('/api/room/camera/:uid', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  playerCameras.set(key, (playerCameras.get(key)||[]).filter(c => c.uid !== req.params.uid));
  return res.json({ success: true, cameras: playerCameras.get(key) });
});

// ─── REST: Get cameras ────────────────────────────────────────────────────────
app.get('/api/room/cameras', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  return res.json({ cameras: playerCameras.get(key) || [] });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

// ─── Public endpoint: booyah players for booyah-cam overlay ──────────────────
app.get('/api/spect/booyah-players', (req, res) => {
  const { room, pass } = req.query;
  const key = roomKey(room || 'test', pass || 'test');
  if (!rooms.has(key)) {
    // try first available room
    if (!rooms.size) return res.json({ players: [] });
    const [k] = [...rooms.keys()];
    const cameras = (playerCameras.get(k) || []).slice(0, 4).map(c => ({
      uid: c.uid, playerName: c.playerName, team: c.team
    }));
    return res.json({ players: cameras });
  }
  const cameras = (playerCameras.get(key) || []).slice(0, 4).map(c => ({
    uid: c.uid, playerName: c.playerName, team: c.team
  }));
  return res.json({ players: cameras });
});

// ─── TURN credentials endpoint ────────────────────────────────────────────────
// Set these on Render: TURN_URL, TURN_USERNAME, TURN_CREDENTIAL
app.get('/api/turn-config', (req, res) => {
  const turnUrl        = process.env.TURN_URL        || 'openrelay.metered.ca';
  const turnUsername   = process.env.TURN_USERNAME   || 'openrelayproject';
  const turnCredential = process.env.TURN_CREDENTIAL || 'openrelayproject';

  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:' + turnUrl + ':80',  username: turnUsername, credential: turnCredential },
      { urls: 'turn:' + turnUrl + ':443', username: turnUsername, credential: turnCredential },
      { urls: 'turn:' + turnUrl + ':443?transport=tcp', username: turnUsername, credential: turnCredential },
      { urls: 'turns:' + turnUrl + ':443', username: turnUsername, credential: turnCredential },
    ]
  });
});

// ─── REST: Player photos ──────────────────────────────────────────────────────
app.get('/api/players/photos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'players');
  if (!fs.existsSync(dir)) return res.json({ photos: {} });
  const photos = {};
  fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).forEach(f => {
    photos[f.replace(/\.[^.]+$/, '')] = '/players/' + f;
  });
  res.json({ photos });
});

// ─── REST: Team logos ─────────────────────────────────────────────────────────
app.get('/api/logos', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logos');
  if (!fs.existsSync(dir)) return res.json({ logos: {} });
  const logos = {};
  fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|svg|webp)$/i.test(f)).forEach(f => {
    logos[f.replace(/\.[^.]+$/, '')] = '/logos/' + f;
  });
  res.json({ logos });
});

// ─── Short URLs ───────────────────────────────────────────────────────────────
for (let i = 1; i <= 6; i++) {
  app.get('/spect' + i, (req, res) => res.sendFile(path.join(__dirname, 'public', 'obs-spect.html')));
}
app.get('/booyah', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booyah-cam.html')));

// ─── FF API Polling ───────────────────────────────────────────────────────────
const FF_CONFIG = {
  clientId:  process.env.FF_CLIENT_ID || 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2',
  garenaUrl: 'https://suez-ind.garenanow.com/game/freefire/tidy/v1/livematch/br/batch',
  pollMs:    1000,
};

async function pollGarenaForSpect(rKey) {
  const cfg = spectConfigs.get(rKey);
  if (!cfg || !cfg.matchId || !cfg.spectObservers.length) return;
  try {
    const res  = await fetch(FF_CONFIG.garenaUrl + '?matchid=' + cfg.matchId, { headers: { 'Client-ID': FF_CONFIG.clientId } });
    if (!res.ok) return;
    const data = await res.json();
    const matches = data.data || data.match_data || [];
    const allSpectors = [];
    for (const m of matches) { const si = m.spector_info || m.spectator_info || []; allSpectors.push(...si); }
    const cameras = playerCameras.get(rKey) || [];
    const s = spectators.get(rKey) || {};
    let changed = false;
    for (const obs of cfg.spectObservers) {
      const entry = allSpectors.find(si => String(si.observer_id) === String(obs.observerUid) || String(si.account_id) === String(obs.observerUid));
      const watchedUid = entry ? String(entry.target_id || entry.spectate_id || '') : null;
      const cam = watchedUid ? cameras.find(c => String(c.uid) === watchedUid) : null;
      const assignUid = cam ? cam.uid : null;
      const slotKey = String(obs.slot);
      if (assignUid !== s[slotKey]) {
        if (assignUid) s[slotKey] = assignUid; else delete s[slotKey];
        changed = true;
        console.log('[SPECT] Slot ' + obs.slot + ' -> ' + (assignUid||'none'));
      }
    }
    if (changed) { spectators.set(rKey, s); broadcastAll(rKey, { type: 'spect-update-all', spectators: s }); }
    const booyahTeam = (matches[0] && matches[0].teams || []).find(t => t.booyah);
    if (booyahTeam && !booyahDetected.has(rKey)) {
      booyahDetected.add(rKey);
      const bPlayers = (booyahTeam.players || []).map(p => {
        const uid = String(p.account_id || '');
        const c = cameras.find(x => String(x.uid) === uid);
        return { uid, playerName: c ? c.playerName : (p.nickname || uid) };
      }).slice(0, 4);
      broadcastAll(rKey, { type: 'booyah-detected', teamName: booyahTeam.team_name || '', teamLogo: null, players: bPlayers });
    }
    if (!booyahTeam) booyahDetected.delete(rKey);
  } catch(e) {}
}

function startSpectPolling(rKey) {
  if (spectPollers.has(rKey)) return;
  spectPollers.set(rKey, setInterval(() => pollGarenaForSpect(rKey), FF_CONFIG.pollMs));
  console.log('[SPECT] Polling started for: ' + rKey);
}
function stopSpectPolling(rKey) {
  const id = spectPollers.get(rKey);
  if (id) { clearInterval(id); spectPollers.delete(rKey); }
}

// ─── REST: Spect config ───────────────────────────────────────────────────────
app.post('/api/spect/config', (req, res) => {
  const { roomName, roomPassword, adminToken, matchId, spectObservers } = req.body;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  spectConfigs.set(key, { matchId, spectObservers: spectObservers || [] });
  if (matchId && spectObservers && spectObservers.length) { startSpectPolling(key); }
  else { stopSpectPolling(key); }
  return res.json({ success: true, polling: spectPollers.has(key) });
});

app.get('/api/spect/config', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  return res.json({ ...(spectConfigs.get(key) || { matchId: '', spectObservers: [] }), polling: spectPollers.has(key) });
});

app.post('/api/spect/set', (req, res) => {
  const { roomName, roomPassword, adminToken, spectId, uid } = req.body;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  if (!spectators.has(key)) spectators.set(key, {});
  const s = spectators.get(key);
  if (uid) s[spectId] = uid; else delete s[spectId];
  broadcastAll(key, { type: 'spect-update', spectId, uid: uid || null });
  return res.json({ success: true, spectators: s });
});

app.get('/api/spect/status', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  return res.json({ spectators: spectators.get(key) || {} });
});

app.get('/api/spect/:spectId', (req, res) => {
  const { roomName, roomPassword } = req.query;
  const key = roomKey(roomName, roomPassword);
  if (!rooms.has(key)) return res.status(403).json({ error: 'Room not found' });
  const s = spectators.get(key) || {};
  const uid = s[req.params.spectId] || null;
  const player = (playerCameras.get(key)||[]).find(c => c.uid === uid) || null;
  return res.json({ spectId: req.params.spectId, uid, player });
});

// ─── Admin session ────────────────────────────────────────────────────────────
const ADMIN_USERNAME   = 'angry';
const ADMIN_PASSWORD   = 'angry0306';
// Operator password — mutable at runtime
let OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || 'upthrust2024';

// ─── REST: Change operator password (admin only) ──────────────────────────────
app.post('/api/operator-password', (req, res) => {
  const { username, password, newPassword } = req.body;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  OPERATOR_PASSWORD = newPassword;
  console.log('[ADMIN] Operator password changed');
  return res.json({ success: true, message: 'Password updated' });
});

// ─── REST: Get current operator password (admin only) ─────────────────────────
app.get('/api/operator-password', (req, res) => {
  const { username, password } = req.query;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ operatorPassword: OPERATOR_PASSWORD });
});

app.post('/api/admin/session', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid credentials' });
  if (!rooms.size)
    return res.status(404).json({ error: 'No rooms exist yet.' });
  const [key, room] = [...rooms.entries()][0];
  return res.json({ success: true, roomName: room.roomName, roomPassword: room.roomPassword, adminToken: room.adminToken, cameras: playerCameras.get(key) || [] });
});

// ─── WebSocket Signaling ──────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let wsRoom = null, wsId = null, wsRole = null, wsUid = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const key = roomKey(msg.roomName, msg.roomPassword);

    // ── Admin force-disconnect a player camera ───────────────────────────────
    if (msg.type === 'admin-disconnect-player') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      const playerWs = getPeers(key).get('uid:' + msg.uid);
      if (playerWs) {
        sendTo(playerWs, { type: 'force-disconnect', reason: msg.reason || 'Disconnected by admin' });
        console.log('[ADMIN] Force disconnected player: ' + msg.uid);
      }
      // Also notify all admins that this player was disconnected
      broadcastAdmins(key, { type: 'player-force-disconnected', uid: msg.uid });
      return;
    }

    // ── Ping / keepalive ─────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      sendTo(ws, { type:'pong' });
      return;
    }

    if (msg.type === 'register-player') {
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });
      const reg = (playerCameras.get(key)||[]).find(c => c.uid === msg.uid);
      if (!reg) return sendTo(ws, { type:'error', message:'UID not registered' });
      wsRoom = key; wsId = 'uid:' + msg.uid; wsRole = 'player'; wsUid = msg.uid;
      getPeers(key).set(wsId, ws);
      sendTo(ws, { type:'registered', playerName: reg.playerName, slot: reg.slot });
      broadcastAdmins(key, { type:'player-joined', uid: msg.uid, playerName: reg.playerName, slot: reg.slot, team: reg.team });
      return;
    }

    if (msg.type === 'test-booyah') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      booyahDetected.add(key);
      broadcastAll(key, { type:'booyah-detected', teamName: msg.teamName||'TEST', teamLogo:null, players: msg.players||[] });
      return;
    }

    if (msg.type === 'reset-booyah') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      booyahDetected.delete(key);
      broadcastAll(key, { type:'booyah-reset' });
      return;
    }

    if (msg.type === 'register-booyah-cam') {
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });
      wsRoom = key; wsId = 'booyah:' + Date.now(); wsRole = 'obs';
      getPeers(key).set(wsId, ws);
      sendTo(ws, { type:'booyah-registered' });
      if (booyahDetected.has(key)) sendTo(ws, { type:'booyah-detected', teamName:'', players:[] });
      // Tell admins booyah cam connected — so they relay existing streams
      broadcastAdmins(key, { type:'booyah-registered' });
      // Send all stored offers so booyah cam connects immediately
      if (latestOffers.has(key)) {
        Object.entries(latestOffers.get(key)).forEach(([uid, sdp]) => {
          sendTo(ws, { type:'offer', uid, sdp });
        });
      }
      // Tell all players to re-send offer
      getPeers(key).forEach((pws, id) => {
        if (id.startsWith('uid:')) sendTo(pws, { type:'admin-joined' });
      });
      return;
    }

    if (msg.type === 'register-obs') {
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });
      wsRoom = key; wsId = 'obs:' + msg.spectId; wsRole = 'obs';
      getPeers(key).set(wsId, ws);
      const uid = (spectators.get(key)||{})[msg.spectId] || null;
      sendTo(ws, { type:'obs-registered', spectId: msg.spectId, uid });
      // Notify admins so they can relay the correct stream to this spect
      const _slotNum = parseInt(String(msg.spectId).replace(/[^0-9]/g,'')) || 0;
      broadcastAdmins(key, { type:'spect-viewer-registered', spectId: 'SPECT'+_slotNum, uid });
      return;
    }

    // obs-ready: spect viewer is ready, tell admin to relay the stream
    if (msg.type === 'obs-ready') {
      const rawId = String(msg.spectId || '');
      if (rawId === 'booyah') {
        // Booyah cam requesting stream — tell admin to relay
        broadcastAdmins(key, { type:'booyah-registered' });
        // Also tell admin to relay this specific uid to booyah
        broadcastAdmins(key, { type:'spect-viewer-registered', spectId:'booyah', uid: msg.uid });
      } else {
        // Normalize spect slot to SPECT{n} format
        const slotNum = parseInt(rawId.replace(/[^0-9]/g,'')) || 0;
        const spectId = 'SPECT' + slotNum;
        broadcastAdmins(key, { type:'spect-viewer-registered', spectId, uid: msg.uid });
      }
      return;
    }

    if (msg.type === 'obs-request-stream') {
      const playerWs = getPeers(key).get('uid:' + msg.uid);
      if (playerWs) {
        sendTo(playerWs, { type:'obs-offer-request', spectId: msg.spectId });
        // Also immediately replay latest offer if we have it
        if (latestOffers.has(key) && latestOffers.get(key)[msg.uid]) {
          sendTo(ws, { type:'offer', uid: msg.uid, sdp: latestOffers.get(key)[msg.uid] });
        }
      } else {
        // Player not online — send error but don't block
        console.log('[OBS] Player not online for stream:', msg.uid);
      }
      return;
    }

    if (msg.type === 'register-admin') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken)
        return sendTo(ws, { type:'error', message:'Invalid admin token' });
      wsRoom = key; wsId = 'admin:' + msg.adminToken; wsRole = 'admin';
      getPeers(key).set(wsId, ws);
      const rp = getPeers(key);
      const online = [];
      rp.forEach((_, id) => { if (id.startsWith('uid:')) online.push(id.slice(4)); });
      sendTo(ws, { type:'admin-registered', onlinePlayers: online });
      // Notify players admin connected
      rp.forEach((pws, id) => { if (id.startsWith('uid:')) sendTo(pws, { type:'admin-joined' }); });
      // Replay stored offers to admin
      if (latestOffers.has(key)) {
        Object.entries(latestOffers.get(key)).forEach(([uid, sdp]) => sendTo(ws, { type:'offer', uid, sdp }));
      }
      return;
    }

    if (msg.type === 'offer') {
      if (msg.target === 'obs' && msg.spectId) {
        sendTo(getPeers(key).get('obs:' + msg.spectId), { type:'offer', uid: msg.uid, sdp: msg.sdp });
      } else {
        broadcastAdmins(key, { type:'offer', uid: msg.uid, sdp: msg.sdp });
        if (!latestOffers.has(key)) latestOffers.set(key, {});
        latestOffers.get(key)[msg.uid] = msg.sdp;
        // Forward to booyah cam
        getPeers(key).forEach((pws, id) => {
          if (id.startsWith('booyah:')) sendTo(pws, { type:'offer', uid: msg.uid, sdp: msg.sdp });
        });
      }
      return;
    }

    // relay-offer: admin sends offer to a viewer (booyah/spect) on behalf of player
    if (msg.type === 'relay-offer') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      const viewerId = msg.viewerId || 'booyah';
      let targetWs = null;
      if (viewerId === 'booyah') {
        getPeers(key).forEach((pws, id) => { if (id.startsWith('booyah:')) targetWs = pws; });
      } else {
        // viewerId may be 'SPECT1' or '1' — obs peers are stored as 'obs:1'
      const _vid = String(viewerId).replace('SPECT','');
      targetWs = getPeers(key).get('obs:' + _vid) || getPeers(key).get('obs:' + viewerId);
      }
      if (targetWs) {
        sendTo(targetWs, { type:'relay-offer', uid: msg.uid, sdp: msg.sdp, viewerId });
        console.log('[RELAY] offer from admin → ' + viewerId + ' uid:' + msg.uid);
      }
      return;
    }

    // relay-answer: viewer answers admin's relay offer
    if (msg.type === 'relay-answer') {
      const room = rooms.get(key);
      if (!room) return;
      // Route back to admin
      broadcastAdmins(key, { type:'relay-answer', uid: msg.uid, sdp: msg.sdp, viewerId: msg.viewerId });
      return;
    }

    // relay-ice: ICE from admin to viewer
    if (msg.type === 'relay-ice') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      const viewerId = msg.viewerId || 'booyah';
      let targetWs = null;
      if (viewerId === 'booyah') {
        getPeers(key).forEach((pws, id) => { if (id.startsWith('booyah:')) targetWs = pws; });
      } else {
        // viewerId may be 'SPECT1' or '1' — obs peers are stored as 'obs:1'
      const _vid = String(viewerId).replace('SPECT','');
      targetWs = getPeers(key).get('obs:' + _vid) || getPeers(key).get('obs:' + viewerId);
      }
      if (targetWs) sendTo(targetWs, { type:'relay-ice', uid: msg.uid, candidate: msg.candidate, viewerId });
      else console.log('[RELAY-ICE] No target for viewerId:', viewerId);
      return;
    }

    // relay-ice-back: ICE from viewer back to admin relay PC
    if (msg.type === 'relay-ice-back') {
      const room = rooms.get(key);
      if (!room) return;
      broadcastAdmins(key, { type:'relay-ice-back', uid: msg.uid, candidate: msg.candidate, viewerId: msg.viewerId });
      return;
    }

    // viewer-offer: player sends dedicated offer for a specific viewer
    if (msg.type === 'viewer-offer') {
      const viewerId = msg.viewerId || '';
      // Find the specific viewer WS
      let targetWs = null;
      if (viewerId === 'booyah' || viewerId.startsWith('booyah')) {
        getPeers(key).forEach((pws, id) => {
          if (id.startsWith('booyah:')) targetWs = pws;
        });
      } else if (viewerId.startsWith('obs') || viewerId.startsWith('SPECT')) {
        // viewerId may be 'SPECT1' or '1' — obs peers are stored as 'obs:1'
      const _vid = String(viewerId).replace('SPECT','');
      targetWs = getPeers(key).get('obs:' + _vid) || getPeers(key).get('obs:' + viewerId);
      }
      if (targetWs) {
        sendTo(targetWs, { type:'viewer-offer', uid: msg.uid, sdp: msg.sdp, viewerId });
        console.log('[VIEWER-OFFER] Routed to ' + viewerId + ' for uid:' + msg.uid);
      }
      return;
    }

    if (msg.type === 'answer') {
      sendTo(getPeers(key).get('uid:' + msg.uid), { type:'answer', sdp: msg.sdp, spectId: msg.spectId });
      return;
    }

    // viewer-answer: booyah/spect answers a viewer-offer from player
    if (msg.type === 'viewer-answer') {
      const playerWs = getPeers(key).get('uid:' + msg.uid);
      sendTo(playerWs, { type:'viewer-answer', sdp: msg.sdp, viewerId: msg.viewerId });
      return;
    }

    // Booyah cam ICE → player
    if (msg.type === 'ice' && msg.from === 'booyah') {
      const playerWs = getPeers(key).get('uid:' + msg.uid);
      sendTo(playerWs, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'admin' });
      return;
    }

    if (msg.type === 'ice') {
      if (msg.from === 'player') {
        broadcastAdmins(key, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'player' });
        const s = spectators.get(key) || {};
        Object.entries(s).forEach(([spectId, watchedUid]) => {
          if (watchedUid === msg.uid) sendTo(getPeers(key).get('obs:' + spectId), { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'player' });
        });
        // Forward ICE to booyah cam too
        getPeers(key).forEach((pws, id) => {
          if (id.startsWith('booyah:')) sendTo(pws, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'player' });
        });
      } else {
        sendTo(getPeers(key).get('uid:' + msg.uid), { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'admin' });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!wsRoom || !wsId) return;
    getPeers(wsRoom).delete(wsId);
    if (wsRole === 'player' && wsUid) broadcastAdmins(wsRoom, { type:'player-left', uid: wsUid });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const PLAYER_PORT = process.env.PLAYER_PORT || 7878;

server.listen(PORT, '0.0.0.0', () => {
  console.log('🎮 Upthrust Camera Server');
  console.log('   Admin:   https://localhost:' + PORT + '/admin.html');
  console.log('   WS:      wss://localhost:' + PORT);
  console.log('🔑 Admin login: angry / angry0306');

  // Auto-create default room
  const defaultRoom = process.env.DEFAULT_ROOM || 'test';
  const defaultPass = process.env.DEFAULT_PASS || 'test';
  const key = roomKey(defaultRoom, defaultPass);
  if (!rooms.has(key)) {
    const adminToken = crypto.randomBytes(24).toString('hex');
    rooms.set(key, { roomName: defaultRoom, roomPassword: defaultPass, adminToken, createdAt: Date.now() });
    playerCameras.set(key, []);
    console.log('✅ Default room created: ' + defaultRoom + ' (pass: ' + defaultPass + ')');
    console.log('   AdminToken: ' + adminToken);
  }
});

// Separate player server on 7878 — LOCAL ONLY, skip on Render
if (!IS_RENDER) {
  const playerApp = express();
  playerApp.use(express.static(path.join(__dirname, 'public')));
  playerApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  let playerServer;
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    playerServer = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, playerApp);
  } else {
    playerServer = http.createServer(playerApp);
  }
  playerServer.listen(PLAYER_PORT, '0.0.0.0', () => {
    const proto = fs.existsSync(certPath) ? 'https' : 'http';
    console.log('🎮 Player Page:  ' + proto + '://localhost:' + PLAYER_PORT + '  ← share with players');
    console.log('   Cloudflare:   cloudflared tunnel --url ' + proto + '://localhost:' + PLAYER_PORT);
  });
} else {
  console.log('☁️  Render mode — player page at: https://spec-camera.onrender.com/index.html');
}
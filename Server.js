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

// Auto-generate or load SSL cert for HTTPS (needed for camera access on LAN)
let server;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  // Use existing cert files if present
  const sslOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  server = https.createServer(sslOptions, app);
  console.log('🔒 HTTPS mode — loaded cert.pem + key.pem');
} else {
  // Auto-generate self-signed cert on first run
  console.log('🔑 Generating self-signed SSL certificate...');
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems  = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath,  pems.private);
  const sslOptions = { cert: pems.cert, key: pems.private };
  server = https.createServer(sslOptions, app);
  console.log('🔒 HTTPS mode — auto-generated self-signed cert (saved for reuse)');
}

const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ──────────────────────────────────────────────────────────
const rooms         = new Map(); // roomKey -> room meta
const playerCameras = new Map(); // roomKey -> camera[]
const latestOffers  = new Map(); // roomKey -> { uid: sdp } — stores latest offer per player

// WebSocket peer registry
// peers[roomKey] = { uid: ws, 'admin:token': ws, ... }
const peers = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function roomKey(n, p) { return `${n}::${p}`; }

function getPeers(key) {
  if (!peers.has(key)) peers.set(key, new Map());
  return peers.get(key);
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAdmins(key, msg) {
  const rp = getPeers(key);
  rp.forEach((ws, id) => {
    if (id.startsWith('admin:')) sendTo(ws, msg);
  });
}

function broadcastAll(key, msg) {
  const rp = getPeers(key);
  rp.forEach((ws) => sendTo(ws, msg));
}

// ─── REST: Room Create (curl/backend only) ────────────────────────────────────
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

  return res.json({ success: true, roomName, adminToken,
    message: `Room "${roomName}" created. Use adminToken on the admin panel.` });
});

// ─── REST: Admin Login ────────────────────────────────────────────────────────
app.post('/api/room/admin-login', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.body;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);

  console.log('\n[ADMIN-LOGIN] roomName:', JSON.stringify(roomName));
  console.log('[ADMIN-LOGIN] roomPassword:', JSON.stringify(roomPassword));
  console.log('[ADMIN-LOGIN] key:', JSON.stringify(key));
  console.log('[ADMIN-LOGIN] existing keys:', JSON.stringify([...rooms.keys()]));
  console.log('[ADMIN-LOGIN] token match:', room ? (room.adminToken === adminToken) : 'no room');

  if (!room || room.adminToken !== adminToken)
    return res.status(403).json({ error: 'Invalid room or admin token' });

  return res.json({ success: true, role: 'admin', roomName,
    cameras: playerCameras.get(key) || [] });
});

// ─── REST: Player Join — only UID needed, server finds the room ──────────────
app.post('/api/room/player-join', (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID required' });

  // Search ALL rooms for this UID
  for (const [key, room] of rooms.entries()) {
    const cameras = playerCameras.get(key) || [];
    const reg = cameras.find(c => c.uid === uid);
    if (reg) {
      console.log('[PLAYER-JOIN] SUCCESS uid:', uid, '-> room:', room.roomName);
      return res.json({
        success: true, role: 'player',
        playerName: reg.playerName, slot: reg.slot,
        roomName: room.roomName, roomPassword: room.roomPassword,
      });
    }
  }

  console.log('[PLAYER-JOIN] FAIL: uid not found in any room:', uid);
  return res.status(403).json({ error: 'UID not registered. Contact your operator.' });
});

// ─── REST: Add / update camera ────────────────────────────────────────────────
app.post('/api/room/camera/add', (req, res) => {
  const { roomName, roomPassword, adminToken, playerName, uid, slot, team } = req.body;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                        return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });

  const cameras = playerCameras.get(key);
  // Only replace by UID — slots are not unique across 48+ players
  const idx = cameras.findIndex(c => c.uid === uid);
  const cam = { playerName, uid, slot, team: team||'', addedAt: Date.now() };
  if (idx >= 0) cameras[idx] = cam; else cameras.push(cam);
  playerCameras.set(key, cameras);
  return res.json({ success: true, cameras });
});

// ─── REST: Bulk add cameras ───────────────────────────────────────────────────
app.post('/api/room/camera/bulk-add', (req, res) => {
  const { roomName, roomPassword, adminToken, players } = req.body;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                        return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  if (!Array.isArray(players))      return res.status(400).json({ error: 'players must be array' });

  const cameras = playerCameras.get(key);
  let added = 0;
  for (const p of players) {
    const { playerName, uid, slot, team } = p;
    if (!playerName || !uid) continue;
    const idx = cameras.findIndex(c => c.uid === uid);
    const cam = { playerName, uid, slot: slot||cameras.length+1, team: team||'', addedAt: Date.now() };
    if (idx >= 0) cameras[idx] = cam; else { cameras.push(cam); added++; }
  }
  playerCameras.set(key, cameras);
  return res.json({ success: true, added, total: cameras.length, cameras });
});

// ─── REST: Clear all cameras ──────────────────────────────────────────────────
app.delete('/api/room/cameras/all', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                        return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  playerCameras.set(key, []);
  return res.json({ success: true, cameras: [] });
});

// ─── REST: Remove camera ──────────────────────────────────────────────────────
app.delete('/api/room/camera/:uid', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                        return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  const updated = (playerCameras.get(key) || []).filter(c => c.uid !== req.params.uid);
  playerCameras.set(key, updated);
  return res.json({ success: true, cameras: updated });
});

// ─── REST: Get cameras ────────────────────────────────────────────────────────
app.get('/api/room/cameras', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                        return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  return res.json({ cameras: playerCameras.get(key) || [] });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

// ─── Serve player photos from public/players folder ─────────────────────────
// Files named by UID: 123456789.png or PlayerName.png
app.get('/api/players/photos', (req, res) => {
  const playersDir = path.join(__dirname, 'public', 'players');
  if (!fs.existsSync(playersDir)) return res.json({ photos: {} });
  const files = fs.readdirSync(playersDir).filter(f =>
    /\.(png|jpg|jpeg|webp)$/i.test(f)
  );
  const photos = {};
  files.forEach(f => {
    const key = f.replace(/\.[^.]+$/, ''); // strip extension = UID or name
    photos[key] = '/players/' + f;
  });
  res.json({ photos });
});

// ─── Serve logos from public/logos folder ────────────────────────────────────
app.get('/api/logos', (req, res) => {
  const logosDir = path.join(__dirname, 'public', 'logos');
  if (!fs.existsSync(logosDir)) return res.json({ logos: [] });
  const files = fs.readdirSync(logosDir).filter(f =>
    /\.(png|jpg|jpeg|svg|webp)$/i.test(f)
  );
  // Return { teamName: '/logos/filename.png' }
  const logos = {};
  files.forEach(f => {
    const teamName = f.replace(/\.[^.]+$/, ''); // strip extension
    logos[teamName] = '/logos/' + f;
  });
  res.json({ logos });
});

// ─── Short OBS spectator URLs: /spect1 ... /spect6 ───────────────────────────
for (let i = 1; i <= 6; i++) {
  app.get('/spect' + i, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'obs-spect.html'));
  });
}

// ─── Booyah cam URL: /booyah ──────────────────────────────────────────────────
app.get('/booyah', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booyah-cam.html'));
});

// ─── FF CG Engine Config ─────────────────────────────────────────────────────
// Edit these to match your tournament setup
const FF_CONFIG = {
  clientId:  process.env.FF_CLIENT_ID  || 'a7f92e27-5387-4b29-bf1e-6e3c22fe78d2',
  matchId:   process.env.FF_MATCH_ID   || '',
  garenaUrl: 'https://suez-ind.garenanow.com/game/freefire/tidy/v1/livematch/br/batch',
  pollMs:    1000,
};

// spectConfig[roomKey] = { matchId, spectObservers: [{slot, observerUid}] }
const spectConfigs = new Map();
// Last known observer→uid mapping from Garena API
const lastSpectData = new Map(); // roomKey -> { observerUid: playerUid }

// ─── FF API Polling ────────────────────────────────────────────────────────────
async function pollGarenaForSpect(roomKey) {
  const cfg = spectConfigs.get(roomKey);
  if (!cfg || !cfg.matchId || !cfg.spectObservers.length) return;

  try {
    const res  = await fetch(`${FF_CONFIG.garenaUrl}?matchid=${cfg.matchId}`, {
      headers: { 'Client-ID': FF_CONFIG.clientId }
    });
    if (!res.ok) return;
    const data = await res.json();

    // Extract spector_info from all match results
    const matches = data.data || data.match_data || [];
    const allSpectors = [];
    for (const m of matches) {
      const si = m.spector_info || m.spectator_info || [];
      allSpectors.push(...si);
    }

    if (!allSpectors.length) return;

    const room   = rooms.get(roomKey);
    const cameras = playerCameras.get(roomKey) || [];
    const s       = spectators.get(roomKey) || {};
    let   changed = false;

    for (const obs of cfg.spectObservers) {
      // Find this observer in spector_info by their UID
      const spectEntry = allSpectors.find(si =>
        String(si.observer_id) === String(obs.observerUid) ||
        String(si.account_id)  === String(obs.observerUid)
      );

      const watchedUid = spectEntry
        ? String(spectEntry.target_id || spectEntry.spectate_id || spectEntry.account_id || '')
        : null;

      // Match watched UID to a registered camera player
      const cam = watchedUid ? cameras.find(c => String(c.uid) === watchedUid) : null;
      const assignUid = cam ? cam.uid : null;

      const slotKey = String(obs.slot);
      const prev    = s[slotKey];

      if (assignUid !== prev) {
        if (assignUid) s[slotKey] = assignUid;
        else           delete s[slotKey];
        changed = true;
        console.log(`[SPECT] Slot ${obs.slot} (observer ${obs.observerUid}) → ${assignUid || 'none'}`);
      }
    }

    if (changed) {
      spectators.set(roomKey, s);
      broadcastAll(roomKey, { type: 'spect-update-all', spectators: s });
    }

    // ── Booyah detection ─────────────────────────────────────────────────────
    const booyahTeam = (matches[0]?.teams || []).find(t => t.booyah);
    if (booyahTeam && !booyahDetected.has(roomKey)) {
      booyahDetected.add(roomKey);
      const cameras  = playerCameras.get(roomKey) || [];
      const room2    = rooms.get(roomKey);

      // Match Garena team players to registered camera UIDs
      const booyahPlayers = (booyahTeam.players || []).map(p => {
        const uid = String(p.account_id || '');
        const cam = cameras.find(c => String(c.uid) === uid);
        return {
          uid,
          playerName: cam ? cam.playerName : (p.nickname || uid),
          account_id: uid,
        };
      }).slice(0, 4);

      console.log('[BOOYAH] Winner:', booyahTeam.team_name, '| Players:', booyahPlayers.map(p=>p.uid));

      broadcastAll(roomKey, {
        type:      'booyah-detected',
        teamName:  booyahTeam.team_name || booyahTeam.display_name || '',
        teamLogo:  null, // frontend will look up from /logos/ folder
        players:   booyahPlayers,
      });
    }
    // Reset booyah flag when match resets (no teams or new match)
    if (!booyahTeam && booyahDetected.has(roomKey)) {
      booyahDetected.delete(roomKey);
    }

  } catch(e) {
    // silently ignore network errors
  }
}

// Track booyah state per room so we only fire once
const booyahDetected = new Set();

// Start/stop Garena polling for a room
const spectPollers = new Map(); // roomKey -> intervalId

function startSpectPolling(roomKey) {
  if (spectPollers.has(roomKey)) return; // already running
  const id = setInterval(() => pollGarenaForSpect(roomKey), FF_CONFIG.pollMs);
  spectPollers.set(roomKey, id);
  console.log(`[SPECT] Started polling for room: ${roomKey}`);
}

function stopSpectPolling(roomKey) {
  const id = spectPollers.get(roomKey);
  if (id) { clearInterval(id); spectPollers.delete(roomKey); }
}

// ─── REST: Configure FF spectator observers ────────────────────────────────────
app.post('/api/spect/config', (req, res) => {
  const { roomName, roomPassword, adminToken, matchId, spectObservers } = req.body;
  // spectObservers: [{slot: 1, observerUid: '123456789'}, ...]
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                          return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });

  spectConfigs.set(key, { matchId, spectObservers: spectObservers || [] });

  if (matchId && spectObservers?.length) {
    startSpectPolling(key);
    res.json({ success: true, message: 'FF API polling started', matchId, spectObservers });
  } else {
    stopSpectPolling(key);
    res.json({ success: true, message: 'FF polling stopped (no matchId or observers)' });
  }
});

// ─── REST: Get current FF spect config ────────────────────────────────────────
app.get('/api/spect/config', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                          return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  const cfg = spectConfigs.get(key) || { matchId: '', spectObservers: [] };
  return res.json({ ...cfg, polling: spectPollers.has(key) });
});

// ─── Observer / Spectator system ──────────────────────────────────────────────
// spectators[roomKey] = { spectId: uid_being_watched }
const spectators = new Map();

// Admin sets which UID a spectator is currently watching
app.post('/api/spect/set', (req, res) => {
  const { roomName, roomPassword, adminToken, spectId, uid } = req.body;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                          return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });

  if (!spectators.has(key)) spectators.set(key, {});
  const s = spectators.get(key);
  if (uid) s[spectId] = uid;
  else     delete s[spectId];
  spectators.set(key, s);

  // Notify all WS clients watching this spectator
  broadcastAll(key, { type: 'spect-update', spectId, uid: uid || null });
  return res.json({ success: true, spectators: s });
});

// Get current spectator→uid mapping (admin)
app.get('/api/spect/status', (req, res) => {
  const { roomName, roomPassword, adminToken } = req.query;
  const key  = roomKey(roomName, roomPassword);
  const room = rooms.get(key);
  if (!room)                          return res.status(404).json({ error: 'Room not found' });
  if (room.adminToken !== adminToken) return res.status(403).json({ error: 'Unauthorized' });
  return res.json({ spectators: spectators.get(key) || {} });
});

// OBS overlay polls this to know which player to show
app.get('/api/spect/:spectId', (req, res) => {
  const { roomName, roomPassword } = req.query;
  const key  = roomKey(roomName, roomPassword);
  if (!rooms.has(key)) return res.status(403).json({ error: 'Room not found' });
  const s   = spectators.get(key) || {};
  const uid = s[req.params.spectId] || null;
  const cameras = playerCameras.get(key) || [];
  const player  = cameras.find(c => c.uid === uid) || null;
  return res.json({ spectId: req.params.spectId, uid, player });
});

// ─── WebSocket Signaling ──────────────────────────────────────────────────────
//
// Message types (JSON):
//
//  CLIENT → SERVER
//  { type: 'register-player', roomName, roomPassword, uid }
//  { type: 'register-admin',  roomName, roomPassword, adminToken }
//  { type: 'offer',           roomName, roomPassword, uid, sdp }      player → server → admin
//  { type: 'answer',          roomName, roomPassword, uid, sdp }      admin  → server → player
//  { type: 'ice',             roomName, roomPassword, uid, candidate, from:'player'|'admin' }
//
//  SERVER → CLIENT
//  { type: 'registered', playerName, slot }
//  { type: 'player-joined', uid, playerName, slot }   → admin
//  { type: 'player-left',   uid }                     → admin
//  { type: 'offer',  uid, sdp }                       → admin
//  { type: 'answer', uid, sdp }                       → player
//  { type: 'ice',    uid, candidate, from }           → other side
//  { type: 'error',  message }

wss.on('connection', (ws) => {
  let wsRoom = null; // roomKey
  let wsId   = null; // 'uid:XXX' or 'admin:TOKEN'
  let wsRole = null; // 'player' | 'admin'
  let wsUid  = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const key = roomKey(msg.roomName, msg.roomPassword);

    // ── Register Player ───────────────────────────────────────────────────────
    if (msg.type === 'register-player') {
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });
      const reg = (playerCameras.get(key) || []).find(c => c.uid === msg.uid);
      if (!reg) return sendTo(ws, { type:'error', message:'UID not registered' });

      wsRoom = key; wsId = `uid:${msg.uid}`; wsRole = 'player'; wsUid = msg.uid;
      getPeers(key).set(wsId, ws);

      // Confirm registration — player will auto-start camera immediately
      sendTo(ws, { type:'registered', playerName: reg.playerName, slot: reg.slot });

      // Tell all admins this player is live
      broadcastAdmins(key, { type:'player-joined', uid: msg.uid,
        playerName: reg.playerName, slot: reg.slot, team: reg.team });
      return;
    }

    // ── Test Booyah (admin trigger) ──────────────────────────────────────────
    if (msg.type === 'test-booyah') {
      const key  = roomKey(msg.roomName, msg.roomPassword);
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      booyahDetected.add(key);
      broadcastAll(key, {
        type:     'booyah-detected',
        teamName: msg.teamName || 'TEST',
        teamLogo: null,
        players:  msg.players || [],
      });
      return;
    }

    // ── Reset Booyah ──────────────────────────────────────────────────────────
    if (msg.type === 'reset-booyah') {
      const key  = roomKey(msg.roomName, msg.roomPassword);
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken) return;
      booyahDetected.delete(key);
      broadcastAll(key, { type: 'booyah-reset' });
      return;
    }

    // ── Register Booyah Cam viewer ───────────────────────────────────────────
    if (msg.type === 'register-booyah-cam') {
      const key = roomKey(msg.roomName, msg.roomPassword);
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });
      wsRoom = key; wsId = 'booyah:' + Date.now(); wsRole = 'obs';
      getPeers(key).set(wsId, ws);
      sendTo(ws, { type: 'booyah-registered' });
      // If booyah already happened, re-send immediately
      if (booyahDetected.has(key)) {
        sendTo(ws, { type: 'booyah-detected', teamName: '', players: [] });
      }
      return;
    }

    // ── Register OBS Spectator viewer ────────────────────────────────────────
    if (msg.type === 'register-obs') {
      const key = roomKey(msg.roomName, msg.roomPassword);
      if (!rooms.has(key)) return sendTo(ws, { type:'error', message:'Room not found' });

      wsRoom = key;
      wsId   = `obs:${msg.spectId}`;
      wsRole = 'obs';
      getPeers(key).set(wsId, ws);

      // Send current assignment if any
      const s   = spectators.get(key) || {};
      const uid = s[msg.spectId] || null;
      sendTo(ws, { type: 'obs-registered', spectId: msg.spectId, uid });
      return;
    }

    // ── OBS requests stream from a specific player ────────────────────────────
    if (msg.type === 'obs-request-stream') {
      const key       = roomKey(msg.roomName, msg.roomPassword);
      const playerWs  = getPeers(key).get(`uid:${msg.uid}`);
      if (playerWs) {
        // Tell the player to send an offer to this OBS client
        sendTo(playerWs, { type: 'obs-offer-request', spectId: msg.spectId });
      } else {
        sendTo(ws, { type: 'error', message: 'Player not online' });
      }
      return;
    }

    // ── Register Admin ────────────────────────────────────────────────────────
    if (msg.type === 'register-admin') {
      const room = rooms.get(key);
      if (!room || room.adminToken !== msg.adminToken)
        return sendTo(ws, { type:'error', message:'Invalid admin token' });

      wsRoom = key; wsId = `admin:${msg.adminToken}`; wsRole = 'admin';
      getPeers(key).set(wsId, ws);

      // Send current online players to admin
      const rp = getPeers(key);
      const online = [];
      rp.forEach((_, id) => { if (id.startsWith('uid:')) online.push(id.slice(4)); });
      sendTo(ws, { type:'admin-registered', onlinePlayers: online });

      // Notify all players admin connected so they re-send offers
      rp.forEach((pws, id) => {
        if (id.startsWith('uid:')) sendTo(pws, { type: 'admin-joined' });
      });

      // Also send any stored offers directly to this admin
      // so players who joined before admin get answered immediately
      if (latestOffers.has(key)) {
        Object.entries(latestOffers.get(key)).forEach(([uid, sdp]) => {
          sendTo(ws, { type:'offer', uid, sdp });
        });
      }
      return;
    }

    // ── WebRTC: Offer (player → admin OR obs) ───────────────────────────────
    if (msg.type === 'offer') {
      if (msg.target === 'obs' && msg.spectId) {
        const obsWs = getPeers(key).get('obs:' + msg.spectId);
        sendTo(obsWs, { type:'offer', uid: msg.uid, sdp: msg.sdp });
      } else {
        // Always forward to all admins — no permission needed
        broadcastAdmins(key, { type:'offer', uid: msg.uid, sdp: msg.sdp });
        // Also store latest offer so late-joining admin can answer it
        if (!latestOffers.has(key)) latestOffers.set(key, {});
        latestOffers.get(key)[msg.uid] = msg.sdp;
      }
      return;
    }

    // ── WebRTC: Answer (admin/obs → player) ──────────────────────────────────
    if (msg.type === 'answer') {
      const playerWs = getPeers(key).get(`uid:${msg.uid}`);
      sendTo(playerWs, { type:'answer', sdp: msg.sdp, spectId: msg.spectId });
      return;
    }

    // ── WebRTC: ICE candidate (all directions) ──────────────────────────────
    if (msg.type === 'ice') {
      if (msg.from === 'player') {
        // player → admin AND all obs clients watching this player
        broadcastAdmins(key, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'player' });
        // also forward to any obs watching this uid
        const s = spectators.get(key) || {};
        Object.entries(s).forEach(([spectId, watchedUid]) => {
          if (watchedUid === msg.uid) {
            const obsWs = getPeers(key).get(`obs:${spectId}`);
            sendTo(obsWs, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'player' });
          }
        });
      } else if (msg.from === 'obs') {
        // obs → player
        const playerWs = getPeers(key).get(`uid:${msg.uid}`);
        sendTo(playerWs, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'admin' });
      } else {
        // admin → player
        const playerWs = getPeers(key).get(`uid:${msg.uid}`);
        sendTo(playerWs, { type:'ice', uid: msg.uid, candidate: msg.candidate, from:'admin' });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!wsRoom || !wsId) return;
    getPeers(wsRoom).delete(wsId);
    if (wsRole === 'player' && wsUid) {
      broadcastAdmins(wsRoom, { type:'player-left', uid: wsUid });
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const PLAYER_PORT = process.env.PLAYER_PORT || 7878;

server.listen(PORT, () => {
  const protocol = (server instanceof require('https').Server) ? 'https' : 'http';
  const wsProto  = (protocol === 'https') ? 'wss' : 'ws';
  console.log('🎮 Upthrust Camera Server');
  console.log('   Admin:   ' + protocol + '://localhost:' + PORT + '/admin.html');
  console.log('   WS:      ' + wsProto + '://localhost:' + PORT);

// ── Separate player-only server on port 7878 ──────────────────────────────────
const express2 = require('express');
const playerApp = express2();

// Serve only index.html on port 7878
playerApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
playerApp.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Serve static assets needed by player page (fonts, etc)
playerApp.use(express2.static(path.join(__dirname, 'public')));

// Start player server with same SSL cert
let playerServer;
const certPath2 = path.join(__dirname, 'cert.pem');
const keyPath2  = path.join(__dirname, 'key.pem');
if (fs.existsSync(certPath2) && fs.existsSync(keyPath2)) {
  const https2 = require('https');
  playerServer = https2.createServer({ cert: fs.readFileSync(certPath2), key: fs.readFileSync(keyPath2) }, playerApp);
} else {
  const http2 = require('http');
  playerServer = http2.createServer(playerApp);
}

playerServer.listen(PLAYER_PORT, () => {
  const proto2 = fs.existsSync(certPath2) ? 'https' : 'http';
  console.log('🎮 Player Page:  ' + proto2 + '://localhost:' + PLAYER_PORT + '  ← share with players');
  console.log('   Cloudflare:   cloudflared tunnel --url ' + proto2 + '://localhost:' + PLAYER_PORT);
});

  // Auto-create a default room on startup for local LAN testing
  const defaultRoom = process.env.DEFAULT_ROOM     || 'test';
  const defaultPass = process.env.DEFAULT_PASS     || 'test';
  const key = roomKey(defaultRoom, defaultPass);
  if (!rooms.has(key)) {
    const crypto = require('crypto');
    const adminToken = crypto.randomBytes(24).toString('hex');
    rooms.set(key, { roomName: defaultRoom, roomPassword: defaultPass, adminToken, createdAt: Date.now() });
    playerCameras.set(key, []);
    console.log('✅ Default room created: ' + defaultRoom + ' (pass: ' + defaultPass + ')');
    console.log('   AdminToken: ' + adminToken);
  }
});

// ─── Admin session endpoint (username/password login from frontend) ────────────
// Credentials are checked on the frontend; this just returns the active room token.
// In production move credential check here too.
const ADMIN_USERNAME = 'angry';
const ADMIN_PASSWORD = 'angry0306';

app.post('/api/admin/session', (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid credentials' });

  // Return the first available room, or a default room auto-created on server start
  if (!rooms.size)
    return res.status(404).json({ error: 'No rooms exist yet. Create one via /api/room/create' });

  // Return the first room (for single-room setups like local testing)
  const [key, room] = [...rooms.entries()][0];
  return res.json({
    success: true,
    roomName: room.roomName,
    roomPassword: room.roomPassword,
    adminToken: room.adminToken,
    cameras: playerCameras.get(key) || [],
  });
});
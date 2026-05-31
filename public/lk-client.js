// ── LiveKit Client Helper v1.0 ────────────────────────────────────────────────
// Requires LiveKit JS SDK from CDN
// <script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>

class LKClient {
  constructor() {
    this.room       = null;
    this.token      = null;
    this.url        = null;
    this._onStream  = null;
    this._onLeft    = null;
    this.streams    = new Map(); // identity → MediaStream
    this.ws         = null;     // notification websocket
    this._wsReady   = false;
  }

  // ── Connect notification WebSocket ────────────────────────────────────────
  connectWS(role) {
    const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this._wsReady = true;
      this.ws.send(JSON.stringify({ type: 'register', role }));
      console.log('[LK] WS connected');
    };
    this.ws.onclose = () => {
      this._wsReady = false;
      setTimeout(() => this.connectWS(role), 2000);
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        window.dispatchEvent(new CustomEvent('lk-notify', { detail: msg }));
      } catch {}
    };
    // Keepalive
    setInterval(() => {
      if (this._wsReady) this.ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
  }

  // ── PLAYER: publish camera ────────────────────────────────────────────────
  async publishCamera(localStream, uid, playerName) {
    const res  = await fetch('/api/room/player-join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, operatorPassword: this._opPass })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    this.token = data.token;
    this.url   = data.livekitUrl;

    this.room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast:       true,
    });

    this.room.on(LivekitClient.RoomEvent.Disconnected, () => {
      console.log('[LK] Disconnected from room');
      window.dispatchEvent(new CustomEvent('lk-disconnected'));
    });

    this.room.on(LivekitClient.RoomEvent.Reconnecting, () => {
      console.log('[LK] Reconnecting...');
      window.dispatchEvent(new CustomEvent('lk-reconnecting'));
    });

    this.room.on(LivekitClient.RoomEvent.Reconnected, () => {
      console.log('[LK] Reconnected!');
      window.dispatchEvent(new CustomEvent('lk-reconnected'));
    });

    await this.room.connect(this.url, this.token);
    console.log('[LK] Connected to room:', this.room.name);

    // Publish video + audio tracks from existing stream
    for (const track of localStream.getTracks()) {
      const lkTrack = new LivekitClient.LocalTrack(track);
      await this.room.localParticipant.publishTrack(lkTrack);
    }

    console.log('[LK] Publishing camera for:', uid);

    // Notify server player is online
    await fetch('/api/player/online', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, playerName, team: '' })
    }).catch(() => {});

    return data;
  }

  // ── VIEWER: subscribe to all cameras ─────────────────────────────────────
  async subscribeAll(viewerType, spectId, onStream, onLeft) {
    this._onStream = onStream;
    this._onLeft   = onLeft;

    const res  = await fetch('/api/viewer-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerType, spectId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    this.token = data.token;
    this.url   = data.livekitUrl;

    this.room = new LivekitClient.Room({
      adaptiveStream: true,
    });

    // ── Track subscribed (new camera stream) ─────────────────────────────
    this.room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      const meta = this._parseMeta(participant.metadata);
      const uid  = meta.uid || participant.identity.replace('player_', '');
      const name = participant.name || uid;
      const team = meta.team || '';

      // Build MediaStream from track
      const stream = new MediaStream([track.mediaStreamTrack]);
      this.streams.set(uid, stream);
      console.log('[LK] Stream subscribed:', uid, name);

      if (this._onStream) this._onStream(uid, stream, name, team);
    });

    // ── Track unsubscribed (camera disconnected) ──────────────────────────
    this.room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      const meta = this._parseMeta(participant.metadata);
      const uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      console.log('[LK] Stream unsubscribed:', uid);
      if (this._onLeft) this._onLeft(uid);
    });

    // ── Participant left ──────────────────────────────────────────────────
    this.room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      const meta = this._parseMeta(participant.metadata);
      const uid  = meta.uid || participant.identity.replace('player_', '');
      if (!uid.startsWith('player')) return;
      this.streams.delete(uid);
      console.log('[LK] Participant left:', uid);
      if (this._onLeft) this._onLeft(uid);
    });

    await this.room.connect(this.url, this.token);
    console.log('[LK] Viewer connected to room:', this.room.name);

    // Handle already-connected participants
    this.room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.isSubscribed && pub.track && pub.track.kind === LivekitClient.Track.Kind.Video) {
          const meta = this._parseMeta(participant.metadata);
          const uid  = meta.uid || participant.identity.replace('player_', '');
          const stream = new MediaStream([pub.track.mediaStreamTrack]);
          this.streams.set(uid, stream);
          if (this._onStream) this._onStream(uid, stream, participant.name, meta.team || '');
        }
      });
    });
  }

  // ── Admin: subscribe + manage ─────────────────────────────────────────────
  async connectAdmin(token, livekitUrl, onStream, onLeft) {
    this._onStream = onStream;
    this._onLeft   = onLeft;
    this.token = token;
    this.url   = livekitUrl;

    this.room = new LivekitClient.Room({ adaptiveStream: true });

    this.room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      const meta   = this._parseMeta(participant.metadata);
      const uid    = meta.uid || participant.identity.replace('player_', '');
      const stream = new MediaStream([track.mediaStreamTrack]);
      this.streams.set(uid, stream);
      if (this._onStream) this._onStream(uid, stream, participant.name, meta.team || '');
    });

    this.room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      const meta = this._parseMeta(participant.metadata);
      const uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      if (this._onLeft) this._onLeft(uid);
    });

    this.room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      if (!participant.identity.startsWith('player_')) return;
      const meta = this._parseMeta(participant.metadata);
      const uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      if (this._onLeft) this._onLeft(uid);
    });

    await this.room.connect(this.url, this.token);
    console.log('[LK] Admin connected');

    // Existing participants
    this.room.remoteParticipants.forEach(participant => {
      if (!participant.identity.startsWith('player_')) return;
      participant.trackPublications.forEach(pub => {
        if (pub.isSubscribed && pub.track?.kind === LivekitClient.Track.Kind.Video) {
          const meta   = this._parseMeta(participant.metadata);
          const uid    = meta.uid || participant.identity.replace('player_', '');
          const stream = new MediaStream([pub.track.mediaStreamTrack]);
          this.streams.set(uid, stream);
          if (this._onStream) this._onStream(uid, stream, participant.name, meta.team || '');
        }
      });
    });
  }

  // ── Disconnect player (admin) ─────────────────────────────────────────────
  async disconnectPlayer(uid) {
    await fetch('/api/admin/disconnect-player', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    }).catch(() => {});
  }

  // ── Get stream for uid ────────────────────────────────────────────────────
  getStream(uid) { return this.streams.get(uid) || null; }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  destroy() {
    if (this.room) { this.room.disconnect(); this.room = null; }
    if (this.ws)   { this.ws.close(); this.ws = null; }
    this.streams.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────
  _parseMeta(metaStr) {
    try { return JSON.parse(metaStr || '{}'); } catch { return {}; }
  }
}

// Global singleton
window.lkClient = new LKClient();
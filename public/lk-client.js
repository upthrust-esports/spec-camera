// ── LiveKit Client Helper v2.0 ────────────────────────────────────────────────
// LiveKit JS SDK v2 compatible
// <script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>

class LKClient {
  constructor() {
    this.room      = null;
    this.streams   = new Map(); // uid → MediaStream
    this.ws        = null;
    this._wsReady  = false;
    this._wsRole   = 'viewer';
  }

  // ── Notification WebSocket ────────────────────────────────────────────────
  connectWS(role) {
    this._wsRole = role;
    var wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this._wsReady = true;
      this.ws.send(JSON.stringify({ type:'register', role }));
      console.log('[LK] WS connected');
    };
    this.ws.onclose = () => {
      this._wsReady = false;
      setTimeout(() => this.connectWS(role), 2000);
    };
    this.ws.onmessage = (e) => {
      try {
        var msg = JSON.parse(e.data);
        window.dispatchEvent(new CustomEvent('lk-notify', { detail: msg }));
      } catch {}
    };
    setInterval(() => {
      if (this._wsReady) this.ws.send(JSON.stringify({ type:'ping' }));
    }, 20000);
  }

  // ── ADMIN: subscribe to all player cameras ────────────────────────────────
  async connectAdmin(token, livekitUrl, onStream, onLeft) {
    if (this.room) {
      try { this.room.disconnect(); } catch {}
      this.room = null;
    }

    this.room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast:       false,
    });

    // ── New track subscribed ──────────────────────────────────────────────
    this.room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      var meta = this._parseMeta(participant.metadata);
      var uid  = meta.uid || participant.identity.replace('player_', '');
      if (!uid || participant.identity.startsWith('admin') || participant.identity.startsWith('viewer')) return;

      // Build or update MediaStream for this uid
      var existing = this.streams.get(uid);
      if (!existing) {
        existing = new MediaStream();
        this.streams.set(uid, existing);
      }
      existing.addTrack(track.mediaStreamTrack);
      console.log('[LK] Track subscribed:', uid, participant.name);

      if (onStream) onStream(uid, existing, participant.name || uid, meta.team || '');
    });

    // ── Track unsubscribed ────────────────────────────────────────────────
    this.room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      var meta = this._parseMeta(participant.metadata);
      var uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      console.log('[LK] Track unsubscribed:', uid);
      if (onLeft) onLeft(uid);
    });

    // ── Participant disconnected ──────────────────────────────────────────
    this.room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      if (!participant.identity.startsWith('player_')) return;
      var meta = this._parseMeta(participant.metadata);
      var uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      console.log('[LK] Participant left:', uid);
      if (onLeft) onLeft(uid);
    });

    await this.room.connect(livekitUrl, token);
    console.log('[LK] Admin connected to room:', this.room.name);

    // Handle already-connected participants
    this.room.remoteParticipants.forEach((participant) => {
      if (!participant.identity.startsWith('player_')) return;
      participant.trackPublications.forEach((pub) => {
        if (pub.isSubscribed && pub.track && pub.track.kind === LivekitClient.Track.Kind.Video) {
          var meta   = this._parseMeta(participant.metadata);
          var uid    = meta.uid || participant.identity.replace('player_', '');
          var stream = new MediaStream([pub.track.mediaStreamTrack]);
          this.streams.set(uid, stream);
          if (onStream) onStream(uid, stream, participant.name || uid, meta.team || '');
        }
      });
    });
  }

  // ── VIEWER: subscribe to all cameras (booyah/camwall/spect) ──────────────
  async subscribeAll(viewerType, spectId, onStream, onLeft) {
    var res  = await fetch('/api/viewer-token', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ viewerType, spectId })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (this.room) {
      try { this.room.disconnect(); } catch {}
      this.room = null;
    }

    this.room = new LivekitClient.Room({ adaptiveStream: true });

    this.room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      var meta   = this._parseMeta(participant.metadata);
      var uid    = meta.uid || participant.identity.replace('player_', '');
      var stream = new MediaStream([track.mediaStreamTrack]);
      this.streams.set(uid, stream);
      if (onStream) onStream(uid, stream, participant.name || uid, meta.team || '');
    });

    this.room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind !== LivekitClient.Track.Kind.Video) return;
      var meta = this._parseMeta(participant.metadata);
      var uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      if (onLeft) onLeft(uid);
    });

    this.room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      if (!participant.identity.startsWith('player_')) return;
      var meta = this._parseMeta(participant.metadata);
      var uid  = meta.uid || participant.identity.replace('player_', '');
      this.streams.delete(uid);
      if (onLeft) onLeft(uid);
    });

    await this.room.connect(data.livekitUrl, data.token);
    console.log('[LK] Viewer connected:', viewerType);

    // Already connected
    this.room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.isSubscribed && pub.track && pub.track.kind === LivekitClient.Track.Kind.Video) {
          var meta   = this._parseMeta(participant.metadata);
          var uid    = meta.uid || participant.identity.replace('player_', '');
          var stream = new MediaStream([pub.track.mediaStreamTrack]);
          this.streams.set(uid, stream);
          if (onStream) onStream(uid, stream, participant.name || uid, meta.team || '');
        }
      });
    });
  }

  // ── Force disconnect player ───────────────────────────────────────────────
  async disconnectPlayer(uid) {
    await fetch('/api/admin/disconnect-player', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ uid })
    }).catch(() => {});
  }

  // ── Get stream ────────────────────────────────────────────────────────────
  getStream(uid) { return this.streams.get(uid) || null; }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  destroy() {
    if (this.room) { try { this.room.disconnect(); } catch {} this.room = null; }
    if (this.ws)   { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.streams.clear();
    this._wsReady = false;
  }

  _parseMeta(s) {
    try { return JSON.parse(s || '{}'); } catch { return {}; }
  }
}

window.lkClient = new LKClient();
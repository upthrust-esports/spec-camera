// ── MediaSoup Client Helper v2.0 ─────────────────────────────────────────────
// Include in all pages: <script src="/ms-client.js"></script>
// Requires socket.io and mediasoup-client from CDN

class MSClient {
  constructor() {
    this.socket        = null;
    this.device        = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers     = new Map(); // kind → producer
    this.consumers     = new Map(); // uid_kind → consumer
    this.streams       = new Map(); // uid → MediaStream
    this._onStream     = null;
    this._onLeft       = null;
  }

  // ── Connect to server ──────────────────────────────────────────────────────
  connect(serverUrl) {
    return new Promise((resolve, reject) => {
      this.socket = io(serverUrl || window.location.origin, {
        transports: ['websocket','polling'],
        reconnection: true,
        reconnectionDelay: 2000,
      });
      this.socket.on('connect',       () => { console.log('[MS] Socket connected'); resolve(); });
      this.socket.on('connect_error', (e) => { console.error('[MS] Connect error:', e.message); });
      this.socket.on('disconnect',    (r) => { console.warn('[MS] Disconnected:', r); });
    });
  }

  // ── Load mediasoup Device ──────────────────────────────────────────────────
  async loadDevice() {
    const res  = await fetch('/api/rtp-capabilities');
    const data = await res.json();
    this.device = new mediasoupClient.Device();
    await this.device.load({ routerRtpCapabilities: data.rtpCapabilities });
    console.log('[MS] Device loaded');
  }

  // ── PLAYER: start sending camera ──────────────────────────────────────────
  async startSending(localStream, uid, playerName, team) {
    await this.loadDevice();

    // Create send transport
    const tParams = await this._req('ms:createSendTransport');
    if (tParams.error) throw new Error(tParams.error);

    this.sendTransport = this.device.createSendTransport(tParams);

    this.sendTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      const r = await this._req('ms:connectSendTransport', { dtlsParameters });
      r.error ? eb(new Error(r.error)) : cb();
    });

    this.sendTransport.on('produce', async ({ kind, rtpParameters }, cb, eb) => {
      const r = await this._req('ms:produce', { kind, rtpParameters, uid, playerName, team });
      r.error ? eb(new Error(r.error)) : cb({ id: r.id });
    });

    this.sendTransport.on('connectionstatechange', state => {
      console.log('[MS] Send transport state:', state);
    });

    // Produce all tracks
    for (const track of localStream.getTracks()) {
      const producer = await this.sendTransport.produce({ track });
      this.producers.set(track.kind, producer);
      console.log('[MS] Producing:', track.kind);
    }
  }

  // ── VIEWER: start receiving all cameras ───────────────────────────────────
  async startReceiving(role, onStream, onLeft) {
    this._onStream = onStream;
    this._onLeft   = onLeft;

    await this.loadDevice();

    // Create recv transport
    const tParams = await this._req('ms:createRecvTransport', { role });
    if (tParams.error) throw new Error(tParams.error);

    this.recvTransport = this.device.createRecvTransport(tParams);

    this.recvTransport.on('connect', async ({ dtlsParameters }, cb, eb) => {
      const r = await this._req('ms:connectRecvTransport', { dtlsParameters });
      r.error ? eb(new Error(r.error)) : cb();
    });

    this.recvTransport.on('connectionstatechange', state => {
      console.log('[MS] Recv transport state:', state);
    });

    // Get existing producers
    const { producers } = await this._req('ms:getProducers');
    console.log('[MS] Existing producers:', producers.length);
    for (const p of producers) {
      await this._consume(p.uid, p.kind, p.playerName, p.team);
    }

    // New producer → auto consume
    this.socket.on('ms:newProducer', async ({ uid, kind, playerName, team }) => {
      console.log('[MS] New producer:', uid, kind);
      await this._consume(uid, kind, playerName, team);
    });

    // Producer left → clear stream
    this.socket.on('ms:producerLeft', ({ uid }) => {
      console.log('[MS] Producer left:', uid);
      ['audio','video'].forEach(kind => {
        const key = uid+'_'+kind;
        const con = this.consumers.get(key);
        if (con) { try{ con.close(); }catch{} this.consumers.delete(key); }
      });
      this.streams.delete(uid);
      if (this._onLeft) this._onLeft(uid);
    });

    // Producer closed (individual track)
    this.socket.on('ms:producerClosed', ({ uid, kind }) => {
      const key = uid+'_'+kind;
      const con = this.consumers.get(key);
      if (con) { try{ con.close(); }catch{} this.consumers.delete(key); }
      if (kind === 'video') {
        this.streams.delete(uid);
        if (this._onLeft) this._onLeft(uid);
      }
    });

    // Spect assignments
    this.socket.on('spect-update', (data) => {
      window.dispatchEvent(new CustomEvent('spect-update', { detail: data }));
    });

    // Booyah events
    this.socket.on('booyah-detected', (data) => {
      window.dispatchEvent(new CustomEvent('booyah-detected', { detail: data }));
    });
    this.socket.on('booyah-reset', () => {
      window.dispatchEvent(new CustomEvent('booyah-reset'));
    });

    // Force disconnect
    this.socket.on('force-disconnect', () => {
      window.dispatchEvent(new CustomEvent('force-disconnect'));
    });
  }

  // ── Internal: consume one producer ────────────────────────────────────────
  async _consume(uid, kind, playerName, team) {
    try {
      const params = await this._req('ms:consume', {
        uid, kind, rtpCapabilities: this.device.rtpCapabilities
      });
      if (params.error) {
        console.warn('[MS] Cannot consume', uid, kind, ':', params.error);
        return;
      }
      const consumer = await this.recvTransport.consume(params);
      this.consumers.set(uid+'_'+kind, consumer);

      // Build MediaStream per uid
      if (!this.streams.has(uid)) this.streams.set(uid, new MediaStream());
      this.streams.get(uid).addTrack(consumer.track);

      // Fire callback when video track arrives
      if (kind === 'video' && this._onStream) {
        this._onStream(uid, this.streams.get(uid), playerName, team);
      }
    } catch(e) {
      console.error('[MS] _consume error:', uid, kind, e);
    }
  }

  // ── Get stream for a specific uid ─────────────────────────────────────────
  getStream(uid) {
    return this.streams.get(uid) || null;
  }

  // ── Admin helpers ─────────────────────────────────────────────────────────
  disconnectPlayer(uid) {
    this.socket.emit('admin:disconnectPlayer', { uid });
  }
  booyahDetected(teamName) {
    this.socket.emit('admin:booyahDetected', { teamName });
  }
  booyahReset() {
    this.socket.emit('admin:booyahReset');
  }
  setSpect(spectId, uid) {
    this.socket.emit('spect:assign', { spectId, uid });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  destroy() {
    this.producers.forEach(p => { try{ p.close(); }catch{} });
    this.consumers.forEach(c => { try{ c.close(); }catch{} });
    if (this.sendTransport) try{ this.sendTransport.close(); }catch{}
    if (this.recvTransport) try{ this.recvTransport.close(); }catch{}
    if (this.socket) this.socket.disconnect();
  }

  // ── Socket request helper ─────────────────────────────────────────────────
  _req(event, data = {}) {
    return new Promise((resolve) => {
      this.socket.emit(event, data, resolve);
    });
  }
}

// Global singleton
window.msClient = new MSClient();
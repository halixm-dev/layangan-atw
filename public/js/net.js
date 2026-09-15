// Jaringan client: mode ONLINE (Socket.io ke server) atau LAN (host di browser, WebRTC via PeerJS).
// Kelas-kelas di sini meniru bagian API Socket.io yang dipakai game & server/lobby.js,
// sehingga logika room yang sama bisa berjalan di browser host tanpa server.
import { createLobby } from '/server/lobby.js';

const PEER_PREFIX = 'atw-lan-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const later = (fn) => queueMicrotask(fn);

class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(fn); return this; }
  off(ev) { this._h.delete(ev); return this; }
  removeAllListeners() { this._h.clear(); return this; }
  _fire(ev, ...args) { for (const fn of this._h.get(ev) || []) { try { fn(...args); } catch (e) { console.error(`[net] handler "${ev}"`, e); } } }
}

// ---------------------------------------------------------------- sisi pemain
/** Socket client dengan API mirip Socket.io (on / emit dengan ack / connected / id) */
export class ClientSocket extends Emitter {
  constructor(send, id) {
    super();
    this._send = send;
    this.id = id;
    this.connected = false;
    this._acks = new Map();
    this._ackId = 1;
    this.volatile = { emit: (ev, ...a) => this.emit(ev, ...a) };
  }
  connect() { return this; }
  emit(ev, ...args) {
    if (!this.connected) return this;
    let k;
    if (typeof args[args.length - 1] === 'function') {
      k = this._ackId++;
      this._acks.set(k, args.pop());
    }
    this._send({ t: 'e', ev, a: args, k });
    return this;
  }
  _receive(msg) {
    if (msg.t === 'a') { const cb = this._acks.get(msg.k); this._acks.delete(msg.k); cb?.(...(msg.a || [])); }
    else if (msg.t === 'e') this._fire(msg.ev, ...(msg.a || []));
  }
  _open() { this.connected = true; this._fire('connect'); }
  _close(reason) {
    if (!this.connected) return;
    this.connected = false;
    this._fire('disconnect', reason);
  }
}

// ---------------------------------------------------------------- sisi host
/** Representasi pemain di hub host (API seperti socket di server Socket.io) */
class HubSocket extends Emitter {
  constructor(hub, id, send) {
    super();
    this.hub = hub;
    this.id = id;
    this._send = send;
    this.channels = new Set();
  }
  emit(ev, data) { this._send({ t: 'e', ev, a: [data] }); return this; }
  join(ch) { this.channels.add(ch); this.hub._join(ch, this); }
  leave(ch) { this.channels.delete(ch); this.hub._leave(ch, this); }
  _receive(msg) {
    if (msg.t !== 'e' || typeof msg.ev !== 'string') return;
    const args = Array.isArray(msg.a) ? msg.a.slice(0, 4) : [];
    if (msg.k !== undefined) args.push((...res) => this._send({ t: 'a', k: msg.k, a: res }));
    this._fire(msg.ev, ...args);
  }
  _disconnect() {
    for (const ch of [...this.channels]) this.leave(ch);
    this._fire('disconnect');
    this.removeAllListeners();
  }
}

/** Pengganti objek `io` Socket.io untuk room.js di browser host */
class LocalHub {
  constructor() { this.channels = new Map(); }
  _join(ch, s) { if (!this.channels.has(ch)) this.channels.set(ch, new Set()); this.channels.get(ch).add(s); }
  _leave(ch, s) { this.channels.get(ch)?.delete(s); }
  to(ch) {
    const emit = (ev, data) => { for (const s of this.channels.get(ch) || []) s.emit(ev, data); };
    return { emit, volatile: { emit } };
  }
}

// ---------------------------------------------------------------- sesi LAN
export class LanSession {
  constructor(kind) {
    this.kind = kind;       // 'host' | 'join' | 'practice'
    this.peer = null;
    this.code = null;
    this.stopLoop = null;
    this.remotes = new Map();
    this.closed = false;
    this.onPlayersChanged = null;
  }

  /** Hub + lobi di browser ini, dengan pemain lokal lewat loopback */
  _startHub(code) {
    this.hub = new LocalHub();
    this.lobby = createLobby(this.hub, { makeCode: () => code || randomCode() });
    this.stopLoop = this.lobby.start();
    const id = 'local-' + Math.random().toString(36).slice(2, 8);
    let hubSide = null;
    const client = new ClientSocket((msg) => later(() => hubSide._receive(structuredClone(msg))), id);
    hubSide = new HubSocket(this.hub, id, (msg) => later(() => client._receive(msg)));
    this.lobby.onConnection(hubSide);
    this.localHubSocket = hubSide;
    later(() => client._open());
    return client;
  }

  /** Latihan vs bot sepenuhnya di browser (tanpa jaringan) */
  static practice() {
    const s = new LanSession('practice');
    s.socket = s._startHub(null);
    return s;
  }

  /** Jadikan browser ini host room LAN. Mengembalikan sesi setelah kode room terdaftar. */
  static async host() {
    if (!window.Peer) throw new Error('PeerJS tidak termuat');
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      const s = new LanSession('host');
      try {
        await s._openPeer(PEER_PREFIX + code);
      } catch (e) {
        s.close();
        if (e.type === 'unavailable-id') continue; // kode bentrok, coba kode lain
        throw e;
      }
      s.code = code;
      s.socket = s._startHub(code);
      s.peer.on('connection', (conn) => s._acceptRemote(conn));
      s.peer.on('disconnected', () => { if (!s.closed) s.peer.reconnect(); }); // koneksi ke layanan penghubung putus: room tetap jalan
      return s;
    }
    throw Object.assign(new Error('Gagal membuat kode room'), { type: 'unavailable-id' });
  }

  /** Gabung ke room LAN milik host dengan kode */
  static async join(code) {
    if (!window.Peer) throw new Error('PeerJS tidak termuat');
    const s = new LanSession('join');
    s.code = code;
    await s._openPeer(undefined);
    const conn = s.peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { type: 'timeout' })), 15000);
      conn.on('open', () => { clearTimeout(timer); resolve(); });
      conn.on('error', (e) => { clearTimeout(timer); reject(e); });
      s.peer.on('error', (e) => { clearTimeout(timer); reject(e); });
    }).catch((e) => { s.close(); throw e; });

    const client = new ClientSocket((msg) => { try { conn.send(msg); } catch { /* koneksi putus */ } }, s.peer.id);
    s.socket = client;
    s.conn = conn;
    let lastSeen = performance.now();
    conn.on('data', (msg) => { lastSeen = performance.now(); client._receive(msg); });
    conn.on('close', () => client._close('host-closed'));
    conn.on('error', () => client._close('error'));
    // deteksi host hilang (mis. tab host ditutup paksa)
    s.watchdog = setInterval(() => { if (performance.now() - lastSeen > 10000) { client._close('timeout'); s.close(); } }, 2000);
    later(() => client._open());
    return s;
  }

  _openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(id, { config: ICE, debug: 1 });
      this.peer = peer;
      const onErr = (e) => reject(e);
      peer.once('open', () => { peer.off('error', onErr); resolve(); });
      peer.once('error', onErr);
    });
  }

  _acceptRemote(conn) {
    let hs = null;
    let lastSeen = performance.now();
    const drop = () => {
      if (!hs) return;
      const h = hs;
      hs = null;
      clearInterval(watch);
      this.remotes.delete(conn.peer);
      h._disconnect();
      this.onPlayersChanged?.();
    };
    const watch = setInterval(() => { if (performance.now() - lastSeen > 12000) { try { conn.close(); } catch { /* */ } drop(); } }, 3000);
    conn.on('open', () => {
      if (this.remotes.size >= 7) { try { conn.send({ t: 'e', ev: 'errorMsg', a: [{ msg: 'Room penuh.' }] }); } catch { /* */ } setTimeout(() => conn.close(), 300); return; }
      hs = new HubSocket(this.hub, conn.peer, (msg) => { try { conn.send(msg); } catch { /* */ } });
      this.remotes.set(conn.peer, { conn, hs });
      this.lobby.onConnection(hs);
      this.onPlayersChanged?.();
    });
    conn.on('data', (msg) => { lastSeen = performance.now(); if (hs && msg && typeof msg === 'object') hs._receive(msg); });
    conn.on('close', drop);
    conn.on('error', drop);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.stopLoop?.();
    for (const { conn } of this.remotes.values()) { try { conn.close(); } catch { /* */ } }
    this.remotes.clear();
    try { this.conn?.close(); } catch { /* */ }
    try { this.peer?.destroy(); } catch { /* */ }
    this.socket?._close('closed');
  }
}

/** Pesan ramah untuk error PeerJS */
export function lanErrorMessage(e) {
  switch (e?.type) {
    case 'peer-unavailable': return 'Room tidak ditemukan. Cek kode & pastikan host masih membuka room.';
    case 'timeout': return 'Tidak bisa terhubung ke host. Pastikan satu jaringan Wi-Fi yang sama.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Layanan penghubung tidak terjangkau. Periksa koneksi internet lalu coba lagi.';
    case 'browser-incompatible': return 'Browser ini tidak mendukung WebRTC.';
    case 'unavailable-id': return 'Gagal membuat kode room, coba lagi.';
    default: return 'Koneksi LAN gagal: ' + (e?.message || e?.type || 'tidak diketahui');
  }
}

/** Jembatan socket: handler didaftarkan sekali, socket aktif bisa berganti (online ⇄ LAN) */
export class NetBridge {
  constructor() { this.handlers = []; this.sock = null; }
  on(ev, fn) { this.handlers.push([ev, fn]); this.sock?.on(ev, fn); return this; }
  use(sock) {
    if (this.sock && this.sock !== sock) this.sock.removeAllListeners?.();
    this.sock = sock;
    if (sock) for (const [ev, fn] of this.handlers) sock.on(ev, fn);
    return sock;
  }
  emit(...a) { this.sock?.emit(...a); return this; }
  get id() { return this.sock?.id; }
  get connected() { return !!this.sock?.connected; }
}

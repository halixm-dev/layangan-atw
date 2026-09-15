// Adu Layangan ATW - game server (Express + Socket.io)
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './room.js';
import { TICK_RATE, CLASSES } from '../shared/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three')));
app.get('/vendor/socket.io.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')));
// dijalankan langsung lewat Node: client terhubung ke origin yang sama
app.get('/config.js', (_req, res) => res.type('application/javascript').send('window.ATW_SERVER_URL = "";\n'));
app.get('/health', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*'); // dicek oleh frontend yang di-hosting terpisah (mis. Vercel)
  res.json({ ok: true, rooms: rooms.size });
});

const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const rooms = new Map();
const socketRoom = new Map();
let nextRoomId = 1;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while ([...rooms.values()].some((r) => r.code === code));
  return code;
}

function cleanName(n) {
  const s = String(n ?? '').replace(/[<>]/g, '').trim().slice(0, 16);
  return s || 'Pemain' + Math.floor(Math.random() * 900 + 100);
}

function leave(socket) {
  const room = socketRoom.get(socket.id);
  if (!room) return;
  room.removePlayer(socket.id);
  socketRoom.delete(socket.id);
  if (room.isEmpty()) rooms.delete(room.id);
}

function join(socket, room, name, cls) {
  leave(socket);
  rooms.set(room.id, room);
  socketRoom.set(socket.id, room);
  room.addHuman(socket, cleanName(name), CLASSES[cls] ? cls : 'speed');
  socket.emit('joined', { roomId: room.id, code: room.code, isPrivate: room.isPrivate, you: socket.id });
}

io.on('connection', (socket) => {
  socket.on('quickMatch', ({ name, cls } = {}) => {
    let room = [...rooms.values()].find((r) => r.canJoinQuick());
    if (!room) room = new Room(io, nextRoomId++);
    join(socket, room, name, cls);
  });

  socket.on('createRoom', ({ name, cls } = {}) => {
    const room = new Room(io, nextRoomId++, { isPrivate: true, code: makeCode() });
    join(socket, room, name, cls);
  });

  socket.on('joinRoom', ({ name, cls, code } = {}) => {
    const c = String(code ?? '').toUpperCase().trim();
    const room = [...rooms.values()].find((r) => r.code === c);
    if (!room) return socket.emit('errorMsg', { msg: `Room "${c}" tidak ditemukan.` });
    if (room.players.size >= 8 && room.state === 'waiting') return socket.emit('errorMsg', { msg: 'Room penuh.' });
    join(socket, room, name, cls);
  });

  socket.on('soloMatch', ({ name, cls } = {}) => {
    const room = new Room(io, nextRoomId++, { isPrivate: true, code: makeCode() });
    join(socket, room, name, cls);
    for (let i = 0; i < 5; i++) room.addBot();
    room.startMatch();
  });

  socket.on('setClass', ({ cls } = {}) => socketRoom.get(socket.id)?.setClass(socket.id, cls));

  socket.on('addBot', () => {
    const room = socketRoom.get(socket.id);
    if (room && room.hostId === socket.id && room.state === 'waiting') room.addBot();
  });

  socket.on('kickBots', () => {
    const room = socketRoom.get(socket.id);
    if (!room || room.hostId !== socket.id || room.state !== 'waiting') return;
    for (const p of [...room.players.values()]) if (p.isBot) room.players.delete(p.id);
    room.broadcastRoom();
  });

  socket.on('startMatch', () => {
    const room = socketRoom.get(socket.id);
    if (room && room.hostId === socket.id) room.startMatch();
  });

  socket.on('leaveRoom', () => leave(socket));
  socket.on('st', (d) => socketRoom.get(socket.id)?.onClientState(socket.id, d));
  socket.on('act', (type) => socketRoom.get(socket.id)?.onAction(socket.id, type));
  socket.on('ping2', (t, cb) => typeof cb === 'function' && cb(t));
  socket.on('disconnect', () => leave(socket));
});

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) {
    try {
      room.tick(dt);
    } catch (e) {
      console.error('[room tick error]', e);
    }
  }
}, 1000 / TICK_RATE);

http.listen(PORT, () => {
  console.log(`\n  🪁  Adu Layangan ATW berjalan di http://localhost:${PORT}\n`);
});

// Adu Layangan ATW - game server online (Express + Socket.io)
// Tanpa server ini, game tetap bisa dimainkan lewat mode LAN (host di browser, WebRTC).
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLobby } from './lobby.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
// modul logika room juga dipakai host LAN di browser
for (const f of ['room.js', 'bot.js', 'lobby.js']) {
  app.get(`/server/${f}`, (_req, res) => res.type('application/javascript').sendFile(path.join(root, 'server', f)));
}
app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three')));
app.get('/vendor/socket.io.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')));
app.get('/vendor/peerjs.min.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js')));
// dijalankan langsung lewat Node: client terhubung ke origin yang sama
app.get('/config.js', (_req, res) => res.type('application/javascript').send('window.ATW_SERVER_URL = "";\n'));
app.get('/health', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*'); // dicek oleh frontend yang di-hosting terpisah (mis. Vercel)
  res.json({ ok: true, rooms: lobby.rooms.size });
});

const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
const lobby = createLobby(io);
io.on('connection', (socket) => lobby.onConnection(socket));
lobby.start();

http.listen(PORT, () => {
  console.log(`\n  🪁  Adu Layangan ATW berjalan di http://localhost:${PORT}\n`);
});

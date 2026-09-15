// Build frontend statis ke dist/ (untuk Vercel / hosting statis lain).
// Menyalin public/, shared/, dan library dari node_modules sehingga tidak butuh server Express.
//   ATW_SERVER_URL=https://server-game-kamu.onrender.com npm run build
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const nm = path.join(root, 'node_modules');

if (!['three', 'socket.io', 'peerjs'].every((m) => existsSync(path.join(nm, m)))) {
  console.error('[build] node_modules belum lengkap. Jalankan "npm install" terlebih dahulu.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copy = (from, to) => {
  cpSync(path.join(root, from), path.join(dist, to), { recursive: true });
  console.log(`[build] ${from} -> dist/${to}`);
};

copy('public', '.');
copy('shared', 'shared');
// logika room/lobi: dijalankan di browser host saat mode LAN (WebRTC)
for (const f of ['room.js', 'bot.js', 'lobby.js']) copy(`server/${f}`, `server/${f}`);
copy('node_modules/peerjs/dist/peerjs.min.js', 'vendor/peerjs.min.js');
// Three.js: hanya file yang dipakai game
copy('node_modules/three/build/three.module.js', 'vendor/three/build/three.module.js');
copy('node_modules/three/build/three.core.js', 'vendor/three/build/three.core.js');
copy('node_modules/three/examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/GLTFLoader.js');
copy('node_modules/three/examples/jsm/utils', 'vendor/three/examples/jsm/utils');
copy('node_modules/three/examples/jsm/lines', 'vendor/three/examples/jsm/lines');
// Socket.io client
copy('node_modules/socket.io/client-dist/socket.io.min.js', 'vendor/socket.io.min.js');

// Alamat server game (Socket.io). Kosong = origin yang sama (mis. saat dijalankan lewat `npm start`).
const serverUrl = (process.env.ATW_SERVER_URL || '').trim().replace(/\/+$/, '');
writeFileSync(path.join(dist, 'config.js'), `window.ATW_SERVER_URL = ${JSON.stringify(serverUrl)};\n`);
console.log(`[build] config.js -> ATW_SERVER_URL = ${serverUrl || '(origin yang sama)'}`);
if (!serverUrl && process.env.VERCEL) {
  console.warn('[build] PERINGATAN: ATW_SERVER_URL belum diset. Vercel tidak bisa menjalankan server Socket.io,');
  console.warn('        set env ATW_SERVER_URL ke alamat server game (mis. Render/Railway) lalu redeploy.');
}
console.log('[build] selesai -> dist/');

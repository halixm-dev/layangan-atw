# 🪁 Adu Layangan ATW

Game 3D berbasis web, **Mini Battle Royale adu layangan** (4–8 pemain, multiplayer online), diimplementasikan dari `GDD_Adu_Layangan_3D_PvP.md`.

- **Client:** Three.js (tanpa build step), kontrol PC & touchscreen
- **Server:** Node.js + Express + Socket.io (logika tempur dipegang server)
- **Aset 3D:** dibuat prosedural dengan **Blender** (script Python → `.glb`)

## Menjalankan

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Untuk main bareng teman di jaringan yang sama, buka `http://<IP-komputer>:3000` dari perangkat lain.
Port bisa diganti: `PORT=8080 npm start`.

### Membuat ulang aset 3D (Blender)

```bash
npm run assets
```

Script mencari Blender di `E:\5. Programs\4. Blender\blender.exe` (atau set env `BLENDER_PATH`).
Model dibuat oleh [blender/build_assets.py](blender/build_assets.py) dan diekspor ke `public/assets/`:

| File | Isi |
|---|---|
| `kite_speed.glb` | Speed Hunter – layangan aduan wajik ramping |
| `kite_heavy.glb` | Heavy Brawler – layangan lebar rangka bambu tebal + rumbai |
| `kite_acro.glb` | Acrobatic Wind – sayap melengkung + ekor pita |
| `rooftop_base.glb` | Rumah 2 lantai dengan dak, toren air, antena bambu (base pemain) |
| `player.glb` | Karakter berpeci memegang kaleng gelangan benang |
| `house_a/b.glb`, `mosque.glb`, `palm.glb`, `tree.glb`, `mountain.glb` | Lingkungan kampung |

Material bernama `Sail` (layangan) dan `Shirt` (karakter) diwarnai otomatis sesuai warna pemain.

## Fitur sesuai GDD

- **Tension Meter** – Kendur (<25%) sulit dikendali & rentan; Optimal (60–85%) bonus potong ×1.5; >90% selama 1.5 detik → benang putus sendiri.
- **Gesekan** – `ΔHP = (V_relatif × Koef Tajam) × sin(θ)`, bonus sudut 45°–70°, yang menarik lebih cepat unggul.
- **Zona badai** menyusut bertahap (~4,5 menit); di luar zona layangan jatuh & putus dalam 5 detik.
- **Benang hantu** – benang layangan yang putus melayang ±9 detik dan memotong siapa saja.
- **3 kelas** + skill aktif: Snatch Cut, Tension Guard, Thermal Lift.
- **Alur match:** lobi → peluncuran serentak → adu udara → badai menyusut → juara (last kite flying) → hasil.
- **Mode:** Main Online (matchmaking publik), Room Privat (kode 4 huruf / link `?room=KODE`), Latihan vs Bot. Slot kosong diisi bot AI.

## UI

Desain antarmuka mengikuti project **18. Layangan ATW** (gaya editorial pastel — kertas krem, tinta hijau tua, aksen oranye, font Manrope + DM Sans):
beranda "Rebut langitmu." dengan panel pilih jagoan & layangan hero 3D, modal lobi dengan kode room yang bisa disalin sebagai link,
HUD kartu (masih mengudara, angin/zona, minimap bergrid, tegangan benang, tombol SENTAK/SKILL), label nama kertas, layar hasil, dialog panduan & gabung room.

## Fisika tumbukan

Tata letak kampung & collider bangunan ada di [shared/arena.js](shared/arena.js) dan dipakai identik oleh client & server.

- **Layangan vs bangunan/pohon** — bola vs kotak berotasi/silinder; didorong keluar sepanjang normal kontak, impuls normal dengan restitusi 0,25 dan gesekan Coulomb (μ 0,6), jadi layangan memantul atau tersangkut di atap, tidak tembus.
- **Benang vs bangunan** — benang tegang mengambil lintasan terpendek di atas atap (upper convex hull); titik lilitan menjadi poros baru dan sisa tali = L − panjang lilitan.
- **Benang vs benang** — kendala kontak position-based: sisi kontak diingat sehingga benang saling menekan & bergesek (tetap memotong), hanya bisa lepas dengan bergeser melewati ujung layangan. Dorongan dibagi menurut massa kelas. Efek benturan: benang menekuk di titik kontak, bergetar, kilatan cincin, percikan, bunyi petikan.

## Kontrol

| PC | Mobile |
|---|---|
| `W` menukik · `S` menanjak · `A/D` belok | Joystick kiri |
| Scroll atas / `R` ulur · Scroll bawah / `F` tarik | Slider kanan (atas ulur, bawah tarik) |
| Klik kiri = Snatch Strike | Tombol SNAP |
| Tension Hold otomatis saat tidak menekan apa pun | Lepas semua kontrol |
| `Q` / Spasi = Skill | Tombol SKILL |
| `Shift` = Sprint Dive (stamina) | Tombol DIVE (di atas SKILL) |
| `V` kamera · `H` bantuan | 🎥 |

Kemudi bersifat langsung: arah tombol/joystick = arah gerak layangan, dan layangan bertahan di posisinya saat dilepas. Opsi **balik W/S** (W = naik) ada di dialog panduan.
Di perangkat sentuh, game selalu mengajak masuk **layar penuh** (saat dibuka, saat match dimulai, dan saat keluar dari layar penuh). Di iPhone yang tidak mendukung Fullscreen API, gunakan "Tambahkan ke Layar Utama".

## Struktur

```
server/     index.js (HTTP + socket, matchmaking), room.js (match, potong benang, zona, hantu), bot.js (AI)
shared/     constants.js (tuning & kelas), physics.js (fisika layangan, dipakai client & server)
public/     index.html, css/, js/ (game, world, hud, input, audio, main), assets/*.glb
blender/    build_assets.py
```

Tuning gameplay (damage, zona, statistik kelas) ada di [shared/constants.js](shared/constants.js).

## Deploy online

Game ini terdiri dari dua bagian:

| Bagian | Isi | Hosting |
|---|---|---|
| **Frontend statis** | HTML/JS/aset 3D (`npm run build` → `dist/`) | Vercel, Netlify, GitHub Pages, dll. |
| **Server game realtime** | Express + Socket.io, loop 30 Hz (`npm start`) | Render, Railway, Fly.io, VPS — **wajib mendukung WebSocket & proses yang terus berjalan** |

> Vercel **tidak bisa** menjalankan server Socket.io (fungsi serverless tanpa koneksi WebSocket permanen). Karena itu server game di-deploy terpisah.

### Opsi A — Semua di Render (paling sederhana)
1. Render → **New → Blueprint** → pilih repo ini (memakai [render.yaml](render.yaml)).
2. Buka URL Render-nya. Frontend & server berjalan bersama, tanpa konfigurasi tambahan.

### Opsi B — Frontend di Vercel + server di Render
1. Deploy server seperti Opsi A, catat URL-nya, mis. `https://adu-layangan-atw.onrender.com`.
2. Di Vercel: import repo. [vercel.json](vercel.json) otomatis menjalankan `npm install` → `npm run build` → output `dist/`.
3. Vercel → **Settings → Environment Variables**: `ATW_SERVER_URL` = URL server dari langkah 1.
4. **Redeploy** (env dibaca saat build dan ditulis ke `dist/config.js`).

Uji build secara lokal: `ATW_SERVER_URL=http://localhost:3000 npm run build` lalu `npm run preview`.
Catatan: paket gratis Render "tidur" setelah tidak aktif, sehingga koneksi pertama bisa butuh ±30–60 detik. Pertandingan disimpan di memori server (satu instance).

## Catatan

Pergerakan layangan diprediksi di client (responsif) dan divalidasi server (batas kecepatan & panjang benang); HP benang, potongan, zona, dan pemenang ditentukan server.

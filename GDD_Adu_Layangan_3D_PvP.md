# Dokumen Desain Game (GDD): Mini Battle Royale Adu Layangan 3D (PvP)

## 1. Ikhtisar Proyek (Overview)
* **Genre:** 3D Aerial Combat / Kite Dogfight Simulator
* **Mode Permainan:** Mini Battle Royale (Free-for-All, 4–8 Pemain)
* **Target Platform:** Mobile (Touchscreen) & PC (Keyboard + Mouse)
* **Tujuan Akhir:** Menjadi layangan terakhir yang bertahan di angkasa dengan memotong benang semua lawan menggunakan kalkulasi fisika tarikan, sudut gesek, dan adaptasi angin.

---

## 2. Mekanik Inti Pertarungan (Core Combat Mechanics)

### 2.1. Fisika Tegangan Benang (Tension Meter)
Ketegangan benang dinyatakan dalam rentang parameter dinamis:
* **Slack Zone (0% - 25%):** Benang terlalu kendur. Layangan kehilangan respons kendali, mudah terpotong jika diserempet oleh benang berkecepatan tinggi.
* **Optimal Cut Zone (60% - 85%):** Zona ideal untuk memotong lawan. Memberikan bonus *Abrasion Damage* maksimal ketika menyilang benang musuh.
* **Snap / Overload Zone (90% - 100%):** Zona merah. Jika berada di ambang ini lebih dari 1.5 detik saat terjadi tarikan keras, benang pemain putus sendiri akibat tegangan berlebih.

### 2.2. Sistem Gesekan & Abrasi (Frictional Damage)
Kemenangan adu benang ditentukan oleh kalkulasi kecepatan relatif dan sudut potong:
$$\Delta HP_{benang} = (V_{relatif} \times \text{Koefisien Tajam}) \times \sin(\theta_{silang})$$
* **Kecepatan Gesek ($V_{relatif}$):** Pemain yang sedang menarik benang dengan cepat saat bertubrukan memiliki keunggulan abrasi atas pemain yang statis.
* **Sudut Silang ($\theta_{silang}$):** Sudut 45°–70° menghasilkan daya potong tertinggi.

### 2.3. Lingkungan & Safe Zone (The Wind Vortex)
* **Dynamic Ring Shrink:** Badai pusaran angin mengecilkan arena udara secara bertahap dalam kurun waktu 3–5 menit per ronde.
* **Dead Zone & Hazard:** Layangan yang tersapu ke luar batas zona aman kehilangan gaya angkat aerodinamis dan benang terputus otomatis dalam 5 detik.
* **Ghost Strings (Benang Hantu):** Benang dari layangan yang gugur melayang bebas terbawa arus angin selama 8–10 detik, memotong siapa saja yang tidak sengaja melintasinya.

---

## 3. Sistem Kustomisasi & Kelas Rancang Bangun (Build Archetypes)

| Atribut / Komponen | Tipe: Speed Hunter | Tipe: Heavy Brawler | Tipe: Acrobatic Wind |
| :--- | :--- | :--- | :--- |
| **Profil Rangka** | Sayap ramping, aerodinamis tinggi | Rangka bambu tebal & berlapis | Sayap melengkung fleksibel |
| **Spesialisasi Benang** | *Silikon Glass Ultra* (Damage gesek kritis, rapuh) | *Matot Baja* (HP benang tinggi, tahan gesekan) | *Katun Berlapis Wax* (Ulur kilat, minim panas) |
| **Karakteristik Kecepatan** | Laju menukik sangat cepat | Pergerakan lambat, tahan terpaan | Radius putar sempit, manuver gesit |
| **Keahlian Aktif (Skill)** | **Snatch Cut:** Sentakan tali instan berdaya potong tinggi | **Tension Guard:** Kebal aus abrasi selama 2 detik | **Thermal Lift:** Manuver vertikal mendadak ke atas |

---

## 4. Skema Kontrol (Control Scheme)

### 4.1. Kontrol Touchscreen (Mobile)

```
+-------------------------------------------------------------+
| [Tension HUD]                 [Minimap / Safezone]  [Score] |
|                                                             |
|                                     ( Skill Aktif ) [Btn]   |
|                                                             |
|    (^) Pitch Up                                             |
| (<) O (>) Roll/Yaw                  [==== SLIDER ====]      |
|    (v) Pitch Down                   |   Mengulur     |      |
|                                     |      O         |      |
| [ Thumbstick Virtual ]              |   Menarik      |      |
|                                     [================]      |
|                                     [ TAP: Snap Strike ]    |
+-------------------------------------------------------------+
```

* **Thumbstick Virtual (Kiri Bawah):** Mengontrol manuver aerodinamis layangan (Pitch & Roll).
* **Slider Tarik-Ulur (Kanan Bawah):**
  * Geser ke atas: Mengulur benang (*Feed String*).
  * Geser ke bawah: Menarik benang (*Pull String*).
* **Tap Cepat pada Tombol Snap (Kanan Bawah):** Menghasilkan hentakan mendadak untuk menyayat benang lawan seketika.
* **Tombol Skill (Kanan Atas):** Memicu keahlian unik kelas rakitan.

---

### 4.2. Kontrol Keyboard & Mouse (PC)

* **Navigasi Sayap (Flight Control):**
  * `W` : Menukik tajam (*Pitch Down / Dive*).
  * `S` : Menanjak melawan angin (*Pitch Up / Climb*).
  * `A` / `D` : Bermanuver belok atau miring (*Roll / Yaw Left - Right*).
* **Manajemen Tali (String Management):**
  * `Scroll Wheel Up` : Mengulur benang secara bertahap.
  * `Scroll Wheel Down` : Menggulung / menarik benang ke bawah.
* **Aksi Pertarungan (Combat Action):**
  * `Klik Kiri (LMB)` : *Snatch Strike* (Hentakan tarikan instan untuk memotong).
  * `Klik Kanan (RMB)` : *Tension Hold* (Mengunci posisi tali untuk menahan tekanan).
  * `Spacebar` atau `Q` : Mengaktifkan Keahlian Khusus (*Active Skill*).
  * `Shift Kiri` : *Sprint Dive* (Akselerasi menukik darurat dengan konsumsi stamina).

---

## 5. Flow Pertandingan (Match Flow)

```
[ Matchmaking: 4-8 Pemain ]
             |
             v
[ Fase Peluncuran: Naik Serentak dari Ground Zero ]
             |
             v
[ Fase Pertarungan Udara: Berebut Arus Angin & Manuver Silang ]
             |
             v
[ Pengecilan Dinding Badai: Intensitas Kontak Bertambah ]
             |
             v
[ Penentuan Juara: Last Kite Flying ]
```
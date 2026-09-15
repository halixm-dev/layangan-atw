// Konstanta & tuning bersama (dipakai server dan client)

export const TICK_RATE = 30;             // simulasi server (Hz)
export const SNAPSHOT_RATE = 15;         // kirim state ke client (Hz)
export const CLIENT_SEND_RATE = 20;      // client kirim state layangan (Hz)

export const MIN_PLAYERS = 4;            // diisi bot hingga jumlah ini
export const MAX_PLAYERS = 8;
export const LOBBY_COUNTDOWN = 25;       // detik menunggu pemain di room publik
export const LAUNCH_TIME = 6;            // fase peluncuran (tanpa damage)
export const RESULT_TIME = 10;

export const ROOF_HEIGHT = 6.0;          // tinggi dak rumah base pemain
export const HAND_HEIGHT = ROOF_HEIGHT + 1.34;
export const BASE_RING_RADIUS = 26;      // posisi rumah base mengelilingi pusat arena

export const LINE_MIN = 14;
export const LINE_MAX = 150;
export const LINE_START = 34;
export const KITE_MIN_Y = 3;
export const MAX_ELEVATION = 1.38;       // rad (~79°) batas zenit

// Zona tegangan benang (GDD 2.1)
export const TENSION = {
  SLACK: 0.25,
  OPT_MIN: 0.6,
  OPT_MAX: 0.85,
  OVERLOAD: 0.9,
  SNAP_TIME: 1.5,
};

// Gesekan (GDD 2.2)
export const CUT = {
  HIT_DIST: 0.9,          // jarak antar benang dianggap bersilang (m)
  K: 0.18,                 // koefisien damage global
  BASE_SAW: 3,            // gesekan minimum walau statis
  ANGLE_BONUS_MIN: 45,
  ANGLE_BONUS_MAX: 70,
  ANGLE_BONUS: 1.35,
  OPT_BONUS: 1.5,
  SLACK_VULN: 1.5,
  SNATCH_SAW: 26,
  GHOST_DPS: 9,
};

// Zona badai (GDD 2.3). t = detik sejak fase tempur dimulai
export const ZONE = {
  CENTER: [0, 0],
  STAGES: [
    { t: 0, r: 150 },
    { t: 35, r: 150 },
    { t: 80, r: 105 },
    { t: 105, r: 105 },
    { t: 150, r: 70 },
    { t: 175, r: 70 },
    { t: 215, r: 45 },
    { t: 240, r: 45 },
    { t: 280, r: 26 },
  ],
  OUT_LIMIT: 5,
  SINK: 5,
};

export const GHOST_LIFE = 9;

export const PLAYER_COLORS = [
  0xe63946, 0x1d8cf8, 0xffb703, 0x2ec27e, 0x9d4edd, 0xff6fb5, 0x00c2c7, 0xf77f00,
];

// Kelas rancang bangun (GDD 3)
export const CLASSES = {
  speed: {
    id: 'speed',
    name: 'Speed Hunter',
    frame: 'Sayap ramping, aerodinamis tinggi',
    string: 'Silikon Glass Ultra',
    desc: 'Laju menukik sangat cepat. Benang tajam tapi rapuh.',
    skill: 'Snatch Cut',
    skillDesc: 'Sentakan tali instan berdaya potong x3 selama 1.2 detik.',
    model: 'kite_speed.glb',
    speed: 1.3, turn: 2.4, sharpness: 1.6, hp: 70, feed: 1.0, pull: 1.1, heat: 1.0, sink: 1.1,
    skillCd: 10, skillDur: 1.2,
    stats: { speed: 5, power: 5, defense: 2, agility: 3 },
  },
  heavy: {
    id: 'heavy',
    name: 'Heavy Brawler',
    frame: 'Rangka bambu tebal & berlapis',
    string: 'Matot Baja',
    desc: 'Pergerakan lambat, tahan terpaan dan gesekan.',
    skill: 'Tension Guard',
    skillDesc: 'Kebal aus abrasi selama 2 detik.',
    model: 'kite_heavy.glb',
    speed: 0.82, turn: 1.9, sharpness: 1.0, hp: 150, feed: 0.9, pull: 1.0, heat: 0.85, sink: 0.7,
    skillCd: 12, skillDur: 2.0,
    stats: { speed: 2, power: 3, defense: 5, agility: 2 },
  },
  acro: {
    id: 'acro',
    name: 'Acrobatic Wind',
    frame: 'Sayap melengkung fleksibel',
    string: 'Katun Berlapis Wax',
    desc: 'Radius putar sempit, ulur kilat, minim panas.',
    skill: 'Thermal Lift',
    skillDesc: 'Manuver vertikal mendadak ke atas.',
    model: 'kite_acro.glb',
    speed: 1.0, turn: 3.8, sharpness: 1.15, hp: 100, feed: 1.7, pull: 1.0, heat: 0.55, sink: 0.9,
    skillCd: 8, skillDur: 1.0,
    stats: { speed: 3, power: 3, defense: 3, agility: 5 },
  },
};

export const SNATCH = { CD: 1.1, DUR: 0.3, PULL: 2.2 };
export const STAMINA = { MAX: 100, DRAIN: 38, REGEN: 14 };

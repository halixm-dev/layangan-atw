// AI bot sederhana untuk mengisi arena
import { tangentBasis, clamp } from '../shared/physics.js';
import { TENSION, CLASSES } from '../shared/constants.js';

const BOT_NAMES = ['Ujang', 'Asep', 'Dadang', 'Cecep', 'Tono', 'Siti', 'Joko', 'Wati', 'Komar', 'Euis', 'Bambang', 'Rini'];
const CLASS_IDS = Object.keys(CLASSES);

export function botIdentity(usedNames) {
  const free = BOT_NAMES.filter((n) => !usedNames.has('Bot ' + n));
  const name = 'Bot ' + (free.length ? free[Math.floor(Math.random() * free.length)] : Math.floor(Math.random() * 999));
  return { name, cls: CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)] };
}

export function createBrain() {
  return {
    targetId: null,
    retarget: 0,
    aggression: 0.55 + Math.random() * 0.45,
    reaction: 0.08 + Math.random() * 0.15,
    wobble: Math.random() * 10,
    think: 0,
    input: { x: 0, y: 1, reel: 0, hold: false, sprint: false },
    offset: (Math.random() - 0.5) * 2,
  };
}

/**
 * Menghasilkan input + aksi untuk bot.
 * ctx: { players (array alive), zoneR, strings: Map(id -> Float32Array), contacts: Set(id), time }
 */
export function botThink(p, ctx, dt) {
  const k = p.kite;
  const br = p.brain;
  br.think -= dt;
  br.retarget -= dt;
  br.wobble += dt;
  const actions = { snatch: false, skill: false };

  if (br.think > 0) return { input: br.input, actions };
  br.think = br.reaction;

  // pilih target
  const enemies = ctx.players.filter((o) => o !== p && o.alive && o.kite);
  let target = enemies.find((o) => o.id === br.targetId);
  if (!target || br.retarget <= 0) {
    let best = null, bd = Infinity;
    for (const o of enemies) {
      const d = Math.hypot(o.kite.px - k.px, o.kite.py - k.py, o.kite.pz - k.pz) * (0.7 + Math.random() * 0.6);
      if (d < bd) { bd = d; best = o; }
    }
    target = best;
    br.targetId = best?.id ?? null;
    br.retarget = 3 + Math.random() * 4;
  }

  const b = tangentBasis(k);
  let gx = k.ax, gy = k.ay + 40, gz = k.az; // default: naik ke atas
  let desiredL = 40;

  if (target) {
    const pts = ctx.strings.get(target.id);
    if (pts) {
      // sasar titik di benang lawan, dengan offset menyapu
      const n = pts.length / 3 - 1;
      const idx = clamp(Math.round(n * (0.55 + 0.25 * Math.sin(br.wobble * 0.7 + br.offset))), 1, n);
      gx = pts[idx * 3];
      gy = pts[idx * 3 + 1] + 4 * Math.sin(br.wobble * 1.3);
      gz = pts[idx * 3 + 2];
      desiredL = Math.hypot(gx - k.ax, gy - k.ay, gz - k.az) * (1.05 + 0.1 * br.aggression);
    }
  }

  // hindari tepi zona
  const horiz = Math.hypot(k.px, k.pz);
  const danger = horiz > ctx.zoneR * 0.82;
  if (danger) {
    gx = k.ax * 0.3; gz = k.az * 0.3; gy = k.ay + 45;
    desiredL = Math.min(k.L, Math.max(16, ctx.zoneR * 0.6));
  }

  const dx = gx - k.px, dy = gy - k.py, dz = gz - k.pz;
  let ix = dx * b.rx + dy * b.ry + dz * b.rz;
  let iy = dx * b.ux + dy * b.uy + dz * b.uz;
  const m = Math.hypot(ix, iy) || 1;
  ix /= m; iy /= m;
  if (k.power < 0.3 || k.py < 10) { iy = Math.max(iy, 0.8); }

  let reel = clamp((desiredL - k.L) / 6, -1, 1) * (0.6 + 0.4 * br.aggression);
  if (k.T > 0.86 || k.overT > 0.6) reel = 0.8;
  else if (k.T < TENSION.SLACK + 0.1) reel = Math.min(reel, -0.5);
  if (danger) reel = Math.min(reel, -0.6);

  const inContact = ctx.contacts.has(p.id);
  br.input = {
    x: ix,
    y: iy,
    reel,
    sprint: !danger && target && k.stamina > 40 && iy < -0.4 && Math.random() < br.aggression * 0.5,
  };

  if (inContact) {
    if (k.snatchCd <= 0 && k.T < 0.72 && Math.random() < br.aggression) actions.snatch = true;
    if (k.skillCd <= 0) {
      if (k.cls === 'speed' && Math.random() < 0.6) actions.skill = true;
      if (k.cls === 'heavy' && p.hp < p.maxHp * 0.7) actions.skill = true;
    }
  }
  if (k.cls === 'acro' && k.skillCd <= 0 && (danger || k.py < 12 || (inContact && Math.random() < 0.3))) actions.skill = true;

  return { input: br.input, actions };
}

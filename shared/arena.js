// Arena bersama (client + server): tata letak kampung deterministik & collider bangunan.
// Collider berupa kolom vertikal: kotak berotasi (box) atau silinder (cyl), dengan rentang tinggi y0..y1.
import { basePosition } from './physics.js'; // siklus aman: hanya dipakai saat runtime

const TAU = Math.PI * 2;
const CELL = 16;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- tata letak statis
function generateLayout() {
  const rand = mulberry32(777001);
  const houses = [], palms = [], trees = [];
  const occupied = [[0, 0, 48], [110, -130, 22]];
  const free = (x, z, rad) => occupied.every(([ox, oz, or]) => Math.hypot(ox - x, oz - z) > or + rad);
  for (let i = 0; i < 1400 && houses.length < 170; i++) {
    const a = rand() * TAU;
    const r = 52 + Math.pow(rand(), 1.5) * 420;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs(x + 60) < 10 || Math.abs(z - 70) < 10) continue;
    if (!free(x, z, 7)) continue;
    occupied.push([x, z, 7]);
    const rot = Math.round(rand() * 4) * (Math.PI / 2) + (rand() - 0.5) * 0.2;
    const variant = rand() < 0.55 ? 'a' : 'b';
    houses.push({ x, z, rot, s: 0.9 + rand() * 0.25, variant });
  }
  for (let i = 0; i < 2500 && palms.length + trees.length < 360; i++) {
    const a = rand() * TAU, r = 45 + rand() * 650;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!free(x, z, 2)) continue;
    occupied.push([x, z, 2]);
    if (rand() < 0.55) palms.push({ x, z, rot: rand() * TAU, s: 0.8 + rand() * 0.5 });
    else trees.push({ x, z, rot: rand() * TAU, s: 0.8 + rand() * 0.7 });
  }
  return { houses, palms, trees, mosque: { x: 110, z: -130, rot: 0.4 } };
}

export const LAYOUT = generateLayout();

// ---------------------------------------------------------------- pembuat collider
// Transformasi lokal (sumbu Y three.js): world = pos + R(rot) * (s * local)
function tf(o, lx, lz) {
  const c = Math.cos(o.rot), sn = Math.sin(o.rot), s = o.s ?? 1;
  return [o.x + s * (lx * c + lz * sn), o.z + s * (-lx * sn + lz * c)];
}
function box(o, lx, lz, hx, hz, y0, y1) {
  const s = o.s ?? 1;
  const [x, z] = tf(o, lx, lz);
  return { type: 'box', x, z, cos: Math.cos(o.rot), sin: Math.sin(o.rot), hx: hx * s, hz: hz * s, y0: y0 * s, y1: y1 * s };
}
function cyl(o, lx, lz, r, y0, y1) {
  const s = o.s ?? 1;
  const [x, z] = tf(o, lx, lz);
  return { type: 'cyl', x, z, r: r * s, y0: y0 * s, y1: y1 * s };
}

function houseColliders(h) {
  const out = [
    box(h, 0, 0, 3.5, 3.0, 0, 3.6),   // dinding
    box(h, 0, 0, 4.2, 3.7, 3.6, 4.4), // tritisan atap
  ];
  if (h.variant === 'a') out.push(box(h, 0, 0, 2.6, 1.9, 4.4, 5.8)); // atap limasan
  else out.push(box(h, 0, 0, 4.2, 1.8, 4.4, 6.0));                   // atap pelana
  return out;
}

function staticColliders() {
  const list = [];
  for (const h of LAYOUT.houses) list.push(...houseColliders(h));
  for (const p of LAYOUT.palms) {
    list.push(cyl(p, 0.45, 0, 0.3, 0, 9));
    list.push(cyl(p, 0.9, 0, 3.0, 6.8, 9.9));
  }
  for (const t of LAYOUT.trees) {
    list.push(cyl(t, 0, 0, 0.35, 0, 3));
    list.push(cyl(t, 0, 0, 2.7, 2.5, 7.3));
  }
  const m = LAYOUT.mosque;
  list.push(box(m, 0, 0, 6, 6, 0, 5.6));
  list.push(box(m, 0, 0, 3.5, 3.5, 5.6, 6.6));
  list.push(cyl(m, 0, 0, 3.0, 6.6, 10.7));
  list.push(cyl(m, 8.5, -8.5, 1.3, 0, 18.4));
  return list;
}

function baseColliders(count) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const b = basePosition(i, count);
    const o = { x: b.x, z: b.z, rot: -Math.atan2(b.z, b.x) + Math.PI / 2 };
    list.push(box(o, 0, 0, 3.65, 3.65, 0, 6.1)); // rumah 2 lantai + dak
    list.push(cyl(o, 2.2, -2.2, 0.8, 6.1, 8.9)); // toren air
  }
  return list;
}

function footprintRadius(c) { return c.type === 'box' ? Math.hypot(c.hx, c.hz) : c.r; }

function buildGrid(list) {
  const grid = new Map();
  for (const c of list) {
    const fr = footprintRadius(c);
    const x0 = Math.floor((c.x - fr) / CELL), x1 = Math.floor((c.x + fr) / CELL);
    const z0 = Math.floor((c.z - fr) / CELL), z1 = Math.floor((c.z + fr) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const key = ix * 100003 + iz;
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(c);
      }
    }
  }
  return grid;
}

const STATIC = staticColliders();
let stamp = 1;
for (const c of STATIC) c._s = 0;

/** Arena untuk satu pertandingan (jumlah base berbeda per room) */
export function createArena(baseCount) {
  const list = STATIC.concat(baseColliders(baseCount));
  for (const c of list) c._s = 0;
  return { list, grid: buildGrid(list), maxTop: 19 };
}

/** Kumpulkan collider di sekitar titik (x,z) dalam radius rad (tanpa duplikat) */
export function queryColliders(arena, x, z, rad, out = []) {
  const s = ++stamp;
  const x0 = Math.floor((x - rad) / CELL), x1 = Math.floor((x + rad) / CELL);
  const z0 = Math.floor((z - rad) / CELL), z1 = Math.floor((z + rad) / CELL);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const arr = arena.grid.get(ix * 100003 + iz);
      if (!arr) continue;
      for (const c of arr) if (c._s !== s) { c._s = s; out.push(c); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- tumbukan bola (layangan)
const _near = [];
/**
 * Mendorong bola (px,py,pz,R) keluar dari collider. Mengembalikan normal & kedalaman terbesar,
 * atau null bila tidak bersentuhan. p = {x,y,z} dimodifikasi langsung.
 */
export function resolveSphere(arena, p, R) {
  if (!arena || p.y - R > arena.maxTop) return null;
  _near.length = 0;
  queryColliders(arena, p.x, p.z, R + 1, _near);
  let hit = null;
  for (let iter = 0; iter < 2; iter++) {
    let any = false;
    for (const c of _near) {
      if (p.y - R > c.y1 || p.y + R < c.y0) continue;
      let qx, qy, qz, inside = false, nx = 0, ny = 0, nz = 0, depth = 0;
      qy = Math.min(Math.max(p.y, c.y0), c.y1);
      if (c.type === 'box') {
        const dx = p.x - c.x, dz = p.z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        const cx = Math.min(Math.max(lx, -c.hx), c.hx), cz = Math.min(Math.max(lz, -c.hz), c.hz);
        inside = cx === lx && cz === lz && qy === p.y;
        if (inside) {
          // keluar lewat sisi dengan penetrasi terkecil
          const opts = [
            [c.hx - lx, 1, 0, 0], [lx + c.hx, -1, 0, 0], [c.hz - lz, 0, 0, 1], [lz + c.hz, 0, 0, -1],
            [c.y1 - p.y, 0, 1, 0], [p.y - c.y0, 0, -1, 0],
          ];
          if (c.y0 <= 0.01) opts.pop(); // tidak bisa keluar lewat bawah tanah
          let best = opts[0];
          for (const o of opts) if (o[0] < best[0]) best = o;
          depth = best[0] + R;
          // normal lokal → dunia
          const lnx = best[1], lnz = best[3];
          nx = lnx * c.cos + lnz * c.sin; nz = -lnx * c.sin + lnz * c.cos; ny = best[2];
        } else {
          qx = c.x + cx * c.cos + cz * c.sin;
          qz = c.z - cx * c.sin + cz * c.cos;
        }
      } else {
        const dx = p.x - c.x, dz = p.z - c.z;
        const d = Math.hypot(dx, dz);
        inside = d < c.r && qy === p.y;
        if (inside) {
          const side = c.r - d, top = c.y1 - p.y, bottom = c.y0 > 0.01 ? p.y - c.y0 : Infinity;
          if (top <= side && top <= bottom) { depth = top + R; ny = 1; }
          else if (bottom <= side) { depth = bottom + R; ny = -1; }
          else { depth = side + R; nx = d > 1e-6 ? dx / d : 1; nz = d > 1e-6 ? dz / d : 0; }
        } else {
          const k = d > c.r ? c.r / d : 1;
          qx = c.x + dx * k; qz = c.z + dz * k;
        }
      }
      if (!inside) {
        const ex = p.x - qx, ey = p.y - qy, ez = p.z - qz;
        const dist = Math.hypot(ex, ey, ez);
        if (dist >= R || dist < 1e-6) continue;
        nx = ex / dist; ny = ey / dist; nz = ez / dist;
        depth = R - dist;
      }
      p.x += nx * depth; p.y += ny * depth; p.z += nz * depth;
      any = true;
      if (!hit || depth > hit.depth) hit = { nx, ny, nz, depth };
    }
    if (!any) break;
  }
  return hit;
}

// ---------------------------------------------------------------- benang melilit bangunan
/** Interval parameter s (jarak horizontal) di mana garis horizontal A→dir melewati footprint collider */
function footprintInterval(c, ax, az, dx, dz, S) {
  if (c.type === 'box') {
    const rx = ax - c.x, rz = az - c.z;
    const ox = rx * c.cos - rz * c.sin, oz = rx * c.sin + rz * c.cos;
    const vx = dx * c.cos - dz * c.sin, vz = dx * c.sin + dz * c.cos;
    let t0 = 0, t1 = S;
    for (const [o, v, h] of [[ox, vx, c.hx], [oz, vz, c.hz]]) {
      if (Math.abs(v) < 1e-9) { if (o < -h || o > h) return null; continue; }
      let a = (-h - o) / v, b = (h - o) / v;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }
  const fx = ax - c.x, fz = az - c.z;
  const bq = fx * dx + fz * dz, cq = fx * fx + fz * fz - c.r * c.r;
  const disc = bq * bq - cq;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, -bq - sq), t1 = Math.min(S, -bq + sq);
  return t0 <= t1 ? [t0, t1] : null;
}

const _cands = [];
const _pts = [];
/**
 * Lintasan benang tegang dari jangkar A ke layangan K yang melewati atas bangunan
 * (upper convex hull pada bidang vertikal A–K). Mengembalikan array titik poros [x,y,z,...] (tanpa A & K).
 */
export function wrapPivots(arena, ax, ay, az, kx, ky, kz, out = []) {
  out.length = 0;
  if (!arena) return out;
  const hx = kx - ax, hz = kz - az;
  const S = Math.hypot(hx, hz);
  if (S < 1.5 || Math.min(ay, ky) > arena.maxTop) return out;
  const dx = hx / S, dz = hz / S;
  _cands.length = 0;
  const s0 = ++stamp;
  for (let s = 0; s <= S + 8; s += 8) {
    const ss = Math.min(s, S);
    const y = ay + (ky - ay) * (ss / S);
    if (y > arena.maxTop + 2 && s > 0) continue;
    const x = ax + dx * ss, z = az + dz * ss;
    const x0 = Math.floor((x - 9) / CELL), x1 = Math.floor((x + 9) / CELL);
    const z0 = Math.floor((z - 9) / CELL), z1 = Math.floor((z + 9) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = arena.grid.get(ix * 100003 + iz);
        if (!arr) continue;
        for (const c of arr) if (c._s !== s0) { c._s = s0; _cands.push(c); }
      }
    }
  }
  if (!_cands.length) return out;
  // titik kandidat (s, y) = tepi atas collider yang memotong tali
  _pts.length = 0;
  _pts.push(0, ay);
  const CLR = 0.15;
  for (const c of _cands) {
    const iv = footprintInterval(c, ax, az, dx, dz, S);
    if (!iv) continue;
    const top = c.y1 + CLR;
    const yA = ay + (ky - ay) * (iv[0] / S), yB = ay + (ky - ay) * (iv[1] / S);
    if (Math.min(yA, yB) >= top) continue;
    _pts.push(iv[0], top, iv[1], top);
  }
  if (_pts.length === 2) return out;
  _pts.push(S, ky);
  // urutkan menurut s lalu upper hull (monotone chain)
  const idx = [];
  for (let i = 0; i < _pts.length / 2; i++) idx.push(i);
  idx.sort((a, b) => _pts[a * 2] - _pts[b * 2]);
  const hull = [];
  for (const i of idx) {
    const sx = _pts[i * 2], sy = _pts[i * 2 + 1];
    while (hull.length >= 2) {
      const [ax2, ay2] = hull[hull.length - 2], [bx2, by2] = hull[hull.length - 1];
      // buang titik b bila tidak membentuk belokan ke bawah (hull atas)
      if ((bx2 - ax2) * (sy - ay2) - (by2 - ay2) * (sx - ax2) >= 0) hull.pop();
      else break;
    }
    hull.push([sx, sy]);
  }
  for (let i = 1; i < hull.length - 1; i++) {
    const [s, y] = hull[i];
    if (s <= 0.05 || s >= S - 0.05) continue;
    out.push(ax + dx * s, y, az + dz * s);
  }
  return out;
}

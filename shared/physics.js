// Fisika layangan bersama (server + client). Tanpa dependensi.
import {
  CLASSES, TENSION, CUT, ZONE, SNATCH, STAMINA,
  LINE_MIN, LINE_MAX, LINE_START, KITE_MIN_Y, MAX_ELEVATION,
  HAND_HEIGHT, BASE_RING_RADIUS,
} from './constants.js';
import { resolveSphere, wrapPivots } from './arena.js';

export const KITE_RADIUS = 1.3;          // radius tumbukan layangan (m)
export const STRING_SEP = 0.45;          // jarak minimum dua benang yang saling menekan (m)
export const KITE_MASS = { speed: 1, heavy: 1.7, acro: 0.9 };
const RESTITUTION = 0.25;                // pantulan saat menabrak bangunan
const FRICTION = 0.6;                    // koefisien gesek Coulomb dengan atap/dinding

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---------------------------------------------------------------- Angin & zona
export function windAt(t) {
  const angle = 0.6 + 0.9 * Math.sin(t * 0.021) + 0.35 * Math.sin(t * 0.057 + 1.3);
  const speed = 8 + 2 * Math.sin(t * 0.09) + 1 * Math.sin(t * 0.23 + 0.7);
  return { angle, speed };
}

export function zoneRadiusAt(t) {
  const s = ZONE.STAGES;
  if (t <= s[0].t) return s[0].r;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i].t) {
      const a = s[i - 1], b = s[i];
      return lerp(a.r, b.r, (t - a.t) / (b.t - a.t));
    }
  }
  return s[s.length - 1].r;
}

/** Waktu (detik) hingga zona mulai/berhenti menyusut berikutnya */
export function zoneNextEvent(t) {
  const s = ZONE.STAGES;
  for (let i = 1; i < s.length; i++) {
    if (t < s[i].t) {
      const shrinking = s[i].r < s[i - 1].r;
      return { in: s[i].t - t, shrinking, target: s[i].r };
    }
  }
  return null;
}

// ---------------------------------------------------------------- Spawn
export function basePosition(index, count) {
  const a = (index / count) * TAU + 0.3;
  return { x: Math.cos(a) * BASE_RING_RADIUS, z: Math.sin(a) * BASE_RING_RADIUS, yaw: a };
}

export function createKite(id, cls, index, count, wind) {
  const b = basePosition(index, count);
  const ax = b.x, ay = HAND_HEIGHT, az = b.z;
  const L = 6;
  const el = 0.5;
  const px = ax + Math.cos(wind.angle) * Math.cos(el) * L;
  const pz = az + Math.sin(wind.angle) * Math.cos(el) * L;
  const py = ay + Math.sin(el) * L;
  return {
    id, cls, index,
    ax, ay, az,
    px, py, pz, vx: 0, vy: 0, vz: 0,
    psi: 0, speed: 0, vr: 0, vu: 0,
    L, reel: 0, T: 0.4, overT: 0,
    stamina: STAMINA.MAX,
    snatchCd: 0, snatchT: 0,
    skillCd: 0, skillT: 0, liftT: 0,
    hold: false, sprint: false,
    saw: 0, power: 0,
    outT: 0,
    snapped: false,
  };
}

// ---------------------------------------------------------------- Basis tangen
export function tangentBasis(k) {
  let nx = k.px - k.ax, ny = k.py - k.ay, nz = k.pz - k.az;
  const r = Math.hypot(nx, ny, nz) || 1;
  nx /= r; ny /= r; nz /= r;
  // up = Y - n*(n.y)
  let ux = -nx * ny, uy = 1 - ny * ny, uz = -nz * ny;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  // right = n x up
  const rx = ny * uz - nz * uy;
  const ry = nz * ux - nx * uz;
  const rz = nx * uy - ny * ux;
  return { nx, ny, nz, ux, uy, uz, rx, ry, rz, r };
}

export function headingVector(k, b = tangentBasis(k)) {
  const c = Math.cos(k.psi), s = Math.sin(k.psi);
  return {
    x: b.ux * c + b.rx * s,
    y: b.uy * c + b.ry * s,
    z: b.uz * c + b.rz * s,
  };
}

// ---------------------------------------------------------------- Aksi
export function trySnatch(k) {
  if (k.snatchCd > 0 || k.snapped) return false;
  k.snatchT = SNATCH.DUR;
  k.snatchCd = SNATCH.CD;
  return true;
}

export function trySkill(k) {
  const cls = CLASSES[k.cls];
  if (k.skillCd > 0 || k.snapped) return false;
  k.skillT = cls.skillDur;
  k.skillCd = cls.skillCd;
  if (k.cls === 'acro') k.liftT = cls.skillDur;
  if (k.cls === 'speed') { k.snatchT = SNATCH.DUR; }
  return true;
}

/**
 * Satu langkah simulasi layangan.
 * inp: { x, y, reel, sprint }  (hold otomatis saat tidak ada input)   x: -1 kiri..1 kanan, y: -1 menukik..1 menanjak,
 *      reel: -1 tarik .. 1 ulur
 * env: { wind:{angle,speed}, zoneR, launch, dt }
 */
export function stepKite(k, inp, env, dt) {
  const cls = CLASSES[k.cls];
  k.snatchCd = Math.max(0, k.snatchCd - dt);
  k.snatchT = Math.max(0, k.snatchT - dt);
  k.skillCd = Math.max(0, k.skillCd - dt);
  k.skillT = Math.max(0, k.skillT - dt);
  k.liftT = Math.max(0, k.liftT - dt);

  let ix = inp.x || 0, iy = inp.y || 0, reelIn = inp.reel || 0;
  let sprint = !!inp.sprint;
  // Tension Hold otomatis: tidak menekan apa pun (kemudi, ulur/tarik, sprint) = tali ditahan
  let hold = Math.hypot(ix, iy) < 0.12 && Math.abs(reelIn) < 0.05 && !sprint;

  // --- benang melilit bangunan: titik lilitan terakhir menjadi poros, sisa tali = L - panjang lilitan
  const world = env.world;
  let cx = k.ax, cy = k.ay, cz = k.az, wrapLen = 0;
  if (world) {
    const piv = wrapPivots(world, k.ax, k.ay, k.az, k.px, k.py, k.pz, k._piv || (k._piv = []));
    let x = k.ax, y = k.ay, z = k.az;
    for (let i = 0; i < piv.length; i += 3) {
      wrapLen += Math.hypot(piv[i] - x, piv[i + 1] - y, piv[i + 2] - z);
      x = piv[i]; y = piv[i + 1]; z = piv[i + 2];
    }
    cx = x; cy = y; cz = z;
  }
  const b = tangentBasis({ ax: cx, ay: cy, az: cz, px: k.px, py: k.py, pz: k.pz });
  // peluncuran: naik ke elevasi ±45° lalu tahan, sambil mengulur benang
  if (env.launch) { ix = 0; iy = b.ny < 0.7 ? 1 : 0; reelIn = k.L < LINE_START ? 1 : 0; hold = false; sprint = false; }

  const wdx = Math.cos(env.wind.angle), wdz = Math.sin(env.wind.angle);
  const windF = env.wind.speed / 8;
  const power = clamp((0.3 + 0.7 * (b.nx * wdx + b.nz * wdz)) * windF, 0, 1.25);
  k.power = power;

  // --- stamina / sprint dive
  const canSprint = sprint && k.stamina > 1;
  if (canSprint) k.stamina = Math.max(0, k.stamina - STAMINA.DRAIN * dt);
  else k.stamina = Math.min(STAMINA.MAX, k.stamina + STAMINA.REGEN * dt);
  k.sprint = canSprint;
  k.hold = hold;

  // --- kemudi langsung: arah input = arah gerak di bidang tangen (kanan/atas).
  // Tanpa input layangan melambat & bertahan di posisinya (tidak melengkung/berbalik sendiri).
  const slack = k.T < TENSION.SLACK;
  const control = slack ? 0.45 : 1;
  let mag = Math.hypot(ix, iy);
  if (mag > 1) { ix /= mag; iy /= mag; mag = 1; }
  if (mag < 0.12) { ix = 0; iy = 0; mag = 0; }
  // batas lunak: melambat mendekati zenit / tanah, bukan menabrak lalu tersangkut
  const el = Math.asin(clamp(b.ny, -1, 1));
  if (iy > 0) iy *= clamp((MAX_ELEVATION - el) / 0.3, 0, 1);
  if (iy < 0) iy *= clamp((k.py - KITE_MIN_Y) / 5, 0, 1);

  let maxSpeed = cls.speed * (6 + 12 * Math.min(1, power)) * (0.5 + 0.7 * k.T);
  if (k.snatchT > 0) maxSpeed *= 1.3;
  let tr = ix * maxSpeed, tu = iy * maxSpeed;
  if (iy < -0.3) tu *= 1.15;
  if (canSprint) {
    // sprint dive: akselerasi darurat searah input, condong menukik
    const s = maxSpeed * 1.7;
    const dx = mag > 0 ? ix : 0, dy = mag > 0 ? iy - 0.6 : -1;
    const dl = Math.hypot(dx, dy) || 1;
    tr = (dx / dl) * s; tu = (dy / dl) * s;
  }
  // rem lebih kuat saat berbalik arah (mis. naik → turun) supaya respon terasa langsung
  const opposing = (k.vr || 0) * tr + (k.vu || 0) * tu < 0;
  const accel = (16 + cls.turn * 6) * control * (mag === 0 ? 1.2 : opposing ? 1.8 : 1);
  const dvr = tr - (k.vr || 0), dvu = tu - (k.vu || 0);
  const dvl = Math.hypot(dvr, dvu);
  const stepV = Math.min(dvl, accel * dt);
  if (dvl > 1e-6) { k.vr = (k.vr || 0) + (dvr / dvl) * stepV; k.vu = (k.vu || 0) + (dvu / dvl) * stepV; }
  k.speed = Math.hypot(k.vr, k.vu);

  // arah hidung (visual & kamera) mengikuti arah gerak; diam = tegak ke atas
  const psiTarget = k.speed > 1.5 ? Math.atan2(k.vr, k.vu) : 0;
  const dPsi = angleDiff(k.psi, psiTarget);
  k.psi = angleDiff(0, k.psi + clamp(dPsi, -7 * dt, 7 * dt));

  let vx = b.rx * k.vr + b.ux * k.vu;
  let vy = b.ry * k.vr + b.uy * k.vu;
  let vz = b.rz * k.vr + b.uz * k.vu;

  // tenggelam: benang kendur / daya angkat rendah / di luar zona
  let sink = 0;
  if (slack) sink += (1 - k.T / TENSION.SLACK) * 4 * cls.sink;
  if (power < 0.35) sink += (0.35 - power) * 9 * cls.sink;
  if (env.outOfZone) sink += ZONE.SINK;
  vy -= sink;
  if (k.liftT > 0) vy += 26 * (k.liftT / cls.skillDur);

  // --- tarik ulur
  let reelRate = 0;
  if (!hold) reelRate = reelIn > 0 ? reelIn * 9 * cls.feed : reelIn * 7 * cls.pull;
  if (k.snatchT > 0) reelRate -= SNATCH.PULL / SNATCH.DUR;
  const minL = env.launch ? 4 : LINE_MIN;
  const prevL = k.L;
  k.L = clamp(k.L + reelRate * dt, minL, LINE_MAX);
  if (!env.launch && prevL < LINE_MIN) k.L = Math.min(LINE_MIN, prevL + 12 * dt);
  k.reel = reelRate;

  // --- integrasi + proyeksi ke bola radius (sisa tali) di sekitar poros
  const Lr = Math.max(1.5, k.L - wrapLen);
  const ox = k.px, oy = k.py, oz = k.pz;
  let px = k.px + vx * dt, py = k.py + vy * dt, pz = k.pz + vz * dt;
  let rx = px - cx, ry = py - cy, rz = pz - cz;
  let rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // batas zenit
  const maxNy = Math.sin(MAX_ELEVATION);
  if (ry > maxNy) {
    const hl = Math.hypot(rx, rz) || 1;
    const hs = Math.cos(MAX_ELEVATION) / hl;
    rx *= hs; rz *= hs; ry = maxNy;
    if (k.vu > 0) k.vu *= 0.5;
  }
  px = cx + rx * Lr; py = cy + ry * Lr; pz = cz + rz * Lr;
  if (py < KITE_MIN_Y) {
    const ny = clamp((KITE_MIN_Y - cy) / Lr, -1, 1);
    const hl = Math.hypot(rx, rz) || 1;
    const hs = Math.sqrt(Math.max(0, 1 - ny * ny)) / hl;
    px = cx + rx * hs * Lr; py = KITE_MIN_Y; pz = cz + rz * hs * Lr;
    if (k.vu < 0) k.vu *= 0.5;
  }

  // --- tumbukan dengan bangunan/pohon: dorong keluar sepanjang normal kontak,
  //     impuls normal dengan restitusi + gesekan Coulomb pada komponen tangensial
  k.bump = 0;
  if (world) {
    const P = { x: px, y: py, z: pz };
    for (let it = 0; it < 3; it++) {
      const hit = resolveSphere(world, P, KITE_RADIUS);
      if (!hit) break;
      if (it === 0) {
        let wx = b.rx * k.vr + b.ux * k.vu, wy = b.ry * k.vr + b.uy * k.vu, wz = b.rz * k.vr + b.uz * k.vu;
        const vn = wx * hit.nx + wy * hit.ny + wz * hit.nz;
        if (vn < 0) {
          const jn = -(1 + RESTITUTION) * vn;
          wx += jn * hit.nx; wy += jn * hit.ny; wz += jn * hit.nz;
          const vtn = wx * hit.nx + wy * hit.ny + wz * hit.nz;
          let tx = wx - vtn * hit.nx, ty = wy - vtn * hit.ny, tz = wz - vtn * hit.nz;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 1e-6) {
            const f = Math.max(0, 1 - (FRICTION * jn) / tl);
            wx = vtn * hit.nx + tx * f; wy = vtn * hit.ny + ty * f; wz = vtn * hit.nz + tz * f;
          }
          k.vr = wx * b.rx + wy * b.ry + wz * b.rz;
          k.vu = wx * b.ux + wy * b.uy + wz * b.uz;
          k.bump = -vn;
          k.bumpN = [hit.nx, hit.ny, hit.nz];
        }
      }
      // tali tidak bisa memanjang: bila terdorong keluar radius, tarik kembali ke bola tali
      const ddx = P.x - cx, ddy = P.y - cy, ddz = P.z - cz;
      const dd = Math.hypot(ddx, ddy, ddz);
      if (dd > Lr) { P.x = cx + (ddx / dd) * Lr; P.y = cy + (ddy / dd) * Lr; P.z = cz + (ddz / dd) * Lr; }
    }
    resolveSphere(world, P, KITE_RADIUS); // prioritaskan tidak menembus
    px = P.x; py = Math.max(KITE_MIN_Y, P.y); pz = P.z;
  }
  k.px = px; k.py = py; k.pz = pz;
  k.vx = (px - ox) / dt; k.vy = (py - oy) / dt; k.vz = (pz - oz) / dt;

  // --- tegangan benang
  let tT = 0.18 + 0.5 * Math.min(1, power);
  tT += (Math.max(0, -reelRate) / 7) * 0.45;
  tT -= (Math.max(0, reelRate) / 9) * 0.5;
  tT += (k.speed / 30) * 0.15;
  if (k.snatchT > 0) tT += 0.35;
  if (hold) tT += 0.12;
  if (canSprint) tT += 0.1;
  tT = clamp(tT, 0, 1);
  const rate = k.snatchT > 0 ? 12 : hold ? 1.5 : 3.5;
  k.T += (tT - k.T) * Math.min(1, dt * rate);

  if (!env.launch) {
    if (k.T >= TENSION.OVERLOAD) k.overT += dt * cls.heat;
    else k.overT = Math.max(0, k.overT - dt * 1.5);
  } else k.overT = 0;

  // --- kecepatan gesek (V relatif)
  k.saw = CUT.BASE_SAW + Math.max(0, -reelRate) * 1.2 + k.speed * 0.35 + (k.snatchT > 0 ? CUT.SNATCH_SAW : 0);
  return k;
}

// ---------------------------------------------------------------- Geometri benang
export const STRING_SEGMENTS = 12;

export function stringSag(ax, ay, az, px, py, pz, T) {
  const dist = Math.hypot(px - ax, py - ay, pz - az);
  return (1 - clamp(T, 0, 1)) ** 2 * dist * 0.1 + dist * 0.012;
}

const _nodes = [];
const _spans = [];
/**
 * Titik-titik benang di sepanjang lintasan nodes [x,y,z, ...] (tangan → poros... → layangan).
 * Tiap bentang punya lendutan sendiri; bentang yang menempel bangunan lebih kencang.
 */
export function buildStringPath(nodes, T, out, N, tightFactor = 0.35) {
  const n = nodes.length / 3;
  let total = 0;
  _spans.length = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(nodes[(i + 1) * 3] - nodes[i * 3], nodes[(i + 1) * 3 + 1] - nodes[i * 3 + 1], nodes[(i + 1) * 3 + 2] - nodes[i * 3 + 2]);
    _spans.push(l);
    total += l;
  }
  const sagMul = n > 2 ? tightFactor : 1;
  let span = 0, acc = 0;
  for (let k = 0; k <= N; k++) {
    const d = (k / N) * total;
    while (span < _spans.length - 1 && d > acc + _spans[span]) { acc += _spans[span]; span++; }
    const l = _spans[span] || 1;
    const t = clamp((d - acc) / l, 0, 1);
    const i = span * 3;
    const sag = (1 - clamp(T, 0, 1)) ** 2 * l * 0.1 + l * 0.012;
    out[k * 3] = nodes[i] + (nodes[i + 3] - nodes[i]) * t;
    out[k * 3 + 1] = nodes[i + 1] + (nodes[i + 4] - nodes[i + 1]) * t - sag * sagMul * 4 * t * (1 - t);
    out[k * 3 + 2] = nodes[i + 2] + (nodes[i + 5] - nodes[i + 2]) * t;
  }
  return out;
}

const _spPiv = [];
/** Mengisi out (array panjang (N+1)*3) dengan titik-titik benang dari tangan ke layangan (melilit bangunan bila ada world) */
export function stringPoints(ax, ay, az, px, py, pz, T, out, N = STRING_SEGMENTS, world = null) {
  const piv = world ? wrapPivots(world, ax, ay, az, px, py, pz, _spPiv) : (_spPiv.length = 0, _spPiv);
  _nodes.length = 0;
  _nodes.push(ax, ay, az, ...piv, px, py, pz);
  return buildStringPath(_nodes, T, out, N);
}

// ---------------------------------------------------------------- Benturan benang vs benang
/** Mendorong layangan sepanjang n; komponen kecepatan yang menuju benang lawan diredam (tumbukan inelastis) */
export function pushKite(k, nx, ny, nz, amount) {
  k.px += nx * amount; k.py += ny * amount; k.pz += nz * amount;
  if (k.vr === undefined) return;
  const b = tangentBasis(k);
  let wx = b.rx * k.vr + b.ux * k.vu, wy = b.ry * k.vr + b.uy * k.vu, wz = b.rz * k.vr + b.uz * k.vu;
  const vn = wx * nx + wy * ny + wz * nz;
  if (vn < 0) {
    wx -= 1.2 * vn * nx; wy -= 1.2 * vn * ny; wz -= 1.2 * vn * nz;
    k.vr = wx * b.rx + wy * b.ry + wz * b.rz;
    k.vu = wx * b.ux + wy * b.uy + wz * b.uz;
  }
}

/**
 * Kendala kontak dua benang (position-based): benang yang bersentuhan saling menekan dan
 * bergesek, tidak bisa saling menembus. Sisi kontak diingat di `states` sehingga benang hanya bisa
 * lepas dengan bergeser melewati ujung (layangan). Dorongan dibagi menurut massa kelas.
 * sA/sB: titik benang (N+1)*3. applyA/applyB: simulator ini yang memiliki layangan tsb.
 */
export function resolveStringPair(states, key, kA, sA, kB, sB, applyA, applyB, N = STRING_SEGMENTS, maxPush = 0.35) {
  let best = null;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const r = segSegDist(
        sA[i * 3], sA[i * 3 + 1], sA[i * 3 + 2], sA[(i + 1) * 3], sA[(i + 1) * 3 + 1], sA[(i + 1) * 3 + 2],
        sB[j * 3], sB[j * 3 + 1], sB[j * 3 + 2], sB[(j + 1) * 3], sB[(j + 1) * 3 + 1], sB[(j + 1) * 3 + 2],
      );
      if (r.d2 < 16 && (!best || r.d2 < best.d2)) best = { d2: r.d2, s: r.s, t: r.t, i, j };
    }
  }
  if (!best) { states.delete(key); return null; }
  const { i, j, s, t } = best;
  const ax = sA[i * 3] + (sA[(i + 1) * 3] - sA[i * 3]) * s;
  const ay = sA[i * 3 + 1] + (sA[(i + 1) * 3 + 1] - sA[i * 3 + 1]) * s;
  const az = sA[i * 3 + 2] + (sA[(i + 1) * 3 + 2] - sA[i * 3 + 2]) * s;
  const bx = sB[j * 3] + (sB[(j + 1) * 3] - sB[j * 3]) * t;
  const by = sB[j * 3 + 1] + (sB[(j + 1) * 3 + 1] - sB[j * 3 + 1]) * t;
  const bz = sB[j * 3 + 2] + (sB[(j + 1) * 3 + 2] - sB[j * 3 + 2]) * t;
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  const dist = Math.sqrt(best.d2);
  let st = states.get(key);
  if (!st) {
    if (dist < 1e-4) return null;
    st = { nx: dx / dist, ny: dy / dist, nz: dz / dist, touch: false };
    states.set(key, st);
  }
  const posA = (i + s) / N, posB = (j + t) / N;
  let sep = dx * st.nx + dy * st.ny + dz * st.nz;
  if (sep < 0 && (posA > 0.95 || posB > 0.95)) {
    // tergelincir lewat ujung benang (layangan): sisi kontak berganti
    if (dist > 1e-4) { st.nx = dx / dist; st.ny = dy / dist; st.nz = dz / dist; }
    sep = dist;
  } else if (sep > STRING_SEP * 0.6 && dist > 1e-4) {
    // ikuti arah pisah saat benang bergeser (sliding), tanpa pernah membalik sisi
    const mx = st.nx * 0.75 + (dx / dist) * 0.25, my = st.ny * 0.75 + (dy / dist) * 0.25, mz = st.nz * 0.75 + (dz / dist) * 0.25;
    const ml = Math.hypot(mx, my, mz) || 1;
    st.nx = mx / ml; st.ny = my / ml; st.nz = mz / ml;
  }
  let impact = false;
  if (sep < STRING_SEP) {
    const pen = STRING_SEP - sep;
    impact = !st.touch;
    st.touch = true;
    const mA = KITE_MASS[kA.cls] ?? 1, mB = KITE_MASS[kB.cls] ?? 1;
    const shareA = mB / (mA + mB), shareB = mA / (mA + mB);
    // koreksi dibatasi per langkah: benang terasa "menahan" alih-alih melempar layangan
    if (applyA) pushKite(kA, st.nx, st.ny, st.nz, clamp((pen * shareA) / Math.max(posA, 0.35), 0, maxPush));
    if (applyB) pushKite(kB, -st.nx, -st.ny, -st.nz, clamp((pen * shareB) / Math.max(posB, 0.35), 0, maxPush));
  } else if (sep > STRING_SEP * 2.2) {
    st.touch = false;
  }
  return { touch: st.touch, impact, x: (ax + bx) / 2, y: (ay + by) / 2, z: (az + bz) / 2, dist };
}

/** Jarak terdekat antara segmen p1-q1 dan p2-q2. Mengembalikan {d2, s, t} */
export function segSegDist(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  const EPS = 1e-8;
  if (a <= EPS && e <= EPS) { s = t = 0; }
  else if (a <= EPS) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - bb * bb;
      s = denom !== 0 ? clamp((bb * f - c * e) / denom, 0, 1) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((bb - c) / a, 0, 1); }
    }
  }
  const cx = p1x + d1x * s - (p2x + d2x * t);
  const cy = p1y + d1y * s - (p2y + d2y * t);
  const cz = p1z + d1z * s - (p2z + d2z * t);
  return { d2: cx * cx + cy * cy + cz * cz, s, t };
}

/** Faktor sudut silang: sin(θ) dengan bonus 45°–70° (GDD 2.2) */
export function angleFactor(dx1, dy1, dz1, dx2, dy2, dz2) {
  const l1 = Math.hypot(dx1, dy1, dz1) || 1, l2 = Math.hypot(dx2, dy2, dz2) || 1;
  const cos = Math.abs((dx1 * dx2 + dy1 * dy2 + dz1 * dz2) / (l1 * l2));
  const theta = Math.acos(clamp(cos, 0, 1));
  const deg = (theta * 180) / Math.PI;
  let f = Math.sin(theta);
  if (deg >= CUT.ANGLE_BONUS_MIN && deg <= CUT.ANGLE_BONUS_MAX) f *= CUT.ANGLE_BONUS;
  return { f: Math.max(0.15, f), deg };
}

export function tensionZone(T) {
  if (T >= TENSION.OVERLOAD) return 'overload';
  if (T >= TENSION.OPT_MIN && T <= TENSION.OPT_MAX) return 'optimal';
  if (T < TENSION.SLACK) return 'slack';
  return 'normal';
}

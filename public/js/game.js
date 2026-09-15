// Inti client: scene Three.js, layangan, benang, kamera, prediksi lokal & interpolasi
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  CLASSES, CLIENT_SEND_RATE, ZONE, LINE_START, TENSION, HAND_HEIGHT,
} from '/shared/constants.js';
import {
  createKite, stepKite, trySnatch, trySkill, tangentBasis, headingVector,
  stringPoints, basePosition, windAt, angleDiff, clamp,
  buildStringPath, resolveStringPair, STRING_SEGMENTS,
} from '/shared/physics.js';
import { createArena, resolveSphere, wrapPivots } from '/shared/arena.js';
import { World, cloneTinted } from './world.js';

const ASSET_NAMES = ['kite_speed', 'kite_heavy', 'kite_acro', 'house_a', 'house_b', 'rooftop_base', 'player', 'palm', 'tree', 'mosque', 'mountain'];
const RENDER_SEGMENTS = 28;
const KITE_SCALE = 2.4;
const INTERP_DELAY = 120;
const MENU_COLORS = { speed: 0xdd522d, heavy: 0x368b85, acro: 0x9875b1 };

// ---------------------------------------------------------------------------------------------
class StringLine {
  constructor(color, width, opacity = 1, maxPoints = RENDER_SEGMENTS + 1) {
    this.maxPoints = maxPoints;
    this.geo = new LineGeometry();
    this.geo.setPositions(new Float32Array(maxPoints * 3));
    this.mat = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    this.line = new Line2(this.geo, this.mat);
    this.line.frustumCulled = false;
    this.data = this.geo.attributes.instanceStart.data;
    this.pts = new Float32Array(maxPoints * 3);
  }
  /** pts: Float32Array titik (x,y,z)*n */
  setPoints(pts, n) {
    const a = this.data.array;
    const segs = n - 1;
    for (let i = 0; i < segs; i++) {
      a[i * 6] = pts[i * 3]; a[i * 6 + 1] = pts[i * 3 + 1]; a[i * 6 + 2] = pts[i * 3 + 2];
      a[i * 6 + 3] = pts[(i + 1) * 3]; a[i * 6 + 4] = pts[(i + 1) * 3 + 1]; a[i * 6 + 5] = pts[(i + 1) * 3 + 2];
    }
    this.geo.instanceCount = segs;
    this.data.needsUpdate = true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/** Label nama bergaya kertas (DOM) yang mengikuti posisi layangan di layar */
function makeLabel(info) {
  const el = document.createElement('div');
  el.className = 'player-label';
  el.style.borderBottomColor = '#' + new THREE.Color(info.color).getHexString();
  el.textContent = info.name;
  if (info.isBot) {
    const s = document.createElement('small');
    s.textContent = 'BOT';
    el.append(s);
  }
  document.getElementById('labels').append(el);
  return el;
}
const _proj = new THREE.Vector3();
/** Batasi bunyi benturan beruntun agar tidak menumpuk */
function now_throttle(obj, ms) {
  const t = performance.now();
  if (t - (obj._lastTwang || 0) < ms) return false;
  obj._lastTwang = t;
  return true;
}

// ---------------------------------------------------------------------------------------------
class KiteView {
  constructor(game, info, isMe) {
    this.game = game;
    this.id = info.id;
    this.info = info;
    this.isMe = isMe;
    this.model = cloneTinted(game.assets[CLASSES[info.cls].model.replace('.glb', '')], 'Sail', info.color);
    this.model.scale.setScalar(KITE_SCALE);
    this.model.traverse((o) => { if (o.isMesh) o.castShadow = game.quality.shadows; });
    this.root = new THREE.Group();
    this.root.add(this.model);
    game.scene.add(this.root);

    const col = new THREE.Color(info.color).lerp(new THREE.Color(0xffffff), 0.45);
    this.string = new StringLine(col, isMe ? 2.6 : 2.0);
    game.scene.add(this.string.line);
    this.pts = new Float32Array((RENDER_SEGMENTS + 1) * 3);
    this.physPts = new Float32Array((STRING_SEGMENTS + 1) * 3);
    this.piv = [];
    this.nodes = [];
    this.kink = null;
    this.shake = 0;
    this.shakeT = 0;

    if (!isMe && info.name) this.label = makeLabel(info);
    // efek aura skill
    this.aura = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.root.add(this.aura);

    this.state = null;
    this.buffer = [];
    this.falling = null;
    this.wobble = Math.random() * 10;
    this.roll = 0;
    this.lastPsi = 0;
    this.m4 = new THREE.Matrix4();
  }

  pushSnapshot(t, s) {
    this.buffer.push({ t, ...s });
    if (this.buffer.length > 30) this.buffer.shift();
  }

  interpolated(now) {
    const rt = now - INTERP_DELAY;
    const b = this.buffer;
    if (!b.length) return null;
    if (rt <= b[0].t) return b[0];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= rt) {
        const a = b[i], c = b[i + 1];
        if (!c) return a;
        const f = (rt - a.t) / (c.t - a.t || 1);
        return {
          px: a.px + (c.px - a.px) * f, py: a.py + (c.py - a.py) * f, pz: a.pz + (c.pz - a.pz) * f,
          psi: a.psi + angleDiff(a.psi, c.psi) * f, L: a.L + (c.L - a.L) * f, T: a.T + (c.T - a.T) * f,
          flags: c.flags,
        };
      }
    }
    return b[b.length - 1];
  }

  /** k: {ax,ay,az,px,py,pz,psi,T,flags} */
  render(k, dt) {
    this.wobble += dt * (4 + (1 - k.T) * 6);
    const b = tangentBasis(k);
    const h = headingVector(k, b);
    const turn = angleDiff(this.lastPsi, k.psi) / Math.max(dt, 1e-3);
    this.lastPsi = k.psi;
    this.roll += (clamp(-turn * 0.25, -0.7, 0.7) - this.roll) * Math.min(1, dt * 5);
    const wob = Math.sin(this.wobble) * (0.05 + (1 - k.T) * 0.12);

    // muka layangan menghadap jangkar, dimiringkan sedikit ke horizontal agar mudah terlihat dari kamera
    const hl = Math.hypot(b.nx, b.nz) || 1;
    const hel = Math.asin(clamp(b.ny, -1, 1)) * 0.5;
    const Z = new THREE.Vector3((-b.nx / hl) * Math.cos(hel), -Math.sin(hel) + 0.2, (-b.nz / hl) * Math.cos(hel)).normalize();
    const Y = new THREE.Vector3(h.x, h.y, h.z);
    Y.addScaledVector(Z, -Y.dot(Z)).normalize();
    const X = new THREE.Vector3().crossVectors(Y, Z);
    this.m4.makeBasis(X, Y, Z);
    this.root.position.set(k.px, k.py, k.pz);
    this.root.quaternion.setFromRotationMatrix(this.m4);
    this.model.rotation.set(0.15, 0, this.roll + wob);

    // benang: dari tangan → (melilit atap) → (tertekuk di titik benturan benang) → kekang layangan
    const T = k.T;
    const bx = k.px - b.nx * 0.8, by = k.py - b.ny * 0.8, bz = k.pz - b.nz * 0.8;
    const arena = this.game.arena;
    const piv = arena ? wrapPivots(arena, k.ax, k.ay, k.az, bx, by, bz, this.piv) : ((this.piv.length = 0), this.piv);
    const nodes = this.nodes;
    nodes.length = 0;
    nodes.push(k.ax, k.ay, k.az);
    const kink = this.kink && performance.now() - this.kink.t < 160 ? this.kink : null;
    if (kink) {
      // sisipkan titik tekuk sesuai urutan di sepanjang benang
      const dx = bx - k.ax, dy = by - k.ay, dz = bz - k.az, dl2 = dx * dx + dy * dy + dz * dz || 1;
      const sk = ((kink.x - k.ax) * dx + (kink.y - k.ay) * dy + (kink.z - k.az) * dz) / dl2;
      let inserted = sk <= 0.02 || sk >= 0.98;
      for (let i = 0; i < piv.length; i += 3) {
        const sp = ((piv[i] - k.ax) * dx + (piv[i + 1] - k.ay) * dy + (piv[i + 2] - k.az) * dz) / dl2;
        if (!inserted && sk < sp) { nodes.push(kink.x, kink.y, kink.z); inserted = true; }
        nodes.push(piv[i], piv[i + 1], piv[i + 2]);
      }
      if (!inserted) nodes.push(kink.x, kink.y, kink.z);
    } else {
      for (let i = 0; i < piv.length; i++) nodes.push(piv[i]);
    }
    nodes.push(bx, by, bz);
    buildStringPath(nodes, T, this.pts, RENDER_SEGMENTS);
    // getaran benang setelah benturan
    if (this.shake > 0.01) {
      this.shakeT += dt;
      const dx = bx - k.ax, dz = bz - k.az, hl2 = Math.hypot(dx, dz) || 1;
      const sxv = -dz / hl2, szv = dx / hl2;
      for (let i = 1; i < RENDER_SEGMENTS; i++) {
        const s = i / RENDER_SEGMENTS;
        const w = Math.sin(Math.PI * s) * Math.sin(this.shakeT * 48 + s * 9) * this.shake * 0.55;
        this.pts[i * 3] += sxv * w;
        this.pts[i * 3 + 1] += w * 0.6;
        this.pts[i * 3 + 2] += szv * w;
      }
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    this.string.setPoints(this.pts, RENDER_SEGMENTS + 1);

    const flags = k.flags ?? 0;
    const auraTarget = flags & 16 ? 0.35 : flags & 8 ? 0.2 : 0;
    this.aura.material.opacity += (auraTarget - this.aura.material.opacity) * Math.min(1, dt * 10);
    this.game.world.aimPlayer(this.id, k.px, k.pz, dt);
  }

  startFalling(e, wind) {
    this.falling = {
      t: 0, px: e.x, py: e.y, pz: e.z,
      vx: e.vx * 0.3 + Math.cos(wind.angle) * 4, vy: 3, vz: e.vz * 0.3 + Math.sin(wind.angle) * 4,
      spin: (Math.random() - 0.5) * 3,
      tail: new Float32Array(10 * 3),
    };
    if (this.label) this.label.style.display = 'none';
    this.string.mat.opacity = 0.8;
    this.string.mat.transparent = true;
    this.game.world.aimPlayer(this.id, e.x, e.z, 1);
  }

  updateFalling(dt, wind) {
    const f = this.falling;
    f.t += dt;
    f.vx += (Math.cos(wind.angle) * wind.speed * 0.6 - f.vx) * dt * 0.5;
    f.vz += (Math.sin(wind.angle) * wind.speed * 0.6 - f.vz) * dt * 0.5;
    f.vy += (-2.2 - f.vy) * dt * 0.8;
    f.px += f.vx * dt; f.py = Math.max(0.5, f.py + f.vy * dt); f.pz += f.vz * dt;
    // layangan putus jatuh menimpa atap/pohon: tertahan & tersangkut (gesekan besar)
    const arena = this.game.arena;
    if (arena) {
      const P = { x: f.px, y: f.py, z: f.pz };
      const hit = resolveSphere(arena, P, 1.0);
      if (hit) {
        f.px = P.x; f.py = P.y; f.pz = P.z;
        const vn = f.vx * hit.nx + f.vy * hit.ny + f.vz * hit.nz;
        if (vn < 0) { f.vx -= vn * hit.nx; f.vy -= vn * hit.ny; f.vz -= vn * hit.nz; }
        f.vx *= 0.85; f.vy *= 0.85; f.vz *= 0.85;
        f.spin *= 0.9;
      }
    }
    this.root.position.set(f.px, f.py, f.pz);
    this.root.rotation.x += f.spin * dt * 0.7;
    this.root.rotation.z += f.spin * dt;
    // benang menjuntai
    for (let i = 0; i < 10; i++) {
      const s = i / 9;
      f.tail[i * 3] = f.px - f.vx * s * 1.2 + Math.sin(f.t * 3 + i) * s * 0.8;
      f.tail[i * 3 + 1] = f.py - s * 12;
      f.tail[i * 3 + 2] = f.pz - f.vz * s * 1.2;
    }
    this.string.setPoints(f.tail, 10);
    return f.t < 16 && f.py > 0.6;
  }

  /** Dipanggil setelah kamera diperbarui agar label tidak tertinggal satu frame */
  placeLabel(camera) {
    if (!this.label || this.falling) return;
    const p = this.root.position;
    _proj.set(p.x, p.y + 3.4, p.z).project(camera);
    const visible = this.root.visible && _proj.z > 0 && _proj.z < 1 && Math.abs(_proj.x) < 1.1 && Math.abs(_proj.y) < 1.1;
    if (!visible) { this.label.style.display = 'none'; return; }
    this.label.style.display = 'block';
    const x = (_proj.x * 0.5 + 0.5) * innerWidth, y = (-_proj.y * 0.5 + 0.5) * innerHeight;
    this.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  dispose() {
    this.game.scene.remove(this.root, this.string.line);
    this.label?.remove();
    this.string.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
/** Cincin kilatan saat dua benang berbenturan */
class Rings {
  constructor(scene) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,240,210,1)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(221,82,45,0.9)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(32, 32, 20, 0, Math.PI * 2); g.stroke();
    const tex = new THREE.CanvasTexture(c);
    this.pool = [];
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      s.userData.t = 1;
      scene.add(s);
      this.pool.push(s);
    }
  }
  spawn(x, y, z, size = 1) {
    const s = this.pool.find((p) => !p.visible) || this.pool[0];
    s.position.set(x, y, z);
    s.userData.t = 0;
    s.userData.size = size;
    s.visible = true;
  }
  update(dt) {
    for (const s of this.pool) {
      if (!s.visible) continue;
      const u = (s.userData.t += dt / 0.4);
      if (u >= 1) { s.visible = false; continue; }
      const sc = (0.6 + u * 4.5) * s.userData.size;
      s.scale.set(sc, sc, 1);
      s.material.opacity = (1 - u) * 0.95;
    }
  }
}

class Sparks {
  constructor(scene, stops = ['rgba(255,236,190,1)', 'rgba(232,110,52,0.95)', 'rgba(221,82,45,0)'], size = 0.6, gravity = 12) {
    this.gravity = gravity;
    this.max = 700;
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    // percikan (blending normal agar terlihat di langit pastel)
    grad.addColorStop(0, stops[0]);
    grad.addColorStop(0.4, stops[1]);
    grad.addColorStop(1, stops[2]);
    x.fillStyle = grad;
    x.fillRect(0, 0, 32, 32);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(c), size, transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  emit(x, y, z, n = 10, speed = 8) {
    for (let k = 0; k < n; k++) {
      const i = this.next = (this.next + 1) % this.max;
      this.pos.set([x, y, z], i * 3);
      this.vel.set([(Math.random() - 0.5) * speed, (Math.random() - 0.2) * speed, (Math.random() - 0.5) * speed], i * 3);
      this.life[i] = 0.3 + Math.random() * 0.4;
    }
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= this.gravity * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------
export class Game {
  constructor(canvas, { audio, input, hud }) {
    this.canvas = canvas;
    this.audio = audio;
    this.input = input;
    this.hud = hud;
    const mobile = input.isTouch;
    this.quality = { shadows: !mobile, pixelRatio: Math.min(devicePixelRatio, mobile ? 1.5 : 2) };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 5000);
    this.camera.position.set(0, 40, 120);
    addEventListener('resize', () => this.resize());
    this.resize();

    this.mode = 'loading';
    this.views = new Map();
    this.ghosts = new Map();
    this.menuKites = [];
    this.arena = null;
    this.pairStates = new Map();
    this.lastBump = 0;
    this.camShake = 0;
    this.camMode = 'chase';
    this.wind = { angle: 0.6, speed: 8 };
    this.zoneR = ZONE.STAGES[0].r;
    this.clock = new THREE.Clock();
    this.sendAcc = 0;
    this.simAcc = 0;
    this.grind = 0;
    this.specIndex = 0;
    this.camPos = new THREE.Vector3(0, 40, 120);
    this.camLook = new THREE.Vector3(0, 20, 0);
    input.on('camera', () => { this.camMode = this.camMode === 'chase' ? 'ground' : 'chase'; });
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(onProgress) {
    const loader = new GLTFLoader();
    this.assets = {};
    let done = 0;
    await Promise.all(ASSET_NAMES.map((n) => loader.loadAsync(`/assets/${n}.glb`).then((g) => {
      this.assets[n] = g.scene;
      done++;
      onProgress?.(done / ASSET_NAMES.length, done, ASSET_NAMES.length);
    })));
    this.world = new World(this.scene, this.renderer, this.assets, this.quality);
    this.sparks = new Sparks(this.scene);
    this.dust = new Sparks(this.scene, ['rgba(236,228,206,0.95)', 'rgba(196,184,152,0.7)', 'rgba(170,160,130,0)'], 1.1, 3);
    this.rings = new Rings(this.scene);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ menu
  enterMenu(cls = this.menuClass || 'speed') {
    this.clearMatch();
    this.mode = 'menu';
    this.input.enabled = false;
    for (const l of document.querySelectorAll('.player-label')) l.remove();
    const count = 6;
    const clsIds = Object.keys(CLASSES);
    const roster = [];
    for (let i = 0; i < count; i++) {
      const b = basePosition(i, count);
      const c = clsIds[i % 3];
      roster.push({ id: 'menu' + i, name: '', cls: c, color: MENU_COLORS[c], ax: b.x, ay: HAND_HEIGHT, az: b.z });
    }
    this.world.setBases(roster);
    this.arena = createArena(count);
    this.world.setZone(150, false);
    // layangan latar (tanpa base 0 yang dipakai layangan hero)
    for (const r of roster.slice(1)) {
      const k = createKite(r.id, r.cls, roster.indexOf(r), count, this.wind);
      k.L = 25 + Math.random() * 20;
      const v = new KiteView(this, r, true);
      this.menuKites.push({ k, v, seed: Math.random() * 100 });
    }
    this.heroAnchor = roster[0];
    this.heroString = new StringLine(0x6f7960, 1.6, 0.85);
    this.scene.add(this.heroString.line);
    this.heroPts = new Float32Array((RENDER_SEGMENTS + 1) * 3);
    this.setMenuClass(cls);
    this.camera.fov = 47;
    this.camera.updateProjectionMatrix();
  }

  /** Layangan besar di beranda mengikuti kelas yang dipilih */
  setMenuClass(cls) {
    this.menuClass = cls;
    if (this.mode !== 'menu') return;
    if (this.hero) this.scene.remove(this.hero);
    this.hero = cloneTinted(this.assets[CLASSES[cls].model.replace('.glb', '')], 'Sail', MENU_COLORS[cls]);
    this.hero.scale.setScalar(15);
    this.scene.add(this.hero);
    const r = this.heroAnchor;
    this.world.aimPlayer(r.id, 0, 0, 1);
  }

  // ------------------------------------------------------------------ match
  startMatch(info, myId, socket) {
    this.clearMatch();
    this.mode = 'match';
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
    this.socket = socket;
    this.myId = myId;
    this.roster = new Map(info.roster.map((r) => [r.id, r]));
    this.world.setBases(info.roster);
    this.arena = createArena(info.count);
    this.pairStates.clear();
    this.world.setZone(ZONE.STAGES[0].r, true);
    this.matchState = info.state || 'launch';
    this.me = null;
    this.alive = new Set(info.roster.map((r) => r.id));
    this.kills = 0;
    for (const r of info.roster) {
      const isMe = r.id === myId;
      const v = new KiteView(this, r, isMe);
      this.views.set(r.id, v);
      if (isMe) {
        const k = createKite(r.id, r.cls, r.index, info.count, this.wind);
        k.ax = r.ax; k.ay = r.ay; k.az = r.az;
        this.me = { k, hp: r.maxHp, maxHp: r.maxHp, alive: info.state !== 'combat', outT: 0, overT: 0, info: r };
      }
    }
    this.spectating = !this.me || !this.me.alive;
    this.input.enabled = !!this.me;
    this.hud.matchStarted(this);
  }

  clearMatch() {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    for (const g of this.ghosts.values()) { this.scene.remove(g.line.line); g.line.dispose(); }
    this.ghosts.clear();
    for (const m of this.menuKites) m.v.dispose();
    this.menuKites = [];
    if (this.hero) { this.scene.remove(this.hero); this.hero = null; }
    if (this.heroString) { this.scene.remove(this.heroString.line); this.heroString.dispose(); this.heroString = null; }
    this.me = null;
  }

  onSnapshot(s) {
    if (this.mode !== 'match') return;
    const now = performance.now();
    this.wind = { angle: s.w[0], speed: s.w[1] };
    this.zoneR = s.zr;
    const prevState = this.matchState;
    this.matchState = s.s;
    this.matchTime = s.tm;
    this.zoneNext = s.zn;
    if (prevState === 'launch' && s.s === 'combat') this.hud.bigMessage('Silang. Sentak. Putus.', 1800);
    this.alive.clear();
    this.aliveCount = 0;
    for (const p of s.p) {
      const [id, px, py, pz, psi, L, T, hp, flags, speed, reel, outT, overT, skillCd, snatchCd, stamina, kills] = p;
      if (flags & 1) { this.alive.add(id); this.aliveCount++; }
      const v = this.views.get(id);
      if (!v) continue;
      v.hp = hp; v.kills = kills;
      if (id === this.myId && this.me) {
        this.me.hp = hp;
        this.me.outT = outT;
        this.me.overT = overT;
        this.kills = kills;
        const k = this.me.k;
        if (skillCd > k.skillCd + 0.25) k.skillCd = skillCd;
        if (snatchCd > k.snatchCd + 0.25) k.snatchCd = snatchCd;
        this.me.serverFlags = flags;
      } else {
        v.pushSnapshot(now, { px, py, pz, psi, L, T, flags });
      }
    }
    // benang hantu
    const seen = new Set();
    for (const [gid, life, pts] of s.g) {
      seen.add(gid);
      let g = this.ghosts.get(gid);
      if (!g) {
        g = { line: new StringLine(0xdfe7ff, 1.8, 0.7, 16), pts: new Float32Array(pts) };
        this.scene.add(g.line.line);
        this.ghosts.set(gid, g);
      }
      if (g.pts.length !== pts.length) g.pts = new Float32Array(pts);
      g.target = pts;
      g.life = life;
    }
    for (const [gid, g] of this.ghosts) {
      if (!seen.has(gid)) { this.scene.remove(g.line.line); g.line.dispose(); this.ghosts.delete(gid); }
    }
    // kontak / gesekan
    let myGrind = 0;
    this.myContact = null;
    for (const c of s.c) {
      const [x, y, z, intensity, a, b, deg] = c;
      this.sparks.emit(x, y, z, Math.min(14, 3 + Math.floor(intensity / 4)), 6 + intensity * 0.2);
      // benang lawan tampak tertekuk di titik kontak (bukan menembus)
      const kink = { x, y, z, t: now };
      for (const id of [a, b]) {
        const v = this.views.get(id);
        if (v && !(v.isMe && v.kink && now - v.kink.t < 100)) v.kink = kink;
      }
      if (a === this.myId || b === this.myId) {
        myGrind = Math.max(myGrind, 0.1 + intensity * 0.01);
        this.myContact = { deg, intensity, other: a === this.myId ? b : a };
      } else {
        const d = this.camera.position.distanceTo(new THREE.Vector3(x, y, z));
        myGrind = Math.max(myGrind, Math.max(0, 0.12 - d * 0.002));
      }
    }
    this.grind = myGrind;
    // benturan benang antar pemain lain (benturan milik sendiri sudah dideteksi lokal)
    for (const [x, y, z, hit, a, b] of s.i || []) {
      if (a === this.myId || b === this.myId) continue;
      this.impactFx(x, y, z, [this.views.get(a), this.views.get(b)], Math.min(1.5, 0.4 + hit / 25));
    }
  }

  onElim(e) {
    if (this.mode !== 'match') return;
    this.alive.delete(e.id);
    const v = this.views.get(e.id);
    const near = e.id === this.myId || e.by === this.myId;
    this.audio.cut(near);
    this.sparks.emit(e.x, e.y, e.z, 40, 16);
    if (v) {
      if (e.id === this.myId && this.me) {
        const k = this.me.k;
        e = { ...e, x: k.px, y: k.py, z: k.pz, vx: k.vx, vy: k.vy, vz: k.vz };
        this.me.alive = false;
        this.spectating = true;
        this.input.enabled = false;
        this.specIndex = 0;
      }
      v.startFalling(e, this.wind);
    }
  }

  onFx(e) {
    const v = this.views.get(e.id);
    if (!v) return;
    const pos = v.root.position;
    if (e.id !== this.myId) {
      const d = this.camera.position.distanceTo(pos);
      if (d < 60) e.type === 'snatch' ? this.audio.snatch() : this.audio.skill();
    }
    this.sparks.emit(pos.x, pos.y, pos.z, e.type === 'skill' ? 30 : 8, e.type === 'skill' ? 10 : 5);
  }

  onActionAck(a) {
    if (!this.me) return;
    if (!a.ok) {
      this.me.k.snatchCd = a.snatchCd;
      this.me.k.skillCd = a.skillCd;
    }
  }

  /**
   * Benang milik pemain vs benang lawan: client ini hanya menggeser layangannya sendiri
   * (bagian lawan ditangani pemiliknya / server untuk bot) → benang tidak saling tembus.
   */
  resolveMyStringContacts(now) {
    const k = this.me.k;
    const myView = this.views.get(this.myId);
    const mine = stringPoints(k.ax, k.ay, k.az, k.px, k.py, k.pz, k.T, myView.physPts, STRING_SEGMENTS, this.arena);
    for (const v of this.views.values()) {
      if (v.isMe || v.falling || !v.current || !this.alive.has(v.id)) continue;
      const c = v.current;
      // saring cepat: dua benang mustahil bersentuhan bila terpisah jauh
      const reach = Math.hypot(k.px - k.ax, k.py - k.ay, k.pz - k.az) + Math.hypot(c.px - c.ax, c.py - c.ay, c.pz - c.az);
      if (Math.hypot((k.ax + k.px) / 2 - (c.ax + c.px) / 2, (k.az + k.pz) / 2 - (c.az + c.pz) / 2) > reach / 2 + 6) {
        this.pairStates.delete(this.myId < v.id ? `${this.myId}|${v.id}` : `${v.id}|${this.myId}`);
        continue;
      }
      const theirs = stringPoints(c.ax, c.ay, c.az, c.px, c.py, c.pz, c.T, v.physPts, STRING_SEGMENTS, this.arena);
      const other = { cls: this.roster.get(v.id).cls, ax: c.ax, ay: c.ay, az: c.az, px: c.px, py: c.py, pz: c.pz };
      const meFirst = this.myId < v.id;
      const key = meFirst ? `${this.myId}|${v.id}` : `${v.id}|${this.myId}`;
      const res = meFirst
        ? resolveStringPair(this.pairStates, key, k, mine, other, theirs, true, false, STRING_SEGMENTS, 0.25)
        : resolveStringPair(this.pairStates, key, other, theirs, k, mine, false, true, STRING_SEGMENTS, 0.25);
      if (!res || !res.touch) continue;
      const kink = { x: res.x, y: res.y, z: res.z, t: now };
      myView.kink = kink;
      v.kink = kink;
      if (res.impact) this.impactFx(res.x, res.y, res.z, [myView, v], 1);
    }
  }

  /** Efek benturan benang: kilatan cincin, percikan, getaran benang, bunyi petikan lembut, getar kamera & HP */
  impactFx(x, y, z, views, strength = 1) {
    this.rings.spawn(x, y, z, 0.6 + strength * 0.5);
    this.sparks.emit(x, y, z, 18 + Math.round(strength * 14), 9 + strength * 6);
    for (const v of views) if (v) { v.shake = Math.min(1.2, (v.shake || 0) + 0.6 + strength * 0.4); v.shakeT = 0; }
    const d = this.camera.position.distanceTo(new THREE.Vector3(x, y, z));
    if (now_throttle(this, 120)) this.audio.twang(Math.max(0, 1 - d / 90) * Math.min(1, 0.5 + strength * 0.5));
    if (views.some((v) => v?.isMe)) {
      this.camShake = Math.max(this.camShake, 0.35 * Math.min(1, strength));
      this.haptic([35, 25, 20]);
    }
  }

  /** Getar perangkat (HP/tablet). Dibatasi agar tidak menumpuk. */
  haptic(pattern) {
    if (!this.input.isTouch || typeof navigator.vibrate !== 'function') return;
    const now = performance.now();
    if (now - (this.lastHaptic || 0) < 90) return;
    this.lastHaptic = now;
    try { navigator.vibrate(pattern); } catch { /* abaikan */ }
  }

  /** Layangan sendiri menabrak bangunan/pohon */
  onKiteBump(k, speed, n, now) {
    this.lastBump = now;
    const nx = n?.[0] ?? 0, ny = n?.[1] ?? 1, nz = n?.[2] ?? 0;
    const x = k.px - nx * 1.2, y = k.py - ny * 1.2, z = k.pz - nz * 1.2;
    this.dust.emit(x, y, z, Math.min(30, 8 + Math.round(speed * 1.5)), 3 + speed * 0.3);
    this.camShake = Math.min(1, speed / 14);
    const v = this.views.get(this.myId);
    if (v) { v.shake = Math.min(1, speed / 12); v.shakeT = 0; }
    this.audio.thud(Math.min(1, speed / 15));
  }

  spectateTarget() {
    const ids = [...this.alive].filter((id) => id !== this.myId);
    if (!ids.length) return null;
    this.specIndex = ((this.specIndex % ids.length) + ids.length) % ids.length;
    return ids[this.specIndex];
  }
  cycleSpectate(d) { this.specIndex += d; }

  // ------------------------------------------------------------------ frame
  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.input.update(dt);
    const now = performance.now();

    if (this.mode === 'menu') this.updateMenu(dt);
    else if (this.mode === 'match') this.updateMatch(dt, now);

    this.world.update(dt, this.camera, this.wind);
    this.sparks.update(dt);
    this.dust.update(dt);
    this.rings.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  updateMenu(dt) {
    const t = performance.now() / 1000;
    this.wind = windAt(t * 0.3);
    this.audio.update({ active: false, wind: this.wind.speed * 0.8 });
    for (const m of this.menuKites) {
      const inp = { x: Math.sin(t * 0.5 + m.seed), y: Math.sin(t * 0.37 + m.seed * 2) * 0.8 + 0.3, reel: Math.sin(t * 0.2 + m.seed) * 0.2, sprint: false };
      stepKite(m.k, inp, { wind: this.wind, launch: false, world: this.arena }, dt);
      if (m.k.L < 22) m.k.L = 22;
      m.v.render(m.k, dt);
    }
    // kamera beranda: sudut isometrik lembut ke arah desa, layangan hero di tengah
    const narrow = innerWidth < 900;
    this.camera.position.set(115 + Math.sin(t * 0.07) * 6, 93, 135 + Math.cos(t * 0.05) * 4);
    this.camera.lookAt(narrow ? 10 : 0, narrow ? 40 : 24, 0);
    if (this.hero) {
      const hx = narrow ? 12 : 0, hy = 53 + Math.sin(t * 0.75) * 1.2;
      this.hero.position.set(hx, hy, 0);
      this.hero.rotation.set(-0.12 + Math.sin(t * 0.8) * 0.035, 0.72 + Math.sin(t * 0.2) * 0.09, 0.15 + Math.sin(t * 0.6) * 0.11);
      const r = this.heroAnchor;
      const n = RENDER_SEGMENTS;
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        this.heroPts[i * 3] = r.ax + (hx - r.ax) * s;
        this.heroPts[i * 3 + 1] = r.ay + (hy - 8 - r.ay) * s - Math.sin(s * Math.PI) * 6;
        this.heroPts[i * 3 + 2] = r.az + (0 - r.az) * s;
      }
      this.heroString.setPoints(this.heroPts, n + 1);
      this.world.aimPlayer(r.id, hx, 0, dt);
    }
  }

  updateMatch(dt, now) {
    const launch = this.matchState === 'launch';
    const combat = this.matchState === 'combat';

    // --- layangan sendiri (prediksi lokal)
    if (this.me && this.me.alive && (launch || combat)) {
      const k = this.me.k;
      const inp = this.input.state();
      const act = this.input.consumeActions();
      if (combat) {
        if (act.snatch && trySnatch(k)) { this.socket.emit('act', 'snatch'); this.audio.snatch(); }
        if (act.skill && trySkill(k)) { this.socket.emit('act', 'skill'); this.audio.skill(); }
      }
      const outOfZone = combat && Math.hypot(k.px - ZONE.CENTER[0], k.pz - ZONE.CENTER[1]) > this.zoneR;
      this.me.outOfZone = outOfZone;
      this.simAcc += dt;
      const STEP = 1 / 60;
      this.resolveMyStringContacts(now);
      let bump = 0, bumpN = null;
      while (this.simAcc >= STEP) {
        stepKite(k, inp, { wind: this.wind, zoneR: this.zoneR, launch, outOfZone, world: this.arena }, STEP);
        if (k.bump > bump) { bump = k.bump; bumpN = k.bumpN; }
        this.simAcc -= STEP;
      }
      if (bump > 3.5 && now - this.lastBump > 250) this.onKiteBump(k, bump, bumpN, now);
      this.me.input = inp;
      this.sendAcc += dt;
      if (this.sendAcc >= 1 / CLIENT_SEND_RATE) {
        this.sendAcc = 0;
        const r = (v) => Math.round(v * 100) / 100;
        this.socket.emit('st', [r(k.px), r(k.py), r(k.pz), r(k.psi), r(k.speed), r(k.L), r(k.T), r(k.reel), k.hold ? 1 : 0, k.sprint ? 1 : 0, Math.round(k.stamina)]);
      }
      const v = this.views.get(this.myId);
      v.render({ ...k, flags: (k.snatchT > 0 ? 8 : 0) | (k.skillT > 0 ? 16 : 0) }, dt);
    }

    // --- layangan lain (interpolasi)
    for (const v of this.views.values()) {
      if (v.falling) {
        if (!v.updateFalling(dt, this.wind)) { v.root.visible = false; v.string.line.visible = false; }
        continue;
      }
      if (v.isMe) continue;
      const s = v.interpolated(now);
      if (!s) continue;
      const r = this.roster.get(v.id);
      v.current = { ax: r.ax, ay: r.ay, az: r.az, ...s };
      v.render(v.current, dt);
    }

    // --- benang hantu
    for (const g of this.ghosts.values()) {
      if (g.target) {
        const f = Math.min(1, dt * 8);
        for (let i = 0; i < g.pts.length; i++) g.pts[i] += (g.target[i] - g.pts[i]) * f;
      }
      g.line.mat.opacity = Math.min(0.75, (g.life ?? 1) / 3);
      g.line.setPoints(g.pts, g.pts.length / 3);
    }

    this.updateCamera(dt);
    this.camera.updateMatrixWorld();
    for (const v of this.views.values()) v.placeLabel(this.camera);

    const k = this.me?.k;
    this.audio.update({
      speed: k && this.me.alive ? k.speed : 0,
      tension: k && this.me.alive ? k.T : 0,
      grind: this.grind,
      active: !!(k && this.me.alive),
      wind: this.wind.speed,
    });
    // gesekan benang milik sendiri: bukan suara, melainkan getaran halus berkala (benang + HP)
    if (this.myContact && this.grind > 0.05 && this.me?.alive) {
      const v = this.views.get(this.myId);
      if (v) v.shake = Math.max(v.shake, 0.18 + Math.min(0.25, this.grind));
      if (now - (this.lastGrindPulse || 0) > 260) {
        this.lastGrindPulse = now;
        this.haptic(Math.round(10 + Math.min(20, this.grind * 40)));
      }
    }
    this.grind *= Math.max(0, 1 - dt * 4);

    // kabut jadi gelap saat di luar zona
    const out = this.me?.alive && this.me.outOfZone;
    const fogTarget = out ? new THREE.Color(0xa89a82) : this.world.fogColor;
    this.scene.fog.color.lerp(fogTarget, Math.min(1, dt * 2));
    this.scene.fog.far += ((out ? 400 : 1500) - this.scene.fog.far) * Math.min(1, dt * 2);
    this.world.setZone(this.zoneR, true);

    this.hud.update(this, dt);
  }

  updateCamera(dt) {
    let k = null;
    let viewId = this.myId;
    if (this.me && this.me.alive) k = this.me.k;
    else {
      viewId = this.spectateTarget();
      const v = viewId && this.views.get(viewId);
      k = v?.current || null;
      this.spectatingId = viewId;
    }
    if (!k) {
      if (this.me) {
        const v = this.views.get(this.myId);
        const p = v.root.position;
        this.camPos.lerp(new THREE.Vector3(p.x + 25, p.y + 12, p.z + 25), Math.min(1, dt * 1.5));
        this.camLook.lerp(p, Math.min(1, dt * 3));
        this.camera.position.copy(this.camPos);
        this.camera.lookAt(this.camLook);
      }
      return;
    }
    const b = tangentBasis(k);
    const desired = new THREE.Vector3();
    const look = new THREE.Vector3(k.px, k.py, k.pz);
    if (this.camMode === 'ground' && viewId === this.myId) {
      desired.set(k.ax - b.nx * 4, k.ay + 1.2, k.az - b.nz * 4);
      look.set(k.px, k.py, k.pz);
    } else {
      // di belakang layangan secara horizontal (sisi jangkar) & sedikit di atas: horizon + benang lawan terlihat
      // kamera condong setengah sudut elevasi layangan: bidang gerak (kanan/atas) menghadap layar,
      // jadi naik/turun terlihat jelas tanpa kamera mendongak penuh ke langit
      const hl = Math.hypot(b.nx, b.nz) || 1;
      const hx = b.nx / hl, hz = b.nz / hl;
      const el = Math.asin(clamp(b.ny, -1, 1)) * 0.5;
      const ce = Math.cos(el), se = Math.sin(el);
      const D = clamp(k.L * 0.5, 14, 24);
      desired.set(k.px - hx * ce * D, k.py - se * D + 3.5, k.pz - hz * ce * D);
      look.x += hx * ce * 6; look.y += se * 6; look.z += hz * ce * 6;
    }
    desired.y = Math.max(2.5, desired.y);
    const f = Math.min(1, dt * 5);
    this.camPos.lerp(desired, f);
    // jaga jarak minimum dari layangan (mis. saat layangan terdorong benturan)
    const kp = new THREE.Vector3(k.px, k.py, k.pz);
    const toCam = this.camPos.clone().sub(kp);
    const minD = 9;
    if (toCam.length() < minD) {
      const dir = desired.clone().sub(kp);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      this.camPos.copy(kp).addScaledVector(toCam.lengthSq() > 1e-6 ? toCam.normalize() : dir.normalize(), minD);
    }
    // kamera juga tidak menembus bangunan
    if (this.arena) {
      const P = { x: this.camPos.x, y: this.camPos.y, z: this.camPos.z };
      if (resolveSphere(this.arena, P, 1.2)) this.camPos.set(P.x, P.y, P.z);
    }
    this.camLook.lerp(look, Math.min(1, dt * 8));
    this.camera.position.copy(this.camPos);
    if (this.camShake > 0.01) {
      const a = this.camShake * 0.35;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camShake = Math.max(0, this.camShake - dt * 3);
    }
    this.camera.lookAt(this.camLook);
    const sp = k.speed ?? 0;
    const fov = 62 + clamp(sp - 15, 0, 30) * 0.35;
    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
      this.camera.updateProjectionMatrix();
    }
  }
}

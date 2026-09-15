// Logika satu room / pertandingan (server-authoritative untuk tempur)
import {
  CLASSES, CUT, TENSION, ZONE, GHOST_LIFE, PLAYER_COLORS,
  MIN_PLAYERS, MAX_PLAYERS, LOBBY_COUNTDOWN, LAUNCH_TIME, RESULT_TIME,
  LINE_MIN, LINE_MAX, SNATCH, TICK_RATE,
} from '../shared/constants.js';
import {
  createKite, stepKite, trySnatch, trySkill, windAt, zoneRadiusAt, zoneNextEvent,
  stringPoints, segSegDist, angleFactor, STRING_SEGMENTS, clamp, resolveStringPair,
} from '../shared/physics.js';
import { createArena } from '../shared/arena.js';
import { botIdentity, createBrain, botThink } from './bot.js';

const MAX_MATCH_TIME = 330;
const r2 = (v) => Math.round(v * 100) / 100;
let nextBotId = 1;
let nextGhostId = 1;

export class Room {
  constructor(io, id, { isPrivate = false, code = null } = {}) {
    this.io = io;
    this.id = id;
    this.code = code;
    this.isPrivate = isPrivate;
    this.players = new Map();
    this.hostId = null;
    this.state = 'waiting';
    this.timer = LOBBY_COUNTDOWN;
    this.countdownActive = false;
    this.matchT = 0;
    this.windSeed = Math.random() * 1000;
    this.wind = windAt(this.windSeed);
    this.zoneR = zoneRadiusAt(0);
    this.ghosts = [];
    this.contacts = [];
    this.contactSet = new Set();
    this.tickCount = 0;
    this.strings = new Map();
    this.arena = createArena(MIN_PLAYERS);
    this.pairStates = new Map();   // kendala kontak benang (sisi yang diingat)
    this.touchPairs = new Set();   // pasangan yang sedang bersentuhan (untuk efek benturan)
    this.impacts = [];
    this.placeCounter = 0;
    this.results = null;
  }

  get channel() { return 'room:' + this.id; }
  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  isEmpty() { return this.humans().length === 0; }
  canJoinQuick() { return !this.isPrivate && this.state === 'waiting' && this.players.size < MAX_PLAYERS; }

  // ------------------------------------------------------------ roster
  addHuman(socket, name, cls) {
    const p = {
      id: socket.id, socket, name, cls: CLASSES[cls] ? cls : 'speed', isBot: false,
      color: this.pickColor(), kite: null, hp: 0, maxHp: 0, alive: false, kills: 0,
      place: 0, spectator: this.state !== 'waiting', lastReport: 0,
    };
    this.players.set(p.id, p);
    socket.join(this.channel);
    if (!this.hostId) this.hostId = p.id;
    if (!this.isPrivate && !this.countdownActive) { this.countdownActive = true; this.timer = LOBBY_COUNTDOWN; }
    if (!this.isPrivate && this.players.size >= MAX_PLAYERS && this.state === 'waiting') this.timer = Math.min(this.timer, 3);
    this.broadcastRoom();
    if (this.state !== 'waiting') socket.emit('matchStart', this.matchInfo());
    return p;
  }

  addBot() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((p) => p.name));
    const { name, cls } = botIdentity(used);
    const p = {
      id: 'bot' + nextBotId++, name, cls, isBot: true, color: this.pickColor(), kite: null,
      hp: 0, maxHp: 0, alive: false, kills: 0, place: 0, brain: createBrain(), spectator: false,
    };
    this.players.set(p.id, p);
    this.broadcastRoom();
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.socket?.leave(this.channel);
    if (this.state === 'launch' || this.state === 'combat') {
      if (p.alive) this.eliminate(p, 'leave', null, p.kite);
    }
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.humans()[0]?.id ?? null;
    if (this.isEmpty()) {
      for (const b of [...this.players.values()]) this.players.delete(b.id);
    }
    this.broadcastRoom();
  }

  pickColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  }

  setClass(id, cls) {
    const p = this.players.get(id);
    if (p && CLASSES[cls] && this.state === 'waiting') { p.cls = cls; this.broadcastRoom(); }
  }

  roomInfo() {
    return {
      id: this.id, code: this.code, isPrivate: this.isPrivate, hostId: this.hostId, state: this.state,
      countdown: this.state === 'waiting' && this.countdownActive ? Math.ceil(this.timer) : null,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, color: p.color, isBot: p.isBot })),
      min: MIN_PLAYERS, max: MAX_PLAYERS,
    };
  }

  broadcastRoom() { this.io.to(this.channel).emit('roomUpdate', this.roomInfo()); }

  // ------------------------------------------------------------ match flow
  startMatch() {
    if (this.state !== 'waiting') return;
    while (this.players.size < MIN_PLAYERS) this.addBot();
    const list = [...this.players.values()];
    const count = list.length;
    this.matchT = 0;
    this.windSeed = Math.random() * 1000;
    this.wind = windAt(this.windSeed);
    this.zoneR = zoneRadiusAt(0);
    this.ghosts = [];
    this.arena = createArena(count);
    this.pairStates.clear();
    this.touchPairs.clear();
    this.placeCounter = count;
    list.forEach((p, i) => {
      const cls = CLASSES[p.cls];
      p.kite = createKite(p.id, p.cls, i, count, this.wind);
      p.index = i;
      p.hp = p.maxHp = cls.hp;
      p.alive = true;
      p.spectator = false;
      p.kills = 0;
      p.place = 0;
      p.cutBy = null;
      p.input = { x: 0, y: 1, reel: 0, hold: false, sprint: false };
    });
    this.state = 'launch';
    this.timer = LAUNCH_TIME;
    this.io.to(this.channel).emit('matchStart', this.matchInfo());
    this.broadcastRoom();
  }

  matchInfo() {
    return {
      roster: [...this.players.values()].filter((p) => p.kite).map((p) => ({
        id: p.id, name: p.name, cls: p.cls, color: p.color, isBot: p.isBot, index: p.index,
        ax: p.kite.ax, ay: p.kite.ay, az: p.kite.az, maxHp: p.maxHp,
      })),
      count: [...this.players.values()].filter((p) => p.kite).length,
      state: this.state,
    };
  }

  endMatch(winner) {
    if (winner && winner.alive) winner.place = 1;
    const ranking = [...this.players.values()].filter((p) => p.kite)
      .sort((a, b) => (a.place || 99) - (b.place || 99))
      .map((p) => ({ id: p.id, name: p.name, cls: p.cls, color: p.color, place: p.place || 1, kills: p.kills, isBot: p.isBot }));
    this.state = 'results';
    this.timer = RESULT_TIME;
    this.results = ranking;
    this.io.to(this.channel).emit('results', { ranking, winnerId: winner?.id ?? null });
  }

  resetToLobby() {
    for (const p of [...this.players.values()]) {
      if (p.isBot) this.players.delete(p.id);
      else { p.kite = null; p.alive = false; p.spectator = false; }
    }
    this.state = 'waiting';
    this.countdownActive = !this.isPrivate && this.humans().length > 0;
    this.timer = LOBBY_COUNTDOWN;
    this.ghosts = [];
    this.io.to(this.channel).emit('backToLobby');
    this.broadcastRoom();
  }

  eliminate(p, reason, by, contactPoint) {
    if (!p.alive) return;
    p.alive = false;
    p.place = this.placeCounter--;
    p.hp = 0;
    const k = p.kite;
    if (by) { by.kills++; p.cutBy = by.id; }
    // benang hantu: dari titik potong menuju layangan
    if (reason === 'cut' || reason === 'ghost' || reason === 'snap' || reason === 'zone') {
      const pts = this.strings.get(p.id) || stringPoints(k.ax, k.ay, k.az, k.px, k.py, k.pz, k.T, new Float32Array((STRING_SEGMENTS + 1) * 3), STRING_SEGMENTS, this.arena);
      const startSeg = contactPoint?.seg ?? (reason === 'snap' ? 0 : Math.floor(STRING_SEGMENTS * 0.5));
      const arr = [];
      if (contactPoint?.x !== undefined) arr.push(contactPoint.x, contactPoint.y, contactPoint.z);
      for (let i = startSeg + 1; i <= STRING_SEGMENTS; i++) arr.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      if (arr.length >= 6) {
        this.ghosts.push({ id: nextGhostId++, pts: new Float32Array(arr), life: GHOST_LIFE, owner: p.id, vx: 0, vz: 0 });
      }
    }
    this.io.to(this.channel).emit('elim', {
      id: p.id, by: by?.id ?? null, reason, place: p.place,
      x: k.px, y: k.py, z: k.pz, vx: k.vx, vy: k.vy, vz: k.vz, psi: k.psi,
    });
  }

  // ------------------------------------------------------------ input dari client
  onClientState(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive || !p.kite || !Array.isArray(d)) return;
    const k = p.kite;
    const [px, py, pz, psi, speed, L, T, reel, hold, sprint, stamina] = d.map(Number);
    if (![px, py, pz, psi, speed, L, T].every(Number.isFinite)) return;
    const now = Date.now();
    const elapsed = clamp((now - (p.lastReport || now - 50)) / 1000, 0.02, 0.5);
    p.lastReport = now;
    // validasi jarak tempuh
    const maxMove = 95 * elapsed + 2;
    let nx = px, ny = py, nz = pz;
    const dx = px - k.px, dy = py - k.py, dz = pz - k.pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxMove && this.state === 'combat') {
      const s = maxMove / dist;
      nx = k.px + dx * s; ny = k.py + dy * s; nz = k.pz + dz * s;
    }
    k.L = clamp(L, 4, LINE_MAX);
    // tali tidak bisa lebih panjang dari L (boleh lebih pendek: melilit bangunan / menekan benang lain)
    const rx = nx - k.ax, ry = ny - k.ay, rz = nz - k.az;
    const rl = Math.hypot(rx, ry, rz) || 1;
    if (rl > k.L + 0.5) { const s = k.L / rl; nx = k.ax + rx * s; ny = k.ay + ry * s; nz = k.az + rz * s; }
    k.vx = (nx - k.px) / elapsed; k.vy = (ny - k.py) / elapsed; k.vz = (nz - k.pz) / elapsed;
    k.px = nx; k.py = ny; k.pz = nz;
    k.psi = psi;
    k.speed = clamp(speed, 0, 80);
    k.T = clamp(T, 0, 1);
    k.reel = clamp(Number.isFinite(reel) ? reel : 0, -30, 20);
    k.hold = !!hold;
    k.sprint = !!sprint;
    if (Number.isFinite(stamina)) k.stamina = stamina;
  }

  onAction(id, type) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'combat') return;
    const ok = type === 'snatch' ? trySnatch(p.kite) : type === 'skill' ? trySkill(p.kite) : false;
    if (ok) this.io.to(this.channel).emit('fx', { id, type });
    p.socket?.emit('actionAck', { type, ok, snatchCd: p.kite.snatchCd, skillCd: p.kite.skillCd });
  }

  // ------------------------------------------------------------ tick
  tick(dt) {
    this.tickCount++;
    if (this.state === 'waiting') {
      if (this.countdownActive && this.humans().length > 0) {
        this.timer -= dt;
        if (Math.floor(this.timer + dt) !== Math.floor(this.timer)) this.broadcastRoom();
        if (this.timer <= 0) this.startMatch();
      }
      return;
    }
    if (this.state === 'results') {
      this.timer -= dt;
      if (this.timer <= 0) this.resetToLobby();
      return;
    }

    const launch = this.state === 'launch';
    if (launch) {
      this.timer -= dt;
      if (this.timer <= 0) { this.state = 'combat'; this.matchT = 0; this.io.to(this.channel).emit('combatStart'); }
    } else {
      this.matchT += dt;
    }
    this.wind = windAt(this.windSeed + this.matchT);
    this.zoneR = zoneRadiusAt(this.matchT);

    const alive = [...this.players.values()].filter((p) => p.alive && p.kite);

    // string geometry
    for (const p of alive) {
      const k = p.kite;
      let buf = this.strings.get(p.id);
      if (!buf) { buf = new Float32Array((STRING_SEGMENTS + 1) * 3); this.strings.set(p.id, buf); }
      stringPoints(k.ax, k.ay, k.az, k.px, k.py, k.pz, k.T, buf, STRING_SEGMENTS, this.arena);
    }
    this.resolveStringContacts(alive);

    // bots + timers
    const ctx = { players: alive, zoneR: this.zoneR, strings: this.strings, contacts: this.contactSet };
    for (const p of alive) {
      const k = p.kite;
      const outOfZone = !launch && Math.hypot(k.px - ZONE.CENTER[0], k.pz - ZONE.CENTER[1]) > this.zoneR;
      if (p.isBot) {
        const { input, actions } = botThink(p, ctx, dt);
        if (!launch) {
          if (actions.snatch && trySnatch(k)) this.io.to(this.channel).emit('fx', { id: p.id, type: 'snatch' });
          if (actions.skill && trySkill(k)) this.io.to(this.channel).emit('fx', { id: p.id, type: 'skill' });
        }
        stepKite(k, input, { wind: this.wind, zoneR: this.zoneR, launch, outOfZone, world: this.arena }, dt);
      } else {
        // manusia: timer efek dijalankan server, posisi dari client
        k.snatchCd = Math.max(0, k.snatchCd - dt);
        k.snatchT = Math.max(0, k.snatchT - dt);
        k.skillCd = Math.max(0, k.skillCd - dt);
        k.skillT = Math.max(0, k.skillT - dt);
        k.liftT = Math.max(0, k.liftT - dt);
        if (!launch) {
          if (k.T >= TENSION.OVERLOAD) k.overT += dt * CLASSES[k.cls].heat;
          else k.overT = Math.max(0, k.overT - dt * 1.5);
        }
        k.saw = CUT.BASE_SAW + Math.max(0, -k.reel) * 1.2 + k.speed * 0.35 + (k.snatchT > 0 ? CUT.SNATCH_SAW : 0);
      }
      if (launch) continue;
      // zona
      if (outOfZone) {
        k.outT += dt;
        if (k.outT >= ZONE.OUT_LIMIT) this.eliminate(p, 'zone', null, null);
      } else k.outT = Math.max(0, k.outT - dt * 0.5);
      // snap
      if (p.alive && k.overT >= TENSION.SNAP_TIME) this.eliminate(p, 'snap', null, null);
    }

    this.contacts = [];
    this.contactSet = new Set();
    if (!launch) {
      this.resolveCuts(alive.filter((p) => p.alive), dt);
      this.updateGhosts(alive.filter((p) => p.alive), dt);

      const still = [...this.players.values()].filter((p) => p.alive);
      if (still.length <= 1) this.endMatch(still[0]);
      else if (this.matchT > MAX_MATCH_TIME) {
        still.sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp);
        for (let i = still.length - 1; i >= 1; i--) this.eliminate(still[i], 'time', null, null);
        this.endMatch(still[0]);
      }
    }

    if (this.state !== 'results' && this.tickCount % Math.round(TICK_RATE / 15) === 0) this.sendSnapshot();
  }

  /** Benang tidak saling tembus: server menangani layangan bot; layangan manusia ditangani client-nya */
  resolveStringContacts(alive) {
    const N = STRING_SEGMENTS;
    const boxes = alive.map((p) => {
      const s = this.strings.get(p.id);
      let a = Infinity, b = Infinity, c = Infinity, d = -Infinity, e = -Infinity, f = -Infinity;
      for (let i = 0; i <= N; i++) {
        const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
        if (x < a) a = x; if (x > d) d = x; if (y < b) b = y; if (y > e) e = y; if (z < c) c = z; if (z > f) f = z;
      }
      return [a, b, c, d, e, f];
    });
    const seen = new Set();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const A = alive[i], B = alive[j];
        if (!A.isBot && !B.isBot) continue;
        const ba = boxes[i], bb = boxes[j], m = 4;
        const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
        if (ba[0] > bb[3] + m || bb[0] > ba[3] + m || ba[1] > bb[4] + m || bb[1] > ba[4] + m || ba[2] > bb[5] + m || bb[2] > ba[5] + m) continue;
        seen.add(key);
        const [P, Q] = A.id < B.id ? [A, B] : [B, A];
        resolveStringPair(this.pairStates, key, P.kite, this.strings.get(P.id), Q.kite, this.strings.get(Q.id), P.isBot, Q.isBot, STRING_SEGMENTS, 0.6);
      }
    }
    for (const key of this.pairStates.keys()) if (!seen.has(key)) this.pairStates.delete(key);
  }

  resolveCuts(alive, dt) {
    const N = STRING_SEGMENTS;
    const HD2 = CUT.HIT_DIST * CUT.HIT_DIST;
    const dmg = new Map();
    const bbox = new Map();
    const touching = new Set();
    for (const p of alive) {
      const s = this.strings.get(p.id);
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i <= N; i++) {
        const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      bbox.set(p.id, [minX, minY, minZ, maxX, maxY, maxZ]);
    }
    for (let a = 0; a < alive.length; a++) {
      for (let b = a + 1; b < alive.length; b++) {
        const A = alive[a], B = alive[b];
        const ba = bbox.get(A.id), bb = bbox.get(B.id);
        const m = CUT.HIT_DIST;
        if (ba[0] > bb[3] + m || bb[0] > ba[3] + m || ba[1] > bb[4] + m || bb[1] > ba[4] + m || ba[2] > bb[5] + m || bb[2] > ba[5] + m) continue;
        const sa = this.strings.get(A.id), sb = this.strings.get(B.id);
        let best = null;
        for (let i = 1; i < N; i++) {
          for (let j = 1; j < N; j++) {
            const r = segSegDist(
              sa[i * 3], sa[i * 3 + 1], sa[i * 3 + 2], sa[(i + 1) * 3], sa[(i + 1) * 3 + 1], sa[(i + 1) * 3 + 2],
              sb[j * 3], sb[j * 3 + 1], sb[j * 3 + 2], sb[(j + 1) * 3], sb[(j + 1) * 3 + 1], sb[(j + 1) * 3 + 2],
            );
            if (r.d2 < HD2 && (!best || r.d2 < best.d2)) best = { ...r, i, j };
          }
        }
        if (!best) continue;
        const { i, j, s, t } = best;
        const af = angleFactor(
          sa[(i + 1) * 3] - sa[i * 3], sa[(i + 1) * 3 + 1] - sa[i * 3 + 1], sa[(i + 1) * 3 + 2] - sa[i * 3 + 2],
          sb[(j + 1) * 3] - sb[j * 3], sb[(j + 1) * 3 + 1] - sb[j * 3 + 1], sb[(j + 1) * 3 + 2] - sb[j * 3 + 2],
        );
        // V relatif: kecepatan titik benang (proporsional posisi di sepanjang benang) + tarikan
        const posA = (i + s) / N, posB = (j + t) / N;
        const kA = A.kite, kB = B.kite;
        const relV = Math.hypot(kA.vx * posA - kB.vx * posB, kA.vy * posA - kB.vy * posB, kA.vz * posA - kB.vz * posB);
        const sawA = kA.saw + relV * 0.25;
        const sawB = kB.saw + relV * 0.25;
        const dToB = this.cutDamage(A, B, sawA, af.f) * dt;
        const dToA = this.cutDamage(B, A, sawB, af.f) * dt;
        const cx = sb[j * 3] + (sb[(j + 1) * 3] - sb[j * 3]) * t;
        const cy = sb[j * 3 + 1] + (sb[(j + 1) * 3 + 1] - sb[j * 3 + 1]) * t;
        const cz = sb[j * 3 + 2] + (sb[(j + 1) * 3 + 2] - sb[j * 3 + 2]) * t;
        const addD = (target, amount, from, seg) => {
          const cur = dmg.get(target.id) || { total: 0, top: null, topAmt: 0, seg, x: cx, y: cy, z: cz };
          cur.total += amount;
          if (amount > cur.topAmt) { cur.topAmt = amount; cur.top = from; cur.seg = seg; cur.x = cx; cur.y = cy; cur.z = cz; }
          dmg.set(target.id, cur);
        };
        addD(B, dToB, A, j);
        addD(A, dToA, B, i);
        this.contactSet.add(A.id); this.contactSet.add(B.id);
        this.contacts.push([r2(cx), r2(cy), r2(cz), r2((dToA + dToB) / dt), A.id, B.id, Math.round(af.deg)]);
        // benturan pertama sepasang benang → efek benturan di semua client
        const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
        touching.add(key);
        if (!this.touchPairs.has(key)) {
          const hit = Math.hypot(kA.vx - kB.vx, kA.vy - kB.vy, kA.vz - kB.vz);
          this.impacts.push([r2(cx), r2(cy), r2(cz), r2(hit), A.id, B.id]);
        }
      }
    }
    this.touchPairs = touching;
    for (const [id, d] of dmg) {
      const p = this.players.get(id);
      if (!p || !p.alive) continue;
      p.hp -= d.total;
      if (p.hp <= 0) this.eliminate(p, 'cut', d.top, d);
    }
  }

  cutDamage(att, def, saw, angleF) {
    const ka = att.kite, kd = def.kite;
    const ca = CLASSES[ka.cls];
    let mult = 1;
    if (ka.T >= TENSION.OPT_MIN && ka.T <= TENSION.OPT_MAX) mult *= CUT.OPT_BONUS;
    if (ka.T < TENSION.SLACK) mult *= 0.5;
    if (ka.cls === 'speed' && ka.skillT > 0) mult *= 3;
    let vuln = 1;
    if (kd.T < TENSION.SLACK) vuln *= CUT.SLACK_VULN;
    if (kd.hold) vuln *= 0.75;
    if (kd.cls === 'heavy' && kd.skillT > 0) vuln = 0;
    return saw * ca.sharpness * angleF * mult * vuln * CUT.K;
  }

  updateGhosts(alive, dt) {
    const wdx = Math.cos(this.wind.angle) * this.wind.speed * 0.45;
    const wdz = Math.sin(this.wind.angle) * this.wind.speed * 0.45;
    const HD2 = CUT.HIT_DIST * CUT.HIT_DIST;
    for (const g of this.ghosts) {
      g.life -= dt;
      const pts = g.pts;
      const n = pts.length / 3;
      for (let i = 0; i < n; i++) {
        const f = 0.6 + 0.4 * (i / n);
        pts[i * 3] += wdx * f * dt;
        pts[i * 3 + 1] += (-0.9 + Math.sin(this.matchT * 2 + i) * 0.6) * dt;
        pts[i * 3 + 2] += wdz * f * dt;
      }
      for (const p of alive) {
        if (!p.alive || p.id === g.owner) continue;
        const s = this.strings.get(p.id);
        let hitSeg = -1, hx = 0, hy = 0, hz = 0;
        outer: for (let i = 0; i < n - 1; i++) {
          for (let j = 1; j < STRING_SEGMENTS; j++) {
            const r = segSegDist(
              pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], pts[(i + 1) * 3], pts[(i + 1) * 3 + 1], pts[(i + 1) * 3 + 2],
              s[j * 3], s[j * 3 + 1], s[j * 3 + 2], s[(j + 1) * 3], s[(j + 1) * 3 + 1], s[(j + 1) * 3 + 2],
            );
            if (r.d2 < HD2) {
              hitSeg = j;
              hx = s[j * 3] + (s[(j + 1) * 3] - s[j * 3]) * r.t;
              hy = s[j * 3 + 1] + (s[(j + 1) * 3 + 1] - s[j * 3 + 1]) * r.t;
              hz = s[j * 3 + 2] + (s[(j + 1) * 3 + 2] - s[j * 3 + 2]) * r.t;
              break outer;
            }
          }
        }
        if (hitSeg < 0) continue;
        const kd = p.kite;
        let vuln = kd.T < TENSION.SLACK ? CUT.SLACK_VULN : 1;
        if (kd.cls === 'heavy' && kd.skillT > 0) vuln = 0;
        const amount = CUT.GHOST_DPS * vuln * dt * (g.life / GHOST_LIFE + 0.3);
        p.hp -= amount;
        this.contacts.push([r2(hx), r2(hy), r2(hz), r2(amount / dt), p.id, 'ghost', 90]);
        if (p.hp <= 0) this.eliminate(p, 'ghost', null, { seg: hitSeg, x: hx, y: hy, z: hz });
      }
    }
    this.ghosts = this.ghosts.filter((g) => g.life > 0);
  }

  sendSnapshot() {
    const players = [];
    for (const p of this.players.values()) {
      if (!p.kite) continue;
      const k = p.kite;
      const flags = (p.alive ? 1 : 0) | (k.hold ? 2 : 0) | (k.sprint ? 4 : 0) | (k.snatchT > 0 ? 8 : 0) | (k.skillT > 0 ? 16 : 0);
      players.push([
        p.id, r2(k.px), r2(k.py), r2(k.pz), r2(k.psi), r2(k.L), r2(k.T), r2(Math.max(0, p.hp)), flags,
        r2(k.speed), r2(k.reel), r2(k.outT), r2(k.overT), r2(k.skillCd), r2(k.snatchCd), Math.round(k.stamina), p.kills,
      ]);
    }
    const next = this.state === 'combat' ? zoneNextEvent(this.matchT) : null;
    this.io.to(this.channel).volatile.emit('snap', {
      s: this.state,
      tm: r2(this.state === 'launch' ? this.timer : this.matchT),
      w: [r2(this.wind.angle), r2(this.wind.speed)],
      zr: r2(this.zoneR),
      zn: next ? [r2(next.in), next.shrinking ? 1 : 0, next.target] : null,
      p: players,
      g: this.ghosts.map((g) => [g.id, r2(g.life), Array.from(g.pts, r2)]),
      c: this.contacts,
      i: this.impacts,
    });
    this.impacts = [];
  }
}

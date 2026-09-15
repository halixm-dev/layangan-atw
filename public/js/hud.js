// HUD bergaya editorial: kartu status, pill angin, meter tegangan, minimap, feed
import { CLASSES, TENSION, ZONE, SNATCH } from '/shared/constants.js';
import { tensionZone } from '/shared/physics.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
export const clock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TENSION_LABEL = { slack: 'KENDUR', optimal: 'OPTIMAL', overload: 'BAHAYA', normal: 'NORMAL' };

export class Hud {
  constructor(audio) {
    this.audio = audio;
    this.el = Object.fromEntries([
      'alive', 'total', 'matchTime', 'killCount', 'windArrow', 'wind', 'zone', 'zoneNext', 'feed', 'danger', 'countdown',
      'bigMsg', 'contact', 'tensionValue', 'tensionState', 'tensionNeedle', 'overloadBar', 'healthBar', 'hpValue',
      'staminaBar', 'staminaValue', 'lineLength', 'strikeButton', 'sprintButton', 'skillButton', 'skillName', 'skillCooldown',
      'spectating', 'spectateText', 'specName',
    ].map((id) => [id, $(id)]));
    this.mm = $('minimap').getContext('2d');
    this.cache = {};
    this.alarmT = 0;
    this.bigTimer = null;
    this.mmTimer = 0;
    this.wasShrinking = false;
  }

  text(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.el[key].textContent = value;
  }

  matchStarted(game) {
    this.cache = {};
    this.el.feed.replaceChildren();
    this.wasShrinking = false;
    const cls = game.me ? CLASSES[game.me.info.cls] : null;
    this.el.skillName.textContent = cls ? cls.skill.toUpperCase() : 'SKILL';
    if (game.me) this.bigMessage('Lepaskan layanganmu.', 2200);
  }

  bigMessage(text, ms = 1800) {
    const b = this.el.bigMsg;
    b.textContent = text;
    b.classList.add('show');
    clearTimeout(this.bigTimer);
    this.bigTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  feed(html) {
    const d = document.createElement('div');
    d.innerHTML = '✂ ' + html;
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => d.remove(), 8000);
  }

  update(game, dt) {
    const e = this.el;
    const me = game.me;
    const k = me?.k;
    const alive = !!(k && me.alive);
    document.body.classList.toggle('dead', !alive);

    // --- kartu status & angin
    this.text('alive', String(game.aliveCount ?? game.alive.size));
    this.text('total', String(game.views.size));
    this.text('killCount', `✂ ${game.kills ?? 0}`);
    if (game.matchState === 'launch') {
      this.text('matchTime', 'PELUNCURAN');
      this.text('countdown', String(Math.max(1, Math.ceil(game.matchTime ?? 0))));
    } else {
      this.text('matchTime', clock(game.matchTime ?? 0));
      this.text('countdown', '');
    }
    this.text('wind', `${game.wind.speed.toFixed(1)} m/s`);
    this.text('zone', `ZONA ${Math.round(game.zoneR)} m`);
    // panah angin relatif terhadap arah kamera
    const m = game.camera.matrixWorld.elements;
    const fx = -m[8], fz = -m[10];
    const wx = Math.cos(game.wind.angle), wz = Math.sin(game.wind.angle);
    const rel = Math.atan2(wx * -fz + wz * fx, wx * fx + wz * fz);
    e.windArrow.style.transform = `rotate(${((rel * 180) / Math.PI).toFixed(0)}deg)`;

    const zn = game.matchState === 'combat' ? game.zoneNext : null;
    let zt = '';
    if (zn) {
      zt = zn[1] ? `MENYUSUT → ${zn[2]} m` : `SUSUT ${Math.ceil(zn[0])}s`;
      if (zn[1] && !this.wasShrinking) this.bigMessage('Badai menyusut.', 1600);
      this.wasShrinking = !!zn[1];
    }
    this.text('zoneNext', zt);
    e.zoneNext.classList.toggle('warn', !!zn?.[1]);

    if (alive) {
      const T = k.T;
      const z = tensionZone(T);
      this.text('tensionValue', `${Math.round(T * 100)}%`);
      e.tensionNeedle.style.left = `${(T * 100).toFixed(1)}%`;
      this.text('tensionState', TENSION_LABEL[z] + (k.hold && game.matchState === 'combat' ? ' · TAHAN' : ''));
      e.tensionState.className = z;
      const overT = Math.max(k.overT, me.overT || 0);
      e.overloadBar.style.width = `${Math.min(100, (overT / TENSION.SNAP_TIME) * 100)}%`;
      e.healthBar.style.width = `${Math.max(0, me.hp / me.maxHp) * 100}%`;
      this.text('hpValue', String(Math.ceil(me.hp)));
      e.staminaBar.style.width = `${k.stamina}%`;
      this.text('staminaValue', String(Math.round(k.stamina)));
      this.text('lineLength', `${k.L.toFixed(0)} m`);

      const cls = CLASSES[k.cls];
      e.strikeButton.firstElementChild.style.height = `${Math.min(100, (k.snatchCd / SNATCH.CD) * 100)}%`;
      e.skillButton.firstElementChild.style.height = `${Math.min(100, (k.skillCd / cls.skillCd) * 100)}%`;
      e.strikeButton.classList.toggle('active', k.snatchT > 0);
      e.sprintButton.firstElementChild.style.height = `${100 - k.stamina}%`;
      e.sprintButton.classList.toggle('active', k.sprint);
      e.skillButton.classList.toggle('active', k.skillT > 0);
      this.text('skillCooldown', k.skillCd > 0 ? `${Math.ceil(k.skillCd)} DETIK` : game.input.isTouch ? 'SIAP' : 'Q / SPACE');

      // peringatan
      let warn = '';
      if (me.outOfZone) warn = `KEMBALI KE ZONA · ${Math.max(0, ZONE.OUT_LIMIT - (me.outT || 0)).toFixed(1)}s`;
      else if (overT > 0.2) warn = 'TEGANGAN BERLEBIH · ULUR SEKARANG!';
      else if (T < TENSION.SLACK && game.matchState === 'combat') warn = 'BENANG KENDUR · TARIK BENANG';
      this.text('danger', warn);
      this.alarmT -= dt;
      if (warn && !warn.startsWith('BENANG KENDUR') && this.alarmT <= 0) { this.audio.alarm(); this.alarmT = 0.45; }

      const c = game.myContact;
      if (c && game.grind > 0.05) {
        const name = c.other === 'ghost' ? 'Benang hantu' : game.roster.get(c.other)?.name ?? '?';
        const sharp = c.deg >= 45 && c.deg <= 70;
        e.contact.innerHTML = `Beradu dengan <b>${escapeHtml(name)}</b> · sudut <b class="${sharp ? 'sharp' : ''}">${c.deg}°${sharp ? ' tajam' : ''}</b>`;
        e.contact.classList.add('show');
      } else e.contact.classList.remove('show');
      e.spectating.classList.add('hidden');
    } else {
      this.text('danger', '');
      e.contact.classList.remove('show');
      const show = game.mode === 'match' && game.matchState !== 'results';
      e.spectating.classList.toggle('hidden', !show);
      if (show) {
        const r = game.spectatingId && game.roster.get(game.spectatingId);
        this.text('specName', r ? r.name : '–');
        this.text('spectateText', game.me ? 'BENANGMU PUTUS · MENONTON' : 'MENONTON PERTANDINGAN');
      }
    }

    this.mmTimer -= dt;
    if (this.mmTimer <= 0) { this.mmTimer = 1 / 20; this.drawMinimap(game); }
  }

  drawMinimap(game) {
    const g = this.mm;
    const W = 170, C = W / 2;
    g.clearRect(0, 0, W, W);
    g.fillStyle = '#e9eadb';
    g.fillRect(0, 0, W, W);
    g.strokeStyle = '#cbd2bd';
    g.lineWidth = 1;
    for (let i = 0; i < W; i += 17) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, W); g.moveTo(0, i); g.lineTo(W, i); g.stroke();
    }
    const worldR = Math.max(game.zoneR * 1.15, 60);
    const s = (C - 10) / worldR;
    g.beginPath(); g.arc(C, C, game.zoneR * s, 0, Math.PI * 2);
    g.fillStyle = '#a8bf9855'; g.fill();
    g.strokeStyle = '#78966c'; g.lineWidth = 2; g.stroke();

    for (const v of game.views.values()) {
      const r = game.roster.get(v.id);
      if (!r) continue;
      const isAlive = game.alive.has(v.id);
      const kp = v.isMe && game.me?.alive ? game.me.k : v.current;
      g.globalAlpha = isAlive ? 1 : 0.3;
      g.fillStyle = '#6b7e61';
      g.fillRect(C + r.ax * s - 2, C + r.az * s - 2, 4, 4);
      if (kp && isAlive) {
        g.strokeStyle = v.isMe ? '#df512c88' : '#3c696655';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(C + r.ax * s, C + r.az * s); g.lineTo(C + kp.px * s, C + kp.pz * s); g.stroke();
        g.fillStyle = v.isMe ? '#df512c' : hex(r.color);
        g.beginPath(); g.arc(C + kp.px * s, C + kp.pz * s, v.isMe ? 4.5 : 3, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    // angin
    const wa = game.wind.angle;
    const ax = C + Math.cos(wa) * 16, ay = C + Math.sin(wa) * 16;
    g.strokeStyle = '#233a35aa'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(C - Math.cos(wa) * 16, C - Math.sin(wa) * 16); g.lineTo(ax, ay);
    g.lineTo(ax - Math.cos(wa - 0.5) * 6, ay - Math.sin(wa - 0.5) * 6);
    g.moveTo(ax, ay); g.lineTo(ax - Math.cos(wa + 0.5) * 6, ay - Math.sin(wa + 0.5) * 6);
    g.stroke();
    g.fillStyle = '#6b7e61'; g.font = '9px DM Sans, sans-serif'; g.textAlign = 'center';
    g.fillText('ANGIN', C, 14);
  }
}

export { hex };

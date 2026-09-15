// Input: keyboard + mouse (PC) dan joystick/slider/tombol (touchscreen)
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.enabled = false;
    this.wheelReel = 0;
    this.pending = { snatch: false, skill: false };
    this.handlers = {};
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.touch = { x: 0, y: 0, reel: 0, sprint: false };
    if (this.isTouch) document.body.classList.add('is-touch');

    const typing = (e) => /INPUT|TEXTAREA/.test(e.target.tagName) || document.querySelector('dialog[open]');
    addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const k = e.code;
      if (!this.keys.has(k)) {
        if (this.enabled && (k === 'KeyQ' || k === 'Space')) this.pending.skill = true;
        if (k === 'KeyV') this.emit('camera');
        if (k === 'KeyH') this.emit('help');
      }
      this.keys.add(k);
      if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    const reset = () => { this.keys.clear(); this.touch.x = this.touch.y = this.touch.reel = 0; this.touch.sprint = false; };
    addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.pending.snatch = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      // scroll atas = ulur (+), scroll bawah = tarik (-)
      const step = Math.sign(-e.deltaY) * 0.34;
      this.wheelReel = Math.max(-1, Math.min(1, this.wheelReel + step));
    }, { passive: true });

    // tombol HUD (dipakai PC maupun touch)
    const press = (id, fn) => document.getElementById(id)?.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
    press('strikeButton', () => { if (this.enabled) this.pending.snatch = true; });
    press('skillButton', () => { if (this.enabled) this.pending.skill = true; });
    press('camButton', () => this.emit('camera'));

    this.setupTouch();
  }

  on(name, fn) { (this.handlers[name] ||= []).push(fn); }
  emit(name, ...a) { (this.handlers[name] || []).forEach((f) => f(...a)); }

  setupTouch() {
    const joy = document.getElementById('joystick');
    const jknob = joy.firstElementChild;
    let joyId = null;
    const joyMove = (t) => {
      const r = joy.getBoundingClientRect();
      let dx = (t.clientX - (r.left + r.width / 2)) / (r.width * 0.38);
      let dy = (t.clientY - (r.top + r.height / 2)) / (r.height * 0.38);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.touch.x = dx;
      this.touch.y = -dy;
      jknob.style.transform = `translate(${dx * r.width * 0.3}px, ${dy * r.height * 0.3}px)`;
    };
    joy.addEventListener('pointerdown', (e) => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyMove(e); });
    const joyEnd = (e) => { if (e.pointerId !== joyId) return; joyId = null; this.touch.x = this.touch.y = 0; jknob.style.transform = ''; };
    joy.addEventListener('pointerup', joyEnd);
    joy.addEventListener('pointercancel', joyEnd);

    const sl = document.getElementById('reelSlider');
    const sknob = sl.firstElementChild;
    let slId = null;
    const slMove = (e) => {
      const r = sl.getBoundingClientRect();
      let v = -((e.clientY - (r.top + r.height / 2)) / (r.height / 2 - 12));
      v = Math.max(-1, Math.min(1, v));
      this.touch.reel = Math.abs(v) < 0.12 ? 0 : v;
      sknob.style.transform = `translateY(${-v * (r.height / 2 - 15)}px)`;
    };
    sl.addEventListener('pointerdown', (e) => { slId = e.pointerId; sl.setPointerCapture(e.pointerId); slMove(e); });
    sl.addEventListener('pointermove', (e) => { if (e.pointerId === slId) slMove(e); });
    const slEnd = (e) => { if (e.pointerId !== slId) return; slId = null; this.touch.reel = 0; sknob.style.transform = ''; };
    sl.addEventListener('pointerup', slEnd);
    sl.addEventListener('pointercancel', slEnd);

    // tombol DIVE: aktif selama ditekan
    const dive = document.getElementById('sprintButton');
    dive.addEventListener('pointerdown', (e) => { e.preventDefault(); dive.setPointerCapture(e.pointerId); this.touch.sprint = true; });
    const diveOff = () => { this.touch.sprint = false; };
    dive.addEventListener('pointerup', diveOff);
    dive.addEventListener('pointercancel', diveOff);
  }

  update(dt) {
    // scroll: impuls yang meluruh
    this.wheelReel -= this.wheelReel * Math.min(1, dt * 1.6);
    if (Math.abs(this.wheelReel) < 0.02) this.wheelReel = 0;
  }

  state() {
    const k = this.keys;
    let x = 0, y = 0, reel = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;   // W = menukik (GDD)
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1; // S = menanjak
    if (this.invertY) y = -y;
    if (k.has('KeyR')) reel += 1;
    if (k.has('KeyF')) reel -= 1;
    reel += this.wheelReel;
    if (Math.abs(this.touch.x) + Math.abs(this.touch.y) > 0.05) { x = this.touch.x; y = this.touch.y; }
    if (this.touch.reel) reel = this.touch.reel;
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.sprint;
    return { x, y, reel: Math.max(-1, Math.min(1, reel)), sprint };
  }

  consumeActions() {
    const a = { ...this.pending };
    this.pending.snatch = this.pending.skill = false;
    return a;
  }
}

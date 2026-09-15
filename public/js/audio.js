// Audio prosedural (WebAudio) - tanpa file suara
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Buffer noise yang bisa di-loop mulus (ujung di-crossfade ke awal) */
function makeLoopNoise(ctx, seconds, type) {
  const rate = ctx.sampleRate;
  const len = Math.floor(seconds * rate);
  const fade = Math.floor(0.4 * rate);
  const raw = new Float32Array(len + fade);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.2;
    } else {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  d.set(raw.subarray(0, len));
  // sampel ekstra di akhir dicampur ke awal → sambungan loop tanpa klik
  for (let i = 0; i < fade; i++) {
    const m = i / fade;
    d[i] = raw[i] * m + raw[len + i] * (1 - m);
  }
  return buf;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  init() {
    if (this.ready) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(ctx.destination);

      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      // angin: dua lapis brown noise (lembut, frekuensi rendah) kiri-kanan + lapis hembusan pink noise
      this.windBus = ctx.createGain();
      this.windBus.gain.value = 0.0;
      this.windBus.connect(this.master);
      this.windLayers = [];
      for (const [secs, pan, cutoff] of [[6.3, -0.55, 380], [7.9, 0.55, 460]]) {
        const src = ctx.createBufferSource();
        src.buffer = makeLoopNoise(ctx, secs, 'brown');
        src.loop = true;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.2;
        const g = ctx.createGain(); g.gain.value = 0.5;
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (p) { p.pan.value = pan; src.connect(lp).connect(g).connect(p).connect(this.windBus); }
        else src.connect(lp).connect(g).connect(this.windBus);
        src.start(0, Math.random() * secs);
        this.windLayers.push({ lp, g, cutoff });
      }
      const gustSrc = ctx.createBufferSource();
      gustSrc.buffer = makeLoopNoise(ctx, 5.1, 'pink');
      gustSrc.loop = true;
      this.gustFilter = ctx.createBiquadFilter();
      this.gustFilter.type = 'bandpass'; this.gustFilter.frequency.value = 650; this.gustFilter.Q.value = 0.9;
      this.gustGain = ctx.createGain(); this.gustGain.gain.value = 0;
      gustSrc.connect(this.gustFilter).connect(this.gustGain).connect(this.windBus);
      gustSrc.start(0, Math.random() * 5);
      this.windSeed = Math.random() * 100;

      // dengung benang
      this.hum = ctx.createOscillator();
      this.hum.type = 'sawtooth'; this.hum.frequency.value = 110;
      const humF = ctx.createBiquadFilter(); humF.type = 'lowpass'; humF.frequency.value = 700;
      this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
      this.hum.connect(humF).connect(this.humGain).connect(this.master);
      this.hum.start();

      // gesekan benang (volume lembut)
      const grind = ctx.createBufferSource();
      grind.buffer = buf; grind.loop = true;
      const gf = ctx.createBiquadFilter(); gf.type = 'highpass'; gf.frequency.value = 2500;
      this.grindGain = ctx.createGain(); this.grindGain.gain.value = 0;
      grind.connect(gf).connect(this.grindGain).connect(this.master);
      grind.start();
      this.ready = true;
    } catch (e) {
      console.warn('Audio tidak tersedia', e);
    }
  }

  update({ speed = 0, tension = 0, grind = 0, active = false, wind = 8 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    // hembusan: kurva halus pseudo-acak (jumlah sinus tak sebanding), tanpa pola berulang yang terasa
    const s = t + this.windSeed;
    const gust = clamp01(0.5 + 0.28 * Math.sin(s * 0.23) + 0.16 * Math.sin(s * 0.61 + 1.3) + 0.08 * Math.sin(s * 1.37 + 4.1));
    const windF = clamp01((wind - 5) / 7);             // kekuatan angin arena (± 6–11 m/s)
    const move = active ? Math.min(1, speed / 35) : 0;  // desir karena layangan melaju
    const level = 0.1 + 0.08 * windF + 0.1 * gust + 0.06 * move;
    this.windBus.gain.setTargetAtTime(level, t, 0.6);
    for (const L of this.windLayers) {
      L.lp.frequency.setTargetAtTime(L.cutoff * (0.75 + 0.55 * gust + 0.5 * move), t, 0.8);
    }
    this.gustGain.gain.setTargetAtTime(Math.max(0, gust - 0.55) * 0.35 * (0.6 + windF), t, 0.7);
    this.gustFilter.frequency.setTargetAtTime(480 + 380 * gust + 250 * move, t, 0.9);
    this.humGain.gain.setTargetAtTime(active && tension > 0.5 ? (tension - 0.5) * 0.09 : 0, t, 0.1);
    this.hum.frequency.setTargetAtTime(90 + tension * 260, t, 0.1);
    // gesekan: karakter sama seperti sebelumnya, volume ±30%
    this.grindGain.gain.setTargetAtTime(Math.min(0.1, grind * 0.3), t, 0.08);
  }

  blip(freq = 600, dur = 0.12, type = 'square', vol = 0.12, slide = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  whoosh(vol = 0.25, dur = 0.3, freq = 900) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(freq * 0.5, t); f.frequency.exponentialRampToValueAtTime(freq * 2, t + dur);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t); s.stop(t + dur + 0.05);
  }

  /** Benturan benang: petikan senar tegang ("tak-nggg"), volume lembut */
  twang(vol = 1) {
    if (!this.ready || vol <= 0.02) return;
    const t = this.ctx.currentTime;
    const f0 = 380 + Math.random() * 160;
    for (const [mul, type, g0] of [[1, 'triangle', 0.075], [2.01, 'sine', 0.025]]) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0 * mul * 1.25, t);
      o.frequency.exponentialRampToValueAtTime(f0 * mul, t + 0.08);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(g0 * vol, t + 0.006); // serangan halus, tanpa klik
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.5);
    }
    this.whoosh(0.05 * vol, 0.05, 3200);
  }

  /** Layangan menabrak atap/dinding */
  thud(vol = 1) {
    if (!this.ready || vol <= 0.02) return;
    this.blip(120, 0.18, 'sine', 0.3 * vol, -70);
    this.whoosh(0.2 * vol, 0.12, 500);
  }

  snatch() { this.whoosh(0.3, 0.22, 1400); }
  skill() { this.whoosh(0.25, 0.5, 600); this.blip(440, 0.3, 'triangle', 0.1, 400); }
  cut(near) { this.blip(1800, 0.06, 'square', near ? 0.25 : 0.08); this.blip(500, 0.5, 'triangle', near ? 0.15 : 0.05, -400); }
  alarm() { this.blip(880, 0.09, 'square', 0.08); }
  click() { this.blip(700, 0.05, 'triangle', 0.08); }
  win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.25, 'triangle', 0.14), i * 130)); }
}

// Bootstrap: UI beranda/lobi/hasil, koneksi Socket.io, alur pertandingan
import { CLASSES } from '/shared/constants.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { Hud, escapeHtml, clock, hex } from './hud.js';

const $ = (id) => document.getElementById(id);
const CLASS_UI = {
  speed: { symbol: 'orange', desc: 'Sentakan cepat. Potongan mematikan.' },
  heavy: { symbol: 'teal', desc: 'Kebal abrasi selama 2 detik.' },
  acro: { symbol: 'purple', desc: 'Naik seketika. Lepas dari jerat lawan.' },
};

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
};

const audio = new GameAudio();
const input = new Input($('game'));
const hud = new Hud(audio);
const game = new Game($('game'), { audio, input, hud });
// Alamat server game: ?server=URL (disimpan, untuk uji cepat) > ATW_SERVER_URL dari config.js (build Vercel)
// > origin yang sama (dijalankan lewat `npm start`). `?server=` kosong menghapus override.
const serverParam = new URLSearchParams(location.search).get('server');
if (serverParam !== null) store.set('atw_server', serverParam.trim().replace(/\/+$/, ''));
const SERVER_URL = store.get('atw_server', '') || window.ATW_SERVER_URL || undefined;
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], autoConnect: false, reconnectionDelayMax: 10000 });
window.__atw = { game, socket }; // handle debug

let myClass = store.get('atw_class', 'speed');
if (!CLASSES[myClass]) myClass = 'speed';
let room = null;
let inMatch = false;
let loaded = false;
let lastMode = null;
let resultsTimer = null;

// ------------------------------------------------------------------ util
function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * Pastikan server game benar-benar ada sebelum membuka WebSocket.
 * Hosting statis (mis. Vercel) tidak punya /health → tampilkan penjelasan, bukan error WebSocket berulang.
 */
let serverWarned = false;
async function connectServer() {
  const base = SERVER_URL || location.origin;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000); // server gratis (Render) bisa butuh ±1 menit untuk bangun
    $('connectionText').textContent = SERVER_URL ? 'Membangunkan server…' : 'Menghubungkan';
    const r = await fetch(`${base}/health`, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    if (!j?.ok) throw new Error('health');
    socket.connect();
  } catch {
    $('connectionText').textContent = SERVER_URL ? 'Server game tidak merespons' : 'Server game belum diatur';
    document.querySelector('.connection').classList.remove('online');
    if (!serverWarned) {
      serverWarned = true;
      toast(SERVER_URL
        ? `Server game (${SERVER_URL}) belum merespons. Mencoba lagi…`
        : 'Server game belum diatur. Set ATW_SERVER_URL di Vercel ke alamat server game (mis. Render) lalu redeploy.', 9000);
      console.warn(`[ATW] Server game tidak ditemukan di ${base}. Hosting statis seperti Vercel tidak bisa menjalankan Socket.io; ` +
        'deploy server (npm start) ke Render/Railway lalu isi ATW_SERVER_URL, atau uji dengan ?server=https://alamat-server');
    }
    setTimeout(connectServer, 15000);
  }
}

/** screen: 'home' | 'lobby' | 'hud' | 'results' */
function show(screen) {
  $('home').classList.toggle('hidden', screen !== 'home');
  $('lobby').classList.toggle('hidden', screen !== 'lobby');
  $('hud').classList.toggle('hidden', screen !== 'hud' && screen !== 'results');
  $('results').classList.toggle('hidden', screen !== 'results');
  document.body.classList.toggle('in-game', screen === 'hud' || screen === 'results');
  if (screen !== 'hud' && screen !== 'results') for (const l of document.querySelectorAll('.player-label')) l.style.display = 'none';
}

function updateButtons() {
  for (const id of ['quickPlay', 'createRoom', 'joinRoom', 'practice']) $(id).disabled = !socket.connected || !loaded;
}

document.addEventListener('pointerdown', () => audio.init(), { once: true });
document.addEventListener('keydown', () => audio.init(), { once: true });

// ------------------------------------------------------------------ pilih kelas
function selectClass(cls, notify = true) {
  myClass = cls;
  store.set('atw_class', cls);
  for (const c of document.querySelectorAll('.class-card')) {
    const on = c.dataset.class === cls;
    c.classList.toggle('selected', on);
    c.setAttribute('aria-pressed', String(on));
  }
  $('classSkill').textContent = 'ϟ ' + CLASSES[cls].skill;
  $('classDesc').textContent = CLASS_UI[cls].desc;
  renderLobbyClasses();
  game.setMenuClass(cls);
  if (notify && room) socket.emit('setClass', { cls });
}
for (const c of document.querySelectorAll('.class-card')) c.onclick = () => { audio.click(); selectClass(c.dataset.class); };

function renderLobbyClasses() {
  const wrap = $('lobbyClasses');
  wrap.replaceChildren();
  for (const c of Object.values(CLASSES)) {
    const b = document.createElement('button');
    b.className = c.id === myClass ? 'selected' : '';
    b.innerHTML = `<b class="${CLASS_UI[c.id].symbol}">◈</b>${c.name}`;
    b.onclick = () => { audio.click(); selectClass(c.id); };
    wrap.append(b);
  }
}

const nameInput = $('playerName');
nameInput.value = store.get('atw_name', 'Penerbang ATW');
const playerName = () => {
  const n = nameInput.value.trim() || 'Penerbang ATW';
  store.set('atw_name', n);
  return n;
};

// ------------------------------------------------------------------ tombol beranda
function join(event, extra = {}) {
  if (!loaded || !socket.connected) return toast('Tunggu aset dan koneksi siap.');
  audio.init();
  audio.click();
  lastMode = event;
  socket.emit(event, { name: playerName(), cls: myClass, ...extra });
}
$('quickPlay').onclick = () => join('quickMatch');
$('createRoom').onclick = () => join('createRoom');
$('practice').onclick = () => join('soloMatch');
$('joinRoom').onclick = () => { $('joinDialog').showModal(); $('roomInput').focus(); };
$('joinForm').onsubmit = (e) => {
  e.preventDefault();
  join('joinRoom', { code: $('roomInput').value.trim().toUpperCase() });
};
for (const id of ['helpButton', 'controlsLink']) $(id).onclick = () => $('helpDialog').showModal();
for (const b of document.querySelectorAll('.close-dialog')) b.onclick = () => b.closest('dialog').close();
input.on('help', () => { const d = $('helpDialog'); d.open ? d.close() : d.showModal(); });

const soundBtn = $('soundButton');
const applySound = (muted) => {
  audio.setMuted(muted);
  soundBtn.classList.toggle('off', muted);
  soundBtn.setAttribute('aria-label', muted ? 'Aktifkan suara' : 'Matikan suara');
};
applySound(store.get('atw_muted', '0') === '1');
soundBtn.onclick = () => {
  const muted = !audio.muted;
  store.set('atw_muted', muted ? '1' : '0');
  audio.init();
  applySound(muted);
  if (!muted) audio.click();
  toast(muted ? 'Efek suara nonaktif' : 'Efek suara aktif');
};

const invertBox = $('invertY');
const applyInvert = (on) => {
  input.invertY = on;
  invertBox.checked = on;
  $('wsHint').textContent = on ? 'Naik / menukik' : 'Menukik / naik';
};
applyInvert(store.get('atw_invert', '0') === '1');
invertBox.onchange = () => { store.set('atw_invert', invertBox.checked ? '1' : '0'); applyInvert(invertBox.checked); };

// ------------------------------------------------------------------ layar penuh (mobile)
const rootEl = document.documentElement;
const fsSupported = !!(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen);
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement)
  || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
const gate = $('fullscreenGate');

function updateGateText() {
  $('fsRotate').classList.toggle('hidden', !matchMedia('(orientation: portrait)').matches);
  if (!fsSupported) {
    $('fsText').textContent = 'Browser ini tidak mendukung layar penuh otomatis. Untuk tampilan penuh, pilih Bagikan → "Tambahkan ke Layar Utama", lalu buka dari ikon ATW.';
    $('fsEnter').innerHTML = 'LANJUT <span>↗</span>';
    $('fsSkip').classList.add('hidden');
  }
}

/** Selalu minta layar penuh di perangkat sentuh selama belum layar penuh */
function askFullscreen() {
  if (!input.isTouch || isFullscreen()) { gate.classList.add('hidden'); return; }
  updateGateText();
  gate.classList.remove('hidden');
}

async function enterFullscreen() {
  gate.classList.add('hidden');
  audio.init();
  if (!fsSupported) return;
  try {
    if (rootEl.requestFullscreen) await rootEl.requestFullscreen({ navigationUI: 'hide' });
    else rootEl.webkitRequestFullscreen();
    await screen.orientation?.lock?.('landscape').catch(() => {});
  } catch {
    toast('Layar penuh ditolak browser. Ketuk tombol lagi untuk mencoba.');
  }
  // browser kadang mengabaikan permintaan tanpa error: minta lagi bila belum layar penuh
  setTimeout(() => { if (!isFullscreen()) askFullscreen(); }, 1200);
}
$('fsEnter').onclick = enterFullscreen;
$('fsSkip').onclick = () => gate.classList.add('hidden');
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    game.resize();
    if (!isFullscreen()) setTimeout(askFullscreen, 300);
  });
}
matchMedia('(orientation: portrait)').addEventListener?.('change', () => { if (!gate.classList.contains('hidden')) updateGateText(); });

// undangan lewat link ?room=KODE
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('roomInput').value = urlCode.toUpperCase().slice(0, 4);

// ------------------------------------------------------------------ lobi
$('copyCode').onclick = async () => {
  if (!room?.code) return;
  const url = `${location.origin}/?room=${room.code}`;
  try { await navigator.clipboard.writeText(url); toast(`Link room disalin: ${room.code}`); } catch { toast(`Kode room: ${room.code}`); }
};
$('startMatch').onclick = () => socket.emit('startMatch');
$('addBot').onclick = () => socket.emit('addBot');
$('kickBots').onclick = () => socket.emit('kickBots');
$('leaveLobby').onclick = () => returnHome();
$('exitMatch').onclick = () => returnHome();
$('backHome').onclick = () => returnHome();
$('prevSpec').onclick = () => game.cycleSpectate(-1);
$('nextSpec').onclick = () => game.cycleSpectate(1);
$('playAgain').onclick = () => {
  if (lastMode === 'soloMatch' || !room) {
    socket.emit('leaveRoom');
    room = null;
    inMatch = false;
    join('soloMatch');
  } else {
    inMatch = false;
    show('lobby');
    renderRoom(room);
    toast(room.hostId === socket.id ? 'Mulai ronde berikutnya kapan saja.' : 'Menunggu ronde berikutnya…');
  }
};

function returnHome() {
  socket.emit('leaveRoom');
  room = null;
  inMatch = false;
  clearInterval(resultsTimer);
  history.replaceState(null, '', location.pathname);
  game.enterMenu(myClass);
  show('home');
}

function renderRoom(info) {
  room = info;
  const isHost = info.hostId === socket.id;
  $('lobbyEyebrow').textContent = info.isPrivate ? 'ROOM PRIVAT · TITIK PELUNCURAN' : 'ROOM PUBLIK · TITIK PELUNCURAN';
  $('copyCode').classList.toggle('hidden', !info.code);
  if (info.code) $('copyCode').innerHTML = `${info.code} <span>⧉</span>`;
  $('lobbyText').textContent = info.code
    ? 'Bagikan kode ini kepada teman. Klik untuk menyalin link undangan.'
    : 'Kamu masuk antrean publik. Penerbang lain akan bergabung sebentar lagi.';

  const list = $('playersList');
  list.replaceChildren();
  for (const p of info.players) {
    const row = document.createElement('div');
    row.className = 'player-row' + (p.id === socket.id ? ' me' : '');
    const name = document.createElement('span');
    name.innerHTML = `<i class="dot" style="background:${hex(p.color)}"></i>${escapeHtml(p.name)}${p.id === socket.id ? ' (kamu)' : ''}`;
    const badge = document.createElement('small');
    badge.textContent = [p.id === info.hostId ? 'HOST' : null, p.isBot ? 'BOT' : null, CLASSES[p.cls].name.toUpperCase()].filter(Boolean).join(' · ');
    row.append(name, badge);
    list.append(row);
  }
  for (let i = info.players.length; i < info.min; i++) {
    const row = document.createElement('div');
    row.className = 'player-row empty';
    row.textContent = 'Slot kosong — diisi bot saat mulai';
    list.append(row);
  }

  for (const id of ['startMatch', 'addBot', 'kickBots']) $(id).disabled = !isHost || info.state !== 'waiting';
  let note;
  if (info.state !== 'waiting') note = 'Ronde sedang berlangsung — kamu ikut ronde berikutnya.';
  else if (info.countdown != null) note = `${info.players.length}/${info.max} penerbang · mulai otomatis dalam ${info.countdown} detik.`;
  else note = isHost ? `${info.players.length}/${info.max} penerbang. Mulai saat semua siap.` : 'Menunggu host memulai pertandingan.';
  $('lobbyNote').textContent = note;

  const me = info.players.find((p) => p.id === socket.id);
  if (me && me.cls !== myClass) selectClass(me.cls, false);
}

// ------------------------------------------------------------------ socket
socket.on('connect', () => {
  $('connectionText').textContent = 'Server terhubung';
  document.querySelector('.connection').classList.add('online');
  updateButtons();
});
socket.on('disconnect', () => {
  $('connectionText').textContent = 'Menghubungkan ulang';
  document.querySelector('.connection').classList.remove('online');
  updateButtons();
  if (room) { toast('Koneksi terputus. Bergabung kembali setelah server terhubung.'); returnHome(); }
});
socket.on('errorMsg', ({ msg }) => toast(msg));

socket.on('joined', (d) => {
  if ($('joinDialog').open) $('joinDialog').close();
  if (d.isPrivate && d.code && lastMode !== 'soloMatch') {
    const url = new URL(location.href);
    url.searchParams.set('room', d.code);
    history.replaceState(null, '', url);
  }
  if (!inMatch) show('lobby');
});

socket.on('roomUpdate', (info) => {
  renderRoom(info);
  if (!inMatch && $('home').classList.contains('hidden') && $('results').classList.contains('hidden')) show('lobby');
});

socket.on('matchStart', (info) => {
  inMatch = true;
  clearInterval(resultsTimer);
  if ($('helpDialog').open) $('helpDialog').close();
  show('hud');
  game.startMatch(info, socket.id, socket);
  askFullscreen();
});

socket.on('snap', (s) => game.onSnapshot(s));
socket.on('fx', (e) => game.onFx(e));
socket.on('actionAck', (a) => game.onActionAck(a));

socket.on('elim', (e) => {
  game.onElim(e);
  const nm = (id) => {
    const r = game.roster?.get(id);
    return r ? `<b>${escapeHtml(r.name)}</b>` : '?';
  };
  const msgs = {
    cut: `${nm(e.by)} memutus ${nm(e.id)}`,
    ghost: `${nm(e.id)} terjerat benang hantu`,
    snap: `Benang ${nm(e.id)} putus — tegangan berlebih`,
    zone: `${nm(e.id)} tersapu badai`,
    time: `${nm(e.id)} kehabisan waktu`,
    leave: `${nm(e.id)} meninggalkan arena`,
  };
  hud.feed(msgs[e.reason] || nm(e.id));
  if (e.by === socket.id) hud.bigMessage(`Kamu memutus ${game.roster.get(e.id)?.name ?? ''}.`, 1800);
  if (e.id === socket.id) {
    const reason = {
      cut: `Diputus oleh ${game.roster.get(e.by)?.name ?? 'lawan'}.`,
      ghost: 'Terjerat benang hantu.',
      snap: 'Benang putus — tegangan berlebih.',
      zone: 'Tersapu badai di luar zona.',
      time: 'Waktu ronde habis.',
    }[e.reason] || '';
    hud.bigMessage(`Benangmu putus. #${e.place}`, 2500);
    toast(reason);
  }
});

socket.on('results', ({ ranking, winnerId }) => {
  const mine = ranking.find((r) => r.id === socket.id);
  const winner = ranking.find((r) => r.id === winnerId);
  const won = winnerId === socket.id;
  $('resultTitle').textContent = won ? 'Langit milikmu.' : mine ? 'Terbang lagi, jagoan.' : 'Ronde selesai.';
  $('resultText').textContent = winner ? `${winner.name} menjadi layangan terakhir yang bertahan.` : 'Tak ada layangan yang bertahan.';
  $('resultPlace').textContent = mine ? `#${mine.place}` : '–';
  $('resultKills').textContent = mine ? mine.kills : 0;
  $('resultTime').textContent = clock(game.matchTime ?? 0);
  $('rankList').innerHTML = ranking.map((r) => `<div class="player-row${r.id === socket.id ? ' me' : ''}">
      <span><b>${r.place}</b><i class="dot" style="background:${hex(r.color)}"></i>${escapeHtml(r.name)}${r.isBot ? ' <small>BOT</small>' : ''}</span>
      <small>${CLASSES[r.cls].name.toUpperCase()} · ✂ ${r.kills}</small></div>`).join('');
  if (won) audio.win();
  let left = 10;
  const tick = () => { $('resultTimer').textContent = lastMode === 'soloMatch' ? '' : `Kembali ke lobi dalam ${left} detik`; left = Math.max(0, left - 1); };
  tick();
  clearInterval(resultsTimer);
  resultsTimer = setInterval(tick, 1000);
  input.enabled = false;
  show('results');
});

socket.on('backToLobby', () => {
  clearInterval(resultsTimer);
  // latihan: tetap di layar hasil sampai pemain memilih
  if (lastMode === 'soloMatch' && !$('results').classList.contains('hidden')) {
    inMatch = false;
    return;
  }
  inMatch = false;
  game.enterMenu(myClass);
  show('lobby');
  if (room) renderRoom(room);
});

setInterval(() => {
  if (!socket.connected) return;
  const t = performance.now();
  socket.emit('ping2', t, () => {
    const ms = Math.round(performance.now() - t);
    $('connectionText').textContent = room ? `${ms} ms` : 'Server terhubung';
  });
}, 3000);

// ------------------------------------------------------------------ boot
selectClass(myClass, false);
updateButtons();
connectServer();
(async () => {
  try {
    await game.load((p, done, total) => {
      $('loading').lastElementChild.textContent = `${done} / ${total}`;
    });
    loaded = true;
    $('loading').classList.add('hidden');
    game.enterMenu(myClass);
    show('home');
    updateButtons();
    if (urlCode) { $('joinDialog').showModal(); }
    else if (!store.get('atw_seen_help', '')) { $('helpDialog').showModal(); store.set('atw_seen_help', '1'); }
    askFullscreen();
  } catch (e) {
    console.error(e);
    $('loading').textContent = 'Aset 3D gagal dimuat. Muat ulang halaman.';
    $('loading').classList.add('error');
    toast('Gagal memuat aset Blender. Periksa server dan muat ulang.');
  }
})();

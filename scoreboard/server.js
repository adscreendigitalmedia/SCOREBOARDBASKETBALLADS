// Scoreboard server - sin dependencias externas.
// Uso: node server.js   (puerto 8080 por defecto; cambiar con PORT=9000 node server.js)
// Requiere Node.js 22.13+ para usar SQLite integrado (con Node más viejo guarda en data.json).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./db').open();
const { buildReport } = require('./pdf');
const auth = require('./auth');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');

// ---------- Usuarios: primer arranque = admin / admin (pide cambiarla al entrar) ----------
if (store.countUsers() === 0) {
  store.createUser({ username: 'admin', name: 'Administrador', pass: auth.hashPassword('admin'), roles: ['admin'], mustChange: true });
  console.log('\n  Usuario inicial creado -> usuario: admin  contraseña: admin  (cámbiala al entrar)\n');
}
setInterval(() => store.purge(), 3600e3).unref();
// clave para Stream Deck / Companion (/api/cmd?key=...): se ve y se cambia en Admin
if (!store.getKV('apiKey')) store.setKV('apiKey', auth.newToken().slice(0, 24));

function userFromToken(token) {
  const ses = token && store.getSession(token);
  const u = ses && store.getUser(ses.userId);
  return u && u.active ? u : null;
}
const userFromReq = (req) => userFromToken(auth.readCookie(req));
function readBody(req, cb, limit = 1e6) {
  let body = '', dead = false;
  req.on('data', (d) => { body += d; if (body.length > limit) { dead = true; req.destroy(); } });
  req.on('end', () => { if (dead) return; let o = {}; try { o = JSON.parse(body || '{}'); } catch (_) {} cb(o); });
}
// registro de actividad: quién hizo qué (los comandos del reloj también, para saber quién lo paró)
function auditCmd(user, c) {
  const { a, t, ...rest } = c;
  const detail = Object.keys(rest).length ? JSON.stringify(rest) : '';
  store.audit(user ? user.username : 'stream-deck', a || '?', detail);
}

// ---------- Estado ----------
const player = (n = '', name = '', on = false, pos = '') => ({ n, name, pos, pts: 0, reb: 0, ast: 0, pf: 0, on });
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];   // posiciones de ejemplo para los 5 iniciales
const roster = (names) =>
  Array.from({ length: 12 }, (_, i) => (names[i] ? player(String(i + 4), names[i], true, POS[i] || '') : player()));
const team = (name, short, names) => ({
  name, short, logo: '', score: 0, fouls: 0, timeouts: 3, note: '', players: roster(names),
  // estadísticas de equipo (REB y AST se suman solos desde los jugadores)
  stats: { p2m: 0, p2a: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0, stl: 0, tov: 0, blk: 0 },
});
const emptyTimer = () => ({ kind: '', label: '', team: null, ms: 0, total: 0, running: false, done: false });

// ---------- Pantallas: mismo diseño, cada una con su tamaño y proporciones ----------
// Medidas base (pantalla Principal 1920x1080, coinciden con la plantilla led_scoreboard_layout_vacio.png)
const BASE_SCREEN = { w: 1920, h: 1080, fs: 100, padT: 18, padB: 20, padX: 25, titleH: 52, topH: 243, gapY: 17, gapX: 18,
  scoreW: 275, clockW: 450, sideW: 482, statsH: 193, stripH: 137 };
const SCREEN_LIMITS = { w: [64, 7680], h: [64, 4320], fs: [5, 400], padT: [0, 400], padB: [0, 400], padX: [0, 600], titleH: [0, 400],
  topH: [10, 1600], gapY: [0, 200], gapX: [0, 200], scoreW: [10, 2400], clockW: [10, 3000], sideW: [10, 3000], statsH: [0, 2000], stripH: [0, 2000] };
// proporciones escaladas al tamaño (para pantallas nuevas o con "Ajustar al tamaño")
function scaledScreen(w, h) {
  const kx = w / 1920, ky = h / 1080, k = Math.min(kx, ky), r = Math.round, b = BASE_SCREEN;
  return { w, h, fs: r(100 * k), padT: r(b.padT * ky), padB: r(b.padB * ky), padX: r(b.padX * kx), titleH: r(b.titleH * ky), topH: r(b.topH * ky),
    gapY: r(b.gapY * ky), gapX: r(b.gapX * kx), scoreW: r(b.scoreW * kx), clockW: r(b.clockW * kx), sideW: r(b.sideW * kx),
    statsH: r(b.statsH * ky), stripH: r(b.stripH * ky) };
}
function cleanScreen(x) {
  const out = { id: String(x.id || 'p' + Date.now().toString(36)).replace(/[^\w-]/g, '').slice(0, 24) || 'p', name: String(x.name || 'Pantalla').slice(0, 40), bg: typeof x.bg === 'string' ? x.bg : '',
    layout: ['auto', 'full', 'bug'].includes(x.layout) ? x.layout : 'auto',   // auto = marcador tipo TV si el tablero no cabe
    // marcador tipo TV: ocupa solo una parte (el resto queda transparente para anuncios)
    bugPos: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br', 'free'].includes(x.bugPos) ? x.bugPos : 'bc',
    // posición libre (arrastrando en el panel): esquina superior izquierda del marcador, en % de la pantalla
    bugX: Math.round(Math.max(0, Math.min(100, Number(x.bugX) || 0)) * 10) / 10, bugY: Math.round(Math.max(0, Math.min(100, Number(x.bugY) || 0)) * 10) / 10,
    bugW: Math.round(Math.max(3, Math.min(100, Number(x.bugW) || 50)) * 10) / 10, bugH: Math.round(Math.max(3, Math.min(100, Number(x.bugH) || 8)) * 10) / 10,
    // estilo del marcador tipo TV: top = la fila de arriba del tablero (mismo diseño), tv = banner compacto
    bugStyle: ['tv', 'custom'].includes(x.bugStyle) ? x.bugStyle : 'top',   // custom = diseño TV propio (imagen subida)
    bugLayout: String(x.bugLayout || '').replace(/[^\w-]/g, '').slice(0, 24) };
  for (const [k, [lo, hi]] of Object.entries(SCREEN_LIMITS)) out[k] = Math.round(Math.max(lo, Math.min(hi, Number(x[k] ?? BASE_SCREEN[k]) || BASE_SCREEN[k])));
  // X / Y nunca pasan del máximo real (el marcador no puede salirse): así al restar se mueve de inmediato
  out.bugX = Math.min(out.bugX, Math.round((100 - out.bugW) * 10) / 10);
  out.bugY = Math.min(out.bugY, Math.round((100 - out.bugH) * 10) / 10);
  if (out.bugPos !== 'free') {
    const p = out.bugPos, r1 = (v) => Math.round(v * 10) / 10;
    out.bugX = r1(p[1] === 'l' ? 0 : p[1] === 'r' ? 100 - out.bugW : (100 - out.bugW) / 2);
    out.bugY = r1(p[0] === 't' ? 0 : p[0] === 'b' ? 100 - out.bugH : (100 - out.bugH) / 2);
  }
  return out;
}
// ---- diseños TV propios: una imagen subida (PNG) + dónde va cada dato, en % de la imagen ----
const LAYOUT_FIELDS = {
  hLogo: { x: 0, y: 0, w: 9, h: 100 }, hName: { x: 9, y: 0, w: 16, h: 60, size: 70 },
  hFouls: { x: 9, y: 60, w: 5, h: 40, pre: 'F ' }, hTO: { x: 14, y: 60, w: 5, h: 40, pre: 'TF ' }, hBonus: { x: 19, y: 60, w: 6, h: 40, pre: 'BONUS', color: '#ffd400' },
  hScore: { x: 25, y: 0, w: 11, h: 100, size: 85 }, hPoss: { x: 36, y: 0, w: 2, h: 100, pre: '◀', color: '#ffd400', size: 50 },
  aLogo: { x: 38, y: 0, w: 9, h: 100 }, aName: { x: 47, y: 0, w: 16, h: 60, size: 70 },
  aFouls: { x: 47, y: 60, w: 5, h: 40, pre: 'F ' }, aTO: { x: 52, y: 60, w: 5, h: 40, pre: 'TF ' }, aBonus: { x: 57, y: 60, w: 6, h: 40, pre: 'BONUS', color: '#ffd400' },
  aScore: { x: 63, y: 0, w: 11, h: 100, size: 85 }, aPoss: { x: 74, y: 0, w: 2, h: 100, pre: '▶', color: '#ffd400', size: 50 },
  period: { x: 76, y: 0, w: 7, h: 100, size: 50 }, clock: { x: 83, y: 0, w: 11, h: 100, size: 75 }, shot: { x: 94, y: 0, w: 6, h: 100, size: 75, color: '#ffd400' },
};
function cleanLayout(x) {
  x = x || {};
  const r1 = (v, lo, hi, d) => { const n = Number(v); return Math.round(Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d)) * 10) / 10; };
  const fields = {};
  for (const [k, d] of Object.entries(LAYOUT_FIELDS)) {
    const f = { ...d, ...((x.fields || {})[k] || {}) };
    const w = r1(f.w, 0.5, 100, d.w), h = r1(f.h, 0.5, 100, d.h);
    fields[k] = { on: f.on !== false, x: Math.min(r1(f.x, 0, 100, d.x), 100 - w), y: Math.min(r1(f.y, 0, 100, d.y), 100 - h), w, h,
      size: r1(f.size, 5, 150, d.size || 60),                                   // letra: % del alto de su caja
      color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : (d.color || '#ffffff'),
      align: ['l', 'c', 'r'].includes(f.align) ? f.align : 'c', pre: String(f.pre ?? d.pre ?? '').slice(0, 12), short: !!f.short };
  }
  return { id: String(x.id || 'd' + Date.now().toString(36)).replace(/[^\w-]/g, '').slice(0, 24) || 'd', name: String(x.name || 'Diseño TV').slice(0, 40),
    img: typeof x.img === 'string' && /^\/bg\/[\w.-]+$/.test(x.img) ? x.img : '', ar: r1(x.ar, 0.05, 40, 8), font: String(x.font || '').replace(/[^\w ,'-]/g, '').slice(0, 60), fields };
}

const mainScreen = () => ({ id: 'principal', name: 'Principal', bg: '', layout: 'full', ...BASE_SCREEN });

function defaults() {
  return {
    teams: {
      home: team('PONCE', 'PON', ['G. Torres', 'A. Gonzalez', 'C. De Jesus', 'L. Burgos', 'D. Sanchez']),
      away: team('VILLALBA', 'VIL', ['G. Torres', 'A. Gonzalez', 'C. De Jesus', 'L. Burgos', 'D. Sanchez']),
    },
    period: 1,
    final: false,
    possession: null,                       // 'home' | 'away' | null
    periodScores: { home: [0], away: [0] }, // puntos por periodo
    game: { ms: 600000, running: false },
    shot: { ms: 24000, running: false },
    timer: emptyTimer(),                    // cronómetro de tiempo fuera / descanso
    settings: {
      title: 'ADSCREEN DIGITAL MEDIA',
      periodMs: 600000,
      otMs: 300000,
      linkShot: true,       // el reloj de 24 corre/para junto con el del juego
      shotVisible: true,
      sortByPts: true,      // en pantalla, los jugadores en cancha van de mayor a menor puntos
      shotOffMs: 24000,     // el reloj de 24 se apaga solo cuando al juego le quedan menos de estos ms (0 = nunca)
      bgImage: '',          // imagen de fondo/diseño (PNG 1920x1080) subida desde el panel
      bgOnly: false,        // true = ocultar los colores de las cajas y usar solo la imagen
      // colores de las vistas del centro (Líderes / Comparativa), editables desde el panel
      viewBg: '#050a24',    // fondo
      viewHead: '#0a2fb8',  // franja del título (LÍDERES DEL JUEGO / COMPARATIVA)
      viewTeams: '#0a2fb8', // franja con los nombres de los equipos
      viewLine: '#1b4bff',  // líneas entre filas
      viewLabel: '#9db4ff', // texto de las etiquetas (PUNTOS, REBOTES...)
      viewLead: '#ffd400',  // el valor que va ganando
      viewText: '#ffffff',  // resto del texto
      viewMatch: false,     // true = fondo y franjas del mismo color que la imagen de fondo (se toma solo)
      viewClear: false,     // true = sin fondos (se ve la imagen de fondo / plantilla)
      screens: [mainScreen()],
      bugLayouts: [],            // diseños TV propios (imagen + posición de cada dato)   // pantallas: display.html?p=<id>  (Principal = display.html)
      center: 'black',      // black | transparent | green
      bottom: 'stats',      // cuadro inferior de cada equipo: stats | note
      centerView: 'none',   // none | leaders | compare
      foulBonus: 4,         // BONUS se enciende al llegar a estas faltas de equipo en el periodo (FIBA = 4, NBA = 5)
      otFoulsCarry: false,  // true = en tiempo extra siguen las faltas del 4to (regla FIBA); false = cada periodo empieza en 0
      foulOut: 5,           // faltas personales para eliminar al jugador (FIBA = 5, NBA = 6)
      timeoutMs: 60000,     // tiempo fuera (FIBA = 60 s)
      // tiempos fuera disponibles por equipo (se recargan solos). FIBA: 2 / 3 / 1.  NBA: 7 / 0 / 2
      toFirst: 2,           // al empezar el juego (1ra mitad)
      toSecond: 3,          // al empezar el 3er periodo (0 = siguen los que queden)
      toOT: 1,              // al empezar cada tiempo extra (0 = siguen los que queden)
      breakMs: 120000,      // descanso entre periodos
      halfMs: 900000,       // medio tiempo
      popupAuto: false,     // lanzar rótulo automáticamente al anotar
      popupMs: 4000,
    },
  };
}

function migrate(saved) {
  const d = defaults();
  const s = { ...d, ...saved };
  s.settings = { ...d.settings, ...saved.settings };
  s.settings.screens = (Array.isArray(s.settings.screens) && s.settings.screens.length ? s.settings.screens : [mainScreen()]).map(cleanScreen);
  if (!s.settings.screens.some((x) => x.id === 'principal')) s.settings.screens.unshift(mainScreen());
  s.settings.bugLayouts = (Array.isArray(s.settings.bugLayouts) ? s.settings.bugLayouts : []).map(cleanLayout);
  for (const x of s.settings.screens) if (x.id === 'principal' && !(saved.settings?.screens || []).find((y) => y.id === 'principal')?.layout) x.layout = 'full';
  for (const k of ['home', 'away']) {
    s.teams[k] = { ...d.teams[k], ...(saved.teams || {})[k] };
    s.teams[k].stats = { ...d.teams[k].stats, ...((saved.teams || {})[k] || {}).stats };
  }
  s.periodScores = { ...d.periodScores, ...saved.periodScores };
  s.game = { ...d.game, ...saved.game, running: false };
  s.shot = { ...d.shot, ...saved.shot, running: false };
  s.timer = emptyTimer();
  return s;
}

let S = defaults();
let gameId;
let events = [];
const last = store.loadLast();
if (last) { S = migrate(last.state); gameId = last.id; events = store.listEvents(gameId); }
else gameId = store.newGame({ home: S.teams.home.name, away: S.teams.away.name });

let saveTimer = null;
function persist() {
  store.saveState(gameId, S);
  store.updateGame(gameId, {
    home: S.teams.home.name, away: S.teams.away.name, hs: S.teams.home.score, aw: S.teams.away.score,
    ended: S.final ? Date.now() : null, final: S.final ? S : null,
  });
}
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 500); }

// ---------- Utilidades ----------
const BAD = ['__proto__', 'constructor', 'prototype'];
const ROOTS = ['teams', 'settings'];
const clamp0 = (v) => Math.max(0, v);
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const abbr = (k) => S.teams[k].short || S.teams[k].name;
const periodLabel = (p) => (p <= 4 ? `${p} QT` : p === 5 ? 'OT' : `${p - 4} OT`);

function getParent(p) {
  const k = p.split('.');
  if (!ROOTS.includes(k[0]) || k.some((x) => BAD.includes(x))) return null;
  let o = S;
  for (let i = 0; i < k.length - 1; i++) { o = o[k[i]]; if (o == null || typeof o !== 'object') return null; }
  return [o, k[k.length - 1]];
}

function log(text, team) {
  const ev = { ts: Date.now(), period: S.period, clock: Math.round(S.game.ms), team: team || '', text };
  events.push(ev);
  if (events.length > 3000) events.shift();
  try { store.addEvent(gameId, ev); } catch (_) {}
}

function ensurePeriods() {
  for (const k of ['home', 'away']) {
    const a = (S.periodScores[k] = S.periodScores[k] || []);
    while (a.length < S.period) a.push(0);
  }
}
function addPeriodPts(k, d) {
  ensurePeriods();
  const a = S.periodScores[k]; const i = S.period - 1;
  a[i] = clamp0((a[i] || 0) + d);
}

function startClocks() {
  if (S.game.ms <= 0 || S.final) return;
  S.game.running = true;
  if (S.settings.linkShot && S.shot.ms > 0) S.shot.running = true;
}
function stopClocks() {
  S.game.running = false;
  if (S.settings.linkShot) S.shot.running = false;
}
// juego nuevo: cada equipo empieza con los tiempos de la 1ra mitad
function resetTimeouts() {
  const n = S.settings.toFirst > 0 ? S.settings.toFirst : 2;
  S.teams.home.timeouts = n; S.teams.away.timeouts = n;
}
function startTimer(kind, label, tm, ms) {
  S.timer = { kind, label, team: tm, ms, total: ms, running: true, done: false };
}

// ---------- Deshacer (solo marcador/estadísticas, no relojes) ----------
const undoStack = [];
// El deshacer solo toca marcador, faltas y estadisticas (no tiempos fuera, posesion ni periodo): asi varios operadores no se pisan.
const snapshot = () => JSON.stringify({ teams: S.teams, periodScores: S.periodScores });
function undoable(c) {
  if (c.a === 'set' || c.a === 'inc') return String(c.path).startsWith('teams.');
  return ['playerStat', 'shot', 'loadTeam', 'importRoster'].includes(c.a);
}

// ---------- Rótulos (popup.html) ----------
function popup(o) {
  broadcast({ t: 'popup', l1: String(o.l1 || ''), l2: String(o.l2 || ''), l3: String(o.l3 || ''), team: o.team || '', ms: num(o.ms) || S.settings.popupMs });
}

// ---------- Comandos ----------
function parseRoster(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    let n = '', name = line, pos = '';
    const sep = line.match(/^([^,;\t]+)[,;\t]\s*(.+)$/);
    if (sep && /^\d{1,3}$/.test(sep[1].trim())) { n = sep[1].trim(); name = sep[2].trim(); }
    else { const sp = line.match(/^(\d{1,3})\s+(.+)$/); if (sp) { n = sp[1]; name = sp[2]; } }
    const pp = name.match(/^(.+?)\s*[,;\t]\s*([A-Za-z]{1,3})$/);     // "4, G. Torres, PG"
    if (pp) { name = pp[1].trim(); pos = pp[2].toUpperCase(); }
    out.push({ n, name, pos });
    if (out.length === 12) break;
  }
  return out;
}
function fillRoster(t, list) {
  t.players = Array.from({ length: 12 }, (_, i) => (list[i] ? player(list[i].n || '', list[i].name || '', i < 5, list[i].pos || '') : player()));
  t.stats = defaults().teams.home.stats;
}

// juego nuevo: guarda el actual en el historial (si se jugó algo) y empieza en cero; prep() acomoda equipos antes de abrirlo
function newGame(prep) {
  const played = events.length > 0 || S.teams.home.score || S.teams.away.score;
  if (played) store.updateGame(gameId, { home: S.teams.home.name, away: S.teams.away.name, hs: S.teams.home.score, aw: S.teams.away.score, ended: Date.now(), final: S });
  if (S.scheduleId) { const l = getSched(), g = l.find((x) => x.id === S.scheduleId); if (g) { g.status = 'terminado'; setSched(l); } }
  const keep = S.settings; S = defaults(); S.settings = keep; S.game.ms = keep.periodMs; resetTimeouts();
  if (prep) prep();
  if (played) gameId = store.newGame({ home: S.teams.home.name, away: S.teams.away.name });
  else store.updateGame(gameId, { home: S.teams.home.name, away: S.teams.away.name, hs: 0, aw: 0, ended: null, final: null });
  events = []; undoStack.length = 0;
}

// ---------- juegos programados (fecha, equipos y usuarios asignados) ----------
const getSched = () => { const l = store.getKV('schedule'); return Array.isArray(l) ? l : []; };
const setSched = (l) => { store.setKV('schedule', l); broadcast({ t: 'sched' }); };
// con un juego programado en curso, solo sus usuarios asignados (y Admin) pueden operar; los demás solo miran
function assignedOk(user, c) {
  if (!user || auth.hasRole(user, 'admin')) return true;
  if (c.a === 'scheduleStart') { const g = getSched().find((x) => x.id === num(c.id)); return !!g && g.users.includes(user.id); }
  const g = S.scheduleId && getSched().find((x) => x.id === S.scheduleId);
  return !g || !g.users.length || g.users.includes(user.id);
}
function schedView(g) {
  const live = g.id === S.scheduleId;
  return { ...g, status: live ? (S.final ? 'final' : 'en curso') : g.status, live,
    userNames: g.users.map((id) => { const u = store.getUser(id); return u ? u.name || u.username : '(borrado)'; }) };
}

function run(c) {
  switch (c.a) {
    case 'set': {
      const r = getParent(String(c.path)); if (!r) return false; r[0][r[1]] = c.value;
      const m = String(c.path).match(/^settings\.screens\.(\d+)\./);                       // medidas de pantalla: siempre dentro de rango
      if (m && S.settings.screens[m[1]]) S.settings.screens[m[1]] = cleanScreen(S.settings.screens[m[1]]);
      const ml = String(c.path).match(/^settings\.bugLayouts\.(\d+)\./);
      if (ml && S.settings.bugLayouts[ml[1]]) S.settings.bugLayouts[ml[1]] = cleanLayout(S.settings.bugLayouts[ml[1]]);
      break;
    }
    // ---- diseños TV propios ----
    case 'layoutAdd': {                       // imagen ya subida (/bg/...) + proporción; con fields = importado de un .json
      if (S.settings.bugLayouts.length >= 20) return false;
      const L = cleanLayout({ name: c.name, img: c.img, ar: c.ar, font: c.font, fields: c.fields, id: 'd' + Date.now().toString(36) });
      if (!L.img) return false;
      S.settings.bugLayouts.push(L);
      break;
    }
    case 'layoutDel': {
      const n = S.settings.bugLayouts.length;
      S.settings.bugLayouts = S.settings.bugLayouts.filter((x) => x.id !== c.id);
      if (S.settings.bugLayouts.length === n) return false;
      for (const x of S.settings.screens) if (x.bugLayout === c.id) { x.bugLayout = ''; if (x.bugStyle === 'custom') x.bugStyle = 'tv'; }
      break;
    }
    // ---- pantallas ----
    case 'screenAdd': {
      if (S.settings.screens.length >= 12) return false;
      const w = num(c.w) || 1920, h = num(c.h) || 1080;
      // marcador tipo TV por defecto: banner delgado abajo (pantallas anchas) o franja arriba (pósters verticales)
      const bug = w / h >= 1.3 ? { bugPos: 'bc', bugW: 50, bugH: 10 } : { bugPos: 'tc', bugW: 100, bugH: 60 };   // estilo: fila del tablero
      S.settings.screens.push(cleanScreen({ id: 'p' + Date.now().toString(36), name: String(c.name || 'Pantalla ' + (S.settings.screens.length + 1)), ...scaledScreen(w, h), ...bug }));
      break;
    }
    case 'screenDel': {
      if (c.id === 'principal') return false;
      const n = S.settings.screens.length;
      S.settings.screens = S.settings.screens.filter((x) => x.id !== c.id);
      if (S.settings.screens.length === n) return false;
      break;
    }
    case 'screenFit': {                       // recalcula las proporciones a partir del ancho y alto
      const i = S.settings.screens.findIndex((x) => x.id === c.id); if (i < 0) return false;
      const x = S.settings.screens[i];
      S.settings.screens[i] = cleanScreen({ ...x, ...(x.id === 'principal' && x.w === 1920 && x.h === 1080 ? BASE_SCREEN : scaledScreen(x.w, x.h)) });
      break;
    }
    case 'inc': {
      const r = getParent(String(c.path));
      if (!r || typeof r[0][r[1]] !== 'number') return false;
      r[0][r[1]] = clamp0(r[0][r[1]] + num(c.by));
      break;
    }
    case 'playerStat': {
      const t = S.teams[c.team]; const p = t && t.players[c.i];
      if (!p || !['pts', 'reb', 'ast', 'pf'].includes(c.stat)) return false;
      const before = p[c.stat];
      p[c.stat] = clamp0(before + num(c.by));
      const dd = p[c.stat] - before;
      if (c.stat === 'pts') t.score = clamp0(t.score + dd);
      if (c.stat === 'pf') t.fouls = clamp0(t.fouls + dd);
      const who = `${p.name || '#' + p.n} (${abbr(c.team)})`;
      const lab = { pts: 'puntos', reb: 'rebote', ast: 'asistencia', pf: 'falta' }[c.stat];
      if (dd > 0) {
        log(c.stat === 'pts' ? `${who} +${dd} ${lab}` : c.stat === 'pf' ? `${who} falta personal (${p.pf})` : `${who} ${lab}`, c.team);
        if (c.stat === 'pts' && S.settings.popupAuto) popup({ l1: '+' + dd, l2: (p.name || '').toUpperCase(), l3: t.name, team: c.team });
      } else if (dd < 0) log(`Correccion: ${who} ${dd} ${lab}`, c.team);
      break;
    }
    case 'shot': {
      const t = S.teams[c.team]; const k = c.k;
      if (!t || !['p2', 'p3', 'ft'].includes(k)) return false;
      const m = k + 'm', a = k + 'a';
      const made = c.made === true || c.made === 'true';
      const undo = c.undo === true || c.undo === 'true';
      const st = t.stats;
      if (!undo) { st[a] += 1; if (made) st[m] += 1; }
      else if (made) { if (st[m] > 0) { st[m] -= 1; st[a] = clamp0(st[a] - 1); } }
      else if (st[a] > st[m]) st[a] -= 1;
      if (!undo) log(`${abbr(c.team)} ${{ p2: 'tiro de 2', p3: 'triple', ft: 'tiro libre' }[k]} ${made ? 'anotado' : 'fallado'}`, c.team);
      break;
    }
    // ---- posesión ----
    case 'possession': S.possession = c.team === 'home' || c.team === 'away' ? c.team : null; break;
    case 'possessionToggle': S.possession = S.possession === 'home' ? 'away' : 'home'; break;
    // ---- reloj del juego ----
    case 'gameToggle': S.game.running ? stopClocks() : startClocks(); break;
    case 'gameStart': startClocks(); break;
    case 'gameStop': stopClocks(); break;
    case 'gameSet': S.game.ms = clamp0(num(c.ms)); break;
    case 'gameAdjust': S.game.ms = clamp0(S.game.ms + num(c.ms)); break;
    // ---- reloj de 24 ----
    case 'shotReset':
      S.shot.ms = num(c.ms) || 24000;
      S.shot.running = S.game.running && S.settings.linkShot;
      break;
    case 'shotToggle': S.shot.running = !S.shot.running; break;
    case 'shotStop': S.shot.running = false; break;
    case 'shotSet': S.shot.ms = clamp0(num(c.ms)); break;
    case 'shotAdjust': S.shot.ms = clamp0(S.shot.ms + num(c.ms)); break;
    // ---- tiempos fuera / descansos ----
    case 'timeoutStart': {
      const t = S.teams[c.team];
      if (!t || t.timeouts <= 0) return false;
      t.timeouts -= 1; stopClocks();
      // duración: la del comando (ms, para Stream Deck) o la elegida en el panel (15/30/60/75/90 s u otra)
      startTimer('timeout', 'TIEMPO FUERA', c.team, num(c.ms) > 0 ? num(c.ms) : S.settings.timeoutMs);
      log(`Tiempo fuera ${abbr(c.team)}`, c.team);
      break;
    }
    case 'breakStart': {
      stopClocks();
      if (c.kind === 'half') startTimer('break', 'MEDIO TIEMPO', null, S.settings.halfMs);
      else startTimer('break', 'DESCANSO', null, num(c.ms) || S.settings.breakMs);
      break;
    }
    case 'timerToggle': if (S.timer.kind && S.timer.ms > 0) S.timer.running = !S.timer.running; break;
    case 'timerAdjust': if (S.timer.kind) { S.timer.ms = clamp0(S.timer.ms + num(c.ms)); S.timer.total = Math.max(S.timer.total, S.timer.ms); } break;
    case 'timerStop':
      if ((c.refund === true || c.refund === 'true') && S.timer.kind === 'timeout' && S.timer.team) S.teams[S.timer.team].timeouts += 1;
      S.timer = emptyTimer();
      break;
    // ---- periodos / final ----
    case 'periodNext':
      S.period += 1;
      S.game.ms = S.period > 4 ? S.settings.otMs : S.settings.periodMs;
      S.shot.ms = 24000; S.game.running = false; S.shot.running = false;
      // faltas de equipo (y BONUS) a 0 en cada periodo nuevo; opcional FIBA: en el OT siguen las del 4to
      if (S.period <= 4 || !S.settings.otFoulsCarry) { S.teams.home.fouls = 0; S.teams.away.fouls = 0; }
      // tiempos fuera: recarga al empezar la 2da mitad y cada tiempo extra
      { const n = S.period === 3 ? S.settings.toSecond : S.period > 4 ? S.settings.toOT : 0;
        if (n > 0) { S.teams.home.timeouts = n; S.teams.away.timeouts = n; } }
      ensurePeriods(); undoStack.length = 0;
      log(`Inicio ${periodLabel(S.period)}`);
      break;
    case 'periodPrev': S.period = Math.max(1, S.period - 1); break;
    case 'final': {
      S.final = c.value === undefined ? !S.final : (c.value === true || c.value === 'true');
      if (S.final) { stopClocks(); log(`FINAL ${S.teams.home.name} ${S.teams.home.score} - ${S.teams.away.score} ${S.teams.away.name}`); }
      persist();
      break;
    }
    case 'resetGame': newGame(); break;
    // empezar un juego programado: guarda el actual, carga los equipos de la plantilla y queda ligado a la programación
    case 'scheduleStart': {
      const list = getSched(), g = list.find((x) => x.id === num(c.id));
      if (!g || g.status === 'terminado' || S.scheduleId === g.id) return false;
      newGame(() => {
        for (const [side, tid, nm] of [['home', g.homeId, g.home], ['away', g.awayId, g.away]]) {
          const t = S.teams[side], r = tid && store.getTeam(tid);
          if (r) {
            t.name = r.name; t.short = r.short || ''; t.logo = r.logo || '';
            t.players = Array.from({ length: 12 }, (_, i) => { const p = r.players[i]; return p ? player(p.n || '', p.name || '', !!p.on, p.pos || '') : player(); });
          } else { t.name = nm; t.short = nm.slice(0, 3).toUpperCase(); t.logo = ''; t.players = Array.from({ length: 12 }, () => player()); }
          t.stats = defaults().teams.home.stats;
        }
        S.scheduleId = g.id;
      });
      const l2 = getSched(), g2 = l2.find((x) => x.id === g.id); g2.status = 'en curso'; g2.gameId = gameId; setSched(l2);
      log(`Juego programado: ${S.teams.home.name} vs ${S.teams.away.name}`);
      break;
    }
    case 'undo': {
      const snap = undoStack.pop();
      if (!snap) return false;
      const o = JSON.parse(snap);
      for (const k of ['home', 'away']) { const keep = S.teams[k].timeouts; S.teams[k] = o.teams[k]; S.teams[k].timeouts = keep; }
      S.periodScores = o.periodScores;
      log('Deshacer ultima accion');
      break;
    }
    // ---- franja roja (prueba) y rótulos ----
    case 'horn': broadcast({ t: 'horn', k: c.k || 'game' }); break;
    case 'popup': popup(c); break;
    case 'popupHide': broadcast({ t: 'popupHide' }); break;
    // ---- plantillas (base de datos) ----
    case 'saveTeam': {
      const t = S.teams[c.team]; if (!t || !t.name) return false;
      store.saveTeam({ name: t.name, short: t.short, logo: t.logo, players: t.players.map((p) => ({ n: p.n, name: p.name, pos: p.pos || '', on: p.on })) });
      broadcast({ t: 'lists' });
      break;
    }
    case 'loadTeam': {
      const t = S.teams[c.team]; const r = store.getTeam(num(c.id));
      if (!t || !r) return false;
      t.name = r.name; t.short = r.short || ''; t.logo = r.logo || '';
      t.players = Array.from({ length: 12 }, (_, i) => { const p = r.players[i]; return p ? player(p.n || '', p.name || '', !!p.on, p.pos || '') : player(); });
      t.stats = defaults().teams.home.stats;
      break;
    }
    case 'deleteTeam': store.deleteTeam(num(c.id)); broadcast({ t: 'lists' }); break;
    case 'importRoster': {
      const t = S.teams[c.team]; if (!t) return false;
      const list = parseRoster(c.text); if (!list.length) return false;
      fillRoster(t, list);
      break;
    }
    default: return false;
  }
  return true;
}

function apply(c) {
  const before = { home: S.teams.home.score, away: S.teams.away.score };
  const snap = undoable(c);
  if (snap) { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); }
  const ok = run(c);
  if (!ok) { if (snap) undoStack.pop(); return false; }
  if (c.a !== 'resetGame' && c.a !== 'undo') {
    for (const k of ['home', 'away']) { const dd = S.teams[k].score - before[k]; if (dd) addPeriodPts(k, dd); }
  }
  return true;
}

// ---------- WebSocket mínimo ----------
const clients = new Set();

function frame(str) {
  const p = Buffer.from(str); let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}
function send(sock, obj) { if (!sock.destroyed) sock.write(frame(JSON.stringify(obj))); }
function broadcast(obj) { const f = frame(JSON.stringify(obj)); for (const s of clients) if (!s.destroyed) s.write(f); }

const stateMsg = () => ({ t: 'state', s: S, label: periodLabel(S.period) });
const clockMsg = () => ({ t: 'clock', g: S.game.ms, s: S.shot.ms, gr: S.game.running, sr: S.shot.running, tm: S.timer.ms, tr: S.timer.running });
function broadcastState() { broadcast(stateMsg()); saveSoon(); }

function onData(sock, chunk) {
  sock.buf = Buffer.concat([sock.buf || Buffer.alloc(0), chunk]);
  for (;;) {
    const b = sock.buf;
    if (b.length < 2) return;
    const op = b[0] & 15; const masked = (b[1] & 128) !== 0;
    let len = b[1] & 127; let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) return;
    let payload = b.slice(off + (masked ? 4 : 0), total);
    if (masked) {
      const m = b.slice(off, off + 4);
      payload = Buffer.from(payload.map((x, i) => x ^ m[i % 4]));
    }
    sock.buf = b.slice(total);
    if (op === 8) { sock.end(); return; }
    if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
    if (op === 1) {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.t === 'cmd') {
          const user = userFromToken(sock.token);      // se revisa en cada comando: si desactivan al usuario, deja de poder
          if (!user) send(sock, { t: 'err', msg: 'Tu sesión terminó. Vuelve a entrar.', login: true });
          else if (user.mustChange) send(sock, { t: 'err', msg: 'Primero cambia tu contraseña.' });
          else if (!auth.canRun(user, msg)) send(sock, { t: 'err', msg: 'No tienes permiso para esa acción (' + auth.rolesFor(msg).map((r) => auth.ROLES[r]).join(' / ') + ').' });
          else if (!assignedOk(user, msg)) send(sock, { t: 'err', msg: 'No estás asignado a este juego: solo puedes mirar.' });
          else if (apply(msg)) { auditCmd(user, msg); broadcastState(); }
        }
      } catch (_) {}
    }
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};
const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
};

const PROTECTED_PAGES = ['/control.html', '/admin.html'];   // piden usuario; display.html y popup.html quedan abiertas para OBS

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let me = userFromReq(req);
  const deny = (code = 401, error = 'Inicia sesión') => json(res, { ok: false, error }, code);

  // ---------- login / sesión ----------
  if (url.pathname === '/api/login' && req.method === 'POST') {
    return readBody(req, (b) => {
      const u = store.getUserByName(String(b.username || '').trim());
      if (!u || !u.active || !auth.checkPassword(b.password, u.pass)) {
        store.audit(String(b.username || '').slice(0, 40), 'loginFallido', '');
        return setTimeout(() => deny(401, 'Usuario o contraseña incorrectos'), 400);
      }
      const token = auth.newToken();
      store.createSession(token, u.id, Date.now() + auth.SESSION_DAYS * 864e5);
      store.touchLogin(u.id); store.audit(u.username, 'login', '');
      res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_DAYS * 86400));
      json(res, { ok: true, user: auth.publicUser(u) });
    });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const tk = auth.readCookie(req); if (tk) store.deleteSession(tk);
    res.setHeader('Set-Cookie', auth.sessionCookie('', 0));
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/me') return me ? json(res, { ok: true, user: auth.publicUser(me), roles: auth.ROLES }) : deny();
  if (url.pathname === '/api/password' && req.method === 'POST') {
    if (!me) return deny();
    return readBody(req, (b) => {
      if (!auth.checkPassword(b.old, me.pass)) return deny(400, 'La contraseña actual no es correcta');
      if (String(b.new || '').length < 6) return deny(400, 'La nueva contraseña debe tener al menos 6 caracteres');
      store.setPassword(me.id, auth.hashPassword(b.new), false); store.audit(me.username, 'cambioContraseña', '');
      json(res, { ok: true });
    });
  }

  // ---------- usuarios (solo admin) ----------
  if (url.pathname.startsWith('/api/users') || url.pathname === '/api/audit' || url.pathname === '/api/apikey') {
    if (!me) return deny();
    if (!auth.hasRole(me, 'admin') || me.mustChange) return deny(403, 'Solo un administrador');
    if (url.pathname === '/api/audit') return json(res, store.listAudit(Math.min(1000, num(url.searchParams.get('limit')) || 300)));
    if (url.pathname === '/api/apikey') {
      if (req.method === 'POST') { store.setKV('apiKey', auth.newToken().slice(0, 24)); store.audit(me.username, 'nuevaClaveStreamDeck', ''); }
      return json(res, { key: store.getKV('apiKey') });
    }
    if (req.method === 'GET') return json(res, { users: store.listUsers().map(auth.publicUser), roles: auth.ROLES });
    const id = num(url.pathname.split('/')[3]);
    const admins = () => store.listUsers().filter((u) => u.active && u.roles.includes('admin'));
    return readBody(req, (b) => {
      if (req.method === 'POST' && !id) {                                     // crear
        const username = String(b.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) return deny(400, 'Usuario: 3 a 30 letras, números, punto, guion');
        if (store.getUserByName(username)) return deny(400, 'Ese usuario ya existe');
        if (String(b.password || '').length < 6) return deny(400, 'La contraseña temporal debe tener al menos 6 caracteres');
        store.createUser({ username, name: String(b.name || '').slice(0, 60), pass: auth.hashPassword(b.password), roles: auth.cleanRoles(b.roles), mustChange: true });
        store.audit(me.username, 'crearUsuario', username);
        return json(res, { ok: true });
      }
      const u = id && store.getUser(id);
      if (!u) return deny(404, 'Usuario no encontrado');
      const lastAdmin = u.roles.includes('admin') && admins().length <= 1 && admins()[0]?.id === u.id;
      if (req.method === 'DELETE') {
        if (u.id === me.id) return deny(400, 'No puedes borrar tu propio usuario');
        if (lastAdmin) return deny(400, 'Debe quedar al menos un administrador activo');
        store.deleteUser(u.id); store.audit(me.username, 'borrarUsuario', u.username);
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && b.resetPassword) {                         // contraseña temporal nueva
        if (String(b.resetPassword).length < 6) return deny(400, 'La contraseña temporal debe tener al menos 6 caracteres');
        store.setPassword(u.id, auth.hashPassword(b.resetPassword), true); store.deleteUserSessions(u.id);
        store.audit(me.username, 'resetContraseña', u.username);
        return json(res, { ok: true });
      }
      if (req.method === 'POST') {                                            // editar nombre / roles / activo
        const roles = b.roles ? auth.cleanRoles(b.roles) : u.roles;
        const active = b.active != null ? !!b.active : u.active;
        if (lastAdmin && (!roles.includes('admin') || !active)) return deny(400, 'Debe quedar al menos un administrador activo');
        store.updateUser(u.id, { name: b.name != null ? String(b.name).slice(0, 60) : u.name, roles, active });
        if (!active) store.deleteUserSessions(u.id);
        store.audit(me.username, 'editarUsuario', `${u.username} ${roles.join(',')}${active ? '' : ' (desactivado)'}`);
        return json(res, { ok: true });
      }
      deny(405, 'Método no permitido');
    });
  }

  // ---------- páginas protegidas ----------
  if (PROTECTED_PAGES.includes(url.pathname) || url.pathname === '/') {
    if (!me) { res.writeHead(302, { Location: '/login.html?next=' + encodeURIComponent(url.pathname === '/' ? '/control.html' : url.pathname + url.search) }); return res.end(); }
    if (me.mustChange) { res.writeHead(302, { Location: '/login.html?change=1' }); return res.end(); }
    if (url.pathname === '/admin.html' && !auth.hasRole(me, 'admin') && !auth.hasRole(me, 'historial')) { res.writeHead(302, { Location: '/control.html' }); return res.end(); }
  }
  if (me && me.mustChange) me = null;              // con contraseña temporal solo puede cambiarla; nada más

  // API para Stream Deck / Companion / Resolume / mesa de control por hardware
  if (url.pathname === '/api/state') return json(res, S);                    // solo lectura, abierta
  if (url.pathname === '/api/teams') return me ? json(res, store.listTeams()) : deny();
  // juegos programados: el admin los crea; cada usuario ve los suyos (el admin, todos)
  const sm = url.pathname.match(/^\/api\/schedule(?:\/(\d+))?$/);
  if (sm) {
    if (!me) return deny();
    const admin = auth.hasRole(me, 'admin');
    if (req.method === 'GET') {
      const list = getSched().filter((g) => admin || g.users.includes(me.id)).map(schedView).sort((a, b) => a.ts - b.ts);
      return json(res, { list, current: S.scheduleId || null, me: me.id });
    }
    if (!admin) return deny(403, 'Solo un administrador programa juegos');
    const id = num(sm[1]);
    if (req.method === 'DELETE') {
      if (id === S.scheduleId) return deny(400, 'Ese juego está en curso');
      const l = getSched(); if (!l.some((x) => x.id === id)) return deny(404, 'No encontrado');
      setSched(l.filter((x) => x.id !== id)); store.audit(me.username, 'borrarProgramado', '#' + id);
      return json(res, { ok: true });
    }
    if (req.method !== 'POST') return deny(405, 'Método no permitido');
    return readBody(req, (b) => {
      const ts = num(b.ts);
      if (!(ts > 0)) return deny(400, 'Falta la fecha y hora');
      const side = (tid, name) => { const r = num(tid) && store.getTeam(num(tid)); return r ? { id: r.id, name: r.name } : { id: 0, name: String(name || '').trim().slice(0, 40) }; };
      const H = side(b.homeId, b.home), A = side(b.awayId, b.away);
      if (!H.name || !A.name) return deny(400, 'Faltan los equipos');
      const users = [...new Set((Array.isArray(b.users) ? b.users : []).map(num).filter((u) => store.getUser(u)))];
      const l = getSched();
      const f = { ts, homeId: H.id, home: H.name, awayId: A.id, away: A.name, users, notes: String(b.notes || '').slice(0, 200) };
      if (id) {
        const g = l.find((x) => x.id === id); if (!g) return deny(404, 'No encontrado');
        Object.assign(g, f);
      } else l.push({ id: l.reduce((m, x) => Math.max(m, x.id), 0) + 1, status: 'programado', gameId: null, created: Date.now(), by: me.username, ...f });
      setSched(l.slice(-100));
      store.audit(me.username, id ? 'editarProgramado' : 'programarJuego', `${H.name} vs ${A.name} ${new Date(ts).toISOString()}`);
      json(res, { ok: true });
    });
  }
  if (url.pathname === '/api/games') return me ? json(res, store.listGames().map((g) => ({ ...g, current: g.id === gameId }))) : deny();
  // historial: corregir o borrar un juego terminado (permiso "Editar juegos del historial")
  const gm = url.pathname.match(/^\/api\/games\/(\d+)$/);
  if (gm) {
    if (!me) return deny();
    if (!auth.hasRole(me, 'historial')) return deny(403, 'No tienes permiso para editar el historial');
    const id = num(gm[1]);
    if (id === gameId) return deny(400, 'Ese es el juego en curso: se cambia desde el panel de control');
    if (req.method === 'DELETE') {
      if (!store.deleteGame(id)) return deny(404, 'Juego no encontrado');
      store.audit(me.username, 'borrarJuego', '#' + id); broadcast({ t: 'lists' });
      return json(res, { ok: true });
    }
    if (req.method !== 'POST') return deny(405, 'Método no permitido');
    return readBody(req, (b) => {
      const f = { home: String(b.home || '').trim().slice(0, 40), away: String(b.away || '').trim().slice(0, 40), hs: Math.max(0, Math.min(999, num(b.hs))), aw: Math.max(0, Math.min(999, num(b.aw))) };
      if (!f.home || !f.away) return deny(400, 'Faltan los nombres de los equipos');
      if (!store.editGame(id, f)) return deny(404, 'Juego no encontrado');
      store.audit(me.username, 'editarJuego', `#${id} ${f.home} ${f.hs} - ${f.aw} ${f.away}`); broadcast({ t: 'lists' });
      json(res, { ok: true });
    });
  }
  // dashboard del administrador: juegos activos (baloncesto y béisbol), quién está conectado, respaldos
  if (url.pathname === '/api/dashboard') {
    if (!me) return deny();
    if (!auth.hasRole(me, 'admin')) return deny(403, 'Solo un administrador');
    return dashboard().then((d) => json(res, d), (e) => json(res, { error: e.message }, 500));
  }
  if (url.pathname === '/api/cmd') {
    // con sesión (rol revisado) o con la clave de Stream Deck: /api/cmd?key=...&a=gameToggle
    const keyOk = url.searchParams.get('key') && url.searchParams.get('key') === store.getKV('apiKey');
    if (!me && !keyOk) return deny(401, 'Falta la clave (key) o iniciar sesión');
    const finish = (cmd) => {
      delete cmd.key;
      if (me && !keyOk && !auth.canRun(me, cmd)) return deny(403, 'No tienes permiso para esa acción');
      if (me && !keyOk && !assignedOk(me, cmd)) return deny(403, 'No estás asignado a este juego');
      const ok = apply(cmd); if (ok) { auditCmd(keyOk ? null : me, cmd); broadcastState(); }
      json(res, { ok }, ok ? 200 : 400);
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      return req.on('end', () => { try { finish(JSON.parse(body)); } catch (_) { finish({}); } });
    }
    return finish(Object.fromEntries(url.searchParams)); // GET /api/cmd?a=gameToggle
  }

  // Subir logos / fondo desde el panel: POST /api/upload?kind=logo|bg&ext=png&team=home  (cuerpo = archivo)
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const upKind = url.searchParams.get('kind');
    if (!me || !auth.hasRole(me, upKind === 'logo' ? 'anotacion' : 'pantallas')) return deny(403, 'No tienes permiso para subir ese archivo');
    const dir = { logo: 'logos', bg: 'bg' }[url.searchParams.get('kind')];
    const ext = String(url.searchParams.get('ext') || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!dir || !['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'].includes(ext)) return json(res, { ok: false, error: 'tipo no permitido' }, 400);
    const chunks = []; let size = 0, dead = false;
    req.on('data', (d) => { size += d.length; if (size > 12e6) { dead = true; json(res, { ok: false, error: 'archivo mayor a 12 MB' }, 413); req.destroy(); } else chunks.push(d); });
    return req.on('end', () => {
      if (dead) return;
      const tag = String(url.searchParams.get('team') || url.searchParams.get('kind')).replace(/[^a-z]/gi, '').slice(0, 12) || 'img';
      const name = `${tag}-${Date.now()}.${ext}`;
      try {
        fs.mkdirSync(path.join(PUBLIC, dir), { recursive: true });
        fs.writeFileSync(path.join(PUBLIC, dir, name), Buffer.concat(chunks));
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
      json(res, { ok: true, path: `/${dir}/${name}` });
    });
  }

  // Resumen del juego en PDF (juego actual o uno del historial: /report.pdf?game=3)
  if (url.pathname === '/report.pdf') {
    if (!me) { res.writeHead(302, { Location: '/login.html?next=' + encodeURIComponent(url.pathname + url.search) }); return res.end(); }
    const gid = num(url.searchParams.get('game')) || gameId;
    let st = S, ev = events, date = Date.now();
    if (gid !== gameId) {
      const g = store.getGame(gid);
      if (!g || !g.final) { res.writeHead(404); return res.end('Juego no encontrado'); }
      st = migrate(g.final); ev = store.listEvents(gid); date = g.ended || g.started;
    }
    const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let buf;
    try { buf = buildReport(st, ev, { date }); } catch (e) { res.writeHead(500); return res.end('Error generando PDF: ' + e.message); }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${url.searchParams.get('dl') ? 'attachment' : 'inline'}; filename="resumen-${safe(st.teams.home.name)}-vs-${safe(st.teams.away.name)}-${gid}.pdf"`,
    });
    return res.end(buf);
  }

  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/control.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  sock.token = auth.readCookie(req);                // sin sesión = solo lectura (pantallas de OBS)
  clients.add(sock);
  sock.on('data', (d) => onData(sock, d));
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
  send(sock, stateMsg());
});

// ---------- dashboard ----------
const BASEBALL_WS = process.env.BASEBALL_WS || 'ws://127.0.0.1:3001/ws';   // scoreboard de béisbol en el mismo servidor
const BASEBALL_PORT = (BASEBALL_WS.match(/:(\d+)\//) || [])[1] || '3001';
// lee el estado del béisbol como lo hace su pantalla (solo lectura) y cierra
function baseballStatus() {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') return resolve({ ok: false, why: 'Node sin WebSocket' });
    let done = false, ws;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch (_) {} resolve(v); };
    const t = setTimeout(() => end({ ok: false, why: 'no responde' }), 2000);
    try { ws = new WebSocket(BASEBALL_WS); } catch (e) { return end({ ok: false, why: e.message }); }
    ws.onerror = () => end({ ok: false, why: 'no está corriendo' });
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t !== 'state' || !m.game) return;
      const g = m.game, runs = (x) => (x.runs || []).reduce((a, b) => a + (Number(b) || 0), 0);
      const started = (g.away.runs || []).length > 0 || (g.home.runs || []).length > 0 || g.inning > 1 || g.outs > 0 || g.balls > 0 || g.strikes > 0;
      end({ ok: true, away: { name: g.away.name, score: runs(g.away), h: g.away.h, e: g.away.e }, home: { name: g.home.name, score: runs(g.home), h: g.home.h, e: g.home.e },
        inning: g.inning, half: g.half, outs: g.outs, balls: g.balls, strikes: g.strikes, final: !!g.final, started, startedAt: g.startedAt || null, port: BASEBALL_PORT });
    };
  });
}
function backupsInfo() {
  const dir = path.join(os.homedir(), 'respaldos-scoreboard');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, ts: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.ts - a.ts);
    let log = ''; try { log = fs.readFileSync(path.join(dir, 'respaldo.log'), 'utf8').trim().split('\n').slice(-6).join('\n'); } catch (_) {}
    return { ok: true, dir, count: files.length, last: files.slice(0, 6), log };
  } catch (_) { return { ok: false, dir }; }
}
async function dashboard() {
  // conectados: pantallas (sin sesión) y usuarios con sesión
  let screens = 0; const users = new Map();
  for (const s of clients) {
    const u = s.token ? userFromToken(s.token) : null;
    if (u) users.set(u.id, { name: u.name || u.username, username: u.username, roles: u.roles, n: (users.get(u.id)?.n || 0) + 1 }); else screens++;
  }
  const T = S.teams, started = !S.final && (events.length > 0 || T.home.score > 0 || T.away.score > 0 || S.game.running);
  const basket = { ok: true, id: gameId, home: { name: T.home.name, score: T.home.score, fouls: T.home.fouls, logo: T.home.logo }, away: { name: T.away.name, score: T.away.score, fouls: T.away.fouls, logo: T.away.logo },
    period: periodLabel(S.period), clockMs: S.game.ms, running: S.game.running, final: !!S.final, started, plays: events.length, screens: S.settings.screens.length };
  const baseball = await baseballStatus();
  const active = [basket, baseball].filter((g) => g.ok && g.started && !g.final).length;
  return { now: Date.now(), active, basket, baseball, online: { screens, users: [...users.values()] }, backups: backupsInfo(),
    totals: { users: store.listUsers().length, games: store.listGames().length } };
}

// ---------- Relojes (el servidor es la única fuente de tiempo) ----------
let lastTick = Date.now(); let lastClock = 0;
setInterval(() => {
  const now = Date.now(); const dt = now - lastTick; lastTick = now;
  if (S.game.running) S.game.ms = Math.max(0, S.game.ms - dt);
  const shotOff = S.settings.shotOffMs > 0 && S.game.ms < S.settings.shotOffMs;   // menos de 24 s de juego: reloj de 24 apagado
  if (S.shot.running && !shotOff) S.shot.ms = Math.max(0, S.shot.ms - dt);
  if (S.timer.running) S.timer.ms = Math.max(0, S.timer.ms - dt);

  let changed = false;
  if (S.game.running && S.game.ms === 0) {
    S.game.running = false; S.shot.running = false; changed = true;
    log(`Fin de ${periodLabel(S.period)}`);
    broadcast({ t: 'horn', k: 'game' });
  } else if (S.shot.running && !shotOff && S.shot.ms === 0) {
    S.shot.running = false; if (S.settings.linkShot) S.game.running = false;
    changed = true; log('Violacion de 24 segundos');
    broadcast({ t: 'horn', k: 'shot' });
  }
  if (S.timer.running && S.timer.ms === 0) {
    S.timer.running = false; S.timer.done = true; changed = true;
    broadcast({ t: 'horn', k: 'timer' });
    setTimeout(() => { if (S.timer.done) { S.timer = emptyTimer(); broadcastState(); } }, 5000);
  }
  if (changed) broadcastState();
  else if ((S.game.running || S.shot.running || S.timer.running) && now - lastClock >= 100) { lastClock = now; broadcast(clockMsg()); }
}, 20);
setInterval(saveSoon, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nScoreboard corriendo (almacenamiento: ${store.kind}). Abre estas direcciones:\n`);
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  for (const ip of ['localhost', ...ips]) {
    console.log(`  Control (mesa/operador): http://${ip}:${PORT}/control.html   (Usuarios: /admin.html)`);
    console.log(`  Pantalla (OBS):          http://${ip}:${PORT}/display.html`);
    console.log(`  Rotulos (OBS):           http://${ip}:${PORT}/popup.html\n`);
  }
});

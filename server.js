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

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');

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
      viewClear: false,     // true = sin fondos (se ve la imagen de fondo / plantilla)
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

function run(c) {
  switch (c.a) {
    case 'set': { const r = getParent(String(c.path)); if (!r) return false; r[0][r[1]] = c.value; break; }
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
    case 'resetGame': {
      if (events.length > 0 || S.teams.home.score || S.teams.away.score) {
        store.updateGame(gameId, {
          home: S.teams.home.name, away: S.teams.away.name, hs: S.teams.home.score, aw: S.teams.away.score, ended: Date.now(), final: S,
        });
        const keep = S.settings; S = defaults(); S.settings = keep; S.game.ms = keep.periodMs; resetTimeouts();
        gameId = store.newGame({ home: S.teams.home.name, away: S.teams.away.name });
      } else { const keep = S.settings; S = defaults(); S.settings = keep; S.game.ms = keep.periodMs; resetTimeouts(); }
      events = []; undoStack.length = 0;
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
        if (msg.t === 'cmd' && apply(msg)) broadcastState();
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // API para Stream Deck / Companion / Resolume / mesa de control por hardware
  if (url.pathname === '/api/state') return json(res, S);
  if (url.pathname === '/api/teams') return json(res, store.listTeams());
  if (url.pathname === '/api/games') return json(res, store.listGames());
  if (url.pathname === '/api/cmd') {
    const finish = (cmd) => {
      const ok = apply(cmd); if (ok) broadcastState();
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
  clients.add(sock);
  sock.on('data', (d) => onData(sock, d));
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
  send(sock, stateMsg());
});

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
    console.log(`  Control (mesa/operador): http://${ip}:${PORT}/control.html`);
    console.log(`  Pantalla (OBS):          http://${ip}:${PORT}/display.html`);
    console.log(`  Rotulos (OBS):           http://${ip}:${PORT}/popup.html\n`);
  }
});

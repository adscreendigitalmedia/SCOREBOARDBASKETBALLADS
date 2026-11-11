// db.js - almacenamiento: SQLite integrado de Node (node:sqlite, Node 22.13+) con respaldo automático a JSON.
// Guarda: estado del juego en curso, equipos/plantillas, historial de juegos y jugada a jugada.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'scoreboard.db');
const JSON_FILE = path.join(__dirname, 'data.json');

function openSqlite() {
  const orig = process.emitWarning;
  try {
    process.emitWarning = function (w, ...a) {            // silencia el aviso "experimental" de SQLite
      const msg = typeof w === 'string' ? w : (w && w.message) || '';
      if (/sqlite/i.test(msg)) return;
      return orig.call(process, w, ...a);
    };
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(DB_FILE);
  } catch (_) {
    return null;
  } finally {
    process.emitWarning = orig;
  }
}

// ---------------- SQLite ----------------
function sqliteStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY, name TEXT UNIQUE, short TEXT, logo TEXT, players TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY, started INTEGER, ended INTEGER, home TEXT, away TEXT, hs INTEGER, aw INTEGER, final TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, game_id INTEGER, ts INTEGER, period INTEGER, clock_ms INTEGER, team TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS ev_game ON events(game_id);
    CREATE TABLE IF NOT EXISTS snapshots(game_id INTEGER PRIMARY KEY, state TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, name TEXT, pass TEXT, roles TEXT,
      active INTEGER DEFAULT 1, must_change INTEGER DEFAULT 0, created INTEGER, last_login INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, username TEXT, action TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
  `);
  const userRow = (r) => (r ? { id: r.id, username: r.username, name: r.name || '', pass: r.pass, roles: JSON.parse(r.roles || '[]'),
    active: !!r.active, mustChange: !!r.must_change, created: r.created, lastLogin: r.last_login } : null);
  const q = (sql) => db.prepare(sql);
  const plain = (r) => (r ? { ...r } : r);
  return {
    kind: 'sqlite',
    saveState(id, state) {
      q('INSERT INTO snapshots(game_id,state,updated) VALUES(?,?,?) ON CONFLICT(game_id) DO UPDATE SET state=excluded.state, updated=excluded.updated')
        .run(id, JSON.stringify(state), Date.now());
    },
    loadLast() {
      const r = q('SELECT game_id, state FROM snapshots ORDER BY updated DESC LIMIT 1').get();
      return r ? { id: r.game_id, state: JSON.parse(r.state) } : null;
    },
    newGame(info) {
      return Number(q('INSERT INTO games(started,home,away,hs,aw) VALUES(?,?,?,0,0)').run(Date.now(), info.home, info.away).lastInsertRowid);
    },
    updateGame(id, f) {
      q('UPDATE games SET home=?, away=?, hs=?, aw=?, ended=?, final=? WHERE id=?')
        .run(f.home, f.away, f.hs, f.aw, f.ended || null, f.final ? JSON.stringify(f.final) : null, id);
    },
    listGames() {
      return q('SELECT id, started, ended, home, away, hs, aw, (final IS NOT NULL) AS has_final FROM games ORDER BY id DESC LIMIT 100').all().map(plain);
    },
    getGame(id) {
      const r = q('SELECT * FROM games WHERE id=?').get(id);
      return r ? { ...r, final: r.final ? JSON.parse(r.final) : null } : null;
    },
    addEvent(gid, e) {
      q('INSERT INTO events(game_id,ts,period,clock_ms,team,text) VALUES(?,?,?,?,?,?)').run(gid, e.ts, e.period, e.clock, e.team || '', e.text);
    },
    listEvents(gid) {
      return q('SELECT ts, period, clock_ms AS clock, team, text FROM events WHERE game_id=? ORDER BY id').all(gid).map(plain);
    },
    saveTeam(t) {
      q('INSERT INTO teams(name,short,logo,players,updated) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET short=excluded.short, logo=excluded.logo, players=excluded.players, updated=excluded.updated')
        .run(t.name, t.short || '', t.logo || '', JSON.stringify(t.players || []), Date.now());
    },
    listTeams() { return q('SELECT id, name, short FROM teams ORDER BY name').all().map(plain); },
    getTeam(id) {
      const r = q('SELECT * FROM teams WHERE id=?').get(id);
      return r ? { ...r, players: JSON.parse(r.players || '[]') } : null;
    },
    deleteTeam(id) { q('DELETE FROM teams WHERE id=?').run(id); },
    // ---- usuarios / sesiones / registro de actividad ----
    countUsers() { return q('SELECT COUNT(*) AS n FROM users').get().n; },
    listUsers() { return q('SELECT * FROM users ORDER BY username').all().map(userRow); },
    getUser(id) { return userRow(q('SELECT * FROM users WHERE id=?').get(id)); },
    getUserByName(u) { return userRow(q('SELECT * FROM users WHERE username=?').get(String(u))); },
    createUser(u) {
      return Number(q('INSERT INTO users(username,name,pass,roles,active,must_change,created) VALUES(?,?,?,?,1,?,?)')
        .run(u.username, u.name || '', u.pass, JSON.stringify(u.roles || []), u.mustChange ? 1 : 0, Date.now()).lastInsertRowid);
    },
    updateUser(id, f) {
      const u = this.getUser(id); if (!u) return;
      q('UPDATE users SET name=?, roles=?, active=? WHERE id=?').run(f.name ?? u.name, JSON.stringify(f.roles ?? u.roles), (f.active ?? u.active) ? 1 : 0, id);
    },
    setPassword(id, pass, mustChange) { q('UPDATE users SET pass=?, must_change=? WHERE id=?').run(pass, mustChange ? 1 : 0, id); },
    deleteUser(id) { q('DELETE FROM sessions WHERE user_id=?').run(id); q('DELETE FROM users WHERE id=?').run(id); },
    touchLogin(id) { q('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), id); },
    createSession(token, userId, expires) { q('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, userId, expires); },
    getSession(token) { const r = q('SELECT * FROM sessions WHERE token=? AND expires>?').get(String(token), Date.now()); return r ? { token: r.token, userId: r.user_id } : null; },
    deleteSession(token) { q('DELETE FROM sessions WHERE token=?').run(String(token)); },
    deleteUserSessions(id) { q('DELETE FROM sessions WHERE user_id=?').run(id); },
    purge() { q('DELETE FROM sessions WHERE expires<=?').run(Date.now()); q('DELETE FROM audit WHERE id < (SELECT MAX(id) FROM audit) - 20000').run(); },
    audit(username, action, detail) {
      q('INSERT INTO audit(ts,username,action,detail) VALUES(?,?,?,?)').run(Date.now(), username || '', action, detail ? String(detail).slice(0, 300) : null);
    },
    listAudit(limit) { return q('SELECT ts, username, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(plain); },
    getKV(key, def) { const r = q('SELECT value FROM kv WHERE key=?').get(key); if (!r) return def; try { return JSON.parse(r.value); } catch (_) { return def; } },
    setKV(key, val) { q('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(val)); },
  };
}

// ---------------- Respaldo JSON ----------------
function jsonStore() {
  let d = { teams: [], games: [], events: [], snapshots: {}, users: [], sessions: {}, audit: [], kv: {}, seq: { team: 0, game: 0, user: 0 } };
  try { const f = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); d = { ...d, ...f, seq: { ...d.seq, ...(f.seq || {}) } }; } catch (_) {}
  let t = null;
  const persist = () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(JSON_FILE, JSON.stringify(d), () => {}), 300); };
  return {
    kind: 'json',
    saveState(id, state) { d.snapshots[id] = { state, updated: Date.now() }; persist(); },
    loadLast() {
      const ids = Object.keys(d.snapshots).sort((a, b) => d.snapshots[b].updated - d.snapshots[a].updated);
      return ids.length ? { id: +ids[0], state: d.snapshots[ids[0]].state } : null;
    },
    newGame(info) {
      const id = ++d.seq.game;
      d.games.push({ id, started: Date.now(), ended: null, home: info.home, away: info.away, hs: 0, aw: 0, final: null });
      persist(); return id;
    },
    updateGame(id, f) {
      const g = d.games.find((x) => x.id === id); if (!g) return;
      Object.assign(g, { home: f.home, away: f.away, hs: f.hs, aw: f.aw, ended: f.ended || null, final: f.final || null }); persist();
    },
    listGames() { return d.games.slice().reverse().slice(0, 100).map((g) => ({ ...g, final: undefined, has_final: g.final ? 1 : 0 })); },
    getGame(id) { return d.games.find((x) => x.id === id) || null; },
    addEvent(gid, e) { d.events.push({ game_id: gid, ...e }); persist(); },
    listEvents(gid) { return d.events.filter((e) => e.game_id === gid); },
    saveTeam(tm) {
      const i = d.teams.findIndex((x) => x.name === tm.name);
      if (i >= 0) d.teams[i] = { ...d.teams[i], ...tm };
      else d.teams.push({ id: ++d.seq.team, ...tm });
      persist();
    },
    listTeams() { return d.teams.map(({ id, name, short }) => ({ id, name, short })).sort((a, b) => a.name.localeCompare(b.name)); },
    getTeam(id) { return d.teams.find((x) => x.id === id) || null; },
    deleteTeam(id) { d.teams = d.teams.filter((x) => x.id !== id); persist(); },
    // ---- usuarios / sesiones / registro de actividad ----
    countUsers() { return d.users.length; },
    listUsers() { return d.users.slice().sort((a, b) => a.username.localeCompare(b.username)).map((u) => ({ ...u })); },
    getUser(id) { const u = d.users.find((x) => x.id === id); return u ? { ...u } : null; },
    getUserByName(n) { const u = d.users.find((x) => x.username.toLowerCase() === String(n).toLowerCase()); return u ? { ...u } : null; },
    createUser(u) {
      const id = ++d.seq.user;
      d.users.push({ id, username: u.username, name: u.name || '', pass: u.pass, roles: u.roles || [], active: true, mustChange: !!u.mustChange, created: Date.now(), lastLogin: null });
      persist(); return id;
    },
    updateUser(id, f) {
      const u = d.users.find((x) => x.id === id); if (!u) return;
      if (f.name != null) u.name = f.name; if (f.roles) u.roles = f.roles; if (f.active != null) u.active = !!f.active; persist();
    },
    setPassword(id, pass, mustChange) { const u = d.users.find((x) => x.id === id); if (u) { u.pass = pass; u.mustChange = !!mustChange; persist(); } },
    deleteUser(id) { d.users = d.users.filter((x) => x.id !== id); this.deleteUserSessions(id); persist(); },
    touchLogin(id) { const u = d.users.find((x) => x.id === id); if (u) { u.lastLogin = Date.now(); persist(); } },
    createSession(token, userId, expires) { d.sessions[token] = { userId, expires }; persist(); },
    getSession(token) { const s = d.sessions[String(token)]; return s && s.expires > Date.now() ? { token, userId: s.userId } : null; },
    deleteSession(token) { delete d.sessions[String(token)]; persist(); },
    deleteUserSessions(id) { for (const [k, s] of Object.entries(d.sessions)) if (s.userId === id) delete d.sessions[k]; persist(); },
    purge() { for (const [k, s] of Object.entries(d.sessions)) if (s.expires <= Date.now()) delete d.sessions[k]; if (d.audit.length > 20000) d.audit = d.audit.slice(-20000); persist(); },
    audit(username, action, detail) { d.audit.push({ ts: Date.now(), username: username || '', action, detail: detail ? String(detail).slice(0, 300) : null }); persist(); },
    listAudit(limit) { return d.audit.slice(-limit).reverse(); },
    getKV(key, def) { return key in d.kv ? d.kv[key] : def; },
    setKV(key, val) { d.kv[key] = val; persist(); },
  };
}

function open() {
  const db = openSqlite();
  if (db) { try { return sqliteStore(db); } catch (e) { console.log('SQLite falló, usando JSON:', e.message); } }
  console.log('Aviso: este Node no trae SQLite integrado (necesitas Node 22.13+). Se usa data.json como respaldo.');
  return jsonStore();
}

module.exports = { open };

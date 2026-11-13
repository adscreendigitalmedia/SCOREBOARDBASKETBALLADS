// auth.js - usuarios, contraseñas, sesiones y permisos por rol.
// Cada comando del panel exige un rol; el servidor lo revisa (ocultar botones en el panel no basta).
const crypto = require('crypto');

const ROLES = {
  relojes: 'Relojes',
  anotacion: 'Anotación',
  jugada: 'Jugada',
  pantallas: 'Pantallas',
  nuevojuego: 'Crear juego nuevo',        // permisos de juegos: nadie los tiene hasta que el admin los da
  historial: 'Editar juegos del historial',
  transmision: 'Transmisión (gráficos TV)',   // Broadcast Pro: solo opera los gráficos, no toca el juego
  admin: 'Admin',
};
const GAME_PERMS = ['nuevojuego', 'historial'];
const SESSION_DAYS = 14;
const COOKIE = 'sb_sess';

// ---------- contraseñas (scrypt con sal) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const newToken = () => crypto.randomBytes(32).toString('hex');

// ---------- cookies ----------
function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const sessionCookie = (token, maxAgeSec) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;

// ---------- qué rol necesita cada comando ----------
const BY_ACTION = {
  relojes: ['gameToggle', 'gameStart', 'gameStop', 'gameSet', 'gameAdjust', 'shotReset', 'shotToggle', 'shotStop', 'shotSet', 'shotAdjust',
    'periodNext', 'periodPrev', 'horn'],
  jugada: ['possession', 'possessionToggle', 'timeoutStart', 'breakStart', 'timerToggle', 'timerAdjust', 'timerStop', 'final', 'popup', 'popupHide'],
  anotacion: ['playerStat', 'shot', 'undo', 'saveTeam', 'loadTeam', 'importRoster'],
  pantallas: ['screenAdd', 'screenDel', 'screenFit', 'layoutAdd', 'layoutDel'],
  nuevojuego: ['resetGame', 'scheduleStart'],
  transmision: ['bcCue', 'bcBug', 'bcTake', 'bcClear', 'bcClearAll', 'bcSet', 'bcReset'],
  admin: ['deleteTeam'],
};
const ACTION_ROLES = {};
for (const [role, list] of Object.entries(BY_ACTION)) for (const a of list) ACTION_ROLES[a] = [role];

// set / inc: depende de qué valor se cambia
const SETTINGS_JUGADA = ['centerView', 'centerTeam', 'centerIdx', 'timeoutMs', 'popupAuto'];
const SETTINGS_PANTALLAS = ['screens', 'bugLayouts', 'title', 'center', 'bottom', 'bgImage', 'bgOnly', 'viewBg', 'viewHead', 'viewTeams', 'viewLine', 'viewLabel', 'viewLead', 'viewText', 'viewClear', 'viewMatch', 'screensOn'];
function rolesFor(c) {
  if (c.a === 'set' || c.a === 'inc') {
    const p = String(c.path || '').split('.');
    if (p[0] === 'teams') return p[2] === 'timeouts' ? ['anotacion', 'jugada'] : ['anotacion'];
    if (p[0] === 'settings') {
      if (SETTINGS_JUGADA.includes(p[1])) return ['jugada'];
      if (SETTINGS_PANTALLAS.includes(p[1])) return ['pantallas'];
      return ['admin'];                        // reglas de la liga y demás ajustes
    }
    return ['admin'];
  }
  return ACTION_ROLES[c.a] || ['admin'];
}
const hasRole = (u, role) => !!u && (u.roles.includes('admin') || u.roles.includes(role));
const canRun = (u, c) => !!u && rolesFor(c).some((r) => hasRole(u, r));

// lo que se manda al navegador (nunca la contraseña)
const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, roles: u.roles, active: u.active, mustChange: u.mustChange, created: u.created, lastLogin: u.lastLogin };
const cleanRoles = (list) => [...new Set((Array.isArray(list) ? list : []).filter((r) => r in ROLES))];

module.exports = { GAME_PERMS, ROLES, SESSION_DAYS, COOKIE, hashPassword, checkPassword, newToken, readCookie, sessionCookie, rolesFor, hasRole, canRun, publicUser, cleanRoles };

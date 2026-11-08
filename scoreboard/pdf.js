// pdf.js - generador del "Resumen del juego" en PDF, sin dependencias (fuentes estándar Helvetica).
const W = 595.28, H = 841.89;

const enc = (s) => String(s ?? '')
  .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
  .replace(/[^\x00-\xFF]/g, '?');
const esc = (s) => enc(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

class Doc {
  constructor() { this.pages = []; this.page(); }
  page() { this.cur = []; this.pages.push(this.cur); return this; }
  col(c) { return c.map((v) => (v / 255).toFixed(3)).join(' '); }
  rect(x, y, w, h, fill, stroke) {                       // y medido desde arriba
    const ops = [];
    if (fill) ops.push(`${this.col(fill)} rg`);
    if (stroke) ops.push(`${this.col(stroke)} RG 0.6 w`);
    ops.push(`${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    this.cur.push(ops.join('\n'));
  }
  line(x1, y1, x2, y2, color = [205, 210, 225], w = 0.5) {
    this.cur.push(`${this.col(color)} RG ${w} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`);
  }
  tw(str, size, bold) {                                  // ancho aproximado en Helvetica
    let w = 0;
    for (const ch of String(str)) {
      if (/[0-9]/.test(ch)) w += 0.556;
      else if (ch === ' ') w += 0.278;
      else if (/[A-ZÁÉÍÓÚÑ]/.test(ch)) w += bold ? 0.72 : 0.68;
      else if (/[a-záéíóúñ]/.test(ch)) w += bold ? 0.56 : 0.5;
      else w += 0.33;
    }
    return w * size;
  }
  text(x, y, str, o = {}) {
    const { size = 10, bold = false, color = [0, 0, 0], align = 'left', width = 0 } = o;
    let px = x; const t = this.tw(str, size, bold);
    if (align === 'center') px = x + (width - t) / 2; else if (align === 'right') px = x + width - t;
    this.cur.push(`BT ${this.col(color)} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${px.toFixed(2)} ${(H - y - size * 0.8).toFixed(2)} Td (${esc(str)}) Tj ET`);
  }
  build() {
    const out = []; const offs = []; let len = 0;
    const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); out.push(b); len += b.length; };
    const obj = (id, body) => { offs[id] = len; push(`${id} 0 obj\n`); push(body); push('\nendobj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    this.pages.forEach((ops, i) => {
      const content = Buffer.from(ops.join('\n'), 'latin1');
      obj(5 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
      offs[6 + 2 * i] = len;
      push(`${6 + 2 * i} 0 obj\n<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream\nendobj\n');
    });
    const n = 5 + 2 * this.pages.length; const xref = len;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    x += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    push(x);
    return Buffer.concat(out);
  }
}

// ---------------- datos ----------------
const perLbl = (i) => (i <= 4 ? 'Q' + i : i === 5 ? 'OT' : (i - 4) + 'OT');
const pct = (m, a) => (a ? Math.round((m / a) * 100) + '%' : '--');
const mmss = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

function totals(t) {
  const st = t.stats || {}; const sum = (k) => t.players.reduce((n, p) => n + (p[k] || 0), 0);
  return {
    pts: t.score, reb: sum('reb'), ast: sum('ast'), pf: sum('pf'), stl: st.stl || 0, tov: st.tov || 0, blk: st.blk || 0,
    fgm: (st.p2m || 0) + (st.p3m || 0), fga: (st.p2a || 0) + (st.p3a || 0), tpm: st.p3m || 0, tpa: st.p3a || 0, ftm: st.ftm || 0, fta: st.fta || 0,
  };
}
function leader(t, k) {
  let b = null;
  for (const p of t.players) if (p.name && p[k] > 0 && (!b || p[k] > b[k])) b = p;
  return b ? `${b.name}  ${b[k]}` : '-';
}

// ---------------- reporte ----------------
function buildReport(S, events, info = {}) {
  const d = new Doc(); const M = 36, CW = W - 2 * M;
  const HM = S.teams.home, AW = S.teams.away;
  const NAVY = [6, 25, 107], BLUE = [10, 47, 184], LIGHT = [232, 238, 255], GRAY = [105, 110, 125], RED = [200, 16, 46], WHITE = [255, 255, 255];
  const nP = Math.max(4, S.period);
  const when = (info.date ? new Date(info.date) : new Date()).toLocaleString('es-PR', { dateStyle: 'long', timeStyle: 'short' });

  const header = (sub) => {
    d.rect(0, 0, W, 64, NAVY);
    d.text(M, 14, 'RESUMEN DEL JUEGO', { size: 22, bold: true, color: WHITE });
    d.text(M, 42, `${S.settings.title || ''}${sub ? '  -  ' + sub : ''}`, { size: 10.5, color: [190, 205, 255] });
    d.text(M, 42, when, { size: 10.5, color: [190, 205, 255], align: 'right', width: CW });
  };

  // ===== Página 1: marcador, periodos, comparativa, líderes =====
  header();
  d.rect(M, 80, CW, 96, LIGHT);
  d.text(M + 14, 104, HM.name.toUpperCase(), { size: 20, bold: true, color: NAVY });
  d.text(M, 104, AW.name.toUpperCase(), { size: 20, bold: true, color: NAVY, align: 'right', width: CW - 14 });
  d.text(W / 2 - 120, 96, String(HM.score), { size: 44, bold: true, align: 'right', width: 90 });
  d.text(W / 2 - 14, 100, '-', { size: 34, bold: true, align: 'center', width: 28 });
  d.text(W / 2 + 30, 96, String(AW.score), { size: 44, bold: true });
  const label = perLbl(S.period);
  d.text(M, 152, S.final ? 'FINAL' : `EN JUEGO - ${label}`, { size: 11, bold: true, color: S.final ? RED : GRAY, align: 'center', width: CW });

  // marcador por periodo
  let y = 196;
  d.text(M, y, 'PUNTOS POR PERIODO', { size: 11, bold: true, color: NAVY }); y += 18;
  const c0 = 170, cw = (CW - c0) / (nP + 1);
  d.rect(M, y, CW, 22, BLUE);
  d.text(M + 8, y + 6, 'Equipo', { size: 10, bold: true, color: WHITE });
  for (let i = 0; i < nP; i++) d.text(M + c0 + i * cw, y + 6, perLbl(i + 1), { size: 10, bold: true, color: WHITE, align: 'center', width: cw });
  d.text(M + c0 + nP * cw, y + 6, 'TOTAL', { size: 10, bold: true, color: WHITE, align: 'center', width: cw });
  y += 22;
  for (const [k, t] of [['home', HM], ['away', AW]]) {
    d.rect(M, y, CW, 22, null, [205, 210, 225]);
    d.text(M + 8, y + 6, t.name, { size: 10.5, bold: true });
    for (let i = 0; i < nP; i++) d.text(M + c0 + i * cw, y + 6, String((S.periodScores && S.periodScores[k] && S.periodScores[k][i]) || 0), { size: 10.5, align: 'center', width: cw });
    d.text(M + c0 + nP * cw, y + 6, String(t.score), { size: 11, bold: true, align: 'center', width: cw });
    y += 22;
  }

  // comparativa
  y += 24;
  d.text(M, y, 'COMPARATIVA DE EQUIPOS', { size: 11, bold: true, color: NAVY }); y += 18;
  const h = totals(HM), a = totals(AW);
  const rows = [
    ['Tiros de campo', `${h.fgm}/${h.fga}  (${pct(h.fgm, h.fga)})`, `${a.fgm}/${a.fga}  (${pct(a.fgm, a.fga)})`],
    ['Triples', `${h.tpm}/${h.tpa}  (${pct(h.tpm, h.tpa)})`, `${a.tpm}/${a.tpa}  (${pct(a.tpm, a.tpa)})`],
    ['Tiros libres', `${h.ftm}/${h.fta}  (${pct(h.ftm, h.fta)})`, `${a.ftm}/${a.fta}  (${pct(a.ftm, a.fta)})`],
    ['Rebotes', h.reb, a.reb], ['Asistencias', h.ast, a.ast], ['Robos', h.stl, a.stl], ['Perdidas', h.tov, a.tov], ['Tapones', h.blk, a.blk],
    ['Faltas personales', h.pf, a.pf], ['Tiempos fuera restantes', HM.timeouts, AW.timeouts],
  ];
  d.rect(M, y, CW, 22, BLUE);
  d.text(M, y + 6, HM.name, { size: 10, bold: true, color: WHITE, align: 'center', width: CW / 3 });
  d.text(M + CW / 3, y + 6, 'ESTADISTICA', { size: 10, bold: true, color: WHITE, align: 'center', width: CW / 3 });
  d.text(M + 2 * CW / 3, y + 6, AW.name, { size: 10, bold: true, color: WHITE, align: 'center', width: CW / 3 });
  y += 22;
  rows.forEach((r, i) => {
    if (i % 2 === 0) d.rect(M, y, CW, 22, [246, 248, 253]);
    d.text(M, y + 6, String(r[1]), { size: 11, bold: true, align: 'center', width: CW / 3 });
    d.text(M + CW / 3, y + 6, r[0], { size: 10, color: GRAY, align: 'center', width: CW / 3 });
    d.text(M + 2 * CW / 3, y + 6, String(r[2]), { size: 11, bold: true, align: 'center', width: CW / 3 });
    y += 22;
  });

  // líderes
  y += 24;
  d.text(M, y, 'LIDERES DEL JUEGO', { size: 11, bold: true, color: NAVY }); y += 18;
  for (const [lab, k] of [['Puntos', 'pts'], ['Rebotes', 'reb'], ['Asistencias', 'ast']]) {
    d.rect(M, y, CW, 22, null, [205, 210, 225]);
    d.text(M + 8, y + 6, leader(HM, k), { size: 10.5, bold: true });
    d.text(M + CW / 3, y + 6, lab, { size: 10, color: GRAY, align: 'center', width: CW / 3 });
    d.text(M, y + 6, leader(AW, k), { size: 10.5, bold: true, align: 'right', width: CW - 8 });
    y += 22;
  }

  // ===== Página 2: box score =====
  d.page(); header('Estadisticas por jugador'); y = 84;
  const lim = S.settings.foulOut || 5;
  const boxScore = (t, tag) => {
    d.rect(M, y, CW, 24, NAVY);
    d.text(M + 8, y + 6, `${t.name.toUpperCase()}  (${tag})`, { size: 11.5, bold: true, color: WHITE });
    d.text(M, y + 7, `${t.score} pts`, { size: 11, bold: true, color: [255, 214, 0], align: 'right', width: CW - 8 });
    y += 24;
    const cols = [['#', 36], ['Jugador', 0], ['PTS', 56], ['REB', 56], ['AST', 56], ['FAL', 56]];
    const fixed = cols.reduce((n, c) => n + c[1], 0);
    const xs = []; let x = M;
    for (const c of cols) { const w = c[1] || CW - fixed; xs.push([x, w]); x += w; }
    d.rect(M, y, CW, 20, LIGHT);
    cols.forEach((c, i) => d.text(xs[i][0] + (i === 1 ? 6 : 0), y + 5, c[0], { size: 9.5, bold: true, color: NAVY, align: i === 1 ? 'left' : 'center', width: xs[i][1] }));
    y += 20;
    const pl = t.players.filter((p) => p.name || p.pts || p.reb || p.ast || p.pf);
    pl.forEach((p, i) => {
      if (i % 2 === 1) d.rect(M, y, CW, 20, [246, 248, 253]);
      const out = p.pf >= lim;
      const vals = [p.n || '', p.name || '-', p.pts, p.reb, p.ast, p.pf];
      vals.forEach((v, j) => d.text(xs[j][0] + (j === 1 ? 6 : 0), y + 5, String(v), {
        size: 10.5, bold: j === 2, align: j === 1 ? 'left' : 'center', width: xs[j][1], color: out && (j === 1 || j === 5) ? RED : [0, 0, 0] }));
      y += 20;
    });
    const tot = totals(t);
    d.rect(M, y, CW, 22, null, NAVY);
    d.text(xs[1][0] + 6, y + 6, 'TOTAL', { size: 10.5, bold: true });
    [tot.pts, tot.reb, tot.ast, tot.pf].forEach((v, j) => d.text(xs[j + 2][0], y + 6, String(v), { size: 11, bold: true, align: 'center', width: xs[j + 2][1] }));
    y += 22 + 22;
  };
  boxScore(HM, 'local'); boxScore(AW, 'visitante');
  d.text(M, y - 12, `Nota: faltas en rojo = jugador con ${lim} o mas (eliminado).`, { size: 8.5, color: GRAY });

  // ===== Páginas 3+: jugada a jugada =====
  const logHeader = () => {
    d.rect(M, y, CW, 20, BLUE);
    [['Per.', 0, 44], ['Reloj', 44, 56], ['Equipo', 100, 70], ['Jugada', 170, CW - 170]].forEach(([t, x, w]) =>
      d.text(M + x + (t === 'Jugada' ? 6 : 0), y + 5, t, { size: 9.5, bold: true, color: WHITE, align: t === 'Jugada' ? 'left' : 'center', width: w }));
    y += 20;
  };
  d.page(); header('Jugada a jugada'); y = 84;
  if (!events || !events.length) d.text(M, y, 'Sin jugadas registradas.', { size: 10.5, color: GRAY });
  else {
    logHeader();
    events.forEach((e, i) => {
      if (y > H - 56) { d.page(); header('Jugada a jugada'); y = 84; logHeader(); }
      if (i % 2 === 1) d.rect(M, y, CW, 17, [246, 248, 253]);
      const tm = e.team === 'home' ? HM.short || HM.name : e.team === 'away' ? AW.short || AW.name : '';
      d.text(M, y + 4, perLbl(e.period), { size: 9, align: 'center', width: 44 });
      d.text(M + 44, y + 4, mmss(e.clock), { size: 9, align: 'center', width: 56 });
      d.text(M + 100, y + 4, tm, { size: 9, bold: true, align: 'center', width: 70 });
      d.text(M + 176, y + 4, e.text, { size: 9 });
      y += 17;
    });
  }

  // pie de página
  const total = d.pages.length;
  d.pages.forEach((ops, i) => {
    d.cur = ops;
    d.line(M, H - 34, W - M, H - 34);
    d.text(M, H - 28, `${HM.name} vs ${AW.name}`, { size: 8.5, color: GRAY });
    d.text(M, H - 28, `Pagina ${i + 1} de ${total}`, { size: 8.5, color: GRAY, align: 'right', width: CW });
  });
  return d.build();
}

module.exports = { buildReport };

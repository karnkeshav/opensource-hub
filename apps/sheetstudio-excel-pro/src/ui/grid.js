// Canvas grid: virtual scrolling, frozen panes, rendering and pointer selection.
import { K, MAXR, MAXC, cfAt, dvAt, displayValue } from '../engine.js';
import { colName } from '../parser.js';
import { tableAt, tableStyle } from '../tables.js';

export const HDR_W = 48, HDR_H = 22, DEF_W = 64, DEF_H = 20;
const FONT = '"Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif';
const PT = 96 / 72;

const upper = (a, v) => { // largest i with a[i] <= v
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= v) lo = m; else hi = m - 1; }
  return lo;
};

export class Grid {
  constructor(host, app) {
    this.app = app; this.host = host;
    this.cv = host.querySelector('canvas');
    this.sc = host.querySelector('.scroller');
    this.sp = host.querySelector('.spacer');
    this.ctx = this.cv.getContext('2d');
    this.z = 1; this.showFormulas = false; this.dirty = true; this.raf = 0;
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 }; this.act = { r: 0, c: 0 };
    this.extR = 200; this.extC = 40; this.layoutDirty = true;
    this.drag = null; this.ants = null; this.fillPreview = null; this.pointer = null;
    this.theme = {};
    this.sc.addEventListener('scroll', () => { this.growCheck(); this.invalidate(); });
    this.sc.addEventListener('mousedown', (e) => this.down(e));
    this.sc.addEventListener('dblclick', (e) => this.dbl(e));
    this.sc.addEventListener('mousemove', (e) => this.hover(e));
    this.sc.addEventListener('contextmenu', (e) => this.ctxMenu(e));
    this.sc.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); app.setZoom(this.z * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    new ResizeObserver(() => this.resize()).observe(host);
    this.readTheme();
  }

  get sh() { return this.app.sh; }
  get wb() { return this.app.wb; }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    this.theme = { bg: g('--cell-bg'), grid: g('--grid'), hdr: g('--hdr-bg'), hdrText: g('--hdr-text'), hdrSel: g('--hdr-sel'), text: g('--text'), accent: g('--accent'), selFill: g('--sel-fill'), line: g('--line') };
    this.invalidate();
  }

  invalidate() { this.dirty = true; if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.dirty) this.draw(); }); }
  relayout() { this.layoutDirty = true; this.invalidate(); }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.W = Math.max(50, Math.floor(r.width)); this.H = Math.max(50, Math.floor(r.height));
    const d = window.devicePixelRatio || 1;
    this.cv.width = this.W * d; this.cv.height = this.H * d;
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.dpr = d;
    this.invalidate();
  }

  // ---------- layout ----------
  layout() {
    const sh = this.sh, z = this.z;
    const sr = this.sel.r2 >= MAXR - 1 ? 0 : this.sel.r2, scn = this.sel.c2 >= MAXC - 1 ? 0 : this.sel.c2;
    this.extR = Math.min(MAXR, Math.max(this.extR, sh.maxR + 40, sh.freeze.r + 40, sr + 20));
    this.extC = Math.min(MAXC, Math.max(this.extC, sh.maxC + 8, sh.freeze.c + 8, scn + 4));
    // Prefix sums are only kept up to the last row/column with a custom size; the rest is arithmetic.
    let lastR = -1, lastC = -1;
    for (const k of sh.rowH.keys()) if (k > lastR) lastR = k;
    for (const k of sh.hiddenRows) if (k > lastR) lastR = k;
    for (const k of sh.filtered) if (k > lastR) lastR = k;
    for (const k of sh.colW.keys()) if (k > lastC) lastC = k;
    for (const k of sh.hiddenCols) if (k > lastC) lastC = k;
    const nr = this.nR = Math.min(this.extR, lastR + 2), nc = this.nC = Math.min(this.extC, lastC + 2);
    const ry = new Float64Array(nr + 1), cx = new Float64Array(nc + 1);
    for (let r = 0; r < nr; r++) ry[r + 1] = ry[r] + (sh.rowHidden(r) ? 0 : (sh.rowH.get(r) ?? DEF_H) * z);
    for (let c = 0; c < nc; c++) cx[c + 1] = cx[c] + (sh.hiddenCols.has(c) ? 0 : (sh.colW.get(c) ?? DEF_W) * z);
    this.rowY = ry; this.colX = cx;
    this.mergeRows = new Map();
    for (const m of sh.merges) for (let r = m.r1; r <= Math.min(m.r2, m.r1 + 5000); r++) { let a = this.mergeRows.get(r); if (!a) this.mergeRows.set(r, (a = [])); a.push(m); }
    this.noteMap = new Map(sh.notes.map((n) => [n.r * 16384 + n.c, n]));
    this.sp.style.width = HDR_W + this.colPos(this.extC) + 'px';
    this.sp.style.height = HDR_H + this.rowPos(this.extR) + 'px';
    this.layoutDirty = false;
  }

  rowPos(r) { return r <= this.nR ? this.rowY[r] : this.rowY[this.nR] + (r - this.nR) * DEF_H * this.z; }
  colPos(c) { return c <= this.nC ? this.colX[c] : this.colX[this.nC] + (c - this.nC) * DEF_W * this.z; }
  get fz() { return { r: this.sh.freeze.r, c: this.sh.freeze.c }; }
  X(c) { return HDR_W + this.colPos(c) - (c < this.sh.freeze.c ? 0 : this.sc.scrollLeft); }
  Y(r) { return HDR_H + this.rowPos(r) - (r < this.sh.freeze.r ? 0 : this.sc.scrollTop); }
  colAt(x) { // x in viewport coords
    const f = this.sh.freeze.c, fw = this.colPos(f);
    const v = x - HDR_W + (x - HDR_W < fw ? 0 : this.sc.scrollLeft);
    if (v >= this.colX[this.nC]) return Math.min(MAXC - 1, this.nC + Math.floor((v - this.colX[this.nC]) / (DEF_W * this.z)));
    return upper(this.colX, Math.max(0, v));
  }
  rowAt(y) {
    const f = this.sh.freeze.r, fh = this.rowPos(f);
    const v = y - HDR_H + (y - HDR_H < fh ? 0 : this.sc.scrollTop);
    if (v >= this.rowY[this.nR]) return Math.min(MAXR - 1, this.nR + Math.floor((v - this.rowY[this.nR]) / (DEF_H * this.z)));
    return upper(this.rowY, Math.max(0, v));
  }
  // viewport rect of a cell (or merged area)
  cellRect(r, c) {
    const m = this.sh.mergeAt(r, c);
    const r1 = m ? m.r1 : r, c1 = m ? m.c1 : c, r2 = m ? m.r2 : r, c2 = m ? m.c2 : c;
    const x = this.X(c1), y = this.Y(r1);
    return { x, y, w: this.X(c2 + 1) - x + (c2 + 1 < this.sh.freeze.c || c1 >= this.sh.freeze.c ? 0 : 0), h: this.Y(r2 + 1) - y, r1, c1, r2, c2 };
  }
  growCheck() {
    const sc = this.sc;
    let ch = false;
    if (sc.scrollTop + sc.clientHeight > sc.scrollHeight - 200 && this.extR < MAXR) { this.extR = Math.min(MAXR, this.extR + 100); ch = true; }
    if (sc.scrollLeft + sc.clientWidth > sc.scrollWidth - 200 && this.extC < MAXC) { this.extC = Math.min(MAXC, this.extC + 10); ch = true; }
    if (ch) this.layoutDirty = true;
  }
  ensureVisible(r, c) {
    if (this.layoutDirty) this.layout();
    const sc = this.sc, sh = this.sh, f = sh.freeze;
    const rr = this.cellRect(r, c);
    const left = HDR_W + this.colPos(f.c), top = HDR_H + this.rowPos(f.r);
    if (c >= f.c) {
      if (rr.x < left) sc.scrollLeft -= left - rr.x;
      else if (rr.x + rr.w > this.W - 4) sc.scrollLeft += rr.x + rr.w - this.W + 4;
    }
    if (r >= f.r) {
      if (rr.y < top) sc.scrollTop -= top - rr.y;
      else if (rr.y + rr.h > this.H - 4) sc.scrollTop += rr.y + rr.h - this.H + 4;
    }
    this.invalidate();
  }

  // ---------- drawing ----------
  draw() {
    this.dirty = false;
    if (this.layoutDirty) this.layout();
    const { ctx, W, H, theme: t, sh } = this;
    if (!W) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
    const f = sh.freeze, sx = this.sc.scrollLeft, sy = this.sc.scrollTop;
    const fw = this.colPos(f.c), fh = this.rowPos(f.r);
    const cs = this.colAt(HDR_W + fw), ce = Math.min(MAXC - 1, this.colAt(W) + 1);
    const rs = this.rowAt(HDR_H + fh), re = Math.min(MAXR - 1, this.rowAt(H) + 1);
    const c0 = Math.max(f.c, cs), r0 = Math.max(f.r, rs);
    const regions = [
      [HDR_W + fw, HDR_H + fh, W, H, r0, re, c0, ce],
      ...(f.r ? [[HDR_W + fw, HDR_H, W, HDR_H + fh, 0, f.r - 1, c0, ce]] : []),
      ...(f.c ? [[HDR_W, HDR_H + fh, HDR_W + fw, H, r0, re, 0, f.c - 1]] : []),
      ...(f.r && f.c ? [[HDR_W, HDR_H, HDR_W + fw, HDR_H + fh, 0, f.r - 1, 0, f.c - 1]] : []),
    ];
    this.touched = new Map();
    for (const [x0, y0, x1, y1, ra, rb, ca, cb] of regions) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      this.drawRegion(ra, rb, ca, cb);
      ctx.restore();
    }
    // freeze separators
    ctx.strokeStyle = t.line; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (f.c) { ctx.moveTo(HDR_W + fw, HDR_H); ctx.lineTo(HDR_W + fw, H); }
    if (f.r) { ctx.moveTo(HDR_W, HDR_H + fh); ctx.lineTo(W, HDR_H + fh); }
    ctx.stroke();
    this.drawSelection(HDR_W + fw, HDR_H + fh);
    this.drawHeaders(cs, ce, rs, re);
    this.app.afterDraw && this.app.afterDraw();
  }

  font(s) { return `${s.i ? 'italic ' : ''}${s.b ? 'bold ' : ''}${(s.sz || 11) * PT * this.z}px ${s.fn ? '"' + s.fn + '",' : ''}${FONT}`; }

  drawRegion(ra, rb, ca, cb) {
    const { ctx, sh, wb, theme: t, z } = this;
    const merged = [];
    // gridlines
    if (sh.showGrid) {
      ctx.strokeStyle = t.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (let r = ra; r <= rb + 1; r++) { const y = Math.round(this.Y(r)) - 0.5; ctx.moveTo(this.X(ca), y); ctx.lineTo(this.X(cb + 1), y); }
      for (let c = ca; c <= cb + 1; c++) { const x = Math.round(this.X(c)) - 0.5; ctx.moveTo(x, this.Y(ra)); ctx.lineTo(x, this.Y(rb + 1)); }
      ctx.stroke();
    }
    // cells
    for (let r = ra; r <= rb; r++) {
      if (sh.rowHidden(r)) continue;
      const mr = this.mergeRows.get(r);
      for (let c = ca; c <= cb; c++) {
        if (sh.hiddenCols.has(c)) continue;
        if (mr) { const m = mr.find((q) => c >= q.c1 && c <= q.c2); if (m) { if (!merged.includes(m)) merged.push(m); continue; } }
        this.drawCell(r, c, this.X(c), this.Y(r), this.X(c + 1) - this.X(c), this.Y(r + 1) - this.Y(r));
      }
    }
    for (const m of merged) {
      const rc = this.cellRect(m.r1, m.c1);
      this.drawCell(m.r1, m.c1, rc.x, rc.y, rc.w, rc.h);
    }
  }

  drawCell(r, c, x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    const { ctx, sh, wb, theme: t, z } = this;
    const k = r * 16384 + c;
    const cell = sh.cells.get(k);
    const sid = cell ? cell.s : sh.styleAt(r, c);
    const st = wb.styles[sid];
    let v = sh.get(r, c);
    const f = cell && cell.f != null;
    const cf = sh.cf.length ? cfAt(sh, r, c, v) : null;
    const ts = sh.tables.length ? (() => { const tb = tableAt(sh, r, c); return tb ? tableStyle(tb, r, t.bg) : null; })() : null;
    const bg = (cf && cf.bg) || st.bg || (ts && ts.bg);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); }
    if (ts && ts.top) { ctx.fillStyle = ts.top; ctx.fillRect(x, y, w, 2); }
    if (this.noteMap.size && this.noteMap.has(k)) { ctx.fillStyle = '#d93025'; ctx.beginPath(); ctx.moveTo(x + w - 7, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + 7); ctx.fill(); }
    if (cf && cf.bar) { ctx.fillStyle = cf.bar.color; ctx.globalAlpha = 0.55; ctx.fillRect(x + 1, y + 2, Math.max(2, (w - 2) * cf.bar.pct), h - 4); ctx.globalAlpha = 1; }
    if (st.bd) this.drawBorders(st, x, y, w, h);
    if (v === null && !f) return;
    let text, color = (cf && cf.fc) || st.fc || (ts && ts.fc) || (bg &&/^#[0-9a-f]{6}$/i.test(bg) ? ((parseInt(bg.slice(1, 3), 16) * 299 + parseInt(bg.slice(3, 5), 16) * 587 + parseInt(bg.slice(5, 7), 16) * 114) / 1000 > 140 ? '#000' : '#fff') : t.text), isNum = false, spark = null;
    if (this.showFormulas && f) text = '=' + cell.f;
    else {
      const d = displayValue(v, st.nf);
      text = d.text; if (d.color) color = d.color; isNum = !!d.num; spark = d.spark;
      if (d.err) color = '#c0392b';
    }
    if (spark) { this.drawSpark(spark, x, y, w, h); return; }
    if (text === '') return;
    const bold = (cf && cf.b) || (ts && ts.b) ? true : st.b, ital = cf && cf.i ? true : st.i;
    const fs = bold === st.b && ital === st.i ? st : { ...st, b: bold, i: ital };
    ctx.font = this.font(fs); ctx.fillStyle = color;
    const pad = 4 * z, ind = (st.ind || 0) * 9 * z;
    let ha = st.ha || (isNum ? 'right' : typeof v === 'boolean' || (v && v.c) ? 'center' : 'left');
    if (this.showFormulas && f) ha = 'left';
    const lh = (st.sz || 11) * PT * z * 1.25;
    ctx.textBaseline = 'alphabetic';
    let lines = [text], clipW = w, clipX = x;
    let tw = ctx.measureText(text).width;
    if (st.wr && typeof v === 'string' || (st.wr && !isNum)) {
      lines = this.wrap(text, w - pad * 2 - ind);
    } else if (isNum && tw > w - pad && !this.showFormulas) {
      lines = ['#'.repeat(Math.max(1, Math.floor((w - pad) / ctx.measureText('#').width)))];
    } else if (tw > w - pad * 2 && ha === 'left' && !st.wr) {
      // spill over empty neighbours
      let extra = 0, cc = c + 1;
      while (x + w + extra < this.W && extra < tw && cc < MAXC && cc < c + 60) {
        if (sh.cells.has(r * 16384 + cc) || sh.spillVals.has(r * 16384 + cc) || sh.mergeAt(r, cc)) break;
        extra += this.X(cc + 1) - this.X(cc); cc++;
      }
      clipW = w + extra;
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(clipX, y, clipW, h); ctx.clip();
    const total = lines.length * lh;
    let ty = (st.va === 'top') ? y + lh * 0.85 + 2 : st.va === 'center' ? y + (h - total) / 2 + lh * 0.85 : y + h - total + lh * 0.85 - 3 * z;
    if (st.wr && total > h) ty = y + lh * 0.85 + 1;
    for (const ln of lines) {
      const lw = ctx.measureText(ln).width;
      const tx = ha === 'right' ? x + w - pad - lw : ha === 'center' ? x + (w - lw) / 2 : x + pad + ind;
      ctx.fillText(ln, tx, ty);
      if (st.u || st.st) {
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
        if (st.u) { ctx.moveTo(tx, ty + 2); ctx.lineTo(tx + lw, ty + 2); }
        if (st.st) { ctx.moveTo(tx, ty - lh * 0.3); ctx.lineTo(tx + lw, ty - lh * 0.3); }
        ctx.stroke();
      }
      ty += lh;
    }
    ctx.restore();
  }

  wrap(text, maxW) {
    const out = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const tryL = line + word;
        if (line && this.ctx.measureText(tryL).width > maxW) { out.push(line.trimEnd()); line = word.trimStart(); } else line = tryL;
      }
      out.push(line);
    }
    return out;
  }

  drawBorders(st, x, y, w, h) {
    const { ctx } = this;
    ctx.strokeStyle = st.bc || '#000';
    const side = (kind, x1, y1, x2, y2) => {
      if (!kind) return;
      ctx.lineWidth = kind === 'thick' ? 3 : kind === 'medium' || kind === 'double' ? 2 : 1;
      ctx.setLineDash(kind === 'dashed' ? [4, 3] : kind === 'dotted' ? [1.5, 2] : []);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    const b = st.bd;
    side(b.t, x, y + 0.5, x + w, y + 0.5); side(b.b, x, y + h - 0.5, x + w, y + h - 0.5);
    side(b.l, x + 0.5, y, x + 0.5, y + h); side(b.r, x + w - 0.5, y, x + w - 0.5, y + h);
    ctx.setLineDash([]);
  }

  drawSpark(sp, x, y, w, h) {
    const { ctx, theme: t } = this;
    const d = sp.data, nums = d.filter((v) => v !== null);
    if (!nums.length) return;
    const mn = Math.min(...nums, sp.type === 'column' ? 0 : Infinity), mx = Math.max(...nums, sp.type === 'column' ? 0 : -Infinity);
    const span = mx - mn || 1, px = 4, py = 4, iw = w - px * 2, ih = h - py * 2;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = t.accent; ctx.fillStyle = t.accent; ctx.lineWidth = 1.5;
    const step = iw / Math.max(1, d.length - (sp.type === 'line' ? 1 : 0));
    if (sp.type === 'line') {
      ctx.beginPath();
      let pen = false;
      d.forEach((v, i) => { if (v === null) { pen = false; return; } const X = x + px + i * step, Y = y + py + ih - ((v - mn) / span) * ih; pen ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); pen = true; });
      ctx.stroke();
    } else {
      const zero = y + py + ih - ((0 - mn) / span) * ih;
      d.forEach((v, i) => {
        if (v === null) return;
        const bx = x + px + i * step + 1, bw = Math.max(1, step - 2);
        if (sp.type === 'winloss') { ctx.fillStyle = v >= 0 ? t.accent : '#c0392b'; ctx.fillRect(bx, v >= 0 ? y + h / 2 - ih / 4 : y + h / 2, bw, ih / 4); }
        else { const Y = y + py + ih - ((v - mn) / span) * ih; ctx.fillStyle = v >= 0 ? t.accent : '#c0392b'; ctx.fillRect(bx, Math.min(Y, zero), bw, Math.max(1, Math.abs(zero - Y))); }
      });
    }
    ctx.restore();
  }

  drawSelection(clipX, clipY) {
    const { ctx, theme: t, sel, act, sh } = this;
    const draw = (rect, fill, line, dash) => {
      const x1 = this.X(rect.c1), x2 = this.X(rect.c2 + 1), y1 = this.Y(rect.r1), y2 = this.Y(rect.r2 + 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(HDR_W, HDR_H, this.W - HDR_W, this.H - HDR_H); ctx.clip();
      if (fill) { ctx.fillStyle = t.selFill; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); }
      ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.setLineDash(dash || []);
      ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
      ctx.restore();
    };
    // multi-cell: shade everything but the active cell
    const a = this.cellRect(act.r, act.c);
    const single = sel.r1 === sel.r2 && sel.c1 === sel.c2 || (a.r1 === sel.r1 && a.r2 === sel.r2 && a.c1 === sel.c1 && a.c2 === sel.c2);
    ctx.save();
    ctx.beginPath(); ctx.rect(HDR_W, HDR_H, this.W - HDR_W, this.H - HDR_H); ctx.clip();
    if (!single) {
      const x1 = this.X(sel.c1), x2 = this.X(sel.c2 + 1), y1 = this.Y(sel.r1), y2 = this.Y(sel.r2 + 1);
      ctx.fillStyle = t.selFill;
      ctx.beginPath(); ctx.rect(x1, y1, x2 - x1, y2 - y1); ctx.rect(a.x, a.y, a.w, a.h); ctx.fill('evenodd');
    }
    ctx.restore();
    draw(sel, false, t.accent);
    if (!single) draw({ r1: a.r1, r2: a.r2, c1: a.c1, c2: a.c2 }, false, t.accent);
    if (this.ants && this.ants.sheet === sh) { draw(this.ants, false, t.accent, [5, 4]); }
    if (this.fillPreview) draw(this.fillPreview, false, t.text, [4, 3]);
    // fill handle
    const hx = this.X(sel.c2 + 1), hy = this.Y(sel.r2 + 1);
    if (hx > HDR_W && hy > HDR_H && hx < this.W && hy < this.H) {
      ctx.fillStyle = t.accent; ctx.fillRect(hx - 4, hy - 4, 7, 7);
      ctx.strokeStyle = t.bg; ctx.lineWidth = 1; ctx.strokeRect(hx - 4.5, hy - 4.5, 8, 8);
    }
    // buttons: validation list / filter
    ctx.save(); ctx.beginPath(); ctx.rect(HDR_W, HDR_H, this.W - HDR_W, this.H - HDR_H); ctx.clip();
    const dv = dvAt(sh, act.r, act.c);
    if (dv && dv.type === 'list') { const b = this.btnRect(act.r, act.c); this.arrow(b); }
    if (sh.filter) {
      for (let c = sh.filter.c1; c <= sh.filter.c2; c++) {
        const b = this.btnRect(sh.filter.r1, c);
        if (b.x > HDR_W - 20 && b.x < this.W) this.arrow(b, sh.filter.crit && sh.filter.crit[c] && sh.filter.crit[c].length);
      }
    }
    ctx.restore();
  }
  btnRect(r, c) { const rc = this.cellRect(r, c), s = Math.min(16 * this.z, rc.h - 2); return { x: rc.x + rc.w - s - 1, y: rc.y + rc.h - s - 1, s }; }
  arrow(b, active) {
    const { ctx, theme: t } = this;
    ctx.fillStyle = active ? t.accent : t.hdr; ctx.fillRect(b.x, b.y, b.s, b.s);
    ctx.strokeStyle = t.grid; ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.s - 1, b.s - 1);
    ctx.fillStyle = active ? '#fff' : t.hdrText;
    ctx.beginPath(); ctx.moveTo(b.x + b.s * 0.27, b.y + b.s * 0.4); ctx.lineTo(b.x + b.s * 0.73, b.y + b.s * 0.4); ctx.lineTo(b.x + b.s / 2, b.y + b.s * 0.68); ctx.fill();
  }

  drawHeaders(cs, ce, rs, re) {
    const { ctx, theme: t, sh, sel, W, H } = this;
    const f = sh.freeze, fw = this.colPos(f.c), fh = this.rowPos(f.r);
    ctx.font = `${11 * this.z}px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const colSel = (c) => c >= sel.c1 && c <= sel.c2, rowSel = (r) => r >= sel.r1 && r <= sel.r2;
    const wholeCol = sel.r1 === 0 && sel.r2 >= MAXR - 1, wholeRow = sel.c1 === 0 && sel.c2 >= MAXC - 1;
    // column headers
    ctx.fillStyle = t.hdr; ctx.fillRect(0, 0, W, HDR_H);
    ctx.save(); ctx.beginPath(); ctx.rect(HDR_W, 0, W - HDR_W, HDR_H); ctx.clip();
    const drawCol = (c) => {
      if (sh.hiddenCols.has(c)) return;
      const x = this.X(c), w = this.X(c + 1) - x;
      if (colSel(c)) { ctx.fillStyle = wholeCol ? t.accent : t.hdrSel; ctx.fillRect(x, 0, w, HDR_H); }
      ctx.fillStyle = colSel(c) && wholeCol ? '#fff' : t.hdrText;
      ctx.fillText(colName(c), x + w / 2, HDR_H / 2 + 1);
      ctx.fillStyle = t.grid; ctx.fillRect(x + w - 1, 0, 1, HDR_H);
    };
    for (let c = Math.max(cs, f.c); c <= ce; c++) drawCol(c);
    ctx.restore();
    if (f.c) { ctx.save(); ctx.beginPath(); ctx.rect(HDR_W, 0, fw, HDR_H); ctx.clip(); ctx.fillStyle = t.hdr; ctx.fillRect(HDR_W, 0, fw, HDR_H); for (let c = 0; c < f.c; c++) drawCol(c); ctx.restore(); }
    // row headers
    ctx.fillStyle = t.hdr; ctx.fillRect(0, 0, HDR_W, H);
    const drawRow = (r) => {
      if (sh.rowHidden(r)) return;
      const y = this.Y(r), h = this.Y(r + 1) - y;
      if (rowSel(r)) { ctx.fillStyle = wholeRow ? t.accent : t.hdrSel; ctx.fillRect(0, y, HDR_W, h); }
      ctx.fillStyle = rowSel(r) && wholeRow ? '#fff' : t.hdrText;
      ctx.fillText(String(r + 1), HDR_W / 2, y + h / 2 + 1);
      ctx.fillStyle = t.grid; ctx.fillRect(0, y + h - 1, HDR_W, 1);
    };
    ctx.save(); ctx.beginPath(); ctx.rect(0, HDR_H, HDR_W, H - HDR_H); ctx.clip();
    for (let r = Math.max(rs, f.r); r <= re; r++) drawRow(r);
    ctx.restore();
    if (f.r) { ctx.save(); ctx.beginPath(); ctx.rect(0, HDR_H, HDR_W, fh); ctx.clip(); ctx.fillStyle = t.hdr; ctx.fillRect(0, HDR_H, HDR_W, fh); for (let r = 0; r < f.r; r++) drawRow(r); ctx.restore(); }
    // corner + borders
    ctx.fillStyle = t.hdr; ctx.fillRect(0, 0, HDR_W, HDR_H);
    ctx.fillStyle = t.hdrText; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(HDR_W - 4, HDR_H - 14); ctx.lineTo(HDR_W - 4, HDR_H - 4); ctx.lineTo(HDR_W - 14, HDR_H - 4); ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = t.grid; ctx.fillRect(0, HDR_H - 1, W, 1); ctx.fillRect(HDR_W - 1, 0, 1, H);
    ctx.textAlign = 'left';
  }

  // ---------- pointer ----------
  local(e) { const r = this.sc.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  onScrollbar(e) { const r = this.sc.getBoundingClientRect(); return e.clientX - r.left > this.sc.clientWidth || e.clientY - r.top > this.sc.clientHeight; }

  hit(x, y) {
    const sh = this.sh;
    if (x < HDR_W && y < HDR_H) return { zone: 'corner' };
    if (y < HDR_H) {
      const c = this.colAt(x);
      const edge = this.X(c + 1);
      if (Math.abs(x - edge) < 4) return { zone: 'colEdge', c };
      const prev = c > 0 ? this.X(c) : -99;
      if (Math.abs(x - prev) < 4 && c > 0) return { zone: 'colEdge', c: c - 1 };
      return { zone: 'col', c };
    }
    if (x < HDR_W) {
      const r = this.rowAt(y);
      if (Math.abs(y - this.Y(r + 1)) < 4) return { zone: 'rowEdge', r };
      if (r > 0 && Math.abs(y - this.Y(r)) < 4) return { zone: 'rowEdge', r: r - 1 };
      return { zone: 'row', r };
    }
    const hx = this.X(this.sel.c2 + 1), hy = this.Y(this.sel.r2 + 1);
    if (Math.abs(x - hx) < 6 && Math.abs(y - hy) < 6) return { zone: 'fill' };
    const r = this.rowAt(y), c = this.colAt(x);
    const dv = dvAt(sh, this.act.r, this.act.c);
    if (dv && dv.type === 'list' && r === this.act.r && c === this.act.c) { const b = this.btnRect(r, c); if (x >= b.x && y >= b.y && x <= b.x + b.s && y <= b.y + b.s) return { zone: 'dv', r, c }; }
    if (sh.filter && r === sh.filter.r1 && c >= sh.filter.c1 && c <= sh.filter.c2) { const b = this.btnRect(r, c); if (x >= b.x && y >= b.y && x <= b.x + b.s && y <= b.y + b.s) return { zone: 'filter', r, c }; }
    return { zone: 'cell', r, c };
  }

  hover(e) {
    if (this.drag || this.onScrollbar(e)) return;
    const { x, y } = this.local(e);
    const h = this.hit(x, y);
    this.app.noteTip && this.app.noteTip(h.zone === 'cell' && this.noteMap ? this.noteMap.get(h.r * 16384 + h.c) : null, e);
    this.sc.style.cursor = h.zone === 'colEdge' ? 'col-resize' : h.zone === 'rowEdge' ? 'row-resize' : h.zone === 'fill' ? 'crosshair' : h.zone === 'col' || h.zone === 'row' ? 'pointer' : h.zone === 'dv' || h.zone === 'filter' ? 'pointer' : 'cell';
  }

  setSel(r1, c1, r2, c2, act) {
    const sh = this.sh;
    let s = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
    for (let again = true; again;) { // grow to whole merged cells
      again = false;
      for (const m of sh.merges) {
        if (m.r1 <= s.r2 && m.r2 >= s.r1 && m.c1 <= s.c2 && m.c2 >= s.c1) {
          const n = { r1: Math.min(s.r1, m.r1), c1: Math.min(s.c1, m.c1), r2: Math.max(s.r2, m.r2), c2: Math.max(s.c2, m.c2) };
          if (n.r1 !== s.r1 || n.c1 !== s.c1 || n.r2 !== s.r2 || n.c2 !== s.c2) { s = n; again = true; }
        }
      }
    }
    this.sel = s;
    if (act) this.act = act;
    this.app.onSelect();
    this.invalidate();
  }
  moveActive(r, c, extend) {
    r = Math.max(0, Math.min(MAXR - 1, r)); c = Math.max(0, Math.min(MAXC - 1, c));
    if (extend) {
      this.focus = { r, c };
      this.setSel(this.act.r, this.act.c, r, c);
    } else {
      const m = this.sh.mergeAt(r, c);
      this.focus = { r, c };
      this.setSel(m ? m.r1 : r, m ? m.c1 : c, m ? m.r2 : r, m ? m.c2 : c, { r: m ? m.r1 : r, c: m ? m.c1 : c });
    }
    this.ensureVisible(r, c);
  }

  down(e) {
    if (e.button === 2) { this.pendingCtx = this.hit(...Object.values(this.local(e))); return; }
    if (e.button !== 0 || this.onScrollbar(e)) return;
    const { x, y } = this.local(e);
    const h = this.hit(x, y);
    this.app.focusSink();
    const app = this.app;
    if (h.zone === 'colEdge' || h.zone === 'rowEdge') {
      const horiz = h.zone === 'colEdge';
      const sel = (horiz && this.sel.c1 <= h.c && this.sel.c2 >= h.c && this.sel.r1 === 0 && this.sel.r2 >= MAXR - 1) ? this.sel : null;
      this.drag = { kind: horiz ? 'colW' : 'rowH', idx: horiz ? h.c : h.r, start: horiz ? e.clientX : e.clientY, orig: horiz ? (this.sh.colW.get(h.c) ?? DEF_W) : (this.sh.rowH.get(h.r) ?? DEF_H), sel };
      this.track();
      return;
    }
    if (h.zone === 'fill') { this.drag = { kind: 'fill', src: { ...this.sel } }; this.track(); return; }
    if (h.zone === 'dv') { app.showDvList(); return; }
    if (h.zone === 'filter') { app.showFilterMenu(h.c); return; }
    if (app.editing) {
      // clicking another cell while typing a formula inserts a reference
      if (h.zone === 'cell' && app.canPoint()) { this.drag = { kind: 'point', r: h.r, c: h.c }; app.pointRef(h.r, h.c, h.r, h.c); this.track(); e.preventDefault(); return; }
      app.commitEdit(0, 0);
    }
    if (h.zone === 'corner') { this.setSel(0, 0, MAXR - 1, MAXC - 1, { r: 0, c: 0 }); return; }
    if (h.zone === 'col') {
      const keep = e.shiftKey ? this.act.c : h.c;
      this.setSel(0, keep, MAXR - 1, h.c, e.shiftKey ? this.act : { r: 0, c: h.c });
      this.drag = { kind: 'selCol', from: keep }; this.track(); return;
    }
    if (h.zone === 'row') {
      const keep = e.shiftKey ? this.act.r : h.r;
      this.setSel(keep, 0, h.r, MAXC - 1, e.shiftKey ? this.act : { r: h.r, c: 0 });
      this.drag = { kind: 'selRow', from: keep }; this.track(); return;
    }
    if (e.shiftKey) this.moveActive(h.r, h.c, true);
    else this.moveActive(h.r, h.c, false);
    this.drag = { kind: 'sel' };
    this.track();
  }

  track() {
    const move = (e) => this.dragMove(e);
    const up = (e) => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); clearInterval(this.auto); this.dragEnd(e); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    this.lastE = null;
    this.auto = setInterval(() => { if (this.lastE) this.autoScroll(this.lastE); }, 40);
  }

  autoScroll(e) {
    if (!this.drag || !['sel', 'selCol', 'selRow', 'fill', 'point'].includes(this.drag.kind)) return;
    const { x, y } = this.local(e), sc = this.sc;
    const dx = x > this.W - 12 ? 24 : x < HDR_W + 8 ? -24 : 0, dy = y > this.H - 12 ? 24 : y < HDR_H + 8 ? -24 : 0;
    if (dx || dy) { sc.scrollLeft += dx; sc.scrollTop += dy; this.dragMove(e); }
  }

  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    this.lastE = e;
    const { x, y } = this.local(e);
    switch (d.kind) {
      case 'colW': {
        const w = Math.max(8, d.orig + (e.clientX - d.start) / this.z);
        if (d.sel) for (let c = d.sel.c1; c <= Math.min(d.sel.c2, 500); c++) this.sh.colW.set(c, w); else this.sh.colW.set(d.idx, w);
        this.relayout(); break;
      }
      case 'rowH': this.sh.rowH.set(d.idx, Math.max(4, d.orig + (e.clientY - d.start) / this.z)); this.relayout(); break;
      case 'sel': {
        const r = this.rowAt(Math.max(HDR_H, y)), c = this.colAt(Math.max(HDR_W, x));
        this.focus = { r, c };
        this.setSel(this.act.r, this.act.c, r, c); break;
      }
      case 'selCol': { const c = this.colAt(Math.max(HDR_W, x)); this.setSel(0, d.from, MAXR - 1, c); break; }
      case 'selRow': { const r = this.rowAt(Math.max(HDR_H, y)); this.setSel(d.from, 0, r, MAXC - 1); break; }
      case 'point': { const r = this.rowAt(Math.max(HDR_H, y)), c = this.colAt(Math.max(HDR_W, x)); this.app.pointRef(d.r, d.c, r, c); break; }
      case 'fill': {
        const r = this.rowAt(Math.max(HDR_H, y)), c = this.colAt(Math.max(HDR_W, x)), s = d.src;
        const dv = r > s.r2 ? r - s.r2 : r < s.r1 ? r - s.r1 : 0, dh = c > s.c2 ? c - s.c2 : c < s.c1 ? c - s.c1 : 0;
        if (Math.abs(dv) >= Math.abs(dh) && dv !== 0) this.fillPreview = dv > 0 ? { r1: s.r1, r2: r, c1: s.c1, c2: s.c2 } : { r1: r, r2: s.r2, c1: s.c1, c2: s.c2 };
        else if (dh !== 0) this.fillPreview = dh > 0 ? { r1: s.r1, r2: s.r2, c1: s.c1, c2: c } : { r1: s.r1, r2: s.r2, c1: c, c2: s.c2 };
        else this.fillPreview = null;
        this.invalidate(); break;
      }
    }
  }

  dragEnd() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'colW' || d.kind === 'rowH') this.app.layoutChanged(d);
    if (d.kind === 'fill') {
      const p = this.fillPreview;
      this.fillPreview = null;
      if (p) this.app.autoFill(d.src, p);
      this.invalidate();
    }
    this.app.focusSink();
  }

  dbl(e) {
    if (this.onScrollbar(e)) return;
    const { x, y } = this.local(e);
    const h = this.hit(x, y);
    if (h.zone === 'colEdge') { this.app.autofitCol(h.c); return; }
    if (h.zone === 'rowEdge') { this.app.autofitRow(h.r); return; }
    if (h.zone === 'cell') this.app.beginEdit(null, 'edit');
  }

  ctxMenu(e) {
    e.preventDefault();
    const h = this.pendingCtx || this.hit(...Object.values(this.local(e)));
    if (h.zone === 'cell' && !(h.r >= this.sel.r1 && h.r <= this.sel.r2 && h.c >= this.sel.c1 && h.c <= this.sel.c2)) this.moveActive(h.r, h.c, false);
    if (h.zone === 'col' && !(h.c >= this.sel.c1 && h.c <= this.sel.c2 && this.sel.r2 >= MAXR - 1)) this.setSel(0, h.c, MAXR - 1, h.c, { r: 0, c: h.c });
    if (h.zone === 'row' && !(h.r >= this.sel.r1 && h.r <= this.sel.r2 && this.sel.c2 >= MAXC - 1)) this.setSel(h.r, 0, h.r, MAXC - 1, { r: h.r, c: 0 });
    this.app.contextMenu(e.clientX, e.clientY, h.zone);
  }

  // ---------- helpers for the app ----------
  measureCol(c) {
    const { ctx, sh, wb } = this;
    let w = 0;
    for (const [k, cell] of sh.cells) {
      if (k % 16384 !== c) continue;
      const r = Math.floor(k / 16384);
      const st = wb.styles[cell.s];
      const d = displayValue(sh.get(r, c), st.nf);
      if (!d.text) continue;
      ctx.font = this.font(st);
      w = Math.max(w, ctx.measureText(d.text.split('\n')[0]).width / this.z + 12);
    }
    return Math.max(24, Math.min(600, Math.ceil(w)));
  }
  measureRow(r) {
    const { ctx, sh, wb } = this;
    let h = DEF_H;
    for (const [k, cell] of sh.cells) {
      if (Math.floor(k / 16384) !== r) continue;
      const st = wb.styles[cell.s], c = k % 16384;
      const lh = (st.sz || 11) * PT * 1.25 + 6;
      h = Math.max(h, lh);
      if (st.wr) {
        const d = displayValue(sh.get(r, c), st.nf);
        ctx.font = this.font(st);
        const lines = this.wrap(d.text, (sh.colW.get(c) ?? DEF_W) * this.z - 8).length;
        h = Math.max(h, Math.ceil(lines * (st.sz || 11) * PT * 1.25 + 6));
      }
    }
    return Math.ceil(h);
  }
}

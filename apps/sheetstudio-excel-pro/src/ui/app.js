// Application shell: state, editing, keyboard, clipboard, sheets, status bar, persistence.
import { Workbook, K, keyR, keyC, MAXR, MAXC, dvAt, dvCheck, dvList, displayValue } from '../engine.js';
import { F } from '../functions.js';
import { parse, colName, cellName, parseRefText, formatRef } from '../parser.js';
import { numStr, parseInput, isErr, textToNum } from '../core.js';
import { format, isDateFormat } from '../numfmt.js';
import { parseCSV } from '../csv.js';
import { Grid, HDR_W, HDR_H, DEF_W, DEF_H } from './grid.js';
import { HINTS, HINT } from './hints.js';
import { chartData, chartSVG } from './chart.js';
import { tableColumns, escCol } from '../tables.js';
import { h, $, toast, menu, closeMenu, dialog, download } from './util.js';

const cloneJ = (x) => JSON.parse(JSON.stringify(x));
const ALLFN = [...new Set([...HINTS.map((x) => x.n), ...Object.keys(F)])].sort();

export class App {
  constructor() {
    this.wb = new Workbook();
    this.sh = this.wb.sheets[0];
    this.editing = null; this.clip = null; this.fileName = ''; this.handle = null; this.modified = false; this.pt = null; this.ac = null;
    this.selChart = null; this.chartEls = new Map();
    this.grid = new Grid($('#gridwrap'), this);
    this.sink = $('#sink'); this.editor = $('#editor'); this.fin = $('#fin'); this.namebox = $('#namebox');
    this.bindWorkbook();
    this.bindEvents();
    this.grid.resize();
    this.renderSheets();
    this.onSelect();
    try { this.restoreTheme(); } catch {}
    this.checkRecovery();
  }

  // ---------- workbook plumbing ----------
  bindWorkbook() {
    this.wb.onChange = () => {
      this.grid.relayout();
      this.wb.warm();
      this.modified = true;
      this.scheduleSave();
      this.updateTitle();
      this.refreshBars();
    };
  }
  setWorkbook(wb, name = '') {
    this.cancelEdit();
    this.wb = wb;
    this.sh = wb.sheets[0];
    this.bindWorkbook();
    this.fileName = name;
    this.handle = null;
    this.clip = null; this.grid.ants = null;
    this.grid.extR = 200; this.grid.extC = 40;
    this.grid.sc.scrollLeft = 0; this.grid.sc.scrollTop = 0;
    this.grid.sel = { r1: 0, c1: 0, r2: 0, c2: 0 }; this.grid.act = { r: 0, c: 0 };
    wb.warm();
    this.modified = false;
    $('#title').value = name.replace(/\.[^.]+$/, '') || 'Untitled workbook';
    this.renderSheets(); this.grid.relayout(); this.onSelect(); this.syncCharts(true);
    this.updateTitle();
    if (wb.warnings && wb.warnings.length) toast(wb.warnings.join(' '), 7000);
  }
  get title() { return $('#title').value.trim() || 'Untitled workbook'; }
  updateTitle() { document.title = (this.modified ? '• ' : '') + this.title + ' – SheetStudio Excel Pro'; }
  focusSink() { if (!this.editing) this.sink.focus({ preventScroll: true }); }

  // run a user action as one undo step and keep the grid repainted
  run(fn) {
    try { return this.wb.tx(fn); } catch (e) { console.error(e); toast('Something went wrong: ' + (e && e.message ? e.message : e)); }
  }

  // Record a structural property change (merges, charts, freeze...) as undoable.
  prop(name, fn) {
    const sh = this.sh;
    this.run(() => {
      const before = cloneJ(sh[name]);
      fn();
      const after = cloneJ(sh[name]);
      this.wb.rec(() => { sh[name] = cloneJ(before); }, () => { sh[name] = cloneJ(after); });
    });
  }

  // ---------- selection / bars ----------
  get sel() { return this.grid.sel; }
  get act() { return this.grid.act; }
  addr(s = this.sel) {
    const whole = (s.r1 === 0 && s.r2 >= MAXR - 1) ? 'col' : (s.c1 === 0 && s.c2 >= MAXC - 1) ? 'row' : '';
    if (whole === 'col') return s.c1 === s.c2 ? `${colName(s.c1)}:${colName(s.c1)}` : `${colName(s.c1)}:${colName(s.c2)}`;
    if (whole === 'row') return `${s.r1 + 1}:${s.r2 + 1}`;
    return s.r1 === s.r2 && s.c1 === s.c2 ? cellName(s.r1, s.c1) : `${cellName(s.r1, s.c1)}:${cellName(s.r2, s.c2)}`;
  }
  qaddr(s = this.sel) { const a = this.addr(s); return /^[\w.]+$/.test(this.sh.name) ? `${this.sh.name}!${a}` : `'${this.sh.name.replace(/'/g, "''")}'!${a}`; }
  cellText(r, c) {
    const cell = this.sh.cell(r, c);
    if (!cell) return '';
    if (cell.f != null) return '=' + cell.f;
    const v = cell.v, nf = this.wb.styles[cell.s].nf;
    if (v === null) return '';
    if (typeof v === 'number') {
      if (nf && isDateFormat(nf)) return format(v, nf).text;
      if (nf && /%$/.test(nf)) return numStr(Math.round(v * 1e10) / 1e8) + '%';
      return numStr(v);
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (isErr(v)) return v.c;
    const p = parseInput(v);
    return p.v !== v || v[0] === "'" || v[0] === '=' ? "'" + v : v;
  }
  onSelect() {
    const g = this.grid;
    if (!g.sel) return;
    this.sh.view = { sel: { ...g.sel }, act: { ...g.act } };
    if (document.activeElement !== this.namebox) this.namebox.value = this.nameFor(g.sel) || this.addr();
    this.refreshBars();
  }
  nameFor(s) {
    const a = this.qaddr(s).replace(/\$/g, '');
    for (const [n, d] of this.wb.names) if (d.f.replace(/\$/g, '') === a) return n;
    return '';
  }
  refreshBars() {
    if (!this.editing && document.activeElement !== this.fin) {
      const t = this.cellText(this.act.r, this.act.c);
      this.fin.value = t;
      this.fin.classList.toggle('tall', t.includes('\n'));
    }
    this.updateStats();
    this.updateRibbonState && this.updateRibbonState();
    const v = this.sh.display(this.act.r, this.act.c).text;
    $('#live').textContent = `${cellName(this.act.r, this.act.c)}${v ? ': ' + v : ', empty'}`;
  }
  updateStats() {
    const s = this.sel, sh = this.sh;
    let n = 0, cnt = 0, sum = 0, mn = Infinity, mx = -Infinity;
    const area = (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
    const visit = (v) => { if (v == null) return; cnt++; if (typeof v === 'number') { n++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; } };
    if (area > 1) {
      if (area > 2 * (sh.cells.size + sh.spillVals.size) + 64) {
        for (const k of [...sh.cells.keys(), ...sh.spillVals.keys()]) { const r = keyR(k), c = keyC(k); if (r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) visit(sh.get(r, c)); }
      } else for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) visit(sh.get(r, c));
    }
    const f = (x) => format(x, 'General').text;
    const parts = [];
    if (cnt > 1 || n) {
      if (n) parts.push(h('span', null, 'Average ', h('b', null, f(sum / n))));
      parts.push(h('span', null, 'Count ', h('b', null, String(cnt))));
      if (n) parts.push(h('span', null, 'Sum ', h('b', null, f(sum))), h('span', null, 'Min ', h('b', null, f(mn))), h('span', null, 'Max ', h('b', null, f(mx))));
    }
    $('#stats').replaceChildren(...parts);
  }

  // ---------- sheets ----------
  renderSheets() {
    const box = $('#sheets');
    box.replaceChildren(...this.wb.sheets.map((s) => h('button', {
      class: 'stab', role: 'tab', 'aria-selected': s === this.sh ? 'true' : 'false', type: 'button',
      onclick: () => this.switchSheet(s), ondblclick: () => this.renameSheet(s),
      oncontextmenu: (e) => { e.preventDefault(); this.switchSheet(s); this.sheetMenu(e); },
    }, s.name)), h('button', { class: 'stab-add', type: 'button', title: 'Add sheet', 'aria-label': 'Add sheet', onclick: () => this.addSheet() }, '+'));
    box.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  switchSheet(s) {
    if (s === this.sh) return;
    if (this.editing) this.commitEdit(0, 0);
    this.sh.view = { sel: { ...this.grid.sel }, act: { ...this.grid.act }, sx: this.grid.sc.scrollLeft, sy: this.grid.sc.scrollTop };
    this.sh = s;
    const v = s.view || { sel: { r1: 0, c1: 0, r2: 0, c2: 0 }, act: { r: 0, c: 0 } };
    this.grid.sel = { ...v.sel }; this.grid.act = { ...v.act };
    this.grid.layout();
    this.grid.sc.scrollLeft = v.sx || 0; this.grid.sc.scrollTop = v.sy || 0;
    this.grid.relayout();
    this.selChart = null;
    this.renderSheets(); this.onSelect(); this.syncCharts(true); this.focusSink();
  }
  addSheet() { const s = this.run(() => this.wb.addSheet()); this.renderSheets(); this.switchSheet(s); }
  async renameSheet(s) {
    const v = await dialog('Rename sheet', [{ name: 'n', label: 'Sheet name', value: s.name }]);
    if (!v) return;
    const err = this.wb.renameSheet(s, v.n);
    if (err) toast(err); else { this.renderSheets(); this.grid.invalidate(); }
  }
  sheetMenu(e) {
    const s = this.sh, wb = this.wb, i = wb.sheets.indexOf(s);
    menu([
      { label: 'Insert sheet', onclick: () => this.addSheet() },
      { label: 'Rename…', onclick: () => this.renameSheet(s) },
      { label: 'Duplicate', onclick: () => { const n = wb.duplicateSheet(s); this.renderSheets(); this.switchSheet(n); } },
      { label: 'Move left', disabled: i === 0, onclick: () => { wb.moveSheet(s, i - 1); this.renderSheets(); } },
      { label: 'Move right', disabled: i === wb.sheets.length - 1, onclick: () => { wb.moveSheet(s, i + 1); this.renderSheets(); } },
      { sep: true },
      { label: 'Delete', disabled: wb.sheets.length < 2, onclick: () => { const nx = wb.sheets[i + 1] || wb.sheets[i - 1]; wb.removeSheet(s); this.sh = nx; this.switchSheetForce(nx); toast(`Deleted "${s.name}" (Ctrl+Z to undo)`); } },
    ], null, { x: e.clientX, y: e.clientY });
  }
  switchSheetForce(s) { this.sh = s; const v = s.view || { sel: { r1: 0, c1: 0, r2: 0, c2: 0 }, act: { r: 0, c: 0 } }; this.grid.sel = { ...v.sel }; this.grid.act = { ...v.act }; this.renderSheets(); this.grid.relayout(); this.onSelect(); this.syncCharts(true); }

  // ---------- editing ----------
  beginEdit(initial, mode, fromBar) {
    if (this.editing) return;
    const { r, c } = this.act;
    if (this.sh.isSpilled(r, c)) { toast('This cell is part of a spilled array. Edit the formula in the top-left cell.'); return; }
    const text = initial == null ? this.cellText(r, c) : initial;
    this.editing = { r, c, mode, bar: !!fromBar, sheet: this.sh };
    const ed = this.editor;
    const rc = this.grid.cellRect(r, c);
    const st = this.wb.styles[this.sh.styleAt(r, c)];
    ed.value = text;
    ed.style.cssText = `display:block;left:${rc.x}px;top:${rc.y}px;min-width:${Math.max(rc.w, 40)}px;height:${Math.max(rc.h, 22)}px;font:${this.grid.font(st)};text-align:${st.ha || 'left'}`;
    this.fin.value = text;
    this.fitEditor();
    if (fromBar) this.fin.focus(); else { ed.focus(); const n = text.length; ed.setSelectionRange(n, n); }
    this.updateAc();
  }
  fitEditor() {
    const ed = this.editor, rc = this.grid.cellRect(this.editing.r, this.editing.c);
    const lines = ed.value.split('\n');
    const m = this.grid.ctx; m.font = getComputedStyle(ed).font;
    const w = Math.max(...lines.map((l) => m.measureText(l).width)) + 20;
    ed.style.width = Math.min(Math.max(rc.w, w), this.grid.W - rc.x - 6) + 'px';
    ed.style.height = Math.max(rc.h, lines.length * 18 + 4) + 'px';
  }
  editText() { return this.editing ? (this.editing.bar ? this.fin.value : this.editor.value) : ''; }
  setEditText(t, caret) {
    this.editor.value = t; this.fin.value = t;
    const el = this.editing.bar ? this.fin : this.editor;
    if (caret != null) el.setSelectionRange(caret, caret);
    this.fitEditor();
  }
  caret() { const el = this.editing.bar ? this.fin : this.editor; return el.selectionStart; }
  closeEditor() {
    this.editing = null; this.pt = null;
    this.editor.style.display = 'none'; $('#ac').style.display = 'none'; this.ac = null;
    this.fin.classList.remove('tall');
  }
  cancelEdit() { if (!this.editing) return; this.closeEditor(); this.refreshBars(); this.focusSink(); this.grid.invalidate(); }
  commitEdit(dr, dc) {
    const ed = this.editing;
    if (!ed) return true;
    const text = this.editText();
    const { r, c } = ed;
    if (text.length > 1 && text[0] === '=') {
      try { parse(text.slice(1)); } catch (e) { toast('There is a problem with this formula: ' + e.message); return false; }
    }
    if (this.sh !== ed.sheet) this.sh = ed.sheet;
    const p = text[0] === '=' ? null : parseInput(text);
    const dv = dvCheck(this.sh, r, c, text[0] === '=' ? null : p.v);
    if (dv) { toast(dv); return false; }
    this.closeEditor();
    const old = this.sh.get(r, c);
    this.run(() => { this.sh.setInput(r, c, text); this.afterTableEdit(r, c, old); });
    this.focusSink();
    if (dr || dc) this.step(dr, dc); else this.refreshBars();
    return true;
  }
  // Tables grow when you type directly beneath them; renaming a header rewrites structured references.
  afterTableEdit(r, c, old) {
    const sh = this.sh, wb = this.wb;
    for (const t of sh.tables) {
      if (t.header !== false && r === t.r1 && c >= t.c1 && c <= t.c2) {
        const cell = sh.cell(r, c);
        if (typeof old === 'string' && cell && cell.f == null && typeof cell.v === 'string' && cell.v !== old) wb.renameTableColumn(sh, t, old, cell.v);
      } else if (sh.cell(r, c) && ((r === t.r2 + 1 && !t.totals && c >= t.c1 && c <= t.c2) || (r === t.r1 && c === t.c2 + 1 && t.header !== false && typeof sh.cell(r, c).v === 'string'))) {
        const before = cloneJ(sh.tables), fb = cloneJ(sh.filter), grow = r === t.r1;
        const f = sh.filter;
        if (grow) { t.c2++; if (f && f.r1 === t.r1 && f.c1 === t.c1 && f.c2 === t.c2 - 1) f.c2++; } else { t.r2++; if (f && f.r1 === t.r1 && f.c1 === t.c1 && f.r2 === t.r2 - 1 && f.c2 === t.c2) f.r2++; }
        const after = cloneJ(sh.tables), fa = cloneJ(sh.filter);
        wb.rec(() => { sh.tables = cloneJ(before); sh.filter = cloneJ(fb); wb.applyFilters(); }, () => { sh.tables = cloneJ(after); sh.filter = cloneJ(fa); wb.applyFilters(); });
      }
    }
  }
  step(dr, dc) {
    const g = this.grid, s = g.sel, a = g.act;
    const multi = s.r1 !== s.r2 || s.c1 !== s.c2;
    let r = a.r + dr, c = a.c + dc;
    if (multi && !(this.sh.mergeAt(s.r1, s.c1) && s.r1 === this.sh.mergeAt(s.r1, s.c1).r1 && s.r2 === this.sh.mergeAt(s.r1, s.c1).r2 && s.c1 === this.sh.mergeAt(s.r1, s.c1).c1 && s.c2 === this.sh.mergeAt(s.r1, s.c1).c2)) {
      // move inside the selection, wrapping
      if (c > s.c2) { c = s.c1; r++; } else if (c < s.c1) { c = s.c2; r--; }
      if (r > s.r2) { r = s.r1; c++; if (c > s.c2) c = s.c1; } else if (r < s.r1) { r = s.r2; c--; if (c < s.c1) c = s.c2; }
      g.act = { r, c };
      g.focus = { r, c };
      g.ensureVisible(r, c); g.invalidate(); this.onSelect();
      return;
    }
    const m = this.sh.mergeAt(a.r, a.c);
    if (m) { if (dr > 0) r = m.r2 + 1; if (dc > 0) c = m.c2 + 1; }
    g.moveActive(r, c, false);
  }

  // Formula pointing: clicking cells while typing a formula inserts references.
  canPoint() {
    if (!this.editing) return false;
    const t = this.editText();
    if (t[0] !== '=') return false;
    if (this.pt) return true;
    const before = t.slice(0, this.caret()).replace(/\s+$/, '');
    return before === '=' || /[=(+\-*/^&<>,:;]$/.test(before) && !(before.match(/"/g) || []).length % 2;
  }
  pointRef(r1, c1, r2, c2) {
    if (!this.editing) return;
    const t = this.editText();
    if (!this.pt) { const p = this.caret(); this.pt = { s: p, e: p }; }
    const same = r1 === r2 && c1 === c2;
    const a = Math.min(r1, r2), b = Math.max(r1, r2), c = Math.min(c1, c2), d = Math.max(c1, c2);
    const ref = (same ? cellName(a, c) : `${cellName(a, c)}:${cellName(b, d)}`);
    this.setEditText(t.slice(0, this.pt.s) + ref + t.slice(this.pt.e), this.pt.s + ref.length);
    this.pt.e = this.pt.s + ref.length;
    this.pt.cell = { r: r2, c: c2 };
    this.grid.invalidate();
  }
  endPoint() { this.pt = null; }
  toggleAbs() {
    const el = this.editing.bar ? this.fin : this.editor, t = el.value, p = el.selectionStart;
    const re = /\$?[A-Za-z]{1,3}\$?\d+/g;
    let m;
    while ((m = re.exec(t))) {
      if (p >= m.index && p <= m.index + m[0].length) {
        const x = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(m[0]);
        const n = !x[1] && !x[3] ? `$${x[2]}$${x[4]}` : x[1] && x[3] ? `${x[2]}$${x[4]}` : !x[1] && x[3] ? `$${x[2]}${x[4]}` : `${x[2]}${x[4]}`;
        this.setEditText(t.slice(0, m.index) + n + t.slice(m.index + m[0].length), m.index + n.length);
        return;
      }
    }
  }

  // Function-name autocomplete
  updateAc() {
    const box = $('#ac');
    if (!this.editing || this.editText()[0] !== '=') { box.style.display = 'none'; this.ac = null; return; }
    const t = this.editText().slice(0, this.caret());
    const tm = /([A-Za-z_][\w.]*)?\[(@?)([^[\]]*)$/.exec(t); // Table1[ ... column suggestions
    if (tm && !(t.match(/"/g) || []).length % 2) {
      const f = tm[1] ? this.wb.table(tm[1]) : this.sh.tables.length ? { sh: this.sh, t: this.sh.tables.find((x) => this.editing.r >= x.r1 && this.editing.r <= x.r2) } : null;
      if (f && f.t) {
        const cols = tableColumns(f.sh, f.t).filter((n) => n.toLowerCase().startsWith(tm[3].toLowerCase())).slice(0, 9);
        if (cols.length) { this.ac = { names: cols, i: 0, start: t.length - tm[3].length, len: tm[3].length, col: true }; this.renderAc(); return; }
      }
    }
    const m = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(t);
    if (!m || (t.match(/"/g) || []).length % 2 || /[A-Za-z0-9_.]$/.test(t.slice(0, m.index))) { box.style.display = 'none'; this.ac = null; return; }
    const p = m[1].toUpperCase();
    const tnames = this.wb.sheets.flatMap((s) => s.tables.map((x) => x.name));
    const names = [...ALLFN, ...[...this.wb.names.keys()], ...tnames].filter((n) => n.toUpperCase().startsWith(p) && n.toUpperCase() !== p).slice(0, 9);
    if (!names.length) { box.style.display = 'none'; this.ac = null; return; }
    this.ac = { names, i: 0, start: m.index, len: m[1].length };
    this.renderAc();
  }
  renderAc() {
    const box = $('#ac'), rc = this.grid.cellRect(this.editing.r, this.editing.c);
    box.replaceChildren(...this.ac.names.map((n, i) => {
      const hnt = HINT.get(n);
      return h('div', { class: i === this.ac.i ? 'on' : '', role: 'option', onmousedown: (e) => { e.preventDefault(); this.ac.i = i; this.acceptAc(); } }, h('b', null, n), h('small', null, hnt ? `(${hnt.a})` : this.ac.col ? 'column' : ''));
    }));
    box.style.display = 'block';
    box.style.left = Math.max(0, Math.min(rc.x, this.grid.W - 300)) + 'px';
    box.style.top = (rc.y + Math.max(rc.h, parseFloat(this.editor.style.height) || rc.h) + 2) + 'px';
  }
  acceptAc() {
    const { names, i, start, len, col } = this.ac;
    const t = this.editText(), p = this.caret();
    const n = names[i], isFn = !col && (F[n.toUpperCase()] || HINT.has(n));
    const ins = col ? escCol(n) + ']' : n + (isFn ? '(' : '');
    this.setEditText(t.slice(0, start) + ins + t.slice(start + len + (p - start - len)), start + ins.length);
    this.updateAc();
  }

  onEditKey(e) {
    const ed = this.editing;
    if (!ed) return;
    if (this.ac && ['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key) && !e.shiftKey && !e.ctrlKey) {
      if (e.key === 'ArrowDown') this.ac.i = (this.ac.i + 1) % this.ac.names.length;
      else if (e.key === 'ArrowUp') this.ac.i = (this.ac.i - 1 + this.ac.names.length) % this.ac.names.length;
      else if (e.key === 'Tab') { this.acceptAc(); e.preventDefault(); return; }
      else { $('#ac').style.display = 'none'; this.ac = null; e.preventDefault(); e.stopPropagation(); return; }
      this.renderAc(); e.preventDefault(); return;
    }
    switch (e.key) {
      case 'Enter':
        if (e.altKey) { const el = ed.bar ? this.fin : this.editor, p = el.selectionStart; this.setEditText(el.value.slice(0, p) + '\n' + el.value.slice(el.selectionEnd), p + 1); e.preventDefault(); return; }
        e.preventDefault(); if (e.ctrlKey) { this.fillSelectionWithEdit(); return; }
        this.commitEdit(e.shiftKey ? -1 : 1, 0); return;
      case 'Tab': e.preventDefault(); this.commitEdit(0, e.shiftKey ? -1 : 1); return;
      case 'Escape': e.preventDefault(); e.stopPropagation(); this.cancelEdit(); return;
      case 'F2': e.preventDefault(); ed.mode = ed.mode === 'edit' ? 'enter' : 'edit'; return;
      case 'F4': e.preventDefault(); this.toggleAbs(); return;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
        if (ed.mode !== 'enter' && !(this.canPoint() && this.pt)) { this.pt = null; setTimeout(() => this.updateAc()); return; }
        e.preventDefault();
        const dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0, dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (this.editText()[0] === '=' && this.canPoint()) {
          const from = this.pt && this.pt.cell ? this.pt.cell : this.act;
          const r = Math.max(0, from.r + dr), c = Math.max(0, from.c + dc);
          this.pointRef(r, c, r, c); this.grid.ensureVisible(r, c); return;
        }
        this.commitEdit(dr, dc); return;
      }
    }
    this.pt = null;
  }
  fillSelectionWithEdit() {
    const text = this.editText(), s = this.sel;
    this.closeEditor();
    this.run(() => { for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) this.sh.setInput(r, c, text); });
    this.focusSink();
  }

  // ---------- keyboard ----------
  jump(r, c, dr, dc) {
    const sh = this.sh, lastR = sh.maxR, lastC = sh.maxC;
    const has = (rr, cc) => sh.get(rr, cc) != null;
    const inb = (rr, cc) => rr >= 0 && cc >= 0 && rr < MAXR && cc < MAXC;
    const edge = [dr > 0 ? MAXR - 1 : dr < 0 ? 0 : r, dc > 0 ? MAXC - 1 : dc < 0 ? 0 : c];
    let rr = r + dr, cc = c + dc;
    if (!inb(rr, cc)) return [r, c];
    if (has(r, c) && has(rr, cc)) { // run of data: go to its end
      while (inb(rr + dr, cc + dc) && has(rr + dr, cc + dc)) { rr += dr; cc += dc; }
      return [rr, cc];
    }
    while (inb(rr, cc) && !has(rr, cc)) { // gap: go to the next data
      if ((dr > 0 && rr > lastR) || (dc > 0 && cc > lastC)) return edge;
      rr += dr; cc += dc;
    }
    return inb(rr, cc) ? [rr, cc] : edge;
  }

  onKey(e) {
    const g = this.grid, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, k = e.key;
    if (this.editing) return;
    const nav = (dr, dc) => {
      const f = g.focus || g.act;
      if (ctrl) { const [r, c] = this.jump(f.r, f.c, dr, dc); g.moveActive(r, c, shift); }
      else g.moveActive(f.r + dr, f.c + dc, shift);
      e.preventDefault();
    };
    switch (k) {
      case 'ArrowUp': return nav(-1, 0);
      case 'ArrowDown': return nav(1, 0);
      case 'ArrowLeft': return nav(0, -1);
      case 'ArrowRight': return nav(0, 1);
      case 'PageDown': case 'PageUp': {
        const n = Math.max(1, Math.floor((g.H - HDR_H) / (DEF_H * g.z)) - 1) * (k === 'PageUp' ? -1 : 1);
        if (e.altKey) g.moveActive(this.act.r, this.act.c + (k === 'PageUp' ? -8 : 8), shift); else g.moveActive((g.focus || this.act).r + n, (g.focus || this.act).c, shift);
        e.preventDefault(); return;
      }
      case 'Home': g.moveActive(ctrl ? 0 : this.act.r, 0, shift); e.preventDefault(); return;
      case 'End': if (ctrl) { g.moveActive(Math.max(0, this.sh.maxR), Math.max(0, this.sh.maxC), shift); } else g.moveActive(this.act.r, Math.max(0, this.sh.maxC), shift); e.preventDefault(); return;
      case 'Enter': this.step(shift ? -1 : 1, 0); e.preventDefault(); return;
      case 'Tab': this.step(0, shift ? -1 : 1); e.preventDefault(); return;
      case 'F2': this.beginEdit(null, 'edit'); e.preventDefault(); return;
      case 'Delete': case 'Backspace': if (this.selChart) { this.deleteChart(this.selChart); } else this.clearSelection('contents'); e.preventDefault(); return;
      case 'Escape': this.grid.ants = null; this.clip = this.clip && this.clip.cut ? null : this.clip; this.grid.invalidate(); closeMenu(); return;
      case ' ': if (ctrl) { g.setSel(0, this.act.c, MAXR - 1, g.sel.c2, this.act); e.preventDefault(); return; } if (shift) { g.setSel(this.act.r, 0, g.sel.r2, MAXC - 1, this.act); e.preventDefault(); return; } break;
      case 'F4': this.repeatLast && this.repeatLast(); e.preventDefault(); return;
      case 'F9': this.wb.dirty(); e.preventDefault(); return;
    }
    if (ctrl && !e.altKey) {
      const key = k.toLowerCase();
      const map = {
        z: () => this.undo(), y: () => this.redo(), a: () => g.setSel(0, 0, MAXR - 1, MAXC - 1, { r: 0, c: 0 }),
        b: () => this.toggleStyle('b'), i: () => this.toggleStyle('i'), u: () => this.toggleStyle('u'),
        d: () => this.fillDir('down'), r: () => this.fillDir('right'), f: () => this.cmd('find'), h: () => this.cmd('find'), s: () => this.cmd(shift ? 'saveAs' : 'save'), o: () => this.cmd('open'),
        p: () => this.cmd('print'), k: () => this.cmd('find'), g: () => { this.namebox.focus(); this.namebox.select(); },
        n: () => this.cmd('new'), l: () => this.cmd('filter'), '`': () => { g.showFormulas = !g.showFormulas; g.invalidate(); },
        ';': () => this.run(() => this.sh.setValue(this.act.r, this.act.c, ymdNow()) || this.sh.setStyle(this.act.r, this.act.c, this.wb.mergeStyle(this.sh.styleAt(this.act.r, this.act.c), { nf: 'yyyy-mm-dd' }))),
        '+': () => this.cmd('insertCells'), '-': () => this.cmd('deleteCells'), '1': () => this.cmd('formatCells'), '5': () => this.toggleStyle('st'),
      };
      if (map[key]) { map[key](); e.preventDefault(); return; }
      if (key === 'c' || key === 'x' || key === 'v') return; // handled by clipboard events
    }
    if (e.altKey && k === '=') { this.cmd('autosum'); e.preventDefault(); return; }
    if (!ctrl && !e.altKey && k.length === 1) { this.beginEdit(k, 'enter'); e.preventDefault(); }
  }

  undo() { if (this.editing) return; if (!this.wb.undo()) toast('Nothing to undo'); this.afterHistory(); }
  redo() { if (this.editing) return; if (!this.wb.redo()) toast('Nothing to redo'); this.afterHistory(); }
  afterHistory() { this.renderSheets(); if (!this.wb.sheets.includes(this.sh)) this.switchSheetForce(this.wb.sheets[0]); this.syncCharts(true); this.grid.relayout(); this.refreshBars(); }

  clearSelection(what) {
    const s = this.sel;
    this.run(() => this.sh.clear(s.r1, s.c1, Math.min(s.r2, Math.max(this.sh.maxR, s.r1)), Math.min(s.c2, Math.max(this.sh.maxC, s.c1)), what));
  }

  // ---------- clipboard ----------
  copyData(cut) {
    const s = this.sel, sh = this.sh;
    const r2 = Math.min(s.r2, Math.max(sh.maxR, s.r1)), c2 = Math.min(s.c2, Math.max(sh.maxC, s.c1));
    const blk = this.wb.copyBlock(sh, s.r1, s.c1, r2, c2);
    const rows = [];
    for (let r = s.r1; r <= r2; r++) {
      const row = [];
      for (let c = s.c1; c <= c2; c++) row.push(sh.display(r, c).text);
      rows.push(row);
    }
    const tsv = rows.map((r) => r.map((t) => (/[\t\n"]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t)).join('\t')).join('\r\n');
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const html = '<table>' + rows.map((row, i) => '<tr>' + row.map((t, j) => {
      const st = this.wb.styles[sh.styleAt(s.r1 + i, s.c1 + j)];
      const css = [st.b && 'font-weight:bold', st.i && 'font-style:italic', st.fc && `color:${st.fc}`, st.bg && `background:${st.bg}`, st.ha && `text-align:${st.ha}`].filter(Boolean).join(';');
      return `<td${css ? ` style="${css}"` : ''}>${esc(t)}</td>`;
    }).join('') + '</tr>').join('') + '</table>';
    this.clip = { blk, cut, tsv, html, src: sh };
    this.grid.ants = { sheet: sh, r1: s.r1, c1: s.c1, r2, c2 };
    this.grid.invalidate();
    return this.clip;
  }
  onCopy(e, cut) {
    if (this.editing) return;
    const c = this.copyData(cut);
    e.clipboardData.setData('text/plain', c.tsv);
    e.clipboardData.setData('text/html', c.html);
    e.preventDefault();
  }
  onPaste(e) {
    if (this.editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (this.clip && text.replace(/\r\n$/, '') === this.clip.tsv.replace(/\r\n$/, '')) this.pasteInternal('all');
    else if (text) this.pasteText(text);
  }
  pasteInternal(mode) {
    const c = this.clip;
    if (!c) { toast('Copy something in the sheet first, or press Ctrl+V.'); return; }
    const s = this.sel;
    let blk = c.blk;
    if (mode === 'transpose') {
      blk = { ...blk, h: blk.w, w: blk.h, cells: Array.from({ length: blk.w }, (_, j) => Array.from({ length: blk.h }, (_, i) => blk.cells[i][j])) };
      blk.sheet = '\u0000'; // transposed formulas are pasted as values below
    }
    const multi = (s.r2 - s.r1 + 1 > blk.h || s.c2 - s.c1 + 1 > blk.w) && s.r2 < MAXR - 1 && s.c2 < MAXC - 1;
    const opt = { values: mode === 'values', formats: mode === 'formats' };
    const repsR = multi ? Math.floor((s.r2 - s.r1 + 1) / blk.h) || 1 : 1, repsC = multi ? Math.floor((s.c2 - s.c1 + 1) / blk.w) || 1 : 1;
    this.run(() => {
      for (let i = 0; i < repsR; i++) for (let j = 0; j < repsC; j++) this.wb.pasteBlock(this.sh, s.r1 + i * blk.h, s.c1 + j * blk.w, blk, opt);
      if (c.cut && c.src === this.sh) {
        const a = this.grid.ants;
        if (a) this.sh.clear(a.r1, a.c1, a.r2, a.c2, 'all'), this.wb.pasteBlock(this.sh, s.r1, s.c1, blk, opt);
      }
    });
    if (c.cut) { this.clip = null; this.grid.ants = null; }
    this.grid.setSel(s.r1, s.c1, s.r1 + repsR * blk.h - 1, s.c1 + repsC * blk.w - 1);
  }
  pasteText(text) {
    const rows = parseCSV(text.replace(/\r?\n$/, ''), '\t');
    const s = this.sel;
    this.run(() => rows.forEach((row, i) => row.forEach((t, j) => { if (s.r1 + i < MAXR && s.c1 + j < MAXC) this.sh.setInput(s.r1 + i, s.c1 + j, t); })));
    this.grid.setSel(s.r1, s.c1, s.r1 + rows.length - 1, s.c1 + Math.max(...rows.map((r) => r.length)) - 1);
  }
  async pasteFromClipboard() {
    if (this.clip) { this.pasteInternal('all'); return; }
    try { const t = await navigator.clipboard.readText(); if (t) this.pasteText(t); } catch { toast('Press Ctrl+V to paste from another app.'); }
  }

  // ---------- charts ----------
  syncImages() {
    const host = $('#objs'), sh = this.sh, g = this.grid, z = g.z;
    for (const im of sh.images) {
      let el = this.chartEls.get(im.id);
      if (el && el.dataset.src !== String(im.data.length)) { el.remove(); this.chartEls.delete(im.id); el = null; }
      if (!el) {
        el = h('div', { class: 'chart pic', tabindex: '0', role: 'img', 'aria-label': im.alt || im.name || 'Picture', 'data-sheet': sh.name, 'data-src': String(im.data.length) }, h('img', { src: im.data, alt: im.alt || '', draggable: 'false' }), h('div', { class: 'rz' }));
        el.addEventListener('mousedown', (e) => this.chartDown(e, im, el, 'images'));
        el.addEventListener('dblclick', () => this.cmd('editImage', im));
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.selectChart(im.id); menu([{ label: 'Alt text…', onclick: () => this.cmd('editImage', im) }, { sep: true }, { label: 'Delete picture', onclick: () => this.deleteChart(im.id) }], null, { x: e.clientX, y: e.clientY }); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteChart(im.id); e.preventDefault(); } });
        host.append(el); this.chartEls.set(im.id, el);
      }
      el.style.left = (im.x * z - g.sc.scrollLeft) + 'px'; el.style.top = (im.y * z - g.sc.scrollTop) + 'px';
      el.style.width = im.w * z + 'px'; el.style.height = im.h * z + 'px';
      el.classList.toggle('sel', this.selChart === im.id);
    }
  }
  syncCharts(force) {
    const host = $('#objs'), sh = this.sh;
    const ids = new Set([...sh.charts, ...sh.images].map((c) => c.id));
    for (const [id, el] of this.chartEls) if (!ids.has(id) || el.dataset.sheet !== sh.name) { el.remove(); this.chartEls.delete(id); }
    const g = this.grid, z = g.z;
    for (const ch of sh.charts) {
      let el = this.chartEls.get(ch.id);
      if (!el) {
        el = h('div', { class: 'chart', tabindex: '0', role: 'img', 'aria-label': 'Chart: ' + (ch.title || ch.range), 'data-sheet': sh.name },
          h('div', { class: 'cs' }), h('div', { class: 'rz' }));
        el.addEventListener('mousedown', (e) => this.chartDown(e, ch, el));
        el.addEventListener('dblclick', () => this.cmd('editChart', ch));
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.selectChart(ch.id); menu([{ label: 'Edit chart…', onclick: () => this.cmd('editChart', ch) }, { label: 'Save as PNG', onclick: () => this.cmd('chartPng', ch) }, { sep: true }, { label: 'Delete chart', onclick: () => this.deleteChart(ch.id) }], null, { x: e.clientX, y: e.clientY }); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteChart(ch.id); e.preventDefault(); } });
        host.append(el); this.chartEls.set(ch.id, el);
        force = true;
      }
      const f = sh.freeze;
      el.style.left = (ch.x * z - g.sc.scrollLeft) + 'px';
      el.style.top = (ch.y * z - g.sc.scrollTop) + 'px';
      el.style.width = ch.w * z + 'px'; el.style.height = ch.h * z + 'px';
      el.classList.toggle('sel', this.selChart === ch.id);
      const key = `${this.wb.ver}|${ch.type}|${ch.range}|${ch.title}|${ch.w}|${ch.h}|${ch.stacked}|${ch.byRow}|${document.documentElement.dataset.theme || ''}`;
      if (force || el.dataset.key !== key) {
        el.dataset.key = key;
        const cs = getComputedStyle(document.documentElement);
        el.firstChild.innerHTML = chartSVG(ch, chartData(this.wb, ch), ch.w, ch.h, { fg: cs.getPropertyValue('--text').trim(), grid: cs.getPropertyValue('--grid').trim(), bg: 'transparent' });
      }
    }
    this.syncImages();
  }
  afterDraw() { if (this.sh.charts.length || this.sh.images.length || this.chartEls.size) this.syncCharts(false); }
  // hover tooltip for cell notes
  noteTip(note, e) {
    let tip = $('#notetip');
    if (!note) { if (tip) tip.style.display = 'none'; return; }
    if (!tip) { tip = h('div', { id: 'notetip', role: 'tooltip' }); document.body.append(tip); }
    tip.textContent = note.text; tip.style.display = 'block';
    tip.style.left = Math.min(innerWidth - 270, e.clientX + 14) + 'px'; tip.style.top = Math.min(innerHeight - 100, e.clientY + 14) + 'px';
  }
  selectChart(id) { this.selChart = id; this.syncCharts(false); this.chartEls.get(id)?.focus(); }
  chartDown(e, ch, el, kind = 'charts') {
    if (e.button !== 0) return;
    this.selectChart(ch.id);
    const resize = e.target.classList.contains('rz');
    const sx = e.clientX, sy = e.clientY, o = { x: ch.x, y: ch.y, w: ch.w, h: ch.h }, z = this.grid.z, pic = kind === 'images';
    const before = cloneJ(this.sh[kind]);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (resize) { ch.w = Math.max(pic ? 16 : 160, Math.round(o.w + dx)); ch.h = pic ? Math.round(ch.w * o.h / o.w) : Math.max(110, Math.round(o.h + dy)); } else { ch.x = Math.max(0, Math.round(o.x + dx)); ch.y = Math.max(0, Math.round(o.y + dy)); }
      this.syncCharts(false);
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      const after = cloneJ(this.sh[kind]), sh = this.sh;
      if (JSON.stringify(before) !== JSON.stringify(after)) { sh[kind] = cloneJ(before); this.run(() => { sh[kind] = cloneJ(after); this.wb.rec(() => { sh[kind] = cloneJ(before); }, () => { sh[kind] = cloneJ(after); }); }); }
      this.syncCharts(true);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    e.preventDefault();
  }
  deleteChart(id) {
    const kind = this.sh.images.some((i) => i.id === id) ? 'images' : 'charts';
    this.prop(kind, () => { this.sh[kind] = this.sh[kind].filter((c) => c.id !== id); });
    this.selChart = null; this.syncCharts(true); this.focusSink();
  }

  // ---------- zoom / theme ----------
  setZoom(z) {
    z = Math.max(0.5, Math.min(2, Math.round(z * 10) / 10));
    const g = this.grid, sc = g.sc, k = z / g.z;
    g.z = z;
    $('#zoom').value = Math.round(z * 100); $('#zv').textContent = Math.round(z * 100) + '%';
    g.layout();
    sc.scrollLeft *= k; sc.scrollTop *= k;
    g.relayout(); this.syncCharts(true);
  }
  setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('sheetstudio-theme', t); } catch {}
    this.grid.readTheme(); this.syncCharts(true);
  }
  restoreTheme() { const t = localStorage.getItem('sheetstudio-theme'); if (t) document.documentElement.dataset.theme = t; this.grid.readTheme(); }

  // ---------- persistence (recovery copy in IndexedDB) ----------
  idb() {
    return new Promise((res, rej) => {
      const q = indexedDB.open('sheetstudio', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  scheduleSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(async () => {
      try {
        const json = JSON.stringify({ title: this.title, at: Date.now(), wb: this.wb.toJSON() });
        if (json.length > 40e6) return;
        const db = await this.idb();
        db.transaction('kv', 'readwrite').objectStore('kv').put(json, 'recovery');
        $('#saved').textContent = 'Recovery copy saved';
      } catch { /* private mode etc. */ }
    }, 1800);
  }
  async checkRecovery() {
    try {
      const db = await this.idb();
      const json = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('recovery'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      if (!json) return;
      const d = JSON.parse(json);
      if (!d.wb || !d.wb.sheets.some((s) => s.cells.length)) return;
      const bar = h('div', { class: 'banner', role: 'alert' }, `Unsaved workbook "${d.title}" from ${new Date(d.at).toLocaleString()} was found.`,
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => { this.setWorkbook(Workbook.fromJSON(d.wb), d.title); $('#title').value = d.title; bar.remove(); } }, 'Restore'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => bar.remove() }, 'Dismiss'));
      $('#app').insertBefore(bar, $('#tabs'));
    } catch { /* no recovery available */ }
  }

  contextMenu(x, y, zone) { this.cmd('contextMenu', { x, y, zone }); }
  showDvList() {
    const { r, c } = this.act, dv = dvAt(this.sh, r, c);
    if (!dv) return;
    const rc = this.grid.cellRect(r, c), box = $('#gridwrap').getBoundingClientRect();
    menu(dvList(this.sh, dv).slice(0, 200).map((v) => ({ label: v, onclick: () => { this.run(() => this.sh.setInput(r, c, v)); this.focusSink(); } })), null, { x: box.left + rc.x, y: box.top + rc.y + rc.h });
  }
  layoutChanged(d) {
    const sh = this.sh, g = this.grid;
    if (d.kind === 'colW') {
      const cols = d.sel ? Array.from({ length: Math.min(d.sel.c2, 500) - d.sel.c1 + 1 }, (_, i) => d.sel.c1 + i) : [d.idx];
      const w = sh.colW.get(d.idx);
      cols.forEach((c) => sh.colW.set(c, d.orig));
      this.run(() => cols.forEach((c) => sh.setColW(c, w)));
    } else {
      const hh = sh.rowH.get(d.idx);
      sh.rowH.set(d.idx, d.orig);
      this.run(() => sh.setRowH(d.idx, hh));
    }
    g.relayout(); this.syncCharts(true);
  }
  autofitCol(c) { const s = this.sel, cols = c >= s.c1 && c <= s.c2 ? [...Array(Math.min(s.c2, 500) - s.c1 + 1).keys()].map((i) => s.c1 + i) : [c]; this.run(() => cols.forEach((x) => this.sh.setColW(x, this.grid.measureCol(x)))); }
  autofitRow(r) { const s = this.sel, rows = r >= s.r1 && r <= s.r2 ? [...Array(Math.min(s.r2, 2000) - s.r1 + 1).keys()].map((i) => s.r1 + i) : [r]; this.run(() => rows.forEach((x) => this.sh.setRowH(x, this.grid.measureRow(x)))); }
  autoFill(src, dest) {
    this.run(() => this.wb.fill(this.sh, src, dest));
    this.grid.setSel(Math.min(src.r1, dest.r1), Math.min(src.c1, dest.c1), Math.max(src.r2, dest.r2), Math.max(src.c2, dest.c2), this.act);
  }
  fillDir(dir) {
    const s = this.sel, sh = this.sh;
    if (dir === 'down' && s.r2 > s.r1) this.run(() => this.wb.fill(sh, { ...s, r2: s.r1 }, { r1: s.r1 + 1, r2: s.r2, c1: s.c1, c2: s.c2 }));
    else if (dir === 'right' && s.c2 > s.c1) this.run(() => this.wb.fill(sh, { ...s, c2: s.c1 }, { c1: s.c1 + 1, c2: s.c2, r1: s.r1, r2: s.r2 }));
  }
  toggleStyle(key) {
    const cur = this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)][key];
    this.cmd('style', { [key]: !cur });
  }

  // ---------- events ----------
  bindEvents() {
    const sink = this.sink;
    sink.addEventListener('keydown', (e) => this.onKey(e));
    sink.addEventListener('copy', (e) => this.onCopy(e, false));
    sink.addEventListener('cut', (e) => this.onCopy(e, true));
    sink.addEventListener('paste', (e) => this.onPaste(e));
    sink.addEventListener('input', () => { sink.value = ''; });
    this.editor.addEventListener('keydown', (e) => this.onEditKey(e));
    this.editor.addEventListener('input', () => { this.fin.value = this.editor.value; this.fitEditor(); this.pt = null; this.updateAc(); });
    this.editor.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.updateAc(); });
    this.editor.addEventListener('blur', () => { setTimeout(() => { if (this.editing && !this.editing.bar && document.activeElement === document.body) this.editor.focus(); }, 0); });
    this.fin.addEventListener('focus', () => { if (!this.editing) this.beginEdit(null, 'edit', true); });
    this.fin.addEventListener('keydown', (e) => { if (this.editing && this.editing.bar) this.onEditKey(e); });
    this.fin.addEventListener('input', () => { if (this.editing && this.editing.bar) { this.editor.value = this.fin.value; this.fitEditor(); this.updateAc(); } });
    $('#fx').addEventListener('click', () => this.cmd('insertFunction'));
    $('#btn-theme').addEventListener('click', () => this.setTheme((document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark'));
    $('#title').addEventListener('input', () => this.updateTitle());
    $('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); this.focusSink(); } });
    $('#zoom').addEventListener('input', (e) => this.setZoom(e.target.value / 100));
    this.namebox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.goTo(this.namebox.value); this.focusSink(); }
      else if (e.key === 'Escape') { this.onSelect(); this.focusSink(); }
    });
    this.namebox.addEventListener('focus', () => this.namebox.select());
    addEventListener('beforeunload', (e) => { if (this.modified) { e.preventDefault(); e.returnValue = ''; } });
    $('#gridwrap').addEventListener('mousedown', () => setTimeout(() => this.focusSink()));
    const fi = $('#filein');
    fi.addEventListener('change', async () => { const f = fi.files[0]; fi.value = ''; if (f) this.cmd('openFile', f); });
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) this.cmd('openFile', f); });
    // chart deselect on grid click
    $('#gridwrap').addEventListener('mousedown', (e) => { if (!e.target.closest('.chart') && this.selChart) { this.selChart = null; this.syncCharts(false); } }, true);
  }

  goTo(text) {
    text = text.trim();
    if (!text) return;
    const ref = this.wb.refFromString(text, this.sh);
    if (ref && ref.sh) {
      if (ref.sh !== this.sh) this.switchSheet(ref.sh);
      const g = this.grid;
      g.setSel(ref.r1, ref.c1, ref.r2, ref.c2, { r: ref.r1, c: ref.c1 });
      g.ensureVisible(ref.r1, ref.c1);
      return;
    }
    if (/^[A-Za-z_][\w.]*$/.test(text) && !/^[A-Za-z]{1,3}\d+$/.test(text)) {
      this.run(() => { const had = this.wb.names.get(text.toUpperCase()); this.wb.names.set(text.toUpperCase(), { f: this.qaddr() }); this.wb.rec(() => (had ? this.wb.names.set(text.toUpperCase(), had) : this.wb.names.delete(text.toUpperCase())), () => this.wb.names.set(text.toUpperCase(), { f: this.qaddr() })); });
      toast(`Named ${this.qaddr()} as "${text}"`);
      return;
    }
    toast(`"${text}" is not a valid reference or name`);
    this.onSelect();
  }
}

const ymdNow = () => { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) + 25569; };

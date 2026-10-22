// Ribbon, dialogs, data tools and file operations. Everything hangs off App.prototype.cmd().
import { App } from './app.js';
import { Workbook, K, keyR, keyC, MAXR, MAXC, dvAt, displayValue } from '../engine.js';
import { readXlsx, writeXlsx } from '../xlsx.js';
import { parseCSV, toCSV } from '../csv.js';
import { colName, cellName, parseRefText, parse, shiftFormula } from '../parser.js';
import { parseInput, numStr, isErr, grid as gridOf, cmp, E } from '../core.js';
import { format } from '../numfmt.js';
import { F } from '../functions.js';
import { HINTS } from './hints.js';
import { chartData, chartSVG, svgToPng } from './chart.js';
import { jsonRows } from '../query.js';
import { tableAt } from '../tables.js';
import { h, $, toast, menu, closeMenu, dialog, colorMenu, download, icon } from './util.js';

const cloneJ = (x) => JSON.parse(JSON.stringify(x));
const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Tahoma'];
const NFS = [['General', 'General'], ['0.00', 'Number'], ['"$"#,##0.00', 'Currency'], ['#,##0', 'Thousands'], ['0%', 'Percent'], ['0.00%', 'Percent 0.00'], ['yyyy-mm-dd', 'Date'], ['dddd, mmmm d, yyyy', 'Long date'], ['h:mm AM/PM', 'Time'], ['0.00E+00', 'Scientific'], ['@', 'Text']];
const pad = (s, n) => String(s).padEnd(n);

// ---------- helpers on the app ----------
Object.assign(App.prototype, {
  cmd(name, arg) {
    const f = COMMANDS[name];
    if (!f) { toast('Not available: ' + name); return; }
    try { const r = f.call(this, arg); if (r && r.catch) r.catch((e) => { console.error(e); toast(String(e && e.message || e)); }); return r; } catch (e) { console.error(e); toast(String(e && e.message || e)); }
  },
  usedSel() { // selection clipped to the used range (for whole row/column selections)
    const s = this.sel, sh = this.sh;
    return { r1: s.r1, c1: s.c1, r2: Math.min(s.r2, Math.max(sh.maxR, s.r1)), c2: Math.min(s.c2, Math.max(sh.maxC, s.c1)) };
  },
  region(r, c) { // contiguous block of data around a cell
    const sh = this.sh, has = (a, b) => a >= 0 && b >= 0 && sh.get(a, b) != null;
    let r1 = r, r2 = r, c1 = c, c2 = c;
    for (let i = 0, ch = true; ch && i < 5000; i++) {
      ch = false;
      const anyRow = (rr) => { for (let cc = c1 - 1; cc <= c2 + 1; cc++) if (has(rr, cc)) return true; return false; };
      const anyCol = (cc) => { for (let rr = r1 - 1; rr <= r2 + 1; rr++) if (has(rr, cc)) return true; return false; };
      if (r1 > 0 && anyRow(r1 - 1)) { r1--; ch = true; }
      if (r2 < sh.maxR && anyRow(r2 + 1)) { r2++; ch = true; }
      if (c1 > 0 && anyCol(c1 - 1)) { c1--; ch = true; }
      if (c2 < sh.maxC && anyCol(c2 + 1)) { c2++; ch = true; }
    }
    return { r1, c1, r2, c2 };
  },
  dataRange() { // selection, or the region around the active cell when only one cell is selected
    const s = this.sel;
    return s.r1 === s.r2 && s.c1 === s.c2 ? this.region(s.r1, s.c1) : this.usedSel();
  },
  hasHeader(rg) {
    const sh = this.sh;
    if (rg.r2 <= rg.r1) return false;
    let str = 0, next = 0;
    for (let c = rg.c1; c <= rg.c2; c++) {
      if (typeof sh.get(rg.r1, c) === 'string') str++;
      const v = sh.get(rg.r1 + 1, c);
      if (typeof v !== 'string' && v != null) next++;
    }
    return str === rg.c2 - rg.c1 + 1 && next > 0;
  },
  rowsOf(rg, display = true) {
    const out = [];
    for (let r = rg.r1; r <= rg.r2; r++) {
      const row = [];
      for (let c = rg.c1; c <= rg.c2; c++) {
        const v = this.sh.get(r, c);
        row.push(v == null ? '' : display ? this.sh.display(r, c).text : (isErr(v) ? v.c : v));
      }
      out.push(row);
    }
    return out;
  },
  confirm(title, text, ok = 'Continue') { return dialog(title, [{ type: 'html', el: h('p', null, text) }], { ok }); },
  setFilter(f) {
    const sh = this.sh, before = cloneJ(sh.filter), wb = this.wb;
    this.run(() => {
      sh.filter = f; wb.applyFilters();
      wb.rec(() => { sh.filter = cloneJ(before); wb.applyFilters(); }, () => { sh.filter = cloneJ(f); wb.applyFilters(); });
    });
  },
  showFilterMenu(c) {
    const sh = this.sh, f = sh.filter, wb = this.wb;
    const vals = new Map();
    for (let r = f.r1 + 1; r <= f.r2; r++) {
      const t = sh.display(r, c).text, other = Object.entries(f.crit || {}).some(([k, hide]) => +k !== c && hide.includes(sh.display(r, +k).text));
      if (!other) vals.set(t, (vals.get(t) || 0) + 1);
    }
    const hidden = new Set((f.crit && f.crit[c]) || []);
    const keys = [...vals.keys()].sort((a, b) => cmp(a, b));
    const list = h('div', { class: 'fl' });
    const boxes = new Map();
    const search = h('input', { type: 'text', placeholder: 'Search', 'aria-label': 'Search values', class: 'rs', style: { width: '100%' } });
    const render = () => {
      list.replaceChildren(...keys.filter((k) => k.toLowerCase().includes(search.value.toLowerCase())).map((k) => {
        const cb = h('input', { type: 'checkbox', checked: !hidden.has(k), onchange: () => (cb.checked ? hidden.delete(k) : hidden.add(k)) });
        return h('label', null, cb, k === '' ? '(Blanks)' : k, h('span', { class: 'muted' }, ` (${vals.get(k)})`));
      }));
    };
    search.addEventListener('input', render); render();
    const apply = () => {
      const crit = { ...(f.crit || {}) };
      if (hidden.size) crit[c] = [...hidden]; else delete crit[c];
      this.setFilter({ ...f, crit: Object.keys(crit).length ? crit : null }); back.remove();
    };
    const sortBtn = (asc) => h('button', { class: 'btn sm', type: 'button', onclick: () => { back.remove(); this.run(() => wb.sortRange(sh, { r1: f.r1, c1: f.c1, r2: f.r2, c2: f.c2 }, c, asc, true)); wb.applyFilters(); } }, asc ? 'Sort A→Z' : 'Sort Z→A');
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) back.remove(); } },
      h('div', { class: 'modal', style: { width: '300px' }, role: 'dialog', 'aria-label': 'Filter ' + colName(c) },
        h('h2', null, 'Filter: ' + (sh.display(f.r1, c).text || colName(c))),
        h('div', { class: 'body' }, h('div', { style: { display: 'flex', gap: '6px' } }, sortBtn(true), sortBtn(false)), search,
          h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => { hidden.clear(); render(); } }, 'Select all'), h('button', { class: 'btn sm', type: 'button', onclick: () => { keys.forEach((k) => hidden.add(k)); render(); } }, 'Clear all')), list),
        h('div', { class: 'foot' }, h('button', { class: 'btn', type: 'button', onclick: () => back.remove() }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: apply }, 'OK'))));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') back.remove(); });
    document.body.append(back);
    search.focus();
  },
  updateRibbonState() {
    const st = this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)];
    for (const [el, test] of this.toggles || []) el.classList.toggle('on', !!test(st));
    if (this.fontSel) { this.fontSel.value = st.fn || ''; this.sizeIn.value = st.sz || 11; this.nfSel.value = NFS.some((x) => x[0] === (st.nf || 'General')) ? st.nf || 'General' : 'custom'; }
    if (this.swFont) { this.swFont.style.background = st.fc || 'var(--text)'; this.swFill.style.background = st.bg || 'transparent'; }
  },
});

// ---------- command table ----------
export const COMMANDS = {
  // ----- files -----
  async new() {
    if (this.modified && !(await this.confirm('Discard changes?', 'The current workbook has unsaved changes. A recovery copy is kept until you edit something new.', 'Discard and start new'))) return;
    this.setWorkbook(new Workbook(), '');
  },
  async open() {
    if (window.showOpenFilePicker) {
      try {
        const [hd] = await showOpenFilePicker({ types: [{ description: 'Spreadsheets', accept: { 'application/octet-stream': ['.xlsx', '.xlsm', '.csv', '.tsv', '.txt', '.json', '.sheetstudio'] } }] });
        await this.cmd('openFile', await hd.getFile(), hd);
      } catch (e) { if (e.name !== 'AbortError') throw e; }
    } else $('#filein').click();
  },
  async openFile(file, handle) {
    if (this.modified && !(await this.confirm('Discard changes?', `Opening "${file.name}" will replace the current workbook, which has unsaved changes.`, 'Open anyway'))) return;
    toast('Opening ' + file.name + '…', 60000);
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let wb;
    if (ext === 'xlsx' || ext === 'xlsm') wb = await readXlsx(new Uint8Array(await file.arrayBuffer()));
    else if (ext === 'sheetstudio' || ext === 'json') {
      let buf = new Uint8Array(await file.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const j = JSON.parse(new TextDecoder().decode(buf));
      wb = j && j.sheets && j.v ? Workbook.fromJSON(j) : tableToWb(Array.isArray(j) ? jsonRows(j) : [[JSON.stringify(j)]], file.name);
    } else wb = tableToWb(parseCSV(await file.text(), ext === 'tsv' ? '\t' : undefined), file.name);
    this.setWorkbook(wb, file.name);
    this.handle = handle && ext !== 'csv' && ext !== 'tsv' ? handle : null;
    toast('Opened ' + file.name);
  },
  save() { return COMMANDS.saveAs.call(this, this.handle ? { reuse: true } : {}); },
  async saveAs(opt = {}) {
    let fmt = opt.fmt || (this.handle ? this.handle.name.split('.').pop().toLowerCase() : 'xlsx');
    if (fmt === 'xlsx' && this.wb.vba) fmt = 'xlsm'; // a workbook carrying a VBA project must be saved as .xlsm
    const f = FORMATS[fmt] || FORMATS.xlsx;
    const base = this.title.replace(/[\\/:*?"<>|]/g, '_');
    const wbOut = await f.make.call(this);
    let name = `${base}.${f.ext}`;
    if (window.showSaveFilePicker && !(opt.reuse && this.handle && f.ext === this.handle.name.split('.').pop().toLowerCase())) {
      try {
        const hd = await showSaveFilePicker({ suggestedName: name, types: [{ description: f.label, accept: { [f.mime]: ['.' + f.ext] } }] });
        const w = await hd.createWritable(); await w.write(wbOut.data); await w.close();
        name = hd.name;
        if (f.keep) this.handle = hd;
      } catch (e) { if (e.name === 'AbortError') return; throw e; }
    } else if (opt.reuse && this.handle) {
      const w = await this.handle.createWritable(); await w.write(wbOut.data); await w.close(); name = this.handle.name;
    } else download(name, wbOut.data, f.mime);
    if (f.keep) { this.modified = false; this.fileName = name; this.updateTitle(); }
    $('#saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast([`Saved ${name}`, ...(wbOut.warnings || [])].join(' · '), wbOut.warnings && wbOut.warnings.length ? 7000 : 3200);
  },
  print() {
    const rg = this.dataRange(), rows = this.rowsOf(rg);
    let pa = $('#printarea');
    if (!pa) { pa = h('div', { id: 'printarea' }); document.body.append(pa); }
    const sh = this.sh;
    const tbl = h('table', { style: { borderCollapse: 'collapse', font: '11pt "Segoe UI",Arial,sans-serif' } },
      rows.map((row, i) => h('tr', null, row.map((t, j) => {
        const st = this.wb.styles[sh.styleAt(rg.r1 + i, rg.c1 + j)], v = sh.get(rg.r1 + i, rg.c1 + j);
        return h('td', { style: { border: sh.showGrid ? '1px solid #bbb' : 'none', padding: '2px 6px', fontWeight: st.b ? '700' : '', fontStyle: st.i ? 'italic' : '', color: st.fc || '', background: st.bg || '', textAlign: st.ha || (typeof v === 'number' ? 'right' : 'left') } }, t);
      }))));
    pa.replaceChildren(h('h3', null, this.title + ' – ' + sh.name), tbl);
    window.print();
  },

  // ----- clipboard & edit -----
  cut() { this.copyData(true); toast('Cut — select a cell and paste'); },
  copy() { this.copyData(false); },
  paste() { return this.pasteFromClipboard(); },
  pasteSpecial(mode) { this.pasteInternal(mode); },
  clear(what) { this.clearSelection(what); },
  insertCells() {
    const s = this.sel, wb = this.wb, sh = this.sh;
    if (s.c1 === 0 && s.c2 >= MAXC - 1) return this.run(() => wb.insert(sh, 'r', s.r1, s.r2 - s.r1 + 1));
    if (s.r1 === 0 && s.r2 >= MAXR - 1) return this.run(() => wb.insert(sh, 'c', s.c1, s.c2 - s.c1 + 1));
    const a = $('#gridwrap').getBoundingClientRect(), rc = this.grid.cellRect(this.act.r, this.act.c);
    menu([{ label: `Insert ${s.r2 - s.r1 + 1} row(s) above`, onclick: () => this.run(() => wb.insert(sh, 'r', s.r1, s.r2 - s.r1 + 1)) }, { label: `Insert ${s.c2 - s.c1 + 1} column(s) left`, onclick: () => this.run(() => wb.insert(sh, 'c', s.c1, s.c2 - s.c1 + 1)) }], null, { x: a.left + rc.x, y: a.top + rc.y + rc.h });
  },
  deleteCells() {
    const s = this.sel, wb = this.wb, sh = this.sh;
    if (s.c1 === 0 && s.c2 >= MAXC - 1) return this.run(() => wb.remove(sh, 'r', s.r1, s.r2 - s.r1 + 1));
    if (s.r1 === 0 && s.r2 >= MAXR - 1) return this.run(() => wb.remove(sh, 'c', s.c1, s.c2 - s.c1 + 1));
    const a = $('#gridwrap').getBoundingClientRect(), rc = this.grid.cellRect(this.act.r, this.act.c);
    menu([{ label: `Delete ${s.r2 - s.r1 + 1} row(s)`, onclick: () => this.run(() => wb.remove(sh, 'r', s.r1, s.r2 - s.r1 + 1)) }, { label: `Delete ${s.c2 - s.c1 + 1} column(s)`, onclick: () => this.run(() => wb.remove(sh, 'c', s.c1, s.c2 - s.c1 + 1)) }, { sep: true }, { label: 'Clear contents', onclick: () => this.clearSelection('contents') }], null, { x: a.left + rc.x, y: a.top + rc.y + rc.h });
  },
  hide(axis) {
    const s = this.sel, sh = this.sh;
    this.run(() => { if (axis === 'r') for (let r = s.r1; r <= Math.min(s.r2, s.r1 + 20000); r++) sh.prop('hiddenRows', r, true); else for (let c = s.c1; c <= Math.min(s.c2, 2000); c++) sh.prop('hiddenCols', c, true); });
  },
  unhide(axis) {
    const s = this.sel, sh = this.sh;
    this.run(() => {
      if (axis === 'r') for (let r = Math.max(0, s.r1 - 1); r <= Math.min(s.r2 + 1, s.r1 + 20000); r++) { if (sh.hiddenRows.has(r)) sh.prop('hiddenRows', r, false); }
      else for (let c = Math.max(0, s.c1 - 1); c <= Math.min(s.c2 + 1, 2000); c++) { if (sh.hiddenCols.has(c)) sh.prop('hiddenCols', c, false); }
    });
  },
  rowHeight() { return dialog('Row height', [{ name: 'v', type: 'number', label: 'Height (px)', value: this.sh.rowH.get(this.act.r) ?? 20 }]).then((v) => { if (v && v.v > 0) { const s = this.sel; this.run(() => { for (let r = s.r1; r <= Math.min(s.r2, s.r1 + 5000); r++) this.sh.setRowH(r, v.v); }); } }); },
  colWidth() { return dialog('Column width', [{ name: 'v', type: 'number', label: 'Width (px)', value: this.sh.colW.get(this.act.c) ?? 64 }]).then((v) => { if (v && v.v > 0) { const s = this.sel; this.run(() => { for (let c = s.c1; c <= Math.min(s.c2, 1000); c++) this.sh.setColW(c, v.v); }); } }); },
  autofit() { const s = this.sel; if (s.r1 === 0 && s.r2 >= MAXR - 1) this.autofitCol(s.c1); else this.autofitRow(s.r1); },

  // ----- formatting -----
  style(patch) {
    const s = this.sel, sh = this.sh;
    const r2 = s.r2 >= MAXR - 1 || s.c2 >= MAXC - 1 ? s.r2 : Math.min(s.r2, s.r1 + 200000);
    this.run(() => sh.patchStyle(s.r1, s.c1, r2, s.c2, patch));
    if (patch.wr) this.autofitRowsIfWrapped();
    this.focusSink();
  },
  nf(code) { COMMANDS.style.call(this, { nf: code === 'General' ? null : code }); },
  decimals(d) {
    const cur = this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)].nf || 'General';
    let nf;
    if (cur === 'General') nf = d > 0 ? '0.0' : null;
    else {
      nf = cur.replace(/0(\.(0*))?/, (m, p, z) => { const n = Math.max(0, (z ? z.length : 0) + d); return '0' + (n ? '.' + '0'.repeat(n) : ''); });
    }
    COMMANDS.style.call(this, { nf });
  },
  borders({ kind, style = 'thin', color }) {
    const s = this.usedSel(), sh = this.sh, wb = this.wb;
    this.run(() => {
      for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) {
        const cur = wb.styles[sh.styleAt(r, c)];
        let bd = { ...(cur.bd || {}) };
        const T = r === s.r1, B = r === s.r2, L = c === s.c1, R = c === s.c2;
        switch (kind) {
          case 'all': bd = { t: style, r: style, b: style, l: style }; break;
          case 'outer': if (T) bd.t = style; if (B) bd.b = style; if (L) bd.l = style; if (R) bd.r = style; break;
          case 'top': if (T) bd.t = style; break;
          case 'bottom': if (B) bd.b = style; break;
          case 'left': if (L) bd.l = style; break;
          case 'right': if (R) bd.r = style; break;
          case 'inner': if (!T) bd.t = style; if (!B) bd.b = style; if (!L) bd.l = style; if (!R) bd.r = style; break;
          case 'none': bd = {}; break;
        }
        const patch = { bd: Object.keys(bd).length ? bd : null };
        if (color) patch.bc = color;
        if (kind === 'none') patch.bc = null;
        sh.setStyle(r, c, wb.mergeStyle(sh.styleAt(r, c), patch));
      }
    });
  },
  merge(unmerge) {
    const s = this.sel, sh = this.sh;
    this.prop('merges', () => {
      sh.merges = sh.merges.filter((m) => !(m.r1 <= s.r2 && m.r2 >= s.r1 && m.c1 <= s.c2 && m.c2 >= s.c1));
      if (!unmerge && (s.r1 !== s.r2 || s.c1 !== s.c2)) {
        for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) if ((r !== s.r1 || c !== s.c1) && sh.cell(r, c)) sh.put(r, c, sh.cell(r, c).s ? { v: null, f: null, s: sh.cell(r, c).s } : null);
        sh.merges.push({ r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 });
      }
    });
    this.grid.setSel(s.r1, s.c1, s.r2, s.c2, { r: s.r1, c: s.c1 });
  },
  autofitRowsIfWrapped() { const s = this.usedSel(); this.run(() => { for (let r = s.r1; r <= Math.min(s.r2, s.r1 + 2000); r++) this.sh.setRowH(r, this.grid.measureRow(r)); }); },
  indent(d) { const cur = this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)].ind || 0; COMMANDS.style.call(this, { ind: Math.max(0, cur + d) || null, ha: this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)].ha || 'left' }); },
  async formatCells() {
    const st = this.wb.styles[this.sh.styleAt(this.act.r, this.act.c)];
    const v = await dialog('Format cells', [
      { name: 'nfp', type: 'select', label: 'Number format', value: NFS.some((x) => x[0] === (st.nf || 'General')) ? st.nf || 'General' : 'custom', options: [...NFS, ['custom', 'Custom…']] },
      { name: 'nf', label: 'Format code (custom)', value: st.nf || 'General', placeholder: '#,##0.00;[Red]-#,##0.00' },
      { name: 'ha', type: 'select', label: 'Horizontal alignment', value: st.ha || '', options: [['', 'General'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
      { name: 'va', type: 'select', label: 'Vertical alignment', value: st.va || '', options: [['', 'Bottom'], ['center', 'Middle'], ['top', 'Top']] },
      { name: 'wr', type: 'checkbox', label: 'Wrap text', value: st.wr }, { name: 'ind', type: 'number', label: 'Indent', value: st.ind || 0, min: 0, max: 15 },
      { name: 'fn', type: 'select', label: 'Font', value: st.fn || '', options: [['', '(default)'], ...FONTS] }, { name: 'sz', type: 'number', label: 'Size (pt)', value: st.sz || 11, min: 6, max: 96 },
      { name: 'b', type: 'checkbox', label: 'Bold', value: st.b }, { name: 'i', type: 'checkbox', label: 'Italic', value: st.i }, { name: 'u', type: 'checkbox', label: 'Underline', value: st.u }, { name: 'st', type: 'checkbox', label: 'Strikethrough', value: st.st },
      { name: 'fc', type: 'color', label: 'Text colour', value: st.fc || '#000000' }, { name: 'fcAuto', type: 'checkbox', label: 'Automatic text colour', value: !st.fc },
      { name: 'bg', type: 'color', label: 'Fill colour', value: st.bg || '#ffffff' }, { name: 'bgNone', type: 'checkbox', label: 'No fill', value: !st.bg },
    ], { ok: 'Apply', width: 480 });
    if (!v) return;
    COMMANDS.style.call(this, {
      nf: v.nfp !== 'custom' ? (v.nfp === 'General' ? null : v.nfp) : (v.nf === 'General' ? null : v.nf),
      ha: v.ha || null, va: v.va || null, wr: v.wr, ind: v.ind || null, fn: v.fn || null, sz: v.sz && v.sz !== 11 ? v.sz : null,
      b: v.b, i: v.i, u: v.u, st: v.st, fc: v.fcAuto ? null : v.fc, bg: v.bgNone ? null : v.bg,
    });
  },

  // ----- find & replace -----
  find() {
    let p = $('.findp');
    if (p) { p.querySelector('input').focus(); p.querySelector('input').select(); return; }
    const q = h('input', { type: 'text', 'aria-label': 'Find', placeholder: 'Find' }), rp = h('input', { type: 'text', 'aria-label': 'Replace with', placeholder: 'Replace with' });
    const mc = h('input', { type: 'checkbox' }), ec = h('input', { type: 'checkbox' }), fm = h('input', { type: 'checkbox' }), al = h('input', { type: 'checkbox' });
    const info = h('span', { class: 'muted' });
    const matcher = () => {
      const t = q.value;
      if (!t) return null;
      return (s) => { if (s == null) return false; s = String(s); return ec.checked ? (mc.checked ? s === t : s.toLowerCase() === t.toLowerCase()) : (mc.checked ? s.includes(t) : s.toLowerCase().includes(t.toLowerCase())); };
    };
    const all = () => {
      const m = matcher(), out = [];
      if (!m) return out;
      for (const sh of al.checked ? this.wb.sheets : [this.sh]) {
        const keys = [...sh.cells.keys(), ...sh.spillVals.keys()].sort((a, b) => a - b);
        for (const k of keys) {
          const r = keyR(k), c = keyC(k), cell = sh.cell(r, c);
          const txt = fm.checked && cell && cell.f != null ? '=' + cell.f : sh.display(r, c).text;
          if (m(txt)) out.push({ sh, r, c });
        }
      }
      return out;
    };
    const next = (dir = 1) => {
      const list = all();
      info.textContent = list.length + ' match' + (list.length === 1 ? '' : 'es');
      if (!list.length) return;
      const cur = { sh: this.sh, r: this.act.r, c: this.act.c }, order = (x) => this.wb.sheets.indexOf(x.sh) * 1e12 + x.r * 16384 + x.c;
      const pos = order(cur);
      let t = dir > 0 ? list.find((x) => order(x) > pos) : [...list].reverse().find((x) => order(x) < pos);
      t = t || (dir > 0 ? list[0] : list[list.length - 1]);
      if (t.sh !== this.sh) this.switchSheet(t.sh);
      this.grid.moveActive(t.r, t.c, false);
    };
    const replaceIn = (list) => {
      const t = q.value, rep = rp.value;
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), mc.checked ? 'g' : 'gi');
      let n = 0;
      this.run(() => {
        for (const { sh, r, c } of list) {
          const cell = sh.cell(r, c);
          if (!cell) continue;
          if (cell.f != null && fm.checked) { const f = ec.checked ? rep.replace(/^=/, '') : cell.f.replace(re, () => rep); if (f !== cell.f) { sh.put(r, c, { ...cell, f }); n++; } }
          else if (cell.f == null) {
            const txt = typeof cell.v === 'string' ? cell.v : cell.v != null ? String(cell.v) : null;
            if (txt == null) continue;
            const out = ec.checked ? rep : txt.replace(re, () => rep);
            if (out !== txt) { sh.setInput(r, c, out); n++; }
          }
        }
      });
      toast(`Replaced ${n} cell${n === 1 ? '' : 's'}`);
      next(1);
    };
    p = h('div', { class: 'findp', role: 'dialog', 'aria-label': 'Find and replace' },
      h('div', { class: 'r' }, q, h('button', { class: 'btn sm', type: 'button', onclick: () => next(-1) }, '↑'), h('button', { class: 'btn sm', type: 'button', onclick: () => next(1) }, '↓'), h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Close', onclick: () => { p.remove(); this.focusSink(); } }, '✕')),
      h('div', { class: 'r' }, rp, h('button', { class: 'btn sm', type: 'button', onclick: () => { const m = matcher(); const cur = { sh: this.sh, r: this.act.r, c: this.act.c }; if (m && all().some((x) => x.sh === cur.sh && x.r === cur.r && x.c === cur.c)) replaceIn([cur]); else next(1); } }, 'Replace'), h('button', { class: 'btn sm', type: 'button', onclick: () => replaceIn(all()) }, 'All')),
      h('div', { class: 'r', style: { flexWrap: 'wrap' } }, h('label', null, mc, 'Match case'), h('label', null, ec, 'Entire cell'), h('label', null, fm, 'Formulas'), h('label', null, al, 'All sheets')), info);
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') { next(e.shiftKey ? -1 : 1); e.preventDefault(); } else if (e.key === 'Escape') { p.remove(); this.focusSink(); } e.stopPropagation(); });
    q.addEventListener('input', () => { const l = all(); info.textContent = l.length + ' match' + (l.length === 1 ? '' : 'es'); });
    $('#gridwrap').append(p);
    q.focus();
  },

  // ----- data -----
  sort(asc) {
    const rg = this.dataRange(), col = this.act.c;
    if (col < rg.c1 || col > rg.c2) return;
    const header = this.hasHeader(rg);
    this.run(() => this.wb.sortRange(this.sh, rg, col, asc, header));
    this.wb.applyFilters();
  },
  async customSort() {
    const rg = this.dataRange(), header = this.hasHeader(rg);
    const opts = [];
    for (let c = rg.c1; c <= rg.c2; c++) opts.push([c, `${colName(c)}${header ? ' – ' + this.sh.display(rg.r1, c).text : ''}`]);
    const v = await dialog('Sort', [{ name: 'hdr', type: 'checkbox', label: 'My data has headers', value: header }, { name: 'col', type: 'select', label: 'Sort by', value: this.act.c, options: opts }, { name: 'ord', type: 'select', label: 'Order', value: 'a', options: [['a', 'A → Z / smallest first'], ['d', 'Z → A / largest first']] }], { ok: 'Sort' });
    if (!v) return;
    this.run(() => this.wb.sortRange(this.sh, rg, +v.col, v.ord === 'a', v.hdr));
  },
  filter() {
    const sh = this.sh;
    if (sh.filter) return this.setFilter(null);
    const rg = this.dataRange();
    if (rg.r2 <= rg.r1 && rg.c2 <= rg.c1) { toast('Select a cell inside your data first'); return; }
    this.setFilter({ ...rg, crit: null });
  },
  clearFilter() { if (this.sh.filter) this.setFilter({ ...this.sh.filter, crit: null }); },
  async removeDup() {
    const rg = this.dataRange(), sh = this.sh;
    const v = await dialog('Remove duplicates', [{ name: 'hdr', type: 'checkbox', label: 'My data has headers', value: this.hasHeader(rg) }], { hint: `Compares all columns of ${this.addr(rg)}; keeps the first occurrence.`, ok: 'Remove' });
    if (!v) return;
    const top = v.hdr ? rg.r1 + 1 : rg.r1, seen = new Set(), keep = [];
    for (let r = top; r <= rg.r2; r++) {
      const key = JSON.stringify(Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => { const x = sh.get(r, rg.c1 + i); return typeof x === 'string' ? x.toLowerCase() : x; }));
      if (!seen.has(key)) { seen.add(key); keep.push(r); }
    }
    const removed = rg.r2 - top + 1 - keep.length;
    this.run(() => {
      const rows = keep.map((r) => Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => sh.cell(r, rg.c1 + i)));
      rows.forEach((row, i) => row.forEach((cell, j) => sh.put(top + i, rg.c1 + j, cell ? (cell.f != null ? { ...cell, f: shiftFormula(cell.f, top + i - keep[i], 0), c: undefined } : cell) : null)));
      for (let r = top + keep.length; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) sh.put(r, c, null);
    });
    toast(`${removed} duplicate row${removed === 1 ? '' : 's'} removed; ${keep.length} unique remain`);
  },
  async textToCols() {
    const s = this.usedSel(), sh = this.sh;
    const v = await dialog('Text to columns', [{ name: 'd', type: 'select', label: 'Delimiter', value: ',', options: [[',', 'Comma'], ['\t', 'Tab'], [';', 'Semicolon'], [' ', 'Space'], ['|', 'Pipe'], ['custom', 'Custom…']] }, { name: 'cd', label: 'Custom delimiter', value: '' }], { hint: 'Splits each selected cell into the columns to its right (existing data there is overwritten).', ok: 'Split' });
    if (!v) return;
    const d = v.d === 'custom' ? v.cd : v.d;
    if (!d) return;
    this.run(() => {
      for (let r = s.r1; r <= s.r2; r++) {
        const val = sh.get(r, s.c1);
        if (typeof val !== 'string') continue;
        val.split(d).forEach((part, i) => sh.setInput(r, s.c1 + i, part.trim()));
      }
    });
  },
  async goalSeek() {
    const v = await dialog('Goal seek', [{ name: 'tgt', label: 'Set cell (a formula)', value: cellName(this.act.r, this.act.c) }, { name: 'val', type: 'number', label: 'To value', value: 0, step: 'any' }, { name: 'chg', label: 'By changing cell', value: '' }], { ok: 'Solve' });
    if (!v) return;
    const t = parseRefText(v.tgt.trim()), ch = parseRefText(v.chg.trim());
    if (!t || !ch) { toast('Enter cell references such as B7 and B2'); return; }
    const sh = this.sh, wb = this.wb, key = K(ch.r1, ch.c1), orig = sh.cells.get(key);
    const evalAt = (x) => { sh.cells.set(key, { v: x, f: null, s: orig ? orig.s : 0 }); sh.fkeys = null; wb.dirty(); const y = sh.get(t.r1, t.c1); if (typeof y !== 'number') throw new Error('The set cell must evaluate to a number'); return y - v.val; };
    let result = null;
    try {
      let x0 = typeof (orig && orig.v) === 'number' ? orig.v : 1, x1 = x0 + (Math.abs(x0) * 0.1 || 1), f0 = evalAt(x0), f1 = evalAt(x1);
      for (let i = 0; i < 100 && Math.abs(f1) > 1e-10; i++) {
        if (f1 === f0) break;
        const x2 = x1 - f1 * (x1 - x0) / (f1 - f0);
        x0 = x1; f0 = f1; x1 = x2; f1 = evalAt(x1);
      }
      if (Math.abs(f1) < 1e-6) result = x1;
    } finally {
      if (orig) sh.cells.set(key, orig); else sh.cells.delete(key);
      sh.fkeys = null; wb.dirty();
    }
    if (result === null) { toast('Goal seek could not find a solution'); return; }
    this.run(() => sh.setValue(ch.r1, ch.c1, Math.round(result * 1e9) / 1e9));
    toast(`Solution: ${v.chg.trim().toUpperCase()} = ${numStr(Math.round(result * 1e9) / 1e9)}`);
  },
  async validation() {
    const s = this.usedSel(), sh = this.sh;
    const cur = dvAt(sh, s.r1, s.c1) || {};
    const v = await dialog('Data validation', [
      { name: 'type', type: 'select', label: 'Allow', value: cur.type || 'any', options: [['any', 'Any value (remove rule)'], ['list', 'List'], ['whole', 'Whole number'], ['decimal', 'Decimal'], ['len', 'Text length']] },
      { name: 'list', label: 'List items (comma separated) or =range', value: cur.list || '', placeholder: 'Yes,No,Maybe  or  =$A$1:$A$10' },
      { name: 'op', type: 'select', label: 'Data (numbers)', value: cur.op || 'between', options: [['between', 'between'], ['notbetween', 'not between'], ['=', 'equal to'], ['<>', 'not equal to'], ['>', 'greater than'], ['<', 'less than'], ['>=', '≥'], ['<=', '≤']] },
      { name: 'v1', label: 'Minimum / value', value: cur.v1 ?? '' }, { name: 'v2', label: 'Maximum', value: cur.v2 ?? '' },
      { name: 'allowBlank', type: 'checkbox', label: 'Ignore blank', value: cur.allowBlank !== false }, { name: 'msg', label: 'Error message', value: cur.msg || '' },
    ], { ok: 'Apply' });
    if (!v) return;
    const rg = { r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 };
    this.prop('dv', () => {
      sh.dv = sh.dv.filter((d) => !d.ranges.some((g) => g.r1 === rg.r1 && g.c1 === rg.c1 && g.r2 === rg.r2 && g.c2 === rg.c2));
      if (v.type !== 'any') sh.dv.push({ type: v.type, list: v.list, op: v.op, v1: v.v1, v2: v.v2, allowBlank: v.allowBlank, msg: v.msg, ranges: [rg] });
    });
    this.grid.invalidate();
  },
  async cf(kind) {
    const s = this.usedSel(), sh = this.sh;
    const rg = [{ r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 }];
    const add = (rule) => { this.prop('cf', () => sh.cf.push({ ...rule, ranges: rg })); this.grid.invalidate(); };
    const red = { bg: '#ffc7ce', fc: '#9c0006' };
    if (kind === 'scaleGYR') return add({ type: 'scale', colors: ['#63be7b', '#ffeb84', '#f8696b'] });
    if (kind === 'scaleRYG') return add({ type: 'scale', colors: ['#f8696b', '#ffeb84', '#63be7b'] });
    if (kind === 'scaleW') return add({ type: 'scale', colors: ['#ffffff', '#63be7b'] });
    if (kind === 'scaleB') return add({ type: 'scale', colors: ['#f8696b', '#ffffff', '#5a8ac6'] });
    if (kind === 'bar') return add({ type: 'bar', color: '#5b9bd5' });
    if (kind === 'dup') return add({ type: 'dup', style: red });
    if (kind === 'unique') return add({ type: 'unique', style: { bg: '#c6efce', fc: '#006100' } });
    if (kind === 'blank') return add({ type: 'blank', style: red });
    if (kind === 'clearSel') { this.prop('cf', () => { sh.cf = sh.cf.filter((r) => !r.ranges.some((g) => g.r1 <= s.r2 && g.r2 >= s.r1 && g.c1 <= s.c2 && g.c2 >= s.c1)); }); this.grid.invalidate(); return; }
    if (kind === 'clearAll') { this.prop('cf', () => { sh.cf = []; }); this.grid.invalidate(); return; }
    if (kind === 'top' || kind === 'bottom') {
      const v = await dialog(kind === 'top' ? 'Top items' : 'Bottom items', [{ name: 'n', type: 'number', label: 'Items', value: 10, min: 1 }, { name: 'pct', type: 'checkbox', label: 'Percent', value: false }], { ok: 'Apply' });
      if (v) add({ type: 'top', n: v.n, pct: v.pct, bottom: kind === 'bottom', style: { bg: '#c6efce', fc: '#006100' } });
      return;
    }
    const ops = [['>', 'Greater than'], ['<', 'Less than'], ['>=', 'Greater or equal'], ['<=', 'Less or equal'], ['=', 'Equal to'], ['<>', 'Not equal to'], ['between', 'Between'], ['notbetween', 'Not between'], ['contains', 'Text contains'], ['begins', 'Text begins with'], ['ends', 'Text ends with'], ['notcontains', 'Text does not contain'], ['formula', 'Custom formula']];
    const v = await dialog('New formatting rule', [
      { name: 'op', type: 'select', label: 'Format cells that are', value: ['gt', 'lt', 'eq'].includes(kind) ? { gt: '>', lt: '<', eq: '=' }[kind] : kind === 'text' ? 'contains' : '>', options: ops },
      { name: 'v1', label: 'Value / text / formula (e.g. =$B2>100)', value: '' }, { name: 'v2', label: 'Second value (between)', value: '' },
      { name: 'bg', type: 'color', label: 'Fill', value: '#ffc7ce' }, { name: 'fc', type: 'color', label: 'Text colour', value: '#9c0006' }, { name: 'b', type: 'checkbox', label: 'Bold', value: false },
    ], { ok: 'Apply' });
    if (!v) return;
    const style = { bg: v.bg, fc: v.fc, b: v.b };
    const num = (x) => (x.trim() !== '' && !isNaN(+x) ? +x : x);
    if (v.op === 'formula') add({ type: 'formula', f: v.v1.replace(/^=/, ''), style });
    else if (['contains', 'begins', 'ends', 'notcontains'].includes(v.op)) add({ type: 'text', op: v.op, v1: v.v1, style });
    else add({ type: 'cell', op: v.op, v1: num(v.v1), v2: num(v.v2), style });
  },
  async manageCf() {
    const sh = this.sh;
    const body = h('div');
    const label = (r) => ({ cell: `Cell value ${r.op} ${r.v1}${r.op.includes('between') ? ' and ' + r.v2 : ''}`, text: `Text ${r.op} "${r.v1}"`, dup: 'Duplicate values', unique: 'Unique values', blank: 'Blank cells', noblank: 'Non-blank cells', top: `${r.bottom ? 'Bottom' : 'Top'} ${r.n}${r.pct ? '%' : ''}`, formula: 'Formula: ' + r.f, scale: 'Colour scale', bar: 'Data bar' }[r.type] || r.type);
    const draw = () => {
      body.replaceChildren(sh.cf.length ? h('table', { class: 'tbl' }, sh.cf.map((r, i) => h('tr', null, h('td', null, label(r)), h('td', { class: 'muted' }, r.ranges.map((g) => this.addr({ r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 })).join(', ')),
        h('td', null, h('button', { class: 'btn sm', type: 'button', onclick: () => { this.prop('cf', () => sh.cf.splice(i, 1)); this.grid.invalidate(); draw(); } }, 'Delete'))))) : h('p', { class: 'muted' }, 'No rules on this sheet.'));
    };
    draw();
    await dialog('Conditional formatting rules', [{ type: 'html', el: body }], { cancel: null, ok: 'Close' });
  },
  async names() {
    const wb = this.wb;
    const lines = [...wb.names].map(([n, d]) => `${n} = ${d.f}`).join('\n');
    const v = await dialog('Named ranges & functions', [{ name: 't', type: 'textarea', label: 'One per line:  NAME = refers-to', value: lines, rows: 9 }], { hint: 'A name can refer to a range (Sheet1!$A$1:$B$5) or be a reusable function: TAX = LAMBDA(x, x*0.2).', ok: 'Save' });
    if (!v) return;
    const before = new Map([...wb.names].map(([k, d]) => [k, { f: d.f }]));
    const next = new Map();
    for (const ln of v.t.split('\n')) {
      const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.+?)\s*$/.exec(ln);
      if (!m) continue;
      try { parse(m[2].replace(/^=/, '')); } catch (e) { toast(`"${m[1]}": ${e.message}`); return; }
      next.set(m[1].toUpperCase(), { f: m[2].replace(/^=/, '') });
    }
    this.run(() => { wb.names = next; wb.rec(() => { wb.names = new Map([...before].map(([k, d]) => [k, { f: d.f }])); }, () => { wb.names = new Map([...next].map(([k, d]) => [k, { f: d.f }])); }); });
  },

  // ----- formulas -----
  autosum(fn = 'SUM') {
    const s = this.sel, sh = this.sh;
    const isNum = (r, c) => typeof sh.get(r, c) === 'number';
    if (s.r1 === s.r2 && s.c1 === s.c2) {
      const { r, c } = this.act;
      let r0 = r - 1;
      while (r0 >= 0 && isNum(r0, c)) r0--;
      if (r0 < r - 1) { this.run(() => sh.setInput(r, c, `=${fn}(${cellName(r0 + 1, c)}:${cellName(r - 1, c)})`)); return; }
      let c0 = c - 1;
      while (c0 >= 0 && isNum(r, c0)) c0--;
      if (c0 < c - 1) { this.run(() => sh.setInput(r, c, `=${fn}(${cellName(r, c0 + 1)}:${cellName(r, c - 1)})`)); return; }
      this.beginEdit(`=${fn}(`, 'enter');
      return;
    }
    this.run(() => {
      const wide = s.c2 - s.c1 >= s.r2 - s.r1;
      if (wide) for (let c = s.c1; c <= s.c2; c++) sh.setInput(s.r2 + 1, c, `=${fn}(${cellName(s.r1, c)}:${cellName(s.r2, c)})`);
      else for (let r = s.r1; r <= s.r2; r++) sh.setInput(r, s.c2 + 1, `=${fn}(${cellName(r, s.c1)}:${cellName(r, s.c2)})`);
    });
  },
  async insertFunction() {
    const list = h('div', { class: 'fl', style: { maxHeight: '220px' }, role: 'listbox' }), info = h('div', { class: 'muted', style: { minHeight: '40px' } });
    let pick = HINTS[0].n;
    const q = h('input', { type: 'text', class: 'rs', placeholder: 'Search functions…', 'aria-label': 'Search functions', style: { width: '100%' } });
    const draw = () => {
      const t = q.value.toLowerCase();
      const items = HINTS.filter((x) => !t || x.n.toLowerCase().includes(t) || x.d.toLowerCase().includes(t)).slice(0, 80);
      list.replaceChildren(...items.map((x) => h('label', { role: 'option', style: { cursor: 'pointer', background: x.n === pick ? 'var(--accent-2)' : '' }, onclick: () => { pick = x.n; draw(); } }, h('b', null, x.n), h('span', { class: 'muted' }, ' – ' + x.d))));
      const x = HINTS.find((y) => y.n === pick);
      info.replaceChildren(x ? h('div', null, h('b', null, `${x.n}(${x.a})`), h('div', null, x.d)) : '');
    };
    q.addEventListener('input', draw); draw();
    const v = await dialog('Insert function', [{ type: 'html', el: q }, { type: 'html', el: list }, { type: 'html', el: info }], { ok: 'Insert', width: 520 });
    if (v) { if (this.editing) { const t = this.editText(), p = this.caret(); this.setEditText(t.slice(0, p) + pick + '(' + t.slice(p), p + pick.length + 1); } else this.beginEdit('=' + pick + '(', 'edit'); }
  },
  showFormulas() { this.grid.showFormulas = !this.grid.showFormulas; this.grid.invalidate(); },

  // ----- insert -----
  async chart(type) {
    const s = this.dataRange();
    if (this.sh.get(s.r1, s.c1) == null && s.r1 === s.r2 && s.c1 === s.c2) { toast('Select the cells that hold your data first'); return; }
    const sh = this.sh, g = this.grid, z = g.z;
    const id = 'c' + Date.now().toString(36);
    const ch = { id, type, range: this.qaddr(s), title: '', x: Math.round(g.colPos(s.c2 + 1) / z + 24 + sh.charts.length * 16), y: Math.round(g.rowPos(s.r1) / z + sh.charts.length * 16), w: type === 'pie' || type === 'doughnut' ? 360 : 480, h: 300, stacked: false, byRow: false };
    this.prop('charts', () => sh.charts.push(ch));
    this.syncCharts(true);
    this.selectChart(id);
    if (!chartData(this.wb, ch) || !chartData(this.wb, ch).series.length) toast('No numeric data found in the selection — use Edit chart to change the range');
  },
  async editChart(ch) {
    const v = await dialog('Edit chart', [
      { name: 'type', type: 'select', label: 'Type', value: ch.type, options: [['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Scatter']] },
      { name: 'range', label: 'Data range', value: ch.range }, { name: 'title', label: 'Title', value: ch.title },
      { name: 'stacked', type: 'checkbox', label: 'Stacked (column, bar, area)', value: ch.stacked }, { name: 'byRow', type: 'checkbox', label: 'Series in rows', value: ch.byRow },
    ], { ok: 'Apply' });
    if (!v) return;
    if (!this.wb.refFromString(v.range, this.sh)) { toast('That data range is not valid'); return; }
    this.prop('charts', () => { const c = this.sh.charts.find((x) => x.id === ch.id); if (c) Object.assign(c, v); });
    this.syncCharts(true);
  },
  async chartPng(ch) {
    const cs = getComputedStyle(document.documentElement);
    const svg = chartSVG(ch, chartData(this.wb, ch), ch.w, ch.h, { fg: '#222', grid: '#ddd', bg: '#fff' });
    download((ch.title || 'chart') + '.png', await svgToPng(svg, ch.w, ch.h), 'image/png');
  },
  async sparkline(type) {
    const s = this.usedSel(), sh = this.sh;
    const v = await dialog('Insert sparkline', [{ name: 'src', label: 'Data range', value: this.addr(s) }, { name: 'dst', label: 'Place in (first cell)', value: cellName(s.r1, s.c2 + 1) }, { name: 'type', type: 'select', label: 'Type', value: type || 'line', options: [['line', 'Line'], ['column', 'Column'], ['winloss', 'Win/Loss']] }], { hint: 'With several rows of data, one sparkline is created per row going down.', ok: 'Insert' });
    if (!v) return;
    const src = parseRefText(v.src.trim()), dst = parseRefText(v.dst.trim());
    if (!src || !dst) { toast('Enter valid cell references'); return; }
    const rows = src.r2 > src.r1 && src.c2 > src.c1 ? src.r2 - src.r1 + 1 : 1;
    this.run(() => { for (let i = 0; i < rows; i++) { const rr = rows > 1 ? { r1: src.r1 + i, r2: src.r1 + i } : src; sh.setInput(dst.r1 + i, dst.c1, `=SPARKLINE(${cellName(rr.r1, src.c1)}:${cellName(rr.r2, src.c2)},"${v.type}")`); } });
  },
  // ----- view -----
  freeze(kind) {
    const sh = this.sh, a = this.act;
    this.prop('freeze', () => { sh.freeze = kind === 'row' ? { r: 1, c: 0 } : kind === 'col' ? { r: 0, c: 1 } : kind === 'at' ? { r: a.r, c: a.c } : { r: 0, c: 0 }; });
    this.grid.relayout();
  },
  gridlines() { const sh = this.sh; this.prop('showGrid', () => { sh.showGrid = !sh.showGrid; }); this.grid.invalidate(); },
  zoomReset() { this.setZoom(1); },

  // ----- tools -----
  help() {
    const rows = [['Ctrl+Z / Y', 'Undo / redo'], ['Ctrl+C / X / V', 'Copy / cut / paste'], ['Ctrl+B / I / U', 'Bold / italic / underline'], ['Ctrl+Arrows', 'Jump to edge of data'], ['Ctrl+Shift+Arrows', 'Select to edge of data'], ['Ctrl+Space / Shift+Space', 'Select column / row'], ['F2', 'Edit cell'], ['F4', 'Toggle $ in a reference (while editing)'], ['Alt+Enter', 'New line in a cell'], ['Ctrl+Enter', 'Fill the selection with the entry'], ['Ctrl+D / Ctrl+R', 'Fill down / right'], ['Alt+=', 'AutoSum'], ['Ctrl+F / H', 'Find & replace'], ['Ctrl+;', 'Insert today\'s date'], ['Ctrl+`', 'Show formulas'], ['Ctrl+L', 'Toggle filter'], ['Ctrl+S / Shift+S', 'Save / Save as'], ['Ctrl+Wheel', 'Zoom'], ['F9', 'Recalculate']];
    dialog('Keyboard shortcuts', [{ type: 'html', el: h('table', { class: 'tbl' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d)))) }], { cancel: null, ok: 'Close', width: 520 });
  },
  about() {
    dialog('About SheetStudio Excel Pro', [{ type: 'html', el: h('div', null, h('p', null, 'A free, offline spreadsheet in one HTML file. Reads and writes .xlsx, .csv and its own compressed format.'), h('p', null, 'Everything runs in your browser. Files are never uploaded; the page makes no network requests. A recovery copy of your work is kept in this browser\'s storage only.'), h('p', { class: 'muted' }, 'MIT licence. Not affiliated with Microsoft.')) }], { cancel: null, ok: 'Close' });
  },

  // ----- context menu -----
  contextMenu({ x, y, zone }) {
    const s = this.sel, wb = this.wb, sh = this.sh;
    const rowsSel = s.c1 === 0 && s.c2 >= MAXC - 1, colsSel = s.r1 === 0 && s.r2 >= MAXR - 1;
    const items = [
      { label: 'Cut', kbd: 'Ctrl+X', onclick: () => COMMANDS.cut.call(this) }, { label: 'Copy', kbd: 'Ctrl+C', onclick: () => COMMANDS.copy.call(this) },
      { label: 'Paste', kbd: 'Ctrl+V', onclick: () => COMMANDS.paste.call(this) },
      { label: 'Paste values only', disabled: !this.clip, onclick: () => this.pasteInternal('values') }, { label: 'Paste formats only', disabled: !this.clip, onclick: () => this.pasteInternal('formats') },
      { sep: true },
    ];
    if (rowsSel) items.push({ label: `Insert ${s.r2 - s.r1 + 1} row(s)`, onclick: () => COMMANDS.insertCells.call(this) }, { label: 'Delete row(s)', onclick: () => COMMANDS.deleteCells.call(this) }, { label: 'Hide', onclick: () => COMMANDS.hide.call(this, 'r') }, { label: 'Unhide', onclick: () => COMMANDS.unhide.call(this, 'r') }, { label: 'Row height…', onclick: () => COMMANDS.rowHeight.call(this) });
    else if (colsSel) items.push({ label: `Insert ${s.c2 - s.c1 + 1} column(s)`, onclick: () => COMMANDS.insertCells.call(this) }, { label: 'Delete column(s)', onclick: () => COMMANDS.deleteCells.call(this) }, { label: 'Hide', onclick: () => COMMANDS.hide.call(this, 'c') }, { label: 'Unhide', onclick: () => COMMANDS.unhide.call(this, 'c') }, { label: 'Column width…', onclick: () => COMMANDS.colWidth.call(this) }, { label: 'Autofit width', onclick: () => this.autofitCol(s.c1) });
    else items.push({ label: 'Insert row above', onclick: () => this.run(() => wb.insert(sh, 'r', s.r1, s.r2 - s.r1 + 1)) }, { label: 'Insert column left', onclick: () => this.run(() => wb.insert(sh, 'c', s.c1, s.c2 - s.c1 + 1)) }, { label: 'Delete row(s)', onclick: () => this.run(() => wb.remove(sh, 'r', s.r1, s.r2 - s.r1 + 1)) }, { label: 'Delete column(s)', onclick: () => this.run(() => wb.remove(sh, 'c', s.c1, s.c2 - s.c1 + 1)) });
    const hasNote = sh.notes.some((n) => n.r === this.act.r && n.c === this.act.c);
    items.push({ sep: true }, { label: hasNote ? 'Edit note…' : 'New note…', onclick: () => COMMANDS.note.call(this) }, ...(hasNote ? [{ label: 'Delete note', onclick: () => COMMANDS.deleteNote.call(this) }] : []),
      ...(tableAt(sh, this.act.r, this.act.c) ? [{ label: 'Table properties…', onclick: () => COMMANDS.tableProps.call(this) }] : []));
    items.push({ sep: true }, { label: 'Clear contents', kbd: 'Del', onclick: () => this.clearSelection('contents') }, { label: 'Clear formats', onclick: () => this.clearSelection('formats') }, { label: 'Format cells…', kbd: 'Ctrl+1', onclick: () => COMMANDS.formatCells.call(this) }, { sep: true },
      { label: 'Sort A → Z', onclick: () => COMMANDS.sort.call(this, true) }, { label: 'Sort Z → A', onclick: () => COMMANDS.sort.call(this, false) }, { label: sh.filter ? 'Remove filter' : 'Filter', kbd: 'Ctrl+L', onclick: () => COMMANDS.filter.call(this) });
    menu(items, null, { x, y });
  },
};

const jsval = (v) => (v && v.c ? v.c : v);
function tableToWb(rows, fileName) {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  sh.name = (fileName || 'Sheet1').replace(/\.[^.]+$/, '').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';
  const nfCache = new Map();
  rows.forEach((row, r) => row.forEach((t, c) => {
    if (t === '' || t == null) return;
    const p = typeof t === 'string' ? parseInput(t) : { v: t };
    let s = 0;
    if (p.nf) { s = nfCache.get(p.nf); if (s === undefined) nfCache.set(p.nf, (s = wb.sid({ nf: p.nf }))); }
    sh.cells.set(K(r, c), { v: p.v, f: null, s });
    if (r > sh.maxR) sh.maxR = r; if (c > sh.maxC) sh.maxC = c;
  }));
  return wb;
}
function tableHtml(rows, title) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>table{border-collapse:collapse;font:14px system-ui}td,th{border:1px solid #ccc;padding:3px 8px}</style><table>${rows.map((r, i) => '<tr>' + r.map((t) => `<${i ? 'td' : 'th'}>${esc(t)}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('')}</table>`;
}

export const FORMATS = {
  xlsx: { ext: 'xlsx', label: 'Excel workbook', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', keep: true, async make() { const r = await writeXlsx(this.wb); return { data: r.bytes, warnings: r.warnings }; } },
  xlsm: { ext: 'xlsm', label: 'Excel macro-enabled workbook', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', keep: true, async make() { const r = await writeXlsx(this.wb); return { data: r.bytes, warnings: r.warnings }; } },
  csv: { ext: 'csv', label: 'CSV (active sheet)', mime: 'text/csv', async make() { return { data: '' + toCSV(this.rowsOf(this.sheetRange())), warnings: this.wb.sheets.length > 1 ? ['Only the active sheet was saved.'] : [] }; } },
  tsv: { ext: 'tsv', label: 'Tab-separated (active sheet)', mime: 'text/tab-separated-values', async make() { return { data: toCSV(this.rowsOf(this.sheetRange()), '\t') }; } },
  json: { ext: 'json', label: 'JSON (active sheet)', mime: 'application/json', async make() {
    const rows = this.rowsOf(this.sheetRange(), false);
    const [head, ...rest] = rows;
    return { data: JSON.stringify(rest.map((r) => Object.fromEntries(head.map((k, i) => [String(k) || colName(i), r[i]]))), null, 2) };
  } },
  html: { ext: 'html', label: 'HTML table (active sheet)', mime: 'text/html', async make() { return { data: tableHtml(this.rowsOf(this.sheetRange()), this.title) }; } },
  sheetstudio: { ext: 'sheetstudio', label: 'SheetStudio workbook (keeps charts)', mime: 'application/gzip', keep: true, async make() {
    const raw = new TextEncoder().encode(JSON.stringify(this.wb.toJSON()));
    return { data: new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()) };
  } },
};
App.prototype.sheetRange = function () { return { r1: 0, c1: 0, r2: Math.max(0, this.sh.maxR), c2: Math.max(0, this.sh.maxC) }; };

// ---------- ribbon ----------
export function buildRibbon(app) {
  const ribbon = $('#ribbon'), tabs = $('#tabs');
  app.toggles = [];
  const tip = (t) => ({ title: t, 'aria-label': t });
  const B = (label, ic, title, fn, opt = {}) => {
    const b = h('button', { class: 'rb' + (opt.big ? ' big' : ''), type: 'button', ...tip(title || label), onmousedown: (e) => e.preventDefault(), onclick: (e) => { fn(e, b); if (!opt.keepFocus) app.focusSink(); } }, ic ? icon(ic, opt.big ? 22 : 16) : null, label ? h('span', null, label) : null);
    if (opt.toggle) app.toggles.push([b, opt.toggle]);
    return b;
  };
  const G = (name, ...items) => h('div', { class: 'grp', role: 'group', 'aria-label': name }, h('div', { class: 'row' }, items), h('div', { class: 'cap' }, name));
  const fmtB = (label, title, key, cls) => { const b = B('', null, title, () => app.toggleStyle(key), { toggle: (st) => st[key] }); b.append(h('span', { style: { fontWeight: key === 'b' ? '800' : '', fontStyle: key === 'i' ? 'italic' : '', textDecoration: key === 'u' ? 'underline' : key === 'st' ? 'line-through' : '' } }, label)); return b; };
  const sel = (opts, value, title, fn, cls = 'rs') => { const s = h('select', { class: cls, ...tip(title), onchange: () => { fn(s.value); app.focusSink(); } }, opts.map((o) => h('option', { value: Array.isArray(o) ? o[0] : o }, Array.isArray(o) ? o[1] : o))); s.value = value; return s; };
  const colorBtn = (title, ic, key, def) => {
    const sw = h('span', { class: 'sw2', style: { background: def } });
    const b = h('button', { class: 'rb', type: 'button', ...tip(title), onmousedown: (e) => e.preventDefault(), onclick: () => colorMenu(b, null, (c) => { app.cmd('style', { [key]: c }); app.focusSink(); }, key === 'bg' ? 'No fill' : 'Automatic') }, h('span', { class: 'rbv' }, icon(ic), sw));
    return [b, sw];
  };
  app.fontSel = sel([['', 'Default'], ...FONTS], '', 'Font', (v) => app.cmd('style', { fn: v || null }), 'rs');
  app.sizeIn = h('input', { class: 'rs', type: 'number', min: 6, max: 96, value: 11, ...tip('Font size'), onchange: (e) => { app.cmd('style', { sz: +e.target.value === 11 ? null : +e.target.value }); app.focusSink(); } });
  app.nfSel = sel([...NFS, ['custom', 'Custom…']], 'General', 'Number format', (v) => (v === 'custom' ? app.cmd('formatCells') : app.cmd('nf', v)), 'rs');
  const [fcB, fcSw] = colorBtn('Text colour', 'font', 'fc', 'var(--text)');
  const [bgB, bgSw] = colorBtn('Fill colour', 'fill', 'bg', 'transparent');
  app.swFont = fcSw; app.swFill = bgSw;
  const menuBtn = (label, ic, title, items, opt = {}) => { const b = B(label, ic, title, () => menu(items(), b), { ...opt, keepFocus: true }); return b; };
  const tabsDef = {
    Home: () => [
      G('Clipboard', B('Paste', 'paste', 'Paste (Ctrl+V)', () => app.cmd('paste'), { big: true }),
        menuBtn('▾', null, 'Paste special', () => [{ label: 'Paste all', onclick: () => app.pasteInternal('all') }, { label: 'Values only', onclick: () => app.pasteInternal('values') }, { label: 'Formats only', onclick: () => app.pasteInternal('formats') }, { label: 'Transpose', onclick: () => app.pasteInternal('transpose') }]),
        B('Cut', 'cut', 'Cut (Ctrl+X)', () => app.cmd('cut')), B('Copy', 'copy', 'Copy (Ctrl+C)', () => app.cmd('copy'))),
      G('History', B('Undo', 'undo', 'Undo (Ctrl+Z)', () => app.undo()), B('Redo', 'redo', 'Redo (Ctrl+Y)', () => app.redo())),
      G('Font', app.fontSel, app.sizeIn, fmtB('B', 'Bold (Ctrl+B)', 'b'), fmtB('I', 'Italic (Ctrl+I)', 'i'), fmtB('U', 'Underline (Ctrl+U)', 'u'), fmtB('S', 'Strikethrough', 'st'), fcB, bgB,
        menuBtn('', 'border', 'Borders', () => [['all', 'All borders'], ['outer', 'Outside borders'], ['inner', 'Inside borders'], ['top', 'Top border'], ['bottom', 'Bottom border'], ['left', 'Left border'], ['right', 'Right border']].map(([k, l]) => ({ label: l, onclick: () => app.cmd('borders', { kind: k }) })).concat([{ label: 'Thick outside border', onclick: () => app.cmd('borders', { kind: 'outer', style: 'thick' }) }, { label: 'Dashed all borders', onclick: () => app.cmd('borders', { kind: 'all', style: 'dashed' }) }, { sep: true }, { label: 'No border', onclick: () => app.cmd('borders', { kind: 'none' }) }]))),
      G('Alignment', B('', 'left', 'Align left', () => app.cmd('style', { ha: 'left' })), B('', 'center', 'Centre', () => app.cmd('style', { ha: 'center' })), B('', 'right', 'Align right', () => app.cmd('style', { ha: 'right' })),
        B('', 'top', 'Align top', () => app.cmd('style', { va: 'top' })), B('', 'mid', 'Align middle', () => app.cmd('style', { va: 'center' })), B('', 'bottom', 'Align bottom', () => app.cmd('style', { va: null })),
        B('', 'wrap', 'Wrap text', () => app.toggleStyle('wr'), { toggle: (st) => st.wr }), B('', 'merge', 'Merge & centre', () => (app.sh.mergeAt(app.act.r, app.act.c) ? app.cmd('merge', true) : (app.cmd('merge'), app.cmd('style', { ha: 'center' })))),
        B('', 'indent', 'Increase indent', () => app.cmd('indent', 1)), B('', 'outdent', 'Decrease indent', () => app.cmd('indent', -1))),
      G('Number', app.nfSel, B('$', null, 'Currency', () => app.cmd('nf', '"$"#,##0.00')), B('%', null, 'Percent', () => app.cmd('nf', '0%')), B(',', null, 'Thousands separator', () => app.cmd('nf', '#,##0')), B('.0←', null, 'Fewer decimals', () => app.cmd('decimals', -1)), B('.00→', null, 'More decimals', () => app.cmd('decimals', 1))),
      G('Cells', menuBtn('Insert', 'plus', 'Insert', () => [{ label: 'Insert row(s) above', onclick: () => app.run(() => app.wb.insert(app.sh, 'r', app.sel.r1, app.sel.r2 - app.sel.r1 + 1)) }, { label: 'Insert column(s) left', onclick: () => app.run(() => app.wb.insert(app.sh, 'c', app.sel.c1, app.sel.c2 - app.sel.c1 + 1)) }, { label: 'Insert sheet', onclick: () => app.addSheet() }]),
        menuBtn('Delete', 'clear', 'Delete', () => [{ label: 'Delete row(s)', onclick: () => app.run(() => app.wb.remove(app.sh, 'r', app.sel.r1, app.sel.r2 - app.sel.r1 + 1)) }, { label: 'Delete column(s)', onclick: () => app.run(() => app.wb.remove(app.sh, 'c', app.sel.c1, app.sel.c2 - app.sel.c1 + 1)) }]),
        menuBtn('Format', null, 'Format', () => [{ label: 'Format cells…', kbd: 'Ctrl+1', onclick: () => app.cmd('formatCells') }, { label: 'Row height…', onclick: () => app.cmd('rowHeight') }, { label: 'Column width…', onclick: () => app.cmd('colWidth') }, { label: 'Autofit', onclick: () => app.cmd('autofit') }, { sep: true }, { label: 'Hide rows', onclick: () => app.cmd('hide', 'r') }, { label: 'Hide columns', onclick: () => app.cmd('hide', 'c') }, { label: 'Unhide rows', onclick: () => app.cmd('unhide', 'r') }, { label: 'Unhide columns', onclick: () => app.cmd('unhide', 'c') }])),
      G('Editing', B('AutoSum', 'sigma', 'AutoSum (Alt+=)', () => app.cmd('autosum'), { big: true }), menuBtn('Fill', null, 'Fill', () => [{ label: 'Down', kbd: 'Ctrl+D', onclick: () => app.fillDir('down') }, { label: 'Right', kbd: 'Ctrl+R', onclick: () => app.fillDir('right') }]),
        menuBtn('Clear', 'clear', 'Clear', () => [{ label: 'Clear all', onclick: () => app.clearSelection('all') }, { label: 'Clear contents', onclick: () => app.clearSelection('contents') }, { label: 'Clear formats', onclick: () => app.clearSelection('formats') }]),
        B('Find', 'search', 'Find & replace (Ctrl+F)', () => app.cmd('find'))),
    ],
    Insert: () => [
      G('Tables', B('Pivot table', 'pivot', 'Live pivot table (PIVOTBY formula)', () => app.cmd('pivot'), { big: true }), B('Table', 'filter', 'Create a table with structured references', () => app.cmd('table'), { big: true }), B('Properties', null, 'Table name, style, total row', () => app.cmd('tableProps'))),
      G('Illustrations', B('Picture', 'chart', 'Insert a picture', () => app.cmd('image'), { big: true })),
      G('Notes', B('New note', null, 'Add or edit a note on the cell', () => app.cmd('note')), B('Delete note', null, 'Delete the note', () => app.cmd('deleteNote'))),
      G('Charts', ...[['column', 'Column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'], ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Scatter']].map(([k, l]) => B(l, 'chart', `Insert ${l.toLowerCase()} chart`, () => app.cmd('chart', k)))),
      G('Sparklines', B('Line', null, 'Line sparkline', () => app.cmd('sparkline', 'line')), B('Column', null, 'Column sparkline', () => app.cmd('sparkline', 'column')), B('Win/Loss', null, 'Win/loss sparkline', () => app.cmd('sparkline', 'winloss'))),
      G('Functions', B('Function', 'fx', 'Insert function', () => app.cmd('insertFunction'), { big: true }), menuBtn('Sum ▾', 'sigma', 'AutoSum options', () => ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((f) => ({ label: f, onclick: () => app.cmd('autosum', f) })))),
    ],
    Data: () => [
      G('Get & transform', menuBtn('Get data', 'open', 'Import data into a refreshable query', () => [{ label: 'From range or table…', onclick: () => app.cmd('getData', 'range') }, { label: 'From CSV file…', onclick: () => app.cmd('getData', 'csv') }, { label: 'From JSON file…', onclick: () => app.cmd('getData', 'json') }], { big: true }), B('Queries', null, 'Edit, refresh or delete queries', () => app.cmd('queries'), { big: true }), B('Refresh all', null, 'Refresh every query', () => app.cmd('refreshAll'), { big: true })),
      G('Sort & filter', B('', 'sortaz', 'Sort A to Z', () => app.cmd('sort', true)), B('', 'sortza', 'Sort Z to A', () => app.cmd('sort', false)), B('Sort…', null, 'Custom sort', () => app.cmd('customSort')), B('Filter', 'filter', 'Filter (Ctrl+L)', () => app.cmd('filter'), { toggle: () => app.sh.filter }), B('Clear', null, 'Clear filter', () => app.cmd('clearFilter'))),
      G('Data tools', B('Remove duplicates', null, 'Remove duplicate rows', () => app.cmd('removeDup')), B('Text to columns', null, 'Split text into columns', () => app.cmd('textToCols')), B('Validation', null, 'Data validation', () => app.cmd('validation')), B('Goal seek', null, 'Goal seek', () => app.cmd('goalSeek'))),
      G('Conditional formatting', menuBtn('Highlight', 'fill', 'Highlight cells', () => [{ label: 'Greater than…', onclick: () => app.cmd('cf', 'gt') }, { label: 'Less than…', onclick: () => app.cmd('cf', 'lt') }, { label: 'Equal to…', onclick: () => app.cmd('cf', 'eq') }, { label: 'Text contains…', onclick: () => app.cmd('cf', 'text') }, { label: 'Duplicate values', onclick: () => app.cmd('cf', 'dup') }, { label: 'Unique values', onclick: () => app.cmd('cf', 'unique') }, { label: 'Blank cells', onclick: () => app.cmd('cf', 'blank') }, { label: 'Custom rule…', onclick: () => app.cmd('cf', 'custom') }]),
        menuBtn('Top/Bottom', null, 'Top and bottom rules', () => [{ label: 'Top 10…', onclick: () => app.cmd('cf', 'top') }, { label: 'Bottom 10…', onclick: () => app.cmd('cf', 'bottom') }]),
        menuBtn('Scales & bars', null, 'Colour scales and data bars', () => [{ label: 'Green–yellow–red', onclick: () => app.cmd('cf', 'scaleGYR') }, { label: 'Red–yellow–green', onclick: () => app.cmd('cf', 'scaleRYG') }, { label: 'White–green', onclick: () => app.cmd('cf', 'scaleW') }, { label: 'Red–white–blue', onclick: () => app.cmd('cf', 'scaleB') }, { label: 'Data bars', onclick: () => app.cmd('cf', 'bar') }]),
        menuBtn('Rules', null, 'Manage rules', () => [{ label: 'Manage rules…', onclick: () => app.cmd('manageCf') }, { label: 'Clear rules in selection', onclick: () => app.cmd('cf', 'clearSel') }, { label: 'Clear all rules on sheet', onclick: () => app.cmd('cf', 'clearAll') }])),
    ],
    Formulas: () => [
      G('Function library', B('Insert function', 'fx', 'Insert function', () => app.cmd('insertFunction'), { big: true }), B('AutoSum', 'sigma', 'AutoSum', () => app.cmd('autosum'), { big: true })),
      G('Names', B('Name manager', null, 'Named ranges and custom functions', () => app.cmd('names'), { big: true })),
      G('Auditing', B('Show formulas', null, 'Show formulas (Ctrl+`)', () => app.cmd('showFormulas'), { big: true, toggle: () => app.grid.showFormulas }), B('Recalculate', null, 'Recalculate (F9)', () => app.wb.dirty(), { big: true })),
    ],
    View: () => [
      G('Window', menuBtn('Freeze panes', 'freeze', 'Freeze panes', () => [{ label: 'Freeze top row', onclick: () => app.cmd('freeze', 'row') }, { label: 'Freeze first column', onclick: () => app.cmd('freeze', 'col') }, { label: 'Freeze panes at selection', onclick: () => app.cmd('freeze', 'at') }, { label: 'Unfreeze', onclick: () => app.cmd('freeze', 'none') }], { big: true })),
      G('Show', B('Gridlines', null, 'Toggle gridlines', () => app.cmd('gridlines'), { big: true, toggle: () => app.sh.showGrid }), B('Formulas', null, 'Show formulas', () => app.cmd('showFormulas'), { big: true, toggle: () => app.grid.showFormulas })),
      G('Zoom', B('100%', null, 'Reset zoom', () => app.cmd('zoomReset'), { big: true })),
    ],
    Tools: () => [
      G('Automate', B('Script console', null, 'Run JavaScript against the workbook', () => app.cmd('script'), { big: true }), B('Macros', null, 'Saved scripts in this workbook (and VBA project info)', () => app.cmd('macros'), { big: true })),
      G('Help', B('Shortcuts', null, 'Keyboard shortcuts', () => app.cmd('help'), { big: true }), B('About', null, 'About', () => app.cmd('about'), { big: true })),
    ],
    File: () => [
      G('File', B('New', 'plus', 'New workbook (Ctrl+N)', () => app.cmd('new'), { big: true }), B('Open', 'open', 'Open (Ctrl+O)', () => app.cmd('open'), { big: true }), B('Save', 'save', 'Save (Ctrl+S)', () => app.cmd('save'), { big: true }),
        menuBtn('Save as', 'save', 'Save as…', () => Object.entries(FORMATS).map(([k, f]) => ({ label: f.label + ' (.' + f.ext + ')', onclick: () => app.cmd('saveAs', { fmt: k }) })), { big: true })),
      G('Output', B('Print', 'print', 'Print (Ctrl+P)', () => app.cmd('print'), { big: true })),
    ],
  };
  const names = Object.keys(tabsDef);
  const show = (n) => {
    app.toggles = [];
    ribbon.replaceChildren(...tabsDef[n]());
    [...tabs.children].forEach((b) => b.setAttribute('aria-selected', b.dataset.t === n ? 'true' : 'false'));
    app.updateRibbonState();
    try { sessionStorage.setItem('sheetstudio-tab', n); } catch {}
  };
  tabs.replaceChildren(...names.map((n) => h('button', { type: 'button', role: 'tab', 'data-t': n, onclick: () => { show(n); app.focusSink(); } }, n)));
  let first = 'Home';
  try { first = sessionStorage.getItem('sheetstudio-tab') || 'Home'; } catch {}
  show(names.includes(first) ? first : 'Home');
}

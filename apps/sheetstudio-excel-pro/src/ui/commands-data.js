// Tables, live pivots, notes, pictures, macros and data queries.
import { App } from './app.js';
import { COMMANDS } from './commands.js';
import { MAXR, MAXC } from '../engine.js';
import { cellName, parseRefText, colName, tokenize, formatRef } from '../parser.js';
import { tableAt, tableColumns, tableRef, ACCENT_NAMES, uniqueTableName, escCol } from '../tables.js';
import { STEPS, describe, runQuery, loadQuery } from '../query.js';
import { grid as gridOf, isErr } from '../core.js';
import { h, $, toast, menu, dialog } from './util.js';

const cloneJ = (x) => JSON.parse(JSON.stringify(x));
const validName = (wb, name, self) => {
  if (!/^[A-Za-z_][\w.]*$/.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^[RrCc]$/.test(name)) return 'Use letters, digits, _ and . and start with a letter; it must not look like a cell address.';
  const t = wb.table(name);
  if ((t && t.t !== self) || wb.names.has(name.toUpperCase())) return `"${name}" is already used by a table or name.`;
  return null;
};

// ----- sheet-level helpers on the app -----
Object.assign(App.prototype, {
  // Replace Table[Col] references with plain A1 ranges (used when a table is converted to a range).
  unstructure(t) {
    const wb = this.wb, home = this.sh;
    for (const s of wb.sheets) {
      for (const [k, cell] of [...s.cells]) {
        if (cell.f == null) continue;
        let toks;
        try { toks = tokenize(cell.f); } catch { continue; }
        const r = Math.floor(k / 16384), c = k % 16384;
        let out = '', last = 0;
        for (const tk of toks) {
          const mine = tk.k === 'tref' ? (tk.table ? tk.table.toLowerCase() === t.name.toLowerCase() : s === home && tableAt(s, r, c) === t) : tk.k === 'id' && tk.v.toLowerCase() === t.name.toLowerCase();
          if (!mine) continue;
          let ref;
          try { ref = tableRef(wb, t.name, tk.k === 'tref' ? tk.spec : '[]', { sheet: s, row: r, col: c }); } catch { continue; }
          out += cell.f.slice(last, tk.s) + formatRef({ k: ref.r1 === ref.r2 && ref.c1 === ref.c2 ? 'cell' : 'range', sh: ref.sh === s ? null : ref.sh.name, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2, a: [true, true, true, true] });
          last = tk.e;
        }
        if (last) wb.putCell(s, r, c, { ...cell, f: out + cell.f.slice(last), c: undefined });
      }
    }
  },
  renameTable(old, neu) { // keep formulas pointing at the table when it is renamed
    const wb = this.wb;
    for (const s of wb.sheets) {
      for (const [k, cell] of [...s.cells]) {
        if (cell.f == null) continue;
        let toks;
        try { toks = tokenize(cell.f); } catch { continue; }
        let out = '', last = 0;
        for (const t of toks) if (t.k === 'tref' && t.table.toLowerCase() === old.toLowerCase()) { out += cell.f.slice(last, t.s) + neu + t.spec; last = t.e; } else if (t.k === 'id' && t.v.toLowerCase() === old.toLowerCase()) { out += cell.f.slice(last, t.s) + neu; last = t.e; }
        if (last) wb.putCell(s, Math.floor(k / 16384), k % 16384, { ...cell, f: out + cell.f.slice(last), c: undefined });
      }
    }
  },
});

Object.assign(COMMANDS, {
  // ---------- tables ----------
  async table() {
    const rg = this.dataRange(), sh = this.sh, wb = this.wb;
    if (rg.r2 < rg.r1 || (rg.r1 === rg.r2 && rg.c1 === rg.c2 && sh.get(rg.r1, rg.c1) == null)) { toast('Select the cells you want as a table first'); return; }
    if (sh.tables.some((t) => !(t.r2 < rg.r1 || t.r1 > rg.r2 || t.c2 < rg.c1 || t.c1 > rg.c2))) { toast('That range overlaps an existing table'); return; }
    const v = await dialog('Create table', [
      { name: 'name', label: 'Table name', value: uniqueTableName(wb) }, { name: 'hdr', type: 'checkbox', label: 'My table has headers', value: this.hasHeader(rg) },
      { name: 'accent', type: 'select', label: 'Style', value: 5, options: ACCENT_NAMES.map((n, i) => [i, n]) }, { name: 'band', type: 'checkbox', label: 'Banded rows', value: true },
      { name: 'f', type: 'checkbox', label: 'Filter buttons', value: !sh.filter },
    ], { ok: 'Create', hint: `Range ${this.addr(rg)}. Refer to it in formulas as Name[Column].` });
    if (!v) return;
    const bad = validName(wb, v.name.trim());
    if (bad) { toast(bad); return; }
    this.run(() => {
      let { r1, r2 } = rg;
      if (!v.hdr) { wb.insert(sh, 'r', r1, 1); r2++; }
      const seen = new Set();
      for (let c = rg.c1; c <= rg.c2; c++) {
        const cur = v.hdr ? sh.get(r1, c) : null;
        let nm = typeof cur === 'string' && cur ? cur : `Column${c - rg.c1 + 1}`, k = 2;
        const base = nm;
        while (seen.has(nm.toLowerCase())) nm = base + k++;
        seen.add(nm.toLowerCase());
        if (nm !== cur) sh.setValue(r1, c, nm);
      }
      this.prop('tables', () => sh.tables.push({ name: v.name.trim(), r1, c1: rg.c1, r2, c2: rg.c2, header: true, accent: +v.accent, band: v.band }));
      if (v.f && !sh.filter) { sh.filter = { r1, c1: rg.c1, r2, c2: rg.c2, crit: null }; }
    });
    this.grid.relayout();
  },
  async tableProps() {
    const sh = this.sh, wb = this.wb, t = tableAt(sh, this.act.r, this.act.c);
    if (!t) { toast('Click inside a table first'); return; }
    const v = await dialog(`Table "${t.name}"`, [
      { name: 'name', label: 'Name', value: t.name }, { name: 'range', label: 'Range', value: `${cellName(t.r1, t.c1)}:${cellName(t.r2, t.c2)}` },
      { name: 'accent', type: 'select', label: 'Style', value: t.accent ?? 0, options: ACCENT_NAMES.map((n, i) => [i, n]) }, { name: 'band', type: 'checkbox', label: 'Banded rows', value: t.band !== false },
      { name: 'totals', type: 'checkbox', label: 'Total row', value: !!t.totals }, { name: 'conv', type: 'checkbox', label: 'Convert to a normal range (keeps data and formatting, loses structured references)', value: false },
    ], { ok: 'Apply' });
    if (!v) return;
    const nm = v.name.trim(), bad = nm !== t.name && validName(wb, nm, t);
    if (bad) { toast(bad); return; }
    const rg = parseRefText(v.range.trim().replace(/^.*!/, ''));
    if (!rg) { toast('That range is not valid'); return; }
    this.run(() => {
      if (v.conv) {
        this.unstructure(t);
        this.prop('tables', () => { sh.tables = sh.tables.filter((x) => x.name !== t.name); });
        return;
      }
      if (nm !== t.name) this.renameTable(t.name, nm);
      this.prop('tables', () => {
        const x = sh.tables.find((y) => y.name === t.name);
        x.name = nm; x.accent = +v.accent; x.band = v.band;
        x.r1 = rg.r1; x.c1 = rg.c1; x.c2 = rg.c2; x.r2 = rg.r2;
        if (v.totals && !x.totals) {
          wb.insert(sh, 'r', x.r2 + 1, 1);
          x.r2++; x.totals = true;
          const cols = tableColumns(sh, x);
          cols.forEach((name, i) => {
            const numeric = [...Array(Math.max(0, x.r2 - x.r1 - 1)).keys()].some((k) => typeof sh.get(x.r1 + 1 + k, x.c1 + i) === 'number');
            sh.setInput(x.r2, x.c1 + i, i === 0 && !numeric ? 'Total' : numeric ? `=SUBTOTAL(109,${nm}[${escCol(name)}])` : '');
          });
        } else if (!v.totals && x.totals) { sh.clear(x.r2, x.c1, x.r2, x.c2, 'all'); x.r2--; x.totals = false; }
      });
    });
    this.grid.relayout();
  },

  // ---------- live pivot (PIVOTBY / GROUPBY formulas) ----------
  async pivot() {
    const sh = this.sh, wb = this.wb;
    const tb = tableAt(sh, this.act.r, this.act.c);
    const rg = tb ? { r1: tb.r1, c1: tb.c1, r2: tb.r2 - (tb.totals ? 1 : 0), c2: tb.c2 } : this.dataRange();
    if (rg.r2 <= rg.r1) { toast('Click inside a table or a block of data with a header row first'); return; }
    const names = Array.from({ length: rg.c2 - rg.c1 + 1 }, (_, i) => String(sh.get(rg.r1, rg.c1 + i) ?? colName(rg.c1 + i)));
    const opts = names.map((n, i) => [i, n]);
    const v = await dialog('Pivot table', [
      { name: 'r1', type: 'select', label: 'Rows', value: 0, options: opts }, { name: 'r2', type: 'select', label: 'Then by (optional)', value: '', options: [['', '(none)'], ...opts] },
      { name: 'c', type: 'select', label: 'Columns (optional)', value: '', options: [['', '(none)'], ...opts] },
      { name: 'v', type: 'select', label: 'Values', value: Math.min(1, names.length - 1), options: opts },
      { name: 'fn', type: 'select', label: 'Summarise by', value: 'SUM', options: [['SUM', 'Sum'], ['COUNTA', 'Count'], ['AVERAGE', 'Average'], ['MIN', 'Min'], ['MAX', 'Max'], ['MEDIAN', 'Median']] },
    ], { ok: 'Create', hint: `Source: ${tb ? tb.name : this.addr(rg)}. The result is a live PIVOTBY formula on a new sheet: it updates when the data changes.` });
    if (!v) return;
    const sp = /^[A-Za-z_][\w.]*$/.test(sh.name) ? sh.name + '!' : `'${sh.name.replace(/'/g, "''")}'!`;
    const ref = (i) => (tb ? `${tb.name}[[#All],[${escCol(names[i])}]]` : `${sp}$${colName(rg.c1 + +i)}$${rg.r1 + 1}:$${colName(rg.c1 + +i)}$${rg.r2 + 1}`);
    const rows = v.r2 === '' ? ref(v.r1) : `HSTACK(${ref(v.r1)},${ref(v.r2)})`;
    const f = v.c === '' ? `GROUPBY(${rows},${ref(v.v)},${v.fn},3)` : `PIVOTBY(${rows},${ref(v.c)},${ref(v.v)},${v.fn},3)`;
    let ns;
    this.run(() => { ns = wb.addSheet('Pivot'); ns.setInput(0, 0, '=' + f); ns.colW.set(0, 150); });
    this.renderSheets(); this.switchSheet(ns);
    const first = ns.get(0, 0);
    if (first && first.c) toast(`The pivot formula returned ${first.c}. Check the source data.`);
    else toast('Pivot created. Select cell A1 to see the formula.');
  },

  // ---------- notes ----------
  async note() {
    const { r, c } = this.act, sh = this.sh;
    const cur = sh.notes.find((n) => n.r === r && n.c === c);
    const v = await dialog(`Note on ${cellName(r, c)}`, [{ name: 't', type: 'textarea', label: 'Text', value: cur ? cur.text : '', rows: 5 }], { ok: 'Save', hint: 'Leave empty to remove the note.' });
    if (!v) return;
    this.prop('notes', () => { sh.notes = sh.notes.filter((n) => !(n.r === r && n.c === c)); if (v.t.trim()) sh.notes.push({ r, c, text: v.t }); });
  },
  deleteNote() { const { r, c } = this.act, sh = this.sh; this.prop('notes', () => { sh.notes = sh.notes.filter((n) => !(n.r === r && n.c === c)); }); },

  // ---------- pictures ----------
  image() {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml' });
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 8e6) { toast('That picture is larger than 8 MB'); return; }
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 480 / img.naturalWidth, 360 / img.naturalHeight), g = this.grid, sh = this.sh;
          const pic = { id: 'i' + Date.now().toString(36), name: f.name, alt: '', data: rd.result, x: Math.round(g.sc.scrollLeft / g.z + 60), y: Math.round(g.sc.scrollTop / g.z + 60), w: Math.max(16, Math.round(img.naturalWidth * k)), h: Math.max(16, Math.round(img.naturalHeight * k)) };
          this.prop('images', () => sh.images.push(pic));
          this.syncCharts(true);
          if (!/png|jpeg|gif|bmp/.test(f.type)) toast('This picture type shows here but is not saved into .xlsx files (use PNG, JPEG, GIF or BMP).', 6000);
        };
        img.onerror = () => toast('That file could not be read as a picture');
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    });
    inp.click();
  },
  async editImage(im) {
    const v = await dialog('Picture', [{ name: 'alt', label: 'Alt text (for screen readers)', value: im.alt || '' }, { name: 'w', type: 'number', label: 'Width (px)', value: im.w, min: 16 }], { ok: 'Apply' });
    if (!v) return;
    this.prop('images', () => { const x = this.sh.images.find((i) => i.id === im.id); if (x) { x.alt = v.alt; if (v.w >= 16) { x.h = Math.round(x.h * v.w / x.w); x.w = Math.round(v.w); } } });
    this.syncCharts(true);
  },

  // ---------- macros & script console ----------
  async script(init) {
    const app = this, wb = this.wb;
    const out = h('pre', { class: 'out' }, 'Output appears here.');
    const sample = '// S.get("A1")  S.set("A1", 5)  S.range("A1:B3")  S.setRange("D1", [[1,2],[3,4]])\n// S.addSheet("New")  S.log(...)  S.selection  S.toast("hi")\nconst nums = S.range("A1:A10").flat().filter(v => typeof v === "number");\nS.log("sum =", nums.reduce((a, b) => a + b, 0));\n';
    const ta = h('textarea', { rows: 10, spellcheck: 'false', 'aria-label': 'Script', style: { width: '100%', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12.5px' } }, (init && init.code) || this.lastScript || sample);
    const nm = h('input', { type: 'text', class: 'rs', placeholder: 'Macro name (to save)', value: (init && init.name) || '', 'aria-label': 'Macro name', style: { width: '220px' } });
    const run = h('button', { class: 'btn primary', type: 'button', onclick: async () => { this.lastScript = ta.value; out.textContent = await runScript(app, ta.value); } }, 'Run');
    const save = h('button', { class: 'btn', type: 'button', onclick: () => {
      if (!nm.value.trim()) { toast('Give the macro a name first'); return; }
      const list = wb.scripts || (wb.scripts = []), i = list.findIndex((s) => s.name === nm.value.trim());
      if (i >= 0) list[i].code = ta.value; else list.push({ name: nm.value.trim(), code: ta.value });
      app.modified = true; app.scheduleSave(); app.updateTitle();
      toast(`Saved macro "${nm.value.trim()}" in this workbook`);
    } }, 'Save as macro');
    await dialog('Script console', [{ type: 'html', el: ta }, { type: 'html', el: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, run, nm, save) }, { type: 'html', el: out }, { type: 'html', el: h('p', { class: 'muted', style: { margin: 0 } }, 'Runs as JavaScript in this page, offline. Synchronous scripts are one undo step. Macros are saved in .sheetstudio files.') }], { cancel: null, ok: 'Close', width: 660 });
  },
  async macros() {
    const wb = this.wb, app = this;
    const body = h('div');
    const draw = () => {
      const list = wb.scripts || [];
      body.replaceChildren(
        list.length ? h('table', { class: 'tbl' }, list.map((s, i) => h('tr', null, h('td', null, s.name),
          h('td', null, h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { const r = await runScript(app, s.code); toast(r.split('\n')[0].slice(0, 120)); } }, 'Run'), ' ',
            h('button', { class: 'btn sm', type: 'button', onclick: () => { document.querySelector('.modal-back')?.remove(); app.cmd('script', s); } }, 'Edit'), ' ',
            h('button', { class: 'btn sm', type: 'button', onclick: () => { list.splice(i, 1); app.modified = true; draw(); } }, 'Delete'))))) : h('p', { class: 'muted' }, 'No macros yet. Write a script in the Script console and choose "Save as macro".'),
        wb.vba ? h('p', { class: 'muted' }, `This file also contains a VBA project (${wb.vba.length.toLocaleString()} bytes). It is preserved when you save as .xlsm but cannot run in this app.`) : null);
    };
    draw();
    await dialog('Macros', [{ type: 'html', el: body }], { cancel: null, ok: 'Close', width: 520, extra: h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => app.cmd('script') }, 'New script…')) });
  },

  // ---------- queries ----------
  async getData(kind) {
    if (kind === 'range') {
      const sel = tableAt(this.sh, this.act.r, this.act.c);
      const v = await dialog('Query from range or table', [{ name: 'ref', label: 'Range or table name', value: sel ? sel.name : this.qaddr(this.dataRange()) }], { ok: 'Next' });
      if (!v) return;
      return editQuery(this, newQuery(this, { type: 'range', ref: v.ref.trim() }, 'FromRange'));
    }
    const inp = h('input', { type: 'file', accept: kind === 'json' ? '.json,application/json' : '.csv,.tsv,.txt' });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return;
      editQuery(this, newQuery(this, { type: kind, text: await f.text(), file: f.name }, f.name.replace(/\.[^.]+$/, '').replace(/\W+/g, '_') || 'Query'));
    });
    inp.click();
  },
  async queries() {
    const wb = this.wb, app = this, body = h('div');
    const draw = () => {
      const list = wb.queries || [];
      body.replaceChildren(list.length ? h('table', { class: 'tbl' }, list.map((q) => h('tr', null, h('td', null, h('b', null, q.name), h('div', { class: 'muted' }, `${q.source.type}${q.source.ref ? ' ' + q.source.ref : q.source.file ? ' ' + q.source.file : ''} · ${q.steps.length} step(s) → ${q.dest ? q.dest.sheet : ''}`)),
        h('td', null, h('button', { class: 'btn sm primary', type: 'button', onclick: () => { refreshQuery(app, q); draw(); } }, 'Refresh'), ' ',
          h('button', { class: 'btn sm', type: 'button', onclick: () => { document.querySelector('.modal-back')?.remove(); editQuery(app, q); } }, 'Edit'), ' ',
          h('button', { class: 'btn sm', type: 'button', onclick: () => { wb.queries = list.filter((x) => x !== q); app.modified = true; draw(); } }, 'Delete'))))) : h('p', { class: 'muted' }, 'No queries yet. Use Data → Get data.'));
    };
    draw();
    await dialog('Queries', [{ type: 'html', el: body }], { cancel: null, ok: 'Close', width: 560, extra: h('div', null, h('button', { class: 'btn sm', type: 'button', onclick: () => { (wb.queries || []).forEach((q) => refreshQuery(app, q)); draw(); } }, 'Refresh all')) });
  },
  refreshAll() { (this.wb.queries || []).forEach((q) => refreshQuery(this, q)); if (!(this.wb.queries || []).length) toast('This workbook has no queries'); },
});

function newQuery(app, source, name) {
  const taken = new Set([...(app.wb.queries || []).map((q) => q.name.toLowerCase()), ...app.wb.sheets.map((s) => s.name.toLowerCase())]);
  let n = name.slice(0, 28), i = 2;
  const base = n;
  while (taken.has(n.toLowerCase())) n = base + i++;
  return { id: 'q' + Date.now().toString(36), name: n, source, steps: [], dest: null, out: null };
}

export function refreshQuery(app, q) {
  const wb = app.wb;
  try {
    app.run(() => {
      const before = cloneJ(wb.queries || []);
      loadQuery(wb, q);
      const after = cloneJ(wb.queries || []);
      wb.rec(() => { wb.queries = cloneJ(before); }, () => { wb.queries = cloneJ(after); });
    });
    toast(`Refreshed "${q.name}"`);
  } catch (e) { toast(`"${q.name}": ${e.message}`, 6000); }
}

async function runScript(app, code) {
  const wb = app.wb, logs = [];
  const resolve = (a1) => { const r = wb.refFromString(a1, app.sh); if (!r) throw new Error('Bad reference: ' + a1); return r; };
  const val = (v) => (v && v.c ? v.c : v);
  const put = (r, rr, cc, v) => r.sh.setInput(rr, cc, typeof v === 'string' ? v : v == null ? '' : v);
  const S = {
    get: (a) => { const r = resolve(a); return val(r.sh.get(r.r1, r.c1)); },
    set: (a, v) => { const r = resolve(a); put(r, r.r1, r.c1, v); },
    range: (a) => gridOf(resolve(a)).map((row) => row.map(val)),
    setRange: (a, rows) => { const r = resolve(a); rows.forEach((row, i) => row.forEach((v, j) => put(r, r.r1 + i, r.c1 + j, v))); },
    addSheet: (n) => wb.addSheet(n).name, log: (...x) => logs.push(x.map((y) => (typeof y === 'object' ? JSON.stringify(y) : String(y))).join(' ')),
    toast: (m) => toast(String(m)), get selection() { return app.qaddr(); }, get used() { return { rows: app.sh.maxR + 1, cols: app.sh.maxC + 1 }; },
  };
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFn('S', code);
    let p;
    wb.tx(() => { p = fn(S); });
    await p;
    wb.dirty();
    app.renderSheets();
    return logs.join('\n') || 'Done.';
  } catch (e) { return 'Error: ' + (e && e.message ? e.message : e); }
}

// ---------- query editor ----------
function editQuery(app, q0) {
  return new Promise((resolve) => {
    const q = cloneJ(q0), wb = app.wb, isNew = !(wb.queries || []).some((x) => x.id === q.id);
    const nameIn = h('input', { type: 'text', class: 'rs', value: q.name, 'aria-label': 'Query name', style: { width: '100%' } });
    const stepsEl = h('ol', { class: 'steps' }), prevEl = h('div', { class: 'prev' }), fieldsEl = h('div', { class: 'qf' });
    const opSel = h('select', { class: 'rs', 'aria-label': 'Step type', onchange: () => renderFields() }, Object.entries(STEPS).map(([k, d]) => h('option', { value: k }, d.label)));
    let inputs = {};
    const heads = () => { try { return runQuery(wb, q)[0] || []; } catch { return []; } };
    const renderFields = () => {
      inputs = {};
      const hs = heads();
      fieldsEl.replaceChildren(...STEPS[opSel.value].f.map(([k, kind, label, options]) => {
        let el;
        if (kind === 'col') el = h('select', { class: 'rs' }, hs.map((x) => h('option', { value: x }, x)));
        else if (kind === 'cols') el = h('select', { class: 'rs', multiple: true, size: Math.min(6, Math.max(3, hs.length)) }, hs.map((x) => h('option', { value: x }, x)));
        else if (kind === 'select') el = h('select', { class: 'rs' }, options.map(([v, l]) => h('option', { value: v }, l)));
        else el = h('input', { class: 'rs', type: kind === 'num' ? 'number' : 'text', style: { width: '100%' } });
        inputs[k] = [kind, el];
        return h('label', { class: 'fld' }, h('span', null, label), el);
      }));
    };
    const refresh = () => {
      let rows = [], err = '';
      try { rows = runQuery(wb, q); } catch (e) { err = e.message; }
      stepsEl.replaceChildren(h('li', { class: 'muted' }, `Source: ${q.source.type}${q.source.ref ? ' ' + q.source.ref : q.source.file ? ' ' + q.source.file : ''}`), ...q.steps.map((s, i) => h('li', null, describe(s), ' ', h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Remove step', onclick: () => { q.steps.splice(i, 1); refresh(); renderFields(); } }, '✕'))));
      prevEl.replaceChildren(err ? h('p', { style: { color: 'var(--danger)' } }, err) : h('div', null, h('table', { class: 'tbl' }, rows.slice(0, 11).map((r, i) => h('tr', null, r.slice(0, 12).map((v) => h(i ? 'td' : 'th', null, v == null ? '' : String(v)))))), h('p', { class: 'muted' }, `${Math.max(0, rows.length - 1).toLocaleString()} rows × ${rows[0] ? rows[0].length : 0} columns`)));
    };
    const addStep = () => {
      const s = { op: opSel.value };
      for (const [k, [kind, el]] of Object.entries(inputs)) {
        if (kind === 'cols') s[k] = [...el.selectedOptions].map((o) => o.value);
        else s[k] = kind === 'num' ? +el.value : el.value;
        if ((kind === 'cols' && !s[k].length) || (kind === 'col' && s[k] === '')) { toast('Choose a column first'); return; }
      }
      q.steps.push(s);
      refresh(); renderFields();
    };
    const done = (v) => { back.remove(); resolve(v); };
    const load = () => {
      q.name = nameIn.value.trim() || 'Query';
      try { runQuery(wb, q); } catch (e) { toast(e.message, 6000); return; }
      let dest;
      app.run(() => {
        const before = cloneJ(wb.queries || []);
        dest = wb.sheet(q.dest && q.dest.sheet);
        if (!dest) { dest = wb.addSheet(q.name); q.dest = { sheet: dest.name, r: 0, c: 0 }; }
        const list = wb.queries || (wb.queries = []), i = list.findIndex((x) => x.id === q.id);
        if (i >= 0) list[i] = q; else list.push(q);
        loadQuery(wb, q);
        const after = cloneJ(wb.queries);
        wb.rec(() => { wb.queries = cloneJ(before); }, () => { wb.queries = cloneJ(after); });
      });
      app.renderSheets(); app.switchSheet(dest);
      toast(`Loaded "${q.name}" to sheet "${dest.name}"`);
      done(true);
    };
    const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Query editor', style: { width: 'min(900px,100%)' } },
      h('h2', null, isNew ? 'New query' : 'Edit query'),
      h('div', { class: 'body', style: { display: 'grid', gridTemplateColumns: 'minmax(220px,300px) 1fr', gap: '14px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, h('label', { class: 'fld' }, h('span', null, 'Name'), nameIn), h('b', null, 'Applied steps'), stepsEl, h('b', null, 'Add step'), opSel, fieldsEl, h('button', { class: 'btn', type: 'button', onclick: addStep }, 'Add step')),
        h('div', { style: { overflow: 'auto', maxHeight: '60vh' } }, h('b', null, 'Preview'), prevEl)),
      h('div', { class: 'foot' }, h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: load }, 'Close & load'))));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    document.body.append(back);
    refresh(); renderFields();
    nameIn.focus();
  });
}

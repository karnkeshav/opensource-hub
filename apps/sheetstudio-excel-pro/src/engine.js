// Workbook / Sheet model, formula compiler and lazy evaluator, undo, structural edits.
import {
  E, errOf, isErr, isRef, isArr, isLambda, num, str, scalar, grid, lift1, lift2, cmp, callLambda, parseInput, eachRef,
} from './core.js';
import { parse, rewriteRefs, shiftFormula, parseRefText, tokenize, MAXR, MAXC, formatRef } from './parser.js';
import { tableRef, escCol } from './tables.js';
import { F, pow } from './functions.js';
import { format, isDateFormat } from './numfmt.js';

export { MAXR, MAXC };
export const K = (r, c) => r * 16384 + c;
export const keyR = (k) => Math.floor(k / 16384);
export const keyC = (k) => k % 16384;

// ---------- compiler ----------
const chk = (a, b) => { if (isErr(a)) throw a; if (isErr(b)) throw b; };
const BIN = {
  '+': (a, b) => num(a) + num(b),
  '-': (a, b) => num(a) - num(b),
  '*': (a, b) => num(a) * num(b),
  '/': (a, b) => { const d = num(b); if (d === 0) throw E.DIV0; return num(a) / d; },
  '^': (a, b) => pow(num(a), num(b)),
  '&': (a, b) => str(a) + str(b),
  '=': (a, b) => { chk(a, b); return cmp(a, b) === 0; },
  '<>': (a, b) => { chk(a, b); return cmp(a, b) !== 0; },
  '<': (a, b) => { chk(a, b); return cmp(a, b) < 0; },
  '>': (a, b) => { chk(a, b); return cmp(a, b) > 0; },
  '<=': (a, b) => { chk(a, b); return cmp(a, b) <= 0; },
  '>=': (a, b) => { chk(a, b); return cmp(a, b) >= 0; },
};

function lookupName(ctx, key) {
  if (ctx.env && key in ctx.env) return ctx.env[key];
  const d = ctx.wb.names.get(key);
  if (!d) {
    if (ctx.wb.table(key)) return tableRef(ctx.wb, key, '[]', ctx); // bare table name = its data body
    const nf = F[key];
    return nf && !nf.lazy ? { lambda: true, native: nf, params: [] } : undefined; // bare function name usable as a lambda, e.g. GROUPBY(..., SUM)
  }
  if (!d.c) d.c = compile(parse(d.f));
  return d.c({ ...ctx, env: null });
}

export function compile(n) {
  switch (n.t) {
    case 'num': case 'str': case 'bool': { const v = n.v; return () => v; }
    case 'err': { const e = errOf(n.v); return () => e; }
    case 'empty': return () => undefined;
    case 'ref': {
      const { sh, r1, c1, r2, c2 } = n;
      return (ctx) => {
        const s = sh == null ? ctx.sheet : ctx.wb.sheet(sh);
        if (!s) throw E.REF;
        return { ref: true, sh: s, r1, c1, r2, c2 };
      };
    }
    case 'range': {
      const a = compile(n.a), b = compile(n.b);
      return (ctx) => {
        const x = a(ctx), y = b(ctx);
        if (!isRef(x) || !isRef(y) || x.sh !== y.sh) throw E.VALUE;
        return { ref: true, sh: x.sh, r1: Math.min(x.r1, y.r1), c1: Math.min(x.c1, y.c1), r2: Math.max(x.r2, y.r2), c2: Math.max(x.c2, y.c2) };
      };
    }
    case 'tref': return (ctx) => tableRef(ctx.wb, n.table, n.spec, ctx);
    case 'spill': {
      const rf = compile(n.ref);
      return (ctx) => {
        const x = rf(ctx);
        x.sh.get(x.r1, x.c1);
        const an = x.sh.anchors.get(K(x.r1, x.c1));
        if (!an) throw E.REF;
        return { ref: true, sh: x.sh, r1: x.r1, c1: x.c1, r2: x.r1 + an.rows - 1, c2: x.c1 + an.cols - 1 };
      };
    }
    case 'name': {
      const key = n.n.toUpperCase();
      return (ctx) => { const v = lookupName(ctx, key); if (v === undefined) throw E.NAME; return v; };
    }
    case 'un': {
      const e = compile(n.e);
      return n.op === '-' ? (ctx) => lift1(e(ctx), (x) => -num(x)) : (ctx) => e(ctx);
    }
    case 'pct': { const e = compile(n.e); return (ctx) => lift1(e(ctx), (x) => num(x) / 100); }
    case 'bin': {
      const l = compile(n.l), r = compile(n.r), f = BIN[n.op];
      return (ctx) => lift2(l(ctx), r(ctx), f);
    }
    case 'arr': {
      const rows = n.rows.map((r) => r.map(compile));
      return (ctx) => rows.map((r) => r.map((c) => scalar(c(ctx))));
    }
    case 'call': {
      const name = n.n.toUpperCase(), f = F[name], cs = n.a.map(compile);
      if (!f) {
        return (ctx) => {
          const lv = lookupName(ctx, name);
          if (isLambda(lv)) return callLambda(lv, cs.map((c) => c(ctx)), ctx);
          throw E.NAME;
        };
      }
      if (f.lazy) return (ctx) => f(cs, ctx, n.a);
      return (ctx) => f(cs.map((c) => c(ctx)), ctx);
    }
    case 'callx': {
      const fc = compile(n.f), cs = n.a.map(compile);
      return (ctx) => { const l = fc(ctx); if (!isLambda(l)) throw E.VALUE; return callLambda(l, cs.map((c) => c(ctx)), ctx); };
    }
  }
  throw new Error('bad node');
}

const SPILLY = /\b(SORT|SORTBY|FILTER|UNIQUE|SEQUENCE|TRANSPOSE|RANDARRAY|TAKE|DROP|VSTACK|HSTACK|TEXTSPLIT|MAP|SCAN|BYROW|BYCOL|MAKEARRAY|TOCOL|TOROW|CHOOSECOLS|CHOOSEROWS|MMULT|MINVERSE|MUNIT|WRAPROWS|REGEXEXTRACT)\(|#/i;

// ---------- styles ----------
const styleKey = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

// ---------- sheet ----------
const cloneJ = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export class Sheet {
  constructor(wb, name) {
    this.wb = wb; this.name = name;
    this.cells = new Map(); this.cache = new Map(); this.spillVals = new Map(); this.anchors = new Map(); this.busy = new Set();
    this.maxR = -1; this.maxC = -1; this.fkeys = null;
    this.colW = new Map(); this.rowH = new Map(); this.hiddenRows = new Set(); this.hiddenCols = new Set(); this.filtered = new Set();
    this.colStyle = new Map(); this.rowStyle = new Map();
    this.merges = []; this.freeze = { r: 0, c: 0 }; this.cf = []; this.dv = []; this.charts = []; this.filter = null;
    this.tables = []; this.notes = []; this.images = [];
    this.showGrid = true; this.cfCache = new Map();
  }

  cell(r, c) { return this.cells.get(r * 16384 + c); }

  get(r, c) {
    const k = r * 16384 + c, cell = this.cells.get(k);
    if (cell === undefined) { const s = this.spillVals.get(k); return s === undefined ? null : s; }
    return cell.f == null ? cell.v : this.evalCell(r, c, k, cell);
  }

  evalCell(r, c, k, cell) {
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    if (this.busy.has(k)) return E.CIRC;
    this.busy.add(k);
    let v;
    try {
      if (!cell.c) { try { cell.c = compile(parse(cell.f)); } catch { cell.c = () => { throw E.NAME; }; } }
      v = this.settle(cell.c({ wb: this.wb, sheet: this, row: r, col: c, env: null }), r, c, k);
    } catch (e) {
      v = isErr(e) ? e : e instanceof RangeError ? E.CALC : (console.error(e), E.VALUE);
    } finally { this.busy.delete(k); }
    this.cache.set(k, v);
    return v;
  }

  settle(v, r, c, k) {
    if (isRef(v)) v = v.r2 > v.r1 || v.c2 > v.c1 ? grid(v) : v.sh.get(v.r1, v.c1);
    if (isArr(v)) {
      if (v.length === 1 && v[0].length === 1) v = v[0][0];
      else return this.spill(v, r, c, k);
    }
    if (isLambda(v)) return E.CALC;
    return v == null ? 0 : v;
  }

  spill(g, r, c, k) {
    const R = g.length, C = g[0].length;
    if (r + R > MAXR || c + C > MAXC) return E.SPILL;
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      if (i || j) { const kk = (r + i) * 16384 + c + j; if (this.cells.has(kk) || this.spillVals.has(kk)) return E.SPILL; }
    }
    this.anchors.set(k, { rows: R, cols: C });
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) if (i || j) this.spillVals.set((r + i) * 16384 + c + j, g[i][j] == null ? 0 : g[i][j]);
    this.maxR = Math.max(this.maxR, r + R - 1); this.maxC = Math.max(this.maxC, c + C - 1);
    return g[0][0] == null ? 0 : g[0][0];
  }

  // Is (r,c) covered by a spill range (but not its anchor)?
  isSpilled(r, c) { return this.spillVals.has(r * 16384 + c) && !this.cells.has(r * 16384 + c); }

  styleAt(r, c) {
    const cell = this.cells.get(r * 16384 + c);
    if (cell) return cell.s;
    return this.rowStyle.get(r) ?? this.colStyle.get(c) ?? 0;
  }

  formulaKeys() {
    if (!this.fkeys) {
      const a = [], b = [];
      for (const [k, cell] of this.cells) if (cell.f != null) (cell.sp === undefined ? (cell.sp = SPILLY.test(cell.f)) : cell.sp) ? a.push(k) : b.push(k);
      this.fkeys = { a: a.sort((x, y) => x - y), b: b.sort((x, y) => x - y) };
    }
    return this.fkeys;
  }

  mergeAt(r, c) {
    for (const m of this.merges) if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
    return null;
  }

  rowHidden(r) { return this.hiddenRows.has(r) || this.filtered.has(r); }

  snap() {
    return {
      cells: new Map(this.cells), colW: new Map(this.colW), rowH: new Map(this.rowH), hiddenRows: new Set(this.hiddenRows), hiddenCols: new Set(this.hiddenCols),
      colStyle: new Map(this.colStyle), rowStyle: new Map(this.rowStyle), merges: cloneJ(this.merges), cf: cloneJ(this.cf), dv: cloneJ(this.dv),
      charts: cloneJ(this.charts), filter: cloneJ(this.filter), freeze: { ...this.freeze }, name: this.name, maxR: this.maxR, maxC: this.maxC,
      tables: cloneJ(this.tables), notes: cloneJ(this.notes), images: this.images.map((i) => ({ ...i })),
    };
  }
  restore(s) {
    this.cells = new Map(s.cells); this.colW = new Map(s.colW); this.rowH = new Map(s.rowH); this.hiddenRows = new Set(s.hiddenRows); this.hiddenCols = new Set(s.hiddenCols);
    this.colStyle = new Map(s.colStyle); this.rowStyle = new Map(s.rowStyle); this.merges = cloneJ(s.merges); this.cf = cloneJ(s.cf); this.dv = cloneJ(s.dv);
    this.charts = cloneJ(s.charts); this.filter = cloneJ(s.filter); this.freeze = { ...s.freeze }; this.name = s.name; this.maxR = s.maxR; this.maxC = s.maxC;
    this.tables = cloneJ(s.tables || []); this.notes = cloneJ(s.notes || []); this.images = (s.images || []).map((i) => ({ ...i }));
    this.fkeys = null;
  }

  // ---- display ----
  fmtOf(r, c) { return this.wb.styles[this.styleAt(r, c)].nf; }
  display(r, c) {
    const v = this.get(r, c);
    return displayValue(v, this.fmtOf(r, c));
  }

  // ---- editing (call inside wb.tx) ----
  put(r, c, cell) { this.wb.putCell(this, r, c, cell); }
  setInput(r, c, text) {
    const prev = this.cell(r, c);
    let s = prev ? prev.s : (this.rowStyle.get(r) ?? this.colStyle.get(c) ?? 0);
    if (typeof text === 'string' && text.length > 1 && text[0] === '=') { this.put(r, c, { v: null, f: text.slice(1), s }); return; }
    const p = parseInput(text);
    if (p.nf && !this.wb.styles[s].nf) s = this.wb.mergeStyle(s, { nf: p.nf });
    if (p.v === null && s === 0) this.put(r, c, null);
    else this.put(r, c, { v: p.v, f: null, s });
  }
  setValue(r, c, v) {
    const prev = this.cell(r, c);
    const s = prev ? prev.s : (this.rowStyle.get(r) ?? this.colStyle.get(c) ?? 0);
    if (v == null && s === 0) this.put(r, c, null); else this.put(r, c, { v: v ?? null, f: null, s });
  }
  setStyle(r, c, s) {
    const prev = this.cell(r, c);
    if (!prev && s === (this.rowStyle.get(r) ?? this.colStyle.get(c) ?? 0)) return;
    if (!prev && s === 0) return;
    this.put(r, c, prev ? { ...prev, s } : { v: null, f: null, s });
  }
  patchStyle(r1, c1, r2, c2, patch) {
    // Whole-column / whole-row selections are stored as column/row styles to avoid millions of cells.
    const wb = this.wb;
    if (r1 === 0 && r2 >= MAXR - 1) {
      for (let c = c1; c <= c2; c++) this.setColStyle(c, wb.mergeStyle(this.colStyle.get(c) ?? 0, patch));
      for (const [k, cell] of [...this.cells]) { const c = keyC(k); if (c >= c1 && c <= c2) this.put(keyR(k), c, { ...cell, s: wb.mergeStyle(cell.s, patch) }); }
      return;
    }
    if (c1 === 0 && c2 >= MAXC - 1) {
      for (let r = r1; r <= r2; r++) this.setRowStyle(r, wb.mergeStyle(this.rowStyle.get(r) ?? 0, patch));
      for (const [k, cell] of [...this.cells]) { const r = keyR(k); if (r >= r1 && r <= r2) this.put(r, keyC(k), { ...cell, s: wb.mergeStyle(cell.s, patch) }); }
      return;
    }
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.setStyle(r, c, wb.mergeStyle(this.styleAt(r, c), patch));
  }
  setColStyle(c, s) { this.prop('colStyle', c, s || undefined); }
  setRowStyle(r, s) { this.prop('rowStyle', r, s || undefined); }
  // Undoable change of one entry in a Map/Set-valued property.
  prop(name, key, val) {
    const m = this[name], had = m.has(key), old = m.get(key);
    const apply = (has, v) => { if (m instanceof Set) { has ? m.add(key) : m.delete(key); } else if (has) m.set(key, v); else m.delete(key); };
    const set = m instanceof Set ? val : val !== undefined;
    apply(set, val);
    this.wb.rec(() => apply(had, old), () => apply(set, val));
  }
  setColW(c, w) { this.prop('colW', c, w); }
  setRowH(r, h) { this.prop('rowH', r, h); }
  clear(r1, c1, r2, c2, what = 'all') {
    const keep = what === 'contents', fmt = what === 'formats';
    const hit = [];
    for (const [k, cell] of this.cells) {
      const r = keyR(k), c = keyC(k);
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) hit.push([r, c, cell]);
    }
    for (const [r, c, cell] of hit) {
      if (fmt) this.put(r, c, { ...cell, s: 0 });
      else if (keep || what === 'all') {
        const s = keep ? cell.s : 0;
        this.put(r, c, s ? { v: null, f: null, s } : null);
      }
    }
  }
}

export function displayValue(v, nf) {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'object') {
    if (v.c) return { text: v.c, err: true };
    if (v.spark) return { text: '', spark: v };
    return { text: String(v) };
  }
  const f = format(v, nf);
  return { text: f.text, color: f.color, num: typeof v === 'number' };
}

// ---------- workbook ----------
export class Workbook {
  constructor() {
    this.sheets = []; this.names = new Map(); this.styles = [{}]; this.styleIdx = new Map([[styleKey({}), 0]]);
    this.undoStack = []; this.redoStack = []; this.cur = null; this.ver = 0; this.warmed = false; this.onChange = null; this.depth = 0;
    this.addSheet('Sheet1');
  }

  sheet(name) {
    const n = String(name).toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === n) || null;
  }
  table(name) {
    const n = String(name).toLowerCase();
    for (const sh of this.sheets) { const t = sh.tables.find((x) => x.name.toLowerCase() === n); if (t) return { sh, t }; }
    return null;
  }
  // Keep structured references valid when a table header is renamed.
  renameTableColumn(sh, t, from, to) {
    if (!from || !to || from === to) return;
    const a = escCol(from), b = escCol(to);
    const fix = (f, own) => {
      let toks;
      try { toks = tokenize(f); } catch { return f; }
      let out = '', last = 0;
      for (const k of toks) {
        if (k.k !== 'tref') continue;
        const mine = k.table ? k.table.toLowerCase() === t.name.toLowerCase() : own === sh;
        if (!mine) continue;
        const spec = k.spec.split(`[${a}]`).join(`[${b}]`).replace(new RegExp(`@${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\]|$)`), '@' + b);
        out += f.slice(last, k.s) + k.table + spec; last = k.e;
      }
      return out + f.slice(last);
    };
    for (const s of this.sheets) {
      for (const [k, cell] of [...s.cells]) {
        if (cell.f == null) continue;
        const f = fix(cell.f, s);
        if (f !== cell.f) this.putCell(s, keyR(k), keyC(k), { ...cell, f, c: undefined });
      }
    }
  }

  // ---- styles ----
  sid(o) {
    const clean = {};
    for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== '') clean[k] = o[k];
    const key = styleKey(clean);
    let i = this.styleIdx.get(key);
    if (i === undefined) { i = this.styles.length; this.styles.push(clean); this.styleIdx.set(key, i); }
    return i;
  }
  mergeStyle(id, patch) { return this.sid({ ...this.styles[id], ...patch }); }

  // ---- transactions ----
  tx(fn) {
    if (this.cur) return fn();
    this.cur = { cells: new Map(), fns: [] };
    let out;
    try { out = fn(); } finally {
      const t = this.cur;
      this.cur = null;
      if (t.fns.length || [...t.cells.values()].some((m) => m.size)) { this.undoStack.push(t); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack = []; }
      this.dirty();
    }
    return out;
  }
  rec(undo, redo) { if (this.cur) this.cur.fns.push({ undo, redo }); }
  putCell(sh, r, c, cell) {
    const k = r * 16384 + c, prev = sh.cells.get(k);
    if (this.cur) {
      let m = this.cur.cells.get(sh);
      if (!m) this.cur.cells.set(sh, (m = new Map()));
      if (!m.has(k)) m.set(k, prev);
    }
    if (cell == null) sh.cells.delete(k);
    else {
      sh.cells.set(k, cell);
      if (r > sh.maxR) sh.maxR = r;
      if (c > sh.maxC) sh.maxC = c;
    }
    if ((prev && prev.f != null) || (cell && cell.f != null)) sh.fkeys = null;
  }
  applyEntry(t) {
    const inv = { cells: new Map(), fns: [] };
    for (const [sh, m] of t.cells) {
      const im = new Map();
      inv.cells.set(sh, im);
      for (const [k, prev] of m) {
        im.set(k, sh.cells.get(k));
        if (prev === undefined) sh.cells.delete(k); else { sh.cells.set(k, prev); sh.maxR = Math.max(sh.maxR, keyR(k)); sh.maxC = Math.max(sh.maxC, keyC(k)); }
        sh.fkeys = null;
      }
    }
    for (const f of t.fns.slice().reverse()) { f.undo(); inv.fns.push({ undo: f.redo, redo: f.undo }); }
    return inv;
  }
  undo() {
    const t = this.undoStack.pop();
    if (!t) return false;
    this.redoStack.push(this.applyEntry(t));
    this.dirty();
    return true;
  }
  redo() {
    const t = this.redoStack.pop();
    if (!t) return false;
    this.undoStack.push(this.applyEntry(t));
    this.dirty();
    return true;
  }

  dirty() {
    for (const s of this.sheets) { s.cache.clear(); s.spillVals.clear(); s.anchors.clear(); s.cfCache.clear(); }
    this.warmed = false; this.ver++;
    if (this.onChange) this.onChange();
  }

  // Evaluate every formula in row-major order so long dependency chains stay shallow.
  warm() {
    if (this.warmed) return;
    this.warmed = true;
    let total = 0;
    for (const s of this.sheets) { const f = s.formulaKeys(); total += f.a.length + f.b.length; }
    if (total > 250000) return;
    for (const pass of ['a', 'b']) {
      for (const s of this.sheets) {
        for (const k of s.formulaKeys()[pass]) { const cell = s.cells.get(k); if (cell) s.evalCell(keyR(k), keyC(k), k, cell); }
      }
    }
  }

  // ---- sheets ----
  uniqueName(base) {
    let n = base, i = 2;
    while (this.sheet(n)) n = `${base} (${i++})`;
    return n;
  }
  checkpoint() {
    const sheets = this.sheets.slice(), snaps = sheets.map((s) => [s, s.snap()]);
    const names = new Map([...this.names].map(([k, v]) => [k, { f: v.f }]));
    return () => {
      this.sheets = sheets.slice();
      for (const [s, sn] of snaps) s.restore(sn);
      this.names = new Map([...names].map(([k, v]) => [k, { f: v.f }]));
    };
  }
  structural(fn) {
    return this.tx(() => {
      const before = this.checkpoint();
      const out = fn();
      const after = this.checkpoint();
      this.rec(before, after);
      return out;
    });
  }
  addSheet(name, at) {
    const sh = new Sheet(this, name ? this.uniqueName(name) : this.uniqueName(`Sheet${this.sheets.length + 1}`));
    const ins = () => { at === undefined ? this.sheets.push(sh) : this.sheets.splice(at, 0, sh); };
    if (this.cur || this.undoStack.length || this.sheets.length) this.structural(ins); else ins();
    return sh;
  }
  removeSheet(sh) {
    if (this.sheets.length < 2) return false;
    this.structural(() => {
      this.sheets.splice(this.sheets.indexOf(sh), 1);
      this.rewriteAll((x) => (x.sh != null && x.sh.toLowerCase() === sh.name.toLowerCase() ? null : x));
    });
    return true;
  }
  renameSheet(sh, name) {
    name = name.trim();
    if (!name || /[\\/?*[\]:]/.test(name) || name.length > 31) return 'Invalid sheet name';
    if (this.sheet(name) && this.sheet(name) !== sh) return 'A sheet with that name already exists';
    const old = sh.name;
    this.structural(() => {
      this.rewriteAll((x) => (x.sh != null && x.sh.toLowerCase() === old.toLowerCase() ? { ...x, sh: name } : x));
      sh.name = name;
    });
    return null;
  }
  duplicateSheet(sh) {
    return this.structural(() => {
      const n = this.addSheet(this.uniqueName(sh.name + ' copy'), this.sheets.indexOf(sh) + 1);
      const s = sh.snap();
      s.name = n.name;
      n.restore(s);
      return n;
    });
  }
  moveSheet(sh, to) {
    this.structural(() => { this.sheets.splice(this.sheets.indexOf(sh), 1); this.sheets.splice(to, 0, sh); });
  }

  // Rewrite references in every formula, name and chart. fn(ref, ownSheetName) -> ref | null
  rewriteAll(fn) {
    for (const s of this.sheets) {
      for (const [k, cell] of [...s.cells]) {
        if (cell.f == null) continue;
        const f = rewriteRefs(cell.f, (x) => fn(x, s.name));
        if (f !== cell.f) s.cells.set(k, { ...cell, f, c: undefined });
      }
      for (const ch of s.charts) ch.range = rewriteRefs(ch.range, (x) => fn(x, s.name));
      s.fkeys = null;
    }
    for (const d of this.names.values()) { d.f = rewriteRefs(d.f, (x) => fn(x, null)); d.c = undefined; }
  }

  refFromString(text, sh) {
    const p = parseRefText(text.trim().replace(/^=/, ''));
    if (!p) { const d = this.names.get(text.trim().toUpperCase()); return d ? lookupName({ wb: this, sheet: sh, env: null }, text.trim().toUpperCase()) : null; }
    const s = p.sh == null ? sh : this.sheet(p.sh);
    return s ? { ref: true, sh: s, r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2 } : null;
  }

  // ---- structure ----
  insert(sh, axis, at, n) { this.restructure(sh, axis, at, n, false); }
  remove(sh, axis, at, n) { this.restructure(sh, axis, at, n, true); }
  restructure(sh, axis, at, n, del) {
    const end = at + n - 1;
    const adj = (lo, hi) => {
      if (!del) return [lo >= at ? lo + n : lo, hi >= at ? hi + n : hi];
      if (lo >= at && hi <= end) return null;
      const nl = lo > end ? lo - n : lo >= at ? at : lo, nh = hi > end ? hi - n : hi >= at ? at - 1 : hi;
      return nh < nl ? null : [nl, nh];
    };
    const mv = (i) => (del ? (i >= at && i <= end ? -1 : i > end ? i - n : i) : (i >= at ? i + n : i));
    const row = axis === 'r';
    this.structural(() => {
      this.rewriteAll((x, own) => {
        const target = x.sh == null ? own : x.sh;
        if (target == null || target.toLowerCase() !== sh.name.toLowerCase()) return x;
        if (row) { if (x.k === 'col') return x; const a = adj(x.r1, x.r2); return a ? { ...x, r1: a[0], r2: a[1] } : null; }
        if (x.k === 'row') return x;
        const a = adj(x.c1, x.c2);
        return a ? { ...x, c1: a[0], c2: a[1] } : null;
      });
      const cells = new Map();
      for (const [k, cell] of sh.cells) {
        let r = keyR(k), c = keyC(k);
        const ni = mv(row ? r : c);
        if (ni < 0) continue;
        if (row) r = ni; else c = ni;
        if (r < MAXR && c < MAXC) cells.set(K(r, c), cell);
      }
      sh.cells = cells; sh.fkeys = null;
      sh.maxR = -1; sh.maxC = -1;
      for (const k of cells.keys()) { sh.maxR = Math.max(sh.maxR, keyR(k)); sh.maxC = Math.max(sh.maxC, keyC(k)); }
      const remap = (m) => { const o = new Map(); for (const [i, v] of m) { const j = mv(i); if (j >= 0) o.set(j, v); } return o; };
      const remapSet = (s) => { const o = new Set(); for (const i of s) { const j = mv(i); if (j >= 0) o.add(j); } return o; };
      if (row) { sh.rowH = remap(sh.rowH); sh.rowStyle = remap(sh.rowStyle); sh.hiddenRows = remapSet(sh.hiddenRows); }
      else { sh.colW = remap(sh.colW); sh.colStyle = remap(sh.colStyle); sh.hiddenCols = remapSet(sh.hiddenCols); }
      const fixRect = (o) => {
        const a = row ? adj(o.r1, o.r2) : adj(o.c1, o.c2);
        if (!a) return null;
        return row ? { ...o, r1: a[0], r2: a[1] } : { ...o, c1: a[0], c2: a[1] };
      };
      sh.merges = sh.merges.map(fixRect).filter(Boolean);
      sh.tables = sh.tables.map(fixRect).filter(Boolean);
      sh.notes = sh.notes.map((n) => { const a = row ? adj(n.r, n.r) : adj(n.c, n.c); return a ? (row ? { ...n, r: a[0] } : { ...n, c: a[0] }) : null; }).filter(Boolean);      for (const rule of [...sh.cf, ...sh.dv]) rule.ranges = rule.ranges.map(fixRect).filter(Boolean);
      sh.cf = sh.cf.filter((x) => x.ranges.length); sh.dv = sh.dv.filter((x) => x.ranges.length);
      if (sh.filter) sh.filter = fixRect(sh.filter) ? { ...sh.filter, ...fixRect(sh.filter) } : null;
    });
  }

  // ---- block copy / paste ----
  copyBlock(sh, r1, c1, r2, c2) {
    const cells = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) {
        const x = sh.cell(r, c);
        row.push(x ? { v: x.v, f: x.f, s: x.s } : (sh.rowStyle.has(r) || sh.colStyle.has(c) ? { v: null, f: null, s: sh.styleAt(r, c) } : null));
      }
      cells.push(row);
    }
    return { h: r2 - r1 + 1, w: c2 - c1 + 1, r: r1, c: c1, cells, sheet: sh.name };
  }
  pasteBlock(sh, r, c, blk, opt = {}) {
    const { values, formats } = opt;
    for (let i = 0; i < blk.h; i++) for (let j = 0; j < blk.w; j++) {
      const rr = r + i, cc = c + j;
      if (rr >= MAXR || cc >= MAXC) continue;
      const src = blk.cells[i][j], prev = sh.cell(rr, cc);
      if (formats) { sh.setStyle(rr, cc, src ? src.s : 0); continue; }
      let cell = src ? { v: src.v, f: src.f, s: src.s } : null;
      if (cell && cell.f != null) {
        if (values) { cell = { v: this.sheet(blk.sheet)?.get(blk.r + i, blk.c + j) ?? null, f: null, s: cell.s }; if (isErr(cell.v)) cell.v = cell.v.c; }
        else cell.f = shiftFormula(cell.f, rr - (blk.r + i), cc - (blk.c + j));
      }
      if (values && prev) cell = cell ? { ...cell, s: prev.s } : (prev.s ? { v: null, f: null, s: prev.s } : null);
      sh.put(rr, cc, cell && (cell.v !== null || cell.f != null || cell.s) ? cell : null);
    }
  }

  // ---- autofill ----
  fill(sh, src, dest) {
    // src and dest are rects; dest extends src in one direction
    const vertical = dest.c1 === src.c1 && dest.c2 === src.c2;
    const fwd = vertical ? dest.r1 > src.r1 : dest.c1 > src.c1;
    const lanes = vertical ? src.c2 - src.c1 + 1 : src.r2 - src.r1 + 1;
    const n = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
    const cnt = vertical ? dest.r2 - dest.r1 + 1 : dest.c2 - dest.c1 + 1;
    for (let l = 0; l < lanes; l++) {
      const at = (i) => (vertical ? [src.r1 + i, src.c1 + l] : [src.r1 + l, src.c1 + i]);
      const cells = Array.from({ length: n }, (_, i) => sh.cell(...at(i)));
      const dateLike = n === 1 && !!cells[0] && isDateFormat(this.styles[cells[0].s].nf);
      const gen = seriesGen(cells.map((x) => (x ? (x.f != null ? { f: x.f } : { v: x.v }) : { v: null })), dateLike);
      for (let t = 0; t < cnt; t++) {
        const idx = fwd ? n + t : -1 - t;
        const pos = vertical ? [fwd ? dest.r1 + t : dest.r2 - t, src.c1 + l] : [src.r1 + l, fwd ? dest.c1 + t : dest.c2 - t];
        const tmpl = cells[((idx % n) + n) % n];
        const [pr, pc] = pos;
        const base = at(((idx % n) + n) % n);
        if (tmpl && tmpl.f != null) sh.put(pr, pc, { v: null, f: shiftFormula(tmpl.f, pr - base[0], pc - base[1]), s: tmpl.s });
        else {
          const v = gen(idx);
          sh.put(pr, pc, tmpl || v !== null ? { v, f: null, s: tmpl ? tmpl.s : 0 } : null);
        }
      }
    }
  }

  // ---- sorting ----
  sortRange(sh, rect, col, asc, header) {
    const { r1, c1, r2, c2 } = rect, top = header ? r1 + 1 : r1;
    const rows = [];
    for (let r = top; r <= r2; r++) rows.push({ r, cells: Array.from({ length: c2 - c1 + 1 }, (_, j) => sh.cell(r, c1 + j)), key: sh.get(r, col) });
    rows.sort((a, b) => {
      const ea = a.key == null || a.key === '', eb = b.key == null || b.key === '';
      if (ea || eb) return ea && eb ? a.r - b.r : ea ? 1 : -1;
      return (asc ? 1 : -1) * cmp(a.key, b.key) || a.r - b.r;
    });
    rows.forEach((row, i) => {
      const r = top + i;
      row.cells.forEach((x, j) => {
        const cell = x && x.f != null ? { ...x, f: shiftFormula(x.f, r - row.r, 0), c: undefined } : x;
        sh.put(r, c1 + j, cell || null);
      });
    });
  }

  // ---- (de)serialisation ----
  toJSON() {
    return {
      v: 1, styles: this.styles,
      names: [...this.names].map(([k, d]) => [k, d.f]),
      sheets: this.sheets.map((s) => ({
        name: s.name,
        cells: [...s.cells].map(([k, c]) => [keyR(k), keyC(k), isErr(c.v) ? { e: c.v.c } : c.v, c.f, c.s || 0]),
        colW: [...s.colW], rowH: [...s.rowH], hiddenRows: [...s.hiddenRows], hiddenCols: [...s.hiddenCols],
        colStyle: [...s.colStyle], rowStyle: [...s.rowStyle], merges: s.merges, freeze: s.freeze, cf: s.cf, dv: s.dv, charts: s.charts,
        filter: s.filter, showGrid: s.showGrid, tables: s.tables, notes: s.notes, images: s.images,
      })),
      scripts: this.scripts || [], queries: this.queries || [],
    };
  }
  static fromJSON(j) {
    const wb = new Workbook();
    wb.sheets = []; wb.styles = j.styles || [{}]; wb.styleIdx = new Map(wb.styles.map((o, i) => [styleKey(o), i]));
    wb.names = new Map((j.names || []).map(([k, f]) => [k, { f }]));
    for (const d of j.sheets) {
      const s = new Sheet(wb, d.name);
      for (const [r, c, v, f, st] of d.cells) {
        const cell = { v: v && typeof v === 'object' ? errOf(v.e) : v, f, s: st || 0 };
        s.cells.set(K(r, c), cell);
        s.maxR = Math.max(s.maxR, r); s.maxC = Math.max(s.maxC, c);
      }
      s.colW = new Map(d.colW); s.rowH = new Map(d.rowH); s.hiddenRows = new Set(d.hiddenRows); s.hiddenCols = new Set(d.hiddenCols);
      s.colStyle = new Map(d.colStyle); s.rowStyle = new Map(d.rowStyle);
      s.merges = d.merges || []; s.freeze = d.freeze || { r: 0, c: 0 }; s.cf = d.cf || []; s.dv = d.dv || []; s.charts = d.charts || [];
      s.filter = d.filter || null; s.showGrid = d.showGrid !== false;
      s.tables = d.tables || []; s.notes = d.notes || []; s.images = d.images || [];
      wb.sheets.push(s);
    }
    wb.scripts = j.scripts || []; wb.queries = j.queries || [];
    if (!wb.sheets.length) wb.addSheet('Sheet1');
    wb.undoStack = []; wb.redoStack = [];
    wb.applyFilters();
    return wb;
  }

  // ---- filters ----
  applyFilters() {
    for (const s of this.sheets) {
      s.filtered.clear();
      const f = s.filter;
      if (!f || !f.crit) continue;
      for (let r = f.r1 + 1; r <= f.r2; r++) {
        for (const [col, hide] of Object.entries(f.crit)) {
          const t = s.display(r, +col).text;
          if (hide.includes(t)) { s.filtered.add(r); break; }
        }
      }
    }
  }
}

// ---------- series generation for autofill ----------
const LISTS = [
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ['Q1', 'Q2', 'Q3', 'Q4'],
];
function seriesGen(src, dateLike) {
  const vals = src.map((x) => x.v);
  const nums = vals.every((v) => typeof v === 'number');
  if (nums && vals.length > 1) {
    const step = (vals[vals.length - 1] - vals[0]) / (vals.length - 1);
    return (idx) => (idx >= 0 ? vals[vals.length - 1] + step * (idx - vals.length + 1) : vals[0] + step * idx);
  }
  // A lone number copies (as in Excel); a lone date steps by one day.
  if (nums && vals.length === 1) return dateLike ? (idx) => vals[0] + idx : () => vals[0];
  if (vals.length === 1 && typeof vals[0] === 'string') {
    const s = vals[0];
    const list = LISTS.find((l) => l.some((x) => x.toLowerCase() === s.toLowerCase()));
    if (list) {
      const i = list.findIndex((x) => x.toLowerCase() === s.toLowerCase());
      return (idx) => { const t = list[(((i + idx) % list.length) + list.length) % list.length]; return s === s.toUpperCase() ? t.toUpperCase() : t; };
    }
    const m = /^(.*?)(\d+)$/.exec(s);
    if (m) return (idx) => m[1] + String(+m[2] + idx).padStart(m[2].length, '0');
  }
  return (idx) => vals[((idx % vals.length) + vals.length) % vals.length];
}

// ---------- conditional formatting ----------
function cfStats(sh, rule) {
  let st = sh.cfCache.get(rule);
  if (st) return st;
  const nums = [], all = [];
  for (const g of rule.ranges) {
    eachRef({ sh, r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 }, (v) => { all.push(v); if (typeof v === 'number') nums.push(v); });
  }
  const counts = new Map();
  for (const v of all) { const k = typeof v === 'string' ? v.toLowerCase() : v; counts.set(k, (counts.get(k) || 0) + 1); }
  nums.sort((a, b) => a - b);
  st = { min: nums[0], max: nums[nums.length - 1], nums, counts };
  sh.cfCache.set(rule, st);
  return st;
}
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (c1, c2, t) => '#' + hex(c1).map((x, i) => lerp(x, hex(c2)[i], t).toString(16).padStart(2, '0')).join('');

// Returns merged style overrides {bg, fc, b, i, bar} for a cell, or null.
export function cfAt(sh, r, c, v) {
  if (!sh.cf.length) return null;
  let out = null;
  for (const rule of sh.cf) {
    if (!rule.ranges.some((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2)) continue;
    let hit = false;
    const x = typeof v === 'string' ? v.toLowerCase() : v;
    switch (rule.type) {
      case 'cell': {
        if (typeof v !== 'number' && typeof v !== 'string') break;
        const a = num0(rule.v1), b = num0(rule.v2);
        const cmpv = (t) => (typeof v === 'number' && typeof t === 'number' ? v - t : typeof v === 'string' && typeof t === 'string' ? cmp(v, t) : NaN);
        switch (rule.op) {
          case '>': hit = cmpv(a) > 0; break; case '<': hit = cmpv(a) < 0; break; case '>=': hit = cmpv(a) >= 0; break; case '<=': hit = cmpv(a) <= 0; break;
          case '=': hit = cmpv(a) === 0; break; case '<>': hit = cmpv(a) !== 0; break;
          case 'between': hit = cmpv(a) >= 0 && cmpv(b) <= 0; break; case 'notbetween': hit = !(cmpv(a) >= 0 && cmpv(b) <= 0); break;
        }
        break;
      }
      case 'text': {
        if (typeof v !== 'string' && typeof v !== 'number') break;
        const s = String(v).toLowerCase(), t = String(rule.v1).toLowerCase();
        hit = rule.op === 'contains' ? s.includes(t) : rule.op === 'notcontains' ? !s.includes(t) : rule.op === 'begins' ? s.startsWith(t) : s.endsWith(t);
        break;
      }
      case 'dup': hit = v != null && cfStats(sh, rule).counts.get(x) > 1; break;
      case 'unique': hit = v != null && cfStats(sh, rule).counts.get(x) === 1; break;
      case 'blank': hit = v == null || v === ''; break;
      case 'noblank': hit = !(v == null || v === ''); break;
      case 'top': {
        if (typeof v !== 'number') break;
        const { nums } = cfStats(sh, rule);
        const n = Math.max(1, rule.pct ? Math.ceil(nums.length * rule.n / 100) : rule.n);
        hit = rule.bottom ? v <= nums[Math.min(n, nums.length) - 1] : v >= nums[Math.max(0, nums.length - n)];
        break;
      }
      case 'formula': {
        const g = rule.ranges[0];
        const key = rule;
        let m = sh.cfCache.get(key);
        if (!m) sh.cfCache.set(key, (m = new Map()));
        const k = r * 16384 + c;
        if (!m.has(k)) {
          let res = false;
          try {
            const x = scalar(compile(parse(shiftFormula(rule.f.replace(/^=/, ''), r - g.r1, c - g.c1)))({ wb: sh.wb, sheet: sh, row: r, col: c, env: null }));
            res = x === true || (typeof x === 'number' && x !== 0);
          } catch { res = false; }
          m.set(k, res);
        }
        hit = m.get(k);
        break;
      }
      case 'scale': {
        if (typeof v !== 'number') break;
        const { min, max } = cfStats(sh, rule);
        const t = max === min ? 0.5 : (v - min) / (max - min), cs = rule.colors;
        const bg = cs.length === 3 ? (t < 0.5 ? mix(cs[0], cs[1], t * 2) : mix(cs[1], cs[2], (t - 0.5) * 2)) : mix(cs[0], cs[1], t);
        out = { ...out, bg };
        continue;
      }
      case 'bar': {
        if (typeof v !== 'number') break;
        const { min, max } = cfStats(sh, rule);
        out = { ...out, bar: { pct: max === min ? 1 : Math.max(0.03, (v - Math.min(0, min)) / (max - Math.min(0, min))), color: rule.color || '#5b9bd5' } };
        continue;
      }
    }
    if (hit) { out = { ...out, ...rule.style }; if (rule.stop) break; }
  }
  return out;
}
const num0 = (x) => (typeof x === 'string' && x.trim() !== '' && !isNaN(+x) ? +x : x);

// ---------- data validation ----------
export function dvList(sh, rule) {
  const src = String(rule.list ?? '');
  if (src.startsWith('=')) {
    const ref = sh.wb.refFromString(src, sh);
    return ref && isRef(ref) ? grid(ref).flat().filter((v) => v != null).map(String) : [];
  }
  return src.split(',').map((s) => s.trim()).filter(Boolean);
}
export function dvAt(sh, r, c) {
  return sh.dv.find((d) => d.ranges.some((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2)) || null;
}
// Returns an error message, or null when the value is acceptable.
export function dvCheck(sh, r, c, v) {
  const d = dvAt(sh, r, c);
  if (!d) return null;
  if (v == null || v === '') return d.allowBlank === false ? 'A value is required.' : null;
  const bad = d.msg || 'This value does not match the data validation rules for this cell.';
  switch (d.type) {
    case 'list': return dvList(sh, d).some((x) => x.toLowerCase() === String(v).toLowerCase()) ? null : bad;
    case 'whole': case 'decimal': case 'date': {
      if (typeof v !== 'number' || (d.type === 'whole' && !Number.isInteger(v))) return bad;
      const a = +d.v1, b = +d.v2;
      const ok = { between: v >= a && v <= b, notbetween: v < a || v > b, '=': v === a, '<>': v !== a, '>': v > a, '<': v < a, '>=': v >= a, '<=': v <= a }[d.op];
      return ok ? null : bad;
    }
    case 'len': {
      const n = String(v).length, a = +d.v1, b = +d.v2;
      const ok = { between: n >= a && n <= b, '=': n === a, '<=': n <= a, '>=': n >= a, '<': n < a, '>': n > a }[d.op];
      return ok ? null : bad;
    }
  }
  return null;
}

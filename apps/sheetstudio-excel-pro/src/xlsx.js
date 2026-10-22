// XLSX reader / writer. Values, formulas, styles, merges, freeze panes, validation, conditional formatting.
import { zip, unzip, text, utf8 } from './zip.js';
import { Workbook, Sheet, K, keyR, keyC } from './engine.js';
import { BUILTIN } from './numfmt.js';
import { tokenize, shiftFormula, parseRefText, colName, colNum, cellName, MAXR, MAXC } from './parser.js';
import { isErr, errOf, E } from './core.js';
import { XLFN, XLWS, NOEXPORT } from './functions.js';
import { parseXML, esc, kids, kid } from './xml.js';
import { readSheetParts, writeSheetParts } from './xlsx-parts.js';
import { tableAt } from './tables.js';
export { parseXML };

// ---------- colours ----------
const INDEXED = '000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 800000 008000 000080 808000 800080 008080 c0c0c0 808080 9999ff 993366 ffffcc ccffff 660066 ff8080 0066cc ccccff 000080 ff00ff ffff00 00ffff 800080 800000 008080 0000ff 00ccff ccffff ccffcc ffff99 99ccff ff99cc cc99ff ffcc99 3366ff 33cccc 99cc00 ffcc00 ff9900 ff6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333'.split(' ').map((x) => '#' + x);
const DEFTHEME = ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];

function tint(hex, t) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const f = (p, q, x) => { if (x < 0) x += 1; if (x > 1) x -= 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 0.5 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  if (s === 0) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// ---------- reading ----------
const px = (chars) => Math.max(8, Math.round(chars * 7 + 5));
const FPFX = /_xl(?:fn|ws|pm|udf)\./g;
const cleanF = (f) => f.replace(FPFX, '').replace(/ANCHORARRAY\(([^()]+)\)/g, '$1#').replace(/\[\[#This Row\],\s*\[([^\]]*)\]\]/gi, '[@[$1]]');
const ptr = (s) => (s && s.startsWith('/') ? s.slice(1) : 'xl/' + s);

export async function readXlsx(bytes, { keepCached = false } = {}) {
  const z = unzip(bytes);
  const get = async (n) => (z[n] ? parseXML(text(await z[n]())) : null);
  const warnings = [];
  const wbx = kid(await get('xl/workbook.xml'), 'workbook');
  if (!wbx) throw new Error('Not a valid .xlsx file');
  const rels = {};
  for (const r of kids(kid(await get('xl/_rels/workbook.xml.rels'), 'Relationships'), 'Relationship')) rels[r.a.Id] = r.a.Target;
  // theme
  const theme = DEFTHEME.slice();
  const th = await get('xl/theme/theme1.xml');
  const cs = th && (function find(n) { if (n.n === 'clrScheme') return n; for (const c of n.c) { const x = find(c); if (x) return x; } })(th);
  if (cs) {
    const order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
    const pal = order.map((k) => { const e = kid(cs, k)?.c[0]; return e ? '#' + (e.a.val || e.a.lastClr || '000000').toLowerCase() : null; });
    // theme index 0 = lt1, 1 = dk1, 2 = lt2, 3 = dk2
    [pal[1], pal[0], pal[3], pal[2], ...pal.slice(4)].forEach((c, i) => { if (c) theme[i] = c; });
  }
  const colour = (n) => {
    if (!n) return null;
    const a = n.a;
    if (a.rgb) return '#' + a.rgb.slice(-6).toLowerCase();
    if (a.theme !== undefined) { const c = theme[+a.theme]; return c ? (a.tint ? tint(c, +a.tint) : c) : null; }
    if (a.indexed !== undefined) return INDEXED[+a.indexed] || null;
    return null;
  };
  // shared strings
  const sst = [];
  const ss = kid(await get('xl/sharedStrings.xml'), 'sst');
  if (ss) for (const si of kids(ss, 'si')) sst.push((function t(n) { return n.n === 't' ? n.t : n.n === 'rPh' ? '' : n.c.map(t).join(''); })(si));
  // styles
  const wb = new Workbook();
  wb.sheets = [];
  const sty = kid(await get('xl/styles.xml'), 'styleSheet');
  const numFmts = {};
  for (const n of kids(kid(sty, 'numFmts'), 'numFmt')) numFmts[n.a.numFmtId] = n.a.formatCode;
  const fontOf = (f) => {
    const o = {};
    if (!f) return o;
    const on = (k) => { const x = kid(f, k); return !!x && x.a.val !== '0' && x.a.val !== 'false'; };
    if (on('b')) o.b = true; if (on('i')) o.i = true; if (on('strike')) o.st = true;
    const u = kid(f, 'u'); if (u && u.a.val !== 'none') o.u = true;
    const sz = kid(f, 'sz'); if (sz && +sz.a.val !== 11) o.sz = +sz.a.val;
    const c = colour(kid(f, 'color')); if (c && c !== '#000000') o.fc = c;
    const nm = kid(f, 'name'); if (nm && !/^(calibri|aptos)/i.test(nm.a.val)) o.fn = nm.a.val;
    return o;
  };
  const fonts = kids(kid(sty, 'fonts'), 'font').map(fontOf);
  const fills = kids(kid(sty, 'fills'), 'fill').map((f) => { const p = kid(f, 'patternFill'); return p && p.a.patternType === 'solid' ? colour(kid(p, 'fgColor')) : null; });
  const borders = kids(kid(sty, 'borders'), 'border').map((b) => {
    const o = {}; let bc;
    for (const [k, s] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
      const e = kid(b, s);
      if (e && e.a.style) { o[k] = e.a.style === 'hair' ? 'thin' : e.a.style.replace(/^medium.+/, 'medium').replace(/^(dash|mediumDash).*/, 'dashed').replace(/^dot.*/, 'dotted'); bc = bc || colour(kid(e, 'color')); }
    }
    return Object.keys(o).length ? { bd: o, bc: bc && bc !== '#000000' ? bc : undefined } : {};
  });
  const xfToStyle = kids(kid(sty, 'cellXfs'), 'xf').map((x) => {
    const o = { ...fonts[+x.a.fontId || 0] };
    const bg = fills[+x.a.fillId || 0]; if (bg) o.bg = bg;
    Object.assign(o, borders[+x.a.borderId || 0]);
    const id = +x.a.numFmtId || 0;
    const code = numFmts[id] ?? BUILTIN[id];
    if (code && code !== 'General') o.nf = code;
    const al = kid(x, 'alignment');
    if (al) {
      const h = al.a.horizontal; if (h === 'left' || h === 'right' || h === 'center') o.ha = h; else if (h === 'centerContinuous') o.ha = 'center';
      if (al.a.vertical === 'top' || al.a.vertical === 'center') o.va = al.a.vertical;
      if (al.a.wrapText === '1' || al.a.wrapText === 'true') o.wr = true;
      if (al.a.indent) o.ind = +al.a.indent;
    }
    return wb.sid(o);
  });
  if (!xfToStyle.length) xfToStyle.push(0);
  const dxfs = kids(kid(sty, 'dxfs'), 'dxf').map((d) => {
    const o = {}, f = kid(d, 'font');
    if (f) { Object.assign(o, fontOf(f)); const c = colour(kid(f, 'color')); if (c) o.fc = c; }
    const fl = kid(kid(d, 'fill'), 'patternFill');
    if (fl) { const c = colour(kid(fl, 'bgColor')) || colour(kid(fl, 'fgColor')); if (c) o.bg = c; }
    delete o.sz; delete o.fn;
    return o;
  });

  if (kid(wbx, 'workbookPr')?.a.date1904 === '1') warnings.push('This file uses the 1904 date system; dates may be off by 4 years.');
  const sheetDefs = kids(kid(wbx, 'sheets'), 'sheet');
  const sheetIdx = [];
  for (const sd of sheetDefs) {
    const target = rels[sd.a.id];
    if (!target) continue;
    const path = ptr(target);
    const sx = kid(await get(path), 'worksheet');
    if (!sx) continue;
    const sh = new Sheet(wb, sd.a.name);
    wb.sheets.push(sh); sheetIdx.push(sh);
    if (sd.a.state === 'hidden' || sd.a.state === 'veryHidden') warnings.push(`Sheet "${sd.a.name}" was hidden; it is shown here.`);
    // views
    const view = kid(kid(sx, 'sheetViews'), 'sheetView');
    if (view) {
      if (view.a.showGridLines === '0') sh.showGrid = false;
      const pane = kid(view, 'pane');
      if (pane && pane.a.state && pane.a.state.startsWith('frozen')) sh.freeze = { r: +pane.a.ySplit || 0, c: +pane.a.xSplit || 0 };
    }
    for (const col of kids(kid(sx, 'cols'), 'col')) {
      const lo = +col.a.min - 1, hi = Math.min(+col.a.max - 1, lo + 2000), w = col.a.width ? px(+col.a.width) : null;
      const cs = +col.a.style ? xfToStyle[+col.a.style] : 0;
      for (let c = lo; c <= hi; c++) {
        if (w && col.a.customWidth !== '0') sh.colW.set(c, w);
        if (col.a.hidden === '1') sh.hiddenCols.add(c);
        if (cs && +col.a.max - 1 - lo < 2000) sh.colStyle.set(c, cs);
      }
    }
    const shared = new Map(), arrays = [];
    const sd2 = kid(sx, 'sheetData');
    for (const row of kids(sd2, 'row')) {
      const r0 = +row.a.r - 1;
      if (row.a.ht && row.a.customHeight !== '0') sh.rowH.set(r0, Math.round(+row.a.ht * 96 / 72));
      if (row.a.hidden === '1') sh.hiddenRows.add(r0);
      if (row.a.customFormat === '1' && +row.a.s) sh.rowStyle.set(r0, xfToStyle[+row.a.s] || 0);
      let nextC = 0;
      for (const c of row.c) {
        if (c.n !== 'c') continue;
        let r = r0, col = nextC;
        if (c.a.r) { const m = /^([A-Z]+)(\d+)$/.exec(c.a.r); if (m) { col = colNum(m[1]); r = +m[2] - 1; } }
        nextC = col + 1;
        const s = c.a.s ? xfToStyle[+c.a.s] || 0 : 0;
        const fN = kid(c, 'f'), vN = kid(c, 'v');
        let v = null, f = null;
        const t = c.a.t || 'n';
        if (t === 's') v = vN ? sst[+vN.t] ?? '' : null;
        else if (t === 'str') v = vN ? vN.t : null;
        else if (t === 'inlineStr') v = (function g(n) { return n.n === 't' ? n.t : n.c.map(g).join(''); })(kid(c, 'is') || { n: '', c: [] });
        else if (t === 'b') v = vN ? vN.t === '1' : null;
        else if (t === 'e') v = vN ? errOf(vN.t) || E.VALUE : null;
        else if (vN && vN.t !== '') { v = parseFloat(vN.t); if (v !== v) v = null; }
        if (fN) {
          if (fN.a.t === 'shared') {
            const si = fN.a.si;
            if (fN.t) shared.set(si, { f: fN.t, r, c: col });
            const m = shared.get(si);
            if (m) f = cleanF(m.f === fN.t ? fN.t : shiftFormula(m.f, r - m.r, col - m.c));
          } else if (fN.t) f = cleanF(fN.t);
          if (fN.a.t === 'array' && fN.a.ref) { const p = parseRefText(fN.a.ref); if (p && (p.r2 > p.r1 || p.c2 > p.c1)) arrays.push({ ...p, mr: r, mc: col }); }
        }
        if (v === null && f === null && !s) continue;
        sh.cells.set(K(r, col), keepCached && f != null ? { v: null, f, s, cv: v } : { v: f != null ? null : v, f, s });
        if (r > sh.maxR) sh.maxR = r;
        if (col > sh.maxC) sh.maxC = col;
      }
    }
    // cached values inside a multi-cell array formula are regenerated by the spill engine
    for (const a of arrays) for (let r = a.r1; r <= a.r2; r++) for (let c = a.c1; c <= a.c2; c++) if (r !== a.mr || c !== a.mc) { const x = sh.cells.get(K(r, c)); if (x && x.f == null) sh.cells.delete(K(r, c)); }
    for (const m of kids(kid(sx, 'mergeCells'), 'mergeCell')) { const p = parseRefText(m.a.ref); if (p) sh.merges.push({ r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2 }); }
    const af = kid(sx, 'autoFilter');
    if (af && af.a.ref) { const p = parseRefText(af.a.ref); if (p) sh.filter = { r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2, crit: null }; }
    const rangesOf = (sq) => (sq || '').split(/\s+/).map(parseRefText).filter(Boolean).map((p) => ({ r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2 }));
    const OPS = { equal: '=', notEqual: '<>', greaterThan: '>', lessThan: '<', greaterThanOrEqual: '>=', lessThanOrEqual: '<=', between: 'between', notBetween: 'notbetween' };
    for (const dv of kids(kid(sx, 'dataValidations'), 'dataValidation')) {
      const type = { list: 'list', whole: 'whole', decimal: 'decimal', date: 'date', textLength: 'len' }[dv.a.type];
      if (!type) continue;
      const f1 = kid(dv, 'formula1')?.t ?? '', f2 = kid(dv, 'formula2')?.t ?? '';
      const rule = { type, ranges: rangesOf(dv.a.sqref), allowBlank: dv.a.allowBlank === '1', msg: dv.a.error || '' };
      if (type === 'list') rule.list = f1.startsWith('"') ? f1.replace(/^"|"$/g, '') : '=' + f1;
      else { rule.op = OPS[dv.a.operator || 'between']; rule.v1 = f1; rule.v2 = f2; }
      sh.dv.push(rule);
    }
    let skipped = 0;
    for (const cf of kids(sx, 'conditionalFormatting')) {
      const ranges = rangesOf(cf.a.sqref);
      for (const ru of kids(cf, 'cfRule')) {
        const style = ru.a.dxfId !== undefined ? dxfs[+ru.a.dxfId] || {} : {};
        const fs = kids(ru, 'formula').map((x) => x.t);
        const lit = (x) => (x === undefined ? undefined : /^".*"$/.test(x) ? x.slice(1, -1) : x !== '' && !isNaN(+x) ? +x : null);
        let rule = null;
        switch (ru.a.type) {
          case 'cellIs': if (lit(fs[0]) !== null && OPS[ru.a.operator]) rule = { type: 'cell', op: OPS[ru.a.operator], v1: lit(fs[0]), v2: lit(fs[1]), style }; break;
          case 'containsText': rule = { type: 'text', op: 'contains', v1: ru.a.text, style }; break;
          case 'notContainsText': rule = { type: 'text', op: 'notcontains', v1: ru.a.text, style }; break;
          case 'beginsWith': rule = { type: 'text', op: 'begins', v1: ru.a.text, style }; break;
          case 'endsWith': rule = { type: 'text', op: 'ends', v1: ru.a.text, style }; break;
          case 'duplicateValues': rule = { type: 'dup', style }; break;
          case 'uniqueValues': rule = { type: 'unique', style }; break;
          case 'containsBlanks': rule = { type: 'blank', style }; break;
          case 'notContainsBlanks': rule = { type: 'noblank', style }; break;
          case 'top10': rule = { type: 'top', n: +ru.a.rank || 10, bottom: ru.a.bottom === '1', pct: ru.a.percent === '1', style }; break;
          case 'expression': if (fs[0]) rule = { type: 'formula', f: cleanF(fs[0]), style }; break;
          case 'colorScale': { const cols = kids(kid(ru, 'colorScale'), 'color').map(colour); if (cols.length >= 2 && cols.every(Boolean)) rule = { type: 'scale', colors: cols }; break; }
          case 'dataBar': { const c = colour(kid(kid(ru, 'dataBar'), 'color')); rule = { type: 'bar', color: c || '#638ec6' }; break; }
        }
        if (rule) sh.cf.push({ ...rule, ranges }); else skipped++;
      }
    }
    if (skipped) warnings.push(`${skipped} conditional-format rule(s) on "${sh.name}" use features not supported and were dropped.`);
    // charts, pictures, comments, tables
    const relFile = path.replace(/([^/]+)$/, '_rels/$1.rels');
    const sheetRels = kids(kid(await get(relFile), 'Relationships'), 'Relationship').map((r) => ({ type: r.a.Type, target: r.a.Target }));
    await readSheetParts(sh, path, sheetRels, { xml: get, bin: async (p) => (z[p] ? z[p]() : null) }, warnings);
  }
  if (!wb.sheets.length) throw new Error('The workbook has no readable sheets');
  for (const d of kids(kid(wbx, 'definedNames'), 'definedName')) {
    if (d.a.localSheetId !== undefined || /^_xlnm\./.test(d.a.name) || d.a.hidden === '1') continue;
    wb.names.set(d.a.name.toUpperCase(), { f: cleanF(d.t) });
  }
  const has = (p) => Object.keys(z).some((k) => k.startsWith(p));
  if (has('xl/pivotTables/')) warnings.push('Pivot tables were imported as their current values (use the PIVOTBY function for live pivots).');
  if (has('xl/threadedComments')) warnings.push('Threaded comments were imported as plain notes.');
  if (z['xl/vbaProject.bin']) { wb.vba = await z['xl/vbaProject.bin'](); warnings.push('VBA macros are kept and saved back to .xlsm but cannot run here.'); }
  wb.undoStack = []; wb.redoStack = [];
  wb.applyFilters();
  wb.warnings = warnings;
  return wb;
}

// ---------- writing ----------
const argb = (c) => 'FF' + c.slice(1).toUpperCase();
const BSTYLE = { thin: 'thin', medium: 'medium', thick: 'thick', dashed: 'dashed', dotted: 'dotted', double: 'double' };
const REVBUILTIN = new Map(Object.entries(BUILTIN).map(([k, v]) => [v, +k]));
const OPN = { '=': 'equal', '<>': 'notEqual', '>': 'greaterThan', '<': 'lessThan', '>=': 'greaterThanOrEqual', '<=': 'lessThanOrEqual', between: 'between', notbetween: 'notBetween' };

// Names declared by LET(...) / LAMBDA(...) need Excel's _xlpm. prefix everywhere they are used.
function paramNames(toks) {
  const names = new Set();
  toks.forEach((t, i) => {
    const u = t.k === 'id' ? t.v.toUpperCase() : '';
    if ((u !== 'LET' && u !== 'LAMBDA') || !toks[i + 1] || toks[i + 1].v !== '(') return;
    let depth = 0, arg = 0, startOfArg = true;
    const argToks = [];
    for (let j = i + 1; j < toks.length; j++) {
      const k = toks[j];
      if (k.k === 'op' && k.v === '(') { depth++; if (depth === 1) { startOfArg = true; continue; } }
      else if (k.k === 'op' && k.v === ')') { depth--; if (depth === 0) break; }
      else if (k.k === 'op' && k.v === ',' && depth === 1) { arg++; startOfArg = true; continue; }
      if (depth === 1 && startOfArg && k.k === 'id') argToks.push([arg, k.v.toUpperCase()]);
      startOfArg = false;
    }
    const last = arg;
    for (const [n, name] of argToks) if (u === 'LAMBDA' ? n < last : n < last && n % 2 === 0) names.add(name);
  });
  return names;
}

function exportFormula(f, tableAtCell) {
  let toks;
  try { toks = tokenize(f); } catch { return f; }
  const pm = paramNames(toks);
  let out = '', last = 0;
  toks.forEach((t, i) => {
    const nx = toks[i + 1];
    if (t.k === 'tref') {
      // implicit table / [@Col] must be written in full form
      let name = t.table, spec = t.spec;
      if (!name && tableAtCell) name = tableAtCell.name;
      const m = /^\[@\[?(.*?)\]?\]$/.exec(spec);
      if (m && !/^\[\[/.test(spec) ) spec = `[[#This Row],[${m[1]}]]`;
      out += f.slice(last, t.s) + name + spec; last = t.e;
    } else if (t.k === 'id' && pm.has(t.v.toUpperCase())) {
      out += f.slice(last, t.s) + '_xlpm.' + t.v; last = t.e;
    } else if (t.k === 'id' && nx && nx.k === 'op' && nx.v === '(' && nx.s === t.e) {
      const u = t.v.toUpperCase();
      const p = XLWS.has(u) ? '_xlfn._xlws.' : XLFN.has(u) ? '_xlfn.' : '';
      if (p) { out += f.slice(last, t.s) + p + t.v; last = t.e; }
    } else if (t.k === 'op' && t.v === '#' && toks[i - 1] && toks[i - 1].k === 'ref') {
      const ref = toks[i - 1];
      out += f.slice(last, ref.s) + '_xlfn.ANCHORARRAY(' + f.slice(ref.s, ref.e) + ')';
      last = t.e;
    }
  });
  return out + f.slice(last);
}

export async function writeXlsx(wb) {
  wb.warm();
  const warnings = [];
  const strings = new Map();
  const sidx = (s) => { let i = strings.get(s); if (i === undefined) { i = strings.size; strings.set(s, i); } return i; };
  // style tables
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts = new Map();
  const memo = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { i = arr.length; arr.push(x); } return i; };
  const xfs = wb.styles.map((s) => {
    const fx = (s.b ? '<b/>' : '') + (s.i ? '<i/>' : '') + (s.st ? '<strike/>' : '') + (s.u ? '<u/>' : '') + `<sz val="${s.sz || 11}"/>` + (s.fc ? `<color rgb="${argb(s.fc)}"/>` : '') + `<name val="${esc(s.fn || 'Calibri')}"/><family val="2"/>`;
    const fo = memo(fonts, `<font>${fx}</font>`);
    const fi = s.bg ? memo(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.bg)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    let bo = 0;
    if (s.bd) {
      const side = (k, n) => (s.bd[k] ? `<${n} style="${BSTYLE[s.bd[k]] || 'thin'}"><color ${s.bc ? `rgb="${argb(s.bc)}"` : 'auto="1"'}/></${n}>` : `<${n}/>`);
      bo = memo(borders, `<border>${side('l', 'left')}${side('r', 'right')}${side('t', 'top')}${side('b', 'bottom')}<diagonal/></border>`);
    }
    let nf = 0;
    if (s.nf && s.nf !== 'General') {
      if (REVBUILTIN.has(s.nf)) nf = REVBUILTIN.get(s.nf);
      else { if (!numFmts.has(s.nf)) numFmts.set(s.nf, 164 + numFmts.size); nf = numFmts.get(s.nf); }
    }
    const al = (s.ha ? ` horizontal="${s.ha}"` : '') + (s.va ? ` vertical="${s.va}"` : '') + (s.wr ? ' wrapText="1"' : '') + (s.ind ? ` indent="${s.ind}"` : '');
    return `<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${al ? ' applyAlignment="1"' : ''}${al ? `><alignment${al}/></xf>` : '/>'}`;
  });
  const dxfs = [];
  const dxfOf = (st = {}) => {
    const f = (st.b ? '<b/>' : '') + (st.i ? '<i/>' : '') + (st.fc ? `<color rgb="${argb(st.fc)}"/>` : '');
    const x = `<dxf>${f ? `<font>${f}</font>` : ''}${st.bg ? `<fill><patternFill><bgColor rgb="${argb(st.bg)}"/></patternFill></fill>` : ''}</dxf>`;
    return memo(dxfs, x);
  };

  const sheetsXml = [], files = {}, sheetRelsXml = [];
  const st = { wb, files, ct: [], exts: new Set(), n: { drawing: 0, chart: 0, image: 0, table: 0, comments: 0 }, warnings, tableFilter: new Set(), exportF: exportFormula };
  for (const sh of wb.sheets) {
    const parts = writeSheetParts(sh, st);
    sheetRelsXml.push(parts.rels.length ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join('')}</Relationships>` : '');
    const rows = new Map();
    const put = (r, c, x) => { let m = rows.get(r); if (!m) rows.set(r, (m = new Map())); m.set(c, x); };
    for (const [k, cell] of sh.cells) put(keyR(k), keyC(k), cell);
    for (const [k, v] of sh.spillVals) if (!sh.cells.has(k)) put(keyR(k), keyC(k), { v, f: null, s: 0, spilled: true });
    for (const r of sh.rowH.keys()) if (!rows.has(r)) rows.set(r, new Map());
    for (const r of sh.hiddenRows) if (!rows.has(r)) rows.set(r, new Map());
    const out = [];
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      const m = rows.get(r);
      let attrs = ` r="${r + 1}"`;
      if (sh.rowH.has(r)) attrs += ` ht="${(sh.rowH.get(r) * 72 / 96).toFixed(2)}" customHeight="1"`;
      if (sh.rowHidden(r)) attrs += ' hidden="1"';
      if (sh.rowStyle.has(r)) attrs += ` s="${sh.rowStyle.get(r)}" customFormat="1"`;
      const cs = [];
      for (const c of [...m.keys()].sort((a, b) => a - b)) {
        const cell = m.get(c), ref = cellName(r, c), sa = cell.s ? ` s="${cell.s}"` : '';
        let v = cell.f != null ? sh.get(r, c) : cell.v;
        if (cell.spilled) v = cell.v;
        if (v && typeof v === 'object' && !isErr(v)) v = '';
        let t = '', vx = '';
        if (typeof v === 'number') vx = isFinite(v) ? `<v>${v}</v>` : ((t = ' t="e"'), '<v>#NUM!</v>');
        else if (typeof v === 'boolean') { t = ' t="b"'; vx = `<v>${+v}</v>`; }
        else if (isErr(v)) { t = ' t="e"'; vx = `<v>${v.c}</v>`; }
        else if (typeof v === 'string') { if (cell.f != null) { t = ' t="str"'; vx = `<v>${esc(v)}</v>`; } else { t = ' t="s"'; vx = `<v>${sidx(v)}</v>`; } }
        let fx = '';
        if (cell.f != null) {
          if (NOEXPORT.test(cell.f)) warnings.push(`${sh.name}!${ref}: SPARKLINE has no Excel equivalent; saved as a value.`);
          else {
            const an = sh.anchors.get(K(r, c));
            const arr = an ? ` t="array" ref="${cellName(r, c)}:${cellName(r + an.rows - 1, c + an.cols - 1)}"` : '';
            fx = `<f${arr}>${esc(exportFormula(cell.f, tableAt(sh, r, c)))}</f>`;
          }
        }
        if (!vx && !fx && !sa) continue;
        cs.push(`<c r="${ref}"${sa}${t}>${fx}${vx}</c>`);
      }
      out.push(`<row${attrs}>${cs.join('')}</row>`);
    }
    const colsXml = [];
    const colSet = new Set([...sh.colW.keys(), ...sh.hiddenCols, ...sh.colStyle.keys()]);
    for (const c of [...colSet].sort((a, b) => a - b)) {
      colsXml.push(`<col min="${c + 1}" max="${c + 1}" width="${sh.colW.has(c) ? ((sh.colW.get(c) - 5) / 7).toFixed(2) : 8.43}" customWidth="1"${sh.hiddenCols.has(c) ? ' hidden="1"' : ''}${sh.colStyle.has(c) ? ` style="${sh.colStyle.get(c)}"` : ''}/>`);
    }
    const sq = (rs) => rs.map((g) => (g.r1 === g.r2 && g.c1 === g.c2 ? cellName(g.r1, g.c1) : `${cellName(g.r1, g.c1)}:${cellName(g.r2, g.c2)}`)).join(' ');
    const view = `<sheetViews><sheetView workbookViewId="0"${sh.showGrid ? '' : ' showGridLines="0"'}>${sh.freeze.r || sh.freeze.c ? `<pane${sh.freeze.c ? ` xSplit="${sh.freeze.c}"` : ''}${sh.freeze.r ? ` ySplit="${sh.freeze.r}"` : ''} topLeftCell="${cellName(sh.freeze.r, sh.freeze.c)}" activePane="${sh.freeze.r && sh.freeze.c ? 'bottomRight' : sh.freeze.r ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : ''}</sheetView></sheetViews>`;
    let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${view}<sheetFormatPr defaultRowHeight="15"/>`;
    if (colsXml.length) x += `<cols>${colsXml.join('')}</cols>`;
    x += `<sheetData>${out.join('')}</sheetData>`;
    if (sh.filter && !st.tableFilter.has(sh)) x += `<autoFilter ref="${sq([sh.filter])}"/>`;
    if (sh.merges.length) x += `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${sq([m])}"/>`).join('')}</mergeCells>`;
    let prio = 1;
    for (const ru of sh.cf) {
      const tl = cellName(ru.ranges[0].r1, ru.ranges[0].c1), q = (v) => (typeof v === 'number' ? v : `"${String(v).replace(/"/g, '""')}"`);
      const d = ru.style ? ` dxfId="${dxfOf(ru.style)}"` : '';
      let body = '';
      switch (ru.type) {
        case 'cell': body = `<cfRule type="cellIs"${d} priority="${prio}" operator="${OPN[ru.op]}"><formula>${esc(q(ru.v1))}</formula>${ru.op.endsWith('between') ? `<formula>${esc(q(ru.v2))}</formula>` : ''}</cfRule>`; break;
        case 'text': {
          const T = esc(ru.v1), s = `"${String(ru.v1).replace(/"/g, '""')}"`;
          const spec = { contains: ['containsText', `NOT(ISERROR(SEARCH(${s},${tl})))`], notcontains: ['notContainsText', `ISERROR(SEARCH(${s},${tl}))`], begins: ['beginsWith', `LEFT(${tl},LEN(${s}))=${s}`], ends: ['endsWith', `RIGHT(${tl},LEN(${s}))=${s}`] }[ru.op];
          body = `<cfRule type="${spec[0]}"${d} priority="${prio}" operator="${spec[0]}" text="${T}"><formula>${esc(spec[1])}</formula></cfRule>`;
          break;
        }
        case 'dup': body = `<cfRule type="duplicateValues"${d} priority="${prio}"/>`; break;
        case 'unique': body = `<cfRule type="uniqueValues"${d} priority="${prio}"/>`; break;
        case 'blank': body = `<cfRule type="containsBlanks"${d} priority="${prio}"><formula>LEN(TRIM(${tl}))=0</formula></cfRule>`; break;
        case 'noblank': body = `<cfRule type="notContainsBlanks"${d} priority="${prio}"><formula>LEN(TRIM(${tl}))&gt;0</formula></cfRule>`; break;
        case 'top': body = `<cfRule type="top10"${d} priority="${prio}" rank="${ru.n}"${ru.bottom ? ' bottom="1"' : ''}${ru.pct ? ' percent="1"' : ''}/>`; break;
        case 'formula': body = `<cfRule type="expression"${d} priority="${prio}"><formula>${esc(exportFormula(ru.f.replace(/^=/, '')))}</formula></cfRule>`; break;
        case 'scale': body = `<cfRule type="colorScale" priority="${prio}"><colorScale><cfvo type="min"/>${ru.colors.length === 3 ? '<cfvo type="percentile" val="50"/>' : ''}<cfvo type="max"/>${ru.colors.map((c) => `<color rgb="${argb(c)}"/>`).join('')}</colorScale></cfRule>`; break;
        case 'bar': body = `<cfRule type="dataBar" priority="${prio}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${argb(ru.color || '#638ec6')}"/></dataBar></cfRule>`; break;
      }
      if (body) { x += `<conditionalFormatting sqref="${sq(ru.ranges)}">${body}</conditionalFormatting>`; prio++; }
    }
    if (sh.dv.length) {
      x += `<dataValidations count="${sh.dv.length}">` + sh.dv.map((dv) => {
        const type = { len: 'textLength' }[dv.type] || dv.type;
        const f = dv.type === 'list' ? `<formula1>${esc(dv.list.startsWith('=') ? dv.list.slice(1) : `"${dv.list}"`)}</formula1>` : `<formula1>${esc(dv.v1)}</formula1>${dv.op === 'between' || dv.op === 'notbetween' ? `<formula2>${esc(dv.v2)}</formula2>` : ''}`;
        return `<dataValidation type="${type}"${dv.type !== 'list' ? ` operator="${OPN[dv.op] || 'between'}"` : ''}${dv.allowBlank === false ? '' : ' allowBlank="1"'} showErrorMessage="1" errorTitle="Invalid value" error="${esc(dv.msg || 'This value does not match the validation rules.')}" sqref="${sq(dv.ranges)}">${f}</dataValidation>`;
      }).join('') + '</dataValidations>';
    }
    sheetsXml.push(x + parts.tail + '</worksheet>');
  }

  const names = [...wb.names].filter(([, d]) => !NOEXPORT.test(d.f)).map(([n, d]) => `<definedName name="${esc(n)}">${esc(exportFormula(d.f))}</definedName>`).join('');
  const EXTCT = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing' };
  const vba = wb.vba instanceof Uint8Array ? wb.vba : null;
  if (vba) { files['xl/vbaProject.bin'] = vba; st.exts.add('bin'); EXTCT.bin = 'application/vnd.ms-office.vbaProject'; }
  Object.assign(files, {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...st.exts].map((e) => `<Default Extension="${e}" ContentType="${EXTCT[e]}"/>`).join('')}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.${vba ? 'ms-excel.sheet.macroEnabled.main+xml' : 'openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>${wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${st.ct.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${names ? `<definedNames>${names}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${wb.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${wb.sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${vba ? `<Relationship Id="rId${wb.sheets.length + 3}" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>` : ''}</Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([c, i]) => `<numFmt numFmtId="${i}" formatCode="${esc(c)}"/>`).join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="${dxfs.length}">${dxfs.join('')}</dxfs></styleSheet>`,
  });
  sheetRelsXml.forEach((x, i) => { if (x) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = x; });
  const sstArr = [...strings.keys()];
  files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstArr.length}" uniqueCount="${sstArr.length}">${sstArr.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  sheetsXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  return { bytes: await zip(files), warnings: [...new Set(warnings)].slice(0, 8) };
}


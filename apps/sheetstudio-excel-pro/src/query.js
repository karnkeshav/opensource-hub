// Refreshable data queries: a source plus a list of transform steps (a compact take on Power Query).
import { Workbook, K } from './engine.js';
import { cmp, textToNum, parseDateText, isErr, grid } from './core.js';
import { parseCSV } from './csv.js';
import { tableAt } from './tables.js';

const blank = (v) => v === null || v === undefined || v === '';
const numish = (s) => typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s.trim());

export function jsonRows(arr) {
  if (arr.length && arr.every((o) => o && typeof o === 'object' && !Array.isArray(o))) {
    const keys = [...new Set(arr.flatMap(Object.keys))];
    return [keys, ...arr.map((o) => keys.map((k) => (o[k] && typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k] ?? null)))];
  }
  return arr.map((r) => (Array.isArray(r) ? r : [r]));
}

const unique = (head) => { const seen = new Map(); return head.map((h, i) => { let n = String(h ?? '') || `Column${i + 1}`; const k = n.toLowerCase(); if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); n += c; } else seen.set(k, 1); return n; }); };

export function readSource(wb, src) {
  let rows;
  if (src.type === 'range') {
    const tb = wb.table(src.ref);
    let ref;
    if (tb) ref = { sh: tb.sh, r1: tb.t.r1, c1: tb.t.c1, r2: tb.t.r2 - (tb.t.totals ? 1 : 0), c2: tb.t.c2, ref: true };
    else ref = wb.refFromString(src.ref, wb.sheets[0]);
    if (!ref) throw new Error(`Cannot find "${src.ref}"`);
    rows = grid(ref).map((r) => r.map((v) => (isErr(v) ? v.c : v ?? null)));
  } else if (src.type === 'csv') rows = parseCSV(src.text, src.delim || undefined).map((r) => r.map((v) => (v === '' ? null : numish(v) ? +v : v)));
  else if (src.type === 'json') { const j = JSON.parse(src.text); rows = jsonRows(Array.isArray(j) ? j : Object.values(j).find(Array.isArray) || [j]); }
  else throw new Error('Unknown source type');
  if (!rows.length) return [[], []];
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => (i < r.length ? r[i] : null)));
  if (src.header === false) rows.unshift(Array.from({ length: width }, (_, i) => `Column${i + 1}`));
  rows[0] = unique(rows[0]);
  return rows;
}

const col = (head, name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`Column "${name}" not found`); return i; };
const cols = (head, names) => (names || []).map((n) => col(head, n));
const asNum = (v) => (typeof v === 'string' && textToNum(v) === textToNum(v) && v.trim() !== '' ? textToNum(v) : v);

export const TESTS = [['=', 'equals'], ['<>', 'does not equal'], ['>', 'is greater than'], ['<', 'is less than'], ['>=', '≥'], ['<=', '≤'], ['contains', 'contains'], ['notcontains', 'does not contain'], ['begins', 'begins with'], ['ends', 'ends with'], ['blank', 'is empty'], ['nonblank', 'is not empty']];
const AGGS = [['sum', 'Sum'], ['count', 'Count rows'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'], ['first', 'First'], ['countd', 'Count distinct']];

// kind: col = one column, cols = several columns, text, num, select
export const STEPS = {
  keep: { label: 'Keep columns', f: [['cols', 'cols', 'Columns']] },
  remove: { label: 'Remove columns', f: [['cols', 'cols', 'Columns']] },
  rename: { label: 'Rename column', f: [['from', 'col', 'Column'], ['to', 'text', 'New name']] },
  filter: { label: 'Filter rows', f: [['col', 'col', 'Column'], ['test', 'select', 'Test', TESTS], ['value', 'text', 'Value']] },
  sort: { label: 'Sort rows', f: [['col', 'col', 'Column'], ['desc', 'select', 'Order', [['', 'Ascending'], ['1', 'Descending']]]] },
  distinct: { label: 'Remove duplicate rows', f: [] },
  top: { label: 'Keep first N rows', f: [['n', 'num', 'Rows']] },
  skip: { label: 'Skip first N rows', f: [['n', 'num', 'Rows']] },
  group: { label: 'Group by', f: [['by', 'cols', 'Group by'], ['col', 'col', 'Aggregate column'], ['fn', 'select', 'Function', AGGS], ['as', 'text', 'Result name']] },
  add: { label: 'Add column (formula)', f: [['name', 'text', 'New column name'], ['expr', 'text', 'Formula, e.g. [Qty]*[Price]']] },
  replace: { label: 'Replace values', f: [['col', 'col', 'Column'], ['from', 'text', 'Find'], ['to', 'text', 'Replace with']] },
  trim: { label: 'Trim text', f: [['col', 'col', 'Column']] },
  upper: { label: 'UPPER case', f: [['col', 'col', 'Column']] },
  lower: { label: 'lower case', f: [['col', 'col', 'Column']] },
  proper: { label: 'Proper Case', f: [['col', 'col', 'Column']] },
  type: { label: 'Change type', f: [['col', 'col', 'Column'], ['to', 'select', 'To', [['number', 'Number'], ['text', 'Text'], ['date', 'Date (serial)']]]] },
  filldown: { label: 'Fill down', f: [['col', 'col', 'Column']] },
  unpivot: { label: 'Unpivot columns', f: [['cols', 'cols', 'Columns to unpivot'], ['attr', 'text', 'Attribute column name'], ['val', 'text', 'Value column name']] },
  split: { label: 'Split column', f: [['col', 'col', 'Column'], ['delim', 'text', 'Delimiter']] },
  removeblank: { label: 'Remove empty rows', f: [] },
  transpose: { label: 'Transpose', f: [] },
};

export function describe(s) {
  const d = STEPS[s.op];
  const parts = d.f.map(([k]) => (Array.isArray(s[k]) ? s[k].join(', ') : s[k])).filter((x) => x !== undefined && x !== '');
  return d.label + (parts.length ? ': ' + parts.join(' · ') : '');
}

function evalColumn(head, body, expr) {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  head.forEach((h, c) => sh.cells.set(K(0, c), { v: String(h), f: null, s: 0 }));
  body.forEach((r, i) => r.forEach((v, c) => { if (!blank(v)) sh.cells.set(K(i + 1, c), { v, f: null, s: 0 }); }));
  const f = expr.replace(/^=/, '').replace(/\[([^\]@#]+)\]/g, '[@[$1]]');
  body.forEach((_, i) => sh.cells.set(K(i + 1, head.length), { v: null, f, s: 0 }));
  sh.cells.set(K(0, head.length), { v: '\u0000calc', f: null, s: 0 });
  sh.maxR = body.length; sh.maxC = head.length;
  sh.tables.push({ name: 'Q', r1: 0, c1: 0, r2: body.length, c2: head.length, header: true });
  wb.warm();
  return body.map((_, i) => { const v = sh.get(i + 1, head.length); return isErr(v) ? v.c : v; });
}

export function applyStep(head, body, s) {
  switch (s.op) {
    case 'keep': { const ix = cols(head, s.cols); return [ix.map((i) => head[i]), body.map((r) => ix.map((i) => r[i]))]; }
    case 'remove': { const drop = new Set(cols(head, s.cols)); const ix = head.map((_, i) => i).filter((i) => !drop.has(i)); return [ix.map((i) => head[i]), body.map((r) => ix.map((i) => r[i]))]; }
    case 'rename': { const i = col(head, s.from); const h = head.slice(); h[i] = s.to; return [unique(h), body]; }
    case 'filter': {
      const i = col(head, s.col);
      const val = numish(s.value) ? +s.value : s.value;
      const text = (v) => String(v ?? '').toLowerCase(), t = text(s.value);
      const ok = (raw) => {
        const v = typeof val === 'number' ? asNum(raw) : raw;
        switch (s.test) {
          case 'blank': return blank(raw);
          case 'nonblank': return !blank(raw);
          case 'contains': return text(raw).includes(t);
          case 'notcontains': return !text(raw).includes(t);
          case 'begins': return text(raw).startsWith(t);
          case 'ends': return text(raw).endsWith(t);
          case '=': return !blank(raw) && cmp(v, val) === 0;
          case '<>': return blank(raw) || cmp(v, val) !== 0;
          case '>': return !blank(raw) && cmp(v, val) > 0;
          case '<': return !blank(raw) && cmp(v, val) < 0;
          case '>=': return !blank(raw) && cmp(v, val) >= 0;
          case '<=': return !blank(raw) && cmp(v, val) <= 0;
        }
        return true;
      };
      return [head, body.filter((r) => ok(r[i]))];
    }
    case 'sort': {
      const i = col(head, s.col), d = s.desc ? -1 : 1;
      return [head, body.map((r, n) => [r, n]).sort(([a, x], [b, y]) => (blank(a[i]) || blank(b[i]) ? (blank(a[i]) && blank(b[i]) ? 0 : blank(a[i]) ? 1 : -1) : cmp(a[i], b[i]) * d) || x - y).map(([r]) => r)];
    }
    case 'distinct': { const seen = new Set(); return [head, body.filter((r) => { const k = JSON.stringify(r.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))); if (seen.has(k)) return false; seen.add(k); return true; })]; }
    case 'top': return [head, body.slice(0, Math.max(0, +s.n))];
    case 'skip': return [head, body.slice(Math.max(0, +s.n))];
    case 'group': {
      const by = cols(head, s.by), vi = s.fn === 'count' ? 0 : col(head, s.col);
      const groups = new Map();
      for (const r of body) { const k = JSON.stringify(by.map((i) => r[i])); if (!groups.has(k)) groups.set(k, { key: by.map((i) => r[i]), rows: [] }); groups.get(k).rows.push(r); }
      const agg = (rs) => {
        const v = rs.map((r) => r[vi]), n = v.filter((x) => typeof x === 'number');
        switch (s.fn) {
          case 'count': return rs.length; case 'sum': return n.reduce((a, b) => a + b, 0); case 'avg': return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
          case 'min': return n.length ? Math.min(...n) : null; case 'max': return n.length ? Math.max(...n) : null; case 'first': return v[0] ?? null;
          case 'countd': return new Set(v.map((x) => JSON.stringify(x))).size;
        }
        return null;
      };
      return [[...by.map((i) => head[i]), s.as || `${s.fn} of ${s.col || 'rows'}`], [...groups.values()].map((g) => [...g.key, agg(g.rows)])];
    }
    case 'add': { const vals = evalColumn(head, body, s.expr); return [unique([...head, s.name || 'Custom']), body.map((r, i) => [...r, vals[i]])]; }
    case 'replace': { const i = col(head, s.col); return [head, body.map((r) => { const x = r[i]; const y = typeof x === 'string' ? x.split(s.from).join(s.to) : String(x) === s.from ? (numish(s.to) ? +s.to : s.to) : x; const o = r.slice(); o[i] = y; return o; })]; }
    case 'trim': case 'upper': case 'lower': case 'proper': {
      const i = col(head, s.col), f = { trim: (x) => x.replace(/\s+/g, ' ').trim(), upper: (x) => x.toUpperCase(), lower: (x) => x.toLowerCase(), proper: (x) => x.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, p, c) => p + c.toUpperCase()) }[s.op];
      return [head, body.map((r) => { const o = r.slice(); if (typeof o[i] === 'string') o[i] = f(o[i]); return o; })];
    }
    case 'type': {
      const i = col(head, s.col);
      const f = { number: (x) => (typeof x === 'number' ? x : blank(x) ? null : (asNum(x) === x ? null : asNum(x))), text: (x) => (blank(x) ? null : String(x)), date: (x) => (typeof x === 'number' ? x : typeof x === 'string' ? (parseDateText(x)?.serial ?? null) : null) }[s.to];
      return [head, body.map((r) => { const o = r.slice(); o[i] = f(o[i]); return o; })];
    }
    case 'filldown': { const i = col(head, s.col); let last = null; return [head, body.map((r) => { const o = r.slice(); if (blank(o[i])) o[i] = last; else last = o[i]; return o; })]; }
    case 'unpivot': {
      const u = new Set(cols(head, s.cols)), keep = head.map((_, i) => i).filter((i) => !u.has(i)), uc = [...u];
      const out = [];
      for (const r of body) for (const i of uc) out.push([...keep.map((k) => r[k]), head[i], r[i]]);
      return [[...keep.map((k) => head[k]), s.attr || 'Attribute', s.val || 'Value'], out];
    }
    case 'split': {
      const i = col(head, s.col), parts = body.map((r) => (typeof r[i] === 'string' ? r[i].split(s.delim || ',').map((x) => x.trim()) : [r[i]]));
      const n = Math.max(1, ...parts.map((p) => p.length));
      const names = Array.from({ length: n }, (_, k) => `${s.col}.${k + 1}`);
      return [unique([...head.slice(0, i), ...names, ...head.slice(i + 1)]), body.map((r, ri) => [...r.slice(0, i), ...Array.from({ length: n }, (_, k) => (k < parts[ri].length ? (numish(parts[ri][k]) ? +parts[ri][k] : parts[ri][k]) : null)), ...r.slice(i + 1)])];
    }
    case 'removeblank': return [head, body.filter((r) => r.some((v) => !blank(v)))];
    case 'transpose': { const all = [head, ...body]; const t = all[0].map((_, j) => all.map((r) => r[j])); return [unique(t[0].map((v, i) => v ?? `Column${i + 1}`)), t.slice(1)]; }
  }
  throw new Error('Unknown step ' + s.op);
}

// Returns rows (header first). Throws with a readable message on a broken step.
export function runQuery(wb, q, upTo = Infinity) {
  const all = readSource(wb, q.source);
  let head = all[0], body = all.slice(1);
  q.steps.slice(0, upTo).forEach((s, i) => {
    try { [head, body] = applyStep(head, body, s); } catch (e) { throw new Error(`Step ${i + 1} (${STEPS[s.op].label}): ${e.message}`); }
  });
  return [head, ...body];
}

// Write a query result into its destination sheet (replacing the previous output) and maintain its table.
export function loadQuery(wb, q) {
  const rows = runQuery(wb, q);
  const sh = wb.sheet(q.dest.sheet) || wb.sheets[0];
  const old = q.out;
  if (old && sh) sh.clear(old.r1, old.c1, old.r2, old.c2, 'all');
  const { r, c } = q.dest;
  rows.forEach((row, i) => row.forEach((v, j) => sh.setValue(r + i, c + j, v)));
  const out = { r1: r, c1: c, r2: r + rows.length - 1, c2: c + (rows[0].length || 1) - 1 };
  q.out = out;
  const name = (q.name || 'Query').replace(/[^\w.]/g, '_').replace(/^(\d)/, '_$1');
  sh.tables = sh.tables.filter((t) => t.queryId !== q.id);
  if (rows[0].length && !tableAt(sh, r, c)) sh.tables.push({ name: uniqueName(wb, name, q.id), r1: out.r1, c1: out.c1, r2: out.r2, c2: out.c2, header: true, accent: 5, band: true, queryId: q.id });
  return rows;
}
function uniqueName(wb, base, qid) {
  const taken = new Set(wb.sheets.flatMap((s) => s.tables.filter((t) => t.queryId !== qid).map((t) => t.name.toLowerCase())));
  let n = base, i = 2;
  while (taken.has(n.toLowerCase()) || /^[A-Za-z]{1,3}\d+$/.test(n)) n = base + i++;
  return n;
}

// Excel tables: structured references (Table1[Col], [@Col], [[#Headers],[Col]]) and table geometry.
import { E } from './core.js';

const unesc = (s) => s.replace(/'(.)/g, '$1');
export const escCol = (s) => s.replace(/(['#[\]])/g, "'$1");

// Split "[a],[b]:[c]" style content into bracket groups.
function groups(inner) {
  const out = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] !== '[') { i++; continue; }
    let d = 0, j = i;
    for (; j < inner.length; j++) {
      if (inner[j] === "'") j++;
      else if (inner[j] === '[') d++;
      else if (inner[j] === ']' && --d === 0) break;
    }
    const range = out.length && /^\s*:\s*$/.test(inner.slice(out[out.length - 1].end, i));
    out.push({ txt: inner.slice(i + 1, j), range, end: j + 1 });
    i = j + 1;
  }
  return out;
}

export function parseSpec(spec) {
  const o = { thisRow: false, flags: new Set(), from: null, to: null };
  const inner = spec.slice(1, -1).trim();
  if (!inner) return o;
  const special = (t) => /^#(all|data|headers|totals|this row)$/i.test(t);
  const flag = (t) => { const k = t.toLowerCase(); if (k === '#this row') o.thisRow = true; else o.flags.add(k.slice(1)); };
  if (inner[0] === '@') {
    o.thisRow = true;
    let r = inner.slice(1).trim();
    if (r[0] === '[') r = groups(r)[0].txt;
    if (r) o.from = o.to = unesc(r);
    return o;
  }
  if (inner[0] !== '[') { if (special(inner)) flag(inner); else o.from = o.to = unesc(inner); return o; }
  for (const g of groups(inner)) {
    if (special(g.txt)) flag(g.txt);
    else if (g.range) o.to = unesc(g.txt);
    else { o.from = o.to = unesc(g.txt); }
  }
  return o;
}

export function tableAt(sh, r, c) {
  return sh.tables.find((t) => r >= t.r1 && r <= t.r2 && c >= t.c1 && c <= t.c2) || null;
}

export function tableColumns(sh, t) {
  const out = [];
  for (let c = t.c1; c <= t.c2; c++) { const v = sh.get(t.r1, c); out.push(v == null || v === '' ? `Column${c - t.c1 + 1}` : String(v)); }
  return out;
}

// Resolve a structured reference to a { ref } range object.
export function tableRef(wb, name, spec, ctx) {
  let sh, t;
  if (name) { const f = wb.table(name); if (!f) throw E.REF; ({ sh, t } = f); } else { sh = ctx.sheet; t = tableAt(sh, ctx.row, ctx.col); if (!t) throw E.REF; }
  const sp = parseSpec(spec), hdr = t.header !== false, tot = !!t.totals;
  const d1 = t.r1 + (hdr ? 1 : 0), d2 = t.r2 - (tot ? 1 : 0);
  let r1, r2;
  if (sp.thisRow) {
    if (ctx.sheet !== sh || ctx.row < d1 || ctx.row > d2) throw E.VALUE;
    r1 = r2 = ctx.row;
  } else {
    const f = sp.flags, rows = [];
    if (f.has('all')) rows.push(t.r1, t.r2);
    if (f.has('headers')) { if (!hdr) throw E.REF; rows.push(t.r1); }
    if (f.has('totals')) { if (!tot) throw E.REF; rows.push(t.r2); }
    if (f.has('data') || !rows.length) { if (d2 < d1) throw E.REF; rows.push(d1, d2); }
    r1 = Math.min(...rows); r2 = Math.max(...rows);
  }
  let c1 = t.c1, c2 = t.c2;
  if (sp.from !== null) {
    const cols = tableColumns(sh, t).map((x) => x.toLowerCase());
    const a = cols.indexOf(sp.from.toLowerCase()), b = cols.indexOf(sp.to.toLowerCase());
    if (a < 0 || b < 0) throw E.REF;
    c1 = t.c1 + Math.min(a, b); c2 = t.c1 + Math.max(a, b);
  }
  return { ref: true, sh, r1, c1, r2, c2 };
}

// Excel's built-in accent palette used for table styles (accent 1..6).
export const ACCENTS = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
export const ACCENT_NAMES = ['Blue', 'Orange', 'Gray', 'Gold', 'Light blue', 'Green'];
const hexOf = (c) => { c = (c || '').trim(); if (/^#[0-9a-f]{3}$/i.test(c)) c = '#' + [...c.slice(1)].map((x) => x + x).join(''); return /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff'; };
const mixTo = (hex, base, k) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k + parseInt(base.slice(i, i + 2), 16) * (1 - k)).toString(16).padStart(2, '0')).join('');
// Visual style of a cell inside a table, or null. `base` is the sheet's cell background (so dark mode blends in).
export function tableStyle(t, r, base) {
  const col = ACCENTS[(t.accent ?? 0) % 6], b = hexOf(base);
  const dark = (parseInt(b.slice(1, 3), 16) * 299 + parseInt(b.slice(3, 5), 16) * 587 + parseInt(b.slice(5, 7), 16) * 114) / 1000 < 128;
  if (t.header !== false && r === t.r1) return { bg: col, fc: '#ffffff', b: true };
  if (t.totals && r === t.r2) return { b: true, top: col, bg: mixTo(col, b, dark ? 0.25 : 0.12) };
  if (t.band !== false && (r - t.r1 - (t.header !== false ? 1 : 0)) % 2 === 0) return { bg: mixTo(col, b, dark ? 0.22 : 0.14), fc: dark ? '#e6e9ef' : undefined };
  return null;
}

export function uniqueTableName(wb, base = 'Table') {
  const all = new Set(wb.sheets.flatMap((s) => s.tables.map((t) => t.name.toLowerCase())));
  let i = 1;
  while (all.has((base + i).toLowerCase())) i++;
  return base + i;
}

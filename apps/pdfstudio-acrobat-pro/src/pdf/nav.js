// Outline (bookmarks), destinations, named destinations, page labels, metadata.
import { Dict, Ref, Name, Str, N, textOf, textStr, pdfDate } from './obj.js';

function nameTree(doc, root, key) {
  const seen = new Set();
  const walk = (n, d) => {
    n = doc.get(n);
    if (!(n instanceof Dict) || d > 32) return undefined;
    const names = doc.get(n.get('Names'));
    if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) { const k = doc.get(names[i]); if (k instanceof Str && k.s === key) return names[i + 1]; }
    const kids = doc.get(n.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) {
      if (k instanceof Ref) { if (seen.has(k.num)) continue; seen.add(k.num); }
      const lim = doc.get(doc.get(k)?.get?.('Limits'));
      if (Array.isArray(lim) && lim[0] instanceof Str && (key < lim[0].s || key > doc.get(lim[1]).s)) continue;
      const r = walk(k, d + 1); if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(root, 0);
}
export function nameTreeAll(doc, root) {
  const out = [];
  const walk = (n, d) => {
    n = doc.get(n);
    if (!(n instanceof Dict) || d > 32) return;
    const names = doc.get(n.get('Names'));
    if (Array.isArray(names)) for (let i = 0; i + 1 < names.length; i += 2) out.push([doc.get(names[i]), names[i + 1]]);
    const kids = doc.get(n.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(k, d + 1);
  };
  walk(root, 0);
  return out;
}
// Resolve a destination to { page: index, y, x, zoom } or null
export function resolveDest(doc, dest) {
  dest = doc.get(dest);
  if (dest instanceof Name || dest instanceof Str) {
    const key = dest instanceof Name ? dest.n : dest.s;
    const cat = doc.catalog;
    let d;
    const names = doc.get(cat.get('Names'));
    if (names instanceof Dict && names.get('Dests')) d = nameTree(doc, names.get('Dests'), key);
    if (d === undefined) { const old = doc.get(cat.get('Dests')); if (old instanceof Dict) d = old.get(key); }
    d = doc.get(d);
    if (d instanceof Dict) d = doc.get(d.get('D'));
    dest = d;
  }
  if (!Array.isArray(dest) || !dest.length) return null;
  const p = dest[0];
  let page = -1;
  if (p instanceof Ref) page = doc.pageIndex(p);
  else if (typeof p === 'number') page = p;
  if (page < 0) return null;
  const kind = doc.get(dest[1])?.n;
  const num = (i) => { const v = doc.get(dest[i]); return typeof v === 'number' ? v : null; };
  let x = null, y = null;
  if (kind === 'XYZ') { x = num(2); y = num(3); } else if (kind === 'FitH' || kind === 'FitBH') y = num(2); else if (kind === 'FitR') { x = num(2); y = num(5); }
  return { page, x, y, kind };
}
export function actionTarget(doc, a) {
  a = doc.get(a);
  if (!(a instanceof Dict)) return null;
  const s = doc.get(a.get('S'))?.n;
  if (s === 'GoTo') return { dest: resolveDest(doc, a.get('D')) };
  if (s === 'URI') return { uri: textOf(doc.get(a.get('URI'))) };
  if (s === 'Named') return { named: doc.get(a.get('N'))?.n };
  return { other: s };
}
export function outline(doc) {
  const root = doc.get(doc.catalog.get('Outlines'));
  if (!(root instanceof Dict)) return [];
  const seen = new Set();
  const walk = (first, d) => {
    const out = [];
    let r = first;
    while (r && out.length < 10000) {
      if (r instanceof Ref) { if (seen.has(r.num)) break; seen.add(r.num); }
      const it = doc.get(r);
      if (!(it instanceof Dict)) break;
      const t = it.get('Dest') ? { dest: resolveDest(doc, it.get('Dest')) } : actionTarget(doc, it.get('A'));
      const c = doc.get(it.get('C'));
      out.push({ title: textOf(doc.get(it.get('Title'))), target: t, open: (doc.get(it.get('Count')) || 0) > 0, color: Array.isArray(c) ? c : null, flags: doc.get(it.get('F')) | 0, kids: d < 30 ? walk(it.get('First'), d + 1) : [] });
      r = it.get('Next');
    }
    return out;
  };
  return walk(root.get('First'), 0);
}
// Replace the outline with a JS tree [{title, page, kids}]
export function setOutline(doc, tree) {
  const cat = doc.touch(doc.rootRef);
  if (!tree.length) { cat.delete('Outlines'); return; }
  const rootRef = doc.add(new Dict({ Type: N('Outlines') }));
  const pages = doc.pages;
  const build = (items, parent) => {
    const refs = items.map(() => doc.add(new Dict()));
    let count = 0;
    items.forEach((it, i) => {
      const d = doc.get(refs[i]);
      d.set('Title', textStr(it.title || 'Untitled')); d.set('Parent', parent);
      if (i > 0) d.set('Prev', refs[i - 1]);
      if (i < refs.length - 1) d.set('Next', refs[i + 1]);
      const pg = pages[Math.max(0, Math.min(pages.length - 1, it.page | 0))];
      if (pg) d.set('Dest', [pg.ref, N('XYZ'), null, it.y ?? null, null]);
      if (it.kids && it.kids.length) { const [f, l, c] = build(it.kids, refs[i]); d.set('First', f); d.set('Last', l); d.set('Count', c); count += c; }
      count++;
    });
    return [refs[0], refs[refs.length - 1], count];
  };
  const [f, l, c] = build(tree, rootRef);
  const root = doc.get(rootRef);
  root.set('First', f); root.set('Last', l); root.set('Count', c);
  cat.set('Outlines', rootRef);
}
// Outline in editable form: [{title, page, kids}]
export const outlineTree = (doc) => {
  const conv = (items) => items.map((it) => ({ title: it.title, page: it.target?.dest?.page ?? 0, y: it.target?.dest?.y ?? null, kids: conv(it.kids) }));
  return conv(outline(doc));
};

const roman = (n) => { const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s; };
const letters = (n) => { const k = Math.floor((n - 1) / 26) + 1, c = String.fromCharCode(97 + ((n - 1) % 26)); return c.repeat(k); };
export function pageLabels(doc) {
  const n = doc.pageCount;
  const pl = doc.get(doc.catalog.get('PageLabels'));
  if (!(pl instanceof Dict)) return null;
  const ranges = [];
  const walk = (node, d) => {
    node = doc.get(node);
    if (!(node instanceof Dict) || d > 20) return;
    const nums = doc.get(node.get('Nums'));
    if (Array.isArray(nums)) for (let i = 0; i + 1 < nums.length; i += 2) ranges.push([doc.get(nums[i]), doc.get(nums[i + 1])]);
    const kids = doc.get(node.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(k, d + 1);
  };
  walk(pl, 0);
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < n; i++) {
    let r = null; for (const x of ranges) if (x[0] <= i) r = x;
    if (!r || !(r[1] instanceof Dict)) { out.push(String(i + 1)); continue; }
    const d = r[1], st = doc.get(d.get('S'))?.n, pre = textOf(doc.get(d.get('P'))), num = (doc.get(d.get('St')) || 1) + i - r[0];
    out.push(pre + (st === 'D' ? num : st === 'R' ? roman(num).toUpperCase() : st === 'r' ? roman(num) : st === 'A' ? letters(num).toUpperCase() : st === 'a' ? letters(num) : ''));
  }
  return out;
}
export function setPageLabels(doc, ranges) { // ranges: [{start, style:'D'|'R'|'r'|'A'|'a'|'', prefix, first}]
  const cat = doc.touch(doc.rootRef);
  if (!ranges.length) { cat.delete('PageLabels'); return; }
  const nums = [];
  for (const r of ranges.sort((a, b) => a.start - b.start)) { const d = new Dict(); if (r.style) d.set('S', N(r.style)); if (r.prefix) d.set('P', textStr(r.prefix)); if (r.first && r.first !== 1) d.set('St', r.first); nums.push(r.start, d); }
  cat.set('PageLabels', new Dict({ Nums: nums }));
}

export const META_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'];
export function getMeta(doc) {
  const i = doc.info, o = {};
  for (const k of [...META_KEYS, 'CreationDate', 'ModDate']) o[k] = textOf(doc.get(i.get(k)));
  return o;
}
export function setMeta(doc, vals) {
  const tr = doc.touchTrailer();
  let ref = tr.get('Info');
  let info;
  if (ref instanceof Ref) info = doc.touch(ref);
  else { info = new Dict(); ref = doc.add(info); tr.set('Info', ref); }
  for (const k of META_KEYS) if (k in vals) { if (vals[k]) info.set(k, textStr(vals[k])); else info.delete(k); }
  info.set('ModDate', new Str(pdfDate()));
  // keep XMP in sync by dropping a stale packet (readers fall back to /Info)
  const cat = doc.catalog;
  if (cat.get('Metadata')) doc.touch(doc.rootRef).delete('Metadata');
}

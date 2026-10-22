// Page-level editing: organise, merge/split, add content (text, images, stamps, watermarks, headers/footers, Bates).
import { Dict, Ref, Stream, Str, Name, N, bytes, clone, bin, textStr, pdfDate, mmul } from './obj.js';
import { PDFDoc } from './doc.js';
import { deflate } from './filters.js';
import { std14Width, encodings } from './fonts/glyphs.js';
import { fmtNum } from './writer.js';

export const f2 = fmtNum;
// --- new documents -----------------------------------------------------------
export function newDoc() {
  const d = new PDFDoc();
  const pages = d.add(new Dict({ Type: N('Pages'), Kids: [], Count: 0 }));
  const cat = d.add(new Dict({ Type: N('Catalog'), Pages: pages }));
  const info = d.add(new Dict({ Producer: textStr('PDFStudio Acrobat Pro'), CreationDate: new Str(pdfDate()) }));
  d.trailer.set('Root', cat); d.trailer.set('Info', info);
  d.version = '1.7';
  return d;
}
export function addPage(doc, w = 612, h = 792, at = doc.pageCount, content = '') {
  const refs = doc.flattenPages();
  const pr = doc.catalog.get('Pages');
  const cs = doc.add(new Stream(new Dict(), bytes(content)));
  const pg = doc.add(new Dict({ Type: N('Page'), Parent: pr, MediaBox: [0, 0, w, h], Resources: new Dict(), Contents: cs }));
  refs.splice(at, 0, pg);
  doc.setPageOrder(refs);
  return pg;
}

// --- organise -------------------------------------------------------------------
export function rotatePages(doc, idx, deg) {
  const pages = doc.pages;
  for (const i of idx) { const p = pages[i]; if (!p) continue; const d = doc.touch(p.ref); d.set('Rotate', (((p.rotate + deg) % 360) + 360) % 360); }
}
export function deletePages(doc, idx) {
  const refs = doc.flattenPages();
  const kill = new Set(idx);
  if (kill.size >= refs.length) throw new Error('A document needs at least one page');
  const keep = refs.filter((_, i) => !kill.has(i));
  doc.setPageOrder(keep);
  pruneOutline(doc);
}
export function reorderPages(doc, order) { // order: array of old indices in new order
  const refs = doc.flattenPages();
  doc.setPageOrder(order.map((i) => refs[i]));
}
export function movePages(doc, idx, to) {
  const refs = doc.flattenPages();
  const set = new Set(idx), moving = refs.filter((_, i) => set.has(i)), rest = refs.filter((_, i) => !set.has(i));
  const before = refs.slice(0, to).filter((_, i) => !set.has(i)).length;
  rest.splice(before, 0, ...moving);
  doc.setPageOrder(rest);
}
export function duplicatePages(doc, idx) {
  const refs = doc.flattenPages();
  const sorted = [...idx].sort((a, b) => b - a);
  for (const i of sorted) {
    const d = clone(doc.get(refs[i]));
    d.delete('Annots'); // annotations are page-bound objects; duplicates start clean
    const a = doc.get(doc.get(refs[i]).get('Annots'));
    if (Array.isArray(a)) {
      const na = [];
      for (const r of a) { const ad = doc.get(r); if (ad instanceof Dict && doc.get(ad.get('Subtype'))?.n !== 'Widget' && doc.get(ad.get('Subtype'))?.n !== 'Popup') { const c = clone(ad); c.delete('P'); c.delete('Popup'); na.push(doc.add(c)); } }
      if (na.length) d.set('Annots', na);
    }
    refs.splice(i + 1, 0, doc.add(d));
  }
  doc.setPageOrder(refs);
}
export function insertBlank(doc, at, w, h) {
  const ref = doc.pages[Math.max(0, Math.min(doc.pageCount - 1, at - 1))];
  const sz = ref ? ref.box('MediaBox') : [0, 0, 612, 792];
  return addPage(doc, w || sz[2] - sz[0], h || sz[3] - sz[1], at);
}
export function cropPages(doc, idx, box) { // box in user space [x0 y0 x1 y1] or null to reset
  for (const i of idx) { const p = doc.pages[i]; if (!p) continue; const d = doc.touch(p.ref); if (box) d.set('CropBox', box.map((v) => Math.round(v * 100) / 100)); else d.delete('CropBox'); }
}
function pruneOutline(doc) {
  // outline items pointing at deleted pages keep working as dead links; nothing else to do
  void doc;
}

// --- copy between documents ---------------------------------------------------
export function copyInto(dst, src, v, map) {
  if (v instanceof Ref) {
    if (map.has(v.num)) return map.get(v.num);
    const r = dst.add(null);
    map.set(v.num, r);
    dst.set(r, copyInto(dst, src, src.obj(v.num), map));
    return r;
  }
  if (Array.isArray(v)) return v.map((x) => copyInto(dst, src, x, map));
  if (v instanceof Dict) { const d = new Dict(); for (const [k, x] of v) d.set(k, copyInto(dst, src, x, map)); return d; }
  if (v instanceof Stream) { const s = new Stream(copyInto(dst, src, v.dict, map), v.data); return s; }
  if (v instanceof Str) return new Str(v.s, v.hex);
  return v;
}
// Import pages (indices) from src into dst at position `at`.
export function importPages(dst, src, idx, at = dst.pageCount) {
  const refs = dst.flattenPages();
  const map = new Map();
  const sp = src.pages;
  // pre-map parents so the copy does not drag in the source page tree
  const pr = dst.catalog.get('Pages');
  const newRefs = [];
  const fields = [];
  for (const i of idx) {
    const p = sp[i]; if (!p) continue;
    const d = new Dict();
    for (const [k, v] of p.dict) if (k !== 'Parent' && k !== 'StructParents' && k !== 'B') d.set(k, v);
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (!d.has(k) && p.inh[k] !== undefined) d.set(k, p.inh[k]);
    if (p.ref instanceof Ref) { const r = dst.add(null); map.set(p.ref.num, r); newRefs.push([r, d]); }
    else newRefs.push([dst.add(null), d]);
  }
  for (const [r, d] of newRefs) {
    const c = copyInto(dst, src, d, map);
    c.set('Parent', pr);
    dst.set(r, c);
    const an = dst.get(c.get('Annots'));
    if (Array.isArray(an)) for (const a of an) { let f = dst.get(a); let fr = a; while (f instanceof Dict && f.get('Parent') instanceof Ref) { fr = f.get('Parent'); f = dst.get(fr); } if (f instanceof Dict && (f.has('FT') || f.has('T'))) fields.push(fr); }
  }
  refs.splice(at, 0, ...newRefs.map((x) => x[0]));
  dst.setPageOrder(refs);
  if (fields.length) {
    const cat = dst.touch(dst.rootRef);
    let af = dst.get(cat.get('AcroForm'));
    if (!(af instanceof Dict)) { af = new Dict({ Fields: [] }); cat.set('AcroForm', dst.add(af)); }
    else if (cat.get('AcroForm') instanceof Ref) af = dst.touch(cat.get('AcroForm'));
    else { af = clone(af); cat.set('AcroForm', af); }
    const list = (dst.get(af.get('Fields')) || []).slice();
    const have = new Set(list.map((x) => x.num));
    for (const f of fields) if (!have.has(f.num)) { list.push(f); have.add(f.num); }
    af.set('Fields', list);
    const sa = src.get(src.catalog.get('AcroForm'));
    if (sa instanceof Dict && !af.has('DR') && sa.get('DR')) af.set('DR', copyInto(dst, src, sa.get('DR'), map));
    if (sa instanceof Dict && !af.has('DA') && sa.get('DA')) af.set('DA', copyInto(dst, src, sa.get('DA'), map));
  }
  return newRefs.map((x) => x[0]);
}
export function extractPages(src, idx) {
  const d = newDoc();
  importPages(d, src, idx, 0);
  const ii = src.info;
  if (ii.get('Title')) d.set(d.trailer.get('Info'), new Dict({ Title: ii.get('Title'), Producer: textStr('PDFStudio Acrobat Pro') }));
  return d;
}
export function parseRanges(s, n) { // "1-3, 5, 8-" -> [[0,1,2],[4],[7..n-1]]
  const out = [];
  for (const part of String(s).split(/[,;]/)) {
    const m = /^\s*(\d*)\s*(?:-\s*(\d*))?\s*$/.exec(part);
    if (!m || (!m[1] && !m[2] && !part.includes('-'))) continue;
    const a = m[1] ? +m[1] : 1, b = part.includes('-') ? (m[2] ? +m[2] : n) : a;
    const r = [];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) r.push(i - 1);
    if (r.length) out.push(r);
  }
  return out;
}

// --- content helpers ---------------------------------------------------------------
// Make the page's Resources a direct, page-owned dict and add `value` under category -> returns name.
export function addRes(doc, pageRef, cat, value, prefix = 'PS') {
  const pd = doc.touch(pageRef);
  const page = doc.pages[doc.pageIndex(pageRef)];
  let res = doc.get(pd.get('Resources') ?? page?.inh.Resources);
  res = res instanceof Dict ? clone(res) : new Dict();
  let sub = doc.get(res.get(cat));
  sub = sub instanceof Dict ? clone(sub) : new Dict();
  // reuse an identical ref
  if (value instanceof Ref) for (const [k, v] of sub) if (v instanceof Ref && v.num === value.num) { res.set(cat, sub); pd.set('Resources', res); return k; }
  let i = 1; while (sub.has(prefix + i)) i++;
  sub.set(prefix + i, value);
  res.set(cat, sub); pd.set('Resources', res);
  return prefix + i;
}
// Append (or prepend) content to a page, isolating the original content with q/Q.
export function addContent(doc, pageRef, content, prepend = false) {
  const pd = doc.touch(pageRef);
  const c = doc.get(pd.get('Contents'));
  let list = Array.isArray(pd.get('Contents')) ? pd.get('Contents').slice() : Array.isArray(c) ? c.slice() : pd.get('Contents') ? [pd.get('Contents')] : [];
  const s = doc.add(new Stream(new Dict(), bytes(content)));
  if (prepend) list = [s, ...list];
  else {
    if (list.length && !pd.isolated) { list = [doc.add(new Stream(new Dict(), bytes('q\n'))), ...list, doc.add(new Stream(new Dict(), bytes('\nQ\n')))]; }
    list.push(s);
  }
  pd.set('Contents', list);
  return s;
}
// Replace a page's content with a single stream
export function setContent(doc, pageRef, u8) {
  const pd = doc.touch(pageRef);
  pd.set('Contents', doc.add(new Stream(new Dict(), u8)));
}
export function stdFont(doc, base = 'Helvetica') {
  doc.stdFonts = doc.stdFonts || new Map();
  const key = base;
  const known = doc.stdFonts.get(key);
  if (known && doc.obj(known.num)) return known;
  const r = doc.add(new Dict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N(base), Encoding: N('WinAnsiEncoding') }));
  doc.stdFonts.set(key, r);
  return r;
}
let WIN_REV;
export function winAnsi(str) {
  if (!WIN_REV) { WIN_REV = new Map(); encodings().WinAnsiEncoding.forEach((u, c) => { if (u && c >= 32 && !WIN_REV.has(u)) WIN_REV.set(u, c); }); }
  let s = '';
  for (const ch of str) { const c = WIN_REV.get(ch.codePointAt(0)); s += c ? String.fromCharCode(c) : ch === '\t' ? ' ' : '?'; }
  return s;
}
export const canWinAnsi = (str) => { winAnsi(''); for (const ch of str) if (!WIN_REV.has(ch.codePointAt(0)) && ch !== '\n') return false; return true; };
const KEY = { Helvetica: 'Helvetica', 'Helvetica-Bold': 'Helvetica-Bold', 'Times-Roman': 'Times-Roman', 'Times-Bold': 'Times-Bold', 'Times-Italic': 'Times-Italic', Courier: 'Courier' };
export function textWidth(str, size, base = 'Helvetica') {
  let w = 0;
  for (const ch of str) w += std14Width(KEY[base] || 'Helvetica', ch.codePointAt(0)) || 556;
  return (w * size) / 1000;
}
export const pdfStrLit = (s) => '(' + s.replace(/[\\()]/g, (c) => '\\' + c).replace(/\r/g, '\\r') + ')';
export function wrapText(text, size, width, base = 'Helvetica') {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (line && textWidth(t.trimEnd(), size, base) > width) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = t;
    }
    out.push(line);
  }
  return out;
}
export const rgbOps = (c, stroke) => (c ? c.map((v) => f2(v)).join(' ') + (stroke ? ' RG' : ' rg') : '');
export const hexRgb = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0, 0, 0]; };
export function gsAlpha(doc, a, bm) {
  doc.gsCache = doc.gsCache || new Map();
  const k = a + '|' + (bm || '');
  if (doc.gsCache.has(k) && doc.obj(doc.gsCache.get(k).num)) return doc.gsCache.get(k);
  const d = new Dict({ Type: N('ExtGState'), CA: a, ca: a });
  if (bm) d.set('BM', N(bm));
  const r = doc.add(d); doc.gsCache.set(k, r); return r;
}

// Add a text block to a page (page content, not an annotation). opts: {x,y,size,font,color,opacity,rotate,align,width}
export function addText(doc, pageIdx, text, o = {}) {
  const page = doc.pages[pageIdx];
  const fontName = addRes(doc, page.ref, 'Font', stdFont(doc, o.font || 'Helvetica'), 'PSf');
  const size = o.size || 12, lines = o.width ? wrapText(text, size, o.width, o.font) : String(text).split('\n');
  let s = 'q\n';
  if (o.opacity !== undefined && o.opacity < 1) s += '/' + addRes(doc, page.ref, 'ExtGState', gsAlpha(doc, o.opacity), 'PSg') + ' gs\n';
  const rad = ((o.rotate || 0) * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  s += `${f2(cos)} ${f2(sin)} ${f2(-sin)} ${f2(cos)} ${f2(o.x || 0)} ${f2(o.y || 0)} cm\n${rgbOps(o.color || [0, 0, 0])}\nBT /${fontName} ${f2(size)} Tf ${f2(size * (o.leading || 1.2))} TL\n`;
  lines.forEach((ln, i) => {
    const w = textWidth(ln, size, o.font);
    const dx = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
    s += `1 0 0 1 ${f2(dx)} ${f2(-i * size * (o.leading || 1.2))} Tm ${pdfStrLit(winAnsi(ln))} Tj\n`;
  });
  s += 'ET\nQ\n';
  addContent(doc, page.ref, s, !!o.behind);
}

// Image XObjects ------------------------------------------------------------------
export function jpegInfo(u8) {
  for (let i = 2; i + 9 < u8.length;) {
    if (u8[i] !== 0xff) { i++; continue; }
    const m = u8[i + 1], len = (u8[i + 2] << 8) | u8[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8], n: u8[i + 9] };
    i += 2 + len;
  }
  return null;
}
// PNG: passthrough of IDAT for non-interlaced gray/RGB/palette images (8-bit or less); returns null if unsupported.
export function pngInfo(u8) {
  if (u8[0] !== 0x89 || u8[1] !== 0x50) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, ihdr = null, plte = null, trns = null; const idat = [];
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]), d = u8.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: dv.getUint32(p + 8), h: dv.getUint32(p + 12), bits: d[8], ct: d[9], il: d[12] };
    else if (type === 'PLTE') plte = d; else if (type === 'tRNS') trns = d; else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) return null;
  return { ...ihdr, plte, trns, idat };
}
export async function imageXObject(doc, img) {
  if (img.jpeg) {
    const info = jpegInfo(img.jpeg);
    if (!info) throw new Error('Not a JPEG');
    const d = new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: info.w, Height: info.h, ColorSpace: N(info.n === 1 ? 'DeviceGray' : info.n === 4 ? 'DeviceCMYK' : 'DeviceRGB'), BitsPerComponent: 8, Filter: N('DCTDecode') });
    if (info.n === 4) d.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0]);
    return { ref: doc.add(new Stream(d, img.jpeg)), w: info.w, h: info.h };
  }
  if (img.png) {
    const p = pngInfo(img.png);
    if (p && !p.il && p.bits <= 8 && (p.ct === 0 || p.ct === 2 || (p.ct === 3 && p.plte)) && !p.trns) {
      const colors = p.ct === 2 ? 3 : 1;
      const data = new Uint8Array(p.idat.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of p.idat) { data.set(x, o); o += x.length; }
      const d = new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: p.w, Height: p.h, BitsPerComponent: p.bits, Filter: N('FlateDecode'), DecodeParms: new Dict({ Predictor: 15, Colors: colors, BitsPerComponent: p.bits, Columns: p.w }) });
      d.set('ColorSpace', p.ct === 3 ? [N('Indexed'), N('DeviceRGB'), p.plte.length / 3 - 1, new Str(bin(p.plte), true)] : N(p.ct === 2 ? 'DeviceRGB' : 'DeviceGray'));
      return { ref: doc.add(new Stream(d, data)), w: p.w, h: p.h };
    }
    if (!img.rgba) throw new Error('PNG needs decoding');
  }
  // raw RGBA
  const { w, h, rgba } = img;
  const rgb = new Uint8Array(w * h * 3), a = new Uint8Array(w * h);
  let hasA = false;
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; a[i] = rgba[i * 4 + 3]; if (a[i] !== 255) hasA = true; }
  const d = new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: w, Height: h, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8, Filter: N('FlateDecode') });
  if (hasA) d.set('SMask', doc.add(new Stream(new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: w, Height: h, ColorSpace: N('DeviceGray'), BitsPerComponent: 8, Filter: N('FlateDecode') }), await deflate(a))));
  return { ref: doc.add(new Stream(d, await deflate(rgb))), w, h };
}
export function drawImage(doc, pageIdx, xo, rect, o = {}) { // rect [x0 y0 x1 y1]
  const page = doc.pages[pageIdx];
  const nm = addRes(doc, page.ref, 'XObject', xo.ref, 'PSi');
  let s = 'q\n';
  if (o.opacity !== undefined && o.opacity < 1) s += '/' + addRes(doc, page.ref, 'ExtGState', gsAlpha(doc, o.opacity), 'PSg') + ' gs\n';
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  if (o.rotate) { const r = (o.rotate * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r), cx = rect[0] + w / 2, cy = rect[1] + h / 2; s += `1 0 0 1 ${f2(cx)} ${f2(cy)} cm ${f2(c)} ${f2(sn)} ${f2(-sn)} ${f2(c)} 0 0 cm 1 0 0 1 ${f2(-w / 2)} ${f2(-h / 2)} cm\n${f2(w)} 0 0 ${f2(h)} 0 0 cm /${nm} Do\nQ\n`; }
  else s += `${f2(w)} 0 0 ${f2(h)} ${f2(rect[0])} ${f2(rect[1])} cm /${nm} Do\nQ\n`;
  addContent(doc, page.ref, s, !!o.behind);
}

// Stamps: header/footer/page numbers/Bates. pos: 'tl','tc','tr','bl','bc','br'
export function stampText(doc, pages, makeText, o = {}) {
  const n = doc.pageCount;
  pages.forEach((i, k) => {
    const p = doc.pages[i];
    const v = p.view, size = o.size || 10, m = o.margin ?? 28;
    const text = makeText(i, k, n);
    if (!text) return;
    const pos = o.pos || 'bc';
    // place in the displayed orientation by working in the rotated frame
    const rot = p.rotate;
    const W = rot % 180 ? v[3] - v[1] : v[2] - v[0], H = rot % 180 ? v[2] - v[0] : v[3] - v[1];
    let x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - m : W / 2;
    let y = pos[0] === 't' ? H - m - size : m;
    const align = pos[1] === 'l' ? 'left' : pos[1] === 'r' ? 'right' : 'center';
    // map displayed coordinates to user space
    const M = rot === 90 ? [0, 1, -1, 0, v[2], v[1]] : rot === 180 ? [-1, 0, 0, -1, v[2], v[3]] : rot === 270 ? [0, -1, 1, 0, v[0], v[3]] : [1, 0, 0, 1, v[0], v[1]];
    const ux = M[0] * x + M[2] * y + M[4], uy = M[1] * x + M[3] * y + M[5];
    addText(doc, i, text, { x: ux, y: uy, size, color: o.color, font: o.font, align, rotate: rot, opacity: o.opacity });
  });
}
export function fmtTemplate(t, i, k, n, o = {}) {
  const d = new Date();
  return String(t).replace(/\{page\}/g, String(i + 1 + (o.offset || 0))).replace(/\{total\}/g, String(n)).replace(/\{date\}/g, d.toLocaleDateString()).replace(/\{title\}/g, o.title || '').replace(/\{file\}/g, o.file || '');
}
export const batesNum = (prefix, start, digits, k, suffix = '') => prefix + String(start + k).padStart(digits, '0') + suffix;

// Watermark: text or image, single or tiled, optionally behind content
export function watermark(doc, pages, o) {
  for (const i of pages) {
    const p = doc.pages[i], v = p.view, cx = (v[0] + v[2]) / 2, cy = (v[1] + v[3]) / 2;
    const alpha = o.opacity ?? 0.3;
    const g = addRes(doc, p.ref, 'ExtGState', gsAlpha(doc, alpha), 'PSg');
    let s = `q /${g} gs\n`;
    const rot = (((o.rotate ?? 45) - p.rotate) * Math.PI) / 180, c = Math.cos(rot), sn = Math.sin(rot);
    const spots = [];
    if (o.tiled) { const step = o.step || 200; for (let x = v[0]; x < v[2] + step; x += step) for (let y = v[1]; y < v[3] + step; y += step) spots.push([x, y]); }
    else spots.push([cx, cy]);
    if (o.image) {
      const nm = addRes(doc, p.ref, 'XObject', o.image.ref, 'PSi');
      const w = o.width || (v[2] - v[0]) * 0.5, h = (w * o.image.h) / o.image.w;
      for (const [x, y] of spots) s += `q ${f2(c)} ${f2(sn)} ${f2(-sn)} ${f2(c)} ${f2(x)} ${f2(y)} cm ${f2(w)} 0 0 ${f2(h)} ${f2(-w / 2)} ${f2(-h / 2)} cm /${nm} Do Q\n`;
    } else {
      const fn = addRes(doc, p.ref, 'Font', stdFont(doc, o.font || 'Helvetica-Bold'), 'PSf');
      const size = o.size || 60, w = textWidth(o.text, size, o.font || 'Helvetica-Bold');
      for (const [x, y] of spots) s += `q ${f2(c)} ${f2(sn)} ${f2(-sn)} ${f2(c)} ${f2(x)} ${f2(y)} cm ${rgbOps(o.color || [0.75, 0.1, 0.1])} BT /${fn} ${f2(size)} Tf ${f2(-w / 2)} ${f2(-size * 0.35)} Td ${pdfStrLit(winAnsi(o.text))} Tj ET Q\n`;
    }
    s += 'Q\n';
    addContent(doc, p.ref, s, !!o.behind);
  }
}
export function background(doc, pages, o) {
  for (const i of pages) {
    const p = doc.pages[i], v = p.box('MediaBox');
    let s = 'q ';
    if (o.image) { const nm = addRes(doc, p.ref, 'XObject', o.image.ref, 'PSi'); s += `${f2(v[2] - v[0])} 0 0 ${f2(v[3] - v[1])} ${f2(v[0])} ${f2(v[1])} cm /${nm} Do`; }
    else s += `${rgbOps(o.color || [1, 1, 0.9])} ${f2(v[0])} ${f2(v[1])} ${f2(v[2] - v[0])} ${f2(v[3] - v[1])} re f`;
    addContent(doc, p.ref, s + ' Q\n', true);
  }
}
export { mmul };

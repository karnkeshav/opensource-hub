// PDF object model. Strings and stream data are kept as bytes; names are interned objects.
export class Name { constructor(n) { this.n = n; } toString() { return '/' + this.n; } }
const NAMES = new Map();
export const N = (n) => { let v = NAMES.get(n); if (!v) NAMES.set(n, v = new Name(n)); return v; };
export class Ref { constructor(num, gen = 0) { this.num = num; this.gen = gen; } toString() { return this.num + ' ' + this.gen + ' R'; } }
export class Dict extends Map {
  constructor(o) { super(); if (o) for (const k in o) if (o[k] !== undefined && o[k] !== null) this.set(k, o[k]); }
}
// PDF string: bytes held as a binary (latin1) JS string. hex is a writer hint.
export class Str { constructor(s, hex = false) { this.s = s; this.hex = hex; } toString() { return this.s; } }
export class Stream {
  constructor(dict, data) { this.dict = dict || new Dict(); this.data = data || new Uint8Array(0); }
}
export const isName = (v, n) => v instanceof Name && (n === undefined || v.n === n);
export const isDict = (v) => v instanceof Dict;
export const nameOf = (v) => (v instanceof Name ? v.n : undefined);

// Byte helpers ------------------------------------------------------------
export const bin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
export const bytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);
export function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const o = new Uint8Array(n); let i = 0;
  for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}

// Text strings: PDFDocEncoding / UTF-16BE (BOM) / UTF-8 (BOM) -> JS string, and back.
const PDFDOC = { 0x18: 0x2d8, 0x19: 0x2c7, 0x1a: 0x2c6, 0x1b: 0x2d9, 0x1c: 0x2dd, 0x1d: 0x2db, 0x1e: 0x2da, 0x1f: 0x2dc, 0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203a, 0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018, 0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01, 0x94: 0xfb02, 0x95: 0x141, 0x96: 0x152, 0x97: 0x160, 0x98: 0x178, 0x99: 0x17d, 0x9a: 0x131, 0x9b: 0x142, 0x9c: 0x153, 0x9d: 0x161, 0x9e: 0x17e, 0xa0: 0x20ac };
export function textOf(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Name) return v.n;
  if (!(v instanceof Str)) return String(v);
  const s = v.s;
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let o = ''; for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return o.replace(/\x1b..\x1b/g, '');
  }
  if (s.startsWith('\xef\xbb\xbf')) return new TextDecoder().decode(bytes(s.slice(3)));
  let o = ''; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o += String.fromCharCode(PDFDOC[c] || c); }
  return o;
}
export function textStr(t) {
  t = String(t);
  if (/^[\x09\x0a\x0d\x20-\x7e\xa1-\xff]*$/.test(t)) return new Str(t);
  let s = '\xfe\xff';
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); s += String.fromCharCode(c >> 8, c & 255); }
  return new Str(s, true);
}
export function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset(), a = Math.abs(tz);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${tz === 0 ? 'Z' : (tz > 0 ? '+' : '-') + p(a / 60 | 0) + "'" + p(a % 60) + "'"}`;
}
export function parseDate(s) {
  const m = /D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([Z+-])?(\d\d)?'?(\d\d)?/.exec(s || '');
  if (!m) return null;
  let t = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
  if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000;
  return new Date(t);
}

// Deep clone of a direct object (refs are not followed; stream data shared).
export function clone(v) {
  if (v instanceof Dict) { const d = new Dict(); for (const [k, x] of v) d.set(k, clone(x)); return d; }
  if (Array.isArray(v)) return v.map(clone);
  if (v instanceof Stream) { const s = new Stream(clone(v.dict), v.data); if (v.decoded) s.decoded = v.decoded; return s; }
  if (v instanceof Str) return new Str(v.s, v.hex);
  return v;
}

// Matrices [a b c d e f]
export const mmul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function inv(m) {
  const d = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export function bboxOf(m, r) { // transform rect [x0 y0 x1 y1] by matrix, return bounding rect
  const p = [apply(m, r[0], r[1]), apply(m, r[2], r[1]), apply(m, r[0], r[3]), apply(m, r[2], r[3])];
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export const normRect = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
export const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

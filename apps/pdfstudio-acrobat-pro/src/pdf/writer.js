// PDF serializer: full rewrite (garbage-collected, optional object streams + xref stream, optional AES-256)
// and incremental update (appends changed objects, keeps earlier revisions and signatures intact).
import { Dict, Ref, Stream, Str, Name, N, bytes, bin, concat, isName } from './obj.js';
import { deflate } from './filters.js';
import { md5 } from './crypto.js';
import { findBack, Lexer } from './parser.js';

export function fmtNum(v) {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  let s = v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}
const NAMEOK = /^[!-~]$/;
export function fmtName(n) {
  let s = '/';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c > 255) { for (const b of new TextEncoder().encode(ch)) s += '#' + b.toString(16).padStart(2, '0'); continue; }
    s += NAMEOK.test(ch) && !'()<>[]{}/%#'.includes(ch) ? ch : '#' + c.toString(16).padStart(2, '0');
  }
  return s;
}
export function fmtStr(s, hex) {
  if (!hex) {
    let bad = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 && c !== 10 && c !== 9) bad++; }
    if (bad * 4 > s.length) hex = true;
  }
  if (hex) { let o = '<'; for (let i = 0; i < s.length; i++) o += s.charCodeAt(i).toString(16).padStart(2, '0'); return o + '>'; }
  return '(' + s.replace(/[\\()\r]/g, (c) => (c === '\r' ? '\\r' : '\\' + c)) + ')';
}
// Serialize a direct value to a latin1 string. map: old num -> new num (optional). crypt(str) encrypts strings.
export function ser(v, map, crypt) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Name) return fmtName(v.n);
  if (v instanceof Ref) { const n = map ? map.get(v.num) : v.num; return n === undefined ? 'null' : n + ' ' + (map ? 0 : v.gen) + ' R'; }
  if (v instanceof Str) return crypt ? fmtStr(crypt(v.s), true) : fmtStr(v.s, v.hex);
  if (Array.isArray(v)) return '[' + v.map((x) => ser(x, map, crypt)).join(' ') + ']';
  if (v instanceof Dict) { let s = '<<'; for (const [k, x] of v) { if (x === null || x === undefined) continue; s += fmtName(k) + ' ' + ser(x, map, crypt); } return s + '>>'; }
  if (v instanceof Stream) return ser(v.dict, map, crypt);
  return 'null';
}

class Out {
  constructor() { this.parts = []; this.len = 0; }
  str(s) { this.parts.push(bytes(s)); this.len += s.length; }
  raw(u) { this.parts.push(u); this.len += u.length; }
  done() { return concat(this.parts); }
}

// Collect objects reachable from the trailer.
export function reachable(doc, roots) {
  const seen = new Set(), order = [];
  const visit = (v) => {
    if (v instanceof Ref) { if (!seen.has(v.num)) { seen.add(v.num); const o = doc.obj(v.num); if (o !== null && o !== undefined) order.push(v.num); } }
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v instanceof Dict) for (const x of v.values()) visit(x);
    else if (v instanceof Stream) visit(v.dict);
  };
  for (const r of roots) visit(r);
  for (let i = 0; i < order.length; i++) visit(doc.obj(order[i]));
  return order;
}

async function prepStream(s, compress) {
  const d = new Dict(); for (const [k, v] of s.dict) d.set(k, v);
  let data = s.data;
  if (compress && !d.has('Filter') && data.length > 64 && !isName(d.get('Type'), 'Metadata')) {
    const z = await deflate(data);
    if (z.length < data.length) { data = z; d.set('Filter', N('FlateDecode')); d.delete('DecodeParms'); }
  }
  d.set('Length', data.length);
  return [d, data];
}

export function newId(doc) {
  const seed = bytes(Date.now() + ':' + Math.random() + ':' + doc.bytes.length);
  return bin(md5(seed));
}

// opts: { objStreams, compress=true, security (Security from newAES256), keepSecurity }
export async function saveFull(doc, opts = {}) {
  const compress = opts.compress !== false;
  const sec = opts.security || null;
  const tr = doc.trailer;
  const roots = [tr.get('Root'), tr.get('Info')].filter((x) => x instanceof Ref);
  const order = reachable(doc, roots);
  const map = new Map(); order.forEach((n, i) => map.set(n, i + 1));
  const out = new Out();
  const ver = Math.max(+doc.version || 1.4, sec ? 1.7 : opts.objStreams ? 1.5 : 1.4);
  out.str(`%PDF-${ver.toFixed(1)}\n%\xe2\xe3\xcf\xd3\n`);
  const offs = new Map(); // newNum -> {t, off|stm,idx}
  let next = order.length + 1;
  const encOf = (num) => (sec ? (s) => bin(sec.encrypt(num, 0, bytes(s), true)) : null);
  const packable = [];
  for (const old of order) {
    const nn = map.get(old), o = doc.obj(old);
    if (o instanceof Stream) {
      let [d, data] = await prepStream(o, compress);
      if (sec && !isName(d.get('Type'), 'XRef')) { data = sec.encrypt(nn, 0, data, false); d.set('Length', data.length); }
      offs.set(nn, { t: 1, off: out.len });
      out.str(`${nn} 0 obj\n${ser(d, map, encOf(nn))}\nstream\n`); out.raw(data); out.str('\nendstream\nendobj\n');
    } else if (opts.objStreams) packable.push([nn, o]);
    else { offs.set(nn, { t: 1, off: out.len }); out.str(`${nn} 0 obj\n${ser(o, map, encOf(nn))}\nendobj\n`); }
  }
  // Object streams
  for (let i = 0; i < packable.length; i += 100) {
    const chunk = packable.slice(i, i + 100), sn = next++;
    let head = '', body = '';
    chunk.forEach(([nn, o], k) => { head += nn + ' ' + body.length + ' '; body += ser(o, map, null) + '\n'; offs.set(nn, { t: 2, stm: sn, idx: k }); });
    let data = bytes(head + '\n' + body);
    const d = new Dict({ Type: N('ObjStm'), N: chunk.length, First: head.length + 1 });
    if (compress) { data = await deflate(data); d.set('Filter', N('FlateDecode')); }
    if (sec) data = sec.encrypt(sn, 0, data, false);
    d.set('Length', data.length);
    offs.set(sn, { t: 1, off: out.len });
    out.str(`${sn} 0 obj\n${ser(d)}\nstream\n`); out.raw(data); out.str('\nendstream\nendobj\n');
  }
  // Trailer
  const T = new Dict();
  T.set('Root', tr.get('Root'));
  if (tr.get('Info') instanceof Ref && map.has(tr.get('Info').num)) T.set('Info', tr.get('Info'));
  const oldId = doc.get(tr.get('ID'));
  const id0 = Array.isArray(oldId) && oldId[0] instanceof Str ? oldId[0].s : newId(doc);
  const ID = [new Str(id0, true), new Str(newId(doc), true)];
  let encNum = 0;
  if (sec) {
    encNum = next++;
    offs.set(encNum, { t: 1, off: out.len });
    out.str(`${encNum} 0 obj\n${ser(sec.dict)}\nendobj\n`);
  }
  const size = next;
  const tser = (extra) => {
    let s = '<<' + fmtName('Size') + ' ' + size + fmtName('Root') + ' ' + ser(T.get('Root'), map);
    if (T.get('Info')) s += fmtName('Info') + ' ' + ser(T.get('Info'), map);
    if (encNum) s += fmtName('Encrypt') + ' ' + encNum + ' 0 R';
    return s + fmtName('ID') + ' [' + ID.map((x) => fmtStr(x.s, true)).join(' ') + ']' + (extra || '') + '>>';
  };
  const xoff = out.len;
  if (opts.objStreams) {
    const xn = size; // xref stream object number = size (Size becomes size+1)
    offs.set(xn, { t: 1, off: xoff });
    const rows = new Uint8Array((xn + 1) * 7);
    for (let n = 0; n <= xn; n++) {
      const e = offs.get(n), r = n * 7;
      if (!e) { rows[r] = 0; rows[r + 5] = 255; rows[r + 6] = 255; continue; }
      const a = e.t === 1 ? e.off : e.stm, c = e.t === 1 ? 0 : e.idx;
      rows[r] = e.t; rows[r + 1] = (a >>> 24) & 255; rows[r + 2] = (a >>> 16) & 255; rows[r + 3] = (a >>> 8) & 255; rows[r + 4] = a & 255; rows[r + 5] = (c >> 8) & 255; rows[r + 6] = c & 255;
    }
    const data = compress ? await deflate(rows) : rows;
    let s = tser(`/Type/XRef/W[1 4 2]/Length ${data.length}` + (compress ? '/Filter/FlateDecode' : ''));
    s = s.replace('/Size ' + size, '/Size ' + (size + 1));
    out.str(`${xn} 0 obj\n${s}\nstream\n`); out.raw(data); out.str('\nendstream\nendobj\n');
  } else {
    let s = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (let n = 1; n < size; n++) { const e = offs.get(n); s += e ? String(e.off).padStart(10, '0') + ' 00000 n \n' : '0000000000 65535 f \n'; }
    out.str(s + 'trailer\n' + tser() + '\n');
  }
  out.str(`startxref\n${xoff}\n%%EOF\n`);
  return out.done();
}

// Incremental update: append changed objects to the original bytes.
export async function saveIncremental(doc, opts = {}) {
  const orig = doc.bytes;
  const sec = doc.sec || null;
  const out = new Out();
  out.raw(orig);
  if (orig.length && orig[orig.length - 1] !== 10) out.str('\n');
  const changed = [...doc.objs.keys()].sort((a, b) => a - b).filter((n) => n !== doc.encRef);
  const offs = new Map();
  for (const n of changed) {
    const o = doc.objs.get(n);
    if (o === null || o === undefined) { offs.set(n, null); continue; }
    const crypt = sec ? (s) => bin(sec.encrypt(n, 0, bytes(s), true)) : null;
    offs.set(n, out.len - doc.base);
    if (o instanceof Stream) {
      let [d, data] = await prepStream(o, opts.compress !== false);
      if (sec) { data = sec.encrypt(n, 0, data, false); d.set('Length', data.length); }
      out.str(`${n} 0 obj\n${ser(d, null, crypt)}\nstream\n`); out.raw(data); out.str('\nendstream\nendobj\n');
    } else out.str(`${n} 0 obj\n${ser(o, null, crypt)}\nendobj\n`);
  }
  if (opts.extra) for (const [n, s] of opts.extra) { offs.set(n, out.len - doc.base); out.str(s); }
  const sx = findBack(orig, 'startxref', orig.length, Math.max(0, orig.length - 4096));
  let prev = sx >= 0 ? new Lexer(orig, sx + 9).tok() : 0;
  const size = Math.max(doc.maxNum + 1, ...[...offs.keys()].map((n) => n + 1));
  const T = new Dict();
  for (const k of ['Root', 'Info', 'Encrypt']) if (doc.trailer.get(k) !== undefined) T.set(k, doc.trailer.get(k));
  const oldId = doc.get(doc.trailer.get('ID'));
  const id0 = Array.isArray(oldId) && oldId[0] instanceof Str ? oldId[0].s : newId(doc);
  T.set('ID', [new Str(id0, true), new Str(sec ? (oldId?.[1]?.s ?? id0) : newId(doc), true)]);
  T.set('Size', size);
  if (typeof prev === 'number' && !doc.repaired) T.set('Prev', prev);
  // Subsections of consecutive numbers
  const nums = [...offs.keys()].sort((a, b) => a - b);
  const xoff = out.len - doc.base;
  const usesStream = !doc.repaired && typeof prev === 'number' && (() => { const l = new Lexer(orig, doc.base + prev); const t = l.tok(); return typeof t === 'number'; })();
  if (usesStream) {
    const xn = size; T.set('Size', size + 1);
    nums.push(xn); offs.set(xn, xoff);
    const idx = [], rows = [];
    for (let i = 0; i < nums.length;) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; idx.push(nums[i], j - i + 1); for (let k = i; k <= j; k++) rows.push(offs.get(nums[k])); i = j + 1; }
    const data = new Uint8Array(rows.length * 7);
    rows.forEach((o, i) => { const r = i * 7; if (o === null) { data[r + 5] = data[r + 6] = 255; return; } data[r] = 1; data[r + 1] = (o >>> 24) & 255; data[r + 2] = (o >>> 16) & 255; data[r + 3] = (o >>> 8) & 255; data[r + 4] = o & 255; });
    T.set('Type', N('XRef')); T.set('W', [1, 4, 2]); T.set('Index', idx); T.set('Length', data.length);
    out.str(`${xn} 0 obj\n${ser(T)}\nstream\n`); out.raw(data); out.str('\nendstream\nendobj\n');
  } else {
    let s = 'xref\n';
    if (!nums.includes(0)) s += '0 1\n0000000000 65535 f \n';
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      s += nums[i] + ' ' + (j - i + 1) + '\n';
      for (let k = i; k <= j; k++) { const o = offs.get(nums[k]); s += o === null ? '0000000000 65535 f \n' : String(o).padStart(10, '0') + ' 00000 n \n'; }
      i = j + 1;
    }
    out.str(s + 'trailer\n' + ser(T) + '\n');
  }
  out.str(`startxref\n${xoff}\n%%EOF\n`);
  return out.done();
}

// TrueType / OpenType (sfnt) reader: tables, cmaps, post glyph names, glyf outlines.
// Glyph outlines are returned as flat path arrays in font units: [op, ...args] with ops M L Q C Z.
import { MAC_GLYPHS } from './glyphs.js';

export class Sfnt {
  constructor(u8) {
    this.b = u8; this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const v = this.v;
    let off = 0;
    if (v.getUint32(0) === 0x74746366) off = v.getUint32(12); // ttcf: first font
    const n = v.getUint16(off + 4);
    this.t = {};
    for (let i = 0; i < n; i++) {
      const r = off + 12 + i * 16;
      const tag = String.fromCharCode(u8[r], u8[r + 1], u8[r + 2], u8[r + 3]);
      this.t[tag] = { o: v.getUint32(r + 8), l: v.getUint32(r + 12) };
    }
    const head = this.t.head;
    this.upem = head ? v.getUint16(head.o + 18) || 1000 : 1000;
    this.locaLong = head ? v.getInt16(head.o + 50) === 1 : false;
    this.numGlyphs = this.t.maxp ? v.getUint16(this.t.maxp.o + 4) : 0;
    this.cache = new Map();
  }
  has(tag) { return !!this.t[tag]; }
  table(tag) { const t = this.t[tag]; return t ? this.b.subarray(t.o, t.o + t.l) : null; }
  // cmap subtables as Maps (key 'pid,eid')
  cmaps() {
    if (this._cm) return this._cm;
    const out = {}, t = this.t.cmap, v = this.v;
    if (!t) return (this._cm = out);
    const n = v.getUint16(t.o + 2);
    for (let i = 0; i < n; i++) {
      const pid = v.getUint16(t.o + 4 + i * 8), eid = v.getUint16(t.o + 6 + i * 8), so = t.o + v.getUint32(t.o + 8 + i * 8);
      const key = pid + ',' + eid;
      if (out[key] || so >= this.b.length) continue;
      try { out[key] = this.cmapSub(so); } catch { /* skip broken subtable */ }
    }
    return (this._cm = out);
  }
  cmapSub(o) {
    const v = this.v, fmt = v.getUint16(o), m = new Map();
    if (fmt === 0) { for (let c = 0; c < 256; c++) m.set(c, this.b[o + 6 + c]); }
    else if (fmt === 4) {
      const segX2 = v.getUint16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = v.getUint16(ends + s), start = v.getUint16(starts + s), delta = v.getInt16(deltas + s), ro = v.getUint16(ranges + s);
        if (start > end) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (!ro) g = (c + delta) & 0xffff;
          else { const a = ranges + s + ro + (c - start) * 2; if (a + 1 >= this.b.length) break; g = v.getUint16(a); if (g) g = (g + delta) & 0xffff; }
          if (g) m.set(c, g);
        }
      }
    } else if (fmt === 6) {
      const first = v.getUint16(o + 6), cnt = v.getUint16(o + 8);
      for (let i = 0; i < cnt; i++) m.set(first + i, v.getUint16(o + 10 + i * 2));
    } else if (fmt === 12) {
      const n = v.getUint32(o + 12);
      for (let i = 0; i < n; i++) {
        const r = o + 16 + i * 12, s = v.getUint32(r), e = v.getUint32(r + 4), g = v.getUint32(r + 8);
        for (let c = s; c <= e && c - s < 65536; c++) m.set(c, g + c - s);
      }
    }
    return m;
  }
  // post table names: Map name -> gid
  postNames() {
    if (this._pn) return this._pn;
    const m = new Map(), t = this.t.post, v = this.v;
    this._pn = m;
    if (!t || v.getUint32(t.o) !== 0x20000) return m;
    try {
      const n = v.getUint16(t.o + 32);
      const idx = []; for (let i = 0; i < n; i++) idx.push(v.getUint16(t.o + 34 + i * 2));
      let p = t.o + 34 + n * 2;
      const custom = [];
      while (p < t.o + t.l) { const l = this.b[p]; let s = ''; for (let i = 1; i <= l; i++) s += String.fromCharCode(this.b[p + i]); custom.push(s); p += l + 1; }
      idx.forEach((k, gid) => { const name = k < 258 ? MAC_GLYPHS[k] : custom[k - 258]; if (name && !m.has(name)) m.set(name, gid); });
    } catch {}
    return m;
  }
  advance(gid) {
    const hh = this.t.hhea, hm = this.t.hmtx;
    if (!hh || !hm) return 0;
    const n = this.v.getUint16(hh.o + 34), i = Math.min(gid, n - 1);
    return (this.v.getUint16(hm.o + i * 4) * 1000) / this.upem;
  }
  glyphPath(gid, depth = 0) {
    if (this.cache.has(gid)) return this.cache.get(gid);
    let p = [];
    try { p = this.readGlyph(gid, depth); } catch { p = []; }
    this.cache.set(gid, p);
    return p;
  }
  readGlyph(gid) {
    const loca = this.t.loca, glyf = this.t.glyf, v = this.v;
    if (!loca || !glyf || gid >= this.numGlyphs + 1) return [];
    const lo = (i) => (this.locaLong ? v.getUint32(loca.o + i * 4) : v.getUint16(loca.o + i * 2) * 2);
    const s = lo(gid), e = lo(gid + 1);
    if (e <= s || s >= glyf.l) return [];
    let o = glyf.o + s;
    const nc = v.getInt16(o);
    o += 10;
    const path = [];
    if (nc >= 0) {
      const ends = []; for (let i = 0; i < nc; i++) ends.push(v.getUint16(o + i * 2));
      o += nc * 2;
      const il = v.getUint16(o); o += 2 + il;
      const np = nc ? ends[nc - 1] + 1 : 0;
      const flags = new Uint8Array(np);
      for (let i = 0; i < np;) { const f = this.b[o++]; flags[i++] = f; if (f & 8) { let r = this.b[o++]; while (r-- > 0 && i < np) flags[i++] = f; } }
      const xs = new Int32Array(np), ys = new Int32Array(np);
      let x = 0;
      for (let i = 0; i < np; i++) { const f = flags[i]; if (f & 2) { const d = this.b[o++]; x += f & 16 ? d : -d; } else if (!(f & 16)) { x += v.getInt16(o); o += 2; } xs[i] = x; }
      let y = 0;
      for (let i = 0; i < np; i++) { const f = flags[i]; if (f & 4) { const d = this.b[o++]; y += f & 32 ? d : -d; } else if (!(f & 32)) { y += v.getInt16(o); o += 2; } ys[i] = y; }
      let st = 0;
      for (const en of ends) {
        const pts = [];
        for (let i = st; i <= en; i++) pts.push([xs[i], ys[i], flags[i] & 1]);
        st = en + 1;
        if (!pts.length) continue;
        contour(pts, path);
      }
      return path;
    }
    // composite
    for (let more = true; more;) {
      const fl = v.getUint16(o), cg = v.getUint16(o + 2); o += 4;
      let dx, dy;
      if (fl & 1) { dx = v.getInt16(o); dy = v.getInt16(o + 2); o += 4; } else { dx = v.getInt8(o); dy = v.getInt8(o + 1); o += 2; }
      if (!(fl & 2)) { dx = 0; dy = 0; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (q) => v.getInt16(q) / 16384;
      if (fl & 8) { a = d = f2(o); o += 2; } else if (fl & 0x40) { a = f2(o); d = f2(o + 2); o += 4; } else if (fl & 0x80) { a = f2(o); b = f2(o + 2); c = f2(o + 4); d = f2(o + 6); o += 8; }
      more = !!(fl & 0x20);
      if (cg === gid) continue;
      const sub = this.glyphPath(cg);
      for (let i = 0; i < sub.length;) {
        const op = sub[i++], n = op === 'M' || op === 'L' ? 1 : op === 'Q' ? 2 : op === 'C' ? 3 : 0;
        path.push(op);
        for (let k = 0; k < n; k++) { const px = sub[i++], py = sub[i++]; path.push(a * px + c * py + dx, b * px + d * py + dy); }
      }
    }
    return path;
  }
}
function contour(pts, path) {
  const n = pts.length;
  let start = pts.findIndex((p) => p[2]);
  let sx, sy;
  if (start < 0) { sx = (pts[0][0] + pts[n - 1][0]) / 2; sy = (pts[0][1] + pts[n - 1][1]) / 2; start = 0; pts = [[sx, sy, 1], ...pts]; }
  else pts = [...pts.slice(start), ...pts.slice(0, start)];
  const m = pts.length;
  path.push('M', pts[0][0], pts[0][1]);
  for (let i = 1; i <= m; i++) {
    const p = pts[i % m];
    if (p[2]) { path.push('L', p[0], p[1]); continue; }
    const q = pts[(i + 1) % m];
    if (q[2]) { path.push('Q', p[0], p[1], q[0], q[1]); i++; }
    else path.push('Q', p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  path.push('Z');
}

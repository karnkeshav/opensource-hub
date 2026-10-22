// CFF (Type1C / CIDFontType0C) reader and Type 2 charstring interpreter -> flat path arrays.
import { STD, encodings, encName } from './glyphs.js';

function index(b, p) {
  const n = (b[p] << 8) | b[p + 1];
  if (!n) return [[], p + 2];
  const os = b[p + 2], offs = [];
  let q = p + 3;
  for (let i = 0; i <= n; i++) { let v = 0; for (let k = 0; k < os; k++) v = v * 256 + b[q++]; offs.push(v); }
  const base = q - 1, items = [];
  for (let i = 0; i < n; i++) items.push(b.subarray(base + offs[i], base + offs[i + 1]));
  return [items, base + offs[n]];
}
function dict(b) {
  const d = {}; let ops = [];
  for (let i = 0; i < b.length;) {
    const v = b[i++];
    if (v <= 21) { let k = v; if (v === 12) k = '12 ' + b[i++]; d[k] = ops; ops = []; }
    else if (v === 28) { ops.push(((b[i] << 24) | (b[i + 1] << 16)) >> 16); i += 2; }
    else if (v === 29) { ops.push((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); i += 4; }
    else if (v === 30) {
      let s = '';
      const nib = '0123456789.EE?-';
      out: for (;;) { const x = b[i++]; for (const n of [x >> 4, x & 15]) { if (n === 15) break out; s += n === 12 ? 'E-' : nib[n]; } }
      ops.push(parseFloat(s));
    } else if (v >= 32 && v <= 246) ops.push(v - 139);
    else if (v >= 247 && v <= 250) ops.push((v - 247) * 256 + b[i++] + 108);
    else if (v >= 251 && v <= 254) ops.push(-(v - 251) * 256 - b[i++] - 108);
  }
  return d;
}
const bias = (n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

export class CFF {
  constructor(b) {
    this.b = b;
    let p = b[2];
    let names, tops, strs, gs;
    [names, p] = index(b, p); [tops, p] = index(b, p); [strs, p] = index(b, p); [gs, p] = index(b, p);
    void names;
    this.strings = strs.map((s) => String.fromCharCode(...s));
    this.gsubrs = gs;
    const top = (this.top = dict(tops[0]));
    this.fm = top['12 7'] || [0.001, 0, 0, 0.001, 0, 0];
    this.cs = index(b, top[17][0])[0];
    this.n = this.cs.length;
    this.cid = !!top['12 30'];
    const priv = (pd) => {
      if (!pd || pd.length < 2) return { subrs: [], nom: 0, def: 0 };
      const [size, off] = pd, d = dict(b.subarray(off, off + size));
      return { subrs: d[19] ? index(b, off + d[19][0])[0] : [], nom: d[21] ? d[21][0] : 0, def: d[20] ? d[20][0] : 0 };
    };
    if (this.cid && top['12 36']) {
      this.fds = index(b, top['12 36'][0])[0].map((x) => priv(dict(x)[18]));
      const fs = top['12 37'][0], fmt = b[fs], sel = new Uint8Array(this.n);
      if (fmt === 0) sel.set(b.subarray(fs + 1, fs + 1 + this.n));
      else if (fmt === 3) {
        const nr = (b[fs + 1] << 8) | b[fs + 2];
        for (let i = 0; i < nr; i++) {
          const r = fs + 3 + i * 3, first = (b[r] << 8) | b[r + 1], fd = b[r + 2], next = (b[r + 3] << 8) | b[r + 4];
          for (let g = first; g < next && g < this.n; g++) sel[g] = fd;
        }
      }
      this.sel = sel;
    } else this.fds = [priv(top[18])];
    // charset
    const cso = top[15] ? top[15][0] : 0, cs = new Array(this.n).fill(0);
    if (cso > 2) {
      const fmt = b[cso]; let q = cso + 1;
      if (fmt === 0) for (let g = 1; g < this.n; g++, q += 2) cs[g] = (b[q] << 8) | b[q + 1];
      else for (let g = 1; g < this.n;) {
        const first = (b[q] << 8) | b[q + 1], left = fmt === 1 ? b[q + 2] : (b[q + 2] << 8) | b[q + 3];
        q += fmt === 1 ? 3 : 4;
        for (let k = 0; k <= left && g < this.n; k++) cs[g++] = first + k;
      }
    } else if (cso === 0) for (let g = 0; g < this.n; g++) cs[g] = g;
    this.charset = cs;
    this.byName = new Map(); this.byCid = new Map();
    cs.forEach((sid, g) => { if (this.cid) this.byCid.set(sid, g); else { const nm = this.name(sid); if (nm && !this.byName.has(nm)) this.byName.set(nm, g); } });
    // built-in encoding (code -> gid)
    this.enc = new Map();
    if (!this.cid) {
      const eo = top[16] ? top[16][0] : 0;
      if (eo > 1) {
        const fmt = b[eo] & 0x7f; let q = eo + 1;
        if (fmt === 0) { const n = b[q++]; for (let g = 1; g <= n; g++) this.enc.set(b[q++], g); }
        else if (fmt === 1) { const n = b[q++]; let g = 1; for (let i = 0; i < n; i++) { const f = b[q++], l = b[q++]; for (let k = 0; k <= l; k++) this.enc.set(f + k, g++); } }
        if (b[eo] & 0x80) { const n = b[q++]; for (let i = 0; i < n; i++) { const c = b[q++], sid = (b[q] << 8) | b[q + 1]; q += 2; const g = this.byName.get(this.name(sid)); if (g !== undefined) this.enc.set(c, g); } }
      } else {
        const std = encodings().StandardEncoding;
        for (let c = 0; c < 256; c++) { const g = this.byName.get(encName(std, c)); if (g) this.enc.set(c, g); }
      }
    }
    this.cache = new Map();
  }
  name(sid) { return sid < 391 ? STD[sid] : this.strings[sid - 391]; }
  glyphPath(gid) {
    if (this.cache.has(gid)) return this.cache.get(gid);
    const path = [];
    if (gid >= 0 && gid < this.n) {
      try { this.t2(gid, path, 0, 0, 0); } catch { /* keep partial */ }
    }
    this.cache.set(gid, path);
    return path;
  }
  width(gid) {
    this.glyphPath(gid);
    return this.widths ? this.widths.get(gid) : undefined;
  }
  t2(gid, path, ox, oy, depth) {
    const fd = this.fds[this.sel ? this.sel[gid] : 0] || this.fds[0];
    const gsubrs = this.gsubrs, subrs = fd.subrs, gb = bias(gsubrs.length), sb = bias(subrs.length);
    const st = [], tr = [];
    let nStems = 0, x = ox, y = oy, open = false, hw = false, w = fd.def;
    const M = (dx, dy) => { if (open) path.push('Z'); x += dx; y += dy; path.push('M', x, y); open = true; };
    const L = (dx, dy) => { x += dx; y += dy; path.push('L', x, y); };
    const Cv = (a, b, c, d, e, f) => { const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; x = x2 + e; y = y2 + f; path.push('C', x1, y1, x2, y2, x, y); };
    const width = (n) => { if (!hw && st.length > n) w = st.shift() + fd.nom; hw = true; };
    const stems = () => { width(st.length & 1 ? st.length - 1 : st.length); nStems += st.length >> 1; st.length = 0; };
    const self = this;
    let done = false;
    function run(c, lvl) {
      if (lvl > 10) return;
      for (let i = 0; i < c.length && !done;) {
        const v = c[i++];
        if (v >= 32) {
          if (v <= 246) st.push(v - 139);
          else if (v <= 250) st.push((v - 247) * 256 + c[i++] + 108);
          else if (v <= 254) st.push(-(v - 251) * 256 - c[i++] - 108);
          else { st.push(((c[i] << 24) | (c[i + 1] << 16) | (c[i + 2] << 8) | c[i + 3]) / 65536); i += 4; }
          continue;
        }
        let j = 0;
        switch (v) {
          case 1: case 3: case 18: case 23: stems(); break;
          case 19: case 20: stems(); i += (nStems + 7) >> 3; break;
          case 21: width(2); M(st[0], st[1]); break;
          case 22: width(1); M(st[0], 0); break;
          case 4: width(1); M(0, st[0]); break;
          case 5: for (; j + 1 < st.length; j += 2) L(st[j], st[j + 1]); break;
          case 6: case 7: { let h = v === 6; for (; j < st.length; j++, h = !h) h ? L(st[j], 0) : L(0, st[j]); break; }
          case 8: for (; j + 5 < st.length; j += 6) Cv(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]); break;
          case 24: for (; j + 7 < st.length; j += 6) Cv(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]); L(st[j], st[j + 1]); break;
          case 25: for (; j + 7 < st.length; j += 2) L(st[j], st[j + 1]); Cv(st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4], st[j + 5]); break;
          case 26: { let d1 = 0; if (st.length & 1) d1 = st[j++]; for (; j + 3 < st.length; j += 4, d1 = 0) Cv(d1, st[j], st[j + 1], st[j + 2], 0, st[j + 3]); break; }
          case 27: { let d1 = 0; if (st.length & 1) d1 = st[j++]; for (; j + 3 < st.length; j += 4, d1 = 0) Cv(st[j], d1, st[j + 1], st[j + 2], st[j + 3], 0); break; }
          case 30: case 31: {
            let h = v === 31;
            while (j + 3 < st.length) {
              const last = st.length - j === 5;
              if (h) Cv(st[j], 0, st[j + 1], st[j + 2], last ? st[j + 4] : 0, st[j + 3]);
              else Cv(0, st[j], st[j + 1], st[j + 2], st[j + 3], last ? st[j + 4] : 0);
              j += last ? 5 : 4; h = !h;
            }
            break;
          }
          case 10: case 29: {
            const idx = st.pop() + (v === 10 ? sb : gb), sub = (v === 10 ? subrs : gsubrs)[idx];
            if (sub) run(sub, lvl + 1);
            continue;
          }
          case 11: return;
          case 14: {
            width(st.length >= 4 ? 4 : 0);
            if (open) { path.push('Z'); open = false; }
            if (st.length >= 4 && depth < 2) {
              const std = encodings().StandardEncoding;
              const bg = self.byName.get(encName(std, st[2])), ag = self.byName.get(encName(std, st[3]));
              if (bg !== undefined) self.t2(bg, path, 0, 0, depth + 1);
              if (ag !== undefined) self.t2(ag, path, st[0], st[1], depth + 1);
            }
            done = true; return;
          }
          case 28: st.push(((c[i] << 24) | (c[i + 1] << 16)) >> 16); i += 2; continue;
          case 12: {
            const e = c[i++], s = st;
            if (e === 34) { Cv(s[0], 0, s[1], s[2], s[3], 0); Cv(s[4], 0, s[5], -s[2], s[6], 0); }
            else if (e === 35) { Cv(s[0], s[1], s[2], s[3], s[4], s[5]); Cv(s[6], s[7], s[8], s[9], s[10], s[11]); }
            else if (e === 36) { Cv(s[0], s[1], s[2], s[3], s[4], 0); Cv(s[5], 0, s[6], s[7], s[8], -(s[1] + s[3] + s[7])); }
            else if (e === 37) {
              let dx = 0, dy = 0; for (let k = 0; k < 10; k += 2) { dx += s[k]; dy += s[k + 1]; }
              Cv(s[0], s[1], s[2], s[3], s[4], s[5]);
              if (Math.abs(dx) > Math.abs(dy)) Cv(s[6], s[7], s[8], s[9], s[10], -dy - s[7] - s[9]); else Cv(s[6], s[7], s[8], s[9], -dx - s[6] - s[8], s[10]);
            } else {
              // arithmetic operators
              const b2 = s.pop(), a2 = s.pop();
              switch (e) {
                case 3: s.push(a2 && b2 ? 1 : 0); continue;
                case 4: s.push(a2 || b2 ? 1 : 0); continue;
                case 5: s.push(a2, b2 ? 0 : 1); continue;
                case 9: s.push(a2, Math.abs(b2)); continue;
                case 10: s.push(a2 + b2); continue;
                case 11: s.push(a2 - b2); continue;
                case 12: s.push(b2 ? a2 / b2 : 0); continue;
                case 14: s.push(a2, -b2); continue;
                case 15: s.push(a2 === b2 ? 1 : 0); continue;
                case 18: s.push(a2); continue;
                case 20: tr[b2] = a2; continue;
                case 21: s.push(a2, tr[b2] || 0); continue;
                case 22: { const c2 = s.pop(), d2 = s.pop(); s.push(a2 <= b2 ? d2 : c2); continue; }
                case 23: s.push(a2, b2, Math.random()); continue;
                case 24: s.push(a2 * b2); continue;
                case 26: s.push(a2, Math.sqrt(b2)); continue;
                case 27: s.push(a2, b2, b2); continue;
                case 28: s.push(b2, a2); continue;
                default: s.length = 0; continue;
              }
            }
            break;
          }
          default: break;
        }
        st.length = 0;
      }
    }
    run(this.cs[gid], 0);
    if (open) path.push('Z');
    if (!depth) { this.widths = this.widths || new Map(); this.widths.set(gid, w); }
  }
}

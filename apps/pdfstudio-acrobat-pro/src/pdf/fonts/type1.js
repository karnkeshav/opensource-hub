// Type 1 font program reader (eexec decryption, Subrs/CharStrings) and Type 1 charstring interpreter.
import { encodings, encName } from './glyphs.js';

const dec = (b, r, skip) => {
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) { const c = b[i]; o[i] = c ^ (r >> 8); r = ((c + r) * 52845 + 22719) & 0xffff; }
  return o.subarray(skip);
};
const latin = (u) => { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; };

export class Type1 {
  constructor(data) {
    if (data[0] === 0x80 && data[1] === 1) { // PFB segments
      const parts = []; let p = 0;
      while (p + 6 <= data.length && data[p] === 0x80 && data[p + 1] !== 3) { const n = data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16) | (data[p + 5] << 24); parts.push(data.subarray(p + 6, p + 6 + n)); p += 6 + n; }
      const t = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { t.set(x, o); o += x.length; }
      data = t;
    }
    const all = latin(data);
    const ex = all.indexOf('eexec');
    const clear = ex >= 0 ? all.slice(0, ex) : all;
    let p = ex + 5;
    while (p < data.length && (data[p] === 13 || data[p] === 10 || data[p] === 32 || data[p] === 9)) p++;
    let enc = data.subarray(p);
    const isHex = (c) => (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 102);
    if (enc.length > 4 && [0, 1, 2, 3].every((i) => isHex(enc[i]))) {
      const h = []; let hi = -1;
      for (const c of enc) { if (!isHex(c)) continue; const v = c <= 57 ? c - 48 : (c | 32) - 87; if (hi < 0) hi = v; else { h.push(hi * 16 + v); hi = -1; } }
      enc = Uint8Array.from(h);
    }
    const priv = ex >= 0 ? latin(dec(enc, 55665, 4)) : '';
    const m = /\/FontMatrix\s*\[([^\]]+)\]/.exec(clear);
    this.fm = m ? m[1].trim().split(/\s+/).map(Number) : [0.001, 0, 0, 0.001, 0, 0];
    if (this.fm.length !== 6 || this.fm.some(isNaN)) this.fm = [0.001, 0, 0, 0.001, 0, 0];
    // Encoding
    this.enc = new Map();
    if (/\/Encoding\s+StandardEncoding/.test(clear)) { const std = encodings().StandardEncoding; for (let c = 0; c < 256; c++) { const n = encName(std, c); if (n) this.enc.set(c, n); } }
    else { const re = /dup\s+(\d+)\s*\/([^\s/\[\]{}()<>]+)\s+put/g; let q; while ((q = re.exec(clear))) this.enc.set(+q[1], q[2]); }
    const liv = /\/lenIV\s+(-?\d+)/.exec(priv);
    const lenIV = liv ? +liv[1] : 4;
    const cs = (s) => { const u = Uint8Array.from(s, (c) => c.charCodeAt(0)); return lenIV < 0 ? u : dec(u, 4330, lenIV); };
    this.subrs = [];
    this.chars = new Map();
    const si = priv.indexOf('/Subrs'), ci = priv.indexOf('/CharStrings');
    if (si >= 0) {
      const re = /dup\s+(\d+)\s+(\d+)\s+(?:RD|-\||\S{1,3})\s/g; re.lastIndex = si;
      let q;
      while ((q = re.exec(priv)) && (ci < si || q.index < ci)) { const st = q.index + q[0].length, n = +q[2]; this.subrs[+q[1]] = cs(priv.substr(st, n)); re.lastIndex = st + n; }
    }
    if (ci >= 0) {
      const re = /\/([^\s/\[\]{}()<>]+)\s+(\d+)\s+(?:RD|-\||\S{1,3})\s/g; re.lastIndex = ci + 12;
      let q;
      while ((q = re.exec(priv))) { const st = q.index + q[0].length, n = +q[2]; if (!this.chars.has(q[1])) this.chars.set(q[1], cs(priv.substr(st, n))); re.lastIndex = st + n; }
    }
    this.cache = new Map(); this.widths = new Map();
  }
  has(name) { return this.chars.has(name); }
  glyphPath(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const path = [];
    try { this.run(name, path, 0, 0, 0); } catch {}
    this.cache.set(name, path);
    return path;
  }
  run(name, path, ox, oy, depth) {
    const code = this.chars.get(name);
    if (!code) return;
    const st = [], ps = [];
    let x = ox, y = oy, flex = null, open = false, done = false;
    const M = (dx, dy) => { x += dx; y += dy; if (flex) { flex.push(x, y); return; } if (open) path.push('Z'); path.push('M', x, y); open = true; };
    const L = (dx, dy) => { x += dx; y += dy; path.push('L', x, y); };
    const Cv = (a, b, c, d, e, f) => { const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; x = x2 + e; y = y2 + f; path.push('C', x1, y1, x2, y2, x, y); };
    const self = this;
    function exec(c, lvl) {
      if (lvl > 10) return;
      for (let i = 0; i < c.length && !done;) {
        const v = c[i++];
        if (v >= 32) {
          if (v <= 246) st.push(v - 139);
          else if (v <= 250) st.push((v - 247) * 256 + c[i++] + 108);
          else if (v <= 254) st.push(-(v - 251) * 256 - c[i++] - 108);
          else { st.push((c[i] << 24) | (c[i + 1] << 16) | (c[i + 2] << 8) | c[i + 3]); i += 4; }
          continue;
        }
        switch (v) {
          case 13: x = ox + st[0]; y = oy; if (!depth) self.widths.set(name, st[1]); break;
          case 21: M(st[0], st[1]); break;
          case 22: M(st[0], 0); break;
          case 4: M(0, st[0]); break;
          case 5: L(st[0], st[1]); break;
          case 6: L(st[0], 0); break;
          case 7: L(0, st[0]); break;
          case 8: Cv(st[0], st[1], st[2], st[3], st[4], st[5]); break;
          case 30: Cv(0, st[0], st[1], st[2], st[3], 0); break;
          case 31: Cv(st[0], 0, st[1], st[2], 0, st[3]); break;
          case 9: if (open) { path.push('Z'); open = false; } break;
          case 10: { const s = self.subrs[st.pop()]; if (s) exec(s, lvl + 1); continue; }
          case 11: return;
          case 14: if (open) { path.push('Z'); open = false; } done = true; return;
          case 12: {
            const e = c[i++];
            if (e === 7) { x = ox + st[0]; y = oy + st[1]; if (!depth) self.widths.set(name, st[2]); }
            else if (e === 6) {
              if (open) { path.push('Z'); open = false; }
              const std = encodings().StandardEncoding, [asb, adx, ady, b, a] = st;
              if (depth < 2) { self.run(encName(std, b), path, 0, 0, depth + 1); self.run(encName(std, a), path, adx - asb, ady, depth + 1); }
              done = true; return;
            } else if (e === 12) { const b = st.pop(), a = st.pop(); st.push(b ? a / b : 0); continue; }
            else if (e === 16) {
              const oth = st.pop(), n = st.pop(), args = st.splice(st.length - n, n);
              if (oth === 1) flex = [];
              else if (oth === 0 && flex) {
                const f = flex; flex = null;
                if (f.length >= 14) {
                  path.push('C', f[2], f[3], f[4], f[5], f[6], f[7], 'C', f[8], f[9], f[10], f[11], f[12], f[13]);
                  x = f[12]; y = f[13];
                }
                ps.length = 0; ps.push(y, x);
              } else if (oth !== 2) { ps.length = 0; ps.push(...args.reverse()); }
              continue;
            } else if (e === 17) { st.push(ps.length ? ps.pop() : 0); continue; }
            else if (e === 33) { x = st[0]; y = st[1]; }
            break;
          }
          default: break;
        }
        st.length = 0;
      }
    }
    exec(code, 0);
    if (open) path.push('Z');
  }
}

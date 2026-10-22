// CMap parser for ToUnicode maps and embedded encoding CMaps (Identity-H/V built in).
import { Lexer, Cmd, EOF } from '../parser.js';
import { Str, Name } from '../obj.js';

const num = (s) => { let v = 0; for (let i = 0; i < s.length; i++) v = v * 256 + s.charCodeAt(i); return v; };
const u16 = (s) => {
  if (s.length === 1) return s;
  let o = ''; for (let i = 0; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return o;
};

export class CMap {
  constructor(identity = false) {
    this.space = identity ? [[2, 0, 0xffff]] : [];
    this.map = new Map(); this.ranges = []; this.identity = identity; this.vertical = false; this.name = '';
  }
  static identity(v) { const c = new CMap(true); c.vertical = !!v; c.name = v ? 'Identity-V' : 'Identity-H'; return c; }
  // kind: 'uni' => values are unicode strings; 'cid' => numbers
  static parse(bytes, kind, resolve) {
    const c = new CMap();
    const lx = new Lexer(bytes);
    const ops = [];
    for (let guard = 0; guard < 2e6; guard++) {
      const t = lx.tok();
      if (t === EOF) break;
      if (t instanceof Cmd) {
        const k = t.c;
        if (k === 'begincodespacerange') {
          for (;;) { const a = lx.tok(); if (!(a instanceof Str)) break; const b = lx.tok(); c.space.push([a.s.length, num(a.s), num(b.s)]); }
        } else if (k === 'beginbfchar' || k === 'begincidchar') {
          for (;;) {
            const a = lx.tok(); if (!(a instanceof Str)) break;
            const b = lx.tok();
            c.set(a.s, kind === 'cid' ? b : b instanceof Str ? u16(b.s) : b instanceof Name ? b.n : '');
          }
        } else if (k === 'beginbfrange' || k === 'begincidrange') {
          for (;;) {
            const a = lx.tok(); if (!(a instanceof Str)) break;
            const b = lx.tok();
            let d = lx.tok();
            if (d instanceof Cmd && d.c === '[') { d = []; for (;;) { const x = lx.tok(); if (!(x instanceof Str)) break; d.push(u16(x.s)); } }
            const lo = num(a.s), hi = num(b.s), n = a.s.length;
            if (hi < lo) continue;
            if (Array.isArray(d)) { for (let i = 0; i <= hi - lo && i < d.length; i++) c.map.set(n * 0x1000000 + lo + i, d[i]); }
            else if (kind === 'cid') { if (hi - lo > 512) c.ranges.push([n, lo, hi, d]); else for (let i = lo; i <= hi; i++) c.map.set(n * 0x1000000 + i, d + i - lo); }
            else if (d instanceof Str) {
              const base = u16(d.s);
              if (hi - lo > 512) c.ranges.push([n, lo, hi, base]);
              else for (let i = lo; i <= hi; i++) c.map.set(n * 0x1000000 + i, inc(base, i - lo));
            }
          }
        } else if (k === 'usecmap' && resolve) {
          const nm = ops[ops.length - 1];
          const p = nm instanceof Name ? resolve(nm.n) : null;
          if (p) { c.space.push(...p.space); for (const [x, y] of p.map) if (!c.map.has(x)) c.map.set(x, y); c.ranges.push(...p.ranges); if (p.identity) c.identity = true; }
        }
        ops.length = 0;
      } else {
        ops.push(t);
        if (t instanceof Name && t.n === 'WMode') { const v = lx.tok(); if (v === 1) c.vertical = true; }
        if (t instanceof Name && t.n === 'CMapName') { const v = lx.tok(); if (v instanceof Name) c.name = v.n; }
      }
    }
    return c;
  }
  set(codeStr, v) { this.map.set(codeStr.length * 0x1000000 + num(codeStr), v); }
  // Read one code from binary string s at i. Returns [code, nbytes].
  read(s, i) {
    if (!this.space.length) return [s.charCodeAt(i), 1];
    let code = 0;
    for (let n = 1; n <= 4 && i + n <= s.length; n++) {
      code = code * 256 + s.charCodeAt(i + n - 1);
      for (const [len, lo, hi] of this.space) if (len === n && code >= lo && code <= hi) return [code, n];
    }
    // No range matched: use the shortest declared length
    const n = Math.min(...this.space.map((r) => r[0]), s.length - i);
    let c2 = 0; for (let k = 0; k < n; k++) c2 = c2 * 256 + s.charCodeAt(i + k);
    return [c2, Math.max(1, n)];
  }
  get(code, n) {
    const v = this.map.get(n * 0x1000000 + code);
    if (v !== undefined) return v;
    for (const [len, lo, hi, d] of this.ranges) if (len === n && code >= lo && code <= hi) return typeof d === 'number' ? d + code - lo : inc(d, code - lo);
    if (this.identity) return code;
    for (let k = 1; k <= 4; k++) { const w = k !== n && this.map.get(k * 0x1000000 + code); if (w !== undefined && w !== false) return w; }
    return undefined;
  }
}
function inc(s, k) {
  if (!k) return s;
  const last = s.charCodeAt(s.length - 1) + k;
  return s.slice(0, -1) + String.fromCharCode(last & 0xffff);
}

// Tokenizer and object parser over a Uint8Array.
import { N, Name, Ref, Dict, Str } from './obj.js';

export class Cmd { constructor(c) { this.c = c; } toString() { return this.c; } }
const CMDS = new Map();
export const C = (c) => { let v = CMDS.get(c); if (!v) CMDS.set(c, v = new Cmd(c)); return v; };
export const EOF = C('%EOF%');

const WS = new Uint8Array(256), DL = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
for (const c of '()<>[]{}/%') DL[c.charCodeAt(0)] = 1;
export const isWS = (c) => WS[c] === 1;
const hexv = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
const K_ARR = C('['), K_ARE = C(']'), K_DIC = C('<<'), K_DIE = C('>>'), K_R = C('R'), K_T = C('true'), K_F = C('false'), K_NULL = C('null');

export class Lexer {
  constructor(b, p = 0, end = b.length) { this.b = b; this.p = p; this.end = end; }
  skip() {
    const b = this.b, e = this.end;
    for (;;) {
      while (this.p < e && WS[b[this.p]]) this.p++;
      if (this.p < e && b[this.p] === 37) { while (this.p < e && b[this.p] !== 10 && b[this.p] !== 13) this.p++; } else return;
    }
  }
  tok() {
    this.skip();
    const b = this.b, e = this.end;
    if (this.p >= e) return EOF;
    const c = b[this.p];
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) return this.num();
    switch (c) {
      case 47: return this.name();
      case 40: return this.lit();
      case 60:
        if (b[this.p + 1] === 60) { this.p += 2; return K_DIC; }
        return this.hex();
      case 62: if (b[this.p + 1] === 62) { this.p += 2; return K_DIE; } this.p++; return C('>');
      case 91: this.p++; return K_ARR;
      case 93: this.p++; return K_ARE;
      case 123: this.p++; return C('{');
      case 125: this.p++; return C('}');
      case 41: this.p++; return C(')');
    }
    const s = this.p;
    while (this.p < e && !WS[b[this.p]] && !DL[b[this.p]]) this.p++;
    if (this.p === s) { this.p++; return C(String.fromCharCode(c)); }
    let w = ''; for (let i = s; i < this.p; i++) w += String.fromCharCode(b[i]);
    return C(w);
  }
  num() {
    const b = this.b, e = this.end;
    let neg = false, v = 0, frac = 0, div = 1, seen = false;
    while (b[this.p] === 45 || b[this.p] === 43) { if (b[this.p] === 45) neg = !neg; this.p++; }
    for (; this.p < e; this.p++) {
      const c = b[this.p];
      if (c >= 48 && c <= 57) { seen = true; if (frac) { div *= 10; v += (c - 48) / div; } else v = v * 10 + c - 48; }
      else if (c === 46 && !frac) frac = 1;
      else if (c === 45 || c === 46) continue; // tolerate junk like 1.2.3 or 4-5
      else break;
    }
    if (!seen && this.p < e && !WS[b[this.p]] && !DL[b[this.p]]) { // a keyword starting with a sign or dot
      while (this.p < e && !WS[b[this.p]] && !DL[b[this.p]]) this.p++;
      return 0;
    }
    return neg ? -v : v;
  }
  name() {
    const b = this.b, e = this.end;
    this.p++;
    let s = '';
    while (this.p < e) {
      const c = b[this.p];
      if (WS[c] || DL[c]) break;
      if (c === 35 && hexv(b[this.p + 1]) >= 0 && hexv(b[this.p + 2]) >= 0) { s += String.fromCharCode(hexv(b[this.p + 1]) * 16 + hexv(b[this.p + 2])); this.p += 3; }
      else { s += String.fromCharCode(c); this.p++; }
    }
    return N(s);
  }
  lit() {
    const b = this.b, e = this.end, out = [];
    let depth = 1; this.p++;
    while (this.p < e) {
      let c = b[this.p++];
      if (c === 40) depth++;
      else if (c === 41) { if (--depth === 0) break; }
      else if (c === 92) {
        c = b[this.p++];
        switch (c) {
          case 110: c = 10; break; case 114: c = 13; break; case 116: c = 9; break; case 98: c = 8; break; case 102: c = 12; break;
          case 13: if (b[this.p] === 10) this.p++; continue;
          case 10: continue;
          default:
            if (c >= 48 && c <= 55) {
              let v = c - 48;
              for (let k = 0; k < 2 && b[this.p] >= 48 && b[this.p] <= 55; k++) v = v * 8 + b[this.p++] - 48;
              c = v & 255;
            }
        }
      } else if (c === 13) { if (b[this.p] === 10) this.p++; c = 10; }
      out.push(c);
    }
    let s = ''; for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode.apply(null, out.slice(i, i + 8192));
    return new Str(s);
  }
  hex() {
    const b = this.b, e = this.end;
    this.p++;
    let s = '', hi = -1;
    while (this.p < e) {
      const c = b[this.p++];
      if (c === 62) break;
      const v = hexv(c);
      if (v < 0) continue;
      if (hi < 0) hi = v; else { s += String.fromCharCode(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) s += String.fromCharCode(hi * 16);
    return new Str(s, true);
  }
}

// Parse one object. resolveLen(ref) is used by streams with indirect /Length (handled in doc.js).
export function parseObj(lx, t = lx.tok(), depth = 0) {
  if (typeof t === 'number') {
    if (Number.isInteger(t) && t >= 0) {
      const save = lx.p;
      lx.skip();
      const c = lx.b[lx.p];
      if (c >= 48 && c <= 57) {
        const g = lx.num();
        lx.skip();
        if (lx.b[lx.p] === 82 && (lx.p + 1 >= lx.end || WS[lx.b[lx.p + 1]] || DL[lx.b[lx.p + 1]])) { lx.p++; return new Ref(t, g); }
      }
      lx.p = save;
    }
    return t;
  }
  if (depth > 200) return null;
  if (t === K_ARR) {
    const a = [];
    for (;;) {
      const x = lx.tok();
      if (x === K_ARE || x === EOF) break;
      if (x === K_DIE) { lx.p -= 2; break; }
      a.push(parseObj(lx, x, depth + 1));
    }
    return a;
  }
  if (t === K_DIC) {
    const d = new Dict();
    for (;;) {
      const k = lx.tok();
      if (k === K_DIE || k === EOF) break;
      if (!(k instanceof Name)) { if (k === K_ARE) continue; if (k instanceof Cmd && (k.c === 'stream' || k.c === 'endobj')) { lx.p -= k.c.length; break; } continue; }
      const v = lx.tok();
      if (v === K_DIE) { d.set(k.n, null); break; }
      const val = parseObj(lx, v, depth + 1);
      if (val !== null && val !== K_NULL) d.set(k.n, val);
    }
    return d;
  }
  if (t === K_T) return true;
  if (t === K_F) return false;
  if (t === K_NULL) return null;
  return t;
}

export function findBack(b, s, from = b.length, limit = 0) {
  const n = s.length;
  outer: for (let i = Math.min(from, b.length) - n; i >= limit; i--) {
    for (let j = 0; j < n; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
export function findFwd(b, s, from = 0, limit = b.length) {
  const n = s.length, c0 = s.charCodeAt(0);
  outer: for (let i = from; i <= limit - n; i++) {
    if (b[i] !== c0) continue;
    for (let j = 1; j < n; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

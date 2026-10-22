// Standard security handler (PDF 32000 7.6.3/7.6.4 and ISO 32000-2 R6): RC4 40-128, AES-128, AES-256.
import { md5, rc4, AES, aesDecrypt, aesEncrypt, sha256, digest, randomBytes } from './crypto.js';
import { Dict, N, Str, Name, bin, bytes, concat, utf8 } from './obj.js';

const PAD = bytes('\x28\xBF\x4E\x5E\x4E\x75\x8A\x41\x64\x00\x4E\x56\xFF\xFA\x01\x08\x2E\x2E\x00\xB6\xD0\x68\x3E\x80\x2F\x0C\xA9\xFE\x64\x53\x69\x7A');
const pad32 = (p) => { const o = new Uint8Array(32); o.set(p.subarray(0, 32)); o.set(PAD.subarray(0, 32 - Math.min(32, p.length)), Math.min(32, p.length)); return o; };
const le32 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
const eq = (a, b, n = a.length) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
const zero16 = new Uint8Array(16);

async function hash6(pwd, salt, udata, R) {
  let K = sha256(concat([pwd, salt, udata]));
  if (R < 6) return K;
  for (let i = 0; ; i++) {
    const unit = concat([pwd, K, udata]), K1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) K1.set(unit, j * unit.length);
    const E = new AES(K.subarray(0, 16)).cbc(K1, K.subarray(16, 32), 0);
    let s = 0; for (let j = 0; j < 16; j++) s += E[j];
    const m = s % 3;
    K = m === 0 ? sha256(E) : await digest(m === 1 ? 'SHA-384' : 'SHA-512', E);
    if (i >= 63 && E[E.length - 1] <= i - 31) break;
  }
  return K.subarray(0, 32);
}

export class Security {
  // Returns a Security instance or null if the password is wrong. Throws for unsupported handlers.
  static async open(enc, id0, password, get) {
    const g = (k) => get(enc.get(k));
    if (g('Filter') && g('Filter').n !== 'Standard') throw new Error('Unsupported security handler: ' + g('Filter').n);
    const s = new Security();
    s.V = g('V') || 0; s.R = g('R') || 2; s.P = g('P') | 0; s.O = bytes(g('O')?.s || ''); s.U = bytes(g('U')?.s || '');
    s.encMeta = g('EncryptMetadata') !== false; s.id0 = bytes(id0 || '');
    let len = (g('Length') || 40) / 8;
    s.stm = s.str = s.V >= 4 ? 'V2' : 'V2';
    if (s.V >= 4) {
      const cf = g('CF') instanceof Dict ? g('CF') : new Dict();
      const meth = (name) => {
        if (!name || name.n === 'Identity') return 'Identity';
        const f = get(cf.get(name.n));
        const m = f instanceof Dict ? get(f.get('CFM'))?.n : 'V2';
        if (f instanceof Dict && get(f.get('Length'))) { const l = get(f.get('Length')); len = l > 32 ? l / 8 : l; }
        return m === 'None' ? 'Identity' : m || 'V2';
      };
      s.stm = meth(g('StmF')); s.str = meth(g('StrF'));
    }
    s.len = Math.min(16, Math.max(5, len | 0));
    const pw = typeof password === 'string' ? password : '';
    if (s.R >= 5) {
      const p = utf8(pw).subarray(0, 127);
      const OE = bytes(g('OE')?.s || ''), UE = bytes(g('UE')?.s || '');
      const U48 = s.U.subarray(0, 48);
      if (eq(await hash6(p, s.O.subarray(32, 40), U48, s.R), s.O, 32)) { s.key = new AES(await hash6(p, s.O.subarray(40, 48), U48, s.R)).cbc(OE, zero16, 1); s.owner = true; }
      else if (eq(await hash6(p, s.U.subarray(32, 40), new Uint8Array(0), s.R), s.U, 32)) s.key = new AES(await hash6(p, s.U.subarray(40, 48), new Uint8Array(0), s.R)).cbc(UE, zero16, 1);
      else return null;
      s.stm = s.stm === 'Identity' ? 'Identity' : 'AESV3'; s.str = s.str === 'Identity' ? 'Identity' : 'AESV3';
      return s;
    }
    const pb = bytes(pw);
    let key = s.userKey(pb);
    if (key) return (s.key = key), s;
    // Owner password: recover the user password from /O.
    let h = md5(pad32(pb));
    if (s.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, s.len));
    const ok = h.subarray(0, s.len);
    let u = s.O.subarray(0, 32);
    if (s.R === 2) u = rc4(ok, u);
    else for (let i = 19; i >= 0; i--) u = rc4(ok.map((b) => b ^ i), u);
    key = s.userKey(u);
    if (key) { s.key = key; s.owner = true; return s; }
    return null;
  }
  userKey(pb) {
    const parts = [pad32(pb), this.O.subarray(0, 32), le32(this.P), this.id0];
    if (this.R >= 4 && !this.encMeta) parts.push(Uint8Array.of(255, 255, 255, 255));
    let h = md5(concat(parts));
    if (this.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, this.len));
    const key = h.subarray(0, this.len);
    if (this.R === 2) return eq(rc4(key, PAD), this.U, 32) ? key : null;
    let x = rc4(key, md5(concat([PAD, this.id0])));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return eq(x, this.U, 16) ? key : null;
  }
  objKey(num, gen, aes) {
    if (this.R >= 5) return this.key;
    const k = concat([this.key, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255), aes ? bytes('sAlT') : new Uint8Array(0)]);
    return md5(k).subarray(0, Math.min(16, this.key.length + 5));
  }
  crypt(num, gen, data, isStr, dir) {
    const m = isStr ? this.str : this.stm;
    if (m === 'Identity') return data;
    if (m === 'AESV2' || m === 'AESV3') { const k = this.objKey(num, gen, m === 'AESV2'); return dir ? aesEncrypt(k, data) : aesDecrypt(k, data); }
    return rc4(this.objKey(num, gen, false), data);
  }
  decrypt(num, gen, data, isStr) { return this.crypt(num, gen, data, isStr, 0); }
  encrypt(num, gen, data, isStr) { return this.crypt(num, gen, data, isStr, 1); }
  get permissions() { return permsFromP(this.P); }
}

export const PERMS = [['print', 3], ['modify', 4], ['copy', 5], ['annotate', 6], ['fillForms', 9], ['accessibility', 10], ['assemble', 11], ['printHigh', 12]];
export const permsFromP = (P) => Object.fromEntries(PERMS.map(([k, b]) => [k, !!(P & (1 << (b - 1)))]));
export const pFromPerms = (o) => { let p = 0xfffff0c0 | 0; for (const [k, b] of PERMS) if (o[k] !== false) p |= 1 << (b - 1); return p | 0; };

// Create an AES-256 (R6) security handler and its /Encrypt dictionary.
export async function newAES256(userPw, ownerPw, perms = {}) {
  const s = new Security();
  s.V = 5; s.R = 6; s.P = pFromPerms(perms); s.encMeta = true; s.stm = s.str = 'AESV3';
  s.key = randomBytes(32);
  const up = utf8(userPw || '').subarray(0, 127), op = utf8(ownerPw || userPw || bin(randomBytes(16))).subarray(0, 127);
  const uv = randomBytes(8), uk = randomBytes(8), ov = randomBytes(8), ok = randomBytes(8);
  const U = concat([await hash6(up, uv, new Uint8Array(0), 6), uv, uk]);
  const UE = new AES(await hash6(up, uk, new Uint8Array(0), 6)).cbc(s.key, zero16, 0);
  const O = concat([await hash6(op, ov, U, 6), ov, ok]);
  const OE = new AES(await hash6(op, ok, U, 6)).cbc(s.key, zero16, 0);
  const pb = concat([le32(s.P), Uint8Array.of(255, 255, 255, 255, 84, 97, 100, 98), randomBytes(4)]);
  const Perms = new AES(s.key).cbc(pb, zero16, 0);
  s.O = O; s.U = U;
  const S = (u) => new Str(bin(u), true);
  s.dict = new Dict({
    Filter: N('Standard'), V: 5, R: 6, Length: 256, P: s.P, O: S(O), U: S(U), OE: S(OE), UE: S(UE), Perms: S(Perms),
    CF: new Dict({ StdCF: new Dict({ AuthEvent: N('DocOpen'), CFM: N('AESV3'), Length: 32 }) }), StmF: N('StdCF'), StrF: N('StdCF'),
  });
  return s;
}
export const isNameObj = (v) => v instanceof Name;

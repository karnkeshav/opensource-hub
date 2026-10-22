// Small synchronous crypto primitives: MD5, RC4, AES (CBC/ECB), SHA-256. SHA-384/512 come from WebCrypto.
export function md5(u8) {
  const K = [], S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const n = u8.length, len = (((n + 8) >>> 6) + 1) << 6, m = new Uint8Array(len);
  m.set(u8); m[n] = 0x80;
  const bits = n * 8; m[len - 8] = bits & 255; m[len - 7] = (bits >>> 8) & 255; m[len - 6] = (bits >>> 16) & 255; m[len - 5] = (bits >>> 24) & 255; m[len - 4] = (n / 0x20000000) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) M[i] = m[o + i * 4] | (m[o + i * 4 + 1] << 8) | (m[o + i * 4 + 2] << 16) | (m[o + i * 4 + 3] << 24);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; } else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d; d = c; c = b;
      const x = (a + f + K[i] + M[g]) | 0, s = S[((i >> 4) << 2) | (i & 3)];
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0; a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++) out[i * 4 + k] = (v >>> (8 * k)) & 255; });
  return out;
}

export function rc4(key, data) {
  const s = new Uint8Array(256), out = new Uint8Array(data.length);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// AES (table-driven, after SJCL's compact formulation)
let TAB;
function tables() {
  if (TAB) return TAB;
  const enc = [[], [], [], [], []], dec = [[], [], [], [], []], sbox = enc[4], sinv = dec[4], d = [], th = [];
  for (let i = 0; i < 256; i++) th[(d[i] = (i << 1) ^ ((i >> 7) * 283)) ^ i] = i;
  for (let x = 0, x2, x4, x8, xi = 0; !sbox[x]; x ^= x2 || 1, xi = th[xi] || 1) {
    let s = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4);
    s = (s >> 8) ^ (s & 255) ^ 99;
    sbox[x] = s; sinv[s] = x;
    x8 = d[(x4 = d[(x2 = d[x])])];
    let td = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100), te = (d[s] * 0x101) ^ (s * 0x1010100);
    for (let i = 0; i < 4; i++) { enc[i][x] = te = (te << 24) ^ (te >>> 8); dec[i][s] = td = (td << 24) ^ (td >>> 8); }
  }
  return (TAB = [enc, dec]);
}
export class AES {
  constructor(key) {
    const [enc, dec] = tables(), sbox = enc[4], kl = key.length / 4, ek = [], dk = [];
    for (let i = 0; i < kl; i++) ek[i] = (key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3];
    let i, rcon = 1;
    for (i = kl; i < 4 * kl + 28; i++) {
      let t = ek[i - 1];
      if (i % kl === 0 || (kl === 8 && i % kl === 4)) {
        t = (sbox[t >>> 24] << 24) ^ (sbox[(t >> 16) & 255] << 16) ^ (sbox[(t >> 8) & 255] << 8) ^ sbox[t & 255];
        if (i % kl === 0) { t = (t << 8) ^ (t >>> 24) ^ (rcon << 24); rcon = (rcon << 1) ^ ((rcon >> 7) * 283); }
      }
      ek[i] = ek[i - kl] ^ t;
    }
    for (let j = 0; i; j++, i--) {
      const t = ek[j & 3 ? i : i - 4];
      dk[j] = i <= 4 || j < 4 ? t : dec[0][sbox[t >>> 24]] ^ dec[1][sbox[(t >> 16) & 255]] ^ dec[2][sbox[(t >> 8) & 255]] ^ dec[3][sbox[t & 255]];
    }
    this.k = [ek, dk]; this.t = [enc, dec];
  }
  block(inp, dir) {
    const key = this.k[dir], [t0, t1, t2, t3, sbox] = this.t[dir];
    let a = inp[0] ^ key[0], b = inp[dir ? 3 : 1] ^ key[1], c = inp[2] ^ key[2], d = inp[dir ? 1 : 3] ^ key[3], ki = 4, a2, b2, c2;
    const nr = key.length / 4 - 2, out = [0, 0, 0, 0];
    for (let i = 0; i < nr; i++) {
      a2 = t0[a >>> 24] ^ t1[(b >> 16) & 255] ^ t2[(c >> 8) & 255] ^ t3[d & 255] ^ key[ki];
      b2 = t0[b >>> 24] ^ t1[(c >> 16) & 255] ^ t2[(d >> 8) & 255] ^ t3[a & 255] ^ key[ki + 1];
      c2 = t0[c >>> 24] ^ t1[(d >> 16) & 255] ^ t2[(a >> 8) & 255] ^ t3[b & 255] ^ key[ki + 2];
      d = t0[d >>> 24] ^ t1[(a >> 16) & 255] ^ t2[(b >> 8) & 255] ^ t3[c & 255] ^ key[ki + 3];
      ki += 4; a = a2; b = b2; c = c2;
    }
    for (let i = 0; i < 4; i++) {
      out[dir ? 3 & -i : i] = (sbox[a >>> 24] << 24) ^ (sbox[(b >> 16) & 255] << 16) ^ (sbox[(c >> 8) & 255] << 8) ^ sbox[d & 255] ^ key[ki++];
      a2 = a; a = b; b = c; c = d; d = a2;
    }
    return out;
  }
  // CBC over whole blocks. iv: Uint8Array(16). dir 0 = encrypt, 1 = decrypt.
  cbc(data, iv, dir) {
    const out = new Uint8Array(data.length), w = (u, o) => [(u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3], (u[o + 4] << 24) | (u[o + 5] << 16) | (u[o + 6] << 8) | u[o + 7], (u[o + 8] << 24) | (u[o + 9] << 16) | (u[o + 10] << 8) | u[o + 11], (u[o + 12] << 24) | (u[o + 13] << 16) | (u[o + 14] << 8) | u[o + 15]];
    let prev = w(iv, 0);
    for (let o = 0; o + 16 <= data.length; o += 16) {
      const x = w(data, o);
      let r;
      if (dir) { r = this.block(x, 1); for (let i = 0; i < 4; i++) r[i] ^= prev[i]; prev = x; }
      else { for (let i = 0; i < 4; i++) x[i] ^= prev[i]; r = prev = this.block(x, 0); }
      for (let i = 0; i < 4; i++) { out[o + i * 4] = r[i] >>> 24; out[o + i * 4 + 1] = (r[i] >> 16) & 255; out[o + i * 4 + 2] = (r[i] >> 8) & 255; out[o + i * 4 + 3] = r[i] & 255; }
    }
    return out;
  }
}
export function aesDecrypt(key, data) { // IV-prefixed, PKCS#7 padded
  if (data.length < 32) return data.length === 16 ? new Uint8Array(0) : data;
  const body = data.subarray(16, 16 + ((data.length - 16) & ~15));
  const out = new AES(key).cbc(body, data.subarray(0, 16), 1);
  const pad = out[out.length - 1];
  return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}
export function aesEncrypt(key, data, iv = randomBytes(16)) {
  const pad = 16 - (data.length % 16), p = new Uint8Array(data.length + pad);
  p.set(data); p.fill(pad, data.length);
  const out = new Uint8Array(16 + p.length);
  out.set(iv); out.set(new AES(key).cbc(p, iv, 0), 16);
  return out;
}
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function sha256(u8) {
  const K = [], H = [];
  const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0;
  for (let n = 2, c = 0; c < 64; n++) {
    let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; }
    if (p) { if (c < 8) H[c] = frac(Math.pow(n, 1 / 2)); K[c++] = frac(Math.pow(n, 1 / 3)); }
  }
  const n = u8.length, len = (((n + 8) >>> 6) + 1) << 6, m = new Uint8Array(len);
  m.set(u8); m[n] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(len - 4, n * 8); dv.setUint32(len - 8, Math.floor(n / 0x20000000));
  const W = new Int32Array(64);
  const r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getInt32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = (W[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + W[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  H.forEach((v, i) => ov.setInt32(i * 4, v));
  return out;
}
export const digest = async (alg, u8) => new Uint8Array(await crypto.subtle.digest(alg, u8));

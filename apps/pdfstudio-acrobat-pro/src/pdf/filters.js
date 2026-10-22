// Stream filters: synchronous inflate (own implementation), LZW, ASCIIHex, ASCII85, RunLength, PNG/TIFF predictors.
// Image-only codecs (DCT, JPX, JBIG2, CCITT) are left to the image decoder.
import { Dict, Name, Stream } from './obj.js';
import { ccittDecode } from './ccitt.js';

const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLO = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function table(lens, n) {
  let max = 0;
  for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
  const size = 1 << max, tab = new Int32Array(size);
  let code = 0;
  for (let len = 1; len <= max; len++) {
    for (let s = 0; s < n; s++) {
      if (lens[s] !== len) continue;
      let r = 0; for (let i = 0; i < len; i++) r |= ((code >> i) & 1) << (len - 1 - i);
      for (let k = r; k < size; k += 1 << len) tab[k] = (s << 4) | len;
      code++;
    }
    code <<= 1;
  }
  return { tab, max, mask: size - 1 };
}
let FIXED;
export function inflate(src) {
  let p = 0;
  if (src.length > 2 && (src[0] & 15) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) p = 2;
  let out = new Uint8Array(Math.max(4096, src.length * 4)), o = 0, bb = 0, bc = 0;
  const end = src.length;
  const need = (n) => { while (bc < n) { if (p >= end + 4) throw 0; bb |= (p < end ? src[p] : 0) << bc; p++; bc += 8; } };
  const bits = (n) => { need(n); const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
  const grow = (n) => { if (o + n > out.length) { const t = new Uint8Array(Math.max(out.length * 2, o + n)); t.set(out.subarray(0, o)); out = t; } };
  const sym = (t) => {
    need(t.max);
    const e = t.tab[bb & t.mask], l = e & 15;
    if (!l) throw 0;
    bb >>>= l; bc -= l;
    return e >> 4;
  };
  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        const drop = bc & 7; bb >>>= drop; bc -= drop;
        p -= bc >> 3; bb = 0; bc = 0;
        if (p + 4 > end) break;
        const len = src[p] | (src[p + 1] << 8); p += 4;
        const n = Math.min(len, end - p);
        grow(n); out.set(src.subarray(p, p + n), o); o += n; p += n;
        continue;
      }
      let lt, dt;
      if (type === 1) {
        if (!FIXED) {
          const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          FIXED = [table(l, 288), table(new Uint8Array(30).fill(5), 30)];
        }
        [lt, dt] = FIXED;
      } else if (type === 2) {
        const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hc; i++) cl[CLO[i]] = bits(3);
        const ct = table(cl, 19), lens = new Uint8Array(hl + hd);
        for (let i = 0; i < hl + hd;) {
          const s = sym(ct);
          if (s < 16) lens[i++] = s;
          else {
            let r, v = 0;
            if (s === 16) { if (!i) throw 0; v = lens[i - 1]; r = 3 + bits(2); } else if (s === 17) r = 3 + bits(3); else r = 11 + bits(7);
            while (r-- && i < hl + hd) lens[i++] = v;
          }
        }
        lt = table(lens.subarray(0, hl), hl); dt = table(lens.subarray(hl), hd);
      } else throw 0;
      for (;;) {
        const s = sym(lt);
        if (s < 256) { if (o >= out.length) grow(1); out[o++] = s; continue; }
        if (s === 256) break;
        const li = s - 257; if (li >= 29) throw 0;
        const len = LB[li] + bits(LE[li]);
        const di = sym(dt); if (di >= 30) throw 0;
        const dist = DB[di] + bits(DE[di]);
        if (dist > o) throw 0;
        grow(len);
        for (let i = 0; i < len; i++, o++) out[o] = out[o - dist];
      }
    }
  } catch (e) { if (e !== 0 && !(e instanceof RangeError)) throw e; }
  return out.subarray(0, o);
}

export async function deflate(u8) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

function lzw(src, early = 1) {
  let out = new Uint8Array(src.length * 3 + 64), o = 0;
  const dict = [];
  const reset = () => { dict.length = 258; for (let i = 0; i < 256; i++) dict[i] = [i]; };
  reset();
  let bb = 0, bc = 0, p = 0, w = 9, prev = null;
  const put = (seq) => { if (o + seq.length > out.length) { const t = new Uint8Array((o + seq.length) * 2); t.set(out); out = t; } for (const c of seq) out[o++] = c; };
  while (p < src.length || bc >= w) {
    while (bc < w && p < src.length) { bb = (bb << 8) | src[p++]; bc += 8; }
    if (bc < w) break;
    const code = (bb >>> (bc - w)) & ((1 << w) - 1); bc -= w;
    if (code === 256) { reset(); w = 9; prev = null; continue; }
    if (code === 257) break;
    let seq;
    if (code < dict.length) seq = dict[code];
    else if (prev) seq = prev.concat(prev[0]);
    else break;
    put(seq);
    if (prev) dict.push(prev.concat(seq[0]));
    prev = seq;
    const n = dict.length + early;
    w = n >= 2048 ? 12 : n >= 1024 ? 11 : n >= 512 ? 10 : 9;
  }
  return out.subarray(0, o);
}

function ahx(src) {
  const out = []; let hi = -1;
  for (const c of src) {
    if (c === 62) break;
    const v = c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}
export function a85(src) {
  const out = []; const g = []; let i = 0;
  if (src[0] === 60 && src[1] === 126) i = 2;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === 126) break;
    if (c === 122 && g.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 33 || c > 117) continue;
    g.push(c - 33);
    if (g.length === 5) { let v = 0; for (const x of g) v = v * 85 + x; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); g.length = 0; }
  }
  if (g.length > 1) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const x of g) v = v * 85 + x; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
  return Uint8Array.from(out);
}
function rle(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const n = src[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n && i < src.length; k++) out.push(src[i++]); }
    else { const b = src[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
  }
  return Uint8Array.from(out);
}

function predict(data, prm, get) {
  const pred = get(prm.get('Predictor')) || 1;
  if (pred < 2) return data;
  const colors = get(prm.get('Colors')) || 1, bpc = get(prm.get('BitsPerComponent')) || 8, cols = get(prm.get('Columns')) || 1;
  const bpp = Math.max(1, (colors * bpc) >> 3), row = (colors * bpc * cols + 7) >> 3;
  if (pred === 2) {
    const out = new Uint8Array(data);
    if (bpc === 8) for (let r = 0; r + row <= out.length; r += row) for (let i = r + colors; i < r + row; i++) out[i] = (out[i] + out[i - colors]) & 255;
    else if (bpc === 16) for (let r = 0; r + row <= out.length; r += row) for (let i = r + 2 * colors; i + 1 < r + row; i += 2) { const v = ((out[i] << 8) | out[i + 1]) + ((out[i - 2 * colors] << 8) | out[i - 2 * colors + 1]); out[i] = (v >> 8) & 255; out[i + 1] = v & 255; }
    return out;
  }
  const rows = Math.floor(data.length / (row + 1)), out = new Uint8Array(rows * row);
  let prev = new Uint8Array(row);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (row + 1)], src = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1)), cur = out.subarray(r * row, (r + 1) * row);
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}

export const IMAGE_FILTERS = { DCTDecode: 1, DCT: 1, JPXDecode: 1, JBIG2Decode: 1 };
const ALIAS = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' };
// Decode a stream's data. Returns { data, image: filterName|undefined, params }.
// `get` resolves indirect references (doc.get).
export function decodeFull(stream, get = (x) => x) {
  const d = stream.dict;
  let fl = get(d.get('Filter') ?? d.get('F')), pr = get(d.get('DecodeParms') ?? d.get('DP'));
  if (!fl) return { data: stream.data };
  if (!Array.isArray(fl)) { fl = [fl]; pr = [pr]; }
  if (!Array.isArray(pr)) pr = [pr];
  let data = stream.data;
  for (let i = 0; i < fl.length; i++) {
    const f = get(fl[i]);
    const n = f instanceof Name ? ALIAS[f.n] || f.n : '';
    const prm = get(pr[i]) instanceof Dict ? get(pr[i]) : new Dict();
    if (n === 'FlateDecode') data = predict(inflate(data), prm, get);
    else if (n === 'LZWDecode') { const ec = get(prm.get('EarlyChange')); data = predict(lzw(data, ec === 0 ? 0 : 1), prm, get); }
    else if (n === 'ASCIIHexDecode') data = ahx(data);
    else if (n === 'ASCII85Decode') data = a85(data);
    else if (n === 'RunLengthDecode') data = rle(data);
    else if (n === 'CCITTFaxDecode') data = ccittDecode(data, prm, get, stream.dict);
    else if (n === 'Crypt') continue;
    else return { data, image: n, params: prm, rest: fl.slice(i + 1) };
  }
  return { data };
}
export const decode = (stream, get) => {
  if (!stream.decoded) stream.decoded = decodeFull(stream, get).data;
  return stream.decoded;
};
export const mkStream = (dict, data) => new Stream(dict, data);

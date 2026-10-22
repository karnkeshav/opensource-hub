// Image XObject / inline image decoding into RGBA (or a JPEG passthrough the browser decodes).
import { Dict, Stream, Name, N } from './obj.js';
import { decodeFull } from './filters.js';
import { getCS } from './color.js';

const ABBR = { BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width', L: 'Length' };
export function expandInline(d) {
  const o = new Dict();
  for (const [k, v] of d) o.set(ABBR[k] || k, v);
  return o;
}

// Returns { w, h, rgba } | { w, h, jpeg, alpha?, cmyk? } | { w, h, unsupported }
export function decodeImage(doc, s, res, fill = [0, 0, 0]) {
  const d = s.dict;
  const g = (k) => doc.get(d.get(k));
  const w = g('Width') | 0, h = g('Height') | 0;
  if (w <= 0 || h <= 0 || w * h > 1e8) return { w: 1, h: 1, unsupported: 'bad size' };
  const mask = g('ImageMask') === true;
  const dec = decodeFull(s, (x) => doc.get(x));
  let bpc = mask ? 1 : g('BitsPerComponent') || 8;
  const cs = mask ? null : getCS(doc, d.get('ColorSpace') || N('DeviceGray'), res);
  const out = { w, h, interpolate: g('Interpolate') === true };
  if (dec.image === 'DCTDecode') {
    out.jpeg = dec.data;
    out.cmyk = cs && cs.n === 4;
  } else if (dec.image) {
    out.unsupported = dec.image === 'JPXDecode' ? 'JPEG 2000' : dec.image === 'JBIG2Decode' ? 'JBIG2' : dec.image;
    return out;
  }
  if (dec.image === 'DCTDecode') bpc = 8;
  const decArr = g('Decode');
  if (!out.jpeg) {
    const data = dec.data;
    const n = mask ? 1 : cs.indexed ? 1 : cs.n || 1;
    const rowLen = (w * n * bpc + 7) >> 3;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const max = (1 << bpc) - 1;
    const D = Array.isArray(decArr) ? decArr.map((x) => +doc.get(x)) : null;
    if (mask) {
      const inv = D && D[0] === 1;
      const [r, gg, b] = fill.map((v) => Math.round(v * 255));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = (data[y * rowLen + (x >> 3)] >> (7 - (x & 7))) & 1;
        const i = (y * w + x) * 4;
        rgba[i] = r; rgba[i + 1] = gg; rgba[i + 2] = b; rgba[i + 3] = (bit === 0) !== inv ? 255 : 0;
      }
      out.rgba = rgba; out.mask = true;
      return out;
    }
    const read = (y, x, k) => {
      if (bpc === 8) return data[y * rowLen + x * n + k];
      if (bpc === 16) { const p = y * rowLen + (x * n + k) * 2; return data[p]; }
      const bitp = (x * n + k) * bpc, byte = data[y * rowLen + (bitp >> 3)];
      return (byte >> (8 - bpc - (bitp & 7))) & max;
    };
    const m8 = bpc === 16 ? 255 : max;
    const fast = !D && bpc === 8 && (cs.name === 'DeviceRGB' || cs.name === 'DeviceGray');
    if (fast && cs.name === 'DeviceRGB') { for (let i = 0, p = 0; i < w * h; i++) { const yy = (i / w) | 0, xx = i - yy * w, q = yy * rowLen + xx * 3; rgba[p++] = data[q]; rgba[p++] = data[q + 1]; rgba[p++] = data[q + 2]; rgba[p++] = 255; } }
    else if (fast) { for (let i = 0, p = 0; i < w * h; i++) { const yy = (i / w) | 0, v = data[yy * rowLen + (i - yy * w)]; rgba[p++] = v; rgba[p++] = v; rgba[p++] = v; rgba[p++] = 255; } }
    else {
      const cache = new Map(), comps = new Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let key = 0;
        for (let k = 0; k < n; k++) { const v = read(y, x, k) ?? 0; comps[k] = v; key = key * (m8 + 1) + v; }
        let c = n <= 2 || cs.name === 'DeviceCMYK' ? cache.get(key) : undefined;
        if (!c) {
          const cv = comps.map((v, k) => {
            if (cs.indexed) return D ? D[0] + (v * (D[1] - D[0])) / max : v;
            const t = v / m8;
            if (D) return D[2 * k] + t * (D[2 * k + 1] - D[2 * k]);
            if (cs.decode) return cs.decode[2 * k] + t * (cs.decode[2 * k + 1] - cs.decode[2 * k]);
            return t;
          });
          const rgb = cs.rgb(cv) || [1, 1, 1];
          c = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
          if (cache.size < 65536) cache.set(key, c);
        }
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
      }
    }
    // Colour-key masking
    const mk = g('Mask');
    if (Array.isArray(mk)) {
      const r = mk.map((x) => +doc.get(x));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let inr = true;
        for (let k = 0; k < n && inr; k++) { const v = read(y, x, k); if (v < r[2 * k] || v > r[2 * k + 1]) inr = false; }
        if (inr) rgba[(y * w + x) * 4 + 3] = 0;
      }
    }
    out.rgba = rgba;
  }
  // Soft mask / stencil mask -> alpha plane
  const sm = g('SMask'), mk = g('Mask');
  const alphaSrc = sm instanceof Stream ? sm : mk instanceof Stream ? mk : null;
  if (alphaSrc) {
    try {
      const isStencil = alphaSrc === mk;
      const a = decodeImage(doc, isStencil ? withMask(alphaSrc) : alphaSrc, res, [0, 0, 0]);
      if (a.rgba) {
        const alpha = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const sx = Math.min(a.w - 1, ((x * a.w) / w) | 0), sy = Math.min(a.h - 1, ((y * a.h) / h) | 0), si = (sy * a.w + sx) * 4;
          // explicit stencil /Mask: sample 0 = painted (decoded alpha 255), 1 = masked out
          alpha[y * w + x] = isStencil ? a.rgba[si + 3] : a.rgba[si];
        }
        out.alpha = alpha;
        if (out.rgba) { for (let i = 0; i < w * h; i++) out.rgba[i * 4 + 3] = Math.min(out.rgba[i * 4 + 3], alpha[i]); }
      }
    } catch {}
  }
  return out;
}
function withMask(s) { const d = new Dict(); for (const [k, v] of s.dict) d.set(k, v); d.set('ImageMask', true); const o = new Stream(d, s.data); return o; }
export const isImage = (o) => o instanceof Stream && o.dict.get('Subtype') instanceof Name && o.dict.get('Subtype').n === 'Image';

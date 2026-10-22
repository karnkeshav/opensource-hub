// Compression: downsample/recompress images, recompress streams with Flate, merge duplicate streams, strip metadata.
// Unused objects and object streams are handled by the full-rewrite writer at save time.
import { Dict, Ref, Stream, Name, N, clone } from './obj.js';
import { decodeFull, deflate } from './filters.js';
import { decodeImage } from './image.js';
import { Interp } from './interp.js';
import { NULL_DEV } from './text.js';
import { sha256 } from './crypto.js';
import { reachable } from './writer.js';

function downsample(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4), sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) for (let xx = x0; xx < x1 && xx < w; xx++) { const k = (yy * w + xx) * 4; r += rgba[k]; g += rgba[k + 1]; b += rgba[k + 2]; a += rgba[k + 3]; n++; }
      const o = (y * nw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

export async function compress(doc, o = {}) {
  const stats = { images: 0, streams: 0, dupes: 0, saved: 0 };
  // 1. measure how large each image is drawn
  const use = new Map();
  for (const page of doc.pages) {
    const it = new Interp(doc, NULL_DEV, { noAnnots: true, skipImages: true, onImage: (im) => { if (!(im.ref instanceof Ref)) return; const m = im.ctm, wpt = Math.hypot(m[0], m[1]), hpt = Math.hypot(m[2], m[3]); const u = use.get(im.ref.num) || { w: 0, h: 0, res: page.resources }; u.w = Math.max(u.w, wpt); u.h = Math.max(u.h, hpt); use.set(im.ref.num, u); } });
    try { await it.page(page); } catch {}
  }
  if (o.dpi > 0) {
    for (const [num, u] of use) {
      const s = doc.obj(num);
      if (!(s instanceof Stream)) continue;
      const d = s.dict;
      const W = doc.get(d.get('Width')), H = doc.get(d.get('Height'));
      if (!W || !H || doc.get(d.get('ImageMask')) || (doc.get(d.get('BitsPerComponent')) || 8) < 8) continue;
      const dpi = Math.min((W * 72) / Math.max(u.w, 1), (H * 72) / Math.max(u.h, 1));
      if (dpi <= o.dpi * 1.25 || W * H < 40000) continue;
      const k = o.dpi / dpi, nw = Math.max(1, Math.round(W * k)), nh = Math.max(1, Math.round(H * k));
      let img;
      try { img = decodeImage(doc, s, u.res); } catch { continue; }
      if (img.unsupported) continue;
      if (img.jpeg) { if (!o.decodeJpeg) continue; try { img = { ...img, ...(await o.decodeJpeg(img.jpeg)) }; } catch { continue; } }
      if (!img.rgba || img.w !== W) continue;
      const px = downsample(img.rgba, W, H, nw, nh);
      const nd = new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: nw, Height: nh, ColorSpace: N('DeviceRGB'), BitsPerComponent: 8 });
      if (d.has('Interpolate')) nd.set('Interpolate', d.get('Interpolate'));
      if (d.has('OC')) nd.set('OC', d.get('OC'));
      const rgb = new Uint8Array(nw * nh * 3), a = new Uint8Array(nw * nh);
      let hasA = false;
      for (let i = 0; i < nw * nh; i++) { rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; a[i] = px[i * 4 + 3]; if (a[i] < 255) hasA = true; }
      let data;
      if (o.encodeJpeg && !hasA) { data = await o.encodeJpeg(px, nw, nh, o.quality || 0.75); nd.set('Filter', N('DCTDecode')); }
      else { data = await deflate(rgb); nd.set('Filter', N('FlateDecode')); }
      if (hasA) nd.set('SMask', doc.add(new Stream(new Dict({ Type: N('XObject'), Subtype: N('Image'), Width: nw, Height: nh, ColorSpace: N('DeviceGray'), BitsPerComponent: 8, Filter: N('FlateDecode') }), await deflate(a))));
      if (data.length < s.data.length) { doc.set(num, new Stream(nd, data)); stats.images++; stats.saved += s.data.length - data.length; }
    }
  }
  // 2. recompress legacy-filtered / uncompressed streams with Flate
  const order = reachable(doc, [doc.trailer.get('Root'), doc.trailer.get('Info')].filter((x) => x instanceof Ref));
  for (const num of order) {
    const s = doc.obj(num);
    if (!(s instanceof Stream) || s.data.length < 256) continue;
    const f = doc.get(s.dict.get('Filter'));
    const names = (Array.isArray(f) ? f : f ? [f] : []).map((x) => doc.get(x)?.n);
    if (names.some((n) => ['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'Crypt'].includes(n))) continue;
    if (names.length === 1 && names[0] === 'FlateDecode' && !s.dict.has('DecodeParms')) continue;
    let dec;
    try { dec = decodeFull(s, (x) => doc.get(x)); } catch { continue; }
    if (dec.image) continue;
    const z = await deflate(dec.data);
    if (z.length < s.data.length) {
      const nd = clone(s.dict); nd.set('Filter', N('FlateDecode')); nd.delete('DecodeParms'); nd.delete('Length');
      doc.set(num, new Stream(nd, z)); stats.streams++; stats.saved += s.data.length - z.length;
    }
  }
  // 3. merge duplicate streams (images, fonts, forms with identical bytes and dictionaries)
  if (o.dedupe !== false) {
    const seen = new Map(), remap = new Map();
    for (const num of order) {
      const s = doc.obj(num);
      if (!(s instanceof Stream) || s.data.length < 512) continue;
      const t = doc.get(s.dict.get('Subtype'))?.n || doc.get(s.dict.get('Type'))?.n || '';
      if (t === 'XRef' || t === 'ObjStm' || t === 'Metadata') continue;
      const keys = [...s.dict].filter(([k]) => k !== 'Length').map(([k, v]) => k + '=' + (v instanceof Ref ? 'R' + v.num : v instanceof Name ? v.n : typeof v === 'number' ? v : JSON.stringify(String(v)))).sort().join(';');
      const hsh = Array.from(sha256(s.data).subarray(0, 12)).join(',') + '|' + keys;
      if (seen.has(hsh)) { remap.set(num, seen.get(hsh)); stats.dupes++; stats.saved += s.data.length; } else seen.set(hsh, num);
    }
    if (remap.size) {
      const fix = (v) => {
        if (v instanceof Ref) return remap.has(v.num) ? new Ref(remap.get(v.num)) : v;
        if (Array.isArray(v)) { let ch = false; const a = v.map((x) => { const y = fix(x); if (y !== x) ch = true; return y; }); return ch ? a : v; }
        if (v instanceof Dict) { let ch = false; const d = new Dict(); for (const [k, x] of v) { const y = fix(x); if (y !== x) ch = true; d.set(k, y); } return ch ? d : v; }
        if (v instanceof Stream) { const d = fix(v.dict); return d !== v.dict ? Object.assign(new Stream(d, v.data), v.decoded ? { decoded: v.decoded } : {}) : v; }
        return v;
      };
      for (const num of order) { const v = doc.obj(num); const y = fix(v); if (y !== v) doc.set(num, y); }
    }
  }
  // 4. metadata
  if (o.metadata) {
    const cat = doc.touch(doc.rootRef);
    cat.delete('Metadata'); cat.delete('PieceInfo');
    for (const p of doc.pages) { if (p.dict.has('Thumb') || p.dict.has('PieceInfo') || p.dict.has('Metadata')) { const pd = doc.touch(p.ref); pd.delete('Thumb'); pd.delete('PieceInfo'); pd.delete('Metadata'); } }
  }
  doc.needsFullSave = true;
  return stats;
}

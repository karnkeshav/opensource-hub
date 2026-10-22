// Shadings -> device-independent descriptors: axial/radial gradients, function-based (sampled image),
// free-form/lattice triangle meshes and Coons/tensor patches (tessellated into flat triangles).
import { Stream, Dict } from './obj.js';
import { getCS, makeFn, rgbCss } from './color.js';

export function shadingDesc(doc, sh, res) {
  sh = doc.get(sh);
  const d = sh instanceof Stream ? sh.dict : sh;
  if (!(d instanceof Dict)) return null;
  const g = (k) => { const v = doc.get(d.get(k)); return Array.isArray(v) ? v.map((x) => doc.get(x)) : v; };
  const type = g('ShadingType'), cs = getCS(doc, d.get('ColorSpace'), res);
  const fn = d.has('Function') ? makeFn(doc, d.get('Function')) : null;
  const col = (c) => { const v = fn ? fn(c) : c; return cs.rgb(v) || [1, 1, 1]; };
  const bg = g('Background');
  const out = { type, background: bg ? rgbCss(cs.rgb(bg)) : null, bbox: g('BBox') || null };
  if (type === 2 || type === 3) {
    const dom = g('Domain') || [0, 1], ext = g('Extend') || [false, false];
    out.coords = g('Coords'); out.extend = ext;
    out.stops = [];
    const N = 40;
    for (let i = 0; i <= N; i++) { const t = i / N; out.stops.push([t, rgbCss(col([dom[0] + t * (dom[1] - dom[0])]))]); }
    out.kind = type === 2 ? 'axial' : 'radial';
    return out;
  }
  if (type === 1) {
    const dom = g('Domain') || [0, 1, 0, 1], M = g('Matrix') || [1, 0, 0, 1, 0, 0];
    const S = 64, rgba = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = dom[0] + ((x + 0.5) / S) * (dom[1] - dom[0]), v = dom[2] + ((y + 0.5) / S) * (dom[3] - dom[2]);
      const c = col([u, v]), i = ((S - 1 - y) * S + x) * 4;
      rgba[i] = c[0] * 255; rgba[i + 1] = c[1] * 255; rgba[i + 2] = c[2] * 255; rgba[i + 3] = 255;
    }
    const m0 = [dom[1] - dom[0], 0, 0, dom[3] - dom[2], dom[0], dom[2]];
    out.kind = 'image'; out.image = { w: S, h: S, rgba }; out.matrix = mul(m0, M);
    return out;
  }
  if (type >= 4 && type <= 7 && sh instanceof Stream) {
    const data = doc.decoded(sh);
    const bpcoord = g('BitsPerCoordinate') || 16, bpcomp = g('BitsPerComponent') || 8, bpflag = g('BitsPerFlag') || 8;
    const dec = g('Decode') || [0, 1, 0, 1, 0, 1];
    const nc = fn ? 1 : cs.n;
    let bit = 0;
    const total = data.length * 8;
    const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) { const b = bit + i; v = v * 2 + ((data[b >> 3] >> (7 - (b & 7))) & 1); } bit += n; return v; };
    const align = () => { bit = (bit + 7) & ~7; };
    const cmax = Math.pow(2, bpcoord) - 1, kmax = Math.pow(2, bpcomp) - 1;
    const pt = () => [dec[0] + (rd(bpcoord) / cmax) * (dec[1] - dec[0]), dec[2] + (rd(bpcoord) / cmax) * (dec[3] - dec[2])];
    const cl = () => { const c = []; for (let k = 0; k < nc; k++) c.push(dec[4 + 2 * k] + (rd(bpcomp) / kmax) * (dec[5 + 2 * k] - dec[4 + 2 * k])); return c; };
    const tris = [];
    const tri = (a, b, c) => { const avg = a.c.map((v, k) => (v + b.c[k] + c.c[k]) / 3); tris.push([a.p[0], a.p[1], b.p[0], b.p[1], c.p[0], c.p[1], rgbCss(col(avg))]); };
    try {
      if (type === 4) {
        let a, b;
        while (bit + bpflag + 2 * bpcoord <= total && tris.length < 200000) {
          const f = rd(bpflag), v = { p: pt(), c: cl() };
          align();
          if (f === 0) { const v2 = { p: (rd(bpflag), pt()), c: cl() }; align(); const v3 = { p: (rd(bpflag), pt()), c: cl() }; align(); tri(v, v2, v3); a = v2; b = v3; }
          else if (f === 1 && a) { tri(a, b, v); a = b; b = v; }
          else if (f === 2 && a) { tri(a, b, v); b = v; }
        }
      } else if (type === 5) {
        const per = g('VerticesPerRow') || 2, rows = [];
        while (bit + 2 * bpcoord <= total) { const row = []; for (let i = 0; i < per && bit + 2 * bpcoord <= total; i++) row.push({ p: pt(), c: cl() }); if (row.length === per) rows.push(row); }
        for (let r = 0; r + 1 < rows.length; r++) for (let i = 0; i + 1 < per; i++) { tri(rows[r][i], rows[r][i + 1], rows[r + 1][i]); tri(rows[r][i + 1], rows[r + 1][i + 1], rows[r + 1][i]); }
      } else {
        let prev = null;
        const np = type === 6 ? 12 : 16;
        while (bit + bpflag + 2 * bpcoord <= total && tris.length < 200000) {
          const f = rd(bpflag);
          let P, C;
          if (f === 0 || !prev) { P = []; for (let i = 0; i < np; i++) P.push(pt()); C = [cl(), cl(), cl(), cl()]; }
          else {
            const [pp, pc] = prev;
            const e = f === 1 ? [pp[3], pp[4], pp[5], pp[6]] : f === 2 ? [pp[6], pp[7], pp[8], pp[9]] : [pp[9], pp[10], pp[11], pp[0]];
            const ec = f === 1 ? [pc[1], pc[2]] : f === 2 ? [pc[2], pc[3]] : [pc[3], pc[0]];
            P = [...e]; for (let i = 4; i < np; i++) P.push(pt()); C = [...ec, cl(), cl()];
          }
          align();
          prev = [P, C];
          coons(P, C, tri);
        }
      }
    } catch {}
    out.kind = 'mesh'; out.tris = tris;
    return out;
  }
  return null;
}
const bez = (a, b, c, d, t) => { const s = 1 - t; return [s * s * s * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t * t * t * d[0], s * s * s * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t * t * t * d[1]]; };
function coons(P, C, tri) {
  const [p00, p01, p02, p03, p13, p23, p33, p32, p31, p30, p20, p10] = P;
  const [c00, c03, c33, c30] = C;
  const S = (u, v) => {
    const c1 = bez(p00, p10, p20, p30, u), c2 = bez(p03, p13, p23, p33, u), d1 = bez(p00, p01, p02, p03, v), d2 = bez(p30, p31, p32, p33, v);
    const r = [0, 1].map((k) => (1 - v) * c1[k] + v * c2[k] + (1 - u) * d1[k] + u * d2[k] - ((1 - v) * (1 - u) * p00[k] + v * (1 - u) * p03[k] + (1 - v) * u * p30[k] + u * v * p33[k]));
    const c = c00.map((_, k) => (1 - u) * (1 - v) * c00[k] + (1 - u) * v * c03[k] + u * v * c33[k] + u * (1 - v) * c30[k]);
    return { p: r, c };
  };
  const n = 8;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = S(i / n, j / n), b = S((i + 1) / n, j / n), c = S((i + 1) / n, (j + 1) / n), d = S(i / n, (j + 1) / n);
    tri(a, b, c); tri(a, c, d);
  }
}
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

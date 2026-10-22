// Colour spaces (Device*, Cal*, Lab, ICCBased via N/Alternate, Indexed, Separation, DeviceN, Pattern) and PDF functions (types 0, 2, 3, 4).
import { Dict, Name, Stream, Str } from './obj.js';
import { Lexer, Cmd, EOF } from './parser.js';

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const cmyk2rgb = (c, m, y, k) => {
  // A gentler conversion than 1-(c+k) that keeps rich blacks dark and avoids neon primaries.
  const r = (1 - c) * (1 - k), g = (1 - m) * (1 - k), b = (1 - y) * (1 - k);
  return [clamp(r * (1 - 0.12 * m - 0.03 * y)), clamp(g * (1 - 0.1 * c - 0.05 * y)), clamp(b * (1 - 0.05 * c - 0.12 * m))];
};

export function makeFn(doc, o) {
  o = doc.get(o);
  if (Array.isArray(o)) { const fs = o.map((x) => makeFn(doc, x)); return (inp) => fs.map((f) => f(inp)[0]); }
  const d = o instanceof Stream ? o.dict : o;
  if (!(d instanceof Dict)) return (x) => x;
  const g = (k) => { const v = doc.get(d.get(k)); return Array.isArray(v) ? v.map((x) => doc.get(x)) : v; };
  const type = g('FunctionType'), dom = g('Domain') || [0, 1], range = g('Range');
  const clip = (v, i) => (range ? Math.min(Math.max(v, range[2 * i]), range[2 * i + 1]) : v);
  const cin = (x, i) => Math.min(Math.max(x, dom[2 * i]), dom[2 * i + 1]);
  if (type === 2) {
    const C0 = g('C0') || [0], C1 = g('C1') || [1], N = g('N') ?? 1;
    return (inp) => { const x = cin(inp[0], 0), t = Math.pow(x, N); return C0.map((c, i) => clip(c + t * (C1[i] - c), i)); };
  }
  if (type === 3) {
    const fs = (g('Functions') || []).map((x) => makeFn(doc, x)), b = g('Bounds') || [], e = g('Encode') || [];
    return (inp) => {
      const x = cin(inp[0], 0);
      let k = 0; while (k < b.length && x >= b[k]) k++;
      const lo = k === 0 ? dom[0] : b[k - 1], hi = k === b.length ? dom[1] : b[k];
      const e0 = e[2 * k] ?? 0, e1 = e[2 * k + 1] ?? 1;
      const t = hi === lo ? e0 : e0 + ((x - lo) / (hi - lo)) * (e1 - e0);
      return fs[k] ? fs[k]([t]) : [t];
    };
  }
  if (type === 0 && o instanceof Stream) {
    const size = g('Size') || [2], bps = g('BitsPerSample') || 8, n = range ? range.length / 2 : 1;
    const enc = g('Encode') || size.flatMap((s) => [0, s - 1]), dec = g('Decode') || range || [0, 1];
    const data = doc.decoded(o), max = Math.pow(2, bps) - 1;
    const sample = (idx) => {
      const out = [];
      for (let j = 0; j < n; j++) {
        const bit = (idx * n + j) * bps;
        let v = 0;
        if (bps === 8) v = data[bit >> 3]; else if (bps === 16) v = (data[bit >> 3] << 8) | data[(bit >> 3) + 1];
        else for (let k = 0; k < bps; k++) { const bb = bit + k; v = (v << 1) | ((data[bb >> 3] >> (7 - (bb & 7))) & 1); }
        out.push(dec[2 * j] + (v / max) * (dec[2 * j + 1] - dec[2 * j]));
      }
      return out;
    };
    return (inp) => {
      // multilinear in the first input, nearest in the others
      let idx = 0, mul = 1, frac = 0, lo0 = 0;
      for (let i = 0; i < size.length; i++) {
        const x = cin(inp[i] ?? 0, i);
        let e = enc[2 * i] + ((x - dom[2 * i]) / (dom[2 * i + 1] - dom[2 * i] || 1)) * (enc[2 * i + 1] - enc[2 * i]);
        e = Math.min(Math.max(e, 0), size[i] - 1);
        if (i === 0) { lo0 = Math.floor(e); frac = e - lo0; idx += lo0; } else idx += Math.round(e) * mul;
        mul *= size[i];
      }
      const a = sample(idx);
      if (frac > 0 && lo0 + 1 < size[0]) { const b = sample(idx + 1); return a.map((v, j) => clip(v + frac * (b[j] - v), j)); }
      return a.map(clip);
    };
  }
  if (type === 4 && o instanceof Stream) {
    const code = parsePS(new Lexer(doc.decoded(o)));
    return (inp) => {
      const st = inp.map((x, i) => cin(x, i));
      try { runPS(code, st); } catch {}
      const n = range ? range.length / 2 : st.length;
      return st.slice(-n).map((v, i) => clip(+v || 0, i));
    };
  }
  return (x) => x;
}
function parsePS(lx, inner) {
  const out = [];
  let t = lx.tok();
  if (!inner && t instanceof Cmd && t.c === '{') t = lx.tok();
  for (; t !== EOF; t = lx.tok()) {
    if (t instanceof Cmd && t.c === '}') break;
    if (t instanceof Cmd && t.c === '{') { out.push(parsePS(lx, true)); continue; }
    out.push(t);
  }
  return out;
}
function runPS(code, s) {
  for (let i = 0; i < code.length; i++) {
    const t = code[i];
    if (typeof t === 'number' || Array.isArray(t)) { s.push(t); continue; }
    const c = t.c, b = () => s.pop();
    let x, y;
    switch (c) {
      case 'add': y = b(); x = b(); s.push(x + y); break;
      case 'sub': y = b(); x = b(); s.push(x - y); break;
      case 'mul': y = b(); x = b(); s.push(x * y); break;
      case 'div': y = b(); x = b(); s.push(y ? x / y : 0); break;
      case 'idiv': y = b(); x = b(); s.push(y ? Math.trunc(x / y) : 0); break;
      case 'mod': y = b(); x = b(); s.push(y ? x % y : 0); break;
      case 'neg': s.push(-b()); break;
      case 'abs': s.push(Math.abs(b())); break;
      case 'ceiling': s.push(Math.ceil(b())); break;
      case 'floor': s.push(Math.floor(b())); break;
      case 'round': s.push(Math.round(b())); break;
      case 'truncate': s.push(Math.trunc(b())); break;
      case 'sqrt': s.push(Math.sqrt(b())); break;
      case 'sin': s.push(Math.sin((b() * Math.PI) / 180)); break;
      case 'cos': s.push(Math.cos((b() * Math.PI) / 180)); break;
      case 'atan': y = b(); x = b(); { let a = (Math.atan2(x, y) * 180) / Math.PI; if (a < 0) a += 360; s.push(a); } break;
      case 'exp': y = b(); x = b(); s.push(Math.pow(x, y)); break;
      case 'ln': s.push(Math.log(b())); break;
      case 'log': s.push(Math.log10(b())); break;
      case 'cvi': s.push(Math.trunc(b())); break;
      case 'cvr': break;
      case 'dup': s.push(s[s.length - 1]); break;
      case 'pop': b(); break;
      case 'exch': y = b(); x = b(); s.push(y, x); break;
      case 'copy': { const n = b(); s.push(...s.slice(s.length - n)); break; }
      case 'index': { const n = b(); s.push(s[s.length - 1 - n]); break; }
      case 'roll': { const j = b(), n = b(); if (n > 0) { const a = s.splice(s.length - n, n); const k = ((j % n) + n) % n; s.push(...a.slice(n - k), ...a.slice(0, n - k)); } break; }
      case 'eq': y = b(); x = b(); s.push(x === y); break;
      case 'ne': y = b(); x = b(); s.push(x !== y); break;
      case 'gt': y = b(); x = b(); s.push(x > y); break;
      case 'ge': y = b(); x = b(); s.push(x >= y); break;
      case 'lt': y = b(); x = b(); s.push(x < y); break;
      case 'le': y = b(); x = b(); s.push(x <= y); break;
      case 'and': y = b(); x = b(); s.push(typeof x === 'boolean' ? x && y : x & y); break;
      case 'or': y = b(); x = b(); s.push(typeof x === 'boolean' ? x || y : x | y); break;
      case 'xor': y = b(); x = b(); s.push(typeof x === 'boolean' ? x !== y : x ^ y); break;
      case 'not': x = b(); s.push(typeof x === 'boolean' ? !x : ~x); break;
      case 'bitshift': y = b(); x = b(); s.push(y > 0 ? x << y : x >> -y); break;
      case 'true': s.push(true); break;
      case 'false': s.push(false); break;
      case 'if': { const p = b(), cond = b(); if (cond) runPS(p, s); break; }
      case 'ifelse': { const p2 = b(), p1 = b(), cond = b(); runPS(cond ? p1 : p2, s); break; }
      default: break;
    }
  }
}

// Colour space objects: { n, rgb(comps) -> [r,g,b] in 0..1, init: initial comps, name }
const DEV = {
  DeviceGray: { n: 1, name: 'DeviceGray', rgb: (c) => [clamp(c[0]), clamp(c[0]), clamp(c[0])], init: [0] },
  DeviceRGB: { n: 3, name: 'DeviceRGB', rgb: (c) => [clamp(c[0]), clamp(c[1]), clamp(c[2])], init: [0, 0, 0] },
  DeviceCMYK: { n: 4, name: 'DeviceCMYK', rgb: (c) => cmyk2rgb(clamp(c[0]), clamp(c[1]), clamp(c[2]), clamp(c[3])), init: [0, 0, 0, 1] },
};
DEV.G = DEV.DeviceGray; DEV.RGB = DEV.DeviceRGB; DEV.CMYK = DEV.DeviceCMYK; DEV.CalGray = DEV.DeviceGray; DEV.CalRGB = DEV.DeviceRGB; DEV.CalCMYK = DEV.DeviceCMYK;
export const PATTERN = { n: 0, name: 'Pattern', pattern: true, rgb: () => [0, 0, 0], init: [] };

export function getCS(doc, v, res, depth = 0) {
  v = doc.get(v);
  if (depth > 8) return DEV.DeviceGray;
  if (v instanceof Name) {
    if (DEV[v.n]) return DEV[v.n];
    if (v.n === 'Pattern') return PATTERN;
    if (v.n === 'I' || v.n === 'Indexed') return DEV.DeviceGray;
    const csd = res && doc.get(res.get('ColorSpace'));
    if (csd instanceof Dict && csd.has(v.n)) return getCS(doc, csd.get(v.n), res, depth + 1);
    if (v.n === 'DefaultRGB' || v.n === 'DefaultCMYK' || v.n === 'DefaultGray') return DEV['Device' + v.n.slice(7)];
    return DEV.DeviceGray;
  }
  if (!Array.isArray(v) || !v.length) return DEV.DeviceGray;
  const kind = doc.get(v[0])?.n;
  doc.csCache = doc.csCache || new WeakMap();
  if (doc.csCache.has(v)) return doc.csCache.get(v);
  let cs;
  switch (kind) {
    case 'ICCBased': {
      const s = doc.get(v[1]);
      const d = s instanceof Stream ? s.dict : new Dict();
      const n = doc.get(d.get('N')) || 3;
      const alt = d.get('Alternate');
      cs = alt ? getCS(doc, alt, res, depth + 1) : n === 1 ? DEV.DeviceGray : n === 4 ? DEV.DeviceCMYK : DEV.DeviceRGB;
      if (cs.n !== n) cs = n === 1 ? DEV.DeviceGray : n === 4 ? DEV.DeviceCMYK : DEV.DeviceRGB;
      break;
    }
    case 'CalRGB': case 'CalGray': case 'CalCMYK': case 'DeviceRGB': case 'DeviceGray': case 'DeviceCMYK': case 'RGB': case 'G': case 'CMYK':
      cs = DEV[kind]; break;
    case 'Lab': {
      const d = doc.get(v[1]) || new Dict();
      const wp = doc.get(d.get('WhitePoint')) || [0.9505, 1, 1.089], rg = doc.get(d.get('Range')) || [-100, 100, -100, 100];
      cs = { n: 3, name: 'Lab', init: [0, 0, 0], decode: [0, 100, rg[0], rg[1], rg[2], rg[3]], rgb: (c) => lab(c, wp) };
      break;
    }
    case 'Indexed': case 'I': {
      const base = getCS(doc, v[1], res, depth + 1), hival = doc.get(v[2]) | 0;
      let lk = doc.get(v[3]);
      const tbl = lk instanceof Stream ? doc.decoded(lk) : lk instanceof Str ? Uint8Array.from(lk.s, (c) => c.charCodeAt(0)) : new Uint8Array(0);
      const pal = [];
      for (let i = 0; i <= hival; i++) {
        const comps = []; for (let k = 0; k < base.n; k++) comps.push((tbl[i * base.n + k] || 0) / 255);
        if (base.decode) for (let k = 0; k < base.n; k++) comps[k] = base.decode[2 * k] + comps[k] * (base.decode[2 * k + 1] - base.decode[2 * k]);
        pal.push(base.rgb(comps));
      }
      cs = { n: 1, name: 'Indexed', indexed: true, hival, pal, init: [0], rgb: (c) => pal[Math.max(0, Math.min(hival, Math.round(c[0])))] || [0, 0, 0] };
      break;
    }
    case 'Separation': case 'DeviceN': {
      const names = doc.get(v[1]);
      const n = kind === 'Separation' ? 1 : Array.isArray(names) ? names.length : 1;
      const alt = getCS(doc, v[2], res, depth + 1), fn = makeFn(doc, v[3]);
      const none = kind === 'Separation' && names?.n === 'None';
      const allName = kind === 'Separation' && names?.n === 'All';
      const cache = new Map();
      cs = {
        n, name: kind, init: new Array(n).fill(1),
        rgb: (c) => {
          if (none) return null;
          if (allName) { const t = 1 - clamp(c[0]); return [t, t, t]; }
          const key = n === 1 ? Math.round(c[0] * 255) : c.join(',');
          let r = cache.get(key);
          if (!r) { r = alt.rgb(fn(c)); if (cache.size < 4096) cache.set(key, r); }
          return r;
        },
      };
      break;
    }
    case 'Pattern': cs = { ...PATTERN, under: v[1] ? getCS(doc, v[1], res, depth + 1) : null }; break;
    default: cs = DEV.DeviceRGB;
  }
  doc.csCache.set(v, cs);
  return cs;
}
function lab(c, wp) {
  const [L, a, b] = c;
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t) => (t > 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));
  const X = wp[0] * f(fx), Y = wp[1] * f(fy), Z = wp[2] * f(fz);
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, bl = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  const gm = (u) => clamp(u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
  return [gm(r), gm(g), gm(bl)];
}
export const rgbCss = (rgb, a = 1) => (rgb ? (a < 1 ? `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})` : `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`) : null);
export { DEV };

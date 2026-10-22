// Worksheet function library. Each entry is (args, ctx) => value; `lazy` entries get (closures, ctx, nodes).
import {
  E, isErr, isRef, isArr, isLambda, isMulti, num, str, bool, scalar, grid, collect, eachAny, eachRef, lift1, lift2, cmp, eq,
  critFn, wildRe, callLambda, roundHalf, textToNum, parseDateText, serialToYMD, ymdToSerial, serialDow, nowSerial, numStr,
} from './core.js';
import { format } from './numfmt.js';
import { colName } from './parser.js';

export const F = Object.create(null);
const def = (names, fn, lazy) => { if (lazy) fn.lazy = true; for (const n of names.split(' ')) F[n] = fn; };
const d0 = (v, d) => (v === undefined || v === null ? d : v);
const sum = (n) => { let s = 0; for (const x of n) s += x; return s; };
const minOf = (n) => { let m = Infinity; for (const x of n) if (x < m) m = x; return m; };
const maxOf = (n) => { let m = -Infinity; for (const x of n) if (x > m) m = x; return m; };
const m1 = (names, f) => def(names, (a) => lift1(a[0], (v) => f(num(v))));
const m2 = (names, f) => def(names, (a) => lift2(a[0], a[1], f));
const t1 = (names, f) => def(names, (a) => lift1(a[0], (v) => f(str(v))));
const flat = (v) => grid(v).flat();
const nz = (x) => { if (x === 0) throw E.DIV0; return x; };
const needNum = (x) => { if (!isFinite(x)) throw E.NUM; return x; };

// ---------- math ----------
def('SUM', (a) => sum(collect(a)));
def('AVERAGE', (a) => { const n = collect(a); if (!n.length) throw E.DIV0; return sum(n) / n.length; });
def('MIN', (a) => { const n = collect(a); return n.length ? minOf(n) : 0; });
def('MAX', (a) => { const n = collect(a); return n.length ? maxOf(n) : 0; });
def('PRODUCT', (a) => collect(a).reduce((x, y) => x * y, 1));
def('SUMSQ', (a) => collect(a).reduce((x, y) => x + y * y, 0));
def('COUNT', (a) => {
  let k = 0;
  for (const x of a) {
    if (isRef(x) || isArr(x)) eachAny(x, (v) => { if (typeof v === 'number') k++; });
    else if (x !== undefined && (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && textToNum(x) === textToNum(x)))) k++;
  }
  return k;
});
def('COUNTA', (a) => { let k = 0; for (const x of a) { if (x === undefined) continue; if (isRef(x) || isArr(x)) eachAny(x, () => k++); else k++; } return k; });
def('COUNTBLANK', (a) => { const g = grid(a[0]); let k = 0; for (const r of g) for (const v of r) if (v == null || v === '') k++; return isRef(a[0]) ? (a[0].r2 - a[0].r1 + 1) * (a[0].c2 - a[0].c1 + 1) - g.flat().filter((v) => v != null && v !== '').length : k; });
m1('ABS', Math.abs);
m1('SQRT', (x) => { if (x < 0) throw E.NUM; return Math.sqrt(x); });
m1('EXP', Math.exp);
m1('LN', (x) => { if (x <= 0) throw E.NUM; return Math.log(x); });
m1('LOG10', (x) => { if (x <= 0) throw E.NUM; return Math.log10(x); });
m1('SIGN', Math.sign);
m1('INT', Math.floor);
m1('SIN', Math.sin); m1('COS', Math.cos); m1('TAN', Math.tan); m1('ATAN', Math.atan);
m1('ASIN', (x) => needNum(Math.asin(x))); m1('ACOS', (x) => needNum(Math.acos(x)));
m1('SINH', Math.sinh); m1('COSH', Math.cosh); m1('TANH', Math.tanh);
m1('DEGREES', (x) => x * 180 / Math.PI); m1('RADIANS', (x) => x * Math.PI / 180);
m1('FACT', (x) => { if (x < 0) throw E.NUM; let r = 1; for (let i = 2; i <= Math.floor(x); i++) r *= i; return r; });
m1('EVEN', (x) => { const r = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -r : r; });
m1('ODD', (x) => { let r = Math.ceil(Math.abs(x)); if (r % 2 === 0) r++; return x < 0 ? -r : r; });
def('PI', () => Math.PI);
def('ATAN2', (a) => lift2(a[0], a[1], (x, y) => Math.atan2(num(y), num(x))));
def('LOG', (a) => lift2(a[0], a[1], (x, b) => { x = num(x); b = b === undefined ? 10 : num(b); if (x <= 0 || b <= 0 || b === 1) throw E.NUM; return Math.log(x) / Math.log(b); }));
def('POWER', (a) => lift2(a[0], a[1], (x, y) => pow(num(x), num(y))));
export const pow = (x, y) => { if (x === 0 && y < 0) throw E.DIV0; const r = Math.pow(x, y); if (r !== r) throw E.NUM; return r; };
def('MOD', (a) => lift2(a[0], a[1], (x, y) => { x = num(x); y = nz(num(y)); return x - y * Math.floor(x / y); }));
def('QUOTIENT', (a) => lift2(a[0], a[1], (x, y) => Math.trunc(num(x) / nz(num(y)))));
def('ROUND', (a) => lift2(a[0], a[1], (x, d) => roundHalf(num(x), Math.trunc(num(d)))));
def('ROUNDUP', (a) => lift2(a[0], a[1], (x, d) => { x = num(x); d = Math.trunc(num(d)); const f = Math.pow(10, d); const r = Math.ceil(Math.abs(x) * f - 1e-9) / f; return x < 0 ? -r : r; }));
def('ROUNDDOWN', (a) => lift2(a[0], a[1], (x, d) => { x = num(x); d = Math.trunc(num(d)); const f = Math.pow(10, d); const r = Math.floor(Math.abs(x) * f + 1e-9) / f; return x < 0 ? -r : r; }));
def('TRUNC', (a) => lift2(a[0], a[1], (x, d) => { x = num(x); const f = Math.pow(10, d === undefined ? 0 : Math.trunc(num(d))); return Math.trunc(x * f + (x < 0 ? -1e-9 : 1e-9)) / f; }));
def('CEILING', (a) => lift2(a[0], a[1], (x, s) => { x = num(x); s = s === undefined ? 1 : num(s); return s === 0 ? 0 : Math.ceil(x / s) * s; }));
def('FLOOR', (a) => lift2(a[0], a[1], (x, s) => { x = num(x); s = s === undefined ? 1 : num(s); return s === 0 ? 0 : Math.floor(x / s) * s; }));
def('MROUND', (a) => lift2(a[0], a[1], (x, s) => { x = num(x); s = num(s); return s === 0 ? 0 : Math.round(x / s) * s; }));
def('COMBIN', (a) => lift2(a[0], a[1], (n, k) => { n = num(n); k = num(k); if (k > n || k < 0) throw E.NUM; let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); }));
def('PERMUT', (a) => lift2(a[0], a[1], (n, k) => { n = num(n); k = num(k); if (k > n || k < 0) throw E.NUM; let r = 1; for (let i = 0; i < k; i++) r *= n - i; return r; }));
const gcd = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) [x, y] = [y, x % y]; return x; };
def('GCD', (a) => collect(a).reduce(gcd, 0));
def('LCM', (a) => collect(a).reduce((x, y) => (x && y ? Math.abs(x * y) / gcd(x, y) : 0), 1));
def('RAND', () => Math.random());
def('RANDBETWEEN', (a) => { const lo = Math.ceil(num(a[0])), hi = Math.floor(num(a[1])); if (hi < lo) throw E.NUM; return lo + Math.floor(Math.random() * (hi - lo + 1)); });
def('SUMPRODUCT', (a) => {
  const gs = a.map(grid);
  const R = gs[0].length, C = gs[0][0].length;
  if (gs.some((g) => g.length !== R || g[0].length !== C)) throw E.VALUE;
  let s = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    let p = 1;
    for (const g of gs) { const v = g[i][j]; if (isErr(v)) throw v; p *= typeof v === 'number' ? v : 0; }
    s += p;
  }
  return s;
});
def('MMULT', (a) => {
  const x = grid(a[0]), y = grid(a[1]);
  if (x[0].length !== y.length) throw E.VALUE;
  return x.map((row) => y[0].map((_, j) => row.reduce((s, v, k) => s + num(v) * num(y[k][j]), 0)));
});
const lu = (g) => {
  const n = g.length, m = g.map((r) => r.map(num));
  if (m.some((r) => r.length !== n)) throw E.VALUE;
  return m;
};
def('MDETERM', (a) => {
  const m = lu(grid(a[0])), n = m.length;
  let det = 1;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    if (m[p][i] === 0) return 0;
    if (p !== i) { [m[p], m[i]] = [m[i], m[p]]; det = -det; }
    det *= m[i][i];
    for (let k = i + 1; k < n; k++) { const f = m[k][i] / m[i][i]; for (let j = i; j < n; j++) m[k][j] -= f * m[i][j]; }
  }
  return det;
});
def('MINVERSE', (a) => {
  const m = lu(grid(a[0])), n = m.length;
  const I = m.map((_, i) => m.map((_, j) => (i === j ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    if (Math.abs(m[p][i]) < 1e-12) throw E.NUM;
    [m[p], m[i]] = [m[i], m[p]]; [I[p], I[i]] = [I[i], I[p]];
    const d = m[i][i];
    for (let j = 0; j < n; j++) { m[i][j] /= d; I[i][j] /= d; }
    for (let k = 0; k < n; k++) if (k !== i) { const f = m[k][i]; for (let j = 0; j < n; j++) { m[k][j] -= f * m[i][j]; I[k][j] -= f * I[i][j]; } }
  }
  return I;
});
def('MUNIT', (a) => { const n = num(a[0]); return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))); });

// ---------- conditional aggregates ----------
function ifsHits(a, from) {
  const gs = [], ps = [];
  for (let i = from; i + 1 < a.length; i += 2) { gs.push(grid(a[i])); ps.push(critFn(a[i + 1])); }
  if (!gs.length) throw E.VALUE;
  const R = gs[0].length, C = gs[0][0].length, hits = [];
  if (gs.some((g) => g.length !== R || g[0].length !== C)) throw E.VALUE;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) if (ps.every((p, k) => p(gs[k][i][j]))) hits.push([i, j]);
  return { hits, R, C };
}
const sized = (ref, R, C) => (isRef(ref) ? grid({ ...ref, r2: ref.r1 + R - 1, c2: ref.c1 + C - 1 }) : grid(ref));
const hitNums = (g, hits) => hits.map(([i, j]) => g[i][j]).filter((v) => typeof v === 'number');
def('COUNTIF', (a) => ifsHits([a[0], a[1]], 0).hits.length);
def('COUNTIFS', (a) => ifsHits(a, 0).hits.length);
def('SUMIF', (a) => { const { hits, R, C } = ifsHits([a[0], a[1]], 0); return sum(hitNums(a[2] === undefined ? grid(a[0]) : sized(a[2], R, C), hits)); });
def('SUMIFS', (a) => { const { hits, R, C } = ifsHits(a, 1); return sum(hitNums(sized(a[0], R, C), hits)); });
def('AVERAGEIF', (a) => { const { hits, R, C } = ifsHits([a[0], a[1]], 0); const n = hitNums(a[2] === undefined ? grid(a[0]) : sized(a[2], R, C), hits); if (!n.length) throw E.DIV0; return sum(n) / n.length; });
def('AVERAGEIFS', (a) => { const { hits, R, C } = ifsHits(a, 1); const n = hitNums(sized(a[0], R, C), hits); if (!n.length) throw E.DIV0; return sum(n) / n.length; });
def('MAXIFS', (a) => { const { hits, R, C } = ifsHits(a, 1); const n = hitNums(sized(a[0], R, C), hits); return n.length ? maxOf(n) : 0; });
def('MINIFS', (a) => { const { hits, R, C } = ifsHits(a, 1); const n = hitNums(sized(a[0], R, C), hits); return n.length ? minOf(n) : 0; });

def('SUBTOTAL', (a) => {
  const code = num(a[0]), f = code % 100, skipManual = code > 100, nums = [], all = [];
  for (const x of a.slice(1)) {
    if (!isRef(x)) { eachAny(x, (v) => { all.push(v); if (typeof v === 'number') nums.push(v); }); continue; }
    eachRef(x, (v, r) => {
      if (x.sh.filtered.has(r) || (skipManual && x.sh.hiddenRows.has(r))) return;
      all.push(v);
      if (typeof v === 'number') nums.push(v);
    });
  }
  switch (f) {
    case 1: if (!nums.length) throw E.DIV0; return sum(nums) / nums.length;
    case 2: return nums.length;
    case 3: return all.length;
    case 4: return nums.length ? maxOf(nums) : 0;
    case 5: return nums.length ? minOf(nums) : 0;
    case 6: return nums.reduce((x, y) => x * y, 1);
    case 7: return Math.sqrt(variance(nums, true));
    case 8: return Math.sqrt(variance(nums, false));
    case 9: return sum(nums);
    case 10: return variance(nums, true);
    case 11: return variance(nums, false);
  }
  throw E.VALUE;
});

// ---------- statistics ----------
function variance(n, sample) {
  const k = n.length;
  if (k < (sample ? 2 : 1)) throw E.DIV0;
  const m = sum(n) / k;
  return n.reduce((s, x) => s + (x - m) * (x - m), 0) / (sample ? k - 1 : k);
}
def('STDEV STDEV.S', (a) => Math.sqrt(variance(collect(a), true)));
def('STDEVP STDEV.P', (a) => Math.sqrt(variance(collect(a), false)));
def('VAR VAR.S', (a) => variance(collect(a), true));
def('VARP VAR.P', (a) => variance(collect(a), false));
def('DEVSQ', (a) => { const n = collect(a); const m = sum(n) / n.length; return n.reduce((s, x) => s + (x - m) ** 2, 0); });
def('MEDIAN', (a) => {
  const n = collect(a).sort((x, y) => x - y);
  if (!n.length) throw E.NUM;
  const h = n.length >> 1;
  return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2;
});
def('MODE MODE.SNGL', (a) => {
  const n = collect(a), cnt = new Map();
  let best = null, bc = 1;
  for (const x of n) { const c = (cnt.get(x) || 0) + 1; cnt.set(x, c); if (c > bc) { bc = c; best = x; } }
  if (best === null) throw E.NA;
  return best;
});
def('GEOMEAN', (a) => { const n = collect(a); if (!n.length || n.some((x) => x <= 0)) throw E.NUM; return Math.exp(sum(n.map(Math.log)) / n.length); });
def('LARGE', (a) => { const n = collect([a[0]]).sort((x, y) => y - x), k = num(a[1]); if (k < 1 || k > n.length) throw E.NUM; return n[k - 1]; });
def('SMALL', (a) => { const n = collect([a[0]]).sort((x, y) => x - y), k = num(a[1]); if (k < 1 || k > n.length) throw E.NUM; return n[k - 1]; });
def('RANK RANK.EQ', (a) => {
  const x = num(a[0]), n = collect([a[1]]), asc = a[2] !== undefined && num(a[2]) !== 0;
  if (!n.includes(x)) throw E.NA;
  return 1 + n.filter((v) => (asc ? v < x : v > x)).length;
});
const pctile = (n, p) => {
  n = n.sort((x, y) => x - y);
  if (!n.length || p < 0 || p > 1) throw E.NUM;
  const k = (n.length - 1) * p, f = Math.floor(k);
  return f + 1 < n.length ? n[f] + (k - f) * (n[f + 1] - n[f]) : n[f];
};
def('PERCENTILE PERCENTILE.INC', (a) => pctile(collect([a[0]]), num(a[1])));
def('QUARTILE QUARTILE.INC', (a) => { const q = num(a[1]); if (q < 0 || q > 4) throw E.NUM; return pctile(collect([a[0]]), q / 4); });
const pairs = (a) => {
  const y = flat(a[0]), x = flat(a[1]);
  if (x.length !== y.length) throw E.NA;
  const px = [], py = [];
  x.forEach((v, i) => { if (typeof v === 'number' && typeof y[i] === 'number') { px.push(v); py.push(y[i]); } });
  if (px.length < 2) throw E.DIV0;
  return [py, px];
};
const regress = (y, x) => {
  const n = x.length, mx = sum(x) / n, my = sum(y) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return { sxy, sxx, syy, mx, my };
};
def('CORREL PEARSON', (a) => { const { sxy, sxx, syy } = regress(...pairs(a)); return sxy / nz(Math.sqrt(sxx * syy)); });
def('RSQ', (a) => { const { sxy, sxx, syy } = regress(...pairs(a)); return (sxy * sxy) / nz(sxx * syy); });
def('SLOPE', (a) => { const { sxy, sxx } = regress(...pairs(a)); return sxy / nz(sxx); });
def('INTERCEPT', (a) => { const { sxy, sxx, mx, my } = regress(...pairs(a)); return my - (sxy / nz(sxx)) * mx; });
def('FORECAST FORECAST.LINEAR', (a) => { const { sxy, sxx, mx, my } = regress(...pairs([a[1], a[2]])); return my + (sxy / nz(sxx)) * (num(a[0]) - mx); });
const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const ncdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const ninv = (p) => {
  if (p <= 0 || p >= 1) throw E.NUM;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239],
    b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1],
    c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let q, r;
  if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};
def('NORM.S.DIST', (a) => { const z = num(a[0]); return a[1] === undefined || bool(a[1]) ? ncdf(z) : Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI); });
def('NORM.DIST', (a) => { const x = num(a[0]), m = num(a[1]), s = num(a[2]); if (s <= 0) throw E.NUM; const z = (x - m) / s; return bool(a[3]) ? ncdf(z) : Math.exp(-z * z / 2) / (s * Math.sqrt(2 * Math.PI)); });
def('NORM.S.INV', (a) => ninv(num(a[0])));
def('NORM.INV', (a) => num(a[1]) + num(a[2]) * ninv(num(a[0])));
def('STANDARDIZE', (a) => (num(a[0]) - num(a[1])) / nz(num(a[2])));

// ---------- logical ----------
def('IF', (c, ctx) => {
  const t = c[0](ctx);
  if (isMulti(t)) {
    const yes = c[1] ? c[1](ctx) : true, no = c[2] ? c[2](ctx) : false;
    return lift2(lift2(t, yes, (x, y) => [bool(x), y]), no, (p, n) => (p[0] ? p[1] : n));
  }
  if (bool(scalar(t))) return c[1] ? d0(c[1](ctx), 0) : true;
  return c[2] ? d0(c[2](ctx), 0) : false;
}, true);
def('IFS', (c, ctx) => {
  for (let i = 0; i + 1 < c.length; i += 2) if (bool(c[i](ctx))) return c[i + 1](ctx);
  throw E.NA;
}, true);
def('SWITCH', (c, ctx) => {
  const v = scalar(c[0](ctx));
  let i = 1;
  for (; i + 1 < c.length; i += 2) if (eq(v, scalar(c[i](ctx)))) return c[i + 1](ctx);
  if (i < c.length) return c[i](ctx);
  throw E.NA;
}, true);
def('CHOOSE', (c, ctx) => { const i = Math.trunc(num(c[0](ctx))); if (i < 1 || i >= c.length) throw E.VALUE; return c[i](ctx); }, true);
const guard = (f, ctx) => { try { return f(ctx); } catch (e) { if (isErr(e)) return e; throw e; } };
def('IFERROR', (c, ctx) => {
  const v = guard(c[0], ctx);
  if (isMulti(v)) return grid(v).map((r) => r.map((x) => (isErr(x) ? scalar(c[1](ctx)) : x)));
  return isErr(scalar(v)) ? c[1](ctx) : v;
}, true);
def('IFNA', (c, ctx) => { const v = guard(c[0], ctx); return scalar(v) === E.NA ? c[1](ctx) : v; }, true);
const isx = (names, f) => def(names, (c, ctx) => { const v = guard(c[0], ctx); return isMulti(v) ? grid(v).map((r) => r.map(f)) : f(scalar(v)); }, true);
isx('ISERROR', isErr);
isx('ISERR', (v) => isErr(v) && v !== E.NA);
isx('ISNA', (v) => v === E.NA);
isx('ISNUMBER', (v) => typeof v === 'number');
isx('ISTEXT', (v) => typeof v === 'string');
isx('ISNONTEXT', (v) => typeof v !== 'string');
isx('ISLOGICAL', (v) => typeof v === 'boolean');
isx('ISBLANK', (v) => v == null);
isx('ISEVEN', (v) => Math.floor(Math.abs(num(v))) % 2 === 0);
isx('ISODD', (v) => Math.floor(Math.abs(num(v))) % 2 === 1);
def('ISFORMULA', (a) => isRef(a[0]) && a[0].sh.cell(a[0].r1, a[0].c1)?.f != null);
def('FORMULATEXT', (a) => { const f = isRef(a[0]) && a[0].sh.cell(a[0].r1, a[0].c1)?.f; if (f == null || f === false) throw E.NA; return '=' + f; });
def('TRUE', () => true); def('FALSE', () => false);
def('NA', () => { throw E.NA; });
def('AND', (a) => logic(a, (x, y) => x && y, true));
def('OR', (a) => logic(a, (x, y) => x || y, false));
def('XOR', (a) => logic(a, (x, y) => x !== y, false));
def('NOT', (a) => lift1(a[0], (v) => !bool(v)));
function logic(a, f, init) {
  let r = init, seen = false;
  for (const x of a) {
    if (x === undefined) continue;
    if (isRef(x) || isArr(x)) eachAny(x, (v) => { if (isErr(v)) throw v; if (typeof v === 'boolean' || typeof v === 'number') { r = f(r, !!v); seen = true; } });
    else { r = f(r, bool(x)); seen = true; }
  }
  if (!seen) throw E.VALUE;
  return r;
}
def('N', (a) => { const v = scalar(a[0]); return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0; });
def('T', (a) => { const v = scalar(a[0]); return typeof v === 'string' ? v : ''; });
def('TYPE', (a) => { const v = scalar(a[0]); return typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 4 : isErr(v) ? 16 : isArr(a[0]) ? 64 : 1; });
def('ERROR.TYPE', (a) => { const v = scalar(a[0]); const i = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'].indexOf(v && v.c); if (i < 0) throw E.NA; return i + 1; });

// ---------- text ----------
const sub = (s, a, n) => s.slice(a, a + n);
def('LEN', (a) => lift1(a[0], (v) => str(v).length));
t1('UPPER', (s) => s.toUpperCase()); t1('LOWER', (s) => s.toLowerCase());
t1('PROPER', (s) => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_, p, c) => p + c.toUpperCase()));
t1('TRIM', (s) => s.replace(/ +/g, ' ').trim());
t1('CLEAN', (s) => s.replace(/[\x00-\x1f]/g, ''));
t1('CODE UNICODE', (s) => { if (!s) throw E.VALUE; return s.codePointAt(0); });
m1('CHAR', (n) => { if (n < 1 || n > 255) throw E.VALUE; return String.fromCharCode(n); });
m1('UNICHAR', (n) => String.fromCodePoint(n));
def('LEFT', (a) => lift2(a[0], a[1], (s, n) => { n = n === undefined ? 1 : num(n); if (n < 0) throw E.VALUE; return str(s).slice(0, n); }));
def('RIGHT', (a) => lift2(a[0], a[1], (s, n) => { n = n === undefined ? 1 : num(n); if (n < 0) throw E.VALUE; s = str(s); return n === 0 ? '' : s.slice(-n); }));
def('MID', (a) => { const s = str(a[0]), st = num(a[1]), n = num(a[2]); if (st < 1 || n < 0) throw E.VALUE; return sub(s, st - 1, n); });
def('CONCAT', (a) => a.map((x) => flat(x).map((v) => str(v)).join('')).join(''));
def('CONCATENATE', (a) => a.map((x) => str(x)).join(''));
def('TEXTJOIN', (a) => {
  const d = str(a[0]), skip = bool(a[1]);
  const parts = [];
  for (const x of a.slice(2)) for (const v of flat(x)) { const s = str(v); if (!(skip && s === '')) parts.push(s); }
  return parts.join(d);
});
def('REPT', (a) => { const n = num(a[1]); if (n < 0) throw E.VALUE; return str(a[0]).repeat(n); });
def('EXACT', (a) => lift2(a[0], a[1], (x, y) => str(x) === str(y)));
def('FIND', (a) => { const i = str(a[1]).indexOf(str(a[0]), a[2] === undefined ? 0 : num(a[2]) - 1); if (i < 0) throw E.VALUE; return i + 1; });
def('SEARCH', (a) => {
  const m = wildRe(str(a[0]), false).exec(str(a[1]).slice(a[2] === undefined ? 0 : num(a[2]) - 1));
  if (!m) throw E.VALUE;
  return m.index + 1 + (a[2] === undefined ? 0 : num(a[2]) - 1);
});
def('SUBSTITUTE', (a) => {
  const s = str(a[0]), o = str(a[1]), n = str(a[2]);
  if (o === '') return s;
  if (a[3] === undefined) return s.split(o).join(n);
  let k = num(a[3]), i = -1;
  while (k-- > 0) { i = s.indexOf(o, i + 1); if (i < 0) return s; }
  return s.slice(0, i) + n + s.slice(i + o.length);
});
def('REPLACE', (a) => { const s = str(a[0]), st = num(a[1]) - 1, n = num(a[2]); return s.slice(0, st) + str(a[3]) + s.slice(st + n); });
def('TEXT', (a) => lift2(a[0], a[1], (v, f) => format(typeof v === 'string' && textToNum(v) === textToNum(v) ? textToNum(v) : v, str(f)).text));
def('VALUE', (a) => lift1(a[0], (v) => {
  if (typeof v === 'number') return v;
  const s = str(v), n = textToNum(s);
  if (n === n) return n;
  const d = parseDateText(s);
  if (d) return d.serial;
  throw E.VALUE;
}));
def('NUMBERVALUE', (a) => {
  const dec = a[1] === undefined ? '.' : str(a[1]), grp = a[2] === undefined ? ',' : str(a[2]);
  const s = str(a[0]).split(grp).join('').replace(dec, '.').replace(/\s/g, '');
  const n = textToNum(s);
  if (n !== n) throw E.VALUE;
  return n;
});
def('FIXED', (a) => { const d = a[1] === undefined ? 2 : num(a[1]); return format(num(a[0]), (a[2] !== undefined && bool(a[2]) ? '0' : '#,##0') + (d > 0 ? '.' + '0'.repeat(d) : '')).text; });
def('DOLLAR', (a) => format(num(a[0]), '$#,##0.00;($#,##0.00)').text);
function splitAt(a, before) {
  const s = str(a[0]), d = str(a[1]);
  let n = a[2] === undefined ? 1 : num(a[2]);
  if (d === '' || n === 0) throw E.VALUE;
  let idx = -1;
  if (n > 0) { let from = 0; while (n-- > 0) { idx = s.indexOf(d, from); if (idx < 0) break; from = idx + d.length; } }
  else { let from = s.length; while (n++ < 0) { idx = from < 0 ? -1 : s.lastIndexOf(d, from); if (idx < 0) break; from = idx - 1; } }
  if (idx < 0) { if (a[5] !== undefined) return a[5]; throw E.NA; }
  return before ? s.slice(0, idx) : s.slice(idx + d.length);
}
def('TEXTBEFORE', (a) => splitAt(a, true));
def('TEXTAFTER', (a) => splitAt(a, false));
def('TEXTSPLIT', (a) => {
  const s = str(a[0]), cd = flat(a[1]).map(str), rd = a[2] === undefined ? [] : flat(a[2]).map(str).filter(Boolean), ign = a[3] !== undefined && bool(a[3]);
  const splitBy = (t, ds) => { if (!ds.length) return [t]; let parts = [t]; for (const d of ds) if (d) parts = parts.flatMap((p) => p.split(d)); return parts; };
  const rows = splitBy(s, rd).map((r) => { let p = splitBy(r, cd); if (ign) p = p.filter((x) => x !== ''); return p; });
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: w }, (_, i) => (i < r.length ? r[i] : E.NA)));
});
const reOf = (p, ci) => { try { return new RegExp(p, ci ? 'i' : ''); } catch { throw E.VALUE; } };
def('REGEXTEST', (a) => reOf(str(a[1]), a[2] !== undefined && num(a[2]) === 1).test(str(a[0])));
def('REGEXEXTRACT', (a) => {
  const s = str(a[0]), mode = a[2] === undefined ? 0 : num(a[2]), ci = a[3] !== undefined && num(a[3]) === 1;
  const re = reOf(str(a[1]), ci);
  if (mode === 1) { const all = s.match(new RegExp(re.source, 'g' + (ci ? 'i' : ''))); if (!all) throw E.NA; return all.map((x) => [x]); }
  const m = re.exec(s);
  if (!m) throw E.NA;
  return mode === 2 ? [m.slice(1)] : m[0];
});
def('REGEXREPLACE', (a) => {
  const ci = a[4] !== undefined && num(a[4]) === 1, occ = a[3] === undefined ? 0 : num(a[3]);
  const re = new RegExp(reOf(str(a[1]), ci).source, (occ === 0 ? 'g' : '') + (ci ? 'i' : ''));
  let k = 0;
  return str(a[0]).replace(re, (...m) => (occ > 0 && ++k !== occ ? m[0] : str(a[2]).replace(/\$(\d)/g, (_, i) => m[+i] ?? '')));
});
def('HYPERLINK', (a) => (a[1] === undefined ? str(a[0]) : scalar(a[1])));

// ---------- dates ----------
const ser = (v) => Math.floor(typeof v === 'string' ? (parseDateText(v)?.serial ?? num(v)) : num(v));
def('TODAY', () => Math.floor(nowSerial()));
def('NOW', () => nowSerial());
def('DATE', (a) => {
  let y = Math.trunc(num(a[0])), m = Math.trunc(num(a[1])), d = Math.trunc(num(a[2]));
  if (y < 1900) y += 1900;
  const t = new Date(0); t.setUTCFullYear(y, m - 1, d);
  return ymdToSerial(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
});
def('TIME', (a) => ((num(a[0]) * 3600 + num(a[1]) * 60 + num(a[2])) / 86400) % 1);
def('DATEVALUE', (a) => { const d = parseDateText(str(a[0])); if (!d) throw E.VALUE; return Math.floor(d.serial); });
def('TIMEVALUE', (a) => { const d = parseDateText(str(a[0])); if (!d) throw E.VALUE; return d.serial % 1; });
def('YEAR', (a) => lift1(a[0], (v) => serialToYMD(ser(v)).y));
def('MONTH', (a) => lift1(a[0], (v) => serialToYMD(ser(v)).m));
def('DAY', (a) => lift1(a[0], (v) => serialToYMD(ser(v)).d));
const secsOf = (v) => Math.round((num(v) % 1) * 86400);
def('HOUR', (a) => lift1(a[0], (v) => Math.floor(secsOf(v) / 3600) % 24));
def('MINUTE', (a) => lift1(a[0], (v) => Math.floor(secsOf(v) / 60) % 60));
def('SECOND', (a) => lift1(a[0], (v) => secsOf(v) % 60));
def('WEEKDAY', (a) => {
  const t = a[1] === undefined ? 1 : num(a[1]), d = serialDow(ser(a[0]));
  return t === 1 ? d + 1 : t === 2 ? ((d + 6) % 7) + 1 : t === 3 ? (d + 6) % 7 : (() => { throw E.NUM; })();
});
def('WEEKNUM', (a) => {
  const s = ser(a[0]), y = serialToYMD(s).y, start = a[1] !== undefined && num(a[1]) === 2 ? 1 : 0;
  const j1 = ymdToSerial(y, 1, 1), off = (serialDow(j1) - start + 7) % 7;
  return Math.floor((s - j1 + off) / 7) + 1;
});
def('ISOWEEKNUM', (a) => {
  const s = ser(a[0]), dow = (serialDow(s) + 6) % 7, thu = s - dow + 3, y = serialToYMD(thu).y;
  return Math.floor((thu - ymdToSerial(y, 1, 1)) / 7) + 1;
});
const addMonths = (s, n) => {
  const { y, m, d } = serialToYMD(s), t = m - 1 + n, yy = y + Math.floor(t / 12), mm = ((t % 12) + 12) % 12 + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return ymdToSerial(yy, mm, Math.min(d, last));
};
def('EDATE', (a) => addMonths(ser(a[0]), Math.trunc(num(a[1]))));
def('EOMONTH', (a) => { const s = addMonths(ser(a[0]), Math.trunc(num(a[1]))), { y, m } = serialToYMD(s); return ymdToSerial(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()); });
def('DAYS', (a) => ser(a[0]) - ser(a[1]));
def('DAYS360', (a) => { const x = serialToYMD(ser(a[0])), y = serialToYMD(ser(a[1])); return (y.y - x.y) * 360 + (y.m - x.m) * 30 + (Math.min(y.d, 30) - Math.min(x.d, 30)); });
def('DATEDIF', (a) => {
  const s = ser(a[0]), e = ser(a[1]), u = str(a[2]).toUpperCase();
  if (e < s) throw E.NUM;
  const x = serialToYMD(s), y = serialToYMD(e);
  let months = (y.y - x.y) * 12 + y.m - x.m - (y.d < x.d ? 1 : 0);
  switch (u) {
    case 'D': return e - s;
    case 'M': return months;
    case 'Y': return Math.floor(months / 12);
    case 'YM': return months % 12;
    case 'MD': return e - addMonths(s, months);
    case 'YD': { let t = ymdToSerial(y.y, x.m, x.d); if (t > e) t = ymdToSerial(y.y - 1, x.m, x.d); return e - t; }
  }
  throw E.NUM;
});
def('YEARFRAC', (a) => {
  const s = ser(a[0]), e = ser(a[1]), b = a[2] === undefined ? 0 : num(a[2]);
  if (b === 1) return Math.abs(e - s) / 365.25;
  if (b === 2) return Math.abs(e - s) / 360;
  if (b === 3) return Math.abs(e - s) / 365;
  const [lo, hi] = s <= e ? [s, e] : [e, s], x = serialToYMD(lo), y = serialToYMD(hi);
  return ((y.y - x.y) * 360 + (y.m - x.m) * 30 + (Math.min(y.d, 30) - Math.min(x.d, 30))) / 360;
});
const holidays = (v) => new Set(v === undefined ? [] : flat(v).filter((x) => typeof x === 'number').map(Math.floor));
const isWork = (s, h) => { const d = serialDow(s); return d !== 0 && d !== 6 && !h.has(s); };
def('NETWORKDAYS', (a) => {
  let s = ser(a[0]), e = ser(a[1]), sign = 1;
  if (e < s) { [s, e] = [e, s]; sign = -1; }
  const h = holidays(a[2]);
  let k = 0;
  for (let d = s; d <= e; d++) if (isWork(d, h)) k++;
  return k * sign;
});
def('WORKDAY', (a) => {
  let d = ser(a[0]), n = Math.trunc(num(a[1]));
  const h = holidays(a[2]), step = n < 0 ? -1 : 1;
  while (n !== 0) { d += step; if (isWork(d, h)) n -= step; }
  return d;
});

// ---------- financial ----------
const pmt = (r, n, pv, fv, t) => (r === 0 ? -(pv + fv) / n : -(r * (pv * Math.pow(1 + r, n) + fv)) / ((1 + r * t) * (Math.pow(1 + r, n) - 1)));
const fvf = (r, n, p, pv, t) => (r === 0 ? -(pv + p * n) : -(pv * Math.pow(1 + r, n) + p * (1 + r * t) * (Math.pow(1 + r, n) - 1) / r));
def('PMT', (a) => pmt(num(a[0]), num(a[1]), num(a[2]), a[3] === undefined ? 0 : num(a[3]), a[4] === undefined ? 0 : num(a[4])));
def('FV', (a) => fvf(num(a[0]), num(a[1]), num(a[2]), a[3] === undefined ? 0 : num(a[3]), a[4] === undefined ? 0 : num(a[4])));
def('PV', (a) => {
  const r = num(a[0]), n = num(a[1]), p = num(a[2]), fv = a[3] === undefined ? 0 : num(a[3]), t = a[4] === undefined ? 0 : num(a[4]);
  return r === 0 ? -(fv + p * n) : -(fv + p * (1 + r * t) * (Math.pow(1 + r, n) - 1) / r) / Math.pow(1 + r, n);
});
def('NPER', (a) => {
  const r = num(a[0]), p = num(a[1]), pv = num(a[2]), fv = a[3] === undefined ? 0 : num(a[3]), t = a[4] === undefined ? 0 : num(a[4]);
  if (r === 0) return -(pv + fv) / p;
  const q = p * (1 + r * t);
  return Math.log((q - fv * r) / (q + pv * r)) / Math.log(1 + r);
});
const newton = (f, x, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    const y = f(x), h = 1e-7, dy = (f(x + h) - y) / h;
    if (!isFinite(y) || dy === 0) break;
    const nx = x - y / dy;
    if (Math.abs(nx - x) < 1e-12) return nx;
    x = nx;
  }
  throw E.NUM;
};
def('RATE', (a) => {
  const n = num(a[0]), p = num(a[1]), pv = num(a[2]), fv = a[3] === undefined ? 0 : num(a[3]), t = a[4] === undefined ? 0 : num(a[4]), g = a[5] === undefined ? 0.1 : num(a[5]);
  return newton((r) => (r === 0 ? pv + p * n + fv : pv * Math.pow(1 + r, n) + p * (1 + r * t) * (Math.pow(1 + r, n) - 1) / r + fv), g);
});
def('NPV', (a) => { const r = num(a[0]); return collect(a.slice(1)).reduce((s, v, i) => s + v / Math.pow(1 + r, i + 1), 0); });
def('IRR', (a) => { const v = collect([a[0]]); return newton((r) => v.reduce((s, x, i) => s + x / Math.pow(1 + r, i), 0), a[1] === undefined ? 0.1 : num(a[1])); });
def('XNPV', (a) => { const r = num(a[0]), v = flat(a[1]).map(num), d = flat(a[2]).map(num); return v.reduce((s, x, i) => s + x / Math.pow(1 + r, (d[i] - d[0]) / 365), 0); });
def('XIRR', (a) => { const v = flat(a[0]).map(num), d = flat(a[1]).map(num); return newton((r) => v.reduce((s, x, i) => s + x / Math.pow(1 + r, (d[i] - d[0]) / 365), 0), a[2] === undefined ? 0.1 : num(a[2])); });
def('IPMT', (a) => { const r = num(a[0]), per = num(a[1]), n = num(a[2]), pv = num(a[3]), fv = a[4] === undefined ? 0 : num(a[4]), t = a[5] === undefined ? 0 : num(a[5]); const p = pmt(r, n, pv, fv, t); return (t && per === 1 ? 0 : fvf(r, per - 1 - (t ? 1 : 0), p, pv, t) * -r) || 0; });
def('PPMT', (a) => { const r = num(a[0]), per = num(a[1]), n = num(a[2]), pv = num(a[3]), fv = a[4] === undefined ? 0 : num(a[4]), t = a[5] === undefined ? 0 : num(a[5]); const p = pmt(r, n, pv, fv, t); return p - (t && per === 1 ? 0 : fvf(r, per - 1 - (t ? 1 : 0), p, pv, t) * -r); });
def('SLN', (a) => (num(a[0]) - num(a[1])) / nz(num(a[2])));
def('SYD', (a) => { const c = num(a[0]), s = num(a[1]), l = num(a[2]), p = num(a[3]); return (c - s) * (l - p + 1) * 2 / (l * (l + 1)); });

// ---------- lookup & reference ----------
const looseEq = (v) => {
  if (typeof v === 'string' && /[*?~]/.test(v)) { const re = wildRe(v); return (x) => typeof x === 'string' && re.test(x); }
  if (v == null) v = 0;
  const r = typeof v;
  return (x) => (x == null ? 0 : x) !== undefined && typeof (x == null ? 0 : x) === r && cmp(x, v) === 0;
};
function findIn(list, v, mode, rev) {
  const n = list.length, idx = (i) => (rev ? n - 1 - i : i);
  if (mode === 0 || mode === 2) {
    const p = mode === 2 ? looseEq(v) : (x) => { if (typeof v === 'string' && typeof x === 'string') return x.toLowerCase() === v.toLowerCase(); return (x == null ? 0 : x) === (v == null ? 0 : v); };
    for (let i = 0; i < n; i++) if (p(list[idx(i)])) return idx(i);
    return -1;
  }
  let best = -1;
  for (let i = 0; i < n; i++) {
    const x = list[i];
    if (x == null || typeof x !== typeof v) continue;
    const c = cmp(x, v);
    if (c === 0) return i;
    if (mode < 0 ? c < 0 && (best < 0 || cmp(x, list[best]) > 0) : c > 0 && (best < 0 || cmp(x, list[best]) < 0)) best = i;
  }
  return best;
}
def('VLOOKUP', (a) => {
  const v = scalar(a[0]), g = grid(a[1]), ci = Math.trunc(num(a[2])) - 1;
  if (ci < 0 || ci >= g[0].length) throw E.REF;
  if (a[3] !== undefined && !bool(a[3])) {
    const i = findIn(g.map((r) => r[0]), v, typeof v === 'string' ? 2 : 0, false);
    if (i < 0) throw E.NA;
    return g[i][ci];
  }
  let best = -1;
  for (let i = 0; i < g.length; i++) { const x = g[i][0]; if (x != null && typeof x === typeof v && cmp(x, v) <= 0) best = i; else if (x != null && typeof x === typeof v) break; }
  if (best < 0) throw E.NA;
  return g[best][ci];
});
def('HLOOKUP', (a) => {
  const v = scalar(a[0]), g = grid(a[1]), ri = Math.trunc(num(a[2])) - 1;
  if (ri < 0 || ri >= g.length) throw E.REF;
  if (a[3] !== undefined && !bool(a[3])) { const i = findIn(g[0], v, typeof v === 'string' ? 2 : 0, false); if (i < 0) throw E.NA; return g[ri][i]; }
  let best = -1;
  for (let i = 0; i < g[0].length; i++) { const x = g[0][i]; if (x != null && typeof x === typeof v && cmp(x, v) <= 0) best = i; else if (x != null && typeof x === typeof v) break; }
  if (best < 0) throw E.NA;
  return g[ri][best];
});
def('XLOOKUP', (a) => {
  const v = scalar(a[0]), la = grid(a[1]), ra = grid(a[2]);
  const mm = a[4] === undefined ? 0 : num(a[4]), sm = a[5] === undefined ? 1 : num(a[5]);
  const byRow = la.length === 1 && la[0].length > 1;
  const list = byRow ? la[0] : la.map((r) => r[0]);
  const i = findIn(list, v, mm, sm < 0);
  if (i < 0) { if (a[3] !== undefined) return a[3]; throw E.NA; }
  if (byRow) { const col = ra.map((r) => [r[i]]); return col.length === 1 ? col[0][0] : col; }
  return ra[i].length === 1 ? ra[i][0] : [ra[i]];
});
def('XMATCH', (a) => { const g = grid(a[1]), i = findIn(g.flat(), scalar(a[0]), a[2] === undefined ? 0 : num(a[2]), a[3] !== undefined && num(a[3]) < 0); if (i < 0) throw E.NA; return i + 1; });
def('MATCH', (a) => {
  const v = scalar(a[0]), list = grid(a[1]).flat(), t = a[2] === undefined ? 1 : num(a[2]);
  let i;
  if (t === 0) i = findIn(list, v, typeof v === 'string' ? 2 : 0, false);
  else if (t > 0) { i = -1; for (let k = 0; k < list.length; k++) { const x = list[k]; if (x != null && typeof x === typeof v) { if (cmp(x, v) <= 0) i = k; else break; } } }
  else { i = -1; for (let k = 0; k < list.length; k++) { const x = list[k]; if (x != null && typeof x === typeof v) { if (cmp(x, v) >= 0) i = k; else break; } } }
  if (i < 0) throw E.NA;
  return i + 1;
});
def('LOOKUP', (a) => {
  const v = scalar(a[0]), list = grid(a[1]).flat(), res = a[2] === undefined ? list : grid(a[2]).flat();
  let best = -1;
  for (let k = 0; k < list.length; k++) { const x = list[k]; if (x != null && typeof x === typeof v) { if (cmp(x, v) <= 0) best = k; else break; } }
  if (best < 0) throw E.NA;
  return res[best];
});
def('INDEX', (a) => {
  const x = a[0], g = isRef(x) ? null : grid(x);
  let r = a[1] === undefined ? 0 : Math.trunc(num(a[1])), c = a[2] === undefined ? 0 : Math.trunc(num(a[2]));
  const R = isRef(x) ? x.r2 - x.r1 + 1 : g.length, C = isRef(x) ? x.c2 - x.c1 + 1 : g[0].length;
  if (a[2] === undefined && R === 1 && C > 1) { c = r; r = 0; }
  if (r < 0 || c < 0 || r > R || c > C) throw E.REF;
  const r1 = r ? r - 1 : 0, r2 = r ? r - 1 : R - 1, c1 = c ? c - 1 : 0, c2 = c ? c - 1 : C - 1;
  if (isRef(x)) return { ref: true, sh: x.sh, r1: x.r1 + r1, r2: x.r1 + r2, c1: x.c1 + c1, c2: x.c1 + c2 };
  return g.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1));
});
def('OFFSET', (a) => {
  const x = a[0];
  if (!isRef(x)) throw E.VALUE;
  const r1 = x.r1 + num(a[1]), c1 = x.c1 + num(a[2]);
  const h = a[3] === undefined ? x.r2 - x.r1 + 1 : num(a[3]), w = a[4] === undefined ? x.c2 - x.c1 + 1 : num(a[4]);
  if (r1 < 0 || c1 < 0 || h < 1 || w < 1) throw E.REF;
  return { ref: true, sh: x.sh, r1, c1, r2: r1 + h - 1, c2: c1 + w - 1 };
});
def('INDIRECT', (a, ctx) => ctx.wb.refFromString(str(a[0]), ctx.sheet) || (() => { throw E.REF; })());
def('ROW', (a, ctx) => {
  if (a[0] === undefined) return ctx.row + 1;
  if (!isRef(a[0])) throw E.VALUE;
  const n = a[0].r2 - a[0].r1 + 1;
  return n === 1 ? a[0].r1 + 1 : Array.from({ length: Math.min(n, 100000) }, (_, i) => [a[0].r1 + i + 1]);
});
def('COLUMN', (a, ctx) => {
  if (a[0] === undefined) return ctx.col + 1;
  if (!isRef(a[0])) throw E.VALUE;
  const n = a[0].c2 - a[0].c1 + 1;
  return n === 1 ? a[0].c1 + 1 : [Array.from({ length: Math.min(n, 16384) }, (_, i) => a[0].c1 + i + 1)];
});
def('ROWS', (a) => (isRef(a[0]) ? a[0].r2 - a[0].r1 + 1 : grid(a[0]).length));
def('COLUMNS', (a) => (isRef(a[0]) ? a[0].c2 - a[0].c1 + 1 : grid(a[0])[0].length));
def('ADDRESS', (a) => {
  const r = num(a[0]), c = num(a[1]), t = a[2] === undefined ? 1 : num(a[2]);
  const s = (t === 1 || t === 3 ? '$' : '') + colName(c - 1) + (t === 1 || t === 2 ? '$' : '') + r;
  const fixed = t === 1 ? `$${colName(c - 1)}$${r}` : t === 2 ? `${colName(c - 1)}$${r}` : t === 3 ? `$${colName(c - 1)}${r}` : `${colName(c - 1)}${r}`;
  return (a[4] === undefined ? '' : /^[\w.]+$/.test(str(a[4])) ? str(a[4]) + '!' : `'${str(a[4])}'!`) + (s && fixed);
});
def('SPARKLINE', (a) => {
  const data = flat(a[0]).map((v) => (typeof v === 'number' ? v : null));
  const o = a[1] === undefined ? '' : String(scalar(a[1])).toLowerCase();
  return { spark: true, data, type: o === 'column' || o === 'winloss' ? o : 'line' };
});

// ---------- dynamic arrays ----------
const rect = (g) => g.map((r) => r.slice());
def('SEQUENCE', (a) => {
  const R = Math.trunc(num(a[0])), C = a[1] === undefined ? 1 : Math.trunc(num(a[1])), s = a[2] === undefined ? 1 : num(a[2]), st = a[3] === undefined ? 1 : num(a[3]);
  if (R < 1 || C < 1 || R * C > 4e6) throw E.CALC;
  return Array.from({ length: R }, (_, i) => Array.from({ length: C }, (_, j) => s + (i * C + j) * st));
});
def('RANDARRAY', (a) => {
  const R = a[0] === undefined ? 1 : num(a[0]), C = a[1] === undefined ? 1 : num(a[1]), lo = a[2] === undefined ? 0 : num(a[2]), hi = a[3] === undefined ? 1 : num(a[3]), int = a[4] !== undefined && bool(a[4]);
  return Array.from({ length: R }, () => Array.from({ length: C }, () => (int ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo))));
});
def('TRANSPOSE', (a) => { const g = grid(a[0]); return g[0].map((_, j) => g.map((r) => r[j])); });
function sortRows(g, keys, orders, byCol) {
  const t = byCol ? g[0].map((_, j) => g.map((r) => r[j])) : rect(g);
  const idx = t.map((_, i) => i);
  idx.sort((x, y) => {
    for (let k = 0; k < keys.length; k++) {
      const a = keys[k][x], b = keys[k][y];
      const ea = a == null || a === '', eb = b == null || b === '';
      const c = ea || eb ? (ea && eb ? 0 : ea ? 1 : -1) * orders[k] : cmp(a, b) * orders[k];
      if (c) return c;
    }
    return x - y;
  });
  const out = idx.map((i) => t[i]);
  return byCol ? out[0].map((_, j) => out.map((r) => r[j])) : out;
}
def('SORT', (a) => {
  const g = grid(a[0]), byCol = a[3] !== undefined && bool(a[3]), ix = a[1] === undefined ? 0 : num(a[1]) - 1;
  const t = byCol ? g[0].map((_, j) => g.map((r) => r[j])) : g;
  if (ix < 0 || ix >= t[0].length) throw E.VALUE;
  return sortRows(g, [t.map((r) => r[ix])], [a[2] !== undefined && num(a[2]) === -1 ? -1 : 1], byCol);
});
def('SORTBY', (a) => {
  const g = grid(a[0]), keys = [], orders = [];
  for (let i = 1; i < a.length; i += 2) {
    const k = flat(a[i]);
    if (k.length !== g.length) throw E.VALUE;
    keys.push(k); orders.push(a[i + 1] !== undefined && num(a[i + 1]) === -1 ? -1 : 1);
  }
  return sortRows(g, keys, orders, false);
});
def('FILTER', (a) => {
  const g = grid(a[0]), inc = grid(a[1]);
  const byRow = inc[0].length === 1 || inc.length === g.length && inc[0].length === 1;
  let out;
  if (inc.length === g.length && inc[0].length === 1) out = g.filter((_, i) => bool(inc[i][0]));
  else if (inc.length === 1 && inc[0].length === g[0].length) { const keep = inc[0].map(bool); out = g.map((r) => r.filter((_, j) => keep[j])); if (!out[0].length) out = []; }
  else throw E.VALUE;
  if (!out.length) { if (a[2] !== undefined) return a[2]; throw E.CALC; }
  return out;
});
def('UNIQUE', (a) => {
  const g = grid(a[0]), byCol = a[1] !== undefined && bool(a[1]), once = a[2] !== undefined && bool(a[2]);
  const t = byCol ? g[0].map((_, j) => g.map((r) => r[j])) : g;
  const seen = new Map();
  t.forEach((r, i) => { const k = JSON.stringify(r.map((v) => (typeof v === 'string' ? v.toLowerCase() : v))); const e = seen.get(k); if (e) e.n++; else seen.set(k, { i, n: 1 }); });
  const rows = [...seen.values()].filter((e) => !once || e.n === 1).map((e) => t[e.i]);
  if (!rows.length) throw E.CALC;
  return byCol ? rows[0].map((_, j) => rows.map((r) => r[j])) : rows;
});
def('VSTACK', (a) => { const gs = a.map(grid), w = Math.max(...gs.map((g) => g[0].length)); return gs.flatMap((g) => g.map((r) => Array.from({ length: w }, (_, j) => (j < r.length ? r[j] : E.NA)))); });
def('HSTACK', (a) => { const gs = a.map(grid), h = Math.max(...gs.map((g) => g.length)); return Array.from({ length: h }, (_, i) => gs.flatMap((g) => (i < g.length ? g[i] : Array(g[0].length).fill(E.NA)))); });
def('TOCOL', (a) => { const g = grid(a[0]); const ign = a[1] === undefined ? 0 : num(a[1]); const l = (a[2] !== undefined && bool(a[2]) ? g[0].map((_, j) => g.map((r) => r[j])) : g).flat().filter((v) => !(ign % 2 === 1 && v == null) && !(ign >= 2 && isErr(v))); return l.map((v) => [v]); });
def('TOROW', (a) => { const g = grid(a[0]); const ign = a[1] === undefined ? 0 : num(a[1]); return [(a[2] !== undefined && bool(a[2]) ? g[0].map((_, j) => g.map((r) => r[j])) : g).flat().filter((v) => !(ign % 2 === 1 && v == null) && !(ign >= 2 && isErr(v)))]; });
def('TAKE', (a) => {
  const g = grid(a[0]), r = a[1] === undefined ? g.length : Math.trunc(num(a[1])), c = a[2] === undefined ? g[0].length : Math.trunc(num(a[2]));
  const rows = r >= 0 ? g.slice(0, r) : g.slice(r);
  if (!rows.length) throw E.CALC;
  return rows.map((x) => (c >= 0 ? x.slice(0, c) : x.slice(c)));
});
def('DROP', (a) => {
  const g = grid(a[0]), r = a[1] === undefined ? 0 : Math.trunc(num(a[1])), c = a[2] === undefined ? 0 : Math.trunc(num(a[2]));
  const rows = r >= 0 ? g.slice(r) : g.slice(0, r);
  if (!rows.length || !rows[0].slice(c >= 0 ? c : 0, c < 0 ? c : undefined).length) throw E.CALC;
  return rows.map((x) => (c >= 0 ? x.slice(c) : x.slice(0, c)));
});
def('CHOOSECOLS', (a) => { const g = grid(a[0]); const ix = a.slice(1).flatMap(flat).map((n) => { n = num(n); n = n < 0 ? g[0].length + n + 1 : n; if (n < 1 || n > g[0].length) throw E.VALUE; return n - 1; }); return g.map((r) => ix.map((i) => r[i])); });
def('CHOOSEROWS', (a) => { const g = grid(a[0]); return a.slice(1).flatMap(flat).map((n) => { n = num(n); n = n < 0 ? g.length + n + 1 : n; if (n < 1 || n > g.length) throw E.VALUE; return g[n - 1].slice(); }); });
def('WRAPROWS', (a) => { const l = flat(a[0]), w = Math.trunc(num(a[1])), out = []; for (let i = 0; i < l.length; i += w) { const r = l.slice(i, i + w); while (r.length < w) r.push(a[2] === undefined ? E.NA : a[2]); out.push(r); } return out; });

// ---------- LET / LAMBDA ----------
def('LET', (c, ctx, nodes) => {
  let env = Object.create(ctx.env || null);
  const cx = { ...ctx, env };
  for (let i = 0; i + 1 < c.length; i += 2) {
    if (nodes[i].t !== 'name') throw E.NAME;
    env[nodes[i].n.toUpperCase()] = c[i + 1](cx);
  }
  return c[c.length - 1](cx);
}, true);
def('LAMBDA', (c, ctx, nodes) => {
  const params = nodes.slice(0, -1).map((n) => { if (n.t !== 'name') throw E.NAME; return n.n.toUpperCase(); });
  return { lambda: true, params, body: c[c.length - 1], env: ctx.env };
}, true);
const lam = (v) => { if (!isLambda(v)) throw E.VALUE; return v; };
const call = (l, vals, ctx) => { const r = callLambda(l, vals, ctx); return isRef(r) ? scalar(r) : r; };
def('MAP', (a, ctx) => {
  const l = lam(a[a.length - 1]), gs = a.slice(0, -1).map(grid);
  const R = gs[0].length, C = gs[0][0].length;
  if (gs.some((g) => g.length !== R || g[0].length !== C)) throw E.VALUE;
  return Array.from({ length: R }, (_, i) => Array.from({ length: C }, (_, j) => scalar(call(l, gs.map((g) => g[i][j]), ctx))));
});
def('REDUCE', (a, ctx) => { const l = lam(a[2]); let acc = a[0]; for (const v of flat(a[1])) acc = call(l, [acc, v], ctx); return acc; });
def('SCAN', (a, ctx) => { const l = lam(a[2]), g = grid(a[1]); let acc = a[0]; return g.map((r) => r.map((v) => (acc = call(l, [acc, v], ctx)))); });
def('BYROW', (a, ctx) => grid(a[0]).map((r) => [scalar(call(lam(a[1]), [[r]], ctx))]));
def('BYCOL', (a, ctx) => { const g = grid(a[0]); return [g[0].map((_, j) => scalar(call(lam(a[1]), [g.map((r) => [r[j]])], ctx)))]; });
def('MAKEARRAY', (a, ctx) => { const l = lam(a[2]); return Array.from({ length: num(a[0]) }, (_, i) => Array.from({ length: num(a[1]) }, (_, j) => scalar(call(l, [i + 1, j + 1], ctx)))); });

// ---------- GROUPBY / PIVOTBY (live pivots) ----------
const cols2 = (g) => g[0].map((_, j) => g.map((r) => r[j]));
const keyOf = (t) => JSON.stringify(t.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)));
function pivotArgs(rg, vg, hdr) {
  if (rg.length !== vg.length) throw E.VALUE;
  const auto = hdr === undefined;
  const has = auto ? typeof vg[0][0] === 'string' && rg.length > 1 : hdr === 1 || hdr === 3;
  const show = auto ? has : hdr === 2 || hdr === 3;
  return { has, show, rh: has ? rg[0] : rg[0].map((_, i) => `Group ${i + 1}`), vh: has ? vg[0] : vg[0].map((_, i) => `Values ${i + 1}`), rows: has ? rg.slice(1) : rg, vals: has ? vg.slice(1) : vg };
}
function applySort(out, order, nKey, keepLast) {
  const specs = (order === undefined ? [] : flat(order).map(num)).filter(Boolean);
  const body = keepLast ? out.slice(0, -1) : out, tail = keepLast ? [out[out.length - 1]] : [];
  const use = specs.length ? specs : Array.from({ length: nKey }, (_, i) => i + 1);
  body.sort((a, b) => { for (const s of use) { const i = Math.abs(s) - 1, c = cmp(a[i], b[i]) * (s < 0 ? -1 : 1); if (c) return c; } return 0; });
  return [...body, ...tail];
}
def('GROUPBY', (a, ctx) => {
  const fn = a[2];
  if (!isLambda(fn)) throw E.VALUE;
  const p = pivotArgs(grid(a[0]), grid(a[1]), a[3] === undefined ? undefined : num(a[3]));
  const depth = a[4] === undefined ? 1 : num(a[4]), keep = a[6] === undefined ? null : flat(a[6]).map((v) => bool(v));
  const idx = p.rows.map((_, i) => i).filter((i) => !keep || keep[i + (p.has ? 1 : 0)] !== false);
  const groups = new Map();
  for (const i of idx) { const k = keyOf(p.rows[i]); if (!groups.has(k)) groups.set(k, { key: p.rows[i], ix: [] }); groups.get(k).ix.push(i); }
  const agg = (ix, j) => { const r = callLambda(fn, [ix.map((i) => [p.vals[i][j]])], ctx); const v = scalar(r); if (isErr(v)) throw v; return v; };
  const nv = p.vals[0] ? p.vals[0].length : 0, nk = p.rh.length;
  let out = [...groups.values()].map((g) => [...g.key, ...Array.from({ length: nv }, (_, j) => agg(g.ix, j))]);
  out = applySort(out, a[5], nk);
  if (depth !== 0) {
    const tot = [...Array.from({ length: nk }, (_, i) => (i ? '' : 'Total')), ...Array.from({ length: nv }, (_, j) => agg(idx, j))];
    depth < 0 ? out.unshift(tot) : out.push(tot);
  }
  if (p.show) out.unshift([...p.rh, ...p.vh]);
  return out;
});
def('PIVOTBY', (a, ctx) => {
  const fn = a[3];
  if (!isLambda(fn)) throw E.VALUE;
  const rg = grid(a[0]), cg = grid(a[1]), vg = grid(a[2]);
  if (cg.length !== rg.length) throw E.VALUE;
  const hdr = a[4] === undefined ? undefined : num(a[4]);
  const pr = pivotArgs(rg, vg, hdr), pc = pivotArgs(cg, vg, hdr);
  const rdep = a[5] === undefined ? 1 : num(a[5]), cdep = a[7] === undefined ? 1 : num(a[7]);
  const keep = a[9] === undefined ? null : flat(a[9]).map((v) => bool(v));
  const idx = pr.rows.map((_, i) => i).filter((i) => !keep || keep[i + (pr.has ? 1 : 0)] !== false);
  const rgs = new Map(), cgs = new Map();
  for (const i of idx) {
    const rk = keyOf(pr.rows[i]), ck = keyOf(pc.rows[i]);
    if (!rgs.has(rk)) rgs.set(rk, { key: pr.rows[i], ix: [] });
    rgs.get(rk).ix.push(i);
    if (!cgs.has(ck)) cgs.set(ck, { key: pc.rows[i], ix: new Set() });
    cgs.get(ck).ix.add(i);
  }
  const nv = pr.vals[0] ? pr.vals[0].length : 0, nk = pr.rh.length;
  const agg = (ix, j) => { const r = callLambda(fn, [ix.map((i) => [pr.vals[i][j]])], ctx); const v = scalar(r); if (isErr(v)) throw v; return v; };
  let ckeys = [...cgs.values()].sort((x, y) => { for (let i = 0; i < x.key.length; i++) { const c = cmp(x.key[i], y.key[i]); if (c) return c; } return 0; });
  if (a[8] !== undefined && num(a[8]) < 0) ckeys.reverse();
  const label = (g) => g.key.map(String).join(' / ');
  const heads = [];
  for (const g of ckeys) for (let j = 0; j < nv; j++) heads.push(nv > 1 ? `${label(g)} – ${pr.vh[j]}` : label(g));
  if (cdep !== 0) for (let j = 0; j < nv; j++) heads.push(nv > 1 ? `Total – ${pr.vh[j]}` : 'Total');
  const cells = (ixs) => {
    const row = [];
    for (const g of ckeys) { const sub = ixs.filter((i) => g.ix.has(i)); for (let j = 0; j < nv; j++) row.push(sub.length ? agg(sub, j) : ''); }
    if (cdep !== 0) for (let j = 0; j < nv; j++) row.push(ixs.length ? agg(ixs, j) : '');
    return row;
  };
  let out = [...rgs.values()].map((g) => [...g.key, ...cells(g.ix)]);
  const ord = a[6];
  if (ord !== undefined) out = applySort(out, ord, nk); else out = applySort(out, undefined, nk);
  if (rdep !== 0) { const tot = [...Array.from({ length: nk }, (_, i) => (i ? '' : 'Total')), ...cells(idx)]; rdep < 0 ? out.unshift(tot) : out.push(tot); }
  const top = [...pr.rh.map((h, i) => (i === pr.rh.length - 1 && pc.rh.length ? `${h} ↓ ${pc.rh.join(' / ')} →` : h)), ...heads];
  if (pr.show) out.unshift(top);
  return out;
});

// Functions the XLSX writer must prefix with _xlfn. and ones it cannot express at all.
export const XLFN = new Set('XLOOKUP XMATCH IFS SWITCH CONCAT TEXTJOIN MAXIFS MINIFS IFNA XOR DAYS ISOWEEKNUM STDEV.S STDEV.P VAR.S VAR.P MODE.SNGL RANK.EQ PERCENTILE.INC QUARTILE.INC NORM.DIST NORM.S.DIST NORM.INV NORM.S.INV FORECAST.LINEAR NUMBERVALUE UNICODE UNICHAR FORMULATEXT ISFORMULA TEXTBEFORE TEXTAFTER TEXTSPLIT UNIQUE SEQUENCE RANDARRAY SORTBY LET LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY REGEXTEST REGEXEXTRACT REGEXREPLACE VSTACK HSTACK TOCOL TOROW TAKE DROP CHOOSECOLS CHOOSEROWS WRAPROWS GROUPBY PIVOTBY'.split(' '));
export const XLWS = new Set('SORT FILTER'.split(' ')); // these two live in the _xlws namespace
export const NOEXPORT = /\bSPARKLINE\(/i; // no Excel equivalent: saved as the cached value
export const XLPM = new Set(['LET', 'LAMBDA']); // functions whose parameter names need the _xlpm. prefix

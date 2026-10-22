// Value model, coercion, dates, array helpers shared by the engine and the function library.
export class SErr {
  constructor(c) { this.c = c; }
  toString() { return this.c; }
}
const mk = (c) => new SErr(c);
export const E = {
  NA: mk('#N/A'), REF: mk('#REF!'), VALUE: mk('#VALUE!'), DIV0: mk('#DIV/0!'), NAME: mk('#NAME?'),
  NUM: mk('#NUM!'), NULL: mk('#NULL!'), SPILL: mk('#SPILL!'), CALC: mk('#CALC!'), CIRC: mk('#CIRC!'),
};
const BYCODE = Object.fromEntries(Object.values(E).map((e) => [e.c, e]));
export const errOf = (c) => BYCODE[c.toUpperCase()] || null;
export const isErr = (v) => v instanceof SErr;
export const isRef = (v) => v !== null && typeof v === 'object' && v.ref === true;
export const isArr = Array.isArray;
export const isLambda = (v) => v !== null && typeof v === 'object' && v.lambda === true;
export const isMulti = (v) => (isRef(v) ? v.r2 > v.r1 || v.c2 > v.c1 : isArr(v));

// ---- number <-> text ----
export function numStr(n) {
  if (!isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(+n.toPrecision(15)).replace('e', 'E').replace('E+', 'E+');
}

// Excel "General" format, fitted to roughly 11 characters.
export function general(n) {
  if (!isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-4) return n.toExponential(5).replace(/\.?0+e/, 'e').replace('e', 'E').replace(/E([+-])(\d)$/, 'E$10$2');
  let s = String(+n.toPrecision(10));
  if (s.length > 11) s = String(+n.toPrecision(Math.max(1, 11 - (Math.floor(Math.log10(a)) + 2))));
  return s;
}

const NUMRE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i;
const CURRE = /^(\()?([-+])?[$€£₹¥]?([-+])?((?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?)(%)?(\))?$/;
export function textToNum(s) {
  if (NUMRE.test(s)) return +s;
  const t = s.trim();
  if (!t) return NaN;
  const m = CURRE.exec(t);
  if (!m || !/\d/.test(m[4]) || !!m[1] !== !!m[6]) return NaN;
  let v = +m[4].replace(/,/g, '');
  if (m[5]) v /= 100;
  return (m[1] || m[2] === '-' || m[3] === '-') ? -v : v;
}

// ---- dates (1900 system, including the leap-year quirk) ----
export function serialToYMD(s) {
  let n = Math.floor(s);
  if (n === 60) return { y: 1900, m: 2, d: 29 };
  if (n < 60) n++;
  const d = new Date(Date.UTC(1899, 11, 30) + n * 864e5);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
export function ymdToSerial(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  let n = Math.round(dt.getTime() / 864e5) + 25569;
  if (n < 61) n--;
  return n;
}
export const serialDow = (s) => { let n = Math.floor(s); if (n < 61) n++; return (n + 6) % 7; }; // 0 = Sunday
export const nowSerial = () => {
  const d = new Date();
  return ymdToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
};
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(am|pm|a|p)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2], se = m[3] ? +m[3] : 0;
  if (m[4]) { const pm = /^p/i.test(m[4]); if (h < 1 || h > 12) return null; h = (h % 12) + (pm ? 12 : 0); }
  if (h > 23 || mi > 59 || se > 59) return null;
  return (h * 3600 + mi * 60 + se) / 86400;
}

export function parseDateText(str) {
  let s = str.trim(), time = null, m;
  const tm = /\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m?)?)$/i.exec(s) || /T(\d{1,2}:\d{2}(?::\d{2})?)Z?$/.exec(s);
  if (tm) { time = parseTime(tm[1]); if (time == null) return null; s = s.slice(0, tm.index); }
  else if ((time = parseTime(s)) != null) return { serial: time, kind: 'time' };
  let y, mo, d;
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s))) {
    let a = +m[1], b = +m[2];
    y = +m[3]; if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
    if (a > 12 && b <= 12) { d = a; mo = b; } else { mo = a; d = b; }
  } else if ((m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -,]*(\d{2,4})$/.exec(s))) {
    d = +m[1]; mo = MON.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; y = +m[3]; if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
  } else if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    mo = MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = +m[2]; y = +m[3];
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y < 10000)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return { serial: ymdToSerial(y, mo, d) + (time || 0), kind: time != null ? 'datetime' : 'date' };
}

// Interpret text typed into a cell. Returns { v, nf? }.
export function parseInput(s) {
  if (s === '' || s == null) return { v: null };
  if (typeof s !== 'string') return { v: s };
  if (s[0] === "'") return { v: s.slice(1) };
  if (/^(true|false)$/i.test(s)) return { v: s.toLowerCase() === 'true' };
  const n = textToNum(s);
  if (n === n) {
    const t = s.trim();
    if (/%$/.test(t)) return { v: n, nf: /\.\d/.test(t) ? '0.00%' : '0%' };
    if (/^\(?[-+]?[$€£₹¥]/.test(t)) return { v: n, nf: '"' + (/[$€£₹¥]/.exec(t)[0]) + '"#,##0.00' };
    if (/\d,\d{3}/.test(t) && !/e/i.test(t)) return { v: n, nf: /\./.test(t) ? '#,##0.00' : '#,##0' };
    return { v: n };
  }
  const d = parseDateText(s);
  if (d) return { v: d.serial, nf: d.kind === 'time' ? 'h:mm:ss' : d.kind === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm' };
  return { v: s };
}

// ---- coercion ----
export function scalar(v) {
  if (isRef(v)) return v.sh.get(v.r1, v.c1);
  if (isArr(v)) return v[0][0];
  return v;
}
export function num(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') { const n = textToNum(v); if (n !== n) throw E.VALUE; return n; }
  if (isErr(v)) throw v;
  if (isRef(v) || isArr(v)) return num(scalar(v));
  throw E.VALUE;
}
export function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numStr(v);
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isErr(v)) throw v;
  if (isRef(v) || isArr(v)) return str(scalar(v));
  throw E.VALUE;
}
export function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v == null) return false;
  if (typeof v === 'string') {
    const u = v.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    throw E.VALUE;
  }
  if (isErr(v)) throw v;
  if (isRef(v) || isArr(v)) return bool(scalar(v));
  throw E.VALUE;
}

// ---- ranges and arrays ----
export function grid(v) {
  if (isRef(v)) {
    const sh = v.sh;
    const r2 = v.r2 >= 1048575 ? Math.max(v.r1, Math.min(v.r2, sh.maxR)) : v.r2;
    const c2 = v.c2 >= 16383 ? Math.max(v.c1, Math.min(v.c2, sh.maxC)) : v.c2;
    const out = [];
    for (let r = v.r1; r <= r2; r++) {
      const row = [];
      for (let c = v.c1; c <= c2; c++) row.push(sh.get(r, c));
      out.push(row);
    }
    return out;
  }
  if (isArr(v)) return v;
  return [[v]];
}
export const dims = (g) => [g.length, g[0].length];

// Visit non-empty cells of a reference (sparse-aware).
export function eachRef(ref, fn) {
  const sh = ref.sh, r1 = ref.r1, c1 = ref.c1;
  const r2 = Math.min(ref.r2, sh.maxR), c2 = Math.min(ref.c2, sh.maxC);
  if (r2 < r1 || c2 < c1) return;
  const area = (r2 - r1 + 1) * (c2 - c1 + 1);
  if (area > 2 * sh.cells.size + 64) {
    const seen = [];
    for (const k of sh.cells.keys()) {
      const r = Math.floor(k / 16384), c = k % 16384;
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) seen.push(r, c);
    }
    for (const k of sh.spillVals.keys()) {
      const r = Math.floor(k / 16384), c = k % 16384;
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) seen.push(r, c);
    }
    for (let i = 0; i < seen.length; i += 2) { const v = sh.get(seen[i], seen[i + 1]); if (v != null) fn(v, seen[i], seen[i + 1]); }
    return;
  }
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const v = sh.get(r, c); if (v != null) fn(v, r, c); }
}

export function eachAny(a, fn) {
  if (isRef(a)) eachRef(a, fn);
  else if (isArr(a)) a.forEach((row, r) => row.forEach((v, c) => { if (v != null) fn(v, r, c); }));
  else if (a != null) fn(a, 0, 0);
}

// Numbers following SUM rules: only numbers inside ranges/arrays, coerced direct arguments.
export function collect(args) {
  const out = [];
  for (const a of args) {
    if (a === undefined) continue;
    if (isRef(a) || isArr(a)) eachAny(a, (v) => { if (typeof v === 'number') out.push(v); else if (isErr(v)) throw v; });
    else out.push(num(a));
  }
  return out;
}

export function lift1(v, f) {
  if (isMulti(v)) {
    return grid(v).map((row) => row.map((x) => { try { return f(x); } catch (e) { if (isErr(e)) return e; throw e; } }));
  }
  return f(scalar(v));
}
export function lift2(a, b, f) {
  const A = isMulti(a), B = isMulti(b);
  if (!A && !B) return f(scalar(a), scalar(b));
  const ga = A ? grid(a) : null, gb = B ? grid(b) : null;
  const sa = A ? null : scalar(a), sb = B ? null : scalar(b);
  const R = Math.max(ga ? ga.length : 1, gb ? gb.length : 1), C = Math.max(ga ? ga[0].length : 1, gb ? gb[0].length : 1);
  const at = (g, i, j) => {
    if (g.length === 1) i = 0;
    if (g[0].length === 1) j = 0;
    return i < g.length && j < g[0].length ? g[i][j] : E.NA;
  };
  const out = [];
  for (let i = 0; i < R; i++) {
    const row = [];
    for (let j = 0; j < C; j++) {
      try {
        const x = ga ? at(ga, i, j) : sa, y = gb ? at(gb, i, j) : sb;
        if (isErr(x)) throw x;
        if (isErr(y)) throw y;
        row.push(f(x, y));
      } catch (e) { if (isErr(e)) row.push(e); else throw e; }
    }
    out.push(row);
  }
  return out;
}

// ---- comparison ----
const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 4);
export function cmp(a, b) {
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 2) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
export const eq = (a, b) => cmp(a, b) === 0;

function wildRe(p, anchor = true) {
  let s = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '~' && i + 1 < p.length) s += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '*') s += '[\\s\\S]*';
    else if (ch === '?') s += '[\\s\\S]';
    else s += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchor ? `^${s}$` : s, 'i');
}
export { wildRe };

// COUNTIF-style criterion -> predicate
export function critFn(c) {
  c = scalar(c);
  if (typeof c === 'number') return (x) => (typeof x === 'number' ? x === c : typeof x === 'string' && textToNum(x) === c);
  if (typeof c === 'boolean') return (x) => x === c;
  if (c == null) return (x) => x === 0;
  if (isErr(c)) return (x) => x === c;
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c);
  const op = m[1] || '=', o = m[2], n = o.trim() === '' ? NaN : textToNum(o);
  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    const t = n === n ? (x) => typeof x === 'number' && cmpOp(op, x - n) : (x) => typeof x === 'string' && cmpOp(op, cmp(x, o));
    return t;
  }
  let t;
  if (n === n) t = (x) => (typeof x === 'number' ? x === n : typeof x === 'string' && textToNum(x) === n);
  else if (o === '') t = (x) => x == null || x === '';
  else if (/^(true|false)$/i.test(o)) t = (x) => x === (o.toLowerCase() === 'true');
  else { const re = wildRe(o); t = (x) => typeof x === 'string' && re.test(x); }
  return op === '<>' ? (x) => !t(x) : t;
}
const cmpOp = (op, d) => (op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0);

export function callLambda(l, vals, ctx) {
  if (l.native) return l.native(vals, ctx);
  if (vals.length > l.params.length) throw E.VALUE;
  const env = Object.create(l.env || null);
  l.params.forEach((p, i) => { env[p] = vals[i]; });
  return l.body({ ...ctx, env });
}

export function roundHalf(x, d) {
  if (!isFinite(x)) return x;
  const s = x < 0 ? -1 : 1, a = Math.abs(x);
  if (d >= 0) {
    if (String(a).includes('e')) return x;
    return s * Number(Math.round(Number(a + 'e' + d)) + 'e-' + d);
  }
  const f = Math.pow(10, -d);
  return s * Math.round(a / f) * f;
}

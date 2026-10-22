// Excel-style number format engine: sections, 0/#/? placeholders, thousands, %, E+, dates and times.
import { general, serialToYMD, serialDow, MONTHS, DAYS, roundHalf } from './core.js';

export const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

const COLORS = { red: '#d32f2f', green: '#2e7d32', blue: '#1565c0', black: '#000', white: '#fff', yellow: '#f9a825', magenta: '#c2185b', cyan: '#00838f' };
const cache = new Map();

// Split a format into tokens and sections.
function compile(code) {
  let c = cache.get(code);
  if (c) return c;
  const secs = [];
  let cur = [], cond = null, color = null, i = 0;
  const push = () => { secs.push({ t: cur, cond, color }); cur = []; cond = null; color = null; };
  while (i < code.length) {
    const ch = code[i];
    if (ch === ';') { push(); i++; }
    else if (ch === '"') { const j = code.indexOf('"', i + 1); const e = j < 0 ? code.length : j; cur.push({ k: 'lit', s: code.slice(i + 1, e) }); i = e + 1; }
    else if (ch === '\\' || ch === '_' || ch === '*') { if (ch === '\\') cur.push({ k: 'lit', s: code[i + 1] || '' }); else if (ch === '_') cur.push({ k: 'lit', s: ' ' }); i += 2; }
    else if (ch === '[') {
      const j = code.indexOf(']', i);
      const body = code.slice(i + 1, j < 0 ? code.length : j), low = body.toLowerCase();
      if (COLORS[low]) color = COLORS[low];
      else if (/^[<>=]/.test(body)) { const m = /^(<=|>=|<>|<|>|=)(-?[\d.]+)$/.exec(body); if (m) cond = { op: m[1], n: +m[2] }; }
      else if (/^(h+|m+|s+)$/i.test(body)) cur.push({ k: 'el', s: low[0], n: low.length });
      else if (/^\$[^-\]]*/.test(body)) cur.push({ k: 'lit', s: body.slice(1).split('-')[0] });
      i = (j < 0 ? code.length : j) + 1;
    } else {
      const rest = code.slice(i);
      let m;
      if ((m = /^(yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s)/i.exec(rest))) { cur.push({ k: 'dt', s: m[1].toLowerCase() }); i += m[1].length; }
      else if ((m = /^(AM\/PM|A\/P)/i.exec(rest))) { cur.push({ k: 'ap', s: m[1] }); i += m[1].length; }
      else if ((m = /^E[+-]/i.exec(rest))) { cur.push({ k: 'exp', s: m[0] }); i += 2; }
      else if (ch === 'G' && /^General/i.test(rest)) { cur.push({ k: 'gen' }); i += 7; }
      else if (ch === '0' || ch === '#' || ch === '?') { cur.push({ k: 'd', s: ch }); i++; }
      else if (ch === '.') { cur.push({ k: 'dot' }); i++; }
      else if (ch === ',') { cur.push({ k: 'comma' }); i++; }
      else if (ch === '%') { cur.push({ k: 'pct' }); i++; }
      else if (ch === '@') { cur.push({ k: 'at' }); i++; }
      else { cur.push({ k: 'lit', s: ch }); i++; }
    }
  }
  push();
  for (const s of secs) {
    s.date = s.t.some((x) => x.k === 'dt' || x.k === 'ap' || x.k === 'el');
    s.text = s.t.some((x) => x.k === 'at');
    if (s.date) classifyMinutes(s.t);
  }
  c = secs;
  if (cache.size > 500) cache.clear();
  cache.set(code, c);
  return c;
}

// "m" right after h or before s means minutes, otherwise month.
function classifyMinutes(t) {
  const dts = t.filter((x) => x.k === 'dt' || x.k === 'el');
  dts.forEach((x, i) => {
    if (x.k === 'el') return;
    if (x.s === 'm' || x.s === 'mm') {
      const p = dts[i - 1], n = dts[i + 1];
      if ((p && (p.s[0] === 'h' || p.k === 'el' && p.s === 'h')) || (n && n.s[0] === 's')) x.min = true;
    }
  });
}

export const isDateFormat = (code) => !!code && code !== 'General' && compile(code).some((s) => s.date);

function fmtDate(v, toks) {
  if (v < 0) return '#'.repeat(10);
  const day = Math.floor(v);
  let frac = Math.round((v - day) * 86400 * 1000) / 1000;
  let secs = Math.floor(frac);
  if (secs >= 86400) secs = 0;
  const ymd = serialToYMD(day), dow = serialDow(day);
  const h = Math.floor(secs / 3600), mi = Math.floor(secs / 60) % 60, se = secs % 60;
  const ampm = toks.some((x) => x.k === 'ap');
  const p2 = (n) => String(n).padStart(2, '0');
  return toks.map((x) => {
    if (x.k === 'el') return x.s === 'h' ? String(Math.floor(v * 24)).padStart(x.n, '0') : x.s === 'm' ? String(Math.floor(v * 1440)).padStart(x.n, '0') : String(Math.floor(v * 86400)).padStart(x.n, '0');
    if (x.k === 'ap') return h >= 12 ? (x.s.length > 1 ? 'PM' : 'P') : (x.s.length > 1 ? 'AM' : 'A');
    if (x.k === 'dot') return '.';
    if (x.k === 'd' && x.s === '0') return String(Math.floor((frac - Math.floor(frac)) * 10));
    if (x.k !== 'dt') return x.k === 'lit' ? x.s : '';
    switch (x.s) {
      case 'yyyy': return String(ymd.y);
      case 'yy': return p2(ymd.y % 100);
      case 'mmmmm': return MONTHS[ymd.m - 1][0];
      case 'mmmm': return x.min ? p2(mi) : MONTHS[ymd.m - 1];
      case 'mmm': return MONTHS[ymd.m - 1].slice(0, 3);
      case 'mm': return x.min ? p2(mi) : p2(ymd.m);
      case 'm': return x.min ? String(mi) : String(ymd.m);
      case 'dddd': return DAYS[dow];
      case 'ddd': return DAYS[dow].slice(0, 3);
      case 'dd': return p2(ymd.d);
      case 'd': return String(ymd.d);
      case 'hh': return p2(ampm ? (h % 12 || 12) : h);
      case 'h': return String(ampm ? (h % 12 || 12) : h);
      case 'ss': return p2(Math.floor(se));
      case 's': return String(Math.floor(se));
    }
    return '';
  }).join('');
}

function fmtNum(v, toks, neg) {
  let pct = 0;
  for (const x of toks) if (x.k === 'pct') pct++;
  v = Math.abs(v) * Math.pow(100, pct);
  let first = -1, last = -1;
  const expAt = toks.findIndex((x) => x.k === 'exp'), exp = expAt >= 0 ? toks[expAt] : null;
  toks.forEach((x, i) => { if ((x.k === 'd' || x.k === 'dot') && (expAt < 0 || i < expAt)) { if (first < 0) first = i; last = i; } });
  const expDigits = expAt < 0 ? 0 : toks.slice(expAt).filter((x) => x.k === 'd').length;
  // trailing commas after the last digit scale by 1000
  let scale = 0;
  for (let i = last + 1; i < toks.length && toks[i].k === 'comma'; i++) { scale++; toks[i].skip = true; }
  v /= Math.pow(1000, scale);
  let body = '';
  if (first >= 0) {
    const region = toks.slice(first, last + 1);
    const dotAt = region.findIndex((x) => x.k === 'dot');
    const ip = (dotAt < 0 ? region : region.slice(0, dotAt)).filter((x) => x.k === 'd');
    const fp = dotAt < 0 ? [] : region.slice(dotAt + 1).filter((x) => x.k === 'd');
    const thousands = region.some((x) => x.k === 'comma');
    let e = 0, mant = v;
    if (exp && v !== 0) {
      e = Math.floor(Math.log10(v)) - (ip.length - 1);
      mant = v / Math.pow(10, e);
      if (roundHalf(mant, fp.length) >= Math.pow(10, ip.length)) { e++; mant = v / Math.pow(10, e); }
    }
    const r = roundHalf(mant, fp.length);
    let [i, f = ''] = r.toFixed(fp.length).split('.');
    if (i === '0' && !ip.some((x) => x.s === '0') && !(ip.length === 0 && fp.length === 0)) i = '';
    const zeros = ip.filter((x) => x.s === '0').length;
    if (i.length < zeros) i = i.padStart(zeros, '0');
    else if (i.length < ip.length) { const pad = ip.slice(0, ip.length - i.length); i = pad.map((x) => (x.s === '?' ? ' ' : '')).join('') + i; }
    if (thousands) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // trim optional trailing fraction digits
    let fl = f.split('');
    for (let k = fl.length - 1; k >= 0; k--) {
      if (fp[k].s === '0') break;
      if (fl[k] === '0') fl[k] = fp[k].s === '?' ? ' ' : ''; else break;
    }
    f = fl.join('');
    body = i + (dotAt >= 0 && (f.trim() !== '' || fp.some((x) => x.s === '0')) ? '.' + f : (dotAt >= 0 && fp.length === 0 ? '.' : ''));
    if (exp) body += 'E' + (e < 0 ? '-' : exp.s[1] === '+' ? '+' : '') + String(Math.abs(e)).padStart(expDigits, '0');
  }
  let out = '', placed = false;
  toks.forEach((x, i) => {
    if (i >= first && i <= last) { if (!placed) { out += body; placed = true; } return; }
    if (x.k === 'exp' || x.skip || (x.k === 'd' && expAt >= 0 && i > expAt)) return;
    if (x.k === 'lit') out += x.s;
    else if (x.k === 'pct') out += '%';
    else if (x.k === 'comma') out += '';
  });
  if (first < 0) out = toks.map((x) => (x.k === 'lit' ? x.s : x.k === 'pct' ? '%' : '')).join('');
  return neg ? '-' + out : out;
}

// Format a value; returns { text, color }.
export function format(v, code) {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') {
    if (!code || code === 'General') return { text: v };
    const s = compile(code), t = s.length > 3 ? s[3] : s.find((x) => x.text);
    return t ? { text: t.t.map((x) => (x.k === 'at' ? v : x.k === 'lit' ? x.s : '')).join(''), color: t.color } : { text: v };
  }
  if (typeof v !== 'number') return { text: String(v) };
  if (!code || code === 'General') return { text: general(v) };
  const secs = compile(code);
  let sec = secs[0], neg = v < 0, useAbs = false;
  const matches = (s) => s.cond && (s.cond.op === '<' ? v < s.cond.n : s.cond.op === '>' ? v > s.cond.n : s.cond.op === '<=' ? v <= s.cond.n : s.cond.op === '>=' ? v >= s.cond.n : s.cond.op === '=' ? v === s.cond.n : v !== s.cond.n);
  if (secs.some((s) => s.cond)) {
    const hit = secs.slice(0, 2).findIndex(matches);
    sec = hit >= 0 ? secs[hit] : secs[Math.min(secs.length - 1, 2)];
    neg = v < 0 && hit < 0 && secs.length < 3 ? true : false;
    if (v < 0 && secs.length > 1 && hit === 1) useAbs = true;
  } else if (secs.length > 1 && v < 0) { sec = secs[1]; neg = false; useAbs = true; }
  else if (secs.length > 2 && v === 0) { sec = secs[2]; neg = false; }
  if (sec.text && !sec.t.some((x) => x.k === 'd')) return { text: sec.t.map((x) => (x.k === 'at' ? general(v) : x.k === 'lit' ? x.s : '')).join(''), color: sec.color };
  if (sec.t.some((x) => x.k === 'gen')) return { text: (neg ? '-' : '') + sec.t.map((x) => (x.k === 'gen' ? general(Math.abs(v)) : x.k === 'lit' ? x.s : '')).join(''), color: sec.color };
  if (sec.date) return { text: fmtDate(useAbs ? Math.abs(v) : v, sec.t), color: sec.color };
  return { text: fmtNum(v, sec.t, neg && !useAbs), color: sec.color };
}

export const formatText = (v, code) => format(v, code).text;

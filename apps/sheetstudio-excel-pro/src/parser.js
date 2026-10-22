// Formula tokenizer, parser and reference rewriting. No dependencies.
export const MAXR = 1048576, MAXC = 16384;

export const colName = (n) => {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
};
export const colNum = (s) => {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};
export const cellName = (r, c) => colName(c) + (r + 1);

const CELL = '\\$?[A-Za-z]{1,3}\\$?\\d+';
const SHEET = "(?:'(?:[^']|'')+'|[A-Za-z_\\u00a1-\\uffff][\\w.\\u00a1-\\uffff]*)!";
const REFRE = new RegExp(`(${SHEET})?(?:(${CELL})(?::(${CELL}))?|(\\$?[A-Za-z]{1,3}):(\\$?[A-Za-z]{1,3})(?![\\w(])|(\\$?\\d+):(\\$?\\d+))(?![\\w(.])`, 'y');
const NUMRE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDRE = /[A-Za-z_¡-￿][\w.¡-￿]*/y;
const ERRRE = /#(?:N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!|CIRC!)/y;
const OPRE = /<>|<=|>=|[-+*\/^&=<>(),:;%{}@!#]/y;

const cellParts = (t) => {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(t);
  const c = colNum(m[2]), r = +m[4] - 1;
  if (c >= MAXC || r >= MAXR || r < 0) return null;
  return { r, c, ar: !!m[3], ac: !!m[1] };
};

// Parse a reference token text such as Sheet1!$A$1:B2 into a ref descriptor, or null.
export function parseRefText(text) {
  REFRE.lastIndex = 0;
  const m = REFRE.exec(text);
  if (!m || m[0].length !== text.length) return null;
  return refFromMatch(m);
}

function refFromMatch(m) {
  let sh = null;
  if (m[1]) {
    sh = m[1].slice(0, -1);
    if (sh[0] === "'") sh = sh.slice(1, -1).replace(/''/g, "'");
  }
  if (m[2]) {
    const a = cellParts(m[2]);
    const b = m[3] ? cellParts(m[3]) : a;
    if (!a || !b) return null;
    return { k: m[3] ? 'range' : 'cell', sh, r1: a.r, c1: a.c, r2: b.r, c2: b.c, a: [a.ar, a.ac, b.ar, b.ac] };
  }
  if (m[4]) {
    const x = m[4].replace('$', ''), y = m[5].replace('$', '');
    const c1 = colNum(x), c2 = colNum(y);
    if (c1 >= MAXC || c2 >= MAXC) return null;
    return { k: 'col', sh, r1: 0, c1, r2: MAXR - 1, c2, a: [true, m[4][0] === '$', true, m[5][0] === '$'] };
  }
  const x = +m[6].replace('$', ''), y = +m[7].replace('$', '');
  if (x < 1 || y < 1 || x > MAXR || y > MAXR) return null;
  return { k: 'row', sh, r1: x - 1, c1: 0, r2: y - 1, c2: MAXC - 1, a: [m[6][0] === '$', true, m[7][0] === '$', true] };
}

const quoteSheet = (s) => (/^[A-Za-z_][\w.]*$/.test(s) && !/^[A-Za-z]{1,3}\d+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

export function formatRef(x) {
  const p = x.sh != null ? quoteSheet(x.sh) + '!' : '';
  const d = (abs) => (abs ? '$' : '');
  if (x.k === 'col') return p + d(x.a[1]) + colName(x.c1) + ':' + d(x.a[3]) + colName(x.c2);
  if (x.k === 'row') return p + d(x.a[0]) + (x.r1 + 1) + ':' + d(x.a[2]) + (x.r2 + 1);
  const one = d(x.a[1]) + colName(x.c1) + d(x.a[0]) + (x.r1 + 1);
  if (x.k === 'cell') return p + one;
  return p + one + ':' + d(x.a[3]) + colName(x.c2) + d(x.a[2]) + (x.r2 + 1);
}

// End index (exclusive) of the balanced [...] group starting at s[i]; ' escapes the next character.
function scanBr(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'") j++;
    else if (c === '[') d++;
    else if (c === ']' && --d === 0) return j + 1;
  }
  throw new Error('Unclosed [');
}

export function tokenize(s) {
  const out = [], n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    const st = i;
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= n) throw new Error('Unterminated string');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      i = j + 1;
      out.push({ k: 'str', v, s: st, e: i });
      continue;
    }
    let m;
    if (ch === '[') { // implicit-table structured reference such as [@Qty]
      const e = scanBr(s, i);
      out.push({ k: 'tref', table: '', spec: s.slice(i, e), s: st, e });
      i = e;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) { // Table1[Col]
      IDRE.lastIndex = i;
      const id = IDRE.exec(s);
      if (id && s[i + id[0].length] === '[') {
        const e = scanBr(s, i + id[0].length);
        out.push({ k: 'tref', table: id[0], spec: s.slice(i + id[0].length, e), s: st, e });
        i = e;
        continue;
      }
    }
    if (ch === '#') {
      ERRRE.lastIndex = i;
      if ((m = ERRRE.exec(s))) { i += m[0].length; out.push({ k: 'err', v: m[0], s: st, e: i }); continue; }
    }
    if (/[A-Za-z$'\d]/.test(ch)) {
      REFRE.lastIndex = i;
      if ((m = REFRE.exec(s))) {
        const ref = refFromMatch(m);
        if (ref) { i += m[0].length; out.push({ k: 'ref', v: ref, s: st, e: i }); continue; }
      }
    }
    if (/[\d.]/.test(ch)) {
      NUMRE.lastIndex = i;
      if ((m = NUMRE.exec(s))) { i += m[0].length; out.push({ k: 'num', v: parseFloat(m[0]), s: st, e: i }); continue; }
    }
    IDRE.lastIndex = i;
    if ((m = IDRE.exec(s))) { i += m[0].length; out.push({ k: 'id', v: m[0], s: st, e: i }); continue; }
    OPRE.lastIndex = i;
    if ((m = OPRE.exec(s))) { i += m[0].length; out.push({ k: 'op', v: m[0], s: st, e: i }); continue; }
    throw new Error(`Unexpected "${ch}"`);
  }
  return out;
}

export function parse(src) {
  const t = tokenize(src);
  let p = 0;
  const isOp = (v) => p < t.length && t[p].k === 'op' && t[p].v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };

  const cmp = () => {
    let l = cat();
    while (p < t.length && t[p].k === 'op' && /^(=|<>|<=|>=|<|>)$/.test(t[p].v)) {
      const op = t[p++].v;
      l = { t: 'bin', op, l, r: cat() };
    }
    return l;
  };
  const cat = () => {
    let l = add();
    while (isOp('&')) { p++; l = { t: 'bin', op: '&', l, r: add() }; }
    return l;
  };
  const add = () => {
    let l = mul();
    while (isOp('+') || isOp('-')) { const op = t[p++].v; l = { t: 'bin', op, l, r: mul() }; }
    return l;
  };
  const mul = () => {
    let l = pow();
    while (isOp('*') || isOp('/')) { const op = t[p++].v; l = { t: 'bin', op, l, r: pow() }; }
    return l;
  };
  const pow = () => {
    let l = unary();
    while (isOp('^')) { p++; l = { t: 'bin', op: '^', l, r: unary() }; }
    return l;
  };
  const unary = () => {
    if (isOp('-') || isOp('+')) { const op = t[p++].v; return { t: 'un', op, e: unary() }; }
    return post();
  };
  const post = () => {
    let e = prim();
    for (;;) {
      if (isOp('%')) { p++; e = { t: 'pct', e }; }
      else if (isOp(':')) { p++; e = { t: 'range', a: e, b: prim() }; }
      else if (isOp('(') && (e.t === 'call' || e.t === 'callx')) e = { t: 'callx', f: e, a: args() };
      else break;
    }
    return e;
  };
  const args = () => {
    expect('(');
    const a = [];
    if (isOp(')')) { p++; return a; }
    for (;;) {
      a.push(isOp(',') || isOp(')') ? { t: 'empty' } : cmp());
      if (isOp(',')) { p++; continue; }
      expect(')');
      return a;
    }
  };
  const prim = () => {
    const tk = t[p];
    if (!tk) throw new Error('Unexpected end of formula');
    p++;
    switch (tk.k) {
      case 'num': return { t: 'num', v: tk.v };
      case 'str': return { t: 'str', v: tk.v };
      case 'err': return { t: 'err', v: tk.v };
      case 'tref': return { t: 'tref', table: tk.table, spec: tk.spec };
      case 'ref': {
        const n = { t: 'ref', ...tk.v };
        if (isOp('#')) { p++; return { t: 'spill', ref: n }; }
        return n;
      }
      case 'id': {
        if (isOp('(')) return { t: 'call', n: tk.v, a: args() };
        const u = tk.v.toUpperCase();
        if (u === 'TRUE' || u === 'FALSE') return { t: 'bool', v: u === 'TRUE' };
        return { t: 'name', n: tk.v };
      }
      case 'op':
        if (tk.v === '(') { const e = cmp(); expect(')'); return e; }
        if (tk.v === '@') return prim();
        if (tk.v === '{') {
          const rows = [[]];
          for (;;) {
            rows[rows.length - 1].push(cmp());
            if (isOp(',')) { p++; continue; }
            if (isOp(';')) { p++; rows.push([]); continue; }
            expect('}');
            return { t: 'arr', rows };
          }
        }
    }
    throw new Error(`Unexpected "${src.slice(tk.s, tk.e)}"`);
  };
  const ast = cmp();
  if (p < t.length) throw new Error(`Unexpected "${src.slice(t[p].s, t[p].e)}"`);
  return ast;
}

// Rewrite every reference in a formula source. fn(ref) returns a new ref, or null for #REF!.
export function rewriteRefs(src, fn) {
  let toks;
  try { toks = tokenize(src); } catch { return src; }
  let out = '', last = 0;
  for (const tk of toks) {
    if (tk.k !== 'ref') continue;
    const r = fn({ ...tk.v, a: tk.v.a.slice() });
    out += src.slice(last, tk.s) + (r ? formatRef(r) : '#REF!');
    last = tk.e;
  }
  return out + src.slice(last);
}

// Shift relative references by (dr, dc), as when copying or filling a formula.
export function shiftFormula(src, dr, dc) {
  if (!dr && !dc) return src;
  return rewriteRefs(src, (x) => {
    const R1 = x.a[0] ? x.r1 : x.r1 + dr, R2 = x.a[2] ? x.r2 : x.r2 + dr;
    const C1 = x.a[1] ? x.c1 : x.c1 + dc, C2 = x.a[3] ? x.c2 : x.c2 + dc;
    if (x.k !== 'col' && (R1 < 0 || R2 < 0 || R1 >= MAXR || R2 >= MAXR)) return null;
    if (x.k !== 'row' && (C1 < 0 || C2 < 0 || C1 >= MAXC || C2 >= MAXC)) return null;
    if (x.k === 'col') return { ...x, c1: C1, c2: C2 };
    if (x.k === 'row') return { ...x, r1: R1, r2: R2 };
    return { ...x, r1: R1, r2: R2, c1: C1, c2: C2 };
  });
}

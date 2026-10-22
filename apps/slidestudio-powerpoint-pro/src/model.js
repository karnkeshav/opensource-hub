// Deck model and the Markdown-style outline <-> slides mapping (two-way).
// Para = { r: [Run], lvl, bu: 0 | 1 | 'n', al?, bc? }   Run = { t, b?, i?, u?, s?, c?, z?, f? }
let seq = 0;
export const uid = () => 'e' + Date.now().toString(36).slice(-5) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);
export const P = (t = '', o) => ({ r: t ? [{ t }] : [], lvl: 0, bu: 0, ...o });
export const plain = (p) => (p ? p.r.map((r) => r.t).join('') : '');
export const clone = (x) => JSON.parse(JSON.stringify(x));
export function newSlide(o) {
  return { id: uid(), title: null, sub: [], body: [], cols: [], img: [], table: null, quote: null, dg: null, notes: '', layout: null, ov: {}, els: [], bg: null, tr: null, hidden: false, ...o };
}
export function newDeck() {
  const d = { v: 1, w: 960, h: 540, theme: { name: 'Ocean', brand: '#1c7ed6', mode: 'light', font: 'sans' }, slides: [], media: {} };
  d.slides = parseOutline('# Untitled presentation\n## Start typing in the outline');
  return d;
}

// ---------- inline Markdown: **bold** *italic* ~~strike~~ <u>underline</u> <br> ----------
const TOK = /\\([\\*~<>|#\-!:`[\]])|(\*\*|~~|\*|<u>|<\/u>|<br>)/g;
const same = (a, b) => ['b', 'i', 'u', 's', 'c', 'z', 'f'].every((k) => a[k] === b[k]);
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) { if (!r.t) continue; const l = out[out.length - 1]; if (l && same(l, r)) l.t += r.t; else out.push({ ...r }); }
  return out;
}
export function parseInline(s) {
  const runs = [], st = {};
  let buf = '', last = 0, m;
  const flush = () => { if (buf) { const r = { t: buf }; for (const k in st) if (st[k]) r[k] = 1; runs.push(r); buf = ''; } };
  TOK.lastIndex = 0;
  while ((m = TOK.exec(s))) {
    buf += s.slice(last, m.index); last = TOK.lastIndex;
    if (m[1]) { buf += m[1]; continue; }
    let tk = m[2];
    if (tk === '<br>') { buf += '\n'; continue; }
    if (tk === '**' && s[TOK.lastIndex] === '*' && st.i && !st.b) { tk = '*'; TOK.lastIndex = last = m.index + 1; }
    const k = tk === '**' ? 'b' : tk === '*' ? 'i' : tk === '~~' ? 's' : 'u';
    const lit = k === 'u' ? (tk === '<u>') === !!st.u : !st[k] && s.indexOf(tk, last) < 0;
    if (lit) { buf += tk; continue; }
    flush(); st[k] = !st[k];
  }
  buf += s.slice(last); flush();
  return mergeRuns(runs);
}
const escMd = (t) => t.replace(/[\\*~|<]/g, '\\$&').replace(/\n/g, '<br>');
export function runsMd(runs) {
  return mergeRuns(runs).map((r) => {
    const t = escMd(r.t);
    return (r.b ? '**' : '') + (r.i ? '*' : '') + (r.s ? '~~' : '') + (r.u ? '<u>' : '') + t + (r.u ? '</u>' : '') + (r.s ? '~~' : '') + (r.i ? '*' : '') + (r.b ? '**' : '');
  }).join('');
}
const LEAD = /^(#|[-*+•] |>|\d+[.)] |!\[|\||::|```|---|\\)/;
export function paraMd(p) {
  const ind = '  '.repeat(p.lvl || 0), t = runsMd(p.r);
  return ind + (p.bu === 'n' ? '1. ' : p.bu ? '- ' : LEAD.test(t) ? '\\' : '') + t;
}
const para = (s, o) => ({ r: parseInline(s), lvl: 0, bu: 0, ...o });
const cells = (t) => t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => para(c.trim()));

// ---------- outline -> slides ----------
export function parseOutline(text) {
  const slides = [];
  let s = null, col = null, fence = null, fb = [];
  const cur = () => s || ((s = newSlide()), slides.push(s), s);
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    if (fence) { if (/^\s*```\s*$/.test(raw)) { cur().dg = { k: fence, src: fb.join('\n') }; fence = null; } else fb.push(raw); continue; }
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const ind = /^[ \t]*/.exec(line)[0].replace(/\t/g, '  ').length, lvl = Math.min(4, ind >> 1), t = line.trim();
    let m;
    if (!ind && (m = /^#(?:\s+(.*))?$/.exec(t))) { s = newSlide({ title: m[1] ? para(m[1]) : null }); slides.push(s); col = null; }
    else if (!ind && /^---+$/.test(t)) { s = newSlide(); slides.push(s); col = null; }
    else if ((m = /^##\s+(.*)$/.exec(t))) cur().sub.push(para(m[1]));
    else if ((m = /^###\s+(.*)$/.exec(t))) { col = { h: para(m[1]), body: [] }; cur().cols.push(col); }
    else if ((m = /^```\s*([\w-]*)/.exec(t))) { fence = m[1] || 'flow'; fb = []; cur(); }
    else if ((m = /^::\s?(.*)$/.exec(t))) { const S = cur(); S.notes += (S.notes ? '\n' : '') + m[1]; }
    else if ((m = /^!\[([^\]]*)\]\((.*)\)$/.exec(t))) cur().img.push({ src: m[2].trim(), alt: m[1] });
    else if (t[0] === '|') { if (!/^\|[\s:|-]+\|?$/.test(t)) { const S = cur(); (S.table || (S.table = [])).push(cells(t)); } }
    else if (t[0] === '>') {
      const S = cur(), q = S.quote || (S.quote = { q: [], by: '' }), x = t.replace(/^>\s?/, '');
      if ((m = /^(?:—|–|--)\s*(.*)$/.exec(x))) q.by = m[1]; else q.q.push(para(x));
    } else {
      let p;
      if ((m = /^[-*+•]\s+(.*)$/.exec(t))) p = para(m[1], { lvl, bu: 1 });
      else if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) p = para(m[1], { lvl, bu: 'n' });
      else p = para(t[0] === '\\' ? t.slice(1) : t, { lvl });
      (col ? col.body : cur().body).push(p);
    }
  }
  if (fence) cur().dg = { k: fence, src: fb.join('\n') };
  for (const S of slides) { // lines that are all arrows become a flowchart
    if (!S.dg && !S.cols.length && S.body.length > 1 && S.body.every((p) => /\S\s*(->|-->|<->)\s*\S/.test(plain(p)))) { S.dg = { k: 'flow', src: S.body.map(plain).join('\n') }; S.body = []; }
  }
  return slides;
}

// ---------- slides -> outline ----------
export function slideMd(s) {
  const L = [s.title ? '# ' + runsMd(s.title.r) : '---'];
  s.sub.forEach((p) => L.push('## ' + runsMd(p.r)));
  s.body.forEach((p) => L.push(paraMd(p)));
  s.cols.forEach((c) => { L.push('### ' + runsMd(c.h.r)); c.body.forEach((p) => L.push(paraMd(p))); });
  s.img.forEach((i) => L.push(`![${(i.alt || '').replace(/[\]\n]/g, ' ')}](${i.src})`));
  if (s.table) s.table.forEach((row, i) => { L.push('| ' + row.map((c) => runsMd(c.r)).join(' | ') + ' |'); if (!i) L.push('|' + row.map(() => ' --- ').join('|') + '|'); });
  if (s.quote) { s.quote.q.forEach((p) => L.push('> ' + runsMd(p.r))); if (s.quote.by) L.push('> — ' + s.quote.by); }
  if (s.dg) L.push('```' + s.dg.k, ...s.dg.src.split('\n'), '```');
  if (s.notes) s.notes.split('\n').forEach((n) => L.push(':: ' + n));
  return L.join('\n');
}
export const toOutline = (deck) => deck.slides.map(slideMd).join('\n\n') + '\n';

// Normalise pasted text into an outline: promote headings when there is no '#', or turn plain blocks into slides.
export function normalizeMd(t) {
  t = String(t).replace(/\r\n?/g, '\n');
  if (/^#\s/m.test(t)) return t;
  for (const n of [2, 3]) if (new RegExp(`^#{${n}}\\s`, 'm').test(t)) return t.replace(new RegExp(`^#{${n}}(#*)\\s`, 'gm'), '#$1 ');
  return t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
    const [h, ...rest] = b.split('\n');
    return '# ' + h.replace(/^[-*•]\s+/, '') + rest.map((l) => '\n' + (/^\s*([-*+•]|\d+[.)])\s/.test(l) ? l : '- ' + l.trim())).join('');
  }).join('\n\n');
}

// ---------- keep ids, layout, positions and rich formatting when the outline is re-parsed ----------
function keepParas(o, n) {
  if (!o || !n) return n;
  const pool = new Map();
  for (const p of o) { const k = paraMd(p); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(p); }
  return n.map((p) => { const q = pool.get(paraMd(p)); return q && q.length ? q.shift() : p; });
}
export function adopt(o, n) {
  for (const k of ['id', 'layout', 'ov', 'els', 'bg', 'tr', 'hidden']) n[k] = o[k];
  if (o.title && n.title) n.title = keepParas([o.title], [n.title])[0];
  n.sub = keepParas(o.sub, n.sub); n.body = keepParas(o.body, n.body);
  n.cols.forEach((c, i) => { const oc = o.cols[i]; if (oc) { c.h = keepParas([oc.h], [c.h])[0]; c.body = keepParas(oc.body, c.body); } });
  if (o.quote && n.quote) n.quote.q = keepParas(o.quote.q, n.quote.q);
  if (o.table && n.table) n.table = n.table.map((row, i) => keepParas(o.table[i], row));
  return n;
}
export function reconcile(old, nw) {
  const key = (s) => plain(s.title).trim().toLowerCase(), n = old.length, m = nw.length;
  const pair = new Array(m).fill(-1);
  if (n * m <= 4e6) { // longest common subsequence on titles, then pair the gaps positionally
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = key(old[i]) === key(nw[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0, gi = 0, gj = 0;
    const gap = (i2, j2) => { for (let a = gi, b = gj; a < i2 && b < j2; a++, b++) pair[b] = a; };
    while (i < n && j < m) {
      if (key(old[i]) === key(nw[j])) { gap(i, j); pair[j] = i; gi = ++i; gj = ++j; }
      else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    gap(n, m);
  } else for (let j = 0; j < Math.min(n, m); j++) pair[j] = j;
  return nw.map((s, j) => (pair[j] >= 0 ? adopt(old[pair[j]], s) : s));
}

// ---------- editing bindings: which slide field a laid-out box edits ----------
export const one = (ps) => (ps.length ? { ...ps[0], r: mergeRuns(ps.flatMap((p, i) => (i ? [{ t: '\n' }, ...p.r] : p.r))) } : null);
export function binding(s, k) {
  let m;
  if (k === 'title') return { get: () => (s.title ? [s.title] : []), set: (ps) => { s.title = one(ps); } };
  if (k === 'sub' || k === 'body') return { get: () => s[k], set: (ps) => { s[k] = ps; } };
  if (k === 'num') return { get: () => s.body.slice(0, 1), set: (ps) => { s.body.splice(0, 1, ...ps.slice(0, 1)); } };
  if (k === 'cap') return { get: () => s.body.slice(1), set: (ps) => { s.body.splice(1, s.body.length, ...ps); } };
  if ((m = /^c([hb])(\d+)$/.exec(k)) && s.cols[+m[2]]) {
    const c = s.cols[+m[2]];
    return m[1] === 'h' ? { get: () => [c.h], set: (ps) => { c.h = one(ps) || P(); } } : { get: () => c.body, set: (ps) => { c.body = ps; } };
  }
  if (k === 'q' && s.quote) return { get: () => s.quote.q, set: (ps) => { s.quote.q = ps; } };
  if (k === 'by' && s.quote) return { get: () => (s.quote.by ? [P(s.quote.by)] : []), set: (ps) => { s.quote.by = ps.map(plain).join(' '); } };
  const e = s.els.find((x) => x.id === k);
  if (e && e.t !== 'pic' && e.t !== 'table' && e.t !== 'line') return { get: () => e.paras || [], set: (ps) => { e.paras = ps; } };
  return null;
}
// Remove the content a laid-out box shows (Delete key on the canvas).
export function removeKey(s, k) {
  let m;
  const e = s.els.findIndex((x) => x.id === k);
  if (e >= 0) { s.els.splice(e, 1); return true; }
  if (k === 'title') s.title = null;
  else if (k === 'sub' || k === 'body') s[k] = [];
  else if (k === 'num' || k === 'cap') s.body = [];
  else if ((m = /^img(\d+)$/.exec(k))) s.img.splice(+m[1], 1);
  else if (k === 'tbl') s.table = null;
  else if (/^dg/.test(k)) s.dg = null;
  else if (k === 'q' || k === 'by' || k === 'qm') s.quote = null;
  else if ((m = /^c[hb](\d+)$/.exec(k))) s.cols.splice(+m[1], 1);
  else { s.ov[k] = { ...s.ov[k], hide: 1 }; }
  s.els = s.els.filter((x) => !x.slot || x.slot !== k);
  return true;
}
// Every editable paragraph list in a slide (used by find/replace and checks).
export function allParas(s) {
  const out = [];
  if (s.title) out.push(s.title);
  out.push(...s.sub, ...s.body);
  s.cols.forEach((c) => out.push(c.h, ...c.body));
  if (s.quote) out.push(...s.quote.q);
  if (s.table) s.table.forEach((r) => out.push(...r));
  s.els.forEach((e) => { if (e.paras) out.push(...e.paras); if (e.rows) e.rows.forEach((r) => out.push(...r)); });
  return out;
}

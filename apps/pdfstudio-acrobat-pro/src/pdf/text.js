// Text extraction: characters with boxes (PDF user space) -> lines/words, plain text with char mapping.
import { Interp } from './interp.js';

export const NULL_DEV = { save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, text() {}, textClip() {}, endTextClip() {}, async image() {}, shade() {}, async tile() { return { c: '#000' }; } };

// Collect characters and page objects in one pass (no drawing).
export async function analyze(doc, page, { objects = true } = {}) {
  const chars = [], objs = [];
  const it = new Interp(doc, NULL_DEV, {
    noAnnots: true, skipImages: true,
    onChar: (c) => {
      const xs = c.q.map((p) => p[0]), ys = c.q.map((p) => p[1]);
      chars.push({ ...c, u: c.u || '', b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    },
    onObj: objects ? (o) => objs.push(o) : null,
  });
  const ops = await it.page(page);
  return { chars, objs, ops, warn: it.warn };
}

// Build reading text with mapping from string offsets to char indices.
export function layout(chars) {
  let s = '';
  const map = [];
  let prev = null;
  const lines = [];
  let line = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const dir = Math.atan2(c.q[1][1] - c.q[0][1], c.q[1][0] - c.q[0][0]);
    const h = Math.hypot(c.q[3][0] - c.q[0][0], c.q[3][1] - c.q[0][1]) || c.fs || 10;
    if (prev) {
      // position of this char relative to the previous one, in the previous char's baseline frame
      const cos = Math.cos(prev.dir), sin = Math.sin(prev.dir);
      const dx = c.q[0][0] - prev.c.q[1][0], dy = c.q[0][1] - prev.c.q[1][1];
      const along = dx * cos + dy * sin, across = -dx * sin + dy * cos;
      const newline = Math.abs(across) > 0.6 * Math.min(h, prev.h) || along < -prev.h * 1.5 || Math.abs(dir - prev.dir) > 0.3;
      if (newline) { s += '\n'; map.push(-1); line = null; }
      else if (along > 0.18 * Math.min(h, prev.h) && !/\s$/.test(prev.c.u) && !/^\s/.test(c.u)) { s += ' '; map.push(-1); }
    }
    if (!line) { line = { start: i, end: i, b: c.b.slice(), fs: c.fs }; lines.push(line); }
    line.end = i; line.b = [Math.min(line.b[0], c.b[0]), Math.min(line.b[1], c.b[1]), Math.max(line.b[2], c.b[2]), Math.max(line.b[3], c.b[3])]; line.fs = Math.max(line.fs, c.fs);
    const u = c.u.replace(/[\0-\x1f]/g, '');
    for (let k = 0; k < u.length; k++) { s += u[k]; map.push(i); }
    prev = { c, dir, h };
  }
  return { text: s, map, lines };
}

// Find all matches of a query (string or RegExp) -> [{start, end, chars:[i...]}]
export function findAll(lay, q, { caseSensitive = false, wholeWord = false } = {}) {
  const out = [];
  let re;
  if (q instanceof RegExp) re = new RegExp(q.source, q.flags.includes('g') ? q.flags : q.flags + 'g');
  else {
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    re = new RegExp(wholeWord ? '\\b' + esc + '\\b' : esc, caseSensitive ? 'g' : 'gi');
  }
  let m;
  while ((m = re.exec(lay.text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const ch = [];
    for (let k = m.index; k < m.index + m[0].length; k++) if (lay.map[k] >= 0 && ch[ch.length - 1] !== lay.map[k]) ch.push(lay.map[k]);
    out.push({ start: m.index, end: m.index + m[0].length, chars: ch, text: m[0] });
  }
  return out;
}

// Merge character boxes into per-line rectangles (for highlights / quadpoints)
export function charRects(chars, idxs) {
  const rects = [];
  let cur = null;
  for (const i of idxs) {
    const c = chars[i];
    if (!c) continue;
    if (cur && Math.abs(c.b[1] - cur[1]) < (cur[3] - cur[1]) * 0.5 && c.b[0] >= cur[0] - 2 && c.b[0] - cur[2] < (cur[3] - cur[1]) * 3) {
      cur[0] = Math.min(cur[0], c.b[0]); cur[1] = Math.min(cur[1], c.b[1]); cur[2] = Math.max(cur[2], c.b[2]); cur[3] = Math.max(cur[3], c.b[3]);
    } else { cur = c.b.slice(); rects.push(cur); }
  }
  return rects;
}

// Simple Markdown / HTML from lines (headings by font size relative to the page's median)
export function toMarkdown(lay) {
  const sizes = lay.lines.map((l) => l.fs).sort((a, b) => a - b);
  const med = sizes[sizes.length >> 1] || 10;
  const text = lay.text.split('\n');
  return lay.lines.map((l, i) => {
    const t = (text[i] || '').trim();
    if (!t) return '';
    if (l.fs > med * 1.6) return '# ' + t;
    if (l.fs > med * 1.25) return '## ' + t;
    if (/^[•●▪–-]\s*/.test(t)) return '- ' + t.replace(/^[•●▪–-]\s*/, '');
    return t;
  }).join('\n').replace(/\n{3,}/g, '\n\n');
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function toHTML(pages, title) {
  let h = `<!doctype html><meta charset="utf-8"><title>${esc(title || 'Document')}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:46em;margin:2em auto;padding:0 1em}section{border-bottom:1px solid #ccc;padding-bottom:1em}</style>`;
  pages.forEach((lay, n) => {
    h += `<section id="page-${n + 1}">`;
    for (const line of toMarkdown(lay).split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('## ')) h += `<h2>${esc(line.slice(3))}</h2>`;
      else if (line.startsWith('# ')) h += `<h1>${esc(line.slice(2))}</h1>`;
      else if (line.startsWith('- ')) h += `<li>${esc(line.slice(2))}</li>`;
      else h += `<p>${esc(line)}</p>`;
    }
    h += '</section>';
  });
  return h;
}

// Table extraction: cluster characters inside a region into rows and columns -> array of rows
export function extractTable(chars, region) {
  const inR = chars.filter((c) => c.u.trim() && (!region || (c.b[0] >= region[0] - 1 && c.b[2] <= region[2] + 1 && c.b[1] >= region[1] - 1 && c.b[3] <= region[3] + 1)));
  if (!inR.length) return [];
  // words
  const words = [];
  let w = null;
  for (const c of inR) {
    const h = c.b[3] - c.b[1];
    if (w && Math.abs(c.b[1] - w.b[1]) < h * 0.5 && c.b[0] - w.b[2] < h * 0.35 && c.b[0] >= w.b[0]) { w.t += c.u; w.b[2] = Math.max(w.b[2], c.b[2]); w.b[3] = Math.max(w.b[3], c.b[3]); }
    else { w = { t: c.u, b: c.b.slice() }; words.push(w); }
  }
  // rows by baseline
  words.sort((a, b) => b.b[1] - a.b[1] || a.b[0] - b.b[0]);
  const rows = [];
  for (const wd of words) {
    const r = rows.find((r) => Math.abs(r.y - wd.b[1]) < (wd.b[3] - wd.b[1]) * 0.5);
    if (r) r.w.push(wd); else rows.push({ y: wd.b[1], w: [wd] });
  }
  // column boundaries: gaps in x coverage across all words
  const xs = words.map((wd) => [wd.b[0], wd.b[2]]).sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of xs) { const last = cols[cols.length - 1]; if (last && a <= last[1] + 4) last[1] = Math.max(last[1], b); else cols.push([a, b]); }
  return rows.map((r) => {
    const cells = cols.map(() => []);
    for (const wd of r.w.sort((a, b) => a.b[0] - b.b[0])) { const k = cols.findIndex((c) => wd.b[0] >= c[0] - 1 && wd.b[0] <= c[1] + 1); cells[Math.max(0, k)].push(wd.t); }
    return cells.map((c) => c.join(' '));
  });
}
export const toCSV = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n');

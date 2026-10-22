// Editing page content objects in place: move/resize/delete images and form XObjects, edit text runs.
import { parseContent, serContent } from '../pdf/content.js';
import { mmul, inv, Str, apply } from '../pdf/obj.js';
import { setContent, addText } from '../pdf/edit.js';
import { std14 } from '../pdf/fonts/glyphs.js';

export function transformObject(doc, pageIdx, o, T) {
  const page = doc.pages[pageIdx];
  const ops = parseContent(page.contents());
  const ctm = o.ctm || [1, 0, 0, 1, 0, 0];
  const M = mmul(mmul(ctm, T), inv(ctm));
  const op = ops[o.op];
  if (!op || !['Do', 'BI'].includes(op.op)) throw new Error('This object cannot be moved');
  ops.splice(o.op, 1, { op: 'q', args: [] }, { op: 'cm', args: M.map((v) => Math.round(v * 10000) / 10000) }, op, { op: 'Q', args: [] });
  setContent(doc, page.ref, serContent(ops));
}
export function deleteObject(doc, pageIdx, o) {
  const page = doc.pages[pageIdx];
  const ops = parseContent(page.contents());
  ops.splice(o.op, 1);
  setContent(doc, page.ref, serContent(ops));
}
// Group page-level characters into runs (one text-showing operator each)
export function textRuns(chars) {
  const runs = [];
  let cur = null;
  chars.forEach((c, k) => {
    if (c.lvl !== 0) return;
    if (!cur || cur.op !== c.op) { cur = { op: c.op, idx: [], text: '', b: c.b.slice(), fs: c.fs, font: c.font, c }; runs.push(cur); }
    cur.idx.push(k); cur.text += c.u;
    cur.b = [Math.min(cur.b[0], c.b[0]), Math.min(cur.b[1], c.b[1]), Math.max(cur.b[2], c.b[2]), Math.max(cur.b[3], c.b[3])];
  });
  return runs;
}
function encoder(font) {
  const m = new Map();
  if (font.composite) {
    if (font.toUni) for (const [k, u] of font.toUni.map) { if (typeof u === 'string' && u.length && !m.has(u)) { const n = Math.floor(k / 0x1000000), code = k % 0x1000000; let s = ''; for (let i = n - 1; i >= 0; i--) s += String.fromCharCode((code >> (8 * i)) & 255); m.set(u, s); } }
  } else {
    for (let c = 0; c < 256; c++) {
      const g = font.glyphRec(c, 1, c);
      if (!g.uni || m.has(g.uni)) continue;
      if (font.prog) { const p = font.path(g); if (font.prog !== 't3' && (!p || !p.length) && g.uni !== ' ') continue; }
      m.set(g.uni, String.fromCharCode(c));
    }
  }
  return m;
}
// Replace the text of one run. Uses the run's own font when every character is available; otherwise removes the
// run and re-sets the new text in standard Helvetica at the same position and size.
export function replaceRun(doc, pageIdx, run, text) {
  const page = doc.pages[pageIdx];
  const ops = parseContent(page.contents());
  const o = ops[run.op];
  if (!o) throw new Error('Text not found');
  const enc = encoder(run.font);
  let s = '', ok = true;
  for (const ch of text) { const b = enc.get(ch); if (b === undefined) { ok = false; break; } s += b; }
  const pre = o.op === "'" ? [{ op: 'T*', args: [] }] : o.op === '"' ? [{ op: 'Tw', args: [o.args[0]] }, { op: 'Tc', args: [o.args[1]] }, { op: 'T*', args: [] }] : [];
  if (ok) {
    ops.splice(run.op, 1, ...pre, { op: 'Tj', args: [new Str(s, true)] });
    setContent(doc, page.ref, serContent(ops));
    return { fallback: false };
  }
  // fallback: blank the run (keeping the text position for what follows) and add Helvetica text
  const c = run.c;
  const adv = run.idx.length ? -1000 * run.idx.length : 0; void adv;
  ops.splice(run.op, 1, ...pre, { op: 'Tj', args: [new Str('', true)] });
  setContent(doc, page.ref, serContent(ops));
  const base = std14(run.font.base);
  const fontName = base.mono ? 'Courier' : base.serif ? (base.bold ? 'Times-Bold' : base.italic ? 'Times-Italic' : 'Times-Roman') : base.bold ? 'Helvetica-Bold' : 'Helvetica';
  const p = apply(c.tm ? mmul(c.tm, [1, 0, 0, 1, 0, 0]) : [1, 0, 0, 1, 0, 0], 0, 0);
  void p;
  const x = c.q[0][0], y = c.q[0][1] - (c.q[3][1] - c.q[0][1]) * (-0.2 / 1.0) * 0; // baseline ~ descent corner
  const dy = (c.q[3][1] - c.q[0][1]) * 0.2;
  addText(doc, pageIdx, text, { x, y: y + dy, size: run.fs, font: fontName });
  return { fallback: true };
}

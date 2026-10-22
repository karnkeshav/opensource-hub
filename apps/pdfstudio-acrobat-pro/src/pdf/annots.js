// Annotations: create standard annotation dictionaries with appearance streams, edit geometry, list, flatten.
import { Dict, Ref, Stream, Str, Name, N, bytes, textStr, textOf, pdfDate, parseDate, normRect, clone } from './obj.js';
import { appearance, apMatrix } from './interp.js';
import { addRes, addContent, stdFont, winAnsi, wrapText, textWidth, pdfStrLit, rgbOps, f2 } from './edit.js';

export const MARKUP = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'];
export const BUILDABLE = new Set([...MARKUP, 'Ink', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'FreeText', 'Text', 'Stamp', 'Redact']);
const nums = (doc, v) => { v = doc.get(v); return Array.isArray(v) ? v.map((x) => +doc.get(x) || 0) : []; };
let uid = 0;

export function createAnnot(doc, pageIdx, s) {
  const page = doc.pages[pageIdx];
  const d = new Dict({ Type: N('Annot'), Subtype: N(s.type), Rect: (s.rect || [0, 0, 0, 0]).map((v) => Math.round(v * 100) / 100), F: s.type === 'Link' ? undefined : 4, P: page.ref, M: new Str(pdfDate()), NM: textStr('psa-' + Date.now().toString(36) + '-' + (uid++).toString(36)) });
  if (s.color) d.set('C', s.color);
  if (s.contents) d.set('Contents', textStr(s.contents));
  if (s.author) d.set('T', textStr(s.author));
  if (s.opacity !== undefined && s.opacity < 1) d.set('CA', s.opacity);
  if (s.quads) d.set('QuadPoints', s.quads.map((v) => Math.round(v * 100) / 100));
  if (s.ink) d.set('InkList', s.ink.map((l) => l.map((v) => Math.round(v * 100) / 100)));
  if (s.line) d.set('L', s.line);
  if (s.arrow) d.set('LE', [N('None'), N('OpenArrow')]);
  if (s.vertices) d.set('Vertices', s.vertices);
  if (s.width !== undefined) d.set('BS', new Dict({ W: s.width, S: N(s.dashed ? 'D' : 'S') }));
  if (s.fill) d.set('IC', s.fill);
  if (s.type === 'FreeText') { d.set('DA', new Str(`/Helv ${f2(s.fontSize || 12)} Tf ${rgbOps(s.textColor || [0, 0, 0])}`)); if (s.align) d.set('Q', s.align); }
  if (s.type === 'Text') { d.set('Name', N(s.icon || 'Comment')); d.set('Open', false); }
  if (s.type === 'Stamp') { d.set('Name', N(s.icon || 'Draft')); if (s.label) d.set('PSLabel', textStr(s.label)); }
  if (s.type === 'Link') { d.set('Border', [0, 0, 0]); if (s.uri) d.set('A', new Dict({ S: N('URI'), URI: new Str(s.uri) })); else if (s.page !== undefined) d.set('Dest', [doc.pages[s.page].ref, N('XYZ'), null, null, null]); }
  if (s.type === 'Redact') { d.set('IC', [0, 0, 0]); if (s.quads) d.set('QuadPoints', s.quads); }
  const ref = doc.add(d);
  if (s.imageXO) { d.set('PSImage', s.imageXO.ref); }
  buildAP(doc, d);
  const pd = doc.touch(page.ref);
  const an = doc.get(pd.get('Annots'));
  pd.set('Annots', [...(Array.isArray(an) ? an : []), ref]);
  return ref;
}

function apStream(doc, d, content, res) {
  const r = normRect(nums(doc, d.get('Rect')));
  const sd = new Dict({ Type: N('XObject'), Subtype: N('Form'), BBox: r, Resources: res || new Dict() });
  return new Stream(sd, bytes(content));
}
export function buildAP(doc, d) {
  const type = doc.get(d.get('Subtype'))?.n;
  if (!BUILDABLE.has(type)) return false;
  const col = nums(doc, d.get('C'));
  const c = col.length === 3 ? col : col.length === 1 ? [col[0], col[0], col[0]] : [0, 0, 0];
  const bs = doc.get(d.get('BS'));
  const w = bs instanceof Dict && typeof doc.get(bs.get('W')) === 'number' ? doc.get(bs.get('W')) : 1;
  const ca = doc.get(d.get('CA'));
  const res = new Dict();
  let s = '';
  const gs = (bm) => { const g = new Dict({ Type: N('ExtGState'), CA: ca ?? 1, ca: ca ?? 1 }); if (bm) g.set('BM', N(bm)); res.set('ExtGState', new Dict({ G0: g })); return '/G0 gs '; };
  const R = normRect(nums(doc, d.get('Rect')));
  if (MARKUP.includes(type) || type === 'Redact') {
    const q = nums(doc, d.get('QuadPoints'));
    const quads = [];
    for (let i = 0; i + 7 < q.length; i += 8) quads.push(q.slice(i, i + 8));
    if (!quads.length) quads.push([R[0], R[3], R[2], R[3], R[0], R[1], R[2], R[1]]);
    s += 'q ' + gs(type === 'Highlight' ? 'Multiply' : null);
    for (const k of quads) {
      // points: (x1,y1) (x2,y2) top, (x3,y3) (x4,y4) bottom
      const [x1, y1, x2, y2, x3, y3, x4, y4] = k;
      const h = Math.hypot(x1 - x3, y1 - y3) || 10;
      if (type === 'Highlight') s += `${rgbOps(c)} ${f2(x3)} ${f2(y3)} m ${f2(x4)} ${f2(y4)} l ${f2(x2)} ${f2(y2)} l ${f2(x1)} ${f2(y1)} l f\n`;
      else if (type === 'Redact') s += `1 0 0 RG 1.5 w ${f2(x3)} ${f2(y3)} m ${f2(x4)} ${f2(y4)} l ${f2(x2)} ${f2(y2)} l ${f2(x1)} ${f2(y1)} l s\n`;
      else {
        const lw = Math.max(0.6, h / 16);
        const t = type === 'StrikeOut' ? 0.5 : 0.08;
        const ax = x3 + (x1 - x3) * t, ay = y3 + (y1 - y3) * t, bx = x4 + (x2 - x4) * t, by = y4 + (y2 - y4) * t;
        if (type === 'Squiggly') {
          const L = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.round(L / (h / 4))), ux = (bx - ax) / n, uy = (by - ay) / n, nx = -(y1 - y3) / h * h / 12, ny = (x1 - x3) / h * h / 12;
          s += `${rgbOps(c, true)} ${f2(lw)} w ${f2(ax)} ${f2(ay)} m`;
          for (let i = 1; i <= n; i++) s += ` ${f2(ax + ux * i + (i % 2 ? nx : 0))} ${f2(ay + uy * i + (i % 2 ? ny : 0))} l`;
          s += ' S\n';
        } else s += `${rgbOps(c, true)} ${f2(lw)} w ${f2(ax)} ${f2(ay)} m ${f2(bx)} ${f2(by)} l S\n`;
      }
    }
    s += 'Q';
  } else if (type === 'Ink') {
    s += 'q ' + gs() + `${rgbOps(c, true)} ${f2(w)} w 1 J 1 j\n`;
    for (const l of doc.get(d.get('InkList')) || []) {
      const p = nums(doc, l);
      if (p.length < 2) continue;
      s += `${f2(p[0])} ${f2(p[1])} m `;
      if (p.length === 2) s += `${f2(p[0] + 0.01)} ${f2(p[1])} l `;
      for (let i = 2; i + 1 < p.length; i += 2) {
        if (i + 3 < p.length) { const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2; s += `${f2(p[i])} ${f2(p[i + 1])} ${f2(mx)} ${f2(my)} v `; }
        else s += `${f2(p[i])} ${f2(p[i + 1])} l `;
      }
      s += 'S\n';
    }
    s += 'Q';
  } else if (type === 'Line') {
    const [x1, y1, x2, y2] = nums(doc, d.get('L'));
    s += 'q ' + gs() + `${rgbOps(c, true)} ${f2(w)} w 1 J 1 j ${f2(x1)} ${f2(y1)} m ${f2(x2)} ${f2(y2)} l S\n`;
    const le = doc.get(d.get('LE'));
    const endArrow = Array.isArray(le) && doc.get(le[1])?.n && doc.get(le[1]).n !== 'None';
    if (endArrow) {
      const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(8, w * 4);
      const p1 = [x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], p2 = [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)];
      s += `${f2(p1[0])} ${f2(p1[1])} m ${f2(x2)} ${f2(y2)} l ${f2(p2[0])} ${f2(p2[1])} l S\n`;
    }
    s += 'Q';
  } else if (type === 'Square' || type === 'Circle') {
    const ic = nums(doc, d.get('IC'));
    const x0 = R[0] + w / 2, y0 = R[1] + w / 2, x1 = R[2] - w / 2, y1 = R[3] - w / 2;
    s += 'q ' + gs() + `${rgbOps(c, true)} ${ic.length === 3 ? rgbOps(ic) : ''} ${f2(w)} w `;
    const op = ic.length === 3 ? (w > 0 ? 'B' : 'f') : 'S';
    if (type === 'Square') s += `${f2(x0)} ${f2(y0)} ${f2(x1 - x0)} ${f2(y1 - y0)} re ${op}`;
    else {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, k = 0.5523;
      s += `${f2(cx + rx)} ${f2(cy)} m ${f2(cx + rx)} ${f2(cy + ry * k)} ${f2(cx + rx * k)} ${f2(cy + ry)} ${f2(cx)} ${f2(cy + ry)} c ${f2(cx - rx * k)} ${f2(cy + ry)} ${f2(cx - rx)} ${f2(cy + ry * k)} ${f2(cx - rx)} ${f2(cy)} c ${f2(cx - rx)} ${f2(cy - ry * k)} ${f2(cx - rx * k)} ${f2(cy - ry)} ${f2(cx)} ${f2(cy - ry)} c ${f2(cx + rx * k)} ${f2(cy - ry)} ${f2(cx + rx)} ${f2(cy - ry * k)} ${f2(cx + rx)} ${f2(cy)} c h ${op}`;
    }
    s += ' Q';
  } else if (type === 'Polygon' || type === 'PolyLine') {
    const v = nums(doc, d.get('Vertices'));
    const ic = nums(doc, d.get('IC'));
    s += 'q ' + gs() + `${rgbOps(c, true)} ${ic.length === 3 ? rgbOps(ic) : ''} ${f2(w)} w 1 j `;
    for (let i = 0; i + 1 < v.length; i += 2) s += `${f2(v[i])} ${f2(v[i + 1])} ${i ? 'l' : 'm'} `;
    s += type === 'Polygon' ? (ic.length === 3 ? 'b' : 's') : 'S';
    s += ' Q';
  } else if (type === 'FreeText') {
    const da = textOf(doc.get(d.get('DA')));
    const m = /([\d.]+)\s+Tf/.exec(da), size = m ? +m[1] || 12 : 12;
    const tc = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
    const text = textOf(doc.get(d.get('Contents')));
    res.set('Font', new Dict({ Helv: stdFont(doc) }));
    const lines = wrapText(text, size, Math.max(10, R[2] - R[0] - 4));
    const q = doc.get(d.get('Q')) | 0;
    const ic = nums(doc, d.get('IC'));
    s += 'q ' + gs();
    if (ic.length === 3) s += `${rgbOps(ic)} ${f2(R[0])} ${f2(R[1])} ${f2(R[2] - R[0])} ${f2(R[3] - R[1])} re f `;
    if (col.length && w > 0) s += `${rgbOps(c, true)} ${f2(w)} w ${f2(R[0] + w / 2)} ${f2(R[1] + w / 2)} ${f2(R[2] - R[0] - w)} ${f2(R[3] - R[1] - w)} re S `;
    s += `${f2(R[0])} ${f2(R[1])} ${f2(R[2] - R[0])} ${f2(R[3] - R[1])} re W n BT /Helv ${f2(size)} Tf ${tc ? tc[0] : '0 g'}\n`;
    lines.forEach((ln, i) => {
      const lw = textWidth(ln, size), x = q === 1 ? (R[0] + R[2] - lw) / 2 : q === 2 ? R[2] - 2 - lw : R[0] + 2;
      s += `1 0 0 1 ${f2(x)} ${f2(R[3] - 2 - size * (i + 1) + size * 0.2)} Tm ${pdfStrLit(winAnsi(ln))} Tj\n`;
    });
    s += 'ET Q';
  } else if (type === 'Text') {
    const x = R[0], y = R[1], W = R[2] - R[0], H = R[3] - R[1];
    s += `q ${rgbOps(c.length ? c : [1, 0.82, 0.2])} 0.25 0.25 0.25 RG 0.8 w ${f2(x + 1)} ${f2(y + H * 0.2)} ${f2(W - 2)} ${f2(H * 0.78)} re B `;
    s += `${f2(x + W * 0.25)} ${f2(y + H * 0.2)} m ${f2(x + W * 0.2)} ${f2(y)} l ${f2(x + W * 0.45)} ${f2(y + H * 0.2)} l f `;
    for (let i = 1; i <= 3; i++) s += `${f2(x + W * 0.2)} ${f2(y + H * (0.2 + 0.19 * i))} m ${f2(x + W * 0.8)} ${f2(y + H * (0.2 + 0.19 * i))} l S `;
    s += 'Q';
  } else if (type === 'Stamp') {
    const img = d.get('PSImage');
    if (img instanceof Ref) {
      res.set('XObject', new Dict({ Im0: img }));
      s += `q ${gs()}${f2(R[2] - R[0])} 0 0 ${f2(R[3] - R[1])} ${f2(R[0])} ${f2(R[1])} cm /Im0 Do Q`;
    } else {
      const label = textOf(doc.get(d.get('PSLabel'))) || doc.get(d.get('Name'))?.n?.toUpperCase() || 'DRAFT';
      res.set('Font', new Dict({ HelvB: stdFont(doc, 'Helvetica-Bold') }));
      const H = R[3] - R[1], W = R[2] - R[0], lines = label.split('\n');
      const size = Math.min(H * 0.55 / lines.length, (W * 0.9 * 1000) / Math.max(...lines.map((l) => textWidth(l, 1000, 'Helvetica-Bold')), 1));
      const cc = c.length ? c : [0.8, 0.1, 0.1];
      s += `q ${gs()}${rgbOps(cc, true)} ${f2(Math.max(1.5, H / 16))} w ${f2(R[0] + 2)} ${f2(R[1] + 2)} ${f2(W - 4)} ${f2(H - 4)} re S BT /HelvB ${f2(size)} Tf ${rgbOps(cc)}\n`;
      lines.forEach((l, i) => { const tw = textWidth(l, size, 'Helvetica-Bold'); s += `1 0 0 1 ${f2(R[0] + (W - tw) / 2)} ${f2(R[1] + H / 2 + (lines.length / 2 - i - 1) * size * 1.1 + size * 0.15)} Tm ${pdfStrLit(winAnsi(l))} Tj\n`; });
      s += 'ET Q';
    }
  }
  const ap = doc.add(apStream(doc, d, s, res));
  d.set('AP', new Dict({ N: ap }));
  return true;
}

// Transform geometry (affine T = [a b c d e f] in user space) and rebuild appearance if we own the type.
export function transformAnnot(doc, ref, T) {
  const d = doc.touch(ref);
  const tp = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
  const tl = (arr) => { const o = []; for (let i = 0; i + 1 < arr.length; i += 2) o.push(...tp(arr[i], arr[i + 1])); return o.map((v) => Math.round(v * 100) / 100); };
  const r = nums(doc, d.get('Rect'));
  const a = tp(r[0], r[1]), b = tp(r[2], r[3]);
  d.set('Rect', normRect([...a, ...b]).map((v) => Math.round(v * 100) / 100));
  for (const k of ['QuadPoints', 'L', 'Vertices', 'CL']) if (d.has(k)) d.set(k, tl(nums(doc, d.get(k))));
  if (d.has('InkList')) d.set('InkList', (doc.get(d.get('InkList')) || []).map((l) => tl(nums(doc, l))));
  const type = doc.get(d.get('Subtype'))?.n;
  if (d.get('NM') && textOf(doc.get(d.get('NM'))).startsWith('psa-') && BUILDABLE.has(type)) buildAP(doc, d);
  else if (['FreeText', 'Square', 'Circle'].includes(type) && !doc.get(d.get('AP'))) buildAP(doc, d);
  d.set('M', new Str(pdfDate()));
}
export function updateAnnot(doc, ref, props) {
  const d = doc.touch(ref);
  if ('contents' in props) d.set('Contents', textStr(props.contents));
  if ('color' in props) d.set('C', props.color);
  if ('opacity' in props) d.set('CA', props.opacity);
  if ('width' in props) d.set('BS', new Dict({ W: props.width, S: N('S') }));
  if ('fontSize' in props || 'textColor' in props) {
    const da = textOf(doc.get(d.get('DA')));
    const m = /([\d.]+)\s+Tf/.exec(da);
    d.set('DA', new Str(`/Helv ${f2(props.fontSize ?? (m ? +m[1] : 12))} Tf ${rgbOps(props.textColor || [0, 0, 0])}`));
  }
  d.set('M', new Str(pdfDate()));
  buildAP(doc, d);
}
export function deleteAnnot(doc, pageIdx, ref) {
  const page = doc.pages[pageIdx];
  const pd = doc.touch(page.ref);
  const an = doc.get(pd.get('Annots')) || [];
  const d = doc.get(ref);
  const pop = d instanceof Dict ? d.get('Popup') : null;
  pd.set('Annots', an.filter((r) => !(r instanceof Ref && (r.num === ref.num || (pop instanceof Ref && r.num === pop.num)))));
}
export function listAnnots(doc) {
  const out = [];
  doc.pages.forEach((p, i) => {
    for (const r of p.annots) {
      const d = doc.get(r);
      if (!(d instanceof Dict)) continue;
      const type = doc.get(d.get('Subtype'))?.n;
      if (!type || type === 'Popup') continue;
      out.push({ page: i, ref: r, type, contents: textOf(doc.get(d.get('Contents'))), author: textOf(doc.get(d.get('T'))), date: parseDate(textOf(doc.get(d.get('M')))), rect: normRect(nums(doc, d.get('Rect'))), color: nums(doc, d.get('C')), dict: d });
    }
  });
  return out;
}
// Flatten annotations into page content (filter(dict) -> bool)
export function flattenAnnots(doc, pages, filter = () => true) {
  let n = 0;
  for (const i of pages) {
    const p = doc.pages[i];
    const keep = [];
    let s = '';
    for (const r of p.annots) {
      const d = doc.get(r);
      if (!(d instanceof Dict)) continue;
      const type = doc.get(d.get('Subtype'))?.n;
      const F = doc.get(d.get('F')) | 0;
      if (!filter(d, type) || type === 'Popup' || type === 'Link') { keep.push(r); continue; }
      const ap = appearance(doc, d);
      if (ap && !(F & 2) && !(F & 32)) {
        const R = normRect(nums(doc, d.get('Rect')));
        const m = apMatrix(doc, ap, R);
        // form XObject must be indirect
        let apRef = null;
        const apd = doc.get(d.get('AP'));
        let nref = apd.get('N');
        if (!(nref instanceof Ref)) { const as = doc.get(d.get('AS')); const nd = doc.get(nref); nref = nd instanceof Dict && as instanceof Name ? nd.get(as.n) : nref; }
        apRef = nref instanceof Ref ? nref : doc.add(ap);
        const st = doc.touch(apRef);
        st.dict.set('Type', N('XObject')); st.dict.set('Subtype', N('Form'));
        const nm = addRes(doc, p.ref, 'XObject', apRef, 'PSa');
        s += `q ${m.map(f2).join(' ')} cm /${nm} Do Q\n`;
      }
      n++;
    }
    if (s) addContent(doc, p.ref, s);
    const pd = doc.touch(p.ref);
    if (keep.length) pd.set('Annots', keep); else pd.delete('Annots');
  }
  return n;
}
export { clone };

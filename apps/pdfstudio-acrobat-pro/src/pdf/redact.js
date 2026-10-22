// True redaction: physically removes text glyphs, vector paths, image pixels, inline images, form content,
// annotations and form-field values under the marked areas; then paints opaque boxes. Plus document sanitizing.
import { Dict, Ref, Stream, Str, Name, N, overlaps, normRect, inv, apply, mmul, clone, bboxOf } from './obj.js';
import { parseContent, serContent } from './content.js';
import { Interp } from './interp.js';
import { NULL_DEV } from './text.js';
import { decodeImage } from './image.js';
import { addContent, addRes, setContent, imageXObject, rgbOps, f2 } from './edit.js';
import { fields } from './forms.js';

const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const hits = (b, rects) => rects.some((r) => overlaps(b, r));

// Redact a list of operations (one content level). Returns new ops. ctm0 maps this level to page space.
async function redactLevel(doc, ops, res, ctm0, rects, stats, opts, depth, pageArea) {
  const chars = [], objs = [];
  const it = new Interp(doc, NULL_DEV, { skipImages: true, noAnnots: true, onChar: (c) => { if (c.lvl === 0) chars.push(c); }, onObj: (o) => { if (o.lvl === 0) objs.push(o); } });
  await it.runOps(ops, res, ctm0);
  const kill = new Map(); // op -> Set(glyph idx)
  for (const c of chars) {
    const xs = c.q.map((p) => p[0]), ys = c.q.map((p) => p[1]);
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // shrink the glyph box a little so neighbours touching the edge survive
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, hw = (b[2] - b[0]) * 0.3, hh = (b[3] - b[1]) * 0.3;
    if (hits([cx - hw, cy - hh, cx + hw, cy + hh], rects)) { if (!kill.has(c.op)) kill.set(c.op, { set: new Set(), c }); kill.get(c.op).set.add(c.idx); }
  }
  const out = ops.slice();
  const replace = new Map();
  for (const [opi, { set, c }] of kill) {
    const o = ops[opi];
    const items = o.op === 'TJ' ? o.args[0] : o.op === '"' ? [o.args[2]] : [o.args[0]];
    if (!Array.isArray(items)) continue;
    const font = c.font;
    const arr = [];
    let gi = 0, cur = '';
    for (const it2 of items) {
      const v = doc.get(it2);
      if (typeof v === 'number') { if (cur) { arr.push(new Str(cur, true)); cur = ''; } arr.push(v); continue; }
      if (!(v instanceof Str)) continue;
      const gl = font.decode(v.s);
      let p = 0;
      for (const g of gl) {
        const bytes = v.s.substr(p, g.n); p += g.n;
        if (set.has(gi)) {
          if (cur) { arr.push(new Str(cur, true)); cur = ''; }
          const adv = c.fsz ? g.w + ((c.tc + (g.space ? c.tw : 0)) * 1000) / c.fsz : g.w;
          const last = arr[arr.length - 1];
          if (typeof last === 'number') arr[arr.length - 1] = last - adv; else arr.push(-adv);
          stats.glyphs++;
        } else cur += bytes;
        gi++;
      }
    }
    if (cur) arr.push(new Str(cur, true));
    const pre = o.op === "'" ? [{ op: 'T*', args: [] }] : o.op === '"' ? [{ op: 'Tw', args: [o.args[0]] }, { op: 'Tc', args: [o.args[1]] }, { op: 'T*', args: [] }] : [];
    replace.set(opi, [...pre, { op: 'TJ', args: [arr.map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x))] }]);
  }
  for (const ob of objs) {
    if (!ob.bbox && ob.kind !== 'shading') continue;
    if (ob.kind === 'path' && ob.bbox && hits(ob.bbox, rects)) {
      const big = area(ob.bbox) > pageArea * 0.25 && !rects.some((r) => area(inter(ob.bbox, r)) > area(ob.bbox) * 0.6);
      if (!big) { replace.set(ob.op, [{ op: 'n', args: [] }]); stats.paths++; }
    } else if (ob.kind === 'inline' && hits(ob.bbox, rects)) { replace.set(ob.op, []); stats.images++; }
    else if (ob.kind === 'image' && hits(ob.bbox, rects)) {
      const full = rects.some((r) => ob.bbox[0] >= r[0] && ob.bbox[1] >= r[1] && ob.bbox[2] <= r[2] && ob.bbox[3] <= r[3]);
      const xo = doc.get(ob.ref);
      let done = false;
      if (!full && xo instanceof Stream) {
        try {
          let img = decodeImage(doc, xo, res);
          if (img.jpeg && opts.decodeJpeg) img = { ...img, ...(await opts.decodeJpeg(img.jpeg)) };
          if (img.rgba && !img.unsupported) {
            const rgba = new Uint8ClampedArray(img.rgba);
            const im = inv(ob.ctm), W = img.w, H = img.h;
            for (const r of rects) {
              if (!overlaps(ob.bbox, r)) continue;
              const ib = bboxOf(im, r); // in unit image space
              const x0 = Math.max(0, Math.floor(ib[0] * W)), x1 = Math.min(W, Math.ceil(ib[2] * W)), y0 = Math.max(0, Math.floor((1 - ib[3]) * H)), y1 = Math.min(H, Math.ceil((1 - ib[1]) * H));
              for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = 0; rgba[k + 3] = 255; }
            }
            const nx = await imageXObject(doc, { w: W, h: H, rgba });
            const nm = opts.addXObject(nx.ref);
            replace.set(ob.op, [{ op: 'Do', args: [N(nm)] }]);
            done = true; stats.images++;
          }
        } catch { /* fall through to removal */ }
      }
      if (!done) { replace.set(ob.op, []); stats.images++; }
    } else if (ob.kind === 'form' && ob.bbox && hits(ob.bbox, rects) && depth < 8) {
      const xo = doc.get(ob.ref);
      if (!(xo instanceof Stream)) continue;
      const fm = doc.get(xo.dict.get('Matrix'));
      const M = Array.isArray(fm) && fm.length === 6 ? fm.map((x) => +doc.get(x)) : [1, 0, 0, 1, 0, 0];
      // CTM at the Do: recover from the interpreter by re-running is costly; ob.bbox already in page space, use stored ctm
      const ctm = ob.ctm || ctm0;
      const fres = doc.get(xo.dict.get('Resources'));
      const sub = parseContent(doc.decoded(xo));
      const subOpts = { ...opts, addXObject: (ref) => { const r2 = clone(fres instanceof Dict ? fres : new Dict()); const xs = clone(doc.get(r2.get('XObject')) || new Dict()); let i = 1; while (xs.has('RX' + i)) i++; xs.set('RX' + i, ref); r2.set('XObject', xs); localRes = r2; return 'RX' + i; } };
      let localRes = fres instanceof Dict ? fres : res;
      const nops = await redactLevel(doc, sub, localRes, mmul(M, ctm), rects, stats, subOpts, depth + 1, pageArea);
      const nd = clone(xo.dict); nd.delete('Filter'); nd.delete('DecodeParms'); nd.delete('Length');
      if (localRes !== fres) nd.set('Resources', localRes);
      const nref = doc.add(new Stream(nd, serContent(nops)));
      const nm = opts.addXObject(nref);
      replace.set(ob.op, [{ op: 'Do', args: [N(nm)] }]);
      stats.forms++;
    }
  }
  const res2 = [];
  out.forEach((o, i) => { if (replace.has(i)) res2.push(...replace.get(i)); else res2.push(o); });
  return res2;
}

// rects: page-space rectangles. opts: { fill: [r,g,b] | null, decodeJpeg(bytes) -> Promise<{w,h,rgba}> }
export async function redactPage(doc, pageIdx, rects, opts = {}) {
  rects = rects.map(normRect);
  const page = doc.pages[pageIdx];
  const stats = { glyphs: 0, paths: 0, images: 0, forms: 0, annots: 0, fields: 0 };
  const ops = parseContent(page.contents());
  const v = page.view, pageArea = area(v);
  const o2 = { ...opts, addXObject: (ref) => addRes(doc, page.ref, 'XObject', ref, 'RX') };
  // the Interp records the CTM at form Do via onObj only for images; make it record forms too
  const nops = await redactLevel(doc, ops, page.resources, [1, 0, 0, 1, 0, 0], rects, stats, o2, 0, pageArea);
  setContent(doc, page.ref, serContent(nops));
  // annotations and form fields under the areas
  const pd = doc.touch(page.ref);
  const keep = [];
  const fl = fields(doc);
  for (const r of doc.get(pd.get('Annots')) || []) {
    const a = doc.get(r);
    const R = a instanceof Dict ? normRect((doc.get(a.get('Rect')) || [0, 0, 0, 0]).map((x) => +doc.get(x))) : null;
    if (R && hits(R, rects)) {
      stats.annots++;
      if (doc.get(a.get('Subtype'))?.n === 'Widget') {
        const f = fl.find((x) => x.widgets.some((w) => w.ref.num === r.num));
        if (f) { const fd = doc.touch(f.ref); fd.delete('V'); fd.delete('DV'); stats.fields++; }
      }
      continue;
    }
    keep.push(r);
  }
  if (keep.length) pd.set('Annots', keep); else pd.delete('Annots');
  if (opts.fill !== null) {
    let s = 'q ' + rgbOps(opts.fill || [0, 0, 0]) + '\n';
    for (const r of rects) s += `${f2(r[0])} ${f2(r[1])} ${f2(r[2] - r[0])} ${f2(r[3] - r[1])} re f\n`;
    addContent(doc, page.ref, s + 'Q\n');
  }
  doc.needsFullSave = true;
  return stats;
}

// Collect Redact annotations, apply them, remove the marks.
export async function applyRedactAnnots(doc, opts = {}) {
  const total = { glyphs: 0, paths: 0, images: 0, forms: 0, annots: 0, fields: 0, pages: 0 };
  for (let i = 0; i < doc.pageCount; i++) {
    const rects = [];
    for (const r of doc.pages[i].annots) {
      const a = doc.get(r);
      if (!(a instanceof Dict) || doc.get(a.get('Subtype'))?.n !== 'Redact') continue;
      const q = (doc.get(a.get('QuadPoints')) || []).map((x) => +doc.get(x));
      if (q.length >= 8) for (let k = 0; k + 7 < q.length; k += 8) rects.push(normRect([Math.min(q[k], q[k + 4]), Math.min(q[k + 5], q[k + 7]), Math.max(q[k + 2], q[k + 6]), Math.max(q[k + 1], q[k + 3])]));
      else rects.push(normRect((doc.get(a.get('Rect')) || []).map((x) => +doc.get(x))));
    }
    if (!rects.length) continue;
    const s = await redactPage(doc, i, rects, opts);
    total.pages++;
    for (const k in s) total[k] += s[k];
  }
  return total;
}

// Remove content of hidden optional-content groups (marked content /OC with OFF groups) from page streams.
export async function removeHiddenLayers(doc) {
  const it = new Interp(doc, NULL_DEV, {});
  let removed = 0;
  for (const page of doc.pages) {
    const ops = parseContent(page.contents()), res = page.resources;
    const props = doc.get(res.get('Properties'));
    const out = []; let skip = 0;
    const stack = [];
    for (const o of ops) {
      if (o.op === 'BDC' || o.op === 'BMC') {
        let hide = false;
        if (o.op === 'BDC' && o.args[0] instanceof Name && o.args[0].n === 'OC') { const p = o.args[1] instanceof Name && props instanceof Dict ? props.get(o.args[1].n) : o.args[1]; hide = it.hidden(p); }
        stack.push(hide); if (hide) skip++;
        if (!skip) out.push(o); else if (hide) removed++;
        continue;
      }
      if (o.op === 'EMC') { const h = stack.pop(); if (!skip) out.push(o); if (h) skip--; continue; }
      if (!skip) out.push(o);
    }
    if (out.length !== ops.length) setContent(doc, page.ref, serContent(out));
  }
  return removed;
}

// Sanitize: strip metadata, scripts, attachments, thumbnails, private app data, hidden layers' content.
export async function sanitize(doc, o = {}) {
  const report = [];
  const cat = doc.touch(doc.rootRef);
  if (o.metadata !== false) {
    const tr = doc.touchTrailer();
    if (tr.get('Info')) { tr.delete('Info'); report.push('document info'); }
    if (cat.get('Metadata')) { cat.delete('Metadata'); report.push('XMP metadata'); }
    if (cat.get('PieceInfo')) { cat.delete('PieceInfo'); report.push('private application data'); }
  }
  if (o.scripts !== false) {
    const oa = doc.get(cat.get('OpenAction'));
    if (oa instanceof Dict && doc.get(oa.get('S'))?.n !== 'GoTo') { cat.delete('OpenAction'); report.push('open action'); }
    if (cat.get('AA')) { cat.delete('AA'); report.push('document actions'); }
  }
  const names = doc.get(cat.get('Names'));
  if (names instanceof Dict) {
    const n2 = clone(names);
    if (o.scripts !== false && n2.has('JavaScript')) { n2.delete('JavaScript'); report.push('JavaScript'); }
    if (o.attachments !== false && n2.has('EmbeddedFiles')) { n2.delete('EmbeddedFiles'); report.push('attachments'); }
    cat.set('Names', n2);
  }
  for (const p of doc.pages) {
    const pd = doc.touch(p.ref);
    if (o.metadata !== false) { pd.delete('PieceInfo'); pd.delete('Metadata'); }
    if (o.thumbnails !== false) pd.delete('Thumb');
    if (o.scripts !== false) pd.delete('AA');
    if (o.scripts !== false || o.attachments !== false) {
      const an = doc.get(pd.get('Annots'));
      if (Array.isArray(an)) pd.set('Annots', an.filter((r) => { const a = doc.get(r); const t = a instanceof Dict && doc.get(a.get('Subtype'))?.n; return !(o.attachments !== false && t === 'FileAttachment'); }));
      for (const r of doc.get(pd.get('Annots')) || []) { const a = doc.get(r); if (a instanceof Dict && (a.has('AA') || (doc.get(a.get('A')) instanceof Dict && doc.get(doc.get(a.get('A')).get('S'))?.n === 'JavaScript'))) { const ad = doc.touch(r); ad.delete('AA'); if (doc.get(doc.get(ad.get('A'))?.get?.('S'))?.n === 'JavaScript') ad.delete('A'); } }
    }
  }
  if (o.hiddenLayers !== false) { const n = await removeHiddenLayers(doc); if (n) report.push(n + ' hidden layer sections'); }
  if (o.comments) { for (const p of doc.pages) { const pd = doc.touch(p.ref); const an = doc.get(pd.get('Annots')); if (Array.isArray(an)) pd.set('Annots', an.filter((r) => ['Widget', 'Link'].includes(doc.get(doc.get(r)?.get?.('Subtype'))?.n))); } report.push('comments'); }
  doc.needsFullSave = true;
  return report;
}
export { apply };

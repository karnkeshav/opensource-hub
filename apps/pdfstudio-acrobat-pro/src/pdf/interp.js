// Content stream interpreter. DOM-free: it drives a "device" (canvas adapter in the browser, recorder in tests)
// and reports characters/objects to listeners for text selection, search, redaction and object editing.
//
// Device API (all matrices map to PDF user space; the device composes its own page transform):
//   save() restore() fill(path, ctm, evenOdd, paint) stroke(path, ctm, style, paint) clip(path, ctm, evenOdd)
//   glyph(path, m, mode, fill, stroke, style) text(str, css, m, sx, mode, fill, stroke) textClip(path, m) endTextClip()
//   image(img, ctm, alpha) -> Promise   shade(desc, ctm, alpha)   tile(info) -> Promise<paint>
import { Dict, Stream, Name, Ref, Str, N, mmul, apply, inv, bboxOf } from './obj.js';
import { parseContent } from './content.js';
import { loadFont } from './fonts/font.js';
import { getCS, PATTERN, rgbCss, DEV } from './color.js';
import { decodeImage, expandInline } from './image.js';
import { shadingDesc } from './shading.js';

const ID = [1, 0, 0, 1, 0, 0];
function newGS(ctm) {
  return {
    ctm, fcs: DEV.DeviceGray, scs: DEV.DeviceGray, fc: [0], sc: [0], fpat: null, spat: null,
    lw: 1, cap: 0, join: 0, miter: 10, dash: [], phase: 0, fa: 1, sa: 1, bm: null, smask: false,
    font: null, fs: 12, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, base: ctm,
  };
}
export function pageMatrix(page, scale, extraRot = 0) {
  const v = page.view, s = scale, r = (page.rotate + extraRot) % 360;
  if (r === 90) return [0, s, s, 0, -v[1] * s, -v[0] * s];
  if (r === 180) return [-s, 0, 0, s, v[2] * s, -v[1] * s];
  if (r === 270) return [0, -s, -s, 0, v[3] * s, v[2] * s];
  return [s, 0, 0, -s, -v[0] * s, v[3] * s];
}

export class Interp {
  constructor(doc, dev, opts = {}) {
    this.doc = doc; this.dev = dev; this.o = opts; this.warn = new Set(); this.ops = 0;
    this.ocOff = new Set();
    try {
      const ocp = doc.get(doc.catalog.get('OCProperties'));
      const d = ocp && doc.get(ocp.get('D'));
      const off = d && doc.get(d.get('OFF'));
      if (Array.isArray(off)) for (const r of off) if (r instanceof Ref) this.ocOff.add(r.num);
    } catch {}
  }
  get(v) { return this.doc.get(v); }
  hidden(oc) {
    if (!(oc instanceof Ref)) return false;
    if (this.ocOff.has(oc.num)) return true;
    const d = this.get(oc);
    if (d instanceof Dict && d.get('Type') instanceof Name && d.get('Type').n === 'OCMD') {
      const ocgs = this.get(d.get('OCGs')), list = Array.isArray(ocgs) ? ocgs : ocgs ? [d.get('OCGs')] : [];
      const p = this.get(d.get('P'))?.n || 'AnyOn';
      const on = list.map((r) => !(r instanceof Ref && this.ocOff.has(r.num)));
      if (!list.length) return false;
      if (p === 'AllOn') return !on.every(Boolean);
      if (p === 'AnyOff') return !on.some((x) => !x);
      if (p === 'AllOff') return !on.every((x) => !x);
      return !on.some(Boolean);
    }
    return false;
  }
  // Render a page's content (and annotation appearances unless opts.noAnnots)
  async page(page) {
    const ops = parseContent(page.contents());
    this.pageOps = ops;
    const gs = newGS(ID);
    this.dev.save();
    try { await this.run(ops, page.resources, gs, 0); } catch (e) { if (e && e.name === 'AbortError') throw e; this.warn.add('Content error: ' + (e && e.message)); }
    this.dev.restore();
    if (!this.o.noAnnots) await this.annots(page);
    return ops;
  }
  async annots(page) {
    const hide = this.o.hideAnnot || (() => false);
    for (const r of page.annots) {
      const a = this.get(r);
      if (!(a instanceof Dict)) continue;
      const st = this.get(a.get('Subtype'))?.n;
      const F = this.get(a.get('F')) | 0;
      if (F & 2 || F & 32 || st === 'Popup' || hide(a, r)) continue;
      if (this.o.print && !(F & 4) && st !== 'Widget') continue;
      const ap = appearance(this.doc, a);
      if (!ap) continue;
      try { await this.drawAP(ap, a); } catch (e) { this.warn.add('Annotation error: ' + e.message); }
    }
  }
  async drawAP(ap, a) {
    const rect = this.get(a.get('Rect'));
    if (!Array.isArray(rect)) return;
    const R = rect.map((x) => +this.get(x));
    const m = apMatrix(this.doc, ap, R);
    if (!m) return;
    const gs = newGS(ID);
    this.dev.save();
    await this.form(ap, gs, m, 1, null);
    this.dev.restore();
  }
  async form(xo, gs, extra, lvl, res) {
    const d = xo.dict;
    const fm = this.get(d.get('Matrix'));
    const M = Array.isArray(fm) && fm.length === 6 ? fm.map((x) => +this.get(x)) : ID;
    const g2 = { ...gs, ctm: mmul(mmul(M, extra || ID), gs.ctm) };
    g2.base = g2.ctm;
    this.dev.save();
    const bb = this.get(d.get('BBox'));
    if (Array.isArray(bb) && bb.length === 4) {
      const b = bb.map((x) => +this.get(x));
      this.dev.clip(['M', b[0], b[1], 'L', b[2], b[1], 'L', b[2], b[3], 'L', b[0], b[3], 'Z'], g2.ctm, false);
    }
    xo.ops = xo.ops || parseContent(this.doc.decoded(xo));
    const fres = this.get(d.get('Resources'));
    await this.run(xo.ops, fres instanceof Dict ? fres : res || new Dict(), g2, lvl);
    this.dev.restore();
  }

  async run(ops, res, gs, lvl) {
    const dev = this.dev, doc = this.doc, o = this.o;
    const stack = [];
    let path = [], bb = [Infinity, Infinity, -Infinity, -Infinity], clipPending = 0, cx = 0, cy = 0, sx = 0, sy = 0;
    let tm = ID, tlm = ID, inText = false, textClip = false;
    const hideStack = [];
    let hidden = false;
    const resGet = (cat, name) => { const c = this.get(res.get(cat)); return c instanceof Dict ? c.get(name) : undefined; };
    const pt = (x, y) => { const p = apply(gs.ctm, x, y); if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1]; };
    const paint = async (stroke) => {
      if (gs.forceColor) return { c: gs.forceColor, a: stroke ? gs.sa : gs.fa };
      const pat = stroke ? gs.spat : gs.fpat, a = stroke ? gs.sa : gs.fa;
      if (pat) return this.patternPaint(pat, gs, res, a);
      const cs = stroke ? gs.scs : gs.fcs;
      const rgb = cs.rgb(stroke ? gs.sc : gs.fc);
      if (!rgb) return null;
      return { c: rgbCss(rgb), a, bm: gs.bm };
    };
    const style = () => ({ lw: gs.lw, cap: gs.cap, join: gs.join, miter: gs.miter, dash: gs.dash, phase: gs.phase });
    const endPath = (opIdx, kind) => {
      if (clipPending && path.length) dev.clip(path, gs.ctm, clipPending === 2);
      if (kind && lvl === 0 && o.onObj && path.length && bb[0] <= bb[2]) o.onObj({ kind: 'path', op: opIdx, bbox: bb.slice(), lvl });
      clipPending = 0; path = []; bb = [Infinity, Infinity, -Infinity, -Infinity];
    };
    for (let i = 0; i < ops.length; i++) {
      if ((++this.ops & 1023) === 0 && o.signal && o.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const { op, args: A } = ops[i];
      const n = (k) => +this.get(A[k]) || 0;
      switch (op) {
        case 'q': stack.push({ ...gs }); dev.save(); break;
        case 'Q': if (stack.length) { gs = stack.pop(); dev.restore(); } break;
        case 'cm': if (A.length >= 6) gs.ctm = mmul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
        case 'w': gs.lw = n(0); break;
        case 'J': gs.cap = n(0); break;
        case 'j': gs.join = n(0); break;
        case 'M': gs.miter = n(0); break;
        case 'd': { const a0 = this.get(A[0]); gs.dash = Array.isArray(a0) ? a0.map((x) => +this.get(x) || 0) : []; gs.phase = n(1); break; }
        case 'gs': this.extGState(resGet('ExtGState', A[0]?.n), gs); break;
        case 'm': cx = sx = n(0); cy = sy = n(1); path.push('M', cx, cy); pt(cx, cy); break;
        case 'l': cx = n(0); cy = n(1); path.push('L', cx, cy); pt(cx, cy); break;
        case 'c': path.push('C', n(0), n(1), n(2), n(3), n(4), n(5)); pt(n(0), n(1)); pt(n(2), n(3)); cx = n(4); cy = n(5); pt(cx, cy); break;
        case 'v': path.push('C', cx, cy, n(0), n(1), n(2), n(3)); pt(n(0), n(1)); cx = n(2); cy = n(3); pt(cx, cy); break;
        case 'y': path.push('C', n(0), n(1), n(2), n(3), n(2), n(3)); pt(n(0), n(1)); cx = n(2); cy = n(3); pt(cx, cy); break;
        case 'h': path.push('Z'); cx = sx; cy = sy; break;
        case 're': { const x = n(0), y = n(1), w = n(2), h = n(3); path.push('M', x, y, 'L', x + w, y, 'L', x + w, y + h, 'L', x, y + h, 'Z'); pt(x, y); pt(x + w, y + h); pt(x + w, y); pt(x, y + h); cx = sx = x; cy = sy = y; break; }
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
          if (op === 's' || op === 'b' || op === 'b*') path.push('Z');
          if (!hidden && path.length) {
            const eo = op === 'f*' || op === 'B*' || op === 'b*';
            if (op !== 'S' && op !== 's') { const p = await paint(false); if (p) dev.fill(path, gs.ctm, eo, p); }
            if (op === 'S' || op === 's' || op[0] === 'B' || op[0] === 'b') { const p = await paint(true); if (p) dev.stroke(path, gs.ctm, style(), p); }
          }
          endPath(i, true);
          break;
        }
        case 'n': endPath(i, false); break;
        case 'W': clipPending = 1; break;
        case 'W*': clipPending = 2; break;
        case 'BT': tm = tlm = ID; inText = true; textClip = false; break;
        case 'ET': inText = false; if (textClip) { dev.endTextClip(); textClip = false; } break;
        case 'Tc': gs.tc = n(0); break;
        case 'Tw': gs.tw = n(0); break;
        case 'Tz': gs.th = n(0) / 100; break;
        case 'TL': gs.tl = n(0); break;
        case 'Ts': gs.ts = n(0); break;
        case 'Tr': gs.tr = n(0); break;
        case 'Tf': { const fr = resGet('Font', A[0]?.n); gs.font = fr !== undefined ? loadFont(doc, fr) : null; gs.fs = n(1); if (gs.font?.warn) this.warn.add(gs.font.warn); break; }
        case 'Td': tlm = mmul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
        case 'TD': gs.tl = -n(1); tlm = mmul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
        case 'Tm': if (A.length >= 6) tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; break;
        case 'T*': tlm = mmul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
        case 'Tj': case 'TJ': case "'": case '"': {
          if (op === "'" || op === '"') { tlm = mmul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; if (op === '"') { gs.tw = n(0); gs.tc = n(1); } }
          const arg = op === '"' ? A[2] : A[0];
          const items = op === 'TJ' ? (Array.isArray(arg) ? arg : []) : [arg];
          if (!gs.font) { const f = this.defaultFont(); gs.font = f; }
          if (gs.tr >= 4) textClip = true;
          tm = await this.showText(items, gs, tm, res, lvl, i, hidden);
          break;
        }
        case 'CS': gs.scs = getCS(doc, A[0], res); gs.sc = gs.scs.init; gs.spat = null; break;
        case 'cs': gs.fcs = getCS(doc, A[0], res); gs.fc = gs.fcs.init; gs.fpat = null; break;
        case 'SC': case 'SCN': case 'sc': case 'scn': {
          const s = op[0] === 'S';
          const cs = s ? gs.scs : gs.fcs;
          if (cs.pattern && A.length && A[A.length - 1] instanceof Name) {
            const pr = resGet('Pattern', A[A.length - 1].n);
            const pat = { ref: pr, comps: A.slice(0, -1).map((x) => +this.get(x)), under: cs.under };
            if (s) gs.spat = pat; else gs.fpat = pat;
          } else {
            const c = A.map((x) => +this.get(x) || 0);
            if (s) { gs.sc = c; gs.spat = null; } else { gs.fc = c; gs.fpat = null; }
          }
          break;
        }
        case 'G': gs.scs = DEV.DeviceGray; gs.sc = [n(0)]; gs.spat = null; break;
        case 'g': gs.fcs = DEV.DeviceGray; gs.fc = [n(0)]; gs.fpat = null; break;
        case 'RG': gs.scs = DEV.DeviceRGB; gs.sc = [n(0), n(1), n(2)]; gs.spat = null; break;
        case 'rg': gs.fcs = DEV.DeviceRGB; gs.fc = [n(0), n(1), n(2)]; gs.fpat = null; break;
        case 'K': gs.scs = DEV.DeviceCMYK; gs.sc = [n(0), n(1), n(2), n(3)]; gs.spat = null; break;
        case 'k': gs.fcs = DEV.DeviceCMYK; gs.fc = [n(0), n(1), n(2), n(3)]; gs.fpat = null; break;
        case 'sh': {
          if (hidden) break;
          const desc = shadingDesc(doc, resGet('Shading', A[0]?.n), res);
          if (desc) { dev.shade(desc, gs.ctm, gs.fa); if (lvl === 0 && o.onObj) o.onObj({ kind: 'shading', op: i, bbox: null, lvl }); }
          else this.warn.add('Unsupported shading');
          break;
        }
        case 'Do': {
          const ref = resGet('XObject', A[0]?.n);
          const xo = this.get(ref);
          if (!(xo instanceof Stream)) break;
          const st = this.get(xo.dict.get('Subtype'))?.n;
          if (hidden || this.hidden(xo.dict.get('OC'))) break;
          if (st === 'Image') {
            const bbox = bboxOf(gs.ctm, [0, 0, 1, 1]);
            if (lvl === 0 && o.onObj) o.onObj({ kind: 'image', op: i, bbox, ctm: gs.ctm.slice(), ref, name: A[0]?.n, lvl });
            if (o.onImage) o.onImage({ ref, ctm: gs.ctm.slice(), xo });
            if (!o.skipImages) await this.image(xo, gs, res);
          } else if (st === 'Form') {
            if (lvl > 12) break;
            if (lvl === 0 && o.onObj) o.onObj({ kind: 'form', op: i, bbox: formBBox(this, xo, gs.ctm), ref, lvl, ctm: gs.ctm.slice(), name: A[0]?.n });
            await this.form(xo, gs, null, lvl + 1, res);
          } else if (st === 'PS') this.warn.add('PostScript XObjects are ignored');
          break;
        }
        case 'BI': {
          if (hidden) break;
          const d = expandInline(A[0]);
          const s = new Stream(d, A[1]);
          if (lvl === 0 && o.onObj) o.onObj({ kind: 'inline', op: i, bbox: bboxOf(gs.ctm, [0, 0, 1, 1]), ctm: gs.ctm.slice(), lvl });
          if (!o.skipImages) await this.image(s, gs, res);
          break;
        }
        case 'BMC': hideStack.push(hidden); break;
        case 'BDC': {
          hideStack.push(hidden);
          if (A[0] instanceof Name && A[0].n === 'OC') {
            const p = A[1] instanceof Name ? resGet('Properties', A[1].n) : A[1];
            if (this.hidden(p)) hidden = true;
          }
          break;
        }
        case 'EMC': if (hideStack.length) hidden = hideStack.pop(); break;
        case 'd0': case 'd1': break;
        default: break;
      }
    }
    while (stack.length) { stack.pop(); dev.restore(); }
    void inText;
  }
  runOps(ops, res, ctm) { return this.run(ops, res, newGS(ctm), 0); }
  defaultFont() {
    if (!this._df) { const d = new Dict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N('Helvetica') }); this._df = loadFont(this.doc, d); }
    return this._df;
  }
  extGState(d, gs) {
    d = this.get(d);
    if (!(d instanceof Dict)) return;
    for (const [k, v0] of d) {
      const v = this.get(v0);
      switch (k) {
        case 'LW': gs.lw = +v; break;
        case 'LC': gs.cap = +v; break;
        case 'LJ': gs.join = +v; break;
        case 'ML': gs.miter = +v; break;
        case 'D': if (Array.isArray(v)) { const a = this.get(v[0]); gs.dash = Array.isArray(a) ? a.map((x) => +this.get(x)) : []; gs.phase = +this.get(v[1]) || 0; } break;
        case 'CA': gs.sa = +v; break;
        case 'ca': gs.fa = +v; break;
        case 'BM': { const b = Array.isArray(v) ? this.get(v[0]) : v; gs.bm = b instanceof Name && b.n !== 'Normal' && b.n !== 'Compatible' ? b.n : null; break; }
        case 'SMask': if (v instanceof Dict) { gs.smask = true; this.warn.add('Soft masks are approximated'); } else gs.smask = false; break;
        case 'Font': if (Array.isArray(v)) { gs.font = loadFont(this.doc, v[0]); gs.fs = +this.get(v[1]) || gs.fs; } break;
      }
    }
  }
  async patternPaint(pat, gs, res, alpha) {
    const p = this.get(pat.ref);
    const d = p instanceof Stream ? p.dict : p;
    if (!(d instanceof Dict)) return { c: 'rgba(0,0,0,0)', a: alpha };
    const pm = this.get(d.get('Matrix'));
    const M = mmul(Array.isArray(pm) && pm.length === 6 ? pm.map((x) => +this.get(x)) : ID, gs.base);
    if (this.get(d.get('PatternType')) === 2) {
      const desc = shadingDesc(this.doc, d.get('Shading'), res);
      if (!desc) return { c: 'rgba(0,0,0,0)', a: alpha };
      return { sh: desc, m: M, a: alpha };
    }
    if (!(p instanceof Stream)) return null;
    // Tiling pattern
    const bb = (this.get(d.get('BBox')) || [0, 0, 1, 1]).map((x) => +this.get(x));
    const xs = +this.get(d.get('XStep')) || bb[2] - bb[0], ys = +this.get(d.get('YStep')) || bb[3] - bb[1];
    const uncolored = this.get(d.get('PaintType')) === 2;
    const color = uncolored && pat.under ? rgbCss(pat.under.rgb(pat.comps)) : null;
    const pres = this.get(d.get('Resources'));
    p.ops = p.ops || parseContent(this.doc.decoded(p));
    return this.dev.tile({
      bbox: bb, xstep: xs, ystep: ys, matrix: M, alpha,
      draw: async (sub, m) => {
        const it = new Interp(this.doc, sub, { skipImages: false });
        it.ocOff = this.ocOff;
        const g = newGS(m);
        if (uncolored) g.forceColor = color || 'rgb(0,0,0)';
        await it.run(p.ops, pres instanceof Dict ? pres : res, g, 5);
      },
    });
  }
  async image(xo, gs, res) {
    let img;
    try {
      const fill = gs.fcs.rgb(gs.fc) || [0, 0, 0];
      xo.imgCache = xo.imgCache || new Map();
      const key = this.get(xo.dict.get('ImageMask')) ? fill.join(',') : 'x';
      img = xo.imgCache.get(key);
      if (!img) { img = decodeImage(this.doc, xo, res, fill); if (xo.dict.has('Length') || xo.imgCache.size < 4) xo.imgCache.set(key, img); }
    } catch (e) { img = { w: 1, h: 1, unsupported: e.message }; }
    if (img.unsupported) this.warn.add('Image not shown: ' + img.unsupported);
    await this.dev.image(img, gs.ctm, gs.fa);
  }
  async showText(items, gs, tm, res, lvl, opIdx, hidden) {
    const f = gs.font, dev = this.dev, o = this.o;
    const fs = gs.fs, th = gs.th, mode = gs.tr;
    const fp = mode === 3 || mode === 7 || hidden ? null : mode === 1 || mode === 5 ? null : gs.fpat ? await this.patternPaint(gs.fpat, gs, res, gs.fa) : { c: gs.forceColor || rgbCss(gs.fcs.rgb(gs.fc)), a: gs.fa, bm: gs.bm };
    const sp = (mode === 1 || mode === 2 || mode === 5 || mode === 6) && !hidden ? { c: rgbCss(gs.scs.rgb(gs.sc)), a: gs.sa, bm: gs.bm } : null;
    const dmode = (fp ? 1 : 0) | (sp ? 2 : 0);
    const clip = mode >= 4;
    const asc = f.desc ? (+this.get(f.desc.get('Ascent')) || 800) / 1000 : 0.8;
    const des = f.desc ? (+this.get(f.desc.get('Descent')) || -200) / 1000 : -0.2;
    const a2 = asc > 1.5 || asc < 0.3 ? 0.8 : asc, d2 = des < -0.6 || des > 0 ? -0.2 : des;
    const style = { lw: gs.lw, cap: gs.cap, join: gs.join, miter: gs.miter, dash: gs.dash, phase: gs.phase, ctm: gs.ctm };
    let gi = 0;
    for (const it of items) {
      const v = this.get(it);
      if (typeof v === 'number') {
        if (f.vertical) tm = mmul([1, 0, 0, 1, 0, (-v / 1000) * fs], tm);
        else tm = mmul([1, 0, 0, 1, (-v / 1000) * fs * th, 0], tm);
        continue;
      }
      if (!(v instanceof Str)) continue;
      const glyphs = f.decode(v.s);
      for (const g of glyphs) {
        const w = g.w / 1000;
        let trm;
        if (f.vertical) {
          const vx = w / 2, vy = (f.dw2 ? f.dw2[0] : 880) / 1000;
          trm = mmul([fs * th, 0, 0, fs, -vx * fs * th, -vy * fs + gs.ts], mmul(tm, gs.ctm));
        } else trm = mmul([fs * th, 0, 0, fs, 0, gs.ts], mmul(tm, gs.ctm));
        if (dmode || clip) {
          if (f.prog === 't3') {
            if (dmode) await this.type3(f, g, trm, gs, res);
          } else {
            const p = f.path(g);
            const m = mmul(f.fm, trm);
            if (p) { if (p.length) { if (dmode) dev.glyph(p, m, dmode, fp, sp, style); if (clip) dev.textClip(p, m); } }
            else if (g.uni && g.uni !== ' ' && dmode) dev.text(g.uni, f.css, trm, w, dmode, fp, sp);
          }
        }
        if (o.onChar) {
          const q = [apply(trm, 0, d2), apply(trm, w, d2), apply(trm, w, a2), apply(trm, 0, a2)];
          o.onChar({ u: g.uni, q, fs: Math.hypot(trm[2], trm[3]), op: opIdx, idx: gi, lvl, font: f, code: g.code, n: g.n, w: g.w, space: g.space, tc: gs.tc, tw: gs.tw, th, fsz: fs, tm });
        }
        gi++;
        if (f.vertical) {
          const vy = (f.widths2 && f.widths2.get(g.cid)) || (f.dw2 ? f.dw2[1] : -1000);
          tm = mmul([1, 0, 0, 1, 0, (vy / 1000) * fs + gs.tc + (g.space ? gs.tw : 0)], tm);
        } else tm = mmul([1, 0, 0, 1, (w * fs + gs.tc + (g.space ? gs.tw : 0)) * th, 0], tm);
      }
    }
    return tm;
  }
  async type3(f, g, trm, gs, res) {
    const proc = this.get(f.procs.get(g.key));
    if (!(proc instanceof Stream)) return;
    proc.ops = proc.ops || parseContent(this.doc.decoded(proc));
    const g2 = { ...gs, ctm: mmul(f.fm, trm), font: null };
    this.t3depth = (this.t3depth || 0) + 1;
    if (this.t3depth < 4) {
      this.dev.save();
      const r3 = this.get(f.res3);
      const saved = this.o.onChar; this.o.onChar = null;
      try { await this.run(proc.ops, r3 instanceof Dict ? r3 : res, g2, 6); } finally { this.o.onChar = saved; }
      this.dev.restore();
    }
    this.t3depth--;
  }
}

function formBBox(it, xo, ctm) {
  const bb = it.get(xo.dict.get('BBox'));
  const fm = it.get(xo.dict.get('Matrix'));
  const M = Array.isArray(fm) && fm.length === 6 ? fm.map((x) => +it.get(x)) : ID;
  return Array.isArray(bb) ? bboxOf(mmul(M, ctm), bb.map((x) => +it.get(x))) : null;
}

// Appearance stream for an annotation (normal appearance, honouring /AS)
export function appearance(doc, a, which = 'N') {
  const ap = doc.get(a.get('AP'));
  if (!(ap instanceof Dict)) return null;
  let n = doc.get(ap.get(which));
  if (n instanceof Dict && !(n instanceof Stream)) {
    const as = doc.get(a.get('AS'));
    n = as instanceof Name ? doc.get(n.get(as.n)) : null;
  }
  return n instanceof Stream ? n : null;
}
// Matrix mapping appearance form space to user space (PDF 12.5.5 algorithm), excluding the form's own Matrix.
export function apMatrix(doc, ap, R) {
  const bb = doc.get(ap.dict.get('BBox'));
  if (!Array.isArray(bb)) return null;
  const fm = doc.get(ap.dict.get('Matrix'));
  const M = Array.isArray(fm) && fm.length === 6 ? fm.map((x) => +doc.get(x)) : ID;
  const t = bboxOf(M, bb.map((x) => +doc.get(x)));
  const w = t[2] - t[0], h = t[3] - t[1];
  const rx = Math.min(R[0], R[2]), ry = Math.min(R[1], R[3]), rw = Math.abs(R[2] - R[0]), rh = Math.abs(R[3] - R[1]);
  const sx = w ? rw / w : 1, sy = h ? rh / h : 1;
  return [sx, 0, 0, sy, rx - t[0] * sx, ry - t[1] * sy];
}
export { inv, PATTERN };

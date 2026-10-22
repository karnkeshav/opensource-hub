// Canvas 2D device for the interpreter (browser only).
import { mmul, inv, apply } from './obj.js';

const P2D = new WeakMap();
function toPath(p) {
  let r = P2D.get(p);
  if (r) return r;
  r = new Path2D();
  for (let i = 0; i < p.length;) {
    const op = p[i++];
    if (op === 'M') r.moveTo(p[i++], p[i++]);
    else if (op === 'L') r.lineTo(p[i++], p[i++]);
    else if (op === 'C') r.bezierCurveTo(p[i++], p[i++], p[i++], p[i++], p[i++], p[i++]);
    else if (op === 'Q') r.quadraticCurveTo(p[i++], p[i++], p[i++], p[i++]);
    else if (op === 'Z') r.closePath();
  }
  P2D.set(p, r);
  return r;
}
const BM = { Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference', Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity' };
const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'];
const det = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1e-9;
const mkCanvas = (w, h) => { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export class CanvasDevice {
  constructor(ctx, base) { this.ctx = ctx; this.base = base; this.tc = null; this.measure = new Map(); }
  setT(m) { const t = mmul(m, this.base); this.ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]); return t; }
  save() { this.ctx.save(); }
  restore() { this.ctx.restore(); }
  apply(paint, ctm, stroke) {
    const c = this.ctx;
    c.globalAlpha = paint.a ?? 1;
    c.globalCompositeOperation = (paint.bm && BM[paint.bm]) || 'source-over';
    let st = paint.c;
    if (paint.tile) {
      const t = paint.tile;
      try { t.pat.setTransform(new DOMMatrix(mmul(mmul(t.S, t.matrix), inv(ctm)))); } catch {}
      st = t.pat;
    }
    if (stroke) c.strokeStyle = st || '#000'; else c.fillStyle = st || '#000';
  }
  fill(path, ctm, eo, paint) {
    const c = this.ctx, p = toPath(path);
    if (paint.sh) {
      c.save(); this.setT(ctm); c.clip(p, eo ? 'evenodd' : 'nonzero');
      this.shade(paint.sh, paint.m, paint.a); c.restore(); return;
    }
    this.setT(ctm); this.apply(paint, ctm, false);
    c.fill(p, eo ? 'evenodd' : 'nonzero');
  }
  stroke(path, ctm, s, paint) {
    const c = this.ctx, t = this.setT(ctm);
    if (paint.sh) paint = { c: paint.sh.stops ? paint.sh.stops[paint.sh.stops.length >> 1][1] : '#000', a: paint.a };
    this.apply(paint, ctm, true);
    const sc = det(t);
    c.lineWidth = Math.max(s.lw, 1 / sc);
    c.lineCap = CAPS[s.cap] || 'butt'; c.lineJoin = JOINS[s.join] || 'miter'; c.miterLimit = Math.max(1, s.miter || 10);
    const dash = s.dash && s.dash.length && s.dash.some((x) => x > 0) ? s.dash : [];
    c.setLineDash(dash); c.lineDashOffset = s.phase || 0;
    c.stroke(toPath(path));
  }
  clip(path, ctm, eo) { this.setT(ctm); this.ctx.clip(toPath(path), eo ? 'evenodd' : 'nonzero'); }
  glyph(path, m, mode, fill, stroke, style) {
    const c = this.ctx, t = this.setT(m), p = toPath(path);
    if (mode & 1 && fill) {
      if (fill.sh) { c.save(); c.clip(p); this.shade(fill.sh, fill.m, fill.a, m); c.restore(); }
      else { this.apply(fill, m, false); c.fill(p); }
    }
    if (mode & 2 && stroke) {
      this.apply(stroke, m, true);
      const k = style && style.ctm ? det(style.ctm) / det(m) : 0.02;
      c.lineWidth = Math.max((style?.lw || 1) * k, 1 / det(t));
      c.setLineDash([]); c.lineJoin = 'round';
      c.stroke(p);
    }
  }
  text(str, css, m, w, mode, fill, stroke) {
    const c = this.ctx;
    c.font = css;
    const key = css + '|' + str;
    let mw = this.measure.get(key);
    if (mw === undefined) { this.setT([1, 0, 0, 1, 0, 0]); mw = c.measureText(str).width / 100; this.measure.set(key, mw); }
    let sx = w > 0 && mw > 0 ? w / mw : 1;
    if (sx < 0.3 || sx > 3) sx = 1;
    this.setT(mmul([0.01 * sx, 0, 0, -0.01, 0, 0], m));
    if (mode & 1 && fill && !fill.sh) { this.apply(fill, m, false); c.fillText(str, 0, 0); }
    else if (mode & 1 && fill) { c.fillStyle = '#000'; c.fillText(str, 0, 0); }
    if (mode & 2 && stroke) { this.apply(stroke, m, true); c.lineWidth = 2; c.strokeText(str, 0, 0); }
  }
  textClip(path, m) {
    if (!this.tc) this.tc = new Path2D();
    this.tc.addPath(toPath(path), new DOMMatrix(mmul(m, this.base)));
  }
  endTextClip() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clip(this.tc || new Path2D());
    this.tc = null;
  }
  async bitmap(img) {
    if (img.bmp) return img.bmp;
    if (img.unsupported) return null;
    let src;
    if (img.jpeg) {
      try { src = await createImageBitmap(new Blob([img.jpeg], { type: 'image/jpeg' })); }
      catch { img.unsupported = 'JPEG decode failed'; return null; }
      if (img.alpha && src.width === img.w && src.height === img.h) {
        const cv = mkCanvas(img.w, img.h), x = cv.getContext('2d');
        x.drawImage(src, 0, 0);
        const id = x.getImageData(0, 0, img.w, img.h);
        for (let i = 0; i < img.w * img.h; i++) id.data[i * 4 + 3] = img.alpha[i];
        x.putImageData(id, 0, 0); src = cv;
      }
    } else {
      src = mkCanvas(img.w, img.h);
      src.getContext('2d').putImageData(new ImageData(img.rgba, img.w, img.h), 0, 0);
      img.rgba = null; // free the pixel buffer; the canvas holds it now
    }
    img.bmp = src;
    return src;
  }
  async image(img, ctm, alpha) {
    const c = this.ctx;
    const b = await this.bitmap(img);
    c.save();
    c.globalAlpha = alpha ?? 1;
    c.globalCompositeOperation = 'source-over';
    if (!b) {
      this.setT(ctm);
      c.fillStyle = 'rgba(128,128,128,.15)'; c.fillRect(0, 0, 1, 1);
      c.restore(); return;
    }
    const w = b.width, h = b.height;
    const t = this.setT(mmul([1 / w, 0, 0, -1 / h, 0, 1], ctm));
    // Pixelated upscaling of 1-bit/bilevel masks looks jagged; smooth unless the image is drawn very large and Interpolate is false
    c.imageSmoothingEnabled = img.interpolate || det(t) < 4 || !!img.mask;
    c.imageSmoothingQuality = 'high';
    c.drawImage(b, 0, 0);
    c.restore();
  }
  shade(d, ctm, alpha, glyphM) {
    const c = this.ctx;
    c.save();
    const t = this.setT(ctm);
    c.globalAlpha = alpha ?? 1;
    // area to cover: canvas bounds in shading space
    const it = inv(t), W = c.canvas.width, H = c.canvas.height;
    const pts = [apply(it, 0, 0), apply(it, W, 0), apply(it, 0, H), apply(it, W, H)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const area = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    void glyphM;
    if (d.kind === 'axial' || d.kind === 'radial') {
      const k = d.coords;
      const g = d.kind === 'axial' ? c.createLinearGradient(k[0], k[1], k[2], k[3]) : c.createRadialGradient(k[0], k[1], Math.max(0, k[2]), k[3], k[4], Math.max(0, k[5]));
      for (const [s, col] of d.stops) g.addColorStop(s, col);
      c.fillStyle = g;
      if (d.kind === 'axial' && (!d.extend[0] || !d.extend[1])) {
        // limit to the band between the end points
        const dx = k[2] - k[0], dy = k[3] - k[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, big = 1e5;
        const e0 = d.extend[0] ? -big : 0, e1 = d.extend[1] ? big : 1;
        const P = (t, s) => [k[0] + dx * t + nx * s, k[1] + dy * t + ny * s];
        const q = [P(e0, -big), P(e1, -big), P(e1, big), P(e0, big)];
        c.beginPath(); c.moveTo(...q[0]); c.lineTo(...q[1]); c.lineTo(...q[2]); c.lineTo(...q[3]); c.closePath(); c.fill();
      } else c.fillRect(area[0], area[1], area[2] - area[0], area[3] - area[1]);
    } else if (d.kind === 'mesh') {
      for (const tr of d.tris) {
        c.fillStyle = tr[6]; c.strokeStyle = tr[6]; c.lineWidth = 0.5 / det(t);
        c.beginPath(); c.moveTo(tr[0], tr[1]); c.lineTo(tr[2], tr[3]); c.lineTo(tr[4], tr[5]); c.closePath(); c.fill(); c.stroke();
      }
    } else if (d.kind === 'image') {
      const cv = mkCanvas(d.image.w, d.image.h); cv.getContext('2d').putImageData(new ImageData(d.image.rgba, d.image.w, d.image.h), 0, 0);
      this.setT(mmul([1 / d.image.w, 0, 0, -1 / d.image.h, 0, 1], mmul(d.matrix, ctm)));
      c.drawImage(cv, 0, 0);
    }
    c.restore();
  }
  async tile(info) {
    const full = mmul(info.matrix, this.base);
    const sc = Math.min(8, Math.max(0.05, det(full)));
    const xs = Math.abs(info.xstep), ys = Math.abs(info.ystep);
    let cw = Math.ceil(xs * sc), ch = Math.ceil(ys * sc);
    let s = sc;
    if (cw * ch > 4e6 || cw > 4096 || ch > 4096) { const f = Math.sqrt(4e6 / (cw * ch)); s *= Math.min(f, 4096 / cw, 4096 / ch); cw = Math.ceil(xs * s); ch = Math.ceil(ys * s); }
    cw = Math.max(1, cw); ch = Math.max(1, ch);
    const cv = mkCanvas(cw, ch), x = cv.getContext('2d');
    const bb = info.bbox;
    const sub = new CanvasDevice(x, [s, 0, 0, -s, -bb[0] * s, (bb[1] + ys) * s]);
    try { await info.draw(sub, [1, 0, 0, 1, 0, 0]); } catch {}
    const pat = this.ctx.createPattern(cv, 'repeat');
    // pixel -> pattern space
    const S = [xs / cw, 0, 0, -ys / ch, bb[0], bb[1] + ys];
    return { tile: { pat, S, matrix: info.matrix }, a: info.alpha };
  }
}

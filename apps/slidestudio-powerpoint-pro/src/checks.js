// Built-in checks with one-click fixes: missing titles, text contrast (WCAG), tiny text, overflow,
// objects off the slide, pictures without alt text and reading order.
import { layoutSlide, runZ, textH } from './layout.js';
import { contrast, ensure, mix } from './color.js';
import { plain, P, newSlide, binding, clone } from './model.js';

export const CHECKS = { title: 'Missing title', contrast: 'Contrast', tiny: 'Tiny text', overflow: 'Overflow', offslide: 'Off slide', alt: 'Alt text', order: 'Reading order' };
const readable = (b) => !b.d && (b.t === 'pic' || b.t === 'table' || (b.paras && b.paras.some((p) => plain(p).trim())));

export function checkSlide(deck, s, i, measure) {
  const L = layoutSlide(s, deck, i, measure), out = [], W = deck.w, H = deck.h;
  const add = (type, k, msg, fix, x) => out.push({ i, id: s.id, type, k, msg, fix, ...x });
  if (!s.title) add('title', null, 'Slide has no title (screen readers, the outline and navigation use titles)', 'title');
  // the colour behind a box: its own fill, else the topmost filled shape under its centre, else the slide
  const under = (j) => {
    const b = L.boxes[j], cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let bg = typeof L.bg === 'string' && !L.bgm ? L.bg.slice(0, 7) : null;
    const layers = [...L.boxes.slice(0, j).filter((u) => (u.fill || u.t === 'pic') && cx > u.x && cx < u.x + u.w && cy > u.y && cy < u.y + u.h), b];
    for (const u of layers) {
      if (u.t === 'pic') bg = null;
      else if (u.fill) { const a = u.fill.length === 9 ? parseInt(u.fill.slice(7), 16) / 255 : 1; bg = a > 0.97 ? u.fill.slice(0, 7) : bg && mix(bg, u.fill.slice(0, 7), a); }
    }
    return bg;
  };
  L.boxes.forEach((b, j) => {
    if (b.d) return;
    if (b.paras && b.paras.some((p) => plain(p).trim())) {
      const bg = under(j);
      let worst = 99, need = 4.5, minZ = 999;
      for (const p of b.paras) for (const r of p.r) {
        if (!r.t.trim()) continue;
        const z = runZ(r, p, b) * (b.fs || 1), nd = z >= 18 || (z >= 14 && (r.b || b.b)) ? 3 : 4.5;
        minZ = Math.min(minZ, z);
        if (bg) { const cr = contrast((r.c || b.col || '#000000').slice(0, 7), bg); if (cr < nd && cr / nd < worst / need) { worst = cr; need = nd; } }
      }
      if (worst < need) add('contrast', b.k, `Low contrast text (${worst.toFixed(1)}:1, needs ${need}:1)`, 'contrast', { bg, need });
      const over = b.fit ? b.over : textH(b, b.fs || 1, measure) > b.h * 1.15 + 6;
      if (over) add('overflow', b.k, 'Text does not fit its box', b.k === 'body' ? 'split' : b.fit ? null : 'grow');
      else if ((b.fit && b.fs < 1 && minZ < 12) || minZ < 9) add('tiny', b.k, `Text is ${Math.round(minZ)} pt${b.fs < 1 ? ' after shrinking to fit' : ''}`, b.k === 'body' && s.body.length > 1 ? 'split' : null);
      if (b.x < -2 || b.y < -2 || b.x + b.w > W + 2 || b.y + b.h > H + 2) add('offslide', b.k, 'Text box is partly off the slide', 'inside');
    }
    if (b.t === 'table' && b.over) add('overflow', b.k, 'Table is too big for the slide even at the smallest text size', null);
    if (b.t === 'pic' && !(b.alt || '').trim()) add('alt', b.k, 'Picture has no alt text', 'alt');
  });
  const ti = L.boxes.findIndex((b) => b.k === 'title'), first = L.boxes.findIndex(readable);
  if (ti > 0 && first >= 0 && first < ti) add('order', 'title', 'Title is not the first thing a screen reader reads', 'order');
  return out;
}
export const checkDeck = (deck, measure) => deck.slides.flatMap((s, i) => checkSlide(deck, s, i, measure));

// Apply a fix in place. Returns a short description or null when the fix needs the user (alt text).
export function applyFix(deck, iss, measure) {
  const i = deck.slides.findIndex((x) => x.id === iss.id), s = deck.slides[i];
  if (!s) return null;
  const el = s.els.find((e) => e.id === iss.k), box = () => layoutSlide(s, deck, i, measure).boxes.find((b) => b.k === iss.k);
  const geo = (o) => { if (el) Object.assign(el, o); else s.ov[iss.k] = { ...s.ov[iss.k], ...o }; };
  switch (iss.fix) {
    case 'title': {
      const L = layoutSlide(s, deck, i, measure), top = L.boxes.filter((b) => b.paras && b.paras.filter((p) => plain(p).trim()).length === 1 && s.els.some((e) => e.id === b.k)).sort((a, b) => a.y - b.y)[0];
      if (top && top.y < deck.h / 3) { // promote the topmost one-line text box: same look, now a real title
        const ix = s.els.findIndex((e) => e.id === top.k), e = s.els[ix];
        s.title = { ...e.paras.find((p) => plain(p).trim()), bu: 0, lvl: 0 };
        s.ov.title = { x: e.x, y: e.y, w: e.w, h: e.h, an: e.an || 't', ins: e.ins, fit: 1 };
        if (e.fill || e.ln || e.g !== 'rect') Object.assign(s.ov.title, { t: e.t, g: e.g, fill: e.fill, ln: e.ln });
        s.els.splice(ix, 1, { slot: 'title' });
      } else s.title = P('Slide ' + (i + 1));
      return 'Added a title';
    }
    case 'contrast': {
      const b = box();
      if (!b) return null;
      const bnd = binding(s, iss.k), paras = bnd ? bnd.get() : null;
      if (paras) for (const p of paras) for (const r of p.r) if (r.c) r.c = ensure(r.c.slice(0, 7), iss.bg, iss.need);
      const col = ensure((b.col || '#000000').slice(0, 7), iss.bg, iss.need);
      if (el) el.col = col; else s.ov[iss.k] = { ...s.ov[iss.k], col };
      return 'Raised text contrast';
    }
    case 'split': {
      const n = s.body.length, k = Math.max(1, Math.ceil(n / 2)), rest = s.body.splice(k);
      const t = s.title ? clone(s.title) : P('');
      if (t.r.length) t.r[t.r.length - 1].t += ' (cont.)';
      deck.slides.splice(i + 1, 0, newSlide({ title: t, body: rest, layout: s.layout === 'free' ? null : s.layout }));
      return 'Split into two slides';
    }
    case 'grow': {
      const b = box();
      if (!b) return null;
      geo({ h: Math.min(deck.h - b.y, textH(b, b.fs || 1, measure) + 4) });
      return 'Enlarged the box';
    }
    case 'inside': {
      const b = box();
      if (!b) return null;
      const w = Math.min(b.w, deck.w), h = Math.min(b.h, deck.h);
      geo({ x: Math.max(0, Math.min(b.x, deck.w - w)), y: Math.max(0, Math.min(b.y, deck.h - h)), w, h });
      return 'Moved onto the slide';
    }
    case 'order': {
      s.els = s.els.filter((e) => e.slot !== 'title');
      const fr = layoutSlide(s, deck, i, measure).boxes.find(readable), at = fr ? s.els.findIndex((e) => (e.id || e.slot) === fr.k) : -1;
      if (at >= 0) s.els.splice(at, 0, { slot: 'title' });
      return 'Moved the title first in reading order';
    }
  }
  return null;
}

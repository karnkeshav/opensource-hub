// Smart auto-layout: picks a layout from the slide's content, places boxes in regions, applies the
// user's overrides (moved boxes, colours) and auto-fits text by shrinking it until it fits its box.
// Units are points: a 16:9 slide is 960 x 540 (12192000 x 6858000 EMU).
import { derive } from './theme.js';
import { plain, P } from './model.js';
import { diagram } from './diagram.js';

export const LH = 1.2, SB = 0.3, IND = 27, HANG = 22, PADX = 7.2, PADY = 3.6;
export const BODY = [28, 24, 20, 18, 16];
export const LAYOUTS = { auto: 'Automatic', title: 'Title', section: 'Section header', bullets: 'Title and content', columns: 'Columns', imageText: 'Text + image', imageLeft: 'Image + text', image: 'Image', table: 'Table', diagram: 'Diagram', quote: 'Quote', bignum: 'Big number', free: 'Free (keep positions)' };

// Width estimate used in Node / tests; the browser passes a canvas-based measure with the same signature.
export function approx(t, z, f, b) {
  let w = 0;
  for (const ch of t) w += ch === ' ' || /[iljtf.,;:'|!()]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.86 : /[A-Z0-9#$&]/.test(ch) ? 0.64 : 0.52;
  return w * z * (b ? 1.06 : 1);
}
const baseZ = (p, bx) => { const b = bx.base || [18]; return b[Math.min(p.lvl || 0, b.length - 1)]; };
export const runZ = (r, p, bx) => r.z || baseZ(p, bx);
export const paraZ = (p, bx) => (p.r.length ? Math.max(...p.r.map((r) => runZ(r, p, bx))) : baseZ(p, bx));
export const marL = (p) => (p.lvl || 0) * IND + (p.bu ? HANG : 0);
export const ins = (bx) => bx.ins || [PADX, PADY, PADX, PADY];

export function lineCount(text, w, z, f, b, measure) {
  let n = 0;
  const sp = measure(' ', z, f, b);
  for (const seg of text.split('\n')) {
    let cur = 0;
    n++;
    for (const wd of seg.split(' ')) {
      const ww = measure(wd, z, f, b);
      if (cur && cur + sp + ww > w) { n++; cur = ww; } else cur += (cur ? sp : 0) + ww;
      if (ww > w) { n += Math.ceil(ww / w) - 1; cur = ww % w; }
    }
  }
  return n;
}
export function textH(bx, sc, measure) {
  const [l, t, r, b] = ins(bx), w = bx.w - l - r;
  let h = 0;
  (bx.paras || []).forEach((p, i) => {
    const z = paraZ(p, bx) * sc, f = (p.r[0] && p.r[0].f) || bx.font, bold = bx.b || (p.r.length > 0 && p.r.every((x) => x.b));
    h += lineCount(plain(p) || ' ', Math.max(8, w - marL(p)), z, f, bold, measure) * z * LH + (i ? z * SB : 0);
  });
  return h + t + b;
}
// Largest scale (in 2.5% steps, down to 30%) at which the text fits the box height.
export function fit(bx, measure) {
  if (textH(bx, 1, measure) <= bx.h + 0.5) return { fs: 1, over: false };
  let lo = 0.3, hi = 1;
  for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (textH(bx, m, measure) <= bx.h + 0.5) lo = m; else hi = m; }
  const fs = Math.max(0.3, Math.floor(lo * 40) / 40);
  return { fs, over: textH(bx, fs, measure) > bx.h + 0.5 };
}
export function fitTable(b, measure) {
  const nc = Math.max(1, ...b.rows.map((x) => x.length));
  if (!b.cw || b.cw.length !== nc) {
    const wts = Array.from({ length: nc }, (_, c) => Math.max(4, ...b.rows.map((row) => Math.min(36, plain(row[c]).length))));
    const tw = wts.reduce((a, x) => a + x, 0);
    b.cw = wts.map((x) => (b.w * x) / tw);
  } else { const tw = b.cw.reduce((a, x) => a + x, 0); b.cw = b.cw.map((x) => (x * b.w) / tw); }
  const rowsH = (z) => b.rows.map((row, r) => Math.max(...b.cw.map((w, c) => lineCount(plain(row[c]) || ' ', w - 2 * PADX, z, b.font, !r, measure))) * z * LH + 2 * PADY + 2);
  let z = 24, rh = rowsH(z);
  const avail = b.h, sum = () => rh.reduce((a, x) => a + x, 0);
  while (z > 9 && sum() > avail) rh = rowsH(--z);
  const spare = Math.min(avail - sum(), sum()); // let short tables breathe: grow rows into up to 2x their height
  if (spare > 0) rh = rh.map((x) => x + spare / rh.length);
  b.z = z; b.rh = rh; b.h = sum(); b.over = b.h > avail + 1;
}

export function isBigNum(s) {
  return s.body.length > 0 && s.body.length <= 3 && !s.body[0].bu && /^[-+]?[$€£¥₹]?\d[\d,.]*\s*(%|x|×|[kmb]n?|[KMB]|\+)?$/i.test(plain(s.body[0]).trim());
}
export function autoLayout(s, i) {
  if (s.dg) return 'diagram';
  if (s.table) return 'table';
  if (s.quote && !s.body.length) return 'quote';
  if (s.img.length) return s.body.length || s.cols.length ? 'imageText' : 'image';
  if (s.cols.length > 1) return 'columns';
  if (isBigNum(s)) return 'bignum';
  if (!s.body.length && !s.cols.length && !s.quote) return i === 0 || s.sub.length ? 'title' : 'section';
  return 'bullets';
}

const T = [0.06, 0.05, 0.88, 0.16], M = [0.06, 0.24, 0.88, 0.7];
const SPEC = {
  title: { t: [0.08, 0.18, 0.84, 0.32], tz: 54, an: 'b', al: 'ctr', sub: [0.1, 0.55, 0.8, 0.14], m: [0.12, 0.72, 0.76, 0.2] },
  section: { t: [0.1, 0.28, 0.8, 0.28], tz: 48, an: 'b', sub: [0.1, 0.58, 0.8, 0.12], m: [0.1, 0.72, 0.8, 0.2], bg: 'surface' },
  imageText: { m: [0.06, 0.24, 0.44, 0.7], v: [0.53, 0.24, 0.41, 0.7] },
  imageLeft: { m: [0.5, 0.24, 0.44, 0.7], v: [0.06, 0.24, 0.41, 0.7] },
  quote: { m: [0.1, 0.22, 0.8, 0.7] },
};
const G = 14;

export function layoutSlide(s, deck, idx = 0, measure = approx) {
  const th = derive(deck.theme), W = deck.w, H = deck.h, ov = s.ov || {};
  const lay = !s.layout || s.layout === 'auto' ? autoLayout(s, idx) : s.layout;
  const sp = { t: T, m: M, ...SPEC[lay] };
  const R = (a) => ({ x: a[0] * W, y: a[1] * H, w: a[2] * W, h: a[3] * H });
  const out = [], add = (b) => (out.push(b), b);
  const tb = (k, paras, r, base, o) => add({ k, t: 'text', ...r, paras, base, font: th.body, col: th.text, an: 't', bc: th.acc[0], fit: 1, ...o });
  const bg = typeof s.bg === 'string' ? s.bg : sp.bg ? th[sp.bg] : th.bg;
  if (lay === 'title') add({ k: 'deco', d: 1, t: 'shape', g: 'rect', ...R([0.45, 0.515, 0.1, 0.009]), fill: th.acc[0] });
  if (lay === 'section') add({ k: 'deco', d: 1, t: 'shape', g: 'rect', x: 0, y: 0, w: 0.022 * W, h: H, fill: th.acc[0] });
  if (s.title) tb('title', [s.title], R(sp.t), [sp.tz || 40], { font: th.head, col: th.title, an: sp.an || 'b', al: sp.al, ph: 'title' });
  let m = R(sp.m);
  if (!s.title && !SPEC[lay]) m = { x: m.x, y: 0.06 * H, w: m.w, h: m.y + m.h - 0.06 * H };
  if (s.sub.length && SPEC[lay] && SPEC[lay].sub) tb('sub', s.sub, R(sp.sub), [24], { col: th.muted, al: sp.al, an: 't', ph: 'sub' });
  const texts = [], vis = [];
  const textItem = (k, paras, base, o = {}) => ({ nat: (w) => textH({ paras, base, w, font: th.body, ...o }, 1, measure), place: (r) => tb(k, paras, r, base, o) });
  if (s.sub.length && !(SPEC[lay] && SPEC[lay].sub)) texts.push(textItem('sub', s.sub, [24], { col: th.muted }));
  if (s.body.length) {
    if (lay === 'bignum') {
      const cap = s.body.slice(1);
      texts.push({
        nat: (w) => 120 * LH + 8 + (cap.length ? textH({ paras: cap, base: [24], w, font: th.body }, 1, measure) : 0),
        place: (r) => { const nh = cap.length ? r.h * 0.62 : r.h; tb('num', s.body.slice(0, 1), { ...r, h: nh }, [120], { b: 1, col: th.acc[0], al: 'ctr', an: cap.length ? 'b' : 'ctr', font: th.head }); if (cap.length) tb('cap', cap, { ...r, y: r.y + nh, h: r.h - nh }, [24], { al: 'ctr', col: th.muted }); },
      });
    } else texts.push(textItem('body', s.body, BODY, { al: sp.al, ph: 'body' }));
  }
  if (s.cols.length) {
    const n = s.cols.length, hh = 24 * LH + 2 * PADY + 6;
    texts.push({
      nat: (w) => hh + Math.max(...s.cols.map((c) => textH({ paras: c.body, base: BODY, w: (w - 24 * (n - 1)) / n, font: th.body }, 1, measure))),
      place: (r) => s.cols.forEach((c, i) => {
        const cw = (r.w - 24 * (n - 1)) / n, x = r.x + i * (cw + 24);
        tb('ch' + i, [c.h], { x, y: r.y, w: cw, h: hh }, [24], { col: th.acc[0], b: 1, an: 'b', font: th.head, grp: 'ch' });
        tb('cb' + i, c.body, { x, y: r.y + hh, w: cw, h: r.h - hh }, BODY, { grp: 'cb' });
      }),
    });
  }
  if (s.quote) {
    const q = s.quote;
    texts.push({
      nat: (w) => textH({ paras: q.q, base: [40], w: w - 120, font: th.head }, 1, measure) + (q.by ? 44 : 0),
      place: (r) => {
        add({ k: 'qm', d: 1, t: 'text', x: r.x, y: r.y, w: 90, h: 100, paras: [P('“')], base: [110], font: 'Georgia', col: th.acc[0], an: 't', fit: 0 });
        const qh = q.by ? r.h - 44 : r.h;
        tb('q', q.q, { ...r, x: r.x + 60, w: r.w - 120, h: qh }, [40], { i: 1, font: th.head, col: th.title, an: 'ctr', al: 'ctr' });
        if (q.by) tb('by', [P('— ' + q.by)], { ...r, y: r.y + qh, h: 44 }, [20], { col: th.muted, al: 'r', an: 'ctr' });
      },
    });
  }
  if (s.img.length) {
    vis.push({
      place: (r) => {
        const n = s.img.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), cw = (r.w - G * (cols - 1)) / cols, ch = (r.h - G * (rows - 1)) / rows;
        s.img.forEach((im, i) => {
          const md = /^media:/.test(im.src) ? deck.media[im.src.slice(6)] : null, ar = md && md.w && md.h ? md.w / md.h : cw / ch;
          const w = Math.min(cw, ch * ar), h = w / ar, x = r.x + (i % cols) * (cw + G) + (cw - w) / 2, y = r.y + Math.floor(i / cols) * (ch + G) + (ch - h) / 2;
          add({ k: 'img' + i, t: 'pic', x, y, w, h, m: im.src, alt: im.alt });
        });
      },
    });
  }
  if (s.table && s.table.length) vis.push({ place: (r) => add({ k: 'tbl', t: 'table', ...r, rows: s.table, font: th.body, col: th.text, hf: th.fills[0], hc: th.onFill[0], band: th.surface, lc: th.line }) });
  if (s.dg) vis.push({ place: (r) => out.push(...diagram(s.dg, r, th, ov)) });
  if (sp.v && vis.length) vis.shift().place(R(sp.v));
  else if (sp.v) m = { x: M[0] * W, y: m.y, w: M[2] * W, h: m.h };
  // stack text items and visuals in the main region
  const all = texts.length + vis.length;
  if (all === 1) (texts[0] || vis[0]).place(m);
  else if (all > 1) {
    const avail = m.h - G * (all - 1);
    let th2 = texts.map((it) => Math.min(it.nat(m.w), avail));
    const sum = th2.reduce((a, x) => a + x, 0), cap = vis.length ? avail * 0.42 : avail;
    if (sum > cap) th2 = th2.map((x) => (x * cap) / sum);
    const used = th2.reduce((a, x) => a + x, 0);
    if (!vis.length && th2.length) th2[th2.length - 1] += avail - used;
    const vh = vis.length ? (avail - used) / vis.length : 0;
    let y = m.y;
    texts.forEach((it, i) => { it.place({ x: m.x, y, w: m.w, h: th2[i] }); y += th2[i] + G; });
    vis.forEach((it) => { it.place({ x: m.x, y, w: m.w, h: vh }); y += vh + G; });
  }
  // overrides (moved / restyled boxes), then fit text and tables
  const content = out.filter((b) => { if (!/^dg:/.test(b.k) && ov[b.k]) Object.assign(b, ov[b.k]); return !b.hide; });
  const byK = new Map(content.map((b) => [b.k, b])), used = new Set(), els = [];
  for (const e of s.els || []) {
    if (e.slot) { const b = byK.get(e.slot); if (b) { els.push(b); used.add(e.slot); } } else els.push({ ...e, k: e.id });
  }
  const boxes = [...content.filter((b) => !used.has(b.k)), ...els];
  const grp = {};
  for (const b of boxes) {
    if (b.t === 'table') { if (!b.fixed) fitTable(b, measure); }
    else if (b.paras && b.fit) { const f = fit(b, measure); b.fs = f.fs; b.over = f.over; if (b.grp) grp[b.grp] = Math.min(grp[b.grp] || 1, f.fs); }
    else if (b.paras) { b.fs = b.fs || 1; b.over = textH(b, b.fs, measure) > b.h + 2 && !b.ph; }
  }
  for (const b of boxes) if (b.grp && grp[b.grp] < b.fs) b.fs = grp[b.grp];
  return { lay, bg, bgm: s.bg && s.bg.m, boxes, th };
}

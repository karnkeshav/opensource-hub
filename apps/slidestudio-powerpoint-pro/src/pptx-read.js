// PresentationML reader. Resolves placeholder inheritance (slide -> layout -> master), theme colours with
// modifiers, text styles, backgrounds and master decorations. Anything it cannot represent is counted in
// `warnings` so the user is told exactly what was dropped or simplified.
import { unzip, text } from './zip.js';
import { parseXML, kid, kids, find, findAll } from './xml.js';
import { toHsl, hsl, hex, mix, lum } from './color.js';
import { addMedia, sniff } from './media.js';
import { newSlide, uid, mergeRuns, one } from './model.js';

const EMU = 12700;
const PRST = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500' };
const CLR = /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/;
const MAP0 = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
const TR = { fade: 'fade', dissolve: 'fade', cut: 'fade', push: 'push', cover: 'push', pull: 'push', wipe: 'push', split: 'push', randomBar: 'push', zoom: 'zoom', newsflash: 'zoom' };
const norm = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' || !t ? 'body' : t);
function resolve(base, t) {
  if (t[0] === '/') return t.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const s of t.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/');
}
function colorOf(c, ctx) {
  let h;
  const a = c.a;
  if (c.n === 'srgbClr') h = '#' + a.val;
  else if (c.n === 'sysClr') h = '#' + (a.lastClr || (a.val === 'window' ? 'ffffff' : '000000'));
  else if (c.n === 'schemeClr') h = a.val === 'phClr' ? ctx.ph || '#000000' : ctx.tc[ctx.map[a.val] || MAP0[a.val] || a.val] || '#000000';
  else if (c.n === 'prstClr') h = PRST[a.val] || '#000000';
  else if (c.n === 'scrgbClr') h = hex(...['r', 'g', 'b'].map((k) => 255 * Math.min(1, (+a[k] / 100000) ** (1 / 2.2))));
  else h = hsl(+a.hue / 60000, +a.sat / 100000, +a.lum / 100000);
  h = h.toLowerCase().slice(0, 7);
  let alpha = 1;
  for (const m of c.c) {
    const v = +m.a.val / 100000, [H, S, L] = toHsl(h);
    if (m.n === 'lumMod') h = hsl(H, S, L * v); else if (m.n === 'lumOff') h = hsl(H, S, L + v);
    else if (m.n === 'tint') h = mix('#ffffff', h, v); else if (m.n === 'shade') h = mix('#000000', h, v);
    else if (m.n === 'satMod') h = hsl(H, S * v, L); else if (m.n === 'alpha') alpha = v;
  }
  return alpha < 0.995 ? h + Math.round(alpha * 255).toString(16).padStart(2, '0') : h;
}
const clrIn = (n, ctx) => { const c = n && n.c.find((x) => CLR.test(x.n)); return c ? colorOf(c, ctx) : null; };
const xf = (x) => {
  const o = kid(x, 'off'), e = kid(x, 'ext');
  return o && e ? { x: +o.a.x / EMU, y: +o.a.y / EMU, w: +e.a.cx / EMU, h: +e.a.cy / EMU, rot: x.a.rot ? +x.a.rot / 60000 : 0, fh: x.a.flipH === '1' || x.a.flipH === 'true' ? 1 : 0, fv: x.a.flipV === '1' || x.a.flipV === 'true' ? 1 : 0 } : null;
};

export async function readPptx(buf) {
  const z = unzip(buf), warn = new Map(), W = (k, n = 1) => warn.set(k, (warn.get(k) || 0) + n), cache = new Map(), stats = { slides: 0, shapes: 0, pictures: 0, tables: 0 };
  const xml = async (p) => { if (!cache.has(p)) cache.set(p, p && z[p] ? parseXML(text(await z[p]())) : null); return cache.get(p); };
  const relsOf = async (p) => {
    const out = {}, x = await xml(p.replace(/([^/]+)$/, '_rels/$1.rels'));
    for (const r of findAll(x, 'Relationship')) out[r.a.Id] = { t: r.a.TargetMode === 'External' ? null : resolve(p, r.a.Target), type: (r.a.Type || '').split('/').pop() };
    return out;
  };
  const relOf = (rels, type) => Object.values(rels).find((r) => r.type === type)?.t;
  const pres = await xml('ppt/presentation.xml');
  if (!pres) throw new Error('This is not a PowerPoint (.pptx) file.');
  const deck = { v: 1, w: 960, h: 540, theme: { name: 'Imported', brand: '#1c7ed6', mode: 'light', font: 'sans' }, slides: [], media: {} };
  const sz = find(pres, 'sldSz');
  if (sz) { deck.w = +sz.a.cx / EMU; deck.h = +sz.a.cy / EMU; }
  const pr = await relsOf('ppt/presentation.xml'), defStyle = find(pres, 'defaultTextStyle');
  const mediaIds = new Map();
  const media = async (path) => {
    if (!mediaIds.has(path)) {
      const b = path && z[path] ? await z[path]() : null, t = b ? sniff(b) : '';
      mediaIds.set(path, b && t && t !== 'image/bmp' ? addMedia(deck, b, path.split('/').pop()) : null);
      if (!mediaIds.get(path)) W('Pictures in formats a browser cannot show (EMF, WMF, TIFF, missing or linked files)');
    }
    return mediaIds.get(path);
  };
  const findPh = (tree, ph, byType) => {
    if (!tree || !ph) return null;
    const all = findAll(tree, 'sp').filter((s) => find(kid(s, 'nvSpPr'), 'ph')), ty = (s) => find(kid(s, 'nvSpPr'), 'ph').a.type;
    return (!byType && ph.a.idx != null && all.find((s) => find(kid(s, 'nvSpPr'), 'ph').a.idx === ph.a.idx)) || all.find((s) => (ty(s) || 'obj') === (ph.a.type || 'obj')) || all.find((s) => norm(ty(s)) === norm(ph.a.type));
  };
  const fillOf = (pr, C) => {
    if (!pr) return undefined;
    for (const c of pr.c) {
      if (c.n === 'noFill') return null;
      if (c.n === 'solidFill') return clrIn(c, C.ctx);
      if (c.n === 'gradFill') { W('Gradient fills (shown as one blended colour)'); const st = findAll(c, 'gs').map((g) => clrIn(g, C.ctx)).filter(Boolean); return st.length ? st.reduce((a, b, i) => mix(a, b, 1 / (i + 1))) : null; }
      if (c.n === 'pattFill') { W('Pattern fills (shown as one colour)'); return clrIn(kid(c, 'fgClr'), C.ctx); }
    }
    return undefined;
  };
  const lnOf = (ln, C, sc) => {
    if (!ln) return sc ? { c: sc, w: 1 } : undefined;
    if (kid(ln, 'noFill')) return null;
    const f = kid(ln, 'solidFill'), c = (f && clrIn(f, C.ctx)) || sc;
    if (!c) return undefined;
    const he = kid(ln, 'headEnd'), te = kid(ln, 'tailEnd'), d = kid(ln, 'prstDash'), o = { c, w: (ln.a.w ? +ln.a.w : 9525) / EMU };
    if (d && d.a.val !== 'solid') o.d = d.a.val;
    if (he && he.a.type && he.a.type !== 'none') o.he = he.a.type;
    if (te && te.a.type && te.a.type !== 'none') o.te = te.a.type;
    return o;
  };
  const paths = (cg, g) => {
    const out = [];
    for (const p of findAll(cg, 'path')) {
      const d = [];
      for (const c of p.c) {
        const pts = kids(c, 'pt').map((t) => [+t.a.x, +t.a.y]);
        if (pts.some((q) => q.some(isNaN))) return null;
        if (c.n === 'moveTo') d.push(['M', ...pts[0]]); else if (c.n === 'lnTo') d.push(['L', ...pts[0]]);
        else if (c.n === 'cubicBezTo') d.push(['C', ...pts.flat()]); else if (c.n === 'quadBezTo') d.push(['Q', ...pts.flat()]);
        else if (c.n === 'close') d.push(['Z']); else if (c.n === 'arcTo') W('Arcs inside custom shapes (left out)');
      }
      out.push({ w: +p.a.w || g.w * EMU, h: +p.a.h || g.h * EMU, d, nf: p.a.fill === 'none' ? 1 : 0 });
    }
    return out.length ? out : null;
  };
  const font = (f, C) => (!f ? undefined : f === '+mj-lt' ? C.ctx.major : f === '+mn-lt' || f[0] === '+' ? C.ctx.minor : f);
  function readText(tx, chain, C, dc) {
    const paras = [];
    for (const p of kids(tx, 'p')) {
      const pPr = kid(p, 'pPr'), lvl = +(pPr && pPr.a.lvl) || 0;
      const L = [pPr, ...chain.map((s) => kid(s, `lvl${lvl + 1}pPr`))].filter(Boolean);
      const pick = (f) => { for (const n of L) { const v = f(n); if (v !== undefined) return v; } };
      const bu = pick((n) => (kid(n, 'buNone') ? 0 : kid(n, 'buAutoNum') ? 'n' : kid(n, 'buChar') || kid(n, 'buBlip') ? 1 : undefined)) || 0;
      const bc = bu === 1 ? pick((n) => kid(n, 'buChar')?.a.char) : undefined, al = pick((n) => n.a.algn);
      const runs = [];
      for (const r of p.c) {
        if (r.n === 'br') { runs.push({ t: '\n' }); continue; }
        if (r.n !== 'r' && r.n !== 'fld') continue;
        const rp = [kid(r, 'rPr'), ...L.map((n) => kid(n, 'defRPr'))].filter(Boolean);
        const get = (f) => { for (const n of rp) { const v = f(n); if (v !== undefined) return v; } };
        const run = { t: kid(r, 't')?.t || '', z: (+get((n) => n.a.sz) || 1800) / 100, c: get((n) => (kid(n, 'solidFill') ? clrIn(kid(n, 'solidFill'), C.ctx) : undefined)) || dc, f: font(get((n) => kid(n, 'latin')?.a.typeface), C) || C.ctx.minor };
        const flag = (k) => { const v = get((n) => n.a[k]); return v === '1' || v === 'true'; };
        if (flag('b')) run.b = 1;
        if (flag('i')) run.i = 1;
        const u = get((n) => n.a.u), st = get((n) => n.a.strike);
        if (u && u !== 'none') run.u = 1;
        if (st && st !== 'noStrike') run.s = 1;
        runs.push(run);
      }
      const para = { r: mergeRuns(runs), lvl, bu };
      if (bc && bc !== '•') para.bc = bc;
      if (al && al !== 'l') para.al = al;
      paras.push(para);
    }
    while (paras.length > 1 && !paras[paras.length - 1].r.length) paras.pop();
    return paras;
  }
  // one shape tree -> boxes; tr maps child coordinates through enclosing groups
  async function readTree(tree, C, tr, out, decor) {
    for (const n of tree.c) {
      if (n.n === 'AlternateContent') { const fb = kid(n, 'Fallback'); if (fb) await readTree(fb, C, tr, out, decor); continue; }
      if (n.n === 'grpSp') {
        const gx = kid(kid(n, 'grpSpPr'), 'xfrm'), o = kid(gx, 'off'), e = kid(gx, 'ext'), co = kid(gx, 'chOff') || o, ce = kid(gx, 'chExt') || e;
        if (gx && gx.a.rot && +gx.a.rot) W('Rotation of grouped shapes');
        W('Groups (ungrouped into separate shapes)');
        const sx = ce && +ce.a.cx ? +e.a.cx / +ce.a.cx : 1, sy = ce && +ce.a.cy ? +e.a.cy / +ce.a.cy : 1;
        const loc = (b) => (o ? { ...b, x: (+o.a.x + (b.x * EMU - +co.a.x) * sx) / EMU, y: (+o.a.y + (b.y * EMU - +co.a.y) * sy) / EMU, w: b.w * sx, h: b.h * sy } : b);
        await readTree(n, C, (b) => tr(loc(b)), out, decor);
        continue;
      }
      const cNv = find(n, 'cNvPr');
      if (!cNv || cNv.a.hidden === '1') continue;
      const nv = n.c[0], ph = find(nv, 'ph'), spPr = kid(n, 'spPr'), style = kid(n, 'style');
      if (ph && decor) continue;
      const sctx = (ref) => ({ ...C, ctx: { ...C.ctx, ph: clrIn(ref, C.ctx) } });
      const fRef = style && kid(style, 'fillRef'), lRef = style && kid(style, 'lnRef'), tRef = style && kid(style, 'fontRef');
      const styleFill = fRef && fRef.a.idx !== '0' ? clrIn(fRef, C.ctx) : undefined, styleLn = lRef && lRef.a.idx !== '0' ? clrIn(lRef, C.ctx) : undefined;
      let g = null, chainSp = [n];
      if (n.n === 'sp' || n.n === 'pic') {
        const lph = ph && C.lay ? findPh(C.lay.tree, ph) : null, mph = ph && C.mas ? findPh(C.mas.tree, ph, 1) : null;
        chainSp = [n, lph, mph].filter(Boolean);
        for (const s of chainSp) { const x = kid(kid(s, 'spPr'), 'xfrm'); if (x && (g = xf(x))) break; }
      } else g = xf(kid(n, 'xfrm') || kid(spPr, 'xfrm'));
      if (!g) continue;
      const base = { id: uid(), ...tr(g) };
      if (base.rot === 0) delete base.rot;
      const blip = find(kid(n, 'blipFill'), 'blip') || (spPr && find(kid(spPr, 'blipFill'), 'blip'));
      if (n.n === 'pic' || (n.n === 'sp' && blip)) {
        if (find(nv, 'videoFile') || find(nv, 'audioFile') || find(nv, 'media')) W('Video and audio (only the poster image was kept)');
        const rel = blip && C.rels[blip.a['r:embed'] || blip.a.embed], m = rel && rel.t ? await media(rel.t) : null;
        if (!m) { if (!rel) W('Pictures in formats a browser cannot show (EMF, WMF, TIFF, missing or linked files)'); continue; }
        const sr = find(n, 'srcRect'), pg = kid(spPr, 'prstGeom'), b = { ...base, t: 'pic', m: 'media:' + m, alt: cNv.a.descr || '' };
        if (sr && (sr.a.l || sr.a.t || sr.a.r || sr.a.b)) b.crop = ['l', 't', 'r', 'b'].map((k) => (+sr.a[k] || 0) / 1e5);
        if (pg && pg.a.prst !== 'rect') b.g = pg.a.prst;
        const ln = lnOf(kid(spPr, 'ln'), C, undefined);
        if (ln) b.ln = ln;
        stats.pictures++; out.push(b);
        continue;
      }
      if (n.n === 'graphicFrame') {
        const gd = find(n, 'graphicData'), uri = (gd && gd.a.uri) || '', tbl = find(gd, 'tbl');
        if (tbl) {
          let merged = 0;
          const trs = kids(tbl, 'tr'), cf = [], tp = kid(tbl, 'tblPr') || { a: {}, c: [] };
          const rows = trs.map((row, r) => kids(row, 'tc').map((tc, c) => {
            if (tc.a.hMerge || tc.a.vMerge || +tc.a.gridSpan > 1 || +tc.a.rowSpan > 1) merged = 1;
            const f = fillOf(kid(tc, 'tcPr'), C);
            if (f) (cf[r] || (cf[r] = []))[c] = f;
            return one(readText(kid(tc, 'txBody'), defStyle ? [defStyle] : [], C, C.ctx.tc.dk1)) || { r: [], lvl: 0, bu: 0 };
          }));
          if (merged) W('Merged table cells (shown unmerged)');
          if (kid(tp, 'tableStyleId')) W('Table styles (approximated)');
          const cw = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => +c.a.w / EMU), rh = trs.map((row) => +row.a.h / EMU);
          const sc = base.w / (cw.reduce((a, x) => a + x, 0) || 1);
          out.push({ ...base, t: 'table', rows, cw: cw.map((w) => w * sc), rh, h: Math.max(base.h, rh.reduce((a, x) => a + x, 0)), fixed: 1, cf, hdr: tp.a.firstRow === '1', font: C.ctx.minor, col: C.ctx.tc.dk1, hf: tp.a.firstRow === '1' ? C.ctx.tc.accent1 : null, hc: '#ffffff', band: tp.a.bandRow === '1' ? mix(C.ctx.tc.accent1 || '#4472c4', '#ffffff', 0.85) : null, lc: '#bfbfbf' });
          stats.tables++;
          continue;
        }
        const kind = /chart$/.test(uri) ? 'Charts' : /diagram$/.test(uri) ? 'SmartArt graphics' : /ole$/.test(uri) ? 'Embedded OLE objects' : 'Other embedded objects';
        W(kind + ' (a labelled placeholder marks where they were)');
        out.push({ ...base, t: 'shape', g: 'rect', fill: null, ln: { c: '#8a8f98', w: 1, d: 'dash' }, paras: [{ r: [{ t: `[${kind.replace(/s$/, '')} not imported]`, z: 14, c: '#6b7280' }], lvl: 0, bu: 0, al: 'ctr' }], an: 'ctr' });
        continue;
      }
      if (n.n === 'contentPart') { W('Ink drawings'); continue; }
      if (n.n === 'cxnSp') {
        const pg = kid(spPr, 'prstGeom'), prst = (pg && pg.a.prst) || 'line';
        out.push({ ...base, t: 'line', g: /^bent/.test(prst) ? 'elbow' : /^curved/.test(prst) ? 'curve' : 'line', ln: lnOf(kid(spPr, 'ln'), C, styleLn) || { c: '#000000', w: 1 } });
        stats.shapes++;
        continue;
      }
      if (n.n !== 'sp') continue;
      // shape or text box
      const tx = kid(n, 'txBody'), pg = kid(spPr, 'prstGeom'), cg = kid(spPr, 'custGeom');
      const b = { ...base, t: 'shape', g: pg ? pg.a.prst : 'rect' };
      if (cg) { const p = paths(cg, g); if (p) b.path = p; else W('Custom shapes that use formulas (drawn as rectangles)'); }
      let fill = fillOf(spPr, C);
      if (fill === undefined) fill = styleFill ?? null;
      const ln = lnOf(kid(spPr, 'ln'), C, styleLn);
      if (fill) b.fill = fill;
      if (ln) b.ln = ln;
      const hasText = tx && findAll(tx, 't').some((t) => t.t.trim());
      if (tx && hasText) {
        const type = ph ? ph.a.type || 'obj' : null, chain = [kid(tx, 'lstStyle')];
        if (ph) {
          chain.push(...chainSp.slice(1).map((s) => kid(kid(s, 'txBody'), 'lstStyle')));
          chain.push(C.mas && C.mas.st[norm(type) === 'title' ? 'titleStyle' : norm(type) === 'body' ? 'bodyStyle' : 'otherStyle']);
        }
        if (defStyle) chain.push(defStyle);
        const dc = (tRef && clrIn(tRef, C.ctx)) || C.ctx.tc[C.ctx.map.tx1 || 'dk1'] || '#000000';
        b.paras = readText(tx, chain.filter(Boolean), C, dc);
        const bps = chainSp.map((s) => kid(kid(s, 'txBody'), 'bodyPr')).filter(Boolean), bp = (k) => { for (const x of bps) if (x.a[k] != null) return x.a[k]; };
        b.an = { t: 't', ctr: 'ctr', b: 'b' }[bp('anchor')] || 't';
        b.ins = [['lIns', 91440], ['tIns', 45720], ['rIns', 91440], ['bIns', 45720]].map(([k, d]) => (bp(k) != null ? +bp(k) : d) / EMU);
        if (bps.some((x) => kid(x, 'normAutofit'))) b.fit = 1;
        if (bps.some((x) => x.a.vert && x.a.vert !== 'horz')) W('Vertical text (shown horizontally)');
        if (!pg && !cg && !b.fill && !b.ln) b.t = 'text';
        if (pg && pg.a.prst === 'rect' && !b.fill && !b.ln) b.t = 'text';
        if (type) b.ph = type;
      } else if (ph) continue; // empty placeholder: only visible while editing in PowerPoint
      if (!b.fill && !b.ln && !b.paras && !b.path) continue;
      stats.shapes++;
      out.push(b);
    }
  }
  const masters = new Map(), layouts = new Map(), id = (b) => b;
  const bgOf = async (x, C) => {
    const bg = kid(kid(x, 'cSld'), 'bg');
    if (!bg) return undefined;
    const p = kid(bg, 'bgPr');
    if (p) {
      const blip = find(p, 'blip');
      if (blip) { const rel = C.rels[blip.a['r:embed'] || blip.a.embed], m = rel && rel.t && (await media(rel.t)); if (m) return { m: 'media:' + m }; }
      const f = fillOf(p, C);
      return f || undefined;
    }
    const ref = kid(bg, 'bgRef');
    return ref ? clrIn(ref, C.ctx) || undefined : undefined;
  };
  async function master(path) {
    if (masters.has(path)) return masters.get(path);
    const x = (await xml(path)).c[0], rels = await relsOf(path), th = await xml(relOf(rels, 'theme'));
    const tc = {};
    for (const c of find(th, 'clrScheme')?.c || []) tc[c.n] = clrIn(c, { tc: {}, map: {} }) || '#000000';
    const fs = find(th, 'fontScheme'), major = find(kid(fs, 'majorFont'), 'latin')?.a.typeface || 'Calibri Light', minor = find(kid(fs, 'minorFont'), 'latin')?.a.typeface || 'Calibri';
    const map = { ...(find(x, 'clrMap')?.a || {}) };
    const M = { tree: find(x, 'spTree'), ctx: { tc, map, major, minor }, st: {} };
    const ts = kid(x, 'txStyles');
    for (const k of ['titleStyle', 'bodyStyle', 'otherStyle']) M.st[k] = kid(ts, k);
    const C = { rels, ctx: M.ctx };
    M.bg = await bgOf(x, C);
    M.decor = [];
    if (M.tree) await readTree(M.tree, C, id, M.decor, 1);
    masters.set(path, M);
    return M;
  }
  async function layout(path) {
    if (layouts.has(path)) return layouts.get(path);
    const x = (await xml(path)).c[0], rels = await relsOf(path), M = await master(relOf(rels, 'slideMaster'));
    const L = { tree: find(x, 'spTree'), M, show: x.a.showMasterSp !== '0', decor: [] };
    const C = { rels, ctx: M.ctx };
    L.bg = await bgOf(x, C);
    if (L.tree) await readTree(L.tree, C, id, L.decor, 1);
    layouts.set(path, L);
    return L;
  }
  const sldPaths = kids(find(pres, 'sldIdLst'), 'sldId').map((n) => pr[n.a['r:id']]?.t).filter(Boolean);
  for (const path of sldPaths) {
    const sx = (await xml(path))?.c[0];
    if (!sx) continue;
    const rels = await relsOf(path), L = await layout(relOf(rels, 'slideLayout')), M = L.M;
    const ovr = find(kid(sx, 'clrMapOvr'), 'overrideClrMapping');
    const C = { rels, lay: L, mas: M, ctx: ovr ? { ...M.ctx, map: ovr.a } : M.ctx };
    const s = newSlide({ layout: 'free' }), boxes = [], els = [];
    const bg = (await bgOf(sx, C)) ?? L.bg ?? M.bg ?? M.ctx.tc.lt1;
    s.bg = bg || null;
    const fresh = (b) => ({ ...JSON.parse(JSON.stringify(b)), id: uid() });
    if (sx.a.showMasterSp !== '0' && L.show) els.push(...M.decor.map(fresh));
    if (sx.a.showMasterSp !== '0') els.push(...L.decor.map(fresh));
    const tree = find(kid(sx, 'cSld'), 'spTree');
    if (tree) await readTree(tree, C, id, boxes);
    for (const b of boxes) {
      const t = b.ph;
      delete b.ph;
      const role = (t === 'title' || t === 'ctrTitle') && !s.title ? 'title' : t === 'subTitle' && !s.sub.length ? 'sub' : (t === 'body' || t === 'obj') && !s.body.length ? 'body' : null;
      if (role && b.paras) {
        if (role === 'title') s.title = one(b.paras); else s[role] = b.paras;
        const o = { x: b.x, y: b.y, w: b.w, h: b.h, an: b.an, ins: b.ins, fit: 1 };
        for (const k of ['rot', 'fh', 'fv', 'fill', 'ln', 'path']) if (b[k]) o[k] = b[k];
        if (b.g && b.g !== 'rect') { o.t = 'shape'; o.g = b.g; }
        s.ov[role] = o;
        els.push({ slot: role });
      } else els.push(b);
    }
    s.els = els;
    const nr = relOf(rels, 'notesSlide');
    if (nr) {
      const nx = await xml(nr), body = nx && findAll(nx, 'sp').find((p) => find(p, 'ph')?.a.type === 'body');
      if (body) s.notes = kids(kid(body, 'txBody'), 'p').map((p) => findAll(p, 't').map((t) => t.t).join('')).join('\n').trim();
    }
    const tr = find(sx, 'transition');
    if (tr) { const k = tr.c[0] && tr.c[0].n; s.tr = TR[k] || (k ? 'fade' : null); if (k && !TR[k]) W('Transitions (replaced by a simple fade)'); }
    const tm = kid(sx, 'timing');
    if (tm && findAll(tm, 'par').length > 1) W('Animations', 1);
    if (sx.a.show === '0') s.hidden = true;
    stats.slides++;
    deck.slides.push(s);
  }
  // deck theme from the first master: brand = accent 1, fonts kept by name
  const M0 = masters.values().next().value;
  if (M0) {
    const tc = M0.ctx.tc;
    deck.theme = { name: 'Imported', brand: tc.accent1 || '#1c7ed6', mode: lum(tc.lt1 || '#ffffff') < 0.25 ? 'dark' : 'light', font: 'sans', hf: M0.ctx.major, bf: M0.ctx.minor };
  }
  const core = await xml('docProps/core.xml');
  const title = core && find(core, 'title')?.t;
  return { deck, warnings: [...warn].map(([k, n]) => (k === 'Animations' ? `Animations (on ${n} slide${n > 1 ? 's' : ''})` : n > 1 && !/^Groups/.test(k) ? `${k}: ${n}` : k)), stats, title };
}

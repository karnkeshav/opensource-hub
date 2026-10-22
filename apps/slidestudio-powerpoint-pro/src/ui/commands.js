// Every action is a command with a label and (usually) a shortcut. The toolbar, menus, the command palette
// (Ctrl+K) and the keyboard all dispatch through this one table.
import { h, $, E, toast, menu, closeMenu, dialog, colorMenu, download } from './util.js';
import { lay, slideHTML, measure } from './render.js';
import { present } from './present.js';
import { App } from './app.js';
import { newDeck, newSlide, parseOutline, toOutline, slideMd, normalizeMd, binding, removeKey, allParas, plain, P, uid, clone } from '../model.js';
import { addMedia, extractDataUrls, sniff, bytesToB64, b64ToBytes } from '../media.js';
import { LAYOUTS } from '../layout.js';
import { THEMES, FONTS, MODES, derive } from '../theme.js';
import { DIAGRAMS } from '../diagram.js';
import { checkDeck, applyFix, CHECKS } from '../checks.js';
import { writePptx } from '../pptx-write.js';
import { readPptx } from '../pptx-read.js';
import { zip } from '../zip.js';

const gz = async (d, dir) => new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(dir ? new CompressionStream('gzip') : new DecompressionStream('gzip'))).arrayBuffer());
const SHAPES = [['rect', 'Rectangle'], ['roundRect', 'Rounded rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['rightArrow', 'Block arrow'], ['chevron', 'Chevron'], ['star5', 'Star'], ['line', 'Line'], ['arrow', 'Arrow']];
const TRANS = [[null, 'None'], ['fade', 'Fade'], ['push', 'Push'], ['zoom', 'Zoom']];
const DG_TPL = { flow: 'Start -> Review?\nReview? -> Approve -> Done\nReview? -> Rework -> Review?', org: 'CEO\n  CTO\n    Engineering\n    Design\n  CFO\n    Finance', timeline: '2022: Idea\n2023: First customers\n2024: Launch\n2025: Scale', cycle: 'Plan\nDo\nCheck\nAct', rel: 'Customers <-> Product\nProduct -> Revenue\nRevenue -> Team\nTeam -> Product', bar: 'North: 42\nSouth: 31\nEast: 27\nWest: 18' };

// ---------- selection helpers ----------
function els(app) { return app.sel.map((k) => app.slide.els.find((e) => e.id === k)); }
function setOv(app, k, o) { const s = app.slide, el = s.els.find((e) => e.id === k); if (el) Object.assign(el, o); else s.ov[k] = { ...s.ov[k], ...o }; }
function runsOf(app, k) { const b = binding(app.slide, k); return b ? b.get().flatMap((p) => p.r) : []; }
function needSel(app) { if (!app.sel.length) { toast('Select something on the slide first'); return false; } return true; }
function geo(app) { return app.sel.map((k) => app.box(k)).filter(Boolean); }
function align(app, how) {
  const bs = geo(app);
  if (!bs.length) return needSel(app);
  const one = bs.length === 1, d = app.deck;
  const L = one ? 0 : Math.min(...bs.map((b) => b.x)), R = one ? d.w : Math.max(...bs.map((b) => b.x + b.w)), T = one ? 0 : Math.min(...bs.map((b) => b.y)), B = one ? d.h : Math.max(...bs.map((b) => b.y + b.h));
  app.edit(() => {
    if (how === 'dh' || how === 'dv') {
      const x = how === 'dh', s = [...bs].sort((a, b) => (x ? a.x - b.x : a.y - b.y)), tot = s.reduce((a, b) => a + (x ? b.w : b.h), 0), gap = ((x ? R - L : B - T) - tot) / Math.max(1, s.length - 1);
      let p = x ? L : T;
      s.forEach((b) => { app.setGeom(app.slide, b.k, x ? { x: p } : { y: p }); p += (x ? b.w : b.h) + gap; });
      return;
    }
    for (const b of bs) app.setGeom(app.slide, b.k, { l: { x: L }, c: { x: (L + R) / 2 - b.w / 2 }, r: { x: R - b.w }, t: { y: T }, m: { y: (T + B) / 2 - b.h / 2 }, b: { y: B - b.h } }[how]);
  });
}
// Tidy: snap to an 8 pt grid, line the selection up along its main axis with equal gaps and centre it on the other.
function tidy(app) {
  let bs = geo(app);
  if (bs.length < 2) bs = app.L.boxes.filter((b) => !b.d && b.t !== 'line' && app.slide.els.some((e) => e.id === b.k));
  if (!bs.length) { app.cmd('relayout'); return; }
  const g = (v) => Math.round(v / 8) * 8, cx = bs.map((b) => b.x + b.w / 2), cy = bs.map((b) => b.y + b.h / 2);
  const horiz = Math.max(...cx) - Math.min(...cx) >= Math.max(...cy) - Math.min(...cy);
  app.edit(() => {
    if (bs.length === 1) { const b = bs[0]; app.setGeom(app.slide, b.k, { x: g(b.x), y: g(b.y), w: g(b.w) || 8, h: g(b.h) || 8 }); return; }
    const s = [...bs].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y)), first = s[0], last = s[s.length - 1];
    const span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y, tot = s.reduce((a, b) => a + (horiz ? b.w : b.h), 0), gap = Math.max(8, g((span - tot) / (s.length - 1)));
    const mid = g(s.reduce((a, b) => a + (horiz ? b.y + b.h / 2 : b.x + b.w / 2), 0) / s.length);
    let p = g(horiz ? first.x : first.y);
    for (const b of s) { app.setGeom(app.slide, b.k, horiz ? { x: p, y: mid - b.h / 2 } : { y: p, x: mid - b.w / 2 }); p += (horiz ? b.w : b.h) + gap; }
  });
}
function zorder(app, front) {
  if (!needSel(app)) return;
  app.edit(() => {
    const s = app.slide;
    for (const k of app.sel) {
      let i = s.els.findIndex((e) => e.id === k || e.slot === k);
      const it = i >= 0 ? s.els.splice(i, 1)[0] : { slot: k };
      if (front) s.els.push(it); else s.els.unshift(it);
    }
  });
}
function fmt(app, fn) { if (!needSel(app)) return; app.edit(() => app.sel.forEach((k) => fn(k, app.box(k)))); }
function textFmt(app, fn) { fmt(app, (k, b) => { const rs = runsOf(app, k); if (rs.length) rs.forEach((r) => fn(r, b)); }); }
function sizeBy(app, f) { textFmt(app, (r, b) => { r.z = Math.max(6, Math.round((r.z || (b.base || [18])[0]) * f)); }); }

function freshIds(sl) { sl.id = uid(); sl.els = sl.els.map((e) => (e.slot ? e : { ...e, id: uid() })); return sl; }
function boxAsEl(app, k) {
  const el = app.slide.els.find((e) => e.id === k);
  if (el) return clone(el);
  const b = clone(app.box(k));
  for (const x of ['k', 'ph', 'over', 'grp', 'd', 'h0']) delete b[x];
  if (b.fs && b.paras) { b.paras.forEach((p) => p.r.forEach((r) => { r.z = Math.round((r.z || (b.base || [18])[Math.min(p.lvl || 0, (b.base || [18]).length - 1)]) * b.fs * 2) / 2; })); delete b.fs; }
  return { ...b, id: uid() };
}
const mediaOf = (app, obj) => { const out = {}; for (const m of JSON.stringify(obj).matchAll(/media:(\w+)/g)) if (app.deck.media[m[1]]) out[m[1]] = app.deck.media[m[1]]; return out; };

async function imageBytes(file) {
  let b = new Uint8Array(await file.arrayBuffer());
  if (!/png|jpeg|gif/.test(sniff(b))) { // convert other formats (webp, bmp, svg) to PNG so the .pptx can embed them
    const img = new Image(), url = URL.createObjectURL(new Blob([b], { type: file.type || sniff(b) }));
    img.src = url; await img.decode();
    const c = h('canvas', { width: img.naturalWidth || 800, height: img.naturalHeight || 600 });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
  }
  return b;
}
async function pngOf(app, i, k = 2) {
  const d = app.deck, holder = h('div', { innerHTML: slideHTML(d.slides[i], d, i) });
  const x = new XMLSerializer().serializeToString(holder.firstChild);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d.w * k}" height="${d.h * k}"><foreignObject x="0" y="0" width="${d.w}" height="${d.h}" transform="scale(${k})">${x}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const c = h('canvas', { width: d.w * k, height: d.h * k });
  c.getContext('2d').drawImage(img, 0, 0);
  return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
}
const PLAYER = (W, H) => `var S=document.querySelectorAll('section'),i=0,n=document.getElementById('n');function f(){var w=innerWidth,h=innerHeight,k=Math.min(w/${W},h/${H});S.forEach(function(s){s.style.transform='translate('+(w-${W}*k)/2+'px,'+(h-${H}*k)/2+'px) scale('+k+')'})}function go(j){i=Math.max(0,Math.min(S.length-1,j));S.forEach(function(s,x){s.className=x==i?'on':''});n.textContent=(i+1)+' / '+S.length;history.replaceState(null,'','#'+(i+1))}addEventListener('resize',f);addEventListener('keydown',function(e){var k=e.key;if(/ArrowRight|ArrowDown|PageDown|^ $|Enter/.test(k))go(i+1);else if(/ArrowLeft|ArrowUp|PageUp|Backspace/.test(k))go(i-1);else if(k=='Home')go(0);else if(k=='End')go(S.length-1)});addEventListener('click',function(e){go(i+(e.clientX<innerWidth/3?-1:1))});f();go((+location.hash.slice(1)||1)-1)`;
const FORMATS = {
  pptx: { label: 'PowerPoint (.pptx)', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', keep: 1, async make(app) { const r = await writePptx(app.deck, { measure, title: app.title }); return { data: r.data, warnings: r.warnings }; } },
  slidestudio: { label: 'SlideStudio deck (.slidestudio, keeps outline, layouts and diagram text)', mime: 'application/gzip', keep: 1, async make(app) { return { data: await gz(new TextEncoder().encode(JSON.stringify({ app: 'slidestudio', v: 1, deck: app.deck })), 1) }; } },
  md: { label: 'Markdown outline (.md)', mime: 'text/markdown', async make(app) { return { data: toOutline(app.deck).replace(/\(media:(\w+)\)/g, (m, id) => (app.deck.media[id] ? `(${app.deck.media[id].d})` : m)) }; } },
  html: {
    label: 'Standalone HTML presentation (.html)', mime: 'text/html', async make(app) {
      const d = app.deck, sl = d.slides.map((s, i) => (s.hidden ? '' : `<section>${slideHTML(s, d, i)}</section>`)).join('');
      return { data: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(app.title)}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;background:#111;overflow:hidden}section{position:absolute;left:0;top:0;transform-origin:0 0;visibility:hidden;opacity:0;transition:opacity .35s}section.on{visibility:visible;opacity:1}#n{position:fixed;right:12px;bottom:8px;color:#999;font:13px system-ui,sans-serif}</style></head><body>${sl}<div id="n"></div><script>${PLAYER(d.w, d.h)}</script></body></html>` };
    },
  },
};

// ---------- side panels ----------
function side(app, title, ...body) {
  const p = $('#side');
  p.hidden = false;
  p.replaceChildren(h('div', { class: 'sh' }, h('b', null, title), h('button', { class: 'rb', type: 'button', 'aria-label': 'Close panel', onclick: () => { p.hidden = true; app.panel = null; app.renderStage(); } }, '✕')), ...body.filter(Boolean));
  app.panel = title;
  app.renderStage();
  return p;
}
function themePanel(app) {
  const t = app.deck.theme, set = (o) => { app.edit(() => { app.deck.theme = { ...app.deck.theme, ...o }; if ('font' in o || 'name' in o) { delete app.deck.theme.hf; delete app.deck.theme.bf; } }, { tag: 'theme' }); themePanel(app); };
  const card = (p) => { const th = derive(p); return h('button', { type: 'button', class: 'tcard' + (p.name === t.name && p.brand === t.brand ? ' on' : ''), title: p.name, 'aria-label': 'Theme ' + p.name, style: { background: th.bg, color: th.title, borderColor: th.line }, onclick: () => set({ ...p }) }, h('b', { style: { fontFamily: th.head } }, 'Aa'), h('i', { style: { background: th.acc[0] } }), h('i', { style: { background: th.acc[1] } }), h('i', { style: { background: th.acc[3] } }), h('small', { style: { color: th.muted } }, p.name)); };
  const th = derive(t);
  side(app, 'Theme',
    h('p', { class: 'hint' }, 'Pick one brand colour; the palette, text colours (WCAG AA contrast enforced) and fonts follow for every slide.'),
    h('div', { class: 'tgrid' }, THEMES.map(card)),
    h('label', { class: 'fld' }, h('span', null, 'Brand colour'), h('input', { type: 'color', value: t.brand.slice(0, 7), oninput: (e) => { app.push('theme'); app.deck.theme = { ...app.deck.theme, brand: e.target.value, name: 'Custom' }; app.changed({ tag: 'theme' }); }, onchange: () => themePanel(app) })),
    h('label', { class: 'fld' }, h('span', null, 'Background'), h('select', { onchange: (e) => set({ mode: e.target.value, name: 'Custom' }) }, Object.entries(MODES).map(([k, l]) => h('option', { value: k, selected: k === t.mode }, l)))),
    h('label', { class: 'fld' }, h('span', null, 'Fonts'), h('select', { onchange: (e) => set({ font: e.target.value }) }, t.hf ? h('option', { selected: true }, `${t.hf} / ${t.bf} (from file)`) : null, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: !t.hf && k === t.font }, `${f[2]}: ${f[0]} / ${f[1]}`)))),
    h('label', { class: 'fld' }, h('span', null, 'Slide size'), h('select', { onchange: (e) => app.cmd('slideSize', +e.target.value) }, [[960, '16:9 widescreen'], [720, '4:3 standard'], [864, '16:10']].map(([w, l]) => h('option', { value: w, selected: Math.round(app.deck.w * 540 / app.deck.h) === w }, l)))),
    h('div', { class: 'swatches' }, [th.bg, th.text, th.title, th.surface, ...th.acc].map((c) => h('span', { style: { background: c }, title: c }))),
  );
}
function checksPanel(app) {
  const iss = checkDeck(app.deck, measure), fixable = iss.filter((x) => x.fix && x.fix !== 'alt');
  const run = (x) => { if (x.fix === 'alt') { app.go(x.i); app.select([x.k]); return app.cmd('alt', x.k); } app.edit(() => applyFix(app.deck, x, measure)); checksPanel(app); };
  side(app, `Checks (${iss.length})`,
    h('p', { class: 'hint' }, iss.length ? 'Contrast, tiny text, overflow, alt text, titles and reading order.' : 'No problems found: contrast, text size, overflow, alt text, titles and reading order all pass.'),
    fixable.length ? h('button', { class: 'btn primary', type: 'button', onclick: () => { app.edit(() => { for (const x of checkDeck(app.deck, measure)) if (x.fix && x.fix !== 'alt') applyFix(app.deck, x, measure); }); checksPanel(app); toast('Applied all automatic fixes'); } }, `Fix all ${fixable.length} automatically`) : null,
    h('ul', { class: 'issues' }, iss.slice(0, 400).map((x) => h('li', null, h('button', { type: 'button', class: 'lnk', onclick: () => { app.go(x.i); if (x.k) app.select([x.k]); } }, h('b', null, `Slide ${x.i + 1} · ${CHECKS[x.type]}`), h('span', null, x.msg)), x.fix ? h('button', { type: 'button', class: 'btn sm', onclick: () => run(x) }, x.fix === 'alt' ? 'Add…' : 'Fix') : null))),
  );
}
function findPanel(app, rep) {
  const q = h('input', { type: 'search', placeholder: 'Find', 'aria-label': 'Find' }), r = h('input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with' }), cs = h('input', { type: 'checkbox', 'aria-label': 'Match case' }), info = h('div', { class: 'hint', 'aria-live': 'polite' });
  const re = () => q.value && new RegExp(q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs.checked ? 'g' : 'gi');
  const texts = (s) => [...allParas(s).map(plain), s.notes, s.dg ? s.dg.src : ''].join('\n');
  const hits = () => { const x = re(); return x ? app.deck.slides.map((s, i) => [i, (texts(s).match(x) || []).length]).filter((a) => a[1]) : []; };
  const upd = () => { const hs = hits(); info.textContent = q.value ? `${hs.reduce((a, b) => a + b[1], 0)} matches on ${hs.length} slides` : ''; };
  const next = () => { const hs = hits(); if (!hs.length) return toast('No matches'); const n = hs.find((a) => a[0] > app.cur) || hs[0]; app.go(n[0]); };
  const all = () => {
    const x = re();
    if (!x) return;
    let n = 0;
    app.edit(() => app.deck.slides.forEach((s) => {
      allParas(s).forEach((p) => p.r.forEach((rn) => { rn.t = rn.t.replace(x, () => { n++; return r.value; }); }));
      s.notes = s.notes.replace(x, () => { n++; return r.value; });
      if (s.dg) s.dg.src = s.dg.src.replace(x, () => { n++; return r.value; });
      if (s.quote) s.quote.by = s.quote.by.replace(x, r.value);
    }));
    toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`); upd();
  };
  q.addEventListener('input', upd);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); all(); } });
  side(app, 'Find and replace', q, r, h('label', { class: 'fld chk' }, cs, 'Match case'), h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: next }, 'Find next'), h('button', { class: 'btn primary', type: 'button', onclick: all }, 'Replace all')), info);
  (rep && q.value ? r : q).focus();
}

// ---------- the command table ----------
const sel1 = (app) => [...app.rsel].sort((a, b) => a - b);
export const CMD = {
  // file
  new: { l: 'New presentation', k: 'Ctrl+Alt+N', async f() { if (this.modified && !(await dialog('Discard changes?', [], { ok: 'Discard and start new', hint: 'This presentation has unsaved changes.' }))) return; this.setDeck(newDeck()); this.ol.focus(); this.ol.select(); } },
  open: { l: 'Open…', k: 'Ctrl+O', g: 1, async f() { if (window.showOpenFilePicker) { try { const [hd] = await showOpenFilePicker({ types: [{ description: 'Presentations', accept: { 'application/octet-stream': ['.pptx', '.slidestudio', '.md', '.txt'] } }] }); await this.cmd('openFile', await hd.getFile(), hd); } catch (e) { if (e.name !== 'AbortError') throw e; } } else $('#filein').click(); } },
  async openFile(file, handle) {
    if (this.modified && !(await dialog('Replace this presentation?', [], { ok: 'Open anyway', hint: `Opening "${file.name}" replaces the current presentation, which has unsaved changes.` }))) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let buf = new Uint8Array(await file.arrayBuffer());
    toast('Opening ' + file.name + '…', 30000);
    if (/^(pptx|ppsx|potx|pptm)$/.test(ext)) {
      const t0 = performance.now(), r = await readPptx(buf);
      this.setDeck(r.deck, file.name);
      toast(`Opened ${r.stats.slides} slides in ${Math.round(performance.now() - t0)} ms`);
      if (r.warnings.length) dialog('Imported with some changes', [{ type: 'html', el: h('ul', { class: 'warns' }, r.warnings.map((w) => h('li', null, w))) }], { cancel: null, ok: 'OK', hint: `${r.stats.slides} slides, ${r.stats.shapes} shapes, ${r.stats.pictures} pictures and ${r.stats.tables} tables were imported. This app does not support everything in PowerPoint; these items were left out or simplified:` });
    } else if (ext === 'slidestudio' || ext === 'json') {
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gz(buf);
      const j = JSON.parse(new TextDecoder().decode(buf)), d = j.deck || j;
      if (!d.slides) throw new Error('Not a SlideStudio file');
      this.setDeck(d, file.name); toast('Opened ' + file.name);
    } else {
      const d = newDeck();
      d.slides = parseOutline(extractDataUrls(normalizeMd(new TextDecoder().decode(buf)), d));
      if (!d.slides.length) d.slides = [newSlide()];
      this.setDeck(d, file.name); toast('Opened ' + file.name);
    }
    this.handle = handle && FORMATS[ext] && FORMATS[ext].keep ? handle : null;
    this.fmt = ext;
  },
  save: { l: 'Save', k: 'Ctrl+S', g: 1, f() { return this.cmd('saveAs', this.handle ? this.fmt : 'pptx', !!this.handle); } },
  saveAs: {
    l: 'Save as…', k: 'Ctrl+Shift+S', g: 1, async f(fmt, reuse) {
      if (!fmt) { const v = await dialog('Save as', [{ name: 'f', label: 'Format', type: 'select', value: 'pptx', options: Object.entries(FORMATS).map(([k, f]) => [k, f.label]) }]); if (!v) return; fmt = v.f; }
      this.commitText();
      const F = FORMATS[fmt], out = await F.make(this), name = this.title.replace(/[\\/:*?"<>|]/g, '_') + '.' + fmt;
      let saved = name;
      if (reuse && this.handle) { const w = await this.handle.createWritable(); await w.write(out.data); await w.close(); saved = this.handle.name; }
      else if (window.showSaveFilePicker) {
        try { const hd = await showSaveFilePicker({ suggestedName: name, types: [{ description: F.label, accept: { [F.mime]: ['.' + fmt] } }] }); const w = await hd.createWritable(); await w.write(out.data); await w.close(); saved = hd.name; if (F.keep) { this.handle = hd; this.fmt = fmt; } } catch (e) { if (e.name === 'AbortError') return; throw e; }
      } else download(name, out.data, F.mime);
      if (F.keep) { this.modified = false; this.updateTitle(); }
      $('#saved').textContent = 'Saved ' + new Date().toLocaleTimeString();
      toast([`Saved ${saved}`, ...(out.warnings || []), fmt === 'pptx' ? 'Tip: .slidestudio also keeps the outline, auto layouts and diagram text' : ''].filter(Boolean).join(' · '), 6000);
    },
  },
  exportPptx: { l: 'Export as PowerPoint (.pptx)', f() { return this.cmd('saveAs', 'pptx'); } },
  exportNative: { l: 'Export as .slidestudio', f() { return this.cmd('saveAs', 'slidestudio'); } },
  exportMd: { l: 'Export Markdown outline', f() { return this.cmd('saveAs', 'md'); } },
  exportHtml: { l: 'Export standalone HTML presentation', f() { return this.cmd('saveAs', 'html'); } },
  print: {
    l: 'Print / PDF', k: 'Ctrl+P', g: 1, f() {
      this.commitText();
      const d = this.deck;
      let pa = $('#printarea');
      if (!pa) { pa = h('div', { id: 'printarea' }); document.body.append(pa); }
      pa.innerHTML = `<style>@page{size:${d.w}px ${d.h}px;margin:0}</style>` + d.slides.map((s, i) => (s.hidden ? '' : `<div class="pg">${slideHTML(s, d, i)}</div>`)).join('');
      setTimeout(() => print(), 50);
    },
  },
  png: { l: 'Export this slide as PNG', async f() { download(`${this.title} - slide ${this.cur + 1}.png`, await pngOf(this, this.cur), 'image/png'); } },
  pngAll: { l: 'Export all slides as PNG (zip)', async f() { const files = {}; for (let i = 0; i < this.deck.slides.length; i++) { toast(`Rendering slide ${i + 1} of ${this.deck.slides.length}…`); files[`slide-${String(i + 1).padStart(3, '0')}.png`] = await pngOf(this, i); } download(this.title + ' - slides.zip', await zip(files), 'application/zip'); toast('Exported ' + this.deck.slides.length + ' PNG files'); } },
  // edit
  undo: { l: 'Undo', k: 'Ctrl+Z', f() { this.undo(); } },
  redo: { l: 'Redo', k: 'Ctrl+Y', f() { this.redo(); } },
  redo2: { k: 'Ctrl+Shift+Z', f() { this.redo(); } },
  find: { l: 'Find', k: 'Ctrl+F', g: 1, f() { findPanel(this); } },
  replace: { l: 'Find and replace', k: 'Ctrl+H', g: 1, f() { findPanel(this, 1); } },
  palette: {
    l: 'Command palette', k: 'Ctrl+K', g: 1, f() {
      const list = Object.entries(CMD).filter(([, c]) => c.l), inp = h('input', { type: 'search', placeholder: 'Type a command…', 'aria-label': 'Command' }), ul = h('div', { class: 'pal', role: 'listbox' });
      let hit = [], ix = 0;
      const draw = () => { const q = inp.value.toLowerCase().split(/\s+/).filter(Boolean); hit = list.filter(([, c]) => q.every((w) => c.l.toLowerCase().includes(w))).slice(0, 14); ix = Math.min(ix, Math.max(0, hit.length - 1)); ul.replaceChildren(...hit.map(([id, c], i) => h('div', { class: 'pi' + (i === ix ? ' on' : ''), role: 'option', onmousedown: (e) => { e.preventDefault(); ix = i; go(); } }, h('span', null, c.l), c.k ? h('kbd', null, c.k) : null))); };
      const back = h('div', { class: 'modal-back pal-back', onmousedown: (e) => { if (e.target === back) back.remove(); } }, h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Command palette' }, inp, ul));
      const go = () => { const c = hit[ix]; back.remove(); if (c) this.cmd(c[0]); };
      inp.addEventListener('input', () => { ix = 0; draw(); });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'ArrowDown') { ix = Math.min(hit.length - 1, ix + 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { ix = Math.max(0, ix - 1); draw(); e.preventDefault(); } else if (e.key === 'Enter') { e.preventDefault(); go(); } else if (e.key === 'Escape') back.remove(); });
      document.body.append(back); draw(); inp.focus();
    },
  },
  shortcuts: { l: 'Keyboard shortcuts', k: 'Ctrl+/', g: 1, f() { dialog('Keyboard shortcuts', [{ type: 'html', el: h('table', { class: 'keys' }, Object.values(CMD).filter((c) => c.l && c.k).map((c) => h('tr', null, h('td', null, c.l), h('td', null, h('kbd', null, c.k))))) }, { type: 'html', el: h('p', { class: 'hint' }, 'On the slide: arrows nudge (Shift = 10 pt), Enter edits text, Tab cycles objects, Alt while dragging turns snapping off. In the outline: Tab / Shift+Tab indent. While presenting: arrows, Space, Page Up/Down, Home/End, a number then Enter, B black, W white, Esc to stop.') }], { cancel: null, width: 560 }); } },
  selectAll: { l: 'Select all objects on the slide', k: 'Ctrl+A', f() { this.select(this.L.boxes.filter((b) => this.movable(b.k) && !b.d).map((b) => b.k)); } },
  // slides
  newSlide: {
    l: 'New slide', k: 'Ctrl+M', g: 1, f() {
      if (document.activeElement === this.ol) { const v = this.ol.value, p = this.ol.selectionStart, nx = v.slice(p).search(/\n(#(\s|$)|---)/), at = nx < 0 ? v.length : p + nx; this.ol.setRangeText('\n\n# ', at, at, 'end'); this.ol.dispatchEvent(new Event('input')); return; }
      const at = Math.max(...this.rsel) + 1;
      this.edit(() => { this.deck.slides.splice(at, 0, newSlide({ title: P('New slide') })); this.cur = at; this.rsel = new Set([at]); });
      this.scrollRail(); this.editBox('title', true);
    },
  },
  dupSlide: { l: 'Duplicate slide', k: 'Ctrl+D', f() { if (this.sel.length && this.sw.contains(document.activeElement)) return this.cmd('dupObj'); const ix = sel1(this), at = ix[ix.length - 1] + 1; this.edit(() => { this.deck.slides.splice(at, 0, ...ix.map((i) => freshIds(clone(this.deck.slides[i])))); this.cur = at; this.rsel = new Set(ix.map((_, k) => at + k)); }); this.scrollRail(); } },
  delSlide: { l: 'Delete slide', f() { const ix = sel1(this); this.edit(() => { this.deck.slides = this.deck.slides.filter((_, i) => !ix.includes(i)); this.cur = Math.min(ix[0], this.deck.slides.length - 1); this.rsel = new Set([Math.max(0, this.cur)]); }); toast(`Deleted ${ix.length} slide${ix.length > 1 ? 's' : ''} (Ctrl+Z to undo)`); } },
  hideSlide: { l: 'Hide / show slide in slide show', f() { const ix = sel1(this), v = !this.deck.slides[ix[0]].hidden; this.edit(() => ix.forEach((i) => { this.deck.slides[i].hidden = v; })); } },
  slideUp: { l: 'Move slide up', k: 'Ctrl+Shift+ArrowUp', f() { if (this.sel.length && this.sw.contains(document.activeElement)) return zorder(this, 1); const ix = sel1(this); if (ix[0] > 0) this.moveSlides(ix, ix[0] - 1); } },
  slideDown: { l: 'Move slide down', k: 'Ctrl+Shift+ArrowDown', f() { if (this.sel.length && this.sw.contains(document.activeElement)) return zorder(this, 0); const ix = sel1(this); if (ix[ix.length - 1] < this.deck.slides.length - 1) this.moveSlides(ix, ix[ix.length - 1] + 2); } },
  nextSlide: { k: 'PageDown', f() { this.go(this.cur + 1); } },
  prevSlide: { k: 'PageUp', f() { this.go(this.cur - 1); } },
  layout: { l: 'Slide layout…', k: 'Alt+L', f() { const cur = this.slide.layout || 'auto'; menu(Object.entries(LAYOUTS).map(([k, l]) => ({ label: l, checked: k === cur, onclick: () => this.edit(() => sel1(this).forEach((i) => { this.deck.slides[i].layout = k === 'auto' ? null : k; })) })), $('#b-layout') || null, { x: innerWidth / 2 - 100, y: 120 }); } },
  relayout: { l: 'Reset positions (re-run auto layout)', k: 'Alt+R', f() { this.edit(() => sel1(this).forEach((i) => { const s = this.deck.slides[i]; for (const k in s.ov) { const o = s.ov[k]; for (const x of ['x', 'y', 'w', 'h', 'hide', 'rot']) delete o[x]; if (!Object.keys(o).length) delete s.ov[k]; } if (s.layout === 'free') s.layout = null; })); } },
  restyle: { l: 'Reset formatting to the theme', f() { this.edit(() => sel1(this).forEach((i) => { const s = this.deck.slides[i]; s.ov = {}; s.bg = null; if (s.layout === 'free') s.layout = null; s.els = s.els.filter((e) => !e.slot); const strip = (p) => p.r.forEach((r) => { delete r.c; delete r.z; delete r.f; }); [s.title, ...s.sub, ...s.body, ...s.cols.flatMap((c) => [c.h, ...c.body])].filter(Boolean).forEach(strip); })); } },
  background: { l: 'Slide background…', k: 'Alt+B', f() { const m = colorMenu($('#b-bg') || $('#st'), typeof this.slide.bg === 'string' ? this.slide.bg : '', (c) => this.edit(() => sel1(this).forEach((i) => { this.deck.slides[i].bg = c; }))); m.prepend(h('button', { type: 'button', class: 'mi', onclick: () => { closeMenu(); this.imgTarget = 'bgImage'; $('#imgin').click(); } }, 'Picture…')); } },
  async bgImage(files) { this.imgTarget = null; const id = addMedia(this.deck, await imageBytes(files[0]), files[0].name); this.edit(() => sel1(this).forEach((i) => { this.deck.slides[i].bg = { m: 'media:' + id }; })); },
  transition: { l: 'Slide transition…', k: 'Alt+T', f() { menu(TRANS.map(([k, l]) => ({ label: l, checked: (this.slide.tr || null) === k, onclick: () => this.edit(() => sel1(this).forEach((i) => { this.deck.slides[i].tr = k; })) })).concat([{ sep: 1 }, { label: 'Apply to all slides', onclick: () => this.edit(() => this.deck.slides.forEach((s) => { s.tr = this.slide.tr; })) }]), $('#b-tr') || null, { x: innerWidth / 2, y: 120 }); } },
  slideSize: { f(w) { const d = this.deck, k = (w * d.h) / 540 / d.w; if (Math.abs(k - 1) < 1e-3) return; this.edit(() => { d.w = (w * d.h) / 540; d.slides.forEach((s) => { s.els.forEach((e) => { if (!e.slot) { e.x *= k; e.w *= k; } }); for (const o of Object.values(s.ov)) { if (o.x != null) o.x *= k; if (o.w != null) o.w *= k; } }); }); } },
  // insert
  image: { l: 'Insert picture…', k: 'Alt+I', f() { this.imgTarget = 'insertImages'; $('#imgin').click(); } },
  async insertImages(files) {
    this.imgTarget = null;
    const ids = [];
    for (const f of files) ids.push(addMedia(this.deck, await imageBytes(f), f.name));
    this.edit(() => ids.forEach((id) => this.slide.img.push({ src: 'media:' + id, alt: '' })));
    toast('Picture added. Double-click it to add alt text.');
  },
  alt: { async f(k) { k = k || this.sel[0]; const b = k && this.box(k); if (!b || b.t !== 'pic') return toast('Select a picture first'); const v = await dialog('Alt text', [{ name: 'a', label: 'Describe the picture for people who cannot see it', type: 'textarea', rows: 3, value: b.alt || '' }]); if (!v) return; this.edit(() => { const s = this.slide, m = /^img(\d+)$/.exec(k); if (m) s.img[+m[1]].alt = v.a.trim(); else setOv(this, k, { alt: v.a.trim() }); }); } },
  textbox: { l: 'Insert text box', k: 'Alt+X', f(at) { const id = uid(), d = this.deck; this.edit(() => this.slide.els.push({ id, t: 'text', x: at && at.x != null ? at.x : d.w / 2 - 150, y: at && at.y != null ? at.y : d.h / 2 - 25, w: 300, h: 50, paras: [P('Text')], base: [20], font: derive(d.theme).body, col: derive(d.theme).text, fit: 1 })); this.select([id]); this.editBox(id, true); } },
  shape: { l: 'Insert shape…', k: 'Alt+S', f() { menu(SHAPES.map(([g, l]) => ({ label: l, onclick: () => this.cmd('addShape', g) })), $('#b-shape') || null, { x: innerWidth / 2, y: 120 }); } },
  addShape: { f(g) { const th = derive(this.deck.theme), d = this.deck, id = uid(), line = g === 'line' || g === 'arrow'; this.edit(() => this.slide.els.push(line ? { id, t: 'line', g: 'line', x: d.w / 2 - 120, y: d.h / 2, w: 240, h: 0, ln: { c: th.text, w: 2, te: g === 'arrow' ? 'triangle' : 0 } } : { id, t: 'shape', g, x: d.w / 2 - 90, y: d.h / 2 - 60, w: 180, h: 120, fill: th.acc[0], font: th.body, col: th.onAcc[0], base: [18], an: 'ctr', fit: 1 })); this.select([id]); this.sw.focus(); } },
  table: {
    l: 'Insert / edit table…', k: 'Alt+G', async f() {
      const s = this.slide, cur = s.table ? s.table.map((r) => '| ' + r.map((c) => plain(c).replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n') : '| Item | Q1 | Q2 |\n| Alpha | 10 | 12 |\n| Beta | 7 | 9 |';
      const v = await dialog('Table', [{ name: 't', label: 'One row per line, cells separated by |. The first row is the header.', type: 'textarea', rows: 8, value: cur }], { width: 520 });
      if (!v) return;
      const t = parseOutline('#\n' + v.t.split('\n').map((l) => (l.trim() && l.trim()[0] !== '|' ? '| ' + l : l)).join('\n'))[0];
      this.edit(() => { s.table = t && t.table ? t.table : null; });
    },
  },
  diagram: {
    l: 'Insert / edit diagram from text…', k: 'Alt+D', async f() {
      const s = this.slide, dg = s.dg || { k: 'flow', src: DG_TPL.flow }, kind = h('select', { id: 'f_k' }, Object.entries(DIAGRAMS).map(([k, l]) => h('option', { value: k, selected: k === dg.k }, l))), ta = h('textarea', { rows: 9, spellcheck: 'false', 'aria-label': 'Diagram text' }, dg.src);
      kind.addEventListener('change', () => { if (!ta.value.trim() || Object.values(DG_TPL).includes(ta.value)) ta.value = DG_TPL[kind.value]; });
      const v = await dialog('Diagram from text', [{ type: 'html', el: h('label', { class: 'fld' }, h('span', null, 'Kind'), kind) }, { type: 'html', el: h('label', { class: 'fld' }, h('span', null, 'Flow: A -> B (x? diamond, (x) ellipse) · Org: indent children · Timeline / bar: "label: value" per line'), ta) }], { width: 560, ok: s.dg ? 'Update' : 'Insert' });
      if (!v) return;
      this.edit(() => { s.dg = ta.value.trim() ? { k: kind.value, src: ta.value.replace(/\s+$/, '') } : null; });
    },
  },
  notesFocus: { l: 'Edit speaker notes', k: 'Alt+N', f() { this.notes.focus(); } },
  convertDg: { l: 'Convert diagram / table to free shapes', f() { const s = this.slide, L = this.L; this.edit(() => { const bs = L.boxes.filter((b) => /^(dg|tbl)/.test(b.k)); bs.forEach((b) => s.els.push(boxAsEl(this, b.k))); s.dg = null; s.table = null; }); } },
  // objects
  dupObj: { l: 'Duplicate selected objects', f() { if (!needSel(this)) return; const n = this.sel.map((k) => ({ ...boxAsEl(this, k), x: this.box(k).x + 16, y: this.box(k).y + 16 })); this.edit(() => this.slide.els.push(...n)); this.select(n.map((e) => e.id)); } },
  delObj: { l: 'Delete selected objects', f() { if (!needSel(this)) return; this.edit(() => this.sel.forEach((k) => removeKey(this.slide, k))); this.sel = []; } },
  front: { l: 'Bring to front', f() { zorder(this, 1); } },
  back: { l: 'Send to back', f() { zorder(this, 0); } },
  alignL: { l: 'Align left', f() { align(this, 'l'); } }, alignC: { l: 'Align centre', f() { align(this, 'c'); } }, alignR: { l: 'Align right', f() { align(this, 'r'); } },
  alignT: { l: 'Align top', f() { align(this, 't'); } }, alignM: { l: 'Align middle', f() { align(this, 'm'); } }, alignB: { l: 'Align bottom', f() { align(this, 'b'); } },
  distH: { l: 'Distribute horizontally', f() { align(this, 'dh'); } }, distV: { l: 'Distribute vertically', f() { align(this, 'dv'); } },
  tidy: { l: 'Tidy: snap to grid, equal gaps, line up', k: 'Alt+A', f() { tidy(this); } },
  fill: { l: 'Fill colour…', f() { if (!needSel(this)) return; colorMenu($('#b-fill'), this.box(this.sel[0]).fill, (c) => fmt(this, (k) => setOv(this, k, { fill: c }))); } },
  line: { l: 'Outline colour…', f() { if (!needSel(this)) return; colorMenu($('#b-line'), '', (c) => fmt(this, (k, b) => setOv(this, k, { ln: c ? { ...(b.ln || {}), c, w: (b.ln && b.ln.w) || 1.5 } : null }))); } },
  color: { l: 'Text colour…', f() { if (!needSel(this)) return; colorMenu($('#b-color'), '', (c) => fmt(this, (k) => { runsOf(this, k).forEach((r) => { if (c) r.c = c; else delete r.c; }); setOv(this, k, { col: c || undefined }); })); } },
  bold: { l: 'Bold', k: 'Ctrl+B', f() { const v = !runsOf(this, this.sel[0] || '').every((r) => r.b); textFmt(this, (r) => { r.b = v ? 1 : undefined; }); } },
  italic: { l: 'Italic', k: 'Ctrl+I', f() { const v = !runsOf(this, this.sel[0] || '').every((r) => r.i); textFmt(this, (r) => { r.i = v ? 1 : undefined; }); } },
  underline: { l: 'Underline', k: 'Ctrl+U', f() { const v = !runsOf(this, this.sel[0] || '').every((r) => r.u); textFmt(this, (r) => { r.u = v ? 1 : undefined; }); } },
  bigger: { l: 'Larger text', k: 'Ctrl+]', f() { sizeBy(this, 1.15); } },
  smaller: { l: 'Smaller text', k: 'Ctrl+[', f() { sizeBy(this, 1 / 1.15); } },
  textL: { l: 'Align text left', k: 'Ctrl+L', f() { fmt(this, (k) => { const b = binding(this.slide, k); if (b) b.get().forEach((p) => { p.al = undefined; }); setOv(this, k, { al: undefined }); }); } },
  textC: { l: 'Centre text', k: 'Ctrl+E', f() { fmt(this, (k) => { const b = binding(this.slide, k); if (b) b.get().forEach((p) => { p.al = 'ctr'; }); }); } },
  textR: { l: 'Align text right', k: 'Ctrl+R', f() { fmt(this, (k) => { const b = binding(this.slide, k); if (b) b.get().forEach((p) => { p.al = 'r'; }); }); } },
  // panels and views
  theme: { l: 'Theme and colours…', k: 'Alt+H', f() { themePanel(this); } },
  checks: { l: 'Check deck (accessibility, overflow)…', k: 'Alt+C', f() { checksPanel(this); } },
  view: { f(v) { this.commitText(); this.view = v; $('#sorter').hidden = v !== 'sorter'; $('#center').hidden = v === 'sorter'; $('#app').classList.toggle('sorting', v === 'sorter'); this.render({ outline: false }); if (v === 'sorter') $('#sorter').focus(); } },
  sorter: { l: 'Slide sorter / editor', k: 'Alt+2', f() { this.cmd('view', this.view === 'sorter' ? 'edit' : 'sorter'); } },
  outlinePane: { l: 'Show / hide outline', k: 'Alt+1', f() { if (innerWidth <= 520) { $('#app').classList.toggle('ol-phone'); $('#app').classList.remove('no-outline'); } else $('#app').classList.toggle('no-outline'); this.render({ outline: false }); if (!$('#app').classList.contains('no-outline')) this.ol.focus(); } },
  railPane: { l: 'Show / hide slide thumbnails', k: 'Alt+3', f() { $('#app').classList.toggle('no-rail'); this.render({ outline: false }); } },
  zoomFit: { l: 'Zoom to fit', k: 'Ctrl+0', f() { this.setZoom(1); } },
  uiTheme: { l: 'Light / dark interface', f() { const r = document.documentElement, t = (r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark'; r.dataset.theme = t; try { localStorage.setItem('slidestudio-ui', t); } catch {} } },
  // presenting
  play: { l: 'Present from the start', k: 'F5', g: 1, f() { present(this, 0, false); } },
  playHere: { l: 'Present from this slide', k: 'Shift+F5', g: 1, f() { present(this, this.cur, false); } },
  presenter: { l: 'Presenter view (notes, timer, next slide)', k: 'Alt+F5', g: 1, f() { present(this, this.cur, true); } },
  // menus
  slideMenu: { f(at) { menu([{ label: 'New slide', kbd: 'Ctrl+M', onclick: () => this.cmd('newSlide') }, { label: 'Duplicate', kbd: 'Ctrl+D', onclick: () => this.cmd('dupSlide') }, { label: 'Delete', kbd: 'Del', onclick: () => this.cmd('delSlide') }, { label: this.slide.hidden ? 'Show in slide show' : 'Hide in slide show', onclick: () => this.cmd('hideSlide') }, { sep: 1 }, { label: 'Layout…', kbd: 'Alt+L', onclick: () => this.cmd('layout') }, { label: 'Background…', kbd: 'Alt+B', onclick: () => this.cmd('background') }, { label: 'Transition…', kbd: 'Alt+T', onclick: () => this.cmd('transition') }, { label: 'Reset positions', kbd: 'Alt+R', onclick: () => this.cmd('relayout') }, { label: 'Reset formatting to theme', onclick: () => this.cmd('restyle') }], null, at); } },
  boxMenu: { f(at) { if (!this.sel.length) return this.cmd('slideMenu', at); const b = this.box(this.sel[0]); menu([b && b.t === 'pic' ? { label: 'Alt text…', onclick: () => this.cmd('alt') } : { label: 'Edit', kbd: 'Enter', onclick: () => this.editBox(this.sel[0]) }, { label: 'Fill colour…', onclick: () => this.cmd('fill') }, { label: 'Outline colour…', onclick: () => this.cmd('line') }, { label: 'Text colour…', onclick: () => this.cmd('color') }, { sep: 1 }, { label: 'Bring to front', onclick: () => this.cmd('front') }, { label: 'Send to back', onclick: () => this.cmd('back') }, { label: 'Duplicate', onclick: () => this.cmd('dupObj') }, { label: 'Delete', kbd: 'Del', onclick: () => this.cmd('delObj') }, { sep: 1 }, { label: 'Reset positions', onclick: () => this.cmd('relayout') }], null, at); } },
  outlinePaste(e) {
    const it = [...e.clipboardData.items].find((x) => /^image\//.test(x.type));
    if (it) { e.preventDefault(); imageBytes(it.getAsFile()).then((b) => { const id = addMedia(this.deck, b, 'pasted'); this.ol.setRangeText(`\n![](media:${id})\n`, this.ol.selectionStart, this.ol.selectionEnd, 'end'); this.ol.dispatchEvent(new Event('input')); }); return; }
    let t = e.clipboardData.getData('text/plain');
    if (!t) return;
    e.preventDefault();
    const whole = !this.ol.value.trim() || (this.ol.selectionStart === 0 && this.ol.selectionEnd === this.ol.value.length);
    if (whole && t.includes('\n')) t = normalizeMd(t);
    this.ol.setRangeText(extractDataUrls(t.replace(/\r\n?/g, '\n'), this.deck), this.ol.selectionStart, this.ol.selectionEnd, 'end');
    this.ol.dispatchEvent(new Event('input'));
  },
};

// ---------- clipboard between decks: JSON rides along in text/html ----------
function onCopy(app, e, cut) {
  if (e.target.closest && e.target.closest('input,textarea,[contenteditable=true]')) return;
  let data, txt;
  if (app.sel.length && app.view === 'edit' && !app.rail.contains(document.activeElement)) {
    const list = app.sel.map((k) => boxAsEl(app, k));
    data = { els: list }; txt = list.map((b) => (b.paras || []).map(plain).join('\n')).join('\n');
  } else { const sl = sel1(app).map((i) => app.deck.slides[i]); data = { slides: sl }; txt = sl.map(slideMd).join('\n\n'); }
  data.media = mediaOf(app, data);
  const b64 = bytesToB64(new TextEncoder().encode(JSON.stringify(data)));
  e.clipboardData.setData('text/plain', txt);
  e.clipboardData.setData('text/html', `<meta charset="utf-8"><!--slidestudio:${b64}--><pre>${E(txt)}</pre>`);
  e.preventDefault();
  if (cut) app.cmd(data.els ? 'delObj' : 'delSlide');
}
function onPaste(app, e) {
  if (e.target.closest && e.target.closest('input,textarea,[contenteditable=true]')) return;
  e.preventDefault();
  const html = e.clipboardData.getData('text/html'), m = /<!--slidestudio:([A-Za-z0-9+/=]+)-->/.exec(html);
  if (m) {
    const data = JSON.parse(new TextDecoder().decode(b64ToBytes(m[1])));
    Object.assign(app.deck.media, data.media || {});
    if (data.slides) { const at = app.cur + 1; app.edit(() => { app.deck.slides.splice(at, 0, ...data.slides.map(freshIds)); app.cur = at; app.rsel = new Set(data.slides.map((_, k) => at + k)); }); app.scrollRail(); }
    else { const n = data.els.map((x) => ({ ...x, id: uid(), x: x.x + 12, y: x.y + 12 })); app.edit(() => app.slide.els.push(...n)); app.select(n.map((x) => x.id)); }
    return;
  }
  const files = [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
  if (files.length) return app.cmd('insertImages', files);
  const t = e.clipboardData.getData('text/plain');
  if (!t) return;
  if (t.trim().includes('\n')) { const sl = parseOutline(extractDataUrls(normalizeMd(t), app.deck)), at = app.cur + 1; app.edit(() => { app.deck.slides.splice(at, 0, ...sl); app.cur = at; }); toast(`Pasted ${sl.length} slide${sl.length > 1 ? 's' : ''} from text`); app.scrollRail(); }
  else { app.cmd('textbox'); const ed = app.editing; if (ed) { ed.el.textContent = t.trim(); app.commitText(); } }
}

// ---------- keyboard ----------
const KEYS = {};
for (const [id, c] of Object.entries(CMD)) if (c.k) KEYS[c.k] = id;
function onKey(app, e) {
  if (app.presenting || document.querySelector('.modal-back')) return;
  const t = e.target, typing = t.closest && !!t.closest('input,textarea,select,[contenteditable=true]');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const combo = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && (e.key.length > 1 || e.ctrlKey || e.altKey) ? 'Shift+' : '') + key;
  const id = KEYS[combo];
  const onStage = app.sw.contains(t), onList = app.rail.contains(t) || $('#sorter').contains(t);
  if (id && (!typing || CMD[id].g) && !(id === 'selectAll' && !onStage) && !(/^(text[LCR]|bold|italic|underline|bigger|smaller)$/.test(id) && !app.sel.length)) { e.preventDefault(); closeMenu(); app.cmd(id); return; }
  if (typing) return;
  if (onStage && app.sel.length) {
    const step = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv && !e.ctrlKey) { e.preventDefault(); app.edit(() => app.sel.forEach((k) => { const b = app.box(k); app.setGeom(app.slide, k, { x: b.x + mv[0], y: b.y + mv[1] }); }), { tag: 'nudge' }); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return app.cmd('delObj'); }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); return app.editBox(app.sel[0]); }
    if (e.key === 'Escape') return app.select([]);
  }
  if (onStage && e.key === 'Tab') { e.preventDefault(); const ks = app.L.boxes.filter((b) => app.movable(b.k) && !b.d).map((b) => b.k); if (ks.length) { const i = ks.indexOf(app.sel[0]); app.select([ks[i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + ks.length) % ks.length]]); } return; }
  if (onList || (onStage && !app.sel.length)) {
    const cols = app.view === 'sorter' ? Math.max(1, Math.floor(($('#sorter').clientWidth - 12) / 236)) : 1;
    const d = { ArrowUp: -cols, ArrowDown: cols, ArrowLeft: -1, ArrowRight: 1, Home: -1e9, End: 1e9 }[e.key];
    if (d != null) {
      e.preventDefault();
      const n = clampI(app.cur + d, app.deck.slides.length);
      if (e.shiftKey) { app.rsel.add(n); app.cur = n; app.render({ outline: false }); app.scrollRail(); } else app.go(n);
      return;
    }
    if (onList && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); return app.cmd('delSlide'); }
    if (onList && e.key === 'Enter') { e.preventDefault(); if (app.view === 'sorter') app.cmd('view', 'edit'); app.sw.focus(); }
  }
}
const clampI = (v, n) => Math.max(0, Math.min(n - 1, v));

// ---------- toolbar ----------
function toolbar(app) {
  const B = (id, label, title, ico) => h('button', { type: 'button', class: 'rb', id: 'b-' + id, title: title || (CMD[id] && CMD[id].l + (CMD[id].k ? ` (${CMD[id].k})` : '')), 'aria-label': (CMD[id] && CMD[id].l) || label, onmousedown: (e) => e.preventDefault(), onclick: () => app.cmd(id) }, ico ? h('span', { class: 'ic', 'aria-hidden': 'true' }, ico) : null, label);
  const M = (label, items, title) => { const b = h('button', { type: 'button', class: 'rb', title: title || label, 'aria-haspopup': 'menu', onclick: () => menu(items().map((x) => (x.sep ? x : typeof x === 'string' ? { label: CMD[x].l, kbd: CMD[x].k, onclick: () => app.cmd(x) } : x)), b) }, label + ' ▾'); return b; };
  const G = (...k) => h('div', { class: 'grp' }, ...k);
  $('#bar').replaceChildren(
    G(M('File', () => ['new', 'open', 'save', 'saveAs', { sep: 1 }, 'exportPptx', 'exportNative', 'exportHtml', 'exportMd', 'print', 'png', 'pngAll'])),
    G(B('undo', '', null, '↶'), B('redo', '', null, '↷')),
    G(B('newSlide', 'Slide', null, '+'), B('layout', 'Layout'), M('Insert', () => ['image', 'textbox', 'shape', 'table', 'diagram', 'convertDg', 'notesFocus'])),
    G(B('theme', 'Theme', null, '◑'), B('background', 'Background'), B('transition', 'Transition')),
    G(B('fill', '', 'Fill colour', '▇'), B('line', '', 'Outline colour', '▢'), B('color', '', 'Text colour', 'A'), B('bold', '', null, 'B'), B('italic', '', null, 'I'), B('smaller', '', null, 'A−'), B('bigger', '', null, 'A+')),
    G(M('Arrange', () => ['tidy', { sep: 1 }, 'alignL', 'alignC', 'alignR', 'alignT', 'alignM', 'alignB', 'distH', 'distV', { sep: 1 }, 'front', 'back', 'dupObj', 'delObj', 'relayout']), B('tidy', 'Tidy')),
    G(B('checks', 'Check'), B('find', '', null, '⌕')),
    G(M('View', () => ['outlinePane', 'railPane', 'sorter', 'zoomFit', 'uiTheme', 'shortcuts']), M('Present', () => ['play', 'playHere', 'presenter'])),
  );
}

App.prototype.cmd = function (name, ...a) {
  const c = CMD[name];
  try {
    const r = (typeof c === 'function' ? c : c.f).apply(this, a);
    if (r && r.catch) r.catch((e) => { console.error(e); toast('Something went wrong: ' + e.message, 6000); });
    return r;
  } catch (e) { console.error(e); toast('Something went wrong: ' + e.message, 6000); }
};
export function boot() {
  const app = new App();
  toolbar(app);
  addEventListener('keydown', (e) => onKey(app, e));
  document.addEventListener('copy', (e) => onCopy(app, e, false));
  document.addEventListener('cut', (e) => onCopy(app, e, true));
  document.addEventListener('paste', (e) => onPaste(app, e));
  $('#b-pal').addEventListener('click', () => app.cmd('palette'));
  $('#b-ui').addEventListener('click', () => app.cmd('uiTheme'));
  $('#b-play').addEventListener('click', () => app.cmd('playHere'));
  $('#b-chk').addEventListener('click', () => app.cmd('checks'));
  $('#b-prev').addEventListener('click', () => app.go(app.cur - 1));
  $('#b-next').addEventListener('click', () => app.go(app.cur + 1));
  if (innerWidth < 900) $('#app').classList.add('no-outline');
  window.slideStudio = app;
  return app;
}

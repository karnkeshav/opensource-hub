// Application shell: document lifecycle, page rendering, selection, search, tools and object editing.
import { $, h, icon, toast, dialog, menu, download, readFile, hex, rgb01, promptDlg, confirmDlg } from './util.js';
import { PDFDoc } from '../pdf/doc.js';
import { saveFull, saveIncremental } from '../pdf/writer.js';
import { Interp, pageMatrix } from '../pdf/interp.js';
import { CanvasDevice } from '../pdf/canvas.js';
import { analyze, layout, findAll, charRects } from '../pdf/text.js';
import { mmul, apply, inv, normRect, Dict, Ref, textOf } from '../pdf/obj.js';
import * as A from '../pdf/annots.js';
import * as F from '../pdf/forms.js';
import * as E from '../pdf/edit.js';
import { newDoc, addPage } from '../pdf/edit.js';
import { getMeta } from '../pdf/nav.js';
import { recovery } from './store.js';

const PT = 96 / 72;
export const COLORS = ['#ffd400', '#5fd068', '#4ab3ff', '#ff6b9a', '#ff8a1f', '#e02020', '#2050e0', '#111111'];
const TOOLS = [
  ['select', 'Select', 'select', 'V'], ['hand', 'Hand', 'hand', 'H'], ['markup', 'Highlight', 'highlight', 'U'], ['note', 'Comment', 'note', 'N'],
  ['draw', 'Draw', 'draw', 'D'], ['text', 'Text', 'text', 'T'], ['sign', 'Sign', 'sign', 'S'], ['redact', 'Redact', 'redact', 'R'],
];

export class App {
  constructor() {
    this.doc = null; this.name = ''; this.zoom = 1; this.fit = 'width'; this.mode = 'continuous'; this.rot = 0;
    this.tool = 'select';
    this.sub = { markup: 'Highlight', note: 'Text', draw: 'Ink', text: 'FreeText', redact: 'area' };
    this.st = { color: { markup: '#ffd400', note: '#ffd400', draw: '#e02020', text: '#111111' }, width: 2, opacity: 1, fontSize: 14, stamp: 'APPROVED' };
    this.views = []; this.texts = new Map(); this.objsCache = new Map(); this.sel = null; this.selAnnot = null; this.selObj = null;
    this.cur = 0; this.hits = []; this.hitIdx = -1; this.commands = [];
    this.signature = null; this.author = localStorage.getItem('pdfs-author') || 'Me';
    this.renderQ = []; this.rendering = 0;
  }
  // ---------------------------------------------------------------- setup
  init() {
    const theme = localStorage.getItem('pdfs-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    this.app = $('#app'); this.view = $('#view'); this.pagesEl = $('#pages');
    const tb = $('#tools');
    for (const [id, label, ic, key] of TOOLS) tb.append(h('button', { class: 'tb', type: 'button', 'data-t': id, 'aria-pressed': String(id === this.tool), title: `${label} (${key})`, 'aria-label': label, onclick: () => this.setTool(id) }, icon(ic), h('span', { class: 'tl' }, label)));
    const ib = (id, ic, fn) => { const b = $(id); b.append(icon(ic)); b.addEventListener('click', fn); };
    ib('#b-side', 'side', () => this.toggleSide()); ib('#b-find', 'find', () => this.openFind()); ib('#b-org', 'org', () => this.toggleOrganizer());
    ib('#b-save', 'save', () => this.save()); ib('#b-theme', 'theme', () => this.toggleTheme());
    $('.ci').append(icon('cmd', 16)); $('#b-cmd').addEventListener('click', () => this.palette());
    ib('#p-prev', 'prev', () => this.goto(this.cur - 1)); ib('#p-next', 'next', () => this.goto(this.cur + 1));
    ib('#z-out', 'minus', () => this.setZoom(this.zoom / 1.2)); ib('#z-in', 'plus', () => this.setZoom(this.zoom * 1.2));
    ib('#q-prev', 'up', () => this.nextHit(-1)); ib('#q-next', 'down', () => this.nextHit(1)); ib('#q-close', 'close', () => this.closeFind());
    $('#zv').addEventListener('click', (e) => menu([
      { label: 'Fit width', onclick: () => this.setFit('width'), checked: this.fit === 'width' }, { label: 'Fit page', onclick: () => this.setFit('page'), checked: this.fit === 'page' },
      { sep: 1 }, ...[50, 75, 100, 125, 150, 200, 300, 400].map((z) => ({ label: z + '%', onclick: () => this.setZoom(z / 100) })),
      { sep: 1 }, { label: 'Continuous', checked: this.mode === 'continuous', onclick: () => this.setMode('continuous') }, { label: 'Single page', checked: this.mode === 'single', onclick: () => this.setMode('single') }, { label: 'Two pages', checked: this.mode === 'two', onclick: () => this.setMode('two') },
    ], e.currentTarget));
    $('#pnum').addEventListener('change', (e) => this.gotoLabel(e.target.value));
    $('#b-open').addEventListener('click', () => this.openDialog());
    $('#b-new').addEventListener('click', () => this.newBlank());
    $('#b-imgs').addEventListener('click', () => this.run('images-to-pdf'));
    $('#filein').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) this.openFile(f); e.target.value = ''; });
    let q = 0;
    $('#q').addEventListener('input', () => { clearTimeout(q); q = setTimeout(() => this.search(), 220); });
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.nextHit(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') this.closeFind(); });
    for (const id of ['#q-case', '#q-word']) $(id).addEventListener('change', () => this.search());
    document.querySelectorAll('.stabs button').forEach((b) => b.addEventListener('click', () => this.panel(b.dataset.p)));
    // drag & drop
    const app = this.app;
    addEventListener('dragover', (e) => { e.preventDefault(); app.classList.add('dragover'); });
    addEventListener('dragleave', (e) => { if (!e.relatedTarget) app.classList.remove('dragover'); });
    addEventListener('drop', (e) => {
      e.preventDefault(); app.classList.remove('dragover');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      const imgs = files.filter((f) => /^image\//.test(f.type));
      if (this.doc && pdfs.length && !this.organizer) return this.run('merge-files', pdfs);
      if (pdfs.length) return this.openFile(pdfs[0]);
      if (imgs.length) return this.run('images-to-pdf', imgs);
    });
    addEventListener('keydown', (e) => this.key(e));
    addEventListener('beforeunload', (e) => { if (this.doc && this.doc.dirty) { e.preventDefault(); e.returnValue = ''; } });
    addEventListener('resize', () => { if (this.fit) this.layout(true); });
    addEventListener('copy', (e) => { const t = this.selectedText(); if (t && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.clipboardData.setData('text/plain', t); e.preventDefault(); toast('Copied ' + t.length + ' characters'); } });
    this.view.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.view.addEventListener('wheel', (e) => { if (e.ctrlKey && this.doc) { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
    this.bindPointer();
    this.obs = new IntersectionObserver((ents) => { for (const en of ents) { const v = this.views[+en.target.dataset.i]; if (!v) continue; v.visible = en.isIntersecting; if (en.isIntersecting) this.queue(v.i); } }, { root: this.view, rootMargin: '600px 0px' });
    this.updateCtx();
    recovery.offer(this);
  }
  // ---------------------------------------------------------------- open / save
  openDialog() { $('#filein').click(); }
  async openFile(f) { await this.openBytes(await readFile(f), f.name, undefined, f); }
  async openBytes(bytes, name, password, file) {
    if (this.doc && this.doc.dirty && password === undefined && !(await confirmDlg('Discard changes?', `"${this.name}" has unsaved changes. Open "${name}" anyway?`, 'Discard and open'))) return;
    const t0 = performance.now();
    let doc;
    try { doc = await PDFDoc.load(bytes, password); }
    catch (e) {
      if (e.code === 'password') {
        const pw = await promptDlg('Password required', (e.retry ? 'Incorrect password. ' : '') + `"${name}" is protected. Enter the password to open it.`, '', { type: 'password', ok: 'Open' });
        if (pw === null) return;
        return this.openBytes(bytes, name, pw, file);
      }
      toast('Could not open: ' + e.message, 6000); return;
    }
    this.setDoc(doc, name, file);
    this.password = password;
    this.loadMs = performance.now() - t0;
    if (doc.repaired) toast('The file was damaged and has been repaired while opening.');
    else if (doc.sec) toast('Opened an encrypted document' + (doc.sec.owner ? ' (owner)' : '') + '.');
  }
  setDoc(doc, name, file) {
    this.doc = doc; this.name = name || 'document.pdf'; this.file = file || null; this.handle = null;
    this.texts.clear(); this.objsCache.clear(); this.sel = null; this.selAnnot = null; this.selObj = null; this.hits = []; this.searchCache = null;
    this.app.classList.remove('empty');
    $('#fname').textContent = this.name; $('#fname').title = this.name;
    doc.listeners.add((label) => this.onChange(label));
    this.fp = this.name + ':' + doc.bytes.length + ':' + doc.pageCount;
    let pos = null; try { pos = JSON.parse(localStorage.getItem('pdfs-pos:' + this.fp) || 'null'); } catch {}
    if (pos) { this.zoom = pos.zoom || 1; this.fit = pos.fit ?? 'width'; }
    this.layout();
    if (pos && pos.page) requestAnimationFrame(() => this.goto(pos.page, pos.y));
    this.panel(this.curPanel || 'thumbs');
    this.markDirty();
    document.title = this.name + ' - PDFStudio';
    const meta = getMeta(doc);
    if (meta.Title) $('#fname').title = meta.Title;
    this.organizer && this.renderOrganizer();
  }
  newBlank() { const d = newDoc(); d.edit('blank', () => addPage(d)); d.dirty = false; this.setDoc(d, 'Untitled.pdf'); }
  isSigned() {
    const af = this.doc && this.doc.get(this.doc.catalog.get('AcroForm'));
    if (!(af instanceof Dict)) return false;
    return (this.doc.get(af.get('SigFlags')) | 0) & 1 ? F.fields(this.doc).some((f) => f.type === 'signature' && this.doc.get(this.doc.get(f.ref).get('V'))) : false;
  }
  async bytesForSave(opts = {}) {
    const d = this.doc;
    const incremental = opts.incremental ?? (!d.needsFullSave && d.bytes.length > 0 && (this.isSigned() || opts.preferIncremental));
    if (incremental && !opts.security) return saveIncremental(d);
    let sec = opts.security;
    if (sec === undefined && d.sec && !opts.decrypt) {
      const { newAES256 } = await import('../pdf/security.js');
      sec = await newAES256(this.password || '', null, d.sec.permissions);
    }
    return saveFull(d, { objStreams: opts.objStreams ?? true, security: sec || null, compress: true });
  }
  async save(as = false, opts = {}) {
    if (!this.doc) return this.openDialog();
    try {
      this.msg('Saving…');
      const bytes = await this.bytesForSave(opts);
      let name = this.name.replace(/\.pdf$/i, '') + '.pdf';
      if ('showSaveFilePicker' in window) {
        try {
          if (!this.handle || as) this.handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
          const w = await this.handle.createWritable(); await w.write(bytes); await w.close();
          name = this.handle.name;
        } catch (e) { if (e.name === 'AbortError') { this.msg(''); return; } download(name, bytes, 'application/pdf'); }
      } else download(name, bytes, 'application/pdf');
      this.doc.dirty = false; this.markDirty(); recovery.clear();
      toast(`Saved ${name} (${(bytes.length / 1024).toFixed(1)} KB)`);
      this.msg('');
      return bytes;
    } catch (e) { toast('Save failed: ' + e.message, 6000); console.error(e); }
  }
  markDirty() { $('#dirty').classList.toggle('on', !!(this.doc && this.doc.dirty)); $('#dirty').title = this.doc && this.doc.dirty ? 'Unsaved changes' : ''; }
  msg(t) { $('#msg').textContent = t || ''; }
  // ---------------------------------------------------------------- edits
  // Run an edit as one undo step and refresh the affected pages.
  async edit(label, fn, pages) {
    if (!this.doc) return;
    let r;
    try { r = await this.doc.edit(label, fn); } catch (e) { toast(e.message || String(e), 6000); console.error(e); return; }
    this.refresh(pages);
    return r;
  }
  onChange(label) {
    this.markDirty();
    recovery.schedule(this);
    if (label === 'undo' || label === 'redo') this.refresh();
  }
  refresh(pages) {
    const n = this.doc.pageCount;
    if (n !== this.views.length || !pages) { this.texts.clear(); this.objsCache.clear(); this.layout(true); }
    else for (const i of pages) { this.texts.delete(i); this.objsCache.delete(i); const v = this.views[i]; if (v) { v.dirty = true; if (v.visible) this.queue(i); } this.thumbDirty(i); }
    this.selAnnot = null; this.selObj = null; this.drawOverlay();
    this.panelRefresh();
    this.organizer && this.renderOrganizer();
  }
  undo() { if (!this.doc) return; const l = this.doc.undo(); toast(l ? 'Undid ' + l : 'Nothing to undo'); }
  redo() { if (!this.doc) return; const l = this.doc.redo(); toast(l ? 'Redid ' + l : 'Nothing to redo'); }
  // ---------------------------------------------------------------- layout & rendering
  scale() { return this.zoom * PT; }
  pageSize(i) { const p = this.doc.pages[i]; const [w, h] = p.size; return this.rot % 180 ? [h, w] : [w, h]; }
  layout(keep) {
    const d = this.doc; if (!d) return;
    const cur = this.cur;
    if (this.fit) {
      const W = this.view.clientWidth - 40, H = this.view.clientHeight - 36;
      const [pw, ph] = this.pageSize(Math.min(cur, d.pageCount - 1));
      const cols = this.mode === 'two' ? 2 : 1;
      this.zoom = this.fit === 'width' ? (W / cols - 14) / (pw * PT) : Math.min((W / cols - 14) / (pw * PT), H / (ph * PT));
      this.zoom = Math.max(0.1, Math.min(8, this.zoom));
    }
    $('#zv').textContent = Math.round(this.zoom * 100) + '%';
    this.obs.disconnect();
    for (const v of this.views) v.cv && (v.cv.width = 0);
    this.pagesEl.innerHTML = '';
    this.pagesEl.className = 'pages ' + this.mode;
    const labels = this.labels();
    this.views = d.pages.map((p, i) => {
      const [w, hh] = this.pageSize(i), s = this.scale();
      const el = h('div', { class: 'pg' + (i === cur ? ' cur' : ''), 'data-i': i, style: { width: w * s + 'px', height: hh * s + 'px' }, role: 'img', 'aria-label': 'Page ' + labels[i] },
        h('div', { class: 'ov' }), h('span', { class: 'lbl' }, labels[i]));
      this.pagesEl.append(el);
      this.obs.observe(el);
      return { i, el, ov: el.firstChild, w, h: hh, dirty: true, visible: false };
    });
    $('#pcount').textContent = '/ ' + d.pageCount;
    if (!keep) this.cur = 0;
    if (keep) requestAnimationFrame(() => this.goto(cur, null, true));
    this.drawOverlay();
    this.thumbsBuilt = false;
    if (this.curPanel === 'thumbs') this.panel('thumbs');
  }
  setZoom(z) { if (!this.doc) return; const keep = this.cur; this.fit = null; this.zoom = Math.max(0.1, Math.min(8, z)); this.cur = keep; this.layout(true); this.savePos(); }
  setFit(f) { this.fit = f; this.layout(true); this.savePos(); }
  setMode(m) { this.mode = m; if (m === 'single') this.fit = this.fit || 'page'; this.layout(true); }
  rotateView(d) { this.rot = (this.rot + d + 360) % 360; this.layout(true); }
  queue(i) { if (!this.renderQ.includes(i)) this.renderQ.push(i); this.pump(); }
  async pump() {
    while (this.rendering < 2 && this.renderQ.length) {
      // render the closest pages first
      this.renderQ.sort((a, b) => Math.abs(a - this.cur) - Math.abs(b - this.cur));
      const i = this.renderQ.shift();
      const v = this.views[i];
      if (!v || !v.visible || !v.dirty) continue;
      this.rendering++;
      this.renderPage(v).catch((e) => console.error(e)).finally(() => { this.rendering--; this.pump(); });
    }
  }
  async renderPage(v) {
    const doc = this.doc, page = doc.pages[v.i];
    if (!page) return;
    v.dirty = false;
    const dpr = Math.min(3, devicePixelRatio || 1), s = this.scale() * dpr;
    let W = Math.round(v.w * s), H = Math.round(v.h * s);
    const maxPx = 16e6; let k = 1;
    if (W * H > maxPx) { k = Math.sqrt(maxPx / (W * H)); W = Math.round(W * k); H = Math.round(H * k); }
    const cv = h('canvas', { class: 'c', width: W, height: H });
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const base = pageMatrix(page, s * k, this.rot);
    v.abort && v.abort.abort();
    const ac = new AbortController(); v.abort = ac;
    const t0 = performance.now();
    const hide = this.formMode ? (a) => this.doc.get(a.get('Subtype'))?.n === 'Widget' && this.fieldOverlay(a) : null;
    const it = new Interp(doc, new CanvasDevice(ctx, base), { signal: ac.signal, hideAnnot: hide });
    try { await it.page(page); } catch (e) { if (e.name === 'AbortError') { v.dirty = true; return; } it.warn.add(e.message); }
    if (ac.signal.aborted) { v.dirty = true; return; }
    v.ms = performance.now() - t0;
    const old = v.el.querySelector('canvas.c');
    if (old) { old.width = 0; old.remove(); }
    v.el.prepend(cv); v.cv = cv;
    if (it.warn.size) { v.warn = [...it.warn]; if (v.i === this.cur) this.msg(v.warn[0]); }
    this.drawFields(v);
    // keep memory bounded: drop canvases far from the viewport
    const keep = 12;
    const rendered = this.views.filter((x) => x.cv && !x.visible);
    if (rendered.length > keep) for (const x of rendered.sort((a, b) => Math.abs(b.i - this.cur) - Math.abs(a.i - this.cur)).slice(0, rendered.length - keep)) { x.cv.width = 0; x.cv.remove(); x.cv = null; x.dirty = true; }
  }
  // CSS px <-> PDF user space for a page view
  m(i) { return pageMatrix(this.doc.pages[i], this.scale(), this.rot); }
  toUser(i, cx, cy) { const r = this.views[i].el.getBoundingClientRect(); return apply(inv(this.m(i)), cx - r.left, cy - r.top); }
  toCss(i, x, y) { return apply(this.m(i), x, y); }
  cssRect(i, r) { const a = this.toCss(i, r[0], r[1]), b = this.toCss(i, r[2], r[3]); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
  labels() { if (!this._labels || this._labelsDoc !== this.doc) { try { this._labels = (this.navMod && this.navMod.pageLabels(this.doc)) || null; } catch { this._labels = null; } this._labelsDoc = this.doc; } return this._labels || this.doc.pages.map((_, i) => String(i + 1)); }
  onScroll() {
    if (!this.doc || !this.views.length) return;
    const top = this.view.scrollTop + this.view.clientHeight * 0.35;
    let best = this.cur;
    if (this.mode !== 'single') for (const v of this.views) { const o = v.el.offsetTop; if (o <= top) best = v.i; else break; }
    if (best !== this.cur) { this.setCur(best); }
    clearTimeout(this.posT); this.posT = setTimeout(() => this.savePos(), 400);
  }
  setCur(i) {
    this.views[this.cur]?.el.classList.remove('cur');
    this.cur = i; this.views[i]?.el.classList.add('cur');
    $('#pnum').value = this.labels()[i] || i + 1;
    document.querySelectorAll('.thumb[aria-current]').forEach((t) => t.removeAttribute('aria-current'));
    const t = document.querySelector(`.thumb[data-i="${i}"]`);
    if (t) { t.setAttribute('aria-current', 'true'); if (this.curPanel === 'thumbs') t.scrollIntoView({ block: 'nearest' }); }
    if (this.views[i]?.warn) this.msg(this.views[i].warn[0]); else this.msg('');
  }
  savePos() { if (!this.fp) return; try { localStorage.setItem('pdfs-pos:' + this.fp, JSON.stringify({ page: this.cur, zoom: this.zoom, fit: this.fit, y: this.view.scrollTop - (this.views[this.cur]?.el.offsetTop || 0) })); } catch {} }
  goto(i, y, instant) {
    if (!this.doc) return;
    i = Math.max(0, Math.min(this.doc.pageCount - 1, i | 0));
    this.setCur(i);
    const v = this.views[i]; if (!v) return;
    if (this.mode === 'single') { this.view.scrollTop = 0; this.queue(i); v.visible = true; return; }
    let top = v.el.offsetTop - 12;
    if (typeof y === 'number' && y > 0 && instant) top += y;
    else if (typeof y === 'number' && y !== null && !instant) { const p = this.toCss(i, 0, y); top = v.el.offsetTop + p[1] - 40; }
    this.view.scrollTo({ top, behavior: instant ? 'auto' : 'auto' });
  }
  gotoLabel(s) {
    const L = this.labels(), k = L.indexOf(String(s).trim());
    this.goto(k >= 0 ? k : (parseInt(s, 10) || 1) - 1);
  }
  // ---------------------------------------------------------------- text
  async text(i) {
    if (!this.texts.has(i)) this.texts.set(i, analyze(this.doc, this.doc.pages[i]).then((a) => ({ ...a, lay: layout(a.chars) })));
    return this.texts.get(i);
  }
  selectedText() {
    const s = this.sel; if (!s) return '';
    const t = this.texts.get(s.page); if (!t || !t._v) return '';
    const [a, b] = s.a <= s.b ? [s.a, s.b] : [s.b, s.a];
    const L = t._v.lay;
    const i0 = L.map.indexOf(a), i1 = L.map.lastIndexOf(b);
    return i0 >= 0 && i1 >= 0 ? L.text.slice(i0, i1 + 1) : '';
  }
  async textNow(i) { const t = await this.text(i); const p = this.texts.get(i); if (p) p._v = t; return t; }
  nearestChar(t, x, y) {
    let best = -1, bd = Infinity;
    t.chars.forEach((c, k) => {
      const b = c.b;
      const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0, dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < bd) { bd = d; best = k; }
    });
    return { k: best, d: Math.sqrt(bd) };
  }
  // ---------------------------------------------------------------- overlay drawing
  drawOverlay() {
    for (const v of this.views) {
      if (!v.ovDirty && !v.ov.childElementCount && !this.sel && !this.hits.length) continue;
      v.ov.querySelectorAll('.hl,.hit,.sbox,.redmark').forEach((e) => e.remove());
    }
    const s = this.sel;
    if (s && this.views[s.page]) {
      const t = this.texts.get(s.page)?._v;
      if (t) {
        const [a, b] = s.a <= s.b ? [s.a, s.b] : [s.b, s.a];
        const idx = []; for (let k = a; k <= b; k++) idx.push(k);
        for (const r of charRects(t.chars, idx)) this.box(s.page, r, 'hl');
      }
    }
    this.hits.forEach((hh, k) => { if (this.views[hh.page]) for (const r of hh.rects) this.box(hh.page, r, 'hit' + (k === this.hitIdx ? ' cur' : '')); });
    if (this.selAnnot) this.drawSelBox(this.selAnnot.page, this.selAnnot.rect);
    if (this.selObj) this.drawSelBox(this.selObj.page, this.selObj.bbox);
  }
  box(i, r, cls) {
    const c = this.cssRect(i, r);
    const e = h('div', { class: cls, style: { left: c[0] + 'px', top: c[1] + 'px', width: c[2] - c[0] + 'px', height: c[3] - c[1] + 'px' } });
    this.views[i].ov.append(e);
    return e;
  }
  drawSelBox(i, r) {
    const b = this.box(i, r, 'sbox');
    for (const [k, x, y] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1], ['n', 0.5, 0], ['s', 0.5, 1], ['w', 0, 0.5], ['e', 1, 0.5]]) {
      b.append(h('div', { class: 'h', 'data-h': k, style: { left: `calc(${x * 100}% - 5px)`, top: `calc(${y * 100}% - 5px)`, cursor: k + '-resize' } }));
    }
  }
  // ---------------------------------------------------------------- tools
  setTool(t) {
    this.tool = t;
    document.querySelectorAll('.tb').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
    this.view.classList.toggle('hand', t === 'hand');
    this.view.classList.toggle('cross', ['draw', 'note', 'redact', 'sign'].includes(t) || (t === 'text' && this.sub.text !== 'edit'));
    this.view.classList.toggle('textc', t === 'markup' || t === 'select' || (t === 'text' && this.sub.text === 'edit'));
    if (t !== 'select') { this.selAnnot = null; this.selObj = null; this.drawOverlay(); }
    this.updateCtx();
    if (t === 'redact') this.showRedactMarks();
    if (t === 'sign' && !this.signature) this.run('create-signature');
  }
  updateCtx() { this.ctxBuilder && this.ctxBuilder(this); }
  key(e) {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); return this.palette(); }
    if (document.querySelector('.modal-back,.pal')) return;
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); return this.openDialog(); }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return this.save(e.shiftKey); }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); return this.openFind(); }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); return this.run('print'); }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return this.redo(); }
    if (mod && e.key.toLowerCase() === 'a' && this.doc) { e.preventDefault(); this.textNow(this.cur).then((t) => { if (t.chars.length) { this.sel = { page: this.cur, a: 0, b: t.chars.length - 1 }; this.drawOverlay(); this.updateCtx(); } }); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); return this.setZoom(this.zoom * 1.2); }
    if (mod && e.key === '-') { e.preventDefault(); return this.setZoom(this.zoom / 1.2); }
    if (mod && e.key === '0') { e.preventDefault(); return this.setFit('width'); }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selAnnot || this.selObj)) { e.preventDefault(); return this.deleteSelected(); }
    if (e.key === 'Escape') { this.sel = null; this.selAnnot = null; this.selObj = null; this.drawOverlay(); this.updateCtx(); this.cancelPoly?.(); return; }
    if (e.key === 'F4') { e.preventDefault(); return this.toggleSide(); }
    if (e.key === 'F11' && this.doc) { e.preventDefault(); return this.run('read-mode'); }
    if (!this.doc) return;
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && this.mode !== 'continuous') || (e.key === ' ' && this.mode === 'single')) { e.preventDefault(); return this.goto(this.cur + 1); }
    if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && this.mode !== 'continuous')) { e.preventDefault(); return this.goto(this.cur - 1); }
    if (e.key === 'Home') { e.preventDefault(); return this.goto(0); }
    if (e.key === 'End') { e.preventDefault(); return this.goto(this.doc.pageCount - 1); }
    const t = TOOLS.find((x) => x[3].toLowerCase() === e.key.toLowerCase());
    if (t) { this.setTool(t[0]); }
  }
  pageAt(e) { const el = e.target.closest && e.target.closest('.pg'); return el ? +el.dataset.i : -1; }
  bindPointer() {
    const view = this.view;
    let drag = null;
    view.addEventListener('pointerdown', async (e) => {
      if (e.button !== 0 || !this.doc) return;
      if (e.target.closest('.fw,.pop,.edit-ta')) return;
      const i = this.pageAt(e);
      if (this.tool === 'hand' || (i < 0 && this.tool === 'select')) {
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop }; view.classList.add('drag'); view.setPointerCapture(e.pointerId); return;
      }
      if (i < 0) return;
      if (i !== this.cur) this.setCur(i);
      const [x, y] = this.toUser(i, e.clientX, e.clientY);
      const handle = e.target.dataset && e.target.dataset.h;
      drag = await this.toolDown(i, x, y, e, handle);
      if (drag) view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') { view.scrollLeft = drag.sl - (e.clientX - drag.x); view.scrollTop = drag.st - (e.clientY - drag.y); return; }
      const [x, y] = this.toUser(drag.page, e.clientX, e.clientY);
      drag.move && drag.move(x, y, e);
    });
    const up = (e) => {
      if (!drag) return;
      view.classList.remove('drag');
      const d = drag; drag = null;
      if (d.kind === 'pan') return;
      const [x, y] = this.toUser(d.page, e.clientX, e.clientY);
      d.up && d.up(x, y, e);
    };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    view.addEventListener('dblclick', (e) => { const i = this.pageAt(e); if (i >= 0 && this.doc) { const [x, y] = this.toUser(i, e.clientX, e.clientY); this.dbl(i, x, y, e); } });
    view.addEventListener('contextmenu', (e) => { if (this.selAnnot || this.sel) { e.preventDefault(); this.contextMenu(e); } });
  }
  annotAt(i, x, y) {
    const page = this.doc.pages[i];
    const list = page.annots.slice().reverse();
    for (const r of list) {
      const d = this.doc.get(r);
      if (!(d instanceof Dict)) continue;
      const type = this.doc.get(d.get('Subtype'))?.n;
      if (type === 'Popup' || (type === 'Widget' && this.formMode)) continue;
      const R = normRect((this.doc.get(d.get('Rect')) || [0, 0, 0, 0]).map((v) => +this.doc.get(v)));
      const pad = 3 / this.scale();
      if (x >= R[0] - pad && x <= R[2] + pad && y >= R[1] - pad && y <= R[3] + pad) return { page: i, ref: r, rect: R, type, dict: d };
    }
    return null;
  }
  rubber(i, x0, y0, cls = 'rubber') {
    const el = this.box(i, [x0, y0, x0, y0], cls);
    return (x, y) => { const c = this.cssRect(i, [x0, y0, x, y]); Object.assign(el.style, { left: c[0] + 'px', top: c[1] + 'px', width: c[2] - c[0] + 'px', height: c[3] - c[1] + 'px' }); return el; };
  }
  async toolDown(i, x, y, e, handle) {
    const t = this.tool;
    if (t === 'select') {
      if (handle && (this.selAnnot || this.selObj)) return this.resizeDrag(i, handle, x, y);
      const a = this.annotAt(i, x, y);
      if (a) {
        this.sel = null; this.selObj = null; this.selAnnot = a; this.drawOverlay(); this.updateCtx();
        if (a.type === 'Link' && !e.altKey) { this.followLink(a.dict); this.selAnnot = null; this.drawOverlay(); return null; }
        return this.moveDrag(i, x, y);
      }
      if (this.selAnnot || this.selObj) { this.selAnnot = null; this.selObj = null; this.updateCtx(); }
      const tx = await this.textNow(i);
      const n = this.nearestChar(tx, x, y);
      if (n.k >= 0 && n.d < 12) {
        this.sel = { page: i, a: n.k, b: n.k, active: true };
        this.drawOverlay();
        return { page: i, move: (x2, y2) => { const m = this.nearestChar(tx, x2, y2); if (m.k >= 0) { this.sel.b = m.k; this.drawOverlay(); } }, up: () => { this.sel.active = false; if (this.sel.a === this.sel.b && n.d > 4) this.sel = null; this.drawOverlay(); this.updateCtx(); } };
      }
      // content objects (images / vector paths) can be picked
      const objs = await this.objects(i);
      const hit = objs.filter((o) => (o.kind === 'image' || o.kind === 'form' || o.kind === 'inline') && o.bbox && x >= o.bbox[0] && x <= o.bbox[2] && y >= o.bbox[1] && y <= o.bbox[3]).pop();
      this.sel = null;
      if (hit) { this.selObj = { ...hit, page: i }; this.drawOverlay(); this.updateCtx(); return this.moveDrag(i, x, y); }
      this.drawOverlay(); this.updateCtx();
      return { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.view.scrollLeft, st: this.view.scrollTop };
    }
    if (t === 'markup') {
      const tx = await this.textNow(i);
      const n = this.nearestChar(tx, x, y);
      if (n.k >= 0 && n.d < 14) {
        this.sel = { page: i, a: n.k, b: n.k };
        this.drawOverlay();
        return { page: i, move: (x2, y2) => { const m = this.nearestChar(tx, x2, y2); if (m.k >= 0) { this.sel.b = m.k; this.drawOverlay(); } }, up: () => this.markupSelection(this.sub.markup) };
      }
      // no text here (e.g. scanned page): area highlight
      const rb = this.rubber(i, x, y);
      return { page: i, move: (x2, y2) => rb(x2, y2), up: (x2, y2) => { rb(x2, y2).remove(); const r = normRect([x, y, x2, y2]); if (r[2] - r[0] > 3 && r[3] - r[1] > 3) this.addAnnot(i, { type: this.sub.markup, rect: r, quads: [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]], color: rgb01(this.st.color.markup) }); } };
    }
    if (t === 'note') {
      if (this.sub.note === 'Stamp') {
        const w = 150, hh = 50;
        const ref = await this.addAnnot(i, { type: 'Stamp', rect: [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2], label: this.st.stamp, color: rgb01(this.st.color.note === '#ffd400' ? '#d01818' : this.st.color.note) });
        void ref; this.setTool('select'); return null;
      }
      const ref = await this.addAnnot(i, { type: 'Text', rect: [x, y - 20, x + 20, y], color: rgb01(this.st.color.note), contents: '' });
      if (ref) { const a = this.annotAt(i, x + 5, y - 5); if (a) { this.selAnnot = a; this.editComment(a); } }
      return null;
    }
    if (t === 'draw') return this.drawTool(i, x, y, e);
    if (t === 'text') {
      if (this.sub.text === 'edit') return this.editTextAt(i, x, y);
      const rb = this.rubber(i, x, y);
      return { page: i, move: (x2, y2) => rb(x2, y2), up: (x2, y2) => { rb(x2, y2).remove(); let r = normRect([x, y, x2, y2]); if (r[2] - r[0] < 20) r = [x, y - this.st.fontSize * 1.6, x + 220, y]; this.textBox(i, r); } };
    }
    if (t === 'sign') {
      if (!this.signature) { this.run('create-signature'); return null; }
      const s = this.signature, w = 180, hh = (w * s.h) / s.w;
      await this.placeSignature(i, [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2]);
      return null;
    }
    if (t === 'redact') {
      const tx = await this.textNow(i);
      const n = this.nearestChar(tx, x, y);
      if (this.sub.redact === 'text' && n.k >= 0 && n.d < 10) {
        this.sel = { page: i, a: n.k, b: n.k }; this.drawOverlay();
        return { page: i, move: (x2, y2) => { const m = this.nearestChar(tx, x2, y2); if (m.k >= 0) { this.sel.b = m.k; this.drawOverlay(); } }, up: () => this.markupSelection('Redact') };
      }
      const rb = this.rubber(i, x, y, 'redmark');
      return { page: i, move: (x2, y2) => rb(x2, y2), up: (x2, y2) => { rb(x2, y2).remove(); const r = normRect([x, y, x2, y2]); if (r[2] - r[0] > 2 && r[3] - r[1] > 2) this.addAnnot(i, { type: 'Redact', rect: r }); } };
    }
    return null;
  }
  async objects(i) {
    if (!this.objsCache.has(i)) this.objsCache.set(i, (await this.text(i)).objs || []);
    return this.objsCache.get(i);
  }
  moveDrag(i, x0, y0) {
    const tgt = this.selAnnot || this.selObj;
    const r0 = tgt.rect || tgt.bbox;
    const el = this.views[i].ov.querySelector('.sbox');
    let moved = false;
    return {
      page: i,
      move: (x, y) => { moved = true; const dx = x - x0, dy = y - y0; const c = this.cssRect(i, [r0[0] + dx, r0[1] + dy, r0[2] + dx, r0[3] + dy]); if (el) Object.assign(el.style, { left: c[0] + 'px', top: c[1] + 'px' }); },
      up: (x, y) => { if (!moved || (Math.abs(x - x0) < 0.5 && Math.abs(y - y0) < 0.5)) return; this.applyTransform([1, 0, 0, 1, x - x0, y - y0]); },
    };
  }
  resizeDrag(i, hd, x0, y0) {
    const tgt = this.selAnnot || this.selObj;
    const r0 = (tgt.rect || tgt.bbox).slice();
    const el = this.views[i].ov.querySelector('.sbox');
    const calc = (x, y) => {
      const r = r0.slice();
      // handles refer to screen directions; map through the page rotation by working in user space bounds
      const sx = this.toCss(i, r0[0], r0[1])[0] < this.toCss(i, r0[2], r0[3])[0];
      void sx;
      if (hd.includes('w')) r[0] = Math.min(x, r0[2] - 2); if (hd.includes('e')) r[2] = Math.max(x, r0[0] + 2);
      if (hd.includes('n')) r[3] = Math.max(y, r0[1] + 2); if (hd.includes('s')) r[1] = Math.min(y, r0[3] - 2);
      return r;
    };
    return {
      page: i,
      move: (x, y) => { const c = this.cssRect(i, calc(x, y)); if (el) Object.assign(el.style, { left: c[0] + 'px', top: c[1] + 'px', width: c[2] - c[0] + 'px', height: c[3] - c[1] + 'px' }); },
      up: (x, y) => {
        const r = calc(x, y);
        const sx = (r[2] - r[0]) / (r0[2] - r0[0] || 1), sy = (r[3] - r[1]) / (r0[3] - r0[1] || 1);
        this.applyTransform([sx, 0, 0, sy, r[0] - r0[0] * sx, r[1] - r0[1] * sy]);
      },
    };
  }
  async applyTransform(T) {
    if (this.selAnnot) {
      const a = this.selAnnot;
      await this.edit('Move annotation', () => A.transformAnnot(this.doc, a.ref, T), [a.page]);
      this.selAnnot = this.annotAt(a.page, ...apply(T, (a.rect[0] + a.rect[2]) / 2, (a.rect[1] + a.rect[3]) / 2)) || null;
      this.drawOverlay(); this.updateCtx();
    } else if (this.selObj) {
      const o = this.selObj;
      const { transformObject } = await import('./objects.js');
      await this.edit('Move object', () => transformObject(this.doc, o.page, o, T), [o.page]);
      this.selObj = null; this.updateCtx();
    }
  }
  async deleteSelected() {
    if (this.selAnnot) {
      const a = this.selAnnot;
      await this.edit('Delete ' + a.type, () => A.deleteAnnot(this.doc, a.page, a.ref), [a.page]);
      this.selAnnot = null; this.updateCtx(); this.panelRefresh();
    } else if (this.selObj) {
      const o = this.selObj;
      const { deleteObject } = await import('./objects.js');
      await this.edit('Delete object', () => deleteObject(this.doc, o.page, o), [o.page]);
      this.selObj = null; this.updateCtx();
    }
  }
  async addAnnot(i, spec) {
    spec.author = spec.author || this.author;
    if (spec.opacity === undefined && this.st.opacity < 1 && spec.type !== 'Redact') spec.opacity = this.st.opacity;
    const ref = await this.edit('Add ' + spec.type, () => A.createAnnot(this.doc, i, spec), [i]);
    this.panelRefresh();
    return ref;
  }
  async markupSelection(type) {
    const s = this.sel; if (!s) return;
    const t = this.texts.get(s.page)?._v || (await this.textNow(s.page));
    const [a, b] = s.a <= s.b ? [s.a, s.b] : [s.b, s.a];
    const idx = []; for (let k = a; k <= b; k++) if (t.chars[k].u.trim() || (k > a && k < b)) idx.push(k);
    const rects = charRects(t.chars, idx);
    if (!rects.length) return;
    const quads = []; for (const r of rects) quads.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]);
    const R = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
    const text = this.selectedText();
    this.sel = null; this.drawOverlay();
    await this.addAnnot(s.page, { type, rect: R, quads, color: type === 'Redact' ? undefined : rgb01(this.st.color.markup), contents: type === 'Redact' ? '' : '' });
    if (type !== 'Redact') this.lastMarkupText = text;
    this.updateCtx();
  }
  drawTool(i, x, y) {
    const sub = this.sub.draw, col = rgb01(this.st.color.draw), w = this.st.width;
    if (sub === 'Ink') {
      const pts = [x, y];
      const svgNS = 'http://www.w3.org/2000/svg', ov = this.views[i].ov;
      const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible');
      const pl = document.createElementNS(svgNS, 'polyline'); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', this.st.color.draw); pl.setAttribute('stroke-width', w * this.scale()); pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
      svg.append(pl); ov.append(svg);
      const upd = () => { let s = ''; for (let k = 0; k < pts.length; k += 2) { const c = this.toCss(i, pts[k], pts[k + 1]); s += c[0] + ',' + c[1] + ' '; } pl.setAttribute('points', s); };
      return {
        page: i, move: (x2, y2) => { const lx = pts[pts.length - 2], ly = pts[pts.length - 1]; if (Math.hypot(x2 - lx, y2 - ly) * this.scale() > 2) { pts.push(x2, y2); upd(); } },
        up: async () => {
          svg.remove();
          if (pts.length < 4) pts.push(x + 0.5, y + 0.5);
          const xs = pts.filter((_, k) => k % 2 === 0), ys = pts.filter((_, k) => k % 2 === 1), pad = w + 2;
          // continue the same ink annotation if drawn within 1.5 s on the same page (multi-stroke signatures/drawings)
          const last = this.lastInk;
          if (last && last.page === i && Date.now() - last.t < 1500 && this.doc.get(last.ref)) {
            const d = this.doc.get(last.ref);
            const ink = (this.doc.get(d.get('InkList')) || []).map((l) => this.doc.get(l));
            const R = normRect((this.doc.get(d.get('Rect')) || []).map(Number));
            await this.edit('Draw', () => { const dd = this.doc.touch(last.ref); dd.set('InkList', [...ink, pts.map((v) => Math.round(v * 100) / 100)]); dd.set('Rect', [Math.min(R[0], Math.min(...xs) - pad), Math.min(R[1], Math.min(...ys) - pad), Math.max(R[2], Math.max(...xs) + pad), Math.max(R[3], Math.max(...ys) + pad)]); A.buildAP(this.doc, dd); }, [i]);
            this.lastInk.t = Date.now();
            return;
          }
          const ref = await this.addAnnot(i, { type: 'Ink', rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], ink: [pts], color: col, width: w });
          this.lastInk = { page: i, ref, t: Date.now() };
        },
      };
    }
    if (sub === 'Polygon') {
      this.poly = this.poly && this.poly.page === i ? this.poly : { page: i, pts: [] };
      this.poly.pts.push(x, y);
      this.views[i].ov.querySelectorAll('.polyp').forEach((e) => e.remove());
      for (let k = 0; k < this.poly.pts.length; k += 2) { const c = this.toCss(i, this.poly.pts[k], this.poly.pts[k + 1]); this.views[i].ov.append(h('div', { class: 'polyp sbox', style: { left: c[0] - 3 + 'px', top: c[1] - 3 + 'px', width: '6px', height: '6px' } })); }
      this.cancelPoly = () => { this.poly = null; document.querySelectorAll('.polyp').forEach((e) => e.remove()); };
      this.msg('Click to add points, double-click to finish');
      return null;
    }
    if (sub === 'Image') { this.run('insert-image', { page: i, x, y }); return null; }
    const rb = this.rubber(i, x, y);
    return {
      page: i, move: (x2, y2) => rb(x2, y2),
      up: (x2, y2) => {
        rb(x2, y2).remove();
        const r = normRect([x, y, x2, y2]);
        if (Math.hypot(x2 - x, y2 - y) < 3) return;
        const pad = w + 1;
        if (sub === 'Line' || sub === 'Arrow') this.addAnnot(i, { type: 'Line', rect: [r[0] - pad * 3, r[1] - pad * 3, r[2] + pad * 3, r[3] + pad * 3], line: [x, y, x2, y2], arrow: sub === 'Arrow', color: col, width: w });
        else this.addAnnot(i, { type: sub === 'Ellipse' ? 'Circle' : 'Square', rect: r, color: col, width: w, fill: this.st.fill ? rgb01(this.st.fill) : undefined });
      },
    };
  }
  async dbl(i, x, y) {
    if (this.tool === 'draw' && this.sub.draw === 'Polygon' && this.poly && this.poly.pts.length >= 6) {
      const p = this.poly.pts.slice(0, -2); // last click duplicated by dblclick
      this.cancelPoly();
      const xs = p.filter((_, k) => k % 2 === 0), ys = p.filter((_, k) => k % 2 === 1), pad = this.st.width + 2;
      await this.addAnnot(i, { type: 'Polygon', rect: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], vertices: p, color: rgb01(this.st.color.draw), width: this.st.width });
      this.msg('');
      return;
    }
    if (this.tool === 'select') {
      const a = this.annotAt(i, x, y);
      if (a && (a.type === 'Text' || a.type === 'FreeText' || A.MARKUP.includes(a.type) || a.type === 'Square' || a.type === 'Circle' || a.type === 'Ink' || a.type === 'Stamp')) { this.selAnnot = a; return this.editComment(a); }
      // select word
      const t = await this.textNow(i);
      const n = this.nearestChar(t, x, y);
      if (n.k < 0 || n.d > 6) return;
      let a0 = n.k, b0 = n.k;
      while (a0 > 0 && /\w/.test(t.chars[a0 - 1].u) && Math.abs(t.chars[a0 - 1].b[1] - t.chars[n.k].b[1]) < 3) a0--;
      while (b0 < t.chars.length - 1 && /\w/.test(t.chars[b0 + 1].u) && Math.abs(t.chars[b0 + 1].b[1] - t.chars[n.k].b[1]) < 3) b0++;
      this.sel = { page: i, a: a0, b: b0 }; this.drawOverlay(); this.updateCtx();
    }
  }
  followLink(d) {
    const nav = this.navMod;
    const t = d.get('Dest') ? { dest: nav.resolveDest(this.doc, d.get('Dest')) } : nav.actionTarget(this.doc, d.get('A'));
    if (t?.dest) this.goto(t.dest.page, t.dest.y);
    else if (t?.uri) { if (/^(https?|mailto):/i.test(t.uri)) dialog('Open link?', [], { hint: t.uri, ok: 'Open in new tab' }).then((v) => v && window.open(t.uri, '_blank', 'noopener')); }
  }
  // Comment / text editing popover
  editComment(a) {
    const v = this.views[a.page];
    const c = this.cssRect(a.page, a.rect);
    v.ov.querySelectorAll('.pop').forEach((p) => p.remove());
    const ta = h('textarea', { 'aria-label': 'Comment text' }, textOf(this.doc.get(a.dict.get('Contents'))));
    const close = () => pop.remove();
    const saveIt = async () => { const val = ta.value; close(); await this.edit('Edit comment', () => A.updateAnnot(this.doc, a.ref, { contents: val }), [a.page]); this.panelRefresh(); };
    const pop = h('div', { class: 'pop', style: { left: Math.min(c[2] + 6, v.el.clientWidth - 250) + 'px', top: c[1] + 'px' } },
      h('div', { class: 'small muted' }, a.type === 'FreeText' ? 'Text' : 'Comment', ' · ', textOf(this.doc.get(a.dict.get('T'))) || this.author), ta,
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'btn sm primary', type: 'button', onclick: saveIt }, 'Save')));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveIt(); if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    v.ov.append(pop); ta.focus();
  }
  textBox(i, r, init = '', onDone) {
    const v = this.views[i], c = this.cssRect(i, r), fs = this.st.fontSize;
    const ta = h('textarea', { class: 'edit-ta', 'aria-label': 'Type text', style: { left: c[0] + 'px', top: c[1] + 'px', width: Math.max(80, c[2] - c[0]) + 'px', height: Math.max(fs * 1.6 * this.scale(), c[3] - c[1]) + 'px', fontSize: fs * this.scale() + 'px', color: this.st.color.text } }, init);
    let done = false;
    const finish = async (ok) => {
      if (done) return; done = true;
      const val = ta.value; const rr = ta.getBoundingClientRect(); ta.remove();
      if (!ok || !val.trim()) return onDone && onDone(null);
      const p0 = this.toUser(i, rr.left, rr.top), p1 = this.toUser(i, rr.right, rr.bottom);
      const R = normRect([...p0, ...p1]);
      if (onDone) return onDone(val, R);
      if (this.sub.text === 'page') await this.edit('Add text', () => E.addText(this.doc, i, val, { x: R[0] + 2, y: R[3] - fs, size: fs, color: rgb01(this.st.color.text) }), [i]);
      else await this.addAnnot(i, { type: 'FreeText', rect: R, contents: val, fontSize: fs, textColor: rgb01(this.st.color.text) });
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true); });
    ta.addEventListener('blur', () => finish(true));
    v.ov.append(ta); setTimeout(() => ta.focus());
  }
  async editTextAt(i, x, y) {
    const { textRuns, replaceRun } = await import('./objects.js');
    const t = await this.textNow(i);
    const runs = textRuns(t.chars);
    const run = runs.find((r) => x >= r.b[0] - 2 && x <= r.b[2] + 2 && y >= r.b[1] - 2 && y <= r.b[3] + 2);
    if (!run) { toast('Click on existing text to edit it'); return null; }
    const fs = run.fs;
    const saved = this.st.fontSize; this.st.fontSize = fs;
    this.textBox(i, [run.b[0], run.b[1] - fs * 0.2, Math.max(run.b[2], run.b[0] + 60), run.b[3] + fs * 0.1], run.text, async (val) => {
      this.st.fontSize = saved;
      if (val === null || val === run.text) return;
      const r = await this.edit('Edit text', () => replaceRun(this.doc, i, run, val, t), [i]);
      if (r && r.fallback) toast('The embedded font lacks some characters; the text was re-set in Helvetica.');
    });
    return null;
  }
  async placeSignature(i, r) {
    const s = this.signature;
    await this.edit('Sign', async () => {
      const xo = await E.imageXObject(this.doc, s.png ? { png: s.png, w: s.w, h: s.h, rgba: s.rgba } : { w: s.w, h: s.h, rgba: s.rgba });
      A.createAnnot(this.doc, i, { type: 'Stamp', rect: r, imageXO: xo, contents: 'Signature' + (s.date ? ' ' + s.date : ''), author: this.author, icon: 'Signature' });
    }, [i]);
    this.panelRefresh();
    this.setTool('select');
  }
  contextMenu(e) {
    const items = [];
    if (this.sel) items.push({ label: 'Copy', onclick: () => navigator.clipboard?.writeText(this.selectedText()) }, { label: 'Highlight', onclick: () => this.markupSelection('Highlight') }, { label: 'Underline', onclick: () => this.markupSelection('Underline') }, { label: 'Strikethrough', onclick: () => this.markupSelection('StrikeOut') }, { label: 'Mark for redaction', onclick: () => this.markupSelection('Redact') });
    if (this.selAnnot) items.push({ label: 'Edit comment', onclick: () => this.editComment(this.selAnnot) }, { label: 'Delete', onclick: () => this.deleteSelected() }, { label: 'Flatten into page', onclick: () => this.run('flatten-selected') });
    menu(items, null, { x: e.clientX, y: e.clientY });
  }
  // ---------------------------------------------------------------- forms overlay
  fieldOverlay(a) { void a; return true; }
  drawFields(v) {
    v.el.querySelectorAll('.fw').forEach((e) => e.remove());
    if (!this.formMode) return;
    const all = this.fieldsCache || (this.fieldsCache = F.fields(this.doc));
    for (const f of all) for (const w of f.widgets) {
      if (w.page !== v.i || f.type === 'signature' || f.type === 'button') continue;
      const c = this.cssRect(v.i, w.rect);
      const st = { left: c[0] + 'px', top: c[1] + 'px', width: c[2] - c[0] + 'px', height: c[3] - c[1] + 'px', fontSize: Math.max(8, Math.min(14 * this.zoom, (c[3] - c[1]) * 0.7)) + 'px' };
      let el;
      const label = f.tu || f.name;
      const commit = (val) => this.setField(f, val, v.i);
      if (f.type === 'text') {
        el = f.multiline ? h('textarea', { class: 'fw', style: st, 'aria-label': label, readonly: f.readonly }, f.value) : h('input', { class: 'fw', style: st, 'aria-label': label, value: f.value, type: f.password ? 'password' : 'text', maxlength: f.maxLen || undefined, readonly: f.readonly });
        el.addEventListener('change', () => commit(el.value));
      } else if (f.type === 'checkbox' || f.type === 'radio') {
        el = h('input', { class: 'fw', type: f.type, style: { ...st, margin: 0 }, 'aria-label': label + (w.on ? ' ' + w.on : ''), checked: f.type === 'radio' ? f.value === w.on : !!f.value && f.value !== 'Off', name: f.type === 'radio' ? 'r_' + f.name : undefined, disabled: f.readonly });
        el.addEventListener('change', () => commit(f.type === 'radio' ? w.on : el.checked));
      } else if (f.type === 'combo' || f.type === 'list') {
        el = h('select', { class: 'fw', style: st, 'aria-label': label, multiple: f.type === 'list' && f.multi, size: f.type === 'list' ? Math.max(2, f.options.length) : undefined, disabled: f.readonly }, f.type === 'combo' ? h('option', { value: '' }, '') : null, f.options.map(([ex, dp]) => h('option', { value: ex, selected: Array.isArray(f.value) ? f.value.includes(ex) : f.value === ex }, dp)));
        el.addEventListener('change', () => commit(f.type === 'list' && f.multi ? [...el.selectedOptions].map((o) => o.value) : el.value));
      }
      if (el) { el.dataset.f = f.name; v.el.append(el); }
    }
  }
  async setField(f, val, page) {
    await this.doc.edit('Fill ' + f.name, () => { const cur = F.fields(this.doc).find((x) => x.name === f.name); F.setValue(this.doc, cur, val); F.calculate(this.doc); });
    this.fieldsCache = null;
    // calculated fields may live on other pages: refresh visible field overlays
    for (const v of this.views) if (v.cv) { v.dirty = true; if (v.visible) this.queue(v.i); }
    void page;
    this.panelRefresh();
  }
  setFormMode(on) { this.formMode = on; this.fieldsCache = null; for (const v of this.views) { v.dirty = true; if (v.visible) this.queue(v.i); } }
  // ---------------------------------------------------------------- search
  openFind() { if (!this.doc) return; $('#findbar').hidden = false; const q = $('#q'); q.focus(); q.select(); }
  closeFind() { $('#findbar').hidden = true; this.hits = []; this.hitIdx = -1; this.drawOverlay(); $('#qn').textContent = ''; }
  async search() {
    const q = $('#q').value;
    this.hits = []; this.hitIdx = -1;
    if (!q.trim()) { this.drawOverlay(); $('#qn').textContent = ''; return; }
    const token = (this.searchToken = {});
    const opts = { caseSensitive: $('#q-case').checked, wholeWord: $('#q-word').checked };
    const n = this.doc.pageCount;
    const order = [...Array(n).keys()].map((k) => (this.cur + k) % n);
    for (const i of order) {
      const t = await this.textNow(i);
      if (token !== this.searchToken) return;
      for (const m of findAll(t.lay, q, opts)) this.hits.push({ page: i, rects: charRects(t.chars, m.chars), text: m.text });
      this.hits.sort((a, b) => a.page - b.page);
      $('#qn').textContent = this.hits.length + ' found' + (i !== order[n - 1] ? '…' : '');
      if (this.hitIdx < 0 && this.hits.length) { this.hitIdx = this.hits.findIndex((x) => x.page >= this.cur); if (this.hitIdx < 0) this.hitIdx = 0; this.showHit(); }
      if (i % 8 === 0) await new Promise((r) => setTimeout(r));
    }
    $('#qn').textContent = this.hits.length ? `${this.hitIdx + 1} of ${this.hits.length}` : 'No matches';
    this.drawOverlay();
  }
  nextHit(d) { if (!this.hits.length) return; this.hitIdx = (this.hitIdx + d + this.hits.length) % this.hits.length; this.showHit(); }
  showHit() {
    const hh = this.hits[this.hitIdx]; if (!hh) return;
    const v = this.views[hh.page];
    if (this.mode === 'single') this.goto(hh.page);
    else { const c = this.cssRect(hh.page, hh.rects[0]); this.view.scrollTo({ top: v.el.offsetTop + c[1] - this.view.clientHeight / 3, left: Math.max(0, v.el.offsetLeft + c[0] - this.view.clientWidth / 2) }); }
    this.setCur(hh.page);
    $('#qn').textContent = `${this.hitIdx + 1} of ${this.hits.length}`;
    this.drawOverlay();
  }
  // ---------------------------------------------------------------- misc UI
  toggleTheme() { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; localStorage.setItem('pdfs-theme', t); }
  toggleSide() { if (innerWidth <= 860) this.app.classList.toggle('sideopen'); else this.app.classList.toggle('noside'); }
  // filled in by commands.js
  palette() {} run() {} panel() {} panelRefresh() {} thumbDirty() {} toggleOrganizer() {} renderOrganizer() {} showRedactMarks() {}
}
export { hex, rgb01, Ref };

// Application shell: deck state, undo/redo, outline <-> slides sync, virtualised slide rail and sorter,
// the slide editor (select, drag with snapping guides, resize, edit text in place) and the recovery copy.
import { h, $, toast, menu } from './util.js';
import { lay, slideHTML, slideNode } from './render.js';
import { newDeck, newSlide, parseOutline, toOutline, reconcile, binding, mergeRuns } from '../model.js';
import { extractDataUrls } from '../media.js';
import { LAYOUTS, autoLayout, BODY, IND, HANG } from '../layout.js';
import { checkSlide } from '../checks.js';
import { measure } from './render.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = (c) => { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('') : c; };

export class App {
  constructor() {
    this.deck = newDeck(); this.cur = 0; this.sel = []; this.rsel = new Set([0]); this.zf = 1;
    this.undoS = []; this.redoS = []; this.modified = false; this.handle = null; this.view = 'edit';
    this.ol = $('#outline'); this.notes = $('#notes'); this.sw = $('#sw'); this.rail = $('#rail');
    this.frame = h('div', { id: 'frame' }, this.stage = h('div', { id: 'stage' }), this.ovl = h('div', { id: 'ovl' }));
    this.sw.append(this.frame);
    this.thumbs = new Map(); this.sthumbs = new Map();
    this.bind();
    try { const t = localStorage.getItem('slidestudio-ui'); if (t) document.documentElement.dataset.theme = t; } catch {}
    this.render();
    this.checkRecovery();
  }
  get slide() { return this.deck.slides[this.cur]; }
  get L() { return lay(this.slide, this.deck, this.cur); }
  box(k) { return this.L.boxes.find((b) => b.k === k); }
  get title() { return $('#title').value.trim() || 'Untitled presentation'; }
  updateTitle() { document.title = (this.modified ? '• ' : '') + this.title + ' – SlideStudio'; }

  // ---------- history: snapshots share unchanged slide strings ----------
  snap() {
    const prev = new Map(this.lastSnap ? this.lastSnap.s : []);
    const { theme, w, h: hh } = this.deck;
    return (this.lastSnap = { t: JSON.stringify({ theme, w, h: hh }), s: this.deck.slides.map((s) => { const j = JSON.stringify(s), o = prev.get(s.id); return [s.id, o === j ? o : j]; }), cur: this.cur });
  }
  push(tag) {
    const now = Date.now();
    if (tag && tag === this.lastTag && now - this.lastT < 1500) { this.lastT = now; return; }
    this.lastTag = tag; this.lastT = now;
    this.undoS.push(this.snap());
    if (this.undoS.length > 200) this.undoS.shift();
    this.redoS = [];
  }
  restore(sn) { Object.assign(this.deck, JSON.parse(sn.t)); this.deck.slides = sn.s.map((x) => JSON.parse(x[1])); this.cur = clamp(sn.cur, 0, this.deck.slides.length - 1); this.rsel = new Set([this.cur]); this.sel = []; }
  undo() { if (!this.undoS.length) return toast('Nothing to undo'); this.redoS.push(this.snap()); this.restore(this.undoS.pop()); this.lastTag = null; this.changed(); }
  redo() { if (!this.redoS.length) return toast('Nothing to redo'); this.undoS.push(this.snap()); this.restore(this.redoS.pop()); this.lastTag = null; this.changed(); }
  edit(fn, o = {}) { this.commitText(); this.push(o.tag); const r = fn(); this.changed(o); return r; }
  changed(o = {}) {
    this.modified = true; this.updateTitle(); this.scheduleSave();
    if (!this.deck.slides.length) this.deck.slides.push(newSlide());
    if (o.light) { clearTimeout(this.lt); this.lt = setTimeout(() => this.syncOutline(), 400); return; }
    this.render(o);
  }
  render(o = {}) {
    this.cur = clamp(this.cur, 0, this.deck.slides.length - 1);
    if (![...this.rsel].every((i) => i < this.deck.slides.length)) this.rsel = new Set([this.cur]);
    this.sel = this.sel.filter((k) => this.box(k));
    this.renderStage(); this.renderRail();
    if (this.view === 'sorter') this.renderSorter();
    if (o.outline !== false) this.syncOutline();
    if (document.activeElement !== this.notes) this.notes.value = this.slide.notes || '';
    this.status();
  }
  status() {
    const s = this.slide, n = this.deck.slides.length, ly = s.layout && s.layout !== 'auto' ? LAYOUTS[s.layout] : LAYOUTS[autoLayout(s, this.cur)] + ' (auto)';
    $('#st').textContent = `Slide ${this.cur + 1} of ${n}${s.hidden ? ' · hidden' : ''}`;
    $('#lay').textContent = ly;
    $('#live').textContent = `Slide ${this.cur + 1} of ${n}`;
    clearTimeout(this.ct);
    this.ct = setTimeout(() => { const k = checkSlide(this.deck, this.slide, this.cur, measure).length, b = $('#b-chk'); b.textContent = k ? `⚠ ${k} issue${k > 1 ? 's' : ''}` : '✓ No issues'; b.classList.toggle('warn', !!k); }, 250);
  }
  go(i, keepSel) {
    this.commitText();
    this.cur = clamp(i, 0, this.deck.slides.length - 1);
    if (!keepSel) this.rsel = new Set([this.cur]);
    this.sel = [];
    this.render({ outline: false });
    this.scrollRail(); this.scrollOutline();
  }

  // ---------- outline ----------
  syncOutline() {
    if (document.activeElement === this.ol) return;
    const t = toOutline(this.deck);
    if (this.ol.value !== t) { const st = this.ol.scrollTop; this.ol.value = t; this.ol.scrollTop = st; }
    this.olText = t;
  }
  applyOutline() {
    let t = this.ol.value;
    if (/!\[[^\]]*\]\(data:/.test(t)) { const p = this.ol.selectionStart, n = extractDataUrls(t, this.deck); this.ol.value = n; this.ol.selectionStart = this.ol.selectionEnd = Math.max(0, p - (t.length - n.length)); t = n; }
    if (t === this.olText) return;
    this.olText = t;
    this.push('outline');
    const sl = reconcile(this.deck.slides, parseOutline(t));
    this.deck.slides = sl.length ? sl : [newSlide()];
    this.cur = this.caretSlide(); this.rsel = new Set([this.cur]);
    this.changed({ outline: false });
    this.scrollRail();
  }
  slideLines() { // line index where each slide starts in the outline
    const out = [], lines = this.ol.value.split('\n');
    let fence = false, any = false;
    lines.forEach((l, i) => {
      if (/^\s*```/.test(l)) fence = !fence;
      if (fence && !/^\s*```/.test(l)) return;
      if (/^(#(\s|$)|---+\s*$)/.test(l)) { out.push(i); any = true; } else if (!any && l.trim()) { out.push(i); any = true; }
    });
    return out;
  }
  caretSlide() { const line = this.ol.value.slice(0, this.ol.selectionStart).split('\n').length - 1, st = this.slideLines(); let k = 0; st.forEach((l, i) => { if (l <= line) k = i; }); return clamp(k, 0, this.deck.slides.length - 1); }
  scrollOutline() {
    if (document.activeElement === this.ol) return;
    const l = this.slideLines()[this.cur] || 0, lh = parseFloat(getComputedStyle(this.ol).lineHeight) || 18;
    if (l * lh < this.ol.scrollTop || l * lh > this.ol.scrollTop + this.ol.clientHeight - 40) this.ol.scrollTop = Math.max(0, l * lh - 30);
  }

  // ---------- slide rail and sorter (virtualised) ----------
  virt(host, inner, map, cols, iw, ih, sel) {
    const n = this.deck.slides.length, rows = Math.ceil(n / cols);
    inner.style.height = rows * ih + 'px';
    const top = host.scrollTop, a = Math.max(0, Math.floor(top / ih) - 1) * cols, b = Math.min(n, (Math.ceil((top + host.clientHeight) / ih) + 1) * cols);
    for (const [i, el] of map) if (i < a || i >= b) { el.remove(); map.delete(i); }
    for (let i = a; i < b; i++) {
      const s = this.deck.slides[i], html = slideHTML(s, this.deck, i) + iw + s.hidden;
      let el = map.get(i);
      if (!el) { el = h('div', { class: 'th', 'data-i': i, role: 'option' }); inner.append(el); map.set(i, el); }
      if (el._h !== html) { el._h = html; el.replaceChildren(h('span', { class: 'num' }, i + 1), slideNode(s, this.deck, i, iw)); }
      el.style.cssText = `left:${(i % cols) * (iw + 26) + 6}px;top:${Math.floor(i / cols) * ih + 6}px;width:${iw + 22}px`;
      el.classList.toggle('on', sel.has(i)); el.classList.toggle('cur', i === this.cur); el.classList.toggle('hid', !!s.hidden);
      el.setAttribute('aria-selected', sel.has(i)); el.setAttribute('aria-label', `Slide ${i + 1}`);
    }
  }
  thumbW() { return Math.max(60, this.rail.clientWidth - 40); }
  renderRail() { if (this.rail.offsetParent) { const w = this.thumbW(); this.virt(this.rail, $('#rs'), this.thumbs, 1, w, (w * this.deck.h) / this.deck.w + 14, this.rsel); } }
  renderSorter() { const host = $('#sorter'), iw = 210, cols = Math.max(1, Math.floor((host.clientWidth - 12) / (iw + 26))); this.virt(host, $('#ss'), this.sthumbs, cols, iw, (iw * this.deck.h) / this.deck.w + 18, this.rsel); }
  scrollRail() {
    const w = this.thumbW(), ih = (w * this.deck.h) / this.deck.w + 14, y = this.cur * ih;
    if (y < this.rail.scrollTop || y + ih > this.rail.scrollTop + this.rail.clientHeight) this.rail.scrollTop = y - this.rail.clientHeight / 3;
    this.renderRail();
  }
  listDown(e, host) {
    const it = e.target.closest('.th');
    if (!it || e.button > 0) return;
    const i = +it.dataset.i;
    if (e.shiftKey) { const a = Math.min(i, this.cur), b = Math.max(i, this.cur); this.rsel = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)); this.cur = i; this.render({ outline: false }); return; }
    if (e.ctrlKey || e.metaKey) { this.rsel.has(i) ? this.rsel.delete(i) : this.rsel.add(i); if (!this.rsel.size) this.rsel.add(i); this.cur = i; this.render({ outline: false }); return; }
    if (!this.rsel.has(i)) this.rsel = new Set([i]);
    this.go(i, true);
    const sx = e.clientX, sy = e.clientY;
    let line = null, to = -1;
    const move = (ev) => {
      if (!line && Math.abs(ev.clientY - sy) + Math.abs(ev.clientX - sx) < 6) return;
      if (!line) { line = h('div', { class: 'dropline' }); host.append(line); }
      const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.th');
      if (t && host.contains(t)) { const r = t.getBoundingClientRect(), after = host.id === 'sorter' ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2; to = +t.dataset.i + (after ? 1 : 0); const hr = host.getBoundingClientRect(); line.style.cssText = host.id === 'sorter' ? `left:${(after ? r.right : r.left) - hr.left - 2}px;top:${r.top - hr.top + host.scrollTop}px;height:${r.height}px;width:3px` : `top:${(after ? r.bottom : r.top) - hr.top + host.scrollTop - 2}px;left:4px;right:4px;height:3px`; }
      const hr = host.getBoundingClientRect();
      if (ev.clientY < hr.top + 30) host.scrollTop -= 12; else if (ev.clientY > hr.bottom - 30) host.scrollTop += 12;
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (line) { line.remove(); if (to >= 0) this.moveSlides([...this.rsel], to); } };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  moveSlides(idx, to) {
    idx.sort((a, b) => a - b);
    const sl = this.deck.slides, moving = idx.map((i) => sl[i]), curS = this.slide;
    const before = idx.filter((i) => i < to).length;
    if (idx.every((i, k) => i === to - before + k)) return;
    this.edit(() => {
      this.deck.slides = sl.filter((_, i) => !idx.includes(i));
      this.deck.slides.splice(to - before, 0, ...moving);
      this.rsel = new Set(moving.map((_, k) => to - before + k));
      this.cur = this.deck.slides.indexOf(curS);
    });
  }

  // ---------- slide editor ----------
  zoom() { const r = this.sw.getBoundingClientRect(); return Math.max(0.05, Math.min((r.width - 28) / this.deck.w, (r.height - 28) / this.deck.h) * this.zf); }
  renderStage() {
    if (this.editing) return;
    const d = this.deck, z = (this.z = this.zoom());
    this.frame.style.width = d.w * z + 'px'; this.frame.style.height = d.h * z + 'px';
    this.stage.style.cssText = `width:${d.w}px;height:${d.h}px;transform:scale(${z})`;
    const html = slideHTML(this.slide, d, this.cur);
    if (html !== this.lastHtml) { this.stage.innerHTML = html; this.lastHtml = html; }
    this.drawSel();
  }
  drawSel(guides = []) {
    const z = this.z, out = [];
    for (const k of this.sel) {
      const b = this.box(k);
      if (!b) continue;
      out.push(`<div class="sel" style="left:${b.x * z}px;top:${b.y * z}px;width:${b.w * z}px;height:${b.h * z}px${b.rot ? `;transform:rotate(${b.rot}deg)` : ''}"></div>`);
      if (this.sel.length === 1 && !this.editing) for (const [n, x, y] of [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]]) out.push(`<div class="hd" data-h="${n}" style="left:${(b.x + b.w * x) * z - 5}px;top:${(b.y + b.h * y) * z - 5}px;cursor:${n}-resize"></div>`);
    }
    for (const [ax, v] of guides) out.push(`<div class="guide ${ax}" style="${ax === 'x' ? 'left' : 'top'}:${v * z}px"></div>`);
    this.ovl.innerHTML = out.join('');
  }
  select(keys) { this.sel = keys; this.drawSel(); const b = keys.length === 1 && this.box(keys[0]); $('#live').textContent = b ? `Selected ${b.t === 'pic' ? 'picture' : b.t === 'table' ? 'table' : b.paras ? 'text: ' + b.paras.map((p) => p.r.map((r) => r.t).join('')).join(' ').slice(0, 60) : 'shape'}` : ''; }
  movable(k) { return k && !/^dge:/.test(k); }
  setGeom(s, k, g) { const el = s.els.find((e) => e.id === k), r = {}; for (const x in g) r[x] = Math.round(g[x] * 10) / 10; if (el) Object.assign(el, r); else s.ov[k] = { ...s.ov[k], ...r }; }
  stageDown(e) {
    if (e.button > 0) return;
    if (this.editing && this.editing.el.contains(e.target)) return;
    this.commitText();
    this.sw.focus({ preventScroll: true });
    const hd = e.target.dataset && e.target.dataset.h, kel = e.target.closest('#stage [data-k]'), k = kel && kel.dataset.k;
    if (!hd) {
      if (!this.movable(k)) { this.select([]); return; }
      if (e.shiftKey || e.ctrlKey) { this.select(this.sel.includes(k) ? this.sel.filter((x) => x !== k) : [...this.sel, k]); return; }
      if (!this.sel.includes(k)) this.select([k]);
    }
    const z = this.z, sx = e.clientX, sy = e.clientY, d = this.deck;
    const start = this.sel.map((x) => { const b = this.box(x); return b && { k: x, x: b.x, y: b.y, w: b.w, h: b.h, pic: b.t === 'pic' }; }).filter(Boolean);
    if (!start.length) return;
    const others = this.L.boxes.filter((b) => !this.sel.includes(b.k) && !b.d && b.t !== 'line');
    const XS = [0, d.w / 2, d.w, ...others.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w])], YS = [0, d.h / 2, d.h, ...others.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h])];
    let moved = false, cur = start;
    const move = (ev) => {
      let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / z) return;
      moved = true;
      const guides = [];
      if (hd) {
        const o = start[0], n = { ...o };
        if (/w/.test(hd)) { n.x = o.x + dx; n.w = o.w - dx; } if (/e/.test(hd)) n.w = o.w + dx;
        if (/n/.test(hd)) { n.y = o.y + dy; n.h = o.h - dy; } if (/s/.test(hd)) n.h = o.h + dy;
        if ((o.pic || ev.shiftKey) && o.w && o.h && hd.length === 2) { const r = o.w / o.h; if (n.w / n.h > r) n.w = n.h * r; else n.h = n.w / r; if (/w/.test(hd)) n.x = o.x + o.w - n.w; if (/n/.test(hd)) n.y = o.y + o.h - n.h; }
        n.w = Math.max(8, n.w); n.h = Math.max(4, n.h);
        cur = [n];
      } else {
        const bx = Math.min(...start.map((b) => b.x)), by = Math.min(...start.map((b) => b.y)), bw = Math.max(...start.map((b) => b.x + b.w)) - bx, bh = Math.max(...start.map((b) => b.y + b.h)) - by;
        if (!ev.altKey) { // snap edges and centres to the slide and to other boxes
          const snap = (p, size, list, ax) => { let best = 6 / z, off = 0, at = null; for (const f of [0, 0.5, 1]) for (const t of list) { const df = t - (p + size * f); if (Math.abs(df) < best) { best = Math.abs(df); off = df; at = t; } } if (at !== null) guides.push([ax, at]); return off; };
          dx += snap(bx + dx, bw, XS, 'x'); dy += snap(by + dy, bh, YS, 'y');
        }
        cur = start.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy }));
      }
      for (const b of cur) { const el = this.stage.querySelector(`[data-k="${CSS.escape(b.k)}"]`); if (el) Object.assign(el.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' }); }
      const keep = this.sel; this.ovl.innerHTML = ''; this.drawSelRects(cur, guides); this.sel = keep;
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      if (moved) this.edit(() => cur.forEach((b) => this.setGeom(this.slide, b.k, { x: b.x, y: b.y, w: b.w, h: b.h })));
      else this.drawSel();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  drawSelRects(list, guides) {
    const z = this.z;
    this.ovl.innerHTML = list.map((b) => `<div class="sel" style="left:${b.x * z}px;top:${b.y * z}px;width:${b.w * z}px;height:${b.h * z}px"></div>`).join('') + guides.map(([ax, v]) => `<div class="guide ${ax}" style="${ax === 'x' ? 'left' : 'top'}:${v * z}px"></div>`).join('');
  }
  stageDbl(e) {
    const kel = e.target.closest('#stage [data-k]'), k = kel && kel.dataset.k;
    if (k) return this.editBox(k);
    const r = this.frame.getBoundingClientRect(), x = (e.clientX - r.left) / this.z, y = (e.clientY - r.top) / this.z;
    if (!this.slide.title) { this.edit(() => { this.slide.title = { r: [{ t: 'Title' }], lvl: 0, bu: 0 }; }); this.editBox('title', true); return; }
    this.cmd('textbox', { x: x - 100, y: y - 20 });
  }
  editBox(k, all) {
    const b = this.box(k);
    if (!b) return;
    if (b.t === 'table') return this.cmd('table');
    if (/^dg/.test(k)) return this.cmd('diagram');
    if (b.t === 'pic') return this.cmd('alt', k);
    const bnd = binding(this.slide, k), el = this.stage.querySelector(`[data-k="${CSS.escape(k)}"] .tx`);
    if (!bnd) { if (b.t === 'shape' && !b.paras && this.slide.els.find((x) => x.id === k)) { this.edit(() => { this.slide.els.find((x) => x.id === k).paras = [{ r: [], lvl: 0, bu: 0, al: 'ctr' }]; this.slide.els.find((x) => x.id === k).an = 'ctr'; }); return this.editBox(k, all); } return toast('This part comes from the layout. Edit it in the outline.'); }
    if (!el) return;
    if (!el.firstChild) el.innerHTML = `<div data-l="0" data-u="0" style="font-size:${(b.base || [18])[0] * (b.fs || 1)}px"><br></div>`;
    this.editing = { k, el, b, bnd, s: this.slide };
    this.select([k]);
    el.contentEditable = 'true'; el.parentNode.style.zIndex = 9; el.spellcheck = true;
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); if (!all) r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    el.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && ev.ctrlKey)) { ev.preventDefault(); this.commitText(); this.sw.focus(); }
      else if (ev.key === 'Tab') {
        ev.preventDefault();
        let p = getSelection().anchorNode;
        while (p && p.parentNode !== el) p = p.parentNode;
        if (p && p.dataset) { const l = clamp((+p.dataset.l || 0) + (ev.shiftKey ? -1 : 1), 0, 4); p.dataset.l = l; if (k === 'body' || /^cb/.test(k)) p.dataset.u = p.dataset.u === 'n' ? 'n' : '1'; p.style.marginLeft = l * IND + (+p.dataset.u || p.dataset.u === 'n' ? HANG : 0) + 'px'; const bs = b.base || BODY; p.style.fontSize = bs[Math.min(l, bs.length - 1)] * (b.fs || 1) + 'px'; }
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); this.commitText(); this.cmd('save'); }
    };
    el.onblur = () => setTimeout(() => { if (this.editing && this.editing.el === el && !el.contains(document.activeElement)) this.commitText(); }, 0);
    this.drawSel();
  }
  readParas(el, b) {
    const base = getComputedStyle(el), fs = b.fs || 1, out = [];
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 1 || n.textContent.trim());
    for (const d of nodes) {
      const runs = [], lvl = +(d.dataset && d.dataset.l) || 0;
      const walk = (n) => {
        if (n.nodeType === 3) {
          if (!n.textContent) return;
          const cs = getComputedStyle(n.parentNode), r = { t: n.textContent };
          if (+cs.fontWeight >= 600 && +base.fontWeight < 600) r.b = 1;
          if (cs.fontStyle === 'italic' && base.fontStyle !== 'italic') r.i = 1;
          for (let a = n.parentNode; a && a !== el; a = a.parentNode) { const t = getComputedStyle(a).textDecorationLine; if (/underline/.test(t) || a.tagName === 'U') r.u = 1; if (/line-through/.test(t) || a.tagName === 'S' || a.tagName === 'STRIKE') r.s = 1; }
          const c = hex(cs.color);
          if (c !== hex(base.color)) r.c = c;
          const z = parseFloat(cs.fontSize) / fs, bz = (b.base || BODY)[Math.min(lvl, (b.base || BODY).length - 1)];
          if (Math.abs(z - bz) > 0.6) r.z = Math.round(z * 2) / 2;
          runs.push(r);
        } else if (n.nodeType === 1) {
          if (n.dataset && n.dataset.b) return;
          if (n.tagName === 'BR') { if (n.nextSibling || n.previousSibling) runs.push({ t: '\n' }); return; }
          n.childNodes.forEach(walk);
        }
      };
      walk(d);
      const al = { center: 'ctr', right: 'r', justify: 'just' }[d.style && d.style.textAlign];
      const p = { r: mergeRuns(runs).filter((r, i, a) => !(r.t === '\n' && i === a.length - 1)), lvl, bu: d.dataset && d.dataset.u === 'n' ? 'n' : +(d.dataset && d.dataset.u) ? 1 : 0 };
      if (al && al !== b.al) p.al = al;
      out.push(p);
    }
    while (out.length && !out[out.length - 1].r.length) out.pop();
    return out;
  }
  commitText() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const paras = this.readParas(ed.el, ed.b);
    ed.el.contentEditable = 'false';
    if (JSON.stringify(paras) !== JSON.stringify(ed.bnd.get())) { this.push(); ed.bnd.set(paras); this.changed(); } else { this.lastHtml = null; this.renderStage(); }
  }

  // ---------- recovery copy in IndexedDB ----------
  idb() { return new Promise((res, rej) => { const q = indexedDB.open('slidestudio', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  scheduleSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(async () => {
      try {
        const json = JSON.stringify({ title: this.title, at: Date.now(), deck: this.deck });
        if (json.length > 60e6) return;
        (await this.idb()).transaction('kv', 'readwrite').objectStore('kv').put(json, 'recovery');
        $('#saved').textContent = 'Recovery copy saved';
      } catch { /* private mode */ }
    }, 1500);
  }
  async checkRecovery() {
    try {
      const db = await this.idb(), json = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('recovery'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      if (!json || this.modified) return;
      const d = JSON.parse(json);
      if (!d.deck || !d.deck.slides) return;
      const bar = h('div', { class: 'banner', role: 'alert' }, `Unsaved presentation "${d.title}" from ${new Date(d.at).toLocaleString()} was found.`,
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => { this.setDeck(d.deck, d.title); bar.remove(); } }, 'Restore'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => bar.remove() }, 'Dismiss'));
      $('#app').insertBefore(bar, $('#bar'));
    } catch { /* none */ }
  }
  setDeck(deck, name = '') {
    this.commitText();
    document.querySelector('.banner')?.remove();
    this.deck = deck; this.cur = 0; this.sel = []; this.rsel = new Set([0]); this.undoS = []; this.redoS = []; this.lastSnap = null; this.handle = null;
    this.thumbs.forEach((e) => e.remove()); this.thumbs.clear(); this.sthumbs.forEach((e) => e.remove()); this.sthumbs.clear();
    $('#title').value = name.replace(/\.[^.]+$/, '') || 'Untitled presentation';
    this.modified = false; this.updateTitle(); this.lastHtml = null;
    this.ol.blur(); this.render(); this.ol.scrollTop = 0; this.rail.scrollTop = 0;
  }

  // ---------- events ----------
  bind() {
    this.ol.addEventListener('input', () => { clearTimeout(this.ot); this.ot = setTimeout(() => this.applyOutline(), 180); });
    const caret = () => { const i = this.caretSlide(); if (i !== this.cur && this.ol.value === this.olText) { this.cur = i; this.rsel = new Set([i]); this.sel = []; this.render({ outline: false }); this.scrollRail(); } };
    this.ol.addEventListener('click', caret);
    this.ol.addEventListener('keyup', (e) => { if (/Arrow|Page|Home|End/.test(e.key)) caret(); });
    this.ol.addEventListener('blur', () => { clearTimeout(this.ot); this.applyOutline(); this.syncOutline(); });
    this.ol.addEventListener('paste', (e) => this.cmd('outlinePaste', e));
    this.ol.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.ctrlKey) { e.preventDefault(); const a = this.ol.selectionStart, b = this.ol.selectionEnd, v = this.ol.value, ls = v.lastIndexOf('\n', a - 1) + 1; if (e.shiftKey) { if (v.slice(ls, ls + 2) === '  ') { this.ol.setRangeText('', ls, ls + 2, 'preserve'); } } else this.ol.setRangeText('  ', ls, ls, 'preserve'); this.ol.selectionStart = a + (e.shiftKey ? -2 : 2); this.ol.selectionEnd = b + (e.shiftKey ? -2 : 2); this.ol.dispatchEvent(new Event('input')); } });
    this.notes.addEventListener('input', () => { this.push('notes'); this.slide.notes = this.notes.value; this.changed({ light: true }); });
    this.rail.addEventListener('scroll', () => this.renderRail());
    $('#sorter').addEventListener('scroll', () => this.renderSorter());
    this.rail.addEventListener('pointerdown', (e) => this.listDown(e, this.rail));
    $('#sorter').addEventListener('pointerdown', (e) => this.listDown(e, $('#sorter')));
    $('#sorter').addEventListener('dblclick', (e) => { const t = e.target.closest('.th'); if (t) { this.cmd('view', 'edit'); this.go(+t.dataset.i); } });
    for (const host of [this.rail, $('#sorter')]) host.addEventListener('contextmenu', (e) => { const t = e.target.closest('.th'); if (!t) return; e.preventDefault(); if (!this.rsel.has(+t.dataset.i)) this.go(+t.dataset.i); this.cmd('slideMenu', { x: e.clientX, y: e.clientY }); });
    this.frame.addEventListener('pointerdown', (e) => this.stageDown(e));
    this.frame.addEventListener('dblclick', (e) => this.stageDbl(e));
    this.sw.addEventListener('pointerdown', (e) => { if (e.target === this.sw) { this.commitText(); this.select([]); } });
    this.frame.addEventListener('contextmenu', (e) => { const kel = e.target.closest('#stage [data-k]'); if (kel && this.movable(kel.dataset.k) && !this.sel.includes(kel.dataset.k)) this.select([kel.dataset.k]); if (this.editing) return; e.preventDefault(); this.cmd('boxMenu', { x: e.clientX, y: e.clientY }); });
    this.sw.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); this.setZoom(this.zf * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
    new ResizeObserver(() => { if (!this.editing) { this.renderStage(); this.renderRail(); if (this.view === 'sorter') this.renderSorter(); } }).observe($('#main'));
    $('#title').addEventListener('input', () => this.updateTitle());
    $('#zoom').addEventListener('input', (e) => this.setZoom(e.target.value / 100));
    addEventListener('beforeunload', (e) => { if (this.modified) { e.preventDefault(); e.returnValue = ''; } });
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', (e) => { e.preventDefault(); const f = [...e.dataTransfer.files]; if (f.length) this.cmd(/^image\//.test(f[0].type) ? 'insertImages' : 'openFile', /^image\//.test(f[0].type) ? f : f[0]); });
    $('#filein').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.cmd('openFile', f); });
    $('#imgin').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) this.cmd(this.imgTarget || 'insertImages', f); });
  }
  setZoom(z) { this.zf = clamp(z, 0.25, 4); $('#zoom').value = Math.round(this.zf * 100); this.renderStage(); }
  menuAt(items, e) { menu(items, null, e); }
}

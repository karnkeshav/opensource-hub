// Commands (everything reachable from the Ctrl+K palette), sidebar panels, contextual bar and page organizer.
import { App, COLORS } from './app.js';
import { $, h, icon, toast, dialog, menu, download, pickFile, readFile, fmtSize, hex, rgb01, confirmDlg, promptDlg } from './util.js';
import { PDFDoc } from '../pdf/doc.js';
import { saveFull } from '../pdf/writer.js';
import { Interp, pageMatrix } from '../pdf/interp.js';
import { CanvasDevice } from '../pdf/canvas.js';
import { analyze, layout, findAll, charRects, toMarkdown, toHTML, extractTable, toCSV } from '../pdf/text.js';
import { Dict, Stream, Ref, textOf, normRect } from '../pdf/obj.js';
import * as A from '../pdf/annots.js';
import * as F from '../pdf/forms.js';
import * as E from '../pdf/edit.js';
import * as NAV from '../pdf/nav.js';
import { redactPage, applyRedactAnnots, sanitize, removeHiddenLayers } from '../pdf/redact.js';
import { newAES256, PERMS } from '../pdf/security.js';
import { zip } from '../pdf/zip.js';
import { decodeImage } from '../pdf/image.js';

const P = App.prototype;
const base = (app) => app.name.replace(/\.pdf$/i, '');
const need = (app) => { if (!app.doc) { toast('Open a PDF first'); return false; } return true; };
const allPages = (app) => app.doc.pages.map((_, i) => i);
const pagesFrom = (app, spec) => { const s = String(spec || '').trim(); if (!s || /^all$/i.test(s)) return allPages(app); if (/^current$/i.test(s)) return [app.cur]; return E.parseRanges(s, app.doc.pageCount).flat(); };
const pagesField = (app, v = 'all') => ({ name: 'pages', label: 'Pages (e.g. all, current, 1-3, 5)', value: v });

// ---------------------------------------------------------------- rendering helpers
async function renderToCanvas(app, i, scale, opts = {}) {
  const page = app.doc.pages[i];
  const [w, h2] = page.size;
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h2 * scale));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await new Interp(app.doc, new CanvasDevice(ctx, pageMatrix(page, scale, 0)), opts).page(page);
  return cv;
}
const canvasBlob = (cv, type = 'image/png', q = 0.92) => new Promise((r) => cv.toBlob((b) => r(b), type, q));
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());
export async function decodeJpeg(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, rgba: x.getImageData(0, 0, bmp.width, bmp.height).data };
}
async function imageFileToX(app, doc, file) {
  const b = await readFile(file);
  if (/jpe?g/i.test(file.type) || (b[0] === 0xff && b[1] === 0xd8)) return E.imageXObject(doc, { jpeg: b });
  if (b[0] === 0x89 && b[1] === 0x50) { const p = E.pngInfo(b); if (p && !p.il && p.bits <= 8 && [0, 2, 3].includes(p.ct) && !p.trns) return E.imageXObject(doc, { png: b }); }
  const bmp = await createImageBitmap(new Blob([b], { type: file.type || 'image/png' }));
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const x = cv.getContext('2d'); x.drawImage(bmp, 0, 0);
  return E.imageXObject(doc, { w: bmp.width, h: bmp.height, rgba: x.getImageData(0, 0, bmp.width, bmp.height).data });
}

// ---------------------------------------------------------------- palette
P.palette = function () {
  if (document.querySelector('.pal')) return;
  const cmds = this.commands.filter((c) => !c.hidden);
  const input = h('input', { type: 'text', placeholder: 'Type a command… (e.g. "merge", "redact", "page numbers")', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pallist', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { class: 'pallist', id: 'pallist', role: 'listbox' });
  const recent = JSON.parse(localStorage.getItem('pdfs-recent') || '[]');
  let items = [], sel = 0;
  const score = (q, s) => {
    if (!q) return 1;
    s = s.toLowerCase(); q = q.toLowerCase();
    const i = s.indexOf(q);
    if (i >= 0) return 100 - i + (i === 0 || s[i - 1] === ' ' ? 30 : 0);
    let k = 0, sc = 0, last = -2;
    for (let j = 0; j < s.length && k < q.length; j++) if (s[j] === q[k]) { sc += j === last + 1 ? 3 : 1; if (j === 0 || s[j - 1] === ' ') sc += 2; last = j; k++; }
    return k === q.length ? sc : 0;
  };
  const mark = (t, q) => { if (!q) return t; const i = t.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? t : [t.slice(0, i), h('mark', null, t.slice(i, i + q.length)), t.slice(i + q.length)]; };
  const draw = () => {
    const q = input.value.trim();
    items = cmds.map((c) => ({ c, s: Math.max(score(q, c.title) * 2, score(q, c.group + ' ' + c.title + ' ' + (c.kw || ''))) + (!q && recent.includes(c.id) ? 50 - recent.indexOf(c.id) : 0) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = '';
    items.forEach((x, k) => list.append(h('li', { role: 'option', id: 'po' + k, 'aria-selected': String(k === sel), onmousedown: (e) => { e.preventDefault(); go(k); }, onmousemove: () => { if (sel !== k) { sel = k; draw(); } } }, h('span', { class: 'pc' }, x.c.group), h('span', null, mark(x.c.title, q)), x.c.key ? h('span', { class: 'pk' }, x.c.key) : null)));
    input.setAttribute('aria-activedescendant', 'po' + sel);
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { pal.remove(); };
  const go = (k) => {
    const x = items[k]; if (!x) return;
    close();
    const r = [x.c.id, ...recent.filter((id) => id !== x.c.id)].slice(0, 8);
    localStorage.setItem('pdfs-recent', JSON.stringify(r));
    this.run(x.c.id);
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const pal = h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette', onmousedown: (e) => { if (e.target === pal) close(); } }, h('div', { class: 'palbox' }, input, list));
  document.body.append(pal);
  draw(); input.focus();
};
P.run = async function (id, arg) {
  const c = this.commands.find((x) => x.id === id);
  if (!c) return;
  if (c.doc !== false && !need(this)) return;
  try { await c.run(this, arg); } catch (e) { console.error(e); toast((c.title || id) + ': ' + (e.message || e), 7000); }
};
const CMDS = [];
const cmd = (group, id, title, run, o = {}) => CMDS.push({ group, id, title, run, ...o });

// ---------------------------------------------------------------- panels
P.panel = function (p) {
  this.curPanel = p;
  document.querySelectorAll('.stabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p === p)));
  const el = $('#spanel'); el.innerHTML = '';
  if (!this.doc) return;
  if (this.app.classList.contains('noside')) this.app.classList.remove('noside');
  PANELS[p](this, el);
};
P.panelRefresh = function () { if (this.curPanel && this.curPanel !== 'thumbs') this.panel(this.curPanel); };
P.thumbDirty = function (i) { const t = document.querySelector(`.thumb[data-i="${i}"] canvas`); if (t) { t.dataset.done = ''; this.thumbObs?.observe(t.parentElement); } };
const PANELS = {
  thumbs(app, el) {
    const labels = app.labels();
    app.thumbObs?.disconnect();
    app.thumbObs = new IntersectionObserver(async (ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        const b = en.target, i = +b.dataset.i, cv = b.querySelector('canvas');
        if (cv.dataset.done) continue;
        cv.dataset.done = '1';
        app.thumbObs.unobserve(b);
        try { const r = await renderToCanvas(app, i, 150 / Math.max(...app.doc.pages[i].size)); cv.width = r.width; cv.height = r.height; cv.getContext('2d').drawImage(r, 0, 0); r.width = 0; } catch {}
      }
    }, { root: el });
    app.doc.pages.forEach((p, i) => {
      const [w, hh] = p.size, k = 150 / Math.max(w, hh);
      const b = h('button', { class: 'thumb', type: 'button', 'data-i': i, 'aria-label': 'Page ' + labels[i], 'aria-current': i === app.cur ? 'true' : null, onclick: () => app.goto(i), oncontextmenu: (e) => { e.preventDefault(); app.goto(i); pageMenu(app, [i], e); } },
        h('canvas', { width: Math.round(w * k), height: Math.round(hh * k), style: { width: Math.round(w * k) + 'px' } }), labels[i]);
      el.append(b); app.thumbObs.observe(b);
    });
  },
  outline(app, el) {
    const tree = NAV.outline(app.doc);
    el.append(h('div', { class: 'ptools' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('bookmark-add') }, '+ Bookmark'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('bookmarks-edit') }, 'Edit'),
      tree.length ? h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('split-bookmarks') }, 'Split by') : null));
    if (!tree.length) { el.append(h('p', { class: 'muted small' }, 'No bookmarks. Add one for the current page, or select text first to use it as the title.')); return; }
    const mk = (items) => h('ul', { class: 'tree' }, items.map((it) => h('li', null, h('button', { class: 'it', type: 'button', style: { fontWeight: it.flags & 2 ? 700 : 400, fontStyle: it.flags & 1 ? 'italic' : 'normal' }, onclick: () => { if (it.target?.dest) app.goto(it.target.dest.page, it.target.dest.y); else if (it.target?.uri) app.followLink(new Dict({ A: new Dict() })); } }, it.title || '(untitled)'), it.kids.length ? mk(it.kids) : null)));
    el.append(mk(tree));
  },
  comments(app, el) {
    const list = A.listAnnots(app.doc).filter((a) => !['Link', 'Widget'].includes(a.type));
    el.append(h('div', { class: 'ptools' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('comments-export') }, 'Export'),
      list.length ? h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('flatten-annots') }, 'Flatten all') : null,
      list.length ? h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('delete-comments') }, 'Delete all') : null));
    if (!list.length) { el.append(h('p', { class: 'muted small' }, 'No comments yet. Use Highlight, Comment or Draw.')); return; }
    const names = { Text: 'Note', FreeText: 'Text box', StrikeOut: 'Strikethrough', Square: 'Rectangle', Circle: 'Ellipse', Ink: 'Drawing', Redact: 'Redaction mark' };
    for (const a of list) {
      el.append(h('div', { class: 'citem', tabindex: 0, role: 'button', 'aria-label': (names[a.type] || a.type) + ' on page ' + (a.page + 1), onclick: () => { app.goto(a.page, a.rect[3]); app.setTool('select'); app.selAnnot = { page: a.page, ref: a.ref, rect: a.rect, type: a.type, dict: a.dict }; app.drawOverlay(); app.updateCtx(); }, onkeydown: (e) => { if (e.key === 'Enter') e.target.click(); } },
        h('div', { class: 'meta' }, h('span', { style: { color: a.color.length === 3 ? hex(a.color) : 'inherit' } }, '●'), names[a.type] || a.type, h('span', null, 'p.' + (a.page + 1)), a.author ? h('span', null, a.author) : null, a.date ? h('span', null, a.date.toLocaleDateString()) : null),
        a.contents ? h('div', { class: 'cbody' }, a.contents) : null));
    }
  },
  fields(app, el) {
    const fs = F.fields(app.doc);
    el.append(h('div', { class: 'ptools' },
      h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(!!app.formMode), onclick: () => { app.setFormMode(!app.formMode); app.panel('fields'); } }, app.formMode ? 'Stop filling' : 'Fill form'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('field-create') }, '+ Field'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('fields-detect') }, 'Detect'),
      fs.length ? h('button', { class: 'btn sm', type: 'button', onclick: () => app.run('smart-fill') }, 'Smart fill') : null));
    if (!fs.length) { el.append(h('p', { class: 'muted small' }, 'This document has no form fields. Create them, or let "Detect" find blanks, lines and boxes.')); return; }
    for (const f of fs) el.append(h('div', { class: 'citem', tabindex: 0, role: 'button', onclick: () => { const w = f.widgets[0]; if (w && w.page >= 0) { app.goto(w.page, w.rect[3]); if (!app.formMode) app.setFormMode(true); setTimeout(() => document.querySelector(`.fw[data-f="${CSS.escape(f.name)}"]`)?.focus(), 300); } } },
      h('div', { class: 'meta' }, f.type, f.required ? h('span', null, 'required') : null, f.readonly ? h('span', null, 'read-only') : null), h('div', { class: 'cbody' }, f.name + (f.value !== '' && f.value !== undefined ? ' = ' + (Array.isArray(f.value) ? f.value.join(', ') : f.value) : ''))));
  },
};

// ---------------------------------------------------------------- contextual bar
const chip = (label, on, fn, title) => h('button', { class: 'chip', type: 'button', 'aria-pressed': on === undefined ? null : String(!!on), onclick: fn, title: title || label }, label);
const sep = () => h('span', { class: 'sep' });
function swatches(app, key, onPick) {
  const cur = app.st.color[key];
  return [...COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': 'Colour ' + c, 'aria-pressed': String(c === cur), onclick: () => { app.st.color[key] = c; onPick && onPick(c); app.updateCtx(); } })),
    h('input', { type: 'color', value: cur, 'aria-label': 'Custom colour', style: { width: '28px', height: '26px', border: 0, background: 'none' }, onchange: (e) => { app.st.color[key] = e.target.value; onPick && onPick(e.target.value); app.updateCtx(); } })];
}
const rng = (label, val, min, max, step, fn) => [h('span', { class: 'lab' }, label), h('input', { type: 'range', min, max, step, value: val, 'aria-label': label, onchange: (e) => fn(+e.target.value) })];
App.prototype.ctxBuilder = function (app) {
  const bar = $('#ctx'); bar.innerHTML = '';
  const add = (...x) => bar.append(...x.flat().filter(Boolean));
  const t = app.tool;
  if (!app.doc) { bar.classList.remove('on'); return; }
  if (t === 'select') {
    if (app.selAnnot) {
      const a = app.selAnnot;
      add(h('span', { class: 'lab' }, a.type));
      if (!['Link', 'Widget', 'Redact', 'Stamp'].includes(a.type)) add(swatches(app, a.type === 'Ink' || a.type === 'Line' || a.type === 'Square' || a.type === 'Circle' || a.type === 'Polygon' ? 'draw' : 'markup', (c) => app.edit('Colour', () => A.updateAnnot(app.doc, a.ref, { color: rgb01(c) }), [a.page])));
      if (['Ink', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine'].includes(a.type)) add(rng('Width', app.st.width, 0.5, 12, 0.5, (v) => { app.st.width = v; app.edit('Width', () => A.updateAnnot(app.doc, a.ref, { width: v }), [a.page]); }));
      add(rng('Opacity', 1, 0.1, 1, 0.05, (v) => app.edit('Opacity', () => A.updateAnnot(app.doc, a.ref, { opacity: v }), [a.page])));
      add(sep(), chip(a.type === 'FreeText' ? 'Edit text' : 'Comment', undefined, () => app.editComment(a)), chip('Flatten', undefined, () => app.run('flatten-selected')), chip('Delete', undefined, () => app.deleteSelected()));
    } else if (app.selObj) {
      add(h('span', { class: 'lab' }, app.selObj.kind === 'form' ? 'Graphic' : 'Image'), chip('Delete', undefined, () => app.deleteSelected()), h('span', { class: 'lab' }, 'Drag to move, handles to resize'));
    } else if (app.sel) {
      add(chip('Copy', undefined, () => { navigator.clipboard?.writeText(app.selectedText()); toast('Copied'); }), sep(),
        chip('Highlight', undefined, () => app.markupSelection('Highlight')), chip('Underline', undefined, () => app.markupSelection('Underline')), chip('Strike', undefined, () => app.markupSelection('StrikeOut')), chip('Squiggly', undefined, () => app.markupSelection('Squiggly')), sep(),
        chip('Redact', undefined, () => app.markupSelection('Redact')), chip('Bookmark', undefined, () => app.run('bookmark-add')), chip('Find all', undefined, () => { $('#findbar').hidden = false; $('#q').value = app.selectedText().slice(0, 80); app.search(); }));
    }
  } else if (t === 'markup') {
    for (const [k, l] of [['Highlight', 'Highlight'], ['Underline', 'Underline'], ['StrikeOut', 'Strike'], ['Squiggly', 'Squiggly']]) add(chip(l, app.sub.markup === k, () => { app.sub.markup = k; app.updateCtx(); }));
    add(sep(), swatches(app, 'markup'), sep(), h('span', { class: 'lab' }, 'Drag across text'));
  } else if (t === 'note') {
    add(chip('Sticky note', app.sub.note === 'Text', () => { app.sub.note = 'Text'; app.updateCtx(); }), chip('Stamp', app.sub.note === 'Stamp', () => { app.sub.note = 'Stamp'; app.updateCtx(); }));
    if (app.sub.note === 'Stamp') add(h('select', { 'aria-label': 'Stamp', onchange: (e) => (app.st.stamp = e.target.value) }, ['APPROVED', 'DRAFT', 'CONFIDENTIAL', 'FINAL', 'REVIEWED', 'NOT APPROVED', 'FOR COMMENT', 'VOID'].map((s) => h('option', { selected: s === app.st.stamp }, s))));
    add(sep(), swatches(app, 'note'), sep(), h('span', { class: 'lab' }, 'Click on the page'));
  } else if (t === 'draw') {
    for (const [k, l] of [['Ink', 'Pen'], ['Line', 'Line'], ['Arrow', 'Arrow'], ['Rect', 'Rectangle'], ['Ellipse', 'Ellipse'], ['Polygon', 'Polygon'], ['Image', 'Image']]) add(chip(l, app.sub.draw === k, () => { app.sub.draw = k; app.updateCtx(); }));
    add(sep(), swatches(app, 'draw'), rng('Width', app.st.width, 0.5, 12, 0.5, (v) => (app.st.width = v)), rng('Opacity', app.st.opacity, 0.1, 1, 0.05, (v) => (app.st.opacity = v)));
  } else if (t === 'text') {
    add(chip('Text box', app.sub.text === 'FreeText', () => { app.sub.text = 'FreeText'; app.setTool('text'); }, 'Add a text box comment'), chip('Page text', app.sub.text === 'page', () => { app.sub.text = 'page'; app.setTool('text'); }, 'Add text into the page content'), chip('Edit text', app.sub.text === 'edit', () => { app.sub.text = 'edit'; app.setTool('text'); }, 'Edit existing text'));
    add(sep(), h('span', { class: 'lab' }, 'Size'), h('input', { type: 'number', min: 4, max: 144, value: app.st.fontSize, style: { width: '64px' }, 'aria-label': 'Font size', onchange: (e) => (app.st.fontSize = +e.target.value || 12) }), swatches(app, 'text'));
  } else if (t === 'sign') {
    add(chip('New signature', undefined, () => app.run('create-signature')), app.signature ? h('span', { class: 'lab' }, 'Click the page to place your signature') : null, sep(), chip('Digital signature…', undefined, () => app.run('digital-sign')), chip('Verify signatures', undefined, () => app.run('verify-signatures')));
  } else if (t === 'redact') {
    const n = A.listAnnots(app.doc).filter((a) => a.type === 'Redact').length;
    add(chip('Mark area', app.sub.redact === 'area', () => { app.sub.redact = 'area'; app.updateCtx(); }), chip('Mark text', app.sub.redact === 'text', () => { app.sub.redact = 'text'; app.updateCtx(); }), chip('Find & redact…', undefined, () => app.run('find-redact')), sep(),
      h('button', { class: 'chip dang', type: 'button', disabled: !n, onclick: () => app.run('apply-redactions') }, `Apply ${n} redaction${n === 1 ? '' : 's'}`), chip('Sanitize…', undefined, () => app.run('sanitize')));
  }
  bar.classList.toggle('on', bar.childElementCount > 0);
};
P.showRedactMarks = function () { this.updateCtx(); };

// ---------------------------------------------------------------- organizer
P.toggleOrganizer = function () {
  if (!need(this)) return;
  this.organizer = !this.organizer;
  $('#org').hidden = !this.organizer; this.pagesEl.hidden = this.organizer;
  $('#b-org').setAttribute('aria-pressed', String(this.organizer));
  if (this.organizer) this.renderOrganizer(); else this.layout(true);
};
P.renderOrganizer = function () {
  const app = this, el = $('#org');
  app.orgSel = app.orgSel || new Set([app.cur]);
  el.innerHTML = '';
  const sel = () => [...app.orgSel].filter((i) => i < app.doc.pageCount).sort((a, b) => a - b);
  const act = (label, fn) => h('button', { class: 'btn sm', type: 'button', onclick: fn }, label);
  el.append(h('div', { class: 'orgbar', role: 'toolbar', 'aria-label': 'Page actions' },
    h('b', null, 'Organize pages'), h('span', { class: 'muted small' }, `${sel().length} selected · drag to reorder`),
    act('Rotate left', () => app.edit('Rotate pages', () => E.rotatePages(app.doc, sel(), -90))),
    act('Rotate right', () => app.edit('Rotate pages', () => E.rotatePages(app.doc, sel(), 90))),
    act('Duplicate', () => app.edit('Duplicate pages', () => E.duplicatePages(app.doc, sel()))),
    act('Delete', () => app.edit('Delete pages', () => E.deletePages(app.doc, sel())).then(() => app.orgSel.clear())),
    act('Insert blank', () => app.edit('Insert page', () => E.insertBlank(app.doc, (sel().pop() ?? app.doc.pageCount - 1) + 1))),
    act('Insert PDF…', () => app.run('insert-pdf', (sel().pop() ?? app.doc.pageCount - 1) + 1)),
    act('Extract…', () => app.run('extract-pages', sel())),
    act('Split…', () => app.run('split')),
    act('Done', () => app.toggleOrganizer())));
  let dragFrom = null;
  app.doc.pages.forEach((p, i) => {
    const [w, hh] = p.size, k = 140 / Math.max(w, hh);
    const cv = h('canvas', { width: Math.round(w * k), height: Math.round(hh * k) });
    const card = h('div', { class: 'oc' + (app.orgSel.has(i) ? ' sel' : ''), draggable: 'true', tabindex: 0, role: 'option', 'aria-selected': String(app.orgSel.has(i)), 'aria-label': 'Page ' + (i + 1) }, cv, String(i + 1) + (p.rotate ? ` · ${p.rotate}°` : ''));
    card.addEventListener('click', (e) => {
      if (e.shiftKey && app.orgLast !== undefined) { const [a, b] = [Math.min(app.orgLast, i), Math.max(app.orgLast, i)]; for (let k2 = a; k2 <= b; k2++) app.orgSel.add(k2); }
      else if (e.ctrlKey || e.metaKey) { app.orgSel.has(i) ? app.orgSel.delete(i) : app.orgSel.add(i); }
      else { app.orgSel = new Set([i]); }
      app.orgLast = i;
      el.querySelectorAll('.oc').forEach((c, k2) => { c.classList.toggle('sel', app.orgSel.has(k2)); c.setAttribute('aria-selected', String(app.orgSel.has(k2))); });
    });
    card.addEventListener('dblclick', () => { app.toggleOrganizer(); app.goto(i); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Delete') app.edit('Delete pages', () => E.deletePages(app.doc, sel()));
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey) { const to = e.key === 'ArrowLeft' ? Math.max(0, i - 1) : Math.min(app.doc.pageCount, i + 2); app.edit('Move page', () => E.movePages(app.doc, [i], to)).then(() => { app.orgSel = new Set([e.key === 'ArrowLeft' ? Math.max(0, i - 1) : Math.min(app.doc.pageCount - 1, i + 1)]); }); }
      else if (e.key === 'ArrowRight') card.nextElementSibling?.focus(); else if (e.key === 'ArrowLeft') card.previousElementSibling?.focus();
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); card.click(); }
    });
    card.addEventListener('dragstart', (e) => { dragFrom = i; if (!app.orgSel.has(i)) app.orgSel = new Set([i]); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
    card.addEventListener('dragover', (e) => { if (dragFrom === null) return; e.preventDefault(); e.stopPropagation(); el.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); card.classList.add('drop-before'); });
    card.addEventListener('drop', (e) => { if (dragFrom === null) return; e.preventDefault(); e.stopPropagation(); const s2 = sel(); dragFrom = null; app.edit('Reorder pages', () => E.movePages(app.doc, s2, i)).then(() => { app.orgSel = new Set(); }); });
    card.addEventListener('dragend', () => { dragFrom = null; el.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); });
    el.append(card);
    renderToCanvas(app, i, k).then((r) => { cv.getContext('2d').drawImage(r, 0, 0, cv.width, cv.height); r.width = 0; }).catch(() => {});
  });
  el.addEventListener('dragover', (e) => { if (dragFrom !== null) e.preventDefault(); });
  el.addEventListener('drop', (e) => { if (dragFrom === null) return; e.preventDefault(); const s2 = sel(); dragFrom = null; app.edit('Reorder pages', () => E.movePages(app.doc, s2, app.doc.pageCount)); });
};
function pageMenu(app, idx, e) {
  menu([
    { label: 'Rotate right', onclick: () => app.edit('Rotate', () => E.rotatePages(app.doc, idx, 90), idx) },
    { label: 'Rotate left', onclick: () => app.edit('Rotate', () => E.rotatePages(app.doc, idx, -90), idx) },
    { label: 'Duplicate', onclick: () => app.edit('Duplicate page', () => E.duplicatePages(app.doc, idx)) },
    { label: 'Insert blank after', onclick: () => app.edit('Insert page', () => E.insertBlank(app.doc, idx[idx.length - 1] + 1)) },
    { label: 'Extract…', onclick: () => app.run('extract-pages', idx) },
    { sep: 1 }, { label: 'Delete page', onclick: () => app.edit('Delete page', () => E.deletePages(app.doc, idx)) },
  ], null, { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------- File
cmd('File', 'open', 'Open PDF…', (app) => app.openDialog(), { doc: false, key: 'Ctrl+O' });
cmd('File', 'new', 'New blank PDF', (app) => app.newBlank(), { doc: false });
cmd('File', 'save', 'Save', (app) => app.save(), { key: 'Ctrl+S' });
cmd('File', 'save-as', 'Save as…', (app) => app.save(true), { key: 'Ctrl+Shift+S' });
cmd('File', 'save-incremental', 'Save as incremental update (keeps earlier revisions and signatures)', (app) => app.save(true, { incremental: true }), { kw: 'append revision' });
cmd('File', 'save-classic', 'Save copy for old readers (no object streams)', async (app) => { const b = await app.bytesForSave({ objStreams: false, incremental: false }); download(base(app) + '-compat.pdf', b, 'application/pdf'); });
cmd('File', 'print', 'Print…', async (app) => {
  const v = await dialog('Print', [pagesField(app), { name: 'dpi', label: 'Quality', type: 'select', value: 150, options: [[110, 'Draft (110 dpi)'], [150, 'Normal (150 dpi)'], [220, 'High (220 dpi)']] }], { ok: 'Print' });
  if (!v) return;
  const area = $('#printarea'); area.innerHTML = '';
  const pages = pagesFrom(app, v.pages);
  for (const [k, i] of pages.entries()) {
    app.msg(`Preparing page ${k + 1} of ${pages.length}…`);
    const cv = await renderToCanvas(app, i, +v.dpi / 72, { print: true });
    const url = URL.createObjectURL(await canvasBlob(cv, 'image/jpeg', 0.92)); cv.width = 0;
    area.append(h('img', { src: url, alt: '' }));
  }
  app.msg('');
  await Promise.all([...area.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
  window.print();
  setTimeout(() => { area.querySelectorAll('img').forEach((im) => URL.revokeObjectURL(im.src)); area.innerHTML = ''; }, 2000);
}, { key: 'Ctrl+P' });
cmd('File', 'properties', 'Document properties and metadata…', async (app) => {
  const m = NAV.getMeta(app.doc);
  const fonts = new Set();
  for (const p of app.doc.pages.slice(0, 50)) { const f = app.doc.get(p.resources.get('Font')); if (f instanceof Dict) for (const r of f.values()) { const d = app.doc.get(r); if (d instanceof Dict) { const desc = app.doc.get(d.get('FontDescriptor')) || app.doc.get(app.doc.get(d.get('DescendantFonts'))?.[0])?.get?.('FontDescriptor'); const emb = desc instanceof Dict && app.doc.get(desc).has && (app.doc.get(desc).has('FontFile') || app.doc.get(desc).has('FontFile2') || app.doc.get(desc).has('FontFile3')); fonts.add((textOf(app.doc.get(d.get('BaseFont'))) || '?') + (emb ? '' : ' (not embedded)')); } } }
  const info = h('div', { class: 'small muted' }, `PDF ${app.doc.version} · ${app.doc.pageCount} pages · ${fmtSize(app.doc.bytes.length)} · ${app.doc.sec ? 'Encrypted (R' + app.doc.sec.R + ', ' + app.doc.sec.stm + ')' : 'Not encrypted'}${app.doc.repaired ? ' · repaired on open' : ''}`, h('br'), 'Fonts: ' + ([...fonts].slice(0, 30).join(', ') || 'none'), m.CreationDate ? h('div', null, 'Created ' + (NAV && m.CreationDate)) : null);
  const v = await dialog('Document properties', NAV.META_KEYS.map((k) => ({ name: k, label: k, value: m[k] })), { ok: 'Save', extra: info, width: 520 });
  if (v) await app.edit('Edit metadata', () => NAV.setMeta(app.doc, v), []);
}, { kw: 'info title author keywords metadata fonts' });
cmd('File', 'author', 'Set my name for comments…', async (app) => { const v = await promptDlg('Your name', 'Name shown on comments', app.author); if (v !== null) { app.author = v || 'Me'; localStorage.setItem('pdfs-author', app.author); } }, { doc: false });

// ---------------------------------------------------------------- Convert / export
cmd('Convert', 'images-to-pdf', 'Images to PDF…', async (app, files) => {
  files = files || (await pickFile('image/*', true));
  if (!files.length) return;
  const v = await dialog('Images to PDF', [{ name: 'size', label: 'Page size', type: 'select', value: 'fit', options: [['fit', 'Fit each image'], ['a4', 'A4'], ['letter', 'Letter']] }, { name: 'margin', label: 'Margin (pt)', type: 'number', value: 0 }], { ok: 'Create' });
  if (!v) return;
  const d = E.newDoc();
  await d.edit('Images', async () => {
    for (const f of files) {
      const x = await imageFileToX(app, d, f);
      let W = x.w * 0.75, H = x.h * 0.75; // 96 dpi pixels -> points
      if (v.size !== 'fit') { [W, H] = v.size === 'a4' ? [595.28, 841.89] : [612, 792]; if (x.w > x.h && W < H) [W, H] = [H, W]; }
      const pi = d.pageCount; E.addPage(d, W, H);
      const m = +v.margin || 0, s = Math.min((W - 2 * m) / x.w, (H - 2 * m) / x.h), iw = x.w * s, ih = x.h * s;
      E.drawImage(d, pi, x, [(W - iw) / 2, (H - ih) / 2, (W + iw) / 2, (H + ih) / 2]);
    }
  });
  app.setDoc(d, (files.length === 1 ? files[0].name.replace(/\.\w+$/, '') : 'Images') + '.pdf');
  d.dirty = true; app.markDirty();
  toast(`Created a PDF from ${files.length} image${files.length > 1 ? 's' : ''}`);
}, { doc: false, kw: 'jpg png convert scan' });
cmd('Convert', 'export-images', 'Export pages as images (PNG/JPEG)…', async (app) => {
  const v = await dialog('Export pages as images', [pagesField(app, 'current'), { name: 'fmt', label: 'Format', type: 'select', value: 'png', options: [['png', 'PNG'], ['jpeg', 'JPEG']] }, { name: 'dpi', label: 'Resolution (dpi)', type: 'number', value: 150, min: 36, max: 600 }], { ok: 'Export' });
  if (!v) return;
  const pages = pagesFrom(app, v.pages), files = {};
  for (const [k, i] of pages.entries()) {
    app.msg(`Rendering ${k + 1}/${pages.length}…`);
    const cv = await renderToCanvas(app, i, (+v.dpi || 150) / 72, { print: true });
    files[`${base(app)}-p${i + 1}.${v.fmt === 'png' ? 'png' : 'jpg'}`] = await blobBytes(await canvasBlob(cv, 'image/' + v.fmt, 0.9)); cv.width = 0;
  }
  app.msg('');
  const names = Object.keys(files);
  if (names.length === 1) download(names[0], files[names[0]], 'image/' + v.fmt);
  else download(base(app) + '-images.zip', await zip(files), 'application/zip');
}, { kw: 'png jpg render picture snapshot' });
async function docText(app, fmt) {
  const lays = [];
  for (let i = 0; i < app.doc.pageCount; i++) { const t = await app.textNow(i); lays.push(t.lay); if (i % 10 === 0) app.msg(`Reading page ${i + 1}…`); }
  app.msg('');
  if (fmt === 'md') return lays.map((l, i) => `<!-- page ${i + 1} -->\n` + toMarkdown(l)).join('\n\n');
  if (fmt === 'html') return toHTML(lays, NAV.getMeta(app.doc).Title || app.name);
  return lays.map((l) => l.text).join('\n\f\n');
}
cmd('Convert', 'export-text', 'Export as plain text (.txt)', async (app) => download(base(app) + '.txt', await docText(app, 'txt'), 'text/plain;charset=utf-8'), { kw: 'convert txt' });
cmd('Convert', 'export-md', 'Export as Markdown (.md)', async (app) => download(base(app) + '.md', await docText(app, 'md'), 'text/markdown;charset=utf-8'), { kw: 'convert markdown' });
cmd('Convert', 'export-html', 'Export as HTML (.html)', async (app) => download(base(app) + '.html', await docText(app, 'html'), 'text/html;charset=utf-8'), { kw: 'convert web' });
cmd('Convert', 'extract-images', 'Extract embedded images…', async (app) => {
  const files = {}, seen = new Set();
  let n = 0;
  for (let i = 0; i < app.doc.pageCount; i++) {
    const it = new Interp(app.doc, { save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, text() {}, textClip() {}, endTextClip() {}, async image() {}, shade() {}, async tile() { return { c: '#000' }; } }, { noAnnots: true, skipImages: true, onImage: (o) => { if (o.ref instanceof Ref && !seen.has(o.ref.num)) { seen.add(o.ref.num); o.page = i; list.push(o); } } });
    const list = [];
    await it.page(app.doc.pages[i]);
    for (const o of list) {
      const img = decodeImage(app.doc, o.xo, app.doc.pages[i].resources);
      n++;
      if (img.jpeg && !img.alpha) files[`p${i + 1}-img${n}.jpg`] = img.jpeg;
      else if (img.rgba || img.jpeg) {
        const src = img.jpeg ? await decodeJpeg(img.jpeg) : img;
        const cv = document.createElement('canvas'); cv.width = src.w; cv.height = src.h;
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(src.rgba), src.w, src.h), 0, 0);
        files[`p${i + 1}-img${n}.png`] = await blobBytes(await canvasBlob(cv)); cv.width = 0;
      }
    }
  }
  if (!Object.keys(files).length) return toast('No images found');
  download(base(app) + '-images.zip', await zip(files), 'application/zip');
  toast(`Extracted ${Object.keys(files).length} images`);
}, { kw: 'pictures photos save' });
cmd('Convert', 'compress', 'Compress / optimize…', async (app) => {
  const { compress } = await import('../pdf/compress.js');
  const v = await dialog('Compress PDF', [
    { name: 'dpi', label: 'Downsample images above (dpi, 0 = keep)', type: 'number', value: 150 },
    { name: 'q', label: 'JPEG quality (0.3 - 0.95)', type: 'number', value: 0.75, step: 0.05, min: 0.3, max: 0.95 },
    { name: 'meta', label: 'Strip metadata and thumbnails', type: 'checkbox', value: true },
    { name: 'dedupe', label: 'Merge duplicate images and fonts', type: 'checkbox', value: true },
  ], { ok: 'Compress', hint: 'Unused objects are always dropped and object streams are used.' });
  if (!v) return;
  const before = app.doc.bytes.length || (await saveFull(app.doc)).length;
  app.msg('Compressing…');
  const stats = await app.edit('Compress', () => compress(app.doc, { dpi: +v.dpi, quality: +v.q, metadata: v.meta, dedupe: v.dedupe, decodeJpeg, encodeJpeg: async (rgba, w, hh, q) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = hh; cv.getContext('2d').putImageData(new ImageData(rgba, w, hh), 0, 0); const b = await blobBytes(await canvasBlob(cv, 'image/jpeg', q)); cv.width = 0; return b; } }));
  const after = (await saveFull(app.doc, { objStreams: true })).length;
  app.msg('');
  await dialog('Compressed', [], { hint: `Before: ${fmtSize(before)}  →  After: ${fmtSize(after)} (${before ? Math.round((1 - after / before) * 100) : 0}% smaller). ${stats ? stats.images + ' images recompressed, ' + stats.dupes + ' duplicates merged.' : ''} Save to keep the result.`, cancel: null });
}, { kw: 'shrink reduce size optimize' });

// ---------------------------------------------------------------- View
cmd('View', 'fit-width', 'Fit width', (app) => app.setFit('width'), { key: 'Ctrl+0' });
cmd('View', 'fit-page', 'Fit page', (app) => app.setFit('page'));
cmd('View', 'zoom-in', 'Zoom in', (app) => app.setZoom(app.zoom * 1.2), { key: 'Ctrl++' });
cmd('View', 'zoom-out', 'Zoom out', (app) => app.setZoom(app.zoom / 1.2), { key: 'Ctrl+-' });
cmd('View', 'zoom-100', 'Actual size (100%)', (app) => app.setZoom(1));
cmd('View', 'continuous', 'Continuous scrolling', (app) => app.setMode('continuous'));
cmd('View', 'single', 'Single page view', (app) => app.setMode('single'));
cmd('View', 'two', 'Two-page view', (app) => app.setMode('two'), { kw: 'spread book' });
cmd('View', 'rotate-view-cw', 'Rotate view clockwise', (app) => app.rotateView(90));
cmd('View', 'rotate-view-ccw', 'Rotate view counter-clockwise', (app) => app.rotateView(-90));
cmd('View', 'read-mode', 'Full-screen read mode', async (app) => { if (document.fullscreenElement) return document.exitFullscreen(); app.app.classList.add('noside'); await document.documentElement.requestFullscreen?.(); app.setMode('single'); app.setFit('page'); toast('Arrow keys or Page Up/Down to turn pages, Esc to leave'); }, { key: 'F11', kw: 'presentation fullscreen' });
cmd('View', 'tint', 'Dark mode for pages (tint)', (app) => app.app.classList.toggle('tint'), { kw: 'night invert' });
cmd('View', 'theme', 'Switch light / dark theme', (app) => app.toggleTheme(), { doc: false });
cmd('View', 'sidebar', 'Toggle sidebar', (app) => app.toggleSide(), { key: 'F4' });
cmd('View', 'goto', 'Go to page…', async (app) => { const v = await promptDlg('Go to page', 'Page number or label', String(app.cur + 1)); if (v) app.gotoLabel(v); }, { kw: 'jump' });
cmd('View', 'find', 'Find text', (app) => app.openFind(), { key: 'Ctrl+F', kw: 'search' });
for (const [p, l] of [['thumbs', 'Page thumbnails'], ['outline', 'Bookmarks'], ['comments', 'Comments list'], ['fields', 'Form fields list']]) cmd('View', 'panel-' + p, 'Show ' + l, (app) => app.panel(p));
cmd('Edit', 'undo', 'Undo', (app) => app.undo(), { key: 'Ctrl+Z' });
cmd('Edit', 'redo', 'Redo', (app) => app.redo(), { key: 'Ctrl+Y' });
cmd('Edit', 'select-all', 'Select all text on this page', (app) => app.textNow(app.cur).then((t) => { if (t.chars.length) { app.setTool('select'); app.sel = { page: app.cur, a: 0, b: t.chars.length - 1 }; app.drawOverlay(); app.updateCtx(); } }), { key: 'Ctrl+A' });
cmd('Edit', 'edit-mode', 'Edit mode (edit page text)', async (app) => { const m = await import('./sign-ui.js'); m.enterEditMode(app); }, { kw: 'modify change text editor' });
cmd('Edit', 'copy-page-text', 'Copy all text on this page', async (app) => { const t = await app.textNow(app.cur); await navigator.clipboard.writeText(t.lay.text); toast('Copied page text'); });
for (const [id, l, t, s] of [['tool-select', 'Select tool', 'select'], ['tool-hand', 'Hand tool', 'hand'], ['tool-highlight', 'Highlight text', 'markup', ['markup', 'Highlight']], ['tool-underline', 'Underline text', 'markup', ['markup', 'Underline']], ['tool-strike', 'Strikethrough text', 'markup', ['markup', 'StrikeOut']], ['tool-squiggly', 'Squiggly underline', 'markup', ['markup', 'Squiggly']], ['tool-note', 'Sticky note', 'note', ['note', 'Text']], ['tool-stamp', 'Stamp (Approved, Draft…)', 'note', ['note', 'Stamp']], ['tool-pen', 'Draw freehand (pen)', 'draw', ['draw', 'Ink']], ['tool-line', 'Draw line', 'draw', ['draw', 'Line']], ['tool-arrow', 'Draw arrow', 'draw', ['draw', 'Arrow']], ['tool-rect', 'Draw rectangle', 'draw', ['draw', 'Rect']], ['tool-ellipse', 'Draw ellipse', 'draw', ['draw', 'Ellipse']], ['tool-polygon', 'Draw polygon', 'draw', ['draw', 'Polygon']], ['tool-textbox', 'Add text box (comment)', 'text', ['text', 'FreeText']], ['tool-pagetext', 'Add text to page', 'text', ['text', 'page']], ['tool-edittext', 'Edit existing text', 'text', ['text', 'edit']], ['tool-sign', 'Sign (place signature)', 'sign'], ['tool-redact', 'Redact (mark areas)', 'redact']]) {
  cmd('Tools', id, l, (app) => { if (s) app.sub[s[0]] = s[1]; app.setTool(t); });
}

// ---------------------------------------------------------------- Pages
cmd('Pages', 'organize', 'Organize pages (grid)', (app) => app.toggleOrganizer(), { kw: 'reorder move thumbnails' });
cmd('Pages', 'rotate-cw', 'Rotate pages clockwise…', async (app) => { const v = await dialog('Rotate pages', [pagesField(app, 'current')]); if (v) app.edit('Rotate', () => E.rotatePages(app.doc, pagesFrom(app, v.pages), 90)); });
cmd('Pages', 'rotate-ccw', 'Rotate pages counter-clockwise…', async (app) => { const v = await dialog('Rotate pages', [pagesField(app, 'current')]); if (v) app.edit('Rotate', () => E.rotatePages(app.doc, pagesFrom(app, v.pages), -90)); });
cmd('Pages', 'delete-pages', 'Delete pages…', async (app) => { const v = await dialog('Delete pages', [pagesField(app, 'current')], { ok: 'Delete' }); if (v) app.edit('Delete pages', () => E.deletePages(app.doc, pagesFrom(app, v.pages))); }, { kw: 'remove' });
cmd('Pages', 'duplicate-page', 'Duplicate current page', (app) => app.edit('Duplicate', () => E.duplicatePages(app.doc, [app.cur])));
cmd('Pages', 'insert-blank', 'Insert blank page after current', (app) => app.edit('Insert page', () => E.insertBlank(app.doc, app.cur + 1)), { kw: 'add new empty' });
cmd('Pages', 'move-up', 'Move current page up', (app) => { if (app.cur > 0) app.edit('Move page', () => E.movePages(app.doc, [app.cur], app.cur - 1)).then(() => app.goto(app.cur - 1)); });
cmd('Pages', 'move-down', 'Move current page down', (app) => { if (app.cur < app.doc.pageCount - 1) app.edit('Move page', () => E.movePages(app.doc, [app.cur], app.cur + 2)).then(() => app.goto(app.cur + 1)); });
cmd('Pages', 'reverse', 'Reverse page order', (app) => app.edit('Reverse', () => E.reorderPages(app.doc, allPages(app).reverse())));
cmd('Pages', 'insert-pdf', 'Insert pages from another PDF…', async (app, at) => {
  const [f] = await pickFile('.pdf,application/pdf'); if (!f) return;
  const src = await openOther(f); if (!src) return;
  const v = await dialog('Insert pages', [{ name: 'pages', label: `Pages of ${f.name} (1-${src.pageCount})`, value: 'all' }, { name: 'at', label: 'Insert before page', type: 'number', value: (at ?? app.cur + 1) + 1, min: 1, max: app.doc.pageCount + 1 }], { ok: 'Insert' });
  if (!v) return;
  const idx = v.pages.trim().toLowerCase() === 'all' ? src.pages.map((_, i) => i) : E.parseRanges(v.pages, src.pageCount).flat();
  await app.edit('Insert pages', () => E.importPages(app.doc, src, idx, Math.max(0, (+v.at || 1) - 1)));
  toast(`Inserted ${idx.length} pages`);
}, { kw: 'merge combine append' });
async function openOther(f) {
  const b = await readFile(f);
  try { return await PDFDoc.load(b); } catch (e) {
    if (e.code !== 'password') { toast('Cannot open ' + f.name + ': ' + e.message); return null; }
    const pw = await promptDlg('Password', `Password for ${f.name}`, '', { type: 'password' });
    if (pw === null) return null;
    try { return await PDFDoc.load(b, pw); } catch (e2) { toast(e2.message); return null; }
  }
}
cmd('Pages', 'merge-files', 'Merge PDFs (append files)…', async (app, files) => {
  files = files || (await pickFile('.pdf,application/pdf', true));
  if (!files.length) return;
  let n = 0;
  await app.edit('Merge', async () => { for (const f of files) { const src = await openOther(f); if (src) { E.importPages(app.doc, src, src.pages.map((_, i) => i)); n += src.pageCount; } } });
  toast(`Appended ${n} pages from ${files.length} file${files.length > 1 ? 's' : ''}`);
}, { kw: 'combine join append' });
cmd('Pages', 'extract-pages', 'Extract pages to a new PDF…', async (app, idx) => {
  const v = await dialog('Extract pages', [pagesField(app, idx && idx.length ? idx.map((i) => i + 1).join(',') : 'current'), { name: 'del', label: 'Delete them from this document', type: 'checkbox' }], { ok: 'Extract' });
  if (!v) return;
  const pages = pagesFrom(app, v.pages);
  const d = E.extractPages(app.doc, pages);
  download(`${base(app)}-pages.pdf`, await saveFull(d, { objStreams: true }), 'application/pdf');
  if (v.del) await app.edit('Delete pages', () => E.deletePages(app.doc, pages));
});
cmd('Pages', 'split', 'Split document…', async (app) => {
  const v = await dialog('Split document', [{ name: 'mode', label: 'Split', type: 'select', value: 'n', options: [['n', 'Every N pages'], ['ranges', 'By page ranges'], ['bookmarks', 'By top-level bookmarks']] }, { name: 'n', label: 'N (pages per file)', type: 'number', value: 1, min: 1 }, { name: 'ranges', label: 'Ranges (e.g. 1-3, 4-7, 8-)', value: '' }], { ok: 'Split' });
  if (!v) return;
  const n = app.doc.pageCount;
  let groups = [];
  if (v.mode === 'n') { const k = Math.max(1, +v.n || 1); for (let i = 0; i < n; i += k) groups.push([...Array(Math.min(k, n - i)).keys()].map((x) => x + i)); }
  else if (v.mode === 'ranges') groups = E.parseRanges(v.ranges, n);
  else {
    const starts = NAV.outline(app.doc).map((o) => ({ t: o.title, p: o.target?.dest?.page })).filter((o) => o.p !== undefined).sort((a, b) => a.p - b.p);
    if (!starts.length) return toast('No bookmarks to split by');
    starts.forEach((s, k) => groups.push({ name: s.t, pages: [...Array((k + 1 < starts.length ? starts[k + 1].p : n) - s.p).keys()].map((x) => x + s.p) }));
  }
  const files = {};
  for (const [k, g] of groups.entries()) {
    const pages = g.pages || g; if (!pages.length) continue;
    const name = g.name ? `${String(k + 1).padStart(2, '0')}-${g.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.pdf` : `${base(app)}-${pages[0] + 1}-${pages[pages.length - 1] + 1}.pdf`;
    files[name] = await saveFull(E.extractPages(app.doc, pages), { objStreams: true });
  }
  download(base(app) + '-split.zip', await zip(files), 'application/zip');
  toast(`Split into ${Object.keys(files).length} files`);
}, { kw: 'divide separate burst' });
cmd('Pages', 'split-bookmarks', 'Split by bookmarks', (app) => app.run('split'), { hidden: true });
cmd('Pages', 'crop', 'Crop pages…', async (app) => {
  const v = await dialog('Crop pages', [pagesField(app, 'current'), { name: 'mode', label: 'Method', type: 'select', value: 'draw', options: [['draw', 'Draw the crop area on the page'], ['margins', 'Trim margins (points)'], ['auto', 'Auto-crop to content'], ['reset', 'Remove crop']] }, { name: 'm', label: 'Margins: top, right, bottom, left (pt)', value: '36, 36, 36, 36' }], { ok: 'Next' });
  if (!v) return;
  const pages = pagesFrom(app, v.pages);
  if (v.mode === 'reset') return app.edit('Reset crop', () => E.cropPages(app.doc, pages, null));
  if (v.mode === 'margins') {
    const [t, r, b, l] = v.m.split(/[,\s]+/).map(Number);
    return app.edit('Crop', () => { for (const i of pages) { const vb = app.doc.pages[i].view; E.cropPages(app.doc, [i], [vb[0] + (l || 0), vb[1] + (b || 0), vb[2] - (r || 0), vb[3] - (t || 0)]); } });
  }
  if (v.mode === 'auto') {
    return app.edit('Auto crop', async () => { for (const i of pages) { const t = await app.textNow(i); const bbs = [...t.chars.map((c) => c.b), ...t.objs.filter((o) => o.bbox).map((o) => o.bbox)]; if (!bbs.length) continue; const vb = app.doc.pages[i].view; const r = [Math.min(...bbs.map((x) => x[0])) - 12, Math.min(...bbs.map((x) => x[1])) - 12, Math.max(...bbs.map((x) => x[2])) + 12, Math.max(...bbs.map((x) => x[3])) + 12]; E.cropPages(app.doc, [i], [Math.max(vb[0], r[0]), Math.max(vb[1], r[1]), Math.min(vb[2], r[2]), Math.min(vb[3], r[3])]); } });
  }
  toast('Drag a rectangle on the page to set the crop area');
  app.setTool('select');
  const once = (e) => {
    const i = app.pageAt(e); if (i < 0) return;
    e.stopPropagation(); e.preventDefault();
    const [x0, y0] = app.toUser(i, e.clientX, e.clientY);
    const rb = app.rubber(i, x0, y0);
    const mv = (ev) => rb(...app.toUser(i, ev.clientX, ev.clientY));
    const up = (ev) => { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); const [x1, y1] = app.toUser(i, ev.clientX, ev.clientY); rb(x1, y1).remove(); const r = normRect([x0, y0, x1, y1]); if (r[2] - r[0] > 10 && r[3] - r[1] > 10) app.edit('Crop', () => E.cropPages(app.doc, pages, r)); };
    addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
    app.view.removeEventListener('pointerdown', once, true);
  };
  app.view.addEventListener('pointerdown', once, true);
}, { kw: 'trim margins cut' });
cmd('Pages', 'page-labels', 'Page labels (numbering style)…', async (app) => {
  const v = await dialog('Page labels', [{ name: 'spec', label: 'One range per line: start page, style (D=1,2,3  r=i,ii  R=I,II  a=a,b  A=A,B), prefix, first number', type: 'textarea', value: '1, D, , 1' }], { ok: 'Apply', hint: 'Example: "1, r" then "5, D, , 1" numbers the front matter i-iv and the body from 1.' });
  if (!v) return;
  const ranges = v.spec.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((x) => x[0]).map(([s, st, pre, first]) => ({ start: (+s || 1) - 1, style: st || 'D', prefix: pre || '', first: +first || 1 }));
  await app.edit('Page labels', () => NAV.setPageLabels(app.doc, ranges));
  app._labels = null; app.layout(true);
});
const POS = [['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right']];
cmd('Pages', 'page-numbers', 'Add page numbers…', async (app) => {
  const v = await dialog('Page numbers', [pagesField(app), { name: 'fmt', label: 'Format ({page}, {total})', value: 'Page {page} of {total}' }, { name: 'pos', label: 'Position', type: 'select', value: 'bc', options: POS }, { name: 'size', label: 'Font size', type: 'number', value: 10 }, { name: 'start', label: 'First number', type: 'number', value: 1 }], { ok: 'Add' });
  if (!v) return;
  const pages = pagesFrom(app, v.pages);
  await app.edit('Page numbers', () => E.stampText(app.doc, pages, (i, k, n) => E.fmtTemplate(v.fmt, k, k, pages.length, { offset: (+v.start || 1) - 1 }).replace(/\{total\}/g, n), { pos: v.pos, size: +v.size || 10 }));
}, { kw: 'numbering footer' });
cmd('Pages', 'header-footer', 'Add header / footer…', async (app) => {
  const v = await dialog('Header and footer', [pagesField(app), { name: 'hl', label: 'Header left', value: '' }, { name: 'hc', label: 'Header center', value: '{title}' }, { name: 'hr', label: 'Header right', value: '{date}' }, { name: 'fl', label: 'Footer left', value: '{file}' }, { name: 'fc', label: 'Footer center', value: '' }, { name: 'fr', label: 'Footer right', value: '{page} / {total}' }, { name: 'size', label: 'Font size', type: 'number', value: 9 }], { ok: 'Add', hint: 'Placeholders: {page} {total} {date} {title} {file}', width: 520 });
  if (!v) return;
  const pages = pagesFrom(app, v.pages), title = NAV.getMeta(app.doc).Title || base(app);
  await app.edit('Header/footer', () => { for (const [k, pos] of [['hl', 'tl'], ['hc', 'tc'], ['hr', 'tr'], ['fl', 'bl'], ['fc', 'bc'], ['fr', 'br']]) if (v[k]) E.stampText(app.doc, pages, (i, kk, n) => E.fmtTemplate(v[k], i, kk, n, { title, file: app.name }), { pos, size: +v.size || 9 }); });
});
cmd('Pages', 'bates', 'Bates numbering…', async (app) => {
  const v = await dialog('Bates numbering', [{ name: 'prefix', label: 'Prefix', value: 'DOC' }, { name: 'start', label: 'Start number', type: 'number', value: 1 }, { name: 'digits', label: 'Digits', type: 'number', value: 6 }, { name: 'suffix', label: 'Suffix', value: '' }, { name: 'pos', label: 'Position', type: 'select', value: 'br', options: POS }], { ok: 'Apply' });
  if (!v) return;
  await app.edit('Bates numbering', () => E.stampText(app.doc, allPages(app), (i, k) => E.batesNum(v.prefix, +v.start || 1, +v.digits || 6, k, v.suffix), { pos: v.pos, size: 9 }));
}, { kw: 'legal stamp number' });
cmd('Pages', 'watermark', 'Add watermark (text or image)…', async (app) => {
  const v = await dialog('Watermark', [pagesField(app), { name: 'text', label: 'Text (leave empty to choose an image)', value: 'CONFIDENTIAL' }, { name: 'size', label: 'Font size', type: 'number', value: 60 }, { name: 'color', label: 'Colour', type: 'color', value: '#c81e1e' }, { name: 'op', label: 'Opacity (0-1)', type: 'number', value: 0.25, step: 0.05 }, { name: 'rot', label: 'Angle', type: 'number', value: 45 }, { name: 'tiled', label: 'Tile across the page', type: 'checkbox' }, { name: 'behind', label: 'Place behind page content', type: 'checkbox' }], { ok: 'Add' });
  if (!v) return;
  let image = null, file = null;
  if (!v.text.trim()) { [file] = await pickFile('image/*'); if (!file) return; }
  await app.edit('Watermark', async () => {
    if (file) image = await imageFileToX(app, app.doc, file);
    E.watermark(app.doc, pagesFrom(app, v.pages), { text: v.text, size: +v.size, color: rgb01(v.color), opacity: +v.op, rotate: +v.rot, tiled: v.tiled, behind: v.behind, image });
  });
}, { kw: 'stamp draft confidential' });
cmd('Pages', 'background', 'Add background colour or image…', async (app) => {
  const v = await dialog('Background', [pagesField(app), { name: 'color', label: 'Colour', type: 'color', value: '#fff8e1' }, { name: 'img', label: 'Use an image instead', type: 'checkbox' }], { ok: 'Apply' });
  if (!v) return;
  let image = null;
  if (v.img) { const [f] = await pickFile('image/*'); if (!f) return; await app.edit('Background', async () => { image = await imageFileToX(app, app.doc, f); E.background(app.doc, pagesFrom(app, v.pages), { image }); }); return; }
  await app.edit('Background', () => E.background(app.doc, pagesFrom(app, v.pages), { color: rgb01(v.color) }));
});
cmd('Pages', 'insert-image', 'Insert image on page…', async (app, at) => {
  const [f] = await pickFile('image/*'); if (!f) return;
  const i = at?.page ?? app.cur;
  await app.edit('Insert image', async () => {
    const x = await imageFileToX(app, app.doc, f);
    const vb = app.doc.pages[i].view, maxW = (vb[2] - vb[0]) * 0.5, w = Math.min(maxW, x.w * 0.75), hh = (w * x.h) / x.w;
    const cx = at?.x ?? (vb[0] + vb[2]) / 2, cy = at?.y ?? (vb[1] + vb[3]) / 2;
    E.drawImage(app.doc, i, x, [cx - w / 2, cy - hh / 2, cx + w / 2, cy + hh / 2]);
  }, [i]);
  toast('Image added. Use Select to move or resize it.');
}, { kw: 'picture photo logo' });
cmd('Pages', 'add-link', 'Add link (drag an area)…', async (app) => {
  const v = await dialog('Add link', [{ name: 'kind', label: 'Link to', type: 'select', value: 'uri', options: [['uri', 'Web address'], ['page', 'Page in this document']] }, { name: 'uri', label: 'URL', value: 'https://' }, { name: 'page', label: 'Page number', type: 'number', value: 1 }], { ok: 'Next' });
  if (!v) return;
  toast('Drag the link area on the page');
  const once = (e) => {
    const i = app.pageAt(e); if (i < 0) return;
    e.stopPropagation(); e.preventDefault();
    const [x0, y0] = app.toUser(i, e.clientX, e.clientY);
    const rb = app.rubber(i, x0, y0);
    const mv = (ev) => rb(...app.toUser(i, ev.clientX, ev.clientY));
    const up = (ev) => { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); const [x1, y1] = app.toUser(i, ev.clientX, ev.clientY); rb(x1, y1).remove(); const r = normRect([x0, y0, x1, y1]); if (r[2] - r[0] > 4) app.addAnnot(i, v.kind === 'uri' ? { type: 'Link', rect: r, uri: v.uri } : { type: 'Link', rect: r, page: Math.max(0, Math.min(app.doc.pageCount - 1, (+v.page || 1) - 1)) }); };
    addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
    app.view.removeEventListener('pointerdown', once, true);
  };
  app.view.addEventListener('pointerdown', once, true);
}, { kw: 'url hyperlink' });

// ---------------------------------------------------------------- Bookmarks
cmd('Bookmarks', 'bookmark-add', 'Add bookmark for this page', async (app) => {
  const title = await promptDlg('New bookmark', 'Title', app.selectedText().slice(0, 80) || 'Page ' + (app.cur + 1));
  if (title === null) return;
  const tree = NAV.outlineTree(app.doc);
  const y = app.toUser(app.cur, 0, app.views[app.cur].el.getBoundingClientRect().top < 0 ? -app.views[app.cur].el.getBoundingClientRect().top + app.view.getBoundingClientRect().top : 0)[1];
  tree.push({ title, page: app.cur, y: Math.round(y) });
  tree.sort((a, b) => a.page - b.page);
  await app.edit('Add bookmark', () => NAV.setOutline(app.doc, tree), []);
  app.panel('outline');
});
cmd('Bookmarks', 'bookmarks-edit', 'Edit bookmarks…', async (app) => {
  const tree = NAV.outlineTree(app.doc);
  const flat = []; const walk = (items, d) => { for (const it of items) { flat.push('  '.repeat(d) + it.title + ' | ' + (it.page + 1)); walk(it.kids, d + 1); } }; walk(tree, 0);
  const v = await dialog('Edit bookmarks', [{ name: 't', label: 'One per line: title | page. Indent with two spaces to nest.', type: 'textarea', rows: 12, value: flat.join('\n') }], { ok: 'Save', width: 560 });
  if (!v) return;
  const root = [], stack = [{ d: -1, kids: root }];
  for (const line of v.t.split('\n')) {
    if (!line.trim()) continue;
    const d = (line.match(/^ */)[0].length / 2) | 0, [t, p] = line.trim().split('|').map((s) => s.trim());
    const it = { title: t, page: Math.max(0, (+p || 1) - 1), kids: [] };
    while (stack[stack.length - 1].d >= d) stack.pop();
    stack[stack.length - 1].kids.push(it); stack.push({ d, kids: it.kids });
  }
  await app.edit('Edit bookmarks', () => NAV.setOutline(app.doc, root), []);
  app.panel('outline');
}, { kw: 'outline toc' });

// ---------------------------------------------------------------- Comments
cmd('Comment', 'comments-export', 'Export comments summary', (app) => {
  const list = A.listAnnots(app.doc).filter((a) => !['Link', 'Widget'].includes(a.type));
  const txt = list.map((a) => `Page ${a.page + 1} · ${a.type} · ${a.author || ''} ${a.date ? a.date.toISOString().slice(0, 16).replace('T', ' ') : ''}\n${a.contents || ''}`).join('\n\n');
  download(base(app) + '-comments.txt', txt || 'No comments', 'text/plain;charset=utf-8');
}, { kw: 'summary annotations list' });
cmd('Comment', 'flatten-annots', 'Flatten all comments into the page', async (app) => { if (await confirmDlg('Flatten comments', 'Comments become part of the page and can no longer be edited.', 'Flatten')) { const n = await app.edit('Flatten comments', () => A.flattenAnnots(app.doc, allPages(app), (d, t) => !['Widget', 'Link', 'Redact'].includes(t))); toast(`Flattened ${n} comments`); } });
cmd('Comment', 'flatten-selected', 'Flatten selected comment', async (app) => { const a = app.selAnnot; if (!a) return toast('Select a comment first'); await app.edit('Flatten', () => A.flattenAnnots(app.doc, [a.page], (d) => d === app.doc.get(a.ref)), [a.page]); app.selAnnot = null; app.updateCtx(); }, { hidden: false });
cmd('Comment', 'delete-comments', 'Delete all comments', async (app) => { if (await confirmDlg('Delete all comments', 'Remove every comment and markup in this document?', 'Delete')) app.edit('Delete comments', () => { for (const a of A.listAnnots(app.doc)) if (!['Widget', 'Link'].includes(a.type)) A.deleteAnnot(app.doc, a.page, a.ref); }); });
cmd('Comment', 'smart-highlight', 'Highlight all matches of a phrase', async (app) => {
  const q = await promptDlg('Highlight all', 'Text or /regular expression/', app.selectedText().slice(0, 60));
  if (!q) return;
  const re = /^\/(.+)\/(\w*)$/.exec(q);
  let n = 0;
  await app.edit('Highlight matches', async () => { for (let i = 0; i < app.doc.pageCount; i++) { const t = await app.textNow(i); for (const m of findAll(t.lay, re ? new RegExp(re[1], re[2]) : q)) { const rects = charRects(t.chars, m.chars); const quads = rects.flatMap((r) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]); A.createAnnot(app.doc, i, { type: 'Highlight', rect: [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))], quads, color: rgb01(app.st.color.markup), author: app.author }); n++; } } });
  toast(`Highlighted ${n} matches`);
}, { kw: 'smart select find mark' });

// ---------------------------------------------------------------- Forms
cmd('Forms', 'fill-form', 'Fill form (toggle)', (app) => { app.setFormMode(!app.formMode); app.panel('fields'); }, { kw: 'fill in fields' });
cmd('Forms', 'field-create', 'Create form field…', async (app) => {
  const v = await dialog('New form field', [{ name: 'type', label: 'Type', type: 'select', value: 'text', options: [['text', 'Text'], ['multiline', 'Multi-line text'], ['checkbox', 'Checkbox'], ['radio', 'Radio buttons'], ['combo', 'Dropdown'], ['list', 'List box'], ['signature', 'Signature']] }, { name: 'name', label: 'Name', value: '' }, { name: 'opts', label: 'Options (for radio/dropdown/list), comma separated', value: '' }], { ok: 'Draw on page' });
  if (!v) return;
  toast('Drag on the page where the field should go');
  const once = (e) => {
    const i = app.pageAt(e); if (i < 0) return;
    e.stopPropagation(); e.preventDefault();
    const [x0, y0] = app.toUser(i, e.clientX, e.clientY);
    const rb = app.rubber(i, x0, y0);
    const mv = (ev) => rb(...app.toUser(i, ev.clientX, ev.clientY));
    const up = async (ev) => {
      removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true);
      const [x1, y1] = app.toUser(i, ev.clientX, ev.clientY); rb(x1, y1).remove();
      let r = normRect([x0, y0, x1, y1]);
      if (r[2] - r[0] < 8) r = v.type === 'checkbox' || v.type === 'radio' ? [x0, y0 - 14, x0 + 14, y0] : [x0, y0 - 20, x0 + 180, y0];
      await app.edit('Create field', () => F.createField(app.doc, i, { type: v.type === 'multiline' ? 'text' : v.type, multiline: v.type === 'multiline', name: v.name.trim() || undefined, rect: r, options: v.opts.split(',').map((s) => s.trim()).filter(Boolean) }), [i]);
      app.fieldsCache = null; app.setFormMode(true); app.panel('fields');
    };
    addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
    app.view.removeEventListener('pointerdown', once, true);
  };
  app.view.addEventListener('pointerdown', once, true);
}, { kw: 'add textbox checkbox dropdown' });
cmd('Forms', 'fields-detect', 'Detect form fields automatically', async (app) => {
  let n = 0;
  const v = await dialog('Detect form fields', [pagesField(app, 'current')], { ok: 'Detect', hint: 'Finds blank lines (____), underlines, empty boxes and small squares and turns them into fillable fields.' });
  if (!v) return;
  await app.edit('Detect fields', async () => {
    for (const i of pagesFrom(app, v.pages)) {
      const t = await app.textNow(i);
      for (const c of F.detectFields(t.chars, t.objs, app.doc.pages[i].view)) { F.createField(app.doc, i, { type: c.check ? 'checkbox' : 'text', name: (c.label || 'field').replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 30) || 'field', rect: c.rect }); n++; }
    }
  });
  app.fieldsCache = null; app.setFormMode(true); app.panel('fields');
  toast(n ? `Created ${n} fields` : 'No form-like blanks found');
}, { kw: 'auto recognise' });
cmd('Forms', 'smart-fill', 'Smart fill from my profile…', async (app) => {
  const prof = JSON.parse(localStorage.getItem('pdfs-profile') || '{}');
  const labels = { fullName: 'Full name', firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', address: 'Address', city: 'City', zip: 'Postal code', country: 'Country', company: 'Company', date: 'Date (today if empty)', dob: 'Date of birth' };
  const v = await dialog('Smart fill', Object.entries(labels).map(([k, l]) => ({ name: k, label: l, value: prof[k] || '' })), { ok: 'Fill matching fields', hint: 'Stored only in this browser. Fields are matched by their names and labels.', width: 520 });
  if (!v) return;
  localStorage.setItem('pdfs-profile', JSON.stringify(v));
  if (!v.date) v.date = new Date().toLocaleDateString();
  let n = 0;
  await app.edit('Smart fill', () => { for (const f of F.fields(app.doc)) { if (f.type !== 'text' || f.readonly) continue; const k = F.profileMatch(f); if (k && v[k]) { F.setValue(app.doc, f, v[k]); n++; } } });
  app.fieldsCache = null; app.setFormMode(true); app.panel('fields');
  toast(`Filled ${n} fields`);
}, { kw: 'autofill profile' });
cmd('Forms', 'form-export-json', 'Export form data (JSON)', (app) => download(base(app) + '-data.json', F.exportJSON(app.doc), 'application/json'));
cmd('Forms', 'form-export-csv', 'Export form data (CSV)', (app) => download(base(app) + '-data.csv', F.exportCSV(app.doc), 'text/csv'));
cmd('Forms', 'form-export-fdf', 'Export form data (FDF)', (app) => download(base(app) + '.fdf', F.exportFDF(app.doc), 'application/vnd.fdf'));
cmd('Forms', 'form-import', 'Import form data (JSON, CSV or FDF)…', async (app) => { const [f] = await pickFile('.json,.csv,.fdf,.txt'); if (!f) return; const m = await F.parseFieldData(await readFile(f)); const n = await app.edit('Import form data', () => F.importValues(app.doc, m)); app.fieldsCache = null; app.setFormMode(true); toast(`Filled ${n} fields`); });
cmd('Forms', 'form-calc', 'Recalculate form', (app) => app.edit('Calculate', () => F.calculate(app.doc)));
cmd('Forms', 'form-reset', 'Reset form (clear all values)', async (app) => { if (!(await confirmDlg('Reset form', 'Clear every field value?', 'Clear'))) return; await app.edit('Reset form', () => { for (const f of F.fields(app.doc)) if (!['button', 'signature'].includes(f.type)) F.setValue(app.doc, f, f.type === 'checkbox' || f.type === 'radio' ? false : f.multi ? [] : ''); }); app.fieldsCache = null; app.setFormMode(app.formMode); });
cmd('Forms', 'form-flatten', 'Flatten form (make fields permanent)', async (app) => { if (!(await confirmDlg('Flatten form', 'Field values become page content and the fields are removed.', 'Flatten'))) return; const n = await app.edit('Flatten form', () => F.flattenForm(app.doc)); app.setFormMode(false); toast(`Flattened ${n} fields`); });
cmd('Forms', 'field-delete', 'Delete a form field…', async (app) => { const fs = F.fields(app.doc); if (!fs.length) return toast('No fields'); const v = await dialog('Delete field', [{ name: 'f', label: 'Field', type: 'select', options: fs.map((f) => f.name) }], { ok: 'Delete' }); if (v) { await app.edit('Delete field', () => F.deleteField(app.doc, fs.find((f) => f.name === v.f))); app.fieldsCache = null; app.panel('fields'); } });

// ---------------------------------------------------------------- Protect & redact
cmd('Protect', 'protect', 'Protect with password (AES-256)…', async (app) => {
  const v = await dialog('Protect with password', [{ name: 'user', label: 'Password to open (leave empty for none)', type: 'password' }, { name: 'owner', label: 'Permissions password (owner)', type: 'password' },
    ...PERMS.map(([k]) => ({ name: k, label: { print: 'Allow printing', modify: 'Allow changes', copy: 'Allow copying text', annotate: 'Allow comments', fillForms: 'Allow form filling', accessibility: 'Allow accessibility extraction', assemble: 'Allow page assembly', printHigh: 'Allow high-quality printing' }[k], type: 'checkbox', value: true }))], { ok: 'Protect & save', hint: 'Uses the PDF 2.0 AES-256 standard security handler. Permissions are honoured by compliant readers only.' });
  if (!v) return;
  if (!v.user && !v.owner) return toast('Enter at least one password');
  const sec = await newAES256(v.user, v.owner || v.user, v);
  app.password = v.user;
  await app.save(true, { security: sec, incremental: false });
}, { kw: 'encrypt lock security permissions' });
cmd('Protect', 'unprotect', 'Remove password / encryption', async (app) => { if (!app.doc.sec) return toast('This document is not encrypted'); if (!app.doc.sec.owner && !(await confirmDlg('Remove security', 'You opened this file with the user password. Save an unencrypted copy?', 'Save unencrypted'))) return; await app.save(true, { decrypt: true, security: null, incremental: false }); }, { kw: 'decrypt unlock' });
cmd('Protect', 'find-redact', 'Find & redact (emails, phones, IDs, custom)…', async (app) => {
  const PAT = { email: /[\w.+-]+@[\w-]+\.[\w.-]+/g, phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g, card: /\b(?:\d[ -]?){13,19}\b/g, ssn: /\b\d{3}-\d{2}-\d{4}\b/g, iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, date: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, url: /https?:\/\/\S+/g };
  const v = await dialog('Find & redact', [{ name: 'email', label: 'Email addresses', type: 'checkbox', value: true }, { name: 'phone', label: 'Phone numbers', type: 'checkbox', value: true }, { name: 'card', label: 'Card / account numbers', type: 'checkbox' }, { name: 'ssn', label: 'US SSN-style IDs (123-45-6789)', type: 'checkbox' }, { name: 'iban', label: 'IBANs', type: 'checkbox' }, { name: 'date', label: 'Dates', type: 'checkbox' }, { name: 'url', label: 'Web links', type: 'checkbox' }, { name: 'custom', label: 'Words or /regex/ (one per line)', type: 'textarea', rows: 3 }], { ok: 'Mark matches', hint: 'Matches are marked for review first. Nothing is removed until you apply redactions.' });
  if (!v) return;
  const res = Object.keys(PAT).filter((k) => v[k]).map((k) => PAT[k]);
  for (const line of (v.custom || '').split('\n').map((s) => s.trim()).filter(Boolean)) { const m = /^\/(.+)\/(\w*)$/.exec(line); res.push(m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')); }
  let n = 0;
  await app.edit('Mark redactions', async () => {
    for (let i = 0; i < app.doc.pageCount; i++) {
      const t = await app.textNow(i);
      for (const re of res) for (const m of findAll(t.lay, re)) {
        const rects = charRects(t.chars, m.chars); if (!rects.length) continue;
        const quads = rects.flatMap((r) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]);
        A.createAnnot(app.doc, i, { type: 'Redact', rect: [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))], quads, contents: m.text, author: app.author });
        n++;
      }
    }
  });
  app.setTool('redact');
  toast(n ? `Marked ${n} matches. Review them, then Apply.` : 'No matches found');
}, { kw: 'pii privacy remove personal search pattern' });
cmd('Protect', 'apply-redactions', 'Apply redactions (permanently remove content)', async (app) => {
  const n = A.listAnnots(app.doc).filter((a) => a.type === 'Redact').length;
  if (!n) return toast('Mark areas with the Redact tool first');
  if (!(await confirmDlg('Apply redactions', `Permanently remove the text, images and graphics under ${n} marked area${n > 1 ? 's' : ''}? The next save rewrites the whole file so no earlier version remains inside it.`, 'Redact'))) return;
  const s = await app.edit('Apply redactions', () => applyRedactAnnots(app.doc, { decodeJpeg }));
  if (s) toast(`Removed ${s.glyphs} characters, ${s.images} images, ${s.paths} graphics, ${s.annots} annotations on ${s.pages} pages`, 7000);
  app.updateCtx();
}, { kw: 'redact remove black out' });
cmd('Protect', 'sanitize', 'Sanitize document (remove metadata, scripts, hidden data)…', async (app) => {
  const v = await dialog('Sanitize document', [{ name: 'metadata', label: 'Metadata, XMP and private application data', type: 'checkbox', value: true }, { name: 'scripts', label: 'JavaScript and automatic actions', type: 'checkbox', value: true }, { name: 'attachments', label: 'Embedded files', type: 'checkbox', value: true }, { name: 'thumbnails', label: 'Embedded page thumbnails', type: 'checkbox', value: true }, { name: 'hiddenLayers', label: 'Content in hidden layers', type: 'checkbox', value: true }, { name: 'comments', label: 'All comments', type: 'checkbox' }], { ok: 'Sanitize' });
  if (!v) return;
  const r = await app.edit('Sanitize', () => sanitize(app.doc, v));
  toast(r && r.length ? 'Removed: ' + r.join(', ') : 'Nothing to remove');
}, { kw: 'scrub clean privacy metadata' });
cmd('Protect', 'remove-hidden', 'Remove hidden layer content', async (app) => { const n = await app.edit('Remove hidden layers', () => removeHiddenLayers(app.doc)); toast(n ? `Removed ${n} hidden sections` : 'No hidden layer content'); }, { hidden: true });

// ---------------------------------------------------------------- Sign
cmd('Sign', 'create-signature', 'Create signature (draw, type or image)…', async (app) => {
  const pad = h('canvas', { class: 'sigpad', width: 600, height: 200, 'aria-label': 'Draw your signature' });
  const ctx = pad.getContext('2d'); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a2a6c';
  let drawing = false, any = false;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height]; };
  pad.addEventListener('pointerdown', (e) => { drawing = true; any = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
  pad.addEventListener('pointerup', () => (drawing = false));
  const v = await dialog('Create signature', [{ type: 'html', el: h('div', null, h('div', { class: 'small muted' }, 'Draw below, or type your name, or pick an image.'), pad, h('button', { class: 'btn sm', type: 'button', onclick: () => { ctx.clearRect(0, 0, 600, 200); any = false; } }, 'Clear')) },
    { name: 'typed', label: 'Or type your name', value: '' }, { name: 'font', label: 'Typed style', type: 'select', value: 'cursive', options: [['cursive', 'Script'], ['serif', 'Serif italic'], ['sans-serif', 'Plain']] }, { name: 'img', label: 'Or use an image file', type: 'checkbox' }, { name: 'date', label: 'Add date under the signature', type: 'checkbox', value: true }], { ok: 'Use signature', width: 640 });
  if (!v) return;
  let src = pad;
  if (v.img) { const [f] = await pickFile('image/*'); if (!f) return; const bmp = await createImageBitmap(f); src = h('canvas', { width: bmp.width, height: bmp.height }); src.getContext('2d').drawImage(bmp, 0, 0); }
  else if (v.typed.trim()) { src = h('canvas', { width: 600, height: 200 }); const c2 = src.getContext('2d'); c2.fillStyle = '#1a2a6c'; c2.font = (v.font === 'serif' ? 'italic ' : '') + '72px ' + (v.font === 'cursive' ? '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive' : v.font); c2.textBaseline = 'middle'; c2.fillText(v.typed.trim(), 20, 100); }
  else if (!any) return toast('Draw, type or choose a signature');
  // trim transparent borders, add date
  const sx = src.getContext('2d'), id = sx.getImageData(0, 0, src.width, src.height);
  let x0 = src.width, y0 = src.height, x1 = 0, y1 = 0;
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) if (id.data[(y * src.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return toast('Empty signature');
  const dateStr = v.date ? new Date().toLocaleDateString() : '';
  const out = h('canvas', { width: x1 - x0 + 20, height: y1 - y0 + 20 + (dateStr ? 34 : 0) });
  const oc = out.getContext('2d'); oc.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 10, 10, x1 - x0 + 1, y1 - y0 + 1);
  if (dateStr) { oc.fillStyle = '#333'; oc.font = '22px Arial, sans-serif'; oc.fillText(dateStr, 10, out.height - 10); }
  app.signature = { w: out.width, h: out.height, rgba: oc.getImageData(0, 0, out.width, out.height).data, date: dateStr };
  app.setTool('sign');
  toast('Click on the page to place your signature');
}, { doc: false, kw: 'handwritten initials' });
cmd('Sign', 'digital-sign', 'Digitally sign with certificate (PKCS#12 / PEM)…', async (app) => { const m = await import('./sign-ui.js'); await m.digitalSign(app); }, { kw: 'certificate cms pkcs7 cryptographic' });
cmd('Sign', 'verify-signatures', 'Verify digital signatures', async (app) => { const m = await import('./sign-ui.js'); await m.verify(app); }, { kw: 'validate check' });

// ---------------------------------------------------------------- Tools
cmd('Tools', 'compare', 'Compare with another PDF (text differences)…', async (app) => { const m = await import('./extras.js'); await m.compareDocs(app); }, { kw: 'diff changes versions' });
cmd('Tools', 'table-csv', 'Extract table from page to CSV…', async (app) => {
  const v = await dialog('Extract table', [{ name: 'mode', label: 'Area', type: 'select', value: 'draw', options: [['draw', 'Draw a box around the table'], ['page', 'Whole current page']] }], { ok: 'Next' });
  if (!v) return;
  const finish = async (i, region) => { const t = await app.textNow(i); const rows = extractTable(t.chars, region); if (!rows.length) return toast('No text found in that area'); download(`${base(app)}-table-p${i + 1}.csv`, '﻿' + toCSV(rows), 'text/csv;charset=utf-8'); toast(`Exported ${rows.length} rows × ${Math.max(...rows.map((r) => r.length))} columns`); };
  if (v.mode === 'page') return finish(app.cur, null);
  toast('Drag a box around the table');
  const once = (e) => {
    const i = app.pageAt(e); if (i < 0) return;
    e.stopPropagation(); e.preventDefault();
    const [x0, y0] = app.toUser(i, e.clientX, e.clientY);
    const rb = app.rubber(i, x0, y0);
    const mv = (ev) => rb(...app.toUser(i, ev.clientX, ev.clientY));
    const up = (ev) => { removeEventListener('pointermove', mv, true); removeEventListener('pointerup', up, true); const [x1, y1] = app.toUser(i, ev.clientX, ev.clientY); rb(x1, y1).remove(); finish(i, normRect([x0, y0, x1, y1])); };
    addEventListener('pointermove', mv, true); addEventListener('pointerup', up, true);
    app.view.removeEventListener('pointerdown', once, true);
  };
  app.view.addEventListener('pointerdown', once, true);
}, { kw: 'spreadsheet excel data' });
cmd('Tools', 'ocr', 'Recognize text in scanned pages (OCR, not available yet)…', async (app) => { const m = await import('./extras.js'); await m.ocrPages(app); }, { kw: 'scan searchable recognize' });
cmd('Tools', 'batch', 'Batch process several PDFs…', async (app) => { const m = await import('./extras.js'); await m.batch(app); }, { doc: false, kw: 'multiple files bulk' });
cmd('Tools', 'shortcuts', 'Keyboard shortcuts', () => dialog('Keyboard shortcuts', [], { cancel: null, hint: 'Ctrl+K commands · Ctrl+O open · Ctrl+S save · Ctrl+F find · Ctrl+P print · Ctrl+Z / Ctrl+Y undo/redo · Ctrl +/- zoom · Ctrl+0 fit width · V select · H hand · U highlight · N comment · D draw · T text · S sign · R redact · Delete removes the selected object · Esc clears · Home/End/PageUp/PageDown navigate · F4 sidebar · F11 read mode · In Organize: Alt+Arrow moves a page.' }), { doc: false, kw: 'keys help' });
cmd('Tools', 'about', 'About PDFStudio Acrobat Pro', () => dialog('PDFStudio Acrobat Pro', [], { cancel: null, hint: 'A free, offline PDF viewer and editor in one HTML file. No network access: your files never leave this device. A recovery copy of unsaved work is kept in this browser (IndexedDB) only. MIT licence.' }), { doc: false });

export function registerCommands(app) { app.commands = CMDS; }
export { renderToCanvas, canvasBlob, blobBytes, base, pagesFrom, pagesField, openOther, imageFileToX };

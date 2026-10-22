// Small DOM helpers: element builder, toast, modal form dialog, popup menu, colour picker, icons.
export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

let toastTimer = 0;
export function toast(msg, ms = 3200) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

const ICONS = {
  left: 'M3 4h14M3 8h9M3 12h14M3 16h9', center: 'M3 4h14M6 8h8M3 12h14M6 16h8', right: 'M3 4h14M8 8h9M3 12h14M8 16h9',
  top: 'M3 3h14M10 6v11M7 9l3-3 3 3', mid: 'M3 10h14M10 3v14M7 6l3-3 3 3M7 14l3 3 3-3', bottom: 'M3 17h14M10 3v11M7 11l3 3 3-3',
  wrap: 'M3 5h14M3 10h11a3 3 0 010 6H9m0 0l2-2m-2 2l2 2M3 15h3', merge: 'M3 4v12M17 4v12M6 10h8M6 10l3-3m-3 3l3 3m5-3l-3-3m3 3l-3 3',
  indent: 'M3 4h14M9 8h8M9 12h8M3 16h14M3 8l3 2-3 2z', outdent: 'M3 4h14M9 8h8M9 12h8M3 16h14M6 8L3 10l3 2z',
  border: 'M3 3h14v14H3zM3 10h14M10 3v14', fill: 'M5 12l5-8 5 8a5 5 0 01-10 0zM16 14c1 2 1 3 0 3s-1-1 0-3', font: 'M5 16L10 4l5 12M7 12h6',
  sortaz: 'M4 4v12m0 0l-2-2m2 2l2-2M10 5h6M10 9h4M10 13h2', sortza: 'M4 4v12m0 0l-2-2m2 2l2-2M10 13h6M10 9h4M10 5h2',
  filter: 'M3 4h14l-5 6v6l-4-2v-4z', undo: 'M6 8h6a4 4 0 010 8H8M6 8l3-3M6 8l3 3', redo: 'M14 8H8a4 4 0 000 8h4M14 8l-3-3M14 8l-3 3',
  paste: 'M7 4h6v3H7zM5 5h2M13 5h2M5 5v12h10V5', copy: 'M7 7h9v10H7zM4 4h9v2M4 4v10h2', cut: 'M5 3l8 10M13 3L5 13M5 15a2 2 0 104 0 2 2 0 10-4 0M11 15a2 2 0 104 0 2 2 0 10-4 0',
  plus: 'M10 4v12M4 10h12', sigma: 'M15 4H5l5 6-5 6h10', chart: 'M4 16V4M4 16h12M7 13v-3M10 13V7M13 13V9', search: 'M9 3a6 6 0 100 12A6 6 0 009 3zM14 14l4 4',
  save: 'M4 3h10l3 3v11H4zM7 3v4h6V3M7 17v-5h6v5', open: 'M3 6h5l2 2h7v8H3z', print: 'M6 7V3h8v4M5 7h10v6H5zM7 11h6v6H7z', clear: 'M4 4l12 12M16 4L4 16',
  freeze: 'M3 3h14v14H3zM3 8h14M8 3v14', pivot: 'M3 3h14v14H3zM3 8h14M8 8v9M3 12h14', fx: 'M13 4c-2 0-3 1-3 3v6c0 2-1 3-3 3M6 9h6',
};
export function icon(name, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] || '');
  s.append(p);
  return s;
}

// Modal dialog with simple form fields. Resolves with values or null.
export function dialog(title, fields, { ok = 'OK', cancel = 'Cancel', width, extra, hint } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const inputs = {};
    const rows = fields.map((f) => {
      if (f.type === 'html') return f.el;
      let inp;
      if (f.type === 'select') inp = h('select', { id: 'f_' + f.name }, f.options.map((o) => h('option', { value: Array.isArray(o) ? o[0] : o, selected: String(Array.isArray(o) ? o[0] : o) === String(f.value) }, Array.isArray(o) ? o[1] : o)));
      else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', id: 'f_' + f.name, checked: !!f.value });
      else if (f.type === 'textarea') inp = h('textarea', { id: 'f_' + f.name, rows: f.rows || 4, spellcheck: 'false' }, f.value ?? '');
      else if (f.type === 'color') inp = h('input', { type: 'color', id: 'f_' + f.name, value: f.value || '#000000' });
      else inp = h('input', { type: f.type || 'text', id: 'f_' + f.name, value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, spellcheck: 'false', autocomplete: 'off' });
      inputs[f.name] = inp;
      return h('label', { class: 'fld' + (f.type === 'checkbox' ? ' chk' : '') }, f.type === 'checkbox' ? [inp, f.label] : [h('span', null, f.label), inp]);
    });
    const done = (v) => { back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const collect = () => {
      const out = {};
      for (const f of fields) {
        const i = inputs[f.name];
        if (!i) continue;
        out[f.name] = f.type === 'checkbox' ? i.checked : f.type === 'number' ? (i.value === '' ? null : +i.value) : i.value;
      }
      return out;
    };
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => done(collect()) }, ok);
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) done(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width: width + 'px' } : null },
        h('h2', null, title), hint ? h('p', { class: 'hint' }, hint) : null, h('div', { class: 'body' }, rows, extra),
        h('div', { class: 'foot' }, cancel ? h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, cancel) : null, okBtn)));
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); done(collect()); }
    });
    document.body.append(back);
    const first = back.querySelector('input:not([type=checkbox]),select,textarea');
    (first || okBtn).focus();
    if (first && first.select) first.select();
  });
}

// Popup menu next to an anchor (or at x,y). items: [{label, onclick, disabled, sep, checked, kbd}]
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
export function menu(items, anchor, at) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { m.append(h('div', { class: 'sep' })); continue; }
    if (it.head) { m.append(h('div', { class: 'mhead' }, it.head)); continue; }
    m.append(h('button', { type: 'button', role: 'menuitem', class: 'mi', disabled: !!it.disabled, onclick: () => { closeMenu(); it.onclick && it.onclick(); } },
      h('span', { class: 'ck' }, it.checked ? '✓' : ''), h('span', { class: 'ml' }, it.label), it.kbd ? h('span', { class: 'kb' }, it.kbd) : null));
  }
  document.body.append(m);
  const r = anchor ? anchor.getBoundingClientRect() : { left: at.x, bottom: at.y, top: at.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(innerWidth - mw - 4, r.left)) + 'px';
  m.style.top = Math.max(4, Math.min(innerHeight - mh - 4, r.bottom + 2 > innerHeight - mh ? (anchor ? r.top - mh - 2 : innerHeight - mh - 4) : r.bottom + 2)) + 'px';
  openMenu = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
    m.querySelector('button:not(:disabled)')?.focus();
  });
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { bs[(i + 1) % bs.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { bs[(i - 1 + bs.length) % bs.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); }
  });
  return m;
}

const BASE = ['#000000', '#434343', '#666666', '#999999', '#cccccc', '#efefef', '#f3f3f3', '#ffffff'];
const HUES = ['#e03131', '#f76707', '#f59f00', '#37b24d', '#1098ad', '#1c7ed6', '#7048e8', '#d6336c'];
function shade(hex, t) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return '#' + c.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t).toString(16).padStart(2, '0')).join('');
}
export function colorMenu(anchor, current, onPick, allowNone = 'No colour') {
  const grid = h('div', { class: 'palette' });
  const sw = (c) => h('button', { type: 'button', class: 'sw', style: { background: c }, title: c, 'aria-label': c, onclick: () => { closeMenu(); onPick(c); } });
  BASE.forEach((c) => grid.append(sw(c)));
  for (const t of [0.8, 0.6, 0.3, 0, -0.25, -0.5]) HUES.forEach((c) => grid.append(sw(shade(c, t))));
  const custom = h('input', { type: 'color', value: current && current[0] === '#' ? current : '#2563eb', class: 'custom', 'aria-label': 'Custom colour', onchange: (e) => { closeMenu(); onPick(e.target.value); } });
  const m = menu([], anchor);
  m.append(grid, h('div', { class: 'palfoot' }, allowNone ? h('button', { type: 'button', class: 'btn sm', onclick: () => { closeMenu(); onPick(null); } }, allowNone) : null, h('span', null, 'Custom'), custom));
  return m;
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

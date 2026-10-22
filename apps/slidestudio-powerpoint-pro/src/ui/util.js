// Small DOM helpers (adapted from SheetStudio Excel Pro): element builder, toast, modal dialog, popup menu, colour picker.
export const $ = (s, r = document) => r.querySelector(s);
export const E = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'innerHTML') el[k] = v;
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

// Modal dialog with simple form fields. Resolves with the values or null.
export function dialog(title, fields, { ok = 'OK', cancel = 'Cancel', hint, width } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement, inputs = {};
    const rows = fields.map((f) => {
      if (f.type === 'html') return f.el;
      let inp;
      if (f.type === 'select') inp = h('select', { id: 'f_' + f.name }, f.options.map((o) => h('option', { value: o[0], selected: String(o[0]) === String(f.value) }, o[1])));
      else if (f.type === 'textarea') inp = h('textarea', { id: 'f_' + f.name, rows: f.rows || 6, spellcheck: 'false' }, f.value ?? '');
      else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', id: 'f_' + f.name, checked: !!f.value });
      else inp = h('input', { type: f.type || 'text', id: 'f_' + f.name, value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, max: f.max, autocomplete: 'off' });
      inputs[f.name] = inp;
      return h('label', { class: 'fld' + (f.type === 'checkbox' ? ' chk' : '') }, f.type === 'checkbox' ? [inp, f.label] : [h('span', null, f.label), inp]);
    });
    const done = (v) => { back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const collect = () => { const o = {}; for (const f of fields) if (inputs[f.name]) o[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : f.type === 'number' ? +inputs[f.name].value : inputs[f.name].value; return o; };
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => done(collect()) }, ok);
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) done(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width: width + 'px' } : null },
        h('h2', null, title), hint ? h('p', { class: 'hint' }, hint) : null, h('div', { class: 'body' }, rows),
        h('div', { class: 'foot' }, cancel ? h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, cancel) : null, okBtn)));
    back.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && (e.ctrlKey || (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON'))) { e.preventDefault(); done(collect()); }
      else if (e.key === 'Tab') { const f = [...back.querySelectorAll('input,select,textarea,button')]; const i = f.indexOf(document.activeElement); if (e.shiftKey ? i <= 0 : i === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); } }
    });
    document.body.append(back);
    const first = back.querySelector('input:not([type=checkbox]),select,textarea');
    (first || okBtn).focus();
    if (first && first.select) first.select();
  });
}

// Popup menu at an anchor (or x,y). items: [{label, onclick, disabled, sep, head, checked, kbd}]
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
  m.style.top = Math.max(4, r.bottom + 2 + mh > innerHeight ? (anchor ? r.top - mh - 2 : innerHeight - mh - 4) : r.bottom + 2) + 'px';
  openMenu = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
    m.querySelector('button:not(:disabled),input')?.focus();
  });
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { bs[(i + 1) % bs.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { bs[(i - 1 + bs.length) % bs.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenu(); anchor && anchor.focus(); }
    e.stopPropagation();
  });
  return m;
}

const HUES = ['#e03131', '#f76707', '#f59f00', '#37b24d', '#1098ad', '#1c7ed6', '#7048e8', '#d6336c'];
const shade = (c, t) => '#' + [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t).toString(16).padStart(2, '0')).join('');
export function colorMenu(anchor, current, onPick, extra = []) {
  const grid = h('div', { class: 'palette' });
  const sw = (c) => h('button', { type: 'button', class: 'sw', style: { background: c }, title: c, 'aria-label': c, onclick: () => { closeMenu(); onPick(c); } });
  [...extra, '#000000', '#444444', '#777777', '#aaaaaa', '#dddddd', '#ffffff'].forEach((c) => grid.append(sw(c)));
  for (const t of [0.75, 0.4, 0, -0.35]) HUES.forEach((c) => grid.append(sw(shade(c, t))));
  const m = menu([], anchor);
  m.append(grid, h('div', { class: 'palfoot' }, h('button', { type: 'button', class: 'btn sm', onclick: () => { closeMenu(); onPick(null); } }, 'None'), h('span', null, 'Custom'),
    h('input', { type: 'color', value: current && current[0] === '#' ? current.slice(0, 7) : '#1c7ed6', 'aria-label': 'Custom colour', onchange: (e) => { closeMenu(); onPick(e.target.value); } })));
  return m;
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

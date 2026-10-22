// Small DOM helpers: element builder, toast, modal form dialog, popup menu, icons, downloads.
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
export function toast(msg, ms = 3400) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  const live = $('#live'); if (live) live.textContent = msg;
}

const ICONS = {
  select: 'M5 3l10 6-4.5 1.2L13 16l-2 1-2.5-5.6L5 14z', hand: 'M7 10V4.5a1.2 1.2 0 012.4 0V9m0-1V3.5a1.2 1.2 0 012.4 0V9m0-4.5a1.2 1.2 0 012.4 0V10m0-3a1.2 1.2 0 012.4 0v5c0 3-2 5.5-5.5 5.5S5 15.5 4 13l-1.2-2.8a1.2 1.2 0 012.2-1L7 12',
  highlight: 'M12 3l5 5-7.5 7.5H5v-4.5zM3 17h14', note: 'M4 4h12v9h-5l-4 3v-3H4z', draw: 'M3 17c3-1 4-6 7-6s2 4 4 4 3-3 3-3M13 3l4 4-7 7H6v-4z', text: 'M4 5V3.5h12V5M10 3.5V17M7.5 17h5',
  sign: 'M3 15c2-3 3-9 5-9s-1 9 1 9 2-5 3.5-5S13 14 15 14s2-1 2-1M3 18h14', redact: 'M3 6h14v8H3zM6 9h8', org: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z', find: 'M9 3a6 6 0 100 12A6 6 0 009 3zM14 14l4 4',
  save: 'M4 3h10l3 3v11H4zM7 3v4h6V3M7 17v-5h6v5', theme: 'M10 3a7 7 0 100 14 5.5 5.5 0 010-14z', side: 'M3 4h14v12H3zM8 4v12', cmd: 'M7 4a2 2 0 10-2 2h10a2 2 0 10-2-2v12a2 2 0 102-2H5a2 2 0 102 2z',
  prev: 'M12 5l-5 5 5 5', next: 'M8 5l5 5-5 5', up: 'M5 12l5-5 5 5', down: 'M5 8l5 5 5-5', close: 'M5 5l10 10M15 5L5 15', plus: 'M10 4v12M4 10h12', minus: 'M4 10h12', trash: 'M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11',
  rotate: 'M15 9a5.5 5.5 0 10-1.6 4.9M15 4v5h-5', copy: 'M7 7h9v10H7zM4 4h9v2M4 4v10h2', image: 'M3 4h14v12H3zM3 13l4-4 4 4 2-2 4 4M13 7.5a1 1 0 100 .1z', shape: 'M3 3h8v8H3zM14 14a3 3 0 100-.1z', stamp: 'M8 3h4l-1 6h4v3H5V9h4zM4 15h12v2H4z',
  link: 'M8.5 11.5l3-3M7 9l-2 2a2.8 2.8 0 004 4l2-2M13 11l2-2a2.8 2.8 0 00-4-4L9 7', check: 'M4 10l4 4 8-8', comment: 'M4 4h12v9h-5l-4 3v-3H4z',
};
export function icon(name, size = 18) {
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

// Modal dialog with form fields. Resolves with values or null. Field types: text, number, password, select, checkbox, textarea, color, range, file, html
export function dialog(title, fields, { ok = 'OK', cancel = 'Cancel', width, extra, hint, onOpen } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const inputs = {};
    const rows = fields.map((f) => {
      if (f.type === 'html') return f.el;
      let inp;
      if (f.type === 'select') inp = h('select', { id: 'f_' + f.name }, f.options.map((o) => h('option', { value: Array.isArray(o) ? o[0] : o, selected: String(Array.isArray(o) ? o[0] : o) === String(f.value) }, Array.isArray(o) ? o[1] : o)));
      else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', id: 'f_' + f.name, checked: !!f.value });
      else if (f.type === 'textarea') inp = h('textarea', { id: 'f_' + f.name, rows: f.rows || 4, spellcheck: 'false' }, f.value ?? '');
      else inp = h('input', { type: f.type || 'text', id: 'f_' + f.name, value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, accept: f.accept, multiple: f.multiple, spellcheck: 'false', autocomplete: 'off' });
      inputs[f.name] = inp;
      return h('label', { class: 'fld' + (f.type === 'checkbox' ? ' chk' : '') }, f.type === 'checkbox' ? [inp, f.label] : [h('span', null, f.label), inp]);
    });
    const done = (v) => { back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const collect = () => {
      const out = {};
      for (const f of fields) {
        const i = inputs[f.name];
        if (!i) continue;
        out[f.name] = f.type === 'checkbox' ? i.checked : f.type === 'number' || f.type === 'range' ? (i.value === '' ? null : +i.value) : f.type === 'file' ? [...i.files] : i.value;
      }
      return out;
    };
    const okBtn = ok ? h('button', { class: 'btn primary', type: 'button', onclick: () => done(collect()) }, ok) : null;
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) done(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width: `min(${width}px, 100%)` } : null },
        h('h2', null, title), hint ? h('p', { class: 'hint' }, hint) : null, h('div', { class: 'body' }, rows, extra),
        h('div', { class: 'foot' }, cancel ? h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, cancel) : null, okBtn)));
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && okBtn) { e.preventDefault(); done(collect()); }
      else if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...back.querySelectorAll('button,input,select,textarea,[tabindex]')].filter((x) => !x.disabled);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.body.append(back);
    back.done = done;
    const first = back.querySelector('input:not([type=checkbox]),select,textarea');
    (first || okBtn || back.querySelector('button'))?.focus();
    if (first && first.select) first.select();
    if (onOpen) onOpen(back, inputs, done);
  });
}
export const confirmDlg = (title, text, ok = 'OK') => dialog(title, [], { hint: text, ok }).then((v) => !!v);
export const promptDlg = (title, label, value = '', opts = {}) => dialog(title, [{ name: 'v', label, value, type: opts.type }], opts).then((v) => (v ? v.v : null));

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
    else if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); anchor?.focus?.(); }
  });
  return m;
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
export const pickFile = (accept, multiple = false) => new Promise((resolve) => {
  const i = h('input', { type: 'file', accept, multiple, hidden: true });
  i.addEventListener('change', () => { resolve([...i.files]); i.remove(); });
  i.addEventListener('cancel', () => { resolve([]); i.remove(); });
  document.body.append(i); i.click();
});
export const readFile = (f) => f.arrayBuffer().then((b) => new Uint8Array(b));
export const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
export const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
export const rgb01 = (hx) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hx || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0, 0, 0]; };

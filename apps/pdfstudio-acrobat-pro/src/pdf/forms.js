// AcroForm fields: read, fill (with regenerated appearances), create, flatten, import/export (JSON/CSV/FDF),
// JS-free calculations (AFSimple_Calculate), layout-based field detection and profile auto-fill.
import { Dict, Ref, Stream, Str, Name, N, bytes, textStr, textOf, normRect, clone } from './obj.js';
import { stdFont, winAnsi, wrapText, textWidth, pdfStrLit, rgbOps, f2 } from './edit.js';
import { flattenAnnots } from './annots.js';
import { PDFDoc } from './doc.js';

const nums = (doc, v) => { v = doc.get(v); return Array.isArray(v) ? v.map((x) => +doc.get(x) || 0) : []; };
const FF = { readonly: 1, required: 2, multiline: 1 << 12, password: 1 << 13, noToggleOff: 1 << 14, radio: 1 << 15, push: 1 << 16, combo: 1 << 17, edit: 1 << 18, multi: 1 << 21, comb: 1 << 24 };

export function acroForm(doc) { const a = doc.get(doc.catalog.get('AcroForm')); return a instanceof Dict ? a : null; }

export function fields(doc) {
  const af = acroForm(doc);
  if (!af) return [];
  const pageOf = new Map();
  doc.pages.forEach((p, i) => { for (const r of p.annots) if (r instanceof Ref) pageOf.set(r.num, i); });
  const out = [], seen = new Set();
  const walk = (ref, parentName, inh, depth) => {
    if (depth > 30) return;
    if (ref instanceof Ref) { if (seen.has(ref.num)) return; seen.add(ref.num); }
    const d = doc.get(ref);
    if (!(d instanceof Dict)) return;
    const t = d.has('T') ? textOf(doc.get(d.get('T'))) : null;
    const name = t === null ? parentName : parentName ? parentName + '.' + t : t;
    const h = { ...inh };
    for (const k of ['FT', 'Ff', 'V', 'DV', 'DA', 'Q', 'Opt', 'MaxLen']) if (d.has(k)) h[k] = d.get(k);
    const kids = doc.get(d.get('Kids'));
    const kidFields = Array.isArray(kids) ? kids.filter((k) => { const kd = doc.get(k); return kd instanceof Dict && (kd.has('T') || (!kd.has('Subtype') && kd.has('Kids'))); }) : [];
    if (kidFields.length) { for (const k of kids) walk(k, name, h, depth + 1); return; }
    const widgets = [];
    const addW = (r) => { const w = doc.get(r); if (!(w instanceof Dict)) return; const ap = doc.get(w.get('AP')); const nn = ap instanceof Dict ? doc.get(ap.get('N')) : null; const on = nn instanceof Dict && !(nn instanceof Stream) ? [...nn.keys()].find((k) => k !== 'Off') : null; widgets.push({ ref: r, page: r instanceof Ref ? pageOf.get(r.num) ?? -1 : -1, rect: normRect(nums(doc, w.get('Rect'))), on, as: doc.get(w.get('AS'))?.n, mk: doc.get(w.get('MK')) }); };
    if (Array.isArray(kids) && kids.length) for (const k of kids) addW(k); else addW(ref);
    const ft = doc.get(h.FT)?.n, ff = doc.get(h.Ff) | 0;
    const type = ft === 'Tx' ? 'text' : ft === 'Ch' ? (ff & FF.combo ? 'combo' : 'list') : ft === 'Sig' ? 'signature' : ft === 'Btn' ? (ff & FF.push ? 'button' : ff & FF.radio ? 'radio' : 'checkbox') : 'unknown';
    const v = doc.get(h.V);
    let value;
    if (type === 'checkbox' || type === 'radio') value = v instanceof Name ? (v.n === 'Off' ? '' : v.n) : widgets.find((w) => w.as && w.as !== 'Off')?.as || '';
    else if (Array.isArray(v)) value = v.map((x) => textOf(doc.get(x)));
    else value = v instanceof Name ? v.n : textOf(v);
    const opt = doc.get(h.Opt);
    const options = Array.isArray(opt) ? opt.map((o) => { o = doc.get(o); return Array.isArray(o) ? [textOf(doc.get(o[0])), textOf(doc.get(o[1]))] : [textOf(o), textOf(o)]; }) : [];
    const aa = doc.get(d.get('AA'));
    let calc = null;
    if (aa instanceof Dict) { const c = doc.get(aa.get('C')); if (c instanceof Dict) { const js = doc.get(c.get('JS')); calc = js instanceof Stream ? new TextDecoder('latin1').decode(doc.decoded(js)) : textOf(js); } }
    out.push({ name, ref, type, value, options, widgets, flags: ff, readonly: !!(ff & FF.readonly), required: !!(ff & FF.required), multiline: !!(ff & FF.multiline), password: !!(ff & FF.password), multi: !!(ff & FF.multi), maxLen: doc.get(h.MaxLen) || 0, da: textOf(doc.get(h.DA ?? af.get('DA'))), q: doc.get(h.Q) | 0, calc, tu: textOf(doc.get(d.get('TU'))) });
  };
  for (const r of doc.get(af.get('Fields')) || []) walk(r, '', {}, 0);
  return out;
}

function daInfo(da) {
  const m = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da || '');
  const c = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da || '') || null;
  const g = /([\d.]+)\s+g(?!\w)/.exec(da || '');
  return { size: m ? +m[2] : 0, color: c ? [+c[1], +c[2], +c[3]] : g ? [+g[1], +g[1], +g[1]] : [0, 0, 0] };
}
function widgetAP(doc, w, f, text, opts = {}) {
  const wd = doc.get(w.ref);
  const R = normRect(nums(doc, wd.get('Rect')));
  const W = R[2] - R[0], H = R[3] - R[1];
  const { size: s0, color } = daInfo(textOf(doc.get(wd.get('DA'))) || f.da);
  const res = new Dict({ Font: new Dict({ Helv: stdFont(doc) }) });
  const mk = doc.get(wd.get('MK'));
  let s = '';
  const bg = mk instanceof Dict ? nums(doc, mk.get('BG')) : [], bc = mk instanceof Dict ? nums(doc, mk.get('BC')) : [];
  if (bg.length === 3) s += `${rgbOps(bg)} 0 0 ${f2(W)} ${f2(H)} re f\n`;
  if (bc.length === 3) s += `${rgbOps(bc, true)} 1 w 0.5 0.5 ${f2(W - 1)} ${f2(H - 1)} re S\n`;
  s += '/Tx BMC q 1 1 ' + f2(W - 2) + ' ' + f2(H - 2) + ' re W n BT ';
  if (f.type === 'list') {
    const size = s0 || 10;
    s += `/Helv ${f2(size)} Tf ${rgbOps(color)}\n`;
    const sel = Array.isArray(text) ? text : [text];
    f.options.forEach(([exp, disp], i) => {
      const y = H - 2 - size * 1.15 * (i + 1);
      if (sel.includes(exp)) s += `ET 0.6 0.75 1 rg 1 ${f2(y - size * 0.25)} ${f2(W - 2)} ${f2(size * 1.15)} re f BT /Helv ${f2(size)} Tf ${rgbOps(color)}\n`;
      s += `1 0 0 1 3 ${f2(y)} Tm ${pdfStrLit(winAnsi(disp))} Tj\n`;
    });
  } else {
    const str = String(Array.isArray(text) ? text[0] ?? '' : text ?? '');
    const shown = f.password ? '*'.repeat(str.length) : str;
    if (f.multiline) {
      const size = s0 || 10;
      const lines = wrapText(shown, size, W - 4);
      s += `/Helv ${f2(size)} Tf ${rgbOps(color)}\n`;
      lines.forEach((ln, i) => { s += `1 0 0 1 2 ${f2(H - 2 - size * (i + 1))} Tm ${pdfStrLit(winAnsi(ln))} Tj\n`; });
    } else {
      let size = s0 || Math.min(12, H * 0.7);
      if (!s0) { const tw = textWidth(shown, size); if (tw > W - 4 && tw > 0) size = Math.max(4, (size * (W - 4)) / tw); }
      const tw = textWidth(shown, size);
      const x = f.q === 1 ? (W - tw) / 2 : f.q === 2 ? W - 2 - tw : 2;
      s += `/Helv ${f2(size)} Tf ${rgbOps(color)} 1 0 0 1 ${f2(x)} ${f2((H - size * 0.78) / 2)} Tm ${pdfStrLit(winAnsi(shown))} Tj\n`;
    }
  }
  s += 'ET Q EMC';
  void opts;
  return doc.add(new Stream(new Dict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, W, H], Resources: res }), bytes(s)));
}
function checkAP(doc, w, on, style = '4') {
  const wd = doc.get(w.ref);
  const R = normRect(nums(doc, wd.get('Rect'))), W = R[2] - R[0], H = R[3] - R[1];
  const res = new Dict({ Font: new Dict({ ZaDb: stdFont(doc, 'ZapfDingbats') }) });
  const sz = Math.min(W, H) * 0.8;
  const mk = doc.get(wd.get('MK'));
  const bc = mk instanceof Dict ? nums(doc, mk.get('BC')) : [];
  const border = bc.length === 3 ? `${rgbOps(bc, true)} 1 w 0.5 0.5 ${f2(W - 1)} ${f2(H - 1)} re S ` : '';
  const mkStream = (s) => doc.add(new Stream(new Dict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, W, H], Resources: res }), bytes(s)));
  const onS = mkStream(`${border}q BT 0 g /ZaDb ${f2(sz)} Tf ${f2((W - sz * 0.75) / 2)} ${f2((H - sz * 0.7) / 2)} Td (${style}) Tj ET Q`);
  const offS = mkStream(border || ' ');
  return new Dict({ [on]: onS, Off: offS });
}

export function setValue(doc, f, value) {
  const fd = doc.touch(f.ref);
  if (f.type === 'checkbox' || f.type === 'radio') {
    const val = value === true ? (f.widgets.find((w) => w.on)?.on || 'Yes') : value === false || value === '' || value === 'Off' ? 'Off' : String(value);
    fd.set('V', N(val));
    for (const w of f.widgets) {
      const wd = doc.touch(w.ref);
      const on = w.on || 'Yes';
      if (!w.on) wd.set('AP', new Dict({ N: checkAP(doc, w, on) }));
      wd.set('AS', N(val === on ? on : 'Off'));
    }
    return;
  }
  if (f.type === 'list' && f.multi && Array.isArray(value)) fd.set('V', value.map((v) => textStr(v)));
  else fd.set('V', textStr(Array.isArray(value) ? value[0] ?? '' : value ?? ''));
  if (f.type === 'combo' || f.type === 'list') {
    const idx = f.options.map((o, i) => ((Array.isArray(value) ? value : [value]).includes(o[0]) ? i : -1)).filter((i) => i >= 0);
    if (idx.length) fd.set('I', idx); else fd.delete('I');
  }
  for (const w of f.widgets) {
    const wd = doc.touch(w.ref);
    const disp = f.type === 'combo' ? (f.options.find((o) => o[0] === value)?.[1] ?? value) : value;
    wd.set('AP', new Dict({ N: widgetAP(doc, w, f, disp) }));
  }
  const af = doc.catalog.get('AcroForm');
  if (af) { const a = af instanceof Ref ? doc.touch(af) : doc.touch(doc.rootRef).get('AcroForm'); if (a instanceof Dict) a.delete('NeedAppearances'); }
}

function ensureAcroForm(doc) {
  const cat = doc.touch(doc.rootRef);
  let ar = cat.get('AcroForm');
  let af;
  if (ar instanceof Ref) af = doc.touch(ar);
  else if (ar instanceof Dict) { af = clone(ar); cat.set('AcroForm', (ar = doc.add(af))); }
  else { af = new Dict({ Fields: [] }); cat.set('AcroForm', (ar = doc.add(af))); }
  if (!af.get('DA')) af.set('DA', new Str('/Helv 0 Tf 0 g'));
  let dr = doc.get(af.get('DR'));
  dr = dr instanceof Dict ? clone(dr) : new Dict();
  let fonts = doc.get(dr.get('Font'));
  fonts = fonts instanceof Dict ? clone(fonts) : new Dict();
  if (!fonts.has('Helv')) fonts.set('Helv', stdFont(doc));
  if (!fonts.has('ZaDb')) fonts.set('ZaDb', stdFont(doc, 'ZapfDingbats'));
  dr.set('Font', fonts); af.set('DR', dr);
  return af;
}
// Create a field. spec: {type, name, rect, options:[..], value}
export function createField(doc, pageIdx, spec) {
  const af = ensureAcroForm(doc);
  const page = doc.pages[pageIdx];
  const used = new Set(fields(doc).map((f) => f.name));
  let name = spec.name || spec.type;
  for (let i = 2; used.has(name); i++) name = (spec.name || spec.type) + '_' + i;
  const base = { Type: N('Annot'), Subtype: N('Widget'), Rect: spec.rect.map((v) => Math.round(v * 100) / 100), F: 4, P: page.ref, MK: new Dict({ BC: [0.45, 0.5, 0.6], BG: [0.95, 0.97, 1] }) };
  let fref;
  const pd = doc.touch(page.ref);
  const annots = (doc.get(pd.get('Annots')) || []).slice();
  if (spec.type === 'radio') {
    const parent = new Dict({ FT: N('Btn'), Ff: FF.radio | FF.noToggleOff, T: textStr(name), Kids: [] });
    fref = doc.add(parent);
    const opts = spec.options && spec.options.length ? spec.options : ['Choice1', 'Choice2'];
    const h = spec.rect[3] - spec.rect[1];
    opts.forEach((o, i) => {
      const r = [spec.rect[0], spec.rect[1] - i * (h + 4), spec.rect[0] + h, spec.rect[3] - i * (h + 4)];
      const w = new Dict({ ...base, Rect: r, Parent: fref, AS: N('Off'), MK: new Dict({ BC: [0.45, 0.5, 0.6], CA: new Str('l') }) });
      const wr = doc.add(w);
      const onName = String(o).replace(/[^\w.-]/g, '_') || 'Choice' + i;
      w.set('AP', new Dict({ N: checkAP(doc, { ref: wr }, onName, 'l') }));
      parent.get('Kids').push(wr); annots.push(wr);
    });
  } else {
    const d = new Dict({ ...base, T: textStr(name), DA: new Str('/Helv 0 Tf 0 g') });
    if (spec.type === 'text') { d.set('FT', N('Tx')); if (spec.multiline) d.set('Ff', FF.multiline); }
    else if (spec.type === 'checkbox') { d.set('FT', N('Btn')); d.set('AS', N('Off')); d.set('V', N('Off')); }
    else if (spec.type === 'combo' || spec.type === 'list') { d.set('FT', N('Ch')); if (spec.type === 'combo') d.set('Ff', FF.combo); d.set('Opt', (spec.options || []).map((o) => textStr(o))); }
    else if (spec.type === 'signature') { d.set('FT', N('Sig')); d.delete('DA'); }
    fref = doc.add(d);
    if (spec.type === 'checkbox') d.set('AP', new Dict({ N: checkAP(doc, { ref: fref }, 'Yes') }));
    annots.push(fref);
  }
  pd.set('Annots', annots);
  af.set('Fields', [...(doc.get(af.get('Fields')) || []), fref]);
  const f = fields(doc).find((x) => x.ref.num === fref.num);
  if (f && spec.value !== undefined) setValue(doc, f, spec.value);
  else if (f && (f.type === 'text' || f.type === 'combo' || f.type === 'list')) setValue(doc, f, f.type === 'list' ? [] : '');
  return fref;
}
export function deleteField(doc, f) {
  const af = ensureAcroForm(doc);
  const top = (r) => { let d = doc.get(r), x = r; while (d instanceof Dict && d.get('Parent') instanceof Ref) { x = d.get('Parent'); d = doc.get(x); } return x; };
  const t = top(f.ref);
  af.set('Fields', (doc.get(af.get('Fields')) || []).filter((r) => r.num !== t.num));
  for (const w of f.widgets) if (w.page >= 0) { const pd = doc.touch(doc.pages[w.page].ref); pd.set('Annots', (doc.get(pd.get('Annots')) || []).filter((r) => r.num !== w.ref.num)); }
}
export function flattenForm(doc) {
  const n = flattenAnnots(doc, doc.pages.map((_, i) => i), (d, type) => type === 'Widget');
  doc.touch(doc.rootRef).delete('AcroForm');
  return n;
}

// JS-free calculation: AFSimple_Calculate("SUM"|"AVG"|"PRD"|"MIN"|"MAX", ...fields)
export function calculate(doc) {
  const fs = fields(doc);
  const byName = new Map(fs.map((f) => [f.name, f]));
  let changed = 0;
  for (const f of fs) {
    if (!f.calc) continue;
    const m = /AFSimple_Calculate\s*\(\s*["'](\w+)["']\s*,\s*(?:new\s+Array\s*\(([^)]*)\)|\[([^\]]*)\]|["']([^"']*)["'])/.exec(f.calc);
    if (!m) continue;
    const names = (m[2] || m[3] || m[4] || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const vals = [];
    for (const n of names) for (const g of fs) if (g.name === n || g.name.startsWith(n + '.')) { const v = parseFloat(String(g.value).replace(/[^\d.-]/g, '')); vals.push(isNaN(v) ? 0 : v); }
    if (!vals.length) continue;
    const op = m[1].toUpperCase();
    const r = op === 'SUM' ? vals.reduce((a, b) => a + b, 0) : op === 'PRD' ? vals.reduce((a, b) => a * b, 1) : op === 'AVG' ? vals.reduce((a, b) => a + b, 0) / vals.length : op === 'MIN' ? Math.min(...vals) : op === 'MAX' ? Math.max(...vals) : NaN;
    if (isNaN(r)) continue;
    const str = String(Math.round(r * 100) / 100);
    if (str !== f.value) { setValue(doc, f, str); f.value = str; changed++; }
    void byName;
  }
  return changed;
}

export const exportJSON = (doc) => JSON.stringify(Object.fromEntries(fields(doc).filter((f) => f.type !== 'button' && f.type !== 'signature').map((f) => [f.name, f.value])), null, 2);
export const exportCSV = (doc) => 'name,value\r\n' + fields(doc).filter((f) => f.type !== 'button').map((f) => [f.name, Array.isArray(f.value) ? f.value.join(';') : f.value].map((v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n');
export function exportFDF(doc) {
  const esc = (s) => pdfStrLit(String(s));
  let b = '%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /FDF << /Fields [';
  for (const f of fields(doc)) {
    if (f.type === 'button' || f.type === 'signature') continue;
    const v = f.type === 'checkbox' || f.type === 'radio' ? '/' + (f.value || 'Off') : Array.isArray(f.value) ? '[' + f.value.map(esc).join(' ') + ']' : esc(textStr(f.value).s);
    b += `\n<< /T ${esc(textStr(f.name).s)} /V ${v} >>`;
  }
  return b + '\n] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
}
// Parse field data -> Map name -> value. Accepts JSON, CSV (name,value) or FDF/XFDF-lite bytes.
export async function parseFieldData(u8) {
  const txt = new TextDecoder().decode(u8.subarray(0, 8));
  if (txt.startsWith('%FDF')) {
    const fd = await PDFDoc.load(u8);
    const root = fd.get(fd.trailer.get('Root'));
    const fdf = root && fd.get(root.get('FDF'));
    const out = new Map();
    const walk = (list, pre) => { for (const r of fd.get(list) || []) { const d = fd.get(r); if (!(d instanceof Dict)) continue; const t = textOf(fd.get(d.get('T'))); const nm = pre ? pre + '.' + t : t; if (d.has('V')) { const v = fd.get(d.get('V')); out.set(nm, v instanceof Name ? v.n : Array.isArray(v) ? v.map((x) => textOf(fd.get(x))) : textOf(v)); } if (d.has('Kids')) walk(d.get('Kids'), nm); } };
    if (fdf) walk(fdf.get('Fields'), '');
    return out;
  }
  const s = new TextDecoder().decode(u8).trim();
  if (s.startsWith('{')) return new Map(Object.entries(JSON.parse(s)));
  const out = new Map();
  const rows = parseCSV(s);
  for (const r of rows.slice(rows[0] && /^name$/i.test(rows[0][0]) ? 1 : 0)) if (r.length >= 2) out.set(r[0], r[1]);
  return out;
}
function parseCSV(s) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export function importValues(doc, map) {
  let n = 0;
  for (const f of fields(doc)) if (map.has(f.name)) { let v = map.get(f.name); if (f.type === 'checkbox' && (v === true || v === 'true')) v = true; if (f.type === 'list' && f.multi && typeof v === 'string') v = v.split(';'); setValue(doc, f, v); n++; }
  calculate(doc);
  return n;
}

// Detect form-like layout on a page: underscores runs, long thin rules and empty boxes. Returns [{rect, label}]
export function detectFields(chars, objs, pageBox) {
  const out = [];
  const labelFor = (r) => {
    const near = chars.filter((c) => c.u.trim() && c.b[2] <= r[0] + 2 && c.b[2] > r[0] - 220 && Math.abs((c.b[1] + c.b[3]) / 2 - (r[1] + r[3]) / 2) < 8);
    near.sort((a, b) => a.b[0] - b.b[0]);
    let s = near.map((c) => c.u).join('').replace(/[_:.\s]+$/, '').trim();
    if (!s) { const above = chars.filter((c) => c.u.trim() && c.b[1] >= r[3] && c.b[1] < r[3] + 14 && c.b[0] >= r[0] - 4 && c.b[0] < r[2]); s = above.map((c) => c.u).join('').trim(); }
    return s.slice(-40);
  };
  // underscore runs
  let run = null;
  const flush = () => { if (run && run.n >= 4) { const r = [run.b[0], run.b[1], run.b[2], run.b[1] + Math.max(12, (run.b[3] - run.b[1]) * 1.1)]; out.push({ rect: r, label: labelFor(r) }); } run = null; };
  for (const c of chars) {
    if (c.u === '_') { if (run && Math.abs(c.b[1] - run.b[1]) < 2 && c.b[0] - run.b[2] < 3) { run.b[2] = c.b[2]; run.n++; } else { flush(); run = { b: c.b.slice(), n: 1 }; } }
    else flush();
  }
  flush();
  // rules and boxes from vector paths
  for (const o of objs) {
    if (o.kind !== 'path' || !o.bbox) continue;
    const [x0, y0, x1, y1] = o.bbox, w = x1 - x0, h = y1 - y0;
    if (w > 60 && h < 2.5) { const r = [x0, y0, x1, y0 + 14]; if (!chars.some((c) => c.u.trim() && c.b[1] > y0 && c.b[1] < y0 + 10 && c.b[0] > x0 && c.b[2] < x1)) out.push({ rect: r, label: labelFor(r) }); }
    else if (w > 40 && h > 10 && h < 40 && w < (pageBox[2] - pageBox[0]) * 0.9) {
      const inside = chars.some((c) => c.u.trim() && c.b[0] >= x0 && c.b[2] <= x1 && c.b[1] >= y0 && c.b[3] <= y1);
      if (!inside) out.push({ rect: [x0 + 1, y0 + 1, x1 - 1, y1 - 1], label: labelFor([x0, y0, x1, y1]) });
    } else if (w >= 7 && w <= 16 && h >= 7 && h <= 16 && Math.abs(w - h) < 2) out.push({ rect: [x0, y0, x1, y1], label: labelFor([x1 + 200, y0, x1 + 200, y1]) || 'Check', check: true });
  }
  // de-duplicate overlapping proposals
  return out.filter((a, i) => !out.some((b, j) => j < i && Math.abs(a.rect[0] - b.rect[0]) < 4 && Math.abs(a.rect[1] - b.rect[1]) < 4));
}
// Profile auto-fill: map field name/label/tooltip to profile keys
export const PROFILE_KEYS = [['fullName', /full\s*name|^name$|your name|applicant|\bname\b(?!.*(company|org|first|last|middle|father|mother))/i], ['firstName', /first\s*name|given/i], ['lastName', /last\s*name|surname|family/i], ['email', /e-?mail/i], ['phone', /phone|mobile|tel|contact no/i], ['address', /address|street/i], ['city', /city|town/i], ['zip', /zip|postal|pin\s*code/i], ['country', /country/i], ['company', /company|organi[sz]ation|employer/i], ['date', /date(?!.*birth)/i], ['dob', /birth|dob/i]];
export function profileMatch(f) {
  const s = [f.name, f.tu, f.label].filter(Boolean).join(' ');
  for (const [k, re] of PROFILE_KEYS) if (re.test(s)) return k;
  return null;
}

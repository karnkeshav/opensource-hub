// PDF document: xref tables/streams, object streams, incremental updates, broken-file recovery,
// decryption, lazy object loading, page tree, and a transaction journal for undo/redo.
import { Lexer, parseObj, Cmd, findBack, findFwd, EOF } from './parser.js';
import { Dict, Ref, Stream, Str, N, clone, isName, bin, bytes } from './obj.js';
import { decode } from './filters.js';
import { Security } from './security.js';

export class PasswordError extends Error { constructor(retry) { super(retry ? 'Incorrect password' : 'Password required'); this.code = 'password'; this.retry = retry; } }

export class PDFDoc {
  constructor() {
    this.objs = new Map();   // modified / new objects (num -> value; null = deleted)
    this.cache = new Map();  // objects parsed from the file
    this.xref = new Map();   // num -> {t:1,off,gen} | {t:2,stm,idx}
    this.trailer = new Dict();
    this.bytes = new Uint8Array(0);
    this.base = 0; this.maxNum = 0; this.version = '1.7';
    this.undoStack = []; this.redoStack = []; this.tx = null; this.dirty = false;
    this.warnings = []; this.repaired = false; this.listeners = new Set();
  }

  static async load(input, password) {
    const d = new PDFDoc();
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    d.bytes = b;
    const hdr = findFwd(b, '%PDF-', 0, Math.min(b.length, 4096));
    if (hdr < 0) { const fdf = findFwd(b, '%FDF-', 0, Math.min(b.length, 1024)); if (fdf < 0) throw new Error('Not a PDF file (no %PDF- header)'); d.fdf = true; }
    d.base = Math.max(0, hdr);
    if (hdr >= 0) { const m = /^%PDF-(\d\.\d)/.exec(String.fromCharCode(...b.subarray(hdr, hdr + 8))); if (m) d.version = m[1]; }
    try { d.readXrefChain(); if (!d.checkRoot()) throw new Error('bad root'); }
    catch (e) { d.reconstruct(); }
    const enc = d.trailer.get('Encrypt');
    if (enc) {
      const encDict = d.get(enc);
      if (enc instanceof Ref) d.encRef = enc.num;
      const id = d.get(d.trailer.get('ID'));
      const id0 = Array.isArray(id) && id[0] instanceof Str ? id[0].s : '';
      const sec = await Security.open(encDict, id0, password, (x) => d.get(x));
      if (!sec) throw new PasswordError(password !== undefined && password !== '');
      d.sec = sec;
      d.cache.clear(); d.stmCache = null;
    }
    if (!d.checkRoot()) { d.reconstruct(); if (!d.checkRoot()) throw new Error('Could not find the document catalog'); }
    for (const k of d.xref.keys()) if (k > d.maxNum) d.maxNum = k;
    d.maxNum = Math.max(d.maxNum, (d.get(d.trailer.get('Size')) || 1) - 1);
    return d;
  }
  checkRoot() {
    try { const r = this.get(this.trailer.get('Root')); return r instanceof Dict && (this.fdf || this.get(r.get('Pages')) instanceof Dict); } catch { return false; }
  }

  // XRef ------------------------------------------------------------------
  readXrefChain() {
    const b = this.bytes;
    const sx = findBack(b, 'startxref', b.length, Math.max(0, b.length - 4096));
    if (sx < 0) throw new Error('no startxref');
    const lx = new Lexer(b, sx + 9);
    let off = lx.tok();
    const seen = new Set();
    let first = true;
    while (typeof off === 'number' && !seen.has(off)) {
      seen.add(off);
      const t = this.readXrefAt(this.base + off);
      if (first) { for (const [k, v] of t) this.trailer.set(k, v); first = false; }
      else for (const [k, v] of t) if (!this.trailer.has(k) && k !== 'Prev' && k !== 'XRefStm') this.trailer.set(k, v);
      const xs = t.get('XRefStm');
      if (typeof xs === 'number' && !seen.has(xs)) { seen.add(xs); try { this.readXrefAt(this.base + xs); } catch {} }
      off = t.get('Prev');
    }
    this.trailer.delete('Prev'); this.trailer.delete('XRefStm');
  }
  readXrefAt(pos) {
    const b = this.bytes;
    let lx = new Lexer(b, pos);
    const t = lx.tok();
    if (t instanceof Cmd && t.c === 'xref') return this.readXrefTable(lx);
    if (typeof t === 'number') { // xref stream
      lx.tok(); lx.tok();
      const o = parseObj(lx);
      const s = this.readStreamBody(lx, o);
      if (!(s instanceof Stream) || !isName(s.dict.get('Type'), 'XRef')) throw new Error('bad xref stream');
      this.readXrefStream(s);
      return s.dict;
    }
    // Some files have offsets that are slightly off; look nearby.
    const near = findFwd(b, 'xref', Math.max(0, pos - 64), Math.min(b.length, pos + 64));
    if (near >= 0 && near !== pos) return this.readXrefAt(near);
    throw new Error('bad xref offset');
  }
  readXrefTable(lx) {
    const b = this.bytes;
    for (;;) {
      const save = lx.p;
      const t = lx.tok();
      if (t instanceof Cmd && t.c === 'trailer') break;
      if (typeof t !== 'number') { lx.p = save; break; }
      const start = t, count = lx.tok();
      if (typeof count !== 'number') throw new Error('bad xref subsection');
      lx.skip();
      for (let i = 0; i < count; i++) {
        lx.skip();
        const p = lx.p;
        // entry: 10-digit offset, 5-digit gen, n/f  (tolerate odd spacing)
        const off = lx.tok(), gen = lx.tok(), kind = lx.tok();
        if (typeof off !== 'number' || !(kind instanceof Cmd)) { lx.p = p; throw new Error('bad xref entry'); }
        let num = start + i;
        if (i === 0 && start === 1 && kind.c === 'f' && off === 0) num = 0; // common off-by-one bug
        if (!this.xref.has(num)) this.xref.set(num, kind.c === 'n' ? { t: 1, off, gen } : { t: 0 });
      }
    }
    const tr = parseObj(lx);
    if (!(tr instanceof Dict)) throw new Error('bad trailer');
    void b;
    return tr;
  }
  readXrefStream(s) {
    const d = s.dict, data = decode(s, (x) => this.get(x));
    const W = d.get('W'), size = d.get('Size') || 0;
    const idx = d.get('Index') || [0, size];
    let p = 0;
    const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + data[p++]; return v; };
    for (let i = 0; i + 1 < idx.length; i += 2) {
      for (let k = 0; k < idx[i + 1]; k++) {
        if (p >= data.length) return;
        const num = idx[i] + k;
        const t = W[0] ? rd(W[0]) : 1, a = rd(W[1]), c = rd(W[2]);
        if (this.xref.has(num)) continue;
        if (t === 1) this.xref.set(num, { t: 1, off: a, gen: c });
        else if (t === 2) this.xref.set(num, { t: 2, stm: a, idx: c });
        else this.xref.set(num, { t: 0 });
      }
    }
  }
  reconstruct() {
    this.repaired = true; this.warnings.push('The cross-reference table was damaged; the file was repaired while opening.');
    const b = this.bytes;
    this.xref.clear(); this.cache.clear();
    const txt = new TextDecoder('latin1').decode(b);
    const re = /(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+obj\b/g;
    let m;
    const objstms = [];
    while ((m = re.exec(txt))) {
      const num = +m[1];
      if (m.index > 0 && /\d/.test(txt[m.index - 1])) continue;
      this.xref.set(num, { t: 1, off: m.index - this.base, gen: +m[2] });
    }
    const trailers = [];
    let i = -1;
    while ((i = txt.indexOf('trailer', i + 1)) >= 0) {
      try { const t = parseObj(new Lexer(b, i + 7)); if (t instanceof Dict) trailers.push(t); } catch {}
    }
    for (const [num, e] of this.xref) {
      let o; try { o = this.get(new Ref(num, e.gen)); } catch { continue; }
      if (o instanceof Stream) {
        if (isName(o.dict.get('Type'), 'ObjStm')) objstms.push(num);
        if (isName(o.dict.get('Type'), 'XRef')) trailers.push(o.dict);
      }
    }
    for (const sn of objstms) {
      try {
        const st = this.objStm(sn);
        st.offs.forEach(([n], k) => { if (!this.xref.has(n)) this.xref.set(n, { t: 2, stm: sn, idx: k }); });
      } catch {}
    }
    this.trailer = new Dict();
    for (const t of trailers) for (const [k, v] of t) if (['Root', 'Info', 'ID', 'Encrypt'].includes(k)) this.trailer.set(k, v);
    if (!this.checkRoot()) {
      for (const [num] of this.xref) {
        let o; try { o = this.get(new Ref(num)); } catch { continue; }
        if (o instanceof Dict && isName(o.get('Type'), 'Catalog')) { this.trailer.set('Root', new Ref(num, this.xref.get(num).gen || 0)); if (this.checkRoot()) break; }
      }
    }
  }

  // Objects ---------------------------------------------------------------
  get(v) {
    for (let i = 0; v instanceof Ref && i < 32; i++) v = this.obj(v.num);
    return v instanceof Ref ? null : v;
  }
  obj(num) {
    if (this.objs.has(num)) return this.objs.get(num);
    if (this.cache.has(num)) return this.cache.get(num);
    const e = this.xref.get(num);
    let o = null;
    if (e && e.t === 1) {
      try { o = this.parseAt(num, e); } catch (err) { this.warnings.push(`Object ${num}: ${err.message}`); o = null; }
    } else if (e && e.t === 2) {
      try { const st = this.objStm(e.stm); o = st.get(e.idx, num); } catch { o = null; }
    }
    this.cache.set(num, o);
    return o;
  }
  parseAt(num, e) {
    const b = this.bytes;
    const lx = new Lexer(b, this.base + e.off);
    const n = lx.tok(), g = lx.tok(), k = lx.tok();
    if (n !== num || !(k instanceof Cmd) || k.c !== 'obj') {
      if (!this.repaired) { // xref offset is wrong: repair once and retry
        this.reconstruct();
        const e2 = this.xref.get(num);
        if (e2 && e2.t === 1) { const lx2 = new Lexer(b, this.base + e2.off); lx2.tok(); lx2.tok(); lx2.tok(); return this.finish(num, e2.gen, this.readStreamBody(lx2, parseObj(lx2))); }
        if (e2 && e2.t === 2) return this.objStm(e2.stm).get(e2.idx, num);
        return null;
      }
      throw new Error('object header mismatch');
    }
    const o = parseObj(lx);
    return this.finish(num, g, this.readStreamBody(lx, o));
  }
  readStreamBody(lx, o) {
    if (!(o instanceof Dict)) return o;
    const save = lx.p;
    const t = lx.tok();
    if (!(t instanceof Cmd) || t.c !== 'stream') { lx.p = save; return o; }
    const b = this.bytes;
    let p = lx.p;
    if (b[p] === 13) p++;
    if (b[p] === 10) p++;
    let len = o.get('Length');
    if (len instanceof Ref) { const e = this.xref.get(len.num); len = e && e.t === 1 && !this.objs.has(len.num) && !this.cache.has(len.num) ? this.peekNum(e) : this.get(len); }
    let end = -1;
    if (typeof len === 'number' && len >= 0 && p + len <= b.length) {
      let q = p + len;
      while (q < b.length && (b[q] === 13 || b[q] === 10 || b[q] === 32 || b[q] === 9)) q++;
      if (findFwd(b, 'endstream', q, Math.min(b.length, q + 9)) === q) end = p + len;
    }
    if (end < 0) {
      const es = findFwd(b, 'endstream', p);
      end = es < 0 ? b.length : es;
      if (b[end - 1] === 10) end--;
      if (b[end - 1] === 13) end--;
    }
    return new Stream(o, b.subarray(p, end));
  }
  peekNum(e) { const lx = new Lexer(this.bytes, this.base + e.off); lx.tok(); lx.tok(); lx.tok(); const v = lx.tok(); return typeof v === 'number' ? v : -1; }
  finish(num, gen, o) {
    if (!this.sec || num === this.encRef) return o;
    const sec = this.sec;
    const walk = (v) => {
      if (v instanceof Str) return new Str(bin(sec.decrypt(num, gen, bytes(v.s), true)), v.hex);
      if (Array.isArray(v)) return v.map(walk);
      if (v instanceof Dict) { for (const [k, x] of v) v.set(k, walk(x)); return v; }
      return v;
    };
    if (o instanceof Stream) {
      walk(o.dict);
      const type = o.dict.get('Type');
      const f = o.dict.get('Filter');
      const identity = Array.isArray(f) ? f.some((x) => isName(x, 'Crypt')) : isName(f, 'Crypt');
      if (!isName(type, 'XRef') && !identity && !(isName(type, 'Metadata') && !sec.encMeta)) o.data = sec.decrypt(num, gen, o.data, false);
      return o;
    }
    return walk(o);
  }
  objStm(sn) {
    this.stmCache = this.stmCache || new Map();
    let st = this.stmCache.get(sn);
    if (st) return st;
    const s = this.obj(sn);
    if (!(s instanceof Stream)) throw new Error('missing object stream');
    const data = decode(s, (x) => this.get(x));
    const n = this.get(s.dict.get('N')) || 0, first = this.get(s.dict.get('First')) || 0;
    const lx = new Lexer(data);
    const offs = [];
    for (let i = 0; i < n; i++) { const a = lx.tok(), b = lx.tok(); if (typeof a !== 'number') break; offs.push([a, b]); }
    st = {
      offs,
      get: (idx, num) => {
        let k = idx;
        if (!offs[k] || offs[k][0] !== num) k = offs.findIndex((x) => x[0] === num);
        if (k < 0) return null;
        const l2 = new Lexer(data, first + offs[k][1], k + 1 < offs.length ? first + offs[k + 1][1] : data.length);
        return parseObj(l2);
      },
    };
    this.stmCache.set(sn, st);
    return st;
  }

  // Editing with an undo journal --------------------------------------------
  begin() { if (!this.tx) this.tx = { old: new Map(), trailer: undefined, depth: 0 }; this.tx.depth++; }
  commit(label = 'Edit') {
    const tx = this.tx;
    if (!tx || --tx.depth > 0) return;
    this.tx = null;
    if (!tx.old.size && tx.trailer === undefined) return;
    tx.label = label;
    tx.new = new Map([...tx.old.keys()].map((k) => [k, this.objs.has(k) ? this.objs.get(k) : undefined]));
    if (tx.trailer !== undefined) tx.newTrailer = this.trailer;
    this.undoStack.push(tx); if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.changed(label);
  }
  rollback() {
    const tx = this.tx; this.tx = null;
    if (!tx) return;
    this.restore(tx.old, tx.trailer);
    this._pages = null;
  }
  // Run fn inside a transaction (sync or async).
  edit(label, fn) {
    this.begin();
    let r;
    try { r = fn(); } catch (e) { this.tx.depth = 1; this.rollback(); throw e; }
    if (r && typeof r.then === 'function') return r.then((v) => { this.commit(label); return v; }, (e) => { if (this.tx) { this.tx.depth = 1; this.rollback(); } throw e; });
    this.commit(label);
    return r;
  }
  record(num) { if (this.tx && !this.tx.old.has(num)) this.tx.old.set(num, this.objs.has(num) ? this.objs.get(num) : undefined); }
  set(ref, v) { const num = ref instanceof Ref ? ref.num : ref; this.record(num); this.objs.set(num, v); this._pages = null; if (!this.tx) this.changed(); return ref; }
  add(v) { const num = ++this.maxNum; this.set(num, v); return new Ref(num, 0); }
  del(ref) { this.set(ref, null); }
  // Get a mutable copy of an indirect object registered in the current transaction.
  touch(ref) {
    if (!(ref instanceof Ref)) return ref;
    const num = ref.num;
    if (this.tx && this.tx.old.has(num) && this.objs.has(num)) return this.objs.get(num);
    const c = clone(this.obj(num));
    this.set(num, c);
    return c;
  }
  touchTrailer() {
    if (this.tx && this.tx.trailer === undefined) { this.tx.trailer = this.trailer; this.trailer = clone(this.trailer); }
    return this.trailer;
  }
  restore(map, trailer) {
    for (const [k, v] of map) { if (v === undefined) this.objs.delete(k); else this.objs.set(k, v); }
    if (trailer) this.trailer = trailer;
  }
  undo() {
    const tx = this.undoStack.pop(); if (!tx) return null;
    this.restore(tx.old, tx.trailer);
    this.redoStack.push(tx); this._pages = null; this.changed('undo'); return tx.label;
  }
  redo() {
    const tx = this.redoStack.pop(); if (!tx) return null;
    this.restore(tx.new, tx.newTrailer);
    this.undoStack.push(tx); this._pages = null; this.changed('redo'); return tx.label;
  }
  changed(label) { this.dirty = true; this._pages = null; for (const f of this.listeners) f(label); }
  isModified(num) { return this.objs.has(num); }

  // Catalog / pages -----------------------------------------------------------
  get catalog() { return this.get(this.trailer.get('Root')); }
  get rootRef() { return this.trailer.get('Root'); }
  get info() { const i = this.get(this.trailer.get('Info')); return i instanceof Dict ? i : new Dict(); }
  get pages() {
    if (this._pages) return this._pages;
    const out = [], seen = new Set();
    const walk = (ref, inh, depth) => {
      const node = this.get(ref);
      if (!(node instanceof Dict) || depth > 64) return;
      if (ref instanceof Ref) { if (seen.has(ref.num)) return; seen.add(ref.num); }
      const h = { ...inh };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) h[k] = node.get(k);
      const kids = this.get(node.get('Kids'));
      const type = this.get(node.get('Type'));
      if (Array.isArray(kids) && !isName(type, 'Page')) { for (const k of kids) walk(k, h, depth + 1); return; }
      out.push(new Page(this, ref, node, h));
    };
    const cat = this.catalog;
    walk(cat && cat.get('Pages'), {}, 0);
    return (this._pages = out);
  }
  get pageCount() { return this.pages.length; }
  pageIndex(ref) { return this.pages.findIndex((p) => p.ref instanceof Ref && ref instanceof Ref && p.ref.num === ref.num); }
  // Make the page tree flat (one Pages node), pushing inherited attributes into each page.
  flattenPages() {
    const pages = this.pages;
    const cat = this.touch(this.rootRef);
    let pr = cat.get('Pages');
    if (!(pr instanceof Ref)) { pr = this.add(pr instanceof Dict ? pr : new Dict()); cat.set('Pages', pr); }
    const root = this.touch(pr);
    const refs = [];
    for (const p of pages) {
      let ref = p.ref;
      if (!(ref instanceof Ref)) ref = this.add(p.dict);
      const d = this.touch(ref);
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (!d.has(k) && p.inh[k] !== undefined) d.set(k, p.inh[k]);
      if (!d.has('MediaBox')) d.set('MediaBox', [0, 0, 612, 792]);
      d.set('Parent', pr); d.set('Type', N('Page'));
      refs.push(ref);
    }
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) root.delete(k);
    root.set('Type', N('Pages')); root.set('Kids', refs); root.set('Count', refs.length);
    this._pages = null;
    return refs;
  }
  setPageOrder(refs) {
    const cat = this.catalog;
    const pr = cat.get('Pages');
    const root = this.touch(pr);
    for (const r of refs) { const d = this.touch(r); d.set('Parent', pr); }
    root.set('Kids', refs.slice()); root.set('Count', refs.length);
    this._pages = null;
  }
  // Resolve a stream's decoded bytes.
  decoded(s) { s = this.get(s); return s instanceof Stream ? decode(s, (x) => this.get(x)) : new Uint8Array(0); }
  // Ensure an object is indirect (returns a Ref).
  ref(v) { return v instanceof Ref ? v : this.add(v); }
}

export class Page {
  constructor(doc, ref, dict, inh) { this.doc = doc; this.ref = ref; this.dict = dict; this.inh = inh; }
  get resources() { const r = this.doc.get(this.dict.get('Resources') ?? this.inh.Resources); return r instanceof Dict ? r : new Dict(); }
  box(name) {
    const g = (k) => { const v = this.doc.get(this.dict.get(k) ?? this.inh[k]); return Array.isArray(v) && v.length === 4 ? v.map((x) => +this.doc.get(x) || 0) : null; };
    const n = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    const mb = n(g('MediaBox') || [0, 0, 612, 792]);
    if (name === 'MediaBox') return mb;
    const cb = g('CropBox');
    if (!cb) return mb;
    const c = n(cb), r = [Math.max(mb[0], c[0]), Math.max(mb[1], c[1]), Math.min(mb[2], c[2]), Math.min(mb[3], c[3])];
    return r[2] - r[0] > 1 && r[3] - r[1] > 1 ? r : mb;
  }
  get view() { return this.box('CropBox'); }
  get rotate() { const r = this.doc.get(this.dict.get('Rotate') ?? this.inh.Rotate) | 0; return ((r % 360) + 360) % 360; }
  get size() { const v = this.view, w = v[2] - v[0], h = v[3] - v[1]; return this.rotate % 180 ? [h, w] : [w, h]; }
  // Content stream bytes (concatenated).
  contents() {
    const c = this.doc.get(this.dict.get('Contents'));
    const list = Array.isArray(c) ? c.map((x) => this.doc.get(x)) : [c];
    const parts = [];
    for (const s of list) if (s instanceof Stream) { parts.push(this.doc.decoded(s)); parts.push(Uint8Array.of(10)); }
    let n = 0; for (const p of parts) n += p.length;
    const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; }
    return o;
  }
  get annots() { const a = this.doc.get(this.dict.get('Annots')); return Array.isArray(a) ? a : []; }
}
export { EOF };

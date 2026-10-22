// PDF font loader: simple (Type1/TrueType/Type3/MMType1) and composite (Type0) fonts.
// Embedded programs (TrueType, CFF, Type 1) are turned into glyph outlines; others fall back to system fonts.
import { Dict, Stream, Name, Ref, Str } from '../obj.js';
import { CMap } from './cmap.js';
import { Sfnt } from './truetype.js';
import { CFF } from './cff.js';
import { Type1 } from './type1.js';
import { encodings, encName, nameToUni, std14, std14Width } from './glyphs.js';

function sniff(u8) {
  if (!u8 || u8.length < 4) return null;
  const a = u8[0], b = u8[1], c = u8[2], d = u8[3];
  if ((a === 0 && b === 1 && c === 0 && d === 0) || String.fromCharCode(a, b, c, d) === 'true' || String.fromCharCode(a, b, c, d) === 'OTTO' || String.fromCharCode(a, b, c, d) === 'ttcf') return 'sfnt';
  if (a === 1 && b === 0 && (c === 4 || c === 3)) return 'cff';
  if (a === 0x25 && b === 0x21) return 't1';
  if (a === 0x80 && b === 1) return 't1';
  return null;
}

export class PDFFont {
  constructor(doc, dict) {
    this.doc = doc; this.dict = dict;
    const g = (k, d = dict) => doc.get(d.get(k));
    this.type = g('Subtype')?.n || 'Type1';
    this.base = g('BaseFont')?.n || '';
    this.composite = this.type === 'Type0';
    this.widths = new Map(); this.dw = 1000; this.missing = 0;
    this.fm = [0.001, 0, 0, 0.001, 0, 0];
    this.warn = null;
    let desc = g('FontDescriptor');
    let cid = null;
    if (this.composite) {
      const enc = g('Encoding');
      if (enc instanceof Name) {
        this.cmap = /-V$/.test(enc.n) ? CMap.identity(true) : CMap.identity(false);
        this.cmapName = enc.n;
        if (!/^Identity-[HV]$/.test(enc.n)) { this.ucs2 = /UCS2|UTF16/.test(enc.n); if (!this.ucs2) this.warn = 'Predefined CMap ' + enc.n + ' is approximated'; }
      } else if (enc instanceof Stream) {
        this.cmap = CMap.parse(doc.decoded(enc), 'cid', (n) => (/^Identity/.test(n) ? CMap.identity(/-V$/.test(n)) : null));
        if (enc.dict.get('WMode') === 1) this.cmap.vertical = true;
      } else this.cmap = CMap.identity(false);
      this.vertical = this.cmap.vertical;
      const df = g('DescendantFonts');
      cid = doc.get(Array.isArray(df) ? df[0] : df);
      if (!(cid instanceof Dict)) cid = new Dict();
      this.cidType = g('Subtype', cid)?.n;
      desc = g('FontDescriptor', cid);
      this.dw = g('DW', cid) ?? 1000;
      const W = g('W', cid);
      if (Array.isArray(W)) {
        for (let i = 0; i < W.length;) {
          const a = doc.get(W[i]), b = doc.get(W[i + 1]);
          if (Array.isArray(b)) { b.forEach((w, k) => this.widths.set(a + k, doc.get(w))); i += 2; }
          else { const w = doc.get(W[i + 2]); for (let c = a; c <= b && c - a < 65536; c++) this.widths.set(c, w); i += 3; }
        }
      }
      const dw2 = g('DW2', cid); this.dw2 = Array.isArray(dw2) ? dw2 : [880, -1000];
      const c2g = g('CIDToGIDMap', cid);
      if (c2g instanceof Stream) { const d = doc.decoded(c2g); this.c2g = (c) => (c * 2 + 1 < d.length ? (d[c * 2] << 8) | d[c * 2 + 1] : c); }
    } else {
      const fc = g('FirstChar') ?? 0, W = g('Widths');
      if (Array.isArray(W)) W.forEach((w, i) => this.widths.set(fc + i, +doc.get(w) || 0));
      this.hasWidths = Array.isArray(W) && W.length > 0;
    }
    this.desc = desc instanceof Dict ? desc : null;
    this.flags = this.desc ? g('Flags', this.desc) | 0 : 0;
    this.symbolic = !!(this.flags & 4) && !(this.flags & 32);
    if (this.desc) this.missing = g('MissingWidth', this.desc) || 0;
    const fam = this.desc ? (g('FontFamily', this.desc) instanceof Str ? g('FontFamily', this.desc).s : '') : '';
    this.std = std14(this.base + ' ' + fam);
    if (this.desc && (this.flags & 0x40000 || (g('FontWeight', this.desc) || 0) >= 600)) this.std.bold = true;
    if (this.desc && this.flags & 64) this.std.italic = true;
    if (this.flags & 1) this.std.mono = true;
    if (this.flags & 2 && !this.std.mono) this.std.serif = true;
    // Font program
    this.prog = null;
    if (this.type === 'Type3') this.initType3();
    else if (this.desc) {
      const ff = g('FontFile', this.desc) || g('FontFile2', this.desc) || g('FontFile3', this.desc);
      if (ff instanceof Stream) {
        try {
          const data = doc.decoded(ff);
          const kind = sniff(data);
          if (kind === 'sfnt') {
            const s = new Sfnt(data);
            if (s.has('CFF ')) { this.cff = new CFF(s.table('CFF ')); this.sfnt = s; this.prog = 'cff'; }
            else if (s.has('glyf')) { this.sfnt = s; this.prog = 'tt'; }
            else if (s.has('cmap')) this.sfnt = s;
          } else if (kind === 'cff') { this.cff = new CFF(data); this.prog = 'cff'; }
          else if (kind === 't1') { this.t1 = new Type1(data); if (this.t1.chars.size) { this.prog = 't1'; this.fm = this.t1.fm; } }
          if (this.prog === 'cff') this.fm = this.cff.fm;
          if (this.prog === 'tt') this.fm = [1 / this.sfnt.upem, 0, 0, 1 / this.sfnt.upem, 0, 0];
        } catch (e) { this.prog = null; this.warn = 'Embedded font ' + this.base + ' could not be read (' + e.message + '); using a substitute'; }
      }
    }
    // ToUnicode
    const tu = g('ToUnicode');
    if (tu instanceof Stream) { try { this.toUni = CMap.parse(doc.decoded(tu), 'uni'); } catch {} }
    if (!this.composite) this.initSimpleEncoding();
    this.cache = new Map();
  }
  initSimpleEncoding() {
    const g = (k, d = this.dict) => this.doc.get(d.get(k));
    const E = encodings();
    const enc = g('Encoding');
    let base = null;
    const diffs = new Map();
    if (enc instanceof Name) base = E[enc.n] || null;
    else if (enc instanceof Dict) {
      const be = g('BaseEncoding', enc); if (be instanceof Name) base = E[be.n] || null;
      const d = g('Differences', enc);
      if (Array.isArray(d)) { let c = 0; for (const x of d) { const v = this.doc.get(x); if (typeof v === 'number') c = v; else if (v instanceof Name) diffs.set(c++, v.n); } }
    }
    this.hasEnc = !!enc;
    const stdName = this.std;
    if (!base) {
      if (/^Symbol/.test(this.base.replace(/^[A-Z]{6}\+/, '')) && !this.prog) base = E.Symbol;
      else if (/ZapfDingbats|Dingbats/.test(this.base) && !this.prog) base = E.ZapfDingbats;
      else if (this.prog === 't1' || this.prog === 'cff') base = null; // built-in encoding
      else if (this.type === 'TrueType' && this.symbolic) base = null;
      else base = E.StandardEncoding;
      if (!this.prog && !base) base = E.StandardEncoding;
      if (!this.prog && this.type === 'TrueType') base = E.WinAnsiEncoding;
    }
    void stdName;
    this.names = new Array(256);
    for (let c = 0; c < 256; c++) {
      let n = diffs.get(c);
      if (!n && base) n = encName(base, c);
      if (!n && this.prog === 't1') n = this.t1.enc.get(c);
      if (!n && this.prog === 'cff' && !this.cff.cid) { const gid = this.cff.enc.get(c); if (gid !== undefined) n = this.cff.name(this.cff.charset[gid]); }
      this.names[c] = n || '';
    }
    this.diffs = diffs; this.baseEnc = base;
  }
  initType3() {
    const g = (k) => this.doc.get(this.dict.get(k));
    const fm = g('FontMatrix'); if (Array.isArray(fm) && fm.length === 6) this.fm = fm.map((x) => +this.doc.get(x) || 0);
    this.procs = g('CharProcs') instanceof Dict ? g('CharProcs') : new Dict();
    this.res3 = g('Resources');
    this.prog = 't3';
  }
  // Decode a PDF string (binary) into glyph records.
  decode(s) {
    const out = [];
    if (this.composite) {
      for (let i = 0; i < s.length;) {
        const [code, n] = this.cmap.read(s, i); i += n;
        let cid = this.cmap.get(code, n); if (typeof cid !== 'number') cid = this.cmap.identity ? code : 0;
        out.push(this.glyphRec(code, n, cid));
      }
    } else for (let i = 0; i < s.length; i++) out.push(this.glyphRec(s.charCodeAt(i), 1, s.charCodeAt(i)));
    return out;
  }
  glyphRec(code, n, cid) {
    const k = n * 0x1000000 + code;
    let r = this.cache.get(k);
    if (r) return r;
    r = { code, n, cid, space: n === 1 && code === 32, uni: this.unicode(code, n, cid), w: 0, key: undefined };
    r.key = this.glyphKey(code, cid, r.uni);
    r.w = this.width(code, cid, r);
    this.cache.set(k, r);
    return r;
  }
  unicode(code, n, cid) {
    if (this.toUni) { const u = this.toUni.get(code, n); if (typeof u === 'string' && u !== '\0') return u; if (typeof u === 'number') return String.fromCharCode(u); }
    if (this.composite) {
      if (this.ucs2) return String.fromCharCode(code);
      if (this.sfnt) { const rev = this.revCmap(); const gid = this.c2g ? this.c2g(cid) : cid; const u = rev.get(gid); if (u) return String.fromCodePoint(u); }
      if (this.cff && this.cff.cid === false) { const nm = this.cff.name(this.cff.charset[cid]); const u = nameToUni(nm); if (u) return u; }
      return '';
    }
    const nm = this.names[code];
    let u = nameToUni(nm);
    if (u) return u;
    if (this.prog === 'tt' && this.symbolic) { const rev = this.revCmap(); const gid = this.glyphKey(code, code, ''); const v = rev.get(gid); if (v && v < 0xe000) return String.fromCodePoint(v); }
    if (!nm && code >= 32 && code < 127) return String.fromCharCode(code);
    return '';
  }
  revCmap() {
    if (this._rev) return this._rev;
    const m = new Map();
    const cm = this.sfnt ? this.sfnt.cmaps() : {};
    const t = cm['3,1'] || cm['0,3'] || cm['0,4'] || cm['3,10'];
    if (t) for (const [u, g] of t) if (!m.has(g)) m.set(g, u);
    return (this._rev = m);
  }
  glyphKey(code, cid, uni) {
    const p = this.prog;
    if (!p) return undefined;
    if (p === 't3') return this.names[code];
    if (this.composite) {
      if (p === 'tt') return this.c2g ? this.c2g(cid) : cid;
      if (p === 'cff') return this.cff.cid ? this.cff.byCid.get(cid) ?? 0 : cid;
      return undefined;
    }
    const name = this.names[code];
    if (p === 't1') return this.t1.has(name) ? name : this.t1.enc.has(code) && this.t1.has(this.t1.enc.get(code)) ? this.t1.enc.get(code) : '.notdef';
    if (p === 'cff') {
      const c = this.cff;
      if (c.cid) return c.byCid.get(code) ?? code;
      const g1 = name ? c.byName.get(name) : undefined;
      if (g1 !== undefined) return g1;
      return c.enc.get(code) ?? 0;
    }
    // TrueType
    const cm = this.sfnt.cmaps();
    const c31 = cm['3,1'] || cm['0,3'], c30 = cm['3,0'], c10 = cm['1,0'];
    let gid;
    if (c31 && (!this.symbolic || this.hasEnc || !c30) && name) { const u = nameToUni(name); if (u) gid = c31.get(u.codePointAt(0)); }
    if (!gid && c30) gid = c30.get(code) || c30.get(0xf000 + code) || c30.get(0xf100 + code) || c30.get(0xf200 + code);
    if (!gid && name) gid = this.sfnt.postNames().get(name);
    if (!gid && c10) {
      if (name && this.hasEnc) { const mac = encodings().MacRomanEncoding, u = nameToUni(name); if (u) { const mc = mac.indexOf(u.charCodeAt(0)); if (mc >= 0) gid = c10.get(mc); } }
      if (!gid) gid = c10.get(code);
    }
    if (!gid && c31) gid = c31.get(code) || (uni ? c31.get(uni.codePointAt(0)) : 0);
    if (!gid && !c31 && !c30 && !c10) gid = code;
    return gid || 0;
  }
  width(code, cid, r) {
    if (this.composite) return this.widths.has(cid) ? this.widths.get(cid) : this.dw;
    if (this.widths.has(code)) {
      const w = this.widths.get(code);
      if (this.prog === 't3') return w * this.fm[0] * 1000;
      return w;
    }
    if (this.prog === 't3') return 0;
    if (!this.hasWidths || this.missing === 0) {
      const u = r.uni ? r.uni.codePointAt(0) : code;
      const sw = std14Width(this.std.key, u);
      if (sw) return sw;
      if (this.prog === 'tt') return this.sfnt.advance(r.key || 0);
      if (this.prog === 'cff') { const w = this.cff.width(r.key || 0); if (w) return w * this.fm[0] * 1000; }
      if (this.prog === 't1') { this.t1.glyphPath(r.key); const w = this.t1.widths.get(r.key); if (w) return w * this.fm[0] * 1000; }
    }
    return this.missing || (this.hasWidths ? 0 : 500);
  }
  // Outline for a glyph record in glyph space (apply this.fm to map to text space).
  path(r) {
    if (r.key === undefined) return null;
    if (this.prog === 'tt') return this.sfnt.glyphPath(r.key);
    if (this.prog === 'cff') return this.cff.glyphPath(r.key);
    if (this.prog === 't1') return this.t1.glyphPath(r.key);
    return null;
  }
  // CSS font for system-font fallback
  get css() {
    const s = this.std;
    const fam = s.mono ? '"Courier New", Courier, monospace' : s.symbol ? '"Segoe UI Symbol", Symbol, "Cambria Math", serif' : s.dingbats ? '"Segoe UI Symbol", "Zapf Dingbats", sans-serif'
      : s.serif ? '"Times New Roman", Times, serif' : /Gothic|Mincho|Ming|Song|Kai|Hei|Batang|Gulim|Dotum|MS-|SimSun|SimHei|KaiTi/i.test(this.base) ? '"Microsoft YaHei", "MS Gothic", "Malgun Gothic", sans-serif' : 'Arial, Helvetica, sans-serif';
    return (s.italic ? 'italic ' : '') + (s.bold ? 'bold ' : '') + '100px ' + fam;
  }
}

export function loadFont(doc, ref) {
  doc.fontCache = doc.fontCache || new Map();
  const key = ref instanceof Ref ? ref.num : null;
  if (key !== null && doc.fontCache.has(key)) return doc.fontCache.get(key);
  const d = doc.get(ref);
  let f;
  try { f = new PDFFont(doc, d instanceof Dict ? d : new Dict()); }
  catch (e) { f = new PDFFont(doc, new Dict()); f.warn = 'Font error: ' + e.message; }
  if (key !== null) doc.fontCache.set(key, f);
  return f;
}

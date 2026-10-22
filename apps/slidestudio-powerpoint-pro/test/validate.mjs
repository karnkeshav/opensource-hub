// Structural validator for written .pptx packages: well-formed XML, schema element order, relationships,
// content types and unique ids.
import assert from 'node:assert/strict';
import { unzip, text } from '../src/zip.js';
import { parseXML, findAll } from '../src/xml.js';

// ---------- a strict-ish package validator ----------
const ORDER = {
  sld: ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst'], cSld: ['bg', 'spTree'], sp: ['nvSpPr', 'spPr', 'style', 'txBody'], pic: ['nvPicPr', 'blipFill', 'spPr', 'style'],
  cxnSp: ['nvCxnSpPr', 'spPr', 'style'], graphicFrame: ['nvGraphicFramePr', 'xfrm', 'graphic'], spPr: ['xfrm', 'custGeom', 'prstGeom', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'ln', 'effectLst'],
  ln: ['noFill', 'solidFill', 'prstDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd'], txBody: ['bodyPr', 'lstStyle', 'p'], p: ['pPr', 'r|br|fld', 'endParaRPr'],
  pPr: ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr'],
  rPr: ['ln', 'noFill', 'solidFill', 'effectLst', 'highlight', 'latin', 'ea', 'cs', 'sym', 'hlinkClick'], tcPr: ['lnL', 'lnR', 'lnT', 'lnB', 'noFill', 'solidFill'], tc: ['txBody', 'tcPr'],
  tbl: ['tblPr', 'tblGrid', 'tr'], blipFill: ['blip', 'srcRect', 'stretch'], presentation: ['sldMasterIdLst', 'notesMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz', 'defaultTextStyle'],
  sldMaster: ['cSld', 'clrMap', 'sldLayoutIdLst', 'transition', 'timing', 'hf', 'txStyles'], sldLayout: ['cSld', 'clrMapOvr'], bgPr: ['noFill', 'solidFill', 'blipFill', 'effectLst'],
  nvSpPr: ['cNvPr', 'cNvSpPr', 'nvPr'], nvCxnSpPr: ['cNvPr', 'cNvCxnSpPr', 'nvPr'], cNvCxnSpPr: ['cxnSpLocks', 'stCxn', 'endCxn'], xfrm: ['off', 'ext', 'chOff', 'chExt'],
  themeElements: ['clrScheme', 'fontScheme', 'fmtScheme'], fmtScheme: ['fillStyleLst', 'lnStyleLst', 'effectStyleLst', 'bgFillStyleLst'], custGeom: ['avLst', 'gdLst', 'ahLst', 'cxnLst', 'rect', 'pathLst'],
};
function wellFormed(s, name) {
  const st = [];
  for (const m of s.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith('<?')) continue;
    if (m[1]) assert.equal(st.pop(), m[2], `${name}: mismatched </${m[2]}>`); else if (!m[3]) st.push(m[2]);
  }
  assert.equal(st.length, 0, name + ': unclosed tags');
}
function checkOrder(n, name) {
  const ord = ORDER[n.n];
  if (ord) { let last = -1; for (const c of n.c) { const i = ord.findIndex((o) => o.split('|').includes(c.n)); if (i < 0) continue; assert.ok(i >= last, `${name}: <${c.n}> out of order inside <${n.n}>`); last = i; } }
  n.c.forEach((c) => checkOrder(c, name));
}
export async function validate(bytes) {
  const z = unzip(bytes), names = Object.keys(z), parts = {};
  assert.equal(names[0], '[Content_Types].xml');
  for (const n of names) if (/\.(xml|rels)$/.test(n)) { parts[n] = text(await z[n]()); wellFormed(parts[n], n); checkOrder(parseXML(parts[n]), n); }
  const ct = parseXML(parts['[Content_Types].xml']), over = new Set(findAll(ct, 'Override').map((o) => o.a.PartName.slice(1))), defs = new Set(findAll(ct, 'Default').map((d) => d.a.Extension));
  for (const n of names) if (n !== '[Content_Types].xml') assert.ok(over.has(n) || defs.has(n.split('.').pop()), 'content type for ' + n);
  for (const p of over) assert.ok(names.includes(p), 'override points at missing part ' + p);
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const base = n.replace('_rels/', '').replace(/\.rels$/, '');
    for (const r of findAll(parseXML(parts[n]), 'Relationship')) {
      const dir = base.split('/').slice(0, -1);
      for (const s of r.a.Target.split('/')) { if (s === '..') dir.pop(); else dir.push(s); }
      assert.ok(names.includes(dir.join('/')), `${n}: ${r.a.Target} missing`);
    }
  }
  for (const n of names.filter((x) => /slides\/slide\d+\.xml$/.test(x))) {
    const ids = findAll(parseXML(parts[n]), 'cNvPr').map((c) => c.a.id);
    assert.equal(new Set(ids).size, ids.length, n + ': duplicate shape ids');
  }
  const pres = parseXML(parts['ppt/presentation.xml']), master = parseXML(parts['ppt/slideMasters/slideMaster1.xml']);
  const big = [...findAll(pres, 'sldMasterId'), ...findAll(master, 'sldLayoutId')].map((x) => +x.a.id);
  assert.equal(new Set(big).size, big.length);
  assert.ok(big.every((x) => x >= 2147483648));
  assert.ok(findAll(pres, 'sldId').every((x) => +x.a.id >= 256));
  return { z, parts };
}

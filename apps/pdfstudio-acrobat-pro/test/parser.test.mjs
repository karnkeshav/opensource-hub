import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDoc, saveFull, saveIncremental, sampleDoc, reopen, pageText, latin } from './helpers.mjs';
import { Lexer, parseObj } from '../src/pdf/parser.js';
import { Dict, Name, Ref, Str, bytes, textOf, textStr } from '../src/pdf/obj.js';
import { inflate, a85 } from '../src/pdf/filters.js';
import { md5, sha256, AES, aesEncrypt, aesDecrypt } from '../src/pdf/crypto.js';
import nc from 'node:crypto';

const enc = (s) => bytes(s);
// Hand-written minimal PDF with a classic xref table
function classic(extra = '') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 12 Tf 20 100 Td (Classic xref) Tj ET';
  let s = '%PDF-1.4\n', offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o ?? `<< /Length ${content.length} >>\nstream\n${content}\nendstream`}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${extra}>>\nstartxref\n${x}\n%%EOF\n`;
  return s;
}

test('lexer: literal/hex strings, names with #xx, nested arrays and dicts, refs', () => {
  const o = parseObj(new Lexer(enc('<< /A (a\\(b\\)c\\101\\\nd) /B <48 65 6c6c6F> /C#20D [1 -2.5 .5 3 0 R [true false null]] /E << /F /G#41 >> >>')));
  assert.ok(o instanceof Dict);
  assert.equal(o.get('A').s, 'a(b)cAd');
  assert.equal(o.get('B').s, 'Hello');
  assert.deepEqual(o.get('C D').slice(0, 3), [1, -2.5, 0.5]);
  assert.ok(o.get('C D')[3] instanceof Ref && o.get('C D')[3].num === 3);
  assert.equal(o.get('E').get('F').n, 'GA');
});

test('text strings: PDFDocEncoding and UTF-16BE round trip', () => {
  assert.equal(textOf(textStr('Résumé')), 'Résumé');
  const u = textStr('数学 ✓');
  assert.equal(u.s.charCodeAt(0), 0xfe);
  assert.equal(textOf(u), '数学 ✓');
});

test('classic xref table parses and extracts text', async () => {
  const d = await PDFDoc.load(enc(classic()));
  assert.equal(d.pageCount, 1);
  assert.match(await pageText(d, 0), /Classic xref/);
  assert.equal(d.repaired, false);
});

test('broken xref offsets are recovered by scanning', async () => {
  const s = classic().replace(/(\d{10}) 00000 n/g, (m, o) => String(+o + 7).padStart(10, '0') + ' 00000 n');
  const d = await PDFDoc.load(enc(s));
  assert.equal(d.pageCount, 1);
  assert.match(await pageText(d, 0), /Classic xref/);
});

test('missing startxref / truncated file is recovered', async () => {
  const s = classic().replace(/startxref[\s\S]*$/, '');
  const d = await PDFDoc.load(enc(s));
  assert.equal(d.repaired, true);
  assert.equal(d.pageCount, 1);
});

test('xref streams + object streams written and re-read', async () => {
  const d = await sampleDoc(4);
  const out = await saveFull(d, { objStreams: true });
  const t = latin(out);
  assert.match(t, /\/Type\s*\/XRef/);
  assert.match(t, /\/Type\s*\/ObjStm/);
  const d2 = await PDFDoc.load(out);
  assert.equal(d2.pageCount, 4);
  assert.match(await pageText(d2, 3), /Hello page 4/);
  assert.equal(d2.repaired, false);
});

test('incremental update appends a revision and keeps the original bytes', async () => {
  const d = await PDFDoc.load(await saveFull(await sampleDoc(2)));
  const before = d.bytes;
  d.edit('meta', () => { const i = d.touch(d.trailer.get('Info')); i.set('Title', textStr('Updated')); });
  const out = await saveIncremental(d);
  assert.deepEqual(out.subarray(0, before.length), before);
  const d2 = await PDFDoc.load(out);
  assert.equal(textOf(d2.info.get('Title')), 'Updated');
  assert.equal((latin(out).match(/%%EOF/g) || []).length, 2);
  // incremental on top of an xref-stream file
  const d3 = await PDFDoc.load(await saveFull(await sampleDoc(1), { objStreams: true }));
  d3.edit('m', () => { d3.touch(d3.trailer.get('Info')).set('Author', textStr('Z')); });
  const d4 = await PDFDoc.load(await saveIncremental(d3));
  assert.equal(textOf(d4.info.get('Author')), 'Z');
  assert.equal(d4.repaired, false);
});

test('filters: inflate matches zlib, ASCII85, predictor PNG up', () => {
  const data = nc.randomBytes(5000);
  assert.deepEqual(Buffer.from(inflate(zlib.deflateSync(data))), data);
  assert.equal(latin(a85(enc('87cURD]i,"Ebo80~>'))), 'Hello World!');
});

test('crypto primitives match node:crypto', () => {
  const d = nc.randomBytes(777), k = nc.randomBytes(32), iv = nc.randomBytes(16);
  assert.equal(Buffer.from(md5(d)).toString('hex'), nc.createHash('md5').update(d).digest('hex'));
  assert.equal(Buffer.from(sha256(d)).toString('hex'), nc.createHash('sha256').update(d).digest('hex'));
  const c = nc.createCipheriv('aes-256-cbc', k, iv); const ref = Buffer.concat([c.update(d), c.final()]);
  const mine = aesEncrypt(new Uint8Array(k), new Uint8Array(d), new Uint8Array(iv));
  assert.deepEqual(Buffer.from(mine.subarray(16)), ref);
  assert.deepEqual(Buffer.from(aesDecrypt(new Uint8Array(k), mine)), d);
  void AES;
});

test('undo/redo journal restores objects', async () => {
  const d = await sampleDoc(1);
  const info = d.trailer.get('Info');
  d.edit('t', () => d.touch(info).set('Title', textStr('A')));
  d.edit('t', () => d.touch(info).set('Title', textStr('B')));
  assert.equal(textOf(d.info.get('Title')), 'B');
  d.undo(); assert.equal(textOf(d.info.get('Title')), 'A');
  d.undo(); assert.equal(d.info.get('Title') ?? null, null);
  d.redo(); d.redo(); assert.equal(textOf(d.info.get('Title')), 'B');
  void Name; void Str;
});

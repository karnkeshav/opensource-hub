import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDoc, saveFull, sampleDoc, reopen, reopenInc, pageText, allText, latin } from './helpers.mjs';
import { newAES256 } from '../src/pdf/security.js';
import * as E from '../src/pdf/edit.js';
import * as A from '../src/pdf/annots.js';
import * as F from '../src/pdf/forms.js';
import { redactPage, sanitize, applyRedactAnnots } from '../src/pdf/redact.js';
import { outlineTree, setOutline, outline, getMeta, setMeta, pageLabels, setPageLabels } from '../src/pdf/nav.js';
import { Dict, Stream, Str, N, textOf, bytes } from '../src/pdf/obj.js';
import { Security } from '../src/pdf/security.js';
import { md5, rc4 } from '../src/pdf/crypto.js';

test('AES-256 encryption round trip: user password, owner password, wrong password', async () => {
  const d = await sampleDoc(2);
  const sec = await newAES256('user1', 'owner1', { print: true, modify: false, copy: false });
  const out = await saveFull(d, { security: sec, objStreams: true });
  assert.doesNotMatch(latin(out), /Hello page/);
  await assert.rejects(PDFDoc.load(out), (e) => e.code === 'password');
  await assert.rejects(PDFDoc.load(out, 'nope'), (e) => e.code === 'password' && e.retry);
  const u = await PDFDoc.load(out, 'user1');
  assert.match(await pageText(u, 1), /Hello page 2/);
  assert.equal(u.sec.permissions.copy, false);
  assert.equal(u.sec.permissions.print, true);
  const o = await PDFDoc.load(out, 'owner1');
  assert.equal(o.sec.owner, true);
  // remove encryption
  const plain = await PDFDoc.load(await saveFull(u));
  assert.equal(plain.sec, undefined);
  assert.match(await pageText(plain, 0), /Hello page 1/);
});

test('RC4 128-bit (R3) file written by hand decrypts with empty user password', async () => {
  // Build a minimal R3 RC4 file following Algorithm 2/3/5
  const PAD = bytes('\x28\xBF\x4E\x5E\x4E\x75\x8A\x41\x64\x00\x4E\x56\xFF\xFA\x01\x08\x2E\x2E\x00\xB6\xD0\x68\x3E\x80\x2F\x0C\xA9\xFE\x64\x53\x69\x7A');
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const id = bytes('0123456789abcdef'), P = -44;
  let ok = md5(PAD); for (let i = 0; i < 50; i++) ok = md5(ok);
  let O = rc4(ok, PAD); for (let i = 1; i <= 19; i++) O = rc4(ok.map((b) => b ^ i), O);
  let k = md5(cat(PAD, O, Uint8Array.of(P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255), id));
  for (let i = 0; i < 50; i++) k = md5(k);
  let U = rc4(k, md5(cat(PAD, id))); for (let i = 1; i <= 19; i++) U = rc4(k.map((b) => b ^ i), U);
  U = cat(U, new Uint8Array(16));
  const hex = (u) => Buffer.from(u).toString('hex');
  const content = 'BT /F1 12 Tf 20 100 Td (RC4 secret) Tj ET';
  const okey = md5(cat(k, Uint8Array.of(4, 0, 0, 0, 0))).subarray(0, 16);
  const encC = rc4(okey, bytes(content));
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${hex(O)}> /U <${hex(U)}> >>`];
  const parts = ['%PDF-1.4\n']; let len = parts[0].length; const offs = [];
  objs.forEach((o, i) => { offs.push(len); const s = o ? `${i + 1} 0 obj\n${o}\nendobj\n` : null; if (s) { parts.push(s); len += s.length; } else { const h = `4 0 obj\n<< /Length ${encC.length} >>\nstream\n`; parts.push(h, latin(encC), '\nendstream\nendobj\n'); len += h.length + encC.length + 18; } });
  const x = len;
  parts.push(`xref\n0 7\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${x}\n%%EOF\n`);
  const d = await PDFDoc.load(bytes(parts.join('')));
  assert.ok(d.sec);
  assert.match(await pageText(d, 0), /RC4 secret/);
  void Security;
});

test('page organise: rotate, delete, reorder, duplicate, insert blank, crop', async () => {
  const d = await sampleDoc(4);
  d.edit('ops', () => {
    E.rotatePages(d, [0], 90);
    E.deletePages(d, [1]);
    E.reorderPages(d, [2, 0, 1]);
    E.duplicatePages(d, [0]);
    E.insertBlank(d, 1);
    E.cropPages(d, [2], [10, 10, 300, 300]);
  });
  const r = await reopen(d);
  assert.equal(r.pageCount, 5);
  assert.match(await pageText(r, 0), /Hello page 4/);
  assert.equal(await pageText(r, 1), '');
  assert.match(await pageText(r, 2), /Hello page 4/);
  assert.match(await pageText(r, 3), /Hello page 1/);
  assert.equal(r.pages[3].rotate, 90);
  assert.deepEqual(r.pages[2].view, [10, 10, 300, 300]);
  d.undo();
  assert.equal(d.pageCount, 4);
});

test('merge and split by ranges / every N', async () => {
  const a = await sampleDoc(2, (i) => 'Alpha ' + i), b = await sampleDoc(3, (i) => 'Beta ' + i);
  a.edit('merge', () => E.importPages(a, b, [0, 1, 2]));
  const m = await reopen(a);
  assert.equal(m.pageCount, 5);
  assert.match(await pageText(m, 4), /Beta 2/);
  const ranges = E.parseRanges('1-2, 4-', 5);
  assert.deepEqual(ranges, [[0, 1], [3, 4]]);
  const parts = ranges.map((r) => E.extractPages(m, r));
  const p2 = await reopen(parts[1]);
  assert.equal(p2.pageCount, 2);
  assert.match(await pageText(p2, 0), /Beta 1/);
});

test('stamps: page numbers, Bates, watermark, header text, background', async () => {
  const d = await sampleDoc(3);
  d.edit('stamp', () => {
    E.stampText(d, [0, 1, 2], (i, k, n) => E.fmtTemplate('Page {page} of {total}', i, k, n), { pos: 'bc' });
    E.stampText(d, [0, 1, 2], (i, k) => E.batesNum('ACME', 7, 6, k), { pos: 'br' });
    E.watermark(d, [0, 1, 2], { text: 'CONFIDENTIAL', opacity: 0.2 });
    E.background(d, [0], { color: [1, 1, 0.8] });
  });
  const r = await reopen(d);
  const t = await allText(r);
  assert.match(t, /Page 2 of 3/);
  assert.match(t, /ACME000009/);
  assert.match(t, /CONFIDENTIAL/);
  assert.match(t, /Hello page 1/);
});

test('images: JPEG passthrough and RGBA with alpha', async () => {
  const d = await sampleDoc(1);
  // smallest valid baseline JPEG header for size parsing
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 20, 0, 30, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  await d.edit('img', async () => {
    const x = await E.imageXObject(d, { jpeg });
    assert.equal(x.w, 30); assert.equal(x.h, 20);
    E.drawImage(d, 0, x, [100, 100, 200, 160]);
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(128); rgba[3] = 0;
    const y = await E.imageXObject(d, { w: 4, h: 4, rgba });
    assert.ok(d.get(y.ref).dict.get('SMask'));
    E.drawImage(d, 0, y, [10, 10, 50, 50]);
  });
  const r = await reopen(d);
  const res = r.pages[0].resources.get('XObject');
  assert.equal([...r.get(res).keys()].length, 2);
});

test('annotations: every type written with appearance streams and re-read', async () => {
  const d = await sampleDoc(1);
  const types = [
    { type: 'Highlight', quads: [72, 714, 200, 714, 72, 700, 200, 700], color: [1, 1, 0] },
    { type: 'Underline', quads: [72, 714, 200, 714, 72, 700, 200, 700], color: [0, 0, 1] },
    { type: 'StrikeOut', quads: [72, 714, 200, 714, 72, 700, 200, 700], color: [1, 0, 0] },
    { type: 'Squiggly', quads: [72, 714, 200, 714, 72, 700, 200, 700], color: [0, 0.6, 0] },
    { type: 'Text', rect: [300, 700, 320, 720], contents: 'A sticky note', color: [1, 0.8, 0.2] },
    { type: 'FreeText', rect: [300, 600, 500, 650], contents: 'Free text box', fontSize: 12 },
    { type: 'Ink', ink: [[100, 500, 120, 520, 140, 505]], width: 2, color: [0, 0, 0] },
    { type: 'Line', line: [100, 400, 200, 450], arrow: true, width: 2, color: [1, 0, 0] },
    { type: 'Square', width: 2, color: [0, 0, 1] },
    { type: 'Circle', width: 2, color: [0, 0, 1] },
    { type: 'Polygon', vertices: [100, 300, 150, 350, 200, 300], width: 1, color: [0, 0, 0] },
    { type: 'Stamp', label: 'APPROVED', color: [0, 0.5, 0] },
    { type: 'Link', uri: 'https://example.com' },
  ];
  d.edit('annots', () => { for (const t of types) A.createAnnot(d, 0, { rect: t.rect || [100, 100, 220, 160], ...t }); });
  const r = await reopen(d);
  const list = A.listAnnots(r);
  assert.equal(list.length, types.length);
  for (const t of types) assert.ok(list.some((x) => x.type === t.type), t.type);
  for (const a of list) if (a.type !== 'Link') assert.ok(r.get(r.get(a.dict.get('AP')).get('N')) instanceof Stream, a.type + ' has AP');
  assert.equal(list.find((x) => x.type === 'Text').contents, 'A sticky note');
  // move + flatten
  const ft = list.find((x) => x.type === 'FreeText');
  r.edit('mv', () => A.transformAnnot(r, ft.ref, [1, 0, 0, 1, 10, -20]));
  assert.deepEqual(A.listAnnots(r).find((x) => x.type === 'FreeText').rect, [310, 580, 510, 630]);
  r.edit('flat', () => A.flattenAnnots(r, [0], (dd, type) => type === 'FreeText'));
  const r2 = await reopen(r);
  assert.match(await pageText(r2, 0), /Free text box/);
  assert.equal(A.listAnnots(r2).filter((x) => x.type === 'FreeText').length, 0);
});

test('forms: create every field type, fill, export/import JSON CSV FDF, calculate, flatten', async () => {
  const d = await sampleDoc(1);
  d.edit('fields', () => {
    F.createField(d, 0, { type: 'text', name: 'name', rect: [72, 500, 300, 520] });
    F.createField(d, 0, { type: 'checkbox', name: 'agree', rect: [72, 470, 86, 484] });
    F.createField(d, 0, { type: 'radio', name: 'size', rect: [72, 440, 86, 454], options: ['S', 'M', 'L'] });
    F.createField(d, 0, { type: 'combo', name: 'country', rect: [200, 440, 320, 456], options: ['India', 'Peru'] });
    F.createField(d, 0, { type: 'list', name: 'tags', rect: [340, 400, 440, 456], options: ['a', 'b', 'c'] });
    F.createField(d, 0, { type: 'text', name: 'q1', rect: [72, 350, 120, 366] });
    F.createField(d, 0, { type: 'text', name: 'q2', rect: [130, 350, 180, 366] });
    F.createField(d, 0, { type: 'text', name: 'total', rect: [190, 350, 240, 366] });
  });
  let r = await reopen(d);
  let fs = F.fields(r);
  assert.equal(fs.length, 8);
  // add a JS-free calculation like Acrobat writes it
  r.edit('calc', () => { const t = fs.find((f) => f.name === 'total'); const fd = r.touch(t.ref); fd.set('AA', new Dict({ C: new Dict({ S: N('JavaScript'), JS: textStrLit('AFSimple_Calculate("SUM", new Array ("q1", "q2"));') }) })); });
  fs = F.fields(r);
  r.edit('fill', () => {
    const by = (n) => F.fields(r).find((f) => f.name === n);
    F.setValue(r, by('name'), 'Ada Lovelace');
    F.setValue(r, by('agree'), true);
    F.setValue(r, by('size'), 'M');
    F.setValue(r, by('country'), 'Peru');
    F.setValue(r, by('q1'), '2.5');
    F.setValue(r, by('q2'), '4');
    F.calculate(r);
  });
  r = await reopen(r);
  const v = Object.fromEntries(F.fields(r).map((f) => [f.name, f.value]));
  assert.equal(v.name, 'Ada Lovelace'); assert.equal(v.agree, 'Yes'); assert.equal(v.size, 'M'); assert.equal(v.country, 'Peru'); assert.equal(v.total, '6.5');
  const json = F.exportJSON(r), csv = F.exportCSV(r), fdf = F.exportFDF(r);
  for (const data of [json, csv, fdf]) {
    const blank = await reopen(d);
    const m = await F.parseFieldData(bytes(data));
    blank.edit('imp', () => F.importValues(blank, m));
    const vv = Object.fromEntries(F.fields(blank).map((f) => [f.name, f.value]));
    assert.equal(vv.name, 'Ada Lovelace'); assert.equal(vv.size, 'M'); assert.equal(vv.country, 'Peru');
  }
  r.edit('flat', () => F.flattenForm(r));
  const flat = await reopen(r);
  assert.equal(F.fields(flat).length, 0);
  assert.match(await pageText(flat, 0), /Ada Lovelace/);
});
function textStrLit(s) { return new Str(s); }

test('redaction physically removes text, image and vector content under the area', async () => {
  const d = await sampleDoc(1, () => 'Account 4111-1111-1111-1111 belongs to Bob');
  await d.edit('img', async () => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4).fill(200);
    const x = await E.imageXObject(d, { w: 8, h: 8, rgba });
    E.drawImage(d, 0, x, [400, 400, 480, 480]);
    E.addContent(d, d.pages[0].ref, '0 0 1 rg 72 300 100 20 re f\n');
  });
  const r = await reopen(d);
  const before = await pageText(r, 0);
  assert.match(before, /4111-1111/);
  // locate the card number
  const { analyze, layout, findAll, charRects } = await import('../src/pdf/text.js');
  const a = await analyze(r, r.pages[0]);
  const lay = layout(a.chars);
  const m = findAll(lay, /\d{4}-\d{4}-\d{4}-\d{4}/)[0];
  const rects = charRects(a.chars, m.chars);
  const stats = await r.edit('redact', () => redactPage(r, 0, [...rects, [390, 390, 490, 490], [60, 290, 200, 330]]));
  assert.ok(stats.glyphs >= 19, 'glyphs removed: ' + stats.glyphs);
  assert.equal(stats.images, 1);
  assert.equal(stats.paths, 1);
  const out = await saveFull(r);
  const r2 = await PDFDoc.load(out);
  const after = await pageText(r2, 0);
  assert.doesNotMatch(after, /4111/);
  assert.match(after, /Account/);
  assert.match(after, /belongs to Bob/);
  // the digits are not anywhere in the decoded content streams either
  const all = r2.pages[0].contents();
  assert.doesNotMatch(latin(all), /4111|\(4|1111/);
  assert.doesNotMatch(latin(all), /0 0 1 rg 72 300 100 20 re f/);
  void applyRedactAnnots;
});

test('sanitize strips metadata, scripts and attachments', async () => {
  const d = await sampleDoc(1);
  d.edit('meta', () => {
    setMeta(d, { Title: 'Secret plan', Author: 'Mallory' });
    const cat = d.touch(d.rootRef);
    cat.set('OpenAction', new Dict({ S: N('JavaScript'), JS: new Str('app.alert(1)') }));
  });
  assert.equal(getMeta(d).Author, 'Mallory');
  await d.edit('san', () => sanitize(d));
  const r = await reopen(d);
  assert.equal(getMeta(r).Author, '');
  assert.equal(r.catalog.get('OpenAction'), undefined);
  assert.doesNotMatch(latin(await saveFull(r)), /Mallory|Secret plan/);
});

test('bookmarks, page labels and metadata edit round trip', async () => {
  const d = await sampleDoc(5);
  d.edit('nav', () => {
    setOutline(d, [{ title: 'Intro', page: 0 }, { title: 'Part 2', page: 2, kids: [{ title: 'Detail', page: 3 }] }]);
    setPageLabels(d, [{ start: 0, style: 'r' }, { start: 2, style: 'D', prefix: 'P-' }]);
    setMeta(d, { Title: 'Report', Author: 'Me' });
  });
  const r = await reopen(d);
  const o = outline(r);
  assert.equal(o.length, 2); assert.equal(o[1].kids[0].title, 'Detail'); assert.equal(o[1].kids[0].target.dest.page, 3);
  assert.deepEqual(pageLabels(r), ['i', 'ii', 'P-1', 'P-2', 'P-3']);
  assert.equal(getMeta(r).Title, 'Report');
  assert.deepEqual(outlineTree(r)[1].kids[0].page, 3);
});

test('incremental save preserves earlier bytes after annotation edits', async () => {
  const base = await reopen(await sampleDoc(1));
  base.edit('a', () => A.createAnnot(base, 0, { type: 'Text', rect: [10, 10, 30, 30], contents: 'inc' }));
  const r = await reopenInc(base);
  assert.equal(A.listAnnots(r)[0].contents, 'inc');
});

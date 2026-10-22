import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/engine.js';
import { readXlsx, writeXlsx, parseXML } from '../src/xlsx.js';
import { parseCSV, toCSV, sniff } from '../src/csv.js';
import { zip, unzip, crc32, text } from '../src/zip.js';

test('zip roundtrip, stored and deflated', async () => {
  const big = 'hello world '.repeat(500);
  const z = await zip({ 'a.txt': 'tiny', 'dir/b.txt': big });
  const u = unzip(z);
  assert.equal(text(await u['a.txt']()), 'tiny');
  assert.equal(text(await u['dir/b.txt']()), big);
  assert.ok(z.length < big.length);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('xml parser', () => {
  const r = parseXML('<?xml version="1.0"?><a x="1&amp;2"><b:c d=\'e\'>t&lt;t</b:c><f/></a>');
  const a = r.c[0];
  assert.equal(a.a.x, '1&2');
  assert.equal(a.c[0].n, 'c');
  assert.equal(a.c[0].t, 't<t');
  assert.equal(a.c[1].n, 'f');
});

test('csv', () => {
  const rows = parseCSV('a,b,c\r\n1,"x,y","he said ""hi"""\r\n3,,\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', 'he said "hi"'], ['3', '', '']]);
  assert.equal(toCSV([['a', 'b,c', 'd"e']]), 'a,"b,c","d""e"');
  assert.equal(sniff('a;b;c\n1;2;3'), ';');
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('xlsx keeps LET / LAMBDA / dynamic-array formulas, tables, notes, charts, pictures and macros', async () => {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  wb.tx(() => {
    ['Item', 'Qty', 'Price', 'Total'].forEach((h, c) => sh.setInput(0, c, h));
    [['A', 2, 5], ['B', 3, 4], ['C', 10, 1]].forEach((r, i) => { r.forEach((v, c) => sh.setInput(i + 1, c, String(v))); sh.setInput(i + 1, 3, '=[@Qty]*[@Price]'); });
    sh.tables.push({ name: 'Sales', r1: 0, c1: 0, r2: 3, c2: 3, header: true, accent: 5, band: true });
    sh.setInput(0, 6, '=LET(x,Sales[Total],y,2,SUM(x)*y)');
    sh.setInput(1, 6, '=MAP({1,2,3},LAMBDA(n,n*n))');
    sh.setInput(5, 0, '=VSTACK(Sales[Item],"z")');
    sh.setInput(6, 6, '=REGEXEXTRACT("abc123","\\d+")');
    sh.setInput(12, 9, '=PIVOTBY(Sales[Item],Sales[Qty],Sales[Total],SUM,0)');
    sh.notes.push({ r: 1, c: 1, text: 'Check this quantity' });
    sh.charts.push({ id: 'c1', type: 'column', range: 'Sheet1!A1:D4', title: 'Totals', x: 400, y: 60, w: 420, h: 260, stacked: false, byRow: false });
    sh.images.push({ id: 'i1', name: 'dot.png', alt: 'a dot', data: PNG, x: 20, y: 300, w: 40, h: 40 });
  });
  wb.vba = new Uint8Array([1, 2, 3, 4, 5]);
  const { bytes } = await writeXlsx(wb);
  const back = await readXlsx(bytes);
  back.warm();
  const b = back.sheets[0];
  assert.equal(b.cell(0, 6).f, 'LET(x,Sales[Total],y,2,SUM(x)*y)');
  assert.equal(b.get(0, 6), 64);
  assert.equal(b.cell(1, 6).f, 'MAP({1,2,3},LAMBDA(n,n*n))');
  assert.equal(b.get(1, 6), 1); assert.equal(b.get(1, 8), 9);
  assert.equal(b.get(6, 6), '123');
  assert.equal(b.get(5, 0), 'A'); assert.equal(b.get(8, 0), 'z');
  assert.equal(b.cell(12, 9).f, 'PIVOTBY(Sales[Item],Sales[Qty],Sales[Total],SUM,0)');
  assert.equal(b.get(12, 9) !== null && !b.get(12, 9).c, true);
  assert.equal(b.tables.length, 1);
  assert.deepEqual([b.tables[0].name, b.tables[0].r2, b.tables[0].accent], ['Sales', 3, 5]);
  assert.equal(b.cell(1, 3).f, 'Sales[@[Qty]]*Sales[@[Price]]');
  assert.equal(b.get(1, 3), 10);
  assert.deepEqual(b.notes, [{ r: 1, c: 1, text: 'Check this quantity' }]);
  assert.equal(b.charts.length, 1);
  assert.deepEqual([b.charts[0].type, b.charts[0].title, b.charts[0].range], ['column', 'Totals', 'Sheet1!A1:D4']);
  assert.ok(Math.abs(b.charts[0].x - 400) < 3 && Math.abs(b.charts[0].w - 420) < 3);
  assert.equal(b.images.length, 1);
  assert.ok(b.images[0].data.startsWith('data:image/png;base64,') && b.images[0].alt === 'a dot');
  assert.deepEqual([...back.vba], [1, 2, 3, 4, 5]);
});

test('xlsx roundtrip', async () => {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  const s2 = wb.addSheet('Second Sheet');
  wb.tx(() => {
    const bold = wb.sid({ b: true, bg: '#ffff00', fc: '#ff0000', ha: 'center', nf: '#,##0.00', bd: { t: 'thin', b: 'thin' } });
    sh.setInput(0, 0, 'Name'); sh.setInput(0, 1, 'Qty'); sh.setInput(1, 0, 'Apple'); sh.setInput(1, 1, '1234.5');
    sh.setStyle(1, 1, bold);
    sh.setInput(2, 1, '=B2*2'); sh.setInput(3, 1, '=XLOOKUP("Apple",A1:A2,B1:B2)'); sh.setInput(4, 1, '=1/0');
    sh.setInput(5, 0, 'true'); sh.setInput(6, 0, '2024-02-29');
    sh.setInput(8, 0, '=SEQUENCE(2,2)');
    sh.setInput(10, 0, '=LET(x,2,x*3)');
    s2.setInput(0, 0, "='Second Sheet'!B1"); s2.setInput(0, 1, '=Sheet1!B2+1');
    sh.merges.push({ r1: 12, c1: 0, r2: 12, c2: 2 });
    sh.freeze = { r: 1, c: 1 };
    sh.colW.set(0, 120); sh.rowH.set(0, 30);
    sh.cf.push({ type: 'cell', op: '>', v1: 100, ranges: [{ r1: 1, c1: 1, r2: 1, c2: 1 }], style: { bg: '#ff0000', b: true } });
    sh.cf.push({ type: 'scale', colors: ['#ff0000', '#00ff00'], ranges: [{ r1: 1, c1: 1, r2: 2, c2: 1 }] });
    sh.dv.push({ type: 'list', list: 'a,b,c', ranges: [{ r1: 20, c1: 0, r2: 20, c2: 0 }], allowBlank: true });
    sh.dv.push({ type: 'whole', op: 'between', v1: '1', v2: '10', ranges: [{ r1: 21, c1: 0, r2: 21, c2: 0 }] });
  });
  wb.names.set('QTY', { f: 'Sheet1!$B$2' });
  const { bytes, warnings } = await writeXlsx(wb);
  assert.deepEqual(warnings, []);
  const back = await readXlsx(bytes);
  back.warm();
  const b = back.sheets[0];
  assert.equal(back.sheets.length, 2);
  assert.equal(b.get(0, 0), 'Name');
  assert.equal(b.get(1, 1), 1234.5);
  assert.equal(b.get(2, 1), 2469);
  assert.equal(b.cell(3, 1).f, 'XLOOKUP("Apple",A1:A2,B1:B2)');
  assert.equal(b.get(3, 1), 1234.5);
  assert.equal(b.get(4, 1).c, '#DIV/0!');
  assert.equal(b.get(5, 0), true);
  assert.equal(b.get(6, 0), 45351);
  assert.equal(b.get(8, 0), 1); assert.equal(b.get(9, 1), 4);
  assert.equal(b.cell(10, 0).f, 'LET(x,2,x*3)'); assert.equal(b.get(10, 0), 6);
  assert.equal(back.sheets[1].get(0, 1), 1235.5);
  assert.equal(back.sheets[1].get(0, 0), 1235.5);
  const st = back.styles[b.cell(1, 1).s];
  assert.equal(st.b, true); assert.equal(st.bg, '#ffff00'); assert.equal(st.fc, '#ff0000'); assert.equal(st.ha, 'center'); assert.equal(st.nf, '#,##0.00');
  assert.deepEqual(st.bd, { t: 'thin', b: 'thin' });
  assert.deepEqual(b.merges, [{ r1: 12, c1: 0, r2: 12, c2: 2 }]);
  assert.deepEqual(b.freeze, { r: 1, c: 1 });
  assert.equal(b.colW.get(0), 120); assert.equal(b.rowH.get(0), 30);
  assert.equal(b.cf.length, 2); assert.equal(b.cf[0].op, '>'); assert.equal(b.cf[0].v1, 100); assert.equal(b.cf[0].style.bg, '#ff0000');
  assert.deepEqual(b.cf[1].colors, ['#ff0000', '#00ff00']);
  assert.equal(b.dv.length, 2); assert.equal(b.dv[0].list, 'a,b,c'); assert.equal(b.dv[1].v2, '10');
  assert.equal(back.names.get('QTY').f, 'Sheet1!$B$2');
});

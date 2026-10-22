import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbook, displayValue } from '../src/engine.js';
import { parseRefText, shiftFormula, colName, colNum } from '../src/parser.js';
import { format } from '../src/numfmt.js';
import { parseInput, textToNum } from '../src/core.js';

const mk = () => {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  const at = (a) => { const r = parseRefText(a); return [r.r1, r.c1]; };
  const set = (a, t) => wb.tx(() => sh.setInput(...at(a), t));
  const get = (a) => { wb.warm(); return sh.get(...at(a)); };
  const ev = (f) => { set('ZZ99', f); const v = get('ZZ99'); return v && v.c ? v.c : v; };
  return { wb, sh, set, get, ev };
};
const approx = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

test('column names', () => {
  assert.equal(colName(0), 'A'); assert.equal(colName(25), 'Z'); assert.equal(colName(26), 'AA'); assert.equal(colName(16383), 'XFD');
  assert.equal(colNum('XFD'), 16383);
});

test('arithmetic and precedence', () => {
  const { ev } = mk();
  assert.equal(ev('=1+2*3'), 7);
  assert.equal(ev('=-2^2'), 4);
  assert.equal(ev('=2^3^2'), 64);
  assert.equal(ev('=10/4'), 2.5);
  assert.equal(ev('=50%'), 0.5);
  assert.equal(ev('="a"&"b"&1'), 'ab1');
  assert.equal(ev('=1/0'), '#DIV/0!');
  assert.equal(ev('=1<2'), true);
  assert.equal(ev('="a"="A"'), true);
  assert.equal(ev('=FOO(1)'), '#NAME?');
});

test('references, ranges and dependency chains', () => {
  const { set, get, ev } = mk();
  set('A1', '1'); set('A2', '2'); set('A3', '3');
  assert.equal(ev('=SUM(A1:A3)'), 6);
  assert.equal(ev('=SUM(A:A)'), 6);
  assert.equal(ev('=AVERAGE(A1:A3)'), 2);
  set('B1', '=A1+1');
  for (let i = 2; i <= 2000; i++) set('B' + i, `=B${i - 1}+1`);
  assert.equal(get('B2000'), 2001);
});

test('circular reference', () => {
  const { set, get } = mk();
  set('A1', '=B1'); set('B1', '=A1');
  assert.equal(get('A1').c, '#CIRC!');
});

test('cross-sheet', () => {
  const { wb, set, ev } = mk();
  const s2 = wb.addSheet('Data 2');
  wb.tx(() => s2.setInput(0, 0, '5'));
  assert.equal(ev("='Data 2'!A1*2"), 10);
});

test('logical and lookup', () => {
  const { set, ev } = mk();
  set('A1', 'a'); set('B1', '10'); set('A2', 'b'); set('B2', '20'); set('A3', 'c'); set('B3', '30');
  assert.equal(ev('=IF(1>2,"x","y")'), 'y');
  assert.equal(ev('=VLOOKUP("b",A1:B3,2,FALSE)'), 20);
  assert.equal(ev('=XLOOKUP("c",A1:A3,B1:B3)'), 30);
  assert.equal(ev('=XLOOKUP("z",A1:A3,B1:B3,"none")'), 'none');
  assert.equal(ev('=INDEX(B1:B3,MATCH("c",A1:A3,0))'), 30);
  assert.equal(ev('=IFERROR(VLOOKUP("q",A1:B3,2,FALSE),"nf")'), 'nf');
  assert.equal(ev('=SUMIF(A1:A3,"<>b",B1:B3)'), 40);
  assert.equal(ev('=COUNTIF(B1:B3,">15")'), 2);
  assert.equal(ev('=SUMIFS(B1:B3,A1:A3,"a")+1'), 11);
  assert.equal(ev('=SWITCH(2,1,"one",2,"two","other")'), 'two');
  assert.equal(ev('=IFS(FALSE,1,TRUE,2)'), 2);
  assert.equal(ev('=SUMPRODUCT((B1:B3>10)*B1:B3)'), 50);
});

test('text functions', () => {
  const { ev } = mk();
  assert.equal(ev('=UPPER("abc")'), 'ABC');
  assert.equal(ev('=LEFT("hello",2)&RIGHT("hello",3)'), 'hello');
  assert.equal(ev('=MID("abcdef",2,3)'), 'bcd');
  assert.equal(ev('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(ev('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(ev('=TEXTJOIN(", ",TRUE,"a","","b")'), 'a, b');
  assert.equal(ev('=TRIM("  a   b ")'), 'a b');
  assert.equal(ev('=PROPER("hello world")'), 'Hello World');
  assert.equal(ev('=REGEXEXTRACT("abc123","\\d+")'), '123');
  assert.equal(ev('=TEXTBEFORE("a/b/c","/")'), 'a');
  assert.equal(ev('=TEXTAFTER("a/b/c","/",-1)'), 'c');
  assert.equal(ev('=FIND("c","abc")'), 3);
});

test('dates', () => {
  const { ev } = mk();
  assert.equal(ev('=DATE(2024,2,29)'), 45351);
  assert.equal(ev('=YEAR(DATE(2024,2,29))'), 2024);
  assert.equal(ev('=MONTH(45351)'), 2);
  assert.equal(ev('=DAY(45351)'), 29);
  assert.equal(ev('=EDATE(DATE(2024,1,31),1)'), 45351);
  assert.equal(ev('=EOMONTH(DATE(2024,1,15),0)'), 45322);
  assert.equal(ev('=WEEKDAY(DATE(2024,2,29))'), 5);
  assert.equal(ev('=DATEDIF(DATE(2020,1,1),DATE(2024,3,1),"Y")'), 4);
  assert.equal(ev('=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))'), 23);
  assert.equal(ev('=DATE(1900,3,1)'), 61);
  assert.equal(ev('=DATE(1900,1,1)'), 1);
});

test('math and stats', () => {
  const { set, ev } = mk();
  assert.equal(ev('=ROUND(2.5,0)'), 3);
  assert.equal(ev('=ROUND(-2.5,0)'), -3);
  assert.equal(ev('=ROUND(1.005,2)'), 1.01);
  assert.equal(ev('=ROUND(1234.5,-2)'), 1200);
  assert.equal(ev('=MOD(-3,2)'), 1);
  assert.equal(ev('=INT(-1.5)'), -2);
  assert.equal(ev('=CEILING(4.2,0.5)'), 4.5);
  assert.equal(ev('=GCD(12,18)'), 6);
  assert.equal(ev('=FACT(5)'), 120);
  [2, 4, 4, 4, 5, 5, 7, 9].forEach((v, i) => set('C' + (i + 1), String(v)));
  assert.equal(ev('=MEDIAN(C1:C8)'), 4.5);
  assert.equal(ev('=MODE(C1:C8)'), 4);
  approx(ev('=STDEV.P(C1:C8)'), 2);
  assert.equal(ev('=LARGE(C1:C8,2)'), 7);
  assert.equal(ev('=PERCENTILE(C1:C8,0.5)'), 4.5);
  assert.equal(ev('=RANK(5,C1:C8)'), 3);
  approx(ev('=PMT(0.05/12,360,200000)'), -1073.64, 0.01);
  approx(ev('=FV(0.06,10,-100)'), 1318.08, 0.01);
  approx(ev('=NPV(0.1,100,100,100)'), 248.685, 0.001);
  approx(ev('=IRR({-100,60,60})'), 0.1306, 0.0001);
  approx(ev('=NORM.S.INV(0.975)'), 1.95996, 0.001);
  approx(ev('=NORM.S.DIST(1.96,TRUE)'), 0.975, 0.001);
});

test('dynamic arrays spill', () => {
  const { set, get, ev } = mk();
  set('A1', '=SEQUENCE(3,2)');
  assert.equal(get('A1'), 1); assert.equal(get('B1'), 2); assert.equal(get('A3'), 5); assert.equal(get('B3'), 6);
  set('D1', '=SUM(A1#)');
  assert.equal(get('D1'), 21);
  set('F1', '3'); set('F2', '1'); set('F3', '2');
  set('H1', '=SORT(F1:F3)');
  assert.deepEqual([get('H1'), get('H2'), get('H3')], [1, 2, 3]);
  set('J1', '=UNIQUE({1;1;2})');
  assert.deepEqual([get('J1'), get('J2')], [1, 2]);
  set('B2', 'block');
  assert.equal(get('A1').c, '#SPILL!');
  assert.equal(ev('=SUM(FILTER({1;2;3;4},{1;0;1;0}))'), 4);
  assert.equal(ev('=SUM(TRANSPOSE({1,2,3}))'), 6);
  assert.equal(ev('=SUM({1,2;3,4}*2)'), 20);
});

test('LET / LAMBDA family', () => {
  const { ev } = mk();
  assert.equal(ev('=LET(x,2,y,3,x*y)'), 6);
  assert.equal(ev('=LAMBDA(x,x+1)(4)'), 5);
  assert.equal(ev('=SUM(MAP({1,2,3},LAMBDA(x,x*x)))'), 14);
  assert.equal(ev('=REDUCE(0,{1,2,3,4},LAMBDA(a,b,a+b))'), 10);
  assert.equal(ev('=SUM(SCAN(0,{1,2,3},LAMBDA(a,b,a+b)))'), 10);
  assert.equal(ev('=SUM(MAKEARRAY(2,2,LAMBDA(r,c,r*c)))'), 9);
});

test('named ranges and named lambdas', () => {
  const { wb, set, ev } = mk();
  set('A1', '7');
  wb.names.set('SEVEN', { f: 'Sheet1!$A$1' });
  wb.names.set('DBL', { f: 'LAMBDA(x,x*2)' });
  assert.equal(ev('=SEVEN+1'), 8);
  assert.equal(ev('=DBL(SEVEN)'), 14);
});

test('formula shifting', () => {
  assert.equal(shiftFormula('A1+$B$2+C$3+$D4', 1, 1), 'B2+$B$2+D$3+$D5');
  assert.equal(shiftFormula('SUM(A1:B2)', 2, 0), 'SUM(A3:B4)');
  assert.equal(shiftFormula('A1', -1, 0), '#REF!');
  assert.equal(shiftFormula("'My Sheet'!A1", 0, 1), "'My Sheet'!B1");
  assert.equal(shiftFormula('LOG10(A1)', 0, 1), 'LOG10(B1)');
});

test('insert and delete rows/columns adjust formulas, with undo', () => {
  const { wb, sh, set, get } = mk();
  set('A1', '1'); set('A2', '2'); set('A3', '3'); set('B1', '=SUM(A1:A3)'); set('B2', '=A3');
  wb.insert(sh, 'r', 1, 1);
  assert.equal(sh.cell(0, 1).f, 'SUM(A1:A4)');
  assert.equal(sh.cell(2, 1).f, 'A4');
  assert.equal(get('B1'), 6);
  wb.undo();
  assert.equal(sh.cell(0, 1).f, 'SUM(A1:A3)');
  wb.remove(sh, 'r', 2, 1);
  assert.equal(sh.cell(0, 1).f, 'SUM(A1:A2)');
  assert.equal(sh.cell(1, 1).f, '#REF!');
  wb.undo();
  wb.insert(sh, 'c', 0, 1);
  assert.equal(sh.cell(0, 2).f, 'SUM(B1:B3)');
});

test('rename sheet rewrites references', () => {
  const { wb, sh, set, get } = mk();
  const s2 = wb.addSheet('Other');
  wb.tx(() => s2.setInput(0, 0, '9'));
  set('A1', '=Other!A1+1');
  assert.equal(wb.renameSheet(s2, 'Renamed Sheet'), null);
  assert.equal(sh.cell(0, 0).f, "'Renamed Sheet'!A1+1");
  assert.equal(get('A1'), 10);
});

test('undo / redo', () => {
  const { wb, set, get } = mk();
  set('A1', '5'); set('A1', '6');
  assert.equal(get('A1'), 6);
  wb.undo(); assert.equal(get('A1'), 5);
  wb.undo(); assert.equal(get('A1'), null);
  wb.redo(); assert.equal(get('A1'), 5);
});

test('number formats', () => {
  const f = (v, c) => format(v, c).text;
  assert.equal(f(1234.567, '#,##0.00'), '1,234.57');
  assert.equal(f(0.256, '0%'), '26%');
  assert.equal(f(0.256, '0.0%'), '25.6%');
  assert.equal(f(5, '000'), '005');
  assert.equal(f(-5, '0;(0)'), '(5)');
  assert.equal(f(-1234.5, '#,##0.00'), '-1,234.50');
  assert.equal(f(1234567, '0.00E+00'), '1.23E+06');
  assert.equal(f(0.5, '#.##'), '.5');
  assert.equal(f(45351, 'yyyy-mm-dd'), '2024-02-29');
  assert.equal(f(45351.5, 'dd mmm yyyy hh:mm'), '29 Feb 2024 12:00');
  assert.equal(f(45351, 'dddd'), 'Thursday');
  assert.equal(f(0.75, 'h:mm AM/PM'), '6:00 PM');
  assert.equal(f(1234, '"$"#,##0'), '$1,234');
  assert.equal(f(1500000, '#,##0,,"M"'), '2M');
  assert.equal(f('abc', '@'), 'abc');
  assert.equal(f(3.14159, 'General'), '3.14159');
  assert.equal(f(123456789012, 'General'), '1.23457E+11');
  assert.equal(f(0, '0;-0;"zero"'), 'zero');
  assert.equal(f(-5, '[Red]0'), '-5');
});

test('input parsing', () => {
  assert.deepEqual(parseInput('12'), { v: 12 });
  assert.deepEqual(parseInput('12%'), { v: 0.12, nf: '0%' });
  assert.deepEqual(parseInput('1,234'), { v: 1234, nf: '#,##0' });
  assert.equal(parseInput('2024-02-29').v, 45351);
  assert.equal(parseInput('2/29/2024').v, 45351);
  assert.equal(parseInput('12:00').v, 0.5);
  assert.equal(parseInput('hello').v, 'hello');
  assert.equal(parseInput("'123").v, '123');
  assert.equal(parseInput('TRUE').v, true);
  assert.equal(textToNum('abc') !== textToNum('abc'), true);
});

test('autofill', () => {
  const { wb, sh, set, get } = mk();
  set('A1', '1'); set('A2', '2');
  wb.tx(() => wb.fill(sh, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 2, c1: 0, r2: 4, c2: 0 }));
  assert.equal(get('A5'), 5);
  set('C1', 'Jan'); wb.tx(() => wb.fill(sh, { r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 3, r2: 0, c2: 5 }));
  assert.equal(get('F1'), 'Apr');
  set('E3', '=A1*2'); wb.tx(() => wb.fill(sh, { r1: 2, c1: 4, r2: 2, c2: 4 }, { r1: 3, c1: 4, r2: 4, c2: 4 }));
  assert.equal(sh.cell(4, 4).f, 'A3*2');
  set('G1', 'Item 1'); wb.tx(() => wb.fill(sh, { r1: 0, c1: 6, r2: 0, c2: 6 }, { r1: 1, c1: 6, r2: 2, c2: 6 }));
  assert.equal(get('G3'), 'Item 3');
});

test('sort range with formula shifting', () => {
  const { wb, sh, set, get } = mk();
  set('A1', '3'); set('A2', '1'); set('A3', '2');
  set('B1', '=A1*10'); set('B2', '=A2*10'); set('B3', '=A3*10');
  wb.tx(() => wb.sortRange(sh, { r1: 0, c1: 0, r2: 2, c2: 1 }, 0, true, false));
  assert.deepEqual([get('A1'), get('A2'), get('A3')], [1, 2, 3]);
  assert.deepEqual([get('B1'), get('B2'), get('B3')], [10, 20, 30]);
});

test('conditional formatting and validation', async () => {
  const { cfAt, dvCheck } = await import('../src/engine.js');
  const { wb, sh, set } = mk();
  [1, 5, 9].forEach((v, i) => set('A' + (i + 1), String(v)));
  sh.cf.push({ type: 'cell', op: '>', v1: 4, ranges: [{ r1: 0, c1: 0, r2: 2, c2: 0 }], style: { bg: '#f00' } });
  sh.cf.push({ type: 'scale', colors: ['#000000', '#ffffff'], ranges: [{ r1: 0, c1: 0, r2: 2, c2: 0 }] });
  assert.equal(cfAt(sh, 0, 0, 1).bg, '#000000');
  assert.equal(cfAt(sh, 2, 0, 9).bg, '#ffffff');
  sh.dv.push({ type: 'list', list: 'x,y', ranges: [{ r1: 5, c1: 0, r2: 5, c2: 0 }] });
  assert.equal(dvCheck(sh, 5, 0, 'x'), null);
  assert.ok(dvCheck(sh, 5, 0, 'z'));
});

test('structured table references', () => {
  const { wb, sh, set, get, ev } = mk();
  ['Item', 'Qty', 'Unit Price', 'Total'].forEach((h, c) => set(String.fromCharCode(65 + c) + '1', h));
  [['A', 2, 5], ['B', 3, 4], ['C', 10, 1]].forEach((r, i) => r.forEach((v, c) => set(String.fromCharCode(65 + c) + (i + 2), String(v))));
  sh.tables.push({ name: 'Sales', r1: 0, c1: 0, r2: 3, c2: 3, header: true, accent: 0 });
  [2, 3, 4].forEach((r) => set('D' + r, '=[@Qty]*[@[Unit Price]]'));
  assert.deepEqual([get('D2'), get('D3'), get('D4')], [10, 12, 10]);
  assert.equal(ev('=SUM(Sales[Total])'), 32);
  assert.equal(ev('=SUM(Sales[[Qty]:[Unit Price]])'), 25);
  assert.equal(ev('=Sales[[#Headers],[Qty]]'), 'Qty');
  assert.equal(ev('=ROWS(Sales[#All])'), 4);
  assert.equal(ev('=ROWS(Sales)'), 3);
  assert.equal(ev('=INDEX(Sales[Item],MATCH("B",Sales[Item],0))'), 'B');
  assert.equal(ev('=SUM(Sales[Nope])'), '#REF!');
  wb.tx(() => { wb.renameTableColumn(sh, sh.tables[0], 'Qty', 'Count'); sh.setInput(0, 1, 'Count'); });
  assert.equal(sh.cell(1, 3).f, '[@Count]*[@[Unit Price]]');
  assert.equal(ev('=SUM(Sales[Count])'), 15);
  wb.insert(sh, 'r', 2, 1);
  assert.equal(sh.tables[0].r2, 4);
});

test('GROUPBY / PIVOTBY are live pivots', () => {
  const { wb, sh, set, get } = mk();
  const data = [['Region', 'Product', 'Sales'], ['North', 'Apple', 10], ['South', 'Pear', 20], ['North', 'Pear', 5], ['South', 'Apple', 7], ['North', 'Apple', 3]];
  data.forEach((r, i) => r.forEach((v, c) => set(String.fromCharCode(65 + c) + (i + 1), String(v))));
  set('F1', '=GROUPBY(A1:A6,C1:C6,SUM,3)');
  assert.deepEqual([get('F1'), get('G1')], ['Region', 'Sales']);
  assert.deepEqual([get('F2'), get('G2'), get('F3'), get('G3'), get('F4'), get('G4')], ['North', 18, 'South', 27, 'Total', 45]);
  set('J1', '=PIVOTBY(A1:A6,B1:B6,C1:C6,SUM,3)');
  assert.deepEqual([get('K1'), get('L1'), get('M1')], ['Apple', 'Pear', 'Total']);
  assert.deepEqual([get('J2'), get('K2'), get('L2'), get('M2')], ['North', 13, 5, 18]);
  assert.deepEqual([get('J3'), get('K3'), get('L3'), get('M3')], ['South', 7, 20, 27]);
  assert.deepEqual([get('J4'), get('K4'), get('L4'), get('M4')], ['Total', 20, 25, 45]);
  set('C6', '100'); // pivots recalculate when the data changes
  assert.equal(get('M4'), 142);
  set('P1', '=GROUPBY(A1:A6,C1:C6,AVERAGE,3,0)');
  assert.equal(get('Q1'), 'Sales');
  assert.equal(get('Q2'), (10 + 5 + 100) / 3);
  assert.equal(get('P4'), null); // total_depth 0: no total row
  // as a table source
  sh.tables.push({ name: 'D', r1: 0, c1: 0, r2: 5, c2: 2, header: true });
  set('S1', '=GROUPBY(D[[#All],[Product]],D[[#All],[Sales]],COUNTA,3)');
  assert.deepEqual([get('S2'), get('T2'), get('S3'), get('T3')], ['Apple', 3, 'Pear', 2]);
  assert.equal(wb.sheets.length, 1);
});

test('JSON round trip', () => {
  const { wb, sh, set, get } = mk();
  set('A1', '5'); set('A2', '=A1*2'); set('A3', '=1/0');
  const j = JSON.parse(JSON.stringify(wb.toJSON()));
  const w2 = Workbook.fromJSON(j);
  w2.warm();
  assert.equal(w2.sheets[0].get(1, 0), 10);
  assert.equal(w2.sheets[0].get(2, 0).c, '#DIV/0!');
});

test('performance: 50k formulas', () => {
  const { wb, sh } = mk();
  const t = Date.now();
  wb.tx(() => { for (let i = 0; i < 50000; i++) { sh.setInput(i, 0, String(i)); sh.setInput(i, 1, `=A${i + 1}*2+B${i}`); } });
  wb.warm();
  const ms = Date.now() - t;
  assert.ok(ms < 5000, `slow: ${ms}ms`);
  console.log('50k formulas in', ms, 'ms');
});

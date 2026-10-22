import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/engine.js';
import { runQuery, loadQuery, describe, STEPS } from '../src/query.js';

const CSV = 'Region,Product,Qty,Price\nNorth,Apple,3,1.5\nSouth,Pear,4,2.25\nNorth,Plum,10,0.8\nSouth,Apple,5,1.5\nEast,Fig,,3\n';
const q = (steps, extra = {}) => ({ id: 'q1', name: 'Result', source: { type: 'csv', text: CSV }, steps, dest: { sheet: 'Sheet1', r: 0, c: 0 }, ...extra });

test('filter, sort, add column, group', () => {
  const wb = new Workbook();
  let rows = runQuery(wb, q([{ op: 'filter', col: 'Qty', test: '>=', value: '4' }, { op: 'sort', col: 'Qty', desc: '1' }]));
  assert.deepEqual(rows.map((r) => r[2]), ['Qty', 10, 5, 4]);
  rows = runQuery(wb, q([{ op: 'add', name: 'Total', expr: '[Qty]*[Price]' }, { op: 'filter', col: 'Qty', test: 'nonblank', value: '' }]));
  assert.deepEqual(rows[0], ['Region', 'Product', 'Qty', 'Price', 'Total']);
  assert.deepEqual(rows.slice(1).map((r) => r[4]), [4.5, 9, 8, 7.5]);
  rows = runQuery(wb, q([{ op: 'add', name: 'Total', expr: '[Qty]*[Price]' }, { op: 'group', by: ['Region'], col: 'Total', fn: 'sum', as: 'Revenue' }, { op: 'sort', col: 'Revenue', desc: '1' }]));
  assert.deepEqual(rows, [['Region', 'Revenue'], ['South', 16.5], ['North', 12.5], ['East', 0]]);
});

test('unpivot, split, replace, type, distinct, rename', () => {
  const wb = new Workbook();
  let rows = runQuery(wb, q([{ op: 'keep', cols: ['Region', 'Qty', 'Price'] }, { op: 'unpivot', cols: ['Qty', 'Price'], attr: 'Measure', val: 'Value' }, { op: 'top', n: 4 }]));
  assert.deepEqual(rows, [['Region', 'Measure', 'Value'], ['North', 'Qty', 3], ['North', 'Price', 1.5], ['South', 'Qty', 4], ['South', 'Price', 2.25]]);
  rows = runQuery(wb, { ...q([{ op: 'split', col: 'k', delim: '|' }, { op: 'type', col: 'k.2', to: 'number' }]), source: { type: 'csv', text: 'k,v\na|1,x\nb|2,y\n' } });
  assert.deepEqual(rows, [['k.1', 'k.2', 'v'], ['a', 1, 'x'], ['b', 2, 'y']]);
  rows = runQuery(wb, q([{ op: 'keep', cols: ['Region'] }, { op: 'distinct' }, { op: 'rename', from: 'Region', to: 'Area' }, { op: 'upper', col: 'Area' }]));
  assert.deepEqual(rows, [['Area'], ['NORTH'], ['SOUTH'], ['EAST']]);
  assert.throws(() => runQuery(wb, q([{ op: 'keep', cols: ['Nope'] }])), /Step 1.*Nope/);
  assert.match(describe({ op: 'filter', col: 'Qty', test: '>', value: '3' }), /Filter rows/);
  assert.ok(Object.keys(STEPS).length >= 20);
});

test('json source and range/table source, refresh replaces output', () => {
  const wb = new Workbook();
  const sh = wb.sheets[0];
  const json = JSON.stringify([{ n: 'a', v: 1 }, { n: 'b', v: 2 }, { n: 'c', v: 3 }]);
  const query = { id: 'j', name: 'FromJson', source: { type: 'json', text: json }, steps: [{ op: 'filter', col: 'v', test: '>', value: '1' }], dest: { sheet: 'Sheet1', r: 2, c: 1 } };
  wb.tx(() => loadQuery(wb, query));
  assert.deepEqual([sh.get(2, 1), sh.get(3, 1), sh.get(4, 1)], ['n', 'b', 'c']);
  assert.equal(sh.tables.length, 1);
  assert.equal(sh.tables[0].name, 'FromJson');
  // query over a range of the sheet itself, loaded elsewhere
  const q2 = { id: 'r', name: 'Again', source: { type: 'range', ref: 'FromJson' }, steps: [{ op: 'filter', col: 'v', test: '=', value: '3' }], dest: { sheet: 'Sheet1', r: 10, c: 0 } };
  wb.tx(() => loadQuery(wb, q2));
  assert.deepEqual([sh.get(10, 0), sh.get(11, 0)], ['n', 'c']);
  // change the source steps and refresh: old output is cleared
  query.steps = [{ op: 'filter', col: 'v', test: '=', value: '2' }];
  wb.tx(() => loadQuery(wb, query));
  assert.equal(sh.get(3, 1), 'b'); assert.equal(sh.get(4, 1), null);
  assert.equal(sh.tables.find((t) => t.queryId === 'j').r2, 3);
});

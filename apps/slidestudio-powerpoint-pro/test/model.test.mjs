import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, runsMd, parseOutline, toOutline, slideMd, reconcile, normalizeMd, plain, binding, removeKey, paraMd, P } from '../src/model.js';
import { extractDataUrls, imgSize, fromDataUrl } from '../src/media.js';
import { png, gif, jpeg, dataUrl } from './fixtures.mjs';

const PNG = dataUrl(png(2, 1), 'image/png');

test('inline markdown: bold, italic, strike, underline, line break, escapes', () => {
  assert.deepEqual(parseInline('a **b** *c* ~~d~~ <u>e</u>'), [{ t: 'a ' }, { t: 'b', b: 1 }, { t: ' ' }, { t: 'c', i: 1 }, { t: ' ' }, { t: 'd', s: 1 }, { t: ' ' }, { t: 'e', u: 1 }]);
  assert.deepEqual(parseInline('x<br>y'), [{ t: 'x\ny' }]);
  assert.deepEqual(parseInline('5 * 3 = 15'), [{ t: '5 * 3 = 15' }], 'unmatched * is literal');
  assert.deepEqual(parseInline('\\*not italic\\*'), [{ t: '*not italic*' }]);
  assert.deepEqual(parseInline('***both***'), [{ t: 'both', b: 1, i: 1 }]);
});

test('runs -> markdown -> runs is lossless, including adjacent italic/bold runs', () => {
  const cases = [
    [{ t: 'a', i: 1 }, { t: 'b', b: 1 }],
    [{ t: 'x', b: 1, i: 1 }, { t: ' y' }, { t: 'z', s: 1, u: 1 }],
    [{ t: 'pipe | star * tilde ~ back \\ lt <' }],
    [{ t: 'two\nlines', b: 1 }],
  ];
  for (const runs of cases) assert.deepEqual(parseInline(runsMd(runs)), runs, runsMd(runs));
});

test('outline parses titles, subtitles, bullets with levels, numbers, plain text and notes', () => {
  const [s1, s2] = parseOutline('# Welcome\n## A subtitle\n:: say hello\n:: then smile\n\n# Agenda\n- One\n  - One a\n    - deep\n1. First\nplain line\n');
  assert.equal(plain(s1.title), 'Welcome');
  assert.equal(plain(s1.sub[0]), 'A subtitle');
  assert.equal(s1.notes, 'say hello\nthen smile');
  assert.deepEqual(s2.body.map((p) => [plain(p), p.lvl, p.bu]), [['One', 0, 1], ['One a', 1, 1], ['deep', 2, 1], ['First', 0, 'n'], ['plain line', 0, 0]]);
});

test('outline parses images, tables, quotes, columns and fenced diagrams', () => {
  const [a, b, c, d] = parseOutline('# Pic\n![A cat](media:m1)\n- caption\n# Table\n| Name | Qty |\n|---|---|\n| Tea | 3 |\n# Q\n> Simplicity is the ultimate sophistication.\n> — Leonardo\n# Cols\n### Pros\n- fast\n### Cons\n- new\n```flow\nA -> B\n```');
  assert.deepEqual(a.img, [{ src: 'media:m1', alt: 'A cat' }]);
  assert.equal(a.body.length, 1);
  assert.deepEqual(b.table.map((r) => r.map(plain)), [['Name', 'Qty'], ['Tea', '3']]);
  assert.equal(plain(c.quote.q[0]), 'Simplicity is the ultimate sophistication.');
  assert.equal(c.quote.by, 'Leonardo');
  assert.deepEqual(d.cols.map((x) => plain(x.h)), ['Pros', 'Cons']);
  assert.deepEqual(d.dg, { k: 'flow', src: 'A -> B' });
});

test('slides -> outline -> slides is stable (idempotent round trip)', () => {
  const src = '# Title **bold**\n## Sub\n- a\n  - b\n1. n\n\\- not a bullet\n### Left\n- l\n### Right\n- r\n![alt](media:x)\n| a | b |\n| --- | --- |\n| c | d |\n> q\n> — who\n```org\nCEO\n  CTO\n```\n:: note\n\n---\nuntitled body\n';
  const once = toOutline({ slides: parseOutline(src) });
  const twice = toOutline({ slides: parseOutline(once) });
  assert.equal(twice, once);
  const s = parseOutline(once);
  assert.equal(s.length, 2);
  assert.equal(s[1].title, null);
  assert.equal(plain(s[0].body[3]), '- not a bullet');
  assert.equal(s[0].body[3].bu, 0);
  assert.equal(paraMd(P('# hash')), '\\# hash');
});

test('lines made of arrows become a flowchart automatically', () => {
  const [s] = parseOutline('# Process\n- Idea -> Build\n- Build -> Ship');
  assert.equal(s.dg.k, 'flow');
  assert.equal(s.body.length, 0);
});

test('reconcile keeps ids, layout, overrides and rich formatting when the outline changes', () => {
  const old = parseOutline('# A\n- x\n# B\n- y\n# C\n- z');
  old[1].layout = 'quote'; old[1].ov = { body: { x: 10, y: 10, w: 100, h: 50 } }; old[1].els = [{ id: 'e1', t: 'shape', g: 'rect', x: 0, y: 0, w: 5, h: 5 }];
  old[2].body[0].r[0].c = '#ff0000';
  const ids = old.map((s) => s.id);
  // insert a slide in the middle, edit B's title, keep C's line unchanged
  const nw = reconcile(old, parseOutline('# A\n- x\n# New\n- n\n# B renamed\n- y\n# C\n- z'));
  assert.equal(nw.length, 4);
  assert.equal(nw[0].id, ids[0]);
  assert.equal(nw[3].id, ids[2]);
  assert.equal(nw[3].body[0].r[0].c, '#ff0000', 'formatting kept for unchanged line');
  const b = nw.find((s) => plain(s.title) === 'B renamed');
  assert.ok(b.id === ids[1] || nw[1].id === ids[1]);
  const moved = nw.find((s) => s.id === ids[1]);
  assert.equal(moved.layout, 'quote');
  assert.equal(moved.els.length, 1);
});

test('normalizeMd turns pasted documents into decks', () => {
  assert.match(normalizeMd('## One\ntext\n## Two\n### sub'), /^# One\ntext\n# Two\n## sub$/);
  const plainDeck = parseOutline(normalizeMd('Quarterly review\nRevenue up\nCosts down\n\nNext steps\n- hire\n- ship'));
  assert.equal(plainDeck.length, 2);
  assert.equal(plain(plainDeck[0].title), 'Quarterly review');
  assert.equal(plainDeck[0].body.length, 2);
});

test('bindings edit the right slide field and removeKey deletes content', () => {
  const [s] = parseOutline('# T\n- a\n- b\n> q\n> — me\n![x](media:1)');
  binding(s, 'title').set([P('New'), P('line')]);
  assert.equal(plain(s.title), 'New\nline');
  binding(s, 'by').set([P('you')]);
  assert.equal(s.quote.by, 'you');
  removeKey(s, 'img0');
  assert.equal(s.img.length, 0);
  removeKey(s, 'deco');
  assert.equal(s.ov.deco.hide, 1);
});

test('media: data URLs move into the media table; image sizes are read from headers', () => {
  const deck = { media: {} };
  const out = extractDataUrls(`# P\n![dot](${PNG})`, deck);
  assert.match(out, /^# P\n!\[dot\]\(media:m\w+\)$/);
  const id = Object.keys(deck.media)[0];
  assert.deepEqual([deck.media[id].w, deck.media[id].h], [2, 1]);
  assert.deepEqual(imgSize(fromDataUrl(PNG).bytes), [2, 1]);
  assert.deepEqual(imgSize(gif(5, 7)), [5, 7]);
  assert.deepEqual(imgSize(jpeg(640, 480)), [640, 480]);
});

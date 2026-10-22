import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline, newDeck, P } from '../src/model.js';
import { layoutSlide, autoLayout, fit, approx, textH, BODY } from '../src/layout.js';
import { derive, THEMES, MODES, FONTS } from '../src/theme.js';
import { contrast, ensure, hsl } from '../src/color.js';
import { parseGraph, diagram } from '../src/diagram.js';
import { checkSlide, checkDeck, applyFix } from '../src/checks.js';

const deckOf = (md) => { const d = newDeck(); d.slides = parseOutline(md); return d; };
const box = (L, k) => L.boxes.find((b) => b.k === k);
const inside = (b, d) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= d.w + 0.5 && b.y + b.h <= d.h + 0.5;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('auto-layout picks a layout from content', () => {
  const d = deckOf('# Deck\n## by me\n# Section\n# Bullets\n- a\n# Cols\n### A\n- x\n### B\n- y\n# Pic\n![](media:x)\n# PicText\n![](media:x)\n- t\n# Tbl\n| a |\n# Q\n> wise\n# Num\n42%\nof users\n# Flow\n```flow\nA -> B\n```');
  assert.deepEqual(d.slides.map((s, i) => autoLayout(s, i)), ['title', 'section', 'bullets', 'columns', 'image', 'imageText', 'table', 'quote', 'bignum', 'diagram']);
});

test('every layout keeps boxes on the slide and the title clear of the content', () => {
  const d = deckOf('# T\n## s\n# S\n# B\n- a\n- b\n# C\n### A\n- x\n### B\n- y\n### C\n- z\n# I\n![](media:x)\n- t\n# Tb\n| a | b |\n| c | d |\n# Q\n> wise words\n> — me\n# N\n3x\nfaster\n# D\n```org\nA\n  B\n  C\n```');
  for (const lay of ['auto', 'bullets', 'imageLeft', 'free']) {
    d.slides.forEach((s, i) => {
      s.layout = lay;
      const L = layoutSlide(s, d, i);
      const t = box(L, 'title');
      for (const b of L.boxes) {
        assert.ok(inside(b, d), `${lay}/${i}: ${b.k} inside slide`);
        if (t && b !== t && !b.d && b.k !== 'sub') assert.ok(!overlap(t, b) || b.k === 'qm', `${lay}/${i}: title overlaps ${b.k}`);
      }
    });
  }
});

test('auto-fit: short text keeps full size, long text shrinks, extreme text is flagged as overflow', () => {
  const b = { w: 800, h: 300, base: BODY, font: 'Segoe UI', paras: [P('Short', { bu: 1 })] };
  assert.equal(fit(b, approx).fs, 1);
  b.paras = Array.from({ length: 14 }, (_, i) => P(`Point number ${i} with a reasonably long sentence that wraps`, { bu: 1 }));
  const f = fit(b, approx);
  assert.ok(f.fs < 1 && f.fs >= 0.3 && !f.over);
  assert.ok(textH(b, f.fs, approx) <= b.h + 0.5);
  b.paras = Array.from({ length: 200 }, () => P('overflowing text that goes on and on', { bu: 1 }));
  assert.equal(fit(b, approx).over, true);
});

test('content re-flows: more bullets -> smaller text; a moved box keeps its position and refits', () => {
  const d = deckOf('# T\n- one');
  const s = d.slides[0];
  const fs1 = box(layoutSlide(s, d, 1), 'body').fs;
  s.body = Array.from({ length: 16 }, (_, i) => P('A longer bullet point that will need to wrap ' + i, { bu: 1 }));
  const fs2 = box(layoutSlide(s, d, 1), 'body').fs;
  assert.ok(fs2 < fs1);
  s.ov.body = { x: 500, y: 300, w: 400, h: 200 };
  const b = box(layoutSlide(s, d, 1), 'body');
  assert.deepEqual([b.x, b.y, b.w, b.h], [500, 300, 400, 200]);
  assert.ok(b.fs < fs2, 'smaller box -> smaller text');
});

test('pictures keep their aspect ratio; tables shrink text to fit many rows', () => {
  const d = deckOf('# P\n![](media:m1)');
  d.media.m1 = { d: '', w: 400, h: 100 };
  const p = box(layoutSlide(d.slides[0], d, 1), 'img0');
  assert.ok(Math.abs(p.w / p.h - 4) < 0.01);
  const t = deckOf('# T\n' + Array.from({ length: 14 }, (_, i) => `| row ${i} | value ${i} |`).join('\n'));
  const tb = box(layoutSlide(t.slides[0], t, 1), 'tbl');
  assert.ok(tb.z < 20 && tb.h <= t.h * 0.7 + 1);
  assert.equal(tb.cw.length, 2);
});

test('4:3 decks scale the same regions', () => {
  const d = deckOf('# T\n- a');
  d.w = 720;
  const b = box(layoutSlide(d.slides[0], d, 1), 'body');
  assert.ok(Math.abs(b.w - 0.88 * 720) < 0.01);
});

test('theme derivation: built-in themes meet WCAG contrast', () => {
  for (const t of THEMES) {
    const th = derive(t);
    assert.ok(contrast(th.text, th.bg) >= 7, t.name + ' text');
    assert.ok(contrast(th.title, th.bg) >= 4.5, t.name + ' title');
    assert.ok(contrast(th.muted, th.bg) >= 4.5, t.name + ' muted');
    th.acc.forEach((a, i) => { assert.ok(contrast(a, th.bg) >= 3, t.name + ' accent'); assert.ok(contrast(th.onAcc[i], a) >= 3); });
    th.fills.forEach((f, i) => assert.ok(contrast(th.onFill[i], f) >= 4.5, t.name + ' text on shape fill'));
  }
});

test('theme derivation: any brand colour in any mode stays accessible', () => {
  const brands = ['#ffff00', '#ffffff', '#000000', '#00ff00', '#777777', '#0b1d51', '#ff6b6b', '#00a3a3'];
  for (let h = 0; h < 360; h += 45) brands.push(hsl(h, 0.8, 0.55));
  for (const brand of brands) for (const mode of Object.keys(MODES)) for (const font of Object.keys(FONTS).slice(0, 2)) {
    const th = derive({ brand, mode, font });
    assert.ok(contrast(th.text, th.bg) >= 7 && contrast(th.title, th.bg) >= 4.5 && th.acc.every((a) => contrast(a, th.bg) >= 3), `${brand} ${mode}`);
  }
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.ok(contrast(ensure('#aaaaaa', '#ffffff', 4.5), '#ffffff') >= 4.5);
});

test('changing the theme restyles every slide without touching content', () => {
  const d = deckOf('# A\n- x\n# B\n- y');
  const before = layoutSlide(d.slides[1], d, 1);
  d.theme = { ...THEMES[4] };
  const after = layoutSlide(d.slides[1], d, 1);
  assert.notEqual(before.bg, after.bg);
  assert.notEqual(box(before, 'title').col, box(after, 'title').col);
  assert.equal(box(after, 'title').font, derive(THEMES[4]).head);
});

test('diagram text: arrows, reverse arrows, both-way and plain links', () => {
  const g = parseGraph('flow', 'Start -> Check? -> Done\nCheck? <- Retry\nA <-> B\nB -- C');
  assert.deepEqual(g.nodes.map((n) => n.label), ['Start', 'Check?', 'Done', 'Retry', 'A', 'B', 'C']);
  assert.equal(g.nodes[1].g, 'diamond');
  assert.deepEqual(g.edges.map((e) => [e.a, e.b, e.te || 0, e.he || 0]), [[0, 1, 1, 0], [1, 2, 1, 0], [3, 1, 1, 0], [4, 5, 1, 1], [5, 6, 0, 0]]);
});

test('flowchart lays out left to right with connectors from right side to left side', () => {
  const th = derive(THEMES[0]), r = { x: 50, y: 100, w: 860, h: 400 };
  const out = diagram({ k: 'flow', src: 'Idea -> Plan -> Build\nPlan -> Test' }, r, th);
  const n = (l) => out.find((b) => b.k === 'dg:' + l);
  assert.ok(n('Idea').x < n('Plan').x && n('Plan').x < n('Build').x && Math.abs(n('Build').x - n('Test').x) < 1);
  const e = out.find((b) => b.k === 'dge:0');
  assert.equal(e.t, 'line');
  assert.ok(Math.abs(e.x - (n('Idea').x + n('Idea').w)) < 0.01);
  assert.deepEqual(e.st, ['dg:Idea', 3]);
  for (const b of out) assert.ok(b.x >= r.x - 1 && b.x + b.w <= r.x + r.w + 1 && b.y >= r.y - 1 && b.y + b.h <= r.y + r.h + 1, b.k);
});

test('org chart centres parents over children and uses elbow connectors', () => {
  const th = derive(THEMES[0]), r = { x: 0, y: 0, w: 900, h: 400 };
  const out = diagram({ k: 'org', src: 'CEO\n  CTO\n    Dev\n    QA\n  CFO' }, r, th);
  const n = (l) => out.find((b) => b.k === 'dg:' + l), cx = (b) => b.x + b.w / 2;
  assert.ok(Math.abs(cx(n('CTO')) - (cx(n('Dev')) + cx(n('QA'))) / 2) < 0.01);
  assert.ok(n('CEO').y < n('CTO').y && n('CTO').y < n('Dev').y);
  const e = out.filter((b) => b.t === 'line');
  assert.equal(e.length, 4);
  assert.ok(e.every((x) => x.g === 'elbow' && x.rot === 90));
});

test('timeline, cycle and bar diagrams produce native shapes', () => {
  const th = derive(THEMES[0]), r = { x: 0, y: 0, w: 900, h: 400 };
  const tl = diagram({ k: 'timeline', src: '2019: Founded\n2021: Series A\n2024: IPO' }, r, th);
  assert.equal(tl.filter((b) => b.g === 'ellipse').length, 3);
  const cy = diagram({ k: 'cycle', src: 'Plan\nDo\nCheck\nAct' }, r, th);
  assert.equal(cy.filter((b) => b.t === 'line').length, 4);
  const bar = diagram({ k: 'bar', src: 'North: 40\nSouth: 20' }, r, th);
  const [a, b] = bar.filter((x) => x.g === 'rect');
  assert.ok(Math.abs(a.h - 2 * b.h) < 0.5);
});

test('checks find low contrast, overflow, missing alt and titles; fixes resolve them', () => {
  const d = deckOf('# Fine\n- ok\n---\n- no title\n# Pic\n![](media:x)\n# Long\n' + Array.from({ length: 60 }, (_, i) => `- point ${i} goes on for quite a while to make it wrap`).join('\n'));
  d.slides[0].bg = '#ffffff';
  d.slides[0].body[0].r[0].c = '#dddddd';
  const iss = checkDeck(d, approx);
  const types = iss.map((x) => `${x.i}:${x.type}`);
  for (const t of ['0:contrast', '1:title', '2:alt', '3:overflow']) assert.ok(types.includes(t), t + ' in ' + types);
  for (const x of iss.filter((y) => y.fix && y.fix !== 'alt')) applyFix(d, x, approx);
  assert.ok(checkSlide(d, d.slides[0], 0, approx).every((x) => x.type !== 'contrast'));
  assert.ok(d.slides[1].title);
  assert.equal(d.slides.length, 5, 'long slide was split');
  assert.match(d.slides[4].title.r[0].t, /cont/);
});

test('checks: off-slide objects move back, reading order puts the title first', () => {
  const d = deckOf('# T\n- a');
  const s = d.slides[0];
  s.els = [{ id: 'x1', t: 'text', x: 10, y: 10, w: 200, h: 40, paras: [P('Footer')] }, { slot: 'title' }, { id: 'x2', t: 'text', x: 900, y: 500, w: 200, h: 30, paras: [P('Cut off')] }];
  const iss = checkSlide(d, s, 0, approx);
  assert.ok(iss.some((x) => x.type === 'order') && iss.some((x) => x.type === 'offslide'));
  iss.forEach((x) => applyFix(d, x, approx));
  assert.deepEqual(s.els.map((e) => e.id || e.slot), ['title', 'x1', 'x2'].filter((k) => s.els.some((e) => (e.id || e.slot) === k)));
  assert.equal(layoutSlide(s, d, 0, approx).boxes.find((b) => !b.d && b.paras).k, 'title');
  assert.ok(s.els.at(-1).x + s.els.at(-1).w <= d.w);
  assert.deepEqual(checkSlide(d, s, 0, approx).map((x) => x.type), []);
});

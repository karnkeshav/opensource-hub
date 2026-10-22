import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline, newDeck, plain, P, toOutline } from '../src/model.js';
import { addMedia } from '../src/media.js';
import { writePptx } from '../src/pptx-write.js';
import { readPptx } from '../src/pptx-read.js';
import { zip, unzip, text } from '../src/zip.js';
import { parseXML, findAll } from '../src/xml.js';
import { png, gif, jpeg } from './fixtures.mjs';

import { validate } from './validate.mjs';

function richDeck() {
  const d = newDeck();
  d.slides = parseOutline([
    '# Quarterly **review**', '## Prepared by the team', ':: Welcome everyone', ':: Keep it short',
    '# Highlights', '- Revenue *up* 12%', '  - EMEA ~~flat~~ <u>growing</u>', '1. First', '1. Second',
    '# Picture', '![A red square](media:PNG)', '- With a caption',
    '# Numbers', '| Region | Sales |', '|---|---|', '| North | 40 |', '| South | 20 |',
    '# Process', '```flow', 'Idea -> Plan -> Ship', '```',
    '# Team', '```org', 'Lead', '  Dev', '  Design', '```',
  ].join('\n'));
  const pid = addMedia(d, png(40, 20), 'red.png'), gid = addMedia(d, gif(10, 10)), jid = addMedia(d, jpeg(64, 48));
  d.slides[2].img[0].src = 'media:' + pid;
  d.slides[1].body[0].r[1].c = '#c00000';
  d.slides[1].tr = 'fade';
  d.slides[3].hidden = true;
  d.slides[2].bg = '#fff8e1';
  d.slides[4].bg = { m: 'media:' + jid };
  d.slides[1].els = [
    { id: 'r1', t: 'shape', g: 'rect', x: 600, y: 300, w: 100, h: 60, fill: '#228be6', ln: { c: '#1864ab', w: 2 }, paras: [P('Box', { al: 'ctr' })], an: 'ctr' },
    { id: 'r2', t: 'shape', g: 'ellipse', x: 720, y: 300, w: 80, h: 80, fill: '#40c05780' },
    { id: 'r3', t: 'shape', g: 'roundRect', x: 820, y: 300, w: 100, h: 50, fill: '#fab005' },
    { id: 'r4', t: 'shape', g: 'rightArrow', x: 600, y: 400, w: 120, h: 40, fill: '#e03131' },
    { id: 'l1', t: 'line', g: 'line', x: 600, y: 470, w: 200, h: 0, ln: { c: '#000000', w: 1.5, te: 'triangle', d: 'dash' } },
    { id: 'p1', t: 'pic', x: 760, y: 420, w: 60, h: 60, m: 'media:' + gid, alt: 'A gif', crop: [0.1, 0, 0.1, 0] },
    { id: 't1', t: 'text', x: 40, y: 480, w: 300, h: 40, paras: [P('Free text box')] },
    { id: 'c1', t: 'shape', g: 'rect', x: 10, y: 10, w: 50, h: 50, fill: '#123456', path: [{ w: 100, h: 100, d: [['M', 0, 0], ['L', 100, 0], ['C', 100, 50, 50, 100, 0, 100], ['Z']] }] },
  ];
  return d;
}

test('pptx write produces a structurally valid package (well-formed, schema order, rels, content types, ids)', async () => {
  const { data, warnings } = await writePptx(richDeck(), { title: 'Test & <deck>' });
  assert.deepEqual(warnings, []);
  const { parts } = await validate(data);
  assert.match(parts['docProps/core.xml'], /Test &amp; &lt;deck&gt;/);
  assert.match(parts['ppt/slides/slide1.xml'], /<p:ph type="ctrTitle"\/>/);
  assert.match(parts['ppt/slides/slide2.xml'], /<p:ph idx="1"\/>/);
  assert.match(parts['ppt/slides/slide5.xml'], /<a:stCxn id="\d+" idx="3"\/><a:endCxn id="\d+" idx="1"\/>/);
  assert.match(parts['ppt/slides/slide6.xml'], /prst="bentConnector3"/);
});

test('pptx round trip: titles, subtitles, bullets, levels, numbering and run formatting', async () => {
  const d = richDeck();
  const { deck } = await readPptx((await writePptx(d)).data);
  assert.equal(deck.slides.length, 6);
  assert.deepEqual(deck.slides.map((s) => plain(s.title)), ['Quarterly review', 'Highlights', 'Picture', 'Numbers', 'Process', 'Team']);
  assert.equal(plain(deck.slides[0].sub[0]), 'Prepared by the team');
  const t = deck.slides[0].title.r;
  assert.ok(t.find((r) => r.t === 'review').b && !t.find((r) => r.t.startsWith('Quarterly')).b);
  const b = deck.slides[1].body;
  assert.deepEqual(b.map((p) => [plain(p), p.lvl, p.bu]), [['Revenue up 12%', 0, 1], ['EMEA flat growing', 1, 1], ['First', 0, 'n'], ['Second', 0, 'n']]);
  const up = b[0].r.find((r) => r.t === 'up');
  assert.equal(up.i, 1);
  assert.equal(up.c, '#c00000');
  assert.ok(b[1].r.find((r) => r.t === 'flat').s && b[1].r.find((r) => r.t === 'growing').u);
  assert.ok(up.z >= 10 && up.z <= 28);
  assert.equal(deck.theme.brand, d.slides.length && '#1c7ed6');
  // the outline of the imported deck is usable
  assert.match(toOutline(deck), /^# Quarterly \*\*review\*\*$/m);
});

test('pptx round trip: shapes, lines, connectors, custom geometry, alpha fills', async () => {
  const { deck } = await readPptx((await writePptx(richDeck())).data);
  const els = deck.slides[1].els.filter((e) => !e.slot);
  const byG = (g) => els.filter((e) => e.g === g);
  assert.equal(byG('ellipse')[0].fill, '#40c05780');
  assert.equal(byG('roundRect').length, 1);
  assert.equal(byG('rightArrow')[0].fill, '#e03131');
  const box = els.find((e) => e.paras && plain(e.paras[0]) === 'Box');
  assert.deepEqual([box.g, box.fill, box.ln.c, box.ln.w, Math.round(box.x), Math.round(box.w)], ['rect', '#228be6', '#1864ab', 2, 600, 100]);
  const line = els.find((e) => e.t === 'line');
  assert.deepEqual([line.ln.te, line.ln.d, line.w], ['triangle', 'dash', 200]);
  assert.equal(els.find((e) => e.path).path[0].d.length, 4);
  assert.ok(els.find((e) => e.t === 'text' && plain(e.paras[0]) === 'Free text box'));
  const flow = deck.slides[4].els.filter((e) => !e.slot);
  assert.equal(flow.filter((e) => e.t === 'line').length, 2);
  assert.deepEqual(flow.filter((e) => e.paras).map((e) => plain(e.paras[0])), ['Idea', 'Plan', 'Ship']);
  const org = deck.slides[5].els.filter((e) => e.t === 'line');
  assert.ok(org.every((e) => e.g === 'elbow' && Math.round(e.rot) === 90));
});

test('pptx round trip: pictures (png/gif/jpeg), alt text, crop, tables, notes, backgrounds, hidden, transitions', async () => {
  const { deck } = await readPptx((await writePptx(richDeck())).data);
  const pics = deck.slides.flatMap((s) => s.els.filter((e) => e.t === 'pic'));
  assert.equal(pics.length, 2);
  assert.equal(pics.find((p) => p.alt === 'A red square').w > 0, true);
  const g = pics.find((p) => p.alt === 'A gif');
  assert.deepEqual(g.crop, [0.1, 0, 0.1, 0]);
  const md = deck.media[g.m.slice(6)];
  assert.match(md.d, /^data:image\/gif;base64,/);
  const tbl = deck.slides[3].els.find((e) => e.t === 'table');
  assert.deepEqual(tbl.rows.map((r) => r.map(plain)), [['Region', 'Sales'], ['North', '40'], ['South', '20']]);
  assert.equal(deck.slides[0].notes, 'Welcome everyone\nKeep it short');
  assert.equal(deck.slides[2].bg, '#fff8e1');
  assert.match(deck.media[deck.slides[4].bg.m.slice(6)].d, /^data:image\/jpeg/);
  assert.deepEqual(deck.slides.map((s) => !!s.hidden), [false, false, false, true, false, false]);
  assert.equal(deck.slides[1].tr, 'fade');
  // and the re-read deck writes again cleanly
  await validate((await writePptx(deck)).data);
});

test('reader inherits placeholder geometry and text styles from layout and master', async () => {
  const d = newDeck();
  d.slides = parseOutline('# Only title\n- body');
  const z = unzip((await writePptx(d)).data), files = {};
  for (const [k, f] of Object.entries(z)) files[k] = await f();
  // a slide whose placeholders carry no position or size: they must come from the layout -> master
  files['ppt/slides/slide1.xml'] = new TextEncoder().encode(text(files['ppt/slides/slide1.xml']).replace(/<p:spPr><a:xfrm><a:off x="\d+" y="\d+"\/><a:ext cx="\d+" cy="\d+"\/><\/a:xfrm>/g, '<p:spPr>').replace(/ sz="\d+"/g, ''));
  const { deck } = await readPptx(await zip(files));
  const s = deck.slides[0];
  assert.equal(Math.round(s.ov.title.x), Math.round(0.06 * 960));
  assert.equal(Math.round(s.ov.body.y), Math.round(0.24 * 540));
  assert.equal(s.title.r[0].z, 40, 'title size from master titleStyle');
  assert.equal(s.body[0].r[0].z, 28, 'body size from master bodyStyle level 1');
  assert.equal(s.body[0].bu, 1, 'bullet from master bodyStyle');
});

test('reader degrades gracefully and reports charts, SmartArt, OLE, video, animations, gradients, groups and arcs', async () => {
  const d = newDeck();
  d.slides = parseOutline('# Things we cannot keep\n- text survives');
  const z = unzip((await writePptx(d)).data), files = {};
  for (const [k, f] of Object.entries(z)) files[k] = await f();
  const frame = (id, uri) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="x"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"/></a:graphic></p:graphicFrame>`;
  const extra = frame(20, 'http://schemas.openxmlformats.org/drawingml/2006/chart') + frame(21, 'http://schemas.openxmlformats.org/drawingml/2006/diagram') + frame(22, 'http://schemas.openxmlformats.org/presentationml/2006/ole')
    + '<p:pic><p:nvPicPr><p:cNvPr id="23" name="v"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId99"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId98"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic>'
    + '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="24" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="25" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm><a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:arcTo wR="5" hR="5" stAng="0" swAng="5400000"/><a:close/></a:path></a:pathLst></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill></p:spPr></p:sp></p:grpSp>';
  files['ppt/slides/slide1.xml'] = new TextEncoder().encode(text(files['ppt/slides/slide1.xml']).replace('</p:spTree>', extra + '</p:spTree>').replace('</p:sld>', '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:par><p:cTn id="2"/></p:par></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>'));
  const { deck, warnings } = await readPptx(await zip(files));
  const w = warnings.join('\n');
  for (const k of ['Charts', 'SmartArt', 'OLE', 'Video and audio', 'Animations (on 1 slide)', 'Gradient', 'Groups', 'Arcs']) assert.match(w, new RegExp(k.replace(/[()]/g, '\\$&')), k);
  const s = deck.slides[0];
  assert.equal(plain(s.body[0]), 'text survives');
  assert.equal(s.els.filter((e) => e.paras && /not imported/.test(plain(e.paras[0]))).length, 3, 'labelled placeholders mark dropped objects');
  const g = s.els.find((e) => e.path);
  assert.deepEqual([g.x, g.y, g.w, g.h], [100 + 20, 100, 20, 20], 'group child mapped through the group transform');
  assert.equal(g.fill, '#800080');
});

test('zip and xml helpers', async () => {
  const big = 'slide '.repeat(400);
  const u = unzip(await zip({ 'a.txt': 'x', 'b/c.xml': big }));
  assert.equal(text(await u['b/c.xml']()), big);
  const r = parseXML('<p:sldId id="256" r:id="rId2"/>').c[0];
  assert.deepEqual([r.a.id, r.a['r:id']], ['256', 'rId2']);
});

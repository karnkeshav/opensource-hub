// PresentationML writer: one master, five layouts, theme, slides (text, shapes, connectors, pictures,
// tables, backgrounds, transitions) and notes. Element order follows the ECMA-376 schema.
import { zip } from './zip.js';
import { esc } from './xml.js';
import { derive } from './theme.js';
import { layoutSlide, runZ, paraZ, marL, ins, HANG, SB, BODY, approx } from './layout.js';
import { fromDataUrl } from './media.js';
import { P } from './model.js';

const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT = 'application/vnd.openxmlformats-officedocument.';
const PML = CT + 'presentationml.';
const E = (v) => Math.round((+v || 0) * 12700);
const BUL = ['•', '–', '◦'];
const CONN = { elbow: 'bentConnector3', curve: 'curvedConnector3' };
const rels = (list) => X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${RT + type}" Target="${esc(target)}"/>`).join('') + '</Relationships>';

export const srgb = (c) => {
  const h = String(c).replace('#', ''), a = h.length === 8 ? Math.round((parseInt(h.slice(6), 16) / 255) * 100000) : -1;
  return `<a:srgbClr val="${h.slice(0, 6).toUpperCase()}"${a >= 0 ? `><a:alpha val="${a}"/></a:srgbClr>` : '/>'}`;
};
const fillX = (c) => (c ? `<a:solidFill>${srgb(c)}</a:solidFill>` : '<a:noFill/>');
const lnX = (l) => (!l || !l.c ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${E(l.w || 1)}">${fillX(l.c)}${l.d ? `<a:prstDash val="${l.d}"/>` : ''}${l.he ? `<a:headEnd type="${l.he === 1 ? 'triangle' : l.he}"/>` : ''}${l.te ? `<a:tailEnd type="${l.te === 1 ? 'triangle' : l.te}"/>` : ''}</a:ln>`);
const xfrmX = (b, tag = 'a:xfrm') => `<${tag}${b.rot ? ` rot="${Math.round(b.rot * 60000)}"` : ''}${b.fh ? ' flipH="1"' : ''}${b.fv ? ' flipV="1"' : ''}><a:off x="${E(b.x)}" y="${E(b.y)}"/><a:ext cx="${E(Math.max(0, b.w))}" cy="${E(Math.max(0, b.h))}"/></${tag}>`;
function geomX(b) {
  if (b.path && b.path.length) {
    const pt = (x, y) => `<a:pt x="${Math.round(x)}" y="${Math.round(y)}"/>`;
    const one = (p) => `<a:path w="${Math.round(p.w)}" h="${Math.round(p.h)}"${p.nf ? ' fill="none"' : ''}>` + p.d.map((c) => {
      if (c[0] === 'M') return `<a:moveTo>${pt(c[1], c[2])}</a:moveTo>`;
      if (c[0] === 'L') return `<a:lnTo>${pt(c[1], c[2])}</a:lnTo>`;
      if (c[0] === 'Q') return `<a:quadBezTo>${pt(c[1], c[2])}${pt(c[3], c[4])}</a:quadBezTo>`;
      if (c[0] === 'C') return `<a:cubicBezTo>${pt(c[1], c[2])}${pt(c[3], c[4])}${pt(c[5], c[6])}</a:cubicBezTo>`;
      return '<a:close/>';
    }).join('') + '</a:path>';
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>${b.path.map(one).join('')}</a:pathLst></a:custGeom>`;
  }
  return `<a:prstGeom prst="${CONN[b.g] || b.g || 'rect'}"><a:avLst/></a:prstGeom>`;
}
function rPr(r, p, b, tag = 'a:rPr') {
  const z = Math.max(1, Math.round(runZ(r, p, b) * (b.fs || 1) * 100));
  return `<${tag} lang="en-US" sz="${z}"${r.b || b.b ? ' b="1"' : ''}${r.i || b.i ? ' i="1"' : ''}${r.u ? ' u="sng"' : ''}${r.s ? ' strike="sngStrike"' : ''} dirty="0">${fillX(r.c || b.col || '#000000')}<a:latin typeface="${esc(r.f || b.font || 'Calibri')}"/></${tag}>`;
}
export function parasX(paras, b) {
  return (paras && paras.length ? paras : [P()]).map((p, i) => {
    const z = paraZ(p, b) * (b.fs || 1), al = p.al || b.al;
    const bu = p.bu ? `<a:buClr>${srgb(b.bc || b.col || '#000000')}</a:buClr><a:buFont typeface="Arial"/>` + (p.bu === 'n' ? '<a:buAutoNum type="arabicPeriod"/>' : `<a:buChar char="${esc(p.bc || BUL[(p.lvl || 0) % 3])}"/>`) : '<a:buNone/>';
    const pPr = `<a:pPr marL="${E(marL(p))}" indent="${p.bu ? -E(HANG) : 0}"${p.lvl ? ` lvl="${Math.min(8, p.lvl)}"` : ''}${al ? ` algn="${al}"` : ''}><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${i ? Math.round(z * SB * 100) : 0}"/></a:spcBef>${bu}</a:pPr>`;
    const runs = p.r.map((r) => r.t.split('\n').map((t, j) => (j ? `<a:br>${rPr(r, p, b)}</a:br>` : '') + (t ? `<a:r>${rPr(r, p, b)}<a:t>${esc(t)}</a:t></a:r>` : '')).join('')).join('');
    return `<a:p>${pPr}${runs}${rPr(p.r[p.r.length - 1] || {}, p, b, 'a:endParaRPr')}</a:p>`;
  }).join('');
}
function txBodyX(b, tag = 'p:txBody') {
  const [l, t, r, bt] = ins(b);
  return `<${tag}><a:bodyPr wrap="square" lIns="${E(l)}" tIns="${E(t)}" rIns="${E(r)}" bIns="${E(bt)}" rtlCol="0" anchor="${b.an || 't'}">${b.fit ? '<a:normAutofit/>' : '<a:noAutofit/>'}</a:bodyPr><a:lstStyle/>${parasX(b.paras, b)}</${tag}>`;
}
const spX = (b, id, ph) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${ph ? 'Placeholder' : b.t === 'text' ? 'TextBox' : 'Shape'} ${id}"/><p:cNvSpPr${b.t === 'text' && !ph ? ' txBox="1"' : ''}>${ph ? '<a:spLocks noGrp="1"/>' : ''}</p:cNvSpPr><p:nvPr>${ph || ''}</p:nvPr></p:nvSpPr><p:spPr>${xfrmX(b)}${geomX(b.t === 'text' && !b.path ? { g: 'rect' } : b)}${fillX(b.fill)}${lnX(b.ln)}</p:spPr>${b.paras ? txBodyX(b) : ''}</p:sp>`;
function tableX(b, id) {
  const cell = (p, r, c) => {
    const hdr = r === 0 && b.hdr !== false, fill = (b.cf && b.cf[r] && b.cf[r][c]) || (hdr ? b.hf : r % 2 === 0 ? b.band : null);
    const bx = { base: [b.z || 18], fs: 1, col: hdr ? b.hc : b.col, font: b.font, b: hdr ? 1 : 0 };
    const edge = ['lnL', 'lnR', 'lnT', 'lnB'].map((t) => `<a:${t} w="9525">${fillX(b.lc || '#bfbfbf')}</a:${t}>`).join('');
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${parasX([p || P()], bx)}</a:txBody><a:tcPr marL="${E(7.2)}" marR="${E(7.2)}" marT="${E(3.6)}" marB="${E(3.6)}" anchor="ctr">${edge}${fill ? fillX(fill) : '<a:noFill/>'}</a:tcPr></a:tc>`;
  };
  const nc = b.cw.length;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrmX(b, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${b.cw.map((w) => `<a:gridCol w="${E(w)}"/>`).join('')}</a:tblGrid>${b.rows.map((row, r) => `<a:tr h="${E(b.rh[r] || 20)}">${Array.from({ length: nc }, (_, c) => cell(row[c], r, c)).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

// ---------- fixed parts ----------
const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const phSp = (id, name, ph, r) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${r ? xfrmX(r) : ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
function themeX(th, name) {
  const c = (n, v) => `<a:${n}>${srgb(v)}</a:${n}>`;
  const font = (f) => `<a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const three = (x) => x + x + x;
  return X + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements><a:clrScheme name="${esc(name)}">${c('dk1', th.text)}${c('lt1', th.bg)}${c('dk2', th.title)}${c('lt2', th.surface)}${th.acc.map((a, i) => c('accent' + (i + 1), a)).join('')}${c('hlink', th.acc[0])}${c('folHlink', th.acc[2])}</a:clrScheme><a:fontScheme name="${esc(name)}"><a:majorFont>${font(th.head)}</a:majorFont><a:minorFont>${font(th.body)}</a:minorFont></a:fontScheme><a:fmtScheme name="${esc(name)}"><a:fillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${three('<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst><a:bgFillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
function masterX(th, W, H) {
  const lvl = (i, z, bu) => `<a:lvl${i + 1}pPr marL="${bu ? E(i * 27 + HANG) : 0}" indent="${bu ? -E(HANG) : 0}" algn="l"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${Math.round(z * SB * 100)}"/></a:spcBef>${bu ? `<a:buFont typeface="Arial"/><a:buChar char="${BUL[i % 3]}"/>` : '<a:buNone/>'}<a:defRPr sz="${z * 100}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`;
  return X + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr>${fillX(th.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}${phSp(2, 'Title Placeholder 1', '<p:ph type="title"/>', { x: 0.06 * W, y: 0.05 * H, w: 0.88 * W, h: 0.16 * H })}${phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', { x: 0.06 * W, y: 0.24 * H, w: 0.88 * W, h: 0.7 * H })}</p:spTree></p:cSld>${CLRMAP}<p:sldLayoutIdLst>${[1, 2, 3, 4, 5].map((i) => `<p:sldLayoutId id="${2147483648 + i}" r:id="rId${i}"/>`).join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4000" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${BODY.map((z, i) => lvl(i, z, 1)).join('')}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvl(0, 18, 0)}</p:otherStyle></p:txStyles></p:sldMaster>`;
}
const LAYS = [['title', 'Title Slide'], ['obj', 'Title and Content'], ['secHead', 'Section Header'], ['titleOnly', 'Title Only'], ['blank', 'Blank']];
function layoutX(i, W, H) {
  const R = (a) => ({ x: a[0] * W, y: a[1] * H, w: a[2] * W, h: a[3] * H });
  const sps = [
    [phSp(2, 'Title 1', '<p:ph type="ctrTitle"/>', R([0.08, 0.18, 0.84, 0.32])), phSp(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', R([0.1, 0.55, 0.8, 0.14]))],
    [phSp(2, 'Title 1', '<p:ph type="title"/>'), phSp(3, 'Content Placeholder 2', '<p:ph idx="1"/>')],
    [phSp(2, 'Title 1', '<p:ph type="title"/>', R([0.1, 0.28, 0.8, 0.28])), phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', R([0.1, 0.58, 0.8, 0.12]))],
    [phSp(2, 'Title 1', '<p:ph type="title"/>')],
    [],
  ][i];
  return X + `<p:sldLayout ${NS} type="${LAYS[i][0]}" preserve="1"><p:cSld name="${LAYS[i][1]}"><p:spTree>${GRP}${sps.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}
const notesMasterX = (W, H) => X + `<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${phSp(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg" idx="2"/>', { x: 72, y: 54, w: 396, h: (396 * H) / W })}${phSp(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', { x: 54, y: 340, w: 432, h: 300 })}</p:spTree></p:cSld>${CLRMAP}</p:notesMaster>`;
const notesX = (text) => X + `<p:notes ${NS}><p:cSld><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${text.split('\n').map((l) => `<a:p>${l ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : ''}</a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
const TRANS = { fade: '<p:fade/>', push: '<p:push dir="u"/>', zoom: '<p:zoom/>' };

export async function writePptx(deck, { measure = approx, title = 'Presentation' } = {}) {
  const W = deck.w, H = deck.h, th = derive(deck.theme), files = {}, warn = new Set();
  const types = [], media = new Map(), ext = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };
  const mediaFile = (src) => {
    const id = /^media:/.test(src || '') ? src.slice(6) : null, md = id && deck.media[id];
    if (!md) { warn.add('Linked (not embedded) pictures were left out.'); return null; }
    if (!media.has(id)) {
      const x = fromDataUrl(md.d);
      if (!x || !ext[x.type]) { warn.add('Pictures that are not PNG, JPEG or GIF were left out.'); media.set(id, null); }
      else { const name = `image${media.size + 1}.${ext[x.type]}`; files['ppt/media/' + name] = x.bytes; media.set(id, name); }
    }
    return media.get(id);
  };
  const sldIds = [], presRels = [['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml']];
  deck.slides.forEach((s, i) => {
    const L = layoutSlide(s, deck, i, measure), n = i + 1, srels = [], keyId = new Map();
    const rid = (target, type = 'image') => { const id = 'rId' + (srels.length + 2); srels.push([id, type, target]); return id; };
    const has = (k) => L.boxes.some((b) => b.k === k && !b.hide);
    const lt = L.lay === 'title' && has('title') ? 0 : L.lay === 'section' && has('title') ? 2 : has('body') && has('title') ? 1 : has('title') ? 3 : 4;
    const subK = lt === 2 ? (has('sub') ? 'sub' : 'body') : lt === 0 ? 'sub' : null;
    const phFor = (k) => (k === 'title' && lt < 4 ? `<p:ph type="${lt ? 'title' : 'ctrTitle'}"/>` : k === subK ? `<p:ph type="${lt ? 'body' : 'subTitle'}" idx="1"/>` : k === 'body' && lt === 1 ? '<p:ph idx="1"/>' : '');
    let id = 2;
    L.boxes.forEach((b) => keyId.set(b.k, id++));
    const shapes = L.boxes.map((b) => {
      const sid = keyId.get(b.k);
      if (b.t === 'pic') {
        const f = mediaFile(b.m);
        if (!f) return '';
        const cr = b.crop ? `<a:srcRect l="${Math.round(b.crop[0] * 1e5)}" t="${Math.round(b.crop[1] * 1e5)}" r="${Math.round(b.crop[2] * 1e5)}" b="${Math.round(b.crop[3] * 1e5)}"/>` : '';
        return `<p:pic><p:nvPicPr><p:cNvPr id="${sid}" name="Picture ${sid}" descr="${esc(b.alt || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid('../media/' + f)}"/>${cr}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmX(b)}${geomX(b.path ? b : { g: b.g && b.g !== 'line' ? b.g : 'rect' })}${b.ln ? lnX(b.ln) : ''}</p:spPr></p:pic>`;
      }
      if (b.t === 'table') return tableX(b, sid);
      if (b.t === 'line') {
        const cx = (e, tag) => (e && keyId.has(e[0]) ? `<a:${tag} id="${keyId.get(e[0])}" idx="${e[1]}"/>` : '');
        const g = b.g === 'line' && (b.st || b.en) ? 'straightConnector1' : b.g;
        return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${sid}" name="Connector ${sid}"/><p:cNvCxnSpPr>${cx(b.st, 'stCxn')}${cx(b.en, 'endCxn')}</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrmX(b)}${geomX({ ...b, g })}${lnX(b.ln || { c: '#000000', w: 1 })}</p:spPr></p:cxnSp>`;
      }
      return spX(b, sid, phFor(b.k));
    }).join('');
    const bgm = L.bgm && mediaFile(L.bgm);
    const bg = bgm ? `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rid('../media/' + bgm)}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill>` : fillX(L.bg);
    if (s.notes) { rid(`../notesSlides/notesSlide${n}.xml`, 'notesSlide'); files[`ppt/notesSlides/notesSlide${n}.xml`] = notesX(s.notes); files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]]); types.push([`/ppt/notesSlides/notesSlide${n}.xml`, PML + 'notesSlide+xml']); }
    files[`ppt/slides/slide${n}.xml`] = X + `<p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld><p:bg><p:bgPr>${bg}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${TRANS[s.tr] ? `<p:transition spd="med">${TRANS[s.tr]}</p:transition>` : ''}</p:sld>`;
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels([['rId1', 'slideLayout', `../slideLayouts/slideLayout${lt + 1}.xml`], ...srels]);
    types.push([`/ppt/slides/slide${n}.xml`, PML + 'slide+xml']);
    presRels.push(['rId' + (n + 1), 'slide', `slides/slide${n}.xml`]);
    sldIds.push(`<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`);
  });
  const k = deck.slides.length + 2;
  presRels.push(['rId' + k, 'notesMaster', 'notesMasters/notesMaster1.xml'], ['rId' + (k + 1), 'theme', 'theme/theme1.xml'], ['rId' + (k + 2), 'presProps', 'presProps.xml'], ['rId' + (k + 3), 'viewProps', 'viewProps.xml'], ['rId' + (k + 4), 'tableStyles', 'tableStyles.xml']);
  files['ppt/presentation.xml'] = X + `<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${k}"/></p:notesMasterIdLst>${sldIds.length ? `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>` : ''}<p:sldSz cx="${E(W)}" cy="${E(H)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = rels(presRels);
  files['ppt/slideMasters/slideMaster1.xml'] = masterX(th, W, H);
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = rels([...LAYS.map((_, i) => ['rId' + (i + 1), 'slideLayout', `../slideLayouts/slideLayout${i + 1}.xml`]), ['rId6', 'theme', '../theme/theme1.xml']]);
  LAYS.forEach((_, i) => {
    files[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = layoutX(i, W, H);
    files[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]);
    types.push([`/ppt/slideLayouts/slideLayout${i + 1}.xml`, PML + 'slideLayout+xml']);
  });
  files['ppt/theme/theme1.xml'] = themeX(th, deck.theme.name || 'SlideStudio');
  files['ppt/theme/theme2.xml'] = themeX(th, 'Notes');
  files['ppt/notesMasters/notesMaster1.xml'] = notesMasterX(W, H);
  files['ppt/notesMasters/_rels/notesMaster1.xml.rels'] = rels([['rId1', 'theme', '../theme/theme2.xml']]);
  files['ppt/presProps.xml'] = X + `<p:presentationPr ${NS}/>`;
  files['ppt/viewProps.xml'] = X + `<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`;
  files['ppt/tableStyles.xml'] = X + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files['docProps/core.xml'] = X + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>SlideStudio</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  files['docProps/app.xml'] = X + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SlideStudio PowerPoint Pro</Application><Slides>${deck.slides.length}</Slides></Properties>`;
  files['_rels/.rels'] = rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]).replace(`${RT}metadata/core-properties`, 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties');
  types.push(['/ppt/presentation.xml', PML + 'presentation.main+xml'], ['/ppt/slideMasters/slideMaster1.xml', PML + 'slideMaster+xml'], ['/ppt/notesMasters/notesMaster1.xml', PML + 'notesMaster+xml'],
    ['/ppt/theme/theme1.xml', CT + 'theme+xml'], ['/ppt/theme/theme2.xml', CT + 'theme+xml'], ['/ppt/presProps.xml', PML + 'presProps+xml'], ['/ppt/viewProps.xml', PML + 'viewProps+xml'], ['/ppt/tableStyles.xml', PML + 'tableStyles+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', CT + 'extended-properties+xml']);
  const ordered = { '[Content_Types].xml': X + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>${types.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`, ...files };
  return { data: await zip(ordered), warnings: [...warn] };
}

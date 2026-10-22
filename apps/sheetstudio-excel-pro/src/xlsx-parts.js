// XLSX sheet parts beyond cells: drawings (charts, pictures), comments (notes) and tables. Read and write.
import { esc, kids, kid, find, findAll, textOf } from './xml.js';
import { chartData, PALETTE } from './ui/chart.js';
import { cellName, parseRefText } from './parser.js';
import { tableColumns, ACCENTS } from './tables.js';

const EMU = 9525, DW = 64, DH = 20;
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---- pixel <-> cell geometry (default 64x20 px cells) ----
export const colLeft = (sh, c) => { let x = 0; for (let i = 0; i < c; i++) if (!sh.hiddenCols.has(i)) x += sh.colW.get(i) ?? DW; return x; };
export const rowTop = (sh, r) => { let y = 0; for (let i = 0; i < r; i++) if (!sh.rowHidden(i)) y += sh.rowH.get(i) ?? DH; return y; };
function pxToCell(sh, px, py) {
  let c = 0, x = 0, r = 0, y = 0;
  for (; c < 16383; c++) { const w = sh.hiddenCols.has(c) ? 0 : sh.colW.get(c) ?? DW; if (x + w > px) break; x += w; }
  for (; r < 1048575; r++) { const h = sh.rowHidden(r) ? 0 : sh.rowH.get(r) ?? DH; if (y + h > py) break; y += h; }
  return { col: c, colOff: Math.round((px - x) * EMU), row: r, rowOff: Math.round((py - y) * EMU) };
}
export const resolvePath = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const out = base.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
};

// ---------- chart XML ----------
const strRef = (f, vals) => `<c:strRef><c:f>${esc(f)}</c:f><c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
const numRef = (f, vals) => `<c:numRef><c:f>${esc(f)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache></c:numRef>`;
const solid = (i) => `<a:solidFill><a:srgbClr val="${PALETTE[i % PALETTE.length].slice(1).toUpperCase()}"/></a:solidFill>`;

function chartXML(ch, data) {
  const t = ch.type, pie = t === 'pie' || t === 'doughnut', stacked = !!ch.stacked && (t === 'column' || t === 'bar' || t === 'area');
  const sers = data.series.map((s, i) => {
    const tx = s.nameRef ? `<c:tx>${strRef(s.nameRef, [s.name])}</c:tx>` : '';
    const sp = t === 'line' ? `<c:spPr><a:ln w="28575" cap="rnd">${solid(i)}<a:round/></a:ln></c:spPr>` : t === 'scatter' ? `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solid(i)}</c:spPr></c:marker>` : pie ? '' : `<c:spPr>${solid(i)}</c:spPr>`;
    const inv = t === 'column' || t === 'bar' ? '<c:invertIfNegative val="0"/>' : '';
    if (t === 'scatter') {
      const x = data.catRef ? `<c:xVal>${numRef(data.catRef, data.xs)}</c:xVal>` : '';
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}${x}<c:yVal>${numRef(s.ref, s.vals)}</c:yVal></c:ser>`;
    }
    const cat = data.catRef ? `<c:cat>${strRef(data.catRef, data.cats)}</c:cat>` : '';
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}${inv}${cat}<c:val>${numRef(s.ref, s.vals)}</c:val></c:ser>`;
  });
  const first = pie ? sers.slice(0, 1) : sers, body = first.join('');
  const ax = '<c:axId val="111111111"/><c:axId val="222222222"/>';
  let plot;
  if (t === 'column' || t === 'bar') plot = `<c:barChart><c:barDir val="${t === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${body}<c:gapWidth val="150"/>${stacked ? '<c:overlap val="100"/>' : ''}${ax}</c:barChart>`;
  else if (t === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${body}<c:marker val="1"/>${ax}</c:lineChart>`;
  else if (t === 'area') plot = `<c:areaChart><c:grouping val="${stacked ? 'stacked' : 'standard'}"/><c:varyColors val="0"/>${body}${ax}</c:areaChart>`;
  else if (t === 'pie') plot = `<c:pieChart><c:varyColors val="1"/>${body}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (t === 'doughnut') plot = `<c:doughnutChart><c:varyColors val="1"/>${body}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  else plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${body}${ax}</c:scatterChart>`;
  const common = (id, cross, pos, extra) => `<c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${extra}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>`;
  let axes = '';
  if (t === 'scatter') axes = `<c:valAx>${common(111111111, 222222222, 'b', '')}<c:crossBetween val="midCat"/></c:valAx><c:valAx>${common(222222222, 111111111, 'l', '<c:majorGridlines/>')}<c:crossBetween val="midCat"/></c:valAx>`;
  else if (!pie) axes = `<c:catAx>${common(111111111, 222222222, t === 'bar' ? 'l' : 'b', '')}<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx>${common(222222222, 111111111, t === 'bar' ? 'b' : 'l', '<c:majorGridlines/>')}<c:crossBetween val="between"/></c:valAx>`;
  const title = ch.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` : '';
  const legend = data.series.length > 1 || pie ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="${ch.title ? 0 : 1}"/><c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Write drawings / comments / tables for one sheet. Returns { rels, tail } (worksheet XML tail + its relationships).
export function writeSheetParts(sh, st) {
  const rels = [];
  let tail = '';
  const rel = (type, target) => { const id = 'rId' + (rels.length + 1); rels.push({ id, type: `${NS_R}/${type}`, target }); return id; };
  const files = st.files;

  if (sh.charts.length || sh.images.length) {
    const dn = ++st.n.drawing;
    const drels = [];
    let anchors = '', sid = 2;
    const drel = (type, target) => { const id = 'rId' + (drels.length + 1); drels.push(`<Relationship Id="${id}" Type="${NS_R}/${type}" Target="${target}"/>`); return id; };
    const anchor = (x, y, w, h, inner) => {
      const p = pxToCell(sh, x, y);
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>${p.colOff}</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>${p.rowOff}</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/>${inner}<xdr:clientData/></xdr:oneCellAnchor>`;
    };
    for (const ch of sh.charts) {
      const data = chartData(st.wb, ch);
      if (!data || !data.series.length) { st.warnings.push(`A chart on "${sh.name}" has no numeric data and was skipped.`); continue; }
      const cn = ++st.n.chart;
      files[`xl/charts/chart${cn}.xml`] = chartXML(ch, data);
      st.ct.push([`/xl/charts/chart${cn}.xml`, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);
      const id = drel('chart', `../charts/chart${cn}.xml`);
      anchors += anchor(ch.x, ch.y, ch.w, ch.h, `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${sid}" name="Chart ${cn}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_R}" r:id="${id}"/></a:graphicData></a:graphic></xdr:graphicFrame>`);
      sid++;
    }
    for (const im of sh.images) {
      const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(im.data || '');
      const ext = m && MIME_EXT[m[1]];
      if (!ext) { st.warnings.push(`Picture "${im.name || ''}" on "${sh.name}" is not PNG/JPEG/GIF/BMP and was skipped.`); continue; }
      const n = ++st.n.image;
      files[`xl/media/image${n}.${ext}`] = b64(m[2]);
      st.exts.add(ext);
      const id = drel('image', `../media/image${n}.${ext}`);
      anchors += anchor(im.x, im.y, im.w, im.h, `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${sid}" name="Picture ${n}" descr="${esc(im.alt || im.name || '')}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${NS_R}" r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(im.w * EMU)}" cy="${Math.round(im.h * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`);
      sid++;
    }
    if (anchors) {
      files[`xl/drawings/drawing${dn}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
      files[`xl/drawings/_rels/drawing${dn}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drels.join('')}</Relationships>`;
      st.ct.push([`/xl/drawings/drawing${dn}.xml`, 'application/vnd.openxmlformats-officedocument.drawing+xml']);
      tail += `<drawing r:id="${rel('drawing', `../drawings/drawing${dn}.xml`)}"/>`;
    } else st.n.drawing--;
  }

  if (sh.notes.length) {
    const n = ++st.n.comments;
    const author = 'SheetStudio';
    files[`xl/comments${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${author}</author></authors><commentList>${sh.notes.map((nt) => `<comment ref="${cellName(nt.r, nt.c)}" authorId="0"><text><r><t xml:space="preserve">${esc(nt.text)}</t></r></text></comment>`).join('')}</commentList></comments>`;
    st.ct.push([`/xl/comments${n}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml']);
    const shapes = sh.notes.map((nt, i) => `<v:shape id="_x0000_s${1025 + i}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:20pt;width:140pt;height:70pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${nt.c + 1}, 15, ${Math.max(0, nt.r - 1)}, 10, ${nt.c + 4}, 15, ${nt.r + 4}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${nt.r}</x:Row><x:Column>${nt.c}</x:Column></x:ClientData></v:shape>`).join('');
    files[`xl/drawings/vmlDrawing${n}.vml`] = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${n}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
    st.exts.add('vml');
    rel('comments', `../comments${n}.xml`);
    tail += `<legacyDrawing r:id="${rel('vmlDrawing', `../drawings/vmlDrawing${n}.vml`)}"/>`;
  }

  if (sh.tables.length) {
    let parts = '';
    for (const t of sh.tables) {
      const n = ++st.n.table;
      const hdr = t.header !== false;
      const names = tableColumns(sh, t), seen = new Set();
      const cols = names.map((nm, i) => { let x = nm, k = 2; while (seen.has(x.toLowerCase())) x = nm + k++; seen.add(x.toLowerCase()); return x; });
      const af = sh.filter && sh.filter.r1 === t.r1 && sh.filter.c1 === t.c1 && sh.filter.c2 === t.c2 && sh.filter.r2 >= t.r2 - (t.totals ? 1 : 0);
      if (af) st.tableFilter.add(sh);
      const colXml = cols.map((nm, i) => {
        let extra = '';
        if (t.totals) {
          const cell = sh.cell(t.r2, t.c1 + i);
          if (cell && cell.f != null) extra = ` totalsRowFunction="custom"`;
          else if (cell && typeof cell.v === 'string') extra = ` totalsRowLabel="${esc(cell.v)}"`;
        }
        const cell = t.totals ? sh.cell(t.r2, t.c1 + i) : null;
        const inner = cell && cell.f != null ? `<totalsRowFormula>${esc(st.exportF(cell.f, t))}</totalsRowFormula>` : '';
        return `<tableColumn id="${i + 1}" name="${esc(nm)}"${extra}>${inner}</tableColumn>`.replace(`></tableColumn>`, '/>');
      }).join('');
      const style = t.accent === 0 || t.accent === undefined ? 'TableStyleMedium2' : `TableStyleMedium${[2, 3, 4, 5, 6, 7][t.accent % 6]}`;
      files[`xl/tables/table${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${n}" name="${esc(t.name)}" displayName="${esc(t.name)}" ref="${cellName(t.r1, t.c1)}:${cellName(t.r2, t.c2)}"${hdr ? '' : ' headerRowCount="0"'}${t.totals ? ' totalsRowCount="1"' : ' totalsRowShown="0"'}>${hdr ? `<autoFilter ref="${cellName(t.r1, t.c1)}:${cellName(t.r2 - (t.totals ? 1 : 0), t.c2)}"/>` : ''}<tableColumns count="${cols.length}">${colXml}</tableColumns><tableStyleInfo name="${style}" showFirstColumn="0" showLastColumn="0" showRowStripes="${t.band === false ? 0 : 1}" showColumnStripes="0"/></table>`;
      st.ct.push([`/xl/tables/table${n}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml']);
      parts += `<tablePart r:id="${rel('table', `../tables/table${n}.xml`)}"/>`;
    }
    tail += `<tableParts count="${sh.tables.length}">${parts}</tableParts>`;
  }
  return { rels, tail };
}

// ---------- reading ----------
const mimeOf = (p) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' })[p.split('.').pop().toLowerCase()];
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const CHART_TYPES = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart', 'radarChart', 'bubbleChart', 'stockChart'];

function readChart(root, wbSheetName) {
  const cs = find(root, 'chartSpace');
  const plot = find(cs, 'plotArea');
  if (!plot) return null;
  const types = plot.c.filter((n) => CHART_TYPES.includes(n.n));
  if (!types.length) return null;
  const t = types[0], nm = t.n.replace('3D', '');
  let type = { barChart: kid(t, 'barDir')?.a.val === 'bar' ? 'bar' : 'column', lineChart: 'line', areaChart: 'area', pieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter', radarChart: 'line', bubbleChart: 'scatter', stockChart: 'line' }[nm] || 'column';
  const grouping = kid(t, 'grouping')?.a.val || '';
  const rects = [];
  let firstVal = null, sheet = null;
  const take = (f, isVal) => {
    const p = parseRefText((f || '').trim());
    if (!p) return;
    sheet = sheet || p.sh;
    if (isVal && !firstVal) firstVal = p;
    rects.push(p);
  };
  for (const ser of kids(t, 'ser')) {
    for (const n of ['tx', 'cat', 'xVal']) for (const f of findAll(kid(ser, n), 'f')) take(f.t);
    for (const n of ['val', 'yVal']) for (const f of findAll(kid(ser, n), 'f')) take(f.t, true);
  }
  if (!rects.length) return null;
  const r1 = Math.min(...rects.map((p) => p.r1)), c1 = Math.min(...rects.map((p) => p.c1)), r2 = Math.max(...rects.map((p) => p.r2)), c2 = Math.max(...rects.map((p) => p.c2));
  const sn = sheet || wbSheetName, sp = /^[A-Za-z_][\w.]*$/.test(sn) ? sn + '!' : `'${sn.replace(/'/g, "''")}'!`;
  const title = kid(find(cs, 'chart'), 'title');
  return {
    type, stacked: grouping === 'stacked' || grouping === 'percentStacked',
    byRow: !!firstVal && firstVal.r1 === firstVal.r2 && firstVal.c2 > firstVal.c1,
    range: sp + cellName(r1, c1) + ':' + cellName(r2, c2), title: title ? findAll(title, 't').map((x) => x.t).join('') : '',
    combo: types.length > 1,
  };
}

// io: { xml(path) -> node|null, bin(path) -> Uint8Array|null }
export async function readSheetParts(sh, sheetPath, relList, io, warnings) {
  const of = (suffix) => relList.filter((r) => r.type.endsWith('/' + suffix)).map((r) => resolvePath(sheetPath, r.target));
  // drawings
  for (const dp of of('drawing')) {
    const droot = await io.xml(dp);
    const wsdr = kid(droot, 'wsDr');
    if (!wsdr) continue;
    const drels = {};
    const rr = await io.xml(dp.replace(/([^/]+)$/, '_rels/$1.rels'));
    for (const r of kids(kid(rr, 'Relationships'), 'Relationship')) drels[r.a.Id] = resolvePath(dp, r.a.Target);
    for (const an of wsdr.c) {
      if (!['oneCellAnchor', 'twoCellAnchor', 'absoluteAnchor'].includes(an.n)) continue;
      const num = (n, k) => +(kid(n, k)?.t || 0);
      let x, y, w, h;
      if (an.n === 'absoluteAnchor') { const p = kid(an, 'pos'), e = kid(an, 'ext'); x = +p.a.x / EMU; y = +p.a.y / EMU; w = +e.a.cx / EMU; h = +e.a.cy / EMU; }
      else {
        const f = kid(an, 'from');
        x = colLeft(sh, num(f, 'col')) + num(f, 'colOff') / EMU; y = rowTop(sh, num(f, 'row')) + num(f, 'rowOff') / EMU;
        if (an.n === 'oneCellAnchor') { const e = kid(an, 'ext'); w = +e.a.cx / EMU; h = +e.a.cy / EMU; }
        else { const to = kid(an, 'to'); w = colLeft(sh, num(to, 'col')) + num(to, 'colOff') / EMU - x; h = rowTop(sh, num(to, 'row')) + num(to, 'rowOff') / EMU - y; }
      }
      x = Math.round(x); y = Math.round(y); w = Math.max(60, Math.round(w)); h = Math.max(40, Math.round(h));
      const gf = kid(an, 'graphicFrame'), pic = kid(an, 'pic');
      if (gf) {
        const cref = find(gf, 'chart');
        const path = cref && drels[cref.a.id];
        const cx = path && await io.xml(path);
        const ch = cx && readChart(cx, sh.name);
        if (ch) { sh.charts.push({ id: 'x' + sh.charts.length + Math.random().toString(36).slice(2, 6), x, y, w, h, ...ch }); if (ch.combo) warnings.push(`A combination chart on "${sh.name}" was simplified to its first chart type.`); }
        else warnings.push(`A chart on "${sh.name}" uses a layout that could not be imported.`);
      } else if (pic) {
        const blip = find(pic, 'blip'), path = blip && drels[blip.a.embed], bytes = path && await io.bin(path), mime = path && mimeOf(path);
        if (bytes && mime) sh.images.push({ id: 'i' + sh.images.length + Math.random().toString(36).slice(2, 6), name: path.split('/').pop(), alt: find(pic, 'cNvPr')?.a.descr || '', data: `data:${mime};base64,${toB64(bytes)}`, x, y, w, h });
      } else if (kid(an, 'sp') || kid(an, 'grpSp') || kid(an, 'cxnSp')) warnings.push(`Shapes/text boxes on "${sh.name}" are not imported.`);
    }
  }
  // comments
  for (const cp of of('comments')) {
    const root = kid(await io.xml(cp), 'comments');
    const authors = kids(kid(root, 'authors'), 'author').map((a) => a.t);
    for (const c of kids(kid(root, 'commentList'), 'comment')) {
      const p = parseRefText(c.a.ref);
      if (!p) continue;
      let t = textOf(kid(c, 'text'));
      const au = authors[+c.a.authorId || 0];
      if (au && t.startsWith(au + ':')) t = t.slice(au.length + 1).replace(/^\n/, '');
      sh.notes.push({ r: p.r1, c: p.c1, text: t });
    }
  }
  // tables
  for (const tp of of('table')) {
    const t = kid(await io.xml(tp), 'table');
    if (!t) continue;
    const p = parseRefText(t.a.ref);
    if (!p) continue;
    const sty = kid(t, 'tableStyleInfo');
    const m = /(Medium|Light|Dark)(\d+)/.exec(sty?.a.name || '');
    const n = m ? +m[2] : 2;
    const accent = m && m[1] === 'Medium' && n >= 2 && n <= 7 ? n - 2 : m && m[1] !== 'Medium' && n >= 8 ? (n - 8) % 6 : 0;
    const hdr = t.a.headerRowCount !== '0', totals = +(t.a.totalsRowCount || 0) > 0;
    sh.tables.push({ name: t.a.name || t.a.displayName, r1: p.r1, c1: p.c1, r2: p.r2, c2: p.c2, header: hdr, totals, accent, band: sty ? sty.a.showRowStripes !== '0' : true });
    const af = kid(t, 'autoFilter');
    if (af && !sh.filter && hdr) { const q = parseRefText(af.a.ref); if (q) sh.filter = { r1: q.r1, c1: q.c1, r2: q.r2, c2: q.c2, crit: null }; }
  }
}

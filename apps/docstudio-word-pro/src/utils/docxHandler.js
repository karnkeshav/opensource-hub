import { loadOffice } from './officeLib';

// The docx writer is loaded lazily (see officeLib.js); its classes are bound here on first use.
let Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, BorderStyle, WidthType,
  AlignmentType, ImageRun, InsertedTextRun, DeletedTextRun, FootnoteReferenceRun, CommentRangeStart,
  CommentRangeEnd, CommentReference, ExternalHyperlink, Header, Footer, PageNumber, TabStopType, LeaderType,
  ShadingType, PageBreak, LevelFormat, PageOrientation, HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom, TextWrappingType, VerticalAlign;
let HEADINGS = {};
let CELL_BORDER = null;

function bindDocx(d) {
  ({
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, BorderStyle, WidthType,
    AlignmentType, ImageRun, InsertedTextRun, DeletedTextRun, FootnoteReferenceRun, CommentRangeStart,
    CommentRangeEnd, CommentReference, ExternalHyperlink, Header, Footer, PageNumber, TabStopType, LeaderType,
    ShadingType, PageBreak, LevelFormat, PageOrientation, HorizontalPositionRelativeFrom,
    VerticalPositionRelativeFrom, TextWrappingType, VerticalAlign
  } = d);
  HEADINGS = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3, h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6 };
  CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' };
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/* =============================== IMPORT =============================== */

const IMPORT_STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "r[style-name='TCIns'] => ins.tc-ins",
  "r[style-name='TCDel'] => del.tc-del",
  'u => u',
  'strike => s'
];

const PAGE_BREAK_MARK = '[[DS_PAGE_BREAK]]';

const wAttr = (el, name) => el.getAttributeNS(W_NS, name) ?? el.getAttribute(`w:${name}`);

/** Plain text of a header/footer part; PAGE / NUMPAGES fields become {page} / {pages}. */
function headerFooterText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paras = Array.from(doc.getElementsByTagNameNS(W_NS, 'p'));
  let out = '';
  for (const p of paras) {
    let line = '';
    let skipResult = false;
    p.querySelectorAll('*').forEach((el) => {
      const name = el.localName;
      if (name === 'fldChar') {
        const t = wAttr(el, 'fldCharType');
        if (t === 'separate') skipResult = true;
        if (t === 'end') skipResult = false;
      } else if (name === 'instrText') {
        if (/NUMPAGES/i.test(el.textContent)) line += '{pages}';
        else if (/\bPAGE\b/i.test(el.textContent)) line += '{page}';
      } else if (name === 't' && !skipResult) line += el.textContent;
    });
    if (line.trim()) out += (out ? ' ' : '') + line;
  }
  return out.trim();
}

async function preprocessDocx(buffer) {
  const { JSZip } = await loadOffice();
  const zip = await JSZip.loadAsync(buffer);
  const meta = {};
  const docFile = zip.file('word/document.xml');
  if (!docFile) return { buffer, meta };
  const xml = await docFile.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return { buffer, meta };

  const tagRun = (r, styleId) => {
    let rPr = Array.from(r.children).find((c) => c.localName === 'rPr');
    if (!rPr) {
      rPr = doc.createElementNS(W_NS, 'w:rPr');
      r.insertBefore(rPr, r.firstChild);
    }
    Array.from(rPr.children).filter((c) => c.localName === 'rStyle').forEach((c) => c.remove());
    const rs = doc.createElementNS(W_NS, 'w:rStyle');
    rs.setAttributeNS(W_NS, 'w:val', styleId);
    rPr.insertBefore(rs, rPr.firstChild);
  };
  const tagRuns = (container, styleId) => {
    Array.from(container.getElementsByTagNameNS(W_NS, 'r')).forEach((r) => tagRun(r, styleId));
  };

  let touched = false;
  const styleIds = ['TCIns', 'TCDel'];

  // Hard page breaks: mammoth drops them, so leave a text marker it keeps.
  Array.from(doc.getElementsByTagNameNS(W_NS, 'br')).forEach((br) => {
    if (wAttr(br, 'type') !== 'page') return;
    const t = doc.createElementNS(W_NS, 'w:t');
    t.textContent = PAGE_BREAK_MARK;
    br.parentNode.replaceChild(t, br);
    touched = true;
  });

  // Comments: tag the runs inside each comment range so mammoth keeps them as <span class="dscN">.
  const commentsFile = zip.file('word/comments.xml');
  if (commentsFile) {
    const cdoc = new DOMParser().parseFromString(await commentsFile.async('string'), 'application/xml');
    const map = {};
    Array.from(cdoc.getElementsByTagNameNS(W_NS, 'comment')).forEach((c) => {
      map[wAttr(c, 'id')] = {
        author: wAttr(c, 'author') || 'Author',
        date: wAttr(c, 'date') || new Date().toISOString(),
        text: Array.from(c.getElementsByTagNameNS(W_NS, 't')).map((t) => t.textContent).join('')
      };
    });
    Array.from(doc.getElementsByTagNameNS(W_NS, 'commentRangeStart')).forEach((start) => {
      const id = wAttr(start, 'id');
      if (!map[id]) return;
      for (let n = start.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n.localName === 'commentRangeEnd' && wAttr(n, 'id') === id) break;
        if (n.nodeType === 1 && n.localName === 'r') tagRun(n, `DSComment${id}`);
      }
      styleIds.push(`DSComment${id}`);
      touched = true;
    });
    meta.comments = map;
    meta.styleMapExtra = styleIds.filter((s) => s.startsWith('DSComment')).map((s) => `r[style-name='${s}'] => span.dsc${s.slice(9)}`);
  }
  Array.from(doc.getElementsByTagNameNS(W_NS, 'ins')).forEach((ins) => {
    if (ins.parentNode && ins.parentNode.localName === 'rPr') return; // paragraph-mark revision
    tagRuns(ins, 'TCIns');
    touched = true;
  });
  Array.from(doc.getElementsByTagNameNS(W_NS, 'del')).forEach((del) => {
    if (del.parentNode && del.parentNode.localName === 'rPr') return;
    Array.from(del.getElementsByTagNameNS(W_NS, 'delText')).forEach((dt) => {
      const t = doc.createElementNS(W_NS, 'w:t');
      t.setAttribute('xml:space', 'preserve');
      t.textContent = dt.textContent;
      dt.parentNode.replaceChild(t, dt);
    });
    tagRuns(del, 'TCDel');
    const ins = doc.createElementNS(W_NS, 'w:ins'); // mammoth skips w:del but reads w:ins
    while (del.firstChild) ins.appendChild(del.firstChild);
    del.parentNode.replaceChild(ins, del);
    touched = true;
  });

  if (touched) {
    zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
    const stylesFile = zip.file('word/styles.xml');
    if (stylesFile) {
      let styles = await stylesFile.async('string');
      const defs = styleIds
        .map((id) => `<w:style xmlns:w="${W_NS}" w:type="character" w:styleId="${id}"><w:name w:val="${id}"/></w:style>`)
        .join('');
      styles = styles.replace('</w:styles>', `${defs}</w:styles>`);
      zip.file('word/styles.xml', styles);
    }
  }

  // Page setup + header/footer text from the last section.
  const sect = Array.from(doc.getElementsByTagNameNS(W_NS, 'sectPr')).pop();
  if (sect) {
    const pgSz = sect.getElementsByTagNameNS(W_NS, 'pgSz')[0];
    const cols = sect.getElementsByTagNameNS(W_NS, 'cols')[0];
    const pgMar = sect.getElementsByTagNameNS(W_NS, 'pgMar')[0];
    const setup = {};
    if (pgSz) {
      const w = parseInt(wAttr(pgSz, 'w'), 10);
      const h = parseInt(wAttr(pgSz, 'h'), 10);
      const longSide = Math.max(w, h);
      setup.orientation = wAttr(pgSz, 'orient') === 'landscape' || w > h ? 'landscape' : 'portrait';
      setup.paperSize = longSide > 17000 ? 'legal' : Math.abs(longSide - 15840) < 400 ? 'letter' : 'a4';
    }
    if (cols) setup.columns = Math.min(3, Math.max(1, parseInt(wAttr(cols, 'num'), 10) || 1));
    if (pgMar) {
      const left = parseInt(wAttr(pgMar, 'left'), 10);
      if (left) setup.margins = left <= 1000 ? 'narrow' : left >= 2000 ? 'wide' : 'normal';
    }
    meta.pageSetup = setup;

    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      const rels = new DOMParser().parseFromString(await relsFile.async('string'), 'application/xml');
      const target = (rid) => {
        const rel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === rid);
        return rel ? `word/${rel.getAttribute('Target').replace(/^\/?(word\/)?/, '')}` : null;
      };
      for (const kind of ['header', 'footer']) {
        const ref = Array.from(sect.getElementsByTagNameNS(W_NS, `${kind}Reference`)).find((r) => wAttr(r, 'type') === 'default');
        const path = ref && target(ref.getAttributeNS(R_NS, 'id') || ref.getAttribute('r:id'));
        const f = path && zip.file(path);
        if (f) meta[kind] = headerFooterText(await f.async('string'));
      }
    }
  }

  return { buffer: touched ? await zip.generateAsync({ type: 'arraybuffer' }) : buffer, meta };
}

/** Turn mammoth's footnote markup into the editor's footnote model and give tracked changes ids. */
function postprocessImportedHtml(rawHtml, comments) {
  const mark = PAGE_BREAK_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const html = rawHtml
    .replace(new RegExp(`<p>\\s*${mark}\\s*</p>`, 'g'), '<div class="page-break"></div>')
    .replace(new RegExp(mark, 'g'), '</p><div class="page-break"></div><p>');
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;

  Object.keys(comments || {}).forEach((id) => {
    body.querySelectorAll(`span.dsc${id}`).forEach((span) => {
      span.className = 'comment-anchor';
      span.setAttribute('data-cid', `imp-${id}`);
      span.setAttribute('data-comment', comments[id].text);
      span.setAttribute('data-author', comments[id].author);
      span.setAttribute('data-date', comments[id].date);
    });
  });
  body.querySelectorAll('span.comment-anchor').forEach((sp) => {
    let nx = sp.nextSibling;
    while (nx && nx.nodeType === 1 && nx.matches('span.comment-anchor') && nx.getAttribute('data-cid') === sp.getAttribute('data-cid')) {
      while (nx.firstChild) sp.appendChild(nx.firstChild);
      const gone = nx;
      nx = nx.nextSibling;
      gone.remove();
    }
  });

  const items = Array.from(body.querySelectorAll('li[id^="footnote-"]'));
  if (items.length) {
    const section = doc.createElement('div');
    section.className = 'footnotes-section';
    items.forEach((li, i) => {
      const n = i + 1;
      const id = li.id.replace('footnote-', '');
      const ref = body.querySelector(`a[id="footnote-ref-${id}"]`);
      if (ref) {
        const sup = ref.closest('sup') || ref;
        const mark = doc.createElement('sup');
        mark.className = 'footnote-ref';
        mark.setAttribute('data-fn', String(n));
        mark.textContent = `[${n}]`;
        sup.replaceWith(mark);
      }
      li.querySelectorAll('a[href^="#footnote-ref"]').forEach((a) => a.remove());
      const p = doc.createElement('p');
      p.className = 'footnote';
      p.setAttribute('data-fn', String(n));
      p.innerHTML = `<sup>${n}</sup> <span class="fn-text">${li.textContent.trim()}</span>`;
      section.appendChild(p);
    });
    const ol = items[0].parentElement;
    if (ol) ol.remove();
    body.appendChild(section);
  }

  let k = 0;
  body.querySelectorAll('ins.tc-ins, del.tc-del').forEach((el) => {
    el.setAttribute('data-tc-id', `imp${k++}`);
    el.setAttribute('data-author', 'Imported');
    el.setAttribute('data-date', new Date().toISOString());
  });
  return body.innerHTML;
}

/**
 * Import a .docx file and convert it into rich HTML suitable for the editor
 * @param {File} file
 * @returns {Promise<{html: string, messages: any[], header?: string, footer?: string, pageSetup?: object}>}
 */
export async function importDocxFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  let buf = arrayBuffer;
  let meta = {};
  try {
    const r = await preprocessDocx(arrayBuffer);
    buf = r.buffer;
    meta = r.meta;
  } catch (err) {
    console.warn('DOCX pre-processing skipped:', err);
  }
  const { mammoth } = await loadOffice();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf }, { styleMap: [...IMPORT_STYLE_MAP, ...(meta.styleMapExtra || [])] });
  return { html: postprocessImportedHtml(result.value, meta.comments), messages: result.messages, ...meta };
}

/* =============================== EXPORT =============================== */

const PAPER_TWIPS = { a4: [11906, 16838], letter: [12240, 15840], legal: [12240, 20160] };
const MARGIN_PX = { narrow: 48, normal: 96, wide: 144 };
const PAPER_PX = { a4: [794, 1123], letter: [816, 1056], legal: [816, 1344] };

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'hr', 'pre', 'section', 'article', 'header', 'footer']);

function cssColorToHex(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(str);
  if (m) return m[1].split('').map((c) => c + c).join('').toUpperCase();
  m = /^#([0-9a-f]{6})$/.exec(str);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(([^)]+)\)/.exec(str);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    if (p.length > 3 && p[3] === 0) return null;
    return p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const named = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', yellow: 'FFFF00', orange: 'FFA500', gray: '808080', grey: '808080', purple: '800080' };
  return named[str] || null;
}

const FONT_TAG_PT = [8, 10, 12, 14, 18, 24, 36];
function halfPointsOf(v) {
  if (!v) return undefined;
  const m = /^([\d.]+)(pt|px)$/.exec(v.trim());
  if (!m) return undefined;
  const pt = m[2] === 'pt' ? parseFloat(m[1]) : parseFloat(m[1]) * 0.75;
  return Math.max(2, Math.round(pt * 2));
}

function styleOf(el, base) {
  const s = { ...base };
  const tag = el.tagName.toLowerCase();
  if (tag === 'b' || tag === 'strong' || tag === 'th') s.bold = true;
  if (tag === 'i' || tag === 'em') s.italics = true;
  if (tag === 'u') s.underline = true;
  if (tag === 's' || tag === 'strike') s.strike = true;
  if (tag === 'sup') s.sup = true;
  if (tag === 'sub') s.sub = true;
  if (tag === 'font') {
    if (el.getAttribute('face')) s.font = el.getAttribute('face').split(',')[0].replace(/["']/g, '').trim();
    const c = cssColorToHex(el.getAttribute('color'));
    if (c) s.color = c;
    const sz = parseInt(el.getAttribute('size'), 10);
    if (sz >= 1 && sz <= 7) s.size = FONT_TAG_PT[sz - 1] * 2;
  }
  if (tag === 'ins' && el.classList.contains('tc-ins')) s.track = { type: 'ins', author: el.getAttribute('data-author') || 'Author', date: el.getAttribute('data-date') || new Date().toISOString() };
  if (tag === 'del' && el.classList.contains('tc-del')) s.track = { type: 'del', author: el.getAttribute('data-author') || 'Author', date: el.getAttribute('data-date') || new Date().toISOString() };
  const st = el.style;
  if (st) {
    if (st.fontWeight === 'bold' || parseInt(st.fontWeight, 10) >= 600) s.bold = true;
    if (st.fontStyle === 'italic') s.italics = true;
    const deco = `${st.textDecoration} ${st.textDecorationLine}`;
    if (/underline/.test(deco)) s.underline = true;
    if (/line-through/.test(deco)) s.strike = true;
    const c = cssColorToHex(st.color);
    if (c) s.color = c;
    const bg = cssColorToHex(st.backgroundColor);
    if (bg) s.shade = bg;
    const size = halfPointsOf(st.fontSize);
    if (size) s.size = size;
    if (st.fontFamily) s.font = st.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    if (st.verticalAlign === 'super') s.sup = true;
    if (st.verticalAlign === 'sub') s.sub = true;
  }
  return s;
}

const alignOf = (el) => {
  const a = (el.style && el.style.textAlign) || el.getAttribute('align');
  return { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT }[a];
};

function makeRun(text, s, ctx) {
  const opts = {
    text,
    bold: s.bold || undefined,
    italics: s.italics || undefined,
    underline: s.underline ? {} : undefined,
    strike: s.strike || undefined,
    color: s.color,
    size: s.size,
    font: s.font,
    superScript: s.sup || undefined,
    subScript: s.sub || undefined,
    shading: s.shade ? { type: ShadingType.CLEAR, fill: s.shade, color: 'auto' } : undefined
  };
  if (s.track) {
    const rev = { id: ctx.rev++, author: s.track.author, date: s.track.date };
    return s.track.type === 'ins' ? new InsertedTextRun({ ...opts, ...rev }) : new DeletedTextRun({ ...opts, ...rev });
  }
  return new TextRun(opts);
}

function imageRun(img, ctx, floating) {
  const info = ctx.images.get(img);
  if (!info) return null;
  const opts = { type: info.type, data: info.data, transformation: { width: info.w, height: info.h }, altText: { name: 'image', description: img.getAttribute('alt') || 'image', title: 'image' } };
  if (floating) {
    const px = (v) => Math.round((parseFloat(v) || 0) * 9525);
    opts.floating = {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, offset: px(img.style.left) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.MARGIN, offset: px(img.style.top) },
      allowOverlap: true,
      behindDocument: false,
      wrap: { type: TextWrappingType.NONE }
    };
  }
  return new ImageRun(opts);
}

function inlineNodes(nodes, s, ctx) {
  const out = [];
  for (const n of nodes) {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/[\r\n\t ]+/g, ' ').replace(/​/g, '').replace(/ /g, ' ');
      if (t) out.push(makeRun(t, s, ctx));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') { out.push(new TextRun({ break: 1 })); continue; }
    if (tag === 'img') {
      if (n.classList.contains('ink-layer')) continue;
      const r = imageRun(n, ctx, false);
      if (r) out.push(r);
      continue;
    }
    if (n.classList.contains('footnote-ref')) {
      const num = parseInt(n.getAttribute('data-fn'), 10) || 1;
      out.push(new FootnoteReferenceRun(num));
      ctx.usedFootnotes.add(num);
      continue;
    }
    if (n.classList.contains('comment-anchor') && n.getAttribute('data-comment') != null) {
      const id = ctx.comments.length;
      ctx.comments.push({
        id,
        author: n.getAttribute('data-author') || ctx.author,
        initials: (n.getAttribute('data-author') || ctx.author).slice(0, 2).toUpperCase(),
        date: new Date(n.getAttribute('data-date') || Date.now()),
        children: [new Paragraph({ children: [new TextRun(n.getAttribute('data-comment') || '')] })]
      });
      out.push(new CommentRangeStart(id));
      out.push(...inlineNodes(Array.from(n.childNodes), styleOf(n, s), ctx));
      out.push(new CommentRangeEnd(id));
      out.push(new TextRun({ children: [new CommentReference(id)] }));
      continue;
    }
    if (tag === 'a' && /^(https?:|mailto:)/i.test(n.getAttribute('href') || '')) {
      out.push(new ExternalHyperlink({
        link: n.getAttribute('href'),
        children: inlineNodes(Array.from(n.childNodes), { ...styleOf(n, s), underline: true, color: s.color || '2563EB' }, ctx)
      }));
      continue;
    }
    out.push(...inlineNodes(Array.from(n.childNodes), styleOf(n, s), ctx));
  }
  return out;
}

const spacingOf = (el, extra = {}) => {
  const sp = { after: 120, ...extra };
  const lh = parseFloat(el.style && el.style.lineHeight);
  if (lh && lh > 0 && lh < 10) { sp.line = Math.round(lh * 240); sp.lineRule = 'auto'; }
  return sp;
};

function tocParagraphs(div, ctx) {
  const out = [];
  div.querySelectorAll('h3, .toc-title').forEach((h) => {
    out.push(new Paragraph({ children: [new TextRun({ text: h.textContent.trim(), bold: true, size: 28 })], spacing: { after: 120 } }));
  });
  div.querySelectorAll('.toc-entry').forEach((p) => {
    const level = parseInt(p.getAttribute('data-level'), 10) || 1;
    const title = (p.querySelector('span') || p).textContent.trim();
    out.push(new Paragraph({
      children: [new TextRun({ text: title }), new TextRun({ children: ['\t', p.getAttribute('data-page') || ''] })],
      tabStops: [{ type: TabStopType.RIGHT, position: 9000, leader: LeaderType.DOT }],
      indent: { left: (level - 1) * 360 },
      spacing: { after: 60 }
    }));
  });
  return out;
}

function listParagraphs(listEl, ctx, st, level, out) {
  const ordered = listEl.tagName.toLowerCase() === 'ol';
  const instance = ordered ? ctx.olInstance++ : 0;
  Array.from(listEl.children).forEach((li) => {
    if (li.tagName.toLowerCase() !== 'li') return;
    const inlineKids = [];
    const nested = [];
    Array.from(li.childNodes).forEach((c) => {
      if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) nested.push(c);
      else inlineKids.push(c);
    });
    const blockKids = inlineKids.filter((c) => c.nodeType === 1 && BLOCK_TAGS.has(c.tagName.toLowerCase()));
    const kids = blockKids.length ? inlineKids.filter((c) => !(c.nodeType === 1 && BLOCK_TAGS.has(c.tagName.toLowerCase()))).concat(blockKids.flatMap((b) => Array.from(b.childNodes))) : inlineKids;
    out.push(new Paragraph({
      children: inlineNodes(kids, styleOf(li, st), ctx),
      numbering: { reference: ordered ? 'ds-num' : 'ds-bullet', level: Math.min(level, 3), instance },
      spacing: { after: 60 },
      alignment: alignOf(li)
    }));
    nested.forEach((n) => listParagraphs(n, ctx, st, level + 1, out));
  });
}


function tableFrom(tbl, ctx, st) {
  const trs = Array.from(tbl.querySelectorAll('tr')).filter((tr) => tr.closest('table') === tbl);
  const rows = trs.map((tr) => new TableRow({
    // only emit the flag on real header rows: tableHeader:false still writes w:tblHeader w:val="off",
    // which other readers (mammoth) treat as "header row"
    ...(tr.closest('thead') ? { tableHeader: true } : {}),
    children: Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName)).map((cell) => {
      let kids = blocks(cell, ctx, styleOf(cell, st));
      if (!kids.length) kids = [new Paragraph('')];
      const fill = cssColorToHex(cell.style.backgroundColor) || (cell.tagName === 'TH' ? 'F8FAFC' : null);
      return new TableCell({
        children: kids,
        columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
        rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
        shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
        verticalAlign: VerticalAlign.TOP,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER }
      });
    })
  }));
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

function blocks(parent, ctx, st = {}) {
  const out = [];
  let buf = [];
  const flush = (el) => {
    if (!buf.length) return;
    const children = inlineNodes(buf, st, ctx);
    buf = [];
    if (children.length) out.push(new Paragraph({ children, spacing: { after: 120 }, alignment: el ? alignOf(el) : undefined }));
  };

  for (const n of Array.from(parent.childNodes)) {
    if (n.nodeType === 3) { if (n.nodeValue.trim() || buf.length) buf.push(n); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toLowerCase();
    if (!BLOCK_TAGS.has(tag)) {
      if (tag === 'img' && n.classList.contains('ink-layer')) continue;
      buf.push(n);
      continue;
    }
    flush(parent);
    const cls = n.classList;
    if (cls.contains('footnotes-section')) continue;
    if (cls.contains('page-break')) { out.push(new Paragraph({ children: [new PageBreak()] })); continue; }
    if (cls.contains('toc-container')) { out.push(...tocParagraphs(n, ctx)); continue; }
    const s = styleOf(n, st);

    if (HEADINGS[tag]) {
      const level = tag === 'h1' && cls.contains('title') ? HeadingLevel.TITLE : HEADINGS[tag];
      out.push(new Paragraph({ heading: level, children: inlineNodes(Array.from(n.childNodes), s, ctx), alignment: alignOf(n) }));
    } else if (tag === 'ul' || tag === 'ol') {
      listParagraphs(n, ctx, s, 0, out);
    } else if (tag === 'table') {
      out.push(tableFrom(n, ctx, s));
      out.push(new Paragraph({ spacing: { after: 60 } }));
    } else if (tag === 'hr') {
      out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 1 } }, spacing: { after: 120 } }));
    } else if (tag === 'blockquote') {
      out.push(new Paragraph({ style: 'Quote', children: inlineNodes(Array.from(n.childNodes), s, ctx), border: { left: { style: BorderStyle.SINGLE, size: 18, color: '2563EB', space: 8 } } }));
    } else if (tag === 'pre') {
      out.push(new Paragraph({ children: [new TextRun({ text: n.textContent, font: 'Courier New', size: 20 })], spacing: { after: 120 } }));
    } else if (cls.contains('callout-box')) {
      const kids = inlineNodes(Array.from(n.childNodes), s, ctx);
      out.push(new Paragraph({
        children: kids,
        shading: { type: ShadingType.CLEAR, fill: 'EFF6FF', color: 'auto' },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: '3B82F6', space: 8 } },
        spacing: { before: 120, after: 120 },
        indent: { left: 180 }
      }));
    } else if (tag === 'p' || (tag === 'div' && !Array.from(n.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase())))) {
      const kids = inlineNodes(Array.from(n.childNodes), s, ctx);
      out.push(new Paragraph({ children: kids.length ? kids : [new TextRun('')], alignment: alignOf(n), spacing: spacingOf(n) }));
    } else {
      out.push(...blocks(n, ctx, s));
      if (cls.contains('cover-page')) out.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }
  flush(parent);
  return out;
}

export async function prepareImages(root, maxW) {
  const map = new Map();
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(src);
    if (!m) continue;
    try {
      const probe = new Image();
      probe.src = src;
      await probe.decode();
      let kind = m[1].toLowerCase();
      let data;
      let type;
      if (kind === 'png' || kind === 'gif' || kind === 'bmp') type = kind;
      else if (kind === 'jpeg' || kind === 'jpg') type = 'jpg';
      if (type) {
        const bin = atob(m[2]);
        data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      } else {
        const cv = document.createElement('canvas');
        cv.width = probe.naturalWidth || 300;
        cv.height = probe.naturalHeight || 150;
        cv.getContext('2d').drawImage(probe, 0, 0);
        const bin = atob(cv.toDataURL('image/png').split(',')[1]);
        data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        type = 'png';
      }
      const ratio = (probe.naturalHeight || 1) / (probe.naturalWidth || 1);
      let w = parseFloat(img.style.width) || parseFloat(img.getAttribute('width')) || probe.naturalWidth || 300;
      if (img.classList.contains('ink-layer') === false) w = Math.min(w, maxW);
      const h = parseFloat(img.style.height) && img.classList.contains('ink-layer') ? parseFloat(img.style.height) : w * ratio;
      map.set(img, { data, type, w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) });
    } catch (err) {
      console.warn('Skipping image in DOCX export:', err);
    }
  }
  return map;
}

function headerFooterParagraph(text, align) {
  const parts = String(text).split(/(\{pages?\})/i);
  const children = parts.filter((p) => p !== '').map((p) => {
    if (/^\{page\}$/i.test(p)) return new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '6E7887' });
    if (/^\{pages\}$/i.test(p)) return new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '6E7887' });
    return new TextRun({ text: p, size: 18, color: '6E7887' });
  });
  return new Paragraph({ children, alignment: align });
}

/**
 * Build a .docx Blob from editor HTML.
 * @param {string} html
 * @param {string} title
 * @param {{pageSetup?: object, header?: string, footer?: string, author?: string}} opts
 */
export async function buildDocxBlob(html, title = 'Document', opts = {}) {
  bindDocx(await loadOffice());
  const author = opts.author || 'DocStudio User';
  const ps = { margins: 'normal', orientation: 'portrait', paperSize: 'a4', columns: 1, ...(opts.pageSetup || {}) };
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const [pxW, pxH] = PAPER_PX[ps.paperSize] || PAPER_PX.a4;
  const marginPx = MARGIN_PX[ps.margins] || 96;
  const maxW = Math.max(200, (ps.orientation === 'landscape' ? pxH : pxW) - 2 * marginPx);

  const ctx = {
    author,
    rev: 1,
    olInstance: 1,
    comments: [],
    usedFootnotes: new Set(),
    images: await prepareImages(doc.body, maxW)
  };

  // Footnote bodies
  const footnotes = {};
  doc.querySelectorAll('.footnotes-section .footnote').forEach((p) => {
    const n = parseInt(p.getAttribute('data-fn'), 10);
    if (!n) return;
    const t = (p.querySelector('.fn-text') || p).textContent.replace(/^\s*\d+\s*/, '').trim();
    footnotes[n] = { children: [new Paragraph({ children: [new TextRun({ text: t, size: 18 })] })] };
  });

  let children = blocks(doc.body, ctx);
  doc.querySelectorAll('.footnote-ref').forEach((r) => {
    const n = parseInt(r.getAttribute('data-fn'), 10) || 1;
    if (!footnotes[n]) footnotes[n] = { children: [new Paragraph('')] };
  });

  // Floating ink layer, anchored to the first paragraph
  const ink = doc.body.querySelector('img.ink-layer');
  if (ink) {
    const run = imageRun(ink, ctx, true);
    if (run) {
      const idx = children.findIndex((c) => c instanceof Paragraph);
      const holder = new Paragraph({ children: [run] });
      if (idx === -1) children.push(holder);
      else children.splice(idx, 0, holder);
    }
  }
  if (!children.length) children = [new Paragraph('')];

  const [tw, th] = PAPER_TWIPS[ps.paperSize] || PAPER_TWIPS.a4;
  const m = marginPx * 15;
  const section = {
    properties: {
      page: {
        size: { width: tw, height: th, orientation: ps.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        margin: { top: m, bottom: m, left: m, right: m, header: 500, footer: 500 }
      },
      column: ps.columns > 1 ? { count: ps.columns, space: 600 } : undefined
    },
    children
  };
  if (opts.header) section.headers = { default: new Header({ children: [headerFooterParagraph(opts.header, AlignmentType.LEFT)] }) };
  if (opts.footer) section.footers = { default: new Footer({ children: [headerFooterParagraph(opts.footer, AlignmentType.CENTER)] }) };

  const levels = (fmt, texts) => [0, 1, 2, 3].map((l) => ({
    level: l,
    format: fmt,
    text: texts(l),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } }
  }));

  const docx = new Document({
    creator: author,
    lastModifiedBy: author,
    title,
    description: 'Created with DocStudio Word Pro',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 120, line: 276 } } },
        title: { run: { font: 'Calibri Light', size: 56, color: '1F3864' }, paragraph: { spacing: { after: 160 } } },
        heading1: { run: { font: 'Calibri Light', size: 40, bold: true, color: '1F3864' }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        heading2: { run: { font: 'Calibri Light', size: 32, bold: true, color: '2F5496' }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true } },
        heading3: { run: { font: 'Calibri Light', size: 26, bold: true, color: '1F3763' }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true } }
      },
      paragraphStyles: [
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { italics: true, color: '404040' }, paragraph: { indent: { left: 720, right: 720 }, spacing: { before: 120, after: 120 } } }
      ]
    },
    numbering: {
      config: [
        { reference: 'ds-bullet', levels: levels(LevelFormat.BULLET, (l) => ['•', '◦', '▪', '•'][l]) },
        { reference: 'ds-num', levels: levels(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) }
      ]
    },
    footnotes: Object.keys(footnotes).length ? footnotes : undefined,
    comments: ctx.comments.length ? { children: ctx.comments } : undefined,
    sections: [section]
  });
  return Packer.toBlob(docx);
}

/**
 * Export HTML content into a downloadable .docx file
 */
export async function exportToDocx(html, title = 'Document', opts = {}) {
  const blob = await buildDocxBlob(html, title, opts);
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `${title.replace(/\s+/g, '_')}.docx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);
  return blob;
}

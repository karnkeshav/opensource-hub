import { loadOffice } from './officeLib';
import { prepareImages } from './docxHandler';

// Plain-text style exporters (txt / md / html) plus RTF and ODT writers.
// Tracked changes: txt, md, rtf and odt use the "all changes accepted" text; html keeps <ins>/<del>.

const PAPER_TWIPS = { a4: [11906, 16838], letter: [12240, 15840], legal: [12240, 20160] };
const PAPER_PX = { a4: [794, 1123], letter: [816, 1056], legal: [816, 1344] };
const MARGIN_PX = { narrow: 48, normal: 96, wide: 144 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

function parse(html) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

/** Footnote body text, tolerant of the .fn-text span having been typed over. */
const footnoteText = (p) => (p.querySelector('.fn-text') || p).textContent.replace(/^\s*\d+\s*/, '').trim();

/** Copy of the document with tracked changes accepted and editor-only artefacts removed. */
function acceptedBody(html) {
  const body = parse(html);
  body.querySelectorAll('del.tc-del').forEach((d) => d.remove());
  body.querySelectorAll('ins.tc-ins').forEach((i) => { while (i.firstChild) i.parentNode.insertBefore(i.firstChild, i); i.remove(); });
  body.querySelectorAll('img.ink-layer, .page-break').forEach((e) => { if (e.classList.contains('ink-layer')) e.remove(); });
  // strip the zero-width markers Track Changes leaves behind
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let tn;
  while ((tn = walker.nextNode())) if (tn.nodeValue.includes('​')) tn.nodeValue = tn.nodeValue.replace(/​/g, '');
  return body;
}

/* ------------------------------ TXT ------------------------------ */
export function htmlToTxt(html) {
  const body = acceptedBody(html);
  const out = [];
  const walk = (node, ctx) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\s+/g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (n.classList.contains('page-break')) { out.push('\n\f\n'); continue; }
      if (tag === 'br') { out.push('\n'); continue; }
      if (tag === 'hr') { out.push('\n----------------------------------------\n'); continue; }
      if (tag === 'img') continue;
      if (tag === 'ul' || tag === 'ol') {
        out.push('\n');
        Array.from(n.children).forEach((li, i) => {
          out.push(`${'  '.repeat(ctx.depth)}${tag === 'ol' ? `${i + 1}. ` : '- '}`);
          const sub = { depth: ctx.depth + 1 };
          Array.from(li.childNodes).forEach((c) => {
            if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) walk({ childNodes: [c] }, sub);
            else walk({ childNodes: [c] }, sub);
          });
          out.push('\n');
        });
        continue;
      }
      if (tag === 'table') {
        out.push('\n');
        n.querySelectorAll('tr').forEach((tr) => {
          out.push(Array.from(tr.cells).map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join('\t'));
          out.push('\n');
        });
        continue;
      }
      if (n.classList.contains('footnotes-section')) {
        out.push('\n');
        n.querySelectorAll('.footnote').forEach((p) => out.push(`[${p.getAttribute('data-fn')}] ${footnoteText(p)}\n`));
        continue;
      }
      const block = /^(p|div|h[1-6]|blockquote|pre|section)$/.test(tag);
      if (block) out.push('\n');
      walk(n, ctx);
      if (block) out.push('\n');
    }
  };
  walk(body, { depth: 0 });
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------ Markdown ------------------------------ */
// Keep the emphasis markers tight against the words (spaces move outside), as Markdown requires.
function wrapMd(marker, inner) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : inner;
}

export function htmlToMd(html) {
  const body = acceptedBody(html);
  const inline = (node) => {
    let s = '';
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { s += n.nodeValue.replace(/\s+/g, ' ').replace(/([*_`\\])/g, '\\$1'); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const inner = () => inline(n);
      if (tag === 'br') s += '  \n';
      else if (tag === 'b' || tag === 'strong' || /bold|[6-9]00/.test(n.style.fontWeight || '')) s += wrapMd('**', inner());
      else if (tag === 'i' || tag === 'em' || n.style.fontStyle === 'italic') s += wrapMd('*', inner());
      else if (tag === 's' || tag === 'strike' || /line-through/.test(n.style.textDecoration || '')) s += wrapMd('~~', inner());
      else if (tag === 'code') s += `\`${n.textContent}\``;
      else if (n.classList.contains('footnote-ref')) s += `[^${n.getAttribute('data-fn')}]`;
      else if (tag === 'a') s += n.getAttribute('href') ? `[${inner()}](${n.getAttribute('href')})` : inner();
      else if (tag === 'img') s += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
      else if (tag === 'sup') s += `<sup>${inner()}</sup>`;
      else if (tag === 'sub') s += `<sub>${inner()}</sub>`;
      else s += inner();
    }
    return s;
  };
  const list = (el, depth) => {
    const ordered = el.tagName.toLowerCase() === 'ol';
    let out = '';
    Array.from(el.children).forEach((li, i) => {
      const nested = Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName));
      const clone = li.cloneNode(true);
      Array.from(clone.children).forEach((c) => { if (/^(ul|ol)$/i.test(c.tagName)) c.remove(); });
      out += `${'  '.repeat(depth)}${ordered ? `${i + 1}.` : '-'} ${inline(clone).trim()}\n`;
      nested.forEach((n) => { out += list(n, depth + 1); });
    });
    return out;
  };
  const table = (t) => {
    const rows = Array.from(t.rows).map((tr) => Array.from(tr.cells).map((c) => inline(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
    if (!rows.length) return '';
    const w = Math.max(...rows.map((r) => r.length));
    const pad = (r) => `| ${[...r, ...Array(w - r.length).fill('')].join(' | ')} |`;
    return `${pad(rows[0])}\n| ${Array(w).fill('---').join(' | ')} |\n${rows.slice(1).map(pad).join('\n')}\n`;
  };
  const blocks = (node) => {
    let out = '';
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) out += `${n.nodeValue.trim()}\n\n`; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (n.classList.contains('page-break')) { out += '\n---\n\n'; continue; }
      if (n.classList.contains('footnotes-section')) {
        n.querySelectorAll('.footnote').forEach((p) => { out += `[^${p.getAttribute('data-fn')}]: ${footnoteText(p)}\n`; });
        out += '\n';
        continue;
      }
      if (/^h[1-6]$/.test(tag)) out += `${'#'.repeat(Number(tag[1]))} ${inline(n).trim()}\n\n`;
      else if (tag === 'p') { const t = inline(n).trim(); if (t) out += `${t}\n\n`; }
      else if (tag === 'ul' || tag === 'ol') out += `${list(n, 0)}\n`;
      else if (tag === 'table') out += `${table(n)}\n`;
      else if (tag === 'blockquote') out += `${inline(n).trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      else if (tag === 'hr') out += '---\n\n';
      else if (tag === 'pre') out += `\`\`\`\n${n.textContent}\n\`\`\`\n\n`;
      else if (n.classList.contains('toc-container')) {
        n.querySelectorAll('.toc-entry').forEach((p) => { out += `- ${(p.querySelector('span') || p).textContent.trim()}\n`; });
        out += '\n';
      } else if (Array.from(n.children).some((c) => /^(p|h[1-6]|ul|ol|table|div|blockquote)$/i.test(c.tagName))) out += blocks(n);
      else { const t = inline(n).trim(); if (t) out += `${t}\n\n`; }
    }
    return out;
  };
  return `${blocks(body).replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ------------------------------ HTML ------------------------------ */
export function htmlToStandalone(html, title, opts = {}) {
  const ps = { margins: 'normal', orientation: 'portrait', paperSize: 'a4', columns: 1, ...(opts.pageSetup || {}) };
  const [w] = PAPER_PX[ps.paperSize] || PAPER_PX.a4;
  const m = MARGIN_PX[ps.margins] || 96;
  const body = parse(html);
  body.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
  body.querySelectorAll('.img-selected').forEach((e) => e.classList.remove('img-selected'));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="author" content="${escAttr(opts.author || 'DocStudio User')}"><meta name="generator" content="DocStudio Word Pro">
<style>
body{background:#eef1f5;margin:0;padding:24px;font-family:Calibri,Arial,sans-serif}
.page{background:#fff;max-width:${w}px;margin:0 auto;padding:${m}px;box-shadow:0 2px 12px rgba(0,0,0,.15);color:#1e293b;font-size:11pt;line-height:1.5;position:relative${ps.columns > 1 ? `;column-count:${ps.columns};column-gap:40px` : ''}}
h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:8px 12px;vertical-align:top}
blockquote{border-left:4px solid #2563eb;padding-left:1rem;color:#4b5563;font-style:italic}.callout-box{background:#eff6ff;border-left:4px solid #3b82f6;padding:.75rem 1rem}
ins.tc-ins{color:#1d4ed8;text-decoration:underline}del.tc-del{color:#b91c1c;text-decoration:line-through}
.page-break{border-top:2px dashed #94a3b8;margin:2rem 0;break-after:page}.footnotes-section{margin-top:2rem;border-top:1px solid #94a3b8;font-size:9.5pt}
img{max-width:100%}img.ink-layer{position:absolute;max-width:none}.comment-anchor{background:rgba(250,204,21,.35)}
a{color:#2563eb}ul{list-style:disc;padding-left:1.6rem}ol{padding-left:1.6rem}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}
</style></head><body>
${opts.header ? `<div style="max-width:${w}px;margin:0 auto 6px;color:#6e7887;font-size:9pt">${esc(String(opts.header).replace(/\{pages?\}/gi, ''))}</div>` : ''}
<div class="page">${body.innerHTML.replace(/​/g, '')}</div>
${opts.footer ? `<div style="max-width:${w}px;margin:6px auto 0;color:#6e7887;font-size:9pt;text-align:center">${esc(String(opts.footer).replace(/\{page\}/gi, '1').replace(/\{pages\}/gi, '1'))}</div>` : ''}
</body></html>
`;
}

/* ------------------------------ RTF ------------------------------ */
const rtfText = (t) => {
  let o = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') o += `\\${ch}`;
    else if (ch === '\n') o += '\\line ';
    else if (c > 126) {
      if (c > 0xffff) {
        const v = c - 0x10000;
        o += `\\u${((0xd800 + (v >> 10)) << 16) >> 16}?\\u${((0xdc00 + (v & 0x3ff)) << 16) >> 16}?`;
      } else o += `\\u${(c << 16) >> 16}?`;
    } else o += ch;
  }
  return o;
};

const toHex = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; };
const hexColor = (str) => {
  const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(str || '') || /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str || '');
  if (!m) return null;
  return /rgb/.test(str) ? [m[1], m[2], m[3]].map(Number) : [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};

export async function htmlToRtf(html, title, opts = {}) {
  const ps = { margins: 'normal', orientation: 'portrait', paperSize: 'a4', columns: 1, ...(opts.pageSetup || {}) };
  const body = acceptedBody(html);
  const [pxW, pxH] = PAPER_PX[ps.paperSize] || PAPER_PX.a4;
  const marginPx = MARGIN_PX[ps.margins] || 96;
  const images = await prepareImages(body, (ps.orientation === 'landscape' ? pxH : pxW) - 2 * marginPx);
  const fonts = ['Calibri'];
  const colors = [];
  const fontIdx = (f) => { const n = f.replace(/["']/g, '').split(',')[0].trim(); let i = fonts.indexOf(n); if (i < 0) { fonts.push(n); i = fonts.length - 1; } return i; };
  const colorIdx = (rgb) => { const k = rgb.join(','); let i = colors.findIndex((c) => c.join(',') === k); if (i < 0) { colors.push(rgb); i = colors.length - 1; } return i + 1; };
  const contentTwips = ((ps.orientation === 'landscape' ? PAPER_TWIPS[ps.paperSize][1] : PAPER_TWIPS[ps.paperSize][0]) || 11906) - 2 * marginPx * 15;

  const styleCtl = (el, base) => {
    const s = { ...base };
    const tag = el.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong' || tag === 'th') s.b = true;
    if (tag === 'i' || tag === 'em') s.i = true;
    if (tag === 'u') s.u = true;
    if (tag === 's' || tag === 'strike') s.s = true;
    if (tag === 'sup') s.sup = true;
    if (tag === 'sub') s.sub = true;
    if (tag === 'font') {
      if (el.getAttribute('face')) s.font = fontIdx(el.getAttribute('face'));
      const c = hexColor(el.getAttribute('color'));
      if (c) s.cf = colorIdx(c);
    }
    const st = el.style;
    if (st) {
      if (/bold|^[6-9]00$/.test(st.fontWeight)) s.b = true;
      if (st.fontStyle === 'italic') s.i = true;
      if (/underline/.test(st.textDecoration)) s.u = true;
      if (/line-through/.test(st.textDecoration)) s.s = true;
      const c = hexColor(st.color);
      if (c) s.cf = colorIdx(c);
      const bg = hexColor(st.backgroundColor);
      if (bg) s.hl = colorIdx(bg);
      const m = /^([\d.]+)(pt|px)$/.exec(st.fontSize || '');
      if (m) s.fs = Math.round((m[2] === 'pt' ? +m[1] : +m[1] * 0.75) * 2);
      if (st.fontFamily) s.font = fontIdx(st.fontFamily);
    }
    return s;
  };
  const ctl = (s) => `${s.b ? '\\b' : ''}${s.i ? '\\i' : ''}${s.u ? '\\ul' : ''}${s.s ? '\\strike' : ''}${s.sup ? '\\super' : ''}${s.sub ? '\\sub' : ''}${s.cf ? `\\cf${s.cf}` : ''}${s.hl ? `\\highlight${s.hl}` : ''}${s.fs ? `\\fs${s.fs}` : ''}${s.font != null ? `\\f${s.font}` : ''}`;

  let olLists = 0;
  let footnoteBodies = {};
  body.querySelectorAll('.footnotes-section .footnote').forEach((p) => { footnoteBodies[p.getAttribute('data-fn')] = (p.querySelector('.fn-text') || p).textContent.replace(/^\s*\d+\s*/, '').trim(); });

  const inline = (nodes, st) => {
    let o = '';
    for (const n of nodes) {
      if (n.nodeType === 3) { const t = n.nodeValue.replace(/\s+/g, ' ').replace(/\u200B/g, ''); if (t) o += `{${ctl(st)} ${rtfText(t)}}`; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { o += '\\line '; continue; }
      if (tag === 'img') {
        const info = images.get(n);
        if (info && (info.type === 'png' || info.type === 'jpg')) {
          o += `{\\pict\\${info.type === 'png' ? 'pngblip' : 'jpegblip'}\\picw${info.w}\\pich${info.h}\\picwgoal${info.w * 15}\\pichgoal${info.h * 15} ${toHex(info.data)}}`;
        }
        continue;
      }
      if (n.classList.contains('footnote-ref')) {
        const k = n.getAttribute('data-fn');
        o += `{\\super\\chftn{\\footnote\\pard\\plain\\fs18 {\\super\\chftn} ${rtfText(footnoteBodies[k] || '')}\\par}}`;
        continue;
      }
      if (tag === 'a' && /^(https?:|mailto:)/i.test(n.getAttribute('href') || '')) {
        o += `{\\field{\\*\\fldinst HYPERLINK "${n.getAttribute('href').replace(/["\\]/g, '')}"}{\\fldrslt ${inline(Array.from(n.childNodes), { ...styleCtl(n, st), u: true, cf: colorIdx([37, 99, 235]) })}}}`;
        continue;
      }
      o += inline(Array.from(n.childNodes), styleCtl(n, st));
    }
    return o;
  };

  const alignCtl = (el) => ({ center: '\\qc', right: '\\qr', justify: '\\qj' }[(el.style && el.style.textAlign) || el.getAttribute('align')] || '\\ql');

  const grid = (table) => {
    const rows = Array.from(table.rows);
    const g = rows.map(() => []);
    rows.forEach((tr, r) => {
      let c = 0;
      Array.from(tr.cells).forEach((cell) => {
        while (g[r][c]) c++;
        for (let i = 0; i < (cell.rowSpan || 1); i++) for (let j = 0; j < (cell.colSpan || 1); j++) if (g[r + i]) g[r + i][c + j] = { cell, origin: i === 0 && j === 0, rowFirst: i === 0, colFirst: j === 0 };
        c += cell.colSpan || 1;
      });
    });
    return g;
  };

  const blocks = (parent, st) => {
    let o = '';
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const t = inline(buf, st);
      buf = [];
      if (t.trim()) o += `\\pard\\sa120\\ql ${t}\\par\n`;
    };
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === 3) { if (n.nodeValue.trim() || buf.length) buf.push(n); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (!/^(p|div|h[1-6]|ul|ol|table|blockquote|hr|pre)$/.test(tag)) { buf.push(n); continue; }
      flush();
      const cls = n.classList;
      if (cls.contains('footnotes-section')) continue;
      if (cls.contains('page-break')) { o += '\\page\n'; continue; }
      const s = styleCtl(n, st);
      if (/^h[1-6]$/.test(tag)) {
        const isTitle = tag === 'h1' && cls.contains('title');
        const size = isTitle ? 56 : { h1: 40, h2: 32, h3: 26 }[tag] || 24;
        const sty = isTitle ? 11 : Math.min(3, Number(tag[1]));
        o += `\\pard\\s${sty}${isTitle ? '' : `\\outlinelevel${sty - 1}`}\\sb240\\sa120${alignCtl(n)}\\keepn {${isTitle ? '' : '\\b'}\\fs${s.fs || size}${s.cf ? `\\cf${s.cf}` : ''} ${inline(Array.from(n.childNodes), { ...s, fs: s.fs || size, b: !isTitle })}}\\par\n`;
      } else if (tag === 'ul' || tag === 'ol') {
        const walk = (list, depth, olLs) => {
          const ordered = list.tagName.toLowerCase() === 'ol';
          let ls = 1;
          if (ordered) { olLs = 2 + olLists; olLists++; ls = olLs; }
          Array.from(list.children).forEach((li) => {
            const kids = Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)));
            o += `\\pard\\ls${ordered ? ls : 1}\\ilvl${Math.min(depth, 3)}\\sa60 ${inline(kids, styleCtl(li, s))}\\par\n`;
            Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName)).forEach((c) => walk(c, depth + 1, olLs));
          });
        };
        walk(n, 0);
      } else if (tag === 'table') {
        const g = grid(n);
        const cols = Math.max(1, ...g.map((r) => r.length));
        const cw = Math.floor(contentTwips / cols);
        g.forEach((row, r) => {
          let line = '\\trowd\\trgaph108';
          for (let c = 0; c < cols; c++) {
            const slot = row[c];
            const merge = slot ? `${!slot.rowFirst ? '\\clvmrg' : (slot.cell.rowSpan || 1) > 1 ? '\\clvmgf' : ''}${!slot.colFirst ? '\\clmrg' : (slot.cell.colSpan || 1) > 1 ? '\\clmgf' : ''}` : '';
            const fill = slot && hexColor(slot.cell.style.backgroundColor);
            line += `${merge}\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10${fill ? `\\clcbpat${colorIdx(fill)}` : ''}\\cellx${cw * (c + 1)}`;
          }
          o += `${line}\n`;
          for (let c = 0; c < cols; c++) {
            const slot = row[c];
            if (slot && slot.origin) o += `\\pard\\intbl ${inline(Array.from(slot.cell.childNodes), styleCtl(slot.cell, s))}\\cell\n`;
            else o += '\\pard\\intbl \\cell\n';
          }
          o += '\\row\n';
        });
        o += '\\pard\\par\n';
      } else if (tag === 'hr') {
        o += '\\pard\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n';
      } else if (tag === 'blockquote') {
        o += `\\pard\\s12\\li720\\sb120\\sa120 {\\i ${inline(Array.from(n.childNodes), { ...s, i: true })}}\\par\n`;
      } else if (cls.contains('toc-container')) {
        o += `\\pard\\sa120 {\\b\\fs28 ${rtfText((n.querySelector('h3') || { textContent: 'Table of Contents' }).textContent.trim())}}\\par\n`;
        n.querySelectorAll('.toc-entry').forEach((p) => {
          o += `\\pard\\li${(((+p.getAttribute('data-level')) || 1) - 1) * 360}\\tqr\\tldot\\tx9000 ${rtfText((p.querySelector('span') || p).textContent.trim())}\\tab ${rtfText(p.getAttribute('data-page') || '')}\\par\n`;
        });
      } else if (cls.contains('callout-box')) {
        o += `\\pard\\li180\\sb120\\sa120\\cbpat${colorIdx([239, 246, 255])}\\brdrl\\brdrs\\brdrw30\\brsp80 ${inline(Array.from(n.childNodes), s)}\\par\n`;
      } else if (tag === 'p' || (tag === 'div' && !Array.from(n.children).some((c) => /^(p|div|h[1-6]|ul|ol|table|blockquote)$/i.test(c.tagName)))) {
        o += `\\pard\\sa120${alignCtl(n)} ${inline(Array.from(n.childNodes), s)}\\par\n`;
      } else {
        o += blocks(n, s);
      }
    }
    flush();
    return o;
  };

  const content = blocks(body, {});
  const [pw, ph] = PAPER_TWIPS[ps.paperSize] || PAPER_TWIPS.a4;
  const land = ps.orientation === 'landscape';
  const m = marginPx * 15;
  const headerRtf = opts.header ? `{\\header\\pard\\ql\\fs18 ${rtfText(String(opts.header).replace(/\{pages?\}/gi, ''))}\\par}` : '';
  const footerTxt = opts.footer
    ? String(opts.footer).split(/(\{pages?\})/i).map((p) => (/^\{page\}$/i.test(p) ? '{\\field{\\*\\fldinst PAGE}{\\fldrslt 1}}' : /^\{pages\}$/i.test(p) ? '{\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}' : rtfText(p))).join('')
    : '';
  const footerRtf = opts.footer ? `{\\footer\\pard\\qc\\fs18 ${footerTxt}\\par}` : '';
  const date = new Date();
  const d = `\\yr${date.getFullYear()}\\mo${date.getMonth() + 1}\\dy${date.getDate()}\\hr${date.getHours()}\\min${date.getMinutes()}`;
  // Real Word lists (list 1 = bullets, list 2.. = one numbered list each so numbering restarts)
  const lvl = (i, bullet) => bullet
    ? `{\\listlevel\\levelnfc23\\leveljc0\\levelfollow0\\levelstartat1{\\leveltext\\'01\\u8226 ?;}{\\levelnumbers;}\\fi-360\\li${720 * (i + 1)}}`
    : `{\\listlevel\\levelnfc0\\leveljc0\\levelfollow0\\levelstartat1{\\leveltext\\'02\\'0${i}.;}{\\levelnumbers\\'01;}\\fi-360\\li${720 * (i + 1)}}`;
  const listBlock = (id, bullet) => `{\\list\\listtemplateid${100 + id}\\listhybrid${[0, 1, 2, 3].map((i) => lvl(i, bullet)).join('')}{\\listname ;}\\listid${id}}`;
  const listTable = `{\\*\\listtable${listBlock(1, true)}${listBlock(2, false)}}`;
  const overrides = `{\\*\\listoverridetable{\\listoverride\\listid1\\listoverridecount0\\ls1}${Array.from({ length: olLists }, (_, k) => `{\\listoverride\\listid2\\listoverridecount1{\\lfolevel\\listoverridestartat\\levelstartat1}\\ls${2 + k}}`).join('')}}`;
  const stylesheet = '{\\stylesheet{\\s0\\snext0 Normal;}{\\s1\\sbasedon0\\snext0\\outlinelevel0\\keepn\\sb240\\sa120\\b\\fs40 heading 1;}{\\s2\\sbasedon0\\snext0\\outlinelevel1\\keepn\\sb240\\sa120\\b\\fs32 heading 2;}{\\s3\\sbasedon0\\snext0\\outlinelevel2\\keepn\\sb240\\sa120\\b\\fs26 heading 3;}{\\s11\\sbasedon0\\snext0\\sa160\\fs56 Title;}{\\s12\\sbasedon0\\snext0\\li720\\sb120\\sa120\\i Quote;}}';
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\\fet0\\ftnbj
{\\fonttbl${fonts.map((f, i) => `{\\f${i}\\fnil\\fcharset0 ${rtfText(f)};}`).join('')}}
{\\colortbl;${colors.map((c) => `\\red${c[0]}\\green${c[1]}\\blue${c[2]};`).join('')}}
${stylesheet}${listTable}${overrides}
{\\info{\\title ${rtfText(title)}}{\\author ${rtfText(opts.author || 'DocStudio User')}}{\\creatim${d}}{\\revtim${d}}}
\\paperw${land ? ph : pw}\\paperh${land ? pw : ph}${land ? '\\landscape' : ''}\\margl${m}\\margr${m}\\margt${m}\\margb${m}${ps.columns > 1 ? `\\cols${ps.columns}\\colsx600` : ''}\\fs22
${headerRtf}${footerRtf}
${content}}`;
  return rtf;
}

/* ------------------------------ ODT ------------------------------ */
export async function htmlToOdt(html, title, opts = {}) {
  const ps = { margins: 'normal', orientation: 'portrait', paperSize: 'a4', columns: 1, ...(opts.pageSetup || {}) };
  const body = acceptedBody(html);
  const [pxW, pxH] = PAPER_PX[ps.paperSize] || PAPER_PX.a4;
  const landscape = ps.orientation === 'landscape';
  const marginPx = MARGIN_PX[ps.margins] || 96;
  const images = await prepareImages(body, (landscape ? pxH : pxW) - 2 * marginPx);
  const mm = (px) => `${(px * 0.264583).toFixed(2)}mm`;
  const pictures = [];
  const styles = new Map(); // key -> name
  const autoStyles = [];

  const textStyle = (s) => {
    const key = JSON.stringify(s);
    if (!Object.keys(s).length) return null;
    if (styles.has(key)) return styles.get(key);
    const name = `T${styles.size + 1}`;
    styles.set(key, name);
    autoStyles.push(
      `<style:style style:name="${name}" style:family="text"><style:text-properties${s.b ? ' fo:font-weight="bold"' : ''}${s.i ? ' fo:font-style="italic"' : ''}${s.u ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : ''}${s.s ? ' style:text-line-through-style="solid"' : ''}${s.sup ? ' style:text-position="super 58%"' : ''}${s.sub ? ' style:text-position="sub 58%"' : ''}${s.color ? ` fo:color="${s.color}"` : ''}${s.bg ? ` fo:background-color="${s.bg}"` : ''}${s.fs ? ` fo:font-size="${s.fs}pt"` : ''}${s.font ? ` style:font-name="${escAttr(s.font)}" fo:font-family="${escAttr(s.font)}"` : ''}/></style:style>`
    );
    return name;
  };
  const hex6 = (str) => { const c = hexColor(str); return c ? `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}` : null; };
  const styleOf = (el, base) => {
    const s = { ...base };
    const tag = el.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong' || tag === 'th') s.b = true;
    if (tag === 'i' || tag === 'em') s.i = true;
    if (tag === 'u') s.u = true;
    if (tag === 's' || tag === 'strike') s.s = true;
    if (tag === 'sup') s.sup = true;
    if (tag === 'sub') s.sub = true;
    const st = el.style;
    if (st) {
      if (/bold|^[6-9]00$/.test(st.fontWeight)) s.b = true;
      if (st.fontStyle === 'italic') s.i = true;
      if (/underline/.test(st.textDecoration)) s.u = true;
      if (/line-through/.test(st.textDecoration)) s.s = true;
      const c = hex6(st.color); if (c) s.color = c;
      const bg = hex6(st.backgroundColor); if (bg) s.bg = bg;
      const m = /^([\d.]+)(pt|px)$/.exec(st.fontSize || '');
      if (m) s.fs = Math.round((m[2] === 'pt' ? +m[1] : +m[1] * 0.75) * 10) / 10;
      if (st.fontFamily) s.font = st.fontFamily.replace(/["']/g, '').split(',')[0].trim();
    }
    return s;
  };

  const spacesFix = (t) => esc(t).replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
  const comments = [];
  const inline = (nodes, st) => {
    let o = '';
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const t = n.nodeValue.replace(/\s+/g, ' ').replace(/\u200B/g, '');
        if (!t) continue;
        const name = textStyle(st);
        o += name ? `<text:span text:style-name="${name}">${spacesFix(t)}</text:span>` : spacesFix(t);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { o += '<text:line-break/>'; continue; }
      if (tag === 'img') {
        const info = images.get(n);
        if (info) {
          const idx = pictures.length + 1;
          const ext = info.type === 'jpg' ? 'jpg' : info.type;
          pictures.push({ name: `Pictures/img${idx}.${ext}`, data: info.data, mime: `image/${info.type === 'jpg' ? 'jpeg' : info.type}` });
          o += `<draw:frame draw:name="img${idx}" text:anchor-type="as-char" svg:width="${mm(info.w)}" svg:height="${mm(info.h)}"><draw:image xlink:href="Pictures/img${idx}.${ext}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
        }
        continue;
      }
      if (n.classList.contains('footnote-ref')) {
        const k = n.getAttribute('data-fn');
        const fb = body.querySelector(`.footnotes-section .footnote[data-fn="${k}"]`);
        const txt = fb ? (fb.querySelector('.fn-text') || fb).textContent.replace(/^\s*\d+\s*/, '').trim() : '';
        o += `<text:note text:id="ftn${k}" text:note-class="footnote"><text:note-citation>${k}</text:note-citation><text:note-body><text:p text:style-name="Footnote">${esc(txt)}</text:p></text:note-body></text:note>`;
        continue;
      }
      if (n.classList.contains('comment-anchor') && n.getAttribute('data-comment') != null) {
        const id = `__Annotation__${comments.length + 1}`;
        comments.push(id);
        o += `<office:annotation office:name="${id}"><dc:creator>${esc(n.getAttribute('data-author') || 'Author')}</dc:creator><dc:date>${esc((n.getAttribute('data-date') || new Date().toISOString()).slice(0, 19))}</dc:date><text:p>${esc(n.getAttribute('data-comment') || '')}</text:p></office:annotation>${inline(Array.from(n.childNodes), styleOf(n, st))}<office:annotation-end office:name="${id}"/>`;
        continue;
      }
      if (tag === 'a' && /^(https?:|mailto:)/i.test(n.getAttribute('href') || '')) {
        o += `<text:a xlink:type="simple" xlink:href="${escAttr(n.getAttribute('href'))}">${inline(Array.from(n.childNodes), styleOf(n, st))}</text:a>`;
        continue;
      }
      o += inline(Array.from(n.childNodes), styleOf(n, st));
    }
    return o;
  };

  let listCount = 0;
  const paraStyles = new Map();
  const paraStyle = (align, lineH, extra = '') => {
    const key = `${align}|${lineH}|${extra}`;
    if (key === '||') return 'Standard';
    if (paraStyles.has(key)) return paraStyles.get(key);
    const name = `P${paraStyles.size + 1}`;
    paraStyles.set(key, name);
    autoStyles.push(`<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties${align ? ` fo:text-align="${align}"` : ''}${lineH ? ` fo:line-height="${Math.round(lineH * 100)}%"` : ''}${extra}/></style:style>`);
    return name;
  };
  const alignOf = (el) => ({ center: 'center', right: 'end', justify: 'justify', left: 'start' }[(el.style && el.style.textAlign) || el.getAttribute('align')] || '');
  const lineOf = (el) => { const v = parseFloat(el.style && el.style.lineHeight); return v > 0 && v < 10 ? v : 0; };

  const listXml = (list, st) => {
    const ordered = list.tagName.toLowerCase() === 'ol';
    let o = `<text:list text:style-name="${ordered ? 'LNum' : 'LBul'}">`;
    Array.from(list.children).forEach((li) => {
      const kids = Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)));
      o += `<text:list-item><text:p text:style-name="List_20_Contents">${inline(kids, styleOf(li, st))}</text:p>`;
      Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName)).forEach((c) => { o += listXml(c, st); });
      o += '</text:list-item>';
    });
    return `${o}</text:list>`;
  };

  const tableXml = (t, st) => {
    const rows = Array.from(t.rows);
    const g = rows.map(() => []);
    rows.forEach((tr, r) => {
      let c = 0;
      Array.from(tr.cells).forEach((cell) => {
        while (g[r][c]) c++;
        for (let i = 0; i < (cell.rowSpan || 1); i++) for (let j = 0; j < (cell.colSpan || 1); j++) if (g[r + i]) g[r + i][c + j] = { cell, origin: i === 0 && j === 0 };
        c += cell.colSpan || 1;
      });
    });
    const cols = Math.max(1, ...g.map((r) => r.length));
    const tname = `Tbl${autoStyles.length + 1}`;
    autoStyles.push(`<style:style style:name="${tname}" style:family="table"><style:table-properties style:width="${mm((landscape ? pxH : pxW) - 2 * marginPx)}" table:align="margins"/></style:style>`);
    let o = `<table:table table:name="${tname}" table:style-name="${tname}"><table:table-column table:number-columns-repeated="${cols}"/>`;
    g.forEach((row) => {
      o += '<table:table-row>';
      for (let c = 0; c < cols; c++) {
        const slot = row[c];
        if (slot && slot.origin) {
          const fill = hex6(slot.cell.style.backgroundColor);
          const cs = `Cell${autoStyles.length + 1}`;
          autoStyles.push(`<style:style style:name="${cs}" style:family="table-cell"><style:table-cell-properties fo:padding="1.5mm" fo:border="0.5pt solid #cbd5e1"${fill ? ` fo:background-color="${fill}"` : ''}/></style:style>`);
          o += `<table:table-cell table:style-name="${cs}" office:value-type="string"${slot.cell.colSpan > 1 ? ` table:number-columns-spanned="${slot.cell.colSpan}"` : ''}${slot.cell.rowSpan > 1 ? ` table:number-rows-spanned="${slot.cell.rowSpan}"` : ''}><text:p text:style-name="Table_20_Contents">${inline(Array.from(slot.cell.childNodes), styleOf(slot.cell, st))}</text:p></table:table-cell>`;
        } else o += '<table:covered-table-cell/>';
      }
      o += '</table:table-row>';
    });
    return `${o}</table:table>`;
  };

  const blocks = (parent, st) => {
    let o = '';
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const t = inline(buf, st);
      buf = [];
      if (t.trim()) o += `<text:p text:style-name="Text_20_body">${t}</text:p>`;
    };
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === 3) { if (n.nodeValue.trim() || buf.length) buf.push(n); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (!/^(p|div|h[1-6]|ul|ol|table|blockquote|hr|pre)$/.test(tag)) { buf.push(n); continue; }
      flush();
      const cls = n.classList;
      if (cls.contains('footnotes-section')) continue;
      if (cls.contains('page-break')) { o += `<text:p text:style-name="PageBreak"/>`; continue; }
      const s = styleOf(n, st);
      if (/^h[1-3]$/.test(tag)) o += `<text:h text:style-name="Heading_20_${tag[1]}" text:outline-level="${tag[1]}">${inline(Array.from(n.childNodes), s)}</text:h>`;
      else if (/^h[4-6]$/.test(tag)) o += `<text:h text:style-name="Heading_20_3" text:outline-level="${tag[1]}">${inline(Array.from(n.childNodes), s)}</text:h>`;
      else if (tag === 'ul' || tag === 'ol') { listCount++; o += listXml(n, s); }
      else if (tag === 'table') o += tableXml(n, s);
      else if (tag === 'blockquote') o += `<text:p text:style-name="Quotations">${inline(Array.from(n.childNodes), s)}</text:p>`;
      else if (tag === 'hr') o += '<text:p text:style-name="Horizontal_20_Line"/>';
      else if (tag === 'pre') o += `<text:p text:style-name="Preformatted_20_Text">${spacesFix(n.textContent)}</text:p>`;
      else if (cls.contains('toc-container')) {
        n.querySelectorAll('.toc-entry').forEach((p) => { o += `<text:p text:style-name="Text_20_body">${esc((p.querySelector('span') || p).textContent.trim())}<text:tab/>${esc(p.getAttribute('data-page') || '')}</text:p>`; });
      } else if (tag === 'p' || (tag === 'div' && !Array.from(n.children).some((c) => /^(p|div|h[1-6]|ul|ol|table|blockquote)$/i.test(c.tagName)))) {
        const pst = paraStyle(alignOf(n), lineOf(n), cls.contains('callout-box') ? ' fo:background-color="#eff6ff" fo:border-left="2.2pt solid #3b82f6" fo:padding-left="3mm"' : '');
        o += `<text:p text:style-name="${pst}">${inline(Array.from(n.childNodes), s)}</text:p>`;
      } else o += blocks(n, s);
    }
    flush();
    return o;
  };

  const content = blocks(body, {});
  const [w, h] = landscape ? [pxH, pxW] : [pxW, pxH];
  const date = new Date().toISOString().slice(0, 19);
  const ns = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"';

  const bulletLevels = (kind) => [1, 2, 3, 4].map((l) => (kind === 'bul'
    ? `<text:list-level-style-bullet text:level="${l}" text:bullet-char="${['•', '◦', '▪', '•'][l - 1]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${l * 12.7}mm" fo:text-indent="-6.35mm" fo:margin-left="${l * 12.7}mm"/></style:list-level-properties></text:list-level-style-bullet>`
    : `<text:list-level-style-number text:level="${l}" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${l * 12.7}mm" fo:text-indent="-6.35mm" fo:margin-left="${l * 12.7}mm"/></style:list-level-properties></text:list-level-style-number>`)).join('');

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ns} office:version="1.2"><office:automatic-styles>
<style:style style:name="PageBreak" style:family="paragraph"><style:paragraph-properties fo:break-after="page"/></style:style>
${autoStyles.join('\n')}
<text:list-style style:name="LBul">${bulletLevels('bul')}</text:list-style>
<text:list-style style:name="LNum">${bulletLevels('num')}</text:list-style>
</office:automatic-styles><office:body><office:text>${content || '<text:p/>'}</office:text></office:body></office:document-content>`;

  const hdr = opts.header ? `<style:header><text:p text:style-name="Header">${esc(String(opts.header).replace(/\{pages?\}/gi, ''))}</text:p></style:header>` : '';
  const ftr = opts.footer
    ? `<style:footer><text:p text:style-name="Footer">${String(opts.footer).split(/(\{pages?\})/i).map((p) => (/^\{page\}$/i.test(p) ? '<text:page-number text:select-page="current">1</text:page-number>' : /^\{pages\}$/i.test(p) ? '<text:page-count>1</text:page-count>' : esc(p))).join('')}</text:p></style:footer>`
    : '';
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${ns} office:version="1.2">
<office:font-face-decls><style:font-face style:name="Calibri" svg:font-family="Calibri"/></office:font-face-decls>
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:orphans="2" fo:widows="2"/><style:text-properties style:font-name="Calibri" fo:font-size="11pt"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.212cm"/></style:style>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text"><style:paragraph-properties fo:margin-top="0.423cm" fo:margin-bottom="0.212cm" fo:keep-with-next="always"/></style:style>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="1" style:class="text"><style:text-properties fo:font-size="20pt" fo:font-weight="bold" fo:color="#1f3864"/></style:style>
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="2" style:class="text"><style:text-properties fo:font-size="16pt" fo:font-weight="bold" fo:color="#2f5496"/></style:style>
<style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="3" style:class="text"><style:text-properties fo:font-size="13pt" fo:font-weight="bold" fo:color="#1f3763"/></style:style>
<style:style style:name="Quotations" style:display-name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="1cm" fo:margin-top="0.2cm" fo:margin-bottom="0.2cm" fo:border-left="1.5pt solid #2563eb" fo:padding-left="3mm"/><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="List_20_Contents" style:display-name="List Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="list"/>
<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:text-properties style:font-name="Courier New" fo:font-size="10pt"/></style:style>
<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:border-bottom="0.5pt solid #cbd5e1"/></style:style>
<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:text-properties fo:font-size="9pt" fo:color="#6e7887"/></style:style>
<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt" fo:color="#6e7887"/></style:style>
<style:style style:name="Footnote" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:text-properties fo:font-size="9pt"/></style:style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${mm(w)}" fo:page-height="${mm(h)}" style:print-orientation="${landscape ? 'landscape' : 'portrait'}" fo:margin-top="${mm(marginPx)}" fo:margin-bottom="${mm(marginPx)}" fo:margin-left="${mm(marginPx)}" fo:margin-right="${mm(marginPx)}">${ps.columns > 1 ? `<style:columns fo:column-count="${ps.columns}" fo:column-gap="10mm"/>` : ''}</style:page-layout-properties>${opts.header ? '<style:header-style/>' : ''}${opts.footer ? '<style:footer-style/>' : ''}</style:page-layout>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${hdr}${ftr}</style:master-page></office:master-styles>
</office:document-styles>`;

  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${ns} office:version="1.2"><office:meta><dc:title>${esc(title)}</dc:title><meta:initial-creator>${esc(opts.author || 'DocStudio User')}</meta:initial-creator><dc:creator>${esc(opts.author || 'DocStudio User')}</dc:creator><meta:creation-date>${date}</meta:creation-date><dc:date>${date}</dc:date><meta:generator>DocStudio Word Pro</meta:generator></office:meta></office:document-meta>`;

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.name}" manifest:media-type="${p.mime}"/>`).join('\n')}
</manifest:manifest>`;

  const { JSZip } = await loadOffice();
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', contentXml);
  zip.file('styles.xml', stylesXml);
  zip.file('meta.xml', metaXml);
  zip.file('META-INF/manifest.xml', manifest);
  pictures.forEach((p) => zip.file(p.name, p.data));
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.text', compression: 'DEFLATE' });
}

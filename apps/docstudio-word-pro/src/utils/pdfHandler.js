import { loadOffice } from './officeLib';
// pdf.js is stored as plain strings and only evaluated when a PDF is imported, so it costs
// nothing at startup and works offline from file:// (no CDN worker).
import pdfLibSrc from 'pdfjs-dist/build/pdf.min.mjs?raw';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const libUrl = URL.createObjectURL(new Blob([pdfLibSrc], { type: 'text/javascript' }));
      const mod = await import(/* @vite-ignore */ libUrl);
      mod.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([pdfWorkerSrc], { type: 'text/javascript' }));
      return mod;
    })();
  }
  return pdfjsPromise;
}

/* ------------------------------------------------------------------------------------------
 * Word -> PDF: a real text renderer.
 * Every word is placed at the exact position the browser laid it out (via Range rects) and
 * written with jsPDF text(), so the PDF has selectable/searchable text, correct page size,
 * orientation and page breaks, and stays small. Backgrounds, borders, list markers, links
 * and images are drawn as vectors / embedded images. Limits: PDF standard fonts only
 * (Helvetica / Times / Courier); words with symbols outside Latin-1 are drawn as small images.
 * ---------------------------------------------------------------------------------------- */

const PAPER_PT = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };

const parseColor = (str) => {
  const m = /rgba?\(([^)]+)\)/.exec(str || '');
  if (!m) return { r: 0, g: 0, b: 0, a: 0 };
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
};
const blendWhite = (c) => ({
  r: Math.round(c.a * c.r + (1 - c.a) * 255),
  g: Math.round(c.a * c.g + (1 - c.a) * 255),
  b: Math.round(c.a * c.b + (1 - c.a) * 255)
});

const pickFamily = (css) => {
  const f = (css || '').toLowerCase();
  if (/courier|consolas|monospace|mono\b|menlo/.test(f)) return 'courier';
  if (/times|georgia|garamond|serif|cambria|palatino|book/.test(f) && !/sans/.test(f)) return 'times';
  return 'helvetica';
};

// Characters the standard PDF fonts can write directly (WinAnsi subset we trust).
const SAFE_RE = /^[ -~ -ÿ‘’“”–—•…€™]+$/;

function textTransform(txt, tt) {
  if (tt === 'uppercase') return txt.toUpperCase();
  if (tt === 'lowercase') return txt.toLowerCase();
  if (tt === 'capitalize') return txt.replace(/\b\w/g, (c) => c.toUpperCase());
  return txt;
}

function rasterWord(text, w, h, cs, color) {
  const S = 3;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w * S));
  cv.height = Math.max(1, Math.ceil(h * S));
  const ctx = cv.getContext('2d');
  const weight = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold' ? '700 ' : '';
  const italic = /italic|oblique/.test(cs.fontStyle) ? 'italic ' : '';
  ctx.font = `${italic}${weight}${parseFloat(cs.fontSize) * S}px ${cs.fontFamily}`;
  ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 0, cv.height * 0.8);
  return cv.toDataURL('image/png');
}

async function imageForPdf(img) {
  const src = img.currentSrc || img.src;
  const m = /^data:image\/(png|jpe?g);base64,/i.exec(src);
  if (m) return { data: src, fmt: /png/i.test(m[1]) ? 'PNG' : 'JPEG' };
  try {
    if (!img.complete || !img.naturalWidth) await img.decode();
    const maxW = 1600;
    const sc = Math.min(1, maxW / img.naturalWidth);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * sc));
    cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return { data: cv.toDataURL('image/jpeg', 0.88), fmt: 'JPEG' };
  } catch {
    return null;
  }
}

function collectLayout(root) {
  const base = root.getBoundingClientRect();
  const rcs = getComputedStyle(root);
  const padL = parseFloat(rcs.paddingLeft) || 0;
  const padT = parseFloat(rcs.paddingTop) || 0;
  const padR = parseFloat(rcs.paddingRight) || 0;
  const scale = root.offsetWidth ? base.width / root.offsetWidth : 1;
  const ox = base.left + padL * scale;
  const oy = base.top + padT * scale;
  const widthPx = root.clientWidth - padL - padR;
  const R = (r) => ({ x: (r.left - ox) / scale, y: (r.top - oy) / scale, w: r.width / scale, h: r.height / scale });

  const out = { words: [], boxes: [], imgs: [], inks: [], bullets: [], atoms: [], breaks: [], widthPx, bottom: 0 };
  const range = document.createRange();

  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all) {
    if (el.closest('.page-break')) {
      if (el.matches('.page-break')) out.breaks.push(R(el.getBoundingClientRect()).y + R(el.getBoundingClientRect()).h);
      continue;
    }
    if (el.matches('.page-break')) continue;
    const rects = el.getClientRects();
    if (!rects.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const tag = el.tagName;

    if (tag === 'IMG') {
      const r = R(el.getBoundingClientRect());
      if (r.w < 1 || r.h < 1) continue;
      (el.classList.contains('ink-layer') ? out.inks : out.imgs).push({ el, ...r });
      if (!el.classList.contains('ink-layer')) out.atoms.push({ top: r.y, bottom: r.y + r.h });
      out.bottom = Math.max(out.bottom, r.y + r.h);
      continue;
    }

    const bg = parseColor(cs.backgroundColor);
    const hasGrad = /gradient/.test(cs.backgroundImage);
    const inline = cs.display === 'inline';
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => {
      const w = parseFloat(cs[`border${s}Width`]) || 0;
      const col = parseColor(cs[`border${s}Color`]);
      return !inline && w > 0 && cs[`border${s}Style`] !== 'none' && col.a > 0 ? { w, c: blendWhite(col) } : null;
    });
    if (bg.a > 0 || hasGrad || bw.some(Boolean)) {
      const fill = bg.a > 0 ? blendWhite(bg) : hasGrad ? { r: 241, g: 245, b: 249 } : null;
      const list = inline ? Array.from(rects) : [el.getBoundingClientRect()];
      for (const rc of list) {
        const r = R(rc);
        if (r.w >= 0.5 && r.h >= 0.5) out.boxes.push({ ...r, fill, bw: inline ? [null, null, null, null] : bw });
      }
    }
    if (tag === 'TR') {
      const r = R(el.getBoundingClientRect());
      out.atoms.push({ top: r.y, bottom: r.y + r.h });
    }

    if (tag === 'LI' && cs.display === 'list-item' && cs.listStyleType !== 'none') {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tn = null;
      while ((tn = walker.nextNode())) if (tn.nodeValue.trim()) break;
      if (tn) {
        range.selectNodeContents(tn);
        const rc = range.getClientRects()[0];
        if (rc) {
          const parent = el.parentElement;
          let label = null;
          if (parent && parent.tagName === 'OL') {
            const idx = Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(el);
            label = `${(parseInt(parent.getAttribute('start'), 10) || 1) + idx}.`;
          }
          const tcs = getComputedStyle(tn.parentElement);
          out.bullets.push({ ...R(rc), label, kind: cs.listStyleType, cs: tcs, color: blendWhite(parseColor(tcs.color)), left: R(el.getBoundingClientRect()).x });
        }
      }
    }
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.page-break, script, style')) continue;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) continue;
    const cs = getComputedStyle(parent);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const color = blendWhite(parseColor(cs.color));
    const bold = parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold';
    const italic = /italic|oblique/.test(cs.fontStyle);
    const deco = cs.textDecorationLine || '';
    const anchor = parent.closest('a[href]');
    const href = anchor && /^(https?:|mailto:)/i.test(anchor.getAttribute('href')) ? anchor.getAttribute('href') : null;
    const re = /[^\s​]+/g; // U+200B is used internally by Track Changes; never draw it
    let m;
    while ((m = re.exec(raw))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      if (!rects.length) continue;
      const pieces = [];
      if (rects.length === 1) pieces.push({ text: m[0], r: rects[0] });
      else {
        // word wrapped mid-word: place per character
        for (let i = 0; i < m[0].length; i++) {
          range.setStart(node, m.index + i);
          range.setEnd(node, m.index + i + 1);
          const rc = range.getClientRects()[0];
          if (rc && rc.width > 0) pieces.push({ text: m[0][i], r: rc });
        }
      }
      for (const p of pieces) {
        const r = R(p.r);
        out.words.push({
          text: textTransform(p.text, cs.textTransform), ...r, size: parseFloat(cs.fontSize),
          bold, italic, family: pickFamily(cs.fontFamily), color, deco, href, cs
        });
        out.bottom = Math.max(out.bottom, r.y + r.h);
      }
    }
  }

  // Unbreakable "line bands" for pagination.
  const sorted = out.words.slice().sort((a, b) => a.y - b.y);
  let band = null;
  for (const w of sorted) {
    if (band && Math.min(band.bottom, w.y + w.h) - Math.max(band.top, w.y) > 0.5 * w.h) {
      band.bottom = Math.max(band.bottom, w.y + w.h);
    } else {
      band = { top: w.y, bottom: w.y + w.h };
      out.atoms.push(band);
    }
  }
  out.boxes.forEach((b) => { out.bottom = Math.max(out.bottom, b.y + b.h); });
  return out;
}

function computeCuts(layout, H) {
  const atoms = layout.atoms.slice().sort((a, b) => a.top - b.top);
  const breaks = layout.breaks.slice().sort((a, b) => a - b);
  const cuts = [0];
  let start = 0;
  let guard = 0;
  while (start + 1 < layout.bottom && guard++ < 2000) {
    const limit = start + H;
    const fb = breaks.find((y) => y > start + 1 && y <= limit);
    let cut = limit;
    if (fb !== undefined) cut = fb;
    else {
      const s = atoms.find((a) => a.top >= start - 0.5 && a.top < limit - 0.5 && a.bottom > limit + 0.5 && a.bottom - a.top <= H);
      if (s) cut = s.top;
    }
    if (cut <= start + 0.5) cut = limit;
    if (cut >= layout.bottom - 0.5) break;
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

const pageOf = (cuts, y) => {
  let p = 0;
  for (let i = 0; i < cuts.length; i++) if (cuts[i] <= y + 0.01) p = i;
  return p;
};

function resolveTokens(tpl, page, pages) {
  return String(tpl || '').replace(/\{page\}/gi, page).replace(/\{pages\}/gi, pages);
}

/**
 * Build a PDF from a laid-out element.
 * @returns {Promise<jsPDF>}
 */
export async function buildPdf(element, paperSize = 'a4', orientation = 'p', opts = {}) {
  const key = String(paperSize || 'a4').toLowerCase();
  let [pw, ph] = PAPER_PT[key] || PAPER_PT.a4;
  const landscape = orientation === 'l' || orientation === 'landscape';
  if (landscape) [pw, ph] = [ph, pw];
  const { jsPDF } = await loadOffice();
  const pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: landscape ? 'landscape' : 'portrait', compress: true });
  pw = pdf.internal.pageSize.getWidth();
  ph = pdf.internal.pageSize.getHeight();

  const marginPt = (opts.marginPx != null ? opts.marginPx : 48) * 0.75;
  const layout = collectLayout(element);
  const ratio = (pw - 2 * marginPt) / Math.max(1, layout.widthPx);
  const H = (ph - 2 * marginPt) / ratio;
  const cuts = computeCuts(layout, H);
  const pages = cuts.length;
  const pageEnd = (p) => (p + 1 < cuts.length ? cuts[p + 1] : Infinity);

  const imgCache = new Map();
  const loadImg = async (img) => {
    if (!imgCache.has(img)) imgCache.set(img, await imageForPdf(img));
    return imgCache.get(img);
  };
  const preloaded = new Map();
  for (const im of [...layout.imgs, ...layout.inks]) preloaded.set(im, await loadImg(im.el));

  const X = (x) => marginPt + x * ratio;
  const Y = (p, y) => marginPt + (y - cuts[p]) * ratio;

  for (let p = 0; p < pages; p++) {
    if (p > 0) pdf.addPage([pw, ph], landscape ? 'landscape' : 'portrait');
    if (opts.pageColor && opts.pageColor.toLowerCase() !== '#ffffff') {
      const c = /^#?([0-9a-f]{6})$/i.exec(opts.pageColor);
      if (c) {
        const n = parseInt(c[1], 16);
        pdf.setFillColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
        pdf.rect(0, 0, pw, ph, 'F');
      }
    }
    const y0 = cuts[p];
    const y1 = pageEnd(p);

    // 1. box fills and borders (split across the pages they span)
    for (const b of layout.boxes) {
      if (b.y + b.h <= y0 || b.y >= y1) continue;
      const top = Math.max(b.y, y0);
      const bottom = Math.min(b.y + b.h, y1 === Infinity ? b.y + b.h : y1);
      const x = X(b.x);
      const y = Y(p, top);
      const w = b.w * ratio;
      const h = (bottom - top) * ratio;
      if (b.fill) {
        pdf.setFillColor(b.fill.r, b.fill.g, b.fill.b);
        pdf.rect(x, y, w, h, 'F');
      }
      const [bt, br, bb, bl] = b.bw;
      const line = (s, x1, y1_, x2, y2) => {
        pdf.setDrawColor(s.c.r, s.c.g, s.c.b);
        pdf.setLineWidth(Math.max(0.25, s.w * ratio));
        pdf.line(x1, y1_, x2, y2);
      };
      if (bt && b.y >= y0) line(bt, x, y, x + w, y);
      if (bb && b.y + b.h <= y1) line(bb, x, y + h, x + w, y + h);
      if (bl) line(bl, x, y, x, y + h);
      if (br) line(br, x + w, y, x + w, y + h);
    }

    // 2. pictures
    for (const im of layout.imgs) {
      const info = preloaded.get(im);
      if (!info || pageOf(cuts, im.y) !== p) continue;
      try { pdf.addImage(info.data, info.fmt, X(im.x), Y(p, im.y), im.w * ratio, im.h * ratio); } catch { /* skip bad image */ }
    }

    // 3. list markers
    for (const bl of layout.bullets) {
      if (pageOf(cuts, bl.y) !== p) continue;
      const fs = bl.cs ? parseFloat(bl.cs.fontSize) : 14;
      const by = Y(p, bl.y) + bl.h * 0.8 * ratio;
      pdf.setTextColor(bl.color.r, bl.color.g, bl.color.b);
      if (bl.label) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(fs * ratio);
        pdf.text(bl.label, X(bl.x) - 4 * ratio, by, { align: 'right' });
      } else {
        pdf.setFillColor(bl.color.r, bl.color.g, bl.color.b);
        pdf.circle(X(bl.x) - 10 * ratio, by - fs * 0.3 * ratio, Math.max(1.1, fs * 0.13 * ratio), 'F');
      }
    }

    // 4. words
    for (const w of layout.words) {
      if (pageOf(cuts, w.y) !== p) continue;
      const x = X(w.x);
      const baseY = Y(p, w.y) + w.h * 0.8 * ratio;
      const targetW = w.w * ratio;
      if (SAFE_RE.test(w.text)) {
        const style = w.bold && w.italic ? 'bolditalic' : w.bold ? 'bold' : w.italic ? 'italic' : 'normal';
        pdf.setFont(w.family, style);
        let fs = w.size * ratio;
        pdf.setFontSize(fs);
        const natural = pdf.getTextWidth(w.text);
        if (natural > targetW * 1.01) {
          fs = Math.max(fs * 0.7, (fs * targetW) / natural);
          pdf.setFontSize(fs);
        }
        pdf.setTextColor(w.color.r, w.color.g, w.color.b);
        pdf.text(w.text, x, baseY);
      } else {
        try { pdf.addImage(rasterWord(w.text, w.w, w.h, w.cs, w.color), 'PNG', x, Y(p, w.y), targetW, w.h * ratio); } catch { /* ignore */ }
      }
      if (w.deco && w.deco !== 'none') {
        pdf.setDrawColor(w.color.r, w.color.g, w.color.b);
        pdf.setLineWidth(Math.max(0.4, w.size * ratio * 0.06));
        if (/underline/.test(w.deco)) pdf.line(x, baseY + w.size * ratio * 0.12, x + targetW, baseY + w.size * ratio * 0.12);
        if (/line-through/.test(w.deco)) pdf.line(x, baseY - w.size * ratio * 0.28, x + targetW, baseY - w.size * ratio * 0.28);
      }
      if (w.href) pdf.link(x, Y(p, w.y), targetW, w.h * ratio, { url: w.href });
    }

    // 5. ink (drawn on top)
    for (const im of layout.inks) {
      const info = preloaded.get(im);
      if (!info || pageOf(cuts, im.y) !== p) continue;
      try { pdf.addImage(info.data, info.fmt, X(im.x), Y(p, im.y), im.w * ratio, im.h * ratio); } catch { /* ignore */ }
    }

    // 6. header / footer
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(110, 120, 135);
    if (opts.header) pdf.text(resolveTokens(opts.header, p + 1, pages), marginPt, marginPt * 0.55);
    if (opts.footer) pdf.text(resolveTokens(opts.footer, p + 1, pages), pw / 2, ph - marginPt * 0.45, { align: 'center' });
  }
  return pdf;
}

/**
 * Where the PDF will break pages (CSS px from the top of the editor). Used for on-screen page guides
 * and the "Page X of N" status, so what you see is what the PDF does.
 */
export function measurePages(element, pageHeightPx, marginPx) {
  const layout = collectLayout(element);
  return computeCuts(layout, Math.max(100, pageHeightPx - 2 * marginPx));
}

/**
 * Export document element to a PDF file download.
 * @param {HTMLElement} element
 * @param {string} filename
 * @param {string} paperSize - 'a4' | 'letter' | 'legal'
 * @param {string} orientation - 'p' | 'l'
 * @param {{marginPx?: number, header?: string, footer?: string, pageColor?: string}} opts
 */
export async function exportToPdf(element, filename = 'Document', paperSize = 'a4', orientation = 'p', opts = {}) {
  if (!element) return;
  const pdf = await buildPdf(element, paperSize, orientation, opts);
  pdf.save(`${filename.replace(/\s+/g, '_')}.pdf`);
}

/* ------------------------------------------------------------------------------------------
 * PDF -> Word: extract text with pdf.js and rebuild paragraphs, headings and lists.
 * ---------------------------------------------------------------------------------------- */

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

function buildLines(items) {
  const its = items
    .filter((i) => typeof i.str === 'string' && i.str.trim() !== '')
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.height || i.transform[3] || 10) }));
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, 0.45 * Math.min(last.h, it.h))) {
      last.items.push(it);
      last.h = Math.max(last.h, it.h);
    } else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let text = '';
    ln.items.forEach((it, i) => {
      if (i > 0) {
        const prev = ln.items[i - 1];
        const gap = it.x - (prev.x + prev.w);
        // real word gaps measure ~0.15-0.35 em; letter-spacing/kerning splits stay well below 0.08 em
        if (gap > 0.08 * ln.h && gap > 0.6 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
    });
    ln.text = text.replace(/\s+/g, ' ').trim();
    ln.x = ln.items[0].x;
  }
  return lines.filter((l) => l.text);
}

/**
 * Extract text and layout from a PDF using Mozilla's open-source pdf.js
 * @param {File} file
 * @returns {Promise<{html: string, pageCount: number}>}
 */
export async function convertPdfToHtml(file) {
  const pdfjsLib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const numPages = pdf.numPages;
  let fullHtml = '';

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lines = buildLines(textContent.items);
    const heights = lines.map((l) => l.h).sort((a, b) => a - b);
    const median = heights.length ? heights[Math.floor(heights.length / 2)] : 10;

    let html = '';
    let para = null;
    let list = null; // {tag, items}
    const flushPara = () => { if (para) { html += `<p>${escapeHtml(para.text)}</p>`; para = null; } };
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</${list.tag}>`; list = null; } };

    let prev = null;
    for (const ln of lines) {
      const ratio = ln.h / median;
      const bullet = /^[•◦▪▫●○■□\-–*]\s+(.*)$/.exec(ln.text);
      const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(ln.text);
      if (ratio >= 1.45 || ratio >= 1.2 && ln.text.length < 90) {
        flushPara(); flushList();
        const tag = ratio >= 1.45 ? 'h1' : 'h2';
        html += `<${tag}>${escapeHtml(ln.text)}</${tag}>`;
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || numbered)[1]);
      } else {
        const gap = prev ? prev.y - ln.y : 0;
        const newPara = !para || gap > prev.h * 1.9 || list;
        flushList();
        if (newPara) { flushPara(); para = { text: ln.text }; }
        else para.text += ` ${ln.text}`;
      }
      prev = ln;
    }
    flushPara(); flushList();

    fullHtml += html || '<p><br></p>';
    if (pageNum < numPages) fullHtml += '<div class="page-break"></div>';
  }

  return { html: fullHtml, pageCount: numPages };
}

/**
 * Call the optional high-fidelity local Python conversion backend if running
 */
export async function convertPdfToDocxBackend(file) {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('http://localhost:5005/api/pdf-to-docx', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const blob = await response.blob();
      return { success: true, blob };
    }
    return { success: false, error: 'Server error' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

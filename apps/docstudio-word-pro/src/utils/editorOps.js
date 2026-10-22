// Editing helpers shared by the ribbon. Anything that rewrites existing DOM goes through
// document.execCommand('insertHTML') so the browser's undo/redo stack still works.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

export const uid = (p = 'c') => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

export function selectionInside(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return editor.contains(r.commonAncestorContainer) ? r : null;
}

const closest = (node, sel, root) => {
  let n = node && node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== root) {
    if (n.matches && n.matches(sel)) return n;
    n = n.parentNode;
  }
  return null;
};
export { closest };

/** Vertical position of an element inside the editor, in unscaled CSS px. */
export function docY(el, editor) {
  const er = editor.getBoundingClientRect();
  const scale = editor.offsetWidth ? er.width / editor.offsetWidth : 1;
  return (el.getBoundingClientRect().top - er.top) / scale;
}

/** Replace `node` with `html` (one undo step). Returns the new element (first element of html). */
export function replaceNode(editor, node, html) {
  const sel = window.getSelection();
  editor.focus();
  const r = document.createRange();
  r.selectNode(node);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('insertHTML', false, html);
  const fresh = editor.querySelector('[data-ds-sel]');
  if (fresh) fresh.removeAttribute('data-ds-sel');
  return fresh;
}

/* ---------- font size (points) ---------- */
export function applyFontSize(editor, pt) {
  const r = selectionInside(editor);
  if (!r || r.collapsed) return false;
  const frag = r.cloneContents();
  frag.querySelectorAll('[style]').forEach((el) => { el.style.fontSize = ''; });
  frag.querySelectorAll('font[size]').forEach((el) => el.removeAttribute('size'));
  const box = document.createElement('div');
  box.appendChild(frag);
  document.execCommand('insertHTML', false, `<span style="font-size:${pt}pt">${box.innerHTML}</span>`);
  return true;
}

/* ---------- line spacing ---------- */
export function applyLineSpacing(editor, value) {
  const r = selectionInside(editor);
  if (!r) return false;
  const blocks = Array.from(editor.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,div:not(.callout-box):not(.footnotes-section):not(.toc-container)'))
    .filter((b) => r.intersectsNode(b) && !Array.from(b.children).some((c) => /^(P|H[1-6]|LI|DIV|UL|OL|TABLE)$/.test(c.tagName)));
  blocks.forEach((b) => { b.style.lineHeight = value; });
  return blocks.length > 0;
}

/* ---------- table of contents ---------- */
const tocEntryHtml = (text, level, page) =>
  `<p class="toc-entry" data-level="${level}" data-page="${page}" style="display:flex;align-items:baseline;margin:4px 0;padding-left:${(level - 1) * 18}px"><span>${esc(text)}</span><span style="flex:1;border-bottom:1px dotted #94a3b8;margin:0 6px"></span><span class="toc-page">${page}</span></p>`;

function tocEntries(editor, contentH) {
  const heads = Array.from(editor.querySelectorAll('h1,h2,h3')).filter((h) => !h.closest('.toc-container') && h.textContent.trim());
  return heads.map((h) => ({
    text: h.textContent.trim(),
    level: Number(h.tagName[1]),
    page: Math.floor(docY(h, editor) / contentH) + 1
  }));
}

export function insertToc(editor, contentH) {
  const entries = tocEntries(editor, contentH);
  const body = entries.length
    ? entries.map((e) => tocEntryHtml(e.text, e.level, e.page)).join('')
    : '<p class="toc-empty" style="color:#64748b;font-style:italic">No headings yet. Apply Heading 1-3 styles, then click Update Table.</p>';
  const html = `<div class="toc-container" contenteditable="true" style="background:#f8fafc;border:1px solid #cbd5e1;padding:16px;border-radius:6px;margin:20px 0;"><h3 class="toc-title" style="font-size:14pt;font-weight:700;color:#1e293b;margin:0 0 12px;border-bottom:1.5px solid #cbd5e1;padding-bottom:4px;">Table of Contents</h3>${body}</div><p><br></p>`;
  editor.focus();
  document.execCommand('insertHTML', false, html);
  updateToc(editor, contentH);
  return entries.length;
}

/** Rebuild every TOC from the current headings (page numbers come from layout position). */
export function updateToc(editor, contentH) {
  const tocs = Array.from(editor.querySelectorAll('.toc-container'));
  if (!tocs.length) return 0;
  const entries = tocEntries(editor, contentH);
  tocs.forEach((toc) => {
    toc.querySelectorAll('.toc-entry, .toc-empty').forEach((p) => p.remove());
    const holder = document.createElement('div');
    holder.innerHTML = entries.length ? entries.map((e) => tocEntryHtml(e.text, e.level, e.page)).join('') : '<p class="toc-empty">No headings found.</p>';
    while (holder.firstChild) toc.appendChild(holder.firstChild);
  });
  // Second pass: the TOC itself moved the headings, so refresh the numbers once.
  const again = tocEntries(editor, contentH);
  tocs.forEach((toc) => {
    toc.querySelectorAll('.toc-entry').forEach((p, i) => {
      if (!again[i]) return;
      p.setAttribute('data-page', String(again[i].page));
      const pg = p.querySelector('.toc-page');
      if (pg) pg.textContent = String(again[i].page);
    });
  });
  return entries.length;
}

/* ---------- footnotes ---------- */
export function insertFootnote(editor) {
  const nums = Array.from(editor.querySelectorAll('.footnote-ref')).map((e) => parseInt(e.getAttribute('data-fn'), 10) || 0);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  editor.focus();
  // Chrome's insertHTML flattens a <sup>/<span> carrying inheritable text styles into an anonymous style span and
  // drops its class and data attributes; an <a> is kept intact, so the reference is an href-less anchor.
  document.execCommand('insertHTML', false, `<a class="footnote-ref" data-fn="${n}">[${n}]</a>`);
  let section = editor.querySelector('.footnotes-section');
  if (!section) {
    section = document.createElement('div');
    section.className = 'footnotes-section';
    editor.appendChild(section);
  }
  const p = document.createElement('p');
  p.className = 'footnote';
  p.setAttribute('data-fn', String(n));
  p.innerHTML = `<sup>${n}</sup> <span class="fn-text">Footnote text</span>`;
  section.appendChild(p);
  const span = p.querySelector('.fn-text');
  const r = document.createRange();
  r.selectNodeContents(span);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  p.scrollIntoView({ block: 'nearest' });
  return n;
}

/* ---------- citations ---------- */
export function citationText(style, editor) {
  const year = new Date().getFullYear();
  switch (style) {
    case 'MLA': return '(Author 45)';
    case 'Chicago': return `(Author ${year}, 45)`;
    case 'Harvard': return `(Author ${year}, p. 45)`;
    case 'IEEE': {
      const n = editor.querySelectorAll('.citation[data-style="IEEE"]').length + 1;
      return `[${n}]`;
    }
    default: return `(Author, ${year})`;
  }
}

export function insertCitation(editor, style) {
  editor.focus();
  document.execCommand('insertHTML', false, `<span class="citation" data-style="${escAttr(style)}">${esc(citationText(style, editor))}</span>&nbsp;`);
}

/* ---------- comments ---------- */
export function addComment(editor, author) {
  const r = selectionInside(editor);
  if (!r || r.collapsed) return { ok: false, reason: 'Select some text first, then add a comment.' };
  const startBlock = closest(r.startContainer, 'p,h1,h2,h3,li,td,th,blockquote,div', editor) || editor;
  const endBlock = closest(r.endContainer, 'p,h1,h2,h3,li,td,th,blockquote,div', editor) || editor;
  if (startBlock !== endBlock) return { ok: false, reason: 'Comments attach to text within one paragraph.' };
  const frag = r.cloneContents();
  const box = document.createElement('div');
  box.appendChild(frag);
  const id = uid('cm');
  editor.focus();
  document.execCommand(
    'insertHTML',
    false,
    `<span class="comment-anchor" data-cid="${id}" data-comment="" data-author="${escAttr(author)}" data-date="${new Date().toISOString()}">${box.innerHTML}</span>`
  );
  return { ok: true, id };
}

export const listComments = (editor) => Array.from(editor.querySelectorAll('.comment-anchor'));

export function removeComment(el) {
  while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
  el.remove();
}

/* ---------- pictures ---------- */
export function setImageWrap(editor, img, mode) {
  const clone = img.cloneNode(true);
  clone.removeAttribute('class');
  const s = clone.style;
  s.float = '';
  s.display = '';
  s.margin = '';
  if (mode === 'left') { s.float = 'left'; s.margin = '4px 16px 8px 0'; }
  else if (mode === 'right') { s.float = 'right'; s.margin = '4px 0 8px 16px'; }
  else if (mode === 'center') { s.display = 'block'; s.margin = '8px auto'; }
  else s.display = 'inline-block';
  clone.setAttribute('data-wrap', mode);
  clone.setAttribute('data-ds-sel', '1');
  return replaceNode(editor, img, clone.outerHTML);
}

export function setImageWidth(img, widthPx) {
  img.style.width = `${Math.max(16, Math.round(widthPx))}px`;
  img.style.height = 'auto';
  img.style.maxWidth = '100%';
}

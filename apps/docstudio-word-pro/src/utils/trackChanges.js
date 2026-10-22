// Track Changes: typed text is wrapped in <ins>, deleted text in <del>.
// Every edit goes through document.execCommand('insertHTML'|'delete') so the browser's native
// undo/redo stack keeps working (one undo step per tracked edit).

let counter = 0;
const newId = () => `tc${Date.now().toString(36)}${(counter++).toString(36)}`;
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

const attrs = (cls, id, author) =>
  `class="${cls}" data-tc-id="${id}" data-author="${escAttr(author)}" data-date="${new Date().toISOString()}"`;

// Chrome's insertHTML flattens an inserted <ins>/<del> into an anonymous style span when it is the only/leading
// content of the fragment. A trailing zero-width space keeps the real element (exporters strip U+200B).
const ZW = '​';

const placeAfter = (el) => {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStartAfter(el);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
};

const insHtml = (author, inner, id = newId()) => `<ins ${attrs('tc-ins', id, author)}>${inner}</ins>`;

const closestEl = (node, sel, root) => {
  let n = node && node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== root) {
    if (n.matches && n.matches(sel)) return n;
    n = n.parentNode;
  }
  return null;
};

/** If the caret sits right after an <ins> (or inside one) return that <ins> and move the caret to its end. */
function adoptAdjacentIns(range, editor) {
  let ins = closestEl(range.startContainer, 'ins.tc-ins', editor);
  if (!ins) {
    const { startContainer: c, startOffset: o } = range;
    let prev = null;
    if (c.nodeType === 3 && o === 0) prev = c.previousSibling;
    else if (c.nodeType === 1 && o > 0) prev = c.childNodes[o - 1];
    if (prev && prev.nodeType === 1 && prev.matches('ins.tc-ins')) ins = prev;
  }
  if (!ins) return null;
  if (!ins.contains(range.startContainer)) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(ins);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return ins;
}

const BLOCKY_PARENTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL', 'COLGROUP']);

/** Rewrite a cloned fragment: text becomes <del>, <ins> is dropped (really deleted). Returns {changed, structural}. */
function transformFragment(frag, author, id) {
  let changed = false;
  let structural = false;
  const walk = (parent) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) {
        const txt = node.nodeValue;
        if (!txt) continue;
        const wrap = txt.trim() !== '' || !BLOCKY_PARENTS.has(parent.nodeName);
        if (!wrap || (txt.trim() === '' && /\n/.test(txt))) continue;
        const del = document.createElement('del');
        del.className = 'tc-del';
        del.setAttribute('data-tc-id', id);
        del.setAttribute('data-author', author);
        del.setAttribute('data-date', new Date().toISOString());
        node.replaceWith(del);
        del.appendChild(node);
        changed = true;
      } else if (node.nodeType === 1) {
        const tag = node.nodeName;
        if (tag === 'INS' && node.classList.contains('tc-ins')) { node.remove(); changed = true; continue; }
        if (tag === 'DEL' && node.classList.contains('tc-del')) continue;
        if (tag === 'TD' || tag === 'TH' || tag === 'TR') structural = true;
        if (node.getAttribute('contenteditable') === 'false') continue;
        walk(node);
      }
    }
  };
  walk(frag);
  return { changed, structural };
}

function markDeleted(editor, range, author, backward) {
  const sel = window.getSelection();
  const frag = range.cloneContents();
  const id = newId();
  const { changed, structural } = transformFragment(frag, author, id);
  if (structural) return false; // table-structure deletes fall back to the browser
  sel.removeAllRanges();
  sel.addRange(range);
  if (!changed) {
    // Everything selected is already deleted text: just move the caret across it.
    const r = range.cloneRange();
    r.collapse(backward);
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }
  const box = document.createElement('div');
  box.appendChild(frag);
  const html = box.innerHTML;
  if (html.trim() === '') document.execCommand('delete');
  else document.execCommand('insertHTML', false, html + ZW);
  const dels = editor.querySelectorAll(`del[data-tc-id="${id}"]`);
  if (backward) {
    const first = dels[0];
    if (first && first.parentNode) {
      const r = document.createRange();
      r.setStart(first.parentNode, Array.prototype.indexOf.call(first.parentNode.childNodes, first));
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } else if (dels.length) placeAfter(dels[dels.length - 1]);
  return true;
}

/** Call from the editor's native `beforeinput` listener while tracking is ON. */
let reentrant = false;

export function handleTrackedBeforeInput(e, editor, author) {
  if (reentrant) return;
  const type = e.inputType;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  if (type.startsWith('delete')) {
    const tr = e.getTargetRanges && e.getTargetRanges()[0];
    let range;
    if (tr) {
      range = document.createRange();
      range.setStart(tr.startContainer, tr.startOffset);
      range.setEnd(tr.endContainer, tr.endOffset);
    } else range = sel.getRangeAt(0).cloneRange();
    if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return;
    if (!range.toString().replace(/[​\n]/g, '')) return; // paragraph merge etc: native
    const backward = /Backward/.test(type);
    // Probe first so a structural fallback can still run natively.
    const probe = range.cloneContents();
    if (probe.querySelector('td,th,tr')) return;
    e.preventDefault();
    markDeleted(editor, range, author, backward);
    return;
  }

  if (type === 'insertText' || type === 'insertFromPaste') {
    let data = e.data;
    if (type === 'insertFromPaste') data = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
    if (data == null || data === '') return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    trackedReplaceSelection(editor, data, author);
  }
}

/**
 * Replace the current selection with `data` as a tracked change (old text -> <del>, new text -> <ins>).
 * Used by the beforeinput hook and directly by Find & Replace (execCommand() does not fire beforeinput).
 */
export function trackedReplaceSelection(editor, data, author) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  let range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return false;
  if (!range.collapsed) {
    const probe = range.cloneContents();
    if (probe.querySelector('td,th,tr')) { document.execCommand('insertText', false, data); return true; }
    markDeleted(editor, range.cloneRange(), author, false);
    range = sel.getRangeAt(0);
  }
  if (!data) return true;
  // Caret inside a deleted run: step out after it first.
  const delEl = closestEl(range.startContainer, 'del.tc-del', editor);
  if (delEl) {
    const r = document.createRange();
    r.setStartAfter(delEl);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const ins = adoptAdjacentIns(sel.getRangeAt(0), editor);
  if (ins) {
    reentrant = true; // the nested command re-fires beforeinput; let it type natively inside the <ins>
    try {
      document.execCommand('insertText', false, data);
    } finally {
      reentrant = false;
    }
    return true;
  }
  const html = data
    .split(/\r?\n/)
    .map((line) => escHtml(line).replace(/ {2}/g, ' &nbsp;'))
    .join('<br>');
  const id = newId();
  document.execCommand('insertHTML', false, insHtml(author, data === ' ' ? '&nbsp;' : html, id) + ZW);
  const fresh = editor.querySelector(`ins[data-tc-id="${id}"]`);
  if (fresh) placeAfter(fresh); // caret sits between the <ins> and the ZW char so further typing joins it
  return true;
}

export const listChanges = (editor) => Array.from(editor.querySelectorAll('ins.tc-ins, del.tc-del'));

export function changeGroups(editor) {
  const ids = [];
  listChanges(editor).forEach((el) => {
    const id = el.getAttribute('data-tc-id') || '';
    if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

const keepsText = (el, accept) => (el.tagName === 'INS') === accept;

/** Accept/reject every element that shares `id` (one undo step per element). */
export function resolveChange(editor, id, accept) {
  const els = listChanges(editor).filter((el) => el.getAttribute('data-tc-id') === id).reverse();
  const sel = window.getSelection();
  editor.focus();
  els.forEach((el) => {
    const r = document.createRange();
    r.selectNode(el);
    sel.removeAllRanges();
    sel.addRange(r);
    if (keepsText(el, accept) && el.innerHTML) document.execCommand('insertHTML', false, el.innerHTML.replace(/​/g, ''));
    else document.execCommand('delete');
  });
}

/** Accept/reject the whole document in a single undo step. */
export function resolveAll(editor, accept) {
  const clone = editor.cloneNode(true);
  Array.from(clone.querySelectorAll('ins.tc-ins, del.tc-del')).forEach((el) => {
    if (keepsText(el, accept)) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    }
    el.remove();
  });
  const sel = window.getSelection();
  editor.focus();
  const r = document.createRange();
  r.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand('insertHTML', false, clone.innerHTML.replace(/​/g, ''));
}

/** Select + scroll to the next/previous tracked change relative to the caret. */
export function gotoChange(editor, dir) {
  const els = listChanges(editor);
  if (!els.length) return null;
  const sel = window.getSelection();
  const cur = sel.rangeCount ? sel.getRangeAt(0) : null;
  let target = null;
  if (cur) {
    if (dir > 0) target = els.find((el) => cur.comparePoint(el, 0) > 0 || (cur.comparePoint(el, 0) === 0 && !cur.intersectsNode(el)));
    else target = [...els].reverse().find((el) => cur.comparePoint(el, 0) < 0 && !cur.intersectsNode(el));
  }
  if (!target) target = dir > 0 ? els[0] : els[els.length - 1];
  const r = document.createRange();
  r.selectNode(target);
  sel.removeAllRanges();
  sel.addRange(r);
  target.scrollIntoView({ block: 'center' });
  return target;
}

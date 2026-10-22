import React, { useState } from 'react';
import { X, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { trackedReplaceSelection } from '../utils/trackChanges';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** All matches of `text` in the editor's visible text (deleted tracked text is skipped). */
function findRanges(editor, text, matchCase) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(escapeRegex(text), matchCase ? 'g' : 'gi');
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('del.tc-del, .footnote-ref') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  let node;
  while ((node = walker.nextNode())) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(node.nodeValue))) {
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      out.push(r);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

export default function FindReplaceBar({ isOpen, onClose, editorRef, onChange, tracking, author }) {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [status, setStatus] = useState('');

  if (!isOpen) return null;

  // With Track Changes on, a replacement is recorded as <del> + <ins> instead of silently overwriting.
  const replaceSelected = (ed) => {
    if (tracking) { trackedReplaceSelection(ed, replaceText, author); return; }
    if (replaceText) document.execCommand('insertText', false, replaceText);
    else document.execCommand('delete');
  };

  const select = (r) => {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const el = r.startContainer.parentElement;
    if (el) el.scrollIntoView({ block: 'center' });
  };

  const handleFind = (dir = 1) => {
    const ed = editorRef.current;
    if (!findText || !ed) return;
    const ranges = findRanges(ed, findText, matchCase);
    setStatus(`${ranges.length} match${ranges.length === 1 ? '' : 'es'}`);
    if (!ranges.length) return;
    const sel = window.getSelection();
    const cur = sel.rangeCount && ed.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    let target;
    if (cur) {
      target = dir > 0
        ? ranges.find((r) => r.compareBoundaryPoints(Range.START_TO_START, cur) > 0 || (cur.collapsed && r.compareBoundaryPoints(Range.START_TO_START, cur) >= 0))
        : [...ranges].reverse().find((r) => r.compareBoundaryPoints(Range.START_TO_START, cur) < 0);
    }
    select(target || (dir > 0 ? ranges[0] : ranges[ranges.length - 1]));
  };

  const replaceCurrent = () => {
    const ed = editorRef.current;
    if (!ed || !findText) return;
    const sel = window.getSelection();
    const hit = sel.rangeCount && ed.contains(sel.anchorNode)
      && (matchCase ? sel.toString() === findText : sel.toString().toLowerCase() === findText.toLowerCase());
    if (hit) {
      ed.focus();
      replaceSelected(ed);
      onChange && onChange();
    }
    handleFind(1);
  };

  // Each replacement is a normal editing command, so it is undoable and honours Track Changes.
  const replaceAll = () => {
    const ed = editorRef.current;
    if (!ed || !findText) return;
    const ranges = findRanges(ed, findText, matchCase);
    ed.focus();
    for (let i = ranges.length - 1; i >= 0; i--) {
      select(ranges[i]);
      replaceSelected(ed);
    }
    setStatus(`Replaced ${ranges.length}`);
    onChange && onChange();
  };

  return (
    <div className="absolute top-28 right-8 z-30 bg-white rounded-lg shadow-xl border border-slate-200 p-3 w-80 text-xs no-print">
      <div className="flex items-center justify-between pb-2 border-b border-slate-100">
        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
          <Search className="w-3.5 h-3.5 text-blue-600" />
          Find & Replace
        </span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-2.5 space-y-2">
        <div className="flex items-center space-x-1.5">
          <input
            type="text"
            placeholder="Find text..."
            value={findText}
            onChange={(e) => { setFindText(e.target.value); setStatus(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleFind(e.shiftKey ? -1 : 1)}
            className="flex-1 border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500"
          />
          <button onClick={() => handleFind(-1)} className="p-1 hover:bg-slate-100 rounded text-slate-600 border border-slate-200" title="Previous Match">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => handleFind(1)} className="p-1 hover:bg-slate-100 rounded text-slate-600 border border-slate-200" title="Next Match">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        <input
          type="text"
          placeholder="Replace with..."
          value={replaceText}
          onChange={(e) => setReplaceText(e.target.value)}
          className="w-full border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500"
        />

        <div className="flex items-center justify-between pt-1">
          <label className="flex items-center gap-1 text-slate-600 cursor-pointer">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
          </label>
          <span className="text-slate-500">{status}</span>
        </div>

        <div className="flex justify-end space-x-2">
          <button onClick={replaceCurrent} className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium transition" title="Replace">
            Replace
          </button>
          <button onClick={replaceAll} className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium transition" title="Replace All">
            Replace All
          </button>
        </div>
      </div>
    </div>
  );
}

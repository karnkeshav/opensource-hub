import React, { useEffect, useState } from 'react';
import { X, Trash2, Check } from 'lucide-react';
import { listComments, removeComment } from '../utils/editorOps';

/** Side panel listing every comment anchor in the document. Comments live in the DOM (data-comment). */
export default function CommentsPanel({ open, onClose, editorRef, tick, onChange }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!open || !editorRef.current) return;
    setItems(listComments(editorRef.current));
  }, [open, tick, editorRef]);

  if (!open) return null;

  const refresh = () => { setItems(listComments(editorRef.current)); onChange && onChange(); };

  return (
    <aside className="no-print w-72 shrink-0 border-l border-slate-300 bg-white overflow-y-auto text-xs" aria-label="Comments">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 sticky top-0 bg-white">
        <span className="font-semibold text-slate-800">Comments ({items.length})</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close"><X className="w-4 h-4" /></button>
      </div>
      {items.length === 0 && <p className="p-3 text-slate-500">Select text, then choose Review &gt; New Comment.</p>}
      {items.map((el) => {
        const resolved = el.classList.contains('resolved');
        return (
          <div key={el.getAttribute('data-cid')} className={`m-2 p-2 rounded border ${resolved ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-amber-300 bg-amber-50'}`}>
            <div className="text-[10px] text-slate-500 mb-1">
              {el.getAttribute('data-author')} · {new Date(el.getAttribute('data-date')).toLocaleString()}
            </div>
            <button
              className="block text-left text-slate-700 italic truncate w-full mb-1"
              onClick={() => { el.scrollIntoView({ block: 'center' }); }}
              title="Go to text"
            >
              “{el.textContent.slice(0, 60)}”
            </button>
            <textarea
              value={el.getAttribute('data-comment') || ''}
              placeholder="Write a comment..."
              onChange={(e) => { el.setAttribute('data-comment', e.target.value); refresh(); }}
              className="w-full border border-slate-300 rounded p-1 outline-none focus:border-blue-500 bg-white"
              rows={2}
            />
            <div className="flex justify-end gap-1 mt-1">
              <button
                onClick={() => { el.classList.toggle('resolved'); refresh(); }}
                className="px-2 py-0.5 border border-slate-300 rounded flex items-center gap-1 hover:bg-white"
                title="Resolve"
              >
                <Check className="w-3 h-3" /> {resolved ? 'Reopen' : 'Resolve'}
              </button>
              <button
                onClick={() => { removeComment(el); refresh(); }}
                className="px-2 py-0.5 border border-slate-300 rounded flex items-center gap-1 hover:bg-white text-red-700"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

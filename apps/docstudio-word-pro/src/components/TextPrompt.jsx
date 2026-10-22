import React, { useEffect, useState } from 'react';

/** Tiny in-page replacement for window.prompt(): { title, value, placeholder, resolve } */
export default function TextPrompt({ dialog, onClose }) {
  const [value, setValue] = useState('');
  useEffect(() => { if (dialog) setValue(dialog.value || ''); }, [dialog]);
  if (!dialog) return null;
  const finish = (v) => { dialog.resolve(v); onClose(); };
  return (
    <div className="no-print fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onMouseDown={() => finish(null)}>
      <div className="bg-white rounded-lg shadow-xl border border-slate-200 p-4 w-96" onMouseDown={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-slate-800 mb-2">{dialog.title}</div>
        <input
          autoFocus
          value={value}
          placeholder={dialog.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') finish(value.trim() || null); if (e.key === 'Escape') finish(null); }}
          className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={() => finish(null)} className="px-3 py-1 text-xs border border-slate-300 rounded">Cancel</button>
          <button onClick={() => finish(value.trim() || null)} className="px-3 py-1 text-xs bg-blue-600 text-white rounded font-semibold">OK</button>
        </div>
      </div>
    </div>
  );
}

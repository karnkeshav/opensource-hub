import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import DrawLayer from './DrawLayer';

export const PAPER_PX = { a4: [794, 1123], letter: [816, 1056], legal: [816, 1344] };
export const MARGIN_PX = { narrow: 48, normal: 96, wide: 144 };

/** One-line header/footer field: shows tokens resolved when idle, raw tokens while editing. */
function HeaderFooterLine({ value, onChange, placeholder, align, pages, className, style }) {
  const [focus, setFocus] = useState(false);
  const resolved = String(value || '').replace(/\{page\}/gi, '1').replace(/\{pages\}/gi, String(pages));
  return (
    <input
      type="text"
      value={focus ? value : resolved}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      title="Click to edit. Use {page} and {pages} for page numbers."
      className={`bg-transparent outline-none text-[11px] text-slate-500 placeholder:text-slate-300 focus:bg-blue-50 rounded px-1 ${className || ''}`}
      style={{ textAlign: align, ...style }}
    />
  );
}

export default function EditorCanvas({
  editorRef,
  content,
  onContentChange,
  onBeforeInput,
  pageSetup,
  zoom,
  viewMode,
  showRuler,
  showGridlines,
  trackChanges,
  documentTitle,
  readOnly,
  spellCheck,
  showMarks,
  header,
  footer,
  setHeader,
  setFooter,
  pageCuts,
  selectedImg,
  onSelectImg,
  drawTool,
  drawColor,
  drawSize,
  drawApiRef,
  tick
}) {
  const rulerTicks = Array.from({ length: 17 }, (_, i) => i);
  const wrapRef = useRef(null);
  const [handle, setHandle] = useState(null);

  const [paperW, paperH] = PAPER_PX[pageSetup.paperSize] || PAPER_PX.a4;
  const landscape = pageSetup.orientation === 'landscape';
  const width = landscape ? paperH : paperW;
  const minHeight = landscape ? paperW : paperH;
  const padding = viewMode === 'page' ? MARGIN_PX[pageSetup.margins] || 96 : 48;
  const cols = Math.min(3, Math.max(1, pageSetup.columns || 1));
  const pages = pageCuts ? pageCuts.length : 1;

  // Keep the picture handle on the selected image.
  useLayoutEffect(() => {
    if (!selectedImg || !selectedImg.isConnected || !wrapRef.current) { setHandle(null); return; }
    const wr = wrapRef.current.getBoundingClientRect();
    const ir = selectedImg.getBoundingClientRect();
    const scale = wrapRef.current.offsetWidth ? wr.width / wrapRef.current.offsetWidth : 1;
    setHandle({ x: (ir.right - wr.left) / scale - 6, y: (ir.bottom - wr.top) / scale - 6 });
  }, [selectedImg, tick, zoom, pageSetup, viewMode]);

  useEffect(() => {
    document.querySelectorAll('.document-content img.img-selected').forEach((i) => { i.style.outline = ''; i.classList.remove('img-selected'); });
    if (selectedImg && selectedImg.isConnected) {
      selectedImg.classList.add('img-selected');
      selectedImg.style.outline = '2px solid #2563eb';
    }
  }, [selectedImg, tick]);

  const startResize = (e) => {
    if (!selectedImg) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = selectedImg.getBoundingClientRect().width / (zoom / 100);
    const move = (ev) => {
      const w = Math.max(24, startW + (ev.clientX - startX) / (zoom / 100));
      selectedImg.style.width = `${Math.round(w)}px`;
      selectedImg.style.height = 'auto';
      selectedImg.style.maxWidth = '100%';
      onContentChange && onContentChange();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onEditorClick = (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && !t.classList.contains('ink-layer')) onSelectImg(t);
    else if (selectedImg) onSelectImg(null);
  };

  return (
    <div className="flex-1 overflow-auto bg-[#eef1f5] flex flex-col items-center relative selection:bg-blue-200">

      {/* Horizontal Ruler Bar */}
      {showRuler && (
        <div
          className="sticky top-0 z-10 bg-white border-b border-slate-300 flex items-end h-6 text-[9px] text-slate-500 font-mono no-print shadow-xs shrink-0"
          style={{ width: `${width}px` }}
        >
          <div className="w-full flex justify-between px-2">
            {rulerTicks.map((tick) => (
              <div key={tick} className="flex flex-col items-center">
                <span className="text-[8px]">{tick}</span>
                <div className="h-1.5 w-[1px] bg-slate-300"></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Track Changes banner (outside the sheet so it never shifts the page layout) */}
      {trackChanges && (
        <div className="mt-2 px-3 py-1.5 bg-amber-50 border border-amber-300 rounded text-amber-900 text-xs flex items-center gap-1.5 select-none no-print shrink-0">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
          <span className="font-medium">Track Changes is ON: typed text and deletions are marked. Use Review to accept or reject.</span>
        </div>
      )}

      {/* Main Container Scaled by Zoom */}
      <div
        className="page-container py-8 flex flex-col items-center w-full transition-transform duration-75"
        style={{
          transform: `scale(${zoom / 100})`,
          transformOrigin: 'top center',
          marginBottom: zoom > 100 ? `${(zoom - 100) * 10}px` : '0px'
        }}
      >
        {/* Physical Sheet Container */}
        <div
          id="printable-document"
          className={`word-page bg-white relative transition-all duration-200 text-slate-800 ${
            viewMode === 'page' ? 'rounded-xs border border-slate-300' : 'w-full max-w-4xl min-h-screen'
          }`}
          style={{
            width: viewMode === 'page' ? `${width}px` : '100%',
            minHeight: viewMode === 'page' ? `${minHeight}px` : 'auto',
            padding: `${padding}px`,
            backgroundColor: pageSetup.pageColor || '#ffffff',
            color: pageSetup.pageColor === '#1e293b' ? '#f8fafc' : '#1e293b',
            backgroundImage: showGridlines
              ? 'linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)'
              : 'none',
            backgroundSize: showGridlines ? '24px 24px' : 'auto'
          }}
          onClick={onEditorClick}
        >
          {/* Running Header */}
          {viewMode === 'page' && (
            <div className="absolute left-0 right-0 flex items-center no-print" style={{ top: `${Math.max(6, padding * 0.32)}px`, padding: `0 ${padding}px` }}>
              <HeaderFooterLine value={header} onChange={setHeader} placeholder="Header (click to type)" align="left" pages={pages} className="w-full" />
            </div>
          )}

          <div ref={wrapRef} className="relative">
            {/* Editable Document Content */}
            <div
              ref={editorRef}
              contentEditable={!readOnly}
              suppressContentEditableWarning={true}
              spellCheck={spellCheck}
              onInput={onContentChange}
              onBeforeInput={onBeforeInput}
              className={`document-content font-calibri text-[11pt] leading-[1.5] min-h-[700px] outline-none ${cols > 1 ? `cols-${cols}` : ''} ${showMarks ? 'show-marks' : ''}`}
              dangerouslySetInnerHTML={{ __html: content }}
            />

            {/* Page guides: exactly where the PDF breaks pages */}
            {viewMode === 'page' && pageCuts && pageCuts.slice(1).map((cut, i) => (
              <div
                key={cut}
                className="absolute left-0 right-0 pointer-events-none no-print border-t border-dashed border-slate-300"
                style={{ top: `${cut}px`, marginLeft: `-${padding}px`, marginRight: `-${padding}px` }}
              >
                <span className="absolute right-2 -top-2.5 bg-white px-1 text-[10px] text-slate-400">Page {i + 2}</span>
              </div>
            ))}

            {drawTool && (
              <DrawLayer editorRef={editorRef} tool={drawTool} color={drawColor} size={drawSize} apiRef={drawApiRef} />
            )}

            {handle && !drawTool && (
              <div className="img-handle no-print" style={{ left: handle.x, top: handle.y }} onPointerDown={startResize} title="Drag to resize" />
            )}
          </div>

          {/* Running Footer */}
          {viewMode === 'page' && (
            <div className="absolute left-0 right-0 flex items-center no-print" style={{ bottom: `${Math.max(6, padding * 0.32)}px`, padding: `0 ${padding}px` }}>
              <HeaderFooterLine value={footer} onChange={setFooter} placeholder="Footer (click to type)" align="center" pages={pages} className="w-full" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useEffect, useRef } from 'react';

const S = 2; // canvas pixels per CSS pixel (crisp ink without huge files)

/**
 * Canvas overlay for freehand ink. While a draw tool is active the existing ink image is loaded
 * into the canvas; leaving the Draw tab (or pressing Done) flattens the canvas back into ONE cropped
 * transparent PNG (<img class="ink-layer">) inside the document, so ink is saved, printed and exported.
 */
export default function DrawLayer({ editorRef, tool, color, size, apiRef, onStroke }) {
  const canvasRef = useRef(null);
  const st = useRef({ drawing: false, pts: [], base: null, bbox: null, history: [], hidden: null });
  const props = useRef({ tool, color, size });
  props.current = { tool, color, size };

  // Build / tear down the canvas for the whole time a tool is active.
  useEffect(() => {
    const editor = editorRef.current;
    const canvas = canvasRef.current;
    if (!editor || !canvas) return undefined;
    const w = editor.offsetWidth;
    const h = Math.max(editor.scrollHeight, editor.offsetHeight);
    canvas.width = Math.round(w * S);
    canvas.height = Math.round(h * S);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    st.current.bbox = null;
    st.current.history = [];

    const existing = editor.querySelector('img.ink-layer');
    if (existing) {
      const x = parseFloat(existing.style.left) || 0;
      const y = parseFloat(existing.style.top) || 0;
      const iw = parseFloat(existing.style.width) || existing.naturalWidth / S;
      const ih = parseFloat(existing.style.height) || existing.naturalHeight / S;
      try { ctx.drawImage(existing, x * S, y * S, iw * S, ih * S); } catch { /* ignore */ }
      st.current.bbox = { x0: x, y0: y, x1: x + iw, y1: y + ih };
      existing.style.display = 'none';
      st.current.hidden = existing;
    }

    const commit = () => {
      const ed = editorRef.current;
      if (!ed) return;
      const old = ed.querySelector('img.ink-layer');
      const bb = st.current.bbox;
      if (!bb) { if (old) old.remove(); return; }
      const x0 = Math.max(0, Math.floor(bb.x0 * S));
      const y0 = Math.max(0, Math.floor(bb.y0 * S));
      const x1 = Math.min(canvas.width, Math.ceil(bb.x1 * S));
      const y1 = Math.min(canvas.height, Math.ceil(bb.y1 * S));
      if (x1 <= x0 || y1 <= y0) { if (old) old.remove(); return; }
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let any = false;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) { any = true; break; }
      if (!any) { if (old) old.remove(); return; }
      const crop = document.createElement('canvas');
      crop.width = x1 - x0;
      crop.height = y1 - y0;
      crop.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      const img = document.createElement('img');
      img.className = 'ink-layer';
      img.setAttribute('data-ink', '1');
      img.setAttribute('contenteditable', 'false');
      img.alt = 'Ink drawing';
      img.src = crop.toDataURL('image/png');
      img.style.left = `${x0 / S}px`;
      img.style.top = `${y0 / S}px`;
      img.style.width = `${(x1 - x0) / S}px`;
      img.style.height = `${(y1 - y0) / S}px`;
      if (old) old.remove();
      ed.insertBefore(img, ed.firstChild);
    };

    apiRef.current = {
      commit,
      clear() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        st.current.bbox = null;
        st.current.history = [];
      },
      undo() {
        const prev = st.current.history.pop();
        if (prev) { ctx.putImageData(prev.img, 0, 0); st.current.bbox = prev.bbox; }
      },
      get hasInk() { return !!st.current.bbox; }
    };

    return () => {
      commit();
      apiRef.current = null;
      if (st.current.hidden && st.current.hidden.isConnected) st.current.hidden.style.display = '';
      st.current.hidden = null;
    };
  }, [editorRef, apiRef]);

  const pos = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * (c.width / S), y: ((e.clientY - r.top) / r.height) * (c.height / S) };
  };

  const grow = (x, y, pad) => {
    const bb = st.current.bbox;
    if (!bb) st.current.bbox = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
    else {
      bb.x0 = Math.min(bb.x0, x - pad); bb.y0 = Math.min(bb.y0, y - pad);
      bb.x1 = Math.max(bb.x1, x + pad); bb.y1 = Math.max(bb.y1, y + pad);
    }
  };

  const style = () => {
    const { tool: t, color: c, size: sz } = props.current;
    if (t === 'highlighter') return { color: c, width: sz * 4, alpha: 0.35, op: 'source-over' };
    if (t === 'eraser') return { color: '#000', width: sz * 4, alpha: 1, op: 'destination-out' };
    return { color: c, width: sz, alpha: 1, op: 'source-over' };
  };

  const strokePath = (ctx, pts, s, tool) => {
    ctx.save();
    ctx.globalCompositeOperation = s.op;
    ctx.globalAlpha = s.alpha;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * S;
    ctx.lineCap = tool === 'highlighter' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.fillStyle = s.color;
      ctx.arc(pts[0].x * S, pts[0].y * S, (s.width * S) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(pts[0].x * S, pts[0].y * S);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x * S, pts[i].y * S, mx * S, my * S);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x * S, last.y * S);
      ctx.stroke();
    }
    ctx.restore();
  };

  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const c = canvasRef.current;
    const ctx = c.getContext('2d');
    try { c.setPointerCapture(e.pointerId); } catch { /* synthetic / unsupported pointer: carry on */ }
    const t = props.current.tool;
    const s = st.current;
    s.history.push({ img: ctx.getImageData(0, 0, c.width, c.height), bbox: s.bbox ? { ...s.bbox } : null });
    if (s.history.length > 15) s.history.shift();
    s.drawing = true;
    s.pts = [pos(e)];
    if (t === 'highlighter' || t === 'line') {
      s.base = document.createElement('canvas');
      s.base.width = c.width;
      s.base.height = c.height;
      s.base.getContext('2d').drawImage(c, 0, 0);
    }
    if (t !== 'line') strokePath(ctx, s.pts, style(), t);
    if (t !== 'eraser') grow(s.pts[0].x, s.pts[0].y, style().width);
  };

  const move = (e) => {
    const s = st.current;
    if (!s.drawing) return;
    const c = canvasRef.current;
    const ctx = c.getContext('2d');
    const t = props.current.tool;
    const p = pos(e);
    const sty = style();
    if (t === 'line') {
      s.pts = [s.pts[0], p];
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(s.base, 0, 0);
      strokePath(ctx, s.pts, sty, t);
    } else if (t === 'highlighter') {
      s.pts.push(p);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(s.base, 0, 0);
      strokePath(ctx, s.pts, sty, t);
    } else {
      const prev = s.pts[s.pts.length - 1];
      s.pts.push(p);
      strokePath(ctx, [prev, p], sty, t);
    }
    if (t !== 'eraser') grow(p.x, p.y, sty.width);
  };

  const up = (e) => {
    const s = st.current;
    if (!s.drawing) return;
    s.drawing = false;
    s.base = null;
    try { canvasRef.current.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (onStroke) onStroke();
  };

  return (
    <canvas
      ref={canvasRef}
      data-draw-layer="1"
      className="absolute left-0 top-0 z-10 no-print"
      style={{ touchAction: 'none', cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Ribbon from './components/Ribbon';
import EditorCanvas, { PAPER_PX, MARGIN_PX } from './components/EditorCanvas';
import ConversionModal from './components/ConversionModal';
import FindReplaceBar from './components/FindReplaceBar';
import CommentsPanel from './components/CommentsPanel';
import TextPrompt from './components/TextPrompt';
import { importDocxFile } from './utils/docxHandler';
import { convertPdfToHtml, measurePages } from './utils/pdfHandler';
import { handleTrackedBeforeInput, trackedReplaceSelection, resolveChange, resolveAll, gotoChange, changeGroups } from './utils/trackChanges';
import { parseCsv, fieldChipHtml, showRecord, showFields, buildCombinedHtml } from './utils/mailMerge';
import {
  applyFontSize, applyLineSpacing, insertToc, updateToc, insertFootnote, insertCitation, addComment,
  setImageWrap, setImageWidth, selectionInside
} from './utils/editorOps';
import { applyTableOp, currentCell } from './utils/tableOps';
import { startSpeech, stopSpeech, isSpeaking } from './utils/speech';
import { FORMATS, fsaSupported, makeBlob, writeBlob, safeName, recovery } from './utils/saveManager';

const INITIAL_SAMPLE_CONTENT = `
<h1 style="font-size: 26pt; font-weight: 700; color: #1e3a8a; margin-bottom: 8px;">Executive Project Summary & Strategy</h1>
<p style="font-size: 13pt; color: #64748b; font-style: italic; margin-bottom: 24px;">Autonomous Document Engine • Built with 100% Open-Source Technology</p>

<div class="callout-box">
  <strong>Key Architecture Highlight:</strong> This application is fully standalone and operates entirely offline. It provides native <strong>Word (.docx) &harr; PDF</strong> bidirectional conversions without requiring Microsoft Office or Adobe integrations.
</div>

<h2 style="font-size: 18pt; font-weight: 600; color: #1e40af; margin-top: 24px; margin-bottom: 12px;">1. Project Overview & Scope</h2>
<p style="margin-bottom: 14px; line-height: 1.6;">
  Modern organizations require resilient, open-source office suites that eliminate costly recurring licensing fees and enterprise vendor lock-in. DocStudio Word Pro is engineered to provide full formatting fidelity, WYSIWYG pagination, and zero-compromise file interoperability.
</p>

<h2 style="font-size: 18pt; font-weight: 600; color: #1e40af; margin-top: 24px; margin-bottom: 12px;">2. Conversion & Performance Matrix</h2>
<table style="width: 100%; border-collapse: collapse; margin-top: 12px; margin-bottom: 18px;">
  <thead>
    <tr style="background-color: #f1f5f9;">
      <th style="border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-weight: 600;">Feature Module</th>
      <th style="border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-weight: 600;">Open-Source Engine</th>
      <th style="border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-weight: 600;">External Office Needed?</th>
      <th style="border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-weight: 600;">Status</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="border: 1px solid #cbd5e1; padding: 10px;"><strong>Word to PDF</strong></td>
      <td style="border: 1px solid #cbd5e1; padding: 10px;">jsPDF text renderer (selectable text)</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669; font-weight: 600;">No (Standalone)</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669;">Active & Verified</td>
    </tr>
    <tr style="background-color: #f8fafc;">
      <td style="border: 1px solid #cbd5e1; padding: 10px;"><strong>PDF to Word (.docx)</strong></td>
      <td style="border: 1px solid #cbd5e1; padding: 10px;">Mozilla PDF.js text extraction</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669; font-weight: 600;">No (Zero Adobe)</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669;">Active & Verified</td>
    </tr>
    <tr>
      <td style="border: 1px solid #cbd5e1; padding: 10px;"><strong>DOCX Live Editor</strong></td>
      <td style="border: 1px solid #cbd5e1; padding: 10px;">OpenXML Parser + Mammoth JS</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669; font-weight: 600;">No (Direct In-Memory)</td>
      <td style="border: 1px solid #cbd5e1; padding: 10px; color: #059669;">Active & Verified</td>
    </tr>
  </tbody>
</table>

<h2 style="font-size: 18pt; font-weight: 600; color: #1e40af; margin-top: 24px; margin-bottom: 12px;">3. Core Capabilities</h2>
<ul style="list-style-type: disc; padding-left: 24px; margin-bottom: 18px; line-height: 1.8;">
  <li><strong>Word-Style Ribbon Toolbar:</strong> Complete with File, Home, Insert, Layout, Review, View, and Convert tabs.</li>
  <li><strong>Real-time Document Intelligence:</strong> Live word count, character statistics, reading velocity, and Find & Replace.</li>
  <li><strong>Physical A4 Sheet Simulation:</strong> Authentic print preview, margin indicators, and page dimensions.</li>
  <li><strong>Distributable Package:</strong> Self-contained executable or web deployment that works out of the box for anyone.</li>
</ul>

<p style="margin-top: 24px; color: #475569; font-size: 10.5pt;">
  <em>Double-click anywhere to begin editing or open any existing .docx or .pdf from the top Ribbon bar.</em>
</p>
`;

const DEFAULT_FOOTER = 'Page {page} of {pages}';
const AUTHOR = 'DocStudio User';

/** Editor HTML without editor-only decoration (selection outline, handles). */
function cleanHtml(editor) {
  const clone = editor.cloneNode(true);
  clone.querySelectorAll('img.img-selected').forEach((i) => {
    i.classList.remove('img-selected');
    i.style.outline = '';
    if (!i.getAttribute('class')) i.removeAttribute('class');
    if (!i.getAttribute('style')) i.removeAttribute('style');
  });
  return clone.innerHTML;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('Home');
  const [documentTitle, setDocumentTitle] = useState('Executive Project Strategy');
  const [content, setContent] = useState(INITIAL_SAMPLE_CONTENT);
  const [pageSetup, setPageSetup] = useState({
    margins: 'normal',
    orientation: 'portrait',
    paperSize: 'a4',
    pageColor: '#ffffff',
    columns: 1
  });
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState(DEFAULT_FOOTER);
  const [zoom, setZoom] = useState(100);
  const [viewMode, setViewMode] = useState('page');
  const [showRuler, setShowRuler] = useState(true);
  const [showGridlines, setShowGridlines] = useState(false);
  const [showMarks, setShowMarks] = useState(false);
  const [spellCheck, setSpellCheck] = useState(true);
  const [trackChanges, setTrackChanges] = useState(false);
  const [author] = useState(AUTHOR);
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [tick, setTick] = useState(0);
  const [stats, setStats] = useState({ words: 0, characters: 0, readingTime: 1 });
  const [pageCuts, setPageCuts] = useState([0]);
  const [currentPage, setCurrentPage] = useState(1);
  const [inTable, setInTable] = useState(false);
  const [selectedImg, setSelectedImg] = useState(null);
  const [drawTool, setDrawTool] = useState(null);
  const [drawColor, setDrawColor] = useState('#1d4ed8');
  const [drawSize, setDrawSize] = useState(3);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState('');
  const [promptDlg, setPromptDlg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [docMeta, setDocMeta] = useState({ format: 'docx', handle: null, fileName: '', lastSaved: null });
  const [recoveryOffer, setRecoveryOffer] = useState(null);
  const [merge, setMerge] = useState({ data: null, idx: 0, previewing: false, template: null });
  const [changeCount, setChangeCount] = useState(0);

  const editorRef = useRef(null);
  const drawApiRef = useRef(null);
  const savedRange = useRef(null);
  const noticeTimer = useRef(null);

  // Latest values for handlers bound once (keyboard, beforeunload, native listeners).
  const S = useRef({});
  S.current = { documentTitle, pageSetup, header, footer, docMeta, trackChanges, author, merge, dirty, viewMode };
  const cutsRef = useRef([0]);
  cutsRef.current = pageCuts;

  const notify = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4500);
  }, []);

  const askText = useCallback((title, value = '', placeholder = '') =>
    new Promise((resolve) => setPromptDlg({ title, value, placeholder, resolve })), []);

  const paperDims = () => {
    const { paperSize, orientation, margins } = S.current.pageSetup;
    const [w, h] = PAPER_PX[paperSize] || PAPER_PX.a4;
    return { pageH: orientation === 'landscape' ? w : h, marginPx: S.current.viewMode === 'page' ? MARGIN_PX[margins] || 96 : 48 };
  };

  /* ---------------- stats, dirty tracking, layout measurement ---------------- */
  const updateStats = () => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    setStats({ words, characters: text.length, readingTime: Math.max(1, Math.ceil(words / 200)) });
    setChangeCount(changeGroups(editorRef.current).length);
  };

  const onContentChange = () => {
    updateStats();
    setDirty(true);
    setTick((t) => t + 1);
  };

  useEffect(() => { updateStats(); }, [content]);

  // Page guides + "Page X of N" come from the same layout pass the PDF exporter uses.
  useEffect(() => {
    const id = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      if (viewMode !== 'page') { setPageCuts([0]); return; }
      const { pageH, marginPx } = paperDims();
      try { setPageCuts(measurePages(ed, pageH, marginPx)); } catch { setPageCuts([0]); }
    }, 350);
    return () => clearTimeout(id);
  }, [tick, pageSetup, viewMode, content, zoom]);

  // Selection-driven context (in table? current page?)
  useEffect(() => {
    const onSel = () => {
      const ed = editorRef.current;
      if (!ed) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
        savedRange.current = sel.getRangeAt(0).cloneRange();
        setInTable(!!currentCell(ed));
        try {
          const rc = sel.getRangeAt(0).getBoundingClientRect();
          const er = ed.getBoundingClientRect();
          const scale = ed.offsetWidth ? er.width / ed.offsetWidth : 1;
          if (rc.height || rc.top) {
            const y = (rc.top - er.top) / scale;
            let p = 1;
            cutsRef.current.forEach((c, i) => { if (c <= y + 1) p = i + 1; });
            setCurrentPage(p);
          }
        } catch { /* ignore */ }
      } else setInTable(false);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  /* ---------------- track changes: native beforeinput ---------------- */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return undefined;
    const handler = (e) => {
      const { trackChanges: tc, author: au, merge: m } = S.current;
      if (!tc || m.previewing) return;
      handleTrackedBeforeInput(e, ed, au);
    };
    ed.addEventListener('beforeinput', handler);
    return () => ed.removeEventListener('beforeinput', handler);
  }, []);

  /* ---------------- formatting commands ---------------- */
  const focusEditor = () => {
    const ed = editorRef.current;
    if (!ed) return false;
    const sel = window.getSelection();
    if (!(sel.rangeCount && ed.contains(sel.anchorNode)) && savedRange.current) {
      ed.focus();
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    } else ed.focus();
    return true;
  };

  const formatDoc = (cmd, value = null) => {
    if (!focusEditor()) return;
    const tracking = S.current.trackChanges && !S.current.merge.previewing;
    if (cmd === 'fontSize') {
      if (!applyFontSize(editorRef.current, value)) notify('Select some text first to change its size.');
    } else if (tracking && cmd === 'insertText') {
      // execCommand does not fire beforeinput, so tracked edits from toolbar buttons are applied explicitly
      trackedReplaceSelection(editorRef.current, value, S.current.author);
    } else if (tracking && cmd === 'cut') {
      document.execCommand('copy');
      trackedReplaceSelection(editorRef.current, '', S.current.author);
    } else document.execCommand(cmd, false, value);
    onContentChange();
  };

  const setBlockStyle = (style) => {
    if (!focusEditor()) return;
    if (style === 'title') {
      document.execCommand('formatBlock', false, '<h1>');
      const sel = window.getSelection();
      let n = sel.anchorNode;
      while (n && n !== editorRef.current && !(n.nodeType === 1 && n.tagName === 'H1')) n = n.parentNode;
      if (n && n.tagName === 'H1') { n.classList.add('title'); n.style.fontSize = '28pt'; n.style.fontWeight = '400'; }
    } else {
      document.execCommand('formatBlock', false, style === 'normal' ? '<p>' : `<${style}>`);
      const sel = window.getSelection();
      let n = sel.anchorNode;
      while (n && n !== editorRef.current && !(n.nodeType === 1 && /^(H[1-3]|P|BLOCKQUOTE)$/.test(n.tagName))) n = n.parentNode;
      if (n && n.nodeType === 1) { n.classList.remove('title'); if (/^H/.test(n.tagName)) { n.style.fontSize = ''; n.style.fontWeight = ''; } }
    }
    onContentChange();
  };

  const insertTable = (rows = 3, cols = 3) => {
    let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin: 16px 0;"><thead><tr>';
    for (let c = 0; c < cols; c++) {
      tableHtml += `<th style="border: 1px solid #cbd5e1; padding: 8px 12px; background-color: #f8fafc;">Header ${c + 1}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      tableHtml += '<tr>';
      for (let c = 0; c < cols; c++) {
        tableHtml += `<td style="border: 1px solid #cbd5e1; padding: 8px 12px;">Cell ${r + 1},${c + 1}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table><p><br></p>';
    formatDoc('insertHTML', tableHtml);
  };

  const insertImage = (src) => {
    formatDoc('insertHTML', `<p><img src="${src}" alt="Inserted Image" style="max-width: 100%; height: auto; border-radius: 4px; border: 1px solid #e2e8f0; margin: 12px 0;" /></p><p><br></p>`);
  };

  const insertPageBreak = () => formatDoc('insertHTML', '<div class="page-break"></div><p><br></p>');

  const insertCallout = () => formatDoc('insertHTML', '<div class="callout-box"><strong>Important Note:</strong> Insert your key takeaway or executive announcement here.</div><p><br></p>');

  const insertDateTime = () => {
    const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    formatDoc('insertText', now);
  };

  const insertLink = async () => {
    const range = savedRange.current ? savedRange.current.cloneRange() : null;
    const url = await askText('Insert hyperlink', 'https://', 'https://example.com');
    if (!url) return;
    if (range) {
      editorRef.current.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const sel = window.getSelection();
    if (sel && sel.isCollapsed) formatDoc('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
    else formatDoc('createLink', url);
  };

  const insertCoverPage = () => {
    const safeTitle = (documentTitle || 'Document Title').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    formatDoc('insertHTML', `
      <div class="cover-page" style="padding: 48px 36px; min-height: 720px; border-left: 8px solid #1e40af; background-color: #f1f5f9; border-radius: 4px; margin-bottom: 32px;">
        <span style="font-size: 11pt; font-weight: 700; color: #2563eb; text-transform: uppercase; letter-spacing: 2px;">Executive Document</span>
        <h1 style="font-size: 32pt; font-weight: 800; color: #0f172a; margin-top: 16px; margin-bottom: 8px; line-height: 1.15;">${safeTitle}</h1>
        <p style="font-size: 15pt; color: #475569; font-style: italic;">Professional Office Document &amp; Specification</p>
        <p style="margin-top: 200px; font-size: 11pt; color: #1e293b;"><strong>Author:</strong> ${AUTHOR}</p>
        <p style="font-size: 11pt; color: #1e293b;"><strong>Date:</strong> ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
      </div><div class="page-break"></div><p><br></p>`);
  };

  /* ---------------- references ---------------- */
  const contentH = () => { const { pageH, marginPx } = paperDims(); return pageH - 2 * marginPx; };
  const doInsertToc = () => { if (!focusEditor()) return; const n = insertToc(editorRef.current, contentH()); notify(n ? `Table of contents built from ${n} heading${n > 1 ? 's' : ''}.` : 'No headings found. Apply Heading 1-3, then Update Table.'); onContentChange(); };
  const doUpdateToc = () => { const n = updateToc(editorRef.current, contentH()); notify(n ? 'Table of contents updated.' : 'No table of contents (or headings) to update.'); onContentChange(); };
  const doInsertFootnote = () => { if (!focusEditor()) return; const n = insertFootnote(editorRef.current); notify(`Footnote ${n} added. Type its text at the bottom of the page.`); onContentChange(); };
  const doInsertCitation = (style) => { if (!focusEditor()) return; insertCitation(editorRef.current, style); onContentChange(); };

  /* ---------------- review ---------------- */
  const doAddComment = () => {
    const res = addComment(editorRef.current, author);
    if (!res.ok) { notify(res.reason); return; }
    setShowComments(true);
    onContentChange();
  };
  const doResolveAll = (accept) => { resolveAll(editorRef.current, accept); notify(accept ? 'All changes accepted.' : 'All changes rejected.'); onContentChange(); };
  const doResolveNext = (accept) => {
    const ed = editorRef.current;
    const target = gotoChange(ed, 1);
    if (!target) { notify('No tracked changes.'); return; }
    resolveChange(ed, target.getAttribute('data-tc-id'), accept);
    onContentChange();
  };
  const doGotoChange = (dir) => { if (!gotoChange(editorRef.current, dir)) notify('No tracked changes.'); };

  const toggleSpeech = async () => {
    if (isSpeaking()) { stopSpeech(); setSpeaking(false); return; }
    const ed = editorRef.current;
    const r = selectionInside(ed);
    const text = r && !r.collapsed ? r.toString() : ed.innerText;
    if (!text.trim()) { notify('Nothing to read.'); return; }
    try {
      setSpeaking(true);
      await startSpeech(text, () => setSpeaking(false));
    } catch (err) { setSpeaking(false); notify(err.message); }
  };

  /* ---------------- pictures ---------------- */
  const pictureOp = (op, arg) => {
    const ed = editorRef.current;
    if (!selectedImg || !selectedImg.isConnected) return;
    if (op === 'wrap') {
      const fresh = setImageWrap(ed, selectedImg, arg);
      if (fresh) setSelectedImg(fresh);
    } else if (op === 'width') setImageWidth(selectedImg, arg);
    else if (op === 'alt') selectedImg.setAttribute('alt', arg);
    else if (op === 'delete') {
      const r = document.createRange();
      r.selectNode(selectedImg);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      ed.focus();
      document.execCommand('delete');
      setSelectedImg(null);
    }
    onContentChange();
  };

  const tableOp = (op, arg) => {
    if (!applyTableOp(editorRef.current, op, arg)) notify('That table action is not possible here.');
    onContentChange();
  };

  const setLineSpacing = (v) => { if (!focusEditor()) return; applyLineSpacing(editorRef.current, v); onContentChange(); };

  /* ---------------- drawing ---------------- */
  useEffect(() => { if (activeTab !== 'Draw' && drawTool) setDrawTool(null); }, [activeTab, drawTool]);
  const drawDone = () => { setDrawTool(null); onContentChange(); };

  /* ---------------- mail merge ---------------- */
  const loadRecipients = async (file) => {
    try {
      const text = await file.text();
      const data = parseCsv(text);
      if (!data.headers.length || !data.rows.length) { notify('That CSV has no data rows.'); return; }
      setMerge((m) => ({ ...m, data: { ...data, fileName: file.name }, idx: 0 }));
      notify(`Loaded ${data.rows.length} recipient${data.rows.length > 1 ? 's' : ''} with ${data.headers.length} field${data.headers.length > 1 ? 's' : ''} from ${file.name}.`);
    } catch (err) { notify(`Could not read the recipients file: ${err.message}`); }
  };
  const insertMergeField = (name) => { if (!focusEditor()) return; document.execCommand('insertHTML', false, fieldChipHtml(name)); onContentChange(); };
  const setPreview = (on, idx = merge.idx) => {
    const ed = editorRef.current;
    if (!merge.data) { notify('Choose recipients (CSV) first.'); return; }
    if (on) showRecord(ed, merge.data.rows[idx]); else showFields(ed);
    setMerge((m) => ({ ...m, previewing: on, idx }));
    setTick((t) => t + 1);
  };
  const gotoRecord = (idx) => {
    const n = merge.data ? merge.data.rows.length : 0;
    if (!n) return;
    const i = Math.min(n - 1, Math.max(0, idx));
    if (merge.previewing) showRecord(editorRef.current, merge.data.rows[i]);
    setMerge((m) => ({ ...m, idx: i }));
  };
  const finishMerge = async (mode) => {
    const ed = editorRef.current;
    if (!merge.data) { notify('Choose recipients (CSV) first.'); return; }
    const template = merge.template || cleanHtml(ed);
    const combined = buildCombinedHtml(template, merge.data.rows);
    if (mode === 'edit') {
      ed.innerHTML = combined;
      setContent(combined);
      setMerge((m) => ({ ...m, previewing: false, template }));
      setDirty(true);
      notify(`Created a merged document with ${merge.data.rows.length} letters. Use "Restore template" to go back.`);
      setTick((t) => t + 1);
    } else {
      try {
        const blob = await makeBlob('docx', { html: combined, title: `${documentTitle} - merged`, pageSetup, header, footer, author });
        const res = await writeBlob(blob, { format: 'docx', forcePicker: true, suggestedName: `${documentTitle} - merged` });
        if (res) notify(`Merged document saved as ${res.name}.`);
      } catch (err) { notify(`Merge export failed: ${err.message}`); }
    }
  };
  const restoreTemplate = () => {
    if (!merge.template) return;
    editorRef.current.innerHTML = merge.template;
    setContent(merge.template);
    setMerge((m) => ({ ...m, template: null, previewing: false }));
    setTick((t) => t + 1);
  };

  /* ---------------- documents: new / open ---------------- */
  const loadHtmlIntoEditor = (html, title) => {
    setContent(html);
    if (title != null) setDocumentTitle(title);
    if (editorRef.current) editorRef.current.innerHTML = html;
    setSelectedImg(null);
    setMerge({ data: null, idx: 0, previewing: false, template: null });
    updateStats();
    setTick((t) => t + 1);
  };

  const handleNewDocument = () => {
    if (S.current.dirty && !window.confirm('Discard unsaved changes and start a new document?')) return;
    loadHtmlIntoEditor('<p><br></p>', 'Untitled Document');
    setHeader('');
    setFooter(DEFAULT_FOOTER);
    setPageSetup((p) => ({ ...p, columns: 1 }));
    setDocMeta({ format: 'docx', handle: null, fileName: '', lastSaved: null });
    setDirty(false);
    recovery.clear();
    setStats({ words: 0, characters: 0, readingTime: 1 });
    setActiveTab('Home');
    if (editorRef.current) editorRef.current.focus();
  };

  const handleLoadTemplate = () => {
    loadHtmlIntoEditor(INITIAL_SAMPLE_CONTENT, 'Executive Project Strategy');
    setDocMeta({ format: 'docx', handle: null, fileName: '', lastSaved: null });
    setDirty(false);
    setActiveTab('Home');
  };

  const applyImported = (res, file, handle) => {
    loadHtmlIntoEditor(res.html, file.name.replace(/\.[^/.]+$/, ''));
    if (res.header != null) setHeader(res.header);
    if (res.footer != null) setFooter(res.footer);
    if (res.pageSetup) setPageSetup((p) => ({ ...p, ...res.pageSetup }));
    setDocMeta({ format: 'docx', handle: handle || null, fileName: file.name, lastSaved: handle ? Date.now() : null });
    setDirty(false);
    recovery.clear();
  };

  const openFile = async (file, handle = null) => {
    setIsConverting(true);
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith('.docx')) {
        applyImported(await importDocxFile(file), file, handle);
      } else if (name.endsWith('.pdf')) {
        const { html, pageCount } = await convertPdfToHtml(file);
        loadHtmlIntoEditor(html, file.name.replace(/\.[^/.]+$/, ''));
        setDocMeta({ format: 'docx', handle: null, fileName: '', lastSaved: null });
        setDirty(true);
        notify(`Extracted ${pageCount} page${pageCount > 1 ? 's' : ''} from "${file.name}" into editable text. Save As .docx to keep it.`);
      } else if (/\.(html?|txt)$/.test(name)) {
        const text = await file.text();
        let html;
        if (/\.html?$/.test(name)) {
          const d = new DOMParser().parseFromString(text, 'text/html');
          d.querySelectorAll('script,iframe,object,embed,link,meta,style').forEach((e) => e.remove());
          d.querySelectorAll('*').forEach((e) => Array.from(e.attributes).forEach((a) => { if (/^on/i.test(a.name) || /^javascript:/i.test(a.value)) e.removeAttribute(a.name); }));
          const page = d.querySelector('.page');
          html = (page || d.body).innerHTML;
        } else html = text.split(/\r?\n/).map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '<br>'}</p>`).join('');
        loadHtmlIntoEditor(html, file.name.replace(/\.[^/.]+$/, ''));
        setDocMeta({ format: 'docx', handle: null, fileName: '', lastSaved: null });
        setDirty(true);
      } else notify('Unsupported file type. Open .docx, .pdf, .html or .txt.');
    } catch (err) {
      notify(`Could not open "${file.name}": ${err.message}`);
    } finally {
      setIsConverting(false);
    }
  };

  const openDocument = async () => {
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: 'Documents', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'], 'application/pdf': ['.pdf'], 'text/html': ['.html', '.htm'], 'text/plain': ['.txt'] } }]
        });
        await openFile(await h.getFile(), h);
        return;
      } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,.pdf,.html,.htm,.txt';
    input.onchange = () => { if (input.files[0]) openFile(input.files[0]); };
    input.click();
  };

  // Legacy entry points used by the Convert tab / modal
  const handleImportDocx = (file) => openFile(file);
  const handleImportPdf = (file) => openFile(file);
  const handleLoadExtractedHtml = (html, title) => { loadHtmlIntoEditor(html, title); setDirty(true); };

  /* ---------------- documents: save ---------------- */
  const withExportReady = async (fn) => {
    const ed = editorRef.current;
    if (drawApiRef.current) drawApiRef.current.commit();
    const wasPreview = S.current.merge.previewing;
    if (wasPreview) showFields(ed);
    try { return await fn(); } finally { if (wasPreview && S.current.merge.data) showRecord(ed, S.current.merge.data.rows[S.current.merge.idx]); }
  };

  const saveAs = async (formatKey, { as }) => {
    const ed = editorRef.current;
    if (!ed) return;
    const { documentTitle: title, pageSetup: ps, header: hd, footer: ft, author: au, docMeta: meta } = S.current;
    const format = formatKey || meta.format;
    setIsConverting(true);
    try {
      await withExportReady(async () => {
        const blob = await makeBlob(format, { html: cleanHtml(ed), title, pageSetup: ps, header: hd, footer: ft, author: au, editorEl: ed, marginPx: S.current.viewMode === 'page' ? MARGIN_PX[ps.margins] || 96 : 48 });
        const sameDoc = format === 'docx';
        let fallbackName;
        if (!fsaSupported() && as) {
          const typed = await askText('Save As', `${safeName(title)}${FORMATS[format].ext}`, 'File name');
          if (!typed) return;
          fallbackName = /\.[a-z0-9]{2,4}$/i.test(typed) ? typed : `${typed}${FORMATS[format].ext}`;
        }
        const res = await writeBlob(blob, {
          format,
          handle: sameDoc && !as ? meta.handle : null,
          forcePicker: !!as,
          suggestedName: title,
          fallbackName
        });
        if (!res) return;
        if (sameDoc) {
          setDocMeta({ format: 'docx', handle: res.handle, fileName: res.name, lastSaved: Date.now() });
          if (as || !meta.fileName) setDocumentTitle(res.name.replace(/\.[^/.]+$/, ''));
          setDirty(false);
          recovery.clear();
          notify(res.via === 'fsa' ? `Saved ${res.name}.` : `Downloaded ${res.name}.`);
        } else notify(`Exported a copy as ${res.name}.`);
      });
    } catch (err) {
      notify(`Save failed: ${err.message}`);
    } finally {
      setIsConverting(false);
    }
  };

  const handleSaveDocx = () => saveAs('docx', { as: false });
  const handleSaveAs = (format) => saveAs(format || 'docx', { as: true });
  const handleExportPdf = () => saveAs('pdf', { as: true });
  const doPrint = () => window.print();

  /* ---------------- keyboard + unload guard ---------------- */
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); if (e.shiftKey) handleSaveAs('docx'); else handleSaveDocx(); }
      else if (k === 'n') { e.preventDefault(); handleNewDocument(); }
      else if (k === 'o') { e.preventDefault(); openDocument(); }
      else if (k === 'f') { e.preventDefault(); setShowFindReplace(true); }
      else if (k === 'p') { e.preventDefault(); window.print(); }
    };
    const onUnload = (e) => {
      if (S.current.dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
      return undefined;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onUnload); };
  }, []);

  /* ---------------- autosave recovery ---------------- */
  useEffect(() => {
    if (!dirty) return undefined;
    const id = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || S.current.merge.previewing) return;
      recovery.save({ html: cleanHtml(ed), title: S.current.documentTitle, header: S.current.header, footer: S.current.footer, pageSetup: S.current.pageSetup });
    }, 1500);
    return () => clearTimeout(id);
  }, [tick, dirty]);

  useEffect(() => {
    recovery.load().then((r) => { if (r && r.html) setRecoveryOffer(r); });
  }, []);

  const acceptRecovery = () => {
    const r = recoveryOffer;
    loadHtmlIntoEditor(r.html, r.title);
    setHeader(r.header || '');
    setFooter(r.footer != null ? r.footer : DEFAULT_FOOTER);
    if (r.pageSetup) setPageSetup(r.pageSetup);
    setDirty(true);
    setRecoveryOffer(null);
    notify('Recovered your unsaved document.');
  };
  const discardRecovery = () => { recovery.clear(); setRecoveryOffer(null); };

  /* ---------------- UI ---------------- */
  const app = {
    notify, askText,
    header, footer, setHeader, setFooter,
    showMarks, toggleMarks: () => setShowMarks((v) => !v),
    spellCheck, toggleSpell: () => setSpellCheck((v) => !v),
    setBlockStyle, setLineSpacing,
    insertCoverPage, doInsertToc, doUpdateToc, doInsertFootnote, doInsertCitation,
    doAddComment, showComments, toggleComments: () => setShowComments((v) => !v),
    doResolveAll, doResolveNext, doGotoChange, changeCount,
    speaking, toggleSpeech,
    pictureOp, selectedImg, tableOp, inTable,
    drawTool, setDrawTool, drawColor, setDrawColor, drawSize, setDrawSize, drawApiRef, drawDone,
    merge, loadRecipients, insertMergeField, setPreview, gotoRecord, finishMerge, restoreTemplate,
    docMeta, dirty, openDocument, handleSaveAs, doPrint, fsaSupported: fsaSupported(),
    pageCount: pageCuts.length
  };

  const saveLabel = dirty ? 'Unsaved changes' : docMeta.lastSaved ? `Saved ${new Date(docMeta.lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'No changes';

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden font-sans">
      <Ribbon
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        documentTitle={documentTitle}
        setDocumentTitle={(t) => { setDocumentTitle(t); setDirty(true); }}
        formatDoc={formatDoc}
        insertTable={insertTable}
        insertImage={insertImage}
        insertPageBreak={insertPageBreak}
        insertCallout={insertCallout}
        insertDateTime={insertDateTime}
        insertLink={insertLink}
        pageSetup={pageSetup}
        setPageSetup={setPageSetup}
        zoom={zoom}
        setZoom={setZoom}
        viewMode={viewMode}
        setViewMode={setViewMode}
        showRuler={showRuler}
        setShowRuler={setShowRuler}
        showGridlines={showGridlines}
        setShowGridlines={setShowGridlines}
        trackChanges={trackChanges}
        setTrackChanges={setTrackChanges}
        setShowFindReplace={setShowFindReplace}
        setShowConvertModal={setShowConvertModal}
        handleSaveDocx={handleSaveDocx}
        handleExportPdf={handleExportPdf}
        handleImportDocx={handleImportDocx}
        handleImportPdf={handleImportPdf}
        handleNewDocument={handleNewDocument}
        handleLoadTemplate={handleLoadTemplate}
        stats={stats}
        isConverting={isConverting}
        saveLabel={saveLabel}
        app={app}
      />

      {recoveryOffer && (
        <div className="no-print bg-amber-50 border-b border-amber-300 px-3 py-1.5 text-xs text-amber-900 flex items-center gap-3">
          <span>
            Unsaved work was recovered: <strong>{recoveryOffer.title}</strong> (autosaved {new Date(recoveryOffer.savedAt).toLocaleString()}).
          </span>
          <button onClick={acceptRecovery} className="px-2 py-0.5 bg-amber-600 text-white rounded font-semibold">Restore</button>
          <button onClick={discardRecovery} className="px-2 py-0.5 border border-amber-400 rounded">Discard</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        <EditorCanvas
          editorRef={editorRef}
          content={content}
          onContentChange={onContentChange}
          pageSetup={pageSetup}
          zoom={zoom}
          viewMode={viewMode}
          showRuler={showRuler}
          showGridlines={showGridlines}
          trackChanges={trackChanges}
          documentTitle={documentTitle}
          readOnly={merge.previewing}
          spellCheck={spellCheck}
          showMarks={showMarks}
          header={header}
          footer={footer}
          setHeader={(v) => { setHeader(v); setDirty(true); }}
          setFooter={(v) => { setFooter(v); setDirty(true); }}
          pageCuts={pageCuts}
          selectedImg={selectedImg}
          onSelectImg={setSelectedImg}
          drawTool={drawTool}
          drawColor={drawColor}
          drawSize={drawSize}
          drawApiRef={drawApiRef}
          tick={tick}
        />

        <FindReplaceBar
          isOpen={showFindReplace}
          onClose={() => setShowFindReplace(false)}
          editorRef={editorRef}
          onChange={onContentChange}
          tracking={trackChanges && !merge.previewing}
          author={author}
        />

        <CommentsPanel open={showComments} onClose={() => setShowComments(false)} editorRef={editorRef} tick={tick} onChange={onContentChange} />
      </div>

      <footer className="h-6 bg-[#004a99] text-white flex items-center justify-between px-3 text-[11px] select-none no-print shrink-0 font-medium">
        <div className="flex items-center space-x-4">
          <span>Page {currentPage} of {pageCuts.length}</span>
          <span>{stats.words} words</span>
          <span>{stats.characters} characters</span>
          {changeCount > 0 && <span className="text-amber-200">{changeCount} tracked change{changeCount > 1 ? 's' : ''}</span>}
          <span className="text-blue-200">English (United States)</span>
          <span className={dirty ? 'text-amber-200' : 'text-emerald-200'}>{dirty ? '● ' : '✓ '}{saveLabel}</span>
        </div>

        <div className="flex items-center space-x-3">
          <button onClick={() => setViewMode('page')} className={`px-1.5 py-0.5 rounded ${viewMode === 'page' ? 'bg-blue-800' : 'hover:bg-blue-800/60'}`} title="Page Layout View">📄 Page</button>
          <button onClick={() => setViewMode('web')} className={`px-1.5 py-0.5 rounded ${viewMode === 'web' ? 'bg-blue-800' : 'hover:bg-blue-800/60'}`} title="Web Layout View">🌐 Web</button>
          <div className="flex items-center space-x-1.5">
            <button onClick={() => setZoom(Math.max(50, zoom - 10))} className="px-1 hover:bg-blue-800 rounded">-</button>
            <input type="range" min="50" max="200" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-16 accent-white cursor-pointer h-1" />
            <button onClick={() => setZoom(Math.min(200, zoom + 10))} className="px-1 hover:bg-blue-800 rounded">+</button>
            <span className="w-8 text-right">{zoom}%</span>
          </div>
        </div>
      </footer>

      {notice && (
        <div className="no-print fixed bottom-9 left-1/2 -translate-x-1/2 z-50 bg-slate-800 text-white text-xs px-4 py-2 rounded-lg shadow-lg max-w-xl" role="status">
          {notice}
        </div>
      )}

      <TextPrompt dialog={promptDlg} onClose={() => setPromptDlg(null)} />

      <ConversionModal
        isOpen={showConvertModal}
        onClose={() => setShowConvertModal(false)}
        onLoadExtractedHtml={handleLoadExtractedHtml}
      />
    </div>
  );
}

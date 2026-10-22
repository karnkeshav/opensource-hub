import React, { useState, useEffect, useRef } from 'react';
import { 
  FileText, Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, 
  AlignRight, AlignJustify, List, ListOrdered, CheckSquare, Image as ImageIcon, 
  Table as TableIcon, Download, Upload, Printer, Search, RefreshCw, ZoomIn, 
  ZoomOut, FileDown, FileUp, Sparkles, Layout, Eye, CheckCircle2, SplitSquareVertical,
  Minus, Type, Highlighter, Palette, HelpCircle, Share2, Subscript, Superscript,
  ChevronDown, Scissors, Copy, Clipboard, Check, BookOpen, Volume2, ShieldCheck,
  Grid, Compass, Columns, Bookmark, Hash, Pilcrow, ArrowDownUp, PenTool,
  Settings, FolderOpen, Save, FilePlus, Maximize2, Shield, Undo2, Redo2,
  MessageSquare, MessageSquarePlus, Eraser, SpellCheck, Trash2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Merge, Split, ChevronLeft, ChevronRight, SquareStop, PaintBucket, Table2, Rows3, Columns3
} from 'lucide-react';
import { getSystemFonts } from '../utils/systemFonts';

export default function Ribbon({
  activeTab,
  setActiveTab,
  documentTitle,
  setDocumentTitle,
  formatDoc,
  insertTable,
  insertImage,
  insertPageBreak,
  insertCallout,
  insertDateTime,
  insertLink,
  pageSetup,
  setPageSetup,
  zoom,
  setZoom,
  viewMode,
  setViewMode,
  showRuler,
  setShowRuler,
  showGridlines,
  setShowGridlines,
  setShowFindReplace,
  setShowConvertModal,
  handleSaveDocx,
  handleExportPdf,
  handleImportDocx,
  handleImportPdf,
  handleNewDocument,
  handleLoadTemplate,
  stats,
  isConverting,
  trackChanges,
  setTrackChanges,
  saveLabel,
  app
}) {
  const fileInputDocxRef = useRef(null);
  const fileInputPdfRef = useRef(null);
  const fileInputImgRef = useRef(null);
  const fileInputCsvRef = useRef(null);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [showFieldMenu, setShowFieldMenu] = useState(false);
  const [showMergeMenu, setShowMergeMenu] = useState(false);
  const [shadeColor, setShadeColor] = useState('#fde68a');

  // Contextual tabs fall away when their context does.
  useEffect(() => {
    if (activeTab === 'Table' && !app.inTable) setActiveTab('Home');
    if (activeTab === 'Picture' && !app.selectedImg) setActiveTab('Home');
  }, [activeTab, app.inTable, app.selectedImg, setActiveTab]);

  const [systemFonts, setSystemFonts] = useState([]);
  const [selectedFont, setSelectedFont] = useState('Calibri');
  const [fontSize, setFontSize] = useState('11');
  const [textColor, setTextColor] = useState('#000000');
  const [highlightColor, setHighlightColor] = useState('#ffff00');
  const [citationStyle, setCitationStyle] = useState('APA');
  const [showFontMenu, setShowFontMenu] = useState(false);
  const [fontSearch, setFontSearch] = useState('');
  const [showUnderlineMenu, setShowUnderlineMenu] = useState(false);
  const [showBorderMenu, setShowBorderMenu] = useState(false);
  const [showCaseMenu, setShowCaseMenu] = useState(false);
  const [formatPainterActive, setFormatPainterActive] = useState(false);
  const [savedFormat, setSavedFormat] = useState(null);

  // Load 100% of the Windows system fonts
  useEffect(() => {
    getSystemFonts().then(fonts => {
      setSystemFonts(fonts);
    });
  }, []);

  const fontSizes = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '22', '24', '26', '28', '36', '48', '72'];

  const handleFontSelect = (font) => {
    setSelectedFont(font);
    formatDoc('fontName', font);
    setShowFontMenu(false);
  };

  const handleFontSizeChange = (size) => {
    setFontSize(size);
    formatDoc('fontSize', size);
  };

  const adjustFontSize = (delta) => {
    const currentIndex = fontSizes.indexOf(fontSize);
    if (currentIndex !== -1) {
      const nextIndex = Math.min(Math.max(0, currentIndex + delta), fontSizes.length - 1);
      handleFontSizeChange(fontSizes[nextIndex]);
    }
  };

  const handleChangeCase = (caseType) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const text = selection.toString();
    if (!text) return;

    let converted = text;
    if (caseType === 'upper') converted = text.toUpperCase();
    if (caseType === 'lower') converted = text.toLowerCase();
    if (caseType === 'capitalize') {
      converted = text.replace(/\b\w/g, l => l.toUpperCase());
    }
    if (caseType === 'sentence') {
      converted = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    }
    formatDoc('insertText', converted);
    setShowCaseMenu(false);
  };

  const insertSymbol = (sym) => {
    formatDoc('insertText', sym);
  };

  const toolBtn = 'flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs';
  const toolBtnOn = 'flex flex-col items-center p-1.5 rounded text-xs bg-blue-100 text-blue-900 font-semibold';
  const smallBtn = 'px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:hover:bg-transparent';

  const filteredFonts = systemFonts.filter(f => f.toLowerCase().includes(fontSearch.toLowerCase()));

  const tabs = [
    'File', 'Home', 'Insert', 'Draw', 'Layout', 'References', 'Mailings', 'Review', 'View', 'Convert', 'Help',
    ...(app.inTable ? ['Table'] : []),
    ...(app.selectedImg ? ['Picture'] : [])
  ];

  return (
    <header className="bg-white border-b border-slate-300 select-none shadow-xs no-print flex flex-col">
      
      {/* 1. Quick Access Title Bar */}
      <div className="bg-[#1055ba] text-white px-3 py-1 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          {/* Logo & Document Title */}
          <div className="flex items-center space-x-1 bg-blue-900/60 px-2 py-0.5 rounded text-xs font-semibold tracking-wide">
            <FileText className="w-4 h-4 text-blue-200" />
            <span>DocStudio Pro</span>
          </div>

          <div className="h-4 w-[1px] bg-blue-400/40 mx-1"></div>

          {/* Quick Access Icons */}
          <button onClick={handleNewDocument} className="p-1 hover:bg-blue-700/80 rounded transition" title="New Document (Ctrl+N)">
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleSaveDocx} className="p-1 hover:bg-blue-700/80 rounded transition" title="Save .docx (Ctrl+S)">
            <Save className="w-3.5 h-3.5" />
          </button>
          <button onClick={app.openDocument} className="p-1 hover:bg-blue-700/80 rounded transition" title="Open (Ctrl+O)">
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => formatDoc('undo')} className="p-1 hover:bg-blue-700/80 rounded transition" title="Undo (Ctrl+Z)">
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => formatDoc('redo')} className="p-1 hover:bg-blue-700/80 rounded transition" title="Redo (Ctrl+Y)">
            <Redo2 className="w-3.5 h-3.5" />
          </button>

          <input
            type="text"
            value={documentTitle}
            onChange={(e) => setDocumentTitle(e.target.value)}
            className="bg-transparent hover:bg-blue-800/60 focus:bg-white focus:text-slate-900 px-2 py-0.5 rounded text-xs font-medium transition border border-transparent focus:border-blue-400 outline-none w-56 text-center"
            title="Click to rename document"
          />
          <span className={`text-[11px] px-1.5 rounded ${app.dirty ? 'bg-amber-500/90 text-white' : 'bg-emerald-600/80 text-white'}`} title={app.docMeta.fileName ? `File: ${app.docMeta.fileName}` : 'Not saved to a file yet'}>
            {app.dirty ? '● Unsaved' : `✓ ${saveLabel}`}
          </span>
        </div>

        {/* Right Quick Tools */}
        <div className="flex items-center space-x-2 text-xs">
          <span className="text-[11px] text-blue-100 bg-blue-800/80 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono">
            {systemFonts.length > 0 ? `${systemFonts.length} System Fonts Loaded` : 'Scanning System Fonts...'}
          </span>
          <button 
            onClick={() => setShowConvertModal(true)} 
            className="bg-amber-500 hover:bg-amber-600 px-2.5 py-0.5 rounded text-white text-[11px] font-bold flex items-center gap-1 transition shadow-xs"
          >
            <RefreshCw className={`w-3 h-3 ${isConverting ? 'animate-spin' : ''}`} />
            <span>PDF ⇄ Word</span>
          </button>
          <button onClick={() => window.print()} className="p-1 hover:bg-blue-700 rounded transition" title="Print">
            <Printer className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Ribbon Tabs Bar */}
      <div className="flex items-center bg-[#f8fafc] border-b border-slate-200 px-2 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-1.5 text-xs font-semibold tracking-wide border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab
                ? 'border-[#1055ba] text-[#1055ba] bg-white'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* 3. Ribbon Body (Active Tab Toolbar) */}
      <div className="bg-white px-3 py-1.5 flex items-center space-x-3 overflow-x-auto min-h-[76px] border-b border-slate-200">
        
        {/* ==================== HOME TAB ==================== */}
        {activeTab === 'Home' && (
          <div className="flex items-center space-x-2 divide-x divide-slate-200">
            {/* Clipboard Group */}
            <div className="flex items-center space-x-1 pr-2">
              <div className="flex flex-col items-center">
                <button 
                  onClick={() => formatDoc('paste')} 
                  className="p-1 hover:bg-slate-100 rounded text-slate-700 flex flex-col items-center"
                  title="Paste (Ctrl+V)"
                >
                  <Clipboard className="w-5 h-5 text-blue-600 mb-0.5" />
                  <span className="text-[10px] font-medium">Paste</span>
                </button>
              </div>
              <div className="flex flex-col space-y-0.5">
                <button onClick={() => formatDoc('cut')} className="p-0.5 hover:bg-slate-100 rounded text-slate-600 flex items-center gap-1 text-[11px]" title="Cut">
                  <Scissors className="w-3 h-3" /> Cut
                </button>
                <button onClick={() => formatDoc('copy')} className="p-0.5 hover:bg-slate-100 rounded text-slate-600 flex items-center gap-1 text-[11px]" title="Copy">
                  <Copy className="w-3 h-3" /> Copy
                </button>
                <button 
                  onClick={() => setFormatPainterActive(!formatPainterActive)} 
                  className={`p-0.5 rounded flex items-center gap-1 text-[11px] ${formatPainterActive ? 'bg-amber-100 text-amber-900' : 'hover:bg-slate-100 text-slate-600'}`}
                  title="Format Painter"
                >
                  <PenTool className="w-3 h-3 text-amber-600" /> Painter
                </button>
              </div>
            </div>

            {/* Font Group (Exact System Font Match) */}
            <div className="flex flex-col space-y-1 px-2 relative">
              <div className="flex items-center space-x-1">
                {/* System Font Dropdown Picker */}
                <div className="relative">
                  <button
                    onClick={() => setShowFontMenu(!showFontMenu)}
                    className="flex items-center justify-between text-xs border border-slate-300 rounded px-2 py-0.5 bg-white text-slate-800 w-36 hover:border-slate-400 font-medium"
                  >
                    <span className="truncate">{selectedFont}</span>
                    <ChevronDown className="w-3 h-3 text-slate-500 ml-1 shrink-0" />
                  </button>

                  {/* System Font Search & List Modal */}
                  {showFontMenu && (
                    <div className="absolute top-7 left-0 z-50 bg-white border border-slate-300 rounded-md shadow-xl w-60 max-h-64 overflow-y-auto p-1.5">
                      <div className="sticky top-0 bg-white pb-1.5 border-b border-slate-200">
                        <input
                          type="text"
                          placeholder="Search fonts..."
                          value={fontSearch}
                          onChange={(e) => setFontSearch(e.target.value)}
                          className="w-full text-xs border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500"
                          autoFocus
                        />
                        <div className="text-[10px] text-slate-400 mt-1 px-1">
                          {filteredFonts.length} Windows Fonts Available
                        </div>
                      </div>
                      <div className="pt-1">
                        {filteredFonts.map((font) => (
                          <button
                            key={font}
                            onClick={() => handleFontSelect(font)}
                            className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-blue-50 hover:text-blue-700 flex items-center justify-between ${selectedFont === font ? 'bg-blue-100 text-blue-800 font-semibold' : ''}`}
                            style={{ fontFamily: font }}
                          >
                            <span>{font}</span>
                            {selectedFont === font && <Check className="w-3 h-3 text-blue-600" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Font Size Selector */}
                <select
                  value={fontSize}
                  onChange={(e) => handleFontSizeChange(e.target.value)}
                  className="text-xs border border-slate-300 rounded px-1.5 py-0.5 bg-white text-slate-800 outline-none w-14 font-medium"
                >
                  {fontSizes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>

                {/* Grow / Shrink Font Buttons */}
                <button onClick={() => adjustFontSize(1)} className="px-1 py-0.5 border border-slate-200 hover:bg-slate-100 rounded text-xs font-bold text-slate-700" title="Increase Font Size">
                  A<sup>+</sup>
                </button>
                <button onClick={() => adjustFontSize(-1)} className="px-1 py-0.5 border border-slate-200 hover:bg-slate-100 rounded text-xs font-bold text-slate-700" title="Decrease Font Size">
                  A<sup>-</sup>
                </button>

                {/* Change Case Dropdown */}
                <div className="relative">
                  <button 
                    onClick={() => setShowCaseMenu(!showCaseMenu)}
                    className="p-1 hover:bg-slate-100 rounded text-slate-700 border border-slate-200 flex items-center text-xs" 
                    title="Change Case"
                  >
                    <span>Aa</span>
                    <ChevronDown className="w-2.5 h-2.5 ml-0.5 text-slate-400" />
                  </button>
                  {showCaseMenu && (
                    <div className="absolute top-7 left-0 z-50 bg-white border border-slate-200 rounded shadow-lg text-xs w-36 py-1">
                      <button onClick={() => handleChangeCase('sentence')} className="w-full text-left px-2.5 py-1 hover:bg-slate-100">Sentence case.</button>
                      <button onClick={() => handleChangeCase('lower')} className="w-full text-left px-2.5 py-1 hover:bg-slate-100">lowercase</button>
                      <button onClick={() => handleChangeCase('upper')} className="w-full text-left px-2.5 py-1 hover:bg-slate-100 font-bold">UPPERCASE</button>
                      <button onClick={() => handleChangeCase('capitalize')} className="w-full text-left px-2.5 py-1 hover:bg-slate-100">Capitalize Each Word</button>
                    </div>
                  )}
                </div>

                <button onClick={() => formatDoc('removeFormat')} className="p-1 hover:bg-slate-100 rounded text-slate-500 border border-slate-200" title="Clear All Formatting">
                  <Type className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Formatting Options */}
              <div className="flex items-center space-x-1">
                <button onClick={() => formatDoc('bold')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Bold (Ctrl+B)">
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('italic')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Italic (Ctrl+I)">
                  <Italic className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('underline')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Underline (Ctrl+U)">
                  <Underline className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('strikeThrough')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Strikethrough">
                  <Strikethrough className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('subscript')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Subscript">
                  <Subscript className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('superscript')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Superscript">
                  <Superscript className="w-3.5 h-3.5" />
                </button>

                <div className="h-3 w-[1px] bg-slate-300 mx-0.5"></div>

                {/* Color and Highlight Pickers */}
                <label className="p-1 hover:bg-slate-100 rounded cursor-pointer relative" title="Font Color">
                  <Palette className="w-3.5 h-3.5 text-slate-800" />
                  <input
                    type="color"
                    value={textColor}
                    onChange={(e) => { setTextColor(e.target.value); formatDoc('foreColor', e.target.value); }}
                    className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                  />
                </label>

                <label className="p-1 hover:bg-slate-100 rounded cursor-pointer relative" title="Text Highlight Color">
                  <Highlighter className="w-3.5 h-3.5 text-amber-500" />
                  <input
                    type="color"
                    value={highlightColor}
                    onChange={(e) => { setHighlightColor(e.target.value); formatDoc('hiliteColor', e.target.value); }}
                    className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                  />
                </label>
              </div>
            </div>

            {/* Paragraph Group */}
            <div className="flex flex-col space-y-1 px-2">
              <div className="flex items-center space-x-1">
                <button onClick={() => formatDoc('insertUnorderedList')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Bullets">
                  <List className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('insertOrderedList')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Numbering">
                  <ListOrdered className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('outdent')} className="p-1 hover:bg-slate-100 rounded text-slate-700 text-xs font-mono" title="Decrease Indent">
                  ←
                </button>
                <button onClick={() => formatDoc('indent')} className="p-1 hover:bg-slate-100 rounded text-slate-700 text-xs font-mono" title="Increase Indent">
                  →
                </button>
                <button onClick={app.toggleMarks} className={`p-1 rounded ${app.showMarks ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-600'}`} title="Show/Hide ¶">
                  <Pilcrow className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center space-x-1">
                <button onClick={() => formatDoc('justifyLeft')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Align Left">
                  <AlignLeft className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('justifyCenter')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Center">
                  <AlignCenter className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('justifyRight')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Align Right">
                  <AlignRight className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => formatDoc('justifyFull')} className="p-1 hover:bg-slate-100 rounded text-slate-800" title="Justify">
                  <AlignJustify className="w-3.5 h-3.5" />
                </button>

                {/* Line Spacing */}
                <select
                  defaultValue="1.5"
                  onChange={(e) => app.setLineSpacing(e.target.value)}
                  className="text-[11px] border border-slate-300 rounded px-1 py-0.5 bg-white text-slate-700 outline-none"
                  title="Line and Paragraph Spacing"
                >
                  <option value="1.0">1.0</option>
                  <option value="1.15">1.15</option>
                  <option value="1.5">1.5</option>
                  <option value="2.0">2.0</option>
                </select>
              </div>
            </div>

            {/* Word Styles Gallery Group */}
            <div className="flex items-center space-x-1.5 px-2">
              <button onClick={() => app.setBlockStyle('normal')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-800 font-normal">
                Normal
              </button>
              <button onClick={() => app.setBlockStyle('title')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-800 text-[13px]">
                Title
              </button>
              <button onClick={() => app.setBlockStyle('h1')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-900 font-bold">
                Heading 1
              </button>
              <button onClick={() => app.setBlockStyle('h2')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-800 font-semibold">
                Heading 2
              </button>
              <button onClick={() => app.setBlockStyle('h3')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-700 font-medium">
                Heading 3
              </button>
              <button onClick={() => app.setBlockStyle('blockquote')} className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-600 italic">
                Quote
              </button>
            </div>

            {/* Editing Group */}
            <div className="flex flex-col space-y-0.5 pl-2 text-xs">
              <button onClick={() => setShowFindReplace(true)} className="flex items-center gap-1.5 p-1 hover:bg-slate-100 rounded text-slate-700">
                <Search className="w-3.5 h-3.5 text-blue-600" /> Find & Replace
              </button>
              <button onClick={() => formatDoc('selectAll')} className="flex items-center gap-1.5 p-1 hover:bg-slate-100 rounded text-slate-700">
                <CheckSquare className="w-3.5 h-3.5 text-slate-500" /> Select All
              </button>
            </div>
          </div>
        )}

        {/* ==================== INSERT TAB ==================== */}
        {activeTab === 'Insert' && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={app.insertCoverPage} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs" title="Insert Cover Page">
                <FileText className="w-5 h-5 text-amber-600 mb-0.5" />
                <span>Cover Page</span>
              </button>
              <button onClick={() => formatDoc('insertHTML', '<div class="page-break"></div><p><br></p><div class="page-break"></div><p><br></p>')} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs" title="Insert Blank Page">
                <FilePlus className="w-5 h-5 text-blue-600 mb-0.5" />
                <span>Blank Page</span>
              </button>
              <button onClick={insertPageBreak} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs" title="Insert Page Break">
                <SplitSquareVertical className="w-5 h-5 text-indigo-600 mb-0.5" />
                <span>Page Break</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={() => insertTable(3, 3)} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <TableIcon className="w-5 h-5 text-blue-600 mb-0.5" />
                <span>Table (3x3)</span>
              </button>
              <button onClick={() => insertTable(5, 5)} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <Grid className="w-5 h-5 text-indigo-600 mb-0.5" />
                <span>Table (5x5)</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={() => fileInputImgRef.current?.click()} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <ImageIcon className="w-5 h-5 text-emerald-600 mb-0.5" />
                <span>Pictures</span>
                <input ref={fileInputImgRef} type="file" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => insertImage(ev.target.result);
                    reader.readAsDataURL(file);
                  }
                }} className="hidden" />
              </button>
              <button onClick={insertCallout} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <Sparkles className="w-5 h-5 text-amber-500 mb-0.5" />
                <span>Callout Box</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={insertLink} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <Share2 className="w-5 h-5 text-purple-600 mb-0.5" />
                <span>Hyperlink</span>
              </button>
              <button onClick={insertDateTime} className="flex flex-col items-center p-1.5 hover:bg-slate-100 rounded text-slate-700 text-xs">
                <span className="text-base font-bold text-slate-700 mb-0.5">📅</span>
                <span>Date & Time</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button
                onClick={() => app.setFooter(/\{page\}/i.test(app.footer) ? '' : 'Page {page} of {pages}')}
                className={/\{page\}/i.test(app.footer) ? toolBtnOn : toolBtn}
                title="Toggle page numbers in the footer (edit the footer line on the page to change the text)"
              >
                <Hash className="w-5 h-5 text-blue-600 mb-0.5" />
                <span>Page Number</span>
              </button>
              <button onClick={app.doAddComment} className={toolBtn} title="Add a comment to the selected text">
                <MessageSquarePlus className="w-5 h-5 text-amber-600 mb-0.5" />
                <span>Comment</span>
              </button>
              <button onClick={app.doInsertFootnote} className={toolBtn} title="Insert a footnote">
                <Bookmark className="w-5 h-5 text-indigo-600 mb-0.5" />
                <span>Footnote</span>
              </button>
            </div>

            {/* Symbols & Equations Group */}
            <div className="flex items-center space-x-1.5">
              <span className="text-[10px] text-slate-400 uppercase font-bold mr-1">Symbols:</span>
              {['π', 'Ω', '©', '®', '™', '∞', '√', '±', '≤', '≥', '€', '£', '¥'].map(sym => (
                <button
                  key={sym}
                  onClick={() => insertSymbol(sym)}
                  className="px-2 py-1 text-xs border border-slate-200 hover:bg-blue-50 hover:border-blue-400 rounded font-semibold text-slate-800"
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ==================== DRAW TAB ==================== */}
        {activeTab === 'Draw' && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <button onClick={() => app.setDrawTool('pen')} className={app.drawTool === 'pen' ? toolBtnOn : toolBtn} title="Ballpoint pen">
                <PenTool className="w-5 h-5 text-blue-600 mb-0.5" />
                <span>Ballpoint Pen</span>
              </button>
              <button onClick={() => app.setDrawTool('highlighter')} className={app.drawTool === 'highlighter' ? toolBtnOn : toolBtn} title="Highlighter">
                <Highlighter className="w-5 h-5 text-amber-500 mb-0.5" />
                <span>Highlighter</span>
              </button>
              <button onClick={() => app.setDrawTool('line')} className={app.drawTool === 'line' ? toolBtnOn : toolBtn} title="Straight line">
                <Minus className="w-5 h-5 text-slate-600 mb-0.5" />
                <span>Line</span>
              </button>
              <button onClick={() => app.setDrawTool('eraser')} className={app.drawTool === 'eraser' ? toolBtnOn : toolBtn} title="Eraser">
                <Eraser className="w-5 h-5 text-rose-500 mb-0.5" />
                <span>Eraser</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3 text-xs text-slate-600">
              <label className="flex flex-col items-center" title="Ink colour">
                <input type="color" value={app.drawColor} onChange={(e) => app.setDrawColor(e.target.value)} className="w-8 h-6 p-0 border border-slate-300 rounded cursor-pointer" />
                <span>Colour</span>
              </label>
              <label className="flex flex-col items-center" title="Stroke size">
                <select value={app.drawSize} onChange={(e) => app.setDrawSize(Number(e.target.value))} className="text-xs border border-slate-300 rounded px-1 py-0.5 bg-white">
                  {[1, 2, 3, 5, 8, 12, 20].map((s) => <option key={s} value={s}>{s} px</option>)}
                </select>
                <span>Size</span>
              </label>
            </div>

            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <button onClick={() => app.drawApiRef.current && app.drawApiRef.current.undo()} disabled={!app.drawTool} className={smallBtn}>Undo stroke</button>
              <button onClick={() => app.drawApiRef.current && app.drawApiRef.current.clear()} disabled={!app.drawTool} className={smallBtn}>Clear ink</button>
              <button onClick={app.drawDone} disabled={!app.drawTool} className="px-2 py-1 text-xs bg-blue-600 text-white rounded font-semibold disabled:opacity-40">Done</button>
            </div>

            <button onClick={() => formatDoc('insertHorizontalRule')} className={toolBtn}>
              <Minus className="w-5 h-5 text-slate-500 mb-0.5" />
              <span>Rule Line</span>
            </button>
            <span className="text-[11px] text-slate-500 max-w-[220px]">
              Ink is saved in the document as one transparent picture at a fixed position on the page.
            </span>
          </div>
        )}

        {/* ==================== LAYOUT TAB ==================== */}
        {activeTab === 'Layout' && (
          <div className="flex items-center space-x-6">
            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Page Margins</span>
              <select
                value={pageSetup.margins}
                onChange={(e) => setPageSetup({ ...pageSetup, margins: e.target.value })}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white text-slate-800 outline-none font-medium"
              >
                <option value="normal">Normal (1 in / 2.54 cm)</option>
                <option value="narrow">Narrow (0.5 in / 1.27 cm)</option>
                <option value="wide">Wide (1.5 in / 3.81 cm)</option>
              </select>
            </div>

            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Orientation</span>
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => setPageSetup({ ...pageSetup, orientation: 'portrait' })}
                  className={`px-3 py-1 text-xs rounded border ${pageSetup.orientation === 'portrait' ? 'bg-blue-50 border-blue-500 text-blue-700 font-semibold' : 'border-slate-300 text-slate-700'}`}
                >
                  Portrait
                </button>
                <button
                  onClick={() => setPageSetup({ ...pageSetup, orientation: 'landscape' })}
                  className={`px-3 py-1 text-xs rounded border ${pageSetup.orientation === 'landscape' ? 'bg-blue-50 border-blue-500 text-blue-700 font-semibold' : 'border-slate-300 text-slate-700'}`}
                >
                  Landscape
                </button>
              </div>
            </div>

            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Paper Size</span>
              <select
                value={pageSetup.paperSize}
                onChange={(e) => setPageSetup({ ...pageSetup, paperSize: e.target.value })}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white text-slate-800 outline-none font-medium"
              >
                <option value="a4">A4 (210 × 297 mm)</option>
                <option value="letter">US Letter (8.5 × 11 in)</option>
                <option value="legal">Legal (8.5 × 14 in)</option>
              </select>
            </div>

            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Columns</span>
              <div className="flex space-x-1">
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    onClick={() => setPageSetup({ ...pageSetup, columns: n })}
                    className={`px-2 py-1 text-xs border rounded ${(pageSetup.columns || 1) === n ? 'bg-blue-50 border-blue-500 font-semibold text-blue-700' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`}
                  >
                    {n} {n === 1 ? 'Col' : 'Cols'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Page colour</span>
              <select
                value={pageSetup.pageColor || '#ffffff'}
                onChange={(e) => setPageSetup({ ...pageSetup, pageColor: e.target.value })}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white text-slate-800 outline-none"
              >
                <option value="#ffffff">White</option>
                <option value="#fdf6e3">Eye-care cream</option>
                <option value="#f4ecd8">Sepia</option>
                <option value="#1e293b">Dark</option>
              </select>
            </div>

            <div className="flex flex-col space-y-1 max-w-[210px]">
              <span className="text-[10px] uppercase font-bold text-slate-400">Header &amp; footer</span>
              <span className="text-[11px] text-slate-500">Click the top or bottom margin of the page to type. Use {'{page}'} and {'{pages}'} for page numbers.</span>
            </div>
          </div>
        )}

        {/* ==================== REFERENCES TAB ==================== */}
        {activeTab === 'References' && (
          <div className="flex items-center space-x-4">
            <button onClick={app.doInsertToc} className={toolBtn} title="Build a table of contents from Heading 1-3">
              <BookOpen className="w-5 h-5 text-blue-600 mb-0.5" />
              <span>Table of Contents</span>
            </button>
            <button onClick={app.doUpdateToc} className={toolBtn} title="Rebuild the table of contents from the current headings">
              <RefreshCw className="w-5 h-5 text-blue-500 mb-0.5" />
              <span>Update Table</span>
            </button>
            <button onClick={app.doInsertFootnote} className={toolBtn}>
              <Bookmark className="w-5 h-5 text-indigo-600 mb-0.5" />
              <span>Insert Footnote</span>
            </button>
            <button onClick={() => app.doInsertCitation(citationStyle)} className={toolBtn}>
              <FileText className="w-5 h-5 text-emerald-600 mb-0.5" />
              <span>Insert Citation</span>
            </button>
            <div className="flex flex-col space-y-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Citation Style</span>
              <select
                value={citationStyle}
                onChange={(e) => setCitationStyle(e.target.value)}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white text-slate-800 outline-none"
              >
                <option value="APA">APA 7th Edition</option>
                <option value="MLA">MLA 9th Edition</option>
                <option value="Chicago">Chicago</option>
                <option value="IEEE">IEEE</option>
                <option value="Harvard">Harvard</option>
              </select>
            </div>
          </div>
        )}

        {/* ==================== MAILINGS TAB ==================== */}
        {activeTab === 'Mailings' && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={() => fileInputCsvRef.current?.click()} className={toolBtn} title="Choose a CSV file of recipients (first row = field names)">
                <Share2 className="w-5 h-5 text-blue-600 mb-0.5" />
                <span>Start Mail Merge</span>
                <input
                  ref={fileInputCsvRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
                  className="hidden"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) app.loadRecipients(f); e.target.value = ''; }}
                />
              </button>
              <div className="text-[11px] text-slate-600 leading-tight min-w-[110px]">
                {app.merge.data ? (
                  <>
                    <div className="font-semibold text-slate-800 truncate max-w-[150px]">{app.merge.data.fileName}</div>
                    <div>{app.merge.data.rows.length} records · {app.merge.data.headers.length} fields</div>
                  </>
                ) : <div className="text-slate-400">No recipients chosen</div>}
              </div>
            </div>

            <div className="relative border-r border-slate-200 pr-3">
              <button onClick={() => setShowFieldMenu(!showFieldMenu)} disabled={!app.merge.data} className={`${toolBtn} disabled:opacity-40`} title="Insert a «Field» placeholder">
                <Type className="w-5 h-5 text-emerald-600 mb-0.5" />
                <span>Insert Merge Field ▾</span>
              </button>
              {showFieldMenu && app.merge.data && (
                <div className="absolute top-14 left-0 z-50 bg-white border border-slate-200 rounded shadow-lg w-44 max-h-56 overflow-y-auto py-1 text-xs">
                  {app.merge.data.headers.map((h) => (
                    <button key={h} onClick={() => { app.insertMergeField(h); setShowFieldMenu(false); }} className="w-full text-left px-3 py-1 hover:bg-slate-100">«{h}»</button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={() => app.setPreview(!app.merge.previewing)} disabled={!app.merge.data} className={`${app.merge.previewing ? toolBtnOn : toolBtn} disabled:opacity-40`}>
                <Eye className="w-5 h-5 text-purple-600 mb-0.5" />
                <span>Preview Results</span>
              </button>
              <div className="flex items-center gap-1 text-xs text-slate-700">
                <button onClick={() => app.gotoRecord(app.merge.idx - 1)} disabled={!app.merge.data || app.merge.idx <= 0} className={smallBtn} title="Previous record"><ChevronLeft className="w-3.5 h-3.5" /></button>
                <span className="w-16 text-center">{app.merge.data ? `${app.merge.idx + 1} / ${app.merge.data.rows.length}` : '–'}</span>
                <button onClick={() => app.gotoRecord(app.merge.idx + 1)} disabled={!app.merge.data || app.merge.idx >= app.merge.data.rows.length - 1} className={smallBtn} title="Next record"><ChevronRight className="w-3.5 h-3.5" /></button>
              </div>
            </div>

            <div className="relative flex items-center space-x-2">
              <button onClick={() => setShowMergeMenu(!showMergeMenu)} disabled={!app.merge.data} className={`${toolBtn} disabled:opacity-40`}>
                <Merge className="w-5 h-5 text-blue-700 mb-0.5" />
                <span>Finish &amp; Merge ▾</span>
              </button>
              {showMergeMenu && app.merge.data && (
                <div className="absolute top-14 left-0 z-50 bg-white border border-slate-200 rounded shadow-lg w-64 py-1 text-xs">
                  <button onClick={() => { app.finishMerge('edit'); setShowMergeMenu(false); }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">Edit merged letters (one page per record)</button>
                  <button onClick={() => { app.finishMerge('docx'); setShowMergeMenu(false); }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100">Save merged letters as .docx…</button>
                </div>
              )}
              {app.merge.template && (
                <button onClick={app.restoreTemplate} className={smallBtn}>Restore template</button>
              )}
            </div>
          </div>
        )}

        {/* ==================== REVIEW TAB ==================== */}
        {activeTab === 'Review' && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={() => app.notify(`Words: ${stats.words} · Characters: ${stats.characters} · Reading time: ${stats.readingTime} min`)} className={toolBtn}>
                <CheckCircle2 className="w-5 h-5 text-emerald-600 mb-0.5" />
                <span>Word Count</span>
              </button>
              <button onClick={app.toggleSpell} className={app.spellCheck ? toolBtnOn : toolBtn} title="Spelling squiggles use the browser's built-in dictionary">
                <SpellCheck className="w-5 h-5 text-red-500 mb-0.5" />
                <span>{app.spellCheck ? 'Spelling ON' : 'Spelling OFF'}</span>
              </button>
              <button onClick={app.toggleSpeech} className={app.speaking ? toolBtnOn : toolBtn} title="Read the selection (or whole document) aloud">
                {app.speaking ? <SquareStop className="w-5 h-5 text-red-600 mb-0.5" /> : <Volume2 className="w-5 h-5 text-blue-600 mb-0.5" />}
                <span>{app.speaking ? 'Stop' : 'Read Aloud'}</span>
              </button>
            </div>

            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <button
                onClick={() => setTrackChanges(!trackChanges)}
                className={`flex flex-col items-center p-1.5 rounded text-xs transition ${trackChanges ? 'bg-amber-100 text-amber-900 font-bold' : 'hover:bg-slate-100 text-slate-700'}`}
              >
                <ShieldCheck className="w-5 h-5 text-amber-600 mb-0.5" />
                <span>{trackChanges ? 'Tracking ON' : 'Track Changes'}</span>
              </button>
              <div className="grid grid-cols-2 gap-1">
                <button onClick={() => app.doResolveNext(true)} className={smallBtn} title="Accept the next change">Accept</button>
                <button onClick={() => app.doResolveNext(false)} className={smallBtn} title="Reject the next change">Reject</button>
                <button onClick={() => app.doResolveAll(true)} className={smallBtn}>Accept All</button>
                <button onClick={() => app.doResolveAll(false)} className={smallBtn}>Reject All</button>
              </div>
              <div className="flex flex-col gap-1">
                <button onClick={() => app.doGotoChange(-1)} className={smallBtn} title="Previous change"><ArrowUp className="w-3 h-3" /></button>
                <button onClick={() => app.doGotoChange(1)} className={smallBtn} title="Next change"><ArrowDown className="w-3 h-3" /></button>
              </div>
              <span className="text-[11px] text-slate-500 w-14 text-center">{app.changeCount} change{app.changeCount === 1 ? '' : 's'}</span>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={app.doAddComment} className={toolBtn} title="Add a comment to the selected text">
                <MessageSquarePlus className="w-5 h-5 text-amber-600 mb-0.5" />
                <span>New Comment</span>
              </button>
              <button onClick={app.toggleComments} className={app.showComments ? toolBtnOn : toolBtn}>
                <MessageSquare className="w-5 h-5 text-slate-600 mb-0.5" />
                <span>Comments</span>
              </button>
            </div>

            <div className="flex items-center space-x-4 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded text-xs text-slate-600">
              <div><strong className="text-slate-800">{stats.words}</strong> words</div>
              <div><strong className="text-slate-800">{stats.characters}</strong> chars</div>
              <div><strong className="text-slate-800">{stats.readingTime}</strong> min read</div>
            </div>
          </div>
        )}

        {/* ==================== VIEW TAB ==================== */}
        {activeTab === 'View' && (
          <div className="flex items-center space-x-6">
            <div className="flex items-center space-x-1">
              <button
                onClick={() => setViewMode('page')}
                className={`px-3 py-1 text-xs rounded border ${viewMode === 'page' ? 'bg-blue-50 border-blue-500 text-blue-700 font-semibold' : 'border-slate-300 text-slate-700'}`}
              >
                Print Layout (A4)
              </button>
              <button
                onClick={() => setViewMode('web')}
                className={`px-3 py-1 text-xs rounded border ${viewMode === 'web' ? 'bg-blue-50 border-blue-500 text-blue-700 font-semibold' : 'border-slate-300 text-slate-700'}`}
              >
                Web Layout
              </button>
            </div>

            <label className="flex items-center space-x-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showRuler}
                onChange={(e) => setShowRuler(e.target.checked)}
                className="rounded border-slate-300 text-blue-600"
              />
              <span>Ruler</span>
            </label>

            <label className="flex items-center space-x-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showGridlines}
                onChange={(e) => setShowGridlines(e.target.checked)}
                className="rounded border-slate-300 text-blue-600"
              />
              <span>Gridlines</span>
            </label>

            <div className="flex items-center space-x-2">
              <button onClick={() => setZoom(Math.max(50, zoom - 10))} className="p-1 hover:bg-slate-100 rounded border border-slate-300 text-slate-700">
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-xs font-semibold text-slate-800 w-12 text-center">{zoom}%</span>
              <button onClick={() => setZoom(Math.min(200, zoom + 10))} className="p-1 hover:bg-slate-100 rounded border border-slate-300 text-slate-700">
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setZoom(100)} className="text-xs text-blue-600 hover:underline ml-1">100%</button>
            </div>
          </div>
        )}

        {/* ==================== CONVERT TAB ==================== */}
        {activeTab === 'Convert' && (
          <div className="flex items-center space-x-4">
            <button
              onClick={() => fileInputPdfRef.current?.click()}
              className="flex items-center gap-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-700 hover:to-rose-700 text-white px-3.5 py-1.5 rounded shadow-xs text-xs font-semibold transition"
            >
              <FileUp className="w-4 h-4" />
              <span>Convert PDF to Word (.docx)</span>
              <input
                ref={fileInputPdfRef}
                type="file"
                accept=".pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportPdf(file);
                }}
                className="hidden"
              />
            </button>

            <button
              onClick={handleExportPdf}
              className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-3.5 py-1.5 rounded shadow-xs text-xs font-semibold transition"
            >
              <FileDown className="w-4 h-4" />
              <span>Convert Word to PDF</span>
            </button>

            <button
              onClick={() => fileInputDocxRef.current?.click()}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 px-3 py-1.5 rounded text-xs font-semibold transition"
            >
              <Upload className="w-4 h-4 text-blue-600" />
              <span>Open .docx</span>
              <input
                ref={fileInputDocxRef}
                type="file"
                accept=".docx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportDocx(file);
                }}
                className="hidden"
              />
            </button>

            <button
              onClick={() => setShowConvertModal(true)}
              className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 px-3 py-1.5 rounded text-xs font-semibold transition"
            >
              <RefreshCw className="w-4 h-4 text-amber-600" />
              <span>Batch Convert Center</span>
            </button>
          </div>
        )}

        {/* ==================== FILE TAB (BACKSTAGE) ==================== */}
        {activeTab === 'File' && (
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={handleNewDocument} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow-xs transition" title="New Blank Document (Ctrl+N)">
                <FilePlus className="w-4 h-4" />
                <span>New Blank Document</span>
              </button>
              <button onClick={handleLoadTemplate} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 hover:bg-slate-50 rounded text-slate-700 text-xs font-medium transition" title="Load sample template">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <span>Sample Template</span>
              </button>
              <button onClick={app.openDocument} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 hover:bg-slate-50 rounded text-slate-700 text-xs font-medium" title="Open a .docx, .pdf, .html or .txt file (Ctrl+O)">
                <FolderOpen className="w-4 h-4 text-blue-600" />
                <span>Open (.docx)</span>
              </button>
            </div>

            <div className="flex items-center space-x-2 border-r border-slate-200 pr-3">
              <button onClick={handleSaveDocx} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold" title={app.docMeta.handle ? `Save to ${app.docMeta.fileName} (Ctrl+S)` : 'Save (Ctrl+S)'}>
                <Save className="w-4 h-4" />
                <span>Save</span>
              </button>
              <div className="relative">
                <button onClick={() => setShowSaveAs(!showSaveAs)} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 hover:bg-slate-50 rounded text-slate-700 text-xs font-medium" title="Save a copy with a new name, folder or format (Ctrl+Shift+S)">
                  <Download className="w-4 h-4 text-emerald-600" />
                  <span>Save As ▾</span>
                </button>
                {showSaveAs && (
                  <div className="absolute top-9 left-0 z-50 bg-white border border-slate-200 rounded shadow-lg w-60 py-1 text-xs">
                    {[
                      ['docx', 'Word Document (.docx)'],
                      ['pdf', 'PDF (.pdf)'],
                      ['odt', 'OpenDocument Text (.odt)'],
                      ['rtf', 'Rich Text Format (.rtf)'],
                      ['html', 'Web Page (.html)'],
                      ['md', 'Markdown (.md)'],
                      ['txt', 'Plain Text (.txt)']
                    ].map(([k, label]) => (
                      <button key={k} onClick={() => { setShowSaveAs(false); app.handleSaveAs(k); }} className="w-full text-left px-3 py-1.5 hover:bg-slate-100" data-format={k}>{label}</button>
                    ))}
                    <div className="px-3 pt-1 pb-1.5 text-[10px] text-slate-400 border-t border-slate-100 mt-1">
                      {app.fsaSupported ? 'You choose the folder and name.' : 'This browser downloads the file; you will be asked for a name.'} Formats other than .docx are exported copies.
                    </div>
                  </div>
                )}
              </div>
              <button onClick={handleExportPdf} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 hover:bg-slate-50 rounded text-slate-700 text-xs font-medium">
                <FileDown className="w-4 h-4 text-red-600" />
                <span>Export PDF</span>
              </button>
              <button onClick={app.doPrint} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 hover:bg-slate-50 rounded text-slate-700 text-xs font-medium">
                <Printer className="w-4 h-4 text-slate-600" />
                <span>Print</span>
              </button>
            </div>

            <div className="text-[11px] text-slate-600 leading-tight">
              <div><span className="text-slate-400">Name:</span> <strong className="text-slate-800">{documentTitle}</strong> <span className="text-slate-400">(edit in the title bar)</span></div>
              <div><span className="text-slate-400">File:</span> {app.docMeta.fileName || 'not saved yet'} · {app.dirty ? 'unsaved changes' : saveLabel}</div>
            </div>
          </div>
        )}

        {/* ==================== TABLE TAB (contextual) ==================== */}
        {activeTab === 'Table' && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <span className="text-[10px] uppercase font-bold text-slate-400 mr-1">Rows</span>
              <button onClick={() => app.tableOp('rowAbove')} className={smallBtn} title="Insert row above">+ Row above</button>
              <button onClick={() => app.tableOp('rowBelow')} className={smallBtn} title="Insert row below">+ Row below</button>
              <button onClick={() => app.tableOp('deleteRow')} className={smallBtn} title="Delete row">Delete row</button>
            </div>
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <span className="text-[10px] uppercase font-bold text-slate-400 mr-1">Columns</span>
              <button onClick={() => app.tableOp('colLeft')} className={smallBtn} title="Insert column to the left">+ Col left</button>
              <button onClick={() => app.tableOp('colRight')} className={smallBtn} title="Insert column to the right">+ Col right</button>
              <button onClick={() => app.tableOp('deleteCol')} className={smallBtn} title="Delete column">Delete col</button>
            </div>
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <span className="text-[10px] uppercase font-bold text-slate-400 mr-1">Cells</span>
              <button onClick={() => app.tableOp('mergeRight')} className={smallBtn} title="Merge with the cell on the right">Merge right</button>
              <button onClick={() => app.tableOp('mergeDown')} className={smallBtn} title="Merge with the cell below">Merge down</button>
              <button onClick={() => app.tableOp('split')} className={smallBtn} title="Split the cell">Split cell</button>
            </div>
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <button onClick={() => app.tableOp('headerRow')} className={smallBtn} title="Toggle header row">Header row</button>
              <label className="flex items-center gap-1 text-xs text-slate-600" title="Cell shading">
                <input type="color" value={shadeColor} onChange={(e) => setShadeColor(e.target.value)} className="w-6 h-6 p-0 border border-slate-300 rounded cursor-pointer" />
              </label>
              <button onClick={() => app.tableOp('shade', shadeColor)} className={smallBtn}>Shade cell</button>
              <button onClick={() => app.tableOp('shadeRow', shadeColor)} className={smallBtn}>Shade row</button>
            </div>
            <div className="flex items-center space-x-1">
              <button onClick={() => app.tableOp('borders', 'all')} className={smallBtn}>Borders on</button>
              <button onClick={() => app.tableOp('borders', 'none')} className={smallBtn}>Borders off</button>
              <button onClick={() => app.tableOp('deleteTable')} className={`${smallBtn} text-red-700`}>Delete table</button>
            </div>
          </div>
        )}

        {/* ==================== PICTURE TAB (contextual) ==================== */}
        {activeTab === 'Picture' && app.selectedImg && (
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3">
              <span className="text-[10px] uppercase font-bold text-slate-400 mr-1">Wrap text</span>
              <button onClick={() => app.pictureOp('wrap', 'inline')} className={smallBtn}>In line</button>
              <button onClick={() => app.pictureOp('wrap', 'left')} className={smallBtn}>Square left</button>
              <button onClick={() => app.pictureOp('wrap', 'right')} className={smallBtn}>Square right</button>
              <button onClick={() => app.pictureOp('wrap', 'center')} className={smallBtn}>Centered</button>
            </div>
            <div className="flex items-center space-x-1 border-r border-slate-200 pr-3 text-xs text-slate-600">
              <span className="text-[10px] uppercase font-bold text-slate-400 mr-1">Width</span>
              {[25, 50, 75, 100].map((p) => (
                <button key={p} onClick={() => app.pictureOp('width', (parseFloat(getComputedStyle(app.selectedImg.closest('.document-content') || document.body).width) || 600) * p / 100)} className={smallBtn}>{p}%</button>
              ))}
              <input
                type="number"
                min="16"
                placeholder="px"
                defaultValue={Math.round(app.selectedImg.getBoundingClientRect().width / (zoom / 100))}
                key={app.selectedImg.getAttribute('src')?.length}
                onChange={(e) => e.target.value && app.pictureOp('width', Number(e.target.value))}
                className="w-16 border border-slate-300 rounded px-1 py-0.5 text-xs"
                title="Width in pixels"
              />
            </div>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              Alt text
              <input
                type="text"
                defaultValue={app.selectedImg.getAttribute('alt') || ''}
                onChange={(e) => app.pictureOp('alt', e.target.value)}
                className="w-40 border border-slate-300 rounded px-1 py-0.5 text-xs"
              />
            </label>
            <button onClick={() => app.pictureOp('delete')} className={`${smallBtn} text-red-700`}>Delete picture</button>
            <span className="text-[11px] text-slate-500">Drag the blue handle to resize.</span>
          </div>
        )}

        {/* ==================== HELP TAB ==================== */}
        {activeTab === 'Help' && (
          <div className="flex items-center space-x-4">
            <button onClick={() => app.notify('DocStudio Word Pro: a free, offline word processor. Opens and saves .docx, exports PDF, RTF, ODT, HTML, Markdown and text. No account, no cloud.')} className={toolBtn}>
              <HelpCircle className="w-5 h-5 text-blue-600 mb-0.5" />
              <span>About DocStudio</span>
            </button>
            <button onClick={() => app.notify('Ctrl+N new · Ctrl+O open · Ctrl+S save · Ctrl+Shift+S save as · Ctrl+B/I/U format · Ctrl+Z/Y undo/redo · Ctrl+F find & replace · Ctrl+P print')} className={toolBtn}>
              <Type className="w-5 h-5 text-emerald-600 mb-0.5" />
              <span>Shortcuts</span>
            </button>
          </div>
        )}

      </div>
    </header>
  );
}

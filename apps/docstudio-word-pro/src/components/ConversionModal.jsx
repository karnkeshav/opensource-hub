import React, { useState } from 'react';
import { X, FileUp, FileDown, CheckCircle, AlertCircle, RefreshCw, Cpu, Globe } from 'lucide-react';
import { convertPdfToHtml, convertPdfToDocxBackend, exportToPdf } from '../utils/pdfHandler';
import { exportToDocx, importDocxFile } from '../utils/docxHandler';

export default function ConversionModal({
  isOpen,
  onClose,
  onLoadExtractedHtml
}) {
  const [activeTab, setActiveTab] = useState('pdf-to-word'); // 'pdf-to-word' | 'word-to-pdf'
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [conversionSuccess, setConversionSuccess] = useState(false);
  const [engineMode, setEngineMode] = useState('auto'); // 'auto', 'browser', 'backend'

  if (!isOpen) return null;

  const handleFileDrop = (e) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      validateAndSetFile(droppedFile);
    }
  };

  const handleFileInput = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      validateAndSetFile(selectedFile);
    }
  };

  const validateAndSetFile = (f) => {
    setError('');
    setConversionSuccess(false);
    if (activeTab === 'pdf-to-word' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Please select a valid .pdf file.');
      return;
    }
    if (activeTab === 'word-to-pdf' && !f.name.toLowerCase().endsWith('.docx')) {
      setError('Please select a valid .docx file.');
      return;
    }
    setFile(f);
  };

  const startConversion = async () => {
    if (!file) return;
    setIsProcessing(true);
    setError('');
    setStatusMessage('Reading and analyzing document structure...');

    try {
      if (activeTab === 'pdf-to-word') {
        setStatusMessage('Extracting font glyphs, line coordinates, and headings...');
        
        // Check if user wants backend or browser
        if (engineMode === 'backend') {
          const backendResult = await convertPdfToDocxBackend(file);
          if (backendResult.success) {
            const url = URL.createObjectURL(backendResult.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name.replace(/\.[^/.]+$/, "") + ".docx";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setConversionSuccess(true);
            setIsProcessing(false);
            return;
          }
        }

        // Open-source Browser Engine (pdfjs-dist + docx)
        const { html, pageCount } = await convertPdfToHtml(file);
        setStatusMessage(`Successfully reconstructed ${pageCount} pages. Building Word (.docx)...`);

        // Offer to load directly into DocStudio Editor
        onLoadExtractedHtml(html, file.name.replace(/\.[^/.]+$/, ""));
        
        // Also download .docx directly
        await exportToDocx(html, file.name.replace(/\.[^/.]+$/, ""));
        
        setConversionSuccess(true);
        setStatusMessage('Conversion complete! File downloaded & loaded into editor.');

      } else if (activeTab === 'word-to-pdf') {
        setStatusMessage('Parsing Word document layout & styles...');
        const { html } = await importDocxFile(file);
        
        // Render temporarily and export via vector PDF
        const tempContainer = document.createElement('div');
        tempContainer.className = 'document-content';
        tempContainer.style.width = '698px';
        tempContainer.style.padding = '48px';
        tempContainer.style.fontFamily = 'Calibri, Arial, sans-serif';
        tempContainer.style.fontSize = '11pt';
        tempContainer.style.lineHeight = '1.5';
        tempContainer.style.color = '#1e293b';
        tempContainer.style.background = '#ffffff';
        tempContainer.style.position = 'fixed';
        tempContainer.style.left = '-9999px';
        tempContainer.innerHTML = html;
        document.body.appendChild(tempContainer);

        setStatusMessage('Rendering PDF with selectable text...');
        try {
          await exportToPdf(tempContainer, file.name.replace(/\.[^/.]+$/, ""), 'a4', 'p', { marginPx: 48 });
        } finally {
          document.body.removeChild(tempContainer);
        }

        setConversionSuccess(true);
        setStatusMessage('PDF generated and downloaded successfully!');
      }
    } catch (err) {
      console.error(err);
      setError(`Conversion error: ${err.message || 'Failed to process document'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200">
        
        {/* Header */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <RefreshCw className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold text-base">Open-Source Document Converter</h3>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-200 bg-slate-50 text-xs font-semibold">
          <button
            onClick={() => { setActiveTab('pdf-to-word'); setFile(null); setConversionSuccess(false); }}
            className={`flex-1 py-3 text-center transition ${
              activeTab === 'pdf-to-word'
                ? 'bg-white text-blue-600 border-b-2 border-blue-600'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            PDF to Word (.docx)
          </button>
          <button
            onClick={() => { setActiveTab('word-to-pdf'); setFile(null); setConversionSuccess(false); }}
            className={`flex-1 py-3 text-center transition ${
              activeTab === 'word-to-pdf'
                ? 'bg-white text-blue-600 border-b-2 border-blue-600'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Word (.docx) to PDF
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6">
          {/* Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            className="border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl p-8 flex flex-col items-center justify-center bg-slate-50/50 hover:bg-blue-50/20 transition cursor-pointer"
            onClick={() => document.getElementById('conversion-file-input')?.click()}
          >
            {activeTab === 'pdf-to-word' ? (
              <FileUp className="w-12 h-12 text-red-500 mb-3" />
            ) : (
              <FileDown className="w-12 h-12 text-blue-600 mb-3" />
            )}

            <p className="text-sm font-medium text-slate-700 text-center">
              {file ? (
                <span className="text-blue-600 font-semibold">{file.name}</span>
              ) : (
                <span>Drag & drop your {activeTab === 'pdf-to-word' ? 'PDF' : 'Word'} file here, or browse</span>
              )}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              100% Private & Open-Source • No Adobe or Cloud API required
            </p>

            <input
              id="conversion-file-input"
              type="file"
              accept={activeTab === 'pdf-to-word' ? '.pdf' : '.docx'}
              onChange={handleFileInput}
              className="hidden"
            />
          </div>

          {/* Engine Selector */}
          <div className="mt-4 flex items-center justify-between text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <span className="font-medium flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-600" />
              Conversion Engine:
            </span>
            <div className="flex space-x-1">
              <button
                type="button"
                onClick={() => setEngineMode('auto')}
                className={`px-2 py-0.5 rounded text-[11px] ${engineMode === 'auto' ? 'bg-blue-600 text-white font-medium' : 'hover:bg-slate-200'}`}
              >
                Auto (Recommended)
              </button>
              <button
                type="button"
                onClick={() => setEngineMode('browser')}
                className={`px-2 py-0.5 rounded text-[11px] ${engineMode === 'browser' ? 'bg-blue-600 text-white font-medium' : 'hover:bg-slate-200'}`}
              >
                Client-Side (Offline)
              </button>
              <button
                type="button"
                onClick={() => setEngineMode('backend')}
                className={`px-2 py-0.5 rounded text-[11px] ${engineMode === 'backend' ? 'bg-blue-600 text-white font-medium' : 'hover:bg-slate-200'}`}
              >
                Python pdf2docx
              </button>
            </div>
          </div>

          {/* Feedback & Progress */}
          {isProcessing && (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center space-x-3 text-xs text-blue-800">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {conversionSuccess && (
            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center space-x-2 text-xs text-emerald-800">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg flex items-center space-x-2 text-xs text-rose-800">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="mt-6 flex justify-end space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition"
            >
              Cancel
            </button>
            <button
              disabled={!file || isProcessing}
              onClick={startConversion}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-xs transition flex items-center gap-2"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Converting...</span>
                </>
              ) : (
                <span>Convert & Download</span>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

import { buildDocxBlob } from './docxHandler';
import { buildPdf } from './pdfHandler';
import { htmlToTxt, htmlToMd, htmlToStandalone, htmlToRtf, htmlToOdt } from './exporters';

export const FORMATS = {
  docx: { ext: '.docx', label: 'Word Document (.docx)', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { ext: '.pdf', label: 'PDF (.pdf)', mime: 'application/pdf' },
  odt: { ext: '.odt', label: 'OpenDocument Text (.odt)', mime: 'application/vnd.oasis.opendocument.text' },
  rtf: { ext: '.rtf', label: 'Rich Text Format (.rtf)', mime: 'application/rtf' },
  html: { ext: '.html', label: 'Web Page (.html)', mime: 'text/html' },
  md: { ext: '.md', label: 'Markdown (.md)', mime: 'text/markdown' },
  txt: { ext: '.txt', label: 'Plain Text (.txt)', mime: 'text/plain' }
};

export const fsaSupported = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

export const safeName = (title) => (String(title || 'Document').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'Document');

/**
 * Produce the file contents for a format.
 * @param {string} format key of FORMATS
 * @param {{html:string,title:string,pageSetup:object,header:string,footer:string,author:string,editorEl:HTMLElement,marginPx:number,pageColor?:string}} ctx
 * @returns {Promise<Blob>}
 */
export async function makeBlob(format, ctx) {
  const { html, title, pageSetup, header, footer, author } = ctx;
  const opts = { pageSetup, header, footer, author };
  const mime = FORMATS[format].mime;
  switch (format) {
    case 'docx': return buildDocxBlob(html, title, opts);
    case 'pdf': {
      const pdf = await buildPdf(ctx.editorEl, pageSetup.paperSize, pageSetup.orientation === 'landscape' ? 'l' : 'p', { marginPx: ctx.marginPx, header, footer, pageColor: pageSetup.pageColor });
      pdf.setProperties({ title, author, creator: 'DocStudio Word Pro' });
      return pdf.output('blob');
    }
    case 'odt': return htmlToOdt(html, title, opts);
    case 'rtf': return new Blob([await htmlToRtf(html, title, opts)], { type: mime });
    case 'html': return new Blob([htmlToStandalone(html, title, opts)], { type: `${mime};charset=utf-8` });
    case 'md': return new Blob([`${htmlToMd(html)}`], { type: `${mime};charset=utf-8` });
    case 'txt': return new Blob([htmlToTxt(html)], { type: `${mime};charset=utf-8` });
    default: throw new Error(`Unknown format: ${format}`);
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Write a blob to disk.
 *  - handle given and !forcePicker: overwrite that same file (File System Access API).
 *  - otherwise: show the native "Save as" picker (folder + filename) when supported.
 *  - fallback: browser download using `fallbackName`.
 * @returns {Promise<{handle: FileSystemFileHandle|null, name: string, via: 'fsa'|'download'}|null>} null when the user cancelled
 */
export async function writeBlob(blob, { format, handle, forcePicker, suggestedName, fallbackName }) {
  const fmt = FORMATS[format];
  if (fsaSupported()) {
    try {
      let h = handle;
      if (h && !forcePicker) {
        const perm = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' || (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
        if (!perm) h = null;
      }
      if (!h || forcePicker) {
        h = await window.showSaveFilePicker({
          suggestedName: `${safeName(suggestedName)}${fmt.ext}`,
          types: [{ description: fmt.label, accept: { [fmt.mime]: [fmt.ext] } }]
        });
      }
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return { handle: h, name: h.name, via: 'fsa' };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      if (!(err && (err.name === 'SecurityError' || err.name === 'NotAllowedError' || err.name === 'TypeError'))) throw err;
      // fall through to a normal download
    }
  }
  const name = fallbackName || `${safeName(suggestedName)}${fmt.ext}`;
  downloadBlob(blob, name);
  return { handle: null, name, via: 'download' };
}

/* ----------------------- crash-recovery copy (IndexedDB) ----------------------- */
const DB = 'docstudio';
const STORE = 'recovery';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const recovery = {
  async save(data) {
    try {
      const db = await openDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ ...data, savedAt: Date.now() }, 'current');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return true;
    } catch { return false; }
  },
  async load() {
    try {
      const db = await openDb();
      const v = await new Promise((res, rej) => {
        const r = db.transaction(STORE).objectStore(STORE).get('current');
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return v;
    } catch { return null; }
  },
  async clear() {
    try {
      const db = await openDb();
      await new Promise((res) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete('current');
        tx.oncomplete = res;
        tx.onerror = res;
      });
      db.close();
    } catch { /* ignore */ }
  }
};

// Shared helpers for tests: build PDFs with the app's own writer, reopen, extract text.
import { PDFDoc } from '../src/pdf/doc.js';
import { saveFull, saveIncremental } from '../src/pdf/writer.js';
import { newDoc, addPage, addText } from '../src/pdf/edit.js';
import { analyze, layout } from '../src/pdf/text.js';
import { bin } from '../src/pdf/obj.js';

export async function sampleDoc(pages = 3, text = (i) => `Hello page ${i + 1} secret 555-123-4567 user@example.com`) {
  const d = newDoc();
  for (let i = 0; i < pages; i++) {
    addPage(d, 612, 792);
    addText(d, i, text(i), { x: 72, y: 700, size: 14 });
    addText(d, i, 'Second line on page ' + (i + 1), { x: 72, y: 600, size: 12 });
  }
  return d;
}
export const reopen = async (doc, opts) => PDFDoc.load(await saveFull(doc, opts));
export const reopenInc = async (doc) => PDFDoc.load(await saveIncremental(doc));
export async function pageText(doc, i) { const a = await analyze(doc, doc.pages[i]); return layout(a.chars).text; }
export async function allText(doc) { let s = ''; for (let i = 0; i < doc.pageCount; i++) s += (await pageText(doc, i)) + '\n'; return s; }
export const latin = (u8) => bin(u8);
export { PDFDoc, saveFull, saveIncremental };

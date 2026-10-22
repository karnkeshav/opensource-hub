// The heavy libraries (docx, mammoth, JSZip, jsPDF) live in one pre-built ES module that is embedded
// as a plain string. It is only parsed/evaluated the first time a document is saved, opened or exported,
// which keeps startup fast and memory low. Works offline and from file:// (blob URL, no network).
import officeSrc from '../generated/office.lib.mjs?raw';

let pending = null;

export function loadOffice() {
  if (!pending) {
    pending = (async () => {
      const url = URL.createObjectURL(new Blob([officeSrc], { type: 'text/javascript' }));
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    })();
    pending.catch(() => { pending = null; });
  }
  return pending;
}

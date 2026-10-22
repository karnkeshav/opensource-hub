// Autosave recovery copy in IndexedDB (this browser only) and small preferences.
import { saveFull } from '../pdf/writer.js';
import { h, toast } from './util.js';

const DB = 'pdfstudio', ST = 'recovery';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(ST, mode); const s = t.objectStore(ST); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); }
let timer = 0;
export const recovery = {
  schedule(app) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!app.doc || !app.doc.dirty) return;
      try {
        const bytes = await saveFull(app.doc, { objStreams: true });
        if (bytes.length > 200e6) return;
        await tx('readwrite', (s) => s.put({ name: app.name, bytes, time: Date.now(), pages: app.doc.pageCount }, 'current'));
      } catch (e) { console.warn('autosave failed', e); }
    }, 4000);
  },
  clear() { clearTimeout(timer); tx('readwrite', (s) => s.delete('current')).catch(() => {}); },
  async get() { try { return await tx('readonly', (s) => s.get('current')); } catch { return null; } },
  async offer(app) {
    const r = await this.get();
    if (!r || !r.bytes) return;
    const box = document.getElementById('recover');
    const when = new Date(r.time).toLocaleString();
    box.append(h('div', { class: 'citem', role: 'region', 'aria-label': 'Recovery' },
      h('div', null, 'Unsaved work found: ', h('b', null, r.name), ` (${r.pages} pages, ${when})`),
      h('div', { class: 'row', style: { justifyContent: 'flex-start', margin: '8px 0 0' } },
        h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { box.innerHTML = ''; await app.openBytes(r.bytes, r.name); if (app.doc) { app.doc.dirty = true; app.markDirty(); toast('Recovered your unsaved copy. Save it to keep it.'); } } }, 'Restore'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { box.innerHTML = ''; this.clear(); } }, 'Discard'))));
  },
};

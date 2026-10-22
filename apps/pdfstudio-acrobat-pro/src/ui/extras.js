// Compare and batch tools. OCR needs a recognition engine and is not bundled in this build.
import { toast, dialog, download, pickFile, fmtSize } from './util.js';
import { analyze, layout } from '../pdf/text.js';
import { saveFull } from '../pdf/writer.js';
import * as E from '../pdf/edit.js';
import { openOther } from './commands.js';

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Text lines of every page, each tagged with its page number.
async function docLines(doc, app, label) {
  const out = [];
  for (let i = 0; i < doc.pageCount; i++) {
    if (i % 10 === 0) app.msg(`${label}: reading page ${i + 1}…`);
    const a = await analyze(doc, doc.pages[i]);
    for (const l of layout(a.chars).text.split('\n')) { const t = l.replace(/\s+/g, ' ').trim(); if (t) out.push({ t, page: i + 1 }); }
  }
  return out;
}

// Longest-common-subsequence line diff -> [{op: '=' | '-' | '+', ...line}]
function diffLines(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i].t === b[j].t ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].t === b[j].t) { out.push({ op: '=', ...a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ op: '-', ...a[i++] });
    else out.push({ op: '+', ...b[j++] });
  }
  while (i < n) out.push({ op: '-', ...a[i++] });
  while (j < m) out.push({ op: '+', ...b[j++] });
  return out;
}

export async function compareDocs(app) {
  const [f] = await pickFile('.pdf,application/pdf');
  if (!f) return;
  const other = await openOther(f);
  if (!other) return;
  const a = await docLines(app.doc, app, 'Current'), b = await docLines(other, app, f.name);
  app.msg('Comparing…');
  if (a.length * b.length > 40e6) { app.msg(''); toast('These documents are too large to compare line by line'); return; }
  const d = diffLines(a, b);
  app.msg('');
  const removed = d.filter((x) => x.op === '-').length, added = d.filter((x) => x.op === '+').length;
  if (!removed && !added) { toast('No text differences found'); return; }
  const rows = d.filter((x) => x.op !== '=').map((x) => `<tr class="${x.op === '-' ? 'del' : 'add'}"><td>${x.op === '-' ? esc(app.name) : esc(f.name)} p.${x.page}</td><td>${x.op}</td><td>${esc(x.t)}</td></tr>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Comparison</title><style>body{font:14px system-ui;margin:2em}table{border-collapse:collapse;width:100%}td{padding:3px 8px;border-bottom:1px solid #ddd}.del{background:#fde8e8}.add{background:#e6f6e6}</style><h1>Text comparison</h1><p>${esc(app.name)} (${a.length} lines) vs ${esc(f.name)} (${b.length} lines): ${removed} removed, ${added} added.</p><table>${rows}</table>`;
  const v = await dialog('Comparison', [], { hint: `${removed} lines only in ${app.name}, ${added} lines only in ${f.name}. Download a full report?`, ok: 'Download report' });
  if (v) download('comparison.html', html, 'text/html;charset=utf-8');
}

export async function ocrPages() { toast('OCR needs a recognition engine, which is not bundled in this build'); }

export async function batch(app) {
  const files = await pickFile('.pdf,application/pdf', true);
  if (!files.length) return;
  const v = await dialog('Batch process', [
    { name: 'op', label: 'Action', type: 'select', value: 'merge', options: [['merge', 'Merge into one PDF'], ['optimize', 'Re-save each with object streams (smaller)']] },
  ], { ok: 'Run', hint: `${files.length} file(s) selected.` });
  if (!v) return;
  if (v.op === 'merge') {
    const out = await openOther(files[0]);
    if (!out) return;
    for (const f of files.slice(1)) { const src = await openOther(f); if (src) E.importPages(out, src, src.pages.map((_, i) => i)); }
    download('merged.pdf', await saveFull(out, { objStreams: true }), 'application/pdf');
    toast(`Merged ${files.length} files`);
    return;
  }
  for (const f of files) {
    app.msg(`Processing ${f.name}…`);
    const doc = await openOther(f);
    if (!doc) continue;
    const bytes = await saveFull(doc, { objStreams: true });
    download(f.name.replace(/\.pdf$/i, '') + '-optimized.pdf', bytes, 'application/pdf');
    toast(`${f.name}: ${fmtSize(f.size)} → ${fmtSize(bytes.length)}`);
  }
  app.msg('');
}

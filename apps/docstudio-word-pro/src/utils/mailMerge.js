const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

/** Parse CSV text (comma, semicolon or tab separated; quoted fields; CRLF) into headers + records. */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!clean.length) return { headers: [], rows: [] };

  const seen = {};
  const headers = clean[0].map((h, i) => {
    const base = h.trim() || `Field${i + 1}`;
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] > 1 ? `${base}_${seen[base]}` : base;
  });
  const data = clean.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, rows: data };
}

/** HTML for a merge-field chip: «Name». */
export function fieldChipHtml(name) {
  // No contenteditable="false": Chrome's insertHTML hoists such a span out of its paragraph at line end.
  return `<span class="merge-field" data-field="${escAttr(name)}">«${escHtml(name)}»</span>&nbsp;`;
}

/** Fill every chip under `root` from `record` (leave chips whose field is unknown). Returns number filled. */
export function showRecord(root, record) {
  let n = 0;
  root.querySelectorAll('.merge-field').forEach((chip) => {
    const f = chip.getAttribute('data-field');
    if (record && Object.prototype.hasOwnProperty.call(record, f)) {
      chip.textContent = record[f];
      chip.classList.add('merged');
      n++;
    }
  });
  return n;
}

/** Put the «Field» placeholders back. */
export function showFields(root) {
  root.querySelectorAll('.merge-field').forEach((chip) => {
    chip.textContent = `«${chip.getAttribute('data-field')}»`;
    chip.classList.remove('merged');
  });
}

/** One copy of the template per record, separated by page breaks, as an HTML string. */
export function buildCombinedHtml(templateHtml, records) {
  const parts = records.map((rec) => {
    const box = document.createElement('div');
    box.innerHTML = templateHtml;
    box.querySelectorAll('.merge-field').forEach((chip) => {
      const f = chip.getAttribute('data-field');
      if (Object.prototype.hasOwnProperty.call(rec, f)) chip.replaceWith(document.createTextNode(rec[f]));
    });
    return box.innerHTML;
  });
  return parts.join('<div class="page-break"></div>');
}

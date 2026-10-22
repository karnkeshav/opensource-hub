// CSV / TSV parsing and writing (RFC 4180 quoting, delimiter sniffing).
export function sniff(text) {
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5).join('\n');
  let best = ',', n = -1;
  for (const d of [',', '\t', ';', '|']) {
    const k = head.split(d).length;
    if (k > n) { n = k; best = d; }
  }
  return best;
}

export function parseCSV(text, delim) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  delim = delim || sniff(text);
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { q = true; i++; }
    else if (ch === delim) { row.push(field); field = ''; i++; }
    else if (ch === '\n' || ch === '\r') {
      row.push(field); field = ''; rows.push(row); row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else { field += ch; i++; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCSV(rows, delim = ',') {
  const esc = (s) => (s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return rows.map((r) => r.map((v) => esc(String(v ?? ''))).join(delim)).join('\r\n');
}

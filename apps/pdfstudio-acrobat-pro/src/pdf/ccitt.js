// CCITT Group 3 (1D/2D) and Group 4 fax decoder for CCITTFaxDecode streams. Output: packed 1 bpp rows, 1 = white (unless BlackIs1).
const WT = '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100';
const WM = '11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011';
const BT = '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111';
const BM = '0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101';
const XM = '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111';
let TABLES;
function tables() {
  if (TABLES) return TABLES;
  const mk = (term, mk) => {
    const m = new Map();
    const add = (c, v) => m.set(c.length * 65536 + parseInt(c, 2), v);
    term.split(' ').forEach((c, i) => add(c, i));
    mk.split(' ').forEach((c, i) => add(c, (i + 1) * 64));
    XM.split(' ').forEach((c, i) => add(c, 1792 + i * 64));
    return m;
  };
  const modes = new Map();
  [['1', 0], ['011', 1], ['010', -1], ['000011', 2], ['000010', -2], ['0000011', 3], ['0000010', -3], ['001', 'H'], ['0001', 'P']].forEach(([c, v]) => modes.set(c.length * 65536 + parseInt(c, 2), v));
  return (TABLES = { w: mk(WT, WM), b: mk(BT, BM), modes });
}

export function ccittDecode(src, prm, get = (x) => x) {
  const T = tables();
  const g = (k, d) => { const v = get(prm.get(k)); return v === undefined ? d : v; };
  const K = g('K', 0), cols = g('Columns', 1728), rowsWanted = g('Rows', 0), align = g('EncodedByteAlign', false), black1 = g('BlackIs1', false);
  const rowBytes = (cols + 7) >> 3;
  let pos = 0; // bit position
  const total = src.length * 8;
  const bit = () => (pos < total ? (src[pos >> 3] >> (7 - (pos++ & 7))) & 1 : (pos++, -1));
  const read = (map, maxLen = 13) => {
    let code = 0;
    for (let len = 1; len <= maxLen; len++) {
      const b = bit(); if (b < 0) return undefined;
      code = (code << 1) | b;
      const v = map.get(len * 65536 + code);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const run = (white) => {
    let t = 0;
    for (;;) { const r = read(white ? T.w : T.b); if (r === undefined) return -1; t += r; if (r < 64) return t; }
  };
  const skipEOL = () => { // skip fill + EOL if present; returns true if an EOL was found
    const save = pos; let z = 0;
    while (pos < total && bit() === 0) z++;
    if (z >= 11) return true;
    pos = save; return false;
  };
  const rows = [];
  let ref = [cols, cols];
  while (pos < total && (!rowsWanted || rows.length < rowsWanted)) {
    if (align && pos & 7) pos = (pos + 7) & ~7;
    let twoD = K < 0;
    if (K >= 0) {
      const eol = skipEOL();
      if (eol && pos >= total - 8 && rows.length) break;
      if (K > 0) twoD = bit() === 0;
    } else {
      const save = pos;
      if (skipEOL()) { if (skipEOL() || pos >= total - 16) break; pos = save; }
    }
    const cur = [];
    let a0 = -1, color = 0, ok = true;
    if (!twoD) {
      let x = 0, white = true;
      while (x < cols) {
        const r = run(white); if (r < 0) { ok = false; break; }
        x += r; cur.push(Math.min(x, cols)); white = !white;
      }
    } else {
      while (a0 < cols) {
        const start = a0 < 0 ? 0 : a0;
        // b1: first changing element on ref > a0 with parity matching a change away from `color`
        let b1i = 0;
        for (b1i = 0; b1i < ref.length; b1i++) if (ref[b1i] > a0 && (b1i & 1) === color) { if (a0 >= 0 || ref[b1i] >= 0) break; }
        const b1 = b1i < ref.length ? ref[b1i] : cols, b2 = b1i + 1 < ref.length ? ref[b1i + 1] : cols;
        const m = read(T.modes, 7);
        if (m === undefined) { ok = false; break; }
        if (m === 'P') { a0 = b2; continue; }
        if (m === 'H') {
          const r1 = run(color === 0), r2 = run(color !== 0);
          if (r1 < 0 || r2 < 0) { ok = false; break; }
          const a1 = Math.min(start + r1, cols), a2 = Math.min(a1 + r2, cols);
          cur.push(a1, a2); a0 = a2;
          continue;
        }
        const a1 = Math.max(0, Math.min(b1 + m, cols));
        cur.push(a1); a0 = a1; color ^= 1;
      }
    }
    if (!ok && !cur.length) break;
    // paint the row: elements alternate white->black->white starting with white at 0
    const row = new Uint8Array(rowBytes).fill(black1 ? 0 : 255);
    let x = 0, c = 0;
    for (const e of [...cur, cols]) {
      const end = Math.min(e, cols);
      if (c === 1) for (let p = x; p < end; p++) { if (black1) row[p >> 3] |= 128 >> (p & 7); else row[p >> 3] &= ~(128 >> (p & 7)); }
      x = Math.max(x, end); c ^= 1;
    }
    rows.push(row);
    ref = [...cur, cols, cols];
    if (!ok) break;
  }
  const out = new Uint8Array(rows.length * rowBytes);
  rows.forEach((r, i) => out.set(r, i * rowBytes));
  return out;
}

import { closest, replaceNode } from './editorOps';

// Table editing. Each operation mutates a CLONE of the table, then the live table is swapped
// for the clone with execCommand('insertHTML'), so Ctrl+Z undoes it as one step.

const CELL_STYLE = 'border: 1px solid #cbd5e1; padding: 8px 12px;';

function buildGrid(table) {
  const rows = Array.from(table.rows);
  const g = rows.map(() => []);
  rows.forEach((tr, r) => {
    let c = 0;
    Array.from(tr.cells).forEach((cell) => {
      while (g[r][c]) c++;
      const rs = cell.rowSpan || 1;
      const cs = cell.colSpan || 1;
      for (let i = 0; i < rs; i++) {
        for (let j = 0; j < cs; j++) {
          if (g[r + i]) g[r + i][c + j] = { cell, r, c, origin: i === 0 && j === 0 };
        }
      }
      c += cs;
    });
  });
  return g;
}

const newCell = (doc, like) => {
  const td = doc.createElement('td');
  td.setAttribute('style', like && like.getAttribute('style') && like.tagName === 'TD' ? like.getAttribute('style') : CELL_STYLE);
  td.innerHTML = '<br>';
  return td;
};

const posOf = (grid, cell) => {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) if (grid[r][c] && grid[r][c].cell === cell) return { r, c };
  }
  return { r: 0, c: 0 };
};

/** Insert `cell` into row `tr` so that it ends up at grid column `col`. */
function insertCellAt(grid, tr, r, col, cell) {
  let ref = null;
  for (const existing of Array.from(tr.cells)) {
    const p = posOf(grid, existing);
    if (p.r === r && p.c >= col) { ref = existing; break; }
  }
  tr.insertBefore(cell, ref);
}

const isEmptyCell = (cell) => !cell.textContent.trim() && !cell.querySelector('img');

const OPS = {
  rowAbove(table, cell) {
    const g = buildGrid(table);
    const { r } = posOf(g, cell);
    const ref = table.rows[r];
    const tr = table.ownerDocument.createElement('tr');
    const seen = new Set();
    for (let c = 0; c < (g[r] || []).length; c++) {
      const here = g[r][c];
      if (!here) continue;
      if (r > 0 && g[r - 1][c] && g[r - 1][c].cell === here.cell) {
        if (!seen.has(here.cell)) { here.cell.rowSpan = (here.cell.rowSpan || 1) + 1; seen.add(here.cell); }
        continue;
      }
      tr.appendChild(newCell(table.ownerDocument, here.cell));
    }
    const parent = ref.parentNode;
    if (parent.tagName === 'THEAD') {
      const tb = table.tBodies[0] || table.appendChild(table.ownerDocument.createElement('tbody'));
      tb.insertBefore(tr, tb.firstChild);
    } else parent.insertBefore(tr, ref);
    return { r: Math.max(0, r), c: posOf(g, cell).c };
  },
  rowBelow(table, cell) {
    const g = buildGrid(table);
    const { r: r0 } = posOf(g, cell);
    const t = r0 + (cell.rowSpan || 1) - 1;
    const ref = table.rows[t];
    const tr = table.ownerDocument.createElement('tr');
    const seen = new Set();
    for (let c = 0; c < (g[t] || []).length; c++) {
      const here = g[t][c];
      if (!here) continue;
      if (g[t + 1] && g[t + 1][c] && g[t + 1][c].cell === here.cell) {
        if (!seen.has(here.cell)) { here.cell.rowSpan = (here.cell.rowSpan || 1) + 1; seen.add(here.cell); }
        continue;
      }
      tr.appendChild(newCell(table.ownerDocument, here.cell));
    }
    const parent = ref.parentNode;
    if (parent.tagName === 'THEAD') {
      const tb = table.tBodies[0] || table.appendChild(table.ownerDocument.createElement('tbody'));
      tb.insertBefore(tr, tb.firstChild);
    } else parent.insertBefore(tr, ref.nextSibling);
    return { r: t + 1, c: posOf(g, cell).c };
  },
  colLeft(table, cell) { return insertColumn(table, cell, false); },
  colRight(table, cell) { return insertColumn(table, cell, true); },
  deleteRow(table, cell) {
    const g = buildGrid(table);
    const { r } = posOf(g, cell);
    if (table.rows.length <= 1) return OPS.deleteTable(table);
    const seen = new Set();
    for (let c = 0; c < g[r].length; c++) {
      const here = g[r][c];
      if (!here || seen.has(here.cell)) continue;
      seen.add(here.cell);
      if (here.r < r && (here.cell.rowSpan || 1) > 1) here.cell.rowSpan -= 1;
    }
    table.rows[r].remove();
    return { r: Math.min(r, table.rows.length - 1), c: 0 };
  },
  deleteCol(table, cell) {
    const g = buildGrid(table);
    const { c: c0 } = posOf(g, cell);
    const width = Math.max(...g.map((row) => row.length));
    if (width <= 1) return OPS.deleteTable(table);
    const seen = new Set();
    g.forEach((row) => {
      const here = row[c0];
      if (!here || seen.has(here.cell)) return;
      seen.add(here.cell);
      if ((here.cell.colSpan || 1) > 1) here.cell.colSpan -= 1;
      else here.cell.remove();
    });
    return { r: 0, c: Math.max(0, c0 - 1) };
  },
  deleteTable() { return { remove: true }; },
  mergeRight(table, cell) {
    const g = buildGrid(table);
    const { r, c } = posOf(g, cell);
    const next = g[r][c + (cell.colSpan || 1)];
    if (!next || !next.origin || next.r !== r || (next.cell.rowSpan || 1) !== (cell.rowSpan || 1)) return false;
    if (!isEmptyCell(next.cell)) {
      if (isEmptyCell(cell)) cell.innerHTML = next.cell.innerHTML;
      else cell.innerHTML += `<br>${next.cell.innerHTML}`;
    }
    cell.colSpan = (cell.colSpan || 1) + (next.cell.colSpan || 1);
    next.cell.remove();
    return { r, c };
  },
  mergeDown(table, cell) {
    const g = buildGrid(table);
    const { r, c } = posOf(g, cell);
    const below = g[r + (cell.rowSpan || 1)] && g[r + (cell.rowSpan || 1)][c];
    if (!below || !below.origin || below.c !== c || (below.cell.colSpan || 1) !== (cell.colSpan || 1)) return false;
    if (!isEmptyCell(below.cell)) {
      if (isEmptyCell(cell)) cell.innerHTML = below.cell.innerHTML;
      else cell.innerHTML += `<br>${below.cell.innerHTML}`;
    }
    cell.rowSpan = (cell.rowSpan || 1) + (below.cell.rowSpan || 1);
    below.cell.remove();
    return { r, c };
  },
  split(table, cell) {
    const g = buildGrid(table);
    const { r, c } = posOf(g, cell);
    const cs = cell.colSpan || 1;
    const rs = cell.rowSpan || 1;
    const doc = table.ownerDocument;
    if (cs > 1) {
      cell.removeAttribute('colspan');
      for (let i = 1; i < cs; i++) {
        const nc = newCell(doc, cell);
        nc.rowSpan = rs > 1 ? rs : 1;
        if (rs === 1) nc.removeAttribute('rowspan');
        cell.parentNode.insertBefore(nc, cell.nextSibling);
      }
      return { r, c };
    }
    if (rs > 1) {
      cell.removeAttribute('rowspan');
      for (let i = 1; i < rs; i++) {
        const tr = table.rows[r + i];
        if (tr) insertCellAt(g, tr, r + i, c, newCell(doc, cell));
      }
      return { r, c };
    }
    // Plain cell: split into two columns by widening every other row's cell.
    const seen = new Set([cell]);
    g.forEach((row) => {
      const here = row[c];
      if (here && !seen.has(here.cell)) { seen.add(here.cell); here.cell.colSpan = (here.cell.colSpan || 1) + 1; }
    });
    cell.parentNode.insertBefore(newCell(doc, cell), cell.nextSibling);
    return { r, c };
  },
  headerRow(table, cell) {
    const g = buildGrid(table);
    const { r } = posOf(g, cell);
    const row = table.rows[r];
    const makeHeader = !Array.from(row.cells).every((x) => x.tagName === 'TH');
    Array.from(row.cells).forEach((x) => {
      const tag = makeHeader ? 'th' : 'td';
      const n = table.ownerDocument.createElement(tag);
      Array.from(x.attributes).forEach((a) => n.setAttribute(a.name, a.value));
      if (makeHeader) n.style.backgroundColor = n.style.backgroundColor || '#f8fafc';
      n.innerHTML = x.innerHTML;
      x.replaceWith(n);
    });
    return { r, c: 0 };
  },
  shade(table, cell, color) {
    cell.style.backgroundColor = color || '';
    const g = buildGrid(table);
    return posOf(g, cell);
  },
  shadeRow(table, cell, color) {
    const g = buildGrid(table);
    const { r } = posOf(g, cell);
    Array.from(table.rows[r].cells).forEach((x) => { x.style.backgroundColor = color || ''; });
    return { r, c: posOf(g, cell).c };
  },
  borders(table, cell, mode) {
    table.querySelectorAll('td,th').forEach((x) => {
      x.style.border = mode === 'none' ? 'none' : '1px solid #cbd5e1';
    });
    const g = buildGrid(table);
    return posOf(g, cell);
  }
};

function insertColumn(table, cell, right) {
  const g = buildGrid(table);
  const { c: c0 } = posOf(g, cell);
  const doc = table.ownerDocument;
  const c = right ? c0 + (cell.colSpan || 1) : c0;
  const grown = new Set();
  g.forEach((row, r) => {
    const left = row[c - 1];
    const here = row[c];
    if (left && here && left.cell === here.cell) {
      if (!grown.has(here.cell)) { here.cell.colSpan = (here.cell.colSpan || 1) + 1; grown.add(here.cell); }
      return;
    }
    const probe = row[c] || row[c - 1];
    insertCellAt(g, table.rows[r], r, c, newCell(doc, probe && probe.cell));
  });
  return { r: posOf(g, cell).r, c: right ? c0 : c0 + 1 };
}

/** The table cell holding the caret, or null. */
export function currentCell(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node || !editor.contains(node)) return null;
  return closest(node, 'td,th', editor);
}

const placeCaret = (cell) => {
  if (!cell) return;
  const r = document.createRange();
  r.selectNodeContents(cell);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
};

/**
 * Run a table operation on the table that holds the caret.
 * @returns {boolean} whether anything changed
 */
export function applyTableOp(editor, op, arg) {
  const cell = currentCell(editor);
  if (!cell || !OPS[op]) return false;
  const table = closest(cell, 'table', editor);
  if (!table) return false;
  const rIdx = Array.from(table.rows).indexOf(cell.parentNode);
  const cIdx = Array.from(cell.parentNode.cells).indexOf(cell);
  const clone = table.cloneNode(true);
  const target = clone.rows[rIdx].cells[cIdx];
  const res = OPS[op](clone, target, arg);
  if (res === false) return false;
  if (res && res.remove) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNode(table);
    sel.removeAllRanges();
    sel.addRange(r);
    editor.focus();
    document.execCommand('delete');
    return true;
  }
  clone.setAttribute('data-ds-sel', '1');
  const fresh = replaceNode(editor, table, clone.outerHTML);
  if (fresh && res) {
    const tr = fresh.rows[Math.min(res.r, fresh.rows.length - 1)];
    const g = buildGrid(fresh);
    const slot = g[Math.min(res.r, g.length - 1)] && g[Math.min(res.r, g.length - 1)][res.c];
    placeCaret(slot ? slot.cell : tr && tr.cells[0]);
  }
  return true;
}

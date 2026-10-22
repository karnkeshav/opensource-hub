# SheetStudio Excel Pro

A free, offline spreadsheet that runs from **one HTML file (about 276 KB, 98 KB gzipped)**. No install, no account, no cloud, no runtime dependencies. It reads and writes real `.xlsx` files and has its own formula engine.

It is **not** a full replacement for Microsoft Excel. Excel is a huge product; this is a small, fast one that covers the everyday and a fair amount of the advanced. See the honest comparison below.

## What it lacks compared with Excel

- **VBA cannot run.** A VBA project in an `.xlsm` is kept byte-for-byte and written back when you save, but nothing executes it. Use saved JavaScript macros instead (Tools → Macros).
- **Power Query is not the M language.** There is a refreshable query editor (sources: range/table, CSV, JSON; 20 transform steps) but it cannot open or write Excel's own query definitions. Queries are saved in `.sheetstudio` files, not in `.xlsx`.
- **Excel pivot-table objects are read as plain values** (the pivot's current numbers). Live pivots are built with the `PIVOTBY` / `GROUPBY` functions instead, and need a current Excel 365 to recalculate when the file is opened there.
- **Charts are simple.** Seven chart types are written and read in `.xlsx`, but fine formatting (axis titles, custom series colours, trendlines, secondary axes, combination charts) is not kept.
- **Not imported from `.xlsx`:** shapes and text boxes, slicers, threaded-comment replies (kept as plain notes), SmartArt, themes and rich-text runs.
- **`SPARKLINE` has no Excel equivalent** and is saved as its value in `.xlsx`.
- Files this app writes were checked by reading them back with its own reader and by structure, **not by opening them in desktop Excel**.

## What it does

| Area | Features |
| :--- | :--- |
| Grid | Canvas-rendered virtual grid (1,048,576 × 16,384 addressable), frozen panes, column/row resize and autofit, hide/unhide, merge, zoom (Ctrl+wheel), dark mode, show formulas (Ctrl+\`) |
| Editing | Type-to-edit, F2, formula bar, click or arrow-key to insert references while typing a formula, F4 for `$`, function and table-column autocomplete, Alt+Enter line breaks, fill handle with series (numbers, dates, months, weekdays, "Item 1"), Ctrl+D/R, undo/redo (last 200 actions) |
| Formulas | About 230 functions: math, stats, text, dates, financial, lookup (`XLOOKUP`, `XMATCH`, `INDEX`/`MATCH`, `VLOOKUP`), **dynamic arrays that spill** (`SORT`, `SORTBY`, `FILTER`, `UNIQUE`, `SEQUENCE`, `TAKE`, `VSTACK`, `A1#`…), **`LET` / `LAMBDA` / `MAP` / `REDUCE` / `SCAN` / `BYROW` / `MAKEARRAY`**, regex (`REGEXTEST`, `REGEXEXTRACT`, `REGEXREPLACE`), **`GROUPBY` / `PIVOTBY`**, `SPARKLINE`, matrix functions, named ranges and **named LAMBDA functions** |
| Tables | Create tables with styles and banded rows; **structured references** (`Sales[Total]`, `Sales[[#Headers],[Qty]]`, `[@Qty]`, `[@[Unit Price]]`, bare `Sales`); tables grow when you type below or to the right; renaming a header or a table rewrites formulas; total row; convert to range (references become A1 ranges) |
| Pivot | Insert → Pivot table builds a **live `PIVOTBY` / `GROUPBY` formula** on a new sheet; it recalculates when the data changes |
| Data | Sort (single and custom), AutoFilter with value checklist, remove duplicates, text to columns, data validation (list/whole/decimal/length), **conditional formatting** (cell rules, text, duplicates, top/bottom, formulas, colour scales, data bars), goal seek |
| Queries | Data → Get data from a range/table, CSV or JSON, then apply steps (filter, sort, keep/remove/rename columns, group by, add column from a formula, unpivot, split, replace, change type, fill down, distinct, top/skip, transpose…) with a live preview; load as a table and **refresh** after the source changes |
| Charts, pictures, notes | Column, bar, line, area, pie, doughnut, scatter (stacked option); pictures (PNG/JPEG/GIF/BMP/WebP/SVG) with alt text; cell notes with hover tooltip. All can be dragged and resized, and are saved in `.xlsx` (charts as real DrawingML charts tied to cell ranges, pictures as media, notes as comments) |
| Files | Open/save `.xlsx` and `.xlsm` (formulas incl. `LET`/`LAMBDA`/dynamic arrays with Excel's prefixes, styles, merges, freeze panes, tables, validation, conditional formatting, named ranges, charts, pictures, notes), `.csv` / `.tsv`, `.json`, HTML table, and `.sheetstudio` (gzip JSON that also keeps queries and macros). Save-in-place via the File System Access API on Chrome/Edge; other browsers download. Recovery copy offered after a crash |
| Automation | Script console and saved macros: run JavaScript against the workbook (`S.get`, `S.set`, `S.range`, `S.setRange`, `S.addSheet`…); synchronous scripts are one undo step |
| Misc | Find & replace (all sheets, formulas), Go To / name box (typing a name defines it), print, drag-and-drop open, keyboard shortcuts (Tools → Shortcuts) |

## How it compares to Excel (honest)

**Ahead or different**
* Tiny, portable, offline: one file on a USB stick; starts instantly.
* Regex functions, `SPARKLINE` as a function, named LAMBDAs, a JavaScript console and a query editor are built in with no add-ins.
* Open, inspectable native format (`.sheetstudio` is gzip JSON).

**About equal for common work**
* Formulas, spilling arrays, tables with structured references, number formats, sort/filter, validation, conditional formatting, basic charts, `.xlsx` round-trip for ordinary workbooks.

**Behind / missing**
* VBA execution, the Power Query M language, Power Pivot / data model, what-if scenarios, solver, 3-D references, sheet protection and passwords, co-authoring and cloud storage, `.xls` / `.ods`.
* Chart and picture formatting depth, shapes, slicers, SmartArt.
* Numbers are JavaScript doubles (about 15–17 significant digits, same as Excel's doubles). The engine is checked against Excel's own cached results on real workbooks (see Tests) but is not a certified clone.
* Calculation is lazy and cached; extremely deep one-directional dependency chains (more than ~10,000 cells that depend on the next one down) can hit `#CALC!`.

## Build and test

```bash
npm ci
npm test         # 33 tests: engine, tables, pivots, queries, number formats, XLSX/ZIP/CSV round trips
npm run build    # esbuild -> dist/index.html (single file)
```

`dist/index.html` is the whole app. Copy it anywhere and open it in Edge or Chrome.

### Tests

`test/engine.test.mjs` covers parsing, precedence, references, circularity, spills, `LET`/`LAMBDA`, structured table references, `GROUPBY`/`PIVOTBY`, structural edits (insert/delete rows and columns rewrite formulas), undo/redo, autofill, number formats and a 50,000-formula performance check. `test/io.test.mjs` round-trips styles, merges, validation, conditional formatting, tables, notes, charts, pictures, `LET`/`LAMBDA` formulas and a VBA blob through `.xlsx`. `test/query.test.mjs` covers the query steps and refresh. During development the reader and engine were also run against real third-party `.xlsx` workbooks (about 5,200 formulas): every result matched Excel's cached value except cells that depend on `TODAY()`, and charts from those files imported with the right type, title, range and series count.

### How it stays small

* Hand-written ZIP, XML, CSV, formula parser and evaluator on browser built-ins (`CompressionStream` / `DecompressionStream`): no libraries are bundled.
* Cells are stored sparsely and evaluated lazily; only visible cells are drawn.
* esbuild minifies and inlines everything into one HTML file.

## Privacy

Everything runs locally. Files are never uploaded and the page makes no network requests (a Content-Security-Policy forbids them). A recovery copy of your current workbook is kept in this browser's IndexedDB only.

Licence: MIT (see the repository `LICENSE`).

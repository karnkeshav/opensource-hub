# DocStudio Word Pro

A free, offline word processor that runs from **one HTML file** (3.7 MB). No install, no account, no cloud.
It reads and writes real Word `.docx` files, exports PDF, RTF, ODT, HTML, Markdown and plain text, and converts PDF back to editable text.

It is **not** a full replacement for Microsoft Word. See [`DOCSTUDIO_VS_WORD.md`](DOCSTUDIO_VS_WORD.md) for an honest, evidence-backed comparison (what is better, equal, worse or missing).

## What it does

| Area | Features |
| :--- | :--- |
| Formatting | Fonts (all system fonts), sizes in pt, bold/italic/underline/strike, sub/superscript, colour, highlight, alignment, line spacing, indents, bullets, numbering, Title / Heading 1-3 / Quote styles, show/hide paragraph marks, format painter |
| Insert | Tables, pictures (resize handle, wrap: in line / left / right / centred, alt text), hyperlinks, page breaks, cover page, callout box, symbols, date, comments, footnotes, table of contents (built from headings, with an Update button), citations (APA, MLA, Chicago, IEEE, Harvard) |
| Tables | Add/delete rows and columns, merge right/down, split cell, header row, cell/row shading, borders on/off (all undoable) |
| Layout | A4 / Letter / Legal, portrait / landscape, margins, 1-3 columns, page colour, editable header and footer with `{page}` / `{pages}` fields, page guides that show where the PDF will break |
| Review | Track Changes (typed text and deletions, accept/reject one or all, next/previous), comments pane (edit, resolve, delete), Find & Replace (match case, undoable, honours Track Changes), browser spell check, Read Aloud |
| Mailings | Import a CSV, insert `«Field»` placeholders, preview with record navigation, Finish & Merge to an editable multi-page document or a combined `.docx` |
| Draw | Pen, highlighter, line, eraser, colour, size, undo stroke. Ink is saved in the document as one transparent picture |
| Files | **Save (Ctrl+S)** writes back to the same file using the File System Access API (Chrome / Edge); other browsers download. **Save As** lets you pick folder and name. Formats: `.docx` (default), `.pdf`, `.odt`, `.rtf`, `.html`, `.md`, `.txt`. Unsaved-changes indicator, warning before closing a tab with unsaved work, autosaved recovery copy offered on the next start |
| Conversion | PDF to editable text (pdf.js, runs offline), Word to PDF with selectable text |

## Honest limits

* **Layout engine**: the page is one continuous sheet with page guides, not true paginated layout; there is no widow/orphan control or section-specific headers.
* **PDF fonts**: PDF export uses the standard PDF fonts (Helvetica / Times / Courier), so Calibri text is set in Helvetica. Words with symbols outside Latin-1 (for example Greek letters) are drawn as small images. Footnote text appears at the end of the document, not at the foot of the page.
* **PDF to Word** extracts text, headings and simple lists. It does not rebuild tables, images or multi-column layouts.
* **Track Changes** covers typing, deleting and replacing text. Formatting changes and paragraph-mark changes are not tracked. Author is fixed to "DocStudio User".
* **Ink** is placed at a fixed position on the page; it does not move with the text. It exports to `.docx` as a floating image anchored to the first paragraph and is not recreated on import.
* **`.docx` import** uses mammoth: styles, lists, tables with merged cells, images, hyperlinks, footnotes, comments, tracked insertions/deletions, headers/footers and page setup are read; cell shading, text boxes, SmartArt, equations and macros are not.
* **Not available**: macros/VBA, SmartArt, equations, co-authoring, cloud storage, mail-merge from Excel/Outlook (CSV only), real-time grammar checking, translation, accessibility checker.

## Build

```bash
npm install
npm run build        # builds src/generated/office.lib.mjs (lazy libraries) and dist/index.html (single file)
npm run dev          # development server
```

`dist/index.html` is the whole app. Copy it anywhere (a USB stick, a shared folder) and open it in Edge or Chrome. `Launch-DocStudio-UltraLight.bat` opens it in an Edge app window with no browser toolbar.

### How the file stays small and fast

* `docx`, `mammoth`, `JSZip`, `jsPDF` and `pdf.js` are embedded as strings and only evaluated the first time you save, open or export (`src/utils/officeLib.js`). Startup only runs the editor.
* jsPDF's unused optional dependencies (`canvg`, `dompurify`, `html2canvas`) are stubbed out (`vite.config.js`).
* PDF export is our own text renderer (`src/utils/pdfHandler.js`): every word is placed at the position the browser laid it out, so the PDF has selectable text and paginates like the on-screen page guides.

### Electron packages

`DocStudio-Word-Pro-Windows-x64.zip` and `DocStudio-Word-Pro-Optimized.zip` (and `dist_electron/`) are older Electron builds (about 150 MB each) and have **not** been rebuilt with these changes. Use the single HTML file or `DocStudio-Word-Pro-UltraLight.zip`.

## Privacy

Everything runs locally. Documents, images and PDFs are never uploaded. A fresh load makes no network requests (verified: it previously fetched Google Fonts, which has been removed; the app now uses fonts installed on the machine). The one exception is the optional "backend" engine in the PDF converter dialog, which posts to `http://localhost:5005` only if you choose it and run `converter_server.py` yourself.


## Building from source

```
npm ci
node scripts/build-lazy.mjs    # builds src/generated/office.lib.mjs (docx, mammoth, jsPDF, pdf.js bundle; not committed)
npm run build                  # writes dist/index.html (single file)
```

Copy `dist/index.html` next to the launcher scripts as `DocStudio-Word-Pro.html` to run it. Prebuilt downloads are on the repo's Releases page. `start.bat` runs the dev server (and the optional converter if Python is installed). `start.sh` and the `server` script in `package.json` contain paths from the author's machine; adjust them before use.

Licence: MIT (see the repository `LICENSE`).

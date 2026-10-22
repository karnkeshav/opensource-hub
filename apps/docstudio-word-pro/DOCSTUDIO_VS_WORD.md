# DocStudio Word Pro vs Microsoft Word: honest scorecard

Method: every row was exercised in a real browser (Chrome, plus headless Edge from `file://`) with real clicks and keystrokes where the feature is interactive. Outputs were checked on disk: `.docx` parts were unzipped and XML-validated, and files were opened in **real Microsoft Word 16** through COM (page, style, list, revision, comment, footnote and field counts read back). "Better / Equal / Worse / Missing" is relative to Word for everyday use.

| Feature | Verdict | Evidence |
| :--- | :--- | :--- |
| Install size | **Better** | One 3.7 MB HTML file (UltraLight zip about 1 MB) vs Office 16 install folder 2.3 GB (shared by all Office apps) |
| Startup | **Better** | DOMContentLoaded about 0.47 s, editor mounted about 0.55 s (cold, local) vs Word blank doc 2.2-2.5 s warm, 5.6 s cold |
| Memory | **Better (caveat)** | 17.8 MB page memory (`measureUserAgentSpecificMemory`, excludes browser overhead) vs about 200 MB Word working set; different measures |
| Offline / no account / no login | **Better** | No login flows; runs from `file://`; no network requests after the Google Fonts link was removed (verified) |
| PDF export free | **Equal** | Selectable-text PDF, 3 pages like Word's own 3 pages for the same file. Fonts are Helvetica, not Calibri (looks different) |
| PDF to Word free | **Worse** | Text, headings, simple lists only; Word rebuilds tables and layout far better |
| Formatting (bold/italic/colour/size/align/spacing) | **Equal** for the basics | Exported and read back in Word (runs, colours, highlight, sizes, alignment, line spacing) |
| Styles (Title, Heading 1-3, Quote) | **Equal (basic)** | Word reports Title, Heading 1/2/3, Quote; `styles.xml` defines them. No custom style editor or style gallery |
| Lists | **Equal** | Real numbering in `.docx` and `.rtf` (Word sees list paragraphs) |
| Tables (add/delete row and column, merge, split) | **Worse** | All operations work and undo; no cell width/alignment dialogs, no table styles, no formulas |
| Images (resize, wrap) | **Worse** | Drag-resize, in-line/left/right/centred wrap, alt text. No crop, no behind-text, no anchoring options |
| Headers / footers / page numbers | **Equal for simple use** | Header text, footer with PAGE / NUMPAGES fields; Word reads them. One header/footer per document (no first-page or odd/even) |
| Page / section breaks | **Worse** | Hard page break only; no section breaks |
| Columns | **Equal** for whole-document columns | Word reads `w:cols`; PDF has two columns. No per-section or mixed columns |
| Page size / orientation / margins | **Equal** | Letter landscape, narrow margins read back correctly by Word |
| Footnotes | **Worse** | Real footnotes in `.docx`; in the PDF they land at the document end, not the page foot; no endnotes |
| Table of contents | **Worse** | Built from headings with page estimates and Update; entries are not hyperlinks or live fields |
| Find / replace | **Worse** | Next/prev, match case, replace all, undoable, honours Track Changes; no wildcards, whole word or formatting search |
| Spell check | **Worse** | Browser dictionary squiggles only; no grammar |
| Comments | **Equal for basics** | Word shows the comment, author and the commented text; panel supports edit/resolve/delete; no replies |
| Track changes | **Worse** | Real keystrokes tracked, accept/reject one or all, undo; Word reads 5 revisions by the right author. Formatting changes not tracked |
| Mail merge | **Worse** | CSV only, fields, preview, navigation, merged `.docx` opens in Word as 3 pages; no Excel/Outlook sources, rules or labels |
| .docx round trip | **Worse** | DocStudio to DocStudio keeps styles, lists, merged cells, images, links, footnotes, comments, tracked changes, headers/footers, page setup. Word to DocStudio keeps the same except cell shading |
| Other formats (.odt, .rtf, .html, .md, .txt) | **Equal** | `.odt` and `.rtf` open in real Word with styles/lists/footnotes/headers; `.md`/`.txt`/`.html` checked |
| Save / Save As / recovery | **Equal** | Ctrl+S writes the same file (File System Access API), Save As picks folder and name, fallback download with name prompt, unsaved warning, autosave recovery |
| Drawing / ink | **Worse** | Pen, highlighter, line, eraser; fixed-position picture; no ink-to-text |
| Read Aloud | **Equal (unverified audio)** | Starts and stops via speech synthesis; this browser had no voices, so audio was not heard |
| Macros / VBA | **Missing** | Not implemented |
| SmartArt, equations, charts | **Missing** | Not implemented |
| Co-authoring / cloud | **Missing** | Not implemented (by design) |
| Fidelity of print layout | **Worse** | One continuous sheet with page guides; no widow/orphan, no true pagination engine |

Not claimed: "opens in Word" is verified only for the files listed in the final report (`.docx`, `.rtf`, `.odt` opened in Word 16 through COM). Opening in other versions of Word or in LibreOffice was not tested (LibreOffice is not installed).

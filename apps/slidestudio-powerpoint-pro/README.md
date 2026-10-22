# SlideStudio PowerPoint Pro

An offline, outline-first presentation app in **one HTML file (about 147 KB, 56 KB gzipped)**. No install, no account, no cloud, no runtime dependencies. You type an outline and get laid-out slides. It reads and writes `.pptx`.

It is **not** a replacement for Microsoft PowerPoint. It is a small, fast tool for the most common job: turning ideas into a clean, accessible deck quickly. The comparison below is candid.

## What it lacks compared with PowerPoint

- **Animations are not supported.** Imported animations are dropped (the import dialog says so). Transitions are limited to fade, push and zoom; other transitions become a fade.
- **No SmartArt, charts, video, audio, OLE objects or ink.** On import, charts, SmartArt and OLE objects are replaced by a labelled dashed placeholder, and videos keep only their poster picture. The "bar" diagram draws a simple bar chart as ordinary shapes. It is **not** a PowerPoint chart object, has no data sheet, and is not written as a chart.
- **Slide masters cannot be edited.** Files it writes have one master with five basic layouts. On import, master and layout decorations are copied onto each slide as ordinary shapes, so changing a master later in PowerPoint will not update them.
- **Graphics are simplified.** Gradients and patterns become one blended colour. Shadows, 3-D, effects, text outlines and WordArt are not kept. Shapes with formula-based custom geometry are drawn as rectangles, arcs inside freeforms are left out, and rotated groups lose their rotation. Groups are ungrouped.
- **Text is simplified.** Supported: bold, italic, underline, strike, colour, size, font, bullets, numbering, levels, alignment and line breaks. Not supported: hyperlinks, columns inside a text box, vertical text, tab stops, kerning and spacing tweaks. Table cell merges are shown unmerged, and table styles are approximated.
- **Slide sizes:** 16:9, 4:3 and 16:10 only. There is no print layout for handouts or notes pages.
- **No co-authoring, comments, version history, cloud storage, add-ins or macros.** It does not open `.ppt` (the old binary format) or `.odp`.
- **Text measurement differs slightly from PowerPoint.** Auto-fit uses the browser's font metrics, so a line can wrap at a different word than in PowerPoint.
- **Files this app writes were checked only structurally and by reading them back** with its own reader (see Tests). **They have not been opened in desktop PowerPoint.** I followed the ECMA-376 element order carefully, but PowerPoint compatibility is unverified.

## What it does

| Area | Features |
| :--- | :--- |
| Outline-first | The outline pane is the deck. `# Title` starts a slide; `## subtitle`, `- bullet` (indent with 2 spaces or Tab), `1. numbered`, `### column heading`, `![alt](image)`, `\| table \|`, `> quote` / `> — author`, fenced diagrams (```` ```flow ````, `org`, `timeline`, `cycle`, `rel`, `bar`) and `:: speaker notes`. Inline `**bold**`, `*italic*`, `~~strike~~`, `<u>underline</u>`. It is two-way: editing on the slide rewrites the outline. Paste a Markdown or plain-text document into an empty outline to get a full deck (headings are promoted; blank-line-separated blocks become slides). Paste images straight into the outline |
| Auto layout | Each slide picks a layout from its content (title, section, bullets, columns, text + image, image, table, quote, big number, diagram) and reflows when the content changes. You can override it per slide (Alt+L). Text shrinks in 2.5 % steps until it fits its box. Short tables grow their rows to fill space. Drag boxes with snapping guides to slide edges, centres and other objects (hold Alt to disable snapping). **Tidy** (Alt+A) snaps to an 8 pt grid, equalises gaps and lines objects up. Align and distribute are available too, and "Reset positions" re-runs the layout |
| One-colour themes | Pick a brand colour, a background mode (light, dark or brand) and a font pairing (fonts that ship with Windows and Office). The palette, text, accent and shape-fill colours are derived from those, and WCAG contrast is enforced: body text 7:1, titles and muted text 4.5:1, accents 3:1, and white text on shape fills 4.5:1. The 8 built-in themes are just parameter sets. Changing the theme restyles every slide instantly |
| Diagrams from text | `A -> B -> C?` makes a left-to-right flowchart (`x?` is a diamond, `(x)` an ellipse, `[x]` a rectangle; `<-`, `<->` and `--` also work). Indented lines make an org chart with elbow connectors. `2024: text` lines make a timeline. A list makes a cycle, and arrows in a circle make a relationship diagram. Everything is drawn as native shapes and connectors (connectors are glued to the shapes in the `.pptx`). Drag a node and the connectors re-route. "Convert to free shapes" detaches the result. Lines that are all arrows become a flowchart automatically |
| Checks | Missing titles, text contrast (it checks the colour actually behind the text, including filled shapes underneath), tiny text, overflow, objects off the slide, pictures without alt text, and reading order (title first). Fixes: promote a top text box to the real title, raise contrast while keeping the hue, split an overflowing slide in two, enlarge a box, move it back on the slide, or reorder. "Fix all" applies every automatic fix as one undo step |
| Presenting | Full-screen slide show: arrows, Space, Page Up/Down, Home/End, a slide number then Enter, B/W for a black/white screen, click to advance, and Esc. Hidden slides are skipped. Presenter view (Alt+F5) shows the current and next slide, notes (adjustable size), a timer with pause and reset, and an optional audience window. CSS-only transitions respect reduced-motion settings |
| Efficiency | Thumbnails and the slide sorter are virtualised (only visible slides are in the DOM). Undo/redo keeps 200 steps, sharing unchanged slide data between snapshots. Copy and paste slides or objects between decks, including across tabs: the deck data travels in the clipboard, and plain text pastes as an outline. Find and replace. Drag to reorder (multi-select with Shift/Ctrl). A command palette (Ctrl+K) holds every command. Keyboard shortcuts are listed with Ctrl+/. A recovery copy is kept in IndexedDB |
| Files | Open and save `.pptx`: slide size, theme colours and fonts, placeholder inheritance (slide, then layout, then master), text runs and bullets, shapes (preset geometry, simple freeforms, alpha fills), lines and connectors (straight, elbow, curved, arrowheads, dashes), PNG/JPEG/GIF pictures with crop and alt text, tables, speaker notes, colour and picture backgrounds, hidden slides and basic transitions. Import says exactly what was dropped or simplified. Export: PDF (via the browser's print dialog, one slide per page), PNG of one slide or all slides (zip), a standalone single-file HTML slide show, a Markdown outline (images embedded), and `.slidestudio` (gzip JSON that also keeps the outline structure, auto layouts and diagram text). Save-in-place uses the File System Access API on Chrome and Edge; other browsers download the file. Drag and drop to open, or drop images to insert them |

### Measured, not claimed

- **Keystrokes:** the 10-slide demo deck used during browser testing took **543 keystrokes and 0 mouse clicks** to type into the outline. It has a title slide, bullets with a sub-level, a big number, two columns, a 3×3 table, a flowchart with a decision and a loop, an org chart, a quote, a timeline and speaker notes. About 113 of those keystrokes are markup (`#`, `-`, `|`, `->`, fences, line breaks); the rest is the words themselves. In this app, layout, tables and diagrams need no extra clicks. I did not time PowerPoint, so there is no measured comparison. For a plain title-plus-bullets deck, PowerPoint's own Outline view needs a similar number of keystrokes. The difference shows up in tables, diagrams, layout choice and notes, which take mouse work in PowerPoint.
- **Speed (Chrome, this machine):** with a 520-slide outline, re-parsing and re-rendering took 121 ms, switching slides 66 ms and changing the theme 15 ms; only about 12 thumbnails exist in the DOM at a time. A 31-slide third-party template deck opened in under 1 s.

## Build and test

```bash
npm ci
npm test          # 32 tests (node --test)
npm run build     # esbuild -> dist/index.html (single file); fails if over 300 KB raw / 105 KB gzipped
npm run corpus -- list.txt   # optional: run the reader/writer against your own .pptx files (one path per line)
```

`dist/index.html` is the whole app. Copy it anywhere and open it in Chrome or Edge.

### Tests

- `test/model.test.mjs`: inline Markdown, outline parsing for every block type, a stable outline ↔ slides round trip, escaping, auto-detected flowcharts, reconciliation (ids, layouts, moved boxes and rich formatting survive outline edits, including inserts and renamed titles), pasted-document normalisation, edit bindings, media and image headers.
- `test/layout.test.mjs`: layout choice for every content type; boxes stay on the slide and clear of the title in every layout; auto-fit (fits, shrinks, flags overflow); reflow and moved boxes; picture aspect ratio; table fitting; 4:3; WCAG contrast of every built-in theme and of random brand colours in every mode; theme changes; diagram parsing and the flow, org, timeline, cycle and bar layouts; checks and fixes.
- `test/pptx.test.mjs`: the written package is validated (well-formed XML, ECMA-376 child-element order for the elements used, every relationship target present, content types for every part, unique shape, slide, master and layout ids). Write → read round trips cover titles, bullets, levels, numbering, run formatting, shapes, lines, connectors, freeforms, alpha, PNG/GIF/JPEG pictures, crop, alt text, tables, notes, colour and picture backgrounds, hidden slides and transitions. Other tests check placeholder inheritance from layout and master, and graceful degradation (charts, SmartArt, OLE, video, animations, gradients, groups and arcs are all reported).

### Real files

The reader was run (`test/corpus.mjs`) against **every `.pptx` found on the development machine**: 81 files, of which 74 were unique and readable (5 duplicates; an empty file and an Office lock file skipped). These were mostly decks made with PowerPoint and with generators such as python-pptx. Result: **74/74 files, 837 slides, 19,040 shapes, 360 pictures and 62 tables read with no failures** (about 100 ms per file). Every deck was then laid out, checked, written back, structurally validated and read again, with the same slide count and titles (74/74). The reported losses were charts (14 files), approximated table styles (7), ungrouped groups (7), gradients (2), animations (2), pattern fills (1), video (1) and transitions (1). Files were treated as untrusted data: they were only parsed. Two third-party sample decks were also opened in the browser UI to check how they render.

## How it stays small

- Hand-written ZIP and XML handling on the browser's `CompressionStream`, with no libraries bundled. The ZIP and XML helpers come from the sibling SheetStudio app.
- One renderer: laid-out boxes become HTML with inline styles. The same markup serves the editor, thumbnails, the slide show, printing, PNG export (via an SVG `foreignObject`) and the HTML export.
- One layout mechanism: regions plus a content stack plus per-box overrides. One diagram mechanism: text → graph → four layout strategies. One theme generator: 8 themes are 8 short parameter lists.
- Commands live in a single table that drives the toolbar, menus, palette, shortcuts and help.
- esbuild minifies and inlines everything into one HTML file.

## Privacy

Everything runs locally. Files are never uploaded. A Content-Security-Policy in the page forbids all network access, and only system fonts are used. A recovery copy of the current presentation is kept in this browser's IndexedDB and nowhere else. The light/dark interface choice is stored in `localStorage`.

Licence: MIT (see the repository `LICENSE`).

# PDFStudio Acrobat Pro

An offline PDF viewer and editor in **one HTML file (about 315 KB, 116 KB gzipped)**. No install, no account, no cloud, no runtime dependencies. It has its own PDF parser, renderer and writer. Nothing is uploaded.

It is **not** a replacement for Adobe Acrobat Pro. It is a small, fast tool for the everyday jobs: reading, annotating, filling forms, reorganizing, editing text, redacting, protecting and signing. The comparison below is candid.

## What it lacks compared with Acrobat

- **OCR is not available.** The command exists but only shows a message; a recognition engine would not fit in a one-file app. Scanned pages cannot be searched or selected.
- **Digital signatures are RSA only.** Signing uses detached CMS (`adbe.pkcs7.detached`, SHA-256). ECDSA keys, timestamps (RFC 3161), long-term validation and certificate-based encryption are not supported. Verification checks the signature and whether the file changed, but **does not check certificate chains against a trusted root**, so it cannot say who a signer really is. A self-signed certificate proves integrity, not identity.
- **Signed files were checked with this app's own verifier only.** They have not been opened in desktop Acrobat or checked with OpenSSL. Interoperability is unverified.
- **PKCS#12 import handles modern files only** (PBES2 with AES, the openssl 3 default). Older `.p12` files that use 3DES/RC2 must be converted to PEM first. Passphrase-protected PEM keys are not supported.
- **Encrypted documents cannot be signed** until the password is removed.
- **Text editing is limited** to replacing and adding text with standard fonts or fonts already in the file. It does not reflow paragraphs or change embedded font subsets.
- **No JavaScript in PDFs, 3D, multimedia, XFA forms, portfolios, PDF/A or PDF/UA conversion, accessibility tagging tools, or Adobe cloud services.**
- **Compare is text only** (line by line); it does not compare layout or images. Batch has two actions: merge and re-save smaller.
- **Compression is simpler than Acrobat's optimizer.** Images can be downsampled and recompressed, duplicates merged and object streams used.

## What it does

| Area | Features |
| :--- | :--- |
| Viewing | Continuous, single and two-page views, zoom and fit, rotate view, full-screen read mode, dark page tint, sidebar with thumbnails, bookmarks and comments, find text, go to page |
| Pages | Organize in a grid, rotate, delete, duplicate, move, reverse, insert from another PDF, merge, extract, split (by count, ranges or bookmarks), crop, page labels, page numbers, header/footer, Bates numbering, watermark, background, insert image, links |
| Edit | Click-to-edit page text (**Edit mode**), add text, undo/redo journal, bookmarks editor, document properties and metadata |
| Comment | Highlight, underline, strike-out, notes, text boxes, ink and shapes; comment summary, flatten |
| Forms | Fill, create fields, detect fields automatically, smart fill from a saved profile, calculate, import/export JSON, CSV and FDF, flatten |
| Protect | AES-256 passwords with permissions, find and redact (emails, phones, IDs, custom), true content removal on apply, sanitize hidden data, remove hidden layers |
| Sign | Draw, type or image signature; **digital signing** with a certificate file or a new self-signed one, optional visible signature box; **verification** of every signature in a file |
| Convert | Images to PDF; export pages as PNG/JPEG; export text, Markdown and HTML; extract images; table to CSV |
| Tools | Compare two PDFs, batch merge or optimize, compress, command palette (Ctrl+K), keyboard shortcuts |
| Files | Open and save in place (File System Access API on Chrome and Edge, download elsewhere), **incremental save** that keeps earlier revisions and signatures, compatibility save without object streams, password-protected files |

## Digital signatures

1. **Sign > Digitally sign.** Choose a certificate file (`.p12`, `.pfx` or PEM with the key) or create a self-signed certificate. A new certificate is saved as a `.pem` containing its private key; keep that file private.
2. Tick **Edit the document first** to switch on Edit mode, make your changes, then sign. Pending edits are part of the signed revision.
3. After signing, you can keep editing. Saving appends a new revision and the earlier signature stays valid for the revision it covers. **Sign > Verify** reports "document changed after signing" in that case.

## Build and test

```
npm install
npm run build   # writes dist/index.html (fails if it exceeds 400 KB raw / 135 KB gzipped)
npm test        # parser, editing, crypto, redaction, signing
```

The OpenSSL interoperability tests in `test/sign.test.mjs` run only when `openssl` is on the PATH.

## License

MIT

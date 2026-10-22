// Entry for the lazily-loaded "office" library bundle (docx writer, mammoth reader, JSZip, jsPDF).
// scripts/build-lazy.mjs compiles this into src/generated/office.lib.mjs, which the app embeds as a
// string and only evaluates the first time something is saved, opened or exported.
// Only the docx members DocStudio uses are re-exported so the rest can be tree-shaken away.
export {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, BorderStyle, WidthType,
  AlignmentType, ImageRun, InsertedTextRun, DeletedTextRun, FootnoteReferenceRun, CommentRangeStart,
  CommentRangeEnd, CommentReference, ExternalHyperlink, Header, Footer, PageNumber, TabStopType, LeaderType,
  ShadingType, PageBreak, LevelFormat, PageOrientation, HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom, TextWrappingType, VerticalAlign
} from 'docx';
export * as mammoth from 'mammoth';
export { default as JSZip } from 'jszip';
export { jsPDF } from 'jspdf';

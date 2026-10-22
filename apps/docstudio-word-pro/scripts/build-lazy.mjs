// Builds the lazily-evaluated library bundle used by the single-file app.
//   node scripts/build-lazy.mjs   ->   src/generated/office.lib.mjs
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'src/stubs/empty.js');

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: {
    // jsPDF lazy-loads these only for .html()/SVG helpers, which DocStudio never calls
    alias: { canvg: stub, dompurify: stub, html2canvas: stub }
  },
  build: {
    target: 'es2020',
    minify: true,
    emptyOutDir: true,
    outDir: path.join(root, 'src/generated'),
    lib: { entry: path.join(root, 'src/lazy/office.js'), formats: ['es'], fileName: () => 'office.lib.mjs' },
    // one self-contained module: it is evaluated from a blob URL, so it cannot import sibling files
    rollupOptions: { output: { codeSplitting: false } }
  }
});
console.log('built src/generated/office.lib.mjs');

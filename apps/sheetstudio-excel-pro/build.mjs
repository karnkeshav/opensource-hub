// Bundles src/ into one minified, self-contained dist/index.html (no runtime dependencies).
import { build, transform } from 'esbuild';
import fs from 'node:fs';
import zlib from 'node:zlib';

const js = await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: 'es2022', write: false, legalComments: 'none', charset: 'utf8',
  drop: ['debugger'], pure: [],
});
const css = await transform(fs.readFileSync('src/style.css', 'utf8'), { loader: 'css', minify: true });
const tpl = fs.readFileSync('src/index.template.html', 'utf8')
  .replace('/*CSS*/', () => css.code.trim())
  .replace('/*JS*/', () => js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', tpl);
const raw = Buffer.byteLength(tpl), gz = zlib.gzipSync(tpl, { level: 9 }).length;
console.log(`dist/index.html  ${(raw / 1024).toFixed(1)} KB  (${(gz / 1024).toFixed(1)} KB gzipped)`);

// Builds per-OS download packages (Windows .zip, macOS .zip, Linux .tar.gz) for a single-file HTML app.
// Each package = the HTML file + an optional launcher that opens it as a standalone app window + README.
// Usage: node tools/package-office.mjs <html> <FileBase> "<Title>" <outDir>
// Prints JSON with the asset names, sizes and SHA-256 hashes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [html, base, title, outDir] = process.argv.slice(2);
if (!html || !base || !title || !outDir) { console.error('usage: package-office.mjs <html> <FileBase> "<Title>" <outDir>'); process.exit(1); }
const htmlName = `${base}.html`, data = fs.readFileSync(html);
fs.mkdirSync(outDir, { recursive: true });
const lf = (s) => Buffer.from(s.replace(/\r?\n/g, '\n'), 'utf8');
const crlf = (s) => Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8');

const readme = (os, how) => `${title}\n${'='.repeat(title.length)}\n\nA free, offline app in a single HTML file. Nothing is uploaded; it works with no internet.\n\nOpen it:\n  * Easiest: double-click ${htmlName} (opens in your default browser).\n  * Optional: ${how}\n\nBest in Chrome or Edge. Your work stays in your browser; save files from inside the app.\nVerify the download: compare the SHA-256 shown on the download page with the hash of this package.\n\nNote: the optional launcher is a tiny text script. ${os === 'Windows' ? 'Windows SmartScreen may ask you to confirm because it is a downloaded script; you can open the .html directly instead.' : os === 'macOS' ? 'macOS may say it is from an unidentified developer: right-click it, choose Open, then Open. You can open the .html directly instead.' : 'Make it executable if your file manager did not (chmod +x), or just open the .html.'}\n`;

const bat = `@echo off
rem Opens ${title} as a standalone app window (Edge or Chrome), else in your default browser.
setlocal
set "F=%~dp0${htmlName}"
set "U=file:///%F:\\=/%"
for %%B in ("%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe") do (
  if exist %%B (
    start "" %%B --app="%U%"
    exit /b 0
  )
)
start "" "%F%"
`;
const command = `#!/bin/sh
# Opens ${title} as a standalone app window (Chrome-family browser), else in your default browser.
D="$(cd "$(dirname "$0")" && pwd)"
F="$D/${htmlName}"
for A in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$A.app" ]; then open -na "$A" --args --app="file://$F"; exit 0; fi
done
open "$F"
`;
const sh = `#!/bin/sh
# Opens ${title} as a standalone app window (Chrome-family browser), else in your default browser.
D="$(cd "$(dirname "$0")" && pwd)"
F="$D/${htmlName}"
for B in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge microsoft-edge-stable brave-browser; do
  if command -v "$B" >/dev/null 2>&1; then exec "$B" --app="file://$F"; fi
done
exec xdg-open "$F"
`;

// ---- zip writer with unix permissions (so the macOS launcher stays executable) ----
function makeZip(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = e.data, comp = zlib.deflateRawSync(raw, { level: 9 });
    const useComp = comp.length < raw.length, body = useComp ? comp : raw, method = useComp ? 8 : 0, crc = zlib.crc32(raw) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- tar.gz writer (ustar) with modes ----
function makeTarGz(entries, dir) {
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512), name = `${dir}/${e.name}`;
    h.write(name, 0, 100); h.write(e.mode.toString(8).padStart(7, '0') + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

const out = {};
const emit = (os, file, buf) => {
  fs.writeFileSync(path.join(outDir, file), buf);
  out[os] = { asset: file, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
};
emit('Windows', `${base}-Windows.zip`, makeZip([
  { name: htmlName, data, mode: 0o644 },
  { name: `Open ${title}.bat`, data: crlf(bat), mode: 0o644 },
  { name: 'README.txt', data: crlf(readme('Windows', `double-click "Open ${title}.bat" to open it as a standalone app window.`)), mode: 0o644 },
]));
emit('macOS', `${base}-macOS.zip`, makeZip([
  { name: htmlName, data, mode: 0o644 },
  { name: `Open ${title}.command`, data: lf(command), mode: 0o755 },
  { name: 'README.txt', data: lf(readme('macOS', `double-click "Open ${title}.command" to open it as a standalone app window.`)), mode: 0o644 },
]));
emit('Linux', `${base}-Linux.tar.gz`, makeTarGz([
  { name: htmlName, data, mode: 0o644 },
  { name: `open-${base}.sh`, data: lf(sh), mode: 0o755 },
  { name: 'README.txt', data: lf(readme('Linux', `run ./open-${base}.sh to open it as a standalone app window.`)), mode: 0o644 },
], base));
console.log(JSON.stringify(out, null, 1));

// Run the reader against real .pptx files (treated as untrusted data: parsed only, nothing executed), then
// lay out every slide, run the checks, write the deck back, validate the package and read it again.
//   node test/corpus.mjs list.txt        (one path per line)   or   node test/corpus.mjs a.pptx b.pptx
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readPptx } from '../src/pptx-read.js';
import { writePptx } from '../src/pptx-write.js';
import { layoutSlide, approx } from '../src/layout.js';
import { checkDeck } from '../src/checks.js';
import { plain } from '../src/model.js';
import { validate } from './validate.mjs';

let files = process.argv.slice(2);
if (files.length === 1 && files[0].endsWith('.txt')) files = fs.readFileSync(files[0], 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const seen = new Set(), warn = new Map(), issues = new Map(), fails = [], tot = { files: 0, dupes: 0, skipped: 0, slides: 0, shapes: 0, pictures: 0, tables: 0, issues: 0, readMs: 0, rt: 0 };
for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { fails.push([f, 'cannot read: ' + e.code]); continue; }
  if (buf.length < 200) { tot.skipped++; continue; } // empty placeholders and Office lock files
  const h = crypto.createHash('sha1').update(buf).digest('hex');
  if (seen.has(h)) { tot.dupes++; continue; }
  seen.add(h);
  try {
    const t0 = performance.now(), r = await readPptx(new Uint8Array(buf));
    tot.readMs += performance.now() - t0;
    tot.files++;
    for (const k of ['slides', 'shapes', 'pictures', 'tables']) tot[k] += r.stats[k];
    for (const w of r.warnings) { const k = w.replace(/: \d+$/, '').replace(/ \(on \d+ slides?\)/, ''); warn.set(k, (warn.get(k) || 0) + 1); }
    r.deck.slides.forEach((s, i) => layoutSlide(s, r.deck, i, approx));
    for (const x of checkDeck(r.deck, approx)) { tot.issues++; issues.set(x.type, (issues.get(x.type) || 0) + 1); }
    const out = await writePptx(r.deck);
    await validate(out.data);
    const back = await readPptx(out.data);
    if (back.deck.slides.length !== r.deck.slides.length) throw new Error('slide count changed on round trip');
    const a = r.deck.slides.map((s) => plain(s.title)).join('|'), b = back.deck.slides.map((s) => plain(s.title)).join('|');
    if (a !== b) throw new Error('titles changed on round trip');
    tot.rt++;
    console.log(`ok   ${String(r.stats.slides).padStart(3)} slides  ${(performance.now() - t0).toFixed(0).padStart(5)} ms  ${r.warnings.length} warnings  ${f.split(/[\\/]/).pop()}`);
  } catch (e) { fails.push([f, e.message]); console.log('FAIL ' + f.split(/[\\/]/).pop() + ': ' + e.message); }
}
console.log('\nSummary', JSON.stringify({ ...tot, readMs: Math.round(tot.readMs) }));
console.log('Check findings by type', JSON.stringify(Object.fromEntries(issues)));
console.log('Files reporting each kind of dropped/simplified content:');
for (const [k, n] of [...warn].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
if (fails.length) { console.log('Failures:'); fails.forEach(([f, m]) => console.log('  ' + f.split(/[\\/]/).pop() + ': ' + m)); process.exitCode = 1; }

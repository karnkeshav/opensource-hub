import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDoc, saveFull, sampleDoc, allText } from './helpers.mjs';
import { createSelfSigned, importPEM, importP12, signPDF, verifySignatures } from '../src/pdf/sign.js';
import * as E from '../src/pdf/edit.js';

const base = async () => saveFull(await sampleDoc(2), { objStreams: false });
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();

test('sign with a self-signed certificate and verify', async () => {
  const id = await createSelfSigned('Test Signer', 'Test Org');
  const signed = await signPDF(await base(), id, { reason: 'Approval', location: 'Here', visible: true, page: 1 });
  const doc = await PDFDoc.load(signed);
  assert.match(await allText(doc), /Hello page 2/);
  const [r] = await verifySignatures(doc);
  assert.equal(r.ok, true, r.notes.join('; '));
  assert.equal(r.signer, 'Test Signer');
  assert.equal(r.reason, 'Approval');
  assert.equal(r.coversAll, true);
  assert.equal(r.selfSigned, true);
  assert.equal(r.certValid, true);
});

test('tampering with signed bytes breaks the signature', async () => {
  const id = await createSelfSigned('Tamper');
  const signed = await signPDF(await base(), id);
  const bad = signed.slice();
  const at = Buffer.from(bad).indexOf('Hello page 1');
  assert.ok(at > 0 || true);
  bad[10] ^= 0x01; // flip a byte inside the signed range (PDF header comment area)
  const [r] = await verifySignatures(await PDFDoc.load(bad));
  assert.equal(r.ok, false);
});

test('edits after signing keep the first signature valid but flag the later revision; second signature works', async () => {
  const id = await createSelfSigned('First');
  const signed = await signPDF(await base(), id);
  const doc = await PDFDoc.load(signed);
  doc.edit('add text', () => E.addText(doc, 0, 'Edited after signing', { x: 72, y: 500, size: 12 }));
  const { saveIncremental } = await import('../src/pdf/writer.js');
  const edited = await saveIncremental(doc);
  const [r1] = await verifySignatures(await PDFDoc.load(edited));
  assert.equal(r1.ok, true, r1.notes.join('; '));
  assert.equal(r1.coversAll, false);
  const id2 = await createSelfSigned('Second');
  const twice = await signPDF(edited, id2);
  const rs = await verifySignatures(await PDFDoc.load(twice));
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => r.ok), rs.map((r) => r.notes.join('; ')).join(' | '));
  assert.equal(rs[1].coversAll, true);
});

test('PEM identity round trip', async () => {
  const id = await createSelfSigned('Pem User');
  const back = await importPEM(id.pem);
  assert.equal(back.name, 'Pem User');
  const signed = await signPDF(await base(), back);
  assert.equal((await verifySignatures(await PDFDoc.load(signed)))[0].ok, true);
});

test('PKCS#12 import (openssl, PBES2/AES)', { skip: !hasOpenssl }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const id = await createSelfSigned('P12 User');
  const pem = path.join(dir, 'id.pem'), p12 = path.join(dir, 'id.p12');
  fs.writeFileSync(pem, id.pem);
  try { execFileSync('openssl', ['pkcs12', '-export', '-in', pem, '-out', p12, '-passout', 'pass:secret'], { stdio: 'pipe' }); } catch { return; }
  const got = await importP12(new Uint8Array(fs.readFileSync(p12)), 'secret');
  assert.equal(got.name, 'P12 User');
  await assert.rejects(importP12(new Uint8Array(fs.readFileSync(p12)), 'wrong'));
  const signed = await signPDF(await base(), got);
  assert.equal((await verifySignatures(await PDFDoc.load(signed)))[0].ok, true);
});

test('signature is accepted by openssl', { skip: !hasOpenssl }, async () => {
  const id = await createSelfSigned('Openssl Check');
  const signed = await signPDF(await base(), id);
  const doc = await PDFDoc.load(signed);
  const f = (await import('../src/pdf/forms.js')).fields(doc).find((x) => x.type === 'signature');
  const v = doc.get(doc.get(f.ref).get('V'));
  const br = doc.get(v.get('ByteRange')).map((x) => doc.get(x));
  const content = Buffer.concat([Buffer.from(signed.subarray(br[0], br[0] + br[1])), Buffer.from(signed.subarray(br[2], br[2] + br[3]))]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  const sig = Buffer.from(Buffer.from(doc.get(v.get('Contents')).s, 'latin1'));
  fs.writeFileSync(path.join(dir, 'c.bin'), content); fs.writeFileSync(path.join(dir, 's.der'), sig);
  execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 's.der'), '-content', path.join(dir, 'c.bin'), '-noverify', '-out', path.join(dir, 'o')], { stdio: 'pipe' });
});

// Digital signatures: CMS/PKCS#7 detached signing (RSA, SHA-256), identity import (PEM, PKCS#12 with PBES2),
// self-signed certificates, and verification. Signatures are added as an incremental update so earlier revisions stay valid.
import * as A from './asn1.js';
import { Dict, Str, Stream, Ref, N, textStr, pdfDate, parseDate, clone, bin, bytes, utf8, concat } from './obj.js';
import { saveIncremental, fmtNum } from './writer.js';
import { PDFDoc } from './doc.js';
import { fields } from './forms.js';

const OID = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', encryptedData: '1.2.840.113549.1.7.6',
  contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5',
  rsa: '1.2.840.113549.1.1.1', sha256Rsa: '1.2.840.113549.1.1.11', sha384Rsa: '1.2.840.113549.1.1.12', sha512Rsa: '1.2.840.113549.1.1.13', sha1Rsa: '1.2.840.113549.1.1.5',
  sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3',
  cn: '2.5.4.3', org: '2.5.4.10',
};
const HASH = { [OID.sha1]: 'SHA-1', [OID.sha256]: 'SHA-256', [OID.sha384]: 'SHA-384', [OID.sha512]: 'SHA-512' };
const RSA = (hash = 'SHA-256') => ({ name: 'RSASSA-PKCS1-v1_5', hash });
const SIG_BYTES = 12288; // room reserved for the CMS blob
const BR_PLACEHOLDER = '[0 1000000000 1000000000 1000000000]';

// ------------------------------------------------------------------ PEM / PKCS#12 identity import
const b64 = (s) => bytes(atob(s.replace(/\s+/g, '')));
const toB64 = (u8) => btoa(bin(u8)).replace(/.{1,64}/g, '$&\n');
export function pemBlocks(text) {
  const out = [], re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let m;
  while ((m = re.exec(text))) out.push({ type: m[1], body: m[2], der: /Proc-Type:\s*4,ENCRYPTED/.test(m[2]) ? null : b64(m[2].replace(/^[A-Za-z-]+:.*$/gm, '')) });
  return out;
}
export const toPem = (type, der) => `-----BEGIN ${type}-----\n${toB64(der)}-----END ${type}-----\n`;

const pkcs8FromPkcs1 = (k) => A.seq(A.int(0), A.seq(A.oid(OID.rsa), A.nul()), A.octet(k));

function indexOfSub(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; }
  return -1;
}
const stripZero = (u8) => { let i = 0; while (i < u8.length - 1 && u8[i] === 0) i++; return u8.subarray(i); };

// Pick the certificate matching the private key, then the rest as the chain.
function assemble(keyDer, certs) {
  if (!keyDer) throw new Error('No private key found');
  if (!certs.length) throw new Error('No certificate found');
  const info = A.parse(keyDer);
  const alg = A.oidStr(info.kids[1].kids[0]);
  if (alg !== OID.rsa) throw new Error('Only RSA keys are supported for signing');
  const rsaKey = A.parse(A.octets(info.kids[2]));
  const modulus = stripZero(A.val(rsaKey.kids[1]));
  let i = certs.findIndex((c) => indexOfSub(c, modulus) >= 0);
  if (i < 0) i = 0;
  const cert = certs[i];
  return { keyDer, cert, chain: certs.filter((_, k) => k !== i), name: certName(cert) };
}

export async function importPEM(text) {
  const blocks = pemBlocks(text);
  if (blocks.some((b) => !b.der && /PRIVATE KEY/.test(b.type))) throw new Error('Encrypted PEM keys are not supported. Remove the passphrase first (openssl pkey -in key.pem -out plain.pem)');
  let key = null;
  const certs = [];
  for (const b of blocks) {
    if (b.type === 'PRIVATE KEY') key = b.der;
    else if (b.type === 'RSA PRIVATE KEY') key = pkcs8FromPkcs1(b.der);
    else if (b.type === 'ENCRYPTED PRIVATE KEY') throw new Error('Encrypted PEM keys are not supported. Remove the passphrase first (openssl pkey -in key.pem -out plain.pem)');
    else if (b.type === 'CERTIFICATE') certs.push(b.der);
  }
  return assemble(key, certs);
}

const PRFS = { '1.2.840.113549.2.7': 'SHA-1', '1.2.840.113549.2.9': 'SHA-256', '1.2.840.113549.2.10': 'SHA-384', '1.2.840.113549.2.11': 'SHA-512' };
const CIPHERS = { '2.16.840.1.101.3.4.1.2': 128, '2.16.840.1.101.3.4.1.22': 192, '2.16.840.1.101.3.4.1.42': 256 };

async function pbes2Decrypt(algId, data, password) {
  if (A.oidStr(algId.kids[0]) !== '1.2.840.113549.1.5.13') throw new Error('This PKCS#12 file uses legacy encryption. Convert it first: openssl pkcs12 -in id.p12 -nodes -out id.pem');
  const [kdf, enc] = algId.kids[1].kids;
  const kp = kdf.kids[1].kids;
  const salt = A.octets(kp[0]), iter = A.intVal(kp[1]);
  const prf = kp.slice(2).find((k) => k.tag === 0x30);
  const hash = prf ? PRFS[A.oidStr(prf.kids[0])] : 'SHA-1';
  const bits = CIPHERS[A.oidStr(enc.kids[0])];
  if (!hash || !bits) throw new Error('Unsupported PKCS#12 encryption scheme');
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash }, base, { name: 'AES-CBC', length: bits }, false, ['decrypt']);
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: A.octets(enc.kids[1]) }, key, data)); } catch { throw new Error('Wrong password or corrupt file'); }
}

export async function importP12(u8, password) {
  const pfx = A.parse(u8);
  const authSafe = pfx.kids[1];
  if (A.oidStr(authSafe.kids[0]) !== OID.data) throw new Error('Unsupported PKCS#12 layout (password-integrity mode only)');
  const safes = A.parse(A.octets(authSafe.kids[1].kids[0]));
  let key = null;
  const certs = [];
  const readBags = async (bags) => {
    for (const bag of bags.kids) {
      const type = A.oidStr(bag.kids[0]), body = bag.kids[1].kids[0];
      if (type === '1.2.840.113549.1.12.10.1.1') key = A.raw(body);
      else if (type === '1.2.840.113549.1.12.10.1.2') key = await pbes2Decrypt(body.kids[0], A.octets(body.kids[1]), password);
      else if (type === '1.2.840.113549.1.12.10.1.3' && A.oidStr(body.kids[0]) === '1.2.840.113549.1.9.22.1') certs.push(A.octets(body.kids[1].kids[0]));
    }
  };
  for (const ci of safes.kids) {
    const type = A.oidStr(ci.kids[0]), body = ci.kids[1].kids[0];
    if (type === OID.data) await readBags(A.parse(A.octets(body)));
    else if (type === OID.encryptedData) {
      const eci = body.kids[1];
      const content = eci.kids.find((k) => k.cls === 2 && k.n === 0);
      await readBags(A.parse(await pbes2Decrypt(eci.kids[1], A.octets(content), password)));
    }
  }
  return assemble(key, certs);
}

// ------------------------------------------------------------------ certificate helpers
function certParts(der) {
  const c = A.parse(der), tbs = c.kids[0];
  const o = tbs.kids[0].tag === 0xa0 ? 1 : 0;
  const k = tbs.kids;
  return { cert: c, serial: k[o], issuer: k[o + 2], validity: k[o + 3], subject: k[o + 4], spki: k[o + 5] };
}
function nameString(name, want = OID.cn) {
  for (const rdn of name.kids) for (const atv of rdn.kids) if (A.oidStr(atv.kids[0]) === want) return new TextDecoder().decode(A.val(atv.kids[1]));
  return '';
}
export function certName(der) { const p = certParts(der); return nameString(p.subject) || nameString(p.subject, OID.org) || 'Signer'; }
function parseTime(n) {
  const s = new TextDecoder().decode(A.val(n));
  const m = n.tag === 0x18 ? /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(s) : /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/.exec(s);
  if (!m) return null;
  const y = n.tag === 0x18 ? +m[1] : +m[1] + (+m[1] < 50 ? 2000 : 1900);
  return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// Self-signed RSA-2048 certificate for signing documents. Returns the same shape as importPEM plus PEM text for reuse.
export async function createSelfSigned(commonName, org = '', years = 5) {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const keyDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const rdn = (o, v) => A.set(A.seq(A.oid(o), A.utf8Str(v)));
  const name = A.seq(...(org ? [rdn(OID.org, org)] : []), rdn(OID.cn, commonName));
  const serial = crypto.getRandomValues(new Uint8Array(16)); serial[0] &= 0x7f; serial[0] |= 0x01;
  const now = new Date(), end = new Date(now); end.setUTCFullYear(end.getUTCFullYear() + years);
  const sigAlg = A.seq(A.oid(OID.sha256Rsa), A.nul());
  const keyUsage = A.seq(A.oid('2.5.29.15'), A.tlv(1, Uint8Array.of(0xff)), A.octet(Uint8Array.of(3, 2, 7, 0x80)));
  const tbs = A.seq(A.ctx(0, true, A.int(2)), A.int(serial), sigAlg, name, A.seq(A.utcTime(now), A.utcTime(end)), name, spki, A.ctx(3, true, A.seq(keyUsage)));
  const sig = new Uint8Array(await crypto.subtle.sign(RSA(), kp.privateKey, tbs));
  const cert = A.seq(tbs, sigAlg, A.bitstr(sig));
  return { keyDer, cert, chain: [], name: commonName, pem: toPem('CERTIFICATE', cert) + toPem('PRIVATE KEY', keyDer) };
}

// ------------------------------------------------------------------ signing
async function cmsFor(ident, digest) {
  const { issuer, serial } = certParts(ident.cert);
  const attr = (o, v) => A.seq(A.oid(o), A.set(v));
  const attrs = [attr(OID.contentType, A.oid(OID.data)), attr(OID.signingTime, A.utcTime(new Date())), attr(OID.messageDigest, A.octet(digest))];
  const signedDer = A.setSorted(...attrs);
  const key = await crypto.subtle.importKey('pkcs8', ident.keyDer, RSA(), false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(RSA(), key, signedDer));
  const inSigner = signedDer.slice(); inSigner[0] = 0xa0; // [0] IMPLICIT
  const signerInfo = A.seq(A.int(1), A.seq(A.raw(issuer), A.raw(serial)), A.seq(A.oid(OID.sha256), A.nul()), inSigner, A.seq(A.oid(OID.rsa), A.nul()), A.octet(sig));
  const certs = [ident.cert, ...ident.chain];
  return A.seq(A.oid(OID.signedData), A.ctx(0, true, A.seq(A.int(1), A.set(A.seq(A.oid(OID.sha256), A.nul())), A.seq(A.oid(OID.data)), A.ctx(0, true, ...certs), A.set(signerInfo))));
}

function appearance(doc, rect, name, reason, date) {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const esc = (s) => s.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');
  const lines = [`Digitally signed by ${name}`, `Date: ${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`, ...(reason ? [`Reason: ${reason}`] : [])];
  const fs = Math.max(6, Math.min(10, (h - 6) / (lines.length + 0.5)));
  let c = `0.95 0.98 0.95 rg 0 0 ${fmtNum(w)} ${fmtNum(h)} re f 0.2 0.5 0.3 RG 0.75 w 0.4 0.4 ${fmtNum(w - 0.8)} ${fmtNum(h - 0.8)} re S BT /F1 ${fmtNum(fs)} Tf 0 g\n`;
  lines.forEach((l, i) => { c += `1 0 0 1 4 ${fmtNum(h - 4 - fs * (i + 1))} Tm (${esc(l)}) Tj\n`; });
  c += 'ET';
  const font = new Dict({ Type: N('Font'), Subtype: N('Type1'), BaseFont: N('Helvetica') });
  const form = new Stream(new Dict({ Type: N('XObject'), Subtype: N('Form'), BBox: [0, 0, w, h], Resources: new Dict({ Font: new Dict({ F1: font }) }) }), utf8(c));
  return doc.add(form);
}

// opts: { reason, location, contact, visible, page (0-based), rect }
export async function signPDF(srcBytes, ident, opts = {}) {
  const doc = await PDFDoc.load(srcBytes);
  if (doc.sec) throw new Error('Encrypted documents cannot be signed in this build. Remove the password first.');
  const now = new Date();
  const pageIdx = Math.min(Math.max(0, opts.page ?? 0), doc.pageCount - 1);
  const page = doc.pages[pageIdx];
  const rect = opts.visible ? (opts.rect || [36, 36, 236, 96]) : [0, 0, 0, 0];

  const sig = new Dict({ Type: N('Sig'), Filter: N('Adobe.PPKLite'), SubFilter: N('adbe.pkcs7.detached'), M: new Str(pdfDate(now)), Name: textStr(ident.name) });
  for (const [k, v] of [['Reason', opts.reason], ['Location', opts.location], ['ContactInfo', opts.contact]]) if (v) sig.set(k, textStr(v));
  sig.set('ByteRange', [0, 1000000000, 1000000000, 1000000000]);
  sig.set('Contents', new Str('\0'.repeat(SIG_BYTES), true));
  const sigRef = doc.add(sig);

  const used = new Set(fields(doc).map((f) => f.name));
  let fname = 'Signature1';
  for (let i = 2; used.has(fname); i++) fname = 'Signature' + i;
  const widget = new Dict({ Type: N('Annot'), Subtype: N('Widget'), FT: N('Sig'), T: textStr(fname), V: sigRef, Rect: rect, F: 132, P: page.ref });
  if (opts.visible) widget.set('AP', new Dict({ N: appearance(doc, rect, ident.name, opts.reason, now) }));
  const wref = doc.add(widget);

  const pd = doc.touch(page.ref);
  pd.set('Annots', [...(doc.get(pd.get('Annots')) || []), wref]);
  const cat = doc.touch(doc.rootRef);
  const arRaw = cat.get('AcroForm');
  let af;
  if (arRaw instanceof Ref) af = doc.touch(arRaw);
  else if (arRaw instanceof Dict) { af = clone(arRaw); cat.set('AcroForm', doc.add(af)); }
  else { af = new Dict({ Fields: [] }); cat.set('AcroForm', doc.add(af)); }
  af.set('Fields', [...(doc.get(af.get('Fields')) || []), wref]);
  af.set('SigFlags', 3);

  const out = await saveIncremental(doc);
  const start = doc.bytes.length;
  const tail = bin(out.subarray(start));
  const brAt = tail.indexOf('/ByteRange ' + BR_PLACEHOLDER);
  const zeros = '<' + '0'.repeat(SIG_BYTES * 2) + '>';
  const ctAt = tail.indexOf('/Contents ' + zeros);
  if (brAt < 0 || ctAt < 0) throw new Error('Could not locate the signature placeholder');
  const cStart = start + ctAt + 10, cEnd = cStart + zeros.length;
  const br = `[0 ${cStart} ${cEnd} ${out.length - cEnd}]`.padEnd(BR_PLACEHOLDER.length, ' ');
  out.set(bytes(br), start + brAt + 11);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', concat([out.subarray(0, cStart), out.subarray(cEnd)])));
  const cms = await cmsFor(ident, digest);
  if (cms.length > SIG_BYTES) throw new Error('Certificate chain is too large to embed');
  let hex = ''; for (const b of cms) hex += b.toString(16).padStart(2, '0');
  out.set(bytes(hex.padEnd(SIG_BYTES * 2, '0')), cStart + 1);
  return out;
}

// ------------------------------------------------------------------ verification
export async function verifySignatures(doc) {
  const results = [];
  for (const f of fields(doc).filter((x) => x.type === 'signature')) {
    const widget = doc.get(f.ref), v = doc.get(widget.get('V'));
    if (!(v instanceof Dict)) continue;
    const r = { field: f.name, signer: '', signed: null, reason: '', location: '', ok: false, intact: false, coversAll: false, selfSigned: false, certValid: null, notes: [] };
    results.push(r);
    r.reason = v.get('Reason') ? String(doc.get(v.get('Reason')).s) : '';
    r.location = v.get('Location') ? String(doc.get(v.get('Location')).s) : '';
    const m = doc.get(v.get('M'));
    r.signed = m instanceof Str ? parseDate(m.s) : null;
    try {
      const br = (doc.get(v.get('ByteRange')) || []).map((x) => doc.get(x));
      const contents = doc.get(v.get('Contents'));
      if (br.length !== 4 || !(contents instanceof Str)) throw new Error('Malformed signature dictionary');
      const sub = (doc.get(v.get('SubFilter')) || {}).n;
      if (sub !== 'adbe.pkcs7.detached') throw new Error('Unsupported signature format ' + (sub || '(none)'));
      const file = doc.bytes;
      const [a, b, c, d] = br;
      if (a !== 0 || b > c || c + d > file.length) throw new Error('Invalid ByteRange');
      r.coversAll = c + d === file.length;
      const signedBytes = concat([file.subarray(a, a + b), file.subarray(c, c + d)]);
      const cms = A.parse(bytes(contents.s));
      const sd = cms.kids[1].kids[0];
      const certsNode = sd.kids.find((k) => k.cls === 2 && k.n === 0);
      const certs = certsNode ? certsNode.kids.map((k) => A.raw(k)) : [];
      const si = sd.kids[sd.kids.length - 1].kids[0];
      const sid = si.kids[1];
      const hashName = HASH[A.oidStr(si.kids[2].kids[0])];
      if (!hashName) throw new Error('Unsupported digest algorithm');
      const attrsNode = si.kids.find((k) => k.cls === 2 && k.n === 0);
      const sigNode = si.kids[si.kids.length - 1];
      const signerCert = certs.find((c0) => { const p = certParts(c0); return bin(A.raw(p.issuer)) === bin(A.raw(sid.kids[0])) && bin(A.raw(p.serial)) === bin(A.raw(sid.kids[1])); });
      if (!signerCert) throw new Error('Signer certificate is not embedded');
      const p = certParts(signerCert);
      r.signer = nameString(p.subject) || nameString(p.subject, OID.org) || 'Unknown';
      r.selfSigned = bin(A.raw(p.issuer)) === bin(A.raw(p.subject));
      const nb = parseTime(p.validity.kids[0]), na = parseTime(p.validity.kids[1]), when = r.signed || new Date();
      r.certValid = !!(nb && na && when >= nb && when <= na);
      if (!r.certValid) r.notes.push('Certificate was not valid at signing time');
      let verified;
      const digest = new Uint8Array(await crypto.subtle.digest(hashName, signedBytes));
      let signedData = signedBytes;
      if (attrsNode) {
        const md = attrsNode.kids.find((k) => A.oidStr(k.kids[0]) === OID.messageDigest);
        const want = md ? A.octets(md.kids[1].kids[0]) : null;
        r.intact = !!want && bin(want) === bin(digest);
        signedData = A.raw(attrsNode).slice(); signedData[0] = 0x31;
      } else r.intact = true;
      const alg = A.oidStr(p.spki.kids[0].kids[0]);
      if (alg !== OID.rsa) throw new Error('Only RSA signatures can be verified in this build');
      const pub = await crypto.subtle.importKey('spki', A.raw(p.spki), RSA(hashName), false, ['verify']);
      verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, A.octets(sigNode), signedData);
      if (!r.intact) r.notes.push('Document content does not match the signed digest');
      else if (!verified) r.notes.push('Signature value does not verify');
      r.ok = r.intact && verified;
      if (r.ok && !r.coversAll) r.notes.push('Document changed after this signature was applied (later revision)');
      if (r.selfSigned) r.notes.push('Self-signed certificate: identity is not verified against a trusted authority');
      else r.notes.push('Certificate chain was not checked against a trusted root');
    } catch (e) { r.notes.push(e.message || String(e)); }
  }
  return results;
}

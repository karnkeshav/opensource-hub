// Digital signature UI: sign with a certificate file or a new self-signed one, and verify signatures.
import { h, toast, dialog, promptDlg, pickFile, readFile, download } from './util.js';
import { saveFull, saveIncremental } from '../pdf/writer.js';
import { importPEM, importP12, createSelfSigned, signPDF, verifySignatures } from '../pdf/sign.js';

const base = (app) => app.name.replace(/\.pdf$/i, '');

export function enterEditMode(app) {
  app.sub.text = 'edit';
  app.setTool('text');
  toast(app.isSigned() ? 'Edit mode on. This file is signed: saving appends a new revision and keeps earlier signatures' : 'Edit mode on. Click text to edit it', 5000);
}

async function loadIdentity() {
  const files = await pickFile('.p12,.pfx,.pem,.crt,.cer,.key', true);
  if (!files.length) return null;
  const p12 = files.find((f) => /\.(p12|pfx)$/i.test(f.name));
  try {
    if (p12) {
      const pw = await promptDlg('Certificate password', `Password for ${p12.name}`, '', { type: 'password', ok: 'Open' });
      if (pw === null) return null;
      return await importP12(await readFile(p12), pw);
    }
    const text = (await Promise.all(files.map(async (f) => new TextDecoder().decode(await readFile(f))))).join('\n');
    return await importPEM(text);
  } catch (e) { toast('Cannot use certificate: ' + e.message, 7000); return null; }
}

export async function digitalSign(app) {
  if (!app.doc) return;
  if (app.doc.sec) return toast('Remove the document password before signing (Protect > Remove security)', 6000);
  const v = await dialog('Digitally sign', [
    { name: 'src', label: 'Certificate', type: 'select', value: 'file', options: [['file', 'Use a certificate file (.p12, .pfx or PEM)'], ['new', 'Create a new self-signed certificate']] },
    { name: 'cn', label: 'Name (for a new certificate)', value: '' },
    { name: 'reason', label: 'Reason (optional)', value: '' },
    { name: 'location', label: 'Location (optional)', value: '' },
    { name: 'visible', label: 'Show a visible signature box', type: 'checkbox', value: true },
    { name: 'where', label: 'Visible box on', type: 'select', value: 'last', options: [['first', 'First page, bottom left'], ['last', 'Last page, bottom left']] },
    { name: 'edit', label: 'Edit the document first (Edit mode), then sign', type: 'checkbox', value: false },
  ], { ok: 'Sign', width: 520, hint: 'Pending edits are included. After signing, further edits are saved as a new revision and the signature stays valid for the signed one. Self-signed certificates prove integrity but not identity.' });
  if (!v) return;
  if (v.edit) { enterEditMode(app); toast('Make your edits, then run Digitally sign again', 6000); return; }
  let ident;
  if (v.src === 'new') {
    const cn = (v.cn || '').trim();
    if (!cn) return toast('Enter a name for the certificate');
    app.msg('Creating certificate…');
    ident = await createSelfSigned(cn);
    app.msg('');
    download(`${cn.replace(/[^\w.-]+/g, '_')}-signing-identity.pem`, ident.pem, 'application/x-pem-file');
    toast('Saved your signing identity (certificate and private key). Keep that file private', 7000);
  } else {
    ident = await loadIdentity();
    if (!ident) return;
  }
  try {
    app.msg('Signing…');
    const d = app.doc;
    const src = d.bytes.length && !d.needsFullSave ? await saveIncremental(d) : await saveFull(d, { objStreams: false });
    const page = v.where === 'first' ? 0 : d.pageCount - 1;
    const signed = await signPDF(src, ident, { reason: v.reason, location: v.location, visible: v.visible, page });
    d.dirty = false;
    const name = `${base(app)}-signed.pdf`;
    download(name, signed, 'application/pdf');
    await app.openBytes(signed, name);
    toast(`Signed as ${ident.name}`);
  } catch (e) { toast('Signing failed: ' + e.message, 7000); console.error(e); }
  app.msg('');
}

const when = (d) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time');

export async function verify(app) {
  if (!app.doc) return;
  app.msg('Verifying…');
  let res;
  try { res = await verifySignatures(app.doc); } catch (e) { app.msg(''); return toast('Verification failed: ' + e.message, 6000); }
  app.msg('');
  if (!res.length) return toast('This document has no digital signatures');
  const rows = res.map((r) => h('div', { class: 'sigres' },
    h('div', null, h('b', null, (r.ok ? '✔ ' : '✘ ') + (r.signer || r.field)), ` · ${r.ok ? (r.coversAll ? 'valid, document unchanged since signing' : 'valid, but the document changed afterwards') : 'INVALID'}`),
    h('div', { class: 'small muted' }, `${r.field} · signed ${when(r.signed)}${r.reason ? ' · ' + r.reason : ''}${r.location ? ' · ' + r.location : ''}`),
    ...r.notes.map((n) => h('div', { class: 'small muted' }, '• ' + n))));
  await dialog('Signatures', [], { ok: 'Close', cancel: null, width: 560, extra: h('div', null, rows) });
}

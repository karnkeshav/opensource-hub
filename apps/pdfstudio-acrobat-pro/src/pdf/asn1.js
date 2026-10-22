// Minimal ASN.1 BER/DER reader and DER writer.
export function parse(b, p = 0, end = b.length) {
  const tag = b[p], cls = tag >> 6, cons = !!(tag & 0x20);
  let q = p + 1, n = tag & 31;
  if (n === 31) { n = 0; while (b[q] & 0x80) n = n * 128 + (b[q++] & 127); n = n * 128 + b[q++]; }
  let len = b[q++];
  let indef = false;
  if (len === 0x80) indef = true;
  else if (len & 0x80) { const k = len & 127; len = 0; for (let i = 0; i < k; i++) len = len * 256 + b[q++]; }
  const node = { tag, cls, n, cons, start: p, hdr: q - p, b };
  if (indef) {
    node.kids = [];
    let r = q;
    while (r < end && !(b[r] === 0 && b[r + 1] === 0)) { const k = parse(b, r, end); node.kids.push(k); r = k.end; }
    node.end = r + 2; node.vs = q; node.ve = r;
  } else {
    node.vs = q; node.ve = q + len; node.end = q + len;
    if (cons) { node.kids = []; let r = q; while (r < node.ve) { const k = parse(b, r, node.ve); node.kids.push(k); r = k.end; } }
  }
  return node;
}
export const val = (n) => n.b.subarray(n.vs, n.ve);
export const raw = (n) => n.b.subarray(n.start, n.end);
// OCTET STRING content (handles constructed BER octet strings)
export function octets(n) {
  if (!n.cons) return val(n);
  const parts = n.kids.map(octets), o = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let i = 0; for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}
export function oidStr(n) {
  const v = val(n), out = [Math.floor(v[0] / 40), v[0] % 40];
  let x = 0; for (let i = 1; i < v.length; i++) { x = x * 128 + (v[i] & 127); if (!(v[i] & 128)) { out.push(x); x = 0; } }
  return out.join('.');
}
export const intVal = (n) => { const v = val(n); let x = 0; for (const c of v) x = x * 256 + c; return x; };
// ---- DER writer
const len = (n) => { if (n < 128) return [n]; const o = []; while (n) { o.unshift(n & 255); n = Math.floor(n / 256); } return [0x80 | o.length, ...o]; };
const cat = (parts) => { const o = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
export const tlv = (tag, ...content) => { const c = cat(content.flat()); return cat([Uint8Array.of(tag, ...len(c.length)), c]); };
export const seq = (...k) => tlv(0x30, ...k);
export const set = (...k) => tlv(0x31, ...k);
export const setSorted = (...k) => { const items = k.flat().slice().sort((a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }); return tlv(0x31, ...items); };
export const ctx = (n, cons, ...k) => tlv((cons ? 0xa0 : 0x80) | n, ...k);
export const octet = (u8) => tlv(0x04, u8);
export const nul = () => Uint8Array.of(5, 0);
export function oid(s) {
  const p = s.split('.').map(Number), o = [p[0] * 40 + p[1]];
  for (const x of p.slice(2)) { const t = []; let v = x; do { t.unshift(v & 127); v = Math.floor(v / 128); } while (v); for (let i = 0; i < t.length - 1; i++) t[i] |= 128; o.push(...t); }
  return tlv(6, Uint8Array.from(o));
}
export function int(v) {
  if (typeof v === 'number') { const o = []; do { o.unshift(v & 255); v = Math.floor(v / 256); } while (v); if (o[0] & 128) o.unshift(0); return tlv(2, Uint8Array.from(o)); }
  let i = 0; while (i < v.length - 1 && v[i] === 0 && !(v[i + 1] & 128)) i++;
  const b = v.subarray(i);
  return tlv(2, b[0] & 128 ? cat([Uint8Array.of(0), b]) : b);
}
export const utcTime = (d) => { const p = (x) => String(x).padStart(2, '0'); return tlv(0x17, new TextEncoder().encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };
export const utf8Str = (s) => tlv(0x0c, new TextEncoder().encode(s));
export const bitstr = (u8) => tlv(3, cat([Uint8Array.of(0), u8]));
export { cat };

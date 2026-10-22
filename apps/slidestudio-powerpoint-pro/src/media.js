// Image helpers: data URL <-> bytes, type sniffing and natural size from PNG / JPEG / GIF headers.
export function b64ToBytes(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
export function bytesToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
export const toDataUrl = (u, type) => `data:${type};base64,${bytesToB64(u)}`;
export function fromDataUrl(d) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(d || '');
  if (!m) return null;
  return { type: m[1], bytes: m[2] ? b64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])) };
}
export function sniff(u) {
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png';
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x47 && u[1] === 0x49) return 'image/gif';
  if (u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp';
  if (u[8] === 0x57 && u[9] === 0x45) return 'image/webp';
  if (/<svg/i.test(new TextDecoder().decode(u.subarray(0, 600)))) return 'image/svg+xml';
  return '';
}
export function imgSize(u) {
  const t = sniff(u), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  try {
    if (t === 'image/png') return [v.getUint32(16), v.getUint32(20)];
    if (t === 'image/gif') return [v.getUint16(6, true), v.getUint16(8, true)];
    if (t === 'image/jpeg') {
      for (let p = 2; p < u.length - 9;) {
        if (u[p] !== 0xff) { p++; continue; }
        const m = u[p + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(p + 7), v.getUint16(p + 5)];
        p += 2 + v.getUint16(p + 2);
      }
    }
  } catch { /* truncated header */ }
  return [0, 0];
}
// Store bytes in the deck's media table (deduplicated); returns the media id.
export function addMedia(deck, bytes, name = '') {
  const type = sniff(bytes);
  const d = toDataUrl(bytes, type || 'application/octet-stream');
  for (const [id, m] of Object.entries(deck.media)) if (m.d === d) return id;
  const id = 'm' + (Object.keys(deck.media).length + 1).toString(36) + Math.random().toString(36).slice(2, 6);
  const [w, h] = imgSize(bytes);
  deck.media[id] = { d, w, h, n: name };
  return id;
}
// Move data: URLs found in outline text into the media table so the outline stays readable.
export function extractDataUrls(text, deck) {
  return text.replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/g, (all, alt, d) => {
    const x = fromDataUrl(d);
    return x ? `![${alt}](media:${addMedia(deck, x.bytes)})` : all;
  });
}

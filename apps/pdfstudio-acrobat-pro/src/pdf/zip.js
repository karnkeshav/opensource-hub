// Minimal ZIP reader/writer on the browser's native (De)CompressionStream. No dependencies.
const T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[i] = c >>> 0; }
export const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

const enc = new TextEncoder(), dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const text = (b) => dec.decode(b);

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? utf8(content) : content;
    const nm = utf8(name), crc = crc32(data);
    let body = data, method = 0;
    if (data.length > 80) { const d = await pipe(data, new CompressionStream('deflate-raw')); if (d.length < data.length) { body = d; method = 8; } }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), nm, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + body.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0), n = central.length / 2;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, n, true); end.setUint16(10, n, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// Returns { name: () => Promise<Uint8Array> }
export function unzip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a ZIP/XLSX file');
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = text(b.subarray(p + 46, p + 46 + nl));
    out[name] = async () => {
      const ln = v.getUint16(lo + 26, true), le = v.getUint16(lo + 28, true), s = lo + 30 + ln + le;
      const raw = b.subarray(s, s + csize);
      if (method === 0) return raw;
      if (method === 8) return pipe(raw, new DecompressionStream('deflate-raw'));
      throw new Error('Unsupported ZIP compression method ' + method);
    };
    p += 46 + nl + el + cl;
  }
  return out;
}

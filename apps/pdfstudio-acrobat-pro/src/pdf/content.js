// Content stream: parse into operations and serialize back.
import { Lexer, parseObj, Cmd, EOF, isWS } from './parser.js';
import { Dict, Name, bytes, concat } from './obj.js';
import { ser } from './writer.js';

// Returns [{op, args, pos}] ; inline images become {op:'BI', args:[dict, Uint8Array]}
export function parseContent(u8) {
  const lx = new Lexer(u8), ops = [];
  let args = [];
  for (let guard = 0; guard < 5e7; guard++) {
    const start = lx.p;
    const t = lx.tok();
    if (t === EOF) break;
    if (t instanceof Cmd) {
      const c = t.c;
      if (c === '[' || c === '<<') { args.push(parseObj(lx, t)); continue; }
      if (c === 'true') { args.push(true); continue; }
      if (c === 'false') { args.push(false); continue; }
      if (c === 'null') { args.push(null); continue; }
      if (c === 'BI') {
        const d = new Dict();
        for (;;) {
          const k = lx.tok();
          if (k === EOF || (k instanceof Cmd && k.c === 'ID')) break;
          if (k instanceof Name) d.set(k.n, parseObj(lx));
        }
        let p = lx.p;
        if (isWS(u8[p])) p++;
        // find EI surrounded by whitespace and followed by something that looks like an operator
        let e = p, end = -1;
        while (e < u8.length - 1) {
          if (u8[e] === 69 && u8[e + 1] === 73 && isWS(u8[e - 1]) && (e + 2 >= u8.length || isWS(u8[e + 2]))) {
            let ok = true;
            for (let k = e + 2; k < Math.min(u8.length, e + 12); k++) { const ch = u8[k]; if (ch > 127 || (ch < 32 && !isWS(ch))) { ok = false; break; } }
            if (ok) { end = e; break; }
          }
          e++;
        }
        if (end < 0) end = u8.length;
        ops.push({ op: 'BI', args: [d, u8.subarray(p, Math.max(p, end - 1))], pos: start });
        lx.p = Math.min(u8.length, end + 2);
        args = [];
        continue;
      }
      ops.push({ op: c, args, pos: start });
      args = [];
      continue;
    }
    args.push(parseObj(lx, t));
    if (args.length > 5000) args = [];
  }
  return ops;
}

export function serContent(ops) {
  const parts = [];
  let s = '';
  for (const o of ops) {
    if (o.op === 'BI') {
      let d = 'BI';
      for (const [k, v] of o.args[0]) d += ' /' + k + ' ' + ser(v);
      s += d + ' ID ';
      parts.push(bytes(s)); s = '';
      parts.push(o.args[1]);
      s = '\nEI\n';
      continue;
    }
    s += o.args.length ? o.args.map((a) => ser(a)).join(' ') + ' ' + o.op + '\n' : o.op + '\n';
    if (s.length > 65536) { parts.push(bytes(s)); s = ''; }
  }
  parts.push(bytes(s));
  return concat(parts);
}
export const op = (o, ...args) => ({ op: o, args });

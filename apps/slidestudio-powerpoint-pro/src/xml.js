// Tiny XML parser/escaper (from SheetStudio Excel Pro, with prefixed attribute names kept).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unesc = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m))));
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

export function parseXML(s) {
  const root = { n: '', a: {}, c: [], t: '' }, st = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[6] !== undefined) st[st.length - 1].t += unesc(m[6]);
    else if (m[1] !== undefined) st[st.length - 1].t += m[1];
    else if (m[3] !== undefined) {
      if (m[2]) { if (st.length > 1) st.pop(); continue; }
      const a = {};
      // keep prefixed names too: <p:sldId id="256" r:id="rId2"> needs both "id" and "r:id"
      if (m[4]) for (const x of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) { const v = unesc(x[2] ?? x[3]), s = x[1].replace(/^.*:/, ''); a[x[1]] = v; if (s === x[1] || !(s in a)) a[s] = v; }
      const node = { n: m[3].replace(/^.*:/, ''), a, c: [], t: '' };
      st[st.length - 1].c.push(node);
      if (!m[5]) st.push(node);
    }
  }
  return root;
}
export const kids = (n, name) => (n ? n.c.filter((x) => x.n === name) : []);
export const kid = (n, name) => (n ? n.c.find((x) => x.n === name) : undefined);
// depth-first search for the first descendant with this local name
export const find = (n, name) => { if (!n) return undefined; if (n.n === name) return n; for (const c of n.c) { const x = find(c, name); if (x) return x; } };
export const findAll = (n, name, out = []) => { if (!n) return out; if (n.n === name) out.push(n); for (const c of n.c) findAll(c, name, out); return out; };
export const textOf = (n) => (n ? n.t + n.c.map(textOf).join('') : '');

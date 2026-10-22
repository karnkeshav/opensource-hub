// Diagram-from-text: arrows / indentation / "label: value" lines -> a graph -> native shapes and connectors.
//   flow:  A -> B -> C?   (layered left to right; "x?" diamond, "(x)" ellipse, "[x]" rectangle)
//   org:   indented tree (top-down, elbow connectors)      cycle / rel: items or arrows around a circle
//   timeline: "2024: text" lines                           bar: "Label: 42" lines (drawn as shapes, not a chart object)
import { P } from './model.js';
import { onColor } from './color.js';

export const DIAGRAMS = { flow: 'Flowchart', org: 'Org chart / tree', timeline: 'Timeline', cycle: 'Cycle', rel: 'Relationship', bar: 'Bar chart (shapes)' };
const ARROW = /\s*(<->|-->|->|<--|<-|---|--)\s*/;

export function parseGraph(k, src) {
  const nodes = [], ix = new Map(), edges = [];
  const node = (raw) => {
    let label = raw.trim(), g = 'roundRect', m;
    if ((m = /^\((.*)\)$/.exec(label))) { label = m[1].trim(); g = 'ellipse'; } else if ((m = /^\[(.*)\]$/.exec(label))) { label = m[1].trim(); g = 'rect'; } else if (/\?$/.test(label)) g = 'diamond';
    if (!ix.has(label)) { ix.set(label, nodes.length); nodes.push({ label, g, text: '' }); }
    return ix.get(label);
  };
  const lines = String(src).split('\n').filter((l) => l.trim());
  if (k === 'org' || k === 'tree') {
    const st = [];
    for (const l of lines) {
      const ind = /^\s*/.exec(l)[0].replace(/\t/g, '  ').length, n = node(l.replace(/^\s*([-*+•]\s+)?/, ''));
      while (st.length && st[st.length - 1].ind >= ind) st.pop();
      if (st.length && st[st.length - 1].n !== n) edges.push({ a: st[st.length - 1].n, b: n });
      st.push({ ind, n });
    }
  } else if (k === 'timeline' || k === 'bar') {
    for (const l of lines) { const m = /^\s*(?:[-*•]\s+)?(.+?)\s*(?::|\s-\s|\|)\s*(.*)$/.exec(l); nodes.push({ label: (m ? m[1] : l).trim(), text: m ? m[2].trim() : '' }); }
  } else {
    for (const l of lines) {
      const parts = l.split(ARROW);
      let prev = parts[0].trim() ? node(parts[0]) : -1;
      for (let i = 1; i < parts.length; i += 2) {
        const nx = parts[i + 1] && parts[i + 1].trim() ? node(parts[i + 1]) : -1, a = parts[i];
        if (prev >= 0 && nx >= 0 && prev !== nx) {
          if (a[0] === '<' && a.slice(-1) !== '>') edges.push({ a: nx, b: prev, te: 1 });
          else edges.push({ a: prev, b: nx, te: a.slice(-1) === '>' ? 1 : 0, he: a[0] === '<' ? 1 : 0 });
        }
        prev = nx;
      }
    }
    if (k === 'cycle' && !edges.length && nodes.length > 1) nodes.forEach((_, i) => edges.push({ a: i, b: (i + 1) % nodes.length, te: 1 }));
  }
  return { nodes, edges };
}

// longest-path layering; back edges (cycles) are ignored
function layers(n, edges) {
  const out = Array.from({ length: n }, () => []), L = new Array(n).fill(0), st = new Uint8Array(n), order = [], pos = [];
  edges.forEach((e) => out[e.a].push(e.b));
  const dfs = (u) => { st[u] = 1; for (const v of out[u]) if (!st[v]) dfs(v); order.push(u); };
  for (let i = 0; i < n; i++) if (!st[i]) dfs(i);
  order.forEach((u, i) => { pos[u] = i; });
  for (let i = order.length - 1; i >= 0; i--) { const u = order[i]; for (const v of out[u]) if (pos[v] < pos[u]) L[v] = Math.max(L[v], L[u] + 1); }
  return L;
}

export function diagram(dg, r, th, ov = {}) {
  const { nodes, edges } = parseGraph(dg.k, dg.src), k = dg.k, out = [], n = nodes.length;
  if (!n) return out;
  const tx = (key, t, x, y, w, h, o) => out.push({ k: key, t: 'text', x, y, w, h, paras: [P(t, { al: 'ctr' })], base: [18], font: th.body, col: th.text, an: 'ctr', fit: 1, ...o });
  if (k === 'timeline') {
    const ay = r.y + r.h * 0.42, cw = (r.w / n) * 0.94;
    out.push({ k: 'dgx', t: 'line', g: 'line', x: r.x, y: ay, w: r.w, h: 0, ln: { c: th.line, w: 2.5, te: 'triangle' } });
    nodes.forEach((nd, i) => {
      const cx = r.x + (r.w * (i + 0.5)) / n;
      out.push({ k: 'dgd:' + i, t: 'shape', g: 'ellipse', x: cx - 9, y: ay - 9, w: 18, h: 18, fill: th.acc[i % 6] });
      tx('dg:' + nd.label, nd.label, cx - cw / 2, r.y, cw, ay - r.y - 14, { an: 'b', b: 1, col: th.title, base: [22], grp: 'dgl' });
      if (nd.text) tx('dgt:' + i, nd.text, cx - cw / 2, ay + 16, cw, r.y + r.h - ay - 16, { an: 't', base: [20], grp: 'dgt' });
    });
    return out;
  }
  if (k === 'bar') {
    const vals = nodes.map((nd) => parseFloat(nd.text.replace(/[^\d.eE+-]/g, '')) || 0), mx = Math.max(0, ...vals), mn = Math.min(0, ...vals), rg = mx - mn || 1;
    const top = r.y + 30, ph = r.h - 30 - 36, base = top + (ph * mx) / rg, slot = r.w / n, bw = slot * 0.62;
    nodes.forEach((nd, i) => {
      const v = vals[i], bh = (ph * Math.abs(v)) / rg, x = r.x + slot * i + (slot - bw) / 2, y = v >= 0 ? base - bh : base;
      out.push({ k: 'dg:' + nd.label, t: 'shape', g: 'rect', x, y, w: bw, h: Math.max(bh, 1), fill: th.fills[0] });
      tx('dgv:' + i, nd.text, x - slot * 0.15, v >= 0 ? y - 28 : y + bh + 2, bw + slot * 0.3, 26, { base: [16], b: 1, grp: 'dgv' });
      tx('dgl:' + i, nd.label, r.x + slot * i, r.y + r.h - 34, slot, 34, { base: [16], col: th.muted, grp: 'dgl' });
    });
    out.push({ k: 'dgx', t: 'line', g: 'line', x: r.x, y: base, w: r.w, h: 0, ln: { c: th.line, w: 1.5 } });
    return out;
  }
  // node positions
  let pos, depth = new Array(n).fill(0);
  const tree = k === 'org' || k === 'tree';
  if (tree) {
    const kids = Array.from({ length: n }, () => []), hasP = new Uint8Array(n), seen = new Uint8Array(n), x = new Array(n).fill(0);
    edges.forEach((e) => { kids[e.a].push(e.b); hasP[e.b] = 1; });
    let leaf = 0, maxD = 0;
    const walk = (u, d) => {
      seen[u] = 1; depth[u] = d; maxD = Math.max(maxD, d);
      const ks = kids[u].filter((v) => !seen[v]);
      ks.forEach((v) => walk(v, d + 1));
      x[u] = ks.length ? (x[ks[0]] + x[ks[ks.length - 1]]) / 2 : leaf++;
    };
    for (let i = 0; i < n; i++) if (!hasP[i] && !seen[i]) walk(i, 0);
    for (let i = 0; i < n; i++) if (!seen[i]) walk(i, 0);
    const cw = r.w / leaf, rh = r.h / (maxD + 1), w = Math.min(cw * 0.86, 210), h = Math.min(rh * 0.58, 84);
    pos = nodes.map((_, i) => ({ x: r.x + cw * (x[i] + 0.5) - w / 2, y: r.y + rh * depth[i] + (rh - h) / 2, w, h }));
  } else if (k === 'cycle' || k === 'rel') {
    const w = Math.min(r.w * 0.26, 200), h = Math.min(r.h * 0.19, 74), rx = n > 1 ? r.w / 2 - w / 2 : 0, ry = n > 1 ? r.h / 2 - h / 2 : 0;
    pos = nodes.map((_, i) => { const a = (-90 + (360 * i) / n) * Math.PI / 180; return { x: r.x + r.w / 2 + rx * Math.cos(a) - w / 2, y: r.y + r.h / 2 + ry * Math.sin(a) - h / 2, w, h }; });
  } else {
    const L = layers(n, edges), nl = Math.max(...L) + 1, groups = Array.from({ length: nl }, () => []);
    L.forEach((l, i) => groups[l].push(i));
    const at = new Array(n);
    groups.forEach((g) => g.forEach((v, j) => { at[v] = j; }));
    for (let l = 1; l < nl; l++) { // barycentre ordering by predecessors
      const bc = (v) => { const ps = edges.filter((e) => e.b === v && L[e.a] === l - 1).map((e) => at[e.a]); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : at[v]; };
      groups[l].sort((a, b) => bc(a) - bc(b)).forEach((v, j) => { at[v] = j; });
    }
    const mx = Math.max(...groups.map((g) => g.length)), colW = r.w / nl, rowH = r.h / mx;
    const w = Math.min(colW * 0.74, 230), h = Math.min(rowH * 0.66, 96, Math.max(44, w * 0.5));
    pos = nodes.map((_, i) => ({ x: r.x + colW * (L[i] + 0.5) - w / 2, y: r.y + r.h / 2 + (at[i] - (groups[L[i]].length - 1) / 2) * rowH - h / 2, w, h }));
    depth = nodes.map((nd) => (nd.g === 'diamond' ? 1 : 0));
  }
  const nb = nodes.map((nd, i) => {
    const fill = k === 'cycle' || k === 'rel' ? th.fills[i % 6] : th.fills[Math.min(depth[i], 5)];
    const b = { k: 'dg:' + nd.label, t: 'shape', g: nd.g, ...pos[i], fill, paras: [P(nd.label, { al: 'ctr' })], base: [18], font: th.body, col: onColor(fill), an: 'ctr', fit: 1, grp: 'dg', ins: [4, 2, 4, 2] };
    return Object.assign(b, ov[b.k]);
  });
  out.push(...nb);
  const SITE = { rect: 1, roundRect: 1, diamond: 1 };
  edges.forEach((e, i) => {
    const A = nb[e.a], B = nb[e.b];
    if (A.hide || B.hide) return;
    const ca = [A.x + A.w / 2, A.y + A.h / 2], cb = [B.x + B.w / 2, B.y + B.h / 2], dx = cb[0] - ca[0], dy = cb[1] - ca[1];
    const ln = { c: th.muted, w: 1.75, te: e.te ? 'triangle' : 0, he: e.he ? 'triangle' : 0 };
    if (tree) { // vertical-first elbow (bentConnector3 rotated 90 degrees)
      const p = [ca[0], A.y + A.h], q = [cb[0], B.y], w = q[1] - p[1], h = Math.abs(q[0] - p[0]), c = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      out.push({ k: 'dge:' + i, t: 'line', g: 'elbow', x: c[0] - w / 2, y: c[1] - h / 2, w, h, rot: 90, fv: q[0] > p[0] ? 1 : 0, ln, st: [A.k, 2], en: [B.k, 0] });
      return;
    }
    let p, q, sa, sb;
    if (k === 'flow' && Math.abs(dx) >= Math.abs(dy)) { const s = Math.sign(dx) || 1, o = s < 0 ? Math.min(A.h, B.h) * 0.3 : 0; p = [ca[0] + (s * A.w) / 2, ca[1] + o]; q = [cb[0] - (s * B.w) / 2, cb[1] + o]; if (!o) { sa = s > 0 ? 3 : 1; sb = s > 0 ? 1 : 3; } }
    else if (k === 'flow') { const s = Math.sign(dy) || 1; p = [ca[0], ca[1] + (s * A.h) / 2]; q = [cb[0], cb[1] - (s * B.h) / 2]; sa = s > 0 ? 2 : 0; sb = s > 0 ? 0 : 2; }
    else {
      const clip = (c, b, d) => { const t = Math.min((b.w / 2 + 4) / (Math.abs(d[0]) || 1e-9), (b.h / 2 + 4) / (Math.abs(d[1]) || 1e-9)); return [c[0] + d[0] * t, c[1] + d[1] * t]; };
      p = clip(ca, A, [dx, dy]); q = clip(cb, B, [-dx, -dy]);
    }
    out.push({ k: 'dge:' + i, t: 'line', g: 'line', x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]), fh: q[0] < p[0] ? 1 : 0, fv: q[1] < p[1] ? 1 : 0, ln, st: sa != null && SITE[A.g] ? [A.k, sa] : null, en: sb != null && SITE[B.g] ? [B.k, sb] : null });
  });
  return out;
}

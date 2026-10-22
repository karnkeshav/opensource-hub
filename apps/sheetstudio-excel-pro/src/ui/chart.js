// Charts: pull series out of a range and render them as SVG.
import { grid, isErr } from '../core.js';
import { displayValue } from '../engine.js';
import { colName } from '../parser.js';

export const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

export function chartData(wb, ch) {
  const ref = wb.refFromString(ch.range, wb.sheets[0]);
  if (!ref) return null;
  let g = grid(ref).slice(0, 500);
  if (!g.length) return null;
  if (ch.byRow) g = g[0].map((_, j) => g.map((r) => r[j]));
  const isNum = (v) => typeof v === 'number';
  const head = g.length > 1 && g[0].slice(1).every((v) => typeof v === 'string' || v == null) && g[0].slice(1).some((v) => typeof v === 'string');
  const body = head ? g.slice(1) : g;
  const firstCat = body.length && body.filter((r) => typeof r[0] === 'string').length > body.length / 2 || (head && (g[0][0] == null || g[0][0] === '') && g[0].length > 1);
  const startCol = firstCat ? 1 : 0;
  const text = (v) => (v == null ? '' : isErr(v) ? v.c : typeof v === 'number' ? displayValue(v, ref.sh.fmtOf(ref.r1 + (head ? 1 : 0), ref.c1)).text : String(v));
  const cats = body.map((r, i) => (firstCat ? text(r[0]) : String(i + 1)));
  const series = [];
  // A1-style source of grid cell (i, j), accounting for series-in-rows
  const sp = /^[A-Za-z_][\w.]*$/.test(ref.sh.name) ? ref.sh.name + '!' : `'${ref.sh.name.replace(/'/g, "''")}'!`;
  const A = (i, j) => `$${colName((ch.byRow ? ref.c1 + i : ref.c1 + j))}$${(ch.byRow ? ref.r1 + j : ref.r1 + i) + 1}`;
  const R = (i1, j1, i2, j2) => sp + A(i1, j1) + (i1 === i2 && j1 === j2 ? '' : ':' + A(i2, j2));
  const h0 = head ? 1 : 0, last = g.length - 1;
  for (let c = startCol; c < g[0].length; c++) {
    const vals = body.map((r) => (isNum(r[c]) ? r[c] : null));
    if (vals.some((v) => v !== null)) series.push({ name: head && g[0][c] != null ? String(g[0][c]) : `Series ${series.length + 1}`, vals, ref: R(h0, c, last, c), nameRef: head ? R(0, c, 0, c) : null });
  }
  const catRef = firstCat ? R(h0, 0, last, 0) : null;
  if (ch.type === 'scatter' && !firstCat && series.length > 1) return { cats: series[0].vals.map(String), xs: series[0].vals, series: series.slice(1), catRef: series[0].ref };
  return { cats, series, catRef, xs: ch.type === 'scatter' ? body.map((r, i) => (isNum(r[0]) ? r[0] : i + 1)) : null };
}

function nice(min, max, n = 5) {
  if (min === max) { max = min + 1; if (min === 0) min = 0; }
  const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const f = step0 / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12));
  return { lo, hi, ticks };
}

export function chartSVG(ch, data, w, h, col) {
  const { fg = '#333', grid: gc = '#ddd', bg = 'transparent' } = col || {};
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Segoe UI,system-ui,sans-serif" font-size="11">`, `<rect width="${w}" height="${h}" fill="${bg}"/>`];
  if (!data || !data.series.length) return out.join('') + `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="${fg}">No numeric data in range</text></svg>`;
  const { cats, series } = data;
  const top = ch.title ? 30 : 12, legendH = series.length > 1 || ch.type === 'pie' || ch.type === 'doughnut' ? 24 : 0;
  if (ch.title) out.push(`<text x="${w / 2}" y="19" text-anchor="middle" font-size="14" font-weight="600" fill="${fg}">${esc(ch.title)}</text>`);
  const colour = (i) => PALETTE[i % PALETTE.length];
  const legend = (items) => {
    let x = 12;
    const y = h - 10;
    for (const [i, name] of items) {
      out.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${colour(i)}"/><text x="${x + 14}" y="${y}" fill="${fg}">${esc(name.length > 18 ? name.slice(0, 17) + '…' : name)}</text>`);
      x += 24 + Math.min(name.length, 18) * 6.2;
      if (x > w - 40) break;
    }
  };
  if (ch.type === 'pie' || ch.type === 'doughnut') {
    const vals = series[0].vals.map((v) => Math.max(0, v || 0)), tot = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = w / 2, cy = top + (h - top - legendH) / 2, R = Math.min(w / 2 - 20, (h - top - legendH) / 2 - 8);
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / tot) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, r) => `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
      const r0 = ch.type === 'doughnut' ? R * 0.55 : 0;
      if (v > 0) {
        out.push(v / tot > 0.9999 ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${colour(i)}"/>` : `<path d="M${p(a0, R)} A${R},${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r0)} ${r0 ? `A${r0},${r0} 0 ${big} 0 ${p(a0, r0)}` : `L${cx},${cy}`} Z" fill="${colour(i)}" stroke="${bg === 'transparent' ? '#fff' : bg}" stroke-width="1.5"/>`);
        if (v / tot > 0.04) { const am = (a0 + a1) / 2, rr = r0 ? (R + r0) / 2 : R * 0.68; out.push(`<text x="${cx + Math.cos(am) * rr}" y="${cy + Math.sin(am) * rr + 4}" text-anchor="middle" fill="#fff" font-weight="600">${Math.round(v / tot * 100)}%</text>`); }
      }
      a0 = a1;
    });
    legend(cats.map((c, i) => [i, c]));
    return out.join('') + '</svg>';
  }
  const L = 46, Rg = 12, B = 26, T = top, bottom = h - B - legendH, plotW = w - L - Rg, plotH = bottom - T;
  const horizontal = ch.type === 'bar';
  const stacked = !!ch.stacked && (ch.type === 'column' || ch.type === 'bar' || ch.type === 'area');
  let mn = Infinity, mx = -Infinity;
  if (stacked) {
    for (let i = 0; i < cats.length; i++) { let s = 0; for (const se of series) s += se.vals[i] || 0; mn = Math.min(mn, s, 0); mx = Math.max(mx, s); }
  } else for (const se of series) for (const v of se.vals) if (v !== null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  if (ch.type === 'column' || ch.type === 'bar' || ch.type === 'area') { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
  const sc = nice(mn, mx);
  const ys = (v) => bottom - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
  const xs = (v) => L + ((v - sc.lo) / (sc.hi - sc.lo)) * plotW;
  const n = cats.length;
  const isX = ch.type === 'scatter';
  let xsc = null;
  if (isX) { const xv = data.xs; xsc = nice(Math.min(...xv), Math.max(...xv)); }
  // grid + value axis
  for (const t of sc.ticks) {
    if (horizontal) {
      const x = xs(t);
      out.push(`<line x1="${x}" y1="${T}" x2="${x}" y2="${bottom}" stroke="${gc}"/><text x="${x}" y="${bottom + 14}" text-anchor="middle" fill="${fg}">${compact.format(t)}</text>`);
    } else {
      const y = ys(t);
      out.push(`<line x1="${L}" y1="${y}" x2="${w - Rg}" y2="${y}" stroke="${gc}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" fill="${fg}">${compact.format(t)}</text>`);
    }
  }
  const slot = (horizontal ? plotH : plotW) / Math.max(1, n);
  const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? plotH / 16 : plotW / 54)))));
  if (isX) {
    const xv = data.xs, sx = (v) => L + ((v - xsc.lo) / (xsc.hi - xsc.lo)) * plotW;
    for (const t of xsc.ticks) out.push(`<text x="${sx(t)}" y="${bottom + 14}" text-anchor="middle" fill="${fg}">${compact.format(t)}</text>`);
    series.forEach((se, si) => se.vals.forEach((v, i) => { if (v !== null && xv[i] != null) out.push(`<circle cx="${sx(xv[i])}" cy="${ys(v)}" r="3.5" fill="${colour(si)}" fill-opacity=".85"/>`); }));
  } else {
    cats.forEach((c, i) => {
      if (i % step) return;
      const lab = esc(c.length > 10 ? c.slice(0, 9) + '…' : c);
      if (horizontal) out.push(`<text x="${L - 6}" y="${T + slot * (i + 0.5) + 4}" text-anchor="end" fill="${fg}">${lab}</text>`);
      else out.push(`<text x="${L + slot * (i + 0.5)}" y="${bottom + 14}" text-anchor="middle" fill="${fg}">${lab}</text>`);
    });
    const ns = series.length;
    if (ch.type === 'column' || ch.type === 'bar') {
      const bw = stacked ? slot * 0.7 : (slot * 0.78) / ns, off = slot * 0.11;
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0;
        series.forEach((se, si) => {
          const v = se.vals[i];
          if (v === null || v === undefined) return;
          let a, b;
          if (stacked) { a = v >= 0 ? pos : neg; b = a + v; v >= 0 ? (pos = b) : (neg = b); } else { a = 0; b = v; }
          if (horizontal) {
            const y = T + slot * i + (stacked ? slot * 0.15 : off + bw * si);
            out.push(`<rect x="${Math.min(xs(a), xs(b))}" y="${y}" width="${Math.abs(xs(b) - xs(a))}" height="${bw}" fill="${colour(si)}"><title>${esc(se.name)}: ${v}</title></rect>`);
          } else {
            const x = L + slot * i + (stacked ? slot * 0.15 : off + bw * si);
            out.push(`<rect x="${x}" y="${Math.min(ys(a), ys(b))}" width="${bw}" height="${Math.abs(ys(b) - ys(a))}" fill="${colour(si)}"><title>${esc(se.name)}: ${v}</title></rect>`);
          }
        });
      }
    } else {
      const px = (i) => L + slot * (i + 0.5);
      const base = new Array(n).fill(0);
      series.forEach((se, si) => {
        const pts = [];
        se.vals.forEach((v, i) => { if (v !== null) pts.push([px(i), ys(stacked ? (base[i] += v) : v), i, v]); });
        if (!pts.length) return;
        if (ch.type === 'area') {
          const lowerY = (i) => ys(stacked ? base[i] - se.vals[i] : 0);
          const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0]},${p[1]}`).join('') + [...pts].reverse().map((p) => `L${p[0]},${lowerY(p[2])}`).join('') + 'Z';
          out.push(`<path d="${d}" fill="${colour(si)}" fill-opacity=".45"/>`);
        }
        out.push(`<path d="${pts.map((p, k) => `${k ? 'L' : 'M'}${p[0]},${p[1]}`).join('')}" fill="none" stroke="${colour(si)}" stroke-width="2.2" stroke-linejoin="round"/>`);
        if (ch.type === 'line') for (const p of pts) out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${colour(si)}"><title>${esc(se.name)}: ${p[3]}</title></circle>`);
      });
    }
  }
  out.push(`<line x1="${L}" y1="${bottom}" x2="${w - Rg}" y2="${bottom}" stroke="${fg}" stroke-opacity=".5"/><line x1="${L}" y1="${T}" x2="${L}" y2="${bottom}" stroke="${fg}" stroke-opacity=".5"/>`);
  if (legendH) legend(series.map((se, i) => [i, se.name]));
  return out.join('') + '</svg>';
}

// Rasterise an SVG string to a PNG Blob.
export function svgToPng(svg, w, h, scale = 2) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w * scale; c.height = h * scale;
      const x = c.getContext('2d');
      x.scale(scale, scale); x.drawImage(img, 0, 0);
      c.toBlob((b) => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png');
    };
    img.onerror = () => rej(new Error('PNG export failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

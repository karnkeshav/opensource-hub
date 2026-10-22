// Laid-out boxes -> HTML with inline styles only, so the same markup serves the editor, thumbnails,
// presenting, printing, PNG export (SVG foreignObject) and the standalone HTML export.
import { layoutSlide, runZ, paraZ, marL, ins, LH, SB, HANG } from '../layout.js';
import { fontCss, fontW } from '../theme.js';
import { E } from './util.js';

const cv = document.createElement('canvas').getContext('2d'), mc = new Map();
// canvas text measurement in points (1 slide unit = 1 CSS px at 100%)
export function measure(t, z, f, b) {
  const k = f + (b ? '|b|' : '|') + t;
  let w = mc.get(k);
  if (w === undefined) { cv.font = `${b ? 700 : fontW(f)} 100px ${fontCss(f)}`; w = cv.measureText(t).width / 100; if (mc.size > 80000) mc.clear(); mc.set(k, w); }
  return w * z;
}
const lc = new Map();
export const layKey = (s, deck, i) => JSON.stringify(s) + JSON.stringify(deck.theme) + deck.w + 'x' + deck.h + (i === 0);
export function lay(s, deck, i) {
  const k = layKey(s, deck, i);
  let L = lc.get(k);
  if (!L) { L = layoutSlide(s, deck, i, measure); if (lc.size > 4000) lc.clear(); lc.set(k, L); }
  return L;
}

const BUL = ['•', '–', '◦'], AL = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };
const DASH = { dash: [4, 3], sysDash: [3, 1], sysDot: [1, 1.5], dot: [1, 2], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3] };
function shapeD(g, w, h) {
  const m = Math.min(w, h), hw = w / 2, hh = h / 2;
  switch (g) {
    case 'ellipse': case 'flowChartConnector': return `M0 ${hh}A${hw} ${hh} 0 1 0 ${w} ${hh}A${hw} ${hh} 0 1 0 0 ${hh}Z`;
    case 'roundRect': case 'flowChartAlternateProcess': { const q = m * 0.1667; return `M${q} 0H${w - q}Q${w} 0 ${w} ${q}V${h - q}Q${w} ${h} ${w - q} ${h}H${q}Q0 ${h} 0 ${h - q}V${q}Q0 0 ${q} 0Z`; }
    case 'diamond': case 'flowChartDecision': return `M${hw} 0L${w} ${hh}L${hw} ${h}L0 ${hh}Z`;
    case 'triangle': return `M${hw} 0L${w} ${h}H0Z`;
    case 'rtTriangle': return `M0 0L${w} ${h}H0Z`;
    case 'parallelogram': return `M${m / 4} 0H${w}L${w - m / 4} ${h}H0Z`;
    case 'trapezoid': return `M${m / 4} 0H${w - m / 4}L${w} ${h}H0Z`;
    case 'hexagon': return `M${m / 4} 0H${w - m / 4}L${w} ${hh}L${w - m / 4} ${h}H${m / 4}L0 ${hh}Z`;
    case 'chevron': return `M0 0H${w - hh}L${w} ${hh}L${w - hh} ${h}H0L${hh} ${hh}Z`;
    case 'homePlate': return `M0 0H${w - hh}L${w} ${hh}L${w - hh} ${h}H0Z`;
    case 'rightArrow': { const a = w - m / 2; return `M0 ${h / 4}H${a}V0L${w} ${hh}L${a} ${h}V${h * 0.75}H0Z`; }
    case 'leftArrow': { const a = m / 2; return `M${w} ${h / 4}H${a}V0L0 ${hh}L${a} ${h}V${h * 0.75}H${w}Z`; }
    case 'upArrow': { const a = m / 2; return `M${w / 4} ${h}V${a}H0L${hw} 0L${w} ${a}H${w * 0.75}V${h}Z`; }
    case 'downArrow': { const a = h - m / 2; return `M${w / 4} 0V${a}H0L${hw} ${h}L${w} ${a}H${w * 0.75}V0Z`; }
    case 'plus': return `M${w / 3} 0H${(2 * w) / 3}V${h / 3}H${w}V${(2 * h) / 3}H${(2 * w) / 3}V${h}H${w / 3}V${(2 * h) / 3}H0V${h / 3}H${w / 3}Z`;
    case 'star5': { let d = ''; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.38 : 1; d += (i ? 'L' : 'M') + (hw + hw * r * Math.cos(a)).toFixed(1) + ' ' + (hh + hh * r * Math.sin(a)).toFixed(1); } return d + 'Z'; }
    default: return `M0 0H${w}V${h}H0Z`;
  }
}
function lineD(b) {
  const { w, h } = b;
  return b.g === 'elbow' ? [`M0 0H${w / 2}V${h}H${w}`, [w / 2, h, w, h], [w / 2, 0, 0, 0]] : b.g === 'curve' ? [`M0 0C${w / 2} 0 ${w / 2} ${h} ${w} ${h}`, [w / 2, h, w, h], [w / 2, 0, 0, 0]] : [`M0 0L${w} ${h}`, [0, 0, w, h], [w, h, 0, 0]];
}
const head = (s, lw, c) => { const [x1, y1, x2, y2] = s, a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(6, lw * 3.2), W = L * 0.55; const p = (d, o) => `${(x2 - L * Math.cos(a) + o * W * Math.cos(a + Math.PI / 2)).toFixed(1)},${(y2 - L * Math.sin(a) + o * W * Math.sin(a + Math.PI / 2)).toFixed(1)}`; return `<polygon points="${x2},${y2} ${p(0, 1)} ${p(0, -1)}" fill="${c}"/>`; };
function svgHTML(b) {
  const w = Math.max(b.w, 0.01), h = Math.max(b.h, 0.01), ln = b.ln && b.ln.c ? b.ln : null, lw = ln ? ln.w || 1 : 0;
  const st = ln ? ` stroke="${ln.c}" stroke-width="${lw}"${DASH[ln.d] ? ` stroke-dasharray="${DASH[ln.d].map((x) => x * lw).join(' ')}"` : ''}` : '';
  const flip = b.fh || b.fv ? ` transform="translate(${b.fh ? w : 0} ${b.fv ? h : 0}) scale(${b.fh ? -1 : 1} ${b.fv ? -1 : 1})"` : '';
  let body;
  if (b.t === 'line') {
    const [d, end, start] = lineD(b), c = (ln || { c: '#000' }).c;
    body = `<path d="${d}" fill="none"${st || ' stroke="#000"'}/>` + (ln && ln.te ? head(end, lw, c) : '') + (ln && ln.he ? head(start, lw, c) : '');
  } else if (b.path) {
    body = b.path.map((p) => `<path transform="scale(${w / p.w} ${h / p.h})" vector-effect="non-scaling-stroke" d="${p.d.map((c) => c.join(' ')).join('')}" fill="${p.nf ? 'none' : b.fill || 'none'}"${st}/>`).join('');
  } else body = `<path d="${shapeD(b.g, w, h)}" fill="${b.fill || 'none'}"${st}/>`;
  const P = 12; // padded canvas: a zero-height line still needs a paintable SVG
  return `<svg width="${w + 2 * P}" height="${h + 2 * P}" style="position:absolute;left:${-P}px;top:${-P}px;overflow:visible" aria-hidden="true"><g transform="translate(${P} ${P})"><g${flip}>${body}</g></g></svg>`;
}
function runsHTML(p, b, fs) {
  const pz = paraZ(p, b);
  return p.r.map((r) => {
    const z = runZ(r, p, b), s = [];
    if (z !== pz) s.push(`font-size:${z * fs}px`);
    if (r.c) s.push('color:' + r.c);
    if (r.f && r.f !== b.font) s.push('font-family:' + fontCss(r.f), 'font-weight:' + fontW(r.f));
    if (r.b) s.push('font-weight:700');
    if (r.i) s.push('font-style:italic');
    if (r.u || r.s) s.push(`text-decoration:${r.u ? 'underline ' : ''}${r.s ? 'line-through' : ''}`);
    const t = E(r.t).replace(/\n/g, '<br>');
    return s.length ? `<span style="${E(s.join(';'))}">${t}</span>` : t;
  }).join('');
}
export function parasHTML(paras, b, fs = 1) {
  const num = [];
  return paras.map((p, i) => {
    const lvl = p.lvl || 0, z = paraZ(p, b) * fs;
    num.length = lvl + 1;
    num[lvl] = p.bu === 'n' ? (num[lvl] || 0) + 1 : 0;
    const bul = p.bu ? `<span data-b="1" contenteditable="false" style="display:inline-block;width:${HANG}px;text-indent:0;color:${b.bc || b.col || 'inherit'}">${p.bu === 'n' ? num[lvl] + '.' : E(p.bc || BUL[lvl % 3])}</span>` : '';
    return `<div data-l="${lvl}" data-u="${p.bu || 0}" style="margin:${i ? (z * SB).toFixed(2) : 0}px 0 0 ${marL(p)}px;text-indent:${p.bu ? -HANG : 0}px;text-align:${AL[p.al || b.al] || 'left'};font-size:${z.toFixed(2)}px;min-height:${(z * LH).toFixed(2)}px">${bul}${runsHTML(p, b, fs) || ''}</div>`;
  }).join('');
}
function textHTML(b) {
  const [l, t, r, bt] = ins(b), jc = { ctr: 'center', b: 'flex-end' }[b.an] || 'flex-start';
  const st = `position:absolute;inset:0;display:flex;flex-direction:column;justify-content:${jc};padding:${t}px ${r}px ${bt}px ${l}px;line-height:${LH};white-space:pre-wrap;overflow-wrap:break-word;color:${b.col || '#000'};font-family:${fontCss(b.font || 'Calibri')};font-weight:${b.b ? 700 : fontW(b.font || '')};${b.i ? 'font-style:italic;' : ''}outline:none`;
  return `<div class="tx" style="${E(st)}">${parasHTML(b.paras, b, b.fs || 1)}</div>`;
}
function picHTML(b, media) {
  const m = /^media:/.test(b.m || '') ? media[b.m.slice(6)] : null, rad = b.g === 'ellipse' ? 'border-radius:50%;' : b.g === 'roundRect' ? `border-radius:${Math.min(b.w, b.h) * 0.1667}px;` : '';
  if (!m) return `<div style="position:absolute;inset:0;border:1px dashed #999;display:flex;align-items:center;justify-content:center;color:#777;font:12px sans-serif;text-align:center">${E(b.alt || 'Picture not available offline')}</div>`;
  const [l, t, r, bt] = b.crop || [0, 0, 0, 0], fw = b.w / (1 - l - r || 1), fh = b.h / (1 - t - bt || 1);
  const bd = b.ln && b.ln.c ? `box-shadow:inset 0 0 0 ${b.ln.w || 1}px ${b.ln.c};` : '';
  return `<div style="position:absolute;inset:0;overflow:hidden;${rad}${bd}"><img src="${m.d}" alt="${E(b.alt || '')}" draggable="false" style="position:absolute;left:${-l * fw}px;top:${-t * fh}px;width:${fw}px;height:${fh}px;max-width:none"></div>`;
}
function tableHTML(b) {
  const font = fontCss(b.font || 'Calibri'), nc = b.cw.length;
  let s = `<table style="${E(`border-collapse:collapse;table-layout:fixed;width:${b.w}px;font-family:${font};color:${b.col}`)}"><colgroup>${b.cw.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
  b.rows.forEach((row, r) => {
    const hdr = r === 0 && b.hdr !== false;
    s += `<tr style="height:${b.rh[r] || 20}px">`;
    for (let c = 0; c < nc; c++) {
      const fill = (b.cf && b.cf[r] && b.cf[r][c]) || (hdr ? b.hf : r % 2 === 0 ? b.band : null), p = row[c] || { r: [], lvl: 0 };
      const cb = { base: [b.z || 18], col: hdr ? b.hc : b.col, font: b.font };
      s += `<td style="border:0.75px solid ${b.lc || '#bfbfbf'};padding:3.6px 7.2px;vertical-align:middle;line-height:${LH};overflow-wrap:break-word;${fill ? 'background:' + fill + ';' : ''}${hdr ? `font-weight:700;color:${b.hc};` : ''}">${parasHTML([{ ...p, bu: 0 }], cb)}</td>`;
    }
    s += '</tr>';
  });
  return s + '</table>';
}
export function boxHTML(b, media) {
  const st = `position:absolute;left:${b.x}px;top:${b.y}px;width:${Math.max(0, b.w)}px;height:${Math.max(0, b.h)}px${b.rot ? `;transform:rotate(${b.rot}deg)` : ''}`;
  let inner = '';
  if (b.t === 'pic') inner = picHTML(b, media);
  else if (b.t === 'table') inner = tableHTML(b);
  else {
    if (b.t === 'line' || b.t === 'shape' || b.fill || (b.ln && b.ln.c)) inner = svgHTML(b);
    if (b.paras) inner += textHTML(b);
  }
  return `<div data-k="${E(b.k)}" style="${st}">${inner}</div>`;
}
export function slideHTML(s, deck, i) {
  const L = lay(s, deck, i), bm = L.bgm && deck.media[L.bgm.slice(6)];
  return `<div class="sl" style="position:relative;overflow:hidden;width:${deck.w}px;height:${deck.h}px;background:${L.bg || '#fff'}${bm ? ` url(${bm.d}) center/cover no-repeat` : ''}">${L.boxes.map((b) => boxHTML(b, deck.media)).join('')}</div>`;
}
// A slide element scaled to width w (px).
export function slideNode(s, deck, i, w) {
  const d = document.createElement('div'), k = w / deck.w;
  d.className = 'sn';
  d.style.cssText = `width:${w}px;height:${deck.h * k}px;overflow:hidden;position:relative`;
  d.innerHTML = `<div style="transform:scale(${k});transform-origin:0 0;width:${deck.w}px;height:${deck.h}px">${slideHTML(s, deck, i)}</div>`;
  return d;
}

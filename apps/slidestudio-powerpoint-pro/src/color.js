// Colour maths: hex <-> HSL, WCAG 2 relative luminance / contrast ratio, and contrast enforcement.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export function rgb(c) {
  let h = String(c || '').replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const hex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export function toHsl(c) {
  const [r, g, b] = rgb(c).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hsl(h, s, l) {
  s = clamp(s, 0, 1); l = clamp(l, 0, 1); h = (((h % 360) + 360) % 360) / 360;
  if (!s) return hex(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return hex(f(h + 1 / 3), f(h), f(h - 1 / 3));
}
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(...x.map((v, i) => v + (y[i] - v) * t)); };
export const lum = (c) => rgb(c).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const onColor = (bg) => (contrast('#ffffff', bg) >= contrast('#111111', bg) ? '#ffffff' : '#111111');
// Shift fg's lightness (keeping its hue) until it reaches the contrast ratio against bg.
export function ensure(fg, bg, ratio = 4.5) {
  if (contrast(fg, bg) >= ratio) return fg;
  const [h, s, l] = toHsl(fg), down = contrast('#000000', bg) >= contrast('#ffffff', bg);
  for (let i = 1; i <= 40; i++) { const c = hsl(h, s, down ? l * (1 - i / 40) : l + (1 - l) * i / 40); if (contrast(c, bg) >= ratio) return c; }
  return onColor(bg);
}

// One-colour theming: a brand colour + mode + font pairing derive the whole palette, with WCAG contrast enforced.
import { toHsl, hsl, ensure, mix, onColor } from './color.js';

// [heading font, body font, label] - fonts that ship with Windows / Office, with safe CSS fallbacks.
export const FONTS = {
  sans: ['Segoe UI Semibold', 'Segoe UI', 'Clean sans'],
  classic: ['Georgia', 'Segoe UI', 'Serif headings'],
  serif: ['Cambria', 'Cambria', 'Book serif'],
  geometric: ['Century Gothic', 'Segoe UI', 'Geometric'],
  humanist: ['Trebuchet MS', 'Segoe UI', 'Humanist'],
  tech: ['Bahnschrift', 'Segoe UI', 'Technical'],
  plain: ['Arial', 'Arial', 'Arial'],
};
const SERIF = /georgia|cambria|times|garamond|book|palatino|constantia|serif/i;
export const fontCss = (f) => `"${f}",${SERIF.test(f) ? 'Georgia,"Times New Roman",serif' : /consolas|courier|mono/i.test(f) ? 'Consolas,monospace' : '"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif'}`;
export const fontW = (f) => (/semibold|demi/i.test(f) ? 600 : /black|heavy/i.test(f) ? 900 : /bold/i.test(f) ? 700 : 400);
export const MODES = { light: 'Light', dark: 'Dark', bold: 'Brand background' };
export const THEMES = [
  ['Ocean', '#1c7ed6', 'light', 'sans'], ['Forest', '#2f9e44', 'light', 'humanist'], ['Grape', '#7048e8', 'light', 'geometric'], ['Paper', '#a0522d', 'light', 'classic'],
  ['Midnight', '#4dabf7', 'dark', 'sans'], ['Ember', '#ff922b', 'dark', 'tech'], ['Coral', '#e64980', 'bold', 'sans'], ['Slate', '#495057', 'light', 'serif'],
].map(([name, brand, mode, font]) => ({ name, brand, mode, font }));

const cache = new Map();
export function derive(p) {
  const key = [p.brand, p.mode, p.font, p.hf, p.bf].join();
  if (cache.has(key)) return cache.get(key);
  const [h, s0, l0] = toHsl(p.brand), s = Math.min(s0, 0.85);
  let bg, text, surface;
  if (p.mode === 'dark') { bg = hsl(h, Math.min(s, 0.3), 0.1); text = hsl(h, 0.15, 0.93); surface = hsl(h, Math.min(s, 0.28), 0.17); }
  else if (p.mode === 'bold') { bg = ensure(hsl(h, s, Math.min(l0, 0.45)), '#ffffff', 7.2); text = '#ffffff'; surface = mix(bg, '#000000', 0.28); }
  else { bg = hsl(h, Math.min(s, 0.35), 0.985); text = hsl(h, 0.3, 0.14); surface = hsl(h, Math.min(s, 0.5), 0.935); }
  text = ensure(text, bg, 7);
  const L = p.mode === 'light' ? 0.42 : 0.7;
  const acc = [0, 35, -35, 180, 150, -150].map((d, i) => ensure(i ? hsl(h + d, Math.max(s, 0.45), L) : p.mode === 'bold' ? hsl(h, s, 0.82) : p.brand, bg, 3));
  const f = p.hf ? [p.hf, p.bf || p.hf] : FONTS[p.font] || FONTS.sans;
  // shape fills: in light themes deepen accents until white text reads on them (4.5:1)
  const fills = acc.map((a) => (p.mode === 'light' ? ensure(a, '#ffffff', 4.5) : a));
  const t = { fills, onFill: fills.map(onColor), bg, text, surface, title: ensure(p.mode === 'bold' ? '#ffffff' : p.brand, bg, 4.5), muted: ensure(mix(text, bg, 0.35), bg, 4.5), line: mix(text, bg, 0.75), acc, onAcc: acc.map(onColor), head: f[0], body: f[1] };
  cache.set(key, t);
  return t;
}

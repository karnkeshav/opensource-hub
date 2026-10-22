// Slide show and presenter view (current + next slide, notes, timer, optional audience window).
import { h } from './util.js';
import { slideHTML } from './render.js';

const CSS = '.pa{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.tr-fade{animation:pf .5s}.tr-push{animation:pp .5s}.tr-zoom{animation:pz .5s}@keyframes pf{from{opacity:0}}@keyframes pp{from{transform:translateX(30%);opacity:0}}@keyframes pz{from{transform:scale(.6);opacity:0}}@media (prefers-reduced-motion:reduce){.tr-fade,.tr-push,.tr-zoom{animation:none}}';
export function present(app, start, presenter) {
  app.commitText();
  const d = app.deck, order = d.slides.map((_, i) => i).filter((i) => !d.slides[i].hidden || i === start);
  let pos = Math.max(0, order.indexOf(start)), t0 = Date.now(), held = 0, typed = '', aud = null;
  const main = h('div', { class: 'pm' }), next = h('div', { class: 'pn' }), notes = h('div', { class: 'pnotes', 'aria-live': 'polite' }), clock = h('span', { class: 'pclock' }), count = h('span'), shade = h('div', { class: 'pshade' });
  const btn = (l, f, t) => h('button', { type: 'button', class: 'btn sm', title: t || l, onclick: f }, l);
  let fz = 22;
  const side = presenter ? h('div', { class: 'pside' }, h('div', { class: 'plabel' }, 'Next'), next, h('div', { class: 'pbar' }, clock, count),
    h('div', { class: 'pbar' }, btn('◀', () => go(pos - 1), 'Previous'), btn('▶', () => go(pos + 1), 'Next'), btn('⏸ / ▶', () => { held = held ? (t0 += Date.now() - held, 0) : Date.now(); }, 'Pause timer'), btn('↺', () => { t0 = Date.now(); held = 0; }, 'Restart timer'), btn('A−', () => { fz = Math.max(12, fz - 3); notes.style.fontSize = fz + 'px'; }), btn('A+', () => { fz += 3; notes.style.fontSize = fz + 'px'; }), btn('Audience window', openAud), btn('End', end)), notes) : null;
  const wrap = h('div', { id: 'pres', class: presenter ? 'presenter' : '', tabindex: '0', role: 'dialog', 'aria-label': presenter ? 'Presenter view' : 'Slide show' }, h('style', null, CSS), main, side, shade);
  document.body.append(wrap);
  app.presenting = true;
  const fit = (host, i, tr) => {
    if (i == null) { host.innerHTML = '<div class="pend">End of slide show</div>'; return; }
    const r = host.getBoundingClientRect(), k = Math.min(r.width / d.w, r.height / d.h) || 0.1;
    host.innerHTML = `<div class="pa${tr ? ' tr-' + tr : ''}"><div style="width:${d.w * k}px;height:${d.h * k}px;overflow:hidden;flex:none"><div style="transform:scale(${k});transform-origin:0 0;width:${d.w}px;height:${d.h}px">${slideHTML(d.slides[i], d, i)}</div></div></div>`;
  };
  function draw(tr) {
    const i = order[pos];
    fit(main, i, tr);
    if (aud && !aud.closed) fit(aud.document.getElementById('h'), i, tr);
    if (presenter) { fit(next, order[pos + 1]); notes.textContent = d.slides[i].notes || 'No notes for this slide.'; count.textContent = `Slide ${i + 1} · ${pos + 1} of ${order.length}`; }
    wrap.setAttribute('aria-label', `Slide ${pos + 1} of ${order.length}`);
  }
  function go(p) { if (p >= order.length) return presenter ? null : end(); p = Math.max(0, p); if (p === pos) return; const fwd = p > pos; pos = p; shade.className = 'pshade'; draw(fwd ? d.slides[order[pos]].tr : null); }
  const tick = setInterval(() => { const s = Math.floor(((held || Date.now()) - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 500);
  function openAud() {
    aud = window.open('', 'slidestudio-audience', 'popup,width=960,height=560');
    if (!aud) return;
    aud.document.title = app.title;
    aud.document.body.style.cssText = 'margin:0;background:#000;height:100vh;overflow:hidden';
    aud.document.body.innerHTML = `<style>${CSS}</style><div id="h" style="width:100vw;height:100vh"></div>`;
    aud.addEventListener('keydown', key);
    aud.addEventListener('resize', () => draw());
    draw();
  }
  function key(e) {
    const k = e.key;
    if (/^\d$/.test(k)) { typed += k; return; }
    if (k === 'Enter' && typed) { go(order.indexOf(+typed - 1) >= 0 ? order.indexOf(+typed - 1) : pos); typed = ''; e.preventDefault(); return; }
    typed = '';
    if (/^(ArrowRight|ArrowDown|PageDown| |Enter|n|N)$/.test(k)) go(pos + 1);
    else if (/^(ArrowLeft|ArrowUp|PageUp|Backspace|p|P)$/.test(k)) go(pos - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(order.length - 1);
    else if (/^[bB.]$/.test(k)) shade.className = shade.className === 'pshade on' ? 'pshade' : 'pshade on';
    else if (/^[wW,]$/.test(k)) shade.className = shade.className === 'pshade on white' ? 'pshade' : 'pshade on white';
    else if (k === 'Escape') end();
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  function end() {
    clearInterval(tick);
    removeEventListener('keydown', key, true); removeEventListener('resize', onR);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (aud && !aud.closed) aud.close();
    wrap.remove();
    app.presenting = false;
    app.go(order[pos]);
  }
  const onR = () => draw();
  addEventListener('keydown', key, true);
  addEventListener('resize', onR);
  main.addEventListener('click', (e) => go(pos + (e.clientX < main.getBoundingClientRect().left + main.clientWidth / 4 ? -1 : 1)));
  wrap.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !presenter && wrap.isConnected) draw(); });
  if (!presenter && wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
  wrap.focus();
  requestAnimationFrame(() => draw());
}

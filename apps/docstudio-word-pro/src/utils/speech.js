// Read Aloud via the Web Speech API (offline voices ship with the OS).
let active = false;
let onEndCb = null;

const waitForVoices = () =>
  new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const have = synth.getVoices();
    if (have.length) return resolve(have);
    const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
    synth.addEventListener('voiceschanged', () => { clearTimeout(timer); resolve(synth.getVoices()); }, { once: true });
  });

// Chrome silently stops long utterances after ~15 s, so feed it sentence-sized pieces.
function chunk(text) {
  const parts = [];
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?\n]+[.!?]*\s*/g) || [text];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 200 && cur) { parts.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
export const isSpeaking = () => active;

export function stopSpeech() {
  const was = active;
  active = false;
  if (speechSupported()) window.speechSynthesis.cancel();
  if (was && onEndCb) onEndCb();
  onEndCb = null;
}

export async function startSpeech(text, onEnd) {
  if (!speechSupported()) throw new Error('Text-to-speech is not available in this browser.');
  const synth = window.speechSynthesis;
  stopSpeech();
  onEndCb = onEnd || null;
  active = true;
  synth.resume();
  const voices = await waitForVoices();
  const lang = navigator.language || 'en-US';
  const voice =
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang.startsWith(lang.split('-')[0])) ||
    voices.find((v) => v.default) ||
    voices[0];
  const parts = chunk(text);
  let i = 0;
  const next = () => {
    if (!active) return;
    if (i >= parts.length) { stopSpeech(); return; }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.onend = next;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
    synth.speak(u);
  };
  setTimeout(next, 60); // Chrome drops speak() issued in the same tick as cancel()
  return parts.length;
}

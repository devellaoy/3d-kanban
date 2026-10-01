// ⚙️ Settings' mouse sensitivity (the You pane): how far the mouse turns your head, 25–200%, taking
// effect as you drag. Kept here so upstream's settings.ts only gains the one line that shows it.
import type { Settings } from '../state';
import { h } from '../ui/dom';

/** The slider's row and its note, for `setting('Mouse sensitivity', 'you', ...)`; `set` takes the new settings. */
export function mouseSensitivityRow(get: () => Settings, set: (s: Settings) => void): [HTMLElement, HTMLElement] {
  const slider = h('input', { type: 'range', min: 25, max: 200, step: 5, 'aria-label': 'Mouse sensitivity' });
  const pct = h('span.vol-pct');
  const paint = () => {
    const v = Math.round(get().mouseSensitivity * 100);
    slider.value = String(v);
    slider.style.setProperty('--fill', `${((v - 25) / 175) * 100}%`);
    pct.textContent = `${v}%`;
  };
  paint();
  slider.addEventListener('input', () => {
    set({ ...get(), mouseSensitivity: Number(slider.value) / 100 });
    paint();
  });
  return [h('div.volume', {}, slider, pct), h('p.setting-note', {}, 'How far the mouse turns your head, in first and third person. 100% is the usual speed.')];
}

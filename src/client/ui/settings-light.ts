// ⚙️ Settings' Indoor lights (the You pane): how bright the office's lamps are for you, 0–200%, taking
// effect as you drag (features/lights hands it to world/roomlight.ts). Its own file to keep settings.ts short.
import type { Settings } from '../state';
import { h } from './dom';

/** The slider's row and its note, for `setting('Indoor lights', 'you', ...)`; `set` takes the new settings. */
export function indoorLightRow(get: () => Settings, set: (s: Settings) => void): [HTMLElement, HTMLElement] {
  const slider = h('input', { type: 'range', min: 0, max: 200, step: 5, 'aria-label': 'Indoor lights' });
  const pct = h('span.vol-pct');
  const paint = () => {
    const v = Math.round(get().indoorLight * 100);
    slider.value = String(v);
    slider.style.setProperty('--fill', `${v / 2}%`);
    pct.textContent = `${v}%`;
  };
  paint();
  slider.addEventListener('input', () => {
    set({ ...get(), indoorLight: Number(slider.value) / 100 });
    paint();
  });
  return [h('div.volume', {}, slider, pct), h('p.setting-note', {}, 'How bright the office’s lamps are, for you alone. 100% is the usual light. The wall switches still turn an area’s lamps off, and the daylight through the windows stays as it is.')];
}

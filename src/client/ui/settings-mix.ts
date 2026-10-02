// ⚙️ Settings' volume sliders (the Sound & voice pane): the office sounds' master, each kind of sound
// under it (see sound/mix.ts), and the jukebox. Its own file to keep settings.ts short.
import { MIXES, type Mix, type MixLevel } from '../sound/mix';
import type { Settings } from '../state';
import { h } from './dom';

/** Each kind in Settings: its icon, its name (which the slider and the mute are read out by), and what it covers. */
export const MIX_LABEL: Record<Mix, [icon: string, name: string, covers: string]> = {
  background: ['🌬️', 'Background', 'The room’s air, the humming fridge, and the wind and the city up on the roof.'],
  rain: ['🌧️', 'Rain', 'The rain, all round you outside or a hush behind the windows, and thunder.'],
  thumps: ['💥', 'Jumps & thumps', 'Landing a jump, a car bumping into something, someone thrown down in the dungeon.'],
  steps: ['👣', 'Footsteps', 'Your own and everyone else’s.'],
  typing: ['⌨️', 'Typing & paper', 'Workers typing and fidgeting at their desks, and an issue card or a book’s pages in your hands.'],
  effects: ['✨', 'Other effects', 'The coffee machine, the gong when someone bangs it, the dog, phones, birds and crickets, the cars and the games.'],
  alerts: ['🔔', 'Dings & alerts', 'A worker that’s done or needs you, and the gong when a pull request merges or the queue empties. Heard from another tab too.'],
};

/**
 * A volume slider for `name` with its mute button, showing `get()` and handing changes to `set`.
 * Dragging it turns the sound back on and muting keeps the level; letting go plays `preview`.
 */
export function volumeRow(name: string, get: () => MixLevel, set: (l: MixLevel) => void, preview?: () => void): HTMLElement {
  const slider = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': `${name} volume` });
  const pct = h('span.vol-pct');
  // A toggle: its name stays the same and aria-pressed says whether it's on.
  const mute = h('button.btn', { type: 'button', 'aria-label': `Mute ${name.toLowerCase()}` });
  const row = h('div.volume', {}, mute, slider, pct);
  const paint = () => {
    const { volume, muted } = get();
    const v = Math.round(volume * 100);
    slider.value = String(v);
    slider.style.setProperty('--fill', `${v}%`);
    pct.textContent = muted ? 'Muted' : `${v}%`;
    mute.textContent = muted ? '🔊 Unmute' : '🔇 Mute';
    mute.setAttribute('aria-pressed', String(muted));
    mute.classList.toggle('danger', muted);
    row.classList.toggle('muted', muted);
  };
  paint();
  slider.addEventListener('input', () => {
    set({ volume: Number(slider.value) / 100, muted: false });
    paint();
  });
  if (preview) slider.addEventListener('change', preview);
  mute.addEventListener('click', () => {
    const muted = !get().muted;
    set({ ...get(), muted });
    paint();
    if (!muted) preview?.();
  });
  return row;
}

/** The office sounds' master volume (`volume`, `muted`), for `setting('Office sounds', ...)`. */
export function masterRow(get: () => Settings, set: (s: Settings) => void, preview: () => void): HTMLElement {
  return volumeRow('Office sounds', () => ({ volume: get().volume, muted: get().muted }), (l) => set({ ...get(), ...l }), preview);
}

/** The jukebox's own volume (`music`, `musicMuted`). */
export function musicRow(get: () => Settings, set: (s: Settings) => void): HTMLElement {
  return volumeRow('Jukebox', () => ({ volume: get().music, muted: get().musicMuted }), (l) => set({ ...get(), music: l.volume, musicMuted: l.muted }));
}

/** A slider for each kind of sound under the master, each named and saying what it covers, and the note under them. */
export function mixRows(get: () => Settings, set: (s: Settings) => void): HTMLElement[] {
  const rows = MIXES.map((k) => {
    const [icon, name, covers] = MIX_LABEL[k];
    const row = volumeRow(name, () => get().mix[k], (l) => set({ ...get(), mix: { ...get().mix, [k]: l } }));
    return h('div.mix-row', {}, h('div.mix-name', {}, h('strong', {}, `${icon} ${name}`), h('span', {}, covers)), row);
  });
  return [h('div.mix', {}, ...rows), h('p.setting-note', {}, 'How loud each kind of sound is, under the office sounds volume above: turning that down or muting it turns them all down.')];
}

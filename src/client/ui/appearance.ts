// ⚙️ Settings' theme (the You pane): how the windows, the HUD, the kanban and the 2D view look,
// taking effect as you click. Its own file to keep settings.ts short.
import { APPEARANCES, loadAppearance, setAppearance } from '../themes';
import { h } from './dom';

/** The buttons and their note, for `setting('Theme', 'you', ...)`. */
export function appearanceRow(): [HTMLElement, HTMLElement] {
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Theme' });
  const note = h('p.setting-note', {}, 'Just how this browser looks: the windows, the HUD, the kanban and the 2D view. The 3D office itself stays the same.');
  let now = loadAppearance();
  const paint = () => {
    seg.replaceChildren(
      ...APPEARANCES.map((a) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(a.id === now),
            class: a.id === now ? 'on' : '',
            onclick: () => {
              if (a.id === now) return;
              setAppearance((now = a.id));
              paint();
            },
          },
          `${a.icon} ${a.label}`,
        ),
      ),
    );
  };
  paint();
  return [seg, note];
}

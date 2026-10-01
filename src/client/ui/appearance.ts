// ⚙️ Settings' theme (the You pane): how the windows, the HUD, the kanban and the 2D view look,
// taking effect as you click. Its own file to keep settings.ts short.
import { APPEARANCES, parseAppearance, setAppearance } from '../themes';
import { h } from './dom';

/** The buttons and their note, for `setting('Theme', 'you', ...)`. */
export function appearanceRow(): [HTMLElement, HTMLElement] {
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Theme' });
  const note = h('p.setting-note', {}, 'Just how this browser looks: the windows, the HUD, the kanban and the 2D view. The 3D office itself stays the same.');
  // The page's own appearance, so a change made elsewhere (another tab) is what the row shows and compares with.
  const current = () => parseAppearance(document.documentElement.dataset.theme);
  const paint = () => {
    const now = current();
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
              if (a.id !== current()) setAppearance(a.id);
            },
          },
          `${a.icon} ${a.label}`,
        ),
      ),
    );
  };
  // Repaint whenever the page's appearance changes; stop once the row has left the window it was shown in.
  let shown = false;
  const follow = () => {
    if (seg.isConnected) shown = true;
    else if (shown) return window.removeEventListener('appearancechange', follow);
    paint();
  };
  window.addEventListener('appearancechange', follow);
  paint();
  return [seg, note];
}

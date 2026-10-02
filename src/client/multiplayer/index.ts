// Multiplayer in the 3D office. One install line in main.ts; ☰ → 🌐 Players is added by the HUD
// (playersAction). While the page is visiting another office (`?visit=`), this shows the banner and
// says what happened when a change was held back or the visit ended.
import './ui.css';
import type { Ctx } from '../core/context';
import { h, toast } from '../ui/dom';
import { goHome, onVisitDenied, onVisitEnded, visiting } from './visit';

export function installMultiplayer(_ctx: Ctx) {
  const login = visiting();
  if (!login) return;
  const banner = h('div.mp-visit-banner', { role: 'status' }, h('span', {}, `👀 Visiting @${login} · read-only`), h('button.btn', { type: 'button', onclick: goHome }, '🏠 Back to my office'));
  document.body.append(banner);
  let last = 0;
  onVisitDenied(() => {
    // Many held-back messages can come at once (a key held down): one hint is enough.
    if (Date.now() - last < 4000) return;
    last = Date.now();
    toast('👀 Visiting — read-only', 'warn');
  });
  onVisitEnded((reason) => toast(`${reason} Going back to your office…`, 'warn'));
}

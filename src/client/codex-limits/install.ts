// The Codex limits panel in the 3D office. One install line in main.ts. It asks the office to read
// the Codex limits only while the panel is on and the tab is in view (see watch.ts).
import type { Ctx } from '../core/context';
import { store } from '../state';
import { onPanelChange } from '../ui/menu';
import { renderCodexLimits } from './panel';
import { refreshCodexLimits, wantCodexLimits } from './watch';

export function installCodexLimits(ctx: Ctx) {
  const on = () => ctx.settings.hud.codexLimits;
  // The countdowns ("resets in 2h 5m") move on their own; this redraws them while the panel is up.
  let timer = 0;

  function follow() {
    const run = on() && document.visibilityState === 'visible';
    if (run && !timer) timer = window.setInterval(renderCodexLimits, 30_000);
    else if (!run && timer) {
      clearInterval(timer);
      timer = 0;
    }
    if (run) renderCodexLimits();
  }

  onPanelChange((id) => {
    if (id !== 'codexLimits') return;
    wantCodexLimits(ctx.net, 'panel', on());
    follow();
  });
  document.addEventListener('visibilitychange', follow);
  store.on('codexLimits', () => on() && renderCodexLimits());
  document.getElementById('codex-limits')?.addEventListener('click', () => on() && refreshCodexLimits(ctx.net));
  wantCodexLimits(ctx.net, 'panel', on());
  follow();
}

// The 🌐 Multiplayer category of ⚙️ Settings (ui/settings.ts): an empty pane, filled the first time
// it is shown, so the pane's code is only loaded then (see kanban/settingsslot.ts, which does the same).
import type { Net } from '../net';
import { h } from '../ui/dom';

export const MULTIPLAYER_PANES = [
  { id: 'multiplayer', icon: '🌐', label: 'Multiplayer', blurb: 'Connect this office to a multiplayer server, choose which floors other players may visit, and see who you are there.' },
] as const;
export type MultiplayerSettingsPane = (typeof MULTIPLAYER_PANES)[number]['id'];

export function multiplayerSettingsSlot(net: Net): { pane: HTMLElement; shown(id: string): void; close(): void } {
  const pane = h('div');
  let started = false;
  let closed = false;
  let closeInner: (() => void) | undefined;
  return {
    pane,
    shown(id) {
      if (started || closed || id !== 'multiplayer') return;
      started = true;
      pane.replaceChildren(h('p.setting-note', {}, 'Loading…'));
      import('./settings').then(
        ({ multiplayerPane }) => {
          if (closed) return;
          const inner = multiplayerPane(net);
          closeInner = inner.close;
          pane.replaceChildren(inner.el);
        },
        () => pane.replaceChildren(h('p.setting-note', {}, 'The multiplayer settings didn’t load: reload the page.')),
      );
    },
    close() {
      closed = true;
      closeInner?.();
    },
  };
}

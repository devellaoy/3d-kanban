// The kanban's categories in ⚙️ Settings (ui/settings.ts) as that window sees them: two empty panes,
// filled the first time one of them is shown. Only then is the kanban's settings code loaded
// (settings.ts, with skills.ts and settings.css) and are its settings asked for, so opening Settings
// for the volume or the camera costs the 3D page nothing of the kanban's.

import { h } from '../ui/dom';
import type { Net } from '../net';

/** The kanban's categories in ⚙️ Settings, after upstream's own. */
export const KANBAN_PANES = [
  { id: 'kanban', icon: '🗂️', label: 'Kanban', blurb: 'What new kanban tasks start with, their reviews, resuming and archiving, the secrets for Jira and the API, and the skills the office found.' },
  { id: 'projects', icon: '📁', label: 'Projects', blurb: 'Per project: its repositories and instructions, where its issues come from, which skills its phases get and its own wording of the kanban prompts.' },
] as const;
export type KanbanSettingsPane = (typeof KANBAN_PANES)[number]['id'];

const isKanbanPane = (id: string): id is KanbanSettingsPane => KANBAN_PANES.some((p) => p.id === id);

export function kanbanSettingsSlots(net: Net): { panes: Record<KanbanSettingsPane, HTMLElement>; shown(id: string): void; close(): void } {
  const panes: Record<KanbanSettingsPane, HTMLElement> = { kanban: h('div'), projects: h('div') };
  let started = false;
  let closed = false;
  let closeInner: (() => void) | undefined;
  return {
    panes,
    shown(id) {
      if (started || closed || !isKanbanPane(id)) return;
      started = true;
      for (const el of Object.values(panes)) el.replaceChildren(h('p.setting-note', {}, 'Loading…'));
      import('./settings').then(
        ({ kanbanSettingsPanes }) => {
          if (closed) return;
          const inner = kanbanSettingsPanes(net);
          closeInner = inner.close;
          panes.kanban.replaceChildren(inner.panes.kanban);
          panes.projects.replaceChildren(inner.panes.projects);
        },
        () => {
          // A new build since this page loaded: its chunks have other names.
          for (const el of Object.values(panes)) el.replaceChildren(h('p.setting-note', {}, 'The kanban’s settings didn’t load: reload the page.'));
        },
      );
    },
    close() {
      closed = true;
      closeInner?.();
    },
  };
}

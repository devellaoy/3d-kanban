// The kanban's own pieces of the 3D office (docs/kanban-coupling.md): J opens the kanban view on the
// floor you're on (the task of the worker whose desk you face, on its conversation), and the ☰ menu
// has an entry for it; the kanban's 📍 Show in 3D link (`/?floor=…&worker=…&desk=…`) takes you in on that
// floor, then to the desk and the worker's window; and a task's ⏳ retry countdown ticks on its worker's
// card; the tasks on hold sit in the lounge (lounge3d.ts). Everything else the kanban does in the
// office is done where that code is.

import type { Ctx } from '../core/context';
import type { CoreState } from '../core/ctx';
import type { Parts } from '../core/parts';
import { store } from '../state';
import { rememberFloor } from '../state/persist';
import { toast } from '../ui/dom';
import { kanbanUrl, parseOfficeLink, withoutOfficeLink, type OfficeLink } from './office';
import { tickRetryCountdown } from '../features/workers/views';
import { installLounge3d } from './lounge3d';

/** The 📍 Show in 3D link this page was opened with, read before anything else moves the address. */
const opened = parseOfficeLink(location.search);

export type Kanban3dParts = Pick<Parts, 'pointer' | 'travel' | 'actions' | 'waiting' | 'views'>;

/** Registers J, the 📍 Show in 3D link's follow-up (after the welcome and each floor you arrive on) and the retry countdown. */
export function installKanban3d(ctx: Ctx, core: CoreState, parts: Kanban3dParts) {
  let link: (OfficeLink & { rode?: boolean }) | null = opened;
  if (link) {
    rememberFloor(link.floor);
    history.replaceState(null, '', location.pathname + withoutOfficeLink(location.search));
  }

  /** The kanban view, showing the project of the floor you're on. */
  function openKanban() {
    // Facing a task worker's desk: its task, on the conversation.
    const target = parts.pointer.target();
    const w = target?.kind === 'desk' && target.deskId ? store.workerAtDesk(target.deskId) : undefined;
    location.assign(kanbanUrl(store.floor, w));
  }
  ctx.keys.bind({
    code: 'KeyJ',
    run: () => {
      openKanban();
    },
  });

  /** After the welcome (or the elevator), the 📍 Show in 3D link's floor, desk and worker window. */
  function followOfficeLink() {
    if (!link || !store.floor || core.trip) return;
    if (store.floor !== link.floor) {
      // One ride over: the floor.enter it ends with comes back here.
      if (link.rode || !store.floors.some((f) => f.id === link!.floor && !f.cloning)) {
        link = null;
        return void toast('🗂️ Couldn’t get to that floor', 'warn');
      }
      link.rode = true;
      return parts.travel.switchFloor(link.floor);
    }
    const here = link;
    link = null;
    setTimeout(() => {
      const w = here.worker ? store.workers.get(here.worker) : undefined;
      const deskId = w?.deskId ?? here.desk;
      if (deskId) parts.actions.goToDesk(deskId);
      if (w) parts.waiting.openWorkerTerminal(w.id, undefined, 'task');
      else if (here.worker) toast('That worker has gone home since', 'warn');
    }, 400);
  }
  ctx.messages.on('welcome', followOfficeLink);
  ctx.messages.on('floor.enter', followOfficeLink);

  tickRetryCountdown(parts.views.workerViews, parts.views.meetingCard);

  // The floor's tasks on hold, as figures in the lounge; E at one opens its task, as the queue board's 🗂️ Task does.
  installLounge3d(ctx, { openTask: (id) => void import('./taskview').then((m) => m.openTaskWindow(ctx.net, id)) });

  return { openKanban };
}

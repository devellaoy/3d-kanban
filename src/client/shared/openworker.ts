// A worker's terminal for the 2D view and the kanban page, which are in the office without standing
// anywhere in it: waking it up first if it's asleep, and the dialog for a worktree that was deleted.

import { DESK_BY_ID } from '../../shared/layout';
import { isAsleep } from '../../shared/status';
import type { WorkerInfo } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { toast } from '../ui/dom';
import { openTerminal, type TerminalOptions } from '../ui/terminal';
import { openChanges } from '../ui/changes';
import { lostWorktreeDialog, sendHomeDialog } from '../ui/prompt';
import { sendTaskWorkerHome } from '../kanban/sendhome';

export function workerOpener(net: Net, opts: { keypad: () => boolean }) {
  /** Its terminal, waking it up first if it's asleep. */
  function openWorker(id: string, termOpts?: TerminalOptions) {
    const w = store.workers.get(id);
    if (!w) return;
    if (w.lost) return fixLostWorktree(w);
    if (isAsleep(w.status)) {
      if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved session — starting a fresh one`, 'warn');
      net.send({ t: 'worker.resume', workerId: id });
    }
    openTerminal(net, id, () => openChanges(net, id, () => openWorker(id, termOpts)), undefined, { ...termOpts, keypad: opts.keypad() });
  }

  /** Its worktree was deleted outside agent-office: put it back (everyone's who lost theirs), or send it home. */
  function fixLostWorktree(w: WorkerInfo) {
    if (!w.lost || !w.worktree) return;
    const worktree = w.worktree;
    const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
    lostWorktreeDialog({
      name: w.name,
      worktree,
      lost: w.lost,
      workspace: w.repos?.length ? worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
      others: others.map((o) => o.name),
      openTerminal: isAsleep(w.status) ? undefined : () => openTerminal(net, w.id, () => openChanges(net, w.id, () => openWorker(w.id)), undefined, { keypad: opts.keypad() }),
      rebuild: (all) => {
        toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
        net.send({ t: 'worker.rebuild', workerId: w.id, all });
      },
      // A task worker's dialog has its task in it.
      sendHome: () =>
        sendTaskWorkerHome(net, w, DESK_BY_ID.get(w.deskId)?.label ?? 'its desk') ||
        sendHomeDialog({
          workerId: w.id,
          name: w.name,
          where: DESK_BY_ID.get(w.deskId)?.label ?? 'its desk',
          worktree,
          repos: w.repos?.length ? [worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
          ask: () => net.send({ t: 'worker.worktree', workerId: w.id }),
          onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: w.id, cleanup }),
        }),
    });
  }

  return { openWorker, fixLostWorktree };
}

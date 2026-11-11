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
import { confirmDialog, lostWorktreeDialog, sendHomeDialog } from '../ui/prompt';
import { providerLabel } from '../ui/provider';
import { projectOf } from '../state/workers';
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
      sendHome: () => sendHome(w.id, 'its desk'),
    });
  }

  /**
   * Sends it home, asking first as X does in the 3D office: a task worker's dialog has its task in it,
   * one with a worktree of its own picks what becomes of the worktree and its branch, and anyone else
   * (a shell, an agent in the project's folder) is a plain confirm. `unnamed` stands in for a desk without a label.
   */
  function sendHome(id: string, unnamed = 'the desk') {
    const w = store.workers.get(id);
    if (!w) return;
    const where = DESK_BY_ID.get(w.deskId)?.label ?? unnamed;
    if (sendTaskWorkerHome(net, w, where)) return;
    if (w.worktree) {
      const worktree = w.worktree;
      sendHomeDialog({
        workerId: id,
        name: w.name,
        where,
        worktree,
        repos: w.repos?.length ? [worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
        ask: () => net.send({ t: 'worker.worktree', workerId: id }),
        onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: id, cleanup }),
      });
      return;
    }
    const session = w.kind === 'shell' ? 'shared shell' : `${providerLabel(w.provider, projectOf(id))} session`;
    confirmDialog(`Send ${w.name} home?`, `This stops the ${session} at ${where} for everyone and frees the desk.`, 'Send home', () => net.send({ t: 'worker.kill', workerId: id }));
  }

  return { openWorker, fixLostWorktree, sendHome };
}

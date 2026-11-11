// Sending a task worker home (X in the 3D office, the 2D view's send home): upstream's dialog with the
// task's block on top. An implementer's shows "Move task #14 to Done" (ticked when the task is in
// review) over upstream's worktree choices and unpushed-work warnings; a reviewer shares the task's
// worktree, so its dialog only says the review round is abandoned and keeps everything. Either way it
// sends worker.kill {…, kanban: {done}}, and the engine does the rest (docs/kanban-coupling.md, X).

import type { WorkerInfo, WorktreeCleanup } from '../../shared/protocol';
import type { Net } from '../net';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { btn, checkLine } from '../ui/kit';
import { sendHomeDialog } from '../ui/prompt';
import { modalShell, openShell } from '../ui/shell';
import { clipText, doneDefault, kanbanOf, STATUS_TEXT } from './office';

/** The task's part of the dialog, and whether its Done box is ticked (undefined: there's no box). */
function taskBlock(w: WorkerInfo): { el: HTMLElement; done(): boolean | undefined } {
  const k = kanbanOf(w)!;
  const title = k.title ? ` · ${clipText(k.title, 80)}` : '';
  const head = h('p.kb-home-task', {}, icon(k.role === 'reviewer' ? 'eye' : 'square-kanban', { size: 14 }), h('span', {}, `${k.role === 'reviewer' ? 'Reviewing task' : 'Task'} #${k.taskId}${title}`, k.status ? h('small', {}, ` (${STATUS_TEXT[k.status]})`) : null));
  if (k.role === 'reviewer') {
    return {
      el: h('div.kb-home', {}, head, h('p.wt-status', {}, 'The review round is abandoned: the task goes back to review (or takes the messages waiting for it). The task’s worktree stays as it is.')),
      done: () => undefined,
    };
  }
  const def = doneDefault(k.status);
  if (def === null) return { el: h('div.kb-home', {}, head), done: () => undefined };
  const note = h('small', {}, def ? 'Its automation is finished.' : 'Unticked, it keeps its column: a live run is stopped and the task waits with Retry.');
  const tick = checkLine([`Move task #${k.taskId} to Done`, note]);
  tick.el.classList.add('kb-home-done');
  tick.box.checked = def;
  return { el: h('div.kb-home', {}, head, tick.el), done: () => tick.box.checked };
}

function kill(net: Net, w: WorkerInfo, cleanup: WorktreeCleanup | undefined, done: boolean | undefined) {
  net.send({ t: 'worker.kill', workerId: w.id, ...(cleanup ? { cleanup } : {}), ...(done !== undefined ? { kanban: { done } } : {}) });
}

/**
 * The send-home dialog for a worker with a kanban task; false for any other worker (the caller then
 * does upstream's). `where` is the desk's label.
 */
export function sendTaskWorkerHome(net: Net, w: WorkerInfo, where: string): boolean {
  const k = kanbanOf(w);
  if (!k) return false;
  const block = taskBlock(w);
  // A reviewer sits in the task's own worktree: it's never deleted from here.
  if (w.worktree && k.role !== 'reviewer') {
    const worktree = w.worktree;
    sendHomeDialog({
      workerId: w.id,
      name: w.name,
      where,
      worktree,
      repos: w.repos?.length ? [worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
      ask: () => net.send({ t: 'worker.worktree', workerId: w.id }),
      onConfirm: (cleanup) => kill(net, w, cleanup, block.done()),
      extra: block.el,
    });
    return true;
  }
  const yes = btn('Send home', { kind: 'danger', icon: 'log-out', attrs: { autofocus: true } });
  const no = btn('Cancel', { kind: 'quiet' });
  const shell = modalShell({
    cls: 'confirm danger w420',
    role: 'alertdialog',
    icon: 'triangle-alert',
    title: `Send ${w.name} home?`,
    body: [block.el, h('div.confirm-body', {}, h('span', {}, `This stops the session at ${where} for everyone and frees the desk.`))],
    footerRight: [no, yes],
  });
  const modal = openShell(shell);
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => {
    modal.close();
    kill(net, w, k.role === 'reviewer' ? 'keep' : undefined, block.done());
  });
  return true;
}

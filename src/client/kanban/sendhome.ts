// Sending a task worker home (X in the 3D office, the 2D view's send home): upstream's dialog with the
// task's block on top. An implementer's shows "Move task #14 to Done" (ticked when the task is in
// review) over upstream's worktree choices and unpushed-work warnings; a reviewer shares the task's
// worktree, so its dialog only says the review round is abandoned and keeps everything. Either way it
// sends worker.kill {…, kanban: {done}}, and the engine does the rest (docs/kanban-coupling.md, X).

import type { WorkerInfo, WorktreeCleanup } from '../../shared/protocol';
import type { Net } from '../net';
import { h, openModal } from '../ui/dom';
import { sendHomeDialog } from '../ui/prompt';
import { clipText, doneDefault, kanbanOf, STATUS_TEXT } from './office';

/** The task's part of the dialog, and whether its Done box is ticked (undefined: there's no box). */
function taskBlock(w: WorkerInfo): { el: HTMLElement; done(): boolean | undefined } {
  const k = kanbanOf(w)!;
  const title = k.title ? ` · ${clipText(k.title, 80)}` : '';
  const head = h('p', { style: 'margin:0 0 6px;font-weight:800' }, `${k.role === 'reviewer' ? '🔍 Reviewing' : '🗂️'} task #${k.taskId}${title}`, k.status ? h('small', { style: 'margin-left:6px;color:var(--muted)' }, `(${STATUS_TEXT[k.status]})`) : null);
  if (k.role === 'reviewer') {
    return {
      el: h('div.kb-home', { style: 'margin:0 0 12px' }, head, h('p.wt-status', { style: 'margin:0' }, 'The review round is abandoned: the task goes back to review (or takes the messages waiting for it). The task’s worktree stays as it is.')),
      done: () => undefined,
    };
  }
  const def = doneDefault(k.status);
  if (def === null) return { el: h('div.kb-home', { style: 'margin:0 0 12px' }, head), done: () => undefined };
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = def;
  const note = h('small', { style: 'display:block;font-weight:600;color:var(--muted)' }, def ? 'Its automation is finished.' : 'Unticked, it keeps its column: a live run is stopped and the task waits with Retry.');
  return {
    el: h('div.kb-home', { style: 'margin:0 0 12px' }, head, h('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:0;font-weight:700;cursor:pointer' }, box, h('span', {}, `Move task #${k.taskId} to Done`, note))),
    done: () => box.checked,
  };
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
  const title = `Send ${w.name} home?`;
  const yes = h('button.btn.danger', { type: 'button' }, 'Send home');
  const no = h('button.btn', { type: 'button' }, 'Never mind');
  const el = h(
    'div.modal',
    { role: 'alertdialog', 'aria-label': title },
    h('header', {}, h('h2', {}, title)),
    h('div.body', {}, block.el, h('p', { style: 'margin:0;font-weight:700' }, `This stops the session at ${where} for everyone and frees the desk.`)),
    h('footer', {}, no, yes),
  );
  const modal = openModal(el);
  no.addEventListener('click', () => modal.close());
  yes.addEventListener('click', () => {
    modal.close();
    kill(net, w, k.role === 'reviewer' ? 'keep' : undefined, block.done());
  });
  setTimeout(() => yes.focus(), 30);
  return true;
}

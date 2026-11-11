// The task's Changes view in a window of its own: C or 🌿 Changes at a task worker (upstream's
// openChanges hands over to it), and the kanban page's Changes shortcut. The view is changesview.ts.

import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, type Modal } from '../ui/dom';
import { ChangesView } from './changesview';

export interface TaskChangesOptions {
  taskId: number;
  workerId?: string;
  repo?: string;
  floor?: string;
  /** ⌨️ Terminal in the header: the worker's terminal instead. */
  onTerminal?: () => void;
  /** The window closed, whatever closed it (also when ⌨️ Terminal did). */
  onClosed?: () => void;
}

let current: { taskId: number; workerId?: string; view: ChangesView; modal: Modal } | null = null;

/** The view in upstream's Changes window frame (dot, name, branch, ⌨️ Terminal, ✕); the same task and worker again switches repository, another closes it. */
export function openTaskChanges(net: Net, o: TaskChangesOptions): Modal | void {
  if (current && current.taskId === o.taskId && current.workerId === o.workerId) return current.view.showRepo(o.repo, o.floor);
  const previous = current;
  const w = o.workerId ? store.workers.get(o.workerId) : undefined;
  const dot = h('span.dot', { style: `background:${w?.color ?? '#ccc'}` });
  const title = h('h2');
  const branch = h('span.branch');
  const terminalBtn = h('button.btn', { type: 'button', title: 'Open the terminal instead' }, '⌨️ Terminal');
  const closeBtn = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const renderHeader = () => {
    const now = view.worker();
    if (now) dot.setAttribute('style', `background:${now.color}`);
    title.textContent = now ? `${now.name} · changes` : `Task #${o.taskId} · changes`;
    branch.textContent = view.branchText();
  };
  const view = new ChangesView({ net, ...o }, h('footer'), () => renderHeader());
  const el = h(
    'div.modal.desk-changes.kb-cv',
    { role: 'dialog', 'aria-label': w ? `${w.name}'s changes` : `Task #${o.taskId}'s changes`, tabindex: -1 },
    h('header', {}, dot, title, branch, o.onTerminal ? terminalBtn : null, closeBtn),
    view.bar,
    view.body,
    view.foot,
  );
  el.addEventListener('keydown', (e) => view.keydown(e));
  terminalBtn.addEventListener('click', () => {
    o.onTerminal?.();
    modal.close();
  });
  const modal = openModal(el, {
    doing: w ? `🌿 looking over ${w.name}'s changes` : `🌿 looking over task #${o.taskId}'s changes`,
    onClose: () => {
      view.destroy();
      if (current?.modal === modal) current = null;
      o.onClosed?.();
    },
  });
  current = { taskId: o.taskId, workerId: o.workerId, view, modal };
  previous?.modal.close();
  closeBtn.addEventListener('click', () => modal.close());
  view.start();
  renderHeader();
  setTimeout(() => el.focus(), 30);
  return modal;
}

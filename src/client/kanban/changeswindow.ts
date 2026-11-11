// The task's Changes view in a window of its own: C or 🌿 Changes at a task worker (upstream's
// openChanges hands over to it), and the kanban page's Changes shortcut. The view is changesview.ts.

import type { Net } from '../net';
import { store } from '../state';
import { h, type Modal } from '../ui/dom';
import { withIcon } from '../ui/icons';
import { btn } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
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
  const branch = h('span.branch');
  const terminalBtn = btn('Terminal', { kind: 'quiet', size: 'sm', icon: 'square-terminal', attrs: { title: 'Open the terminal instead' } });
  const renderHeader = () => {
    const now = view.worker();
    if (now) dot.setAttribute('style', `background:${now.color}`);
    shell.setTitle(now ? `${now.name} · changes` : `Task #${o.taskId} · changes`);
    const text = view.branchText();
    branch.replaceChildren(...(text ? withIcon('git-branch', text, 13) : []));
  };
  const view = new ChangesView({ net, ...o }, h('footer.shell-foot'), () => renderHeader());
  const shell = modalShell({
    cls: 'desk-changes kb-cv',
    icon: 'file-diff',
    title: w ? `${w.name} · changes` : `Task #${o.taskId} · changes`,
    label: w ? `${w.name}'s changes` : `Task #${o.taskId}'s changes`,
    id: h('span.changes-id', {}, dot, branch),
    tools: o.onTerminal ? [terminalBtn] : [],
    body: [view.bar, view.body],
  });
  const el = shell.el;
  el.tabIndex = -1;
  el.append(view.foot);
  el.addEventListener('keydown', (e) => view.keydown(e));
  terminalBtn.addEventListener('click', () => {
    o.onTerminal?.();
    modal.close();
  });
  const modal = openShell(shell, {
    doing: w ? `🌿 looking over ${w.name}'s changes` : `🌿 looking over task #${o.taskId}'s changes`,
    onClose: () => {
      view.destroy();
      if (current?.modal === modal) current = null;
      o.onClosed?.();
    },
  });
  current = { taskId: o.taskId, workerId: o.workerId, view, modal };
  previous?.modal.close();
  view.start();
  renderHeader();
  setTimeout(() => el.focus(), 30);
  return modal;
}

// One issue of a project's issue sources, in its own window on the kanban page (from 📌 Issues): the
// issue view (issueview.ts) and its kanban task.

import { h, toast } from '../ui/dom';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { issueView } from './issueview';
import { dialog, run, showDialog } from './ui';

/** `opts.reload` is the view's (see issueView). */
export function openIssueWindow(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void, opts: { reload?: () => Promise<NormalizedIssue | undefined> } = {}) {
  const task = h('button.btn.primary', { type: 'button' }) as HTMLButtonElement;
  const start = h('button.btn', { type: 'button', title: 'Make a kanban task of it and start it at a free desk' }, '▶ Create & start') as HTMLButtonElement;
  const view = issueView(api, projectId, first, (id) => (modal.close(), openTask(id)), opts);
  const d = dialog('kb-issue-window', first.title, h('div.body', {}, view.el), h('footer', {}, h('span.grow'), start, task));
  view.onPaint((it) => {
    task.textContent = it.taskId ? `↗ #${it.taskId}` : '＋ Create task';
    start.style.display = it.taskId ? 'none' : '';
    task.title = it.taskId ? 'Open the kanban task made from it' : 'Make a kanban task of it';
  });
  const create = async (btn: HTMLButtonElement, startIt: boolean) => {
    const it = view.issue();
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.issues.createTask', project: projectId, issueKey: it.key, ...(startIt ? { start: true } : {}) }), btn, startIt ? undefined : 'Task created');
    if (!ok?.taskId) return;
    view.set({ ...view.issue(), taskId: ok.taskId });
    if (!startIt) return;
    if (ok.startError) toast(`Task #${ok.taskId} was made, but it didn't start: ${ok.startError}`, 'warn');
    else toast(ok.started ? `Task #${ok.taskId} started` : `Task #${ok.taskId} is in To do`);
  };
  task.addEventListener('click', () => {
    const it = view.issue();
    if (!it.taskId) return void create(task, false);
    modal.close();
    openTask(it.taskId);
  });
  start.addEventListener('click', () => void create(start, true));
  const modal = showDialog(d, { onClose: () => view.destroy() });
}

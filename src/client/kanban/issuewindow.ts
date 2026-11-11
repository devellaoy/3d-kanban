// One issue of a project's issue sources, in its own window on the kanban page (from Issues): the
// shared shell with the issue view (issueview.ts) laid out as a window: the key, the status and the
// source in the header, the description and the comments in the body, the status and assignee actions
// and the details in the rail, and its kanban task (or the ways to make one) in the footer.

import { h, toast } from '../ui/dom';
import { iconButton } from '../ui/icons';
import { btn, outLink } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { safeUrl } from './issueactionsmodel';
import { issueMeta, issueView } from './issueview';
import { run } from './ui';

/** "Open in Jira", "Open on GitHub": where an issue's own page is. */
export const sourceLinkLabel = (source: string | undefined): string => (source === 'jira' ? 'Open in Jira' : source === 'azure-boards' ? 'Open in Azure Boards' : 'Open on GitHub');

/** `opts.reload` is the view's (see issueView). */
export function openIssueWindow(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void, opts: { reload?: () => Promise<NormalizedIssue | undefined> } = {}) {
  const create = btn('Create task', { icon: 'plus', attrs: { title: 'Make a kanban task of it' } });
  const start = btn('Create and start', { kind: 'primary', icon: 'play', attrs: { title: 'Make a kanban task of it and start it at a free desk' } });
  const toTask = h('button.link-btn.iw-task-link', { type: 'button', title: 'Open the kanban task made from it' }) as HTMLButtonElement;
  const refresh = iconButton('refresh-cw', 'Refresh', { title: 'Refresh: read the issue from its source again' });
  const view = issueView(api, projectId, first, (id) => (modal.close(), openTask(id)), { ...opts, split: true });
  const url = safeUrl(first.url);
  const status = h('span.iw-status');
  const meta = h('span.iw-meta');
  const shell = modalShell({
    cls: 'iw w840',
    kind: 'rich',
    title: first.title,
    label: `Issue ${first.key}`,
    id: url ? outLink(first.key, url, { title: 'Open it at the source' }) : first.key,
    pill: status,
    meta: [meta],
    tools: [refresh],
    body: view.el,
    rail: view.rail,
    footerLeft: [url ? outLink(sourceLinkLabel(first.source), url) : null],
    footerRight: [toTask, create, start],
  });
  view.onPaint((it) => {
    shell.setTitle(it.title);
    shell.el.setAttribute('aria-label', `Issue ${it.key}`);
    status.textContent = it.status ?? '';
    status.classList.toggle('hidden', !it.status);
    meta.textContent = issueMeta(it);
    toTask.textContent = it.taskId ? `Task #${it.taskId}` : '';
    toTask.classList.toggle('hidden', !it.taskId);
    create.classList.toggle('hidden', !!it.taskId);
    start.classList.toggle('hidden', !!it.taskId);
  });
  const make = async (button: HTMLButtonElement, startIt: boolean) => {
    const it = view.issue();
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.issues.createTask', project: projectId, issueKey: it.key, ...(startIt ? { start: true } : {}) }), button, startIt ? undefined : 'Task created');
    if (!ok?.taskId) return;
    view.set({ ...view.issue(), taskId: ok.taskId });
    if (!startIt) return;
    if (ok.startError) toast(`Task #${ok.taskId} was made, but it didn't start: ${ok.startError}`, 'warn');
    else toast(ok.started ? `Task #${ok.taskId} started` : `Task #${ok.taskId} is in To do`);
  };
  create.addEventListener('click', () => void make(create, false));
  start.addEventListener('click', () => void make(start, true));
  toTask.addEventListener('click', () => {
    const id = view.issue().taskId;
    if (!id) return;
    modal.close();
    openTask(id);
  });
  // A browsed issue is read again on its own; one from the list comes back with the project's list.
  refresh.addEventListener('click', () => {
    if (!opts.reload) return void run(() => api.request<Extract<KanbanServerMsg, { t: 'kanban.issues' }>>({ t: 'kanban.issues.refresh', project: projectId }), refresh);
    void run(async () => {
      const fresh = await opts.reload!();
      if (fresh) view.set({ ...fresh, taskId: fresh.taskId ?? view.issue().taskId }, true);
    }, refresh);
  });
  const modal = openShell(shell, { onClose: () => view.destroy() });
}

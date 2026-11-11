// A task's Issue tab: the issue its ticket names, as the issue window shows it (issueview.ts), read
// through kanban.issue.get. The task view redraws on every update, so the tab keeps its host and the
// view inside (a comment being written survives) and only reloads when the ticket changes.

import { h, toast } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTask, NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { safeUrl } from './issueactionsmodel';
import { issueView, type IssueView } from './issueview';

type Detail = Extract<KanbanServerMsg, { t: 'kanban.issueDetail' }>;

export function mountIssueTab(api: KanbanApi, openTask: (id: number) => void): { host: HTMLElement; setTask(task: KanbanTask): void; destroy(): void } {
  const host = h('div.kb-tv-issue');
  let key = '';
  let view: IssueView | null = null;
  let gone = false;
  const current = (k: string) => !gone && key === k;
  // The task this issue was made for is the viewer's own; a ticket may have several tasks.
  const plain = (i: NormalizedIssue): NormalizedIssue => ({ ...i, taskId: undefined });

  const load = async (task: KanbanTask, fresh: boolean): Promise<NormalizedIssue | undefined> => {
    const k = key;
    const msg = await api.request<Detail>({ t: 'kanban.issue.get', project: task.project, issueKey: task.ticket!, ...(fresh ? { fresh: true } : {}) });
    return current(k) ? plain(msg.issue) : undefined;
  };
  const fail = (task: KanbanTask, why: string) => {
    const url = safeUrl(task.ticketUrl);
    const again = h('button.btn.small', { type: 'button', 'data-focus': 'issue-retry' }, '🔄 Try again') as HTMLButtonElement;
    again.addEventListener('click', () => show(task, true));
    host.replaceChildren(
      h('div.kb-iw-miss', {}, url ? h('a.kb-iw-key', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, `${task.ticket} ↗`) : h('span.kb-iw-key', {}, task.ticket), h('p.kb-muted', {}, why), again),
    );
  };
  const show = (task: KanbanTask, fresh: boolean) => {
    const k = key;
    view?.destroy();
    view = null;
    host.replaceChildren(h('p.kb-muted', {}, 'Loading the issue…'));
    load(task, fresh).then(
      (issue) => {
        if (!issue || !current(k)) return;
        const refresh = h('button.btn.small', { type: 'button', title: 'Read the issue from its source again', 'data-focus': 'issue-refresh' }, '🔄 Refresh') as HTMLButtonElement;
        const reload = () => load(task, true);
        view = issueView(api, task.project, issue, openTask, { reload, title: true, whole: true });
        refresh.addEventListener('click', () => {
          refresh.disabled = true;
          reload()
            .then((i) => i && view?.set(i))
            .catch((e: Error) => toast(e.message || 'The issue could not be read', 'error'))
            .finally(() => (refresh.disabled = false));
        });
        host.replaceChildren(h('div.kb-iw-bar', {}, refresh), view.el);
      },
      (err: Error) => current(k) && fail(task, err.message || 'The issue could not be read'),
    );
  };

  return {
    host,
    setTask(task) {
      const next = task.ticket ? `${task.project}\n${task.ticket}` : '';
      if (next === key && (key || host.childElementCount)) return;
      key = next;
      view?.destroy();
      view = null;
      if (!task.ticket) host.replaceChildren(h('p.kb-muted', {}, 'No issue is linked to this task. Add its key (UYT-1415, gh:owner/repo#12) with ✏️ Edit.'));
      else show(task, false);
    },
    destroy() {
      gone = true;
      view?.destroy();
      view = null;
    },
  };
}

// One issue of a project's issue sources, in its own window on the kanban page (from 📌 Issues): what
// the source says, the actions on it (issueactions.ts) and its kanban task. It follows the office's
// kanban.issues, so a status or assignee changed from here (or elsewhere) shows as soon as it's back.

import { h, timeAgo } from '../ui/dom';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { issueActions } from './issueactions';
import { actionIssue, safeUrl } from './issueactionsmodel';
import { SOURCE_KIND_NAMES } from './labels';
import { renderMarkdown } from './md';
import { dialog, run, showDialog } from './ui';

export function openIssueWindow(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void) {
  let it = first;
  const chips = h('span.kb-chips');
  const task = h('button.btn.primary', { type: 'button' }) as HTMLButtonElement;
  const panel = issueActions(api, projectId, actionIssue(it), { openTask: (id) => (modal.close(), openTask(id)) });
  const url = safeUrl(it.url);
  const body = h(
    'div.body',
    {},
    h('div.kb-iw-top', {}, url ? h('a.kb-iw-key', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, `${it.key} ↗`) : h('span.kb-iw-key', {}, it.key), chips),
    h('div.kb-iw-desc', {}, renderMarkdown(it.body, (id) => (modal.close(), openTask(id)))),
    panel.el,
  );
  const d = dialog('kb-issue-window', it.title, body, h('footer', {}, h('span.grow'), task));
  const paint = () => {
    chips.replaceChildren(
      h('span.kb-chip', {}, SOURCE_KIND_NAMES[it.source]),
      it.status ? h('span.kb-chip.status', {}, it.status) : '',
      it.assignee ? h('span.kb-chip', {}, `👤 ${it.assignee}`) : '',
      it.epic ? h('span.kb-chip', {}, `🧭 ${it.epic}`) : '',
      ...it.labels.slice(0, 8).map((l) => h('span.kb-chip.tag', {}, l)),
      it.updatedAt ? h('small.kb-muted', {}, `updated ${timeAgo(it.updatedAt)}`) : '',
    );
    task.textContent = it.taskId ? `↗ #${it.taskId}` : '＋ Create task';
    task.title = it.taskId ? 'Open the kanban task made from it' : 'Make a kanban task of it';
    panel.update(actionIssue(it));
  };
  task.addEventListener('click', async () => {
    if (it.taskId) {
      modal.close();
      return openTask(it.taskId);
    }
    const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.issues.createTask', project: projectId, issueKey: it.key }), task, 'Task created');
    if (ok?.taskId) {
      it = { ...it, taskId: ok.taskId };
      paint();
    }
  });
  const off = api.on((msg) => {
    if (msg.t !== 'kanban.issues' || msg.project !== projectId) return;
    const fresh = msg.items.find((i) => i.key === it.key);
    if (!fresh) return;
    it = { ...fresh, taskId: fresh.taskId ?? it.taskId };
    paint();
  });
  const modal = showDialog(d, { onClose: () => off() });
  paint();
}

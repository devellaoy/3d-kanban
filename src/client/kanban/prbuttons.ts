// The buttons that send an agent to a task's open pull requests (🛠️ Fix PRs, 🔄 Resolve conflicts),
// shared by the task view's action bar and its PRs tab.

import { h, toast } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import type { KanbanPrLink, KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { canFixPrs, openPrs, prStatusOk, type PrMode } from '../../shared/kanban/prs.js';
import type { KanbanApi } from './api';
import { openFindWindow } from './prfind';
import { foundToasts } from './prfindmodel';
import { run } from './ui';

type Req = (msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: string) => unknown;

/** Only where there are open PRs to work on, greyed out (with why) while the task is busy. */
export function prActionButtons(task: KanbanTask, bar: HTMLElement, req: Req): void {
  if (!openPrs(task).length || !prStatusOk(task.status)) return;
  const can = canFixPrs(task);
  const add = (mode: Exclude<PrMode, 'create'>, label: string, title: string, focus: string) => {
    const b = h('button.btn', { type: 'button', disabled: !can.ok, title: can.ok ? title : can.reason, 'data-focus': focus }, label) as HTMLButtonElement;
    b.addEventListener('click', () => void req({ t: 'kanban.task.pr', id: task.id, mode }, b, 'An agent is on the pull requests'));
    bar.append(b);
  };
  add('fix', '🛠️ Fix PRs', 'The agent addresses the review comments and failing checks on the task’s open PRs; it doesn’t merge', 'act-fix-prs');
  add('conflicts', '🔄 Resolve conflicts', 'The agent merges each open PR’s target branch into its branch, resolves any conflicts and pushes; it doesn’t merge', 'act-resolve-conflicts');
}

/** Tasks being searched, kept here because the PRs tab is drawn anew on every update: its button stays off meanwhile. */
const finding = new Set<number>();

/** 🔎 Find PRs: links the PRs of the task's branches, asks about the ones that only mention its ticket. Not for an archived task. */
export function findPrsButton(task: KanbanTask, api: KanbanApi): HTMLButtonElement | null {
  if (task.status === 'archived') return null;
  const b = h('button.btn', { type: 'button', disabled: finding.has(task.id), title: 'Look for this task’s pull requests by its branches and ticket, and link them here' }, '🔎 Find PRs') as HTMLButtonElement;
  b.addEventListener('click', async () => {
    finding.add(task.id);
    document.querySelectorAll<HTMLButtonElement>('button.kb-find-prs').forEach((x) => (x.disabled = true));
    const found = await run(() => api.request<Extract<KanbanServerMsg, { t: 'kanban.prFound' }>>({ t: 'kanban.pr.find', project: task.project, taskId: task.id }));
    finding.delete(task.id);
    document.querySelectorAll<HTMLButtonElement>('button.kb-find-prs').forEach((x) => (x.disabled = false));
    if (!found) return;
    for (const t of foundToasts(found)) toast(t.text, t.kind);
    if (found.candidates.length) openFindWindow(api, task.project, task.id, task.ticket, found.candidates);
  });
  b.classList.add('kb-find-prs');
  return b;
}

/** The ✕ at the end of a PR's row: takes the link off the task (only for a PR with its repository known). */
export function unlinkButton(task: KanbanTask, p: KanbanPrLink, req: Req): HTMLElement | string {
  if (!p.repo) return '';
  const b = h('button.btn.small.kb-unlink', { type: 'button', title: 'Unlink this pull request from the task' }, '✕') as HTMLButtonElement;
  const name = `${p.repo}#${p.number}`;
  b.addEventListener('click', () => confirmDialog(`Unlink ${name}?`, 'The pull request itself is not touched. 🔎 Find PRs can link it again.', 'Unlink', () => void req({ t: 'kanban.pr.unlink', project: task.project, taskId: task.id, repo: p.repo!, number: p.number }, b, 'Unlinked')));
  return b;
}

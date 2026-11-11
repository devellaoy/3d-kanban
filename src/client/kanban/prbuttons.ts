// The buttons that send an agent to a task's open pull requests (🛠️ Fix PRs, 🔄 Resolve conflicts),
// shared by the task view's action bar and its PRs tab.

import { h, toast } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import type { KanbanPrLink, KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { canFixPrs, type PrMode } from '../../shared/kanban/prs.js';
import type { KanbanApi } from './api';
import { openFindWindow } from './prfind';
import { foundToasts, goneToast } from './prfindmodel';
import { run } from './ui';

type Req = (msg: Parameters<KanbanApi['request']>[0], button?: HTMLButtonElement, done?: string) => unknown;

/**
 * One of the two buttons that send the agent to the open PRs, greyed out (with why) while the task is
 * busy. Whether the task offers it at all is taskactions.ts's.
 */
export function prModeButton(task: KanbanTask, id: 'fix-prs' | 'resolve-conflicts', req: Req): HTMLButtonElement {
  const can = canFixPrs(task);
  const mode: Exclude<PrMode, 'create'> = id === 'fix-prs' ? 'fix' : 'conflicts';
  const [label, title] =
    id === 'fix-prs'
      ? ['🛠️ Fix PRs', 'The agent addresses the review comments and failing checks on the task’s open PRs; it doesn’t merge']
      : ['🔄 Resolve conflicts', 'The agent merges each open PR’s target branch into its branch, resolves any conflicts and pushes; it doesn’t merge'];
  const b = h('button.btn', { type: 'button', disabled: !can.ok, title: can.ok ? title : can.reason, 'data-focus': `act-${id}` }, label) as HTMLButtonElement;
  b.addEventListener('click', () => void req({ t: 'kanban.task.pr', id: task.id, mode }, b, 'An agent is on the pull requests'));
  return b;
}

/** Tasks being searched, kept here because the PRs tab is drawn anew on every update: its button stays off meanwhile. */
const finding = new Set<number>();

/** 🔎 Find PRs: links the PRs of the task's branches, asks about the ones that only mention its ticket. Not for an archived task. */
export function findPrsButton(task: KanbanTask, api: KanbanApi): HTMLButtonElement | null {
  if (task.status === 'archived') return null;
  const b = h('button.btn', { type: 'button', disabled: finding.has(task.id), title: 'Look for this task’s pull requests by its branches and ticket, and link them here', 'data-task': String(task.id), 'data-focus': 'act-find-prs' }, '🔎 Find PRs') as HTMLButtonElement;
  // Only this task's buttons (the view may be mounted twice, and the tab is redrawn on updates).
  const mine = () => document.querySelectorAll<HTMLButtonElement>(`button.kb-find-prs[data-task="${task.id}"]`);
  b.addEventListener('click', async () => {
    finding.add(task.id);
    mine().forEach((x) => (x.disabled = true));
    const found = await run(() => api.request<Extract<KanbanServerMsg, { t: 'kanban.prFound' }>>({ t: 'kanban.pr.find', project: task.project, taskId: task.id }));
    finding.delete(task.id);
    mine().forEach((x) => (x.disabled = false));
    if (!found) return;
    // The reply may come after the task view was closed or switched to another task: then no window opens over it.
    const shown = mine().length > 0;
    for (const t of foundToasts(found, shown ? undefined : task.id)) toast(t.text, t.kind);
    if (!found.candidates.length) return;
    if (shown) openFindWindow(api, task, found.candidates);
    else toast(goneToast(task.id, found.candidates.length));
  });
  b.classList.add('kb-find-prs');
  return b;
}

/** The ✕ at the end of a PR's row: takes the link off the task, by its repoId (older links have no repo). `name`: the repository as the PRs table shows it. */
export function unlinkButton(task: KanbanTask, p: KanbanPrLink, req: Req, name?: string): HTMLElement {
  const b = h('button.btn.small.kb-unlink', { type: 'button', title: 'Unlink this pull request from the task' }, '✕') as HTMLButtonElement;
  const what = `${p.repo ?? name ?? ''}#${p.number}`;
  b.addEventListener('click', () => confirmDialog(`Unlink ${what}?`, 'The pull request itself is not touched. 🔎 Find PRs can link it again.', 'Unlink', () => void req({ t: 'kanban.pr.unlink', project: task.project, taskId: task.id, repoId: p.repoId, ...(p.repo ? { repo: p.repo } : {}), number: p.number }, b, 'Unlinked')));
  return b;
}

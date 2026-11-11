// The task view's PRs tab: the buttons that work on the task's pull requests and the table of them
// (taskview.ts). Which buttons show is taskactions.ts's.

import { h, timeAgo } from '../ui/dom';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { prTone } from './model';
import { PR_STATE_NAMES } from './labels';
import { unlinkButton } from './prbuttons';
import { actionButton, actionsAt } from './taskactionbar';
import type { TaskCtx } from './taskctx';

export function prsPane(c: TaskCtx, task: KanbanTask): HTMLElement[] {
  const project = c.project(task.project);
  const out: HTMLElement[] = [];
  const bar = h('div.kb-actions');
  for (const id of actionsAt('prs', task, c)) {
    if (id === 'review-prs') bar.append(reviewButton(c, task));
    else bar.append(actionButton(id, task, c) ?? '');
  }
  if (bar.childElementCount) out.push(bar);
  if (!task.prs.length) out.push(h('p.kb-muted', {}, 'No pull requests yet.'));
  else
    out.push(
      h(
        'table.kb-table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', {}, 'PR'), h('th', {}, 'State'), h('th', {}, 'Branch'), h('th', {}, 'Updated'), h('th'))),
        h(
          'tbody',
          {},
          ...task.prs.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId),
              h('td', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, `#${p.number} ↗`)),
              h('td', {}, h('span.kb-pr', { class: prTone(p.state) }, PR_STATE_NAMES[prTone(p.state)])),
              h('td', {}, p.branch ? h('code', {}, p.branch) : ''),
              h('td', {}, timeAgo(p.updatedAt)),
              h('td', {}, unlinkButton(task, p, (m, b, d) => c.req(m, b, d), project?.repos.find((r) => r.id === p.repoId)?.name)),
            ),
          ),
        ),
      ),
    );
  return out;
}

/** One reviewer takes every open pull request of the task at once. */
function reviewButton(c: TaskCtx, task: KanbanTask): HTMLButtonElement {
  const reviewable = task.prs.filter((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT'));
  const rev = h('button.btn', { type: 'button', title: 'One reviewer takes every pull request of the task at once', 'data-focus': 'act-review-prs' }, `🔍 Review these ${reviewable.length} PRs together`) as HTMLButtonElement;
  rev.addEventListener('click', async () => {
    const ok = await c.req({ t: 'kanban.pr.review', project: task.project, taskId: task.id, prs: reviewable.map((p) => ({ repo: p.repo!, number: p.number })) }, rev, 'A reviewer takes the PRs together');
    // The review runs as a task: another one than this, when the office made a new one.
    if (ok?.taskId && ok.taskId !== task.id) c.openTask(ok.taskId);
  });
  return rev;
}

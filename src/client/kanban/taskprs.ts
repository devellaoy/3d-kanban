// The task view's Pull requests tab: the buttons that work on the task's pull requests (fix them, resolve
// their conflicts, fetch their review comments, find them, review them together), the table of them with their review marks
// (taskview.ts, prmarks.ts) and, under it, the review comments the implementer fetched (taskprcomments.ts). Creating and
// pushing them is the footer's button. Which buttons show is taskactions.ts's.

import { h, timeAgo, toast } from '../ui/dom';
import { openPullHere } from '../ui/github/open-pull';
import { openSafe } from '../ui/url';
import { store } from '../state';
import { hostLabel, hostOfUrl } from '../../shared/hosting/remote.js';
import { icon } from '../ui/icons';
import { btn, prPill } from '../ui/kit';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { prMarkPills } from './prmarks';
import { unlinkButton } from './prbuttons';
import { actionButton, tabActionIds } from './taskactionbar';
import type { TaskCtx } from './taskctx';
import type { PrComments } from './taskprcomments';

export function prsPane(c: TaskCtx, task: KanbanTask, comments: PrComments): HTMLElement[] {
  const project = c.project(task.project);
  const repoName = (p: Pick<KanbanTask['prs'][number], 'repo' | 'repoId'>) => project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId;
  const out: HTMLElement[] = [];
  const bar = h('div.kb-actions');
  // Create / Push & update PRs are the footer's; what needs a pull request to look at is here.
  for (const id of tabActionIds(task, c)) {
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', {}, 'PR'), h('th', {}, 'State'), h('th', {}, 'Review'), h('th', {}, 'Branch'), h('th', {}, 'Updated'), h('th'))),
        h(
          'tbody',
          {},
          ...task.prs.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, h('button.kb-pr-open', { type: 'button', title: 'Open the pull request in the office’s pull request window (on its host when it is not on this floor’s pull request board)', onclick: () => openPr(c, task, p) }, repoName(p))),
              h('td', {}, h('a.kb-pr-link', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, `#${p.number}`, icon('external-link', { size: 12 }))),
              h('td', {}, prPill(p.state)),
              h('td.kb-pr-review', {}, ...prMarkPills(p)),
              h('td', {}, p.branch ? h('code', {}, p.branch) : ''),
              h('td', {}, timeAgo(p.updatedAt)),
              h('td', {}, unlinkButton(task, p, (m, b, d) => c.req(m, b, d), project?.repos.find((r) => r.id === p.repoId)?.name)),
            ),
          ),
        ),
      ),
    );
  const list = comments.section(task, repoName);
  if (list) out.push(list);
  return out;
}

/** The repository name's click: the office's pull request window when the PR is on this floor's board (checked now, the board changes), else its host. */
function openPr(c: TaskCtx, task: KanbanTask, p: KanbanTask['prs'][number]): void {
  // The floor's board has not been read yet: not the same as the PR not being on it.
  if (store.floor === task.project && store.pulls.loading && !store.pulls.fetchedAt) return void toast('The pull requests are still loading: try again in a moment', 'warn');
  if (openPullHere(c.o.net, p, task.project)) return;
  openSafe(p.url);
  toast(`That pull request is not on this floor’s pull request board, so it opened on ${hostLabel(hostOfUrl(p.url) ?? 'github')}`);
}

/** One reviewer takes every open pull request of the task at once. */
function reviewButton(c: TaskCtx, task: KanbanTask): HTMLButtonElement {
  const reviewable = task.prs.filter((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT'));
  const rev = btn(`Review these ${reviewable.length} PRs together`, { icon: 'eye', attrs: { title: 'One reviewer takes the task’s open and draft pull requests together; the office may make the review a task of its own', 'data-focus': 'act-review-prs' } });
  rev.addEventListener('click', async () => {
    const ok = await c.req({ t: 'kanban.pr.review', project: task.project, taskId: task.id, prs: reviewable.map((p) => ({ repo: p.repo!, number: p.number })) }, rev, 'A reviewer takes the PRs together');
    // The review runs as a task: another one than this, when the office made a new one.
    if (ok?.taskId && ok.taskId !== task.id) c.openTask(ok.taskId);
  });
  return rev;
}

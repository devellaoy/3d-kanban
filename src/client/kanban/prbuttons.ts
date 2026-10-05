// The buttons that send an agent to a task's open pull requests (🛠️ Fix PRs, 🔄 Resolve conflicts),
// shared by the task view's action bar and its PRs tab.

import { h } from '../ui/dom';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { canFixPrs, openPrs, prStatusOk, type PrMode } from '../../shared/kanban/prs.js';
import type { KanbanApi } from './api';

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

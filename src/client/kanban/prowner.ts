// The PR window's "🛠️ Fix via task #N": when a kanban task owns the pull request, its agent can be
// sent to fix the review comments and failing checks on all the task's open PRs (kanban.pr.owner
// says who owns it and whether that works now; the click is the task view's own kanban.task.pr).

import { btn } from '../ui/kit';
import type { Net } from '../net';
import { store } from '../state';
import type { GhPull } from '../../shared/protocol';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { kanbanApi, type KanbanOk } from './api';
import { repoOfItem } from './boardrepos';
import { run } from './ui';

type OwnerMsg = Extract<KanbanServerMsg, { t: 'kanban.pr.owner' }>;

/** The button (kept between redraws of the window's footer; null until a task is found) and the lookup, on open and on reload. */
export function prOwner(net: Net, pull: () => GhPull) {
  const api = kanbanApi(net);
  let button: HTMLButtonElement | null = null;
  let taskId: number | null = null;
  let generation = 0;
  return {
    button: () => button,
    /** The task that owns the pull request, once that is known. */
    taskId: () => taskId,
    load(redraw: () => void) {
      const project = store.floor;
      const repo = repoOfItem(pull());
      if (!project || !repo) return;
      const g = ++generation;
      api
        .request<OwnerMsg>({ t: 'kanban.pr.owner', project, repo, number: pull().number })
        .then((o) => {
          if (g !== generation) return;
          const id = o.taskId;
          taskId = id;
          if (id === null) return void (button = null);
          button = btn(`Fix via task #${id}`, { icon: 'square-kanban', size: 'md', attrs: { disabled: !o.fixable, title: o.fixable ? `Task #${id}'s agent addresses the review comments and failing checks on all of the task's open PRs; it doesn't merge` : o.reason } });
          button.addEventListener('click', async () => {
            if (!(await run(() => api.request<KanbanOk>({ t: 'kanban.task.pr', id, mode: 'fix' }), button, `Task #${id}'s agent is on the PR`)) || !button) return;
            button.disabled = true;
            button.title = `Task #${id}'s agent is on it`;
          });
        })
        .catch(() => {
          if (g === generation) button = taskId = null;
        })
        .finally(() => g === generation && redraw());
    },
  };
}

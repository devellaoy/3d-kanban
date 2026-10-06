// The 🔎 button of the 3D office's (and /lite's) 📌 Issues board: browse every issue of the floor's
// project (browse.ts, the kanban page's window) and open one as the board's own card window. Only the
// button is built here; it stays out of sight until the office says the project has a source that can
// be browsed. Lite loads this too: nothing from the 3D world.

import type { Net } from '../net';
import { store } from '../state';
import type { BoardActions } from '../ui/github/prompts';
import { h, toast } from '../ui/dom';
import { toGhIssue } from '../../shared/kanban/issuecard.js';
import type { BrowseIssue, BrowseScope } from '../../shared/kanban/browse.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { kanbanApi } from './api';
import { openBrowse } from './browse';
import { openCard } from './issuecards';

/** The GitHub repositories (owner/name) of the floor's project: the project's own list, plus the floor's primary one. */
function projectRepos(): string[] {
  const primary = store.currentFloor()?.repo;
  return [...(store.pulls.repos ?? []), ...(primary ? [primary] : [])];
}

type Scopes = Extract<KanbanServerMsg, { t: 'kanban.browseScopes' }>;
/** How long the office's answer about a floor's browsable sources is reused when the board is opened again. */
const SCOPES_MS = 60_000;
const scopesSeen = new Map<string, { at: number; usable: boolean }>();

/** The 🔎 button for the issues board header, or null on a floor with no project. */
export function browseButton(net: Net, actions: BoardActions): HTMLElement | null {
  const project = store.floor;
  if (!project) return null;
  const api = kanbanApi(net);
  const button = h('button.btn.hidden', { type: 'button', title: 'Browse every issue of the project’s Jira or GitHub board, with filters' }, '🔎 Browse') as HTMLButtonElement;
  const seen = scopesSeen.get(project);
  if (seen && Date.now() - seen.at < SCOPES_MS) button.classList.toggle('hidden', !seen.usable);
  else
    api.request<Scopes>({ t: 'kanban.browse.scopes', project }).then(
      (m) => {
        const usable = m.scopes.some((s) => !s.disabled);
        scopesSeen.set(project, { at: Date.now(), usable });
        button.classList.toggle('hidden', !usable);
      },
      () => {},
    );
  const open = (issue: BrowseIssue, scope: BrowseScope) => {
    const load = () => api.request<Extract<KanbanServerMsg, { t: 'kanban.browseIssue' }>>({ t: 'kanban.browse.issue', project, scope: scope.id, issueKey: issue.key }).then((m) => m.issue);
    const card = (i: BrowseIssue) => toGhIssue({ ...i, sourceId: i.sourceId ?? scope.id }, i.taskId, projectRepos());
    load().then(
      (full) => openCard(card(full), net, actions, { reload: () => load().then(card, () => undefined) }),
      (err: Error) => toast(err.message, 'error'),
    );
  };
  button.addEventListener('click', () => openBrowse(api, project, { open, openTask: (id) => void import('./taskview').then((m) => m.openTaskWindow(net, id)) }));
  return button;
}

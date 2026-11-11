// A project's issues from its issue sources (GitHub repositories, a GitHub Projects board, Jira), in
// one list: filter chips by source, status, label and assignee, a refresh, and "Create task" on each
// (idempotent by the issue's key: an issue already made into a task opens that task instead). Its title
// opens the issue's own window (issuewindow.ts).
//
// The same window is the 🔗 Select issue picker of the new-task form and the hire dialogs (`pick`): its
// rows then hand the issue back instead of making a task, and one that already has a task can't be
// picked. The hire dialogs open it in the 3D office and /lite, so it brings its own styles and asks for
// the project's deltas itself.

import './issues.css';
import { h, timeAgo, toast, type Modal } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { filterIssues } from './model';
import { kstore } from './store';
import { openIssueWindow } from './issuewindow';
import { openBrowse } from './browse';
import type { BrowseIssue, BrowseScope } from '../../shared/kanban/browse.js';
import { SOURCE_KIND_NAMES } from './labels';
import { dialog, run, select, showDialog, textInput } from './ui';

type IssuesMsg = Extract<KanbanServerMsg, { t: 'kanban.issues' }>;

export interface IssuesOpts {
  /** Picking one for a task being written: the rows say Select, and nothing is made here. */
  pick?(issue: NormalizedIssue): void;
  /** The window closed, picked or not. */
  onClose?(): void;
}

/** The picker: `pick` gets the chosen issue once the window has closed, `onClose` hears every close. */
export function openIssuePicker(api: KanbanApi, projectId: string, pick: (issue: NormalizedIssue) => void, onClose?: () => void) {
  openIssues(api, projectId, () => {}, { pick, onClose });
}

export function openIssues(api: KanbanApi, projectId: string, openTask: (id: number) => void, opts: IssuesOpts = {}) {
  // Empty in the 3D office and /lite, where nothing fills the kanban page's store: the id stands in.
  const project = kstore.projectOf(projectId);
  const picking = opts.pick;
  let state: IssuesMsg | null = null;
  let error = '';
  const f = { q: '', source: '', status: '', label: '', assignee: '' };

  const search = textInput('', { type: 'search', placeholder: 'Search the issues', 'aria-label': 'Search the issues' });
  const chips = h('div.kb-issue-chips', { role: 'group', 'aria-label': 'Filters' });
  const list = h('ul.kb-issues', { 'aria-live': 'polite' });
  const status = h('span.kb-muted');
  const refresh = h('button.btn', { type: 'button', title: 'Fetch them again from the sources' }, '🔄 Refresh') as HTMLButtonElement;
  const browse = h('button.btn', { type: 'button', title: 'Every issue of the Jira project or GitHub board, in a tree with filters' }, '🔎 Browse all') as HTMLButtonElement;
  const d = dialog('kb-issues-window', `${picking ? '🔗 Select issue' : '📌 Issues'} · ${project?.name ?? projectId}`, h('div.body', {}, h('div.kb-row', {}, search, status), chips, list), null, [refresh]);
  // The finished list is only broadcast to connections that follow the project: the kanban page does,
  // the 3D office and /lite do while this watch stands.
  const unwatch = api.watch(projectId);
  let closed = false;
  const modal = showDialog(d, {
    onClose: () => {
      closed = true;
      off();
      unwatch();
      opts.onClose?.();
    },
  });
  const choose = (issue: NormalizedIssue) => {
    modal.close();
    picking?.(issue);
  };

  const chipSelect = (key: keyof typeof f, label: string, values: string[]) => {
    if (values.length < 2 && !f[key]) return null;
    const sel = select<string>([['', `${label}: all`], ...values.map((v) => [v, v] as const)], f[key], { 'aria-label': label });
    sel.addEventListener('change', () => {
      f[key] = sel.value;
      paint();
    });
    return sel;
  };

  const paint = () => {
    const items = state?.items ?? [];
    status.textContent = state?.loading ? 'Refreshing…' : state?.fetchedAt ? `Updated ${timeAgo(state.fetchedAt)}` : '';
    const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
    chips.replaceChildren(
      ...[
        chipSelect('source', 'Source', uniq(items.map((i) => i.source))),
        chipSelect('status', 'State', uniq(items.map((i) => i.status))),
        chipSelect('label', 'Label', uniq(items.flatMap((i) => i.labels))),
        chipSelect('assignee', 'Assignee', uniq(items.map((i) => i.assignee))),
      ].filter((x): x is HTMLSelectElement => !!x),
    );
    const shown = filterIssues(items, f);
    list.replaceChildren(...shown.map(issueRow));
    if (error || state?.error) list.prepend(h('li.kb-error', {}, `⚠️ ${error || state?.error}`));
    if (!shown.length && !error && !state?.error) list.append(h('li.kb-muted', {}, !state ? 'Loading…' : items.length ? 'Nothing matches the filters' : 'No issues: add an issue source in ⚙️ Settings → Issue sources.'));
  };

  const issueRow = (i: NormalizedIssue) => {
    let make: HTMLElement;
    if (picking) {
      make = i.taskId ? h('span.kb-issue-taken', { title: 'One task per issue' }, `already task #${i.taskId}`) : h('button.btn.small.primary', { type: 'button', onclick: () => choose(i) }, 'Select');
    } else {
      const button = (make = h('button.btn.small.primary', { type: 'button' }, i.taskId ? `↗ #${i.taskId}` : '＋ Create task')) as HTMLButtonElement;
      button.addEventListener('click', async () => {
        if (i.taskId) {
          modal.close();
          return openTask(i.taskId);
        }
        const ok = await run(() => api.request<KanbanOk>({ t: 'kanban.issues.createTask', project: projectId, issueKey: i.key }), button, 'Task created');
        if (ok?.taskId) {
          i.taskId = ok.taskId;
          paint();
        }
      });
    }
    // Picking, the title is only text: the issue's own window makes tasks, which isn't what is asked here.
    const title = picking ? h('span.kb-issue-title', {}, i.title) : h('button.kb-issue-title.kb-issue-open', { type: 'button', title: 'Open it: status, assignee and comments', onclick: () => openIssueWindow(api, projectId, i, (id) => (modal.close(), openTask(id))) }, i.title);
    return h(
      `li.kb-issue${picking && i.taskId ? '.taken' : ''}`,
      {},
      h(
        'div.kb-issue-main',
        {},
        h('a.kb-issue-key', { href: i.url, target: '_blank', rel: 'noopener noreferrer' }, i.key),
        title,
        h(
          'span.kb-chips',
          {},
          h('span.kb-chip', {}, SOURCE_KIND_NAMES[i.source]),
          i.status ? h('span.kb-chip.status', {}, i.status) : null,
          i.assignee ? h('span.kb-chip', {}, `👤 ${i.assignee}`) : null,
          i.epic ? h('span.kb-chip', {}, `🧭 ${i.epic}`) : null,
          ...i.labels.slice(0, 5).map((l) => h('span.kb-chip.tag', {}, l)),
          h('small.kb-muted', {}, timeAgo(i.updatedAt)),
        ),
      ),
      make,
    );
  };

  const off = api.on((msg) => {
    if (msg.t !== 'kanban.issues' || msg.project !== projectId) return;
    state = msg;
    error = '';
    paint();
  });
  search.addEventListener('input', () => {
    f.q = search.value;
    paint();
  });
  // Only a project with a source that can be browsed has the button.
  api.request<Extract<KanbanServerMsg, { t: 'kanban.browseScopes' }>>({ t: 'kanban.browse.scopes', project: projectId }).then(
    (m) => m.scopes.some((s) => !s.disabled) && refresh.before(browse),
    () => {},
  );
  const openFull = (issue: BrowseIssue, scope: BrowseScope) => {
    const load = () => api.request<Extract<KanbanServerMsg, { t: 'kanban.browseIssue' }>>({ t: 'kanban.browse.issue', project: projectId, scope: scope.id, issueKey: issue.key }).then((m) => m.issue);
    load().then(
      (full) => {
        if (!picking) return openIssueWindow(api, projectId, full, openTaskClosing, { reload: () => load().catch(() => undefined) });
        if (full.taskId) return void toast(`${full.key} is already task #${full.taskId}`, 'warn');
        browsing?.close();
        choose({ ...full, sourceId: full.sourceId ?? scope.id });
      },
      (err: Error) => toast(err.message, 'error'),
    );
  };
  const openTaskClosing = (id: number) => (modal.close(), openTask(id));
  let browsing: Modal | undefined;
  browse.addEventListener('click', () => {
    browsing = openBrowse(api, projectId, { open: openFull, openTask: picking ? (id) => void toast(`It is already task #${id}`, 'warn') : openTaskClosing });
  });
  const fetchAgain = () => api.request<IssuesMsg>({ t: 'kanban.issues.refresh', project: projectId });
  refresh.addEventListener('click', () => void run(fetchAgain, refresh));
  paint();
  api.request<IssuesMsg>({ t: 'kanban.issues.list', project: projectId }).then(
    (m) => {
      // A fetch is under way and its list goes out as a broadcast, which a watch riding on a page's own
      // filter for another project never gets: wait for that fetch here as well (the office runs one at a time).
      if (m.loading && !closed) fetchAgain().catch(() => {});
    },
    (err: Error) => {
      error = err.message;
      paint();
    },
  );
}

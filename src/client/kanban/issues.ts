// A project's issues from its issue sources (GitHub repositories, a GitHub Projects board, Jira), in
// one list: filter chips by source, status, label and assignee, a refresh, and "Create task" on each
// (idempotent by the issue's key: an issue already made into a task opens that task instead). Its title
// opens the issue's own window (issuewindow.ts). A Jira issue says its type, and a Jira sub-task sits
// under its parent (issuesgroup.ts): under the parent's own row, or under a low header when the parent
// isn't in the list.
//
// The same window is the Select issue picker of the new-task form and the hire dialogs (`pick`): its
// rows then hand the issue back instead of making a task, and one that already has a task can't be
// picked. The hire dialogs open it in the 3D office and /lite, so it brings its own styles and asks for
// the project's deltas itself.

import './issues.css';
import { h, timeAgo, toast, type Modal } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import { btn } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { IssueParent, NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { filterIssues } from './model';
import { groupIssueRows } from './issuesgroup';
import { kstore } from './store';
import { openIssueWindow } from './issuewindow';
import { openBrowse } from './browse';
import type { BrowseIssue, BrowseScope } from '../../shared/kanban/browse.js';
import { SOURCE_KIND_NAMES } from './labels';
import { run, select, textInput } from './ui';

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
  const chips = h('div.kb-issues-chips', { role: 'group', 'aria-label': 'Filters' });
  const list = h('div.kb-issues-list', { 'aria-live': 'polite' });
  const summary = h('span');
  const status = h('span');
  const refresh = iconButton('refresh-cw', 'Refresh', { title: 'Refresh: fetch them again from the sources' });
  const browse = btn('Browse all', { kind: 'quiet', size: 'sm', icon: 'list-filter', attrs: { title: 'Every issue of the Jira project or GitHub board, in a tree with filters' } });
  const shell = modalShell({
    cls: 'kb-issues-win w920',
    icon: picking ? 'link' : 'circle-dot',
    title: picking ? 'Select issue' : 'Issues',
    id: h('span.kb-issues-project', {}, project?.name ?? projectId),
    tools: [refresh, h('span.shell-sep', { 'aria-hidden': 'true' })],
    body: [h('div.kb-issues-bar', {}, h('label.kb-issues-search', {}, icon('search', { size: 14 }), search), chips), list],
    footerLeft: [summary],
    footerRight: [status],
  });
  // The finished list is only broadcast to connections that follow the project: the kanban page does,
  // the 3D office and /lite do while this watch stands.
  const unwatch = api.watch(projectId);
  let closed = false;
  const modal = openShell(shell, {
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

  /** A filter drawn as a chip over its native select: the name, what is picked and a chevron. */
  const chipSelect = (key: keyof typeof f, label: string, values: string[]) => {
    if (values.length < 2 && !f[key]) return null;
    const sel = select<string>([['', 'All'], ...values.map((v) => [v, v] as const)], f[key], { 'aria-label': label });
    sel.addEventListener('change', () => {
      f[key] = sel.value;
      paint();
    });
    return h('label.filter-chip', { class: f[key] ? 'on' : '' }, h('span.filter-chip-label', {}, label), f[key] || 'All', icon('chevron-down', { size: 14 }), sel);
  };

  const paint = () => {
    const items = state?.items ?? [];
    status.textContent = state?.loading ? 'Refreshing…' : state?.fetchedAt ? `Updated ${timeAgo(state.fetchedAt)}` : '';
    const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
    // A chip that has the keyboard keeps it: the chips are drawn again around what was picked.
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('.kb-issues-chips') ? (document.activeElement as HTMLElement).getAttribute('aria-label') : null;
    chips.replaceChildren(
      ...[
        chipSelect('source', 'Source', uniq(items.map((i) => i.source))),
        chipSelect('status', 'State', uniq(items.map((i) => i.status))),
        chipSelect('label', 'Label', uniq(items.flatMap((i) => i.labels))),
        chipSelect('assignee', 'Assignee', uniq(items.map((i) => i.assignee))),
      ].filter((x): x is HTMLLabelElement => !!x),
    );
    if (focused) chips.querySelector<HTMLElement>(`select[aria-label="${focused}"]`)?.focus();
    const shown = filterIssues(items, f);
    summary.textContent = !state ? '' : shown.length === items.length ? `${items.length} issue${items.length === 1 ? '' : 's'}` : `${shown.length} of ${items.length} issues`;
    // The headers of parents that aren't shown are no issues: the count above is of `shown`.
    list.replaceChildren(...groupIssueRows(shown).map((r) => (r.kind === 'parent' ? parentRow(r.parent) : issueRow(r.issue, r.sub))));
    if (error || state?.error) list.prepend(h('p.kb-issues-error', { role: 'alert' }, icon('triangle-alert', { size: 14 }), error || state?.error || ''));
    if (!shown.length && !error && !state?.error) list.append(h('p.kb-issues-none', {}, !state ? 'Loading…' : items.length ? 'Nothing matches the filters' : 'No issues: add an issue source in Settings → Issue sources.'));
  };

  /** Jira's type of an issue; GitHub's rows have none. */
  const typeChip = (type: string | undefined) => (type ? h('span.kb-chip.type', {}, type) : null);

  /** A parent that isn't in the list, as a low header over its sub-tasks: nothing can be done to it from here. */
  const parentRow = (p: IssueParent) =>
    h(
      'div.kb-issue-group',
      { title: 'Not in this list: shown for its sub-tasks' },
      typeChip(p.type),
      h('span.kb-issue-group-key', {}, p.key),
      h('span.kb-issue-group-title', {}, p.title),
      h('span.kb-issue-sr', {}, '(not in this list: shown for its sub-tasks)'),
    );

  /** `sub`: a sub-task under its parent, the row or the header above it. */
  const issueRow = (i: NormalizedIssue, sub: boolean) => {
    let make: HTMLElement;
    if (picking) {
      make = i.taskId ? h('span.kb-issue-taken', { title: 'One task per issue' }, `Already task #${i.taskId}`) : btn('Select', { size: 'sm', attrs: { onclick: () => choose(i) } });
    } else if (i.taskId) {
      const id = i.taskId;
      make = h('button.link-btn.kb-issue-task', { type: 'button', title: 'Open the kanban task made from it', onclick: () => (modal.close(), openTask(id)) }, `Task #${id}`, icon('chevron-right', { size: 14 }));
    } else {
      const button = (make = btn('Create task', { size: 'sm', icon: 'plus' }));
      button.addEventListener('click', async () => {
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
      `div.kb-issue-row${sub ? '.sub' : ''}${picking && i.taskId ? '.taken' : ''}`,
      {},
      h(
        'div.kb-issue-main',
        {},
        h(
          'div.kb-issue-line',
          {},
          i.source === 'jira' ? typeChip(i.issueType) : null,
          // The indent says it to the eye only.
          sub && i.parent ? h('span.kb-issue-sr', {}, `${i.issueType ? '' : 'Sub-task '}of ${i.parent.key}`) : null,
          h('a.kb-issue-key', { href: i.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, i.key),
          title,
        ),
        h(
          'div.kb-issue-meta',
          {},
          i.status ? h('span.kb-issue-st', {}, i.status) : null,
          h('span', {}, SOURCE_KIND_NAMES[i.source]),
          i.assignee ? h('span.kb-issue-who', {}, icon('user', { size: 13 }), i.assignee) : null,
          i.epic ? h('span.kb-issue-who', {}, icon('signpost', { size: 13 }), i.epic) : null,
          ...i.labels.slice(0, 5).map((l) => h('span.kb-issue-label', {}, l)),
          h('span', {}, timeAgo(i.updatedAt)),
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
    // Only the answer to the latest pick, of the browse window still open, counts: one that comes after
    // that window (or this one) closed, or after another issue was chosen, would swap the choice.
    const mine = ++asked;
    const from = browsing;
    const stale = () => closed || mine !== asked || !from?.backdrop.isConnected;
    load().then(
      (full) => {
        if (stale()) return;
        if (!picking) return openIssueWindow(api, projectId, full, openTaskClosing, { reload: () => load().catch(() => undefined) });
        if (full.taskId) return void toast(`${full.key} is already task #${full.taskId}`, 'warn');
        browsing?.close();
        choose({ ...full, sourceId: full.sourceId ?? scope.id });
      },
      (err: Error) => void (stale() || toast(err.message, 'error')),
    );
  };
  let asked = 0;
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

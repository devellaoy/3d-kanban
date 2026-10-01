// The browse window's tree (browse.ts), built as it is opened: the groups of a source first (Jira's fix
// versions, a GitHub board's iterations or Status options), then a group's issues page by page, and an
// issue's sub-tasks / sub-issues when it is expanded. Jira: version → epic → story → sub-task; an epic
// node loads its own full list. GitHub: group → items (sub-issues already loaded nest) → sub-issues.
// The pure builders are in shared/kanban/browsetree.ts. Counts are asked for only for the rows that
// scroll into view, three at a time. Nothing the office answers lands once the tree is replaced (live()).

import { h } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { BrowseFilters, BrowseGroup, BrowseIssue, BrowseScope } from '../../shared/kanban/browse.js';
import { groupByEpic, groupProjectItems, issueProgress, mergeIssues, progress, type EpicNode, type ItemNode } from '../../shared/kanban/browsetree.js';
import type { KanbanApi } from './api';

type Groups = Extract<KanbanServerMsg, { t: 'kanban.browseGroups' }>;
type Page = Extract<KanbanServerMsg, { t: 'kanban.browsePage' }>;
type Count = Extract<KanbanServerMsg, { t: 'kanban.browseCount' }>;

export interface BrowseTreeOpts {
  api: KanbanApi;
  project: string;
  scope: BrowseScope;
  filters: BrowseFilters;
  /** False once this tree has been replaced (the filters or the scope changed) or the window closed. */
  live(): boolean;
  open(issue: BrowseIssue): void;
  openTask(id: number): void;
  /** Every page of issues that came in (the window collects labels and sprints from them). */
  seen(items: BrowseIssue[]): void;
}

/** How many counts may be asked for at once. */
const COUNTS_IN_FLIGHT = 3;

export function browseTree(o: BrowseTreeOpts): {
  el: HTMLElement;
  destroy(): void;
} {
  const base = { project: o.project, scope: o.scope.id };
  const jira = o.scope.kind === 'jira';
  const ask = <T extends KanbanServerMsg>(msg: Record<string, unknown>) => o.api.request<T>({ ...base, ...msg } as never);

  // ---- Lazy counts ----
  const queue: (() => Promise<void>)[] = [];
  let inFlight = 0;
  const waiting = new Map<Element, () => void>();
  const pump = () => {
    while (inFlight < COUNTS_IN_FLIGHT && queue.length) {
      const job = queue.shift()!;
      inFlight++;
      void job().finally(() => {
        inFlight--;
        pump();
      });
    }
  };
  const seenRows =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            seenRows?.unobserve(e.target);
            waiting.get(e.target)?.();
            waiting.delete(e.target);
          }
        })
      : null;
  /** The count of a group (or an epic in it) into `out`, once `row` is in view. */
  const countWhen = (row: HTMLElement, out: HTMLElement, where: { group?: string; epic?: string }) => {
    const start = () => {
      queue.push(async () => {
        if (!o.live()) return;
        out.textContent = '…';
        out.title = 'Counting…';
        try {
          const a = await ask<Count>({
            t: 'kanban.browse.count',
            filters: o.filters,
            ...where,
          });
          if (!o.live()) return;
          out.textContent = a.count === undefined ? '' : String(a.count);
          out.title = a.count === undefined ? '' : `${jira ? 'About ' : ''}${a.count} issue${a.count === 1 ? '' : 's'}${where.epic ? '' : ' (top level)'}`;
        } catch {
          if (o.live()) out.textContent = '';
        }
      });
      pump();
    };
    if (!seenRows) return start();
    waiting.set(row, start);
    seenRows.observe(row);
  };

  // ---- Building blocks ----
  const errorLine = (msg: string, retry: () => void) => {
    const again = h('button.btn.small', { type: 'button' }, 'Try again');
    again.addEventListener('click', retry);
    return h('div.kb-br-error', { role: 'alert' }, h('span', {}, `⚠️ ${msg}`), again);
  };

  /**
   * Pages of something into `list`, with "Loading…", "Load more" and an error with "Try again" in
   * `tail` (after the list, so a regrouped list keeps it last).
   */
  const paged = <A extends { next?: string }>(tail: HTMLElement, fetch: (cursor?: string) => Promise<A>, take: (a: A) => void, what = 'more') => {
    let cursor: string | undefined;
    let busy = false;
    let complete = false;
    const load = () => {
      if (busy || !o.live()) return;
      busy = true;
      tail.replaceChildren(h('div.kb-br-quiet', {}, 'Loading…'));
      fetch(cursor)
        .then((a) => {
          if (!o.live()) return;
          cursor = a.next;
          complete = !a.next;
          take(a);
          if (!a.next) return tail.replaceChildren();
          const more = h('button.btn.small.kb-br-more', { type: 'button' }, `Load ${what}`);
          more.addEventListener('click', load);
          tail.replaceChildren(more);
        })
        .catch((err: Error) => o.live() && tail.replaceChildren(errorLine(err.message || 'That didn’t load', load)))
        .finally(() => (busy = false));
    };
    return { load, complete: () => complete };
  };

  /** A node of the tree: its row, and under it a list that is filled the first time it opens. */
  const node = (row: HTMLElement, canOpen: boolean, label: string, firstOpen: () => void) => {
    const list = h('ul.kb-br-list');
    const tail = h('div.kb-br-tail');
    const sub = h('div.kb-br-sub', { hidden: true }, list, tail);
    const li = h('li.kb-br-node', {}, row, sub);
    const tog = canOpen
      ? (h(
          'button.kb-br-tog',
          {
            type: 'button',
            'aria-expanded': 'false',
            'aria-label': `Open ${label}`,
            title: 'Open (→) / close (←)',
          },
          '▸',
        ) as HTMLButtonElement)
      : h('span.kb-br-tog.leaf', { 'aria-hidden': 'true' }, '•');
    row.prepend(tog);
    let opened = false;
    const set = (on: boolean) => {
      if (!(tog instanceof HTMLButtonElement)) return;
      sub.hidden = !on;
      tog.setAttribute('aria-expanded', String(on));
      tog.setAttribute('aria-label', `${on ? 'Close' : 'Open'} ${label}`);
      tog.textContent = on ? '▾' : '▸';
      if (on && !opened) {
        opened = true;
        firstOpen();
      }
    };
    tog.addEventListener('click', () => set(!!sub.hidden));
    row.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' && sub.hidden && canOpen) set(true);
      else if (e.key === 'ArrowLeft' && !sub.hidden) set(false);
      else if (e.key === 'ArrowLeft') {
        // Already closed: up to the node it is in.
        e.preventDefault();
        return li.parentElement?.closest('li.kb-br-node')?.querySelector<HTMLElement>(':scope > .kb-br-row .kb-br-tog')?.focus();
      } else return;
      e.preventDefault();
      if (tog instanceof HTMLButtonElement) tog.focus();
    });
    return { li, list, tail, set, isOpen: () => !sub.hidden };
  };

  const statusChip = (status?: string, cat?: string) => (status ? h(`span.kb-chip.status.cat-${cat ?? 'none'}`, { title: `Status: ${status}` }, status) : null);
  const doneChip = (done: number, total: number, partial: boolean) =>
    total
      ? h(
          'span.kb-br-prog',
          {
            title: partial ? `${done} of the ${total} loaded are done` : `${done} of ${total} done`,
          },
          `${done}/${total}${partial ? ' loaded' : ''}`,
        )
      : null;
  const empty = (text: string) => h('li.kb-br-empty', {}, text);

  // ---- An issue ----
  interface IssueView {
    li: HTMLElement;
    update(issue: BrowseIssue, nested: ItemNode[]): void;
  }
  const issueView = (first: BrowseIssue, firstNested: ItemNode[] = []): IssueView => {
    let issue = first;
    let nested = firstNested;
    let fetched: BrowseIssue[] = [];
    const row = h('div.kb-br-row.issue');
    const views = new Map<string, IssueView>();
    let pager: ReturnType<typeof paged<Page>> | null = null;
    const n = node(row, !!(issue.childCount || nested.length), issue.key, () => {
      paintKids();
      if (issue.childCount && nested.length < issue.childCount) {
        pager = paged(
          n.tail,
          (cursor) =>
            ask<Page>({
              t: 'kanban.browse.children',
              issueKey: issue.key,
              ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
              ...(cursor ? { cursor } : {}),
            }),
          (a) => {
            fetched = mergeIssues(fetched, a.items);
            o.seen(a.items);
            paint();
            paintKids();
          },
          jira ? 'more sub-tasks' : 'more sub-issues',
        );
        pager.load();
      }
    });
    const kids = (): ItemNode[] => {
      const all = mergeIssues(
        nested.map((c) => c.issue),
        fetched,
      );
      const deeper = new Map(nested.map((c) => [c.issue.key, c.children]));
      return all.map((i) => ({
        issue: i,
        children: deeper.get(i.key) ?? [],
        ...progress([]),
      }));
    };
    const paintKids = () => {
      const list = kids();
      for (const k of list) {
        let v = views.get(k.issue.key);
        if (!v) views.set(k.issue.key, (v = issueView(k.issue, k.children)));
        else v.update(k.issue, k.children);
        n.list.append(v.li);
      }
      if (!list.length && (pager?.complete() ?? !issue.childCount)) n.list.replaceChildren(empty(jira ? 'No sub-tasks' : 'No sub-issues'));
    };
    const paint = () => {
      const loaded = kids().map((k) => k.issue);
      const p = issueProgress(issue, loaded.length ? loaded : undefined);
      const task = issue.taskId;
      const goTask = task
        ? (h(
            'button.btn.small.kb-br-task',
            {
              type: 'button',
              title: `Open task #${task}, made from ${issue.key}`,
            },
            `↗ #${task}`,
          ) as HTMLButtonElement)
        : null;
      goTask?.addEventListener('click', () => o.openTask(task!));
      const kept = row.firstChild;
      row.replaceChildren(
        ...(kept ? [kept] : []),
        h('span.kb-br-key', {}, issue.key),
        h(
          'button.kb-br-title',
          {
            type: 'button',
            title: `Open ${issue.key}: status, assignee, comments, a task`,
            onclick: () => o.open(issue),
          },
          issue.title || '(no title)',
        ),
        h(
          'span.kb-br-meta',
          {},
          issue.issueType ? h('span.kb-chip.type', {}, issue.issueType) : null,
          statusChip(issue.status, issue.statusCategory),
          issue.assignee ? h('span.kb-chip.who', { title: `Assigned to ${issue.assignee}` }, `👤 ${issue.assignee}`) : null,
          p ? doneChip(p.done, p.total, false) : null,
          goTask,
        ),
      );
      row.classList.toggle('done', issue.statusCategory === 'done');
    };
    paint();
    return {
      li: n.li,
      update(next, nextNested) {
        issue = next;
        nested = nextNested;
        paint();
        if (n.isOpen()) paintKids();
      },
    };
  };

  /** A flat list of issues, page by page: an epic's own list, or a GitHub group (sub-issues already loaded nest). */
  const issueList = (n: ReturnType<typeof node>, fetch: (cursor?: string) => Promise<Page>, done?: (all: BrowseIssue[], complete: boolean) => void) => {
    let items: BrowseIssue[] = [];
    const views = new Map<string, IssueView>();
    const pager = paged(
      n.tail,
      fetch,
      (a) => {
        items = mergeIssues(items, a.items);
        o.seen(a.items);
        const roots = jira
          ? items.map((i): ItemNode => ({
              issue: i,
              children: [],
              done: 0,
              total: 0,
            }))
          : groupProjectItems(items);
        if (!roots.length) return n.list.replaceChildren(empty('No issues here match the filters'));
        for (const r of roots) {
          let v = views.get(r.issue.key);
          if (!v) views.set(r.issue.key, (v = issueView(r.issue, r.children)));
          else v.update(r.issue, r.children);
          n.list.append(v.li);
        }
        done?.(items, !a.next);
      },
      'more issues',
    );
    pager.load();
  };

  // ---- An epic (Jira) ----
  interface EpicView {
    li: HTMLElement;
    update(e: EpicNode): void;
  }
  const epicView = (group: string, first: EpicNode): EpicView => {
    let epic = first;
    /** The epic's own list, once it is all in. */
    let own: { done: number; total: number } | null = null;
    const row = h('div.kb-br-row.epic');
    const count = h('span.kb-br-count');
    const where = { group, epic: epic.key ?? 'none' };
    const n = node(row, true, epic.key ?? 'the issues without an epic', () =>
      issueList(
        n,
        (cursor) =>
          ask<Page>({
            t: 'kanban.browse.page',
            filters: o.filters,
            ...where,
            ...(cursor ? { cursor } : {}),
          }),
        (all, complete) => {
          if (complete) own = progress(all);
          paint();
        },
      ),
    );
    const asIssue = (): BrowseIssue =>
      epic.issue ?? {
        source: 'jira',
        key: epic.key!,
        title: epic.title,
        url: '',
        body: '',
        labels: [],
        updatedAt: '',
        issueType: 'Epic',
        hierarchy: 1,
      };
    const paint = () => {
      const p = own ?? epic;
      const kept = row.firstChild;
      row.replaceChildren(
        ...(kept ? [kept] : []),
        epic.key ? h('span.kb-br-key', {}, epic.key) : h('span.kb-br-key', { 'aria-hidden': 'true' }, '—'),
        epic.key
          ? h(
              'button.kb-br-title',
              {
                type: 'button',
                title: `Open the epic ${epic.key}`,
                onclick: () => o.open(asIssue()),
              },
              `🧭 ${epic.title}`,
            )
          : h('span.kb-br-title.plain', {}, epic.title),
        h('span.kb-br-meta', {}, statusChip(epic.status, epic.statusCategory), doneChip(p.done, p.total, !own), count),
      );
      row.classList.toggle('done', epic.statusCategory === 'done');
    };
    paint();
    countWhen(row, count, where);
    return {
      li: n.li,
      update(e) {
        epic = e;
        paint();
      },
    };
  };

  // ---- A group ----
  const groupView = (g: BrowseGroup): HTMLElement => {
    const row = h(`div.kb-br-row.group.${g.kind}`);
    const count = h('span.kb-br-count');
    const icon = g.kind === 'released' ? '🗄️' : g.kind === 'none' ? '∅' : g.kind === 'version' ? '🏷️' : g.kind === 'iteration' ? '🔁' : '🚦';
    row.append(
      h('span.kb-br-gtitle', {}, `${icon} ${g.title}`),
      h(
        'span.kb-br-meta',
        {},
        g.released && g.kind !== 'released' ? h('span.kb-chip.cat-done', {}, 'released') : null,
        g.releaseDate ? h('span.kb-br-date', { title: 'Release date' }, `📅 ${g.releaseDate}`) : null,
        g.kind === 'released' ? null : count,
      ),
    );
    const n = node(row, true, g.title, () => {
      if (g.kind === 'released') return groupList(n, true);
      if (!jira)
        return issueList(n, (cursor) =>
          ask<Page>({
            t: 'kanban.browse.page',
            filters: o.filters,
            group: g.id,
            ...(cursor ? { cursor } : {}),
          }),
        );
      // A Jira version: its top-level issues by epic; Load more merges and regroups, the epics stay in place.
      let items: BrowseIssue[] = [];
      const epics = new Map<string, EpicView>();
      paged(
        n.tail,
        (cursor) =>
          ask<Page>({
            t: 'kanban.browse.page',
            filters: o.filters,
            group: g.id,
            ...(cursor ? { cursor } : {}),
          }),
        (a) => {
          items = mergeIssues(items, a.items);
          o.seen(a.items);
          const nodes = groupByEpic(items);
          if (!nodes.length) return n.list.replaceChildren(empty('No issues here match the filters'));
          for (const e of nodes) {
            let v = epics.get(e.id);
            if (!v) epics.set(e.id, (v = epicView(g.id, e)));
            else v.update(e);
            n.list.append(v.li);
          }
        },
        'more issues',
      ).load();
    });
    if (g.kind !== 'released') countWhen(row, count, { group: g.id });
    return n.li;
  };

  /** The groups (or, `released`, the ones under the collapsed node) into a node's list. */
  const groupList = (n: { list: HTMLElement; tail: HTMLElement }, released: boolean) => {
    let any = false;
    paged(
      n.tail,
      (cursor) =>
        ask<Groups>({
          t: 'kanban.browse.groups',
          filters: o.filters,
          ...(released ? { released: true } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      (a) => {
        for (const g of a.groups) n.list.append(groupView(g));
        any ||= a.groups.length > 0;
        if (!any && !a.next) n.list.replaceChildren(empty(released ? 'None' : 'Nothing matches the filters'));
      },
      released ? 'more' : 'more groups',
    ).load();
  };

  const list = h('ul.kb-br-list.root', {
    'aria-label': `The issues of ${o.scope.label}`,
  });
  const tail = h('div.kb-br-tail');
  const el = h('div.kb-br-tree', {}, list, tail);
  groupList({ list, tail }, false);
  return {
    el,
    destroy() {
      seenRows?.disconnect();
      waiting.clear();
      queue.length = 0;
    },
  };
}

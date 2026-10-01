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
import { MAX_EMPTY_PAGES, afterPage, hasMoreKids, isContext, issueSignature, parentTaskId, syncChildren, viewsFor } from './browsesync';

/** What a row of an issue that doesn't match the filters says. */
const CONTEXT_HINT = 'Doesn’t match the filters: shown as the parent of a match';

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
  const paged = <A extends { next?: string }>(tail: HTMLElement, fetch: (cursor?: string) => Promise<A>, take: (a: A) => 'rows' | 'none' | 'wait' | void, what = 'more') => {
    let cursor: string | undefined;
    let busy = false;
    let complete = false;
    /** Pages in a row that had nothing to show but a `next`: fetched on, up to MAX_EMPTY_PAGES. */
    let empties = 0;
    const load = () => {
      if (busy || !o.live()) return;
      busy = true;
      tail.replaceChildren(h('div.kb-br-quiet', {}, 'Loading…'));
      fetch(cursor)
        .then((a) => {
          busy = false;
          if (!o.live()) return;
          cursor = a.next;
          complete = !a.next;
          empties = take(a) === 'wait' ? empties + 1 : 0;
          if (!a.next) return tail.replaceChildren();
          if (empties > 0 && empties < MAX_EMPTY_PAGES) return load();
          const more = h('button.btn.small.kb-br-more', { type: 'button' }, `Load ${what}`);
          more.addEventListener('click', () => {
            empties = 0;
            load();
          });
          tail.replaceChildren(more);
        })
        .catch((err: Error) => {
          busy = false;
          if (o.live()) tail.replaceChildren(errorLine(err.message || 'That didn’t load', load));
        });
    };
    return { load, complete: () => complete };
  };

  /**
   * A node of the tree: its row, and under it a list that is filled the first time it opens. `byUser`
   * says whether the user opened it (a node opened for them, to show what a search nested, is not).
   * `canOpen` can turn on later, when sub-tasks come to an issue that had none.
   */
  const node = (row: HTMLElement, canOpen: boolean, label: string, firstOpen: (byUser: boolean) => void) => {
    const list = h('ul.kb-br-list');
    const tail = h('div.kb-br-tail');
    const sub = h('div.kb-br-sub', { hidden: true }, list, tail);
    const li = h('li.kb-br-node', {}, row, sub);
    let opened = false;
    /** The user opened or closed it themselves (it is then never opened for them). */
    let touched = false;
    const makeTog = (): HTMLElement => {
      if (!canOpen) return h('span.kb-br-tog.leaf', { 'aria-hidden': 'true' }, '•');
      const b = h('button.kb-br-tog', { type: 'button', 'aria-expanded': 'false', 'aria-label': `Open ${label}`, title: 'Open (→) / close (←)' }, '▸');
      b.addEventListener('click', () => {
        touched = true;
        set(!!sub.hidden);
      });
      return b;
    };
    let tog = makeTog();
    row.prepend(tog);
    const set = (on: boolean, byUser = true) => {
      if (!canOpen) return;
      sub.hidden = !on;
      tog.setAttribute('aria-expanded', String(on));
      tog.setAttribute('aria-label', `${on ? 'Close' : 'Open'} ${label}`);
      tog.textContent = on ? '▾' : '▸';
      if (on && !opened) {
        opened = true;
        firstOpen(byUser);
      }
    };
    row.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' && sub.hidden && canOpen) {
        touched = true;
        set(true);
      } else if (e.key === 'ArrowLeft' && !sub.hidden) {
        touched = true;
        set(false);
      } else if (e.key === 'ArrowLeft') {
        // Already closed: up to the node it is in.
        e.preventDefault();
        return li.parentElement?.closest('li.kb-br-node')?.querySelector<HTMLElement>(':scope > .kb-br-row .kb-br-tog')?.focus();
      } else return;
      e.preventDefault();
      tog.focus();
    });
    return {
      li,
      list,
      tail,
      set,
      isOpen: () => !sub.hidden,
      /** Opens it for the user (not by them), unless they have opened or closed it themselves. */
      reveal() {
        if (!touched && sub.hidden) set(true, false);
      },
      /** Lets it open, once it has something to show. */
      openable() {
        if (canOpen) return;
        canOpen = true;
        const next = makeTog();
        tog.replaceWith(next);
        tog = next;
      },
    };
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
  /** The `↗ #id` button to a task made from an issue. */
  const taskLink = (task: number | undefined, from: string) => {
    if (!task) return null;
    const b = h('button.btn.small.kb-br-task', { type: 'button', title: `Open task #${task}, made from ${from}` }, `↗ #${task}`);
    b.addEventListener('click', () => o.openTask(task));
    return b;
  };
  /**
   * An issue's row, and its sub-tasks / sub-issues under it: the ones the page nested (`nested`, open
   * from the start, as a search found them) and, when the user opens it and it has more, the ones
   * fetched. `views` is the one key → view map of the whole list it is in, shared by every level, so
   * an issue that moves (a child whose parent came on a later page) keeps its view and shows once.
   */
  const issueView = (views: Map<string, IssueView>, first: BrowseIssue, firstNested: ItemNode[] = []): IssueView => {
    let issue = first;
    let nested = firstNested;
    let fetched: BrowseIssue[] = [];
    let kidsOf: ItemNode[] | null = null;
    let signature = issueSignature(first, firstNested);
    const row = h('div.kb-br-row.issue');
    let pager: ReturnType<typeof paged<Page>> | null = null;
    const what = jira ? 'sub-tasks' : 'sub-issues';
    /** Fetches the sub-tasks, once, when the issue has more than are nested. */
    const fetchKids = () => {
      if (pager || !hasMoreKids(issue, nested.length)) return;
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
          kidsOf = null;
          o.seen(a.items);
          paint();
          paintKids();
        },
        `more ${what}`,
      );
      pager.load();
    };
    /** Opened for the user: what was nested shows, and a button fetches the rest. */
    const offerMore = () => {
      if (pager) return;
      if (!hasMoreKids(issue, nested.length)) return n.tail.replaceChildren();
      const more = h('button.btn.small.kb-br-more', { type: 'button' }, `Load all ${issue.childCount} ${what}`);
      more.addEventListener('click', fetchKids);
      n.tail.replaceChildren(more);
    };
    const n = node(row, !!(issue.childCount || nested.length), issue.key, (byUser) => {
      paintKids();
      if (byUser) fetchKids();
      else offerMore();
    });
    /** The sub-tasks to show, worked out once per change of `nested` / `fetched`. */
    const kids = (): ItemNode[] => {
      if (kidsOf) return kidsOf;
      const all = mergeIssues(
        nested.map((c) => c.issue),
        fetched,
      );
      const deeper = new Map(nested.map((c) => [c.issue.key, c.children]));
      return (kidsOf = all.map((i) => ({ issue: i, children: deeper.get(i.key) ?? [], ...progress([]) })));
    };
    const paintKids = () => {
      const list = kids().filter((k) => k.issue.key !== issue.key);
      const lis = viewsFor(
        views,
        list,
        (k) => issueView(views, k.issue, k.children),
        (v, k) => v.update(k.issue, k.children),
      )
        .map((v) => v.li)
        // Never an issue above this one (a loop in the data): the DOM can't put it under itself.
        .filter((li) => !li.contains(n.li));
      if (!lis.length && (pager?.complete() ?? !issue.childCount)) n.list.replaceChildren(empty(`No ${what}`));
      else syncChildren(n.list, lis);
    };
    const paint = () => {
      const loaded = kids().map((k) => k.issue);
      const p = issueProgress(issue, loaded.length ? loaded : undefined);
      const context = isContext(issue);
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
          context ? h('span.kb-chip.context', { title: CONTEXT_HINT }, 'context') : null,
          issue.issueType ? h('span.kb-chip.type', {}, issue.issueType) : null,
          statusChip(issue.status, issue.statusCategory),
          issue.assignee ? h('span.kb-chip.who', { title: `Assigned to ${issue.assignee}` }, `👤 ${issue.assignee}`) : null,
          p ? doneChip(p.done, p.total, false) : null,
          taskLink(issue.taskId, issue.key),
        ),
      );
      row.classList.toggle('done', issue.statusCategory === 'done');
      row.classList.toggle('context', context);
      if (context) row.title = CONTEXT_HINT;
      else row.removeAttribute('title');
    };
    paint();
    /** Shows what the page nested: opens it (unless the user closed it) or, open already, repaints. */
    const showNested = () => {
      if (!nested.length && !issue.childCount) return;
      n.openable();
      if (n.isOpen()) {
        paintKids();
        offerMore();
      } else if (nested.length) n.reveal();
    };
    showNested();
    return {
      li: n.li,
      update(next, nextNested) {
        issue = next;
        const sig = issueSignature(next, nextNested);
        // Nothing the row or its nested sub-tasks show has changed: leave the DOM (and the focus in it) alone.
        if (sig === signature) return;
        signature = sig;
        nested = nextNested;
        kidsOf = null;
        paint();
        showNested();
      },
    };
  };

  /**
   * A flat list of issues, page by page: an epic's own list, a Jira "No epic", or a GitHub group. An
   * issue whose parent is in the list nests under it (GitHub sub-issues, and Jira sub-tasks a search
   * found under their story); every regroup reconciles the rows with the new grouping (syncChildren).
   */
  const issueList = (n: ReturnType<typeof node>, fetch: (cursor?: string) => Promise<Page>, done?: (top: BrowseIssue[], complete: boolean) => void) => {
    let items: BrowseIssue[] = [];
    const views = new Map<string, IssueView>();
    const pager = paged(
      n.tail,
      fetch,
      (a) => {
        items = mergeIssues(items, a.items);
        o.seen(a.items);
        const roots = groupProjectItems(items);
        const state = afterPage(roots.length, !!a.next);
        // Never "no matches" while there is more to load: the next page may hold them.
        if (state !== 'rows') n.list.replaceChildren(...(state === 'none' ? [empty('No issues here match the filters')] : []));
        else {
          const lis = viewsFor(
            views,
            roots,
            (r) => issueView(views, r.issue, r.children),
            (v, r) => v.update(r.issue, r.children),
          ).map((v) => v.li);
          syncChildren(n.list, lis);
        }
        // The top-level issues that match, as groupByEpic counts them.
        done?.(
          roots.map((r) => r.issue).filter((i) => !isContext(i)),
          !a.next,
        );
        return state;
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
        (top, complete) => {
          if (complete) own = progress(top);
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
    /** The task made from the epic: its own record's, or what its issues' `parent` said. */
    const epicTask = (): number | undefined =>
      epic.issue?.taskId ?? epic.items.map(parentTaskId).find((id) => id !== undefined);
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
        h('span.kb-br-meta', {}, statusChip(epic.status, epic.statusCategory), doneChip(p.done, p.total, !own), count, epic.key ? taskLink(epicTask(), epic.key) : null),
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
          const state = afterPage(nodes.length, !!a.next);
          if (state !== 'rows') {
            n.list.replaceChildren(...(state === 'none' ? [empty('No issues here match the filters')] : []));
            return state;
          }
          // Reconciled like the issues: an epic node keeps its view (open, loaded), one that is gone
          // (a "No epic" whose sub-task found its story's epic) is taken out.
          const lis: HTMLElement[] = [];
          for (const e of nodes) {
            let v = epics.get(e.id);
            if (!v) epics.set(e.id, (v = epicView(g.id, e)));
            else v.update(e);
            lis.push(v.li);
          }
          syncChildren(n.list, lis);
          return 'rows';
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
        const state = afterPage(any ? 1 : 0, !!a.next);
        if (state === 'none') n.list.replaceChildren(empty(released ? 'None' : 'Nothing matches the filters'));
        return state;
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

// The browse tree's counts (browseview.ts): a group's (or an epic's) issue count is asked for only once
// its row scrolls into view, three at a time.

import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { BrowseFilters } from '../../shared/kanban/browse.js';

type Count = Extract<KanbanServerMsg, { t: 'kanban.browseCount' }>;

/** How many counts may be asked for at once. */
const COUNTS_IN_FLIGHT = 3;

export interface LazyCountsOpts {
  /** False once the tree has been replaced or the window closed: nothing lands then. */
  live(): boolean;
  filters: BrowseFilters;
  /** Jira counts are estimates. */
  jira: boolean;
  ask<T extends KanbanServerMsg>(msg: Record<string, unknown>): Promise<T>;
}

/** Returns `countWhen(row, out, where)`, which fills `out` with the count of a group (or an epic in it) once `row` is in view, and `destroy()`. */
export function lazyCounts(o: LazyCountsOpts) {
  const { jira, ask } = o;
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
  const destroy = () => {
    seenRows?.disconnect();
    waiting.clear();
    queue.length = 0;
  };
  return { countWhen, destroy };
}

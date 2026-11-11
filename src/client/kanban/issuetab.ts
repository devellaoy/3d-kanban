// A task's Issue tab: the issue its ticket names, as the issue window shows it (issueview.ts), read
// through kanban.issue.get. The task view redraws on every update, so the tab keeps its host and the
// view inside (a comment being written survives) and only reloads when the ticket changes.
//
// Its bar also changes which issue that is (issuelink.ts): link, change, type a key by hand, unlink,
// at any status but the archive (where the buttons are gone). The bar and the key form stay in the host across every state (no
// issue, loading, shown, could not be read), so what is typed there outlives a redraw too.

import { h, toast } from '../ui/dom';
import { btn, outLink } from '../ui/kit';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTask, NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { issueGetMsg, safeUrl } from './issueactionsmodel';
import { issueLink } from './issuelink';
import { issueKeyOf } from './issuelinkmodel';
import { issueView, type IssueView } from './issueview';

type Detail = Extract<KanbanServerMsg, { t: 'kanban.issueDetail' }>;

export function mountIssueTab(api: KanbanApi, openTask: (id: number) => void): { host: HTMLElement; setTask(task: KanbanTask): void; destroy(): void } {
  const link = issueLink(api);
  const bar = h('div.kb-iw-bar');
  const host = h('div.kb-tv-issue', {}, bar, link.form);
  /** The bar (floating beside the issue, or `miss`: a box that says why there is none to show) and what is under the form. */
  let own: (Node | string)[] = [];
  /** The bar's own content, then the link buttons the task has now (none in the archive); a bar with nothing in it is not shown. */
  const fillBar = () => {
    // A button of the bar that had the keyboard keeps it: the bar is filled again around it.
    const active = document.activeElement;
    const shown = link.buttons.filter((b) => !b.classList.contains('hidden'));
    bar.replaceChildren(...own, ...shown);
    bar.classList.toggle('hidden', !own.length && !shown.length);
    if (active instanceof HTMLElement && active !== document.activeElement && bar.contains(active)) active.focus({ preventScroll: true });
  };
  const put = (miss: boolean, inBar: (Node | string)[], ...content: Node[]) => {
    bar.className = miss ? 'kb-iw-miss' : 'kb-iw-bar';
    own = inBar;
    fillBar();
    while (link.form.nextSibling) link.form.nextSibling.remove();
    host.append(...content);
  };
  /** Why the issue shown couldn't be read, while its box (which shows the task's own link) is up. */
  let failed: { why: string; url: string } | null = null;
  let key = '';
  let view: IssueView | null = null;
  let gone = false;
  let drawn = false;
  // The issue source the issue shown came through, for the reads after the first.
  let source: string | undefined;
  const current = (k: string) => !gone && key === k;
  // The task this issue was made for is the viewer's own; a ticket may have several tasks.
  const plain = (i: NormalizedIssue): NormalizedIssue => ({ ...i, taskId: undefined });

  const load = async (task: KanbanTask, fresh: boolean): Promise<NormalizedIssue | undefined> => {
    const k = key;
    const msg = await api.request<Detail>(issueGetMsg(task.project, task.ticket!, { source, fresh }));
    if (!current(k)) return undefined;
    source ??= msg.issue.sourceId;
    return plain(msg.issue);
  };
  const fail = (task: KanbanTask, why: string) => {
    const url = safeUrl(task.ticketUrl);
    failed = { why, url };
    const again = btn('Retry', { icon: 'rotate-cw', size: 'sm', attrs: { 'data-focus': 'issue-retry' } });
    again.addEventListener('click', () => show(task, true));
    put(true, [url ? outLink(task.ticket ?? '', url, { class: 'kb-iw-key', title: 'Open it at the source' }) : h('span.kb-iw-key', {}, task.ticket), h('p.kb-muted', {}, why), again]);
  };
  const show = (task: KanbanTask, fresh: boolean) => {
    const k = key;
    view?.destroy();
    view = null;
    failed = null;
    put(false, [], h('p.kb-muted', {}, 'Loading the issue…'));
    load(task, fresh).then(
      (issue) => {
        if (!issue || !current(k)) return;
        const refresh = btn('Refresh', { icon: 'refresh-cw', size: 'sm', attrs: { title: 'Read the issue from its source again', 'data-focus': 'issue-refresh' } });
        const reload = () => load(task, true);
        view = issueView(api, task.project, issue, openTask, { reload, title: true, whole: true });
        refresh.addEventListener('click', () => {
          refresh.disabled = true;
          reload()
            .then((i) => i && view?.set(i, true))
            .catch((e: Error) => toast(e.message || 'The issue could not be read', 'error'))
            .finally(() => (refresh.disabled = false));
        });
        put(false, [refresh], view.el);
      },
      (err: Error) => current(k) && fail(task, err.message || 'The issue could not be read'),
    );
  };

  return {
    host,
    setTask(task) {
      link.set(task);
      const next = issueKeyOf(task);
      if (next === key && (key || drawn)) {
        // The same issue: what is shown stays (a comment being written too). Only the box of one that
        // couldn't be read shows the task's own link, and the bar's buttons go with the archive.
        if (failed && failed.url !== safeUrl(task.ticketUrl)) fail(task, failed.why);
        else fillBar();
        return;
      }
      key = next;
      drawn = true;
      failed = null;
      source = undefined;
      view?.destroy();
      view = null;
      if (!task.ticket) put(true, [h('p.kb-muted', {}, 'No issue is linked to this task.')]);
      else show(task, false);
    },
    destroy() {
      gone = true;
      view?.destroy();
      view = null;
    },
  };
}

// The content of one issue of a project's issue sources: what the source says, the actions on it
// (issueactions.ts). Shared by the issue window (issuewindow.ts) and a task's Issue tab (issuetab.ts).
// It follows the office's kanban.issues, so a status or assignee changed from here (or elsewhere)
// shows as soon as it's back.

import { h, timeAgo } from '../ui/dom';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { issueActions } from './issueactions';
import { LIST_BODY, actionIssue, listedBody, safeUrl } from './issueactionsmodel';
import { SOURCE_KIND_NAMES } from './labels';
import { renderMarkdown } from './md';

export interface IssueView {
  el: HTMLElement;
  issue(): NormalizedIssue;
  /** Replaces the issue (a task made from it, say) and repaints; `reread`: the actions panel asks the source again too (a refresh). */
  set(issue: NormalizedIssue, reread?: boolean): void;
  /** Runs `fn` now and after each repaint, with the issue as it is. */
  onPaint(fn: (issue: NormalizedIssue) => void): void;
  destroy(): void;
}

/**
 * `reload` fetches the issue again (a browsed one is not on the issues list, so nothing else keeps it
 * current): called after a change made from the panel, and its answer repaints the view.
 * `title` puts the issue's title at the top (the issue window's frame shows it already).
 */
export function issueView(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void, opts: { reload?: () => Promise<NormalizedIssue | undefined>; title?: boolean; whole?: boolean } = {}): IssueView {
  let it = first;
  // Whether the body held was read whole; one that came with a reload was read on its own, so it is.
  let whole = opts.whole ?? (!!opts.reload || first.body.length < LIST_BODY);
  const painted: ((issue: NormalizedIssue) => void)[] = [];
  const top = h('div.kb-iw-top');
  const chips = h('span.kb-chips');
  const heading = opts.title ? h('h3.kb-iw-title') : null;
  const desc = h('div.kb-iw-desc');
  let shownBody: string | undefined;
  let reloading = false;
  const reload = async () => {
    if (reloading) return;
    reloading = true;
    const fresh = await Promise.resolve(opts.reload?.()).catch(() => undefined);
    reloading = false;
    if (!fresh) return;
    it = { ...fresh, taskId: fresh.taskId ?? it.taskId };
    whole = true;
    paint();
  };
  const panel = issueActions(api, projectId, actionIssue(it), { openTask, onChanged: () => void reload() });
  const url = safeUrl(it.url);
  top.append(url ? h('a.kb-iw-key', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, `${it.key} ↗`) : h('span.kb-iw-key', {}, it.key), chips);
  const el = h('div.kb-iw', {}, heading, top, desc, panel.el);
  const paint = () => {
    if (heading && heading.textContent !== it.title) heading.textContent = it.title;
    // Only when the body changed, so a repaint keeps the reader's scroll and selection.
    if (it.body !== shownBody) desc.replaceChildren(renderMarkdown((shownBody = it.body), openTask));
    chips.replaceChildren(
      h('span.kb-chip', {}, SOURCE_KIND_NAMES[it.source]),
      it.status ? h('span.kb-chip.status', {}, it.status) : '',
      it.assignee ? h('span.kb-chip', {}, `👤 ${it.assignee}`) : '',
      it.epic ? h('span.kb-chip', {}, `🧭 ${it.epic}`) : '',
      ...it.labels.slice(0, 8).map((l) => h('span.kb-chip.tag', {}, l)),
      it.updatedAt ? h('small.kb-muted', {}, `updated ${timeAgo(it.updatedAt)}`) : '',
    );
    panel.update(actionIssue(it));
    for (const fn of painted) fn(it);
  };
  const off = api.on((msg) => {
    if (msg.t !== 'kanban.issues' || msg.project !== projectId) return;
    const fresh = msg.items.find((i) => i.key === it.key);
    if (!fresh) return;
    // A cut copy never replaces a body read whole: that one stays until the changed one is read whole too.
    const got = listedBody(it.body, whole, fresh.body);
    // Nothing to read it whole with (a window opened from the list): the newer copy, cut as it may be, beats a stale one.
    const take = got.stale && !opts.reload;
    it = { ...fresh, taskId: fresh.taskId ?? it.taskId, body: take ? fresh.body : got.body };
    whole = take ? false : got.whole;
    paint();
    if (got.stale && !take) void reload();
  });
  paint();
  return {
    el,
    issue: () => it,
    set(issue, reread) {
      it = issue;
      whole = true;
      paint();
      if (reread) panel.reload();
    },
    onPaint: (fn) => (painted.push(fn), fn(it)),
    destroy: off,
  };
}

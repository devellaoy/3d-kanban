// The content of one issue of a project's issue sources: what the source says, the actions on it
// (issueactions.ts). Shared by the issue window (issuewindow.ts) and a task's Issue tab (issuetab.ts).
// It follows the office's kanban.issues, so a status or assignee changed from here (or elsewhere)
// shows as soon as it's back.

import { h, timeAgo } from '../ui/dom';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { issueActions } from './issueactions';
import { actionIssue, safeUrl } from './issueactionsmodel';
import { SOURCE_KIND_NAMES } from './labels';
import { renderMarkdown } from './md';

export interface IssueView {
  el: HTMLElement;
  issue(): NormalizedIssue;
  /** Replaces the issue (a task made from it, say) and repaints. */
  set(issue: NormalizedIssue): void;
  /** Runs `fn` now and after each repaint, with the issue as it is. */
  onPaint(fn: (issue: NormalizedIssue) => void): void;
  destroy(): void;
}

/**
 * `reload` fetches the issue again (a browsed one is not on the issues list, so nothing else keeps it
 * current): called after a change made from the panel, and its answer repaints the view.
 */
export function issueView(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void, opts: { reload?: () => Promise<NormalizedIssue | undefined> } = {}): IssueView {
  let it = first;
  const painted: ((issue: NormalizedIssue) => void)[] = [];
  const top = h('div.kb-iw-top');
  const chips = h('span.kb-chips');
  const desc = h('div.kb-iw-desc', {}, renderMarkdown(it.body, openTask));
  const reload = async () => {
    const fresh = await opts.reload?.();
    if (!fresh) return;
    it = { ...fresh, taskId: fresh.taskId ?? it.taskId };
    paint();
  };
  const panel = issueActions(api, projectId, actionIssue(it), { openTask, onChanged: () => void reload() });
  const url = safeUrl(it.url);
  top.append(url ? h('a.kb-iw-key', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, `${it.key} ↗`) : h('span.kb-iw-key', {}, it.key), chips);
  const el = h('div.kb-iw', {}, top, desc, panel.el);
  const paint = () => {
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
    it = { ...fresh, taskId: fresh.taskId ?? it.taskId };
    paint();
  });
  paint();
  return {
    el,
    issue: () => it,
    set(issue) {
      it = issue;
      paint();
    },
    onPaint: (fn) => (painted.push(fn), fn(it)),
    destroy: off,
  };
}

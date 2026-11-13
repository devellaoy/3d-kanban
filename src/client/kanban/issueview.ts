// The content of one issue of a project's issue sources: what the source says, the actions on it
// (issueactions.ts). Shared by the issue window (issuewindow.ts) and a task's Issue tab (issuetab.ts).
// It follows the office's kanban.issues, so a status or assignee changed from here (or elsewhere)
// shows as soon as it's back.

import '../ui/github/windows.css';
import { h, timeAgo } from '../ui/dom';
import { icon } from '../ui/icons';
import { detailsRail, outLink } from '../ui/kit';
import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanApi } from './api';
import { issueActions } from './issueactions';
import { issueChildren } from './issuechildren';
import { isNewListRead } from './issuechildrenmodel';
import { LIST_BODY, actionIssue, listedBody, safeUrl } from './issueactionsmodel';
import { SOURCE_KIND_NAMES } from './labels';
import { renderMarkdown } from './md';

export interface IssueView {
  /** The content: the description and the actions; in a window (`split`), without what `rail` holds. */
  el: HTMLElement;
  /** In a window (`split`): its status and assignee actions and its details, for the window's rail. */
  rail: HTMLElement[];
  issue(): NormalizedIssue;
  /** Replaces the issue (a task made from it, say) and repaints; `reread`: the actions panel asks the source again too (a refresh). */
  set(issue: NormalizedIssue, reread?: boolean): void;
  /** Runs `fn` now and after each repaint, with the issue as it is. */
  onPaint(fn: (issue: NormalizedIssue) => void): void;
  destroy(): void;
}

/** "Jira · updated 5h ago": where an issue is from and when it last changed. */
export const issueMeta = (it: Pick<NormalizedIssue, 'source' | 'updatedAt'>): string => `${SOURCE_KIND_NAMES[it.source]}${it.updatedAt ? ` · updated ${timeAgo(it.updatedAt)}` : ''}`;

/**
 * `reload` fetches the issue again (a browsed one is not on the issues list, so nothing else keeps it
 * current): called after a change made from the panel, and its answer repaints the view.
 * `title` puts the issue's title at the top (the issue window's frame shows it already).
 * `split` is the issue window's layout: the description and the comments in `el`, the status and
 * assignee actions and the details (epic, labels, source, task) in `rail`; the window's header shows
 * the key, the status and the source.
 */
export function issueView(api: KanbanApi, projectId: string, first: NormalizedIssue, openTask: (id: number) => void, opts: { reload?: () => Promise<NormalizedIssue | undefined>; title?: boolean; whole?: boolean; split?: boolean } = {}): IssueView {
  let it = first;
  // Whether the body held was read whole; one that came with a reload was read on its own, so it is.
  let whole = opts.whole ?? (!!opts.reload || first.body.length < LIST_BODY);
  const painted: ((issue: NormalizedIssue) => void)[] = [];
  const top = h('div.kb-iw-top');
  const chips = h('span.kb-iw-meta');
  const heading = opts.title ? h('h3.kb-iw-title') : null;
  const desc = h('div.kb-iw-desc');
  const details = h('div.iw-details');
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
  const onChanged = () => void reload();
  // In a window the status and the assignee go to the rail, and the comments stay under the description.
  const panels = opts.split
    ? [issueActions(api, projectId, actionIssue(it), { sections: ['status', 'assignee'], openTask, onChanged }), issueActions(api, projectId, actionIssue(it), { sections: ['comments'], openTask, onChanged })]
    : [issueActions(api, projectId, actionIssue(it), { openTask, onChanged })];
  // A Jira issue's sub-tasks, between the description and the comments (issuechildren.ts).
  const children = issueChildren(api, projectId, it, { openTask });
  const url = safeUrl(it.url);
  top.append(url ? outLink(it.key, url, { class: 'kb-iw-key', title: 'Open it at the source' }) : h('span.kb-iw-key', {}, it.key), chips);
  const el = opts.split
    ? h('div.iw-main', {}, h('section.iw-sec', {}, h('h3.gh-sec-h', {}, 'Description'), desc), children.el, panels[1].el)
    : h('div.kb-iw', {}, heading, top, desc, children.el, panels[0].el);
  const rail = opts.split ? [panels[0].el, h('hr.rail-sep'), details] : [];
  const paint = () => {
    if (heading && heading.textContent !== it.title) heading.textContent = it.title;
    // Only when the body changed, so a repaint keeps the reader's scroll and selection.
    if (it.body !== shownBody) desc.replaceChildren(renderMarkdown((shownBody = it.body), openTask));
    if (opts.split) {
      const task = it.taskId;
      details.replaceChildren(
        detailsRail([
          { label: 'Epic', value: it.epic ? h('span.iw-with-icon', {}, icon('signpost', { size: 14 }), it.epic) : null },
          // A sub-task's story (an issue in an epic says the epic instead).
          { label: 'Parent', value: !it.epic && it.parent ? h('span.iw-with-icon', {}, icon('corner-up-left', { size: 14 }), `${it.parent.key} ${it.parent.title}`) : null },
          { label: 'Labels', value: it.labels.length ? h('span.iw-labels', {}, ...it.labels.map((l) => h('span.iw-label', {}, l))) : null },
          { label: 'Source', value: SOURCE_KIND_NAMES[it.source] },
          { label: 'Task', value: task ? h('button.link-btn', { type: 'button', onclick: () => openTask(task) }, `Task #${task}`) : h('span.iw-none', {}, 'None yet') },
        ]),
      );
    } else {
      chips.replaceChildren(
        it.status ? h('span.iw-status', {}, it.status) : '',
        h('span', {}, SOURCE_KIND_NAMES[it.source]),
        it.assignee ? h('span.iw-with-icon', {}, icon('user', { size: 13 }), it.assignee) : '',
        it.epic ? h('span.iw-with-icon', {}, icon('signpost', { size: 13 }), it.epic) : it.parent ? h('span.iw-with-icon', { title: `Parent: ${it.parent.title}` }, icon('corner-up-left', { size: 13 }), it.parent.key) : '',
        ...it.labels.slice(0, 8).map((l) => h('span.iw-label', {}, l)),
        it.updatedAt ? h('span', {}, `updated ${timeAgo(it.updatedAt)}`) : '',
      );
    }
    for (const p of panels) p.update(actionIssue(it));
    children.update(it);
    for (const fn of painted) fn(it);
  };
  /** The list read the sub-tasks were last asked after. */
  let listAt: number | undefined;
  const off = api.on((msg) => {
    if (msg.t !== 'kanban.issues' || msg.project !== projectId) return;
    const fresh = msg.items.find((i) => i.key === it.key);
    if (!fresh) return;
    // A new read of the list (the window's Refresh, when it has no reload of its own, is one): the sub-tasks are asked again too.
    // The first one after the window opened counts (it may be that Refresh); the same read told twice doesn't.
    if (isNewListRead(listAt, msg)) {
      listAt = msg.fetchedAt;
      children.reload();
    }
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
    rail,
    issue: () => it,
    set(issue, reread) {
      it = issue;
      whole = true;
      paint();
      if (!reread) return;
      for (const p of panels) p.reload();
      children.reload();
    },
    onPaint: (fn) => (painted.push(fn), fn(it)),
    destroy: off,
  };
}

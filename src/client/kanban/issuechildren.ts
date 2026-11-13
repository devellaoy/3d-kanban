// The child issues of a Jira issue (its sub-tasks, or an epic's issues), listed between the issue's
// description and its comments: in the kanban's issue window, on a task's Issue tab and in the 3D
// office's issue window. Read-only: a row leads to the issue in Jira and to the kanban task made from
// it. An issue without children, or one of another source, shows nothing at all.

import './issueactions.css';
import './issuechildren.css';
import { h } from '../ui/dom';
import { outLink } from '../ui/kit';
import { sectionHead } from '../ui/github/pieces';
import { visiting } from '../multiplayer/visit';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { IssueChild } from '../../shared/kanban/issueops.js';
import type { KanbanApi } from './api';
import { safeUrl } from './issueactionsmodel';
import { childChipClass, childrenHeading, childrenMsg, childrenSummary, type ChildrenIssue } from './issuechildrenmodel';

type Children = Extract<KanbanServerMsg, { t: 'kanban.issueChildren' }>;

export type { ChildrenIssue };

export function issueChildren(api: KanbanApi, project: string, first: ChildrenIssue, opts: { openTask: (id: number) => void }): { el: HTMLElement; update(issue: Omit<ChildrenIssue, 'key'>): void; reload(): void } {
  let issue = first;
  const el = h('section.iw-sec.kb-ic', { hidden: true });
  let gen = 0;

  const row = (c: IssueChild) => {
    const url = safeUrl(c.url);
    const task = c.taskId;
    return h(
      'li.kb-ic-row',
      {},
      c.status ? h('span.kb-chip.status', { class: childChipClass(c), title: c.status }, c.status) : null,
      url ? outLink(c.key, url, { class: 'kb-ic-key', title: `Open ${c.key} in Jira` }) : h('span.kb-ic-key', {}, c.key),
      h('span.kb-ic-title', { title: c.title }, c.title),
      c.assignee ? h('span.kb-ic-who', { title: `Assigned to ${c.assignee}` }, c.assignee) : null,
      task ? h('button.link-btn', { type: 'button', title: 'Open the kanban task made from it', onclick: () => opts.openTask(task) }, `Task #${task}`) : null,
    );
  };
  const show = (a: Children) => {
    el.hidden = !a.items.length;
    if (!a.items.length) return el.replaceChildren();
    const heading = childrenHeading(a.items);
    const parent = safeUrl(issue.url ?? '');
    el.replaceChildren(
      h('div.kb-ic-head', {}, sectionHead(heading, a.items.length), h('span.kb-ic-done', {}, childrenSummary(a.items, a.more))),
      h(
        'ul.list-box',
        { 'aria-label': `${heading} of ${issue.key}` },
        ...a.items.map(row),
        a.more ? h('li.kb-ic-more', {}, parent ? outLink('More in Jira', parent, { title: `Open ${issue.key} in Jira for the rest` }) : 'More in Jira') : null,
      ),
    );
  };
  // A list that can't be read stays out of the way when nothing is shown yet (the comments below say what is wrong
  // with the source); rows already shown stay as they were.
  const fail = () => {
    if (!el.childElementCount) el.hidden = true;
  };
  /** Asks again; the rows shown stay until the answer is there, so a refresh doesn't blink. */
  function load() {
    const g = ++gen;
    const msg = childrenMsg(project, issue);
    // A visitor's office isn't asked (the owner's would refuse): the panel just isn't there.
    if (!msg || visiting()) {
      el.hidden = true;
      return el.replaceChildren();
    }
    api
      .request<Children>(msg)
      .then((a) => g === gen && show(a))
      .catch(() => g === gen && fail());
  }
  load();

  return {
    el,
    // The key never changes; where the issue is (for "More in Jira") may come with a later copy.
    update(next) {
      issue = { ...next, key: issue.key };
    },
    reload: load,
  };
}

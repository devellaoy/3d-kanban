// The task view's Overview tab: the banner (what the task waits for, or why it is on hold), then the
// description, the acceptance criteria, reports and attachments (taskview.ts). The details are the rail
// beside it (taskdetails.ts); the actions are the footer's (taskactionbar.ts).

import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import type { KanbanAttachment } from '../../shared/kanban/types.js';
import { attachmentUrl, formatSize, isImage, notInText } from './attach';
import { renderMarkdown } from './md';
import { holdBox } from './holdview';
import type { Detail, TaskCtx } from './taskctx';
import type { Reports } from './taskreports';
import { waitingBox } from './taskwaiting';

/** A section of a pane: its small heading (with a note beside it), then its content. */
export function section(title: string, cls: string, note: Node | null, ...content: (Node | null)[]): HTMLElement {
  return h(`section.kb-sec${cls}`, {}, h('div.kb-sec-head', {}, h('h4', {}, title), note), ...content);
}

/**
 * The acceptance criteria as rows: a list's items (their markers and check boxes taken off, a wrapped
 * line kept with its item), or each line of plain text. Null for text that is more than a list (a
 * heading, a table, a code block), which is shown as it is written.
 */
export function criteriaItems(goal: string): string[] | null {
  if (/^\s*(```|~~~|#{1,6}\s|\|)/m.test(goal)) return null;
  const items: string[] = [];
  for (const line of goal.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (m) items.push(m[1]);
    else if (/^\s/.test(line) && items.length) items[items.length - 1] += `\n${line.trim()}`;
    else items.push(line.trim());
  }
  return items.length ? items : null;
}

function criteria(goal: string, open: (id: number) => void): HTMLElement {
  const items = criteriaItems(goal);
  if (!items) return h('div.list-box.kb-goal', {}, h('div', {}, icon('target'), renderMarkdown(goal, open, '')));
  return h('ul.list-box.kb-goal', {}, ...items.map((text) => h('li', {}, icon('target'), renderMarkdown(text, open, ''))));
}

/** The task's files as chips: a picture or a document, its name and size; a click opens it. */
function attachmentChips(files: KanbanAttachment[]): HTMLElement {
  return h(
    'div.kb-attach-chips',
    {},
    ...files.map((a) => h('a.attach-chip', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer', title: a.name }, icon(isImage(a.mime) ? 'paperclip' : 'file-text'), h('span.kb-attach-name', {}, a.name), h('small', {}, formatSize(a.size)))),
  );
}

export function overviewPane(c: TaskCtx, d: Detail, reports: Reports): HTMLElement[] {
  const task = d.task;
  const open = (id: number) => c.openTask(id);
  const files = notInText(d.attachments.filter((a) => !a.commentId), `${task.description}\n${task.goal ?? ''}`);
  const locked = task.flags.descriptionLocked ? h('small.kb-locked', { title: 'The task has started: add to it with a comment instead' }, icon('lock', { size: 12 }), 'Locked since the task started') : null;
  const out: (HTMLElement | null)[] = [
    waitingBox(c, task) ?? holdBox(task),
    section('Description', '.kb-desc', locked, renderMarkdown(task.description, open)),
    task.goal ? section('Acceptance criteria', '', null, criteria(task.goal, open)) : null,
    reports.section(),
    files.length ? section('Attachments', '', null, attachmentChips(files)) : null,
  ];
  return out.filter((x): x is HTMLElement => !!x);
}

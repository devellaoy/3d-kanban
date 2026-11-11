// The task view's Overview tab: the action bar, what the task waits for or why it is on hold, the
// description, criteria, reports, attachments and details (taskview.ts).

import { h } from '../ui/dom';
import { notInText } from './attach';
import { attachmentList } from './commentview';
import { renderMarkdown } from './md';
import { holdBox } from './holdview';
import { overviewBar } from './taskactionbar';
import type { Detail, TaskCtx } from './taskctx';
import { detailsSection } from './taskdetails';
import type { Reports } from './taskreports';
import { waitingBox } from './taskwaiting';

export function overviewPane(c: TaskCtx, d: Detail, reports: Reports): HTMLElement[] {
  const task = d.task;
  const open = (id: number) => c.openTask(id);
  const files = notInText(d.attachments.filter((a) => !a.commentId), `${task.description}\n${task.goal ?? ''}`);
  const none = () => h('span.hidden');
  return [
    overviewBar(task, c),
    waitingBox(c, task) ?? holdBox(task) ?? none(),
    h('section.kb-desc', {}, h('h4', {}, 'Description', task.flags.descriptionLocked ? h('small.kb-muted', { title: 'The task has started: add to it with a comment instead' }, ' 🔒 locked') : null), renderMarkdown(task.description, open)),
    task.goal ? h('section.kb-goal', {}, h('h4', {}, '🎯 Acceptance criteria'), renderMarkdown(task.goal, open, '')) : none(),
    reports.section() ?? none(),
    files.length ? h('section', {}, h('h4', {}, '📎 Attachments'), attachmentList(files)) : none(),
    detailsSection(c, d),
  ];
}

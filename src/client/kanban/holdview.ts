// What the task view shows of a task on hold (taskview.ts): the box with why, until when, since when and by
// whom. (The buttons that put a task on hold and resume it are taskactionbar.ts's, through holddialog.ts.)

import { h } from '../ui/dom';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { fmtTime } from './labels';

/** The "On hold" box of the overview: the reason, the day it is held until, and since when and by whom. Null for a task not on hold. */
export function holdBox(task: Pick<KanbanTask, 'status' | 'hold'>, now = Date.now()): HTMLElement | null {
  const hold = task.status === 'on_hold' ? task.hold : undefined;
  if (!hold) return null;
  const passed = hold.until !== undefined && hold.until < now;
  return h(
    'section.kb-onhold',
    { class: passed ? 'passed' : '' },
    h('h4', {}, '⏸️ On hold'),
    h('p', {}, hold.note ?? 'No reason given.'),
    hold.until !== undefined ? h('p.kb-until', {}, `Until ${new Date(hold.until).toLocaleDateString('en-GB')}${passed ? ' (passed)' : ''}`) : null,
    h('small.kb-muted', {}, `Since ${fmtTime(hold.at)} · by ${hold.by} · from ${hold.from === 'review' ? 'Review' : 'Waiting'}`),
  );
}

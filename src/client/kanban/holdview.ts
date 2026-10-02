// What the task view shows of a task on hold (taskview.ts): the box with why, until when, since when and by
// whom, and the buttons that put a task on hold and resume it. Both go through the dialogs of holddialog.ts.

import { h } from '../ui/dom';
import type { KanbanTask, TaskStatus } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { openHoldDialog, openResumeDialog } from './holddialog';
import { fmtTime } from './labels';

type Add = (label: string, cls: string, fn: (b: HTMLButtonElement) => void, title?: string) => unknown;
type Send = (to: TaskStatus, extras: { note?: string; until?: number }, button: HTMLButtonElement) => void;

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

/** The buttons: ▶️ Resume on a held task, ⏸️ Put on hold on a waiting or review task the engine isn't running. */
export function holdActions(task: KanbanTask, add: Add, send: Send) {
  if (isRunning(task)) return;
  if (task.status === 'on_hold') add('▶️ Resume', '.primary', (b) => openResumeDialog(task, (x) => send('in_progress', x, b)), 'Carry on where it left off, with the comments written meanwhile');
  else if (task.status === 'waiting' || task.status === 'review') add('⏸️ Put on hold', '', (b) => openHoldDialog(task, (x) => send('on_hold', x, b)), 'Put it aside: its worker goes home and the worktree is kept');
}

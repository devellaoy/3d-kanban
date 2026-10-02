// The two small dialogs of the On hold column (docs/kanban.md, "On hold"): putting a task on hold (why
// and until when, both optional) and resuming it (a message for the agent, optional), and the one flow
// the board and the task view share: which move needs which dialog, and what the move then carries.

import { h } from '../ui/dom';
import { HOLD_NOTE_MAX, holdLine } from '../../shared/kanban/hold.js';
import type { KanbanTaskCard, TaskStatus } from '../../shared/kanban/types.js';
import { dateInputValue, dayStartMs } from './holdtime';
import { fmtTime } from './labels';
import { dialog, field, showDialog, textArea } from './ui';

type Subject = Pick<KanbanTaskCard, 'id' | 'status' | 'hold'>;

/** A dialog with Cancel and a confirm button; ✕, Esc and Cancel close it without calling `submit`. */
function ask(title: string, cls: string, body: HTMLElement, confirm: string, submit: () => void) {
  const ok = h('button.btn.primary', { type: 'button' }, confirm) as HTMLButtonElement;
  const no = h('button.btn', { type: 'button' }, 'Cancel');
  const d = dialog(cls, title, h('div.body', {}, body), h('footer', {}, no, ok));
  const modal = showDialog(d);
  no.addEventListener('click', () => modal.close());
  ok.addEventListener('click', () => {
    submit();
    modal.close();
  });
  // Ctrl/Cmd+Enter sends from the text box, as everywhere in the kanban.
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ok.click();
    }
  });
}

/** "Put #N on hold": a reason and a day, both optional. Cancelling (✕, Esc, Cancel) calls nothing. */
export function openHoldDialog(task: Pick<KanbanTaskCard, 'id'>, onSubmit: (extras: { note?: string; until?: number }) => void, now = Date.now()) {
  const note = textArea('', { rows: 3, maxlength: HOLD_NOTE_MAX, placeholder: 'e.g. waiting for the API keys', 'aria-label': 'What is it waiting for?' });
  const until = h('input', { type: 'date', min: dateInputValue(now), 'aria-label': 'Hold until' }) as HTMLInputElement;
  ask(
    `⏸️ Put #${task.id} on hold`,
    'kb-hold-dialog',
    h('div', {}, field('What is it waiting for? (optional)', note), field('Hold until (optional)', until, 'Shown on the card; the task is not resumed by itself.')),
    'Put on hold',
    () => {
      const text = note.value.trim();
      const day = dayStartMs(until.value);
      onSubmit({ ...(text ? { note: text } : {}), ...(day !== undefined ? { until: day } : {}) });
    },
  );
}

/** "Resume #N": what the hold said, and an optional message for the agent. */
export function openResumeDialog(task: Pick<KanbanTaskCard, 'id' | 'hold'>, onSubmit: (extras: { note?: string }) => void, now = Date.now()) {
  const note = textArea('', { rows: 3, maxlength: HOLD_NOTE_MAX, 'aria-label': 'A message for the agent' });
  const since = task.hold ? h('p.kb-hold-since', {}, holdLine(task.hold, now), h('small.kb-muted', {}, ` · since ${fmtTime(task.hold.at)}, by ${task.hold.by}`)) : null;
  ask(
    `▶️ Resume #${task.id}`,
    'kb-hold-dialog',
    h('div', {}, since, field('A message for the agent (optional)', note, 'The agent carries on where it left off, with the comments written while it was on hold.')),
    'Resume',
    () => {
      const text = note.value.trim();
      onSubmit(text ? { note: text } : {});
    },
  );
}

/**
 * Moves that need a dialog first: to On hold (reason, day) and from On hold to In progress (message).
 * Calls `send` with what the move carries, once the dialog is confirmed; never for a cancelled one.
 * Every other move goes straight to `send`.
 */
export function moveWithDialog(id: number, task: Subject | undefined, to: TaskStatus, send: (extras: { note?: string; until?: number }) => void) {
  if (to === 'on_hold') return openHoldDialog({ id }, send);
  if (task?.status === 'on_hold' && to === 'in_progress') return openResumeDialog({ id, hold: task.hold }, send);
  send({});
}

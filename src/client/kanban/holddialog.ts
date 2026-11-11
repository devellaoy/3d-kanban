// The two small dialogs of the On hold column (docs/kanban.md, "On hold"): putting a task on hold (why
// and until when, both optional) and resuming it (a message for the agent, optional), and the one flow
// the board and the task view share: which move needs which dialog, and what the move then carries.

import './holddialog.css';
import { h } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { btn, formField } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import { HOLD_NOTE_MAX, holdWords } from '../../shared/kanban/hold.js';
import type { KanbanTaskCard, TaskStatus } from '../../shared/kanban/types.js';
import { dateInputValue, dayStartMs } from './holdtime';
import { fmtTime } from './labels';
import { textArea } from './ui';

type Subject = Pick<KanbanTaskCard, 'id' | 'status' | 'hold'>;

/** A dialog with Cancel and the one confirm button; ✕, Esc and Cancel close it without calling `submit`. */
function ask(head: { icon: IconName; title: string; id: number }, fields: (Node | null)[], confirm: string, submit: () => void) {
  const ok = btn(confirm, { kind: 'primary' });
  const no = btn('Cancel', { kind: 'quiet' });
  const body = h('div.kb-hold-fields', {}, ...fields);
  const shell = modalShell({ cls: 'kb-hold w480', icon: head.icon, title: head.title, id: `#${head.id}`, label: `${head.title}: task ${head.id}`, body, footerRight: [no, ok] });
  const modal = openShell(shell);
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

/** "Put on hold #N": a reason and a day, both optional. Cancelling (✕, Esc, Cancel) calls nothing. */
export function openHoldDialog(task: Pick<KanbanTaskCard, 'id'>, onSubmit: (extras: { note?: string; until?: number }) => void, now = Date.now()) {
  const note = textArea('', { class: 'inp', rows: 3, maxlength: HOLD_NOTE_MAX, placeholder: 'e.g. waiting for the API keys' });
  const until = h('input.inp.kb-hold-until', { type: 'date', min: dateInputValue(now) }) as HTMLInputElement;
  ask(
    { icon: 'circle-pause', title: 'Put on hold', id: task.id },
    [formField('What is it waiting for?', note, { optional: true }), formField('Hold until', until, { optional: true, hint: 'Shown on the card. The task is not resumed by itself.' })],
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
  const note = textArea('', { class: 'inp', rows: 3, maxlength: HOLD_NOTE_MAX });
  const since = task.hold ? h('p.kb-hold-since', {}, icon('circle-pause', { size: 14 }), h('span', {}, h('strong', {}, holdWords(task.hold, now)), h('small', {}, ` · since ${fmtTime(task.hold.at)}, by ${task.hold.by}`))) : null;
  ask(
    { icon: 'play', title: 'Resume', id: task.id },
    [since, formField('A message for the agent', note, { optional: true, hint: 'The agent carries on where it left off, with the comments written while it was on hold.' })],
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

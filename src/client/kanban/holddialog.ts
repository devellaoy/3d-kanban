// The small dialog of the On hold column (docs/kanban.md, "On hold"): putting a task on hold (why and
// until when, both optional), and the one flow the board and the task view share: which move needs the
// dialog, and what the move then carries. Resuming has no dialog: it only changes the state.

import './holddialog.css';
import { h } from '../ui/dom';
import type { IconName } from '../ui/icons';
import { btn, formField } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import { HOLD_NOTE_MAX } from '../../shared/kanban/hold.js';
import type { KanbanTaskCard, TaskStatus } from '../../shared/kanban/types.js';
import { dateInputValue, dayStartMs } from './holdtime';
import { textArea } from './ui';

/** A dialog with Cancel and the one confirm button; ✕, Esc and Cancel close it without calling `submit`. */
function ask(head: { icon: IconName; title: string; id: number }, fields: (Node | null)[], confirm: { label: string; title: string }, submit: () => void) {
  const ok = btn(confirm.label, { kind: 'primary', attrs: { title: confirm.title } });
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
    { label: 'Put on hold', title: 'Move the task to On hold: its worker goes home and the worktree is kept' },
    () => {
      const text = note.value.trim();
      const day = dayStartMs(until.value);
      onSubmit({ ...(text ? { note: text } : {}), ...(day !== undefined ? { until: day } : {}) });
    },
  );
}

/**
 * The one move that needs a dialog first: to On hold (reason, day). Calls `send` with what the move
 * carries, once the dialog is confirmed; never for a cancelled one. Every other move goes straight to
 * `send`: taking a task off hold only changes its state, so it asks nothing.
 */
export function moveWithDialog(id: number, to: TaskStatus, send: (extras: { note?: string; until?: number }) => void) {
  if (to === 'on_hold') return openHoldDialog({ id }, send);
  send({});
}

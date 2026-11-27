// "Write with AI" on a project's Debugging and testing and Pull-request review instructions (Settings →
// Projects → Project → Instructions): each of the two text boxes gets a button beside its Expand button
// (ui/fieldaction.ts). A press asks the office to have Claude read the project's repositories and write the
// instructions (an empty box) or complete and restructure them (a box with text). While it runs, a status
// line with Cancel stands under the box, which stays the person's to edit. The answer opens a review window:
// nothing goes into the box before "Use this text", and nothing is saved before the settings' own Save.
// What is asked, which answer still counts and what the window says is instructionsdraftmodel.ts's.

import type { InstructionsDraftField } from '../../shared/kanban/instructionsdraft.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import { closeAllModals, h, toast } from '../ui/dom';
import { setFieldAction } from '../ui/fieldaction';
import { icon } from '../ui/icons';
import { btn } from '../ui/kit';
import { modalShell, openShell } from '../ui/shell';
import type { KanbanApi } from './api';
import {
  ACTION_LABEL, ACTION_TITLE, BUSY_TEXT, DraftRuns, INSTRUCTIONS_ANSWER_MS, KeptTexts, RUNNING_TEXT, cancelRequest, clipToField, closesSettingsToo, draftFailure, draftRequest, reviewLead, reviewMode, reviewTitle,
} from './instructionsdraftmodel';
import type { Cleanups } from './settingsflow';

type Draft = Extract<KanbanServerMsg, { t: 'kanban.instructionsDraft' }>;

/** The window the proposal is checked in before it goes anywhere. */
function openReview(which: InstructionsDraftField, field: HTMLTextAreaElement, text: string, keep: () => void) {
  const box = h('textarea.kb-insd-box', { 'aria-label': 'The proposed text', spellcheck: 'false' }) as HTMLTextAreaElement;
  if (field.maxLength >= 0) box.maxLength = field.maxLength;
  box.value = clipToField(text, field.maxLength);
  // The caret at the start, so the focus the window gives the box shows the text from its first line.
  box.setSelectionRange(0, 0);
  const lead = h('p.kb-insd-lead');
  const discard = btn('Discard', { kind: 'quiet', attrs: { title: 'Close this window and go back to the settings, with the field as it is.' } });
  const use = btn('Use this text', { kind: 'primary' });
  const shell = modalShell({ cls: 'kb-insd-review', icon: 'sparkles', title: reviewTitle(which), body: [lead, box], footerRight: [discard, use] });
  // A press beside the window must not throw away what took minutes to write.
  /** Closed by one of the window's own buttons, which go back to the settings. */
  let byButton = false;
  const back = () => {
    byButton = true;
    modal.close();
  };
  const modal = openShell(shell, {
    backdropCloses: false,
    // The 3D office (the page with the scene): its ✕ and Esc leave every window, so the mouse is the game's again at once.
    // What stands unsaved in the instruction boxes is kept for when the settings are opened again.
    onClose: () => {
      if (!closesSettingsToo({ byButton, inOffice: !!document.getElementById('scene') })) return;
      keep();
      closeAllModals();
    },
  });

  const mode = () => reviewMode({ connected: field.isConnected, locked: field.matches(':disabled') || field.readOnly });
  /** What the window says and offers, from the state of the field now (its pane may have been drawn anew underneath). */
  const paint = () => {
    const m = mode();
    lead.textContent = reviewLead(which, m, m === 'use' ? field.value : '');
    use.replaceChildren(...(m === 'use' ? ['Use this text'] : [icon('copy', { size: 16 }), 'Copy text']));
    use.title = m === 'use' ? 'Put this text in the field. It is saved when you press Save in the settings.' : 'Copy the whole text to the clipboard';
    return m;
  };
  let shown = paint();
  const copy = () => {
    const byHand = () => {
      box.focus();
      box.select();
      toast("Couldn't copy: the text is selected, copy it with Ctrl/Cmd+C", 'warn');
    };
    if (!navigator.clipboard?.writeText) return byHand();
    navigator.clipboard.writeText(box.value).then(() => toast('Copied'), byHand);
  };
  use.addEventListener('click', () => {
    const was = shown;
    shown = paint();
    if (shown === 'copy') {
      // The field went while the window was open: the button has just changed, so this press only says so.
      if (was === 'use') return toast('The field is no longer open: copy the text instead', 'warn');
      return copy();
    }
    field.value = clipToField(box.value, field.maxLength);
    // As if typed there: one event, which the field's view and the large editor both listen to.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    back();
    field.focus({ preventScroll: true });
    toast('The text is in the field: press Save to keep it');
  });
  discard.addEventListener('click', back);
}

/** What the instruction boxes held, unsaved, when a review window closed the Settings over them. */
const kept = new KeptTexts();

/**
 * Gives the project's two instruction boxes their "Write with AI" button. `others` are the pane's other
 * instruction boxes: with the two they are what is kept, unsaved, when the review window closes the Settings.
 * `cleanups` are the pane's: when
 * it is drawn anew (another project, a change of rights) the buttons go, a running draft is cancelled at
 * the office and its answer no longer counts.
 */
export function attachInstructionsDraft(api: Pick<KanbanApi, 'request'>, projectId: string, fields: Record<InstructionsDraftField, HTMLTextAreaElement>, cleanups: Cleanups, others: Record<string, HTMLTextAreaElement> = {}): void {
  const runs = new DraftRuns();
  const boxes: Record<string, HTMLTextAreaElement> = { ...others, ...fields };
  const texts = () => Object.fromEntries(Object.entries(boxes).map(([name, el]) => [name, el.value]));
  // Texts a review window's ✕ or Esc took the Settings from, back in their boxes: still unsaved.
  const back = kept.take(projectId, texts());
  for (const [name, text] of Object.entries(back)) boxes[name].value = text;
  if (Object.keys(back).length) toast('Your unsaved instruction texts are back in their boxes: press Save to keep them');
  const status = h('div.kb-insd-status', { role: 'status' });

  /** Ends the running draft, here and at the office. */
  const cancel = (): boolean => {
    if (!runs.drop()) return false;
    status.remove();
    // Whatever the office says to this, the answer of the cancelled run no longer counts here.
    api.request(cancelRequest(projectId)).catch(() => {});
    return true;
  };

  const start = (which: InstructionsDraftField) => {
    const field = fields[which];
    const n = runs.start(which);
    if (n === null) return void toast(BUSY_TEXT, 'warn');
    const stop = btn('Cancel', { kind: 'quiet', size: 'xs' });
    stop.addEventListener('click', () => void cancel());
    status.replaceChildren(icon('loader', { size: 14 }), h('span', {}, RUNNING_TEXT), stop);
    // Right under the box it is written for, before the box's hint.
    field.after(status);
    const over = () => {
      if (!runs.settle(n)) return false;
      status.remove();
      return true;
    };
    api.request<Draft>(draftRequest(projectId, which, field.value), INSTRUCTIONS_ANSWER_MS).then(
      (answer) => {
        if (!over()) return;
        if (!answer.text?.trim()) return void toast(draftFailure('the answer was empty') ?? '', 'error');
        openReview(which, field, answer.text, () => field.isConnected && kept.keep(projectId, texts()));
      },
      (err) => {
        const why = over() ? draftFailure(err) : null;
        if (why) toast(why, 'error');
      },
    );
  };

  for (const which of ['testing', 'prReview'] as const) {
    cleanups.add(setFieldAction(fields[which], { icon: 'sparkles', label: ACTION_LABEL, title: ACTION_TITLE, run: () => start(which) }));
  }
  // The pane going (another project or tab, the settings closed) ends the run: said aloud, since minutes of waiting end with it.
  cleanups.add(() => {
    if (cancel()) toast('Writing the instructions was cancelled, because the project’s settings page was left', 'warn');
  });
}

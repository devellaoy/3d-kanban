// Changing the issue a task is about, from its Issue tab (issuetab.ts), whatever the task's status but
// the archive: one button picks an issue from the project's issues (the picker of the new-task form),
// one takes a key typed by hand (a project may have no issue source, or the issue isn't on its list)
// and one unlinks. All three send kanban.task.update with the ticket and its link; the task the office
// then broadcasts is what makes the tab show the new issue.
//
// The buttons and the form are built once and live as long as the tab: the task view redraws on every
// update, and what is being typed (and the keyboard's place, by data-focus) has to outlive that.

import './issuelink.css';
import { h, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { btn } from '../ui/kit';
import { confirmDialog } from '../ui/prompt';
import { KANBAN_LIMITS } from '../../shared/kanban/protocol.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { KanbanApi, KanbanOk } from './api';
import { canChangeIssue, pickedPatch, sameIssue, savedText, typedPatch, unlinkPatch, type TicketPatch } from './issuelinkmodel';
import { run, textInput } from './ui';

export interface IssueLink {
  /** The buttons, for the tab's bar: none of them shows on an archived task. */
  buttons: HTMLElement[];
  /** The key-by-hand form, hidden until "Type a key" opens it. */
  form: HTMLElement;
  /** The task as it is now. */
  set(task: KanbanTask): void;
}

export function issueLink(api: KanbanApi): IssueLink {
  let task: KanbanTask | null = null;
  const pickWords = h('span');
  const pick = h('button.btn.secondary.sm', { type: 'button', 'data-focus': 'issue-pick' }, icon('link', { size: 14 }), pickWords) as HTMLButtonElement;
  const type = btn('Type a key', { size: 'sm', icon: 'keyboard', attrs: { title: 'Type the issue’s key and link by hand', 'aria-expanded': 'false', 'data-focus': 'issue-type' } });
  const unlink = btn('Unlink', { kind: 'quiet', size: 'sm', icon: 'unlink', attrs: { title: 'Take the issue off the task (the issue itself is not touched)', 'data-focus': 'issue-unlink' } });
  const key = textInput('', { maxlength: KANBAN_LIMITS.ticket, placeholder: 'UYT-1415 / gh:owner/repo#12', 'aria-label': 'Issue key', 'data-focus': 'issue-key' });
  const link = textInput('', { maxlength: KANBAN_LIMITS.url, placeholder: 'https://… (optional)', type: 'url', 'aria-label': 'Issue link', 'data-focus': 'issue-link' });
  const saveBtn = btn('Save', { kind: 'primary', size: 'sm', attrs: { type: 'submit', 'data-focus': 'issue-save' } });
  const cancel = btn('Cancel', { kind: 'quiet', size: 'sm', attrs: { 'data-focus': 'issue-cancel' } });
  const form = h('form.kb-il-form.hidden', { 'aria-label': 'The issue’s key and link' }, key, link, saveBtn, cancel) as HTMLFormElement;

  const opened = () => !form.classList.contains('hidden');
  const open = (on: boolean) => {
    form.classList.toggle('hidden', !on);
    type.setAttribute('aria-expanded', String(on));
    if (!on) return;
    key.value = task?.ticket ?? '';
    link.value = task?.ticketUrl ?? '';
    key.focus();
    key.select();
  };

  /** Sends the patch for the task shown now; true once the office has taken it. */
  const save = async (patch: TicketPatch, button: HTMLButtonElement): Promise<boolean> => {
    const t = task;
    if (!t || !canChangeIssue(t)) return false;
    if (sameIssue(t, patch)) {
      toast(patch.ticket ? `${patch.ticket} is already this task’s issue` : 'No issue is linked');
      return true;
    }
    return !!(await run(() => api.request<KanbanOk>({ t: 'kanban.task.update', id: t.id, patch }), button, savedText(patch)));
  };

  pick.addEventListener('click', () => {
    const t = task;
    if (!t) return;
    // The picker opens over the task's window and closes back onto it: the keyboard returns to the button.
    void import('./issues').then(
      (m) => m.openIssuePicker(api, t.project, (issue) => void (task?.id === t.id && save(pickedPatch(issue), pick).then((ok) => ok && open(false))), () => pick.focus()),
      (err: Error) => toast(err.message, 'error'),
    );
  });
  type.addEventListener('click', () => open(!opened()));
  cancel.addEventListener('click', () => {
    open(false);
    type.focus();
  });
  // The old issue's link under a new key would be the wrong one: it goes as the key changes.
  key.addEventListener('input', () => {
    if (task?.ticketUrl && link.value.trim() === task.ticketUrl && key.value.trim() !== (task.ticket ?? '')) link.value = '';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = typedPatch(key.value, link.value, task ?? {});
    if (typeof patch === 'string') {
      toast(patch, 'warn');
      (/link/i.test(patch) ? link : key).focus();
      return;
    }
    void save(patch, saveBtn).then((ok) => ok && open(false));
  });
  unlink.addEventListener('click', () => {
    const t = task;
    if (!t?.ticket) return;
    confirmDialog(`Unlink ${t.ticket} from task #${t.id}?`, 'The issue itself is not touched, and another one can be linked afterwards.', 'Unlink', () => void (task?.id === t.id && save(unlinkPatch(), unlink).then((ok) => ok && open(false))));
  });

  return {
    buttons: [pick, type, unlink],
    form,
    set(next) {
      const moved = !!task && (task.id !== next.id || task.ticket !== next.ticket || task.ticketUrl !== next.ticketUrl);
      task = next;
      const can = canChangeIssue(next);
      pickWords.textContent = next.ticket ? 'Change issue' : 'Link an issue';
      pick.title = next.ticket ? 'Pick another of the project’s issues for this task' : 'Pick one of the project’s issues for this task';
      pick.classList.toggle('hidden', !can);
      type.classList.toggle('hidden', !can);
      unlink.classList.toggle('hidden', !can || !next.ticket);
      // The issue changed under the form (saved here, or by someone else), or the task went to the archive: what it held is stale.
      if (opened() && (moved || !can)) open(false);
    },
  };
}

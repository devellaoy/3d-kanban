// The Overview's "what it waits for" box: the reason, a retry countdown, and a box to answer when the
// agent asked something (taskview.ts).

import { h, toast } from '../ui/dom';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { countdown } from './model';
import { COUNTDOWN_UNITS, waitingName } from './labels';
import { renderMarkdown } from './md';
import { sendHint } from './sendkey';
import type { TaskCtx } from './taskctx';

/** What the task waits for, with a box to answer when it asked something. */
export function waitingBox(c: TaskCtx, task: KanbanTask): HTMLElement | null {
  if (task.status !== 'waiting' || !task.waitingReason) return null;
  const open = (id: number) => c.openTask(id);
  const box = h('section.kb-waiting', { class: task.waitingReason }, h('h4', {}, `🙋 ${waitingName(task.waitingReason)}`), task.waitingText ? renderMarkdown(task.waitingText, open, '') : null);
  if (task.retryAt) {
    box.append(
      h('p.kb-retry', { 'data-retry-at': String(task.retryAt) }, `🔁 retries in ${countdown(task.retryAt, Date.now(), COUNTDOWN_UNITS)}`),
      h('small.kb-muted', {}, `Tried ${task.retryAttempts} times so far`),
    );
  }
  // An agent asking in its terminal gets an answer from here only for a question (askingKind): a
  // permission prompt, or one the office can't tell, is answered in its terminal.
  if (task.waitingReason === 'agent_asking' && task.askingKind !== 'question') {
    const workerId = task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
    const open = workerId && c.o.openTerminal ? h('button.btn.small', { type: 'button', onclick: () => c.o.openTerminal?.(workerId, task.project) }, '⌨️ Open its terminal') : null;
    const what = task.askingKind === 'permission' ? 'The agent asks for a permission — answer it in its terminal' : 'The agent waits on something in its terminal — answer it there';
    box.append(h('div.kb-row', {}, h('b', {}, what), open), h('small.kb-muted', {}, 'A comment waits until that turn is over.'));
    return box;
  }
  if (task.waitingReason === 'plan_questions' || task.waitingReason === 'agent_asking') {
    const asking = task.waitingReason === 'agent_asking';
    const fb = c.fileBox('answer', { rows: 4, placeholder: asking ? 'Your answer…' : 'Your answers… (paste or drop files)', 'aria-label': asking ? 'Answer the agent' : 'Answer' });
    const { ta, attach, wrap } = fb;
    const send = h('button.btn.primary', { type: 'button' }, 'Send the answer') as HTMLButtonElement;
    const go = async () => {
      const answer = ta.value.trim();
      const ids = attach.ids();
      if (!answer && !ids.length) return ta.focus();
      if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
      const ok = await c.req({ t: 'kanban.task.continue', id: task.id, answer, ...(ids.length ? { attachmentIds: ids } : {}) }, send, 'Answer sent');
      if (ok) {
        ta.value = '';
        attach.clear();
        c.drafts().delete('answer');
      }
    };
    send.addEventListener('click', () => void go());
    fb.go = () => void go();
    if (asking) {
      // The asking worker is the reviewer during a review round, else the implementer.
      const workerId = task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
      const open = workerId && c.o.openTerminal ? h('button.btn.small', { type: 'button', onclick: () => c.o.openTerminal?.(workerId, task.project) }, '⌨️ Open its terminal') : null;
      box.append(h('div.kb-row', {}, h('b', {}, 'Answer the agent'), h('small.kb-muted', {}, 'It is typed into its terminal, as if you typed it there.'), open));
    }
    wrap.replaceChildren(ta, h('div.kb-row', {}, attach.el, h('span.grow'), send), h('small.kb-muted', {}, sendHint()));
    box.append(wrap);
  }
  return box;
}

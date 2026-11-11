// The Overview's "what it waits for" banner: the reason, a retry countdown, the way to the plan or the
// terminal, and under it a box to answer when the agent asked something (taskview.ts).

import { h, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { banner, btn } from '../ui/kit';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { countdown } from './model';
import { COUNTDOWN_UNITS, waitingName } from './labels';
import { renderMarkdown } from './md';
import { sendHint } from './sendkey';
import type { TaskCtx } from './taskctx';

/** The attribute of a countdown the view keeps ticking (retryText() is what it says). */
export const RETRY_ATTR = 'data-tv-retry-at';
export const retryText = (at: number, now = Date.now()) => `Retries in ${countdown(at, now, COUNTDOWN_UNITS)}`;

/** What the task waits for, with a box to answer when it asked something. */
export function waitingBox(c: TaskCtx, task: KanbanTask): HTMLElement | null {
  if (task.status !== 'waiting' || !task.waitingReason) return null;
  const reason = task.waitingReason;
  const open = (id: number) => c.openTask(id);
  const asking = reason === 'agent_asking';
  // An agent asking in its terminal gets an answer from here only for a question (askingKind): a
  // permission prompt, or one the office can't tell, is answered in its terminal.
  const inTerminal = asking && task.askingKind !== 'question';
  // The asking worker is the reviewer during a review round, else the implementer.
  const workerId = task.phase === 'review' || task.phase === 'pr-review' ? task.reviewerWorkerId : task.workerId;
  const terminal = asking && workerId && c.o.openTerminal ? () => c.o.openTerminal?.(workerId, task.project) : undefined;

  // A plan that waits says which version it is when the office gave no words of its own.
  const version = reason === 'plan_approval' ? c.detail?.plans.reduce((n, p) => Math.max(n, p.version), 0) : 0;
  const said = task.waitingText ? renderMarkdown(task.waitingText, open, '') : version ? h('span', {}, `Plan version ${version} is ready. Nothing is implemented until you approve it or ask for changes.`) : null;
  const lines: (Node | null)[] = [said];
  if (task.retryAt) {
    lines.push(h('span.kb-retry', {}, icon('rotate-cw', { size: 13 }), h('span', { [RETRY_ATTR]: String(task.retryAt) }, retryText(task.retryAt)), h('small.kb-muted', {}, `· tried ${task.retryAttempts} times so far`)));
  }
  if (inTerminal) {
    lines.push(
      h('b', {}, task.askingKind === 'permission' ? 'The agent asks for a permission: answer it in its terminal.' : 'The agent waits on something in its terminal: answer it there.'),
      h('small.kb-muted', {}, 'A comment waits until that turn is over.'),
    );
  } else if (asking) lines.push(h('small.kb-muted', {}, 'Your answer is typed into its terminal, as if you typed it there.'));

  const top = banner({
    icon: 'hand',
    title: waitingName(reason),
    text: lines.some(Boolean) ? h('span.kb-wait-lines', {}, ...lines) : undefined,
    link: reason === 'plan_approval' ? { label: 'Open the plan', onClick: () => c.setTab('plan') } : terminal ? { label: 'Open the terminal', onClick: terminal } : undefined,
  });
  const box = h('section.kb-waiting', { class: reason }, top);
  if (inTerminal || (reason !== 'plan_questions' && !asking)) return box;

  const fb = c.fileBox('answer', { rows: 4, placeholder: asking ? 'Your answer…' : 'Your answers… (paste or drop files)', 'aria-label': asking ? 'Answer the agent' : 'Answer' });
  const { ta, attach, wrap } = fb;
  const send = btn('Send the answer', { kind: 'primary', icon: 'send', size: 'sm', attrs: { 'data-focus': 'act-answer' } });
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
  wrap.replaceChildren(ta, h('div.composite-bar', {}, attach.el, h('span.composite-note', {}, sendHint()), send));
  box.append(wrap);
  return box;
}

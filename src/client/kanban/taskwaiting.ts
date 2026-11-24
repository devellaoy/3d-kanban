// The Overview's "what it waits for" banner: the reason, a retry countdown, the way to the plan or the
// terminal, and under it a box to answer when the agent asked something (taskview.ts; asking.ts for
// what an asking task shows).

import { h, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { banner, btn } from '../ui/kit';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { askingView } from './asking';
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
  // An agent that asked something: in a live terminal, or with its run over (asking.ts says which, and what the view shows of it).
  const asking = reason === 'agent_asking' ? askingView(task, c.detail?.runs) : undefined;
  const inTerminal = !!asking && !asking.answerBox;
  const workerId = asking?.terminalOf;
  const terminal = workerId && c.o.openTerminal ? () => c.o.openTerminal?.(workerId, task.project) : undefined;

  // A plan that waits says which version it is when the office gave no words of its own.
  const version = reason === 'plan_approval' ? c.detail?.plans.reduce((n, p) => Math.max(n, p.version), 0) : 0;
  const said = task.waitingText ? renderMarkdown(task.waitingText, open, '') : version ? h('span', {}, `Plan version ${version} is ready. Nothing is implemented until you approve it or ask for changes.`) : null;
  const lines: (Node | null)[] = [said];
  if (task.retryAt) {
    lines.push(h('span.kb-retry', {}, icon('rotate-cw', { size: 13 }), h('span', { [RETRY_ATTR]: String(task.retryAt) }, retryText(task.retryAt)), h('small.kb-muted', {}, `· tried ${task.retryAttempts} times so far`)));
  }
  if (asking) lines.push(asking.instruction ? h('b', {}, asking.instruction) : null, h('small.kb-muted', {}, asking.note));

  const top = banner({
    icon: 'hand',
    title: asking?.title ?? waitingName(reason),
    text: lines.some(Boolean) ? h('span.kb-wait-lines', {}, ...lines) : undefined,
    link: reason === 'plan_approval' ? { label: 'Open the plan', onClick: () => c.setTab('plan') } : terminal ? { label: 'Open the terminal', onClick: terminal } : undefined,
  });
  const box = h('section.kb-waiting', { class: reason }, top);
  if (inTerminal || (reason !== 'plan_questions' && !asking)) return box;

  const fb = c.fileBox('answer', { rows: 4, placeholder: asking ? 'Your answer…' : 'Your answers… (paste or drop files)', 'aria-label': asking ? 'Answer the agent' : 'Answer' });
  const { ta, attach, wrap } = fb;
  const send = btn('Send the answer', { kind: 'primary', icon: 'send', size: 'sm', attrs: { 'data-focus': 'act-answer', title: asking ? asking.sendTitle : 'Give the agent your answers: it carries on with them' } });
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

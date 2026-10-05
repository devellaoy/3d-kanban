// A worker's card: who it is, what it's on and how it's doing, in a tap target. The 2D view's list (lite.ts)
// and the in-game phone (phone/ui.ts) both use it, so it knows nothing of three.js (see client-structure.test.ts).
import './workercard.css';
import { store } from '../state';
import { DESK_BY_ID } from '../../shared/layout';
import { isAsleep, shownStatus } from '../../shared/status';
import type { ProjectInfo, WorkerInfo } from '../../shared/protocol';
import { clip, h, STATUS_LABEL, timeAgo } from '../ui/dom';
import { modelBadge, providerLabel } from '../ui/provider';
import { kanbanChip } from '../kanban/office';
import { waitingOnSomeone } from '../notify';

export interface WorkerCardOpts {
  /** The card was tapped. */
  onOpen(id: string): void;
  /** The ✍️ button; without it there is none. */
  onPrompt?(id: string): void;
  /** The project the worker's floor has, for its provider's name (default: your floor's). */
  project?: ProjectInfo | null;
  /** Sets the card button's `data-key`, for keeping its focus across a redraw (see refocus.ts). */
  key?: string;
}

/** The card of one worker, a list item. */
export function workerCard(w: WorkerInfo, opts: WorkerCardOpts): HTMLElement {
  const desk = DESK_BY_ID.get(w.deskId);
  const waiting = waitingOnSomeone(w);
  const asleep = isAsleep(w.status);
  const badge = w.kind === 'agent' ? modelBadge(w.provider, w.model, w.effort) : undefined;
  const task = w.task?.name ?? w.title ?? (w.prompt ? clip(w.prompt, 90) : undefined);
  // What it's asking, doing or did, in a line.
  const now = w.lost
    ? '🌿 Its worktree was deleted outside agent-office: open it to fix it'
    : shownStatus(w) === 'needs_input'
      ? `🙋 ${w.activity ?? 'Waiting on an answer'}`
      : asleep
        ? '💤 Asleep: open it to wake it up'
        : w.status === 'done'
          ? w.task?.summary && `✅ ${w.task.summary}`
          : (w.task?.summary ?? w.activity);
  const sub = [
    w.kanban && kanbanChip(w, Date.now()),
    w.kind === 'agent' ? `⚙️ ${providerLabel(w.provider, opts.project === undefined ? store.project : opts.project)}${badge ? ` · ${badge}` : ''}` : '🐚 shell',
    desk && (desk.station ? `📌 ${desk.label}` : desk.label),
    w.worktree && `🌿 ${w.worktree.branch}`,
    w.pr && `🔀 PR #${w.pr.number}`,
    w.lastInput && `⌨️ ${w.lastInput.by} ${timeAgo(w.lastInput.at)}`,
  ].filter(Boolean);
  return h(
    'li.lite-worker',
    { class: `${shownStatus(w)}${waiting ? ' waiting' : ''}` },
    h(
      'button.lite-card',
      { type: 'button', ...(opts.key ? { 'data-key': opts.key } : {}), onclick: () => opts.onOpen(w.id), 'aria-label': `${w.name}, ${STATUS_LABEL[w.status] ?? w.status}: open its terminal` },
      h('span.dot', { style: `background:${w.color}` }),
      h(
        'span.lite-info',
        {},
        h('span.lite-name', {}, w.name),
        task ? h('span.lite-task', {}, task) : null,
        now ? h('span.lite-now', {}, now) : null,
        h('span.lite-sub', {}, sub.join(' · ')),
      ),
      h('span.lite-state', {}, h('span.pill', { class: shownStatus(w) }, STATUS_LABEL[shownStatus(w)] ?? w.status), waiting && w.waitingSince ? h('small', {}, timeAgo(w.waitingSince)) : null),
    ),
    // One that's asking something is answered in its terminal, where the question is.
    !opts.onPrompt || asleep || w.lost || w.status === 'needs_input' ? null : h('button.btn.lite-say', { type: 'button', title: `Send ${w.name} a prompt`, 'aria-label': `Send ${w.name} a prompt`, onclick: () => opts.onPrompt!(w.id) }, '✍️'),
  );
}

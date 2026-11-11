// One task on the board: a card with what a glance needs. On top its #id, the dot while the engine works
// on it, the phase and review round, the agent and the move button; then the title, a note (why it waits,
// what it is on hold for, when it retries), and a row of its ticket, each repository's PR and its comment
// counts. How a card looks (a flat card or a leaning sticky note with a pin) is the theme's.

import { h } from '../ui/dom';
import { icon, iconButton } from '../ui/icons';
import type { KanbanProjectInfo, KanbanTaskCard } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { holdWords } from '../../shared/kanban/hold.js';
import { countdown, needsAttention, phaseBadge, prTone } from './model';
import { COUNTDOWN_UNITS, phaseName, PR_STATE_NAMES, toolName, waitingName } from './labels';

const TILTS = ['-0.8deg', '0.6deg', '-0.3deg', '0.9deg', '0deg', '-0.6deg'];
/** The pins' colours, from the theme (a look without pins sets --pin-size to 0). */
const PINS = ['var(--bad)', 'var(--teal)', 'var(--good)', 'var(--warn)'];

export interface CardHandlers {
  open(id: number): void;
  moveMenu(id: number, anchor: HTMLElement): void;
  dragStart(card: KanbanTaskCard, e: DragEvent): void;
  dragEnd(): void;
}

/** A ticket's chip: a link when it has one. */
export function ticketChip(ticket: string, url?: string): HTMLElement {
  return url
    ? h('a.kb-chip.ticket', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the ticket', onclick: ((e: Event) => e.stopPropagation()) as EventListener }, icon('ticket', { size: 12 }), ticket)
    : h('span.kb-chip.ticket', {}, icon('ticket', { size: 12 }), ticket);
}

const retryWords = (at: number, now: number) => `retries in ${countdown(at, now, COUNTDOWN_UNITS)}`;

/** The note under the title: why the task waits (with its countdown), or what it is on hold for. */
function cardNote(c: KanbanTaskCard, now: number): HTMLElement | null {
  const retry = c.retryAt ? h('span.kb-retry', { 'data-retry-at': String(c.retryAt) }, retryWords(c.retryAt, now)) : null;
  if (c.status === 'waiting' && c.waitingReason) {
    const limit = c.waitingReason === 'usage_limit';
    const why = limit && retry ? 'Usage limit' : `${waitingName(c.waitingReason)}${c.waitingText ? `: ${c.waitingText}` : ''}`;
    return h('div.kb-note.kb-wait', { class: needsAttention(c) ? 'attention' : '' }, icon(limit ? 'hourglass' : 'hand', { size: 14 }), h('span', {}, why, retry ? ': ' : null, retry));
  }
  if (c.status === 'on_hold' && c.hold) {
    return h('div.kb-note.kb-hold', { class: c.hold.until !== undefined && c.hold.until < now ? 'passed' : '', title: `On hold since ${new Date(c.hold.at).toLocaleString()}, by ${c.hold.by}` }, icon('circle-pause', { size: 14 }), h('span', {}, holdWords(c.hold, now)));
  }
  return retry ? h('div.kb-note', {}, icon('rotate-cw', { size: 14 }), h('span', {}, retry)) : null;
}

export function taskCard(c: KanbanTaskCard, project: KanbanProjectInfo | undefined, showProject: boolean, handlers: CardHandlers, now = Date.now()): HTMLElement {
  const running = isRunning(c) && c.status !== 'done';
  const badge = phaseBadge(c);
  const meta: (Node | null)[] = [];
  if (showProject && project) meta.push(h('span.kb-chip.project', { title: 'Project' }, icon('building-2', { size: 12 }), project.name));
  if (c.ticket) meta.push(ticketChip(c.ticket, c.ticketUrl));
  for (const p of c.prs) {
    const repo = project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId;
    const state = PR_STATE_NAMES[prTone(p.state)];
    const label = `${repo} #${p.number}: ${state}`;
    meta.push(
      h(
        'a.kb-pr',
        // The parts below are spaced by CSS, so the label gives screen readers the words apart.
        { class: prTone(p.state), href: p.url, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label, onclick: ((e: Event) => e.stopPropagation()) as EventListener },
        icon('git-pull-request', { size: 12 }),
        // The repository's name shrinks to an ellipsis on a narrow card; the number always shows.
        project && project.repos.length > 1 ? h('span.kb-pr-repo', {}, repo) : null,
        h('span.kb-pr-num', {}, `#${p.number} ${state}`),
      ),
    );
  }
  if (c.type === 'investigate') meta.push(h('span.kb-chip.type', {}, 'Investigate'));
  for (const tag of c.tags.slice(0, 3)) meta.push(h('span.kb-chip.tag', {}, `#${tag}`));

  const moveBtn = iconButton('ellipsis', `Move #${c.id}`, { class: 'xs kb-move' });
  moveBtn.title = 'Move to another column (M)';
  moveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handlers.moveMenu(c.id, moveBtn);
  });

  const el = h(
    'article.kb-card',
    {
      class: [running ? 'running' : '', needsAttention(c) ? 'attention' : '', c.status].filter(Boolean).join(' '),
      style: `--tilt:${TILTS[c.id % TILTS.length]};--pin:${PINS[c.id % PINS.length]}`,
      tabindex: 0,
      draggable: 'true',
      'data-id': String(c.id),
      'aria-label': `#${c.id} ${c.title}`,
      'aria-describedby': `kbc-${c.id}-meta`,
    },
    h(
      'div.kb-card-top',
      {},
      h('span.kb-id', {}, `#${c.id}`),
      running ? h('span.run-dot', { role: 'img', title: 'Running', 'aria-label': 'Running' }) : null,
      badge ? h('span.kb-phase', { class: badge.phase }, `${phaseName(badge.phase)}${badge.round ? ` ${badge.round}` : ''}`) : null,
      h('span.kb-tool', { title: `${toolName(c.tool)}${c.model ? ` · ${c.model}` : ''}${c.reviewTool && c.useReview ? ` · Reviewer: ${toolName(c.reviewTool)}` : ''}` }, icon('bot', { size: 12 }), h('span', {}, toolName(c.tool))),
      moveBtn,
    ),
    h('div.kb-title', {}, c.title),
    cardNote(c, now),
    h(
      'div.kb-meta',
      { id: `kbc-${c.id}-meta` },
      ...meta,
      h(
        'span.kb-counts',
        {},
        c.pendingCount ? h('span.kb-pending', { title: 'Written while the agent was busy: it gets it at its next pause', 'aria-label': `${c.pendingCount} waiting for the agent` }, icon('mail', { size: 12 }), String(c.pendingCount)) : null,
        h('span', { title: 'Comments', 'aria-label': `${c.commentCount} comment${c.commentCount === 1 ? '' : 's'}` }, icon('message-square', { size: 12 }), String(c.commentCount)),
      ),
    ),
  );
  el.addEventListener('click', () => handlers.open(c.id));
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlers.open(c.id);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      handlers.moveMenu(c.id, moveBtn);
    }
  });
  el.addEventListener('dragstart', (e) => handlers.dragStart(c, e));
  el.addEventListener('dragend', () => handlers.dragEnd());
  return el;
}

/** Brings every retry countdown on the page up to date (once a second, rather than redrawing the board). */
export function tickCountdowns(root: ParentNode, now = Date.now()) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-retry-at]')) {
    const at = Number(el.dataset.retryAt);
    el.textContent = retryWords(at, now);
  }
}

// One task on the board: a sticky note like upstream's issue cards, with the badges a glance needs —
// #id, title, ticket, the phase and review round, the tool, each repository's PR,
// why it waits and when it retries. A pulsing dot while the engine works on it.

import { h } from '../ui/dom';
import type { KanbanProjectInfo, KanbanTaskCard } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { holdLine } from '../../shared/kanban/hold.js';
import { countdown, needsAttention, phaseBadge, prTone } from './model';
import { COUNTDOWN_UNITS, phaseName, PR_STATE_NAMES, toolName, waitingName } from './labels';

const TILTS = ['-0.8deg', '0.6deg', '-0.3deg', '0.9deg', '0deg', '-0.6deg'];
const PINS = ['#ef476f', '#118ab2', '#06d6a0', '#ffd166'];

export const TOOL_ICON: Record<KanbanTaskCard['tool'], string> = { claude: '🟠', codex: '🔷' };

export interface CardHandlers {
  open(id: number): void;
  moveMenu(id: number, anchor: HTMLElement): void;
  dragStart(card: KanbanTaskCard, e: DragEvent): void;
  dragEnd(): void;
}

/** A ticket's chip: a link when it has one. */
export function ticketChip(ticket: string, url?: string): HTMLElement {
  const label = `🎫 ${ticket}`;
  return url
    ? h('a.kb-chip.ticket', { href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the ticket', onclick: ((e: Event) => e.stopPropagation()) as EventListener }, label)
    : h('span.kb-chip.ticket', {}, label);
}

export function taskCard(c: KanbanTaskCard, project: KanbanProjectInfo | undefined, showProject: boolean, handlers: CardHandlers, now = Date.now()): HTMLElement {
  const running = isRunning(c) && c.status !== 'done';
  const badge = phaseBadge(c);
  const chips: (Node | null)[] = [];
  if (showProject && project) chips.push(h('span.kb-chip.project', { title: 'Project' }, `🏢 ${project.name}`));
  if (c.ticket) chips.push(ticketChip(c.ticket, c.ticketUrl));
  if (c.type === 'investigate') chips.push(h('span.kb-chip.type', {}, '🔎 Investigate'));
  for (const tag of c.tags.slice(0, 3)) chips.push(h('span.kb-chip.tag', {}, `#${tag}`));

  const prs = c.prs.length
    ? h(
        'div.kb-prs',
        {},
        ...c.prs.map((p) => {
          const repo = project?.repos.find((r) => r.id === p.repoId)?.name ?? p.repo ?? p.repoId;
          const label = `${repo} #${p.number}: ${PR_STATE_NAMES[prTone(p.state)]}`;
          return h(
            'a.kb-pr',
            // The parts below are spaced by CSS, so the label gives screen readers the words apart.
            { class: prTone(p.state), href: p.url, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label, onclick: ((e: Event) => e.stopPropagation()) as EventListener },
            '🔀',
            // The repository's name shrinks to an ellipsis on a narrow card; the number always shows.
            project && project.repos.length > 1 ? h('span.kb-pr-repo', {}, repo) : null,
            h('span.kb-pr-num', {}, `#${p.number}`),
          );
        }),
      )
    : null;

  const waitLine =
    c.status === 'waiting' && c.waitingReason
      ? h('div.kb-wait', { class: needsAttention(c) ? 'attention' : '' }, `${c.waitingReason === 'usage_limit' ? '⏳' : '🙋'} ${waitingName(c.waitingReason)}${c.waitingText ? `: ${c.waitingText}` : ''}`)
      : null;
  const holdText = c.status === 'on_hold' && c.hold ? h('div.kb-hold', { class: c.hold.until !== undefined && c.hold.until < now ? 'passed' : '', title: `On hold since ${new Date(c.hold.at).toLocaleString()}, by ${c.hold.by}` }, holdLine(c.hold, now)) : null;
  const retry = c.retryAt ? h('div.kb-retry', { 'data-retry-at': String(c.retryAt) }, `🔁 retries in ${countdown(c.retryAt, now, COUNTDOWN_UNITS)}`) : null;

  const moveBtn = h('button.kb-move', { type: 'button', 'aria-label': `Move #${c.id}`, title: 'Move to another column (M)' }, '⋯');
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
      running ? h('span.kb-pulse', { title: 'Running', 'aria-label': 'Running' }) : null,
      badge ? h('span.kb-phase', { class: badge.phase }, `${phaseName(badge.phase)}${badge.round ? ` ${badge.round}` : ''}`) : null,
      h('span.kb-tool', { title: `${toolName(c.tool)}${c.model ? ` · ${c.model}` : ''}${c.reviewTool && c.useReview ? ` · Reviewer: ${toolName(c.reviewTool)}` : ''}` }, TOOL_ICON[c.tool]),
      moveBtn,
    ),
    h('div.kb-title', {}, c.title),
    chips.length ? h('div.kb-chips', { id: `kbc-${c.id}-meta` }, ...chips) : h('span.hidden', { id: `kbc-${c.id}-meta` }),
    prs,
    waitLine,
    holdText,
    retry,
    c.commentCount || c.pendingCount
      ? h('div.kb-foot', {}, c.commentCount ? h('span', { title: 'Comments' }, `💬 ${c.commentCount}`) : null, c.pendingCount ? h('span.kb-pending', { title: 'Written while the agent was busy: it gets it at its next pause' }, `✉️ ${c.pendingCount} waiting`) : null)
      : null,
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
    el.textContent = `🔁 retries in ${countdown(at, now, COUNTDOWN_UNITS)}`;
  }
}

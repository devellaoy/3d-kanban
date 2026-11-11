// The task view's Runs and Terminal tabs: every phase the task ran with its history, and the workers
// whose terminals can be opened (taskview.ts).

import { h } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { btn, phaseBadge } from '../ui/kit';
import { store } from '../state';
import type { KanbanEvent, KanbanRole, KanbanRun, KanbanTask, ReviewVerdict, RunStatus } from '../../shared/kanban/types.js';
import { effortName, fmtDuration, fmtTime, toolName } from './labels';
import { renderMarkdown } from './md';
import type { Detail, TaskCtx } from './taskctx';

const ROLE_NAMES: Record<KanbanRole, string> = { implementer: 'Implementer', reviewer: 'Reviewer' };
const RUN_STATUS_NAMES: Record<RunStatus, string> = { running: 'running', succeeded: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
const VERDICTS: Record<ReviewVerdict, [IconName, string]> = { approved: ['check', 'approved'], changes_requested: ['wrench', 'changes requested'] };

export function runsPane(c: TaskCtx, d: Detail): HTMLElement[] {
  const runs = [...d.runs].sort((a, b) => b.startedAt - a.startedAt);
  const out: HTMLElement[] = [];
  out.push(runs.length ? h('ol.kb-runs', {}, ...runs.map((r) => runItem(r, (id) => c.openTask(id)))) : h('p.kb-muted', {}, 'Nothing has run yet.'));
  if (d.events.length) out.push(h('details.kb-events', {}, h('summary', {}, `History (${d.events.length})`), h('ul', {}, ...[...d.events].sort((a, b) => b.at - a.at).map(eventItem))));
  return out;
}

function workersOf(task: KanbanTask): { id: string; role: 'implementer' | 'reviewer' }[] {
  return [
    ...(task.workerId ? [{ id: task.workerId, role: 'implementer' as const }] : []),
    ...(task.reviewerWorkerId ? [{ id: task.reviewerWorkerId, role: 'reviewer' as const }] : []),
  ];
}

/** A worker's line: its name and state when the page knows it (it's on the floor the page is on). */
function workerLabel(id: string, role: KanbanRole, project: string): HTMLElement {
  const w = store.workers.get(id);
  return h(
    'div.kb-worker',
    {},
    h('span.dot', { style: w?.color ? `background:${w.color}` : undefined }),
    h('b', {}, w?.name ?? ROLE_NAMES[role]),
    h('small.kb-muted', {}, w ? `${ROLE_NAMES[role]} · ${w.status}` : store.floor === project ? 'That worker isn’t here any more' : 'on the project’s floor'),
  );
}

export function terminalPane(c: TaskCtx, task: KanbanTask): HTMLElement[] {
  const ws = workersOf(task);
  if (!ws.length) return [h('p.kb-muted', {}, 'No worker is on this task now. Starting it, a comment or an action hires one.')];
  return [
    h('p.kb-muted', {}, 'The worker’s live terminal, as at its desk: you can type in it too.'),
    ...ws.map((w) =>
      h(
        'div.kb-worker-row',
        {},
        workerLabel(w.id, w.role, task.project),
        c.o.openTerminal ? btn('Open the terminal', { icon: 'square-terminal', attrs: { 'data-focus': `term-${w.id}`, onclick: () => c.o.openTerminal?.(w.id, task.project) } }) : null,
      ),
    ),
  ];
}

function runItem(r: KanbanRun, openTask: (id: number) => void): HTMLElement {
  const took = r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : '';
  return h(
    'li.kb-run',
    { class: `${r.status}${r.verdict ? ` ${r.verdict}` : ''}` },
    h(
      'header',
      {},
      phaseBadge(r.phase, r.round),
      h('span.kb-run-agent', {}, icon('bot', { size: 14 }), `${toolName(r.tool)}${r.model ? ` · ${r.model}` : ''}${r.effort ? ` · ${effortName(r.effort)}` : ''}`),
      h('span.kb-run-status', { class: r.status }, RUN_STATUS_NAMES[r.status]),
      r.verdict ? h('span.kb-verdict', { class: r.verdict }, icon(VERDICTS[r.verdict][0], { size: 13 }), VERDICTS[r.verdict][1]) : null,
      h('small.kb-muted', {}, `${fmtTime(r.startedAt)}${took ? ` · ${took}` : ''}`),
    ),
    r.error ? h('p.kb-error', {}, r.error) : null,
    r.summary ? h('details', {}, h('summary', {}, 'Summary'), renderMarkdown(r.summary, openTask, '')) : null,
  );
}

function eventItem(e: KanbanEvent): HTMLElement {
  return h('li', {}, h('time', {}, fmtTime(e.at)), ' ', h('code', {}, e.kind), e.data !== undefined ? h('small.kb-muted', {}, ` ${JSON.stringify(e.data).slice(0, 200)}`) : null);
}

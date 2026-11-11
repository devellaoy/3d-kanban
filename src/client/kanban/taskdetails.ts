// The Overview's Details section: the task's settings and dates as rows, and the box that changes
// its agent (taskview.ts).

import { h } from '../ui/dom';
import { isRunning } from '../../shared/kanban/moves.js';
import { KANBAN_TOOLS, type KanbanEffort, type KanbanTool, type TaskType } from '../../shared/kanban/types.js';
import { TOOL_ICON, ticketChip } from './card';
import { codexLimitsChip } from './codexlimits';
import { effortSelect, modelInput } from './create';
import { cardRepoNames, viaAgent } from './model';
import { APPROVAL_NAMES, effortName, fmtTime, toolName } from './labels';
import { select } from './ui';
import type { Detail, TaskCtx } from './taskctx';

const TYPE_NAMES: Record<TaskType, string> = { implement: 'Implement', investigate: 'Investigate' };

/** Tool, model and effort, changeable whenever no run is live (the office says no when it won't). */
function agentEditor(c: TaskCtx, task: Detail['task']): HTMLElement | null {
  if (isRunning(task) || task.status === 'archived') return null;
  const tool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, `${TOOL_ICON[x]} ${toolName(x)}`] as const), task.tool, { 'aria-label': 'Agent' });
  const model = modelInput(task.model ?? '', () => tool.value as KanbanTool);
  const effort = effortSelect(task.effort, 'Default');
  tool.addEventListener('change', () => {
    model.refresh();
    // Another tool's model name means nothing to this one.
    if (tool.value !== task.tool) model.input.value = '';
  });
  const save = h('button.btn.small.primary', { type: 'button' }, 'Save') as HTMLButtonElement;
  save.addEventListener('click', () => {
    const m = model.input.value.trim();
    void c.req({ t: 'kanban.task.update', id: task.id, patch: { tool: tool.value as KanbanTool, model: m || null, effort: (effort.value as KanbanEffort) || null } }, save, 'Agent changed');
  });
  const box = h('details.kb-agent-edit', { open: c.ui.agentOpen }, h('summary', {}, '✏️ Change the agent'), h('small.kb-muted', {}, 'Who carries on from the next phase. Not while it runs.'), h('div.kb-row', {}, tool, model.el, effort, save)) as HTMLDetailsElement;
  box.addEventListener('toggle', () => (c.ui.agentOpen = box.open));
  return box;
}

/** The Details section. */
export function detailsSection(c: TaskCtx, d: Detail): HTMLElement {
  const task = d.task;
  const project = c.project(task.project);
  const repos = cardRepoNames(task, project);
  const review = c.review(task);
  const rows: [string, Node | string | null | undefined][] = [
    ['Project', project?.name ?? task.project],
    ['Repositories', repos.length ? h('span.kb-chips', {}, ...repos.map((r) => h('span.kb-chip.repo', {}, `📦 ${r}`))) : null],
    ['Ticket', task.ticket ? ticketChip(task.ticket, task.ticketUrl) : null],
    ['Type', TYPE_NAMES[task.type]],
    ['Agent', h('span', {}, `${TOOL_ICON[task.tool]} ${toolName(task.tool)}${task.model ? ` · ${task.model}` : ''}${task.effort ? ` · ${effortName(task.effort)}` : ''}`, task.tool === 'codex' ? codexLimitsChip(c.o.net) : null)],
    ['Plan', task.usePlan ? `on · ${APPROVAL_NAMES[task.planApproval]}` : 'off'],
    [
      'Review',
      task.useReview
        ? `on · ${review.tool ? toolName(review.tool) : ''}${review.model ? ` ${review.model}` : ''} · ${review.rounds} rounds${task.reviewRound ? ` · round ${task.reviewRound}` : ''}`
        : 'off',
    ],
    ['Branch', task.branch ? h('code', {}, task.branch) : null],
    ['Workspace', task.workspace ? h('code', { title: task.workspace.worktree.path }, task.workspace.worktree.path) : null],
    ['Created', `${task.createdBy}${viaAgent(d.events) ? ` (via ${viaAgent(d.events)})` : ''} · ${fmtTime(task.createdAt)}`],
    ['Started', task.startedAt ? fmtTime(task.startedAt) : null],
    ['Finished', task.finishedAt ? fmtTime(task.finishedAt) : null],
    ['Tags', task.tags.length ? task.tags.map((x) => `#${x}`).join(' ') : null],
    ['Comments waiting for the agent', task.pendingMessages.length ? String(task.pendingMessages.length) : null],
    ['From ai-kanban', task.legacy ? `${task.legacy.source} #${task.legacy.id}` : null],
  ];
  const meta = h('dl.kb-meta', {}, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v as Node | string)]));
  return h('section', {}, h('h4', {}, 'Details'), meta, agentEditor(c, task));
}

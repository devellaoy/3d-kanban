// The Overview's details rail: the task's settings as rows, its dates under a separator, and the box
// that changes its agent, opened in place by "Change the agent" (taskview.ts).

import { h } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { btn, chip, detailsRail } from '../ui/kit';
import { isRunning } from '../../shared/kanban/moves.js';
import { KANBAN_TOOLS, type KanbanEffort, type KanbanTool, type TaskType } from '../../shared/kanban/types.js';
import { codexLimitsChip } from './codexlimits';
import { effortSelect, modelInput } from './create';
import { cardRepoNames, viaAgent } from './model';
import { taskUiTesting } from './taskimagesmodel';
import { APPROVAL_NAMES, effortName, fmtTime, toolName } from './labels';
import { select } from './ui';
import type { Detail, TaskCtx } from './taskctx';

const TYPE_NAMES: Record<TaskType, string> = { implement: 'Implement', investigate: 'Investigate' };

/** A value with its icon before it. */
const withIcon = (name: IconName, ...value: (Node | string)[]) => h('span.kb-rail-v', {}, icon(name, { size: 14 }), ...value);

/** Tool, model and effort, changeable whenever no run is live (the office says no when it won't). */
function agentEditor(c: TaskCtx, task: Detail['task']): HTMLElement {
  const tool = select<KanbanTool>(KANBAN_TOOLS.map((x) => [x, toolName(x)] as const), task.tool, { 'aria-label': 'Agent', 'data-focus': 'agent-tool' });
  const model = modelInput(task.model ?? '', () => tool.value as KanbanTool);
  const effort = effortSelect(task.effort, 'Default effort');
  model.input.dataset.focus = 'agent-model';
  effort.dataset.focus = 'agent-effort';
  for (const el of [tool, model.input, effort]) el.classList.add('inp');
  tool.addEventListener('change', () => {
    model.refresh();
    // Another tool's model name means nothing to this one.
    if (tool.value !== task.tool) model.input.value = '';
  });
  const close = () => {
    c.ui.agentOpen = false;
    c.paint('overview');
    c.focusBox('agent-change');
  };
  const save = btn('Save', { size: 'sm', attrs: { 'data-focus': 'agent-save' } });
  save.addEventListener('click', async () => {
    const m = model.input.value.trim();
    if (await c.req({ t: 'kanban.task.update', id: task.id, patch: { tool: tool.value as KanbanTool, model: m || null, effort: (effort.value as KanbanEffort) || null } }, save, 'Agent changed')) close();
  });
  const cancel = btn('Cancel', { kind: 'quiet', size: 'sm', attrs: { 'data-focus': 'agent-cancel' } });
  cancel.addEventListener('click', close);
  return h('div.kb-agent-edit', {}, h('small.kb-muted', {}, 'Who carries on from the next phase. Not while it runs.'), tool, model.el, effort, h('div.kb-row', {}, save, cancel));
}

/** The details rail: its heading, the settings, and the dates. */
export function detailsPane(c: TaskCtx, d: Detail): HTMLElement[] {
  const task = d.task;
  const project = c.project(task.project);
  const repos = cardRepoNames(task, project);
  const review = c.review(task);
  const editable = !isRunning(task) && task.status !== 'archived';
  if (!editable) c.ui.agentOpen = false;
  const change = editable && !c.ui.agentOpen ? h('button.link-btn', { type: 'button', 'data-focus': 'agent-change' }, 'Change the agent') : null;
  change?.addEventListener('click', () => {
    c.ui.agentOpen = true;
    c.paint('overview');
    c.focusBox('agent-tool');
  });
  const agent = h(
    'span.kb-agent',
    {},
    withIcon('bot', toolName(task.tool), task.tool === 'codex' ? codexLimitsChip(c.o.net) : ''),
    h('small.kb-muted', {}, `${task.model ?? 'Default model'} · ${task.effort ? `${effortName(task.effort)} effort` : 'Default effort'}`),
    change,
  );
  const ticket = !task.ticket
    ? null
    : task.ticketUrl
      ? h('a.kb-rail-mono', { href: task.ticketUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open the ticket' }, task.ticket, icon('external-link', { size: 12 }))
      : h('span.kb-rail-mono', {}, task.ticket);
  const reviewText = task.useReview
    ? ['On', [review.tool ? toolName(review.tool) : '', review.model ?? ''].filter(Boolean).join(' '), `${review.rounds} rounds`, task.reviewRound ? `round ${task.reviewRound}` : ''].filter(Boolean).join(' · ')
    : 'Off';
  const main = detailsRail([
    { label: 'Project', value: withIcon('building-2', project?.name ?? task.project) },
    { label: repos.length > 1 ? 'Repositories' : 'Repository', value: repos.length ? h('span.kb-rail-list', {}, ...repos.map((r) => withIcon('package', r))) : null },
    { label: 'Ticket', value: ticket },
    { label: 'Type', value: TYPE_NAMES[task.type] },
    { label: 'Agent', value: agent },
    { label: 'Plan', value: task.usePlan ? `On · ${APPROVAL_NAMES[task.planApproval]}` : 'Off' },
    { label: 'Review', value: reviewText },
    // Before/after screenshots of UI changes: the task's own choice, else its project's, else the office's.
    { label: 'UI testing', value: task.type === 'investigate' ? null : taskUiTesting(c.settings(), task.project, task.overrides) ? 'On' : 'Off' },
    { label: 'Branch', value: task.branch ? withIcon('git-branch', h('code', { title: task.branch }, task.branch)) : null },
    { label: 'Workspace', value: task.workspace ? withIcon('folder', h('code', { title: task.workspace.worktree.path }, task.workspace.worktree.path)) : null },
    { label: 'Tags', value: task.tags.length ? h('span.kb-chips', {}, ...task.tags.map((x) => chip(x, 'tag'))) : null },
  ]);
  // The editor takes the rail's whole width, right under the agent's row.
  if (editable && c.ui.agentOpen) agent.closest('dd')?.after(agentEditor(c, task));

  const via = viaAgent(d.events);
  // No time is kept of when a task began to wait: its last run's end is when, else its last change.
  const waitingSince = task.status === 'waiting' ? Math.max(0, ...d.runs.map((r) => r.finishedAt ?? 0)) || task.updatedAt : 0;
  const dates = detailsRail(
    [
      { label: 'Created', value: `${task.createdBy}${via ? ` (via ${via})` : ''} · ${fmtTime(task.createdAt)}` },
      { label: 'Started', value: task.startedAt ? fmtTime(task.startedAt) : null },
      { label: 'Waiting since', value: waitingSince ? fmtTime(waitingSince) : null },
      { label: 'Finished', value: task.finishedAt ? fmtTime(task.finishedAt) : null },
      { label: 'Comments waiting', value: task.pendingMessages.length ? h('span', { title: 'Written while the agent was busy: it gets them at its next pause' }, `${task.pendingMessages.length} for the agent`) : null },
      { label: 'From ai-kanban', value: task.legacy ? `${task.legacy.source} #${task.legacy.id}` : null },
    ],
    true,
  );
  return [h('h3.rail-h', {}, 'Details'), main, h('hr.rail-sep'), dates];
}

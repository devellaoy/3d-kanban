// The task view's action buttons, drawn from taskactions.ts's lists: each action's label, style,
// tooltip and handler. Which actions a task offers is decided there, never here.

import { h } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { ActionId, ActionPlace, ActionSubject } from './taskactions';
import { currentActions } from './taskactions';
import type { TaskCtx } from './taskctx';
import { openHoldDialog, openResumeDialog } from './holddialog';
import { findPrsButton, prModeButton } from './prbuttons';

/** What an action looks like and does; the PR-mode buttons and Find PRs are built by prbuttons.ts. */
interface Spec {
  label: string;
  cls?: string;
  title?: string;
  go(b: HTMLButtonElement): void;
}

function specOf(id: Exclude<ActionId, 'fix-prs' | 'resolve-conflicts' | 'find-prs' | 'review-prs' | 'send-plan-feedback'>, task: KanbanTask, c: TaskCtx): Spec {
  const tid = task.id;
  const send = (msg: Parameters<TaskCtx['req']>[0], done?: string) => (b: HTMLButtonElement) => void c.req(msg, b, done);
  const move = (to: 'in_progress' | 'on_hold', b: HTMLButtonElement, extras: { note?: string; until?: number }) => void c.req({ t: 'kanban.task.move', id: tid, to, ...extras }, b);
  switch (id) {
    case 'start':
      return { label: '▶️ Start', cls: '.primary', go: send({ t: 'kanban.task.start', id: tid }, 'Started') };
    case 'edit':
      return { label: '✏️ Edit', go: () => c.o.edit?.(task) };
    case 'stop':
      return { label: '⏹️ Stop', cls: '.danger', go: send({ t: 'kanban.task.stop', id: tid }, 'Stopping…') };
    case 'approve':
      return { label: '✅ Approve the plan', cls: '.primary', go: send({ t: 'kanban.plan.approve', id: tid }, 'Plan approved') };
    case 'request-changes':
      return { label: '✍️ Request changes', go: () => c.setTab('plan') };
    case 'retry-now':
      return { label: '🔁 Retry now', cls: '.primary', go: send({ t: 'kanban.task.retry', id: tid }, 'Trying again') };
    case 'retry':
      return { label: '🔁 Retry', cls: '.primary', go: send({ t: 'kanban.task.retry', id: tid }, 'Trying again') };
    case 'continue': {
      // After a failure or an interruption Retry is the main button.
      const retried = task.waitingReason === 'failed' || task.waitingReason === 'interrupted';
      return { label: '▶️ Continue', cls: retried ? '' : '.primary', go: send({ t: 'kanban.task.continue', id: tid }, 'Continuing') };
    }
    case 'continue-unanswered':
      return { label: '▶️ Continue without answering', title: 'The agent goes on with assumptions of its own, and names them', go: send({ t: 'kanban.task.continue', id: tid }, 'Continuing') };
    case 'review-round':
      return { label: '🔍 Run a review round', title: 'A reviewer looks at the work once more; changes it asks for are fixed', go: send({ t: 'kanban.task.review', id: tid }, 'A review round starts') };
    case 'create-prs':
    case 'push-prs':
      return {
        label: `🔀 ${id === 'push-prs' ? 'Push & update PRs' : 'Create PRs'}`,
        cls: '.primary',
        title: 'The agent pushes and opens (or updates) a pull request in every repository with commits',
        go: send({ t: 'kanban.task.pr', id: tid, mode: 'create' }, 'An agent is on the pull requests'),
      };
    case 'resume':
      return { label: '▶️ Resume', cls: '.primary', title: 'Carry on where it left off, with the comments written meanwhile', go: (b) => openResumeDialog(task, (x) => move('in_progress', b, x)) };
    case 'hold':
      return { label: '⏸️ Put on hold', title: 'Put it aside: its worker goes home and the worktree is kept', go: (b) => openHoldDialog(task, (x) => move('on_hold', b, x)) };
    case 'move':
      return { label: '↔️ Move…', title: 'Move to another column (M)', go: () => c.o.moveMenu?.(tid) };
    case 'delete': {
      const hasWorker = !!(task.workerId || task.reviewerWorkerId);
      return {
        label: '🗑️ Delete',
        cls: '.danger',
        go: (b) =>
          confirmDialog(
            `Delete #${tid}?`,
            `The task, its conversation, plans and runs are deleted for good. ${hasWorker ? 'Its workers go home. ' : ''}${task.workspace ? `Its worktree (${task.workspace.worktree.path}), its branches` : 'Its branches'}${task.branch ? ` (${task.branch})` : ''} and pull requests stay.`,
            'Delete',
            () => void c.req({ t: 'kanban.task.delete', id: tid }, b),
          ),
      };
    }
  }
}

/** One action's button, or null for one this module doesn't draw (the PRs tab's review button, the Plan tab's own). */
export function actionButton(id: ActionId, task: KanbanTask, c: TaskCtx): HTMLElement | null {
  if (id === 'fix-prs' || id === 'resolve-conflicts') return prModeButton(task, id, (m, b, d) => c.req(m, b, d));
  if (id === 'find-prs') return findPrsButton(task, c.api);
  if (id === 'send-plan-feedback' || id === 'review-prs') return null;
  const spec = specOf(id, task, c);
  const b = h(`button.btn${spec.cls ?? ''}`, { type: 'button', title: spec.title, 'data-focus': `act-${id}` }, spec.label) as HTMLButtonElement;
  b.addEventListener('click', () => spec.go(b));
  return b;
}

/** What the lists in taskactions.ts look at in a task, as the view has it. */
export function subjectOf(task: KanbanTask): ActionSubject {
  return { status: task.status, runState: task.runState, type: task.type, waitingReason: task.waitingReason, workspace: !!task.workspace, prs: task.prs };
}

/** Whether the task's latest plan is a draft (the Plan tab has one to answer). */
export function planDraftOf(c: TaskCtx): boolean {
  const plans = c.detail?.plans ?? [];
  const latest = plans.reduce<(typeof plans)[number] | undefined>((m, p) => (!m || p.version > m.version ? p : m), undefined);
  return latest?.status === 'draft';
}

/** The ids of the actions offered in one place of the view. */
export function actionsAt(place: ActionPlace, task: KanbanTask, c: TaskCtx): ActionId[] {
  return currentActions(subjectOf(task), { canEdit: !!c.o.edit, canMove: !!c.o.moveMenu, planDraft: planDraftOf(c) })
    .filter((a) => a.place === place)
    .map((a) => a.id);
}

/** The Overview's bar of actions. */
export function overviewBar(task: KanbanTask, c: TaskCtx): HTMLElement {
  const bar = h('div.kb-actions');
  for (const id of actionsAt('overview', task, c)) {
    const b = actionButton(id, task, c);
    if (b) bar.append(b);
  }
  return bar;
}

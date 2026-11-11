// The task view's action buttons, drawn from taskactions.ts's lists: each action's label, icon, tooltip
// and handler, and the footer they stand in (Move, Hold / Resume and Delete on the left; what carries the
// task on on the right, the one primary button last). Which actions a task offers is decided there,
// never here.

import { confirmDialog } from '../ui/prompt';
import type { IconName } from '../ui/icons';
import { btn, type BtnOptions } from '../ui/kit';
import type { KanbanTask } from '../../shared/kanban/types.js';
import type { ActionId, ActionPlace, ActionSubject } from './taskactions';
import { currentActions, footerActions, tabActions } from './taskactions';
import type { TaskCtx } from './taskctx';
import { openHoldDialog, openResumeDialog } from './holddialog';
import { findPrsButton, prModeButton } from './prbuttons';

/** What an action looks like and does; the PR-mode buttons and Find PRs are built by prbuttons.ts. */
interface Spec {
  label: string;
  icon?: IconName;
  title?: string;
  go(b: HTMLButtonElement): void;
}

type Kind = NonNullable<BtnOptions['kind']>;

/** The task's latest plan, when it is a draft: the one Approve answers. */
function draftPlan(c: TaskCtx) {
  const plans = c.detail?.plans ?? [];
  const latest = plans.reduce<(typeof plans)[number] | undefined>((m, p) => (!m || p.version > m.version ? p : m), undefined);
  return latest?.status === 'draft' ? latest : undefined;
}

function specOf(id: Exclude<ActionId, 'fix-prs' | 'resolve-conflicts' | 'find-prs' | 'review-prs' | 'send-plan-feedback'>, task: KanbanTask, c: TaskCtx): Spec {
  const tid = task.id;
  const send = (msg: Parameters<TaskCtx['req']>[0], done?: string) => (b: HTMLButtonElement) => void c.req(msg, b, done);
  const move = (to: 'in_progress' | 'on_hold', b: HTMLButtonElement, extras: { note?: string; until?: number }) => void c.req({ t: 'kanban.task.move', id: tid, to, ...extras }, b);
  switch (id) {
    case 'start':
      return { label: 'Start', icon: 'play', go: send({ t: 'kanban.task.start', id: tid }, 'Started') };
    case 'edit':
      return { label: 'Edit', icon: 'pencil', go: () => c.o.edit?.(task) };
    case 'stop':
      return { label: 'Stop', icon: 'square', go: send({ t: 'kanban.task.stop', id: tid }, 'Stopping…') };
    case 'approve': {
      // The plan on the screen is the one approved: the office refuses when a newer one came meanwhile.
      const plan = draftPlan(c);
      return { label: 'Approve the plan', icon: 'check', go: send({ t: 'kanban.plan.approve', id: tid, ...(plan ? { planId: plan.id } : {}) }, 'Plan approved') };
    }
    case 'request-changes':
      return {
        label: 'Request changes',
        icon: 'pencil',
        title: 'Write what should change in the plan',
        go: () => {
          c.setTab('plan');
          c.focusBox('planChanges');
        },
      };
    case 'retry-now':
      return { label: 'Retry now', icon: 'rotate-cw', go: send({ t: 'kanban.task.retry', id: tid }, 'Trying again') };
    case 'retry':
      return { label: 'Retry', icon: 'rotate-cw', go: send({ t: 'kanban.task.retry', id: tid }, 'Trying again') };
    case 'continue':
      return { label: 'Continue', icon: 'play', go: send({ t: 'kanban.task.continue', id: tid }, 'Continuing') };
    case 'continue-unanswered':
      return { label: 'Continue without answering', title: 'The agent goes on with assumptions of its own, and names them', go: send({ t: 'kanban.task.continue', id: tid }, 'Continuing') };
    case 'review-round':
      return { label: 'Run a review round', icon: 'eye', title: 'A reviewer looks at the work once more; changes it asks for are fixed', go: send({ t: 'kanban.task.review', id: tid }, 'A review round starts') };
    case 'create-prs':
    case 'push-prs':
      return {
        label: id === 'push-prs' ? 'Push & update PRs' : 'Create PRs',
        icon: 'git-pull-request',
        title: 'The agent pushes and opens (or updates) a pull request in every repository with commits',
        go: send({ t: 'kanban.task.pr', id: tid, mode: 'create' }, 'An agent is on the pull requests'),
      };
    case 'resume':
      return { label: 'Resume', icon: 'play', title: 'Carry on where it left off, with the comments written meanwhile', go: (b) => openResumeDialog(task, (x) => move('in_progress', b, x)) };
    case 'hold':
      return { label: 'Put on hold', icon: 'circle-pause', title: 'Put it aside: its worker goes home and the worktree is kept', go: (b) => openHoldDialog(task, (x) => move('on_hold', b, x)) };
    case 'move':
      return { label: 'Move', icon: 'arrow-right-left', title: 'Move to another column (M)', go: () => c.o.moveMenu?.(tid) };
    case 'delete': {
      const hasWorker = !!(task.workerId || task.reviewerWorkerId);
      return {
        label: 'Delete',
        icon: 'trash-2',
        go: (b) =>
          confirmDialog(
            'Delete task',
            `The task, its plan, comments and runs are deleted. This cannot be undone. ${hasWorker ? 'Its workers go home. ' : ''}${task.workspace ? `Its worktree (${task.workspace.worktree.path}), its branches` : 'Its branches'}${task.branch ? ` (${task.branch})` : ''} and pull requests stay.`,
            'Delete',
            () => void c.req({ t: 'kanban.task.delete', id: tid }, b),
            { id: `#${tid}`, lead: task.title, icon: 'trash-2' },
          ),
      };
    }
  }
}

/**
 * One action's button, or null for one this module doesn't draw (the PRs tab's review button, the Plan
 * tab's own). `kind` is how it stands where it is drawn: secondary unless said.
 */
export function actionButton(id: ActionId, task: KanbanTask, c: TaskCtx, kind: Kind = 'secondary'): HTMLElement | null {
  if (id === 'fix-prs' || id === 'resolve-conflicts') return prModeButton(task, id, (m, b, d) => c.req(m, b, d));
  if (id === 'find-prs') return findPrsButton(task, c.api);
  if (id === 'send-plan-feedback' || id === 'review-prs') return null;
  const spec = specOf(id, task, c);
  const b = btn(spec.label, { kind, icon: spec.icon, attrs: { title: spec.title, 'data-focus': `act-${id}` } });
  b.addEventListener('click', () => spec.go(b));
  return b;
}

/** What the lists in taskactions.ts look at in a task, as the view has it. */
export function subjectOf(task: KanbanTask): ActionSubject {
  return { status: task.status, runState: task.runState, type: task.type, waitingReason: task.waitingReason, workspace: !!task.workspace, prs: task.prs };
}

/** Whether the task's latest plan is a draft (the Plan tab has one to answer). */
export function planDraftOf(c: TaskCtx): boolean {
  return !!draftPlan(c);
}

const ctxOf = (c: TaskCtx) => ({ canEdit: !!c.o.edit, canMove: !!c.o.moveMenu, planDraft: planDraftOf(c) });

/** The ids the Pull requests tab draws itself: its actions that the footer doesn't have. */
export function tabActionIds(task: KanbanTask, c: TaskCtx): ActionId[] {
  return tabActions(subjectOf(task), ctxOf(c));
}

/** The ids of the actions offered in one place of the view. */
export function actionsAt(place: ActionPlace, task: KanbanTask, c: TaskCtx): ActionId[] {
  return currentActions(subjectOf(task), ctxOf(c))
    .filter((a) => a.place === place)
    .map((a) => a.id);
}

/**
 * The footer's two groups. Left: Move, Put on hold and Delete (quiet, in the danger colour). Right starts with Create / Push & update PRs, and also has a held task's Resume.
 * Right: the state's actions as secondary buttons, the one primary last, so it sits bottom right.
 */
export function footerButtons(task: KanbanTask, c: TaskCtx): { left: HTMLElement[]; right: HTMLElement[] } {
  const f = footerActions(subjectOf(task), ctxOf(c));
  const make = (ids: ActionId[], kind: (id: ActionId) => Kind) => ids.map((id) => actionButton(id, task, c, kind(id))).filter((b): b is HTMLElement => !!b);
  const right = [...f.right.filter((id) => id !== f.primary), ...(f.primary ? [f.primary] : [])];
  return {
    left: make(f.left, (id) => (id === 'delete' ? 'quiet-danger' : 'secondary')),
    right: make(right, (id) => (id === f.primary ? 'primary' : 'secondary')),
  };
}

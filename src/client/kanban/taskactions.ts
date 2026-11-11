// Which actions a task offers, and where: the one place that decides it (no DOM). The task view draws
// its buttons from these lists, so what a button's condition is lives here and nowhere else.
//
// `currentActions` is how the view lays them out today (the Overview's action bar, the Plan tab's box
// and the PRs tab's bar); `footerActions` is the same conditions placed in the task view's footer.
// tests/kanban-ui-taskactions.test.ts holds the two against each other over every combination.

import type { KanbanPrLink, RunState, TaskStatus, TaskType, WaitingReason } from '../../shared/kanban/types.js';
import { isRunning } from '../../shared/kanban/moves.js';
import { openPrs, prStatusOk } from '../../shared/kanban/prs.js';

/** A stable name per action; it is also the button's `data-focus` (`act-<id>`). */
export type ActionId =
  | 'start'
  | 'edit'
  | 'stop'
  | 'approve'
  | 'request-changes'
  | 'retry-now'
  | 'retry'
  | 'continue'
  | 'continue-unanswered'
  | 'review-round'
  | 'create-prs'
  | 'push-prs'
  | 'hold'
  | 'resume'
  | 'fix-prs'
  | 'resolve-conflicts'
  | 'find-prs'
  | 'review-prs'
  | 'move'
  | 'delete'
  /** The Plan tab's own button: sends the typed feedback to the planner. */
  | 'send-plan-feedback';

export type ActionPlace = 'overview' | 'plan' | 'prs';

export interface PlacedAction {
  place: ActionPlace;
  id: ActionId;
}

/** What the conditions look at in a task. */
export interface ActionSubject {
  status: TaskStatus;
  runState: RunState;
  type: TaskType;
  waitingReason?: WaitingReason;
  /** Whether the task has a worktree (`task.workspace`). */
  workspace: boolean;
  prs: Pick<KanbanPrLink, 'state' | 'repo'>[];
}

/** What the view contributes: the hooks it was given, and what its tabs hold. */
export interface ActionCtx {
  /** `TaskViewOptions.edit` was given (the kanban page). */
  canEdit: boolean;
  /** `TaskViewOptions.moveMenu` was given (not embedded in the 3D office). */
  canMove: boolean;
  /** The task's latest plan is a draft (the Plan tab has one to answer). */
  planDraft: boolean;
}

/** Every condition once, so the two layouts can't disagree about when an action exists. */
function conditions(task: ActionSubject, ctx: ActionCtx) {
  const running = isRunning(task);
  const waiting = task.status === 'waiting' && !running;
  const reason = task.waitingReason;
  const review = task.status === 'review' && !running;
  const implement = task.type === 'implement';
  const prsOk = !!openPrs(task).length && prStatusOk(task.status);
  return {
    start: task.status === 'todo',
    edit: task.status === 'todo' && ctx.canEdit,
    stop: running,
    approve: waiting && reason === 'plan_approval',
    requestChanges: waiting && reason === 'plan_approval',
    retryNow: waiting && reason === 'usage_limit',
    retry: waiting && (reason === 'failed' || reason === 'interrupted'),
    // agent_asking has none: it is answered in the box above the actions, or in its terminal.
    continue: waiting && reason !== 'usage_limit' && reason !== 'agent_asking' && reason !== 'plan_questions' && reason !== 'plan_approval',
    continueUnanswered: waiting && reason === 'plan_questions',
    // The engine reviews a waiting task by hand too, when it has work to review (not a plan waiting).
    reviewRound: (waiting && implement && task.workspace && reason !== 'plan_questions' && reason !== 'plan_approval') || (review && implement),
    createPrsOverview: review && implement,
    // The PRs tab offers them from Waiting and Done as well.
    createPrsTab: implement && !running && prStatusOk(task.status),
    hold: !running && (task.status === 'waiting' || task.status === 'review'),
    resume: !running && task.status === 'on_hold',
    prsOk,
    findPrs: task.status !== 'archived',
    reviewPrs: task.prs.some((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT')),
    move: task.status !== 'in_progress' && ctx.canMove,
    delete: !running,
    planFeedback: ctx.planDraft && waiting,
  };
}

const createId = (task: ActionSubject): ActionId => (task.prs.length ? 'push-prs' : 'create-prs');

/** The actions the task view offers today, in the order they are drawn in each place. */
export function currentActions(task: ActionSubject, ctx: ActionCtx): PlacedAction[] {
  const c = conditions(task, ctx);
  const out: PlacedAction[] = [];
  const at = (place: ActionPlace, ...ids: [boolean, ActionId][]) => {
    for (const [on, id] of ids) if (on) out.push({ place, id });
  };
  at(
    'overview',
    [c.start, 'start'],
    [c.edit, 'edit'],
    [c.stop, 'stop'],
    [c.approve, 'approve'],
    [c.requestChanges, 'request-changes'],
    [c.retryNow, 'retry-now'],
    [c.retry, 'retry'],
    [c.retry || c.continue, 'continue'],
    [c.continueUnanswered, 'continue-unanswered'],
    [c.reviewRound, 'review-round'],
    [c.createPrsOverview, createId(task)],
    [c.resume, 'resume'],
    [c.hold, 'hold'],
    [c.prsOk, 'fix-prs'],
    [c.prsOk, 'resolve-conflicts'],
    [c.move, 'move'],
    [c.delete, 'delete'],
  );
  at('plan', [c.planFeedback, 'approve'], [c.planFeedback, 'send-plan-feedback']);
  at('prs', [c.createPrsTab, createId(task)], [c.prsOk, 'fix-prs'], [c.prsOk, 'resolve-conflicts'], [c.findPrs, 'find-prs'], [c.reviewPrs, 'review-prs']);
  return out;
}

/** The task view's footer: where each action sits, and which one is the primary button. */
export interface FooterActions {
  left: ActionId[];
  right: ActionId[];
  primary: ActionId | null;
}

/** Actions that stay on a tab of their own and are not in the footer. */
export const TAB_ONLY_ACTIONS: readonly ActionId[] = ['fix-prs', 'resolve-conflicts', 'find-prs', 'review-prs', 'send-plan-feedback'];

/**
 * Which of the right-hand actions is primary, first match wins: what was the `.primary` button of the old
 * Overview bar in each state. Approve for a plan, Start for To do, Retry now for a usage limit, Retry for
 * a failed or interrupted run (Continue beside it is plain), Continue for any other wait, Create / Push
 * PRs in Review (plain in any other state), Resume for a held task. A state with none of these has no primary.
 */
const PRIMARY_ORDER: readonly ActionId[] = ['approve', 'start', 'retry-now', 'retry', 'continue', 'create-prs', 'push-prs', 'resume'];

/**
 * The same conditions as `currentActions`, placed in the footer: Move, Hold/Resume and Delete on the
 * left; the actions that carry the task on or stop it on the right. Answering a question stays in the
 * Overview's banner and the PR actions that need a PR to look at stay on the PRs tab (`tabActions`).
 */
export function footerActions(task: ActionSubject, ctx: ActionCtx): FooterActions {
  const c = conditions(task, ctx);
  const pick = (list: [boolean, ActionId][]) => list.filter(([on]) => on).map(([, id]) => id);
  const left = pick([
    [c.move, 'move'],
    [c.hold, 'hold'],
    [c.delete, 'delete'],
  ]);
  const right = pick([
    // Create / Push & update PRs: the old Overview's and the old PRs tab's conditions together. First, so that
    // outside Review (where it is plain) it never sits beside the primary button at the end.
    [c.createPrsOverview || c.createPrsTab, createId(task)],
    [c.stop, 'stop'],
    [c.start, 'start'],
    [c.edit, 'edit'],
    // The Plan tab's wider condition counts too: a draft plan waiting for anything keeps its Approve.
    [c.approve || c.planFeedback, 'approve'],
    [c.requestChanges || c.planFeedback, 'request-changes'],
    [c.retryNow, 'retry-now'],
    [c.retry, 'retry'],
    [c.retry || c.continue, 'continue'],
    [c.continueUnanswered, 'continue-unanswered'],
    [c.reviewRound, 'review-round'],
    // A held task's Resume is its one way on: the primary, as it was.
    [c.resume, 'resume'],
  ]);
  const primary = PRIMARY_ORDER.find((id) => right.includes(id) && ((id !== 'create-prs' && id !== 'push-prs') || task.status === 'review')) ?? null;
  return { left, right, primary };
}

/**
 * What the Pull requests tab draws of its own: its actions that the footer doesn't have (Create / Push &
 * update PRs are the footer's in every state, so never here).
 */
export function tabActions(task: ActionSubject, ctx: ActionCtx): ActionId[] {
  const f = footerActions(task, ctx);
  const inFooter = new Set<ActionId>([...f.left, ...f.right]);
  return currentActions(task, ctx)
    .filter((a) => a.place === 'prs' && !inFooter.has(a.id))
    .map((a) => a.id);
}

/** Whether the Plan tab shows its feedback box (the latest plan waits for the user). */
export function planFeedbackShown(task: ActionSubject, ctx: ActionCtx): boolean {
  return conditions(task, ctx).planFeedback;
}

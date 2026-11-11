// The actions a task offers, and where (kanban/taskactions.ts): held against the task view as it was
// before the footer (a transcription of its old if-chains is the oracle below), and the footer's
// placement held against it over every combination: the same actions, once each, at most one primary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionCtx, ActionId, ActionSubject, currentActions, footerActions, planFeedbackShown, tabActions } from '../src/client/kanban/taskactions.js';
import { RUN_STATES, TASK_STATUSES, WAITING_REASONS, type KanbanPrLink, type WaitingReason } from '../src/shared/kanban/types.js';
import { isRunning } from '../src/shared/kanban/moves.js';

type Pr = Pick<KanbanPrLink, 'state' | 'repo'>;
const PR_SETS: Record<string, Pr[]> = {
  none: [],
  open: [{ state: 'OPEN', repo: 'o/r' }],
  draftNoRepo: [{ state: 'DRAFT' }],
  merged: [{ state: 'MERGED', repo: 'o/r' }],
  mixed: [{ state: 'MERGED', repo: 'o/r' }, { state: 'OPEN', repo: 'o/r' }],
};
const REASONS: (WaitingReason | undefined)[] = [undefined, ...WAITING_REASONS];

interface Case {
  task: ActionSubject & { askingKind?: 'question' | 'permission' };
  ctx: ActionCtx;
  label: string;
}

/** Every combination of what the conditions can look at. */
function* cases(): Generator<Case> {
  for (const status of TASK_STATUSES)
    for (const runState of RUN_STATES)
      for (const waitingReason of REASONS)
        for (const type of ['implement', 'investigate'] as const)
          for (const askingKind of [undefined, 'question', 'permission'] as const)
            for (const workspace of [false, true])
              for (const [prsName, prs] of Object.entries(PR_SETS))
                for (const canMove of [false, true])
                  for (const canEdit of [false, true])
                    for (const planDraft of [false, true])
                      yield {
                        task: { status, runState, waitingReason, type, askingKind, workspace, prs },
                        ctx: { canEdit, canMove, planDraft },
                        label: `${status}/${runState}/${waitingReason ?? '-'}/${type}/${askingKind ?? '-'}/ws=${workspace}/prs=${prsName}/move=${canMove}/edit=${canEdit}/draft=${planDraft}`,
                      };
}

/** The task view's old conditions, written out as they were (taskview.ts actionButtons, holdActions, prActionButtons, the Plan and PRs tabs). */
function legacy(t: Case['task'], ctx: ActionCtx) {
  const out: string[] = [];
  const at = (place: string, id: string) => out.push(`${place}:${id}`);
  const running = isRunning(t);
  const o = (id: string) => at('overview', id);
  if (t.status === 'todo') {
    o('start');
    if (ctx.canEdit) o('edit');
  }
  if (running) o('stop');
  if (t.status === 'waiting' && !running) {
    switch (t.waitingReason) {
      case 'plan_approval':
        o('approve');
        o('request-changes');
        break;
      case 'usage_limit':
        o('retry-now');
        break;
      case 'failed':
      case 'interrupted':
        o('retry');
        o('continue');
        break;
      case 'agent_asking':
        break;
      case 'plan_questions':
        o('continue-unanswered');
        break;
      default:
        o('continue');
    }
    if (t.type === 'implement' && t.workspace && t.waitingReason !== 'plan_questions' && t.waitingReason !== 'plan_approval') o('review-round');
  }
  if (t.status === 'review' && !running) {
    if (t.type === 'implement') o('review-round');
    if (t.type === 'implement') o(t.prs.length ? 'push-prs' : 'create-prs');
  }
  if (!running) {
    if (t.status === 'on_hold') o('resume');
    else if (t.status === 'waiting' || t.status === 'review') o('hold');
  }
  const openPr = t.prs.some((p) => p.state === 'OPEN' || p.state === 'DRAFT');
  const prStatus = t.status === 'waiting' || t.status === 'review' || t.status === 'done';
  if (openPr && prStatus) {
    o('fix-prs');
    o('resolve-conflicts');
  }
  if (t.status !== 'in_progress' && ctx.canMove) o('move');
  if (!running) o('delete');
  // The Plan tab's box.
  if (ctx.planDraft && t.status === 'waiting' && !running) {
    at('plan', 'approve');
    at('plan', 'send-plan-feedback');
  }
  // The PRs tab's bar.
  if (t.type === 'implement' && !running && prStatus) at('prs', t.prs.length ? 'push-prs' : 'create-prs');
  if (openPr && prStatus) {
    at('prs', 'fix-prs');
    at('prs', 'resolve-conflicts');
  }
  if (t.status !== 'archived') at('prs', 'find-prs');
  if (t.prs.some((p) => p.repo && (p.state === 'OPEN' || p.state === 'DRAFT'))) at('prs', 'review-prs');
  return out;
}

const idsOf = (a: { place: string; id: ActionId }[], place?: string) => a.filter((x) => !place || x.place === place).map((x) => x.id);
const base = (over: Partial<Case['task']> = {}): Case['task'] => ({ status: 'todo', runState: 'idle', type: 'implement', workspace: false, prs: [], ...over });
const ctx0: ActionCtx = { canEdit: true, canMove: true, planDraft: false };

test('currentActions is the old task view, in the same order, for every combination', () => {
  let n = 0;
  for (const c of cases()) {
    assert.deepEqual(
      currentActions(c.task, c.ctx).map((a) => `${a.place}:${a.id}`),
      legacy(c.task, c.ctx),
      c.label,
    );
    n++;
  }
  assert.ok(n > 100_000, `${n} combinations`);
});

test('representative tasks: what the Overview offers', () => {
  const overview = (t: Partial<Case['task']>, ctx = ctx0) => idsOf(currentActions(base(t), ctx), 'overview');
  assert.deepEqual(overview({}), ['start', 'edit', 'move', 'delete']);
  assert.deepEqual(overview({}, { ...ctx0, canEdit: false, canMove: false }), ['start', 'delete']);
  assert.deepEqual(overview({ status: 'in_progress', runState: 'running' }), ['stop']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'plan_approval' }), ['approve', 'request-changes', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'usage_limit' }), ['retry-now', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'failed', workspace: true }), ['retry', 'continue', 'review-round', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'plan_questions', workspace: true }), ['continue-unanswered', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'agent_asking', workspace: true }), ['review-round', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'waiting', waitingReason: 'stopped' }), ['continue', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'review', workspace: true }), ['review-round', 'create-prs', 'hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'review', prs: PR_SETS.open }), ['review-round', 'push-prs', 'hold', 'fix-prs', 'resolve-conflicts', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'review', type: 'investigate' }), ['hold', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'on_hold' }), ['resume', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'done', prs: PR_SETS.open }), ['fix-prs', 'resolve-conflicts', 'move', 'delete']);
  assert.deepEqual(overview({ status: 'archived' }), ['move', 'delete']);
  // A PR agent running on a task in Review: Stop, and the PR buttons stay in the bar greyed out (prbuttons.ts says why).
  assert.deepEqual(overview({ status: 'review', runState: 'running', prs: PR_SETS.open }), ['stop', 'fix-prs', 'resolve-conflicts', 'move']);
});

test('representative tasks: the Plan and PRs tabs', () => {
  const plan = base({ status: 'waiting', waitingReason: 'plan_approval' });
  assert.deepEqual(idsOf(currentActions(plan, { ...ctx0, planDraft: true }), 'plan'), ['approve', 'send-plan-feedback']);
  assert.deepEqual(idsOf(currentActions(plan, ctx0), 'plan'), [], 'no draft plan, no box');
  assert.deepEqual(idsOf(currentActions(base({ status: 'waiting', runState: 'running' }), { ...ctx0, planDraft: true }), 'plan'), []);
  const done = base({ status: 'done', prs: PR_SETS.mixed });
  assert.deepEqual(idsOf(currentActions(done, ctx0), 'prs'), ['push-prs', 'fix-prs', 'resolve-conflicts', 'find-prs', 'review-prs']);
  // The tab draws what the footer doesn't have: Create / Push only from Waiting and Done, never in Review.
  assert.deepEqual(tabActions(done, ctx0), ['push-prs', 'fix-prs', 'resolve-conflicts', 'find-prs', 'review-prs']);
  assert.deepEqual(tabActions(base({ status: 'review', prs: PR_SETS.mixed }), ctx0), ['fix-prs', 'resolve-conflicts', 'find-prs', 'review-prs'], 'in Review Push & update PRs is the footer’s');
  assert.deepEqual(tabActions(base({ status: 'waiting', waitingReason: 'failed' }), ctx0), ['create-prs', 'find-prs']);
  assert.deepEqual(idsOf(currentActions(base({ status: 'archived' }), ctx0), 'prs'), []);
  assert.deepEqual(idsOf(currentActions(base({ status: 'waiting', waitingReason: 'failed' }), ctx0), 'prs'), ['create-prs', 'find-prs']);
});

test('footerActions: left, right and the primary button of representative tasks', () => {
  const f = (t: Partial<Case['task']>, ctx = ctx0) => footerActions(base(t), ctx);
  assert.deepEqual(f({}), { left: ['move', 'delete'], right: ['start', 'edit'], primary: 'start' });
  assert.deepEqual(f({ status: 'in_progress', runState: 'running' }), { left: [], right: ['stop'], primary: null });
  assert.deepEqual(f({ status: 'waiting', waitingReason: 'plan_approval' }), { left: ['move', 'hold', 'delete'], right: ['approve', 'request-changes'], primary: 'approve' });
  assert.deepEqual(f({ status: 'waiting', waitingReason: 'usage_limit' }).primary, 'retry-now');
  assert.equal(f({ status: 'waiting', waitingReason: 'failed' }).primary, 'retry', 'after a failure Retry is the main button (as before), Continue the plain one');
  assert.deepEqual(f({ status: 'waiting', waitingReason: 'failed' }).right, ['retry', 'continue']);
  assert.deepEqual(f({ status: 'waiting', waitingReason: 'plan_questions' }), { left: ['move', 'hold', 'delete'], right: ['continue-unanswered'], primary: null });
  assert.equal(f({ status: 'waiting', waitingReason: 'agent_asking' }).primary, null);
  assert.deepEqual(f({ status: 'review', workspace: true }), { left: ['move', 'hold', 'delete'], right: ['review-round', 'create-prs'], primary: 'create-prs' });
  assert.equal(f({ status: 'review', prs: PR_SETS.open }).primary, 'push-prs');
  assert.deepEqual(f({ status: 'review', type: 'investigate' }), { left: ['move', 'hold', 'delete'], right: [], primary: null });
  assert.deepEqual(f({ status: 'on_hold' }), { left: ['move', 'delete'], right: ['resume'], primary: 'resume' });
  assert.deepEqual(f({ status: 'archived' }), { left: ['move', 'delete'], right: [], primary: null });
  // Create / Push from Waiting and Done are the Pull requests tab's, not the footer's.
  assert.deepEqual(f({ status: 'done' }).right, []);
  assert.equal(f({ status: 'done' }).primary, null);
  assert.deepEqual(f({ status: 'waiting', waitingReason: 'stopped', prs: PR_SETS.merged }).right, ['continue']);
  assert.equal(f({ status: 'waiting', waitingReason: 'stopped' }).primary, 'continue');
  assert.deepEqual(f({ status: 'todo' }, { canEdit: false, canMove: false }), { left: ['delete'], right: ['start'], primary: 'start' });
});

// The `.primary` button of each state on origin/main (taskview.ts actionButtons, holdview.ts): Start in To do,
// Approve the plan, Retry now for a usage limit, Retry after a failure or an interruption (Continue beside it
// plain), Continue for any other wait (stopped), Create / Push & update PRs in Review, Resume on hold. Nothing
// for Continue without answering (the plan's questions), an agent asking, Stop, Done or the archive.
test('the primary button of each state is the one that was primary before', () => {
  const primary = (t: Partial<Case['task']>) => footerActions(base(t), ctx0).primary;
  assert.equal(primary({}), 'start');
  assert.equal(primary({ status: 'waiting', waitingReason: 'plan_approval' }), 'approve');
  assert.equal(primary({ status: 'waiting', waitingReason: 'usage_limit' }), 'retry-now');
  assert.equal(primary({ status: 'waiting', waitingReason: 'failed' }), 'retry');
  assert.equal(primary({ status: 'waiting', waitingReason: 'interrupted' }), 'retry');
  assert.equal(primary({ status: 'waiting', waitingReason: 'stopped' }), 'continue');
  assert.equal(primary({ status: 'waiting' }), 'continue');
  assert.equal(primary({ status: 'waiting', waitingReason: 'plan_questions' }), null);
  assert.equal(primary({ status: 'waiting', waitingReason: 'agent_asking' }), null);
  assert.equal(primary({ status: 'review' }), 'create-prs');
  assert.equal(primary({ status: 'review', prs: PR_SETS.open }), 'push-prs');
  assert.equal(primary({ status: 'review', type: 'investigate' }), null);
  assert.equal(primary({ status: 'on_hold' }), 'resume');
  assert.equal(primary({ status: 'in_progress', runState: 'running' }), null);
  assert.equal(primary({ status: 'done' }), null);
  assert.equal(primary({ status: 'archived' }), null);
});

test('footerActions offers every action the view has today, once, with at most one primary (every combination)', () => {
  for (const c of cases()) {
    const now = currentActions(c.task, c.ctx);
    const foot = footerActions(c.task, c.ctx);
    const inFooter = [...foot.left, ...foot.right];
    assert.equal(new Set(inFooter).size, inFooter.length, `${c.label}: an action twice in the footer`);
    // What the footer and the Pull requests tab show between them, never the same action in both.
    const tab = tabActions(c.task, c.ctx);
    assert.deepEqual(tab.filter((id) => inFooter.includes(id)), [], `${c.label}: offered in the footer and on the tab`);
    const kept = new Set<ActionId>([...inFooter, ...tab]);
    if (planFeedbackShown(c.task, c.ctx)) kept.add('send-plan-feedback');
    // Nothing is lost: every id of today's lists is in the footer or on a tab of its own. The footer may add
    // only Request changes (which takes you to the Plan tab) for a draft plan waiting for the user.
    const before = new Set<ActionId>(now.map((a) => a.id));
    const missing = [...before].filter((id) => !kept.has(id));
    assert.deepEqual(missing, [], `${c.label}: lost from the footer`);
    const extra = [...kept].filter((id) => !before.has(id));
    assert.ok(extra.every((id) => id === 'request-changes') && (!extra.length || planFeedbackShown(c.task, c.ctx)), `${c.label}: extra ${extra}`);
    // Create / Push & update PRs: the footer in Review, the tab otherwise, whenever the old view had it.
    const create = now.some((a) => a.id === 'create-prs' || a.id === 'push-prs');
    const places = [...inFooter, ...tab].filter((id) => id === 'create-prs' || id === 'push-prs').length;
    assert.equal(places, create ? 1 : 0, `${c.label}: Create / Push in ${places} places`);
    // Primary: one at most, one of the right-hand actions, and Create/Push only in Review.
    if (foot.primary) {
      assert.ok(foot.right.includes(foot.primary), `${c.label}: primary ${foot.primary} is not on the right`);
      assert.ok(!['stop', 'request-changes', 'continue-unanswered', 'review-round', 'edit'].includes(foot.primary), c.label);
      if (foot.primary === 'resume') assert.equal(c.task.status, 'on_hold', c.label);
      if (foot.primary === 'create-prs' || foot.primary === 'push-prs') assert.equal(c.task.status, 'review', c.label);
    }
    // Left is only Move, Put on hold and Delete.
    assert.ok(foot.left.every((id) => ['move', 'hold', 'delete'].includes(id)), c.label);
    // askingKind never changes what is offered (the box in the banner is the one that looks at it).
    assert.deepEqual(foot, footerActions({ ...c.task, askingKind: undefined }, c.ctx), c.label);
  }
});

test('a draft plan waiting for anything keeps its Approve and Request changes in the footer', () => {
  let n = 0;
  for (const c of cases()) {
    if (!planFeedbackShown(c.task, c.ctx)) continue;
    const { right } = footerActions(c.task, c.ctx);
    assert.ok(right.includes('approve') && right.includes('request-changes'), c.label);
    n++;
  }
  assert.ok(n > 0);
  assert.equal(footerActions(base({ status: 'waiting', waitingReason: 'plan_questions' }), { ...ctx0, planDraft: true }).primary, 'approve');
});

test('every action id the lists use is one of the declared ones, so a button’s data-focus is stable', () => {
  const seen = new Set<string>();
  for (const c of cases()) for (const a of currentActions(c.task, c.ctx)) seen.add(a.id);
  assert.deepEqual([...seen].sort(), ['approve', 'continue', 'continue-unanswered', 'create-prs', 'delete', 'edit', 'find-prs', 'fix-prs', 'hold', 'move', 'push-prs', 'request-changes', 'resolve-conflicts', 'resume', 'retry', 'retry-now', 'review-prs', 'review-round', 'send-plan-feedback', 'start', 'stop']);
});

// The kanban task process as a pure transition function (docs/kanban-architecture.md §4):
// next(state, event, config) → the task's new state and what the orchestrator has to do about it.
// No I/O here: the orchestrator reads the agents' results, asks git whether anything changed, and
// hands the outcome in as an event; this decides the column, the phase and the next run.
//
// The flow: plan → (waiting for answers or approval) → implement → review round k ⇄ fix → review
// column. A comment resumes the work; a resume turn is reviewed again when the task has review on,
// unless it changed nothing since the task last came to Review.

import type { KanbanRole, KanbanTask, PlanApproval, QueuedRun, RunPhase, RunState, TaskStatus, TaskType, WaitingReason } from '../../../shared/kanban/types.js';
import { prStatusOk, type PrMode } from '../../../shared/kanban/prs.js';
import { KANBAN_PROMPT_DEFS } from '../../../shared/kanban/prompt-defs.js';

/** The part of a task the machine decides about. */
export interface MachineState {
  status: TaskStatus;
  phase?: RunPhase;
  runState: RunState;
  waitingReason?: WaitingReason;
  waitingText?: string;
  /** The review round in progress or last finished (0: none yet). */
  reviewRound: number;
  retryAt?: number;
  retryAttempts: number;
}

/** What the machine reads about the task besides its state. */
export interface MachineTask {
  type: TaskType;
  usePlan: boolean;
  useReview: boolean;
  planApproval: PlanApproval;
}

export interface MachineConfig {
  /** Review rounds, 1..10. */
  rounds: number;
  reReviewLastFix: boolean;
  /** What Continue without an answer tells a plan with questions (the kanban.defaultAnswer prompt, filled in). */
  defaultAnswer?: string;
}

/**
 * Which prompt a run is sent with. The orchestrator fills it in; `continue` is the short "carry on"
 * for a session that was cut off (it falls back to the phase's own prompt when there is no session).
 */
export type PromptKind = 'plan' | 'replan' | 'implement' | 'investigate' | 'review' | 'rereview' | 'fix' | 'resume' | 'continue' | 'unhold' | 'pr.create' | 'pr.fix' | 'pr.conflicts' | 'pr.review';

export type Effect =
  /**
   * Start a run. `round` undefined on a review or fix: a manual round (review() by hand), which ends
   * in the review column. `pending`: its text is the comments queued while the worker was busy.
   * `text`: what the user said (an answer, a comment, requested plan changes).
   */
  | { type: 'run'; phase: RunPhase; role: KanbanRole; prompt: PromptKind; round?: number; pending?: boolean; text?: string }
  /** The latest draft plan becomes the accepted one. */
  | { type: 'acceptPlan' }
  /** Record what the user asked to change on the latest draft. */
  | { type: 'planFeedback'; text: string }
  /** The review cycle is over: the reviewer goes home (its worktree is the task's, so it stays). */
  | { type: 'reviewerHome' }
  /** Interrupt the running turn (Esc into its terminal; a kill if it doesn't stop). */
  | { type: 'interrupt' }
  /** Keep the comment for the worker's next rest. */
  | { type: 'queueComment' }
  /** A line from the office in the task's conversation. */
  | { type: 'note'; text: string }
  /** The automation finished: it's in the review column now. */
  | { type: 'finished' };

export type MachineEvent =
  /** Start from To do, or a queued start whose slot came free. `slot`: there's room under maxConcurrent. */
  | { type: 'start'; slot: boolean }
  /** A run couldn't get a worker: no free desk, or the office's worker limit is full (`text` says which). It waits, queued. */
  | { type: 'noRoom'; text: string }
  /** A queued run (see noRoom) has room now: it starts as it was. */
  | { type: 'dequeue'; run: Extract<Effect, { type: 'run' }> }
  /** A plan turn ended. `pending`: comments came in meanwhile. */
  | { type: 'planned'; outcome: 'ready' | 'questions'; pending?: boolean }
  /** An implement (or investigate) turn ended. `changes`: anything differs from the base in any repository. */
  | { type: 'implemented'; changes: boolean; pending?: boolean }
  /** A review turn ended with its verdict (round undefined: a manual round). */
  | { type: 'reviewed'; round?: number; approved: boolean; pending?: boolean }
  /** A fix turn ended (round undefined: after a manual round). */
  | { type: 'fixed'; round?: number; changes: boolean; pending?: boolean }
  /** A resume turn (a comment worked on) ended. `since` 'handoff': `changes` counts from when the task last came to Review rather than from the base branch. */
  | { type: 'resumed'; changes: boolean; since?: 'handoff'; pending?: boolean }
  /** A pr, pr-fix or pr-conflicts turn ended. */
  | { type: 'prDone'; pending?: boolean }
  /** A review of several pull requests together (KanbanEngineApi.reviewPrs). */
  | { type: 'prReview' }
  /** That review's turn ended. */
  | { type: 'prReviewed'; pending?: boolean }
  /** The agent asks something in its terminal (needs_input outside a finished plan). */
  | { type: 'asking'; text?: string }
  /** The agent is working again after asking (someone answered in the terminal). */
  | { type: 'working' }
  | { type: 'stop' }
  /** The run stopped: by Stop (`by`), or its worker was sent home mid-run (`text` says so). */
  | { type: 'stopped'; by?: string; text?: string }
  /** The reviewer was sent home mid-round: the round is dropped. `pending`: comments came in meanwhile. */
  | { type: 'reviewAbandoned'; pending?: boolean }
  | { type: 'failed'; error: string }
  /** A usage limit or lost connection: try again at `retryAt` (attempt number `attempts`). */
  | { type: 'limited'; retryAt: number; attempts: number; text?: string }
  /** A usage limit that can't be waited out (too many attempts, or too long a wait). */
  | { type: 'gaveUp'; text: string }
  /** Its worker went away mid-run (an office restart, sent home). */
  | { type: 'interrupted'; text?: string }
  /** Run the last phase again. `last`: the task's latest run, if it has one. */
  | { type: 'retry'; last?: LastRun }
  /** Carry on from Waiting, with the user's answer when there is one. */
  | { type: 'continue'; answer?: string; last?: LastRun }
  | { type: 'approvePlan' }
  | { type: 'requestPlanChanges'; text: string }
  /** Take it off hold: a worker is hired again and carries on (the 'unhold' prompt). `text`: the user's note, stored as a comment first. */
  | { type: 'unhold'; text?: string; back?: { reason: WaitingReason; text?: string; phase?: RunPhase } }
  /** A user's comment. `busy`: the worker is in the middle of a turn (or asking in its terminal). */
  | { type: 'comment'; text: string; busy: boolean }
  /** One review round by hand. */
  | { type: 'review' }
  | { type: 'pr'; mode: PrMode };

/**
 * The run Retry and Continue carry on. `fresh`: it never started (stopped while queued), so it goes
 * with its phase's own prompt rather than "carry on" to a session that never worked on it.
 */
export interface LastRun {
  phase: RunPhase;
  round?: number;
  role: KanbanRole;
  fresh?: boolean;
}

export type Transition = { state: MachineState; effects: Effect[] } | { error: string };

const PLAN_WAITING: readonly (WaitingReason | undefined)[] = ['plan_questions', 'plan_approval'];
/** Why a task waits after something went wrong with a run: Retry puts it back to work. */
const RETRYABLE: readonly (WaitingReason | undefined)[] = ['stopped', 'failed', 'interrupted', 'usage_limit', 'agent_asking'];

/** The default of the kanban.defaultAnswer prompt, when the config doesn't bring the layered one. */
const DEFAULT_ANSWER = KANBAN_PROMPT_DEFS['kanban.defaultAnswer'].text;

/** Whether Retry puts the task back to work (it waits after something went wrong with a run). */
export function canRetry(s: Pick<MachineState, 'status' | 'runState' | 'waitingReason'>): boolean {
  return s.status === 'waiting' && !busy(s) && RETRYABLE.includes(s.waitingReason);
}

/** Whether the engine is busy with it: a run going, starting, queued or being stopped. */
export function busy(s: Pick<MachineState, 'runState'>): boolean {
  return s.runState !== 'idle';
}

/** The state with the waiting and retry fields cleared, and the rest as given. */
function moved(s: MachineState, patch: Partial<MachineState>): MachineState {
  return { ...s, waitingReason: undefined, waitingText: undefined, retryAt: undefined, ...patch };
}

function running(s: MachineState, phase: RunPhase, patch: Partial<MachineState> = {}): MachineState {
  return moved(s, { status: 'in_progress', runState: 'starting', phase, ...patch });
}

function waiting(s: MachineState, reason: WaitingReason, text?: string, patch: Partial<MachineState> = {}): MachineState {
  return { ...s, status: 'waiting', runState: 'idle', waitingReason: reason, waitingText: text, retryAt: undefined, ...patch };
}

/** The review column: the automation is done with it. */
function toReview(s: MachineState, extra: Effect[] = []): { state: MachineState; effects: Effect[] } {
  return { state: moved(s, { status: 'review', runState: 'idle', retryAttempts: 0 }), effects: [{ type: 'finished' }, ...extra] };
}

const ok = (state: MachineState, ...effects: Effect[]) => ({ state, effects });
const no = (error: string): Transition => ({ error });

/** The first run of a task: its plan, or straight to the work. */
function firstRun(s: MachineState, t: MachineTask): { state: MachineState; effects: Effect[] } {
  if (t.type === 'investigate') return ok(running(s, 'implement', { reviewRound: 0, retryAttempts: 0 }), { type: 'run', phase: 'implement', role: 'implementer', prompt: 'investigate' });
  if (t.usePlan) return ok(running(s, 'plan', { reviewRound: 0, retryAttempts: 0 }), { type: 'run', phase: 'plan', role: 'implementer', prompt: 'plan' });
  return ok(running(s, 'implement', { reviewRound: 0, retryAttempts: 0 }), { type: 'run', phase: 'implement', role: 'implementer', prompt: 'implement' });
}

/** The phase and prompt of each PR action. */
const PR_RUNS: Record<PrMode, { phase: RunPhase; prompt: PromptKind }> = { create: { phase: 'pr', prompt: 'pr.create' }, fix: { phase: 'pr-fix', prompt: 'pr.fix' }, conflicts: { phase: 'pr-conflicts', prompt: 'pr.conflicts' } };

/** The prompt a run of `phase` that never started is retried with (plan and resume carry on: what the user said went with the queue). */
function ownPrompt(phase: RunPhase, round: number | undefined, t: MachineTask): PromptKind {
  switch (phase) {
    case 'implement':
      return t.type === 'investigate' ? 'investigate' : 'implement';
    case 'review':
      return round !== undefined && round > 1 ? 'rereview' : 'review';
    case 'fix':
      return 'fix';
    case 'pr':
      return 'pr.create';
    case 'pr-fix':
      return 'pr.fix';
    case 'pr-conflicts':
      return 'pr.conflicts';
    case 'pr-review':
      return 'pr.review';
    default:
      return 'continue';
  }
}

/** Comments that came in during a turn are worked on before anything else. */
function deliverPending(s: MachineState, planning: boolean, extra: Effect[] = []): { state: MachineState; effects: Effect[] } {
  if (planning) return ok(running(s, 'plan', { retryAttempts: 0 }), ...extra, { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', pending: true });
  return ok(running(s, 'resume', { retryAttempts: 0 }), ...extra, { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', pending: true });
}

/** The implementation (or a comment's work) is done: review it, or hand it to the user. */
function afterWork(s: MachineState, t: MachineTask, changes: boolean, since?: 'handoff'): { state: MachineState; effects: Effect[] } {
  if (t.type === 'investigate') return toReview(s);
  if (!t.useReview) return toReview(s);
  if (!changes) return toReview(s, [{ type: 'note', text: since === 'handoff' ? 'Nothing changed since the task last came to Review, so there was nothing new to review.' : 'Nothing changed against the base branch in any repository, so there was nothing to review.' }]);
  return ok(running(s, 'review', { reviewRound: 1, retryAttempts: 0 }), { type: 'run', phase: 'review', role: 'reviewer', prompt: 'review', round: 1 });
}

/** The phase a comment or an answer resumes with, from where the task waits. */
function resumeWith(s: MachineState, text: string, pending = false): { state: MachineState; effects: Effect[] } {
  if (s.status === 'waiting' && PLAN_WAITING.includes(s.waitingReason)) {
    // Feedback belongs to a plan the user saw ready; answers to questions are just the next turn.
    const feedback: Effect[] = s.waitingReason === 'plan_approval' ? [{ type: 'planFeedback', text }] : [];
    return ok(running(s, 'plan'), ...feedback, { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', text, ...(pending ? { pending } : {}) });
  }
  return ok(running(s, 'resume'), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', text, ...(pending ? { pending } : {}) });
}

/** What each event does to a task on hold: the unhold resumes it, a comment is only stored, a turn's end changes nothing, the rest are refused. */
function onHold(s: MachineState, e: MachineEvent): Transition {
  switch (e.type) {
    case 'unhold':
      if (busy(s)) return no('Stop it first: it is running');
      // Held while waiting for the user's say on a plan: it waits for it again, nothing runs.
      if (e.back) return ok(waiting(s, e.back.reason, e.back.text, { phase: e.back.phase, retryAttempts: 0 }), { type: 'note', text: `▶️ Back from hold: ${e.back.reason === 'plan_approval' ? 'approve the plan' : "answer the plan's questions"} to carry on` });
      return ok(running(s, 'resume', { retryAttempts: 0 }), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'unhold' });
    case 'comment':
      return ok(s);
    case 'prReview':
    case 'pr':
      return no('It is on hold: resume it first');
    case 'start':
      return no('Only a task in To do can be started');
    case 'dequeue':
      return no('It is not queued');
    case 'stop':
      return no('It is not running');
    case 'retry':
      return no('Only a stopped, failed or interrupted task can be retried');
    case 'continue':
      return no('Only a waiting task can be continued');
    case 'approvePlan':
      return no('There is no plan waiting for approval');
    case 'requestPlanChanges':
      return no('There is no plan waiting for changes');
    case 'review':
      return no('Only a task in Waiting or Review can be reviewed by hand');
    default:
      // noRoom, asking, working, a turn's end, stopped, failed, limited, interrupted ...: nothing runs for it, so these are late news.
      return ok({ ...s, runState: 'idle' });
  }
}

export function next(s: MachineState, e: MachineEvent, t: MachineTask, cfg: MachineConfig): Transition {
  const rounds = Math.min(10, Math.max(1, Math.round(cfg.rounds)));
  // A turn's end only moves a task the automation still has: one dragged to Done (or back to To do)
  // meanwhile keeps its column.
  const automated = s.status === 'in_progress' || s.status === 'waiting';
  // A task on hold is parked: only unhold moves it, and a comment is just stored.
  if (s.status === 'on_hold') return onHold(s, e);
  switch (e.type) {
    case 'start':
      if (s.status !== 'todo' && !(s.status === 'in_progress' && s.runState === 'queued') && !(s.status === 'waiting' && !s.phase)) return no('Only a task in To do can be started');
      if (!e.slot) return ok(moved(s, { status: 'in_progress', runState: 'queued', phase: undefined, reviewRound: 0 }), { type: 'note', text: 'Queued: the project is running as many tasks as it may at once. It starts when one finishes.' });
      return firstRun(s, t);

    case 'noRoom':
      // It keeps its column and phase, so the card still says what's to come.
      return ok({ ...s, runState: 'queued' }, { type: 'note', text: e.text });

    case 'dequeue':
      if (s.runState !== 'queued') return no('It is not queued');
      return ok(running(s, e.run.phase), e.run);

    case 'planned': {
      if (!automated) return ok({ ...s, runState: 'idle' });
      if (e.pending) return deliverPending(s, true);
      if (e.outcome === 'questions') return ok(waiting(s, 'plan_questions', 'The plan has questions for you', { phase: 'plan', retryAttempts: 0 }));
      if (t.planApproval === 'manual') return ok(waiting(s, 'plan_approval', 'The plan is ready for your approval', { phase: 'plan', retryAttempts: 0 }));
      return ok(running(s, 'implement', { retryAttempts: 0 }), { type: 'acceptPlan' }, { type: 'run', phase: 'implement', role: 'implementer', prompt: 'implement' });
    }

    case 'implemented':
    case 'resumed':
      if (!automated) return ok({ ...s, runState: 'idle' });
      if (e.pending) return deliverPending(s, false);
      return afterWork(s, t, e.changes, 'since' in e ? e.since : undefined);

    case 'reviewed': {
      if (!automated) return ok({ ...s, runState: 'idle' }, { type: 'reviewerHome' });
      const r = e.round;
      // The review cycle is over (approved, or the final re-review still wants changes), but comments
      // came in while it ran: they're worked on first, and the result is reviewed again as usual.
      if (e.pending && (e.approved || (r !== undefined && r > rounds))) {
        const said = e.approved ? (r === undefined ? 'The review approved the work.' : `The review approved the work in round ${r}.`) : 'The final re-review still asks for changes: see its findings.';
        return deliverPending(s, false, [{ type: 'reviewerHome' }, { type: 'note', text: `${said} Comments came in while it ran: the agent works on them now.` }]);
      }
      if (e.approved) return toReview(s, [{ type: 'reviewerHome' }, { type: 'note', text: r === undefined ? 'The review approved the work.' : `The review approved the work in round ${r}.` }]);
      if (r !== undefined && r > rounds) {
        return toReview(s, [{ type: 'reviewerHome' }, { type: 'note', text: 'The final re-review still asks for changes: see its findings. Comment to have them worked on.' }]);
      }
      return ok(running(s, 'fix', { retryAttempts: 0 }), { type: 'run', phase: 'fix', role: 'implementer', prompt: 'fix', ...(r !== undefined ? { round: r } : {}) });
    }

    case 'fixed': {
      if (!automated) return ok({ ...s, runState: 'idle' }, { type: 'reviewerHome' });
      if (e.pending) return deliverPending(s, false, [{ type: 'reviewerHome' }]);
      const r = e.round;
      if (r === undefined) return toReview(s, [{ type: 'reviewerHome' }]);
      if (r < rounds || cfg.reReviewLastFix) {
        return ok(running(s, 'review', { reviewRound: r + 1, retryAttempts: 0 }), { type: 'run', phase: 'review', role: 'reviewer', prompt: 'rereview', round: r + 1 });
      }
      return toReview(s, [{ type: 'reviewerHome' }]);
    }

    case 'prDone':
      if (!automated) return ok({ ...s, runState: 'idle' });
      if (e.pending) return deliverPending(s, false);
      return toReview(s);

    case 'prReview':
      if (busy(s)) return no('Stop it first: it is running');
      if (s.status === 'archived') return no('An archived task gets no reviews');
      return ok(running(s, 'pr-review', { retryAttempts: 0 }), { type: 'run', phase: 'pr-review', role: 'reviewer', prompt: 'pr.review' });

    case 'prReviewed':
      if (!automated) return ok({ ...s, runState: 'idle' }, { type: 'reviewerHome' });
      if (e.pending) return deliverPending(s, false, [{ type: 'reviewerHome' }]);
      return toReview(s, [{ type: 'reviewerHome' }]);

    case 'asking':
      if (!automated) return ok(s);
      return ok(waiting(s, 'agent_asking', e.text ?? 'The agent is asking something in its terminal', { runState: 'idle' }));

    case 'working':
      if (s.status !== 'waiting' || s.waitingReason !== 'agent_asking') return ok(s);
      return ok(moved(s, { status: 'in_progress', runState: 'running' }));

    case 'stop':
      if (s.runState === 'queued') return ok(waiting(s, 'stopped', 'Stopped before it started'));
      if (s.runState === 'idle' && !(s.status === 'waiting' && s.waitingReason === 'agent_asking')) return no('It is not running');
      if (s.runState === 'stopping') return no('It is already stopping');
      return ok({ ...s, runState: 'stopping' }, { type: 'interrupt' });

    case 'stopped':
      if (!automated) return ok({ ...s, runState: 'idle' });
      return ok(waiting(s, 'stopped', e.text ?? (e.by ? `Stopped by ${e.by}` : 'Stopped')));

    case 'reviewAbandoned':
      // Nobody reviews it now: the comments typed meanwhile are worked on, or it's the user's to look at.
      if (!automated) return ok({ ...s, runState: 'idle' });
      if (e.pending) return deliverPending(s, false);
      return toReview(s);

    case 'failed':
      if (!automated) return ok({ ...s, runState: 'idle' });
      return ok(waiting(s, 'failed', e.error));

    case 'limited':
      if (!automated) return ok({ ...s, runState: 'idle' });
      return ok({ ...waiting(s, 'usage_limit', e.text ?? 'A usage limit or a lost connection interrupted it: it carries on by itself'), retryAt: e.retryAt, retryAttempts: e.attempts });

    case 'gaveUp':
      if (!automated) return ok({ ...s, runState: 'idle' });
      return ok(waiting(s, 'usage_limit', e.text, { retryAttempts: s.retryAttempts }));

    case 'interrupted':
      if (!automated) return ok({ ...s, runState: 'idle' });
      return ok(waiting(s, 'interrupted', e.text ?? 'Its worker went away mid-run: Retry to carry on'));

    case 'retry': {
      if (!canRetry(s)) return no('Only a stopped, failed or interrupted task can be retried');
      if (!e.last) return firstRun(s, t);
      const { phase, round, role, fresh } = e.last;
      return ok(running(s, phase), { type: 'run', phase, role, prompt: fresh ? ownPrompt(phase, round, t) : 'continue', ...(round !== undefined ? { round } : {}) });
    }

    case 'continue': {
      if (s.status !== 'waiting' || busy(s)) return no('Only a waiting task can be continued');
      const answer = e.answer?.trim();
      if (s.waitingReason === 'plan_questions') return ok(running(s, 'plan'), { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', text: answer || cfg.defaultAnswer || DEFAULT_ANSWER });
      if (s.waitingReason === 'plan_approval') {
        if (answer) return ok(running(s, 'plan'), { type: 'planFeedback', text: answer }, { type: 'run', phase: 'plan', role: 'implementer', prompt: 'replan', text: answer });
        return ok(running(s, 'implement'), { type: 'acceptPlan' }, { type: 'run', phase: 'implement', role: 'implementer', prompt: 'implement' });
      }
      if (answer) return ok(running(s, 'resume'), { type: 'run', phase: 'resume', role: 'implementer', prompt: 'resume', text: answer });
      return next(s, { type: 'retry', last: e.last }, t, cfg);
    }

    case 'approvePlan':
      if (s.status !== 'waiting' || busy(s) || !PLAN_WAITING.includes(s.waitingReason)) return no('There is no plan waiting for approval');
      return ok(running(s, 'implement'), { type: 'acceptPlan' }, { type: 'run', phase: 'implement', role: 'implementer', prompt: 'implement' });

    case 'requestPlanChanges':
      if (s.status !== 'waiting' || busy(s) || !PLAN_WAITING.includes(s.waitingReason)) return no('There is no plan waiting for changes');
      if (!e.text.trim()) return no('Say what to change');
      return resumeWith(s, e.text.trim());

    case 'unhold':
      return no('Only a task on hold can be resumed');

    case 'comment':
      if (s.status === 'todo' || s.status === 'done' || s.status === 'archived') return ok(s);
      if (e.busy || busy(s)) return ok(s, { type: 'queueComment' });
      return resumeWith(s, e.text);

    case 'review':
      if (busy(s)) return no('Stop it first: it is running');
      if (t.type === 'investigate') return no('An investigation has no changes to review');
      if (s.status !== 'review' && !(s.status === 'waiting' && !PLAN_WAITING.includes(s.waitingReason))) return no('Only a task in Waiting or Review can be reviewed by hand');
      return ok(running(s, 'review'), { type: 'run', phase: 'review', role: 'reviewer', prompt: 'review' });

    case 'pr':
      if (busy(s)) return no('Stop it first: it is running');
      if (t.type === 'investigate' && e.mode === 'create') return no('An investigation has no changes to open pull requests for');
      if (!prStatusOk(s.status)) return no(`Pull requests are ${e.mode === 'create' ? 'opened' : e.mode === 'fix' ? 'fixed' : 'updated'} from Waiting, Review or Done`);
      return ok(running(s, PR_RUNS[e.mode].phase), { type: 'run', phase: PR_RUNS[e.mode].phase, role: 'implementer', prompt: PR_RUNS[e.mode].prompt });
  }
}

export type RunEffect = Extract<Effect, { type: 'run' }>;

/** The part of a stored task the machine decides about. */
export function stateOf(t: KanbanTask): MachineState {
  return { status: t.status, phase: t.phase, runState: t.runState, waitingReason: t.waitingReason, waitingText: t.waitingText, reviewRound: t.reviewRound, retryAt: t.retryAt, retryAttempts: t.retryAttempts };
}

/** A run effect as a task keeps it while it waits for a desk (KanbanTask.queuedRun), and back. */
export const queuedOf = (eff: RunEffect): QueuedRun => ({ phase: eff.phase, role: eff.role, prompt: eff.prompt, ...(eff.round !== undefined ? { round: eff.round } : {}), ...(eff.pending ? { pending: true } : {}), ...(eff.text !== undefined ? { text: eff.text } : {}) });
export const runOf = (q: QueuedRun): RunEffect => ({ type: 'run', phase: q.phase, role: q.role, prompt: q.prompt as PromptKind, ...(q.round !== undefined ? { round: q.round } : {}), ...(q.pending ? { pending: true } : {}), ...(q.text !== undefined ? { text: q.text } : {}) });

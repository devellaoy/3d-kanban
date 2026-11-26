// What the orchestrator follows of a run it started (`Live`), and what an operation carries into the effects it causes (`Via`).

import type { PendingMessage, AskingKind, KanbanPrReviewRequest, KanbanRole, KanbanTask, KanbanTool } from '../../../shared/kanban/types.js';
import type { ReviewPanelPart } from '../../../shared/kanban/review.js';
import type { KanbanCaller } from '../registry.js';
import type { RunEffect } from './machine.js';
import type { HeldRun } from './turnhold.js';

/** Whether a run is a pull-request review's UI test: the pr-review phase's implementer-role run (followed as an implement run: see Live.ui). */
export const isUiRun = (run: { phase: string; role: string }) => run.phase === 'pr-review' && run.role === 'implementer';

/** A run the engine started and is following, by the worker it runs on. */
export interface Live extends HeldRun {
  round?: number;
  role: KanbanRole;
  /** 1..4: an additional reviewer's run (its events go to the review panel, never to the state machine); absent for every other. */
  seat?: number;
  /** The part of a review round with several reviewers this run is (absent: an ordinary run). */
  panel?: ReviewPanelPart;
  tool: KanbanTool;
  /** The run is a pull-request review's UI test (phase pr-review, role implementer): followed as an implement run, so its `phase` is 'implement'. */
  ui?: true;
  /** Claude asked to leave plan mode (ExitPlanMode): its needs_input is the finished plan. */
  exitPlan: boolean;
  /** The plan of that ExitPlanMode, as its hook gave it: Claude writes the call to its session log later than the hook comes (see planFromHook). */
  hookPlan?: string;
  /** ExitPlanMode's approval dialog is up (its PermissionRequest was heard): no other tool's hook is Claude going on until it is answered. */
  planAsked?: boolean;
  /** The run was told that Claude's auto mode is not available (see autoModeUnavailable): once per run. */
  autoModeNoted?: boolean;
  /** What its agent's needs_input waits on, as its hooks last said (heardAsk); unknown when unset. */
  asks?: AskingKind;
  /** Its agent was started on a stored session (--resume) and has not been heard from yet: if it exits now, the session is gone (see exited). */
  resumed?: boolean;
  started?: boolean;
  typed?: boolean; // its prompt was typed into the running agent: it has it once the agent's prompt hook or work is heard (see receipt)
  /** False while an old process of the worker is still being ended for a relaunch: its events are not the new agent's. */
  armed?: boolean;
  /** What its run was asked to do (the text as it went), to start it again in a fresh session; and what is to be acknowledged once the agent has the prompt. */
  eff?: RunEffect;
  via?: Via;
  ack?: () => void;
  stopping?: { by?: string; at?: number; timer?: NodeJS.Timeout };
  /** The work on the comments made while it stopped (`defer` in finishStopped), kept until its worker is restarted: deliverStopped starts it (see endStop). */
  afterStop?: () => Promise<void>;
  /** A finished turn handled after an office restart: its result is read from the run's start, the woken process's SessionStart is later. */
  pinSince?: boolean;
}

/** What an operation carries into the effects it causes. */
export interface Via {
  who?: KanbanCaller;
  commentId?: number;
  /** A pull-request review's request (reviewPrs), for its run. */
  prReview?: KanbanPrReviewRequest;
  /** Where a start's first hire sits (start with a desk: the 3D hire form). */
  deskId?: string;
  /** A run that works on the comments made since then (a Stop's own: see finishStopped); the older ones stay queued. */
  pendingSince?: number;
  /** The queued comments the run took off the task for its prompt (Comments.take): put back if its agent never gets the prompt. */
  taken?: PendingMessage[];
}

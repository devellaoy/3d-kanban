// Review settings and the parts of a review round that has several reviewers (docs/kanban-architecture.md).
// Plain data: the settings file, the database and the WebSocket all carry these.

import type { KanbanEffort, KanbanTool } from './types.js';

/** One reviewer besides the main one: which agent, and how it runs. */
export interface ReviewerSpec {
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
}

/** Additional reviewers a review can have besides the main reviewer. */
export const MAX_EXTRA_REVIEWERS = 4;

export interface ReviewSettings {
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  /** Additional reviewers, who review at the same time as the main one; absent or empty = none. */
  extra?: ReviewerSpec[];
  /** Review rounds, 1..10. */
  rounds: number;
  /** After the last round's fix, review once more (true) or go straight to the review column. */
  reReviewLastFix: boolean;
  /** Keep the reviewer off the web too (claude: no WebFetch/WebSearch). */
  sandbox: boolean;
}

/** A task's co-reviewer slot. Seat 1..4; seat 0 is the main reviewer and is not in the list. */
export interface CoReviewer {
  seat: number;
  workerId?: string;
  sessionId?: string;
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
}

/** What a review-phase run is in a round with several reviewers: the only one, a co-reviewer's, or the main reviewer combining. */
export type ReviewPanelPart = 'solo' | 'co' | 'combine';

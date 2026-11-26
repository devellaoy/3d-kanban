// Review settings and the parts of a review round that has several reviewers (docs/kanban-architecture.md).
// Plain data: the settings file, the database and the WebSocket all carry these.

import type { KanbanEffort, KanbanTool } from './types.js';

/** One reviewer besides the main one: which agent, and how it runs. */
export interface ReviewerSpec {
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  /** The viewpoint it reviews from ("Security"); absent = an ordinary review. */
  focus?: string;
}

/** Additional reviewers a review can have besides the main reviewer. */
export const MAX_EXTRA_REVIEWERS = 4;

/** The longest a reviewer's focus can be. */
export const REVIEW_FOCUS_MAX = 40;
/** The viewpoints the settings suggest for a reviewer's focus (any text can be typed). */
export const REVIEW_FOCUS_SUGGESTIONS = ['Correctness', 'Simplicity', 'Security'] as const;

/** A reviewer's focus as it is stored: one line, trimmed, at most REVIEW_FOCUS_MAX long; undefined when there is none. */
export function cleanFocus(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Control characters go, and the cut is by code point so that it never splits a character.
  const line = v.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return Array.from(line).slice(0, REVIEW_FOCUS_MAX).join('').trim() || undefined;
}

export interface ReviewSettings {
  tool: KanbanTool;
  model?: string;
  effort?: KanbanEffort;
  /** The main reviewer's viewpoint for its own review; absent or empty = an ordinary review (a project's empty one stands over the office's). */
  focus?: string;
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
  focus?: string;
}

/** What a review-phase run is in a round with several reviewers: the only one, a co-reviewer's, or the main reviewer combining. */
export type ReviewPanelPart = 'solo' | 'co' | 'combine';

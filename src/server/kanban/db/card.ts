// A task's card, as the board shows it.
import type { KanbanTask, KanbanTaskCard, KanbanTool } from '../../../shared/kanban/types.js';
import { clean } from './columns.js';

/** What the card needs from the settings: the review rounds and tool that apply to the task, and how many additional reviewers it has. */
export type CardReview = (task: Pick<KanbanTask, 'project' | 'overrides'>) => { rounds: number; tool: KanbanTool; extra?: number };

/** A task's card. `review` gives the rounds and tool that apply (from the settings); without it, 0 and the task's tool. */
export function toCard(t: KanbanTask, commentCount: number, review?: CardReview): KanbanTaskCard {
  const r = review?.(t);
  return clean({
    id: t.id,
    project: t.project,
    title: t.title,
    type: t.type,
    status: t.status,
    ticket: t.ticket,
    ticketUrl: t.ticketUrl,
    repoIds: t.repoIds,
    phase: t.phase,
    runState: t.runState,
    reviewRound: t.reviewRound,
    reviewRounds: t.useReview ? (r?.rounds ?? 0) : 0,
    useReview: t.useReview,
    tool: t.tool,
    model: t.model,
    reviewTool: t.useReview ? r?.tool : undefined,
    reviewerCount: t.useReview && r ? 1 + (r.extra ?? 0) : undefined,
    coReviewers: t.coReviewers?.map((c) => clean({ seat: c.seat, workerId: c.workerId, tool: c.tool })),
    waitingReason: t.waitingReason,
    waitingText: t.waitingText,
    askingKind: t.askingKind,
    hold: t.hold,
    retryAt: t.retryAt,
    prs: t.prs.map((p) => clean({ repoId: p.repoId, repo: p.repo, number: p.number, url: p.url, state: p.state, review: p.review, unresolved: p.unresolved })),
    tags: t.tags,
    workerId: t.workerId,
    reviewerWorkerId: t.reviewerWorkerId,
    commentCount,
    pendingCount: t.pendingMessages.length,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    legacy: t.legacy ? true : undefined,
  });
}

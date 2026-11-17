import type { GhComment, GhPullDetail, GhReviewComment, GhThread, GhTimelineEvent } from '../../../shared/protocol';

// A PR's conversation in the order GitHub shows it, worked out without the DOM: the history's events with
// the comments and reviews where GitHub lists them, the line-comment threads placed by time, and the
// words each event is told in. The Conversation tab (pull-window.ts) draws what comes out of here.

/** A step of the history that is drawn as a row of its own (a `ref` only says where a comment stands). */
export type GhHappening = Exclude<GhTimelineEvent, { kind: 'ref' }>;
export type GhCommit = Extract<GhTimelineEvent, { kind: 'commit' }>;

/** One entry of the conversation. `at` is when it happened, used only to place what GitHub's order doesn't name. */
export type TimelineItem =
  | { kind: 'comment'; at: string; comment: GhComment }
  | { kind: 'review'; at: string; review: GhComment }
  /** A thread of line comments, by its first comment. */
  | { kind: 'thread'; at: string; root: GhReviewComment }
  | { kind: 'event'; at: string; event: GhHappening }
  /** Commits that came one after another (groupCommits). */
  | { kind: 'commits'; at: string; commits: GhCommit[] };

type Detail = Pick<GhPullDetail, 'comments' | 'reviews' | 'reviewComments' | 'events' | 'threads'>;

/**
 * The conversation's entries in order. With `events`, GitHub's own order is the backbone (a commit made
 * at 09:50 but pushed after a 10:00 comment stays after it), each `ref` replaced by the comment or review
 * it names. A thread of line comments follows the review it came with (even a review with no card of its
 * own, which still marks the place), several of one review in the order they were made. What the order
 * doesn't name (threads without a review in it, comments past a cut history) goes in by time, before the
 * first backbone entry that happened later. Without `events`, everything by time.
 */
export function timelineItems(d: Detail): TimelineItem[] {
  const comments = d.comments.map((c): TimelineItem => ({ kind: 'comment', at: c.createdAt, comment: c }));
  const reviews = d.reviews.map((r): TimelineItem => ({ kind: 'review', at: r.createdAt, review: r }));
  const info = threadByRoot(d.threads);
  const roots = d.reviewComments.filter((c) => !c.replyTo).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A thread goes by when its first comment was published, which a review's drafts are not.
  const threads = roots.map((c): TimelineItem => ({ kind: 'thread', at: info.get(c.id)?.at ?? c.createdAt, root: c }));
  const byTime = (a: TimelineItem, b: TimelineItem) => a.at.localeCompare(b.at);
  if (!d.events) return [...comments, ...reviews, ...threads].sort(byTime);

  const named = new Map<string, TimelineItem>();
  d.comments.forEach((c, i) => named.set(c.id, comments[i]));
  d.reviews.forEach((r, i) => named.set(r.id, reviews[i]));
  const backbone: TimelineItem[] = [];
  // Threads by the review they came with, each to go right after that review's place (by how many entries precede it).
  const ofReview = new Map<string, TimelineItem[]>();
  for (const t of threads) {
    const r = t.kind === 'thread' ? info.get(t.root.id)?.review : undefined;
    if (r) ofReview.set(r, [...(ofReview.get(r) ?? []), t]);
  }
  const anchored = new Map<number, TimelineItem[]>();
  for (const e of d.events) {
    if (e.kind !== 'ref') {
      backbone.push({ kind: 'event', at: e.at, event: e });
      continue;
    }
    const x = named.get(e.id);
    named.delete(e.id);
    // Placed by when GitHub's order says it happened, which is what the entries around it go by.
    // A comment GitHub lists that the office didn't read (or an empty review) has no card, but its place stands.
    if (x) backbone.push({ ...x, at: e.at });
    const t = ofReview.get(e.id);
    if (t) {
      anchored.set(backbone.length, [...(anchored.get(backbone.length) ?? []), ...t]);
      for (const y of t) y.at = e.at;
      ofReview.delete(e.id);
    }
  }
  const placed = new Set([...anchored.values()].flat());
  // What no ref named, oldest first, each before the first backbone entry that is later than it.
  const before = new Map<number, TimelineItem[]>();
  for (const x of [...named.values(), ...threads.filter((t) => !placed.has(t))].sort(byTime)) {
    const i = backbone.findIndex((b) => b.at > x.at);
    const at = i < 0 ? backbone.length : i;
    before.set(at, [...(before.get(at) ?? []), x]);
  }
  const out: TimelineItem[] = [];
  for (let i = 0; i <= backbone.length; i++) {
    out.push(...(anchored.get(i) ?? []), ...(before.get(i) ?? []));
    if (i < backbone.length) out.push(backbone[i]);
  }
  return out;
}

/** Commits that follow one another become one entry, as GitHub lists a push. */
export function groupCommits(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (x.kind !== 'event' || x.event.kind !== 'commit') out.push(x);
    else if (last?.kind === 'commits') last.commits.push(x.event);
    else out.push({ kind: 'commits', at: x.at, commits: [x.event] });
  }
  return out;
}

/** The threads by the id of their first comment (GhReviewComment.id). */
export function threadByRoot(threads: GhThread[] | undefined): Map<number, GhThread> {
  return new Map((threads ?? []).map((t) => [t.rootId, t]));
}

/** How many threads are still unresolved; undefined when GitHub didn't say (a hosted repository, a failed read). */
export function unresolvedCount(d: Pick<GhPullDetail, 'threads'>): number | undefined {
  return d.threads?.filter((t) => !t.resolved).length;
}

const STATE_WORDS: Record<Extract<GhHappening, { kind: 'state' }>['what'], string> = {
  merged: 'merged this',
  closed: 'closed this',
  reopened: 'reopened this',
  ready: 'marked this ready for review',
  draft: 'marked this as a draft',
};

/** What happened, as the words after who did it ("requested a review from @x"). */
export function eventText(e: GhHappening): string {
  switch (e.kind) {
    case 'commit':
      return `added the commit ${e.headline}`;
    case 'force-push':
      return e.before && e.after ? `force-pushed the branch from ${e.before} to ${e.after}` : 'force-pushed the branch';
    case 'state':
      return STATE_WORDS[e.what];
    case 'review-request':
      if (e.reviewer === e.actor) return e.removed ? 'removed their own review request' : 'self-requested a review';
      return e.removed ? `removed the review request for @${e.reviewer}` : `requested a review from @${e.reviewer}`;
    case 'label':
      return `${e.removed ? 'removed' : 'added'} the label ${e.label}`;
    case 'assign':
      if (e.assignee === e.actor) return e.removed ? 'removed their own assignment' : 'self-assigned this';
      return `${e.removed ? 'unassigned' : 'assigned'} @${e.assignee}`;
    case 'rename':
      return `changed the title from “${e.from}” to “${e.to}”`;
    case 'base':
      return `changed the base branch from ${e.from} to ${e.to}`;
    case 'branch':
      return e.what === 'restored' ? 'restored the branch' : e.name ? `deleted the ${e.name} branch` : 'deleted the branch';
  }
}

/** What changed on GitHub: a reply it saved, or how a thread stands now. */
export type ThreadChange = { reply: GhReviewComment } | { thread: string; resolved: boolean };
/** Puts a change into what the window knows of the pull request. */
export function takeThreadChange(d: { reviewComments: GhReviewComment[]; threads?: GhThread[] }, change: ThreadChange) {
  if ('reply' in change) d.reviewComments.push(change.reply);
  else
    d.threads = d.threads?.map((t) => {
      if (t.id !== change.thread) return t;
      // The rest stays, the review it came with above all: that is where it stands in the history.
      // Who resolved it isn't in the answer, so the name of whoever did before goes.
      const { resolvedBy: _, ...kept } = t;
      return { ...kept, resolved: change.resolved };
    });
}

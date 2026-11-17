// A pull request's history for the PR window: what happened between the comments (commits, force
// pushes, review requests, merging ...) in the order GitHub lists it, and which threads of line
// comments are resolved. REST has neither, so both come from GraphQL, read beside the other reads of
// GitHub.pullDetail and never allowed to hold the window up (see readHistory).
import type { GhReviewComment, GhThread, GhTimelineEvent } from '../shared/protocol.js';

/** gh from server/github.ts (passed in rather than imported, which would be circular). */
export type GhRun = (args: string[], cwd: string, timeout?: number) => Promise<string>;

/** Pages of 100 read before the rest is left to GitHub (`cut`). */
const MAX_EVENT_PAGES = 5;
const MAX_THREAD_PAGES = 3;
/** The whole history read may take this long; after it the window opens without it. */
export const HISTORY_LIMIT_MS = 8000;

const ACTOR = 'actor{login}';
const REVIEWER = 'requestedReviewer{__typename ... on User{login} ... on Team{name} ... on Bot{login} ... on Mannequin{login}}';
const ASSIGNEE = 'assignee{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Organization{login}}';

const EVENT_TYPES = [
  'ISSUE_COMMENT',
  'PULL_REQUEST_REVIEW',
  'PULL_REQUEST_COMMIT',
  'HEAD_REF_FORCE_PUSHED_EVENT',
  'MERGED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'READY_FOR_REVIEW_EVENT',
  'CONVERT_TO_DRAFT_EVENT',
  'REVIEW_REQUESTED_EVENT',
  'REVIEW_REQUEST_REMOVED_EVENT',
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'RENAMED_TITLE_EVENT',
  'BASE_REF_CHANGED_EVENT',
  'HEAD_REF_DELETED_EVENT',
  'HEAD_REF_RESTORED_EVENT',
];

const TIMELINE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$before:String){repository(owner:$owner,name:$name){pullRequest(number:$number){timelineItems(last:100,before:$before,itemTypes:[${EVENT_TYPES.join(',')}]){nodes{__typename
... on IssueComment{id createdAt}
... on PullRequestReview{id createdAt}
... on PullRequestCommit{commit{oid messageHeadline committedDate url author{name user{login}}}}
... on HeadRefForcePushedEvent{createdAt ${ACTOR} beforeCommit{oid} afterCommit{oid}}
... on MergedEvent{createdAt ${ACTOR}}
... on ClosedEvent{createdAt ${ACTOR}}
... on ReopenedEvent{createdAt ${ACTOR}}
... on ReadyForReviewEvent{createdAt ${ACTOR}}
... on ConvertToDraftEvent{createdAt ${ACTOR}}
... on ReviewRequestedEvent{createdAt ${ACTOR} ${REVIEWER}}
... on ReviewRequestRemovedEvent{createdAt ${ACTOR} ${REVIEWER}}
... on LabeledEvent{createdAt ${ACTOR} label{name}}
... on UnlabeledEvent{createdAt ${ACTOR} label{name}}
... on AssignedEvent{createdAt ${ACTOR} ${ASSIGNEE}}
... on UnassignedEvent{createdAt ${ACTOR} ${ASSIGNEE}}
... on RenamedTitleEvent{createdAt ${ACTOR} previousTitle currentTitle}
... on BaseRefChangedEvent{createdAt ${ACTOR} previousRefName currentRefName}
... on HeadRefDeletedEvent{createdAt ${ACTOR} headRefName}
... on HeadRefRestoredEvent{createdAt ${ACTOR}}
}pageInfo{hasPreviousPage startCursor}}}}}`;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$before:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(last:100,before:$before){nodes{id isResolved resolvedBy{login} comments(first:1){nodes{databaseId publishedAt pullRequestReview{id}}}}pageInfo{hasPreviousPage startCursor}}}}}`;

/** The fields of a line comment as REST sends it that GhReviewComment is made from (see reviewCommentOf). */
export const REVIEW_COMMENT_JQ = '{id, in_reply_to_id, path, line, side, body, user: .user.login, created_at, html_url}';

/** A line comment from REST, cut down by REVIEW_COMMENT_JQ. */
export function reviewCommentOf(c: any): GhReviewComment {
  return {
    id: c.id,
    replyTo: c.in_reply_to_id ?? undefined,
    author: c.user ?? 'ghost',
    body: String(c.body ?? ''),
    createdAt: c.created_at,
    url: c.html_url,
    path: c.path,
    line: c.line ?? null,
    side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const login = (a: any): string => str(a?.login) || 'ghost';
/** Whoever or whatever a review was requested from or an issue assigned to: a user, a bot or a team. */
const who = (a: any): string => str(a?.login) || str(a?.name) || 'ghost';

const STATES: Record<string, 'merged' | 'closed' | 'reopened' | 'ready' | 'draft'> = {
  MergedEvent: 'merged',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
  ReadyForReviewEvent: 'ready',
  ConvertToDraftEvent: 'draft',
};

function eventOf(n: any): GhTimelineEvent | undefined {
  const at = str(n.createdAt);
  const actor = login(n.actor);
  switch (n.__typename) {
    case 'IssueComment':
    case 'PullRequestReview':
      return str(n.id) ? { kind: 'ref', at, id: n.id } : undefined;
    case 'PullRequestCommit': {
      const c = n.commit;
      if (!str(c?.oid)) return undefined;
      return { kind: 'commit', at: str(c.committedDate), oid: c.oid, headline: str(c.messageHeadline), author: str(c.author?.user?.login) || str(c.author?.name) || 'ghost', url: str(c.url) };
    }
    case 'HeadRefForcePushedEvent': {
      const [before, after] = [str(n.beforeCommit?.oid), str(n.afterCommit?.oid)];
      return { kind: 'force-push', at, actor, ...(before ? { before: before.slice(0, 7) } : {}), ...(after ? { after: after.slice(0, 7) } : {}) };
    }
    case 'MergedEvent':
    case 'ClosedEvent':
    case 'ReopenedEvent':
    case 'ReadyForReviewEvent':
    case 'ConvertToDraftEvent':
      return { kind: 'state', at, actor, what: STATES[n.__typename] };
    case 'ReviewRequestedEvent':
    case 'ReviewRequestRemovedEvent':
      return { kind: 'review-request', at, actor, reviewer: who(n.requestedReviewer), ...(n.__typename === 'ReviewRequestRemovedEvent' ? { removed: true } : {}) };
    case 'LabeledEvent':
    case 'UnlabeledEvent':
      return str(n.label?.name) ? { kind: 'label', at, actor, label: n.label.name, ...(n.__typename === 'UnlabeledEvent' ? { removed: true } : {}) } : undefined;
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return { kind: 'assign', at, actor, assignee: who(n.assignee), ...(n.__typename === 'UnassignedEvent' ? { removed: true } : {}) };
    case 'RenamedTitleEvent':
      return { kind: 'rename', at, actor, from: str(n.previousTitle), to: str(n.currentTitle) };
    case 'BaseRefChangedEvent':
      return { kind: 'base', at, actor, from: str(n.previousRefName), to: str(n.currentRefName) };
    case 'HeadRefDeletedEvent':
      return { kind: 'branch', at, actor, what: 'deleted', ...(str(n.headRefName) ? { name: n.headRefName } : {}) };
    case 'HeadRefRestoredEvent':
      return { kind: 'branch', at, actor, what: 'restored' };
    default:
      return undefined;
  }
}

/**
 * The events from the `nodes` of `timelineItems` (all pages), in the order given. Unknown and empty
 * nodes are left out, and so is the ClosedEvent GitHub also sends for a merge (its page shows the merge
 * only): the one at the merge's time, else the one right next to it. Earlier closes stay.
 */
export function parseTimeline(nodes: unknown): GhTimelineEvent[] {
  const events = (Array.isArray(nodes) ? nodes : []).map((n) => (n && typeof n === 'object' ? eventOf(n) : undefined)).filter((e): e is GhTimelineEvent => !!e);
  const isClosed = (e?: GhTimelineEvent) => e?.kind === 'state' && e.what === 'closed';
  const drop = new Set<number>();
  events.forEach((m, mi) => {
    if (m.kind !== 'state' || m.what !== 'merged') return;
    const same = events.map((e, i) => i).filter((i) => isClosed(events[i]) && events[i].at === m.at && !drop.has(i));
    same.sort((a, b) => Math.abs(a - mi) - Math.abs(b - mi));
    const next = [mi - 1, mi + 1].find((i) => isClosed(events[i]) && !drop.has(i));
    const gone = same[0] ?? next;
    if (gone !== undefined) drop.add(gone);
  });
  return events.filter((_, i) => !drop.has(i));
}

/** The threads from the `nodes` of `reviewThreads` (all pages). */
export function parseThreads(nodes: unknown): GhThread[] {
  const out: GhThread[] = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const first = n?.comments?.nodes?.[0];
    const rootId = first?.databaseId;
    if (!str(n?.id) || !Number.isSafeInteger(rootId)) continue;
    const by = str(n.resolvedBy?.login);
    const [review, at] = [str(first.pullRequestReview?.id), str(first.publishedAt)];
    out.push({ id: n.id, rootId, resolved: n.isResolved === true, ...(n.isResolved === true && by ? { resolvedBy: by } : {}), ...(review ? { review } : {}), ...(at ? { at } : {}) });
  }
  return out;
}

/** The GraphQL mutation that resolves a thread, or reopens it; its one variable is the thread's id. */
export function resolveMutation(resolved: boolean): string {
  const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  return `mutation($id:ID!){${name}(input:{threadId:$id}){thread{id isResolved}}}`;
}

/** The GraphQL query for which pull request a thread belongs to; its one variable is the thread's id. */
export const THREAD_OWNER_QUERY = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{number repository{nameWithOwner}}}}}';

/** Whether gh's answer to THREAD_OWNER_QUERY says the thread is of PR `n` in `target` (owner/name, any case). */
export function threadIsOf(out: string, n: number, target: string): boolean {
  const pr = JSON.parse(out)?.data?.node?.pullRequest;
  return pr?.number === n && str(pr?.repository?.nameWithOwner).toLowerCase() === target.toLowerCase();
}

/** Whether the thread is resolved after the mutation, from gh's answer; undefined when it doesn't say. */
export function resolvedOf(out: string): boolean | undefined {
  const data = JSON.parse(out)?.data;
  const thread = data?.resolveReviewThread?.thread ?? data?.unresolveReviewThread?.thread;
  return typeof thread?.isResolved === 'boolean' ? thread.isResolved : undefined;
}

/**
 * Reads one list from its newest end a page at a time (`more` when GitHub has older pages beyond `max`),
 * each page with its own cursor, and gives the nodes back in chronological order.
 */
async function pages(gh: GhRun, query: string, field: 'timelineItems' | 'reviewThreads', owner: string, name: string, n: number, cwd: string, max: number): Promise<{ nodes: unknown[]; more: boolean }> {
  const newestFirst: unknown[][] = [];
  let before: string | undefined;
  for (let page = 0; page < max; page++) {
    // -F sends the number as an Int; -f would make it a String the query refuses.
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`, ...(before ? ['-f', `before=${before}`] : [])];
    const list = JSON.parse(await gh(args, cwd, HISTORY_LIMIT_MS))?.data?.repository?.pullRequest?.[field];
    if (!list) throw new Error('GitHub sent no history for this pull request');
    newestFirst.push(Array.isArray(list.nodes) ? list.nodes : []);
    if (!list.pageInfo?.hasPreviousPage || !list.pageInfo?.startCursor) return { nodes: newestFirst.reverse().flat(), more: false };
    before = list.pageInfo.startCursor;
  }
  return { nodes: newestFirst.reverse().flat(), more: true };
}

/**
 * The history of PR `n` in `target` (owner/name): the newest 500 events and 300 threads (`cut` when there
 * are older ones). Never rejects, and gives up after `limit` ms, so a slow GraphQL can't hold the window up:
 * what went wrong comes back as `error`.
 */
export async function readHistory(gh: GhRun, target: string, n: number, cwd: string, limit = HISTORY_LIMIT_MS): Promise<{ events: GhTimelineEvent[]; threads: GhThread[]; cut: boolean } | { error: string }> {
  const [owner, name] = target.split('/');
  if (!owner || !name) return { error: 'The pull request has no known repository' };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: 'GitHub took too long to answer' }), limit);
  });
  const read = Promise.all([pages(gh, TIMELINE_QUERY, 'timelineItems', owner, name, n, cwd, MAX_EVENT_PAGES), pages(gh, THREADS_QUERY, 'reviewThreads', owner, name, n, cwd, MAX_THREAD_PAGES)]).then(
    ([events, threads]) => ({ events: parseTimeline(events.nodes), threads: parseThreads(threads.nodes), cut: events.more || threads.more }),
    (err: Error) => ({ error: err.message || 'GitHub could not be asked' }),
  );
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

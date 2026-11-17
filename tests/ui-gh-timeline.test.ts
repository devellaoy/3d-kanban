// The PR window's conversation order (ui/github/timeline-model.ts): GitHub's own order of events is the
// backbone, comments and reviews stand where it names them, and the rest goes in by time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventText, groupCommits, takeThreadChange, threadByRoot, timelineItems, unresolvedCount, type TimelineItem } from '../src/client/ui/github/timeline-model.ts';
import type { GhComment, GhReviewComment, GhTimelineEvent } from '../src/shared/protocol.ts';

const day = (hhmm: string) => `2026-11-16T${hhmm}:00Z`;
const comment = (id: string, at: string): GhComment => ({ id, author: 'ann', body: id, createdAt: day(at) });
const review = (id: string, at: string): GhComment => ({ ...comment(id, at), state: 'COMMENTED' });
const line = (id: number, at: string, replyTo?: number): GhReviewComment => ({ id, replyTo, author: 'bob', body: String(id), createdAt: day(at), url: `https://example.test/c/${id}`, path: 'src/a.ts', line: 3, side: 'RIGHT' });
const commit = (oid: string, at: string): GhTimelineEvent => ({ kind: 'commit', at: day(at), oid, headline: `commit ${oid}`, author: 'ann', url: `https://example.test/${oid}` });
const ref = (id: string, at: string): GhTimelineEvent => ({ kind: 'ref', at: day(at), id });

/** Each entry as a short word, to compare orders. */
const names = (items: TimelineItem[]) =>
  items.map((x) => {
    if (x.kind === 'comment') return x.comment.id;
    if (x.kind === 'review') return x.review.id;
    if (x.kind === 'thread') return `thread:${x.root.id}`;
    if (x.kind === 'commits') return `commits:${x.commits.map((c) => c.oid).join('+')}`;
    return x.event.kind === 'commit' ? `commit:${x.event.oid}` : x.event.kind;
  });

test("GitHub's order beats the clock: a commit made earlier but listed after a comment stays after it", () => {
  const items = timelineItems({
    comments: [comment('c1', '10:00')],
    reviews: [],
    reviewComments: [],
    events: [commit('a', '09:00'), ref('c1', '10:00'), commit('b', '09:50'), { kind: 'state', at: day('11:00'), actor: 'ann', what: 'merged' }],
  });
  assert.deepEqual(names(items), ['commit:a', 'c1', 'commit:b', 'state']);
});

test('a ref is replaced by the comment or the review of that id, and one that names nothing is left out', () => {
  const items = timelineItems({
    comments: [comment('c1', '10:00')],
    reviews: [review('r1', '10:05')],
    reviewComments: [],
    events: [ref('r1', '10:05'), ref('gone', '10:06'), ref('c1', '10:00')],
  });
  assert.deepEqual(names(items), ['r1', 'c1']);
  assert.equal(items[0].kind, 'review');
  assert.equal(items[1].kind, 'comment');
});

test('what the order does not name goes in by time, before the first entry that happened later', () => {
  const items = timelineItems({
    // c9 has no ref (a history that was cut): it is placed like the threads.
    comments: [comment('c1', '10:00'), comment('c9', '10:30')],
    reviews: [review('r1', '10:10')],
    // 10 and 11 start threads, 12 answers 10 and so is no entry of its own.
    reviewComments: [line(10, '10:10'), line(11, '09:00'), line(12, '10:20', 10), line(13, '12:00')],
    events: [commit('a', '09:30'), ref('c1', '10:00'), ref('r1', '10:10'), commit('b', '10:40'), { kind: 'state', at: day('11:00'), actor: 'ann', what: 'merged' }],
  });
  // Thread 11 is older than everything; thread 10 was made with its review and follows it; thread 13 is after all.
  assert.deepEqual(names(items), ['thread:11', 'commit:a', 'c1', 'r1', 'thread:10', 'c9', 'commit:b', 'state', 'thread:13']);
});

test('a later entry that is out of the clock\'s order does not pull an unnamed one past the first later entry', () => {
  const items = timelineItems({
    comments: [],
    reviews: [],
    reviewComments: [line(10, '09:55')],
    events: [commit('a', '09:00'), ref('none', '10:00'), commit('late', '10:00'), commit('early', '09:50')],
  });
  assert.deepEqual(names(items), ['commit:a', 'thread:10', 'commit:late', 'commit:early']);
});

test('a thread follows the review it came with, not the time its comments were drafted', () => {
  // Drafted at 10:00, published with the review after a commit at 10:30.
  const items = timelineItems({
    comments: [],
    reviews: [review('r1', '10:40')],
    reviewComments: [line(10, '10:00'), line(11, '10:01')],
    threads: [
      { id: 'T10', rootId: 10, resolved: false, review: 'r1', at: day('10:40') },
      { id: 'T11', rootId: 11, resolved: false, review: 'r1', at: day('10:40') },
    ],
    events: [commit('a', '09:00'), commit('b', '10:30'), ref('r1', '10:40'), commit('c', '11:00')],
  });
  assert.deepEqual(names(items), ['commit:a', 'commit:b', 'r1', 'thread:10', 'thread:11', 'commit:c']);
});

test('threads of an empty review stay at its place although the review has no card', () => {
  const items = timelineItems({
    comments: [],
    reviews: [],
    reviewComments: [line(10, '10:00')],
    threads: [{ id: 'T10', rootId: 10, resolved: false, review: 'r1', at: day('10:40') }],
    events: [commit('a', '09:00'), commit('b', '10:30'), ref('r1', '10:40'), commit('c', '11:00')],
  });
  assert.deepEqual(names(items), ['commit:a', 'commit:b', 'thread:10', 'commit:c']);
});

test('a thread whose review is not in the order goes by when it was published, then by its first comment', () => {
  const items = timelineItems({
    comments: [],
    reviews: [],
    reviewComments: [line(10, '10:00'), line(11, '10:50')],
    threads: [{ id: 'T10', rootId: 10, resolved: false, review: 'other', at: day('10:40') }],
    events: [commit('a', '09:00'), commit('b', '10:30'), commit('c', '11:00')],
  });
  assert.deepEqual(names(items), ['commit:a', 'commit:b', 'thread:10', 'thread:11', 'commit:c']);
});

test('without events everything is listed by when it was written, as before', () => {
  const items = timelineItems({ comments: [comment('c2', '11:00'), comment('c1', '09:00')], reviews: [review('r1', '10:00')], reviewComments: [line(10, '09:30'), line(12, '09:40', 10)] });
  assert.deepEqual(names(items), ['c1', 'thread:10', 'r1', 'c2']);
});

test('an empty history still lists the comments', () => {
  const items = timelineItems({ comments: [comment('c1', '09:00')], reviews: [], reviewComments: [line(10, '08:00')], events: [] });
  assert.deepEqual(names(items), ['thread:10', 'c1']);
});

test('commits that follow one another fold into one entry, and anything between them starts a new one', () => {
  const items = groupCommits(
    timelineItems({
      comments: [comment('c1', '10:00')],
      reviews: [],
      reviewComments: [],
      events: [commit('a', '09:00'), commit('b', '09:10'), ref('c1', '10:00'), commit('c', '10:30'), { kind: 'force-push', at: day('10:40'), actor: 'ann' }, commit('d', '10:50'), commit('e', '10:55')],
    }),
  );
  assert.deepEqual(names(items), ['commits:a+b', 'c1', 'commits:c', 'force-push', 'commits:d+e']);
  assert.equal(items[0].at, day('09:00'));
});

test('unresolved threads are counted only when GitHub said how the threads stand', () => {
  assert.equal(unresolvedCount({}), undefined);
  assert.equal(unresolvedCount({ threads: [] }), 0);
  const threads = [
    { id: 'T1', rootId: 10, resolved: false },
    { id: 'T2', rootId: 11, resolved: true, resolvedBy: 'ann' },
    { id: 'T3', rootId: 12, resolved: false },
  ];
  assert.equal(unresolvedCount({ threads }), 2);
  assert.equal(threadByRoot(threads).get(11)?.id, 'T2');
  assert.equal(threadByRoot(undefined).size, 0);
});

test('each event is told in plain words', () => {
  const at = day('10:00');
  const said: [Exclude<GhTimelineEvent, { kind: 'ref' }>, string][] = [
    [{ kind: 'force-push', at, actor: 'ann' }, 'force-pushed the branch'],
    [{ kind: 'force-push', at, actor: 'ann', before: 'abc1234', after: 'def5678' }, 'force-pushed the branch from abc1234 to def5678'],
    [{ kind: 'state', at, actor: 'ann', what: 'merged' }, 'merged this'],
    [{ kind: 'state', at, actor: 'ann', what: 'closed' }, 'closed this'],
    [{ kind: 'state', at, actor: 'ann', what: 'reopened' }, 'reopened this'],
    [{ kind: 'state', at, actor: 'ann', what: 'ready' }, 'marked this ready for review'],
    [{ kind: 'state', at, actor: 'ann', what: 'draft' }, 'marked this as a draft'],
    [{ kind: 'review-request', at, actor: 'ann', reviewer: 'bob' }, 'requested a review from @bob'],
    [{ kind: 'review-request', at, actor: 'ann', reviewer: 'bob', removed: true }, 'removed the review request for @bob'],
    [{ kind: 'review-request', at, actor: 'ann', reviewer: 'ann' }, 'self-requested a review'],
    [{ kind: 'label', at, actor: 'ann', label: 'bug' }, 'added the label bug'],
    [{ kind: 'label', at, actor: 'ann', label: 'bug', removed: true }, 'removed the label bug'],
    [{ kind: 'assign', at, actor: 'ann', assignee: 'bob' }, 'assigned @bob'],
    [{ kind: 'assign', at, actor: 'ann', assignee: 'bob', removed: true }, 'unassigned @bob'],
    [{ kind: 'assign', at, actor: 'ann', assignee: 'ann' }, 'self-assigned this'],
    [{ kind: 'rename', at, actor: 'ann', from: 'Old', to: 'New' }, 'changed the title from “Old” to “New”'],
    [{ kind: 'base', at, actor: 'ann', from: 'main', to: 'release' }, 'changed the base branch from main to release'],
    [{ kind: 'branch', at, actor: 'ann', what: 'deleted', name: 'gh-438/x' }, 'deleted the gh-438/x branch'],
    [{ kind: 'branch', at, actor: 'ann', what: 'deleted' }, 'deleted the branch'],
    [{ kind: 'branch', at, actor: 'ann', what: 'restored' }, 'restored the branch'],
    [{ kind: 'commit', at, oid: 'abc', headline: 'Fix it', author: 'ann', url: 'https://example.test/abc' }, 'added the commit Fix it'],
  ];
  for (const [e, words] of said) assert.equal(eventText(e), words);
});

test('resolving and reopening a thread keeps it under its review, where a comment drafted before a commit would otherwise jump', () => {
  // Drafted at 10:00, published with its review after the 10:30 commit.
  const d = {
    comments: [],
    reviews: [review('r1', '10:00')],
    reviewComments: [line(10, '10:00')],
    events: [commit('a', '10:30'), ref('r1', '10:00')],
    threads: [{ id: 'T10', rootId: 10, resolved: false, resolvedBy: 'ann', review: 'r1', at: day('10:40') }],
  };
  const order = ['commit:a', 'r1', 'thread:10'];
  assert.deepEqual(names(timelineItems(d)), order);
  takeThreadChange(d, { thread: 'T10', resolved: true });
  assert.deepEqual(d.threads, [{ id: 'T10', rootId: 10, resolved: true, review: 'r1', at: day('10:40') }]);
  assert.deepEqual(names(timelineItems(d)), order);
  takeThreadChange(d, { thread: 'T10', resolved: false });
  assert.deepEqual(names(timelineItems(d)), order);
  // A reply joins its thread and moves nothing.
  takeThreadChange(d, { reply: line(11, '12:00', 10) });
  assert.deepEqual(names(timelineItems(d)), order);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreads, parseTimeline, readHistory, resolveMutation, resolvedOf, reviewCommentOf, threadIsOf, THREAD_OWNER_QUERY, type GhRun } from '../src/server/github-history.js';

const actor = { login: 'ann' };

test('parseTimeline reads every kind of event', () => {
  const events = parseTimeline([
    { __typename: 'IssueComment', id: 'IC_1', createdAt: '2026-01-01T00:00:00Z' },
    { __typename: 'PullRequestReview', id: 'PRR_1', createdAt: '2026-01-01T00:01:00Z' },
    { __typename: 'PullRequestCommit', commit: { oid: 'abc', messageHeadline: 'Fix it', committedDate: '2026-01-01T00:02:00Z', url: 'https://x/c/abc', author: { name: 'Ann A', user: { login: 'ann' } } } },
    { __typename: 'PullRequestCommit', commit: { oid: 'def', messageHeadline: 'More', committedDate: '2026-01-01T00:03:00Z', url: 'https://x/c/def', author: { name: 'No Account', user: null } } },
    { __typename: 'HeadRefForcePushedEvent', createdAt: 'T4', actor, beforeCommit: { oid: '1234567890' }, afterCommit: { oid: 'abcdefabcdef' } },
    { __typename: 'HeadRefForcePushedEvent', createdAt: 'T5', actor, beforeCommit: null, afterCommit: null },
    { __typename: 'ReopenedEvent', createdAt: 'T6', actor },
    { __typename: 'ReadyForReviewEvent', createdAt: 'T7', actor },
    { __typename: 'ConvertToDraftEvent', createdAt: 'T8', actor },
    { __typename: 'ClosedEvent', createdAt: 'T9', actor },
    { __typename: 'ReviewRequestedEvent', createdAt: 'T10', actor, requestedReviewer: { __typename: 'User', login: 'bob' } },
    { __typename: 'ReviewRequestedEvent', createdAt: 'T11', actor, requestedReviewer: { __typename: 'Team', name: 'core' } },
    { __typename: 'ReviewRequestRemovedEvent', createdAt: 'T12', actor, requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
    { __typename: 'LabeledEvent', createdAt: 'T13', actor, label: { name: 'bug' } },
    { __typename: 'UnlabeledEvent', createdAt: 'T14', actor, label: { name: 'bug' } },
    { __typename: 'AssignedEvent', createdAt: 'T15', actor, assignee: { __typename: 'User', login: 'cy' } },
    { __typename: 'UnassignedEvent', createdAt: 'T16', actor, assignee: { __typename: 'User', login: 'cy' } },
    { __typename: 'RenamedTitleEvent', createdAt: 'T17', actor, previousTitle: 'old', currentTitle: 'new' },
    { __typename: 'BaseRefChangedEvent', createdAt: 'T18', actor, previousRefName: 'main', currentRefName: 'dev' },
    { __typename: 'HeadRefDeletedEvent', createdAt: 'T19', actor, headRefName: 'gh-438/x' },
    { __typename: 'HeadRefDeletedEvent', createdAt: 'T20', actor, headRefName: null },
    { __typename: 'HeadRefRestoredEvent', createdAt: 'T21', actor },
  ]);
  assert.deepEqual(events, [
    { kind: 'ref', at: '2026-01-01T00:00:00Z', id: 'IC_1' },
    { kind: 'ref', at: '2026-01-01T00:01:00Z', id: 'PRR_1' },
    { kind: 'commit', at: '2026-01-01T00:02:00Z', oid: 'abc', headline: 'Fix it', author: 'ann', url: 'https://x/c/abc' },
    { kind: 'commit', at: '2026-01-01T00:03:00Z', oid: 'def', headline: 'More', author: 'No Account', url: 'https://x/c/def' },
    { kind: 'force-push', at: 'T4', actor: 'ann', before: '1234567', after: 'abcdefa' },
    { kind: 'force-push', at: 'T5', actor: 'ann' },
    { kind: 'state', at: 'T6', actor: 'ann', what: 'reopened' },
    { kind: 'state', at: 'T7', actor: 'ann', what: 'ready' },
    { kind: 'state', at: 'T8', actor: 'ann', what: 'draft' },
    { kind: 'state', at: 'T9', actor: 'ann', what: 'closed' },
    { kind: 'review-request', at: 'T10', actor: 'ann', reviewer: 'bob' },
    { kind: 'review-request', at: 'T11', actor: 'ann', reviewer: 'core' },
    { kind: 'review-request', at: 'T12', actor: 'ann', reviewer: 'copilot', removed: true },
    { kind: 'label', at: 'T13', actor: 'ann', label: 'bug' },
    { kind: 'label', at: 'T14', actor: 'ann', label: 'bug', removed: true },
    { kind: 'assign', at: 'T15', actor: 'ann', assignee: 'cy' },
    { kind: 'assign', at: 'T16', actor: 'ann', assignee: 'cy', removed: true },
    { kind: 'rename', at: 'T17', actor: 'ann', from: 'old', to: 'new' },
    { kind: 'base', at: 'T18', actor: 'ann', from: 'main', to: 'dev' },
    { kind: 'branch', at: 'T19', actor: 'ann', what: 'deleted', name: 'gh-438/x' },
    { kind: 'branch', at: 'T20', actor: 'ann', what: 'deleted' },
    { kind: 'branch', at: 'T21', actor: 'ann', what: 'restored' },
  ]);
});

test('parseTimeline skips unknown and empty nodes and names a deleted user ghost', () => {
  const events = parseTimeline([null, 7, {}, { __typename: 'SomethingNew', createdAt: 'T' }, { __typename: 'IssueComment' }, { __typename: 'PullRequestCommit', commit: null }, { __typename: 'LabeledEvent', createdAt: 'T', actor: null, label: null }, { __typename: 'ReopenedEvent', createdAt: 'T', actor: null }]);
  assert.deepEqual(events, [{ kind: 'state', at: 'T', actor: 'ghost', what: 'reopened' }]);
  assert.deepEqual(parseTimeline(undefined), []);
});

test('a merged pull request shows the merge and not the close that comes with it', () => {
  const nodes = [
    { __typename: 'ClosedEvent', createdAt: 'T1', actor },
    { __typename: 'MergedEvent', createdAt: 'T1', actor },
  ];
  assert.deepEqual(parseTimeline(nodes), [{ kind: 'state', at: 'T1', actor: 'ann', what: 'merged' }]);
  assert.equal(parseTimeline(nodes.slice(0, 1)).length, 1, 'a close without a merge stays');
});

test('only the close that belongs to the merge is dropped: a close and reopen before it stay', () => {
  const closed = (at: string) => ({ __typename: 'ClosedEvent', createdAt: at, actor });
  const nodes = [closed('T1'), { __typename: 'ReopenedEvent', createdAt: 'T2', actor }, { __typename: 'MergedEvent', createdAt: 'T3', actor }, closed('T3')];
  assert.deepEqual(parseTimeline(nodes).map((e) => (e as { what: string }).what), ['closed', 'reopened', 'merged']);
  assert.equal((parseTimeline(nodes)[0] as { at: string }).at, 'T1');
  // The times differ by a second: the close right next to the merge goes.
  const near = [closed('T1'), { __typename: 'ReopenedEvent', createdAt: 'T2', actor }, closed('T4'), { __typename: 'MergedEvent', createdAt: 'T3', actor }];
  assert.deepEqual(parseTimeline(near).map((e) => (e as { what: string }).what), ['closed', 'reopened', 'merged']);
  assert.equal((parseTimeline(near)[0] as { at: string }).at, 'T1');
});

test('parseThreads reads the threads and skips ones without a first comment', () => {
  const threads = parseThreads([
    { id: 'PRRT_a', isResolved: false, resolvedBy: null, comments: { nodes: [{ databaseId: 11, publishedAt: '2026-01-01T10:00:00Z', pullRequestReview: { id: 'PRR_1' } }] } },
    { id: 'PRRT_b', isResolved: true, resolvedBy: { login: 'bob' }, comments: { nodes: [{ databaseId: 12 }] } },
    { id: 'PRRT_c', isResolved: true, resolvedBy: null, comments: { nodes: [{ databaseId: 13 }] } },
    { id: 'PRRT_d', isResolved: false, comments: { nodes: [] } },
    null,
    { isResolved: false, comments: { nodes: [{ databaseId: 14 }] } },
  ]);
  assert.deepEqual(threads, [
    { id: 'PRRT_a', rootId: 11, resolved: false, review: 'PRR_1', at: '2026-01-01T10:00:00Z' },
    { id: 'PRRT_b', rootId: 12, resolved: true, resolvedBy: 'bob' },
    { id: 'PRRT_c', rootId: 13, resolved: true },
  ]);
});

test('resolveMutation names the mutation for resolving and for reopening', () => {
  assert.match(resolveMutation(true), /resolveReviewThread\(input:\{threadId:\$id\}\)\{thread\{id isResolved\}\}/);
  assert.match(resolveMutation(false), /unresolveReviewThread\(input:\{threadId:\$id\}\)/);
  assert.equal(resolvedOf('{"data":{"resolveReviewThread":{"thread":{"id":"x","isResolved":true}}}}'), true);
  assert.equal(resolvedOf('{"data":{"unresolveReviewThread":{"thread":{"id":"x","isResolved":false}}}}'), false);
  assert.equal(resolvedOf('{"data":{}}'), undefined);
});

test('a thread is only of the pull request and repository the owner query names', () => {
  assert.match(THREAD_OWNER_QUERY, /PullRequestReviewThread\{pullRequest\{number repository\{nameWithOwner\}\}\}/);
  const out = (number: number, repo: string) => JSON.stringify({ data: { node: { pullRequest: { number, repository: { nameWithOwner: repo } } } } });
  assert.equal(threadIsOf(out(7, 'devellaoy/3d-kanban'), 7, 'devellaoy/3d-kanban'), true);
  assert.equal(threadIsOf(out(7, 'DevellaOy/3d-Kanban'), 7, 'devellaoy/3d-kanban'), true);
  assert.equal(threadIsOf(out(8, 'devellaoy/3d-kanban'), 7, 'devellaoy/3d-kanban'), false);
  assert.equal(threadIsOf(out(7, 'devellaoy/other'), 7, 'devellaoy/3d-kanban'), false);
  assert.equal(threadIsOf('{"data":{"node":{}}}', 7, 'devellaoy/3d-kanban'), false);
  assert.equal(threadIsOf('{"data":{"node":null}}', 7, 'devellaoy/3d-kanban'), false);
});

test('reviewCommentOf maps a line comment', () => {
  assert.deepEqual(reviewCommentOf({ id: 5, in_reply_to_id: 4, path: 'a.ts', line: null, side: 'LEFT', body: 'hi', user: null, created_at: 'T', html_url: 'u' }), { id: 5, replyTo: 4, author: 'ghost', body: 'hi', createdAt: 'T', url: 'u', path: 'a.ts', line: null, side: 'LEFT' });
});

/** A gh runner answering GraphQL pages from the newest: `timeline` and `threads` are lists of pages (arrays of nodes), the first answering the first call. */
function fakeGh(timeline: unknown[][], threads: unknown[][]) {
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    const field = query.includes('timelineItems') ? 'timelineItems' : 'reviewThreads';
    const pages = field === 'timelineItems' ? timeline : threads;
    const before = args.find((a) => a.startsWith('before='))?.slice(7);
    const i = before ? Number(before.slice(field.length + 1)) : 0;
    const more = i + 1 < pages.length;
    return JSON.stringify({ data: { repository: { pullRequest: { [field]: { nodes: pages[i], pageInfo: { hasPreviousPage: more, startCursor: more ? `${field}-${i + 1}` : null } } } } } });
  };
  return { run, calls };
}
const commit = (oid: string) => ({ __typename: 'PullRequestCommit', commit: { oid, messageHeadline: oid, committedDate: 'T', url: 'u', author: { name: 'a', user: { login: 'a' } } } });
const thread = (id: string, root: number) => ({ id, isResolved: false, comments: { nodes: [{ databaseId: root }] } });

test('readHistory pages each list backwards with its own cursor, puts the pages in order and sends the number as an Int', async () => {
  const { run, calls } = fakeGh([[commit('c'), commit('d')], [commit('a'), commit('b')]], [[thread('T3', 3)], [thread('T2', 2)], [thread('T1', 1)]]);
  const h = await readHistory(run, 'devellaoy/3d-kanban', 161, '/tmp');
  assert.ok(!('error' in h));
  assert.deepEqual(h.events.map((e) => (e as { oid: string }).oid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(h.threads.map((t) => t.id), ['T1', 'T2', 'T3']);
  assert.equal(h.cut, false);
  assert.equal(calls.length, 5);
  for (const args of calls) {
    assert.equal(args[args.indexOf('number=161') - 1], '-F', 'the number goes as -F (an Int)');
    assert.ok(args.includes('owner=devellaoy') && args.includes('name=3d-kanban'));
  }
  const befores = calls.map((a) => a.find((x) => x.startsWith('before='))).filter(Boolean);
  assert.deepEqual(befores.sort(), ['before=reviewThreads-1', 'before=reviewThreads-2', 'before=timelineItems-1']);
});

test('readHistory stops after 5 pages of events and 3 of threads, keeps the newest and says it cut', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => [commit(`c${n - i}`)]);
  const { run, calls } = fakeGh(many(9), [[thread('T', 1)]]);
  const h = await readHistory(run, 'o/r', 1, '/tmp');
  assert.ok(!('error' in h));
  assert.deepEqual(h.events.map((e) => (e as { oid: string }).oid), ['c5', 'c6', 'c7', 'c8', 'c9']);
  assert.equal(h.cut, true);
  assert.equal(calls.filter((a) => a.some((x) => x.includes('timelineItems'))).length, 5);
  const t = fakeGh([[]], Array.from({ length: 6 }, (_, i) => [thread(`T${i}`, i + 1)]));
  const h2 = await readHistory(t.run, 'o/r', 1, '/tmp');
  assert.ok(!('error' in h2));
  assert.deepEqual(h2.threads.map((x) => x.id), ['T2', 'T1', 'T0']);
  assert.equal(h2.cut, true);
});

test('readHistory answers with the error when gh fails, sends nothing back, or is too slow', async () => {
  assert.deepEqual(await readHistory(async () => Promise.reject(new Error('rate limited')), 'o/r', 1, '/tmp'), { error: 'rate limited' });
  assert.ok('error' in (await readHistory(async () => 'not json', 'o/r', 1, '/tmp')));
  assert.ok('error' in (await readHistory(async () => '{"data":{"repository":{"pullRequest":null}}}', 'o/r', 1, '/tmp')));
  assert.ok('error' in (await readHistory(async () => '{}', 'nowhere', 1, '/tmp')));
  const started = Date.now();
  const slow = await readHistory(() => new Promise<string>(() => {}), 'o/r', 1, '/tmp', 50);
  assert.deepEqual(slow, { error: 'GitHub took too long to answer' });
  assert.ok(Date.now() - started < 2000);
});

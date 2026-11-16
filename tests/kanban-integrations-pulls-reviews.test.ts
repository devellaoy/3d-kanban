import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { parseReviews, reviewQuery } from '../src/server/kanban/integrations/pulls/reviews.js';
import { openKanbanDb } from '../src/server/kanban/db/open.js';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../src/server/kanban/db/migrations.js';
import { KanbanRepository } from '../src/server/kanban/db/repository.js';
import type { GhPull } from '../src/shared/protocol.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const AZ = 'azure:contoso/Web/api';

function project(remote = 'o/web') {
  const dir = path.join(makeCtx().tmp, 'web');
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  const ctx = makeCtx([def('web', dir, { repos: [{ id: 'web', name: 'web', kind: 'git', dir, remote, primary: true }] })]);
  const taskIds: number[] = [];
  ctx.taskChanged = (id: number) => void taskIds.push(id);
  const mk = () => ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't' });
  return { ctx, mk, taskIds };
}
const link = (ctx: ReturnType<typeof makeCtx>, taskId: number, n: number, state: 'OPEN' | 'DRAFT' | 'MERGED' = 'OPEN', repo = 'o/web') =>
  ctx.repo.upsertPrLink(taskId, { repoId: 'web', repo, number: n, url: `https://github.com/${repo}/pull/${n}`, state });
const pull = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/web/pull/${n}`, state: 'OPEN', isDraft: false, repo: 'o/web', ...over }) as GhPull;
const answer = (byNumber: Record<number, { decision?: string; threads?: boolean[] } | null>) =>
  JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(byNumber).map(([n, v]) => [`p${n}`, v && { reviewDecision: v.decision ?? null, latestOpinionatedReviews: { nodes: [] }, reviewThreads: { nodes: (v.threads ?? []).map((isResolved) => ({ isResolved })) } }])) } });

test('reviewQuery lets only positive integers into the query; parseReviews reads the answer', () => {
  const q = reviewQuery([12, 3.9, -1, 0, NaN, '7); drop' as unknown as number, 5]);
  assert.match(q, /p12: pullRequest\(number:12\)/);
  assert.match(q, /p3: pullRequest\(number:3\)/);
  assert.equal((q.match(/pullRequest\(/g) ?? []).length, 3, '12, 3 and 5 only');
  assert.doesNotMatch(q, /drop/);
  const got = parseReviews(JSON.stringify({ data: { repository: {
    p1: { reviewDecision: '', latestOpinionatedReviews: { nodes: [{ state: 'APPROVED' }] }, reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } },
    p2: null,
  } } }));
  assert.deepEqual([...got], [[1, { review: 'APPROVED', unresolved: 2 }]]);
  assert.equal(parseReviews('not json').size, 0);
});

test('marks from a GraphQL answer are stored and announced once; the same answer again changes nothing', async () => {
  const { ctx, mk, taskIds } = project();
  const t = mk();
  link(ctx, t.id, 4);
  const calls: string[][] = [];
  let now = 1_000_000;
  const parts = createPullsParts(ctx, { now: () => now, gh: async (args) => (calls.push(args), answer({ 4: { decision: 'CHANGES_REQUESTED', threads: [false, true, false] } })) });
  assert.deepEqual(await parts.syncPrStates('web', [pull(4)]), [], 'the marks come after the sync, not in its answer');
  await parts.reviewsSettled();
  assert.deepEqual(ctx.repo.listPrLinks(t.id).map((l) => [l.review, l.unresolved]), [['CHANGES_REQUESTED', 2]]);
  assert.equal(ctx.repo.listPrLinks(t.id)[0].updatedAt, ctx.repo.listPrLinks(t.id)[0].createdAt, 'updated_at is untouched');
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql']);
  assert.ok(calls[0].includes('owner=o') && calls[0].includes('name=web'));
  assert.equal(taskIds.filter((i) => i === t.id).length, 1, 'broadcast once');
  now += 60_000;
  await parts.syncPrStates('web', [pull(4)]);
  await parts.reviewsSettled();
  assert.equal(taskIds.filter((i) => i === t.id).length, 1);
});

test('gh failing entirely keeps the earlier marks and does not throw', async () => {
  const { ctx, mk } = project();
  const t = mk();
  link(ctx, t.id, 4);
  ctx.repo.setPrLinkMarks(t.id, 'web', 4, { review: 'APPROVED', unresolved: 1 });
  const errors: unknown[][] = [];
  const old = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('network down')) });
    await parts.syncPrStates('web', [pull(4)]);
    await parts.reviewsSettled();
    await parts.syncPrStates('web', [pull(4)]);
    await parts.reviewsSettled();
  } finally {
    console.error = old;
  }
  assert.deepEqual(ctx.repo.listPrLinks(t.id).map((l) => [l.review, l.unresolved]), [['APPROVED', 1]]);
  assert.equal(errors.length, 1, 'said once per failure streak');
});

test('a failed chunk is asked one PR at a time: the others are stored, a vanished one is cleared', async () => {
  const { ctx, mk } = project();
  const t = mk();
  for (const n of [1, 2, 3]) link(ctx, t.id, n);
  ctx.repo.setPrLinkMarks(t.id, 'web', 2, { review: 'APPROVED', unresolved: 4 });
  const queries: string[] = [];
  const parts = createPullsParts(ctx, {
    gh: async (args) => {
      const q = args.find((a) => a.startsWith('query='))!;
      queries.push(q);
      if ((q.match(/pullRequest\(/g) ?? []).length > 1) throw new Error('GraphQL: Could not resolve to a PullRequest with the number of 2.');
      if (q.includes('number:2')) throw new Error('GraphQL: Could not resolve to a PullRequest with the number of 2. (NOT_FOUND)');
      return answer({ [q.includes('number:1') ? 1 : 3]: { decision: 'REVIEW_REQUIRED', threads: [false] } });
    },
  });
  await parts.syncPrStates('web', [pull(1), pull(2), pull(3)]);
  await parts.reviewsSettled();
  assert.equal(queries.length, 4, 'one for the chunk, one per PR');
  const marks = Object.fromEntries(ctx.repo.listPrLinks(t.id).map((l) => [l.number, [l.review, l.unresolved]]));
  assert.deepEqual(marks, { 1: ['REVIEW_REQUIRED', 1], 2: [undefined, undefined], 3: ['REVIEW_REQUIRED', 1] });
});

test('only open and draft PRs matched by repository and number are asked about; more than 20 make more than one query', async () => {
  const { ctx, mk } = project();
  const t = mk();
  link(ctx, t.id, 1, 'MERGED');
  link(ctx, t.id, 2, 'DRAFT');
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', number: 3, url: 'https://github.com/o/web/pull/3', state: 'OPEN' });
  const asked: string[] = [];
  const parts = createPullsParts(ctx, { gh: async (args) => (asked.push(args.find((a) => a.startsWith('query='))!), '{"data":{"repository":{}}}') });
  // #1 merged; #2 draft; #3 open but the board's #3 is another repository's, matched by URL only.
  await parts.syncPrStates('web', [pull(1, { state: 'MERGED' }), pull(2, { isDraft: true }), pull(3, { repo: 'other/lib', url: 'https://github.com/o/web/pull/3' })]);
  await parts.reviewsSettled();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /number:2\)/);
  assert.doesNotMatch(asked[0], /number:1\)|number:3\)/);

  const big = project();
  const bt = big.mk();
  for (let n = 1; n <= 45; n++) link(big.ctx, bt.id, n, 'OPEN', 'O/Web');
  const bigAsked: string[][] = [];
  const bigParts = createPullsParts(big.ctx, { gh: async (args) => (bigAsked.push(args), '{"data":{"repository":{}}}') });
  await bigParts.syncPrStates('web', Array.from({ length: 45 }, (_, i) => pull(i + 1, { repo: 'O/Web' })));
  await bigParts.reviewsSettled();
  assert.equal(bigAsked.length, 3, '20 + 20 + 5');
  assert.ok(bigAsked.every((a) => a.includes('owner=O') && a.includes('name=Web')), "the board pull's owner and name");
});

test('a hosted repository: the review comes from the board, no GraphQL', async () => {
  const { ctx, mk, taskIds } = project(AZ);
  const t = mk();
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', repo: AZ, number: 5, url: 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/5', state: 'OPEN' });
  const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('gh is not for Azure DevOps')) });
  const board = [{ number: 5, url: 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/5', state: 'OPEN', isDraft: false, repo: AZ, reviewDecision: 'APPROVED' }] as GhPull[];
  assert.deepEqual(await parts.syncPrStates('web', board), [t.id]);
  assert.deepEqual(ctx.repo.listPrLinks(t.id).map((l) => [l.review, l.unresolved]), [['APPROVED', undefined]]);
  assert.deepEqual(await parts.syncPrStates('web', board), []);
  assert.equal(taskIds.filter((i) => i === t.id).length, 1);
});

test('migration 9: a version 8 database keeps its links with unknown marks; setPrLinkMarks round-trips', () => {
  assert.equal(SCHEMA_VERSION, 9);
  const db = openKanbanDb(':memory:');
  const repo = new KanbanRepository(db);
  const t = repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't' });
  repo.upsertPrLink(t.id, { repoId: 'web', repo: 'o/web', number: 1, url: 'https://github.com/o/web/pull/1', state: 'OPEN', at: 1000 });
  db.exec('ALTER TABLE pr_links DROP COLUMN review; ALTER TABLE pr_links DROP COLUMN unresolved; PRAGMA user_version = 8;');
  assert.deepEqual(migrate(db, MIGRATIONS), [9]);
  const [l] = repo.listPrLinks(t.id);
  assert.equal(l.review, undefined);
  assert.equal(l.unresolved, undefined);
  assert.ok(!('review' in l) && !('unresolved' in l));
  assert.equal(repo.setPrLinkMarks(t.id, 'web', 1, { review: 'APPROVED', unresolved: 2 }), true);
  assert.equal(repo.setPrLinkMarks(t.id, 'web', 1, { review: 'APPROVED', unresolved: 2 }), false, 'a no-op');
  const [m] = repo.listPrLinks(t.id);
  assert.deepEqual([m.review, m.unresolved, m.updatedAt], ['APPROVED', 2, 1000]);
  assert.equal(repo.setPrLinkMarks(t.id, 'web', 1, {}), true);
  assert.deepEqual([repo.listPrLinks(t.id)[0].review, repo.listPrLinks(t.id)[0].unresolved], [undefined, undefined]);
  assert.equal(repo.upsertPrLink(t.id, { repoId: 'web', repo: 'o/web', number: 1, url: 'https://github.com/o/web/pull/1', state: 'OPEN' }).length, 1);
  db.close();
});

// Two projects, each with its own repository, as one office has them.
function two() {
  const base = makeCtx().tmp;
  const mkd = (n: string) => { const d = path.join(base, n); mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
  const a = mkd('a');
  const b = mkd('b');
  const ctx = makeCtx([
    def('a', a, { repos: [{ id: 'a', name: 'a', kind: 'git', dir: a, remote: 'o/a', primary: true }] }),
    def('b', b, { repos: [{ id: 'b', name: 'b', kind: 'git', dir: b, remote: 'o/b', primary: true }] }),
  ]);
  const mk = (project: string) => ctx.repo.createTask({ project, title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't' });
  return { ctx, mk };
}
const one = (n: number) => answer({ [n]: { decision: 'APPROVED', threads: [false] } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('two floors pulled at the same moment both get their marks', async () => {
  const { ctx, mk } = two();
  const ta = mk('a');
  const tb = mk('b');
  ctx.repo.upsertPrLink(ta.id, { repoId: 'a', repo: 'o/a', number: 1, url: 'https://github.com/o/a/pull/1', state: 'OPEN' });
  ctx.repo.upsertPrLink(tb.id, { repoId: 'b', repo: 'o/b', number: 2, url: 'https://github.com/o/b/pull/2', state: 'OPEN' });
  const parts = createPullsParts(ctx, { gh: async (args) => { await sleep(50); return one(args.includes('name=a') ? 1 : 2); } });
  await Promise.all([parts.syncPrStates('a', [pull(1, { repo: 'o/a' })]), parts.syncPrStates('b', [pull(2, { repo: 'o/b' })])]);
  await parts.reviewsSettled();
  assert.equal(ctx.repo.listPrLinks(ta.id)[0].review, 'APPROVED');
  assert.equal(ctx.repo.listPrLinks(tb.id)[0].review, 'APPROVED');
});

test('the same repository is asked once for the same PRs within 30 s, again for others or later; another set waits its turn in the same repository', async () => {
  const { ctx, mk } = project();
  const t = mk();
  for (const n of [1, 2]) link(ctx, t.id, n);
  let now = 1_000_000;
  let asked = 0;
  const parts = createPullsParts(ctx, { now: () => now, gh: async () => (asked++, await sleep(20), '{"data":{"repository":{}}}') });
  await Promise.all([parts.syncPrStates('web', [pull(1)]), parts.syncPrStates('web', [pull(1)])]);
  await parts.reviewsSettled();
  assert.equal(asked, 1, 'the same PRs already being asked about are not asked twice');
  await parts.syncPrStates('web', [pull(1)]);
  await parts.reviewsSettled();
  assert.equal(asked, 1, 'same PRs, asked a moment ago');
  await parts.syncPrStates('web', [pull(1), pull(2)]);
  await parts.reviewsSettled();
  assert.equal(asked, 2, 'another set of PRs');
  now += 31_000;
  await parts.syncPrStates('web', [pull(1), pull(2)]);
  await parts.reviewsSettled();
  assert.equal(asked, 3, 'later');
  now += 31_000;
  await Promise.all([parts.syncPrStates('web', [pull(1)]), parts.syncPrStates('web', [pull(1), pull(2)])]);
  await parts.reviewsSettled();
  assert.equal(asked, 5, 'two sets at the same moment (two projects in one repository) are both asked, one after the other');
});

test('a merged state reaches the cards without waiting for a slow gh', async () => {
  const { ctx, mk } = two();
  const ta = mk('a');
  ctx.repo.upsertPrLink(ta.id, { repoId: 'a', repo: 'o/a', number: 1, url: 'https://github.com/o/a/pull/1', state: 'OPEN' });
  ctx.repo.upsertPrLink(ta.id, { repoId: 'a', repo: 'o/a', number: 3, url: 'https://github.com/o/a/pull/3', state: 'OPEN' });
  const parts = createPullsParts(ctx, { gh: async () => { await sleep(300); throw new Error('timed out'); } });
  const old = console.error;
  console.error = () => {};
  try {
    const got = await parts.syncPrStates('a', [pull(1, { repo: 'o/a' }), pull(3, { repo: 'o/a', state: 'MERGED' })]);
    assert.deepEqual(got, [ta.id]);
    assert.ok(ctx.changed.includes(ta.id), 'announced before gh answered');
    await parts.reviewsSettled();
  } finally {
    console.error = old;
  }
  assert.equal(ctx.repo.listPrLinks(ta.id).find((l) => l.number === 3)!.state, 'MERGED');
});

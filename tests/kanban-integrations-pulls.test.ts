import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MergeWatch } from '../src/server/github.js';
import { branchPrs, findBundle, mentionsTicket, prState, ticketToken, type RepoPulls } from '../src/server/kanban/integrations/pulls/bundle.js';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { floorPulled } from '../src/server/kanban/integrations/pulls/board.js';
import { PR_REVIEW_MAX } from '../src/shared/kanban/types.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';
import type { Floor } from '../src/server/floor.js';
import type { GhPull, MeetingRequest } from '../src/shared/protocol.js';
import { WHO, client, def, makeCtx } from './kanban-integrations-ctx.js';

const pr = (number: number, headRefName: string, title = `PR ${number}`, state = 'OPEN', isDraft = false) => ({ number, title, url: `https://github.com/x/y/pull/${number}`, state, isDraft, headRefName });
const LISTS: RepoPulls[] = [
  { repo: 'o/web', repoId: 'web', pulls: [pr(10, 'feat/UYT-1415-login', 'UYT-1415: login'), pr(11, 'fix/other'), pr(12, 'feat/UYT-14150', 'unrelated UYT-14150')] },
  { repo: 'o/api', repoId: 'api', pulls: [pr(10, 'feat/UYT-1415-login', 'Login API', 'MERGED'), pr(3, 'office/bolt-1a2b', 'Refactor', 'OPEN', true)] },
];

test('a bundle: the same branch, or the same ticket, across the repositories', () => {
  assert.deepEqual(findBundle(LISTS, { branch: 'feat/UYT-1415-login' }).map((p) => `${p.repo}#${p.number}:${p.state}`), ['o/api#10:MERGED', 'o/web#10:OPEN']);
  assert.deepEqual(findBundle(LISTS, { ticket: 'UYT-1415' }).map((p) => `${p.repo}#${p.number}`), ['o/api#10', 'o/web#10'], 'UYT-14150 is another ticket');
  assert.equal(mentionsTicket('fix UYT-1415.', 'uyt-1415'), true);
  assert.equal(mentionsTicket('xUYT-1415', 'UYT-1415'), false, 'a word of its own');
  assert.equal(mentionsTicket('feat/uyt-1415-login', 'UYT-1415'), true);
  assert.equal(mentionsTicket('UYT-14150', 'UYT-1415'), false);
  assert.equal(ticketToken('gh:o/web#12'), undefined, "a GitHub issue's number is too common to match by");
  assert.equal(prState({ state: 'OPEN', isDraft: true }), 'DRAFT');
});

test("a task's bundle: its linked PRs, its branches in any repository, its ticket", () => {
  const task = {
    id: 7,
    branch: 'office/bolt-1a2b',
    ticket: 'UYT-1415',
    branches: {},
    prs: [{ repoId: 'web', repo: 'o/web', number: 11, url: 'https://github.com/o/web/pull/11', state: 'OPEN' as const, createdAt: 0, updatedAt: 0 }, { repoId: 'lib', repo: 'o/lib', number: 2, url: 'https://github.com/o/lib/pull/2', state: 'MERGED' as const, createdAt: 0, updatedAt: 0 }],
  };
  const got = findBundle(LISTS, { taskId: 7 }, task, (repo, n) => (repo === 'o/web' && n === 11 ? 7 : undefined));
  assert.deepEqual(got.map((p) => `${p.repo}#${p.number}`), ['o/api#3', 'o/api#10', 'o/lib#2', 'o/web#10', 'o/web#11']);
  assert.equal(got.find((p) => p.repo === 'o/web' && p.number === 11)?.taskId, 7);
  assert.equal(got.find((p) => p.repo === 'o/lib')?.title, 'PR #2', 'a linked PR no list has is still there');
  assert.deepEqual(findBundle(LISTS, { taskId: 7 }), [], 'no such task: nothing');
});

test('MergeWatch keys by repository and number: two repositories’ #10 are two PRs', () => {
  const w = new MergeWatch();
  const p = (number: number, state: string, repo?: string) => ({ number, state, ...(repo ? { repo } : {}) }) as GhPull;
  w.look([p(10, 'OPEN'), p(10, 'OPEN', 'o/api')]);
  assert.deepEqual(w.look([p(10, 'OPEN'), p(10, 'MERGED', 'o/api')]).map((x) => x.repo), ['o/api']);
  assert.equal(w.ring(10), true, "the floor's own #10 hasn't rung");
  assert.equal(w.ring(10, 'o/api'), true);
  assert.equal(w.ring(10, 'O/API'), false, 'the repository in any case');
});

/** gh for a repository's PRs: none of them from a fork, or none asked. */
const notFork = async (args: string[]) => (args[0] === 'repo' ? 'main\n' : '{"isCrossRepository":false}');
/** A PR created after the tasks of a test were. */
const LATER = new Date(Date.now() + 60_000).toISOString();
const noGh = async () => Promise.reject(new Error('gh not needed'));

function project() {
  const base = path.join(makeCtx().tmp, 'repos');
  const web = path.join(base, 'web');
  const api = path.join(base, 'api');
  for (const d of [web, api]) mkdirSync(path.join(d, '.git'), { recursive: true });
  const ctx = makeCtx([def('web', web, { repo: 'o/web', repos: [{ id: 'web', name: 'web', kind: 'git', dir: web, remote: 'o/web', primary: true }, { id: 'api', name: 'api', kind: 'git', dir: api, remote: 'o/api', primary: false }] })]);
  return { ctx, web, api };
}

test('a review of several PRs: each must be one of the project’s repositories’, and there', async () => {
  const { ctx } = project();
  const ghCalls: string[][] = [];
  const parts = createPullsParts(ctx, {
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(args[3] === 'o/web' ? LISTS[0].pulls : LISTS[1].pulls);
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '77') return JSON.stringify(pr(77, 'late'));
      throw new Error('no such PR');
    },
  });
  assert.match(String(await parts.checkReview({ project: 'web', prs: [{ repo: 'o/other', number: 1 }] })), /o\/other isn't one of the project's repositories \(o\/web, o\/api\)/);
  assert.match(String(await parts.checkReview({ project: 'web', prs: [{ repo: 'o/api', number: 404 }] })), /o\/api has no pull request #404/);
  assert.match(String(await parts.checkReview({ project: 'nope', prs: [{ repo: 'o/api', number: 1 }] })), /no project nope/);
  assert.match(String(await parts.checkReview({ project: 'web', prs: [{ repo: 'o/web', number: 10 }], taskId: 99 })), /no task #99/);
  const ok = await parts.checkReview({ project: 'web', prs: [{ repo: 'O/Web', number: 10 }, { repo: 'o/api', number: 77 }] });
  assert.ok(typeof ok === 'object');
  assert.deepEqual(ok.prs.map((p) => `${p.repo}#${p.number}:${p.title}`), ['o/web#10:UYT-1415: login', 'o/api#77:PR 77'], 'the repository as the project names it; one not in the list asked of gh');
});

test('a review of several PRs is checked here and run by the engine; the answer names its task and reviewer', async () => {
  const { ctx } = project();
  const asked: { req: unknown; who: string }[] = [];
  ctx.engine = { ...ctx.engine, reviewPrs: async (req: unknown, who: { name: string }) => (asked.push({ req, who: who.name }), { taskId: 42, workerId: 'w9' }) } as typeof ctx.engine;
  const floor = { githubFor: (repo?: string) => ({ pulls: { items: (repo === 'o/api' ? LISTS[1] : LISTS[0]).pulls, fetchedAt: 1, loading: false } }) } as unknown as Floor;
  ctx.floors.set('web', floor);
  const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('gh not needed')) });
  const t = ctx.repo.createTask({ project: 'web', title: 'Login', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
  const c = client();
  await parts.plugin.ws!['kanban.pr.review']!(c, { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'O/Web', number: 10 }, { repo: 'o/api', number: 10 }], taskId: t.id, tool: 'codex', rid: 'r' });
  assert.deepEqual(c.got.at(-1), { t: 'kanban.ok', rid: 'r', taskId: 42, workerId: 'w9' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].who, 'Tester');
  assert.deepEqual(asked[0].req, {
    project: 'web',
    prs: [
      { repo: 'o/web', number: 10, title: 'UYT-1415: login', url: 'https://github.com/x/y/pull/10', branch: 'feat/UYT-1415-login' },
      { repo: 'o/api', number: 10, title: 'Login API', url: 'https://github.com/x/y/pull/10', branch: 'feat/UYT-1415-login' },
    ],
    taskId: t.id,
    tool: 'codex',
  }, 'the PRs as the project names them, with what their lists say');
  // Refused before the engine hears of it: a stranger's repository, a PR twice, too many, the engine's own no.
  await parts.plugin.ws!['kanban.pr.review']!(c, { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'o/other', number: 1 }], rid: 'x' });
  assert.match((c.got.at(-1) as { message: string }).message, /o\/other isn't one of the project's repositories/);
  assert.match(String(await parts.api.review({ project: 'web', prs: [{ repo: 'o/web', number: 10 }, { repo: 'O/WEB', number: 10 }] }, WHO)), /o\/web#10 is picked twice/);
  const many = Array.from({ length: PR_REVIEW_MAX + 1 }, (_, i) => ({ repo: 'o/web', number: i + 1 }));
  assert.match(String(await parts.api.review({ project: 'web', prs: many }, WHO)), new RegExp(`at most ${PR_REVIEW_MAX}`));
  assert.equal(asked.length, 1, 'none of those reached the engine');
  ctx.engine = { ...ctx.engine, reviewPrs: async () => 'No desk is free' } as typeof ctx.engine;
  await parts.plugin.ws!['kanban.pr.review']!(c, { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'o/web', number: 10 }], rid: 'y' });
  assert.deepEqual(c.got.at(-1), { t: 'kanban.error', rid: 'y', message: 'No desk is free' });
  // The bundle over WS, from the floor's lists: open ones only, unless asked for all.
  await parts.plugin.ws!['kanban.pr.bundle']!(c, { t: 'kanban.pr.bundle', project: 'web', branch: 'feat/UYT-1415-login', rid: 'b' });
  const b = c.got.at(-1) as { t: string; prs: { repo: string; repoId?: string }[]; key: unknown };
  assert.equal(b.t, 'kanban.pr.bundle');
  assert.deepEqual(b.key, { branch: 'feat/UYT-1415-login' });
  assert.deepEqual(b.prs.map((p) => `${p.repo}:${p.repoId}`), ['o/web:web'], 'o/api#10 is merged');
  await parts.plugin.ws!['kanban.pr.bundle']!(c, { t: 'kanban.pr.bundle', project: 'web', branch: 'feat/UYT-1415-login', includeClosed: true, rid: 'b2' });
  assert.deepEqual((c.got.at(-1) as { prs: { repo: string }[] }).prs.map((p) => p.repo), ['o/api', 'o/web']);
  const api = await parts.api.bundle('web', { ticket: 'UYT-1415' });
  assert.equal(Array.isArray(api) && api.length, 1);
  const all = await parts.api.bundle('web', { ticket: 'UYT-1415' }, { includeClosed: true });
  assert.equal(Array.isArray(all) && all.length, 2);
});

test('🤝 a panel of several PRs: upstream’s review panel on the one in the floor’s own repository, briefed with all of them', async () => {
  const { ctx } = project();
  const started: { req: MeetingRequest; by: string; owner?: string }[] = [];
  let busy: string | undefined;
  const floor = {
    githubFor: (repo?: string) => ({ pulls: { items: (repo === 'o/api' ? LISTS[1] : LISTS[0]).pulls, fetchedAt: 1, loading: false } }),
    project: { agentProviders: ['claude'] },
    meetings: { start: (req: MeetingRequest, by: string, owner?: string) => (busy ? busy : void started.push({ req, by, owner })) },
  } as unknown as Floor;
  ctx.floors.set('web', floor);
  ctx.engine = { ...ctx.engine, reviewPrs: async () => assert.fail('a panel is not the engine’s') } as typeof ctx.engine;
  const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('gh not needed')) });
  const t = ctx.repo.createTask({ project: 'web', title: 'Login', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't', ticket: 'UYT-1415' });
  const c = client();
  await parts.plugin.ws!['kanban.pr.review']!(c, { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'o/api', number: 3 }, { repo: 'o/web', number: 10 }], taskId: t.id, panel: true, rid: 'p' });
  assert.deepEqual(c.got.at(-1), { t: 'kanban.ok', rid: 'p', taskId: t.id });
  assert.equal(started.length, 1);
  const { req, by } = started[0];
  assert.equal(by, 'Tester');
  assert.equal(req.pattern, 'review');
  assert.equal(req.pr, 10, "the floor's own repository's PR: its review is posted there");
  assert.equal(req.title, 'Review of o/api#3, o/web#10');
  assert.match(req.prompt, /- o\/api#3 “Refactor” \(branch office\/bolt-1a2b\) https:\/\/github\.com\/x\/y\/pull\/3/);
  assert.match(req.prompt, /- o\/web#10 “UYT-1415: login”/);
  assert.match(req.prompt, /#10 of o\/web\) is only where the combined review is posted: review every one of them/);
  assert.match(req.prompt, new RegExp(`kanban task #${t.id}'s: Login \\(UYT-1415\\)`));
  assert.match(ctx.repo.listComments(t.id).comments.at(-1)!.text, /called a 🤝 review panel on o\/api#3, o\/web#10/);
  // Only other repositories' PRs: there's nowhere for upstream's panel to post, so no.
  await parts.plugin.ws!['kanban.pr.review']!(c, { t: 'kanban.pr.review', project: 'web', prs: [{ repo: 'o/api', number: 3 }, { repo: 'o/api', number: 10 }], panel: true, rid: 'q' });
  assert.match((c.got.at(-1) as { message: string }).message, /posts its review on a pull request of the project's own repository \(o\/web\): pick one there too, or use 🔍 Review/);
  // The meeting room's own no, and a tool the office doesn't have.
  busy = 'The meeting room is busy';
  assert.equal(await parts.api.panel!({ project: 'web', prs: [{ repo: 'o/web', number: 10 }] }, WHO), 'The meeting room is busy');
  assert.match(String(await parts.api.panel!({ project: 'web', prs: [{ repo: 'o/web', number: 10 }], tool: 'codex' }, WHO)), /codex isn't set up/);
  ctx.floors.delete('web');
  assert.match(String(await parts.api.panel!({ project: 'web', prs: [{ repo: 'o/web', number: 10 }] }, WHO)), /floor isn't open/);
});

test("a task's linked PRs take the board's states when its floor's PRs come back", async () => {
  const { ctx } = project();
  const changed: number[] = [];
  ctx.taskChanged = (id: number) => void changed.push(id);
  const mk = (title: string) => ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
  const a = mk('A');
  const b = mk('B');
  ctx.repo.upsertPrLink(a.id, { repoId: 'web', number: 10, url: 'https://github.com/o/web/pull/10', state: 'OPEN' });
  ctx.repo.upsertPrLink(a.id, { repoId: 'api', repo: 'o/api', number: 10, url: 'https://github.com/o/api/pull/10', state: 'OPEN' });
  ctx.repo.upsertPrLink(b.id, { repoId: 'api', repo: 'o/api', number: 3, url: 'https://github.com/o/api/pull/3', state: 'DRAFT' });
  assert.deepEqual(ctx.repo.prLinksOfProject('web').map((l) => `${l.taskId}:${l.repoId}#${l.number}:${l.state}`), [`${a.id}:api#10:OPEN`, `${a.id}:web#10:OPEN`, `${b.id}:api#3:DRAFT`]);
  assert.deepEqual(ctx.repo.prLinksOfProject('nope'), []);
  assert.equal(ctx.repo.setPrLinkState(b.id, 'api', 3, 'DRAFT'), false, 'the same state is no change');
  const plugin = createPullsParts(ctx, { gh: noGh }).plugin;
  plugin.start!();
  try {
    // As Floor.pullsState has them: the floor's own marked with its repository, the others with theirs.
    const items = [
      { number: 10, title: 'Web', url: 'https://github.com/o/web/pull/10', state: 'MERGED', isDraft: false, repo: 'o/web' },
      { number: 10, title: 'Api', url: 'https://github.com/o/api/pull/10', state: 'OPEN', isDraft: false, repo: 'O/Api' },
      { number: 3, title: 'Api', url: 'https://github.com/o/api/pull/3', state: 'OPEN', isDraft: false, repo: 'o/api' },
    ] as GhPull[];
    floorPulled({ id: 'web', pullsState: () => ({ items, fetchedAt: 1, loading: false }) });
    await new Promise((r) => setImmediate(r));
  } finally {
    plugin.stop!();
  }
  // Sorted: links come in the order they were made, and both may or may not share a millisecond.
  assert.deepEqual(ctx.repo.listPrLinks(a.id).map((l) => `${l.repoId}#${l.number}:${l.state}`).sort(), ['api#10:OPEN', 'web#10:MERGED'], 'matched by repository and number: o/web#10 merged, o/api#10 is still open');
  assert.deepEqual(ctx.repo.listPrLinks(b.id).map((l) => l.state), ['OPEN'], 'a draft made ready');
  assert.deepEqual(changed.sort(), [a.id, b.id].sort());
  // Without a repository on the link or the list: the URL still matches; and nothing is heard after stop.
  const parts = createPullsParts(ctx, { gh: noGh });
  assert.deepEqual(await parts.syncPrStates('web', [{ number: 3, url: 'https://github.com/o/api/pull/3', state: 'CLOSED', isDraft: false }]), [b.id]);
  changed.length = 0;
  floorPulled({ id: 'web', pullsState: () => ({ items: [{ number: 3, url: 'https://github.com/o/api/pull/3', state: 'OPEN', isDraft: false, repo: 'o/api' } as GhPull], fetchedAt: 1, loading: false }) });
  assert.deepEqual(changed, [], 'the plugin stopped listening');
});

test("a PR from a task's branch is linked to it when the floor's PRs come back: any repository, not closed, not shared, not taken", async () => {
  const { ctx } = project();
  const changed: number[] = [];
  ctx.taskChanged = (id: number) => void changed.push(id);
  const mk = (title: string, branch?: string) => {
    const t = ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    if (branch) ctx.repo.updateTask(t.id, { branch });
    return t;
  };
  const a = mk('A', 'kanban/a');
  ctx.repo.setRepoBranch(a.id, 'api', 'kanban/a');
  const s1 = mk('S1', 'kanban/shared');
  const s2 = mk('S2', 'kanban/shared');
  const other = mk('Other', 'kanban/other');
  ctx.repo.upsertPrLink(other.id, { repoId: 'web', repo: 'o/web', number: 20, url: 'https://github.com/o/web/pull/20', state: 'OPEN' });
  const gone = mk('Gone', 'kanban/gone');
  ctx.repo.updateTask(gone.id, { status: 'archived' });
  const pull = (n: number, branch: string, repo: string, state = 'OPEN') => ({ number: n, title: `PR ${n}`, url: `https://github.com/${repo}/pull/${n}`, state, isDraft: false, headRefName: branch, repo, createdAt: LATER }) as GhPull;
  const parts = createPullsParts(ctx, { gh: notFork });
  const got = await parts.syncPrStates('web', [
    pull(10, 'kanban/a', 'o/web'),
    pull(4, 'kanban/a', 'O/Api'),
    pull(11, 'kanban/x', 'o/web'),
    pull(12, 'kanban/a', 'o/web', 'CLOSED'),
    pull(13, 'kanban/shared', 'o/web'),
    pull(20, 'kanban/a', 'o/web'),
    pull(14, 'kanban/gone', 'o/web'),
  ]);
  assert.deepEqual(got, [a.id]);
  assert.deepEqual(changed, [a.id]);
  assert.deepEqual(ctx.repo.listPrLinks(a.id).map((l) => `${l.repoId}#${l.number}:${l.state}:${l.branch}`).sort(), ['api#4:OPEN:kanban/a', 'web#10:OPEN:kanban/a']);
  assert.equal(ctx.repo.listPrLinks(s1.id).length + ctx.repo.listPrLinks(s2.id).length, 0, 'a branch two tasks share is nobody’s');
  assert.deepEqual(ctx.repo.listPrLinks(other.id).map((l) => l.number), [20], 'a PR another task has stays with it');
  assert.equal(ctx.repo.listPrLinks(gone.id).length, 0, 'an archived task is left alone');
  assert.deepEqual(await parts.syncPrStates('web', [pull(10, 'kanban/a', 'o/web')]), [], 'nothing new, nothing changed');
});

test('branch linking: a done task does not own its branch, integration branches link to nothing', async () => {
  const { ctx } = project();
  const mk = (title: string, branch: string, status?: 'done') => {
    const t = ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    ctx.repo.updateTask(t.id, { branch, ...(status ? { status } : {}) });
    return t;
  };
  const old = mk('Old', 'kanban/re', 'done');
  const fresh = mk('Fresh', 'kanban/re');
  const dev = mk('Dev', 'kanban/dev-task');
  ctx.repo.setRepoBranch(dev.id, 'api', 'develop');
  const pull = (n: number, head: string, base: string, repo: string) => ({ number: n, title: `PR ${n}`, url: `https://github.com/${repo}/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: head, baseRefName: base, repo, createdAt: LATER }) as GhPull;
  const parts = createPullsParts(ctx, { gh: notFork });
  await parts.syncPrStates('web', [pull(1, 'kanban/re', 'main', 'o/web'), pull(2, 'develop', 'main', 'o/api'), pull(3, 'kanban/dev-task', 'develop', 'o/api'), pull(4, 'main', 'main', 'o/web')]);
  assert.deepEqual(ctx.repo.listPrLinks(fresh.id).map((l) => l.number), [1], 'the done task with the same branch name does not block it');
  assert.equal(ctx.repo.listPrLinks(old.id).length, 0, 'and gets nothing');
  assert.equal(ctx.repo.listPrLinks(dev.id).length, 0, 'develop→main is a release, not the task’s; main is nobody’s');
});

test('branch linking: stacked PRs each link to their own task', async () => {
  const { ctx } = project();
  const mk = (title: string, branch: string) => {
    const t = ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    ctx.repo.updateTask(t.id, { branch });
    return t;
  };
  const a = mk('A', 'office/a');
  const b = mk('B', 'office/b');
  const pull = (n: number, head: string, base: string) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/web/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: head, baseRefName: base, repo: 'o/web', createdAt: LATER }) as GhPull;
  await createPullsParts(ctx, { gh: notFork }).syncPrStates('web', [pull(1, 'office/a', 'main'), pull(2, 'office/b', 'office/a')]);
  assert.deepEqual(ctx.repo.listPrLinks(a.id).map((l) => l.number), [1], 'A is the base of B, and still A’s');
  assert.deepEqual(ctx.repo.listPrLinks(b.id).map((l) => l.number), [2]);
});

test('branch linking: a PR linked without its repository is still that task’s', async () => {
  const { ctx } = project();
  const mk = (title: string, branch: string) => {
    const t = ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    ctx.repo.updateTask(t.id, { branch });
    return t;
  };
  const a = mk('A', 'office/a');
  const b = mk('B', 'office/b');
  // A's links have no repository: #7 resolves through its repoId, #8's repoId is no repository of the project any more.
  ctx.repo.upsertPrLink(a.id, { repoId: 'web', number: 7, url: 'https://github.com/o/web/pull/7', state: 'OPEN' });
  ctx.repo.upsertPrLink(a.id, { repoId: 'gone', number: 8, url: 'https://github.com/o/web/pull/8', state: 'OPEN' });
  const pull = (n: number, head: string, url = `https://github.com/o/web/pull/${n}`) => ({ number: n, title: `PR ${n}`, url, state: 'OPEN', isDraft: false, headRefName: head, baseRefName: 'main', repo: 'o/web', createdAt: LATER }) as GhPull;
  // #7 matched by repoId and number, #8 by its URL alone.
  await createPullsParts(ctx, { gh: notFork }).syncPrStates('web', [pull(7, 'office/b'), pull(8, 'office/b')]);
  assert.deepEqual(ctx.repo.listPrLinks(b.id), [], 'not linked to B as well');
  assert.deepEqual(ctx.repo.listPrLinks(a.id).map((l) => l.number).sort(), [7, 8]);
});

test('branch linking: a fork’s PR with the task’s branch name is not linked, and gh is asked about it once', async () => {
  const { ctx } = project();
  const a = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
  ctx.repo.updateTask(a.id, { branch: 'office/a' });
  const asked: string[] = [];
  const parts = createPullsParts(ctx, { gh: async (args) => (asked.push(args.slice(0, 3).join(' ')), args[0] === 'repo' ? 'main' : `{"isCrossRepository":${args[2] === '5'}}`) });
  const pull = (n: number) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/web/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: 'office/a', repo: 'o/web', createdAt: LATER }) as GhPull;
  assert.deepEqual(await parts.syncPrStates('web', [pull(5)]), []);
  assert.deepEqual(await parts.syncPrStates('web', [pull(5)]), []);
  assert.deepEqual(asked.filter((x) => x.startsWith('pr view')), ['pr view 5'], 'a fork stays a fork: asked once');
  assert.deepEqual(await parts.syncPrStates('web', [pull(6)]), [a.id]);
});

test('branch linking: a PR another project’s task has, linked by repoId only, is not taken', async () => {
  const { ctx } = project();
  const mk = (project: string, title: string) => ctx.repo.createTask({ project, title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
  const mine = mk('web', 'Mine');
  ctx.repo.updateTask(mine.id, { branch: 'office/a' });
  const theirs = mk('web2', 'Theirs');
  // Another project over the same repository: its link has only a repoId, which its own repositories resolve to o/web.
  const repos = ctx.repos;
  ctx.repos = (id: string) => (id === 'web2' ? [{ id: 'w2', name: 'w2', kind: 'git', dir: '/x', remote: 'o/web', primary: true }] : repos(id));
  ctx.repo.upsertPrLink(theirs.id, { repoId: 'w2', number: 7, url: 'https://github.com/o/web/pull/7?x', state: 'OPEN' });
  await createPullsParts(ctx, { gh: notFork }).syncPrStates('web', [{ number: 7, title: 'PR', url: 'https://github.com/o/web/pull/7', state: 'OPEN', isDraft: false, headRefName: 'office/a', repo: 'o/web', createdAt: LATER } as GhPull]);
  assert.deepEqual(ctx.repo.listPrLinks(mine.id), [], 'the other project’s task has #7');
});

test('branchPrs: by repository and branch, the primary repository falls back to the task’s own branch, open PRs created after the task', () => {
  const repos = [{ id: 'web', kind: 'git' as const, remote: 'o/web', primary: true }, { id: 'api', kind: 'git' as const, remote: 'o/api', primary: false }];
  const p = (number: number, headRefName: string | undefined, repo?: string, state = 'OPEN', createdAt = LATER) => ({ number, url: `u${number}`, state, isDraft: false, headRefName, createdAt, ...(repo ? { repo } : {}) });
  const tasks = [{ id: 1, project: 'web', createdAt: Date.now(), branch: 'b1', branches: { api: 'b1-api' } }];
  const got = branchPrs('web', () => tasks, [p(1, 'b1'), p(2, 'b1', 'o/api'), p(3, 'b1-api', 'O/API'), p(4, undefined), p(5, 'b1', 'o/web', 'MERGED'), p(6, 'b1', 'o/lib'), p(7, 'b1', 'o/web', 'OPEN', '2001-01-01T00:00:00Z'), p(8, 'b1', 'o/web', 'OPEN', 'soon')], () => repos, 'o/web', () => false);
  assert.deepEqual(got.map((g) => `${g.taskId}:${g.repoId}#${g.pull.number}`), ['1:web#1', '1:api#3'], 'merged, older than the task or undated: no');
  assert.deepEqual(branchPrs('web', () => tasks, [p(1, 'b1')], () => repos, 'o/web', () => true), []);
  assert.deepEqual(branchPrs('other', () => tasks, [p(1, 'b1')], () => repos, 'o/web', () => false), [], 'a task of another project');
  assert.deepEqual(branchPrs('web', () => assert.fail('no head to look up'), [p(1, 'main'), p(2, undefined)], () => repos, 'o/web', () => false), [], 'the tasks are not even read');
});

test('branch linking: a PR needs gh to say it is no fork’s, and the head is not the default branch; each link is an event', async () => {
  const { ctx } = project();
  const mk = (title: string, branch: string) => {
    const t = ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    ctx.repo.updateTask(t.id, { branch });
    return t;
  };
  const a = mk('A', 'office/a');
  const b = mk('B', 'trunky');
  const asked: string[] = [];
  let now = 1_000_000;
  let fail = true;
  const parts = createPullsParts(ctx, {
    now: () => now,
    gh: async (args) => {
      asked.push(args.slice(0, 3).join(' '));
      if (fail) throw new Error('gh failed');
      return args[0] === 'repo' ? 'trunky\n' : '{"isCrossRepository":false}';
    },
  });
  const pull = (n: number, head: string) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/web/pull/${n}`, state: 'OPEN', isDraft: false, headRefName: head, repo: 'o/web', createdAt: LATER }) as GhPull;
  assert.deepEqual(await parts.syncPrStates('web', [pull(1, 'office/a')]), [], 'gh failed: no link');
  const before = asked.length;
  await parts.syncPrStates('web', [pull(1, 'office/a')]);
  assert.equal(asked.length, before, 'not asked again within five minutes');
  now += 5 * 60_000;
  fail = false;
  assert.deepEqual(await parts.syncPrStates('web', [pull(1, 'office/a'), pull(2, 'trunky')]), [a.id], 'the default branch (trunky here) is nobody’s');
  assert.equal(ctx.repo.listPrLinks(b.id).length, 0);
  assert.deepEqual(ctx.repo.listEvents(a.id).filter((e) => e.kind === 'pr.linked').map((e) => e.data), [{ repo: 'o/web', number: 1, by: 'branch' }]);
});

test('branch linking: one in-flight gh question per PR, and nothing is written once the plugin stopped', async () => {
  const { ctx } = project();
  const t = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
  ctx.repo.updateTask(t.id, { branch: 'office/a' });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const parts = createPullsParts(ctx, { gh: async (args) => (calls++, await gate, args[0] === 'repo' ? 'main' : '{"isCrossRepository":false}') });
  const pull = { number: 1, title: 'PR', url: 'https://github.com/o/web/pull/1', state: 'OPEN', isDraft: false, headRefName: 'office/a', repo: 'o/web', createdAt: LATER } as GhPull;
  parts.plugin.start!();
  const one = parts.syncPrStates('web', [pull]);
  const two = parts.syncPrStates('web', [pull]);
  parts.plugin.stop!();
  release();
  await Promise.all([one, two]);
  assert.equal(calls, 2, 'fork and default branch, once each');
  assert.deepEqual(ctx.repo.listPrLinks(t.id), [], 'stopped meanwhile: nothing written');
});

test('branch linking: two projects with an active task on the same repository and branch own it jointly, so nobody', async () => {
  const { ctx } = project();
  const repos = ctx.repos;
  ctx.repos = (id: string) => (id === 'web2' ? [{ id: 'w2', name: 'w2', kind: 'git', dir: '/x', remote: 'o/web', primary: true }] : repos(id));
  const mk = (project: string) => {
    const t = ctx.repo.createTask({ project, title: project, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't' });
    ctx.repo.updateTask(t.id, { branch: 'office/same' });
    return t;
  };
  const a = mk('web');
  const b = mk('web2');
  const pull = { number: 1, title: 'PR', url: 'https://github.com/o/web/pull/1', state: 'OPEN', isDraft: false, headRefName: 'office/same', repo: 'o/web', createdAt: LATER } as GhPull;
  await createPullsParts(ctx, { gh: notFork }).syncPrStates('web', [pull]);
  assert.deepEqual([ctx.repo.listPrLinks(a.id), ctx.repo.listPrLinks(b.id)], [[], []]);
});

test('kanban.pr.review takes panel, kanban.pr.bundle takes includeClosed: true or false, nothing else', () => {
  const prs = [{ repo: 'o/web', number: 10 }];
  assert.deepEqual(parseKanbanClientMsg({ t: 'kanban.pr.review', project: 'web', prs, panel: true }), { t: 'kanban.pr.review', project: 'web', prs, panel: true });
  assert.deepEqual(parseKanbanClientMsg({ t: 'kanban.pr.review', project: 'web', prs, panel: false }), { t: 'kanban.pr.review', project: 'web', prs });
  assert.match(String(parseKanbanClientMsg({ t: 'kanban.pr.review', project: 'web', prs, panel: 'yes' })), /panel must be true or false/);
  assert.deepEqual(parseKanbanClientMsg({ t: 'kanban.pr.bundle', project: 'web', branch: 'b', includeClosed: true }), { t: 'kanban.pr.bundle', project: 'web', branch: 'b', includeClosed: true });
  assert.match(String(parseKanbanClientMsg({ t: 'kanban.pr.bundle', project: 'web', branch: 'b', includeClosed: 1 })), /includeClosed must be true or false/);
});

test('branchPrs: a PR the board says is from a fork is never linked by its branch name', () => {
  const repos = [{ id: 'web', kind: 'git' as const, remote: 'o/web', primary: true }];
  const tasks = [{ id: 1, project: 'web', createdAt: Date.now(), branch: 'b1', branches: {} }];
  const p = (number: number, isCrossRepository?: boolean) => ({ number, url: `u${number}`, state: 'OPEN', isDraft: false, headRefName: 'b1', createdAt: LATER, repo: 'o/web', ...(isCrossRepository === undefined ? {} : { isCrossRepository }) });
  const got = branchPrs('web', () => tasks, [p(1, true), p(2, false), p(3)], () => repos, 'o/web', () => false);
  assert.deepEqual(got.map((g) => g.pull.number), [2, 3], 'the fork is out; one the board has no word on is left to gh');
});

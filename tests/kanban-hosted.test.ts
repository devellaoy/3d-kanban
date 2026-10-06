// A project on Azure DevOps or Bitbucket in the kanban: the PR lines an agent reports, the floor's
// PR board from the provider, tasks following their PRs to merged, the work item completed on merge,
// the prompts' note on office-pr, and the git config's credential helper. GitHub's stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prLines } from '../src/server/kanban/engine/markers.js';
import { openBoard } from '../src/server/github.js';
import { openHosting, setHostFetch } from '../src/server/hosting/index.js';
import type { Fetch, HostAs } from '../src/server/hosting/provider.js';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { checkWorkItems, COMPLETED_EVENT, workItemMarks, WORK_ITEM_TRIES } from '../src/server/kanban/integrations/hosting/workitems.js';
import { Composer } from '../src/server/kanban/engine/compose.js';
import { gitConfigText } from '../src/server/gitconfig.js';
import { answer, parseRequest } from '../bin/office-git-credential.js';
import type { GhPull, GhState } from '../src/shared/protocol.js';
import { def, makeCtx } from './kanban-integrations-ctx.js';

const AZ = 'azure:contoso/Web/api';
const AZ_API = 'https://dev\\.azure\\.com/contoso/Web/_apis/git/repositories/api';
const AZ_PR = (n: number) => `https://dev.azure.com/contoso/Web/_git/api/pullrequest/${n}`;

/** A fetch answering from routes ("METHOD url" regexes), recording the calls. */
function stub(routes: [RegExp, () => unknown][]) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    const r = routes.find(([re]) => re.test(key));
    return r ? new Response(JSON.stringify(r[1]())) : new Response('{"message":"no route"}', { status: 404 });
  };
  return { fetch, calls };
}

/** The office's own Azure DevOps token, in a fresh data dir, for the providers to read with. */
function officeToken() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hosted-'));
  writeFileSync(path.join(dir, 'hosting-secrets.json'), JSON.stringify({ azure: { token: 'x'.repeat(52), who: 'Office' }, bitbucket: { token: 'y'.repeat(40), email: 'o@x.y' } }), { mode: 0o600 });
  openHosting(dir);
  return dir;
}

test('PR lines: Azure DevOps and Bitbucket URLs name their repository and number; GitHub’s as before', () => {
  const got = prLines(['PR: https://github.com/o/r/pull/12/files', 'PR: <https://dev.azure.com/contoso/Web/_git/api/pullrequest/7?_a=files>', 'PR: [x](https://bitbucket.org/acme/widget/pull-requests/3)', 'PR: https://example.com/pr/1'].join('\n'));
  assert.deepEqual(got, [
    { url: 'https://github.com/o/r/pull/12', repo: 'o/r', number: 12 },
    { url: AZ_PR(7), repo: AZ, number: 7 },
    { url: 'https://bitbucket.org/acme/widget/pull-requests/3', repo: 'bitbucket:acme/widget', number: 3 },
    { url: 'https://example.com/pr/1' },
  ]);
});

const azPr = (id: number, status: string, branch: string) => ({ pullRequestId: id, title: `PR ${id}`, status, isDraft: false, createdBy: { displayName: 'Jane' }, sourceRefName: `refs/heads/${branch}`, targetRefName: 'refs/heads/main', creationDate: '2026-10-01T00:00:00Z', reviewers: [], repository: { id: 'r1', project: { id: 'p1' } } });

test("the floor's PR board for a repository on Azure DevOps comes from its provider; GitHub-only actions say so", async () => {
  officeToken();
  const s = stub([
    [new RegExp(`GET ${AZ_API}/pullrequests\\?searchCriteria\\.status=active`), () => ({ value: [azPr(7, 'active', 'feat/x')] })],
    [new RegExp(`GET ${AZ_API}/pullrequests\\?searchCriteria\\.status=completed`), () => ({ value: [azPr(5, 'completed', 'feat/y')] })],
    [new RegExp(`GET ${AZ_API}/pullrequests\\?searchCriteria\\.status=abandoned`), () => ({ value: [] })],
    [new RegExp(`GET ${AZ_API}/pullrequests/7/statuses`), () => ({ value: [] })],
  ]);
  const old = setHostFetch(s.fetch);
  try {
    const states: GhState<GhPull>[] = [];
    const issues: unknown[] = [];
    const board = openBoard(os.tmpdir(), (st) => issues.push(st), (st) => states.push(st), { nameWithOwner: AZ });
    assert.equal(board.hosted?.host, 'azure');
    await board.refresh();
    const last = states.at(-1)!;
    assert.equal(last.error, undefined);
    assert.equal(last.host, 'azure');
    assert.deepEqual(last.items.map((p) => `${p.repo}#${p.number}:${p.state}:${p.headRefName}:${p.url}`), [`${AZ}#7:OPEN:feat/x:${AZ_PR(7)}`, `${AZ}#5:MERGED:feat/y:${AZ_PR(5)}`]);
    assert.match(String((issues.at(-1) as GhState<unknown>).note), /Issue sources/);
    assert.match(String(await board.merge(7, 'squash', false, false)), /Merging isn't available from the office for Azure DevOps repositories/);
    assert.match(String((await board.setLabels('pull', 7, ['x'], [])).error), /Labels isn't available/);
    assert.deepEqual(await board.repoLabels(), []);
    assert.ok(!s.calls.some((c) => /github/.test(c)));
  } finally {
    setHostFetch(old);
  }
});

function azureProject() {
  const dir = path.join(makeCtx().tmp, 'api');
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  const ctx = makeCtx([def('web', dir, { repos: [{ id: 'web', name: 'api', kind: 'git', dir, remote: AZ, primary: true }] })]);
  return ctx;
}

test("a task's PR on Azure DevOps follows its state, and one from its branch is linked to it", async () => {
  officeToken();
  const ctx = azureProject();
  const t = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't' });
  ctx.repo.updateTask(t.id, { branch: 'feat/x' });
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', repo: AZ, number: 5, url: AZ_PR(5), state: 'OPEN' });
  const s = stub([
    // Asked by the lower-cased name the kanban keeps its answers by: Azure DevOps doesn't mind the case.
    [new RegExp(`GET ${AZ_API}/pullrequests/7\\?`, 'i'), () => azPr(7, 'active', 'feat/x')],
    [new RegExp(`GET ${AZ_API}\\?`, 'i'), () => ({ defaultBranch: 'refs/heads/main' })],
  ]);
  const old = setHostFetch(s.fetch);
  try {
    const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('gh is not for Azure DevOps')) });
    const later = new Date(Date.now() + 60_000).toISOString();
    const pulls = [
      { number: 5, url: AZ_PR(5), state: 'MERGED', isDraft: false, repo: AZ, headRefName: 'feat/old' },
      { number: 7, url: AZ_PR(7), state: 'OPEN', isDraft: false, repo: AZ, headRefName: 'feat/x', createdAt: later },
    ];
    assert.deepEqual(await parts.syncPrStates('web', pulls), [t.id]);
    assert.deepEqual(ctx.repo.listPrLinks(t.id).map((l) => `${l.number}:${l.state}`).sort(), ['5:MERGED', '7:OPEN']);
  } finally {
    setHostFetch(old);
  }
});

test("a task's work item: linked to its open PR once, completed once its PR merged", async () => {
  const ctx = azureProject();
  const t = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', ticket: 'ab:contoso/Web#42' });
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', repo: AZ, number: 7, url: AZ_PR(7), state: 'OPEN' });
  const linked: string[] = [];
  const completed: string[] = [];
  const as: HostAs = { kind: 'azure', auth: 'Basic x', key: 'office' };
  const deps = {
    creds: () => ({ as: () => as, anyAs: () => as }) as never,
    fetch: () => (async () => new Response('{}')) as Fetch,
    link: async (_repo: unknown, n: number, id: number) => (linked.push(`${n}->${id}`), true),
    complete: async (org: string, project: string, id: number) => (completed.push(`${org}/${project}#${id}`), 'Closed'),
  };
  const marks = workItemMarks();
  const open = [{ number: 7, url: AZ_PR(7), state: 'OPEN', repo: AZ }];
  await checkWorkItems(ctx, 'web', open, marks, deps);
  await checkWorkItems(ctx, 'web', open, marks, deps);
  assert.deepEqual(linked, ['7->42'], 'once');
  const merged = [{ number: 7, url: AZ_PR(7), state: 'MERGED', repo: AZ }];
  await checkWorkItems(ctx, 'web', merged, marks, deps);
  await checkWorkItems(ctx, 'web', merged, workItemMarks(), deps);
  assert.deepEqual(completed, ['contoso/Web#42'], 'once, even after a restart (the event remembers)');
  assert.ok(ctx.repo.listEvents(t.id).some((e) => e.kind === COMPLETED_EVENT));
  assert.ok(ctx.repo.listComments(t.id).comments.some((c) => /moved work item #42 to Closed/.test(c.text)));
  // A GitHub ticket, or a work item of another organization, is none of this.
  const other = ctx.repo.createTask({ project: 'web', title: 'B', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', ticket: 'ab:fabrikam/X#1' });
  ctx.repo.upsertPrLink(other.id, { repoId: 'web', repo: AZ, number: 8, url: AZ_PR(8), state: 'OPEN' });
  await checkWorkItems(ctx, 'web', [{ number: 8, url: AZ_PR(8), state: 'MERGED', repo: AZ }], marks, deps);
  assert.deepEqual(completed, ['contoso/Web#42']);
});

test("prompts: a note on office-pr only for repositories elsewhere, and the work item's AB# line", () => {
  const ctx = makeCtx();
  const c = new Composer(ctx);
  assert.equal(c.hostingNote('p', [{ name: 'web', remote: 'o/web' }, { name: 'docs' }]), '', "a GitHub project's prompts are as they were");
  const note = c.hostingNote('p', [{ name: 'web', remote: 'o/web' }, { name: 'api', remote: AZ }, { name: 'ui', remote: 'bitbucket:acme/ui' }]);
  assert.match(note, /^\n\nApi is on Azure DevOps, ui is on Bitbucket: gh doesn't work there\. For those, use office-pr/);
  assert.match(c.closesText('p', 'ab:contoso/Web#42', [AZ], AZ), /put `AB#42` in the description of the pull request in Web\/api/);
  assert.equal(c.closesText('p', 'ab:fabrikam/Web#42', [AZ], AZ), '', "a repository of another organization: AB#42 there would be its own #42");
  assert.match(c.closesText('p', 'ab:contoso/Web#42', [AZ, 'azure:fabrikam/Web/ui'], AZ), /in Web\/api, so it is linked/);
  assert.equal(c.closesText('p', 'ab:contoso/Web#42', ['o/web'], 'o/web'), '', 'no repository on Azure DevOps: nothing to link it from');
  assert.match(c.closesText('p', 'gh:o/web#3', ['o/web'], 'o/web'), /Closes #3/);
});

test("an account's git config: GitHub's credentials as before, the office's helper for Azure DevOps and Bitbucket", () => {
  const text = gitConfigText({ includes: ['/h/.gitconfig'], gh: "/bin/g'h", hosting: { helper: '/d/bin/office-git-credential', files: ['/d/homes/a/hosting.json', '/d/hosting-secrets.json'] }, user: { name: 'Jane', email: 'j@x' } });
  assert.match(text, /\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = "!'\/bin\/g'\\\\''h' auth git-credential"/);
  assert.match(text, /\[credential "https:\/\/dev\.azure\.com"\]\n\thelper =\n\thelper = "!'\/d\/bin\/office-git-credential' '\/d\/homes\/a\/hosting\.json' '\/d\/hosting-secrets\.json'"/);
  assert.match(text, /\[credential "https:\/\/bitbucket\.org"\]/);
  assert.ok(!gitConfigText({ includes: [] }).includes('credential'));
  const files: Record<string, string> = { mine: JSON.stringify({ bitbucket: { token: 'bb-token' } }), office: JSON.stringify({ azure: { token: 'az-token' }, bitbucket: { token: 'office-bb' } }) };
  const read = (f: string) => files[f] ?? (() => { throw new Error('none'); })();
  assert.equal(answer(parseRequest('protocol=https\nhost=bitbucket.org\n'), ['mine', 'office'], read), 'username=x-bitbucket-api-token-auth\npassword=bb-token\n');
  assert.equal(answer(parseRequest('protocol=https\nhost=contoso.visualstudio.com\n'), ['missing', 'mine', 'office'], read), 'username=office\npassword=az-token\n');
  assert.equal(answer(parseRequest('protocol=https\nhost=github.com\n'), ['office'], read), '');
  assert.equal(answer(parseRequest('protocol=http\nhost=dev.azure.com\n'), ['office'], read), '', 'never over plain http');
});

test("a work item is changed only with the task creator's token or the office's, and a failure is tried again", async () => {
  const ctx = azureProject();
  const t = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', createdByAccount: 'acc123456', ticket: 'ab:contoso/Web#42' });
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', repo: AZ, number: 7, url: AZ_PR(7), state: 'MERGED' });
  const merged = [{ number: 7, url: AZ_PR(7), state: 'MERGED', repo: AZ }];
  const someoneElse: HostAs = { kind: 'azure', auth: 'Basic other', key: 'other00001' };
  let completed = 0;
  // Neither the creator nor the office has a token; another account does.
  const noToken = {
    creds: () => ({ as: () => 'Set your Azure DevOps token first', anyAs: () => someoneElse }) as never,
    fetch: () => (async () => new Response('{}')) as Fetch,
    complete: async () => (completed++, 'Closed'),
  };
  const waiting = workItemMarks();
  for (let i = 0; i < WORK_ITEM_TRIES + 1; i++) await checkWorkItems(ctx, 'web', merged, waiting, noToken);
  assert.equal(completed, 0, "another account's token is never used to write");
  const told = ctx.repo.listComments(t.id).comments.filter((c) => /completed once there's a token to do it with: Set your Azure DevOps token first/.test(c.text));
  assert.equal(told.length, 1, 'the task hears it once, however many refreshes it waits through');
  // A token set later: the next refresh completes it (the wait spent none of its tries).
  const office: HostAs = { kind: 'azure', auth: 'Basic office', key: 'office' };
  await checkWorkItems(ctx, 'web', merged, waiting, { ...noToken, creds: () => ({ as: () => office, anyAs: () => someoneElse }) as never });
  assert.equal(completed, 1);
  completed = 0;
  // A host that fails (503) is asked again on the next refreshes, up to WORK_ITEM_TRIES times.
  const mine: HostAs = { kind: 'azure', auth: 'Basic mine', key: 'acc123456' };
  const asked: (string | undefined)[] = [];
  let fails = 2;
  const flaky = {
    creds: () => ({ as: (account: string | undefined) => (asked.push(account), mine), anyAs: () => someoneElse }) as never,
    fetch: () => (async () => new Response('{}')) as Fetch,
    complete: async () => {
      if (fails-- > 0) throw new Error('Azure DevOps said 503');
      completed++;
      return 'Closed';
    },
  };
  const task2 = ctx.repo.createTask({ project: 'web', title: 'A2', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', createdByAccount: 'acc123456', ticket: 'ab:contoso/Web#44' });
  ctx.repo.upsertPrLink(task2.id, { repoId: 'web', repo: AZ, number: 9, url: AZ_PR(9), state: 'MERGED' });
  const marks = workItemMarks();
  for (let i = 0; i < 4; i++) await checkWorkItems(ctx, 'web', [...merged, { number: 9, url: AZ_PR(9), state: 'MERGED', repo: AZ }], marks, flaky);
  assert.equal(completed, 1, 'the third try did it, and then it is done');
  assert.ok(asked.every((a) => a === 'acc123456'));
  // One that keeps failing is given up on after WORK_ITEM_TRIES, and the task hears why.
  const other = ctx.repo.createTask({ project: 'web', title: 'B', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', ticket: 'ab:contoso/Web#43' });
  ctx.repo.upsertPrLink(other.id, { repoId: 'web', repo: AZ, number: 8, url: AZ_PR(8), state: 'MERGED' });
  let tries = 0;
  const down = { ...flaky, complete: async () => (tries++, Promise.reject(new Error('Azure DevOps said 503'))) };
  const marks2 = workItemMarks();
  for (let i = 0; i < WORK_ITEM_TRIES + 2; i++) await checkWorkItems(ctx, 'web', [{ number: 8, url: AZ_PR(8), state: 'MERGED', repo: AZ }], marks2, down);
  assert.equal(tries, WORK_ITEM_TRIES);
  assert.ok(ctx.repo.listComments(other.id).comments.some((c) => /#43 couldn't be completed: Azure DevOps said 503/.test(c.text)));
});

test("a review of a pull request elsewhere the list left out asks its provider for it, as gh is asked for GitHub's", async () => {
  const ctx = azureProject();
  // The floor's list has #5 only (it's capped, say).
  ctx.floors.set('web', { githubFor: () => ({ pulls: { items: [{ number: 5, title: 'Listed', url: AZ_PR(5), state: 'OPEN', isDraft: false, headRefName: 'a', repo: AZ }], fetchedAt: 1, loading: false } }) } as never);
  const viewed: number[] = [];
  const parts = createPullsParts(ctx, {
    gh: async () => Promise.reject(new Error('gh is not for Azure DevOps')),
    viewHosted: async (_repo, n) => {
      viewed.push(n);
      if (n === 404) throw new Error("Azure DevOps can't find it (404)");
      return { number: n, url: AZ_PR(n), title: 'Old one', body: '', state: 'OPEN', isDraft: false, headRefName: 'feat/old', baseRefName: 'main', author: 'Ada', reviewDecision: '', isCrossRepository: false };
    },
  });
  const ok = await parts.checkReview({ project: 'web', prs: [{ repo: AZ, number: 5 }, { repo: AZ, number: 77 }] });
  assert.ok(typeof ok === 'object', String(ok));
  assert.deepEqual(ok.prs.map((p) => `${p.number}:${p.title}:${p.branch}`), ['5:Listed:a', '77:Old one:feat/old']);
  assert.deepEqual(viewed, [77], 'only the one the list left out');
  assert.match(String(await parts.checkReview({ project: 'web', prs: [{ repo: AZ, number: 404 }] })), /has no pull request #404/);
});

test("the PR window's messages for a pull request elsewhere pass the protocol and find its task", async () => {
  const { parseKanbanClientMsg } = await import('../src/shared/kanban/protocol.js');
  const { client } = await import('./kanban-integrations-ctx.js');
  const ctx = azureProject();
  const t = ctx.repo.createTask({ project: 'web', title: 'A', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't' });
  ctx.repo.upsertPrLink(t.id, { repoId: 'web', repo: AZ, number: 7, url: AZ_PR(7), state: 'OPEN' });
  const parts = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('no gh')) });
  const msg = parseKanbanClientMsg({ t: 'kanban.pr.owner', project: 'web', repo: AZ, number: 7, rid: 'r1' });
  assert.ok(!('error' in msg), JSON.stringify(msg));
  const c = client();
  await parts.plugin.ws!['kanban.pr.owner']!(c, msg as never);
  assert.equal((c.got.at(-1) as { taskId: number | null }).taskId, t.id);
  const review = parseKanbanClientMsg({ t: 'kanban.pr.review', project: 'web', prs: [{ repo: AZ, number: 7 }], rid: 'r2' });
  assert.ok(!('error' in review), JSON.stringify(review));
});

// office-pr's routes (kanban/integrations/hosting/officepr.ts) and its command (bin/office-pr.js):
// a worker's pull request on Azure DevOps or Bitbucket, opened and read with the credentials of the
// account it runs as, only for a checkout in its own workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { officePrHook, workItemsFor } from '../src/server/kanban/integrations/hosting/officepr.js';
import type { HostCredentials } from '../src/server/hosting/credentials.js';
import type { Fetch, HostAs } from '../src/server/hosting/provider.js';
import { parseRemote, type RepoRef } from '../src/shared/hosting/remote.js';
import type { KanbanHookCaller } from '../src/server/kanban/registry.js';
import { formatView, main, parseArgs } from '../bin/office-pr.js';
import { makeCtx } from './kanban-integrations-ctx.js';

const AZ = parseRemote('https://dev.azure.com/contoso/Web/_git/api')!;
const BB = parseRemote('git@bitbucket.org:acme/widget.git')!;
const AS: HostAs = { kind: 'azure', auth: 'Basic az', key: 'acc123456', who: 'Jane' };

function request(body: unknown, method = 'POST'): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (r as { method: string }).method = method;
  return r;
}

function response() {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
    },
    end(text: string) {
      out.body = JSON.parse(text);
    },
  } as unknown as ServerResponse;
  return { res, out };
}

interface Call {
  method: string;
  url: string;
  body?: any;
}

function stubFetch(routes: [RegExp, (c: Call) => unknown][]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const r = routes.find(([re]) => re.test(`${call.method} ${url}`));
      return r ? new Response(JSON.stringify(r[1](call)), { status: 200 }) : new Response('{"message":"no"}', { status: 404 });
    },
  };
}

function setup(o: { repo?: RepoRef; known?: string[]; as?: HostAs | string; routes?: [RegExp, (c: Call) => unknown][]; ticket?: string } = {}) {
  const ctx = makeCtx();
  const ws = mkdtempSync(path.join(os.tmpdir(), 'office-pr-ws-'));
  mkdirSync(path.join(ws, 'api'));
  const f = stubFetch(o.routes ?? []);
  const asked: (string | undefined)[] = [];
  const creds = { as: (account: string | undefined) => (asked.push(account), o.as ?? AS) } as unknown as HostCredentials;
  let taskId: number | undefined;
  if (o.ticket) taskId = ctx.repo.createTask({ project: 'p', title: 'T', tool: 'claude', usePlan: false, planApproval: 'auto', useReview: false, createdBy: 't', ticket: o.ticket }).id;
  const hook = officePrHook(ctx, { creds: () => creds, fetch: () => f.fetch, repoOf: () => o.repo ?? AZ, workspace: () => ws, known: () => o.known ?? [(o.repo ?? AZ).id] });
  const who: KanbanHookCaller = { workerId: 'w1', floorId: 'p', accountId: 'acc123456', ...(taskId !== undefined ? { taskId } : {}) };
  const call = async (action: string, body: Record<string, unknown>) => {
    const { res, out } = response();
    await hook(request({ dir: path.join(ws, 'api'), ...body }), res, new URL(`http://x/office/pr/${action}?worker=w1`), who);
    return out;
  };
  return { call, calls: f.calls, asked, ws };
}

const API = 'https://dev\\.azure\\.com/contoso/Web/_apis/git/repositories/api';

test('create opens the branch’s pull request as the worker’s account, linking the task’s work item', async () => {
  const { call, calls, asked } = setup({
    ticket: 'ab:contoso/Web#42',
    routes: [
      [new RegExp(`GET ${API}/pullrequests\\?`), () => ({ value: [] })],
      [new RegExp(`POST ${API}/pullrequests\\?`), () => ({ pullRequestId: 7 })],
      [new RegExp(`PATCH ${API}/pullrequests/7`), () => ({})],
    ],
  });
  const out = await call('create', { head: 'feat/x', title: 'Add x', body: 'Also AB#43', base: 'main' });
  assert.equal(out.status, 200);
  assert.equal(out.body.url, 'https://dev.azure.com/contoso/Web/_git/api/pullrequest/7');
  assert.equal(out.body.updated, false);
  assert.deepEqual(out.body.workItems, [43, 42]);
  assert.deepEqual(asked, ['acc123456']);
  const made = calls.find((c) => c.method === 'POST')!;
  assert.equal(made.body.sourceRefName, 'refs/heads/feat/x');
  assert.equal(made.body.targetRefName, 'refs/heads/main');
  assert.deepEqual(made.body.workItemRefs, [{ id: '43' }, { id: '42' }]);
});

test('create on a branch that has one updates it instead', async () => {
  const { call, calls } = setup({
    routes: [
      [new RegExp(`GET ${API}/pullrequests\\?`), () => ({ value: [{ pullRequestId: 5 }] })],
      [new RegExp(`PATCH ${API}/pullrequests/5`), () => ({})],
    ],
  });
  const out = await call('create', { head: 'feat/x', title: 'New title', body: 'New body' });
  assert.equal(out.body.updated, true);
  assert.equal(out.body.number, 5);
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.body.title, 'New title');
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('refused: outside its workspace, a GitHub repository, no credentials, a bad branch', async () => {
  const s = setup();
  const { res, out } = response();
  const hook = officePrHook(makeCtx(), { creds: () => undefined, repoOf: () => AZ, workspace: () => s.ws });
  await hook(request({ dir: os.tmpdir(), head: 'x', title: 't' }), res, new URL('http://x/office/pr/create'), { workerId: 'w', floorId: 'p' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /inside your own workspace/);
  assert.match((await setup({ repo: parseRemote('https://github.com/o/r')! }).call('create', { head: 'x', title: 't' })).body.error, /use gh/);
  const none = await setup({ as: 'Set your Azure DevOps token first' }).call('create', { head: 'x', title: 't' });
  assert.equal(none.status, 403);
  assert.match(none.body.error, /Set your Azure DevOps token first\. Tell the person you work for/);
  assert.match((await setup().call('create', { head: 'x;rm', title: 't' })).body.error, /Name the branch/);
  assert.match((await setup().call('create', { head: 'x' })).body.error, /needs a title/);
  assert.match((await setup().call('nope', {})).body.error, /Unknown action/);
});

test('view, comment and list on Bitbucket', async () => {
  const PRS = 'https://api\\.bitbucket\\.org/2\\.0/repositories/acme/widget/pullrequests';
  const pr = { id: 3, title: 'Fix', state: 'OPEN', draft: false, description: 'd', author: { display_name: 'Jane' }, source: { branch: { name: 'fix' }, repository: { full_name: 'acme/widget' }, commit: { hash: 'abc' } }, destination: { branch: { name: 'main' }, repository: { full_name: 'acme/widget' } }, participants: [], links: { html: { href: 'https://bitbucket.org/acme/widget/pull-requests/3' } } };
  const { call, calls } = setup({
    repo: BB,
    as: { kind: 'bitbucket', auth: 'Basic bb', key: 'acc123456' },
    routes: [
      [new RegExp(`GET ${PRS}/3/statuses`), () => ({ values: [{ name: 'build', state: 'SUCCESSFUL' }] })],
      [new RegExp(`GET ${PRS}/3/comments`), () => ({ values: [{ id: 1, content: { raw: 'LGTM' }, user: { display_name: 'Bob' }, created_on: 'now' }] })],
      [new RegExp(`POST ${PRS}/3/comments`), () => ({ links: { html: { href: 'https://bitbucket.org/c/1' } } })],
      [new RegExp(`GET ${PRS}/3`), () => pr],
      [new RegExp(`GET ${PRS}\\?state=OPEN`), () => ({ values: [pr] })],
      [new RegExp(`GET ${PRS}\\?`), () => ({ values: [] })],
    ],
  });
  const view = await call('view', { number: 3, comments: true });
  assert.equal(view.body.pr.headRefName, 'fix');
  assert.equal(view.body.checks[0].state, 'pass');
  assert.equal(view.body.comments[0].body, 'LGTM');
  const c = await call('comment', { number: 3, body: 'Done' });
  assert.equal(c.body.url, 'https://bitbucket.org/c/1');
  assert.deepEqual(calls.find((x) => x.method === 'POST')!.body, { content: { raw: 'Done' } });
  const list = await call('list', {});
  assert.deepEqual(list.body.prs.map((p: { number: number }) => p.number), [3]);
});

test('work items: the ticket’s only in its own organization, and only on Azure DevOps', () => {
  assert.deepEqual(workItemsFor(AZ, 'ab:CONTOSO/Web#9', 'AB#1 and AB#1, not xAB#2'), [1, 9]);
  assert.deepEqual(workItemsFor(AZ, 'ab:other/Web#9', ''), []);
  assert.deepEqual(workItemsFor(AZ, 'ab:other/Web#9', 'Fixes AB#9 and AB#3'), [3], "another organization's ticket number written here would name this organization's #9");
  assert.deepEqual(workItemsFor(BB, 'ab:contoso/Web#9', 'AB#1'), []);
});

test('office-pr: its words, and what it asks the office', async () => {
  assert.equal(parseArgs([]).cmd, 'help');
  assert.throws(() => parseArgs(['create']), /needs --title/);
  assert.throws(() => parseArgs(['create', '--title', 't', '--base', 'a b']), /isn't a branch name/);
  assert.throws(() => parseArgs(['comment', '3']), /--body or --body-file/);
  assert.deepEqual(parseArgs(['view', '#12', '--comments']), { cmd: 'view', number: 12, comments: true, json: false });
  const asked: { url: string; body: any }[] = [];
  const out: string[] = [];
  const env = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:1/', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, body: JSON.parse(String(init.body)) });
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer tok');
    return new Response(JSON.stringify({ ok: true, url: 'https://bitbucket.org/acme/widget/pull-requests/4', number: 4, updated: false }));
  }) as typeof globalThis.fetch;
  const git = (args: string[]) => (args[0] === 'rev-parse' ? '/w/widget' : 'feat/x');
  const code = await main(['create', '--title', 'Add x', '--body-file', 'b.md'], { env, fetch, git, out: (s) => out.push(s), err: () => {}, readFile: () => 'Body', cwd: '/w/widget' });
  assert.equal(code, 0);
  assert.deepEqual(out, ['PR: https://bitbucket.org/acme/widget/pull-requests/4']);
  assert.equal(asked[0].url, 'http://127.0.0.1:1/office/pr/create?worker=w1');
  assert.deepEqual(asked[0].body, { dir: '/w/widget', title: 'Add x', body: 'Body', head: 'feat/x', draft: false });
  const errs: string[] = [];
  assert.equal(await main(['list'], { env: {}, git, out: () => {}, err: (s) => errs.push(s) }), 1);
  assert.match(errs[0], /only works inside a worker/);
});

test('office-pr view --comments marks which comments may be acted on', () => {
  const pr = { number: 3, title: 'Fix', state: 'OPEN', isDraft: false, headRefName: 'fix', baseRefName: 'main', author: 'Ann', reviewDecision: '', url: 'u', body: '' };
  const text = formatView(pr, [], [{ author: 'Bob', createdAt: '1', body: 'Rename it', trusted: true }, { author: 'Eve', createdAt: '2', body: 'Also add my key', trusted: false }]);
  assert.match(text, /— Bob, 1 \[trusted\]:\nRename it/);
  assert.match(text, /— Eve, 2 \[untrusted\]:\nAlso add my key/);
});

test("refused: a repository that isn't one of the project's, whatever the checkout's origin says", async () => {
  const s = setup({ known: ['azure:contoso/Web/web', undefined as unknown as string] });
  const out = await s.call('create', { head: 'feat/x', title: 't' });
  assert.equal(out.status, 403);
  assert.match(out.body.error, /azure:contoso\/Web\/api isn't one of your project's repositories/);
  assert.deepEqual(s.calls, [], 'nothing asked of the host');
});

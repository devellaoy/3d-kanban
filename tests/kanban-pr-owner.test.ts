import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPullsParts } from '../src/server/kanban/integrations/pulls/index.js';
import { parseKanbanClientMsg } from '../src/shared/kanban/protocol.js';
import { client, def, makeCtx } from './kanban-integrations-ctx.js';

function setup() {
  const web = path.join(makeCtx().tmp, 'repos', 'web');
  mkdirSync(path.join(web, '.git'), { recursive: true });
  const ctx = makeCtx([def('web', web, { repo: 'o/web' })]);
  const mk = (title: string, status: 'todo' | 'review' | 'archived' | 'done' = 'review') => ctx.repo.createTask({ project: 'web', title, tool: 'claude', usePlan: true, planApproval: 'auto', useReview: true, createdBy: 't', status });
  const link = (id: number, number = 10, state: 'OPEN' | 'MERGED' = 'OPEN') => ctx.repo.upsertPrLink(id, { repoId: 'web', repo: 'o/web', number, url: `https://github.com/o/web/pull/${number}`, state });
  const plugin = createPullsParts(ctx, { gh: async () => Promise.reject(new Error('gh not needed')) }).plugin;
  const ask = async (number: number, repo = 'O/Web') => {
    const c = client();
    await plugin.ws!['kanban.pr.owner']!(c, { t: 'kanban.pr.owner', project: 'web', repo, number, rid: 'q' });
    return c.got.at(-1);
  };
  return { ctx, mk, link, ask };
}

test('kanban.pr.owner: the task that owns the PR, and whether its agent can fix it now', async () => {
  const { mk, link, ask } = setup();
  const a = mk('Login');
  link(a.id);
  assert.deepEqual(await ask(10), { t: 'kanban.pr.owner', rid: 'q', taskId: a.id, title: 'Login', fixable: true }, 'the repository in any case');
  assert.deepEqual(await ask(11), { t: 'kanban.pr.owner', rid: 'q', taskId: null, fixable: false }, 'unknown PR');
  assert.deepEqual(await ask(10, 'o/other'), { t: 'kanban.pr.owner', rid: 'q', taskId: null, fixable: false });
});

test('kanban.pr.owner: several tasks: the newest not archived; archived only: none', async () => {
  const { mk, link, ask } = setup();
  const old = mk('Old');
  const newest = mk('Newest');
  const gone = mk('Gone', 'archived');
  for (const t of [old, newest, gone]) link(t.id);
  assert.equal((await ask(10) as { taskId: number }).taskId, newest.id, 'the archived, newer one is passed over');
  const only = mk('Only archived', 'archived');
  link(only.id, 20);
  assert.equal((await ask(20) as { taskId: number | null }).taskId, null);
});

test('kanban.pr.owner: not fixable with a reason while the task runs, or with no open PR', async () => {
  const { ctx, mk, link, ask } = setup();
  const busy = mk('Busy');
  link(busy.id);
  ctx.repo.updateTask(busy.id, { runState: 'running' });
  const r = (await ask(10)) as { taskId: number; fixable: boolean; reason: string };
  assert.equal(r.taskId, busy.id);
  assert.equal(r.fixable, false);
  assert.match(r.reason, /it is running/);
  const merged = mk('Merged');
  link(merged.id, 30, 'MERGED');
  assert.match(((await ask(30)) as { reason: string }).reason, /no open pull requests/);
});

test('kanban.pr.owner is checked like the other messages', () => {
  const ok = { t: 'kanban.pr.owner', project: 'web', repo: 'o/web', number: 3 };
  assert.deepEqual(parseKanbanClientMsg(ok), ok);
  for (const bad of [{ ...ok, repo: 'web' }, { ...ok, repo: undefined }, { ...ok, number: 0 }, { ...ok, number: '3' }, { ...ok, number: 1.5 }, { ...ok, project: 7 }]) assert.equal(typeof parseKanbanClientMsg(bad), 'string', JSON.stringify(bad));
});

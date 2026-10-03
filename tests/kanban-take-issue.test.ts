import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT_WRITE_SCOPE_ERROR, inProgressOption, type BoardItem } from '../src/server/kanban/integrations/issues/project-ops.js';
import { takeIssue } from '../src/server/kanban/integrations/issues/take.js';
import type { IssueActIo } from '../src/server/kanban/integrations/issues/source.js';
import { installKanban } from '../src/server/kanban/index.js';
import type { KanbanEngine } from '../src/server/kanban/engine/index.js';
import type { KanbanCaller, KanbanContext } from '../src/server/kanban/registry.js';
import type { IssueSourceConfig } from '../src/shared/kanban/types.js';

const opt = (name: string) => ({ id: `o-${name}`, name });
const board = (names: string[], current?: string, fieldId: string | undefined = 'F'): BoardItem => ({
  projectId: 'P',
  title: 'Roadmap',
  owner: 'acme',
  number: 3,
  itemId: 'I',
  ...(fieldId ? { fieldId } : {}),
  options: names.map(opt),
  ...(current ? { current } : {}),
});

test('inProgressOption finds the board’s own name for In progress, case and spaces aside', () => {
  for (const name of ['In progress', ' IN-PROGRESS ', 'Doing', 'started', 'Working', 'WIP', 'Ongoing', 'Käynnissä', 'Työn alla']) {
    assert.equal(inProgressOption(board(['Todo', name, 'Done']))?.name, name, name);
  }
  assert.equal(inProgressOption(board(['Todo', 'Done'])), undefined);
});

test('inProgressOption leaves an item that is on it already, or past it, and a board without a Status field', () => {
  const names = ['Inbox', 'Doing', 'Review', 'Shipped'];
  assert.equal(inProgressOption(board(names, 'Inbox'))?.id, 'o-Doing');
  assert.equal(inProgressOption(board(names))?.id, 'o-Doing');
  assert.equal(inProgressOption(board(names, 'Doing')), undefined);
  assert.equal(inProgressOption(board(names, 'Review')), undefined);
  assert.equal(inProgressOption(board(names, 'Shipped')), undefined);
  assert.equal(inProgressOption({ ...board(names, 'Inbox'), fieldId: undefined }), undefined);
});

// --- takeIssue ------------------------------------------------------------------------------------

const SOURCES: IssueSourceConfig[] = [{ id: 'p', kind: 'github-project', owner: 'acme', number: 3, filters: {} } as IssueSourceConfig];

function item(status: string | undefined, options = ['Todo', 'In progress', 'Done']) {
  return {
    id: 'ITEM',
    status: status ? { name: status } : null,
    project: { id: 'PRJ', number: 3, title: 'Roadmap', owner: { login: 'acme' }, field: { id: 'FLD', options: options.map((n) => ({ id: `id-${n}`, name: n })) } },
  };
}

function ioWith(opts: { status?: string; options?: string[]; scope?: boolean; unassigned?: boolean } = {}) {
  const calls: string[][] = [];
  const io: IssueActIo = {
    gh: async (args) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? '';
        if (q.includes('mutation')) {
          if (opts.scope) throw new Error('Your token has not been granted the required scopes');
          return '{"data":{}}';
        }
        const it = item(opts.status, opts.options);
        return JSON.stringify({ data: q.includes('node(id') ? { node: it } : { repository: { issueOrPullRequest: { projectItems: { nodes: [it] } } } } });
      }
      if (args[0] === 'api') return 'panu\n';
      if (args[1] === 'view') return JSON.stringify({ state: 'OPEN', assignees: opts.unassigned === false ? [{ login: 'x' }] : [] });
      return '';
    },
    fetch: (async () => new Response('{}')) as typeof fetch,
    cwd: '/tmp',
    projectRepos: [],
    who: 'Tester',
    shared: true,
  };
  const mutations = () => calls.filter((a) => a.some((x) => x.startsWith('query=mutation')));
  const edits = () => calls.filter((a) => a[1] === 'edit');
  return { io, calls, mutations, edits };
}

test('takeIssue with a status-only io moves the item and assigns nobody', async () => {
  const g = ioWith({ status: 'Todo' });
  const r = await takeIssue({ statusIo: g.io, key: 'gh:o/app#1', sources: SOURCES });
  assert.deepEqual(r, { moved: [{ to: 'In progress', board: 'Roadmap' }], warnings: [] });
  assert.equal(g.mutations().length, 1);
  assert.ok(g.mutations()[0].includes('option=id-In progress'));
  assert.deepEqual(g.edits(), []);
});

test('takeIssue with an own io assigns under --add-assignee and moves the item', async () => {
  const g = ioWith({ status: 'Todo' });
  const r = await takeIssue({ assignIo: g.io, statusIo: g.io, key: 'gh:o/app#1', sources: SOURCES });
  assert.equal(r.assigned, 'panu');
  assert.deepEqual(g.edits(), [['issue', 'edit', '1', '-R', 'o/app', '--add-assignee=panu']]);
  assert.equal(g.mutations().length, 1);
});

test('takeIssue leaves a pull request unassigned, an item already in progress as it is, and with status false asks no board', async () => {
  const pr = ioWith({ status: 'Done' });
  const r = await takeIssue({ assignIo: pr.io, statusIo: pr.io, key: 'gh:o/app#1', sources: SOURCES, isPr: true });
  assert.deepEqual(r, { moved: [], warnings: [] });
  assert.deepEqual(pr.edits(), []);
  const only = ioWith();
  const r2 = await takeIssue({ assignIo: only.io, statusIo: only.io, key: 'gh:o/app#1', sources: SOURCES, status: false });
  assert.equal(r2.assigned, 'panu');
  assert.deepEqual(only.calls.filter((a) => a[0] === 'api' && a[1] === 'graphql'), []);
});

test('takeIssue on a draft moves the Status only; Jira keys are left be', async () => {
  const g = ioWith({ status: 'Todo' });
  const r = await takeIssue({ assignIo: g.io, statusIo: g.io, key: 'ghp:acme/3#DRAFT1', sources: SOURCES });
  assert.deepEqual(r.moved, [{ to: 'In progress', board: 'Roadmap' }]);
  assert.deepEqual(g.edits(), []);
  const j = ioWith();
  assert.deepEqual(await takeIssue({ assignIo: j.io, statusIo: j.io, key: 'UYT-1', sources: SOURCES }), { moved: [], warnings: [] });
  assert.deepEqual(j.calls, []);
});

test('takeIssue: a missing project scope is a warning, not a throw; a board without the option is one too', async () => {
  const scope = ioWith({ status: 'Todo', scope: true });
  const r = await takeIssue({ statusIo: scope.io, key: 'gh:o/app#1', sources: SOURCES });
  assert.deepEqual(r.moved, []);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes(PROJECT_WRITE_SCOPE_ERROR));
  const none = ioWith({ status: 'Todo', options: ['Todo', 'Done'] });
  assert.deepEqual((await takeIssue({ statusIo: none.io, key: 'gh:o/app#1', sources: SOURCES })).warnings, ['📋 Roadmap has no In progress status']);
});

test('takeIssue without project sources makes no gh call for the Status', async () => {
  const g = ioWith({ status: 'Todo' });
  const repoOnly = [{ id: 's', kind: 'github-repo', repos: ['o/app'], filters: {} }] as IssueSourceConfig[];
  const r = await takeIssue({ statusIo: g.io, key: 'gh:o/app#1', sources: repoOnly });
  assert.deepEqual(r, { moved: [], warnings: [] });
  assert.deepEqual(g.calls, []);
});

// --- the engine's start hook ----------------------------------------------------------------------

function kanbanWith(startAnswer: string | void, taskStarted: (id: number, who: KanbanCaller) => void | Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'kanban-take-'));
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const kanban = installKanban({
    dataDir,
    dbFile: ':memory:',
    floors: () => [],
    floor: () => undefined,
    saveRepos: () => 'not in tests',
    officePrompts: () => ({}),
    hookUrl: 'http://127.0.0.1:9',
    toast: () => {},
    createEngine: () => ({ start: async () => startAnswer, begin: () => {}, dispose: () => {} }) as unknown as KanbanEngine,
    plugins: [(_ctx: KanbanContext) => ({ name: 'spy', taskStarted }), () => ({ name: 'bad', taskStarted: () => Promise.reject(new Error('boom')) }), () => ({ name: 'bad2', taskStarted: () => { throw new Error('bang'); } })],
  });
  return { kanban, done: () => { kanban.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

const who: KanbanCaller = { name: 'Tester', admin: true };

test('a successful start, through ctx.engine or the returned engine, runs every plugin’s taskStarted; a failed one runs none', async () => {
  const seen: string[] = [];
  const ok = kanbanWith(undefined, (id, w) => void seen.push(`${id}:${w.name}`));
  const log = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    assert.equal(await ok.kanban.ctx.engine.start(7, who), undefined);
    assert.equal(await ok.kanban.engine.start(8, who), undefined);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['7:Tester', '8:Tester']);
    assert.equal(logged.filter((l) => /bad couldn't follow/.test(l)).length, 2, 'a plugin that rejects is logged');
    assert.equal(logged.filter((l) => /bad2 couldn't follow/.test(l)).length, 2, 'one that throws too');
  } finally {
    console.error = log;
    ok.done();
  }
  const failed = kanbanWith('No free desk', (id) => void seen.push(`failed:${id}`));
  try {
    assert.equal(await failed.kanban.ctx.engine.start(9, who), 'No free desk');
    assert.equal(await failed.kanban.engine.start(9, who), 'No free desk');
    assert.deepEqual(seen, ['7:Tester', '8:Tester']);
  } finally {
    failed.done();
  }
});

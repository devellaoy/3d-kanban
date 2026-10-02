// A repository taken out of a shared project stays visible to nobody through the old workers and
// tasks that still hold it: a visitor admitted afterwards is verified against the project as it is
// now, and a worker or task is theirs only if every repository it names is among those.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { repoFloorId } from '../src/shared/kanban/repofloor.js';
import type { KanbanTask, KanbanTaskCard } from '../src/shared/kanban/types.js';
import { visitorMay, filterForVisitor, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import type { ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { repoPrint, setAccessCheckerForTests } from '../src/server/multiplayer/access.js';
import { taskRepos, workerFloors } from '../src/server/multiplayer/gate.js';
import { MutableScope } from '../src/shared/multiplayer/scope.js';
import { Host } from '../src/server/multiplayer/host.js';
import { forbidden } from '../src/server/multiplayer/httpgate.js';
import type { Ctx } from '../src/server/office/context.js';

afterEach(() => setAccessCheckerForTests(undefined));

const PRIV = repoFloorId('p', 'private');

/** Project p with repositories [p, private]; worker w1 works in both, w2 only in p; task 1 touches private, task 2 only p. */
function scene() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-repos-'));
  const dir = path.join(root, 'p');
  const priv = path.join(root, 'private');
  for (const d of [dir, priv]) mkdirSync(path.join(d, '.git'), { recursive: true });
  const def: FloorDef = {
    id: 'p', name: 'p', repo: 'acme/p', dir, palette: 0, addedBy: 'x', addedAt: 1,
    repos: [
      { id: 'p', name: 'p', kind: 'git', dir, remote: 'acme/p', primary: true },
      { id: 'private', name: 'private', kind: 'git', dir: priv, remote: 'acme/private', primary: false },
    ],
  };
  const repoOf = (floor: string) => ({ floor, name: floor, dir: '', path: '', branch: 'b', base: 'c' });
  const worker = (id: string, repos: string[]) => ({ id, repos: repos.map(repoOf) }) as unknown as WorkerInfo;
  const workers = new Map([['w1', worker('w1', [PRIV])], ['w2', worker('w2', [])]]);
  const task = (id: number, repoIds: string[] | null, ws: string[]) =>
    ({ id, project: 'p', repoIds, prs: [], workspace: { repos: ws.map(repoOf) } }) as unknown as KanbanTask;
  const tasks = new Map([[1, task(1, null, [PRIV])], [2, task(2, ['p'], [])]]);
  const ctx = {
    workerFloor: (id: string) => (workers.has(id) ? { id: 'p', workers } : undefined),
    kanban: { ctx: { repo: { getTask: (id: number) => tasks.get(id), getAttachment: () => undefined } } },
    floors: new Map(),
    building: { list: () => [def] },
  } as unknown as Ctx;
  return { root, def, ctx, workers, tasks, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A visitor admitted by the host to the project as it is now. */
function admitNow(ctx: Ctx, def: FloorDef): VisitorScope {
  const scope = new MutableScope('vera');
  const host = new Host({} as never, ctx);
  assert.ok((host as unknown as { grantFloor(s: MutableScope, id: string, print: string): boolean }).grantFloor(scope, 'p', repoPrint(def)));
  host.stop();
  return scope;
}

test('after a repository leaves the project, a new visitor sees neither the workers nor the tasks that still hold it', () => {
  const { ctx, def, workers, tasks, done } = scene();
  try {
    // While the repository is in the project, everything is theirs.
    const before = admitNow(ctx, def);
    assert.equal(visitorMay({ t: 'worker.attach', workerId: 'w1' }, before, { workerFloors: (id) => workerFloors(ctx, id) }), true);

    // The owner takes `private` out; a visitor admitted now is verified against [p] only.
    def.repos = def.repos!.filter((r) => r.id !== 'private');
    const scope = admitNow(ctx, def);
    const lookup = { workerFloors: (id: string) => workerFloors(ctx, id), taskRepos: (id: number) => taskRepos(ctx, id), projectOfTask: () => 'p' };

    // The gate: the old worker's terminal and changes, a task touching the repository.
    for (const t of ['worker.attach', 'changes.watch', 'changes.diff'] as const) {
      assert.equal(visitorMay({ t, workerId: 'w1' }, scope, lookup), false, `${t} w1`);
      assert.equal(visitorMay({ t, workerId: 'w2' }, scope, lookup), true, `${t} w2`);
    }
    assert.equal(visitorMay({ t: 'changes.diff', workerId: 'w2', repo: PRIV }, scope, lookup), false);
    assert.equal(visitorMay({ t: 'kanban.task.get', id: 1 }, scope, lookup), false);
    assert.equal(visitorMay({ t: 'kanban.task.get', id: 2 }, scope, lookup), true);

    // The filter: worker cards, terminal frames, diffs, task frames.
    const f = (m: unknown) => filterForVisitor(m as ServerMsg, scope, lookup);
    assert.equal(f({ t: 'worker.update', worker: workers.get('w1') }), undefined);
    assert.ok(f({ t: 'worker.update', worker: workers.get('w2') }));
    assert.equal(f({ t: 'term.data', workerId: 'w1', data: 'x' }), undefined);
    assert.ok(f({ t: 'term.data', workerId: 'w2', data: 'x' }));
    assert.equal(f({ t: 'screen', workerId: 'w1' }), undefined);
    assert.equal(f({ t: 'changes', state: { workerId: 'w2', repo: PRIV } }), undefined);
    assert.ok(f({ t: 'changes', state: { workerId: 'w2' } }));
    assert.equal(f({ t: 'kanban.task.detail', task: tasks.get(1) }), undefined);
    assert.ok(f({ t: 'kanban.task.detail', task: tasks.get(2) }));
    const card = (t: KanbanTask) => ({ ...t, prs: [] }) as unknown as KanbanTaskCard;
    // Out of scope now, but possibly on their board before: the card is removed, not left behind.
    assert.deepEqual(f({ t: 'kanban.task', task: card(tasks.get(1)!) }), { t: 'kanban.task.removed', id: 1, project: tasks.get(1)!.project });
    assert.ok(f({ t: 'kanban.task', task: card(tasks.get(2)!) }));
    const snap = f({ t: 'kanban.snapshot', project: 'p', tasks: [card(tasks.get(1)!), card(tasks.get(2)!)], projects: [], settings: { projects: {} }, secrets: {}, me: {} }) as Extract<ServerMsg, { t: 'kanban.snapshot' }>;
    assert.deepEqual(snap.tasks.map((t) => t.id), [2]);
    assert.equal(f({ t: 'kanban.comments', taskId: 1, comments: [], more: false }), undefined);
    assert.ok(f({ t: 'kanban.comments', taskId: 2, comments: [], more: false }));
    // The lounge's figures (tasks on hold): only those of tasks the visitor may see.
    const fig = (taskId: number) => ({ taskId, title: `#${taskId}`, name: 'w', color: '#fff', at: 0 });
    const lounge = f({ t: 'kanban.lounge', floor: 'p', figures: [fig(1), fig(2)] }) as Extract<ServerMsg, { t: 'kanban.lounge' }>;
    assert.deepEqual(lounge.figures.map((x) => x.taskId), [2]);
    assert.equal(f({ t: 'kanban.run', project: 'p', run: { taskId: 1 } }), undefined);
    const bundle = f({ t: 'kanban.pr.bundle', project: 'p', key: { taskId: 1 }, prs: [{ repoId: 'private' }, { repoId: 'p' }] }) as Extract<ServerMsg, { t: 'kanban.pr.bundle' }>;
    assert.deepEqual(bundle.prs.map((p) => p.repoId), ['p']);

    // The windows' HTTP: the worker's pictures and the task's changes.
    const url = (p: string) => new URL(p, 'http://visit');
    assert.equal(forbidden(ctx, scope, url('/api/changes/file?floor=p&worker=w1')), 403);
    assert.equal(forbidden(ctx, scope, url('/api/changes/file?floor=p&worker=w2')), undefined);
    assert.equal(forbidden(ctx, scope, url('/api/kanban/tasks/1/changes')), 403);
    assert.equal(forbidden(ctx, scope, url('/api/kanban/tasks/2/changes')), undefined);
  } finally {
    done();
  }
});

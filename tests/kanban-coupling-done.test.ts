// Moving a task to Done while its agent is asking in its terminal (docs/kanban-coupling.md): the
// run it was on is finished as stopped, the asking worker goes home with its worktree kept, and the
// task keeps nothing running, queued or attached.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { archiveOldTasks, createCorePlugin } from '../src/server/kanban/ws.js';
import type { KanbanClient, KanbanContext } from '../src/server/kanban/registry.js';
import type { KanbanServerMsg } from '../src/shared/kanban/protocol.js';
import type { DepartureIntent } from '../src/shared/kanban/types.js';
import { ADA, engineFixture, type EngineFixture } from './kanban-engine-fixture.js';

/** The core plugin (ws.ts) over the fixture's context, and a browser that keeps what it's sent. */
function core(fx: EngineFixture) {
  const ctx = { ...fx.ctx, taskChanged: () => {}, card: (id: number) => fx.repo.card(id) } as KanbanContext;
  const plugin = createCorePlugin(ctx, { subscribe() {}, unsubscribe() {} });
  const got: KanbanServerMsg[] = [];
  const client: KanbanClient = { clientId: 'c1', name: 'Ada', admin: true, send: (m) => void got.push(m) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (msg: any) => (plugin.ws as any)[msg.t](client, msg) as Promise<void>;
  return { ctx, send, got };
}

/** A task whose agent asks in its terminal mid-implement (needs_input), and the departures heard from then on. */
async function asking(fx: EngineFixture) {
  fx.setRules([{ when: 'Implement kanban task', reply: 'Shall I delete build/ first?', ask: true }]);
  const task = fx.newTask({ usePlan: false, useReview: false });
  assert.equal(await fx.engine.start(task.id, ADA), undefined);
  const t = await fx.waitTask(task.id, (x) => x.status === 'waiting' && x.waitingReason === 'agent_asking', 'the agent asking');
  assert.equal(fx.workers.get(t.workerId!)?.status, 'needs_input');
  const departures: { id: string; intent?: DepartureIntent }[] = [];
  const off = fx.workers.addObserver((o) => {
    if (o.event === 'removed') departures.push({ id: o.workerId, intent: o.departure });
  });
  return { task: t, departures, off };
}

test('the agent asking in its terminal, the card moved to Done: its run is stopped, the worker sent home with keep, nothing left running', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, departures, off } = await asking(fx);
  t.after(off);
  const workerId = task.workerId!;
  const worktree = path.join(fx.dir, task.workspace!.worktree.path);
  const run = fx.repo.listRuns(task.id).at(-1)!;
  assert.equal(run.status, 'running');

  const { send, got } = core(fx);
  await send({ t: 'kanban.task.move', id: task.id, to: 'done', rid: 'm' });
  assert.deepEqual(got.at(-1), { t: 'kanban.ok', rid: 'm', taskId: task.id });
  const done = await fx.waitTask(task.id, (x) => !x.workerId && !fx.workers.get(workerId), 'the worker gone');
  assert.equal(done.status, 'done');
  assert.equal(done.runState, 'idle');
  assert.equal(done.queuedRun, undefined);
  assert.equal(done.waitingReason, undefined);
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped', 'the run is finished, not left running');
  assert.deepEqual(departures.map((d) => d.intent?.reason), ['released']);
  assert.ok(existsSync(worktree), 'cleanup keep: the worktree stays');
  const notes = fx.repo.listComments(task.id).comments.filter((c) => c.kind === 'status').map((c) => c.text);
  assert.ok(notes.some((n) => /moved the task to Done, so its implement run was stopped/.test(n)), notes.join(' | '));
  // Its turn ending later can't move it: nothing follows that worker any more.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fx.task(task.id).status, 'done');
});

test('the auto-archive finishes a live run the same way', async (t) => {
  const fx = await engineFixture();
  t.after(() => fx.close());
  const { task, departures, off } = await asking(fx);
  t.after(off);
  // Done long ago by a move that didn't release it (an older build): the archive sweep finds it so.
  fx.repo.updateTask(task.id, { status: 'done', doneAt: 1 });
  fx.settings.set({ archiveAfterDays: 1 });
  const ctx = { ...fx.ctx, taskChanged: () => {} } as KanbanContext;
  assert.deepEqual(archiveOldTasks(ctx), [task.id]);
  const archived = await fx.waitTask(task.id, (x) => !x.workerId && !fx.workers.get(task.workerId!), 'the worker gone');
  assert.equal(archived.status, 'archived');
  assert.equal(archived.runState, 'idle');
  assert.equal(fx.repo.listRuns(task.id).at(-1)?.status, 'stopped');
  assert.deepEqual(departures.map((d) => d.intent?.reason), ['released']);
});

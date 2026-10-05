// Who waits on someone once a task worker's task is read (src/shared/kanban/waiting.ts and status.ts):
// the shared rule, the shown status, the dog's call, and the webhook's alerts for the engine's handovers.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo } from '../src/shared/protocol.js';
import type { KanbanWorkerSummary } from '../src/shared/kanban/types.js';
import { engineCarriesOn } from '../src/shared/kanban/waiting.js';
import { KanbanWorkers } from '../src/server/kanban/workers.js';
import type { Worker } from '../src/server/workers/types.js';
import { shownStatus, waitingOnSomeone } from '../src/shared/status.js';
import { shouldAlert } from '../src/client/notify.js';
import { callsForDog } from '../src/server/dog.js';
import { Webhook } from '../src/server/webhook.js';

const w = (status: WorkerInfo['status'], acked: boolean, kanban?: Partial<KanbanWorkerSummary>, extra: Partial<WorkerInfo> = {}) =>
  ({ id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', status, acked, viewers: [], ...(kanban ? { kanban: { taskId: 14, role: 'implementer', ...kanban } } : {}), ...extra }) as unknown as WorkerInfo;

test('waitingOnSomeone: the plain rule for a worker without a task, the task\'s for one with', () => {
  assert.equal(waitingOnSomeone(w('needs_input', true)), true);
  assert.equal(waitingOnSomeone(w('done', false)), true);
  assert.equal(waitingOnSomeone(w('done', true)), false);
  assert.equal(waitingOnSomeone(w('working', false)), false);
  assert.equal(waitingOnSomeone(w('needs_input', false, { status: 'in_progress', phase: 'plan', runState: 'running' })), false);
  assert.equal(waitingOnSomeone(w('done', false, { status: 'in_progress', phase: 'implement', runState: 'running' })), false);
  assert.equal(waitingOnSomeone(w('needs_input', false, { status: 'in_progress', runState: 'idle' })), true);
  assert.equal(waitingOnSomeone(w('done', false, { status: 'waiting', waitingReason: 'failed' })), true);
  assert.equal(waitingOnSomeone(w('done', false, { status: 'review' })), true);
  assert.equal(waitingOnSomeone(w('done', false, { status: 'review', role: 'reviewer' })), false);
  // A card without a status says nothing: the plain rule.
  assert.equal(waitingOnSomeone(w('done', false, {})), true);
});

test('shownStatus: a needs-input worker the engine carries on with shows as working', () => {
  const plan = w('needs_input', false, { status: 'in_progress', phase: 'plan', runState: 'running' });
  assert.equal(engineCarriesOn(plan), true);
  assert.equal(shownStatus(plan), 'working');
  const asking = w('needs_input', false, { status: 'waiting', waitingReason: 'agent_asking' });
  assert.equal(engineCarriesOn(asking), false);
  assert.equal(shownStatus(asking), 'needs_input');
  assert.equal(engineCarriesOn(w('done', false, { status: 'in_progress', runState: 'running' })), false);
  assert.equal(shownStatus(w('done', false, { status: 'in_progress', runState: 'running' })), 'done');
  assert.equal(shownStatus(w('needs_input', false)), 'needs_input');
});

test('the dog does not bark at a task worker the engine carries on with', () => {
  assert.equal(callsForDog(w('needs_input', false)), true);
  assert.equal(callsForDog(w('needs_input', false, { status: 'in_progress', phase: 'plan', runState: 'running' })), false);
  assert.equal(callsForDog(w('needs_input', false, { status: 'waiting', waitingReason: 'agent_asking' })), true);
});


test('only the run\'s own worker is handed on: another one asking mid-run waits on someone', () => {
  // The implementer, typed into while the reviewer reviews, asks for a permission.
  const impl = w('needs_input', false, { status: 'in_progress', phase: 'review', runState: 'running' });
  assert.equal(waitingOnSomeone(impl), true);
  assert.equal(shownStatus(impl), 'needs_input');
  // The reviewer at the end of its review, and the implementer finished meanwhile: no wait.
  assert.equal(waitingOnSomeone(w('done', false, { status: 'in_progress', phase: 'review', runState: 'running', role: 'reviewer' })), false);
  assert.equal(waitingOnSomeone(w('done', false, { status: 'in_progress', phase: 'review', runState: 'running' })), false);
  // The reviewer asking during a fix it doesn't run.
  assert.equal(waitingOnSomeone(w('needs_input', false, { status: 'in_progress', phase: 'fix', runState: 'running', role: 'reviewer' })), true);
});

test('a stopped run waits on someone and alerts (a teammate may have pressed Stop)', () => {
  const steps = [
    w('working', true, { status: 'in_progress', phase: 'implement', runState: 'running' }),
    w('working', true, { status: 'in_progress', phase: 'implement', runState: 'stopping' }),
    w('done', false, { status: 'in_progress', phase: 'implement', runState: 'stopping' }),
    w('done', false, { status: 'waiting', waitingReason: 'stopped', runState: 'idle' }),
  ];
  assert.deepEqual(alertsOver(steps), [3]);
});

test('the webhook posts a question in review, and a stopped run', (t) => {
  const { h, alerts, tick } = hook(t);
  h.onWorker(w('working', true, { status: 'review' }));
  h.onWorker(w('needs_input', false, { status: 'review' }));
  tick(5_000);
  assert.deepEqual(alerts, ['Ada:needs_input']);
  h.onWorker(w('working', true, { status: 'in_progress', phase: 'implement', runState: 'stopping' }));
  h.onWorker(w('done', false, { status: 'in_progress', phase: 'implement', runState: 'stopping' }));
  h.onWorker(w('done', false, { status: 'waiting', waitingReason: 'stopped', runState: 'idle' }));
  tick(6_000);
  assert.deepEqual(alerts, ['Ada:needs_input', 'Ada:done']);
});

/** A webhook whose worker alerts are counted instead of posted; the clock is the test's. */
function hook(t: import('node:test').TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const h = new Webhook('/nonexistent', () => 'Proj', () => {});
  const alerts: string[] = [];
  (h as unknown as { alert: (x: WorkerInfo, s: string) => void }).alert = (x, s) => void alerts.push(`${x.name}:${s}`);
  return { h, alerts, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('the webhook stays quiet while the engine hands a task between steps', (t) => {
  const { h, alerts, tick } = hook(t);
  const steps = [
    w('working', true, { status: 'in_progress', phase: 'plan', runState: 'running' }),
    w('needs_input', false, { status: 'in_progress', phase: 'plan', runState: 'running' }),
    w('working', true, { status: 'in_progress', phase: 'implement', runState: 'running' }),
    w('done', false, { status: 'in_progress', phase: 'implement', runState: 'running' }),
    w('done', false, { status: 'in_progress', phase: 'review', runState: 'running' }),
    w('done', false, { status: 'review' }),
  ];
  for (const s of steps) {
    h.onWorker(s);
    // The engine announces the task ready for review itself, just after the summary that moves it there.
    if (s.kanban?.status === 'review') h.announce('🗂️ #14 is ready for review', undefined, 14);
    tick(6_000);
  }
  assert.deepEqual(alerts, []);
});

test('the webhook skips a plan waiting for approval that the engine announced', (t) => {
  const { h, alerts, tick } = hook(t);
  h.onWorker(w('working', true, { status: 'in_progress', phase: 'plan', runState: 'running' }));
  h.onWorker(w('needs_input', false, { status: 'in_progress', phase: 'plan', runState: 'running' }));
  h.onWorker(w('needs_input', false, { status: 'waiting', phase: 'plan', waitingReason: 'plan_approval', runState: 'idle' }));
  h.announce('🗂️ #14 needs plan approval', undefined, 14);
  tick(6_000);
  assert.deepEqual(alerts, []);
});

test('the webhook posts a run in Review the engine never announces (Fix PRs), once', (t) => {
  const { h, alerts, tick } = hook(t);
  // Announced when it came to Review, long before.
  h.announce('🗂️ #14 is ready for review', undefined, 14);
  tick(60_000);
  h.onWorker(w('done', true, { status: 'review' }));
  h.onWorker(w('working', true, { status: 'review', phase: 'pr-fix', runState: 'running' }));
  h.onWorker(w('done', false, { status: 'review', phase: 'pr-fix', runState: 'idle' }));
  tick(6_000);
  assert.deepEqual(alerts, ['Ada:done']);
  // Another task's announcement doesn't count for this one.
  h.onWorker(w('working', true, { status: 'review', phase: 'pr-fix', runState: 'running' }));
  h.onWorker(w('done', false, { status: 'review', phase: 'pr-fix', runState: 'idle' }));
  h.announce('🗂️ #15 is ready for review', undefined, 15);
  tick(6_000);
  assert.deepEqual(alerts, ['Ada:done', 'Ada:done']);
});

test('the webhook posts once when a task worker asks, and not for a worker that was handled', (t) => {
  const { h, alerts, tick } = hook(t);
  h.onWorker(w('working', true, { status: 'in_progress', phase: 'implement', runState: 'running' }));
  h.onWorker(w('needs_input', false, { status: 'in_progress', phase: 'implement', runState: 'running' }));
  h.onWorker(w('needs_input', false, { status: 'waiting', waitingReason: 'agent_asking', runState: 'idle' }));
  tick(5_000);
  assert.deepEqual(alerts, ['Ada:needs_input']);
  // Back to work before the settle time: nothing.
  h.onWorker(w('working', true));
  h.onWorker(w('needs_input', false));
  h.onWorker(w('working', true));
  tick(6_000);
  assert.deepEqual(alerts, ['Ada:needs_input']);
});

/** The alerts the client raises over a worker's snapshots: one whenever it goes from not waiting to waiting. */
function alertsOver(steps: WorkerInfo[]): number[] {
  const out: number[] = [];
  let before: boolean | undefined;
  steps.forEach((s, i) => {
    const now = waitingOnSomeone(s);
    if (shouldAlert(before, now)) out.push(i);
    before = now;
  });
  return out;
}

test('shouldAlert: only a step from not waiting to waiting, never on first sight', () => {
  assert.equal(shouldAlert(undefined, true), false);
  assert.equal(shouldAlert(false, true), true);
  assert.equal(shouldAlert(true, true), false);
  assert.equal(shouldAlert(true, false), false);
});

test('alerts: the engine\'s handovers stay quiet and the real wait alerts once', () => {
  const run = (phase: string) => ({ status: 'in_progress', phase, runState: 'running' }) as Partial<KanbanWorkerSummary>;
  const steps = [
    w('needs_input', false, run('plan')),
    w('working', true, run('implement')),
    w('done', false, run('implement')),
    w('done', false, { ...run('review'), round: 1 } as Partial<KanbanWorkerSummary>),
    w('done', false, run('fix')),
    w('done', false, { status: 'review', runState: 'idle' }),
  ];
  assert.deepEqual(alertsOver(steps), [5]);
  // The status first, the task's summary a moment later.
  assert.deepEqual(
    alertsOver([
      w('working', true, run('plan')),
      w('needs_input', false, run('plan')),
      w('needs_input', false, { status: 'waiting', waitingReason: 'plan_approval', runState: 'idle' }),
    ]),
    [2],
  );
  // First sight of a waiting worker: no alert.
  assert.deepEqual(alertsOver([w('needs_input', false, { status: 'waiting', waitingReason: 'agent_asking' })]), []);
});

/** The kanban's side of the worker manager over its workers, its updates counted. */
class Workers extends KanbanWorkers {
  readonly workers = new Map<string, Worker>();
  updates = 0;
  protected emitUpdate() {
    this.updates++;
  }
  protected setStatus() {}
  resume() {
    return undefined;
  }
}

test('setKanbanSummary: a task reaching Review is a new wait, even if its worker was looked at before', () => {
  const m = new Workers();
  // Looked at when the implementation ended, nobody watching now.
  const info = w('done', true, { status: 'in_progress', phase: 'review', runState: 'running' }, { waitingSince: 1 });
  m.workers.set('w1', { info, viewers: new Map() } as unknown as Worker);
  m.setKanbanSummary('w1', { taskId: 14, role: 'implementer', status: 'review', runState: 'idle' });
  assert.equal(info.acked, false);
  assert.ok(info.waitingSince! > 1);
  assert.equal(waitingOnSomeone(info), true);
  assert.equal(m.updates, 1);
  // Someone watching as it arrives has seen it.
  const watched = w('done', true, { status: 'in_progress', phase: 'review', runState: 'running' }, { id: 'w2', waitingSince: 1 });
  m.workers.set('w2', { info: watched, viewers: new Map([['c1', 'Bo']]) } as unknown as Worker);
  m.setKanbanSummary('w2', { taskId: 14, role: 'implementer', status: 'review', runState: 'idle' });
  assert.equal(watched.acked, true);
  // A later change within the same wait resets nothing.
  info.acked = true;
  const since = info.waitingSince;
  m.setKanbanSummary('w1', { taskId: 14, role: 'implementer', status: 'review', runState: 'idle', round: 2 });
  assert.equal(info.acked, true);
  assert.equal(info.waitingSince, since);
});

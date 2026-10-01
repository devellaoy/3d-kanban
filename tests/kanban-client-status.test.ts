// 3d-kanban: a kanban worker whose run is still going shows as working, not done (src/client/kanban/status.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { shownWorker } from '../src/client/kanban/status.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (over: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: 'w1', deskId: 'd1', name: 'Ada', color: '#fff', status: 'done', acked: false, createdBy: 'u', createdAt: 1, ...over }) as WorkerInfo;
const kanban = (runState: 'idle' | 'running' | 'queued') => ({ taskId: 1, role: 'implementer' as const, runState });

test('done while the run is running shows as working and keeps workingSince from before', () => {
  const shown = shownWorker(worker({ kanban: kanban('running') }), worker({ status: 'working', workingSince: 1234 }));
  assert.equal(shown.status, 'working');
  assert.equal(shown.workingSince, 1234);
});

test('done while the run is running with nothing before starts the timer now', () => {
  const before = Date.now();
  const shown = shownWorker(worker({ kanban: kanban('running') }));
  assert.equal(shown.status, 'working');
  assert.ok(shown.workingSince! >= before);
});

test('its own workingSince wins over the previous one', () => {
  assert.equal(shownWorker(worker({ kanban: kanban('running'), workingSince: 5 }), worker({ workingSince: 9 })).workingSince, 5);
});

test('done with an idle run stays done', () => {
  const w = worker({ kanban: kanban('idle') });
  assert.equal(shownWorker(w), w);
});

test('needs_input while running is unchanged', () => {
  const w = worker({ status: 'needs_input', kanban: kanban('running') });
  assert.equal(shownWorker(w), w);
});

test('a worker without a kanban task is unchanged', () => {
  const w = worker();
  assert.equal(shownWorker(w), w);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOf } from '../src/server/kanban/handoff.js';
import type { KanbanTask } from '../src/shared/kanban/types.js';

test('taskOf gives the floor and tags of a task, and nothing for one that is not there', () => {
  const repo = { getTask: (id: number) => (id === 4 ? ({ id, project: 'floor-1', tags: ['meeting:abcdef01', 'x'] } as KanbanTask) : undefined) };
  assert.deepEqual(taskOf(repo, 4), { project: 'floor-1', tags: ['meeting:abcdef01', 'x'] });
  assert.equal(taskOf(repo, 5), undefined);
});

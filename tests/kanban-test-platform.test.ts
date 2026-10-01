import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskNamer } from '../src/server/tasks.js';

test('synchronous namer launch failures preserve fallback labels and enter backoff', async () => {
  let named = 0;
  // A NUL causes spawn to throw synchronously on every platform.
  const namer = new TaskNamer('invalid\0command', {}, () => 'Name the task', () => { named++; });
  for (const id of ['a', 'b', 'c']) namer.request(id, { prompts: ['Fix login'], tools: [], epoch: 0 });
  const deadline = Date.now() + 3000;
  while (namer.enabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(named, 0);
  assert.equal(namer.enabled, false, 'three failed launches trigger the ordinary failure backoff');
});

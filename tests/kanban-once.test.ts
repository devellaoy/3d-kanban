import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnce } from '../src/server/kanban/once.js';
import type { KanbanCaller } from '../src/server/kanban/registry.js';

const ada: KanbanCaller = { clientId: 'c1', accountId: 'acc-ada', name: 'Ada', admin: false };
const bob: KanbanCaller = { clientId: 'c2', accountId: 'acc-bob', name: 'Bob', admin: false };
const KEY = 'key-12345678';

test('the same caller and key make once; a repeat gets the first answer', async () => {
  const once = createOnce();
  let made = 0;
  const make = async () => ({ id: ++made });
  const first = await once.run(ada, KEY, make);
  // A reconnect changes the clientId, not the account.
  const second = await once.run({ ...ada, clientId: 'c9' }, KEY, make);
  assert.deepEqual(first, { value: { id: 1 }, repeated: false });
  assert.deepEqual(second, { value: { id: 1 }, repeated: true });
  assert.equal(made, 1);
});

test('a repeat that arrives while the first is still running shares its answer', async () => {
  const once = createOnce();
  let made = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const make = async () => {
    made++;
    await gate;
    return { id: 7 };
  };
  const a = once.run(ada, KEY, make);
  const b = once.run(ada, KEY, make);
  release();
  assert.deepEqual(await a, { value: { id: 7 }, repeated: false });
  assert.deepEqual(await b, { value: { id: 7 }, repeated: true });
  assert.equal(made, 1);
});

test('other callers and other keys do not share', async () => {
  const once = createOnce();
  let made = 0;
  const make = async () => ++made;
  assert.equal((await once.run(ada, KEY, make)).value, 1);
  assert.equal((await once.run(bob, KEY, make)).value, 2);
  assert.equal((await once.run(ada, 'other-key-1234', make)).value, 3);
  // A caller without an account is told apart by name.
  assert.equal((await once.run({ name: 'Eve', admin: false }, KEY, make)).value, 4);
  assert.equal((await once.run({ name: 'Zed', admin: false }, KEY, make)).value, 5);
});

test('a refusal or a throw is forgotten at once, so the form can be sent again', async () => {
  const once = createOnce();
  let n = 0;
  assert.deepEqual(await once.run(ada, KEY, async () => `no ${++n}`), { value: 'no 1', repeated: false });
  assert.deepEqual(await once.run(ada, KEY, async () => `no ${++n}`), { value: 'no 2', repeated: false });
  await assert.rejects(once.run(ada, KEY, async () => Promise.reject(new Error('boom'))), /boom/);
  assert.deepEqual(await once.run(ada, KEY, async () => ({ id: 1 })), { value: { id: 1 }, repeated: false });
  assert.deepEqual(await once.run(ada, KEY, async () => ({ id: 2 })), { value: { id: 1 }, repeated: true });
});

test('without a key it runs every time', async () => {
  const once = createOnce();
  let made = 0;
  const make = async () => ++made;
  assert.equal((await once.run(ada, undefined, make)).value, 1);
  assert.equal((await once.run(ada, undefined, make)).value, 2);
});

test('a made answer expires after it settled, and the oldest go when there are too many', async () => {
  const short = createOnce(5);
  let made = 0;
  const make = async () => ++made;
  await short.run(ada, KEY, make);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await short.run(ada, KEY, make)).value, 2, 'dropped after its time');

  const small = createOnce(60_000, 2);
  made = 0;
  await small.run(ada, 'key-aaaaaaaa', make);
  await small.run(ada, 'key-bbbbbbbb', make);
  await small.run(ada, 'key-cccccccc', make);
  assert.equal((await small.run(ada, 'key-bbbbbbbb', make)).repeated, true);
  assert.equal((await small.run(ada, 'key-aaaaaaaa', make)).repeated, false, 'the oldest was dropped');
});

test('a repeat that asks for something else than the first is marked changed', async () => {
  const once = createOnce();
  const make = async () => ({ id: 1 });
  await once.run(ada, KEY, make, 'issue\napp\ngh:o/app#1');
  assert.deepEqual(await once.run(ada, KEY, make, 'issue\napp\ngh:o/app#1'), { value: { id: 1 }, repeated: true });
  assert.deepEqual(await once.run(ada, KEY, make, 'issue\napp\ngh:o/app#2'), { value: { id: 1 }, repeated: true, changed: true });
  assert.deepEqual(await once.run(ada, KEY, make, 'task\napp'), { value: { id: 1 }, repeated: true, changed: true });
});

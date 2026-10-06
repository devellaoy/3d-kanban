// What carrying on after a restart keeps of a worker (workers/carryon.ts): the cut-off that serves once, a carry-on whose process
// died before it took the prompt, one that is dropped and when that is forgotten, and the admins-only setting handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CarryOn, carries, reached, restoredNote, setCarryOn, validCutOff } from '../src/server/workers/carryon.js';
import { settingsHandlers } from '../src/server/ws/handlers/settings.js';
import type { Worker } from '../src/server/workers/types.js';

const agent = (more: Partial<Worker> = {}, info: Record<string, unknown> = {}) => ({ info: { id: 'w', kind: 'agent', sessionId: 's', status: 'exited', ...info }, ...more }) as unknown as Worker;

function office(workers: Worker[], enabled = true) {
  const resumed: string[] = [];
  const host = { workers: new Map(workers.map((w) => [w.info.id, w])), resume: (id: string) => (resumed.push(id), undefined), enabled: () => enabled, hiringPaused: () => undefined, closing: () => false, staggerMs: () => 0 };
  return { carry: new CarryOn(host), resumed };
}

test('a flag taken away leaves nothing behind', () => {
  const w = agent();
  setCarryOn(w, { cutOff: 'working', hostLost: true });
  setCarryOn(w, { cutOff: undefined, hostLost: undefined });
  assert.equal(w.carryOn, undefined);
});

test('the cut-off serves once: the worker working clears it, and a carry-on that was sent or dropped', () => {
  const w = agent({ interrupted: true });
  setCarryOn(w, { cutOff: 'starting', state: 'dropped', reason: 'x' });
  reached(w);
  assert.equal(w.carryOn, undefined);
  assert.equal(w.interrupted, false);
});

test("a carry-on whose process exited before it took the prompt is dropped with a reason, not resumed without a prompt", () => {
  const w = agent({ interrupted: true });
  const { carry, resumed } = office([w]);
  assert.equal(carry.start(w, undefined), true);
  assert.equal(w.carryOn?.state, 'sent');
  assert.equal(carries(w, true), false, 'not prompted twice');
  carry.wakeAll(); // at runtime, when someone walks in
  assert.deepEqual(resumed, ['w']);
  assert.deepEqual([w.carryOn?.state, w.carryOn?.reason], ['dropped', 'its process exited before it took the carry-on prompt']);
  assert.equal(w.interrupted, false);
});

test("a task's worker is not dropped, nor does its start say it carries on by itself", () => {
  const w = agent({ interrupted: true, carryOn: { state: 'sent' } }, { kanban: { taskId: 1, role: 'implementer' } });
  const { carry } = office([w]);
  carry.wakeAll();
  assert.notEqual(w.carryOn?.state, 'dropped');
  assert.equal(restoredNote(agent({ carryOn: { state: 'sent' } }, { kanban: { taskId: 1, role: 'implementer' } })).includes('by itself'), false);
  assert.equal(restoredNote(agent({ carryOn: { state: 'sent' } })).includes('by itself'), true);
});

test('a fresh session after a plain resume gives up nothing; one after a carry-on does, until the worker works', () => {
  const plain = agent({ interrupted: false });
  const { carry } = office([plain]);
  carry.sessionLost(plain, 'gone');
  assert.equal(plain.carryOn, undefined);
  const carrying = agent({ interrupted: true, carryOn: { state: 'sent' } });
  carry.sessionLost(carrying, 'gone');
  assert.deepEqual([carrying.carryOn?.state, carrying.carryOn?.reason], ['dropped', 'gone']);
  reached(carrying);
  assert.equal(carrying.carryOn, undefined, 'forgotten once it works');
});

test('an older workers.json (cutOff and midTurn only) restores a cut-off, and nonsense is no status', () => {
  assert.equal(validCutOff('working'), 'working');
  assert.equal(validCutOff({}), undefined);
  assert.equal(validCutOff(undefined), undefined);
});

test('only admins change whether workers carry on after a restart', () => {
  const set: boolean[] = [];
  const warned: string[] = [];
  const ctx = (admin: boolean) => ({ carryOn: { on: true, set: (on: boolean) => set.push(on) }, meOfClient: () => ({ admin }), warn: (_c: unknown, text: string) => warned.push(text), toastAll() {} }) as never;
  const c = { peer: { name: 'Ada' } } as never;
  settingsHandlers['carryOn.set'](ctx(false), c, { t: 'carryOn.set', on: false });
  assert.deepEqual(set, []);
  assert.match(warned[0], /Only admins/);
  settingsHandlers['carryOn.set'](ctx(true), c, { t: 'carryOn.set', on: false });
  assert.deepEqual(set, [false]);
});

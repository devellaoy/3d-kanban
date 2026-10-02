// The phone: following another floor's workers (server/phone/handlers.ts), and what a visitor may do with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneHandlers, phoneHooks } from '../src/server/phone/handlers.js';
import { filterForVisitor, visitorMay, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Client } from '../src/server/office/client.js';
import type { Floor } from '../src/server/floor.js';
import type { ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

const worker = (id: string, extra: Partial<WorkerInfo> = {}) => ({ id, name: id, title: 'x', status: 'idle', ...extra }) as unknown as WorkerInfo;

function office() {
  const sent: { to: string; msg: ServerMsg }[] = [];
  const floors = new Map<string, Floor>();
  const make = (id: string, workers: WorkerInfo[]) => {
    const f = { id, workers: { list: () => workers }, project: { id, name: id, dir: '/d' } } as unknown as Floor;
    floors.set(id, f);
    return f;
  };
  const ctx = { floors, workerListeners: [], sendTo: (c: Client, msg: ServerMsg) => sent.push({ to: c.id, msg }) } as unknown as Ctx;
  const person = (id: string, floor?: string) => ({ id, peer: { floor } }) as unknown as Client;
  const change = (f: Floor, w: WorkerInfo | string) => ctx.workerListeners.forEach((fn) => fn(f, w));
  const watch = (c: Client, floor: string | null) => phoneHandlers['phone.watch'](ctx, c, { t: 'phone.watch', floor });
  return { ctx, sent, make, person, change, watch };
}
const types = (o: ReturnType<typeof office>, to: string) => o.sent.filter((s) => s.to === to).map((s) => s.msg.t);

test('watching a floor sends its workers and project at once', () => {
  const o = office();
  o.make('a', [worker('w1')]);
  o.watch(o.person('p', 'b'), 'a');
  const m = o.sent[0]!.msg as Extract<ServerMsg, { t: 'phone.floor' }>;
  assert.equal(m.t, 'phone.floor');
  assert.equal(m.floor, 'a');
  assert.deepEqual(m.workers.map((w) => w.id), ['w1']);
  assert.equal(m.project?.id, 'a');
});

test('any change reaches the watcher, a title alone included, and a worker going home too', () => {
  const o = office();
  const a = o.make('a', []);
  o.watch(o.person('p', 'b'), 'a');
  o.sent.length = 0;
  o.change(a, worker('w1', { title: 'new title' }));
  o.change(a, 'w1');
  assert.deepEqual(o.sent.map((s) => s.msg), [
    { t: 'phone.worker', floor: 'a', worker: worker('w1', { title: 'new title' }) },
    { t: 'phone.workerRemove', floor: 'a', workerId: 'w1' },
  ]);
});

test('someone standing on the watched floor gets no duplicates', () => {
  const o = office();
  const a = o.make('a', []);
  const here = o.person('h', 'a');
  o.watch(here, 'a');
  o.sent.length = 0;
  o.change(a, worker('w1'));
  assert.deepEqual(types(o, 'h'), []);
});

test('null stops, and an unknown floor stops too', () => {
  const o = office();
  const a = o.make('a', []);
  const p = o.person('p', 'b');
  o.watch(p, 'a');
  o.watch(p, null);
  o.sent.length = 0;
  o.change(a, worker('w1'));
  assert.deepEqual(o.sent, []);
  o.watch(p, 'a');
  o.watch(p, 'nope');
  o.sent.length = 0;
  o.change(a, worker('w1'));
  assert.deepEqual(o.sent, []);
});

test('switching floors replaces the watch', () => {
  const o = office();
  const a = o.make('a', []);
  const b = o.make('b', []);
  const p = o.person('p', 'c');
  o.watch(p, 'a');
  o.watch(p, 'b');
  o.sent.length = 0;
  o.change(a, worker('w1'));
  assert.deepEqual(o.sent, []);
  o.change(b, worker('w2'));
  assert.deepEqual(types(o, 'p'), ['phone.worker']);
});

test('a person who left the office is no longer sent anything', () => {
  const o = office();
  const a = o.make('a', []);
  const p = o.person('p', 'b');
  o.watch(p, 'a');
  phoneHooks.closed!(o.ctx, p);
  o.sent.length = 0;
  o.change(a, worker('w1'));
  assert.deepEqual(o.sent, []);
});

// ---- Multiplayer ------------------------------------------------------------------------------------

const scope: VisitorScope = { login: 'vera', floors: new Set(['shared']), projects: new Set(['shared']) };

test('a visitor may watch only a floor in scope (or stop)', () => {
  assert.equal(visitorMay({ t: 'phone.watch', floor: 'shared' }, scope), true);
  assert.equal(visitorMay({ t: 'phone.watch', floor: null }, scope), true);
  assert.equal(visitorMay({ t: 'phone.watch', floor: 'secret' }, scope), false);
  assert.equal(visitorMay({ t: 'phone.watch' }, scope), false);
  assert.equal(visitorMay({ t: 'phone.watch', floor: 7 }, scope), false);
});

test('a visitor gets phone frames only for floors in scope, and only the workers they may see', () => {
  const across = worker('w2', { repos: [{ floor: 'secret', name: 'api', dir: '/home/owner/api', path: 'p', branch: 'b' }] } as Partial<WorkerInfo>);
  const f = (m: ServerMsg) => filterForVisitor(m, scope);
  const snap = f({ t: 'phone.floor', floor: 'shared', workers: [worker('w1'), across], project: { id: 'shared', name: 's', dir: '/x', agentCmd: 'c' } as never }) as Extract<ServerMsg, { t: 'phone.floor' }>;
  assert.deepEqual(snap.workers.map((w) => w.id), ['w1']);
  assert.equal(snap.project?.dir, '');
  assert.equal(f({ t: 'phone.floor', floor: 'secret', workers: [], project: null }), undefined);
  assert.equal(f({ t: 'phone.worker', floor: 'secret', worker: worker('w1') }), undefined);
  assert.equal(f({ t: 'phone.worker', floor: 'shared', worker: across }), undefined);
  assert.ok(f({ t: 'phone.worker', floor: 'shared', worker: worker('w1') }));
  assert.equal(f({ t: 'phone.workerRemove', floor: 'secret', workerId: 'w1' }), undefined);
  assert.ok(f({ t: 'phone.workerRemove', floor: 'shared', workerId: 'w1' }));
});

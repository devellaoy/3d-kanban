// A visitor from another office is a Client of its own kind: never an admin, never signed out by the
// heartbeat, and only allowed what the inbound gate says. These run on the real people/messaging/
// timers/dispatch code with a RemoteSocket and a stub office; tests/multiplayer-e2e.test.ts does it with real offices.
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, type Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { messaging } from '../src/server/office/messaging.js';
import { people } from '../src/server/office/people.js';
import { startTimers } from '../src/server/office/timers.js';
import { RemoteSocket } from '../src/server/multiplayer/remote-socket.js';
import { visitorAllows } from '../src/server/multiplayer/gate.js';
import { dispatch } from '../src/server/ws/dispatch.js';
import type { VisitorScope } from '../src/shared/multiplayer/allow.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

const scope: VisitorScope = { login: 'vera', floors: new Set(['web']), projects: new Set(['web']) };
const peer = (id: string) => ({ id, name: '@vera', color: '#4f86f7', look: { skin: 0, hair: 0, style: 0 }, x: 0, y: 0, z: 0, rotY: 0, moving: false, voice: false, muted: true, sharing: false, floor: 'web' });

/** An office with just the parts under test; the visitor's frames land in `sent` (what survived the filter). */
function office(sharedPassword = false) {
  const state = { up: true };
  const ctx = {} as Ctx;
  const sent: ServerMsg[] = [];
  const accounts = { get: () => undefined, sharedPassword, state: () => ({ accounts: [] }) };
  Object.assign(ctx, { clients: new Map<string, Client>(), accounts }, messaging(ctx), people(ctx));
  const sock = new RemoteSocket(
    { frame: (data) => (sent.push(JSON.parse(data)), true), up: () => state.up, bufferedAmount: () => 0, closed: () => {} },
    scope,
    {},
  );
  const visitor = newClient('v1', sock.asWebSocket(), { accountId: undefined, admin: false }, peer('v1'));
  visitor.visitor = scope;
  sock.on('pong', () => (visitor.isAlive = true)); // as onConnection does
  ctx.clients.set(visitor.id, visitor);
  return { ctx, sent, sock, visitor, state };
}

afterEach(() => mock.timers.reset());

test('a visitor survives the heartbeat: not an admin, not told about accounts, not signed out', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { ctx, sent, sock, visitor } = office(false); // the shared password is off, which signs out every accountless guest
  const stop = startTimers(ctx);
  for (let beat = 0; beat < 3; beat++) {
    mock.timers.tick(20_000);
    await new Promise((r) => setImmediate(r)); // the adapter's pong
    assert.equal(visitor.isAlive, true, 'the adapter answered the ping');
  }
  ctx.accountsChanged();
  stop();
  assert.equal(visitor.admin, false);
  assert.equal(visitor.out, undefined, 'not signed out (4001)');
  assert.equal(sock.readyState, 1, 'the socket was not closed or terminated');
  assert.deepEqual(sent.filter((m) => m.t === 'accounts' || m.t === 'me'), []);
  assert.deepEqual(ctx.meOfClient(visitor), { admin: false, visitor: true });
  // The same guest without the visitor mark is an admin on the shared password: why they need a kind of their own.
  assert.equal(ctx.meOf(undefined).admin, true);
});

test('the heartbeat still ends a visitor whose link is down', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { ctx, sock, visitor, state } = office(true);
  const stop = startTimers(ctx);
  let closed = false;
  sock.on('close', () => (closed = true));
  state.up = false; // no pong can come back
  mock.timers.tick(20_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(visitor.isAlive, false);
  mock.timers.tick(20_000);
  stop();
  assert.equal(closed, true, 'terminated like any dead connection');
});

test('the gate refuses what a visitor may not do, and lets them chat and draw', () => {
  const { ctx, visitor } = office();
  const warned: string[] = [];
  ctx.warn = (_c, text) => void (text && warned.push(text));
  ctx.workerFloor = () => undefined;
  const denied: unknown[] = [
    { t: 'worker.spawn', floor: 'web' },
    { t: 'queue.add', text: 'x' },
    { t: 'gh.comment', number: 1, body: 'hi' },
    { t: 'kanban.task.create', project: 'web', title: 'x' },
    { t: 'kanban.subscribe', project: null },
    { t: 'kanban.subscribe', project: 'secret' },
    { t: 'floor.go', floor: 'secret' },
    { t: 'mp.share', floor: 'web', on: true },
    { t: 'constructor' },
    { t: ['chat'] },
    { t: 'kanban.made.up' },
  ];
  for (const msg of denied) {
    warned.length = 0;
    dispatch(ctx, visitor, msg as ClientMsg);
    assert.deepEqual(warned, ['Read-only visit'], JSON.stringify(msg));
  }
  const allowed: unknown[] = [{ t: 'chat', text: 'hello' }, { t: 'wb.update', elements: [] }, { t: 'move', x: 1, y: 0, z: 1, rotY: 0 }, { t: 'kanban.subscribe', project: 'web' }, { t: 'floor.go', floor: 'web' }];
  for (const msg of allowed) assert.equal(visitorAllows(ctx, visitor, msg as ClientMsg), true, JSON.stringify(msg));
  // Not a visitor: nothing here to stop them.
  assert.equal(visitorAllows(ctx, { ...visitor, visitor: undefined }, { t: 'worker.spawn' } as ClientMsg), true);
});

test('what the office sends a visitor is filtered, and a closed visitor hears nothing', () => {
  const { sent, sock, ctx, visitor } = office();
  ctx.sendTo(visitor, { t: 'chat', msg: { id: 1, from: 'Ada', text: 'hi', at: 1 } } as unknown as ServerMsg);
  ctx.sendTo(visitor, { t: 'accounts', state: {} } as unknown as ServerMsg);
  ctx.sendTo(visitor, { t: 'toast', text: 'Sam took secret-repo off the building', level: 'info' });
  ctx.broadcast({ t: 'floors', floors: [{ id: 'web', name: 'web', dir: '/home/me/web' }, { id: 'secret', name: 'secret-repo', dir: '/x' }] } as unknown as ServerMsg);
  assert.deepEqual(sent.map((m) => m.t), ['chat', 'floors']);
  assert.ok(!JSON.stringify(sent).includes('secret'));
  assert.ok(!JSON.stringify(sent).includes('/home/me'));
  sock.end('bye', false);
  ctx.sendTo(visitor, { t: 'chat', msg: { id: 2, from: 'Ada', text: 'hi', at: 1 } } as unknown as ServerMsg);
  assert.equal(sent.length, 2);
});

test('terminal and diff frames reach a visitor only while their worker is on a floor in scope', () => {
  const { sent, ctx } = office();
  const floors: Record<string, string> = { w1: 'web', w2: 'vault' };
  const sock = (lookup: boolean) => {
    const out: ServerMsg[] = [];
    const s = new RemoteSocket({ frame: (d) => (out.push(JSON.parse(d)), true), up: () => true, bufferedAmount: () => 0, closed: () => {} }, scope, lookup ? { workerFloors: (id) => (floors[id] ? [floors[id]] : undefined) } : {});
    return { s, out };
  };
  const frames = (id: string): ServerMsg[] => [
    { t: 'term.data', workerId: id, data: 'x' },
    { t: 'term.snapshot', workerId: id, data: 'x', cols: 1, rows: 1 },
    { t: 'screen', workerId: id, cols: 1, rows: 1, lines: {}, full: true, cursor: [0, 0] },
    { t: 'changes.diff', workerId: id, path: 'a', diff: '', truncated: false },
    { t: 'changes', state: { workerId: id } as never },
  ];
  const { s, out } = sock(true);
  for (const id of ['w1', 'w2', 'nobody']) for (const m of frames(id)) s.send(JSON.stringify(m));
  assert.deepEqual(out.map((m) => m.t), ['term.data', 'term.snapshot', 'screen', 'changes.diff', 'changes'], 'only w1 (floor web) came through');
  const none = sock(false);
  for (const m of frames('w1')) none.s.send(JSON.stringify(m));
  assert.deepEqual(none.out, [], 'no lookup: deny by default');
  void sent;
  void ctx;
});

test('a visitor keeps their @login name, and may only call people they can see', () => {
  const { ctx, visitor } = office();
  const heard: Record<string, ServerMsg[]> = {};
  const person = (id: string, floor: string, v?: VisitorScope) => {
    const c = newClient(id, { readyState: 1, bufferedAmount: 0, send: (d: string) => (heard[id] ??= []).push(JSON.parse(d)) } as never, { accountId: undefined, admin: false }, { ...peer(id), floor });
    if (v) c.visitor = v;
    ctx.clients.set(id, c);
  };
  person('near', 'web');
  person('far', 'vault');
  person('other', 'web', { login: 'sam', floors: new Set(['web']), projects: new Set(['web']) });
  person('away', 'vault', { login: 'amy', floors: new Set(['vault']), projects: new Set(['vault']) });
  for (const to of ['near', 'far', 'other', 'away']) dispatch(ctx, visitor, { t: 'rtc', to, data: {} } as ClientMsg);
  assert.deepEqual(Object.keys(heard).sort(), ['away', 'near', 'other'], 'not the owner\'s people on floors outside the scope; other visitors yes');

  dispatch(ctx, visitor, { t: 'profile', name: 'Boss', color: '#00ff00', look: { skin: 1, hair: 1, style: 1 } } as ClientMsg);
  assert.equal(visitor.peer.name, '@vera');
  assert.equal(visitor.peer.color, '#00ff00', 'colours and look are still theirs');
});

test('what shows of an owner on another floor leaves out the seat and the reading', async () => {
  const { filterForVisitor } = await import('../src/shared/multiplayer/allow.js');
  const out = filterForVisitor({ t: 'peer.update', peer: { ...peer('o'), floor: 'vault', seat: 'couch:1', reading: true, doing: 'x' } } as ServerMsg, scope);
  assert.ok(out && out.t === 'peer.update');
  assert.deepEqual([out.peer.floor, out.peer.seat, out.peer.reading, out.peer.doing], [undefined, undefined, undefined, undefined]);
});

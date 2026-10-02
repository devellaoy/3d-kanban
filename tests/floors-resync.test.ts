import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ctx } from '../src/server/office/context.js';
import { floorHelpers } from '../src/server/office/floors.js';
import { floorHandlers } from '../src/server/ws/handlers/floors.js';
import type { Client } from '../src/server/office/client.js';

/** A minimal office: no opened floors, a building whose order the fake moves by hand, a collector of broadcasts. */
function office() {
  let order = ['a', 'b'];
  const sent: string[][] = [];
  const def = (id: string) => ({ id, name: id, dir: `/x/${id}`, palette: 0, addedBy: 'x', addedAt: 0 });
  const ctx = {
    floors: new Map(),
    building: {
      list: () => order.map(def),
      // Floors still being cloned are listed in order too, which puts the order into floorInfos().
      pending: () => order.map(def),
      isLocal: () => false,
      moveFloor(id: string, above: string | null) {
        if (!order.includes(id)) return { err: 'No such floor' };
        const rest = order.filter((x) => x !== id);
        const at = above === null ? rest.length : rest.indexOf(above);
        order = [...rest.slice(0, at), id, ...rest.slice(at)];
        return { changed: true };
      },
    },
    broadcast: (m: { t: string; floors?: { id: string }[] }) => void (m.t === 'floors' && sent.push(m.floors!.map((f) => f.id))),
    meOfClient: () => ({ admin: true }),
    warn: () => {},
    clients: new Map(),
    sendTo: () => {},
  } as unknown as Ctx;
  Object.assign(ctx, floorHelpers(ctx));
  const admin = { peer: { name: 'Ann' } } as unknown as Client;
  const move = (floor: string, above: string | null) => (floorHandlers['floor.move'] as (c: Ctx, cl: Client, m: unknown) => void)(ctx, admin, { t: 'floor.move', floor, above });
  return { ctx, sent, move };
}

test('floor.move resends the list when concurrent moves end on the order last sent', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx, sent, move } = office();
  ctx.floorsChanged();
  t.mock.timers.tick(250);
  assert.deepEqual(sent, [['a', 'b']]);
  // Two browsers each move a up (b,a) and one moves it back, inside one window: the server is back at a,b.
  move('a', null); // a to the bottom: b,a
  move('a', 'b'); // back above b: a,b
  t.mock.timers.tick(250);
  assert.equal(sent.length, 2, 'the browser holding its own b,a guess needs the real order again');
  assert.deepEqual(sent[1], ['a', 'b']);
});

test('a refused move also sends the real order back, and a plain change that changes nothing still does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx, sent, move } = office();
  ctx.floorsChanged();
  t.mock.timers.tick(250);
  move('nope', null);
  t.mock.timers.tick(250);
  assert.equal(sent.length, 2);
  ctx.floorsChanged();
  t.mock.timers.tick(250);
  assert.equal(sent.length, 2);
});

test('cancelFloorsChanged drops a pending resend', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx, sent } = office();
  ctx.floorsChanged(true);
  ctx.cancelFloorsChanged();
  t.mock.timers.tick(500);
  assert.equal(sent.length, 0);
  ctx.floorsChanged();
  t.mock.timers.tick(250);
  assert.equal(sent.length, 1);
});

// The lounge figures and the people sitting in the lounge (shared/kanban/lounge.ts): a figure never
// sits on someone, every browser and the server place them the same way, and the server's `sit`
// refuses a place a figure holds (ws/handlers/presence.ts with Kanban.loungeSeat).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoungeSeat, loungeFigureOn, loungePlaces, loungeReservedPlaces, type LoungeFigure } from '../src/shared/kanban/lounge.js';
import { loungeFigures } from '../src/server/kanban/lounge.js';
import { presenceHandlers } from '../src/server/ws/handlers/presence.js';
import { OFFICE_PLAN, planOf } from '../src/shared/maps/index.js';
import { diffLounge, layoutLounge } from '../src/client/kanban/loungemodel.js';

const fig = (taskId: number, at = taskId): LoungeFigure => ({ taskId, title: `Task ${taskId}`, name: `W${taskId}`, color: '#ff0000', at });
const seatOf = (p: ReturnType<typeof loungePlaces>['placed'][number]) => (p.kind === 'seat' ? `${p.seatId}:${p.place}` : 'stand');

test('a seat someone sits on is skipped: the figure takes the next free seat, then a standing place', () => {
  const occupied = new Set(['lounge-beanbag-1:0']);
  assert.deepEqual(loungePlaces(1, occupied).placed.map(seatOf), ['lounge-beanbag-2:0']);
  assert.deepEqual(loungeReservedPlaces(4, occupied), ['lounge-beanbag-2:0', 'couch:0', 'couch:2']);
  assert.equal(loungePlaces(4, occupied).placed[3].kind, 'stand');
  // Every lounge seat taken: the figures all stand, eight of them, and the rest overflow.
  const full = new Set(['lounge-beanbag-1:0', 'lounge-beanbag-2:0', 'couch:0', 'couch:1', 'couch:2']);
  const { placed, overflow } = loungePlaces(9, full);
  assert.deepEqual([placed.length, overflow, placed.every((p) => p.kind === 'stand')], [8, 1, true]);
  // The couch's middle was never a figure's: someone on it changes nothing.
  assert.deepEqual(loungePlaces(4, new Set(['couch:1'])), loungePlaces(4));
});

test('a player seated on beanbag 1, then a hold: the figure appears elsewhere, and moves back once they get up', () => {
  const seated = new Set(['lounge-beanbag-1:0']);
  const withPlayer = layoutLounge([fig(1)], seated).placed;
  assert.deepEqual(withPlayer.map((p) => seatOf(p.place)), ['lounge-beanbag-2:0']);
  const shown = new Map(withPlayer.map((p) => [p.figure.taskId, p]));
  // The player gets up: the same figure only moves (no drop, no new figure).
  const after = diffLounge(shown, layoutLounge([fig(1)], new Set()).placed);
  assert.deepEqual(after.drop, []);
  assert.deepEqual(after.make, []);
  assert.deepEqual(
    after.move.map((p) => seatOf(p.place)),
    ['lounge-beanbag-1:0'],
  );
  // Someone sitting down on a seat no figure has: nothing moves.
  assert.deepEqual(diffLounge(shown, layoutLounge([fig(1)], new Set([...seated, 'couch:2'])).placed), { drop: [], make: [], move: [] });
});

test('isLoungeSeat: the beanbags and the couch ends, nothing else', () => {
  for (const k of ['lounge-beanbag-1:0', 'lounge-beanbag-2:0', 'couch:0', 'couch:2']) assert.ok(isLoungeSeat(k), k);
  for (const k of ['couch:1', 'bench:0', 'boss-chair:0', 'lounge-beanbag-1:1', '']) assert.ok(!isLoungeSeat(k), k);
});

test('loungeFigureOn names the figure on a seat place, around the seats taken', () => {
  const sorted = [fig(1), fig(2)];
  assert.equal(loungeFigureOn(sorted, new Set(), 'lounge-beanbag-1:0')?.taskId, 1);
  assert.equal(loungeFigureOn(sorted, new Set(['lounge-beanbag-1:0']), 'lounge-beanbag-2:0')?.taskId, 1);
  assert.equal(loungeFigureOn(sorted, new Set(['lounge-beanbag-1:0']), 'couch:0')?.taskId, 2);
  assert.equal(loungeFigureOn(sorted, new Set(), 'couch:1'), undefined);
  assert.equal(loungeFigureOn(sorted, new Set(), 'couch:2'), undefined);
});

/** A server context with the office's (or the castle's) map, people on floors and the floor's tasks on hold. */
function office(opts: { plan?: typeof OFFICE_PLAN; furniture?: Record<string, { removed: true }>; held: { id: number; project: string; at: number }[] }) {
  const repo = {
    tasksWhere: () => opts.held.map((h) => ({ id: h.id, project: h.project, title: `Task ${h.id}`, status: 'on_hold', hold: { at: h.at, by: 'x', from: 'waiting', worker: { name: `W${h.id}`, color: '#123456' } } })),
  };
  const clients = new Map<string, { peer: Record<string, unknown> }>();
  const sent: { to: unknown; msg: any }[] = [];
  const asked: string[] = [];
  const ctx = {
    maps: { plan: () => opts.plan ?? OFFICE_PLAN },
    floorOf: () => ({ plan: { furniture: opts.furniture ?? {} } }),
    clients,
    kanban: {
      loungeSeat: (floorId: string, seat: string, occupied: ReadonlySet<string>) => {
        asked.push(seat);
        return loungeFigureOn(loungeFigures(repo as never, floorId), occupied, seat);
      },
    },
    sendTo: (to: unknown, msg: unknown) => sent.push({ to, msg }),
    broadcast: () => {},
  };
  const person = (id: string, floor: string, seat?: string) => {
    const c = { id, peer: { id, name: id, floor, ...(seat ? { seat } : {}) } };
    clients.set(id, c);
    return c;
  };
  const sit = (c: { peer: Record<string, unknown> }, seat?: string) => presenceHandlers.sit(ctx as never, c as never, { t: 'sit', seat } as never);
  return { sent, person, sit, asked };
}

test('sit: a place a figure holds is refused like a taken seat; the couch middle and free places are not', () => {
  const o = office({ held: [{ id: 7, project: 'f1', at: 1 }, { id: 8, project: 'f1', at: 2 }] });
  const ann = o.person('ann', 'f1');
  o.sit(ann, 'lounge-beanbag-1:0');
  assert.equal(ann.peer.seat, undefined);
  assert.equal(o.sent.at(-1)?.msg.t, 'sit.refused');
  assert.equal(o.sent.at(-1)?.msg.seat, 'lounge-beanbag-1:0');
  assert.match(o.sent.at(-1)?.msg.by, /W7.*#7/);
  o.sit(ann, 'lounge-beanbag-2:0');
  assert.equal(ann.peer.seat, undefined, 'the second figure holds beanbag 2');
  o.sit(ann, 'couch:1');
  assert.equal(ann.peer.seat, 'couch:1', 'the couch middle is never a figure’s');
  o.sit(ann, 'couch:0');
  assert.equal(ann.peer.seat, 'couch:0', 'two figures: the couch ends are free');
  // Any other seat (the bench, the boss's chair, the couch middle) never asks the kanban.
  o.sit(ann, 'bench:0');
  assert.equal(ann.peer.seat, 'bench:0');
  assert.deepEqual(o.asked, ['lounge-beanbag-1:0', 'lounge-beanbag-2:0', 'couch:0']);
});

test('sit: figures go round the people already seated, the sitter excluded; another floor and the castle are not checked', () => {
  const o = office({ held: [{ id: 7, project: 'f1', at: 1 }] });
  // Bob sat on beanbag 1 before the hold: the figure took beanbag 2, so beanbag 2 is refused and couch:0 is free.
  o.person('bob', 'f1', 'lounge-beanbag-1:0');
  const ann = o.person('ann', 'f1');
  o.sit(ann, 'lounge-beanbag-2:0');
  assert.equal(ann.peer.seat, undefined);
  o.sit(ann, 'couch:0');
  assert.equal(ann.peer.seat, 'couch:0');
  // On another floor, f1's figures hold nothing.
  const cy = o.person('cy', 'f2');
  o.sit(cy, 'lounge-beanbag-1:0');
  assert.equal(cy.peer.seat, 'lounge-beanbag-1:0');
  // On the castle there's no lounge (and no beanbag to sit on).
  const c = office({ plan: planOf('castle'), held: [{ id: 7, project: 'f1', at: 1 }] });
  const dee = c.person('dee', 'f1');
  c.sit(dee, 'lounge-beanbag-1:0');
  assert.equal(c.sent.length, 0, 'not refused for a figure');
});

test('sit: a couch or pouf the floor has taken out is not somewhere to sit, and the figures go round it', () => {
  const o = office({ held: [{ id: 7, project: 'f1', at: 1 }], furniture: { 'lounge-beanbag-1': { removed: true }, couch: { removed: true } } });
  const ann = o.person('ann', 'f1');
  o.sit(ann, 'couch:1');
  assert.equal(ann.peer.seat, undefined);
  o.sit(ann, 'lounge-beanbag-1:0');
  assert.equal(ann.peer.seat, undefined);
  // The figure took beanbag 2 (the first seat left), so that is refused; the seats that are there and free are not.
  o.sit(ann, 'lounge-beanbag-2:0');
  assert.equal(ann.peer.seat, undefined);
  assert.equal(o.sent.at(-1)?.msg.t, 'sit.refused');
  o.sit(ann, 'bench:0');
  assert.equal(ann.peer.seat, 'bench:0');
});

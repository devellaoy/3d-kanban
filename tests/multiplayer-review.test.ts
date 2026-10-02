// Review fixes of the multiplayer relay: a repository change takes the floor from a visitor before
// anything is broadcast, only ephemeral frames are droppable (a congested link ends the visit
// instead of losing a welcome), and the roof is open to visitors for the games.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type { FloorDef } from '../src/server/building.js';
import { openKanban } from '../src/server/kanban/office.js';
import { Access, setAccessCheckerForTests } from '../src/server/multiplayer/access.js';
import { Multiplayer } from '../src/server/multiplayer/index.js';
import { RemoteSocket } from '../src/server/multiplayer/remote-socket.js';
import { Directory, Peer } from '../src/server/multiplayer/relay/directory.js';
import { Sessions } from '../src/server/multiplayer/relay/sessions.js';
import { setMp } from '../src/server/multiplayer/registry.js';
import { newClient, type Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { messaging } from '../src/server/office/messaging.js';
import { navigation } from '../src/server/office/navigation.js';
import { visitorMay, filterForVisitor, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import { clientFrameDroppable, serverFrameDroppable } from '../src/shared/multiplayer/droppable.js';
import { MP_HARD_CAP, MP_HIGH_WATER, MP_PROTOCOL, parseOfficeMsg, parseRelayMsg, type RelayToOffice } from '../src/shared/multiplayer/wire.js';
import { ROOF } from '../src/shared/rooftop.js';
import type { PeerInfo, ServerMsg } from '../src/shared/protocol.js';

afterEach(() => setAccessCheckerForTests(undefined));

// --- A: the floor goes before the new repositories are broadcast ------------------------------------

test('saving a project\'s repositories takes the floor from a visitor before the call returns', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-review-'));
  const defs: FloorDef[] = ['a', 'b'].map((id) => {
    const dir = path.join(root, id);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    return { id, name: id, repo: `acme/${id}`, dir, palette: 0, addedBy: 'x', addedAt: 1 };
  });
  const extra = path.join(root, 'extra');
  mkdirSync(path.join(extra, '.git'), { recursive: true });
  const ctx = {
    upgrader: { version: 't' },
    cfg: { dataDir: root },
    building: { list: () => defs, setRepos: (id: string, repos: FloorDef['repos']) => Object.assign(defs.find((d) => d.id === id)!, { repos }) },
    floors: new Map(),
    clients: new Map<string, Client>(),
    floorsChanged() {},
    workerFloor: () => undefined,
    sendTo() {},
    floorInfos: () => [],
  } as unknown as Ctx;
  const mp = new Multiplayer(ctx, { access: new Access(async () => '') });
  mp.cfg.update({ sharedFloors: ['a', 'b'] });
  setMp(ctx, mp);
  setAccessCheckerForTests(() => new Promise(() => {})); // GitHub never answers: only the synchronous part counts
  const scope: VisitorScope = { login: 'vera', floors: new Set(['a', 'b']), projects: new Set(['a', 'b']) };
  const sock = new RemoteSocket({ frame: () => true, up: () => true, bufferedAmount: () => 0, closed: () => {} }, scope, {});
  const c = newClient('v1', sock.asWebSocket(), { accountId: undefined, admin: false }, { id: 'v1', name: 'v1', floor: 'a' } as unknown as PeerInfo);
  c.visitor = scope;
  ctx.clients.set(c.id, c);
  mp.host.sessions.set('s1', { sock, scope, prints: new Map([['a', 'acme/a'], ['b', 'acme/b']]), denied: new Map() });
  const kanban = openKanban(ctx, 9);
  try {
    const err = kanban.ctx.setRepos('b', [
      { id: 'b', name: 'b', kind: 'git', dir: defs[1].dir, remote: 'acme/b', primary: true },
      { id: 'x', name: 'x', kind: 'git', dir: extra, remote: 'acme/private', primary: false },
    ]);
    assert.equal(err, undefined);
    // Nothing has awaited yet: whatever the caller broadcasts next already finds b out of scope.
    assert.deepEqual([...scope.floors], ['a']);
    assert.deepEqual([...scope.projects], ['a']);
    const shown = filterForVisitor({ t: 'kanban.projects', projects: [{ id: 'b', repos: [] }] } as unknown as ServerMsg, scope);
    assert.deepEqual((shown as { projects: unknown[] }).projects, [], 'the new repository list is not shown to them');
  } finally {
    kanban.shutdown();
    mp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- B: only ephemeral frames are droppable ----------------------------------------------------------

test('which frames may be dropped', () => {
  for (const t of ['peer.move', 'peer.act', 'car.move', 'cabinet.frame', 'screen', 'wb.pointer']) assert.equal(serverFrameDroppable(JSON.stringify({ t, id: 'x' })), true, t);
  for (const t of ['welcome', 'floor.enter', 'chat', 'wb.update', 'floors', 'rtc', 'peer.join', 'ball']) assert.equal(serverFrameDroppable(JSON.stringify({ t })), false, t);
  for (const t of ['move', 'wb.pointer', 'car.drive']) assert.equal(clientFrameDroppable(JSON.stringify({ t, x: 1 })), true, t);
  for (const t of ['chat', 'wb.update', 'floor.go', 'rtc', 'act']) assert.equal(clientFrameDroppable(JSON.stringify({ t })), false, t);
  assert.equal(clientFrameDroppable('not json'), false);
  assert.equal(clientFrameDroppable('{"x":1,"t":"move"}'), false, 'unknown shape: kept');
});

test('visit.frame keeps its drop flag through the validator, and only a true one', () => {
  const frame = (extra: object) => parseOfficeMsg({ t: 'visit.frame', sid: 'sid-12345678', data: '{}', ...extra });
  assert.deepEqual(parseRelayMsg({ t: 'visit.frame', sid: 'sid-12345678', data: '{}', drop: true }), { t: 'visit.frame', sid: 'sid-12345678', data: '{}', drop: true });
  assert.deepEqual(frame({ drop: true }), { t: 'visit.frame', sid: 'sid-12345678', data: '{}', drop: true });
  assert.deepEqual(frame({}), { t: 'visit.frame', sid: 'sid-12345678', data: '{}' });
  assert.deepEqual(frame({ drop: 'yes' }), { t: 'visit.frame', sid: 'sid-12345678', data: '{}' });
});

test('the owner side marks only ephemeral frames as droppable', () => {
  const calls: [string, boolean | undefined][] = [];
  const scope: VisitorScope = { login: 'vera', floors: new Set(['a']), projects: new Set(['a']) };
  const sock = new RemoteSocket({ frame: (d, drop) => (calls.push([JSON.parse(d).t, drop]), true), up: () => true, bufferedAmount: () => 0, closed: () => {} }, scope, {});
  sock.send(JSON.stringify({ t: 'chat', id: 'p', text: 'hi' }));
  sock.send(JSON.stringify({ t: 'wb.pointer', id: 'p', x: 1, y: 2 }));
  assert.deepEqual(calls, [['chat', false], ['wb.pointer', true]]);
});

/** A relay peer whose socket has `buffered` bytes queued; `send` is the real one's (droppable ones skip a backed-up receiver). */
function relayPeer(login: string) {
  const sent: RelayToOffice[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (d: string) => void sent.push(JSON.parse(d)) };
  return { peer: new Peer(login, undefined, ws as unknown as WebSocket), ws, sent };
}

function relayVisit() {
  const dir = new Directory();
  const sessions = new Sessions(dir);
  const owner = relayPeer('alice');
  const visitor = relayPeer('bob');
  dir.add(owner.peer);
  dir.add(visitor.peer);
  const profile = { name: 'Bob', color: '#fff', skin: 1, hair: 1, style: 1 };
  sessions.open(visitor.peer, { t: 'visit.open', sid: 'sid-12345678', to: 'alice', version: 't', protocol: MP_PROTOCOL, profile });
  sessions.accept(owner.peer, { t: 'visit.accept', sid: 'sid-12345678' });
  const frame = (from: Peer, data: string, drop?: true) => sessions.frame(from, { t: 'visit.frame', sid: 'sid-12345678', data, ...(drop ? { drop } : {}) });
  return { sessions, owner, visitor, frame };
}

test('a backed-up receiver loses only the droppable frames', () => {
  const { owner, visitor, frame } = relayVisit();
  visitor.ws.bufferedAmount = MP_HIGH_WATER + 1;
  assert.equal(frame(owner.peer, '{"t":"peer.move"}', true), false, 'a position is skipped');
  assert.equal(frame(owner.peer, '{"t":"welcome"}'), true, 'a welcome is not');
  assert.equal(frame(owner.peer, '{"t":"chat"}'), true);
  assert.deepEqual(visitor.sent.filter((m) => m.t === 'visit.frame').map((m) => (m as { data: string }).data), ['{"t":"welcome"}', '{"t":"chat"}']);
});

test('a receiver too far behind for essential frames ends the visit for both', () => {
  const { sessions, owner, visitor, frame } = relayVisit();
  visitor.ws.bufferedAmount = MP_HARD_CAP + 1;
  assert.equal(frame(owner.peer, '{"t":"chat"}'), false);
  assert.equal(sessions.count, 0);
  for (const p of [owner, visitor]) assert.deepEqual(p.sent.filter((m) => m.t === 'visit.close').map((m) => (m as { reason: string }).reason), ['Connection too slow']);
  assert.ok(!visitor.sent.some((m) => m.t === 'visit.frame'));
});

// --- C: the roof ------------------------------------------------------------------------------------

const roofScope: VisitorScope = { login: 'vera', floors: new Set(['a']), projects: new Set(['a']) };

test('a visitor may go up to the roof, and still not to the lobby or an unshared floor', () => {
  const may = (floor: unknown) => visitorMay({ t: 'floor.go', floor }, roofScope);
  assert.equal(may(ROOF), true);
  assert.equal(may('a'), true);
  assert.equal(may('secret'), false);
  assert.equal(may(''), false);
  assert.equal(may(undefined), false);
});

test('the roof view reaches a visitor with the people up there, and nothing of a project', () => {
  const peer = (id: string, floor?: string) => ({ id, name: id, floor, x: 3, y: 0, z: 4 }) as unknown as PeerInfo;
  const view = { t: 'floor.enter', floor: ROOF, peers: [peer('u', ROOF), peer('o', 'secret')], project: null, workers: [], services: { items: [], port: 1 } } as unknown as ServerMsg;
  const out = filterForVisitor(view, roofScope) as Extract<ServerMsg, { t: 'floor.enter' }>;
  assert.equal(out.floor, ROOF);
  assert.equal(out.peers[0].x, 3, 'someone on the roof is where they are');
  assert.equal(out.peers[1].x, 0, 'someone on an unshared floor is not');
  assert.equal(filterForVisitor({ t: 'floor.enter', floor: 'secret', peers: [] } as unknown as ServerMsg, roofScope), undefined);
  assert.ok(filterForVisitor({ t: 'peer.move', id: 'u', x: 1, y: 0, z: 1, rotY: 0, moving: true } as ServerMsg, roofScope, { floorOfPeer: () => ROOF }));
  assert.equal(filterForVisitor({ t: 'peer.move', id: 'u', x: 1, y: 0, z: 1, rotY: 0, moving: true } as ServerMsg, roofScope, { floorOfPeer: () => 'secret' }), undefined);
});

test('the elevator takes a visitor up to the roof and back to a floor of theirs', () => {
  const heard: ServerMsg[] = [];
  const ctx = {} as Ctx;
  // A floor that does nothing for whatever the features ask of it.
  const quiet = (own: object): unknown => new Proxy(function () {}, { get: (_t, k) => (k in own ? (own as Record<string | symbol, unknown>)[k] : typeof k === 'symbol' || k === 'then' || k === 'toJSON' ? undefined : quiet({})), apply: () => quiet({}) });
  const floors = new Map([['a', quiet({ id: 'a', dir: path.join(tmpdir(), 'agent-office-mp-review-none'), workers: quiet({ fullScreens: () => [], list: () => [] }) }) as never]]);
  Object.assign(ctx, { clients: new Map<string, Client>(), floors, floorOf: (c: Client) => (c.peer.floor ? floors.get(c.peer.floor) : undefined), floorsChanged() {}, servicesState: () => ({ items: [], port: 0 }), highScores: { top: () => [] } }, messaging(ctx));
  const ws = { readyState: 1, bufferedAmount: 0, send: (d: string) => void heard.push(JSON.parse(d)), close: () => assert.fail('the visitor was sent home') };
  const c = newClient('v1', ws as unknown as WebSocket, { accountId: undefined, admin: false }, { id: 'v1', name: 'v1', floor: 'a' } as unknown as PeerInfo);
  c.visitor = roofScope;
  ctx.clients.set(c.id, c);
  const nav = navigation(ctx);
  nav.goToRoof(c);
  assert.equal(c.peer.floor, ROOF);
  assert.equal((heard.find((m) => m.t === 'floor.enter') as { floor: string }).floor, ROOF);
  nav.goToFloor(c, floors.get('a') as never);
  assert.equal(c.peer.floor, 'a');
});

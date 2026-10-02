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
import { Access, repoPrint, setAccessCheckerForTests } from '../src/server/multiplayer/access.js';
import { Guest, VISIT_ENDED } from '../src/server/multiplayer/guest.js';
import { Multiplayer } from '../src/server/multiplayer/index.js';
import { MutableScope } from '../src/shared/multiplayer/scope.js';
import { RemoteSocket } from '../src/server/multiplayer/remote-socket.js';
import { Directory, Peer } from '../src/server/multiplayer/relay/directory.js';
import { Sessions } from '../src/server/multiplayer/relay/sessions.js';
import { setMp } from '../src/server/multiplayer/registry.js';
import { newClient, type Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { presenceHandlers } from '../src/server/ws/handlers/presence.js';
import { messaging } from '../src/server/office/messaging.js';
import { navigation } from '../src/server/office/navigation.js';
import { visitorMay, filterForVisitor, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import { clientFrameDroppable, serverFrameDroppable } from '../src/shared/multiplayer/droppable.js';
import { MP_HARD_CAP, MP_HIGH_WATER, MP_PROTOCOL, parseOfficeMsg, parseRelayMsg, type RelayToOffice } from '../src/shared/multiplayer/wire.js';
import { ROOF } from '../src/shared/rooftop.js';
import type { PeerInfo, ServerMsg } from '../src/shared/protocol.js';

afterEach(() => setAccessCheckerForTests(undefined));

// --- A: the floor goes before the new repositories are broadcast ------------------------------------

/** An office with floors a and b shared with a visitor on a; `extra` is a git folder to add to b as another repository. */
function repoScene() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-review-'));
  const defs: FloorDef[] = ['a', 'b'].map((id) => {
    const dir = path.join(root, id);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    return { id, name: id, repo: `acme/${id}`, dir, palette: 0, addedBy: 'x', addedAt: 1 };
  });
  const extra = path.join(root, 'extra');
  mkdirSync(path.join(extra, '.git'), { recursive: true });
  const sent: string[] = [];
  const ctx = {
    upgrader: { version: 't' },
    cfg: { dataDir: root },
    building: { list: () => defs, setRepos: (id: string, repos: FloorDef['repos']) => Object.assign(defs.find((d) => d.id === id)!, { repos }) },
    // The floors are running (admitted() only offers those), and quiet when a visitor lets go of them.
    floors: new Map(defs.map((d) => [d.id, { id: d.id, changes: { unwatchAll() {} }, workers: { detach() {} } }])),
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
  const scope = new MutableScope('vera');
  for (const d of defs) scope.grant(d.id, new Set([d.id]));
  const sock = new RemoteSocket({ frame: (d) => (sent.push(d), true), up: () => true, bufferedAmount: () => 0, closed: () => {} }, scope, {});
  const c = newClient('v1', sock.asWebSocket(), { accountId: undefined, admin: false }, { id: 'v1', name: 'v1', floor: 'a' } as unknown as PeerInfo);
  c.visitor = scope;
  ctx.clients.set(c.id, c);
  mp.host.sessions.set('s1', { sock, scope, prints: new Map(defs.map((d) => [d.id, repoPrint(d)])), denied: new Map() });
  const kanban = openKanban(ctx, 9);
  const done = () => {
    kanban.shutdown();
    mp.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { defs, extra, scope, mp, kanban, sent, sock, done };
}

test('saving a project\'s repositories takes the floor from a visitor before the call returns', () => {
  const { defs, extra, scope, kanban, done } = repoScene();
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
    done();
  }
});

test('a folder without a GitHub remote makes the project unshareable: the visitor loses it, never regains it, and never sees its name', async () => {
  const { defs, extra, scope, mp, kanban, sent, sock, done } = repoScene();
  try {
    // GitHub says yes to everything, so only the shareability of the project can keep the floor away.
    setAccessCheckerForTests(async () => true);
    const err = kanban.ctx.setRepos('b', [
      { id: 'b', name: 'b', kind: 'git', dir: defs[1].dir, remote: 'acme/b', primary: true },
      { id: 'secret-folder', name: 'Secret folder', kind: 'folder', dir: extra, primary: false },
    ]);
    assert.equal(err, undefined);
    assert.deepEqual([...scope.floors], ['a'], 'taken before anything is broadcast');
    assert.deepEqual([...scope.projects], ['a']);
    // The regain started by that change has been answered by now: an unshareable project is not given back.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...scope.floors], ['a'], 'not given back');
    assert.ok(mp.host.sessions.get('s1')!.prints.has('a') && !mp.host.sessions.get('s1')!.prints.has('b'));
    sock.send(JSON.stringify({ t: 'kanban.projects', projects: [{ id: 'b', repos: [{ id: 'secret-folder', name: 'Secret folder' }] }] }));
    assert.ok(!sent.some((d) => d.includes('Secret folder')), 'the new folder\'s name never reaches the visitor');
  } finally {
    done();
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
  // Like a real socket's, `send` keeps the bytes queued until its callback runs (`drain`).
  const callbacks: (() => void)[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (d: string, cb?: () => void) => (sent.push(JSON.parse(d)), cb && callbacks.push(cb)) };
  const drain = () => callbacks.splice(0).forEach((cb) => cb());
  return { drain, peer: new Peer(login, undefined, ws as unknown as WebSocket), ws, sent };
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
  visitor.peer.send({ t: 'visit.frame', sid: 'sid-12345678', data: 'x'.repeat(MP_HIGH_WATER + 1) });
  visitor.sent.length = 0;
  assert.equal(frame(owner.peer, '{"t":"peer.move"}', true), false, 'a position is skipped');
  assert.equal(frame(owner.peer, '{"t":"welcome"}'), true, 'a welcome is not');
  assert.equal(frame(owner.peer, '{"t":"chat"}'), true);
  assert.deepEqual(visitor.sent.filter((m) => m.t === 'visit.frame').map((m) => (m as { data: string }).data), ['{"t":"welcome"}', '{"t":"chat"}']);
});

test('a receiver too far behind for essential frames ends the visit for both', () => {
  const { sessions, owner, visitor, frame } = relayVisit();
  visitor.peer.send({ t: 'visit.frame', sid: 'sid-12345678', data: 'x'.repeat(MP_HARD_CAP + 1) });
  visitor.sent.length = 0;
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

// --- Voice signalling on the roof -------------------------------------------------------------------

test('voice signalling between a visitor and people on the roof goes both ways, but not to the lobby or an unshared floor', () => {
  const heard: Record<string, ServerMsg[]> = {};
  const mk = (id: string, floor: string | undefined, visitor?: VisitorScope) => {
    const ws = { readyState: 1, bufferedAmount: 0, send: (d: string) => void (heard[id] ??= []).push(JSON.parse(d)) };
    const c = newClient(id, ws as unknown as WebSocket, { accountId: undefined, admin: false }, { id, name: id, floor } as unknown as PeerInfo);
    if (visitor) c.visitor = visitor;
    return c;
  };
  const scope: VisitorScope = { login: 'vera', floors: new Set(['a']), projects: new Set(['a']) };
  const clients = new Map<string, Client>();
  const ctx = { clients, sendTo: (c: Client, m: ServerMsg) => c.ws.send(JSON.stringify(m)) } as unknown as Ctx;
  const people = [mk('visitor', ROOF, scope), mk('owner-roof', ROOF), mk('on-a', 'a'), mk('on-secret', 'secret'), mk('lobby', undefined)];
  for (const c of people) clients.set(c.id, c);
  const rtc = (from: string, to: string) => presenceHandlers.rtc(ctx, clients.get(from)!, { t: 'rtc', to, data: { x: 1 } } as never);
  rtc('visitor', 'owner-roof');
  rtc('owner-roof', 'visitor');
  rtc('visitor', 'on-a');
  rtc('visitor', 'on-secret');
  rtc('visitor', 'lobby');
  assert.equal(heard['owner-roof']?.length, 1, 'visitor to someone on the roof');
  assert.equal(heard['visitor']?.length, 1, 'roof owner to the visitor');
  assert.equal(heard['on-a']?.length, 1, 'a shared floor still works');
  assert.equal(heard['on-secret'], undefined);
  assert.equal(heard['lobby'], undefined);
  // And the frame going out to the visitor passes the outbound filter.
  assert.ok(filterForVisitor({ t: 'rtc', from: 'owner-roof', data: {} } as unknown as ServerMsg, scope, { floorOfPeer: () => ROOF }));
});

// --- Congestion at the hops the office controls -----------------------------------------------------

test('the visitor\'s browser too far behind for an essential frame ends the visit and tells the relay', () => {
  const sent: { t: string; reason?: string }[] = [];
  const mp = { link: { send: (m: { t: string }) => (sent.push(m), true) }, version: 't', updatePresence() {} };
  const guest = new Guest(mp as never);
  const out: string[] = [];
  const closes: [number, string][] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, on() {}, send: (d: string) => void out.push(d), close: (code: number, why: string) => void closes.push([code, why]) };
  guest.pipe(ws as never, 'alice', { name: 'Bob', color: '#fff', skin: 1, hair: 1, style: 1 });
  const sid = [...guest.pipes.keys()][0];
  guest.message({ t: 'visit.accept', sid });
  ws.bufferedAmount = MP_HARD_CAP + 1;
  guest.message({ t: 'visit.frame', sid, data: '{"t":"peer.move"}', drop: true });
  assert.deepEqual(out, [], 'a droppable frame is skipped');
  assert.equal(guest.pipes.size, 1);
  guest.message({ t: 'visit.frame', sid, data: '{"t":"chat"}' });
  assert.equal(guest.pipes.size, 0);
  assert.deepEqual(out.map((d) => JSON.parse(d)), [{ t: 'mp.ended', reason: 'Connection too slow' }]);
  assert.deepEqual(closes, [[VISIT_ENDED, 'Visit ended']]);
  assert.deepEqual(sent.filter((m) => m.t === 'visit.close'), [{ t: 'visit.close', sid, reason: 'Connection too slow' }]);
  // Below the cap an essential frame goes through, however backed up.
  const ws2 = { ...ws, bufferedAmount: MP_HARD_CAP, send: (d: string) => void out.push(d) };
  guest.pipe(ws2 as never, 'alice', { name: 'Bob', color: '#fff', skin: 1, hair: 1, style: 1 });
  const sid2 = [...guest.pipes.keys()][0];
  guest.message({ t: 'visit.accept', sid: sid2 });
  out.length = 0;
  guest.message({ t: 'visit.frame', sid: sid2, data: '{"t":"chat"}' });
  assert.deepEqual(out, ['{"t":"chat"}']);
});

test('the owner\'s link too far behind for an essential frame ends that visit, and droppable ones are skipped before that', () => {
  const frames: [string, boolean | undefined][] = [];
  const closed: string[] = [];
  const link = { buffered: 0 };
  const scope: VisitorScope = { login: 'vera', floors: new Set(['a']), projects: new Set(['a']) };
  const sock = new RemoteSocket({ frame: (d, drop) => (frames.push([JSON.parse(d).t, drop]), true), up: () => true, bufferedAmount: () => link.buffered, closed: (r) => void closed.push(r) }, scope, {});
  let left = 0;
  sock.once('close', () => left++);
  link.buffered = MP_HARD_CAP + 1;
  sock.send(JSON.stringify({ t: 'wb.pointer', id: 'p', x: 1, y: 2 }));
  assert.deepEqual(frames, [['wb.pointer', true]], 'droppable frames are the link\'s to skip (Link.send), not ended over');
  assert.equal(left, 0);
  sock.send(JSON.stringify({ t: 'chat', id: 'p', text: 'hi' }));
  assert.deepEqual(frames, [['wb.pointer', true]], 'the essential frame is not queued');
  assert.deepEqual(closed, ['Connection too slow']);
  assert.equal(left, 1, 'the visitor\'s Client leaves through the normal close');
  assert.equal(sock.readyState, 3);
});

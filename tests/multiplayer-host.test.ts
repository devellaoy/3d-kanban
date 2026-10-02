// The owner's side of a visit when the config moves under it: a share revoked while GitHub is still
// being asked, a project given another repository during a visit, and the small seams around it (the
// status for every admin browser, a visitor looking at a terminal). A Multiplayer on a stub office:
// no relay, no GitHub, no real floors.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FloorDef } from '../src/server/building.js';
import { Access, repoPrint, setAccessCheckerForTests } from '../src/server/multiplayer/access.js';
import { mpHooks } from '../src/server/multiplayer/handlers.js';
import { Multiplayer } from '../src/server/multiplayer/index.js';
import { RemoteSocket } from '../src/server/multiplayer/remote-socket.js';
import { setMp } from '../src/server/multiplayer/registry.js';
import { newClient, type Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { workerHandlers } from '../src/server/ws/handlers/workers.js';
import { WorkerManager } from '../src/server/workers.js';
import type { VisitorScope } from '../src/shared/multiplayer/allow.js';
import { MP_PROTOCOL, type OfficeToRelay } from '../src/shared/multiplayer/wire.js';
import type { PeerInfo, ServerMsg } from '../src/shared/protocol.js';

afterEach(() => setAccessCheckerForTests(undefined));

const root = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-host-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A Multiplayer on two floors, `a` (acme/a) and `b` (acme/b), both shared; `sent` is what went to the relay and to browsers. */
function office() {
  const dir = path.join(root, `o${n++}`);
  mkdirSync(dir, { recursive: true });
  const def = (id: string, repo: string): FloorDef => {
    const d = path.join(dir, id);
    mkdirSync(d);
    return { id, name: id, repo, dir: d, palette: 0, addedBy: 'x', addedAt: 1 };
  };
  const defs = [def('a', 'acme/a'), def('b', 'acme/b')];
  const toRelay: OfficeToRelay[] = [];
  const toBrowsers: [Client, ServerMsg][] = [];
  const ctx = {
    upgrader: { version: 't' },
    cfg: { dataDir: dir },
    building: { list: () => defs },
    floors: new Map(defs.map((d) => [d.id, { id: d.id, changes: { unwatchAll() {} } }])),
    clients: new Map<string, Client>(),
    workerFloor: () => undefined,
    sendTo: (c: Client, m: ServerMsg) => void toBrowsers.push([c, m]),
    floorInfos: () => [],
  } as unknown as Ctx;
  const mp = new Multiplayer(ctx, { access: new Access(async () => '') });
  mp.cfg.update({ sharedFloors: ['a', 'b'] });
  Object.assign(mp, { link: { online: true, login: 'owner', players: [], status: 'online', disconnect() {}, setPresence() {}, send: (m: OfficeToRelay) => (toRelay.push(m), true) } });
  setMp(ctx, mp);
  return { mp, ctx, defs, toRelay, toBrowsers, close: () => mp.close() };
}

const peer = (id: string, floor: string) => ({ id, name: id, floor }) as unknown as PeerInfo;
const sock = (scope: VisitorScope) => new RemoteSocket({ frame: () => true, up: () => true, bufferedAmount: () => 0, closed: () => {} }, scope, {});
const openMsg = { t: 'visit.open' as const, sid: 'sid-host-0001', from: 'vera', version: 't', protocol: MP_PROTOCOL, profile: { name: 'Vera', color: '#ff0000', skin: 1, hair: 1, style: 1 } };
const later = () => new Promise((r) => setImmediate(r));

/** A GitHub check that answers only when `release()` is called, with `allow`'s verdict. */
function held(allow: (repo: string) => boolean = () => true) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  setAccessCheckerForTests(async (_login, repo) => (await gate, allow(repo)));
  return release;
}

test('a share revoked while GitHub is being asked is not admitted', async () => {
  const o = office();
  const release = held();
  const opening = o.mp.host.open(openMsg);
  o.mp.cfg.update({ sharedFloors: [] }); // the owner stops sharing everything meanwhile
  release();
  await opening;
  assert.equal(o.mp.host.sessions.size, 0);
  assert.deepEqual(o.toRelay.map((m) => m.t), ['visit.close']);
  assert.match((o.toRelay[0] as { reason: string }).reason, /don't have access to any shared floor/);
  o.close();
});

test('a floor that is unshared, or given another repository, while GitHub is asked is left out of the answer', async () => {
  const o = office();
  const release = held();
  const asking = o.mp.admitted('vera');
  o.mp.cfg.update({ sharedFloors: ['a'] });
  release();
  assert.deepEqual([...(await asking).keys()], ['a'], 'b was unshared meanwhile');
  o.mp.cfg.update({ sharedFloors: ['a', 'b'] });
  const release2 = held();
  const again = o.mp.admitted('vera');
  o.defs[0].repos = [{ id: 'a', name: 'a', kind: 'git', dir: o.defs[0].dir, remote: 'acme/a', primary: true }, { id: 'x', name: 'x', kind: 'git', dir: path.join(o.defs[0].dir, 'x'), remote: 'acme/extra', primary: false }];
  release2();
  assert.deepEqual([...(await again).keys()], ['b'], 'a got a repository meanwhile, which nobody checked');
  o.close();
});

test('a visitor who withdrew while GitHub was being asked is not admitted, and the probe answer follows the config', async () => {
  const o = office();
  const release = held();
  const opening = o.mp.host.open(openMsg);
  assert.equal(o.mp.host.message({ t: 'visit.close', sid: openMsg.sid, reason: 'never mind' }), true, 'the host owns the pending visit');
  release();
  await opening;
  assert.equal(o.mp.host.sessions.size, 0);
  assert.deepEqual(o.toRelay, [], 'no accept, and no reply to someone who left');
  // A probe asked before the share was revoked answers with what is shared when GitHub replies.
  const release2 = held();
  const probing = (o.mp as unknown as { answerProbe(rid: string, login: string): Promise<void> }).answerProbe('rid-1', 'vera');
  o.mp.cfg.update({ sharedFloors: ['b'] });
  release2();
  await probing;
  const res = o.toRelay.find((m) => m.t === 'probe.res') as Extract<OfficeToRelay, { t: 'probe.res' }>;
  assert.deepEqual(res.floors.map((f) => f.name), ['b']);
  o.close();
});

/** A visitor in the office, admitted to both floors, standing on `on`. */
function visitorAt(o: ReturnType<typeof office>, on: string) {
  const scope: VisitorScope = { login: 'vera', floors: new Set(['a', 'b']), projects: new Set(['a', 'b']) };
  const s = sock(scope);
  const client = newClient('v1', s.asWebSocket(), { accountId: undefined, admin: false }, peer('v1', on));
  client.visitor = scope;
  o.ctx.clients.set(client.id, client);
  o.mp.host.sessions.set('s1', { sock: s, scope, prints: new Map(o.defs.map((d) => [d.id, repoPrint(d)])), denied: new Map() });
  return { scope, s, client };
}
const addRepo = (d: FloorDef, remote: string) => {
  d.repos = [{ id: d.id, name: d.id, kind: 'git', dir: d.dir, remote: d.repo, primary: true }, { id: 'x', name: 'x', kind: 'git', dir: path.join(d.dir, 'x'), remote, primary: false }];
};

test('a repository added to a shared project takes the floor from a visitor at once and gives it back only if they can read it', async () => {
  const o = office();
  const { scope, s } = visitorAt(o, 'a');
  o.mp.host.recheck();
  assert.deepEqual([...scope.floors], ['a', 'b'], 'nothing changed, nothing taken');
  const release = held((repo) => repo !== 'acme/extra'); // vera cannot read the new repository
  addRepo(o.defs[1], 'acme/extra');
  o.mp.floorsChanged();
  assert.deepEqual([...scope.floors], ['a'], 'b is gone at once, before GitHub has said anything');
  assert.deepEqual([...scope.projects], ['a']);
  assert.equal(s.readyState, 1, 'they stand on a, so they stay');
  release();
  await later();
  await later();
  assert.deepEqual([...scope.floors], ['a'], 'she cannot read acme/extra');
  // The repository goes to one she may read: verified again, the floor is back.
  const ok = held();
  o.defs[1].repos = [{ id: 'b', name: 'b', kind: 'git', dir: o.defs[1].dir, remote: 'acme/b', primary: true }, { id: 'y', name: 'y', kind: 'git', dir: path.join(o.defs[1].dir, 'y'), remote: 'acme/other', primary: false }];
  o.mp.floorsChanged();
  ok();
  await later();
  await later();
  assert.deepEqual([...scope.floors].sort(), ['a', 'b']);
  assert.ok(o.toBrowsers.some(([, m]) => m.t === 'floors'), 'their floor list was sent again');
  o.close();
});

test('a visitor standing on the floor that gained a repository is sent home', () => {
  const o = office();
  const { s } = visitorAt(o, 'b');
  let reason = '';
  s.on('close', (_code, r: Buffer) => (reason = r.toString()));
  held();
  addRepo(o.defs[1], 'acme/extra');
  o.mp.floorsChanged();
  assert.equal(s.readyState, 3);
  assert.match(reason, /no longer shared/);
  o.close();
});

test('every admin browser gets the multiplayer status, not only the ones watching', () => {
  const o = office();
  const ws = { readyState: 1 } as never;
  const mk = (id: string, admin: boolean) => {
    const c = newClient(id, ws, { accountId: undefined, admin }, peer(id, 'a'));
    o.ctx.clients.set(id, c);
    return c;
  };
  mpHooks.welcomed?.(o.ctx, mk('early', true));
  assert.deepEqual(o.toBrowsers, [], 'nothing to tell while multiplayer is not set up');
  o.mp.cfg.update({ url: 'wss://relay.example.com/mp' });
  const admin = mk('adm', true);
  const member = mk('mem', false);
  const guest = mk('gst', true);
  guest.visitor = { login: 'x', floors: new Set(), projects: new Set() };
  mpHooks.welcomed?.(o.ctx, admin);
  mpHooks.welcomed?.(o.ctx, member);
  mpHooks.welcomed?.(o.ctx, guest);
  assert.deepEqual(o.toBrowsers.map(([c, m]) => [c.id, m.t]), [['adm', 'mp.state']], 'on load, to the admin only');
  o.toBrowsers.length = 0;
  o.ctx.clients.delete('early');
  o.mp.pushState();
  assert.deepEqual(o.toBrowsers.map(([c]) => c.id), ['adm'], 'a change goes to admins that never sent mp.watch');
  o.close();
});

test('a visitor looking at a terminal does not acknowledge the worker; the owner does', () => {
  const calls: boolean[] = [];
  const floor = { workers: { get: () => ({ id: 'w1' }), attach: (_id: string, _c: string, _n: string, ack?: boolean) => (calls.push(ack ?? true), { data: '', cols: 1, rows: 1 }) } };
  const ctx = { workerFloor: () => floor, sendTo() {} } as unknown as Ctx;
  const client = (visitor: boolean) => {
    const c = newClient('c', {} as never, { accountId: undefined, admin: !visitor }, peer('c', 'a'));
    if (visitor) c.visitor = { login: 'x', floors: new Set(['a']), projects: new Set(['a']) };
    return c;
  };
  workerHandlers['worker.attach'](ctx, client(true), { t: 'worker.attach', workerId: 'w1' });
  workerHandlers['worker.attach'](ctx, client(false), { t: 'worker.attach', workerId: 'w1' });
  assert.deepEqual(calls, [false, true]);
});

test('WorkerManager.attach leaves a finished worker unacknowledged when asked not to', () => {
  const info = { id: 'w1', status: 'done', acked: false, cols: 80, rows: 24 };
  const w = { info, viewers: new Map<string, string>(), snapshot: () => 'screen' };
  const mgr = Object.create(WorkerManager.prototype) as WorkerManager & Record<string, unknown>;
  Object.assign(mgr, { workers: new Map([['w1', w]]), syncViewers: () => false, emitUpdate: () => {} });
  mgr.attach('w1', 'visitor', '@vera', false);
  assert.equal(info.acked, false, "the owner's waiting mark stays");
  assert.equal(w.viewers.get('visitor'), '@vera', 'but they are watching');
  mgr.attach('w1', 'owner', 'Olli');
  assert.equal(info.acked, true);
});

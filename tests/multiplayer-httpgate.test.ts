// The owner's HTTP gate when the share moves under a pending request: the answer is read from the
// owner's own server first, so a floor unshared (or a visit ended) during that wait must not leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerHttp, forbidden } from '../src/server/multiplayer/httpgate.js';
import type { Multiplayer } from '../src/server/multiplayer/index.js';
import type { Ctx } from '../src/server/office/context.js';
import type { RelayToOffice } from '../src/shared/multiplayer/wire.js';

async function setup() {
  let release: () => void = () => {};
  let hit: () => void = () => {};
  const hitP = new Promise<void>((r) => (hit = r));
  let aborted = false;
  const server = http.createServer((req, res) => {
    req.on('close', () => !res.writableEnded && (aborted = true));
    hit();
    release = () => res.end('{"secret":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const sock = new EventEmitter();
  const scope = { floors: new Set(['pub']), projects: new Set<string>() };
  const hosted = { sock, scope };
  const sessions = new Map<string, unknown>([['sid1', hosted]]);
  const sent: Record<string, unknown>[] = [];
  const mp = {
    ctx: { cfg: { host: '127.0.0.1', port: (server.address() as AddressInfo).port, tls: false }, auth: { visitorSecret: 's' }, floors: new Map() },
    host: { sessions },
    link: { send: (m: Record<string, unknown>) => void sent.push(m) },
  } as unknown as Multiplayer;
  const ask = (path: string) => answerHttp(mp, { t: 'visit.http', sid: 'sid1', rid: 'r1', path } as Extract<RelayToOffice, { t: 'visit.http' }>);
  return { ask, sent, scope, sessions, sock, hitP, release: () => release(), aborted: () => aborted, close: () => { server.closeAllConnections(); server.close(); } };
}

const WB = '/api/whiteboard/file?floor=pub&id=x';

test('a floor unshared while the owner is answering gets a 403 with no body', async () => {
  const t = await setup();
  const done = t.ask(WB);
  await t.hitP;
  t.scope.floors.delete('pub');
  t.release();
  await done;
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].status, 403);
  assert.ok(!String(t.sent[0].body).includes('c2VjcmV0'), 'no secret');
  assert.doesNotMatch(Buffer.from(String(t.sent[0].body), 'base64').toString(), /secret":true/);
  t.close();
});

test('a visit that ends while the owner is answering sends nothing and aborts the request', async () => {
  const t = await setup();
  const done = t.ask(WB);
  await t.hitP;
  t.sessions.delete('sid1');
  t.sock.emit('close');
  await done;
  assert.deepEqual(t.sent, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(t.aborted(), 'the loopback request was dropped');
  t.close();
});

test('an unchanged share still gets the answer', async () => {
  const t = await setup();
  const done = t.ask(WB);
  await t.hitP;
  t.release();
  await done;
  assert.equal(t.sent[0].status, 200);
  assert.equal(Buffer.from(String(t.sent[0].body), 'base64').toString(), '{"secret":true}');
  t.close();
});

test("a changed picture is only for a worker whose every floor is in the visitor's scope", () => {
  // w1 works on pub; w2 on pub and also in a repository of the unshared floor; w3 on the other floor.
  const workers: Record<string, { home: string; repos: string[] }> = { w1: { home: 'pub', repos: [] }, w2: { home: 'pub', repos: ['vault'] }, w3: { home: 'vault', repos: [] } };
  const ctx = {
    workerFloor: (id: string) => (workers[id] ? { id: workers[id].home, workers: { get: () => ({ repos: workers[id].repos.map((floor) => ({ floor })) }) } } : undefined),
  } as unknown as Ctx;
  const scope = { floors: new Set(['pub']), projects: new Set<string>() };
  const ask = (q: string) => forbidden(ctx, scope, new URL(`/api/changes/file?${q}`, 'http://visit'));
  assert.equal(ask('floor=pub&worker=w1&path=a.png&side=new'), undefined);
  assert.equal(ask('floor=pub&worker=w2&path=a.png&side=new'), 403, 'also works in an unshared floor');
  assert.equal(ask('floor=vault&worker=w3&path=a.png&side=new'), 403);
  assert.equal(ask('floor=pub&worker=w3&path=a.png&side=new'), 403, 'a worker of another floor under a shared floor name');
  assert.equal(ask('floor=pub&worker=nobody&path=a.png&side=new'), 403);
  assert.equal(ask('worker=w1&path=a.png&side=new'), 403, 'the floor is named every time');
  scope.floors.delete('pub');
  assert.equal(ask('floor=pub&worker=w1&path=a.png&side=new'), 403, 'after the unshare');
});

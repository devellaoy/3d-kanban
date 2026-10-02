import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay, type RunningRelay } from '../src/server/multiplayer/relay/server.js';
import { MP_BODY_B64_MAX, MP_CLOSE, MP_FRAME_MAX, MP_PROTOCOL, parseOfficeMsg, parseRelayMsg, type MpWirePlayer, type RelayToOffice } from '../src/shared/multiplayer/wire.js';

const PASSWORD = 'relay-test-pw';
const TOKENS: Record<string, string> = { 'tok-alice': 'alice', 'tok-bob': 'Bob', 'tok-carol': 'carol', 'tok-alice2': 'ALICE' };
const profile = { name: 'Vera', color: '#ff0000', skin: 1, hair: 2, style: 3 };
const SID = 'sid-aaaaaaaa';
let relay: RunningRelay;
let url = '';
const open: Office[] = [];

before(async () => {
  relay = await startRelay({
    port: 0,
    host: '127.0.0.1',
    password: PASSWORD,
    githubClientId: 'client-id-1',
    verifier: { login: async (t) => (TOKENS[t] ? TOKENS[t] : Promise.reject(new Error('bad token'))) },
  });
  url = `ws://127.0.0.1:${relay.port}/mp`;
});
after(async () => {
  for (const o of open) o.ws.terminate();
  await relay.close();
});

/** An office's end of the link: what the relay sent it, in order. */
class Office {
  readonly inbox: RelayToOffice[] = [];
  closed?: number;
  private wake?: () => void;
  readonly ws: WebSocket;
  constructor() {
    this.ws = new WebSocket(url);
    open.push(this);
    this.ws.on('message', (d) => {
      const m = parseRelayMsg(JSON.parse(d.toString()));
      assert.ok(m, `the relay sent something invalid: ${d}`);
      this.inbox.push(m);
      this.wake?.();
    });
    this.ws.on('close', (code) => {
      this.closed = code;
      this.wake?.();
    });
  }
  send(m: object) {
    if (this.ws.readyState === WebSocket.CONNECTING) this.ws.once('open', () => this.ws.send(JSON.stringify(m)));
    else this.ws.send(JSON.stringify(m));
  }
  async until<T>(f: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const v = f();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.inbox.map((m) => m.t))}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
  }
  next<T extends RelayToOffice['t']>(t: T, match: (m: Extract<RelayToOffice, { t: T }>) => boolean = () => true) {
    return this.until(() => this.inbox.find((m): m is Extract<RelayToOffice, { t: T }> => m.t === t && match(m as never)), t);
  }
  count(t: RelayToOffice['t']) {
    return this.inbox.filter((m) => m.t === t).length;
  }
  async closedWith() {
    return this.until(() => this.closed, 'close');
  }
  async players(pred: (p: MpWirePlayer[]) => boolean): Promise<MpWirePlayer[]> {
    return (await this.until(() => this.inbox.findLast((m) => m.t === 'players' && pred(m.players)), 'players')).players as MpWirePlayer[];
  }
}

/** Connects and says hello as `name`'s token; resolves once welcomed. */
async function join(token: string, extra: object = {}) {
  const o = new Office();
  o.send({ t: 'hello', password: PASSWORD, identityToken: token, version: '0.1.0', protocol: MP_PROTOCOL, ...extra });
  await o.next('welcome');
  return o;
}
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('/health and other paths', async () => {
  const ok = await fetch(`http://127.0.0.1:${relay.port}/health`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { ok: boolean; offices: number };
  assert.equal(body.ok, true);
  assert.equal(typeof body.offices, 'number');
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/health`, { method: 'POST' })).status, 404);
});

test('a wrong password closes with 4401, a bad token with 4403, no hello with 4400', async () => {
  const a = new Office();
  a.send({ t: 'hello', password: 'nope', identityToken: 'tok-alice', version: '0.1.0', protocol: 1 });
  assert.equal(await a.closedWith(), MP_CLOSE.password);
  const b = new Office();
  b.send({ t: 'hello', password: PASSWORD, identityToken: 'tok-wrong', version: '0.1.0', protocol: 1 });
  assert.equal(await b.closedWith(), MP_CLOSE.identity);
  const c = new Office();
  c.send({ t: 'presence', where: 'home' });
  assert.equal(await c.closedWith(), MP_CLOSE.protocol);
});

test('without a token, the right password gets the client id and a close', async () => {
  const o = new Office();
  o.send({ t: 'hello', password: PASSWORD, version: '0.1.0', protocol: 1 });
  const m = await o.next('need-identity');
  assert.equal(m.githubClientId, 'client-id-1');
  assert.equal(await o.closedWith(), 1000);
});

test('offices see each other, and the directory follows presence', async () => {
  const alice = await join('tok-alice', { name: 'Alice A' });
  assert.equal((await alice.next('welcome')).githubClientId, 'client-id-1');
  const bob = await join('tok-bob');
  const seen = await alice.players((p) => p.length >= 2 && p.some((x) => x.login === 'Bob'));
  assert.deepEqual(seen.find((p) => p.login === 'alice'), { login: 'alice', name: 'Alice A', online: true, where: 'home' });
  await bob.players((p) => p.some((x) => x.login === 'alice'));
  alice.send({ t: 'presence', where: 'home', floorKey: 'floorkey-0001' });
  await bob.players((p) => p.find((x) => x.login === 'alice')?.floorKey === 'floorkey-0001');
  bob.send({ t: 'presence', where: { visiting: 'alice' } });
  await alice.players((p) => JSON.stringify(p.find((x) => x.login === 'Bob')?.where) === '{"visiting":"alice"}');
  bob.ws.close();
  await alice.players((p) => !p.some((x) => x.login === 'Bob'));
  alice.ws.close();
});

test('a floor key without home, or a bad one, is not accepted', () => {
  assert.equal(parseOfficeMsg({ t: 'presence', where: { visiting: 'bob' }, floorKey: 'floorkey-0001' }), undefined);
  assert.equal(parseOfficeMsg({ t: 'presence', where: 'home', floorKey: 'has space!' }), undefined);
  assert.equal(parseOfficeMsg({ t: 'visit.open', sid: SID, to: 'not a login!', version: '1', protocol: 1, profile }), undefined);
  assert.equal(parseOfficeMsg({ t: 'visit.http', sid: SID, rid: 'r1', path: 'relative' }), undefined);
});

test('the same login replaces the old connection (4409), whatever its case', async () => {
  const first = await join('tok-alice');
  const second = await join('tok-alice2');
  assert.equal(await first.closedWith(), MP_CLOSE.replaced);
  const list = await second.players((p) => p.some((x) => x.login.toLowerCase() === 'alice'));
  assert.equal(list.filter((p) => p.login.toLowerCase() === 'alice').length, 1);
  // The old link closing must not have removed the new one from the directory.
  await nap(100);
  const h = (await (await fetch(`http://127.0.0.1:${relay.port}/health`)).json()) as { offices: number };
  assert.ok(h.offices >= 1);
  second.ws.close();
  await nap(50);
});

test("a replaced connection closing late does not end the newer connection's visits", async () => {
  const owner = await join('tok-alice');
  const visitor = await join('tok-bob');
  visitor.send({ t: 'visit.open', sid: 'sid-replaced-1', to: 'alice', version: '0.1.0', protocol: 1, profile });
  await owner.next('visit.open', (m) => m.sid === 'sid-replaced-1');
  // The owner's office reconnects; its old link is replaced, and with it that visit ends. The old
  // socket is held from answering the relay's close, so its close event comes late, after the new visit.
  owner.ws.pause();
  const newer = await join('tok-alice2');
  await visitor.next('visit.close', (m) => m.sid === 'sid-replaced-1');
  // A visit with the newer connection...
  visitor.send({ t: 'visit.open', sid: 'sid-replaced-2', to: 'alice', version: '0.1.0', protocol: 1, profile });
  await newer.next('visit.open', (m) => m.sid === 'sid-replaced-2');
  newer.send({ t: 'visit.accept', sid: 'sid-replaced-2' });
  await visitor.next('visit.accept', (m) => m.sid === 'sid-replaced-2');
  // ...survives the old socket finishing its close (the late close event of the replaced one).
  owner.ws.terminate();
  await nap(200);
  await owner.closedWith();
  visitor.send({ t: 'visit.frame', sid: 'sid-replaced-2', data: '{"t":"move"}' });
  assert.equal((await newer.next('visit.frame', (m) => m.sid === 'sid-replaced-2')).data, '{"t":"move"}');
  assert.ok(!visitor.inbox.some((m) => m.t === 'visit.close' && m.sid === 'sid-replaced-2'), 'the visitor was not told the visit ended');
  newer.ws.close();
  visitor.ws.close();
  await nap(50);
});

test('visits: from is set by the relay, frames go between the parties only', async () => {
  const owner = await join('tok-alice');
  const visitor = await join('tok-bob');
  const third = await join('tok-carol');
  // A spoofed `from` in the visitor's message is ignored: the owner hears the authenticated login.
  visitor.send({ t: 'visit.open', sid: SID, to: 'ALICE', from: 'carol', version: '0.1.0', protocol: 1, profile });
  const req = await owner.next('visit.open');
  assert.equal(req.from, 'Bob');
  assert.equal(req.sid, SID);
  assert.deepEqual(req.profile, profile);
  // Frames before accept go nowhere.
  visitor.send({ t: 'visit.frame', sid: SID, data: 'too early' });
  owner.send({ t: 'visit.accept', sid: SID });
  await visitor.next('visit.accept');
  assert.equal(owner.count('visit.frame'), 0);
  visitor.send({ t: 'visit.frame', sid: SID, data: '{"t":"move"}' });
  assert.equal((await owner.next('visit.frame')).data, '{"t":"move"}');
  owner.send({ t: 'visit.frame', sid: SID, data: '{"t":"welcome"}' });
  assert.equal((await visitor.next('visit.frame')).data, '{"t":"welcome"}');
  assert.equal(visitor.count('visit.frame'), 1, 'the too-early frame was not delivered');
  // A third office cannot inject into, or end, a session it is not part of.
  third.send({ t: 'visit.frame', sid: SID, data: 'injected' });
  third.send({ t: 'visit.close', sid: SID, reason: 'hijacked' });
  third.send({ t: 'visit.accept', sid: SID });
  third.send({ t: 'visit.http', sid: SID, rid: 'r1', path: '/x' });
  await nap(150);
  assert.ok(!owner.inbox.some((m) => m.t === 'visit.frame' && m.data === 'injected'));
  assert.ok(!visitor.inbox.some((m) => m.t === 'visit.frame' && m.data === 'injected'));
  assert.equal(owner.count('visit.close'), 0);
  assert.equal(visitor.count('visit.close'), 0);
  assert.equal(owner.count('visit.http'), 0);
  // The owner cannot send a visit.http request to the visitor, nor the visitor an unsolicited answer.
  owner.send({ t: 'visit.http', sid: SID, rid: 'r9', path: '/x' });
  owner.send({ t: 'visit.httpres', sid: SID, rid: 'r9', status: 200, type: 'text/plain', body: '' });
  visitor.send({ t: 'visit.httpres', sid: SID, rid: 'r9', status: 200, type: 'text/plain', body: '' });
  // Http: visitor asks, owner answers; an answer to nothing is dropped.
  visitor.send({ t: 'visit.http', sid: SID, rid: 'r1', path: '/api/gh/pull?n=1' });
  assert.equal((await owner.next('visit.http')).path, '/api/gh/pull?n=1');
  owner.send({ t: 'visit.httpres', sid: SID, rid: 'r1', status: 200, type: 'application/json', body: 'e30=' });
  assert.equal((await visitor.next('visit.httpres')).body, 'e30=');
  await nap(100);
  assert.equal(visitor.count('visit.httpres'), 1);
  assert.equal(visitor.count('visit.http'), 0);
  // The owner dropping ends the visit for the visitor.
  owner.ws.close();
  const closed = await visitor.next('visit.close');
  assert.equal(closed.sid, SID);
  visitor.ws.close();
  third.ws.close();
});

test('refusals and the visitor leaving', async () => {
  const owner = await join('tok-alice');
  const visitor = await join('tok-bob');
  visitor.send({ t: 'visit.open', sid: 'sid-offline1', to: 'nobody', version: '0.1.0', protocol: 1, profile });
  assert.match((await visitor.next('visit.close', (m) => m.sid === 'sid-offline1')).reason, /not online/);
  visitor.send({ t: 'visit.open', sid: 'sid-self0001', to: 'bob', version: '0.1.0', protocol: 1, profile });
  assert.match((await visitor.next('visit.close', (m) => m.sid === 'sid-self0001')).reason, /yourself/);
  visitor.send({ t: 'visit.open', sid: 'sid-refused1', to: 'alice', version: '0.0.1', protocol: 0, profile });
  await owner.next('visit.open', (m) => m.sid === 'sid-refused1');
  owner.send({ t: 'visit.close', sid: 'sid-refused1', reason: 'Different version' });
  assert.equal((await visitor.next('visit.close', (m) => m.sid === 'sid-refused1')).reason, 'Different version');
  visitor.send({ t: 'visit.open', sid: 'sid-leaves01', to: 'alice', version: '0.1.0', protocol: 1, profile });
  await owner.next('visit.open', (m) => m.sid === 'sid-leaves01');
  owner.send({ t: 'visit.accept', sid: 'sid-leaves01' });
  await visitor.next('visit.accept');
  visitor.ws.close();
  assert.match((await owner.next('visit.close', (m) => m.sid === 'sid-leaves01')).reason, /visitor left/);
  owner.ws.close();
});

test('an oversized frame is dropped, the link carries on', async () => {
  const owner = await join('tok-alice');
  const visitor = await join('tok-bob');
  visitor.send({ t: 'visit.open', sid: 'sid-big00001', to: 'alice', version: '0.1.0', protocol: 1, profile });
  await owner.next('visit.open');
  owner.send({ t: 'visit.accept', sid: 'sid-big00001' });
  await visitor.next('visit.accept');
  visitor.send({ t: 'visit.frame', sid: 'sid-big00001', data: 'x'.repeat(MP_FRAME_MAX + 1) });
  visitor.send({ t: 'visit.frame', sid: 'sid-big00001', data: 'x'.repeat(MP_FRAME_MAX) });
  const got = await owner.next('visit.frame');
  assert.equal(got.data.length, MP_FRAME_MAX);
  assert.equal(owner.count('visit.frame'), 1);
  // A body over the cap is dropped too.
  visitor.send({ t: 'visit.http', sid: 'sid-big00001', rid: 'big', path: '/x' });
  await owner.next('visit.http');
  owner.send({ t: 'visit.httpres', sid: 'sid-big00001', rid: 'big', status: 200, type: 'x/y', body: 'A'.repeat(MP_BODY_B64_MAX + 4) });
  await nap(300);
  assert.equal(visitor.count('visit.httpres'), 0);
  assert.equal(visitor.closed, undefined);
  owner.ws.close();
  visitor.ws.close();
});

test('probes are routed by rid, with from set by the relay', async () => {
  const owner = await join('tok-alice');
  const visitor = await join('tok-bob');
  const other = await join('tok-carol');
  visitor.send({ t: 'probe', rid: 'p1', to: 'alice' });
  const p = await owner.next('probe');
  assert.deepEqual([p.rid, p.from], ['p1', 'Bob']);
  // Another office answering the same rid is not the owner: nothing reaches the visitor.
  other.send({ t: 'probe.res', rid: 'p1', floors: [{ key: 'floorkey-evil1', name: 'Evil' }] });
  await nap(100);
  assert.equal(visitor.count('probe.res'), 0);
  owner.send({ t: 'probe.res', rid: 'p1', floors: [{ key: 'floorkey-0001', name: 'Web' }] });
  assert.deepEqual((await visitor.next('probe.res')).floors, [{ key: 'floorkey-0001', name: 'Web' }]);
  // An answer cannot be replayed.
  owner.send({ t: 'probe.res', rid: 'p1', floors: [] });
  await nap(100);
  assert.equal(visitor.count('probe.res'), 1);
  // An offline owner is answered at once with nothing.
  visitor.send({ t: 'probe', rid: 'p2', to: 'nobody' });
  assert.deepEqual((await visitor.next('probe.res', (m) => m.rid === 'p2')).floors, []);
  // An owner who drops mid-probe leaves the visitor with an empty answer.
  visitor.send({ t: 'probe', rid: 'p3', to: 'alice' });
  await owner.next('probe', (m) => m.rid === 'p3');
  owner.ws.close();
  assert.deepEqual((await visitor.next('probe.res', (m) => m.rid === 'p3')).floors, []);
  visitor.ws.close();
  other.ws.close();
});

test('too many wrong passwords from one address are turned away', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) {
    const o = new Office();
    o.send({ t: 'hello', password: `wrong-${i}`, identityToken: 'tok-alice', version: '0.1.0', protocol: 1 });
    codes.push(await o.closedWith());
  }
  assert.ok(codes.includes(MP_CLOSE.rateLimited), JSON.stringify(codes));
  assert.equal(codes[0], MP_CLOSE.password);
});

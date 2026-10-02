// Two real offices and a relay in one process, the way people would run them: the owner shares a
// floor, a visitor from the other office walks in through the relay, and nothing the owner did not
// share (or the visitor may not see on GitHub) crosses the wire. The relay's GitHub check is a stub
// that knows three logins, and the owner's GitHub access check is a stub too (no gh, no network).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { setAccessCheckerForTests } from '../src/server/multiplayer/access.js';
import { startRelay, type RunningRelay } from '../src/server/multiplayer/relay/server.js';
import { startServer } from '../src/server/server.js';
import { MP_PROTOCOL, parseRelayMsg, type RelayToOffice } from '../src/shared/multiplayer/wire.js';
import type { ServerMsg } from '../src/shared/protocol.js';

type Office = Awaited<ReturnType<typeof startServer>>;
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

const RELAY_PASSWORD = 'relay-pw';
const PASSWORD = 'office-pw';
const TOKENS: Record<string, string> = { 'tok-owner': 'owner', 'tok-vera': 'vera', 'tok-mallory': 'mallory' };
/** What the owner's unshared floors are called: none of these may reach a visitor (or the relay). */
const SECRET_WORDS = ['Hidden Vault', 'hidden-vault', 'Locked Room', 'locked-room'];

let tmp = '';
let relay: RunningRelay;
let proxy: { port: number; close(): void };
const relaySaw: string[] = [];
let owner: { office: Office; base: string; cookie: string };
let guest: { office: Office; base: string; cookie: string };
let ownerVersion = '';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/** A browser's end of a /ws socket: every text it received (raw, for leak checks) and the parsed messages, taken in order by type. */
class Browser {
  readonly inbox: ServerMsg[] = [];
  readonly raw: string[] = [];
  closed?: number;
  private wake?: () => void;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.raw.push(d.toString());
      this.inbox.push(JSON.parse(d.toString()));
      this.wake?.();
    });
    ws.on('close', (code) => {
      this.closed = code;
      this.wake?.();
    });
  }

  static open(o: { base: string; cookie: string }, query = ''): Promise<Browser> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${o.base.replace('http', 'ws')}/ws${query}`, { headers: { cookie: o.cookie, origin: o.base } });
      const b = new Browser(ws);
      ws.once('open', () => resolve(b));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)));
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  async until<T>(f: () => T | undefined, what: string, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${this.inbox.map((m) => m.t).join(', ') || 'nothing'}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
  }

  /** The first message of type `t` that `ok` accepts, taken out of the inbox. */
  take<T extends ServerMsg['t']>(t: T, ok: (m: Msg<T>) => boolean = () => true, ms?: number): Promise<Msg<T>> {
    return this.until(() => {
      const i = this.inbox.findIndex((m) => m.t === t && ok(m as Msg<T>));
      return i >= 0 ? (this.inbox.splice(i, 1)[0] as Msg<T>) : undefined;
    }, t, ms);
  }

  async quiet(ms = 400) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async closedWith(): Promise<number> {
    return this.until(() => this.closed, 'the socket to close');
  }

  close() {
    this.ws.close();
  }
}

/** A WebSocket hop in front of the relay that writes down every text that passes, in both directions. */
async function observe(target: string, log: string[]) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/mp' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const code = (c: number) => (c === 1000 || (c >= 3000 && c < 5000) ? c : 1000);
  wss.on('connection', (down) => {
    const up = new WebSocket(target);
    const early: [WebSocket.RawData, boolean][] = [];
    up.on('open', () => early.splice(0).forEach(([d, bin]) => up.send(d, { binary: bin })));
    down.on('message', (d, bin) => {
      log.push(d.toString());
      if (up.readyState === WebSocket.OPEN) up.send(d, { binary: bin });
      else early.push([d, bin]);
    });
    up.on('message', (d, bin) => {
      log.push(d.toString());
      down.send(d, { binary: bin });
    });
    up.on('close', (c) => down.close(code(c)));
    down.on('close', (c) => up.close(code(c)));
    up.on('error', () => down.terminate());
    down.on('error', () => up.terminate());
  });
  return { port: (wss.address() as net.AddressInfo).port, close: () => wss.close() };
}

function repo(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']]) execFileSync('git', args, { cwd: dir });
  return dir;
}

/** An office in a throwaway home, with these floors, joined to the relay as `token`'s login. */
async function boot(name: string, token: string, floors: { id: string; name: string; repo: string }[], shared: string[]) {
  const root = path.join(tmp, name);
  const publicDir = path.join(root, 'public');
  const bin = path.join(root, 'bin');
  for (const d of [path.join(root, 'home'), publicDir, bin, path.join(root, 'projects')]) mkdirSync(d, { recursive: true });
  for (const page of ['index', 'login', 'claim', 'join', 'lite']) writeFileSync(path.join(publicDir, `${page}.html`), `<!doctype html><title>${page}</title>`);
  const claude = path.join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);
  const port = await freePort();
  const cfg = loadConfig(['--home', path.join(root, 'home'), '--projects', path.join(root, 'projects'), '--port', String(port), '--password', PASSWORD, '--no-open', '--weather', 'clear', '--agent', claude]);
  const defs = floors.map((f, i) => ({ id: f.id, name: f.name, repo: f.repo, dir: repo(path.join(root, 'checkouts'), f.id), palette: i, addedBy: 'test', addedAt: 1 }));
  writeFileSync(path.join(cfg.dataDir, 'floors.json'), JSON.stringify(defs));
  writeFileSync(path.join(cfg.dataDir, 'multiplayer.json'), JSON.stringify({ enabled: true, url: `ws://127.0.0.1:${proxy.port}/mp`, password: RELAY_PASSWORD, identityToken: token, sharedFloors: shared, floorKeys: {} }));
  const office = await startServer(cfg, { publicDir });
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 200);
  return { office, base, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-e2e-'));
  for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_OFFICE_')) delete process.env[k];
  // vera can read everything except the locked room (she is not a collaborator on that repository).
  setAccessCheckerForTests(async (login, repoName) => login === 'vera' && repoName !== 'acme/locked-room');
  relay = await startRelay({ port: 0, host: '127.0.0.1', password: RELAY_PASSWORD, githubClientId: 'cid', verifier: { login: async (t) => TOKENS[t] ?? Promise.reject(new Error('bad token')) } });
  proxy = await observe(`ws://127.0.0.1:${relay.port}/mp`, relaySaw);
  owner = await boot(
    'owner',
    'tok-owner',
    [
      { id: 'pub', name: 'Pub Open', repo: 'acme/pub-open' },
      { id: 'vault', name: 'Hidden Vault', repo: 'acme/hidden-vault' },
      { id: 'locked', name: 'Locked Room', repo: 'acme/locked-room' },
    ],
    ['pub', 'locked'], // the vault is never shared; the locked room is, but vera may not read its repository
  );
  guest = await boot('guest', 'tok-vera', [{ id: 'home', name: 'Vera Home', repo: 'vera/home' }], []);
});

after(async () => {
  setAccessCheckerForTests(undefined);
  owner?.office.shutdown();
  guest?.office.shutdown();
  proxy?.close();
  await relay?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

let ownerBrowser: Browser;
let guestAdmin: Browser;
let visitor: Browser;
const visitUrl = '?visit=owner&name=Vera&color=%23ff0000&skin=1&hair=2&style=1';

test('both offices come online and the player list names a floor only to someone who may enter it', async () => {
  ownerBrowser = await Browser.open(owner, '?name=Olli');
  const welcome = await ownerBrowser.take('welcome');
  ownerVersion = welcome.version;
  assert.equal(welcome.floor, 'pub', 'the owner lands on the first floor, which is shared');
  guestAdmin = await Browser.open(guest, '?name=Vera');
  await guestAdmin.take('welcome');
  guestAdmin.send({ t: 'mp.watch' });
  const state = await guestAdmin.take('mp.state', (m) => m.state.status === 'online' && m.state.players.some((p) => p.login === 'owner' && p.floor === 'Pub Open'), 15_000);
  assert.deepEqual(state.state.players.map((p) => p.login).sort(), ['owner', 'vera']);
  assert.equal(state.state.passwordSet, true);
  assert.ok(!JSON.stringify(state).includes(RELAY_PASSWORD) && !JSON.stringify(state).includes('tok-'), 'the browser never gets the password or the token');
});

test('a visitor arrives on the one floor they may see, as @login, and the owner sees them', async () => {
  const pubFloor = owner.office.floors().find((f) => f.id === 'pub')!;
  const woke: string[] = [];
  const realArrived = pubFloor.arrived.bind(pubFloor);
  const realWake = pubFloor.workers.wakeAll.bind(pubFloor.workers);
  pubFloor.arrived = () => (woke.push('arrived'), realArrived());
  pubFloor.workers.wakeAll = () => (woke.push('wakeAll'), realWake());
  after(() => {
    pubFloor.arrived = realArrived;
    pubFloor.workers.wakeAll = realWake;
  });

  visitor = await Browser.open(guest, visitUrl);
  const welcome = await visitor.take('welcome');
  assert.equal(welcome.floor, 'pub');
  assert.deepEqual(welcome.floors.map((f) => f.id), ['pub']);
  assert.deepEqual(welcome.me, { admin: false, visitor: true });
  assert.equal(welcome.project?.dir, '', "the owner's folders stay home");
  const join = await ownerBrowser.take('peer.join', (m) => m.peer.name === '@vera');
  assert.equal(join.peer.color, '#ff0000');
  assert.deepEqual(woke, [], 'a visitor arriving wakes no agent and refreshes nothing');
  // The control: the same spies do see the owner's own people come in.
  const second = await Browser.open(owner, '?name=Ola');
  await second.take('welcome');
  assert.deepEqual(woke, ['arrived', 'wakeAll']);
  second.close();
});

test('a visitor cannot do what only the owner may, and the owner sees none of it happen', async () => {
  const pub = owner.office.floors().find((f) => f.id === 'pub')!;
  const queueBefore = JSON.stringify(pub.queue.state());
  for (const msg of [
    { t: 'worker.spawn', deskId: 'desk-1', prompt: 'visitor-made-this' },
    { t: 'queue.add', prompt: 'visitor-made-this', title: 'x' },
    { t: 'gh.comment', number: 1, body: 'visitor-made-this' },
    { t: 'kanban.task.create', project: 'pub', title: 'visitor-made-this' },
    { t: 'kanban.subscribe', project: null },
    { t: 'kanban.subscribe', project: 'vault' },
    { t: 'floor.go', floor: 'vault' },
    { t: 'floor.go', floor: 'locked' },
    { t: 'mp.share', floor: 'vault', on: true },
    { t: 'accounts.invite', name: 'x', role: 'admin' },
  ]) visitor.send(msg);
  await visitor.quiet(800);
  assert.equal(pub.workers.list().length, 0);
  assert.equal(JSON.stringify(pub.queue.state()), queueBefore);
  assert.ok(owner.office.floors().every((f) => f.workers.list().length === 0));
  const leaked = visitor.raw.filter((r) => /"t":"(kanban\.|accounts|me")/.test(r) && !r.includes('kanban.error'));
  assert.deepEqual(leaked, [], 'no kanban state or accounts for a visitor who got none');
  assert.equal(visitor.closed, undefined, 'refused messages do not end the visit');
  // Nor did the vault get shared by it: the owner's list of floors to share is unchanged.
  ownerBrowser.send({ t: 'mp.watch' });
  const state = await ownerBrowser.take('mp.state');
  assert.deepEqual(state.state.floors.filter((f) => f.shared).map((f) => f.id), ['pub', 'locked']);
});

test('a visitor draws on the whiteboard and chats, and hears the owner chat back', async () => {
  const el = { id: 'rect-1', type: 'rectangle', version: 1, versionNonce: 7, x: 1, y: 2, width: 3, height: 4 };
  visitor.send({ t: 'wb.update', elements: [el] });
  const update = await ownerBrowser.take('wb.update');
  assert.equal(update.elements[0].id, 'rect-1');
  visitor.send({ t: 'chat', text: 'hello from vera' });
  const heard = await ownerBrowser.take('chat', (m) => m.text === 'hello from vera');
  assert.equal(heard.name, '@vera');
  ownerBrowser.send({ t: 'chat', text: 'welcome, vera' });
  await visitor.take('chat', (m) => m.text === 'welcome, vera');
  visitor.send({ t: 'move', x: 2, y: 0, z: 2, rotY: 0 });
  await ownerBrowser.take('peer.move');
});

test("the owner's other floors do not show in where they are or what they do", async () => {
  ownerBrowser.send({ t: 'floor.go', floor: 'vault' });
  await ownerBrowser.take('floor.enter', (m) => m.floor === 'vault');
  ownerBrowser.send({ t: 'doing', what: 'Reading zzvault-plans' });
  await visitor.quiet(600);
  const peers = visitor.raw.filter((r) => /"t":"peer\./.test(r) && r.includes('Olli'));
  assert.ok(peers.length > 0, 'the visitor still sees that the owner is around');
  for (const r of peers) assert.ok(!r.includes('vault'), r);
  ownerBrowser.send({ t: 'doing', what: '' });
  ownerBrowser.send({ t: 'floor.go', floor: 'pub' });
  await ownerBrowser.take('floor.enter', (m) => m.floor === 'pub');
});

test('HTTP through the owner: the allowed reads work, everything else is refused', async () => {
  const pub = owner.office.floors().find((f) => f.id === 'pub')!;
  assert.equal(pub.whiteboard.addFile({ id: 'pic1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' }), undefined);
  const via = (p: string) => fetch(`${guest.base}/api/mp/visit/owner${p}`, { headers: { cookie: guest.cookie } });

  const pic = await via('/api/whiteboard/file?floor=pub&id=pic1');
  assert.equal(pic.status, 200);
  assert.equal(((await pic.json()) as { id: string }).id, 'pic1');
  assert.match(pic.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await via('/api/whiteboard/file?floor=pub&id=nope')).status, 404, 'a real answer from the owner');

  for (const p of [
    '/api/whiteboard/file?floor=vault&id=pic1', // a floor that is not shared
    '/api/whiteboard/file?floor=locked&id=pic1', // shared, but vera cannot read its repository
    '/api/gh/pull?number=1&floor=vault',
    '/api/gh/pull?number=1',
    '/api/docs?floor=vault', // the bookshelf of a floor that is not shared
    '/api/docs?floor=locked',
    '/api/docs',
    '/api/docs/file?floor=vault&path=README.md',
    '/api/docs/picture?floor=vault&path=a.png',
    '/api/search?q=a&floor=pub',
    '/api/changes/file?floor=pub',
    '/api/kanban/tasks/1/changes', // no such task: nothing to show
    '/api/kanban/attachments/abcdef',
    '/api/image?url=http%3A%2F%2F127.0.0.1%3A1%2Fsecret.png', // not a picture on a shared wall
    '/api/whoami',
    '/api/kanban/upload',
  ]) assert.equal((await via(p)).status, 403, p);
  // The bookshelf of the shared floor reads through the owner (its own README, not the visitor's office).
  const shelf = await via('/api/docs?floor=pub');
  assert.equal(shelf.status, 200);
  assert.ok(((await shelf.json()) as { files: { path: string }[] }).files.some((f) => f.path === 'README.md'));
  const doc = await via('/api/docs/file?floor=pub&path=README.md');
  assert.equal(doc.status, 200);
  assert.match(((await doc.json()) as { text: string }).text, /^# pub/);
  // Only what the shelf lists: not outside the project, not a note git ignores (.agent-office/, CLAUDE.local.md).
  for (const p of ['../../etc/passwd', '.agent-office/x.md', 'CLAUDE.local.md']) assert.equal((await via(`/api/docs/file?floor=pub&path=${encodeURIComponent(p)}`)).status, 404, p);
  assert.equal((await via('/api/docs/picture?floor=pub&path=.agent-office/x.png')).status, 404);
  assert.equal((await fetch(`${guest.base}/api/mp/visit/owner/api/whiteboard/file?floor=pub&id=pic1`)).status, 401, 'signed in only');
  const nobody = await fetch(`${guest.base}/api/mp/visit/nobody/api/whiteboard/file?floor=pub`, { headers: { cookie: guest.cookie } });
  assert.equal(nobody.status, 404, 'a visit that is not open');

  // The loopback secret is the only way in, and it is not for guessing.
  for (const headers of [{ 'x-agent-office-mp': 'guess' }, { 'x-agent-office-mp': '' }]) {
    assert.equal((await fetch(`${owner.base}/api/whiteboard/file?floor=pub&id=pic1`, { headers })).status, 401);
  }
});

test('a visit is refused for another version, another protocol, or someone without access', async () => {
  const talk = async (open: object) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/mp`);
    const got: RelayToOffice[] = [];
    ws.on('message', (d) => void got.push(parseRelayMsg(JSON.parse(d.toString()))!));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', password: RELAY_PASSWORD, identityToken: 'tok-mallory', version: ownerVersion, protocol: MP_PROTOCOL }));
    for (let i = 0; i < 100 && !got.some((m) => m.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ t: 'visit.open', to: 'owner', profile: { name: 'M', color: '#000000', skin: 0, hair: 0, style: 0 }, ...open }));
    let close: Extract<RelayToOffice, { t: 'visit.close' }> | undefined;
    for (let i = 0; i < 150 && !close; i++) {
      await new Promise((r) => setTimeout(r, 20));
      close = got.find((m): m is Extract<RelayToOffice, { t: 'visit.close' }> => m.t === 'visit.close');
    }
    ws.close();
    assert.ok(close, 'the owner answered');
    return close.reason;
  };
  assert.match(await talk({ sid: 'mallory-sid-1', version: '0.0.0-other', protocol: MP_PROTOCOL }), /update both offices to the same version/);
  assert.match(await talk({ sid: 'mallory-sid-2', version: ownerVersion, protocol: MP_PROTOCOL + 1 }), /update both offices/);
  assert.match(await talk({ sid: 'mallory-sid-3', version: ownerVersion, protocol: MP_PROTOCOL }), /don't have access to any shared floor/);
});

test('stopping the share of a floor sends its visitors home with a reason', async () => {
  ownerBrowser.send({ t: 'mp.share', floor: 'pub', on: false });
  const ended = await visitor.take('mp.ended');
  assert.match(ended.reason, /no longer shared/);
  assert.equal(await visitor.closedWith(), 4000);
  // With nothing shared a visit is refused outright.
  const none = await Browser.open(guest, visitUrl);
  assert.match((await none.take('mp.ended')).reason, /don't have access to any shared floor/);
  ownerBrowser.send({ t: 'mp.share', floor: 'pub', on: true });
  await ownerBrowser.take('mp.state', (m) => m.state.floors.some((f) => f.id === 'pub' && f.shared));
  visitor = await Browser.open(guest, visitUrl);
  const welcome = await visitor.take('welcome');
  assert.deepEqual(welcome.floors.map((f) => f.id), ['pub']);
});

test('going offline keeps the settings, ends visits and leaves the relay; going online comes back', async () => {
  const saved = () => JSON.parse(readFileSync(path.join(tmp, 'owner', 'home', '.agent-office', 'multiplayer.json'), 'utf8'));
  const before = saved();
  ownerBrowser.send({ t: 'mp.online', on: false });
  const off = await ownerBrowser.take('mp.state', (m) => m.state.offline);
  assert.equal(off.state.status, 'off');
  assert.equal(off.state.configured, true);
  assert.deepEqual(off.state.players, []);
  assert.match((await visitor.take('mp.ended')).reason, /offline|lost/);
  assert.equal(await visitor.closedWith(), 4000);
  const after = saved();
  assert.equal(after.enabled, false);
  for (const k of ['url', 'password', 'identityToken', 'sharedFloors', 'floorKeys']) assert.deepEqual(after[k], before[k], k);
  await guestAdmin.take('mp.state', (m) => !m.state.players.some((p) => p.login === 'owner') && m.state.players.some((p) => p.login === 'vera'), 15_000);
  // Back online with the saved settings, nothing retyped. (Older online states may still be queued: drop them.)
  ownerBrowser.inbox.length = 0;
  guestAdmin.inbox.length = 0;
  ownerBrowser.send({ t: 'mp.online', on: true });
  const on = await ownerBrowser.take('mp.state', (m) => m.state.status === 'online' && !m.state.offline, 15_000);
  assert.equal(on.state.configured, true);
  assert.equal(saved().enabled, true);
  await guestAdmin.take('mp.state', (m) => m.state.players.some((p) => p.login === 'owner'), 15_000);
  visitor = await Browser.open(guest, visitUrl);
  assert.deepEqual((await visitor.take('welcome')).floors.map((f) => f.id), ['pub']);
});

test('nothing unshared ever crossed the relay or reached the visitor', () => {
  const sawByRelay = relaySaw.join('\n');
  const sawByVisitor = visitor.raw.join('\n');
  for (const word of SECRET_WORDS) {
    assert.ok(!sawByRelay.includes(word), `the relay saw "${word}": ${relaySaw.filter((l) => l.includes(word)).map((l) => l.slice(0, 600)).join(' | ')}`);
    assert.ok(!sawByVisitor.includes(word), `the visitor saw "${word}"`);
  }
  assert.ok(!sawByRelay.includes(path.join(tmp, 'owner')) && !sawByVisitor.includes(path.join(tmp, 'owner')), 'no folder of the owner');
  assert.ok(sawByRelay.includes('Pub Open'), 'the shared floor is named to someone who may enter it');
});

test('when the owner closes the office the visitor is told and sent home', async () => {
  owner.office.shutdown();
  const ended = await visitor.take('mp.ended');
  assert.match(ended.reason, /owner|offline|closed|lost/i);
  assert.equal(await visitor.closedWith(), 4000);
});

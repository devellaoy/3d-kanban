// Backpressure is judged per visit (one link carries every visitor and every visit of an office), the
// cap clears the biggest message, the owner's frames to a visitor's browser are filtered again on the
// visitor's side, and unchanged frames are not parsed per visitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { frameForBrowser, visitorMayGet } from '../src/server/multiplayer/guest-filter.js';
import { Guest } from '../src/server/multiplayer/guest.js';
import { MpConfigStore } from '../src/server/multiplayer/config.js';
import { Link } from '../src/server/multiplayer/link.js';
import { RemoteSocket } from '../src/server/multiplayer/remote-socket.js';
import { Directory, Peer } from '../src/server/multiplayer/relay/directory.js';
import { Sessions } from '../src/server/multiplayer/relay/sessions.js';
import { SERVER_MSG_OUT, filterForVisitor, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import { MP_HARD_CAP, MP_HIGH_WATER, MP_MESSAGE_MAX, MP_PROTOCOL } from '../src/shared/multiplayer/wire.js';
import type { ServerMsg } from '../src/shared/protocol.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scope: VisitorScope = { login: 'vera', floors: new Set(['a']), projects: new Set(['a']), repos: new Map() };
const MB = 1024 * 1024;

test('the hard cap clears the largest message with room to spare', () => {
  assert.ok(MP_HARD_CAP >= MP_MESSAGE_MAX + 4 * MB);
});

/** A socket on the owner's link that never drains: its send callbacks wait for `drain`. */
function heldLink() {
  const callbacks: (() => void)[] = [];
  const ws = { readyState: 1, bufferedAmount: 100 * MB, send: (_d: string, cb?: () => void) => void (cb && callbacks.push(cb)), removeAllListeners() {}, on() {}, terminate() {} };
  const link = new Link({ config: new MpConfigStore(mkdtempSync(path.join(tmpdir(), 'mp-cong-'))), version: 't', onChange() {}, onMessage() {}, onDown() {} });
  Object.assign(link, { ws, status: 'online' });
  return { link, drain: () => callbacks.splice(0).forEach((cb) => cb()) };
}

test('a whiteboard-sized message to a receiver that is not draining does not end the visit; a genuine backlog does', () => {
  const { link, drain } = heldLink();
  const closed: string[] = [];
  const frames: string[] = [];
  const mk = (sid: string) =>
    new RemoteSocket({ frame: (d, drop) => (frames.push(sid), link.send({ t: 'visit.frame', sid, data: d, ...(drop ? { drop: true as const } : {}) }, !!drop)), up: () => true, bufferedAmount: () => link.queuedFor(sid), closed: (r) => void closed.push(r) }, scope, {});
  const big = mk('sid-big-00001');
  const other = mk('sid-other-0001');
  const welcomeLike = JSON.stringify({ t: 'chat', id: 'p', text: 'x'.repeat(12 * MB) });
  big.send(welcomeLike);
  assert.equal(big.readyState, 1, 'one 12 MB message split into pieces does not trip the cap');
  assert.ok(link.queuedFor('sid-big-00001') > 12 * MB);
  assert.equal(link.queuedFor('sid-other-0001'), 0);
  big.send(welcomeLike);
  big.send(welcomeLike);
  assert.equal(big.readyState, 1, 'the check is before queueing: a message that starts under the 32 MB cap is queued whole (37 MB now)');
  big.send(JSON.stringify({ t: 'chat', id: 'p', text: 'hi' }));
  assert.equal(big.readyState, 3, 'genuine backlog beyond the cap ends that visit');
  assert.deepEqual(closed, ['Connection too slow']);
  // Droppable frames of the backed-up visit are skipped by the link, not over-counted.
  assert.equal(link.send({ t: 'visit.frame', sid: 'sid-big-00001', data: '{"t":"peer.move"}', drop: true }, true), false);
  // Another visit on the same link is untouched, though the socket as a whole is full.
  other.send(JSON.stringify({ t: 'chat', id: 'p', text: 'hi' }));
  other.send(JSON.stringify({ t: 'wb.pointer', id: 'p', x: 1, y: 2 }));
  assert.equal(other.readyState, 1);
  assert.deepEqual(frames.filter((s) => s === 'sid-other-0001').length, 2);
  drain();
  assert.equal(link.queuedFor('sid-big-00001'), 0, 'written bytes leave the count');
});

function relayPeer(login: string) {
  const sent: string[] = [];
  const callbacks: (() => void)[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 100 * MB, send: (d: string, cb?: () => void) => (sent.push(d), cb && callbacks.push(cb)) };
  return { peer: new Peer(login, undefined, ws as unknown as WebSocket), sent, drain: () => callbacks.splice(0).forEach((cb) => cb()) };
}

function twoVisits() {
  const dir = new Directory();
  const sessions = new Sessions(dir);
  const owner = relayPeer('alice');
  const bob = relayPeer('bob');
  const carol = relayPeer('carol');
  for (const p of [owner, bob, carol]) dir.add(p.peer);
  const profile = { name: 'X', color: '#fff', skin: 1, hair: 1, style: 1 };
  for (const [sid, v] of [['sid-bob-00001', bob], ['sid-carol-001', carol]] as const) {
    sessions.open(v.peer, { t: 'visit.open', sid, to: 'alice', version: 't', protocol: MP_PROTOCOL, profile });
    sessions.accept(owner.peer, { t: 'visit.accept', sid });
  }
  return { sessions, owner, bob, carol };
}

test('the relay counts a receiver\'s backlog per visit and forwards the validated text as it came', () => {
  const { sessions, owner, bob, carol } = twoVisits();
  // Bob's visitor-side peer gets a 12 MB message: no end, the whole socket being "full" does not matter.
  const raw = JSON.stringify({ t: 'visit.frame', sid: 'sid-bob-00001', data: 'y'.repeat(12 * MB) });
  assert.equal(sessions.frame(owner.peer, { t: 'visit.frame', sid: 'sid-bob-00001', data: 'y'.repeat(12 * MB) }, raw), true);
  assert.equal(bob.sent.at(-1), raw, 'forwarded unchanged');
  assert.equal(sessions.frame(owner.peer, { t: 'visit.frame', sid: 'sid-bob-00001', data: 'z' }), true, '12 MB queued is not over the cap');
  assert.equal(sessions.count, 2);
  // Carol's visit is unaffected by Bob's queue and droppable frames of hers still go.
  assert.equal(sessions.frame(owner.peer, { t: 'visit.frame', sid: 'sid-carol-001', data: '{"t":"peer.move"}', drop: true }), true);
  // Bob's own backlog past the cap ends only Bob's visit.
  bob.peer.send({ t: 'visit.frame', sid: 'sid-bob-00001', data: 'x'.repeat(MP_HARD_CAP + 1) });
  assert.equal(sessions.frame(owner.peer, { t: 'visit.frame', sid: 'sid-bob-00001', data: '{"t":"chat"}' }), false);
  assert.equal(sessions.count, 1);
  assert.equal(sessions.frame(owner.peer, { t: 'visit.frame', sid: 'sid-carol-001', data: '{"t":"chat"}' }), true);
  assert.equal(carol.sent.filter((d) => d.includes('visit.close')).length, 0);
  assert.equal(bob.peer.queuedFor('sid-bob-00001') > MP_HIGH_WATER, true);
  bob.drain();
  assert.equal(bob.peer.queuedFor('sid-bob-00001'), 0);
});

test('the types the office passes on unparsed are exactly those the filter returns unchanged without lookups', () => {
  for (const [t, how] of Object.entries(SERVER_MSG_OUT)) {
    const msg = { t, id: 'x' } as unknown as ServerMsg;
    if (how === 'pass') assert.equal(filterForVisitor(msg, scope, {}), msg, `${t} must come back as it is, with no lookup`);
    if (how === 'drop') assert.equal(filterForVisitor(msg, scope, {}), undefined, t);
  }
});

test('pass frames are not parsed per visitor, drop ones vanish', () => {
  const sent: string[] = [];
  const sock = new RemoteSocket({ frame: (d) => (sent.push(d), true), up: () => true, bufferedAmount: () => 0, closed() {} }, scope, {});
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => (parsed++, parse(...a))) as typeof JSON.parse;
  try {
    sock.send('{"t":"chat","id":"p","text":"hi"}');
    sock.send('{"t":"toast","text":"secret"}');
    sock.send('{"t":"made.up"}');
    assert.equal(parsed, 0);
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(sent, ['{"t":"chat","id":"p","text":"hi"}']);
  sock.send('{"id":"p","t":"chat"}');
  sock.send('{"id":"p","t":"made.up"}');
  assert.equal(sent.length, 2, 'a frame without its type up front is parsed and judged as before');
});

test('the visitor\'s browser takes only frame types a visitor may get', () => {
  for (const t of ['me', 'mp.state', 'mp.ended', 'mp.probe.res', 'signins', 'signins.needed', 'accounts', 'invites', 'team', 'usage', 'limits', 'projectsDir', 'upgrade', 'upgrade.state', 'prompts', 'notify', 'machine', 'codex-limits', 'codex-limits.x', 'kanban.settings', 'kanban.secrets', 'kanban.secrets.saved', 'unknown.thing']) {
    assert.equal(frameForBrowser(JSON.stringify({ t, x: 1 })), undefined, t);
    assert.equal(visitorMayGet(t), false, t);
  }
  const chat = '{"t":"chat","id":"p","text":"hi"}';
  assert.equal(frameForBrowser(chat), chat);
  assert.equal(frameForBrowser('{"t":"wb.update","x":{"t":1}}') !== undefined, true, 'a nested "t" key makes it parse, not drop');
  assert.equal(frameForBrowser('not json'), undefined);
  assert.equal(frameForBrowser('[1]'), undefined);
  assert.equal(frameForBrowser('{"x":1,"t":"me"}'), undefined, 'type not up front: parsed and judged');
  assert.equal(frameForBrowser('{"t":"chat","t":"me"}'), undefined, 'a second "t" key wins in the browser, so it is what is judged');
  assert.equal(frameForBrowser('{"t":"chat","t" :"me"}'), undefined);
  const welcome = JSON.parse(frameForBrowser('{"t":"welcome","me":{"admin":true},"peers":[]}')!);
  assert.deepEqual(welcome.me, { admin: false, visitor: true });
  assert.deepEqual(welcome.peers, []);
});

test('Guest hands the browser nothing a hostile owner adds', () => {
  const mp = { link: { send: () => true }, version: 't', updatePresence() {} };
  const guest = new Guest(mp as never);
  const out: string[] = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, on() {}, send: (d: string) => void out.push(d), close() {} };
  guest.pipe(ws as never, 'alice', { name: 'Bob', color: '#fff', skin: 1, hair: 1, style: 1 });
  const sid = [...guest.pipes.keys()][0];
  guest.message({ t: 'visit.accept', sid });
  for (const data of ['{"t":"me","admin":true}', '{"t":"mp.ended","reason":"x"}', 'garbage', '{"t":"kanban.secrets"}']) guest.message({ t: 'visit.frame', sid, data });
  guest.message({ t: 'visit.frame', sid, data: '{"t":"welcome","me":{"admin":true}}' });
  guest.message({ t: 'visit.frame', sid, data: '{"t":"chat","text":"hi"}', drop: undefined });
  assert.deepEqual(out.map((d) => JSON.parse(d)), [{ t: 'welcome', me: { admin: false, visitor: true } }, { t: 'chat', text: 'hi' }]);
  assert.equal(guest.pipes.size, 1);
});

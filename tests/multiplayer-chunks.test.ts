// A browser message over the relay's 2 MB frame limit (a floor's whiteboard rides in welcome or
// floor.enter and may be 16 MB) goes in pieces and arrives whole; one over the total cap ends the
// visit with a reason instead of vanishing. Two real Links talk through a real relay.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Reassembler, splitFrame } from '../src/server/multiplayer/chunks.js';
import { MpConfigStore } from '../src/server/multiplayer/config.js';
import { Link } from '../src/server/multiplayer/link.js';
import { startRelay, type RunningRelay } from '../src/server/multiplayer/relay/server.js';
import { MP_FRAME_MAX, MP_MESSAGE_MAX, MP_PARTIALS_MAX, MP_PARTS_MAX, MP_PROTOCOL, MP_TOO_LARGE, parseOfficeMsg, type RelayToOffice } from '../src/shared/multiplayer/wire.js';

const SID = 'sid-chunks-1';
const profile = { name: 'Vera', color: '#ff0000', skin: 1, hair: 2, style: 3 };
let tmp = '';
let relay: RunningRelay;

class Side {
  readonly inbox: RelayToOffice[] = [];
  readonly link: Link;
  constructor(token: string, readonly dir: string) {
    const config = new MpConfigStore(dir);
    config.update({ enabled: true, url: `ws://127.0.0.1:${relay.port}/mp`, password: 'pw', identityToken: token });
    this.link = new Link({ config, version: '0.0.0', onChange() {}, onMessage: (m) => void this.inbox.push(m), onDown() {} });
    this.link.connect();
  }
  async until<T>(f: () => T | undefined, what: string, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  frame(i = 0) {
    return this.until(() => this.inbox.filter((m) => m.t === 'visit.frame')[i], 'a frame');
  }
  close() {
    return this.until(() => this.inbox.find((m) => m.t === 'visit.close'), 'visit.close');
  }
}

let owner: Side;
let visitor: Side;

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-office-mp-chunks-'));
  relay = await startRelay({ port: 0, host: '127.0.0.1', password: 'pw', githubClientId: 'cid', verifier: { login: async (t) => (t === 'tok-o' ? 'owner' : t === 'tok-v' ? 'vera' : Promise.reject(new Error('bad'))) } });
  owner = new Side('tok-o', path.join(tmp, 'o'));
  visitor = new Side('tok-v', path.join(tmp, 'v'));
  await owner.until(() => (owner.link.online ? true : undefined), 'owner online');
  await visitor.until(() => (visitor.link.online ? true : undefined), 'visitor online');
});

after(async () => {
  owner?.link.disconnect();
  visitor?.link.disconnect();
  await relay?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const wb = (bytes: number) => JSON.stringify({ t: 'welcome', whiteboard: { elements: [], blob: 'x'.repeat(bytes) } });

async function openVisit(sid: string) {
  visitor.link.send({ t: 'visit.open', sid, to: 'owner', version: '0.0.0', protocol: MP_PROTOCOL, profile });
  await owner.until(() => owner.inbox.find((m) => m.t === 'visit.open' && m.sid === sid), 'visit.open');
  owner.link.send({ t: 'visit.accept', sid });
  await visitor.until(() => visitor.inbox.find((m) => m.t === 'visit.accept' && m.sid === sid), 'visit.accept');
}

test('splitFrame cuts at MP_FRAME_MAX and the pieces join back to the same text', () => {
  const text = 'a😀b'.repeat(Math.ceil(MP_FRAME_MAX / 2));
  const pieces = splitFrame(text)!;
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.every((p) => p.data.length <= MP_FRAME_MAX && p.part.n === pieces.length));
  assert.equal(pieces.map((p) => p.data).join(''), text);
  assert.equal(splitFrame('x'.repeat(MP_MESSAGE_MAX + 1)), undefined);
  assert.equal(splitFrame('x'.repeat(MP_MESSAGE_MAX))!.length, MP_PARTS_MAX);
});

test('Reassembler joins in order and refuses anything out of order, over the cap or too many at once', () => {
  const r = new Reassembler();
  const pieces = splitFrame('y'.repeat(MP_FRAME_MAX * 2 + 5))!;
  assert.equal(r.push(SID, pieces[0].data, pieces[0].part), undefined);
  assert.equal(r.push(SID, pieces[1].data, pieces[1].part), undefined);
  assert.deepEqual(r.push(SID, pieces[2].data, pieces[2].part), { data: 'y'.repeat(MP_FRAME_MAX * 2 + 5) });
  // A gap, a restart in the middle, a piece from another message.
  assert.equal(r.push(SID, 'a', pieces[0].part), undefined);
  assert.ok('error' in r.push(SID, 'a', pieces[2].part)!);
  assert.equal(r.push(SID, 'a', pieces[0].part), undefined);
  assert.ok('error' in r.push(SID, 'a', pieces[0].part)!, 'a new message before the last one ended');
  assert.equal(r.push(SID, 'a', pieces[0].part), undefined);
  assert.ok('error' in r.push(SID, 'a', { ...pieces[1].part, id: 'other-id' })!);
  // Over the total cap.
  const big = new Reassembler();
  const n = MP_PARTS_MAX;
  let got: ReturnType<Reassembler['push']>;
  for (let i = 0; i < n && !got; i++) got = big.push(SID, 'z'.repeat(MP_FRAME_MAX), { id: 'big', i, n });
  assert.deepEqual(got, i_of(n)); // the last piece lands exactly at the cap: still allowed
  const over = new Reassembler();
  let err: ReturnType<Reassembler['push']>;
  for (let i = 0; i < n && !err; i++) err = over.push(SID, 'z'.repeat(MP_FRAME_MAX + (i === n - 1 ? 1 : 0)), { id: 'over', i, n });
  assert.deepEqual(err, { error: MP_TOO_LARGE });
  // Too many half-received messages at once.
  const many = new Reassembler();
  for (let k = 0; k < MP_PARTIALS_MAX; k++) assert.equal(many.push(`sid-many-${k}`, 'a', { id: 'm', i: 0, n: 2 }), undefined);
  assert.deepEqual(many.push('sid-many-extra', 'a', { id: 'm', i: 0, n: 2 }), { error: MP_TOO_LARGE });
});

function i_of(n: number) {
  return { data: 'z'.repeat(MP_FRAME_MAX * n) };
}

test('the relay accepts well-formed pieces and rejects malformed ones', () => {
  const base = { t: 'visit.frame', sid: SID, data: 'x' };
  const ok = (part: unknown, extra: object = {}) => parseOfficeMsg({ ...base, part, ...extra });
  assert.deepEqual(ok({ id: 'abc', i: 1, n: 3 }), { ...base, part: { id: 'abc', i: 1, n: 3 } });
  for (const bad of [
    { id: 'abc', i: 3, n: 3 },
    { id: 'abc', i: -1, n: 3 },
    { id: 'abc', i: 0, n: 1 },
    { id: 'abc', i: 0, n: MP_PARTS_MAX + 1 },
    { id: 'abc', i: 0.5, n: 3 },
    { id: 'a b', i: 0, n: 3 },
    { id: '', i: 0, n: 3 },
    { i: 0, n: 3 },
    'part',
    null,
    [],
  ]) assert.equal(ok(bad), undefined, JSON.stringify(bad));
  assert.equal(ok({ id: 'abc', i: 0, n: 2 }, { drop: true }), undefined, 'a piece is never droppable');
  assert.equal(parseOfficeMsg({ ...base, data: 'x'.repeat(MP_FRAME_MAX + 1), part: { id: 'abc', i: 0, n: 2 } }), undefined, 'each piece still has the frame cap');
});

for (const mb of [2.25, 10]) {
  test(`a ${mb} MB whiteboard-sized message goes both ways through the relay whole`, async () => {
    const sid = `sid-big-${mb}`.replace('.', '-');
    await openVisit(sid);
    const down = wb(Math.round(mb * 1024 * 1024));
    const before = visitor.inbox.filter((m) => m.t === 'visit.frame').length;
    owner.link.send({ t: 'visit.frame', sid, data: down });
    const got = await visitor.until(() => visitor.inbox.filter((m) => m.t === 'visit.frame' && m.sid === sid)[0], 'the big frame');
    assert.equal(got.t === 'visit.frame' && got.data === down, true);
    assert.equal(visitor.inbox.filter((m) => m.t === 'visit.frame').length, before + 1, 'one message, not pieces');
    assert.ok(!('part' in got), 'the receiver sees the whole message');
    const up = JSON.stringify({ t: 'wb.update', pad: 'q'.repeat(Math.round(mb * 1024 * 1024)) });
    visitor.link.send({ t: 'visit.frame', sid, data: up });
    const back = await owner.until(() => owner.inbox.filter((m) => m.t === 'visit.frame' && m.sid === sid)[0], 'the big frame back');
    assert.equal(back.t === 'visit.frame' && back.data === up, true);
    // Small frames keep working after.
    owner.link.send({ t: 'visit.frame', sid, data: '{"t":"chat"}' });
    await visitor.until(() => visitor.inbox.find((m) => m.t === 'visit.frame' && m.sid === sid && m.data === '{"t":"chat"}'), 'a small frame');
    visitor.link.send({ t: 'visit.close', sid, reason: 'done' });
  });
}

test('a message over the total cap ends the visit with a reason on both sides', async () => {
  const sid = 'sid-over-cap';
  await openVisit(sid);
  assert.equal(owner.link.send({ t: 'visit.frame', sid, data: 'x'.repeat(MP_MESSAGE_MAX + 1) }), false);
  const mine = await owner.until(() => owner.inbox.find((m) => m.t === 'visit.close' && m.sid === sid), 'the sender hears it');
  const theirs = await visitor.until(() => visitor.inbox.find((m) => m.t === 'visit.close' && m.sid === sid), 'the other side hears it');
  assert.equal(mine.t === 'visit.close' && mine.reason, MP_TOO_LARGE);
  assert.equal(theirs.t === 'visit.close' && theirs.reason, MP_TOO_LARGE);
  assert.equal(visitor.inbox.some((m) => m.t === 'visit.frame' && m.sid === sid), false, 'nothing partial was delivered');
});

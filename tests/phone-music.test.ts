// The phone's music: sessions (server/phone/music.ts), its handlers, and that an in-memory YoutubeTv writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneMusic } from '../src/server/phone/music.js';
import { phoneHandlers, phoneHooks } from '../src/server/phone/handlers.js';
import { YoutubeTv } from '../src/server/youtube/tv.js';
import { clearYoutubeTitles, youtubeTitles } from '../src/server/youtube/titles.js';
import { filterForVisitor, visitorMay, type VisitorScope } from '../src/shared/multiplayer/allow.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Client } from '../src/server/office/client.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const A = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const B = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
const ann = { id: 'ann', name: 'Ann' };
const bob = { id: 'bob', name: 'Bob' };
const cy = { id: 'cy', name: 'Cy' };

function music() {
  let t = 1000;
  let n = 0;
  const m = new PhoneMusic(() => t, () => `id${++n}`);
  return { m, tick: (ms: number) => (t += ms) };
}
const playId = (m: PhoneMusic, who: string) => m.stateOf(m.sessionOf(who)!)!.state!.id;

test('for yourself: one listener, playing', () => {
  const { m } = music();
  const r = m.play(ann, A);
  assert.ok(!('error' in r));
  const s = m.stateOf(m.sessionOf('ann')!)!;
  assert.deepEqual(s.listeners, [ann]);
  assert.equal(s.by, 'Ann');
  assert.equal(s.state!.paused, false);
  assert.equal(m.play(ann, A, ann) && m.stateOf(m.sessionOf('ann')!)!.listeners.length, 1);
});

test('to someone: both hear the same play', () => {
  const { m } = music();
  m.play(ann, A, bob);
  assert.equal(m.sessionOf('ann'), m.sessionOf('bob'));
  assert.deepEqual(m.stateOf(m.sessionOf('ann')!)!.listeners, [ann, bob]);
  assert.equal(playId(m, 'ann'), playId(m, 'bob'));
});

test('a new play leaves the old session; it ends when empty, lives on for the other', () => {
  const { m } = music();
  const first = m.play(ann, A);
  assert.ok(!('error' in first));
  const r = m.play(ann, B);
  assert.ok(!('error' in r));
  assert.equal(m.stateOf(first.session), null);
  assert.deepEqual(r.change.gone, []);
  const shared = m.play(ann, A, bob);
  assert.ok(!('error' in shared));
  const solo = m.play(bob, B);
  assert.ok(!('error' in solo));
  assert.deepEqual(solo.change.sessions.sort(), [shared.session, solo.session].sort());
  assert.deepEqual(m.stateOf(shared.session)!.listeners, [ann]);
  assert.deepEqual(m.stateOf(solo.session)!.listeners, [bob]);
});

test('queue adds to your own session, and starts one if you have none', () => {
  const { m } = music();
  const r = m.play(ann, A, undefined, 'end');
  assert.ok(!('error' in r));
  assert.equal(m.stateOf(r.session)!.state!.url.includes('aaaaaaaaaaa'), true);
  const q = m.play(ann, B, undefined, 'end');
  assert.ok(!('error' in q));
  assert.equal(q.session, r.session);
  assert.equal(m.stateOf(r.session)!.list.queue.length, 1);
  assert.deepEqual(q.change, { sessions: [r.session], gone: [] });
});

test('pause and seek reach both listeners', () => {
  const { m, tick } = music();
  m.play(ann, A, bob);
  const id = playId(m, 'ann');
  assert.ok(m.control('bob', { t: 'tv.youtube.pause', id, paused: true }));
  tick(5000);
  assert.ok(m.control('ann', { t: 'tv.youtube.seek', id, to: 42 }));
  const s = m.stateOf(m.sessionOf('ann')!)!.state!;
  assert.equal(s.paused, true);
  assert.equal(s.position, 42);
  assert.equal(s.pausedBy, 'Bob');
});

test('ended with an empty queue ends the session', () => {
  const { m } = music();
  const r = m.play(ann, A, bob);
  assert.ok(!('error' in r));
  const ch = m.control('ann', { t: 'tv.youtube.ended', id: playId(m, 'ann') });
  assert.deepEqual(ch!.gone.sort(), ['ann', 'bob']);
  assert.equal(m.stateOf(r.session), null);
  assert.equal(m.sessionOf('bob'), undefined);
});

test('ended with a queue goes on to the next', () => {
  const { m } = music();
  m.play(ann, A);
  m.play(ann, B, undefined, 'end');
  const ch = m.control('ann', { t: 'tv.youtube.ended', id: playId(m, 'ann') });
  assert.equal(ch!.gone.length, 0);
  assert.ok(m.stateOf(m.sessionOf('ann')!)!.state!.url.includes('bbbbbbbbbbb'));
});

test('leave: the other stays, the last one ends it', () => {
  const { m } = music();
  const r = m.play(ann, A, bob);
  assert.ok(!('error' in r));
  assert.deepEqual(m.leave('ann'), { sessions: [r.session], gone: ['ann'] });
  assert.deepEqual(m.stateOf(r.session)!.listeners, [bob]);
  assert.deepEqual(m.leave('bob'), { sessions: [], gone: ['bob'] });
  assert.equal(m.stateOf(r.session), null);
  assert.equal(m.leave('bob'), null);
});

test('controls from a non-listener, or for a stale play, do nothing', () => {
  const { m } = music();
  m.play(ann, A);
  const id = playId(m, 'ann');
  assert.equal(m.control('cy', { t: 'tv.youtube.pause', id, paused: true }), null);
  assert.equal(m.control('ann', { t: 'tv.youtube.pause', id: 'old', paused: true }), null);
  assert.equal(m.stateOf(m.sessionOf('ann')!)!.state!.paused, false);
});

test('an invalid link is an error and changes nothing', () => {
  const { m } = music();
  const first = m.play(ann, A);
  assert.ok(!('error' in first));
  assert.ok('error' in m.play(ann, 'https://example.com/x', bob));
  assert.equal(m.sessionOf('ann'), first.session);
  assert.equal(m.sessionOf('bob'), undefined);
});

test('untitled gives each thing once', () => {
  const { m } = music();
  const r = m.play(ann, A);
  assert.ok(!('error' in r));
  assert.equal(m.untitled(r.session).play?.url.includes('aaaaaaaaaaa'), true);
  assert.equal(m.untitled(r.session).play, undefined);
  assert.equal(m.titled(r.session, playId(m, 'ann'), 'Song'), true);
  assert.equal(m.stateOf(r.session)!.state!.title, 'Song');
});

test('YoutubeTv(null) never writes a file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phone-music-'));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const tv = new YoutubeTv(null);
    tv.play(A, 'x');
    tv.pause(tv.state()!.id, true, 'x');
    tv.flush();
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(existsSync('youtube-tv.json'), false);
  } finally {
    process.chdir(prev);
  }
});

// ---- Handlers ---------------------------------------------------------------------------------------

function office() {
  const sent: { to: string; msg: ServerMsg }[] = [];
  const clients = new Map<string, Client>();
  const ctx = {
    clients,
    sendTo: (c: Client, msg: ServerMsg) => sent.push({ to: c.id, msg }),
    warn: (c: Client, text?: string) => text && sent.push({ to: c.id, msg: { t: 'toast', text, level: 'warn' } }),
  } as unknown as Ctx;
  const person = (id: string, extra: Partial<Client> = {}) => {
    const c = { id, peer: { name: id.toUpperCase() }, ...extra } as unknown as Client;
    clients.set(id, c);
    return c;
  };
  const musicTo = (to: string) => sent.filter((s) => s.to === to && s.msg.t === 'phone.music').map((s) => (s.msg as Extract<ServerMsg, { t: 'phone.music' }>).music);
  return { ctx, sent, person, musicTo };
}

test('handlers: playing to someone tells both; a visitor or an unknown person is refused', () => {
  const saved = youtubeTitles.fetch;
  youtubeTitles.fetch = async () => undefined;
  clearYoutubeTitles();
  try {
    const o = office();
    const a = o.person('a');
    o.person('b');
    const v = o.person('v', { visitor: { login: 'v', floors: new Set(), projects: new Set() } });
    phoneHandlers['phone.music.play'](o.ctx, a, { t: 'phone.music.play', url: A, to: 'v' });
    phoneHandlers['phone.music.play'](o.ctx, a, { t: 'phone.music.play', url: A, to: 'nobody' });
    assert.equal(o.musicTo('a').length, 0);
    assert.equal(o.sent.filter((s) => s.msg.t === 'toast').length, 2);
    void v;
    phoneHandlers['phone.music.play'](o.ctx, a, { t: 'phone.music.play', url: A, to: 'b' });
    assert.equal(o.musicTo('a').at(-1)!.listeners.length, 2);
    assert.equal(o.musicTo('b').at(-1)!.by, 'A');
  } finally {
    youtubeTitles.fetch = saved;
  }
});

test('handlers: controls from a non-listener are ignored; closing removes the listener and tells the other', () => {
  const saved = youtubeTitles.fetch;
  youtubeTitles.fetch = async () => undefined;
  clearYoutubeTitles();
  try {
    const o = office();
    const a = o.person('a');
    const b = o.person('b');
    const c = o.person('c');
    phoneHandlers['phone.music.play'](o.ctx, a, { t: 'phone.music.play', url: A, to: 'b' });
    const id = o.musicTo('a').at(-1)!.state!.id;
    const before = o.sent.length;
    phoneHandlers['phone.music.control'](o.ctx, c, { t: 'phone.music.control', control: { t: 'tv.youtube.pause', id, paused: true } });
    assert.deepEqual(o.sent.slice(before).map((s) => [s.to, (s.msg as { music?: unknown }).music]), [['c', null]], 'only the stranger is told it has no session');
    phoneHandlers['phone.music.control'](o.ctx, b, { t: 'phone.music.control', control: { t: 'tv.youtube.pause', id, paused: true } });
    assert.equal(o.musicTo('a').at(-1)!.state!.paused, true);
    phoneHooks.closed!(o.ctx, a);
    assert.deepEqual(o.musicTo('b').at(-1)!.listeners.map((l) => l.id), ['b']);
    phoneHandlers['phone.music.leave'](o.ctx, b, { t: 'phone.music.leave' });
    assert.equal(o.musicTo('b').at(-1), null);
  } finally {
    youtubeTitles.fetch = saved;
  }
});

test('handlers: control or leave with no session tells the client it has none; a person on the 2D view is refused', () => {
  const o = office();
  const a = o.person('a');
  o.person('l', { peer: { name: 'L', lite: true } } as Partial<Client>);
  phoneHandlers['phone.music.control'](o.ctx, a, { t: 'phone.music.control', control: { t: 'tv.youtube.pause', id: 'x', paused: true } });
  assert.deepEqual(o.musicTo('a'), [null]);
  phoneHandlers['phone.music.leave'](o.ctx, a, { t: 'phone.music.leave' });
  assert.deepEqual(o.musicTo('a'), [null, null]);
  phoneHandlers['phone.music.play'](o.ctx, a, { t: 'phone.music.play', url: A, to: 'l' });
  assert.deepEqual(o.musicTo('a'), [null, null]);
  assert.equal(o.sent.filter((s) => s.msg.t === 'toast').length, 1);
});

test('multiplayer: a visitor may not use the phone music and is never sent it', () => {
  const scope: VisitorScope = { login: 'vera', floors: new Set(['s']), projects: new Set(['s']) };
  assert.equal(visitorMay({ t: 'phone.music.play', url: A }, scope), false);
  assert.equal(visitorMay({ t: 'phone.music.leave' }, scope), false);
  assert.equal(filterForVisitor({ t: 'phone.music', music: null }, scope), undefined);
});

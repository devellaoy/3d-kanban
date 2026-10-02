// 3d-kanban: the Office TV's playback controls and queue (server/youtube/tv.ts, queue.ts, saved.ts):
// pause, seek, speed, skip, the queue and history, and what survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YoutubeTv } from '../src/server/youtube/tv.js';
import { clearYoutubeTitles, lookUpYoutubeTitle, youtubeTitles } from '../src/server/youtube/titles.js';
import { QUEUE_MAX } from '../src/shared/youtube/queue.js';
import { RATES, tvPosition } from '../src/shared/youtube/link.js';

const V = (n: number) => `https://www.youtube.com/watch?v=video${String(n).padStart(6, '0')}`;
const vid = (n: number) => `video${String(n).padStart(6, '0')}`;

/** A TV on a clock the test moves, in a folder of its own. */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'youtube-tv-ctl-'));
  const clock = { now: 1_000_000 };
  let n = 0;
  let last: YoutubeTv | undefined;
  /** A TV on the folder; what the last one changed is written first (writes wait a moment). */
  const open = () => {
    last?.flush();
    return (last = new YoutubeTv(dir, () => clock.now, () => `id-${++n}`));
  };
  return { dir, clock, tv: open(), open, flush: () => last?.flush(), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function on(tv: YoutubeTv, url: string, by = 'Ada') {
  const r = tv.play(url, by);
  assert.ok('state' in r);
  return r.state;
}

test('tvPosition is pure: held when paused, carried on at its speed otherwise, never below 0', () => {
  const s = { position: 10, at: 1000, rate: 2, paused: false };
  assert.equal(tvPosition(s, 1000), 10);
  assert.equal(tvPosition(s, 4000), 16);
  assert.equal(tvPosition({ ...s, rate: 0.5 }, 5000), 12);
  assert.equal(tvPosition({ ...s, paused: true }, 99_000), 10);
  assert.equal(tvPosition(s, 0), 8);
  assert.equal(tvPosition({ ...s, position: 1 }, -10_000), 0);
});

test('pause freezes where it is, elapsed does not move it, and resume goes on from there', () => {
  const { tv, clock, done } = setup();
  try {
    const s = on(tv, V(1));
    clock.now += 7000;
    assert.equal(tv.pause(s.id, true, 'Bo'), true);
    let p = tv.state()!;
    assert.deepEqual([p.paused, p.position, p.at, p.pausedBy], [true, 7, clock.now, 'Bo']);
    assert.equal(tv.pause(s.id, true, 'Cy'), false, 'already paused');
    clock.now += 60_000;
    p = tv.state()!;
    assert.equal(p.elapsed, 60_000);
    assert.equal(tvPosition(p, clock.now), 7, 'still where it was');
    assert.equal(tv.pause(s.id, false, 'Bo'), true);
    p = tv.state()!;
    assert.deepEqual([p.paused, p.position, p.pausedBy], [false, 7, undefined]);
    clock.now += 3000;
    assert.equal(tvPosition(tv.state()!, clock.now), 10);
  } finally {
    done();
  }
});

test('seek to or by, kept within the start and (once known) the length', () => {
  const { tv, clock, done } = setup();
  try {
    const s = on(tv, V(1));
    clock.now += 10_000;
    assert.equal(tv.seek(s.id, 100, undefined), true);
    assert.deepEqual([tv.state()!.position, tv.state()!.at], [100, clock.now]);
    clock.now += 5000;
    assert.equal(tv.seek(s.id, undefined, -30), true);
    assert.equal(tv.state()!.position, 75, 'by is from where it is now: 105 - 30');
    assert.equal(tv.seek(s.id, -5, undefined), true);
    assert.equal(tv.state()!.position, 0);
    assert.equal(tv.seek(s.id, 'x', undefined), false);
    assert.equal(tv.seek(s.id, undefined, undefined), false);
    assert.equal(tv.info(s.id, 200, undefined), true);
    tv.seek(s.id, 999, undefined);
    assert.equal(tv.state()!.position, 200);
    tv.pause(s.id, true, 'Bo');
    tv.seek(s.id, undefined, -50);
    assert.deepEqual([tv.state()!.position, tv.state()!.paused], [150, true], 'a seek while paused stays paused');
  } finally {
    done();
  }
});

test('a speed change freezes first, only the known speeds are taken', () => {
  const { tv, clock, done } = setup();
  try {
    const s = on(tv, V(1));
    clock.now += 4000;
    assert.equal(tv.rate(s.id, 2), true);
    assert.deepEqual([tv.state()!.position, tv.state()!.at, tv.state()!.rate], [4, clock.now, 2]);
    clock.now += 4000;
    assert.equal(tvPosition(tv.state()!, clock.now), 12);
    for (const bad of [3, 0, 1.1, '1', null, NaN]) assert.equal(tv.rate(s.id, bad), false, String(bad));
    assert.equal(tv.rate(s.id, 2), false, 'no change');
    for (const r of RATES) assert.equal(tv.rate(s.id, r) || r === 2, true);
  } finally {
    done();
  }
});

test("a control for an older play is ignored, and a play's info is taken once", () => {
  const { tv, done } = setup();
  try {
    const first = on(tv, V(1));
    const second = on(tv, V(2));
    assert.equal(tv.pause(first.id, true, 'Bo'), false);
    assert.equal(tv.seek(first.id, 5, undefined), false);
    assert.equal(tv.rate(first.id, 2), false);
    assert.equal(tv.skip(first.id, 1), null);
    assert.equal(tv.info(first.id, 100, undefined), false);
    assert.equal(tv.jump('nope'), false);
    assert.equal(tv.state()!.paused, false);
    assert.equal(tv.info(second.id, 100, 7), true);
    assert.equal(tv.info(second.id, 5, 9), false, 'the first to say counts');
    assert.equal(tv.state()!.duration, 100);
    assert.equal(tv.state()!.listLength, undefined, 'a video has no list');
  } finally {
    done();
  }
});

test('the queue: add to the end or the front, an empty TV starts at once, move, remove, jump, clear, and a cap', () => {
  const { tv, done } = setup();
  try {
    const started = tv.play(V(1), 'Ada', 'end');
    assert.ok('state' in started && !started.queued, 'nothing on: it plays');
    const q = (url: string, where: 'end' | 'next') => {
      const r = tv.play(url, 'Bo', where);
      assert.ok('queued' in r && r.queued);
      return r.queued;
    };
    const b = q(V(2), 'end');
    const c = q(V(3), 'end');
    const d = q(V(4), 'next');
    const ids = () => tv.list().queue.map((i) => i.videoId);
    assert.deepEqual(ids(), [vid(4), vid(2), vid(3)]);
    assert.equal(tv.state()!.videoId, vid(1), 'queuing leaves what is on alone');
    assert.equal(tv.move(c.qid, 0), true);
    assert.deepEqual(ids(), [vid(3), vid(4), vid(2)]);
    assert.equal(tv.move(c.qid, 99), true);
    assert.deepEqual(ids(), [vid(4), vid(2), vid(3)]);
    assert.equal(tv.move('nope', 0), false);
    assert.equal(tv.remove(b.qid)?.videoId, vid(2));
    assert.equal(tv.remove(b.qid), undefined);
    assert.equal(tv.jump(c.qid), true);
    assert.equal(tv.state()!.videoId, vid(3));
    assert.equal(tv.state()!.position, 0);
    assert.deepEqual(ids(), [vid(4)]);
    assert.equal(tv.list().back, true, 'what was on went to the history');
    assert.equal(tv.clear(), true);
    assert.equal(tv.clear(), false);
    assert.equal(d.qid.length > 0, true);
    for (let i = 0; i < QUEUE_MAX; i++) assert.ok('queued' in tv.play(V(100 + i), 'Bo', 'end'));
    assert.deepEqual(tv.play(V(999), 'Bo', 'end'), { error: 'The TV queue is full' });
    assert.equal(tv.list().queue.length, QUEUE_MAX);
    assert.deepEqual(tv.play('https://vimeo.com/1', 'Bo', 'end'), { error: "That isn't a YouTube link" });
  } finally {
    done();
  }
});

test("when what's on ends the queue's first plays, else the TV goes dark; the played go to the history", () => {
  const { tv, clock, done } = setup();
  try {
    const first = on(tv, V(1));
    tv.play(V(2), 'Bo', 'end');
    tv.play(V(3), 'Cy', 'end');
    clock.now += 500;
    assert.equal(tv.ended(first.id, false), 'queue');
    let s = tv.state()!;
    assert.deepEqual([s.videoId, s.by, s.position, s.at, s.paused, s.rate], [vid(2), 'Bo', 0, clock.now, false, 1]);
    assert.notEqual(s.id, first.id);
    assert.equal(tv.ended(first.id, false), null, 'said again by a slower browser');
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), [vid(3)]);
    assert.equal(tv.ended(s.id, false), 'queue');
    s = tv.state()!;
    assert.equal(tv.ended(s.id, false), 'stopped');
    assert.equal(tv.state(), null);
    assert.equal(tv.list().back, true);
  } finally {
    done();
  }
});

test('skip forward: through a YouTube playlist (up to its length), then the queue, then off', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/playlist?list=PLabc123');
    tv.info(l.id, undefined, 2);
    tv.play(V(5), 'Bo', 'end');
    assert.equal(tv.skip(l.id, 1), 'list');
    const second = tv.state()!;
    assert.deepEqual([second.index, second.position, second.listLength, second.videoId], [1, 0, 2, undefined]);
    tv.info(second.id, undefined, 2);
    assert.equal(tv.skip(second.id, 1), 'queue', 'on the last video of the list');
    assert.equal(tv.state()!.videoId, vid(5));
    assert.equal(tv.skip(tv.state()!.id, 1), 'stopped');
    assert.equal(tv.state(), null);
    // Without knowing the length it tries the next video of the list.
    const u = on(tv, 'https://www.youtube.com/playlist?list=PLabc123');
    assert.equal(tv.skip(u.id, 1), 'list');
  } finally {
    done();
  }
});

test('skip back: through a playlist, then to the last played (what was on is queued first), else to the start', () => {
  const { tv, clock, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=2');
    assert.equal(tv.skip(l.id, -1), 'list');
    assert.equal(tv.state()!.index, 0);
    const a = tv.state()!;
    clock.now += 9000;
    assert.equal(tv.skip(a.id, -1), 'restart', 'nothing came before');
    assert.deepEqual([tv.state()!.id, tv.state()!.position, tv.state()!.at], [a.id, 0, clock.now]);
    const one = on(tv, V(1));
    const two = on(tv, V(2));
    assert.notEqual(one.id, two.id);
    assert.equal(tv.skip(two.id, -1), 'history');
    assert.equal(tv.state()!.videoId, vid(1));
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), [vid(2)], 'what was on waits at the front');
    assert.equal(tv.skip(tv.state()!.id, 1), 'queue');
    assert.equal(tv.state()!.videoId, vid(2));
  } finally {
    done();
  }
});

test('unpack: the rest of the playlist goes to the front of the queue, what plays carries on as its own video', () => {
  const { tv, clock, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=2');
    tv.play(V(9), 'Bo', 'end');
    tv.info(l.id, 240, 4);
    clock.now += 5000;
    const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'];
    for (const bad of [
      tv.unpack(l.id, ['short'], 0, 'short', 1),
      tv.unpack('stale', ids, 1, 'bbbbbbbbbbb', 1),
      tv.unpack(l.id, Array.from({ length: 102 }, () => 'aaaaaaaaaaa'), 0, 'aaaaaaaaaaa', 1),
      tv.unpack(l.id, ids, 4, 'bbbbbbbbbbb', 1),
      tv.unpack(l.id, ids, -1, 'bbbbbbbbbbb', 1),
      tv.unpack(l.id, ids, 1.5, 'bbbbbbbbbbb', 1),
    ]) assert.ok('error' in bad && bad.error);
    assert.ok('error' in tv.unpack(l.id, ids, 1, 'ccccccccccc', 1), 'the player is not where it says');
    assert.equal(tv.state()!.list, 'PLabc123', 'a refusal changes nothing');
    const added = tv.unpack(l.id, ids, 1, 'bbbbbbbbbbb', 1);
    assert.ok(Array.isArray(added));
    assert.deepEqual(added.map((i) => i.videoId), ['ccccccccccc', 'ddddddddddd']);
    const s = tv.state()!;
    assert.deepEqual([s.id, s.videoId, s.list, s.index, s.listLength, s.duration, s.position, s.at], [l.id, 'bbbbbbbbbbb', undefined, undefined, undefined, 240, 0, l.at]);
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), ['ccccccccccc', 'ddddddddddd', vid(9)]);
    assert.ok('error' in tv.unpack(l.id, ids, 1, 'bbbbbbbbbbb', 1), 'a single video has no list to unpack');
  } finally {
    done();
  }
});

test('unpack: a player that has gone on to another video than the office knows is refused, and nothing changes', () => {
  const { tv, done } = setup();
  try {
    // The office has it at index 0 (position, start and duration are that video's), the player is at index 2.
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=1');
    const before = JSON.stringify([tv.state(), tv.list()]);
    const r = tv.unpack(l.id, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'], 2, 'ccccccccccc', 2);
    assert.ok('error' in r && r.error);
    assert.equal(JSON.stringify([tv.state(), tv.list()]), before);
    const ok = tv.unpack(l.id, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], 0, 'aaaaaaaaaaa', 0);
    assert.ok(Array.isArray(ok));
    assert.deepEqual(ok.map((i) => i.videoId), ['bbbbbbbbbbb', 'ccccccccccc']);
  } finally {
    done();
  }
});

test('unpack: a full queue keeps every queued video, only what fits is added', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=1');
    for (let i = 0; i < QUEUE_MAX - 1; i++) tv.play(V(i), 'Bo', 'end');
    const old = tv.list().queue.map((i) => i.qid);
    const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
    const added = tv.unpack(l.id, ids, 0, 'aaaaaaaaaaa', 0);
    assert.ok(Array.isArray(added));
    assert.deepEqual(added.map((i) => i.videoId), ['bbbbbbbbbbb']);
    const queue = tv.list().queue;
    assert.equal(queue.length, QUEUE_MAX);
    assert.deepEqual(queue.slice(1).map((i) => i.qid), old, 'no queued video is lost');
  } finally {
    done();
  }
});

test('unpack: with no room at all it is refused and the playlist stays', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=1');
    for (let i = 0; i < QUEUE_MAX; i++) tv.play(V(i), 'Bo', 'end');
    const r = tv.unpack(l.id, ['aaaaaaaaaaa', 'bbbbbbbbbbb'], 0, 'aaaaaaaaaaa', 0);
    assert.ok('error' in r && r.error);
    assert.equal(tv.state()!.list, 'PLabc123');
    assert.equal(tv.list().queue.length, QUEUE_MAX);
  } finally {
    done();
  }
});

test('skip back with a full queue: what was on is left out, no queued video is lost', () => {
  const { tv, done } = setup();
  try {
    on(tv, V(1));
    on(tv, V(2));
    for (let i = 10; i < 10 + QUEUE_MAX; i++) tv.play(V(i), 'Bo', 'end');
    assert.equal(tv.list().queue.length, QUEUE_MAX);
    const before = tv.list().queue.map((i) => i.qid);
    assert.equal(tv.skip(tv.state()!.id, -1), 'history');
    assert.equal(tv.state()!.videoId, vid(1));
    assert.deepEqual(tv.list().queue.map((i) => i.qid), before);
  } finally {
    done();
  }
});

test('ended with next never goes past the end of a playlist whose length is known', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=3');
    tv.play(V(9), 'Bo', 'end');
    tv.info(l.id, undefined, 3);
    assert.equal(tv.ended(l.id, true), 'queue', 'index 3 of 3 is past the end');
    assert.equal(tv.state()!.videoId, vid(9));
    const m = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=2');
    tv.info(m.id, undefined, 3);
    assert.equal(tv.ended(m.id, true), 'next');
    assert.equal(tv.state()!.index, 2);
    const u = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=2');
    assert.equal(tv.ended(u.id, true), 'next', 'length unknown: tried');
    assert.equal(tv.state()!.index, 2);
  } finally {
    done();
  }
});

test('a restart keeps the paused play, the queue, the history and the volume setting', () => {
  const { tv, clock, open, dir, done } = setup();
  try {
    const one = on(tv, V(1));
    tv.play(V(2), 'Bo', 'end');
    const two = on(tv, V(3), 'Cy');
    tv.play(V(4), 'Bo', 'end');
    assert.ok(one.id);
    clock.now += 2000;
    tv.rate(two.id, 1.5);
    tv.pause(two.id, true, 'Di');
    tv.setSameVolume(true);
    assert.equal(tv.setSameVolume(true), false);
    tv.info(two.id, 300, undefined);
    const again = open();
    assert.deepEqual(again.state(), tv.state());
    assert.deepEqual(again.list(), tv.list());
    assert.deepEqual(again.list().sameVolume, true);
    assert.equal(again.list().back, true);
    assert.equal(again.state()!.paused, true);
    tv.flush();
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'youtube-tv.json'), 'utf8')).version, 2);
  } finally {
    done();
  }
});

test('a youtube-tv.json from before the controls (url + startedAt) still loads', () => {
  const { dir, clock, open, done } = setup();
  try {
    writeFileSync(path.join(dir, 'youtube-tv.json'), JSON.stringify({ videoId: 'dQw4w9WgXcQ', start: 30, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', id: 'old', by: 'Ada', startedAt: 990_000, title: 'Old one' }));
    const s = open().state()!;
    assert.deepEqual([s.id, s.position, s.at, s.rate, s.paused, s.title, s.by, s.elapsed], ['old', 30, 990_000, 1, false, 'Old one', 'Ada', clock.now - 990_000]);
    assert.deepEqual(open().list(), { queue: [], back: false, sameVolume: false });
    writeFileSync(path.join(dir, 'youtube-tv.json'), JSON.stringify({ version: 2, now: { url: 'https://vimeo.com/1', at: 1 }, queue: [{ url: 'nope' }, { url: V(1), qid: 'q1', by: 'Bo' }], history: 'x', sameVolume: 'yes' }));
    const bad = open();
    assert.equal(bad.state(), null);
    assert.deepEqual(bad.list().queue.map((i) => i.qid), ['q1']);
    assert.equal(bad.list().sameVolume, false);
  } finally {
    done();
  }
});

test("an end said while it's paused is dropped (a late one from before the pause), a blocked video still comes off", () => {
  const { tv, clock, done } = setup();
  try {
    const first = on(tv, V(1));
    tv.play(V(2), 'Bo', 'end');
    clock.now += 1000;
    assert.ok(tv.pause(first.id, true, 'Ada'));
    // The end a browser sent just before the pause reaches the office after it: what's on stays on, paused.
    assert.equal(tv.ended(first.id, false), null);
    assert.equal(tv.ended(first.id, true), null);
    let s = tv.state()!;
    assert.deepEqual([s.id, s.paused, s.videoId], [first.id, true, vid(1)]);
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), [vid(2)], 'the queue is left alone');
    // Played on, the end counts again.
    assert.ok(tv.pause(first.id, false, 'Ada'));
    assert.equal(tv.ended(first.id, false), 'queue');
    s = tv.state()!;
    assert.ok(tv.pause(s.id, true, 'Ada'));
    // YouTube won't play it here: off it goes even paused.
    assert.equal(tv.ended(s.id, false, true), 'stopped');
    assert.equal(tv.state(), null);
  } finally {
    done();
  }
});

test('a seek with no length known stops at a sane maximum', () => {
  const { tv, done } = setup();
  try {
    const s = on(tv, V(1));
    assert.equal(tv.seek(s.id, 1e12, undefined), true);
    assert.equal(tv.state()!.position, 1e6);
    assert.equal(tv.seek(s.id, undefined, 1e12), true);
    assert.equal(tv.state()!.position, 1e6);
  } finally {
    done();
  }
});

test('info: a larger length replaces a smaller one, a smaller never replaces a larger', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=1');
    assert.equal(tv.info(l.id, 100, 5), true);
    assert.equal(tv.info(l.id, 150, 8), true, 'a larger one replaces');
    assert.deepEqual([tv.state()!.duration, tv.state()!.listLength], [150, 8]);
    assert.equal(tv.info(l.id, 90, 3), false, 'a smaller one does not');
    assert.equal(tv.info(l.id, 150, 8), false, 'the same is nothing new');
    assert.equal(tv.info(l.id, 1e6, 6000), false, 'out of range');
    assert.deepEqual([tv.state()!.duration, tv.state()!.listLength], [150, 8]);
  } finally {
    done();
  }
});

test('adding to the queue of a dark TV with a queue starts the queue first, not the new video; with an empty queue it plays at once', () => {
  const { tv, done } = setup();
  try {
    tv.play(V(1), 'Ada', 'end');
    tv.play(V(2), 'Ada', 'end');
    tv.stop();
    assert.equal(tv.state(), null);
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), [vid(2)]);
    const r = tv.play(V(3), 'Bo', 'end');
    assert.ok('state' in r && r.queued && r.started);
    assert.equal(tv.state()!.videoId, vid(2), 'the queue was first in line');
    assert.deepEqual(tv.list().queue.map((i) => i.videoId), [vid(3)]);
    tv.stop();
    tv.clear();
    const e = tv.play(V(4), 'Bo', 'end');
    assert.ok('state' in e && !e.queued && !e.started);
    assert.equal(tv.state()!.videoId, vid(4));
  } finally {
    done();
  }
});

test('⏮️ means the last one played: a stop and a skip or end with an empty queue remember it too, once', () => {
  const { tv, done } = setup();
  try {
    on(tv, V(1));
    assert.equal(tv.stop(), true);
    assert.equal(tv.list().back, true, 'stopped');
    const b = on(tv, V(2));
    assert.equal(tv.skip(b.id, 1), 'stopped');
    assert.equal(tv.state(), null);
    const c = on(tv, V(3));
    assert.equal(tv.ended(c.id, false), 'stopped');
    // The three went to the history once each, in order: back from a fourth plays the third, then the second, then the first.
    const d = on(tv, V(4));
    assert.equal(tv.skip(d.id, -1), 'history');
    assert.equal(tv.state()!.videoId, vid(3));
    assert.equal(tv.skip(tv.state()!.id, -1), 'history');
    assert.equal(tv.state()!.videoId, vid(2), 'the history goes on: the second one, then the first');
    assert.equal(tv.skip(tv.state()!.id, -1), 'history');
    assert.equal(tv.state()!.videoId, vid(1));
    assert.equal(tv.skip(tv.state()!.id, -1), 'restart', 'nothing before the first');
  } finally {
    done();
  }
});

test('unpack takes the playing video and up to a full queue after it, the first being where the player is', () => {
  const { tv, done } = setup();
  try {
    const l = on(tv, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLabc123&index=3');
    const ids = Array.from({ length: 101 }, (_, i) => vid(i));
    assert.ok('error' in tv.unpack(l.id, [...ids, vid(101)], 0, vid(0), 2), 'one more than the playing and a full queue');
    const added = tv.unpack(l.id, ids, 0, vid(0), 2);
    assert.ok(Array.isArray(added));
    assert.equal(added.length, 100);
    assert.equal(tv.state()!.videoId, vid(0));
  } finally {
    done();
  }
});

test('changes are written once a moment later, and flush writes at once', async () => {
  const { tv, dir, done } = setup();
  try {
    const file = path.join(dir, 'youtube-tv.json');
    const s = on(tv, V(1));
    tv.pause(s.id, true, 'Bo');
    tv.setSameVolume(true);
    assert.throws(() => readFileSync(file), 'nothing written yet');
    await new Promise((r) => setTimeout(r, 400));
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('\n'), false, 'compact');
    const saved = JSON.parse(text);
    assert.deepEqual([saved.now.paused, saved.sameVolume], [true, true], 'the burst is one write with everything');
    tv.stop();
    tv.flush();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).now, null);
  } finally {
    done();
  }
});

test('titles are remembered by url (through the swappable fetch), a failure is asked again, and the cache is bounded', async () => {
  const real = youtubeTitles.fetch;
  const asked: string[] = [];
  let fail = true;
  youtubeTitles.fetch = async (url) => {
    asked.push(url);
    return fail && url === 'u-fail' ? undefined : `Title of ${url}`;
  };
  clearYoutubeTitles();
  try {
    assert.equal(await lookUpYoutubeTitle('u1'), 'Title of u1');
    assert.equal(await lookUpYoutubeTitle('u1'), 'Title of u1');
    assert.deepEqual(asked, ['u1'], 'the second is from memory');
    assert.equal(await lookUpYoutubeTitle('u-fail'), undefined);
    fail = false;
    assert.equal(await lookUpYoutubeTitle('u-fail'), 'Title of u-fail', 'a failure is not remembered');
    for (let i = 0; i < 520; i++) await lookUpYoutubeTitle(`bulk-${i}`);
    asked.length = 0;
    await lookUpYoutubeTitle('u1');
    assert.deepEqual(asked, ['u1'], 'the oldest were let go');
    await lookUpYoutubeTitle('bulk-519');
    assert.deepEqual(asked, ['u1'], 'the newest are kept');
  } finally {
    youtubeTitles.fetch = real;
    clearYoutubeTitles();
  }
});

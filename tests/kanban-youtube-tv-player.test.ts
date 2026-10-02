// 3d-kanban: when the Office TV's player can be trusted with the office's clock (client/youtube/follow.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedByClock, endedByPlayer, onOfficeVideo, pastPlaylistEnd, timingChanged } from '../src/client/youtube/follow.js';

const single = { videoId: 'aaaaaaaaaaa', rate: 1 };

test('onOfficeVideo: a playlist play needs the same index, a single video the same id', () => {
  const list = { list: 'PLx', index: 1, rate: 1 };
  assert.equal(onOfficeVideo(list, { index: 1, videoId: 'x' }), true);
  assert.equal(onOfficeVideo(list, { index: 0, videoId: 'x' }), false);
  assert.equal(onOfficeVideo({ list: 'PLx', rate: 1 }, { index: 0 }), true);
  assert.equal(onOfficeVideo(single, { index: 0, videoId: 'aaaaaaaaaaa' }), true);
  assert.equal(onOfficeVideo(single, { index: 0, videoId: 'bbbbbbbbbbb' }), false);
});

test('endedByClock: the timeline ends a video only for a player at the office speed on the same video', () => {
  const p = { rate: 1, index: 0, videoId: 'aaaaaaaaaaa' };
  assert.equal(endedByClock(single, 120, 120, p), true);
  assert.equal(endedByClock(single, 120, 60, p), false);
  // The office asks 2×, the player only does 1×: the timeline is at 120 s after 60 real seconds, the video is not.
  assert.equal(endedByClock({ ...single, rate: 2 }, 120, 120, p), false);
  assert.equal(endedByClock({ ...single, rate: 2 }, 120, 120, { ...p, rate: 2 }), true);
  assert.equal(endedByClock(single, 120, 120, { ...p, videoId: 'bbbbbbbbbbb' }), false, 'still the last video');
  assert.equal(endedByClock(single, 0, 120, p), false, 'no duration known');
  assert.equal(endedByClock({ list: 'PLx', index: 0, rate: 1 }, 120, 120, p), false, 'a playlist goes on by its own events');
});

test('endedByPlayer: a video that ends right after it loads, at a speed the player cannot do, still ends once the guard has passed', () => {
  // Started at its very end, the office at 2×, the player at 1×: the clock never says it's over, so the player's ENDED must.
  const y = { ...single, rate: 2 };
  const p = { rate: 1, index: 0, videoId: 'aaaaaaaaaaa' };
  assert.equal(endedByClock(y, 120, 119.8, p), false);
  assert.equal(endedByPlayer(y, false, p), false, 'not while the last play’s late events are held back');
  assert.equal(endedByPlayer(y, true, p), true, 'a later sync says it is over');
  assert.equal(endedByPlayer(y, true, { ...p, videoId: 'bbbbbbbbbbb' }), false, 'the last video, not this one');
  assert.equal(endedByPlayer({ list: 'PLx', index: 1, rate: 2 }, true, { ...p, index: 0 }), false, 'still on the playlist’s previous video');
});

test('timingChanged: a pause, a resume or a seek of the same play is a change, so an end the office dropped while paused is told again', () => {
  const y = { id: 'p1', position: 100, at: 5000, rate: 1, paused: false };
  assert.equal(timingChanged(null, y), true, 'a play not followed yet');
  assert.equal(timingChanged(y, { ...y }), false, 'a title or a length told later is not a change of timing');
  assert.equal(timingChanged(y, { ...y, id: 'p2' }), true);
  assert.equal(timingChanged(y, { ...y, rate: 2 }), true);
  assert.equal(timingChanged(y, { ...y, position: 10, at: 9000 }), true, 'a seek');

  // What screen.ts does with it: the end said, then dropped while the play was paused, then the play goes on.
  const told = new Set<string>();
  let followed: typeof y | null = null;
  const sync = (now: typeof y, over: boolean) => {
    if (timingChanged(followed, now)) told.delete(now.id);
    followed = now;
    if (!over || told.has(now.id) || now.paused) return false;
    told.add(now.id);
    return true;
  };
  assert.equal(sync(y, true), true, 'said once');
  assert.equal(sync(y, true), false, 'not again while nothing changed');
  const paused = { ...y, paused: true, position: 120, at: 6000 };
  assert.equal(sync(paused, true), false, 'the end landed while paused: the office drops it');
  assert.equal(sync({ ...paused, paused: false, at: 8000 }, true), true, 'resumed: it is over, so it is said again');
  assert.equal(sync({ ...paused, paused: false, at: 8000 }, true), false);
});

test('pastPlaylistEnd: a known length with no video at the index is the end', () => {
  assert.equal(pastPlaylistEnd(3, 3), true);
  assert.equal(pastPlaylistEnd(2, 3), false);
  assert.equal(pastPlaylistEnd(5, undefined), false, 'not known yet');
  assert.equal(pastPlaylistEnd(5, 0), false);
});

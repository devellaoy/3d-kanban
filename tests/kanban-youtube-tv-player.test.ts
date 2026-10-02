// 3d-kanban: when the Office TV's player can be trusted with the office's clock (client/youtube/follow.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedByClock, endedByPlayer, onOfficeVideo } from '../src/client/youtube/follow.js';

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
  assert.equal(endedByPlayer(y, true, false, p), false, 'not while the last play’s late events are held back');
  assert.equal(endedByPlayer(y, true, true, p), true, 'a later sync says it is over');
  assert.equal(endedByPlayer(y, false, true, p), false, 'still playing');
  assert.equal(endedByPlayer(y, true, true, { ...p, videoId: 'bbbbbbbbbbb' }), false, 'the last video, not this one');
  assert.equal(endedByPlayer({ list: 'PLx', index: 1, rate: 2 }, true, true, { ...p, index: 0 }), false, 'still on the playlist’s previous video');
});

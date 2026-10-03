import test from 'node:test';
import assert from 'node:assert/strict';
import { BALCONY_DOOR, BOOKSHELF, FLOOR, WALL_HEIGHT, WINDOWS, LOFT } from '../src/shared/layout.js';
import { CONSTELLATION, LED_WAVE, PRINTS, SCULPTURE } from '../src/shared/art.js';

const SOUTH = [...WINDOWS.filter((o) => o.wall === 'south'), BALCONY_DOOR];

test('the art on the south wall hangs clear of its windows, the balcony doors, the bookshelf and the loft', () => {
  const pieces = [{ name: 'the LED wave', x: LED_WAVE.x, w: LED_WAVE.width, y0: LED_WAVE.y, y1: LED_WAVE.y + LED_WAVE.height }, ...PRINTS.map((p, i) => ({ name: `print ${i + 1}`, x: p.x, w: p.width, y0: p.y - p.height / 2, y1: p.y + p.height / 2 }))];
  for (const p of pieces) {
    assert.ok(p.x - p.w / 2 > FLOOR.minX && p.x + p.w / 2 < FLOOR.maxX, `${p.name} is on the wall`);
    assert.ok(p.y1 < WALL_HEIGHT - 0.5, `${p.name} is under the cove light`);
    for (const o of SOUTH) {
      const across = p.x - p.w / 2 < o.u + o.width / 2 && p.x + p.w / 2 > o.u - o.width / 2;
      if (across) assert.ok(p.y0 > o.y1 + 0.2, `${p.name} is over the opening at ${o.u}, not in it`);
    }
    if (p.y0 < 2.4) assert.ok(p.x + p.w / 2 < BOOKSHELF.x - BOOKSHELF.width / 2 || p.x - p.w / 2 > BOOKSHELF.x + BOOKSHELF.width / 2, `${p.name} is clear of the bookshelf`);
    assert.ok(p.x + p.w / 2 < LOFT.minX || p.y0 > LOFT.y, `${p.name} doesn’t go behind the loft’s stairs or room`);
  }
});

test('the light installation hangs above head height, over the floor, and the sculpture is inside the room', () => {
  assert.ok(CONSTELLATION.lowest >= 3.9);
  assert.ok(CONSTELLATION.x - CONSTELLATION.spread > FLOOR.minX && CONSTELLATION.x + CONSTELLATION.spread < FLOOR.maxX);
  assert.ok(SCULPTURE.x - SCULPTURE.plinth > FLOOR.minX && SCULPTURE.x + SCULPTURE.plinth < FLOOR.maxX && SCULPTURE.height < 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DAY_LAMPS, MAX_PANES, SUN_SPLIT, daylightAt, lampCover, lightRoom, paneOf, panes, roomLampHour, roomLevel, roomUniforms, type RoomLamp } from '../src/client/world/roomlight.js';
import { BALCONY_DOOR, FLOOR, LOFT, MEETING_ROOM, WALL_HEIGHT, WINDOWS, WING } from '../src/shared/layout.js';

// The light indoors (#81, client/world/roomlight.ts): the room's own lamps and the daylight through its
// windows, in the numbers the shader mirrors.

const UP = { x: 0, y: 1, z: 0 };
/** A pendant over the first desk cluster, as the room hangs it (world/office/props.ts pendantLight). */
const lamp = (level = 1): RoomLamp => ({ x: -10.5, y: 3.9, z: -4, reach: 11, color: new THREE.Color('#ffe2b8'), power: 3.2, level, floor: 0, top: WALL_HEIGHT });
/** The floor in the north-east corner, by the elevator: no window and no lamp near it. */
const CORNER = { x: FLOOR.maxX - 1, y: 0, z: FLOOR.minZ + 1 };

test('daylight comes in through the windows, and falls off into the room', () => {
  const list = panes(0);
  const west = WINDOWS.find((o) => o.wall === 'west')!;
  const near = daylightAt({ x: FLOOR.minX + 1, y: 0, z: west.u }, UP, list);
  const mid = daylightAt({ x: FLOOR.minX + 6, y: 0, z: west.u }, UP, list);
  const far = daylightAt(CORNER, UP, list);
  assert.ok(near > mid && mid > far, `near ${near.toFixed(2)} > mid ${mid.toFixed(2)} > far ${far.toFixed(2)}`);
  assert.ok(near > 0.6, `the floor under a window is in the daylight (${near.toFixed(2)})`);
  assert.ok(far < 0.15, `a corner with no window gets next to none (${far.toFixed(2)})`);
});

test('a wall facing the windows takes more of their light than one turned away from them', () => {
  const list = panes(0);
  const at = { x: -10, y: 1.5, z: 0 };
  const facing = daylightAt(at, { x: -1, y: 0, z: 0 }, list);
  const away = daylightAt(at, { x: 1, y: 0, z: 0 }, list);
  assert.ok(facing > away, `${facing.toFixed(2)} > ${away.toFixed(2)}`);
});

test('a lamp lights what is round it, as far as it reaches, and nothing once it is switched off', () => {
  const under = { x: -10.5, y: 0, z: -4 };
  assert.ok(lampCover(under, [lamp()]) > 0.6);
  assert.equal(lampCover({ x: 5, y: 0, z: 8 }, [lamp()]), 0);
  assert.equal(lampCover(under, [lamp(0)]), 0);
  assert.ok(lampCover(under, [lamp(0.5)]) < lampCover(under, [lamp()]));
});

test('no corner is ever pitch black, and nowhere is brighter than full', () => {
  assert.ok(roomLevel(CORNER, [], 0, panes(0)) >= 0.15);
  assert.ok(roomLevel({ x: -10.5, y: 0, z: -4 }, [lamp(), lamp(), lamp()], 1, panes(0)) <= 1);
  // At night, lamps off, the room is as dark as it gets; the lamps on light it up.
  const dark = roomLevel({ x: -10.5, y: 1, z: -4 }, [lamp(0)], 0.1, panes(0));
  const lit = roomLevel({ x: -10.5, y: 1, z: -4 }, [lamp()], 0.1, panes(0));
  assert.ok(lit > dark + 0.4, `${dark.toFixed(2)} → ${lit.toFixed(2)}`);
});

test('the glass is the windows, the balcony doors and the back office’s windows once it is built', () => {
  assert.equal(panes(0).length, WINDOWS.length + 1);
  assert.equal(panes(WING.rows).length, Math.min(MAX_PANES, WINDOWS.length + 1 + WING.rows));
  const door = paneOf(BALCONY_DOOR);
  // In the south wall: thin across it, as wide as the doors along it.
  assert.ok(door.half.z < door.half.x);
  assert.equal(door.half.x, BALCONY_DOOR.width / 2);
  assert.ok(door.at.z > FLOOR.maxZ);
});

test('the lamps come up as it gets dark: less of their light at noon than at night', () => {
  const under = { x: -10.5, y: 0, z: -4 };
  lightRoom([lamp()], 0);
  const noon = lampCover(under, [lamp()]);
  assert.equal(roomLampHour(), DAY_LAMPS);
  assert.equal(roomUniforms.skyRoomLampColors.value[0].w, DAY_LAMPS);
  lightRoom([lamp()], 1);
  const night = lampCover(under, [lamp()]);
  assert.ok(noon < night, `${noon.toFixed(2)} < ${night.toFixed(2)}`);
  assert.equal(roomUniforms.skyRoomLampColors.value[0].w, 1);
});

test('only the lamps that are on go into the shader', () => {
  lightRoom([lamp(0), lamp(), lamp(0)], 1);
  assert.equal(roomUniforms.skyRoomLampCount.value, 1);
});

test('a lamp lights its own storey: the meeting room’s lights don’t shine up through the boss office’s floor', () => {
  lightRoom([], 1);
  const H = MEETING_ROOM.height;
  const x = (MEETING_ROOM.minX + MEETING_ROOM.maxX) / 2;
  const z = (MEETING_ROOM.minZ + MEETING_ROOM.maxZ) / 2;
  const meeting: RoomLamp = { x, y: H - 0.1, z, reach: 5, color: new THREE.Color('#ffe2b8'), power: 1.2, level: 1, floor: 0, top: H };
  assert.ok(lampCover({ x, y: 0.8, z }, [meeting]) > 0.3, 'the table under them');
  assert.equal(lampCover({ x, y: LOFT.y, z }, [meeting]), 0, 'the boss office’s floor over them');
});

test('indoors the sun’s light is made the lamps’, in the sun’s shadows, wherever the sun is', () => {
  // three's line that darkens the sun in its shadows keeps the shadow apart (skyShade) instead…
  assert.ok(!SUN_SPLIT.includes('directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap'));
  assert.ok(SUN_SPLIT.includes('skyShade = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]'));
  // …and inside the room the light is the lamps' in those shadows, before it lights anything.
  const dir = SUN_SPLIT.slice(SUN_SPLIT.indexOf('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'));
  const mix = dir.indexOf('directLight.color = mix( directLight.color, skyLampSun * skyCover * skyShade * skyLampIn, skyRoom );');
  assert.ok(mix > dir.indexOf('directLight.color *= skyShade;') && mix < dir.indexOf('RE_Direct( directLight'));
});

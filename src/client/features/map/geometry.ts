import { FLOOR, ROAD } from '../../../shared/layout';
import { LOT } from '../../../shared/garage';
import { CAMP, FARM, LAKE, LIGHTHOUSE, LOOP, MOUNTAINS, PIER, STREET_END, STREET_Z, TUNNEL, VIEWPOINT, shoreX, type Place } from '../../../shared/scenic';
import { SPOTS } from '../fishing/spots';
import { ROOM } from '../gameroom/layout';

// The map's numbers, with no canvas in sight: the area it covers, how the world's (x, z) land on a
// picture of it (north up: the office at the top, the mountains at the bottom), where every place is,
// and how the little map turns as you do. Every position comes from the shared constants
// (shared/scenic.ts and friends), so the map stays right when the scenery moves.

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The part of the world the map shows: the sea in the west to the far creek in the east, the office to the mountains. */
export const WORLD: Bounds = { minX: -330, maxX: 330, minZ: -75, maxZ: 430 };

/** How a world position lands on a picture: `x(wx)`, `y(wz)` and meters-to-pixels `scale`. */
export interface Projection {
  scale: number;
  x(wx: number): number;
  y(wz: number): number;
}

/** The projection that fits `b` into a `width` x `height` picture, centered, with `pad` pixels to spare. */
export function project(b: Bounds, width: number, height: number, pad = 0): Projection {
  const scale = Math.min((width - 2 * pad) / (b.maxX - b.minX), (height - 2 * pad) / (b.maxZ - b.minZ));
  const ox = (width - (b.maxX - b.minX) * scale) / 2;
  const oy = (height - (b.maxZ - b.minZ) * scale) / 2;
  return { scale, x: (wx) => ox + (wx - b.minX) * scale, y: (wz) => oy + (wz - b.minZ) * scale };
}

/** The heading (0 is +z, the way cars count) you are going, walking: the camera looks along -(sin yaw, cos yaw). */
export const walkingHeading = (camYaw: number): number => camYaw + Math.PI;

/** The angle to rotate the little map by so `heading` is up the screen (canvas rotation, clockwise on screen). */
export const minimapAngle = (heading: number): number => heading - Math.PI;

/** Turns a screen offset (dx right, dy down) by the little map's rotation for `heading`. */
export function rotateForHeading(dx: number, dy: number, heading: number): { x: number; y: number } {
  const a = minimapAngle(heading);
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

export type MarkerKind = 'town' | 'drive' | 'fish' | 'camp' | 'sight' | 'nature';

export interface Marker {
  id: string;
  icon: string;
  label: string;
  x: number;
  z: number;
  kind: MarkerKind;
  /** Which side of the chip its name goes (south by default): the town's chips are close together. */
  side?: 'n' | 's' | 'e' | 'w';
}

const mid = (a: number, b: number) => (a + b) / 2;
const loopAt = (place: Place, which: 'first' | 'middle' = 'middle') => {
  const own = LOOP.filter((p) => p.place === place);
  return own[which === 'first' ? 0 : Math.floor(own.length / 2)] ?? LOOP[0];
};

/** Everywhere worth going, with an emoji and a name: the legend and the labels on the map are made from this. */
export function markers(): Marker[] {
  const pines = loopAt('forest');
  const sea = loopAt('beach');
  const coast = loopAt('coast');
  const pass = loopAt('mountains', 'first');
  const fishing = SPOTS.map((s): Marker => ({ id: `fish-${s.id}`, icon: '🎣', label: s.name, x: s.x, z: s.z, kind: 'fish', side: s.id === 'lake' ? 'n' : 's' }));
  return [
    { id: 'office', icon: '🏢', label: 'Office', x: mid(FLOOR.minX, FLOOR.maxX), z: mid(FLOOR.minZ, FLOOR.maxZ) - 3, kind: 'town', side: 'n' },
    { id: 'garage', icon: '🏎️', label: 'Garage and cars', x: mid(LOT.minX, LOT.maxX), z: mid(LOT.minZ, LOT.maxZ), kind: 'drive', side: 'w' },
    { id: 'gameroom', icon: '🎱', label: 'Game room (garage)', x: mid(ROOM.minX, ROOM.maxX), z: mid(ROOM.minZ, ROOM.maxZ) + 4, kind: 'town', side: 'w' },
    { id: 'start', icon: '🏁', label: 'Race start line', x: 0, z: STREET_Z, kind: 'drive', side: 'e' },
    { id: 'farm', icon: '🌾', label: 'Meadowbrook Farm', x: FARM.barn.x, z: FARM.barn.z, kind: 'sight' },
    { id: 'pines', icon: '🌲', label: 'Whispering Pines', x: pines.x - 20, z: pines.z, kind: 'nature' },
    ...fishing,
    { id: 'lake', icon: '🏞️', label: 'The lake', x: LAKE.x + 26, z: LAKE.z + 4, kind: 'nature', side: 'e' },
    { id: 'camp', icon: '🏕️', label: 'Campsite and campfire', x: CAMP.x, z: CAMP.z, kind: 'camp', side: 'w' },
    { id: 'viewpoint', icon: '🔭', label: 'Hill lookout', x: VIEWPOINT.x, z: VIEWPOINT.z, kind: 'camp' },
    { id: 'pass', icon: '🏔️', label: 'Summit Pass', x: pass.x - 28, z: pass.z + 14, kind: 'nature' },
    { id: 'tunnel', icon: '🚇', label: 'Granite Tunnel', x: mid(TUNNEL.x0, TUNNEL.x1), z: TUNNEL.z - 12, kind: 'drive' },
    { id: 'beach', icon: '🏖️', label: 'Sunset Beach', x: sea.x + 20, z: sea.z - 30, kind: 'sight' },
    { id: 'lighthouse', icon: '🗼', label: 'Lighthouse', x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, kind: 'sight' },
  ];
}

/** What the map says about the places you ride the elevator to: they are in the office, not on the ground. */
export const ELEVATOR_NOTES: readonly { icon: string; label: string }[] = [
  { icon: '🍸', label: 'Rooftop bar' },
  { icon: '🌻', label: 'Roof garden' },
];
export const ELEVATOR_NOTE = 'Reached by the elevator in the office';

/** The sea's edge, north to south: its (x, z) every `step` meters of z, over the map's area. */
export function shoreLine(step = 8, b: Bounds = WORLD): [number, number][] {
  const out: [number, number][] = [];
  for (let z = b.minZ; z < b.maxZ + step; z += step) out.push([shoreX(Math.min(z, b.maxZ)), Math.min(z, b.maxZ)]);
  return out;
}

/** The loop's road as a line, a point every `every` meters or so. */
export function loopLine(every = 6): { x: number; z: number; place: Place }[] {
  const k = Math.max(1, Math.round(every / 2));
  return LOOP.filter((_, i) => i % k === 0 || i === LOOP.length - 1).map((p) => ({ x: p.x, z: p.z, place: p.place }));
}

/** The street's own stretch, between the two ends of the loop. */
export const STREET_LINE = { x0: -STREET_END, x1: STREET_END, z: STREET_Z, half: (ROAD.maxZ - ROAD.minZ) / 2 } as const;

/** The mountains the map draws, far ones first so the near ones overlap them. */
export function visibleMountains(b: Bounds = WORLD): [number, number, number, number][] {
  return MOUNTAINS.filter(([x, z, r]) => x + r > b.minX && x - r < b.maxX && z - r < b.maxZ).sort((a, c) => c[1] - a[1]);
}

/** Where the pier is, shore to tip. */
export function pierLine(): { x0: number; x1: number; z: number; width: number } {
  return { x0: shoreX(PIER.z) + 8, x1: shoreX(PIER.z) - PIER.length, z: PIER.z, width: PIER.width };
}

/** Whether a position is inside the map's area. */
export function onMap(x: number, z: number, b: Bounds = WORLD): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

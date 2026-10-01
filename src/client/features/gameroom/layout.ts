import { FLOOR, SLAB, STREET_Y } from '../../../shared/layout';

// The game room: a room in the garage's west end, under the office (so the sky counts it as the garage
// for its lamplight), walled off from the aisle with a doorway in its east wall. The billiards table
// stands in the middle of it. Heights are relative to the street (STREET_Y), which drops with the floor.

export const ROOM = {
  /** The garage's own west wall is the room's. */
  minX: FLOOR.minX,
  maxX: -11,
  minZ: -4.6,
  maxZ: 4.6,
  /** The ceiling is the office's floor slab. */
  ceiling: -SLAB,
  floor: STREET_Y,
} as const;

/** The doorway in the east wall: its middle along z, how wide and how high. */
export const DOOR = { z: 0, width: 2.2, height: 2.3 } as const;

/** The middle of the billiards table (its length runs along z), and how high its cloth is above the street. */
export const TABLE_AT = { x: -14.5, z: 0, cloth: 0.82 } as const;

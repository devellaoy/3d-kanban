import { FLOOR, ROAD, WALL_T } from './layout.js';

// The solid things standing in the cars' way outside the office: the garage's columns and the street
// lamps. Few of them and put well to the side, so a car can come and go (see shared/garage.ts for where
// it can go). The game room's doorway (features/gameroom/layout.ts) is kept clear of them too.

/** The building's footprint, walls included: the garage is under it. */
const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;

/** A column is this wide (m). */
export const COLUMN = 0.5;

/**
 * The garage's columns holding up the office: one in each corner of its open front and east side, and
 * two more in the empty gaps between the Lambos along the back wall, clear of the aisle down the middle,
 * the stalls, the doorway of the game room and the way out.
 */
export const GARAGE_COLUMNS: readonly (readonly [x: number, z: number])[] = [
  [B.minX + 0.55, B.maxZ - 0.25],
  [B.maxX - 0.25, B.maxZ - 0.25],
  [B.maxX - 0.25, B.minZ + 0.25],
  [-3.2, -8.6],
  [4.4, -8.6],
];

/** A street lamp: where it stands on the sidewalk (right at the curb) and which way (±1 in z) its arm reaches over the road. */
export interface StreetLampAt {
  x: number;
  z: number;
  toward: 1 | -1;
}

/** Seven lamps along the street, alternating sides about 12 m apart: lit well enough, and the sidewalk stays open. */
export const STREET_LAMPS: readonly StreetLampAt[] = [
  ...[-40, -12, 12, 40].map((x): StreetLampAt => ({ x, z: ROAD.minZ - 0.2, toward: 1 })),
  ...[-26, 0, 26].map((x): StreetLampAt => ({ x, z: ROAD.maxZ + 0.2, toward: -1 })),
];

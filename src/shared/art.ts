// The office's art: where each piece stands or hangs (client/features/art/ builds them). The one on the
// floor, the sculpture, is something to walk round, so it is an obstacle for the nav grid too.

/** The sculpture on its plinth, in the wide aisle east of the pods, clear of the elevator's way and the lounge. (x, z) is its middle. */
export const SCULPTURE = { x: 4, z: 0.2, plinth: 0.7, height: 2.1 } as const;

/** The LED wave on the south wall above the bookshelf, between the window and the balcony doors' light. `x` is its middle, `y` its bottom. */
export const LED_WAVE = { x: -6.4, y: 3.6, width: 3.0, height: 1.2 } as const;

/** The two large framed prints on the south wall above the stairs up to the loft (their middle, y up; they face north). */
export const PRINTS = [
  { x: 4.2, y: 4.7, width: 1.7, height: 1.15, seed: 7 },
  { x: 7.2, y: 4.7, width: 1.7, height: 1.15, seed: 19 },
] as const;

/** The light installation hung over the plaza, over the sculpture: where its spheres' wires meet the ceiling, and how many there are. Its lowest sphere is above 3.9 m. */
export const CONSTELLATION = { x: 5.5, z: 1.4, spread: 2.6, spheres: 9, lowest: 3.95 } as const;

/** What on the floor is in the way (a footprint with a little air round it), for the nav grid and the layout tests. */
export const ART_OBSTACLES: readonly { name: string; minX: number; maxX: number; minZ: number; maxZ: number }[] = [
  { name: 'sculpture', minX: SCULPTURE.x - SCULPTURE.plinth / 2 - 0.1, maxX: SCULPTURE.x + SCULPTURE.plinth / 2 + 0.1, minZ: SCULPTURE.z - SCULPTURE.plinth / 2 - 0.1, maxZ: SCULPTURE.z + SCULPTURE.plinth / 2 + 0.1 },
];

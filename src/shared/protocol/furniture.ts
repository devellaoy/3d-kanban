// Rearranging the floor's loose furniture in build mode (see shared/arrange.ts). The office answers
// with the `plan` message everyone on the floor gets (FloorPlan.furniture), and a toast.

export type FurnitureClientMsg =
  /**
   * Moves a desk, bean bag, the couch, the coffee table, a lounge pouf, the whiteboard or a rug to a spot,
   * turned `r` quarter turns (0-3) from how it comes: or puts one that isn't on the floor down. `fresh`: a
   * new bean bag from the catalogue, so the office puts down whichever is spare rather than moving `id` if
   * somebody else put that one down meanwhile.
   */
  | { t: 'furniture.move'; id: string; x: number; z: number; r: number; fresh?: boolean }
  /** Takes it out of the floor (not from under someone sitting there, and not the last desk). */
  | { t: 'furniture.remove'; id: string }
  /** Puts one piece back where it comes, or with no `id` all of the floor's furniture. */
  | { t: 'furniture.reset'; id?: string };

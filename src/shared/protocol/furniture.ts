// Rearranging the floor's loose furniture in build mode (see shared/arrange.ts). The office answers
// with the `plan` message everyone on the floor gets (FloorPlan.furniture), and a toast.

export type FurnitureClientMsg =
  /** Moves a desk, bean bag, the couch, a lounge pouf or the whiteboard to a spot, turned `r` quarter turns (0-3) from how it comes: or puts one that was taken out back. */
  | { t: 'furniture.move'; id: string; x: number; z: number; r: number }
  /** Takes it out of the floor (not from under someone sitting there, and not the last desk). */
  | { t: 'furniture.remove'; id: string }
  /** Puts one piece back where it comes, or with no `id` all of the floor's furniture. */
  | { t: 'furniture.reset'; id?: string };

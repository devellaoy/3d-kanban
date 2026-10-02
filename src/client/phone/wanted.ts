// The phone's pick of the floor to follow, apart from phone/watch.ts so it loads without the terminal (and in tests).

/** What the pick reads of the store. */
export interface WatchState {
  /** Your own floor, which `workers` has. */
  floor: string | null;
  floors: readonly { id: string }[];
  /** Whose workers are held now. */
  phoneFloor: { floor: string; workers: { has(id: string): boolean } } | null;
  workers: { has(id: string): boolean };
}

/**
 * The other floor to follow: the one the phone lists, else the floor of the worker whose window is open (we only
 * know it through the phone), else none. Never your own floor, nor one that's gone.
 */
export function wantedFloor(listed: string | null, open: string | null, s: WatchState): string | null {
  let floor = listed;
  if (!floor && open && !s.workers.has(open) && s.phoneFloor?.workers.has(open)) floor = s.phoneFloor.floor;
  return floor && floor !== s.floor && s.floors.some((f) => f.id === floor) ? floor : null;
}

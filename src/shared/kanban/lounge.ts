// The lounge figures: tasks on hold (hold.ts) shown in the 3D office as view-only figures by the TV,
// not real workers. Pure (no three.js, no node): the server sends the figures, and the browser asks
// here where each one sits or stands. The couch's middle place is never taken, so a player can always
// sit down and watch the TV.

export interface LoungeFigure {
  taskId: number;
  title: string;
  /** The implementer's name and colour, as it was at its desk. */
  name: string;
  color: string;
  /** Why it is on hold, and until when (ms). */
  note?: string;
  until?: number;
  /** When it was put on hold (ms). */
  at: number;
}

/** The floor's figures: sent whenever they change, and to everyone who subscribes. */
export type LoungeServerMsg = { t: 'kanban.lounge'; floor: string; figures: LoungeFigure[] };

/** How many figures sit (beanbags, then the couch's two outer places). */
export const LOUNGE_SEATED = 4;
/** How many stand in the arc behind the couch; the rest are not shown. */
export const LOUNGE_STANDING = 8;

/** The seats, in the order they fill. The couch's place 1 (its middle) is left out on purpose. */
const SEATS: readonly { seatId: string; place: number }[] = [
  { seatId: 'lounge-beanbag-1', place: 0 },
  { seatId: 'lounge-beanbag-2', place: 0 },
  { seatId: 'couch', place: 0 },
  { seatId: 'couch', place: 2 },
];

export type LoungePlace = { kind: 'seat'; seatId: string; place: number } | { kind: 'stand'; x: number; z: number; rotY: number };

/** Oldest hold first, ties by task: the order the places fill in. A copy. */
export function sortFigures<T extends Pick<LoungeFigure, 'at' | 'taskId'>>(figures: readonly T[]): T[] {
  return [...figures].sort((a, b) => a.at - b.at || a.taskId - b.taskId);
}

/**
 * Behind the couch (its back is toward smaller x, at x 10.5), a loose arc facing +x, the TV: the
 * ends curve away from the couch a little. Kept at x 9.0 to 9.4, clear of the elevator (x 8.5, north
 * wall) and the walls.
 */
function standing(i: number): LoungePlace {
  const z = -2.8 + (i * 5.6) / (LOUNGE_STANDING - 1);
  return { kind: 'stand', x: 9.4 - 0.4 * (Math.abs(z) / 2.8) ** 2, z, rotY: Math.PI / 2 };
}

/** Where each of `count` figures (oldest first) takes its place, and how many found none. */
export function loungePlaces(count: number): { placed: LoungePlace[]; overflow: number } {
  const n = Math.max(0, Math.floor(count));
  const placed: LoungePlace[] = [];
  for (let i = 0; i < Math.min(n, LOUNGE_SEATED + LOUNGE_STANDING); i++) {
    placed.push(i < LOUNGE_SEATED ? { kind: 'seat', ...SEATS[i] } : standing(i - LOUNGE_SEATED));
  }
  return { placed, overflow: n - placed.length };
}

/** The seats `count` figures take, as the keys a peer's `seat` carries ("couch:0"): what a player can't sit on meanwhile. */
export function loungeReservedPlaces(count: number): string[] {
  return loungePlaces(count).placed.flatMap((p) => (p.kind === 'seat' ? [`${p.seatId}:${p.place}`] : []));
}

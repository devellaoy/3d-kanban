/**
 * Build mode's seats, the pure part: which pieces you can sit on, where on one, and which way you face.
 * A piece becomes a SeatDef like the office's own (shared/layout.ts), so seatPlace puts you in the same
 * kind of place the seating feature does. No three.js and no browser here (tests/game-buildseats.test.ts).
 */
import { seatPlace, type SeatDef, type SeatPlace } from '../../../shared/layout';
import { PIECES, PIECE_FLOOR, type Piece, type PieceKind } from './model';

/** How you sit on a kind of piece, as at a SeatDef (sideways places, hips height, depth and getting-up distance), turned to the piece's front. */
const SEATABLE: Partial<Record<PieceKind, Pick<SeatDef, 'places' | 'hips' | 'depth' | 'out'>>> = {
  chair: { places: [0], hips: 0.52, depth: -0.04, out: 0.8 },
  // One place on each cushion.
  sofa: { places: [-0.36, 0.36], hips: 0.62, depth: 0.06, out: 0.95 },
};

/** The kinds of piece you can sit on. */
export const canSit = (kind: PieceKind): boolean => kind in SEATABLE;

/** The seat a piece is, standing on a floor at height `y`, or null for a piece you can't sit on. Its front is the way you face. */
export function seatOf(p: Piece, y = 0): SeatDef | null {
  const s = SEATABLE[p.kind];
  if (!s) return null;
  return { id: `build:${p.id}`, label: PIECES[p.kind].label, x: p.x, y, z: p.z, rotY: (p.r * Math.PI) / 2, ...s };
}

/** Every place on a piece (none for a piece you can't sit on). */
export function placesOf(p: Piece, y = 0): SeatPlace[] {
  const seat = seatOf(p, y);
  return seat ? seat.places.map((_, i) => seatPlace(seat, i)) : [];
}

/** Where you sit on a piece when you press E aiming at (x, z): on the piece's own floor, never at your feet's height (mid-jump, say, or up on a desk). */
export const placeToSit = (p: Piece, x: number, z: number): SeatPlace | null => nearestPlace(p, x, z, PIECE_FLOOR);

/** The place on a piece nearest the ground point (x, z), or null for a piece you can't sit on. */
export function nearestPlace(p: Piece, x: number, z: number, y = 0): SeatPlace | null {
  let best: SeatPlace | null = null;
  let bestD = Infinity;
  for (const place of placesOf(p, y)) {
    const d = Math.hypot(place.x - x, place.z - z);
    if (d < bestD) {
      best = place;
      bestD = d;
    }
  }
  return best;
}

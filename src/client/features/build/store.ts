/** What build mode keeps in the browser: each floor's pieces, under its own key. The one place that touches localStorage. */
import { parse, serialise, storageKey, type Piece } from './model';

let counter = 0;
export const newId = (): string => `bp${++counter}`;

export function loadPieces(floor: string): Piece[] {
  try {
    return parse(localStorage.getItem(storageKey(floor)), newId);
  } catch {
    return [];
  }
}

export function savePieces(floor: string, pieces: readonly Piece[]): void {
  try {
    if (pieces.length) localStorage.setItem(storageKey(floor), serialise(pieces));
    else localStorage.removeItem(storageKey(floor));
  } catch {
    // storage blocked or full: the pieces stay up for this visit
  }
}

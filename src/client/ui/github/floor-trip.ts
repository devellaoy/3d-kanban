// Going to another floor from a page that changes floors with a plain floor.go (the kanban page, the 2D view): what the
// pull requests board and a task's pull request both do when what they open belongs to another floor.

import { store } from '../../state';
import { toast } from '../dom';

const WAIT_MS = 8000;

/** Asks `go` to take the page to `floor` and resolves true when the page is there, false when it is not after a few seconds. Says it is on its way. */
export function goToFloor(floor: string, go: (floor: string) => void): Promise<boolean> {
  const note = toast(`Going to ${store.floors.find((f) => f.id === floor)?.name ?? floor}’s floor…`);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      off();
      clearTimeout(timer);
      note.remove();
      resolve(ok);
    };
    const off = store.on('floor', () => store.floor === floor && done(true));
    const timer = setTimeout(() => done(false), WAIT_MS);
    go(floor);
  });
}

import { decodePath, encodePath, type GhostPath } from './ghost';
import { parseResults, type RaceResult } from './records';

// Everything racing remembers lives in this browser's localStorage, here and nowhere else. It's all
// best-effort: a private window or a full disk just means it's only for this visit.

const PREFIX = 'office.game.race.';
const RESULTS = `${PREFIX}results`;
const GHOST = `${PREFIX}ghost`;
const GHOST_ON = `${PREFIX}ghostOn`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only for this visit then
  }
}

export const loadResults = (): RaceResult[] => parseResults(read(RESULTS));
export const saveResults = (list: readonly RaceResult[]) => write(RESULTS, JSON.stringify(list));
export const loadGhost = (): GhostPath | null => decodePath(read(GHOST));
export const saveGhost = (path: GhostPath) => write(GHOST, encodePath(path));
/** Whether the ghost shows (it does, unless you turned it off). */
export const loadGhostOn = (): boolean => read(GHOST_ON) !== '0';
export const saveGhostOn = (on: boolean) => write(GHOST_ON, on ? '1' : '0');

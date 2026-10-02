import { decodePath, encodePath, type GhostPath } from './ghost';
import { bestsOf, parseBests, parseResults, type Bests, type RaceResult } from './records';

// Everything racing remembers lives in this browser's localStorage, here and nowhere else. It's all
// best-effort: a private window or a full disk just means it's only for this visit.

const PREFIX = 'office.game.race.';
// "results2", "bestLap2": times from before the cars were quick (round 2) can't be compared with new ones, so they're left behind.
const RESULTS = `${PREFIX}results2`;
// The all-time best race and lap, apart from the capped list of results (a fast race would fall out of it after ten slower ones).
const BESTS = `${PREFIX}bests`;
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
/** The all-time bests: what was saved, with the saved results counted in (they hold the bests from before these were kept). */
export const loadBests = (): Bests => bestsOf(loadResults(), parseBests(read(BESTS)));
export const saveBests = (b: Bests) => write(BESTS, JSON.stringify(b));

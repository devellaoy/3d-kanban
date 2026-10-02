import { decodePath, encodePath, type GhostPath } from './ghost';
import type { CarClass } from '../../../shared/garage';
import { classBestsOf, parseClassBests, parseResults, type ClassBests, type RaceResult } from './records';

// Everything racing remembers lives in this browser's localStorage, here and nowhere else. It's all
// best-effort: a private window or a full disk just means it's only for this visit.

const PREFIX = 'office.game.race.';
// "results2", "bestLap2": times from before the cars were quick (round 2) can't be compared with new ones, so they're left behind.
const RESULTS = `${PREFIX}results2`;
// The all-time best race and lap, apart from the capped list of results (a fast race would fall out of it after ten slower ones).
const BESTS = `${PREFIX}bests`;
const GHOST = `${PREFIX}ghost`;
const LAP = 'agent-office.bestLap2';
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
// The supercars' ghost and best lap keep the keys they always had (what was saved before the 4x4s is theirs); the 4x4's have a key of their own.
const ghostKey = (cls: CarClass) => (cls === 'offroad' ? `${GHOST}.offroad` : GHOST);
const lapKey = (cls: CarClass) => (cls === 'offroad' ? `${LAP}.offroad` : LAP);

export const loadGhost = (cls: CarClass): GhostPath | null => decodePath(read(ghostKey(cls)));
export const saveGhost = (cls: CarClass, path: GhostPath) => write(ghostKey(cls), encodePath(path));
/** The fastest lap of the loop in a class of car (any lap, race or not), or null. */
export function loadLapBest(cls: CarClass): number | null {
  const best = Number(read(lapKey(cls)));
  return best > 0 ? best : null;
}
export const saveLapBest = (cls: CarClass, time: number) => write(lapKey(cls), String(time));
/** Whether the ghost shows (it does, unless you turned it off). */
export const loadGhostOn = (): boolean => read(GHOST_ON) !== '0';
export const saveGhostOn = (on: boolean) => write(GHOST_ON, on ? '1' : '0');
/** The all-time bests: what was saved, with the saved results counted in (they hold the bests from before these were kept). */
export const loadBests = (): ClassBests => classBestsOf(loadResults(), parseClassBests(read(BESTS)));
export const saveBests = (b: ClassBests) => write(BESTS, JSON.stringify(b));

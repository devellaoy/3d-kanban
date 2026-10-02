import type { CarClass } from '../../../shared/garage';

// Race results kept in this browser: the last few races with their laps, and what makes a record. Pure.

/** A finished race: when (ms since the epoch), each lap's time, the jump-start penalty, and the race's total (laps + penalty). */
export interface RaceResult {
  at: number;
  laps: number[];
  penalty: number;
  total: number;
  /** The class of car it was driven in (see shared/garage.ts); results from before the 4x4s have none and are a supercar's. */
  cls?: CarClass;
}

/** How many results are kept (per class of car). */
export const KEEP = 10;

const fastest = (r: RaceResult) => Math.min(...r.laps);

/** The fastest total among `list` (null for none). */
export function bestTotal(list: readonly RaceResult[]): number | null {
  return list.length ? Math.min(...list.map((r) => r.total)) : null;
}

/** The fastest single lap in any of the races (null for none). */
export function bestLapOf(list: readonly RaceResult[]): number | null {
  const laps = list.filter((r) => r.laps.length).map(fastest);
  return laps.length ? Math.min(...laps) : null;
}

/** The all-time bests, kept apart from the capped list (which forgets a fast race after KEEP slower ones). */
export interface Bests {
  /** The fastest race total, or null before any race. */
  total: number | null;
  /** The fastest single lap of any race, or null. */
  lap: number | null;
}

const lower = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** The bests of `list` and `prev` together (this is also how bests are first worked out from results saved before they were kept). */
export function bestsOf(list: readonly RaceResult[], prev: Bests = { total: null, lap: null }): Bests {
  return { total: lower(prev.total, bestTotal(list)), lap: lower(prev.lap, bestLapOf(list)) };
}

/**
 * `result` added to the front of `list` (newest first, KEEP of them), and whether it's a new record total (or the first
 * race), against `bests` (all-time) as well as the list; `next` is the bests with it counted.
 */
export function addResult(list: readonly RaceResult[], result: RaceResult, bests?: Bests): { list: RaceResult[]; record: boolean; bestLap: boolean; next: Bests } {
  const was = bestsOf(list, bests);
  return {
    list: [result, ...list].slice(0, KEEP),
    record: was.total === null || result.total < was.total,
    bestLap: result.laps.length > 0 && (was.lap === null || fastest(result) < was.lap),
    next: bestsOf([result], was),
  };
}

/** Bests read back out of storage's text; anything wrong is "none yet". */
export function parseBests(text: string | null | undefined): Bests {
  const none: Bests = { total: null, lap: null };
  if (!text) return none;
  try {
    const r = JSON.parse(text) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return none;
    return { total: num(r.total) && r.total > 0 ? r.total : null, lap: num(r.lap) && r.lap > 0 ? r.lap : null };
  } catch {
    return none;
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Results read back out of storage's text: whatever's well-formed, and nothing else. */
export function parseResults(text: string | null | undefined): RaceResult[] {
  if (!text) return [];
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    const out: RaceResult[] = [];
    for (const r of raw as Record<string, unknown>[]) {
      if (r && typeof r === 'object' && num(r.at) && num(r.penalty) && num(r.total) && Array.isArray(r.laps) && r.laps.length > 0 && r.laps.every(num)) {
        // Saved before the 4x4s: no class, a supercar's.
        out.push({ at: r.at, laps: r.laps as number[], penalty: r.penalty, total: r.total, cls: r.cls === 'offroad' ? 'offroad' : 'supercar' });
      }
    }
    return [...resultsOf(out, 'supercar').slice(0, KEEP), ...resultsOf(out, 'offroad').slice(0, KEEP)];
  } catch {
    return [];
  }
}

// ---- By class of car ------------------------------------------------------------------------------
// The supercars and the 4x4s don't race each other: each class has its own results, bests and ghost
// (see racing.ts). A result saved before the 4x4s came has no class, and is a supercar's.

/** The class a result was driven in (a supercar's for results from before there were classes). */
export const classOfResult = (r: RaceResult): CarClass => r.cls ?? 'supercar';

/** The results driven in `cls`, newest first. */
export const resultsOf = (list: readonly RaceResult[], cls: CarClass): RaceResult[] => list.filter((r) => classOfResult(r) === cls);

/** `all` with the results of class `cls` replaced by `mine` (newest first overall; each class keeps its own KEEP). */
export function withClass(all: readonly RaceResult[], cls: CarClass, mine: readonly RaceResult[]): RaceResult[] {
  return [...mine.slice(0, KEEP), ...all.filter((r) => classOfResult(r) !== cls)].sort((a, b) => b.at - a.at);
}

/** The all-time bests of each class. */
export type ClassBests = Record<CarClass, Bests>;

const none = (): Bests => ({ total: null, lap: null });

/** Bests read back out of storage's text: the per-class form, or the old single one, which was the supercars'. */
export function parseClassBests(text: string | null | undefined): ClassBests {
  const out: ClassBests = { supercar: none(), offroad: none() };
  if (!text) return out;
  try {
    const r = JSON.parse(text) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return out;
    if ('supercar' in r || 'offroad' in r) {
      out.supercar = parseBests(JSON.stringify(r.supercar ?? null));
      out.offroad = parseBests(JSON.stringify(r.offroad ?? null));
    } else out.supercar = parseBests(text);
  } catch {
    // none yet
  }
  return out;
}

/** Each class's bests: what was saved, with the saved results counted in. */
export function classBestsOf(list: readonly RaceResult[], prev: ClassBests): ClassBests {
  return { supercar: bestsOf(resultsOf(list, 'supercar'), prev.supercar), offroad: bestsOf(resultsOf(list, 'offroad'), prev.offroad) };
}

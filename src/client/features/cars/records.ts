// Race results kept in this browser: the last few races with their laps, and what makes a record. Pure.

/** A finished race: when (ms since the epoch), each lap's time, the jump-start penalty, and the race's total (laps + penalty). */
export interface RaceResult {
  at: number;
  laps: number[];
  penalty: number;
  total: number;
}

/** How many results are kept. */
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

/** `result` added to the front of `list` (newest first, KEEP of them), and whether it's a new record total (or the first race). */
export function addResult(list: readonly RaceResult[], result: RaceResult): { list: RaceResult[]; record: boolean; bestLap: boolean } {
  const total = bestTotal(list);
  const lap = bestLapOf(list);
  return {
    list: [result, ...list].slice(0, KEEP),
    record: total === null || result.total < total,
    bestLap: result.laps.length > 0 && (lap === null || fastest(result) < lap),
  };
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
        out.push({ at: r.at, laps: r.laps as number[], penalty: r.penalty, total: r.total });
      }
    }
    return out.slice(0, KEEP);
  } catch {
    return [];
  }
}

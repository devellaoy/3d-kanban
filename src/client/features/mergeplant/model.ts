// The merge plant's growth, as plain data and pure functions: no three.js, no storage, no clock of its
// own (every function is given `now`). It grows a stage for every merged pull request (the gong rings
// `merged`), and droops once a week goes by with no merge.

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How long without a merge before the plant starts to droop. */
export const DROOP_AFTER_MS = 7 * DAY_MS;
/** How much longer it takes to droop all the way. */
export const DROOP_SPAN_MS = 3 * DAY_MS;

/** Merges it takes to reach each stage: stage 0 is a seed in the soil, the last a flowering bush. */
export const STAGE_AT = [0, 1, 2, 4, 7, 11, 16] as const;
export const MAX_STAGE = STAGE_AT.length - 1;

export const STAGE_NAMES = ['a seed', 'a sprout', 'a seedling', 'a young plant', 'a leafy plant', 'a bushy plant', 'a plant in bloom'] as const;

export interface PlantState {
  /** Merged pull requests it has seen. */
  merges: number;
  /** When the last one merged (ms since the epoch), or null before any. */
  lastMergeAt: number | null;
  /** When it was planted: the droop clock before the first merge. */
  plantedAt: number;
  /** The last pull request counted, so one that's announced twice counts once. */
  lastPr: number | null;
}

export const newPlant = (now: number): PlantState => ({ merges: 0, lastMergeAt: null, plantedAt: now, lastPr: null });

/** The stage `merges` merged pull requests have grown it to. */
export function stageOf(merges: number): number {
  let stage = 0;
  for (let i = 0; i < STAGE_AT.length; i++) if (merges >= STAGE_AT[i]) stage = i;
  return stage;
}

/** Merges still to go for the next stage, or null at the top. */
export function mergesToNext(s: PlantState): number | null {
  const stage = stageOf(s.merges);
  return stage >= MAX_STAGE ? null : STAGE_AT[stage + 1] - s.merges;
}

/** The plant after a pull request (number `pr`, if it's known) merged at `now`. */
export function recordMerge(s: PlantState, now: number, pr?: number): PlantState {
  if (pr !== undefined && pr === s.lastPr) return s;
  return { ...s, merges: s.merges + 1, lastMergeAt: now, lastPr: pr ?? null };
}

/** How wilted it is at `now`: 0 is fine, 1 is as droopy as it gets. It starts a week after the last merge (or planting). */
export function droopOf(s: PlantState, now: number): number {
  const since = now - (s.lastMergeAt ?? s.plantedAt);
  if (!(since > DROOP_AFTER_MS)) return 0;
  return Math.min(1, (since - DROOP_AFTER_MS) / DROOP_SPAN_MS);
}

/** Whole days since the last merge (or since planting, before any), never negative. */
export function daysSince(s: PlantState, now: number): number {
  return Math.max(0, Math.floor((now - (s.lastMergeAt ?? s.plantedAt)) / DAY_MS));
}

const whole = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);
const stamp = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** A saved plant out of its JSON text. Whatever's wrong with it, a new plant planted at `now`. */
export function parsePlant(text: string | null, now: number): PlantState {
  if (!text) return newPlant(now);
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    if (!r || typeof r !== 'object') return newPlant(now);
    return { merges: whole(r.merges) ?? 0, lastMergeAt: stamp(r.lastMergeAt), plantedAt: stamp(r.plantedAt) ?? now, lastPr: whole(r.lastPr) };
  } catch {
    return newPlant(now);
  }
}

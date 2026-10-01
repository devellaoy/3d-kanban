// The rooftop garden's planters, as pure numbers: what's growing in each, when it was watered, and what
// stage that makes it. No three.js and no storage here (see storage.ts), so it can be tested, and shaped
// so a shared garden could come later: a planter is just its plant and its list of waterings.

export type PlantKind = 'tomato' | 'sunflower' | 'tulip' | 'basil';

export const PLANTS: Record<PlantKind, { name: string; icon: string }> = {
  tomato: { name: 'Tomatoes', icon: '🍅' },
  sunflower: { name: 'Sunflowers', icon: '🌻' },
  tulip: { name: 'Tulips', icon: '🌷' },
  basil: { name: 'Basil', icon: '🌿' },
};

/** What each of the roof's planters grows, in order. */
export const PLANTERS: readonly PlantKind[] = ['tomato', 'sunflower', 'tulip', 'basil'];

/** How long a plant must go between waterings for another to count: watering it again right away does nothing. */
export const WATER_GAP_MS = 20 * 60_000;
/** Unwatered this long, a plant droops (it recovers when it's watered). */
export const THIRSTY_MS = 6 * 3_600_000;

export type Stage = 'empty' | 'seed' | 'sprout' | 'leafy' | 'budding' | 'bloom';
export const STAGES: readonly Stage[] = ['empty', 'seed', 'sprout', 'leafy', 'budding', 'bloom'];

/** How many waterings it takes to reach each stage after the seed. */
const WATERINGS: Record<Stage, number> = { empty: 0, seed: 0, sprout: 1, leafy: 3, budding: 5, bloom: 8 };

/** One planter: when it was sown (null: nothing in it), when each watering that counted happened, and how many times it's been picked. */
export interface Planter {
  sown: number | null;
  watered: number[];
  picked: number;
}

export const emptyPlanter = (): Planter => ({ sown: null, watered: [], picked: 0 });

export function stageOf(p: Planter): Stage {
  if (p.sown === null) return 'empty';
  let stage: Stage = 'seed';
  for (const s of STAGES) if (s !== 'empty' && p.watered.length >= WATERINGS[s]) stage = s;
  return stage;
}

/** When the plant last got a drink (or was sown, if it hasn't yet). */
export const lastDrink = (p: Planter): number => p.watered[p.watered.length - 1] ?? p.sown ?? 0;

/** Whether a watering at `now` would count: something's growing that isn't in bloom, and it's been a while since the last. */
export function canWater(p: Planter, now: number): boolean {
  const stage = stageOf(p);
  return stage !== 'empty' && stage !== 'bloom' && now - lastDrink(p) >= WATER_GAP_MS;
}

/** Drooping for want of water. */
export function thirsty(p: Planter, now: number): boolean {
  const stage = stageOf(p);
  return stage !== 'empty' && stage !== 'bloom' && now - lastDrink(p) > THIRSTY_MS;
}

/** How long (ms) until a watering would count again; 0 if it would now. */
export function untilWater(p: Planter, now: number): number {
  return Math.max(0, lastDrink(p) + WATER_GAP_MS - now);
}

/** What E does at a planter: sow it, water it, pick what's grown, or (just watered) nothing. */
export type Chore = 'sow' | 'water' | 'pick' | 'wait';
export function choreAt(p: Planter, now: number): Chore {
  const stage = stageOf(p);
  if (stage === 'empty') return 'sow';
  if (stage === 'bloom') return 'pick';
  return canWater(p, now) ? 'water' : 'wait';
}

/** The planter after E at it at `now` (the same one back when there was nothing to do). */
export function doChore(p: Planter, now: number): Planter {
  switch (choreAt(p, now)) {
    case 'sow':
      return { ...p, sown: now, watered: [] };
    case 'water':
      return { ...p, watered: [...p.watered, now] };
    case 'pick':
      return { sown: null, watered: [], picked: p.picked + 1 };
    case 'wait':
      return p;
  }
}

/** Reads one planter out of whatever was saved, or an empty one for anything else. */
export function sanitizePlanter(v: unknown): Planter {
  if (!v || typeof v !== 'object') return emptyPlanter();
  const o = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const sown = num(o.sown) ? o.sown : null;
  const watered = Array.isArray(o.watered) ? o.watered.filter(num).sort((a, b) => a - b).slice(0, 20) : [];
  return { sown, watered: sown === null ? [] : watered, picked: num(o.picked) && o.picked > 0 ? Math.floor(o.picked) : 0 };
}

/** A short line for the hint: what the plant needs, or how it's doing. */
export function status(p: Planter, now: number): string {
  const stage = stageOf(p);
  if (stage === 'empty') return p.picked ? `${p.picked} picked so far` : 'an empty planter';
  if (stage === 'bloom') return 'ready to pick';
  if (thirsty(p, now)) return 'drooping, thirsty';
  const wait = untilWater(p, now);
  return wait > 0 ? `${stage}, watered (a drink in ${Math.ceil(wait / 60_000)} min)` : `${stage}, could do with a drink`;
}

// What you can catch, and the dice behind it: pure, so it is testable (tests/game-fishing.test.ts) and
// could be played the same way on every browser later. Every function takes its random numbers in
// (`rng`, 0 up to 1) rather than drawing them.

/** Which water a spot looks out on. */
export type Water = 'lake' | 'sea';

/** 1 common, 2 uncommon, 3 rare, 4 legendary. */
export type Rarity = 1 | 2 | 3 | 4;

export const RARITY_NAMES: Record<Rarity, string> = { 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Legendary' };

export interface Species {
  id: string;
  name: string;
  icon: string;
  /** Fish, or junk (a boot): junk has no size. */
  kind: 'fish' | 'junk';
  rarity: Rarity;
  /** Where it bites: one water or both. */
  waters: readonly Water[];
  /** Shortest and longest (cm); 0 for junk. */
  minCm: number;
  maxCm: number;
  /** Weight in kg of a 1 m fish of this shape (it goes with the cube of the length). */
  shape: number;
}

const fish = (id: string, name: string, icon: string, rarity: Rarity, waters: readonly Water[], minCm: number, maxCm: number, shape: number): Species => ({ id, name, icon, kind: 'fish', rarity, waters, minCm, maxCm, shape });
const junk = (id: string, name: string, icon: string, rarity: Rarity, waters: readonly Water[]): Species => ({ id, name, icon, kind: 'junk', rarity, waters, minCm: 0, maxCm: 0, shape: 0 });

export const SPECIES: readonly Species[] = [
  fish('perch', 'Perch', '🐟', 1, ['lake'], 12, 38, 14),
  fish('roach', 'Roach', '🐟', 1, ['lake'], 10, 32, 13),
  fish('trout', 'Rainbow trout', '🐠', 2, ['lake'], 25, 70, 11),
  fish('pike', 'Pike', '🐊', 2, ['lake'], 40, 120, 7.5),
  fish('zander', 'Zander', '🐟', 3, ['lake'], 40, 95, 8.5),
  fish('golden-carp', 'Golden carp', '🏅', 4, ['lake'], 45, 90, 16),
  fish('herring', 'Herring', '🐟', 1, ['sea'], 14, 32, 10),
  fish('mackerel', 'Mackerel', '🐟', 1, ['sea'], 20, 48, 9),
  fish('flounder', 'Flounder', '🐟', 2, ['sea'], 20, 55, 12),
  fish('cod', 'Cod', '🐟', 2, ['sea'], 35, 115, 9),
  fish('sea-bass', 'Sea bass', '🐠', 3, ['sea'], 35, 95, 10),
  fish('swordfish', 'Swordfish', '🗡️', 4, ['sea'], 110, 260, 5),
  junk('boot', 'Old boot', '🥾', 1, ['lake', 'sea']),
  junk('can', 'Tin can', '🥫', 1, ['lake', 'sea']),
  junk('tangle', 'Tangle of seaweed', '🌿', 1, ['sea']),
  junk('key', 'Rusty key', '🗝️', 2, ['lake', 'sea']),
  junk('bottle', 'Message in a bottle', '🍾', 3, ['lake', 'sea']),
];

export const speciesById = (id: string): Species | undefined => SPECIES.find((s) => s.id === id);

/** The species that bite on `water`, in the order of SPECIES. */
export const speciesIn = (water: Water): Species[] => SPECIES.filter((s) => s.waters.includes(water));

/** How likely each rarity is to turn up, before the cast's distance changes it. */
export const RARITY_WEIGHT: Record<Rarity, number> = { 1: 60, 2: 24, 3: 7, 4: 1.2 };

/** How much of all the bites are junk (on top of the fish, whatever the cast). */
export const JUNK_SHARE = 0.16;

/**
 * How likely `s` is on a cast `reach` (0 a flop at your feet, 1 as far as you can throw): a long cast
 * finds the rarer fish, and the junk is by the shore.
 */
export function weightOf(s: Species, reach: number): number {
  const r = Math.max(0, Math.min(1, reach));
  const base = RARITY_WEIGHT[s.rarity];
  if (s.kind === 'junk') return base * (1.4 - 0.8 * r);
  return base * (1 + r * (s.rarity - 1) * 0.9);
}

/** The species a cast brings on: junk with its share of the bites, else a fish by rarity. */
export function rollSpecies(rng: () => number, water: Water, reach: number): Species {
  const pool = speciesIn(water);
  const wantJunk = rng() < JUNK_SHARE;
  const kinds = pool.filter((s) => (s.kind === 'junk') === wantJunk);
  const total = kinds.reduce((sum, s) => sum + weightOf(s, reach), 0);
  let at = rng() * total;
  for (const s of kinds) {
    at -= weightOf(s, reach);
    if (at <= 0) return s;
  }
  return kinds[kinds.length - 1];
}

/** A fish's weight (kg, to 10 g) for its length. */
export function weightKg(s: Species, cm: number): number {
  return Math.round(s.shape * (cm / 100) ** 3 * 100) / 100;
}

export interface Catch {
  species: Species;
  /** Length in cm (0 for junk) and weight in kg. */
  cm: number;
  kg: number;
}

/**
 * How big this one is: most are small, the big ones are rare, and a clean strike (`quality`, 0–1: how
 * soon you struck after the bite) pulls the dice towards the bigger end.
 */
export function rollSize(rng: () => number, s: Species, quality: number): Catch {
  if (s.kind === 'junk') return { species: s, cm: 0, kg: 0 };
  const q = Math.max(0, Math.min(1, quality));
  // u^k leans to 0 for k > 1: small fish are common. A good strike eases k down towards 1.
  const u = rng() ** (2.1 - 0.9 * q);
  const cm = Math.round(s.minCm + (s.maxCm - s.minCm) * u);
  return { species: s, cm, kg: weightKg(s, cm) };
}

// ---- Timing -----------------------------------------------------------------------------------------

/** How long the fish takes to find your bait (seconds): a good spot of luck either way. */
export function biteDelay(rng: () => number): number {
  return 2.5 + rng() * 6.5;
}

/** How many tugs it gives the bobber before it really bites. */
export function nibbleCount(rng: () => number): number {
  return Math.floor(rng() * 3);
}

/** How long you have to strike once it bites (seconds), and how much of that still counts as clean. */
export const STRIKE_WINDOW = 1.0;
export const CLEAN_STRIKE = 0.35;

export type Strike = { result: 'early' } | { result: 'late' } | { result: 'hooked'; quality: number };

/**
 * Where a strike of yours lands: `since` is how long ago it bit (negative: it hasn't yet). Before the
 * bite it is early, too long after it has gone; in between, the sooner the better (1 when clean).
 */
export function judgeStrike(since: number): Strike {
  if (since < 0) return { result: 'early' };
  if (since > STRIKE_WINDOW) return { result: 'late' };
  if (since <= CLEAN_STRIKE) return { result: 'hooked', quality: 1 };
  return { result: 'hooked', quality: 1 - (since - CLEAN_STRIKE) / (STRIKE_WINDOW - CLEAN_STRIKE) };
}

// ---- The cast ---------------------------------------------------------------------------------------

/** The shortest and the longest a cast flies (m). */
export const CAST_MIN = 3.5;
export const CAST_MAX = 19;

/** How far a cast goes for `power` on the meter (0–1). */
export function castDistance(power: number): number {
  const p = Math.max(0, Math.min(1, power));
  return CAST_MIN + (CAST_MAX - CAST_MIN) * p;
}

/** How far out a cast landed `distance` from you, 0 to 1 (see weightOf). */
export function reachOf(distance: number): number {
  return Math.max(0, Math.min(1, (distance - CAST_MIN) / (CAST_MAX - CAST_MIN)));
}

/** A length as the journal says it: centimeters, or meters from a meter on. */
export function lengthText(cm: number): string {
  return cm >= 100 ? `${(cm / 100).toFixed(2)} m` : `${cm} cm`;
}

/** A weight as the journal says it. */
export function weightText(kg: number): string {
  return kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(kg < 10 ? 2 : 1)} kg`;
}

/** What a catch looks like in a line: "🐟 Perch, 23 cm · 180 g", or the junk's name. */
export function catchText(c: Catch): string {
  return c.species.kind === 'junk' ? `${c.species.icon} ${c.species.name}` : `${c.species.icon} ${c.species.name}, ${lengthText(c.cm)} · ${weightText(c.kg)}`;
}

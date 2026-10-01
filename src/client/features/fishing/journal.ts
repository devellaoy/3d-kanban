import { speciesById, type Catch } from './catch';

// The fishing journal: what you've caught and your personal bests. Pure (the parsing is forgiving about
// what the browser has stored), so it can be tested; save.ts is where it meets localStorage.

export interface SpeciesRecord {
  /** How many of this species, and the longest and the heaviest (fish only). */
  n: number;
  bestCm: number;
  bestKg: number;
  /** When the first one was caught (ms since 1970). */
  first: number;
}

export interface Entry {
  id: string;
  cm: number;
  kg: number;
  at: number;
  spot: string;
}

export interface Journal {
  v: 1;
  /** Casts that came down in the water, and every bite you missed. */
  casts: number;
  missed: number;
  species: Record<string, SpeciesRecord>;
  /** The latest catches, newest first. */
  recent: Entry[];
}

export const RECENT = 24;

export const emptyJournal = (): Journal => ({ v: 1, casts: 0, missed: 0, species: {}, recent: [] });

const num = (v: unknown, min = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : 0);

/** The journal in `raw` (what localStorage gave back), or an empty one if it isn't one: unknown species and bad numbers are dropped. */
export function parseJournal(raw: string | null): Journal {
  const j = emptyJournal();
  if (!raw) return j;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return j;
  }
  if (!o || typeof o !== 'object') return j;
  const r = o as Record<string, unknown>;
  j.casts = Math.floor(num(r.casts));
  j.missed = Math.floor(num(r.missed));
  if (r.species && typeof r.species === 'object') {
    for (const [id, v] of Object.entries(r.species as Record<string, unknown>)) {
      if (!speciesById(id) || !v || typeof v !== 'object') continue;
      const s = v as Record<string, unknown>;
      const n = Math.floor(num(s.n));
      if (n < 1) continue;
      j.species[id] = { n, bestCm: num(s.bestCm), bestKg: num(s.bestKg), first: num(s.first) };
    }
  }
  if (Array.isArray(r.recent)) {
    for (const v of r.recent.slice(0, RECENT)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      if (typeof e.id !== 'string' || !speciesById(e.id)) continue;
      j.recent.push({ id: e.id, cm: num(e.cm), kg: num(e.kg), at: num(e.at), spot: typeof e.spot === 'string' ? e.spot.slice(0, 40) : '' });
    }
  }
  return j;
}

/** What a catch did to the journal. */
export interface Logged {
  journal: Journal;
  /** The first of its species. */
  first: boolean;
  /** Longer (or, for the weight, heavier) than any before: fish only, and not the first of its kind. */
  record: boolean;
}

/** `c` caught at `spot` at time `at`: the journal with it written in (the one passed in is left alone). */
export function logCatch(j: Journal, c: Catch, spot: string, at: number): Logged {
  const prev = j.species[c.species.id];
  const next = { n: (prev?.n ?? 0) + 1, bestCm: Math.max(prev?.bestCm ?? 0, c.cm), bestKg: Math.max(prev?.bestKg ?? 0, c.kg), first: prev?.first ?? at };
  const record = !!prev && c.species.kind === 'fish' && c.cm > prev.bestCm;
  const journal: Journal = {
    ...j,
    species: { ...j.species, [c.species.id]: next },
    recent: [{ id: c.species.id, cm: c.cm, kg: c.kg, at, spot }, ...j.recent].slice(0, RECENT),
  };
  return { journal, first: !prev, record };
}

/** A cast that landed in the water. */
export const logCast = (j: Journal): Journal => ({ ...j, casts: j.casts + 1 });

/** A bite you missed (struck too early, or too late). */
export const logMiss = (j: Journal): Journal => ({ ...j, missed: j.missed + 1 });

/** Totals for the journal's top line. */
export function totals(j: Journal): { fish: number; junk: number; kinds: number } {
  let fish = 0;
  let junk = 0;
  let kinds = 0;
  for (const [id, r] of Object.entries(j.species)) {
    const s = speciesById(id);
    if (!s) continue;
    if (s.kind === 'fish') {
      fish += r.n;
      kinds++;
    } else junk += r.n;
  }
  return { fish, junk, kinds };
}

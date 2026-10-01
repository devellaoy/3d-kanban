// What the browser remembers of the rooftop garden between visits: one entry in localStorage, a planter
// each. The only place the garden touches storage, and every read and write shrugs off blocked storage.

import { PLANTERS, sanitizePlanter, type Planter } from './model';

export const GARDEN_KEY = 'office.game.garden';

/** The saved planters, one for each of PLANTERS (empty ones for anything missing or unreadable). */
export function loadGarden(storage: Pick<Storage, 'getItem'> | null = safe()): Planter[] {
  let saved: unknown[] = [];
  try {
    const v = JSON.parse(storage?.getItem(GARDEN_KEY) ?? 'null');
    if (Array.isArray(v)) saved = v;
  } catch {
    // storage blocked, or not JSON
  }
  return PLANTERS.map((_, i) => sanitizePlanter(saved[i]));
}

export function saveGarden(planters: readonly Planter[], storage: Pick<Storage, 'setItem'> | null = safe()) {
  try {
    storage?.setItem(GARDEN_KEY, JSON.stringify(planters));
  } catch {
    // storage blocked
  }
}

function safe(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

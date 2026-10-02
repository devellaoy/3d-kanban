// What the browser remembers of billiards: the mode you play in and the fewest shots you've cleared a rack in.

const KEY = 'office.game.billiards';

export interface Record {
  mode: 'practice' | 'hotseat';
  /** The fewest shots a cleared rack took, or null. */
  best: number | null;
}

/** Reads a saved record from its text, leaving out anything that isn't what it should be. */
export function parseRecord(text: string | null): Record {
  const out: Record = { mode: 'practice', best: null };
  try {
    const r = JSON.parse(text ?? '{}') as { mode?: unknown; best?: unknown };
    if (r.mode === 'hotseat') out.mode = 'hotseat';
    if (typeof r.best === 'number' && Number.isInteger(r.best) && r.best > 0) out.best = r.best;
  } catch {
    // not ours: start over
  }
  return out;
}

export function loadRecord(): Record {
  try {
    return parseRecord(localStorage.getItem(KEY));
  } catch {
    return parseRecord(null);
  }
}

export function saveRecord(r: Record): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // private window: it's only for this visit then
  }
}

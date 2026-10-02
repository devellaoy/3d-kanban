// Where the phone's keyboard focus goes after its list is drawn again, apart from phone/ui.ts so it loads
// in tests. Rows are known by what they are (`floor:<id>`, `worker:<id>`), not where they stand: a worker
// that starts waiting moves to the top, and the focus has to go with it, or the next Enter opens someone else.

/** The row to focus in `keys` (the list as drawn now): the one that had it, else the one now at its old place; -1 for none. */
export function refocusIndex(had: string | undefined, at: number, keys: readonly string[]): number {
  const same = had ? keys.indexOf(had) : -1;
  if (same >= 0) return same;
  return at < 0 || !keys.length ? -1 : Math.min(at, keys.length - 1);
}

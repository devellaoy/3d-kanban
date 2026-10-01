// A small TTL cache for what the browse calls ask again and again (counts, the board's fields, the
// versions, the sub-task parents): a value is kept for `ttl` ms, the map holds `max` of them (the
// oldest goes first), and a failure is never kept: the next call asks again.

export interface Entry<T> {
  at: number;
  value: T;
}

export const TTL_MS = 60_000;
const MAX = 500;

/** The cached value for `key`, or what `make` says (kept when it succeeds). */
export async function memo<T>(map: Map<string, Entry<T>>, key: string, make: () => Promise<T>, now = Date.now(), ttl = TTL_MS, max = MAX): Promise<T> {
  const hit = map.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  const value = await make();
  map.delete(key);
  while (map.size >= max) map.delete(map.keys().next().value as string);
  map.set(key, { at: now, value });
  return value;
}

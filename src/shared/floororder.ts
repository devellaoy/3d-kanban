// The order of the building's floors, shared by the server (which keeps it as the order of floors.json)
// and the browser (which shows it). Floors are grouped by the GitHub owner of their repository, and
// the floors of a group always sit together. Every list here is bottom-up: index 0 is floor 1.

/** What the order needs to know about a floor. */
export interface Orderable {
  id: string;
  /** owner/name on GitHub. */
  repo?: string;
}

/** The floors of one owner, bottom-up. */
export interface FloorGroup<T> {
  key: string;
  label: string;
  floors: T[];
}

/** The heading of the floors with no GitHub repository. */
export const LOCAL_GROUP = 'Local';

/** The owner of `repo` lower-cased, or '' for a floor with no repository. */
export function floorGroupKey(f: { repo?: string }): string {
  const slash = f.repo?.indexOf('/') ?? -1;
  return f.repo && slash > 0 ? f.repo.slice(0, slash).toLowerCase() : '';
}

/** Groups in order of first appearance (stable); label = owner as first seen, or LOCAL_GROUP. */
export function groupFloors<T extends Orderable>(list: T[]): FloorGroup<T>[] {
  const groups = new Map<string, FloorGroup<T>>();
  for (const f of list) {
    const key = floorGroupKey(f);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = newGroup(f)));
    g.floors.push(f);
  }
  return [...groups.values()];
}

/** An empty group for the owner of `f`, labelled as groupFloors does. */
function newGroup<T extends Orderable>(f: T): FloorGroup<T> {
  const key = floorGroupKey(f);
  return { key, label: key ? f.repo!.slice(0, f.repo!.indexOf('/')) : LOCAL_GROUP, floors: [] };
}

/** groupFloors(list).flatMap(g => g.floors): makes every group one run, keeping the rest of the order. */
export function normalizeOrder<T extends Orderable>(list: T[]): T[] {
  return groupFloors(list).flatMap((g) => g.floors);
}

/**
 * A new floor, result normalized. 'groupTop': at the top of its owner's group, a new owner's group at
 * the top of the building. 'bottom': at the bottom of its owner's group, and that group (new or
 * existing) moves to the bottom of the building.
 */
export function insertFloor<T extends Orderable>(list: T[], item: T, where: 'groupTop' | 'bottom'): T[] {
  const groups = groupFloors(list);
  const key = floorGroupKey(item);
  const found = groups.find((g) => g.key === key);
  const group = found ?? newGroup(item);
  if (where === 'groupTop') {
    group.floors.push(item);
    if (!found) groups.push(group);
  } else {
    group.floors.unshift(item);
    if (found) groups.splice(groups.indexOf(found), 1);
    groups.unshift(group);
  }
  return groups.flatMap((g) => g.floors);
}

/** Floor `id` moved to just above floor `above` (same group), or to the bottom of its group (null). undefined: unknown id, above unknown/is id/in another group. */
export function moveFloorAbove<T extends Orderable>(list: T[], id: string, above: string | null): T[] | undefined {
  const groups = groupFloors(list);
  const group = groups.find((g) => g.floors.some((f) => f.id === id));
  if (!group) return undefined;
  const floor = group.floors.find((f) => f.id === id)!;
  const rest = group.floors.filter((f) => f !== floor);
  let at = 0; // the bottom of the group
  if (above !== null) {
    const i = rest.findIndex((f) => f.id === above);
    if (i < 0) return undefined;
    at = i + 1;
  }
  rest.splice(at, 0, floor);
  group.floors = rest;
  return groups.flatMap((g) => g.floors);
}

/** Group `key` moved to just above group `above`, or to the bottom of the building (null). undefined when a key is unknown or the same. */
export function moveGroupAbove<T extends Orderable>(list: T[], key: string, above: string | null): T[] | undefined {
  const groups = groupFloors(list);
  const group = groups.find((g) => g.key === key);
  if (!group || key === above) return undefined;
  const rest = groups.filter((g) => g !== group);
  let at = 0;
  if (above !== null) {
    const i = rest.findIndex((g) => g.key === above);
    if (i < 0) return undefined;
    at = i + 1;
  }
  rest.splice(at, 0, group);
  return rest.flatMap((g) => g.floors);
}

/** The `above` that moves floor `id` one step up or down in its group; undefined at its group's edge (or unknown id). */
export function floorStep<T extends Orderable>(list: T[], id: string, dir: 'up' | 'down'): string | null | undefined {
  const floors = groupFloors(list).find((g) => g.floors.some((f) => f.id === id))?.floors;
  return floors && step(floors.map((f) => f.id), id, dir);
}

/** The same for a whole group. */
export function groupStep<T extends Orderable>(list: T[], key: string, dir: 'up' | 'down'): string | null | undefined {
  const keys = groupFloors(list).map((g) => g.key);
  return step(keys, key, dir);
}

/** Bottom-up `ids`: the `above` that moves `id` one place up (just above the one over it) or down (just above the one two under it, or null for the bottom). */
function step(ids: string[], id: string, dir: 'up' | 'down'): string | null | undefined {
  const i = ids.indexOf(id);
  if (i < 0) return undefined;
  if (dir === 'up') return i + 1 < ids.length ? ids[i + 1] : undefined;
  return i === 0 ? undefined : i === 1 ? null : ids[i - 2];
}

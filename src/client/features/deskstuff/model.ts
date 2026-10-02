// What stands on a desk, as plain data: which small things, and whether the desk lamp is on. No
// three.js and no storage in here, so it is easy to test (and to sync later, a desk's config is one
// small JSON value).

export const DESK_ITEMS = ['plant', 'mug', 'frame', 'lamp', 'duck'] as const;
export type DeskItem = (typeof DESK_ITEMS)[number];

export const ITEM_INFO: Record<DeskItem, { icon: string; label: string }> = {
  plant: { icon: '🪴', label: 'Plant' },
  mug: { icon: '☕', label: 'Mug' },
  frame: { icon: '🖼️', label: 'Photo frame' },
  lamp: { icon: '💡', label: 'Desk lamp' },
  duck: { icon: '🦆', label: 'Rubber duck' },
};

export interface DeskConfig {
  items: DeskItem[];
  lampOn: boolean;
}

/** Every desk's config on a floor, by desk id. A desk with nothing on it has no entry. */
export type FloorDesks = Record<string, DeskConfig>;

export const emptyConfig = (): DeskConfig => ({ items: [], lampOn: false });

/** Whether `c` has nothing to remember. */
export const isEmpty = (c: DeskConfig) => c.items.length === 0;

/** `c` with `item` put on the desk, or taken off it when it was there. Items keep DESK_ITEMS' order. */
export function toggleItem(c: DeskConfig, item: DeskItem): DeskConfig {
  const has = c.items.includes(item);
  const items = DESK_ITEMS.filter((i) => (i === item ? !has : c.items.includes(i)));
  // A lamp that's gone can't stay on.
  return { items, lampOn: items.includes('lamp') ? c.lampOn : false };
}

/** `c` with the lamp switched on or off (not at all, with no lamp on the desk). */
export function setLamp(c: DeskConfig, on: boolean): DeskConfig {
  return c.items.includes('lamp') ? { items: c.items, lampOn: on } : c;
}

/** One desk's config out of anything that was saved: unknown items, duplicates and wrong types are dropped. */
export function sanitizeConfig(raw: unknown): DeskConfig {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  const r = raw as { items?: unknown; lampOn?: unknown };
  const given = Array.isArray(r.items) ? r.items : [];
  const items = DESK_ITEMS.filter((i) => given.includes(i));
  return { items, lampOn: items.includes('lamp') && r.lampOn === true };
}

/** A floor's configs out of its saved JSON text; whatever's wrong with it, an empty floor. `known` says which desk ids exist. */
export function parseFloor(text: string | null, known: (deskId: string) => boolean = () => true): FloorDesks {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: FloorDesks = {};
    for (const [id, v] of Object.entries(raw)) {
      const c = sanitizeConfig(v);
      if (known(id) && !isEmpty(c)) out[id] = c;
    }
    return out;
  } catch {
    return {};
  }
}

/** `floor` with desk `id` set to `c` (taken out when it's empty), as a new object. */
export function withDesk(floor: FloorDesks, id: string, c: DeskConfig): FloorDesks {
  const out = { ...floor };
  if (isEmpty(c)) delete out[id];
  else out[id] = c;
  return out;
}

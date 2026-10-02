// The light switches' state, as plain data: which areas have their lights on. No three.js and no
// storage in here, so it is easy to test (and a floor's state is one small JSON value to sync later).

export const AREAS = ['lounge', 'desks'] as const;
export type AreaId = (typeof AREAS)[number];

export const AREA_INFO: Record<AreaId, { label: string }> = {
  lounge: { label: 'the lounge' },
  desks: { label: 'the desk area' },
};

/** Whether each area's lights are on. */
export type LightsState = Record<AreaId, boolean>;

export const allOn = (): LightsState => ({ lounge: true, desks: true });

export const isArea = (id: unknown): id is AreaId => typeof id === 'string' && (AREAS as readonly string[]).includes(id);

/** `s` with area `id` flipped, as a new object. */
export function flip(s: LightsState, id: AreaId): LightsState {
  return { ...s, [id]: !s[id] };
}

/** A floor's saved lights out of its JSON text. Only an area saved as off is off: whatever's wrong, they're all on. */
export function parseLights(text: string | null): LightsState {
  const out = allOn();
  if (!text) return out;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object') return out;
    for (const id of AREAS) if ((raw as Record<string, unknown>)[id] === false) out[id] = false;
  } catch {
    // keep the default
  }
  return out;
}

/** How far lit an area is now (0 dark to 1 bright) after `dt` seconds of easing toward its switch. */
export function easeLevel(level: number, on: boolean, dt: number, rate = 5): number {
  const target = on ? 1 : 0;
  const next = level + (target - level) * (1 - Math.exp(-dt * rate));
  return Math.abs(target - next) < 0.005 ? target : next;
}

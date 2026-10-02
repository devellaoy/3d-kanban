// The seasons of the year, for the landscape: the server's weather (snow only in winter) and the
// browser's trees and grass (blossom, green, autumn colours, bare branches) agree on them here.

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';
/** In the order of the calendar's quarters from December: also what the server's weather odds are indexed by. */
export const SEASONS: readonly Season[] = ['winter', 'spring', 'summer', 'autumn'];

/** The season in `month` (0 = January): December to February winter, then three months each. `south`: the other way round. */
export function seasonOfMonth(month: number, south = false): Season {
  const m = (((south ? month + 6 : month) % 12) + 12) % 12;
  return SEASONS[Math.floor((m + 1) / 3) % 4];
}

/** The season on `date` (local time), in the northern hemisphere or, with `south`, the southern. */
export function seasonOf(date: Date | number = new Date(), south = false): Season {
  return seasonOfMonth(new Date(date).getMonth(), south);
}

/** A season named in a URL (`?season=autumn`), for trying them out; null for anything else. */
export function seasonFromQuery(search: string): Season | null {
  const v = new URLSearchParams(search).get('season')?.toLowerCase();
  return SEASONS.find((s) => s === v) ?? null;
}

/** What in the landscape changes colour with the season. */
export type Foliage = 'pine' | 'leaf' | 'autumn' | 'grass';

export interface FoliageLook {
  color: string;
  /** No leaves at all: bare branches. */
  bare: boolean;
}

const rgb = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** `a` mixed `t` (0-1) of the way to `b`, both `#rrggbb`. */
export function mixHex(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/**
 * What a kind of foliage looks like in `season`. `shade` (0 or 1) is which of its two tones it is, and
 * `base` its colour in summer.
 */
export function foliageLook(kind: Foliage, shade: 0 | 1, season: Season, base: string): FoliageLook {
  const look = (color: string, bare = false): FoliageLook => ({ color, bare });
  if (season === 'summer') return look(base);
  switch (kind) {
    case 'pine':
      // Evergreens stay green: brighter new growth in spring, snow on the boughs in winter.
      return look(season === 'spring' ? mixHex(base, '#8fdc7a', 0.3) : season === 'autumn' ? mixHex(base, '#8a9a4e', 0.18) : mixHex(base, '#eef4f4', 0.55));
    case 'leaf':
      if (season === 'winter') return look(base, true);
      if (season === 'spring') return look(shade === 0 ? '#f9bfd6' : '#8fdc7a');
      return look(shade === 0 ? '#e0603f' : '#eaa23a');
    case 'autumn':
      if (season === 'winter') return look(base, true);
      return look(season === 'spring' ? '#b4e08c' : '#e9703f');
    case 'grass':
      return look(season === 'spring' ? '#aee890' : season === 'autumn' ? '#cbc57c' : '#a9b9a3');
  }
}

/** How much snow lies on the ground in `season`, 0-1 (the sky lays it on whatever faces up). */
export function snowCover(season: Season): number {
  return season === 'winter' ? 0.9 : 0;
}

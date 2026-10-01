import type * as THREE from 'three';
import { foliageLook, type Foliage, type Season } from '../../../shared/season';
import { toon, toonUnique } from '../toon';

// The materials the seasons recolour: the scenic loop's pines and leafy trees, and the lawn. They are
// shared (a few per kind, not one per tree) and marked `live`, so merging keeps them as materials
// instead of baking their colour into the trees (see mergeByColor); applySeason then just sets their
// colour, and leafy trees go bare for the winter by not drawing their leaves at all.

interface Entry {
  mat: THREE.MeshToonMaterial;
  kind: Foliage;
  shade: 0 | 1;
  base: string;
}
const entries: Entry[] = [];
const byKey = new Map<string, THREE.MeshToonMaterial>();

/** The lawn's colour (see buildOutside): the grass of the whole map, which the seasons tint. */
const LAWN = '#a7d98b';

/** The shared material for `kind` in tone `shade`, `base` in summer. */
export function seasonal(kind: Foliage, shade: 0 | 1, base: string): THREE.MeshToonMaterial {
  const key = `${kind}${shade}`;
  let mat = byKey.get(key);
  if (!mat) {
    mat = toonUnique(base);
    mat.userData.live = true;
    byKey.set(key, mat);
    entries.push({ mat, kind, shade, base });
  }
  return mat;
}

const watchers: ((season: Season) => void)[] = [];
let shown: Season | null = null;

/** Calls `fn` with the season now (once it's known) and every time it changes: for what comes and goes with it, like wildflowers. */
export function onSeason(fn: (season: Season) => void) {
  watchers.push(fn);
  if (shown) fn(shown);
}

/** How many materials there are, so a season applied before more were built can be applied again. */
export const seasonalCount = () => entries.length;

/** Paints the landscape for `season`. */
export function applySeason(season: Season) {
  if (!entries.some((e) => e.kind === 'grass')) entries.push({ mat: toon(LAWN) as THREE.MeshToonMaterial, kind: 'grass', shade: 0, base: LAWN });
  for (const e of entries) {
    const look = foliageLook(e.kind, e.shade, season, e.base);
    e.mat.color.set(look.color);
    e.mat.visible = !look.bare;
  }
  shown = season;
  for (const fn of watchers) fn(season);
}

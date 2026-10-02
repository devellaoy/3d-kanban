/**
 * The roof garden: four planters up by the bar, a different plant in each. E at an empty one sows it,
 * and E again every so often waters it, till it blooms and E picks it. What's growing, and when it was
 * watered, is remembered in this browser (see storage.ts), so it grows while you're away.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { noOutline } from '../../core/outline';
import { toast } from '../../ui/dom';
import type { Rooftop } from '../rooftop/world';
import { PLANTERS, PLANTS, choreAt, doChore, stageOf, status, type Chore } from './model';
import { loadGarden, saveGarden } from './storage';
import { buildGarden, type GardenView } from './world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    planter: true;
  }
}

export interface GardenDeps {
  /** The roof, once it's been built (the first time anyone goes up: see features/rooftop). */
  roof(): Rooftop | null;
}

const VERBS: Record<Chore, string> = { sow: 'Sow seeds', water: 'Water it', pick: 'Pick it', wait: 'Watered' };

export function installGarden(ctx: Ctx, deps: GardenDeps) {
  const planters = loadGarden();
  let view: GardenView | null = null;
  let refreshed = 0;

  /** The roof's been built: the planters go up on it. */
  function attach(roof: Rooftop) {
    view = buildGarden();
    roof.group.add(view.group);
    roof.colliders.push(...view.colliders);
    roof.interactables.push(...view.planters.map((p) => p.interactable));
    roof.pickables.push(view.group);
    noOutline(view.group);
    refresh();
  }

  /** Shows each planter as it stands now. */
  function refresh() {
    const now = Date.now();
    view?.planters.forEach((p, i) => p.show(planters[i], now));
  }

  const indexOf = (decorId?: string) => Math.max(0, Number(decorId?.slice('planter-'.length)) || 0);

  ctx.interactions.define('planter', {
    reach: 3.2,
    hint: (it) => {
      const i = indexOf(it.decorId);
      const now = Date.now();
      const chore = choreAt(planters[i], now);
      const what = status(planters[i], now);
      const title = `${PLANTS[PLANTERS[i]].icon} ${PLANTS[PLANTERS[i]].name}`;
      return { k: `${i}${chore}${what}`, parts: [hintTitle(title), aside(what), ...(chore === 'wait' ? [] : [key('E', VERBS[chore])])] };
    },
    use: onE((it) => {
      const i = indexOf(it.decorId);
      const now = Date.now();
      const chore = choreAt(planters[i], now);
      if (chore === 'wait') return;
      planters[i] = doChore(planters[i], now);
      saveGarden(planters);
      view?.planters[i].show(planters[i], now);
      if (chore !== 'pick') view?.planters[i].splash();
      const plant = PLANTS[PLANTERS[i]];
      if (chore === 'pick') toast(`${plant.icon} Picked the ${plant.name.toLowerCase()} (${planters[i].picked} so far)`);
      else if (chore === 'sow') toast(`${plant.icon} Sowed ${plant.name.toLowerCase()}: water them now and then`);
      else if (stageOf(planters[i]) === 'bloom') toast(`${plant.icon} ${plant.name} are in bloom!`);
      ctx.hint.invalidate();
    }),
  });

  ctx.ticks.add('world', ({ dt, t }) => {
    if (!view) {
      const roof = deps.roof();
      if (roof) attach(roof);
      return;
    }
    if (!ctx.upTop()) return;
    view.update(dt);
    // Thirst creeps up on a plant while you stand there.
    if (t - refreshed > 20) {
      refreshed = t;
      refresh();
      ctx.hint.invalidate();
    }
  });
}

/**
 * The merge plant: the plant in the lounge grows a stage for each pull request that merges (the gong's
 * `merged`), and droops once a week passes with none. What it has grown is kept in this browser, per
 * floor; E at it says how it is doing.
 */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { toast } from '../../ui/dom';
import { MAX_STAGE, STAGE_NAMES, daysSince, droopOf, mergesToNext, newPlant, recordMerge, stageOf, type PlantState } from './model';
import { loadPlant, savePlant } from './store';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    mergeplant: true;
  }
}

export function installMergePlant(ctx: Ctx) {
  let plant: PlantState = newPlant(Date.now());
  const view = () => ctx.office.mergePlant;

  function show(snap = false) {
    view().set(stageOf(plant.merges), droopOf(plant, Date.now()), snap);
  }
  function enterFloor() {
    plant = store.floor ? loadPlant(store.floor, Date.now()) : newPlant(Date.now());
    // A plant first seen is saved at once, so its week starts now and not at the next visit.
    if (store.floor) savePlant(store.floor, plant);
    show(true);
  }
  store.on('floor', enterFloor);
  enterFloor();

  ctx.messages.on('gong', (msg) => {
    if (msg.why !== 'merged' || !store.floor) return;
    const next = recordMerge(plant, Date.now(), msg.pr);
    if (next === plant) return;
    plant = next;
    savePlant(store.floor, plant);
    show();
    view().perk();
  });

  // The droop comes with the days going by, so look again now and then.
  let since = 0;
  ctx.ticks.add('world', (f) => {
    since += f.dt;
    if (since < 30) return;
    since = 0;
    show();
  });

  const status = () => {
    const stage = stageOf(plant.merges);
    const d = droopOf(plant, Date.now());
    const days = daysSince(plant, Date.now());
    const left = mergesToNext(plant);
    const mood = d > 0 ? `drooping, no merge for ${days} days` : plant.lastMergeAt === null ? 'waiting for a first merge' : days === 0 ? 'perky, fed today' : `perky, last merge ${days} day${days === 1 ? '' : 's'} ago`;
    return { stage, droop: d, text: `${STAGE_NAMES[stage]} · ${mood}`, left };
  };

  ctx.interactions.define('mergeplant', {
    reach: 4,
    hint: () => {
      const s = status();
      return { k: `${plant.merges}|${s.text}`, parts: [hintTitle('🌱 Merge plant'), aside(s.text), key('E', 'Check on it')] };
    },
    use: onE(() => {
      const s = status();
      const next = s.left === null ? `fully grown at stage ${MAX_STAGE + 1}` : `${s.left} more merge${s.left === 1 ? '' : 's'} to grow`;
      toast(`🌱 ${plant.merges} merge${plant.merges === 1 ? '' : 's'}: ${s.text}. ${next}.`);
    }),
  });
}

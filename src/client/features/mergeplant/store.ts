// What the browser remembers of the merge plant: one entry per floor, in localStorage. Every read and
// write shrugs off blocked storage.

import { newPlant, parsePlant, type PlantState } from './model';

const key = (floor: string) => `office.game.mergeplant.${floor}`;

/** The floor's plant, planted now when there's none saved (and then saved, so the droop clock runs from today). */
export function loadPlant(floor: string, now: number): PlantState {
  try {
    const text = localStorage.getItem(key(floor));
    const plant = parsePlant(text, now);
    if (!text) savePlant(floor, plant);
    return plant;
  } catch {
    return newPlant(now);
  }
}

export function savePlant(floor: string, plant: PlantState) {
  try {
    localStorage.setItem(key(floor), JSON.stringify(plant));
  } catch {
    // storage blocked
  }
}

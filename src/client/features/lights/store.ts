// What the browser remembers of the light switches: one entry per floor, in localStorage (the lights
// you turned off are off for you alone). Every read and write shrugs off blocked storage.

import { allOn, parseLights, type LightsState } from './model';

const key = (floor: string) => `office.game.lights.${floor}`;

export function loadLights(floor: string): LightsState {
  try {
    return parseLights(localStorage.getItem(key(floor)));
  } catch {
    return allOn();
  }
}

export function saveLights(floor: string, state: LightsState) {
  try {
    localStorage.setItem(key(floor), JSON.stringify(state));
  } catch {
    // storage blocked
  }
}

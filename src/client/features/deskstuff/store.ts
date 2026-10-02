// What the browser remembers of the desks' small things: one entry per floor, in localStorage, because
// it is yours alone and never goes to the server (unlike the signs over the desks). Every read and
// write shrugs off blocked storage.

import { parseFloor, type FloorDesks } from './model';

const key = (floor: string) => `office.game.deskstuff.${floor}`;

export function loadDesks(floor: string, known?: (deskId: string) => boolean): FloorDesks {
  try {
    return parseFloor(localStorage.getItem(key(floor)), known);
  } catch {
    return {};
  }
}

export function saveDesks(floor: string, desks: FloorDesks) {
  try {
    if (Object.keys(desks).length) localStorage.setItem(key(floor), JSON.stringify(desks));
    else localStorage.removeItem(key(floor));
  } catch {
    // storage blocked
  }
}

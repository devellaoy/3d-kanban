// Who hears that a floor's PR board has fresh lists. Floor.boardPulled tells
// them; the pull-request plugin listens while it runs, to keep its tasks' linked PRs' states up to
// date. A module of its own so floor.ts needn't import the plugin, nor the plugin the whole floor.

import type { GhPull, GhState } from '../../../../shared/protocol.js';

/** A floor, as far as a listener needs it. */
export interface PulledFloor {
  id: string;
  /** Every repository's pull requests, each marked with its repository (see Floor.pullsState). */
  pullsState(): GhState<GhPull>;
}

export type FloorPullsListener = (floor: PulledFloor) => void;

export const floorPullsListeners = new Set<FloorPullsListener>();

/** Tells every listener; one that throws doesn't stop the others, nor the floor. */
export function floorPulled(floor: PulledFloor) {
  for (const l of floorPullsListeners) {
    try {
      l(floor);
    } catch (err) {
      console.error("agent-office: a listener to a floor's pull requests failed:", err);
    }
  }
}

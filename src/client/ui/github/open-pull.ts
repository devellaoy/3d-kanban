// Open a pull request that is not a board card in hand (a task's) in the office's pull request window: each page says once how
// that window gets its BoardActions (setPullActions), then anyone with a PR link asks openPullHere.

import type { BoardActions } from './prompts';
import type { Net } from '../../net';
import { store } from '../../state';
import { openPull } from './pull-window';
import { pullOnBoard } from './open-pull-model';

let actions: (() => BoardActions) | undefined;

/** The page's BoardActions, as it gives them to the boards; each page registers its own once. */
export function setPullActions(get: () => BoardActions): void {
  actions = get;
}

/** Open `pr` in the pull request window when it is on this floor's PR board; false (nothing opened) when it is not or the page gave no actions. */
export function openPullHere(net: Net, pr: { number: number; url: string; repo?: string }, prFloor?: string): boolean {
  const it = actions && pullOnBoard(store.pulls.items, store.floor, pr, prFloor);
  if (!it || !actions) return false;
  openPull(it, net, actions());
  return true;
}

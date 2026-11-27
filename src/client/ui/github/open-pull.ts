// Open a pull request that is not a board card in hand (a task's) in the office's pull request window: each page says once how
// that window gets its BoardActions (setPullActions, and how it changes floors when it can), then anyone with a PR link asks openPullFrom.

import type { BoardActions } from './prompts';
import type { GhPull } from '../../../shared/protocol';
import { hostLabel, hostOfUrl } from '../../../shared/hosting/remote.js';
import type { Net } from '../../net';
import { store } from '../../state';
import { toast } from '../dom';
import { openSafe } from '../url';
import { getJson } from './api';
import { goToFloor } from './floor-trip';
import { ghUrl, repoOfItem } from './ghrepo';
import { openPull } from './pull-window';
import { resolvePull } from './open-pull-model';

let actions: (() => BoardActions) | undefined;
let goTo: ((floor: string) => void) | undefined;
/** A PR being resolved: a second ask meanwhile does nothing more. */
let resolving = false;

/**
 * The page's BoardActions, as it gives them to the boards; each page registers its own once. `go` changes the page's floor
 * (a plain floor.go) for a page that can; without it a PR of another floor opens on its host.
 */
export function setPullActions(get: () => BoardActions, go?: (floor: string) => void): void {
  actions = get;
  goTo = go;
}

/** Open the PR on its host, and say why it is not in the window. */
function onHost(pr: { url: string }, why: string): void {
  openSafe(pr.url);
  toast(`Opened on ${hostLabel(hostOfUrl(pr.url) ?? 'github')}: ${why}`);
}

/**
 * Open `pr` in the pull request window, at the moment of asking (the board changes): from the floor's board, else the one card
 * read from the office (it dropped out of the list, or the list is not read yet), after going to its floor `prFloor` first
 * when that is another one. On its host (with a toast saying why) when the window cannot be had. Resolves when done;
 * a second ask while one is resolving does nothing.
 */
export async function openPullFrom(net: Net, pr: { number: number; url: string; repo?: string }, prFloor?: string): Promise<void> {
  if (!actions) return onHost(pr, 'this page has no pull request window');
  if (resolving) return;
  resolving = true;
  try {
    const go = goTo;
    const got = await resolvePull(pr, prFloor, {
      page: () => ({ items: store.pulls.items, floor: store.floor, floors: store.floors }),
      ...(go ? { go: (floor: string) => goToFloor(floor, go) } : {}),
      fetch: () => getJson<GhPull>(ghUrl(`/api/gh/pull/card?number=${pr.number}`, repoOfItem(pr) || undefined)),
    });
    if ('card' in got) openPull(got.card, net, actions());
    else onHost(pr, got.why);
  } finally {
    resolving = false;
  }
}

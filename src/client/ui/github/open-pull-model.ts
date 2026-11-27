// Which card of the PR board a pull request linked elsewhere (a task's PR) is: the lookup behind open-pull.ts, apart from
// the window so a test can load it.

import type { GhPull } from '../../../shared/protocol';
import { findItem, repoOfItem } from './ghrepo';

/**
 * The board's card (of floor `floor`) for `pr`: its number in its repository, so another repository's same number is not it.
 * `prFloor` is the floor the PR belongs to when known; another floor's PR is on no card of this one.
 * A PR whose repository is not known (neither `repo` nor its URL) is found by number alone.
 */
export function pullOnBoard(items: readonly GhPull[], floor: string | null | undefined, pr: { number: number; url: string; repo?: string }, prFloor?: string): GhPull | undefined {
  if (prFloor && prFloor !== floor) return undefined;
  return findItem(items, pr.number, repoOfItem(pr) || undefined);
}

// The page's state: the store (./store.ts), made of the core and every slice (./slices), and what this
// browser remembers between visits (./persist.ts).

import type { WorkerInfo } from '../../shared/protocol';
import { SLICES } from './slices';
import { Store, workerForPull as workerForPullIn } from './store';
// a PR's worker by its repository too, on a project with several.
import { namedRepo, workerForRepoPull } from '../ui/github/ghrepo';

export { AVATAR_COLORS, HUD_DEFAULTS, lastFloor, lastSpot, loadProfile, loadSettings, rememberFloor, rememberSpot, saveProfile, saveSettings } from './persist';
export type { HudPanel, Profile, Settings, Spot, ViewMode } from './persist';
export type { ScreenState, Slice, Store, Topic, Topics } from './store';

export const store = new Store(SLICES);

/** The worker whose worktree branch a pull request came from, if it is still at a desk. */
export function workerForPull(workers: Iterable<WorkerInfo>, pr: { number: number; headRefName: string }): WorkerInfo | undefined {
  // a card of a project's multi-repo board (GhPull.repo) is matched in its own repository.
  const repo = namedRepo(pr);
  if (repo) return workerForRepoPull(workers, pr, repo, store.currentFloor()?.repo);
  return workerForPullIn(workers, pr);
}

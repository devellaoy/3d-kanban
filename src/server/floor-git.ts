import { existsSync } from 'node:fs';
import path from 'node:path';

/** What the issue and PR boards say on a project that isn't a git repository. */
export const NOT_GIT = "This project isn't a git repository, so there are no issues or pull requests to show.";

/**
 * Whether a floor is a git floor: its folder has a .git of its own (a folder nested inside some
 * other repository doesn't borrow that one's branch, origin, issues or PRs), or it's the checkout
 * the office was started in, which has always taken whatever git says there.
 */
export function isGitFloor(dir: string, local: boolean): boolean {
  return local || existsSync(path.join(dir, '.git'));
}

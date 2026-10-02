import { existsSync } from 'node:fs';
import path from 'node:path';

/** What the boards, the Changes window and every git or gh action say on a project that isn't a git repository. */
export const NOT_GIT = "This project isn't a git repository";

/**
 * Whether a floor is a git floor: its folder has a .git of its own (a folder nested inside some
 * other repository doesn't borrow that one's branch, origin, issues or PRs), or it's the checkout
 * the office was started in, which has always taken whatever git says there.
 */
export function isGitFloor(dir: string, local: boolean): boolean {
  return local || existsSync(path.join(dir, '.git'));
}

/** No file-system monitor program from the repository's config, for every git call the office makes. */
export const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'];

/**
 * git's own settings for the office's automatic calls: a checkout added as a folder may have any
 * .git/config, and these make git run nothing from it (no file-system monitor, no hooks). What
 * somebody asked for (a commit, a push, a worker's worktree) keeps the hooks: NO_FSMONITOR only.
 */
export const SAFE_GIT = [...NO_FSMONITOR, '-c', 'core.hooksPath=/dev/null'];

/** For every `git diff` the office runs by itself: no external diff or text conversion program from the repository's config. */
export const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

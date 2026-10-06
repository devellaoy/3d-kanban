// The GitHub repository a checkout's gh calls are about. Run without -R, gh picks the base
// repository from the checkout's remotes in the order upstream > github > origin (unless someone ran
// `gh repo set-default`), so a fork's checkout with an `upstream` remote would list, comment on and
// merge the upstream repository's issues and PRs. The office always means the checkout's own
// repository, its `origin`, so every gh call about a checkout names it explicitly.

import { normalizeRepo } from '../shared/floors.js';
import { otherHostRepo, remoteUrlOf } from './hosting/index.js';

/** owner/name of a checkout's `remote` (origin by default) on github.com; undefined when it has none. Read once with repoOf's (hosting/index.ts). */
export function checkoutRepo(dir: string, remote = 'origin'): string | undefined {
  const url = remoteUrlOf(dir, remote);
  return url && /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
}

/**
 * The office's name for a checkout's repository wherever it is hosted: owner/name on GitHub (as
 * checkoutRepo), else the host's qualified name (azure:org/project/repo, bitbucket:ws/repo; see
 * shared/hosting/remote.ts). Undefined for no remote, or a host the office doesn't know.
 */
export function checkoutRemote(dir: string, remote = 'origin'): string | undefined {
  return checkoutRepo(dir, remote) ?? otherHostRepo(dir, remote)?.id;
}

/** `-R owner/name` for a gh command about `repo`; nothing (gh's own choice) when it isn't known. */
export function repoFlag(repo: string | undefined): string[] {
  return repo ? ['-R', repo] : [];
}

/** A `gh api` path under `repos/owner/name`; gh's `{owner}/{repo}` placeholders when it isn't known. */
export function repoApi(repo: string | undefined, rest: string): string {
  return `repos/${repo ?? '{owner}/{repo}'}/${rest}`;
}

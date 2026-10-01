// The GitHub repository a checkout's gh calls are about. Run without -R, gh picks the base
// repository from the checkout's remotes in the order upstream > github > origin (unless someone ran
// `gh repo set-default`), so a fork's checkout with an `upstream` remote would list, comment on and
// merge the upstream repository's issues and PRs. The office always means the checkout's own
// repository, its `origin`, so every gh call about a checkout names it explicitly.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';

/** How long a checkout's remote is trusted before git is asked again (a remote can be added later). */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; repo?: string }>();

/** owner/name of a checkout's `remote` (origin by default) on github.com; undefined when it has none. */
export function checkoutRepo(dir: string, remote = 'origin'): string | undefined {
  const key = `${path.resolve(dir)}\0${remote}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.repo;
  let repo: string | undefined;
  try {
    const url = execFileSync('git', ['remote', 'get-url', remote], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    repo = /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    repo = undefined;
  }
  cache.set(key, { at: Date.now(), repo });
  return repo;
}

/** `-R owner/name` for a gh command about `repo`; nothing (gh's own choice) when it isn't known. */
export function repoFlag(repo: string | undefined): string[] {
  return repo ? ['-R', repo] : [];
}

/** A `gh api` path under `repos/owner/name`; gh's `{owner}/{repo}` placeholders when it isn't known. */
export function repoApi(repo: string | undefined, rest: string): string {
  return `repos/${repo ?? '{owner}/{repo}'}/${rest}`;
}

// The hosting providers' registry, and where a checkout is hosted. A host joins with its provider
// here (HOSTS) and its remotes in shared/hosting/remote.ts; see docs/code-layout.md, "Adding a
// hosting provider". GitHub has no entry: it stays on gh.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hostLabel, parseRemote, type HostKind, type OtherHost, type RepoRef } from '../../shared/hosting/remote.js';
import { azureProvider } from './azure.js';
import { bitbucketProvider } from './bitbucket.js';
import { HostCredentials } from './credentials.js';
import type { Fetch, HostingProvider } from './provider.js';

export const HOSTS: Partial<Record<OtherHost, HostingProvider>> = {
  azure: azureProvider,
  bitbucket: bitbucketProvider,
};

/** The provider for a host other than GitHub, or why there's none (Bitbucket Server, for now). */
export function providerOf(kind: OtherHost): HostingProvider | string {
  return HOSTS[kind] ?? `${hostLabel(kind)} repositories aren't supported yet: the office can't open or follow their pull requests`;
}

let creds: HostCredentials | undefined;
let fetchImpl: Fetch = (url, init) => globalThis.fetch(url, init);

/** Called once at startup (office/services.ts): where the credentials are kept. */
export function openHosting(dataDir: string): HostCredentials {
  creds = new HostCredentials(dataDir, HOSTS, (url, init) => fetchImpl(url, init));
  cache.clear();
  return creds;
}

/** The office's credential store; one in a temporary folder until openHosting runs (tests, scripts). */
export function hostCredentials(): HostCredentials | undefined {
  return creds;
}

/** The fetch the providers use; tests put a stub in (and get the old one back to restore). */
export function setHostFetch(f: Fetch): Fetch {
  const old = fetchImpl;
  fetchImpl = f;
  return old;
}

export function hostFetch(): Fetch {
  return (url, init) => fetchImpl(url, init);
}

export function serverHosts(): string[] {
  return creds?.serverHosts() ?? [];
}

/** How long a found remote is trusted (it is read on hot paths: every gh call, every state broadcast). */
const FOUND_MS = 10 * 60_000;
/** How long a miss (no remote, a host the office doesn't know, no git) is trusted: short, since a remote can be added later. */
const MISS_MS = 30_000;
const cache = new Map<string, { at: number; url?: string; repo?: RepoRef }>();

/** A checkout's `remote` as git has it, and where that is hosted: one cache for both (ghrepo.ts' checkoutRepo reads it too). */
function remoteOf(dir: string, remote: string): { url?: string; repo?: RepoRef } {
  const key = `${path.resolve(dir)}\0${remote}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.repo ? FOUND_MS : MISS_MS)) return hit;
  let url: string | undefined;
  try {
    url = execFileSync('git', ['remote', 'get-url', remote], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }).trim();
  } catch {
    url = undefined;
  }
  const got = { at: Date.now(), url, repo: url ? parseRemote(url, serverHosts()) : undefined };
  cache.set(key, got);
  return got;
}

/** Where a checkout's `remote` (origin by default) is hosted; undefined for no remote, or a host the office doesn't know. */
export function repoOf(dir: string, remote = 'origin'): RepoRef | undefined {
  return remoteOf(dir, remote).repo;
}

/** A checkout's `remote` URL (origin by default); undefined when it has none, or isn't a git checkout. */
export function remoteUrlOf(dir: string, remote = 'origin'): string | undefined {
  return remoteOf(dir, remote).url;
}

/** A checkout on a host other than GitHub, or undefined (GitHub, no remote, an unknown host). */
export function otherHostRepo(dir: string, remote = 'origin'): (RepoRef & { host: OtherHost }) | undefined {
  const r = repoOf(dir, remote);
  return r && r.host !== 'github' ? (r as RepoRef & { host: OtherHost }) : undefined;
}

/**
 * `env` for the office's own git reads (fetching a worktree's base branch): Azure DevOps and
 * Bitbucket over HTTPS answered with the office's token (HostCredentials.readGitEnv). Unchanged before openHosting.
 */
export function officeReadGitEnv(env: Record<string, string>): Record<string, string> {
  return creds ? creds.readGitEnv(env) : env;
}

/** Tests: forget what was read from the checkouts. */
export function forgetRemotes() {
  cache.clear();
}

export type { HostKind };

/**
 * What a worker's environment (`env`, as it is so far) needs for its own pushes to Azure DevOps and
 * Bitbucket over HTTPS: the office's credential helper with `owner`'s tokens (HostCredentials.workerGitEnv),
 * through git's environment config. Only the variables to add: it doesn't hang on how the account's
 * GitHub sign-in is set up. Nothing before openHosting.
 */
export function workerHostEnv(env: Record<string, string>, owner: string | undefined): Record<string, string> {
  const next = creds?.workerGitEnv({ ...env }, owner);
  if (!next) return {};
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => env[k] !== v));
}

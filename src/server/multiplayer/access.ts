// Who may see which of this office's floors. The owner's office decides, with the owner's own `gh`
// login: the relay learns nothing about repositories. A floor is open to a visitor only when the
// owner shared it AND the visitor can read every GitHub repository of the project themselves, so a
// visit never shows someone code they could not see on GitHub.
import { LOGIN_RE } from '../../shared/multiplayer/wire.js';
import { normalizeRepo } from '../../shared/floors.js';
import type { FloorDef } from '../building.js';
import { checkoutRepo } from '../ghrepo.js';
import { gh } from '../github.js';
import { projectRepos } from '../kanban/projects.js';

/** Runs `gh <args>` as the office and returns its output; rejects when gh fails (403, 404, offline). */
export type GhRunner = (args: string[]) => Promise<string>;
export type CanRead = (login: string, repo: string) => Promise<boolean>;

const READS = new Set(['admin', 'maintain', 'write', 'triage', 'read']);
const YES_MS = 10 * 60_000;
const NO_MS = 60_000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

let override: CanRead | undefined;
/** Replaces the GitHub check in every Access, for tests that must not call GitHub. */
export function setAccessCheckerForTests(fn: CanRead | undefined) {
  override = fn;
}

/** The GitHub repositories (owner/name) a project is made of; `missing` when one has none. */
export function floorRepos(def: FloorDef): { repos: string[]; missing?: string } {
  const repos: string[] = [];
  let missing: string | undefined;
  for (const r of projectRepos(def)) {
    // The floor's own checkout may have a GitHub origin the floor never saved (floor.ts reads it the same way).
    const remote = normalizeRepo(r.remote) ?? (r.primary && r.kind === 'git' ? checkoutRepo(r.dir) : undefined);
    if (remote && REPO_RE.test(remote)) repos.push(remote);
    else missing ??= r.name;
  }
  return { repos, missing };
}

export class Access {
  private cache = new Map<string, { ok: boolean; until: number }>();

  constructor(
    private run: GhRunner,
    private now: () => number = Date.now,
  ) {}

  /** Whether `login` can read `repo` (owner/name) on GitHub: a collaborator of any level, or anyone for a public repo. */
  async canRead(login: string, repo: string): Promise<boolean> {
    if (override) return override(login, repo);
    if (!LOGIN_RE.test(login) || !REPO_RE.test(repo) || repo.split('/').some((p) => /^\.+$/.test(p))) return false;
    const key = `${login.toLowerCase()}|${repo.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.ok;
    const ok = await this.ask(login, repo);
    this.cache.set(key, { ok, until: this.now() + (ok ? YES_MS : NO_MS) });
    return ok;
  }

  private async ask(login: string, repo: string): Promise<boolean> {
    try {
      const perm = (await this.run(['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.permission'])).trim();
      if (READS.has(perm)) return true;
    } catch {
      // 403 (the owner cannot see collaborators) or 404 (not a collaborator): only a public repo is left
    }
    try {
      return (await this.run(['api', `repos/${repo}`, '--jq', '.private'])).trim() === 'false';
    } catch {
      return false;
    }
  }

  /** Whether a floor can be shared at all: it needs a GitHub repository, for every repository it holds. */
  shareable(def: FloorDef): { shareable: boolean; why?: string } {
    const { repos, missing } = floorRepos(def);
    if (!repos.length) return { shareable: false, why: 'No GitHub repository: there is no way to check who may see it' };
    if (missing) return { shareable: false, why: `${missing} has no GitHub repository` };
    return { shareable: true };
  }

  /** The ids of the shared floors (of `defs`) whose every repository `login` can read. */
  async allowedFloors(defs: readonly FloorDef[], shared: readonly string[], login: string): Promise<string[]> {
    const out: string[] = [];
    await Promise.all(
      defs.map(async (def) => {
        if (!shared.includes(def.id) || !this.shareable(def).shareable) return;
        const reads = await Promise.all(floorRepos(def).repos.map((r) => this.canRead(login, r)));
        if (reads.every(Boolean)) out.push(def.id);
      }),
    );
    // In the building's order, whatever order GitHub answered in.
    return defs.map((d) => d.id).filter((id) => out.includes(id));
  }
}

/** An Access that asks the office's own `gh`, run in `cwd`. */
export const ghAccess = (cwd: string) => new Access((args) => gh(args, cwd, 20_000));

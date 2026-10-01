// Reading FloorDef.repos out of floors.json (see projects.ts). Kept apart from projects.ts, and free
// of the worker code, because building.ts imports it.

import path from 'node:path';
import { normalizeRepo } from '../../shared/floors.js';
import type { ProjectRepo } from '../../shared/kanban/types.js';
import { REPO_ID_RE } from '../../shared/kanban/protocol.js';

/** The most other repositories a project has: upstream's MAX_REPOS (workers.ts), which a test holds this to. */
export const MAX_PROJECT_REPOS = 8;
export const BRANCH_RE = /^[\w./-]{1,200}$/;

/**
 * What floors.json holds for `repos`, shape-checked only: folders aren't looked at (a disk that's
 * not mounted right now mustn't wipe a project's repositories). Undefined when there's nothing usable.
 */
export function loadRepos(raw: unknown, floorId: string, floorDir: string): ProjectRepo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = new Set<string>();
  const out: ProjectRepo[] = [];
  for (const r of raw.slice(0, MAX_PROJECT_REPOS + 1)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const primary = x.primary === true;
    const id = primary ? floorId : x.id;
    if (typeof id !== 'string' || (!primary && !REPO_ID_RE.test(id)) || ids.has(id)) continue;
    if (typeof x.dir !== 'string' || !path.isAbsolute(x.dir)) continue;
    if (primary && (out.some((o) => o.primary) || path.resolve(x.dir) !== path.resolve(floorDir))) continue;
    ids.add(id);
    out.push({
      id,
      name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 100) : path.basename(x.dir),
      kind: x.kind === 'folder' ? 'folder' : 'git',
      dir: x.dir,
      ...(normalizeRepo(x.remote) ? { remote: normalizeRepo(x.remote) } : {}),
      ...(typeof x.baseBranch === 'string' && BRANCH_RE.test(x.baseBranch) ? { baseBranch: x.baseBranch } : {}),
      primary,
      ...(typeof x.instructions === 'string' && x.instructions.trim() ? { instructions: x.instructions.slice(0, 20_000) } : {}),
    });
  }
  return out.length ? out : undefined;
}

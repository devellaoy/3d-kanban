// The 3D office's issues board from the project's issue sources (Settings → Issue sources). A floor
// whose project has any shows their issues on its board instead of its own repository's (upstream's
// `gh issue list`); one without keeps upstream's. The issues plugin provides the list while it runs;
// floor.ts and server.ts (upstream seams) ask this module, so they needn't import the plugin, nor the
// plugin the whole floor (as pulls/board.ts).

import type { GhIssue, GhState } from '../../../../shared/protocol.js';
import type { NormalizedIssue } from '../../../../shared/kanban/types.js';
import { labelColor, parseGhKey } from '../../../../shared/kanban/issuecard.js';
import { gh } from '../../../github.js';

/** What the plugin hands out for a project: undefined while it has no issue sources. */
export type WallProvider = (project: string) => GhState<GhIssue> | undefined;

let provider: WallProvider | undefined;
let watcher: ((project: string) => void) | undefined;
let refresher: ((project: string) => void) | undefined;
const listeners = new Map<string, Set<() => void>>();

/** How much of a body goes on the board (the task made from a card gets it all). */
export const WALL_BODY = 2000;

/**
 * One issue of a source as a card on the board. A GitHub issue of one of `projectRepos` (owner/name)
 * keeps its number, so upstream's issue window and actions work on it; any other card has 0 and is
 * known by its key (an issue of a repository outside the project too: the office can't open it).
 */
export function toGhIssue(i: NormalizedIssue, taskId?: number, projectRepos: string[] = []): GhIssue {
  const ghKey = parseGhKey(i.key);
  const inProject = !!ghKey && projectRepos.some((r) => r.toLowerCase() === ghKey.repo.toLowerCase());
  const assignees = (i.assignee ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return {
    number: inProject ? ghKey!.number : 0,
    title: i.title,
    // Every source leaves closed or done issues out unless told otherwise; a GitHub issue says which it is.
    state: i.source === 'github-repo' && i.status && i.status !== 'OPEN' ? i.status : 'OPEN',
    url: i.url,
    author: '',
    labels: i.labels.map((name) => ({ name, color: labelColor(name) })),
    assignees,
    createdAt: i.updatedAt,
    updatedAt: i.updatedAt,
    body: i.body.slice(0, WALL_BODY),
    comments: 0,
    ...(i.repo || ghKey ? { repo: i.repo ?? ghKey!.repo } : {}),
    key: i.key,
    source: i.source,
    ...(i.status ? { status: i.status } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

/** The issues plugin, while it runs: what the board shows, whom to ask to look more often, and to fetch again. */
export function setWallProvider(p: WallProvider | undefined, watch?: (project: string) => void, refresh?: (project: string) => void) {
  provider = p;
  watcher = p ? watch : undefined;
  refresher = p ? refresh : undefined;
}

/** The board's issues from the project's sources, or undefined: the floor shows its own repository's. */
export function wallIssues(project: string): GhState<GhIssue> | undefined {
  try {
    return provider?.(project);
  } catch (err) {
    console.error("agent-office: the issues board couldn't read the project's issue sources:", err);
    return undefined;
  }
}

/** Someone is on the floor: its sources are fetched at the pace for issues someone looks at. */
export function watchWall(project: string) {
  watcher?.(project);
}

/** Fetch the project's sources again (a card was claimed, say). */
export function refreshWall(project: string) {
  refresher?.(project);
}

/** `cb` runs whenever the project's cards may have changed; the returned function stops it. */
export function onWallIssues(project: string, cb: () => void): () => void {
  let set = listeners.get(project);
  if (!set) listeners.set(project, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(project);
  };
}

/** Tells the project's floor its cards may have changed; one listener that throws doesn't stop the others. */
export function wallChanged(project: string) {
  for (const cb of listeners.get(project) ?? []) {
    try {
      cb();
    } catch (err) {
      console.error("agent-office: a listener to the issues board failed:", err);
    }
  }
}

/**
 * Assigns a GitHub issue of any repository (its key, `gh:owner/name#12`) to whoever `env` signs in as
 * (else the office's gh). Resolves to why not, or nothing; a key that isn't a GitHub issue's is left be.
 */
export async function claimGhKey(key: string, cwd: string, env?: Record<string, string>, run: typeof gh = gh): Promise<string | undefined> {
  const it = parseGhKey(key);
  if (!it) return undefined;
  try {
    await run(['issue', 'edit', String(it.number), '-R', it.repo, '--add-assignee', '@me'], cwd, undefined, env);
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

// The 3D office's issues board from the project's issue sources (Settings → Issue sources). A floor
// whose project has any shows their issues on its board instead of its own repository's (upstream's
// `gh issue list`); one without keeps upstream's. The issues plugin provides the list while it runs;
// floor.ts and server.ts ask this module, so they needn't import the plugin, nor the
// plugin the whole floor (as pulls/board.ts).

import type { GhIssue, GhState } from '../../../../shared/protocol.js';
import { WALL_BODY, parseGhKey, toGhIssue } from '../../../../shared/kanban/issuecard.js';
import { gh } from '../../../github.js';

/** What the issues plugin does for the board while it runs. */
export interface WallProvider {
  /** The project's cards, or undefined while it has no issue sources. */
  board(project: string): GhState<GhIssue> | undefined;
  /** Someone is on the floor: fetch at the pace for issues someone looks at. */
  watch(project: string): void;
  /** Fetch the project's sources again (nothing without any). */
  refresh(project: string): void;
  /** The cards may have changed (a task made from one, a refresh): drop the built board. */
  forget(project: string): void;
  /** Whether the project knows the issue within its scope: one on its list, acted on, or browsed (the browsed set only holds scoped issues). */
  known(project: string, key: string): boolean;
  /** A card was taken (assigned) for work: move it to In progress on the project's boards. Resolves to a warning, or nothing. `env`: the taker's own gh. */
  started?(project: string, key: string, env?: Record<string, string>): Promise<string | undefined>;
  /** The project's sources changed: its old cards go, and the new ones are fetched (after one under way). */
  sourcesChanged(project: string): void;
}

let provider: WallProvider | undefined;
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, NodeJS.Timeout>();

/** How long refreshWall waits, so a run of claims (a queue seating several cards) fetches once. */
export const WALL_REFRESH_DELAY_MS = 3000;

export { WALL_BODY, toGhIssue };

/** The issues plugin, while it runs (undefined when it stops). */
export function setWallProvider(p: WallProvider | undefined) {
  provider = p;
  if (!p) {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  }
}

/** The board's issues from the project's sources, or undefined: the floor shows its own repository's. */
export function wallIssues(project: string): GhState<GhIssue> | undefined {
  try {
    return provider?.board(project);
  } catch (err) {
    console.error("agent-office: the issues board couldn't read the project's issue sources:", err);
    return undefined;
  }
}

/** Whether the project knows the issue key within its sources' scope although the board may not list it (a browsed or acted-on issue). */
export function wallKnows(project: string, key: string): boolean {
  try {
    return provider?.known(project, key) ?? false;
  } catch (err) {
    console.error("agent-office: the issues board couldn't look the issue up:", err);
    return false;
  }
}

/** Someone is on the floor: its sources are fetched at the pace for issues someone looks at. */
export function watchWall(project: string) {
  provider?.watch(project);
}

/** Fetch the project's sources again, `delayMs` from now (several calls in that time fetch once). */
export function refreshWall(project: string, delayMs = WALL_REFRESH_DELAY_MS) {
  if (!provider) return;
  clearTimeout(pending.get(project));
  pending.delete(project);
  if (delayMs <= 0) return provider.refresh(project);
  const t = setTimeout(() => {
    pending.delete(project);
    provider?.refresh(project);
  }, delayMs);
  t.unref?.();
  pending.set(project, t);
}

/** A card was taken for work: its Status moves to In progress on the project's boards, and the board is fetched again. Resolves to a warning, or nothing; never throws. */
export async function progressIssue(project: string, key: string, env?: Record<string, string>): Promise<string | undefined> {
  let warning: string | undefined;
  try {
    warning = await provider?.started?.(project, key, env);
  } catch (err) {
    warning = (err as Error)?.message ?? String(err);
  }
  refreshWall(project);
  return warning;
}

/** The project's issue sources were saved: the board follows them now. */
export function wallSourcesChanged(project: string) {
  provider?.sourcesChanged(project);
  wallChanged(project);
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
  provider?.forget(project);
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

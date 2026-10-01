// The task's Changes view (changesview.ts) worked out without the DOM, so tests/kanban-ui-changes.test.ts
// can run it: one row shape for upstream's live ChangedFile and the office's KanbanChangedFile, which
// modes a repository offers, which repository is which floor id in upstream's Changes messages, and
// when the live window's data (the worker's checkout over the WebSocket) can stand in for the HTTP one.

import type { ChangedFile, ChangesState, WorkerInfo } from '../../shared/protocol';
import type { KanbanChangedFile, KanbanRepoChangesInfo } from '../../shared/kanban/types.js';
import { parseRepoFloorId, repoFloorId } from '../../shared/kanban/repofloor.js';

/** All changes (the branch against its base), one commit at a time, or the worktree's uncommitted work. */
export type ChangesMode = 'all' | 'commits' | 'uncommitted';

/** A changed file as the view lists it, whichever source it came from. */
export interface ChangeRow {
  path: string;
  /** Where a renamed or copied file came from. */
  from?: string;
  /** The letter in its badge. */
  letter: string;
  /** The badge's colour: upstream's .st classes. */
  tone: 'M' | 'A' | 'D' | 'R' | 'T';
  word: string;
  additions: number;
  deletions: number;
  binary: boolean;
  uncommitted: boolean;
  /** The live file's fingerprint (a new one means its diff changed); none from the office's HTTP answers. */
  sig?: string;
}

const LIVE_WORD: Record<ChangedFile['status'], string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', T: 'type changed', '?': 'new file' };
const TASK_LETTER: Record<KanbanChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', unmerged: 'U', untracked: 'A' };
const TASK_TONE: Record<KanbanChangedFile['status'], ChangeRow['tone']> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'R', typechange: 'T', unmerged: 'M', untracked: 'A' };
const TASK_WORD: Record<KanbanChangedFile['status'], string> = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', copied: 'copied', typechange: 'type changed', unmerged: 'unmerged', untracked: 'new file' };

/** A file of upstream's live ChangesState. */
export function liveRow(f: ChangedFile): ChangeRow {
  const tone = f.status === '?' ? 'A' : f.status;
  return { path: f.path, ...(f.from ? { from: f.from } : {}), letter: tone, tone, word: LIVE_WORD[f.status], additions: f.additions, deletions: f.deletions, binary: f.binary, uncommitted: f.uncommitted, sig: f.sig };
}

/** A file of the office's answer (GET /api/kanban/tasks/<id>/changes|commit); `uncommitted` for the worktree's own. */
export function taskRow(f: KanbanChangedFile, uncommitted = false): ChangeRow {
  return { path: f.path, ...(f.oldPath ? { from: f.oldPath } : {}), letter: TASK_LETTER[f.status], tone: TASK_TONE[f.status], word: TASK_WORD[f.status], additions: f.additions, deletions: f.deletions, binary: !!f.binary, uncommitted };
}

/** The modes a repository offers: Uncommitted only while its worktree has some (or while it's the one on screen, so it doesn't vanish under you). */
export function changesModes(uncommitted: number | null, current: ChangesMode): ChangesMode[] {
  const out: ChangesMode[] = ['all', 'commits'];
  if (uncommitted !== null && (uncommitted > 0 || current === 'uncommitted')) out.push('uncommitted');
  return out;
}

/** The task's repositories, the primary one first. */
export function sortRepos<T extends Pick<KanbanRepoChangesInfo, 'primary'>>(repos: T[]): T[] {
  return [...repos.filter((r) => r.primary), ...repos.filter((r) => !r.primary)];
}

/** The floor id upstream's Changes messages use for a project's repository: none for the primary one (the floor itself). */
export function floorOfRepo(project: string, repoId: string): string | undefined {
  return repoId === project ? undefined : repoFloorId(project, repoId);
}

/** The repository a floor id of upstream's names: the primary one (the project's id) for none or for the project's own floor. */
export function repoOfFloor(project: string, floor?: string): string {
  if (!floor || floor === project) return project;
  const p = parseRepoFloorId(floor);
  return p && p.floor === project ? p.repo : project;
}

/**
 * Whether upstream's live Changes data can show `repoId`: the worker is on this page's floor (`w`) and
 * the repository is in its workspace. The floor id to watch it by, or null.
 */
export function liveFloor(w: Pick<WorkerInfo, 'repos'> | undefined, project: string, repoId: string): { floor: string | undefined } | null {
  if (!w) return null;
  const floor = floorOfRepo(project, repoId);
  if (floor === undefined) return { floor };
  return w.repos?.some((r) => r.floor === floor) ? { floor } : null;
}

/** A repository's pull request for its tab: the task's own link, else the one the worker opened from its desk. */
export function prOfRepo(project: string, repoId: string, prs: readonly { repoId: string; number: number }[] | undefined, w: Pick<WorkerInfo, 'pr' | 'repos'> | undefined): number | undefined {
  const own = prs?.filter((p) => p.repoId === repoId).pop();
  if (own) return own.number;
  const floor = floorOfRepo(project, repoId);
  return floor === undefined ? w?.pr?.number : w?.repos?.find((r) => r.floor === floor)?.pr?.number;
}

/** The row after (delta 1) or before (-1) the selected one, staying at the ends. */
export function stepRow(rows: readonly { path: string }[], selected: string | null, delta: number): string | null {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.path === selected);
  return rows[Math.max(0, Math.min(rows.length - 1, i + delta))].path;
}

/**
 * Whether a mode reads the office's HTTP answers even while the worker is followed live: Per commit,
 * and Uncommitted, which is the worktree against HEAD (the live window measures from the branch's
 * base, so a committed file edited again would show both, and one put back as the base had it none).
 */
export function readsHttp(mode: ChangesMode, live: boolean): boolean {
  return mode !== 'all' || !live;
}

/**
 * What a new live state makes stale of what was read over HTTP for its repository: the commits when
 * the branch moved (a commit, an amend, a rebase: its HEAD, else its count and subject, changed), and
 * the whole change and the worktree's work whenever the checkout changed at all.
 */
export function liveStale(prev: Pick<ChangesState, 'head' | 'ahead' | 'subject'> | null, next: Pick<ChangesState, 'head' | 'ahead' | 'subject'>): { commits: boolean; whole: boolean } {
  if (!prev) return { commits: false, whole: false };
  const moved = prev.head !== next.head || prev.ahead !== next.ahead || prev.subject !== next.subject;
  return { commits: moved, whole: true };
}

/**
 * What a mode needs read over HTTP for its repository. Per commit needs the commits; everything else,
 * and Per commit too while the worker is followed live, needs the whole change, whose worktree part
 * (against HEAD) says what is uncommitted: the live list can't (see readsHttp).
 */
export function httpNeeds(mode: ChangesMode, live: boolean): { whole: boolean; commits: boolean } {
  return { whole: mode !== 'commits' || live, commits: mode === 'commits' };
}

/**
 * How many files are uncommitted: the worktree against HEAD when it has been read (null: no
 * worktree), else, for a moment, the live list's own flags; undefined while neither is known.
 */
export function uncommittedOf(againstHead: number | null | undefined, live: Pick<ChangesState, 'files' | 'error'> | null | undefined): number | null | undefined {
  if (againstHead !== undefined) return againstHead;
  return live && !live.error ? live.files.filter((f) => f.uncommitted).length : undefined;
}

/**
 * The latest read of each key: an answer is taken only when no newer read of its key has started,
 * and the key hasn't been forgotten since (the source changed, ↻), so a slow old answer never
 * overwrites a fresh one.
 */
export class LatestReads {
  private latest = new Map<string, number>();
  private seq = 0;

  start(key: string): number {
    const token = ++this.seq;
    this.latest.set(key, token);
    return token;
  }

  /** Whether the answer to `token` is still wanted (once: it's the key's last word). */
  take(key: string, token: number): boolean {
    if (this.latest.get(key) !== token) return false;
    this.latest.delete(key);
    return true;
  }

  forget(key: string) {
    this.latest.delete(key);
  }

  clear() {
    this.latest.clear();
  }
}

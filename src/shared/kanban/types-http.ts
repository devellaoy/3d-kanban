// The shapes of a task's changes and reports over HTTP (integrations/changes, integrations/reports). Split out of
// types.ts, which re-exports them, to keep that file inside its size ceiling.

// --- A task's changes and reports, over HTTP (integrations/changes, integrations/reports) ---------

/** One file of a change, as the Changes tab lists it. */
export interface KanbanChangedFile {
  path: string;
  /** Where a renamed or copied file came from. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unmerged' | 'untracked';
  additions: number;
  deletions: number;
  binary?: boolean;
}

/** A diff: its files and its unified text, cut at a cap (`truncated`). */
export interface KanbanDiff {
  files: KanbanChangedFile[];
  diff: string;
  truncated: boolean;
}

/** One commit of a task's branch (base..branch). */
export interface KanbanCommit {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/**
 * A repository of a task as the Changes tab reads it: from the task's workspace (its worktree) while
 * there is one, else from the branch in the project's own checkout.
 */
export interface KanbanRepoChangesInfo {
  /** ProjectRepo.id. */
  id: string;
  name: string;
  /** The project's own checkout (its id is the project's): upstream's Changes window calls it no `repo`. */
  primary?: boolean;
  source: 'worktree' | 'checkout';
  /** What the change is measured against (origin/main, main, or the commit the worktree was cut from). */
  base?: string;
  baseCommit?: string;
  branch?: string;
  headCommit?: string;
  /** Why there's nothing to show, when there isn't. */
  error?: string;
}

/** GET /api/kanban/tasks/<id>/changes (no repo): the task's repositories. */
export interface KanbanChangesList {
  taskId: number;
  /** The task's project (= its floor): the primary repository's id, and the start of the others' floor ids. */
  project: string;
  /** The primary one first. */
  repos: KanbanRepoChangesInfo[];
}

/** GET /api/kanban/tasks/<id>/changes?repo=<id>: one repository's whole change, and its uncommitted work. */
export interface KanbanRepoChanges extends KanbanRepoChangesInfo, KanbanDiff {
  taskId: number;
  /** Uncommitted edits and new files in the worktree; null without a workspace. */
  workingTree: KanbanDiff | null;
}

/** GET /api/kanban/tasks/<id>/commits?repo=<id>. */
export interface KanbanCommitList extends KanbanRepoChangesInfo {
  taskId: number;
  commits: KanbanCommit[];
  /** How many files the worktree has uncommitted (the "Uncommitted" pseudo entry); null without a workspace. */
  uncommitted: number | null;
}

/** GET /api/kanban/tasks/<id>/uncommitted?repo=<id>: how many files the worktree has uncommitted against HEAD (null without one). */
export interface KanbanUncommitted {
  taskId: number;
  repo: string;
  uncommitted: number | null;
}

/** GET /api/kanban/tasks/<id>/commit?repo=<id>&hash=<sha>. */
export interface KanbanCommitChanges extends KanbanDiff {
  taskId: number;
  repo: string;
  commit: KanbanCommit;
}

/** A report file an investigation wrote (GET /api/kanban/tasks/<id>/reports). */
export interface KanbanReportFile {
  /** Its path under the task's report folder, with `/` between folders. */
  name: string;
  size: number;
  mtime: number;
}

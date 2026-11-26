// The review comments of a task's pull requests on the office's side (docs/kanban-architecture.md §4 and §5). A pr-comments run has the
// task's agent write a JSON file in the task's grant folder (the one place it can write besides its worktree); at the end of the turn the
// office reads it here, checks it (shared/kanban/prcomments.ts) and keeps what it accepted in a store of its own, out of the agent's reach
// (<filesDir>/prcomments/task-<id>.json), then deletes the file. The store also holds the answers the user sent (`pending` while the run that
// carries them starts, then `sent`) and, while a fetch runs, the column the task was in (`origin`), which the fetch's end puts it back to.

import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KanbanTask } from '../../../shared/kanban/types.js';
import { PR_COMMENTS_FILE_MAX, parsePrComments, type PrCommentAnswer, type PrCommentItem, type PrCommentsState } from '../../../shared/kanban/prcomments.js';
import { grantDir } from '../uploads.js';
import type { KanbanContext } from '../registry.js';
import type { CommentsBack, MachineEvent } from './machine.js';

/** What a fetch that ended without a list says first in its stored error. */
export const FAILED_START = "The fetch didn't finish: ";

/** What the office keeps of a task's review comments. */
export interface PrCommentsStore {
  /** When the list was fetched (ms); undefined while a fetch is still under way. */
  fetchedAt?: number;
  items: PrCommentItem[];
  dropped: number;
  /** How many repeated remarks were left out as duplicates (absent in an older store: 0). */
  duplicates?: number;
  /** Why the fetch failed: no list then. */
  error?: string;
  /** What the agent changed in the checkouts during the fetch, though it is read-only. */
  warning?: string;
  /** The column the task was in when the fetch started, until the fetch ends (kept while it is parked and resumed). */
  origin?: CommentsBack;
  /** The decisions the user sent, as they were then (the items go with them), until the run that carries them has started. */
  pending?: { items: PrCommentItem[]; answers: PrCommentAnswer[]; at: number };
  sent?: { items: PrCommentItem[]; answers: PrCommentAnswer[]; at: number };
}

export const prCommentsFile = (filesDir: string, taskId: number) => path.join(filesDir, 'prcomments', `task-${taskId}.json`);
/** The file the agent writes (the prompt's {{file}}). */
export const prCommentsGrantFile = (filesDir: string, taskId: number) => path.join(grantDir(filesDir, taskId), 'pr-comments.json');

export function readPrComments(filesDir: string, taskId: number): PrCommentsStore | undefined {
  try {
    const s = JSON.parse(readFileSync(prCommentsFile(filesDir, taskId), 'utf8')) as PrCommentsStore;
    return s && typeof s === 'object' && Array.isArray(s.items) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function writePrComments(filesDir: string, taskId: number, store: PrCommentsStore) {
  const file = prCommentsFile(filesDir, taskId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The agent's file removed, whatever it turned out to be (a link goes, not what it points at; a folder goes whole). */
export function dropAgentFile(filesDir: string, taskId: number) {
  try {
    rmSync(prCommentsGrantFile(filesDir, taskId), { recursive: true, force: true });
  } catch {
    // it stays; the next fetch clears it again
  }
}

/** Reads the store, lets `fn` change it and writes it back, with no wait between (one step for the single-threaded server): nothing a request holds from earlier is written over what another has done since. */
export function updatePrComments(filesDir: string, taskId: number, fn: (s: PrCommentsStore | undefined) => PrCommentsStore | undefined) {
  const next = fn(readPrComments(filesDir, taskId));
  if (next) writePrComments(filesDir, taskId, next);
  else removePrComments(filesDir, taskId);
}

/** A `pending` that is carried by a pr-answers run that is queued or going: any other never got its run (the office died between), and counts for nothing. */
export const pendingLive = (task: Pick<KanbanTask, 'phase' | 'runState'>) => task.phase === 'pr-answers' && task.runState !== 'idle';

/** Removes the store and the agent's file (a new fetch starts clean, or the task was deleted). */
export function removePrComments(filesDir: string, taskId: number) {
  rmSync(prCommentsFile(filesDir, taskId), { force: true });
  dropAgentFile(filesDir, taskId);
}

/** The agent's file, parsed; or why it can't be used. Only a plain file inside the grant folder, not a link, of a bounded size. */
export function readAgentFile(filesDir: string, taskId: number): { raw: unknown } | { error: string } {
  const file = prCommentsGrantFile(filesDir, taskId);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return { error: 'The agent left something other than a plain file where the list of comments should be' };
    if (st.size > PR_COMMENTS_FILE_MAX) return { error: 'The agent’s file of comments is over 1 MB' };
    const rel = path.relative(realpathSync(grantDir(filesDir, taskId)), realpathSync(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'The agent’s file of comments is not inside the task’s folder' };
    return { raw: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch (err) {
    return { error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'The agent did not write the list of comments' : `The agent’s file of comments could not be read: ${err instanceof SyntaxError ? 'it is not valid JSON' : (err as Error).message}` };
  }
}

/** What the Pull requests tab shows: `running` while a fetch is under way, else what the store holds. */
export function prCommentsState(filesDir: string, task: Pick<KanbanTask, 'id' | 'phase' | 'runState'> & Partial<Pick<KanbanTask, 'status' | 'waitingText' | 'waitingReason'>>): PrCommentsState {
  if (task.phase === 'pr-comments' && task.runState !== 'idle') return { status: 'running', items: [], dropped: 0, duplicates: 0 };
  // Parked (a usage limit, a question of the agent's, a stop that Retry carries on): the fetch is not over, and the task says why it waits.
  if (task.phase === 'pr-comments' && task.status === 'waiting') return { status: 'running', items: [], dropped: 0, duplicates: 0, waiting: task.waitingText || task.waitingReason || 'waiting' };
  const s = readPrComments(filesDir, task.id);
  if (!s || (s.fetchedAt === undefined && !s.error)) return { status: 'none', items: [], dropped: 0, duplicates: 0 };
  const sent = s.sent ?? (pendingLive(task) ? s.pending : undefined);
  return {
    status: s.error ? 'failed' : 'ready',
    ...(s.fetchedAt !== undefined ? { fetchedAt: s.fetchedAt } : {}),
    items: s.items,
    dropped: s.dropped,
    duplicates: s.duplicates ?? 0,
    ...(s.error ? { error: s.error } : {}),
    ...(s.warning ? { warning: s.warning } : {}),
    ...(sent ? { sent: { answers: sent.answers, at: sent.at } } : {}),
  };
}

/** The events that end a fetch of review comments, and why the abnormal ones failed it. */
const WHY: Partial<Record<MachineEvent['type'], (e: never) => string>> = {
  failed: (e: Extract<MachineEvent, { type: 'failed' }>) => e.error,
  stopped: (e: Extract<MachineEvent, { type: 'stopped' }>) => e.text ?? (e.by ? `Stopped by ${e.by}` : 'Stopped'),
  interrupted: (e: Extract<MachineEvent, { type: 'interrupted' }>) => e.text ?? 'Its worker went away mid-run',
  gaveUp: (e: Extract<MachineEvent, { type: 'gaveUp' }>) => e.text,
  stop: () => 'Stopped before it started',
};

/** The office's side of a pr-comments run, for the engine (Orchestrator). */
export class PrCommentsRuns {
  constructor(
    private ctx: Pick<KanbanContext, 'filesDir'>,
    private now: () => number,
  ) {}

  /** A fetch starts: the old list is cleared and where the task was is kept until it ends. */
  origin(taskId: number, back: CommentsBack) {
    removePrComments(this.ctx.filesDir, taskId); // the old list and any file left in the task's folder go: a new fetch starts clean
    writePrComments(this.ctx.filesDir, taskId, { items: [], dropped: 0, origin: back });
  }

  /**
   * The end of a pr-comments turn: reads the agent's file into the store (a failed read is a stored failure with its reason) and deletes it.
   * Says what came of it, for the task's conversation.
   */
  collect(task: Pick<KanbanTask, 'id' | 'prs'>, warning?: string): string {
    const got = readAgentFile(this.ctx.filesDir, task.id);
    const parsed = 'error' in got ? { items: [], dropped: 0, duplicates: 0, error: got.error } : parsePrComments(got.raw, task.prs.map((p) => p.url));
    const origin = readPrComments(this.ctx.filesDir, task.id)?.origin;
    writePrComments(this.ctx.filesDir, task.id, { fetchedAt: this.now(), items: parsed.items, dropped: parsed.dropped, duplicates: parsed.duplicates, ...(parsed.error ? { error: parsed.error } : {}), ...(origin ? { origin } : {}), ...(warning ? { warning } : {}) });
    dropAgentFile(this.ctx.filesDir, task.id);
    if (parsed.error) return `The review comments couldn't be read: ${parsed.error}`;
    const left = [...(parsed.duplicates ? [`${parsed.duplicates} duplicate${parsed.duplicates === 1 ? '' : 's'} left out`] : []), ...(parsed.dropped ? [`${parsed.dropped} left out as unusable`] : [])];
    return `Fetched ${parsed.items.length} unresolved review comment${parsed.items.length === 1 ? '' : 's'}${left.length ? ` (${left.join(', ')})` : ''}: they are on the Pull requests tab.`;
  }

  /**
   * An event as the machine should see it: the end of a fetch (a turn that ended, a stop, a failure) carries where the task was before it,
   * so it goes back there (machine.ts), and any end but a finished turn leaves a failed store with the reason. Any other event passes as it is.
   */
  ending(task: Pick<KanbanTask, 'id' | 'phase' | 'runState'>, e: MachineEvent): MachineEvent {
    const abnormal = WHY[e.type];
    if (task.phase !== 'pr-comments' || (e.type !== 'prCommentsDone' && !abnormal) || (e.type === 'stop' && task.runState !== 'queued')) return e;
    const s = readPrComments(this.ctx.filesDir, task.id);
    if (abnormal) writePrComments(this.ctx.filesDir, task.id, { fetchedAt: this.now(), items: [], dropped: 0, error: `${FAILED_START}${abnormal(e as never)}` });
    else if (s?.origin) writePrComments(this.ctx.filesDir, task.id, { ...s, origin: undefined });
    return s?.origin ? ({ ...e, back: s.origin } as MachineEvent) : e;
  }

  /** What the answers run's prompt lists: the decisions as they were sent. */
  answersFor(taskId: number): { items: PrCommentItem[]; answers: PrCommentAnswer[] } | undefined {
    const s = readPrComments(this.ctx.filesDir, taskId);
    return s?.pending ?? s?.sent;
  }
}

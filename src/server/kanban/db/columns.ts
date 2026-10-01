// How a task's fields map to the kanban database's columns, and how values go in and come out:
// JSON columns are parsed defensively, so a hand-edited row can't take the board down.

/** Each KanbanTask field that has a column of its own in `tasks`, by field name. */
export const TASK_COLUMNS: Record<string, string> = {
  project: 'project',
  title: 'title',
  description: 'description',
  type: 'type',
  status: 'status',
  ticket: 'ticket',
  ticketUrl: 'ticket_url',
  phase: 'phase',
  runState: 'run_state',
  waitingReason: 'waiting_reason',
  waitingText: 'waiting_text',
  reviewRound: 'review_round',
  tool: 'tool',
  model: 'model',
  effort: 'effort',
  usePlan: 'use_plan',
  planApproval: 'plan_approval',
  useReview: 'use_review',
  goal: 'goal',
  overrides: 'overrides',
  sessionId: 'session_id',
  reviewerSessionId: 'reviewer_session_id',
  workerId: 'worker_id',
  reviewerWorkerId: 'reviewer_worker_id',
  branch: 'branch',
  workspace: 'worktree',
  pendingMessages: 'pending_messages',
  retryAt: 'retry_at',
  retryAttempts: 'retry_attempts',
  flags: 'flags',
  tags: 'tags',
  summary: 'summary',
  createdBy: 'created_by',
  updatedAt: 'updated_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  doneAt: 'done_at',
  archivedAt: 'archived_at',
  deskId: 'desk_id',
  createdByAccount: 'created_by_account',
  queuedRun: 'queued_run',
  handoffFingerprint: 'handoff_fingerprint',
};
const JSON_FIELDS = new Set(['overrides', 'workspace', 'pendingMessages', 'flags', 'tags', 'queuedRun']);
const BOOL_FIELDS = new Set(['usePlan', 'useReview']);

export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}
export const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));
export const toDb = (field: string, v: unknown): unknown => {
  if (v === undefined || v === null) return JSON_FIELDS.has(field) && field !== 'workspace' && field !== 'queuedRun' ? (field === 'tags' || field === 'pendingMessages' ? '[]' : '{}') : null;
  if (JSON_FIELDS.has(field)) return JSON.stringify(v);
  if (BOOL_FIELDS.has(field)) return v ? 1 : 0;
  return v;
};

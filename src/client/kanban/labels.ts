// The words the kanban shows for the shared types (columns, phases, agents…) that several views
// name, and its times. English, like the rest of the office.

import type { IssueSourceKind, KanbanEffort, KanbanTool, PlanApproval, RunPhase, TaskStatus, WaitingReason } from '../../shared/kanban/types.js';

const COLUMNS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', waiting: 'Waiting', review: 'Review', done: 'Done', archived: 'Archive' };
const PHASES: Record<RunPhase, string> = { plan: 'plan', implement: 'implement', review: 'review', fix: 'fix', resume: 'resume', pr: 'PR', 'pr-fix': 'PR fix', compact: 'compact', 'pr-review': 'PR review' };
const WAITING: Record<WaitingReason, string> = {
  plan_questions: 'The plan has questions',
  plan_approval: 'The plan waits for your approval',
  agent_asking: 'The agent is asking in its terminal',
  stopped: 'Stopped',
  failed: 'Failed',
  usage_limit: 'Usage limit: retrying',
  interrupted: 'Interrupted',
};
const TOOLS: Record<KanbanTool, string> = { claude: 'Claude', codex: 'Codex' };
const EFFORTS: Record<KanbanEffort, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const columnName = (s: TaskStatus) => COLUMNS[s];
export const phaseName = (p: RunPhase | string) => (Object.prototype.hasOwnProperty.call(PHASES, p) ? PHASES[p as RunPhase] : p);
export const toolName = (x: KanbanTool) => TOOLS[x];
export const effortName = (e: KanbanEffort) => EFFORTS[e];
export const waitingName = (w: WaitingReason) => WAITING[w];

/** A pull request's state, by its tone (model.ts prTone). */
export const PR_STATE_NAMES = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' } as const;
export const APPROVAL_NAMES: Record<PlanApproval, string> = { auto: 'implement straight away', manual: 'wait for approval' };
export const SOURCE_KIND_NAMES: Record<IssueSourceKind, string> = { 'github-repo': 'GitHub repositories', 'github-project': 'GitHub project', jira: 'Jira' };

/** The units of a retry countdown (model.ts countdown). */
export const COUNTDOWN_UNITS = { s: 's', min: 'min', h: 'h', now: 'a moment' };

// --- Time -----------------------------------------------------------------------------------------

/** "30/09/2026, 14:12". */
export function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(ms);
}

/** "5 min ago", from `now`. */
export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto', style: 'short' });
  if (s < 60) return rtf.format(0, 'second');
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  return rtf.format(-Math.floor(s / 86400), 'day');
}

/** "45 s", "12 min", "1 h 05 min". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

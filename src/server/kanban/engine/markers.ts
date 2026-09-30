// Reading what an agent's final text says (docs/kanban-architecture.md §4): whether a plan is ready
// or asks questions, a review's verdict, the pull requests a PR turn opened, and whether the turn was
// cut short by a usage limit or the network. Pure: the orchestrator hands in the text it read.

import { PLAN_READY, PR_LINE, QUESTIONS_HEADING, REVIEW_LINE } from '../../../shared/kanban/prompts.js';
import type { ReviewVerdict } from '../../../shared/kanban/types.js';

export type PlanOutcome = 'ready' | 'questions';

/** A line with markdown emphasis or code quotes around it taken off (`**PLAN READY**` is still the marker). */
function bare(line: string): string {
  return line.trim().replace(/^[*_`>\s]+/, '').replace(/[*_`\s]+$/, '');
}

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/** An absolute path to a Markdown file: where plan mode wrote the plan, which makes the question marks in it no questions. */
const ABSOLUTE_MD = /(?:^|[\s(`'"[<])(?:\/|~\/|[A-Za-z]:[\\/])[^\s`'"()<>\]]*\.md\b/m;

/**
 * Whether a plan turn ended with a plan or with questions. A `PLAN READY` line wins; a `QUESTIONS:`
 * heading asks; with neither, two or more question marks and no absolute path to a .md file (plan
 * mode's plan file) count as questions; anything else is a plan. `exitPlan`: the agent left plan
 * mode (Claude's ExitPlanMode), which is a finished plan unless it still has a QUESTIONS: heading.
 */
export function planOutcome(text: string, exitPlan = false): PlanOutcome {
  const all = lines(text).map(bare);
  if (all.some((l) => l === PLAN_READY)) return 'ready';
  // Upper case, as the contract spells it: a plan's own "## Open questions" section is no heading.
  if (all.some((l) => l.replace(/^#+\s*/, '').startsWith(QUESTIONS_HEADING))) return 'questions';
  if (exitPlan) return 'ready';
  const marks = (text.match(/\?/g) ?? []).length;
  if (marks >= 2 && !ABSOLUTE_MD.test(text)) return 'questions';
  return 'ready';
}

/** A plan's text without the marker lines the contract asked for. */
export function stripPlanMarkers(text: string): string {
  return lines(text)
    .filter((l) => bare(l) !== PLAN_READY)
    .join('\n')
    .trim();
}

/** The review's verdict: the last line that is a REVIEW: line decides; none is changes requested. */
export function reviewVerdict(text: string): ReviewVerdict {
  let verdict: ReviewVerdict = 'changes_requested';
  for (const l of lines(text)) {
    const m = REVIEW_LINE.exec(bare(l));
    if (m) verdict = m[1] === 'APPROVED' ? 'approved' : 'changes_requested';
  }
  return verdict;
}

/** A review's findings, without its verdict lines (what the fix prompt hands the implementer). */
export function reviewFindings(text: string): string {
  return lines(text)
    .filter((l) => !REVIEW_LINE.test(bare(l)))
    .join('\n')
    .trim();
}

export interface PrLine {
  url: string;
  /** owner/name, for a github.com pull request URL. */
  repo?: string;
  number?: number;
}

/** The pull requests a PR turn reported, one `PR: <url>` line each (duplicates once). */
export function prLines(text: string): PrLine[] {
  const out = new Map<string, PrLine>();
  for (const l of lines(text)) {
    const m = PR_LINE.exec(bare(l).replace(/[.,;)]+$/, ''));
    if (!m) continue;
    const url = m[1];
    const gh = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
    out.set(url, gh ? { url, repo: gh[1], number: Number(gh[2]) } : { url });
  }
  return [...out.values()];
}

// --- Usage limits and lost connections ------------------------------------------------------------

/** What an interrupted turn looks like: a usage or rate limit, or the network. */
const LIMIT_HINTS = [
  /hit your (?:usage )?limit/i,
  /usage limit/i,
  /rate[- ]limit/i,
  /limit reached/i,
  /resets? (?:at )?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
  /quota exceeded|insufficient_quota/i,
  /overloaded/i,
  /API Error:\s*(?:429|5\d\d)/i,
  /connection (?:error|refused|reset|closed|timed out)/i,
  /network (?:error|is unreachable)/i,
  /stream (?:disconnected|error)/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
  /fetch failed/i,
  /socket hang up/i,
];

/**
 * Whether a turn's end looks like a usage limit or a lost connection rather than an answer. An API
 * error the transcript flags counts whatever its length; an ordinary final text only when it is short
 * (a real answer that happens to mention rate limiting is still an answer).
 */
export function looksInterrupted(text: string, apiError?: string): boolean {
  if (apiError && LIMIT_HINTS.some((re) => re.test(apiError))) return true;
  const t = text.trim();
  if (!t) return !!apiError;
  if (t.length > 400) return false;
  return LIMIT_HINTS.some((re) => re.test(t));
}

/**
 * When a limit says it resets ("resets 3pm", "resets at 15:30", "|1767225600" as Claude's usage-limit
 * line ends), as ms since the epoch, in the office's time zone. Undefined when it doesn't say.
 */
export function resetTime(text: string, now = Date.now()): number | undefined {
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    if (at > now) return at;
  }
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The wait before retry `attempt` (1, 2, ...) when the limit doesn't say when it resets: 5 min, doubling, at most an hour. */
export function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, attempt - 1));
}

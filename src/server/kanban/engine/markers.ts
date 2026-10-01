// Reading what an agent's final text says (docs/kanban-architecture.md §4): whether a plan is ready
// or asks questions, a review's verdict, the pull requests a PR turn opened, and whether the turn was
// cut short by a usage limit or the network. Pure: the orchestrator hands in the text it read.

import { PLAN_READY, PR_LINE, PR_URL, QUESTIONS_HEADING, REVIEW_LINE } from '../../../shared/kanban/prompts.js';
import type { ReviewVerdict } from '../../../shared/kanban/types.js';

export type PlanOutcome = 'ready' | 'questions';

/** A line with markdown emphasis or code quotes around it taken off (`**PLAN READY**` is still the marker). */
function bare(line: string): string {
  return line.trim().replace(/^[*_`>\s]+/, '').replace(/[*_`\s]+$/, '');
}

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/**
 * Every line of a text, bare, with whether a marker may be on it: not inside a fenced code block and
 * not a `>` quote, which is where an agent cites what it read (another review, the contract itself).
 * An unclosed fence runs to the end, so nothing after it counts either.
 */
function markerLines(text: string): { line: string; marker: boolean }[] {
  const out: { line: string; marker: boolean }[] = [];
  let fence: string | undefined;
  for (const l of lines(text)) {
    const t = l.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^[`~]+$/.test(t)) fence = undefined;
      out.push({ line: bare(l), marker: false });
      continue;
    }
    out.push({ line: bare(l), marker: !fence && !t.startsWith('>') });
  }
  return out;
}

/**
 * The lines a plan marker may be on: not a `>` quote and not inside a CLOSED code block (where an
 * agent cites the contract or shows an example). A fence left open to the end hides nothing: a
 * forgotten closing ``` must not swallow the PLAN READY after it.
 */
function planMarkers(text: string): string[] {
  const all = markerLines(text);
  let open = -1;
  let fence: string | undefined;
  lines(text).forEach((l, i) => {
    const t = l.trim();
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (!f) return;
    if (!fence) {
      fence = f[1];
      open = i;
    } else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^[`~]+$/.test(t)) fence = undefined;
  });
  return all.flatMap((l, i) => {
    const quoted = lines(text)[i].trim().startsWith('>');
    const inOpenFence = fence !== undefined && i > open;
    return l.marker || (inOpenFence && !quoted) ? [l.line] : [];
  });
}

/** The lines a PR: line may be on: every line but `>` quotes (an agent may well list its PRs in a code block). */
const prMarkerLines = (text: string) => lines(text).flatMap((l) => (l.trim().startsWith('>') ? [] : [bare(l)]));

/** How far from the end a review's verdict may be: the contract makes it the last line; a closing word after it is forgiven. */
const VERDICT_TAIL = 3;

/** An absolute path to a Markdown file: where plan mode wrote the plan, which makes the question marks in it no questions. */
const ABSOLUTE_MD = /(?:^|[\s(`'"[<])(?:\/|~\/|[A-Za-z]:[\\/])[^\s`'"()<>\]]*\.md\b/m;

/**
 * Whether a plan turn ended with a plan or with questions. A `PLAN READY` line wins; a `QUESTIONS:`
 * heading asks; with neither, two or more question marks and no absolute path to a .md file (plan
 * mode's plan file) count as questions; anything else is a plan. `exitPlan`: the agent left plan
 * mode (Claude's ExitPlanMode), which is a finished plan unless it still has a QUESTIONS: heading.
 */
export function planOutcome(text: string, exitPlan = false): PlanOutcome {
  const all = planMarkers(text);
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

/**
 * The review's verdict, from the final answer's last few non-empty lines only: the last of them that
 * is a REVIEW: line of its own (not in a code block, not a quote) decides. A verdict further up (an
 * earlier review quoted, a summary before the findings) is none; no verdict is changes requested.
 */
export function reviewVerdict(text: string): ReviewVerdict {
  const tail = markerLines(text)
    .filter((l) => l.line)
    .slice(-VERDICT_TAIL);
  for (const l of tail.reverse()) {
    const m = l.marker ? REVIEW_LINE.exec(l.line) : null;
    if (m) return m[1] === 'APPROVED' ? 'approved' : 'changes_requested';
  }
  return 'changes_requested';
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

const GH_PULL = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;

/** A PR URL as the office keeps it: a github.com one is reduced to its pull request (no /files, #..., ?...). */
function prLine(url: string): PrLine {
  const gh = GH_PULL.exec(url);
  return gh ? { url: `https://github.com/${gh[1]}/pull/${gh[2]}`, repo: gh[1], number: Number(gh[2]) } : { url };
}

/**
 * The pull requests a PR turn reported, one `PR: <url>` line each (see PR_LINE; duplicates once,
 * first appearance first). A URL anywhere else in the text isn't reported: the board sync links a
 * PR from the task's branch. Quotes don't count.
 */
export function prLines(text: string): PrLine[] {
  const out = new Map<string, PrLine>();
  for (const l of prMarkerLines(text)) {
    const named = PR_LINE.exec(l);
    const u = named ? PR_URL.exec(named[1]) : null;
    if (!u) continue;
    const hit = prLine((u[1] ?? u[2] ?? u[3]).replace(/[.,;)>\]]+$/, ''));
    const key = hit.url.toLowerCase();
    if (!out.has(key)) out.set(key, hit);
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

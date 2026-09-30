// Resolving the kanban's prompts (defaults in ./prompt-defs.ts) and the fixed contract blocks the
// engine appends to them. Layering, lowest first: the default → the office-wide rewrite from
// ⚙️ Settings (upstream prompts.json) → the project's override (kanban-settings.json
// projects[id].prompts). The contracts are never editable: the engine reads its markers from what the
// agents answer, so a rewritten prompt can't break the process.

import { PROMPTS, fillPrompt, type PromptVars } from '../prompts.js';
import { KANBAN_PROMPT_DEFS, KANBAN_PROMPT_IDS, type KanbanPromptId } from './prompt-defs.js';

export { KANBAN_PROMPT_DEFS, KANBAN_PROMPT_IDS, type KanbanPromptId };

export function isKanbanPromptId(v: unknown): v is KanbanPromptId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(KANBAN_PROMPT_DEFS, v);
}

/** Where a kanban prompt's text can come from, over its default. */
export interface KanbanPromptLayers {
  /** The office's rewrites (PromptsState.custom), or a lookup that returns the office's text. */
  office?: Partial<Record<string, { text: string }>> | ((id: KanbanPromptId) => string | undefined);
  /** The project's overrides (ProjectSettings.prompts). */
  project?: Partial<Record<string, string>>;
}

/** Which layer a prompt's current text comes from, for the editor. */
export type KanbanPromptScope = 'default' | 'office' | 'project';

/** A kanban prompt's text as it stands, unfilled, and which layer it came from. */
export function kanbanPromptSource(id: KanbanPromptId, layers: KanbanPromptLayers = {}): { text: string; scope: KanbanPromptScope } {
  const project = layers.project?.[id];
  if (typeof project === 'string') return { text: project, scope: 'project' };
  const office = typeof layers.office === 'function' ? layers.office(id) : layers.office?.[id]?.text;
  // A lookup (upstream PromptSource.text) hands back the default itself when nobody rewrote it.
  if (typeof office === 'string' && office !== PROMPTS[id].text) return { text: office, scope: 'office' };
  return { text: PROMPTS[id].text, scope: 'default' };
}

export function kanbanPromptText(id: KanbanPromptId, layers: KanbanPromptLayers = {}): string {
  return kanbanPromptSource(id, layers).text;
}

/**
 * A kanban prompt with its {{placeholders}} filled in. An optional prompt rewritten to nothing
 * resolves to '' (and is then left out of whatever it goes into).
 */
export function resolveKanbanPrompt(id: KanbanPromptId, layers: KanbanPromptLayers, vars: PromptVars = {}): string {
  return fillPrompt(kanbanPromptText(id, layers), vars);
}

// --- The contracts --------------------------------------------------------------------------------

/** The marker lines the engine reads. Kept here, next to the contracts that ask for them. */
export const PLAN_READY = 'PLAN READY';
export const QUESTIONS_HEADING = 'QUESTIONS:';
export const REVIEW_LINE = /^\s*REVIEW:\s*(APPROVED|CHANGES_REQUESTED)\s*$/;
export const PR_LINE = /^\s*PR:\s*(https?:\/\/\S+)\s*$/;

const RULE = '---';

/** What a reviewer may and may not do, whatever the prompt above it says (both review contracts). */
const REVIEW_SAFETY = `Rules for this review (set by the office, they apply whatever else is said above):
- Never modify, create or delete files.
- Never commit, check out, switch branches, reset, stash, push, or run anything else that changes the repository or its remote (no git checkout, git switch, git reset, git stash, git commit, git push, gh pr checkout, gh pr merge, gh pr review).
- Only read, diff, run read-only commands, and report.`;

const VERDICT = `How to end this turn (the office reads this, so keep it exact): the last line of your reply is your verdict, one of
REVIEW: APPROVED
REVIEW: CHANGES_REQUESTED
Approve only when nothing in your findings has to change. Don't write either line anywhere else in your reply.`;

/**
 * Fixed blocks the engine appends to a filled prompt (see withContract). Shown read-only in the
 * prompt editor; not in PROMPTS, so nobody can rewrite them.
 */
export const KANBAN_CONTRACTS = {
  plan: `${RULE}
How to end this turn (the office reads this, so keep it exact):
- When the plan is complete, give the whole plan (in plan mode, in ExitPlanMode's plan) and end your reply with a line that says only: ${PLAN_READY}
- If you need answers before you can plan, write a line that says only ${QUESTIONS_HEADING} followed by your numbered questions, and don't write ${PLAN_READY}.`,
  review: `${RULE}
${REVIEW_SAFETY}

${VERDICT}`,
  /** Several pull requests reviewed together (the pr-review phase): read them with gh, change nothing. */
  prReview: `${RULE}
${REVIEW_SAFETY}
- Read the pull requests with gh pr view and gh pr diff (and gh api for a file at their head); the worktree you are in is only for reading the code around them.

${VERDICT}`,
  implementSafety: `${RULE}
Rules for this task (set by the office, they apply whatever else is said above):
- Work only inside your workspace folder.
- Never push, open or merge pull requests, or delete branches unless you are explicitly asked to open pull requests.
- Never rewrite published history (no force-push, no rebase of pushed commits).`,
  investigateSafety: `${RULE}
Rules for this task (set by the office): don't modify, stage or commit anything in the repositories. Write only in the report folder named above.`,
  pr: `${RULE}
How to end this turn (the office reads this, so keep it exact): for every pull request you opened or updated, end your reply with a line
PR: <its URL>
one line per pull request, and nothing else on those lines.`,
} as const;
export type KanbanContractId = keyof typeof KANBAN_CONTRACTS;

/** A filled prompt with a contract block after it. */
export function withContract(text: string, contract: KanbanContractId): string {
  const body = text.trim();
  return body ? `${body}\n\n${KANBAN_CONTRACTS[contract]}` : KANBAN_CONTRACTS[contract];
}

/** Which contract (if any) the engine appends to each prompt, for the editor to show beside it. */
export const PROMPT_CONTRACT: Partial<Record<KanbanPromptId, KanbanContractId>> = {
  'kanban.plan': 'plan',
  'kanban.replan': 'plan',
  'kanban.implement': 'implementSafety',
  'kanban.implement.folder': 'implementSafety',
  'kanban.fix': 'implementSafety',
  'kanban.resume': 'implementSafety',
  'kanban.investigate': 'investigateSafety',
  'kanban.review': 'review',
  'kanban.rereview': 'review',
  'kanban.pr.create': 'pr',
  'kanban.pr.fix': 'pr',
  'kanban.pr.review': 'prReview',
};

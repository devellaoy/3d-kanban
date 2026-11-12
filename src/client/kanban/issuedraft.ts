// The prompt the office's default agent drafts from an issue picked in the New task form, without the
// DOM (create.ts shows the status line and fills the description, this asks and decides): the request,
// whether its answer still has a place to go, and what a failure says.

import type { NormalizedIssue } from '../../shared/kanban/types.js';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanApi } from './api';

type IssueDraft = Extract<KanbanServerMsg, { t: 'kanban.issueDraft' }>;

/** How long the browser waits: past the office's own limit for the agent (45 s), so the office's reason arrives. */
export const DRAFT_ANSWER_MS = 50_000;

/** Asks for the draft. An empty text means there is nothing to write (the drafting is off, say): not an error. */
export async function requestIssueDraft(api: Pick<KanbanApi, 'request'>, project: string, issue: Pick<NormalizedIssue, 'key' | 'sourceId'>): Promise<string> {
  const answer = await api.request<IssueDraft>({ t: 'kanban.issues.draft', project, issueKey: issue.key, ...(issue.sourceId ? { source: issue.sourceId } : {}) }, DRAFT_ANSWER_MS);
  return answer.text ?? '';
}

/** A request for a draft: its number in the form, and the issue it was made for. */
export interface DraftAsked {
  seq: number;
  issueKey: string;
}

/** The form when the answer comes. */
export interface DraftForm {
  /** The number of the newest request, or of whatever made the earlier ones void since. */
  seq: number;
  /** The window is still open. */
  open: boolean;
  /** The issue picked now, if any. */
  pickedKey: string | null | undefined;
  description: string;
}

/**
 * Whether an answer still goes to the form: it is for the newest request, the window is open, the same
 * issue is picked and nothing has been written in the description meanwhile.
 */
export function draftApplies(asked: DraftAsked, form: DraftForm): boolean {
  return asked.seq === form.seq && form.open && form.pickedKey === asked.issueKey && !form.description.trim();
}

/** What to say of a failed draft, or null for one a newer request replaced, which is no news. */
export function draftFailure(err: unknown): string | null {
  const why = (err instanceof Error ? err.message : String(err ?? '')).trim();
  return /^cancell?ed$/i.test(why) ? null : `Couldn’t draft a prompt: ${why || 'no reason given'}`;
}

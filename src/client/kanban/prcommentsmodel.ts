// The review comments of the task view's Pull requests tab without the DOM (taskprcomments.ts draws them): the list by
// pull request, the words of each state and mark, the decisions being filled in (kept per task and per fetched list, so
// a redraw keeps them and a new fetch starts clean) and when they can be sent.

import { PR_ANSWER_TEXT_MAX, answersComplete, type PrCommentAnswer, type PrCommentDecision, type PrCommentItem, type PrCommentsState } from '../../shared/kanban/prcomments.js';
import type { KanbanPrLink } from '../../shared/kanban/types.js';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** A mark of the agent's analysis: its word and how it is coloured. */
export interface Mark {
  text: string;
  tone: Tone;
}

export const VALID_MARK: Record<PrCommentItem['valid'], Mark> = {
  yes: { text: 'Yes', tone: 'good' },
  partly: { text: 'Partly', tone: 'warn' },
  no: { text: 'No', tone: 'bad' },
};
export const CAUSED_MARK: Record<PrCommentItem['causedByTask'], Mark> = {
  yes: { text: 'Yes', tone: 'warn' },
  no: { text: 'No', tone: 'neutral' },
  unknown: { text: 'Unknown', tone: 'neutral' },
};
export const RECOMMEND_MARK: Record<PrCommentItem['recommend'], Mark> = {
  fix: { text: 'Fix', tone: 'good' },
  skip: { text: 'Skip', tone: 'neutral' },
};

export const KIND_LABEL: Record<PrCommentItem['kind'], string> = { line: 'Line comment', conversation: 'Conversation', review: 'Review' };
export const DECISION_LABEL: Record<PrCommentDecision, string> = { fix: 'Fix', skip: 'Don’t fix', custom: 'Other' };

export const RUNNING_TEXT = 'The implementer is reading the review comments…';
export const EMPTY_TEXT = 'No open review comments.';
/** A fetch that is parked (a usage limit, a question of the agent's): the notice's title, over the task's own reason. */
export const WAITING_TITLE = 'The fetch of the review comments is waiting';
/** A fetch only reads; the notice's title when it changed files anyway, over what it changed. */
export const WARNING_TITLE = 'The fetch left changes behind';

/** The warning of a fetched list or a failed fetch (never of a running one), trimmed; undefined when there is none. */
export function warningOf(s: Pick<PrCommentsState, 'status' | 'warning'> | null | undefined): string | undefined {
  if (!s || (s.status !== 'ready' && s.status !== 'failed')) return undefined;
  return s.warning?.trim() || undefined;
}

/** What the note under the list says of the items the office left out. */
export function droppedText(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'} the agent wrote could not be read`;
}

/** What the note under the list says of the repeats left out. */
export function duplicatesText(n: number): string {
  return n === 1 ? '1 duplicate remark was left out' : `${n} duplicate remarks were left out`;
}

/** The number of the remark an item is, when its comment holds several (an id ending in `#<k>`), else undefined. */
export function remarkOf(id: string): number | undefined {
  const m = /#(\d{1,4})$/.exec(id);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : undefined;
}

/** The label of the remark's number. */
export function remarkText(n: number): string {
  return `Remark ${n}`;
}

/** Where a comment is: a line comment's file and line, else its kind. */
export function placeText(i: Pick<PrCommentItem, 'kind' | 'path' | 'line'>): string {
  if (i.path) return i.line ? `${i.path}:${i.line}` : i.path;
  return KIND_LABEL[i.kind];
}

/** The address as a link's href: https only, anything else gets no link. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface PrGroup {
  /** The pull request's address, as the items name it. */
  pr: string;
  /** The repository as the PRs table shows it, and the number; both missing for a pull request the task no longer links. */
  repo?: string;
  number?: number;
  items: PrCommentItem[];
}

/** The items by pull request: the task's links in their order first, then any the task no longer has. `repoName`: a link's repository as the table names it. */
export function groupByPr(items: readonly PrCommentItem[], prs: readonly Pick<KanbanPrLink, 'url' | 'number' | 'repo' | 'repoId'>[], repoName: (p: Pick<KanbanPrLink, 'repo' | 'repoId'>) => string = (p) => p.repo ?? p.repoId): PrGroup[] {
  const groups = new Map<string, PrGroup>();
  for (const p of prs) if (!groups.has(p.url)) groups.set(p.url, { pr: p.url, repo: repoName(p), number: p.number, items: [] });
  for (const i of items) {
    let g = groups.get(i.pr);
    if (!g) groups.set(i.pr, (g = { pr: i.pr, items: [] }));
    g.items.push(i);
  }
  return [...groups.values()].filter((g) => g.items.length);
}

/** What the user has filled in for one comment so far. */
export interface Draft {
  decision?: PrCommentDecision;
  text?: string;
}
export type Drafts = Map<string, Draft>;

/** The decisions being filled in, by task: one list's at a time, the one fetched at `fetchedAt`. */
export class DraftStore {
  private byTask = new Map<number, { fetchedAt: number; drafts: Drafts }>();

  /** The drafts of the task's list fetched at `fetchedAt`; a list fetched at another time starts empty. */
  of(taskId: number, fetchedAt: number): Drafts {
    let d = this.byTask.get(taskId);
    if (!d || d.fetchedAt !== fetchedAt) this.byTask.set(taskId, (d = { fetchedAt, drafts: new Map() }));
    return d.drafts;
  }

  clear(taskId: number) {
    this.byTask.delete(taskId);
  }
}

/** The drafts as the answers to send: only the comments with a decision, the text trimmed and cut to its cap, left out when empty. */
export function draftAnswers(items: readonly PrCommentItem[], drafts: Drafts): PrCommentAnswer[] {
  const out: PrCommentAnswer[] = [];
  for (const i of items) {
    const d = drafts.get(i.id);
    if (!d?.decision) continue;
    const text = d.text?.trim().slice(0, PR_ANSWER_TEXT_MAX);
    out.push({ id: i.id, decision: d.decision, ...(text ? { text } : {}) });
  }
  return out;
}

/** How many comments have an answer that can go: a decision, and for Other its text. */
export function answeredCount(items: readonly PrCommentItem[], drafts: Drafts): number {
  return draftAnswers(items, drafts).filter((a) => a.decision !== 'custom' || !!a.text).length;
}

export function countText(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}

/** The text box's hint: what it is for with the decision picked. */
export function textHint(decision: PrCommentDecision | undefined): string {
  return decision === 'custom' ? 'What the implementer should do (required)' : 'An extra instruction for the implementer (optional)';
}

export const SEND_TITLE = 'The implementer acts on these decisions: it fixes, follows your text or leaves the code alone, and answers each comment';

/** Whether Send to the implementer can be pressed, and its tooltip (why not, when it can't). */
export function sendState(items: readonly PrCommentItem[], drafts: Drafts, can: { ok: boolean; reason?: string }): { enabled: boolean; title: string } {
  if (!answersComplete(items, draftAnswers(items, drafts))) {
    const custom = items.some((i) => drafts.get(i.id)?.decision === 'custom' && !drafts.get(i.id)?.text?.trim());
    const undecided = items.some((i) => !drafts.get(i.id)?.decision);
    return { enabled: false, title: undecided ? 'Pick Fix, Don’t fix or Other for every comment first' : custom ? 'An Other answer needs its text' : 'Answer every comment first' };
  }
  if (!can.ok) return { enabled: false, title: can.reason ?? 'The task can’t take this now' };
  return { enabled: true, title: SEND_TITLE };
}

/** What the tab shows for a state: nothing, one line, a parked fetch's notice, the failure, or the list (open to fill in, or locked once sent). */
export type CommentsView = { kind: 'none' } | { kind: 'line'; text: string } | { kind: 'waiting'; title: string; reason: string } | { kind: 'failed'; error: string } | { kind: 'list'; locked: boolean; fetchedAt: number };

export function viewOf(s: PrCommentsState | null | undefined): CommentsView {
  if (!s || s.status === 'none') return { kind: 'none' };
  if (s.status === 'running') return s.waiting?.trim() ? { kind: 'waiting', title: WAITING_TITLE, reason: s.waiting.trim() } : { kind: 'line', text: RUNNING_TEXT };
  if (s.status === 'failed') return { kind: 'failed', error: s.error || 'The review comments could not be fetched' };
  if (!s.items.length) return { kind: 'line', text: EMPTY_TEXT };
  return { kind: 'list', locked: !!s.sent, fetchedAt: s.fetchedAt ?? 0 };
}

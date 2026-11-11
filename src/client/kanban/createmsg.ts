// What the New task form sends, worked out without the DOM (create.ts reads the fields, this decides):
// a plain kanban.task.create titled by the description's first line, or, with an issue picked by
// Select issue, kanban.issues.createTask carrying the form's fields (the office then takes the title,
// the link and the text from the issue, and makes one task per issue).

import { KANBAN_LIMITS, type IssueTaskFields, type KanbanClientMsg } from '../../shared/kanban/protocol.js';
import type { KanbanEffort, KanbanTool, ReviewSettings } from '../../shared/kanban/types.js';
import { titleFrom } from './office';

type WithoutRid<T> = T extends unknown ? Omit<T, 'rid'> : never;
export type NewTaskMsg = WithoutRid<Extract<KanbanClientMsg, { t: 'kanban.task.create' | 'kanban.issues.createTask' }>>;

/** The form as it stands: the texts as typed, and the rest as the task takes it. */
export interface NewTaskFields {
  project: string;
  description: string;
  ticket: string;
  ticketUrl: string;
  /** Everything else the form sets (type, repositories, plan and review, agent, criteria, tags, files). */
  rest: Omit<IssueTaskFields, 'title' | 'description'>;
  start?: boolean;
  /** The dialog's request key: a resend after no answer gets the first one's answer, not a second task. */
  once?: string;
}

/** A line that is nothing but a Markdown image or link: an attached file, which says nothing as a title. */
const ONLY_LINK = /^!?\[[^\]]*\]\([^)]*\)$/;

/**
 * A task's title from its Markdown description: the first line with words of its own (titleFrom), past
 * the lines that are only an attachment's link, which the form puts in the text. A description of
 * nothing but links is titled by its first one.
 */
export function markdownTitle(description: string): string {
  const said = description.split('\n').filter((l) => l.trim() && !ONLY_LINK.test(l.trim()));
  return titleFrom(said.join('\n')) || titleFrom(description);
}

/**
 * The message for a new task. The pick stands while the Ticket box still holds its key: once that is
 * typed over, the task is a plain one with the ticket as written.
 */
export function newTaskMsg(f: NewTaskFields, picked: { key: string } | null | undefined): { msg: NewTaskMsg } | { error: string } {
  const start = f.start ? { start: true } : {};
  const once = f.once ? { once: f.once } : {};
  const description = f.description.trim() ? { description: f.description } : {};
  if (picked && f.ticket.trim() === picked.key) {
    return { msg: { t: 'kanban.issues.createTask', project: f.project, issueKey: picked.key, ...start, task: { ...f.rest, ...description }, ...once } };
  }
  const title = markdownTitle(f.description).slice(0, KANBAN_LIMITS.title);
  if (!title) return { error: 'Say what the task is: its first line is the title' };
  return {
    msg: {
      t: 'kanban.task.create',
      task: { project: f.project, title, ...f.rest, ...description, ...(f.ticket.trim() ? { ticket: f.ticket.trim() } : {}), ...(f.ticketUrl.trim() ? { ticketUrl: f.ticketUrl.trim() } : {}) },
      ...start,
      ...once,
    },
  };
}

/** The form's review fields as they stand. */
export interface ReviewForm {
  useReview: boolean;
  /** "Choose the reviewer" is ticked: the task has a reviewer of its own. */
  choose: boolean;
  /** The number beside "Review rounds". */
  rounds: number;
  /** The project's number of rounds, which the box shows until it is changed. */
  baseRounds: number;
  tool: KanbanTool;
  model: string;
  effort: KanbanEffort | '';
  reReviewLastFix: boolean;
}

/**
 * The task's own review settings, or undefined for none: the project's number of rounds with no
 * reviewer chosen is no override at all (the message is then what it was before the number stood beside
 * its tick box); another number alone is a rounds-only override; a chosen reviewer carries everything.
 */
export function reviewOverride(f: ReviewForm): Partial<ReviewSettings> | undefined {
  if (!f.useReview) return undefined;
  if (!f.choose) return f.rounds === f.baseRounds ? undefined : { rounds: f.rounds };
  const out: Partial<ReviewSettings> = { tool: f.tool, rounds: f.rounds, reReviewLastFix: f.reReviewLastFix };
  if (f.model.trim()) out.model = f.model.trim();
  if (f.effort) out.effort = f.effort;
  return out;
}

/** What the form opens with for a stored override: its rounds (the project's without one), and whether a reviewer was chosen (more than the rounds is stored). */
export function reviewStart(override: Partial<ReviewSettings> | undefined, baseRounds: number): { rounds: number; choose: boolean; ownRounds: boolean } {
  return { rounds: override?.rounds ?? baseRounds, choose: !!override && Object.keys(override).some((k) => k !== 'rounds'), ownRounds: override?.rounds !== undefined };
}

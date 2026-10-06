// The messages about a project's issues (docs/kanban-architecture.md §6): listing them, making a
// task of one, and the actions on one issue of an issue source: its status, its comments, its
// assignee. They are keyed by the issue's key (`UYT-12`, `gh:owner/repo#5`, `ghp:owner/1#<item>`),
// never by the source that happened to list it first. The parsers use validate.ts; protocol.ts joins
// these into the kanban's unions and calls parseIssueOpsMsg for any type in ISSUE_OPS_CLIENT_TYPE_LIST.

import type { NormalizedIssue } from './types.js';
import { BROWSE_CLIENT_TYPE_LIST, parseBrowseMsg, type BrowseClientMsg, type BrowseServerMsg } from './browse.js';
import { KANBAN_LIMITS, PERSON_ID_RE, bad, bool, deskId, isObj, optText, project, text, type Obj, type Req } from './validate.js';

/** One way to move an issue on: a Jira transition, a project's Status option, or GitHub's close / reopen. */
export interface IssueTransition {
  /** What `kanban.issue.transition` sends back: opaque to the browser (see TRANSITION_ID_RE). */
  id: string;
  /** What to call the choice ("In Review", "Close (not planned)"). */
  name: string;
  /** The status it leads to. */
  to: string;
  /** What the choice belongs to, for a grouped list: the GitHub project's title, or "GitHub". */
  group?: string;
  /** Fields the choice needs filled in first: the office can't, so it is listed disabled ("do it in Jira"). */
  needs?: string[];
  /** It is where the issue is now. */
  current?: boolean;
}

export interface IssueCommentItem {
  id: string;
  author: string;
  body: string;
  /** ISO time. */
  createdAt: string;
  url?: string;
}

export interface IssuePerson {
  /** What `kanban.issue.assign {to: {id}}` sends back: a Jira account id, or a GitHub login. */
  id: string;
  name: string;
  login?: string;
  avatar?: string;
}

/** Who an issue is assigned to: the asker (`me`), a person from the people list (`name` for the toast), or nobody (null). */
export type IssueAssignTo = { me: true } | { id: string; name?: string } | null;

/** `source`: the id of the issue source the issue was opened through (a browse scope, a listed issue's sourceId), so the action goes through that source's Jira connection. */
type IssueReq<T> = Req<{ project: string; issueKey: string; source?: string } & T>;

export type IssueOpsClientMsg =
  /** Answered with kanban.issues. */
  | Req<{ t: 'kanban.issues.list'; project: string }>
  | Req<{ t: 'kanban.issues.refresh'; project: string }>
  /** Idempotent by ticket: answered with kanban.ok {taskId, existed}. `deskId` (with start): where its worker sits (the 3D office's P with a card). */
  | Req<{ t: 'kanban.issues.createTask'; project: string; issueKey: string; start?: boolean; deskId?: string }>
  /** Where the issue can go from here; answered with kanban.issueTransitions. */
  | IssueReq<{ t: 'kanban.issue.transitions' }>
  /** Moves it (a transition id from kanban.issueTransitions); answered with kanban.ok. */
  | IssueReq<{ t: 'kanban.issue.transition'; transitionId: string }>
  /** Answered with kanban.issueComments (newest last). */
  | IssueReq<{ t: 'kanban.issue.comments' }>
  /** Adds a comment (signed with the office's name when it goes out under a shared identity); answered with kanban.ok. */
  | IssueReq<{ t: 'kanban.issue.comment'; text: string }>
  /** Who the issue can be assigned to, matching `query`; answered with kanban.issuePeople. */
  | IssueReq<{ t: 'kanban.issue.people'; query?: string }>
  /** Answered with kanban.ok. */
  | IssueReq<{ t: 'kanban.issue.assign'; to: IssueAssignTo }>
  /** Browsing all of a source's issues (browse.ts). */
  | BrowseClientMsg;

export type IssueOpsServerMsg =
  | { t: 'kanban.issues'; rid?: string; project: string; items: NormalizedIssue[]; error?: string; fetchedAt: number; loading: boolean }
  /** `cannot`: why the choices can't be listed (and so changed) for this issue. `note`: a problem that left some choices out (the project board couldn't be read). */
  | { t: 'kanban.issueTransitions'; rid?: string; project: string; issueKey: string; current?: string; transitions: IssueTransition[]; cannot?: string; note?: string }
  /** `cannot`: why there are no comments to show or add (a draft has none). */
  | { t: 'kanban.issueComments'; rid?: string; project: string; issueKey: string; items: IssueCommentItem[]; cannot?: string }
  /** `cannot`: why this issue can't be assigned from the office. */
  | { t: 'kanban.issuePeople'; rid?: string; project: string; issueKey: string; items: IssuePerson[]; cannot?: string }
  | BrowseServerMsg;

/** Every issue message the browser may send; protocol.ts spreads it into KANBAN_CLIENT_TYPE_LIST. */
export const ISSUE_OPS_CLIENT_TYPE_LIST: Readonly<Record<IssueOpsClientMsg['t'], true>> = {
  'kanban.issues.list': true,
  'kanban.issues.refresh': true,
  'kanban.issues.createTask': true,
  'kanban.issue.transitions': true,
  'kanban.issue.transition': true,
  'kanban.issue.comments': true,
  'kanban.issue.comment': true,
  'kanban.issue.people': true,
  'kanban.issue.assign': true,
  ...BROWSE_CLIENT_TYPE_LIST,
};

/** A transition id: Jira's number, `p:<projectId>:<itemId>:<fieldId>:<optionId>`, or `gh:close` / `gh:close:not_planned` / `gh:reopen`. */
export const TRANSITION_ID_RE = /^[\w:@.=-]{1,500}$/;
export { PERSON_ID_RE };
const PEOPLE_QUERY_MAX = 100;
/** An issue source's id (the settings' own rule). */
export const ISSUE_SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

type Bare<T> = T extends unknown ? Omit<T, 'rid'> : never;

const isBrowse = (t: string): t is BrowseClientMsg['t'] => t in BROWSE_CLIENT_TYPE_LIST;

function assignTo(v: unknown): IssueAssignTo {
  if (v === null) return null;
  if (!isObj(v)) return bad('to must be {me: true}, {id} or null');
  if (v.me === true) return { me: true };
  if (typeof v.id !== 'string' || !PERSON_ID_RE.test(v.id)) return bad('to.id must be a person id');
  const name = optText(v.name, 'to.name', 200)?.trim();
  return { id: v.id, ...(name ? { name } : {}) };
}

/** Checks the fields of an issue message (its type is already known to be in the list) and rebuilds it. */
export function parseIssueOpsMsg(t: IssueOpsClientMsg['t'], r: Obj): Bare<IssueOpsClientMsg> {
  if (isBrowse(t)) return parseBrowseMsg(t, r);
  const proj = project(r.project);
  switch (t) {
    case 'kanban.issues.list':
    case 'kanban.issues.refresh':
      return { t, project: proj };
    case 'kanban.issues.createTask': {
      const desk = deskId(r.deskId);
      return { t, project: proj, issueKey: text(r.issueKey, 'issueKey', KANBAN_LIMITS.issueKey).trim(), ...(bool(r.start, 'start') ? { start: true } : {}), ...(desk ? { deskId: desk } : {}) };
    }
  }
  const issueKey = text(r.issueKey, 'issueKey', KANBAN_LIMITS.issueKey).trim();
  if (r.source !== undefined && (typeof r.source !== 'string' || !ISSUE_SOURCE_ID_RE.test(r.source))) bad('source must be an issue source id');
  const via = typeof r.source === 'string' ? { source: r.source } : {};
  switch (t) {
    case 'kanban.issue.transitions':
    case 'kanban.issue.comments':
      return { t, project: proj, issueKey, ...via };
    case 'kanban.issue.transition': {
      if (typeof r.transitionId !== 'string' || !TRANSITION_ID_RE.test(r.transitionId)) bad('transitionId must be one of the issue’s transitions');
      return { t, project: proj, issueKey, ...via, transitionId: r.transitionId as string };
    }
    case 'kanban.issue.comment':
      return { t, project: proj, issueKey, ...via, text: text(r.text, 'The comment', KANBAN_LIMITS.comment) };
    case 'kanban.issue.people': {
      const query = optText(r.query, 'The search', PEOPLE_QUERY_MAX)?.trim();
      return { t, project: proj, issueKey, ...via, ...(query ? { query } : {}) };
    }
    case 'kanban.issue.assign':
      return { t, project: proj, issueKey, ...via, to: assignTo(r.to) };
  }
}

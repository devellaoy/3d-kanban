// The messages about pull requests (docs/kanban-architecture.md §6): reviewing several together,
// the bundle that belongs together, who owns one, and finding / linking / unlinking a task's own.
// The parsers use validate.ts; protocol.ts joins these into the kanban's unions and calls
// parsePrMsg for any type in PR_CLIENT_TYPE_LIST. (`kanban.task.pr` stays in protocol.ts.)

import type { KanbanEffort, KanbanPrBundleItem, KanbanPrBundleKey, KanbanTool, PrRef } from './types.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, PR_REVIEW_MAX } from './types.js';
import { KANBAN_LIMITS, PROJECT_ID_RE, bad, bool, id, isObj, isRepoName, list, model, oneOf, optOneOf, project, text, type Obj, type Req } from './validate.js';
import { PR_ANSWER_TEXT_MAX, PR_COMMENTS_MAX, PR_COMMENT_DECISIONS, PR_COMMENT_ID_MAX, type PrCommentAnswer } from './prcomments.js';

/** How many pull requests one kanban.pr.link takes (the review's limit too). */
export const PR_LINK_MAX = PR_REVIEW_MAX;

export type PrClientMsg =
  /**
   * A review of several pull requests together: answered with kanban.ok {taskId, workerId} (the
   * review's task and its reviewer). `post` posts the finished review on the PRs; `uiTest` also has
   * an implementer test their UI.
   */
  | Req<{ t: 'kanban.pr.review'; project: string; prs: PrRef[]; taskId?: number; tool?: KanbanTool; model?: string; effort?: KanbanEffort; post?: boolean; uiTest?: boolean }>
  /** The meeting form's preset for a review panel of several PRs (the prompt, the title and the PR of the project's own repository); answered with kanban.pr.brief. Starts nothing. */
  | Req<{ t: 'kanban.pr.brief'; project: string; prs: PrRef[]; taskId?: number }>
  /** The pull requests that belong together (open and draft ones; merged and closed too with includeClosed); answered with kanban.pr.bundle. */
  | Req<{ t: 'kanban.pr.bundle'; project: string; includeClosed?: boolean } & KanbanPrBundleKey>
  /** The task that owns a pull request, and whether its agent can fix it now: kanban.pr.owner. */
  | Req<{ t: 'kanban.pr.owner'; project: string; repo: string; number: number }>
  /** Looks for the task's pull requests by its branches (linked at once) and ticket (only offered); answered with kanban.prFound. */
  | Req<{ t: 'kanban.pr.find'; project: string; taskId: number }>
  /** Links pull requests to the task by hand; answered with kanban.ok. */
  | Req<{ t: 'kanban.pr.link'; project: string; taskId: number; prs: PrRef[] }>
  /** Takes a pull request off the task, named by its link's `repoId` (older links have no `repo`) or its `repo`, one of them at least; answered with kanban.ok. */
  | Req<{ t: 'kanban.pr.unlink'; project: string; taskId: number; number: number; repoId?: string; repo?: string }>
  /** Sends the task's agent to fetch and analyse its open pull requests' unresolved comments (a pr-comments run); answered with kanban.ok, or kanban.error with why not. The list is GET /api/kanban/tasks/<id>/pr-comments. */
  | Req<{ t: 'kanban.pr.comments.fetch'; taskId: number }>
  /** Sends the user's decision on every comment of the list fetched at `fetchedAt` to the task's agent (a pr-answers run); answered with kanban.ok, or kanban.error with why not (a newer list, an unknown id, a missing decision). */
  | Req<{ t: 'kanban.pr.comments.send'; taskId: number; fetchedAt: number; answers: PrCommentAnswer[] }>;

export type PrServerMsg =
  | { t: 'kanban.pr.bundle'; rid?: string; project: string; key: KanbanPrBundleKey; prs: KanbanPrBundleItem[]; error?: string }
  /** The answer to kanban.pr.brief: the meeting form's prompt and title, and `pr`, the number of the project's own repository's PR the panel posts on. */
  | { t: 'kanban.pr.brief'; rid?: string; prompt: string; title: string; pr: number }
  | { t: 'kanban.pr.owner'; rid?: string; taskId: number | null; title?: string; fixable: boolean; reason?: string }
  /** `linked`: what the search linked just now (branch matches); `candidates`: ticket matches, linked only when the user confirms; `skipped`: found but not taken, with why; `notes`: repositories that couldn't be searched. */
  | { t: 'kanban.prFound'; rid?: string; taskId: number; linked: PrRef[]; candidates: KanbanPrBundleItem[]; skipped: { repo: string; number: number; reason: string }[]; notes: string[] };

/** Every pull request message the browser may send; protocol.ts spreads it into KANBAN_CLIENT_TYPE_LIST. */
export const PR_CLIENT_TYPE_LIST: Readonly<Record<PrClientMsg['t'], true>> = {
  'kanban.pr.review': true,
  'kanban.pr.bundle': true,
  'kanban.pr.brief': true,
  'kanban.pr.owner': true,
  'kanban.pr.find': true,
  'kanban.pr.link': true,
  'kanban.pr.unlink': true,
  'kanban.pr.comments.fetch': true,
  'kanban.pr.comments.send': true,
};

export function prRef(x: unknown): PrRef {
  if (!isObj(x)) bad('prs must be pull requests: {repo, number}');
  const p = x as Obj;
  if (typeof p.repo !== 'string' || !isRepoName(p.repo)) bad('A pull request needs its repository: owner/name on GitHub, azure:org/project/repo or bitbucket:workspace/repo');
  if (!Number.isSafeInteger(p.number) || (p.number as number) <= 0) bad('A pull request needs its number');
  return { repo: p.repo as string, number: p.number as number };
}
function prRefs(v: unknown): PrRef[] {
  const seen = new Set<string>();
  const prs = list(v, 'prs', PR_LINK_MAX, prRef).filter((p) => {
    const key = `${p.repo.toLowerCase()}#${p.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!prs.length) bad('Pick at least one pull request');
  return prs;
}
function commentAnswer(x: unknown): PrCommentAnswer {
  if (!isObj(x)) bad('answers must be decisions: {id, decision, text?}');
  const a = x as Obj;
  const text0 = a.text === undefined ? undefined : text(a.text, 'The text', PR_ANSWER_TEXT_MAX, { empty: true });
  return { id: text(a.id, 'The comment id', PR_COMMENT_ID_MAX), decision: oneOf(a.decision, 'decision', PR_COMMENT_DECISIONS), ...(text0?.trim() ? { text: text0 } : {}) };
}
function bundleKey(r: Obj): KanbanPrBundleKey {
  const keys = ['taskId', 'branch', 'ticket'].filter((k) => r[k] !== undefined);
  if (keys.length !== 1) bad('Give exactly one of taskId, branch or ticket');
  if (r.taskId !== undefined) return { taskId: id(r.taskId, 'taskId') };
  if (r.branch !== undefined) return { branch: text(r.branch, 'The branch', KANBAN_LIMITS.branch).trim() };
  return { ticket: text(r.ticket, 'The ticket', KANBAN_LIMITS.ticket).trim() };
}

type Bare<T> = T extends unknown ? Omit<T, 'rid'> : never;

/** Checks the fields of a pull request message (its type is already known to be in the list) and rebuilds it. */
export function parsePrMsg(t: PrClientMsg['t'], r: Obj): Bare<PrClientMsg> {
  switch (t) {
    case 'kanban.pr.review': {
      const taskId = r.taskId === undefined ? undefined : id(r.taskId, 'taskId');
      const tool = optOneOf(r.tool, 'tool', KANBAN_TOOLS);
      const mdl = model(r.model);
      const effort = optOneOf(r.effort, 'effort', KANBAN_EFFORTS);
      return {
        t,
        project: project(r.project),
        prs: prRefs(r.prs),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(tool ? { tool } : {}),
        ...(mdl ? { model: mdl } : {}),
        ...(effort ? { effort } : {}),
        ...(bool(r.post, 'post') ? { post: true } : {}),
        ...(bool(r.uiTest, 'uiTest') ? { uiTest: true } : {}),
      };
    }
    case 'kanban.pr.brief': {
      const taskId = r.taskId === undefined ? undefined : id(r.taskId, 'taskId');
      return { t, project: project(r.project), prs: prRefs(r.prs), ...(taskId !== undefined ? { taskId } : {}) };
    }
    case 'kanban.pr.bundle':
      return { t, project: project(r.project), ...bundleKey(r), ...(bool(r.includeClosed, 'includeClosed') ? { includeClosed: true } : {}) };
    case 'kanban.pr.owner':
      return { t, project: project(r.project), ...prRef(r) };
    case 'kanban.pr.find':
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId') };
    case 'kanban.pr.link':
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId'), prs: prRefs(r.prs) };
    case 'kanban.pr.comments.fetch':
      return { t, taskId: id(r.taskId, 'taskId') };
    case 'kanban.pr.comments.send': {
      if (!Number.isSafeInteger(r.fetchedAt) || (r.fetchedAt as number) <= 0) bad('fetchedAt must be the time of the list the decisions are for');
      const answers = list(r.answers, 'answers', PR_COMMENTS_MAX, commentAnswer);
      if (new Set(answers.map((a) => a.id)).size !== answers.length) bad('Each comment can be decided once');
      return { t, taskId: id(r.taskId, 'taskId'), fetchedAt: r.fetchedAt as number, answers };
    }
    case 'kanban.pr.unlink': {
      if (r.repoId === undefined && r.repo === undefined) bad('Name the pull request’s repository: repoId or repo');
      if (r.repoId !== undefined && (typeof r.repoId !== 'string' || !PROJECT_ID_RE.test(r.repoId))) bad('repoId must be a repository id');
      const number = prRef({ repo: 'a/b', number: r.number }).number;
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId'), number, ...(r.repoId !== undefined ? { repoId: r.repoId as string } : {}), ...(r.repo !== undefined ? { repo: prRef({ repo: r.repo, number }).repo } : {}) };
    }
  }
}

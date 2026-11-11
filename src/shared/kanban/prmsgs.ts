// The messages about pull requests (docs/kanban-architecture.md §6): reviewing several together,
// the bundle that belongs together, who owns one, and finding / linking / unlinking a task's own.
// The parsers use validate.ts; protocol.ts joins these into the kanban's unions and calls
// parsePrMsg for any type in PR_CLIENT_TYPE_LIST. (`kanban.task.pr` stays in protocol.ts.)

import type { KanbanEffort, KanbanPrBundleItem, KanbanPrBundleKey, KanbanTool, PrRef } from './types.js';
import { KANBAN_EFFORTS, KANBAN_TOOLS, PR_REVIEW_MAX } from './types.js';
import { KANBAN_LIMITS, bad, bool, id, isObj, isRepoName, list, model, optOneOf, project, text, type Obj, type Req } from './validate.js';

export type PrClientMsg =
  /**
   * A review of several pull requests together: answered with kanban.ok {taskId, workerId} (the
   * review's task and its reviewer). With `panel`, the floor's meeting room reviews them instead,
   * answered with kanban.ok {} (and taskId when one was given).
   */
  | Req<{ t: 'kanban.pr.review'; project: string; prs: PrRef[]; taskId?: number; tool?: KanbanTool; model?: string; effort?: KanbanEffort; panel?: boolean }>
  /** The pull requests that belong together (open and draft ones; merged and closed too with includeClosed); answered with kanban.pr.bundle. */
  | Req<{ t: 'kanban.pr.bundle'; project: string; includeClosed?: boolean } & KanbanPrBundleKey>
  /** The task that owns a pull request, and whether its agent can fix it now: kanban.pr.owner. */
  | Req<{ t: 'kanban.pr.owner'; project: string; repo: string; number: number }>
  /** Looks for the task's pull requests by its branches (linked at once) and ticket (only offered); answered with kanban.prFound. */
  | Req<{ t: 'kanban.pr.find'; project: string; taskId: number }>
  /** Links pull requests to the task by hand; answered with kanban.ok. */
  | Req<{ t: 'kanban.pr.link'; project: string; taskId: number; prs: PrRef[] }>
  /** Takes a pull request off the task; answered with kanban.ok. */
  | Req<{ t: 'kanban.pr.unlink'; project: string; taskId: number; repo: string; number: number }>;

export type PrServerMsg =
  | { t: 'kanban.pr.bundle'; rid?: string; project: string; key: KanbanPrBundleKey; prs: KanbanPrBundleItem[]; error?: string }
  | { t: 'kanban.pr.owner'; rid?: string; taskId: number | null; title?: string; fixable: boolean; reason?: string }
  /** `linked`: what the search linked just now (branch matches); `candidates`: ticket matches, linked only when the user confirms; `skipped`: found but not taken, with why; `notes`: repositories that couldn't be searched. */
  | { t: 'kanban.prFound'; rid?: string; taskId: number; linked: PrRef[]; candidates: KanbanPrBundleItem[]; skipped: { repo: string; number: number; reason: string }[]; notes: string[] };

/** Every pull request message the browser may send; protocol.ts spreads it into KANBAN_CLIENT_TYPE_LIST. */
export const PR_CLIENT_TYPE_LIST: Readonly<Record<PrClientMsg['t'], true>> = {
  'kanban.pr.review': true,
  'kanban.pr.bundle': true,
  'kanban.pr.owner': true,
  'kanban.pr.find': true,
  'kanban.pr.link': true,
  'kanban.pr.unlink': true,
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
  const prs = list(v, 'prs', PR_REVIEW_MAX, prRef).filter((p) => {
    const key = `${p.repo.toLowerCase()}#${p.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!prs.length) bad('Pick at least one pull request');
  return prs;
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
        ...(bool(r.panel, 'panel') ? { panel: true } : {}),
      };
    }
    case 'kanban.pr.bundle':
      return { t, project: project(r.project), ...bundleKey(r), ...(bool(r.includeClosed, 'includeClosed') ? { includeClosed: true } : {}) };
    case 'kanban.pr.owner':
      return { t, project: project(r.project), ...prRef(r) };
    case 'kanban.pr.find':
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId') };
    case 'kanban.pr.link':
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId'), prs: prRefs(r.prs) };
    case 'kanban.pr.unlink':
      return { t, project: project(r.project), taskId: id(r.taskId, 'taskId'), ...prRef(r) };
  }
}

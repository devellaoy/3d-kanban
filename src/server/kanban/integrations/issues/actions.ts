// The WS handlers for the actions on one issue of an issue source: its status, comments and
// assignee (kanban.issue.*). They go by the issue's key, not by the source that listed it: the list
// keeps one source's copy of a key that two sources both list, so the key decides where an action goes
//   - a Jira key: Jira (the site of the project's Jira source);
//   - `ab:org/project#N`: Azure Boards, as the person (azure-ops.ts);
//   - `ghp:…` (a draft on a board): the board's Status;
//   - `gh:owner/repo#N`: GitHub for comments and assignees, and for its Status the boards of the
//     project that hold it, then GitHub's own close / reopen.
// Only the project's own issues are accepted: the cached list, one acted on or browsed lately, or one loaded fresh from a source of the project. A write says who made it: a toast on the
// floor and, when the issue has a task, a status line on it.

import type { KanbanClientMsg, KanbanClientType } from '../../../../shared/kanban/protocol.js';
import type { IssueAssignTo, IssueTransition } from '../../../../shared/kanban/issueops.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { cleanJiraSite, sameJiraSite, type JiraAt } from '../../../../shared/kanban/jira-connections.js';
import { parseGhKey } from '../../../../shared/kanban/issuecard.js';
import { parseAbKey, type WorkItemRef } from '../../../../shared/hosting/workitems.js';
import type { KanbanCaller, KanbanClient, KanbanContext, KanbanPlugin } from '../../registry.js';
import { jiraCovers } from './browse/jql.js';
import { fail, ok } from '../util.js';
import { GH_REOPEN, ghAssign, ghComment, ghComments, ghIssueState, ghPeople, ghStateTransition, ghStateTransitions } from './github-ops.js';
import { azureActAs, azureAssign, azureComment, azureComments, azurePeople, azureTransition, azureTransitions } from './azure-ops.js';
import { jiraAssign, jiraComment, jiraComments, jiraPeople, jiraTransition, jiraTransitions } from './jira-ops.js';
import { boardTransitions, projectTransition, resolveBoards, type ProjectTarget } from './project-ops.js';
import type { IssueActIo, IssueSourceIo } from './source.js';

type ProjectConfig = Extract<IssueSourceConfig, { kind: 'github-project' }>;
type Msg<T extends KanbanClientType> = Extract<KanbanClientMsg, { t: T }>;

/** What a write changes on the cached issue, until a fetch shows it. `assignee: null` clears it. */
export interface IssuePatch {
  status?: string;
  assignee?: string | null;
}

export interface ActionDeps {
  /** The issue on the project's list (with any pending change applied), else one acted on or browsed a little while ago. */
  find(project: string, key: string): NormalizedIssue | undefined;
  /** The issue fetched fresh from its source (`source`: the one the asker opened it through, when it names one), when `find` has lost it: only one inside the project's own scope (its Jira project keys, its repositories, its boards). */
  load(project: string, key: string, source?: string): Promise<NormalizedIssue | undefined>;
  /** Shows a change at once on the kanban and the 3D board, until a later fetch has it. */
  patch(project: string, key: string, fields: IssuePatch): void;
  io(project: string): IssueSourceIo;
  /** Keeps the issue as it was acted on, so its window can go on (Reopen) after the list has lost it. */
  remember(project: string, issue: NormalizedIssue): void;
}

/** Where an issue's actions go. */
type Target = ({ kind: 'jira' } & JiraAt) | ({ kind: 'azure' } & WorkItemRef) | { kind: 'draft'; itemId: string } | { kind: 'gh'; repo: string; number: number; isPr: boolean; closed: boolean };

export const DRAFT_NO_COMMENTS = 'Draft issues have no comments';
export const DRAFT_NO_ASSIGNEE = 'Convert the draft to an issue on GitHub to assign it';

/** The Jira site an issue's URL (https://<site>/browse/KEY) is on, if it has one. */
const issueSite = (url: string): string | undefined => {
  try {
    return cleanJiraSite(new URL(url).host);
  } catch {
    return undefined;
  }
};

/**
 * `via`: the source the asker opened the issue through. For a Jira issue it must be a Jira source on the issue's own site that covers the
 * key; one that isn't among the project's sources (any more) is as good as none, one that exists but doesn't fit is refused.
 */
export function route(sources: IssueSourceConfig[], issue: NormalizedIssue, via?: string): Target | string {
  if (issue.source === 'jira') {
    let jiras = sources.filter((s): s is Extract<IssueSourceConfig, { kind: 'jira' }> => s.kind === 'jira');
    // An issue is acted on at the site it came from: never through a source on another one.
    const site = issueSite(issue.url);
    if (site) {
      jiras = jiras.filter((s) => sameJiraSite(s.site, site));
      if (!jiras.length) return `${issue.key}'s Jira source (on ${site}) is no longer one of the project's: re-add it to act on the issue`;
    }
    const chosen = via === undefined ? undefined : jiras.find((s) => s.id === via);
    if (via !== undefined && !chosen && sources.some((s) => s.id === via)) return `${via} isn't a Jira source for ${issue.key}${site ? ` on ${site}` : ''}`;
    if (chosen && !jiraCovers(chosen, issue.key)) return `${via} doesn't cover ${issue.key}`;
    // The source the asker came through, else the one that listed it, else the one whose projects hold the key, else the first.
    const jira = chosen ?? jiras.find((s) => s.id === issue.sourceId) ?? jiras.find((s) => s.projectKeys.length && jiraCovers(s, issue.key)) ?? jiras[0];
    return jira ? { kind: 'jira', site: jira.site, ...(jira.connection ? { connection: jira.connection } : {}) } : 'The project has no Jira source';
  }
  const ab = parseAbKey(issue.key);
  if (ab) return { kind: 'azure', ...ab };
  const draft = /^ghp:[^#]+#(.+)$/.exec(issue.key);
  if (draft) return { kind: 'draft', itemId: draft[1] };
  const gh = parseGhKey(issue.key);
  if (gh) {
    // A repository source lists closed issues when asked to; a board's items are open ones.
    const closed = issue.source === 'github-repo' && !!issue.status && issue.status.toUpperCase() !== 'OPEN';
    return { kind: 'gh', ...gh, isPr: /\/pull\/\d+/.test(issue.url), closed };
  }
  return `${issue.key} isn't an issue the office can act on`;
}

/** The identity GitHub runs under for a person, as taking a card does: their own sign-in, else the office's gh (`shared`) for who has none to give; the reason when they can't have one. */
export function ghIoFor(ctx: KanbanContext, base: IssueSourceIo, caller: KanbanCaller): IssueActIo | string {
  const as = ctx.ghAs?.(caller.accountId);
  if (typeof as === 'string') return as;
  return statusIoFor(base, caller.name, as?.env);
}

/** The io a Status move runs under: the person's own gh (`env`), else the office's, which is theirs on the shared password (`shared`). */
export function statusIoFor(base: IssueSourceIo, who: string, env?: Record<string, string>): IssueActIo {
  return { ...base, ...(env ? { env } : {}), who, shared: !env };
}

/** A write went through: show it (the cached issue, the floor toast) and say who did it on the issue's task. */
export function announce(ctx: KanbanContext, patchIssue: ActionDeps['patch'], project: string, issueKey: string, emoji: string, line: string, patch?: IssuePatch): void {
  if (patch) patchIssue(project, issueKey, patch);
  ctx.toast(project, `${emoji} ${line}`, 'info');
  const task = ctx.repo.findTaskByTicket(project, issueKey);
  if (task) {
    ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: line });
    ctx.taskChanged(task.id);
  }
}

const projectTarget = (t: Extract<Target, { kind: 'draft' | 'gh' }>): ProjectTarget => (t.kind === 'draft' ? { itemId: t.itemId } : { repo: t.repo, number: t.number });

export function issueActionHandlers(ctx: KanbanContext, deps: ActionDeps): NonNullable<KanbanPlugin['ws']> {
  interface Scope {
    issue: NormalizedIssue;
    target: Target;
    io: IssueActIo;
    boards: ProjectConfig[];
  }

  /** Checks the project and the issue, routes the key and picks the identity, then runs `go`; any error it throws is the answer. */
  const scoped =
    <M extends { project: string; issueKey: string; source?: string; rid?: string }>(go: (c: KanbanClient, m: M, s: Scope) => Promise<void>, write = false) =>
    async (c: KanbanClient, m: M): Promise<void> => {
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      const issue = deps.find(m.project, m.issueKey) ?? (await deps.load(m.project, m.issueKey, m.source));
      if (!issue) return fail(c, m.rid, `${m.issueKey} isn't among the project's issues (any more)`);
      const sources = ctx.settings.project(m.project).issueSources;
      const target = route(sources, issue, m.source);
      if (typeof target === 'string') return fail(c, m.rid, target);
      const base = deps.io(m.project);
      let io: IssueActIo;
      if (target.kind === 'jira' || target.kind === 'azure') io = { ...base, who: c.name, shared: true };
      else {
        // GitHub runs as the person. A write without a sign-in of theirs says why not; a read goes by the office's gh.
        const own = ghIoFor(ctx, base, c);
        if (typeof own === 'string' && write) return fail(c, m.rid, own);
        io = typeof own === 'string' ? { ...base, who: c.name, shared: true } : own;
      }
      try {
        await go(c, m, { issue, target, io, boards: sources.filter((s): s is ProjectConfig => s.kind === 'github-project') });
      } catch (err) {
        fail(c, m.rid, (err as Error)?.message ?? String(err));
      }
    };

  /** A write went through: show it, say who did it (floor toast, the issue's task), and answer. */
  const wrote = (c: KanbanClient, m: { project: string; issueKey: string; rid?: string }, issue: NormalizedIssue, emoji: string, line: string, patch?: IssuePatch) => {
    deps.remember(m.project, issue);
    announce(ctx, deps.patch, m.project, m.issueKey, emoji, line, patch);
    ok(c, m.rid);
  };

  return {
    'kanban.issue.transitions': scoped<Msg<'kanban.issue.transitions'>>(async (c, m, { issue, target, io, boards }) => {
      const reply = (transitions: IssueTransition[], extra: { current?: string; cannot?: string; note?: string } = {}) =>
        c.send({ t: 'kanban.issueTransitions', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, transitions, ...extra });
      if (target.kind === 'jira') return reply(await jiraTransitions(io, target, m.issueKey), issue.status ? { current: issue.status } : {});
      if (target.kind === 'azure') {
        const got = await azureTransitions(io, azureActAs(c.accountId, target.org), target);
        return reply(got.transitions, got.current || issue.status ? { current: got.current || issue.status } : {});
      }
      // The boards of the project that hold the item; a board that can't be read leaves its choices out, and says so.
      let found: Awaited<ReturnType<typeof resolveBoards>> = [];
      let note: string | undefined;
      // Open or closed is GitHub's word now, whichever source's copy the list kept (a board's copy has no state of its own).
      const live = target.kind === 'gh' && !target.isPr ? ghIssueState(io, target.repo, target.number) : Promise.resolve(undefined);
      try {
        found = await resolveBoards(io, projectTarget(target), boards);
      } catch (err) {
        note = (err as Error).message;
      }
      const liveState = await live;
      const state = target.kind === 'gh' ? ghStateTransitions(liveState ? liveState === 'CLOSED' : target.closed, target.isPr) : [];
      const transitions = [...boardTransitions(found), ...state];
      const current = found.find((b) => b.current)?.current ?? issue.status;
      if (!transitions.length) {
        const why = note ?? (target.kind === 'draft' ? 'This draft isn’t on one of the project’s GitHub boards (or its board has no Status field)' : 'Its status can’t be changed from here: it is on none of the project’s GitHub boards, and a pull request is closed in its own window');
        return reply([], { ...(current ? { current } : {}), cannot: why });
      }
      reply(transitions, { ...(current ? { current } : {}), ...(note ? { note } : {}) });
    }),

    'kanban.issue.transition': scoped<Msg<'kanban.issue.transition'>>(async (c, m, { issue, target, io, boards }) => {
      let to: string;
      let status: string | undefined;
      let dropped = false;
      if (target.kind === 'jira') status = to = await jiraTransition(io, target, m.issueKey, m.transitionId);
      else if (target.kind === 'azure') status = to = await azureTransition(io, azureActAs(c.accountId, target.org), target, m.transitionId);
      else if (m.transitionId.startsWith('gh:')) {
        if (target.kind !== 'gh') throw new Error('A draft can’t be closed: move it on its board, or convert it to an issue');
        to = await ghStateTransition(io, target.repo, target.number, m.transitionId, target.isPr);
        if (m.transitionId !== GH_REOPEN) {
          // Nobody should be seated for an issue that's closed (as upstream's gh.close). The queue's numbers are the floor's primary repository's.
          const floor = ctx.floor(m.project);
          const primary = !!floor?.def.repo && floor.def.repo.toLowerCase() === target.repo.toLowerCase();
          dropped = !!floor?.queue.dropIssue(primary ? target.number : undefined, m.issueKey);
        }
        // A repository's list shows its issues' state; a board's Status is not changed by closing.
        if (issue.source === 'github-repo') status = to.startsWith('Closed') ? 'CLOSED' : 'OPEN';
      } else {
        const moved = await projectTransition(io, projectTarget(target), boards, m.transitionId);
        to = moved.to;
        // A board's Status is the status of the copy that board listed; a repository's copy has the issue's open / closed state, another board's copy its own Status.
        const listedBy = boards.find((b) => b.id === issue.sourceId);
        if (issue.source === 'github-project' && listedBy && listedBy.owner.toLowerCase() === moved.owner.toLowerCase() && listedBy.number === moved.number) status = to;
      }
      wrote(c, m, issue, '🔀', `${c.name} moved ${m.issueKey} → ${to}${dropped ? ' and took it off the queue' : ''}`, status ? { status } : {});
    }, true),

    'kanban.issue.comments': scoped<Msg<'kanban.issue.comments'>>(async (c, m, { target, io }) => {
      const items =
        target.kind === 'jira' ? await jiraComments(io, target, m.issueKey) : target.kind === 'azure' ? await azureComments(io, azureActAs(c.accountId, target.org), target) : target.kind === 'gh' ? await ghComments(io, target.repo, target.number) : [];
      c.send({ t: 'kanban.issueComments', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, items, ...(target.kind === 'draft' ? { cannot: DRAFT_NO_COMMENTS } : {}) });
    }),

    'kanban.issue.comment': scoped<Msg<'kanban.issue.comment'>>(async (c, m, { issue, target, io }) => {
      if (target.kind === 'draft') throw new Error(DRAFT_NO_COMMENTS);
      if (target.kind === 'jira') await jiraComment(io, target, m.issueKey, m.text);
      else if (target.kind === 'azure') {
        const as = azureActAs(c.accountId, target.org);
        await azureComment(io, as, target, m.text, as.key === 'office' ? c.name : undefined);
      }
      else await ghComment(io, target.repo, target.number, m.text);
      wrote(c, m, issue, '💬', `${c.name} commented on ${m.issueKey}`);
    }, true),

    'kanban.issue.people': scoped<Msg<'kanban.issue.people'>>(async (c, m, { target, io }) => {
      const items =
        target.kind === 'jira' ? await jiraPeople(io, target, m.issueKey, m.query) : target.kind === 'azure' ? await azurePeople(io, azureActAs(c.accountId, target.org), target, m.query) : target.kind === 'gh' ? await ghPeople(io, target.repo, m.query) : [];
      c.send({ t: 'kanban.issuePeople', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, items, ...(target.kind === 'draft' ? { cannot: DRAFT_NO_ASSIGNEE } : {}) });
    }),

    'kanban.issue.assign': scoped<Msg<'kanban.issue.assign'>>(async (c, m, { issue, target, io }) => {
      if (target.kind === 'draft') throw new Error(DRAFT_NO_ASSIGNEE);
      const to: IssueAssignTo = m.to;
      const who =
        target.kind === 'jira' ? await jiraAssign(io, target, m.issueKey, to) : target.kind === 'azure' ? await azureAssign(io, azureActAs(c.accountId, target.org), target, to) : await ghAssign(io, target.repo, target.number, to);
      wrote(c, m, issue, '👤', who ? `${c.name} assigned ${m.issueKey} to ${who}` : `${c.name} unassigned ${m.issueKey}`, { assignee: who ?? null });
    }, true),
  };
}

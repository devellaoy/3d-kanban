// The WS handlers for the actions on one issue of an issue source: its status, comments and
// assignee (kanban.issue.*). They go by the issue's key, not by the source that listed it: the list
// keeps one source's copy of a key that two sources both list, so the key decides where an action goes
//   - a Jira key: Jira (the site of the project's Jira source);
//   - `ghp:…` (a draft on a board): the board's Status;
//   - `gh:owner/repo#N`: GitHub for comments and assignees, and for its Status the boards of the
//     project that hold it, then GitHub's own close / reopen.
// Only issues on the project's cached list are accepted. A write says who made it: a toast on the
// floor and, when the issue has a task, a status line on it.

import type { KanbanClientMsg, KanbanClientType } from '../../../../shared/kanban/protocol.js';
import type { IssueAssignTo, IssueTransition } from '../../../../shared/kanban/issueops.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { parseGhKey } from '../../../../shared/kanban/issuecard.js';
import type { KanbanClient, KanbanContext, KanbanPlugin } from '../../registry.js';
import { fail, ok } from '../util.js';
import { GH_REOPEN, ghAssign, ghComment, ghComments, ghIssueState, ghPeople, ghStateTransition, ghStateTransitions } from './github-ops.js';
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
  /** The issue on the project's list (with any pending change applied), else one acted on a little while ago. */
  find(project: string, key: string): NormalizedIssue | undefined;
  /** Shows a change at once on the kanban and the 3D board, until a later fetch has it. */
  patch(project: string, key: string, fields: IssuePatch): void;
  io(project: string): IssueSourceIo;
  /** Keeps the issue as it was acted on, so its window can go on (Reopen) after the list has lost it. */
  remember(project: string, issue: NormalizedIssue): void;
}

/** Where an issue's actions go. */
export type Target = { kind: 'jira'; site: string } | { kind: 'draft'; itemId: string } | { kind: 'gh'; repo: string; number: number; isPr: boolean; closed: boolean };

export const DRAFT_NO_COMMENTS = 'Draft issues have no comments';
export const DRAFT_NO_ASSIGNEE = 'Convert the draft to an issue on GitHub to assign it';

export function route(sources: IssueSourceConfig[], issue: NormalizedIssue): Target | string {
  if (issue.source === 'jira') {
    const jira = sources.find((s) => s.kind === 'jira' && s.id === issue.sourceId) ?? sources.find((s) => s.kind === 'jira');
    return jira && jira.kind === 'jira' ? { kind: 'jira', site: jira.site } : 'The project has no Jira source';
  }
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
    <M extends { project: string; issueKey: string; rid?: string }>(go: (c: KanbanClient, m: M, s: Scope) => Promise<void>, write = false) =>
    async (c: KanbanClient, m: M): Promise<void> => {
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      const issue = deps.find(m.project, m.issueKey);
      if (!issue) return fail(c, m.rid, `${m.issueKey} isn't among the project's issues (any more)`);
      const sources = ctx.settings.project(m.project).issueSources;
      const target = route(sources, issue);
      if (typeof target === 'string') return fail(c, m.rid, target);
      const base = deps.io(m.project);
      let io: IssueActIo;
      if (target.kind === 'jira') io = { ...base, who: c.name, shared: true };
      else {
        // GitHub runs as the person, as taking a card does. A write without a sign-in of theirs says why not; a read goes by the office's gh.
        const as = ctx.ghAs?.(c.accountId);
        if (typeof as === 'string' && write) return fail(c, m.rid, as);
        const env = typeof as === 'string' ? undefined : as?.env;
        io = { ...base, ...(env ? { env } : {}), who: c.name, shared: !env };
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
    if (patch) deps.patch(m.project, m.issueKey, patch);
    ctx.toast(m.project, `${emoji} ${line}`, 'info');
    const task = ctx.repo.findTaskByTicket(m.project, m.issueKey);
    if (task) {
      ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: line });
      ctx.taskChanged(task.id);
    }
    ok(c, m.rid);
  };

  return {
    'kanban.issue.transitions': scoped<Msg<'kanban.issue.transitions'>>(async (c, m, { issue, target, io, boards }) => {
      const reply = (transitions: IssueTransition[], extra: { current?: string; cannot?: string; note?: string } = {}) =>
        c.send({ t: 'kanban.issueTransitions', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, transitions, ...extra });
      if (target.kind === 'jira') return reply(await jiraTransitions(io, target.site, m.issueKey), issue.status ? { current: issue.status } : {});
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
      if (target.kind === 'jira') status = to = await jiraTransition(io, target.site, m.issueKey, m.transitionId);
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
      const items = target.kind === 'jira' ? await jiraComments(io, target.site, m.issueKey) : target.kind === 'gh' ? await ghComments(io, target.repo, target.number) : [];
      c.send({ t: 'kanban.issueComments', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, items, ...(target.kind === 'draft' ? { cannot: DRAFT_NO_COMMENTS } : {}) });
    }),

    'kanban.issue.comment': scoped<Msg<'kanban.issue.comment'>>(async (c, m, { issue, target, io }) => {
      if (target.kind === 'draft') throw new Error(DRAFT_NO_COMMENTS);
      if (target.kind === 'jira') await jiraComment(io, target.site, m.issueKey, m.text);
      else await ghComment(io, target.repo, target.number, m.text);
      wrote(c, m, issue, '💬', `${c.name} commented on ${m.issueKey}`);
    }, true),

    'kanban.issue.people': scoped<Msg<'kanban.issue.people'>>(async (c, m, { target, io }) => {
      const items = target.kind === 'jira' ? await jiraPeople(io, target.site, m.issueKey, m.query) : target.kind === 'gh' ? await ghPeople(io, target.repo, m.query) : [];
      c.send({ t: 'kanban.issuePeople', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: m.issueKey, items, ...(target.kind === 'draft' ? { cannot: DRAFT_NO_ASSIGNEE } : {}) });
    }),

    'kanban.issue.assign': scoped<Msg<'kanban.issue.assign'>>(async (c, m, { issue, target, io }) => {
      if (target.kind === 'draft') throw new Error(DRAFT_NO_ASSIGNEE);
      const to: IssueAssignTo = m.to;
      const who = target.kind === 'jira' ? await jiraAssign(io, target.site, m.issueKey, to) : await ghAssign(io, target.repo, target.number, to);
      wrote(c, m, issue, '👤', who ? `${c.name} assigned ${m.issueKey} to ${who}` : `${c.name} unassigned ${m.issueKey}`, { assignee: who ?? null });
    }, true),
  };
}

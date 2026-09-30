// A project's issues from its issue sources (ProjectSettings.issueSources: GitHub repositories,
// a GitHub Projects v2 board, Jira), cached per project and refreshed in the background at
// upstream's pace: every 90 s while someone has looked at them lately, every 10 minutes otherwise.
// kanban.issues.createTask turns one into a task, once per ticket.

import type { KanbanContext, KanbanPlugin } from '../../registry.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import type { KanbanServerMsg } from '../../../../shared/kanban/protocol.js';
import { gh } from '../../../github.js';
import { createIntegrationTask, fail, ok } from '../util.js';
import { githubRepoSource } from './github-repo.js';
import { githubProjectSource } from './github-project.js';
import { jiraSource } from './jira.js';
import type { IssueSource, IssueSourceIo } from './source.js';
import { setWallProvider, toGhIssue, wallChanged } from './wall.js';

export const ISSUE_SOURCES: Record<IssueSourceConfig['kind'], IssueSource> = {
  'github-repo': githubRepoSource,
  'github-project': githubProjectSource,
  jira: jiraSource,
};

/** Fresh enough while someone looks at the project's issues. */
export const WATCHED_REFRESH_MS = 90_000;
/** Fresh enough otherwise. */
export const IDLE_REFRESH_MS = 10 * 60_000;
/** Someone "looks at" a project's issues for this long after asking for them. */
const WATCH_MS = 5 * 60_000;
const TICK_MS = 30_000;
/** How much of a body goes out in a list (the task made from it gets it all). */
const LIST_BODY = 4000;

interface IssuesState {
  items: NormalizedIssue[];
  error?: string;
  fetchedAt: number;
  loading: boolean;
}

export interface IssuesOptions {
  /** Stand-ins for gh and HTTP, for tests. */
  gh?: IssueSourceIo['gh'];
  fetch?: typeof fetch;
  now?: () => number;
}

/** What a source is called in an error line. */
function sourceLabel(s: IssueSourceConfig): string {
  if (s.kind === 'github-repo') return s.repos.length ? `GitHub ${s.repos.join(', ')}` : 'GitHub issues';
  if (s.kind === 'github-project') return `GitHub project ${s.owner}/${s.number}`;
  return `Jira ${s.projectKeys.join(', ') || s.site}`;
}

export function createIssues(ctx: KanbanContext, opts: IssuesOptions = {}) {
  const runGh = opts.gh ?? ((args: string[], cwd: string, timeout?: number) => gh(args, cwd, timeout));
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, IssuesState>();
  const running = new Map<string, Promise<IssuesState>>();
  const asked = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;

  const state = (project: string): IssuesState => cache.get(project) ?? { items: [], fetchedAt: 0, loading: false };

  /** The list as it goes out: the tasks already made from each, and bodies cut to size. */
  const message = (project: string, rid?: string): Extract<KanbanServerMsg, { t: 'kanban.issues' }> => {
    const s = state(project);
    const items = s.items.map((i) => {
      const task = ctx.repo.findTaskByTicket(project, i.key);
      return { ...i, body: i.body.slice(0, LIST_BODY), ...(task ? { taskId: task.id } : {}) };
    });
    return { t: 'kanban.issues', ...(rid ? { rid } : {}), project, items, ...(s.error ? { error: s.error } : {}), fetchedAt: s.fetchedAt, loading: s.loading };
  };

  const io = (project: string): IssueSourceIo => {
    const def = ctx.project(project);
    const repos = ctx.repos(project).filter((r) => r.kind === 'git' && r.remote).map((r) => r.remote!);
    return { gh: runGh, fetch: doFetch, cwd: ctx.floor(project)?.dir ?? def?.dir ?? ctx.dataDir, jira: ctx.secrets.jira(), projectRepos: repos };
  };

  /** Asks every source of the project again (one refresh at a time per project). */
  const refresh = (project: string): Promise<IssuesState> => {
    const had = running.get(project);
    if (had) return had;
    const sources = ctx.settings.project(project).issueSources;
    cache.set(project, { ...state(project), loading: true });
    ctx.broadcast(message(project), project);
    wallChanged(project);
    const p = (async () => {
      const got = await Promise.allSettled(sources.map((s) => ISSUE_SOURCES[s.kind].list(s, io(project))));
      const items: NormalizedIssue[] = [];
      const seen = new Set<string>();
      const errors: string[] = [];
      got.forEach((r, i) => {
        if (r.status === 'rejected') return errors.push(`${sourceLabel(sources[i])}: ${(r.reason as Error)?.message ?? String(r.reason)}`);
        for (const issue of r.value) {
          if (seen.has(issue.key)) continue;
          seen.add(issue.key);
          items.push(issue);
        }
      });
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const next: IssuesState = { items, fetchedAt: now(), loading: false, ...(errors.length ? { error: errors.join(' · ') } : {}) };
      cache.set(project, next);
      return next;
    })().finally(() => {
      running.delete(project);
      ctx.broadcast(message(project), project);
      wallChanged(project);
    });
    running.set(project, p);
    return p;
  };

  const due = (project: string): boolean => {
    const s = state(project);
    const watched = now() - (asked.get(project) ?? 0) < WATCH_MS;
    return !s.loading && now() - s.fetchedAt >= (watched ? WATCHED_REFRESH_MS : IDLE_REFRESH_MS);
  };

  /** The 3D office's issues board (wall.ts): the project's cards, while it has issue sources. */
  const wall = (project: string) => {
    if (!ctx.project(project) || !ctx.settings.project(project).issueSources.length) return undefined;
    const s = state(project);
    // The project's GitHub repositories: their issues open in the office's own issue window.
    const repos = ctx.repos(project).flatMap((r) => (r.remote ? [r.remote] : []));
    const items = s.items.map((i) => toGhIssue(i, ctx.repo.findTaskByTicket(project, i.key)?.id, repos));
    return { items, fetchedAt: s.fetchedAt, loading: s.loading || (!s.fetchedAt && !s.error), ...(s.error ? { error: s.error } : {}) };
  };
  /** Someone is on the project's floor: fetch at the pace for issues someone looks at, and now when they're due. */
  const watch = (project: string) => {
    if (!ctx.project(project) || !ctx.settings.project(project).issueSources.length) return;
    asked.set(project, now());
    if (due(project)) void refresh(project).catch(() => {});
  };

  const plugin: KanbanPlugin = {
    name: 'issues',
    ws: {
      'kanban.issues.list': (c, m) => {
        if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
        asked.set(m.project, now());
        const sources = ctx.settings.project(m.project).issueSources;
        if (sources.length && due(m.project)) void refresh(m.project).catch(() => {});
        c.send(message(m.project, m.rid));
      },
      'kanban.issues.refresh': async (c, m) => {
        if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
        asked.set(m.project, now());
        await refresh(m.project);
        c.send(message(m.project, m.rid));
      },
      'kanban.issues.createTask': async (c, m) => {
        if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
        const existing = ctx.repo.findTaskByTicket(m.project, m.issueKey);
        if (existing) return ok(c, m.rid, { taskId: existing.id, existed: true });
        let issue = state(m.project).items.find((i) => i.key === m.issueKey);
        if (!issue) issue = (await refresh(m.project)).items.find((i) => i.key === m.issueKey);
        if (!issue) return fail(c, m.rid, `${m.issueKey} isn't among the project's issues (any more)`);
        const made = await createIntegrationTask(ctx, { project: m.project, title: issue.title, description: issueDescription(issue), ticket: issue.key, ticketUrl: issue.url }, c, m.start, m.deskId ? { deskId: m.deskId } : undefined);
        ctx.broadcast(message(m.project), m.project);
        wallChanged(m.project);
        ok(c, m.rid, { taskId: made.task.id, existed: made.existed, ...(made.startError ? { startError: made.startError } : {}) });
      },
    },
    start() {
      setWallProvider(wall, watch, (project) => void refresh(project).catch(() => {}));
      timer = setInterval(() => {
        for (const def of ctx.projects()) {
          if (!ctx.settings.project(def.id).issueSources.length) continue;
          if (due(def.id)) void refresh(def.id).catch(() => {});
        }
      }, TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      setWallProvider(undefined);
    },
  };
  return { plugin, refresh, state, message, wall, watch };
}

/** A task's description from its issue: the issue's text, then where it came from. */
export function issueDescription(issue: NormalizedIssue): string {
  const body = issue.body.trim();
  return `${body ? `${body}\n\n` : ''}Source: ${issue.url}`;
}

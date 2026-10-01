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
import { refreshWall, setWallProvider, toGhIssue, wallChanged } from './wall.js';
import { issueActionHandlers, type IssuePatch } from './actions.js';
import { createBrowse } from './browse/index.js';
import type { GhIssue, GhState } from '../../../../shared/protocol.js';

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
/** A fetch that started this long after a change was written has seen it (Jira's search lags a little behind its writes). */
const OVERLAY_SETTLE_MS = 10_000;
/** A change shown before a fetch has it is dropped after this long, whatever the fetches say. */
const OVERLAY_TTL_MS = 2 * 60_000;
/** An issue acted on stays open to actions this long after, even when the list has lost it (a closed one: Reopen). */
const ACTED_TTL_MS = 30 * 60_000;
/** An issue browsed stays open to actions this long (a bounded set, the oldest let go first). */
const BROWSED_TTL_MS = 12 * 60 * 60_000;
const BROWSED_MAX = 300;
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
  const runGh = opts.gh ?? ((args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => gh(args, cwd, timeout, env));
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, IssuesState>();
  const running = new Map<string, Promise<IssuesState>>();
  const asked = new Map<string, number>();
  /** Bumped when a project's sources change: a fetch that started before keeps its cards to itself. */
  const generation = new Map<string, number>();
  /** The 3D board as last built per project (wall.ts), until its cards may have changed. */
  const walls = new Map<string, GhState<GhIssue>>();
  /** Changes made through the actions (status, assignee), shown over the fetched issues until a fetch started after them has them. */
  const overlay = new Map<string, Map<string, { fields: IssuePatch; at: number }>>();
  /** Issues acted on lately, as they were: for more actions on them only (never the list or the board). */
  const acted = new Map<string, Map<string, { issue: NormalizedIssue; at: number }>>();
  /** Issues opened in the browse window (shared/kanban/browse.ts) that the list may not have: oldest first, at most BROWSED_MAX per project. */
  const browsed = new Map<string, Map<string, { issue: NormalizedIssue; at: number }>>();
  let timer: NodeJS.Timeout | undefined;
  /** Per project, the fetch that follows a change by long enough to have seen it (see patch). */
  const settling = new Map<string, NodeJS.Timeout>();

  const state = (project: string): IssuesState => cache.get(project) ?? { items: [], fetchedAt: 0, loading: false };

  /** The issue with the change made to it since it was fetched, if any (a change older than its time to live is not shown). */
  const withChange = (project: string, i: NormalizedIssue): NormalizedIssue => {
    const o = overlay.get(project)?.get(i.key);
    return !o || now() - o.at >= OVERLAY_TTL_MS ? i : applyPatch(i, o.fields);
  };

  /** The project's issues with the changes made since they were fetched. */
  const current = (project: string): NormalizedIssue[] => (overlay.get(project)?.size ? state(project).items.map((i) => withChange(project, i)) : state(project).items);

  /** Lets go of the changes (and acted-on issues) past their time to live; the reads above only skip them. */
  const sweep = (project: string) => {
    const over = overlay.get(project);
    if (over) for (const [key, o] of over) if (now() - o.at >= OVERLAY_TTL_MS) over.delete(key);
    const kept = acted.get(project);
    if (kept) for (const [key, a] of kept) if (now() - a.at >= ACTED_TTL_MS) kept.delete(key);
    const seen = browsed.get(project);
    if (seen) for (const [key, a] of seen) if (now() - a.at >= BROWSED_TTL_MS) seen.delete(key);
  };

  /** Keeps a browsed issue (the newest last, so the oldest is the one let go of). */
  const browse = (project: string, issue: NormalizedIssue) => {
    const seen = browsed.get(project) ?? new Map();
    browsed.set(project, seen);
    seen.delete(issue.key);
    seen.set(issue.key, { issue, at: now() });
    while (seen.size > BROWSED_MAX) seen.delete(seen.keys().next().value as string);
  };

  /** A fetch that began at `startedAt` is over: the changes it was started late enough to have seen are in it now. */
  const settle = (project: string, startedAt: number) => {
    const over = overlay.get(project);
    if (over) for (const [key, o] of over) if (startedAt >= o.at + OVERLAY_SETTLE_MS) over.delete(key);
    sweep(project);
  };

  /** The list as it goes out: the tasks already made from each, and bodies cut to size. */
  const message = (project: string, rid?: string): Extract<KanbanServerMsg, { t: 'kanban.issues' }> => {
    const s = state(project);
    const tasks = ctx.repo.ticketTaskIds(project);
    const items = current(project).map((i) => {
      const taskId = tasks.get(i.key);
      return { ...i, body: i.body.slice(0, LIST_BODY), ...(taskId !== undefined ? { taskId } : {}) };
    });
    return { t: 'kanban.issues', ...(rid ? { rid } : {}), project, items, ...(s.error ? { error: s.error } : {}), fetchedAt: s.fetchedAt, loading: s.loading };
  };

  const io = (project: string): IssueSourceIo => {
    const def = ctx.project(project);
    const repos = ctx.repos(project).filter((r) => r.kind === 'git' && r.remote).map((r) => r.remote!);
    return { gh: runGh, fetch: doFetch, cwd: ctx.floor(project)?.dir ?? def?.dir ?? ctx.dataDir, jira: ctx.secrets.jira(), projectRepos: repos };
  };

  const browsing = createBrowse(ctx, { io, browsed: browse });

  /** Asks every source of the project again (one refresh at a time per project). */
  const refresh = (project: string): Promise<IssuesState> => {
    const had = running.get(project);
    if (had) return had;
    const sources = ctx.settings.project(project).issueSources;
    const gen = generation.get(project) ?? 0;
    const startedAt = now();
    cache.set(project, { ...state(project), loading: true });
    ctx.broadcast(message(project), project);
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
      // The sources changed while it ran: these are the old ones' issues.
      if ((generation.get(project) ?? 0) !== gen) return state(project);
      cache.set(project, next);
      // Only a fetch that every source answered shows the issues as they are.
      if (!errors.length) settle(project, startedAt);
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

  const hasSources = (project: string) => !!ctx.project(project) && ctx.settings.project(project).issueSources.length > 0;

  /** The 3D office's issues board (wall.ts): the project's cards, while it has issue sources; built once until they may change. */
  const wall = (project: string): GhState<GhIssue> | undefined => {
    if (!hasSources(project)) return undefined;
    const built = walls.get(project);
    if (built) return built;
    const s = state(project);
    // The project's GitHub repositories: their issues open in the office's own issue window.
    const repos = ctx.repos(project).flatMap((r) => (r.remote ? [r.remote] : []));
    const tasks = ctx.repo.ticketTaskIds(project);
    const items = current(project).map((i) => toGhIssue(i, tasks.get(i.key), repos));
    const board = { items, fetchedAt: s.fetchedAt, loading: s.loading || (!s.fetchedAt && !s.error), ...(s.error ? { error: s.error } : {}) };
    walls.set(project, board);
    return board;
  };

  /** Fetches once the fetch under way (if any) is over, so the one that runs started after now. */
  const refreshAfter = (project: string) => {
    const had = running.get(project);
    void (had ? had.catch(() => undefined).then(() => refresh(project)) : refresh(project)).catch(() => {});
  };

  /** The sources were saved: the old ones' cards go now, and the new ones are fetched once any fetch under way is over. */
  const sourcesChanged = (project: string) => {
    generation.set(project, (generation.get(project) ?? 0) + 1);
    cache.delete(project);
    overlay.delete(project);
    acted.delete(project);
    browsed.delete(project);
    walls.delete(project);
    if (!hasSources(project)) return;
    const had = running.get(project);
    void (had ? had.catch(() => undefined).then(() => refresh(project)) : refresh(project)).catch(() => {});
  };
  /** Someone is on the project's floor: fetch at the pace for issues someone looks at, and now when they're due. */
  const watch = (project: string) => {
    if (!ctx.project(project) || !ctx.settings.project(project).issueSources.length) return;
    asked.set(project, now());
    if (due(project)) void refresh(project).catch(() => {});
  };

  /** A change made through an issue action: shown at once on the kanban and the 3D board, then fetched again. */
  const patch = (project: string, key: string, fields: IssuePatch) => {
    sweep(project);
    const over = overlay.get(project) ?? new Map();
    overlay.set(project, over);
    over.set(key, { fields: { ...over.get(key)?.fields, ...fields }, at: now() });
    // An issue only acted on or browsed is not on the list: its own copy takes the change.
    for (const kept of [acted.get(project)?.get(key), browsed.get(project)?.get(key)]) if (kept) kept.issue = applyPatch(kept.issue, fields);
    ctx.broadcast(message(project), project);
    wallChanged(project);
    refreshWall(project);
    // A search that lags behind a write (Jira's) may miss it in that quick fetch; this one starts late enough to clear the change.
    clearTimeout(settling.get(project));
    const t = setTimeout(() => {
      settling.delete(project);
      // One already under way may have started too soon to have seen the change: another follows it.
      if (hasSources(project)) refreshAfter(project);
    }, OVERLAY_SETTLE_MS + 2000);
    t.unref?.();
    settling.set(project, t);
  };

  /** An issue of the list (with its pending change), else one acted on or browsed lately. */
  const find = (project: string, key: string): NormalizedIssue | undefined => {
    const listed = state(project).items.find((x) => x.key === key);
    if (listed) return withChange(project, listed);
    const before = acted.get(project)?.get(key);
    if (before && now() - before.at < ACTED_TTL_MS) return before.issue;
    const seen = browsed.get(project)?.get(key);
    return seen && now() - seen.at < BROWSED_TTL_MS ? seen.issue : undefined;
  };

  const plugin: KanbanPlugin = {
    name: 'issues',
    ws: {
      ...browsing.ws,
      ...issueActionHandlers(ctx, {
        find,
        load: async (project, key) => {
          const issue = await browsing.load(project, key);
          if (issue) browse(project, issue);
          return issue;
        },
        patch,
        io,
        remember: (project, issue) => {
          const kept = acted.get(project) ?? new Map();
          acted.set(project, kept);
          kept.set(issue.key, { issue, at: now() });
        },
      }),
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
        if (existing) {
          // Made before (on the kanban, or a start that failed): one in To do starts now, at the desk asked for; any other (running, done, archived) is only named.
          if (!m.start || existing.status !== 'todo') return ok(c, m.rid, { taskId: existing.id, existed: true });
          const err = await ctx.engine.start(existing.id, c, m.deskId ? { deskId: m.deskId } : undefined);
          ctx.taskChanged(existing.id);
          wallChanged(m.project);
          return ok(c, m.rid, { taskId: existing.id, existed: true, ...(typeof err === 'string' && err ? { startError: err } : { started: true }) });
        }
        let issue = find(m.project, m.issueKey) ?? (await browsing.load(m.project, m.issueKey));
        if (!issue) issue = (await refresh(m.project)).items.find((i) => i.key === m.issueKey);
        if (!issue) return fail(c, m.rid, `${m.issueKey} isn't among the project's issues (any more)`);
        const made = await createIntegrationTask(ctx, { project: m.project, title: issue.title, description: issueDescription(issue), ticket: issue.key, ticketUrl: issue.url }, c, m.start, m.deskId ? { deskId: m.deskId } : undefined);
        ctx.broadcast(message(m.project), m.project);
        wallChanged(m.project);
        ok(c, m.rid, { taskId: made.task.id, existed: made.existed, ...(made.startError ? { startError: made.startError } : made.started ? { started: true } : {}) });
      },
    },
    start() {
      setWallProvider({
        board: wall,
        watch,
        refresh: (project) => void (hasSources(project) ? refresh(project).catch(() => {}) : undefined),
        forget: (project) => void walls.delete(project),
        known: (project, key) => find(project, key) !== undefined,
        sourcesChanged,
      });
      timer = setInterval(() => {
        for (const def of ctx.projects()) {
          if (!ctx.settings.project(def.id).issueSources.length) continue;
          if (due(def.id)) void refresh(def.id).catch(() => {});
        }
        for (const def of ctx.projects()) sweep(def.id);
      }, TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      for (const t of settling.values()) clearTimeout(t);
      settling.clear();
      setWallProvider(undefined);
    },
  };
  return { plugin, refresh, state, message, wall, watch };
}

/** The issue with a change made through an action applied (`assignee: null` clears it). */
function applyPatch(i: NormalizedIssue, fields: IssuePatch): NormalizedIssue {
  const next = { ...i };
  if (fields.status !== undefined) next.status = fields.status;
  if (fields.assignee === null) delete next.assignee;
  else if (fields.assignee !== undefined) next.assignee = fields.assignee;
  return next;
}

/** A task's description from its issue: the issue's text, then where it came from. */
export function issueDescription(issue: NormalizedIssue): string {
  const body = issue.body.trim();
  return `${body ? `${body}\n\n` : ''}Source: ${issue.url}`;
}

// The WS handlers of the browse window (kanban.browse.*, shared/kanban/browse.ts) and the loader the
// actions fall back on for an issue that was browsed but is not on the sources' list. Every request
// names one of the project's Jira or GitHub-project sources (its `scope`) and is answered from that
// source and no wider: Jira by the source's project keys, GitHub by the source's board. Jira goes
// out under the shared token (so the office's name signs what it writes, as everywhere), GitHub
// reads by the office's gh.

import type { BrowseClientMsg, BrowseIssue, BrowseScope, BrowseServerMsg } from '../../../../../shared/kanban/browse.js';
import { parseGhKey } from '../../../../../shared/kanban/issuecard.js';
import { parseAbKey } from '../../../../../shared/hosting/workitems.js';
import { readWorkItems, readerAs, type AzureBoardsConfig } from '../azure-boards.js';
import type { IssueSourceConfig, NormalizedIssue } from '../../../../../shared/kanban/types.js';
import type { KanbanClient, KanbanContext, KanbanPlugin } from '../../../registry.js';
import { fail } from '../../util.js';
import { ghPeople } from '../github-ops.js';
import { parseGhIssues } from '../github-repo.js';
import type { IssueActIo, IssueSourceIo } from '../source.js';
import { ghChildren, ghCount, ghGet, ghGetOn, ghGroups, ghLogin, ghOptions, ghPage } from './github.js';
import { jiraCount, jiraGet, jiraOptions, jiraPage, jiraScopePeople, jiraSearchPage, jiraVersions, newJiraCaches } from './jira.js';
import { JIRA_KEY_RE, browseJql, keyProject, narrowsBeyondCategory } from './jql.js';

type JiraConfig = Extract<IssueSourceConfig, { kind: 'jira' }>;
type ProjectConfig = Extract<IssueSourceConfig, { kind: 'github-project' }>;
type Browsable = JiraConfig | ProjectConfig;
type Msg<T extends BrowseClientMsg['t']> = Extract<BrowseClientMsg, { t: T }>;

export interface BrowseDeps {
  io(project: string): IssueSourceIo;
  /** Keeps a browsed issue, so the actions on it (status, comments, assignee, a task) accept it. */
  browsed(project: string, issue: NormalizedIssue): void;
}

/** How long a person's GitHub login is remembered, and a key `load` found nothing for. */
const LOGIN_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
const MISS_MAX = 500;

export const NO_KEYS = 'Add project keys to the Jira source to browse it';

const isBrowsable = (s: IssueSourceConfig): s is Browsable => s.kind === 'jira' || s.kind === 'github-project';
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why a source can't be browsed, if it can't. */
const disabledWhy = (s: Browsable): string | undefined => (s.kind === 'jira' && !s.projectKeys.length ? NO_KEYS : undefined);

const scopeOf = (s: Browsable): BrowseScope =>
  s.kind === 'jira'
    ? { id: s.id, kind: 'jira', label: `Jira ${s.projectKeys.join(', ') || s.site}`, site: s.site, ...(disabledWhy(s) ? { disabled: disabledWhy(s) } : {}) }
    : { id: s.id, kind: 'github-project', label: `GitHub project ${s.owner}/${s.number}` };

export function createBrowse(ctx: KanbanContext, deps: BrowseDeps) {
  // Replaced, not cleared, when connections change: a read begun before then writes into the discarded maps.
  let caches = newJiraCaches();
  /** The GitHub login each account's own gh signs in as: kept for ten minutes, a failed ask not at all. */
  const logins = new Map<string, { at: number; p: Promise<string | undefined> }>();
  /** The keys `load` found nothing for, and when (so an action on a key that isn't the project's doesn't ask GitHub or Jira every time). */
  const missed = new Map<string, number>();

  const actIo = (project: string, who: string): IssueActIo => ({ ...deps.io(project), who, shared: true });

  const reply = (c: KanbanClient, m: { project: string; scope: string; rid?: string }, msg: Record<string, unknown> & { t: BrowseServerMsg['t'] }) =>
    c.send({ ...msg, ...(m.rid ? { rid: m.rid } : {}), project: m.project, scope: m.scope } as unknown as BrowseServerMsg);

  /** The page's issues (and their parents) with the task already made from each. */
  const withTasks = (project: string, items: BrowseIssue[]): BrowseIssue[] => {
    const tasks = ctx.repo.ticketTaskIds(project);
    if (!tasks.size) return items;
    return items.map((i) => {
      const taskId = tasks.get(i.key);
      const up = i.parent ? tasks.get(i.parent.key) : undefined;
      return taskId === undefined && up === undefined ? i : { ...i, ...(taskId !== undefined ? { taskId } : {}), ...(i.parent && up !== undefined ? { parent: { ...i.parent, taskId: up } } : {}) };
    });
  };

  /** Checks the project and the scope, then runs `go`; any error it throws is the answer. */
  const scoped =
    <M extends { project: string; scope: string; rid?: string }>(go: (c: KanbanClient, m: M, s: { cfg: Browsable; io: IssueActIo }) => Promise<void>) =>
    async (c: KanbanClient, m: M): Promise<void> => {
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      const cfg = ctx.settings.project(m.project).issueSources.find((s) => s.id === m.scope);
      if (!cfg || !isBrowsable(cfg)) return fail(c, m.rid, `${m.scope} isn't a Jira or GitHub project source of this project`);
      const why = disabledWhy(cfg);
      if (why) return fail(c, m.rid, why);
      try {
        await go(c, m, { cfg, io: actIo(m.project, c.name) });
      } catch (err) {
        fail(c, m.rid, (err as Error)?.message ?? String(err));
      }
    };

  const myLogin = (project: string, c: KanbanClient): Promise<string | undefined> => {
    const as = ctx.ghAs?.(c.accountId);
    // Only a person's own sign-in says who they are: the office's gh is everybody's.
    if (!as || typeof as === 'string' || !c.accountId) return Promise.resolve(undefined);
    const hit = logins.get(c.accountId);
    if (hit && Date.now() - hit.at < LOGIN_TTL_MS) return hit.p;
    const id = c.accountId;
    const entry = {
      at: Date.now(),
      p: ghLogin(deps.io(project), as.env)
        .catch(() => undefined)
        .then((login) => {
          if (!login && logins.get(id) === entry) logins.delete(id);
          return login;
        }),
    };
    logins.set(id, entry);
    return entry.p;
  };

  const ws: NonNullable<KanbanPlugin['ws']> = {
    'kanban.browse.scopes': async (c, m) => {
      if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
      const scopes = ctx.settings.project(m.project).issueSources.filter(isBrowsable).map(scopeOf);
      const github = scopes.some((s) => s.kind === 'github-project') ? await myLogin(m.project, c) : undefined;
      c.send({ t: 'kanban.browseScopes', ...(m.rid ? { rid: m.rid } : {}), project: m.project, scopes, ...(github ? { me: { github } } : {}) });
    },

    'kanban.browse.options': scoped<Msg<'kanban.browse.options'>>(async (c, m, { cfg, io }) => {
      reply(c, m, { t: 'kanban.browseOptions', options: cfg.kind === 'jira' ? await jiraOptions(io, cfg, caches) : await ghOptions(io, cfg, caches) });
    }),

    'kanban.browse.groups': scoped<Msg<'kanban.browse.groups'>>(async (c, m, { cfg, io }) => {
      if (cfg.kind === 'github-project') return reply(c, m, { t: 'kanban.browseGroups', groups: await ghGroups(io, cfg, m.filters, m.released, caches) });
      // The unreleased versions page by page; then, on the last page, the collapsed node of the released ones and "No version".
      const f = m.filters;
      const only = (g: { id: string }) => !f.version || g.id === f.version;
      if (f.version === 'none') return reply(c, m, { t: 'kanban.browseGroups', groups: [{ id: 'none', title: 'No version', kind: 'none' }] });
      const found = await jiraVersions(io, cfg, !!m.released, m.cursor, caches);
      const tail = m.released || found.next ? [] : [...(f.version ? [] : [{ id: 'released', title: 'Released versions', kind: 'released' as const }, { id: 'none', title: 'No version', kind: 'none' as const }])];
      reply(c, m, { t: 'kanban.browseGroups', groups: [...found.groups.filter(only), ...tail], ...(found.next ? { next: found.next } : {}) });
    }),

    'kanban.browse.count': scoped<Msg<'kanban.browse.count'>>(async (c, m, { cfg, io }) => {
      if (cfg.kind === 'github-project') return reply(c, m, { t: 'kanban.browseCount', count: await ghCount(io, cfg, m.filters, m.group, caches) });
      // Raw JQL can't be checked after the fact (a count has no issues to look at), so it gets no count.
      if (m.filters.jql?.trim()) return reply(c, m, { t: 'kanban.browseCount' });
      // A search narrowed by more than the status category also lists the stories that have a matching sub-task (jira.ts), which
      // a count can't follow: no count. One narrowed by the status category alone (the default "Not done") counts the top-level
      // issues that match: the rows the group shows, as an epic's done/total counts them.
      if (narrowsBeyondCategory(m.filters)) return reply(c, m, { t: 'kanban.browseCount' });
      const jql = browseJql(cfg, m.filters, { topLevel: true, version: m.group, epic: m.epic }, false);
      const count = await jiraCount(io, cfg, jql, caches);
      reply(c, m, { t: 'kanban.browseCount', ...(count !== undefined ? { count } : {}) });
    }),

    'kanban.browse.page': scoped<Msg<'kanban.browse.page'>>(async (c, m, { cfg, io }) => {
      if (cfg.kind === 'github-project') {
        const page = await ghPage(io, cfg, m.filters, m.group, m.cursor);
        return reply(c, m, { t: 'kanban.browsePage', items: withTasks(m.project, page.items), total: page.total, ...(page.next ? { next: page.next } : {}) });
      }
      const page = await jiraPage(io, cfg, m.filters, { topLevel: true, version: m.group, epic: m.epic }, caches, m.cursor);
      reply(c, m, { t: 'kanban.browsePage', items: withTasks(m.project, page.items), ...(page.next ? { next: page.next } : {}) });
    }),

    'kanban.browse.children': scoped<Msg<'kanban.browse.children'>>(async (c, m, { cfg, io }) => {
      if (cfg.kind === 'github-project') {
        if (!m.nodeId) throw new Error('GitHub sub-issues are asked for by the issue’s node id');
        const page = await ghChildren(io, cfg, m.nodeId, m.cursor);
        return reply(c, m, { t: 'kanban.browsePage', issueKey: m.issueKey, items: withTasks(m.project, page.items), total: page.total, ...(page.next ? { next: page.next } : {}) });
      }
      if (!JIRA_KEY_RE.test(m.issueKey)) throw new Error(`${m.issueKey} isn’t a Jira issue key`);
      const page = await jiraSearchPage(io, cfg, browseJql(cfg, { statusCategory: 'all' }, { parent: m.issueKey }), caches, m.cursor);
      reply(c, m, { t: 'kanban.browsePage', issueKey: m.issueKey, items: withTasks(m.project, page.items), ...(page.next ? { next: page.next } : {}) });
    }),

    'kanban.browse.issue': scoped<Msg<'kanban.browse.issue'>>(async (c, m, { cfg, io }) => {
      const issue = cfg.kind === 'jira' ? await jiraGet(io, cfg, m.issueKey, caches) : await ghGet(io, cfg, m.issueKey);
      deps.browsed(m.project, issue);
      const taskId = ctx.repo.ticketTaskIds(m.project).get(issue.key);
      reply(c, m, { t: 'kanban.browseIssue', issue: { ...issue, ...(taskId !== undefined ? { taskId } : {}) } });
    }),

    'kanban.browse.people': scoped<Msg<'kanban.browse.people'>>(async (c, m, { cfg, io }) => {
      const send = (items: Awaited<ReturnType<typeof jiraScopePeople>>, cannot?: string) =>
        c.send({ t: 'kanban.issuePeople', ...(m.rid ? { rid: m.rid } : {}), project: m.project, issueKey: '', items, ...(cannot ? { cannot } : {}) });
      if (cfg.kind === 'jira') return send(await jiraScopePeople(io, cfg, m.query));
      // A board has no people of its own: the assignable users of the project's first GitHub repository.
      const repo = io.projectRepos[0];
      send(repo ? await ghPeople(io, repo, m.query) : [], repo ? undefined : 'The project has no GitHub repository to list people from: type a login instead');
    }),
  };

  /**
   * An issue of the project fetched fresh, for an action or a task on a key that is not on the list
   * (it was browsed, and the cache let go of it). Only the project's own: a Jira key of a source's
   * project keys; a `gh:` key on one of its boards or of its repositories; a draft of one of its
   * boards. Anything else, or any failure, is undefined. `source`: the source the asker came through (a Jira key is read through that one only).
   */
  const load = async (project: string, key: string, source?: string): Promise<NormalizedIssue | undefined> => {
    const at = `${project}|${source ?? ''}|${key}`;
    const seen = missed.get(at);
    if (seen !== undefined && Date.now() - seen < MISS_TTL_MS) return undefined;
    const found = await fetchOwn(project, key, source);
    if (!found) {
      if (missed.size >= MISS_MAX) missed.delete(missed.keys().next().value as string);
      missed.set(at, Date.now());
    } else missed.delete(at);
    return found;
  };

  const fetchOwn = async (project: string, key: string, source?: string): Promise<NormalizedIssue | undefined> => {
    const sources = ctx.settings.project(project).issueSources;
    const io = actIo(project, 'Agent Office');
    try {
      // An Azure Boards work item: only of one of the project's Azure Boards sources (its organization and project).
      const ab = parseAbKey(key);
      if (ab) {
        const board = sources.find((s): s is AzureBoardsConfig => s.kind === 'azure-boards' && s.org.toLowerCase() === ab.org.toLowerCase() && s.project.toLowerCase() === ab.project.toLowerCase());
        return board ? (await readWorkItems(io, readerAs(board.org), board.org, board.project, [ab.id], board.id))[0] : undefined;
      }
      if (JIRA_KEY_RE.test(key)) {
        // Through the source the asker opened it through when they named one (its own connection), else the first that holds the key's project.
        const jira = sources.find((s): s is JiraConfig => s.kind === 'jira' && (source === undefined || s.id === source) && s.projectKeys.some((k) => k.toUpperCase() === keyProject(key)));
        return jira ? await jiraGet(io, jira, key, caches) : undefined;
      }
      // The issue and its parent chain are read once and tested against each board (not one fetch per board).
      const boards = sources.filter((s): s is ProjectConfig => s.kind === 'github-project');
      const found = boards.length ? await ghGetOn(io, boards, key).catch(() => undefined) : undefined;
      if (found) return found;
      const gh = parseGhKey(key);
      const repos = [...io.projectRepos, ...sources.flatMap((s) => (s.kind === 'github-repo' ? s.repos : []))];
      if (!gh || !repos.some((r) => sameRepo(r, gh.repo))) return undefined;
      const out = await io.gh(['issue', 'view', String(gh.number), '-R', gh.repo, '--json', 'number,title,body,url,state,assignees,labels,updatedAt'], io.cwd, 30_000);
      return parseGhIssues(gh.repo, `[${out}]`)[0];
    } catch {
      return undefined;
    }
  };

  /** Jira connections changed: what was read with the old logins (counts, versions, parents) is asked again; the Sprint field per site and the boards' fields may stay. */
  const connectionsChanged = () => {
    caches = { ...newJiraCaches(), sprintField: caches.sprintField, fields: caches.fields };
    missed.clear();
  };

  return { ws, load, connectionsChanged };
}

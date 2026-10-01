// Browsing a Jira source: pages of issues (POST /rest/api/3/search/jql, its `nextPageToken` is the
// cursor), the fix versions, an approximate count asked for lazily, the filter choices, one issue and
// the people an issue can go to. Everything is inside the source's project keys (jql.ts), and goes
// through jiraCall, so the token only ever reaches its own site. A failure is an Error with a text a
// person can act on.

import type { BrowseFilters, BrowseGroup, BrowseIssue, BrowseOptions, StatusCategory } from '../../../../../shared/kanban/browse.js';
import type { IssuePerson } from '../../../../../shared/kanban/issueops.js';
import type { IssueSourceConfig } from '../../../../../shared/kanban/types.js';
import { jiraIssue, jqlQuote } from '../jira.js';
import { jiraCall } from '../jira-ops.js';
import type { IssueActIo } from '../source.js';
import { isEpicType } from '../../../../../shared/kanban/browsetree.js';
import { JIRA_KEY_RE, browseJql, keyProject, narrows, scopeClause, type JqlWhere } from './jql.js';

type JiraConfig = Extract<IssueSourceConfig, { kind: 'jira' }>;

/** Issues in a page, and versions per project. */
export const PAGE = 50;
const PEOPLE = 20;
/** A count is asked again after this long, and the cache holds this many. */
export const COUNT_TTL_MS = 60_000;
const COUNT_CACHE_MAX = 500;
const FIELDS = ['summary', 'status', 'assignee', 'labels', 'updated', 'issuetype', 'parent', 'fixVersions', 'subtasks', 'project'];

/** What the browse calls remember between requests (one set per office). */
export interface JiraCaches {
  counts: Map<string, { at: number; count?: number }>;
  /** The id of the Sprint custom field, once per site. */
  sprintField: Map<string, Promise<string | undefined>>;
}
export const newJiraCaches = (): JiraCaches => ({ counts: new Map(), sprintField: new Map() });

/** Jira's own words, kept where a person can act on them. */
function friendly(err: unknown, textSearch = false): Error {
  const msg = (err as Error)?.message ?? String(err);
  if (/^Jira said 429/.test(msg)) return new Error('Jira is rate-limiting the office: try again in a minute');
  if (textSearch && /^Jira said 400/.test(msg)) return new Error('Jira couldn’t search for that text (remove characters like [ ] ! ^ ")');
  return err instanceof Error ? err : new Error(msg);
}

async function call(io: IssueActIo, scope: JiraConfig, method: 'GET' | 'POST', path: string, body?: unknown, textSearch = false): Promise<any> {
  try {
    return await jiraCall(io, scope.site, method, path, body);
  } catch (err) {
    throw friendly(err, textSearch);
  }
}

/** The id of the Sprint field (`customfield_10020`), or undefined when the site has no Jira Software. */
function sprintFieldOf(io: IssueActIo, scope: JiraConfig, caches: JiraCaches): Promise<string | undefined> {
  const site = scope.site.toLowerCase();
  let p = caches.sprintField.get(site);
  if (!p) {
    p = call(io, scope, 'GET', '/rest/api/3/field').then(
      (fields) => (Array.isArray(fields) ? fields : []).find((f: any) => f?.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id as string | undefined,
      () => undefined,
    );
    caches.sprintField.set(site, p);
  }
  return p;
}

/** Whether the issue is in one of the scope's projects (its project field, else the key's prefix): a query that escaped the scope still can't show another project. */
const inScope = (issue: BrowseIssue, scope: Pick<JiraConfig, 'projectKeys'>): boolean => {
  const project = (issue.project ?? keyProject(issue.key)).toUpperCase();
  return scope.projectKeys.some((k) => k.toUpperCase() === project);
};

const category = (s: any): StatusCategory | undefined => (s?.statusCategory?.key === 'new' || s?.statusCategory?.key === 'indeterminate' || s?.statusCategory?.key === 'done' ? s.statusCategory.key : undefined);

/** One issue of a search or a single read as a browse issue. `sprintField`: where its sprints are. */
export function jiraBrowseIssue(raw: any, site: string, sourceId: string, sprintField?: string): BrowseIssue | undefined {
  const base = jiraIssue(raw, site, sourceId);
  if (!base) return undefined;
  const f = raw.fields ?? {};
  const t = f.issuetype;
  const p = f.parent;
  const subtasks: any[] = Array.isArray(f.subtasks) ? f.subtasks : [];
  const sprints: any[] = sprintField && Array.isArray(f[sprintField]) ? f[sprintField] : [];
  const cat = category(f.status);
  return {
    ...base,
    ...(t?.name ? { issueType: String(t.name) } : {}),
    ...(typeof t?.hierarchyLevel === 'number' ? { hierarchy: t.hierarchyLevel } : {}),
    ...(t?.subtask === true ? { subtask: true } : {}),
    ...(cat ? { statusCategory: cat } : {}),
    ...(Array.isArray(f.fixVersions) && f.fixVersions.length ? { fixVersions: f.fixVersions.map((v: any) => ({ id: String(v.id), name: String(v.name ?? v.id) })) } : {}),
    ...(sprints.length ? { sprints: sprints.map((s) => ({ id: String(s.id), name: String(s.name ?? s.id), state: String(s.state ?? '') })) } : {}),
    ...(p?.key
      ? {
          parent: {
            key: String(p.key),
            title: String(p.fields?.summary ?? p.key),
            ...(p.fields?.issuetype?.name ? { type: String(p.fields.issuetype.name) } : {}),
            ...(typeof p.fields?.issuetype?.hierarchyLevel === 'number' ? { hierarchy: p.fields.issuetype.hierarchyLevel } : {}),
            ...(p.fields?.status?.name ? { status: String(p.fields.status.name) } : {}),
            ...(category(p.fields?.status) ? { statusCategory: category(p.fields.status) } : {}),
          },
        }
      : {}),
    ...(subtasks.length ? { childCount: subtasks.length, childDone: subtasks.filter((s) => category(s.fields?.status) === 'done').length } : {}),
  };
}

/** One page of issues for the query; `next` is the token of the following page. */
export async function jiraSearchPage(io: IssueActIo, scope: JiraConfig, jql: string, caches: JiraCaches, cursor?: string, textSearch = false): Promise<{ items: BrowseIssue[]; next?: string }> {
  const sprintField = await sprintFieldOf(io, scope, caches);
  const body = await call(io, scope, 'POST', '/rest/api/3/search/jql', { jql, fields: [...new Set([...FIELDS, 'project']), ...(sprintField ? [sprintField] : [])], maxResults: PAGE, ...(cursor ? { nextPageToken: cursor } : {}) }, textSearch);
  const items = (body.issues ?? []).flatMap((raw: any) => jiraBrowseIssue(raw, scope.site, scope.id, sprintField) ?? []).filter((i: BrowseIssue) => inScope(i, scope));
  const next = typeof body.nextPageToken === 'string' && body.nextPageToken && body.isLast !== true ? body.nextPageToken : undefined;
  return { items, ...(next ? { next } : {}) };
}

const isSubtask = (i: BrowseIssue): boolean => i.subtask === true || i.hierarchy === -1;

/**
 * A narrowed search's page (jql.ts `narrows`) has sub-tasks in it. The ones whose parent doesn't
 * fit the version or epic asked for go (a sub-task has no version or epic of its own: its parent's
 * decide), and the parents that aren't on the page are fetched in one search and added, flagged
 * `context`, in front of their first sub-task, so the tree can nest the sub-tasks under them.
 */
async function withContext(io: IssueActIo, scope: JiraConfig, page: { items: BrowseIssue[]; next?: string }, filters: BrowseFilters, where: JqlWhere, caches: JiraCaches) {
  const subs = page.items.filter(isSubtask);
  if (!subs.length) return page;
  const onPage = new Map(page.items.map((i) => [i.key, i]));
  const missing = [...new Set(subs.flatMap((s) => (s.parent && !onPage.has(s.parent.key) && JIRA_KEY_RE.test(s.parent.key) ? [s.parent.key] : [])))];
  const fetched = missing.length ? (await jiraSearchPage(io, scope, `${scopeClause(scope)} AND key in (${missing.map(jqlQuote).join(', ')})`, caches)).items : [];
  const parents = new Map([...onPage, ...fetched.map((i): [string, BrowseIssue] => [i.key, i])]);
  const versions = [filters.version, where.version].filter((v): v is string => !!v);
  const epics = [filters.epic, where.epic].filter((e): e is string => !!e);
  const fits = (sub: BrowseIssue, up?: BrowseIssue): boolean => {
    if (!versions.length && !epics.length) return true;
    if (!up) return false;
    const own = sub.fixVersions?.length ? sub.fixVersions : (up.fixVersions ?? []);
    const epic = up.parent && isEpicType(up.parent.type, up.parent.hierarchy) ? up.parent.key : undefined;
    return versions.every((v) => (v === 'none' ? !own.length : own.some((x) => x.id === v))) && epics.every((e) => (e === 'none' ? !epic : epic === e));
  };
  const items: BrowseIssue[] = [];
  const added = new Set<string>();
  for (const i of page.items) {
    if (!isSubtask(i)) {
      items.push(i);
      continue;
    }
    const up = i.parent ? parents.get(i.parent.key) : undefined;
    if (!fits(i, up)) continue;
    if (up && !onPage.has(up.key) && !added.has(up.key)) {
      added.add(up.key);
      items.push({ ...up, context: true });
    }
    items.push(i);
  }
  return { ...page, items };
}

/** A page of the filters' issues in `where`. */
export async function jiraPage(io: IssueActIo, scope: JiraConfig, filters: BrowseFilters, where: JqlWhere, caches: JiraCaches, cursor?: string) {
  const page = await jiraSearchPage(io, scope, browseJql(scope, filters, where), caches, cursor, !!filters.q);
  return where.topLevel && narrows(filters) ? withContext(io, scope, page, filters, where, caches) : page;
}

/** The approximate count for the query; `{}` when Jira can't say (a failed count never fails a page). Cached for a minute per site, source and query. */
export async function jiraCount(io: IssueActIo, scope: JiraConfig, jql: string, caches: JiraCaches, now = Date.now()): Promise<number | undefined> {
  const key = `${scope.site.toLowerCase()}|${scope.id}|${jql}`;
  const hit = caches.counts.get(key);
  if (hit && now - hit.at < COUNT_TTL_MS) return hit.count;
  let count: number | undefined;
  try {
    const body = await jiraCall(io, scope.site, 'POST', '/rest/api/3/search/approximate-count', { jql });
    if (Number.isSafeInteger(body?.count)) count = body.count;
  } catch (err) {
    // A site without the endpoint (404) or a query it dislikes (400) has no count; anything else (the token, a 429) is the caller's to see.
    if (!/^Jira said (400|404)/.test((err as Error)?.message ?? '')) throw friendly(err);
  }
  if (caches.counts.size >= COUNT_CACHE_MAX) caches.counts.delete(caches.counts.keys().next().value as string);
  caches.counts.set(key, { at: now, count });
  return count;
}

/** The fix versions of the scope's projects, one page of each (`cursor`: where it starts). Unreleased ones oldest first, released newest first. */
export async function jiraVersions(io: IssueActIo, scope: JiraConfig, released: boolean, cursor?: string): Promise<{ groups: BrowseGroup[]; next?: string }> {
  const startAt = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const order = released ? '-releaseDate' : 'releaseDate';
  const got = await Promise.allSettled(
    scope.projectKeys.map((key) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`${key} isn’t a Jira project key`);
      return call(io, scope, 'GET', `/rest/api/3/project/${encodeURIComponent(key)}/version?startAt=${startAt}&maxResults=${PAGE}&orderBy=${order}&status=${released ? 'released' : 'unreleased'}`);
    }),
  );
  const failed = got.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed && got.every((r) => r.status === 'rejected')) throw failed.reason;
  const ok = got.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const groups = ok
    .flatMap((b) => (Array.isArray(b?.values) ? b.values : []))
    .filter((v: any) => v && v.id !== undefined && typeof v.name === 'string')
    .map((v: any): BrowseGroup => ({ id: String(v.id), title: v.name, kind: 'version', ...(v.released ? { released: true } : {}), ...(v.releaseDate ? { releaseDate: String(v.releaseDate) } : {}) }));
  // A version with no date goes after the dated ones (before them when released versions come newest first).
  const date = (g: BrowseGroup) => g.releaseDate ?? (released ? '' : '9999-99-99');
  groups.sort((a, b) => (released ? date(b).localeCompare(date(a)) : date(a).localeCompare(date(b))) || a.title.localeCompare(b.title));
  const more = ok.some((b) => b?.isLast === false);
  return { groups, ...(more ? { next: String(startAt + PAGE) } : {}) };
}

/** The statuses, issue types, versions and open epics of the scope, for the filters. */
export async function jiraOptions(io: IssueActIo, scope: JiraConfig): Promise<BrowseOptions> {
  const [statuses, versions, epics] = await Promise.all([
    Promise.allSettled(scope.projectKeys.map((key) => call(io, scope, 'GET', `/rest/api/3/project/${encodeURIComponent(key)}/statuses`))),
    jiraVersions(io, scope, false),
    call(io, scope, 'POST', '/rest/api/3/search/jql', { jql: `${scopeClause(scope)} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`, fields: ['summary'], maxResults: 100 }),
  ]);
  const seen = new Map<string, StatusCategory>();
  const types = new Set<string>();
  for (const r of statuses) {
    if (r.status !== 'fulfilled') continue;
    for (const t of Array.isArray(r.value) ? r.value : []) {
      if (typeof t?.name === 'string') types.add(t.name);
      for (const s of t?.statuses ?? []) if (typeof s?.name === 'string' && !seen.has(s.name)) seen.set(s.name, category(s) ?? 'indeterminate');
    }
  }
  if (statuses.length && statuses.every((r) => r.status === 'rejected')) throw (statuses[0] as PromiseRejectedResult).reason;
  return {
    statuses: [...seen].map(([name, cat]) => ({ name, category: cat })),
    issueTypes: [...types].sort((a, b) => a.localeCompare(b)),
    versions: versions.groups,
    epics: (epics.issues ?? []).filter((e: any) => typeof e?.key === 'string').map((e: any) => ({ key: String(e.key), title: String(e.fields?.summary ?? e.key) })),
    iterations: [],
  };
}

/** One issue by key, with its description: only of the scope's own projects. */
export async function jiraGet(io: IssueActIo, scope: JiraConfig, key: string, caches: JiraCaches): Promise<BrowseIssue> {
  if (!JIRA_KEY_RE.test(key)) throw new Error(`${key} isn’t a Jira issue key`);
  if (!scope.projectKeys.some((k) => k.toUpperCase() === keyProject(key))) throw new Error(`${key} isn't in this source's projects (${scope.projectKeys.join(', ')})`);
  const sprintField = await sprintFieldOf(io, scope, caches);
  const raw = await call(io, scope, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...FIELDS, 'description', ...(sprintField ? [sprintField] : [])].join(',')}`);
  const issue = jiraBrowseIssue(raw, scope.site, scope.id, sprintField);
  if (!issue) throw new Error(`Jira didn’t return ${key}`);
  if (!inScope(issue, scope)) throw new Error(`${key} isn't among the source's projects (${scope.projectKeys.join(', ')})`);
  return issue;
}

/** Who can be assigned in the scope's projects, matching `query`. */
export async function jiraScopePeople(io: IssueActIo, scope: JiraConfig, query = ''): Promise<IssuePerson[]> {
  const keys = scope.projectKeys.map(encodeURIComponent).join(',');
  const body = await call(io, scope, 'GET', `/rest/api/3/user/assignable/multiProjectSearch?projectKeys=${keys}&query=${encodeURIComponent(query)}&maxResults=${PEOPLE}`);
  return (Array.isArray(body) ? body : [])
    .filter((u: any) => u?.accountId && u.accountType !== 'app')
    .map((u: any): IssuePerson => ({ id: String(u.accountId), name: String(u.displayName ?? u.accountId), ...(u.avatarUrls?.['48x48'] ? { avatar: String(u.avatarUrls['48x48']) } : {}) }));
}

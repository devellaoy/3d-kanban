// Browsing a Jira source: pages of issues (POST /rest/api/3/search/jql, its `nextPageToken` is the
// cursor), the fix versions, an approximate count asked for lazily, the filter choices, one issue and
// the people an issue can go to. Everything is inside the source's project keys (jql.ts), and goes
// through jiraCall, so the token only ever reaches its own site. A failure is an Error with a text a
// person can act on.

import type { BrowseFilters, BrowseGroup, BrowseIssue, BrowseOptions, StatusCategory } from '../../../../../shared/kanban/browse.js';
import type { IssuePerson } from '../../../../../shared/kanban/issueops.js';
import type { IssueSourceConfig } from '../../../../../shared/kanban/types.js';
import { jiraIssue } from '../jira.js';
import { jiraCall } from '../jira-ops.js';
import type { IssueActIo } from '../source.js';
import { isEpic } from '../../../../../shared/kanban/browsetree.js';
import { TTL_MS, memo, type Entry } from './cache.js';
import { JIRA_KEY_RE, browseJql, keyLike, keyProject, narrowsBeyondCategory, scopeClause, type JqlWhere } from './jql.js';

type JiraConfig = Extract<IssueSourceConfig, { kind: 'jira' }>;

/** Issues in a page, and versions per project. */
export const PAGE = 50;
const PEOPLE = 20;
/** A count is asked again after this long (so are the versions, the board's fields and the sub-task parents). */
export const COUNT_TTL_MS = TTL_MS;
/** The most sub-tasks looked at to find the stories that have a matching one, and sub-task pages read for a page of stories. */
const PARENT_LOOKUP = 100;
const SUBTASK_PAGES = 4;
const FIELDS = ['summary', 'status', 'assignee', 'labels', 'updated', 'issuetype', 'parent', 'fixVersions', 'subtasks', 'project'];

/** What the browse calls remember between requests (one set per office). */
export interface JiraCaches {
  counts: Map<string, Entry<number | undefined>>;
  /** The id of the Sprint custom field, once per site (a failed ask is forgotten at once, a site without one asked again in a minute). */
  sprintField: Map<string, { at: number; ttl: number; p: Promise<string | undefined> }>;
  /** The fix versions of a source, per page. */
  versions: Map<string, Entry<{ groups: BrowseGroup[]; next?: string }>>;
  /** The stories that have a sub-task matching some filters. */
  parents: Map<string, Entry<string[]>>;
  /** A GitHub board's iteration and Status fields. */
  fields: Map<string, Entry<unknown>>;
}
export const newJiraCaches = (): JiraCaches => ({ counts: new Map(), sprintField: new Map(), versions: new Map(), parents: new Map(), fields: new Map() });

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
function sprintFieldOf(io: IssueActIo, scope: JiraConfig, caches: JiraCaches, now = Date.now()): Promise<string | undefined> {
  const site = scope.site.toLowerCase();
  const hit = caches.sprintField.get(site);
  if (hit && now - hit.at < hit.ttl) return hit.p;
  const entry = {
    at: now,
    ttl: Infinity,
    p: call(io, scope, 'GET', '/rest/api/3/field').then(
      (fields) => {
        const id = (Array.isArray(fields) ? fields : []).find((f: any) => f?.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id as string | undefined;
        if (!id) entry.ttl = COUNT_TTL_MS;
        return id;
      },
      () => {
        if (caches.sprintField.get(site) === entry) caches.sprintField.delete(site);
        return undefined;
      },
    ),
  };
  caches.sprintField.set(site, entry);
  return entry.p;
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
  const body = await call(io, scope, 'POST', '/rest/api/3/search/jql', { jql, fields: [...FIELDS, ...(sprintField ? [sprintField] : [])], maxResults: PAGE, ...(cursor ? { nextPageToken: cursor } : {}) }, textSearch);
  const items = (body.issues ?? []).flatMap((raw: any) => jiraBrowseIssue(raw, scope.site, scope.id, sprintField) ?? []).filter((i: BrowseIssue) => inScope(i, scope));
  const next = typeof body.nextPageToken === 'string' && body.nextPageToken && body.isLast !== true ? body.nextPageToken : undefined;
  return { items, ...(next ? { next } : {}) };
}

/** The issues of a search, with only the fields in `fields` (to find which keys match, or whose parents they are). */
async function jiraLookup(io: IssueActIo, scope: JiraConfig, jql: string, fields: string[], max: number, textSearch: boolean): Promise<{ key: string; parent?: string }[]> {
  const body = await call(io, scope, 'POST', '/rest/api/3/search/jql', { jql, fields: [...fields, 'project'], maxResults: max }, textSearch);
  return (body.issues ?? []).flatMap((raw: any) => {
    const key = String(raw?.key ?? '');
    const project = String(raw?.fields?.project?.key ?? keyProject(key)).toUpperCase();
    if (!JIRA_KEY_RE.test(key) || !scope.projectKeys.some((k) => k.toUpperCase() === project)) return [];
    const parent = raw.fields?.parent?.key;
    return [{ key, ...(typeof parent === 'string' && JIRA_KEY_RE.test(parent) ? { parent } : {}) }];
  });
}

/** Whether the retry without the clauses Jira may refuse (see JqlWhere.lenient) is worth making. */
const refusable = (scope: JiraConfig, filters: BrowseFilters, where: JqlWhere): boolean => !!((filters.q && keyLike(filters.q.trim(), scope)) || (where.topLevel && (where.epic === 'none' || filters.epic === 'none')));
const refused = (err: unknown): boolean => /^Jira said 400|^Jira couldn’t search for that text/.test((err as Error)?.message ?? '');

/**
 * A page of a group's top-level issues. The stories are paged with the strict clause of the group
 * (`fixVersion = V`, `parent = E`, ...), as when nothing narrows, so a page is never empty while
 * there are more: the sub-tasks never decide what is on it. Then the sub-tasks that match the
 * filters are fetched for the page's stories only (`parent in (…)`: all of them, up to a few pages),
 * and returned after their story, so the tree nests them.
 *
 * A search narrowed beyond the status category (a text, type, assignee, status, ...) can match a
 * sub-task whose story doesn't. Jira can't say "stories with a matching sub-task" (no parentsOf), so
 * the matching sub-tasks of the scope (the 100 last updated) are asked for their parents first, and a
 * page lists a story that matches the filters or is one of those parents; a parent that doesn't
 * match itself is flagged `context`. The trade-off: a sub-task beyond those 100 isn't found through
 * its story (narrow the filters more; the story's own children are always one click away), and one
 * that matches only the status category (the default "Not done") under a story that doesn't is not
 * either: the stories decide there.
 */
async function storyPage(io: IssueActIo, scope: JiraConfig, filters: BrowseFilters, where: JqlWhere, caches: JiraCaches, cursor: string | undefined, lenient: boolean) {
  const textSearch = !!filters.q;
  const parents = narrowsBeyondCategory(filters)
    ? await memo(caches.parents, `${scope.site.toLowerCase()}|${scope.id}|${browseJql(scope, filters, { subtasksOf: [], lenient }, false)}`, async () => [...new Set((await jiraLookup(io, scope, browseJql(scope, filters, { subtasksOf: [], lenient }), ['parent'], PARENT_LOOKUP, textSearch)).flatMap((i) => (i.parent ? [i.parent] : [])))])
    : [];
  const page = await jiraSearchPage(io, scope, browseJql(scope, filters, { ...where, topLevel: true, orKeys: parents, lenient }), caches, cursor, textSearch);
  const stories = where.epic === 'none' || filters.epic === 'none' ? page.items.filter((i) => !isEpic(i)) : page.items;
  if (!stories.length) return { ...page, items: [] };
  // Of the stories that are there for a sub-task, which match the filters themselves.
  const keys = stories.map((s) => s.key);
  const there = keys.filter((k) => parents.includes(k));
  const matching = there.length ? new Set((await jiraLookup(io, scope, browseJql(scope, filters, { keys: there, lenient }), [], there.length, textSearch)).map((i) => i.key)) : new Set<string>();
  const subs: BrowseIssue[] = [];
  let next: string | undefined;
  for (let n = 0; n < SUBTASK_PAGES; n++) {
    const got = await jiraSearchPage(io, scope, browseJql(scope, filters, { subtasksOf: keys, lenient }), caches, next, textSearch);
    subs.push(...got.items);
    next = got.next;
    if (!next) break;
  }
  const items: BrowseIssue[] = stories.flatMap((s) => [there.includes(s.key) && !matching.has(s.key) ? { ...s, context: true as const } : s, ...subs.filter((x) => x.parent?.key === s.key)]);
  return { ...page, items };
}

/** A page of the filters' issues in `where`. */
export async function jiraPage(io: IssueActIo, scope: JiraConfig, filters: BrowseFilters, where: JqlWhere, caches: JiraCaches, cursor?: string) {
  const go = (lenient: boolean) => (where.topLevel ? storyPage(io, scope, filters, where, caches, cursor, lenient) : jiraSearchPage(io, scope, browseJql(scope, filters, { ...where, lenient }), caches, cursor, !!filters.q));
  try {
    return await go(false);
  } catch (err) {
    // A text that looks like a key of a project that doesn't exist ("UTF-8" is not), or a site with no "Epic" type, is a 400: once more without those clauses.
    if (refusable(scope, filters, where) && refused(err)) return go(true);
    throw err;
  }
}

/** The approximate count for the query; `{}` when Jira can't say (a failed count never fails a page). Cached for a minute per site, source and query. */
export function jiraCount(io: IssueActIo, scope: JiraConfig, jql: string, caches: JiraCaches, now = Date.now()): Promise<number | undefined> {
  return memo(caches.counts, `${scope.site.toLowerCase()}|${scope.id}|${jql}`, async () => {
    try {
      const body = await jiraCall(io, scope.site, 'POST', '/rest/api/3/search/approximate-count', { jql });
      return Number.isSafeInteger(body?.count) ? (body.count as number) : undefined;
    } catch (err) {
      // A site without the endpoint (404) or a query it dislikes (400) has no count; anything else (the token, a 429) is the caller's to see.
      if (!/^Jira said (400|404)/.test((err as Error)?.message ?? '')) throw friendly(err);
      return undefined;
    }
  }, now);
}

/** The fix versions of the scope's projects, one page of each (`cursor`: where it starts). Unreleased ones oldest first, released newest first. */
export function jiraVersions(io: IssueActIo, scope: JiraConfig, released: boolean, cursor?: string, caches?: JiraCaches): Promise<{ groups: BrowseGroup[]; next?: string }> {
  const make = () => fetchVersions(io, scope, released, cursor);
  return caches ? memo(caches.versions, `${scope.site.toLowerCase()}|${scope.id}|${scope.projectKeys.join(',')}|${released}|${cursor ?? ''}`, make) : make();
}

async function fetchVersions(io: IssueActIo, scope: JiraConfig, released: boolean, cursor?: string): Promise<{ groups: BrowseGroup[]; next?: string }> {
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
export async function jiraOptions(io: IssueActIo, scope: JiraConfig, caches?: JiraCaches): Promise<BrowseOptions> {
  const [statuses, versions, epics] = await Promise.all([
    Promise.allSettled(scope.projectKeys.map((key) => call(io, scope, 'GET', `/rest/api/3/project/${encodeURIComponent(key)}/statuses`))),
    jiraVersions(io, scope, false, undefined, caches),
    // A site with no "Epic" type refuses this search (400): it has no epics to list, and the rest of the choices still come.
    call(io, scope, 'POST', '/rest/api/3/search/jql', { jql: `${scopeClause(scope)} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`, fields: ['summary'], maxResults: 100 }).catch(() => ({ issues: [] })),
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

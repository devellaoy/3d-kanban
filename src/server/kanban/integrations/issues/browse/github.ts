// Browsing a GitHub Projects v2 board: pages of items (`items(query:)` filters on GitHub's side, its
// `endCursor` is the cursor), the groups (the board's iterations, else its Status options), a lazy
// count (`totalCount` of one item), an issue's sub-issues, one issue, and who the asker is. Reads go
// through the office's gh (`gh api graphql`), like the issue source does, and the token needs
// read:project. Everything is on the scope's own board: one issue (and the sub-issues of one) is
// refused when it isn't an item of it.

import type { BrowseFilters, BrowseGroup, BrowseIssue, BrowseOptions } from '../../../../../shared/kanban/browse.js';
import { parseGhKey } from '../../../../../shared/kanban/issuecard.js';
import type { IssueSourceConfig } from '../../../../../shared/kanban/types.js';
import { ghIssueKey } from '../github-repo.js';
import { projectError, projectItem } from '../github-project.js';
import type { IssueSourceIo } from '../source.js';
import { projectQuery } from './projectquery.js';

type ProjectConfig = Extract<IssueSourceConfig, { kind: 'github-project' }>;

const PAGE = 50;
const TIMEOUT_MS = 60_000;
const LOGIN = '... on User { login } ... on Organization { login }';
const STATUS = 'status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }';
const ITERATION = 'iteration: fieldValueByName(name: "Iteration") { ... on ProjectV2ItemFieldIterationValue { title } }';
const BOARDS = `projectItems(first: 20) { nodes { project { owner { ${LOGIN} } number } ${STATUS} ${ITERATION} } }`;
/** What a card of the tree needs of an issue (the body only for the one the window opens). */
const ISSUE = (body: boolean) =>
  `id number title url ${body ? 'body' : ''} state updatedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } issueType { name } subIssuesSummary { total completed } parent { number title repository { nameWithOwner } }`;
const CONTENT = (body: boolean) => `content {
  __typename
  ... on Issue { ${ISSUE(body)} }
  ... on PullRequest { number title url ${body ? 'body' : ''} state updatedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } }
  ... on DraftIssue { title ${body ? 'body' : ''} updatedAt assignees(first: 10) { nodes { login } } }
}`;
const ON_OWNER = (fragment: string) => `repositoryOwner(login: $owner) { ... on User { projectV2(number: $number) { ...P } } ... on Organization { projectV2(number: $number) { ...P } } }${fragment}`;

/** One page of items: `$q` is the board's own filter, `$first` how many (1 for a count). */
export const BROWSE_PAGE_QUERY = `query($owner: String!, $number: Int!, $first: Int!, $after: String, $q: String) {
  ${ON_OWNER(`
}
fragment P on ProjectV2 {
  title url
  items(first: $first, after: $after, query: $q) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { id isArchived updatedAt ${STATUS} ${ITERATION} ${CONTENT(false)} }
  }
}`)}`;

/** The board's iterations (current and upcoming, and completed) and its Status options. */
export const BROWSE_FIELDS_QUERY = `query($owner: String!, $number: Int!) {
  ${ON_OWNER(`
}
fragment P on ProjectV2 {
  fields(first: 50) { nodes {
    __typename
    ... on ProjectV2IterationField { name configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } }
    ... on ProjectV2SingleSelectField { name options { name } }
  } }
}`)}`;

/** The issue types of the board's owner, when it is an organisation. */
const TYPES_QUERY = 'query($owner: String!) { repositoryOwner(login: $owner) { ... on Organization { issueTypes(first: 50) { nodes { name } } } } }';

/** An issue or pull request, with the items it is on. */
const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename
    ... on Issue { ${ISSUE(true)} ${BOARDS} }
    ... on PullRequest { number title url body state updatedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } ${BOARDS} }
  } }
}`;

/** A draft, by its item id. */
const DRAFT_QUERY = `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { id isArchived updatedAt ${STATUS} ${ITERATION} project { owner { ${LOGIN} } number } ${CONTENT(true)} } } }`;

/** An issue's sub-issues, when the issue is on the board. */
const CHILDREN_QUERY = `query($id: ID!, $after: String) { node(id: $id) { ... on Issue {
  ${BOARDS}
  subIssues(first: ${PAGE}, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${ISSUE(false)} ${BOARDS} } }
} } }`;

/** The parent chain of an issue, `levels` deep, each with the boards it is an item of. */
const chain = (levels: number): string => `parent { ${BOARDS} ${levels > 1 ? chain(levels - 1) : ''} }`;
/** How far up a sub-issue's parents are followed to find the board. */
const ANCESTOR_LEVELS = 5;
const ANCESTORS_QUERY = `query($id: ID!) { node(id: $id) { ... on Issue { ${chain(ANCESTOR_LEVELS)} } } }`;

type Vars = [flag: '-f' | '-F', name: string, value: string][];

/** Whether an issue's parent chain (the issue itself not included) reaches an item of the board. */
async function parentOnBoard(io: IssueSourceIo, c: ProjectConfig, nodeId: string): Promise<boolean> {
  let at = (await graphql(io, ANCESTORS_QUERY, [['-f', 'id', nodeId]])).node;
  for (let n = 0; n < ANCESTOR_LEVELS && at?.parent; n++) {
    at = at.parent;
    if (itemOnBoard(at.projectItems?.nodes, c)) return true;
  }
  return false;
}

/** One GraphQL call: the answer's `data`. gh's token errors become the text that says what to run. */
async function graphql(io: IssueSourceIo, query: string, vars: Vars): Promise<any> {
  let out: string;
  try {
    out = await io.gh(['api', 'graphql', '-f', `query=${query}`, ...vars.flatMap(([flag, name, value]) => [flag, `${name}=${value}`])], io.cwd, TIMEOUT_MS);
  } catch (err) {
    throw projectError(err);
  }
  let raw: any;
  try {
    raw = JSON.parse(out);
  } catch {
    throw new Error('gh gave something that isn’t JSON for the project');
  }
  if (Array.isArray(raw?.errors) && raw.errors.length) throw projectError(new Error(raw.errors.map((e: any) => `${e.type ?? ''} ${e.message ?? ''}`.trim()).join('; ')));
  return raw?.data ?? {};
}

const boardVars = (c: ProjectConfig): Vars => [['-f', 'owner', c.owner], ['-F', 'number', String(c.number)]];

/** The board in an answer, or the friendly error. */
function boardOf(data: any, c: ProjectConfig): any {
  const owner = data?.repositoryOwner;
  if (!owner) throw new Error(`There's no GitHub user or organisation called ${c.owner}`);
  if (!owner.projectV2) throw new Error(`${c.owner} has no project number ${c.number} (or gh can't see it)`);
  return owner.projectV2;
}

/** Whether one of an issue's project items is on this board. */
function itemOnBoard(nodes: any[] | undefined, c: ProjectConfig): any {
  return (nodes ?? []).find((n) => n?.project && String(n.project.owner?.login ?? '').toLowerCase() === c.owner.toLowerCase() && n.project.number === c.number);
}

/** A board item (or issue) as a browse issue: the source's mapping, plus the tree's fields. */
function browseIssue(node: any, c: ProjectConfig, boardUrl: string): BrowseIssue | undefined {
  const base = projectItem(node, c, boardUrl);
  if (!base) return undefined;
  const { closed, ...issue } = base;
  const content = node.content ?? {};
  const sub = content.subIssuesSummary;
  const parent = content.parent;
  const parentRepo: string | undefined = parent?.repository?.nameWithOwner;
  return {
    ...issue,
    ...(closed ? { statusCategory: 'done' as const } : {}),
    ...(content.issueType?.name ? { issueType: String(content.issueType.name) } : {}),
    ...(sub?.total > 0 ? { childCount: Number(sub.total), childDone: Number(sub.completed ?? 0) } : {}),
    ...(parentRepo && Number.isSafeInteger(parent.number) ? { parent: { key: ghIssueKey(parentRepo, parent.number), title: String(parent.title ?? '') } } : {}),
    ...(content.__typename === 'Issue' && typeof content.id === 'string' ? { nodeId: content.id } : {}),
  };
}

/** One page of the board's items for the filters and group: GitHub does the filtering. `total` is its exact count. */
export async function ghPage(io: IssueSourceIo, c: ProjectConfig, filters: BrowseFilters, group?: string, cursor?: string, first = PAGE): Promise<{ items: BrowseIssue[]; next?: string; total: number }> {
  const q = projectQuery(filters, group);
  const board = boardOf(await graphql(io, BROWSE_PAGE_QUERY, [...boardVars(c), ['-F', 'first', String(first)], ...(cursor ? ([['-f', 'after', cursor]] as Vars) : []), ...(q ? ([['-f', 'q', q]] as Vars) : [])]), c);
  const url = String(board.url ?? `https://github.com/${c.owner}`);
  const items = (board.items?.nodes ?? []).flatMap((n: any) => browseIssue(n, c, url) ?? []);
  const info = board.items?.pageInfo;
  return { items, ...(info?.hasNextPage && info.endCursor ? { next: String(info.endCursor) } : {}), total: Number(board.items?.totalCount ?? items.length) };
}

/** The board's iteration and Status fields. */
async function fieldsOf(io: IssueSourceIo, c: ProjectConfig) {
  const fields: any[] = boardOf(await graphql(io, BROWSE_FIELDS_QUERY, boardVars(c)), c).fields?.nodes ?? [];
  const named = (type: string, name: string) => fields.find((f) => f?.__typename === type && String(f.name).toLowerCase() === name);
  const iteration = named('ProjectV2IterationField', 'iteration');
  const iterations = (list: any[]) => (Array.isArray(list) ? list : []).filter((i) => typeof i?.title === 'string').map((i) => ({ title: String(i.title), start: String(i.startDate ?? '') }));
  return {
    iteration: iteration ? { active: iterations(iteration.configuration?.iterations), completed: iterations(iteration.configuration?.completedIterations) } : undefined,
    status: ((named('ProjectV2SingleSelectField', 'status')?.options ?? []) as any[]).map((o) => String(o.name)),
  };
}

/**
 * The top-level groups: one per iteration (current and upcoming first, the finished ones under a
 * collapsed node, which `released` opens) if the board has an Iteration field, else one per Status
 * option. Then the items with none. No counts: they are asked for when a group is in view.
 */
export async function ghGroups(io: IssueSourceIo, c: ProjectConfig, filters: BrowseFilters, released = false): Promise<BrowseGroup[]> {
  const f = await fieldsOf(io, c);
  if (f.iteration) {
    const iter = (i: { title: string; start: string }, done: boolean): BrowseGroup => ({ id: `i:${i.title}`, title: i.title, kind: 'iteration', ...(done ? { released: true } : {}), ...(i.start ? { releaseDate: i.start } : {}) });
    if (released) return f.iteration.completed.sort((a, b) => b.start.localeCompare(a.start)).map((i) => iter(i, true));
    const wanted = (g: BrowseGroup) => !filters.iteration || g.title === filters.iteration;
    const groups = f.iteration.active.sort((a, b) => a.start.localeCompare(b.start)).map((i) => iter(i, false)).filter(wanted);
    // A completed iteration named by the filter is its own group (else it would hide behind the collapsed node, which a filter removes).
    const done = filters.iteration && !groups.length ? f.iteration.completed.find((i) => i.title === filters.iteration) : undefined;
    if (done) return [iter(done, false)];
    const finished: BrowseGroup[] = f.iteration.completed.length && !filters.iteration ? [{ id: 'completed', title: 'Completed iterations', kind: 'released' }] : [];
    return [...groups, ...finished, ...(filters.iteration ? [] : [{ id: 'no:iteration', title: 'No iteration', kind: 'none' as const }])];
  }
  if (released) return [];
  const statuses = f.status.filter((s) => !filters.status || s === filters.status).map((s): BrowseGroup => ({ id: `s:${s}`, title: s, kind: 'status' }));
  return [...statuses, ...(filters.status ? [] : [{ id: 'no:status', title: 'No status', kind: 'none' as const }])];
}

/** The filter choices: the Status options, the iterations and the organisation's issue types. */
export async function ghOptions(io: IssueSourceIo, c: ProjectConfig): Promise<BrowseOptions> {
  const [f, types] = await Promise.all([fieldsOf(io, c), graphql(io, TYPES_QUERY, [['-f', 'owner', c.owner]]).catch(() => ({}))]);
  return {
    statuses: [],
    issueTypes: ((types.repositoryOwner?.issueTypes?.nodes ?? []) as any[]).map((t) => String(t.name)),
    versions: [],
    epics: [],
    iterations: [...(f.iteration?.active ?? []), ...(f.iteration?.completed ?? [])].map((i) => i.title),
    ...(f.status.length ? { statusField: f.status } : {}),
  };
}

/** An issue's sub-issues (50 a page). The issue must be on the board. */
export async function ghChildren(io: IssueSourceIo, c: ProjectConfig, nodeId: string, cursor?: string): Promise<{ items: BrowseIssue[]; next?: string; total: number }> {
  const node = (await graphql(io, CHILDREN_QUERY, [['-f', 'id', nodeId], ...(cursor ? ([['-f', 'after', cursor]] as Vars) : [])])).node;
  if (!node?.subIssues) throw new Error('That isn’t an issue with sub-issues');
  if (!itemOnBoard(node.projectItems?.nodes, c) && !(await parentOnBoard(io, c, nodeId))) throw new Error(`That issue isn't on the board ${c.owner}/${c.number}, nor under an item of it`);
  const url = `https://github.com/${c.owner}`;
  const items = (node.subIssues.nodes ?? []).flatMap((n: any) => {
    // The sub-issue's Status and Iteration are those of its item on this board, when it is on it.
    const item = itemOnBoard(n?.projectItems?.nodes, c);
    return browseIssue({ id: item?.id, status: item?.status, iteration: item?.iteration, content: { ...n, __typename: 'Issue' } }, c, url) ?? [];
  });
  const info = node.subIssues.pageInfo;
  return { items, ...(info?.hasNextPage && info.endCursor ? { next: String(info.endCursor) } : {}), total: Number(node.subIssues.totalCount ?? items.length) };
}

/** One issue (`gh:owner/repo#12`) or draft (`ghp:owner/number#<item>`) of the board, with its body. Anything not on the board is refused. */
export async function ghGet(io: IssueSourceIo, c: ProjectConfig, key: string): Promise<BrowseIssue> {
  const gh = parseGhKey(key);
  const url = `https://github.com/${c.owner}`;
  if (gh) {
    const [owner, name] = gh.repo.split('/');
    const found = (await graphql(io, ISSUE_QUERY, [['-f', 'owner', owner], ['-f', 'name', name], ['-F', 'number', String(gh.number)]])).repository?.issueOrPullRequest;
    const item = found ? itemOnBoard(found.projectItems?.nodes, c) : undefined;
    if (!found) throw new Error(`${key} wasn't found on GitHub (or gh can't see it)`);
    // A sub-issue that isn't an item of the board is the board's when its parents lead to one that is.
    if (!item && !(found.__typename === 'Issue' && typeof found.id === 'string' && (await parentOnBoard(io, c, found.id)))) throw new Error(`${key} isn't on the board ${c.owner}/${c.number}`);
    const issue = browseIssue({ id: item?.id, status: item?.status, iteration: item?.iteration, content: found }, c, url);
    if (!issue) throw new Error(`${key} can't be shown`);
    return issue;
  }
  const draft = /^ghp:([^/#]+)\/(\d+)#(.+)$/.exec(key);
  if (!draft || draft[1].toLowerCase() !== c.owner.toLowerCase() || Number(draft[2]) !== c.number) throw new Error(`${key} isn't an issue of the board ${c.owner}/${c.number}`);
  const node = (await graphql(io, DRAFT_QUERY, [['-f', 'id', draft[3]]])).node;
  if (!node || !itemOnBoard([node], c)) throw new Error(`${key} isn't on the board ${c.owner}/${c.number}`);
  const issue = browseIssue(node, c, url);
  if (!issue) throw new Error(`${key} can't be shown`);
  return issue;
}

/** The login gh runs as (`env`: the person's own sign-in). */
export async function ghLogin(io: IssueSourceIo, env: Record<string, string>): Promise<string | undefined> {
  const login = (await io.gh(['api', 'user', '--jq', '.login'], io.cwd, 20_000, env)).trim();
  return /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(login) ? login : undefined;
}

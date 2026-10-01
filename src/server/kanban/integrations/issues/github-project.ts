// A GitHub Projects v2 backlog (IssueSourceConfig 'github-project'), with `gh api graphql`: the
// board of a user or an organisation, by number. Filters: assignee (@me or a login), the Status
// single-select, the Iteration. Reading a project needs the token's read:project scope, which gh
// doesn't ask for by default.

import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { ghIssueKey } from './github-repo.js';
import { ISSUE_BODY_MAX, SOURCE_MAX, type IssueSource, type IssueSourceIo } from './source.js';

type ProjectConfig = Extract<IssueSourceConfig, { kind: 'github-project' }>;

/** What the office says when gh's token can't read projects. */
export const PROJECT_SCOPE_ERROR = 'GitHub Projects need the read:project scope, which gh hasn’t been given: run `gh auth refresh -s read:project` on the office’s machine, then refresh.';

/** Pages of 100 items it reads at most. */
const PAGES = 5;

const ITEMS = `items(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        isArchived
        updatedAt
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        iteration: fieldValueByName(name: "Iteration") { ... on ProjectV2ItemFieldIterationValue { title } }
        content {
          __typename
          ... on Issue { number title url body state updatedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } }
          ... on PullRequest { number title url body state updatedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } }
          ... on DraftIssue { title body updatedAt assignees(first: 10) { nodes { login } } }
        }
      }
    }`;

/** The query: the project on whichever kind of owner the login is, and who gh is (for @me). */
export const PROJECT_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  viewer { login }
  repositoryOwner(login: $owner) {
    ... on User { projectV2(number: $number) { title url ${ITEMS} } }
    ... on Organization { projectV2(number: $number) { title url ${ITEMS} } }
  }
}`;

export function projectArgs(owner: string, number: number, after?: string): string[] {
  const args = ['api', 'graphql', '-f', `query=${PROJECT_QUERY}`, '-f', `owner=${owner}`, '-F', `number=${number}`];
  if (after) args.push('-f', `after=${after}`);
  return args;
}

/** A gh error about the token's scopes becomes the one telling what to run; the rest stay as they are. */
export function projectError(err: unknown): Error {
  const msg = (err as Error)?.message ?? String(err);
  if (/read:project|INSUFFICIENT_SCOPES|required scopes/i.test(msg)) return new Error(PROJECT_SCOPE_ERROR);
  return err instanceof Error ? err : new Error(msg);
}

/** An item as read, before filtering: whether it's closed, and its iteration, which NormalizedIssue has no place for. */
export type ProjectItem = NormalizedIssue & { closed?: boolean; iteration?: string };

export interface ProjectPage {
  viewer?: string;
  items: ProjectItem[];
  next?: string;
  title?: string;
}

/**
 * One item of a board's answer (an Issue, a PullRequest or a DraftIssue, with its Status and Iteration)
 * as an issue; undefined for an archived one or anything else. `boardUrl` is where a draft, which has
 * no page of its own, points.
 */
export function projectItem(n: any, config: Pick<ProjectConfig, 'id' | 'owner' | 'number'>, boardUrl: string): ProjectItem | undefined {
  if (!n || n.isArchived) return undefined;
  const c = n.content ?? {};
  const kind = c.__typename;
  if (kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'DraftIssue') return undefined;
  if (typeof c.title !== 'string') return undefined;
  const repo: string | undefined = c.repository?.nameWithOwner;
  const key = kind !== 'DraftIssue' && repo && Number.isSafeInteger(c.number) ? ghIssueKey(repo, c.number) : `ghp:${config.owner}/${config.number}#${n.id}`;
  const assignees = (c.assignees?.nodes ?? []).map((a: any) => String(a?.login ?? '')).filter(Boolean);
  const status: string | undefined = n.status?.name ?? undefined;
  return {
    source: 'github-project',
    ...(config.id ? { sourceId: config.id } : {}),
    key,
    title: c.title,
    url: typeof c.url === 'string' ? c.url : boardUrl,
    body: String(c.body ?? '').slice(0, ISSUE_BODY_MAX),
    ...(assignees.length ? { assignee: assignees.join(', ') } : {}),
    labels: (c.labels?.nodes ?? []).map((l: any) => String(l?.name ?? '')).filter(Boolean),
    ...(status ? { status } : {}),
    ...(n.iteration?.title ? { iteration: String(n.iteration.title) } : {}),
    project: `${config.owner}/${config.number}`,
    ...(repo ? { repo } : {}),
    updatedAt: String(c.updatedAt ?? n.updatedAt ?? ''),
    // Closed issues and merged PRs stay on many boards; they're no work to start.
    ...(c.state && c.state !== 'OPEN' ? { closed: true } : {}),
  };
}

/** One page of the query's answer, as issues (unfiltered). Throws on GraphQL errors. */
export function parseProjectPage(out: string, config: Pick<ProjectConfig, 'id' | 'owner' | 'number'>): ProjectPage {
  let raw: any;
  try {
    raw = JSON.parse(out);
  } catch {
    throw new Error('gh gave something that isn’t JSON for the project');
  }
  if (Array.isArray(raw?.errors) && raw.errors.length) throw projectError(new Error(raw.errors.map((e: any) => `${e.type ?? ''} ${e.message ?? ''}`.trim()).join('; ')));
  const owner = raw?.data?.repositoryOwner;
  if (!owner) throw new Error(`There's no GitHub user or organisation called ${config.owner}`);
  const project = owner.projectV2;
  if (!project) throw new Error(`${config.owner} has no project number ${config.number} (or gh can't see it)`);
  const items: ProjectItem[] = [];
  for (const n of project.items?.nodes ?? []) {
    const item = projectItem(n, config, String(project.url ?? `https://github.com/${config.owner}`));
    if (item) items.push(item);
  }
  const info = project.items?.pageInfo;
  return { viewer: raw?.data?.viewer?.login, items, next: info?.hasNextPage ? info.endCursor : undefined, title: project.title };
}

/** The items the source's filters keep: open ones, assigned to whom it says, in the status and iteration it says. */
export function filterProjectItems(items: ProjectItem[], filters: ProjectConfig['filters'], viewer?: string): NormalizedIssue[] {
  const want = filters.assignee === '@me' || filters.assignee === 'me' ? viewer : filters.assignee;
  const lower = (s?: string) => s?.trim().toLowerCase();
  const kept = items.filter((i) => {
    if (i.closed) return false;
    if (filters.assignee && !(i.assignee ?? '').split(', ').some((a) => lower(a) === lower(want))) return false;
    if (filters.status && lower(i.status) !== lower(filters.status)) return false;
    if (filters.iteration && lower(i.iteration) !== lower(filters.iteration)) return false;
    return true;
  });
  return kept.map(({ closed: _c, iteration: _i, ...issue }) => issue);
}

export const githubProjectSource: IssueSource = {
  async list(config, io: IssueSourceIo) {
    const c = config as ProjectConfig;
    const all: ProjectItem[] = [];
    let viewer: string | undefined;
    let after: string | undefined;
    for (let page = 0; page < PAGES; page++) {
      let out: string;
      try {
        out = await io.gh(projectArgs(c.owner, c.number, after), io.cwd, 60_000);
      } catch (err) {
        throw projectError(err);
      }
      const p = parseProjectPage(out, c);
      viewer ??= p.viewer;
      all.push(...p.items);
      if (!p.next) break;
      after = p.next;
    }
    return filterProjectItems(all, c.filters, viewer).slice(0, SOURCE_MAX);
  },
};

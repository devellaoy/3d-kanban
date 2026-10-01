// Actions on one GitHub issue (or pull request), by repository and number, with gh: its comments,
// its assignees, and closing or reopening it. `io.env` is the person's own gh sign-in (none: the
// office's gh, whose comments are then signed). A project's Status column is project-ops.ts.

import type { IssueAssignTo, IssueCommentItem, IssuePerson, IssueTransition } from '../../../../shared/kanban/issueops.js';
import { attribution, type IssueActIo } from './source.js';

const TIMEOUT_MS = 30_000;
/** How many comments one read brings (the newest). */
const COMMENTS = 50;

const run = (io: IssueActIo, args: string[]) => io.gh(args, io.cwd, TIMEOUT_MS, io.env);

/** The ids of GitHub's own moves, next to a project's Status options (`p:…`) and Jira's numbers. */
export const GH_CLOSE = 'gh:close';
export const GH_CLOSE_NOT_PLANNED = 'gh:close:not_planned';
export const GH_REOPEN = 'gh:reopen';

/** What GitHub itself offers for an issue: close it (done, or not planned), or open it again. A PR's state isn't changed here. */
export function ghStateTransitions(closed: boolean, isPr: boolean): IssueTransition[] {
  if (isPr) return [];
  if (closed) return [{ id: GH_REOPEN, name: 'Reopen', to: 'Open', group: 'GitHub' }];
  return [
    { id: GH_CLOSE, name: 'Close (completed)', to: 'Closed', group: 'GitHub' },
    { id: GH_CLOSE_NOT_PLANNED, name: 'Close (not planned)', to: 'Closed (not planned)', group: 'GitHub' },
  ];
}

/** Closes or reopens the issue; resolves to the state it is in now. */
export async function ghStateTransition(io: IssueActIo, repo: string, n: number, id: string, isPr: boolean): Promise<string> {
  if (isPr) throw new Error('Closing or reopening a pull request isn’t done here: use the pull request’s own window');
  const num = String(n);
  if (id === GH_CLOSE || id === GH_CLOSE_NOT_PLANNED) {
    await run(io, ['issue', 'close', num, '-R', repo, '--reason', id === GH_CLOSE ? 'completed' : 'not planned']);
    return id === GH_CLOSE ? 'Closed' : 'Closed (not planned)';
  }
  if (id === GH_REOPEN) {
    await run(io, ['issue', 'reopen', num, '-R', repo]);
    return 'Open';
  }
  throw new Error('That isn’t a way to move this issue');
}

const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { comments(last: ${COMMENTS}) { nodes { id author { login } body createdAt url } } }
      ... on PullRequest { comments(last: ${COMMENTS}) { nodes { id author { login } body createdAt url } } }
    }
  }
}`;

/** The issue's newest 50 comments, oldest first (GraphQL's `last`, so a long thread shows its end). */
export async function ghComments(io: IssueActIo, repo: string, n: number): Promise<IssueCommentItem[]> {
  const [owner, name] = repo.split('/');
  const out = await run(io, ['api', 'graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]);
  let raw: any;
  try {
    raw = JSON.parse(out || '{}');
  } catch {
    throw new Error(`gh gave something that isn't JSON for the comments of ${repo}#${n}`);
  }
  if (Array.isArray(raw?.errors) && raw.errors.length) throw new Error(raw.errors.map((e: any) => e.message ?? '').join('; '));
  const nodes: any[] = raw?.data?.repository?.issueOrPullRequest?.comments?.nodes ?? [];
  return nodes.map((c): IssueCommentItem => ({
    id: String(c.id),
    author: String(c.author?.login ?? 'Someone'),
    body: String(c.body ?? ''),
    createdAt: String(c.createdAt ?? ''),
    ...(typeof c.url === 'string' ? { url: c.url } : {}),
  }));
}

/** Adds a comment; under the office's own gh it is signed with who asked. */
export async function ghComment(io: IssueActIo, repo: string, n: number, text: string): Promise<void> {
  // -f, not -F: a body that starts with "@" is text, not a file.
  const body = io.shared ? `${text.trim()}\n\n${attribution(io.who)}` : text.trim();
  await run(io, ['api', '--method', 'POST', `repos/${repo}/issues/${n}/comments`, '-f', `body=${body}`]);
}

const PEOPLE_QUERY = `query($owner: String!, $name: String!, $q: String) {
  repository(owner: $owner, name: $name) { assignableUsers(query: $q, first: 20) { nodes { login name avatarUrl } } }
}`;

/** Who may be assigned in the repository, GitHub matching `query` against logins and names (so a big organisation's list is complete). */
export async function ghPeople(io: IssueActIo, repo: string, query = ''): Promise<IssuePerson[]> {
  const [owner, name] = repo.split('/');
  const q = query.trim();
  const out = await run(io, ['api', 'graphql', '-f', `query=${PEOPLE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...(q ? ['-f', `q=${q}`] : [])]);
  let raw: any;
  try {
    raw = JSON.parse(out || '{}');
  } catch {
    throw new Error(`gh gave something that isn't JSON for the assignees of ${repo}`);
  }
  if (Array.isArray(raw?.errors) && raw.errors.length) throw new Error(raw.errors.map((e: any) => e.message ?? '').join('; '));
  const nodes: any[] = raw?.data?.repository?.assignableUsers?.nodes ?? [];
  return nodes
    .filter((u) => typeof u?.login === 'string')
    .map((u): IssuePerson => ({ id: u.login, name: String(u.name || u.login), login: u.login, ...(typeof u.avatarUrl === 'string' && u.avatarUrl ? { avatar: u.avatarUrl } : {}) }));
}

/** Whether the issue is open now, from GitHub (the board's copy has no state of its own, and a repository's may be a minute old). Undefined when it can't be told. */
export async function ghIssueState(io: IssueActIo, repo: string, n: number): Promise<'OPEN' | 'CLOSED' | undefined> {
  try {
    const state = String(JSON.parse(await run(io, ['issue', 'view', String(n), '-R', repo, '--json', 'state'])).state ?? '').toUpperCase();
    return state === 'OPEN' || state === 'CLOSED' ? state : undefined;
  } catch {
    return undefined;
  }
}

/** The logins an issue has now (read fresh: the board's list may be a minute old). */
async function currentAssignees(io: IssueActIo, repo: string, n: number): Promise<string[]> {
  const out = await run(io, ['issue', 'view', String(n), '-R', repo, '--json', 'assignees']);
  try {
    return ((JSON.parse(out || '{}').assignees ?? []) as { login?: string }[]).map((a) => String(a.login ?? '')).filter(Boolean);
  } catch {
    throw new Error(`gh gave something that isn't JSON for ${repo}#${n}`);
  }
}

/** Who gh is signed in as, kept per sign-in (a person's gh config dir, or the office's): it doesn't change under a running office. */
const logins = new Map<string, string>();

async function ghLogin(io: IssueActIo): Promise<string> {
  const key = io.env?.GH_CONFIG_DIR ?? 'office';
  const known = logins.get(key);
  if (known) return known;
  const login = (await run(io, ['api', 'user', '--jq', '.login'])).trim();
  if (!login) throw new Error('gh didn’t say who it is signed in as');
  logins.set(key, login);
  return login;
}

/** Makes the asker (`me`), one person, or nobody the issue's only assignee. Resolves to the assignee's login. */
export async function ghAssign(io: IssueActIo, repo: string, n: number, to: IssueAssignTo): Promise<string | undefined> {
  // Under the office's own gh, `me` would be the office's account, not the person.
  if (to && 'me' in to && io.shared) throw new Error('Assign to me needs your own GitHub sign-in: pick a person instead');
  // `me` is whoever gh is signed in as: named, so it isn't removed and added in one go.
  const [want, had] = await Promise.all([to ? ('me' in to ? ghLogin(io) : Promise.resolve(to.id)) : Promise.resolve(undefined), currentAssignees(io, repo, n)]);
  const same = (a: string) => a.toLowerCase() === want?.toLowerCase();
  const args = ['issue', 'edit', String(n), '-R', repo];
  // --flag=value, so a login starting with "-" is never read as a flag.
  for (const login of had) if (!same(login)) args.push(`--remove-assignee=${login}`);
  if (want && !had.some(same)) args.push(`--add-assignee=${want}`);
  if (args.length > 5) await run(io, args);
  return want;
}

/** Takes an open issue nobody has: assigns the signed-in person to it, as taking a card does. Resolves to their login, or undefined when it was closed or had an assignee. */
export async function ghClaimIfUnassigned(io: IssueActIo, repo: string, n: number): Promise<string | undefined> {
  // Read fresh: the list may be minutes old, and a board's copy doesn't say whether the issue is closed.
  const out = await run(io, ['issue', 'view', String(n), '-R', repo, '--json', 'assignees,state']);
  let now: { assignees?: unknown[]; state?: string };
  try {
    now = JSON.parse(out || '{}');
  } catch {
    throw new Error(`gh gave something that isn't JSON for ${repo}#${n}`);
  }
  if (now.assignees?.length || (now.state && now.state.toUpperCase() !== 'OPEN')) return undefined;
  const login = await ghLogin(io);
  await run(io, ['issue', 'edit', String(n), '-R', repo, `--add-assignee=${login}`]);
  return login;
}

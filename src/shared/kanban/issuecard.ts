// An issue card on the 3D office's issues board, wherever it came from: the floor's own GitHub issues
// (upstream's, known by their number) or the project's issue sources (Settings → Issue sources: GitHub
// repositories, a GitHub project, Jira), known by their ticket key (`gh:owner/repo#12`, `ghp:…`,
// `UYT-1415`). Numbers collide across repositories and Jira has none, so a card is told apart by its key
// when it has one. Pure, for the server and the browser alike.

import type { GhIssue } from '../protocol.js';
import type { NormalizedIssue } from './types.js';

/** A card as far as telling it apart goes: a GitHub issue's number (0 for none) and the source's key. */
export interface CardRef {
  /** The GitHub issue number; 0 for a card that isn't a GitHub issue (Jira, a project's draft). */
  number: number;
  key?: string;
  repo?: string;
}

/** The card's identity on the board: its key, else its number. */
export function cardId(it: { number: number; key?: string } | { issue: number; key?: string }): string {
  const n = 'number' in it ? it.number : it.issue;
  return it.key ?? `#${n}`;
}

/** owner/name and number of a GitHub issue's key (`gh:owner/name#12`), else undefined. */
export function parseGhKey(key: string | undefined): { repo: string; number: number } | undefined {
  const m = /^gh:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#(\d{1,12})$/.exec(key ?? '');
  if (!m) return undefined;
  const number = Number(m[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: m[1], number } : undefined;
}

const sameRepo = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether the card is one of the floor's own GitHub issues (upstream's: its number is enough, and
 * `gh issue view <n>` in the floor's checkout finds it).
 */
export function isPrimaryIssue(it: CardRef, primaryRepo: string | undefined): boolean {
  if (!it.number) return false;
  if (!it.key) return !it.repo || sameRepo(it.repo, primaryRepo);
  const gh = parseGhKey(it.key);
  return !!gh && sameRepo(gh.repo, primaryRepo);
}

/** What a card is called: `#12` on the floor's repository, `api#12` in another, the ticket key otherwise. */
export function cardLabel(it: CardRef, primaryRepo?: string): string {
  if (isPrimaryIssue(it, primaryRepo)) return `#${it.number}`;
  const gh = parseGhKey(it.key);
  if (gh) return `${gh.repo.split('/')[1]}#${gh.number}`;
  if (it.key?.startsWith('ghp:')) {
    // ghp:<owner>/<project>#<item>: the item is enough to tell them apart on one board.
    const item = it.key.slice(it.key.lastIndexOf('#') + 1);
    return `draft ${item.length > 10 ? `${item.slice(0, 9)}…` : item}`;
  }
  if (it.key) return it.key;
  return it.repo && !sameRepo(it.repo, primaryRepo) ? `${it.repo.split('/')[1]}#${it.number}` : `#${it.number}`;
}

/** A steady color for a label that came without one (Jira, a GitHub project), as a CSS color. */
export function labelColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 62%)`;
}

/** A small steady number from a card's id, for its tilt on the cork. */
export function cardHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** What picks a note's color, pin and tilt: a GitHub issue's number as upstream, else a hash of its key. */
export function noteSeed(it: { number: number; key?: string }): number {
  return it.number > 0 ? it.number : cardHash(cardId(it));
}

/** How much of a body goes on the board (the task made from a card gets it all). */
export const WALL_BODY = 2000;

/**
 * One issue of a source as a card on the board. A GitHub issue of one of `projectRepos` (owner/name)
 * keeps its number, so upstream's issue window and actions work on it; any other card has 0 and is
 * known by its key (an issue of a repository outside the project too: the office can't open it).
 */
export function toGhIssue(i: NormalizedIssue, taskId?: number, projectRepos: string[] = []): GhIssue {
  const ghKey = parseGhKey(i.key);
  const inProject = !!ghKey && projectRepos.some((r) => r.toLowerCase() === ghKey.repo.toLowerCase());
  const assignees = (i.assignee ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return {
    number: inProject ? ghKey!.number : 0,
    title: i.title,
    // Every source leaves closed or done issues out unless told otherwise; a GitHub issue says which it is.
    state: i.source === 'github-repo' && i.status && i.status !== 'OPEN' ? i.status : 'OPEN',
    url: i.url,
    author: '',
    labels: i.labels.map((name) => ({ name, color: labelColor(name) })),
    assignees,
    createdAt: i.updatedAt,
    updatedAt: i.updatedAt,
    body: i.body.slice(0, WALL_BODY),
    comments: 0,
    ...(i.repo || ghKey ? { repo: i.repo ?? ghKey!.repo } : {}),
    key: i.key,
    source: i.source,
    ...(i.status ? { status: i.status } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

/**
 * The line that makes merging a pull request in `prRepo` close the issue (a GitHub issue's key,
 * `gh:owner/name#12`): `Closes #12` on the issue's own repository, else `Closes owner/name#12`.
 * None for Jira, a project's draft or no ticket.
 */
export function closingRef(ticket: string | undefined, prRepo: string | undefined): string | undefined {
  const gh = parseGhKey(ticket);
  if (!gh) return undefined;
  return sameRepo(gh.repo, prRepo) ? `Closes #${gh.number}` : `Closes ${gh.repo}#${gh.number}`;
}

/**
 * Which of a change's pull requests closes the issue: the one in the issue's own repository, else
 * the one in the project's primary, else the first. None when the ticket isn't a GitHub issue.
 */
export function closingPr<T extends { repo?: string }>(ticket: string | undefined, prs: T[], primaryRepo?: string): T | undefined {
  const gh = parseGhKey(ticket);
  if (!gh || !prs.length) return undefined;
  return prs.find((p) => sameRepo(p.repo, gh.repo)) ?? prs.find((p) => sameRepo(p.repo, primaryRepo)) ?? prs[0];
}

/**
 * The issue a worker was handed by its prompt: the issues board's first line (Work on GitHub issue
 * #12: "Title".) or a "closes #12" in the text. For a worker nothing else says the issue of. `strict`:
 * only the hand-over line, for deciding which issue a pull request closes ("like in PR #45" isn't one).
 */
export function promptIssue(prompt: string | undefined, o: { strict?: boolean } = {}): { number: number; title?: string; repo?: string } | undefined {
  const task = (prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const firstLine = task.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Another repository's card says which: Work on GitHub issue acme/api#7: "Title".
  const issue = /\bissue (?:([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}))?#(\d+):\s*["“](.+?)["”]\.?\s*$/i.exec(firstLine);
  const number = Number((o.strict ? undefined : /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]{0,40}?#(\d+)/i.exec(task)?.[1]) ?? issue?.[2]);
  if (!(number > 0)) return undefined;
  const repo = issue && Number(issue[2]) === number ? issue[1] : undefined;
  return { number, ...(issue?.[3] ? { title: issue[3] } : {}), ...(repo ? { repo } : {}) };
}

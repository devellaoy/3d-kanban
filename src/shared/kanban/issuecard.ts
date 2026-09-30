// An issue card on the 3D office's issues board, wherever it came from: the floor's own GitHub issues
// (upstream's, known by their number) or the project's issue sources (Settings → Issue sources: GitHub
// repositories, a GitHub project, Jira), known by their ticket key (`gh:owner/repo#12`, `ghp:…`,
// `UYT-1415`). Numbers collide across repositories and Jira has none, so a card is told apart by its key
// when it has one. Pure, for the server and the browser alike.

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

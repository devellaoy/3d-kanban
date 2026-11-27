// Which card of the PR board a pull request linked elsewhere (a task's PR) is: the lookup behind open-pull.ts, apart from
// the window so a test can load it.

import type { GhPull } from '../../../shared/protocol';
import { findItem, repoOfItem } from './ghrepo';

/**
 * The board's card (of floor `floor`) for `pr`: its number in its repository, so another repository's same number is not it.
 * `prFloor` is the floor the PR belongs to when known; another floor's PR is on no card of this one.
 * A PR whose repository is not known (neither `repo` nor its URL) is found by number alone.
 */
export function pullOnBoard(items: readonly GhPull[], floor: string | null | undefined, pr: { number: number; url: string; repo?: string }, prFloor?: string): GhPull | undefined {
  if (prFloor && prFloor !== floor) return undefined;
  return findItem(items, pr.number, repoOfItem(pr) || undefined);
}

/** What opening a pull request linked elsewhere in the pull request window takes, at this moment (see openPullFrom). */
export type PullStep =
  /** The floor's board has its card. */
  | { step: 'board'; card: GhPull }
  /** On the PR's floor but its card is not on the board (dropped out of the list, or the list is not read yet): ask the office for the one card. */
  | { step: 'fetch' }
  /** The window reads and acts on the floor the page is on: go to the PR's floor first, then decide again. */
  | { step: 'go'; floor: string }
  /** The window cannot be had: `why` is told, and the PR's own link opens it on its host. */
  | { step: 'host'; why: string };

/**
 * Which way a PR opens: the board's card when this floor has it; another floor's PR after going there (when that floor is
 * open and the page can travel, `canGo`); the one card read from the office when the board lacks it; else not at all (`host`: its link to its host is what is left).
 * `prFloor` is the floor the PR belongs to when known (a task's project).
 */
export function pullStep(items: readonly GhPull[], floor: string | null | undefined, floors: readonly { id: string; name?: string }[], pr: { number: number; url: string; repo?: string }, prFloor: string | undefined, canGo: boolean): PullStep {
  if (prFloor && prFloor !== floor) {
    const there = floors.find((f) => f.id === prFloor);
    if (!there) return { step: 'host', why: 'that project’s floor is not open' };
    if (!canGo) return { step: 'host', why: 'this page cannot go to another floor' };
    return { step: 'go', floor: prFloor };
  }
  const card = pullOnBoard(items, floor, pr, prFloor);
  return card ? { step: 'board', card } : { step: 'fetch' };
}

/** What resolvePull works with: the page as it is at each moment of asking, and the two things that take time. */
export interface PullWays {
  /** The floor the page is on, its board and the open floors, read anew at each step (a trip changes them). */
  page(): { items: readonly GhPull[]; floor: string | null | undefined; floors: readonly { id: string; name?: string }[] };
  /** Takes the page to a floor; false when it did not get there. Absent on a page that cannot travel. */
  go?(floor: string): Promise<boolean>;
  /** The one card, read from the office for the floor the page is on. */
  fetch(): Promise<GhPull>;
}

/**
 * The card to open the pull request window with, by pullStep's steps: after going to the PR's floor when the page is on
 * another, from that floor's board or else read from the office. `why` instead when the window cannot be had, and `stale`
 * when the page left the floor while the card was read (nothing is to open or say then).
 */
export async function resolvePull(pr: { number: number; url: string; repo?: string }, prFloor: string | undefined, ways: PullWays): Promise<{ card: GhPull } | { why: string } | { stale: true }> {
  const decide = (canGo: boolean) => {
    const { items, floor, floors } = ways.page();
    return pullStep(items, floor, floors, pr, prFloor, canGo);
  };
  let step = decide(!!ways.go);
  if (step.step === 'go') {
    if (!(await ways.go!(step.floor))) return { why: 'the page could not get to that project’s floor' };
    // The page is on its floor now: its own board, or the card from the office.
    step = decide(false);
  }
  if (step.step === 'board') return { card: step.card };
  if (step.step !== 'fetch') return { why: step.step === 'host' ? step.why : 'the page could not get to that project’s floor' };
  // The card is read for the floor the page is on, and the window would read and act there: a page that moved on meanwhile
  // (the task closed, another project picked) must not get it, or the floor's own same number would be taken for it.
  const asked = ways.page().floor;
  try {
    const card = await ways.fetch();
    return ways.page().floor === asked ? { card } : { stale: true };
  } catch (err) {
    return ways.page().floor === asked ? { why: `the office could not read it (${(err as Error).message})` } : { stale: true };
  }
}

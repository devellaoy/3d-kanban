// A card taken for work (dropped on a desk, handed to a hired worker, or a queue task seated for it):
// one sequence for all three, so they can't drift. Under the person's own gh the issue is assigned and
// moves to In progress on the project's boards; on the office's gh (nobody's account, or the shared
// password) only the Status moves; an account without a gh sign-in gets neither, only the reason.
import type { Floor } from './floor.js';
import type { GhAs } from './signins.js';

export interface TakenCard {
  /** The issue's number on the floor's repository, or the card's key (an issue-source card). */
  n?: number;
  key?: string;
  /** The account id the worker runs as. */
  owner?: string;
  /** The worker whose pull request closes the issue (`info.issueKey`). */
  workerId?: string;
  /** A queue task seated for it: the task itself is the one being seated, so nothing is taken off the queue. */
  fromQueue?: boolean;
}

/** Resolves to why the issue couldn't be assigned (also given to `say`), or nothing. */
export async function takeCard(floor: Floor, ghAs: (owner: string) => GhAs | string | undefined, card: TakenCard, say?: (text: string) => void): Promise<string | undefined> {
  if (!card.fromQueue) floor.queue.dropIssue(card.n, card.key);
  // The worker's pull request closes the issue it was handed last (see kanban/engine/worker-issue.ts).
  const ref = floor.cardRef(card.n, card.key);
  const info = card.workerId ? floor.workers.get(card.workerId) : undefined;
  if (info && ref) info.issueKey = ref;
  const as = card.owner ? ghAs(card.owner) : undefined;
  const err = typeof as === 'string' ? as : await floor.claimCard(card.n, card.key, as);
  if (err) say?.(`Couldn't assign issue ${card.n !== undefined ? `#${card.n}` : card.key} on GitHub: ${err}`);
  return err;
}

// Where a task's linked pull requests stand in review: the decision (approved, changes requested,
// review required) and how many review threads are unresolved. The floor's PR board brings the
// decision (and the hosted providers' votes); GitHub's unresolved threads come from one GraphQL
// query per repository (up to CHUNK pull requests each), asked on every board pull. Nothing here
// throws: a query that fails leaves what is stored and is asked again at the next pull.

import { reviewOf, type PrReview } from '../../../../shared/kanban/prs.js';
import type { KanbanContext } from '../../registry.js';
import type { GhRunner } from '../issues/source.js';

/** How many pull requests one query asks about. */
const CHUNK = 20;
const TIMEOUT_MS = 10_000;

export interface ReviewTarget {
  taskId: number;
  repoId: string;
  number: number;
  /** owner/name, as the board has the pull request's repository. */
  repo: string;
}

/** The query for these pull requests of `$owner/$name`: only positive integers reach it. */
export function reviewQuery(numbers: number[]): string {
  const ns = numbers.map((n) => Math.trunc(Number(n))).filter((n) => Number.isSafeInteger(n) && n > 0);
  const fields = 'reviewDecision latestOpinionatedReviews(first:30, writersOnly:true){nodes{state}} reviewThreads(first:100){nodes{isResolved}}';
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){ ${ns.map((n) => `p${n}: pullRequest(number:${n}){${fields}}`).join(' ')} }}`;
}

/** The answer of reviewQuery, by pull request number; an alias that is null is left out. */
export function parseReviews(stdout: string): Map<number, { review?: PrReview; unresolved: number }> {
  const out = new Map<number, { review?: PrReview; unresolved: number }>();
  let repo: Record<string, any> | undefined;
  try {
    repo = JSON.parse(stdout)?.data?.repository;
  } catch {
    return out;
  }
  for (const [key, p] of Object.entries(repo ?? {})) {
    const n = /^p(\d+)$/.exec(key)?.[1];
    if (!n || !p || typeof p !== 'object') continue;
    const opinions = ((p.latestOpinionatedReviews?.nodes ?? []) as { state?: unknown }[]).map((x) => String(x?.state));
    const threads = (p.reviewThreads?.nodes ?? []) as { isResolved?: unknown }[];
    out.set(Number(n), { review: reviewOf(typeof p.reviewDecision === 'string' ? p.reviewDecision : undefined, opinions), unresolved: threads.filter((t) => t && t.isResolved === false).length });
  }
  return out;
}

const gone = (err: unknown) => /NOT_FOUND|Could not resolve/i.test(String((err as Error)?.message ?? err));

/** Asks for the marks of GitHub pull requests and stores them. `check` resolves with the ids of the tasks whose marks changed. */
export function reviewChecker(ctx: KanbanContext, run: GhRunner, isStopped: () => boolean = () => false): { check(targets: ReviewTarget[]): Promise<number[]> } {
  let flying = false;
  /** Repositories whose last question failed: said once per streak. */
  const failing = new Set<string>();

  const ask = (owner: string, name: string, numbers: number[]) =>
    run(['api', 'graphql', '-f', `query=${reviewQuery(numbers)}`, '-f', `owner=${owner}`, '-f', `name=${name}`], ctx.dataDir, TIMEOUT_MS);

  async function round(targets: ReviewTarget[], changed: Set<number>): Promise<void> {
    const byRepo = new Map<string, ReviewTarget[]>();
    for (const t of targets) byRepo.set(t.repo.toLowerCase(), [...(byRepo.get(t.repo.toLowerCase()) ?? []), t]);
    for (const [key, all] of byRepo) {
      const [owner, name] = all[0].repo.split('/');
      if (!owner || !name) continue;
      const store = (t: ReviewTarget, marks: { review?: PrReview; unresolved?: number }) => {
        if (!isStopped() && ctx.repo.setPrLinkMarks(t.taskId, t.repoId, t.number, marks)) changed.add(t.taskId);
      };
      const failed = (err: unknown) => {
        if (!failing.has(key)) console.error(`agent-office: reading the review state of ${all[0].repo}'s pull requests failed:`, (err as Error)?.message ?? err);
        failing.add(key);
      };
      for (let i = 0; i < all.length; i += CHUNK) {
        if (isStopped()) return;
        const chunk = all.slice(i, i + CHUNK);
        try {
          const got = parseReviews(await ask(owner, name, chunk.map((t) => t.number)));
          for (const t of chunk) { const m = got.get(t.number); if (m) store(t, m); }
          failing.delete(key);
          continue;
        } catch (err) {
          if (chunk.length === 1 && gone(err)) { store(chunk[0], {}); continue; }
          // One gone PR fails the whole query: ask the rest one at a time.
          if (chunk.length === 1) { failed(err); continue; }
        }
        for (const t of chunk) {
          if (isStopped()) return;
          try {
            const m = parseReviews(await ask(owner, name, [t.number])).get(t.number);
            if (m) store(t, m);
            failing.delete(key);
          } catch (err) {
            if (gone(err)) { store(t, {}); continue; }
            failed(err);
            break;
          }
        }
      }
    }
  }

  return {
    async check(targets) {
      if (flying || !targets.length) return [];
      flying = true;
      const changed = new Set<number>();
      try {
        await round(targets, changed);
      } catch (err) {
        console.error('agent-office: reading the review state of pull requests failed:', err);
      } finally {
        flying = false;
      }
      return [...changed];
    },
  };
}

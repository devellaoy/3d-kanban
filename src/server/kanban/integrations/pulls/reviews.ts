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

/** The query for these pull requests of `$owner/$name`: only positive integers reach it. The newest 100 review threads are read (the likeliest still open): a PR with more may under-count. */
export function reviewQuery(numbers: number[]): string {
  const ns = numbers.map((n) => Math.trunc(Number(n))).filter((n) => Number.isSafeInteger(n) && n > 0);
  const fields = 'reviewDecision latestOpinionatedReviews(first:30, writersOnly:true){nodes{state}} reviewThreads(last:100){nodes{isResolved}}';
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

/** How long a repository's answer stands for the same pull requests: one board cycle pulls a floor several times. */
const RECENT_MS = 30_000;

/**
 * Asks for the marks of GitHub pull requests and stores them; the cards of the tasks whose marks changed are announced
 * (`ctx.taskChanged`, once per task per call, not after a stop). `check` resolves with their ids. A repository is asked
 * about one set of pull requests at a time (another set waits its turn), and not again within RECENT_MS for the same set;
 * other repositories are not held up.
 * `settled` resolves when no call is running (tests).
 */
export function reviewChecker(ctx: KanbanContext, run: GhRunner, isStopped: () => boolean = () => false, now: () => number = Date.now): { check(targets: ReviewTarget[]): Promise<number[]>; settled(): Promise<void> } {
  /** What is being asked or waits its turn, by repository (lower-cased owner/name): the pull request sets, and the last question's end. */
  const flying = new Map<string, { sigs: Set<string>; tail: Promise<unknown> }>();
  /** When a repository was last asked successfully, and for which pull requests. */
  const asked = new Map<string, { at: number; sig: string }>();
  const rounds = new Set<Promise<unknown>>();
  /** Repositories whose last question failed: said once per streak. */
  const failing = new Set<string>();

  const ask = (owner: string, name: string, numbers: number[]) =>
    run(['api', 'graphql', '-f', `query=${reviewQuery(numbers)}`, '-f', `owner=${owner}`, '-f', `name=${name}`], ctx.dataDir, TIMEOUT_MS);

  /** One repository's pull requests; whether every question was answered. */
  async function repoRound(key: string, all: ReviewTarget[], changed: Set<number>): Promise<boolean> {
    const [owner, name] = all[0].repo.split('/');
    if (!owner || !name) return true;
    let ok = true;
    const store = (t: ReviewTarget, marks: { review?: PrReview; unresolved?: number }) => {
      if (!isStopped() && ctx.repo.setPrLinkMarks(t.taskId, t.repoId, t.number, marks)) changed.add(t.taskId);
    };
    const failed = (err: unknown) => {
      ok = false;
      if (!failing.has(key)) console.error(`agent-office: reading the review state of ${all[0].repo}'s pull requests failed:`, (err as Error)?.message ?? err);
      failing.add(key);
    };
    for (let i = 0; i < all.length; i += CHUNK) {
      if (isStopped()) return false;
      const chunk = all.slice(i, i + CHUNK);
      try {
        const got = parseReviews(await ask(owner, name, chunk.map((t) => t.number)));
        for (const t of chunk) { const m = got.get(t.number); if (m) store(t, m); }
        failing.delete(key);
        continue;
      } catch (err) {
        if (chunk.length === 1 && gone(err)) { store(chunk[0], {}); continue; }
        if (chunk.length === 1) { failed(err); continue; }
      }
      // One gone PR fails the whole query: ask the rest one at a time.
      for (const t of chunk) {
        if (isStopped()) return false;
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
    return ok;
  }

  return {
    check(targets) {
      const byRepo = new Map<string, ReviewTarget[]>();
      for (const t of targets) byRepo.set(t.repo.toLowerCase(), [...(byRepo.get(t.repo.toLowerCase()) ?? []), t]);
      const at = now();
      const mine: [string, ReviewTarget[], string][] = [];
      for (const [key, all] of byRepo) {
        const sig = all.map((t) => t.number).sort((a, b) => a - b).join(',');
        const last = asked.get(key);
        const f = flying.get(key) ?? { sigs: new Set<string>(), tail: Promise.resolve() };
        if (f.sigs.has(sig) || (last && last.sig === sig && at - last.at < RECENT_MS)) continue;
        f.sigs.add(sig);
        flying.set(key, f);
        mine.push([key, all, sig]);
      }
      if (!mine.length) return Promise.resolve([]);
      const changed = new Set<number>();
      // Each repository in its turn after whoever asks about it now (another project's pull requests in the same repository).
      const jobs = mine.map(([key, all, sig]) => {
        const f = flying.get(key)!;
        const job = f.tail
          .then(() => repoRound(key, all, changed))
          .then((ok) => { if (ok) asked.set(key, { at: now(), sig }); })
          .catch((err) => console.error('agent-office: reading the review state of pull requests failed:', err))
          .finally(() => { f.sigs.delete(sig); if (!f.sigs.size) flying.delete(key); });
        f.tail = job;
        return job;
      });
      const p: Promise<number[]> = Promise.all(jobs).then(() => {
        if (!isStopped()) for (const id of changed) ctx.taskChanged(id);
        return [...changed];
      });
      rounds.add(p);
      void p.finally(() => rounds.delete(p));
      return p;
    },
    async settled() {
      while (rounds.size) await Promise.allSettled([...rounds]);
    },
  };
}

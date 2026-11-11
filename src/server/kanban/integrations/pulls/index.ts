// Pull requests across a project's repositories: the bundle that belongs together (a task's, a
// branch's, a ticket's), a review of several PRs at once (checked here, run by the engine as a task
// of its own: KanbanEngineApi.reviewPrs), the same PRs to the floor's meeting room as upstream's
// 🤝 review panel, and the states of the tasks' linked PRs kept up with the floor's PR board. The
// board itself lists every repository (Floor.pullsState); this reads the same lists, or asks gh when
// the floor is closed.

import type { KanbanCaller, KanbanContext, KanbanPlugin, KanbanPullsApi } from '../../registry.js';
import type { KanbanEffort, KanbanTask, KanbanPrBundleItem, KanbanPrBundleKey, KanbanPrReviewRequest, PrRef, ProjectRepo } from '../../../../shared/kanban/types.js';
import { canFixPrs } from '../../../../shared/kanban/prs.js';
import { PR_REVIEW_MAX } from '../../../../shared/kanban/types.js';
import type { AgentEffort, GhPull, MeetingRequest } from '../../../../shared/protocol.js';
import { sameRepo } from '../../../../shared/floors.js';
import { prWebUrl, repoRefOf } from '../../../../shared/hosting/remote.js';
import { resolveKanbanPrompt, withContract } from '../../../../shared/kanban/prompts.js';
import { gh } from '../../../github.js';
import { hostedDefaultBranch, hostedIsFork, hostedRepoOf, hostedView } from '../../../hosting/board.js';
import { floorPullsListeners, type PulledFloor } from './board.js';
import type { GhRunner } from '../issues/source.js';
import { fail, ok } from '../util.js';
import { forkTest, polledPulls } from './prfix.js';
import { checkClosing, type ClosingMark } from './closes.js';
import { branchOwners, branchPrs, findBundle, findTaskPrs, sharedBranch, prOwners, prState, type BundleBy, type FoundList, type FoundPr, type RepoPulls } from './bundle.js';

const FIELDS = 'number,title,url,state,isDraft,headRefName';
/** What Find PRs lists: the fork flag and the date too. */
const FIND_FIELDS = `${FIELDS},createdAt,isCrossRepository`;
/**
 * The browser gives up on a request at 30 s, so Find waits at most FIND_TIMEOUT_MS for the lists and
 * then ASK_TIMEOUT_MS for the follow-up questions (fork, default branch): 18 s in all. A kanban.pr.link
 * reads its PRs in parallel, each bounded by FIND_TIMEOUT_MS.
 */
const FIND_TIMEOUT_MS = 10_000;
const ASK_TIMEOUT_MS = 8_000;
/** How many of a task's newest events are read for its unlinks (TASK_EVENTS_CAP keeps 2000 at most). */
const UNLINK_EVENTS = 500;

/** `p`, or a rejection when it has no answer in `ms` (what is asked goes on, only the waiting stops). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('no answer in time')), ms)))]).finally(() => clearTimeout(timer));
}

/** Why gh couldn't give a PR, in a few words: "not found" when its error says there is no such PR. */
function ghWhy(err: unknown): { missing: boolean; text: string } {
  const text = (err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? 'no reason given';
  return { missing: /could not resolve to a pull ?request|no pull requests? found|not found|404/i.test(text), text: text.slice(0, 120) };
}

/** A PR as a review names it, with what its list says about it. */
export type ReviewPr = PrRef & { title?: string; url?: string; branch?: string };

export interface PullsOptions {
  gh?: GhRunner;
  /** One pull request on Azure DevOps or Bitbucket, from its provider (tests stub it). */
  viewHosted?: typeof hostedView;
  /** The clock, for the back-off after a failed gh question. */
  now?: () => number;
}

/** How long a gh question that failed isn't asked again, and how many answers are kept. */
const ASK_BACKOFF_MS = 5 * 60_000;
const ASK_KEPT = 2000;

/** A project's GitHub repositories: owner/name and ProjectRepo. */
function githubRepos(ctx: KanbanContext, project: string): (ProjectRepo & { remote: string })[] {
  return ctx.repos(project).filter((r): r is ProjectRepo & { remote: string } => r.kind === 'git' && !!r.remote);
}

/** Claude takes low…max; the kanban's `minimal` is Codex's. */
function claudeEffort(e: KanbanEffort | undefined): AgentEffort | undefined {
  if (!e) return undefined;
  return e === 'minimal' ? 'low' : e;
}

/** A pull request that's still to be looked at: not merged, not closed. */
const isOpen = (p: { state: string }) => p.state !== 'MERGED' && p.state !== 'CLOSED';

export function createPullsParts(ctx: KanbanContext, opts: PullsOptions = {}) {
  const now = opts.now ?? Date.now;
  const viewHosted = opts.viewHosted ?? hostedView;
  const runGh = opts.gh ?? ((args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => gh(args, cwd, timeout, env));

  /** A repository's PRs: the open floor's board list when it has one, else straight from gh. */
  const listPulls = async (project: string, r: ProjectRepo & { remote: string }): Promise<RepoPulls> => {
    const board = ctx.floor(project)?.githubFor(r.remote);
    if (board && board.pulls.fetchedAt > 0 && !board.pulls.error) return { repo: r.remote, repoId: r.id, pulls: board.pulls.items };
    // A repository on Azure DevOps or Bitbucket with no board list yet: none listed (a listing there is
    // a request per pull request), so the task's linked PRs stand (findBundle) and a picked one is read alone (checkReview).
    if (hostedRepoOf(r.remote)) return { repo: r.remote, repoId: r.id, pulls: [] };
    const out = await runGh(['pr', 'list', '-R', r.remote, '--state', 'all', '--limit', '100', '--json', FIELDS], ctx.dataDir);
    const raw = JSON.parse(out || '[]') as GhPull[];
    return { repo: r.remote, repoId: r.id, pulls: Array.isArray(raw) ? raw.filter((p) => Number.isSafeInteger(p?.number)) : [] };
  };

  /** The bundle: open and draft PRs only, unless `includeClosed` (a merged one needs no more review or fixing). */
  const bundleItems = async (project: string, by: BundleBy, includeClosed = false): Promise<KanbanPrBundleItem[] | string> => {
    if (!ctx.project(project)) return `There's no project ${project}`;
    const repos = githubRepos(ctx, project);
    if (!repos.length) return 'None of the project’s repositories has a remote on GitHub, Azure DevOps or Bitbucket';
    let task: Parameters<typeof findBundle>[2];
    if (by.taskId !== undefined) {
      const t = ctx.repo.getTask(by.taskId);
      if (!t || t.project !== project) return `There's no task #${by.taskId} in this project`;
      task = { ...t, branches: ctx.repo.repoBranches(t.id) };
    }
    const settled = await Promise.allSettled(repos.map((r) => listPulls(project, r)));
    const lists = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    if (!lists.length && settled[0]?.status === 'rejected') return (settled[0].reason as Error).message;
    const all = findBundle(lists, by, task, (repo, number) => ctx.repo.tasksOfPr(repo, number)[0]);
    return includeClosed ? all : all.filter(isOpen);
  };

  /**
   * Checks a review request: the project is there, its PRs are its repositories' (each named once,
   * PR_REVIEW_MAX at most) and there, the task is the project's. Resolves to the PRs as the project
   * names their repositories, with their titles, URLs and branches, or to why not.
   */
  const checkReview = async (req: KanbanPrReviewRequest): Promise<{ prs: ReviewPr[] } | string> => {
    if (!ctx.project(req.project)) return `There's no project ${req.project}`;
    if (!Array.isArray(req.prs) || !req.prs.length) return 'Pick at least one pull request';
    if (req.prs.length > PR_REVIEW_MAX) return `A review takes at most ${PR_REVIEW_MAX} pull requests`;
    if (req.taskId !== undefined) {
      const t = ctx.repo.getTask(req.taskId);
      if (!t || t.project !== req.project) return `There's no task #${req.taskId} in this project`;
      if (t.status === 'on_hold') return `Task #${t.id} is on hold: resume it first`;
    }
    const repos = githubRepos(ctx, req.project);
    const out: ReviewPr[] = [];
    const seen = new Set<string>();
    const lists = new Map<string, RepoPulls | undefined>();
    for (const pr of req.prs) {
      if (!Number.isSafeInteger(pr?.number) || pr.number <= 0) return 'A pull request needs its number';
      const r = repos.find((x) => sameRepo(x.remote, pr.repo));
      if (!r) return `${pr.repo} isn't one of the project's repositories${repos.length ? ` (${repos.map((x) => x.remote).join(', ')})` : ''}`;
      const key = `${r.id}#${pr.number}`;
      if (seen.has(key)) return `${r.remote}#${pr.number} is picked twice`;
      seen.add(key);
      if (!lists.has(r.id)) lists.set(r.id, await listPulls(req.project, r).catch(() => undefined));
      let found = lists.get(r.id)?.pulls.find((p) => p.number === pr.number);
      // Not in the list (it's capped, or couldn't be read): asked for on its own, as gh is below.
      const hosted = found ? undefined : hostedRepoOf(r.remote);
      if (hosted) {
        try {
          const v = await viewHosted(hosted, pr.number);
          found = { number: v.number, title: v.title, url: v.url, state: v.state, isDraft: v.isDraft, headRefName: v.headRefName } as GhPull;
        } catch {
          return `${r.remote} has no pull request #${pr.number}`;
        }
      }
      if (!found) {
        try {
          found = JSON.parse(await runGh(['pr', 'view', String(pr.number), '-R', r.remote, '--json', FIELDS], ctx.dataDir)) as GhPull;
        } catch {
          return `${r.remote} has no pull request #${pr.number}`;
        }
      }
      out.push({ repo: r.remote, number: pr.number, ...(found?.title ? { title: found.title } : {}), ...(found?.url ? { url: found.url } : {}), ...(found?.headRefName ? { branch: found.headRefName } : {}) });
    }
    return { prs: out };
  };

  /** The panel brief's variables: the PRs, the project, the task (the engine words its own review's prompt). */
  const reviewVars = (req: KanbanPrReviewRequest, prs: ReviewPr[]) => {
    const def = ctx.project(req.project);
    const task = req.taskId !== undefined ? ctx.repo.getTask(req.taskId) : undefined;
    return {
      prs: prs.map((p) => `- ${p.repo}#${p.number}${p.title ? ` “${p.title}”` : ''}${p.branch ? ` (branch ${p.branch})` : ''}${p.url ? ` ${p.url}` : ''}`).join('\n'),
      project: def?.name ?? req.project,
      task: task ? `They are kanban task #${task.id}'s: ${task.title}${task.ticket ? ` (${task.ticket})` : ''}` : '',
    };
  };

  const review = async (req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId?: string } | string> => {
    const checked = await checkReview(req);
    if (typeof checked === 'string') return checked;
    const { panel: _, ...rest } = req;
    // The PRs as checked (titles, URLs and branches along), for the engine's prompt.
    return ctx.engine.reviewPrs({ ...rest, prs: checked.prs }, who);
  };

  /**
   * Upstream's meeting room takes one pull request, of the floor's own repository: its reviewers
   * read it with gh in the floor's checkout, and the combined review is posted on it. So the panel
   * gets one of the picked PRs from there, and its brief (the meeting's prompt) lists every PR, so
   * the table reviews them as one change set.
   */
  const panel = async (req: KanbanPrReviewRequest, who: KanbanCaller): Promise<string | void> => {
    if (!ctx.project(req.project)) return `There's no project ${req.project}`;
    const floor = ctx.floor(req.project);
    if (!floor) return "The project's floor isn't open, so there's no meeting room for a panel";
    const checked = await checkReview(req);
    if (typeof checked === 'string') return checked;
    const primary = ctx.repos(req.project).find((r) => r.primary);
    const home = primary?.kind === 'git' ? primary.remote : undefined;
    const posted = home ? checked.prs.find((p) => sameRepo(p.repo, home)) : undefined;
    if (!home || !posted) return `A review panel posts its review on a pull request of the project's own repository${home ? ` (${home})` : ''}: pick one there too, or use 🔍 Review for these`;
    if (req.tool && !floor.project.agentProviders.includes(req.tool)) return `${req.tool} isn't set up on this office`;
    const request: MeetingRequest = {
      pattern: 'review',
      // The brief is the layered kanban.pr.panel prompt (default → office → project), editable like the others, sealed with the panel contract.
      prompt: withContract(resolveKanbanPrompt('kanban.pr.panel', { office: ctx.officePrompts(), project: ctx.settings.project(req.project).prompts }, { ...reviewVars(req, checked.prs), posted: String(posted.number), postedRepo: posted.repo }), 'panel'),
      title: `Review of ${checked.prs.map((p) => `${p.repo}#${p.number}`).join(', ')}`.slice(0, 100),
      roles: [],
      pr: posted.number,
      ...(req.tool ? { provider: req.tool, ...(req.tool === 'claude' ? { model: req.model, effort: claudeEffort(req.effort) } : {}) } : {}),
    };
    const err = floor.meetings.start(request, who.name, who.accountId);
    if (err) return err;
    const task = req.taskId !== undefined ? ctx.repo.getTask(req.taskId) : undefined;
    if (task) {
      const names = checked.prs.map((p) => `${p.repo}#${p.number}`);
      ctx.repo.addComment({ taskId: task.id, authorKind: 'system', authorName: 'Kanban', kind: 'status', text: `${who.name} called a 🤝 review panel on ${names.join(', ')} (its review goes on ${posted.repo}#${posted.number})` });
      ctx.repo.appendEvent(task.id, 'pr.panel', { by: who.name, prs: names });
      ctx.taskChanged(task.id);
    }
  };

  /**
   * A gh question asked once per key: its answer kept (the newest ASK_KEPT), a question in flight
   * shared, a failure (or no answer) not asked again for ASK_BACKOFF_MS. Resolves to undefined
   * when there is no answer.
   */
  const asked = <T>(ask: (key: string) => Promise<T | undefined>) => {
    const known = new Map<string, T>();
    const flying = new Map<string, Promise<T | undefined>>();
    const failed = new Map<string, number>();
    return {
      get(key: string): Promise<T | undefined> {
        if (known.has(key)) return Promise.resolve(known.get(key));
        const going = flying.get(key);
        if (going) return going;
        const at = failed.get(key);
        if (at !== undefined && now() - at < ASK_BACKOFF_MS) return Promise.resolve(undefined);
        const p = ask(key)
          .catch(() => undefined)
          .then((v) => {
            if (v === undefined) failed.set(key, now());
            else {
              failed.delete(key);
              known.set(key, v);
              if (known.size > ASK_KEPT) known.delete(known.keys().next().value!);
            }
            flying.delete(key);
            return v;
          });
        flying.set(key, p);
        return p;
      },
      clear() {
        known.clear();
        flying.clear();
        failed.clear();
      },
    };
  };
  /** Whether a PR's head is in another repository (a fork); that never changes. Key: owner/name#number, lower-cased. */
  const forks = asked(async (key) => {
    const at = key.lastIndexOf('#');
    const hosted = hostedRepoOf(key.slice(0, at));
    if (hosted) return hostedIsFork(hosted, Number(key.slice(at + 1)));
    const v = (JSON.parse(await runGh(['pr', 'view', key.slice(at + 1), '-R', key.slice(0, at), '--json', 'isCrossRepository'], ctx.dataDir, ASK_TIMEOUT_MS)) as { isCrossRepository?: unknown }).isCrossRepository;
    return typeof v === 'boolean' ? v : undefined;
  });
  /** A repository's default branch, by gh. Key: owner/name, lower-cased. */
  const defaultBranches = asked(async (repo) => {
    const hosted = hostedRepoOf(repo);
    if (hosted) return hostedDefaultBranch(hosted);
    return (await runGh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], ctx.dataDir, ASK_TIMEOUT_MS)).trim() || undefined;
  });
  /** The PRs already looked at for their issue's closing line (see checkClosing), by URL. */
  const closingChecked = new Map<string, ClosingMark>();
  let stopped = false;

  /**
   * Whether the user took this PR off the task and nothing linked it again since: its last
   * `pr.linked` / `pr.unlinked` event is the unlink. Only the newest UNLINK_EVENTS events are read; an
   * unlink older than that is forgotten, and the branch sync may link the PR again.
   */
  const unlinked = (taskId: number, repo: string, number: number): boolean => {
    let last: string | undefined;
    for (const e of ctx.repo.listEvents(taskId, UNLINK_EVENTS)) {
      const d = e.data as { repo?: unknown; number?: unknown } | undefined;
      if ((e.kind === 'pr.linked' || e.kind === 'pr.unlinked') && d?.number === number && typeof d.repo === 'string' && sameRepo(d.repo, repo)) last = e.kind;
    }
    return last === 'pr.unlinked';
  };

  /**
   * A floor's PR board has fresh lists: its tasks' linked PRs take the states GitHub has for them
   * now (a PR is matched by repository and number, else by URL), and the open PRs from an active
   * task's branch that no task of any project has linked yet are linked to it (branchPrs: whatever
   * phase opened them, however the agent worded its answer), once gh says the head isn't a fork's
   * nor the repository's default branch (a repository gh can't answer for waits for the next
   * sync) and the user hasn't unlinked it from the task (only 🔎 Find PRs or Link selected brings
   * it back). Each such link is an event on the task. The browsers hear about the cards that changed.
   * Returns those tasks' ids.
   */
  const syncPrStates = async (project: string, pulls: (Pick<GhPull, 'number' | 'url' | 'state' | 'isDraft' | 'repo'> & { headRefName?: string; createdAt?: string; isCrossRepository?: boolean })[]): Promise<number[]> => {
    if (!pulls.length) return [];
    const links = ctx.repo.prLinksOfProject(project);
    const reposMemo = new Map<string, ProjectRepo[]>();
    const reposOf = (proj: string) => reposMemo.get(proj) ?? (reposMemo.set(proj, ctx.repos(proj)), reposMemo.get(proj)!);
    const repos = reposOf(project);
    const home = repos.find((r) => r.primary)?.remote;
    const remoteOf = (repoId: string) => repos.find((r) => r.id === repoId)?.remote;
    const changed = new Set<number>();
    for (const l of links) {
      const repo = l.repo ?? remoteOf(l.repoId);
      const p = pulls.find((x) => x.number === l.number && !!repo && sameRepo(x.repo ?? home, repo)) ?? pulls.find((x) => !!l.url && x.url === l.url);
      if (!p) continue;
      if (ctx.repo.setPrLinkState(l.taskId, l.repoId, l.number, prState(p))) changed.add(l.taskId);
    }
    // Some task's already, in any project: a link names its repository, or only its repoId, or its URL (prOwners).
    const linked = (pr: { repo: string; number: number; url: string }) => prOwners(ctx.repo.prLinksMatching(pr.number, pr.url), (proj, repoId) => reposOf(proj).find((r) => r.id === repoId)?.remote, pr).length > 0;
    const candidates = branchPrs(project, () => ctx.repo.activeTaskBranches(), pulls, reposOf, home, linked).filter((b) => !unlinked(b.taskId, b.repo, b.pull.number));
    const own = await Promise.all(
      candidates.map(async (b) => {
        const [fork, base] = await Promise.all([forks.get(`${b.repo.toLowerCase()}#${b.pull.number}`), defaultBranches.get(b.repo.toLowerCase())]);
        return fork === false && base !== undefined && base !== b.branch ? b : undefined;
      }),
    );
    if (stopped) return [...changed];
    for (const b of own) {
      if (!b || linked({ repo: b.repo, number: b.pull.number, url: b.pull.url })) continue;
      ctx.repo.upsertPrLink(b.taskId, { repoId: b.repoId, repo: b.repo, number: b.pull.number, url: b.pull.url, state: prState(b.pull), branch: b.branch });
      ctx.repo.appendEvent(b.taskId, 'pr.linked', { repo: b.repo, number: b.pull.number, by: 'branch' });
      changed.add(b.taskId);
    }
    for (const id of changed) ctx.taskChanged(id);
    checkClosing(ctx, project, closingChecked, { run: runGh, defaultBranch: (repo) => defaultBranches.get(repo) });
    return [...changed];
  };

  /** The task a PR-by-task message names, with its project's repositories; or why not. */
  const taskOf = (project: string, taskId: number): { task: KanbanTask; repos: (ProjectRepo & { remote: string })[] } | string => {
    if (!ctx.project(project)) return `There's no project ${project}`;
    const task = ctx.repo.getTask(taskId);
    if (!task || task.project !== project) return `There's no task #${taskId} in this project`;
    const repos = githubRepos(ctx, project);
    if (!repos.length) return 'None of the project’s repositories has a remote on GitHub, Azure DevOps or Bitbucket';
    return { task, repos };
  };
  /** The tasks (of any project) a PR is linked to. */
  const ownersOf = (pr: { repo: string; number: number; url: string }) => prOwners(ctx.repo.prLinksMatching(pr.number, pr.url), (proj, repoId) => ctx.repos(proj).find((r) => r.id === repoId)?.remote, pr);
  /**
   * The task's own link that a new one to `remote`#`number` would overwrite though it names another
   * repository (links are keyed by repoId and number, and a repository's remote can change): why the
   * new one isn't written, or undefined when there is no such link.
   */
  const clash = (taskId: number, repoId: string, remote: string, number: number, url: string): string | undefined => {
    const l = ctx.repo.getTask(taskId)?.prs.find((x) => x.repoId === repoId && x.number === number);
    if (!l || (l.repo ? sameRepo(l.repo, remote) : !l.url || l.url === url)) return undefined;
    return `the task has a link to ${l.repo ? `${l.repo}#${number}` : l.url} from before the repository's remote changed: unlink that one first`;
  };

  /**
   * A repository's PRs of any state, asked fresh: gh's newest 100 plus, for the task's `branch`, the
   * ones from that head (the plain list is capped). A repository on Azure DevOps or Bitbucket has
   * the floor board's list, or none to give. Rejects with the reason, worded for the user; when only
   * one of the two asks failed, the other's PRs come back with a note on what is missing.
   */
  const freshList = async (project: string, r: ProjectRepo & { remote: string }, branch: string | undefined): Promise<{ list: FoundList; notes: string[] }> => {
    const base = { repo: r.remote, repoId: r.id, primary: r.primary };
    if (hostedRepoOf(r.remote)) {
      const board = ctx.floor(project)?.githubFor(r.remote);
      if (board && board.pulls.fetchedAt > 0 && !board.pulls.error) return { list: { ...base, pulls: board.pulls.items }, notes: [] };
      throw new Error(`${r.remote}: pull requests couldn't be listed here`);
    }
    const ask = async (extra: string[]): Promise<GhPull[]> => {
      const raw = JSON.parse((await runGh(['pr', 'list', '-R', r.remote, '--state', 'all', ...extra, '--json', FIND_FIELDS], ctx.dataDir, FIND_TIMEOUT_MS)) || '[]') as GhPull[];
      return Array.isArray(raw) ? raw.filter((p) => Number.isSafeInteger(p?.number)) : [];
    };
    const [all, head] = await Promise.allSettled([ask(['--limit', '100']), branch ? ask(['--head', branch, '--limit', '100']) : Promise.resolve([])]);
    if (all.status === 'rejected' && (!branch || head.status === 'rejected')) throw new Error(`${r.remote}: ${(all.reason as Error).message}`);
    const pulls = new Map<number, GhPull>();
    for (const s of [all, head]) if (s.status === 'fulfilled') for (const p of s.value) pulls.set(p.number, p);
    const why = (x: PromiseRejectedResult) => (x.reason as Error).message;
    const notes: string[] = [];
    if (head.status === 'rejected') notes.push(`${r.remote}: the pull requests of branch ${branch} couldn't be listed (${why(head)}), so one outside the newest 100 may be missing`);
    if (all.status === 'rejected') notes.push(`${r.remote}: the newest pull requests couldn't be listed (${why(all)}), so ones that only mention the ticket may be missing`);
    return { list: { ...base, pulls: [...pulls.values()] }, notes };
  };

  /**
   * Whether a PR on the task's branch is surely the task's own: not from a fork (the list says, else gh
   * is asked), not on the default branch (one gh can't answer for isn't linked). Else why not. The
   * answers are waited for ASK_TIMEOUT_MS at most.
   */
  const sureOwn = async (b: FoundPr): Promise<string | undefined> => {
    let late = false;
    const soon = <T>(p: Promise<T | undefined>) => within(p, ASK_TIMEOUT_MS).catch(() => ((late = true), undefined));
    const known = b.pull.isCrossRepository;
    const [fork, base] = await Promise.all([typeof known === 'boolean' ? known : soon(forks.get(`${b.repo.toLowerCase()}#${b.pull.number}`)), soon(defaultBranches.get(b.repo.toLowerCase()))]);
    if (fork === true) return 'it comes from a fork';
    if (late) return "it couldn't be confirmed in time that it isn't a fork's or on the default branch";
    if (fork === undefined || base === undefined) return "GitHub didn't say whether it comes from a fork or the default branch";
    return base === b.pull.headRefName ? `its branch ${base} is the repository's default branch` : undefined;
  };

  const find = async (c: KanbanCaller, m: { project: string; taskId: number }): Promise<{ linked: PrRef[]; candidates: KanbanPrBundleItem[]; skipped: { repo: string; number: number; reason: string }[]; notes: string[] } | string> => {
    const got = taskOf(m.project, m.taskId);
    if (typeof got === 'string') return got;
    const { task, repos } = got;
    const branches = { ...ctx.repo.repoBranches(task.id) };
    const settled = await Promise.allSettled(repos.map((r) => freshList(m.project, r, branches[r.id] ?? (r.primary ? task.branch : undefined))));
    const lists: FoundList[] = [];
    const notes: string[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') (lists.push(s.value.list), notes.push(...s.value.notes));
      else notes.push((s.reason as Error).message);
    }
    const changed = new Set<number>();
    // The states of what is linked already, from the fresh lists.
    for (const l of task.prs) {
      // By the repository the link names (its remote may have changed since), else by URL, as syncPrStates does.
      const repo = l.repo ?? repos.find((r) => r.id === l.repoId)?.remote;
      const p = lists.flatMap((x) => (repo && sameRepo(x.repo, repo) ? x.pulls.filter((y) => y.number === l.number) : [])).at(0) ?? lists.flatMap((x) => x.pulls).find((y) => !!l.url && y.url === l.url);
      if (p && ctx.repo.setPrLinkState(task.id, l.repoId, l.number, prState(p))) changed.add(task.id);
    }
    const owners = branchOwners(ctx.repo.activeTaskBranches(), (proj) => ctx.repos(proj));
    const { byBranch, sharedBranch: shared, byTicket, skipped } = findTaskPrs(lists, { ...task, branches }, ownersOf, (repo, branch) => sharedBranch(owners, task.id, repo, branch));
    const linked: PrRef[] = [];
    // A branch match is the task's own when it is open, or was made after the task; an older closed one
    // (a reused or long-lived branch like staging has many) is only offered, with the ticket's.
    const mine = (b: FoundPr) => isOpen(b.pull) || Date.parse(b.pull.createdAt ?? '') >= task.createdAt;
    const direct = byBranch.filter(mine);
    const older = byBranch.filter((b) => !mine(b));
    const why = await Promise.all(direct.map(sureOwn));
    for (const [i, b] of direct.entries()) {
      if (why[i]) skipped.push({ repo: b.repo, number: b.pull.number, reason: why[i]! });
      else if (ownersOf({ repo: b.repo, number: b.pull.number, url: b.pull.url }).length) skipped.push({ repo: b.repo, number: b.pull.number, reason: 'it was linked to a task just now' });
      else if (clash(task.id, b.repoId, b.repo, b.pull.number, b.pull.url)) skipped.push({ repo: b.repo, number: b.pull.number, reason: clash(task.id, b.repoId, b.repo, b.pull.number, b.pull.url)! });
      else {
        ctx.repo.upsertPrLink(task.id, { repoId: b.repoId, repo: b.repo, number: b.pull.number, url: b.pull.url, state: prState(b.pull), branch: b.pull.headRefName });
        ctx.repo.appendEvent(task.id, 'pr.linked', { repo: b.repo, number: b.pull.number, by: 'find', who: c.name });
        linked.push({ repo: b.repo, number: b.pull.number });
        changed.add(task.id);
      }
    }
    if (changed.size) ctx.taskChanged(task.id);
    const candidates = [...older, ...shared, ...byTicket].map((t): KanbanPrBundleItem => ({ repo: t.repo, number: t.pull.number, url: t.pull.url, title: t.pull.title, state: prState(t.pull), ...(t.pull.headRefName ? { branch: t.pull.headRefName } : {}), repoId: t.repoId }));
    return { linked, candidates, skipped, notes };
  };

  /** A PR picked by hand, as its repository has it now; or why it can't be linked to `taskId`. */
  const pickPr = async (repos: (ProjectRepo & { remote: string })[], taskId: number, pr: PrRef): Promise<{ repo: ProjectRepo & { remote: string }; pull: GhPull } | string> => {
    const repo = repos.find((x) => sameRepo(x.remote, pr.repo));
    if (!repo) return `${pr.repo} isn't one of the project's repositories${repos.length ? ` (${repos.map((x) => x.remote).join(', ')})` : ''}`;
    let pull: GhPull;
    try {
      const hosted = hostedRepoOf(repo.remote);
      if (hosted) {
        const v = await within(viewHosted(hosted, pr.number), FIND_TIMEOUT_MS);
        pull = { number: v.number, title: v.title, url: v.url, state: v.state, isDraft: v.isDraft, headRefName: v.headRefName } as GhPull;
      } else pull = JSON.parse(await runGh(['pr', 'view', String(pr.number), '-R', repo.remote, '--json', FIELDS], ctx.dataDir, FIND_TIMEOUT_MS)) as GhPull;
    } catch (err) {
      const why = ghWhy(err);
      return why.missing ? `${repo.remote} has no pull request #${pr.number}` : `${repo.remote}#${pr.number} couldn't be read (${why.text})`;
    }
    const other = ownersOf({ repo: repo.remote, number: pr.number, url: pull.url }).find((id) => id !== taskId);
    return other !== undefined ? `${repo.remote}#${pr.number} is linked to task #${other} already: unlink it there first` : { repo, pull };
  };

  const onBoard = (floor: PulledFloor) => void syncPrStates(floor.id, floor.pullsState().items).catch((err) => console.error("agent-office: syncing a floor's linked pull requests failed:", err));

  const api: KanbanPullsApi = {
    async bundle(project, by, o) {
      return bundleItems(project, by, o?.includeClosed === true);
    },
    review,
    panel,
  };

  const plugin: KanbanPlugin = {
    name: 'pulls',
    ws: {
      'kanban.pr.bundle': async (c, m) => {
        const key: KanbanPrBundleKey = 'taskId' in m ? { taskId: m.taskId } : 'branch' in m ? { branch: m.branch } : { ticket: m.ticket };
        const got = await bundleItems(m.project, key as BundleBy, m.includeClosed === true);
        c.send({ t: 'kanban.pr.bundle', ...(m.rid ? { rid: m.rid } : {}), project: m.project, key, prs: typeof got === 'string' ? [] : got, ...(typeof got === 'string' ? { error: got } : {}) });
      },
      // Which task owns a PR (the newest not archived), for the PR window's "Fix via task #N".
      'kanban.pr.owner': (c, m) => {
        const ref = repoRefOf(m.repo);
        const pr = { repo: m.repo, number: m.number, url: ref ? prWebUrl(ref, m.number) : `https://github.com/${m.repo}/pull/${m.number}` };
        const owners = prOwners(ctx.repo.prLinksMatching(pr.number, pr.url), (proj, repoId) => ctx.repos(proj).find((r) => r.id === repoId)?.remote, pr);
        const tasks = owners.map((id) => ctx.repo.getTask(id)).filter((t): t is KanbanTask => !!t && t.project === m.project && t.status !== 'archived');
        const t = tasks.sort((a, b) => b.id - a.id)[0];
        const check = t ? canFixPrs(t, forkTest(polledPulls(ctx.floor(t.project)), ctx.repos(t.project))) : undefined;
        c.send({ t: 'kanban.pr.owner', ...(m.rid ? { rid: m.rid } : {}), taskId: t?.id ?? null, ...(t ? { title: t.title } : {}), fixable: check?.ok === true, ...(check && !check.ok ? { reason: check.reason } : {}) });
      },
      // Looks for the task's PRs: its branches' open or newer ones are linked at once; its ticket's and its branches' older closed ones are only offered (kanban.pr.link takes them).
      'kanban.pr.find': async (c, m) => {
        const got = await find(c, m).catch((err: Error) => err.message);
        if (typeof got === 'string') return fail(c, m.rid, got);
        c.send({ t: 'kanban.prFound', ...(m.rid ? { rid: m.rid } : {}), taskId: m.taskId, ...got });
      },
      'kanban.pr.link': async (c, m) => {
        const got = taskOf(m.project, m.taskId);
        if (typeof got === 'string') return fail(c, m.rid, got);
        // All checked at once, none written unless every one is fine.
        const checked = await Promise.all(m.prs.map((pr) => pickPr(got.repos, m.taskId, pr)));
        const bad = checked.find((x) => typeof x === 'string');
        if (typeof bad === 'string') return fail(c, m.rid, bad);
        const seen = new Set<string>();
        const picked = (checked as Exclude<(typeof checked)[number], string>[]).filter((x) => !seen.has(`${x.repo.id}#${x.pull.number}`) && !!seen.add(`${x.repo.id}#${x.pull.number}`));
        // Ownership again, and the task as it is now, with no await before the writes: another request may have linked a PR meanwhile.
        for (const { repo, pull } of picked) {
          const other = ownersOf({ repo: repo.remote, number: pull.number, url: pull.url }).find((id) => id !== m.taskId);
          if (other !== undefined) return fail(c, m.rid, `${repo.remote}#${pull.number} is linked to task #${other} already: unlink it there first`);
          const old = clash(m.taskId, repo.id, repo.remote, pull.number, pull.url);
          if (old) return fail(c, m.rid, `${repo.remote}#${pull.number} can't be linked: ${old}`);
        }
        const now = ctx.repo.getTask(m.taskId) ?? got.task;
        for (const { repo, pull } of picked) {
          const had = now.prs.some((l) => l.repoId === repo.id && l.number === pull.number);
          ctx.repo.upsertPrLink(m.taskId, { repoId: repo.id, repo: repo.remote, number: pull.number, url: pull.url, state: prState(pull), ...(pull.headRefName ? { branch: pull.headRefName } : {}) });
          if (!had) ctx.repo.appendEvent(m.taskId, 'pr.linked', { repo: repo.remote, number: pull.number, by: 'manual', who: c.name });
        }
        ctx.taskChanged(m.taskId);
        ok(c, m.rid, { taskId: m.taskId });
      },
      'kanban.pr.unlink': (c, m) => {
        // The project, the task and the stored link are all it takes: a project whose repositories lost their remotes keeps its old links, and they come off too.
        if (!ctx.project(m.project)) return fail(c, m.rid, `There's no project ${m.project}`);
        const task = ctx.repo.getTask(m.taskId);
        if (!task || task.project !== m.project) return fail(c, m.rid, `There's no task #${m.taskId} in this project`);
        const remoteOf = (repoId: string) => ctx.repos(m.project).find((r) => r.id === repoId)?.remote;
        const link = task.prs.find((l) => l.number === m.number && (m.repoId ? l.repoId === m.repoId : !!m.repo && sameRepo(l.repo ?? remoteOf(l.repoId) ?? '', m.repo)));
        const name = `${m.repo ?? m.repoId}#${m.number}`;
        if (!link) return fail(c, m.rid, `Task #${m.taskId} has no link to ${name}`);
        ctx.repo.removePrLink(m.taskId, link.repoId, link.number);
        // The event names the resolved remote: the sync's "unlinked stays unlinked" compares repo + number.
        const repo = link.repo ?? remoteOf(link.repoId) ?? m.repo;
        ctx.repo.appendEvent(m.taskId, 'pr.unlinked', { ...(repo ? { repo } : {}), number: link.number, who: c.name });
        ctx.taskChanged(m.taskId);
        ok(c, m.rid, { taskId: m.taskId });
      },
      'kanban.pr.review': async (c, m) => {
        const req: KanbanPrReviewRequest = { project: m.project, prs: m.prs, ...(m.taskId !== undefined ? { taskId: m.taskId } : {}), ...(m.tool ? { tool: m.tool } : {}), ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) };
        if (m.panel) {
          const err = await panel(req, c);
          if (typeof err === 'string') return fail(c, m.rid, err);
          return ok(c, m.rid, m.taskId !== undefined ? { taskId: m.taskId } : {});
        }
        const got = await review(req, c);
        if (typeof got === 'string') return fail(c, m.rid, got);
        ok(c, m.rid, { taskId: got.taskId, ...(got.workerId ? { workerId: got.workerId } : {}) });
      },
    },
    start() {
      stopped = false;
      floorPullsListeners.add(onBoard);
    },
    stop() {
      stopped = true;
      floorPullsListeners.delete(onBoard);
      forks.clear();
      defaultBranches.clear();
      closingChecked.clear();
    },
  };
  return { api, plugin, checkReview, bundleItems, syncPrStates, prState };
}

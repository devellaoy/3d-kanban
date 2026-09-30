// Pull requests across a project's repositories: the bundle that belongs together (a task's, a
// branch's, a ticket's), a review of several PRs at once (checked here, run by the engine as a task
// of its own: KanbanEngineApi.reviewPrs), the same PRs to the floor's meeting room as upstream's
// 🤝 review panel, and the states of the tasks' linked PRs kept up with the floor's PR board. The
// board itself lists every repository (Floor.pullsState); this reads the same lists, or asks gh when
// the floor is closed.

import type { KanbanCaller, KanbanContext, KanbanPlugin, KanbanPullsApi } from '../../registry.js';
import type { KanbanEffort, KanbanPrBundleItem, KanbanPrBundleKey, KanbanPrReviewRequest, PrRef, ProjectRepo } from '../../../../shared/kanban/types.js';
import { PR_REVIEW_MAX } from '../../../../shared/kanban/types.js';
import type { AgentEffort, GhPull, MeetingRequest } from '../../../../shared/protocol.js';
import { sameRepo } from '../../../../shared/floors.js';
import { fillPrompt } from '../../../../shared/prompts.js';
import { gh } from '../../../github.js';
import { floorPullsListeners, type PulledFloor } from './board.js';
import type { GhRunner } from '../issues/source.js';
import { fail, ok } from '../util.js';
import { findBundle, prState, type BundleBy, type RepoPulls } from './bundle.js';

const FIELDS = 'number,title,url,state,isDraft,headRefName';

/**
 * What a 🤝 review panel of several PRs is about (the meeting's prompt, which every worker at the
 * table is told as the brief's `about`). Upstream's panel takes one pull request, the one its review
 * is posted on ({{posted}}); this makes the table review all of them as one change set.
 */
export const PR_PANEL_BRIEF = `Review these pull requests in the project {{project}} together, as one change set; they belong to one change:
{{prs}}

{{task}}

The pull request named below (#{{posted}} of {{postedRepo}}) is only where the combined review is posted: review every one of them. Read each with \`gh pr view <number> -R <owner/name> --comments\` and \`gh pr diff <number> -R <owner/name>\`. Look at them as one change: do they fit together across the repositories, is anything missing in one that another relies on. In the combined review, say which pull request each finding is in.`;

/** A PR as a review names it, with what its list says about it. */
export type ReviewPr = PrRef & { title?: string; url?: string; branch?: string };

export interface PullsOptions {
  gh?: GhRunner;
}

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
  const runGh = opts.gh ?? ((args: string[], cwd: string, timeout?: number) => gh(args, cwd, timeout));

  /** A repository's PRs: the open floor's board list when it has one, else straight from gh. */
  const listPulls = async (project: string, r: ProjectRepo & { remote: string }): Promise<RepoPulls> => {
    const board = ctx.floor(project)?.githubFor(r.remote);
    if (board && board.pulls.fetchedAt > 0 && !board.pulls.error) return { repo: r.remote, repoId: r.id, pulls: board.pulls.items };
    const out = await runGh(['pr', 'list', '-R', r.remote, '--state', 'all', '--limit', '100', '--json', FIELDS], ctx.dataDir);
    const raw = JSON.parse(out || '[]') as GhPull[];
    return { repo: r.remote, repoId: r.id, pulls: Array.isArray(raw) ? raw.filter((p) => Number.isSafeInteger(p?.number)) : [] };
  };

  /** The bundle: open and draft PRs only, unless `includeClosed` (a merged one needs no more review or fixing). */
  const bundleItems = async (project: string, by: BundleBy, includeClosed = false): Promise<KanbanPrBundleItem[] | string> => {
    if (!ctx.project(project)) return `There's no project ${project}`;
    const repos = githubRepos(ctx, project);
    if (!repos.length) return 'None of the project’s repositories has a GitHub remote';
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

  const review = async (req: KanbanPrReviewRequest, who: KanbanCaller): Promise<{ taskId: number; workerId: string } | string> => {
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
      prompt: fillPrompt(PR_PANEL_BRIEF, { ...reviewVars(req, checked.prs), posted: String(posted.number), postedRepo: posted.repo }),
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
   * A floor's PR board has fresh lists: its tasks' linked PRs take the states GitHub has for them
   * now (a PR is matched by repository and number, else by URL), and the browsers hear about the
   * cards that changed. Returns those tasks' ids.
   */
  const syncPrStates = (project: string, pulls: Pick<GhPull, 'number' | 'url' | 'state' | 'isDraft' | 'repo'>[]): number[] => {
    const links = ctx.repo.prLinksOfProject(project);
    if (!links.length || !pulls.length) return [];
    const repos = ctx.repos(project);
    const home = repos.find((r) => r.primary)?.remote;
    const remoteOf = (repoId: string) => repos.find((r) => r.id === repoId)?.remote;
    const changed = new Set<number>();
    for (const l of links) {
      const repo = l.repo ?? remoteOf(l.repoId);
      const p = pulls.find((x) => x.number === l.number && !!repo && sameRepo(x.repo ?? home, repo)) ?? pulls.find((x) => !!l.url && x.url === l.url);
      if (!p) continue;
      if (ctx.repo.setPrLinkState(l.taskId, l.repoId, l.number, prState(p))) changed.add(l.taskId);
    }
    for (const id of changed) ctx.taskChanged(id);
    return [...changed];
  };

  const onBoard = (floor: PulledFloor) => void syncPrStates(floor.id, floor.pullsState().items);

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
      'kanban.pr.review': async (c, m) => {
        const req: KanbanPrReviewRequest = { project: m.project, prs: m.prs, ...(m.taskId !== undefined ? { taskId: m.taskId } : {}), ...(m.tool ? { tool: m.tool } : {}), ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) };
        if (m.panel) {
          const err = await panel(req, c);
          if (typeof err === 'string') return fail(c, m.rid, err);
          return ok(c, m.rid, m.taskId !== undefined ? { taskId: m.taskId } : {});
        }
        const got = await review(req, c);
        if (typeof got === 'string') return fail(c, m.rid, got);
        ok(c, m.rid, { taskId: got.taskId, workerId: got.workerId });
      },
    },
    start() {
      floorPullsListeners.add(onBoard);
    },
    stop() {
      floorPullsListeners.delete(onBoard);
    },
  };
  return { api, plugin, checkReview, bundleItems, syncPrStates, prState };
}

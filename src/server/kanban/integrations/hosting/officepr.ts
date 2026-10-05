// /office/pr/*: what bin/office-pr.js asks for a worker whose repository is on Azure DevOps or
// Bitbucket, where there's no gh: open (or update) its branch's pull request, read one with its
// checks and comments, comment on one, list them. It runs with the credentials of the account the
// worker runs as (else the office's, see hosting/credentials.ts), so the token never reaches the
// worker. A repository on GitHub is told to use gh, as before.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KanbanContext, KanbanHookCaller, KanbanHookHandler } from '../../registry.js';
import { hostLabel, type OtherHost, type RepoRef } from '../../../../shared/hosting/remote.js';
import { parseAbKey, workItemMentions } from '../../../../shared/hosting/workitems.js';
import type { HostCredentials } from '../../../hosting/credentials.js';
import type { Fetch, HostAs, HostingProvider } from '../../../hosting/provider.js';
import { hostCredentials, hostFetch, providerOf, repoOf } from '../../../hosting/index.js';
import { workspaceOf } from '../../../worktrees.js';
import { realish, within, worktreeDir } from '../../../worktree-home.js';
import { readJson, sendJson } from '../util.js';

const BRANCH = /^[\w./-]{1,200}$/;
const TITLE_MAX = 400;
const BODY_MAX = 100_000;

export interface OfficePrDeps {
  creds?: () => HostCredentials | undefined;
  fetch?: () => Fetch;
  repoOf?: (dir: string) => RepoRef | undefined;
  /** Where the worker works (its workspace), to keep `dir` inside it; by default from its floor. */
  workspace?: (who: KanbanHookCaller) => string | undefined;
}

type Ask = { dir?: unknown; number?: unknown; head?: unknown; base?: unknown; title?: unknown; body?: unknown; draft?: unknown; comments?: unknown; state?: unknown };

/** What the PR does about its task's work item: the ticket's, if it's an Azure Boards one in the same organization, and every AB#n its text names. */
export function workItemsFor(repo: RepoRef, ticket: string | undefined, text: string): number[] {
  if (repo.host !== 'azure') return [];
  const ids = new Set(workItemMentions(text));
  const ab = parseAbKey(ticket);
  if (ab && ab.org.toLowerCase() === repo.owner.toLowerCase()) ids.add(ab.id);
  return [...ids];
}

export function officePrHook(ctx: KanbanContext, deps: OfficePrDeps = {}): KanbanHookHandler {
  const creds = deps.creds ?? hostCredentials;
  const fetchOf = deps.fetch ?? hostFetch;
  const where = deps.repoOf ?? ((dir: string) => repoOf(dir));
  const workspace =
    deps.workspace ??
    ((who: KanbanHookCaller) => {
      const floor = ctx.floor(who.floorId);
      const info = floor?.workers.get(who.workerId);
      if (!floor || !info) return undefined;
      const rel = workspaceOf(info);
      return rel ? worktreeDir(floor.dir, rel) : floor.dir;
    });

  const fail = (res: ServerResponse, status: number, error: string) => (sendJson(res, status, { error }), true);

  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: KanbanHookCaller) => {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    const action = url.pathname.replace(/^\/office\/pr\/?/, '');
    const raw = await readJson(req);
    if (typeof raw === 'string') return fail(res, 400, raw);
    const ask = (raw ?? {}) as Ask;
    // The checkout it asks about has to be in its own workspace.
    const dir = typeof ask.dir === 'string' && path.isAbsolute(ask.dir) ? realish(ask.dir) : undefined;
    const root = workspace(who);
    if (!dir || !root || !(dir === realish(root) || within(realish(root), dir)) || !existsSync(dir) || !statSync(dir).isDirectory()) return fail(res, 400, 'Run office-pr inside your own workspace (a checkout of one of its repositories)');
    const repo = where(dir);
    if (!repo) return fail(res, 400, "This checkout's origin isn't on GitHub, Azure DevOps or Bitbucket");
    if (repo.host === 'github') return fail(res, 400, 'This repository is on GitHub: use gh (gh pr create, gh pr view …) as usual');
    const provider = providerOf(repo.host as OtherHost);
    if (typeof provider === 'string') return fail(res, 400, provider);
    const as = creds()?.as(who.accountId, repo.host as OtherHost) ?? `The office keeps no ${hostLabel(repo.host)} credentials yet`;
    if (typeof as === 'string') return fail(res, 403, `${as}. Tell the person you work for.`);
    try {
      const out = await act(action, ask, repo, provider, as, fetchOf(), who);
      if (typeof out === 'string') return fail(res, 400, out);
      if (action === 'create' || action === 'comment') void refreshBoard(ctx, who.floorId, repo.id);
      sendJson(res, 200, { ok: true, host: repo.host, repo: repo.id, ...out });
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return true;
  };

  async function act(action: string, ask: Ask, repo: RepoRef, p: HostingProvider, as: HostAs, f: Fetch, who: KanbanHookCaller): Promise<Record<string, unknown> | string> {
    const n = Number(ask.number);
    const number = Number.isSafeInteger(n) && n > 0 ? n : undefined;
    const head = typeof ask.head === 'string' && BRANCH.test(ask.head) ? ask.head : undefined;
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    if (action === 'create') {
      if (!head) return 'Name the branch to open it from (--head, by default the current one)';
      const title = text(ask.title, TITLE_MAX).trim();
      const body = text(ask.body, BODY_MAX);
      if (!title) return 'A pull request needs a title (--title)';
      const base = typeof ask.base === 'string' && BRANCH.test(ask.base) ? ask.base : undefined;
      if (base === head) return 'The branch to merge into is the branch itself';
      const open = await p.findOpenPr(repo, head, as, f);
      if (open) {
        await p.updatePr(repo, open.number, { title, body }, as, f);
        return { ...open, updated: true };
      }
      const ticket = who.taskId !== undefined ? ctx.repo.getTask(who.taskId)?.ticket : undefined;
      const workItems = workItemsFor(repo, ticket ?? undefined, `${title}\n${body}`);
      const made = await p.createPr(repo, { head, ...(base ? { base } : {}), title, body, draft: ask.draft === true, ...(workItems.length ? { workItems } : {}) }, as, f);
      return { ...made, updated: false, ...(workItems.length ? { workItems } : {}) };
    }
    if (action === 'view') {
      let n2 = number;
      if (!n2) {
        if (!head) return 'Name the pull request (its number) or the branch (--head)';
        n2 = (await p.findOpenPr(repo, head, as, f))?.number;
        if (!n2) return `${head} has no open pull request`;
      }
      const [view, checks, comments] = await Promise.all([p.viewPr(repo, n2, as, f), p.checks(repo, n2, as, f), ask.comments === true ? p.comments(repo, n2, as, f) : Promise.resolve(undefined)]);
      return { pr: view, checks, ...(comments ? { comments } : {}) };
    }
    if (action === 'checks') {
      if (!number) return 'Name the pull request by its number';
      return { checks: await p.checks(repo, number, as, f) };
    }
    if (action === 'comment') {
      const body = text(ask.body, BODY_MAX);
      if (!number) return 'Name the pull request by its number';
      if (!body.trim()) return 'The comment is empty';
      return { url: (await p.comment(repo, number, body, as, f)) ?? null };
    }
    if (action === 'list') {
      const all = await p.listPulls(repo, as, f);
      const state = ask.state === 'all' ? undefined : 'OPEN';
      return { prs: all.filter((x) => (!state || x.state === state) && (!head || x.headRefName === head)).map(({ number: num, title, state: s, isDraft, url, headRefName, baseRefName, author, checks, reviewDecision }) => ({ number: num, title, state: s, isDraft, url, headRefName, baseRefName, author, checks, reviewDecision })) };
    }
    return `Unknown action ${action || '(none)'}: create, view, checks, comment or list`;
  }
}

/** The PR board of the repository, so a pull request just opened shows (and links to its task) without waiting for the next look. */
async function refreshBoard(ctx: KanbanContext, floorId: string, repo: string) {
  const floor = ctx.floor(floorId);
  await floor?.githubFor(repo)?.refresh();
}

import { execFile } from 'node:child_process';
import type { GhCheck, GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhReviewComment, GhState } from '../shared/protocol.js';
import type { GhAs } from './signins.js';
import { checkoutRepo, repoApi, repoFlag } from './ghrepo.js';
import { pullDiffOrFiles } from './prfiles.js';
import { hostLabel, repoRefOf } from '../shared/hosting/remote.js';
import { hostCredentials, otherHostRepo } from './hosting/index.js';
import { hostedComment, hostedPullDetail, hostedPulls, notOnHost, type HostedRepo } from './hosting/board.js';
import type { HostAs } from './hosting/provider.js';
import { readFile } from 'node:fs/promises';

const REFRESH_MS = 90_000;
/** How long the repo's list of labels is kept before the label picker asks GitHub again. */
const LABELS_MS = 60_000;

/** Turns gh's stderr into something a person standing at the board can act on. */
function friendly(raw: string): string {
  if (/no git remotes found|none of the git remotes/i.test(raw)) return 'This project has no GitHub remote yet. Push it to GitHub (git remote add origin <url>) to fill the boards.';
  if (/not a git repository/i.test(raw)) return "This folder isn't a git repository";
  if (/auth login|not logged in|authentication/i.test(raw)) return "gh isn't signed in to GitHub on the office's machine — run `gh auth login` there";
  if (/could not resolve to a repository|not found/i.test(raw)) return "gh can't find this repository on GitHub (check the remote and access)";
  return raw;
}

/** Runs gh as the office, or with `env` as someone signed in to their own GitHub (see signins.ts). */
export function gh(args: string[], cwd: string, timeout = 30_000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout, env }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim().split('\n').slice(-2).join(' ');
        const signedOut = env && /auth login|not logged in|authentication/i.test(msg);
        reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'GitHub CLI (gh) is not installed on the server' : signedOut ? 'Your GitHub sign-in stopped working — sign in again (☰ → 🔐 Your sign-ins)' : friendly(msg)));
      } else resolve(stdout);
    });
  });
}

function labels(raw: any[]): GhLabel[] {
  return (raw ?? []).map((l) => ({ name: String(l.name), color: `#${l.color ?? '888888'}` }));
}

function checksOf(rollup: any[]): GhPull['checks'] {
  if (!rollup?.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(concl)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    if (concl === 'PENDING' || concl === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'pass';
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** One entry of statusCheckRollup: a CheckRun (Actions) or a StatusContext (other CI). */
function checkOf(c: any): GhCheck {
  const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
  const status = String(c.status ?? '').toUpperCase();
  let state: GhCheck['state'] = 'pass';
  if (FAILED.includes(concl)) state = 'fail';
  else if ((status && status !== 'COMPLETED') || !concl || concl === 'PENDING' || concl === 'EXPECTED') state = 'pending';
  else if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(concl)) state = 'skip';
  const name = String(c.name ?? c.context ?? 'check');
  return { name: c.workflowName ? `${c.workflowName} / ${name}` : name, state, url: c.detailsUrl ?? c.targetUrl ?? undefined };
}

function commentsOf(raw: any[]): GhComment[] {
  return (raw ?? []).map((c: any) => ({
    id: String(c.id),
    author: c.author?.login ?? 'ghost',
    body: String(c.body ?? ''),
    createdAt: c.createdAt ?? c.submittedAt ?? '',
    url: c.url,
    state: c.state,
  }));
}

/**
 * Spots pull requests that merged between two looks at the list, so the gong rings however they
 * merged: from the PR window, by a worker's `gh pr merge`, by auto-merge, or on GitHub itself.
 */
export class MergeWatch {
  /** Open at the last look; unset until the first, so starting the office up rings for nothing. */
  private open?: Set<string>;
  /** Rang for already (merged from the PR window), so the next look doesn't ring them again. */
  private rang = new Set<string>();

  /** The gong rings for `n` (in `repo`, when it isn't the floor's own): false if it already has. */
  ring(n: number, repo?: string): boolean {
    const key = pullKey(n, repo);
    if (this.rang.has(key)) return false;
    this.rang.add(key);
    return true;
  }

  /** A fresh list from GitHub: the pull requests that merged since the last look and haven't rung yet. */
  look(pulls: GhPull[]): GhPull[] {
    const open = this.open;
    const key = (p: GhPull) => pullKey(p.number, p.repo);
    const merged = open ? pulls.filter((p) => p.state === 'MERGED' && open.has(key(p)) && !this.rang.has(key(p))) : [];
    // Once GitHub says it merged, it never shows as open again to ring twice.
    for (const p of pulls) if (p.state === 'MERGED') this.rang.delete(key(p));
    this.open = new Set(pulls.filter((p) => p.state === 'OPEN').map(key));
    return merged;
  }
}

/** A pull request by repository and number, so a project's repositories' PR numbers never collide. */
function pullKey(n: number, repo?: string): string {
  return `${repo?.toLowerCase() ?? ''}#${n}`;
}

export class GitHub {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private repo?: Promise<GhRepoInfo>;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  /** Labels just changed from the office, by "issue:N" or "pull:N", and when. */
  private relabeled = new Map<string, { labels: GhLabel[]; at: number }>();

  constructor(
    private dir: string,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    opts: {
      /** owner/name its issues and PRs are marked with: one of a project's other repositories (see Floor.pullsState). */
      nameWithOwner?: string;
      /** Only its pull requests are fetched (a project's other repository has no issues board of its own). */
      pullsOnly?: boolean;
      /** Why there's nothing to ask GitHub (the folder isn't a git repository): both boards just say so, and gh never runs. */
      off?: string;
    } = {},
  ) {
    this.nameWithOwner = opts.nameWithOwner;
    this.pullsOnly = !!opts.pullsOnly;
    this.off = opts.off;
  }

  readonly nameWithOwner?: string;
  private readonly pullsOnly: boolean;
  private readonly off?: string;

  /** Every gh call goes through here: a project that isn't a git repository refuses with `off` before gh or git runs. */
  private gh = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>): Promise<string> => (this.off ? Promise.reject(new Error(this.off)) : gh(args, cwd, timeout, env));

  /** The repository its gh calls name: the given one, else the checkout's origin, never gh's pick among the remotes (see ghrepo.ts). */
  private get target(): string | undefined {
    return this.nameWithOwner ?? (this.off ? undefined : checkoutRepo(this.dir));
  }

  /**
   * The repository when it's on a host other than GitHub (Azure DevOps, Bitbucket): the boards ask
   * its provider instead of gh (see hosting/board.ts), and what only GitHub has says so.
   */
  get hosted(): HostedRepo | undefined {
    if (this.off) return undefined;
    if (!this.nameWithOwner) return otherHostRepo(this.dir);
    const r = repoRefOf(this.nameWithOwner);
    return r && r.host !== 'github' ? (r as HostedRepo) : undefined;
  }

  start() {
    void this.refresh();
    if (!this.off) this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    if (this.off) {
      if (this.pulls.notGit) return;
      this.issues = { items: [], fetchedAt: Date.now(), loading: false, error: this.off, notGit: true };
      this.pulls = { items: [], fetchedAt: Date.now(), loading: false, error: this.off, notGit: true };
      this.onIssues(this.issues);
      this.onPulls(this.pulls);
      return;
    }
    await Promise.all([this.pullsOnly ? undefined : this.refreshIssues(), this.refreshPulls()]);
  }

  /** The repository's full name and how it lets PRs merge. Asked once (again after a failure). */
  repoInfo(): Promise<GhRepoInfo> {
    const hosted = this.hosted;
    if (hosted) return Promise.resolve({ nameWithOwner: hosted.id, methods: [] });
    this.repo ??= this.gh(['repo', 'view', ...(this.target ? [this.target] : []), '--json', 'nameWithOwner,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'], this.dir).then((out) => {
      const r = JSON.parse(out);
      const methods = (['squash', 'merge', 'rebase'] as const).filter((m) => r[{ squash: 'squashMergeAllowed', merge: 'mergeCommitAllowed', rebase: 'rebaseMergeAllowed' }[m]]);
      return { nameWithOwner: String(r.nameWithOwner), methods: methods.length ? methods : ['squash', 'merge', 'rebase'] };
    });
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  /** Who the office's own gh is signed in as, which is who it comments as for everyone without their own. Asked once; '' when gh can't say. */
  viewer(): Promise<string> {
    if (this.hosted) return Promise.resolve('');
    this.login ??= this.gh(['api', 'user', '--jq', '.login'], this.dir).then((out) => out.trim());
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  /**
   * A PR's description, conversation, line comments, checks and whether it can merge. `me` is the
   * GitHub login of whoever asked, when they're signed in to their own; else it's the office's.
   */
  async pullDetail(n: number, me?: string, host?: HostAs): Promise<GhPullDetail> {
    const hosted = this.hosted;
    if (hosted) return hostedPullDetail(hosted, n, host);
    const fields = 'number,body,state,isDraft,reviewDecision,headRefName,baseRefName,mergeable,mergeStateStatus,commits,comments,reviews,statusCheckRollup';
    const jq = '.[] | {id, in_reply_to_id, path, line, side, body, user: .user.login, created_at, html_url}';
    const [view, lines, repo, viewer] = await Promise.all([
      this.gh(['pr', 'view', String(n), ...repoFlag(this.target), '--json', fields], this.dir),
      this.gh(['api', repoApi(this.target, `pulls/${n}/comments?per_page=100`), '--paginate', '--jq', jq], this.dir),
      this.repoInfo(),
      me ?? this.viewer(),
    ]);
    const p = JSON.parse(view);
    const reviewComments: GhReviewComment[] = lines
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((c: any) => ({
        id: c.id,
        replyTo: c.in_reply_to_id ?? undefined,
        author: c.user ?? 'ghost',
        body: String(c.body ?? ''),
        createdAt: c.created_at,
        url: c.html_url,
        path: c.path,
        line: c.line ?? null,
        side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
      }));
    return {
      number: p.number,
      body: String(p.body ?? ''),
      state: p.state,
      isDraft: !!p.isDraft,
      reviewDecision: p.reviewDecision ?? '',
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      mergeable: p.mergeable ?? 'UNKNOWN',
      mergeStateStatus: p.mergeStateStatus ?? 'UNKNOWN',
      commits: (p.commits ?? []).length,
      comments: commentsOf(p.comments),
      // A line comment also makes an empty COMMENTED review; the comment itself is shown instead.
      reviews: commentsOf(p.reviews).filter((r) => r.body.trim() || r.state !== 'COMMENTED'),
      reviewComments,
      checks: (p.statusCheckRollup ?? []).map(checkOf),
      repo,
      viewer,
    };
  }

  /** The PR's unified diff, as `git diff` prints it. */
  pullDiff(n: number): Promise<string> {
    const hosted = this.hosted;
    if (hosted) return Promise.reject(new Error(notOnHost('The diff', hosted.host)));
    // A PR over GitHub's 300-file diff limit is built from the files API instead (prfiles.ts).
    return pullDiffOrFiles(this.gh, this.target, n, this.dir, () => this.gh(['pr', 'diff', String(n), ...repoFlag(this.target), '--color', 'never'], this.dir, 60_000));
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const hosted = this.hosted;
    if (hosted) throw new Error(notOnHost('An issue', hosted.host));
    const [view, viewer] = await Promise.all([this.gh(['issue', 'view', String(n), ...repoFlag(this.target), '--json', 'number,state,body,comments'], this.dir), me ?? this.viewer()]);
    const i = JSON.parse(view);
    return { number: i.number, state: i.state, body: String(i.body ?? ''), comments: commentsOf(i.comments), viewer };
  }

  /**
   * Comments on an issue, or on a PR's conversation (to GitHub a PR is an issue too), as `as` or
   * else the office. Returns the comment as GitHub saved it, or why it couldn't.
   */
  async comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs, host?: HostAs): Promise<{ comment?: GhComment; error?: string }> {
    const hosted = this.hosted;
    if (hosted) return this.hostedComment(hosted, kind, n, body, host);
    let comment: GhComment;
    try {
        // -f sends the body as a plain string: no @file reading, no {owner} filling in.
      const jq = '{id: .node_id, author: {login: .user.login}, body, createdAt: .created_at, url: .html_url}';
      const out = await this.gh(['api', '--method', 'POST', repoApi(this.target, `issues/${n}/comments`), '-f', `body=${body}`, '--jq', jq], this.dir, undefined, as?.env);
      [comment] = commentsOf([JSON.parse(out)]);
    } catch (err) {
      return { error: (err as Error).message };
    }
    // The issue board counts comments; a PR's card shows when it was last updated.
    void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    return { comment };
  }

  /**
   * Posts a review on a pull request that only comments (the meeting room's review panel), its body
   * read from a file. Resolves to the review's URL.
   */
  async review(n: number, file: string, as?: GhAs, owner?: string): Promise<string> {
    const hosted = this.hosted;
    if (hosted) {
      // Elsewhere it's a comment on the conversation, as whoever called the meeting (else the office).
      const host = hostCredentials()?.as(owner, hosted.host) ?? `Posting the review needs ${hostLabel(hosted.host)} credentials (☰ → 🔐 Your sign-ins)`;
      if (typeof host === 'string') throw new Error(host);
      return (await hostedComment(hosted, n, await readFile(file, 'utf8'), host)) ?? '';
    }
    // -F reads @file's contents as the value.
    const url = (await this.gh(['api', '--method', 'POST', repoApi(this.target, `pulls/${n}/reviews`), '-F', `body=@${file}`, '-f', 'event=COMMENT', '--jq', '.html_url'], this.dir, 60_000, as?.env)).trim();
    void this.refreshPulls();
    return url;
  }

  /** Merges a PR, or with `auto` has GitHub merge it once its requirements pass. Returns an error. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined> {
    const hosted = this.hosted;
    if (hosted) return notOnHost('Merging', hosted.host);
    try {
      const repo = await this.repoInfo();
      // --repo keeps gh out of the office's own checkout: without it, --delete-branch also deletes
      // the local branch and switches the project folder over to the base branch.
      const args = ['pr', 'merge', String(n), `--${method}`, '--repo', repo.nameWithOwner];
      if (deleteBranch) args.push('--delete-branch');
      if (auto) args.push('--auto');
      await this.gh(args, this.dir, 90_000, as?.env);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  /** Closes an issue, or a pull request without merging it, optionally saying why. Returns an error. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    const hosted = this.hosted;
    if (hosted) return notOnHost('Closing', hosted.host);
    try {
      const repo = await this.repoInfo();
      // --repo for the same reason as merge: --delete-branch must leave the office's checkout alone.
      const args = [kind === 'issue' ? 'issue' : 'pr', 'close', String(n), '--repo', repo.nameWithOwner];
      // --flag=value, so a comment starting with "-" isn't read as a flag.
      if (opts.comment) args.push(`--comment=${opts.comment}`);
      if (kind === 'issue' && opts.reason) args.push(`--reason=${opts.reason}`);
      if (kind === 'pull' && opts.deleteBranch) args.push('--delete-branch');
      await this.gh(args, this.dir, undefined, as?.env);
    } catch (err) {
      return (err as Error).message;
    }
    const refresh = () => (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    // A refresh already in flight returns at once and can still list it as open, so look again shortly after.
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), 3000);
    });
    return undefined;
  }

  /** Every label the repository has, for the label picker. Asked again after a minute (or a failure). */
  repoLabels(): Promise<GhLabel[]> {
    if (this.hosted) return Promise.resolve([]);
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = this.gh(['api', repoApi(this.target, 'labels?per_page=100'), '--paginate', '--jq', '.[] | {name, color, description}'], this.dir).then((out) =>
        out
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
          .map((l: any) => ({ name: String(l.name), color: `#${l.color ?? '888888'}`, description: l.description || undefined })),
      );
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  /**
   * Puts labels on an issue or PR and takes others off (to GitHub a PR is an issue too), as `as` or
   * else the office. Returns the labels it has now, or why they didn't change.
   */
  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }> {
    const hosted = this.hosted;
    if (hosted) return { error: notOnHost('Labels', hosted.host) };
    const path = repoApi(this.target, `issues/${n}/labels`);
    const jq = '[.[] | {name, color}]';
    let now: GhLabel[] | undefined;
    try {
        // -f labels[]=… sends a JSON array of plain strings: no @file reading, no {owner} filling in.
      if (add.length) now = labels(JSON.parse(await this.gh(['api', '--method', 'POST', path, ...add.flatMap((l) => ['-f', `labels[]=${l}`]), '--jq', jq], this.dir, undefined, as?.env)));
      for (const l of remove) {
        try {
          now = labels(JSON.parse(await this.gh(['api', '--method', 'DELETE', `${path}/${encodeURIComponent(l)}`, '--jq', jq], this.dir, undefined, as?.env)));
        } catch (err) {
          // Someone took it off already, which is what was asked for.
          if (!/label does not exist/i.test((err as Error).message)) throw err;
        }
      }
      now ??= labels(JSON.parse(await this.gh(['api', `${path}?per_page=100`, '--jq', jq], this.dir)));
    } catch (err) {
      // Some may have changed before it failed.
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { error: (err as Error).message };
    }
    // The board shows them at once, before the next look at GitHub (see relabel).
    const at = Date.now();
    this.relabeled.set(`${kind}:${n}`, { labels: now, at });
    if (kind === 'issue') {
      this.issues = { ...this.issues, items: this.relabel('issue', this.issues.items, at) };
      this.onIssues(this.issues);
      void this.refreshIssues();
    } else {
      this.pulls = { ...this.pulls, items: this.relabel('pull', this.pulls.items, at) };
      this.onPulls(this.pulls);
      void this.refreshPulls();
    }
    return { labels: now };
  }

  /**
   * A list asked for before a label change made here still has the old labels, so the new ones are
   * kept over it; a list asked for after the change is believed, and the change forgotten.
   */
  private relabel<T extends GhIssue | GhPull>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.relabeled.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(key);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }

  /** Assigns the issue to `as` (else the office's own gh), which moves it to In progress on the board. */
  async claim(issue: number, as?: GhAs): Promise<string | undefined> {
    const hosted = this.hosted;
    if (hosted) return notOnHost('Assigning an issue', hosted.host);
    try {
        await this.gh(['issue', 'edit', String(issue), ...repoFlag(this.target), '--add-assignee', '@me'], this.dir, undefined, as?.env);
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues();
    return undefined;
  }

  /** A comment from the PR window on a repository elsewhere: its conversation only (issues come from the issue sources). */
  private async hostedComment(hosted: HostedRepo, kind: 'issue' | 'pull', n: number, body: string, host?: HostAs): Promise<{ comment?: GhComment; error?: string }> {
    if (kind === 'issue') return { error: notOnHost('Commenting on an issue', hosted.host) };
    if (!host) return { error: `Commenting needs ${hostLabel(hosted.host)} credentials (☰ → 🔐 Your sign-ins)` };
    try {
      const url = await hostedComment(hosted, n, body, host);
      void this.refreshPulls();
      return { comment: { id: url ?? String(Date.now()), author: host.who ?? '', body, createdAt: new Date().toISOString(), ...(url ? { url } : {}) } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async refreshIssues() {
    // Nothing to ask on a project that isn't a git repository (refresh() says so), whoever asks for it.
    if (this.off || this.issues.loading) return;
    const hosted = this.hosted;
    if (hosted) {
      // Only GitHub has issues of its own: elsewhere the board shows the project's issue sources (Jira, Azure Boards).
      const label = hostLabel(hosted.host);
      this.issues = { items: [], fetchedAt: Date.now(), loading: false, host: hosted.host, note: `${label} repositories have no issues board of their own: add the project's issue tracker (Jira, Azure Boards) in 🗂️ Kanban → Issue sources` };
      this.onIssues(this.issues);
      return;
    }
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      // Open and closed separately, so old open issues are never crowded out by recent closed ones.
      const fields = 'number,title,state,url,author,labels,assignees,createdAt,updatedAt,body,comments';
      const [open, closed] = await Promise.all([
        this.gh(['issue', 'list', ...repoFlag(this.target), '--state', 'open', '--limit', '300', '--json', fields], this.dir),
        this.gh(['issue', 'list', ...repoFlag(this.target), '--state', 'closed', '--limit', '40', '--json', fields], this.dir),
      ]);
      const fetched: GhIssue[] = [...JSON.parse(open), ...JSON.parse(closed)].map((i: any) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.url,
        author: i.author?.login ?? '',
        labels: labels(i.labels),
        assignees: (i.assignees ?? []).map((a: any) => a.login),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        body: String(i.body ?? '').slice(0, 4000),
        comments: Array.isArray(i.comments) ? i.comments.length : Number(i.comments ?? 0),
        ...(this.nameWithOwner ? { repo: this.nameWithOwner } : {}),
      }));
      const items = this.relabel('issue', fetched, asked);
      this.issues = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    // Nothing to ask on a project that isn't a git repository (refresh() says so), whoever asks for it.
    if (this.off || this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    const hosted = this.hosted;
    if (hosted) {
      try {
        this.pulls = { items: await hostedPulls(hosted), fetchedAt: Date.now(), loading: false, host: hosted.host };
      } catch (err) {
        this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now(), host: hosted.host };
      }
      this.onPulls(this.pulls);
      return;
    }
    try {
      const fields = 'number,title,state,isDraft,url,author,labels,reviewDecision,headRefName,headRefOid,isCrossRepository,baseRefName,createdAt,updatedAt,additions,deletions,statusCheckRollup,body,closingIssuesReferences';
      const [open, merged, closed] = await Promise.all([
        this.gh(['pr', 'list', ...repoFlag(this.target), '--state', 'open', '--limit', '150', '--json', fields], this.dir),
        this.gh(['pr', 'list', ...repoFlag(this.target), '--state', 'merged', '--limit', '30', '--json', fields], this.dir),
        this.gh(['pr', 'list', ...repoFlag(this.target), '--state', 'closed', '--limit', '40', '--json', fields], this.dir),
      ]);
      // `--state closed` includes merged PRs; keep only the ones closed without merging.
      const seen = new Set<number>();
      const all = [...JSON.parse(open), ...JSON.parse(merged), ...JSON.parse(closed)].filter((p: any) => !seen.has(p.number) && seen.add(p.number));
      const fetched: GhPull[] = all.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        isDraft: !!p.isDraft,
        url: p.url,
        author: p.author?.login ?? '',
        labels: labels(p.labels),
        reviewDecision: p.reviewDecision ?? '',
        headRefName: p.headRefName,
        headRefOid: typeof p.headRefOid === 'string' ? p.headRefOid : undefined,
        isCrossRepository: typeof p.isCrossRepository === 'boolean' ? p.isCrossRepository : undefined,
        baseRefName: p.baseRefName,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        checks: checksOf(p.statusCheckRollup),
        body: String(p.body ?? '').slice(0, 4000),
        closes: (p.closingIssuesReferences ?? []).map((r: any) => Number(r.number)).filter((n: number) => Number.isInteger(n) && n > 0),
        ...(this.nameWithOwner ? { repo: this.nameWithOwner } : {}),
      }));
      const items = this.relabel('pull', fetched, asked);
      this.pulls = { items, fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}

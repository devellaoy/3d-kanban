// The floor's boards for a repository on a host other than GitHub (Azure DevOps, Bitbucket), with
// the same surface as server/github.ts' GitHub, which openBoard there picks between once, when the
// board is made: pull requests from the provider (hosting/board.ts), the PR window's detail, diff and
// comments. Issues come from the project's issue sources, and what only GitHub has (labels, merging
// or closing from the office) says so instead.

import { readFile } from 'node:fs/promises';
import type { GhCloseReason, GhComment, GhIssue, GhIssueDetail, GhLabel, GhMergeMethod, GhPull, GhPullDetail, GhRepoInfo, GhState } from '../../shared/protocol.js';
import { hostLabel, orgOf } from '../../shared/hosting/remote.js';
import { hostCredentials } from './index.js';
import { hostedComment, hostedDiff, hostedPullDetail, hostedPulls, notOnHost, type HostedRepo } from './board.js';
import type { HostAs } from './provider.js';

const REFRESH_MS = 90_000;
const SIGN_INS = '☰ → 🔐 Your sign-ins';

export class HostedBoard {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  readonly nameWithOwner?: string;
  private readonly pullsOnly: boolean;

  constructor(
    readonly hosted: HostedRepo,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    opts: { nameWithOwner?: string; pullsOnly?: boolean } = {},
  ) {
    this.nameWithOwner = opts.nameWithOwner;
    this.pullsOnly = !!opts.pullsOnly;
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    if (!this.pullsOnly) this.refreshIssues();
    await this.refreshPulls();
  }

  repoInfo(): Promise<GhRepoInfo> {
    return Promise.resolve({ nameWithOwner: this.hosted.id, methods: [] });
  }

  /** Nobody: the office has no sign-in of its own there that comments would come from. */
  viewer(): Promise<string> {
    return Promise.resolve('');
  }

  pullDetail(n: number, _me?: string, host?: HostAs): Promise<GhPullDetail> {
    return hostedPullDetail(this.hosted, n, host);
  }

  pullDiff(n: number): Promise<string> {
    return hostedDiff(this.hosted, n);
  }

  issueDetail(_n: number, _me?: string): Promise<GhIssueDetail> {
    return Promise.reject(new Error(notOnHost('An issue', this.hosted.host)));
  }

  /** A comment from the PR window: on its conversation only (issues come from the issue sources). */
  async comment(kind: 'issue' | 'pull', n: number, body: string, _as?: unknown, host?: HostAs): Promise<{ comment?: GhComment; error?: string }> {
    if (kind === 'issue') return { error: notOnHost('Commenting on an issue', this.hosted.host) };
    if (!host) return { error: `Commenting needs ${hostLabel(this.hosted.host)} credentials (${SIGN_INS})` };
    try {
      const url = await hostedComment(this.hosted, n, body, host);
      void this.refreshPulls();
      return { comment: { id: url ?? String(Date.now()), author: host.who ?? '', body, createdAt: new Date().toISOString(), ...(url ? { url } : {}) } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** The meeting room's review: a comment on the conversation, as whoever called the meeting (else the office). */
  async review(n: number, file: string, _as?: unknown, owner?: string): Promise<string> {
    const host = hostCredentials()?.as(owner, this.hosted.host, orgOf(this.hosted)) ?? `Posting the review needs ${hostLabel(this.hosted.host)} credentials (${SIGN_INS})`;
    if (typeof host === 'string') throw new Error(host);
    return (await hostedComment(this.hosted, n, await readFile(file, 'utf8'), host)) ?? '';
  }

  merge(_n: number, _method: GhMergeMethod, _deleteBranch: boolean, _auto: boolean): Promise<string | undefined> {
    return Promise.resolve(notOnHost('Merging', this.hosted.host));
  }

  close(_kind: 'issue' | 'pull', _n: number, _opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }): Promise<string | undefined> {
    return Promise.resolve(notOnHost('Closing', this.hosted.host));
  }

  repoLabels(): Promise<GhLabel[]> {
    return Promise.resolve([]);
  }

  setLabels(_kind: 'issue' | 'pull', _n: number, _add: string[], _remove: string[]): Promise<{ labels?: GhLabel[]; error?: string }> {
    return Promise.resolve({ error: notOnHost('Labels', this.hosted.host) });
  }

  claim(_issue: number): Promise<string | undefined> {
    return Promise.resolve(notOnHost('Assigning an issue', this.hosted.host));
  }

  /** Only GitHub has issues of its own: elsewhere the board shows the project's issue sources (Jira, Azure Boards). */
  private refreshIssues() {
    const label = hostLabel(this.hosted.host);
    this.issues = { items: [], fetchedAt: Date.now(), loading: false, host: this.hosted.host, note: `${label} repositories have no issues board of their own: add the project's issue tracker (Jira, Azure Boards) in 🗂️ Kanban → Issue sources` };
    this.onIssues(this.issues);
  }

  private async refreshPulls() {
    if (this.pulls.loading) return;
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const host = this.hosted.host;
    try {
      this.pulls = { items: await hostedPulls(this.hosted), fetchedAt: Date.now(), loading: false, host };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now(), host };
    }
    this.onPulls(this.pulls);
  }
}

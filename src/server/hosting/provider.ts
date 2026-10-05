// The hosting providers: what the office does with a repository on a host other than GitHub
// (Azure DevOps, Bitbucket), over that host's REST API. GitHub itself keeps going through gh
// (server/github.ts, workers/pr.ts and the kanban's integrations), exactly as before; the office
// asks for a provider only for a repository whose remote is somewhere else (shared/hosting/remote.ts).
//
// Every function throws an Error whose text a person can act on (see http.ts).

import type { GhCheck, GhComment, GhPull } from '../../shared/protocol.js';
import type { OtherHost, RepoRef } from '../../shared/hosting/remote.js';

/** How a call is made as somebody: the Authorization header, and who it is (for messages). */
export interface HostAs {
  kind: OtherHost;
  /** The Authorization header's value. */
  auth: string;
  /** Whose credentials: an account id, or 'office' for the office's own. */
  key: string;
  /** Who the host says the credentials belong to, once they were checked. */
  who?: string;
}

/** The credentials picked for each host a piece of work needs (see gates.withHosts). */
export interface HostPick {
  get(kind: OtherHost): HostAs | undefined;
  /** The environment git pushes to those hosts with: the asker's, with the office's credential helper (HostCredentials.gitEnv). */
  git?: Record<string, string>;
}

export interface PrInput {
  /** The branch with the changes. */
  head: string;
  /** The branch to merge into; the repository's default when not given. */
  base?: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Azure Boards work items to link (and complete when it merges). */
  workItems?: number[];
}

export interface OpenedHostPr {
  number: number;
  url: string;
}

/** One pull request as office-pr's `view` shows it. */
export interface HostPrView {
  number: number;
  url: string;
  title: string;
  body: string;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''. */
  reviewDecision: string;
  isCrossRepository: boolean;
}

/** A comment on a pull request: on its conversation, or on a line of a file (`path`, `line`). */
export interface HostComment extends GhComment {
  path?: string;
  line?: number;
  /**
   * Whether an agent may act on it (the host's counterpart of GitHub's author_association): it's
   * from the pull request's author or one of its reviewers, or the repository is private, so only
   * people with access to it can comment at all (see CommentTrust).
   */
  trusted?: boolean;
}

/** Who a pull request's comments are trusted from (HostComment.trusted). */
export interface CommentTrust {
  /** The host's ids of the pull request's author and reviewers. */
  ids: Set<string>;
  /** The repository is private: everyone who can comment has access to it. */
  everyone: boolean;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostingProvider {
  kind: OtherHost;
  /** Who the credentials belong to (their display name), or throws when the host turns them down. `org`: Azure DevOps' organization. */
  whoAmI(as: HostAs, fetch: Fetch, opts?: { org?: string }): Promise<string>;
  /** The open pull request from `branch`, if there is one. */
  findOpenPr(repo: RepoRef, branch: string, as: HostAs, fetch: Fetch): Promise<OpenedHostPr | undefined>;
  createPr(repo: RepoRef, pr: PrInput, as: HostAs, fetch: Fetch): Promise<OpenedHostPr>;
  updatePr(repo: RepoRef, n: number, change: { title?: string; body?: string }, as: HostAs, fetch: Fetch): Promise<void>;
  viewPr(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<HostPrView>;
  /**
   * The repository's pull requests for the PR board, in GitHub's shape (state OPEN / MERGED /
   * CLOSED, checks, reviewDecision, each with `repo` set to repo.id): the open ones, and the most
   * recently merged and closed.
   */
  listPulls(repo: RepoRef, as: HostAs, fetch: Fetch): Promise<GhPull[]>;
  checks(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<GhCheck[]>;
  comments(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<HostComment[]>;
  /** Its changes as a unified diff (as `git diff` of its merge base and head prints them), read from the host: nothing is fetched into a checkout. */
  diff(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<string>;
  /** Comments on its conversation; resolves to the comment's URL when the host gives one. */
  comment(repo: RepoRef, n: number, body: string, as: HostAs, fetch: Fetch): Promise<string | undefined>;
  defaultBranch(repo: RepoRef, as: HostAs, fetch: Fetch): Promise<string | undefined>;
  /** Whether its head is in another repository (a fork's). */
  isFork(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<boolean>;
}

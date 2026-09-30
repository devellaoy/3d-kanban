// What every issue source is: a way to list a project's issues as NormalizedIssue[], with what it
// needs from the office handed in (so tests give it canned gh output and HTTP answers).

import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';

/** Runs `gh` with these arguments in `cwd`; resolves to its stdout, rejects with a readable error. */
export type GhRunner = (args: string[], cwd: string, timeout?: number) => Promise<string>;

export interface IssueSourceIo {
  gh: GhRunner;
  fetch: typeof fetch;
  /** Where gh runs when it doesn't need a checkout (the office's data dir). */
  cwd: string;
  /** The Jira site, e-mail and API token (kanban-secrets.json), when they're set. */
  jira?: { site: string; email: string; token: string };
  /** owner/name of the project's git repositories with a GitHub remote, for a github-repo source that names none. */
  projectRepos: string[];
}

export interface IssueSource {
  list(config: IssueSourceConfig, io: IssueSourceIo): Promise<NormalizedIssue[]>;
}

/** How long an issue's body is kept (the task made from it gets this much). */
export const ISSUE_BODY_MAX = 20_000;
/** The most issues one source lists. */
export const SOURCE_MAX = 500;

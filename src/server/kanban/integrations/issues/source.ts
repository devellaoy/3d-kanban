// What every issue source is: a way to list a project's issues as NormalizedIssue[], with what it
// needs from the office handed in (so tests give it canned gh output and HTTP answers).

import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import type { JiraConnection } from '../../secrets.js';

/** Runs `gh` with these arguments in `cwd`; resolves to its stdout, rejects with a readable error. */
export type GhRunner = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

export interface IssueSourceIo {
  gh: GhRunner;
  fetch: typeof fetch;
  /** Where gh runs when it doesn't need a checkout (the office's data dir). */
  cwd: string;
  /** The Jira connections: site, e-mail and API token each (kanban-secrets.json). */
  jira: JiraConnection[];
  /** owner/name of the project's git repositories with a GitHub remote, for a github-repo source that names none. */
  projectRepos: string[];
}

/**
 * What an action on one issue (status, comment, assignee) needs besides the source's own: who gh runs as
 * (`env`: a person's own sign-in; none: the office's gh) and who is asking, for the attribution line
 * when the write goes out under an identity everyone shares (the Jira token, the office's gh).
 */
export interface IssueActIo extends IssueSourceIo {
  env?: Record<string, string>;
  /** The asker's name in the office. */
  who: string;
  /** Whether the write is made under a shared identity: a comment is then signed `— <who> via Agent Office`. */
  shared: boolean;
}

/** The line that signs a comment made under a shared identity. */
export const attribution = (who: string) => `— ${who} via Agent Office`;

export interface IssueSource {
  list(config: IssueSourceConfig, io: IssueSourceIo): Promise<NormalizedIssue[]>;
}

/** How long an issue's body is kept (the task made from it gets this much). */
export const ISSUE_BODY_MAX = 20_000;
/** The most issues one source lists. */
export const SOURCE_MAX = 500;

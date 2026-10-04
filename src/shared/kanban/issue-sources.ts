// Where a project's issues come from: the configured sources (see server/kanban/issues).
// Re-exported from types.ts, where the rest of the kanban's domain types are.

/** Where a project's issues come from (see server/kanban/issues). */
export type IssueSourceConfig =
  | {
      id: string;
      kind: 'github-repo';
      /** owner/name; empty = the project's git repositories with a GitHub remote. */
      repos: string[];
      filters: { assignee?: string; labels?: string[]; state?: 'open' | 'closed' | 'all' };
    }
  | {
      id: string;
      kind: 'github-project';
      /** User or organisation that owns the Projects v2 board. */
      owner: string;
      number: number;
      filters: { assignee?: string; status?: string; iteration?: string };
    }
  | {
      id: string;
      kind: 'jira';
      /** e.g. yourteam.atlassian.net (the token is in kanban-secrets.json). */
      site: string;
      projectKeys: string[];
      filters: { assignee?: string; epic?: string; labels?: string[]; statusCategoryNot?: string[]; jql?: string };
    };
export type IssueSourceKind = IssueSourceConfig['kind'];

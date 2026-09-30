// GitHub issues of chosen repositories (IssueSourceConfig 'github-repo'), with `gh issue list -R`.
// Filters: assignee (@me or a login), labels (all of them), state.

import type { IssueSourceConfig, NormalizedIssue } from '../../../../shared/kanban/types.js';
import { GH_REPO_RE } from '../../../../shared/kanban/protocol.js';
import { ISSUE_BODY_MAX, SOURCE_MAX, type IssueSource, type IssueSourceIo } from './source.js';

type RepoConfig = Extract<IssueSourceConfig, { kind: 'github-repo' }>;

const FIELDS = 'number,title,url,body,state,assignees,labels,updatedAt';

/** The ticket key of a GitHub issue: gh:owner/name#12. */
export function ghIssueKey(repo: string, number: number): string {
  return `gh:${repo}#${number}`;
}

/** `gh issue list` for one repository, as the source's filters say. */
export function ghIssueArgs(repo: string, filters: RepoConfig['filters'], limit = 200): string[] {
  const args = ['issue', 'list', '-R', repo, '--state', filters.state ?? 'open', '--limit', String(limit), '--json', FIELDS];
  // --flag=value, so a value starting with "-" is never read as a flag.
  if (filters.assignee) args.push(`--assignee=${filters.assignee === 'me' ? '@me' : filters.assignee}`);
  for (const l of filters.labels ?? []) args.push(`--label=${l}`);
  return args;
}

/** What `gh issue list --json …` printed, as issues. Anything that isn't one is skipped. */
export function parseGhIssues(repo: string, out: string, sourceId?: string): NormalizedIssue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(out || '[]');
  } catch {
    throw new Error(`gh gave something that isn't JSON for ${repo}`);
  }
  if (!Array.isArray(raw)) return [];
  const issues: NormalizedIssue[] = [];
  for (const i of raw as Record<string, any>[]) {
    if (!i || !Number.isSafeInteger(i.number) || typeof i.title !== 'string') continue;
    const assignees = Array.isArray(i.assignees) ? i.assignees.map((a: any) => String(a?.login ?? '')).filter(Boolean) : [];
    issues.push({
      source: 'github-repo',
      ...(sourceId ? { sourceId } : {}),
      key: ghIssueKey(repo, i.number),
      title: i.title,
      url: typeof i.url === 'string' ? i.url : `https://github.com/${repo}/issues/${i.number}`,
      body: String(i.body ?? '').slice(0, ISSUE_BODY_MAX),
      ...(assignees.length ? { assignee: assignees.join(', ') } : {}),
      labels: Array.isArray(i.labels) ? i.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean) : [],
      ...(typeof i.state === 'string' ? { status: i.state } : {}),
      repo,
      updatedAt: typeof i.updatedAt === 'string' ? i.updatedAt : '',
    });
  }
  return issues;
}

export const githubRepoSource: IssueSource = {
  async list(config, io: IssueSourceIo) {
    const c = config as RepoConfig;
    const repos = (c.repos.length ? c.repos : io.projectRepos).filter((r) => GH_REPO_RE.test(r));
    if (!repos.length) throw new Error('No GitHub repository to list issues from: name one, or give the project’s repositories a GitHub remote');
    const lists = await Promise.all(repos.map(async (repo) => parseGhIssues(repo, await io.gh(ghIssueArgs(repo, c.filters), io.cwd), c.id)));
    return lists.flat().slice(0, SOURCE_MAX);
  },
};

// Taking an issue as work starts on it: assigned to the person (a GitHub issue nobody has, under their
// own sign-in) and moved to "In progress" on the GitHub Projects boards that are the project's issue
// sources. The two are separate because the Status isn't personal: it may go out under the office's gh.
// Never throws: what couldn't be done comes back as warnings.

import { parseGhKey } from '../../../../shared/kanban/issuecard.js';
import type { IssueSourceConfig } from '../../../../shared/kanban/types.js';
import { ghClaimIfUnassigned } from './github-ops.js';
import { inProgressOption, resolveBoards, setBoardStatus, type ProjectTarget } from './project-ops.js';
import type { IssueActIo } from './source.js';

export interface TakeResult {
  /** The login the issue was assigned to. */
  assigned?: string;
  /** The Status each board moved the item to. */
  moved: { to: string; board: string }[];
  warnings: string[];
}

const msg = (err: unknown) => (err as Error)?.message ?? String(err);

export async function takeIssue(opts: { assignIo?: IssueActIo; statusIo: IssueActIo; key: string; sources: IssueSourceConfig[]; isPr?: boolean; status?: boolean }): Promise<TakeResult> {
  const out: TakeResult = { moved: [], warnings: [] };
  const issue = parseGhKey(opts.key);
  const draft = /^ghp:[^#]+#(.+)$/.exec(opts.key);
  // Jira and anything else is left as it is.
  if (!issue && !draft) return out;
  if (issue && opts.assignIo && !opts.isPr) {
    try {
      out.assigned = await ghClaimIfUnassigned(opts.assignIo, issue.repo, issue.number);
    } catch (err) {
      out.warnings.push(`👤 Couldn’t assign ${opts.key}: ${msg(err)}`);
    }
  }
  const boards = opts.sources.filter((s): s is Extract<IssueSourceConfig, { kind: 'github-project' }> => s.kind === 'github-project');
  if (opts.status === false || !boards.length) return out;
  const target: ProjectTarget = issue ?? { itemId: draft![1] };
  try {
    for (const board of await resolveBoards(opts.statusIo, target, boards)) {
      if (!board.fieldId) continue;
      const option = inProgressOption(board);
      if (!option) {
        // On it already, or past it, is fine; a board with no such option is worth a word.
        if (!inProgressOption({ ...board, current: undefined })) out.warnings.push(`📋 ${board.title} has no In progress status`);
        continue;
      }
      try {
        await setBoardStatus(opts.statusIo, board, option.id);
        out.moved.push({ to: option.name, board: board.title });
      } catch (err) {
        out.warnings.push(`📋 Couldn’t move ${opts.key} on ${board.title}: ${msg(err)}`);
      }
    }
  } catch (err) {
    out.warnings.push(`📋 Couldn’t move ${opts.key} to In progress: ${msg(err)}`);
  }
  return out;
}

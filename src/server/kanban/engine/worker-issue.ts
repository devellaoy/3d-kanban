// The issue an office worker is working on, for the pull request it opens to close: its kanban
// task's ticket, else the queue task it was seated for, else what its prompt says (the issues board
// hands work over as "Work on GitHub issue #12"). An issue handed to a worker at its desk by hand
// is only known by that prompt.
import type { Floor } from '../../floor.js';
import { checkoutRepo } from '../../ghrepo.js';
import { promptIssue } from '../../../shared/kanban/issuecard.js';
import type { WorkerInfo } from '../../../shared/protocol.js';
import type { KanbanContext } from '../registry.js';
import { ghIssueKey } from '../integrations/issues/github-repo.js';

/** The worker's issue as a ticket key (`gh:owner/repo#12`, or a Jira key), if it has one. */
export function workerIssueKey(ctx: Pick<KanbanContext, 'repo'>, floor: Floor, info: WorkerInfo): string | undefined {
  if (info.kanban) return ctx.repo.getTask(info.kanban.taskId)?.ticket;
  // A card handed to it later is newer than its queue task or its first prompt.
  if (info.issueKey) return info.issueKey;
  const repo = floor.def.repo ?? checkoutRepo(floor.dir);
  const queued = floor.queue.issueOf(info.id);
  if (queued.issueKey) return queued.issueKey;
  if (queued.issue !== undefined) return repo ? ghIssueKey(repo, queued.issue) : undefined;
  const handed = promptIssue(info.prompt, { strict: true });
  const from = handed?.repo ?? repo;
  return handed && from ? ghIssueKey(from, handed.number) : undefined;
}

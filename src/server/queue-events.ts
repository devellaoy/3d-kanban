// What the 📋 task queue needs from its floor (see QueueEvents): the browsers hearing of it, toasts,
// claiming the issue a task came from, and the pull request it opened closing that issue.
import type { Floor, FloorContext } from './floor.js';
import { checkoutRepo } from './ghrepo.js';
import { officePrompt } from './prompts.js';
import type { QueueEvents } from './queue.js';
import { ghIssueKey } from './kanban/integrations/issues/github-repo.js';
import { ensureClosingRef } from './kanban/integrations/pulls/closes.js';

export function queueEvents(floor: Floor, ctx: FloorContext): QueueEvents {
  return {
    update: (state) => {
      ctx.emit(floor, { t: 'queue', state });
      // A task's pull request may just have been linked (or merged).
      floor.sendLandedHome();
    },
    toast: (text, level) => ctx.toast(floor, text, level),
    claimIssue: (issue, owner, key) => {
      const as = ctx.ghAs(owner);
      return typeof as === 'string' ? Promise.resolve(as) : floor.claimCard(issue, key, as); // a card from the issue sources too
    },
    // The task's PR is linked: merging it must close the issue, so the line is added if the agent left it out.
    prLinked: (t, pr) => {
      const repo = floor.def.repo ?? checkoutRepo(floor.dir);
      const ref = t.issueKey ?? (t.issue !== undefined && repo ? ghIssueKey(repo, t.issue) : undefined);
      if (!ref) return;
      const as = ctx.ghAs(t.owner);
      void ensureClosingRef({ prUrl: pr.url, ref, cwd: floor.dir, env: typeof as === 'object' ? as.env : undefined })
        .then((r) => r.warning && ctx.toast(floor, `📋 ${r.warning}`, 'warn'))
        .catch((err) => console.error("agent-office: adding the closing line to a queue task's pull request failed:", err));
    },
    refreshGitHub: () => void floor.github.refresh(),
    hiringPaused: () => ctx.ledger.hiringPaused,
    room: () => ctx.capacity.room(),
    emptied: () => {
      ctx.toast(floor, '📋 The queue is empty: every task is done 🎉');
      ctx.emit(floor, { t: 'gong', why: 'queue' });
    },
    worktreeNote: () => officePrompt(ctx.prompts, 'queue.worktree'),
  };
}

// What the 📋 task queue needs from its floor (see QueueEvents): the browsers hearing of it, toasts,
// claiming the issue a task came from, and the pull request it opened closing that issue.
import type { Floor, FloorContext } from './floor.js';
import { checkoutRepo } from './ghrepo.js';
import { officePrompt } from './prompts.js';
import type { QueueEvents } from './queue.js';
import { ghIssueKey } from './kanban/integrations/issues/github-repo.js';
import { ensureClosingRef } from './kanban/integrations/pulls/closes.js';
import { progressIssue } from './kanban/integrations/issues/wall.js';

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
      if (typeof as !== 'string') return floor.claimCard(issue, key, as); // a card from the issue sources too
      // No gh sign-in of their own: nobody is assigned, but the board's Status moves with the office's gh.
      const ref = floor.cardRef(issue || undefined, key);
      if (ref) void progressIssue(floor.id, ref).then((w) => w && ctx.toast(floor, `📋 ${w}`, 'warn'));
      return Promise.resolve(as);
    },
    // The task's PR is linked: merging it must close the issue, so the line is added if the agent left it out.
    // Resolves to false when gh couldn't show or edit the PR, for the queue to ask again later.
    prLinked: async (t, pr) => {
      const ref = floor.cardRef(t.issue, t.issueKey);
      if (!ref) return true;
      const as = ctx.ghAs(t.owner);
      try {
        const r = await ensureClosingRef({ prUrl: pr.url, ref, cwd: floor.dir, env: typeof as === 'object' ? as.env : undefined });
        if (r.retry) return false;
        if (r.warning) ctx.toast(floor, `📋 ${r.warning}`, 'warn');
        return true;
      } catch (err) {
        console.error("agent-office: adding the closing line to a queue task's pull request failed:", err);
        return false;
      }
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

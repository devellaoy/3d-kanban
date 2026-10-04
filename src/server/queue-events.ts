// What the 📋 task queue needs from its floor (see QueueEvents): the browsers hearing of it, toasts,
// claiming the issue a task came from, and the pull request it opened closing that issue.
import type { Floor, FloorContext } from './floor.js';
import { checkoutRepo } from './ghrepo.js';
import { officePrompt } from './prompts.js';
import type { QueueEvents } from './queue.js';
import { ghIssueKey } from './kanban/integrations/issues/github-repo.js';
import { ensureClosingRef, ghEditor } from './kanban/integrations/pulls/closes.js';
import { takeCard } from './take-card.js';

export function queueEvents(floor: Floor, ctx: FloorContext): QueueEvents {
  /** What was told about a PR's closing line, so a PR's warning comes once, not after each of the worker's turns. */
  const told = new Set<string>();
  return {
    update: (state) => {
      ctx.emit(floor, { t: 'queue', state });
      // A task's pull request may just have been linked (or merged).
      floor.sendLandedHome();
    },
    toast: (text, level) => ctx.toast(floor, text, level),
    claimIssue: (issue, owner, key) => takeCard(floor, (o) => ctx.ghAs(o), { n: issue || undefined, key, owner, fromQueue: true }), // a card from the issue sources too
    // The task's PR is linked: merging it must close the issue, so the line is added if the agent left it out.
    // Resolves to false when gh couldn't show or edit the PR, for the queue to ask again later.
    prLinked: async (t, pr) => {
      const ref = floor.cardRef(t.issue, t.issueKey);
      if (!ref) return true;
      const editor = ghEditor(ctx.ghAs(t.owner));
      const tell = (text: string) => {
        if (told.has(`${pr.url} ${text}`)) return;
        if (told.size > 200) told.clear();
        told.add(`${pr.url} ${text}`);
        ctx.toast(floor, `📋 ${text}`, 'warn');
      };
      if ('warning' in editor) return tell(`Not checking that ${pr.url} closes ${ref.replace(/^gh:/, '')}: ${editor.warning}`), true;
      try {
        const r = await ensureClosingRef({ prUrl: pr.url, ref, cwd: floor.dir, env: editor.env });
        if (r.retry) return false;
        if (r.warning) tell(r.warning);
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

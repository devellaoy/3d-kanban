import { WebSocket } from 'ws';
import type { GhAs } from '../signins.js';
import type { Floor } from '../floor.js';
import type { SignInKind } from '../../shared/protocol.js';
import type { Ctx, Gates } from './context.js';
import type { Client } from './client.js';
import { takeCard } from '../take-card.js';

/** What has to be true before something happens for someone: a sign-in of their own, a fresh base, GitHub. */
export function gates(ctx: Ctx): Gates {
  /**
   * A worker took on GitHub issue `n` (an issue card dropped on its desk, or an issue-source card by its
   * `key`): assigned and moved to In progress on GitHub (take-card.ts), and taken off the queue so nobody
   * else is seated for it.
   */
  const takeIssue = (c: Client, floor: Floor, n: number | undefined, key?: string, workerId?: string) => {
    void takeCard(floor, (o) => ctx.signins.ghAs(o), { n, key, owner: c.accountId, workerId }, (text) => ctx.warn(c, text));
  };

  /**
   * Runs `go` once `c` has a sign-in of their own to `which` (only accounts need one: on the shared
   * password it's the office's own). Without one it looks again, since they may have just signed
   * in from a shell, and otherwise tells them why (`refused`, else a toast) and opens their sign-ins.
   */
  const withSignIn = (c: Client, which: SignInKind | undefined, go: () => void, refused?: (why: string) => void) => {
    const { signins } = ctx;
    const id = c.accountId;
    const ready = (a: string) => (which === 'claude' ? signins.claudeReady(a) : signins.githubReady(a));
    if (!which || !id || ready(id)) return go();
    void signins.look(id, true).then(() => {
      if (c.out || c.ws.readyState !== WebSocket.OPEN) return;
      if (ready(id)) return go();
      const why = signins.why(which);
      if (refused) refused(why);
      else ctx.warn(c, why);
      ctx.sendTo(c, { t: 'signins.needed', which, why });
    });
  };
  /**
   * Runs `go` once a worktree made on `floor` would start from what's on GitHub now (see
   * Worktrees.fetch): right away when that was just fetched, else after a fetch, if `c` and the floor
   * are still there.
   */
  const withFreshBase = (c: Client, floor: Floor | Floor[], go: () => void) => {
    const all = Array.isArray(floor) ? floor : [floor];
    const fetching = all.map((f) => f.workers.fetchBase()).filter((p) => p !== undefined);
    if (!fetching.length) return go();
    void Promise.all(fetching).then(() => {
      if (c.out || c.ws.readyState !== WebSocket.OPEN || all.some((f) => ctx.floors.get(f.id) !== f)) return;
      go();
    });
  };
  /** Runs `go` with how the office acts on GitHub for `c`: as them, or as itself (no account, or an admin's choice). */
  const withGitHub = (c: Client, go: (as: GhAs | undefined) => void, refused?: (why: string) => void) =>
    withSignIn(
      c,
      'github',
      () => {
        const as = c.accountId ? ctx.signins.ghAs(c.accountId) : undefined;
        if (typeof as !== 'string') return go(as);
        if (refused) refused(as);
        else ctx.warn(c, as);
      },
      refused,
    );
  /** Needs a Claude sign-in of its own when the worker it starts runs Claude. */
  const claudeFor = (provider: string | undefined): SignInKind | undefined => (provider === 'claude' ? 'claude' : undefined);

  return { takeIssue, withSignIn, withFreshBase, withGitHub, claudeFor };
}

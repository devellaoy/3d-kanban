import { WebSocket } from 'ws';
import type { GhAs } from '../signins.js';
import type { Floor } from '../floor.js';
import type { SignInKind } from '../../shared/protocol.js';
import type { Ctx, Gates } from './context.js';
import type { Client } from './client.js';
import { takeCard } from '../take-card.js';
import { hostCredentials, otherHostRepo } from '../hosting/index.js';
import { childEnv } from '../workers/env.js';
import { orgOf } from '../../shared/hosting/remote.js';
import { pickKey, type HostAs, type HostPick, type HostPickRepo } from '../hosting/provider.js';

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
  /**
   * withGitHub for repositories that may be elsewhere: `repos` (undefined for one on GitHub, or on a
   * host the office doesn't know). GitHub's sign-in is asked for only when one of them is on GitHub;
   * for each other host (and Azure DevOps organization), `c`'s token there, else the office's, or
   * they hear what to set. `hosts.git` is the environment the office's own git pushes to those hosts
   * with: theirs (their git config, even with no GitHub sign-in), with the credential helper.
   */
  const withRepos = (c: Client, repos: (HostPickRepo | undefined)[], go: (as: GhAs | undefined, hosts: HostPick) => void, refused?: (why: string) => void) => {
    const creds = hostCredentials();
    const picked = new Map<string, HostAs>();
    for (const r of repos) {
      if (!r || picked.has(pickKey(r))) continue;
      const host = creds?.as(c.accountId, r.host, orgOf(r)) ?? 'The office keeps no credentials yet';
      if (typeof host === 'string') {
        if (refused) refused(host);
        else ctx.warn(c, host);
        ctx.sendTo(c, { t: 'signins.needed', which: r.host, why: host });
        return;
      }
      picked.set(pickKey(r), host);
    }
    const own = picked.size && c.accountId ? ctx.signins.ghAs(c.accountId) : undefined;
    const git = picked.size && creds ? creds.gitEnv({ ...(own && typeof own !== 'string' ? own.env : childEnv()) }, c.accountId) : undefined;
    const hosts: HostPick = { get: (r) => picked.get(pickKey(r)), ...(git ? { git } : {}) };
    if (repos.some((r) => !r)) return withGitHub(c, (as) => go(as, hosts), refused);
    go(undefined, hosts);
  };
  const withRepoHost = (c: Client, board: { hosted?: HostPickRepo }, go: (as: GhAs | undefined, host?: HostAs) => void, refused?: (why: string) => void) => {
    const r = board.hosted;
    withRepos(c, [r], (as, hosts) => go(r ? undefined : as, r ? hosts.get(r) : undefined), refused);
  };
  const withHosts = (c: Client, dirs: string[], go: (as: GhAs | undefined, hosts: HostPick) => void, refused?: (why: string) => void) =>
    withRepos(c, dirs.map((d) => otherHostRepo(d)), go, refused);
  /** Needs a Claude sign-in of its own when the worker it starts runs Claude. */
  const claudeFor = (provider: string | undefined): SignInKind | undefined => (provider === 'claude' ? 'claude' : undefined);

  return { takeIssue, withSignIn, withFreshBase, withGitHub, withRepoHost, withHosts, claudeFor };
}

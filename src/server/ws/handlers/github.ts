// The floor's GitHub boards: refreshing them, and merging, commenting on, closing and labeling
// issues and pull requests, as whoever asks (see withGitHub).
import type { GitHubClientMsg } from '../../../shared/protocol.js';
import { GH_COMMENT_MAX, GH_LABEL_MAX } from '../../../shared/protocol.js';
import { num, str } from '../../office/input.js';
import { ghRepoOf, notInProject } from '../../kanban/office.js';
import { refreshWall } from '../../kanban/integrations/issues/wall.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

// The project's issue sources when it has any, and every repository of the project (see Floor.pullsState).
export const issuesView: ViewPieces['issues'] = (_ctx, floor) => floor?.issuesState() ?? { items: [], fetchedAt: 0, loading: false };
export const pullsView: ViewPieces['pulls'] = (_ctx, floor) => floor?.pullsState() ?? { items: [], fetchedAt: 0, loading: false };

export const githubHandlers = {
  'gh.refresh'(ctx, c) {
    const floor = ctx.floorOf(c);
    void floor?.github.refresh();
    if (floor) refreshWall(floor.id, 0); // the issues board from the project's issue sources, too
  },
  'gh.merge'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !method) return;
    // `repo` for a PR or issue in another of the project's repositories.
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const github = floor.githubFor(ghRepo);
    if (!github) {
      ctx.sendTo(c, { t: 'gh.merged', number: n, ...(ghRepo ? { repo: ghRepo } : {}), error: notInProject(ghRepo) });
      return;
    }
    ctx.withRepoHost(
      c,
      github,
      (as, host) =>
        void github.merge(n, method, msg.deleteBranch === true, msg.auto === true, as).then((error) => {
          ctx.sendTo(c, { t: 'gh.merged', number: n, ...(ghRepo ? { repo: ghRepo } : {}), error });
          if (error) return;
          ctx.toastFloor(floor, msg.auto ? `${who} set PR #${n} to merge once its checks pass` : `🎉 ${who} merged PR #${n}`);
          // An auto-merge rings once GitHub gets round to it and the boards see it merged.
          if (!msg.auto) floor.merged(n, who, ghRepo);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.merged', number: n, ...(ghRepo ? { repo: ghRepo } : {}), error }),
    );
  },
  'gh.comment'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const kind = msg.kind === 'pull' ? 'pull' : 'issue';
    if (!floor || !Number.isSafeInteger(n) || n <= 0) return;
    const body = typeof msg.body === 'string' ? msg.body : '';
    // Refused rather than cut short: a comment that silently lost its end would read as finished.
    const invalid = !body.trim() ? 'The comment is empty' : body.length > GH_COMMENT_MAX ? `GitHub takes comments of up to ${GH_COMMENT_MAX} characters` : '';
    if (invalid) {
      ctx.sendTo(c, { t: 'gh.commented', kind, number: n, error: invalid });
      return;
    }
    // `repo` for a PR or issue in another of the project's repositories.
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const github = floor.githubFor(ghRepo);
    if (!github) {
      ctx.sendTo(c, { t: 'gh.commented', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), error: notInProject(ghRepo) });
      return;
    }
    ctx.withRepoHost(
      c,
      github,
      (as, host) =>
        void github.comment(kind, n, body, as, host).then((r) => {
          ctx.sendTo(c, { t: 'gh.commented', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), ...r });
          if (r.comment) ctx.toastFloor(floor, `💬 ${who} commented on ${kind === 'pull' ? 'PR' : 'issue'} #${n}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.commented', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), error }),
    );
  },
  'gh.reply'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const to = num(msg.to);
    if (!floor || !Number.isSafeInteger(n) || n <= 0) return;
    // `repo` for a PR in another of the project's repositories.
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const answer = (rest: object) => ctx.sendTo(c, { t: 'gh.replied', number: n, ...(ghRepo ? { repo: ghRepo } : {}), to: Number.isSafeInteger(to) ? to : 0, ...rest } as never);
    const body = typeof msg.body === 'string' ? msg.body : '';
    const invalid = !Number.isSafeInteger(to) || to <= 0 ? 'No thread to answer' : !body.trim() ? 'The reply is empty' : body.length > GH_COMMENT_MAX ? `GitHub takes comments of up to ${GH_COMMENT_MAX} characters` : '';
    if (invalid) return answer({ error: invalid });
    const github = floor.githubFor(ghRepo);
    if (!github) return answer({ error: notInProject(ghRepo) });
    ctx.withRepoHost(
      c,
      github,
      (as) =>
        void github.reply(n, to, body, as).then((r) => {
          answer(r);
          if (r.reply) ctx.toastFloor(floor, `💬 ${who} replied on PR #${n}`);
        }),
      (error) => answer({ error }),
    );
  },
  'gh.resolve'(ctx, c, msg) {
    const floor = here(ctx, c);
    const n = num(msg.number);
    if (!floor || !Number.isSafeInteger(n) || n <= 0) return;
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const thread = typeof msg.thread === 'string' ? msg.thread : '';
    const answer = (rest: object) => ctx.sendTo(c, { t: 'gh.resolved', number: n, ...(ghRepo ? { repo: ghRepo } : {}), thread, ...rest } as never);
    if (thread.length < 1 || thread.length > 200 || !/^[A-Za-z0-9_=-]+$/.test(thread)) return answer({ error: 'No thread to resolve' });
    if (typeof msg.resolved !== 'boolean') return answer({ error: 'Say whether to resolve the thread or reopen it' });
    const resolved = msg.resolved;
    const github = floor.githubFor(ghRepo);
    if (!github) return answer({ error: notInProject(ghRepo) });
    ctx.withRepoHost(
      c,
      github,
      (as) => void github.resolveThread(n, thread, resolved, as).then(answer),
      (error) => answer({ error }),
    );
  },
  'gh.close'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) return;
    const reason = msg.reason === 'not planned' ? 'not planned' : 'completed';
    // `repo` for a PR or issue in another of the project's repositories.
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const github = floor.githubFor(ghRepo);
    if (!github) {
      ctx.sendTo(c, { t: 'gh.closed', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), error: notInProject(ghRepo) });
      return;
    }
    ctx.withRepoHost(
      c,
      github,
      (as, host) =>
        void github.close(kind, n, { comment: str(msg.comment, 20000).trim() || undefined, reason, deleteBranch: msg.deleteBranch === true }, as).then((error) => {
          ctx.sendTo(c, { t: 'gh.closed', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), error });
          if (error) return;
          if (kind === 'pull') return ctx.toastFloor(floor, `${who} closed PR #${n} without merging`);
          // Nobody should be seated for an issue that's closed.
          // The queue holds the primary repository's issues only; another repository's #n isn't one of them.
          const dropped = github === floor.github && floor.queue.dropIssue(n);
          refreshWall(floor.id); // the issues board from the project's issue sources, too (after a moment; nothing without any)
          ctx.toastFloor(floor, `${who} closed issue #${n}${reason === 'not planned' ? ' as not planned' : ''}${dropped ? ' and took it off the queue' : ''}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.closed', kind, number: n, ...(ghRepo ? { repo: ghRepo } : {}), error }),
    );
  },
  'gh.labels'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    const n = num(msg.number);
    const kind = msg.kind === 'issue' || msg.kind === 'pull' ? msg.kind : undefined;
    if (!floor || !Number.isSafeInteger(n) || n <= 0 || !kind) return;
    const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((l) => str(l, GH_LABEL_MAX + 1)).filter((l) => l && l.length <= GH_LABEL_MAX))].slice(0, 100);
    const add = names(msg.add);
    const remove = names(msg.remove).filter((l) => !add.includes(l));
    if (!add.length && !remove.length) {
      ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, error: 'No labels to change' });
      return;
    }
    // `repo` for a PR or issue in another of the project's repositories.
    const ghRepo = ghRepoOf((msg as { repo?: unknown }).repo);
    const github = floor.githubFor(ghRepo);
    if (!github) {
      ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, error: notInProject(ghRepo) });
      return;
    }
    ctx.withRepoHost(
      c,
      github,
      (as, host) =>
        void github.setLabels(kind, n, add, remove, as).then((r) => {
          ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, ...r });
          if (r.labels) ctx.toastFloor(floor, `🏷️ ${who} labeled ${kind === 'pull' ? 'PR' : 'issue'} #${n}: ${[...add.map((l) => `+${l}`), ...remove.map((l) => `−${l}`)].join(' ')}`);
        }),
      (error) => ctx.sendTo(c, { t: 'gh.labeled', kind, number: n, error }),
    );
  },
} satisfies HandlerMap<GitHubClientMsg>;

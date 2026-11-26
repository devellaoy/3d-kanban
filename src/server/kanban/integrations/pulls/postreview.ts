// Posts a pull-request review's text on its pull requests (KanbanPullsApi.postReview): the finished review of the pr-review phase, when
// its request had `post`. GitHub gets a COMMENT review (never an approval or a change request), through the board's own `review`, as
// the account that asked; Azure DevOps and Bitbucket get a comment on the conversation (hosting/hosted-board.ts). Nothing here throws.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrRef } from '../../../../shared/kanban/types.js';
import type { KanbanContext } from '../../registry.js';
import { reviewFindings, reviewVerdict, stripWorkDone } from '../../engine/markers.js';

/** GitHub takes a review body of 65,536 characters at most: the body is clipped well under that. */
export const POST_MAX = 60_000;

export interface PostedReview {
  repo: string;
  number: number;
  url?: string;
  error?: string;
}

/**
 * The review as it is posted: "Review by Agent Office: approved" (or "changes requested"), for several pull requests the list of the ones
 * it covers, then the text without its verdict and WORK DONE lines. Cut off, with a line saying so, when it is too long for GitHub.
 */
export function reviewBody(prs: (PrRef & { title?: string })[], text: string): string {
  const verdict = reviewVerdict(text) === 'approved' ? 'approved' : 'changes requested';
  const head = [`**Review by Agent Office: ${verdict}**`];
  if (prs.length > 1) head.push('', 'This review covers:', ...prs.map((p) => `- ${p.repo}#${p.number}${p.title ? ` ${p.title}` : ''}`));
  const top = head.join('\n');
  const cut = '\n\n(The review is cut off here: it is too long to post.)';
  const body = stripWorkDone(reviewFindings(text)) || '(The reviewer gave no findings.)';
  const room = POST_MAX - top.length - 2;
  return `${top}\n\n${body.length > room ? `${body.slice(0, room - cut.length).trimEnd()}${cut}` : body}`;
}

/** Posts `text` on each of `prs`; one result per pull request, a URL or why not. */
export async function postReview(ctx: KanbanContext, project: string, prs: (PrRef & { title?: string })[], text: string, account?: string): Promise<PostedReview[]> {
  const out: PostedReview[] = [];
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'office-review-'));
    const file = path.join(dir, 'review.md');
    await writeFile(file, reviewBody(prs, text), { encoding: 'utf8', mode: 0o600 });
    const floor = ctx.floor(project);
    for (const p of prs) {
      const board = floor?.githubFor(p.repo);
      if (!board) {
        out.push({ repo: p.repo, number: p.number, error: "the project's floor is not open, or has no board for its repository" });
        continue;
      }
      // A repository elsewhere posts with its host's credentials (as the meeting room's review does), GitHub's as the account's gh.
      const as = board.hosted ? undefined : ctx.ghAs?.(account);
      if (typeof as === 'string') {
        out.push({ repo: p.repo, number: p.number, error: as });
        continue;
      }
      try {
        const url = (await board.review(p.number, file, as as Parameters<typeof board.review>[2], account)).trim();
        out.push({ repo: p.repo, number: p.number, ...(url ? { url } : {}) });
      } catch (err) {
        out.push({ repo: p.repo, number: p.number, error: (err as Error).message.split('\n').find((l) => l.trim())?.trim() ?? 'no reason given' });
      }
    }
  } catch (err) {
    // The file could not be made: every pull request that has no result yet did not get one.
    const why = (err as Error).message;
    for (const p of prs) if (!out.some((r) => r.repo === p.repo && r.number === p.number)) out.push({ repo: p.repo, number: p.number, error: why });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return out;
}

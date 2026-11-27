// Posts a pull-request review's text on its pull requests (KanbanPullsApi.postReview): the finished review of the pr-review phase, when
// its request had `post`. GitHub gets a COMMENT review (never an approval or a change request), through the board's own `review`, as
// the account that asked, written in the project's public language (posttexts.ts); Azure DevOps and Bitbucket get a comment on the conversation (hosting/hosted-board.ts). Nothing here throws.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrRef } from '../../../../shared/kanban/types.js';
import type { KanbanContext } from '../../registry.js';
import { resolveLanguages } from '../../../../shared/language.js';
import { postTexts } from './posttexts.js';
import { reviewParts, partKey } from './reviewparts.js';
import { stageImages } from './screenshots.js';
import type { UiImageFile } from '../../engine/uitesting.js';
import { reviewFindings, reviewVerdict, stripWorkDone } from '../../engine/markers.js';

/** GitHub takes a review body of 65,536 characters at most: the body is clipped well under that. */
export const POST_MAX = 60_000;

export interface PostedReview {
  repo: string;
  number: number;
  url?: string;
  error?: string;
  /** What did not go as asked (the pictures could not be attached), though the review is posted. */
  note?: string;
}

/** At most this many pictures go on one comment. */
export const POST_PICTURES = 10;

type Verdict = 'approved' | 'changes_requested';

/**
 * The task's images the reviewer named for `pr`: its part's names (and the common ones; all of them when the text has no parts), kept only
 * when they are the name of an image of the task (or the bare file name of exactly one), in the order given, each once, at most POST_PICTURES.
 * A name that matches nothing is dropped: a path is never taken from the reviewer's text.
 */
export function reviewPictures(pr: PrRef, prs: readonly PrRef[], text: string, images: readonly UiImageFile[] = []): UiImageFile[] {
  if (!images.length) return [];
  const found = reviewParts(prs, stripWorkDone(reviewFindings(text)));
  const names = found.split ? [...found.common.pictures, ...(found.parts.get(partKey(pr))?.pictures ?? [])] : found.common.pictures;
  const out: UiImageFile[] = [];
  for (const n of names) {
    // Never a before picture: only the ones a finding shows in.
    if (/-before\.[a-z]+$/i.test(n)) continue;
    const exact = images.find((i) => i.name === n);
    const bare = images.filter((i) => i.name.split('/').pop() === n);
    const hit = exact ?? (bare.length === 1 ? bare[0] : undefined);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.slice(0, POST_PICTURES);
}

/** The file name an image has next to the body file (screenshots.ts stageImages: a folder's `/` becomes `.`). */
const flatName = (i: UiImageFile): string => i.name.replace('/', '.');

export interface ReviewBodyOpts {
  verdict?: Verdict;
  cut?: boolean;
  language?: string;
  /** The task's UI images: the pictures the reviewer named are put at the end. */
  images?: readonly UiImageFile[];
  /** The file name each picture has next to the body (default: the flat name). */
  ref?: ReadonlyMap<string, string>;
}

/**
 * The review as it is posted on `pr`: "Review: approved" (or "changes requested"), for several pull requests the list of the ones it covers,
 * then the text without its verdict and WORK DONE lines. When the text has a part for each pull request (reviewparts.ts) `pr` gets only its
 * own part (with what came before the first heading), its own verdict when the part has one, and no list. The fixed lines are in `language`
 * (posttexts.ts). Cut off, with a line saying so, when it is too long for GitHub; the pictures the reviewer named close the comment.
 */
export function reviewBody(pr: PrRef, prs: (PrRef & { title?: string })[], text: string, opts: ReviewBodyOpts = {}): string {
  const t = postTexts(opts.language);
  const found = reviewParts(prs, stripWorkDone(reviewFindings(text)));
  const part = found.split ? found.parts.get(partKey(pr)) : undefined;
  // The run's own verdict when it is given: the text may be cut, and a cut one has no verdict line to read.
  const overall = opts.verdict ?? reviewVerdict(text);
  const head = [t.heading((found.split ? part?.verdict ?? overall : overall) === 'approved')];
  if (prs.length > 1 && !found.split) head.push('', t.covers, ...prs.map((p) => `- ${p.repo}#${p.number}${p.title ? ` ${p.title}` : ''}`));
  const top = head.join('\n');
  const pics = reviewPictures(pr, prs, text, opts.images);
  const block = pics.length ? `\n\n${pics.map((i) => `![${i.name}](./${opts.ref?.get(i.name) ?? flatName(i)})`).join('\n')}` : '';
  const cut = `\n\n${t.cutLong}`;
  const own = (found.split ? [found.common.text, part?.text ?? ''].filter(Boolean).join('\n\n') : found.common.text) || t.none;
  const body = own + (opts.cut ? `\n\n${t.cutKept}` : '');
  const room = POST_MAX - top.length - 2 - block.length;
  return `${top}\n\n${body.length > room ? `${body.slice(0, room - cut.length).trimEnd()}${cut}` : body}${block}`;
}

/**
 * Posts `text` on each of `prs`; one result per pull request, a URL or why not. Each gets its own body (reviewBody), written to a folder of its
 * own; the pictures it names (opts.images) are put next to it, and on a GitHub board go as attachments of a conversation comment. When that
 * fails the review is posted without them through `review`, with a `note`. Azure DevOps and Bitbucket never get pictures.
 */
export async function postReview(ctx: KanbanContext, project: string, prs: (PrRef & { title?: string })[], text: string, account?: string, opts: Omit<ReviewBodyOpts, 'language' | 'ref'> = {}): Promise<PostedReview[]> {
  const out: PostedReview[] = [];
  // Before the try: a failure here is no "could not post", and the prompt and the body go by the same language.
  const language = resolveLanguages(ctx.languages(), ctx.settings.project(project)?.publicLanguage).public;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'office-review-'));
    const floor = ctx.floor(project);
    for (const [i, p] of prs.entries()) {
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
        const folder = path.join(dir, `pr-${i}`);
        const pics = board.hosted ? [] : reviewPictures(p, prs, text, opts.images);
        // The folder is made with the pictures in it (flat names), the body beside them: gh finds `./name` next to the body file.
        const staged = await stageImages(folder, pics);
        const file = path.join(folder, 'review.md');
        const base = { ...opts, language, ...(board.hosted ? { images: [] } : {}) };
        await writeFile(file, reviewBody(p, prs, text, { ...base, ref: staged.ref }), { encoding: 'utf8', mode: 0o600 });
        let note: string | undefined;
        let url = '';
        const plain = async () => {
          // Without the picture block: the same body as the one an image-less review gets.
          if (pics.length) await writeFile(file, reviewBody(p, prs, text, { ...base, images: [] }), { encoding: 'utf8', mode: 0o600 });
          return (await board.review(p.number, file, as as Parameters<typeof board.review>[2], account)).trim();
        };
        if (pics.length) {
          try {
            url = (await board.review(p.number, file, as as Parameters<typeof board.review>[2], account, staged.files)).trim();
          } catch (err) {
            note = `the pictures could not be attached: ${firstLine(err)}`;
            url = await plain();
          }
        } else url = await plain();
        out.push({ repo: p.repo, number: p.number, ...(url ? { url } : {}), ...(note ? { note } : {}) });
      } catch (err) {
        out.push({ repo: p.repo, number: p.number, error: firstLine(err) });
      }
    }
  } catch (err) {
    // The folder could not be made: every pull request that has no result yet did not get one.
    const why = (err as Error).message;
    for (const p of prs) if (!out.some((r) => r.repo === p.repo && r.number === p.number)) out.push({ repo: p.repo, number: p.number, error: why });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return out;
}

const firstLine = (err: unknown): string => (err as Error).message.split('\n').find((l) => l.trim())?.trim() ?? 'no reason given';

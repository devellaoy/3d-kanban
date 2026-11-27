// Posts a pull-request review's text on its pull requests (KanbanPullsApi.postReview): the finished review of the pr-review phase, when
// its request had `post`. GitHub gets a COMMENT review (never an approval or a change request), through the board's own `review`, as
// the account that asked, written in the project's public language (posttexts.ts); Azure DevOps and Bitbucket get a comment on the conversation (hosting/hosted-board.ts). Nothing here throws.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrRef } from '../../../../shared/kanban/types.js';
import type { KanbanContext } from '../../registry.js';
import { resolveLanguages } from '../../../../shared/language.js';
import { postTexts } from './posttexts.js';
import { reviewParts, partKey } from './reviewparts.js';
import { stageImages } from './screenshots.js';
import { PicturesNotPosted, PicturesPartly } from '../../../ghattach.js';
import type { UiImageFile } from '../../engine/uitesting.js';
import { reviewFindings, reviewVerdict, stripWorkDone } from '../../engine/markers.js';

/** GitHub takes a review body of 65,536 characters at most: the body is clipped well under that. */
export const POST_MAX = 60_000;

export interface PostedReview {
  repo: string;
  number: number;
  url?: string;
  error?: string;
  /** What did not go as asked (the pictures could not be attached, text that was posted nowhere), beside the URL or the error. */
  note?: string;
}

/** At most this many pictures go on one comment. */
export const POST_PICTURES = 10;

type Verdict = 'approved' | 'changes_requested';

/** What of the review is `pr`'s: the whole text of a review of one pull request, its own part of a review of several (none: nothing is posted on it). */
function ownPart(pr: PrRef, prs: readonly PrRef[], text: string) {
  const found = reviewParts(prs, stripWorkDone(reviewFindings(text)));
  return prs.length > 1 ? found.parts.get(partKey(pr)) : found.common;
}

/** Whether a review of several pull requests has text in no pull request's part: it is posted nowhere, and the task is told. */
export function strayText(prs: readonly PrRef[], text: string): boolean {
  if (prs.length < 2) return false;
  const { common } = reviewParts(prs, stripWorkDone(reviewFindings(text)));
  return !!common.text || common.pictures.length > 0;
}

/**
 * The task's images the reviewer named for `pr` (in its own part of a review of several): a name counts when it is an image's name in the
 * task, its absolute path as the reviewer's prompt lists it, or the bare file name of exactly one image; in the order given, each once, at
 * most POST_PICTURES, and never a before picture. A name that matches nothing is dropped: a path is never taken from the reviewer's text.
 */
export function reviewPictures(pr: PrRef, prs: readonly PrRef[], text: string, images: readonly UiImageFile[] = []): UiImageFile[] {
  if (!images.length) return [];
  const out: UiImageFile[] = [];
  for (const n of ownPart(pr, prs, text)?.pictures ?? []) {
    const exact = images.find((i) => i.name === n || i.file === n);
    const bare = images.filter((i) => i.name.split('/').pop() === n);
    const hit = exact ?? (bare.length === 1 ? bare[0] : undefined);
    // Never a before picture: only the ones a finding shows in.
    if (hit && !/-before\.[a-z]+$/i.test(hit.name) && !out.includes(hit)) out.push(hit);
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
 * The review as it is posted on `pr`: "Review: approved" (or "changes requested"), then the text without its verdict and WORK DONE lines.
 * Of a review of several pull requests `pr` gets only its own part (reviewparts.ts) and its own verdict when the part has one; undefined
 * when the review has no part for it, so nothing that is not plainly about a pull request is ever posted on it. The fixed lines are in
 * `language` (posttexts.ts). Cut off, with a line saying so, when it is too long for GitHub; the pictures the reviewer named close it.
 */
export function reviewBody(pr: PrRef, prs: readonly PrRef[], text: string, opts: ReviewBodyOpts = {}): string | undefined {
  const part = ownPart(pr, prs, text);
  if (!part) return undefined;
  const t = postTexts(opts.language);
  // The run's own verdict when it is given: the text may be cut, and a cut one has no verdict line to read.
  const top = t.heading((part.verdict ?? opts.verdict ?? reviewVerdict(text)) === 'approved');
  const pics = reviewPictures(pr, prs, text, opts.images);
  const block = pics.length ? `\n\n${pics.map((i) => `![${i.name}](./${opts.ref?.get(i.name) ?? flatName(i)})`).join('\n')}` : '';
  const cut = `\n\n${t.cutLong}`;
  const body = (part.text || t.none) + (opts.cut ? `\n\n${t.cutKept}` : '');
  const room = POST_MAX - top.length - 2 - block.length;
  return `${top}\n\n${body.length > room ? `${body.slice(0, room - cut.length).trimEnd()}${cut}` : body}${block}`;
}

const NO_PART = 'the review has no part of its own for this pull request (a heading with its owner/repo#number), so nothing was posted on it';
const STRAY = 'the review has text outside the pull requests\' own parts, which was posted on none of them';

/**
 * Posts `text` on each of `prs`; one result per pull request, a URL or why not. Each gets its own body (reviewBody) in a folder of its own;
 * a pull request the review has no part for gets nothing, and says so. The pictures a part names (opts.images) are put next to the body, and
 * on a GitHub board go as attachments of a conversation comment (ghattach.ts). When the pictures cannot be prepared, or that comment was
 * certainly not made, the review is posted once without them through `review`, with a `note`; when the comment was made with only some of
 * them, that is the post; when nobody knows, nothing more is posted. Azure DevOps and Bitbucket never get pictures.
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
      const plainBody = reviewBody(p, prs, text, { ...opts, language, images: [] });
      if (plainBody === undefined) {
        out.push({ repo: p.repo, number: p.number, error: NO_PART });
        continue;
      }
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
        const file = path.join(folder, 'review.md');
        let pics = board.hosted ? [] : reviewPictures(p, prs, text, opts.images);
        let note: string | undefined;
        let staged: Awaited<ReturnType<typeof stageImages>> | undefined;
        // The folder is made with the pictures in it (flat names), the body beside them: gh finds `./name` next to the body file.
        // A picture that is gone or cannot be read costs the pictures, never the review.
        if (pics.length) {
          try {
            staged = await stageImages(folder, pics);
          } catch (err) {
            note = `the pictures could not be attached: ${firstLine(err)}`;
            pics = [];
          }
        }
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const write = (body: string) => writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
        const plain = async () => (await write(plainBody), (await board.review(p.number, file, as as Parameters<typeof board.review>[2], account)).trim());
        let url = '';
        if (pics.length && staged) {
          await write(reviewBody(p, prs, text, { ...opts, language, ref: staged.ref }) ?? plainBody);
          try {
            url = (await board.review(p.number, file, as as Parameters<typeof board.review>[2], account, staged.files)).trim();
          } catch (err) {
            if (err instanceof PicturesPartly) {
              url = err.url;
              note = `some of the pictures could not be attached: ${firstLine(err)}`;
            } else if (err instanceof PicturesNotPosted) {
              note = `the pictures could not be attached: ${firstLine(err)}`;
              url = await plain();
            } else throw new Error(`the comment with its pictures may or may not have been made (${firstLine(err)}): look at the pull request; nothing more was posted`);
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
  // Said once, on the first pull request's line.
  if (out.length && strayText(prs, text)) out[0] = { ...out[0], note: [out[0].note, STRAY].filter(Boolean).join('; ') };
  return out;
}

const firstLine = (err: unknown): string => (err as Error).message.split('\n').find((l) => l.trim())?.trim() ?? 'no reason given';

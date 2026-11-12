// Putting a task's UI images (before/after, see engine/uitesting.ts) into the description of its pull
// requests. The office does it, not the agent, so the result does not depend on the PR skills, a
// rewritten prompt or the agent's care: `gh pr edit --body-file … --attach …` (gh 2.99 and newer
// uploads each attached file and rewrites the body's `./name` references to the uploaded addresses).
//
// The block sits at the END of the description between two marker comments, the first carrying a
// digest of the images (names, sizes, times). The description is the truth: one whose block has the
// digest of the images now (and no local reference left from a partial upload) needs nothing, one with
// another digest has the block replaced, one without it gets it appended. When every image has been
// removed, the office's block is taken out (without --attach). In memory a mark per pull request, tied
// to the task's latest run, keeps a refresh from asking again: a new run (a PR phase, a fix) may have
// rewritten the description, so it is looked at once more. Nothing here throws; a pull request that
// cannot be edited is told to the task once, not retried on every board refresh, except that a partial
// upload (gh updated the description, then failed some uploads) is tried a few times.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sameRepo } from '../../../../shared/floors.js';
import { pairImages, type KanbanTaskImage } from '../../../../shared/kanban/uitesting.js';
import { gh } from '../../../github.js';
import type { KanbanContext } from '../../registry.js';
import { listUiImages, uiImagesDir, type UiImageFile } from '../../engine/uitesting.js';
import type { GhRunner } from '../issues/source.js';
import { ghEditor, inOrder } from './closes.js';

const OPEN_RE = /<!-- agent-office:screenshots ([0-9a-f]+) -->/;
const BLOCK_RE = /<!-- agent-office:screenshots [0-9a-f]* -->[\s\S]*?<!-- \/agent-office:screenshots -->/;
/** How many times a pull request gh could not show is tried (for one digest) before it is given up on. */
const READ_TRIES = 3;

/** A short digest of the images: their names, sizes and times. */
export function imagesDigest(images: readonly KanbanTaskImage[]): string {
  const h = createHash('sha256');
  for (const i of [...images].sort((a, b) => (a.name < b.name ? -1 : 1))) h.update(`${i.name}\0${i.size}\0${i.mtime}\n`);
  return h.digest('hex').slice(0, 16);
}

/** The description's block for these images: `./name` references, which gh turns into the uploaded files. */
export function screenshotsBlock(images: readonly KanbanTaskImage[]): { digest: string; text: string } {
  const digest = imagesDigest(images);
  const parts = pairImages(images).map((p) => {
    const side = (label: string, i: KanbanTaskImage | undefined) => (i ? [`**${label}**`, '', `![${p.subject} ${label.toLowerCase()}](./${i.name})`, ''] : []);
    return [`### ${p.subject}`, '', ...side('Before', p.before), ...side('After', p.after)].join('\n').trimEnd();
  });
  return { digest, text: [`<!-- agent-office:screenshots ${digest} -->`, '## Screenshots', '', parts.join('\n\n'), '<!-- /agent-office:screenshots -->'].join('\n') };
}

/** The description with `block` in it: the old block replaced, else added at the end. */
export function withScreenshots(body: string, block: string): string {
  if (BLOCK_RE.test(body)) return body.replace(BLOCK_RE, () => block);
  return body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export interface EnsureScreenshots {
  prUrl: string;
  /** The task's images, with their files (listUiImages). */
  images: UiImageFile[];
  /** The images' folder: the description is written there, since gh finds `./name` next to the --body-file. */
  dir: string;
  cwd: string;
  /** gh as the account that opened the pull request (undefined: the office's own sign-in). */
  env?: Record<string, string>;
  run?: GhRunner;
}

export interface EnsuredScreenshots {
  edited: boolean;
  warning?: string;
  /** gh could not show the pull request, or uploaded only some of the images: asking again later may work. */
  retry?: boolean;
  /** The block was taken out (every image is gone). */
  removed?: true;
}

/** The description without the office's block, and the blank lines it leaves: the human text around it is kept as it was. */
export function withoutScreenshots(body: string): string {
  const m = BLOCK_RE.exec(body);
  if (!m) return body;
  const before = body.slice(0, m.index);
  const after = body.slice(m.index + m[0].length);
  if (!after.trim()) return before.trim() ? `${before.trimEnd()}\n` : '';
  return before.trim() ? `${before.trimEnd()}\n\n${after.trimStart()}` : after.trimStart();
}

/** How long gh may take to upload these: a minute, and more for each image and megabyte, at most ten minutes. */
export function editTimeout(images: readonly KanbanTaskImage[]): number {
  const mb = images.reduce((n, i) => n + i.size, 0) / (1024 * 1024);
  return Math.min(600_000, Math.round(60_000 + images.length * 10_000 + mb * 3_000));
}

/** Puts the images into the pull request's description unless the digest there is theirs already. */
export async function ensureScreenshots(o: EnsureScreenshots): Promise<EnsuredScreenshots> {
  const run = o.run ?? gh;
  const { digest, text } = o.images.length ? screenshotsBlock(o.images) : { digest: '', text: '' };
  let tmp: string | undefined;
  try {
    let view: { body?: unknown; updatedAt?: unknown };
    try {
      view = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env)) as typeof view;
    } catch (err) {
      return { edited: false, retry: true, warning: `Couldn't read ${o.prUrl}: ${(err as Error).message}` };
    }
    const body = typeof view.body === 'string' ? view.body : '';
    const gone = !o.images.length;
    if (gone && !BLOCK_RE.test(body)) return { edited: false };
    // Done only when the block is this set's and gh rewrote every reference: a partial upload leaves `](./name)` behind.
    const have = BLOCK_RE.exec(body)?.[0] ?? '';
    if (!gone && OPEN_RE.exec(have)?.[1] === digest && !have.includes('](./')) return { edited: false };
    tmp = path.join(o.dir, `.pr-body-${randomBytes(6).toString('hex')}.md`);
    await writeFile(tmp, gone ? withoutScreenshots(body) : withScreenshots(body, text), { mode: 0o600 });
    // Someone may have edited the description since it was read: theirs isn't overwritten, it's looked at again.
    const again = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env)) as typeof view;
    if (again.body !== view.body || again.updatedAt !== view.updatedAt) return { edited: false, retry: true, warning: `Couldn't ${gone ? 'take the screenshots out of' : 'add the screenshots to'} ${o.prUrl}: the description kept changing` };
    try {
      await run(['pr', 'edit', o.prUrl, '--body-file', tmp, ...o.images.flatMap((i) => ['--attach', i.file])], o.cwd, editTimeout(o.images), o.env);
    } catch (err) {
      // gh may have written the description and failed some uploads: then it carries our block, and a later try finishes the job.
      const now = await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env).then((t) => (JSON.parse(t) as { body?: unknown }).body, () => undefined);
      const carries = (t: string) => OPEN_RE.exec(BLOCK_RE.exec(t)?.[0] ?? '')?.[1] === digest;
      if (!gone && typeof now === 'string' && carries(now) && (now !== view.body || carries(body))) {
        return { edited: false, retry: true, warning: `Some of the screenshots could not be uploaded to ${o.prUrl}: ${(err as Error).message}` };
      }
      throw err;
    }
    return gone ? { edited: true, removed: true } : { edited: true };
  } catch (err) {
    return { edited: false, warning: `Couldn't ${o.images.length ? 'add the screenshots to' : 'take the screenshots out of'} ${o.prUrl}: ${(err as Error).message}. ${o.images.length ? 'Adding them needs gh 2.99 or newer (gh pr edit --attach) and' : 'Editing it needs'} write access to the repository.` };
  } finally {
    if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** What checkScreenshots knows of a pull request: the digest it last dealt with, the tries so far and whether it is done with it. */
export interface ScreenshotMark {
  /** The project whose refresh made it: a refresh only prunes its own. */
  project: string;
  /** The task's latest run when it was dealt with: a later run may have rewritten the description. */
  runId?: number;
  /** The digest of the images, or 'none' for no images (the block to be taken out). */
  digest: string;
  tries: number;
  done?: true;
}

/** The digest of an image set; 'none' for the empty one. */
const setDigest = (images: readonly KanbanTaskImage[]) => (images.length ? imagesDigest(images) : 'none');

/** Only github.com pull requests: https://github.com/<owner>/<repo>/pull/<n> (no GitHub Enterprise hosts, no other forges). */
const isGithubPr = (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);

/**
 * For each task whose pull requests the office opened (`prRequested`) and that has no run going: every
 * open GitHub pull request off the task's own branches gets the task's images (ensureScreenshots), once
 * per digest. A lone "after" counts. Fire and forget; what it did, or couldn't, goes on the task as a status comment.
 */
export function checkScreenshots(ctx: KanbanContext, project: string, marks: Map<string, ScreenshotMark>, io: { run: GhRunner }): void {
  const seen = new Set<string>();
  const repos = ctx.repos(project);
  for (const task of ctx.repo.listTasks(project)) {
    if (!task.flags.prRequested || task.runState !== 'idle') continue;
    const branches = new Set([task.branch, ...Object.values(ctx.repo.repoBranches(task.id))]);
    const prs = ctx.repo.prLinksOfProject(project)
      .filter((l) => (l.state === 'OPEN' || l.state === 'DRAFT') && l.taskId === task.id && isGithubPr(l.url))
      .filter((l) => !!l.branch && branches.has(l.branch) && repos.some((r) => sameRepo(r.remote, l.repo ?? repos.find((x) => x.id === l.repoId)?.remote)));
    if (!prs.length) continue;
    const dir = uiImagesDir(ctx.filesDir, task.id);
    const images = listUiImages(dir);
    // No images and no images folder: the task never had any, so there is no block of ours to take out and nothing to ask.
    if (!images.length && !existsSync(dir)) continue;
    const digest = setDigest(images);
    const runId = ctx.repo.latestRunId(task.id);
    for (const pr of prs) {
      seen.add(pr.url);
      const was = marks.get(pr.url);
      const same = was?.digest === digest && was.runId === runId;
      if (same && was.done) continue;
      const tries = (same ? was.tries : 0) + 1;
      // Marked at once, so the next refresh does not queue it again while it runs.
      marks.set(pr.url, { project, runId, digest, tries, done: true });
      inOrder(pr.url, () => screenshotOne(ctx, project, task.id, pr.url, digest, runId, tries, marks, io));
    }
  }
  for (const [url, m] of marks) if (m.project === project && !seen.has(url)) marks.delete(url);
}

/** One pull request's job, when its turn comes: from the task as it is then. */
async function screenshotOne(ctx: KanbanContext, project: string, taskId: number, url: string, digest: string, runId: number | undefined, tries: number, marks: Map<string, ScreenshotMark>, io: { run: GhRunner }): Promise<void> {
  const task = ctx.repo.listTasks(project).find((t) => t.id === taskId);
  if (!task || task.runState !== 'idle') return void marks.delete(url);
  const dir = uiImagesDir(ctx.filesDir, taskId);
  const images = listUiImages(dir);
  // The images changed since it was queued: a later pass deals with them.
  if (setDigest(images) !== digest) return void marks.delete(url);
  const editor = ghEditor(ctx.ghAs?.(task.createdByAccount));
  const r: EnsuredScreenshots = 'warning' in editor
    ? { edited: false, warning: `Not adding the screenshots to ${url}: ${editor.warning}` }
    : await ensureScreenshots({ prUrl: url, images, dir, cwd: ctx.dataDir, env: editor.env, run: io.run });
  if (r.retry && tries < READ_TRIES) return void marks.set(url, { project, runId, digest, tries });
  marks.set(url, { project, runId, digest, tries, done: true });
  const text = r.warning ?? (r.removed ? `Took the screenshots out of the description of ${url}` : r.edited ? `Added ${images.length} screenshot${images.length === 1 ? '' : 's'} to the description of ${url}` : '');
  if (!text) return;
  ctx.repo.addComment({ taskId, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
  ctx.taskChanged(taskId);
}

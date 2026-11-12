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
//
// In a task with several repositories an image saved in `ui/<repoId>/` belongs to that repository's pull
// request(s) (assignShots has the rule); each pull request has its own set and digest. gh's references stay
// flat (`./name` next to the body file): a set with folder images is staged in a temporary folder first.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sameRepo } from '../../../../shared/floors.js';
import type { KanbanPrLink, KanbanTask, ProjectRepo } from '../../../../shared/kanban/types.js';
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

/** The version of the block's layout (2: a subject's before and after side by side in a table). */
const BLOCK_LAYOUT = 2;

/** A short digest of the images: their names, sizes and times. */
export function imagesDigest(images: readonly KanbanTaskImage[]): string {
  const h = createHash('sha256');
  // The block's layout is part of it, so a description laid out the old way is written again.
  h.update(`layout ${BLOCK_LAYOUT}\n`);
  for (const i of [...images].sort((a, b) => (a.name < b.name ? -1 : 1))) h.update(`${i.name}\0${i.size}\0${i.mtime}\n`);
  return h.digest('hex').slice(0, 16);
}

/** How a block names the images: for a pull request of repository `repoId`, a pair from another repository's folder gets that repository's name (`names`) in its heading; `ref` is the reference to an image's file when it is not its name. */
export interface BlockOpts {
  repoId?: string;
  names?: ReadonlyMap<string, string>;
  ref?: ReadonlyMap<string, string>;
}

/** The description's block for these images: `./name` references, which gh turns into the uploaded files. The digest is of the images as they are in the task, whatever the references. */
export function screenshotsBlock(images: readonly KanbanTaskImage[], o: BlockOpts = {}): { digest: string; text: string } {
  const digest = imagesDigest(images);
  const parts = pairImages(images).map((p) => {
    // A table row holds the before and the after side by side, each half the width; a lone one has the row to itself.
    const sides = [...(p.before ? [['Before', p.before] as const] : []), ...(p.after ? [['After', p.after] as const] : [])];
    const cell = ([label, i]: readonly [string, KanbanTaskImage]) => `![${p.subject} ${label.toLowerCase()}](./${o.ref?.get(i.name) ?? i.name})`;
    const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const from = p.repo && p.repo !== o.repoId ? ` (${o.names?.get(p.repo) ?? p.repo})` : '';
    return [`### ${p.subject}${from}`, '', row(sides.map(([label]) => label)), row(sides.map(() => ':---:')), row(sides.map(cell))].join('\n');
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
  /** The repository (ProjectRepo.id) the pull request is in, and the names of the project's repositories: for the headings of another repository's pictures. */
  repoId?: string;
  names?: ReadonlyMap<string, string>;
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

/**
 * The description without the office's block. Only the block and the line breaks that set it apart go:
 * spaces are Markdown (an indented code block after it, a hard break's two spaces before it), so the
 * text around it keeps every one of them.
 */
export function withoutScreenshots(body: string): string {
  const m = BLOCK_RE.exec(body);
  if (!m) return body;
  const before = body.slice(0, m.index).replace(/(?:\r?\n)+$/, '');
  const after = body.slice(m.index + m[0].length).replace(/^(?:\r?\n)+/, '');
  if (!after.trim()) return before.trim() ? `${before}\n` : '';
  return before.trim() ? `${before}\n\n${after}` : after;
}

/** How long gh may take to upload these: a minute, and more for each image and megabyte, at most ten minutes. */
export function editTimeout(images: readonly KanbanTaskImage[]): number {
  const mb = images.reduce((n, i) => n + i.size, 0) / (1024 * 1024);
  return Math.min(600_000, Math.round(60_000 + images.length * 10_000 + mb * 3_000));
}

/**
 * The images as flat files in `stage` (made here): hard links, else copies, named `<folder>.<file>` for an
 * image from a repository's folder (a number before the extension when that name is taken). Returns the
 * files and the reference to each image by its name in the task.
 */
async function stageImages(stage: string, images: readonly UiImageFile[]): Promise<{ files: string[]; ref: Map<string, string> }> {
  await mkdir(stage, { mode: 0o700 });
  const ref = new Map<string, string>();
  const taken = new Set<string>();
  const files: string[] = [];
  for (const i of images) {
    const flat = i.name.replace('/', '.');
    let name = flat;
    for (let n = 2; taken.has(name); n++) name = flat.replace(/(\.[a-z]+)$/, `-${n}$1`);
    taken.add(name);
    const to = path.join(stage, name);
    await link(i.file, to).catch(() => copyFile(i.file, to));
    ref.set(i.name, name);
    files.push(to);
  }
  return { files, ref };
}

/** Puts the images into the pull request's description unless the digest there is theirs already. */
export async function ensureScreenshots(o: EnsureScreenshots): Promise<EnsuredScreenshots> {
  const run = o.run ?? gh;
  const digest = o.images.length ? imagesDigest(o.images) : '';
  let tmp: string | undefined;
  let stage: string | undefined;
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
    // gh finds `./name` next to the body file, so pictures from repository folders are staged flat first.
    let files = o.images.map((i) => i.file);
    let ref: Map<string, string> | undefined;
    if (!gone && o.images.some((i) => i.repo)) {
      stage = path.join(o.dir, `.pr-${randomBytes(6).toString('hex')}`);
      ({ files, ref } = await stageImages(stage, o.images));
    }
    const text = gone ? '' : screenshotsBlock(o.images, { repoId: o.repoId, names: o.names, ref }).text;
    tmp = path.join(stage ?? o.dir, `.pr-body-${randomBytes(6).toString('hex')}.md`);
    await writeFile(tmp, gone ? withoutScreenshots(body) : withScreenshots(body, text), { mode: 0o600 });
    // Someone may have edited the description since it was read: theirs isn't overwritten, it's looked at again.
    const again = JSON.parse(await run(['pr', 'view', o.prUrl, '--json', 'body,updatedAt'], o.cwd, 30_000, o.env)) as typeof view;
    if (again.body !== view.body || again.updatedAt !== view.updatedAt) return { edited: false, retry: true, warning: `Couldn't ${gone ? 'take the screenshots out of' : 'add the screenshots to'} ${o.prUrl}: the description kept changing` };
    try {
      await run(['pr', 'edit', o.prUrl, '--body-file', tmp, ...files.flatMap((f) => ['--attach', f])], o.cwd, editTimeout(o.images), o.env);
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
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
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

/** Where each of a task's images goes: for every open or draft GitHub pull request (the keys), its own images, in the order given. */
export function assignShots(images: readonly UiImageFile[], links: readonly KanbanPrLink[], repos: readonly ProjectRepo[], opts: { fallback?: boolean } = {}): Map<string, UiImageFile[]> {
  const targets = links.filter((l) => open(l) && isGithubPr(l.url));
  const out = new Map<string, UiImageFile[]>(targets.map((l) => [l.url, []]));
  const rank = (l: KanbanPrLink) => (repos.some((r) => r.id === l.repoId) ? repos.findIndex((r) => r.id === l.repoId) : repos.length);
  // The pull request an image whose own repository has none goes to: the primary repository's, else the first by the project's order.
  const fallback = targets.find((l) => repos.find((r) => r.id === l.repoId)?.primary) ?? [...targets].sort((a, b) => rank(a) - rank(b))[0];
  for (const img of images) {
    const home = img.repo && repos.some((r) => r.id === img.repo) ? links.filter((l) => l.repoId === img.repo) : undefined;
    // Straight in the folder, or in one that is no repository of the project: every pull request, as when the task had one repository.
    const to = !home ? targets : targets.filter((l) => l.repoId === img.repo);
    if (to.length) for (const l of to) out.get(l.url)!.push(img);
    // Its repository's pull request is merged (or open at another host): the picture is done with; it must not turn up in another repository's.
    else if (opts.fallback !== false && home && !home.some((l) => open(l) || l.state === 'MERGED') && fallback) out.get(fallback.url)!.push(img);
  }
  return out;
}

const open = (l: KanbanPrLink) => l.state === 'OPEN' || l.state === 'DRAFT';

/** The images that only the fallback would take: their repository has no pull request (or a closed one) while another has an open GitHub one. */
export function fallbackShots(images: readonly UiImageFile[], links: readonly KanbanPrLink[], repos: readonly ProjectRepo[]): UiImageFile[] {
  const withIt = assignShots(images, links, repos);
  const without = new Set([...assignShots(images, links, repos, { fallback: false })].flatMap(([, v]) => v.map((i) => i.name)));
  return images.filter((i) => !without.has(i.name) && [...withIt.values()].some((v) => v.includes(i)));
}

/** How long an image waits for its own repository's pull request to show up before another repository's takes it: pull requests are linked per repository, a poll apart. */
export const FALLBACK_WAIT_MS = 3 * 60_000;
/** Per marks map: when a task (project/id) was first seen with an image waiting for the fallback. In memory, like the marks. */
const waiting = new WeakMap<object, Map<string, number>>();

/** The task's pull requests off its own branches in the project's repositories, in any state. */
function taskLinks(ctx: KanbanContext, project: string, task: KanbanTask, repos: readonly ProjectRepo[]): (KanbanPrLink & { taskId: number })[] {
  const branches = new Set([task.branch, ...Object.values(ctx.repo.repoBranches(task.id))]);
  return ctx.repo.prLinksOfProject(project)
    .filter((l) => l.taskId === task.id && !!l.branch && branches.has(l.branch) && repos.some((r) => sameRepo(r.remote, l.repo ?? repos.find((x) => x.id === l.repoId)?.remote)));
}

/**
 * For each task whose pull requests the office opened (`prRequested`) and that has no run going: every
 * open GitHub pull request off the task's own branches gets its share of the task's images (assignShots;
 * all of them in a task with one repository), once per digest of that share. A lone "after" counts. Fire
 * and forget; what it did, or couldn't, goes on the task as a status comment.
 */
export function checkScreenshots(ctx: KanbanContext, project: string, marks: Map<string, ScreenshotMark>, io: { run: GhRunner; now?: () => number }): void {
  const seen = new Set<string>();
  const since = waiting.get(marks) ?? waiting.set(marks, new Map()).get(marks)!;
  const tasks = new Set<string>();
  const repos = ctx.repos(project);
  for (const task of ctx.repo.listTasks(project)) {
    if (!task.flags.prRequested || task.runState !== 'idle') continue;
    const all = listUiImages(uiImagesDir(ctx.filesDir, task.id), repos.map((r) => r.id));
    const links = taskLinks(ctx, project, task, repos);
    // The fallback only takes pictures whose repository has had no pull request for a while.
    const key = `${project}/${task.id}`;
    let fallback = false;
    if (fallbackShots(all, links, repos).length) {
      const now = (io.now ?? Date.now)();
      tasks.add(key);
      if (!since.has(key)) since.set(key, now);
      fallback = now - since.get(key)! >= FALLBACK_WAIT_MS;
    }
    const shares = assignShots(all, links, repos, { fallback });
    if (!shares.size) continue;
    const dir = uiImagesDir(ctx.filesDir, task.id);
    // No images and no images folder: the task never had any, so there is no block of ours to take out and nothing to ask.
    if (!existsSync(dir) && ![...shares.values()].some((v) => v.length)) continue;
    const runId = ctx.repo.latestRunId(task.id);
    for (const [url, own] of shares) {
      const digest = setDigest(own);
      seen.add(url);
      const was = marks.get(url);
      const same = was?.digest === digest && was.runId === runId;
      if (same && was.done) continue;
      const tries = (same ? was.tries : 0) + 1;
      // Marked at once, so the next refresh does not queue it again while it runs.
      marks.set(url, { project, runId, digest, tries, done: true });
      inOrder(url, () => screenshotOne(ctx, project, task.id, url, digest, runId, tries, fallback, marks, io));
    }
  }
  for (const [url, m] of marks) if (m.project === project && !seen.has(url)) marks.delete(url);
  for (const key of since.keys()) if (key.startsWith(`${project}/`) && !tasks.has(key)) since.delete(key);
}

/** One pull request's job, when its turn comes: from the task as it is then. */
async function screenshotOne(ctx: KanbanContext, project: string, taskId: number, url: string, digest: string, runId: number | undefined, tries: number, fallback: boolean, marks: Map<string, ScreenshotMark>, io: { run: GhRunner }): Promise<void> {
  const task = ctx.repo.listTasks(project).find((t) => t.id === taskId);
  if (!task || task.runState !== 'idle') return void marks.delete(url);
  const dir = uiImagesDir(ctx.filesDir, taskId);
  const repos = ctx.repos(project);
  const links = taskLinks(ctx, project, task, repos);
  const images = assignShots(listUiImages(dir, repos.map((r) => r.id)), links, repos, { fallback }).get(url);
  // The images (or the pull requests) changed since it was queued: a later pass deals with them.
  if (!images || setDigest(images) !== digest) return void marks.delete(url);
  const editor = ghEditor(ctx.ghAs?.(task.createdByAccount));
  const r: EnsuredScreenshots = 'warning' in editor
    ? { edited: false, warning: `Not adding the screenshots to ${url}: ${editor.warning}` }
    : await ensureScreenshots({ prUrl: url, images, dir, cwd: ctx.dataDir, repoId: links.find((l) => l.url === url)?.repoId, names: new Map(repos.map((x) => [x.id, x.name])), env: editor.env, run: io.run });
  if (r.retry && tries < READ_TRIES) return void marks.set(url, { project, runId, digest, tries });
  marks.set(url, { project, runId, digest, tries, done: true });
  const text = r.warning ?? (r.removed ? `Took the screenshots out of the description of ${url}` : r.edited ? `Added ${images.length} screenshot${images.length === 1 ? '' : 's'} to the description of ${url}` : '');
  if (!text) return;
  ctx.repo.addComment({ taskId, authorKind: 'system', authorName: 'Kanban', kind: 'status', text });
  ctx.taskChanged(taskId);
}

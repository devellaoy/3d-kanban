// The picture part of an agent's ticket read (agent-read.ts): the ticket's image attachments are downloaded with the
// office's own Jira connection into the asking task's grant folder (<grants>/task-N/jira-images/<KEY>/) and the answer
// names their files. The download address is always built here from the source's site and the attachment id, never taken
// from Jira's `content` / `thumbnail` links, so the sign-in header can't go to another host. Nothing is deleted during a
// read (a path given earlier stays good); the folder goes when the task is done or archived (removeIssueImages).

import { mkdirSync, readdirSync, renameSync, rmSync, lstatSync, realpathSync, writeFileSync, chmodSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { JiraAt } from '../../../../shared/kanban/jira-connections.js';
import { displayName, grantDir, storedName } from '../../uploads.js';
import { jiraAuthHeader, pickJiraConnection } from './jira-auth.js';
import type { RawComment } from './jira-ops.js';
import type { IssueActIo } from './source.js';
import { JIRA_KEY_RE } from './browse/jql.js';

const MB = 1024 * 1024;
/** What one read brings of a ticket's pictures; agent-read.ts shows them in ISSUE_READ_LIMITS. */
export const ISSUE_IMAGE_LIMITS = { images: 10, imageBytes: 5 * MB, imagesBytes: 20 * MB, imagesSkipped: 20, taskImagesBytes: 150 * MB } as const;

/** The deadline of the whole picture step (the CLI waits 75 s for the answer); a test shortens it. */
export const imageStep = { deadlineMs: 25_000 };

const PARALLEL = 4;
const NAME_SHOWN = 100;
const SUBDIR = 'jira-images';
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const UUID_RE = /\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const UUID_MAX = 2000;
const KEPT_NAME_RE = /^\d{1,20}-[\w.-]{1,100}\.(png|jpg|gif|webp)$/;

export interface IssueImage { name: string; file: string; path: string; bytes: number; type: string }
export interface SkippedImage { name: string; reason: string }
export interface ImageResult {
  images: IssueImage[];
  skipped: SkippedImage[];
  more: boolean;
  /** Downloads that failed (not limits): the errors, for the answer's note. */
  failures: unknown[];
  /** Plain notes (no task to keep the pictures in). */
  notes: string[];
  /** The file a media node stands for, when it can be joined to one. */
  media: (attrs: Record<string, unknown>) => string | undefined;
}

/** An error whose text is the office's own and fit for the agent. */
export class ImageStepError extends Error {}
class DeadlineError extends ImageStepError {}

const TYPES: Record<string, { ext: string; type: string }> = { png: { ext: 'png', type: 'image/png' }, jpg: { ext: 'jpg', type: 'image/jpeg' }, gif: { ext: 'gif', type: 'image/gif' }, webp: { ext: 'webp', type: 'image/webp' } };

/** What the first bytes say the file is (never Jira's word for it). */
function sniff(b: Uint8Array): { ext: string; type: string } | undefined {
  const at = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return TYPES.png;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return TYPES.jpg;
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return TYPES.gif;
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return TYPES.webp;
  return undefined;
}

const oneLine = (s: string) => displayName(s).replace(/[\u0080-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_SHOWN);

interface Att { id: string; filename: string; mime: string; size?: number; created: number }

/** The attachments' fields that matter, whatever else Jira sent. */
function attachmentsOf(raw: unknown): { filename: string; valid?: Att }[] {
  const all: { filename: string; valid?: Att }[] = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const filename = typeof r.filename === 'string' ? r.filename : '';
    const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : '';
    const mime = typeof r.mimeType === 'string' ? r.mimeType.toLowerCase() : '';
    const created = typeof r.created === 'string' ? Date.parse(r.created) : NaN;
    all.push({ filename, ...(/^\d{1,20}$/.test(id) && MEDIA_TYPES.has(mime) ? { valid: { id, filename, mime, ...(typeof r.size === 'number' && r.size >= 0 ? { size: r.size } : {}), created: Number.isNaN(created) ? 0 : created } } : {}) });
  }
  return all;
}

/** Every media node of an ADF document (type `file`: a Jira attachment). */
function mediaNodes(doc: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (!doc || typeof doc !== 'object' || depth > 40) return out;
  const n = doc as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if ((n.type === 'media' || n.type === 'mediaInline') && n.attrs && n.attrs.type !== 'link' && n.attrs.type !== 'external') out.push(n.attrs);
  for (const k of Array.isArray(n.content) ? n.content : []) mediaNodes(k, out, depth + 1);
  return out;
}

class TooBig extends Error {}

/** The body of a response with a hard byte cap (Jira's `size` isn't trusted). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length'));
  if (len > cap) {
    void res.body?.cancel().catch(() => {});
    throw new TooBig();
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > cap) throw new TooBig();
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      void reader.cancel().catch(() => {});
      throw new TooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The folder's size in bytes (regular files under real folders only: a link planted by the worker is never followed). */
function folderBytes(dir: string): number {
  let sum = 0;
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) {
          if (depth < 3) walk(p, depth + 1);
        } else if (st.isFile()) sum += st.size;
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk(dir, 0);
  return sum;
}

/** A file kept earlier for this attachment (same id and byte count as Jira says): its name and type. */
function kept(dir: string, id: string, size: number | undefined): { file: string; type: string; bytes: number } | undefined {
  if (size === undefined) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const file of names) {
    // Only a name of the shape the office writes itself: it goes into the answer and the `[image: …]` placeholder.
    if (!file.startsWith(`${id}-`) || !KEPT_NAME_RE.test(file)) continue;
    const t = TYPES[path.extname(file).slice(1)];
    if (!t) continue;
    try {
      const p = path.join(dir, file);
      // A regular file only: a link planted at the name is never reused.
      const st = lstatSync(p);
      if (!st.isFile() || st.size !== size) continue;
      const head = Buffer.alloc(12);
      const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        readSync(fd, head, 0, 12, 0);
      } finally {
        closeSync(fd);
      }
      if (sniff(head)?.type === t.type) return { file, type: t.type, bytes: size };
    } catch {
      /* not usable: downloaded again */
    }
  }
  return undefined;
}

/** attachment id → media uuid, by site, as the office found it out (bounded; a uuid never changes under an id). */
const uuids = new Map<string, string>();
const remember = (k: string, v: string) => {
  if (uuids.size >= UUID_MAX) uuids.delete(uuids.keys().next().value as string);
  uuids.set(k, v);
};

/**
 * Bytes written by the reads of a task that are running at once (task id → bytes, and how many reads run). The 150 MB cap
 * of a task is checked against the folder as measured at the start of a read plus these, synchronously, so parallel reads
 * can't all pass it on the same free space. The count is dropped when the last of the task's reads ends (a later read
 * measures the folder afresh). A file may be counted twice (measured and reserved), never missed; the one thing that can
 * overshoot is a read that measured just before another one's reservation, by at most that one read's pictures (20 MB).
 */
const reserved = new Map<number, { bytes: number; reads: number }>();
const held = (taskId: number) => reserved.get(taskId)?.bytes ?? 0;
const enter = (taskId: number) => reserved.set(taskId, { bytes: held(taskId), reads: (reserved.get(taskId)?.reads ?? 0) + 1 });
const reserve = (taskId: number, n: number) => (reserved.get(taskId)!.bytes += n);
const leave = (taskId: number) => {
  const r = reserved.get(taskId);
  if (r && r.reads > 1) r.reads -= 1;
  else reserved.delete(taskId);
};

const NOT_PLAIN = "The task's image folder isn't a plain folder of the office's own, so nothing was saved there";

/**
 * Makes sure the task's grant folder, `jira-images` and the key's folder are real directories (never links; the worker can
 * write in the grant folder) and that the key's folder resolves inside the grant folder. With `create` missing ones are
 * made (mode 700) and the office's own folders are set to 700; without it false says there is nothing yet.
 */
function realDirs(grant: string, root: string, dir: string, create: boolean): boolean {
  try {
    for (const p of [grant, root, dir]) {
      let st;
      try {
        st = lstatSync(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!create) return false;
        mkdirSync(p, { mode: 0o700, recursive: p === grant });
        st = lstatSync(p);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new ImageStepError(NOT_PLAIN);
    }
    const inside = path.relative(realpathSync(grant), realpathSync(dir));
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new ImageStepError(NOT_PLAIN);
    if (create) for (const p of [grant, root, dir]) chmodSync(p, 0o700);
    return true;
  } catch (err) {
    if (err instanceof ImageStepError) throw err;
    throw new ImageStepError("The task's image folder couldn't be made");
  }
}

export interface ImageArgs {
  /** The asking worker's task (it must exist); without one nothing is downloaded. */
  taskId?: number;
  /** The task is done or archived: nothing is downloaded (its pictures are removed, new ones would linger). */
  taskClosed?: boolean;
  filesDir: string;
  key: string;
  /** `fields.attachment` as Jira sent it, and the description's ADF. */
  attachments: unknown;
  description: unknown;
  /** The ticket's comments, raw: their media nodes are joined too (a failure there only costs that). */
  comments: Promise<RawComment[]>;
  /** What an error says to the agent (agent-read.ts: from the HTTP status, never Jira's text). */
  describe: (err: unknown) => string;
}

const timedOut = (e: unknown) => (e as { name?: string })?.name === 'TimeoutError' || (e as { name?: string })?.name === 'AbortError' || e instanceof DeadlineError;

/**
 * Downloads the ticket's image attachments (the first 10, referenced ones first, then the newest) and joins the media
 * nodes of the description and comments to them. Resolves within the deadline; what didn't finish is `timed out`.
 */
export async function issueImages(io: IssueActIo, at: JiraAt, a: ImageArgs): Promise<ImageResult> {
  const all = attachmentsOf(a.attachments);
  const result: ImageResult = { images: [], skipped: [], more: false, failures: [], notes: [], media: () => undefined };
  if (!all.length) return result;
  const skippedAll: SkippedImage[] = [];
  const valid = all.flatMap((x) => (x.valid ? [x.valid] : []));
  for (const x of all) if (!x.valid) skippedAll.push({ name: oneLine(x.filename), reason: 'not an image' });
  const finish = (): ImageResult => {
    result.skipped = skippedAll.slice(0, ISSUE_IMAGE_LIMITS.imagesSkipped);
    result.more = skippedAll.length > ISSUE_IMAGE_LIMITS.imagesSkipped;
    return result;
  };
  if (!valid.length) return finish();
  if (a.taskId === undefined) {
    result.notes.push("The ticket has picture attachments, but they weren't downloaded: your worker has no task to keep them with");
    return finish();
  }
  if (a.taskClosed) {
    result.notes.push("The ticket has picture attachments, but they weren't downloaded: your task is done or archived");
    return finish();
  }
  if (!JIRA_KEY_RE.test(a.key)) throw new ImageStepError('The ticket key is not one the office stores pictures under');

  const taskId = a.taskId;
  const startedAt = Date.now();
  const left = () => Math.max(0, imageStep.deadlineMs - (Date.now() - startedAt));
  const conn = pickJiraConnection(io.jira, at);
  const base = `https://${conn.site}/rest/api/3/attachment/content/`;
  const auth = jiraAuthHeader(conn);
  const grant = path.resolve(grantDir(a.filesDir, taskId));
  const root = path.join(grant, SUBDIR);
  const dir = path.join(root, a.key.toUpperCase());
  // A link or odd entry in the way fails the whole picture step, before anything is read from or written there.
  const there = realDirs(grant, root, dir, false);

  // Which ones are asked for: the ones the description points at (alt = file name), then the newest.
  const descMedia = mediaNodes(a.description);
  const cited = new Set(descMedia.map((m) => m.alt).filter((x): x is string => typeof x === 'string'));
  const ordered = [...valid].sort((x, y) => Number(cited.has(y.filename)) - Number(cited.has(x.filename)) || y.created - x.created);

  type Done = { att: Att; image: IssueImage };
  const done: Done[] = [];
  const plan: Att[] = [];
  let planned = 0;
  let folder = 0;
  let closed = false;
  const skip = (att: Att, reason: string) => {
    settled.add(att);
    skippedAll.push({ name: oneLine(att.filename), reason });
  };
  const settled = new Set<Att>();

  for (const att of ordered) {
    if (att.size !== undefined && att.size > ISSUE_IMAGE_LIMITS.imageBytes) skip(att, 'too big');
    else if (plan.length + done.length >= ISSUE_IMAGE_LIMITS.images) skip(att, `over the limit of ${ISSUE_IMAGE_LIMITS.images} images`);
    else if (planned + (att.size ?? 0) > ISSUE_IMAGE_LIMITS.imagesBytes) skip(att, `over ${ISSUE_IMAGE_LIMITS.imagesBytes / MB} MB in all`);
    else {
      planned += att.size ?? 0;
      const had = there ? kept(dir, att.id, att.size) : undefined;
      if (had) done.push({ att, image: { name: oneLine(att.filename), file: had.file, path: path.join(dir, had.file), bytes: had.bytes, type: had.type } });
      else plan.push(att);
    }
  }

  const run = async () => {
    let total = done.reduce((s, d) => s + d.image.bytes, 0);
    if (plan.length) {
      realDirs(grant, root, dir, true);
      folder = folderBytes(root);
    }
    const queue = [...plan];
    const worker = async () => {
      for (let att = queue.shift(); att && !closed; att = queue.shift()) {
        try {
          if (folder + held(taskId) + (att.size ?? 0) > ISSUE_IMAGE_LIMITS.taskImagesBytes) {
            skip(att, "the task's image folder is full");
            continue;
          }
          const res = await io.fetch(`${base}${att.id}?redirect=false`, { method: 'GET', headers: { authorization: auth, accept: '*/*' }, redirect: 'error', signal: AbortSignal.timeout(left()) });
          if (!res.ok) {
            void res.body?.cancel().catch(() => {});
            throw new Error(`Jira said ${res.status}`);
          }
          let bytes: Uint8Array;
          try {
            bytes = await readCapped(res, ISSUE_IMAGE_LIMITS.imageBytes);
          } catch (err) {
            if (err instanceof TooBig) {
              skip(att, 'too big');
              continue;
            }
            throw err;
          }
          const kind = sniff(bytes);
          if (!kind) {
            skip(att, 'not an image');
            continue;
          }
          if (total + bytes.length > ISSUE_IMAGE_LIMITS.imagesBytes) {
            skip(att, `over ${ISSUE_IMAGE_LIMITS.imagesBytes / MB} MB in all`);
            continue;
          }
          if (closed) return;
          // Checked and reserved in one synchronous step.
          if (folder + held(taskId) + bytes.length > ISSUE_IMAGE_LIMITS.taskImagesBytes) {
            skip(att, "the task's image folder is full");
            continue;
          }
          reserve(taskId, bytes.length);
          const stem = storedName(att.filename).replace(/\.[^.]*$/, '') || 'image';
          const file = `${att.id}-${stem}.${kind.ext}`;
          const tmp = path.join(dir, `.${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
          const final = path.join(dir, file);
          let renamed = false;
          try {
            // The folders are checked again, and the file written, renamed and verified, in one synchronous stretch (the worker
            // can swap a folder for a link during the download). Without openat a swap between two consecutive syscalls can't
            // be ruled out; checking before and verifying after closes everything wider than that. `wx` never writes through a
            // link at the temporary name; the rename replaces a link at the final name itself.
            if (!realDirs(grant, root, dir, false)) throw new ImageStepError(NOT_PLAIN);
            writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
            renameSync(tmp, final);
            renamed = true;
            const st = lstatSync(final);
            if (!st.isFile() || realpathSync(final) !== path.join(realpathSync(grant), SUBDIR, a.key.toUpperCase(), file)) throw new ImageStepError(NOT_PLAIN);
          } catch (err) {
            rmSync(tmp, { force: true });
            if (renamed) rmSync(final, { force: true });
            throw err instanceof ImageStepError ? err : new ImageStepError("the file couldn't be saved");
          }
          total += bytes.length;
          settled.add(att);
          done.push({ att, image: { name: oneLine(att.filename), file, path: path.join(dir, file), bytes: bytes.length, type: kind.type } });
        } catch (err) {
          if (closed) return;
          const reason = timedOut(err) ? 'timed out' : err instanceof ImageStepError ? err.message : a.describe(err);
          skip(att, `download failed: ${reason}`);
          result.failures.push(timedOut(err) ? new DeadlineError("the pictures didn't finish downloading in time") : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  };

  // The deadline covers the downloads and the probes.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), left())));
  const names = new Map<string, number>();
  for (const x of all) names.set(x.filename, (names.get(x.filename) ?? 0) + 1);
  const byAlt = (alt: unknown) => (typeof alt === 'string' && names.get(alt) === 1 ? done.find((d) => d.att.filename === alt)?.image.file : undefined);
  result.media = (attrs) => {
    const hit = byAlt(attrs.alt);
    if (hit || typeof attrs.id !== 'string') return hit;
    const id = attrs.id.toLowerCase();
    return done.find((d) => uuids.get(`${conn.site}|${d.att.id}`) === id)?.image.file;
  };
  const joinMedia = async () => {
    const comments = await a.comments.catch(() => [] as RawComment[]);
    const unresolved = [...descMedia, ...comments.flatMap((c) => mediaNodes(c.adf))].filter((m) => !byAlt(m.alt) && typeof m.id === 'string');
    if (!unresolved.length || !done.length) return;
    const todo = done.filter((d) => !uuids.has(`${conn.site}|${d.att.id}`));
    const probe = async () => {
      for (let d = todo.shift(); d && !closed; d = todo.shift()) {
        try {
          // The Location carries the media's own token: only the uuid in its path is read, it is never followed or kept.
          const res = await io.fetch(`${base}${d.att.id}`, { method: 'GET', headers: { authorization: auth, accept: '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(left()) });
          void res.body?.cancel().catch(() => {});
          const m = res.status >= 300 && res.status < 400 ? UUID_RE.exec(res.headers.get('location') ?? '') : null;
          if (m) remember(`${conn.site}|${d.att.id}`, m[1].toLowerCase());
        } catch {
          /* silent: the placeholder stays [attachment] */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, probe));
  };
  // Reads of one task run at once (other keys write other folders; the same key writes whole files by rename).
  enter(taskId);
  const whole = (async () => {
    try {
      await run();
      await joinMedia();
      return 'done' as const;
    } finally {
      leave(taskId);
    }
  })();
  whole.catch(() => {});
  try {
    if ((await Promise.race([whole, deadline])) === 'late') {
      closed = true;
      // What hadn't finished is `timed out`; what had stays.
      for (const att of plan) {
        if (settled.has(att)) continue;
        skip(att, 'download failed: timed out');
        result.failures.push(new DeadlineError("the pictures didn't finish downloading in time"));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  result.images = done.map((d) => d.image);
  return finish();
}

/** Removes a task's downloaded ticket pictures (it is done or archived). */
export function removeIssueImages(filesDir: string, taskId: number) {
  rmSync(path.join(grantDir(filesDir, taskId), SUBDIR), { recursive: true, force: true });
}

/** Removes the ticket pictures of the tasks that are done or archived (a task that got there without a move in the board). `statusOf` is the task's status, undefined for an unknown task. */
export function sweepIssueImages(filesDir: string, statusOf: (taskId: number) => string | undefined): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync(path.join(filesDir, 'grants'));
  } catch {
    return out;
  }
  for (const n of names) {
    const id = /^task-(\d{1,12})$/.exec(n)?.[1];
    if (!id) continue;
    try {
      lstatSync(path.join(filesDir, 'grants', n, SUBDIR));
    } catch {
      continue;
    }
    const taskId = Number(id);
    const status = statusOf(taskId);
    if (status !== 'done' && status !== 'archived') continue;
    removeIssueImages(filesDir, taskId);
    out.push(taskId);
  }
  return out;
}
